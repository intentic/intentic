//! One held tunnel as the edge uses it: a carrier of byte streams, each exchange a stream of its own carrying plain
//! HTTP/1.1, where an upgrade is itself. QUIC and `/tunnel/v2`'s yamux are such carriers; a legacy `/tunnel/v1` h2
//! session is not, and is spoken by `legacy.rs` for the fronts that still dial it.

use std::sync::Arc;

use http::header::{self, HeaderValue};
use http::uri::PathAndQuery;
use http::{Request, Response, Version};
use hyper::client::conn::http2::SendRequest;
use hyper_util::rt::TokioIo;
use quinn::Connection;
use tunnel::{BulkRoutes, mux};

use crate::body::Body;
use crate::legacy;

/// Why a request never reached an answer: nothing has been said to the browser yet, so the caller still owes one.
#[derive(Debug)]
pub struct Dropped(pub String);

#[derive(Clone)]
pub struct Session(Arc<Carrier>);

enum Carrier {
    Quic(Connection),
    /// A `/tunnel/v2` socket, and the transfer routes its front announced on it.
    Mux(mux::Opener, BulkRoutes),
    Legacy(SendRequest<Body>),
}

impl Session {
    pub fn quic(connection: Connection) -> Self {
        Self(Arc::new(Carrier::Quic(connection)))
    }

    pub fn mux(opener: mux::Opener, routes: BulkRoutes) -> Self {
        Self(Arc::new(Carrier::Mux(opener, routes)))
    }

    pub fn legacy(sender: SendRequest<Body>) -> Self {
        Self(Arc::new(Carrier::Legacy(sender)))
    }

    /// Whether both handles are the one tunnel, which is what a registry entry is compared by.
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// Whether a request to `host` belongs on its sandbox's bulk socket, as the daemon behind this one announced: a
    /// legacy front's by the routes frozen with its door, and nothing over QUIC, where a burst yields by itself.
    pub fn carries_bulk(&self, host: &str, method: &str, path: &str) -> bool {
        match &*self.0 {
            Carrier::Quic(_) => false,
            Carrier::Mux(_, routes) => routes.carries(host, method, path),
            Carrier::Legacy(_) => legacy::frozen_bulk().carries(host, method, path),
        }
    }

    /// Forwards one exchange down the tunnel, routed on the far side by `host`. The answer's body streams as it arrives
    /// and a browser that goes away ends the stream, which unwinds the daemon's own request; a 101 splices the two
    /// sides once both are free. Nothing reaches the browser before the far side answers, so a refusal is the caller's.
    pub async fn exchange(
        &self,
        request: Request<Body>,
        host: &str,
    ) -> Result<Response<Body>, Dropped> {
        let upgrade = relay::is_upgrade(request.headers(), request.version());
        let stream =
            match &*self.0 {
                Carrier::Legacy(sender) => {
                    return legacy::exchange(sender, request, host, upgrade).await;
                }
                Carrier::Quic(connection) => {
                    let (send, recv) = connection.open_bi().await.map_err(|error| {
                        Dropped(format!("the tunnel refused a stream: {error}"))
                    })?;
                    Stream::Quic(tunnel::quic::stream(send, recv))
                }
                Carrier::Mux(opener, _) => {
                    Stream::Mux(opener.open().await.map_err(|error| {
                        Dropped(format!("the tunnel refused a stream: {error}"))
                    })?)
                }
            };
        let request = over_http1(request, host, upgrade)?;
        let answered = match stream {
            Stream::Quic(stream) => relay::exchange(TokioIo::new(stream), request).await,
            Stream::Mux(stream) => relay::exchange(TokioIo::new(stream), request).await,
        };
        answered.map_err(|error| Dropped(format!("the tunnel dropped the exchange: {error}")))
    }
}

enum Stream {
    Quic(tunnel::quic::Stream),
    Mux(mux::Stream),
}

// A stream's request names its path alone and its Host in a header, with nothing of the browser's hop left on it.
fn over_http1(request: Request<Body>, host: &str, upgrade: bool) -> Result<Request<Body>, Dropped> {
    let (mut parts, sent) = request.into_parts();
    let path = parts.uri.path_and_query().map_or("/", PathAndQuery::as_str);
    parts.uri = path
        .parse()
        .map_err(|error| Dropped(format!("the request names no usable path: {error}")))?;
    parts.version = Version::HTTP_11;
    relay::for_next_hop(&mut parts.headers, upgrade);
    let host = HeaderValue::from_str(host)
        .map_err(|error| Dropped(format!("the request names no usable host: {error}")))?;
    parts.headers.insert(header::HOST, host);
    Ok(Request::from_parts(parts, sent))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body;

    #[test]
    fn a_stream_request_is_origin_form_with_its_host_and_no_hop_of_the_browsers() {
        let request = Request::builder()
            .uri("https://sandbox-abcdef012345.sbx.test/files?x=1")
            .version(Version::HTTP_2)
            .header("te", "trailers")
            .header("x-kept", "1")
            .body(body::empty())
            .unwrap();
        let sent = over_http1(request, "sandbox-abcdef012345.sbx.test", false).unwrap();
        assert_eq!(sent.uri(), "/files?x=1");
        assert_eq!(sent.version(), Version::HTTP_11);
        assert_eq!(
            sent.headers()[header::HOST],
            "sandbox-abcdef012345.sbx.test"
        );
        assert!(sent.headers().get("te").is_none());
        assert_eq!(sent.headers()["x-kept"], "1");
    }
}
