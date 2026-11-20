//! Everything a browser sees of a sandbox's netd and of the edge in front of it, outside the daemon's oRPC contract: a
//! terminal socket's path and messages, netd's vitals, the WebTransport session's path, and the verdict the edge
//! refuses with. These are the only definition; `cargo test -p browser-wire` writes their TypeScript, and the manifest
//! the contract's lock pins, into the contract.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a terminal socket opens, on a sandbox's address: a WebSocket, whether over TCP or on a WebTransport stream.
pub const TERMINAL_PATH: &str = "/system/terminal";

/// The upgrade a terminal socket opens with, whichever carrier its bytes ride.
pub const TERMINAL_UPGRADE: &str = "websocket";

/// Where netd answers its [`SandboxVitals`], on a sandbox's address: a plain GET any origin may read, never
/// forwarded to Node.
pub const VITALS_PATH: &str = "/system/vitals";

/// Where netd also writes its [`SandboxVitals`] inside the container, whenever they change and once a minute, for a
/// host that reaches the container but not its address (`ic` through `docker exec`, the platform through Fly's exec):
/// a daemon that dies before it names netd's ports leaves netd listening on nothing, and this file is then the only
/// place its restarts are counted. Under netd's default run directory, root's alone.
pub const VITALS_FILE: &str = "/run/intentic/vitals.json";

/// Where a browser opens its WebTransport session, on the address of the sandbox the session's streams reach; the edge
/// answers it, never the sandbox.
pub const WEBTRANSPORT_PATH: &str = "/system/transport";

/// The ALPN a browser's HTTP/3, and so its WebTransport session, negotiates with the edge.
pub const H3_ALPN: &str = "h3";

/// Why the edge could not carry a request to a sandbox, in a header the edge exposes to any origin.
pub const VERDICT_HEADER: &str = "x-intentic-edge";

/// The edge's verdicts, the only values [`VERDICT_HEADER`] carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum EdgeVerdict {
    /// No tunnel is registered: the box is off, and one that comes back redials within seconds.
    NoTunnel,
    /// The platform has no such sandbox, and no tunnel for it will be accepted again.
    UnknownSandbox,
    /// A tunnel was held and the forward failed mid-flight.
    Dropped,
}

impl EdgeVerdict {
    pub const ALL: [Self; 3] = [Self::NoTunnel, Self::UnknownSandbox, Self::Dropped];

    pub const fn name(self) -> &'static str {
        match self {
            Self::NoTunnel => "no-tunnel",
            Self::UnknownSandbox => "unknown-sandbox",
            Self::Dropped => "dropped",
        }
    }
}

/// The sandbox's proof of life, measured by netd and answered by it at [`VITALS_PATH`] whatever state Node is in:
/// the daemon's own heartbeat rides Node's event loop, so a sandbox busy enough to starve it would otherwise look dead.
/// It carries nothing of the workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub struct SandboxVitals {
    pub node: NodeLink,
    /// How long Node's event loop takes to answer netd, in milliseconds: the round trip of the last ping it
    /// answered, or how long the one outstanding has waited when that is longer. netd pings every 2 s, only once
    /// the previous ping is answered. Null before the first ping, and while Node is not `up`.
    pub lag_ms: Option<u32>,
    /// How many times netd restarted Node in the last 10 minutes.
    pub restarts: u32,
    /// Seconds since netd, and so the container, started.
    pub uptime_s: u32,
    /// The container's pressure stall; null where the cgroup's pressure files cannot be read.
    pub pressure: Option<Pressure>,
    /// Where the ingress tunnel stands and how often it dropped (2026-10-05: a tunnel that dropped once a minute for
    /// four hours was counted nowhere). Absent from an older netd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tunnel: Option<TunnelVitals>,
}

/// The ingress tunnel as netd holds it: the interactive socket, which every request can ride, and QUIC beside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub struct TunnelVitals {
    pub state: TunnelState,
    /// How many times a registered interactive socket dropped in the last hour.
    pub drops_last_hour: u32,
    /// Where the copy holding this sandbox's tunnel runs, as the edge named it, while `state` is `elsewhere`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub holder: Option<String>,
    /// Whether a QUIC connection is held beside the socket.
    pub quic: bool,
}

/// Where netd's tunnel stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum TunnelState {
    /// No tunnel is configured: the sandbox is reachable on loopback only.
    Off,
    /// Configured and not held right now: dialling, or waiting to redial.
    Dialling,
    /// The edge holds the interactive socket.
    Held,
    /// Another copy of this sandbox holds the tunnel, and the edge refused this one three times in a row; netd
    /// dials every 15 minutes meanwhile.
    Elsewhere,
    /// The platform deleted this sandbox, and netd stopped dialling.
    Deleted,
}

impl TunnelState {
    pub const ALL: [Self; 5] = [
        Self::Off,
        Self::Dialling,
        Self::Held,
        Self::Elsewhere,
        Self::Deleted,
    ];
}

/// Where netd's control link to Node stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum NodeLink {
    /// Node has not said hello since the container started.
    Starting,
    /// Node's control link is open and it said hello on it.
    Up,
    /// Node was up or was restarted before, and is not up now: its link dropped, or its process exited and netd is
    /// starting it again.
    Restarting,
}

impl NodeLink {
    pub const ALL: [Self; 3] = [Self::Starting, Self::Up, Self::Restarting];
}

/// The share of the last 10 seconds, as a percentage, in which some of the container's tasks stalled waiting for each
/// resource: cgroup v2's `some avg10` from `cpu.pressure`, `memory.pressure` and `io.pressure`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[ts(export, export_to = "browser-wire.ts")]
pub struct Pressure {
    pub cpu: f32,
    pub memory: f32,
    pub io: f32,
}

