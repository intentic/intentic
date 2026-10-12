//! FIRST RUN (2026-10-09): this PC's read-only check at launch, the download started at first launch, and the PC's own
//! setup behind the reader's one "Set up this PC", for This computer's card (the web's localHost.ts
//! `LocalOnboardingHost`, drawn by src/device/pcSetup/PcSetupCard.vue; the app's half is src/onboarding/pc.ts).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::PoisonError;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::notice;
use crate::prefetch;
use crate::scripts::{self, Heard, Stream};
use crate::setup_link::{NoticeArgs, NoticeKind};
#[cfg(windows)]
use crate::state::SessionEnd;

pub const EVENT: &str = "desktop://onboarding";

const RUN_SETUP: &str = "pc-setup";
const RUN_ENGINE: &str = "pc-engine";
const RUN_IMAGE: &str = "pc-image";

/// Cache downloads that an update may pause and resume on the next launch. The PC setup itself is never in this set.
pub const PREFETCH_RUNS: [&str; 2] = [RUN_ENGINE, RUN_IMAGE];

#[cfg_attr(not(windows), allow(dead_code))]
const PREPARE_DEADLINE: Duration = Duration::from_secs(120);
#[cfg_attr(not(windows), allow(dead_code))]
const METERED_DEADLINE: Duration = Duration::from_secs(15);
const PREFETCH_START_DELAY: Duration = Duration::from_secs(3);
const METERED_RECHECK: Duration = Duration::from_secs(5 * 60);
/// How often the download's loop looks again while it waits (paused, stepped aside, a retry not yet due).
const PREFETCH_TICK: Duration = Duration::from_secs(2);
/// A failed download tries once more by itself after this long, then gives up for this run of the app. Long enough
/// for a dropped connection or a Wi-Fi hand-over to settle; short enough that the reader still sees it happen. `ic`
/// already retries a stopped layer four times itself, so what reaches here is rarely a blip.
const PREFETCH_RETRY_DELAY: Duration = Duration::from_secs(30);

/* THE DOWNLOAD STEPS ASIDE FOR A REAL INSTALL (2026-10-12). On a Windows PC set up by hand (Docker Desktop installed by
 * the reader), the download started at first launch was still running when the sandbox's own setup reached its pull:
 * it held the image cache's lock (`ic` image_cache.rs `try_lock`), and the setup's connect sat watching it instead of
 * pulling, behind a bar that said nothing. A setup that pulls the image does the same work itself, and its progress is
 * the one the reader is watching, so while one runs the download is stopped (which releases the lock: it is an OS lock
 * on a file, held by the `ic` process) and comes back after it only if there is still something to fetch. */

/// Runs that set a sandbox up on this machine and pull its image as they go: the setup handed over from the workspace
/// (commands.rs `setup_run`) and this computer's own sandbox (machine_sandbox.rs). This PC's own setup (`pc-setup`,
/// WSL and the engine) is not one of them: the download exists to overlap exactly that wait.
const INSTALL_RUNS: [&str; 2] = ["setup", crate::machine_sandbox::RUN];
/// How long a setup announced by prefetch.rs `begin_for_setup` counts as running before its run is registered.
const INSTALL_ANNOUNCE_GRACE: Duration = Duration::from_secs(30);

/* A SETUP THAT NEVER REPORTS BACK (2026-10-12). On 2026-10-12 a reader pressed "Set up this PC" and nothing came back
 * for almost two hours: no outcome, no failure, a bar that did not move. `ic docker prepare --yes` prints a line at
 * every step and while it downloads; its silent stretches are the ones Windows itself runs (DISM turning the WSL
 * features on, an installer unpacking), which can take minutes without a word, ten or so on a slow disk. Twenty minutes
 * with no line at all is well past that, and still short of the point where someone gives up and closes the app (the
 * reader of 2026-10-12 waited nineteen on the install that followed), so that is when the page says it has gone quiet
 * and offers a way on. */
const SETUP_STALL_AFTER: Duration = Duration::from_secs(20 * 60);
const SETUP_STALL_CHECK: Duration = Duration::from_secs(30);

#[cfg_attr(not(windows), allow(dead_code))]
const REQUIREMENT: &str = "intentic-requirement: ";
const REQUIREMENT_STATE: &str = "intentic-requirement-state: ";
#[cfg_attr(not(windows), allow(dead_code))]
const PREPARE_SUMMARY: &str = "intentic-prepare-summary: ";

/// `ic docker prepare` stopped after the reader closed or ignored Windows' permission prompt (`prepare/mod.rs` → `Fail` → exit 1).
const EXIT_PREPARE_FAILED: i32 = 1;
#[cfg_attr(not(windows), allow(dead_code))]
const EXIT_NEEDS_CONSENT: i32 = 3;
#[cfg_attr(not(windows), allow(dead_code))]
const EXIT_NEEDS_RESTART: i32 = 4;

const PREFETCH_MARKER: &str = "intentic-prefetch: ";
const FIRST_LAUNCH_FILE: &str = "onboarding-first-launch-seen";
const RESTART_NOTICE_KEY: &str = "onboarding-restart-soon";

static SETUP_RUNNING: AtomicBool = AtomicBool::new(false);
/// The running setup is being stopped to start it again ("Start again" on a quiet one): its end is not an outcome.
static SETUP_RESTARTING: AtomicBool = AtomicBool::new(false);
/// When the PC setup last said anything, in ms since the epoch.
static SETUP_LAST_LINE_MS: AtomicU64 = AtomicU64::new(0);
static PREFETCH_PAUSED: AtomicBool = AtomicBool::new(false);
static PREFETCH_ACTIVE: AtomicBool = AtomicBool::new(false);
/// The download's loop is running (at most one).
static PREFETCH_LOOP: AtomicBool = AtomicBool::new(false);
/// The reader chose "Download anyway" on a metered connection.
static PREFETCH_ANYWAY: AtomicBool = AtomicBool::new(false);
/// A setup started, and the download it stopped is to read as stepped aside rather than failed.
static PREFETCH_YIELDING: AtomicBool = AtomicBool::new(false);
/// This run of the app's one automatic retry after a failed download has been spent.
static PREFETCH_RETRIED: AtomicBool = AtomicBool::new(false);
/// When prefetch.rs last announced a setup about to start, in ms since the epoch (0: never).
static INSTALL_ANNOUNCED_MS: AtomicU64 = AtomicU64::new(0);
static RESTART_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineParts {
    pub os: String,
    pub build: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpus: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub virtualization: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRow {
    pub id: String,
    pub state: String,
    /// The row in `ic`'s own words (its `title`): what the page says for an id it has no words of its own for, rather
    /// than the bare id (a newer `ic`'s requirement, or one the catalog never named).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub admin: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub state: String,
    pub rows: Vec<CheckRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineParts>,
    pub restart: bool,
    pub admin: bool,
    pub download_bytes: u64,
    pub minutes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

/// The download started at first launch. `state`: `idle`, `running`, `paused` (the reader's, or an update's), `metered`,
/// `yielded` (stepped aside while a setup pulls the image itself), `done`, `skipped` (nothing to fetch) or `failed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefetch {
    pub state: String,
    pub done: u64,
    pub total: u64,
    /// Which try of this run of the app is (or was last) running, from 1; 0 before the first.
    #[serde(default)]
    pub attempt: u32,
    /// Why the last try stopped, while `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<PrefetchFailure>,
    /// While `failed`: when the one automatic retry starts, in seconds since the epoch. Absent once it has given up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<u64>,
    /// While `skipped`: `imageInDocker` (Docker is up and has the image), `dockerPulls` (Docker is installed and
    /// nothing was half-fetched: it pulls the image itself), or `elsewhere` (another `ic` holds the cache and is fetching).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
}

impl Default for Prefetch {
    fn default() -> Self {
        Prefetch {
            state: "idle".into(),
            done: 0,
            total: 0,
            attempt: 0,
            failure: None,
            retry_at: None,
            skipped: None,
        }
    }
}

/// How a try of the download stopped, as the page shows it and the funnel hears it (the page scrubs `reason` of the
/// home folder and any other path before it sends it anywhere: src/onboarding/pcEvents.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchFailure {
    /// `engine` (`ic engine fetch`) or `image` (`ic image prefetch`).
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// The last thing it said that explains it, on one line.
    pub reason: String,
    /// Its transcript, when one was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Setup {
    #[default]
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "running")]
    Running {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        percent: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        needs_you: Option<bool>,
    },
    #[serde(rename = "waiting")]
    Waiting {
        #[serde(rename = "for")]
        for_: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        restart_at: Option<u64>,
    },
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "failed")]
    Failed { reason: String },
}

/// What a finished `ic docker prepare --yes` run means for setup and optionally the check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupApply {
    pub setup: Setup,
    pub check_state: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct Store {
    check: Option<Check>,
    prefetch: Prefetch,
    setup: Setup,
    first_launch_seen: bool,
    first_launch_in_next_payload: bool,
    restart_scheduled_at: Option<u64>,
    setup_track_ids: Vec<String>,
    setup_row_states: HashMap<String, String>,
    /// The running setup is the one a restart waited for (the park file was there at launch), and when it parked.
    setup_resumed: bool,
    setup_parked_at: Option<u64>,
    /// When the running setup started (seconds since the epoch), and the requirement it is on: what the ledger keeps.
    setup_started_at: u64,
    setup_row: Option<String>,
    /// The running setup has said nothing since this (seconds since the epoch), for [`SETUP_STALL_AFTER`] or more.
    setup_quiet_since: Option<u64>,
    /// Its transcript, found when it went quiet, for "Show the log".
    setup_log: Option<String>,
    /// A setup that was running when the app last ended, with no outcome: told to the page once.
    orphaned_in_next_payload: Option<Value>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

fn lock_store<T>(f: impl FnOnce(&mut Store) -> T) -> T {
    let mut guard = store().lock().unwrap_or_else(PoisonError::into_inner);
    f(&mut guard)
}

fn emit(app: &AppHandle) {
    let payload = snapshot_payload(app, false);
    let _ = app.emit(EVENT, payload);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

fn setup_json(setup: &Setup) -> Value {
    match setup {
        Setup::Idle => json!({ "state": "idle" }),
        Setup::Running {
            step,
            percent,
            needs_you,
        } => {
            let mut value = json!({ "state": "running", "step": step, "percent": percent });
            if needs_you == &Some(true) {
                value["needsYou"] = json!(true);
            }
            value
        }
        Setup::Waiting { for_, restart_at } => {
            let mut value = json!({ "state": "waiting", "for": for_ });
            if let Some(at) = restart_at {
                value["restartAt"] = json!(at);
            }
            value
        }
        Setup::Ready => json!({ "state": "ready" }),
        Setup::Failed { reason } => json!({ "state": "failed", "reason": reason }),
    }
}

fn first_launch_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(FIRST_LAUNCH_FILE))
}

