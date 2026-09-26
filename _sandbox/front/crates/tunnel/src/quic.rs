//! The tunnel over QUIC, where UDP reaches the edge: one connection the front dials, and a bidirectional stream per
//! request carrying plain HTTP/1.1, so a body or an upgrade needs nothing of its own and a lost packet stalls only its
//! own stream. The front's first stream is the hello: its grant, answered with one byte.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use quinn::congestion::BbrConfig;
use quinn::{Connection, RecvStream, SendStream, TransportConfig, VarInt};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::{DEAD_AFTER, DISPLACED_CODE, MAX_STREAMS, PING_EVERY, STREAM_WINDOW};

pub const ALPN: &[u8] = b"intentic-tunnel/1";

// The tunnel opens none, but HTTP/3 on the same endpoint needs three each way and WebTransport more.
const UNI_STREAMS: u32 = 100;

// A grant is a few hundred bytes; anything past this is not one.
const MAX_GRANT: usize = 4096;

/// What the edge answers a hello with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hello {
    Held = 0,
    /// No valid reachability grant.
    Refused = 1,
    /// The platform says this sandbox is gone.
    Gone = 2,
}

/// The application close codes, as the WebSocket spells them, and one for a hello the edge refused.
pub const DISPLACED: VarInt = VarInt::from_u32(DISPLACED_CODE as u32);
pub const AWAY: VarInt = VarInt::from_u32(1001);
pub const REFUSED: VarInt = VarInt::from_u32(4003);

/// One connection's streams and liveness: streams sized as the WebSocket session's are, QUIC's own keep-alive and idle
/// timeout on the WebSocket ping's cadence and dead window (the connection's only liveness), and BBR, which paces to the path rather than filling a bottleneck's queue ahead of a keystroke.
pub fn transport() -> Arc<TransportConfig> {
    let mut transport = TransportConfig::default();
    transport
        .max_concurrent_bidi_streams(VarInt::from_u32(MAX_STREAMS))
        .max_concurrent_uni_streams(VarInt::from_u32(UNI_STREAMS))
        .stream_receive_window(VarInt::from_u32(STREAM_WINDOW))
        .keep_alive_interval(Some(PING_EVERY))
        .max_idle_timeout(Some(
            DEAD_AFTER
                .try_into()
                .expect("the dead window fits an idle timeout"),
        ))
        .congestion_controller_factory(Arc::new(BbrConfig::default()));
    Arc::new(transport)
}

/// A stream that sends this much without pausing is a transfer, and yields to every stream that is not.
pub const YIELD_AFTER: u64 = 1024 * 1024;

/// A pause this long ends a burst: the stream is back at the ordinary priority for its next one.
pub const PAUSE: Duration = Duration::from_secs(1);

// Below the default 0, where every exchange starts.
const YIELDED: i32 = -1;

/// A request's stream as one byte stream, for HTTP/1.1 on either end. Its sender ranks it by what it is doing, not by
/// what the request was for: a burst past `YIELD_AFTER` yields to every other stream on the connection until it pauses,
/// so a download or an upload never holds a keystroke, a call or an event frame behind it, on either end.
pub struct Stream {
    recv: RecvStream,
    send: SendStream,
    burst: Burst,
}

pub fn stream(send: SendStream, recv: RecvStream) -> Stream {
    Stream {
        recv,
        send,
        burst: Burst::default(),
    }
}

impl Stream {
    /// Whether the stream is ranked below the others right now.
    pub fn yielded(&self) -> bool {
        self.burst.yielded
    }
}

// What a stream has sent since it last paused, and whether that made it yield.
#[derive(Debug, Default)]
struct Burst {
    bytes: u64,
    last_sent: Option<Instant>,
    yielded: bool,
}

