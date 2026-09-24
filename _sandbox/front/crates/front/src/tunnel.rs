//! Reachability as one outbound dial: present the grant, then serve HTTP/2 straight over the WebSocket, each stream
//! routed like any listener's request. It never gives up: the tunnel is this sandbox's reachability.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use front_wire::{ToNode, TunnelConfig};
use futures_util::{SinkExt, StreamExt};
use http::HeaderValue;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};
use tokio_tungstenite::{Connector, connect_async_tls_with_config};

use crate::link::Link;
use crate::proxy::Front;

// The contract's `ingress-contract.ts` names the header; the edge verifies it before registering anything.
const GRANT_HEADER: &str = "x-intentic-grant";

// The edge's registry closes a tunnel with this when a newer one took its id.
const DISPLACED_CODE: u16 = 4001;

// Redialling at once into a live holder would flap the two tunnels forever.
const DISPLACED_WAIT: Duration = Duration::from_secs(60);

const BACKOFF_FLOOR: Duration = Duration::from_secs(1);
const BACKOFF_CAP: Duration = Duration::from_secs(30);
const STABLE_AFTER: Duration = Duration::from_secs(60);

// Matches the edge's heartbeat (tunnel-heartbeat.ts): a path that died without a FIN reports nothing but silence.
const PING_EVERY: Duration = Duration::from_secs(15);
const DEAD_AFTER: Duration = Duration::from_secs(45);

// Per-stream and session windows as the edge's client sizes them (ingress-protocol.ts).
const STREAM_WINDOW: u32 = 1024 * 1024;
const CONNECTION_WINDOW: u32 = 2 * STREAM_WINDOW;

// Bytes in flight between the WebSocket and the h2 session, each way; past it the reader simply waits.
const PIPE_BYTES: usize = 256 * 1024;

pub struct Tunnel {
    front: Arc<Front>,
    link: &'static Link,
    connected: Arc<AtomicBool>,
    running: Option<(TunnelConfig, JoinHandle<()>, watch::Sender<bool>)>,
}

impl Tunnel {
    pub fn new(front: Arc<Front>, link: &'static Link) -> Self {
        Self {
            front,
            link,
            connected: Arc::new(AtomicBool::new(false)),
            running: None,
        }
    }

    /// Dials the new door, or stops dialling; the same config again changes nothing.
    pub fn configure(&mut self, wanted: Option<TunnelConfig>) {
        if self.running.as_ref().map(|(config, _, _)| config) == wanted.as_ref() {
            return;
        }
        if let Some((_, dialling, closing)) = self.running.take() {
            closing.send_replace(true);
            dialling.abort();
            self.report(false);
        }
        let Some(config) = wanted else {
            return;
        };
        let (closing, closed) = watch::channel(false);
        let dialling = tokio::spawn(run(
            self.front.clone(),
            self.link,
            config.clone(),
            self.connected.clone(),
            closed,
        ));
        self.running = Some((config, dialling, closing));
    }

    /// Tells a Node that just said hello where the tunnel stands.
    pub fn report_again(&self) {
        let _ = self.link.tell(&ToNode::Tunnel {
            connected: self.connected.load(Ordering::Relaxed),
        });
    }

    fn report(&self, connected: bool) {
        self.connected.store(connected, Ordering::Relaxed);
        let _ = self.link.tell(&ToNode::Tunnel { connected });
    }

    /// Closes the tunnel with 1001 so the edge forgets it at once, and waits briefly for the close to leave.
    pub async fn shut(&mut self) {
        if let Some((_, dialling, closing)) = self.running.take() {
            closing.send_replace(true);
            let _ = tokio::time::timeout(Duration::from_secs(2), dialling).await;
        }
    }
}

async fn run(
    front: Arc<Front>,
    link: &'static Link,
    config: TunnelConfig,
    connected: Arc<AtomicBool>,
    closed: watch::Receiver<bool>,
) {
    let mut rung = BACKOFF_FLOOR;
    loop {
        let started = Instant::now();
        let ended = dial_once(&front, link, &config, &connected, closed.clone()).await;
        connected.store(false, Ordering::Relaxed);
        let _ = link.tell(&ToNode::Tunnel { connected: false });
        if *closed.borrow() {
            return;
        }
        let wait = match ended {
            Ended::Displaced => {
                tracing::warn!("another tunnel took this sandbox's address; standing back");
                DISPLACED_WAIT
            }
            Ended::Dropped(why) => {
                tracing::warn!(%why, "the ingress tunnel dropped");
                if started.elapsed() >= STABLE_AFTER {
                    rung = BACKOFF_FLOOR;
                }
                let ceiling = (rung * 2).min(BACKOFF_CAP);
                let wait = BACKOFF_FLOOR + (ceiling - BACKOFF_FLOOR).mul_f64(jitter());
                rung = ceiling;
                wait
            }
        };
        tokio::time::sleep(wait).await;
    }
}