/// What the browser sends on a terminal socket, each a JSON text message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum TerminalClientMessage {
    /// Keystrokes, a paste or a mouse report, written into the pane as their UTF-8 bytes.
    Input { data: String },
    /// The viewer shows the pane, and this much of it fits. Every viewer showing the pane bounds the grid they share.
    Resize { cols: u16, rows: u16 },
    /// The viewer no longer shows the pane (a parked tab, a hidden panel, a background browser tab), so it stops bounding
    /// the shared grid until its next `resize`. A socket opened out of sight says so with `away=1` in its query. An older
    /// netd ignores both and counts the viewer at its last size.
    Away,
    /// The client's liveness, the socket's only one: the editor sends one every 30 s and calls the socket stale after
    /// 90 s without a frame. netd answers `pong`, sends a WebSocket ping only to a client silent for 45 s, and closes
    /// one silent for 90.
    Ping,
}

/// What a terminal socket sends as JSON text; the pane's own bytes travel as binary messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum TerminalServerMessage {
    /// The shared pane's grid. Viewport resize requests remain the viewer's own available size.
    Grid {
        cols: u16,
        rows: u16,
    },
    /// The session is over, and the browser must not reconnect; `reason` is tmux's own words when it had any.
    Exit {
        code: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
    },
    Pong,
    /// Every binary message after this one is the pane's bytes deflated, for a browser that asked with `deflate=1` in
    /// the socket's query: its unpacked length (4 bytes, big-endian), then raw deflate (RFC 1951) through a sync flush,
    /// all of one socket's messages one deflate stream. Sent first, before any pane bytes; a browser that never sees it
    /// reads binary messages as the raw bytes they always were, which is what an older netd sends whatever was asked.
    Deflate,
}

/// Where a browser view socket opens, on a sandbox's address: a WebSocket that shows one of the sandbox's browser windows
/// and carries the person's input back. Node answers it today; it is written here, beside the terminal's, because netd
/// is to serve it the way it serves terminals.
pub const BROWSER_VIEW_PATH: &str = "/system/browser-view";

/// The tag byte that starts every binary message on a browser view socket, so one socket carries every kind of picture
/// and the decoder is told what it cannot work out itself. The rest of the message is the picture's bytes.
pub const BROWSER_FRAME_TAGS: [(&str, u8); 7] = [
    // One whole image each, on the frames path: a browser with no display, photographed by its compositor.
    ("jpeg", 0),
    // On the video path, a sharp still of the settled page, laid over the video.
    ("webp", 1),
    // The recorded demo's drawn pages; no sandbox sends it.
    ("svg", 2),
    // H.264, one access unit each: a keyframe can start a decoder, a delta cannot.
    ("h264Key", 3),
    ("h264Delta", 4),
    // The same two, quiet: nothing in them a still the viewer holds does not show, so decoded but not painted.
    ("h264KeyQuiet", 5),
    ("h264DeltaQuiet", 6),
];

/// What a pointer event did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum PointerAction {
    Move,
    Down,
    Up,
    Wheel,
}

/// A phone a page is rendered as: its CSS viewport in portrait, whether it is a touch screen with a meta viewport, and
/// the user agent it sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub struct EmulatedDevice {
    pub width: u32,
    pub height: u32,
    pub mobile: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub user_agent: Option<String>,
}

/// What the editor sends on a browser view socket, each a JSON text message. Nothing that drives the page is sent
/// until the person takes control; watching sends only the view's own housekeeping (`resize`, `pause`, `ping`, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum BrowserViewClientMessage {
    /// A pointer event in the picture's own pixels, with what a click alone cannot carry: `buttons`, the DOM bitmask of
    /// what is held, so a lost `up` cannot strand a button down; `clickCount`, the browser's own `detail`; and the
    /// modifiers. No `meta`: the sandbox's Chromium is Linux, so a Mac's Cmd arrives already as `ctrl`.
    #[serde(rename_all = "camelCase")]
    Mouse {
        action: PointerAction,
        x: f64,
        y: f64,
        /// Which button changed, in DOM numbering (0 left, 1 middle, 2 right, 3 back, 4 forward).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        button: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        buttons: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        click_count: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        ctrl: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        shift: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        alt: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        delta_x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        delta_y: Option<f64>,
    },
    /// Typed or pasted text. `raw` puts it on the X display rather than into the page: what Chromium's own find bar
    /// needs, since a page-level key event goes to the page whatever the browser has focused.
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        raw: Option<bool>,
    },
    /// A keystroke or chord that is not plain text, by its DOM key name.
    Key {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        ctrl: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        shift: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        alt: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        raw: Option<bool>,
    },
    /// Asks what the page has selected, for the person's own clipboard; answered by `selection`.
    Selection,
    /// The entry of a drop-down the viewer drew itself (frames path only) that the person picked.
    SelectOption {
        index: u32,
    },
    /// Brings a tab in front. The window shows one tab at a time for every viewer, so this moves everyone's picture,
    /// and the next `state` says so; a tab already gone is answered by `gone`.
    #[serde(rename_all = "camelCase")]
    Bind {
        page_id: String,
    },
    /// Goes to an address, in the tab `pageId` names, or the one in front without it.
    #[serde(rename_all = "camelCase")]
    Navigate {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        page_id: Option<String>,
    },
    Back,
    Forward,
    Reload,
    Stop,
    NewTab {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        url: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    CloseTab {
        page_id: String,
    },
    /// The viewer's picture box in CSS px, rounded: the size the browser's viewport is asked to take.
    Resize {
        width: u32,
        height: u32,
    },
    /// The viewer's decoder lost the stream and needs a keyframe to start again.
    Keyframe,
    /// Renders the page as `device`, or as itself again without one. Answered by a fresh `ready`.
    Emulate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        device: Option<EmulatedDevice>,
    },
    /// Answers the JavaScript dialog the window's state lists; `text` is a prompt's reply.
    Dialog {
        accept: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        text: Option<String>,
    },
    /// Nobody can see the picture now (a background tab, a parked view): stop sending it until `resume`.
    Pause,
    Resume,
    /// The account sign-in window only: the person is finished, and the profile is kept.
    Done,
    /// The client's liveness; answered by `pong`.
    Ping,
    /// A fresh `media` now: the viewer must dial its media socket again and the token it holds has lapsed. Answered
    /// only where the window has a castd; elsewhere it is nothing.
    Media,
}

