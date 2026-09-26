//! Reachability as outbound dials: two WebSockets at `/tunnel/v2`, `interactive` and `bulk`, each presenting the grant
//! and the daemon's transfer routes, then serving every stream the edge opens on its yamux session as one HTTP/1.1
//! connection (`Front::serve_stream`), routed like any listener's request. Two, since streams on one TCP connection
//! still share its congestion window and its losses: the edge sends an announced transfer down the bulk socket, and a
//! keystroke never queues behind it. Neither ever gives up, since the tunnel is this sandbox's reachability. The edge's
//! answer declares what else it serves, and only a declared QUIC door is dialled (`quic.rs`), beside the sockets.

use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use front_wire::{ToNode, TunnelConfig};
use http::{HeaderValue, StatusCode};
use relay::Backoff;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Error as SocketError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{Connector, MaybeTlsStream, connect_async_tls_with_config};
use tunnel::{
    BULK_HEADER, BulkRoutes, Close, DISPLACED_CODE, Ended, GRANT_HEADER, LANE_HEADER, Lane,
    Liveness, TRANSPORTS_HEADER, TUNNEL_PATH, Transport, mux,
};

use crate::link::Link;
use crate::proxy::Front;

// Redialling at once into a live holder would flap the two tunnels forever.
pub const DISPLACED_WAIT: Duration = Duration::from_secs(60);

const TUNNEL_CA_ENV: &str = "INTENTIC_TUNNEL_CA";

/// Every carrier redials on this ladder: from a second to thirty, a minute held counting as working.
pub const REDIAL: Backoff = Backoff::new(
    Duration::from_secs(1),
    Duration::from_secs(30),
    Duration::from_secs(60),
);

// Unsent bytes the kernel holds for the interactive socket: past this its session stops writing, so a keystroke is never
// queued behind a deep send buffer the way a transfer's bytes may be.
const INTERACTIVE_NOTSENT_LOWAT: libc::c_int = 16 * 1024;

// What both sockets send the edge when the sandbox stops, so it forgets them at once instead of after the dead window.
const SHUTTING_DOWN: Close = Close {
    code: 1001,
    reason: std::borrow::Cow::Borrowed("sandbox shutting down"),
};

// The config the carriers dial, their tasks, and what asks them to close.
type Running = (
    TunnelConfig,
    Vec<JoinHandle<()>>,
    watch::Sender<Option<Close>>,
);

pub struct Tunnel {
    front: Arc<Front>,
    link: &'static Link,
    // The interactive socket's state: the one Node is told about, since every request can ride it.
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

