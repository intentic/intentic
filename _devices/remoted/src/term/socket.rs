//! One viewer's terminal socket, after its upgrade: browser-wire's terminal protocol exactly as netd speaks it (JSON
//! `TerminalClientMessage` in, `TerminalServerMessage` and the pane's bytes as binary messages out, `deflate=1` and
//! `away=1` in the query), so the editor's terminal client opens one unchanged but for its URL. What a viewer may do is
//! its token's: a read-only one watches and what it types is dropped, and nobody's typing reaches the program while the
//! person at the computer has paused people's input or the uplink's terminal switch is off.
//!
//! An open socket outlives its token by castd's grace (`MEDIA_TOKEN_GRACE_SECONDS`): each fresh token the editor holds
//! is sent on the socket as browser-wire's `{"type":"token","token":"…"}`, and one whose newest token expired longer ago
//! than that is closed with 4002. A drop (`POST /viewers/drop`, or the person at the computer ending every session) closes it with 4001.

use std::sync::Arc;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::time::Duration;

use browser_wire::{MEDIA_TOKEN_GRACE_SECONDS, TerminalClientMessage, TerminalServerMessage};
use bytes::Bytes;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use tokio::sync::{Notify, mpsc};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};

use super::deflate;
use super::outbox::Taken;
use super::session::{Controls, Seat};

/// The close code of a socket whose viewers were dropped (castd's `dropped`).
pub const DROPPED: u16 = 4001;

/// The close code of a socket whose newest token expired past the grace (castd's `expired`).
pub const EXPIRED: u16 = 4002;

// The client's liveness: the editor pings every 30 s and calls the socket stale after 90 s without a frame; remoted
// answers, pings a client silent this long...
const QUIET: Duration = Duration::from_secs(45);

// ...and drops one silent this long.
const SILENT: Duration = Duration::from_secs(90);

// How often silence and the token's age are looked at.
const LISTEN_EVERY: Duration = Duration::from_secs(15);

const CLOSE_PATIENCE: Duration = Duration::from_secs(1);

// One frame never holds the socket long.
const FRAME_MAX: usize = 256 * 1024;

/// A paste arrives as one message; past this it is not a paste.
pub const MESSAGE_MAX: usize = 16 * 1024 * 1024;

/// A socket's end decided elsewhere, latched with the close code it is closed with.
#[derive(Default)]
pub struct Revocation {
    code: AtomicU16,
    woken: Notify,
}

impl Revocation {
    pub fn revoke(&self, code: u16) {
        if self
            .code
            .compare_exchange(0, code, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.woken.notify_waiters();
        }
    }

    pub fn code(&self) -> Option<u16> {
        Some(self.code.load(Ordering::SeqCst)).filter(|code| *code != 0)
    }

    async fn wait(&self) {
        let woken = self.woken.notified();
        if self.code().is_none() {
            woken.await;
        }
    }
}

/// What a socket asks of remoted while it runs: whether typing reaches the program now, and whether a fresh token opens
/// what the socket's first one did (its expiry when it does).
pub trait Gate: Send + Sync + 'static {
    fn input_allowed(&self) -> bool;
    fn refresh(&self, token: &str, read_only: bool) -> Option<u64>;
}

/// Everything a socket is, besides its stream.
pub struct Viewing {
    pub seat: Seat,
    pub read_only: bool,
    /// The newest token's expiry, in ms since the epoch.
    pub expires: u64,
    pub revocation: Arc<Revocation>,
    pub gate: Arc<dyn Gate>,
    pub deflate: bool,
}

/// How long a socket outlives its newest token's expiry: castd's grace, `MEDIA_TOKEN_GRACE_SECONDS`. A debug build takes
/// another from `INTENTIC_REMOTED_TOKEN_GRACE_MS`, so an end-to-end test can watch a socket closed for its token (4002)
/// and a fresh token keep one open without waiting ten minutes; a release build reads nothing.
pub fn token_grace_ms() -> u64 {
    let castds = MEDIA_TOKEN_GRACE_SECONDS * 1000;
    if !cfg!(debug_assertions) {
        return castds;
    }
    std::env::var("INTENTIC_REMOTED_TOKEN_GRACE_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(castds)
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

/// Whether the browser opened the socket out of sight.
pub fn away(query: &str) -> bool {
    query.split('&').any(|pair| pair == "away=1")
}

pub fn text(message: &TerminalServerMessage) -> Message {
    Message::text(serde_json::to_string(message).expect("a server message always serializes"))
}

pub fn exit(code: i32, reason: Option<String>) -> Message {
    text(&TerminalServerMessage::Exit {
        code,
        reason: reason.filter(|reason| !reason.is_empty()),
    })
}

fn close_frame(code: u16, reason: &str) -> Message {
    let mut end = reason.len().min(123);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: Utf8Bytes::from(&reason[..end]),
    }))
}

// When the client was last heard from.
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

