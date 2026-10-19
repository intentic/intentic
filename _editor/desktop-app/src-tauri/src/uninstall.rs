//! UNINSTALLING INTENTIC FROM THIS COMPUTER, FROM THE APP (2026-10-18): This device's "Uninstall Intentic…"
//! (src/device/uninstall/UninstallDialog.vue). The work is `ic uninstall`'s, the one orchestrator every road shares (the
//! Windows uninstaller, the one-liners, a terminal); this module asks it what is here, runs it, and then removes the app
//! itself, which ic leaves alone because it is told `--without-app`.
//!
//! Three commands, in the order the dialog calls them:
//! - [`uninstall_inventory`]: `ic uninstall --dry-run --json`, what Intentic has on this computer and the steps each
//!   outcome would run.
//! - [`uninstall_run`]: `ic uninstall --without-app --yes` with the reader's choice, every `intentic-uninstall:` line it
//!   prints folded into one [`Progress`] and sent whole to the windows on each change ([`EVENT`]). One run at a time.
//!   While it runs and after it, nothing in this process brings back what it removes: the engine keeper stands down
//!   (engine_keeper.rs), this computer's own sandbox is neither made nor started (machine_sandbox.rs `stand_down`), the
//!   first launch's download pauses, and no move between engines can start.
//! - [`uninstall_finish`]: the app itself goes, and the app quits. On Windows its own uninstaller does it, started once
//!   this process has gone and told that ic already ran (`INTENTIC_UNINSTALL=done`, which the installer's hook reads). On
//!   Linux an AppImage is deleted after the app exits, a deb or rpm is removed through `pkexec`, and the app's own
//!   folders in the home folder go after the exit too; where `pkexec` is missing or refused, the command to run is handed
//!   back for the dialog to show, and nothing quits until the reader says so.
//!
//! Every decision is a plain function (the arguments, the marker lines, the fold, the package manager's command, the
//! paths), tested below without an ic, a window or a package manager.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::scripts::{self, Heard, Stream};

/// What every window hears while an uninstall runs: the whole [`Progress`], on each change.
pub const EVENT: &str = "desktop://uninstall";

/// The run an uninstall streams under (`desktop://run`, its transcript, a Quit's question).
pub const RUN: &str = "uninstall";

/// How ic marks the lines of an uninstall meant for this app.
const MARKER: &str = "intentic-uninstall:";

/// `ic uninstall --dry-run --json` lists the sandboxes and asks docker and WSL their sizes: seconds, bounded well past.
const INVENTORY_LIMIT: Duration = Duration::from_secs(180);

/// How long the system's password prompt for removing a deb or an rpm may stay up before it counts as refused.
#[cfg_attr(windows, allow(dead_code))]
const PACKAGE_LIMIT: Duration = Duration::from_secs(600);

/// How long a quit at the end waits before it happens: the dialog's press is answered first.
const QUIT_AFTER: Duration = Duration::from_millis(400);

/// An uninstall of this app's is running.
static RUNNING: AtomicBool = AtomicBool::new(false);
/// An uninstall has started in this process and not been refused: what the engine keeper and this computer's own
/// sandbox read to stand down. Never cleared once ic has run: whatever it removed stays removed until the app goes.
static UNDERWAY: AtomicBool = AtomicBool::new(false);
/// An uninstall ran to its end in this process: the app may remove itself now, and only now.
static RAN: AtomicBool = AtomicBool::new(false);
/// The app is quitting for good after an uninstall: no update installed on the way out, no question about the quit.
static LEAVING: AtomicBool = AtomicBool::new(false);
/// The last run's progress, for a window that opens the dialog while it runs or after it.
static LAST: Mutex<Option<Progress>> = Mutex::new(None);

/// Whether nothing here should bring back what an uninstall removes (engine_keeper.rs, machine_sandbox.rs).
pub fn underway() -> bool {
    UNDERWAY.load(Ordering::SeqCst)
}

/// Whether the app is quitting at the end of an uninstall (windows.rs `hold_quit`, update.rs `install_on_exit`).
pub fn leaving() -> bool {
    LEAVING.load(Ordering::SeqCst)
}