impl Burst {
    // Counts `bytes` sent at `now`, answering the priority to take when the burst crossed the mark or ended.
    fn sent(&mut self, bytes: usize, now: Instant) -> Option<i32> {
        let mut rank = None;
        if self
            .last_sent
            .is_some_and(|last| now.duration_since(last) >= PAUSE)
        {
            self.bytes = 0;
            if self.yielded {
                self.yielded = false;
                rank = Some(0);
            }
        }
        self.last_sent = Some(now);
        self.bytes += bytes as u64;
        if !self.yielded && self.bytes > YIELD_AFTER {
            self.yielded = true;
            rank = Some(YIELDED);
        }
        rank
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        AsyncRead::poll_read(Pin::new(&mut self.recv), cx, buf)
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let written = AsyncWrite::poll_write(Pin::new(&mut self.send), cx, buf);
        if let Poll::Ready(Ok(bytes)) = written
            && let Some(rank) = self.burst.sent(bytes, Instant::now())
        {
            let _ = self.send.set_priority(rank);
        }
        written
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        AsyncWrite::poll_flush(Pin::new(&mut self.send), cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        AsyncWrite::poll_shutdown(Pin::new(&mut self.send), cx)
    }
}

/// The front's side of the hello: the grant, then the edge's answer.
pub async fn hello(connection: &Connection, grant: &str) -> anyhow::Result<Hello> {
    let (mut send, mut recv) = connection.open_bi().await?;
    let length = u16::try_from(grant.len())?;
    send.write_all(&length.to_be_bytes()).await?;
    send.write_all(grant.as_bytes()).await?;
    send.finish()?;
    let mut answer = [0_u8; 1];
    recv.read_exact(&mut answer).await?;
    match answer[0] {
        0 => Ok(Hello::Held),
        1 => Ok(Hello::Refused),
        2 => Ok(Hello::Gone),
        other => anyhow::bail!("the edge answered the hello with {other}"),
    }
}

/// The edge's side of the hello: the grant the front presented, and where to answer it.
pub async fn heard(connection: &Connection) -> anyhow::Result<(String, SendStream)> {
    let (send, mut recv) = connection.accept_bi().await?;
    let mut length = [0_u8; 2];
    recv.read_exact(&mut length).await?;
    let length = usize::from(u16::from_be_bytes(length));
    if length > MAX_GRANT {
        anyhow::bail!("a hello of {length} bytes is no grant");
    }
    let mut grant = vec![0_u8; length];
    recv.read_exact(&mut grant).await?;
    Ok((String::from_utf8(grant)?, send))
}

/// Answers the hello; a refusal waits for the front to have it, since closing the connection next would discard it.
pub async fn answer(mut send: SendStream, hello: Hello) -> anyhow::Result<()> {
    send.write_all(&[hello as u8]).await?;
    send.finish()?;
    if hello != Hello::Held {
        send.stopped().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_past_the_mark_yields_until_the_stream_pauses() {
        let start = Instant::now();
        let mut burst = Burst::default();
        let chunk = 64 * 1024;
        let chunks = usize::try_from(YIELD_AFTER).unwrap() / chunk;
        for sent in 0..chunks {
            let at = start + Duration::from_millis(sent as u64);
            assert_eq!(burst.sent(chunk, at), None, "chunk {sent}");
        }
        assert_eq!(
            burst.sent(1, start + Duration::from_millis(100)),
            Some(YIELDED)
        );
        assert_eq!(burst.sent(chunk, start + Duration::from_millis(200)), None);
        let paused = start + Duration::from_millis(200) + PAUSE;
        assert_eq!(burst.sent(1, paused), Some(0));
        assert!(!burst.yielded);
    }

    #[test]
    fn small_exchanges_never_yield_however_many_there_are() {
        let start = Instant::now();
        let mut burst = Burst::default();
        for sent in 0..1000_u64 {
            let at = start + PAUSE * u32::try_from(sent).unwrap();
            assert_eq!(burst.sent(16 * 1024, at), None);
        }
    }
}
