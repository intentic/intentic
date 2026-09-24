//! One held tunnel as the edge uses it, a request per stream: an h2 client over a WebSocket, where an upgrade rides a
//! CONNECT whose far side answers 200 and then writes its own h1 answer raw, or a QUIC connection whose streams carry
//! plain HTTP/1.1, where an upgrade is itself.

use std::sync::Arc;

use bytes::Bytes;
use http::header::{HeaderMap, HeaderName, HeaderValue};
use http::uri::PathAndQuery;
use http::{Method, Request, Response, StatusCode, Uri, Version};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use hyper::client::conn::http2::SendRequest;
use hyper_util::rt::TokioIo;
use quinn::Connection;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tunnel::{HOP_BY_HOP, wrap_envelope};

use crate::body::{self, Body};

// A far side's raw answer head is refused past this; a real one is a few hundred bytes.
const MAX_HEAD: usize = 64 * 1024;

// Headers an answer that declined the upgrade cannot keep: its body is already de-chunked and hyper frames it anew.
const DECLINED_DROP: [&str; 3] = ["connection", "keep-alive", "transfer-encoding"];

/// Why a request never reached an answer: nothing has been said to the browser yet, so the caller still owes one.
#[derive(Debug)]
pub struct Dropped(pub String);

#[derive(Clone)]
pub struct Session(Arc<Carrier>);

enum Carrier {
    H2(SendRequest<Body>),
    Quic(Connection),
}

// A bulk request's stream yields to every other on the connection; QUIC schedules by it, h2 has nothing to set.
const BULK_PRIORITY: i32 = -1;

impl Session {
    pub fn h2(sender: SendRequest<Body>) -> Self {
        Self(Arc::new(Carrier::H2(sender)))
    }

    pub fn quic(connection: Connection) -> Self {
        Self(Arc::new(Carrier::Quic(connection)))
    }

    /// Whether both handles are the one tunnel, which is what a registry entry is compared by.
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// Forwards one request down the tunnel, routed on the far side by `host`; the answer's body streams as it arrives,
    /// and a browser that goes away resets the stream, which unwinds the daemon's own request.
    pub async fn request(
        &self,
        request: Request<Body>,
        host: &str,
        bulk: bool,
    ) -> Result<Response<Body>, Dropped> {
        let sender = match &*self.0 {
            Carrier::H2(sender) => sender,
            Carrier::Quic(connection) => {
                return quic_request(connection, request, host, bulk).await;
            }
        };
        let (parts, sent) = request.into_parts();
        let path = parts.uri.path_and_query().map_or("/", PathAndQuery::as_str);
        let uri = Uri::builder()
            .scheme("https")
            .authority(host)
            .path_and_query(path)
            .build()
            .map_err(|error| Dropped(format!("the request names no usable address: {error}")))?;
        let mut outbound = Request::new(sent);
        *outbound.method_mut() = parts.method;
        *outbound.uri_mut() = uri;
        *outbound.version_mut() = Version::HTTP_2;
        *outbound.headers_mut() = end_to_end(parts.headers);
        let answer = sender
            .clone()
            .send_request(outbound)
            .await
            .map_err(|error| Dropped(format!("the tunnel dropped the request: {error}")))?;
        let (mut parts, incoming) = answer.into_parts();
        parts.headers = end_to_end(parts.headers);
        parts.version = Version::default();
        Ok(Response::from_parts(parts, body::incoming(incoming)))
    }

