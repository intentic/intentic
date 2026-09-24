//! The control lane between intentic-front and the Node daemon: length-prefixed JSON frames over one Unix socket.
//! These types are the lane's only definition; `cargo test -p front-wire` writes their TypeScript into the contract.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A frame is this many bytes of big-endian length, then that many bytes of JSON.
pub const LENGTH_BYTES: usize = 4;

/// Longer than any honest message: a prefix past it means the stream is corrupt, not that a message is large.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// One message as a frame, length prefix included.
pub fn frame<T: Serialize>(message: &T) -> serde_json::Result<Vec<u8>> {
    let mut out = vec![0; LENGTH_BYTES];
    serde_json::to_writer(&mut out, message)?;
    let length =
        u32::try_from(out.len() - LENGTH_BYTES).expect("a frame never exceeds u32::MAX bytes");
    out[..LENGTH_BYTES].copy_from_slice(&length.to_be_bytes());
    Ok(out)
}

/// Request headers only the front sets on what it forwards to Node; it strips them from everything arriving outside.
/// Exported as a literal type, so a Node constant naming one that drifts from this spelling fails to compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "wire.ts")]
pub enum FrontHeader {
    /// A preview request Node answers itself: a refusal page, the probe, or the outbox.
    #[serde(rename = "x-intentic-preview")]
    Preview,
    /// A preview request whose upstream refused the connection; the value is that upstream's port.
    #[serde(rename = "x-intentic-preview-unreachable")]
    PreviewUnreachable,
}

impl FrontHeader {
    pub const ALL: [Self; 2] = [Self::Preview, Self::PreviewUnreachable];

    pub const fn name(self) -> &'static str {
        match self {
            Self::Preview => "x-intentic-preview",
            Self::PreviewUnreachable => "x-intentic-preview-unreachable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "wire.ts")]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

/// Every port the front binds, as Node's config names them; an absent one is not bound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub struct ListenConfig {
    pub daemon: Endpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preview: Option<Endpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub loopback: Option<Endpoint>,
    /// The 12-hex id every public hostname ends in; without one, a label's prefix alone classifies it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sandbox_id: Option<String>,
    /// Origins that may frame a preview besides the preview itself.
    pub frame_ancestors: Vec<String>,
    /// A preview path Node answers whatever its host resolves to.
    pub preview_probe_path: String,
}

/// A PEM certificate chain and its PEM private key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub struct Certificate {
    pub certificate: String,
    pub private_key: String,
}

/// The ingress tunnel's door and the reachability grant it presents there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "wire.ts")]
pub struct TunnelConfig {
    pub url: String,
    pub grant: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "wire.ts")]
pub enum Scheme {
    Http,
    Https,
}

/// A local upstream a preview host relays to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "wire.ts")]
pub struct Upstream {
    pub host: String,
    pub port: u16,
    pub scheme: Scheme,
    /// Rewrites Host and Origin to `localhost:<port>`, for an app that never agreed to its preview name.
    pub localhost: bool,
    /// Framed by the editor: `frame-ancestors` is set and `x-frame-options` dropped.
    pub frameable: bool,
}

/// Where a preview host's requests go, as Node resolved it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "to", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum PreviewRoute {
    Upstream {
        upstream: Upstream,
    },
    /// Node answers the request itself: a refusal page or the outbox.
    Node,
}

/// What a terminal socket opens onto, as Node decided from its ticket, session name and working directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "plan", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum TerminalPlan {
    /// The tmux session `session`; `argv` follows `tmux -C` to attach when no control client holds it yet.
    Tmux { session: String, argv: Vec<String> },
    /// A service's log, followed from its first line.
    Tail { path: String },
    /// Opens only to end at once: the session names nothing there is to show.
    Exit { code: i32, reason: String },
    /// Closed with this WebSocket close code before anything is attached.
    Refused { code: u16, reason: String },
}

/// A question the front asks Node; the answer carries the same id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "question", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum Question {
    Preview {
        host: String,
    },
    /// A terminal socket asking to open, its query string as the browser sent it.
    Terminal {
        query: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "answer", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum Answer {
    Preview {
        route: PreviewRoute,
    },
    Terminal {
        plan: TerminalPlan,
        /// The member whose ticket opened it, lowercased; absent when the daemon runs without auth.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        member: Option<String>,
    },
}

/// What the browser sends on a terminal socket, each a JSON text frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum TerminalClientMessage {
    /// Keystrokes, a paste or a mouse report, written into the pane as their UTF-8 bytes.
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    /// The browser's keepalive against an idle tunnel; answered `pong`.
    Ping,
}

/// What a terminal socket sends as JSON text; the pane's own bytes travel as binary frames.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum TerminalServerMessage {
    /// The session is over, and the browser must not reconnect; `reason` is tmux's own words when it had any.
    Exit {
        code: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
    },
    Pong,
}

/// The Upgrade a terminal opens with where no WebSocket rides the stream, a WebTransport one: its messages then travel
/// as frames (`FrameKind`). Exported as a literal type, as `FrontHeader` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "wire.ts")]
pub enum TerminalUpgrade {
    #[serde(rename = "intentic-terminal")]
    Frames,
}

impl TerminalUpgrade {
    pub const fn token(self) -> &'static str {
        match self {
            Self::Frames => "intentic-terminal",
        }
    }
}

/// A terminal frame is its kind byte, a big-endian u32 length, then that many bytes.
pub const TERMINAL_FRAME_HEADER: usize = 5;

