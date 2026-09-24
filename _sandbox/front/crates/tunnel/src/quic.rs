//! The tunnel over QUIC, where UDP reaches the edge: one connection the front dials, and a bidirectional stream per
//! request carrying plain HTTP/1.1, so a body or an upgrade needs nothing of its own and a lost packet stalls only its
//! own stream. The front's first stream is the hello: its grant, answered with one byte.

use std::sync::Arc;

use quinn::congestion::BbrConfig;
use quinn::{Connection, RecvStream, SendStream, TransportConfig, VarInt};
use tokio::io::Join;

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

/// The application close codes, as the WebSocket lanes spell them, and one for a hello the edge refused.
pub const DISPLACED: VarInt = VarInt::from_u32(DISPLACED_CODE as u32);
pub const AWAY: VarInt = VarInt::from_u32(1001);
pub const REFUSED: VarInt = VarInt::from_u32(4003);

/// One connection's streams and liveness: streams sized as the TCP lanes' are, the keep-alive and silence the WebSocket
/// ping's, and BBR, which paces to the path rather than filling a bottleneck's queue ahead of a keystroke.
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

/// A request's stream as one byte stream, for HTTP/1.1 on either end.
pub type Stream = Join<RecvStream, SendStream>;

pub fn stream(send: SendStream, recv: RecvStream) -> Stream {
    tokio::io::join(recv, send)
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
