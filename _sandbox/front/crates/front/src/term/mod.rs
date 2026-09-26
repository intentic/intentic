//! Terminals, served by the front itself: `GET /system/terminal` upgrades onto a tmux session or a service's log, which
//! Node authorizes with one question and never carries a byte of. A browser's socket is always a WebSocket: over TCP, or
//! spoken by the editor itself on a WebTransport stream the edge relays as one HTTP/1.1 connection, which reaches here
//! as the same upgrade.

mod control;
mod hub;
mod screen;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use browser_wire::{TERMINAL_PATH, TERMINAL_UPGRADE, TerminalClientMessage, TerminalServerMessage};
use bytes::Bytes;
use front_wire::TerminalPlan;
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

use hub::{Controls, Outbox, Taken};
pub use hub::{Hubs, Tmux};
use relay::body::{self, Body};

/// Every route the front answers itself; the contract marks each `front` (raw-routes.ts), and a test holds them equal.
pub const ROUTES: [(&str, &str); 1] = [("GET", TERMINAL_PATH)];

// A per-sandbox bound, not a quota; 1013 sends the browser to its usual backoff.
const MAX_TERMINALS: usize = 32;

// The socket's liveness is the client's: the editor pings every 30 s (`TerminalClientMessage::Ping`) and calls the socket
// stale after 90 s without a frame. The front answers and listens: a client silent this long is sent a WebSocket ping,
// which any client's stack answers by itself, so one that never pings (not the editor) is still heard from...
const QUIET: Duration = Duration::from_secs(45);

// ...and one silent this long is gone, as a half-open TCP connection never says.
const SILENT: Duration = Duration::from_secs(90);

// How often the silence is looked at.
const LISTEN_EVERY: Duration = Duration::from_secs(15);

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

/// A terminal's WebSocket handshake, answered with this `Sec-WebSocket-Accept`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    accept: String,
}

impl Handshake {
    /// The handshake a request opens, when it is a WebSocket's.
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
        if !names(CONNECTION, "upgrade")
            || !names(UPGRADE, TERMINAL_UPGRADE)
            || headers.get(SEC_WEBSOCKET_VERSION)?.as_bytes() != b"13"
        {
            return None;
        }
        Some(Self {
            accept: derive_accept_key(headers.get(SEC_WEBSOCKET_KEY)?.as_bytes()),
        })
    }

    pub fn switching(&self) -> Response<Body> {
        Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(CONNECTION, "Upgrade")
            .header(UPGRADE, TERMINAL_UPGRADE)
            .header(SEC_WEBSOCKET_ACCEPT, self.accept.as_str())
            .body(body::empty())
            .expect("a switching response always builds")
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
        plan: TerminalPlan,
        member: Option<String>,
        query: &str,
    ) where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let config = WebSocketConfig::default()
            .max_message_size(Some(MESSAGE_MAX))
            .max_frame_size(Some(MESSAGE_MAX));
        let socket = WebSocketStream::from_raw_socket(io, Role::Server, Some(config)).await;
        self.serve_socket(socket, plan, member, query).await;
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
            TerminalPlan::Session { name, create_in } => Feed::Session {
                argv: tmux_argv(&name, create_in.as_deref()),
                session: name,
            },
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

// What follows `tmux -C` for a session: `new-session -A` both creates it and reattaches one that exists, `-c` setting the
// working directory only on creation; a session with nowhere to be created in is only attached, `=` naming it exactly.
fn tmux_argv(name: &str, create_in: Option<&str>) -> Vec<String> {
    match create_in {
        Some(dir) => ["new-session", "-A", "-s", name, "-c", dir]
            .map(str::to_owned)
            .to_vec(),
        None => vec!["attach-session".into(), "-t".into(), format!("={name}")],
    }
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
    let heard = Heard::now();
    let reader = tokio::spawn(read(stream, controls, replies, heard.clone()));
    let mut listening =
        tokio::time::interval_at(tokio::time::Instant::now() + LISTEN_EVERY, LISTEN_EVERY);
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
            _ = listening.tick() => {
                let silent = heard.silent();
                if silent >= SILENT {
                    break;
                }
                if silent >= QUIET && sink.send(Message::Ping(Bytes::new())).await.is_err() {
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

// When the client was last heard from: any frame, its ping, a keystroke or the answer to a ping of the front's.
#[derive(Clone)]
struct Heard {
    since: tokio::time::Instant,
    millis: Arc<AtomicU64>,
}

impl Heard {
    fn now() -> Self {
        Self {
            since: tokio::time::Instant::now(),
            millis: Arc::new(AtomicU64::new(0)),
        }
    }

    fn hear(&self) {
        let millis = u64::try_from(self.since.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.millis.store(millis, Ordering::Relaxed);
    }

    fn silent(&self) -> Duration {
        self.since
            .elapsed()
            .saturating_sub(Duration::from_millis(self.millis.load(Ordering::Relaxed)))
    }
}

// Ends when the browser closes or goes silent, and its end ends the pump: it drops the only sender of `replies`.
async fn read<R, E>(
    mut stream: R,
    controls: Option<Controls>,
    replies: mpsc::UnboundedSender<Message>,
    heard: Heard,
) where
    R: Stream<Item = Result<Message, E>> + Unpin,
{
    while let Some(Ok(message)) = stream.next().await {
        heard.hear();
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
    fn a_session_is_created_where_node_says_and_otherwise_only_attached() {
        assert_eq!(
            tmux_argv("main", Some("/workspace/app")),
            ["new-session", "-A", "-s", "main", "-c", "/workspace/app"]
        );
        assert_eq!(
            tmux_argv("agent-7", None),
            ["attach-session", "-t", "=agent-7"]
        );
    }

    #[test]
    fn the_grid_is_read_from_the_query_and_defaults_where_unreadable() {
        assert_eq!(size_of("ticket=t&cols=120&rows=40"), (120, 40));
        assert_eq!(size_of("cols=0&rows=x"), (80, 24));
        assert_eq!(size_of(""), (80, 24));
    }

    #[test]
    fn only_a_websocket_upgrade_opens_a_terminal() {
        let mut headers = HeaderMap::new();
        headers.insert(UPGRADE, "websocket".parse().unwrap());
        headers.insert(CONNECTION, "keep-alive, Upgrade".parse().unwrap());
        headers.insert(SEC_WEBSOCKET_VERSION, "13".parse().unwrap());
        assert_eq!(Handshake::of(&headers), None);
        // RFC 6455's own example key and answer.
        headers.insert(
            SEC_WEBSOCKET_KEY,
            "dGhlIHNhbXBsZSBub25jZQ==".parse().unwrap(),
        );
        let switching = Handshake::of(&headers).unwrap().switching();
        assert_eq!(switching.status(), StatusCode::SWITCHING_PROTOCOLS);
        assert_eq!(
            switching.headers()[SEC_WEBSOCKET_ACCEPT],
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
        // The framing an earlier editor spoke on a WebTransport stream is no terminal any more: it is refused, and that
        // editor's own fallback takes the WebSocket.
        headers.insert(UPGRADE, "intentic-terminal".parse().unwrap());
        assert_eq!(Handshake::of(&headers), None);
        headers.insert(UPGRADE, "h2c".parse().unwrap());
        assert_eq!(Handshake::of(&headers), None);
        headers.insert(UPGRADE, "websocket".parse().unwrap());
        headers.insert(CONNECTION, "keep-alive".parse().unwrap());
        assert_eq!(Handshake::of(&headers), None);
    }
}
