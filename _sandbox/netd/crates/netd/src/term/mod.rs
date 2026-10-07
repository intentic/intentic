//! Terminals, served by netd itself: `GET /system/terminal` upgrades onto a tmux session or a service's log, which
//! Node authorizes with one question and never carries a byte of. A browser's socket is always a WebSocket: over TCP, or
//! spoken by the editor itself on a WebTransport stream the edge relays as one HTTP/1.1 connection, which reaches here
//! as the same upgrade.

mod control;
mod hub;
mod screen;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use browser_wire::{TERMINAL_PATH, TERMINAL_UPGRADE, TerminalClientMessage, TerminalServerMessage};
use bytes::Bytes;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use http::header::{
    CONNECTION, HeaderMap, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE,
};
use http::{Method, Response, StatusCode};
use netd_wire::TerminalPlan;
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

/// Every route netd answers itself; the contract marks each `netd` (raw-routes.ts), and a test holds them equal.
pub const ROUTES: [(&str, &str); 1] = [("GET", TERMINAL_PATH)];

// A per-sandbox bound, not a quota; 1013 sends the browser to its usual backoff.
const MAX_TERMINALS: usize = 32;

// The socket's liveness is the client's: the editor pings every 30 s (`TerminalClientMessage::Ping`) and calls the socket
// stale after 90 s without a frame. netd answers and listens: a client silent this long is sent a WebSocket ping,
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

// A socket's revocation, latched: a look after it still sees it, and every waiter is woken, its reader and its pump.
#[derive(Default)]
struct Revocation {
    revoked: AtomicBool,
    woken: Notify,
}

impl Revocation {
    fn revoke(&self) {
        self.revoked.store(true, Ordering::SeqCst);
        self.woken.notify_waiters();
    }

    fn revoked(&self) -> bool {
        self.revoked.load(Ordering::SeqCst)
    }

    // A `Notified` counts toward `notify_waiters` from its creation, so one made before the look misses nothing.
    async fn wait(&self) {
        let woken = self.woken.notified();
        if !self.revoked() {
            woken.await;
        }
    }
}

struct Open {
    member: Option<String>,
    revocation: Arc<Revocation>,
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
    revocation: Arc<Revocation>,
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
                open.revocation.revoke();
            }
        }
    }

    fn seat(self: &Arc<Self>, member: Option<String>) -> Option<Seat> {
        let mut open = self.open.lock().expect("terminals poisoned");
        if open.len() >= MAX_TERMINALS {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let revocation = Arc::new(Revocation::default());
        open.insert(
            id,
            Open {
                member,
                revocation: revocation.clone(),
            },
        );
        Some(Seat {
            terminals: self.clone(),
            id,
            revocation,
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
    let revocation = &seat.revocation;
    let reader = tokio::spawn(read(
        stream,
        controls,
        replies,
        heard.clone(),
        revocation.clone(),
    ));
    let mut listening =
        tokio::time::interval_at(tokio::time::Instant::now() + LISTEN_EVERY, LISTEN_EVERY);
    // Endless output never reaches the select at the bottom, so the revocation is looked at on every frame.
    let serving = async {
        while !revocation.revoked() {
            match outbox.take(FRAME_MAX) {
                Taken::Grid(cols, rows) => {
                    if sink
                        .send(text(&TerminalServerMessage::Grid { cols, rows }))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    continue;
                }
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
            }
        }
    };
    // A send to a client that does not read blocks wherever the loop is: the revocation drops it there.
    tokio::select! {
        biased;
        () = revocation.wait() => {}
        () = serving => {}
    }
    reader.abort();
    if revocation.revoked() {
        let revoked = Message::Close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: Utf8Bytes::from_static("authorization revoked"),
        }));
        let _ = tokio::time::timeout(CLOSE_PATIENCE, sink.feed(revoked)).await;
    }
    let _ = tokio::time::timeout(CLOSE_PATIENCE, sink.close()).await;
}

// When the client was last heard from: any frame, its ping, a keystroke or the answer to a ping of netd's.
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

