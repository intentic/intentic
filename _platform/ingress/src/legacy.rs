//! `/tunnel/v1`, kept only for fronts that predate `/tunnel/v2`: two WebSocket lanes, each one HTTP/2 session with the
//! edge its client. An upgrade cannot cross h2 as itself (the headers it needs are the ones h2 forbids), so it rides a
//! CONNECT stream carrying the browser's whole h1 head under `x-ingress-*`, and the front answers 200 and then writes its
//! own h1 answer raw. Those fronts announce no transfer routes, so the ones their daemons had when this door was frozen
//! are here, read as any announcement is. Nothing new is ever built on this file; it goes once no front dials it.

use bytes::Bytes;
use http::header::{self, HeaderMap, HeaderName, HeaderValue};
use http::uri::PathAndQuery;
use http::{Method, Request, Response, StatusCode, Uri, Version};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use hyper::client::conn::http2::SendRequest;
use hyper_util::rt::TokioIo;
use std::sync::LazyLock;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tunnel::BulkRoutes;

use crate::body::{self, Body};
use crate::session::Dropped;

/// The legacy door, beside `tunnel::TUNNEL_PATH`.
pub const PATH: &str = "/tunnel/v1";

const METHOD_HEADER: &str = "x-ingress-method";
const PATH_HEADER: &str = "x-ingress-path";
const HEADER_PREFIX: &str = "x-ingress-h-";

// A front's raw answer head is refused past this; a real one is a few hundred bytes.
const MAX_HEAD: usize = 64 * 1024;

// Headers an answer that declined the upgrade cannot keep: its body is already de-chunked and hyper frames it anew.
const DECLINED_DROP: [&str; 3] = ["connection", "keep-alive", "transfer-encoding"];

// The daemon's transfer routes when this door was frozen, as a front announces them on `/tunnel/v2`.
const FROZEN_BULK: &str = "GET /diff/raw, GET /workspace/raw, GET /workspace/media, POST /workspace/upload, \
    POST /workspace/upload-archive, GET /system/sync/ssh, GET /bundles/download, GET /extensions/{id}/bundle, \
    GET /system/runners/git/{repo}/info/refs, POST /system/runners/git/{repo}/git-upload-pack, \
    POST /system/runners/git/{repo}/git-receive-pack";

/// What a legacy front's daemon would have announced.
pub fn frozen_bulk() -> &'static BulkRoutes {
    static FROZEN: LazyLock<BulkRoutes> = LazyLock::new(|| BulkRoutes::parse(FROZEN_BULK));
    &FROZEN
}

/// Forwards one exchange down a legacy session: a request as an h2 stream of its own, an upgrade as a CONNECT carrying
/// its head. Nothing reaches the browser until the front has answered, so a refusal is still the caller's to write.
pub async fn exchange(
    sender: &SendRequest<Body>,
    request: Request<Body>,
    host: &str,
    upgrade: bool,
) -> Result<Response<Body>, Dropped> {
    if upgrade {
        return carry_upgrade(sender, request, host).await;
    }
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
    *outbound.headers_mut() = over_h2(parts.headers);
    let answer = sender
        .clone()
        .send_request(outbound)
        .await
        .map_err(|error| Dropped(format!("the tunnel dropped the request: {error}")))?;
    let (mut parts, incoming) = answer.into_parts();
    relay::strip_hop_by_hop(&mut parts.headers);
    parts.version = Version::default();
    Ok(Response::from_parts(parts, body::incoming(incoming)))
}

// h2 carries the host as `:authority`, and refuses h1's connection management outright.
fn over_h2(mut headers: HeaderMap) -> HeaderMap {
    relay::strip_hop_by_hop(&mut headers);
    headers.remove(header::HOST);
    headers
}

// A 101 is relayed and the two sides spliced once the browser's side is free; any other answer is relayed as a body.
async fn carry_upgrade(
    sender: &SendRequest<Body>,
    mut request: Request<Body>,
    host: &str,
) -> Result<Response<Body>, Dropped> {
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
        .map_err(|error| Dropped(format!("the front's answer was unreadable: {error}")))?;
    let (status, mut headers) = parse_head(&head)
        .ok_or_else(|| Dropped("the front's answer is not an HTTP/1.1 head".into()))?;
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

// The headers of a CONNECT stream carrying an upgrade's h1 head, rebuilt verbatim on the far side, so no header is
// allowlisted one by one; `None` when a header of it cannot be named under the prefix.
fn wrap_envelope(method: &Method, path: &str, headers: &HeaderMap) -> Option<HeaderMap> {
    let mut envelope = HeaderMap::with_capacity(headers.len() + 2);
    envelope.insert(METHOD_HEADER, HeaderValue::from_str(method.as_str()).ok()?);
    envelope.insert(PATH_HEADER, HeaderValue::from_str(path).ok()?);
    for (name, value) in headers {
        let wrapped = HeaderName::from_bytes(format!("{HEADER_PREFIX}{name}").as_bytes()).ok()?;
        envelope.append(wrapped, value.clone());
    }
    Some(envelope)
}

// The front's answer head, and whatever arrived past it.
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

// A declined upgrade's body: what came past the head, then the stream until the front closes it.
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

    const DAEMON: &str = "sandbox-abcdef012345.sbx.test";

    #[test]
    fn a_legacy_front_carries_the_daemons_transfers_and_every_preview_on_its_bulk_lane() {
        let frozen = frozen_bulk();
        let bulk = [
            ("GET", DAEMON, "/workspace/raw?path=a.bin"),
            ("HEAD", DAEMON, "/workspace/media"),
            ("POST", DAEMON, "/workspace/upload"),
            ("GET", DAEMON, "/extensions/acme.tool/bundle"),
            (
                "POST",
                DAEMON,
                "/system/runners/git/intentic/git-receive-pack",
            ),
            ("OPTIONS", DAEMON, "/workspace/upload"),
            ("GET", "preview-web-abcdef012345.sbx.test", "/"),
            ("GET", "stray.sbx.test", "/"),
        ];
        for (method, host, path) in bulk {
            assert!(frozen.carries(host, method, path), "{method} {host}{path}");
        }
        let interactive = [
            ("GET", DAEMON, "/health"),
            ("POST", DAEMON, "/workspace/raw"),
            ("GET", DAEMON, "/workspace/raw/more"),
            ("GET", DAEMON, "/extensions//bundle"),
            ("OPTIONS", DAEMON, "/health"),
        ];
        for (method, host, path) in interactive {
            assert!(!frozen.carries(host, method, path), "{method} {host}{path}");
        }
    }

    #[test]
    fn an_upgrade_head_rides_the_envelope_whole() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static(DAEMON));
        headers.insert("upgrade", HeaderValue::from_static("websocket"));
        headers.append("cookie", HeaderValue::from_static("a=1"));
        headers.append("cookie", HeaderValue::from_static("b=2"));
        let envelope = wrap_envelope(&Method::GET, "/system/terminal?x=1", &headers).unwrap();
        assert_eq!(envelope[METHOD_HEADER], "GET");
        assert_eq!(envelope[PATH_HEADER], "/system/terminal?x=1");
        assert_eq!(envelope["x-ingress-h-host"], DAEMON);
        assert_eq!(envelope.get_all("x-ingress-h-cookie").iter().count(), 2);
    }

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
    }

    #[tokio::test]
    async fn a_head_that_never_ends_is_refused_rather_than_buffered() {
        let (mut near, mut far) = tokio::io::duplex(MAX_HEAD * 2);
        near.write_all(&vec![b'a'; MAX_HEAD + 10]).await.unwrap();
        assert!(read_head(&mut far).await.is_err());
    }
}
