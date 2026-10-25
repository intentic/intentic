//! Proxy only ROUTES-allowlisted account calls using the shared webview profile's HttpOnly platform cookie; never expose it to the page.
//! Send requests natively and apply response cookies so renewal/sign-out also affects the workspace; local-origin pages cannot call directly.
//! Account deletion goes through the workspace to revoke daemon access. Internal platform_post calls use fixed paths, never page-supplied ones.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::webview::cookie::Cookie;
use tauri::{AppHandle, Manager, Webview};

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
    (Method::Get, "/rpc/sandbox/list"),
    (Method::Post, "/rpc/sandbox/delete"),
    (Method::Post, "/rpc/sandbox/leave"),
    (Method::Get, "/rpc/sandbox/trash"),
    (Method::Post, "/rpc/sandbox/restore"),
    (Method::Post, "/rpc/sandbox/hosted-rollback"),
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
async fn cookies_for(window: &Webview, url: url::Url) -> Result<Vec<Cookie<'static>>, String> {
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(url))
        .await
        .map_err(|error| format!("the session could not be read: {error}"))?
        .map_err(|error| format!("the session could not be read: {error}"))
}

/// Writes or deletes each cookie in the store, as the webview would have on receiving the answer itself. A cookie the
/// store refuses costs only the session's roll, which the workspace's own next call makes, so it is logged and passed.
async fn apply(window: &Webview, changes: Vec<CookieChange>) {
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
async fn signed_off(app: &AppHandle, window: &Webview, held: Vec<Cookie<'static>>) {
    let leftovers = held
        .into_iter()
        .filter(|cookie| cookie.name().contains("better-auth"))
        .map(CookieChange::Delete)
        .collect();
    apply(window, leftovers).await;
    app.state::<AppState>()
        .remember_roster(crate::setup_link::Roster::default());
    crate::local::holders_changed(app);
    crate::folder_setup::account_changed();
    if let Some(workspace) = crate::frame::face(app, crate::windows::WORKSPACE) {
        if let Err(error) = workspace.eval("location.reload()") {
            eprintln!("intentic: the workspace could not be told of the sign-out: {error}");
        }
    }
}

/// One call with the session the store holds, its answer's cookies written back, as the page's own fetch would have; none
/// when the store holds no session, since nothing this app asks answers anyone else.
async fn with_session(
    app: &AppHandle,
    window: &Webview,
    method: Method,
    path: &str,
    body: Option<String>,
) -> Result<Option<(RelayAnswer, Vec<Cookie<'static>>)>, String> {
    let (platform, app_url) = {
        let state = app.state::<AppState>();
        (state.platform_url(), state.app_url())
    };
    let base = url::Url::parse(&platform)
        .map_err(|error| format!("the platform's address is not one: {platform} ({error})"))?;
    let host = base.host_str().unwrap_or_default().to_ascii_lowercase();
    let held = cookies_for(window, base).await?;
    let Some(cookie) = cookie_header(&held) else {
        return Ok(None);
    };
    let url = format!("{}{path}", platform.trim_end_matches('/'));
    let wait = if path.starts_with(GET_SESSION) {
        SESSION_WAIT
    } else {
        CALL_WAIT
    };
    let sent = send(method, &url, &cookie, &origin_of(&app_url), body, wait).await?;
    let now = now_unix();
    let changes = sent
        .set_cookies
        .iter()
        .filter_map(|header| cookie_change(header, &host, now))
        .collect();
    apply(window, changes).await;
    Ok(Some((sent.answer, held)))
}

/// One platform call for a local window's account menu or Settings, with the workspace's session.
#[tauri::command]
pub async fn account_relay(
    app: AppHandle,
    window: Webview,
    ask: RelayAsk,
) -> Result<RelayAnswer, String> {
    let (method, path) = checked(&ask)?;
    // A local window asking who is signed in is the app finding out too, so the folder's dialog and its setup never
    // say otherwise than the account at the window's foot.
    let asks_session = path == GET_SESSION;
    let Some((answer, held)) = with_session(&app, &window, method, &path, ask.body).await? else {
        if asks_session {
            take_session(&app, &Session::Nobody);
        }
        return Ok(signed_out(&path));
    };
    if asks_session {
        take_session(&app, &session_of(answer.status, &answer.body));
    }
    if path == SIGN_OUT && (200..300).contains(&answer.status) {
        signed_off(&app, &window, held).await;
    }
    Ok(answer)
}

/// What a call the app makes for itself came back with: the platform's answer, or nobody signed in to ask with (no
/// session in the store, or one the platform no longer takes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answered {
    SignedOut,
    Json {
        status: u16,
        body: serde_json::Value,
    },
}

