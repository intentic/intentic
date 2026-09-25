use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::scripts::{self, Host, ScriptRun};
use crate::setup_link::{RecreateArgs, SetupArgs, SyncArgs};
use crate::state::{AppState, CloseAction, SessionEnd, Settings};

type CommandResult<T> = Result<T, String>;

// The prefix @intentic/sandbox-run derives every per-sandbox object from, duplicated here because this process has
// no Node. It is the ONLY thing about the container shape this app knows (to find the sandbox a setup just made, and
// to tail a log): what runs and what should run is `ic`'s to say, and this app asks it.
const CONTAINER_PREFIX: &str = "intentic-sandbox-";

/* This struct describes the app, not the machine running it. */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub version: String,
    pub os: String,
    pub app_url: String,
    pub platform_url: String,
    /// This installation's own id, which the launcher's analytics send their events under — the same value the
    /// workspace window is marked with, so both faces report as one app (state.rs).
    pub install_id: String,
    /// Seconds a Docker start waits for its engine before it answers `tookTooLong`.
    pub engine_limit_seconds: u64,
}

/// What this build calls itself. `INTENTIC_VERSION` is stamped by build.rs from the release build's own
/// environment (build-desktop.sh); a checkout that was not built by it says `0.0.0`, which is the value
/// every "is this a real release" decision below reads.
pub const VERSION: &str = env!("INTENTIC_VERSION");

/* THE `ic` A SCRIPT DOWNLOADS HAS TO BE THIS APP'S OWN `ic`. */
pub fn ic_url(version: &str) -> Option<String> {
    if version.is_empty() || version == "0.0.0" {
        return None;
    }
    Some(format!(
        "https://github.com/intentic/intentic/releases/download/v{version}"
    ))
}

/// What EVERY script this app spawns is told, whichever flow it is.
///
/// `INTENTIC_NO_PROMPT` is the second half of the same lesson as the pin above. These flows ask questions
/// when they believe somebody is there, and they work that out by probing — `/dev/tty` on Unix, `CONOUT$` on
/// Windows. Those probes are good, but this caller does not need to be guessed at: it is a GUI process
/// spawning a child with no window, no console and closed stdin, and a question asked on that run is a run
/// that never ends. The flag says so outright, and every prompt in `ic` then reads as "no answer" — which is
/// what each of them already treats as a refusal.
fn app_env(version: &str) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = vec![("INTENTIC_NO_PROMPT".into(), "1".into())];
    if let Some(url) = ic_url(version) {
        env.push(("IC_URL".into(), url));
    }
    env
}

#[tauri::command]
pub fn desktop_info(state: State<'_, AppState>) -> DesktopInfo {
    DesktopInfo {
        version: VERSION.into(),
        os: std::env::consts::OS.into(),
        app_url: state.app_url(),
        platform_url: state.platform_url(),
        install_id: state.install_id(),
        engine_limit_seconds: scripts::ENGINE_LIMIT.as_secs(),
    }
}

/* DOES A DOCKER DAEMON ANSWER RIGHT NOW — asked on its own, and off the main thread. */
#[tauri::command]
pub async fn docker_ready() -> bool {
    tauri::async_runtime::spawn_blocking(scripts::docker_ready)
        .await
        .unwrap_or(false)
}

/* STARTING THE ENGINE THIS MACHINE'S SANDBOX NEEDS — see scripts.rs for why nothing else does it. */

/// Is a socket listening at all? The cheap question, for a screen that has to decide whether to offer
/// anything before it can afford to wait on `docker info`.
#[tauri::command]
pub async fn docker_listening() -> bool {
    tauri::async_runtime::spawn_blocking(scripts::engine_listening)
        .await
        .unwrap_or(false)
}

/// How far a start got, for the card to switch on: the wire spelling of [`scripts::EngineOutcome`], with the
/// reason carried beside it rather than inside it so one shape covers all five.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStart {
    /// `ready` | `notInstalled` | `wouldNotStart` | `notAllowed` | `tookTooLong`.
    pub outcome: &'static str,
    /// Docker's own last words. The card shows them under its sentence; empty when there are none.
    pub detail: String,
}

impl From<scripts::EngineOutcome> for DockerStart {
    fn from(outcome: scripts::EngineOutcome) -> DockerStart {
        use scripts::EngineOutcome::{NotAllowed, NotInstalled, Ready, TookTooLong, WouldNotStart};
        let (outcome, detail) = match outcome {
            Ready => ("ready", String::new()),
            NotInstalled(detail) => ("notInstalled", detail),
            WouldNotStart(detail) => ("wouldNotStart", detail),
            NotAllowed(detail) => ("notAllowed", detail),
            TookTooLong(detail) => ("tookTooLong", detail),
        };
        DockerStart { outcome, detail }
    }
}

/// Start Docker Desktop and wait for its engine. The card keeps its own clock against [`scripts::ENGINE_LIMIT`]
/// (`engine_limit_seconds` in [`DesktopInfo`]), which is the whole of what there is to say while it waits.
///
/// Minutes long by design and deliberately NOT a `CommandResult`: every way this ends is an answer the screen
/// has a sentence for, and an `Err` would collapse five of them into a red string.
#[tauri::command]
pub async fn docker_start() -> DockerStart {
    tauri::async_runtime::spawn_blocking(|| {
        DockerStart::from(scripts::bring_engine_up(scripts::ENGINE_LIMIT))
    })
    .await
    .unwrap_or_else(|error| DockerStart {
        outcome: "wouldNotStart",
        detail: error.to_string(),
    })
}

