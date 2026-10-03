//! THE ACCOUNT, FROM A LOCAL WINDOW: the platform calls a local window's account menu and Settings make, carried by the
//! app with the session the workspace signed in with.
//!
//! A local window cannot hold that session itself. Its page is `tauri.localhost`, the session cookie is the
//! platform's (`__Secure-better-auth.session_token`, HttpOnly, SameSite=Lax, host-only on the API's host), and the
//! platform's CORS answers the workspace's origin alone. But every window of this app shares one browser profile (the
//! same browser args, no data directory of its own, windows.rs), so the cookie the workspace's sign-in set is in the
//! store a local window's webview reads. This module reads it there, sends the call itself, and writes back whatever
//! cookie the answer sets, so the session rolls forward and a sign-out ends it for the workspace too.
//!
//! What may be asked is a short list ([`ROUTES`]), checked here and not in the page: the account (who, rename, avatar,
//! sign out), the plan and its checkout, API tokens, and the data export. Deleting the account is not on it: that has
//! to take this account's access off every sandbox's daemon first, and a local window knows only its own folder, so
//! the page sends that one to the workspace. The cookie never reaches the page.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::webview::cookie::Cookie;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::state::AppState;

/// Every call a local window may have the app make, as method and path. The page's own copy is
/// `local/platform.ts` (desktop-app) and `localHost.ts` (web); this one decides.
const ROUTES: &[(Method, &str)] = &[
    (Method::Get, "/api/auth/get-session"),
    (Method::Post, "/api/auth/update-user"),
    (Method::Post, SIGN_OUT),
    (Method::Get, "/rpc/hosted-plan"),
    (Method::Post, "/rpc/hosted-plan/slots"),
    (Method::Post, "/rpc/hosted-plan/tier"),
    (Method::Post, "/rpc/hosted-plan/checkout"),
    (Method::Post, "/rpc/hosted-plan/portal"),
    (Method::Get, "/rpc/tokens"),
    (Method::Post, "/rpc/tokens/create"),
    (Method::Post, "/rpc/tokens/revoke"),
    (Method::Get, "/rpc/me/export"),
];

const GET_SESSION: &str = "/api/auth/get-session";
const SIGN_OUT: &str = "/api/auth/sign-out";

/// The session cookie's name, under either prefix: `__Secure-` over https, none on a plain-http dev platform.
const SESSION_COOKIE: &str = "better-auth.session_token";

/// The largest body a page may send: a profile picture rides `update-user` as a data URL, which the platform caps far
/// below this.
const BODY_MAX: usize = 8 * 1024 * 1024;

/// Who is signed in is asked as the menu opens, so it gives up sooner than a checkout or an export does.
const SESSION_WAIT: Duration = Duration::from_secs(8);
const CALL_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Method {
    Get,
    Post,
}

/// What the page asks: a method, a path on the platform (with a query on a GET), and a JSON body on a POST.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayAsk {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<String>,
}

/// The platform's answer as the page's fetch should see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayAnswer {
    pub status: u16,
    pub body: String,
    pub content_type: Option<String>,
}

/// The ask, checked against [`ROUTES`]: its method, and its path exactly as it will be sent. A query rides only on a
/// GET and only in characters a query needs, so nothing in it can name another host, path or fragment.
fn checked(ask: &RelayAsk) -> Result<(Method, String), String> {
    let method = match ask.method.as_str() {
        "GET" => Method::Get,
        "POST" => Method::Post,
        _ => return Err(refused(&ask.path)),
    };
    let (route, query) = match ask.path.split_once('?') {
        Some((route, query)) => (route, Some(query)),
        None => (ask.path.as_str(), None),
    };
    if !ROUTES.contains(&(method, route)) {
        return Err(refused(&ask.path));
    }
    if let Some(query) = query {
        let plain = query
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~%&=+".contains(c));
        if method != Method::Get || !plain {
            return Err(refused(&ask.path));
        }
    }
    match (&ask.body, method) {
        (Some(_), Method::Get) => return Err(refused(&ask.path)),
        (Some(body), Method::Post) if body.len() > BODY_MAX => {
            return Err("That is too large to send.".to_string());
        }
        _ => {}
    }
    Ok((method, ask.path.clone()))
}

fn refused(path: &str) -> String {
    format!("A local window can't ask the platform for {path}.")
}

fn is_session(cookie: &Cookie<'_>) -> bool {
    cookie.name().ends_with(SESSION_COOKIE) && !cookie.value().is_empty()
}

