//! One held tunnel as the edge uses it: a carrier of byte streams, each exchange a stream of its own carrying plain
//! HTTP/1.1, where an upgrade is itself. QUIC and `/tunnel/v2`'s yamux are such carriers; a legacy `/tunnel/v1` h2
//! session is not, and is spoken by `legacy.rs` for the fronts that still dial it.
//!
//! Over QUIC a stream's opening and its answer's first byte have deadlines (2026-10-05: a half-dead QUIC path took every
//! request and answered none, since QUIC outranks the socket). A stream that does not open in time hands its request
//! back whole. An answer that does not start in time is a slow route or a dead path, and a probe beside it tells which:
//! answered, the request waits on; unanswered, the carrier is `Stalled`, and a request that sent nothing of a body yet is
//! handed back as a copy for the socket to carry.

use std::sync::Arc;
use std::time::Duration;

use http::header::{self, HeaderValue};
use http::uri::PathAndQuery;
use http::{Request, Response, Version};
use hyper::body::Body as _;
use hyper::client::conn::http2::SendRequest;
use hyper_util::rt::TokioIo;
use quinn::Connection;
use tunnel::{BulkRoutes, PROBE_PATIENCE, mux};

use crate::body::Body;
use crate::legacy;

/// Why a request never reached an answer: nothing has been said to the browser yet, so the caller still owes one.
#[derive(Debug)]
pub struct Dropped(pub String);

/// How a request through a held tunnel failed.
pub enum Failed {
    /// The tunnel took it and it went wrong there.
    Dropped(Dropped),
    /// A QUIC carrier did not take it in time and failed a probe beside it: the carrier is to be demoted, and the request
    /// is handed back for another carrier when nothing of it was spent.
    Stalled {
        why: String,
        request: Option<Box<Request<Body>>>,
    },
}

// A QUIC stream opens at once while the front grants streams; one that has not opened by now never will.
const OPEN_PATIENCE: Duration = Duration::from_secs(5);

// Past this without an answer's first byte, a probe asks whether the path still serves streams.
const FIRST_BYTE_PATIENCE: Duration = Duration::from_secs(10);

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
        self.send(request, host)
            .await
            .map_err(|failed| match failed {
                Failed::Dropped(dropped) => dropped,
                Failed::Stalled { why, .. } => Dropped(why),
            })
    }

    /// `exchange`, telling a QUIC carrier that stalled apart from a request that failed, and handing back what can be
    /// sent again.
    pub async fn send(&self, request: Request<Body>, host: &str) -> Result<Response<Body>, Failed> {
        let upgrade = relay::is_upgrade(request.headers(), request.version());
        let stream = match &*self.0 {
            Carrier::Legacy(sender) => {
                return legacy::exchange(sender, request, host, upgrade)
                    .await
                    .map_err(Failed::Dropped);
            }
            Carrier::Quic(connection) => {
                return quic_exchange(connection, request, host, upgrade).await;
            }
            Carrier::Mux(opener, _) => opener.open().await.map_err(|error| {
                Failed::Dropped(Dropped(format!("the tunnel refused a stream: {error}")))
            })?,
        };
        let request = over_http1(request, host, upgrade).map_err(Failed::Dropped)?;
        relay::exchange(TokioIo::new(stream), request)
            .await
            .map_err(|error| {
                Failed::Dropped(Dropped(format!("the tunnel dropped the exchange: {error}")))
            })
    }
}

async fn quic_exchange(
    connection: &Connection,
    request: Request<Body>,
    host: &str,
    upgrade: bool,
) -> Result<Response<Body>, Failed> {
    let (send, recv) = match tokio::time::timeout(OPEN_PATIENCE, connection.open_bi()).await {
        Ok(Ok(opened)) => opened,
        Ok(Err(error)) => {
            return Err(Failed::Stalled {
                why: format!("the QUIC tunnel refused a stream: {error}"),
                request: Some(Box::new(request)),
            });
        }
        Err(_) => {
            return Err(Failed::Stalled {
                why: format!("no QUIC stream opened within {OPEN_PATIENCE:?}"),
                request: Some(Box::new(request)),
            });
        }
    };
    let replay = replayable(&request, upgrade);
    let request = over_http1(request, host, upgrade).map_err(Failed::Dropped)?;
    let answering = relay::exchange(TokioIo::new(tunnel::quic::stream(send, recv)), request);
    tokio::pin!(answering);
    let dropped = |error: hyper::Error| {
        Failed::Dropped(Dropped(format!("the tunnel dropped the exchange: {error}")))
    };
    if let Ok(answered) = tokio::time::timeout(FIRST_BYTE_PATIENCE, &mut answering).await {
        return answered.map_err(dropped);
    }
    // A slow route answers late on a path that serves; a dead path serves no probe either.
    tokio::select! {
        answered = &mut answering => answered.map_err(dropped),
        probed = tokio::time::timeout(PROBE_PATIENCE, tunnel::quic::probe(connection)) => match probed {
            Ok(Ok(())) => answering.await.map_err(dropped),
            _ => Err(Failed::Stalled {
                why: format!("no answer within {FIRST_BYTE_PATIENCE:?}, and a probe beside it went unanswered"),
                request: replay,
            }),
        },
    }
}

// A copy of a request to send again elsewhere, when nothing of it is spent by sending it once: no upgrade, whose two
// sides are this request's own, and no body still to stream.
fn replayable(request: &Request<Body>, upgrade: bool) -> Option<Box<Request<Body>>> {
    if upgrade || !request.body().is_end_stream() {
        return None;
    }
    let mut copy = Request::builder()
        .method(request.method().clone())
        .uri(request.uri().clone())
        .version(request.version())
        .body(crate::body::empty())
        .ok()?;
    *copy.headers_mut() = request.headers().clone();
    Some(Box::new(copy))
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
    fn only_a_request_with_nothing_left_to_stream_is_sent_again() {
        let get = Request::get("/files")
            .header("x-kept", "1")
            .body(body::empty())
            .unwrap();
        let copy = replayable(&get, false).unwrap();
        assert_eq!(
            (copy.method(), copy.uri().path()),
            (&http::Method::GET, "/files")
        );
        assert_eq!(copy.headers()["x-kept"], "1");
        assert!(
            replayable(&get, true).is_none(),
            "an upgrade's two sides are its own"
        );
        let streaming = Request::post("/upload")
            .body(body::full("a body still to send"))
            .unwrap();
        assert!(replayable(&streaming, false).is_none());
    }

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
