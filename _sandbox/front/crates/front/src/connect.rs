//! Where forwarded requests go: Node's Unix socket, or a preview's local upstream over TCP or TLS. Ordinary requests
//! ride pooled connections; an upgrade dials one of its own, since an upgraded connection never returns to a pool.

use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use hyper::body::Incoming;
use hyper::rt::{Read, ReadBufCursor, Write};
use hyper::{Request, Response, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::rt::{TokioExecutor, TokioIo};
use pin_project_lite::pin_project;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, ring, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio::net::{TcpStream, UnixStream};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tower_service::Service;

use crate::body::Body;

pin_project! {
    #[project = IoProjection]
    pub enum Io {
        Unix { #[pin] inner: TokioIo<UnixStream> },
        Tcp { #[pin] inner: TokioIo<TcpStream> },
        Tls { #[pin] inner: TokioIo<TlsStream<TcpStream>> },
    }
}

impl Read for Io {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        match self.project() {
            IoProjection::Unix { inner } => inner.poll_read(cx, buf),
            IoProjection::Tcp { inner } => inner.poll_read(cx, buf),
            IoProjection::Tls { inner } => inner.poll_read(cx, buf),
        }
    }
}

impl Write for Io {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.project() {
            IoProjection::Unix { inner } => inner.poll_write(cx, buf),
            IoProjection::Tcp { inner } => inner.poll_write(cx, buf),
            IoProjection::Tls { inner } => inner.poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.project() {
            IoProjection::Unix { inner } => inner.poll_flush(cx),
            IoProjection::Tcp { inner } => inner.poll_flush(cx),
            IoProjection::Tls { inner } => inner.poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.project() {
            IoProjection::Unix { inner } => inner.poll_shutdown(cx),
            IoProjection::Tcp { inner } => inner.poll_shutdown(cx),
            IoProjection::Tls { inner } => inner.poll_shutdown(cx),
        }
    }
}

impl Connection for Io {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

type Connecting = Pin<Box<dyn Future<Output = io::Result<Io>> + Send>>;

/// Node's HTTP socket; the URI's authority is ignored, the path is the only address there is.
#[derive(Clone)]
pub struct NodeConnector {
    path: Arc<PathBuf>,
}

impl NodeConnector {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Arc::new(path),
        }
    }
}

impl Service<Uri> for NodeConnector {
    type Response = Io;
    type Error = io::Error;
    type Future = Connecting;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _uri: Uri) -> Connecting {
        let path = self.path.clone();
        Box::pin(async move {
            Ok(Io::Unix {
                inner: TokioIo::new(UnixStream::connect(&*path).await?),
            })
        })
    }
}

/// A preview's upstream: plain TCP, or TLS with verification off, since a forwarded dev server's certificate is
/// self-signed and the socket never leaves the sandbox's own network namespace.
#[derive(Clone)]
pub struct UpstreamConnector {
    tls: TlsConnector,
}

impl UpstreamConnector {
    pub fn new() -> Self {
        let provider = Arc::new(ring::default_provider());
        let config = ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCertificate(provider)))
            .with_no_client_auth();
        Self {
            tls: TlsConnector::from(Arc::new(config)),
        }
    }
}

impl Service<Uri> for UpstreamConnector {
    type Response = Io;
    type Error = io::Error;
    type Future = Connecting;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Connecting {
        let tls = self.tls.clone();
        Box::pin(async move {
            let host = uri.host().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "an upstream URI names no host")
            })?;
            let host = host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_owned();
            let secure = uri.scheme_str() == Some("https");
            let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
            let stream = TcpStream::connect((host.as_str(), port)).await?;
            stream.set_nodelay(true)?;
            if !secure {
                return Ok(Io::Tcp {
                    inner: TokioIo::new(stream),
                });
            }
            let name = ServerName::try_from(host)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
            Ok(Io::Tls {
                inner: TokioIo::new(tls.connect(name, stream).await?),
            })
        })
    }
}

#[derive(Debug)]
struct AcceptAnyCertificate(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

pub type Pool<C> = Client<C, Body>;

// Idle sockets drop before node:http's 5 s keep-alive does (Node and most dev servers), so a reuse never lands on one
// the far side is closing.
pub fn pool<C>(connector: C) -> Pool<C>
where
    C: Service<Uri, Response = Io, Error = io::Error> + Clone + Send + Sync + 'static,
    C::Future: Send + Unpin + 'static,
{
    Client::builder(TokioExecutor::new())
        .pool_idle_timeout(Duration::from_secs(4))
        .build(connector)
}

/// Sends an upgrade request over a connection of its own; the answer's upgrade resolves once it is a 101.
pub async fn send_upgrade(
    io: Io,
    request: Request<Body>,
) -> Result<Response<Incoming>, hyper::Error> {
    let (mut sender, connection) = hyper::client::conn::http1::handshake(io).await?;
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    sender.send_request(request).await
}
