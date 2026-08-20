import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

const peripherySchema = sshSchema.extend({
    coreAddress: z.string(),
    serverName: z.string(),
    image: z.string(),
});
type PeripheryInputs = z.infer<typeof peripherySchema>;
const parse = (inputs: ResolvedInputs): PeripheryInputs => parseInputs(peripherySchema, inputs, "komodo-periphery");

const containerName = (serverName: string): string => `intentic-periphery-${serverName}`;

// Check if the Periphery container is running on the worker host and on which image.
const checkPeriphery = async (session: SshSession, serverName: string): Promise<{ running: boolean; image: string | undefined }> => {
    const name = containerName(serverName);
    const result = await session.exec(`docker ps --filter "name=^${name}$" --format '{{.Names}}'`);
    if (result.stdout.trim() !== name) {
        return { running: false, image: undefined };
    }
    const image = (await session.exec(`docker inspect --format '{{.Config.Image}}' ${name} 2>/dev/null || true`)).stdout.trim();
    return { running: true, image };
};

// Komodo Periphery deployed on a worker host in OUTBOUND mode: it connects TO Core at `coreAddress`
// (the public Komodo URL through the Cloudflare tunnel), registering itself as `serverName`. The container
// runs with --network host and mounts the Docker socket + /proc so Core can manage containers on the host.
// Stateless: a version bump just recreates the container; it reconnects to Core automatically.
export const createKomodoPeripheryProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently),
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "coreAddress")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`komodo-periphery "${ctx.id}": host not reachable over SSH: ${String(error)}`);
            return undefined;
        }
        try {
            const { running, image } = await checkPeriphery(session, parsed.serverName);
            if (!running) {
                return undefined;
            }
            return { outputs: {}, detail: { image } };
        } finally {
            await session.dispose();
        }
    },
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const detail = observed.detail;
        if (detail === undefined || detail["image"] !== parsed.image) {
            return { action: "update", reason: `periphery image differs (running ${String(detail?.["image"])}, want ${parsed.image})` };
        }
        return { action: "noop" };
    },
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            const name = containerName(parsed.serverName);
            await session.exec(`docker rm -f ${name} 2>/dev/null || true`);
            const run = await session.exec(
                [
                    `docker run -d --restart unless-stopped --network host`,
                    `--name ${name}`,
                    // /proc is bind-mounted on purpose (host stats), so masked paths are moot, and masking
                    // over a bind-mounted /proc hard-fails on WSL2 kernels. Unconfine system paths.
                    `--security-opt systempaths=unconfined`,
                    `-v /var/run/docker.sock:/var/run/docker.sock`,
                    `-v /proc:/proc`,
                    `-e PERIPHERY_CORE_ADDRESS=${parsed.coreAddress}`,
                    `-e PERIPHERY_CONNECT_AS=${parsed.serverName}`,
                    parsed.image,
                ].join(" "),
            );
            if (run.code !== 0) {
                throw new Error(`failed to start komodo periphery on host: exited ${run.code}: ${run.stderr.trim()}`);
            }
            return {};
        } finally {
            await session.dispose();
        }
    },
    delete: async (inputs, ctx) => {
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`komodo-periphery "${ctx.id}": host not reachable for delete: ${String(error)}`);
            return;
        }
        try {
            await session.exec(`docker rm -f ${containerName(parsed.serverName)} 2>/dev/null || true`);
        } finally {
            await session.dispose();
        }
    },
});
