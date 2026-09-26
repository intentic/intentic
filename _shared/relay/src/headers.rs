//! What a request or an answer keeps as it crosses a hop, and the three facts every hop reads off one: whether it is an
//! upgrade, which host it names, and that host's leftmost label.

use http::header::{self, HeaderMap, HeaderName, HeaderValue};
use http::{Request, Version};

/// Connection management, which never crosses a hop (RFC 9110 §7.6.1, and h2c's `http2-settings`), and which h2 and h3
/// refuse to carry at all. `host` is not among them: it names the request's target end to end, and a hop that carries
/// it as `:authority` drops it itself.
pub const HOP_BY_HOP: [&str; 10] = [
    "connection",
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

/// Whether a request asks to leave HTTP: an h1 `Upgrade` its `Connection` names.
pub fn is_upgrade(headers: &HeaderMap, version: Version) -> bool {
    version <= Version::HTTP_11
        && headers.contains_key(header::UPGRADE)
        && names(headers, "upgrade")
}

/// Drops every hop-by-hop header and every header the `Connection` header names, as RFC 9110 asks of a proxy.
pub fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|token| HeaderName::from_bytes(token.trim().as_bytes()).ok())
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
}

/// The headers a request crosses to its next hop with: hop-by-hop ones gone, and an upgrade's own two restated, since an
/// upgrade asks the next hop for exactly what they say.
pub fn for_next_hop(headers: &mut HeaderMap, upgrade: bool) {
    let protocol = upgrade
        .then(|| headers.get(header::UPGRADE).cloned())
        .flatten();
    strip_hop_by_hop(headers);
    if let Some(protocol) = protocol {
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(header::UPGRADE, protocol);
    }
}

/// The host a request names. The target's own authority wins over a Host header: an h2 or h3 request carries it as
/// `:authority`, and an h1 request in absolute form MUST be routed by it whatever its Host says (RFC 9112 §3.2.2). Only
/// an origin-form h1 request, which has no authority, is routed by its Host.
pub fn host_of<B>(request: &Request<B>) -> String {
    request
        .uri()
        .authority()
        .map(|authority| authority.as_str().to_owned())
        .or_else(|| {
            request
                .headers()
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

/// The leftmost DNS label of a host, port stripped; empty when there is none.
pub fn label_of(host: &str) -> &str {
    host.split(':')
        .next()
        .unwrap_or("")
        .split('.')
        .next()
        .unwrap_or("")
}

// Whether any Connection token is `token`.
fn names(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|named| named.trim().eq_ignore_ascii_case(token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(uri: &str, host: Option<&str>) -> Request<()> {
        let mut request = Request::builder().uri(uri);
        if let Some(host) = host {
            request = request.header(header::HOST, host);
        }
        request.body(()).unwrap()
    }

    #[test]
    fn the_authority_wins_over_a_host_header_and_origin_form_reads_the_host() {
        assert_eq!(
            host_of(&request(
                "https://sandbox-abcdef012345.sbx.test/x",
                Some("sandbox-0123456789ab.sbx.test")
            )),
            "sandbox-abcdef012345.sbx.test"
        );
        assert_eq!(
            host_of(&request(
                "/x",
                Some("preview-web-abcdef012345.sbx.test:443")
            )),
            "preview-web-abcdef012345.sbx.test:443"
        );
        assert_eq!(host_of(&request("/x", None)), "");
    }

    #[test]
    fn an_upgrade_is_an_h1_upgrade_its_connection_names() {
        let mut headers = HeaderMap::new();
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, Upgrade"),
        );
        assert!(is_upgrade(&headers, Version::HTTP_11));
        assert!(!is_upgrade(&headers, Version::HTTP_2));
        headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        assert!(!is_upgrade(&headers, Version::HTTP_11));
    }

    #[test]
    fn hop_by_hop_headers_and_the_ones_connection_names_are_dropped_and_host_is_kept() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, x-private"),
        );
        headers.insert("x-private", HeaderValue::from_static("1"));
        headers.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        headers.insert(
            "http2-settings",
            HeaderValue::from_static("AAMAAABkAAQAoAAAAAIAAAAA"),
        );
        headers.insert(
            header::TRANSFER_ENCODING,
            HeaderValue::from_static("chunked"),
        );
        headers.insert(
            header::HOST,
            HeaderValue::from_static("sandbox-abcdef012345.sbx.test"),
        );
        headers.append("set-cookie", HeaderValue::from_static("a=1"));
        headers.append("set-cookie", HeaderValue::from_static("b=2"));
        strip_hop_by_hop(&mut headers);
        let mut kept: Vec<&str> = headers.keys().map(HeaderName::as_str).collect();
        kept.sort_unstable();
        assert_eq!(kept, ["host", "set-cookie"]);
        assert_eq!(headers.get_all("set-cookie").iter().count(), 2);
    }

    #[test]
    fn an_upgrade_crosses_with_its_own_two_headers_restated() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONNECTION,
            HeaderValue::from_static("Upgrade, x-private"),
        );
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert("x-private", HeaderValue::from_static("1"));
        headers.insert(
            header::SEC_WEBSOCKET_KEY,
            HeaderValue::from_static("dGhlIHNhbXBsZSBub25jZQ=="),
        );
        let mut plain = headers.clone();
        for_next_hop(&mut headers, true);
        assert_eq!(headers[header::CONNECTION], "upgrade");
        assert_eq!(headers[header::UPGRADE], "websocket");
        assert!(headers.contains_key(header::SEC_WEBSOCKET_KEY));
        assert!(!headers.contains_key("x-private"));
        for_next_hop(&mut plain, false);
        assert!(!plain.contains_key(header::UPGRADE));
    }

    #[test]
    fn a_label_is_the_leftmost_name_without_its_port() {
        assert_eq!(
            label_of("sandbox-abcdef012345.sbx.test:443"),
            "sandbox-abcdef012345"
        );
        assert_eq!(label_of("localhost:8080"), "localhost");
        assert_eq!(label_of(""), "");
    }
}
