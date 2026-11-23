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
    /// The local window whose press asked for this sign-in — a folder's "Work on this with an agent", whose whole point
    /// is that folder — or none for the workspace's own. A detail rather than part of the attempt's identity: a second
    /// press writes it (see [`came_from`]), because where the reader ends up is where they last asked from.
    asked_in: Option<String>,
    started_at: Instant,
}

/// The sign-ins in flight, newest last. Repeated starts inside the newest one's three-minute reuse window REUSE it:
/// one click cannot replace the state/verifier another browser tab is already returning with.
///
/// THE OLDER ONES STAY ANSWERABLE (2026-11-20). One attempt was kept, and a hand-off was taken only inside three
/// minutes: a fresh Windows install pressed Google at 21:34, finished in the browser at 21:45, and the link that
/// reached the app was "an auth handoff this app did not ask for". Every press after that minted a new attempt and
/// dropped the one a tab was still finishing. Now each attempt is answerable for [`ANSWER_TTL`], whichever of the
/// reader's tabs comes back first; the first answer ends them all.
#[derive(Default)]
pub struct PendingAuth(Mutex<Vec<PendingAttempt>>);

/// How long a press re-opens the same page rather than a fresh one.
const ATTEMPT_TTL: Duration = Duration::from_secs(3 * 60);
/// How long an attempt's answer is still taken: a first sign-in in a browser can take a reader many minutes (a new
/// Google account, a phone's second factor). The verifier is this process's alone, so nothing else can use the window.
const ANSWER_TTL: Duration = Duration::from_secs(30 * 60);
/// At most this many attempts are kept answerable; a reader pressing more than this has the newest ones live.
const KEEP_ATTEMPTS: usize = 4;

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
            .last()
            .filter(|attempt| {
                attempt.started_at.elapsed() < ATTEMPT_TTL
                    && attempt.switch_account == switch_account
            })
            .map(|attempt| attempt.url.clone())
    }

    /// Where the reader last pressed sign-in, written onto the attempt in flight. A press in a folder's window and a
    /// press in the workspace ask for the same page; only the way back differs, so this is the one thing a reused
    /// attempt takes from the press that reused it.
    fn came_from(&self, asked_in: Option<String>) {
        if let Some(attempt) = self.0.lock().unwrap().last_mut() {
            attempt.asked_in = asked_in;
        }
    }

    /// A fresh attempt, kept beside the recent ones still answerable.
    fn add(&self, attempt: PendingAttempt) {
        let mut attempts = self.0.lock().unwrap();
        attempts.retain(|kept| kept.started_at.elapsed() < ANSWER_TTL);
        attempts.push(attempt);
        let over = attempts.len().saturating_sub(KEEP_ATTEMPTS);
        attempts.drain(..over);
    }

    /// The attempt an answer names, when it is still answerable; taking it ends every other one, since the reader is
    /// signed in now and any other tab's answer would only sign them in again.
    fn take(&self, state: &str) -> Option<PendingAttempt> {
        let mut attempts = self.0.lock().unwrap();
        let at = attempts.iter().position(|attempt| {
            attempt.state == state && attempt.started_at.elapsed() < ANSWER_TTL
        })?;
        let taken = attempts.swap_remove(at);
        attempts.clear();
        Some(taken)
    }

    /// Each attempt still answerable, as (state, verifier): what the app asks the platform about while it waits.
    fn answerable(&self) -> Vec<(String, String)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|attempt| attempt.started_at.elapsed() < ANSWER_TTL)
            .map(|attempt| (attempt.state.clone(), attempt.verifier.clone()))
            .collect()
    }

    /// The newest attempt's page, whatever its age: the tile's "open it again".
    fn newest_url(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .last()
            .map(|attempt| attempt.url.clone())
    }

    /// One attempt gone, the others left answerable: a page the browser never opened.
    fn forget(&self, state: &str) {
        self.0
            .lock()
            .unwrap()
            .retain(|attempt| attempt.state != state);
    }

    fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

/* A SIGN-IN IN THE BROWSER IS A PROCESS (2026-10-26): the reader pressed sign-in somewhere, the browser has the page,
 * and both faces show a tile saying so (processes.rs), with the browser's page again a press away and a way to call it
 * off. Its end moves nobody: the session is redeemed by the workspace's page where it stands (`complete`). */
