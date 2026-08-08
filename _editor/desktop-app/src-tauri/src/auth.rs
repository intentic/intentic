use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/* SIGN-IN HAPPENS IN THE USER'S REAL BROWSER, NEVER IN THIS APP'S WEBVIEW.
 *
 * Google refuses OAuth authorization requests from embedded webviews (`disallowed_useragent`), and Google
 * Identity Services — which is how the SPA mints the ID token the sandbox daemon verifies — is FedCM-based,
 * which WebKitGTK does not implement at all. The archived version answered both with a Safari user-agent
 * spoof on Linux; that is a workaround with an expiry date nobody controls, and it fails closed on the one
 * screen a new user cannot get past.
 *
 * So the app never asks Google for anything. It opens the platform's own page in the DEFAULT BROWSER, where
 * sign-in is the ordinary flow that already works, and gets the result back over the deep link it already
 * intercepts:
 *
 *   app     opener      →  <app>/desktop-auth?state=<nonce>&challenge=<sha256(verifier)>
 *   browser sign-in     →  platform mints a ONE-TIME handoff (session grant + a fresh Google ID token)
 *   browser redirect    →  intentic://auth?handoff=<token>&state=<nonce>
 *   app     navigate    →  <app>/desktop-auth/complete?handoff=<token>   IN THE WORKSPACE WINDOW
 *
 * The last step is why no cookie is ever injected from Rust: the webview fetches that URL itself, so the
 * platform's Set-Cookie lands in the webview's own jar exactly as it would in a browser. The handoff is spent
 * there, server-side, and the ID token it carried is exchanged once at the daemon's `system.session` for a
 * daemon session that renews silently — so Google reappears only when that session cannot be renewed.
 *
 * `state` ties the returning link to this process. The separate verifier never rides the deep link: its hash
 * is parked with the credentials and redemption requires the original retained value. A process which races
 * the public handoff id therefore learns nothing and cannot consume the real app's attempt.
 */

struct PendingAttempt {
    state: String,
    verifier: String,
    started_at: Instant,
}

/// The sign-in currently in flight, if any. Repeated starts inside its three-minute lifetime are idempotent:
/// one click cannot replace the state/verifier another browser tab is already returning with.
#[derive(Default)]
pub struct PendingAuth(Mutex<Option<PendingAttempt>>);

const ATTEMPT_TTL: Duration = Duration::from_secs(3 * 60);

pub fn start(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<PendingAuth>();
    let mut slot = pending.0.lock().unwrap();
    if slot
        .as_ref()
        .is_some_and(|attempt| attempt.started_at.elapsed() < ATTEMPT_TTL)
    {
        return Ok(());
    }
    let state = uuid::Uuid::new_v4().to_string();
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let base = app.state::<crate::state::AppState>().app_url();
    let url = format!(
        "{}/desktop-auth?state={state}&challenge={challenge}",
        base.trim_end_matches('/')
    );
    *slot = Some(PendingAttempt {
        state,
        verifier,
        started_at: Instant::now(),
    });
    drop(slot);
    let opened = app
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("could not open your browser to sign in: {error}"));
    if opened.is_err() {
        *pending.0.lock().unwrap() = None;
    }
    opened
}

pub fn complete(app: &AppHandle, args: &crate::setup_link::AuthArgs) {
    let pending = app.state::<PendingAuth>();
    let mut slot = pending.0.lock().unwrap();
    let matches = slot.as_ref().is_some_and(|attempt| {
        attempt.started_at.elapsed() < ATTEMPT_TTL && attempt.state == args.state
    });
    if !matches {
        eprintln!("dropped an auth handoff this app did not ask for");
        return;
    }
    let attempt = slot.take().unwrap();
    drop(slot);
    let path = format!(
        "/desktop-auth/complete?handoff={}&verifier={}",
        args.handoff, attempt.verifier
    );
    crate::windows::show_workspace_at(app, Some(&path));
}
