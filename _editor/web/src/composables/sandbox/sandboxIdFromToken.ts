import { sha256Hex } from "../workspace/contentHash";

// The browser half of the contract's sandboxIdFromToken (tunnel-ids.ts is node-only — node:crypto): the same
// sha256-hex[:12] digest over the connect token, via WebCrypto. Must agree byte-for-byte with the CLI's, or a
// name derived from it (Setup's pre-filled subdomain, the switcher's cleanup slug) points at a container that
// doesn't exist.
export const sandboxIdFromToken = async (connectToken: string): Promise<string> => (await sha256Hex(connectToken)).slice(0, 12);
