//! FIRST RUN (2026-10-09): this PC's read-only check at launch, the download started at first launch, and the PC's own
//! setup behind the reader's one "Set up this PC", for the local shell's Agents view (the web's localHost.ts
//! `LocalOnboardingHost`, drawn by local/agents/LocalAgents.vue; the app's half is src/onboarding/pc.ts).

use std::collections::HashMap;
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

#[cfg_attr(not(windows), allow(dead_code))]
const PREPARE_DEADLINE: Duration = Duration::from_secs(120);
#[cfg_attr(not(windows), allow(dead_code))]
const METERED_DEADLINE: Duration = Duration::from_secs(15);
const PREFETCH_START_DELAY: Duration = Duration::from_secs(3);
const METERED_RECHECK: Duration = Duration::from_secs(5 * 60);

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
static PREFETCH_PAUSED: AtomicBool = AtomicBool::new(false);
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefetch {
    pub state: String,
    pub done: u64,
    pub total: u64,
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
    let payload = snapshot_payload(Some(app));
    let _ = app.emit(EVENT, payload);
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

/// Whether the first-launch prefetch has finished or given up — the office editor waits on this (sidecar.rs).
pub fn prefetch_settled() -> bool {
    matches!(
        lock_store(|store| store.prefetch.state.clone()).as_str(),
        "done" | "failed"
    )
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
    if !(needs && consent) || SETUP_RUNNING.load(Ordering::SeqCst) {
        return false;
    }
    SETUP_RUNNING.store(true, Ordering::SeqCst);
    begin_setup_rows();
    lock_store(|store| {
        store.setup = Setup::Running {
            step: None,
            percent: 0,
            needs_you: None,
        };
    });
    emit(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = run_pc_setup(&app);
        SETUP_RUNNING.store(false, Ordering::SeqCst);
    });
    true
}

/// Start the read-only check and the first-launch prefetch (lib.rs setup).
pub fn begin(app: &AppHandle) {
    load_first_launch(app);
    let handle = app.clone();
    std::thread::spawn(move || run_check(&handle));
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PREFETCH_START_DELAY);
        run_prefetch_loop(&handle);
    });
    if resume_wanted() {
        let handle = app.clone();
        std::thread::spawn(move || {
            SETUP_RUNNING.store(true, Ordering::SeqCst);
            begin_setup_rows();
            let _ = run_pc_setup(&handle);
            SETUP_RUNNING.store(false, Ordering::SeqCst);
        });
    }
}

/// The check, the download and the setup as they stand.
#[tauri::command]
pub fn onboarding_state(app: AppHandle) -> Value {
    snapshot_payload(Some(&app))
}