    /// Dials the new door on both sockets, or stops dialling; the same config again changes nothing.
    pub fn configure(&mut self, wanted: Option<TunnelConfig>) {
        if self.running.as_ref().map(|(config, _, _)| config) == wanted.as_ref() {
            return;
        }
        if let Some((_, dialling, closing)) = self.running.take() {
            closing.send_replace(Some(SHUTTING_DOWN));
            for carrier in dialling {
                carrier.abort();
            }
            self.connected.store(false, Ordering::Relaxed);
            let _ = self.link.tell(&ToNode::Tunnel { connected: false });
        }
        let Some(config) = wanted else {
            return;
        };
        let (closing, closed) = watch::channel(None);
        // Whether the edge's last answer declared its QUIC door; nothing does until a socket has been answered.
        let (declaring, declared) = watch::channel(false);
        let declaring = Arc::new(declaring);
        let mut dialling: Vec<JoinHandle<()>> = Lane::ALL
            .into_iter()
            .map(|lane| {
                tokio::spawn(run(
                    self.front.clone(),
                    self.link,
                    config.clone(),
                    lane,
                    Shared {
                        connected: self.connected.clone(),
                        declaring: declaring.clone(),
                    },
                    closed.clone(),
                ))
            })
            .collect();
        // QUIC is TLS or nothing, and shares the TLS door's host and port, so a plaintext edge is left to the sockets.
        if config.url.starts_with("wss://") {
            dialling.push(tokio::spawn(crate::quic::run(
                self.front.clone(),
                config.clone(),
                declared,
                closed,
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

    /// Closes both sockets and the QUIC connection with 1001 so the edge forgets them at once, and waits briefly for
    /// the closes to leave.
    pub async fn shut(&mut self) {
        if let Some((_, dialling, closing)) = self.running.take() {
            closing.send_replace(Some(SHUTTING_DOWN));
            for carrier in dialling {
                let _ = tokio::time::timeout(Duration::from_secs(2), carrier).await;
            }
        }
    }
}

// What both sockets share: the state Node is told about, and where the edge's declaration goes.
struct Shared {
    connected: Arc<AtomicBool>,
    declaring: Arc<watch::Sender<bool>>,
}

async fn run(
    front: Arc<Front>,
    link: &'static Link,
    config: TunnelConfig,
    lane: Lane,
    shared: Shared,
    closed: watch::Receiver<Option<Close>>,
) {
    let reports = lane == Lane::Interactive;
    let mut backoff = REDIAL;
    loop {
        let started = Instant::now();
        let ended = dial_once(&front, link, &config, lane, &shared, closed.clone()).await;
        if reports {
            shared.connected.store(false, Ordering::Relaxed);
            let _ = link.tell(&ToNode::Tunnel { connected: false });
        }
        if closed.borrow().is_some() {
            return;
        }
        let wait = match ended {
            Ended::Closed(Some(DISPLACED_CODE)) => {
                tracing::warn!(
                    lane = lane.name(),
                    "another tunnel took this sandbox's socket; standing back"
                );
                DISPLACED_WAIT
            }
            Ended::Closed(_) | Ended::Dropped(_) => {
                let why = match ended {
                    Ended::Dropped(why) => why,
                    Ended::Closed(_) => "the edge closed the tunnel".into(),
                };
                tracing::warn!(lane = lane.name(), %why, "the ingress tunnel dropped");
                backoff.after(started.elapsed())
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
    shared: &Shared,
    closed: watch::Receiver<Option<Close>>,
) -> Ended {
    let url = door(&config.url);
    let mut request = match url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => return Ended::Dropped(format!("the tunnel URL is unusable: {error}")),
    };
    let announced = BulkRoutes::announce(&config.bulk);
    let headers = [
        (GRANT_HEADER, config.grant.as_str()),
        (LANE_HEADER, lane.name()),
        (BULK_HEADER, announced.as_str()),
    ];
    for (name, value) in headers {
        match HeaderValue::from_str(value) {
            Ok(value) => request.headers_mut().insert(name, value),
            Err(error) => return Ended::Dropped(format!("{name} is not a header value: {error}")),
        };
    }
    let (socket, answer) = match connect_async_tls_with_config(
        request,
        Some(tunnel::socket_config()),
        true,
        Some(Connector::Rustls(client_tls())),
    )
    .await
    {
        Ok(opened) => opened,
        Err(SocketError::Http(refused)) if refused.status() == StatusCode::NOT_FOUND => {
            return Ended::Dropped(format!(
                "the edge does not serve {TUNNEL_PATH}: it predates this front, and serves it once redeployed"
            ));
        }
        Err(error) => return Ended::Dropped(format!("could not dial the edge: {error}")),
    };
    let declared = Transport::declared(
        answer
            .headers()
            .get(TRANSPORTS_HEADER)
            .and_then(|value| value.to_str().ok()),
    );
    shared
        .declaring
        .send_replace(declared.contains(&Transport::Quic));
    if lane == Lane::Interactive
        && let Some(tcp) = tcp_of(socket.get_ref())
    {
        notsent_lowat(tcp, INTERACTIVE_NOTSENT_LOWAT);
    }
    let (session_side, mut pumping) = tunnel::pump(socket, Liveness::Pings, closed);
    let (mut streams, mut driving) = mux::server(session_side);
    let serving = front.clone();
    let accepting = tokio::spawn(async move {
        while let Some(stream) = streams.recv().await {
            let front = serving.clone();
            tokio::spawn(async move { front.serve_stream(stream).await });
        }
    });
    if lane == Lane::Interactive {
        shared.connected.store(true, Ordering::Relaxed);
        let _ = link.tell(&ToNode::Tunnel { connected: true });
    }
    tracing::info!(
        lane = lane.name(),
        "reachable: the ingress tunnel is registered"
    );

    let ended = tokio::select! {
        ended = pumping.ended() => ended,
        driven = &mut driving => Ended::Dropped(match driven {
            Ok(Ok(())) => "the session ended".into(),
            Ok(Err(error)) => format!("the session failed: {error}"),
            Err(error) => error.to_string(),
        }),
    };
    driving.abort();
    accepting.abort();
    ended
}

// Node names the edge's door; whatever path it names, this front dials the one it speaks.
fn door(url: &str) -> String {
    let origin = url
        .find("://")
        .and_then(|scheme| url[scheme + 3..].find('/').map(|path| scheme + 3 + path))
        .map_or(url, |path| &url[..path]);
    format!("{origin}{TUNNEL_PATH}")
}

fn tcp_of(stream: &MaybeTlsStream<TcpStream>) -> Option<&TcpStream> {
    match stream {
        MaybeTlsStream::Plain(tcp) => Some(tcp),
        MaybeTlsStream::Rustls(tls) => Some(tls.get_ref().0),
        _ => None,
    }
}

// Best effort: a kernel without TCP_NOTSENT_LOWAT keeps its default and the socket still works.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_door_dialled_is_this_fronts_whatever_path_node_named() {
        assert_eq!(
            door("wss://ingress.sbx.example.test/tunnel/v1"),
            "wss://ingress.sbx.example.test/tunnel/v2"
        );
        assert_eq!(
            door("ws://127.0.0.1:8080/tunnel/v2"),
            "ws://127.0.0.1:8080/tunnel/v2"
        );
        assert_eq!(
            door("wss://ingress.sbx.example.test"),
            "wss://ingress.sbx.example.test/tunnel/v2"
        );
    }
}