/// Bring Docker Desktop's own window up — the button beside a card that has just said to look at it, because
/// its welcome screen and its sign-in are the two things this app cannot answer for anybody.
#[tauri::command]
pub async fn docker_open() -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(|| match scripts::start_docker_desktop(true) {
        Ok(()) => Ok(()),
        Err(scripts::StartTrouble::NotInstalled(problem))
        | Err(scripts::StartTrouble::Failed(problem)) => Err(problem),
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Whether a sandbox has ever run on THIS machine — what makes a stopped Docker this app's problem rather
/// than somebody else's preference (state.rs).
#[tauri::command]
pub fn hosts_sandboxes(state: State<'_, AppState>) -> bool {
    state.hosts_sandboxes()
}

/// Taken, not read: the launch that opened this face because the engine was asleep is the one launch that
/// should hand over to the workspace on its own once the engine answers. A window opened from the tray was
/// asked for, and must stay where the user put it.
#[tauri::command]
pub fn take_pending_docker(state: State<'_, AppState>) -> bool {
    std::mem::take(&mut *state.pending_docker.lock().unwrap())
}

/* TAKEN, NOT READ — the same rule [`take_pending_recreate`] has always had, and for a sharper reason here. */
#[tauri::command]
pub fn take_pending_setup(state: State<'_, AppState>) -> Option<SetupArgs> {
    state.pending.lock().unwrap().take()
}

/// Taken, not read: a recreate request is consumed by whichever launcher mount picks it up, so a window
/// reopened later does not re-run an update the user already ran.
#[tauri::command]
pub fn take_pending_recreate(state: State<'_, AppState>) -> Option<RecreateArgs> {
    state.pending_recreate.lock().unwrap().take()
}

/// Taken, not read, for the sharpest reason of the three: the pairing token inside is single-use, and a
/// request delivered twice would spend it on a run nobody is watching.
#[tauri::command]
pub fn take_pending_sync(state: State<'_, AppState>) -> Option<SyncArgs> {
    state.pending_sync.lock().unwrap().take()
}

/// Everything a setup invocation needs beyond the link itself: the origins to fall back on, whether Docker
/// already answers, and any image override. Split from [`setup_script`] so that builder is a pure function of
/// its inputs — the argument assembly is the one part of this app that the host it targets never gets to
/// verify, since the Windows installer is cross-built on Linux and its `.ps1` conventions first execute on a
/// user's machine.
pub struct SetupContext {
    /// Used when the link carries no `platform` of its own.
    pub platform_url: String,
    pub app_url: String,
    pub docker_ready: bool,
    pub sandbox_image: Option<String>,
    pub host: Host,
    /// This build's version — the release its `ic` download is pinned to. See [`ic_url`].
    pub version: String,
    /* The install flow asks its one question exactly once, and on this path there is no terminal to ask it on — so the run happens TWICE. */
    pub consented: bool,
}

impl SetupContext {
    fn of(app: &AppHandle, consented: bool) -> SetupContext {
        let state = app.state::<AppState>();
        let host = Host::current();
        SetupContext {
            platform_url: state.platform_url(),
            app_url: state.app_url(),
            // Only Unix uses this answer, to decide whether the whole script must be elevated. On Windows the
            // script is never elevated: `ic docker prepare` checks and raises each prerequisite itself. Asking
            // `docker info` here can spend tens of seconds waiting for a stopped daemon, after the setup face
            // has appeared but before its first command starts.
            docker_ready: setup_docker_ready(host, scripts::docker_ready),
            sandbox_image: std::env::var("INTENTIC_SANDBOX_IMAGE")
                .ok()
                .filter(|image| !image.is_empty()),
            host,
            version: VERSION.to_string(),
            consented,
        }
    }
}

/// Whether this setup needs the Docker probe before it can select its launch shape.
///
/// Windows always delegates the decision to `ic docker prepare`, which can report requirements and raise only
/// the individual operations that need administrator approval. Keeping the probe out of this synchronous path
/// lets a setup begin promptly when Docker Desktop is installed but its daemon is stopped.
fn setup_docker_ready(host: Host, probe: impl FnOnce() -> bool) -> bool {
    host == Host::Unix && probe()
}

/* THE WHOLE ONBOARDING, as an argument vector: connect.sh / connect.ps1 with the setup code the SPA minted. */
pub fn setup_script(args: &SetupArgs, ctx: &SetupContext) -> ScriptRun {
    let mut env: Vec<(String, String)> = app_env(&ctx.version);
    env.push((
        "PLATFORM_URL".into(),
        args.platform_url
            .clone()
            .unwrap_or_else(|| ctx.platform_url.clone()),
    ));
    // The daemon emits CORS only for the origins WEB_ORIGIN names, and the origin that will call it is the one
    // this app's workspace window loads. Identical to the hosted default in production; the reason a desktop
    // build pointed at a local SPA (INTENTIC_APP_URL) still reaches its sandbox.
    env.push(("WEB_ORIGIN".into(), ctx.app_url.clone()));
    if let Some(token) = args.cf_token.clone().filter(|token| !token.is_empty()) {
        env.push(("CF_TOKEN".into(), token));
    }
    if let Some(dir) = args.sync_dir.clone().filter(|dir| !dir.is_empty()) {
        env.push(("SYNC_DIR".into(), dir));
    }
    if let Some(image) = ctx.sandbox_image.clone() {
        env.push(("SANDBOX_IMAGE".into(), image));
    }

    /* Elevate only to install Docker, and only when there is none — the same trade the setup screen's "I already have Docker" checkbox makes. */
    let elevate = ctx.host == Host::Unix && !ctx.docker_ready;
    if elevate || (ctx.host == Host::Windows && ctx.consented) {
        env.push(("INSTALL_DOCKER".into(), "1".into()));
    }

    ScriptRun {
        file: ctx.host.script("connect.sh", "connect.ps1"),
        args: match ctx.host {
            Host::Windows => vec!["-SetupCode".into(), args.code.clone(), "-Yes".into()],
            Host::Unix => vec![args.code.clone(), "-y".into()],
        },
        env,
        elevate,
        host: ctx.host,
    }
}

/// End a run and everything it started (scripts.rs). There was no way to do this: the setup card's own
/// "you can close this — the install keeps going" was the whole of the offer, so a run that had gone wrong
/// could be abandoned but not stopped, and the next attempt then raced the one still going.
#[tauri::command]
pub async fn run_stop(id: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || scripts::stop(&id))
        .await
        .map_err(|error| error.to_string())?
}

/// Show a run's transcript in the machine's own file manager, selected. The file is written for every run
/// (scripts.rs); this is the button that finds it, because "it is in a dot-directory under your profile" is
/// an instruction most people will not follow at the moment an install has just failed on them.
#[tauri::command]
pub fn reveal_log(app: AppHandle, path: String) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(std::path::PathBuf::from(path))
        .map_err(|error| format!("could not open the log folder: {error}"))
}

/// Open an address in the machine's default browser. This face is a LOCAL page and gets no link handler of its
/// own (windows.rs `launcher`), so a `target="_blank"` on it opens nothing at all: WebView2 drops that press
/// without raising its new-window event, and the window that would have answered it is the workspace's.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("could not open your browser: {error}"))
}

/// `install` is the user's answer to the requirements list — see [`SetupContext::consented`]. False on the
/// first attempt of any setup, which is why a machine that needs changes reports them instead of making them.
#[tauri::command]
pub async fn setup_run(app: AppHandle, args: SetupArgs, install: bool) -> CommandResult<()> {
    *app.state::<AppState>().pending.lock().unwrap() = None;
    // A run that starts is a run that is no longer parked: whatever the restart was for has been picked up,
    // and leaving the file would re-offer this same setup on the next launch.
    app.state::<AppState>().clear_parked_setup();

    let name = args.name.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let run = setup_script(&args, &SetupContext::of(&handle, install));
        scripts::run(&handle, "setup", run)
    })
    .await
    .map_err(|error| error.to_string())??;

    // A setup that finished is a sandbox running here, whatever it ended up being called: from now on this
    // machine's stopped Docker is this app's to start (scripts.rs).
    app.state::<AppState>().remember_hosts_sandboxes();

    // The script names the container after the slug it derived, so the row it just created is the one slug we
    // did not have a moment ago. Remembering the display name here is why the manager can show "work" instead
    // of a twelve-hex id — docker knows only the container name.
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        if let Some(slug) = newest_slug() {
            app.state::<AppState>().remember_name(&slug, Some(&name));
        }
    }
    Ok(())
}

/* Turning WSL2 on is the ordinary first step of a Windows install, and it does nothing at all until the machine reboots. */

/// Park this setup, ask Windows to start this app after the next sign-in, and restart.
#[tauri::command]
pub fn restart_for_setup(app: AppHandle, args: SetupArgs) -> CommandResult<()> {
    app.state::<AppState>()
        .park_setup(&args, SessionEnd::Restart);
    end_session(SessionEnd::Restart)
}

