/* A LAUNCH THAT NEVER REACHES THE READER, MADE VISIBLE — and a stuck copy that no longer swallows every later one. */
//
// A user's Windows PC restarted for the Docker setup (2026-10-08) and Intentic did not come back: the desktop
// shortcut and the Start menu entry did nothing, and a reinstall was the only way out. Two things made that both
// possible and invisible.
//
// THE HANDOFF WAITS FOREVER. A second launch hands itself to the running copy (tauri-plugin-single-instance) with
// a `SendMessageW`, which has no timeout: a running copy that is stuck makes every launch after it wait, windowless,
// for an answer that never comes. A reinstall "fixed" it because the installer kills every running copy first
// (installer-hooks.nsh). [`begin`] does that one kill itself, before the plugin's handoff, and only to a copy
// of this same program that has been running for a while and does not answer a message that costs nothing.
//
// NOTHING SAID SO. The app's events are sent by its windows' script; a launch that dies or hangs before a window
// has loaded sends nothing, and a crash in Rust leaves no trace a reader of the telemetry can find. Each launch
// now writes down how far it got ([`Stage`]); the next one reads what the last one left and reports a launch that
// never put a window in front of anyone, and a panic hook writes the panic down for the next launch to report.
// Reports wait on disk until they are sent, so a launch that has no network (the first minutes after a restart)
// loses nothing.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// The app's identifier (tauri.conf.json). Needed before Tauri has read its config: for the config folder, and
/// for the names the single-instance plugin gives its window and mutex.
pub const IDENTIFIER: &str = "dev.intentic.desktop";

/// How far a launch got, in order. A launch that ends before `Shown` never put a window in front of anyone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// The process began, and is the copy that will run (not a launch about to hand over to a running copy).
    Starting,
    /// Tauri and its plugins are up: the app's own setup is running.
    Ready,
    /// The first window has been built.
    Window,
    /// A page finished loading in a window: there is something on screen.
    Shown,
    /// The app quit by itself, wherever it had got to.
    Exited,
}

impl Stage {
    fn word(self) -> &'static str {
        match self {
            Stage::Starting => "starting",
            Stage::Ready => "ready",
            Stage::Window => "window",
            Stage::Shown => "shown",
            Stage::Exited => "exited",
        }
    }
}

/// Written before cleanup: session end does not pass through Tauri's ExitRequested.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExitCause {
    Quit,
    Restart,
    Update,
    SessionEnd,
    #[default]
    Unknown,
}

/// What a launch leaves behind about itself, rewritten as it goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub pid: u32,
    /// When the system says this process started, in its own unit: what tells this process from a later one that
    /// was given the same pid (they are reused, and a restart starts the numbering again).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// Unix seconds.
    pub started_at: u64,
    pub version: String,
    pub stage: Stage,
    #[serde(default)]
    pub exit_cause: ExitCause,
}

/// A panic, as the hook wrote it down for the next launch to report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crash {
    pub pid: u32,
    pub message: String,
    pub location: String,
    pub version: String,
    pub at: u64,
}

/// How a launch that never showed a window ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Ending {
    /// Its process was gone by the next launch: it crashed, was killed, or quit before a window loaded.
    Gone,
    /// It was still running, stuck, and the next launch ended it ([`begin`]).
    Replaced,
}

/// One thing for the telemetry, waiting on disk until it is sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Report {
    /// `desktop_launch_stalled`: a launch that never put a window in front of anyone, or one that stopped answering
    /// and was ended by the next launch (`how: replaced`).
    Stalled {
        stage: Stage,
        /// How long it had been running when it was found (Replaced) or how long ago it started (Gone).
        seconds: u64,
        version: String,
        how: Ending,
    },
    /// `desktop_workspace_unreachable`: the workspace could not be loaded at all, and the offline page stood in
    /// for it (offline.rs). Once per launch; sent when the workspace comes back, or by the next launch.
    Unreachable { status: String, version: String },
    /// `desktop_crashed`: a panic.
    Crashed {
        #[serde(default)]
        at: Option<u64>,
        #[serde(default)]
        exit_cause: ExitCause,
        stage: Stage,
        message: String,
        location: String,
        version: String,
    },
    /// Every process start, even when no page reaches its own analytics.
    Launched {
        at: u64,
        launch_id: String,
        face: String,
        previous_exit_reason: ExitCause,
        version: String,
    },
    /// `desktop_engine_restarted`: Intentic's engine stopped answering while this app ran, and the engine keeper
    /// started it again (engine_keeper.rs). `engine` names it, the property every engine event carries.
    EngineRestarted {
        ok: bool,
        seconds: u64,
        attempt: u32,
        reason: Option<String>,
        version: String,
    },
}