// Ends when the browser closes or goes silent, and its end ends the pump: it drops the only sender of `replies`. A
// revocation ends it too, and nothing read after one reaches the pane.
async fn read<R, E>(
    mut stream: R,
    controls: Option<Controls>,
    replies: mpsc::UnboundedSender<Message>,
    heard: Heard,
    revocation: Arc<Revocation>,
) where
    R: Stream<Item = Result<Message, E>> + Unpin,
{
    loop {
        let message = tokio::select! {
            biased;
            () = revocation.wait() => return,
            message = stream.next() => message,
        };
        let Some(Ok(message)) = message else {
            return;
        };
        // Read as the revocation landed: dropped with everything after it.
        if revocation.revoked() {
            return;
        }
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
    use std::convert::Infallible;

    use tokio::io::DuplexStream;
    use tokio::task::JoinHandle;
    use tokio::time::timeout;

    use super::*;

    const PATIENCE: Duration = Duration::from_secs(10);

    const GONE: &str = "gone@example.com";

    fn said(message: &TerminalClientMessage) -> Message {
        Message::text(serde_json::to_string(message).unwrap())
    }

    fn typed(data: &str) -> Message {
        said(&TerminalClientMessage::Input { data: data.into() })
    }

    // netd's half and the browser's, over memory; a browser that does not read fills it at 64 KiB.
    async fn sockets() -> (WebSocketStream<DuplexStream>, WebSocketStream<DuplexStream>) {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        (
            WebSocketStream::from_raw_socket(ours, Role::Server, None).await,
            WebSocketStream::from_raw_socket(theirs, Role::Client, None).await,
        )
    }

    // `yes`: an outbox that never runs dry.
    fn endless() -> (Arc<Outbox>, JoinHandle<()>) {
        let outbox = Arc::new(Outbox::live());
        let filling = outbox.clone();
        let producing = tokio::spawn(async move {
            loop {
                filling.push(&[b'y'; 4096]).await;
            }
        });
        (outbox, producing)
    }

    fn pumping(
        socket: WebSocketStream<DuplexStream>,
        outbox: Arc<Outbox>,
        controls: Option<Controls>,
        seat: Seat,
    ) -> JoinHandle<()> {
        tokio::spawn(async move { pump(socket, &outbox, controls, &seat, || {}).await })
    }

    // The browser's frames, as the socket's stream; `landing` runs as each is handed over.
    fn frames(
        mut landing: impl FnMut() + Send + Unpin + 'static,
    ) -> (
        mpsc::UnboundedSender<Result<Message, Infallible>>,
        impl Stream<Item = Result<Message, Infallible>> + Unpin + Send + 'static,
    ) {
        let (sending, mut sent) = mpsc::unbounded_channel();
        let stream = futures_util::stream::poll_fn(move |cx| {
            let frame = sent.poll_recv(cx);
            if frame.is_ready() {
                landing();
            }
            frame
        });
        (sending, stream)
    }

    #[tokio::test]
    async fn a_revocation_wakes_every_waiter_and_is_seen_by_a_look_after_it() {
        let revocation = Arc::new(Revocation::default());
        let waiters: Vec<_> = (0..2)
            .map(|_| {
                let revocation = revocation.clone();
                tokio::spawn(async move { revocation.wait().await })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(waiters.iter().all(|waiter| !waiter.is_finished()));
        revocation.revoke();
        for waiter in waiters {
            timeout(PATIENCE, waiter).await.unwrap().unwrap();
        }
        // `notify_waiters` keeps no permit: the latch is what a late look sees.
        assert!(revocation.revoked());
        timeout(PATIENCE, revocation.wait()).await.unwrap();
    }

    #[test]
    fn a_members_revocation_closes_only_theirs_and_none_closes_the_owners() {
        let terminals = Terminals::new(Hubs::new(Tmux::default()));
        let gone = terminals.seat(Some(GONE.into())).unwrap();
        let kept = terminals.seat(Some("kept@example.com".into())).unwrap();
        let owner = terminals.seat(None).unwrap();
        let revoked = || [&gone, &kept, &owner].map(|seat| seat.revocation.revoked());
        terminals.revoke(Some(GONE));
        assert_eq!(revoked(), [true, false, false]);
        terminals.revoke(None);
        assert_eq!(revoked(), [true, true, false]);
    }

    #[tokio::test]
    async fn the_reader_forwards_nothing_sent_after_a_revocation_and_ends_by_itself() {
        let revocation = Arc::new(Revocation::default());
        let (controls, mut forwarded) = Controls::unhubbed();
        let (browser, stream) = frames(|| {});
        let (replies, _answering) = mpsc::unbounded_channel();
        let reading = tokio::spawn(read(
            stream,
            Some(controls),
            replies,
            Heard::now(),
            revocation.clone(),
        ));
        browser.send(Ok(typed("before"))).unwrap();
        let first = timeout(PATIENCE, forwarded.next()).await.unwrap();
        assert_eq!(first.as_deref(), Some("input before"));
        revocation.revoke();
        browser.send(Ok(typed("after"))).unwrap();
        browser
            .send(Ok(said(&TerminalClientMessage::Resize {
                cols: 100,
                rows: 30,
            })))
            .unwrap();
        // Nothing aborts it here.
        timeout(PATIENCE, reading).await.unwrap().unwrap();
        assert_eq!(forwarded.next().await, None);
    }

    #[tokio::test]
    async fn a_frame_read_as_the_revocation_lands_is_not_forwarded() {
        let revocation = Arc::new(Revocation::default());
        let (controls, mut forwarded) = Controls::unhubbed();
        let revoking = revocation.clone();
        let mut handed = 0;
        let (browser, stream) = frames(move || {
            handed += 1;
            if handed == 2 {
                revoking.revoke();
            }
        });
        for data in ["before", "during", "after"] {
            browser.send(Ok(typed(data))).unwrap();
        }
        let (replies, _answering) = mpsc::unbounded_channel();
        let reading = tokio::spawn(read(
            stream,
            Some(controls),
            replies,
            Heard::now(),
            revocation,
        ));
        timeout(PATIENCE, reading).await.unwrap().unwrap();
        assert_eq!(forwarded.rest(), ["input before"]);
    }

    #[tokio::test]
    async fn a_revocation_ends_a_pump_stuck_sending_endless_output_to_a_browser_that_never_reads() {
        let (ours, mut theirs) = sockets().await;
        let (outbox, producing) = endless();
        let terminals = Terminals::new(Hubs::new(Tmux::default()));
        let seat = terminals.seat(Some(GONE.into())).unwrap();
        let (controls, mut forwarded) = Controls::unhubbed();
        let pump = pumping(ours, outbox, Some(controls), seat);
        theirs.send(typed("before")).await.unwrap();
        let first = timeout(PATIENCE, forwarded.next()).await.unwrap();
        assert_eq!(first.as_deref(), Some("input before"));
        terminals.revoke(Some(GONE));
        theirs.send(typed("after")).await.unwrap();
        // Bounded by the close's own patience alone: the send it was stuck in is dropped, not waited out.
        timeout(CLOSE_PATIENCE * 3, pump).await.unwrap().unwrap();
        assert_eq!(forwarded.next().await, None);
        producing.abort();
    }

    #[tokio::test]
    async fn a_revocation_ends_endless_output_with_the_policy_close() {
        let (ours, mut theirs) = sockets().await;
        let (outbox, producing) = endless();
        let terminals = Terminals::new(Hubs::new(Tmux::default()));
        let seat = terminals.seat(Some(GONE.into())).unwrap();
        let pump = pumping(ours, outbox, None, seat);
        let flowing = timeout(PATIENCE, theirs.next()).await.unwrap();
        assert!(matches!(flowing, Some(Ok(Message::Binary(_)))));
        terminals.revoke(Some(GONE));
        let closed = timeout(PATIENCE, async {
            while let Some(Ok(message)) = theirs.next().await {
                if let Message::Close(frame) = message {
                    return frame.map(|frame| (frame.code, frame.reason.to_string()));
                }
            }
            None
        })
        .await
        .unwrap();
        assert_eq!(
            closed,
            Some((CloseCode::Policy, "authorization revoked".into()))
        );
        timeout(PATIENCE, pump).await.unwrap().unwrap();
        producing.abort();
    }

    #[test]
    fn the_routes_the_netd_serves_are_the_ones_the_contract_marks_netd() {
        let table = include_str!(
            "../../../../../../_shared/sandbox-contract/src/protocol/raw/raw-routes.ts"
        );
        let marked: Vec<String> = table
            .lines()
            .filter(|line| line.contains("netd: true"))
            .filter_map(|line| {
                let (key, _) = line.trim().strip_prefix('"')?.split_once('"')?;
                Some(key.to_owned())
            })
            .collect();
        // The terminal's routes and the vitals route (vitals.rs), in the order the contract lists them.
        let served: Vec<String> = ROUTES
            .iter()
            .copied()
            .chain([("GET", browser_wire::VITALS_PATH)])
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
