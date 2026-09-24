//! Reachability as outbound dials: present the grant, then serve HTTP/2 straight over each WebSocket, every stream
//! routed like any listener's request. Two lanes, so a transfer never queues a keystroke behind it on one TCP
//! connection; neither ever gives up, since the tunnel is this sandbox's reachability.

use std::convert::Infallible;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use front_wire::{ToNode, TunnelConfig};
use http::HeaderValue;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{Connector, MaybeTlsStream, connect_async_tls_with_config};
use tunnel::{
    CONNECTION_WINDOW, Close, DISPLACED_CODE, Ended, GRANT_HEADER, LANE_HEADER, Lane, MAX_STREAMS,
    STREAM_WINDOW,
};

use crate::link::Link;
use crate::proxy::Front;

// Redialling at once into a live holder would flap the two tunnels forever.
pub const DISPLACED_WAIT: Duration = Duration::from_secs(60);

const TUNNEL_CA_ENV: &str = "INTENTIC_TUNNEL_CA";

pub const BACKOFF_FLOOR: Duration = Duration::from_secs(1);
pub const BACKOFF_CAP: Duration = Duration::from_secs(30);
pub const STABLE_AFTER: Duration = Duration::from_secs(60);

// Unsent bytes the kernel holds for the interactive lane: past this the session stops writing, so a keystroke is never
// queued behind a deep send buffer the way a transfer's bytes may be.
const INTERACTIVE_NOTSENT_LOWAT: libc::c_int = 16 * 1024;

// What both lanes send the edge when the sandbox stops, so it forgets them at once instead of after the dead window.
const SHUTTING_DOWN: Close = Close {
    code: 1001,
    reason: std::borrow::Cow::Borrowed("sandbox shutting down"),
};

// The config both lanes dial, their tasks, and what asks them to close.
type Running = (
    TunnelConfig,
    Vec<JoinHandle<()>>,
    watch::Sender<Option<Close>>,
);

pub struct Tunnel {
    front: Arc<Front>,
    link: &'static Link,
    // The interactive lane's state: the one Node is told about, since every request can ride it.
    connected: Arc<AtomicBool>,
    running: Option<Running>,
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

    /// Dials the new door on both lanes, or stops dialling; the same config again changes nothing.
    pub fn configure(&mut self, wanted: Option<TunnelConfig>) {
        if self.running.as_ref().map(|(config, _, _)| config) == wanted.as_ref() {
            return;
        }
        if let Some((_, dialling, closing)) = self.running.take() {
            closing.send_replace(Some(SHUTTING_DOWN));
            for lane in dialling {
                lane.abort();
            }
            self.connected.store(false, Ordering::Relaxed);
            let _ = self.link.tell(&ToNode::Tunnel { connected: false });
        }
        let Some(config) = wanted else {
            return;
        };
        let (closing, closed) = watch::channel(None);
        let mut dialling: Vec<JoinHandle<()>> = Lane::ALL
            .into_iter()
            .map(|lane| {
                tokio::spawn(run(
                    self.front.clone(),
                    self.link,
                    config.clone(),
                    lane,
                    self.connected.clone(),
                    closed.clone(),
                ))
            })
            .collect();
        // QUIC is TLS or nothing, so a plaintext edge is left to the lanes.
        if config.url.starts_with("wss://") {
            dialling.push(tokio::spawn(crate::quic::run(
                self.front.clone(),
                config.clone(),
                closed.clone(),
            )));
        }
        self.running = Some((config, dialling, closing));
    }

    /// Tells a Node that just said hello where the tunnel stands.
    pub fn report_again(&self) {
        let _ = self.link.tell(&ToNode::Tunnel {
            connected: self.connected.load(Ordering::Relaxed),
        });
    }

    /// Closes both lanes with 1001 so the edge forgets them at once, and waits briefly for the closes to leave.
    pub async fn shut(&mut self) {
        if let Some((_, dialling, closing)) = self.running.take() {
            closing.send_replace(Some(SHUTTING_DOWN));
            for lane in dialling {
                let _ = tokio::time::timeout(Duration::from_secs(2), lane).await;
            }
        }
    }
}