const SIGN_IN: &str = "sign-in:app";

fn report_waiting(app: &AppHandle) {
    let mut report = crate::processes::ProcessReport::of("sign-in", "app", "waiting");
    report.waiting_for = Some("browser".into());
    report.actions = vec!["sign-in-again".into(), "cancel".into()];
    crate::processes::report(app, report);
}

/// The tile goes once no attempt can come back: answered, called off, or past its lifetime.
fn clear_after_ttl(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ANSWER_TTL);
        if app.state::<PendingAuth>().answerable().is_empty() {
            crate::processes::clear(&app, SIGN_IN);
        }
    });
}

/// The reader's answer on the sign-in's tile: the browser's page again, or the attempt called off.
pub fn act(app: &AppHandle, act: &str) {
    match act {
        "sign-in-again" => match app.state::<PendingAuth>().newest_url() {
            Some(url) => {
                if let Err(error) = open_browser(app, &url) {
                    eprintln!("{error}");
                }
            }
            None => {
                if let Err(error) = start(app, false, None) {
                    eprintln!("{error}");
                }
            }
        },
        "cancel" | "dismiss" => {
            app.state::<PendingAuth>().clear();
            crate::processes::clear(app, SIGN_IN);
        }
        _ => {}
    }
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("could not open your browser to sign in: {error}"))
}

/* Open the sign-in page in the default browser — and open it EVERY time, which is the whole subtlety here. */
pub fn start(
    app: &AppHandle,
    switch_account: bool,
    asked_in: Option<String>,
) -> Result<(), String> {
    let pending = app.state::<PendingAuth>();
    if let Some(url) = pending.live_url(switch_account) {
        pending.came_from(asked_in);
        report_waiting(app);
        return open_browser(app, &url);
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
    let switch = if switch_account { "&switch=1" } else { "" };
    let url = format!(
        "{}/desktop-auth?state={state}&challenge={challenge}{switch}",
        base.trim_end_matches('/')
    );
    pending.add(PendingAttempt {
        state: state.clone(),
        verifier,
        url: url.clone(),
        switch_account,
        asked_in,
        started_at: Instant::now(),
    });
    let opened = open_browser(app, &url);
    if opened.is_err() {
        pending.forget(&state);
        return opened;
    }
    report_waiting(app);
    clear_after_ttl(app);
    watch_platform(app);
    opened
}

/// How the browser's answer reached this process, carried to the page (`via=` on its completion) so a link the browser
/// never launched shows in the sign-in's own analytics instead of as a reader stuck on "waiting".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Via {
    /// The `intentic://auth` link, as designed.
    Link,
    /// The platform, asked by this process while it waited: the link was lost.
    Platform,
}

/// The browser's `intentic://auth` link.
pub fn complete(app: &AppHandle, args: &crate::setup_link::AuthArgs) {
    let Some(attempt) = app.state::<PendingAuth>().take(&args.state) else {
        eprintln!("dropped an auth handoff this app did not ask for");
        return;
    };
    finish(
        app,
        attempt,
        &args.handoff,
        args.profile.as_deref(),
        Via::Link,
    );
}

/* THE LINK IS NOT THE ONLY ROAD BACK (2026-11-20). Chrome launches an app's protocol without a fresh click once, and
 * then refuses every later launch ("a user gesture is required") until the reader clicks a page again: the hand-off
 * page navigates to `intentic://auth` by itself, so a reader who signed in, came back, and pressed sign-in again was
 * signed in in the browser five times over while the app went on waiting, with nothing on either side saying why.
 * So while an attempt waits, this process also asks the platform, by the verifier only it holds, whether the browser
 * parked a hand-off for it (`/desktop/pending`), and finishes the same way the link does when it finds one. */
const POLL_EVERY: Duration = Duration::from_secs(3);
static POLLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// What the platform said about one attempt.
#[derive(Debug, PartialEq, Eq)]
enum Parked {
    /// The browser parked this hand-off for it.
    Handoff(String),
    /// Nothing yet, or no answer: asked again next round.
    Nothing,
    /// A platform from before the question: not asked again by this process.
    Unasked,
}