/* WHAT IS HERE — `ic uninstall --dry-run --json`, as the contract between ic and this app spells it. Every field has a
 * default and unknown ones are passed over, so an ic a little newer or older than this app still reads. */

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Inventory {
    pub version: u32,
    /// `windows`, `linux` or `macos`.
    pub os: String,
    pub sandboxes: Vec<FoundSandbox>,
    /// Sandboxes and runners, the recoverable ones included: what `--confirm` must equal.
    pub delete_count: u32,
    /// A keyring vault is on this computer.
    pub passwords: bool,
    /// None: no intentic engine here.
    pub engine: Option<FoundEngine>,
    /// None: no machine agent here.
    pub agent: Option<FoundAgent>,
    /// None: the desktop app is not installed (ic's view; this app is running, so it is).
    pub app: Option<FoundApp>,
    pub cache_bytes: u64,
    /// What stays whatever is chosen, as a person names it ("Docker Desktop", "WSL").
    pub stays: Vec<String>,
    /// Everything Intentic has here, in a person's phrases ("the Intentic app", "3 sandboxes (22 GB)").
    pub found: Vec<String>,
    /// The steps each outcome runs here, by its id (`everything`, `keep-sandboxes`), labelled as the checklist shows them.
    pub steps: std::collections::BTreeMap<String, Vec<PlanStep>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FoundSandbox {
    pub slug: String,
    /// `sandbox` or `runner`.
    pub kind: String,
    /// `running`, `stopped`, `removed` (recoverable) or `unknown` (docker could not say).
    pub state: String,
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FoundEngine {
    pub bytes: Option<u64>,
    /// It also runs containers that are not Intentic's, so it stays whatever is chosen.
    pub holds_others: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FoundAgent {
    /// Folders it syncs to this computer.
    pub folders: u32,
    /// WSL distros with an agent of their own (Windows).
    pub distros: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FoundApp {
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanStep {
    pub step: String,
    pub label: String,
}

/// The inventory in what `ic uninstall --dry-run --json` printed: the JSON object on its stdout. Pure.
pub fn inventory_from(stdout: &str) -> Option<Inventory> {
    let object = scripts::json_object_in(stdout)?;
    // An object that says nothing an uninstall is about is some other answer (an ic that did not know the verb).
    if object.get("steps").is_none() && object.get("sandboxes").is_none() {
        return None;
    }
    serde_json::from_value(object).ok()
}

/* WHAT THE READER CHOSE, AND THE COMMAND LINE IT BECOMES. */

/// The two outcomes the dialog offers, as ic's wire names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    /// Sandboxes and their data, the saved passwords, the engine, the agent, folder sync, ic, caches.
    Everything,
    /// The sandboxes keep running here, with what keeps them up; only folder sync and caches go (and the app).
    KeepSandboxes,
}

impl Choice {
    /// The dialog's word for it, nothing else.
    pub fn parse(said: &str) -> Result<Choice, String> {
        match said {
            "everything" => Ok(Choice::Everything),
            "keep-sandboxes" => Ok(Choice::KeepSandboxes),
            other => Err(format!(
                "{other:?} is not a way to uninstall: say everything or keep-sandboxes"
            )),
        }
    }
}

/// `ic`'s arguments for an uninstall the app runs: never a question (`--yes`), never the app (`--without-app`, the app
/// removes itself afterwards), and data deleted only for [`Choice::Everything`], with the count the reader typed when
/// there are sandboxes to delete. Pure.
pub fn run_args(choice: Choice, confirm: Option<u32>) -> Vec<String> {
    let mut args: Vec<String> = ["uninstall", "--without-app", "--yes"]
        .into_iter()
        .map(str::to_string)
        .collect();
    match choice {
        Choice::Everything => {
            args.push("--delete-data".to_string());
            if let Some(count) = confirm.filter(|count| *count > 0) {
                args.push("--confirm".to_string());
                args.push(count.to_string());
            }
        }
        Choice::KeepSandboxes => args.push("--keep-sandboxes".to_string()),
    }
    args
}

/* HOW FAR IT HAS GOT — every marker line folded into one record the windows draw whole. */

/// One line of an uninstall as ic printed it: the JSON object after [`MARKER`]. Pure.
pub fn parse_line(line: &str) -> Option<Value> {
    let json = line.trim().strip_prefix(MARKER)?;
    serde_json::from_str::<Value>(json.trim())
        .ok()
        .filter(Value::is_object)
}

/// A step of the plan, as far as it has got.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    pub step: String,
    pub label: String,
    /// `pending`, then `running`, then `done`, `failed` or `skipped`; any other word ic says is kept as it said it.
    pub state: String,
    /// ic's sentence about it.
    pub detail: Option<String>,
}

/// Something that did not come off, what went wrong and the command that finishes the job.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Failure {
    pub label: String,
    pub problem: String,
    pub fix: Option<String>,
}

/// How it ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// `done`: everything planned came off. `partial`: something did not, and `failed` says what.
    pub result: String,
    pub stays: Vec<String>,
    pub failed: Vec<Failure>,
    /// ic's exit code; none when it was killed.
    pub code: Option<i32>,
}

/// An uninstall as the dialog draws it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `everything` or `keep-sandboxes`, once ic has said its plan.
    pub choice: Option<String>,
    pub steps: Vec<StepState>,
    /// Set once ic has exited.
    pub outcome: Option<Outcome>,
    /// The run's transcript, outside the folders it removes.
    pub log: Option<String>,
}

impl Progress {
    /// Fold one marker line in; true when anything changed. Pure.
    pub fn hear(&mut self, said: &Value) -> bool {
        let before = self.clone();
        let text = |key: &str| said.get(key).and_then(Value::as_str).map(str::to_string);
        if let Some(plan) = said.get("plan").and_then(Value::as_array) {
            self.steps = plan
                .iter()
                .filter_map(|planned| {
                    Some(StepState {
                        step: planned.get("step")?.as_str()?.to_string(),
                        label: planned
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        state: "pending".to_string(),
                        detail: None,
                    })
                })
                .collect();
            if let Some(choice) = text("choice") {
                self.choice = Some(choice);
            }
        } else if let Some(step) = text("step") {
            let at = match self.steps.iter().position(|known| known.step == step) {
                Some(at) => at,
                None => {
                    // A step ic did not plan aloud: drawn where it happened, at the end.
                    self.steps.push(StepState {
                        step,
                        label: String::new(),
                        state: "pending".to_string(),
                        detail: None,
                    });
                    self.steps.len() - 1
                }
            };
            let known = &mut self.steps[at];
            if let Some(state) = text("state") {
                known.state = state;
            }
            if let Some(label) = text("label").filter(|label| !label.is_empty()) {
                known.label = label;
            }
            if let Some(detail) = text("detail") {
                known.detail = Some(detail).filter(|detail| !detail.is_empty());
            }
        } else if let Some(result) = text("result") {
            self.outcome = Some(Outcome {
                result,
                stays: strings(said.get("stays")),
                failed: said
                    .get("failed")
                    .and_then(|failed| serde_json::from_value(failed.clone()).ok())
                    .unwrap_or_default(),
                code: None,
            });
        }
        *self != before
    }