/// What a platform answer with `status` and `text` means to the app: a 401 is nobody signed in, whatever the store
/// held; anything else is the platform's JSON, or `null` where it sent none.
fn answered(status: u16, text: &str) -> Answered {
    if status == 401 {
        return Answered::SignedOut;
    }
    Answered::Json {
        status,
        body: serde_json::from_str(text).unwrap_or(serde_json::Value::Null),
    }
}

/// A call the app makes for itself (folder_setup.rs), with the session the workspace signed in with: `path` is the app's own,
/// written where it is called, never one a page names, so it is not held to [`ROUTES`].
pub async fn platform_post(
    app: &AppHandle,
    window: &Webview,
    path: &str,
    body: &serde_json::Value,
) -> Result<Answered, String> {
    let sent = with_session(app, window, Method::Post, path, Some(body.to_string())).await?;
    Ok(match sent {
        None => Answered::SignedOut,
        Some((answer, _)) => answered(answer.status, &answer.body),
    })
}

/// A GET the app makes for itself, with the workspace session (Repair's turn uses POST; this checks sign-in).
pub async fn platform_get(
    app: &AppHandle,
    window: &Webview,
    path: &str,
) -> Result<Answered, String> {
    let sent = with_session(app, window, Method::Get, path, None).await?;
    Ok(match sent {
        None => Answered::SignedOut,
        Some((answer, _)) => answered(answer.status, &answer.body),
    })
}

/* WHO IS SIGNED IN, AS THE PLATFORM SAYS IT (2026-10-21): the one answer every part of the app goes by. The roster's
account (state.rs) used to be only what the workspace's sandbox switcher last announced, and that switcher is drawn
only once the account has a sandbox. So a reader who had just signed in, with no sandbox yet, was signed in to the
local window's own account check and signed out to the folder's dialog, the folder's setup and This computer's card.
The setup asked them to sign in again after every sign-in. Now every session answer the app sees (a local window's
account check, the folder's dialog, a setup waiting on a sign-in) is taken as the account, so all of them agree. */

/// What a session answer says about who is signed in: someone, nobody, or nothing to go by (the platform out of reach,
/// a refusal other than 401, an answer that is not a session).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Session {
    Someone(crate::setup_link::RosterAccount),
    Nobody,
    Unknown,
}