    /// Carries an upgrade down the tunnel. Nothing reaches the browser until the far side has answered, so a refusal
    /// is still the caller's to write; a 101 is relayed and the two sides spliced once the browser's side is free.
    pub async fn upgrade(
        &self,
        mut request: Request<Body>,
        host: &str,
    ) -> Result<Response<Body>, Dropped> {
        let sender = match &*self.0 {
            Carrier::H2(sender) => sender,
            Carrier::Quic(connection) => return quic_upgrade(connection, request, host).await,
        };
        let browser = hyper::upgrade::on(&mut request);
        let path = request
            .uri()
            .path_and_query()
            .map_or("/", PathAndQuery::as_str);
        let envelope = wrap_envelope(request.method(), path, request.headers())
            .ok_or_else(|| Dropped("an upgrade header cannot ride the envelope".into()))?;
        let mut connect = Request::new(body::empty());
        *connect.method_mut() = Method::CONNECT;
        *connect.uri_mut() = Uri::builder()
            .authority(host)
            .build()
            .map_err(|error| Dropped(format!("the upgrade names no usable address: {error}")))?;
        *connect.headers_mut() = envelope;
        let mut answer = sender
            .clone()
            .send_request(connect)
            .await
            .map_err(|error| Dropped(format!("the tunnel dropped the upgrade: {error}")))?;
        if answer.status() != StatusCode::OK {
            return Err(Dropped(format!(
                "the tunnel refused the upgrade with {}",
                answer.status()
            )));
        }
        let far = hyper::upgrade::on(&mut answer)
            .await
            .map_err(|error| Dropped(format!("the upgrade stream never opened: {error}")))?;
        let mut far = TokioIo::new(far);
        let (head, rest) = read_head(&mut far)
            .await
            .map_err(|error| Dropped(format!("the far side's answer was unreadable: {error}")))?;
        let (status, mut headers) = parse_head(&head)
            .ok_or_else(|| Dropped("the far side's answer is not an HTTP/1.1 head".into()))?;
        if status == StatusCode::SWITCHING_PROTOCOLS {
            tokio::spawn(async move {
                let Ok(browser) = browser.await else {
                    return;
                };
                let mut browser = TokioIo::new(browser);
                if !rest.is_empty() && browser.write_all(&rest).await.is_err() {
                    return;
                }
                let _ = tokio::io::copy_bidirectional(&mut browser, &mut far).await;
            });
            let mut response = Response::new(body::empty());
            *response.status_mut() = status;
            *response.headers_mut() = headers;
            return Ok(response);
        }
        for name in DECLINED_DROP {
            headers.remove(name);
        }
        let mut response = Response::new(rest_of(far, rest));
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        Ok(response)
    }
}

// A request's own stream on the QUIC connection, with HTTP/1.1 spoken over it.
async fn quic_exchange(
    connection: &Connection,
    upgrades: bool,
    bulk: bool,
) -> Result<hyper::client::conn::http1::SendRequest<Body>, Dropped> {
    let (send, recv) = connection
        .open_bi()
        .await
        .map_err(|error| Dropped(format!("the tunnel refused a stream: {error}")))?;
    if bulk {
        let _ = send.set_priority(BULK_PRIORITY);
    }
    let (sender, driving) =
        hyper::client::conn::http1::handshake(TokioIo::new(tunnel::quic::stream(send, recv)))
            .await
            .map_err(|error| Dropped(format!("the stream did not open: {error}")))?;
    if upgrades {
        tokio::spawn(driving.with_upgrades());
    } else {
        tokio::spawn(driving);
    }
    Ok(sender)
}

// An HTTP/1.1 request names its path alone and its Host in a header.
fn over_http1(parts: &mut http::request::Parts, host: &str) -> Result<(), Dropped> {
    let path = parts.uri.path_and_query().map_or("/", PathAndQuery::as_str);
    parts.uri = path
        .parse()
        .map_err(|error| Dropped(format!("the request names no usable path: {error}")))?;
    parts.version = Version::HTTP_11;
    let host = HeaderValue::from_str(host)
        .map_err(|error| Dropped(format!("the request names no usable host: {error}")))?;
    parts.headers.insert(http::header::HOST, host);
    Ok(())
}

async fn quic_request(
    connection: &Connection,
    request: Request<Body>,
    host: &str,
    bulk: bool,
) -> Result<Response<Body>, Dropped> {
    let mut sender = quic_exchange(connection, false, bulk).await?;
    let (mut parts, sent) = request.into_parts();
    parts.headers = end_to_end(parts.headers);
    over_http1(&mut parts, host)?;
    let answer = sender
        .send_request(Request::from_parts(parts, sent))
        .await
        .map_err(|error| Dropped(format!("the tunnel dropped the request: {error}")))?;
    let (mut parts, incoming) = answer.into_parts();
    parts.headers = end_to_end(parts.headers);
    Ok(Response::from_parts(parts, body::incoming(incoming)))
}

// The browser's own head goes as it stands, its upgrade headers included, and a 101 splices the two once both are free.
async fn quic_upgrade(
    connection: &Connection,
    mut request: Request<Body>,
    host: &str,
) -> Result<Response<Body>, Dropped> {
    let browser = hyper::upgrade::on(&mut request);
    let mut sender = quic_exchange(connection, true, false).await?;
    let (mut parts, _) = request.into_parts();
    over_http1(&mut parts, host)?;
    let mut answer = sender
        .send_request(Request::from_parts(parts, body::empty()))
        .await
        .map_err(|error| Dropped(format!("the tunnel dropped the upgrade: {error}")))?;
    if answer.status() != StatusCode::SWITCHING_PROTOCOLS {
        let (mut parts, incoming) = answer.into_parts();
        parts.headers = end_to_end(parts.headers);
        return Ok(Response::from_parts(parts, body::incoming(incoming)));
    }
    let far = hyper::upgrade::on(&mut answer);
    tokio::spawn(async move {
        let (Ok(browser), Ok(far)) = (browser.await, far.await) else {
            return;
        };
        let _ =
            tokio::io::copy_bidirectional(&mut TokioIo::new(browser), &mut TokioIo::new(far)).await;
    });
    let (parts, _) = answer.into_parts();
    Ok(Response::from_parts(parts, body::empty()))
}