/* THE OTHER THING WINDOWS ONLY DOES BETWEEN SESSIONS, and the requirement that had no button. */
#[tauri::command]
pub fn sign_out_for_setup(app: AppHandle, args: SetupArgs) -> CommandResult<()> {
    app.state::<AppState>()
        .park_setup(&args, SessionEnd::SignOut);
    end_session(SessionEnd::SignOut)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumableSetup {
    pub args: SetupArgs,
    /// How long ago it was parked. The window decides what to do with that — a setup code lives 30 minutes,
    /// and this is the only thing on either side of a restart that knows how much of that is left.
    pub aged_seconds: u64,
    /// Which way the session ended for it, so the card can tell a sign-out that did not take from a first
    /// ask.
    pub how: SessionEnd,
}

#[tauri::command]
pub fn resumable_setup(state: State<'_, AppState>) -> Option<ResumableSetup> {
    let parked = state.parked_setup()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    Some(ResumableSetup {
        args: parked.args,
        // Saturating, because a clock that moved backwards over the restart (they do) must read as "just
        // now" rather than as an age of eighteen quintillion seconds.
        aged_seconds: now.saturating_sub(parked.saved_at),
        how: parked.how,
    })
}

#[tauri::command]
pub fn forget_resumable_setup(state: State<'_, AppState>) {
    state.clear_parked_setup();
}

#[cfg(windows)]
fn end_session(how: SessionEnd) -> CommandResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = std::env::current_exe()
        .map_err(|error| format!("could not work out where this app lives: {error}"))?;
    // Quoted inside the value: the path contains spaces on every ordinary install, and RunOnce hands its
    // value to the shell as a command line.
    let command = format!("\"{}\"", exe.display());
    let registered = std::process::Command::new("reg.exe")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce",
            "/v",
            "IntenticResumeSetup",
            "/t",
            "REG_SZ",
            "/d",
            &command,
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    // A failed registration is NOT a reason to refuse the restart: the setup is already on disk, and the user
    // opening the app themselves afterwards finds it there. Losing the automatic half is much better than
    // leaving somebody on a screen whose only button did nothing.
    if !registered.map(|status| status.success()).unwrap_or(false) {
        eprintln!("intentic: could not register the after-restart resume; the setup is saved and will resume when this app is next opened.");
    }
    // `/l` signs the session out and `/r` takes the machine down; both end with a sign-in, which is the only
    // event either of these requirements is actually waiting for. No `/t` on a sign-out — `shutdown /l` does
    // not accept one, and there is nothing to warn a machine about that is not going down.
    let (verb, ended) = match how {
        SessionEnd::Restart => (
            vec!["/r", "/t", "10", "/c", "intentic: finishing Docker setup"],
            "restart",
        ),
        SessionEnd::SignOut => (vec!["/l"], "sign out"),
    };
    let done = std::process::Command::new("shutdown.exe")
        .args(&verb)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("could not {ended} this PC: {error}"))?;
    if done.success() {
        return Ok(());
    }
    Err(format!(
        "Windows refused the {ended}. Do it yourself and open Intentic again - your setup is saved."
    ))
}

/// Only Windows ever asks for this: no step of the Unix install needs a new session to take effect.
#[cfg(not(windows))]
fn end_session(_how: SessionEnd) -> CommandResult<()> {
    Err("nothing on this system needs a restart to finish installing.".to_string())
}

/* THE DOCKER ENGINE'S SIZE: the WSL guest on Windows, the Desktop VM on macOS, the host on Linux — the ceiling a sandbox's share is bounded by. */
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerEngine {
    pub memory_bytes: u64,
    pub cpus: u32,
}

/// `{{.MemTotal}} {{.NCPU}}`, read back. Anything unreadable is None, never a guess: a machine that will not say
/// its size is a form with no ceiling, which is honest, not a form with a wrong one.
pub fn engine_from(info: &str) -> Option<DockerEngine> {
    let mut fields = info.split_whitespace();
    let memory_bytes: u64 = fields.next()?.parse().ok()?;
    let cpus: u32 = fields.next()?.parse().ok()?;
    (memory_bytes > 0 && cpus > 0).then_some(DockerEngine { memory_bytes, cpus })
}

/// Async for [`docker_ready`]'s reason: `docker info` against a stopped daemon spends tens of seconds on the
/// socket, and nothing on the screen waits for this answer — the form draws its rails when it arrives.
#[tauri::command]
pub async fn docker_engine() -> Option<DockerEngine> {
    tauri::async_runtime::spawn_blocking(|| {
        scripts::docker_output(
            &["info", "--format", "{{.MemTotal}} {{.NCPU}}"],
            scripts::DOCKER_READ_LIMIT,
        )
        .ok()
        .and_then(|info| engine_from(&info))
    })
    .await
    .unwrap_or(None)
}

/// The slug of the most recently created sandbox — how a finished setup finds the row it just made without
/// re-deriving the script's slug rule (the hostname's leading label, or the connect token's digest) in a
/// second place. `docker ps` lists newest first, and the sidecar it created alongside is skipped.
fn newest_slug() -> Option<String> {
    let listing = scripts::docker_output(
        &[
            "ps",
            "-a",
            "--filter",
            &format!("name=^{CONTAINER_PREFIX}"),
            "--format",
            "{{.Names}}",
        ],
        scripts::DOCKER_READ_LIMIT,
    )
    .ok()?;
    listing
        .lines()
        .filter_map(|name| name.strip_prefix(CONTAINER_PREFIX))
        .find(|slug| !slug.starts_with("tunnel-"))
        .map(str::to_string)
}

/// Every sandbox on this machine as `ic sandbox list --json` reports it (the contract's `DeviceSandbox` rows: running
/// state, the share docker enforces, the shape each runs with, the shape saved for its next restart, the update
/// staged for it), with the name this app remembers for each. ic owns all of it; this app reads nothing off docker.
#[tauri::command]
pub async fn sandbox_list(app: AppHandle) -> CommandResult<Vec<serde_json::Value>> {
    let handle = app.clone();
    let rows = tauri::async_runtime::spawn_blocking(move || {
        scripts::ic_listing(&handle, list_script(Host::current(), VERSION))
    })
    .await
    .map_err(|error| error.to_string())??;
    let state = app.state::<AppState>();
    // A listing with a sandbox in it is the proof that this machine hosts one — and the only cheap proof
    // there is, since the next launch may find Docker stopped and be unable to ask anything at all.
    if !rows.is_empty() {
        state.remember_hosts_sandboxes();
    }
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let name = row["slug"].as_str().and_then(|slug| state.name_of(slug));
            if let (Some(name), Some(fields)) = (name, row.as_object_mut()) {
                fields.insert("name".to_string(), serde_json::Value::String(name));
            }
            row
        })
        .collect())
}

