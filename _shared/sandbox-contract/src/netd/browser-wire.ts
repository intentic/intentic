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
// retransmitted, in any order), `input` (everything the viewer would send on the socket, in order, every one) and
// `pointer` (where the pointer is, none retransmitted, in any order: only the newest counts). The Rust constant's
// comment holds the reasons.
export const RTC_CHANNELS = {
    media: { ordered: true, maxRetransmits: null },
    audio: { ordered: false, maxRetransmits: 0 },
    input: { ordered: true, maxRetransmits: null },
    pointer: { ordered: false, maxRetransmits: 0 },
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

// A person's remote screen and terminals on a connected computer (2026-11-20), on the sandbox's address with the device
// and the session after the path (`${DEVICE_MEDIA_PATH}/<device>/<session>?token=…`, both `[A-Za-z0-9_-]{1,64}`). The
// media socket's and the terminal's own protocols, served by that computer's `intentic-remoted`, which netd reaches down
// the uplink remoted dials (`DEVICE_UPLINK_PATH`). The daemon's `devices.remote.*` hands out each path with its token.
export const DEVICE_MEDIA_PATH = "/system/device-media";
export const DEVICE_TERMINAL_PATH = "/system/device-terminal";
export const DEVICE_UPLINK_PATH = "/system/device-uplink";

// The device an uplink is for, on its upgrade; the token decides, and a header naming another device is refused.
export const DEVICE_HEADER = "x-intentic-device";

// Where netd serves each connected device's remoted to the daemon, `<dir>/<device>.sock`: each connection one stream
// down that device's uplink, for remoted's control routes.
export const DEVICE_SOCKET_DIR = "/run/intentic/devices";

// The codes netd closes a device's uplink with: `displaced`, a newer uplink of the same device replaced it; `withdrawn`,
// the daemon withdrew the device's registration.
export const DEVICE_UPLINK_CLOSE_CODES = { displaced: 4001, withdrawn: 4003 } as const;

// A runner's uplink to its parent (2026-11-23): the runner's netd dials RUNNER_UPLINK_PATH on the parent's address with
// its durable token and RUNNER_HEADER naming its id, and a person's view of the runner opens on the parent at
// `${RUNNER_VIEW_PATH}/<runner>/<path on the runner>?<its query>&ticket=…`, the path one of `system/terminal`,
// `system/browser-view`, `system/desktop-view` (each needing a runner view ticket the parent minted) or
// `system/browser-media/<session>` (castd's token decides). The parent's netd takes the ticket off before the runner sees it.
export const RUNNER_UPLINK_PATH = "/system/runner-uplink";
export const RUNNER_HEADER = "x-intentic-runner";
export const RUNNER_VIEW_PATH = "/system/runner-view";
export const RUNNER_VIEW_TICKET = "ticket";

// The codes a parent's netd closes a runner's uplink with, as a device's.
export const RUNNER_UPLINK_CLOSE_CODES = { displaced: 4001, withdrawn: 4003 } as const;
