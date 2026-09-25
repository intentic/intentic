use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

/* THE NATIVE LAYER, AND ALL OF IT — this app runs the same scripts the copy-paste one-liners run. */

/// Where a line came from. The app's own screen renders stderr as the failure detail when a run exits
/// non-zero — the scripts write their progress to stdout and their diagnostics to stderr, and conflating them
/// loses the only thing worth showing when something goes wrong.
#[derive(Debug, Clone, Copy, Serialize)]
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

/* Until now a run existed only as events in one webview: the lines a user could see were the lines that window happened to still be holding. */
fn log_path(id: &str) -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|home| !home.is_empty())?;
    let dir = Path::new(&home).join(".intentic").join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    // `recreate:work` is not a filename on Windows, where a colon opens an alternate data stream.
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(dir.join(format!("desktop-{safe}-{}.log", stamp())))
}

/// `YYYYmmdd-HHMMSS`, UTC, for a log filename — the same spelling `ic` uses, so the two sets of logs in the
/// directory sort together. Derived here rather than pulled in as a dependency for one filename.
fn stamp() -> String {
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
    running()
        .lock()
        .map(|live| !live.is_empty())
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
    NotStarted { what: String, reason: String },
    TimedOut { what: String, limit: Duration },
}

impl std::fmt::Display for Unanswered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unanswered::NotStarted { what, reason } => write!(f, "{what} would not run: {reason}"),
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
    let mut command = quiet(Command::new("docker"));
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
    let docker_host = std::env::var("DOCKER_HOST").ok();
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    let endpoints = engine_endpoints(Host::current(), docker_host.as_deref(), home.as_deref());
    // Nothing local to probe is a daemon this app cannot start, so the docker CLI's own answer decides instead.
    endpoints.is_empty() || endpoints.iter().any(|endpoint| listening_at(endpoint))
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

/// Where Docker Desktop's own launcher lives on Windows, in the order worth trying: the default install, the
/// per-user one newer builds make, and its Programs sibling.
///
/// Only CALLED on Windows, and asserted everywhere: this spelling is cross-built on a Linux runner and first
/// executes on somebody's PC, which is [`Host`]'s whole argument.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn docker_app_candidates(
    program_files: Option<&str>,
    local_app_data: Option<&str>,
) -> Vec<String> {
    let mut found = Vec::new();
    for base in [program_files, local_app_data] {
        if let Some(base) = base.filter(|base| !base.is_empty()) {
            found.push(format!("{base}\\Docker\\Docker\\Docker Desktop.exe"));
        }
    }
    if let Some(base) = local_app_data.filter(|base| !base.is_empty()) {
        found.push(format!(
            "{base}\\Programs\\Docker\\Docker\\Docker Desktop.exe"
        ));
    }
    found
}

/// Docker Desktop's launcher beside the CLI that shipped inside it — `<app>\resources\bin\docker.exe` — which
/// is how an install in a folder nobody guessed still gets found. Cut by separator rather than by `Path`, so
/// the Windows spelling is asserted on the Linux runner that cross-builds it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn docker_app_beside(cli: &str) -> Option<String> {
    let (app, leaf) = cli.rsplit_once("\\resources\\bin\\")?;
    leaf.eq_ignore_ascii_case("docker.exe")
        .then(|| format!("{app}\\Docker Desktop.exe"))
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
    let program_files = std::env::var("ProgramFiles").ok();
    let local_app_data = std::env::var("LOCALAPPDATA").ok();
    let mut candidates = docker_app_candidates(program_files.as_deref(), local_app_data.as_deref());
    candidates.extend(docker_cli_path().as_deref().and_then(docker_app_beside));
    let exe = candidates
        .into_iter()
        .find(|path| Path::new(path).exists())
        .ok_or_else(|| {
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

/// The docker CLI on this PATH, which names its own installation (see [`docker_app_beside`]).
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
    let mut command = quiet(Command::new("docker"));
    command.args(["info", "--format", "{{.ServerVersion}}"]);
    match capture("docker info", command, DOCKER_PROBE_LIMIT) {
        Ok(answer) if answer.success => None,
        Ok(answer) => Some(answer.stderr.trim().to_string()),
        Err(Unanswered::NotStarted { reason, .. }) => Some(format!("{CLI_MISSING}: {reason}")),
        Err(silence) => Some(format!("Docker's engine is up but {silence}")),
    }
}

/// Whether a refusal is the engine turning THIS ACCOUNT away rather than not being there at all. Windows
/// spells a permission failure on a named pipe exactly one way and Linux spells its socket's exactly one
/// other; waiting longer fixes neither. Mirrors ic's `prepare::plan::engine_denied`, which decides the same
/// thing for the setup flow.
pub fn engine_denied(refusal: &str) -> bool {
    let refusal = refusal.to_ascii_lowercase();
    refusal.contains("access is denied") || refusal.contains("permission denied")
}

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
}