/// The `Cookie` header a browser would send the platform, from the cookies the store holds for it; none without a
/// session among them, since nothing on the list answers anyone else.
fn cookie_header(cookies: &[Cookie<'_>]) -> Option<String> {
    if !cookies.iter().any(is_session) {
        return None;
    }
    let pairs: Vec<String> = cookies
        .iter()
        .filter(|cookie| !cookie.name().is_empty())
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect();
    Some(pairs.join("; "))
}

/// The answer with no session to send: nobody signed in, as the platform itself says it to a browser without one.
fn signed_out(path: &str) -> RelayAnswer {
    let json = Some("application/json".to_string());
    if path.split('?').next() == Some(GET_SESSION) {
        return RelayAnswer {
            status: 200,
            body: "null".to_string(),
            content_type: json,
        };
    }
    RelayAnswer {
        status: 401,
        body: r#"{"message":"Not signed in."}"#.to_string(),
        content_type: json,
    }
}

/// What one `Set-Cookie` of an answer does to the store.
#[derive(Debug, Clone, PartialEq)]
enum CookieChange {
    Write(Cookie<'static>),
    Delete(Cookie<'static>),
}

/// A `Set-Cookie` the platform answered with, as the store needs it: one for another site is dropped, as a browser
/// drops it; one with no domain is the platform's host's alone, which the store spells as the bare host (a leading dot
/// would widen it to every subdomain); an empty value, a non-positive Max-Age or an expiry already past deletes.
fn cookie_change(header: &str, host: &str, now_unix: i64) -> Option<CookieChange> {
    let mut cookie = Cookie::parse(header.to_string()).ok()?;
    match cookie.domain() {
        Some(domain) => {
            let domain = domain.trim_start_matches('.').to_ascii_lowercase();
            if host != domain && !host.ends_with(&format!(".{domain}")) {
                return None;
            }
        }
        None => cookie.set_domain(host.to_string()),
    }
    if cookie.path().is_none() {
        cookie.set_path("/");
    }
    let expired = cookie.value().is_empty()
        || cookie
            .max_age()
            .is_some_and(|age| age.is_zero() || age.is_negative())
        || cookie
            .expires_datetime()
            .is_some_and(|at| at.unix_timestamp() <= now_unix);
    let cookie = cookie.into_owned();
    Some(if expired {
        CookieChange::Delete(cookie)
    } else {
        CookieChange::Write(cookie)
    })
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0)
}

/// The store's cookies for the platform. Off the async runtime's threads: the webview answers on the main thread,
/// and on Windows a cookie read from anywhere that holds that thread never returns (wry#583).
async fn cookies_for(
    window: &WebviewWindow,
    url: url::Url,
) -> Result<Vec<Cookie<'static>>, String> {
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(url))
        .await
        .map_err(|error| format!("the session could not be read: {error}"))?
        .map_err(|error| format!("the session could not be read: {error}"))
}

/// Writes or deletes each cookie in the store, as the webview would have on receiving the answer itself. A cookie the
/// store refuses costs only the session's roll, which the workspace's own next call makes, so it is logged and passed.
async fn apply(window: &WebviewWindow, changes: Vec<CookieChange>) {
    if changes.is_empty() {
        return;
    }
    let window = window.clone();
    let applied = tauri::async_runtime::spawn_blocking(move || {
        for change in changes {
            let result = match change {
                CookieChange::Write(cookie) => window.set_cookie(cookie),
                CookieChange::Delete(cookie) => window.delete_cookie(cookie),
            };
            if let Err(error) = result {
                eprintln!("intentic: a platform cookie could not be stored: {error}");
            }
        }
    })
    .await;
    if let Err(error) = applied {
        eprintln!("intentic: the platform's cookies were not stored: {error}");
    }
}

/// The origin the platform trusts a state-changing auth call from (Better Auth's origin check): the workspace's own.
fn origin_of(app_url: &str) -> String {
    url::Url::parse(app_url)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| app_url.trim_end_matches('/').to_string())
}

struct Sent {
    answer: RelayAnswer,
    set_cookies: Vec<String>,
}