    /// The end, once ic has exited with `code`. An ic that said how it ended is believed; one that did not (it was
    /// killed, it crashed) ended partway, and whatever step it was on did not finish. `error` is its own `error:` line,
    /// the only reason there is then. Pure.
    pub fn end(&mut self, code: Option<i32>, error: Option<String>, log: Option<String>) {
        self.log = log;
        if let Some(outcome) = &mut self.outcome {
            outcome.code = code;
            if outcome.result == "done" && !outcome.failed.is_empty() {
                outcome.result = "partial".to_string();
            }
            return;
        }
        if code == Some(0) {
            for step in &mut self.steps {
                if step.state == "pending" || step.state == "running" {
                    step.state = "done".to_string();
                }
            }
            self.outcome = Some(Outcome {
                result: "done".to_string(),
                stays: Vec::new(),
                failed: Vec::new(),
                code,
            });
            return;
        }
        let stopped_at = self
            .steps
            .iter()
            .position(|step| step.state == "running")
            .or_else(|| self.steps.iter().position(|step| step.state == "pending"));
        let label = stopped_at
            .map(|at| self.steps[at].label.clone())
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| "Uninstall Intentic".to_string());
        if let Some(at) = stopped_at {
            self.steps[at].state = "failed".to_string();
        }
        let problem = error.unwrap_or_else(|| match code {
            Some(code) => format!("ic stopped before it finished (exit {code})."),
            None => "ic was stopped before it finished.".to_string(),
        });
        self.outcome = Some(Outcome {
            result: "partial".to_string(),
            stays: Vec::new(),
            failed: vec![Failure {
                label,
                problem,
                fix: None,
            }],
            code,
        });
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// ic's `error:` line on stderr, the first one: why a run that said no ending stopped. Pure.
pub fn error_line(line: &str) -> Option<String> {
    line.trim()
        .strip_prefix("error:")
        .map(|rest| rest.trim().to_string())
        .filter(|rest| !rest.is_empty())
}

/// What else of this app's is running that an uninstall must not cut through, in a sentence; none when nothing is. This
/// computer's own sandbox's setup and the first launch's download are stopped by the uninstall instead. Pure.
pub fn busy_sentence(runs: &[String]) -> Option<String> {
    let mut doing: Vec<String> = runs
        .iter()
        .filter(|run| {
            run.as_str() != crate::machine_sandbox::RUN
                && !crate::onboarding::PREFETCH_RUNS.contains(&run.as_str())
        })
        .map(|run| crate::windows::run_said(run))
        .collect();
    doing.dedup();
    if doing.is_empty() {
        return None;
    }
    Some(format!(
        "Intentic is still busy on this computer ({}). Wait for it to finish, then uninstall.",
        doing.join(", ")
    ))
}

/* THE COMMANDS. */

/// `ic uninstall --dry-run --json`: what Intentic has on this computer, and the steps each outcome runs. `Err` is a
/// sentence for the dialog: no ic, one that did not answer, or one that said why it could not look.
#[tauri::command]
pub async fn uninstall_inventory() -> Result<Inventory, String> {
    tauri::async_runtime::spawn_blocking(read_inventory)
        .await
        .map_err(|error| error.to_string())?
}

fn read_inventory() -> Result<Inventory, String> {
    let ic = crate::engine::ic_program().ok_or_else(|| scripts::IC_MISSING.to_string())?;
    let mut command = Command::new(&ic);
    command.current_dir(std::env::temp_dir());
    command.args(["uninstall", "--dry-run", "--json"]);
    command.envs(crate::commands::app_env(crate::commands::VERSION));
    intentic_bounded::no_window(&mut command);
    let answer = scripts::capture("ic uninstall --dry-run", command, INVENTORY_LIMIT)
        .map_err(|silence| silence.to_string())?;
    if !answer.success {
        return Err(crate::engine::last_words(
            &answer.stdout,
            &answer.stderr,
            "ic uninstall --dry-run",
        ));
    }
    inventory_from(&answer.stdout).ok_or_else(|| {
        "ic said nothing this app can read about what is on this computer.".to_string()
    })
}

/// The last uninstall's progress in this run of the app: running, or ended. None before one has started.
#[tauri::command]
pub fn uninstall_state() -> Option<Progress> {
    LAST.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

/// The one run at a time, given back when dropped.
struct Claim;

impl Drop for Claim {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Run `ic uninstall --without-app --yes` with the reader's `choice` (`everything` or `keep-sandboxes`) and, for
/// `everything` with sandboxes, the count they typed (`confirm`, which ic checks against its own). Minutes long; every
/// change reaches the windows as [`EVENT`], and the end comes back as the answer. `Err` only when it never ran: a word
/// that is not a choice, one already running, something else of this app's at work, no ic.
#[tauri::command]
pub async fn uninstall_run(
    app: AppHandle,
    choice: String,
    confirm: Option<u32>,
) -> Result<Progress, String> {
    let choice = Choice::parse(&choice)?;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("Intentic is already being uninstalled from this computer.".to_string());
    }
    let claim = Claim;
    tauri::async_runtime::spawn_blocking(move || {
        let _claim = claim;
        run(&app, choice, confirm)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn run(app: &AppHandle, choice: Choice, confirm: Option<u32>) -> Result<Progress, String> {
    // No move between engines may start while the engine is being removed, and none may be running.
    let Some(_moving) = crate::engine::claim() else {
        return Err(
            "Your sandboxes are being moved to another engine. Wait for the move to finish, then uninstall."
                .to_string(),
        );
    };
    if let Some(busy) = busy_sentence(&scripts::running_ids()) {
        return Err(busy);
    }
    let ic = crate::engine::ic_program().ok_or_else(|| scripts::IC_MISSING.to_string())?;

    // From here nothing in this process brings back what the uninstall removes.
    UNDERWAY.store(true, Ordering::SeqCst);
    crate::machine_sandbox::stand_down();
    let resume_download = crate::onboarding::pause_for_update(app).unwrap_or(false);

    let progress = Arc::new(Mutex::new(Progress::default()));
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    publish(app, &Progress::default());
    let heard: Heard = {
        let app = app.clone();
        let progress = Arc::clone(&progress);
        let error = Arc::clone(&error);
        Arc::new(move |stream: Stream, line: &str| {
            if stream == Stream::Stderr {
                let mut error = error.lock().unwrap_or_else(PoisonError::into_inner);
                if error.is_none() {
                    *error = error_line(line);
                }
                return;
            }
            let Some(said) = parse_line(line) else {
                return;
            };
            let mut progress = progress.lock().unwrap_or_else(PoisonError::into_inner);
            if progress.hear(&said) {
                publish(&app, &progress);
            }
        })
    };

    let mut command = Command::new(&ic);
    // Never a folder the uninstall deletes: Windows will not delete the folder a process stands in.
    command.current_dir(std::env::temp_dir());
    command.args(run_args(choice, confirm));
    command.envs(crate::commands::app_env(crate::commands::VERSION));
    let ended = scripts::run_command_heard_in(
        app,
        RUN,
        "ic uninstall",
        command,
        &std::env::temp_dir().join("intentic-uninstall"),
        Some(heard),
    );
    let ended = match ended {
        Ok(ended) => ended,
        Err(why) => {
            // It never started, so nothing was removed: everything goes back to how it was.
            UNDERWAY.store(false, Ordering::SeqCst);
            if resume_download {
                let _ = crate::onboarding::onboarding_pause(app.clone(), false);
            }
            crate::machine_sandbox::kick();
            *LAST.lock().unwrap_or_else(PoisonError::into_inner) = None;
            return Err(why);
        }
    };
    let mut progress = progress
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let error = error.lock().unwrap_or_else(PoisonError::into_inner).clone();
    progress.end(ended.code, error, ended.log);
    RAN.store(true, Ordering::SeqCst);
    publish(app, &progress);
    Ok(progress)
}

/// Keep `progress` as the last one, and tell every window.
fn publish(app: &AppHandle, progress: &Progress) {
    *LAST.lock().unwrap_or_else(PoisonError::into_inner) = Some(progress.clone());
    let _ = app.emit(EVENT, progress);
}

/* THE APP ITSELF, LAST. */

/// What the last step came to.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finish {
    /// The app is quitting, and removes itself (or its uninstaller does) once it has gone.
    pub closing: bool,
    /// The command that removes the app's package, for the reader to run: the system's password prompt was missing or
    /// refused.
    pub command: Option<String>,
    /// Why the app could not remove itself, in a sentence.
    pub reason: Option<String>,
}

/// Remove the app itself, after an uninstall ran, and quit. `leavePackage`: quit without trying the package again (the
/// reader was handed its command, and is closing the app). Answers [`Finish`] with `closing: false` and the command to
/// run when a deb or rpm could not be removed from here.
#[tauri::command]
pub async fn uninstall_finish(
    app: AppHandle,
    leave_package: Option<bool>,
) -> Result<Finish, String> {
    if !RAN.load(Ordering::SeqCst) {
        return Err("Uninstall Intentic from this computer first.".to_string());
    }
    let leave_package = leave_package.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || finish(&app, leave_package))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(windows)]
fn finish(app: &AppHandle, leave_package: bool) -> Result<Finish, String> {
    let exe = std::env::current_exe().ok();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let released = tauri::utils::platform::bundle_type().is_some();
    let uninstaller = uninstaller_candidates(
        exe.as_deref().and_then(Path::parent),
        local.as_deref().filter(|_| released),
    )
    .into_iter()
    .find(|candidate| candidate.is_file());
    let Some(uninstaller) = uninstaller else {
        // Asked to close anyway, after being told why the app could not remove itself: it closes.
        if released && !leave_package {
            return Ok(Finish {
                closing: false,
                command: None,
                reason: Some(
                    "The app's own uninstaller isn't beside it. Remove Intentic in Settings › Apps once it has closed."
                        .to_string(),
                ),
            });
        }
        // A build that was never installed (`tauri dev`) has nothing to uninstall but itself.
        leave(app);
        return Ok(Finish {
            closing: true,
            ..Finish::default()
        });
    };
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &windows_handoff(std::process::id(), &uninstaller),
        ])
        .env("INTENTIC_UNINSTALL", "done");
    if detach(command).is_err() {
        // No PowerShell: the uninstaller itself, at once. Its own check closes this app if it is still here.
        let mut command = Command::new(&uninstaller);
        command.arg("/S").env("INTENTIC_UNINSTALL", "done");
        detach(command)
            .map_err(|error| format!("The app's uninstaller would not start: {error}"))?;
    }
    leave(app);
    Ok(Finish {
        closing: true,
        ..Finish::default()
    })
}

#[cfg(not(windows))]
fn finish(app: &AppHandle, leave_package: bool) -> Result<Finish, String> {
    let exe = std::env::current_exe().ok();
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let exe_name = exe
        .as_deref()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "intentic-desktop".to_string());
    let mut doomed = user_leftovers(
        &UserDirs {
            home: env("HOME"),
            config: env("XDG_CONFIG_HOME"),
            data: env("XDG_DATA_HOME"),
            cache: env("XDG_CACHE_HOME"),
        },
        &exe_name,
    );
    let appimage = env("APPIMAGE").filter(|path| !path.as_os_str().is_empty());
    if let Some(image) = appimage {
        doomed.push(image);
    } else if !leave_package {
        if let Some(package) = exe.as_deref().and_then(installed_package) {
            let remove = remove_command(&package, on_path);
            if let Err(reason) = remove_package(&remove) {
                return Ok(Finish {
                    closing: false,
                    command: Some(format!("sudo {}", remove.join(" "))),
                    reason: Some(reason),
                });
            }
        }
    }
    // After the exit, so nothing this app writes on its way out puts a folder back.
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(LINUX_CLEANUP)
        .arg("sh")
        .arg(std::process::id().to_string())
        .args(&doomed);
    if let Err(error) = detach(command) {
        eprintln!("intentic: the app's own folders will stay: {error}");
    }
    leave(app);
    Ok(Finish {
        closing: true,
        ..Finish::default()
    })
}

