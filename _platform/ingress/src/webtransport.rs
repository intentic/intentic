//! WebTransport for a browser's terminals: a session is one CONNECT to `/system/transport` on a sandbox's address, and
//! each stream the browser opens on it is served as one HTTP/1.1 connection to that address, so a terminal's upgrade
//! reaches the sandbox as a TCP one does while a lost packet stalls only its own stream.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use h3::ext::Protocol;
use h3::server::RequestStream;
use h3_webtransport::server::{AcceptedBi, WebTransportSession};
use h3_webtransport::stream::BidiStream;
use http::header::HOST;
use http::{HeaderValue, Method, Request, Response, StatusCode};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};

use tunnel::host_owner_id;

use crate::body;
use crate::edge::{Edge, Via};

/// Where a session is opened, on the address of the sandbox its streams reach.
pub const PATH: &str = "/system/transport";

pub type Connection = h3::server::Connection<h3_quinn::Connection, Bytes>;
pub type ConnectStream = RequestStream<h3_quinn::BidiStream<Bytes>, Bytes>;

/// Whether a request asks for a session: an extended CONNECT naming WebTransport.
pub fn asks(request: &Request<()>) -> bool {
    request.method() == Method::CONNECT
        && request.extensions().get::<Protocol>() == Some(&Protocol::WEB_TRANSPORT)
}

/// The sandbox address a session asked for is served on, when it asked for one at `PATH`.
pub fn admits(request: &Request<()>) -> Option<String> {
    let host = request.uri().authority()?.as_str();
    (request.uri().path() == PATH && host_owner_id(host).is_some()).then(|| host.to_owned())
}

/// Answers a CONNECT no session is opened for.
pub async fn refuse(mut stream: ConnectStream, status: StatusCode) {
    let refusal = Response::builder()
        .status(status)
        .body(())
        .expect("a refusal builds");
    if stream.send_response(refusal).await.is_ok() {
        let _ = stream.finish().await;
    }
}

/// Holds a session for as long as the browser keeps its connection, which the session takes whole.
pub async fn serve(
    edge: Arc<Edge>,
    request: Request<()>,
    stream: ConnectStream,
    connection: Connection,
    host: String,
    remote: SocketAddr,
) {
    let session = match WebTransportSession::accept(request, stream, connection).await {
        Ok(session) => session,
        Err(error) => {
            tracing::debug!(%error, %remote, "a WebTransport session was not established");
            return;
        }
    };
    loop {
        match session.accept_bi().await {
            Ok(Some(AcceptedBi::BidiStream(_, stream))) => {
                tokio::spawn(exchange(edge.clone(), stream, host.clone(), remote));
            }
            Ok(Some(AcceptedBi::Request(request, stream))) if asks(&request) => {
                tokio::spawn(refuse(stream, StatusCode::TOO_MANY_REQUESTS));
            }
            Ok(Some(AcceptedBi::Request(request, stream))) => {
                tokio::spawn(crate::h3::answer(edge.clone(), request, stream, remote));
            }
            Ok(None) => return,
            Err(error) => {
                tracing::debug!(%error, %remote, "a WebTransport session ended");
                return;
            }
        }
    }
}

// One stream as an HTTP/1.1 connection: whatever Host it writes, it reaches only the address its session was opened for.
async fn exchange(
    edge: Arc<Edge>,
    stream: BidiStream<h3_quinn::BidiStream<Bytes>, Bytes>,
    host: String,
    remote: SocketAddr,
) {
    let Ok(pinned) = HeaderValue::from_str(&host) else {
        return;
    };
    let service = service_fn(move |mut request: Request<Incoming>| {
        let edge = edge.clone();
        request.headers_mut().insert(HOST, pinned.clone());
        async move {
            Ok::<_, Infallible>(
                edge.handle(request.map(body::incoming), remote, Via::Direct)
                    .await,
            )
        }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(crate::serve::HEAD_PATIENCE)
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sessions_path_is_the_one_the_editor_opens() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../_shared/sandbox-contract/src/front/terminal-frames.fixture.json"
        ))
        .unwrap();
        assert_eq!(fixture["session"], PATH);
    }
}