async fn run(
    front: Arc<Front>,
    link: &'static Link,
    config: TunnelConfig,
    lane: Lane,
    connected: Arc<AtomicBool>,
    closed: watch::Receiver<Option<Close>>,
) {
    let reports = lane == Lane::Interactive;
    let mut rung = BACKOFF_FLOOR;
    loop {
        let started = Instant::now();
        let ended = dial_once(&front, link, &config, lane, &connected, closed.clone()).await;
        if reports {
            connected.store(false, Ordering::Relaxed);
            let _ = link.tell(&ToNode::Tunnel { connected: false });
        }
        if closed.borrow().is_some() {
            return;
        }
        let wait = match ended {
            Ended::Closed(Some(DISPLACED_CODE)) => {
                tracing::warn!(
                    lane = lane.name(),
                    "another tunnel took this sandbox's lane; standing back"
                );
                DISPLACED_WAIT
            }
            Ended::Closed(_) | Ended::Dropped(_) => {
                let why = match ended {
                    Ended::Dropped(why) => why,
                    Ended::Closed(_) => "the edge closed the tunnel".into(),
                };
                tracing::warn!(lane = lane.name(), %why, "the ingress tunnel dropped");
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

async fn dial_once(
    front: &Arc<Front>,
    link: &'static Link,
    config: &TunnelConfig,
    lane: Lane,
    connected: &AtomicBool,
    closed: watch::Receiver<Option<Close>>,
) -> Ended {
    let mut request = match config.url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => return Ended::Dropped(format!("the tunnel URL is unusable: {error}")),
    };
    match HeaderValue::from_str(&config.grant) {
        Ok(grant) => request.headers_mut().insert(GRANT_HEADER, grant),
        Err(error) => return Ended::Dropped(format!("the grant is not a header value: {error}")),
    };
    request
        .headers_mut()
        .insert(LANE_HEADER, HeaderValue::from_static(lane.name()));
    let (socket, _) = match connect_async_tls_with_config(
        request,
        Some(tunnel::socket_config()),
        true,
        Some(Connector::Rustls(client_tls())),
    )
    .await
    {
        Ok(opened) => opened,
        Err(error) => return Ended::Dropped(format!("could not dial the edge: {error}")),
    };
    if lane == Lane::Interactive
        && let Some(tcp) = tcp_of(socket.get_ref())
    {
        notsent_lowat(tcp, INTERACTIVE_NOTSENT_LOWAT);
    }
    let (session_side, mut pumping) = tunnel::pump(socket, closed);

    let serving = front.clone();
    let service = service_fn(move |request| {
        let front = serving.clone();
        async move { Ok::<_, Infallible>(front.tunnel(request).await) }
    });
    let mut session = tokio::spawn(
        hyper::server::conn::http2::Builder::new(TokioExecutor::new())
            .initial_stream_window_size(STREAM_WINDOW)
            .initial_connection_window_size(CONNECTION_WINDOW)
            .max_concurrent_streams(MAX_STREAMS)
            .serve_connection(TokioIo::new(session_side), service),
    );
    if lane == Lane::Interactive {
        connected.store(true, Ordering::Relaxed);
        let _ = link.tell(&ToNode::Tunnel { connected: true });
    }
    tracing::info!(
        lane = lane.name(),
        "reachable: the ingress tunnel is registered"
    );

    let ended = tokio::select! {
        ended = pumping.ended() => ended,
        served = &mut session => Ended::Dropped(match served {
            Ok(Ok(())) => "the h2 session ended".into(),
            Ok(Err(error)) => format!("the h2 session failed: {error}"),
            Err(error) => error.to_string(),
        }),
    };
    session.abort();
    ended
}

fn tcp_of(stream: &MaybeTlsStream<TcpStream>) -> Option<&TcpStream> {
    match stream {
        MaybeTlsStream::Plain(tcp) => Some(tcp),
        MaybeTlsStream::Rustls(tls) => Some(tls.get_ref().0),
        _ => None,
    }
}

// Best effort: a kernel without TCP_NOTSENT_LOWAT keeps its default and the lane still works.
fn notsent_lowat(tcp: &TcpStream, bytes: libc::c_int) {
    // SAFETY: setsockopt on a socket this process owns, with a correctly sized int option.
    unsafe {
        libc::setsockopt(
            tcp.as_raw_fd(),
            libc::IPPROTO_TCP,
            libc::TCP_NOTSENT_LOWAT,
            (&raw const bytes).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
}

// Spreads redials so a fleet dropped by one edge deploy does not return in lockstep; unpredictability is not needed.
pub fn jitter() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.subsec_nanos());
    f64::from(nanos) / 1e9
}

fn client_tls() -> Arc<rustls::ClientConfig> {
    Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .with_root_certificates(trusted())
        .with_no_client_auth(),
    )
}

/// The web's roots, and any a PEM file at `INTENTIC_TUNNEL_CA` names: a self-hosted edge on a private CA.
pub fn trusted() -> rustls::RootCertStore {
    let mut roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let Some(path) = std::env::var_os(TUNNEL_CA_ENV) else {
        return roots;
    };
    match std::fs::read(&path) {
        Ok(pem) => {
            for certificate in CertificateDer::pem_slice_iter(&pem).flatten() {
                let _ = roots.add(certificate);
            }
        }
        Err(error) => tracing::warn!(%error, path = ?path, "the tunnel's extra CA did not read"),
    }
    roots
}