fn first_launch_seen_on_disk(app: &AppHandle) -> bool {
    first_launch_path(app).is_some_and(|path| path.is_file())
}

fn mark_first_launch_seen(app: &AppHandle) {
    if let Some(path) = first_launch_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, b"1");
    }
}

fn load_first_launch(app: &AppHandle) {
    let seen = first_launch_seen_on_disk(app);
    lock_store(|store| {
        store.first_launch_seen = seen;
        store.first_launch_in_next_payload = !seen;
    });
}

/// Whether the first-launch prefetch has finished, had nothing to do, or given up — the office editor waits on this
/// (sidecar.rs). A failure with its automatic retry still to come has not given up.
pub fn prefetch_settled() -> bool {
    lock_store(|store| settled(&store.prefetch))
}

fn settled(prefetch: &Prefetch) -> bool {
    match prefetch.state.as_str() {
        "done" | "skipped" => true,
        "failed" => prefetch.retry_at.is_none(),
        _ => false,
    }
}

/// The check alone, for the machine sandbox supervisor.
pub fn check_snapshot() -> Option<Check> {
    lock_store(|store| store.check.clone())
}

/// Whether the PC's own setup is still running.
pub fn setup_running() -> bool {
    SETUP_RUNNING.load(Ordering::SeqCst)
}

/// The machine sandbox's consent on a PC that still needs Docker/WSL: run the PC setup instead of a sandbox connect.
pub fn start_pc_setup_if_needed(app: &AppHandle, consent: bool) -> bool {
    let needs = check_snapshot()
        .is_some_and(|check| matches!(check.state.as_str(), "needsSetup" | "unknown" | "checking"))
        && !scripts::engine_listening();
    if !(needs && consent) || SETUP_RUNNING.swap(true, Ordering::SeqCst) {
        return false;
    }
    mark_setup_started(app, None);
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = run_pc_setup(&app);
        SETUP_RUNNING.store(false, Ordering::SeqCst);
    });
    true
}

/// A setup starting now, as the page draws it from its first moment. `resumed`: the park the restart left, and when
/// it was written (if it says), for a setup the restart was waited for. The caller holds [`SETUP_RUNNING`].
fn mark_setup_started(app: &AppHandle, resumed: Option<Option<u64>>) {
    begin_setup_rows();
    let started_at = now_secs();
    lock_store(|store| {
        store.setup = Setup::Running {
            step: None,
            percent: 0,
            needs_you: None,
        };
        store.setup_resumed = resumed.is_some();
        store.setup_parked_at = resumed.flatten();
        store.setup_started_at = started_at;
        store.setup_row = None;
        store.setup_quiet_since = None;
        store.setup_log = None;
    });
    SETUP_LAST_LINE_MS.store(now_ms(), Ordering::SeqCst);
    write_running_ledger(started_at, None);
    emit(app);
}

/// Start the read-only check and the first-launch prefetch (lib.rs setup).
pub fn begin(app: &AppHandle) {
    load_first_launch(app);
    // Read before a resumed setup below writes its own: a ledger still here is a setup the last run of the app never
    // saw end.
    if let Some(orphaned) = take_running_ledger() {
        lock_store(|store| store.orphaned_in_next_payload = Some(orphaned));
    }
    let handle = app.clone();
    std::thread::spawn(move || run_check(&handle));
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PREFETCH_START_DELAY);
        ensure_prefetch_loop(&handle);
    });
    if resume_wanted() {
        let parked_at = parked_at();
        let handle = app.clone();
        std::thread::spawn(move || {
            if SETUP_RUNNING.swap(true, Ordering::SeqCst) {
                return;
            }
            mark_setup_started(&handle, Some(parked_at));
            let _ = run_pc_setup(&handle);
            SETUP_RUNNING.store(false, Ordering::SeqCst);
        });
    }
}

/// The check, the download and the setup as they stand. The page asks this once it listens (src/onboarding/pc.ts), so
/// what is told only once (the first launch, a setup the last run left behind) goes here and never in an event, which
/// a page not listening yet would miss.
#[tauri::command]
pub fn onboarding_state(app: AppHandle) -> Value {
    snapshot_payload(&app, true)
}

/// The setup as the page reads it: its state, and while it runs, whether it is the one a restart was waited for and
/// whether it has gone quiet. Pure.
fn setup_payload(store: &Store) -> Value {
    let mut setup = setup_json(&store.setup);
    if matches!(store.setup, Setup::Running { .. }) {
        if store.setup_resumed {
            setup["resumed"] = json!(true);
            if let Some(at) = store.setup_parked_at {
                setup["parkedAt"] = json!(at);
            }
        }
        if let Some(since) = store.setup_quiet_since {
            setup["quietSince"] = json!(since);
            if let Some(log) = &store.setup_log {
                setup["log"] = json!(log);
            }
        }
    }
    setup
}

fn snapshot_payload(app: &AppHandle, asked: bool) -> Value {
    let (payload, mark_seen) = lock_store(|store| {
        let mut payload = json!({
            "check": store.check,
            "prefetch": store.prefetch,
            "setup": setup_payload(store),
        });
        if !asked {
            return (payload, false);
        }
        if let Some(orphaned) = store.orphaned_in_next_payload.take() {
            payload["orphaned"] = orphaned;
        }
        if store.first_launch_in_next_payload {
            payload["firstLaunch"] = json!(true);
            store.first_launch_in_next_payload = false;
            store.first_launch_seen = true;
            (payload, true)
        } else {
            (payload, false)
        }
    });
    if mark_seen {
        mark_first_launch_seen(app);
    }
    payload
}

