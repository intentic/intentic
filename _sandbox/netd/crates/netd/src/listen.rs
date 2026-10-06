//! netd's ports, bound as Node's config names them and re-bound only when an address changes, so a Node restart
//! that re-sends the same config leaves every listener and every connection on it alone.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto;
use netd_wire::{Endpoint, ListenConfig};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use crate::proxy::Netd;
use crate::route::Listener;
use crate::tls::CertificateSlot;

// TLS record ContentType "handshake": no HTTP method starts with this byte, which is the whole disambiguation.
const TLS_HANDSHAKE_BYTE: u8 = 0x16;

// An unclassified connection (a port scanner, a half-open probe) holds its socket no longer than this, and a TLS
// handshake takes no longer than this once begun.
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(10);

// A request head not whole by now is hung up on, as is a keep-alive connection idle this long: hyper's own default,
// which it applies only given a timer (without one, a head that never ended held its socket for good).
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Port {
    Daemon,
    Preview,
    Loopback,
}

pub struct Listeners {
    netd: Arc<Netd>,
    certificates: Arc<CertificateSlot>,
    acceptor: TlsAcceptor,
    bound: HashMap<Port, (Endpoint, JoinHandle<()>)>,
}

impl Listeners {
    pub fn new(netd: Arc<Netd>, certificates: Arc<CertificateSlot>) -> Self {
        let acceptor = crate::tls::acceptor(certificates.clone());
        Self {
            netd,
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
                // The listener is the task's: until it has ended, the same port on another host is refused as in use.
                let _ = accepting.await;
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
        let netd = self.netd.clone();
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
                let netd = netd.clone();
                let certificates = certificates.clone();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    match port {
                        Port::Daemon => serve(netd, Listener::Daemon, stream).await,
                        Port::Preview => serve(netd, Listener::Preview, stream).await,
                        Port::Loopback => {
                            loopback(netd, certificates, acceptor, stream, peer).await
                        }
                    }
                });
            }
        }
    }
}

// The certified name and the bare `http://127.0.0.1` candidate share the one published port: the first byte picks.
async fn loopback(
    netd: Arc<Netd>,
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
        serve(netd, Listener::Loopback { tls: false }, stream).await;
        return;
    }
    // A hello with no certificate to answer it: closing lets the browser fall to its next candidate.
    if !certificates.present() {
        return;
    }
    match tokio::time::timeout(FIRST_BYTE_TIMEOUT, acceptor.accept(stream)).await {
        Ok(Ok(tls)) => serve(netd, Listener::Loopback { tls: true }, tls).await,
        Ok(Err(error)) => tracing::debug!(%error, %peer, "a loopback TLS handshake failed"),
        Err(_) => tracing::debug!(%peer, "a loopback TLS handshake did not finish in time"),
    }
}

async fn serve<S>(netd: Arc<Netd>, listener: Listener, stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let service = service_fn(move |request| {
        let netd = netd.clone();
        async move { Ok::<_, Infallible>(netd.handle(listener, request).await) }
    });
    let mut builder = auto::Builder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_READ_TIMEOUT);
    let _ = builder
        .serve_connection_with_upgrades(TokioIo::new(stream), service)
        .await;
}