async fn send(
    method: Method,
    url: &str,
    cookie: &str,
    origin: &str,
    body: Option<String>,
    wait: Duration,
) -> Result<Sent, String> {
    // The updater's TLS stack, set up the way it sets it up: reqwest is built here without a crypto provider of its
    // own, so the first of the two to run installs ring, and the other finds it there.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .timeout(wait)
        .user_agent(format!("intentic-desktop/{}", crate::commands::VERSION))
        .build()
        .map_err(|error| format!("the platform could not be called: {error}"))?;
    let mut request = match method {
        Method::Get => client.get(url),
        Method::Post => client.post(url),
    }
    .header(reqwest::header::COOKIE, cookie)
    .header(reqwest::header::ORIGIN, origin)
    .header(reqwest::header::ACCEPT, "application/json");
    if let Some(body) = body {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    let response = request.send().await.map_err(|error| {
        eprintln!("intentic: the platform did not answer {url}: {error}");
        "The platform could not be reached. Check your connection and try again.".to_string()
    })?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let set_cookies = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect();
    let body = response
        .text()
        .await
        .map_err(|error| format!("the platform's answer could not be read: {error}"))?;
    Ok(Sent {
        answer: RelayAnswer {
            status,
            body,
            content_type,
        },
        set_cookies,
    })
}

/// After a sign-out the platform has agreed to: no session in the store whatever the answer's cookies said, no
/// account or sandboxes for the local windows to list, and a workspace window that finds out now rather than at its
/// next call.
async fn signed_off(app: &AppHandle, window: &WebviewWindow, held: Vec<Cookie<'static>>) {
    let leftovers = held
        .into_iter()
        .filter(|cookie| cookie.name().contains("better-auth"))
        .map(CookieChange::Delete)
        .collect();
    apply(window, leftovers).await;
    app.state::<AppState>()
        .remember_roster(crate::setup_link::Roster::default());
    if let Some(workspace) = app.get_webview_window(crate::windows::WORKSPACE) {
        if let Err(error) = workspace.eval("location.reload()") {
            eprintln!("intentic: the workspace could not be told of the sign-out: {error}");
        }
    }
}

/// One platform call for a local window's account menu or Settings, with the workspace's session.
#[tauri::command]
pub async fn account_relay(
    app: AppHandle,
    window: WebviewWindow,
    ask: RelayAsk,
) -> Result<RelayAnswer, String> {
    let (method, path) = checked(&ask)?;
    let (platform, app_url) = {
        let state = app.state::<AppState>();
        (state.platform_url(), state.app_url())
    };
    let base = url::Url::parse(&platform)
        .map_err(|error| format!("the platform's address is not one: {platform} ({error})"))?;
    let host = base.host_str().unwrap_or_default().to_ascii_lowercase();
    let held = cookies_for(&window, base).await?;
    let Some(cookie) = cookie_header(&held) else {
        return Ok(signed_out(&path));
    };
    let url = format!("{}{path}", platform.trim_end_matches('/'));
    let wait = if path.starts_with(GET_SESSION) {
        SESSION_WAIT
    } else {
        CALL_WAIT
    };
    let sent = send(method, &url, &cookie, &origin_of(&app_url), ask.body, wait).await?;
    let now = now_unix();
    let changes = sent
        .set_cookies
        .iter()
        .filter_map(|header| cookie_change(header, &host, now))
        .collect();
    apply(&window, changes).await;
    if path == SIGN_OUT && (200..300).contains(&sent.answer.status) {
        signed_off(&app, &window, held).await;
    }
    Ok(sent.answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(method: &str, path: &str, body: Option<&str>) -> RelayAsk {
        RelayAsk {
            method: method.into(),
            path: path.into(),
            body: body.map(str::to_string),
        }
    }

    const HOST: &str = "api.intentic.dev";
    const NOW: i64 = 1_790_000_000;

    #[test]
    fn only_the_listed_calls_are_carried_each_by_its_own_method() {
        assert_eq!(
            checked(&ask("GET", "/api/auth/get-session", None)),
            Ok((Method::Get, "/api/auth/get-session".into()))
        );
        assert_eq!(
            checked(&ask("POST", "/rpc/tokens/create", Some("{}"))),
            Ok((Method::Post, "/rpc/tokens/create".into()))
        );
        assert_eq!(
            checked(&ask("GET", "/rpc/me/export?x=1&y=a%20b", None)),
            Ok((Method::Get, "/rpc/me/export?x=1&y=a%20b".into()))
        );
        for (method, path) in [
            ("POST", "/api/auth/delete-user"),
            ("GET", "/rpc/sandbox/list"),
            ("POST", "/api/auth/get-session"),
            ("GET", "/api/auth/sign-out"),
            ("DELETE", "/rpc/tokens"),
            ("GET", "/rpc/tokens/"),
            ("GET", "//evil.example/rpc/tokens"),
            ("GET", "https://evil.example/rpc/tokens"),
            ("GET", "/rpc/../rpc/tokens"),
        ] {
            assert_eq!(
                checked(&ask(method, path, None)),
                Err(refused(path)),
                "{method} {path}"
            );
        }
    }

    #[test]
    fn a_query_is_a_gets_and_cannot_reach_past_its_route() {
        for path in [
            "/rpc/tokens?a=b#frag",
            "/rpc/tokens?a=b/../x",
            "/rpc/tokens?@evil.example",
            "/rpc/tokens?a b",
        ] {
            assert_eq!(checked(&ask("GET", path, None)), Err(refused(path)));
        }
        assert_eq!(
            checked(&ask("POST", "/rpc/tokens/create?a=b", Some("{}"))),
            Err(refused("/rpc/tokens/create?a=b"))
        );
        assert_eq!(
            checked(&ask("GET", "/rpc/tokens", Some("{}"))),
            Err(refused("/rpc/tokens"))
        );
        let large = "x".repeat(BODY_MAX + 1);
        assert_eq!(
            checked(&ask("POST", "/api/auth/update-user", Some(&large))),
            Err("That is too large to send.".to_string())
        );
    }

    #[test]
    fn the_header_carries_every_cookie_but_only_with_a_session_among_them() {
        let session = Cookie::new("__Secure-better-auth.session_token", "abc.def");
        let other = Cookie::new("ph_flag", "1");
        assert_eq!(cookie_header(std::slice::from_ref(&other)), None);
        assert_eq!(
            cookie_header(&[Cookie::new("__Secure-better-auth.session_token", "")]),
            None
        );
        assert_eq!(
            cookie_header(&[other, session]),
            Some("ph_flag=1; __Secure-better-auth.session_token=abc.def".into())
        );
        assert_eq!(
            cookie_header(&[Cookie::new("better-auth.session_token", "dev")]),
            Some("better-auth.session_token=dev".into())
        );
    }

    #[test]
    fn with_no_session_nobody_is_signed_in_and_nothing_else_answers() {
        assert_eq!(
            signed_out("/api/auth/get-session"),
            RelayAnswer {
                status: 200,
                body: "null".into(),
                content_type: Some("application/json".into())
            }
        );
        assert_eq!(signed_out("/rpc/hosted-plan").status, 401);
    }

    #[test]
    fn a_cookie_with_no_domain_stays_the_platform_hosts_alone() {
        let Some(CookieChange::Write(cookie)) = cookie_change(
            "__Secure-better-auth.session_token=new; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax",
            HOST,
            NOW,
        ) else {
            panic!("a fresh session cookie is written");
        };
        assert_eq!(cookie.domain(), Some(HOST));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.value(), "new");
        assert_eq!(cookie.http_only(), Some(true));
    }

    #[test]
    fn a_cleared_or_expired_cookie_is_deleted() {
        for header in [
            "__Secure-better-auth.session_token=; Path=/; Max-Age=0",
            "__Secure-better-auth.session_token=gone; Path=/; Max-Age=0",
            "__Secure-better-auth.session_token=old; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        ] {
            assert!(
                matches!(
                    cookie_change(header, HOST, NOW),
                    Some(CookieChange::Delete(_))
                ),
                "{header}"
            );
        }
    }

    #[test]
    fn a_cookie_for_another_site_is_dropped_and_one_for_a_parent_kept() {
        assert_eq!(cookie_change("a=1; Domain=evil.example", HOST, NOW), None);
        assert_eq!(
            cookie_change("a=1; Domain=notintentic.dev", HOST, NOW),
            None
        );
        let Some(CookieChange::Write(cookie)) =
            cookie_change("a=1; Domain=.intentic.dev", HOST, NOW)
        else {
            panic!("the platform's parent domain is its own");
        };
        assert_eq!(cookie.domain(), Some("intentic.dev"));
        assert_eq!(cookie_change("not a cookie", HOST, NOW), None);
    }

    #[test]
    fn the_origin_is_the_workspaces() {
        assert_eq!(
            origin_of("https://app.intentic.dev/"),
            "https://app.intentic.dev"
        );
        assert_eq!(
            origin_of("http://localhost:5173/x"),
            "http://localhost:5173"
        );
    }
}