/// The recreate shim with `ic`'s own verb behind the shim's switch for it: `recreate.sh <slug> --restart` /
/// `recreate.ps1 -Slug … -Restart`. The shim fetches this build's own `ic` first, as it does for every recreate, so
/// the verb is one this app knows `ic` has. Named on PowerShell, positional on sh, for [`setup_script`]'s reason.
fn ic_verb_script(
    slug: &str,
    verb: (&'static str, &'static str),
    rest: Vec<String>,
    host: Host,
    version: &str,
) -> ScriptRun {
    let mut args = match host {
        Host::Windows => vec!["-Slug".to_string(), slug.to_string()],
        Host::Unix => vec![slug.to_string()],
    };
    args.push(host.script(verb.0, verb.1).to_string());
    args.extend(rest);
    ScriptRun {
        file: host.script("recreate.sh", "recreate.ps1"),
        args,
        env: app_env(version),
        elevate: false,
        host,
    }
}

/// `ic sandbox list --json` through the shim, for a machine whose installed `ic` is missing or older than this app:
/// the shim's fetch is what brings it level, so the next listing asks the installed one again.
pub fn list_script(host: Host, version: &str) -> ScriptRun {
    ScriptRun {
        file: host.script("recreate.sh", "recreate.ps1"),
        args: vec![host.script("--list", "-List").to_string()],
        env: app_env(version),
        elevate: false,
        host,
    }
}

/// Start, stop or restart through `ic`, which powers the tunnel sidecar with its sandbox (down first, up last) and
/// turns a start or restart into the recreate that applies a shape saved for the next restart. Anything else is
/// refused rather than forwarded: this argument reaches the shim as its switch.
pub fn power_script(
    slug: &str,
    action: &str,
    host: Host,
    version: &str,
) -> Result<ScriptRun, String> {
    let switch = match action {
        "start" => ("--start", "-Start"),
        "stop" => ("--stop", "-Stop"),
        "restart" => ("--restart", "-Restart"),
        _ => return Err(format!("unknown sandbox action: {action}")),
    };
    Ok(ic_verb_script(slug, switch, Vec::new(), host, version))
}

/// Under the power id the screen's pane follows for these three verbs; a restart that applies a saved shape is a
/// recreate of a minute, so it streams like one.
#[tauri::command]
pub async fn sandbox_power(app: AppHandle, slug: String, action: String) -> CommandResult<()> {
    let run = power_script(&slug, &action, Host::current(), VERSION)?;
    let id = format!("power:{slug}");
    tauri::async_runtime::spawn_blocking(move || scripts::run(&app, &id, run))
        .await
        .map_err(|error| error.to_string())?
}

/// Recreate the sandbox on a different image — one script, three ways through it, exactly as the shim itself
/// takes them: `recreate.sh <slug>` pulls the fresh :stable base, `<slug> <sha256>` builds the owner-approved
/// environment overlay, and `<slug> --rollback` returns it to the image it ran before its last update. The SPA
/// shows all three as a command to paste on the host, because the daemon cannot recreate its own container;
/// this is that button.
///
/// Rollback wins over a hash rather than combining with one: they name two different destination images, and a
/// caller that asked for both has a bug that must not be resolved silently into a rebuild.
pub fn recreate_script(
    slug: &str,
    hash: Option<&str>,
    rollback: bool,
    host: Host,
    version: &str,
) -> ScriptRun {
    // Named on PowerShell, positional on sh — see setup_script for why the two are not interchangeable.
    let mut args = match host {
        Host::Windows => vec!["-Slug".into(), slug.to_string()],
        Host::Unix => vec![slug.to_string()],
    };
    if rollback {
        args.push(host.script("--rollback", "-Rollback").to_string());
    } else if let Some(hash) = hash.filter(|hash| !hash.is_empty()) {
        if host == Host::Windows {
            args.push("-Hash".into());
        }
        args.push(hash.to_string());
    }
    ScriptRun {
        file: host.script("recreate.sh", "recreate.ps1"),
        args,
        // recreate carries its own copy of the `ic` download block, so it needs the same pin the setup does.
        env: app_env(version),
        elevate: false,
        host,
    }
}

#[tauri::command]
pub async fn sandbox_recreate(
    app: AppHandle,
    slug: String,
    hash: Option<String>,
    rollback: bool,
) -> CommandResult<()> {
    let run = recreate_script(&slug, hash.as_deref(), rollback, Host::current(), VERSION);
    let id = format!("recreate:{slug}");
    tauri::async_runtime::spawn_blocking(move || scripts::run(&app, &id, run))
        .await
        .map_err(|error| error.to_string())?
}

/* A SANDBOX'S SHAPE, as the resources form sends it: the sandbox contract's SandboxShape, whole. */
#[derive(Deserialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    /// Whole GiB, or null for the default share derived from this machine.
    pub memory_gib: Option<u32>,
    /// Whole cores, or null for every core.
    pub cpus: Option<u32>,
    pub privileged: bool,
    pub gpu: bool,
}

/// `ic sandbox shape`'s flags for a whole shape and when it takes effect (`now`, `nextRestart`), or `--forget` for
/// none: a cap is `<n>g` / `<n>` or ic's `default`, a switch the explicit word (a bare flag could only ever add). The
/// Rust twin of the contract's `icShapeArgs`, which the machine agent and the web run; nothing is judged here, ic
/// checks the shape against the image's run contract.
pub fn shape_flags(shape: Option<&Shape>, when: &str) -> Result<Vec<String>, String> {
    let Some(shape) = shape else {
        return Ok(vec!["--forget".to_string()]);
    };
    let when = match when {
        "now" => "now",
        "nextRestart" => "next-restart",
        _ => return Err(format!("unknown time for a shape: {when}")),
    };
    let cap = |value: Option<u32>, unit: &str| {
        value.map_or_else(|| "default".to_string(), |n| format!("{n}{unit}"))
    };
    let switch = |on: bool| (if on { "on" } else { "off" }).to_string();
    Ok(vec![
        "--memory".to_string(),
        cap(shape.memory_gib, "g"),
        "--cpus".to_string(),
        cap(shape.cpus, ""),
        "--privileged".to_string(),
        switch(shape.privileged),
        "--gpus".to_string(),
        switch(shape.gpu),
        "--when".to_string(),
        when.to_string(),
    ])
}

/// `recreate.sh <slug> --shape <ic flags>` / `recreate.ps1 -Slug … -Shape <ic flags>`: everything after the switch
/// binds to the shim's remaining arguments and is forwarded whole to `ic sandbox shape`.
pub fn shape_script(
    slug: &str,
    shape: Option<&Shape>,
    when: &str,
    host: Host,
    version: &str,
) -> Result<ScriptRun, String> {
    Ok(ic_verb_script(
        slug,
        ("--shape", "-Shape"),
        shape_flags(shape, when)?,
        host,
        version,
    ))
}

/// Set a sandbox's shape now (a recreate onto the same image) or for its next restart through ic (nothing restarts),
/// or forget the one saved (`shape` absent). Under the recreate's own run id: the screen's pane for a row follows
/// that id whichever verb started it.
#[tauri::command]
pub async fn sandbox_shape(
    app: AppHandle,
    slug: String,
    shape: Option<Shape>,
    when: String,
) -> CommandResult<()> {
    let run = shape_script(&slug, shape.as_ref(), &when, Host::current(), VERSION)?;
    let id = format!("recreate:{slug}");
    tauri::async_runtime::spawn_blocking(move || scripts::run(&app, &id, run))
        .await
        .map_err(|error| error.to_string())?
}

