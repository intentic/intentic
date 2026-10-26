/* THIS MACHINE'S SANDBOXES WITH NO INTERNET — the sandbox face, the app's own copy of the editor (2026-10-16).

The workspace window shows the editor from app.intentic.dev, which needs the internet twice before it draws anything:
to load, and to ask the platform who is signed in and which sandboxes there are. Intentic OS has to work offline with
its own sandboxes, so when that address does not answer, the window shows `files/sandbox` from the app's bundle
instead (local/sandbox.ts): the same editor, every route and extension, its platform questions answered in the page
from what this machine knows, and each sandbox reached on its loopback port with a session the machine minted for its
owner (`ic sandbox session`, which `docker exec`s the daemon's own mint; the daemon's auth/host/host-session.ts says why the
machine is a proof). Nothing about the hosted workspace changes: when its address answers again the face offers it,
and never takes a page somebody is using away from them.

The page is the app's own bundle in the workspace window, granted the three commands below and nothing else
(capabilities/machine-face.json); the hosted page in the same window is remote content and is granted none of them. */

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

type CommandResult<T> = Result<T, String>;

/// The face in the app's bundle, as a window navigates to it: Tauri serves the bundle at `tauri://localhost` on Linux
/// and `http://tauri.localhost` on Windows (offline.rs pins the latter), and answers `files/sandbox` with
/// `files/sandbox.html` as it does the folder face's `files/local`.
#[cfg(windows)]
pub const FACE_URL: &str = "http://tauri.localhost/files/sandbox";
#[cfg(not(windows))]
pub const FACE_URL: &str = "tauri://localhost/files/sandbox";

/// Whether this build ships the face: the bundle's copy of the editor is built for, and offline.rs watches on, Windows
/// and Linux. Elsewhere there is nothing to open, so nothing offers it (the hosted page's `machineFace`, Devices' Open).
pub const FACE_BUILT: bool = cfg!(any(windows, target_os = "linux"));

/// The face's address, opened on one sandbox when `sandbox` names it by the key the face knows it by (local/machineFace.ts
/// `sandboxKeyOf`: the platform's id, or `machine-<id>`). It rides as the editor's own `?sandbox=` in the face's route,
/// which the face keeps in the hash, so the editor selects it as it does any `/?sandbox=` (router/sandboxArrival.ts);
/// a key out of shape opens the face as it is. Pure.
pub fn face_url_for(sandbox: Option<&str>) -> String {
    match sandbox.filter(|key| is_face_key(key)) {
        Some(key) => format!("{FACE_URL}#/?sandbox={key}"),
        None => FACE_URL.to_string(),
    }
}

/// A key the face lists a sandbox by: a platform id (a cuid) or `machine-` and a 12-hex id or a slug. Letters, digits,
/// dashes and underscores only, so it can never end the route it rides in. Pure.
fn is_face_key(key: &str) -> bool {
    (1..=80).contains(&key.len())
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Whether `url` is the face: the one page of the bundle the workspace window may show besides the offline page.
pub fn is_face_page(url: &url::Url) -> bool {
    let Ok(face) = url::Url::parse(FACE_URL) else {
        return false;
    };
    url.scheme() == face.scheme()
        && url.host_str() == face.host_str()
        && url.path().trim_end_matches(".html") == face.path()
}

/// What the page is handed (local/machineFace.ts `MachineFace`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineFace {
    pub account: Option<Account>,
    pub sandboxes: Vec<MachineSandbox>,
    pub app_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub email: String,
    pub name: Option<String>,
    pub image: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSandbox {
    pub slug: String,
    pub name: String,
    pub platform_id: Option<String>,
    pub sandbox_id: Option<String>,
    pub local_port: Option<u16>,
    pub running: bool,
    pub asleep: bool,
    pub session: Option<Session>,
    pub why: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub token: String,
    pub expires_at: u64,
    pub email: String,
}

/// One `ic sandbox list --json` row as the face lists it, before any session: its names and where it answers. A row
/// from an ic too old to say where it answers has no port, and the page leaves it out. Pure.
pub fn sandbox_of(row: &Value, name: Option<String>) -> Option<MachineSandbox> {
    let slug = row["slug"].as_str()?.to_string();
    let text = |key: &str| row[key].as_str().map(str::to_string);
    Some(MachineSandbox {
        name: name.unwrap_or_else(|| slug.clone()),
        platform_id: text("platformId"),
        sandbox_id: text("sandboxId"),
        local_port: row["localPort"]
            .as_u64()
            .and_then(|port| u16::try_from(port).ok()),
        running: row["running"] == true,
        asleep: row["asleep"] == true,
        session: None,
        why: None,
        slug,
    })
}

/// `ic sandbox session <slug> --json`'s one line: the session, and the platform id it may know better than the listing
/// did. Pure.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Minted {
    email: String,
    token: String,
    expires_at: u64,
    platform_id: Option<String>,
}

