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
// non-zero exit rather than reading it as "absent".
const cli = async (session: SshSession, cid: string, parsed: NamespaceInputs, args: string): Promise<string> => {
    // Correct quoting keeps the password out of the shell's hands, not out of the host's process table; `-a` still
    // puts it on the remote argv where `ps` reads it.
    const result = await session.exec(`docker exec ${cid} valkey-cli -a ${shellQuote(parsed.adminPassword)} --no-auth-warning ${args}`);
    if (result.code !== 0) {
        throw new Error(`valkey-cli failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
};

// A per-app Valkey ACL user scoped to its key prefix. ACL users live in memory: if the instance restarts without
// an aclfile, reconcile re-creates the user (self-healing).
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
