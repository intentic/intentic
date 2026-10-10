use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use intentic_docker_host::refusal::Refusal;
use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

/* THE NATIVE LAYER, AND ALL OF IT — this app runs the same scripts the copy-paste one-liners run. */

/// Where a line came from. The app's own screen renders stderr as the failure detail when a run exits
/// non-zero — the scripts write their progress to stdout and their diagnostics to stderr, and conflating them
/// loses the only thing worth showing when something goes wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stream {
    Stdout,
    Stderr,
}

/// What the app's own screen subscribes to. `run` is the caller's own id (`setup`, `update:<slug>`, …) so one
/// window can render several concurrent runs without the events being routed per-listener.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunEvent {
    /// A run has begun, and where its transcript is being written. Sent before the first line so the screen
    /// can offer the log from the moment there is one — including while a run is still going, which is when
    /// somebody stuck on it most wants something to paste into a support thread.
    Started { run: String, log: Option<String> },
    Line {
        run: String,
        stream: Stream,
        text: String,
    },
    Exit {
        run: String,
        code: Option<i32>,
        ok: bool,
    },
}

pub const RUN_EVENT: &str = "desktop://run";

/// `~/.intentic/logs`, where every run's transcript goes, beside `ic`'s own logs.
pub(crate) fn logs_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|home| !home.is_empty())?;
    Some(Path::new(&home).join(".intentic").join("logs"))
}

/// A run id as a filename: `recreate:work` is not one on Windows, where a colon opens an alternate data stream.
fn safe_name(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/* Until now a run existed only as events in one webview: the lines a user could see were the lines that window happened to still be holding. */
fn log_path(id: &str) -> Option<PathBuf> {
    let dir = logs_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("desktop-{}-{}.log", safe_name(id), stamp())))
}

/* HOW MANY TRANSCRIPTS STAY (2026-10-05). Every run wrote one and none was ever removed, so a machine that ran this app
 * for months held thousands of `desktop-*.log`: the newest KEPT_RUNS runs stay, counted at launch and after every run. */

/// How many runs' files `~/.intentic/logs` keeps: the newest by when each was last written.
pub const KEPT_RUNS: usize = 30;

/// The extensions one run writes: its transcript, and the two files its child writes to ([`Spool`]).
const RUN_FILES: [&str; 3] = ["log", "out", "err"];

/// Which of this app's files in the logs folder to delete so that only the newest `keep` runs remain, given each file's
/// name and when it was last written. A run is its transcript and its child's two files (`desktop-<run>-<stamp>` with
/// `.log`, `.out` or `.err`), kept or deleted together and dated by the newest of them, so a run that is still writing
/// is never the old one. `ic`'s logs and anything else in the folder are not this app's to count. Pure.
pub fn prune_selection(files: &[(String, SystemTime)], keep: usize) -> Vec<String> {
    let mut runs: HashMap<&str, (SystemTime, Vec<&str>)> = HashMap::new();
    for (name, written) in files {
        let Some((stem, extension)) = name.rsplit_once('.') else {
            continue;
        };
        if !stem.starts_with("desktop-") || !RUN_FILES.contains(&extension) {
            continue;
        }
        let run = runs.entry(stem).or_insert((*written, Vec::new()));
        run.0 = run.0.max(*written);
        run.1.push(name.as_str());
    }
    let mut ordered: Vec<(&str, (SystemTime, Vec<&str>))> = runs.into_iter().collect();
    // Newest first; a tie goes to the later name, whose stamp is the later one.
    ordered.sort_by(|a, b| (b.1 .0, b.0).cmp(&(a.1 .0, a.0)));
    let mut doomed: Vec<String> = ordered
        .into_iter()
        .skip(keep)
        .flat_map(|(_, (_, names))| names.into_iter().map(str::to_string))
        .collect();
    doomed.sort();
    doomed
}

/// Delete every run's files past the newest [`KEPT_RUNS`] (lib.rs at launch, and [`follow`] after each run). Best effort:
/// a file another process still holds open on Windows stays until the next count.
pub fn prune_logs() {
    let Some(dir) = logs_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let files: Vec<(String, SystemTime)> = entries
        .flatten()
        .filter_map(|entry| {
            let written = entry.metadata().ok()?.modified().ok()?;
            Some((entry.file_name().to_string_lossy().into_owned(), written))
        })
        .collect();
    for name in prune_selection(&files, KEPT_RUNS) {
        let _ = std::fs::remove_file(dir.join(name));
    }
    let names: Vec<String> = files.into_iter().map(|(name, _)| name).collect();
    for name in prefetch_logs_to_prune(&names, KEPT_RUNS) {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// The image prefetch's logs (prefetch.rs, `prefetch-<stamp>.log`) past the newest `keep`: one per setup that started
/// one, kept as many as the setups' own. The stamp sorts by time, so the name is the order. Pure.
pub fn prefetch_logs_to_prune(names: &[String], keep: usize) -> Vec<String> {
    let mut logs: Vec<&String> = names
        .iter()
        .filter(|name| name.starts_with("prefetch-") && name.ends_with(".log"))
        .collect();
    logs.sort_by(|a, b| b.cmp(a));
    logs.into_iter().skip(keep).cloned().collect()
}

/// `YYYYmmdd-HHMMSS`, UTC, for a log filename — the same spelling `ic` uses, so the two sets of logs in the
/// directory sort together. Derived here rather than pulled in as a dependency for one filename.
pub(crate) fn stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    let (hour, minute, second) = (rest / 3600, (rest % 3600) / 60, rest % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

/* There was no way to end one of these. */
fn running() -> &'static Mutex<HashMap<String, u32>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember(id: &str, pid: u32) {
    if let Ok(mut live) = running().lock() {
        live.insert(id.to_string(), pid);
    }
}

fn forget(id: &str) {
    if let Ok(mut live) = running().lock() {
        live.remove(id);
    }
}

/// Whether anything this app spawned is still going — the guard the self-updater checks before it replaces
/// this executable and ends the process (update.rs). An install that lands mid-`connect.ps1` kills a
/// four-minute run somebody is watching, and takes the window reporting it with it.
///
/// A poisoned lock answers "busy": the wrong answer costs one deferred update, and the other wrong answer
/// costs somebody's install.
pub fn busy() -> bool {
    busy_except(&[])
}

/// Runs other than the ones the caller can safely stop first. The updater pauses onboarding's resumable downloads;
/// a setup, a project change, or any other run still holds it. A poisoned lock remains a refusal.
pub fn busy_except(except: &[&str]) -> bool {
    running()
        .lock()
        .map(|live| live.keys().any(|id| !except.contains(&id.as_str())))
        .unwrap_or(true)
}

/// The ids of the runs going right now, sorted: what a Quit asks about (windows.rs `hold_quit`). A poisoned lock answers
/// none, since that question is only ever a courtesy on the way out.
pub fn running_ids() -> Vec<String> {
    let mut ids: Vec<String> = running()
        .lock()
        .map(|live| live.keys().cloned().collect())
        .unwrap_or_default();
    ids.sort();
    ids
}

/// Whether the run `id` is going right now: a second setup asked for while one runs is refused before it makes anything
/// (project.rs), since both would drive the same docker and report under the same id.
pub fn is_running(id: &str) -> bool {
    running()
        .lock()
        .map(|live| live.contains_key(id))
        .unwrap_or(true)
}

/// End a run and everything it started. The tree matters more than the process: the shim is `powershell.exe`
/// or `sh`, and the thing actually doing the work — `ic`, `docker`, an installer — is its child. Killing only
/// what we spawned would leave a 600 MB download running behind a window that says it stopped.
pub fn stop(id: &str) -> Result<(), String> {
    let pid = running()
        .lock()
        .ok()
        .and_then(|live| live.get(id).copied())
        .ok_or_else(|| format!("nothing called {id} is running on this device"))?;
    match intentic_bounded::kill_tree(pid, intentic_bounded::Signal::Term) {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("could not stop it (exit {:?})", status.code())),
        Err(error) => Err(format!("could not stop it: {error}")),
    }
}

/* A SHORT CHILD, BOUNDED — every docker read and every agent call this window waits on goes through `capture`. */

/// What a bounded child said, once it exited.
#[derive(Debug)]
pub struct Captured {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Why a bounded child has no answer. Displayed as it stands, so each reads as a sentence about `what`.
#[derive(Debug, PartialEq, Eq)]
pub enum Unanswered {
    /// It could not be started. `kind` is the OS's own answer, kept because only `NotFound` means there is no such
    /// binary: a binary that is there and would not start (a command line too long, no permission to run it) is a
    /// different sentence, and a caller looking in several places must not read it as "not here" and move on.
    NotStarted {
        what: String,
        reason: String,
        kind: std::io::ErrorKind,
    },
    TimedOut {
        what: String,
        limit: Duration,
    },
}

impl std::fmt::Display for Unanswered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unanswered::NotStarted { what, reason, .. } => {
                write!(f, "{what} would not run: {reason}")
            }
            Unanswered::TimedOut { what, limit } => {
                write!(f, "{what} did not answer within {}s", limit.as_secs())
            }
        }
    }
}

/// Run `command` to its exit, or kill its whole tree at `limit`: the helper `ic` shares (`intentic-bounded`). The
/// exit ends the wait, never the pipes: a background process it leaves behind inherits them on Windows, so the
/// streams get the crate's drain grace after the exit and no more.
pub fn capture(what: &str, command: Command, limit: Duration) -> Result<Captured, Unanswered> {
    let ran = intentic_bounded::capture(command, limit, intentic_bounded::Reach::Tree).map_err(
        |error| Unanswered::NotStarted {
            what: what.to_string(),
            reason: error.to_string(),
            kind: error.kind(),
        },
    )?;
    if ran.timed_out {
        return Err(Unanswered::TimedOut {
            what: what.to_string(),
            limit,
        });
    }
    Ok(Captured {
        success: ran.success(),
        stdout: ran.stdout,
        stderr: ran.stderr,
    })
}

/// Which script family a run targets, and therefore which argument convention and which interpreter. Every
/// flow has a `.sh` and a `.ps1` sibling in `_site/site/public/scripts/`, and this is the only platform branch
/// in this app.
///
/// It is a VALUE rather than three separate `cfg!(windows)` reads because the three decisions it drives —
/// which file, how its arguments bind, what runs it — must agree, and because a compile-time branch is only
/// ever exercised on the host that compiled it. The Windows installer is cross-built on a Linux runner and the
/// `.ps1` conventions are never executed before a release; naming the platform is what lets one `cargo test`
/// cover both halves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Host {
    Unix,
    Windows,
}

impl Host {
    /// The host this build runs on — the only producer outside tests.
    pub const fn current() -> Host {
        if cfg!(windows) {
            Host::Windows
        } else {
            Host::Unix
        }
    }

    /// Pick a flow's sibling script for this host.
    pub const fn script(self, unix: &'static str, windows: &'static str) -> &'static str {
        match self {
            Host::Unix => unix,
            Host::Windows => windows,
        }
    }
}

/// One script invocation. `env` carries what the scripts read from the environment (SETUP_CODE, CF_TOKEN,
/// SYNC_DIR, WEB_ORIGIN, PLATFORM_URL, SANDBOX_IMAGE); `args` carries what they read positionally.
pub struct ScriptRun {
    /// Basename in the bundled scripts directory, e.g. `connect.sh` — pick it with [`Host::script`].
    pub file: &'static str,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Run through `pkexec` on Linux. Only ever true for the one thing that genuinely needs root — installing
    /// Docker on a machine that has none. connect.sh's own `require_root_to_install_docker` states the same
    /// deal from the other side, and the setup screen's "I already have Docker" checkbox is the browser's
    /// version of this decision.
    pub elevate: bool,
    /// The host whose conventions `file` and `args` were built for.
    pub host: Host,
}