/// A running copy is only ever ended once it has had this long to come up: a copy that is still starting may be
/// slow to answer (a first webview after sign-in takes seconds) and is not stuck.
pub const STUCK_AFTER: Duration = Duration::from_secs(60);

/// How long a running copy gets to answer a message that costs it nothing.
#[cfg_attr(not(windows), allow(dead_code))]
pub const ANSWER_WITHIN: Duration = Duration::from_secs(10);

/// At most this many reports wait on disk: a machine that never gets a network must not grow a file forever.
const KEPT_REPORTS: usize = 10;

/// What a launch found about a copy already running, as far as the decision needs.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Running {
    /// No copy is running (or none has its handoff window up yet).
    None,
    /// A copy is running and answered.
    Answering,
    /// A copy is running and did not answer within [`ANSWER_WITHIN`].
    Silent {
        pid: u32,
        /// How long it has been running.
        age: Duration,
        /// Whether it is this same program (same executable): a different install of the app is never ended.
        same_program: bool,
    },
}

/// What this launch does about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing is running: this launch is the app.
    Run,
    /// Hand over to the running copy, as the single-instance plugin does.
    HandOver,
    /// End the stuck copy, then run.
    Replace { pid: u32 },
}

/// Pure: whether a launch replaces what it found running.
pub fn verdict(running: Running) -> Verdict {
    match running {
        Running::None => Verdict::Run,
        Running::Answering => Verdict::HandOver,
        Running::Silent {
            pid,
            age,
            same_program,
        } if same_program && age >= STUCK_AFTER => Verdict::Replace { pid },
        // Young, or not ours: the handoff waits for it, as it always did.
        Running::Silent { .. } => Verdict::HandOver,
    }
}

/// Pure: what the last launch's marker (and its crash, if it panicked) says should be reported, now that this launch
/// knows that process is no longer running. `None` for a launch that showed a window or quit by itself and is gone.
pub fn report_for(
    previous: &Marker,
    crash: Option<&Crash>,
    ended: Ending,
    now: u64,
) -> Option<Report> {
    if let Some(crash) = crash.filter(|crash| crash.pid == previous.pid) {
        return Some(Report::Crashed {
            at: Some(crash.at),
            exit_cause: previous.exit_cause,
            stage: previous.stage,
            message: crash.message.clone(),
            location: crash.location.clone(),
            version: crash.version.clone(),
        });
    }
    // A copy that had to be ended for not answering is reported however far it got: a window that stopped answering
    // is the same dead shortcut to the reader as one that never came up.
    if previous.stage >= Stage::Shown && ended == Ending::Gone {
        return None;
    }
    Some(Report::Stalled {
        stage: previous.stage,
        seconds: now.saturating_sub(previous.started_at),
        version: previous.version.clone(),
        how: ended,
    })
}

/// Pure: a panic's words with this machine's home folder taken out (a path names the account) and cut to a length
/// a dashboard can show.
pub fn scrub(text: &str, home: Option<&str>) -> String {
    let mut text = text.to_string();
    if let Some(home) = home.filter(|home| home.len() > 3) {
        text = text.replace(home, "~");
        // Windows paths come in both spellings.
        text = text.replace(&home.replace('\\', "/"), "~");
    }
    text.chars().take(300).collect()
}

/* WHERE IT IS WRITTEN: the app's config folder, worked out before Tauri is up (it is `app_config_dir`). */
fn config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    let dir = base?.join(IDENTIFIER);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn marker_path(dir: &Path) -> PathBuf {
    dir.join("launch.json")
}

fn crash_path(dir: &Path) -> PathBuf {
    dir.join("crash.json")
}