/// Remove the sandbox, its volumes and its network — cleanup.sh, which is the only thing that also drops the
/// NAMED /work volume a plain `docker rm -v` leaves behind.
pub fn remove_script(slug: &str, host: Host, version: &str) -> ScriptRun {
    ScriptRun {
        file: host.script("cleanup.sh", "cleanup.ps1"),
        args: match host {
            Host::Windows => vec!["-Slug".into(), slug.to_string(), "-Yes".into()],
            Host::Unix => vec![slug.to_string(), "-y".into()],
        },
        // No `ic` download in this one, but the same no-prompt contract: cleanup asks "which sandbox?" when
        // it believes somebody is there, and the `-Yes` above is the only thing standing between this window
        // and a question nobody can answer.
        env: app_env(version),
        elevate: false,
        host,
    }
}

#[tauri::command]
pub async fn sandbox_remove(app: AppHandle, slug: String) -> CommandResult<()> {
    let run = remove_script(&slug, Host::current(), VERSION);
    let id = format!("remove:{slug}");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || scripts::run(&handle, &id, run))
        .await
        .map_err(|error| error.to_string())??;
    app.state::<AppState>().forget(&slug);
    Ok(())
}

/* THE DESKTOP SYNC ENROLLMENT, as an argument vector: sync.sh / sync.ps1 with the pairing the SPA minted. */
pub fn sync_script(args: &SyncArgs, dir: Option<&str>, host: Host, version: &str) -> ScriptRun {
    let mut env = app_env(version);
    env.push(("SANDBOX_URL".into(), args.url.clone()));
    env.push(("PAIR_TOKEN".into(), args.pair.clone()));
    if let Some(dir) = dir.filter(|dir| !dir.is_empty() && !args.mirror) {
        env.push(("SYNC_DIR".into(), dir.to_string()));
    }
    if args.takeover && !args.mirror {
        env.push(("TAKEOVER".into(), "1".into()));
    }
    ScriptRun {
        file: host.script("sync.sh", "sync.ps1"),
        args: Vec::new(),
        env,
        // Runs as the user by design — the agent installs into ~/.intentic/machine and registers per-user
        // login entries, and nothing about it needs root anywhere.
        elevate: false,
        host,
    }
}

/// Run the enrollment this window just collected a folder for. One at a time under the id the screen
/// watches; the events stream the same way every other run's do.
#[tauri::command]
pub async fn sync_run(app: AppHandle, args: SyncArgs, dir: Option<String>) -> CommandResult<()> {
    let run = sync_script(&args, dir.as_deref(), Host::current(), VERSION);
    tauri::async_runtime::spawn_blocking(move || scripts::run(&app, "sync-setup", run))
        .await
        .map_err(|error| error.to_string())?
}

/// How much already lives in a folder the user just picked — the one fact that turns the sync confirmation
/// from boilerplate into a sentence about THEIR files. Zero for a folder that does not exist yet (the picker
/// can create one), an error only for one that exists and cannot be read.
#[tauri::command]
pub async fn folder_entries(path: String) -> CommandResult<u32> {
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_dir(&path) {
        Ok(entries) => Ok(entries.count().min(u32::MAX as usize) as u32),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!("could not read {path}: {error}")),
    })
    .await
    .map_err(|error| error.to_string())?
}

/// What this machine's agent is doing — the sandboxes that may work on this device, the folders sync keeps in
/// step, the ports it put on localhost, and whether the one resident loop behind all of it is alive.
///
/// None of it was reachable from this app before. `syncDir` rides the setup link into `connect.sh` and is never
/// heard from again, so the window that exists to be the no-terminal way to run a sandbox could say a container
/// was up and nothing at all about the sync the same setup had just configured. The only place those facts lived
/// was `intentic-machine status`, in a terminal.
///
/// Returned as the agent's raw JSON rather than parsed here: this process has no schema for it (no Node), the
/// webview does, and re-stating the shape in Rust would be one more thing to keep in lockstep. `None` means no
/// machine agent is installed — which the screen renders as a fact about the device, not as a failure.
#[tauri::command]
pub async fn machine_report() -> CommandResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(scripts::sync_report)
        .await
        .map_err(|error| error.to_string())?
}

/// Restart this device's agent loop from the window, instead of naming the two commands for someone to type in a
/// terminal on the computer this app is already running on.
#[tauri::command]
pub async fn machine_restart() -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(scripts::agent_restart)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn sandbox_logs(slug: String, tail: u32) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        scripts::logs_tail(&format!("{CONTAINER_PREFIX}{slug}"), tail)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Hand the window back to the workspace — at the app's root, or at a path under it.
///
/// The path is what makes the manager's own screen reachable from the product: this window and the SPA's
/// Devices tab manage the same containers on the same machine through two different doors, and until now
/// neither said the other existed. `show_workspace_at` already navigates an open workspace window, so
/// "Open in Intentic" is the same swap the footer's other button does, one URL further along.
#[tauri::command]
pub fn workspace_open(app: AppHandle, path: Option<String>) {
    crate::windows::show_workspace_at(&app, path.as_deref());
}

/// Ask the OS to point at this window, bringing it back to the front first — a stopped setup that nobody is
/// looking at is a stopped setup nobody finds out about.
#[tauri::command]
pub fn setup_alert(app: AppHandle) {
    crate::windows::alert_setup(&app);
}

/* WHERE THE INSTALL HAS GOT TO, as the setup screen draws it (App.vue `progressShown`). */
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupReport {
    pub name: Option<String>,
    /// `running`, `waiting` (stopped for the requirements list to be answered), `failed`, `stopped` (by the
    /// user) or `done`.
    pub state: String,
    pub percent: f64,
    /// "Step 4 of 10".
    pub position: Option<String>,
    /// "about 3 min left".
    pub remaining: Option<String>,
    /// The running step's phase id, for the page's analytics rather than its screen.
    pub step: Option<String>,
}

/// The setup screen reporting its progress, on every change, for the workspace page (windows.rs
/// `announce_setup`). Nothing is stored: a page that opens later hears the next tick within a second.
#[tauri::command]
pub fn setup_progress(app: AppHandle, report: SetupReport) {
    crate::windows::announce_setup(&app, &report);
}

/// The calling window's page has measured its content (fitWindow.ts): size that window to it. The window is
/// the caller's own, handed to the command by Tauri, so a page can only ever size the window it stands in.
#[tauri::command]
pub fn fit_to_content(app: AppHandle, window: tauri::WebviewWindow, height: f64) {
    crate::windows::fit_to_content(&app, &window, height);
}

/// The close confirmation's answer (windows.rs). `remember` is the dialog's "always do this" — the only thing
/// that retires the question, and the reason it is worth asking at all.
///
/// There is no command for cancelling: that is the dialog closing its own window, which changes nothing.
#[tauri::command]
pub fn close_workspace(app: AppHandle, action: CloseAction, remember: bool) {
    // Handled OFF this callback, because answering destroys the very webview that called it — the WebView2 COM
    // re-entrancy the workspace window's navigation handler already steps around the same way (windows.rs).
    tauri::async_runtime::spawn(async move {
        crate::windows::resolve_close(&app, action, remember);
    });
}