fn snapshot_payload(app: Option<&AppHandle>) -> Value {
    let (payload, mark_seen) = lock_store(|store| {
        let mut payload = json!({
            "check": store.check,
            "prefetch": store.prefetch,
            "setup": setup_json(&store.setup),
        });
        if store.first_launch_in_next_payload {
            payload["firstLaunch"] = json!(true);
            if app.is_some() {
                store.first_launch_in_next_payload = false;
                store.first_launch_seen = true;
            }
            (payload, app.is_some())
        } else {
            (payload, false)
        }
    });
    if mark_seen {
        if let Some(app) = app {
            mark_first_launch_seen(app);
        }
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

/// "Set up this PC": the reader's one consent.
#[tauri::command]
pub async fn onboarding_set_up(app: AppHandle) -> Result<(), String> {
    if SETUP_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    begin_setup_rows();
    lock_store(|store| {
        store.setup = Setup::Running {
            step: None,
            percent: 0,
            needs_you: None,
        };
    });
    emit(&app);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_pc_setup(&app);
        SETUP_RUNNING.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Pause or resume the download started at first launch.
#[tauri::command]
pub fn onboarding_pause(app: AppHandle, paused: bool) -> Result<(), String> {
    if paused {
        PREFETCH_PAUSED.store(true, Ordering::SeqCst);
        let _ = scripts::stop(RUN_ENGINE);
        let _ = scripts::stop(RUN_IMAGE);
        lock_store(|store| {
            if store.prefetch.state == "running" {
                store.prefetch.state = "paused".into();
            }
        });
    } else {
        PREFETCH_PAUSED.store(false, Ordering::SeqCst);
        let resume =
            lock_store(|store| matches!(store.prefetch.state.as_str(), "paused" | "metered"));
        if resume {
            lock_store(|store| store.prefetch.state = "idle".into());
            let app = app.clone();
            std::thread::spawn(move || run_prefetch_once(&app));
        }
    }
    emit(&app);
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
                    "Save your work in other apps. Open Intentic to restart now or choose Not now."
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

#[cfg_attr(not(windows), allow(dead_code))]
fn row_from_requirement(value: &Value, met: bool) -> CheckRow {
    let state = if met {
        "met".into()
    } else if value["action"].as_str() == Some("blocked") {
        "blocked".into()
    } else if value["ours"].as_bool().unwrap_or(false) || value.get("ours").is_none() && !met {
        if value["admin"].as_bool().unwrap_or(false) {
            "yours".into()
        } else {
            "ours".into()
        }
    } else {
        "yours".into()
    };
    CheckRow {
        id: value["id"].as_str().unwrap_or("").to_string(),
        state,
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
    let ended = scripts::run_ic_heard(
        app,
        RUN_SETUP,
        "ic docker prepare --yes",
        &["docker", "prepare", "--yes"],
        &env,
        Some(heard),
    )?;
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
    lock_store(|store| {
        store.setup = setup;
        if let Some(state) = apply.check_state {
            if let Some(check) = store.check.as_mut() {
                check.state = state;
            }
        }
    });
    emit(app);
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
        if let Some(json) = line.trim().strip_prefix(REQUIREMENT_STATE) {
            if let Ok(value) = serde_json::from_str::<Value>(json) {
                if let Some(id) = value["id"].as_str() {
                    if let Some(state) = value["state"].as_str() {
                        lock_store(|store| {
                            store
                                .setup_row_states
                                .insert(id.to_string(), state.to_string());
                        });
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
            }
        }
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

fn run_prefetch_loop(app: &AppHandle) {
    loop {
        if prefetch_settled() {
            crate::sidecar::try_office_after_prefetch(app);
            return;
        }
        if PREFETCH_PAUSED.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        }
        if metered() {
            lock_store(|store| store.prefetch.state = "metered".into());
            emit(app);
            std::thread::sleep(METERED_RECHECK);
            continue;
        }
        run_prefetch_once(app);
        if prefetch_settled() {
            crate::sidecar::try_office_after_prefetch(app);
            return;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn run_prefetch_once(app: &AppHandle) {
    let should_run = lock_store(|store| {
        if matches!(store.prefetch.state.as_str(), "done" | "running") {
            return false;
        }
        store.prefetch.state = "running".into();
        true
    });
    if !should_run {
        return;
    }
    emit(app);
    let base = Arc::new(Mutex::new((0u64, 0u64)));
    if let Err(()) = run_engine_fetch(app, Arc::clone(&base)) {
        if prefetch_was_paused() {
            return;
        }
        fail_prefetch(app);
        return;
    }
    if let Err(()) = run_image_prefetch(app, base) {
        if prefetch_was_paused() {
            return;
        }
        fail_prefetch(app);
        return;
    }
    let (done, total) = lock_store(|store| (store.prefetch.done, store.prefetch.total));
    lock_store(|store| {
        store.prefetch = Prefetch {
            state: "done".into(),
            done,
            total: total.max(done),
        };
    });
    emit(app);
}

fn prefetch_was_paused() -> bool {
    if PREFETCH_PAUSED.load(Ordering::SeqCst) {
        lock_store(|store| {
            if store.prefetch.state == "running" {
                store.prefetch.state = "paused".into();
            }
        });
        true
    } else {
        false
    }
}

fn fail_prefetch(app: &AppHandle) {
    lock_store(|store| store.prefetch.state = "failed".into());
    emit(app);
    crate::sidecar::try_office_after_prefetch(app);
}

fn run_engine_fetch(app: &AppHandle, base: Arc<Mutex<(u64, u64)>>) -> Result<(), ()> {
    let heard = heard_prefetch(app, Arc::clone(&base));
    let ended = scripts::run_ic_heard(
        app,
        RUN_ENGINE,
        "ic engine fetch",
        &["engine", "fetch"],
        &[],
        Some(heard),
    )
    .map_err(|_| ())?;
    if ended.success {
        if let Ok(mut locked) = base.lock() {
            let (done, total) = lock_store(|store| (store.prefetch.done, store.prefetch.total));
            *locked = (done, total);
        }
        Ok(())
    } else {
        // Paused or failed alike: the loop reads PREFETCH_PAUSED to tell the two apart.
        Err(())
    }
}

fn run_image_prefetch(app: &AppHandle, base: Arc<Mutex<(u64, u64)>>) -> Result<(), ()> {
    let image = crate::commands::setup_image();
    let args = prefetch::args(&image);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let heard = heard_prefetch(app, base);
    let ended = scripts::run_ic_heard(
        app,
        RUN_IMAGE,
        "ic image prefetch",
        &arg_refs,
        &[],
        Some(heard),
    )
    .map_err(|_| ())?;
    ended.success.then_some(()).ok_or(())
}

fn heard_prefetch(app: &AppHandle, base: Arc<Mutex<(u64, u64)>>) -> Heard {
    let app = app.clone();
    std::sync::Arc::new(move |_stream: Stream, line: &str| {
        if let Some(json) = line.trim().strip_prefix(PREFETCH_MARKER) {
            if let Ok(marker) = serde_json::from_str::<Value>(json) {
                let phase_done = marker["done"].as_u64().unwrap_or(0);
                let phase_total = marker["total"].as_u64().unwrap_or(0);
                let base_guard = base.lock().unwrap_or_else(PoisonError::into_inner);
                let (base_done, base_total) = *base_guard;
                let (done, total) =
                    prefetch_display(base_done, base_total, phase_done, phase_total);
                lock_store(|store| {
                    store.prefetch = Prefetch {
                        state: "running".into(),
                        done,
                        total,
                    };
                });
                emit(&app);
            }
        }
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

fn park_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(
        std::path::Path::new(&home)
            .join(".intentic")
            .join(PARK_FILE),
    )
}

fn park_pc_setup() {
    if let Some(path) = park_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, b"1");
    }
}

fn clear_pc_park() {
    if let Some(path) = park_path() {
        let _ = std::fs::remove_file(path);
    }
}

fn resume_wanted() -> bool {
    park_path().is_some_and(|path| path.is_file())
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
}