/// The read-only check of this PC again.
#[tauri::command]
pub async fn onboarding_recheck(app: AppHandle) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_check(&app);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// "Set up this PC": the reader's one consent. `again`: a setup that has gone quiet is stopped first and started anew
/// ("Start again" on the page); without it a setup already running is left to run, and this does nothing.
#[tauri::command]
pub async fn onboarding_set_up(app: AppHandle, again: Option<bool>) -> Result<(), String> {
    if again == Some(true) && SETUP_RUNNING.load(Ordering::SeqCst) {
        tauri::async_runtime::spawn_blocking(stop_setup_to_start_again)
            .await
            .map_err(|error| error.to_string())??;
    }
    if SETUP_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    mark_setup_started(&app, None);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_pc_setup(&app);
        SETUP_RUNNING.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Stop the running setup, and everything it started, so it can start again; its end is not reported as an outcome.
fn stop_setup_to_start_again() -> Result<(), String> {
    SETUP_RESTARTING.store(true, Ordering::SeqCst);
    let stopped = wait_until_stopped(&SETUP_RUNNING, Duration::from_secs(15), || {
        if scripts::is_running(RUN_SETUP) {
            scripts::stop(RUN_SETUP)?;
        }
        Ok(())
    });
    SETUP_RESTARTING.store(false, Ordering::SeqCst);
    stopped.map_err(|error| match error {
        Some(error) => format!(
            "The setup that stopped answering could not be stopped ({error}). Restart this PC, then set it up again."
        ),
        None => "The setup that stopped answering has not stopped yet. Restart this PC, then set it up again."
            .into(),
    })
}

/// Pause or resume the download started at first launch. Resuming one that failed starts it again ("Try again").
#[tauri::command]
pub fn onboarding_pause(app: AppHandle, paused: bool) -> Result<(), String> {
    if paused {
        PREFETCH_PAUSED.store(true, Ordering::SeqCst);
        let _ = scripts::stop(RUN_ENGINE);
        let _ = scripts::stop(RUN_IMAGE);
        lock_store(|store| {
            // Paused while metered too: a resume then asks the connection again, where "Download anyway" does not.
            if matches!(
                store.prefetch.state.as_str(),
                "running" | "yielded" | "metered"
            ) {
                store.prefetch.state = "paused".into();
            }
        });
    } else {
        PREFETCH_PAUSED.store(false, Ordering::SeqCst);
        lock_store(|store| match store.prefetch.state.as_str() {
            "metered" => PREFETCH_ANYWAY.store(true, Ordering::SeqCst),
            // Due now: the loop starts it on its next look, as it does the automatic retry.
            "failed" => store.prefetch.retry_at = Some(now_secs()),
            _ => {}
        });
        ensure_prefetch_loop(&app);
    }
    emit(&app);
    Ok(())
}

/// Stop the resumable cache downloads before replacing this app. Wait for the worker as well as its current child:
/// a pause can land just before the child starts, or between the engine and image phases. No new worker can start
/// while paused. Return whether a failed update should resume a download the person had not paused themselves.
pub fn pause_for_update(app: &AppHandle) -> Result<bool, String> {
    let resume = !PREFETCH_PAUSED.load(Ordering::SeqCst);
    onboarding_pause(app.clone(), true)?;
    let stopped = wait_for_prefetch_stop(&PREFETCH_ACTIVE, Duration::from_secs(5), || {
        for id in PREFETCH_RUNS {
            if scripts::is_running(id) {
                scripts::stop(id)?;
            }
        }
        Ok(())
    });
    if stopped.is_err() && resume {
        let _ = onboarding_pause(app.clone(), false);
    }
    stopped.map(|()| resume)
}

fn wait_for_prefetch_stop(
    active: &AtomicBool,
    timeout: Duration,
    stop: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    wait_until_stopped(active, timeout, stop).map_err(|error| match error {
        Some(error) => {
            format!("The background download has not stopped yet: {error}. Try the update again.")
        }
        None => "The background download has not stopped yet. Try the update again.".into(),
    })
}

/// Call `stop` until `active` is cleared, or `timeout` runs out with it still set: then the last error `stop` gave.
fn wait_until_stopped(
    active: &AtomicBool,
    timeout: Duration,
    mut stop: impl FnMut() -> Result<(), String>,
) -> Result<(), Option<String>> {
    let until = std::time::Instant::now() + timeout;
    let mut stop_error = None;
    while active.load(Ordering::SeqCst) {
        // follow() forgets a PID after joining its readers. TERM may fail against an already exited child
        // during that interval; only a worker that remains active at the deadline should refuse.
        if let Err(error) = stop() {
            stop_error = Some(error);
        }
        if std::time::Instant::now() >= until && active.load(Ordering::SeqCst) {
            return Err(stop_error);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn cancel_scheduled_restart(app: &AppHandle) {
    RESTART_GENERATION.fetch_add(1, Ordering::SeqCst);
    notice::withdraw(app, RESTART_NOTICE_KEY);
    lock_store(|store| store.restart_scheduled_at = None);
}

/// The restart the setup waits for: `now`, `in10Minutes` or `later`.
#[tauri::command]
pub fn onboarding_restart(app: AppHandle, when: String) -> Result<(), String> {
    match when.as_str() {
        "now" => {
            cancel_scheduled_restart(&app);
            restart_now(&app)
        }
        "in10Minutes" => {
            cancel_scheduled_restart(&app);
            schedule_restart(&app, Duration::from_secs(10 * 60))
        }
        "later" => {
            cancel_scheduled_restart(&app);
            emit(&app);
            #[cfg(windows)]
            crate::resume::register().map_err(|error| error.to_string())?;
            Ok(())
        }
        other => Err(format!("unknown restart choice: {other}")),
    }
}

/// A machine we host instead, for a PC that cannot run a sandbox.
#[tauri::command]
pub async fn onboarding_use_cloud(app: AppHandle) -> Result<(), String> {
    crate::commands::workspace_open(app, Some("/setup?elsewhere=1&machine=hosted".into())).await;
    Ok(())
}

#[cfg(windows)]
fn restart_now(_app: &AppHandle) -> Result<(), String> {
    park_pc_setup();
    crate::commands::end_session(SessionEnd::Restart)
}

#[cfg(not(windows))]
fn restart_now(_app: &AppHandle) -> Result<(), String> {
    Err("Restart is only scheduled on Windows.".into())
}

fn schedule_restart(app: &AppHandle, delay: Duration) -> Result<(), String> {
    let generation = RESTART_GENERATION.load(Ordering::SeqCst);
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + delay.as_secs();
    lock_store(|store| store.restart_scheduled_at = Some(at));
    if let Setup::Waiting { for_, .. } = lock_store(|store| store.setup.clone()) {
        if for_ == "restart" {
            lock_store(|store| {
                store.setup = Setup::Waiting {
                    for_: for_.clone(),
                    restart_at: Some(at),
                };
            });
        }
    }
    emit(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let warn = delay.saturating_sub(Duration::from_secs(60));
        if !warn.is_zero() {
            std::thread::sleep(warn);
        }
        if RESTART_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        notice::show(
            &app,
            NoticeArgs {
                key: RESTART_NOTICE_KEY.into(),
                kind: NoticeKind::Asks,
                title: "Restarting this PC in one minute".into(),
                body: Some(
                    "Save your work in other apps. Open Intentic to restart now or cancel the restart."
                        .into(),
                ),
                path: Some(notice::THIS_DEVICE.into()),
                silent: false,
            },
        );
        std::thread::sleep(Duration::from_secs(60));
        if RESTART_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let _ = restart_now(&app);
    });
    Ok(())
}

fn run_check(app: &AppHandle) {
    let check = {
        #[cfg(windows)]
        {
            ic_prepare_dry_run(app).unwrap_or_else(|reason| Check {
                state: "unknown".into(),
                rows: vec![CheckRow {
                    id: "check".into(),
                    state: "blocked".into(),
                    title: None,
                    detail: Some(reason),
                    admin: false,
                }],
                ..Default::default()
            })
        }
        #[cfg(not(windows))]
        {
            check_unix()
        }
    };
    lock_store(|store| store.check = Some(check));
    emit(app);
    crate::machine_sandbox::kick();
}

#[cfg(not(windows))]
fn check_unix() -> Check {
    let ready = scripts::docker_ready();
    Check {
        state: if ready { "ready" } else { "needsSetup" }.into(),
        rows: Vec::new(),
        engine: Some("native".into()),
        ..Default::default()
    }
}

#[cfg(windows)]
fn ic_prepare_dry_run(_app: &AppHandle) -> Result<Check, String> {
    let ic = crate::commands::bundled_ic().ok_or("ic missing")?;
    let mut command = std::process::Command::new(&ic);
    if let Some(dir) = ic.parent() {
        command.current_dir(dir);
    }
    command.args(["docker", "prepare", "--dry-run"]);
    command.envs(crate::commands::app_env(crate::commands::VERSION));
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    intentic_bounded::no_window(&mut command);
    let answer = scripts::capture("ic docker prepare --dry-run", command, PREPARE_DEADLINE)
        .map_err(|silence| silence.to_string())?;
    parse_prepare_output(&answer.stdout)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn parse_prepare_output(text: &str) -> Result<Check, String> {
    let mut unmet = Vec::new();
    let mut summary: Option<Value> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(json) = line.strip_prefix(REQUIREMENT) {
            if let Ok(value) = serde_json::from_str::<Value>(json) {
                unmet.push(row_from_requirement(&value, false));
            }
        } else if let Some(json) = line.strip_prefix(PREPARE_SUMMARY) {
            summary = serde_json::from_str(json).ok();
        }
    }
    let summary = summary.ok_or("prepare ended without a summary line")?;
    let state = summary["state"].as_str().unwrap_or("unknown").to_string();
    let mut rows = unmet;
    if let Some(met) = summary["met"].as_array() {
        for item in met {
            rows.push(row_from_requirement(item, true));
        }
    }
    Ok(Check {
        state,
        rows,
        machine: summary.get("machine").and_then(parse_machine),
        restart: summary["restart"].as_bool().unwrap_or(false),
        admin: summary["admin"].as_bool().unwrap_or(false),
        download_bytes: summary["downloadBytes"].as_u64().unwrap_or(0),
        minutes: summary["minutes"].as_u64().unwrap_or(0) as u32,
        engine: summary["engine"].as_str().map(str::to_string),
    })
}

/// Whose a requirement `ic` reported is, by its `action` (prepare/plan.rs `Action::id`): ours to do with the reader's
/// consent (`fix`, and `fixElevated` behind Windows' permission prompt, which is still Intentic's own fix), the reader's
/// (a restart, a sign-out, something only a person can do), or nothing anybody can do on this PC (firmware, a guest
/// VM's host, an unsupported build). Before 2026-10-12 this read an action called `blocked`, which `ic` never sends, and
/// took `admin` for the reader's: every row Intentic fixes behind the prompt read "you'll have to do this".
#[cfg_attr(not(windows), allow(dead_code))]
fn row_state(value: &Value) -> &'static str {
    match value["action"].as_str() {
        Some("firmware" | "hostVm" | "unsupported") => "blocked",
        Some("fix" | "fixElevated") => "ours",
        Some("restart" | "user" | "signOut") => "yours",
        // An action this app has no word for (a newer `ic`): whose `ic` says it is.
        _ if value["ours"].as_bool().unwrap_or(false) => "ours",
        _ => "yours",
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn row_from_requirement(value: &Value, met: bool) -> CheckRow {
    let state = if met { "met" } else { row_state(value) };
    CheckRow {
        id: value["id"].as_str().unwrap_or("").to_string(),
        state: state.into(),
        title: value["title"]
            .as_str()
            .filter(|title| !title.is_empty())
            .map(str::to_string),
        detail: value["detail"]
            .as_str()
            .or_else(|| value["problem"].as_str())
            .map(str::to_string),
        admin: value["admin"].as_bool().unwrap_or(false),
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn parse_machine(value: &Value) -> Option<MachineParts> {
    Some(MachineParts {
        os: value["os"].as_str()?.to_string(),
        build: value["build"].as_u64().unwrap_or(0) as u32,
        memory_bytes: value["memoryBytes"].as_u64(),
        free_bytes: value["freeBytes"].as_u64(),
        cpus: value["cpus"].as_u64().map(|cpus| cpus as u32),
        virtualization: value["virtualization"].as_bool(),
    })
}

fn begin_setup_rows() {
    lock_store(|store| {
        store.setup_row_states.clear();
        store.setup_track_ids = store
            .check
            .as_ref()
            .map(|check| {
                check
                    .rows
                    .iter()
                    .filter(|row| row.state != "met")
                    .map(|row| row.id.clone())
                    .collect()
            })
            .unwrap_or_default();
    });
}

fn run_pc_setup(app: &AppHandle) -> Result<(), String> {
    let heard = heard_setup(app);
    let env = vec![("INSTALL_DOCKER".into(), "1".into())];
    let watch = StallWatch::start(app);
    let ran = scripts::run_ic_heard(
        app,
        RUN_SETUP,
        "ic docker prepare --yes",
        &["docker", "prepare", "--yes"],
        &env,
        Some(heard),
    );
    drop(watch);
    // However it ended, this app saw it end: the ledger is only for a run the app never saw end.
    clear_running_ledger();
    if SETUP_RESTARTING.load(Ordering::SeqCst) {
        // Stopped to start again ("Start again" on a setup gone quiet): the run that follows is the one to report.
        return Ok(());
    }
    let ended = match ran {
        Ok(ended) => ended,
        Err(error) => {
            // It never started (no `ic` beside the app, nowhere to write its log): a failure the page can show and
            // offer again, rather than a bar left at 0% for good.
            settle_setup(
                app,
                Setup::Failed {
                    reason: error.clone(),
                },
                None,
            );
            return Err(error);
        }
    };
    let transcript = ended
        .log
        .as_deref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let summary = last_prepare_summary(&transcript);
    let reason = scrub_setup_reason(&ended, &transcript);
    let apply = setup_outcome(ended.code, summary.as_ref(), reason);
    let recheck = matches!(apply.setup, Setup::Ready);
    let restart_at = lock_store(|store| store.restart_scheduled_at);
    let setup = match &apply.setup {
        Setup::Waiting { for_, .. } if for_ == "restart" => Setup::Waiting {
            for_: for_.clone(),
            restart_at,
        },
        other => other.clone(),
    };
    if matches!(
        &apply.setup,
        Setup::Waiting {
            for_,
            ..
        } if for_ == "restart"
    ) {
        park_pc_setup();
    }
    if recheck {
        clear_pc_park();
    }
    settle_setup(app, setup, apply.check_state);
    if recheck {
        run_check(app);
        crate::machine_sandbox::kick();
        crate::sidecar::try_office_after_prefetch(app);
        return Ok(());
    }
    if matches!(
        lock_store(|store| store.setup.clone()),
        Setup::Waiting { .. }
    ) {
        return Ok(());
    }
    if matches!(
        lock_store(|store| store.setup.clone()),
        Setup::Failed { .. }
    ) {
        return Err("setup failed".into());
    }
    Ok(())
}

/// The setup's outcome, as the page reads it from now on: what was only true of the run (resumed, gone quiet) goes.
fn settle_setup(app: &AppHandle, setup: Setup, check_state: Option<String>) {
    lock_store(|store| {
        store.setup = setup;
        store.setup_resumed = false;
        store.setup_parked_at = None;
        store.setup_quiet_since = None;
        store.setup_log = None;
        store.setup_row = None;
        if let Some(state) = check_state {
            if let Some(check) = store.check.as_mut() {
                check.state = state;
            }
        }
    });
    emit(app);
}

/// Watches the running setup for [`SETUP_STALL_AFTER`] without a line, and tells the page once it has gone that quiet.
/// Stops with the run (dropped by [`run_pc_setup`]).
struct StallWatch(Arc<AtomicBool>);

impl StallWatch {
    fn start(app: &AppHandle) -> StallWatch {
        let ended = Arc::new(AtomicBool::new(false));
        let watching = Arc::clone(&ended);
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(SETUP_STALL_CHECK);
            if watching.load(Ordering::SeqCst) {
                return;
            }
            let last = SETUP_LAST_LINE_MS.load(Ordering::SeqCst);
            if !quiet_too_long(now_ms(), last) {
                continue;
            }
            let newly = lock_store(|store| {
                if store.setup_quiet_since.is_some()
                    || !matches!(store.setup, Setup::Running { .. })
                {
                    return false;
                }
                store.setup_quiet_since = Some(last / 1000);
                store.setup_log = newest_setup_log();
                true
            });
            if newly {
                emit(&app);
            }
        });
        StallWatch(ended)
    }
}

impl Drop for StallWatch {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Whether a setup that last said something at `last_ms` has said nothing for [`SETUP_STALL_AFTER`] by `now_ms`. Pure.
fn quiet_too_long(now_ms: u64, last_ms: u64) -> bool {
    last_ms > 0 && now_ms.saturating_sub(last_ms) >= SETUP_STALL_AFTER.as_millis() as u64
}

/// The newest transcript of the run `run` among `names` (`desktop-<run>-<stamp>.log`, scripts.rs `log_path`): the stamp
/// sorts by time. Pure.
fn newest_log<'a>(names: impl IntoIterator<Item = &'a str>, run: &str) -> Option<&'a str> {
    let prefix = format!("desktop-{run}-");
    names
        .into_iter()
        .filter(|name| name.starts_with(&prefix) && name.ends_with(".log"))
        .max()
}

fn newest_setup_log() -> Option<String> {
    let dir = scripts::logs_dir()?;
    let names: Vec<String> = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    newest_log(names.iter().map(String::as_str), RUN_SETUP)
        .map(|name| dir.join(name).to_string_lossy().into_owned())
}

fn scrub_setup_reason(ended: &scripts::Ended, transcript: &str) -> String {
    transcript
        .lines()
        .rev()
        .find(|line| line.contains('!') || line.contains("error"))
        .map(|line| line.trim_start_matches('!').trim().to_string())
        .or_else(|| {
            ended.log.as_deref().and_then(|path| {
                std::fs::read_to_string(path).ok().and_then(|text| {
                    text.lines()
                        .rev()
                        .find(|line| line.contains('!') || line.contains("error"))
                        .map(|line| line.trim_start_matches('!').trim().to_string())
                })
            })
        })
        .unwrap_or_else(|| "The setup stopped.".into())
}

fn heard_setup(app: &AppHandle) -> Heard {
    let app = app.clone();
    std::sync::Arc::new(move |_stream: Stream, line: &str| {
        SETUP_LAST_LINE_MS.store(now_ms(), Ordering::SeqCst);
        // Word again from a setup the page was told had gone quiet: it is not quiet any more.
        let was_quiet = lock_store(|store| {
            store.setup_log = None;
            store.setup_quiet_since.take().is_some()
        });
        let Some(json) = line.trim().strip_prefix(REQUIREMENT_STATE) else {
            if was_quiet {
                emit(&app);
            }
            return;
        };
        let Ok(value) = serde_json::from_str::<Value>(json) else {
            if was_quiet {
                emit(&app);
            }
            return;
        };
        if let (Some(id), Some(state)) = (value["id"].as_str(), value["state"].as_str()) {
            let moved_on = lock_store(|store| {
                store
                    .setup_row_states
                    .insert(id.to_string(), state.to_string());
                if state != "running" || store.setup_row.as_deref() == Some(id) {
                    return None;
                }
                store.setup_row = Some(id.to_string());
                Some(store.setup_started_at)
            });
            // The ledger says which requirement it was on, for a launch that finds this run left behind.
            if let Some(started_at) = moved_on {
                write_running_ledger(started_at, Some(id));
            }
        }
        let setup = lock_store(|store| {
            setup_running_from_marker(
                &store.setup_track_ids,
                &store.setup_row_states,
                Some(&value),
            )
        });
        lock_store(|store| store.setup = setup);
        emit(&app);
    })
}

fn setup_running_from_marker(
    track_ids: &[String],
    row_states: &HashMap<String, String>,
    current: Option<&Value>,
) -> Setup {
    let (percent, step, needs_you) = setup_progress(track_ids, row_states, current);
    Setup::Running {
        step,
        percent,
        needs_you: needs_you.then_some(true),
    }
}

/* THE DOWNLOAD'S LOOP. One at a time ([`ensure_prefetch_loop`]); it ends once the download is settled ([`settled`]), and
 * a resume or a "Try again" after that starts it again. Commands only change the state and the flags it reads. */

/// What the download's loop does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Next {
    /// Finished, nothing to fetch, or given up: the loop ends.
    Stop,
    /// Paused, a try already going, or a retry not due yet: look again in a moment.
    Wait,
    /// A setup is pulling the image itself: step aside until it ends.
    Yield,
    /// The setup it stepped aside for has ended: fetch again only if there is still something to fetch.
    Recheck,
    Fetch,
}

/// What the loop sees when it looks.
struct Seen<'a> {
    state: &'a str,
    paused: bool,
    active: bool,
    installing: bool,
    /// While `failed`: whether its automatic retry is due. None: no retry is coming.
    retry_due: Option<bool>,
}

/// What the loop does next, from what it sees. Pure.
fn prefetch_next(seen: &Seen) -> Next {
    match seen.state {
        "done" | "skipped" => return Next::Stop,
        "failed" if seen.retry_due.is_none() => return Next::Stop,
        _ => {}
    }
    if seen.paused || seen.active {
        return Next::Wait;
    }
    if seen.installing {
        return Next::Yield;
    }
    if seen.state == "yielded" {
        return Next::Recheck;
    }
    if seen.retry_due == Some(false) {
        return Next::Wait;
    }
    Next::Fetch
}

/// Run the download's loop unless it runs already.
fn ensure_prefetch_loop(app: &AppHandle) {
    if PREFETCH_LOOP.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        run_prefetch_loop(&app);
        PREFETCH_LOOP.store(false, Ordering::SeqCst);
        // Asked to go on (a resume, a retry) just as it ended: carry on, rather than leave the ask to nobody.
        if prefetch_settled() || PREFETCH_LOOP.swap(true, Ordering::SeqCst) {
            return;
        }
    });
}