fn minted_from(stdout: &str) -> Option<Minted> {
    stdout
        .lines()
        .map(str::trim)
        .rfind(|line| line.starts_with('{'))
        .and_then(|line| serde_json::from_str(line).ok())
}

/// A session is minted again this long before it ends, so the page never holds one that dies mid-call.
const RENEW_AHEAD_MS: u64 = 24 * 60 * 60 * 1000;

/// A mint is a `docker exec` of a second or so; past this the container is in trouble.
const MINT_LIMIT: Duration = Duration::from_secs(30);

/// The sessions this run of the app minted, by slug: the face asks again every time the page loads, and a mint per
/// sandbox per load would be seconds of waiting for nothing. In memory only: the token is the owner's credential.
static SESSIONS: LazyLock<Mutex<HashMap<String, Minted>>> = LazyLock::new(Mutex::default);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// A session for `slug`, the one minted earlier while it is still good, else a fresh one, with the platform id the mint
/// knew. BLOCKING.
fn session_for(slug: &str) -> Result<(Session, Option<String>), String> {
    let kept = SESSIONS.lock().unwrap().get(slug).cloned();
    let minted = match kept {
        Some(minted) if minted.expires_at > now_ms().saturating_add(RENEW_AHEAD_MS) => minted,
        _ => {
            let stdout =
                crate::scripts::ic_answer(&["sandbox", "session", slug, "--json"], MINT_LIMIT)?;
            let minted = minted_from(&stdout).ok_or_else(|| {
                format!("ic made no session for {slug}: it may be older than this app")
            })?;
            SESSIONS
                .lock()
                .unwrap()
                .insert(slug.to_string(), minted.clone());
            minted
        }
    };
    Ok((
        Session {
            token: minted.token,
            expires_at: minted.expires_at,
            email: minted.email,
        },
        minted.platform_id,
    ))
}

/// The sandbox with its session, when it runs and answers on a loopback port; otherwise as listed. BLOCKING.
fn with_session(mut sandbox: MachineSandbox) -> MachineSandbox {
    if !sandbox.running || sandbox.local_port.is_none() {
        return sandbox;
    }
    match session_for(&sandbox.slug) {
        Ok((session, platform_id)) => {
            sandbox.session = Some(session);
            sandbox.platform_id = sandbox.platform_id.or(platform_id);
        }
        // ic's own sentence, written for a person: nobody signed in yet, an image too old, a container in trouble.
        Err(why) => sandbox.why = Some(why),
    }
    sandbox
}

/// Everything the page is handed. BLOCKING: one listing, then a mint for each running sandbox that has none.
fn facts(app: &AppHandle) -> Result<MachineFace, String> {
    let rows = crate::scripts::ic_listing(
        app,
        crate::commands::list_script(crate::scripts::Host::current(), crate::commands::VERSION),
    )?;
    let state = app.state::<AppState>();
    let sandboxes = std::thread::scope(|scope| {
        let minting: Vec<_> = rows
            .iter()
            .filter_map(|row| {
                let name = row["slug"].as_str().and_then(|slug| state.name_of(slug));
                sandbox_of(row, name)
            })
            .map(|sandbox| scope.spawn(move || with_session(sandbox)))
            .collect();
        minting
            .into_iter()
            .filter_map(|minted| minted.join().ok())
            .collect()
    });
    let account = state.roster().account.map(|account| Account {
        email: account.email,
        name: account.name,
        image: account.image,
    });
    Ok(MachineFace {
        account,
        sandboxes,
        app_url: state.app_url(),
    })
}

/// The face's facts: this machine's sandboxes, a session for each that runs, and who the workspace last said is signed
/// in.
#[tauri::command]
pub async fn machine_face(app: AppHandle) -> CommandResult<MachineFace> {
    tauri::async_runtime::spawn_blocking(move || facts(&app))
        .await
        .map_err(|error| error.to_string())?
}

/// A fresh session for one sandbox, after its daemon refused the one the page held (signed out everywhere, a new
/// owner) or it woke up: the kept one is dropped first.
#[tauri::command]
pub async fn machine_face_renew(slug: String) -> CommandResult<Session> {
    if !crate::setup_link::is_slug(&slug) {
        return Err(format!("not a sandbox name: {slug}"));
    }
    SESSIONS.lock().unwrap().remove(&slug);
    tauri::async_runtime::spawn_blocking(move || session_for(&slug).map(|(session, _)| session))
        .await
        .map_err(|error| error.to_string())?
}

