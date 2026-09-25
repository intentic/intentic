// Everything a browser sees of a sandbox's front and of the edge in front of it, outside the daemon's oRPC contract. The
// Rust crates are the definition (`browser-wire`, and `tunnel` for what the edge declares): their types arrive as
// TypeScript in generated/, and every value here is held to the manifest they write beside it (wire-manifests.test.ts),
// which contract.lock.json pins.

export type { EdgeVerdict, TerminalClientMessage, TerminalServerMessage } from "./generated/browser-wire.js";

// Where a terminal socket opens on a sandbox's address. It is a WebSocket whichever way its bytes ride: over TCP, or on a
// stream of the edge's WebTransport session, where the editor speaks the same protocol itself.
export const TERMINAL_PATH = "/system/terminal";

// Where a browser opens its WebTransport session, on the address of the sandbox the session's streams reach; the edge
// answers it, never the sandbox.
export const WEBTRANSPORT_PATH = "/system/transport";

// What an edge may declare it serves beyond HTTPS over TCP (the tunnel crate's `Transport`), each only because its own
// configuration binds it. Undeclared means not served: an editor opens WebTransport only where `webtransport` is named.
export type EdgeTransport = "quic" | "h3" | "webtransport";

export const EDGE_TRANSPORTS: readonly EdgeTransport[] = ["quic", "h3", "webtransport"];
