//! The owner's guard on preview hosts (2026-10-27): whether a request to a host it covers may reach its upstream. The
//! policy is Node's, pushed in the listen config (`PreviewGuard`): which hosts need a pass, the key a pass is signed
//! under and the cookie it rides in. netd only checks it, on every request and without asking Node: a pass is an expiry
//! and an HMAC over it, so checking one costs a hash, and Node ends every pass at once by replacing the key.

use std::time::{SystemTime, UNIX_EPOCH};

use http::header::{self, HeaderMap, HeaderValue};
use http::{Method, Response, StatusCode};
use netd_wire::PreviewGuard;
use relay::body::{self, Body};

use crate::route;

/// What the guard makes of one request to a host it covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// A pass that verifies, the probe, or a CORS preflight: relayed as it would be without a guard.
    Open,
    /// The pass's exchange: handed back for Node to turn into a cookie.
    Exchange,
    /// A navigation with no pass: handed back for Node's page, which says how to get one.
    SignIn,
    /// Anything else with no pass (a fetch, an asset, a WebSocket): answered 401 here.
    Refused,
}

// The one format a pass has; another prefix is another format this build does not know, and fails.
const VERSION: &str = "v1";

// What a refused request reads. A fetch or a socket has no page to show, so this is what its network panel says.
const REFUSED: &str = "this address is open to the sandbox's members only: open it from Intentic, which signs this browser in to it, then reload";

// RFC 9110 has a 401 name its scheme; no browser prompts for one it does not know, so this never raises a login dialog.
const CHALLENGE: &str = "IntenticPreviewPass realm=\"preview\"";

/// Whether the guard covers this host: a panel's preview or a forwarded port, as the owner chose. The outbox
/// (`public-`) and every other name are never covered.
pub fn covers(guard: &PreviewGuard, host: &str, sandbox_id: Option<&str>) -> bool {
    (guard.panels && route::panel_from_host(host, sandbox_id).is_some())
        || (guard.ports && route::port_slot_from_host(host, sandbox_id).is_some())
}

/// The verdict on one request to a covered host. Every copy of the pass's cookie is taken off the request whatever the
/// verdict, so the upstream never sees one, and the app's own cookies ride on untouched.
pub fn judge(
    guard: &PreviewGuard,
    probe_path: &str,
    method: &Method,
    path: &str,
    headers: &mut HeaderMap,
    now: u64,
) -> Verdict {
    let passed = take_pass(guard, headers, now);
    // The probe carries no content and the editor reads it from another origin with no credentials.
    if path == probe_path {
        return Verdict::Open;
    }
    // GET alone: a HEAD (a link checker's) must not spend the one-time ticket the link carries.
    if path == guard.pass_path && method == Method::GET {
        return Verdict::Exchange;
    }
    if passed {
        return Verdict::Open;
    }
    // A preflight never carries credentials (Fetch, CORS-preflight fetch), so the app's own CORS answers it.
    if is_preflight(method, headers) {
        return Verdict::Open;
    }
    if is_navigation(method, headers) {
        return Verdict::SignIn;
    }
    Verdict::Refused
}

/// Seconds since the epoch, the clock a pass's expiry is read against.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// The 401 netd answers a covered host's request with when it carries no pass and is no navigation. A fetch from
/// another origin may read it, so the app's console says why rather than reporting a bare CORS failure; the body is
/// this one sentence and nothing of the sandbox's.
pub fn refused(headers: &HeaderMap) -> Response<Body> {
    let mut response = Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::WWW_AUTHENTICATE, CHALLENGE)
        .body(body::full(REFUSED.to_owned()))
        .expect("a static response always builds");
    if let Some(origin) = headers.get(header::ORIGIN) {
        let answer = response.headers_mut();
        answer.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
        answer.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        answer.insert(header::VARY, HeaderValue::from_static("origin"));
    }
    response
}

/// Takes every `Set-Cookie` naming the pass's cookie off an upstream's answer: the app on a covered host may not
/// replace the pass it was reached with.
pub fn keep_pass(headers: &mut HeaderMap, cookie: &str) {
    let set: Vec<HeaderValue> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .cloned()
        .collect();
    if !set.iter().any(|value| names(value.as_bytes(), cookie)) {
        return;
    }
    headers.remove(header::SET_COOKIE);
    for value in set {
        if !names(value.as_bytes(), cookie) {
            headers.append(header::SET_COOKIE, value);
        }
    }
}

