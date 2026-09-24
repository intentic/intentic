//! Terminals, served by the front itself: `GET /system/terminal` upgrades onto a tmux session or a service's log, which
//! Node authorizes with one question and never carries a byte of. A browser's socket is a WebSocket, or frames on a
//! WebTransport stream the edge relays as an `intentic-terminal` upgrade.

mod control;
mod frames;
mod hub;
mod screen;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use front_wire::{TerminalClientMessage, TerminalPlan, TerminalServerMessage, TerminalUpgrade};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use http::header::{
    CONNECTION, HeaderMap, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE,
};
use http::{Method, Response, StatusCode};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::process::Command;
use tokio::sync::{Notify, mpsc};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};
use tokio_util::codec::Framed;

use crate::body::{self, Body};
use frames::Frames;
use hub::{Controls, Outbox, Taken};
pub use hub::{Hubs, Tmux};

/// Every route the front answers itself; the contract marks each `front` (raw-routes.ts), and a test holds them equal.
pub const ROUTES: [(&str, &str); 1] = [("GET", "/system/terminal")];

// A per-sandbox bound, not a quota; 1013 sends the browser to its usual backoff.
const MAX_TERMINALS: usize = 32;

// A ping unanswered this long means the peer is gone, as a half-open TCP connection never says.
const LIVENESS: Duration = Duration::from_secs(30);

// What a closing socket's last frames get to leave before the stream is dropped under them.
const CLOSE_PATIENCE: Duration = Duration::from_secs(1);

// Large enough to carry a burst whole, small enough that one frame never holds the socket long.
const FRAME_MAX: usize = 256 * 1024;

// A paste arrives as one message; past this it is not a paste.
const MESSAGE_MAX: usize = 16 * 1024 * 1024;

// RFC 6455 caps a close frame's reason at 123 bytes.
const CLOSE_REASON_MAX: usize = 123;

const READ_BUFFER: usize = 16 * 1024;

pub fn serves(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, route)| method.as_str() == *verb && path == *route)
}

/// How a terminal socket's messages travel once it has upgraded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Framing {
    /// A WebSocket, answered with this `Sec-WebSocket-Accept`.
    WebSocket { accept: String },
    /// `front_wire` frames, on a stream no WebSocket rides.
    Frames,
}

impl Framing {
    /// The upgrade a request asks for, when it is one a terminal opens with.
    pub fn of(headers: &HeaderMap) -> Option<Self> {
        let names = |header, token: &str| {
            headers
                .get_all(header)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .any(|value| {
                    value
                        .split(',')
                        .any(|named| named.trim().eq_ignore_ascii_case(token))
                })
        };
        if !names(CONNECTION, "upgrade") {
            return None;
        }
        if names(UPGRADE, TerminalUpgrade::Frames.token()) {
            return Some(Self::Frames);
        }
        if !names(UPGRADE, "websocket") || headers.get(SEC_WEBSOCKET_VERSION)?.as_bytes() != b"13" {
            return None;
        }
        Some(Self::WebSocket {
            accept: derive_accept_key(headers.get(SEC_WEBSOCKET_KEY)?.as_bytes()),
        })
    }

    pub fn switching(&self) -> Response<Body> {
        let builder = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(CONNECTION, "Upgrade");
        let builder = match self {
            Self::WebSocket { accept } => builder
                .header(UPGRADE, "websocket")
                .header(SEC_WEBSOCKET_ACCEPT, accept.as_str()),
            Self::Frames => builder.header(UPGRADE, TerminalUpgrade::Frames.token()),
        };
        builder
            .body(body::empty())
            .expect("a switching response always builds")
    }

    /// The same answer as raw h1, for a socket that arrived down the tunnel as a CONNECT stream.
    pub fn switching_head(&self) -> Vec<u8> {
        match self {
            Self::WebSocket { accept } => format!(
                "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\n\r\n"
            ),
            Self::Frames => format!(
                "HTTP/1.1 101 Switching Protocols\r\nupgrade: {}\r\nconnection: Upgrade\r\n\r\n",
                TerminalUpgrade::Frames.token()
            ),
        }
        .into_bytes()
    }
}

