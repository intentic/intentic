use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::scripts::{self, Host, ScriptRun};
use crate::setup_link::{RecreateArgs, SetupArgs, SyncArgs};
use crate::state::{AppState, CloseAction, Settings};

type CommandResult<T> = Result<T, String>;

// The prefixes @intentic/sandbox-run derives every per-sandbox object from. They are duplicated here rather
// than imported because this process has no Node — but they are also the ONLY thing about the container shape
// this app knows, which is the whole point of running the scripts for everything else.
const CONTAINER_PREFIX: &str = "intentic-sandbox-";
const TUNNEL_PREFIX: &str = "intentic-sandbox-tunnel-";

/* WHAT THIS APP IS — and NOTHING ABOUT THE MACHINE IT IS ON, which is a boundary this struct is now drawn
 * along rather than a list that happens to stop here.
 *
 * Every field is a value this process is already holding, so [`desktop_info`] answers in the time one IPC
 * round trip takes and can stay a plain sync command. `dockerReady` used to be the sixth field, and it was
 * the one that ran a subprocess: see [`docker_ready`] for what that cost and why it left. */
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
}

/// What this build calls itself. `INTENTIC_VERSION` is stamped by build.rs from the release build's own
/// environment (build-desktop.sh); a checkout that was not built by it says `0.0.0`, which is the value
/// every "is this a real release" decision below reads.
pub const VERSION: &str = env!("INTENTIC_VERSION");

/* THE `ic` A SCRIPT DOWNLOADS HAS TO BE THIS APP'S OWN `ic`.
 *
 * scripts.rs states the app's whole parity argument: the scripts are bundled rather than fetched, so
 * "Intentic 1.2.0 ships connect.sh@1.2.0" and a release is one commit. That was true of the `.ps1` files and
 * quietly false of the binary they spend their first ten lines downloading — every shim fetches
 * `releases/latest/download/ic-…`, unpinned, on every run. The app updates itself only when the user next
 * quits it, so an app a release or two behind drives a brand-new CLI.
 *
 * That is not a theoretical drift. The `intentic-requirement:` marker and the two-pass consent flow the
 * Windows setup screen is built around were added at one commit: an app older than it receives those lines,
 * has no parser for them, has no requirements list to draw, and does not know its first pass is SUPPOSED to
 * stop — which is exactly a Windows install that reports nothing and appears to hang on "checking Docker".
 *
 * So the app names the release it wants, through the `IC_URL` base every shim already honours (connect.sh,
 * connect.ps1, connect-host.ps1, recreate.ps1 — one spelling, four files). `None` for an unversioned build:
 * a developer running `tauri dev` out of a checkout has no matching release to pin to, and `latest` is the
 * right answer there.
 */
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
    }
}

/* DOES A DOCKER DAEMON ANSWER RIGHT NOW — asked on its own, and off the main thread, because both of those
 * were load-bearing and neither was true when this lived inside [`desktop_info`].
 *
 * `async`, and that is the whole of the second half. A `#[tauri::command] fn` is dispatched INLINE on the
 * thread the IPC arrives on, which is the main thread — the one that pumps the window. Every other command
 * here that spawns a process is already `async fn` for that reason; this probe was the one that was not, and
 * it spawns `docker info`. On the machine this app exists to set up, Docker is often INSTALLED AND NOT
 * RUNNING, and `docker info` against a daemon that is not there does not fail fast: it spends tens of seconds
 * on the socket before giving up. For all of those seconds the launcher was frozen — no screen, no repaint,
 * and not even the window's own title, since setting that is an IPC of its own queued behind this one.
 *
 * What that looked like from outside is the bug this split fixes: a first-time user answers "Set up" to a
 * link from their browser and then watches an empty window for half a minute, on the one machine in the world
 * where the answer to this question is slow, in the one flow where they know least about the app. Both
 * desktop smoke tiers assert exactly that journey by window title and both caught it (smoke.sh section 4,
 * desktop-smoke-windows tier 1) — on the CI machines slow enough to be that user.
 *
 * Asked separately, and NOT waited for: App.vue starts this at mount and draws whichever face it is without
 * it. The answer only decides a step in the install plan and an analytics property, and the second caller of
 * `scripts::docker_ready` — the elevation decision in [`SetupContext::of`] — is unchanged and still exact,
 * being made inside an `async` command while the user watches the screen it belongs to.
 */
