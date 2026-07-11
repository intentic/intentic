// The single source for the tunnel/preview hostname + ingress scheme, shared by the CLI, platform API, daemon,
// AND the browser. Pure string builders/parsers with NO node imports (unlike ./tunnel-ids, which needs
// node:crypto for the digest) — so the web bundle can import them and derive identical names. The caller supplies
// the 12-hex id (sandboxIdFromToken/hostSshIdFromToken in node; WebCrypto in the browser).
//
// All four apps MUST agree on these strings: a divergence resolves to NXDOMAIN that resolvers negative-cache for
// the zone's SOA TTL. This module is that agreement.

// The sandbox daemon's subdomain + hostname: `sandbox-<id>` / `sandbox-<id>.<zone>`.
export const sandboxSubdomain = (id: string): string => `sandbox-${id}`;
export const sandboxHostname = (id: string, zone: string): string => `${sandboxSubdomain(id)}.${zone}`;

// The container sshd hostname the desktop-sync (Mutagen) reaches over the sandbox tunnel: `ssh-<id>.<zone>`.
export const sshHostname = (id: string, zone: string): string => `ssh-${id}.${zone}`;

// A per-host SSH tunnel's Cloudflare tunnel NAME (its hostname reuses sshHostname with the host-ssh id).
export const hostSshTunnelName = (id: string): string => `host-ssh-${id}`;

// The proxied-CNAME target every tunnel points its DNS record at.
export const cfargotunnelCname = (tunnelId: string): string => `${tunnelId}.cfargotunnel.com`;

// The cloudflared ingress catch-all — must be the LAST rule.
export const CATCH_ALL = { service: "http_status:404" } as const;

// Preview scheme: `preview-<panel>-<sandboxId>.<zone>` — one DNS label (the free Universal SSL `*.<zone>` cert
// covers exactly one level), where <panel> is `<repo>` or `<repo>--<app>` and <sandboxId> pins the hostname to
// this sandbox (the shared intentic zone hosts many sandboxes; without the id two users' panels would collide).
export const previewHostname = (panel: string, id: string, zone: string): string => `preview-${panel}-${id}.${zone}`;

// A panel's preview URL — undefined unless the sandbox has both a zone and an id (headless/loopback sandboxes
// have neither and advertise no preview).
export const previewUrl = (panel: string, zone: string | undefined, sandboxId: string | undefined): string | undefined =>
    zone !== undefined && zone !== "" && sandboxId !== undefined ? `https://${previewHostname(panel, sandboxId, zone)}` : undefined;

// The panel key from a request's Host header. The first DNS label must carry the `preview-` prefix (the
// own-Cloudflare wildcard also catches stray subdomains → undefined → the caller's 404) and, when the sandbox
// has an id, the exact `-<sandboxId>` suffix — a fixed-length match, so panel keys containing `-` stay
// unambiguous. Without an id the bare label is the panel key (loopback tests and provider-deployed workspaces,
// which front the proxy themselves).
export const panelFromHost = (hostHeader: string | undefined, sandboxId: string | undefined): string | undefined => {
    const label = hostHeader?.split(":")[0]?.split(".")[0] ?? "";
    if (!label.startsWith("preview-")) {
        return undefined;
    }
    const panel = label.slice("preview-".length);
    if (sandboxId === undefined) {
        return panel === "" ? undefined : panel;
    }
    const suffix = `-${sandboxId}`;
    return panel.length > suffix.length && panel.endsWith(suffix) ? panel.slice(0, -suffix.length) : undefined;
};

// The Cloudflare zone from a sandbox public URL (https://sandbox-<id>.<zone> → <zone>): the hostname minus its
// first DNS label. undefined when the URL is unparsable OR the hostname has fewer than three labels (no zone
// suffix to strip — e.g. a 2-label host would otherwise yield a bare TLD). Accepts scheme-less input too, so it
// works whether the caller passes `https://…` (daemon/CLI) or a bare host. This is the single reconciled
// implementation of what used to be the daemon's `zoneFromPublicUrl` and the web's `zoneFromDaemonUrl`.
export const zoneFromUrl = (url: string | undefined): string | undefined => {
    if (url === undefined || url === "") {
        return undefined;
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
    let hostname: string;
    try {
        hostname = new URL(withScheme).hostname;
    } catch {
        return undefined;
    }
    const labels = hostname.split(".");
    if (labels.length < 3) {
        return undefined;
    }
    return labels.slice(1).join(".");
};
