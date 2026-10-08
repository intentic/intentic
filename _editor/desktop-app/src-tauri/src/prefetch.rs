/* THE SANDBOX IMAGE, FETCHED WHILE DOCKER IS STILL ON ITS WAY (2026-10-08).
 *
 * A Windows setup that has to install Docker spends its first many minutes on Docker Desktop, WSL2 and a restart or two,
 * and only then starts on the sandbox image: 1.8 GB that nothing had touched in all that time. `ic image prefetch`
 * downloads the image's layers over HTTPS into a cache under ~/.intentic before Docker even exists, carrying on from
 * wherever an earlier run of it stopped, and `ic sandbox connect` later loads that cache instead of pulling. So a setup
 * that is about to install Docker starts one beside itself: hidden, detached, writing to a log of its own, at most one
 * per run of this app, and never stopped when the setup ends (a restart ends it, and the resumed setup starts it again,
 * which picks up where it was). A second `ic` started while one runs defers to it by a lock of ic's own. Nothing waits
 * on it, and nothing depends on it: a prefetch that fails, or an `ic` too old to have one, leaves `connect` to pull as it
 * always has. Its end is told to the windows (`desktop://prefetch`), and the main one reports it (useDevice.ts). */

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::scripts::Host;

/// What the windows hear when a prefetch ends.
pub const EVENT: &str = "desktop://prefetch";

/// The line `ic image prefetch` reports on, about every two seconds and once at its end.
const MARKER: &str = "intentic-prefetch: ";

/// One prefetch per run of this app: a second setup started while one fetches has nothing to add to it.
static FETCHING: AtomicBool = AtomicBool::new(false);

/// Whether a setup starting now should fetch the image ahead: on Windows, where Docker is installed by the setup itself,
/// once the reader has agreed to that (a run with consent, a resume after a restart, which is one), and while Docker is
/// not there to pull with. Pure.
pub fn wanted(host: Host, consented: bool, engine_listening: bool) -> bool {
    host == Host::Windows && consented && !engine_listening
}

/// The `ic` to run it with: the one installed beside this app (the installer puts `intentic-ic.exe` in the app's own
/// folder), else the one the setup scripts fetch for this account, else none, and then nothing is fetched ahead. `exists`
/// is the file check, a parameter so the choice is testable. Pure.
pub fn ic_binary(
    exe: Option<&Path>,
    home: Option<&str>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let beside = exe
        .and_then(Path::parent)
        .map(|dir| dir.join("intentic-ic.exe"));
    let fetched = home.filter(|home| !home.is_empty()).map(|home| {
        Path::new(home)
            .join(".intentic")
            .join("ic")
            .join("bin")
            .join("ic.exe")
    });
    [beside, fetched]
        .into_iter()
        .flatten()
        .find(|candidate| exists(candidate))
}

/// Where the prefetch's own copy of `ic` lives. A prefetch runs for minutes, and a running exe is a locked file: run from
/// the app's folder it would hold up an update or an uninstall of the app, and run from `~/.intentic/ic/bin` it would
/// hold up the setup script, which may be replacing exactly that file at the same moment. A copy of its own locks
/// nothing anybody else writes. Pure.
pub fn private_copy(home: &str) -> PathBuf {
    Path::new(home)
        .join(".intentic")
        .join("ic")
        .join("prefetch")
        .join("ic.exe")
}

/// `source` copied to [`private_copy`], and that copy: the file run. A copy that cannot be replaced because an earlier
/// prefetch is still running from it is run as it is (it defers to that one by ic's own lock anyway).
fn staged(source: &Path, home: &str) -> Option<PathBuf> {
    let copy = private_copy(home);
    std::fs::create_dir_all(copy.parent()?).ok()?;
    match std::fs::copy(source, &copy) {
        Ok(_) => Some(copy),
        Err(_) if copy.is_file() => Some(copy),
        Err(error) => {
            eprintln!(
                "intentic: could not stage ic for the image prefetch ({error}); the setup pulls the image instead."
            );
            None
        }
    }
}

/// `ic`'s arguments for `image`.
pub fn args(image: &str) -> Vec<String> {
    ["image", "prefetch", "--image", image]
        .map(str::to_string)
        .to_vec()
}

/// The log's name in `~/.intentic/logs`, beside the setup's own transcripts.
pub fn log_name(stamp: &str) -> String {
    format!("prefetch-{stamp}.log")
}

/// What a prefetch said about itself in its log: the state of its last marker, and how many bytes it last said it had.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Heard {
    pub state: Option<String>,
    pub done: u64,
}