#[tauri::command]
pub async fn docker_ready() -> bool {
    scripts::docker_ready()
}

/* TAKEN, NOT READ — the same rule [`take_pending_recreate`] has always had, and for a sharper reason here.
 *
 * A parked setup is picked up from two directions: the `desktop://pending-setup` event, and the read the
 * launcher does when it mounts. Both call this, and whichever arrives second used to get a copy of the same
 * request — or, once `setup_run` had cleared the slot, a `None` that the screen then wrote back over its own
 * state as "there is no setup here". That is a live race between an arriving link and a mounting window, and
 * what it produces is the setup screen handing the window back to the manager mid-run, taking whatever the
 * run had to say with it. Taking it means exactly one of the two callers gets the work, and the other is
 * told plainly that somebody else has it.
 */
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
    /* THE USER HAS SEEN THE LIST AND SAID YES.
     *
     * The install flow asks its one question exactly once, and on this path there is no terminal to ask it
     * on — so the run happens TWICE. The first pass changes nothing: `ic docker prepare` examines the machine,
     * prints one `intentic-requirement:` line per thing that has to change, and stops. The window draws those
     * as a list with one button. The second pass carries this flag, which becomes INSTALL_DOCKER=1, which is
     * the same pre-consent the terminal path has always accepted for a headless install.
     *
     * A machine that needs nothing never sees the first pass end early — it has no requirements to report —
     * so the two-pass shape costs nothing on the common path. */
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

/* THE WHOLE ONBOARDING, as an argument vector: connect.sh / connect.ps1 with the setup code the SPA minted.
 * Everything it does — claiming the code, installing Docker, provisioning the tunnel, running the container,
 * waiting on /health, enrolling desktop sync — is the script's, unchanged from the terminal path.
 *
 * NAMED on PowerShell, positional on sh, because they bind differently and only one of them forgives a
 * mistake: connect.ps1's first positional parameter is `-PlatformUrl`, so passing the code bare would silently
 * point the whole setup at a platform named after a setup code. connect.sh reads the first non-flag argument
 * as the code, which is what its own one-liner passes.
 *
 * The "don't prompt" flag rides both, because this run has no terminal and the "other sandboxes are already
 * running" question would hang it forever. */
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

    /* Elevate only to install Docker, and only when there is none — the same trade the setup screen's "I
     * already have Docker" checkbox makes. Windows never elevates the SCRIPT: `ic docker prepare` raises the
     * individual steps that need administrator (turning on WSL2, running Docker's installer) through Windows'
     * own prompt, which is both narrower and the thing users expect to see.
     *
     * INSTALL_DOCKER=1 is the pre-consent both hosts read, and it is set from different places for the same
     * reason. On Unix it rides with the elevation: pkexec has already asked the user for a password, which is
     * the consent. On Windows it waits for `consented` — the click on the requirements list, which is the
     * only place the user has been shown what will change. */
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

/// `install` is the user's answer to the requirements list — see [`SetupContext::consented`]. False on the
/// first attempt of any setup, which is why a machine that needs changes reports them instead of making them.
#[tauri::command]
pub async fn setup_run(app: AppHandle, args: SetupArgs, install: bool) -> CommandResult<()> {
    *app.state::<AppState>().pending.lock().unwrap() = None;
    // A run that starts is a run that is no longer parked: whatever the restart was for has been picked up,
    // and leaving the file would re-offer this same setup on the next launch.
    app.state::<AppState>().clear_parked_setup();

    let run = setup_script(&args, &SetupContext::of(&app, install));
    let name = args.name.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || scripts::run(&handle, "setup", run))
        .await
        .map_err(|error| error.to_string())??;

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

/* --- THE RESTART, AND COMING BACK FROM IT ---
 *
 * Turning WSL2 on is the ordinary first step of a Windows install, and it does nothing at all until the
 * machine reboots. Every version of this flow that merely SAID so lost people there: they are several minutes
 * in, have answered an administrator prompt, and are now being asked to restart and then find their way back
 * to a setup code they no longer have on screen.
 *
 * So the app takes the whole thing on: the setup is written to disk, Windows is told to run this app once at
 * the next sign-in, and the machine restarts. The app comes back up, finds the parked setup, and carries on.
 * RunOnce is the right key for it — Windows deletes the entry as it runs it, so a setup that is picked up is
 * picked up exactly once and nothing is left behind on the machine afterwards. */