fn resource(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(format!("scripts/{file}"), BaseDirectory::Resource)
        .map_err(|error| format!("{file} is missing from this build: {error}"))
}

/// Seconds a `docker info` gets: a booting Docker Desktop accepts on its pipe and then answers nothing at all.
const DOCKER_PROBE_LIMIT: Duration = Duration::from_secs(10);

/// Seconds a docker read (`ps`, `info`, `logs`) gets before the screen says Docker is not answering.
pub const DOCKER_READ_LIMIT: Duration = Duration::from_secs(20);

/// Can this user reach a Docker daemon right now? Decides elevation on Linux, and on Windows it is what tells
/// "Docker Desktop isn't installed" (connect.ps1 offers the winget install) from "it is, but not started".
pub fn docker_ready() -> bool {
    let mut command = docker();
    command.args(["info", "--format", "{{.ServerVersion}}"]);
    capture("docker info", command, DOCKER_PROBE_LIMIT).is_ok_and(|answer| answer.success)
}

/* THE ENGINE NOBODY ELSE STARTS.
 *
 * Docker Desktop's "Start Docker Desktop when you sign in to your computer" is OFF by default on every
 * platform — Docker's own settings reference says so, and a machine here reads `"AutoStart": false` in
 * settings-store.json. So the morning after a restart, a computer that hosts a sandbox has no engine, the
 * container's `--restart unless-stopped` has nothing to be restarted by, and the person who bought this to
 * avoid a terminal is looking at a workspace that will not load.
 *
 * This app is the thing that opens on that machine. So this app starts the engine: on launch when the window
 * is opening anyway (lib.rs), and from the card when a start did not work out. It is never a background
 * daemon and never a login item — the wait belongs to an action somebody took.
 */

/// The engine's named pipe, as Windows spells it.
const ENGINE_PIPE: &str = r"\\.\pipe\docker_engine";

/// How long Docker Desktop gets. A FIRST start unpacks the engine and boots a VM, and three minutes is normal
/// on a laptop; ic's `prepare::fix` allows the same five and it was the right call there for the same reason.
pub const ENGINE_LIMIT: Duration = Duration::from_secs(300);

/// Where the engine listens on this machine, in the order worth trying. `DOCKER_HOST` wins when it names a
/// path, because somebody who set it meant it; otherwise the sockets Docker Desktop actually creates — the
/// per-user one a default macOS install leaves the `desktop-linux` context pointing at, and the shared one.
///
/// A VALUE rather than a `cfg!` read, for [`sync_agent_candidates`]'s reason: the Windows spelling is
/// cross-built on a Linux runner and first executes on somebody's PC, so one `cargo test` covers both halves.
pub fn engine_endpoints(host: Host, docker_host: Option<&str>, home: Option<&str>) -> Vec<String> {
    // A `tcp://` or `ssh://` DOCKER_HOST is somebody else's daemon: there is no socket here to look at and
    // nothing this app could start would help, so the list is empty (see `engine_listening`).
    if let Some(explicit) = docker_host.filter(|value| !value.is_empty()) {
        return endpoint_path(host, explicit).into_iter().collect();
    }
    if host == Host::Windows {
        return vec![ENGINE_PIPE.to_string()];
    }
    let mut found = Vec::new();
    if let Some(home) = home.filter(|home| !home.is_empty()) {
        found.push(format!("{home}/.docker/run/docker.sock"));
    }
    found.push("/var/run/docker.sock".to_string());
    found
}

/// The path inside a `DOCKER_HOST`, or None when it names something no local socket answers for.
fn endpoint_path(host: Host, docker_host: &str) -> Option<String> {
    if let Some(path) = docker_host.strip_prefix("unix://") {
        return (host == Host::Unix).then(|| path.to_string());
    }
    // `npipe:////./pipe/docker_engine` is the same pipe written the way a URL has to be written.
    if let Some(path) = docker_host.strip_prefix("npipe://") {
        return (host == Host::Windows).then(|| path.replace('/', "\\"));
    }
    None
}

/// Is the engine LISTENING, right now? Microseconds, because the launch path asks this before any window
/// exists: [`docker_ready`] against a stopped daemon spends tens of seconds reaching the same answer, and a
/// window that waits for it is a window that opens late on precisely the machines this is about.
pub fn engine_listening() -> bool {
    if let Some(engine) = engine_env() {
        return tcp_listening(&engine.docker_host);
    }
    let docker_host = std::env::var("DOCKER_HOST").ok();
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    let endpoints = engine_endpoints(Host::current(), docker_host.as_deref(), home.as_deref());
    // Nothing local to probe is a daemon this app cannot start, so the docker CLI's own answer decides instead.
    endpoints.is_empty() || endpoints.iter().any(|endpoint| listening_at(endpoint))
}

/// Our engine's endpoint (`tcp://127.0.0.1:<port>`, forwarded by WSL into its distro) takes a connection: a port the
/// keeper's `dockerd` holds. A refused or timed-out connect is an engine that is not running.
fn tcp_listening(docker_host: &str) -> bool {
    let Some(address) = docker_host
        .strip_prefix("tcp://")
        .and_then(|at| at.parse::<std::net::SocketAddr>().ok())
    else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&address, Duration::from_millis(400)).is_ok()
}

/// Our engine was stopped on purpose (`ic engine stop`): ic's `~/.intentic/engine/held`, which nothing that keeps the
/// engine running may override.
pub(crate) fn engine_held() -> bool {
    engine_home().is_some_and(|home| home.join(".intentic").join("engine").join("held").exists())
}

/// A move between engines is running (ic's `~/.intentic/engine/moves.json`, a `moving` entry whose heartbeat is
/// under ten minutes old): every container is in somebody's hands, and nothing here starts or restarts one.
pub(crate) fn engine_move_running() -> bool {
    let Some(home) = engine_home() else {
        return false;
    };
    let Ok(text) =
        std::fs::read_to_string(home.join(".intentic").join("engine").join("moves.json"))
    else {
        return false;
    };
    move_running_in(&text, now_ms())
}

fn move_running_in(text: &str, now: u64) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|journal| journal["moving"]["heartbeat"].as_u64())
        .is_some_and(|beat| now.saturating_sub(beat) < 10 * 60 * 1000)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

fn engine_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

/// `ic engine start` for our engine, bounded: the installed ic, or the one beside this app. `quiet` is the background
/// start, which leaves an engine stopped on purpose (or not switched on) alone; without it the start is a person's
/// own, and ends any hold.
pub(crate) fn start_our_engine(quiet: bool, limit: Duration) -> Result<(), String> {
    let home = engine_home().map(|home| home.to_string_lossy().into_owned());
    let installed = ic_candidates(Host::current(), home.as_deref())
        .into_iter()
        .find(|candidate| Path::new(candidate).is_file());
    let ic = installed
        .map(PathBuf::from)
        .or_else(crate::commands::bundled_ic)
        .ok_or_else(|| "ic is not installed on this computer.".to_string())?;
    let mut command = quiet_command(&ic);
    command.args(["engine", "start"]);
    if quiet {
        command.arg("--quiet");
    }
    match capture("ic engine start", command, limit) {
        Ok(answer) if answer.success => Ok(()),
        Ok(answer) => Err(answer
            .stderr
            .lines()
            .chain(answer.stdout.lines())
            .rfind(|line| !line.trim().is_empty())
            .unwrap_or("ic engine start failed")
            .trim()
            .to_string()),
        Err(silence) => Err(format!("ic engine start did not finish: {silence}")),
    }
}

fn quiet_command(program: &Path) -> Command {
    quiet(Command::new(program))
}

/// Three answers, all of them instant: the pipe opened (an engine), every instance is busy or this account is
/// refused (still an engine), or there is no such pipe. Only the last one is a no.
#[cfg(windows)]
fn listening_at(endpoint: &str) -> bool {
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(endpoint)
    {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

#[cfg(unix)]
fn listening_at(endpoint: &str) -> bool {
    match std::os::unix::net::UnixStream::connect(endpoint) {
        Ok(_) => true,
        // A socket that refuses THIS USER has a daemon behind it, exactly as a pipe that does on Windows: the
        // answer to that is a group membership (see `engine_denied`), and never a longer wait or a restart.
        Err(error) => error.kind() == std::io::ErrorKind::PermissionDenied,
    }
}

/// Why Docker Desktop did not start. The two differ on screen: one is a missing install and the other is an
/// install that would not run, and only the first of those is something to go and get.
///
/// `Failed` is only reachable where there is a launcher to fail — on the platforms whose start is one command
/// that either exists or does not, every refusal is the first variant.
#[cfg_attr(not(windows), allow(dead_code))]
pub enum StartTrouble {
    NotInstalled(String),
    Failed(String),
}

/// Start Docker Desktop. `Ok` means a process was started — never that the engine is up, which is
/// [`wait_for_engine`]'s question. `foreground` puts its own window in front, which is what "Open Docker
/// Desktop" means on a card that has just told somebody to look at it.
#[cfg(windows)]
pub fn start_docker_desktop(foreground: bool) -> Result<(), StartTrouble> {
    // Windows has one way to launch an app and it raises the window either way; the flag only means something
    // where `open` has a switch for it.
    let _ = foreground;
    let exe = docker_desktop_exe().ok_or_else(|| {
        StartTrouble::NotInstalled(
            "Docker Desktop is not installed where this app can find it.".to_string(),
        )
    })?;
    quiet(Command::new(&exe))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| StartTrouble::Failed(format!("{exe} would not start: {error}")))
}

/// Docker Desktop's launcher, by the discovery `ic` runs too (`intentic_docker_host::desktop_app`): a default install
/// or the app the CLI on PATH shipped inside (a file check each), else the whole probe — the registry, the uninstall
/// entry, the Start-menu shortcuts — which costs a PowerShell start and is only reached when the cheap half found nothing.
#[cfg(windows)]
fn docker_desktop_exe() -> Option<String> {
    use intentic_docker_host::{desktop_app, powershell};
    let cheap = desktop_app::default_installs_here()
        .into_iter()
        .chain(
            docker_cli_path()
                .as_deref()
                .and_then(desktop_app::app_beside_cli),
        )
        .find(|path| Path::new(path).exists());
    if cheap.is_some() {
        return cheap;
    }
    let mut command = quiet(Command::new("powershell.exe"));
    command.args(powershell::args(&desktop_app::locate_script()));
    capture("locating Docker Desktop", command, Duration::from_secs(30))
        .ok()
        .filter(|answer| answer.success)
        .and_then(|answer| desktop_app::located(&answer.stdout))
}

/// What `~/.intentic/engine/engine.json` names when this PC runs our own engine (IC CONTRACT item 4). Read on every
/// spawn: the record appears mid-setup and is never cached for the app's lifetime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EngineEnv {
    pub docker_host: String,
    pub cert_path: String,
    pub bin_dir: PathBuf,
}

impl EngineEnv {
    fn apply_to(&self, command: &mut Command) {
        command.env("DOCKER_HOST", &self.docker_host);
        command.env("DOCKER_TLS_VERIFY", "1");
        command.env("DOCKER_CERT_PATH", &self.cert_path);
        if let Some(path) = path_with_bin_first(&self.bin_dir) {
            command.env("PATH", path);
        }
    }

    fn as_pairs(&self) -> Vec<(String, String)> {
        let mut pairs = vec![
            ("DOCKER_HOST".into(), self.docker_host.clone()),
            ("DOCKER_TLS_VERIFY".into(), "1".into()),
            ("DOCKER_CERT_PATH".into(), self.cert_path.clone()),
        ];
        if let Some(path) = path_with_bin_first(&self.bin_dir) {
            pairs.push(("PATH".into(), path));
        }
        pairs
    }
}

/// The intentic engine record, when present and valid. `None` when the file is missing, malformed, or not our engine.
pub(crate) fn engine_env() -> Option<EngineEnv> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    engine_env_at(Path::new(&home))
}