/// What a terminal frame carries: one WebSocket message's worth, so a socket reads the same whichever way it came.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameKind {
    /// The pane's own bytes.
    Pane = 0,
    /// A JSON `TerminalClientMessage` or `TerminalServerMessage`.
    Message = 1,
    /// A big-endian u16 close code and its UTF-8 reason, or nothing when there is no code.
    Close = 2,
    /// The front's liveness probe, which the browser answers with a pong carrying the same bytes.
    Ping = 3,
    Pong = 4,
}

impl FrameKind {
    pub const fn of(byte: u8) -> Option<Self> {
        match byte {
            0 => Some(Self::Pane),
            1 => Some(Self::Message),
            2 => Some(Self::Close),
            3 => Some(Self::Ping),
            4 => Some(Self::Pong),
            _ => None,
        }
    }
}

/// A checkout whose changes the front counts: its working tree, the git dir holding its index and HEAD, and the common
/// dir holding refs and excludes (the git dir itself for a repository's main checkout).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub struct WatchedCheckout {
    pub dir: String,
    pub git_dir: String,
    pub common_dir: String,
}

/// Everything Node sends the front.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum FromNode {
    /// Node's HTTP socket is accepting; once per Node process.
    Hello {
        build: String,
        pid: u32,
    },
    Listen {
        config: ListenConfig,
    },
    Certificate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        certificate: Option<Certificate>,
    },
    Tunnel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tunnel: Option<TunnelConfig>,
    },
    Answer {
        id: u32,
        answer: Answer,
    },
    Refused {
        id: u32,
        message: String,
    },
    /// Closes every terminal the member opened; naming none closes every terminal a member opened.
    Revoke {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        member: Option<String>,
    },
    /// Counts this checkout's changes from now on; the same checkout again changes nothing.
    Watch {
        checkout: WatchedCheckout,
    },
    /// Stops counting the checkout at `dir`.
    Unwatch {
        dir: String,
    },
    /// Asks where each checkout's count stands, once every write that finished before this was sent is counted.
    Sync {
        id: u32,
        dirs: Vec<String>,
    },
}

/// Everything the front sends Node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum ToNode {
    Ask {
        id: u32,
        question: Question,
    },
    Tunnel {
        connected: bool,
    },
    /// Each asked checkout's generation, in the order asked: a number that moves whenever anything a `git status`
    /// there reads may have changed, and null for a checkout the front is not counting.
    Synced {
        id: u32,
        // A JSON number: far below 2^53 for any checkout's lifetime of events.
        #[ts(type = "Array<number | null>")]
        generations: Vec<Option<u64>>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_is_its_length_then_its_json() {
        let bytes = frame(&ToNode::Tunnel { connected: true }).unwrap();
        let json = br#"{"kind":"tunnel","connected":true}"#;
        assert_eq!(
            &bytes[..LENGTH_BYTES],
            &u32::try_from(json.len()).unwrap().to_be_bytes()
        );
        assert_eq!(&bytes[LENGTH_BYTES..], json);
    }

    #[test]
    fn a_sync_answer_reads_as_node_parses_it() {
        let json = serde_json::to_string(&ToNode::Synced {
            id: 7,
            generations: vec![Some(3), None],
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"synced","id":7,"generations":[3,null]}"#);
        let asked: FromNode =
            serde_json::from_str(r#"{"kind":"sync","id":7,"dirs":["/a"]}"#).unwrap();
        assert_eq!(
            asked,
            FromNode::Sync {
                id: 7,
                dirs: vec!["/a".into()]
            }
        );
    }

    #[test]
    fn the_terminal_upgrade_is_its_serialized_spelling() {
        assert_eq!(
            serde_json::to_string(&TerminalUpgrade::Frames).unwrap(),
            format!("\"{}\"", TerminalUpgrade::Frames.token())
        );
        for byte in 0..=u8::MAX {
            assert_eq!(
                FrameKind::of(byte).map(|kind| kind as u8),
                (byte <= 4).then_some(byte)
            );
        }
    }

    #[test]
    fn a_header_name_is_its_serialized_spelling() {
        for header in FrontHeader::ALL {
            assert_eq!(
                serde_json::to_string(&header).unwrap(),
                format!("\"{}\"", header.name())
            );
        }
    }

    #[test]
    fn an_absent_option_is_an_absent_key() {
        let json = serde_json::to_string(&FromNode::Certificate { certificate: None }).unwrap();
        assert_eq!(json, r#"{"kind":"certificate"}"#);
        let back: FromNode = serde_json::from_str(r#"{"kind":"tunnel"}"#).unwrap();
        assert_eq!(back, FromNode::Tunnel { tunnel: None });
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
        let ping: TerminalClientMessage = serde_json::from_str(r#"{"type":"ping"}"#).unwrap();
        assert_eq!(ping, TerminalClientMessage::Ping);
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

    #[test]
    fn a_preview_route_reads_as_node_sends_it() {
        let route: PreviewRoute = serde_json::from_str(
            r#"{"to":"upstream","upstream":{"host":"127.0.0.1","port":5174,"scheme":"http","localhost":true,"frameable":true}}"#,
        )
        .unwrap();
        assert_eq!(
            route,
            PreviewRoute::Upstream {
                upstream: Upstream {
                    host: "127.0.0.1".into(),
                    port: 5174,
                    scheme: Scheme::Http,
                    localhost: true,
                    frameable: true
                },
            }
        );
    }
}
