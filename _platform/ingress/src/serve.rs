//! Accepting connections for a handler: each served as HTTP/1.1 or h2, upgrades allowed, and every one of them cut when
//! the listener stops, since the streams an edge carries are long-lived by design and a restart cannot wait on them.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use http::{Request, Response};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream, ToSocketAddrs};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};
use tokio_rustls::TlsAcceptor;

use crate::body::Body;
use crate::proxy_protocol;

// A connection that has not finished its request head by now is a slow client or a probe, never a browser.
pub(crate) const HEAD_PATIENCE: Duration = Duration::from_secs(30);

// The same for a PROXY header or a TLS handshake.
const HANDSHAKE_PATIENCE: Duration = Duration::from_secs(10);

// A browser's uploads cross the internet too: h2's 64 KiB default would hold one to a trickle.
const BROWSER_STREAM_WINDOW: u32 = 1024 * 1024;
const BROWSER_CONNECTION_WINDOW: u32 = 2 * BROWSER_STREAM_WINDOW;

// Streams a browser holds at once: event streams and attaches stay open for a page's whole life.
const BROWSER_MAX_STREAMS: u32 = 1024;

pub struct Listening {
    pub address: SocketAddr,
    stop: watch::Sender<bool>,
    accepting: JoinHandle<()>,
}

impl Listening {
    /// Stops accepting and cuts every connection still open.
    pub async fn stop(self) {
        self.stop.send_replace(true);
        let _ = self.accepting.await;
    }
}

pub async fn listen<H, F>(address: impl ToSocketAddrs, handler: H) -> std::io::Result<Listening>
where
    H: Fn(Request<Incoming>, SocketAddr) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response<Body>> + Send + 'static,
{
    serve_on(TcpListener::bind(address).await?, handler)
}

/// Serves a listener already bound, for a caller that must know its port before it can build the handler.
pub fn serve_on<H, F>(listener: TcpListener, handler: H) -> std::io::Result<Listening>
where
    H: Fn(Request<Incoming>, SocketAddr) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response<Body>> + Send + 'static,
{
    started(listener, move |stream, remote| {
        serve(stream, remote, handler.clone())
    })
}

/// Serves TLS the edge terminates itself, behind a PROXY header when `proxied`: the passthrough in front of it names the
/// browser there, since the socket's peer is the passthrough.
pub fn serve_tls_on<H, F>(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    proxied: bool,
    handler: H,
) -> std::io::Result<Listening>
where
    H: Fn(Request<Incoming>, SocketAddr) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response<Body>> + Send + 'static,
{
    started(listener, move |mut stream: TcpStream, remote| {
        let acceptor = acceptor.clone();
        let handler = handler.clone();
        async move {
            let remote = if proxied {
                match tokio::time::timeout(HANDSHAKE_PATIENCE, proxy_protocol::read(&mut stream))
                    .await
                {
                    Ok(Ok(named)) => named.unwrap_or(remote),
                    Ok(Err(error)) => {
                        tracing::debug!(%error, %remote, "a connection's PROXY header did not read");
                        return;
                    }
                    Err(_) => return,
                }
            } else {
                remote
            };
            match tokio::time::timeout(HANDSHAKE_PATIENCE, acceptor.accept(stream)).await {
                Ok(Ok(tls)) => serve(tls, remote, handler).await,
                Ok(Err(error)) => tracing::debug!(%error, %remote, "a TLS handshake failed"),
                Err(_) => {}
            }
        }
    })
}

fn started<C, S>(listener: TcpListener, connect: C) -> std::io::Result<Listening>
where
    C: Fn(TcpStream, SocketAddr) -> S + Send + Sync + 'static,
    S: Future<Output = ()> + Send + 'static,
{
    let address = listener.local_addr()?;
    let (stop, stopped) = watch::channel(false);
    let accepting = tokio::spawn(accept(listener, connect, stopped));
    Ok(Listening {
        address,
        stop,
        accepting,
    })
}

async fn accept<C, S>(listener: TcpListener, connect: C, mut stopped: watch::Receiver<bool>)
where
    C: Fn(TcpStream, SocketAddr) -> S + Send + Sync + 'static,
    S: Future<Output = ()> + Send + 'static,
{
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, remote)) => {
                    // Nagle would hold a small answer for a delayed ACK.
                    let _ = stream.set_nodelay(true);
                    connections.spawn(connect(stream, remote));
                }
                Err(error) => {
                    tracing::warn!(%error, "accept failed");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            _ = stopped.changed() => break,
        }
    }
    connections.shutdown().await;
}

pub async fn serve<S, H, F>(stream: S, remote: SocketAddr, handler: H)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    H: Fn(Request<Incoming>, SocketAddr) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response<Body>> + Send + 'static,
{
    let service = service_fn(move |request| {
        let answering = handler(request, remote);
        async move { Ok::<_, Infallible>(answering.await) }
    });
    let mut builder = auto::Builder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(HEAD_PATIENCE);
    builder
        .http2()
        .initial_stream_window_size(BROWSER_STREAM_WINDOW)
        .initial_connection_window_size(BROWSER_CONNECTION_WINDOW)
        .max_concurrent_streams(BROWSER_MAX_STREAMS);
    let _ = builder
        .serve_connection_with_upgrades(TokioIo::new(stream), service)
        .await;
}
