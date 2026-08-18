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
    /// The page this attempt was opened at, kept so a second click can open THE SAME one again. Without it a
    /// repeat click had nothing to re-open and did nothing at all — see [`start`].
    url: String,
    started_at: Instant,
}

/// The sign-in currently in flight, if any. Repeated starts inside its three-minute lifetime REUSE it:
/// one click cannot replace the state/verifier another browser tab is already returning with.
#[derive(Default)]
pub struct PendingAuth(Mutex<Option<PendingAttempt>>);

const ATTEMPT_TTL: Duration = Duration::from_secs(3 * 60);

impl PendingAuth {
    /// The page a click should re-open, when an attempt is still in flight — `None` when a fresh one is due.
    ///
    /// Split out from [`start`] because it is the whole of the bug: everything else on that path needs a Tauri
    /// handle to exercise, and this needs nothing, so this is where the regression can be held down.
    fn live_url(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|attempt| attempt.started_at.elapsed() < ATTEMPT_TTL)
            .map(|attempt| attempt.url.clone())
    }
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("could not open your browser to sign in: {error}"))
}

/* Open the sign-in page in the default browser — and open it EVERY time, which is the whole subtlety here.
 *
 * A live attempt is reused rather than replaced, because the tab already carrying this state/verifier has to
 * stay able to come back; minting a new pair would strand it. That much was always right. What was missing is
 * that reuse still has to OPEN something: the earlier version returned success without touching the browser,
 * so the second click of any three-minute window was silently swallowed. The user closes the tab (or never
 * saw it), clicks sign in again, and the app does nothing — for three minutes, with no way to tell that from
 * a broken button. Quitting and relaunching cleared the slot, which is exactly the ritual people arrived at.
 *
 * Re-opening the same URL is safe precisely because it is the same URL: the platform page is idempotent, and
 * the attempt it belongs to is untouched. */
pub fn start(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<PendingAuth>();
    if let Some(url) = pending.live_url() {
        return open_browser(app, &url);
    }
    let mut slot = pending.0.lock().unwrap();
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
        url: url.clone(),
        started_at: Instant::now(),
    });
    drop(slot);
    let opened = open_browser(app, &url);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(age: Duration, url: &str) -> PendingAuth {
        PendingAuth(Mutex::new(Some(PendingAttempt {
            state: "state".into(),
            verifier: "verifier".into(),
            url: url.into(),
            started_at: Instant::now() - age,
        })))
    }

    #[test]
    fn nothing_in_flight_means_a_fresh_attempt() {
        assert_eq!(PendingAuth::default().live_url(), None);
    }

    /* THE REGRESSION. A sign-in already in flight used to make the next click a no-op, so anyone whose first
     * attempt did not finish — closed the tab, never saw it open, hit a Google error — was told nothing and
     * had no way forward but quitting the app. A live attempt must still hand back a page to open. */
    #[test]
    fn a_second_click_reopens_the_same_page() {
        let pending = attempt(
            Duration::from_secs(5),
            "https://app.intentic.dev/desktop-auth?state=a&challenge=b",
        );
        assert_eq!(
            pending.live_url().as_deref(),
            Some("https://app.intentic.dev/desktop-auth?state=a&challenge=b"),
            "a click during a live attempt must re-open that attempt's page, not do nothing"
        );
    }

    #[test]
    fn an_expired_attempt_makes_way_for_a_fresh_one() {
        assert_eq!(
            attempt(ATTEMPT_TTL + Duration::from_secs(1), "https://old").live_url(),
            None
        );
    }
}