fn names(set_cookie: &[u8], cookie: &str) -> bool {
    let pair = set_cookie
        .split(|byte| *byte == b';')
        .next()
        .unwrap_or_default();
    let name = pair.split(|byte| *byte == b'=').next().unwrap_or_default();
    trim(name) == cookie.as_bytes()
}

// Whether the request carries a pass that verifies now. Copies of the cookie are removed and the rest of the `Cookie`
// header is written back as one; a request carrying none is left exactly as it came.
fn take_pass(guard: &PreviewGuard, headers: &mut HeaderMap, now: u64) -> bool {
    let mut passed = false;
    let mut found = false;
    let mut kept: Vec<Vec<u8>> = Vec::new();
    for value in headers.get_all(header::COOKIE) {
        for pair in value.as_bytes().split(|byte| *byte == b';') {
            let pair = trim(pair);
            if pair.is_empty() {
                continue;
            }
            let (name, value) = match pair.iter().position(|byte| *byte == b'=') {
                Some(at) => (trim(&pair[..at]), trim(&pair[at + 1..])),
                None => (pair, &b""[..]),
            };
            if name == guard.cookie.as_bytes() {
                found = true;
                passed |= verifies(guard.key.as_bytes(), value, now);
            } else {
                kept.push(pair.to_vec());
            }
        }
    }
    if found {
        headers.remove(header::COOKIE);
        if let Ok(value) = HeaderValue::from_bytes(&kept.join(&b"; "[..]))
            && !kept.is_empty()
        {
            headers.insert(header::COOKIE, value);
        }
    }
    passed
}

// `v1.<expiry>.<signature>`, unexpired, signed under the key.
fn verifies(key: &[u8], value: &[u8], now: u64) -> bool {
    let Ok(value) = std::str::from_utf8(value) else {
        return false;
    };
    // RFC 6265 lets a cookie's value arrive wrapped in quotes.
    let value = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(value);
    let Some((signed, signature)) = value.rsplit_once('.') else {
        return false;
    };
    let Some(expiry) = signed
        .strip_prefix(VERSION)
        .and_then(|rest| rest.strip_prefix('.'))
    else {
        return false;
    };
    if expiry.is_empty() || !expiry.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(expiry) = expiry.parse::<u64>() else {
        return false;
    };
    expiry > now && same(sign(key, signed).as_bytes(), signature.as_bytes())
}

/// The signature over `message` under `key`: HMAC-SHA256, unpadded base64url, as the daemon writes it.
pub fn sign(key: &[u8], message: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    base64url(ring::hmac::sign(&key, message.as_bytes()).as_ref())
}

fn is_preflight(method: &Method, headers: &HeaderMap) -> bool {
    method == Method::OPTIONS
        && headers.contains_key(header::ORIGIN)
        && headers.contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
}

// A document load, which has a page to show: what Fetch Metadata says, or for a client that sends none, a GET that
// asks for HTML.
fn is_navigation(method: &Method, headers: &HeaderMap) -> bool {
    if method != Method::GET && method != Method::HEAD {
        return false;
    }
    match headers.get("sec-fetch-mode") {
        Some(mode) => mode.as_bytes() == b"navigate",
        None => headers.get(header::ACCEPT).is_some_and(|accept| {
            accept
                .to_str()
                .is_ok_and(|accept| accept.contains("text/html"))
        }),
    }
}

fn trim(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(start, |at| at + 1);
    &bytes[start..end]
}

