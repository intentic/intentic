//! Hands a request to the peer holding its sandbox's tunnel, over the private network as plain HTTP/1.1 with its Host
//! intact and the hop marked, so the peer routes it as it would one from the internet and never hands it on again.
//! Streams both ways; an upgrade dials a connection of its own, since an upgraded one never returns to a pool, and is
//! spliced as every carrier's is (`relay::exchange`).

use std::net::IpAddr;

use http::header::{self, HeaderMap, HeaderValue};
use http::uri::PathAndQuery;
use http::{Request, Response, Version};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::net::TcpStream;

use crate::body::{self, Body};
use crate::cluster::HOP_HEADER;
use crate::peers::Peer;

#[derive(Debug)]
pub enum ForwardError {
    /// The peer is not there: forget it as the holder.
    Unreachable(String),
    /// The peer was reached and the exchange failed; its belief stands until it says otherwise.
    Failed(String),
}

pub struct Forwarder {
    client: Client<HttpConnector, Body>,
}

impl Default for Forwarder {
    fn default() -> Self {
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        Self {
            client: Client::builder(TokioExecutor::new())
                .set_host(false)
                .build(connector),
        }
    }
}

impl Forwarder {
    pub async fn request(
        &self,
        peer: &Peer,
        request: Request<Body>,
        host: &str,
        browser: IpAddr,
    ) -> Result<Response<Body>, ForwardError> {
        let (mut parts, sent) = request.into_parts();
        let path = parts.uri.path_and_query().map_or("/", PathAndQuery::as_str);
        parts.uri = format!("http://{}{path}", peer.address(peer.port))
            .parse()
            .map_err(|error| ForwardError::Failed(format!("no usable peer address: {error}")))?;
        parts.version = Version::HTTP_11;
        mark(&mut parts.headers, host, browser);
        let answer = self
            .client
            .request(Request::from_parts(parts, sent))
            .await
            .map_err(|error| {
                if error.is_connect() {
                    ForwardError::Unreachable(error.to_string())
                } else {
                    ForwardError::Failed(error.to_string())
                }
            })?;
        Ok(answer.map(body::incoming))
    }

    /// Until the peer answers 101 nothing reaches the browser; then the two sides are spliced. Any other answer is
    /// relayed as the peer's refusal.
    pub async fn upgrade(
        &self,
        peer: &Peer,
        request: Request<Body>,
        host: &str,
        browser: IpAddr,
    ) -> Result<Response<Body>, ForwardError> {
        let stream = TcpStream::connect(peer.address(peer.port))
            .await
            .map_err(|error| ForwardError::Unreachable(error.to_string()))?;
        let _ = stream.set_nodelay(true);
        let (mut parts, sent) = request.into_parts();
        let path = parts
            .uri
            .path_and_query()
            .map_or("/", PathAndQuery::as_str)
            .to_owned();
        parts.uri = path
            .parse()
            .map_err(|error| ForwardError::Failed(format!("no usable path: {error}")))?;
        parts.version = Version::HTTP_11;
        relay::for_next_hop(&mut parts.headers, true);
        mark(&mut parts.headers, host, browser);
        relay::exchange(TokioIo::new(stream), Request::from_parts(parts, sent))
            .await
            .map_err(|error| ForwardError::Failed(error.to_string()))
    }
}

// The hop mark, the Host the peer routes by, and the browser's address appended so the holder's logs show a browser.
fn mark(headers: &mut HeaderMap, host: &str, browser: IpAddr) {
    if !headers.contains_key(header::HOST)
        && let Ok(host) = HeaderValue::from_str(host)
    {
        headers.insert(header::HOST, host);
    }
    headers.insert(HOP_HEADER, HeaderValue::from_static("1"));
    let forwarded = match headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
    {
        Some(earlier) => format!("{earlier}, {browser}"),
        None => browser.to_string(),
    };
    if let Ok(forwarded) = HeaderValue::from_str(&forwarded) {
        headers.insert("x-forwarded-for", forwarded);
    }
}
