use std::sync::Mutex;

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
 *   app     opener      →  <app>/desktop-auth?state=<nonce>&redirect=intentic://auth
 *   browser sign-in     →  platform mints a ONE-TIME handoff (session grant + a fresh Google ID token)
 *   browser redirect    →  intentic://auth?handoff=<token>&state=<nonce>
 *   app     navigate    →  <app>/desktop-auth/complete?handoff=<token>   IN THE WORKSPACE WINDOW
 *
 * The last step is why no cookie is ever injected from Rust: the webview fetches that URL itself, so the
 * platform's Set-Cookie lands in the webview's own jar exactly as it would in a browser. The handoff is spent
 * there, server-side, and the ID token it carried is exchanged once at the daemon's `system.session` for a
 * daemon session that renews silently — so Google reappears only when that session cannot be renewed.
 *
 * `state` is the whole of the app's side of the security: a handoff arriving with a nonce this process did not
 * mint is a link somebody else constructed, and is dropped. It is single-use here too — a replayed link finds
 * the slot already taken.
 */

/// The nonce of the sign-in currently in flight, if any.
#[derive(Default)]
pub struct PendingAuth(pub Mutex<Option<String>>);

pub fn start(app: &AppHandle) -> Result<(), String> {
    let nonce = uuid::Uuid::new_v4().to_string();
    let base = app.state::<crate::state::AppState>().app_url();
    let url = format!(
        "{}/desktop-auth?state={nonce}&redirect=intentic%3A%2F%2Fauth",
        base.trim_end_matches('/')
    );
    *app.state::<PendingAuth>().0.lock().unwrap() = Some(nonce);
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("could not open your browser to sign in: {error}"))
}

pub fn complete(app: &AppHandle, args: &crate::setup_link::AuthArgs) {
    let expected = app.state::<PendingAuth>().0.lock().unwrap().take();
    if expected.as_deref() != Some(args.state.as_str()) {
        eprintln!("dropped an auth handoff this app did not ask for");
        return;
    }
    let path = format!("/desktop-auth/complete?handoff={}", args.handoff);
    crate::windows::show_workspace_at(app, Some(&path));
}
