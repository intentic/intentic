import { type CloudflareApi, cloudflareApi } from "@intentic/providers";
import { CATCH_ALL, cfargotunnelCname, sandboxSubdomain, sshHostname as sshHost } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { resolveZone, upsertCname } from "../lib/cf-tunnel.js";

export interface SandboxTunnelResult {
    readonly token: string;
    readonly hostname: string;
    // The SSH hostname (ssh-<id>.<zone>) when sshService was routed — undefined otherwise. Used by the local
    // sync agent (Mutagen) to reach the container's sshd through this same tunnel/connector.
    readonly sshHostname: string | undefined;
}

// Create (or refresh, idempotently) the per-sandbox Cloudflare tunnel + proxied DNS record that exposes the
// sandbox daemon at `sandbox-<id>.<zone>`, and return the connector token connect.sh runs cloudflared with.
// `<id>` is a stable, unguessable digest of the connection token, so re-runs reuse the same tunnel/hostname.
// Reuses the providers' Cloudflare client — the same REST surface `intentic apply` uses for platform tunnels.
export const createSandboxTunnel = async (args: {
    readonly apiToken: string;
    readonly connectToken: string;
    readonly service: string;
    // When set, also route the single-label preview wildcard `*.<zone>` straight to the sandbox's dev server.
    readonly previewService?: string;
    // When set, also route `ssh-<id>.<zone>` to the container's sshd (e.g. ssh://intentic-sandbox-workspace:22)
    // over this SAME tunnel/connector — the transport the local Mutagen sync uses. Same id as the http host.
    readonly sshService?: string;
    readonly zone?: string;
    // An explicit subdomain prefix chosen by the own-Cloudflare user; default is the derived `sandbox-<id>`.
    readonly subdomain?: string;
    readonly log: (message: string) => void;
    readonly api?: CloudflareApi;
}): Promise<SandboxTunnelResult> => {
    const { apiToken, connectToken, service, previewService, sshService, log } = args;
    const api = args.api ?? cloudflareApi;
    const zone = await resolveZone(api, apiToken, args.zone);
    const id = sandboxIdFromToken(connectToken) ?? "";
    const name = args.subdomain !== undefined && args.subdomain !== "" ? args.subdomain : sandboxSubdomain(id);
    const hostname = `${name}.${zone.name}`;
    const previewHostname = `*.${zone.name}`;
    const sshHostname = sshHost(id, zone.name);
    const withPreview = previewService !== undefined && previewService !== "";
    const withSsh = sshService !== undefined && sshService !== "";
    log(`resolving tunnel "${name}" on zone "${zone.name}"…`);
    const existing = await api.findTunnel({ accountId: zone.accountId, apiToken, name });
    const tunnel = existing ?? (await api.createTunnel({ accountId: zone.accountId, apiToken, name }));
    const token = await api.getTunnelToken({ accountId: zone.accountId, apiToken, tunnelId: tunnel.id });
    // The preview `*.<zone>` wildcard overlaps the explicit sandbox/ssh hostnames, and cloudflared matches
    // top-down first-match-wins, so it must come after them (last before the catch-all).
    const ingress = [
        { hostname, service },
        ...(withSsh ? [{ hostname: sshHostname, service: sshService }] : []),
        ...(withPreview ? [{ hostname: previewHostname, service: previewService }] : []),
        CATCH_ALL,
    ];
    await api.putTunnelIngress({ accountId: zone.accountId, apiToken, tunnelId: tunnel.id, ingress });
    const cname = cfargotunnelCname(tunnel.id);
    await upsertCname(api, apiToken, zone.id, hostname, cname, "intentic sandbox tunnel");
    if (withPreview) {
        await upsertCname(api, apiToken, zone.id, previewHostname, cname, "intentic sandbox tunnel");
    }
    if (withSsh) {
        await upsertCname(api, apiToken, zone.id, sshHostname, cname, "intentic sandbox ssh tunnel");
    }
    log(`tunnel "${name}" → ${hostname} ready`);
    return { token, hostname, sshHostname: withSsh ? sshHostname : undefined };
};