fn run_prefetch_loop(app: &AppHandle) {
    let fresh = lock_store(|store| store.prefetch.state == "idle");
    if fresh && !installing() && nothing_to_fetch() {
        skip_prefetch(app, "imageInDocker");
    }
    loop {
        let installing = installing();
        let next = lock_store(|store| {
            let failed = store.prefetch.state == "failed";
            prefetch_next(&Seen {
                state: &store.prefetch.state,
                paused: PREFETCH_PAUSED.load(Ordering::SeqCst),
                active: PREFETCH_ACTIVE.load(Ordering::SeqCst),
                installing,
                retry_due: if failed {
                    store.prefetch.retry_at.map(|at| now_secs() >= at)
                } else {
                    None
                },
            })
        });
        match next {
            Next::Stop => {
                crate::sidecar::try_office_after_prefetch(app);
                return;
            }
            Next::Wait => std::thread::sleep(PREFETCH_TICK),
            Next::Yield => {
                step_aside(app);
                std::thread::sleep(PREFETCH_TICK);
            }
            Next::Recheck if nothing_to_fetch() => skip_prefetch(app, "imageInDocker"),
            Next::Recheck | Next::Fetch => fetch_unless_metered(app),
        }
    }
}

fn fetch_unless_metered(app: &AppHandle) {
    if !PREFETCH_ANYWAY.load(Ordering::SeqCst) && metered() {
        lock_store(|store| store.prefetch.state = "metered".into());
        emit(app);
        wait_out_metered();
        return;
    }
    run_prefetch_once(app);
}