fn engine_env_at(home: &Path) -> Option<EngineEnv> {
    let record = std::fs::read_to_string(engine_record_path(home)).ok()?;
    parse_engine_record(&record)
}

fn engine_record_path(home: &Path) -> PathBuf {
    home.join(".intentic").join("engine").join("engine.json")
}

fn parse_engine_record(text: &str) -> Option<EngineEnv> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("engine")?.as_str()? != "intentic" {
        return None;
    }
    // Installed beside Docker Desktop and not switched on (ic's engine/record.rs `active`): the sandboxes still run on
    // Docker Desktop, and so does every `docker` this app spawns. A record from before the switch is an active one.
    if value.get("active").and_then(serde_json::Value::as_bool) == Some(false) {
        return None;
    }
    Some(EngineEnv {
        docker_host: value.get("host")?.as_str()?.to_string(),
        cert_path: value.get("certPath")?.as_str()?.to_string(),
        bin_dir: PathBuf::from(value.get("bin")?.as_str()?),
    })
}

fn path_with_bin_first(bin_dir: &Path) -> Option<String> {
    let existing = std::env::var_os("PATH")?;
    let mut parts: Vec<PathBuf> = std::env::split_paths(&existing).collect();
    parts.insert(0, bin_dir.to_path_buf());
    std::env::join_paths(parts)
        .ok()
        .map(|joined| joined.to_string_lossy().into_owned())
}

/// [`app_env`](crate::commands::app_env) carries the same TLS and PATH as [`docker`].
pub(crate) fn engine_env_pairs() -> Vec<(String, String)> {
    engine_env().map(|env| env.as_pairs()).unwrap_or_default()
}

/// How the engine this app talks to reads a bind mount's source (`-v <source>:…`), decided once per job rather than
/// per file. Docker Desktop rewrites a Windows path itself, and an engine on Linux or macOS reads the path as it is;
/// our engine's `dockerd` runs inside its WSL distro, sees the PC's drives under `/mnt/`, and refuses `C:\…` as an
/// invalid volume specification (`intentic_docker_host::wsl_path`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Binds {
    AsIs,
    Wsl,
}

impl Binds {
    pub(crate) fn of_engine() -> Binds {
        if engine_env().is_some() {
            Binds::Wsl
        } else {
            Binds::AsIs
        }
    }

    /// `path` as this engine reads a bind source; None when it cannot see the place (a network share).
    pub(crate) fn source(self, path: &Path) -> Option<String> {
        let text = path.to_string_lossy();
        match self {
            Binds::AsIs => Some(text.into_owned()),
            Binds::Wsl => intentic_docker_host::wsl_path::wsl_mount_path(&text),
        }
    }
}

/// Docker Desktop's own CLI, when this process's PATH cannot find one. A PATH is copied into a process when it
/// starts, so the minutes after this app's own setup installs Docker Desktop are exactly the minutes its PATH
/// predates the install: every `docker` this app spawned then failed to start, and the card read "Docker wouldn't
/// start" over an engine that was up. ic adopts the same folder for its own process (`docker::adopt_program_folder`),
/// from the same default installs: this runs before every `docker` spawn, so it is file checks and nothing slower.
#[cfg(windows)]
fn docker_cli_fallback() -> Option<String> {
    use intentic_docker_host::desktop_app;
    if docker_cli_path().is_some() {
        return None;
    }
    desktop_app::default_installs_here()
        .iter()
        .filter_map(|app| desktop_app::cli_beside(app))
        .find(|cli| Path::new(cli).exists())
}

/// `docker`, as this app spawns it: our engine's CLI and TLS when `engine.json` says `intentic`, else the one on PATH,
/// or [`docker_cli_fallback`] with its folder on the child's PATH, since the helpers the CLI calls (credentials,
/// plugins) live beside it.
fn docker() -> Command {
    if let Some(engine) = engine_env() {
        let name = if cfg!(windows) {
            "docker.exe"
        } else {
            "docker"
        };
        let cli = engine.bin_dir.join(name);
        let mut command = quiet(Command::new(if cli.is_file() {
            cli
        } else {
            PathBuf::from("docker")
        }));
        engine.apply_to(&mut command);
        return command;
    }
    #[cfg(windows)]
    if let Some(cli) = docker_cli_fallback() {
        let mut command = quiet(Command::new(&cli));
        if let Some((dir, _)) = cli.rsplit_once('\\') {
            let existing = std::env::var("PATH").unwrap_or_default();
            command.env("PATH", format!("{existing};{dir}"));
        }
        return command;
    }
    quiet(Command::new("docker"))
}

/// [`docker`] for the modules that run a docker command of their own: a dropped folder copied into a sandbox
/// (drop_copy.rs) goes through the same CLI and engine as everything else this app asks of Docker.
pub(crate) fn docker_command() -> Command {
    docker()
}

/// The docker CLI on this PATH, which names its own installation (`desktop_app::app_beside_cli`).
#[cfg(windows)]
fn docker_cli_path() -> Option<String> {
    std::env::var("PATH").ok().and_then(|path| {
        path.split(';')
            .map(|dir| Path::new(dir).join("docker.exe"))
            .find(|candidate| candidate.exists())
            .map(|candidate| candidate.to_string_lossy().to_string())
    })
}

#[cfg(target_os = "macos")]
pub fn start_docker_desktop(foreground: bool) -> Result<(), StartTrouble> {
    let mut command = Command::new("open");
    // `-g` leaves the app in the background, which is what a launch that is only after the engine wants; the
    // button that says "Open Docker Desktop" means the window, so it omits it.
    if !foreground {
        command.arg("-g");
    }
    match command.args(["-a", "Docker"]).status() {
        Ok(status) if status.success() => Ok(()),
        // `open -a` fails exactly one interesting way: there is no such application.
        Ok(_) => Err(StartTrouble::NotInstalled(
            "Docker Desktop is not installed in this machine's Applications.".to_string(),
        )),
        Err(error) => Err(StartTrouble::Failed(format!(
            "Docker Desktop would not start: {error}"
        ))),
    }
}

/// Linux has no Docker Desktop to start on most machines: the engine is a system service, and starting one
/// needs root this app does not have and must not ask for on a launch. Desktop's own unit is a USER service,
/// so where it exists this works, and where it does not the message names the one command that does.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn start_docker_desktop(foreground: bool) -> Result<(), StartTrouble> {
    let _ = foreground;
    match Command::new("systemctl")
        .args(["--user", "start", "docker-desktop"])
        .status()
    {
        Ok(status) if status.success() => Ok(()),
        // Not "not installed": a machine running the plain engine has Docker and no user service to start, and
        // the honest thing to hand back is the one command that does start it.
        _ => Err(StartTrouble::Failed(
            "starting Docker on this machine needs a terminal: sudo systemctl start docker"
                .to_string(),
        )),
    }
}

/// How a refusal that is not the daemon's at all begins: there was no `docker` to ask. Matched rather than
/// typed, so the one caller that must not wait on it ([`wait_for_engine`]) and the ones that only report it
/// read the same value.
const CLI_MISSING: &str = "the docker command would not run";

/// The daemon's own answer: None when it answered, its last words when it did not. Only ever asked of a
/// socket that is already listening — against a stopped daemon this same call spends tens of seconds.
pub fn daemon_refusal() -> Option<String> {
    let mut command = docker();
    command.args(["info", "--format", "{{.ServerVersion}}"]);
    match capture("docker info", command, DOCKER_PROBE_LIMIT) {
        Ok(answer) if answer.success => None,
        Ok(answer) => Some(answer.stderr.trim().to_string()),
        Err(Unanswered::NotStarted { reason, .. }) => Some(format!("{CLI_MISSING}: {reason}")),
        Err(silence) => Some(format!("Docker's engine is up but {silence}")),
    }
}

/// Whether this machine has a docker CLI at all: what tells "Docker isn't installed" from "Docker isn't running" for an
/// engine that does not answer (machine_sandbox.rs). Only a CLI that would not start says no; one that ran and
/// complained is an installed Docker.
pub fn docker_cli_present() -> bool {
    let mut command = docker();
    command.arg("--version");
    !matches!(
        capture("docker --version", command, Duration::from_secs(5)),
        Err(Unanswered::NotStarted { .. })
    )
}

/// Which of the three refusals docker's words describe: the classifier `ic` reads them with
/// (`intentic_docker_host::refusal`), so the two never disagree on whether an engine is broken, refusing this account,
/// or not there yet.
fn refusal_kind(refusal: &str) -> Refusal {
    intentic_docker_host::refusal::classify(refusal)
}

/// Whether a refusal is the engine turning THIS ACCOUNT away rather than not being there at all. Windows spells a
/// permission failure on a named pipe exactly one way and Linux spells its socket's exactly one other; waiting longer
/// fixes neither.
pub fn engine_denied(refusal: &str) -> bool {
    refusal_kind(refusal) == Refusal::Denied
}

/// How long an engine may go on answering with errors before the wait stops calling it a start still under way. A
/// Docker Desktop whose VM went away answers 500 for as long as anybody asks; one that is booting can answer one or two
/// in passing, which is why `ic` also watches an erroring engine a while before calling it wedged.
const ERRORING_GRACE: Duration = Duration::from_secs(20);

/// How far bringing the engine up got. A closed set, because "Docker did not start" with no reason is a dead
/// end wearing an error message — each of these is a different sentence and a different button.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineOutcome {
    /// The engine answers. Nothing to say and nothing to press.
    Ready,
    /// There is no Docker Desktop on this machine to start.
    NotInstalled(String),
    /// There is, and it would not run.
    WouldNotStart(String),
    /// The engine is up and will not talk to this account: a group membership, never a longer wait.
    NotAllowed(String),
    /// Started, and its engine never came up — a welcome screen, a sign-in, or a first start still going.
    TookTooLong(String),
    /// The engine is there and answers every request with an error: the 500 a Docker Desktop answers forever once its
    /// VM went away. Waiting changes nothing; quitting Docker Desktop and starting it again does.
    Broken(String),
}