/// Which decoder a picture needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum PictureKind {
    /// H.264 of the page's viewport off the browser's X display.
    Video,
    /// One image per change from the page's compositor, for a browser with no display.
    Frames,
}

/// A native drop-down the frames path cannot show in its pictures, for the viewer to draw: its entries, the one
/// chosen, and where it opens, in the picture's pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[ts(export, export_to = "browser-wire.ts")]
pub struct SelectMenu {
    pub options: Vec<SelectEntry>,
    pub selected: i32,
    pub rect: PictureRect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[ts(export, export_to = "browser-wire.ts")]
pub struct SelectEntry {
    pub label: String,
    pub disabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[ts(export, export_to = "browser-wire.ts")]
pub struct PictureRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What a browser view socket sends as JSON text; the pictures travel as binary messages, each starting with one of
/// [`BROWSER_FRAME_TAGS`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum BrowserViewServerMessage {
    /// What the pictures after this one are: their decoder, and their size in the display's pixels, `scale` of them per
    /// CSS pixel, which is what pointer coordinates are in. `codec` is read off the stream, on the video path only.
    Ready {
        kind: PictureKind,
        width: u32,
        height: u32,
        scale: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        codec: Option<String>,
    },
    /// The window as the sandbox knows it now, whole: its tabs, which one is in front, what each is loading, an open
    /// dialog. Sent when the socket opens and again on every change, in order with the pictures, so the tabs a viewer
    /// draws and the picture it shows agree. It is the window's entry in the browsers list (the contract's
    /// `BrowserSession`), carrying the same `seq`: of two copies, the higher `seq` is the newer. Absent from an older
    /// sandbox, whose viewers read the list alone.
    State {
        #[ts(type = "unknown")]
        session: serde_json::Value,
    },
    /// The CSS cursor the page shows under the pointer, sent when it changes.
    Cursor {
        cursor: String,
    },
    /// A drop-down to draw, or null to close the one drawn (frames path only).
    Select {
        menu: Option<SelectMenu>,
    },
    /// What the page has selected, answering `selection`; empty when nothing is.
    Selection {
        text: String,
    },
    /// The tab a `bind` named has closed.
    #[serde(rename_all = "camelCase")]
    Gone {
        page_id: String,
    },
    Pong,
    /// The window is gone for good, in words for the person; the viewer must not reconnect.
    Error {
        message: String,
    },
    /// The account sign-in window only: its profile was kept.
    Saved,
    /// This window's pictures, sound, pointer, keys and clipboard travel on a media socket of their own, answered by the
    /// window's media daemon (castd) rather than by Node: dial `path` with `?token=`, and expect no pictures on this
    /// socket. Sent once the window has a castd, and again with a fresh token before the last one expires; absent while
    /// the window is shown the old way (no castd on this sandbox, or a browser with no display), whose pictures keep
    /// arriving here. What drives the browser as a program (tabs, addresses, dialogs, `emulate`) stays on this socket.
    #[serde(rename_all = "camelCase")]
    Media {
        path: String,
        token: String,
        /// When the token stops being accepted for a new connection, in milliseconds since the epoch. A socket already
        /// open is not closed by it. A JSON number: milliseconds since the epoch stay far inside a double's exact range.
        #[ts(type = "number")]
        expires_at: u64,
    },
}

/// Where a browser media socket opens, on a sandbox's address, with the session's name after it
/// (`/system/browser-media/<session>`): a WebSocket that netd hands to that window's castd on its Unix socket. It
/// carries the window's picture and sound, and takes the person's pointer, keys, clipboard and box back, the hot path
/// kept off Node's event loop. The name is the one castd serves under, `[A-Za-z0-9_-]{1,64}`: one per X display
/// (`cast-<display key>`), which every browser session on that display shares, since the picture is the display's.
pub const BROWSER_MEDIA_PATH: &str = "/system/browser-media";

/// Where each window's castd listens inside the container: `<dir>/<session>.sock`, an HTTP/1.1 server netd relays the
/// media socket's upgrade to, the way it relays the daemon's.
pub const BROWSER_MEDIA_SOCKET_DIR: &str = "/run/intentic/cast";

/// The fixed header every binary message on a media socket starts with, big-endian, before its payload:
/// `[0]` kind ([`MEDIA_KINDS`]), `[1]` flags ([`MEDIA_FLAGS`]), `[2..6]` the frame's id (u32, rising; video only, what
/// `ack` names), `[6..10]` when its content was captured, in milliseconds since the stream's `hello` (u32), `[10..12]`
/// the stripe's top row in picture pixels (u16), `[12]` the stripe's index and `[13]` how many stripes the picture is cut
/// into (1 when it is whole), `[14..16]` reserved, zero. Video's payload is one H.264 access unit in Annex B, after the
/// [`MEDIA_CLIP_LEN`]-byte rectangle its `clip` flag announces; audio's is one Opus packet; `lossless`'s is
/// [`MEDIA_CLIP_LEN`] bytes of rectangle and then its pixels.
pub const MEDIA_HEADER_LEN: usize = 16;

/// What a binary media message carries, its header's byte 0. `lossless` (only to a viewer that asked for it with
/// [`MEDIA_LOSSLESS_QUERY`]): an exact copy of a rectangle of the picture, which the viewer draws once every video frame
/// it received before it has been drawn (the header's id is the last such frame's). Its payload is the rectangle (x, y,
/// width, height in picture pixels, u16 each) and then width × height pixels, four bytes each in the order B, G, R and
/// one unused, row after row with no padding: the X server's own pixels, nothing converted.
pub const MEDIA_KINDS: [(&str, u8); 3] = [("video", 1), ("audio", 2), ("lossless", 3)];

/// Bits of a video message's byte 1. `key`: an IDR a decoder can start from. `refine`: a sharpening pass over content
/// that has gone still (castd's paint-over), drawn like any frame and never a sign of motion. `clip` (only to a viewer
/// that asked for `lossless`): the payload starts with a rectangle (x, y, width, height in picture pixels, u16 each), and
/// only that part of the decoded picture is drawn, since the rest of the viewer's picture is already exact; an empty one
/// means decode it and draw nothing. A frame without it is drawn whole.
pub const MEDIA_FLAGS: [(&str, u8); 3] = [("key", 1), ("refine", 2), ("clip", 4)];

/// How many bytes the rectangle that starts a `clip`ped video message's payload, and a `lossless` message's, takes: x,
/// y, width and height, u16 big-endian each.
pub const MEDIA_CLIP_LEN: usize = 8;

/// The query parameter a viewer adds to the media socket's upgrade (`lossless=1`) to say it draws `clip`ped frames and
/// `lossless` rectangles. castd sends neither to a viewer that did not ask, and to one that did only while it reaches
/// castd on this computer's own loopback ([`MEDIA_LISTENER_HEADER`]), where an exact copy of what changed costs nothing
/// the link would notice.
pub const MEDIA_LOSSLESS_QUERY: &str = "lossless";

/// The request header netd sets on a media socket's upgrade it relays from the sandbox's loopback port, valued
/// [`MEDIA_LOOPBACK`]: the browser that dialled runs on the computer the sandbox runs on. netd strips it from every
/// request arriving from outside, as it does all its own headers (netd-wire's `NetdHeader::Listener`, the same name), so
/// castd can believe it.
pub const MEDIA_LISTENER_HEADER: &str = "x-intentic-listener";

/// The value of [`MEDIA_LISTENER_HEADER`] on an upgrade that arrived on the loopback port.
pub const MEDIA_LOOPBACK: &str = "loopback";

/// The DataChannels a viewer opens on a media peer connection (`rtcOffer`), by label, each carrying a part of the media
/// socket's traffic once castd says `hello` on `media`, with the reliability the viewer must open it with:
/// `[label, ordered, max retransmits]`, where no maximum means fully reliable.
///
/// - `media`, castd to viewer, ordered and reliable: every JSON message and every video message, in the order the socket
///   would carry them. castd's H.264 has no intra refresh, so a delta lost is a picture wrong until the next keyframe,
///   which is ten to fifty times its size; on the LAN this path exists for, a retransmit costs one round trip of a few
///   milliseconds, far less than that keyframe. castd's ack window already bounds how many frames can wait behind one.
///   Ordered with the frames, a `hello` always precedes the keyframe it announces.
/// - `audio`, castd to viewer, unordered with no retransmits: one Opus packet a message. A packet is independent and the
///   decoder conceals a lost one; a late one is worth nothing.
/// - `input`, viewer to castd, ordered and reliable: every JSON message the viewer would send on the socket. Keys, acks
///   and clipboard writes must all arrive, in order.
pub const RTC_CHANNELS: [(&str, bool, Option<u16>); 3] = [
    ("media", true, None),
    ("audio", false, Some(0)),
    ("input", true, None),
];

/// The largest DataChannel message either side sends. A video message longer than this is cut into chunks, each a
/// message of its own carrying the same header with byte `[14]` the chunk's index and `[15]` the count (the header's
/// reserved bytes, zero everywhere else and in a whole message); the viewer joins the payloads in order before
/// decoding. A JSON message castd would send that is longer goes on the socket instead (a copied image: nothing orders
/// it against the pictures). A JSON message the viewer sends that is longer goes on `input` as binary chunks, `[index]`
/// `[count]` and then the next slice of its UTF-8, which castd joins in order, so a paste stays in order with the keys
/// around it. Chrome takes at most 256 KiB in a message, and SCTP sends one message's fragments back to back, so the cap
/// is also how long a keyframe can hold up the sound channel.
pub const RTC_MESSAGE_MAX: usize = 32 * 1024;

/// How long past its newest token's expiry castd keeps a media socket open, in seconds. A token is checked at the
/// upgrade and a socket outlives it, so the viewer sends each fresh token the browser view socket hands it on the open
/// socket (`token`), which moves this bound on: only a viewer cut off from the view socket (its access revoked, its tab
/// gone without closing) runs out, and castd closes it with [`MEDIA_CLOSE_CODES`]' `expired`.
pub const MEDIA_TOKEN_GRACE_SECONDS: u64 = 600;

/// The codes castd closes an open media socket with, on the WebSocket close frame, each meaning the token the viewer
/// holds is dead and a fresh one must be asked of the browser view socket (`{type: "media"}`) before dialling again.
/// `dropped`: the daemon dropped the window's viewers (a member's access revoked, or a desktop's control handed back),
/// and castd now refuses every token minted before that. `expired`: the socket's newest token expired more than
/// [`MEDIA_TOKEN_GRACE_SECONDS`] ago.
pub const MEDIA_CLOSE_CODES: [(&str, u16); 2] = [("dropped", 4001), ("expired", 4002)];

/// Whether a key event presses, releases, or does both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum KeyAction {
    Down,
    Up,
    Press,
}