/// Quit for good, a moment after the press that asked for it is answered.
fn leave(app: &AppHandle) {
    LEAVING.store(true, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_AFTER);
        app.exit(0);
    });
}

/// Start `command` to outlive this process: no streams of ours, and a process group of its own.
fn detach(mut command: Command) -> std::io::Result<()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    intentic_bounded::own_group(&mut command);
    intentic_bounded::no_window(&mut command);
    command.spawn().map(drop)
}

/// Where the app's uninstaller is: beside it, where every install puts it, else where a per-user install lives (only
/// for a released build, so a development build never starts the uninstaller of the copy installed on the same PC).
/// Pure.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn uninstaller_candidates(
    exe_dir: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = exe_dir
        .map(|dir| dir.join("uninstall.exe"))
        .into_iter()
        .collect();
    if let Some(local) = local_app_data {
        let installed = local.join("Intentic").join("uninstall.exe");
        if !candidates.contains(&installed) {
            candidates.push(installed);
        }
    }
    candidates
}

/// The PowerShell that starts the uninstaller once this process (`pid`) has gone, so it finds no app to close and no
/// file of the app's held open. Pure.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_handoff(pid: u32, uninstaller: &Path) -> String {
    let path = uninstaller.to_string_lossy().replace('\'', "''");
    format!(
        "$ErrorActionPreference = 'SilentlyContinue'; Wait-Process -Id {pid} -Timeout 60; Start-Process -FilePath '{path}' -ArgumentList '/S'"
    )
}