/// Wait for the engine. The socket is polled rather than `docker info`, so a stopped daemon costs nothing per
/// round; `docker info` is only asked once something is listening, and each ask is bounded by its own limit.
fn wait_for_engine(limit: Duration) -> EngineOutcome {
    let started = Instant::now();
    let mut last = String::new();
    let mut erroring = Erroring::default();
    while started.elapsed() < limit {
        if engine_listening() {
            let refusal = daemon_refusal();
            match refusal {
                None => return EngineOutcome::Ready,
                Some(refusal) if engine_denied(&refusal) => {
                    return EngineOutcome::NotAllowed(refusal)
                }
                // Nothing to wait FOR: the engine may well be up, but the client that would talk to it is not
                // on this machine, and five minutes of polling changes neither half of that.
                Some(refusal) if refusal.starts_with(CLI_MISSING) => {
                    return EngineOutcome::WouldNotStart(refusal)
                }
                Some(refusal) => {
                    if erroring.broken(&refusal, Instant::now()) {
                        return EngineOutcome::Broken(refusal);
                    }
                    last = refusal;
                }
            }
        } else {
            erroring = Erroring::default();
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    EngineOutcome::TookTooLong(last)
}

/// How long the engine has been answering with errors, without a break: the clock [`ERRORING_GRACE`] is read against.
#[derive(Default)]
struct Erroring {
    since: Option<Instant>,
}

impl Erroring {
    /// Take one refusal. True once errors have run on unbroken for the grace: a broken engine rather than a slow one.
    fn broken(&mut self, refusal: &str, now: Instant) -> bool {
        if refusal_kind(refusal) != Refusal::Erroring {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert(now);
        now.duration_since(since) >= ERRORING_GRACE
    }
}

/// Start the engine if it is not up, then wait for it. BLOCKING, for minutes by design — call it from
/// `spawn_blocking`. Safe to run twice at once: Docker Desktop is single-instance, so the second start is a
/// no-op and both waits reach the same answer.
pub fn bring_engine_up(limit: Duration) -> EngineOutcome {
    // Our engine is started by ic, which knows its distro and its keeper; Docker Desktop is never what this PC needs.
    if engine_env().is_some() {
        if engine_listening() && daemon_refusal().is_none() {
            return EngineOutcome::Ready;
        }
        if let Err(problem) = start_our_engine(false, limit) {
            return EngineOutcome::WouldNotStart(problem);
        }
        return wait_for_engine(limit);
    }
    if engine_listening() {
        match daemon_refusal() {
            None => return EngineOutcome::Ready,
            Some(refusal) if engine_denied(&refusal) => return EngineOutcome::NotAllowed(refusal),
            // Listening and not answering yet: Docker Desktop is already on its way up, so there is nothing
            // to start and everything to wait for.
            Some(_) => {}
        }
    } else {
        match start_docker_desktop(false) {
            Ok(()) => {}
            Err(StartTrouble::NotInstalled(problem)) => {
                return EngineOutcome::NotInstalled(problem)
            }
            Err(StartTrouble::Failed(problem)) => return EngineOutcome::WouldNotStart(problem),
        }
    }
    wait_for_engine(limit)
}

fn command_for(app: &AppHandle, run: &ScriptRun) -> Result<Command, String> {
    let path = resource(app, run.file)?;
    let path = path.to_string_lossy().to_string();

    if run.host == Host::Windows {
        // -File (not -Command) so the script's own parameters bind normally; the policy bypass is scoped to
        // this process, exactly like the `irm | iex` one-liner the browser hands out. Reading the file rather
        // than a string is also why every .ps1 here has to be ASCII — see the test at the bottom.
        let mut command = quiet(Command::new("powershell.exe"));
        command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &path]);
        command.args(&run.args);
        command.envs(run.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        return Ok(command);
    }

    if run.elevate {
        // pkexec discards the environment, so the vars have to be re-applied INSIDE the elevated process —
        // hence `pkexec env NAME=value … sh <script>` rather than Command::envs, which would set them on
        // pkexec itself and lose every one of them.
        let mut command = Command::new("pkexec");
        command.arg("env");
        command.args(
            run.env
                .iter()
                .map(|(name, value)| format!("{name}={value}")),
        );
        command.args(["sh", &path]);
        command.args(&run.args);
        return Ok(own_group(command));
    }

    let mut command = Command::new("sh");
    command.arg(&path);
    command.args(&run.args);
    command.envs(run.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    Ok(own_group(command))
}

/// Give the child a process group of its own, so [`stop`] can reach everything it started with one signal
/// rather than killing the shell and orphaning the download it was waiting on.
fn own_group(mut command: Command) -> Command {
    intentic_bounded::own_group(&mut command);
    command
}

/// Run the bundled `ic` with `args`, streaming every line like [`run_heard`]. `what` names the run in logs and events.
/// BLOCKING — same contract as [`run_heard`]: a designed stop (exit 3 or 4) is returned in [`Ended`], not `Err`.
pub fn run_ic_heard(
    app: &AppHandle,
    id: &str,
    what: &str,
    args: &[&str],
    env: &[(String, String)],
    heard: Option<Heard>,
) -> Result<Ended, String> {
    let ic = crate::commands::bundled_ic().ok_or_else(|| {
        "Intentic's own ic is not beside this app, so this step cannot run.".to_string()
    })?;
    let mut command = Command::new(&ic);
    if let Some(dir) = ic.parent() {
        command.current_dir(dir);
    }
    command.args(args);
    command.envs(
        crate::commands::app_env(crate::commands::VERSION)
            .into_iter()
            .chain(env.iter().cloned()),
    );
    intentic_bounded::no_window(&mut command);
    let spool = Spool::open(id).map_err(|error| {
        format!("could not start {what}: nowhere to write what it says ({error})")
    })?;
    let child = spool
        .attach(&mut command)
        .and_then(|()| command.spawn())
        .map_err(|error| {
            spool.remove();
            format!("could not start {what}: {error}")
        })?;
    follow(app, id, what, child, spool, None, heard)
}

/* WHERE A RUN'S CHILD WRITES — a file of its own, never a pipe this process holds (2026-10-05).
 *
 * A pipe dies with the app. A Quit mid-run left the shim and the `ic` under it writing into a pipe nobody read any more,
 * and `ic` prints with `println!`, which panics on a broken pipe: a recreate or a remove stopped half way through, with
 * nothing on screen to say so. A file outlives the app. The child writes its two streams to two files beside the run's
 * transcript (`desktop-<run>-<stamp>.out` and `.err`, [`Spool`]), and this process reads them back as they grow
 * ([`tail`]) for the window and the transcript, exactly as it read the pipes. A run followed to its end leaves only its
 * transcript, which holds every line by then; a run the app quit in the middle keeps writing, and its two files are the
 * record of the rest (its transcript says where, [`note_quit`]). The two streams now interleave in the transcript as
 * finely as one read of each file ([`TAIL_EVERY`]) rather than one write to each pipe: a line or two out of order at
 * worst. */

/// How often a run's files are read for what its child wrote since.
const TAIL_EVERY: Duration = Duration::from_millis(50);

/// The two files a run's child writes to, and the transcript beside them.
struct Spool {
    /// The transcript this process writes, both streams in one, as before; none where the logs folder cannot be made.
    log: Option<PathBuf>,
    out: PathBuf,
    err: PathBuf,
    out_file: std::fs::File,
    err_file: std::fs::File,
}

impl Spool {
    /// The run's transcript path and its child's two files, made empty: beside the transcript when there is one, else in
    /// the system's temporary folder under a name no other run has.
    fn open(id: &str) -> std::io::Result<Spool> {
        let log = log_path(id);
        let base = match &log {
            Some(log) => log.with_extension(""),
            None => std::env::temp_dir().join(format!(
                "intentic-desktop-{}-{}",
                safe_name(id),
                uuid::Uuid::new_v4().simple()
            )),
        };
        let (out, err) = (base.with_extension("out"), base.with_extension("err"));
        Ok(Spool {
            out_file: std::fs::File::create(&out)?,
            err_file: std::fs::File::create(&err)?,
            log,
            out,
            err,
        })
    }

    /// Point `command`'s two streams at the files, and close its stdin (see [`run`] for why nothing is ever asked on
    /// it). Fresh handles each time, so a caller that tries several binaries hands each its own.
    fn attach(&self, command: &mut Command) -> std::io::Result<()> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(self.out_file.try_clone()?))
            .stderr(Stdio::from(self.err_file.try_clone()?));
        Ok(())
    }

    /// The child's files, once every line in them is in the transcript.
    fn remove(&self) {
        let _ = std::fs::remove_file(&self.out);
        let _ = std::fs::remove_file(&self.err);
    }
}

/// The whole lines in `pending`, taken out of it, each without its line ending; whatever follows the last newline stays
/// for the next read. Bytes that are not UTF-8 are replaced, never a reason to stop reading. Pure.
pub fn take_lines(pending: &mut Vec<u8>) -> Vec<String> {
    let Some(last) = pending.iter().rposition(|byte| *byte == b'\n') else {
        return Vec::new();
    };
    let rest = pending.split_off(last + 1);
    let whole = std::mem::replace(pending, rest);
    whole[..whole.len() - 1]
        .split(|byte| *byte == b'\n')
        .map(|line| String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(line)).into_owned())
        .collect()
}

/// Every line written to the file at `path`, handed to `line` as it arrives, until `exited` is set and the file has been
/// read to its end; a last line with no newline is handed over then. Whether the child has exited is asked BEFORE each
/// read, so what it wrote just before it exited is always read: a read that finds nothing after the exit is the end.
pub(crate) fn tail(path: &Path, exited: &AtomicBool, mut line: impl FnMut(&str)) {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let done = exited.load(Ordering::Acquire);
        match file.read(&mut chunk) {
            Ok(0) | Err(_) if done => break,
            Ok(0) | Err(_) => std::thread::sleep(TAIL_EVERY),
            Ok(read) => {
                pending.extend_from_slice(&chunk[..read]);
                for text in take_lines(&mut pending) {
                    line(&text);
                }
            }
        }
    }
    if !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending);
        line(text.strip_suffix('\r').unwrap_or(&text));
    }
}

/// A run being followed right now: its transcript and its child's two files.
type Followed = (Arc<Mutex<std::fs::File>>, PathBuf, PathBuf);

/// The runs being followed, by id, so a quit can say in each transcript where the rest of it went ([`note_quit`]).
fn followed() -> &'static Mutex<HashMap<String, Followed>> {
    static FOLLOWED: OnceLock<Mutex<HashMap<String, Followed>>> = OnceLock::new();
    FOLLOWED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The app is ending with runs still going (the person chose "Quit now", windows.rs `hold_quit`): each carries on writing
/// to its own files, and its transcript says so, and where, since nothing will copy the rest into it. `except` are the
/// runs the quit stops instead (machine_sandbox.rs `before_exit`).
pub fn note_quit(except: &[&str]) {
    let Ok(live) = followed().lock() else {
        return;
    };
    for (id, (transcript, out, err)) in live.iter() {
        if except.contains(&id.as_str()) {
            continue;
        }
        if let Ok(mut file) = transcript.lock() {
            let _ = writeln!(
                file,
                "\n[Intentic quit while this was running. It carries on; the rest of what it says goes to {} and {}]",
                out.display(),
                err.display()
            );
        }
    }
}

/// Run a script to completion, streaming every line to the window as it arrives. BLOCKING — call it from
/// `spawn_blocking`; the scripts pull multi-gigabyte images and a setup legitimately takes minutes.
///
/// stdin is closed. These scripts prompt when they have a terminal (`ic`'s "Proceed?" before a removal, connect's
/// "install Docker?"), and a prompt nobody can answer is a run that hangs forever with no UI for it — so every caller
/// passes the non-interactive flags instead (`-y`, `INSTALL_DOCKER=1`).
pub fn run(app: &AppHandle, id: &str, script: ScriptRun) -> Result<(), String> {
    let file = script.file;
    let ended = run_heard(app, id, script, None, None)?;
    if ended.success {
        return Ok(());
    }
    Err(match ended.code {
        Some(code) => format!("{file} exited with status {code}"),
        None => format!("{file} was terminated"),
    })
}

/// What hears every line of a run as it arrives, beside the window and the transcript: the stream it came on, and
/// the line.
pub type Heard = Arc<dyn Fn(Stream, &str) + Send + Sync>;

/// A run's child, the moment it started: its pid and the two files it writes to (machine_sandbox.rs keeps them in its
/// run lock, so a launch after a crash finds the run still going and follows it there).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawned {
    pub pid: u32,
    pub out: PathBuf,
    pub err: PathBuf,
}

/// What is told of a run's start: see [`Spawned`].
pub type OnSpawn = Box<dyn FnOnce(&Spawned) + Send>;

/// [`run`], with every line also handed to `heard` (machine_sandbox.rs reads its setup's progress in Rust, since no
/// window need be there to read it), `spawned` told the child's pid and files once it starts, and how it ended answered
/// whatever the exit: a designed stop (exit 3 or 4) is an answer for the caller to read, not an error. `Err` only when
/// the script never started. BLOCKING.
pub fn run_heard(
    app: &AppHandle,
    id: &str,
    script: ScriptRun,
    heard: Option<Heard>,
    spawned: Option<OnSpawn>,
) -> Result<Ended, String> {
    let mut command = command_for(app, &script)?;
    let spool = Spool::open(id).map_err(|error| {
        format!(
            "could not start {}: nowhere to write what it says ({error})",
            script.file
        )
    })?;
    let child = spool
        .attach(&mut command)
        .and_then(|()| command.spawn())
        .map_err(|error| {
            spool.remove();
            format!("could not start {}: {error}", script.file)
        })?;
    if let Some(spawned) = spawned {
        spawned(&Spawned {
            pid: child.id(),
            out: spool.out.clone(),
            err: spool.err.clone(),
        });
    }
    follow(app, id, script.file, child, spool, None, heard)
}