/// Its markers read back (`intentic-prefetch: {"state":"fetching","done":…,"total":…}`, `{"state":"ready"}`): the last
/// state, and the last `done` a fetching or ready marker carried, since one that failed or deferred says 0 about what
/// it had. Anything else in the log is `ic`'s own narration. Pure.
pub fn heard(log: &str) -> Heard {
    let mut heard = Heard::default();
    for line in log.lines() {
        let Some(json) = line.trim().strip_prefix(MARKER) else {
            continue;
        };
        let Ok(marker) = serde_json::from_str::<serde_json::Value>(json) else {
            continue;
        };
        let Some(state) = marker["state"].as_str() else {
            continue;
        };
        if matches!(state, "fetching" | "ready") {
            if let Some(done) = marker["done"].as_u64() {
                heard.done = done;
            }
        }
        heard.state = Some(state.to_string());
    }
    heard
}

/// How it ended, as the event names it: `ready` (the image is in the cache, or was in Docker already), `elsewhere` (it
/// deferred to a prefetch already running, which exits 0 too), or `failed`. Pure.
pub fn outcome(success: bool, heard: &Heard) -> &'static str {
    match (success, heard.state.as_deref()) {
        (false, _) => "failed",
        (true, Some("elsewhere")) => "elsewhere",
        // Docker Desktop is installed and nothing was half-fetched: Docker pulls it (or has it) itself.
        (true, Some("skipped")) => "skipped",
        (true, _) => "ready",
    }
}

/// A prefetch's end, as the windows hear it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ended {
    pub outcome: &'static str,
    /// How long it ran, to a tenth of a second.
    pub seconds: f64,
    /// The bytes it last said it had.
    pub bytes: u64,
}

/// Start one for a setup that is starting now, when [`wanted`]. Returns at once; quick enough for a command's own thread,
/// since the engine's socket is all it asks of the machine.
pub fn begin_for_setup(app: &AppHandle, consented: bool) {
    if wanted(
        Host::current(),
        consented,
        crate::scripts::engine_listening(),
    ) {
        start(app);
    }
}

fn start(app: &AppHandle) {
    if FETCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    match spawn() {
        Some((child, log)) => watch(app, child, log),
        // No `ic` to fetch with, or one that would not start: the setup pulls as it always has.
        None => FETCHING.store(false, Ordering::SeqCst),
    }
}

/// The prefetch, started with no window and nothing of this process's attached: its output goes to its own log, never a
/// pipe this app holds, so it outlives the app as it outlives the setup.
fn spawn() -> Option<(Child, Option<PathBuf>)> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    let exe = std::env::current_exe().ok();
    let source = ic_binary(exe.as_deref(), home.as_deref(), Path::exists)?;
    let ic = staged(&source, home.as_deref()?)?;
    let log = crate::scripts::logs_dir().and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir.join(log_name(&crate::scripts::stamp())))
    });
    let file = log.as_ref().and_then(|log| std::fs::File::create(log).ok());
    let (stdout, stderr) = match file
        .as_ref()
        .map(|file| (file.try_clone(), file.try_clone()))
    {
        Some((Ok(out), Ok(err))) => (Stdio::from(out), Stdio::from(err)),
        _ => (Stdio::null(), Stdio::null()),
    };
    let mut command = Command::new(&ic);
    // Its own folder to stand in, never the app's: a working directory is held open, and inherited from a Start-menu
    // launch it would be the install folder an uninstall then cannot remove.
    if let Some(dir) = ic.parent() {
        command.current_dir(dir);
    }
    command
        .args(args(&crate::commands::setup_image()))
        .envs(crate::commands::app_env(crate::commands::VERSION))
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    intentic_bounded::no_window(&mut command);
    match command.spawn() {
        Ok(child) => Some((child, log.filter(|_| file.is_some()))),
        Err(error) => {
            eprintln!(
                "intentic: the sandbox image could not be fetched ahead ({} would not start: {error}); the setup pulls it.",
                ic.display()
            );
            None
        }
    }
}