/// Park this setup, ask Windows to start this app after the next sign-in, and restart.
#[tauri::command]
pub fn restart_for_setup(app: AppHandle, args: SetupArgs) -> CommandResult<()> {
    app.state::<AppState>().park_setup(&args);
    end_session(Session::Restart)
}

/* THE OTHER THING WINDOWS ONLY DOES BETWEEN SESSIONS, and the requirement that had no button.
 *
 * Adding an account to `docker-users` succeeds instantly and changes nothing that matters: group membership
 * lives in the login token, and Windows issues a new one only at sign-in. So that row's only control was
 * "Check again" — a button that could not possibly work, on a machine where every other step just had. The
 * fix is the same shape as the restart, one notch smaller: park the setup, register the resume, sign out.
 */
#[tauri::command]
pub fn sign_out_for_setup(app: AppHandle, args: SetupArgs) -> CommandResult<()> {
    app.state::<AppState>().park_setup(&args);
    end_session(Session::SignOut)
}

/// Which way this session ends. Both come back to the same place — RunOnce fires at the next sign-in either
/// way — so the only thing that differs is how far the machine goes down in between.
#[derive(Clone, Copy)]
pub enum Session {
    Restart,
    SignOut,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumableSetup {
    pub args: SetupArgs,
    /// How long ago it was parked. The window decides what to do with that — a setup code lives 30 minutes,
    /// and this is the only thing on either side of a restart that knows how much of that is left.
    pub aged_seconds: u64,
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
    })
}

#[tauri::command]
pub fn forget_resumable_setup(state: State<'_, AppState>) {
    state.clear_parked_setup();
}

