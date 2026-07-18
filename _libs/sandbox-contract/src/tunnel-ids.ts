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
