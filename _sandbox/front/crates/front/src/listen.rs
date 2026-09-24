//! The front's ports, bound as Node's config names them and re-bound only when an address changes, so a Node restart
//! that re-sends the same config leaves every listener and every connection on it alone.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use front_wire::{Endpoint, ListenConfig};
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use crate::proxy::Front;
use crate::route::Lane;
use crate::tls::CertificateSlot;

// TLS record ContentType "handshake": no HTTP method starts with this byte, which is the whole disambiguation.
const TLS_HANDSHAKE_BYTE: u8 = 0x16;

// An unclassified connection (a port scanner, a half-open probe) holds its socket no longer than this.
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Port {
    Daemon,
    Preview,
    Loopback,
}

pub struct Listeners {
    front: Arc<Front>,
    certificates: Arc<CertificateSlot>,
    acceptor: TlsAcceptor,
    bound: HashMap<Port, (Endpoint, JoinHandle<()>)>,
}

impl Listeners {
    pub fn new(front: Arc<Front>, certificates: Arc<CertificateSlot>) -> Self {
        let acceptor = crate::tls::acceptor(certificates.clone());
        Self {
            front,
            certificates,
            acceptor,
            bound: HashMap::new(),
        }
    }

    pub async fn apply(&mut self, config: &ListenConfig) {
        for (port, wanted) in [
            (Port::Daemon, Some(&config.daemon)),
            (Port::Preview, config.preview.as_ref()),
            (Port::Loopback, config.loopback.as_ref()),
        ] {
            if self.bound.get(&port).map(|(endpoint, _)| endpoint) == wanted {
                continue;
            }
            if let Some((endpoint, accepting)) = self.bound.remove(&port) {
                tracing::info!(listener = ?port, host = %endpoint.host, port = endpoint.port, "unbinding");
                accepting.abort();
            }
            let Some(endpoint) = wanted else {
                continue;
            };
            match TcpListener::bind((endpoint.host.as_str(), endpoint.port)).await {
                Ok(listener) => {
                    tracing::info!(listener = ?port, host = %endpoint.host, port = endpoint.port, "listening");
                    let accepting = tokio::spawn(self.accept(port, listener));
                    self.bound.insert(port, (endpoint.clone(), accepting));
                }
                Err(error) => {
                    tracing::error!(%error, listener = ?port, host = %endpoint.host, port = endpoint.port, "could not bind")
                }
            }
        }
    }

    fn accept(
        &self,
        port: Port,
        listener: TcpListener,
    ) -> impl Future<Output = ()> + Send + 'static {
        let front = self.front.clone();
        let certificates = self.certificates.clone();
        let acceptor = self.acceptor.clone();
        async move {
            loop {
                let (stream, peer) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        tracing::warn!(%error, listener = ?port, "accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                // Set here or nowhere: Nagle holds a new connection's first answer for a delayed ACK (~45 ms measured).
                let _ = stream.set_nodelay(true);
                let front = front.clone();
                let certificates = certificates.clone();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    match port {
                        Port::Daemon => serve(front, Lane::Daemon, stream).await,
                        Port::Preview => serve(front, Lane::Preview, stream).await,
                        Port::Loopback => {
                            loopback(front, certificates, acceptor, stream, peer).await
                        }
                    }
                });
            }
        }
    }
}

// The certified name and the bare `http://127.0.0.1` candidate share the one published port: the first byte picks.
async fn loopback(
    front: Arc<Front>,
    certificates: Arc<CertificateSlot>,
    acceptor: TlsAcceptor,
    stream: TcpStream,
    peer: SocketAddr,
) {
    let mut first = [0_u8; 1];
    let Ok(Ok(read)) = tokio::time::timeout(FIRST_BYTE_TIMEOUT, stream.peek(&mut first)).await
    else {
        return;
    };
    if read == 0 {
        return;
    }
    if first[0] != TLS_HANDSHAKE_BYTE {
        serve(front, Lane::Loopback { tls: false }, stream).await;
        return;
    }
    // A hello with no certificate to answer it: closing lets the browser fall to its next candidate.
    if !certificates.present() {
        return;
    }
    match acceptor.accept(stream).await {
        Ok(tls) => serve(front, Lane::Loopback { tls: true }, tls).await,
        Err(error) => tracing::debug!(%error, %peer, "a loopback TLS handshake failed"),
    }
}

async fn serve<S>(front: Arc<Front>, lane: Lane, stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let service = service_fn(move |request| {
        let front = front.clone();
        async move { Ok::<_, Infallible>(front.handle(lane, request).await) }
    });
    let _ = auto::Builder::new(TokioExecutor::new())
        .serve_connection_with_upgrades(TokioIo::new(stream), service)
        .await;
}