/// The browser's grid from `?cols=&rows=`, 80x24 where either is missing or unreadable.
pub fn size_of(query: &str) -> (u16, u16) {
    let mut size = (80, 24);
    for (key, value) in query.split('&').filter_map(|pair| pair.split_once('=')) {
        match (key, value.parse::<u16>().ok().filter(|cells| *cells > 0)) {
            ("cols", Some(cols)) => size.0 = cols,
            ("rows", Some(rows)) => size.1 = rows,
            _ => {}
        }
    }
    size
}

struct Open {
    member: Option<String>,
    revoked: Arc<Notify>,
}

/// Every open terminal socket, by the member whose ticket opened it.
pub struct Terminals {
    hubs: Arc<Hubs>,
    open: Mutex<HashMap<u64, Open>>,
    next: AtomicU64,
}

// Holds one socket's place in the count; the place is given back however the socket ends.
struct Seat {
    terminals: Arc<Terminals>,
    id: u64,
    revoked: Arc<Notify>,
}

impl Drop for Seat {
    fn drop(&mut self) {
        self.terminals
            .open
            .lock()
            .expect("terminals poisoned")
            .remove(&self.id);
    }
}

impl Terminals {
    pub fn new(hubs: Arc<Hubs>) -> Arc<Self> {
        Arc::new(Self {
            hubs,
            open: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        })
    }

    /// Closes the member's terminals, or every member's when none is named.
    pub fn revoke(&self, member: Option<&str>) {
        for open in self.open.lock().expect("terminals poisoned").values() {
            if open.member.is_some() && (member.is_none() || open.member.as_deref() == member) {
                open.revoked.notify_one();
            }
        }
    }

    fn seat(self: &Arc<Self>, member: Option<String>) -> Option<Seat> {
        let mut open = self.open.lock().expect("terminals poisoned");
        if open.len() >= MAX_TERMINALS {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let revoked = Arc::new(Notify::new());
        open.insert(
            id,
            Open {
                member,
                revoked: revoked.clone(),
            },
        );
        Some(Seat {
            terminals: self.clone(),
            id,
            revoked,
        })
    }

    /// Serves an upgraded socket as Node's plan for it says.
    pub async fn serve<S>(
        self: Arc<Self>,
        io: S,
        framing: &Framing,
        plan: TerminalPlan,
        member: Option<String>,
        query: &str,
    ) where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        match framing {
            Framing::WebSocket { .. } => {
                let config = WebSocketConfig::default()
                    .max_message_size(Some(MESSAGE_MAX))
                    .max_frame_size(Some(MESSAGE_MAX));
                let socket = WebSocketStream::from_raw_socket(io, Role::Server, Some(config)).await;
                self.serve_socket(socket, plan, member, query).await;
            }
            Framing::Frames => {
                let socket = Framed::new(io, Frames::new(MESSAGE_MAX));
                self.serve_socket(socket, plan, member, query).await;
            }
        }
    }

    async fn serve_socket<T, E>(
        self: Arc<Self>,
        mut socket: T,
        plan: TerminalPlan,
        member: Option<String>,
        query: &str,
    ) where
        T: Sink<Message, Error = E> + Stream<Item = Result<Message, E>> + Unpin + Send + 'static,
        E: Send + 'static,
    {
        let feed = match plan {
            TerminalPlan::Refused { code, reason } => {
                return close(&mut socket, CloseCode::from(code), &reason).await;
            }
            TerminalPlan::Exit { code, reason } => {
                let _ = socket.feed(exit(code, reason)).await;
                return close(&mut socket, CloseCode::Normal, "").await;
            }
            TerminalPlan::Tmux { session, argv } => Feed::Session { session, argv },
            TerminalPlan::Tail { path } => Feed::Log { path },
        };
        let Some(seat) = self.seat(member) else {
            return close(&mut socket, CloseCode::Again, "too many terminals").await;
        };
        match feed {
            Feed::Session { session, argv } => {
                let (cols, rows) = size_of(query);
                let viewer = self.hubs.join(&session, &argv, cols, rows);
                let controls = viewer.controls();
                pump(socket, &viewer.outbox, Some(controls), &seat, || {
                    viewer.resync();
                })
                .await;
            }
            Feed::Log { path } => {
                let outbox = Arc::new(Outbox::live());
                let following = tokio::spawn(follow(path, outbox.clone()));
                pump(socket, &outbox, None, &seat, || {}).await;
                following.abort();
            }
        }
    }
}

