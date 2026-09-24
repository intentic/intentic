//! A tunnel's WebSocket as the byte stream its h2 session runs on. Two tasks, one per direction, since a session that
//! cannot write while its reader is parked on a full buffer deadlocks; either ending ends the tunnel.

use std::borrow::Cow;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};

use crate::{DEAD_AFTER, PING_EVERY};

// Bytes in flight between the WebSocket and the session, each way; past it the reader simply waits.
const PIPE_BYTES: usize = 256 * 1024;

// One WebSocket message's worth of what the session wrote.
const READ_CHUNK: usize = 64 * 1024;

// A far end's close reaches the reader just after it made the writer fail; waited for this long, its code says why.
const CLOSE_HEARD_WITHIN: Duration = Duration::from_secs(1);

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
    mut closing: watch::Receiver<Option<Close>>,
) -> (DuplexStream, Pumping)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (session, pump) = tokio::io::duplex(PIPE_BYTES);
    let (mut from_session, mut into_session) = tokio::io::split(pump);
    let (mut sink, mut frames) = socket.split();
    let epoch = Instant::now();
    // Milliseconds since `epoch` of the last frame heard; any frame proves the far end alive, not only a pong.
    let heard = Arc::new(AtomicU64::new(0));

    let hearing = heard.clone();
    let inbound = tokio::spawn(async move {
        while let Some(frame) = frames.next().await {
            hearing.store(
                u64::try_from(epoch.elapsed().as_millis()).unwrap_or(u64::MAX),
                Ordering::Relaxed,
            );
            let bytes = match frame {
                Ok(Message::Binary(bytes)) => bytes,
                // A stray text frame is coerced rather than dropped.
                Ok(Message::Text(text)) => Bytes::from(text.as_str().to_owned()),
                Ok(Message::Close(frame)) => {
                    return Ended::Closed(frame.map(|frame| u16::from(frame.code)));
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
                        if sink.send(Message::Binary(Bytes::copy_from_slice(&buffer[..read]))).await.is_err() {
                            return Outbound::Refused("the tunnel socket refused a write");
                        }
                    }
                },
                _ = ping.tick() => {
                    let silent = epoch.elapsed().saturating_sub(Duration::from_millis(heard.load(Ordering::Relaxed)));
                    if silent > DEAD_AFTER {
                        return Outbound::Ended(Ended::Dropped(format!("no frame from the far end in {silent:?}")));
                    }
                    if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        return Outbound::Refused("the tunnel socket refused a ping");
                    }
                }
                close = raised(&mut closing) => {
                    let frame = CloseFrame { code: close.code.into(), reason: Utf8Bytes::from(close.reason.to_string()) };
                    let _ = sink.send(Message::Close(Some(frame))).await;
                    return Outbound::Ended(Ended::Dropped(format!("closed here: {}", close.reason)));
                }
            }
        }
    });

    (session, Pumping { inbound, outbound })
}

// How the writing direction stopped: on its own account, or refused by a socket the far end may just have closed.
enum Outbound {
    Ended(Ended),
    Refused(&'static str),
}

/// Both directions of a pumped tunnel; dropping it stops them.
pub struct Pumping {
    inbound: JoinHandle<Ended>,
    outbound: JoinHandle<Outbound>,
}

impl Pumping {
    /// How the tunnel ended, once either direction has; the other is stopped then.
    pub async fn ended(&mut self) -> Ended {
        let ended = tokio::select! {
            ended = &mut self.inbound => ended.unwrap_or_else(|error| Ended::Dropped(error.to_string())),
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
        ended
    }
}

impl Drop for Pumping {
    fn drop(&mut self) {
        self.inbound.abort();
        self.outbound.abort();
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
        let (mut near_session, mut near_pumping) = pump(near, near_closing);
        let (mut far_session, mut far_pumping) = pump(far, far_closing);

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
        assert!(matches!(far_pumping.ended().await, Ended::Dropped(_)));
    }

    // The race a displacement meets: the displaced end is mid-write when the close arrives, and its writer fails first.
    #[tokio::test]
    async fn a_close_arriving_mid_write_still_names_its_code() {
        for _ in 0..50 {
            let (near, far) = pair().await;
            let (_near_close, near_closing) = watch::channel(None);
            let (far_close, far_closing) = watch::channel(None);
            let (mut near_session, mut near_pumping) = pump(near, near_closing);
            let (_far_session, _far_pumping) = pump(far, far_closing);
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
        let (near_session, mut near_pumping) = pump(near, near_closing);
        let (_far_session, _far_pumping) = pump(far, far_closing);
        drop(near_session);
        assert_eq!(
            near_pumping.ended().await,
            Ended::Dropped("the session ended".into())
        );
    }
}