/// The platform's answer, read. Pure.
fn parked_of(status: u16, body: &str) -> Parked {
    if status == 404 {
        return Parked::Unasked;
    }
    if !(200..300).contains(&status) {
        return Parked::Nothing;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|answer| answer.get("handoff")?.as_str().map(str::to_string))
        .filter(|handoff| !handoff.is_empty())
        .map_or(Parked::Nothing, Parked::Handoff)
}

async fn ask_platform(platform: &str, verifier: &str) -> Parked {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("intentic-desktop/{}", crate::commands::VERSION))
        .build()
    else {
        return Parked::Nothing;
    };
    let url = format!("{}/rpc/desktop/pending", platform.trim_end_matches('/'));
    let Ok(answer) = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "verifier": verifier }).to_string())
        .send()
        .await
    else {
        return Parked::Nothing;
    };
    let status = answer.status().as_u16();
    let body = answer.text().await.unwrap_or_default();
    parked_of(status, &body)
}

/// One watcher per process, running while any attempt is answerable.
fn watch_platform(app: &AppHandle) {
    if POLLING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_EVERY);
        let pending = app.state::<PendingAuth>();
        let attempts = pending.answerable();
        if attempts.is_empty() {
            POLLING.store(false, std::sync::atomic::Ordering::SeqCst);
            // An attempt added between the read and the store found the flag still up: this watcher keeps it.
            if pending.answerable().is_empty()
                || POLLING.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            continue;
        }
        let platform = app.state::<crate::state::AppState>().platform_url();
        for (state, verifier) in attempts {
            match tauri::async_runtime::block_on(ask_platform(&platform, &verifier)) {
                Parked::Handoff(handoff) => {
                    if let Some(attempt) = pending.take(&state) {
                        finish(&app, attempt, &handoff, None, Via::Platform);
                    }
                    break;
                }
                Parked::Nothing => {}
                Parked::Unasked => {
                    // The flag stays up: nothing in this process asks this platform again.
                    return;
                }
            }
        }
    });
}

fn finish(
    app: &AppHandle,
    attempt: PendingAttempt,
    handoff: &str,
    profile: Option<&str>,
    via: Via,
) {
    crate::processes::clear(app, SIGN_IN);
    // An account now exists for this install to go back to: Home says so, and the tray offers the workspace.
    app.state::<crate::state::AppState>()
        .remember_account_seen();
    crate::offer_workspace(app);
    // A session the platform turned away before is a new one now: a folder waiting on the sign-in reads signed in at
    // once, and its sandbox is made once the workspace says who signed in (folder_setup.rs).
    crate::folder_setup::signed_in(app);
    let path = complete_path(
        handoff,
        &attempt.verifier,
        profile,
        attempt.asked_in.is_some(),
        via,
    );
    // The profile decides the page's scheme before it paints (web index.html), so the app's own faces can
    // be drawn in that light from here on rather than waiting for the page to announce it. Unless the app has seen
    // the reader's look: the page adopts that one over the profile's (windows.rs `look_init_script`).
    let look = app.state::<crate::state::AppState>().ui_look();
    if let Some(mode) = early_mode(profile, look) {
        crate::windows::mode::apply_mode(app, mode);
    }
    // Redeemed by the workspace's page where it stands, the frame left as the reader has it: on screen, its own sign-in
    // dialog takes it in place (the web's signInDialog.ts); out of sight, it routes there out of sight. _(2026-10-26)
    // This put the workspace in the frame whatever the reader was doing, and remembered it as the face in use._
    crate::windows::tell_workspace(app, &path);
}