/// Better Auth's answer to `get-session` read as a [`Session`]: `null` or a 401 is nobody, a user with an email is
/// them. A name is kept trimmed and only when there is one; a picture only over https, as the workspace sends it
/// (desktop.ts `rosterAccount`). Pure.
pub fn session_of(status: u16, body: &str) -> Session {
    if status == 401 {
        return Session::Nobody;
    }
    if !(200..300).contains(&status) {
        return Session::Unknown;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Session::Unknown;
    };
    if value.is_null() || (value["user"].is_null() && value["session"].is_null()) {
        return Session::Nobody;
    }
    let user = &value["user"];
    let Some(email) = user["email"]
        .as_str()
        .map(str::trim)
        .filter(|email| !email.is_empty())
    else {
        return Session::Unknown;
    };
    let name = user["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let image = user["image"]
        .as_str()
        .filter(|image| image.starts_with("https://"))
        .map(str::to_string);
    Session::Someone(crate::setup_link::RosterAccount {
        email: email.to_string(),
        name,
        image,
    })
}

/// The roster once `session` is taken as who is signed in. Someone keeps the sandboxes listed when they are the person
/// the roster already named, or when it named nobody (a folder's own sandbox listed the moment it was made, before the
/// workspace said who); a different person starts with none of the last one's. Nobody is an empty roster, as a
/// sign-out leaves it. Unknown changes nothing. Pure.
pub fn roster_with(
    roster: crate::setup_link::Roster,
    session: &Session,
) -> crate::setup_link::Roster {
    match session {
        Session::Unknown => roster,
        Session::Nobody => crate::setup_link::Roster::default(),
        Session::Someone(account) => {
            let same = roster
                .account
                .as_ref()
                .is_none_or(|held| held.email.eq_ignore_ascii_case(&account.email));
            crate::setup_link::Roster {
                account: Some(account.clone()),
                sandboxes: if same { roster.sandboxes } else { Vec::new() },
            }
        }
    }
}

/// `session` taken as the app's answer to who is signed in: the roster written, and on a change every window told
/// (`desktop://roster`, as the workspace's own roster is told) and every folder waiting on a sign-in looked at again.
pub fn take_session(app: &AppHandle, session: &Session) {
    let state = app.state::<AppState>();
    let before = state.roster();
    let after = roster_with(before.clone(), session);
    if after == before {
        return;
    }
    state.remember_roster(after.clone());
    let _ = tauri::Emitter::emit(app, "desktop://roster", &after);
    crate::shell::roster_changed(app);
    crate::local::holders_changed(app);
    crate::folder_setup::account_changed();
}

/// Who is signed in, asked of the platform now with the session the store holds, and taken as the app's answer. No
/// session in the store is nobody, as the platform would say it; the platform out of reach is unknown and changes
/// nothing.
pub async fn learn_account(app: &AppHandle, window: &Webview) -> Session {
    let session = match with_session(app, window, Method::Get, GET_SESSION, None).await {
        Ok(None) => Session::Nobody,
        Ok(Some((answer, _))) => session_of(answer.status, &answer.body),
        Err(error) => {
            eprintln!("intentic: who is signed in could not be asked: {error}");
            Session::Unknown
        }
    };
    take_session(app, &session);
    session
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
        // The switcher's own calls, so a local window lists and removes the account's sandboxes as the workspace does.
        assert_eq!(
            checked(&ask("GET", "/rpc/sandbox/list", None)),
            Ok((Method::Get, "/rpc/sandbox/list".into()))
        );
        assert_eq!(
            checked(&ask("POST", "/rpc/sandbox/delete", Some("{}"))),
            Ok((Method::Post, "/rpc/sandbox/delete".into()))
        );
        for (method, path) in [
            ("POST", "/api/auth/delete-user"),
            ("POST", "/rpc/sandbox/list"),
            ("GET", "/rpc/sandbox/delete"),
            ("POST", "/rpc/sandbox/create"),
            ("POST", "/rpc/sandbox/owner-ticket"),
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

    /// A sandbox a folder's window asks for is made with fixed paths the app writes, never a page's: a page still cannot
    /// name them through the relay. Removing one is the page's (its switcher's remove, as the workspace's), so it is not here.
    #[test]
    fn the_calls_the_app_makes_for_itself_are_not_a_pages_to_ask() {
        for path in ["/rpc/sandbox/create", "/rpc/sandbox/setup-code"] {
            assert_eq!(checked(&ask("POST", path, Some("{}"))), Err(refused(path)));
        }
    }

    #[test]
    fn an_answer_is_the_platforms_json_or_nobody_signed_in() {
        assert_eq!(
            answered(401, r#"{"message":"Unauthorized"}"#),
            Answered::SignedOut
        );
        assert_eq!(
            answered(200, r#"{"id":"cm1","name":"app"}"#),
            Answered::Json {
                status: 200,
                body: serde_json::json!({ "id": "cm1", "name": "app" })
            }
        );
        // A proxy's error page is not JSON: the status still says what happened.
        assert_eq!(
            answered(502, "<html>Bad gateway</html>"),
            Answered::Json {
                status: 502,
                body: serde_json::Value::Null
            }
        );
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

    /* WHO IS SIGNED IN, AS THE PLATFORM SAYS IT. */

    fn ada() -> crate::setup_link::RosterAccount {
        crate::setup_link::RosterAccount {
            email: "ada@example.com".into(),
            name: Some("Ada".into()),
            image: None,
        }
    }

    fn listed(id: &str) -> crate::setup_link::RosterEntry {
        crate::setup_link::RosterEntry {
            id: id.into(),
            name: id.into(),
            place: "own".into(),
            shared: false,
        }
    }

    #[test]
    fn a_session_answer_is_someone_nobody_or_nothing_to_go_by() {
        let body = r#"{"session":{"id":"s"},"user":{"id":"u","email":" ada@example.com ","name":"  Ada ","image":"http://x/a.png"}}"#;
        assert_eq!(session_of(200, body), Session::Someone(ada()));
        let pictured = r#"{"session":{},"user":{"email":"ada@example.com","name":"","image":"https://x/a.png"}}"#;
        assert_eq!(
            session_of(200, pictured),
            Session::Someone(crate::setup_link::RosterAccount {
                email: "ada@example.com".into(),
                name: None,
                image: Some("https://x/a.png".into()),
            })
        );
        assert_eq!(session_of(200, "null"), Session::Nobody);
        assert_eq!(session_of(200, "{}"), Session::Nobody);
        assert_eq!(session_of(401, r#"{"message":"no"}"#), Session::Nobody);
        // The platform in trouble, or an answer that is not a session, says nothing about who is signed in.
        assert_eq!(session_of(500, "null"), Session::Unknown);
        assert_eq!(session_of(200, "<html>"), Session::Unknown);
        assert_eq!(
            session_of(200, r#"{"session":{},"user":{}}"#),
            Session::Unknown
        );
    }

    #[test]
    fn the_roster_follows_the_session_and_keeps_only_its_own_sandboxes() {
        use crate::setup_link::Roster;
        let announced = Roster {
            account: Some(ada()),
            sandboxes: vec![listed("shop")],
        };
        // The same person: their sandboxes stay, their name as the platform says it now.
        let renamed = crate::setup_link::RosterAccount {
            name: Some("Ada L.".into()),
            ..ada()
        };
        assert_eq!(
            roster_with(announced.clone(), &Session::Someone(renamed.clone())),
            Roster {
                account: Some(renamed),
                sandboxes: vec![listed("shop")],
            }
        );
        // Nobody named yet, and a folder's own sandbox listed the moment it was made: kept.
        let unnamed = Roster {
            account: None,
            sandboxes: vec![listed("mine")],
        };
        assert_eq!(
            roster_with(unnamed, &Session::Someone(ada())),
            Roster {
                account: Some(ada()),
                sandboxes: vec![listed("mine")],
            }
        );
        // Someone else: none of the last person's sandboxes.
        let bo = crate::setup_link::RosterAccount {
            email: "bo@example.com".into(),
            name: None,
            image: None,
        };
        assert_eq!(
            roster_with(announced.clone(), &Session::Someone(bo.clone())),
            Roster {
                account: Some(bo),
                sandboxes: Vec::new(),
            }
        );
        assert_eq!(
            roster_with(announced.clone(), &Session::Nobody),
            Roster::default()
        );
        assert_eq!(roster_with(announced.clone(), &Session::Unknown), announced);
    }
}