fn reports_path(dir: &Path) -> PathBuf {
    dir.join("launch-reports.json")
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// This launch: whether it is the copy that runs, and where it writes. Kept for the stage updates.
struct Launch {
    dir: PathBuf,
    marker: Marker,
}

static LAUNCH: Mutex<Option<Launch>> = Mutex::new(None);
static LAUNCH_ID: OnceLock<String> = OnceLock::new();
static REPORTS: Mutex<()> = Mutex::new(());

/// One id per process, also present in windows created long after startup.
pub fn id() -> &'static str {
    LAUNCH_ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

/// The first thing `run` does: the panic hook, the stuck copy, and the marker. Never fails a launch: anything it
/// cannot do it skips.
pub fn begin() {
    let started_at = now();
    install_panic_hook();
    let Some(dir) = config_dir() else {
        return;
    };
    let previous: Option<Marker> = crate::state::read_json(&marker_path(&dir));
    let verdict = verdict(running_copy());
    keep_report(
        &dir,
        Report::Launched {
            at: started_at,
            launch_id: id().to_string(),
            face: if verdict == Verdict::HandOver {
                "handoff"
            } else {
                "none"
            }
            .into(),
            previous_exit_reason: previous
                .as_ref()
                .map_or(ExitCause::Unknown, |last| last.exit_cause),
            version: crate::commands::VERSION.to_string(),
        },
    );
    let replaced = match verdict {
        Verdict::HandOver => return,
        Verdict::Run => None,
        Verdict::Replace { pid } => end_stuck_copy(pid).then_some(pid),
    };
    let pid = std::process::id();
    if let Some(previous) = previous.filter(|previous| previous.pid != pid) {
        let ended = if replaced == Some(previous.pid) {
            Some(Ending::Replaced)
        } else if !alive(&previous) {
            Some(Ending::Gone)
        } else {
            // Still running, with no handoff to answer (it has not got that far, or two launches raced): not this
            // launch's to judge. This launch runs beside it, so it still writes down its own progress below.
            None
        };
        if let Some(ended) = ended {
            let crash: Option<Crash> = crate::state::read_json(&crash_path(&dir));
            if let Some(report) = report_for(&previous, crash.as_ref(), ended, now()) {
                keep_report(&dir, report);
            }
            let _ = std::fs::remove_file(crash_path(&dir));
        }
    }
    let marker = Marker {
        pid,
        identity: process_identity(pid),
        started_at,
        version: crate::commands::VERSION.to_string(),
        stage: Stage::Starting,
        exit_cause: ExitCause::Unknown,
    };
    crate::state::write_json(&marker_path(&dir), &marker);
    *LAUNCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Launch { dir, marker });
}

/// The face actually opened, after local arguments, deep links and the background choice were applied.
pub fn opened(face: &str) {
    if let Some(dir) = config_dir() {
        note_face(&dir, id(), face);
    }
}

/// Rewrites the queue only when this launch's report is in it: with analytics refused, or the report already sent,
/// there is nothing to patch and no file to create.
fn note_face(dir: &Path, launch: &str, face: &str) {
    let _guard = REPORTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = reports_path(dir);
    let Some(mut reports) = crate::state::read_json::<Vec<Report>>(&path) else {
        return;
    };
    let Some(opened) = reports.iter_mut().find_map(|report| match report {
        Report::Launched {
            launch_id, face, ..
        } if launch_id == launch => Some(face),
        _ => None,
    }) else {
        return;
    };
    *opened = face.into();
    crate::state::write_json(&path, &reports);
}

/// A cause known before Exit (our own restart or update). Kept even if Windows ends us directly.
pub fn exiting(cause: ExitCause) {
    let mut launch = LAUNCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(launch) = launch.as_mut() {
        launch.marker.exit_cause = cause;
        crate::state::write_json(&marker_path(&launch.dir), &launch.marker);
    }
}

/// Only an accepted ExitRequested is a quit; Exit on its own is Windows ending the session.
pub fn exit_requested(code: i32) {
    let cause = if code == tauri::RESTART_EXIT_CODE {
        ExitCause::Restart
    } else {
        ExitCause::Quit
    };
    let mut launch = LAUNCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(launch) = launch.as_mut() {
        if launch.marker.exit_cause != ExitCause::Update {
            launch.marker.exit_cause = cause;
        }
        crate::state::write_json(&marker_path(&launch.dir), &launch.marker);
    }
}

/// Windows' updater calls process::exit without the event loop. Record that exit before handing over,
/// but restore the live stage if the installer refuses it.
pub fn updater_exit() -> Option<(Stage, ExitCause)> {
    let mut launch = LAUNCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let launch = launch.as_mut()?;
    let before = (launch.marker.stage, launch.marker.exit_cause);
    if cfg!(windows) {
        launch.marker.stage = Stage::Exited;
    }
    launch.marker.exit_cause = ExitCause::Update;
    crate::state::write_json(&marker_path(&launch.dir), &launch.marker);
    Some(before)
}

pub fn updater_refused(before: Option<(Stage, ExitCause)>) {
    let mut launch = LAUNCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let (Some(launch), Some((stage, cause))) = (launch.as_mut(), before) {
        launch.marker.stage = stage;
        launch.marker.exit_cause = cause;
        crate::state::write_json(&marker_path(&launch.dir), &launch.marker);
    }
}