/// Up to [`METERED_RECHECK`], cut short by anything that changes what the loop should do.
fn wait_out_metered() {
    let until = std::time::Instant::now() + METERED_RECHECK;
    while std::time::Instant::now() < until {
        std::thread::sleep(PREFETCH_TICK);
        let state = lock_store(|store| store.prefetch.state.clone());
        if state != "metered"
            || PREFETCH_ANYWAY.load(Ordering::SeqCst)
            || PREFETCH_PAUSED.load(Ordering::SeqCst)
            || installing()
        {
            return;
        }
    }
}

/// The download stands aside while a setup pulls the image (nothing of it is running by now).
fn step_aside(app: &AppHandle) {
    let changed = lock_store(|store| {
        if store.prefetch.state == "yielded" {
            return false;
        }
        store.prefetch.state = "yielded".into();
        store.prefetch.retry_at = None;
        true
    });
    if changed {
        emit(app);
    }
}

/// Whether a setup that pulls the sandbox image runs here, or was announced a moment ago (prefetch.rs).
fn installing() -> bool {
    install_announced(now_ms(), INSTALL_ANNOUNCED_MS.load(Ordering::SeqCst))
        || INSTALL_RUNS.iter().any(|id| scripts::is_running(id))
}

/// Whether a setup announced at `announced_ms` (0: never) still counts as starting at `now_ms`. Pure.
fn install_announced(now_ms: u64, announced_ms: u64) -> bool {
    announced_ms > 0
        && now_ms.saturating_sub(announced_ms) < INSTALL_ANNOUNCE_GRACE.as_millis() as u64
}

/// A setup that pulls the sandbox image is about to start (prefetch.rs `begin_for_setup`, called before its run is
/// registered): the download started at first launch stops now and lets go of the image cache, so the setup's own
/// prefetch, or its pull, carries on from where it was. Waits a few seconds at most for it to let go.
pub fn yield_to_install() {
    INSTALL_ANNOUNCED_MS.store(now_ms(), Ordering::SeqCst);
    if !PREFETCH_ACTIVE.load(Ordering::SeqCst) {
        return;
    }
    PREFETCH_YIELDING.store(true, Ordering::SeqCst);
    let _ = wait_until_stopped(&PREFETCH_ACTIVE, Duration::from_secs(5), || {
        stop_prefetch_runs();
        Ok(())
    });
}

fn stop_prefetch_runs() {
    for id in PREFETCH_RUNS {
        if scripts::is_running(id) {
            let _ = scripts::stop(id);
        }
    }
}

/// Docker is up and already holds the sandbox image: a PC set up before, or one whose setup has finished (a finished
/// setup is a sandbox running from that image, loaded or pulled into Docker). Nothing is left to fetch ahead.
fn nothing_to_fetch() -> bool {
    scripts::engine_listening() && crate::commands::sandbox_image_ready()
}

/// Stops the download's runs for as long as a setup that pulls the image runs, while one try is going. Stops with the
/// try (dropped by [`run_prefetch_once`]).
struct YieldWatch(Arc<AtomicBool>);

impl YieldWatch {
    fn start() -> YieldWatch {
        let ended = Arc::new(AtomicBool::new(false));
        let watching = Arc::clone(&ended);
        std::thread::spawn(move || {
            while !watching.load(Ordering::SeqCst) {
                if installing() {
                    PREFETCH_YIELDING.store(true, Ordering::SeqCst);
                    stop_prefetch_runs();
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        });
        YieldWatch(ended)
    }
}

impl Drop for YieldWatch {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn run_prefetch_once(app: &AppHandle) {
    let installing = installing();
    // A try going on is PREFETCH_ACTIVE, not the state: a `running` with nothing active is one to start, never to wait on.
    let should_run = lock_store(|store| {
        if installing
            || PREFETCH_PAUSED.load(Ordering::SeqCst)
            || PREFETCH_ACTIVE.load(Ordering::SeqCst)
            || matches!(store.prefetch.state.as_str(), "done" | "skipped")
        {
            return false;
        }
        PREFETCH_ACTIVE.store(true, Ordering::SeqCst);
        store.prefetch.state = "running".into();
        store.prefetch.attempt += 1;
        store.prefetch.failure = None;
        store.prefetch.retry_at = None;
        true
    });
    if !should_run {
        return;
    }
    // Released on every outcome, including a pause or a failed download.
    struct Active;
    impl Drop for Active {
        fn drop(&mut self) {
            PREFETCH_ACTIVE.store(false, Ordering::SeqCst);
        }
    }
    let _active = Active;
    PREFETCH_YIELDING.store(false, Ordering::SeqCst);
    let _watch = YieldWatch::start();
    emit(app);
    let base = Arc::new(Mutex::new((0u64, 0u64)));
    if let Err(failure) = run_fetch_phase(
        app,
        "engine",
        RUN_ENGINE,
        "ic engine fetch",
        &["engine", "fetch"],
        Arc::clone(&base),
    ) {
        if !prefetch_was_stopped(app) {
            fail_prefetch(app, failure);
        }
        return;
    }
    // The engine's bytes are what the image's are counted on top of.
    *base.lock().unwrap_or_else(PoisonError::into_inner) =
        lock_store(|store| (store.prefetch.done, store.prefetch.total));
    if prefetch_was_stopped(app) {
        return;
    }
    let image = crate::commands::setup_image();
    let args = prefetch::args(&image);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    match run_fetch_phase(
        app,
        "image",
        RUN_IMAGE,
        "ic image prefetch",
        &arg_refs,
        base,
    ) {
        Err(failure) => {
            if !prefetch_was_stopped(app) {
                fail_prefetch(app, failure);
            }
        }
        Ok(said) => match nothing_fetched(&said) {
            Some(why) => skip_prefetch(app, why),
            None => {
                lock_store(|store| {
                    store.prefetch.state = "done".into();
                    store.prefetch.total = store.prefetch.total.max(store.prefetch.done);
                });
                emit(app);
            }
        },
    }
}

/// A try that ended because it was told to: by the reader's pause (whose command tells the page), or by a setup that
/// pulls the image itself. Either way not a failure.
fn prefetch_was_stopped(app: &AppHandle) -> bool {
    if PREFETCH_PAUSED.load(Ordering::SeqCst) {
        lock_store(|store| {
            if store.prefetch.state == "running" {
                store.prefetch.state = "paused".into();
            }
        });
        return true;
    }
    if PREFETCH_YIELDING.swap(false, Ordering::SeqCst) || installing() {
        lock_store(|store| {
            store.prefetch.state = "yielded".into();
            store.prefetch.retry_at = None;
        });
        emit(app);
        return true;
    }
    false
}

/// A try failed: the page says so and why. The first failure of this run of the app tries again by itself after
/// [`PREFETCH_RETRY_DELAY`]; the next one gives up until the reader asks again.
fn fail_prefetch(app: &AppHandle, failure: PrefetchFailure) {
    let retry_at = (!PREFETCH_RETRIED.swap(true, Ordering::SeqCst))
        .then(|| now_secs() + PREFETCH_RETRY_DELAY.as_secs());
    lock_store(|store| {
        store.prefetch.state = "failed".into();
        store.prefetch.failure = Some(failure);
        store.prefetch.retry_at = retry_at;
    });
    emit(app);
    if retry_at.is_none() {
        crate::sidecar::try_office_after_prefetch(app);
    }
}

fn skip_prefetch(app: &AppHandle, why: &str) {
    lock_store(|store| {
        store.prefetch.state = "skipped".into();
        store.prefetch.skipped = Some(why.into());
        store.prefetch.failure = None;
        store.prefetch.retry_at = None;
    });
    emit(app);
}

/// The last `intentic-prefetch:` marker a phase said: its state and its total.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Said {
    state: Option<String>,
    total: u64,
}

/// Why an image phase that succeeded fetched nothing, as [`Prefetch::skipped`] names it; None when it fetched the
/// image. Pure.
fn nothing_fetched(said: &Said) -> Option<&'static str> {
    match said.state.as_deref() {
        Some("skipped") => Some("dockerPulls"),
        Some("elsewhere") => Some("elsewhere"),
        // `ic image prefetch` answers an image Docker already has with a ready that fetched nothing.
        Some("ready") if said.total == 0 => Some("imageInDocker"),
        _ => None,
    }
}

/// One phase of the download, to its end: what it last said when it succeeded, how it failed otherwise.
fn run_fetch_phase(
    app: &AppHandle,
    phase: &'static str,
    id: &str,
    what: &str,
    args: &[&str],
    base: Arc<Mutex<(u64, u64)>>,
) -> Result<Said, PrefetchFailure> {
    let said = Arc::new(Mutex::new(Said::default()));
    let heard = heard_prefetch(app, base, Arc::clone(&said));
    let ended = scripts::run_ic_heard(app, id, what, args, &[], Some(heard)).map_err(|error| {
        PrefetchFailure {
            phase: phase.into(),
            exit_code: None,
            reason: tidy_reason(&error),
            log: None,
        }
    })?;
    if ended.success {
        return Ok(said.lock().unwrap_or_else(PoisonError::into_inner).clone());
    }
    let transcript = ended
        .log
        .as_deref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    Err(phase_failure(phase, what, &ended, &transcript))
}

/// How a phase that exited unsuccessfully failed, from its exit and its transcript. Pure.
fn phase_failure(
    phase: &str,
    what: &str,
    ended: &scripts::Ended,
    transcript: &str,
) -> PrefetchFailure {
    let reason = last_meaningful_line(transcript).unwrap_or_else(|| match ended.code {
        Some(code) => format!("{what} exited with code {code}"),
        None => format!("{what} was stopped before it finished"),
    });
    PrefetchFailure {
        phase: phase.into(),
        exit_code: ended.code,
        reason,
        log: ended.log.clone(),
    }
}

/// The line of a run's transcript that best says why it stopped: the last thing it wrote to stderr (the transcript
/// marks those `! `; `ic` writes its `error: …` there), else the last thing it said at all. Never a progress marker
/// (`intentic-prefetch: …`) or this app's own `[… exited with …]` note. Pure.
fn last_meaningful_line(transcript: &str) -> Option<String> {
    let mut said = None;
    for line in transcript.lines().rev() {
        let line = line.trim();
        let (stderr, text) = match line.strip_prefix('!') {
            Some(rest) => (true, rest.trim()),
            None => (false, line),
        };
        if text.is_empty()
            || (text.starts_with('[') && text.ends_with(']'))
            || text.starts_with("intentic-")
        {
            continue;
        }
        if stderr {
            return Some(tidy_reason(text));
        }
        said.get_or_insert(text);
    }
    said.map(tidy_reason)
}

/// A reason on one line, without the `error:` or `intentic:` it was printed after, at most 300 characters. Pure.
fn tidy_reason(text: &str) -> String {
    let text = text.trim();
    let text = text
        .strip_prefix("error:")
        .or_else(|| text.strip_prefix("intentic:"))
        .unwrap_or(text);
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > 300 {
        format!("{}…", line.chars().take(299).collect::<String>())
    } else {
        line
    }
}

fn heard_prefetch(app: &AppHandle, base: Arc<Mutex<(u64, u64)>>, said: Arc<Mutex<Said>>) -> Heard {
    let app = app.clone();
    std::sync::Arc::new(move |_stream: Stream, line: &str| {
        let Some(json) = line.trim().strip_prefix(PREFETCH_MARKER) else {
            return;
        };
        let Ok(marker) = serde_json::from_str::<Value>(json) else {
            return;
        };
        let state = marker["state"].as_str().unwrap_or("").to_string();
        let phase_done = marker["done"].as_u64().unwrap_or(0);
        let phase_total = marker["total"].as_u64().unwrap_or(0);
        *said.lock().unwrap_or_else(PoisonError::into_inner) = Said {
            state: Some(state.clone()),
            total: phase_total,
        };
        // A marker that failed, deferred or skipped says 0 about what it had: the bar keeps the bytes it was last told,
        // which are what a failure reports as how far it got.
        if !matches!(state.as_str(), "fetching" | "ready") {
            return;
        }
        let (base_done, base_total) = *base.lock().unwrap_or_else(PoisonError::into_inner);
        let (done, total) = prefetch_display(base_done, base_total, phase_done, phase_total);
        lock_store(|store| {
            store.prefetch.done = done;
            store.prefetch.total = total;
        });
        emit(&app);
    })
}

#[cfg(windows)]
fn metered() -> bool {
    let mut command = std::process::Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-Command",
        "[void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]; $p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile(); if ($p) { $c=$p.GetConnectionCost(); \"$(($c.NetworkCostType))|$(($c.Roaming))|$(($c.OverDataLimit))\" }",
    ]);
    intentic_bounded::no_window(&mut command);
    match scripts::capture("metered", command, METERED_DEADLINE) {
        Ok(answer) if answer.success => parse_metered_winrt(answer.stdout.trim()),
        _ => false,
    }
}