/// Waits for the app (`$1`) to exit, at most about thirty seconds, then deletes what follows it.
#[cfg_attr(windows, allow(dead_code))]
const LINUX_CLEANUP: &str =
    "n=0; while kill -0 \"$1\" 2>/dev/null && [ \"$n\" -lt 150 ]; do sleep 0.2; n=$((n+1)); done; shift; rm -rf -- \"$@\"";

/// The home folder and the XDG folders as the environment names them.
#[derive(Debug, Clone, Default)]
#[cfg_attr(windows, allow(dead_code))]
pub struct UserDirs {
    pub home: Option<PathBuf>,
    pub config: Option<PathBuf>,
    pub data: Option<PathBuf>,
    pub cache: Option<PathBuf>,
}

/// What the app keeps in a Linux home folder, which ic leaves to the app when told `--without-app`: its config, data and
/// cache folders (Tauri's, by the app's identifier), its entry for starting at login (autostart.rs), and the handler
/// entry for `intentic://` links (the deep-link plugin's, named after the program). An XDG folder that is not absolute
/// is ignored, as the spec says. Pure.
#[cfg_attr(windows, allow(dead_code))]
pub fn user_leftovers(dirs: &UserDirs, exe_name: &str) -> Vec<PathBuf> {
    let xdg = |set: &Option<PathBuf>, fallback: &[&str]| -> Option<PathBuf> {
        set.clone().filter(|path| path.is_absolute()).or_else(|| {
            dirs.home
                .as_ref()
                .filter(|home| home.is_absolute())
                .map(|home| {
                    fallback
                        .iter()
                        .fold(home.clone(), |path, part| path.join(part))
                })
        })
    };
    let id = crate::launch::IDENTIFIER;
    let mut doomed = Vec::new();
    if let Some(config) = xdg(&dirs.config, &[".config"]) {
        doomed.push(config.join(id));
        doomed.push(config.join("autostart").join(format!("{id}.desktop")));
    }
    if let Some(data) = xdg(&dirs.data, &[".local", "share"]) {
        doomed.push(data.join(id));
        doomed.push(
            data.join("applications")
                .join(format!("{exe_name}-handler.desktop")),
        );
    }
    if let Some(cache) = xdg(&dirs.cache, &[".cache"]) {
        doomed.push(cache.join(id));
    }
    doomed
}

/// The package this app was installed from.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(windows, allow(dead_code))]
pub enum Package {
    Deb(String),
    Rpm(String),
}

/// The package `dpkg -S <file>` says owns it: `intentic: /usr/bin/intentic-desktop`, or `intentic:amd64: …` on a
/// multiarch system. Pure.
#[cfg_attr(windows, allow(dead_code))]
pub fn deb_owner(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let (owner, _) = line.split_once(": ")?;
    let name = owner.split(':').next()?.trim();
    // Several packages ("a, b: path") is a diversion or a shared path, never this app's own file.
    (!name.is_empty() && !name.contains(',') && !name.contains(' ')).then(|| name.to_string())
}

/// The package `rpm -qf --queryformat '%{NAME}\n' <file>` names. Pure.
#[cfg_attr(windows, allow(dead_code))]
pub fn rpm_owner(stdout: &str) -> Option<String> {
    let name = stdout.lines().next()?.trim();
    (!name.is_empty() && !name.contains(' ')).then(|| name.to_string())
}

/// The command that removes `package`, by the package managers `have` says are on this computer. Pure.
#[cfg_attr(windows, allow(dead_code))]
pub fn remove_command(package: &Package, have: impl Fn(&str) -> bool) -> Vec<String> {
    let words: Vec<&str> = match package {
        Package::Deb(name) if have("apt-get") => vec!["apt-get", "remove", "-y", name],
        Package::Deb(name) => vec!["dpkg", "-r", name],
        Package::Rpm(name) if have("dnf") => vec!["dnf", "remove", "-y", name],
        Package::Rpm(name) if have("zypper") => vec!["zypper", "--non-interactive", "remove", name],
        Package::Rpm(name) if have("yum") => vec!["yum", "remove", "-y", name],
        Package::Rpm(name) => vec!["rpm", "-e", name],
    };
    words.into_iter().map(str::to_string).collect()
}

/// Whether `program` is on the PATH.
#[cfg(not(windows))]
fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(program).is_file()))
}

/// The deb or rpm that owns the app's program, asked of dpkg, then rpm. None for an app that came from neither (a
/// build, an unpacked archive).
#[cfg(not(windows))]
fn installed_package(exe: &Path) -> Option<Package> {
    let ask = |program: &str, args: &[&str]| -> Option<String> {
        let mut command = Command::new(program);
        command.args(args).arg(exe);
        let answer = intentic_bounded::capture(
            command,
            Duration::from_secs(20),
            intentic_bounded::Reach::Tree,
        )
        .ok()?;
        answer.success().then_some(answer.stdout)
    };
    ask("dpkg", &["-S"])
        .as_deref()
        .and_then(deb_owner)
        .map(Package::Deb)
        .or_else(|| {
            ask("rpm", &["-qf", "--queryformat", "%{NAME}\n"])
                .as_deref()
                .and_then(rpm_owner)
                .map(Package::Rpm)
        })
}