pub fn exited() {
    let mut launch = LAUNCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(launch) = launch.as_mut() {
        if launch.marker.exit_cause == ExitCause::Unknown {
            launch.marker.exit_cause = ExitCause::SessionEnd;
        }
        launch.marker.stage = Stage::Exited;
        crate::state::write_json(&marker_path(&launch.dir), &launch.marker);
    }
}

/// This launch got as far as `stage`. Only ever forward, and written only when it moves, so the page-load callback
/// that calls this on every load costs one comparison after the first.
pub fn reached(stage: Stage) {
    let mut launch = LAUNCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(launch) = launch.as_mut() else {
        return;
    };
    if stage <= launch.marker.stage {
        return;
    }
    launch.marker.stage = stage;
    crate::state::write_json(&marker_path(&launch.dir), &launch.marker);
}

/// The workspace could not be reached ([`crate::offline`]): kept as a report, once per launch.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn note_unreachable(status: &str) {
    static NOTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if NOTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if let Some(dir) = config_dir() {
        keep_report(
            &dir,
            Report::Unreachable {
                status: status.to_string(),
                version: crate::commands::VERSION.to_string(),
            },
        );
    }
}

/// The engine keeper started Intentic's engine again: kept, then sent right away when there is someone to send to.
pub fn note_engine_restart(
    app: &AppHandle,
    ok: bool,
    seconds: u64,
    attempt: u32,
    reason: Option<String>,
) {
    if let Some(dir) = config_dir() {
        keep_report(
            &dir,
            Report::EngineRestarted {
                ok,
                seconds,
                attempt,
                reason,
                version: crate::commands::VERSION.to_string(),
            },
        );
    }
    send_reports(app);
}

fn keep_report(dir: &Path, report: Report) {
    let _guard = REPORTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !analytics_allowed() {
        return;
    }
    let path = reports_path(dir);
    let mut reports: Vec<Report> = crate::state::read_json(&path).unwrap_or_default();
    reports.push(report);
    let overflow = reports.len().saturating_sub(KEPT_REPORTS);
    reports.drain(..overflow);
    crate::state::write_json(&path, &reports);
}

/* THE PANIC, WRITTEN DOWN: the process is about to end, and the next launch is the only one that can say so. */
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = config_dir() {
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .ok();
            let message = info
                .payload()
                .downcast_ref::<&str>()
                .map(|said| (*said).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "a panic with no message".to_string());
            let location = info
                .location()
                .map(|at| format!("{}:{}", at.file(), at.line()))
                .unwrap_or_default();
            crate::state::write_json(
                &crash_path(&dir),
                &Crash {
                    pid: std::process::id(),
                    message: scrub(&message, home.as_deref()),
                    location: scrub(&location, home.as_deref()),
                    version: crate::commands::VERSION.to_string(),
                    at: now(),
                },
            );
        }
        previous(info);
    }));
}

/* SENT ONCE THERE IS SOMEONE TO SEND TO — from Rust, because a launch whose windows never load has no script. */

/// The analytics key, baked in at build time like the windows' (vite.config.ts): released builds only.
const POSTHOG_KEY: Option<&str> = option_env!("POSTHOG_KEY");
const POSTHOG_HOST: &str = match option_env!("POSTHOG_HOST") {
    Some(host) => host,
    None => "https://us.i.posthog.com",
};

/// On unless this install was switched off. Settings, Data in the workspace window is the one switch
/// (web/src/app/analyticsConsent.ts), and it writes the choice here through `intentic://analytics`; no file means
/// nobody has switched it off. Without a config dir there is nowhere to keep a refusal, so nothing is sent.
pub fn analytics_allowed() -> bool {
    config_dir().is_some_and(
        |dir| match std::fs::read_to_string(dir.join("analytics-consent")) {
            Ok(choice) => choice != "deny",
            Err(_) => true,
        },
    )
}

pub fn set_analytics_consent(choice: &str) {
    if let Some(dir) = config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("analytics-consent"), choice);
        if choice != "allow" {
            let _ = std::fs::remove_file(reports_path(&dir));
        }
    }
}

