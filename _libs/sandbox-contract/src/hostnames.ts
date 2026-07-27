// The single source for the tunnel/preview hostname + ingress scheme, shared by the CLI, platform API, daemon,
// AND the browser. Pure string builders/parsers with NO node imports (unlike ./tunnel-ids, which needs
// node:crypto for the digest) — so the web bundle can import them and derive identical names. The caller supplies
// the 12-hex id (sandboxIdFromToken/hostSshIdFromToken in node; WebCrypto in the browser).
//
// All four apps MUST agree on these strings: a divergence resolves to NXDOMAIN that resolvers negative-cache for
// the zone's SOA TTL. This module is that agreement.

// The sandbox daemon's subdomain + hostname: `sandbox-<id>` / `sandbox-<id>.<zone>`.
const SANDBOX_PREFIX = "sandbox-";
export const sandboxSubdomain = (id: string): string => `${SANDBOX_PREFIX}${id}`;
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
// Port-forward scheme: `port-<slot>-<sandboxId>.<zone>` — the same shape with a `port-` prefix, where <slot>
// is one of the sandbox's fixed forward slots (see PORT_SLOTS), not the port number itself: slots keep the
// intentic-provided path's minted routes bounded and warm while dev servers churn ephemeral ports.
//
// A *label* is the first-DNS-label prefix before `-<sandboxId>` (`preview-<panel>` / `port-<slot>`) — the unit
// the platform's /sandbox/preview-route mints, so one endpoint serves both schemes.
export const previewLabel = (panel: string): string => `preview-${panel}`;
export const portLabel = (slot: string): string => `port-${slot}`;

// The fixed per-sandbox forward slots. Eight is deliberate: enough for a monorepo's worth of concurrent dev
// servers, and the hard cap on preview DNS records a sandbox can ever cost the shared intentic zone.
export const PORT_SLOTS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

// The hostname a label resolves to — what the platform's /sandbox/preview-route mints from the label alone.
export const labelHostname = (label: string, id: string, zone: string): string => `${label}-${id}.${zone}`;
export const previewHostname = (panel: string, id: string, zone: string): string => labelHostname(previewLabel(panel), id, zone);
export const portHostname = (slot: string, id: string, zone: string): string => labelHostname(portLabel(slot), id, zone);

// A panel's / forwarded port's preview URL — undefined unless the sandbox has both a zone and an id
// (headless/loopback sandboxes have neither and advertise no preview).
export const previewUrl = (panel: string, zone: string | undefined, sandboxId: string | undefined): string | undefined =>
    zone !== undefined && zone !== "" && sandboxId !== undefined ? `https://${previewHostname(panel, sandboxId, zone)}` : undefined;
export const portUrl = (slot: string, zone: string | undefined, sandboxId: string | undefined): string | undefined =>
    zone !== undefined && zone !== "" && sandboxId !== undefined ? `https://${portHostname(slot, sandboxId, zone)}` : undefined;

// The key after `<prefix>` from a request's Host header. The first DNS label must carry the prefix (the
// own-Cloudflare wildcard also catches stray subdomains → undefined → the caller's 404) and, when the sandbox
// has an id, the exact `-<sandboxId>` suffix — a fixed-length match, so keys containing `-` stay unambiguous.
// Without an id the bare label is the key (loopback tests and provider-deployed workspaces, which front the
// proxy themselves).
const keyFromHost = (prefix: string, hostHeader: string | undefined, sandboxId: string | undefined): string | undefined => {
    const label = hostHeader?.split(":")[0]?.split(".")[0] ?? "";
    if (!label.startsWith(prefix)) {
        return undefined;
    }
    const key = label.slice(prefix.length);
    if (sandboxId === undefined) {
        return key === "" ? undefined : key;
    }
    const suffix = `-${sandboxId}`;
    return key.length > suffix.length && key.endsWith(suffix) ? key.slice(0, -suffix.length) : undefined;
};

export const panelFromHost = (hostHeader: string | undefined, sandboxId: string | undefined): string | undefined =>
    keyFromHost("preview-", hostHeader, sandboxId);
export const portSlotFromHost = (hostHeader: string | undefined, sandboxId: string | undefined): string | undefined =>
    keyFromHost("port-", hostHeader, sandboxId);

// The sandbox's identity AS THE USER SEES IT: the leading DNS label of its public URL, minus the `sandbox-`
// prefix — `https://sandbox-0f310c3c4db4.intentic.dev` → `0f310c3c4db4`, i.e. sandboxIdFromToken's digest read
// back off the wire by anyone holding only the URL. On the own-Cloudflare path the label is whatever subdomain
// the owner chose, so that is the id there. undefined until the sandbox has a URL at all.
export const sandboxIdFromUrl = (url: string | undefined): string | undefined => {
    if (url === undefined || url === "") {
        return undefined;
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
    let label: string;
    try {
        label = new URL(withScheme).hostname.split(".")[0] ?? "";
    } catch {
        return undefined;
    }
    if (label === "" || label === SANDBOX_PREFIX) {
        return undefined;
    }
    return label.startsWith(SANDBOX_PREFIX) ? label.slice(SANDBOX_PREFIX.length) : label;
};

// The LOCAL folder desktop sync mirrors /work into: `~/intentic/<sandbox name>-<sandboxIdFromUrl>`. Both halves
// are strings the user already has in front of them — the name in the sandbox switcher, the id in the address
// bar — so the folder on disk and the sandbox it mirrors read as ONE identity: `~/intentic/shop-0f310c3c4db4`
// belongs to `https://sandbox-0f310c3c4db4.intentic.dev` and nothing else. Keyed on the URL rather than the
// name alone for the same reason the hostname is: a torn-down sandbox recreated under the same name gets a new
// id, hence its own fresh folder instead of reusing the dead one's (which cleanup never deletes) and colliding
// on the two-way sync. Lives here, beside the hostname builders, because that match IS the contract.
export const syncFolder = (name: string, url: string | undefined): string => {
    const slug =
        name
            .replace(/[^a-zA-Z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase() || "sandbox";
    const id = sandboxIdFromUrl(url);
    return `~/intentic/${slug}${id === undefined ? "" : `-${id}`}`;
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
