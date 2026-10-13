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
    /// Whether this attempt asked the page to put Google's chooser up. Part of the identity of an attempt, not
    /// a detail of it: reusing a plain attempt for a switch press re-opens the page that auto-completed as the
    /// account the reader just rejected.
    switch_account: bool,
    /// Whether the press that asked for this sign-in happened in a local window — a folder's "Work on this with an
    /// agent", whose whole point is that folder. A detail rather than part of the attempt's identity: a second press
    /// writes it (see [`came_from`]), because where the reader ends up is where they last asked from.
    from_local: bool,
    started_at: Instant,
}

/// The sign-in currently in flight, if any. Repeated starts inside its three-minute lifetime REUSE it:
/// one click cannot replace the state/verifier another browser tab is already returning with.
#[derive(Default)]
pub struct PendingAuth(Mutex<Option<PendingAttempt>>);

const ATTEMPT_TTL: Duration = Duration::from_secs(3 * 60);

impl PendingAuth {
    /// The page a click should re-open, when an attempt asking for the same thing is still in flight — `None`
    /// when a fresh one is due.
    ///
    /// Split out from [`start`] because it is the whole of the bug: everything else on that path needs a Tauri
    /// handle to exercise, and this needs nothing, so this is where the regression can be held down.
    fn live_url(&self, switch_account: bool) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|attempt| {
                attempt.started_at.elapsed() < ATTEMPT_TTL
                    && attempt.switch_account == switch_account
            })
            .map(|attempt| attempt.url.clone())
    }

    /// Where the reader last pressed sign-in, written onto the attempt in flight. A press in a folder's window and a
    /// press in the workspace ask for the same page; only the way back differs, so this is the one thing a reused
    /// attempt takes from the press that reused it.
    fn came_from(&self, from_local: bool) {
        if let Some(attempt) = self.0.lock().unwrap().as_mut() {
            attempt.from_local = from_local;
        }
    }
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("could not open your browser to sign in: {error}"))
}

