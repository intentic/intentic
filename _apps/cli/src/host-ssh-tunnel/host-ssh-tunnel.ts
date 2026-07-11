import { type CloudflareApi, cloudflareApi } from "@intentic/providers";
import { CATCH_ALL, cfargotunnelCname, hostSshTunnelName, sshHostname } from "@intentic/sandbox-contract";
import { hostSshIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { resolveZone, upsertCname } from "../lib/cf-tunnel.js";

// The host's sshd port the connector bridges to. connect.sh installs sshd on the standard port; the tunnel
// reaches it only over the host's localhost (the connector runs on the host), so it is never exposed publicly.
const HOST_SSH_PORT = 22;

export interface HostSshTunnelResult {
    readonly token: string;
    readonly hostname: string;
}

// Create (or refresh, idempotently) the per-host Cloudflare tunnel + proxied DNS that exposes THIS machine's
// sshd at `ssh-<id>.<zone>` as an `ssh://localhost:22` ingress, and return the connector token connect.sh runs
// cloudflared with. `<id>` is a stable per-host digest of (connection token + host name), so re-runs reuse the
// same tunnel/hostname and each enrolled host gets a distinct one. The sandbox then SSH-deploys to this host with
// `cloudflared access tcp --hostname ssh-<id>.<zone>` (host registered via:"cloudflared") — a NAT'd machine it
// can't reach by IP. This is a SEPARATE tunnel from the sandbox's: its connector runs ON the host to reach
// localhost:22, whereas the sandbox connector runs on the workspace bridge — one Cloudflare tunnel cannot mix
// connectors on different networks (the edge load-balances across them).
export const createHostSshTunnel = async (args: {
    readonly apiToken: string;
    readonly connectToken: string;
    // Salts the tunnel id so each enrolled host gets its OWN ssh-<id>.<zone> (many deploy targets, no collision).
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