/// Whether the online workspace answers again, for the face's offer to go back to it.
#[tauri::command]
pub async fn machine_face_online(app: AppHandle) -> bool {
    answers(&app.state::<AppState>().app_url(), PROBE_LIMIT).await
}

/// Devices' Open on a sandbox of THIS computer (src/device/face.ts `openSandbox`): the workspace on it at `path`
/// (`/?sandbox=<platform id>`) while the workspace answers usably, as Open always did, and otherwise the face on it
/// (`sandbox`, its key there), which needs nothing from the internet: loading the hosted page into an outage only to be
/// sent on to the offline page, and from there to the face, was two screens and a press in the way of a sandbox that
/// is running on this very computer. A sandbox the platform never named has no workspace row to open, so it opens in
/// the face whatever the network does. ASYNC for the reason `workspace_open` is (commands.rs).
#[tauri::command]
pub async fn local_sandbox_open(
    app: AppHandle,
    window: tauri::Webview,
    path: Option<String>,
    sandbox: String,
) {
    let online = match &path {
        Some(_) if FACE_BUILT => answers(&app.state::<AppState>().app_url(), PROBE_LIMIT).await,
        Some(_) => true,
        None => false,
    };
    // Devices' Open, the reader's press on one sandbox.
    let press = crate::windows::present::Press::by(crate::windows::present::Asked::Page);
    match path.filter(|_| online) {
        Some(path) => {
            crate::windows::show_workspace_from(&app, press, Some(path.as_str()), &window)
        }
        None if FACE_BUILT => {
            crate::windows::show_machine_face_from(&app, press, Some(&sandbox), Some(&window))
        }
        None => {}
    }
}

/* IS THE WORKSPACE THERE? */

/// A page that has not started answering by now will not open for anyone waiting at a screen.
pub const PROBE_LIMIT: Duration = Duration::from_secs(4);

/// Whether `url` answers with something the workspace can be used through, within `limit`: no answer is none, and
/// neither is one [`crate::offline::unusable_status`] calls unusable. The same question the offline page asks, from the
/// app. _(2026-10-26) Any HTTP status used to count, so that a 503 from a platform mid-deploy read as the internet
/// working. But the platform's editor and API sit behind one Cloudflare tunnel, and a dead platform host answers with
/// Cloudflare's 530 or 52x: the window was left on that page for good, with no way to this computer's sandboxes and no
/// retry. A deploy's brief 503 now sends the window to the offline page, which comes back by itself once this answers._
pub async fn answers(url: &str, limit: Duration) -> bool {
    status_at(url, limit)
        .await
        .is_some_and(|status| !crate::offline::unusable_status(status))
}

/// Whether anything at all answers at `url` within `limit`, whatever its status: the question offline.rs's start probe
/// asks, which only cuts short a load that will get no answer. An answer with an unusable status is left to the load
/// itself, judged as it commits: the hosted editor's service worker serves its cached copy in place of a dead platform's
/// page (the web's `public/sw.js`), and that copy is a workspace, where the probe's own request saw only the 530.
pub async fn reached(url: &str, limit: Duration) -> bool {
    status_at(url, limit).await.is_some()
}

/// The HTTP status a HEAD of `url` gets within `limit`; none when nothing answers.
async fn status_at(url: &str, limit: Duration) -> Option<u16> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .timeout(limit)
        .connect_timeout(limit)
        .user_agent(format!("intentic-desktop/{}", crate::commands::VERSION))
        .build()
        .ok()?;
    let answer = client.head(url).send().await.ok()?;
    Some(answer.status().as_u16())
}