#[cfg(windows)]
fn end_session(how: Session) -> CommandResult<()> {
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
        Session::Restart => (
            vec!["/r", "/t", "10", "/c", "intentic: finishing Docker setup"],
            "restart",
        ),
        Session::SignOut => (vec!["/l"], "sign out"),
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
fn end_session(_how: Session) -> CommandResult<()> {
    Err("nothing on this system needs a restart to finish installing.".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    pub slug: String,
    pub container: String,
    pub name: Option<String>,
    pub running: bool,
    pub image: String,
    /// None when no cloudflared sidecar exists for this sandbox at all.
    pub tunnel_running: Option<bool>,
}

struct ContainerRow {
    name: String,
    running: bool,
    image: String,
}

fn containers() -> Result<Vec<ContainerRow>, String> {
    let listing = scripts::docker_output(&[
        "ps",
        "-a",
        "--filter",
        &format!("name=^{CONTAINER_PREFIX}"),
        "--format",
        "{{.Names}}\t{{.State}}\t{{.Image}}",
    ])?;
    Ok(listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            Some(ContainerRow {
                name: fields.next()?.to_string(),
                running: fields.next()? == "running",
                image: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect())
}

/// The slug of the most recently created sandbox — how a finished setup finds the row it just made without
/// re-deriving the script's slug rule (the hostname's leading label, or the connect token's digest) in a
/// second place. `docker ps` lists newest first, and the sidecar it created alongside is skipped.
fn newest_slug() -> Option<String> {
    let listing = scripts::docker_output(&[
        "ps",
        "-a",
        "--filter",
        &format!("name=^{CONTAINER_PREFIX}"),
        "--format",
        "{{.Names}}",
    ])
    .ok()?;
    listing
        .lines()
        .filter_map(|name| name.strip_prefix(CONTAINER_PREFIX))
        .find(|slug| !slug.starts_with("tunnel-"))
        .map(str::to_string)
}

#[tauri::command]
pub async fn sandbox_list(app: AppHandle) -> CommandResult<Vec<SandboxStatus>> {
    let rows = tauri::async_runtime::spawn_blocking(containers)
        .await
        .map_err(|error| error.to_string())??;

    // A workspace container and its tunnel sidecar share the `intentic-sandbox-` prefix, and a user's own
    // subdomain may legitimately BE `tunnel-something` — so a name is only a sidecar when the workspace
    // container it would belong to actually exists. Nothing here has to guess.
    let workspace_names: Vec<&str> = rows
        .iter()
        .map(|row| row.name.as_str())
        .filter(|name| {
            name.strip_prefix(TUNNEL_PREFIX).is_none_or(|slug| {
                !rows
                    .iter()
                    .any(|row| row.name == format!("{CONTAINER_PREFIX}{slug}"))
            })
        })
        .collect();

    let state = app.state::<AppState>();
    Ok(workspace_names
        .iter()
        .filter_map(|name| {
            let slug = name.strip_prefix(CONTAINER_PREFIX)?.to_string();
            let row = rows.iter().find(|row| row.name == **name)?;
            let tunnel = rows
                .iter()
                .find(|candidate| candidate.name == format!("{TUNNEL_PREFIX}{slug}"));
            Some(SandboxStatus {
                name: state.name_of(&slug),
                container: row.name.clone(),
                running: row.running,
                image: row.image.clone(),
                tunnel_running: tunnel.map(|tunnel| tunnel.running),
                slug,
            })
        })
        .collect())
}

/// Start, stop or restart the sandbox and its sidecar together — a workspace with a stopped tunnel is reachable
/// from this machine's loopback and from nowhere else, which is not a state anyone asks for on purpose.
///
/// Three verbs rather than a boolean because the manager offers three: Restart is what the web's Devices tab
/// has always had here and this window had not, and a bool cannot say it. Anything else is refused rather than
/// forwarded — this argument reaches `docker` as its subcommand.
#[tauri::command]
pub async fn sandbox_power(slug: String, action: String) -> CommandResult<()> {
    if !matches!(action.as_str(), "start" | "stop" | "restart") {
        return Err(format!("unknown sandbox action: {action}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let container = format!("{CONTAINER_PREFIX}{slug}");
        let sidecar = format!("{TUNNEL_PREFIX}{slug}");
        // Stopping fells the tunnel first so nothing routes into a container on its way down; starting and
        // restarting raise it last. The same order the machine agent uses for the same three verbs.
        // The sidecar is optional (a sandbox reached over the user's own proxy has none), so its absence is
        // not a failure of the operation the user asked for.
        if action == "stop" {
            let _ = scripts::docker_output(&[&action, &sidecar]);
            scripts::docker_output(&[&action, &container])?;
        } else {
            scripts::docker_output(&[&action, &container])?;
            let _ = scripts::docker_output(&[&action, &sidecar]);
        }
        Ok(())
    })
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

/* THE DESKTOP SYNC ENROLLMENT, as an argument vector: sync.sh / sync.ps1 with the pairing the SPA minted.
 * Everything it does — downloading the agent, enrolling the SSH key, starting Mutagen and the port-mirror
 * watcher — is the script's, unchanged from the one-liner the Desktop sync card hands out; the app's part is
 * only that the folder arrived from a system dialog instead of being typed into a command.
 *
 * ENV THROUGHOUT, no positional args: both sync scripts read SANDBOX_URL / PAIR_TOKEN / SYNC_DIR / TAKEOVER
 * from the environment, exactly as the pasted `env … | sh` and `$env:… ; irm | iex` forms deliver them, so
 * there is no per-host argument convention here to get wrong.
 *
 * `dir` is the folder the user picked, and it is IGNORED on a mirror enrollment in this builder rather than
 * trusted to the webview: a mirror pairing has no folder, and a SYNC_DIR riding one would be a value the
 * agent ignores today and a latent surprise the day it stops ignoring it. */
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

/* WHAT THE APP IS DOING ABOUT ITS OWN VERSION — read on mount, then followed on `desktop://update`.
 *
 * Both halves are needed and neither is redundant. The event covers everything that happens while this window
 * is open; this covers the window that opens in the middle of it, which is the ordinary case here, because the
 * launcher face is built on demand and a download that started at launch is usually already finished by the
 * time anybody opens the manager. Without the read the screen would sit on "Checking for updates…" until the
 * next state change, which on a machine that is up to date never comes.
 */
#[tauri::command]
pub fn update_state(app: AppHandle) -> crate::update::Stage {
    crate::update::stage(&app)
}

/// Take the offer: install the downloaded update and come back on it, or open the download page for a copy
/// that cannot install one (update.rs states which is which). Refusals come back as words for the screen —
/// a run in flight is the one this exists for, and "it will update once that finishes" is the true sentence.
#[tauri::command]
pub fn update_install(app: AppHandle) -> CommandResult<()> {
    if let Some(refusal) = crate::update::refusal(&app) {
        return Err(refusal.to_string());
    }
    crate::update::act(&app);
    Ok(())
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

    /* The argument vectors, both hosts, on whichever host is running the suite.
     *
     * This is the crate's highest-risk logic and the least observable: the Windows installer is cross-built by
     * cargo-xwin on a Linux runner, so before these tests every `.ps1` argument convention in this file first
     * executed on a user's machine after a release. A `-SetupCode` that regressed to a bare positional would
     * bind to connect.ps1's `-PlatformUrl` and point the whole setup at a platform named after a setup code —
     * silently, with a plausible-looking failure much later. */

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

    /* THE APP AND THE CLI IT DRIVES MUST BE ONE RELEASE.
     *
     * Every shim downloads `ic` from `releases/latest` unless `IC_URL` says otherwise, and this app is the
     * one caller that can be arbitrarily old when it runs one — it installs its own updates only when the
     * user next quits. An app that predates a protocol the CLI now speaks receives lines it has no parser
     * for and a first pass it does not know is meant to stop, which is a Windows install that reports
     * nothing at all. */
    #[test]
    fn every_script_fetches_the_cli_from_this_apps_own_release() {
        let pinned = "https://github.com/intentic/intentic/releases/download/v1.2.3";
        assert_eq!(ic_url(RELEASE).as_deref(), Some(pinned));
        for run in [
            setup_script(&setup_args("c"), &context(Host::Windows, false)),
            setup_script(&setup_args("c"), &context(Host::Unix, false)),
            recreate_script("work", None, false, Host::Windows, RELEASE),
            recreate_script("work", None, false, Host::Unix, RELEASE),
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

    /* NO FLOW THIS WINDOW SPAWNS MAY ASK A QUESTION.
     *
     * The child has no window, no console and closed stdin. Every prompt in `ic` decides whether somebody is
     * there by probing for a terminal, and the cost of one of those probes being wrong is not a bad guess —
     * it is an install that never ends, in front of somebody watching a spinner. The `-y`/`-Yes` flags cover
     * the questions we know about; this covers the ones we do not. */
    #[test]
    fn no_script_this_window_spawns_is_allowed_to_prompt() {
        for run in [
            setup_script(&setup_args("c"), &context(Host::Windows, false)),
            setup_script(&setup_args("c"), &context(Host::Unix, false)),
            recreate_script("work", None, false, Host::Windows, RELEASE),
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

    /* THE TWO PASSES OF A WINDOWS SETUP, which is the whole shape of "ask once" on a screen with no terminal.
     *
     * First attempt: nothing agreed to, so no pre-consent rides along and `ic docker prepare` reports what it
     * would change rather than changing it. The window turns that into a list and a button. Second attempt
     * carries the answer. Getting this backwards would mean a window that silently installs Docker Desktop and
     * turns on Windows features on the strength of a click that never mentioned either. */
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

    /* The rollback spelling, per host — the flag the sh shim reads and the switch the ps1 declares are two
     * different strings for one button, and the Windows one is cross-built and first runs on a user's PC. */
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
        assert!(!remove_script("work", Host::Unix, RELEASE).elevate);
        assert!(!sync_script(&sync_args(), Some("/home/ada"), Host::Unix, RELEASE).elevate);
    }

    /* The sync enrollment binds EVERYTHING through env and nothing positionally — the same delivery the
     * pasted one-liners use, and the reason there is no per-host argument convention to cross-check here.
     * The Windows half is still asserted by name: like every other .ps1 it is cross-built on a Linux runner
     * and first executes on a user's machine. */
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

    /* The machine agent's own install location, per host. Cross-built like everything else here, so the Windows
     * spelling first executes on a user's PC — and getting it wrong is invisible rather than loud: the PATH
     * fallback would still find a global copy on a developer's machine and find nothing on a real user's, who
     * would then see a window that simply never mentions their sync. */
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