/// The page the webview redeems the handoff at. The profile rides along verbatim (setup_link.rs has already
/// reduced it to a known name), and the page consumes it off its query string before its router looks.
///
/// `back=agent` says the sign-in began in a local window. The redemption itself has to happen in the WORKSPACE's page
/// (the platform sets its session cookie over an ordinary HTTP round trip on that origin), which then sends
/// `intentic://launcher?to=agent`, the app's word that a folder waiting on the sign-in can go on (windows/links.rs).
/// Nobody is moved by it: the reader is still in the window they pressed in. _(2026-10-17 to 2026-10-26) It brought
/// the local window that asked forward, on its folder's way to a sandbox._
///
/// The sign-in gate (_tools/e2e/signin/desktop.ts, `e2e-platform` in ci.yml) plays this file's half of the sign-in
/// in TypeScript, `start`'s page and this path included, since it runs the web app without Tauri: a change to
/// either shape changes it there too, or the gate goes on proving a sign-in this app no longer does.
///
/// `via=platform` says the link never came and the app found the hand-off itself; the link's own shape is unchanged.
fn complete_path(
    handoff: &str,
    verifier: &str,
    profile: Option<&str>,
    from_local: bool,
    via: Via,
) -> String {
    let mut path = format!("/desktop-auth/complete?handoff={handoff}&verifier={verifier}");
    if let Some(profile) = profile {
        path.push_str("&profile=");
        path.push_str(profile);
    }
    if from_local {
        path.push_str("&back=agent");
    }
    if via == Via::Platform {
        path.push_str("&via=platform");
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

/// The light to draw the app's faces in before the signed-in page has said, as the profile names it: none once a page
/// has announced the reader's look, which the page then wears instead of the profile's, so drawing the profile's
/// daylight under it would only be a flash of the wrong light (2026-10-25).
fn early_mode(
    profile: Option<&str>,
    look: Option<crate::state::Look>,
) -> Option<crate::state::Mode> {
    if look.is_some() {
        return None;
    }
    mode_of_profile(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(age: Duration, url: &str) -> PendingAuth {
        switching_attempt(age, url, false)
    }

    fn switching_attempt(age: Duration, url: &str, switch_account: bool) -> PendingAuth {
        PendingAuth(Mutex::new(vec![made("state", age, url, switch_account)]))
    }

    fn made(state: &str, age: Duration, url: &str, switch_account: bool) -> PendingAttempt {
        PendingAttempt {
            state: state.into(),
            verifier: format!("verifier-{state}"),
            url: url.into(),
            switch_account,
            asked_in: None,
            started_at: Instant::now() - age,
        }
    }

    fn origin_of(pending: &PendingAuth) -> Option<Option<String>> {
        pending
            .0
            .lock()
            .unwrap()
            .last()
            .map(|attempt| attempt.asked_in.clone())
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
            complete_path("h", "v", None, true, Via::Link),
            "/desktop-auth/complete?handoff=h&verifier=v&back=agent"
        );
        assert_eq!(
            complete_path("h", "v", Some("desk"), true, Via::Link),
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
        assert_eq!(origin_of(&pending), Some(None));
        pending.came_from(Some("files-2".to_string()));
        assert_eq!(origin_of(&pending), Some(Some("files-2".to_string())));
        pending.came_from(None);
        assert_eq!(origin_of(&pending), Some(None));
        // Nothing in flight: nothing to write on, and no panic for writing it.
        PendingAuth::default().came_from(Some("main".to_string()));
    }

    #[test]
    fn the_profile_rides_the_completion_and_names_the_light_the_app_draws_in() {
        assert_eq!(
            complete_path("h", "v", None, false, Via::Link),
            "/desktop-auth/complete?handoff=h&verifier=v"
        );
        assert_eq!(
            complete_path("h", "v", Some("desk"), false, Via::Link),
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

    /* A LOOK THE READER WAS SEEN IN OUTRANKS THE PROFILE'S, so its daylight is never painted early under sanctum. */
    #[test]
    fn a_seen_look_keeps_the_profiles_light_off_the_app() {
        assert_eq!(
            early_mode(Some("desk"), None),
            Some(crate::state::Mode::Light)
        );
        assert_eq!(
            early_mode(Some("desk"), Some(crate::state::Look::Sanctum)),
            None
        );
        assert_eq!(
            early_mode(Some("desk"), Some(crate::state::Look::System)),
            None
        );
        assert_eq!(early_mode(None, None), None);
    }

    /* THE FRESH-INSTALL SIGN-IN (2026-11-20): Google finished in the browser eleven minutes after the press, and the
     * link that reached the app was dropped as one it never asked for. */
    #[test]
    fn a_sign_in_finished_long_after_the_press_is_still_taken() {
        let pending = attempt(Duration::from_secs(11 * 60), "https://old");
        assert_eq!(
            pending.live_url(false),
            None,
            "a press now opens a fresh page"
        );
        let taken = pending
            .take("state")
            .expect("an eleven-minute-old attempt is still answerable");
        assert_eq!(taken.verifier, "verifier-state");
        assert!(pending.answerable().is_empty(), "taken once only");
    }

    #[test]
    fn an_answer_past_its_lifetime_or_for_another_app_is_dropped() {
        let pending = attempt(ANSWER_TTL + Duration::from_secs(1), "https://old");
        assert!(pending.take("state").is_none());
        assert!(pending.answerable().is_empty());
        assert!(attempt(Duration::from_secs(5), "https://a")
            .take("other")
            .is_none());
    }

    /* A press after the first attempt's reuse window used to replace it, so the tab still finishing that attempt came
     * back to an app that had forgotten it. Both stay answerable; whichever answers first ends both. */
    #[test]
    fn a_newer_attempt_keeps_the_older_answerable_and_the_first_answer_ends_both() {
        let pending = PendingAuth::default();
        pending.add(made(
            "first",
            Duration::from_secs(5 * 60),
            "https://first",
            false,
        ));
        pending.add(made(
            "second",
            Duration::from_secs(5),
            "https://second",
            false,
        ));
        assert_eq!(pending.live_url(false).as_deref(), Some("https://second"));
        assert_eq!(
            pending.answerable(),
            vec![
                ("first".to_string(), "verifier-first".to_string()),
                ("second".to_string(), "verifier-second".to_string())
            ]
        );
        assert_eq!(
            pending.take("first").map(|attempt| attempt.url),
            Some("https://first".into())
        );
        assert!(
            pending.take("second").is_none(),
            "signed in already: the other tab's answer is not taken"
        );
    }

    #[test]
    fn only_the_newest_attempts_are_kept() {
        let pending = PendingAuth::default();
        pending.add(made(
            "expired",
            ANSWER_TTL + Duration::from_secs(1),
            "https://x",
            false,
        ));
        for n in 0..(KEEP_ATTEMPTS + 2) {
            pending.add(made(
                &format!("s{n}"),
                Duration::from_secs(1),
                "https://x",
                false,
            ));
        }
        let states: Vec<String> = pending
            .answerable()
            .into_iter()
            .map(|(state, _)| state)
            .collect();
        assert_eq!(states.len(), KEEP_ATTEMPTS);
        assert_eq!(
            states.last().map(String::as_str),
            Some(format!("s{}", KEEP_ATTEMPTS + 1).as_str())
        );
        assert!(!states.contains(&"expired".to_string()));
    }

    /// The platform's answer to "did the browser park a hand-off for this attempt": an id, nothing yet, or a platform
    /// that does not know the question (an older one), which is not asked again.
    #[test]
    fn the_platforms_answer_names_the_parked_handoff() {
        assert_eq!(
            parked_of(200, r#"{"handoff":"h1"}"#),
            Parked::Handoff("h1".into())
        );
        assert_eq!(parked_of(200, "{}"), Parked::Nothing);
        assert_eq!(parked_of(200, r#"{"handoff":""}"#), Parked::Nothing);
        assert_eq!(parked_of(200, "not json"), Parked::Nothing);
        assert_eq!(parked_of(502, ""), Parked::Nothing);
        assert_eq!(parked_of(404, ""), Parked::Unasked);
    }

    /// A hand-off the app found on the platform says so on the page's completion, which counts it.
    #[test]
    fn a_handoff_found_on_the_platform_says_so_on_the_completion() {
        assert_eq!(
            complete_path("h", "v", None, false, Via::Platform),
            "/desktop-auth/complete?handoff=h&verifier=v&via=platform"
        );
    }

    #[test]
    fn an_expired_attempt_makes_way_for_a_fresh_one() {
        assert_eq!(
            attempt(ATTEMPT_TTL + Duration::from_secs(1), "https://old").live_url(false),
            None
        );
    }
}
