import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { containerId } from "../core/backing-ssh.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import type { SshSession } from "../core/ssh.js";
import { type SshExecutor, sshExecutor } from "../core/ssh.js";

const namespaceSchema = sshSchema.extend({
    instance: z.string(),
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
const parse = (inputs: ResolvedInputs): NamespaceInputs => parseInputs(namespaceSchema, inputs, "valkey-namespace");

const url = (parsed: NamespaceInputs): string => `redis://${parsed.username}:${parsed.password}@${parsed.instanceHost}:${parsed.instancePort}/0`;

// Run valkey-cli in the instance container authenticated as admin, returning trimmed stdout. Throws on a
// non-zero exit so a real error propagates rather than reading as "absent".
const cli = async (session: SshSession, cid: string, parsed: NamespaceInputs, args: string): Promise<string> => {
    const result = await session.exec(`docker exec ${cid} valkey-cli -a '${parsed.adminPassword}' --no-auth-warning ${args}`);
    if (result.code !== 0) {
        throw new Error(`valkey-cli failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
};

// A per-app Valkey ACL user scoped to its key prefix (the binding for an app that uses a cache capability).
// read reports it present once ACL GETUSER returns the user; apply create-or-updates it (idempotent ACL
// SETUSER); delete drops it. NOTE: ACL users live in memory — if the instance restarts without an aclfile, a
// reconcile re-creates the user (read sees it absent, apply re-runs SETUSER), which is the self-healing path.
export const createValkeyNamespaceProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently) —
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "instanceHost", "instancePort")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`valkey-namespace "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            const cid = await containerId(session, parsed.instance);
            if (cid === "") {
                return undefined;
            }
            const user = await cli(session, cid, parsed, `ACL GETUSER ${parsed.username}`);
            return user === "" ? undefined : { outputs: { url: url(parsed) } };
        } finally {
            await session.dispose();
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            const cid = await containerId(session, parsed.instance);
            if (cid === "") {
                throw new Error(`valkey-namespace "${ctx.id}": instance "${parsed.instance}" is not running`);
            }
            // on (enabled), reset+set the password, scope to the key prefix, allow all commands on those keys.
            await cli(session, cid, parsed, `ACL SETUSER ${parsed.username} on '>${parsed.password}' '~${parsed.keyPrefix}:*' +@all`);
            return { url: url(parsed) };
        } finally {
            await session.dispose();
        }
    },
    delete: async (inputs, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            const cid = await containerId(session, parsed.instance);
            if (cid === "") {
                ctx.log(`valkey-namespace "${ctx.id}": instance "${parsed.instance}" already gone; nothing to drop`);
                return;
            }
            await cli(session, cid, parsed, `ACL DELUSER ${parsed.username}`);
        } finally {
            await session.dispose();
        }
    },
});