/* Open the sign-in page in the default browser — and open it EVERY time, which is the whole subtlety here. */
pub fn start(app: &AppHandle, switch_account: bool, from_local: bool) -> Result<(), String> {
    let pending = app.state::<PendingAuth>();
    if let Some(url) = pending.live_url(switch_account) {
        pending.came_from(from_local);
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
    let switch = if switch_account { "&switch=1" } else { "" };
    let url = format!(
        "{}/desktop-auth?state={state}&challenge={challenge}{switch}",
        base.trim_end_matches('/')
    );
    *slot = Some(PendingAttempt {
        state,
        verifier,
        url: url.clone(),
        switch_account,
        from_local,
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
    // An account now exists for this install to go back to: Home says so, and the tray offers the workspace.
    app.state::<crate::state::AppState>()
        .remember_account_seen();
    crate::offer_workspace(app);
    // A session the platform turned away before is a new one now: this computer's sandbox is asked for again once the
    // workspace says who signed in (machine_sandbox.rs).
    crate::machine_sandbox::account_changed();
    let path = complete_path(
        &args.handoff,
        &attempt.verifier,
        args.profile.as_deref(),
        attempt.from_local,
    );
    // The profile decides the page's scheme before it paints (web index.html), so the app's own faces can
    // be drawn in that light from here on rather than waiting for the page to announce it.
    if let Some(mode) = mode_of_profile(args.profile.as_deref()) {
        crate::windows::apply_mode(app, mode);
    }
    crate::windows::show_workspace_at(app, Some(&path));
}

/// The page the webview redeems the handoff at. The profile rides along verbatim (setup_link.rs has already
/// reduced it to a known name), and the page consumes it off its query string before its router looks.
///
/// `back=agent` is how a sign-in that began in a folder's window gets the reader back there. The redemption itself
/// has to happen in the WORKSPACE window — the platform sets its session cookie over an ordinary HTTP round trip on
/// that origin — so the page is told to send `intentic://launcher?to=agent` once it is done, which brings the local
/// window forward on whatever that folder is waiting for. Without it the workspace simply stayed, and a reader who
/// pressed "Work on this with an agent" on a folder ended up looking at the account's sandbox list instead, with
/// nothing on screen that had anything to do with the folder they asked about.
///
/// The sign-in gate (_tools/e2e/signin/desktop.ts, `e2e-signin` in ci.yml) plays this file's half of the sign-in
/// in TypeScript, `start`'s page and this path included, since it runs the web app without Tauri: a change to
/// either shape changes it there too, or the gate goes on proving a sign-in this app no longer does.
fn complete_path(handoff: &str, verifier: &str, profile: Option<&str>, from_local: bool) -> String {
    let mut path = format!("/desktop-auth/complete?handoff={handoff}&verifier={verifier}");
    if let Some(profile) = profile {
        path.push_str("&profile=");
        path.push_str(profile);
    }
    if from_local {
        path.push_str("&back=agent");
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
        switching_attempt(age, url, false)
    }

    fn switching_attempt(age: Duration, url: &str, switch_account: bool) -> PendingAuth {
        PendingAuth(Mutex::new(Some(PendingAttempt {
            state: "state".into(),
            verifier: "verifier".into(),
            url: url.into(),
            switch_account,
            from_local: false,
            started_at: Instant::now() - age,
        })))
    }

    fn origin_of(pending: &PendingAuth) -> Option<bool> {
        pending
            .0
            .lock()
            .unwrap()
            .as_ref()
            .map(|attempt| attempt.from_local)
    }

    #[test]
    fn nothing_in_flight_means_a_fresh_attempt() {
        assert_eq!(PendingAuth::default().live_url(false), None);
    }

    /* THE REGRESSION. */
    #[test]
    fn a_second_click_reopens_the_same_page() {
        let pending = attempt(
            Duration::from_secs(5),
            "https://app.intentic.dev/desktop-auth?state=a&challenge=b",
        );
        assert_eq!(
            pending.live_url(false).as_deref(),
            Some("https://app.intentic.dev/desktop-auth?state=a&challenge=b"),
            "a click during a live attempt must re-open that attempt's page, not do nothing"
        );
    }

    /* A reader who has just been told the wrong account signed them in must not be sent back to the page that did it. */
    #[test]
    fn asking_for_a_different_account_never_reuses_a_plain_attempt() {
        let pending = attempt(
            Duration::from_secs(5),
            "https://app.intentic.dev/desktop-auth?state=a&challenge=b",
        );
        assert_eq!(pending.live_url(true), None);
    }

    #[test]
    fn a_second_switch_click_reopens_the_switching_page() {
        let pending = switching_attempt(
            Duration::from_secs(5),
            "https://app.intentic.dev/desktop-auth?state=a&challenge=b&switch=1",
            true,
        );
        assert_eq!(
            pending.live_url(true).as_deref(),
            Some("https://app.intentic.dev/desktop-auth?state=a&challenge=b&switch=1")
        );
        assert_eq!(pending.live_url(false), None);
    }

    /// A sign-in asked for in a folder's window is a sign-in about that folder: the page is told to hand the reader
    /// back to this computer's face rather than leave them on the account's sandbox list.
    #[test]
    fn a_sign_in_begun_in_a_local_window_asks_the_page_to_send_the_reader_back() {
        assert_eq!(
            complete_path("h", "v", None, true),
            "/desktop-auth/complete?handoff=h&verifier=v&back=agent"
        );
        assert_eq!(
            complete_path("h", "v", Some("desk"), true),
            "/desktop-auth/complete?handoff=h&verifier=v&profile=desk&back=agent"
        );
    }

    /// Two windows can press sign-in at the same page; only the way back differs, so a reused attempt takes the
    /// origin of the press that reused it rather than keeping the one it was minted with.
    #[test]
    fn a_reused_attempt_goes_back_where_the_reader_last_asked_from() {
        let pending = attempt(
            Duration::from_secs(5),
            "https://app.intentic.dev/desktop-auth?state=a&challenge=b",
        );
        assert_eq!(origin_of(&pending), Some(false));
        pending.came_from(true);
        assert_eq!(origin_of(&pending), Some(true));
        pending.came_from(false);
        assert_eq!(origin_of(&pending), Some(false));
        // Nothing in flight: nothing to write on, and no panic for writing it.
        PendingAuth::default().came_from(true);
    }

    #[test]
    fn the_profile_rides_the_completion_and_names_the_light_the_app_draws_in() {
        assert_eq!(
            complete_path("h", "v", None, false),
            "/desktop-auth/complete?handoff=h&verifier=v"
        );
        assert_eq!(
            complete_path("h", "v", Some("desk"), false),
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
            attempt(ATTEMPT_TTL + Duration::from_secs(1), "https://old").live_url(false),
            None
        );
    }
}
