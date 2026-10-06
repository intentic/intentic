//! A tunnel's WebSocket as the byte stream its session runs on (yamux on `/tunnel/v2`, h2 on the edge's legacy door).
//! Two tasks, one per direction, since a session that cannot write while its reader is parked on a full buffer
//! deadlocks; either ending ends the tunnel. The socket's liveness is the tunnel's only one: netd pings, and both
//! ends drop a peer silent past `DEAD_AFTER`, since a path that died without a FIN reports nothing else. That check runs
//! in a task of its own beside both directions: in the writer's loop, as it was until 2026-10-05, a write stalled on a
//! dead path held it, and the tunnel stayed up until TCP gave up minutes later.

use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures_util::{Sink, SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};

use crate::{DEAD_AFTER, Heard, PING_EVERY};

// Bytes in flight between the WebSocket and the session, each way; past it the reader simply waits. Small, since every
// stream's frames queue here in the order the session wrote them: a keystroke waits behind at most this much.
const PIPE_BYTES: usize = 64 * 1024;

// One WebSocket message's worth of what the session wrote.
const READ_CHUNK: usize = 64 * 1024;

// A far end's close reaches the reader just after it made the writer fail; waited for this long, its code says why.
const CLOSE_HEARD_WITHIN: Duration = Duration::from_secs(1);

// A single write the socket has not taken by now is a path that stopped carrying anything. The silence check says the
// same within a ping's interval; this also ends the writer rather than leave it parked on the dead socket.
const WRITE_PATIENCE: Duration = DEAD_AFTER;

/// A close this end sends: why the tunnel is ending, in the WebSocket's own terms. The reason fits a close frame: 123
/// bytes at most.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Close {
    pub code: u16,
    pub reason: Cow<'static, str>,
}

impl Close {
    /// This end is going away (a restart, a shutdown); the far end redials.
    pub const AWAY: Self = Self {
        code: 1001,
        reason: Cow::Borrowed("going away"),
    };
}

/// What this end does for the socket's liveness. Either way it drops a peer silent past `DEAD_AFTER`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    /// Pings every `PING_EVERY`: netd, which dials, so an edge holding thousands of tunnels sends none itself.
    Pings,
    /// Only listens, the far end's pings and their answers being frames like any other: the edge.
    Listens,
}

/// How a tunnel ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// The far end closed it, with the code it gave.
    Closed(Option<u16>),
    /// Anything else: a socket error, silence past `DEAD_AFTER`, the session ending, or a close this end sent.
    Dropped(String),
}