/// Serves the socket until the viewer leaves, goes silent, is revoked or outlives its token, or the terminal ends.
pub async fn serve<T, E>(socket: T, viewing: Viewing)
where
    T: Sink<Message, Error = E> + Stream<Item = Result<Message, E>> + Send + 'static,
    E: Send + 'static,
{
    let (mut sink, stream) = socket.split();
    let (replies, mut answering) = mpsc::unbounded_channel();
    let heard = Heard::now();
    let expires = Arc::new(AtomicU64::new(viewing.expires));
    let grace = token_grace_ms();
    let revocation = viewing.revocation.clone();
    let reader = tokio::spawn(read(
        stream,
        Reading {
            controls: viewing.seat.controls(),
            read_only: viewing.read_only,
            gate: viewing.gate.clone(),
            expires: expires.clone(),
            replies,
            heard: heard.clone(),
            revocation: revocation.clone(),
        },
    ));
    let outbox = viewing.seat.outbox.clone();
    let mut listening =
        tokio::time::interval_at(tokio::time::Instant::now() + LISTEN_EVERY, LISTEN_EVERY);
    let mut deflater = viewing.deflate.then(deflate::Deflater::default);
    let serving = async {
        if deflater.is_some()
            && sink
                .send(text(&TerminalServerMessage::Deflate))
                .await
                .is_err()
        {
            return;
        }
        while revocation.code().is_none() {
            match outbox.take(FRAME_MAX) {
                Taken::Grid(cols, rows) => {
                    if sink
                        .send(text(&TerminalServerMessage::Grid { cols, rows }))
                        .await
                        .is_err()
                    {
                        return;
                    }
                    continue;
                }
                Taken::Bytes(bytes) => {
                    let message = match deflater.as_mut() {
                        Some(deflater) => Bytes::from(deflater.message(&bytes)),
                        None => bytes,
                    };
                    if sink.send(Message::Binary(message)).await.is_err() {
                        return;
                    }
                    continue;
                }
                Taken::Ended(code, reason) => {
                    let _ = sink.feed(exit(code, reason)).await;
                    let _ = sink.feed(Message::Close(None)).await;
                    return;
                }
                Taken::Resync => {
                    if sink.flush().await.is_err() {
                        return;
                    }
                    viewing.seat.resync();
                    continue;
                }
                Taken::Nothing => {}
            }
            tokio::select! {
                () = outbox.changed() => {}
                reply = answering.recv() => {
                    let Some(reply) = reply else {
                        return;
                    };
                    if sink.send(reply).await.is_err() {
                        return;
                    }
                }
                _ = listening.tick() => {
                    let silent = heard.silent();
                    if silent >= SILENT {
                        return;
                    }
                    if crate::token::now_ms() > expires.load(Ordering::Relaxed).saturating_add(grace) {
                        revocation.revoke(EXPIRED);
                        return;
                    }
                    if silent >= QUIET && sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        return;
                    }
                }
            }
        }
    };
    tokio::select! {
        biased;
        () = revocation.wait() => {}
        () = serving => {}
    }
    reader.abort();
    if let Some(code) = revocation.code() {
        let reason = match code {
            DROPPED => "dropped",
            EXPIRED => "token expired",
            _ => "ended",
        };
        let _ = tokio::time::timeout(CLOSE_PATIENCE, sink.feed(close_frame(code, reason))).await;
    }
    let _ = tokio::time::timeout(CLOSE_PATIENCE, sink.close()).await;
}

struct Reading {
    controls: Controls,
    read_only: bool,
    gate: Arc<dyn Gate>,
    expires: Arc<AtomicU64>,
    replies: mpsc::UnboundedSender<Message>,
    heard: Heard,
    revocation: Arc<Revocation>,
}

// Ends when the viewer closes or goes silent, and its end ends the pump: it drops the only sender of `replies`. A
// revocation ends it too, and nothing read after one reaches the program.
async fn read<R, E>(mut stream: R, reading: Reading)
where
    R: Stream<Item = Result<Message, E>> + Unpin,
{
    loop {
        let message = tokio::select! {
            biased;
            () = reading.revocation.wait() => return,
            message = stream.next() => message,
        };
        let Some(Ok(message)) = message else {
            return;
        };
        if reading.revocation.code().is_some() {
            return;
        }
        reading.heard.hear();
        let payload = match message {
            Message::Text(payload) => payload,
            Message::Close(_) => return,
            _ => continue,
        };
        match serde_json::from_str(&payload) {
            // A fresher token (the editor's `remoteToken.ts` sends each one it is handed): the socket's expiry moves on
            // when it opens this terminal with the socket's own access.
            Ok(TerminalClientMessage::Token { token }) => {
                if let Some(expires) = reading.gate.refresh(&token, reading.read_only) {
                    reading.expires.fetch_max(expires, Ordering::Relaxed);
                }
            }
            Ok(TerminalClientMessage::Input { data }) => {
                if !reading.read_only && reading.gate.input_allowed() {
                    reading.controls.input(data.into_bytes());
                }
            }
            Ok(TerminalClientMessage::Resize { cols, rows }) => {
                if cols > 0 && rows > 0 {
                    reading.controls.resize(cols, rows);
                }
            }
            Ok(TerminalClientMessage::Away) => reading.controls.away(),
            Ok(TerminalClientMessage::Ping) => {
                let _ = reading.replies.send(text(&TerminalServerMessage::Pong));
            }
            // A message a newer editor sends that this remoted does not know: ignored, as netd does.
            #[allow(unreachable_patterns)]
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_query_says_the_size_and_whether_the_viewer_is_away() {
        assert_eq!(size_of("token=x&cols=120&rows=40"), (120, 40));
        assert_eq!(size_of("cols=0&rows=nope"), (80, 24));
        assert!(away("away=1&deflate=1"));
        assert!(!away("away=0"));
    }

    #[test]
    fn a_revocation_keeps_its_first_code() {
        let revocation = Revocation::default();
        assert_eq!(revocation.code(), None);
        revocation.revoke(DROPPED);
        revocation.revoke(EXPIRED);
        assert_eq!(revocation.code(), Some(DROPPED));
    }

    #[test]
    fn a_fresh_token_reads_as_browser_wires_own_message() {
        let Ok(TerminalClientMessage::Token { token }) =
            serde_json::from_str(r#"{"type":"token","token":"a.b"}"#)
        else {
            panic!("a token message did not read");
        };
        assert_eq!(token, "a.b");
    }
}