/// Wait for it on a thread of its own, then tell the windows how it ended.
fn watch(app: &AppHandle, mut child: Child, log: Option<PathBuf>) {
    let app = app.clone();
    let started = Instant::now();
    std::thread::spawn(move || {
        let success = child.wait().is_ok_and(|status| status.success());
        FETCHING.store(false, Ordering::SeqCst);
        let heard = log
            .and_then(|log| std::fs::read_to_string(log).ok())
            .map(|text| heard(&text))
            .unwrap_or_default();
        let ended = Ended {
            outcome: outcome(success, &heard),
            seconds: (started.elapsed().as_millis() / 100) as f64 / 10.0,
            bytes: heard.done,
        };
        let _ = app.emit(EVENT, ended);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_windows_setup_that_will_install_docker_fetches_ahead() {
        assert!(wanted(Host::Windows, true, false));
        // Not agreed to yet: the first pass only reports what it would change, and may change nothing at all.
        assert!(!wanted(Host::Windows, false, false));
        // An engine already listening pulls with Docker, which is what the cache would be standing in for.
        assert!(!wanted(Host::Windows, true, true));
        assert!(!wanted(Host::Unix, true, false));
    }

    #[test]
    fn the_ic_beside_the_app_comes_first_then_the_fetched_one_then_none() {
        let exe = Path::new("/apps/Intentic/intentic.exe");
        let beside = PathBuf::from("/apps/Intentic/intentic-ic.exe");
        let fetched = Path::new("/home/ann")
            .join(".intentic")
            .join("ic")
            .join("bin")
            .join("ic.exe");
        assert_eq!(
            ic_binary(Some(exe), Some("/home/ann"), |_| true),
            Some(beside.clone())
        );
        assert_eq!(
            ic_binary(Some(exe), Some("/home/ann"), |path| path != beside),
            Some(fetched)
        );
        // Neither there: skipped, silently, and the setup pulls.
        assert_eq!(ic_binary(Some(exe), Some("/home/ann"), |_| false), None);
        assert_eq!(ic_binary(None, None, |_| true), None);
        // A plain `ic.exe` beside the app is not the bundled one, which is never named that.
        assert_eq!(
            ic_binary(Some(exe), None, |path| path.ends_with("ic.exe")
                && !path.ends_with("intentic-ic.exe")),
            None
        );
    }

    /// The copy it runs is its own, never a file the app's installer or the setup scripts replace.
    #[test]
    fn the_prefetch_runs_a_copy_nobody_else_writes() {
        let copy = private_copy("/home/ann");
        assert_eq!(
            copy,
            Path::new("/home/ann")
                .join(".intentic")
                .join("ic")
                .join("prefetch")
                .join("ic.exe")
        );
        assert_ne!(
            copy,
            Path::new("/home/ann")
                .join(".intentic")
                .join("ic")
                .join("bin")
                .join("ic.exe")
        );
        let dir =
            std::env::temp_dir().join(format!("intentic-prefetch-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("intentic-ic.exe");
        std::fs::write(&source, b"binary").unwrap();
        let home = dir.to_string_lossy().to_string();
        let ran = staged(&source, &home).expect("staged");
        assert_eq!(ran, private_copy(&home));
        assert_eq!(std::fs::read(&ran).unwrap(), b"binary");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn it_runs_the_image_the_setup_runs_and_logs_beside_the_setups() {
        assert_eq!(
            args("ghcr.io/intentic/sandbox:stable"),
            [
                "image",
                "prefetch",
                "--image",
                "ghcr.io/intentic/sandbox:stable"
            ]
        );
        assert_eq!(log_name("20261008-101500"), "prefetch-20261008-101500.log");
    }

    #[test]
    fn its_log_says_how_far_it_got_and_how_it_ended() {
        let fetched = "\
intentic-prefetch: {\"state\":\"fetching\",\"done\":1048576,\"total\":1900000000}
note: a layer stopped; trying again
intentic-prefetch: {\"state\":\"fetching\",\"done\":905000000,\"total\":1900000000}
intentic-prefetch: {\"state\":\"ready\",\"done\":1900000000,\"total\":1900000000}
";
        let heard_ready = heard(fetched);
        assert_eq!(
            heard_ready,
            Heard {
                state: Some("ready".into()),
                done: 1_900_000_000
            }
        );
        assert_eq!(outcome(true, &heard_ready), "ready");

        // A failure says 0 about what it had: the bytes are the last it said while fetching.
        let failed = heard(
            "intentic-prefetch: {\"state\":\"fetching\",\"done\":700,\"total\":900}\r\nintentic-prefetch: {\"state\":\"failed\",\"done\":0,\"total\":0}\r\nerror: could not fetch it ahead",
        );
        assert_eq!(failed.done, 700);
        assert_eq!(outcome(false, &failed), "failed");

        // Deferred to one already running, which exits 0 without having fetched anything itself.
        let elsewhere =
            heard("intentic-prefetch: {\"state\":\"elsewhere\",\"done\":0,\"total\":0}");
        assert_eq!(outcome(true, &elsewhere), "elsewhere");
        // Docker already installed, nothing to carry on with: nothing was fetched, and it is not "ready".
        let skipped = heard("intentic-prefetch: {\"state\":\"skipped\",\"done\":0,\"total\":0}");
        assert_eq!(outcome(true, &skipped), "skipped");
        // An image already in Docker says ready with nothing fetched; a log with no marker at all is an `ic` that
        // exited 0 without saying, which is ready by its own exit code.
        assert_eq!(heard("intentic-prefetch: {\"state\":\"ready\"}").done, 0);
        assert_eq!(outcome(true, &heard("")), "ready");
        assert_eq!(heard("intentic-prefetch: {\"sta"), Heard::default());
    }
}