/// Runs `socket` as a byte stream, answering the session's side of it and a future that resolves once the tunnel ends.
/// `closing` sends a close frame and ends the tunnel once it holds one.
pub fn pump<S>(
    socket: WebSocketStream<S>,
    liveness: Liveness,
    mut closing: watch::Receiver<Option<Close>>,
) -> (DuplexStream, Pumping)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (session, pump) = tokio::io::duplex(PIPE_BYTES);
    let (mut from_session, mut into_session) = tokio::io::split(pump);
    let (mut sink, mut frames) = socket.split();
    // Any frame proves the far end alive, not only a pong; a pong also proves a round this end asked for.
    let heard = Arc::new(Heard::default());
    let because = Arc::new(Mutex::new(None));

    let hearing = heard.clone();
    let giving = because.clone();
    let inbound = tokio::spawn(async move {
        while let Some(frame) = frames.next().await {
            hearing.mark();
            let bytes = match frame {
                Ok(Message::Binary(bytes)) => bytes,
                // A stray text frame is coerced rather than dropped.
                Ok(Message::Text(text)) => Bytes::from(text.as_str().to_owned()),
                Ok(Message::Close(frame)) => {
                    if let Some(frame) = &frame
                        && !frame.reason.is_empty()
                    {
                        *giving.lock().expect("a close reason is never poisoned") =
                            Some(frame.reason.as_str().to_owned());
                    }
                    return Ended::Closed(frame.map(|frame| u16::from(frame.code)));
                }
                Ok(Message::Pong(_)) => {
                    hearing.answer();
                    continue;
                }
                Ok(_) => continue,
                Err(error) => return Ended::Dropped(error.to_string()),
            };
            if into_session.write_all(&bytes).await.is_err() {
                return Ended::Dropped("the session stopped reading".into());
            }
        }
        Ended::Dropped("the tunnel socket ended".into())
    });

    let outbound = tokio::spawn(async move {
        let mut buffer = vec![0_u8; READ_CHUNK];
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            tokio::select! {
                read = from_session.read(&mut buffer) => match read {
                    Ok(0) | Err(_) => return Outbound::Ended(Ended::Dropped("the session ended".into())),
                    Ok(read) => {
                        let message = Message::Binary(Bytes::copy_from_slice(&buffer[..read]));
                        if let Some(failed) = send_within(&mut sink, message, Sent::Write).await {
                            return failed;
                        }
                    }
                },
                _ = ping.tick() => {
                    if liveness == Liveness::Pings
                        && let Some(failed) = send_within(&mut sink, Message::Ping(Bytes::new()), Sent::Ping).await
                    {
                        return failed;
                    }
                }
                close = raised(&mut closing) => {
                    let frame = CloseFrame { code: close.code.into(), reason: Utf8Bytes::from(close.reason.to_string()) };
                    let _ = tokio::time::timeout(WRITE_PATIENCE, sink.send(Message::Close(Some(frame)))).await;
                    return Outbound::Ended(Ended::Dropped(format!("closed here: {}", close.reason)));
                }
            }
        }
    });

    // Its own task, so nothing either direction waits on can postpone it.
    let watching = heard.clone();
    let silence = tokio::spawn(async move {
        let mut check = tokio::time::interval(PING_EVERY);
        check.tick().await;
        loop {
            check.tick().await;
            let silent = watching.silent();
            if silent > DEAD_AFTER {
                return Ended::Dropped(format!("no frame from the far end in {silent:?}"));
            }
        }
    });

    (
        session,
        Pumping {
            inbound,
            outbound,
            silence,
            heard,
            because,
        },
    )
}

// What the writer was sending when the socket failed it.
#[derive(Clone, Copy)]
enum Sent {
    Write,
    Ping,
}

// Sends one message, or answers how the writer ends: the socket refused it, or did not take it in time.
async fn send_within<K>(sink: &mut K, message: Message, sent: Sent) -> Option<Outbound>
where
    K: Sink<Message> + Unpin,
{
    match tokio::time::timeout(WRITE_PATIENCE, sink.send(message)).await {
        Ok(Ok(())) => None,
        Ok(Err(_)) => Some(Outbound::Refused(match sent {
            Sent::Write => "the tunnel socket refused a write",
            Sent::Ping => "the tunnel socket refused a ping",
        })),
        Err(_) => Some(Outbound::Ended(Ended::Dropped(format!(
            "{} the tunnel socket stalled for {WRITE_PATIENCE:?}",
            match sent {
                Sent::Write => "a write to",
                Sent::Ping => "a ping on",
            }
        )))),
    }
}

// How the writing direction stopped: on its own account, or refused by a socket the far end may just have closed.
enum Outbound {
    Ended(Ended),
    Refused(&'static str),
}

/// Both directions of a pumped tunnel and its silence check; dropping it stops them.
pub struct Pumping {
    inbound: JoinHandle<Ended>,
    outbound: JoinHandle<Outbound>,
    silence: JoinHandle<Ended>,
    heard: Arc<Heard>,
    because: Arc<Mutex<Option<String>>>,
}

impl Pumping {
    /// The reason the far end's close frame gave, once it closed with one: where another copy runs, for a tunnel the
    /// edge closed with `HELD_ELSEWHERE_CODE`.
    pub fn close_reason(&self) -> Option<String> {
        self.because
            .lock()
            .expect("a close reason is never poisoned")
            .clone()
    }

    /// When the far end was last heard, and whether it ever answered a ping: what the edge reads to know a holder is
    /// alive, and what netd reads to count a carrier as having worked.
    pub fn heard(&self) -> Arc<Heard> {
        self.heard.clone()
    }