#[cfg(not(windows))]
fn metered() -> bool {
    false
}

const PARK_FILE: &str = "onboarding-pc-parked.json";
/// The PC setup running right now: written when it starts, removed when this app sees it end. One still there at
/// launch is a setup the last run of the app never saw end (it quit, crashed, or Windows restarted under it).
const RUNNING_FILE: &str = "onboarding-pc-running.json";

/// `~/.intentic/<name>`: beside the setup's logs, and outliving the app's own data on an uninstall and reinstall.
fn ledger_path(name: &str) -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(std::path::Path::new(&home).join(".intentic").join(name))
}

fn park_path() -> Option<PathBuf> {
    ledger_path(PARK_FILE)
}

fn write_ledger(name: &str, value: &Value) {
    if let Some(path) = ledger_path(name) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, value.to_string());
    }
}

/// The setup stopped for a restart: the next launch resumes it, and says when it parked (an older app wrote `1`).
fn park_pc_setup() {
    write_ledger(PARK_FILE, &json!({ "at": now_secs() }));
}

fn clear_pc_park() {
    if let Some(path) = park_path() {
        let _ = std::fs::remove_file(path);
    }
}

fn resume_wanted() -> bool {
    park_path().is_some_and(|path| path.is_file())
}

fn parked_at() -> Option<u64> {
    parse_parked(&std::fs::read_to_string(park_path()?).ok()?)
}

/// When a park was written, in seconds since the epoch: `{"at": …}`, or nothing for an older app's `1`. Pure.
fn parse_parked(text: &str) -> Option<u64> {
    serde_json::from_str::<Value>(text).ok()?["at"].as_u64()
}

fn write_running_ledger(started_at: u64, row: Option<&str>) {
    write_ledger(
        RUNNING_FILE,
        &json!({ "startedAt": started_at, "step": row }),
    );
}

fn clear_running_ledger() {
    if let Some(path) = ledger_path(RUNNING_FILE) {
        let _ = std::fs::remove_file(path);
    }
}

/// The setup the last run of the app left behind, if it did, as the page is told it; read once, then gone.
fn take_running_ledger() -> Option<Value> {
    let path = ledger_path(RUNNING_FILE)?;
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    Some(orphaned_from_ledger(&text))
}

/// A setup left behind as the page is told it: when it started and the requirement it was on, as far as the ledger
/// says (a ledger that cannot be read still says one was left behind). Pure.
fn orphaned_from_ledger(text: &str) -> Value {
    let ledger: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let mut orphaned = json!({});
    if let Some(at) = ledger["startedAt"].as_u64() {
        orphaned["startedAt"] = json!(at);
    }
    if let Some(step) = ledger["step"].as_str() {
        orphaned["step"] = json!(step);
    }
    orphaned
}

/// The last `intentic-prepare-summary:` line in a prepare transcript.
pub fn last_prepare_summary(text: &str) -> Option<Value> {
    text.lines().rev().find_map(|line| {
        line.trim()
            .strip_prefix(PREPARE_SUMMARY)
            .and_then(|json| serde_json::from_str(json).ok())
    })
}

fn admin_refused(code: Option<i32>, reason: &str) -> bool {
    code == Some(EXIT_PREPARE_FAILED)
        && reason
            .to_ascii_lowercase()
            .contains("administrator permission")
}

/// Map `ic docker prepare --yes` exit code and summary into setup (and sometimes check) state.
pub fn setup_outcome(code: Option<i32>, summary: Option<&Value>, reason: String) -> SetupApply {
    if let Some(summary) = summary {
        if summary["state"].as_str() == Some("cantRun") {
            return SetupApply {
                setup: Setup::Idle,
                check_state: Some("cantRun".into()),
            };
        }
        if summary["state"].as_str() == Some("ready") {
            return SetupApply {
                setup: Setup::Ready,
                check_state: None,
            };
        }
    }
    if code == Some(EXIT_NEEDS_RESTART) {
        let restart = summary
            .and_then(|value| value["restart"].as_bool())
            .unwrap_or(false);
        return SetupApply {
            setup: Setup::Waiting {
                for_: if restart {
                    "restart".into()
                } else {
                    "signOut".into()
                },
                restart_at: None,
            },
            check_state: None,
        };
    }
    if admin_refused(code, &reason) {
        return SetupApply {
            setup: Setup::Waiting {
                for_: "admin".into(),
                restart_at: None,
            },
            check_state: None,
        };
    }
    if code == Some(EXIT_NEEDS_CONSENT) {
        return SetupApply {
            setup: Setup::Waiting {
                for_: "admin".into(),
                restart_at: None,
            },
            check_state: None,
        };
    }
    if code == Some(0) {
        return SetupApply {
            setup: Setup::Ready,
            check_state: None,
        };
    }
    SetupApply {
        setup: Setup::Failed { reason },
        check_state: None,
    }
}

/// Row-based overall percent while setup runs (`intentic-requirement-state:` markers).
pub fn setup_progress(
    track_ids: &[String],
    row_states: &HashMap<String, String>,
    current: Option<&Value>,
) -> (u8, Option<String>, bool) {
    let total = track_ids.len();
    if total == 0 {
        let percent = current
            .and_then(|value| value["percent"].as_u64())
            .unwrap_or(0) as u8;
        let step = current
            .and_then(|value| value["detail"].as_str())
            .map(str::to_string);
        let needs_you = current.is_some_and(|value| value["needs"].as_str() == Some("you"));
        return (percent, step, needs_you);
    }
    let mut done_rows = 0usize;
    for id in track_ids {
        if row_states
            .get(id)
            .is_some_and(|state| state == "done" || state == "met")
        {
            done_rows += 1;
        }
    }
    let current_pct = current
        .and_then(|value| value["percent"].as_u64())
        .unwrap_or(0);
    let overall = ((done_rows as f64 + current_pct as f64 / 100.0) / total as f64 * 100.0).round();
    let percent = overall.clamp(0.0, 100.0) as u8;
    let step = current
        .and_then(|value| value["detail"].as_str())
        .map(str::to_string);
    let needs_you = current.is_some_and(|value| value["needs"].as_str() == Some("you"));
    (percent, step, needs_you)
}

/// WinRT connection cost line: `NetworkCostType|Roaming|OverDataLimit`.
#[cfg(any(windows, test))]
pub fn parse_metered_winrt(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return false;
    }
    let mut parts = line.split('|');
    let cost = parts.next().unwrap_or("").trim();
    let roaming = parts
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("true");
    let over = parts
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("true");
    if roaming || over {
        return true;
    }
    matches!(cost, "Fixed" | "Variable")
}