/// How a followed run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub code: Option<i32>,
    pub success: bool,
    /// It ran past its limit and was stopped, with everything it started.
    pub timed_out: bool,
    /// Where its transcript was written, when it could be.
    pub log: Option<String>,
}

/// Follow a spawned run under `id` to its exit: every line its child writes to its files, to the window and to the
/// transcript as it arrives, then the exit. `what` names it in the transcript and in errors. With a `limit`, a run still
/// going when it runs out is stopped with everything it started, as [`stop`] would, and says so in [`Ended::timed_out`].
fn follow(
    app: &AppHandle,
    id: &str,
    what: &str,
    mut child: Child,
    spool: Spool,
    limit: Option<Duration>,
    heard: Option<Heard>,
) -> Result<Ended, String> {
    remember(id, child.id());

    // Opened before the first line and shared by both readers, so the transcript interleaves the two streams in the
    // order they were read — which is the order that makes a failure readable.
    let transcript = spool.log.as_ref().and_then(|path| {
        std::fs::File::create(path)
            .ok()
            .map(|file| Arc::new(Mutex::new(file)))
    });
    if let (Some(transcript), Ok(mut live)) = (&transcript, followed().lock()) {
        live.insert(
            id.to_string(),
            (Arc::clone(transcript), spool.out.clone(), spool.err.clone()),
        );
    }
    let _ = app.emit(
        RUN_EVENT,
        RunEvent::Started {
            run: id.to_string(),
            log: spool
                .log
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
        },
    );

    let exited = Arc::new(AtomicBool::new(false));
    let reader = |path: PathBuf, stream: Stream| {
        let app = app.clone();
        let id = id.to_string();
        let exited = Arc::clone(&exited);
        let transcript = transcript.clone();
        let heard = heard.clone();
        std::thread::spawn(move || {
            tail(&path, &exited, |line| {
                // To disk first: the window is the copy that can be closed, and the whole point of the file is that it
                // outlives whoever was watching.
                if let Some(file) = &transcript {
                    if let Ok(mut file) = file.lock() {
                        let _ = writeln!(
                            file,
                            "{}{line}",
                            match stream {
                                Stream::Stdout => "",
                                Stream::Stderr => "! ",
                            }
                        );
                    }
                }
                if let Some(heard) = &heard {
                    heard(stream, line);
                }
                let _ = app.emit(
                    RUN_EVENT,
                    RunEvent::Line {
                        run: id.clone(),
                        stream,
                        text: line.to_string(),
                    },
                );
            });
        })
    };
    let readers = [
        reader(spool.out.clone(), Stream::Stdout),
        reader(spool.err.clone(), Stream::Stderr),
    ];

    // The limit is watched beside the wait rather than by polling it: the exit drops `exited_now`, which wakes the
    // watch with nothing to do; running out first kills the tree, which is what ends the wait.
    let (exited_now, watch) = channel::<()>();
    let timed_out = Arc::new(AtomicBool::new(false));
    if let Some(limit) = limit {
        let pid = child.id();
        let timed_out = Arc::clone(&timed_out);
        std::thread::spawn(move || {
            if watch.recv_timeout(limit) == Err(RecvTimeoutError::Timeout) {
                timed_out.store(true, Ordering::Relaxed);
                let _ = intentic_bounded::kill_tree(pid, intentic_bounded::Signal::Kill);
            }
        });
    }
    let status = child.wait();
    drop(exited_now);
    // The child is gone: the readers take what is left in its files and stop. A file never blocks, so there is no grace
    // to wait out as there was for a pipe, which a background process the child left could hold open past its exit.
    exited.store(true, Ordering::Release);
    for reader in readers {
        let _ = reader.join();
    }
    forget(id);
    if let Ok(mut live) = followed().lock() {
        live.remove(id);
    }
    let status = status.map_err(|error| format!("{what} did not finish: {error}"))?;
    let timed_out = timed_out.load(Ordering::Relaxed);
    if let Some(file) = &transcript {
        if let Ok(mut file) = file.lock() {
            let _ = match limit.filter(|_| timed_out) {
                Some(limit) => writeln!(
                    file,
                    "\n[{what} was stopped after {}s, its limit]",
                    limit.as_secs()
                ),
                None => writeln!(file, "\n[{what} exited with {:?}]", status.code()),
            };
        }
    }
    // Every line is in the transcript now. Without one (no logs folder), the child's files are all there is, and stay.
    if transcript.is_some() {
        spool.remove();
    }
    prune_logs();

    let _ = app.emit(
        RUN_EVENT,
        RunEvent::Exit {
            run: id.to_string(),
            code: status.code(),
            ok: status.success(),
        },
    );
    Ok(Ended {
        code: status.code(),
        success: status.success() && !timed_out,
        timed_out,
        log: spool.log.map(|path| path.to_string_lossy().to_string()),
    })
}

/// A short docker read whose output we want rather than stream — container listings and log tails. Not a
/// script: these are the two places the app talks to docker directly, because there is no script that lists
/// or tails, and inventing one to avoid a `docker ps` would be the tail wagging the dog.
pub fn docker_output(args: &[&str], limit: Duration) -> Result<String, String> {
    let mut command = docker();
    command.args(args);
    let what = format!("docker {}", args.first().copied().unwrap_or_default());
    let answer = capture(&what, command, limit).map_err(|silence| silence.to_string())?;
    if !answer.success {
        return Err(answer.stderr.trim().to_string());
    }
    Ok(answer.stdout)
}

/* `ic` ON THIS MACHINE — what the sandbox list, and everything about what runs, is read from. */

/// Where `ic` lives, in the order the installers put it: the per-user copy the shims fetch (the one this app's own
/// setup and recreate runs just put down, at this app's version), a root install, then PATH. A VALUE rather than a
/// `cfg!` read, for [`Host`]'s reason. The machine agent looks in the same places (`icCandidates`).
pub fn ic_candidates(host: Host, home: Option<&str>) -> Vec<String> {
    let mut candidates = Vec::new();
    match host {
        Host::Windows => {
            if let Some(home) = home {
                candidates.push(format!("{home}\\.intentic\\ic\\bin\\ic.exe"));
            }
            candidates.push("ic.exe".to_string());
        }
        Host::Unix => {
            if let Some(home) = home {
                candidates.push(format!("{home}/.intentic/ic/bin/ic"));
            }
            candidates.push("/usr/local/bin/ic".to_string());
            candidates.push("ic".to_string());
        }
    }
    candidates
}

/// `ic sandbox list --json`'s one line of JSON, out of whatever else rode on stdout with it (the shim's own
/// narration, when it fetched ic first). None when there is no such line: an ic too old to have `--json`.
pub fn listing_from(stdout: &str) -> Option<Vec<serde_json::Value>> {
    stdout
        .lines()
        .map(str::trim)
        .rfind(|line| line.starts_with('['))
        .and_then(|line| serde_json::from_str(line).ok())
}

/// Seconds a listing gets: ic bounds each docker read inside it at 20s.
const IC_LIST_LIMIT: Duration = Duration::from_secs(60);

/// Seconds the shim's listing gets: a download of ic first, on a slow connection.
const IC_FETCH_LIMIT: Duration = Duration::from_secs(300);

/// clap's exit code for an argument it does not know: what an `ic` from before `list --json` answers.
const USAGE_ERROR: i32 = 2;

/// Every sandbox on this machine, as the installed `ic` lists them. When there is none, or it is too old to know
/// `--json`, the listing runs through `fallback` (the recreate shim's `--list`), whose fetch of this app's own `ic`
/// is what brings the installed one level for every listing after it. Any other failure is ic's own sentence.
pub fn ic_listing(app: &AppHandle, fallback: ScriptRun) -> Result<Vec<serde_json::Value>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    for candidate in ic_candidates(Host::current(), home.as_deref()) {
        let mut command = quiet(Command::new(&candidate));
        command.args(["sandbox", "list", "--json"]);
        match intentic_bounded::capture(command, IC_LIST_LIMIT, intentic_bounded::Reach::Tree) {
            // Not at this path: the next one.
            Err(_) => continue,
            Ok(ran) if ran.timed_out => {
                return Err(format!(
                    "ic did not list this machine's sandboxes within {}s",
                    IC_LIST_LIMIT.as_secs()
                ))
            }
            Ok(ran) => match listing_from(&ran.stdout) {
                Some(rows) if ran.success() => return Ok(rows),
                _ if ran.code == Some(USAGE_ERROR) => break,
                _ => return Err(ran.stderr.trim().to_string()),
            },
        }
    }
    let command = command_for(app, &fallback)?;
    let ran = capture("ic sandbox list", command, IC_FETCH_LIMIT)
        .map_err(|silence| silence.to_string())?;
    match listing_from(&ran.stdout) {
        Some(rows) if ran.success => Ok(rows),
        _ => Err(format!(
            "ic could not list this machine's sandboxes: {}",
            ran.stderr.trim()
        )),
    }
}

/// Run the installed `ic` with `args`, streamed and transcribed under `id` as a script run is, and stopped with
/// everything it started once it has run for `limit`. BLOCKING. `ic` is looked for where [`ic_listing`] looks, in the
/// same order; there is no shim to fall back on here, so a machine without one is told so. `Err` only when no `ic`
/// would start: how one that ran ended is the [`Ended`], a non-zero exit included.
pub fn run_ic(
    app: &AppHandle,
    id: &str,
    args: &[String],
    env: &[(String, String)],
    limit: Duration,
) -> Result<Ended, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    // Its words go to files, as every run's do (see `Spool`): `ic` prints with `println!`, the one writer here that a
    // dead pipe would end mid-flow.
    let spool = Spool::open(id)
        .map_err(|error| format!("ic would not start: nowhere to write what it says ({error})"))?;
    for candidate in ic_candidates(Host::current(), home.as_deref()) {
        let mut command = own_group(quiet(Command::new(&candidate)));
        command.args(args);
        command.envs(
            env.iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        );
        match spool.attach(&mut command).and_then(|()| command.spawn()) {
            // Not at this path: the next one.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                spool.remove();
                return Err(format!("ic would not start: {error}"));
            }
            Ok(child) => return follow(app, id, "ic", child, spool, Some(limit), None),
        }
    }
    spool.remove();
    Err(IC_MISSING.to_string())
}

/// What [`run_ic`] says on a machine with no `ic` anywhere it is installed.
pub const IC_MISSING: &str =
    "ic isn't installed on this device. Set the sandbox up here again to install it.";

/// Where `intentic-machine` lives on this machine, in the order worth trying. The agent's own installer puts it
/// under the home it manages, and that copy is the one this app's setup just installed — so it is preferred over
/// whatever a PATH lookup might find (a stale global, a different user's build). A bare name last means a
/// user who installed it their own way still works.
///
/// A VALUE rather than a `cfg!` read, for the same reason [`Host`] is: the Windows spelling of this path is
/// cross-built on Linux and first executed on somebody's PC, so one `cargo test` covers both halves.
pub fn sync_agent_candidates(host: Host, home: Option<&str>) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(home) = home {
        let (sep, exe) = match host {
            Host::Windows => ('\\', "intentic-machine.exe"),
            Host::Unix => ('/', "intentic-machine"),
        };
        candidates.push(format!(
            "{home}{sep}.intentic{sep}machine{sep}bin{sep}{exe}"
        ));
    }
    candidates.push(match host {
        Host::Windows => "intentic-machine.exe".to_string(),
        Host::Unix => "intentic-machine".to_string(),
    });
    candidates
}