enum Ended {
    Displaced,
    Dropped(String),
}

async fn dial_once(
    front: &Arc<Front>,
    link: &'static Link,
    config: &TunnelConfig,
    connected: &AtomicBool,
    mut closed: watch::Receiver<bool>,
) -> Ended {
    let mut request = match config.url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => return Ended::Dropped(format!("the tunnel URL is unusable: {error}")),
    };
    match HeaderValue::from_str(&config.grant) {
        Ok(grant) => request.headers_mut().insert(GRANT_HEADER, grant),
        Err(error) => return Ended::Dropped(format!("the grant is not a header value: {error}")),
    };
    let (socket, _) = match connect_async_tls_with_config(
        request,
        None,
        true,
        Some(Connector::Rustls(client_tls())),
    )
    .await
    {
        Ok(opened) => opened,
        Err(error) => return Ended::Dropped(format!("could not dial the edge: {error}")),
    };
    let (mut sink, mut frames) = socket.split();
    let (session_side, pump_side) = tokio::io::duplex(PIPE_BYTES);
    let (mut from_session, mut into_session) = tokio::io::split(pump_side);
    let heard = Arc::new(AtomicU64::new(0));
    let epoch = Instant::now();

    let hearing = heard.clone();
    let mut inbound = tokio::spawn(async move {
        while let Some(frame) = frames.next().await {
            hearing.store(epoch.elapsed().as_millis() as u64, Ordering::Relaxed);
            let bytes = match frame {
                Ok(Message::Binary(bytes)) => bytes,
                // A stray text frame is coerced rather than dropped, as the TypeScript duplex did.
                Ok(Message::Text(text)) => Bytes::from(text.as_str().to_owned()),
                Ok(Message::Close(frame)) => {
                    let displaced =
                        frame.is_some_and(|frame| u16::from(frame.code) == DISPLACED_CODE);
                    return if displaced {
                        Ended::Displaced
                    } else {
                        Ended::Dropped("the edge closed the tunnel".into())
                    };
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

    let mut outbound = tokio::spawn(async move {
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            tokio::select! {
                read = from_session.read(&mut buffer) => match read {
                    Ok(0) | Err(_) => return Ended::Dropped("the session ended".into()),
                    Ok(read) => {
                        if sink.send(Message::Binary(Bytes::copy_from_slice(&buffer[..read]))).await.is_err() {
                            return Ended::Dropped("the tunnel socket refused a write".into());
                        }
                    }
                },
                _ = ping.tick() => {
                    let silent = epoch.elapsed().saturating_sub(Duration::from_millis(heard.load(Ordering::Relaxed)));
                    if silent > DEAD_AFTER {
                        return Ended::Dropped(format!("no frame from the edge in {silent:?}"));
                    }
                    if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        return Ended::Dropped("the tunnel socket refused a ping".into());
                    }
                }
                () = raised(&mut closed) => {
                    let close = CloseFrame { code: CloseCode::Away, reason: Utf8Bytes::from_static("sandbox shutting down") };
                    let _ = sink.send(Message::Close(Some(close))).await;
                    return Ended::Dropped("the sandbox is shutting down".into());
                }
            }
        }
    });

    let serving = front.clone();
    let service = service_fn(move |request| {
        let front = serving.clone();
        async move { Ok::<_, Infallible>(front.tunnel(request).await) }
    });
    let mut session = tokio::spawn(
        hyper::server::conn::http2::Builder::new(TokioExecutor::new())
            .initial_stream_window_size(STREAM_WINDOW)
            .initial_connection_window_size(CONNECTION_WINDOW)
            .max_concurrent_streams(1024)
            .serve_connection(TokioIo::new(session_side), service),
    );
    connected.store(true, Ordering::Relaxed);
    let _ = link.tell(&ToNode::Tunnel { connected: true });
    tracing::info!("reachable: the ingress tunnel is registered");

    let ended = tokio::select! {
        ended = &mut inbound => ended.unwrap_or_else(|error| Ended::Dropped(error.to_string())),
        ended = &mut outbound => ended.unwrap_or_else(|error| Ended::Dropped(error.to_string())),
        served = &mut session => Ended::Dropped(match served {
            Ok(Ok(())) => "the h2 session ended".into(),
            Ok(Err(error)) => format!("the h2 session failed: {error}"),
            Err(error) => error.to_string(),
        }),
    };
    inbound.abort();
    outbound.abort();
    session.abort();
    ended
}

// The guard `wait_for` hands back must not live across the await that follows it in a spawned task.
async fn raised(flag: &mut watch::Receiver<bool>) {
    let _ = flag.wait_for(|raised| *raised).await;
}

// Spreads redials so a fleet dropped by one edge deploy does not return in lockstep; unpredictability is not needed.
fn jitter() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.subsec_nanos());
    f64::from(nanos) / 1e9
}

fn client_tls() -> Arc<rustls::ClientConfig> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth(),
    )
}
