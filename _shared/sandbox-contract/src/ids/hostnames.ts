// The single source for tunnel/preview hostnames and scheme, shared by the CLI, platform API, daemon and browser; pure
// string builders, no node imports, so the browser can derive identical names. All four must agree, or a divergence
// resolves to a negative-cached NXDOMAIN.

// The sandbox daemon's subdomain + hostname: `sandbox-<id>` / `sandbox-<id>.<zone>`.
const SANDBOX_PREFIX = "sandbox-";
export const sandboxSubdomain = (id: string): string => `${SANDBOX_PREFIX}${id}`;
export const sandboxHostname = (id: string, zone: string): string => `${sandboxSubdomain(id)}.${zone}`;

// The container sshd hostname the desktop-sync (Mutagen) reaches over the sandbox tunnel: `ssh-<id>.<zone>`.
export const sshHostname = (id: string, zone: string): string => `ssh-${id}.${zone}`;

// A public HTTPS name for 127.0.0.1, needed since Safari refuses http from an https page. One label deeper than other
// names, so a single `*.local.<zone>` wildcard covers every sandbox rather than needing a record each.
export const localHostname = (id: string, zone: string): string => `${id}.${LOCAL_LABEL}.${zone}`;

// The label the loopback names live under, so the wildcard has something to be a wildcard OF.
export const LOCAL_LABEL = "local";

// The single record that answers for all of them. Never per-sandbox, never reaped.
export const localWildcardHostname = (zone: string): string => `*.${LOCAL_LABEL}.${zone}`;

// What that record points at, and the reason it is safe to publish: every resolver on earth gets 127.0.0.1.
export const LOCAL_ADDRESS = "127.0.0.1";

// A per-host SSH tunnel's Cloudflare tunnel name; its hostname reuses sshHostname with the host-ssh id.
export const hostSshTunnelName = (id: string): string => `host-ssh-${id}`;

// The proxied-CNAME target every tunnel points its DNS record at.
export const cfargotunnelCname = (tunnelId: string): string => `${tunnelId}.cfargotunnel.com`;

// The cloudflared ingress catch-all; must be the last rule.
export const CATCH_ALL = { service: "http_status:404" } as const;

// Three schemes share one shape, `<label>-<sandboxId>.<zone>`: preview, port-forward (`port-<slot>`, salted,
// unguessable from the sandbox id alone), and outbox (`public-<slot>`, one record per sandbox).
export const previewLabel = (panel: string): string => `preview-${panel}`;
export const portLabel = (slot: string): string => `port-${slot}`;
export const publicLabel = (slot: string): string => `public-${slot}`;

// The hostname a label resolves to. Nothing mints it: the edge parses the sandbox id back out of the name.
export const labelHostname = (label: string, id: string, zone: string): string => `${label}-${id}.${zone}`;
export const previewHostname = (panel: string, id: string, zone: string): string => labelHostname(previewLabel(panel), id, zone);
export const portHostname = (slot: string, id: string, zone: string): string => labelHostname(portLabel(slot), id, zone);
export const publicHostname = (slot: string, id: string, zone: string): string => labelHostname(publicLabel(slot), id, zone);

// A label's public URL, undefined unless the sandbox has both a zone and an id (headless/loopback sandboxes advertise
// nothing). One builder, three vocabularies.
const labelUrl = (label: string, zone: string | undefined, sandboxId: string | undefined): string | undefined =>
    zone !== undefined && zone !== "" && sandboxId !== undefined ? `https://${labelHostname(label, sandboxId, zone)}` : undefined;
export const previewUrl = (panel: string, zone: string | undefined, sandboxId: string | undefined): string | undefined =>
    labelUrl(previewLabel(panel), zone, sandboxId);
export const portUrl = (slot: string, zone: string | undefined, sandboxId: string | undefined): string | undefined =>
    labelUrl(portLabel(slot), zone, sandboxId);
export const publicUrl = (slot: string, zone: string | undefined, sandboxId: string | undefined): string | undefined =>
    labelUrl(publicLabel(slot), zone, sandboxId);

// The key after `<prefix>` in the Host header; with an id, the label must end in the exact `-<sandboxId>` suffix so a
// key containing `-` stays unambiguous. Without one, the bare label is the key.
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
export const publicSlotFromHost = (hostHeader: string | undefined, sandboxId: string | undefined): string | undefined =>
    keyFromHost("public-", hostHeader, sandboxId);

// The sandbox's identity as the user sees it: the URL's leading DNS label minus the `sandbox-` prefix. On the
// own-Cloudflare path the label is whatever subdomain the owner chose, so that is the id there.
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

// Where desktop sync mirrors /work to: `~/intentic/<name>-<sandboxIdFromUrl>`. Keyed on the URL, not the name alone, so
// a sandbox recreated under the same name gets a fresh folder instead of colliding with the old one's.
export const syncFolder = (name: string, url: string | undefined): string => {
    const slug =
        name
            .replace(/[^a-zA-Z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase() || "sandbox";
    const id = sandboxIdFromUrl(url);
    return `~/intentic/${slug}${id === undefined ? "" : `-${id}`}`;
};

// The zone from a sandbox's public URL: the hostname minus its first DNS label. Undefined when unparsable or under
// three labels, so a two-label host doesn't yield a bare TLD; accepts scheme-less input too.
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
