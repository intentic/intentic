//! The tunnel over QUIC, where UDP reaches the edge: one connection the front dials, and a bidirectional stream per
//! request carrying plain HTTP/1.1, so a body or an upgrade needs nothing of its own and a lost packet stalls only its
//! own stream. The front's first stream is the hello: its grant, answered with one byte.
//!
//! Since 2026-10-05 the hello also carries the front's identity after its grant, and the front acknowledges a `Held`
//! answer with a byte before the edge registers the connection, so the edge never holds a connection its front already
//! gave up on. An older front finishes its side right after the grant: the edge reads no identity and expects no
//! acknowledgement. And the edge proves a held connection with a probe stream (`PROBE`), which a front answers before
//! anything reads it as HTTP; an older front answers it with HTTP's own 400, which proves the stream was served just
//! the same.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use quinn::congestion::BbrConfig;
use quinn::{Connection, RecvStream, SendStream, TransportConfig, VarInt};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::{
    DEAD_AFTER, DELETED_CODE, DEMOTED_CODE, DISPLACED_CODE, HELD_ELSEWHERE_CODE, Identity,
    MAX_STREAMS, PING_EVERY, STREAM_WINDOW,
};

pub const ALPN: &[u8] = b"intentic-tunnel/1";

// The tunnel opens none, but HTTP/3 on the same endpoint needs three each way and WebTransport more.
const UNI_STREAMS: u32 = 100;

// A grant is a few hundred bytes; anything past this is not one.
const MAX_GRANT: usize = 4096;

// An identity is an instance id and a line naming a machine.
const MAX_IDENTITY: usize = 1024;

/// What the edge answers a hello with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hello {
    Held = 0,
    /// No valid reachability grant.
    Refused = 1,
    /// The platform says this sandbox is gone.
    Gone = 2,
    /// Another copy of this sandbox holds it, alive; where it runs follows, length-prefixed. Only a front that named its
    /// instance is ever answered this.
    HeldElsewhere = 3,
}

/// What a front writes on the hello stream once it read `Held`, telling the edge it is still there to be registered.
pub const ACKNOWLEDGED: u8 = 1;

/// The application close codes, as the WebSocket spells them, and one for a hello the edge refused.
pub const DISPLACED: VarInt = VarInt::from_u32(DISPLACED_CODE as u32);
pub const AWAY: VarInt = VarInt::from_u32(1001);
pub const REFUSED: VarInt = VarInt::from_u32(4003);
pub const HELD_ELSEWHERE: VarInt = VarInt::from_u32(HELD_ELSEWHERE_CODE as u32);
pub const DELETED: VarInt = VarInt::from_u32(DELETED_CODE as u32);
pub const DEMOTED: VarInt = VarInt::from_u32(DEMOTED_CODE as u32);

/// What a probe stream opens with. No HTTP request starts with a NUL, so a front tells a probe from an exchange by its
/// first byte, and an older front that reads it as HTTP answers 400, which proves the stream was served all the same.
pub const PROBE: &[u8] = b"\0intentic-probe\n";

/// A front's answer to a probe.
pub const PROBE_ANSWER: &[u8] = b"ok\n";

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
    // The byte `accepted` read to tell an exchange from a probe, handed back first.
    first: Option<u8>,
}