/// Seconds `intentic-machine status` gets: it asks Mutagen about every session, which starts Mutagen's daemon first.
const AGENT_STATUS_LIMIT: Duration = Duration::from_secs(30);

/// Seconds `intentic-machine run --stop` gets: the agent waits 5s for the loop to exit before it kills it.
const AGENT_STOP_LIMIT: Duration = Duration::from_secs(30);

/// Seconds `intentic-machine run` gets: a logon task gets 20s to raise the loop, then the launch stub 10s more.
const AGENT_START_LIMIT: Duration = Duration::from_secs(90);

/// Ask one `intentic-machine` candidate, or None when there is no such binary at that path. Only a missing binary
/// is None: one that is there and would not start is its own answer, which the caller says as it is, rather than
/// trying the next place and ending on "not installed" about an agent that is installed.
fn ask_agent(
    candidate: &str,
    args: &[&str],
    limit: Duration,
) -> Option<Result<Captured, Unanswered>> {
    let mut command = quiet(Command::new(candidate));
    command.args(args);
    match capture(
        &format!("intentic-machine {}", args.join(" ")),
        command,
        limit,
    ) {
        Err(Unanswered::NotStarted {
            kind: std::io::ErrorKind::NotFound,
            ..
        }) => None,
        answer => Some(answer),
    }
}

/// This machine's agent status — `intentic-machine status --json`, the SAME producer the terminal command
/// prints: the sandbox links the device half holds, the sync half's whole machine report, and whether the one
/// resident loop behind both is alive.
///
/// Running the agent rather than reading its state files is the whole point: the files hold links and pairings,
/// but the status also asks Mutagen what each session is doing and checks whether the loop is alive, and a
/// second implementation of that in Rust is precisely the lockstep this app exists to avoid (see the header).
///
/// `Ok(None)` is "no machine agent on this device" — an ordinary state for a machine set up before either
/// capability, and not an error. Only a machine that HAS the agent and could not be asked is one.
pub fn sync_report() -> Result<Option<String>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let mut last: Option<String> = None;
    for candidate in sync_agent_candidates(Host::current(), home.as_deref()) {
        match ask_agent(&candidate, &["status", "--json"], AGENT_STATUS_LIMIT) {
            None => continue,
            Some(Ok(answer)) if answer.success => return Ok(Some(answer.stdout)),
            Some(Ok(answer)) => last = Some(answer.stderr.trim().to_string()),
            Some(Err(silence)) => last = Some(silence.to_string()),
        }
    }
    match last {
        None => Ok(None),
        Some(error) => Err(format!(
            "the sync agent on this device could not be read: {error}"
        )),
    }
}

/// How long an unpair may take: it tells the sandbox to forget this machine first, which a sandbox that is gone answers
/// at once (the edge's 502) and an unreachable one only after its own timeout.
const AGENT_UNPAIR_LIMIT: Duration = Duration::from_secs(60);

/// Stop syncing one sandbox's folder on this machine, `intentic-machine sync uninstall --sandbox <id>`, every other
/// pairing left as it is: what a folder whose sandbox was removed needs before a new one may sync it (project.rs), since
/// the agent keeps one sync per folder. Answers what the agent said.
pub fn agent_unpair(sandbox_id: &str) -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    for candidate in sync_agent_candidates(Host::current(), home.as_deref()) {
        match ask_agent(
            &candidate,
            &["sync", "uninstall", "--sandbox", sandbox_id],
            AGENT_UNPAIR_LIMIT,
        ) {
            None => continue,
            Some(Ok(answer)) if answer.success => return Ok(answer.stdout.trim().to_string()),
            Some(Ok(answer)) => {
                return Err(format!("{}{}", answer.stdout, answer.stderr)
                    .trim()
                    .to_string())
            }
            Some(Err(silence)) => return Err(silence.to_string()),
        }
    }
    Err("no intentic-machine on this device".to_string())
}

/// Whether an agent's answer is it not knowing the verb it was given: the words stricli, the agent's command parser,
/// answers an unknown route with. Pure.
pub fn unknown_verb(said: &str) -> bool {
    said.contains("No command registered for")
}

/// How long `intentic-machine sync forget` may take: it lets go of one sandbox's pairings on this machine.
const AGENT_FORGET_LIMIT: Duration = Duration::from_secs(60);

/// This machine's sync lets go of a sandbox that is gone (2026-10-05): `intentic-machine sync forget <slug>`, which
/// retires whatever the agent keeps for it. An agent older than that verb answers it as unknown, and is asked the way
/// it always was, `sync uninstall --sandbox <id>` ([`agent_unpair`]), when the sandbox's platform id is known. An agent
/// that is not installed has nothing to let go of. Answers what the agent said.
pub fn agent_forget(slug: Option<&str>, sandbox_id: Option<&str>) -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    if let Some(slug) = slug {
        for candidate in sync_agent_candidates(Host::current(), home.as_deref()) {
            match ask_agent(&candidate, &["sync", "forget", slug], AGENT_FORGET_LIMIT) {
                None => continue,
                Some(Ok(answer)) if answer.success => return Ok(answer.stdout.trim().to_string()),
                Some(Ok(answer)) => {
                    let said = format!("{}{}", answer.stdout, answer.stderr);
                    if !unknown_verb(&said) {
                        return Err(said.trim().to_string());
                    }
                    break;
                }
                Some(Err(silence)) => return Err(silence.to_string()),
            }
        }
    }
    match sandbox_id {
        Some(id) => agent_unpair(id),
        None => Err("this machine's agent has no way to let go of that sandbox".to_string()),
    }
}

/// Restart this machine's agent loop — `intentic-machine run --stop`, then `intentic-machine run` — the two
/// commands this window used to tell people to type into a terminal on the very computer it is running on. Both
/// return promptly: `run` puts the loop in the BACKGROUND unless asked for the foreground.
///
/// `--stop` failing is not a failure of the restart: it is what a loop that was already dead answers, and the
/// state this exists to fix is exactly that one. Only the start's own exit decides, and its output is returned
/// verbatim so the window shows the agent's words rather than this function's.
pub fn agent_restart() -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let mut last: Option<String> = None;
    for candidate in sync_agent_candidates(Host::current(), home.as_deref()) {
        if ask_agent(&candidate, &["run", "--stop"], AGENT_STOP_LIMIT).is_none() {
            continue; // not at this path — try the next one
        }
        let started = match ask_agent(&candidate, &["run"], AGENT_START_LIMIT) {
            None => return Err("the agent on this device could not be started".to_string()),
            Some(Err(silence)) => {
                return Err(format!(
                    "the agent on this device did not restart: {silence}"
                ))
            }
            Some(Ok(started)) => started,
        };
        let merged = format!("{}{}", started.stdout, started.stderr);
        if started.success {
            return Ok(merged.trim().to_string());
        }
        last = Some(merged.trim().to_string());
    }
    match last {
        None => Err("no intentic-machine on this device to restart".to_string()),
        Some(error) => Err(format!(
            "the agent on this device would not restart: {error}"
        )),
    }
}

/// Why the machine agent gave no answer to pass on. The screen that asked says each in its own words (project.rs).
#[derive(Debug, PartialEq, Eq)]
pub enum AgentSilence {
    /// No `intentic-machine` at any of the places it is installed.
    Missing,
    /// It is there and would not start: the OS's reason (a command line too long, no permission to run it).
    WouldNotStart(String),
    /// It did not answer within its limit, and was stopped.
    TimedOut(Duration),
    /// It answered, with no JSON object to read on stdout; what it said instead, for stderr.
    Unreadable(String),
}

/// One `intentic-machine` call whose answer is a JSON object on stdout (`sync changes --json` and its siblings),
/// passed on whole: `{ok:true, …}` or `{ok:false, error}` is the agent's to say, and an exit status that is not zero
/// with an object printed is still that object. Resolved as [`sync_report`] resolves the agent, bounded by `limit`.
pub fn agent_json(args: &[String], limit: Duration) -> Result<serde_json::Value, AgentSilence> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    for candidate in sync_agent_candidates(Host::current(), home.as_deref()) {
        match ask_agent(&candidate, &args, limit) {
            None => continue,
            Some(Err(Unanswered::TimedOut { limit, .. })) => {
                return Err(AgentSilence::TimedOut(limit))
            }
            Some(Err(Unanswered::NotStarted { reason, .. })) => {
                return Err(AgentSilence::WouldNotStart(reason))
            }
            Some(Ok(answer)) => {
                return json_object_in(&answer.stdout).ok_or_else(|| {
                    AgentSilence::Unreadable(format!(
                        "no JSON on stdout: {}{}",
                        answer.stdout.trim(),
                        answer.stderr.trim()
                    ))
                })
            }
        }
    }
    Err(AgentSilence::Missing)
}

/// The JSON object an agent printed: its whole stdout, or failing that the last line of it that is one, for an
/// agent that said something else first (a notice, a fetch).
pub fn json_object_in(stdout: &str) -> Option<serde_json::Value> {
    let object = |text: &str| {
        serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .filter(serde_json::Value::is_object)
    };
    object(stdout.trim()).or_else(|| {
        stdout
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with('{'))
            .rev()
            .find_map(object)
    })
}

/// The container's last `tail` log lines, BOTH streams merged in the order docker hands them over. The daemon
/// writes its pino output to stdout and its crashes to stderr, and the line that explains a sandbox that will
/// not come up is nearly always in the second one — so unlike [`docker_output`], a non-zero exit here still
/// returns what was captured rather than throwing it away.
pub fn logs_tail(container: &str, tail: u32) -> Result<String, String> {
    let mut command = docker();
    command.args(["logs", "--tail", &tail.to_string(), container]);
    let answer = capture("docker logs", command, DOCKER_READ_LIMIT)
        .map_err(|silence| silence.to_string())?;
    let merged = format!("{}{}", answer.stdout, answer.stderr);
    if !answer.success && merged.trim().is_empty() {
        return Err(format!("no logs for {container}"));
    }
    Ok(merged)
}

