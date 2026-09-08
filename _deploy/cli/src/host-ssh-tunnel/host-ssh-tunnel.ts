import { type CloudflareApi, cloudflareApi } from "@intentic/providers";
import { CATCH_ALL, cfargotunnelCname, hostSshTunnelName, sshHostname } from "@intentic/sandbox-contract";
import { hostSshIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { resolveZone, upsertCname } from "../lib/cf-tunnel.js";

// connect.sh installs sshd on the standard port; the tunnel reaches it only via the host's own localhost.
const HOST_SSH_PORT = 22;

export interface HostSshTunnelResult {
    readonly token: string;
    readonly hostname: string;
}

// Creates or refreshes the per-host Cloudflare tunnel exposing this host's sshd at `ssh-<id>.<zone>`, returning the
// connector token. Separate from the sandbox's own tunnel; one Cloudflare tunnel can't mix connectors on two networks.
export const createHostSshTunnel = async (args: {
    readonly apiToken: string;
    readonly connectToken: string;
    // Salts the tunnel id so each enrolled host gets its own ssh-<id>.<zone>, no collisions.
    readonly hostName: string;
    readonly zone?: string;
    readonly log: (message: string) => void;
    readonly api?: CloudflareApi;
}): Promise<HostSshTunnelResult> => {
    const api = args.api ?? cloudflareApi;
    const zone = await resolveZone(api, args.apiToken, args.zone);
    const id = hostSshIdFromToken(args.connectToken, args.hostName);
    const name = hostSshTunnelName(id);
    const hostname = sshHostname(id, zone.name);
    args.log(`resolving host SSH tunnel "${name}" on zone "${zone.name}"…`);
    const existing = await api.findTunnel({ accountId: zone.accountId, apiToken: args.apiToken, name });
    const tunnel = existing ?? (await api.createTunnel({ accountId: zone.accountId, apiToken: args.apiToken, name }));
    const token = await api.getTunnelToken({ accountId: zone.accountId, apiToken: args.apiToken, tunnelId: tunnel.id });
    const ingress = [{ hostname, service: `ssh://localhost:${HOST_SSH_PORT}` }, CATCH_ALL];
    await api.putTunnelIngress({ accountId: zone.accountId, apiToken: args.apiToken, tunnelId: tunnel.id, ingress });
    await upsertCname(api, args.apiToken, zone.id, hostname, cfargotunnelCname(tunnel.id), "intentic host ssh tunnel");
    args.log(`host SSH tunnel "${name}" → ${hostname} ready`);
    return { token, hostname };
};