/// The headers that survive a hop: HTTP/1.1 connection management and `host` gone, everything else as it was.
pub fn end_to_end(mut headers: HeaderMap) -> HeaderMap {
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
    headers
}

// The far side's answer head, and whatever arrived past it.
async fn read_head(far: &mut (impl AsyncRead + Unpin)) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 4096];
    loop {
        let read = far.read(&mut chunk).await?;
        if read == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        let searched = buffer.len().saturating_sub(3);
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(at) = buffer[searched..]
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        {
            let rest = buffer.split_off(searched + at + 4);
            return Ok((buffer, rest));
        }
        if buffer.len() > MAX_HEAD {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
    }
}

fn parse_head(head: &[u8]) -> Option<(StatusCode, HeaderMap)> {
    let mut slots = [httparse::EMPTY_HEADER; 128];
    let mut parsed = httparse::Response::new(&mut slots);
    if !parsed.parse(head).ok()?.is_complete() {
        return None;
    }
    let status = StatusCode::from_u16(parsed.code?).ok()?;
    let mut headers = HeaderMap::with_capacity(parsed.headers.len());
    for header in parsed.headers.iter() {
        headers.append(
            HeaderName::from_bytes(header.name.as_bytes()).ok()?,
            HeaderValue::from_bytes(header.value).ok()?,
        );
    }
    Some((status, headers))
}

// A declined upgrade's body: what came past the head, then the stream until the far side closes it.
fn rest_of(far: TokioIo<hyper::upgrade::Upgraded>, rest: Vec<u8>) -> Body {
    let frames = futures_util::stream::unfold(
        (far, Some(rest), false),
        |(mut far, first, done)| async move {
            if done {
                return None;
            }
            if let Some(first) = first.filter(|first| !first.is_empty()) {
                return Some((Ok(Frame::data(Bytes::from(first))), (far, None, false)));
            }
            let mut buffer = vec![0_u8; 16 * 1024];
            match far.read(&mut buffer).await {
                Ok(0) => None,
                Ok(read) => {
                    buffer.truncate(read);
                    Some((Ok(Frame::data(Bytes::from(buffer))), (far, None, false)))
                }
                Err(error) => Some((Err(error.into()), (far, None, true))),
            }
        },
    );
    StreamBody::new(frames).boxed_unsync()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_head_is_read_to_its_blank_line_and_what_follows_is_kept() {
        let (mut near, mut far) = tokio::io::duplex(1024);
        near.write_all(b"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n")
            .await
            .unwrap();
        near.write_all(b"connection: Upgrade\r\n\r\nfirst frame")
            .await
            .unwrap();
        let (head, rest) = read_head(&mut far).await.unwrap();
        assert!(head.ends_with(b"Upgrade\r\n\r\n"));
        assert_eq!(rest, b"first frame");
        let (status, headers) = parse_head(&head).unwrap();
        assert_eq!(status, StatusCode::SWITCHING_PROTOCOLS);
        assert_eq!(headers["upgrade"], "websocket");
        assert_eq!(headers["connection"], "Upgrade");
    }

    #[tokio::test]
    async fn a_head_that_never_ends_is_refused_rather_than_buffered() {
        let (mut near, mut far) = tokio::io::duplex(MAX_HEAD * 2);
        near.write_all(&vec![b'a'; MAX_HEAD + 10]).await.unwrap();
        assert!(read_head(&mut far).await.is_err());
    }

    #[test]
    fn a_hop_by_hop_header_never_crosses() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "host",
            HeaderValue::from_static("sandbox-abcdef012345.sbx.test"),
        );
        headers.insert("connection", HeaderValue::from_static("keep-alive"));
        headers.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        headers.append("set-cookie", HeaderValue::from_static("a=1"));
        headers.append("set-cookie", HeaderValue::from_static("b=2"));
        let kept = end_to_end(headers);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept.get_all("set-cookie").iter().count(), 2);
    }
}