enum Feed {
    Session { session: String, argv: Vec<String> },
    Log { path: String },
}

fn text(message: &TerminalServerMessage) -> Message {
    Message::text(serde_json::to_string(message).expect("a server message always serializes"))
}

fn exit(code: i32, reason: String) -> Message {
    text(&TerminalServerMessage::Exit {
        code,
        reason: (!reason.is_empty()).then_some(reason),
    })
}

async fn close<T, E>(socket: &mut T, code: CloseCode, reason: &str)
where
    T: Sink<Message, Error = E> + Unpin,
{
    let mut end = reason.len().min(CLOSE_REASON_MAX);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    let _ = socket
        .feed(Message::Close(Some(CloseFrame {
            code,
            reason: Utf8Bytes::from(&reason[..end]),
        })))
        .await;
    let _ = tokio::time::timeout(CLOSE_PATIENCE, socket.close()).await;
}

// Writes what the outbox holds, one coalesced binary frame at a time, and everything the socket itself must say.
async fn pump<T, E>(
    socket: T,
    outbox: &Outbox,
    controls: Option<Controls>,
    seat: &Seat,
    resync: impl Fn(),
) where
    T: Sink<Message, Error = E> + Stream<Item = Result<Message, E>> + Send + 'static,
    E: Send + 'static,
{
    let (mut sink, stream) = socket.split();
    let (replies, mut answering) = mpsc::unbounded_channel();
    let alive = Arc::new(AtomicBool::new(true));
    let reader = tokio::spawn(read(stream, controls, replies, alive.clone()));
    let mut liveness = tokio::time::interval_at(tokio::time::Instant::now() + LIVENESS, LIVENESS);
    loop {
        match outbox.take(FRAME_MAX) {
            Taken::Bytes(bytes) => {
                if sink.send(Message::Binary(bytes)).await.is_err() {
                    break;
                }
                continue;
            }
            Taken::Ended(code, reason) => {
                let _ = sink.feed(exit(code, reason)).await;
                let _ = sink.feed(Message::Close(None)).await;
                break;
            }
            Taken::Resync => {
                if sink.flush().await.is_err() {
                    break;
                }
                resync();
                continue;
            }
            Taken::Nothing => {}
        }
        tokio::select! {
            () = outbox.changed() => {}
            reply = answering.recv() => {
                let Some(reply) = reply else {
                    break;
                };
                if sink.send(reply).await.is_err() {
                    break;
                }
            }
            _ = liveness.tick() => {
                if !alive.swap(false, Ordering::Relaxed) || sink.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
            () = seat.revoked.notified() => {
                let _ = sink.feed(Message::Close(Some(CloseFrame {
                    code: CloseCode::Policy,
                    reason: Utf8Bytes::from_static("authorization revoked"),
                }))).await;
                break;
            }
        }
    }
    reader.abort();
    let _ = tokio::time::timeout(CLOSE_PATIENCE, sink.close()).await;
}

// Ends when the browser closes or goes silent, and its end ends the pump: it drops the only sender of `replies`.
async fn read<R, E>(
    mut stream: R,
    controls: Option<Controls>,
    replies: mpsc::UnboundedSender<Message>,
    alive: Arc<AtomicBool>,
) where
    R: Stream<Item = Result<Message, E>> + Unpin,
{
    while let Some(Ok(message)) = stream.next().await {
        alive.store(true, Ordering::Relaxed);
        let payload = match message {
            Message::Text(payload) => payload,
            Message::Close(_) => return,
            _ => continue,
        };
        match serde_json::from_str(&payload) {
            Ok(TerminalClientMessage::Input { data }) => {
                if let Some(controls) = &controls {
                    controls.input(data.into_bytes());
                }
            }
            Ok(TerminalClientMessage::Resize { cols, rows }) => {
                if let Some(controls) = &controls
                    && cols > 0
                    && rows > 0
                {
                    controls.resize(cols, rows);
                }
            }
            Ok(TerminalClientMessage::Ping) => {
                let _ = replies.send(text(&TerminalServerMessage::Pong));
            }
            Err(_) => {}
        }
    }
}

// A log followed from its first line, `\n` turned into the `\r\n` a terminal draws; a log waits, it never drops.
async fn follow(path: String, outbox: Arc<Outbox>) {
    let child = Command::new("tail")
        .args(["-n", "+1", "-F", "--", &path])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => return outbox.end(1, format!("could not follow the log: {error}")),
    };
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut buffer = vec![0_u8; READ_BUFFER];
    let mut drawn = Vec::with_capacity(READ_BUFFER * 2);
    while let Ok(read @ 1..) = stdout.read(&mut buffer).await {
        drawn.clear();
        for byte in &buffer[..read] {
            if *byte == b'\n' {
                drawn.push(b'\r');
            }
            drawn.push(*byte);
        }
        outbox.push(&drawn).await;
    }
    let code = child
        .wait()
        .await
        .ok()
        .and_then(|status| status.code())
        .unwrap_or(1);
    outbox.end(code, String::new());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_routes_the_front_serves_are_the_ones_the_contract_marks_front() {
        let table =
            include_str!("../../../../../../_shared/sandbox-contract/src/protocol/raw-routes.ts");
        let marked: Vec<String> = table
            .lines()
            .filter(|line| line.contains("front: true"))
            .filter_map(|line| {
                let (key, _) = line.trim().strip_prefix('"')?.split_once('"')?;
                Some(key.to_owned())
            })
            .collect();
        let served: Vec<String> = ROUTES
            .iter()
            .map(|(method, path)| format!("{method} {path}"))
            .collect();
        assert_eq!(marked, served);
    }

    #[test]
    fn a_route_is_served_only_at_its_exact_path_and_method() {
        assert!(serves(&Method::GET, "/system/terminal"));
        assert!(!serves(&Method::GET, "/system/terminal/"));
        assert!(!serves(&Method::POST, "/system/terminal"));
        assert!(!serves(&Method::GET, "/system/terminals"));
    }

    #[test]
    fn the_grid_is_read_from_the_query_and_defaults_where_unreadable() {
        assert_eq!(size_of("ticket=t&cols=120&rows=40"), (120, 40));
        assert_eq!(size_of("cols=0&rows=x"), (80, 24));
        assert_eq!(size_of(""), (80, 24));
    }

    #[test]
    fn only_a_websocket_or_a_frames_upgrade_opens_a_terminal() {
        let mut headers = HeaderMap::new();
        headers.insert(UPGRADE, "websocket".parse().unwrap());
        headers.insert(CONNECTION, "keep-alive, Upgrade".parse().unwrap());
        headers.insert(SEC_WEBSOCKET_VERSION, "13".parse().unwrap());
        assert_eq!(Framing::of(&headers), None);
        // RFC 6455's own example key and answer.
        headers.insert(
            SEC_WEBSOCKET_KEY,
            "dGhlIHNhbXBsZSBub25jZQ==".parse().unwrap(),
        );
        assert_eq!(
            Framing::of(&headers),
            Some(Framing::WebSocket {
                accept: "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".into()
            })
        );
        headers.insert(UPGRADE, "h2c".parse().unwrap());
        assert_eq!(Framing::of(&headers), None);
        headers.insert(UPGRADE, "intentic-terminal".parse().unwrap());
        assert_eq!(Framing::of(&headers), Some(Framing::Frames));
        headers.insert(CONNECTION, "keep-alive".parse().unwrap());
        assert_eq!(Framing::of(&headers), None);
        assert_eq!(
            String::from_utf8(Framing::Frames.switching_head()).unwrap(),
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: intentic-terminal\r\nconnection: Upgrade\r\n\r\n"
        );
    }
}
