// Everything a browser sees of a sandbox's netd and of the edge in front of it, outside the daemon's oRPC contract. The
// Rust crates are the definition (`browser-wire`, and `tunnel` for what the edge declares): their types arrive as
// TypeScript in generated/, and every value here is held to the manifest they write beside it (wire-manifests.test.ts),
// which contract.lock.json pins.

export type {
    BrowserMediaClientMessage,
    BrowserMediaServerMessage,
    BrowserViewClientMessage,
    BrowserViewServerMessage,
    ClipboardContent,
    EdgeVerdict,
    EmulatedDevice,
    KeyAction,
    MediaAudio,
    MediaCursor,
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

// Where a browser media socket opens on a sandbox's address, with the browser session's name after it
// (`${BROWSER_MEDIA_PATH}/<session>`): the window's picture, sound, pointer, keys and clipboard, answered by that window's
// castd through netd rather than by Node. The browser view socket names it, with a token, in its `media` message.
export const BROWSER_MEDIA_PATH = "/system/browser-media";

// Where each window's castd listens inside the container, `<dir>/<session>.sock`: what netd relays the media socket's
// upgrade to, and where the daemon keeps the key castd checks tokens with.
export const BROWSER_MEDIA_SOCKET_DIR = "/run/intentic/cast";

// The header every binary message on a media socket starts with (browser-wire's MEDIA_HEADER_LEN): kind, flags, the
// frame's id, its capture time in ms since `hello`, the stripe's top row, index and count, then reserved bytes.
export const MEDIA_HEADER_LEN = 16;

// Byte 0 of that header: what the payload is, one H.264 access unit, one Opus packet, or `lossless`, an exact copy of a
// rectangle of the picture (the rectangle, then its pixels as B, G, R and one unused byte each, row after row), drawn
// once every video frame up to the header's id has been.
export const MEDIA_KINDS = { video: 1, audio: 2, lossless: 3 } as const;

// Bits of byte 1: `key`, an IDR a decoder can start on; `refine`, castd sharpening content that has gone still; `clip`,
// the payload starts with the rectangle the decoded picture is drawn in, the rest of the viewer's picture being exact
// already (an empty one: decode, draw nothing).
export const MEDIA_FLAGS = { key: 1, refine: 2, clip: 4 } as const;

// The rectangle a `clip`ped video message's payload and a `lossless` message's start with: x, y, width and height in
// picture pixels, u16 big-endian each.
export const MEDIA_CLIP_LEN = 8;

// The query parameter (`lossless=1`) a viewer adds to the media socket's upgrade to say it draws `clip`ped frames and
// `lossless` rectangles; castd sends either only to a viewer that asked and reaches it on this computer's loopback.
export const MEDIA_LOSSLESS_QUERY = "lossless";

// The DataChannels a viewer opens on a peer connection straight to castd (browser-wire's RTC_CHANNELS), each with the
// reliability it must be opened with: `media` (castd's JSON and video, in order, every one), `audio` (Opus packets, none
// retransmitted, in any order) and `input` (everything the viewer would send on the socket, in order, every one). The
// Rust constant's comment holds the reasons.
export const RTC_CHANNELS = {
    media: { ordered: true, maxRetransmits: null },
    audio: { ordered: false, maxRetransmits: 0 },
    input: { ordered: true, maxRetransmits: null },
} as const;

export type RtcChannelLabel = keyof typeof RTC_CHANNELS;

// The largest DataChannel message castd sends; a longer video message arrives as chunks of the same header with byte 14
// the chunk's index and byte 15 the count, joined in order before decoding.
export const RTC_MESSAGE_MAX = 32 * 1024;

// How long past its newest token's expiry castd keeps a media socket open, in seconds: the viewer sends each fresh token
// the browser view socket hands it on the open socket (`{type: "token"}`), which moves the bound on.
export const MEDIA_TOKEN_GRACE_SECONDS = 600;

// The codes castd closes an open media socket with, each meaning the held token is dead: ask the browser view socket
// for a fresh `media` before dialling again. `dropped`: the daemon dropped the window's viewers (access revoked, a
// desktop's control handed back), and castd refuses every token minted before it. `expired`: the socket's newest token
// expired more than MEDIA_TOKEN_GRACE_SECONDS ago.
export const MEDIA_CLOSE_CODES = { dropped: 4001, expired: 4002 } as const;
