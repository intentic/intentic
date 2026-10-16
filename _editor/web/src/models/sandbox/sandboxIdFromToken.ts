import { sandboxIdOfToken } from "@intentic/sandbox-run/slug";

// The browser half of the contract's sandboxIdFromToken (tunnel-ids.ts is node-only, node:crypto): the run contract's
// WebCrypto digest, byte for byte the CLI's, or a name derived from it (Setup's pre-filled subdomain, the switcher's
// cleanup slug) points at a container that doesn't exist. Its callers hold a real token; an empty one reads as no id.
export const sandboxIdFromToken = async (connectToken: string): Promise<string> => (await sandboxIdOfToken(connectToken)) ?? ``;
