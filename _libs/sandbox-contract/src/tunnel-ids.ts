import { createHash } from "node:crypto";

// The one sha256-hex digest every stable content/token identity derives from: the tunnel ids below, the
// platform's token lookup digest, the sandbox's bridge-token hashes and environment-overlay hash, hashline
// anchors. node:crypto → this subpath is node-only.
export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

// The sandbox's stable 12-hex id, digested from the connect token. Used by:
//   • the CLI's sandbox-tunnel bootstrap (sandbox-tunnel.ts) to name the tunnel + DNS
//   • the sandbox daemon's preview hostname builder (preview-hostname.ts)
//   • the sandbox daemon's sync SSH hostname derivation (sync.ts)
// All three MUST agree on the digest, so it lives in the contract they share.
export const sandboxIdFromToken = (connectToken: string): string | undefined =>
    connectToken === "" ? undefined : sha256Hex(connectToken).slice(0, 12);

// A per-host SSH tunnel's stable 12-hex id, salted with the host name so each enrolled deploy target gets its
// own ssh-<id>.<zone> (no collision across hosts). Shared by the CLI (createHostSshTunnel) and the platform API
// (provisionHostSshTunnel), which MUST derive the identical id.
export const hostSshIdFromToken = (connectToken: string, hostName: string): string => sha256Hex(`${connectToken}:${hostName}`).slice(0, 12);

/* How many port-forward slots a sandbox has. Eight is enough for a monorepo's worth of concurrent dev servers,
 * and it is the hard cap on preview DNS records a sandbox can ever cost the shared intentic zone. */
export const PORT_SLOT_COUNT = 8;

/* THE PORT-FORWARD SLOT LABELS — the `port-<slot>` half of `port-<slot>-<sandboxId>.<zone>`.
 *
 * These were the letters a…h, and that was the hole: a forwarded port's hostname was then a pure function of the
 * sandbox id, and the sandbox id is not a secret — it is the leading label of the URL the owner uses daily and
 * of every preview link they have ever shared. So anyone who had seen ONE preview link could poll eight fixed
 * names forever and catch whatever the owner forwarded, at any point in the future. The Ports view says a
 * forwarded port is public, and it is; what it could not say was that "public" meant eight guessable URLs.
 *
 * Salting with the connect token fixes that without costing anything the letters bought. Still exactly eight
 * records (the reason slots exist at all — the intentic-provided zone mints per label, and dev servers churn
 * ephemeral ports far faster than DNS should), still stable across restarts so a slot's record stays warm, and
 * still derivable with no coordination by every party that already holds the token: the daemon that forwards,
 * and the platform that mints the DNS. A party without the token has no business predicting these names.
 *
 * The browser is deliberately NOT one of those parties — it never derives a port hostname, it reads `previewUrl`
 * off the daemon's response — which is why this can live here, in the node-only half of the contract, next to
 * the digest it shares with sandboxIdFromToken. */
export const portSlotsFromToken = (connectToken: string): readonly string[] =>
    Array.from({ length: PORT_SLOT_COUNT }, (_, index) => sha256Hex(`${connectToken}:port:${index}`).slice(0, 12));
