use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/* Google refuses OAuth authorization requests from embedded webviews (`disallowed_useragent`), and Google Identity Services. */

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

/* Open the sign-in page in the default browser — and open it EVERY time, which is the whole subtlety here. */
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
    let path = complete_path(&args.handoff, &attempt.verifier, args.profile.as_deref());
    // The profile decides the page's scheme before it paints (web index.html), so the app's own faces can
    // be drawn in that light from here on rather than waiting for the page to announce it.
    if let Some(mode) = mode_of_profile(args.profile.as_deref()) {
        crate::windows::apply_mode(app, mode);
    }
    crate::windows::show_workspace_at(app, Some(&path));
}

/// The page the webview redeems the handoff at. The profile rides along verbatim (setup_link.rs has already
/// reduced it to a known name), and the page consumes it off its query string before its router looks.
fn complete_path(handoff: &str, verifier: &str, profile: Option<&str>) -> String {
    let mut path = format!("/desktop-auth/complete?handoff={handoff}&verifier={verifier}");
    if let Some(profile) = profile {
        path.push_str("&profile=");
        path.push_str(profile);
    }
    path
}

/// What each profile paints in — `@intentic/constants` profile.ts, `PROFILES`, whose scheme is the half of
/// a profile this app can draw itself. `default` names no scheme of its own: it hands the browser back to the
/// OS's, which the page reads for itself and announces a moment later, so there is nothing to apply early.
fn mode_of_profile(profile: Option<&str>) -> Option<crate::state::Mode> {
    match profile? {
        "desk" => Some(crate::state::Mode::Light),
        _ => None,
    }
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

    /* THE REGRESSION. */
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
    fn the_profile_rides_the_completion_and_names_the_light_the_app_draws_in() {
        assert_eq!(
            complete_path("h", "v", None),
            "/desktop-auth/complete?handoff=h&verifier=v"
        );
        assert_eq!(
            complete_path("h", "v", Some("desk")),
            "/desktop-auth/complete?handoff=h&verifier=v&profile=desk"
        );
        assert_eq!(
            mode_of_profile(Some("desk")),
            Some(crate::state::Mode::Light)
        );
        // `default` follows the OS, which only the page can read: nothing for the binary to paint early.
        assert_eq!(mode_of_profile(Some("default")), None);
        assert_eq!(mode_of_profile(None), None);
    }

    #[test]
    fn an_expired_attempt_makes_way_for_a_fresh_one() {
        assert_eq!(
            attempt(ATTEMPT_TTL + Duration::from_secs(1), "https://old").live_url(),
            None
        );
    }
}