/* WHAT THE APP IS DOING ABOUT ITS OWN VERSION — read on mount, then followed on `desktop://update`. */
#[tauri::command]
pub fn update_state(app: AppHandle) -> crate::update::Stage {
    crate::update::stage(&app)
}

/// Take the offer: install the downloaded update and come back on it, or open the download page for a copy
/// that cannot install one (update.rs states which is which). Refusals and failures come back as words for the
/// screen; a successful install on Windows never answers, because it ends this process.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::update::take_offer(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, settings: Settings) {
    state.save_settings(settings);
}

#[cfg(test)]
mod tests {
    use super::*;

    /* Argument vectors are tested on both host types. */

    /// A version that looks like a release, so the pin below is exercised. `VERSION` itself is `0.0.0` in
    /// every build of this repo including the test one, which is deliberately the value that means "not a
    /// release" — a suite that used it would assert the fallback and never the thing that ships.
    const RELEASE: &str = "1.2.3";

    fn context(host: Host, docker_ready: bool) -> SetupContext {
        SetupContext {
            platform_url: "https://api.intentic.dev".into(),
            app_url: "https://app.intentic.dev".into(),
            docker_ready,
            sandbox_image: None,
            host,
            version: RELEASE.into(),
            // The default is the FIRST attempt of any setup — nothing agreed to yet. Every test that cares
            // about the second one says so.
            consented: false,
        }
    }

    #[test]
    fn windows_setup_does_not_wait_for_a_docker_probe_before_starting() {
        let mut probed = false;
        assert!(!setup_docker_ready(Host::Windows, || {
            probed = true;
            true
        }));
        assert!(
            !probed,
            "Windows delegates prerequisites to ic docker prepare"
        );

        assert!(setup_docker_ready(Host::Unix, || true));
        assert!(!setup_docker_ready(Host::Unix, || false));
    }

    fn setup_args(code: &str) -> SetupArgs {
        SetupArgs {
            code: code.into(),
            sandbox_id: None,
            name: None,
            cf_token: None,
            sync_dir: None,
            platform_url: None,
        }
    }

    fn sync_args() -> SyncArgs {
        SyncArgs {
            url: "https://sandbox-abc.example.dev".into(),
            pair: "pair-token".into(),
            name: Some("work".into()),
            takeover: false,
            mirror: false,
        }
    }