/// What a workspace window that could not reach its page shows: the face, when this computer may have sandboxes of
/// its own to open, else the offline page, which keeps trying. Pure.
pub fn fallback_for(hosts_sandboxes: bool, app_url: &str, status: &str) -> String {
    if hosts_sandboxes {
        FACE_URL.to_string()
    } else {
        crate::offline::page_for(app_url, status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_listing_row_becomes_a_sandbox_the_face_can_dial() {
        let row = json!({ "slug": "3c469e9d6c58", "running": true, "asleep": false, "sandboxId": "3c469e9d6c58", "localPort": 30238, "platformId": "cm1" });
        assert_eq!(
            sandbox_of(&row, Some("Lab".to_string())),
            Some(MachineSandbox {
                slug: "3c469e9d6c58".to_string(),
                name: "Lab".to_string(),
                platform_id: Some("cm1".to_string()),
                sandbox_id: Some("3c469e9d6c58".to_string()),
                local_port: Some(30238),
                running: true,
                asleep: false,
                session: None,
                why: None,
            })
        );
        // From an ic too old to say where it answers: listed with no port, and named by its slug when the app knows none.
        let old = sandbox_of(
            &json!({ "slug": "lab", "running": false, "asleep": true }),
            None,
        )
        .unwrap();
        assert_eq!(
            (old.name.as_str(), old.local_port, old.asleep),
            ("lab", None, true)
        );
        assert_eq!(sandbox_of(&json!({ "running": true }), None), None);
    }

    #[test]
    fn a_stopped_sandbox_is_never_asked_for_a_session() {
        let asleep = sandbox_of(
            &json!({ "slug": "nap", "running": false, "asleep": true, "localPort": 30000 }),
            None,
        )
        .unwrap();
        assert_eq!(with_session(asleep.clone()), asleep);
        let unpublished = sandbox_of(
            &json!({ "slug": "dev", "running": true, "localPort": null }),
            None,
        )
        .unwrap();
        assert_eq!(with_session(unpublished.clone()), unpublished);
    }

    #[test]
    fn the_mints_line_is_read_out_of_whatever_else_was_printed() {
        let stdout = "fetching ic…\n{\"slug\":\"lab\",\"sandboxId\":null,\"platformId\":\"cm1\",\"localPort\":30238,\"email\":\"o@x.dev\",\"token\":\"t\",\"expiresAt\":5}\n";
        assert_eq!(
            minted_from(stdout),
            Some(Minted {
                email: "o@x.dev".to_string(),
                token: "t".to_string(),
                expires_at: 5,
                platform_id: Some("cm1".to_string()),
            })
        );
        assert_eq!(minted_from("Nobody has signed in to lab yet."), None);
    }

    /// Opened on one sandbox, by the key the face lists it under, in the face's own route; a key that could end the
    /// route opens the face as it is.
    #[test]
    fn the_face_opens_on_the_sandbox_named_by_its_key() {
        assert_eq!(
            face_url_for(Some("cmtu1eqyv0001dawma7zi4n3i")),
            format!("{FACE_URL}#/?sandbox=cmtu1eqyv0001dawma7zi4n3i")
        );
        assert_eq!(
            face_url_for(Some("machine-82789f4106b4")),
            format!("{FACE_URL}#/?sandbox=machine-82789f4106b4")
        );
        assert_eq!(face_url_for(None), FACE_URL);
        for bad in ["", "a&b=c", "x#y", "../x", "a b", &"x".repeat(81)] {
            assert_eq!(face_url_for(Some(bad)), FACE_URL, "{bad}");
        }
        assert!(is_face_page(&face_url_for(Some("cm1")).parse().unwrap()));
    }

    #[test]
    fn only_the_face_itself_is_the_face() {
        assert!(is_face_page(&FACE_URL.parse().unwrap()));
        assert!(is_face_page(&format!("{FACE_URL}.html").parse().unwrap()));
        assert!(is_face_page(
            &format!("{FACE_URL}#/agents").parse().unwrap()
        ));
        assert!(!is_face_page(
            &FACE_URL.replace("sandbox", "local").parse().unwrap()
        ));
        assert!(!is_face_page(
            &"https://app.intentic.dev/files/sandbox".parse().unwrap()
        ));
    }

    #[test]
    fn a_computer_with_sandboxes_falls_back_to_them_and_one_without_to_the_offline_page() {
        assert_eq!(
            fallback_for(true, "https://app.intentic.dev", "timeout"),
            FACE_URL
        );
        let page = fallback_for(false, "https://app.intentic.dev", "timeout");
        assert!(
            crate::offline::is_offline_page(&page.parse().unwrap()),
            "{page}"
        );
    }

    /// A dead platform behind Cloudflare answers, with its 530: that is no workspace, and the face stays offered. A
    /// working one answers 200.
    #[test]
    fn a_dead_platforms_answer_is_not_the_workspace_answering() {
        fn serving(status: &'static str) -> String {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut asked = [0u8; 1024];
                    let _ = stream.read(&mut asked);
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    );
                }
            });
            format!("http://127.0.0.1:{port}/")
        }
        assert!(!tauri::async_runtime::block_on(answers(
            &serving("530 Origin Unreachable"),
            PROBE_LIMIT
        )));
        assert!(tauri::async_runtime::block_on(answers(
            &serving("200 OK"),
            PROBE_LIMIT
        )));
        // The start probe only asks whether anything answers: a 530 is left to the load, which a cached editor may win.
        assert!(tauri::async_runtime::block_on(reached(
            &serving("530 Origin Unreachable"),
            PROBE_LIMIT
        )));
    }

    /// Nothing listening is no answer, at once rather than at the deadline.
    #[test]
    fn an_address_nothing_answers_on_is_offline() {
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let started = std::time::Instant::now();
        assert!(!tauri::async_runtime::block_on(answers(
            &format!("http://127.0.0.1:{port}/"),
            PROBE_LIMIT
        )));
        assert!(started.elapsed() < PROBE_LIMIT);
    }
}
