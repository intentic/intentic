import { createHash } from "node:crypto";

// The sandbox's stable 12-hex id, digested from the connect token. Used by:
//   • the CLI's sandbox-tunnel bootstrap (sandbox-tunnel.ts) to name the tunnel + DNS
//   • the sandbox daemon's preview hostname builder (preview-hostname.ts)
//   • the sandbox daemon's sync SSH hostname derivation (sync.ts)
// All three MUST agree on the digest, so it lives in the contract they share.
export const sandboxIdFromToken = (connectToken: string): string | undefined =>
    connectToken === "" ? undefined : createHash("sha256").update(connectToken).digest("hex").slice(0, 12);

// A per-host SSH tunnel's stable 12-hex id, salted with the host name so each enrolled deploy target gets its
// own ssh-<id>.<zone> (no collision across hosts). Shared by the CLI (createHostSshTunnel) and the platform API
// (provisionHostSshTunnel), which MUST derive the identical id. node:crypto → this subpath is node-only.
export const hostSshIdFromToken = (connectToken: string, hostName: string): string =>
    createHash("sha256").update(`${connectToken}:${hostName}`).digest("hex").slice(0, 12);
