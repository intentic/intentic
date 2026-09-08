import { createHash } from "node:crypto";

// The one sha256-hex digest every stable content/token identity derives from (tunnel ids, token lookups, bridge-token
// hashes, hashline anchors). node:crypto makes this subpath node-only.
export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

// Twelve lowercase hex characters, a gate applied before trusting an id off the wire (a hostname, a ticket).
export const SANDBOX_ID = /^[0-9a-f]{12}$/;

// The sandbox's stable 12-hex id, digested from the connect token; every public hostname embeds it, and the platform's
// grant mint, tunnelId lookup and the desktop agent's loopback dial all must derive the identical value.
export const sandboxIdFromToken = (connectToken: string): string | undefined =>
    connectToken === "" ? undefined : sha256Hex(connectToken).slice(0, 12);

// A per-host SSH tunnel's stable 12-hex id, salted with the host name so each enrolled deploy target gets its own
// ssh-<id>.<zone>. Shared by the CLI and the platform API, which must derive the identical id.
export const hostSshIdFromToken = (connectToken: string, hostName: string): string => sha256Hex(`${connectToken}:${hostName}`).slice(0, 12);

// Eight is enough for a monorepo's dev servers, and the hard cap on preview DNS records one sandbox can cost.
export const PORT_SLOT_COUNT = 8;

// Salted with the connect token, so a port's hostname isn't a pure function of the public sandbox id; any party holding
// the token derives it with no coordination. The browser never does: it reads `previewUrl` off the daemon.
export const portSlotsFromToken = (connectToken: string): readonly string[] =>
    Array.from({ length: PORT_SLOT_COUNT }, (_, index) => sha256Hex(`${connectToken}:port:${index}`).slice(0, 12));

// Salted like the port slots, and matters more here: a published file sits there indefinitely. With no directory
// listing, reaching anything needs guessing both this label and a filename.
export const publicSlotFromToken = (connectToken: string): string => sha256Hex(`${connectToken}:public`).slice(0, 12);