    /// How the tunnel ended, once either direction has or the far end went silent; the rest is stopped then.
    pub async fn ended(&mut self) -> Ended {
        let ended = tokio::select! {
            ended = &mut self.inbound => ended.unwrap_or_else(|error| Ended::Dropped(error.to_string())),
            silent = &mut self.silence => silent.unwrap_or_else(|error| Ended::Dropped(error.to_string())),
            outbound = &mut self.outbound => match outbound {
                Ok(Outbound::Ended(ended)) => ended,
                Ok(Outbound::Refused(why)) => match tokio::time::timeout(CLOSE_HEARD_WITHIN, &mut self.inbound).await {
                    Ok(Ok(closed @ Ended::Closed(_))) => closed,
                    _ => Ended::Dropped(why.into()),
                },
                Err(error) => Ended::Dropped(error.to_string()),
            },
        };
        self.inbound.abort();
        self.outbound.abort();
        self.silence.abort();
        ended
    }
}

impl Drop for Pumping {
    fn drop(&mut self) {
        self.inbound.abort();
        self.outbound.abort();
        self.silence.abort();
    }
}

/// Resolves with the close once `flag` holds one, and never if its sender goes. The guard `wait_for` hands back must not
/// live across the await that follows it in a spawned task.
pub async fn raised(flag: &mut watch::Receiver<Option<Close>>) -> Close {
    let raised = flag
        .wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|close| close.clone());
    match raised {
        Some(close) => close,
        // The sender is gone: nothing will ever ask this tunnel to close.
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;
    use tokio_tungstenite::tungstenite::protocol::Role;

    async fn pair() -> (WebSocketStream<DuplexStream>, WebSocketStream<DuplexStream>) {
        let (client, server) = tokio::io::duplex(1 << 20);
        (
            WebSocketStream::from_raw_socket(client, Role::Client, None).await,
            WebSocketStream::from_raw_socket(server, Role::Server, None).await,
        )
    }

    #[tokio::test]
    async fn bytes_cross_both_ways_and_a_close_names_its_code() {
        let (near, far) = pair().await;
        let (_near_close, near_closing) = watch::channel(None);
        let (far_close, far_closing) = watch::channel(None);
        let (mut near_session, mut near_pumping) = pump(near, Liveness::Pings, near_closing);
        let (mut far_session, mut far_pumping) = pump(far, Liveness::Listens, far_closing);

        near_session.write_all(b"hello from near").await.unwrap();
        let mut read = vec![0_u8; 15];
        far_session.read_exact(&mut read).await.unwrap();
        assert_eq!(read, b"hello from near");
        far_session.write_all(b"and back").await.unwrap();
        let mut read = vec![0_u8; 8];
        near_session.read_exact(&mut read).await.unwrap();
        assert_eq!(read, b"and back");

        far_close.send_replace(Some(Close {
            code: 4001,
            reason: "displaced".into(),
        }));
        assert_eq!(near_pumping.ended().await, Ended::Closed(Some(4001)));
        assert_eq!(near_pumping.close_reason().as_deref(), Some("displaced"));
        assert!(matches!(far_pumping.ended().await, Ended::Dropped(_)));
    }

    // The race a displacement meets: the displaced end is mid-write when the close arrives, and its writer fails first.
    #[tokio::test]
    async fn a_close_arriving_mid_write_still_names_its_code() {
        for _ in 0..50 {
            let (near, far) = pair().await;
            let (_near_close, near_closing) = watch::channel(None);
            let (far_close, far_closing) = watch::channel(None);
            let (mut near_session, mut near_pumping) = pump(near, Liveness::Pings, near_closing);
            let (_far_session, _far_pumping) = pump(far, Liveness::Listens, far_closing);
            let writing = tokio::spawn(async move {
                while near_session.write_all(&[7_u8; 4096]).await.is_ok() {}
            });
            tokio::task::yield_now().await;
            far_close.send_replace(Some(Close {
                code: 4001,
                reason: "displaced".into(),
            }));
            assert_eq!(near_pumping.ended().await, Ended::Closed(Some(4001)));
            writing.abort();
        }
    }

    #[tokio::test]
    async fn the_session_ending_ends_the_tunnel() {
        let (near, far) = pair().await;
        let (_near_close, near_closing) = watch::channel(None);
        let (_far_close, far_closing) = watch::channel(None);
        let (near_session, mut near_pumping) = pump(near, Liveness::Pings, near_closing);
        let (_far_session, _far_pumping) = pump(far, Liveness::Listens, far_closing);
        drop(near_session);
        assert_eq!(
            near_pumping.ended().await,
            Ended::Dropped("the session ended".into())
        );
    }

    // Only netd pings; the edge hears those pings and its own answers to them as netd's frames, netd hears
    // the answers as the edge's, so a quiet tunnel outlives any number of dead windows on both ends.
    #[tokio::test(start_paused = true)]
    async fn one_end_pinging_keeps_both_ends_of_a_quiet_tunnel() {
        let (near, far) = pair().await;
        let (_near_close, near_closing) = watch::channel(None);
        let (_far_close, far_closing) = watch::channel(None);
        let (_near_session, mut near_pumping) = pump(near, Liveness::Pings, near_closing);
        let (_far_session, mut far_pumping) = pump(far, Liveness::Listens, far_closing);
        let quiet = DEAD_AFTER * 5;
        tokio::select! {
            ended = near_pumping.ended() => panic!("the pinging end ended: {ended:?}"),
            ended = far_pumping.ended() => panic!("the listening end ended: {ended:?}"),
            () = tokio::time::sleep(quiet) => {}
        }
    }

    // Two ends that both only listen hear nothing, and each drops the other once the dead window passes.
    #[tokio::test(start_paused = true)]
    async fn a_silent_peer_is_dropped_after_the_dead_window() {
        let (near, far) = pair().await;
        let (_near_close, near_closing) = watch::channel(None);
        let (_far_close, far_closing) = watch::channel(None);
        let (_near_session, mut near_pumping) = pump(near, Liveness::Listens, near_closing);
        let (_far_session, _far_pumping) = pump(far, Liveness::Listens, far_closing);
        let started = Instant::now();
        let Ended::Dropped(why) = near_pumping.ended().await else {
            panic!("a silent peer is dropped, not closed");
        };
        assert!(why.starts_with("no frame from the far end"), "{why}");
        assert!(started.elapsed() > DEAD_AFTER);
        assert!(started.elapsed() <= DEAD_AFTER + PING_EVERY);
    }

    // A pong is a round this end asked for coming back: netd counts a carrier that carried one as having worked.
    #[tokio::test(start_paused = true)]
    async fn a_pong_marks_the_pinging_end_answered() {
        let (near, far) = pair().await;
        let (_near_close, near_closing) = watch::channel(None);
        let (_far_close, far_closing) = watch::channel(None);
        let (_near_session, near_pumping) = pump(near, Liveness::Pings, near_closing);
        let (_far_session, far_pumping) = pump(far, Liveness::Listens, far_closing);
        assert!(!near_pumping.heard().answered());
        tokio::time::sleep(PING_EVERY + Duration::from_secs(1)).await;
        assert!(near_pumping.heard().answered());
        assert!(near_pumping.heard().alive());
        assert!(
            !far_pumping.heard().answered(),
            "the listening end asks nothing"
        );
    }

    // The 2026-10-05 gap: a far end that stops reading parks this end's write, and the silence check that shared the
    // writer's loop waited behind it. Now it runs beside it, and the tunnel ends within a dead window and a ping.
    #[tokio::test(start_paused = true)]
    async fn a_stalled_write_cannot_postpone_the_silence_check() {
        let (client, _never_read) = tokio::io::duplex(4 * 1024);
        let near = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        let (_near_close, near_closing) = watch::channel(None);
        let (mut near_session, mut near_pumping) = pump(near, Liveness::Pings, near_closing);
        let writing = tokio::spawn(async move {
            while near_session.write_all(&[7_u8; 16 * 1024]).await.is_ok() {}
        });
        let started = Instant::now();
        let Ended::Dropped(why) = near_pumping.ended().await else {
            panic!("a silent far end is dropped, not closed");
        };
        assert!(
            why.starts_with("no frame from the far end") || why.contains("stalled"),
            "{why}"
        );
        assert!(
            started.elapsed() <= DEAD_AFTER + PING_EVERY,
            "{:?}",
            started.elapsed()
        );
        writing.abort();
    }
}
