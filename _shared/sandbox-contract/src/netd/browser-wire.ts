// Everything a browser sees of a sandbox's netd and of the edge in front of it, outside the daemon's oRPC contract. The
// Rust crates are the definition (`browser-wire`, and `tunnel` for what the edge declares): their types arrive as
// TypeScript in generated/, and every value here is held to the manifest they write beside it (wire-manifests.test.ts),
// which contract.lock.json pins.

export type {
    BrowserViewClientMessage,
    BrowserViewServerMessage,
    EdgeVerdict,
    EmulatedDevice,
    PictureKind,
    PointerAction,
    SelectMenu,
    TerminalClientMessage,
    TerminalServerMessage,
} from "./generated/browser-wire.js";

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

// Where a browser view socket opens on a sandbox's address: one browser window's picture, its state, and the person's
// input back. A WebSocket, like the terminal's.
export const BROWSER_VIEW_PATH = "/system/browser-view";

// The tag byte that starts every binary message on a browser view socket, naming what the rest of it is: a whole image
// (jpeg on the frames path, webp a sharp still over the video), the recorded demo's svg, or one H.264 access unit, which
// a keyframe can start a decoder on and a delta cannot. The quiet pair is decoded but not painted over the still.
export const BROWSER_FRAME_TAGS = {
    jpeg: 0,
    webp: 1,
    svg: 2,
    h264Key: 3,
    h264Delta: 4,
    h264KeyQuiet: 5,
    h264DeltaQuiet: 6,
} as const;
