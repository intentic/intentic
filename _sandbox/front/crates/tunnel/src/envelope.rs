//! A WebSocket upgrade cannot cross h2 as itself: the headers it needs (Connection, Upgrade, Sec-WebSocket-Key) are the
//! ones h2 forbids. It rides a CONNECT stream instead, the whole h1 head carried under `x-ingress-*` and rebuilt verbatim
//! on the far side, so no header is allowlisted one by one. The far side answers 200, then writes its own h1 answer raw.

use http::header::{HeaderMap, HeaderName, HeaderValue};
use http::{Method, Request};

pub(crate) const METHOD_HEADER: &str = "x-ingress-method";
pub(crate) const PATH_HEADER: &str = "x-ingress-path";
pub(crate) const HEADER_PREFIX: &str = "x-ingress-h-";

/// Never cross a hop: HTTP/1.1 connection management, which h2 refuses to carry at all, and `host`, which h2 carries as
/// `:authority`.
pub const HOP_BY_HOP: [&str; 11] = [
    "connection",
    "host",
    "http2-settings",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// The headers of a CONNECT stream carrying an upgrade's h1 head; `None` when a header of it cannot be named under the
/// prefix.
pub fn wrap_envelope(method: &Method, path: &str, headers: &HeaderMap) -> Option<HeaderMap> {
    let mut envelope = HeaderMap::with_capacity(headers.len() + 2);
    envelope.insert(METHOD_HEADER, HeaderValue::from_str(method.as_str()).ok()?);
    envelope.insert(PATH_HEADER, HeaderValue::from_str(path).ok()?);
    for (name, value) in headers {
        let wrapped = HeaderName::from_bytes(format!("{HEADER_PREFIX}{name}").as_bytes()).ok()?;
        envelope.append(wrapped, value.clone());
    }
    Some(envelope)
}

/// The h1 head an envelope carried; anything not under the prefix was never part of it. `None` for a method or a
/// header name that does not parse.
pub fn unwrap_envelope(envelope: &HeaderMap) -> Option<Request<()>> {
    let text = |name: &str| envelope.get(name).and_then(|value| value.to_str().ok());
    let method = Method::from_bytes(text(METHOD_HEADER).unwrap_or("GET").as_bytes()).ok()?;
    let mut request = Request::builder()
        .method(method)
        .uri(text(PATH_HEADER).unwrap_or("/"))
        .body(())
        .ok()?;
    for (name, value) in envelope {
        if let Some(original) = name.as_str().strip_prefix(HEADER_PREFIX) {
            request.headers_mut().append(
                HeaderName::from_bytes(original.as_bytes()).ok()?,
                value.clone(),
            );
        }
    }
    Some(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upgrade_head_survives_the_envelope_whole() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "host",
            HeaderValue::from_static("sandbox-abcdef012345.sbx.test"),
        );
        headers.insert("connection", HeaderValue::from_static("Upgrade"));
        headers.insert("upgrade", HeaderValue::from_static("websocket"));
        headers.append("cookie", HeaderValue::from_static("a=1"));
        headers.append("cookie", HeaderValue::from_static("b=2"));
        let envelope = wrap_envelope(&Method::GET, "/system/terminal?x=1", &headers).unwrap();
        let head = unwrap_envelope(&envelope).unwrap();
        assert_eq!(head.method(), Method::GET);
        assert_eq!(head.uri(), "/system/terminal?x=1");
        assert_eq!(head.headers(), &headers);
    }

    #[test]
    fn a_header_outside_the_prefix_is_not_part_of_the_head() {
        let mut envelope = HeaderMap::new();
        envelope.insert("x-ingress-path", HeaderValue::from_static("/events"));
        envelope.insert("x-intentic-hop", HeaderValue::from_static("1"));
        let head = unwrap_envelope(&envelope).unwrap();
        assert_eq!(head.method(), Method::GET);
        assert!(head.headers().is_empty());
    }
}
