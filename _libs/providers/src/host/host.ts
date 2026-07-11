import type { Provider, ResolvedInputs } from "@intentic/engine";
import type { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

// The host's inputs are exactly the shared SSH-creds block.
type HostInputs = z.infer<typeof sshSchema>;
const parse = (inputs: ResolvedInputs): HostInputs => parseInputs(sshSchema, inputs, "host");

// Gather the host's facts over an open session. The host is OWNED infra — this verifies it is reachable
// and Docker-ready and reads its addresses; it does not provision anything. internalIp is the default
// route's source address; publicIp is the address we connect to (no third-party egress).
const gather = async (session: SshSession, address: string): Promise<Record<string, unknown>> => {
    const docker = await session.exec("docker version --format '{{.Server.Version}}'");
    if (docker.code !== 0) {
        throw new Error(`host is not Docker-ready: \`docker version\` exited ${docker.code}: ${docker.stderr.trim()}`);
    }
    const route = await session.exec("ip -4 -o route get 1.1.1.1 | awk '{print $7; exit}'");
    if (route.code !== 0) {
        throw new Error(`failed to read host internal ip: exited ${route.code}: ${route.stderr.trim()}`);
    }
    return { internalIp: route.stdout.trim(), publicIp: address };
};

// The host provider. read/apply both connect-and-gather; diff is always noop (an owned host has no
// managed drift). read maps a connection failure to "not yet reachable" (undefined) so a plan can report
// it without aborting; apply lets a connection failure propagate as the hard error for owned infra.
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
    // The host is OWNED infra, not provisioned by intentic — removing it from desired state never deletes the
    // machine. Implemented as a logged no-op so prune treats it as handled rather than an unhandled orphan.
    delete: async (_inputs, ctx) => {
        ctx.log(`host "${ctx.id}" removed from desired state — owned infra is never torn down by intentic`);
    },
});