/// Send what earlier launches left, off the launch's thread. A report is removed once PostHog took it; one that
/// could not be sent stays for the next launch.
pub fn send_reports(app: &AppHandle) {
    if !analytics_allowed() {
        return;
    }
    let Some(dir) = config_dir() else {
        return;
    };
    let path = reports_path(&dir);
    let reports: Vec<Report> = crate::state::read_json(&path).unwrap_or_default();
    if reports.is_empty() {
        return;
    }
    let Some(key) = POSTHOG_KEY.filter(|key| !key.is_empty()) else {
        // A build without a key reports nothing, and keeps nothing either.
        let _ = std::fs::remove_file(&path);
        return;
    };
    static SENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if SENDING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    struct Sending;
    impl Drop for Sending {
        fn drop(&mut self) {
            SENDING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let install_id = app.state::<crate::state::AppState>().install_id();
    tauri::async_runtime::spawn(async move {
        let _sending = Sending;
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
        else {
            return;
        };
        for report in reports {
            if !analytics_allowed() {
                break;
            }
            let body = event_body(key, &install_id, &report);
            let sent = client
                .post(format!("{}/i/v0/e/", POSTHOG_HOST.trim_end_matches('/')))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.to_string())
                .send()
                .await
                .is_ok_and(|response| response.status().is_success());
            if sent {
                // A report may have arrived during the HTTP request. Remove only this one, under the same
                // lock as append, so completing a send never overwrites a new crash/launch/engine report.
                let _guard = REPORTS
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let mut pending: Vec<Report> = crate::state::read_json(&path).unwrap_or_default();
                if let Some(index) = pending.iter().position(|pending| pending == &report) {
                    pending.remove(index);
                }
                if pending.is_empty() {
                    let _ = std::fs::remove_file(&path);
                } else {
                    crate::state::write_json(&path, &pending);
                }
            }
        }
    });
}

/// Pure: the PostHog event for one report, with the properties every desktop event carries (analytics.ts).
pub fn event_body(key: &str, install_id: &str, report: &Report) -> serde_json::Value {
    let (event, mut properties) = match report {
        Report::Stalled {
            stage,
            seconds,
            version,
            how,
        } => (
            "desktop_launch_stalled",
            serde_json::json!({
                "stage": stage.word(),
                "seconds": seconds,
                "launchVersion": version,
                "how": match how { Ending::Gone => "gone", Ending::Replaced => "replaced" },
            }),
        ),
        Report::Unreachable { status, version } => (
            "desktop_workspace_unreachable",
            serde_json::json!({ "status": status, "launchVersion": version }),
        ),
        Report::Crashed {
            stage,
            exit_cause,
            message,
            location,
            version,
            ..
        } => (
            "desktop_crashed",
            serde_json::json!({
                "stage": stage.word(),
                "at_exit": *stage == Stage::Exited,
                "exit_cause": exit_cause,
                "message": message,
                "location": location,
                "launchVersion": version,
            }),
        ),
        Report::Launched {
            launch_id,
            face,
            previous_exit_reason,
            version,
            ..
        } => (
            "desktop_launched",
            serde_json::json!({ "launch_id": launch_id, "face": face, "previous_exit_reason": previous_exit_reason, "launchVersion": version }),
        ),
        Report::EngineRestarted {
            ok,
            seconds,
            attempt,
            reason,
            version,
        } => (
            "desktop_engine_restarted",
            serde_json::json!({
                "engine": "intentic",
                "ok": ok,
                "seconds": seconds,
                "attempt": attempt,
                "reason": reason,
                "launchVersion": version,
            }),
        ),
    };
    properties["client"] = "desktop".into();
    properties["desktop_surface"] = "app".into();
    properties["desktop_version"] = crate::commands::VERSION.into();
    properties["desktop_os"] = std::env::consts::OS.into();
    properties["desktop_install_id"] = install_id.into();
    let mut body = serde_json::json!({
        "api_key": key,
        "event": event,
        "distinct_id": install_id,
        "properties": properties,
    });
    let at = match report {
        Report::Crashed { at, .. } => *at,
        Report::Launched { at, .. } => Some(*at),
        _ => None,
    };
    if let Some(timestamp) = at
        .and_then(|at| time::OffsetDateTime::from_unix_timestamp(at.try_into().ok()?).ok())
        .and_then(|at| {
            at.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
    {
        body["timestamp"] = timestamp.into();
    }
    body
}

/* WHETHER THE LAST LAUNCH'S PROCESS STILL RUNS: its pid, and that it is the same process that wrote the marker. */
fn alive(marker: &Marker) -> bool {
    let now = process_identity(marker.pid);
    match (&marker.identity, now) {
        (_, None) => false,
        (Some(then), Some(now)) => *then == now,
        // A marker that could not read its own identity: trust the pid alone.
        (None, Some(_)) => true,
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn process_identity(pid: u32) -> Option<String> {
    crate::machine_sandbox::start_time_in_stat(
        &std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?,
    )
}

#[cfg(windows)]
pub(crate) fn process_identity(pid: u32) -> Option<String> {
    stuck::creation_time(pid).map(|ticks| ticks.to_string())
}

#[cfg(not(any(target_os = "linux", windows)))]
pub(crate) fn process_identity(_pid: u32) -> Option<String> {
    None
}

#[cfg(windows)]
fn running_copy() -> Running {
    stuck::running_copy()
}

/// Off Windows the plugin hands over by D-Bus, which does not wait forever: nothing to clear.
#[cfg(not(windows))]
fn running_copy() -> Running {
    Running::None
}

#[cfg(windows)]
fn end_stuck_copy(pid: u32) -> bool {
    stuck::end(pid)
}

#[cfg(not(windows))]
fn end_stuck_copy(_pid: u32) -> bool {
    false
}

/* THE RUNNING COPY, AS WINDOWS SEES IT. */
#[cfg(windows)]
mod stuck {
    use super::{Running, ANSWER_WITHIN, IDENTIFIER};
    use std::time::Duration;
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, LPARAM, WPARAM};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenMutexW, OpenProcess, QueryFullProcessImageNameW,
        TerminateProcess, WaitForSingleObject, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        SYNCHRONIZATION_SYNCHRONIZE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetWindowThreadProcessId, SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_BLOCK,
        WM_NULL,
    };

    /// FILETIME's epoch (1601) to the Unix one, in its 100 ns ticks.
    const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

    /// What `GetExitCodeProcess` answers for a process that has not exited.
    const STILL_ACTIVE: u32 = 259;

    struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn open(
        pid: u32,
        access: windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS,
    ) -> Option<Handle> {
        unsafe { OpenProcess(access, false, pid) }.ok().map(Handle)
    }

    /// The process's creation time, in FILETIME ticks; `None` once it has exited. A process that has exited stays
    /// openable, start time and all, for as long as anything holds a handle to it, so its exit code is what says
    /// whether it still runs (`STILL_ACTIVE`, 259).
    pub fn creation_time(pid: u32) -> Option<u64> {
        let process = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(process.0, &mut code) }.ok()?;
        if code != STILL_ACTIVE {
            return None;
        }
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) }
            .ok()?;
        Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn image(pid: u32) -> Option<String> {
        let process = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut buffer = vec![0u16; 1024];
        let mut length = buffer.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                process.0,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
        }
        .ok()?;
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }

    /// The copy that holds the handoff: the single-instance plugin's window (its `{identifier}-sic` class and
    /// `{identifier}-siw` title, tauri-plugin-single-instance's windows.rs), and whether it answers a message
    /// that asks nothing of it.
    pub fn running_copy() -> Running {
        let class = HSTRING::from(format!("{IDENTIFIER}-sic"));
        let title = HSTRING::from(format!("{IDENTIFIER}-siw"));
        let Ok(window) = (unsafe { FindWindowW(&class, &title) }) else {
            return Running::None;
        };
        if window.is_invalid() {
            return Running::None;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
        if pid == 0 || pid == std::process::id() {
            return Running::None;
        }
        let mut result = 0usize;
        let answered = unsafe {
            SendMessageTimeoutW(
                window,
                WM_NULL,
                WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                ANSWER_WITHIN.as_millis() as u32,
                Some(&mut result),
            )
        };
        if answered.0 != 0 {
            return Running::Answering;
        }
        let age = creation_time(pid)
            .and_then(|created| created.checked_sub(UNIX_EPOCH_TICKS))
            .map(|since_epoch| {
                let started =
                    std::time::UNIX_EPOCH + Duration::from_nanos(since_epoch.saturating_mul(100));
                started.elapsed().unwrap_or_default()
            })
            .unwrap_or_default();
        let ours = std::env::current_exe()
            .ok()
            .map(|path| path.to_string_lossy().to_lowercase());
        let same_program = matches!((image(pid), ours), (Some(theirs), Some(ours)) if theirs.to_lowercase() == ours);
        Running::Silent {
            pid,
            age,
            same_program,
        }
    }

    /// End the stuck copy and wait for its handoff to go with it: the plugin's mutex (`{identifier}-sim`) lives
    /// until the last process holding it is gone, and the launches that were waiting on the stuck copy hold it too.
    /// They give up once its window is gone, so the mutex follows in a moment.
    pub fn end(pid: u32) -> bool {
        let Some(process) = open(pid, PROCESS_TERMINATE | PROCESS_SYNCHRONIZE) else {
            return false;
        };
        if unsafe { TerminateProcess(process.0, 1) }.is_err() {
            return false;
        }
        unsafe { WaitForSingleObject(process.0, 5_000) };
        let mutex = HSTRING::from(format!("{IDENTIFIER}-sim"));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &mutex) } {
                Ok(held) => {
                    unsafe {
                        let _ = CloseHandle(held);
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(stage: Stage) -> Marker {
        Marker {
            pid: 4242,
            identity: Some("1".into()),
            started_at: 1_000,
            version: "1.326.0".into(),
            stage,
            exit_cause: ExitCause::Unknown,
        }
    }

    #[test]
    fn a_running_copy_is_ended_only_when_it_is_ours_old_enough_and_silent() {
        assert_eq!(verdict(Running::None), Verdict::Run);
        assert_eq!(verdict(Running::Answering), Verdict::HandOver);
        let stuck = Running::Silent {
            pid: 7,
            age: Duration::from_secs(600),
            same_program: true,
        };
        assert_eq!(verdict(stuck), Verdict::Replace { pid: 7 });
        let starting = Running::Silent {
            pid: 7,
            age: Duration::from_secs(20),
            same_program: true,
        };
        assert_eq!(
            verdict(starting),
            Verdict::HandOver,
            "a copy still coming up is waited for"
        );
        let other_install = Running::Silent {
            pid: 7,
            age: Duration::from_secs(600),
            same_program: false,
        };
        assert_eq!(
            verdict(other_install),
            Verdict::HandOver,
            "another install of the app is never ended"
        );
    }

    #[test]
    fn a_launch_that_showed_a_window_or_quit_is_not_reported() {
        assert_eq!(
            report_for(&marker(Stage::Shown), None, Ending::Gone, 2_000),
            None
        );
        assert_eq!(
            report_for(&marker(Stage::Exited), None, Ending::Gone, 2_000),
            None
        );
    }

    #[test]
    fn a_copy_that_stopped_answering_is_reported_even_after_it_showed_a_window() {
        assert_eq!(
            report_for(&marker(Stage::Shown), None, Ending::Replaced, 1_300),
            Some(Report::Stalled {
                stage: Stage::Shown,
                seconds: 300,
                version: "1.326.0".into(),
                how: Ending::Replaced,
            })
        );
    }

    #[test]
    fn a_launch_that_never_showed_a_window_is_reported_with_how_far_it_got() {
        assert_eq!(
            report_for(&marker(Stage::Ready), None, Ending::Gone, 1_090),
            Some(Report::Stalled {
                stage: Stage::Ready,
                seconds: 90,
                version: "1.326.0".into(),
                how: Ending::Gone,
            })
        );
        let replaced = report_for(&marker(Stage::Window), None, Ending::Replaced, 1_600);
        assert!(
            matches!(
                replaced,
                Some(Report::Stalled {
                    how: Ending::Replaced,
                    seconds: 600,
                    ..
                })
            ),
            "{replaced:?}"
        );
    }

    #[test]
    fn a_panic_outranks_the_stage_it_happened_at() {
        let crash = Crash {
            pid: 4242,
            message: "boom".into(),
            location: "src/lib.rs:297".into(),
            version: "1.326.0".into(),
            at: 1_010,
        };
        // Even after a window was shown: a crash is a crash.
        assert_eq!(
            report_for(&marker(Stage::Shown), Some(&crash), Ending::Gone, 2_000),
            Some(Report::Crashed {
                at: Some(1_010),
                exit_cause: ExitCause::Unknown,
                stage: Stage::Shown,
                message: "boom".into(),
                location: "src/lib.rs:297".into(),
                version: "1.326.0".into(),
            })
        );
        // Another process's crash file says nothing about this one.
        let theirs = Crash { pid: 1, ..crash };
        assert!(matches!(
            report_for(&marker(Stage::Ready), Some(&theirs), Ending::Gone, 2_000),
            Some(Report::Stalled { .. })
        ));
    }

    #[test]
    fn a_panic_message_loses_the_home_folder_and_its_length() {
        let said = scrub(
            r"could not read C:\Users\Ann Smith\AppData\Roaming\dev.intentic.desktop\x.json and C:/Users/Ann Smith/y",
            Some(r"C:\Users\Ann Smith"),
        );
        assert_eq!(
            said,
            r"could not read ~\AppData\Roaming\dev.intentic.desktop\x.json and ~/y"
        );
        assert_eq!(scrub(&"x".repeat(1000), None).len(), 300);
    }

    #[test]
    fn stages_only_count_forward() {
        assert!(Stage::Starting < Stage::Ready);
        assert!(Stage::Ready < Stage::Window);
        assert!(Stage::Window < Stage::Shown);
        assert!(Stage::Shown < Stage::Exited);
    }

    #[test]
    fn the_event_carries_what_every_desktop_event_carries() {
        let body = event_body(
            "phc_test",
            "install-1",
            &Report::Stalled {
                stage: Stage::Window,
                seconds: 12,
                version: "1.326.0".into(),
                how: Ending::Replaced,
            },
        );
        assert_eq!(body["event"], "desktop_launch_stalled");
        assert_eq!(body["distinct_id"], "install-1");
        assert_eq!(body["properties"]["stage"], "window");
        assert_eq!(body["properties"]["how"], "replaced");
        assert_eq!(body["properties"]["client"], "desktop");
        assert_eq!(body["properties"]["desktop_install_id"], "install-1");
    }

    #[test]
    fn crash_time_and_exit_cause_survive_the_next_launch() {
        let crash = Crash {
            pid: 4242,
            message: "boom".into(),
            location: "runner.rs:371".into(),
            version: "1.338.0".into(),
            at: 1_010,
        };
        for (stage, at_exit) in [(Stage::Shown, false), (Stage::Exited, true)] {
            let mut previous = marker(stage);
            previous.exit_cause = ExitCause::SessionEnd;
            let report = report_for(&previous, Some(&crash), Ending::Gone, 2_000).unwrap();
            let body = event_body("key", "install", &report);
            assert_eq!(body["timestamp"], "1970-01-01T00:16:50Z");
            assert_eq!(body["properties"]["at_exit"], at_exit);
            assert_eq!(body["properties"]["exit_cause"], "session-end");
        }
    }

    #[test]
    fn old_markers_and_queued_crashes_still_read() {
        let previous: Marker = serde_json::from_str(
            r#"{"pid":4242,"startedAt":1000,"version":"old","stage":"exited"}"#,
        )
        .unwrap();
        assert_eq!(previous.exit_cause, ExitCause::Unknown);
        let queued: Report = serde_json::from_str(r#"{"kind":"crashed","stage":"exited","message":"boom","location":"runner.rs","version":"old"}"#).unwrap();
        let body = event_body("key", "install", &queued);
        assert_eq!(body["properties"]["at_exit"], true);
        assert_eq!(body["properties"]["exit_cause"], "unknown");
        assert_eq!(body.get("timestamp"), None);
    }

    #[test]
    fn the_opened_face_patches_only_this_launch_and_writes_nothing_when_nothing_is_queued() {
        let dir =
            std::env::temp_dir().join(format!("intentic-face-report-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Nothing queued (analytics refused, or already sent): no reports file appears.
        note_face(&dir, "launch-1", "workspace");
        assert!(!reports_path(&dir).exists());

        let launched = |id: &str| Report::Launched {
            at: 1_000,
            launch_id: id.into(),
            face: "none".into(),
            previous_exit_reason: ExitCause::Unknown,
            version: "1".into(),
        };
        crate::state::write_json(
            &reports_path(&dir),
            &vec![launched("launch-0"), launched("launch-1")],
        );
        note_face(&dir, "launch-1", "tray");
        let faces: Vec<String> = crate::state::read_json::<Vec<Report>>(&reports_path(&dir))
            .unwrap()
            .into_iter()
            .filter_map(|report| match report {
                Report::Launched { face, .. } => Some(face),
                _ => None,
            })
            .collect();
        assert_eq!(faces, ["none", "tray"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn launch_event_identifies_its_process_and_opened_face() {
        let body = event_body(
            "key",
            "install",
            &Report::Launched {
                at: 1_000,
                launch_id: "launch-1".into(),
                face: "workspace".into(),
                previous_exit_reason: ExitCause::Update,
                version: "new".into(),
            },
        );
        assert_eq!(body["event"], "desktop_launched");
        assert_eq!(body["timestamp"], "1970-01-01T00:16:40Z");
        assert_eq!(body["properties"]["launch_id"], "launch-1");
        assert_eq!(body["properties"]["face"], "workspace");
        assert_eq!(body["properties"]["previous_exit_reason"], "update");
        assert_eq!(uuid::Uuid::parse_str(id()).unwrap().get_version_num(), 4);
    }

    #[test]
    fn the_identifier_is_the_apps() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        assert_eq!(
            config["identifier"], IDENTIFIER,
            "the single-instance names and the config folder follow it"
        );
    }

    #[test]
    fn a_marker_round_trips() {
        let written = serde_json::to_string(&marker(Stage::Window)).unwrap();
        assert!(written.contains("\"stage\":\"window\""), "{written}");
        let back: Marker = serde_json::from_str(&written).unwrap();
        assert_eq!(back, marker(Stage::Window));
    }
}
