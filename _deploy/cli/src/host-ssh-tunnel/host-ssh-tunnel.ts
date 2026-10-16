import { type CloudflareApi, cloudflareApi, findOrCreateTunnel, upsertCname } from "@intentic/providers";
import { CATCH_ALL, cfargotunnelCname, hostSshTunnelName, sshHostname } from "@intentic/sandbox-contract/ids/hostnames";
import { hostSshIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { resolveZone } from "../lib/cf-tunnel.js";

// connect.sh installs sshd on the standard port; the tunnel reaches it only via the host's own localhost.
const HOST_SSH_PORT = 22;

// The shape hostSshIdFromToken gives: what an id handed in (HOST_ID) must look like before it names a tunnel and a
// DNS record.
export const HOST_SSH_ID_RE = /^[0-9a-f]{12}$/;

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
    // The id itself, when the sandbox gave one (HOST_ID): it wins over the digest of connectToken, which for a
    // server-connect code is a single-use token and so a new id on every run.
    readonly id?: string;
    readonly zone?: string;
    readonly log: (message: string) => void;
    readonly api?: CloudflareApi;
}): Promise<HostSshTunnelResult> => {
    if (args.id !== undefined && !HOST_SSH_ID_RE.test(args.id)) {
        throw new Error(`HOST_ID must be 12 lowercase hex characters, as the sandbox gives it; got "${args.id}"`);
    }
    const api = args.api ?? cloudflareApi;
    const zone = await resolveZone(api, args.apiToken, args.zone);
    const id = args.id ?? hostSshIdFromToken(args.connectToken, args.hostName);
    const name = hostSshTunnelName(id);
    const hostname = sshHostname(id, zone.name);
    args.log(`resolving host SSH tunnel "${name}" on zone "${zone.name}"…`);
    const tunnel = await findOrCreateTunnel(api, { accountId: zone.accountId, apiToken: args.apiToken, name });
    const token = await api.getTunnelToken({ accountId: zone.accountId, apiToken: args.apiToken, tunnelId: tunnel.id });
    const ingress = [{ hostname, service: `ssh://localhost:${HOST_SSH_PORT}` }, CATCH_ALL];
    await api.putTunnelIngress({ accountId: zone.accountId, apiToken: args.apiToken, tunnelId: tunnel.id, ingress });
    await upsertCname(api, {
        apiToken: args.apiToken,
        zoneId: zone.id,
        name: hostname,
        content: cfargotunnelCname(tunnel.id),
        comment: "intentic host ssh tunnel",
    });
    args.log(`host SSH tunnel "${name}" → ${hostname} ready`);
    return { token, hostname };
};