    fn env_of<'a>(run: &'a ScriptRun, key: &str) -> Option<&'a str> {
        run.env
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn setup_binds_the_code_positionally_on_sh_and_by_name_on_powershell() {
        let unix = setup_script(&setup_args("abc123"), &context(Host::Unix, true));
        assert_eq!(unix.file, "connect.sh");
        assert_eq!(unix.args, vec!["abc123", "-y"]);

        let windows = setup_script(&setup_args("abc123"), &context(Host::Windows, true));
        assert_eq!(windows.file, "connect.ps1");
        assert_eq!(windows.args, vec!["-SetupCode", "abc123", "-Yes"]);
        // The footgun stated as an assertion: a bare leading positional binds to connect.ps1's -PlatformUrl.
        assert_ne!(windows.args.first().map(String::as_str), Some("abc123"));
    }

    #[test]
    fn setup_always_passes_the_dont_prompt_flag() {
        // No terminal to answer "other sandboxes are already running" in — without this the run hangs forever.
        assert!(setup_script(&setup_args("c"), &context(Host::Unix, true))
            .args
            .contains(&"-y".to_string()));
        assert!(
            setup_script(&setup_args("c"), &context(Host::Windows, true))
                .args
                .contains(&"-Yes".to_string())
        );
    }

    /* Shims download `ic` from `releases/latest` unless `IC_URL` overrides it. */
    /// A shape, for the lists below: every flow that runs the recreate shim is held to the same pin and the same
    /// silence, these included.
    fn shape() -> Shape {
        Shape {
            memory_gib: Some(12),
            cpus: None,
            privileged: false,
            gpu: true,
        }
    }

    #[test]
    fn every_script_fetches_the_cli_from_this_apps_own_release() {
        let pinned = "https://github.com/intentic/intentic/releases/download/v1.2.3";
        assert_eq!(ic_url(RELEASE).as_deref(), Some(pinned));
        for run in [
            setup_script(&setup_args("c"), &context(Host::Windows, false)),
            setup_script(&setup_args("c"), &context(Host::Unix, false)),
            recreate_script("work", None, false, Host::Windows, RELEASE),
            recreate_script("work", None, false, Host::Unix, RELEASE),
            shape_script("work", Some(&shape()), "now", Host::Windows, RELEASE).unwrap(),
            shape_script("work", Some(&shape()), "now", Host::Unix, RELEASE).unwrap(),
            power_script("work", "restart", Host::Windows, RELEASE).unwrap(),
            power_script("work", "restart", Host::Unix, RELEASE).unwrap(),
            list_script(Host::Windows, RELEASE),
            list_script(Host::Unix, RELEASE),
        ] {
            assert_eq!(
                env_of(&run, "IC_URL"),
                Some(pinned),
                "{} must not fetch a different release's CLI",
                run.file
            );
        }
    }

    #[test]
    fn a_build_that_is_not_a_release_still_takes_the_latest_cli() {
        // `tauri dev` out of a checkout has no matching GitHub release to pin to, so the shims' own default
        // is the only workable answer there.
        assert_eq!(ic_url("0.0.0"), None);
        assert_eq!(ic_url(""), None);
        let mut dev = context(Host::Windows, false);
        dev.version = "0.0.0".into();
        assert_eq!(
            env_of(&setup_script(&setup_args("c"), &dev), "IC_URL"),
            None
        );
    }

    /* The child has no window, no console and closed stdin. */
    #[test]
    fn no_script_this_window_spawns_is_allowed_to_prompt() {
        for run in [
            setup_script(&setup_args("c"), &context(Host::Windows, false)),
            setup_script(&setup_args("c"), &context(Host::Unix, false)),
            recreate_script("work", None, false, Host::Windows, RELEASE),
            shape_script("work", None, "now", Host::Windows, RELEASE).unwrap(),
            power_script("work", "stop", Host::Windows, RELEASE).unwrap(),
            list_script(Host::Windows, RELEASE),
            remove_script("work", Host::Windows, RELEASE),
            remove_script("work", Host::Unix, RELEASE),
            sync_script(
                &sync_args(),
                Some("/home/ada/projects"),
                Host::Unix,
                RELEASE,
            ),
            sync_script(&sync_args(), None, Host::Windows, RELEASE),
        ] {
            assert_eq!(
                env_of(&run, "INTENTIC_NO_PROMPT"),
                Some("1"),
                "{} could stop on a question nobody can answer",
                run.file
            );
        }
    }

    #[test]
    fn setup_carries_the_origins_the_daemon_needs() {
        let run = setup_script(&setup_args("c"), &context(Host::Unix, true));
        assert_eq!(
            env_of(&run, "PLATFORM_URL"),
            Some("https://api.intentic.dev")
        );
        // WEB_ORIGIN is the workspace window's origin, not the platform's — the daemon emits CORS for it.
        assert_eq!(env_of(&run, "WEB_ORIGIN"), Some("https://app.intentic.dev"));
    }

    #[test]
    fn a_links_own_platform_overrides_the_configured_one() {
        let mut args = setup_args("c");
        args.platform_url = Some("http://localhost:6480".into());
        let run = setup_script(&args, &context(Host::Unix, true));
        assert_eq!(env_of(&run, "PLATFORM_URL"), Some("http://localhost:6480"));
        // ...and only that one: the SPA origin still comes from this install's settings.
        assert_eq!(env_of(&run, "WEB_ORIGIN"), Some("https://app.intentic.dev"));
    }

    #[test]
    fn optional_values_ride_only_when_they_carry_something() {
        let bare = setup_script(&setup_args("c"), &context(Host::Unix, true));
        assert_eq!(env_of(&bare, "CF_TOKEN"), None);
        assert_eq!(env_of(&bare, "SYNC_DIR"), None);
        assert_eq!(env_of(&bare, "SANDBOX_IMAGE"), None);

        let mut args = setup_args("c");
        args.cf_token = Some("cf-token".into());
        args.sync_dir = Some("~/intentic/work".into());
        let mut ctx = context(Host::Unix, true);
        ctx.sandbox_image = Some("registry.example/sandbox:test".into());
        let full = setup_script(&args, &ctx);
        assert_eq!(env_of(&full, "CF_TOKEN"), Some("cf-token"));
        assert_eq!(env_of(&full, "SYNC_DIR"), Some("~/intentic/work"));
        assert_eq!(
            env_of(&full, "SANDBOX_IMAGE"),
            Some("registry.example/sandbox:test")
        );

        // An empty string is not a value — it would override the script's own default with nothing.
        let mut empty = setup_args("c");
        empty.cf_token = Some(String::new());
        empty.sync_dir = Some(String::new());
        let run = setup_script(&empty, &context(Host::Unix, true));
        assert_eq!(env_of(&run, "CF_TOKEN"), None);
        assert_eq!(env_of(&run, "SYNC_DIR"), None);
    }

    #[test]
    fn elevation_is_asked_for_only_to_install_docker_on_unix() {
        let needed = setup_script(&setup_args("c"), &context(Host::Unix, false));
        assert!(needed.elevate);
        assert_eq!(env_of(&needed, "INSTALL_DOCKER"), Some("1"));

        // Docker already answers: nothing on this path needs root.
        let unneeded = setup_script(&setup_args("c"), &context(Host::Unix, true));
        assert!(!unneeded.elevate);
        assert_eq!(env_of(&unneeded, "INSTALL_DOCKER"), None);

        // Windows never elevates the SCRIPT — `ic docker prepare` raises the individual steps that need
        // administrator through Windows' own prompt.
        let windows = setup_script(&setup_args("c"), &context(Host::Windows, false));
        assert!(!windows.elevate);
    }

    /* THE TWO PASSES OF A WINDOWS SETUP, which is the whole shape of "ask once" on a screen with no terminal. */
    #[test]
    fn windows_only_pre_consents_after_the_user_has_seen_the_list() {
        let first = setup_script(&setup_args("c"), &context(Host::Windows, false));
        assert_eq!(
            env_of(&first, "INSTALL_DOCKER"),
            None,
            "the first pass must ask, not act"
        );

        let mut agreed = context(Host::Windows, false);
        agreed.consented = true;
        let second = setup_script(&setup_args("c"), &agreed);
        assert_eq!(env_of(&second, "INSTALL_DOCKER"), Some("1"));
        assert!(
            !second.elevate,
            "the pre-consent is not an elevation - Windows asks for that itself, per step"
        );
    }

    /// The consent rides on what the USER answered, not on what this app's own Docker probe happened to see a
    /// moment earlier. Those two can disagree — a Docker Desktop that stopped between the probe and the run —
    /// and the second pass must not turn into a run that stops to ask a question nobody can answer.
    #[test]
    fn the_windows_pre_consent_follows_the_answer_rather_than_the_probe() {
        for docker_ready in [true, false] {
            let mut agreed = context(Host::Windows, docker_ready);
            agreed.consented = true;
            assert_eq!(
                env_of(&setup_script(&setup_args("c"), &agreed), "INSTALL_DOCKER"),
                Some("1"),
                "docker_ready={docker_ready}"
            );
        }
    }

    #[test]
    fn recreate_passes_the_slug_and_the_optional_hash_per_host() {
        assert_eq!(
            recreate_script("work", None, false, Host::Unix, RELEASE).args,
            vec!["work"]
        );
        assert_eq!(
            recreate_script("work", Some("deadbeef"), false, Host::Unix, RELEASE).args,
            vec!["work", "deadbeef"]
        );
        assert_eq!(
            recreate_script("work", None, false, Host::Windows, RELEASE).args,
            vec!["-Slug", "work"]
        );
        assert_eq!(
            recreate_script("work", Some("deadbeef"), false, Host::Windows, RELEASE).args,
            vec!["-Slug", "work", "-Hash", "deadbeef"]
        );
        assert_eq!(
            recreate_script("work", None, false, Host::Unix, RELEASE).file,
            "recreate.sh"
        );
        assert_eq!(
            recreate_script("work", None, false, Host::Windows, RELEASE).file,
            "recreate.ps1"
        );
    }

    /* The rollback spelling, per host — the flag the sh shim reads and the switch the ps1 declares are two different strings for one button. */
    #[test]
    fn rollback_is_a_flag_on_sh_and_a_switch_on_powershell() {
        assert_eq!(
            recreate_script("work", None, true, Host::Unix, RELEASE).args,
            vec!["work", "--rollback"]
        );
        assert_eq!(
            recreate_script("work", None, true, Host::Windows, RELEASE).args,
            vec!["-Slug", "work", "-Rollback"]
        );
    }

    #[test]
    fn a_rollback_never_carries_a_digest() {
        // Two different destination images; a caller asking for both is a bug, not a rebuild.
        assert_eq!(
            recreate_script("work", Some("deadbeef"), true, Host::Unix, RELEASE).args,
            vec!["work", "--rollback"]
        );
        assert_eq!(
            recreate_script("work", Some("deadbeef"), true, Host::Windows, RELEASE).args,
            vec!["-Slug", "work", "-Rollback"]
        );
    }

    #[test]
    fn an_empty_hash_is_an_update_not_an_overlay_build() {
        // `recreate.sh <slug> ""` would build an overlay pinned to no digest; the update path passes no hash.
        assert_eq!(
            recreate_script("work", Some(""), false, Host::Unix, RELEASE).args,
            vec!["work"]
        );
        assert_eq!(
            recreate_script("work", Some(""), false, Host::Windows, RELEASE).args,
            vec!["-Slug", "work"]
        );
    }

    /* THE SHAPE, PER HOST: the shim's own switch first, then `ic sandbox shape`'s flags verbatim behind it. */
    #[test]
    fn a_shape_forwards_ics_flags_behind_the_shims_own_switch_per_host() {
        let unix =
            shape_script("work", Some(&shape()), "nextRestart", Host::Unix, RELEASE).unwrap();
        assert_eq!(unix.file, "recreate.sh");
        assert_eq!(
            unix.args,
            vec![
                "work",
                "--shape",
                "--memory",
                "12g",
                "--cpus",
                "default",
                "--privileged",
                "off",
                "--gpus",
                "on",
                "--when",
                "next-restart"
            ]
        );
        let windows = shape_script("work", None, "nextRestart", Host::Windows, RELEASE).unwrap();
        assert_eq!(windows.file, "recreate.ps1");
        assert_eq!(windows.args, vec!["-Slug", "work", "-Shape", "--forget"]);
        assert!(shape_script("work", Some(&shape()), "later", Host::Unix, RELEASE).is_err());
    }

    /* POWER GOES THROUGH ic, so a Restart here applies a shape saved for the next restart, as it does from every other door. */
    #[test]
    fn power_is_ics_verb_behind_the_shims_switch_and_nothing_else_is_forwarded() {
        assert_eq!(
            power_script("work", "restart", Host::Unix, RELEASE)
                .unwrap()
                .args,
            vec!["work", "--restart"]
        );
        assert_eq!(
            power_script("work", "stop", Host::Windows, RELEASE)
                .unwrap()
                .args,
            vec!["-Slug", "work", "-Stop"]
        );
        assert!(power_script("work", "rm", Host::Unix, RELEASE).is_err());
        assert_eq!(list_script(Host::Unix, RELEASE).args, vec!["--list"]);
        assert_eq!(list_script(Host::Windows, RELEASE).args, vec!["-List"]);
    }

    /* A shape off the wire is whole: a missing field is a refusal, not a "leave it". */
    #[test]
    fn a_shape_off_the_wire_is_whole() {
        let parsed: Shape =
            serde_json::from_str(r#"{"memoryGib":null,"cpus":8,"privileged":false,"gpu":true}"#)
                .unwrap();
        assert_eq!(
            parsed,
            Shape {
                memory_gib: None,
                cpus: Some(8),
                privileged: false,
                gpu: true
            }
        );
        assert!(serde_json::from_str::<Shape>(r#"{"cpus":8}"#).is_err());
    }

    /// The engine's size as `docker info` prints it for the form's rails. Unreadable is None, never a guess.
    #[test]
    fn the_engines_size_is_read_off_docker_info() {
        assert_eq!(
            engine_from("21474836480 12\n"),
            Some(DockerEngine {
                memory_bytes: 21_474_836_480,
                cpus: 12
            })
        );
        assert_eq!(engine_from(""), None);
        assert_eq!(engine_from("0 12"), None);
        assert_eq!(engine_from("not numbers"), None);
    }

    #[test]
    fn remove_confirms_itself_per_host() {
        let unix = remove_script("work", Host::Unix, RELEASE);
        assert_eq!(unix.file, "cleanup.sh");
        assert_eq!(unix.args, vec!["work", "-y"]);

        let windows = remove_script("work", Host::Windows, RELEASE);
        assert_eq!(windows.file, "cleanup.ps1");
        assert_eq!(windows.args, vec!["-Slug", "work", "-Yes"]);
    }

    #[test]
    fn no_flow_but_setup_ever_elevates() {
        assert!(!recreate_script("work", None, false, Host::Unix, RELEASE).elevate);
        assert!(
            !shape_script("work", Some(&shape()), "now", Host::Unix, RELEASE)
                .unwrap()
                .elevate
        );
        assert!(
            !power_script("work", "restart", Host::Unix, RELEASE)
                .unwrap()
                .elevate
        );
        assert!(!remove_script("work", Host::Unix, RELEASE).elevate);
        assert!(!sync_script(&sync_args(), Some("/home/ada"), Host::Unix, RELEASE).elevate);
    }

    /* The sync enrollment binds EVERYTHING through env and nothing positionally — the same delivery the pasted one-liners use. */
    #[test]
    fn sync_enrollment_rides_entirely_on_env_on_both_hosts() {
        let unix = sync_script(
            &sync_args(),
            Some("/home/ada/projects/app"),
            Host::Unix,
            RELEASE,
        );
        assert_eq!(unix.file, "sync.sh");
        assert!(unix.args.is_empty());
        assert_eq!(
            env_of(&unix, "SANDBOX_URL"),
            Some("https://sandbox-abc.example.dev")
        );
        assert_eq!(env_of(&unix, "PAIR_TOKEN"), Some("pair-token"));
        assert_eq!(env_of(&unix, "SYNC_DIR"), Some("/home/ada/projects/app"));
        assert_eq!(env_of(&unix, "TAKEOVER"), None);

        let windows = sync_script(
            &sync_args(),
            Some("C:\\Users\\Ada\\projects\\app"),
            Host::Windows,
            RELEASE,
        );
        assert_eq!(windows.file, "sync.ps1");
        assert!(windows.args.is_empty());
        assert_eq!(
            env_of(&windows, "SYNC_DIR"),
            Some("C:\\Users\\Ada\\projects\\app")
        );
    }

    #[test]
    fn a_takeover_rides_only_when_asked_for() {
        let mut args = sync_args();
        args.takeover = true;
        let run = sync_script(&args, Some("/home/ada"), Host::Unix, RELEASE);
        assert_eq!(env_of(&run, "TAKEOVER"), Some("1"));
    }

    /// A mirror pairing has no folder: the builder drops one arriving beside it (and a takeover, which only
    /// sync contends over) rather than trusting the webview to never send them together.
    #[test]
    fn a_mirror_enrollment_never_carries_a_folder_or_a_takeover() {
        let mut args = sync_args();
        args.mirror = true;
        args.takeover = true;
        let run = sync_script(&args, Some("/home/ada/projects"), Host::Unix, RELEASE);
        assert_eq!(env_of(&run, "SYNC_DIR"), None);
        assert_eq!(env_of(&run, "TAKEOVER"), None);
    }

    /// An empty string is not a folder — it would override the agent's own default with nothing.
    #[test]
    fn an_empty_folder_is_no_folder() {
        let run = sync_script(&sync_args(), Some(""), Host::Unix, RELEASE);
        assert_eq!(env_of(&run, "SYNC_DIR"), None);
    }

    /* The machine agent's own install location, per host. */
    #[test]
    fn the_agents_own_install_is_preferred_over_whatever_is_on_path() {
        let unix = scripts::sync_agent_candidates(Host::Unix, Some("/home/ada"));
        assert_eq!(
            unix,
            vec![
                "/home/ada/.intentic/machine/bin/intentic-machine".to_string(),
                "intentic-machine".to_string()
            ]
        );

        let windows = scripts::sync_agent_candidates(Host::Windows, Some("C:\\Users\\Ada"));
        assert_eq!(
            windows,
            vec![
                "C:\\Users\\Ada\\.intentic\\machine\\bin\\intentic-machine.exe".to_string(),
                "intentic-machine.exe".to_string()
            ]
        );
    }

    #[test]
    fn a_machine_with_no_home_still_tries_the_path() {
        assert_eq!(
            scripts::sync_agent_candidates(Host::Unix, None),
            vec!["intentic-machine".to_string()]
        );
    }
}