/// What a clipboard holds, either way across a media socket: plain text, HTML, and a PNG (base64), any of them absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub struct ClipboardContent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub png: Option<String>,
}

/// The pointer's look over the picture: a CSS keyword, or the X server's own cursor image (a native menu's, a resize
/// edge's), a PNG in base64 with its hotspot, in picture pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub struct MediaCursor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub css: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub png: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hot_x: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hot_y: Option<u32>,
}

/// The sound a media socket carries, when it carries any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub struct MediaAudio {
    /// The WebCodecs codec string, `opus`.
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u8,
}

/// What the editor sends on a media socket, each a JSON text message. Coordinates are in the picture's own pixels, as
/// on the browser view socket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum BrowserMediaClientMessage {
    /// A pointer event, as on the browser view socket. `wheel` is not one: precise scrolling is `scroll`.
    #[serde(rename_all = "camelCase")]
    Mouse {
        action: PointerAction,
        x: f64,
        y: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        button: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        buttons: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        click_count: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        ctrl: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        shift: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        alt: Option<bool>,
    },
    /// Scrolling at a point, in picture pixels with their fractions: a trackpad's small steps and a wheel's notches
    /// alike. castd keeps what a step left over for the next one, so nothing a trackpad sends is lost.
    Scroll {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
    /// A key by its DOM name (`event.key`, layout already applied: `ą`, `Enter`, `ArrowLeft`), with `code` for the
    /// physical key where the name alone is ambiguous. `press` (the default) is a down and an up.
    Key {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        action: Option<KeyAction>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        ctrl: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        shift: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        alt: Option<bool>,
    },
    /// Text to type as it stands: an IME's commit, dictation, a mobile keyboard's word. Long text is not typed: a paste
    /// sets the `clipboard` and sends Ctrl+V.
    Text {
        text: String,
    },
    /// Sets the remote clipboard, in order with the keys around it (a paste is this, then Ctrl+V).
    Clipboard {
        content: ClipboardContent,
    },
    /// Lets go of every key and button castd holds down for this viewer: the editor lost focus mid-chord.
    ReleaseAll,
    /// The video frame `id` was decoded, and how long decoding took; what castd's bitrate control reads.
    #[serde(rename_all = "camelCase")]
    Ack {
        id: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        decode_ms: Option<f64>,
    },
    /// The decoder lost the stream: a keyframe, please.
    Keyframe,
    /// The viewer's picture box in CSS px and its device pixel ratio: the size the window's screen is asked to take,
    /// at `scale` display pixels per CSS pixel. Only the viewer driving the window decides it. `hz`: how many times a
    /// second the viewer's display shows a new picture, as it measured it; a castd serving it on this computer's
    /// loopback runs the window's screen at that rate, up to its own `--local-fps`.
    Resize {
        width: u32,
        height: u32,
        scale: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        hz: Option<f64>,
    },
    /// Nobody can see the picture now: stop sending video (and sound) until `resume`.
    Pause,
    Resume,
    /// Sound on or off for this viewer.
    Audio {
        on: bool,
    },
    /// The client's liveness and a round-trip probe: echoed as `pong` with the same `t`.
    Ping {
        t: f64,
    },
    /// An SDP offer for a peer connection straight to castd, which the viewer makes with the [`RTC_CHANNELS`] and no
    /// media, only where `hello` said `rtc`. castd answers `rtcAnswer`, or `rtcClosed` when it cannot take one. Once its
    /// `media` channel is open castd says `hello` there and moves the stream onto the channels; until then, and again
    /// whenever the peer fails, the stream stays on this socket.
    RtcOffer {
        sdp: String,
    },
    /// One of the viewer's ICE candidates, as the browser's `RTCIceCandidate.candidate` writes it. castd is an ICE-lite
    /// agent that learns the viewer's address from its checks, so this is never needed and never harmful.
    #[serde(rename_all = "camelCase")]
    RtcCandidate {
        candidate: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sdp_mid: Option<String>,
    },
    /// The viewer gave up on its peer connection: castd brings the stream back to this socket with a `hello`.
    RtcClose,
    /// A fresh token for this socket: the one the browser view socket handed the viewer in its latest `media`, sent
    /// whenever that does not mean dialling again. castd checks it as at the upgrade and, when it holds and opens the
    /// same access the socket has, counts [`MEDIA_TOKEN_GRACE_SECONDS`] from its expiry instead. One that does not hold
    /// changes nothing. Taken on the peer's `input` channel as well.
    Token {
        token: String,
    },
}

