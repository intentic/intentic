import type { Provider, ResolvedInputs } from "@intentic/engine";
import type { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

// The host's inputs are exactly the shared SSH-creds block.
type HostInputs = z.infer<typeof sshSchema>;
const parse = (inputs: ResolvedInputs): HostInputs => parseInputs(sshSchema, inputs, "host");

// Gathers the host's facts over an open session: verifies it is reachable and Docker-ready, reads its addresses;
// never provisions. internalIp is the default route's source address, publicIp is the address connected to.
const gather = async (session: SshSession, address: string): Promise<Record<string, unknown>> => {
    // Two independent execs, concurrent on one connection, so a plan pays one SSH round-trip per host.
    const [docker, route] = await Promise.all([
        session.exec("docker version --format '{{.Server.Version}}'"),
        session.exec("ip -4 -o route get 1.1.1.1 | awk '{print $7; exit}'"),
    ]);
    if (docker.code !== 0) {
        throw new Error(`host is not Docker-ready: \`docker version\` exited ${docker.code}: ${docker.stderr.trim()}`);
    }
    if (route.code !== 0) {
        throw new Error(`failed to read host internal ip: exited ${route.code}: ${route.stderr.trim()}`);
    }
    return { internalIp: route.stdout.trim(), publicIp: address };
};

// Host provider: read/apply both connect-and-gather; diff is always noop, an owned host has no managed drift.
// `read` maps a connection failure to not-yet-reachable; `apply` lets it propagate as a hard error.
export const createHostProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`host "${ctx.id}" is not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            return { outputs: await gather(session, parsed.address) };
        } finally {
            await session.dispose();
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            return await gather(session, parsed.address);
        } finally {
            await session.dispose();
        }
    },
    // Owned infra; removing it from desired state never deletes the machine. Logged no-op, so prune treats it as
    // handled.
    delete: async (_inputs, ctx) => {
        ctx.log(`host "${ctx.id}" removed from desired state: owned infra is never torn down by intentic`);
    },
});
