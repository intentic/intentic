use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
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
    let killed = if cfg!(windows) {
        quiet(Command::new("taskkill.exe"))
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    } else {
        // The child leads its own process group (see `command_for`), so the negative pid reaches everything
        // it started rather than only the shell.
        Command::new("kill")
            .args(["-TERM", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };
    match killed {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("could not stop it (exit {:?})", status.code())),
        Err(error) => Err(format!("could not stop it: {error}")),
    }
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

/// Can this user reach a Docker daemon right now? Decides elevation on Linux, and on Windows it is what tells
/// "Docker Desktop isn't installed" (connect.ps1 offers the winget install) from "it is, but not started".
pub fn docker_ready() -> bool {
    quiet(Command::new("docker"))
        .args(["info", "--format", "{{.ServerVersion}}"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
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
/// rather than killing the shell and orphaning the download it was waiting on. Windows gets the same reach
/// from `taskkill /T` and needs nothing here.
#[cfg(unix)]
fn own_group(mut command: Command) -> Command {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    command
}

#[cfg(not(unix))]
fn own_group(command: Command) -> Command {
    command
}

/* HOW LONG A FINISHED RUN WAITS ON ITS OWN PIPES — and why it may not wait forever. */
const DRAIN_GRACE: Duration = Duration::from_millis(750);

/// Wait for `pumps` pipe readers to report they reached the end of their stream, for at most `grace` in total.
/// True when every one of them did — false when the window ran out with a reader still parked on a handle
/// somebody else is holding open, which is the case [`DRAIN_GRACE`] exists for.
///
/// Split out from [`run`] because it is the whole of the fix and the only part of it that can be exercised
/// without a window: what it must never do is block past the grace, no matter how many readers stay silent.
fn await_drain(drains: &Receiver<()>, pumps: usize, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    for _ in 0..pumps {
        if drains
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_err()
        {
            return false;
        }
    }
    true
}

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
pub fn docker_output(args: &[&str]) -> Result<String, String> {
    let output = quiet(Command::new("docker"))
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("docker is not reachable: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
        let output = quiet(Command::new(&candidate))
            .args(["status", "--json"])
            .stdin(Stdio::null())
            .output();
        let Ok(output) = output else {
            continue; // not at this path — try the next one
        };
        if output.status.success() {
            return Ok(Some(String::from_utf8_lossy(&output.stdout).to_string()));
        }
        last = Some(String::from_utf8_lossy(&output.stderr).trim().to_string());
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
        let stopped = quiet(Command::new(&candidate))
            .args(["run", "--stop"])
            .stdin(Stdio::null())
            .output();
        if stopped.is_err() {
            continue; // not at this path — try the next one
        }
        let started = quiet(Command::new(&candidate))
            .arg("run")
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("the agent on this device could not be started: {error}"))?;
        let merged = format!(
            "{}{}",
            String::from_utf8_lossy(&started.stdout),
            String::from_utf8_lossy(&started.stderr)
        );
        if started.status.success() {
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
    let output = quiet(Command::new("docker"))
        .args(["logs", "--tail", &tail.to_string(), container])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("docker is not reachable: {error}"))?;
    let merged = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() && merged.trim().is_empty() {
        return Err(format!("no logs for {container}"));
    }
    Ok(merged)
}

/// Suppress the console window Windows gives every spawned process in a GUI app.
#[cfg(windows)]
fn quiet(mut command: Command) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn quiet(command: Command) -> Command {
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

    /* A setup run installs resident background agents, and on Windows a detached process inherits the pipes of whoever spawned it. */
    #[test]
    fn a_drain_that_completes_costs_nothing() {
        let (drained, drains) = channel::<()>();
        drained.send(()).expect("first pump reports");
        drained.send(()).expect("second pump reports");

        let started = Instant::now();
        assert!(await_drain(&drains, 2, Duration::from_secs(30)));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "two pumps that already reported must not wait on the grace at all"
        );
    }

    #[test]
    fn a_pump_that_never_finishes_costs_only_the_grace() {
        let grace = Duration::from_millis(200);
        let (drained, drains) = channel::<()>();
        drained.send(()).expect("the one pump that ends reports");
        // The other end stays alive and silent — a background agent holding the write handle open.
        let _held_open = drained;

        let started = Instant::now();
        assert!(!await_drain(&drains, 2, grace));
        let waited = started.elapsed();
        assert!(waited >= grace, "the grace is a real window, not a poll");
        assert!(
            waited < grace * 10,
            "waited {waited:?} — a silent pump must never hold a finished run open"
        );
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