pub fn stream(send: SendStream, recv: RecvStream) -> Stream {
    Stream {
        recv,
        send,
        burst: Burst::default(),
        first: None,
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
        if buf.remaining() > 0
            && let Some(first) = self.first.take()
        {
            buf.put_slice(&[first]);
            return Poll::Ready(Ok(()));
        }
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
    Ok((read_grant(&mut recv).await?, send))
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

/// What the edge answered a front's hello with, and for `HeldElsewhere` where the holding copy runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Greeting {
    pub hello: Hello,
    pub holder: String,
}

/// The front's side of today's hello: the grant, then its identity, then the edge's answer, acknowledged when it is
/// `Held` so the edge registers the connection only once this front is known to be waiting for it.
pub async fn introduce(
    connection: &Connection,
    grant: &str,
    identity: &Identity,
) -> anyhow::Result<Greeting> {
    let (mut send, mut recv) = connection.open_bi().await?;
    let grant_length = u16::try_from(grant.len())?;
    send.write_all(&grant_length.to_be_bytes()).await?;
    send.write_all(grant.as_bytes()).await?;
    let identity = serde_json::to_vec(identity)?;
    let identity_length = u16::try_from(identity.len())?;
    send.write_all(&identity_length.to_be_bytes()).await?;
    send.write_all(&identity).await?;
    let mut answer = [0_u8; 1];
    recv.read_exact(&mut answer).await?;
    let hello = match answer[0] {
        0 => Hello::Held,
        1 => Hello::Refused,
        2 => Hello::Gone,
        3 => Hello::HeldElsewhere,
        other => anyhow::bail!("the edge answered the hello with {other}"),
    };
    let mut holder = String::new();
    match hello {
        Hello::Held => {
            // An older edge never reads this; it has registered already, and a refused write changes nothing.
            if send.write_all(&[ACKNOWLEDGED]).await.is_ok() {
                let _ = send.finish();
            }
        }
        Hello::HeldElsewhere => {
            let mut length = [0_u8; 2];
            recv.read_exact(&mut length).await?;
            let mut named = vec![0_u8; usize::from(u16::from_be_bytes(length)).min(MAX_IDENTITY)];
            recv.read_exact(&mut named).await?;
            holder = String::from_utf8_lossy(&named).into_owned();
        }
        Hello::Refused | Hello::Gone => {}
    }
    Ok(Greeting { hello, holder })
}

/// A hello as the edge heard it: the grant, the front's identity when it named one (none from a front older than
/// instances), and the stream both answer and acknowledgement ride.
pub struct Introduction {
    pub grant: String,
    pub identity: Option<Identity>,
    send: SendStream,
    recv: RecvStream,
}

/// The edge's side of today's hello, which an older front's hello also reads as: its grant, and no identity.
pub async fn introduced(connection: &Connection) -> anyhow::Result<Introduction> {
    let (send, mut recv) = connection.accept_bi().await?;
    let grant = read_grant(&mut recv).await?;
    let mut length = [0_u8; 2];
    let identity = match recv.read_exact(&mut length).await {
        Ok(()) => {
            let length = usize::from(u16::from_be_bytes(length));
            if length > MAX_IDENTITY {
                anyhow::bail!("an identity of {length} bytes is no identity");
            }
            let mut identity = vec![0_u8; length];
            recv.read_exact(&mut identity).await?;
            let identity: Identity = serde_json::from_slice(&identity)?;
            Identity::of_headers(Some(&identity.instance), Some(&identity.host))
        }
        // The front finished its side after the grant: one from before instances.
        Err(quinn::ReadExactError::FinishedEarly(0)) => None,
        Err(error) => return Err(error.into()),
    };
    Ok(Introduction {
        grant,
        identity,
        send,
        recv,
    })
}

impl Introduction {
    /// Answers the hello, refusals as `answer` does. `Held` to a front that named itself is then waited on for its
    /// acknowledgement: true once it came, or at once for an older front, which sends none; false when the front gave
    /// up first, and the connection is not to be registered.
    pub async fn answer(mut self, hello: Hello, patience: Duration) -> anyhow::Result<bool> {
        let named = self.identity.is_some();
        answer(self.send, hello).await?;
        if hello != Hello::Held || !named {
            return Ok(hello == Hello::Held);
        }
        let mut acknowledged = [0_u8; 1];
        Ok(matches!(
            tokio::time::timeout(patience, self.recv.read_exact(&mut acknowledged)).await,
            Ok(Ok(())) if acknowledged[0] == ACKNOWLEDGED
        ))
    }

    /// Refuses a front that named itself because another copy holds its sandbox, naming where that copy runs.
    pub async fn held_elsewhere(mut self, holder: &str) -> anyhow::Result<()> {
        let holder = crate::identity::header_safe(holder);
        let length = u16::try_from(holder.len())?;
        self.send.write_all(&[Hello::HeldElsewhere as u8]).await?;
        self.send.write_all(&length.to_be_bytes()).await?;
        self.send.write_all(holder.as_bytes()).await?;
        self.send.finish()?;
        self.send.stopped().await?;
        Ok(())
    }
}

async fn read_grant(recv: &mut RecvStream) -> anyhow::Result<String> {
    let mut length = [0_u8; 2];
    recv.read_exact(&mut length).await?;
    let length = usize::from(u16::from_be_bytes(length));
    if length > MAX_GRANT {
        anyhow::bail!("a hello of {length} bytes is no grant");
    }
    let mut grant = vec![0_u8; length];
    recv.read_exact(&mut grant).await?;
    Ok(String::from_utf8(grant)?)
}

/// The edge's probe of a held connection: a stream opened, `PROBE` written, and any answer at all read back. Proves the
/// front serves streams, which QUIC's own keep-alive does not: that one crosses a path that carries nothing else.
pub async fn probe(connection: &Connection) -> anyhow::Result<()> {
    let (mut send, mut recv) = connection.open_bi().await?;
    send.write_all(PROBE).await?;
    send.finish()?;
    let mut answered = [0_u8; 1];
    recv.read_exact(&mut answered).await?;
    Ok(())
}

/// A stream the edge opened, as the front serves it: a probe is answered here and is `None`, anything else is an
/// exchange, handed back whole.
pub async fn accepted(mut send: SendStream, mut recv: RecvStream) -> Option<Stream> {
    let mut first = [0_u8; 1];
    recv.read_exact(&mut first).await.ok()?;
    if first[0] != PROBE[0] {
        let mut stream = stream(send, recv);
        stream.first = Some(first[0]);
        return Some(stream);
    }
    let mut rest = [0_u8; 64];
    let _ = tokio::time::timeout(Duration::from_secs(1), recv.read(&mut rest)).await;
    if send.write_all(PROBE_ANSWER).await.is_ok() {
        let _ = send.finish();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
    use quinn::{Endpoint, ServerConfig};

    // A front's connection to an edge, both on loopback: the edge's end first.
    async fn connected() -> (Connection, Connection, Endpoint, Endpoint) {
        let issued = rcgen::generate_simple_self_signed(vec!["edge.test".to_owned()]).unwrap();
        let provider = || std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let mut server_tls = rustls::ServerConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![issued.cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(issued.signing_key.serialize_der().into()),
            )
            .unwrap();
        server_tls.alpn_protocols = vec![ALPN.to_vec()];
        let mut server =
            ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(server_tls).unwrap()));
        server.transport_config(transport());
        let edge = Endpoint::server(server, "127.0.0.1:0".parse().unwrap()).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(issued.cert.der().clone()).unwrap();
        let mut client_tls = rustls::ClientConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        client_tls.alpn_protocols = vec![ALPN.to_vec()];
        let mut client =
            quinn::ClientConfig::new(Arc::new(QuicClientConfig::try_from(client_tls).unwrap()));
        client.transport_config(transport());
        let mut front = Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        front.set_default_client_config(client);
        let dialled = front
            .connect(edge.local_addr().unwrap(), "edge.test")
            .unwrap();
        let (edge_side, front_side) = tokio::join!(
            async { edge.accept().await.unwrap().await.unwrap() },
            async { dialled.await.unwrap() }
        );
        (edge_side, front_side, edge, front)
    }

    fn rog() -> Identity {
        Identity::new("c0ffee".into(), "rog", "linux", "Ubuntu")
    }

    #[tokio::test]
    async fn a_named_front_is_registered_only_once_it_acknowledged_the_answer() {
        let (edge, front, _e, _f) = connected().await;
        let introducing = tokio::spawn(async move {
            let greeting = introduce(&front, "ig1.grant", &rog()).await.unwrap();
            (greeting, front)
        });
        let heard = introduced(&edge).await.unwrap();
        assert_eq!(heard.grant, "ig1.grant");
        assert_eq!(heard.identity, Some(rog()));
        assert!(
            heard
                .answer(Hello::Held, Duration::from_secs(5))
                .await
                .unwrap()
        );
        let (greeting, _front) = introducing.await.unwrap();
        assert_eq!(greeting.hello, Hello::Held);
    }

    #[tokio::test]
    async fn an_older_fronts_hello_names_no_one_and_is_registered_without_waiting() {
        let (edge, front, _e, _f) = connected().await;
        let hello = tokio::spawn(async move { (hello(&front, "ig1.older").await.unwrap(), front) });
        let heard = introduced(&edge).await.unwrap();
        assert_eq!(
            (heard.grant.as_str(), heard.identity.is_none()),
            ("ig1.older", true)
        );
        assert!(
            heard
                .answer(Hello::Held, Duration::from_secs(60))
                .await
                .unwrap()
        );
        assert_eq!(hello.await.unwrap().0, Hello::Held);
    }

    // The 2026-10-05 race: the front stopped waiting for its answer, and the edge registered a connection nobody served.
    #[tokio::test]
    async fn a_front_that_gave_up_before_acknowledging_is_not_registered() {
        let (edge, front, _e, _f) = connected().await;
        let (mut send, mut recv) = front.open_bi().await.unwrap();
        let identity = serde_json::to_vec(&rog()).unwrap();
        for chunk in [
            &u16::try_from(9).unwrap().to_be_bytes()[..],
            b"ig1.grant",
            &u16::try_from(identity.len()).unwrap().to_be_bytes(),
            &identity,
        ] {
            send.write_all(chunk).await.unwrap();
        }
        let heard = introduced(&edge).await.unwrap();
        let answered = tokio::spawn(heard.answer(Hello::Held, Duration::from_millis(300)));
        let mut answer = [0_u8; 1];
        recv.read_exact(&mut answer).await.unwrap();
        assert_eq!(answer[0], Hello::Held as u8);
        assert!(!answered.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn a_refusal_for_another_copy_names_where_it_runs() {
        let (edge, front, _e, _f) = connected().await;
        let introducing =
            tokio::spawn(async move { introduce(&front, "ig1.grant", &rog()).await.unwrap() });
        let heard = introduced(&edge).await.unwrap();
        heard.held_elsewhere("omen (windows)").await.unwrap();
        assert_eq!(
            introducing.await.unwrap(),
            Greeting {
                hello: Hello::HeldElsewhere,
                holder: "omen (windows)".into()
            }
        );
    }

    #[tokio::test]
    async fn a_probe_is_answered_before_http_and_an_exchange_keeps_its_first_byte() {
        let (edge, front, _e, _f) = connected().await;
        let serving = tokio::spawn(async move {
            let mut exchanges = Vec::new();
            while let Ok((send, recv)) = front.accept_bi().await {
                if let Some(mut stream) = accepted(send, recv).await {
                    let mut head = Vec::new();
                    tokio::io::AsyncReadExt::read_to_end(&mut stream, &mut head)
                        .await
                        .unwrap();
                    exchanges.push(String::from_utf8(head).unwrap());
                    if exchanges.len() == 1 {
                        return exchanges;
                    }
                }
            }
            exchanges
        });
        tokio::time::timeout(crate::PROBE_PATIENCE, probe(&edge))
            .await
            .unwrap()
            .unwrap();
        let (mut send, _recv) = edge.open_bi().await.unwrap();
        send.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
        send.finish().unwrap();
        assert_eq!(serving.await.unwrap(), ["GET / HTTP/1.1\r\n\r\n"]);
    }

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