/// Prefetch bar: engine totals in `base` plus the current phase's live bytes.
pub fn prefetch_display(
    base_done: u64,
    base_total: u64,
    phase_done: u64,
    phase_total: u64,
) -> (u64, u64) {
    let done = base_done.saturating_add(phase_done);
    let total = base_total.saturating_add(phase_total).max(done);
    (done, total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefetch_stop_waits_for_an_exited_child_to_leave_the_registry() {
        let active = AtomicBool::new(true);
        let mut attempts = 0;
        let result = wait_for_prefetch_stop(&active, Duration::from_secs(5), || {
            attempts += 1;
            if attempts == 2 {
                active.store(false, Ordering::SeqCst);
            }
            Err("the child has already exited".into())
        });
        assert_eq!(result, Ok(()));
        assert_eq!(attempts, 2);
        assert!(!active.load(Ordering::SeqCst));
    }

    #[test]
    fn prefetch_stop_refuses_an_active_worker_even_when_stop_succeeds() {
        let active = AtomicBool::new(true);
        assert_eq!(
            wait_for_prefetch_stop(&active, Duration::ZERO, || Ok(())),
            Err("The background download has not stopped yet. Try the update again.".into())
        );
        assert!(active.load(Ordering::SeqCst));
    }

    #[test]
    fn prefetch_stop_reports_why_an_active_worker_could_not_stop() {
        let active = AtomicBool::new(true);
        assert_eq!(
            wait_for_prefetch_stop(&active, Duration::ZERO, || Err("access denied".into())),
            Err(
                "The background download has not stopped yet: access denied. Try the update again."
                    .into()
            )
        );
        assert!(active.load(Ordering::SeqCst));
    }

    #[test]
    fn prepare_summary_and_requirements_become_a_check() {
        let text = "\
intentic-requirement: {\"id\":\"wsl-features\",\"title\":\"WSL\",\"problem\":\"off\",\"remedy\":\"on\",\"action\":\"install\",\"admin\":true,\"ours\":true}
intentic-prepare-summary: {\"state\":\"needsSetup\",\"engine\":\"intentic\",\"restart\":true,\"admin\":true,\"downloadBytes\":3000000000,\"minutes\":25,\"machine\":{\"os\":\"Windows 11\",\"build\":22631,\"memoryBytes\":16000000000,\"freeBytes\":200000000000,\"cpus\":8,\"virtualization\":true},\"met\":[{\"id\":\"virtualization\",\"title\":\"Virtualization\",\"detail\":null}]}
";
        let check = parse_prepare_output(text).expect("parsed");
        assert_eq!(check.state, "needsSetup");
        assert_eq!(check.engine.as_deref(), Some("intentic"));
        assert!(check.restart);
        assert_eq!(check.download_bytes, 3_000_000_000);
        assert_eq!(check.rows.len(), 2);
        assert!(check
            .rows
            .iter()
            .any(|row| row.id == "virtualization" && row.state == "met"));
        assert!(check.rows.iter().any(|row| row.id == "wsl-features"));
        assert_eq!(check.machine.as_ref().unwrap().build, 22631);
    }

    #[test]
    fn check_rows_keep_ics_title_for_the_page_to_fall_back_on() {
        let text = "\
intentic-requirement: {\"id\":\"wsl-kernel\",\"title\":\"Windows features for Docker\",\"problem\":\"the WSL kernel is missing\",\"remedy\":\"we install it\",\"action\":\"fixElevated\",\"detail\":null,\"admin\":true,\"ours\":true}
intentic-prepare-summary: {\"state\":\"needsSetup\",\"met\":[{\"id\":\"disk-space\",\"title\":\"Free disk space\",\"detail\":null},{\"id\":\"memory\",\"title\":\"\",\"detail\":null}]}
";
        let check = parse_prepare_output(text).expect("parsed");
        let titles: Vec<(&str, Option<&str>)> = check
            .rows
            .iter()
            .map(|row| (row.id.as_str(), row.title.as_deref()))
            .collect();
        assert_eq!(
            titles,
            vec![
                ("wsl-kernel", Some("Windows features for Docker")),
                ("disk-space", Some("Free disk space")),
                // An empty title is no title: the page's own words, else the id.
                ("memory", None),
            ]
        );
        // On the wire as `title`, beside the id the page looks its own words up by.
        let wire = serde_json::to_value(&check.rows[0]).expect("serialized");
        assert_eq!(wire["title"], "Windows features for Docker");
        assert_eq!(wire["state"], "ours");
    }

    #[test]
    fn check_rows_are_ours_yours_or_blocked_by_ics_action() {
        let state_of = |action: &str, ours: bool| {
            let value = json!({ "id": "x", "action": action, "admin": true, "ours": ours });
            row_from_requirement(&value, false).state
        };
        // Intentic's own fixes, the one behind Windows' permission prompt included.
        assert_eq!(state_of("fix", true), "ours");
        assert_eq!(state_of("fixElevated", true), "ours");
        // The reader's: a restart, a sign-out, what only a person can do.
        assert_eq!(state_of("restart", false), "yours");
        assert_eq!(state_of("signOut", false), "yours");
        assert_eq!(state_of("user", false), "yours");
        // Nothing anybody can do on this PC.
        assert_eq!(state_of("firmware", false), "blocked");
        assert_eq!(state_of("hostVm", false), "blocked");
        assert_eq!(state_of("unsupported", false), "blocked");
        // An action this app has no word for: whose `ic` says it is.
        assert_eq!(state_of("someday", true), "ours");
        assert_eq!(state_of("someday", false), "yours");
        // Met is met, whatever the action.
        let met = json!({ "id": "wsl", "title": "WSL2", "action": "firmware" });
        assert_eq!(row_from_requirement(&met, true).state, "met");
    }

    #[test]
    fn setup_outcome_ready_from_summary() {
        let summary: Value = serde_json::from_str(
            r#"{"state":"ready","engine":"intentic","restart":false,"admin":false}"#,
        )
        .unwrap();
        let apply = setup_outcome(Some(1), Some(&summary), "ignored".into());
        assert_eq!(apply.setup, Setup::Ready);
        assert!(apply.check_state.is_none());
    }

    #[test]
    fn setup_outcome_restart_vs_sign_out_on_exit_four() {
        let restart: Value =
            serde_json::from_str(r#"{"state":"needsSetup","restart":true}"#).unwrap();
        let apply = setup_outcome(Some(EXIT_NEEDS_RESTART), Some(&restart), String::new());
        assert_eq!(
            apply.setup,
            Setup::Waiting {
                for_: "restart".into(),
                restart_at: None,
            }
        );
        let sign_out: Value =
            serde_json::from_str(r#"{"state":"needsSetup","restart":false}"#).unwrap();
        let apply = setup_outcome(Some(EXIT_NEEDS_RESTART), Some(&sign_out), String::new());
        assert_eq!(
            apply.setup,
            Setup::Waiting {
                for_: "signOut".into(),
                restart_at: None,
            }
        );
    }

    #[test]
    fn setup_outcome_admin_refused_on_exit_one() {
        let apply = setup_outcome(
            Some(EXIT_PREPARE_FAILED),
            None,
            "waiting for administrator permission — try again".into(),
        );
        assert_eq!(
            apply.setup,
            Setup::Waiting {
                for_: "admin".into(),
                restart_at: None,
            }
        );
    }

    #[test]
    fn setup_outcome_cant_run_updates_check() {
        let summary: Value = serde_json::from_str(r#"{"state":"cantRun"}"#).unwrap();
        let apply = setup_outcome(Some(1), Some(&summary), String::new());
        assert_eq!(apply.setup, Setup::Idle);
        assert_eq!(apply.check_state.as_deref(), Some("cantRun"));
    }

    #[test]
    fn setup_outcome_failed_otherwise() {
        let apply = setup_outcome(Some(2), None, "something broke".into());
        assert_eq!(
            apply.setup,
            Setup::Failed {
                reason: "something broke".into()
            }
        );
    }

    #[test]
    fn setup_progress_counts_rows_and_current_percent() {
        let ids = vec!["a".into(), "b".into(), "c".into(), "d".into()];
        let mut rows = HashMap::new();
        rows.insert("a".into(), "done".into());
        rows.insert("b".into(), "done".into());
        let current: Value = serde_json::from_str(
            r#"{"id":"c","state":"running","detail":"turning on WSL","percent":50}"#,
        )
        .unwrap();
        let (percent, step, needs) = setup_progress(&ids, &rows, Some(&current));
        assert_eq!(percent, 63);
        assert_eq!(step.as_deref(), Some("turning on WSL"));
        assert!(!needs);
        let needs_you: Value =
            serde_json::from_str(r#"{"id":"c","state":"running","needs":"you","percent":0}"#)
                .unwrap();
        let (_, _, needs) = setup_progress(&ids, &rows, Some(&needs_you));
        assert!(needs);
    }

    #[test]
    fn prefetch_display_adds_base_and_phase() {
        assert_eq!(prefetch_display(100, 200, 50, 100), (150, 300));
        assert_eq!(prefetch_display(0, 0, 150, 200), (150, 200));
    }

    #[test]
    fn metered_winrt_parser() {
        assert!(parse_metered_winrt("Fixed|False|False"));
        assert!(parse_metered_winrt("Variable|False|False"));
        assert!(parse_metered_winrt("Unrestricted|True|False"));
        assert!(parse_metered_winrt("Unrestricted|False|True"));
        assert!(!parse_metered_winrt("Unrestricted|False|False"));
        assert!(!parse_metered_winrt(""));
        assert!(!parse_metered_winrt("Unknown|False|False"));
    }

    #[test]
    fn last_summary_is_the_final_line() {
        let text = "noise\nintentic-prepare-summary: {\"state\":\"needsSetup\"}\nintentic-prepare-summary: {\"state\":\"ready\"}\n";
        assert_eq!(
            last_prepare_summary(text).and_then(|v| v["state"].as_str().map(str::to_string)),
            Some("ready".into())
        );
    }

    fn seen(state: &str) -> Seen<'_> {
        Seen {
            state,
            paused: false,
            active: false,
            installing: false,
            retry_due: None,
        }
    }

    /// The incident of 2026-10-12: the download held the image cache while the sandbox's own setup waited on it.
    #[test]
    fn the_download_steps_aside_while_a_setup_pulls_and_comes_back_after_it() {
        for state in ["idle", "running", "metered", "yielded"] {
            assert_eq!(
                prefetch_next(&Seen {
                    installing: true,
                    ..seen(state)
                }),
                Next::Yield,
                "{state}"
            );
        }
        // Its automatic retry, due or not, waits for the setup too.
        assert_eq!(
            prefetch_next(&Seen {
                installing: true,
                retry_due: Some(true),
                ..seen("failed")
            }),
            Next::Yield
        );
        // The setup has ended: fetch again only if there is still something to fetch.
        assert_eq!(prefetch_next(&seen("yielded")), Next::Recheck);
        // The reader's pause outranks everything but an end.
        assert_eq!(
            prefetch_next(&Seen {
                paused: true,
                installing: true,
                ..seen("paused")
            }),
            Next::Wait
        );
        assert_eq!(
            prefetch_next(&Seen {
                installing: true,
                ..seen("done")
            }),
            Next::Stop
        );
    }

    #[test]
    fn a_failed_download_retries_once_when_due_then_stops() {
        assert_eq!(
            prefetch_next(&Seen {
                retry_due: Some(false),
                ..seen("failed")
            }),
            Next::Wait
        );
        assert_eq!(
            prefetch_next(&Seen {
                retry_due: Some(true),
                ..seen("failed")
            }),
            Next::Fetch
        );
        assert_eq!(prefetch_next(&seen("failed")), Next::Stop);
        assert_eq!(prefetch_next(&seen("skipped")), Next::Stop);
        assert_eq!(prefetch_next(&seen("idle")), Next::Fetch);
        // A try already going is waited for, never started twice.
        assert_eq!(
            prefetch_next(&Seen {
                active: true,
                ..seen("running")
            }),
            Next::Wait
        );
    }

    #[test]
    fn a_download_is_settled_once_done_skipped_or_given_up() {
        let with = |state: &str, retry_at: Option<u64>| Prefetch {
            state: state.into(),
            retry_at,
            ..Prefetch::default()
        };
        assert!(settled(&with("done", None)));
        assert!(settled(&with("skipped", None)));
        assert!(settled(&with("failed", None)));
        // Its retry is still to come: the office editor keeps waiting (sidecar.rs).
        assert!(!settled(&with("failed", Some(1))));
        for state in ["idle", "running", "paused", "metered", "yielded"] {
            assert!(!settled(&with(state, None)), "{state}");
        }
        assert_eq!(Prefetch::default().state, "idle");
    }

    #[test]
    fn a_setup_announced_counts_as_running_until_its_run_is_registered() {
        assert!(!install_announced(1_000_000, 0));
        assert!(install_announced(1_000_000, 1_000_000 - 1_000));
        let grace = INSTALL_ANNOUNCE_GRACE.as_millis() as u64;
        assert!(!install_announced(1_000_000, 1_000_000 - grace));
    }

    #[test]
    fn an_image_phase_that_fetched_nothing_says_why() {
        let said = |state: &str, total: u64| Said {
            state: Some(state.into()),
            total,
        };
        assert_eq!(nothing_fetched(&said("skipped", 0)), Some("dockerPulls"));
        assert_eq!(nothing_fetched(&said("elsewhere", 0)), Some("elsewhere"));
        assert_eq!(nothing_fetched(&said("ready", 0)), Some("imageInDocker"));
        assert_eq!(nothing_fetched(&said("ready", 2_200_000_000)), None);
        // An `ic` that exited 0 without a marker fetched what it fetched.
        assert_eq!(nothing_fetched(&Said::default()), None);
    }

    #[test]
    fn a_failed_phase_says_its_last_error_not_its_progress() {
        let transcript = "\
intentic-prefetch: {\"state\":\"fetching\",\"done\":700,\"total\":900}
intentic: the prefetch stopped (connection reset); trying again
! error: could not fetch ghcr.io/intentic/sandbox:stable ahead: connection reset by peer
intentic-prefetch: {\"state\":\"failed\",\"done\":0,\"total\":0}

[ic image prefetch exited with Some(1)]
";
        let ended = scripts::Ended {
            code: Some(1),
            success: false,
            timed_out: false,
            log: Some("/home/ann/.intentic/logs/desktop-pc-image-1.log".into()),
        };
        let failure = phase_failure("image", "ic image prefetch", &ended, transcript);
        assert_eq!(
            failure,
            PrefetchFailure {
                phase: "image".into(),
                exit_code: Some(1),
                reason: "could not fetch ghcr.io/intentic/sandbox:stable ahead: connection reset by peer"
                    .into(),
                log: ended.log.clone(),
            }
        );
        // Nothing on stderr: the last thing it said at all.
        assert_eq!(
            last_meaningful_line(
                "intentic: fetched 1 MB\nintentic: the cache is locked\n[x exited with Some(2)]"
            ),
            Some("the cache is locked".into())
        );
        // Nothing at all: the exit says it.
        let silent = phase_failure(
            "engine",
            "ic engine fetch",
            &ended,
            "[ic engine fetch exited with Some(1)]\n",
        );
        assert_eq!(silent.reason, "ic engine fetch exited with code 1");
        let killed = scripts::Ended {
            code: None,
            ..ended
        };
        assert_eq!(
            phase_failure("engine", "ic engine fetch", &killed, "").reason,
            "ic engine fetch was stopped before it finished"
        );
    }

    #[test]
    fn a_reason_is_one_line_of_at_most_300_characters() {
        assert_eq!(tidy_reason("  error:   a\n   b  "), "a b");
        let long = "x".repeat(400);
        let tidy = tidy_reason(&long);
        assert_eq!(tidy.chars().count(), 300);
        assert!(tidy.ends_with('…'));
    }

    #[test]
    fn a_failed_download_reads_as_the_page_expects() {
        let prefetch = Prefetch {
            state: "failed".into(),
            done: 700,
            total: 900,
            attempt: 1,
            failure: Some(PrefetchFailure {
                phase: "image".into(),
                exit_code: Some(1),
                reason: "could not fetch".into(),
                log: None,
            }),
            retry_at: Some(42),
            skipped: None,
        };
        assert_eq!(
            serde_json::to_value(&prefetch).unwrap(),
            json!({
                "state": "failed",
                "done": 700,
                "total": 900,
                "attempt": 1,
                "failure": { "phase": "image", "exitCode": 1, "reason": "could not fetch" },
                "retryAt": 42,
            })
        );
    }

    #[test]
    fn a_setup_goes_quiet_after_twenty_minutes_without_a_line() {
        let last = 10_000_000;
        let after = SETUP_STALL_AFTER.as_millis() as u64;
        assert!(!quiet_too_long(last + after - 1, last));
        assert!(quiet_too_long(last + after, last));
        // Nothing heard yet is not a stall (the watch starts with the run).
        assert!(!quiet_too_long(last + after, 0));
    }

    #[test]
    fn a_quiet_setup_shows_its_newest_transcript() {
        let names = [
            "desktop-pc-setup-20261012-110700.log",
            "desktop-pc-setup-20261012-121500.log",
            "desktop-pc-setup-20261012-121500.out",
            "desktop-setup-20261012-130000.log",
            "prefetch-20261012-130000.log",
        ];
        assert_eq!(
            newest_log(names, RUN_SETUP),
            Some("desktop-pc-setup-20261012-121500.log")
        );
        assert_eq!(newest_log(["desktop-setup-1.log"], RUN_SETUP), None);
    }

    #[test]
    fn a_running_setup_says_it_resumed_and_that_it_went_quiet() {
        let running = Setup::Running {
            step: Some("installing the engine".into()),
            percent: 40,
            needs_you: None,
        };
        let store = Store {
            setup: running.clone(),
            setup_resumed: true,
            setup_parked_at: Some(100),
            setup_quiet_since: Some(200),
            setup_log: Some("/logs/desktop-pc-setup-1.log".into()),
            ..Store::default()
        };
        let payload = setup_payload(&store);
        assert_eq!(payload["resumed"], json!(true));
        assert_eq!(payload["parkedAt"], json!(100));
        assert_eq!(payload["quietSince"], json!(200));
        assert_eq!(payload["log"], json!("/logs/desktop-pc-setup-1.log"));
        // Once it has an outcome, neither is said.
        let ended = Store {
            setup: Setup::Ready,
            ..store
        };
        assert_eq!(setup_payload(&ended), json!({ "state": "ready" }));
        let fresh = Store {
            setup: running,
            ..Store::default()
        };
        assert!(setup_payload(&fresh).get("resumed").is_none());
        assert!(setup_payload(&fresh).get("quietSince").is_none());
    }

    #[test]
    fn a_park_says_when_it_was_written() {
        assert_eq!(parse_parked("{\"at\":1791000000}"), Some(1_791_000_000));
        // An older app's park says nothing of when; it still resumes.
        assert_eq!(parse_parked("1"), None);
        assert_eq!(parse_parked(""), None);
    }

    #[test]
    fn a_setup_left_behind_says_when_it_started_and_where_it_was() {
        assert_eq!(
            orphaned_from_ledger("{\"startedAt\":1791000000,\"step\":\"wsl-features\"}"),
            json!({ "startedAt": 1_791_000_000u64, "step": "wsl-features" })
        );
        assert_eq!(
            orphaned_from_ledger("{\"startedAt\":1791000000,\"step\":null}"),
            json!({ "startedAt": 1_791_000_000u64 })
        );
        // Unreadable, it was still left behind.
        assert_eq!(orphaned_from_ledger("garbage"), json!({}));
    }
}