/// Remove the package through `pkexec`, which asks for the system password in a window of its own. `Err` is why not,
/// for the dialog: no `pkexec`, the prompt dismissed or refused, the package manager's own failure.
#[cfg(not(windows))]
fn remove_package(remove: &[String]) -> Result<(), String> {
    let mut command = Command::new("pkexec");
    command.args(remove);
    let answer = intentic_bounded::capture(command, PACKAGE_LIMIT, intentic_bounded::Reach::Tree)
        .map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            "This computer has no pkexec to ask for the password that removes the app's package."
                .to_string()
        }
        _ => format!("pkexec would not start: {error}"),
    })?;
    if answer.timed_out {
        return Err("Nobody answered the password prompt.".to_string());
    }
    match answer.code {
        Some(0) => Ok(()),
        // pkexec's own: the prompt was dismissed (126), or the password refused (127).
        Some(126 | 127) => Err("The password prompt was closed or refused.".to_string()),
        _ => Err(crate::engine::last_words(
            &answer.stdout,
            &answer.stderr,
            "removing the app's package",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_choice_is_one_of_two_words_and_nothing_else_reaches_the_command_line() {
        assert_eq!(Choice::parse("everything"), Ok(Choice::Everything));
        assert_eq!(Choice::parse("keep-sandboxes"), Ok(Choice::KeepSandboxes));
        for bad in [
            "",
            "Everything",
            "keep",
            "--delete-data",
            "everything --yes",
        ] {
            assert!(Choice::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn everything_deletes_data_with_the_typed_count_and_keeping_never_does() {
        assert_eq!(
            run_args(Choice::Everything, Some(3)),
            [
                "uninstall",
                "--without-app",
                "--yes",
                "--delete-data",
                "--confirm",
                "3"
            ]
        );
        // Passwords and no sandbox: nothing to count.
        assert_eq!(
            run_args(Choice::Everything, None),
            ["uninstall", "--without-app", "--yes", "--delete-data"]
        );
        assert_eq!(
            run_args(Choice::Everything, Some(0)),
            ["uninstall", "--without-app", "--yes", "--delete-data"]
        );
        // A count is never a reason to delete anything when the reader chose to keep.
        let keep = run_args(Choice::KeepSandboxes, Some(3));
        assert_eq!(
            keep,
            ["uninstall", "--without-app", "--yes", "--keep-sandboxes"]
        );
        assert!(!keep
            .iter()
            .any(|arg| arg == "--delete-data" || arg == "--confirm"));
    }

    #[test]
    fn the_inventory_reads_the_contracts_document_and_passes_over_what_it_does_not_know() {
        let printed = json!({
            "version": 1,
            "os": "windows",
            "sandboxes": [
                { "slug": "sandbox-ab12", "kind": "sandbox", "state": "running", "bytes": 4_100_000_000u64 },
                { "slug": "runner-x", "kind": "runner", "state": "removed", "bytes": null, "since": "new field" }
            ],
            "deleteCount": 2,
            "passwords": true,
            "engine": { "bytes": 18_000_000_000u64, "holdsOthers": false },
            "agent": { "folders": 2, "distros": ["Ubuntu"] },
            "app": { "version": "1.340.0" },
            "cacheBytes": 1_400_000_000u64,
            "stays": ["Docker Desktop", "WSL"],
            "found": ["the Intentic app", "2 sandboxes (4.1 GB)"],
            "steps": { "everything": [ { "step": "stop", "label": "Stop Intentic" } ], "keep-sandboxes": [] },
            "somethingNew": { "x": 1 }
        });
        let inventory = inventory_from(&format!("intentic: looking…\n{printed}\n")).expect("read");
        assert_eq!(inventory.delete_count, 2);
        assert_eq!(inventory.sandboxes[1].bytes, None);
        assert_eq!(inventory.sandboxes[0].bytes, Some(4_100_000_000));
        assert_eq!(inventory.agent.as_ref().map(|agent| agent.folders), Some(2));
        assert_eq!(inventory.steps["everything"][0].label, "Stop Intentic");
        assert_eq!(inventory.found[1], "2 sandboxes (4.1 GB)");
        // Absent is none, not an error: no engine, no agent here.
        let bare = inventory_from(r#"{"version":1,"sandboxes":[],"steps":{}}"#).expect("read");
        assert_eq!(
            (bare.engine, bare.agent, bare.passwords),
            (None, None, false)
        );
        // Words, or an object about something else, are not an inventory.
        assert_eq!(
            inventory_from("error: unrecognized subcommand 'uninstall'"),
            None
        );
        assert_eq!(inventory_from(r#"{"engine":"dockerDesktop"}"#), None);
        // Serialized back for the page in its own spelling.
        let page = serde_json::to_value(&inventory).expect("json");
        assert_eq!(page["deleteCount"], 2);
        assert_eq!(page["engine"]["holdsOthers"], false);
    }

    #[test]
    fn a_marker_line_is_the_json_object_after_it_and_nothing_else_is() {
        assert_eq!(
            parse_line(
                r#"intentic-uninstall: {"step":"sandboxes","state":"running","label":"Delete 3 sandboxes"}"#
            ),
            Some(json!({ "step": "sandboxes", "state": "running", "label": "Delete 3 sandboxes" }))
        );
        assert_eq!(
            parse_line("  intentic-uninstall: {\"result\":\"done\",\"stays\":[],\"failed\":[]}\r"),
            Some(json!({ "result": "done", "stays": [], "failed": [] }))
        );
        for other in [
            "intentic: removed 3 sandboxes",
            "intentic-uninstall: [1]",
            "intentic-uninstall: {\"step\":",
            "intentic-move: {\"step\":\"done\"}",
            "",
        ] {
            assert_eq!(parse_line(other), None, "{other:?}");
        }
    }

    fn heard(lines: &[&str]) -> Progress {
        let mut progress = Progress::default();
        for line in lines {
            if let Some(said) = parse_line(line) {
                progress.hear(&said);
            }
        }
        progress
    }

    const PLAN: &str = r#"intentic-uninstall: {"plan":[{"step":"stop","label":"Stop Intentic"},{"step":"sandboxes","label":"Delete 3 sandboxes"},{"step":"files","label":"Delete Intentic's files and caches"},{"step":"ic","label":"Remove ic"}],"choice":"everything"}"#;

    #[test]
    fn the_plan_comes_first_and_each_step_moves_through_it() {
        let progress = heard(&[
            PLAN,
            r#"intentic-uninstall: {"step":"stop","state":"running","label":"Stop Intentic"}"#,
            r#"intentic-uninstall: {"step":"stop","state":"done","label":"Stop Intentic","detail":"Stopped the machine agent."}"#,
            r#"intentic-uninstall: {"step":"sandboxes","state":"running","label":"Delete 3 sandboxes","detail":"sandbox-ab12"}"#,
        ]);
        assert_eq!(progress.choice.as_deref(), Some("everything"));
        let states: Vec<(&str, &str)> = progress
            .steps
            .iter()
            .map(|step| (step.step.as_str(), step.state.as_str()))
            .collect();
        assert_eq!(
            states,
            [
                ("stop", "done"),
                ("sandboxes", "running"),
                ("files", "pending"),
                ("ic", "pending")
            ]
        );
        assert_eq!(
            progress.steps[0].detail.as_deref(),
            Some("Stopped the machine agent.")
        );
        assert_eq!(progress.steps[1].detail.as_deref(), Some("sandbox-ab12"));
        assert_eq!(progress.outcome, None);
    }

    #[test]
    fn hearing_the_same_thing_twice_changes_nothing_so_the_windows_are_told_once() {
        let mut progress = Progress::default();
        let line = parse_line(PLAN).expect("plan");
        assert!(progress.hear(&line));
        assert!(!progress.hear(&line));
        assert!(!progress.hear(&json!({ "said": "something else" })));
    }

    #[test]
    fn a_step_ic_never_planned_aloud_is_drawn_at_the_end() {
        let progress = heard(&[
            PLAN,
            r#"intentic-uninstall: {"step":"distros","state":"skipped","label":"Remove Intentic from WSL (Ubuntu)"}"#,
        ]);
        let last = progress.steps.last().expect("a step");
        assert_eq!(
            (last.step.as_str(), last.state.as_str(), last.label.as_str()),
            ("distros", "skipped", "Remove Intentic from WSL (Ubuntu)")
        );
    }

    #[test]
    fn ics_own_ending_is_believed_with_each_failure_and_its_fix() {
        let mut progress = heard(&[
            PLAN,
            r#"intentic-uninstall: {"step":"files","state":"failed","label":"Delete Intentic's files and caches","detail":"C:\\Users\\a\\.intentic\\logs is in use"}"#,
            r#"intentic-uninstall: {"result":"partial","stays":["Docker Desktop"],"failed":[{"label":"Delete Intentic's files and caches","problem":"a file is in use","fix":"ic uninstall --delete-data"}]}"#,
        ]);
        progress.end(
            Some(1),
            Some("ignored, ic said its ending".into()),
            Some("/tmp/u.log".into()),
        );
        let outcome = progress.outcome.expect("an ending");
        assert_eq!(outcome.result, "partial");
        assert_eq!(outcome.stays, ["Docker Desktop"]);
        assert_eq!(outcome.code, Some(1));
        assert_eq!(
            outcome.failed,
            [Failure {
                label: "Delete Intentic's files and caches".into(),
                problem: "a file is in use".into(),
                fix: Some("ic uninstall --delete-data".into()),
            }]
        );
        assert_eq!(progress.log.as_deref(), Some("/tmp/u.log"));
    }

    #[test]
    fn done_with_a_failure_listed_is_partial() {
        let mut progress = heard(&[
            r#"intentic-uninstall: {"result":"done","stays":[],"failed":[{"label":"Remove ic","problem":"in use"}]}"#,
        ]);
        progress.end(Some(0), None, None);
        let outcome = progress.outcome.expect("an ending");
        assert_eq!(outcome.result, "partial");
        assert_eq!(outcome.failed[0].fix, None);
    }

    #[test]
    fn an_ic_that_stopped_without_an_ending_failed_on_the_step_it_was_on() {
        let mut progress = heard(&[
            PLAN,
            r#"intentic-uninstall: {"step":"stop","state":"done"}"#,
            r#"intentic-uninstall: {"step":"sandboxes","state":"running"}"#,
        ]);
        progress.end(None, None, None);
        assert_eq!(progress.steps[1].state, "failed");
        assert_eq!(progress.steps[2].state, "pending");
        let outcome = progress.outcome.expect("an ending");
        assert_eq!(outcome.result, "partial");
        assert_eq!(outcome.failed[0].label, "Delete 3 sandboxes");
        assert_eq!(
            outcome.failed[0].problem,
            "ic was stopped before it finished."
        );

        // Its own error line is the reason, where it gave one; with no step begun, the first is where it stopped.
        let mut early = heard(&[PLAN]);
        early.end(Some(1), Some("docker did not answer".into()), None);
        assert_eq!(early.steps[0].state, "failed");
        let outcome = early.outcome.expect("an ending");
        assert_eq!(outcome.failed[0].problem, "docker did not answer");
        assert_eq!(outcome.failed[0].label, "Stop Intentic");

        // No plan at all: the uninstall as a whole.
        let mut nothing = Progress::default();
        nothing.end(Some(2), None, None);
        let outcome = nothing.outcome.expect("an ending");
        assert_eq!(outcome.failed[0].label, "Uninstall Intentic");
        assert_eq!(
            outcome.failed[0].problem,
            "ic stopped before it finished (exit 2)."
        );
    }

    #[test]
    fn an_ic_that_exited_cleanly_without_saying_so_is_done() {
        let mut progress = heard(&[
            PLAN,
            r#"intentic-uninstall: {"step":"stop","state":"running"}"#,
        ]);
        progress.end(Some(0), None, None);
        assert!(progress.steps.iter().all(|step| step.state == "done"));
        assert_eq!(progress.outcome.expect("an ending").result, "done");
    }

    #[test]
    fn the_windows_read_the_progress_in_their_own_spelling() {
        let mut progress = heard(&[PLAN]);
        progress.end(Some(0), None, Some("/tmp/u.log".into()));
        let page = serde_json::to_value(&progress).expect("json");
        assert_eq!(page["choice"], "everything");
        assert_eq!(page["steps"][0]["state"], "done");
        assert_eq!(page["outcome"]["result"], "done");
        assert_eq!(page["log"], "/tmp/u.log");
    }

    #[test]
    fn only_the_first_error_line_is_a_reason() {
        assert_eq!(
            error_line("error: docker did not answer"),
            Some("docker did not answer".into())
        );
        assert_eq!(error_line("  error:   "), None);
        assert_eq!(error_line("warning: slow"), None);
    }

    #[test]
    fn another_run_of_the_apps_holds_the_uninstall_but_its_own_sandbox_setup_and_download_do_not() {
        assert_eq!(
            busy_sentence(&[
                crate::machine_sandbox::RUN.to_string(),
                crate::onboarding::PREFETCH_RUNS[0].to_string()
            ]),
            None
        );
        assert_eq!(busy_sentence(&[]), None);
        let said =
            busy_sentence(&["setup".to_string(), "recreate:work".to_string()]).expect("busy");
        assert!(said.contains("setting up a sandbox"), "{said}");
        assert!(said.contains("updating work"), "{said}");
    }

    #[test]
    fn the_uninstaller_is_the_one_beside_the_app_first() {
        let local = Path::new("C:/Users/a/AppData/Local");
        let dir = local.join("Intentic");
        assert_eq!(
            uninstaller_candidates(Some(&dir), Some(local)),
            [dir.join("uninstall.exe")]
        );
        let elsewhere = Path::new("C:/Program Files/Intentic");
        assert_eq!(
            uninstaller_candidates(Some(elsewhere), Some(local)),
            [
                elsewhere.join("uninstall.exe"),
                local.join("Intentic").join("uninstall.exe")
            ]
        );
        // A development build is never pointed at the installed copy's uninstaller.
        assert_eq!(
            uninstaller_candidates(Some(elsewhere), None),
            [elsewhere.join("uninstall.exe")]
        );
    }

    #[test]
    fn the_handoff_waits_for_this_app_then_starts_the_uninstaller_silently() {
        let script = windows_handoff(
            4242,
            Path::new(r"C:\Users\O'Brien\AppData\Local\Intentic\uninstall.exe"),
        );
        assert!(script.contains("Wait-Process -Id 4242"));
        // A quote in the path is doubled, PowerShell's own escape inside single quotes.
        assert!(
            script.contains(r"-FilePath 'C:\Users\O''Brien\AppData\Local\Intentic\uninstall.exe'")
        );
        assert!(script.ends_with("-ArgumentList '/S'"));
    }

    #[test]
    #[cfg(unix)]
    fn the_apps_own_folders_follow_the_xdg_folders_and_fall_back_to_the_home_folder() {
        let home = UserDirs {
            home: Some(PathBuf::from("/home/ann")),
            ..UserDirs::default()
        };
        assert_eq!(
            user_leftovers(&home, "intentic-desktop"),
            [
                PathBuf::from("/home/ann/.config/dev.intentic.desktop"),
                PathBuf::from("/home/ann/.config/autostart/dev.intentic.desktop.desktop"),
                PathBuf::from("/home/ann/.local/share/dev.intentic.desktop"),
                PathBuf::from(
                    "/home/ann/.local/share/applications/intentic-desktop-handler.desktop"
                ),
                PathBuf::from("/home/ann/.cache/dev.intentic.desktop"),
            ]
        );
        let xdg = UserDirs {
            home: Some(PathBuf::from("/home/ann")),
            config: Some(PathBuf::from("/cfg")),
            // Relative: ignored, as the spec says.
            data: Some(PathBuf::from("data")),
            cache: Some(PathBuf::from("/var/cache/ann")),
        };
        let doomed = user_leftovers(&xdg, "intentic-desktop");
        assert!(doomed.contains(&PathBuf::from("/cfg/dev.intentic.desktop")));
        assert!(doomed.contains(&PathBuf::from(
            "/home/ann/.local/share/dev.intentic.desktop"
        )));
        assert!(doomed.contains(&PathBuf::from("/var/cache/ann/dev.intentic.desktop")));
        // No home at all: nothing is guessed at.
        assert!(user_leftovers(&UserDirs::default(), "intentic-desktop").is_empty());
    }

    #[test]
    fn the_package_is_named_as_dpkg_and_rpm_name_it() {
        assert_eq!(
            deb_owner("intentic: /usr/bin/intentic-desktop\n"),
            Some("intentic".into())
        );
        assert_eq!(
            deb_owner("intentic:amd64: /usr/bin/intentic-desktop\n"),
            Some("intentic".into())
        );
        assert_eq!(deb_owner("diversion by x from: /usr/bin/y"), None);
        assert_eq!(deb_owner("a, b: /usr/share/thing"), None);
        assert_eq!(deb_owner(""), None);
        assert_eq!(rpm_owner("intentic\n"), Some("intentic".into()));
        assert_eq!(rpm_owner("file /x is not owned by any package"), None);
    }

    #[test]
    fn the_remove_command_uses_the_package_manager_this_computer_has() {
        let only = |have: &'static [&'static str]| move |program: &str| have.contains(&program);
        let deb = Package::Deb("intentic".into());
        let rpm = Package::Rpm("intentic".into());
        assert_eq!(
            remove_command(&deb, only(&["apt-get", "dpkg"])),
            ["apt-get", "remove", "-y", "intentic"]
        );
        assert_eq!(
            remove_command(&deb, only(&["dpkg"])),
            ["dpkg", "-r", "intentic"]
        );
        assert_eq!(
            remove_command(&rpm, only(&["dnf", "rpm"])),
            ["dnf", "remove", "-y", "intentic"]
        );
        assert_eq!(
            remove_command(&rpm, only(&["zypper", "rpm"])),
            ["zypper", "--non-interactive", "remove", "intentic"]
        );
        assert_eq!(
            remove_command(&rpm, only(&["yum", "rpm"])),
            ["yum", "remove", "-y", "intentic"]
        );
        assert_eq!(remove_command(&rpm, only(&[])), ["rpm", "-e", "intentic"]);
    }

    #[test]
    #[cfg(unix)]
    fn the_cleanup_waits_for_the_app_then_deletes_only_what_it_was_given() {
        // Run for real against a process that has already gone and two folders in a scratch folder.
        let scratch = std::env::temp_dir().join(format!("uninstall-test-{}", std::process::id()));
        std::fs::create_dir_all(scratch.join("keep")).expect("scratch");
        let doomed = scratch.join("app data");
        std::fs::create_dir_all(doomed.join("inner")).expect("doomed");
        let status = Command::new("sh")
            .arg("-c")
            .arg(LINUX_CLEANUP)
            .arg("sh")
            .arg("999999999")
            .arg(&doomed)
            .status()
            .expect("sh");
        assert!(status.success());
        assert!(!doomed.exists());
        assert!(scratch.join("keep").exists());
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