/// Wait for the engine. The socket is polled rather than `docker info`, so a stopped daemon costs nothing per
/// round; `docker info` is only asked once something is listening, and each ask is bounded by its own limit.
fn wait_for_engine(limit: Duration) -> EngineOutcome {
    let started = Instant::now();
    let mut last = String::new();
    while started.elapsed() < limit {
        if engine_listening() {
            match daemon_refusal() {
                None => return EngineOutcome::Ready,
                Some(refusal) if engine_denied(&refusal) => {
                    return EngineOutcome::NotAllowed(refusal)
                }
                // Nothing to wait FOR: the engine may well be up, but the client that would talk to it is not
                // on this machine, and five minutes of polling changes neither half of that.
                Some(refusal) if refusal.starts_with(CLI_MISSING) => {
                    return EngineOutcome::WouldNotStart(refusal)
                }
                Some(refusal) => last = refusal,
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    EngineOutcome::TookTooLong(last)
}

/// Start the engine if it is not up, then wait for it. BLOCKING, for minutes by design — call it from
/// `spawn_blocking`. Safe to run twice at once: Docker Desktop is single-instance, so the second start is a
/// no-op and both waits reach the same answer.
pub fn bring_engine_up(limit: Duration) -> EngineOutcome {
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

/* HOW LONG A FINISHED RUN WAITS ON ITS OWN PIPES — and why it may not wait forever: the crate's grace, shared with `ic`. */
use intentic_bounded::{await_drain, DRAIN_GRACE};

/// Run a script to completion, streaming every line to the window as it arrives. BLOCKING — call it from
/// `spawn_blocking`; the scripts pull multi-gigabyte images and a setup legitimately takes minutes.
///
/// stdin is closed. These scripts prompt when they have a terminal (cleanup's "which sandbox?", connect's
/// "install Docker?"), and a prompt written to a pipe nobody answers is a run that hangs forever with no UI
/// for it — so every caller passes the non-interactive flags instead (`-y`, `INSTALL_DOCKER=1`).
pub fn run(app: &AppHandle, id: &str, script: ScriptRun) -> Result<(), String> {
    let mut command = command_for(app, &script)?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", script.file))?;
    remember(id, child.id());

    // Opened before the first line and shared by both pumps, so the transcript interleaves the two streams
    // in the order they actually arrived — which is the order that makes a failure readable.
    let path = log_path(id);
    let transcript = path.as_ref().and_then(|path| {
        std::fs::File::create(path)
            .ok()
            .map(|file| Arc::new(Mutex::new(file)))
    });
    let _ = app.emit(
        RUN_EVENT,
        RunEvent::Started {
            run: id.to_string(),
            log: path.as_ref().map(|path| path.to_string_lossy().to_string()),
        },
    );

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Live for as long as this run is the one being drawn. A pump left parked on a pipe a background agent
    // still holds checks this before it emits, so its next line goes nowhere instead of into a finished run.
    let reporting = Arc::new(AtomicBool::new(true));
    let (drained, drains) = channel::<()>();
    let pump =
        |handle: Option<Box<dyn std::io::Read + Send>>, stream: Stream, drained: Sender<()>| {
            let app = app.clone();
            let id = id.to_string();
            let reporting = Arc::clone(&reporting);
            let transcript = transcript.clone();
            std::thread::spawn(move || {
                if let Some(handle) = handle {
                    for line in BufReader::new(handle).lines().map_while(Result::ok) {
                        if !reporting.load(Ordering::Relaxed) {
                            return;
                        }
                        // To disk first: the window is the copy that can be closed, and the whole point of
                        // the file is that it outlives whoever was watching.
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
                        let _ = app.emit(
                            RUN_EVENT,
                            RunEvent::Line {
                                run: id.clone(),
                                stream,
                                text: line,
                            },
                        );
                    }
                }
                let _ = drained.send(());
            })
        };
    pump(
        stdout.map(|handle| Box::new(handle) as Box<dyn std::io::Read + Send>),
        Stream::Stdout,
        drained.clone(),
    );
    pump(
        stderr.map(|handle| Box::new(handle) as Box<dyn std::io::Read + Send>),
        Stream::Stderr,
        drained,
    );

    let status = child
        .wait()
        .map_err(|error| format!("{} did not finish: {error}", script.file))?;
    forget(id);
    // The child is gone; give its pipes a moment to hand over the tail of their buffers, then stop listening
    // whether or not they closed. See DRAIN_GRACE — on Windows they may never close at all.
    await_drain(&drains, 2, DRAIN_GRACE);
    reporting.store(false, Ordering::Relaxed);
    if let Some(file) = &transcript {
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "\n[{} exited with {:?}]", script.file, status.code());
        }
    }

    let _ = app.emit(
        RUN_EVENT,
        RunEvent::Exit {
            run: id.to_string(),
            code: status.code(),
            ok: status.success(),
        },
    );
    if status.success() {
        return Ok(());
    }
    Err(match status.code() {
        Some(code) => format!("{} exited with status {code}", script.file),
        None => format!("{} was terminated", script.file),
    })
}

/// A short docker read whose output we want rather than stream — container listings and log tails. Not a
/// script: these are the two places the app talks to docker directly, because there is no script that lists
/// or tails, and inventing one to avoid a `docker ps` would be the tail wagging the dog.
pub fn docker_output(args: &[&str], limit: Duration) -> Result<String, String> {
    let mut command = quiet(Command::new("docker"));
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

/// Ask one `intentic-machine` candidate, or None when there is no such binary at that path.
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
        Err(Unanswered::NotStarted { .. }) => None,
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

/// The container's last `tail` log lines, BOTH streams merged in the order docker hands them over. The daemon
/// writes its pino output to stdout and its crashes to stderr, and the line that explains a sandbox that will
/// not come up is nearly always in the second one — so unlike [`docker_output`], a non-zero exit here still
/// returns what was captured rather than throwing it away.
pub fn logs_tail(container: &str, tail: u32) -> Result<String, String> {
    let mut command = quiet(Command::new("docker"));
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
            Err(Unanswered::NotStarted { ref what, .. }) if what == "nothing"
        ));
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

    /* THE REPORTED SHAPE OF A WINDOWS INSTALL — Program Files, the per-user one, and a folder only the CLI knows about. */
    #[test]
    fn docker_desktop_is_looked_for_everywhere_an_install_puts_it() {
        let found = docker_app_candidates(
            Some("C:\\Program Files"),
            Some("C:\\Users\\radar\\AppData\\Local"),
        );
        assert_eq!(
            found,
            vec![
                "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe".to_string(),
                "C:\\Users\\radar\\AppData\\Local\\Docker\\Docker\\Docker Desktop.exe".to_string(),
                "C:\\Users\\radar\\AppData\\Local\\Programs\\Docker\\Docker\\Docker Desktop.exe"
                    .to_string(),
            ]
        );
        assert!(docker_app_candidates(None, None).is_empty());
    }

    #[test]
    fn the_docker_cli_names_the_installation_it_came_from() {
        assert_eq!(
            docker_app_beside("D:\\Tools\\Docker\\Docker\\resources\\bin\\docker.exe").as_deref(),
            Some("D:\\Tools\\Docker\\Docker\\Docker Desktop.exe")
        );
        // A docker.exe that is not the one inside Docker Desktop names no app at all.
        assert_eq!(docker_app_beside("C:\\bin\\docker.exe"), None);
        assert_eq!(
            docker_app_beside("C:\\Docker\\resources\\bin\\compose.exe"),
            None
        );
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

    /* `connect.ps1`, `connect-host.ps1` and `recreate.ps1` are each handed to `irm | iex` as a standalone string: there is no import. */
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
            blocks.len() >= 3,
            "expected connect/connect-host/recreate to carry this block, found {}",
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
            blocks.len() == 3,
            "expected connect/connect-host/recreate to carry this, found {}",
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