/// Suppress the console window Windows gives every spawned process in a GUI app.
fn quiet(mut command: Command) -> Command {
    intentic_bounded::no_window(&mut command);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumable_downloads_can_be_paused_but_setup_still_holds_an_update() {
        for id in crate::onboarding::PREFETCH_RUNS {
            remember(id, std::process::id());
        }
        assert!(busy(), "the downloads are still running");
        assert!(!busy_except(&crate::onboarding::PREFETCH_RUNS));
        remember("pc-setup", std::process::id());
        assert!(busy_except(&crate::onboarding::PREFETCH_RUNS));
        for id in crate::onboarding::PREFETCH_RUNS {
            forget(id);
        }
        assert!(busy_except(&crate::onboarding::PREFETCH_RUNS));
        forget("pc-setup");
        assert!(!busy());
    }

    #[test]
    fn each_host_picks_its_own_sibling() {
        assert_eq!(Host::Unix.script("connect.sh", "connect.ps1"), "connect.sh");
        assert_eq!(
            Host::Windows.script("connect.sh", "connect.ps1"),
            "connect.ps1"
        );
    }

    /* A BOUNDED CHILD answers by its exit or by its limit, never by whoever else holds its pipes. */

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_exits_is_answered_with_both_streams() {
        let answer = capture(
            "sh",
            shell("echo out; echo err >&2; exit 3"),
            Duration::from_secs(10),
        )
        .expect("the child exits");
        assert!(!answer.success);
        assert_eq!(answer.stdout, "out\n");
        assert_eq!(answer.stderr, "err\n");
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_never_exits_is_killed_at_its_limit() {
        let limit = Duration::from_millis(300);
        let started = Instant::now();
        let answer = capture("sh", shell("sleep 30"), limit);
        assert_eq!(
            answer.expect_err("the child outlives its limit"),
            Unanswered::TimedOut {
                what: "sh".to_string(),
                limit
            }
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "waited {:?} for a child whose limit was {limit:?}",
            started.elapsed()
        );
    }

    /// The Windows shape of `intentic-machine run`: the child exits at once, and the loop it left behind holds its
    /// stdout for as long as the loop lives.
    #[cfg(unix)]
    #[test]
    fn a_background_holder_of_the_pipes_costs_only_the_grace() {
        let started = Instant::now();
        let answer = capture(
            "sh",
            shell("echo started; sleep 20 & exit 0"),
            Duration::from_secs(10),
        )
        .expect("the child itself exits at once");
        assert!(answer.success);
        assert_eq!(answer.stdout, "started\n");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "waited {:?} on a pipe the child's own background process holds",
            started.elapsed()
        );
    }

    #[test]
    fn a_binary_that_is_not_there_never_started() {
        let answer = capture(
            "nothing",
            Command::new("intentic-no-such-binary-here"),
            Duration::from_secs(1),
        );
        assert!(matches!(
            answer,
            Err(Unanswered::NotStarted { ref what, kind: std::io::ErrorKind::NotFound, .. }) if what == "nothing"
        ));
    }

    /// Only an agent that is not at a place is looked for at the next one. One that is there and will not start is
    /// that answer, not "not installed": a folder where the binary should be stands in for any start the OS refuses
    /// (a command line longer than Windows allows, a binary without the right to run).
    #[cfg(unix)]
    #[test]
    fn an_agent_that_is_there_and_will_not_start_is_not_taken_for_a_missing_one() {
        let missing = std::env::temp_dir().join(format!(
            "intentic-no-agent-{}/intentic-machine",
            std::process::id()
        ));
        assert!(ask_agent(
            missing.to_str().unwrap(),
            &["status"],
            Duration::from_secs(5)
        )
        .is_none());

        let refused = std::env::temp_dir();
        match ask_agent(
            refused.to_str().unwrap(),
            &["status"],
            Duration::from_secs(5),
        ) {
            Some(Err(Unanswered::NotStarted { kind, .. })) => {
                assert_ne!(kind, std::io::ErrorKind::NotFound)
            }
            other => panic!("a start the OS refused came back as {other:?}"),
        }
    }

    /* A RUN'S WORDS, read back from the files its child writes. */

    #[test]
    fn whole_lines_are_taken_and_a_partial_one_waits_for_the_next_read() {
        let mut pending = b"one\r\ntwo\nthr".to_vec();
        assert_eq!(take_lines(&mut pending), vec!["one", "two"]);
        assert_eq!(pending, b"thr".to_vec());
        pending.extend_from_slice(b"ee\n\n");
        assert_eq!(take_lines(&mut pending), vec!["three", ""]);
        assert!(pending.is_empty());
        assert!(take_lines(&mut pending).is_empty());
        // Not UTF-8 is replaced, never a reason to stop reading.
        let mut odd = b"caf\xe9\n".to_vec();
        assert_eq!(take_lines(&mut odd), vec!["caf\u{fffd}"]);
    }

    #[test]
    fn a_followed_file_is_read_to_its_end_once_its_writer_has_exited() {
        let path = std::env::temp_dir().join(format!("intentic-tail-{}", std::process::id()));
        std::fs::write(&path, "first\nsecond\nlast without newline").unwrap();
        let exited = AtomicBool::new(true);
        let mut lines = Vec::new();
        tail(&path, &exited, |line| lines.push(line.to_string()));
        let _ = std::fs::remove_file(&path);
        assert_eq!(lines, vec!["first", "second", "last without newline"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_child_writing_to_its_files_is_followed_while_it_runs() {
        let dir = std::env::temp_dir().join(format!("intentic-spool-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("run.out");
        let file = std::fs::File::create(&out).unwrap();
        let mut child = shell("echo early; sleep 0.3; echo late")
            .stdout(Stdio::from(file))
            .spawn()
            .unwrap();
        let exited = Arc::new(AtomicBool::new(false));
        let reading = {
            let (out, exited) = (out.clone(), Arc::clone(&exited));
            std::thread::spawn(move || {
                let mut lines = Vec::new();
                tail(&out, &exited, |line| lines.push(line.to_string()));
                lines
            })
        };
        child.wait().unwrap();
        exited.store(true, Ordering::Release);
        assert_eq!(reading.join().unwrap(), vec!["early", "late"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* HOW MANY RUNS' FILES STAY. */

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn only_the_newest_runs_stay_each_with_all_its_files() {
        let files: Vec<(String, SystemTime)> = vec![
            ("desktop-setup-20261001-100000.log".into(), at(100)),
            ("desktop-setup-20261001-100000.out".into(), at(101)),
            ("desktop-recreate-work-20261002-100000.log".into(), at(200)),
            ("desktop-power-work-20261003-100000.log".into(), at(300)),
            ("desktop-power-work-20261003-100000.err".into(), at(300)),
            // A run still being written to is the newest, whatever its name says.
            ("desktop-fix-20261001-090000.log".into(), at(400)),
            // Not this app's: `ic`'s own logs, and anything else in the folder.
            ("ic-20261001-100000.log".into(), at(1)),
            ("notes.txt".into(), at(2)),
            ("desktop-setup.json".into(), at(3)),
        ];
        assert_eq!(
            prune_selection(&files, 2),
            vec![
                "desktop-recreate-work-20261002-100000.log".to_string(),
                "desktop-setup-20261001-100000.log".to_string(),
                "desktop-setup-20261001-100000.out".to_string(),
            ]
        );
        assert!(prune_selection(&files, KEPT_RUNS).is_empty());
        let names: Vec<String> = [
            "prefetch-20261008-101500.log",
            "prefetch-20261009-090000.log",
            "prefetch-20261007-120000.log",
            "desktop-setup-20261001-000000.log",
            "prefetch-notes.txt",
        ]
        .map(str::to_string)
        .to_vec();
        assert_eq!(
            prefetch_logs_to_prune(&names, 2),
            vec!["prefetch-20261007-120000.log".to_string()],
            "the oldest prefetch log goes, and nothing that is not one"
        );
        assert!(prefetch_logs_to_prune(&names, KEPT_RUNS).is_empty());
        assert_eq!(prune_selection(&files, 0).len(), 6);
    }

    /// An agent that predates a verb says so in its parser's words, which is what turns `sync forget` into the older
    /// `sync uninstall --sandbox`; any other refusal is the agent's answer.
    #[test]
    fn an_agent_that_does_not_know_a_verb_is_told_from_one_that_refused_it() {
        assert!(unknown_verb(
            "No command registered for `forget`, did you mean `uninstall`?"
        ));
        assert!(!unknown_verb("no pairing for work on this machine"));
        assert!(!unknown_verb(""));
    }

    #[test]
    fn a_silent_child_is_named_with_its_limit() {
        let silence = Unanswered::TimedOut {
            what: "docker ps".to_string(),
            limit: Duration::from_secs(20),
        };
        assert_eq!(silence.to_string(), "docker ps did not answer within 20s");
    }

    /* `ic` is looked for where the installers put it, and its listing is found among whatever else rode on stdout. */
    #[test]
    fn ic_is_looked_for_where_the_installers_put_it_before_path() {
        assert_eq!(
            ic_candidates(Host::Unix, Some("/home/ada")),
            vec!["/home/ada/.intentic/ic/bin/ic", "/usr/local/bin/ic", "ic"]
        );
        assert_eq!(
            ic_candidates(Host::Windows, Some("C:\\Users\\Ada")),
            vec!["C:\\Users\\Ada\\.intentic\\ic\\bin\\ic.exe", "ic.exe"]
        );
        assert_eq!(
            ic_candidates(Host::Unix, None),
            vec!["/usr/local/bin/ic", "ic"]
        );
    }

    #[test]
    fn the_listing_is_the_last_json_line_and_an_old_ics_text_is_none() {
        let rows =
            listing_from("intentic: fetching the ic CLI...\r\n[{\"slug\":\"work\"}]\r\n").unwrap();
        assert_eq!(rows, vec![serde_json::json!({ "slug": "work" })]);
        assert_eq!(listing_from("[]"), Some(vec![]));
        assert_eq!(listing_from("running   work\n"), None);
        assert_eq!(listing_from(""), None);
    }

    /// The agent's answer is one JSON object: all of stdout, or the last line of it that is one when something was
    /// said first. An array, a number or prose is not an answer.
    #[test]
    fn an_agent_answer_is_the_json_object_it_printed() {
        assert_eq!(
            json_object_in("{\"ok\":true,\"changes\":[]}\n"),
            Some(serde_json::json!({ "ok": true, "changes": [] }))
        );
        assert_eq!(
            json_object_in("{\n  \"ok\": false,\n  \"error\": \"no session\"\n}\n"),
            Some(serde_json::json!({ "ok": false, "error": "no session" }))
        );
        assert_eq!(
            json_object_in("mutagen: starting daemon\r\n{\"ok\":true}\r\n"),
            Some(serde_json::json!({ "ok": true }))
        );
        assert_eq!(json_object_in("[1,2]"), None);
        assert_eq!(json_object_in("done\n"), None);
        assert_eq!(json_object_in(""), None);
    }

    #[test]
    fn current_host_matches_the_build_target() {
        assert_eq!(
            Host::current(),
            if cfg!(windows) {
                Host::Windows
            } else {
                Host::Unix
            }
        );
    }

    /* THE ENGINE PROBE, asserted on every runner because the Windows half of it is cross-built and first runs on a PC. */

    #[test]
    fn each_host_looks_where_its_own_engine_listens() {
        assert_eq!(
            engine_endpoints(Host::Windows, None, Some("C:\\Users\\radar")),
            vec![ENGINE_PIPE.to_string()]
        );
        assert_eq!(
            engine_endpoints(Host::Unix, None, Some("/Users/radar")),
            vec![
                // Docker Desktop for Mac's own socket comes first: a default install leaves the shared one
                // to whoever asked for it, so the user's own is the one that is always there.
                "/Users/radar/.docker/run/docker.sock".to_string(),
                "/var/run/docker.sock".to_string(),
            ]
        );
        assert_eq!(
            engine_endpoints(Host::Unix, None, None),
            vec!["/var/run/docker.sock".to_string()],
            "a machine that will not say where home is still has the shared socket"
        );
    }

    #[test]
    fn a_docker_host_that_names_a_socket_is_the_only_one_looked_at() {
        assert_eq!(
            engine_endpoints(Host::Unix, Some("unix:///tmp/other.sock"), Some("/home/x")),
            vec!["/tmp/other.sock".to_string()]
        );
        assert_eq!(
            engine_endpoints(Host::Windows, Some("npipe:////./pipe/other_engine"), None),
            vec!["\\\\.\\pipe\\other_engine".to_string()],
            "the URL spelling of a pipe has to come back as the pipe"
        );
        // Somebody else's daemon: there is no local socket to probe and nothing this app starts would help.
        assert!(
            engine_endpoints(Host::Unix, Some("tcp://10.0.0.2:2375"), Some("/home/x")).is_empty()
        );
        assert!(engine_endpoints(Host::Windows, Some("ssh://box"), None).is_empty());
    }

    /* The one refusal that a longer wait cannot fix, in both spellings a real machine produces. */
    #[test]
    fn an_engine_that_refuses_this_account_is_told_from_one_that_is_not_there() {
        assert!(engine_denied(
            "error during connect: ... open //./pipe/docker_engine: Access is denied."
        ));
        assert!(engine_denied(
            "dial unix /var/run/docker.sock: connect: permission denied"
        ));
        assert!(
            !engine_denied("error during connect: ... The system cannot find the file specified."),
            "a daemon that is not there is a wait, not a group membership"
        );
    }

    /* A DOCKER DESKTOP ANSWERING 500: a broken engine, which the wait used to sit out for its whole five minutes. */
    const ANSWERED_500: &str = "request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/info, check if the server supports the requested API version";

    #[test]
    fn an_engine_erroring_past_the_grace_is_broken_rather_than_slow() {
        let start = Instant::now();
        let mut erroring = Erroring::default();
        assert!(
            !erroring.broken(ANSWERED_500, start),
            "one 500 is a boot in passing"
        );
        assert!(!erroring.broken(
            ANSWERED_500,
            start + ERRORING_GRACE - Duration::from_secs(1)
        ));
        assert!(
            erroring.broken(ANSWERED_500, start + ERRORING_GRACE),
            "errors without a break for the whole grace are an engine no wait will fix"
        );
    }

    #[test]
    fn any_other_answer_restarts_the_grace() {
        let start = Instant::now();
        let mut erroring = Erroring::default();
        assert!(!erroring.broken(ANSWERED_500, start));
        // Not there for a moment: Docker Desktop restarting its VM, which is a start under way again.
        assert!(!erroring.broken(
            "error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
            start + Duration::from_secs(10)
        ));
        assert!(!erroring.broken(ANSWERED_500, start + ERRORING_GRACE));
        assert!(erroring.broken(ANSWERED_500, start + ERRORING_GRACE * 2));
    }

    #[test]
    fn the_desktop_reads_refusals_with_ics_classifier() {
        assert_eq!(refusal_kind(ANSWERED_500), Refusal::Erroring);
        assert_eq!(
            refusal_kind("Error response from daemon: Docker Desktop is unable to start"),
            Refusal::Erroring
        );
        // A refusal this app phrased itself, around a silence or a missing CLI, is never read as broken.
        assert_eq!(
            refusal_kind(&format!("{CLI_MISSING}: program not found")),
            Refusal::Down
        );
        assert_eq!(
            refusal_kind("Docker's engine is up but it did not answer within 10 seconds"),
            Refusal::Down
        );
    }

    /* THE ONE THING A .ps1 IN THIS REPO MAY NOT CONTAIN — a byte above 0x7F. */
    #[test]
    fn every_bundled_powershell_script_is_ascii() {
        for (path, text) in powershell_scripts() {
            let offenders: Vec<char> = {
                let mut found: Vec<char> = text.chars().filter(|c| !c.is_ascii()).collect();
                found.sort_unstable();
                found.dedup();
                found
            };
            assert!(
                offenders.is_empty(),
                "{} must be ASCII — Windows PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code page, where \
                 {offenders:?} decode to smart quotes it treats as string delimiters and the script stops \
                 parsing. Write `-`, `->`, `=>`, `...` instead.",
                path.display(),
            );
        }
    }

    /* THE SECOND 5.1 LANDMINE IN THE SAME FILES, and the one that outlived the first fix. */
    #[test]
    fn no_powershell_script_silences_a_probe_while_stop_is_in_force() {
        const REDIRECTIONS: [&str; 4] = ["*>", "2>&1", "2>$null", "2> $null"];
        for (path, text) in powershell_scripts() {
            if !text.contains("$ErrorActionPreference = 'Stop'") {
                continue;
            }
            let silenced: Vec<&str> = REDIRECTIONS
                .iter()
                .copied()
                .filter(|redirection| text.contains(redirection))
                .collect();
            assert!(
                silenced.is_empty(),
                "{} sets $ErrorActionPreference = 'Stop' AND redirects a native command's output \
                 ({silenced:?}). On Windows PowerShell 5.1 that pair is fatal: the redirection turns docker's \
                 stderr into a terminating NativeCommandError, so a probe kills the run on the very outcome it \
                 exists to detect. Use 'Continue' — these scripts branch on $LASTEXITCODE themselves, and \
                 every error they raise is a `Write-Error` followed by `exit 1`.",
                path.display(),
            );
        }
    }

    /* SPLATTING TAKES A VARIABLE, AND `@(...)` IS NOT ONE. */
    #[test]
    fn no_powershell_script_fakes_a_splat_with_an_array_subexpression() {
        // The native commands these scripts hand argv to. A cmdlet taking `@(...)` as one array argument is
        // ordinary and correct, which is why this is a list rather than a bare search for `@(`.
        // The native commands these scripts hand argv to, plus the call operator on an expression
        // (`& $parts[0] @(…)`, how the local-dev AGENT_BIN paths invoke a downloaded agent). A CMDLET taking
        // `@(...)` as one array argument is ordinary and correct, which is why this is a list of invocation
        // shapes rather than a bare search for `@(`.
        const NATIVE: [&str; 4] = ["docker", "winget", "bash", "cloudflared"];
        for (path, text) in powershell_scripts() {
            for (index, line) in text.lines().enumerate() {
                // Code only. These scripts explain their own footguns by quoting them, and a comment that
                // names the mistake it is warning about must not BE the mistake.
                let line = line.split('#').next().unwrap_or(line);
                let by_name = NATIVE
                    .iter()
                    .find(|command| line.contains(&format!("{command} @(")));
                let called = line.contains("& $") && line.contains(" @(");
                assert!(
                    by_name.is_none() && !called,
                    "{}:{} passes `@(...)` where a splat was meant — that is the array SUBEXPRESSION \
                     operator, so PowerShell hands the callee the whole array as ONE space-joined argument \
                     (docker answers `unknown command: docker run -d …`). Name the array first, then splat \
                     the name: `$RunArgs = @(…); docker @RunArgs` — and not `$Args`, which is automatic.",
                    path.display(),
                    index + 1,
                );
            }
        }
    }

    /* `connect.ps1`, `connect-host.ps1`, `recreate.ps1` and `fix.ps1` are each handed to `irm | iex` as a standalone string: there is no import. */
    #[test]
    fn every_copy_of_the_ic_download_is_the_same_download() {
        let scripts = powershell_scripts();
        let mut blocks: Vec<(std::path::PathBuf, String)> = Vec::new();
        for (path, text) in &scripts {
            if let Some(block) = ic_fetch_block(text) {
                blocks.push((path.clone(), block));
            }
        }
        assert!(
            blocks.len() >= 4,
            "expected connect/connect-host/recreate/fix to carry this block, found {}",
            blocks.len()
        );
        let (first_path, first) = &blocks[0];
        for (path, block) in &blocks[1..] {
            assert_eq!(
                block,
                first,
                "{} and {} fetch the ic binary differently. These files cannot share code, so the copies \
                 have to be identical apart from their narration line — fix the one that drifted rather \
                 than relaxing this test.",
                path.display(),
                first_path.display(),
            );
        }
    }

    /* Download scripts place binaries under %USERPROFILE%\.intentic and report their command name. */
    #[test]
    fn every_downloading_installer_puts_its_binary_on_path() {
        let mut blocks: Vec<(std::path::PathBuf, String)> = Vec::new();
        for (path, text) in powershell_scripts() {
            // Downloads the ic CLI => owes the user a working command name. cleanup.ps1 downloads nothing,
            // and the two agent installers delegate PATH to the agent's own setup.
            if ic_fetch_block(&text).is_none() {
                continue;
            }
            let block = add_to_path_block(&text).unwrap_or_else(|| {
                panic!(
                    "{} downloads a binary but never defines Add-IntenticPath — the folder it installs into \
                     stays off the user's PATH, so every command this script's own output names is one the \
                     shell cannot find. Copy the function from connect.ps1 verbatim.",
                    path.display(),
                )
            });
            assert!(
                text.contains("Add-IntenticPath -Folder"),
                "{} defines Add-IntenticPath and never calls it.",
                path.display(),
            );
            blocks.push((path, block));
        }
        assert!(
            blocks.len() == 4,
            "expected connect/connect-host/recreate/fix to carry this, found {}",
            blocks.len()
        );
        let (first_path, first) = &blocks[0];
        for (path, block) in &blocks[1..] {
            assert_eq!(
                block,
                first,
                "{} and {} edit the user's PATH differently. Whichever one drifted, fix it rather than \
                 relaxing this test: the value is REG_EXPAND_SZ on a real machine, and a copy that writes it \
                 back as REG_SZ turns every %VAR%-style entry in somebody's PATH into a literal.",
                path.display(),
                first_path.display(),
            );
        }
    }

    /* Windows restarts the resident agent from its HKCU startup registration. */
    #[test]
    fn no_script_fetches_the_windowless_launcher() {
        for (path, text) in powershell_scripts() {
            assert!(
                !text.contains("intentic-launch"),
                "{} fetches or names intentic-launch.exe — the agent keeps its own launcher stub fresh \
                 (setup and upgrade, _devices/machine/src/install.ts). A script copy is the drift this \
                 test exists to prevent.",
                path.display(),
            );
        }
    }

    #[test]
    fn engine_record_is_read_when_valid_and_ignored_when_not() {
        let dir = std::env::temp_dir().join(format!("intentic-engine-env-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".intentic/engine")).unwrap();
        let record = r#"{"engine":"intentic","host":"tcp://127.0.0.1:2376","certPath":"/home/me/.intentic/engine/certs","bin":"/home/me/.intentic/engine/bin","version":"1.2.3"}"#;
        std::fs::write(dir.join(".intentic/engine/engine.json"), record).unwrap();
        let parsed = engine_env_at(&dir).expect("intentic record");
        assert_eq!(parsed.docker_host, "tcp://127.0.0.1:2376");
        assert_eq!(parsed.cert_path, "/home/me/.intentic/engine/certs");
        assert_eq!(
            parsed.bin_dir,
            PathBuf::from("/home/me/.intentic/engine/bin")
        );

        std::fs::write(
            dir.join(".intentic/engine/engine.json"),
            r#"{"engine":"dockerDesktop","host":"npipe:////./pipe/docker_engine"}"#,
        )
        .unwrap();
        assert_eq!(engine_env_at(&dir), None);

        std::fs::write(dir.join(".intentic/engine/engine.json"), "{not json").unwrap();
        assert_eq!(engine_env_at(&dir), None);

        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(engine_env_at(&dir), None);
    }

    /// The `Add-IntenticPath` function, up to the brace that closes it. None for a script that has no such
    /// function. The prose above each copy names that script's own commands, so only the body is compared.
    fn add_to_path_block(text: &str) -> Option<String> {
        let start = text.find("function Add-IntenticPath {")?;
        let rest = &text[start..];
        let end = rest.find("\n}\n").map(|at| at + 3).unwrap_or(rest.len());
        Some(rest[..end].to_string())
    }

    /// The `$Ic = $env:IC_BIN` block, up to the brace that closes it, minus the one line that is allowed to
    /// differ. None for a script that has no such block (cleanup, sync, device).
    fn ic_fetch_block(text: &str) -> Option<String> {
        let start = text.find("$Ic = $env:IC_BIN")?;
        let rest = &text[start..];
        // The block is one `if (-not $Ic) { … }`, and its closing brace is the first one in column 0.
        let end = rest.find("\n}\n").map(|at| at + 3).unwrap_or(rest.len());
        Some(
            rest[..end]
                .lines()
                .filter(|line| !line.contains("fetching the ic CLI"))
                .collect::<Vec<&str>>()
                .join("\n"),
        )
    }

    /// Every shipped `.ps1`, as (path, contents). The checks above are properties of the FILE that no Linux
    /// runner can reach any other way — the Windows installer is cross-built here and these scripts first
    /// execute on a user's machine.
    fn powershell_scripts() -> Vec<(std::path::PathBuf, String)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../_site/site/public/scripts");
        let mut scripts: Vec<(std::path::PathBuf, String)> = std::fs::read_dir(&dir)
            .expect("the bundled scripts directory is readable")
            .map(|entry| entry.expect("readable directory entry").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "ps1"))
            .map(|path| {
                let text = std::fs::read_to_string(&path).expect("script is readable");
                (path, text)
            })
            .collect();
        scripts.sort();
        assert!(
            !scripts.is_empty(),
            "no .ps1 scripts found in {}",
            dir.display()
        );
        scripts
    }
}
