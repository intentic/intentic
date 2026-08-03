use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

/* THE NATIVE LAYER, AND ALL OF IT — this app runs the same scripts the copy-paste one-liners run.
 *
 * The first attempt at this app reimplemented the machine work in Rust: an environment probe engine, a
 * reconcile plan, a docker-run builder, the /setup/claim call, tunnel provisioning, the sandbox lifecycle.
 * That is ~1400 lines whose ONLY job is to stay bit-identical to connect.sh — a lockstep that has never held
 * anywhere in this repo (see @intentic/sandbox-run's header for the last time it broke), and the reason the
 * experiment was shelved.
 *
 * So the app spawns the scripts instead. Parity is then structural: the desktop path and the terminal path are
 * the same file, and a fix to connect.sh reaches desktop users on the app's next release without anyone
 * remembering to port it. What is left here is the three things a script cannot do for itself — find itself,
 * get the elevation it needs, and say what it is doing to a window instead of a terminal.
 *
 * The scripts are BUNDLED as resources rather than downloaded at run time. A release of this app is cut from
 * one commit, so `Intentic 1.2.0` ships `connect.sh@1.2.0` and the updater is what keeps them fresh — one
 * version to reason about instead of "which script did it fetch". The bundle globs the whole scripts directory
 * (tauri.conf.json), so a script added to the site is bundled by construction and there is no list to drift. */

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

/// Which script family a run targets, and therefore which argument convention and which interpreter. Every
/// flow has a `.sh` and a `.ps1` sibling in `_apps/site/public/scripts/`, and this is the only platform branch
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
        return Ok(command);
    }

    let mut command = Command::new("sh");
    command.arg(&path);
    command.args(&run.args);
    command.envs(run.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    Ok(command)
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

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pump = |handle: Option<Box<dyn std::io::Read + Send>>, stream: Stream| {
        let app = app.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            let Some(handle) = handle else {
                return;
            };
            for line in BufReader::new(handle).lines().map_while(Result::ok) {
                let _ = app.emit(
                    RUN_EVENT,
                    RunEvent::Line {
                        run: id.clone(),
                        stream,
                        text: line,
                    },
                );
            }
        })
    };
    let out = pump(
        stdout.map(|handle| Box::new(handle) as Box<dyn std::io::Read + Send>),
        Stream::Stdout,
    );
    let err = pump(
        stderr.map(|handle| Box::new(handle) as Box<dyn std::io::Read + Send>),
        Stream::Stderr,
    );

    let status = child
        .wait()
        .map_err(|error| format!("{} did not finish: {error}", script.file))?;
    // Join AFTER wait: the pumps end when their pipes close, which is when the child exits.
    let _ = out.join();
    let _ = err.join();

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

    /* THE ONE THING A .ps1 IN THIS REPO MAY NOT CONTAIN — a byte above 0x7F.
     *
     * The terminal path hands PowerShell a STRING (`irm <url> | iex`), decoded from the `charset=utf-8` the
     * site worker sends, so UTF-8 prose survives it. This app hands PowerShell a FILE (`-File <path>`), and
     * Windows PowerShell 5.1 — still the default `powershell.exe` on every Windows 10/11 — reads a file with
     * no BOM in the machine's ANSI code page, not UTF-8.
     *
     * That is not a cosmetic difference. Through cp1252 an em dash (E2 80 94) decodes to `â€"`, whose last
     * character is U+201D RIGHT DOUBLE QUOTATION MARK — and PowerShell honours typographic quotes as real
     * string delimiters. So every em dash in a comment opened a string, the rest of the script was swallowed
     * into it, and connect.ps1 died on a screenful of `Missing closing '}' in statement block` before it ran a
     * line. `─`, `→` and `⇒` decode to smart quotes the same way.
     *
     * A BOM would fix the file path and put a U+FEFF in front of the string the terminal path pipes to `iex`.
     * ASCII fixes both, because there is no decoder anywhere that reads an ASCII byte as anything else. */
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

    /* THE SECOND 5.1 LANDMINE IN THE SAME FILES, and the one that outlived the first fix.
     *
     * These scripts ask docker questions and branch on `$LASTEXITCODE` themselves: `docker network inspect X
     * *> $null` is a probe whose "no" arrives as a non-zero exit and a line on stderr, and the redirection is
     * only there to keep that line off the user's screen. PowerShell 7.4+ has a switch for exactly this
     * (`$PSNativeCommandUseErrorActionPreference = $false`) and every script sets it.
     *
     * 5.1 does not have that switch, and its rule is a different one: a native command's stderr becomes a
     * NativeCommandError record the moment the stream is REDIRECTED, which `$ErrorActionPreference = 'Stop'`
     * then promotes to terminating. Paired, they end the run ON the silenced probe — a first Windows install
     * died at `docker network inspect` for a network that did not exist yet, one statement before the line
     * that would have created it, having already pulled the image.
     *
     * So a script may set 'Stop', and a script may silence a probe. Not both. */
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

    /// Every shipped `.ps1`, as (path, contents). Both checks above are properties of the FILE that no Linux
    /// runner can reach any other way — the Windows installer is cross-built here and these scripts first
    /// execute on a user's machine.
    fn powershell_scripts() -> Vec<(std::path::PathBuf, String)> {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../site/public/scripts");
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