// Compared in full whatever matches first, so the time taken says nothing of how much of a forged signature was right.
fn same(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |differ, (a, b)| differ | (a ^ b))
            == 0
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let at = |index: usize| u32::from(chunk.get(index).copied().unwrap_or(0));
        let group = (at(0) << 16) | (at(1) << 8) | at(2);
        for sextet in 0..=chunk.len() {
            out.push(char::from(
                ALPHABET[((group >> (18 - 6 * sextet)) & 63) as usize],
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    const ID: Option<&str> = Some("abcdef012345");
    const NOW: u64 = 1_800_000_000;

    fn guard(panels: bool, ports: bool) -> PreviewGuard {
        PreviewGuard {
            panels,
            ports,
            cookie: "__Host-intentic-preview-pass".into(),
            key: "the-key".into(),
            pass_path: "/__intentic/preview-pass".into(),
        }
    }

    fn pass(key: &str, expiry: u64) -> String {
        let signed = format!("v1.{expiry}");
        format!("{signed}.{}", sign(key.as_bytes(), &signed))
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(
                http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        headers
    }

    fn judged(method: Method, path: &str, headers: &mut HeaderMap) -> Verdict {
        judge(
            &guard(true, true),
            "/__intentic/preview-probe",
            &method,
            path,
            headers,
            NOW,
        )
    }

    #[test]
    fn the_signature_is_unpadded_base64url_hmac_sha256() {
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"the-key");
        let tag = ring::hmac::sign(&key, b"v1.1800000600");
        assert_eq!(
            sign(b"the-key", "v1.1800000600"),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(tag.as_ref())
        );
        for length in 0..8 {
            let bytes: Vec<u8> = (0..length)
                .map(|byte: u8| byte.wrapping_mul(37).wrapping_add(250))
                .collect();
            assert_eq!(
                base64url(&bytes),
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes)
            );
        }
        // The daemon's own test (_sandbox/sandbox auth/previews/preview-guard.integration.test.ts) signs the same pass to the same value.
        assert_eq!(
            pass("the-key", 1_800_000_600),
            "v1.1800000600.zbHcT57NxCUGoNelaFg8Dixw68sRHEsWoNaSeobR2AI"
        );
    }

    #[test]
    fn only_the_hosts_the_owner_chose_are_covered() {
        let panel = "preview-web-abcdef012345.sbx.example.test";
        let port = "port-s4lt-abcdef012345.sbx.example.test";
        let outbox = "public-s4lt-abcdef012345.sbx.example.test";
        assert!(covers(&guard(true, false), panel, ID));
        assert!(!covers(&guard(true, false), port, ID));
        assert!(covers(&guard(true, true), port, ID));
        assert!(!covers(&guard(true, true), outbox, ID));
        assert!(!covers(&guard(true, true), "stray.sbx.example.test", ID));
        // Another sandbox's name is not this one's to guard; the route refuses it anyway.
        assert!(!covers(
            &guard(true, true),
            "preview-web-0123456789ab.sbx.example.test",
            ID
        ));
    }

    #[test]
    fn a_pass_that_verifies_opens_the_host_and_never_reaches_the_upstream() {
        let mut sent = headers(&[(
            "cookie",
            &format!(
                "theme=dark; __Host-intentic-preview-pass={}; sid=app-session",
                pass("the-key", NOW + 60)
            ),
        )]);
        assert_eq!(judged(Method::POST, "/api/save", &mut sent), Verdict::Open);
        assert_eq!(sent.get_all(header::COOKIE).iter().count(), 1);
        assert_eq!(sent[header::COOKIE], "theme=dark; sid=app-session");
    }

    #[test]
    fn a_pass_split_across_cookie_headers_is_found_and_the_rest_kept() {
        let mut sent = headers(&[
            ("cookie", "a=1"),
            (
                "cookie",
                &format!(
                    "__Host-intentic-preview-pass=\"{}\"",
                    pass("the-key", NOW + 1)
                ),
            ),
            ("cookie", "b=2"),
        ]);
        assert_eq!(judged(Method::GET, "/", &mut sent), Verdict::Open);
        assert_eq!(sent[header::COOKIE], "a=1; b=2");
        let mut alone = headers(&[(
            "cookie",
            &format!("__Host-intentic-preview-pass={}", pass("the-key", NOW + 1)),
        )]);
        assert_eq!(judged(Method::GET, "/", &mut alone), Verdict::Open);
        assert!(alone.get(header::COOKIE).is_none());
    }

    #[test]
    fn an_expired_forged_or_foreign_pass_opens_nothing_and_is_taken_off_all_the_same() {
        for value in [
            pass("the-key", NOW),
            pass("another-key", NOW + 60),
            format!("v1.{}.{}", NOW + 60, "A".repeat(43)),
            format!("v2.{}", &pass("the-key", NOW + 60)[3..]),
            format!("v1.+{}", &pass("the-key", NOW + 60)[3..]),
            "v1..x".to_owned(),
            String::new(),
        ] {
            let mut sent = headers(&[
                (
                    "cookie",
                    &format!("__Host-intentic-preview-pass={value}; app=1"),
                ),
                ("accept", "application/json"),
            ]);
            assert_eq!(
                judged(Method::GET, "/api", &mut sent),
                Verdict::Refused,
                "{value}"
            );
            assert_eq!(sent[header::COOKIE], "app=1");
        }
    }

    #[test]
    fn without_a_pass_a_navigation_is_shown_a_page_and_anything_else_refused() {
        let navigate = |pairs: &[(&str, &str)]| judged(Method::GET, "/", &mut headers(pairs));
        assert_eq!(
            navigate(&[("sec-fetch-mode", "navigate"), ("sec-fetch-dest", "iframe")]),
            Verdict::SignIn
        );
        assert_eq!(navigate(&[("accept", "text/html,*/*")]), Verdict::SignIn);
        assert_eq!(
            navigate(&[("sec-fetch-mode", "cors"), ("accept", "text/html")]),
            Verdict::Refused
        );
        assert_eq!(
            navigate(&[("sec-fetch-mode", "websocket")]),
            Verdict::Refused
        );
        assert_eq!(
            judged(
                Method::POST,
                "/",
                &mut headers(&[("sec-fetch-mode", "navigate")])
            ),
            Verdict::Refused
        );
        let mut untouched = headers(&[("cookie", "app=1"), ("accept", "*/*")]);
        assert_eq!(
            judged(Method::GET, "/x.js", &mut untouched),
            Verdict::Refused
        );
        assert_eq!(untouched[header::COOKIE], "app=1");
    }

    #[test]
    fn the_probe_a_preflight_and_the_exchange_need_no_pass() {
        assert_eq!(
            judged(
                Method::GET,
                "/__intentic/preview-probe",
                &mut HeaderMap::new()
            ),
            Verdict::Open
        );
        assert_eq!(
            judged(
                Method::OPTIONS,
                "/api",
                &mut headers(&[
                    (
                        "origin",
                        "https://preview-web-abcdef012345.sbx.example.test"
                    ),
                    ("access-control-request-method", "POST"),
                ])
            ),
            Verdict::Open
        );
        // An OPTIONS that is no preflight is any other request.
        assert_eq!(
            judged(Method::OPTIONS, "/api", &mut HeaderMap::new()),
            Verdict::Refused
        );
        assert_eq!(
            judged(
                Method::GET,
                "/__intentic/preview-pass",
                &mut HeaderMap::new()
            ),
            Verdict::Exchange
        );
        assert_eq!(
            judged(
                Method::POST,
                "/__intentic/preview-pass",
                &mut HeaderMap::new()
            ),
            Verdict::Refused
        );
    }

    #[test]
    fn a_refusal_says_why_to_the_origin_that_asked() {
        let answer = refused(&headers(&[("origin", "https://app.example")]));
        assert_eq!(answer.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(answer.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            answer.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://app.example"
        );
        assert_eq!(
            answer.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS],
            "true"
        );
        // No scheme a browser knows, so never a login dialog.
        let challenge = answer.headers()[header::WWW_AUTHENTICATE].to_str().unwrap();
        assert!(!challenge.to_ascii_lowercase().starts_with("basic"));
        assert!(
            refused(&HeaderMap::new())
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none()
        );
    }

    #[test]
    fn an_upstream_cannot_set_the_pass_cookie() {
        let mut answer = headers(&[
            ("set-cookie", "sid=1; Path=/"),
            (
                "set-cookie",
                "__Host-intentic-preview-pass=x; Path=/; Secure",
            ),
            ("set-cookie", "theme=dark"),
        ]);
        keep_pass(&mut answer, "__Host-intentic-preview-pass");
        let kept: Vec<_> = answer
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect();
        assert_eq!(kept, ["sid=1; Path=/", "theme=dark"]);
    }
}
