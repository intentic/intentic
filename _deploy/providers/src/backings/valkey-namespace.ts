import type { Provider } from "@intentic/engine";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { bindingSchema, createInstanceBindingProvider } from "../core/instance-binding.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

const namespaceSchema = bindingSchema.extend({
    instanceHost: z.string(),
    instancePort: z.string(),
    // The instance admin password, to authenticate valkey-cli for ACL commands.
    adminPassword: z.string(),
    // The per-app ACL user, its generated password, and the key prefix it is scoped to.
    username: z.string(),
    password: z.string(),
    keyPrefix: z.string(),
});
type NamespaceInputs = z.infer<typeof namespaceSchema>;

const url = (parsed: NamespaceInputs): string => `redis://${parsed.username}:${parsed.password}@${parsed.instanceHost}:${parsed.instancePort}/0`;

// Run valkey-cli in the instance container authenticated as admin, returning trimmed stdout. Throws on a
// non-zero exit so a real error propagates rather than reading as "absent".
const cli = async (session: SshSession, cid: string, parsed: NamespaceInputs, args: string): Promise<string> => {
    // NOTE: correct quoting keeps the password out of the SHELL's hands, not out of the host's process table,
    // `-a` puts it on the remote argv where `ps` still reads it. That exposure is tracked separately; this call
    // no longer lets an apostrophe in the password run the rest of the line as a command.
    const result = await session.exec(`docker exec ${cid} valkey-cli -a ${shellQuote(parsed.adminPassword)} --no-auth-warning ${args}`);
    if (result.code !== 0) {
        throw new Error(`valkey-cli failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
};

// A per-app Valkey ACL user scoped to its key prefix (the binding for an app that uses a cache capability).
// read reports it present once ACL GETUSER returns the user; apply create-or-updates it (idempotent ACL
// SETUSER); delete drops it. NOTE: ACL users live in memory, if the instance restarts without an aclfile, a
// reconcile re-creates the user (read sees it absent, apply re-runs SETUSER), which is the self-healing path.
export const createValkeyNamespaceProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createInstanceBindingProvider(
        {
            kind: "valkey-namespace",
            schema: namespaceSchema,
            pendingRefs: ["instanceHost", "instancePort"],
            present: async (session, cid, parsed) => {
                const user = await cli(session, cid, parsed, `ACL GETUSER ${parsed.username}`);
                return user === "" ? undefined : { url: url(parsed) };
            },
            create: async (session, cid, parsed) => {
                // on (enabled), reset+set the password, scope to the key prefix, allow all commands on those keys.
                await cli(session, cid, parsed, `ACL SETUSER ${parsed.username} on '>${parsed.password}' '~${parsed.keyPrefix}:*' +@all`);
                return { url: url(parsed) };
            },
            drop: async (session, cid, parsed) => {
                await cli(session, cid, parsed, `ACL DELUSER ${parsed.username}`);
            },
        },
        executor,
    );
