import type { z } from "zod";
import type { sshSchema } from "./inputs.js";
import { sshTarget } from "./inputs.js";
import type { SshExecutor } from "./ssh.js";

// The engine reaches the control-plane HTTP services (Forgejo :3000, Komodo :9120) THROUGH the host's SSH
// session, never through their public Cloudflare routes. The public route rides the very tunnel the same
// apply may be reconciling (an ingress change, a connector restart), so dialing it from the engine makes the
// control path depend on the resource being converged, the Cloudflare-530/1033 failure class. A loopback
// port-forward over the already-authenticated SSH transport has no such cycle, and works before DNS or the
// tunnel exist at all (and on NAT'd hosts, whose SSH rides its own connect.sh-managed tunnel).
export const overSsh = async <T>(
    executor: SshExecutor,
    ssh: z.infer<typeof sshSchema>,
    remotePort: number,
    fn: (baseUrl: string) => Promise<T>,
): Promise<T> => {
    const session = await executor.connect(sshTarget(ssh));
    try {
        if (session.forward === undefined) {
            throw new Error("ssh session does not support port forwarding");
        }
        const forwarded = await session.forward("127.0.0.1", remotePort);
        try {
            return await fn(`http://127.0.0.1:${forwarded.port}`);
        } finally {
            await forwarded.close();
        }
    } finally {
        await session.dispose();
    }
};