/// What a media socket sends as JSON text; the pictures and sound travel as binary messages with the
/// [`MEDIA_HEADER_LEN`]-byte header.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum BrowserMediaServerMessage {
    /// What the pictures after this one are: their size in display pixels, `scale` of them per CSS pixel, the H.264
    /// codec string read off the stream, and the sound's format when there is sound. Sent first, and again whenever
    /// the picture changes shape; a keyframe follows it. `readOnly`: input from this viewer is ignored.
    #[serde(rename_all = "camelCase")]
    Hello {
        width: u32,
        height: u32,
        scale: f64,
        codec: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        audio: Option<MediaAudio>,
        read_only: bool,
        /// castd takes a peer connection on this window (`rtcOffer`): it serves one on an address a viewer on its
        /// network may reach. Absent from a castd that serves none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        rtc: Option<bool>,
        /// This viewer reaches castd on the loopback of the computer the sandbox runs on (netd said so): while it
        /// drives, castd encodes at the quality a link that is no network allows, and, where it asked for
        /// [`MEDIA_LOSSLESS_QUERY`], sends it `clip`ped frames and `lossless` rectangles. Absent otherwise.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        local: Option<bool>,
    },
    /// The pointer's look changed.
    Cursor {
        cursor: MediaCursor,
    },
    /// The remote clipboard changed (the page copied, or Ctrl+C in it): for the person's own clipboard.
    Clipboard {
        content: ClipboardContent,
    },
    /// How the stream is doing, about once a second: the round trip, the bitrate castd aims for, frames sent in the
    /// last second, and how long frames wait unacknowledged.
    #[serde(rename_all = "camelCase")]
    Stats {
        rtt_ms: f64,
        target_kbps: u32,
        fps: f64,
        queue_ms: f64,
    },
    Pong {
        t: f64,
    },
    /// The window's media is gone for good, in words for the person; the viewer must not reconnect.
    Error {
        message: String,
    },
    /// castd's answer to `rtcOffer`: its candidates are in it (ICE-lite, host candidates only), so nothing trickles.
    RtcAnswer {
        sdp: String,
    },
    /// castd let go of the viewer's peer connection, or never took it, in words for a log: the stream is on this socket,
    /// and a `hello` here says so before any picture.
    RtcClosed {
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    // A type's JSON Schema without the dialect banner, which every one repeats.
    fn schema<T: schemars::JsonSchema>() -> serde_json::Value {
        let mut schema = serde_json::to_value(schemars::schema_for!(T)).unwrap();
        schema.as_object_mut().unwrap().remove("$schema");
        schema
    }

    // THE WIRE THIS CRATE DEFINES, written where the contract's lock reads it (`contract-lock.ts`): the TypeScript side
    // reads these values instead of restating them, and one that changes or goes away is a removal the lock flags.
    #[test]
    fn the_wire_is_written_where_the_contract_locks_it() {
        let manifest = serde_json::json!({
            "edge": {
                "verdictHeader": VERDICT_HEADER,
                "verdicts": schema::<EdgeVerdict>(),
            },
            "browserView": {
                "path": BROWSER_VIEW_PATH,
                "frameTags": BROWSER_FRAME_TAGS.iter().map(|(name, tag)| (name.to_string(), serde_json::json!(tag))).collect::<serde_json::Map<_, _>>(),
                "client": schema::<BrowserViewClientMessage>(),
                "server": schema::<BrowserViewServerMessage>(),
            },
            "browserMedia": {
                "path": BROWSER_MEDIA_PATH,
                "socketDir": BROWSER_MEDIA_SOCKET_DIR,
                "headerLen": MEDIA_HEADER_LEN,
                "kinds": MEDIA_KINDS.iter().map(|(name, tag)| (name.to_string(), serde_json::json!(tag))).collect::<serde_json::Map<_, _>>(),
                "flags": MEDIA_FLAGS.iter().map(|(name, bit)| (name.to_string(), serde_json::json!(bit))).collect::<serde_json::Map<_, _>>(),
                "clipLen": MEDIA_CLIP_LEN,
                "losslessQuery": MEDIA_LOSSLESS_QUERY,
                "listenerHeader": MEDIA_LISTENER_HEADER,
                "loopback": MEDIA_LOOPBACK,
                "rtcChannels": RTC_CHANNELS.iter().map(|(label, ordered, retransmits)| (label.to_string(), serde_json::json!({"ordered": ordered, "maxRetransmits": retransmits}))).collect::<serde_json::Map<_, _>>(),
                "rtcMessageMax": RTC_MESSAGE_MAX,
                "tokenGraceSeconds": MEDIA_TOKEN_GRACE_SECONDS,
                "closeCodes": MEDIA_CLOSE_CODES.iter().map(|(name, code)| (name.to_string(), serde_json::json!(code))).collect::<serde_json::Map<_, _>>(),
                "client": schema::<BrowserMediaClientMessage>(),
                "server": schema::<BrowserMediaServerMessage>(),
            },
            "terminal": {
                "path": TERMINAL_PATH,
                "upgrade": TERMINAL_UPGRADE,
                "client": schema::<TerminalClientMessage>(),
                "server": schema::<TerminalServerMessage>(),
            },
            "vitals": {
                "path": VITALS_PATH,
                "file": VITALS_FILE,
                "body": schema::<SandboxVitals>(),
            },
            "webTransport": {
                "path": WEBTRANSPORT_PATH,
                "alpn": H3_ALPN,
            },
        });
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../_shared/sandbox-contract/src/netd/generated/browser-wire.json"
        );
        let written = format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap());
        if std::fs::read_to_string(path).ok().as_deref() != Some(written.as_str()) {
            std::fs::write(path, written).unwrap();
        }
    }

    #[test]
    fn a_verdict_is_its_serialized_spelling() {
        for verdict in EdgeVerdict::ALL {
            assert_eq!(
                serde_json::to_string(&verdict).unwrap(),
                format!("\"{}\"", verdict.name())
            );
        }
    }

    #[test]
    fn vitals_are_the_camel_case_json_the_editor_parses_with_null_for_what_is_unknown() {
        let vitals = SandboxVitals {
            node: NodeLink::Restarting,
            lag_ms: None,
            restarts: 2,
            uptime_s: 3600,
            pressure: Some(Pressure {
                cpu: 12.34,
                memory: 0.0,
                io: 1.5,
            }),
            tunnel: None,
        };
        assert_eq!(
            serde_json::to_string(&vitals).unwrap(),
            r#"{"node":"restarting","lagMs":null,"restarts":2,"uptimeS":3600,"pressure":{"cpu":12.34,"memory":0.0,"io":1.5}}"#
        );
        let flapping = SandboxVitals {
            tunnel: Some(TunnelVitals {
                state: TunnelState::Elsewhere,
                drops_last_hour: 171,
                holder: Some("rog (linux)".into()),
                quic: false,
            }),
            ..vitals
        };
        assert!(
            serde_json::to_string(&flapping).unwrap().ends_with(
                r#""tunnel":{"state":"elsewhere","dropsLastHour":171,"holder":"rog (linux)","quic":false}}"#
            )
        );
        let states: Vec<String> = TunnelState::ALL
            .iter()
            .map(|state| serde_json::to_string(state).unwrap())
            .collect();
        assert_eq!(
            states,
            [
                r#""off""#,
                r#""dialling""#,
                r#""held""#,
                r#""elsewhere""#,
                r#""deleted""#
            ]
        );
        let spellings: Vec<String> = NodeLink::ALL
            .iter()
            .map(|link| serde_json::to_string(link).unwrap())
            .collect();
        assert_eq!(spellings, [r#""starting""#, r#""up""#, r#""restarting""#]);
    }

    #[test]
    fn a_browser_view_speaks_the_json_the_editor_and_daemon_already_exchange() {
        let click: BrowserViewClientMessage = serde_json::from_str(
            r#"{"type":"mouse","action":"down","x":10.5,"y":20,"button":0,"buttons":1,"clickCount":2,"ctrl":true}"#,
        )
        .unwrap();
        assert_eq!(
            click,
            BrowserViewClientMessage::Mouse {
                action: PointerAction::Down,
                x: 10.5,
                y: 20.0,
                button: Some(0),
                buttons: Some(1),
                click_count: Some(2),
                ctrl: Some(true),
                shift: None,
                alt: None,
                delta_x: None,
                delta_y: None,
            }
        );
        let bind: BrowserViewClientMessage =
            serde_json::from_str(r#"{"type":"bind","pageId":"p3"}"#).unwrap();
        assert_eq!(
            bind,
            BrowserViewClientMessage::Bind {
                page_id: "p3".into()
            }
        );
        let phone: BrowserViewClientMessage = serde_json::from_str(
            r#"{"type":"emulate","device":{"width":390,"height":844,"mobile":true,"userAgent":"x"}}"#,
        )
        .unwrap();
        assert!(matches!(
            phone,
            BrowserViewClientMessage::Emulate {
                device: Some(EmulatedDevice {
                    width: 390,
                    mobile: true,
                    ..
                })
            }
        ));
        let off: BrowserViewClientMessage = serde_json::from_str(r#"{"type":"emulate"}"#).unwrap();
        assert_eq!(off, BrowserViewClientMessage::Emulate { device: None });
        assert_eq!(
            serde_json::to_string(&BrowserViewServerMessage::Ready {
                kind: PictureKind::Video,
                width: 1280,
                height: 800,
                scale: 1.0,
                codec: Some("avc1.42c028".into()),
            })
            .unwrap(),
            r#"{"type":"ready","kind":"video","width":1280,"height":800,"scale":1.0,"codec":"avc1.42c028"}"#
        );
        let state = BrowserViewServerMessage::State {
            session: serde_json::json!({"name": "browser-own", "seq": 7}),
        };
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"type":"state","session":{"name":"browser-own","seq":7}}"#
        );
        assert_eq!(
            serde_json::to_string(&BrowserViewServerMessage::Select { menu: None }).unwrap(),
            r#"{"type":"select","menu":null}"#
        );
        assert_eq!(
            serde_json::to_string(&BrowserViewServerMessage::Gone {
                page_id: "p1".into()
            })
            .unwrap(),
            r#"{"type":"gone","pageId":"p1"}"#
        );
    }

    #[test]
    fn a_media_socket_speaks_json_both_ends_can_read() {
        let scroll: BrowserMediaClientMessage =
            serde_json::from_str(r#"{"type":"scroll","x":10,"y":20,"dx":0,"dy":3.5}"#).unwrap();
        assert_eq!(
            scroll,
            BrowserMediaClientMessage::Scroll {
                x: 10.0,
                y: 20.0,
                dx: 0.0,
                dy: 3.5
            }
        );
        let key: BrowserMediaClientMessage =
            serde_json::from_str(r#"{"type":"key","key":"ą","code":"KeyA","action":"down"}"#)
                .unwrap();
        assert!(matches!(
            key,
            BrowserMediaClientMessage::Key {
                action: Some(KeyAction::Down),
                ..
            }
        ));
        let paste: BrowserMediaClientMessage =
            serde_json::from_str(r#"{"type":"clipboard","content":{"text":"hi"}}"#).unwrap();
        assert!(matches!(
            paste,
            BrowserMediaClientMessage::Clipboard {
                content: ClipboardContent {
                    text: Some(_),
                    html: None,
                    png: None
                }
            }
        ));
        let ack: BrowserMediaClientMessage =
            serde_json::from_str(r#"{"type":"ack","id":7,"decodeMs":1.5}"#).unwrap();
        assert_eq!(
            ack,
            BrowserMediaClientMessage::Ack {
                id: 7,
                decode_ms: Some(1.5)
            }
        );
        assert_eq!(
            serde_json::to_string(&BrowserMediaClientMessage::ReleaseAll).unwrap(),
            r#"{"type":"releaseAll"}"#
        );
        assert_eq!(
            serde_json::to_string(&BrowserMediaServerMessage::Hello {
                width: 2560,
                height: 1600,
                scale: 2.0,
                codec: "avc1.42c033".into(),
                audio: Some(MediaAudio {
                    codec: "opus".into(),
                    sample_rate: 48_000,
                    channels: 2
                }),
                read_only: false,
                rtc: None,
                local: None,
            })
            .unwrap(),
            r#"{"type":"hello","width":2560,"height":1600,"scale":2.0,"codec":"avc1.42c033","audio":{"codec":"opus","sampleRate":48000,"channels":2},"readOnly":false}"#
        );
        assert_eq!(
            serde_json::to_string(&BrowserMediaServerMessage::Hello {
                width: 1280,
                height: 880,
                scale: 1.0,
                codec: "avc1.640028".into(),
                audio: None,
                read_only: false,
                rtc: None,
                local: Some(true),
            })
            .unwrap(),
            r#"{"type":"hello","width":1280,"height":880,"scale":1.0,"codec":"avc1.640028","readOnly":false,"local":true}"#
        );
        assert_eq!(
            serde_json::to_string(&BrowserMediaServerMessage::Cursor {
                cursor: MediaCursor {
                    css: Some("pointer".into()),
                    png: None,
                    hot_x: None,
                    hot_y: None
                }
            })
            .unwrap(),
            r#"{"type":"cursor","cursor":{"css":"pointer"}}"#
        );
        assert_eq!(
            serde_json::to_string(&BrowserViewServerMessage::Media {
                path: "/system/browser-media/browser-own".into(),
                token: "t".into(),
                expires_at: 1,
            })
            .unwrap(),
            r#"{"type":"media","path":"/system/browser-media/browser-own","token":"t","expiresAt":1}"#
        );
    }

    #[test]
    fn a_fresh_token_rides_the_open_media_socket_and_its_close_codes_are_the_private_range() {
        let token: BrowserMediaClientMessage =
            serde_json::from_str(r#"{"type":"token","token":"e30.c2ln"}"#).unwrap();
        assert_eq!(
            token,
            BrowserMediaClientMessage::Token {
                token: "e30.c2ln".into()
            }
        );
        // 4000 to 4999: what an application may close a WebSocket with, never a code the browser or a proxy uses.
        for (name, code) in MEDIA_CLOSE_CODES {
            assert!((4000..5000).contains(&code), "{name} {code}");
        }
        assert_eq!(MEDIA_TOKEN_GRACE_SECONDS, 600);
    }

    #[test]
    fn a_media_peer_is_signalled_in_json_both_ends_can_read() {
        let offer: BrowserMediaClientMessage =
            serde_json::from_str(r#"{"type":"rtcOffer","sdp":"v=0\r\n"}"#).unwrap();
        assert_eq!(
            offer,
            BrowserMediaClientMessage::RtcOffer {
                sdp: "v=0\r\n".into()
            }
        );
        let candidate: BrowserMediaClientMessage = serde_json::from_str(
            r#"{"type":"rtcCandidate","candidate":"candidate:1 1 udp 1 10.0.0.2 5000 typ host","sdpMid":"0"}"#,
        )
        .unwrap();
        assert_eq!(
            candidate,
            BrowserMediaClientMessage::RtcCandidate {
                candidate: "candidate:1 1 udp 1 10.0.0.2 5000 typ host".into(),
                sdp_mid: Some("0".into())
            }
        );
        assert_eq!(
            serde_json::to_string(&BrowserMediaClientMessage::RtcClose).unwrap(),
            r#"{"type":"rtcClose"}"#
        );
        assert_eq!(
            serde_json::to_string(&BrowserMediaServerMessage::RtcAnswer { sdp: "v=0".into() })
                .unwrap(),
            r#"{"type":"rtcAnswer","sdp":"v=0"}"#
        );
        assert_eq!(
            serde_json::to_string(&BrowserMediaServerMessage::RtcClosed {
                reason: "ICE failed".into()
            })
            .unwrap(),
            r#"{"type":"rtcClosed","reason":"ICE failed"}"#
        );
        let hello: BrowserMediaServerMessage = serde_json::from_str(
            r#"{"type":"hello","width":2,"height":2,"scale":1,"codec":"avc1","readOnly":true,"rtc":true}"#,
        )
        .unwrap();
        assert!(matches!(
            hello,
            BrowserMediaServerMessage::Hello {
                rtc: Some(true),
                ..
            }
        ));
    }

    #[test]
    fn every_rtc_channel_is_its_own_and_a_chunk_count_fits_its_byte() {
        let mut labels: Vec<&str> = RTC_CHANNELS.iter().map(|(label, _, _)| *label).collect();
        labels.sort_unstable();
        labels.dedup();
        assert_eq!(labels, ["audio", "input", "media"]);
        // A chunk's index and count are one byte each: 255 chunks still hold an 8 MB keyframe.
        assert!(255 * (RTC_MESSAGE_MAX - MEDIA_HEADER_LEN) >= 8_000_000);
        assert!(RTC_MESSAGE_MAX <= 256 * 1024);
    }

    #[test]
    fn every_media_kind_and_flag_is_its_own() {
        let mut kinds: Vec<u8> = MEDIA_KINDS.iter().map(|(_, tag)| *tag).collect();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), MEDIA_KINDS.len());
        let bits = MEDIA_FLAGS.iter().fold(0u8, |all, (_, bit)| {
            assert_eq!(all & bit, 0, "a flag bit used twice");
            assert_eq!(bit.count_ones(), 1, "a flag is one bit");
            all | bit
        });
        assert_ne!(bits, 0);
        assert_eq!(MEDIA_HEADER_LEN, 16);
    }

    #[test]
    fn every_browser_frame_tag_is_one_byte_of_its_own() {
        let mut tags: Vec<u8> = BROWSER_FRAME_TAGS.iter().map(|(_, tag)| *tag).collect();
        tags.sort_unstable();
        tags.dedup();
        assert_eq!(tags.len(), BROWSER_FRAME_TAGS.len());
    }

    #[test]
    fn a_terminal_speaks_the_json_the_editor_sends_and_reads() {
        let resize: TerminalClientMessage =
            serde_json::from_str(r#"{"type":"resize","cols":120,"rows":40}"#).unwrap();
        assert_eq!(
            resize,
            TerminalClientMessage::Resize {
                cols: 120,
                rows: 40
            }
        );
        assert_eq!(
            serde_json::to_string(&TerminalServerMessage::Grid { cols: 80, rows: 24 }).unwrap(),
            r#"{"type":"grid","cols":80,"rows":24}"#
        );
        let ping: TerminalClientMessage = serde_json::from_str(r#"{"type":"ping"}"#).unwrap();
        assert_eq!(ping, TerminalClientMessage::Ping);
        let away: TerminalClientMessage = serde_json::from_str(r#"{"type":"away"}"#).unwrap();
        assert_eq!(away, TerminalClientMessage::Away);
        assert_eq!(
            serde_json::to_string(&TerminalServerMessage::Exit {
                code: 0,
                reason: None
            })
            .unwrap(),
            r#"{"type":"exit","code":0}"#
        );
        assert_eq!(
            serde_json::to_string(&TerminalServerMessage::Pong).unwrap(),
            r#"{"type":"pong"}"#
        );
    }
}
