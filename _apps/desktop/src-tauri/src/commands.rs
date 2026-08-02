use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::scripts::{self, platform_script, ScriptRun};
use crate::setup_link::{RecreateArgs, SetupArgs};
use crate::state::{AppState, Settings};

type CommandResult<T> = Result<T, String>;

// The prefixes @intentic/sandbox-run derives every per-sandbox object from. They are duplicated here rather
// than imported because this process has no Node — but they are also the ONLY thing about the container shape
// this app knows, which is the whole point of running the scripts for everything else.
const CONTAINER_PREFIX: &str = "intentic-sandbox-";
const TUNNEL_PREFIX: &str = "intentic-sandbox-tunnel-";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub version: String,
    pub os: String,
    pub app_url: String,
    pub platform_url: String,
    /// A Docker daemon answers right now. False covers both "not installed" and "not started" — the scripts
    /// tell those apart themselves (winget on Windows, get.docker.com on Linux), so the launcher only needs
    /// to know whether setup will have to ask for elevation.
    pub docker_ready: bool,
}

#[tauri::command]
pub fn desktop_info(state: State<'_, AppState>) -> DesktopInfo {
    DesktopInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        app_url: state.app_url(),
        platform_url: state.platform_url(),
        docker_ready: scripts::docker_ready(),
    }
}

#[tauri::command]
pub fn pending_setup(state: State<'_, AppState>) -> Option<SetupArgs> {
    state.pending.lock().unwrap().clone()
}

/// Taken, not read: a recreate request is consumed by whichever launcher mount picks it up, so a window
/// reopened later does not re-run an update the user already ran.
#[tauri::command]
pub fn take_pending_recreate(state: State<'_, AppState>) -> Option<RecreateArgs> {
    state.pending_recreate.lock().unwrap().take()
}

/// The whole onboarding: connect.sh / connect.ps1, with the setup code the SPA minted. Everything it does —
/// claiming the code, installing Docker, provisioning the tunnel, running the container, waiting on /health,
/// enrolling desktop sync — is the script's, unchanged from the terminal path.
#[tauri::command]
pub async fn setup_run(app: AppHandle, args: SetupArgs) -> CommandResult<()> {
    let state = app.state::<AppState>();
    *state.pending.lock().unwrap() = None;

    let mut env: Vec<(String, String)> = Vec::new();
    let platform_url = args
        .platform_url
        .clone()
        .unwrap_or_else(|| state.platform_url());
    env.push(("PLATFORM_URL".into(), platform_url));
    // The daemon emits CORS only for the origins WEB_ORIGIN names, and the origin that will call it is the one
    // this app's workspace window loads. Identical to the hosted default in production; the reason a desktop
    // build pointed at a local SPA (INTENTIC_APP_URL) still reaches its sandbox.
    env.push(("WEB_ORIGIN".into(), state.app_url()));
    if let Some(token) = args.cf_token.clone().filter(|token| !token.is_empty()) {
        env.push(("CF_TOKEN".into(), token));
    }
    if let Some(dir) = args.sync_dir.clone().filter(|dir| !dir.is_empty()) {
        env.push(("SYNC_DIR".into(), dir));
    }
    if let Ok(image) = std::env::var("INTENTIC_SANDBOX_IMAGE") {
        if !image.is_empty() {
            env.push(("SANDBOX_IMAGE".into(), image));
        }
    }

    // Elevate only to install Docker, and only when there is none — the same trade the setup screen's "I
    // already have Docker" checkbox makes. INSTALL_DOCKER=1 goes with it because the script's consent prompt
    // has no terminal to be answered in: the launcher asked before we got here.
    let elevate = !cfg!(windows) && !scripts::docker_ready();
    if elevate {
        env.push(("INSTALL_DOCKER".into(), "1".into()));
    }

    let name = args.name.clone();
    /* The "don't prompt" flag on both, because this run has no terminal and the "other sandboxes are already
     * running" question would hang it forever.
     *
     * NAMED on PowerShell, positional on sh, because they bind differently and only one of them forgives a
     * mistake: connect.ps1's first positional parameter is `-PlatformUrl`, so passing the code bare would
     * silently point the whole setup at a platform named after a setup code. connect.sh reads the first
     * non-flag argument as the code, which is what its own one-liner passes. */
    let run = ScriptRun {
        file: platform_script("connect.sh", "connect.ps1"),
        args: if cfg!(windows) {
            vec!["-SetupCode".into(), args.code.clone(), "-Yes".into()]
        } else {
            vec![args.code.clone(), "-y".into()]
        },
        env,
        elevate,
    };
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

/// Start/stop the sandbox and its sidecar together — a workspace with a stopped tunnel is reachable from this
/// machine's loopback and from nowhere else, which is not a state anyone asks for on purpose.
#[tauri::command]
pub async fn sandbox_power(slug: String, start: bool) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let verb = if start { "start" } else { "stop" };
        scripts::docker_output(&[verb, &format!("{CONTAINER_PREFIX}{slug}")])?;
        // The sidecar is optional (a sandbox reached over the user's own proxy has none), so its absence is
        // not a failure of the operation the user asked for.
        let _ = scripts::docker_output(&[verb, &format!("{TUNNEL_PREFIX}{slug}")]);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Recreate the sandbox on a different image — `recreate.sh <slug>` pulls the fresh :stable base, and
/// `<slug> <sha256>` builds the owner-approved environment overlay. The SPA shows both of these as a command
/// to paste on the host, because the daemon cannot recreate its own container; this is that button.
#[tauri::command]
pub async fn sandbox_recreate(
    app: AppHandle,
    slug: String,
    hash: Option<String>,
) -> CommandResult<()> {
    // Named on PowerShell, positional on sh — see setup_run for why the two are not interchangeable.
    let mut args = if cfg!(windows) {
        vec!["-Slug".into(), slug.clone()]
    } else {
        vec![slug.clone()]
    };
    if let Some(hash) = hash.filter(|hash| !hash.is_empty()) {
        if cfg!(windows) {
            args.push("-Hash".into());
        }
        args.push(hash);
    }
    let run = ScriptRun {
        file: platform_script("recreate.sh", "recreate.ps1"),
        args,
        env: Vec::new(),
        elevate: false,
    };
    let id = format!("recreate:{slug}");
    tauri::async_runtime::spawn_blocking(move || scripts::run(&app, &id, run))
        .await
        .map_err(|error| error.to_string())?
}

/// Remove the sandbox, its volumes and its network — cleanup.sh, which is the only thing that also drops the
/// NAMED /work volume a plain `docker rm -v` leaves behind.
#[tauri::command]
pub async fn sandbox_remove(app: AppHandle, slug: String) -> CommandResult<()> {
    let args = if cfg!(windows) {
        vec!["-Slug".into(), slug.clone(), "-Yes".into()]
    } else {
        vec![slug.clone(), "-y".into()]
    };
    let run = ScriptRun {
        file: platform_script("cleanup.sh", "cleanup.ps1"),
        args,
        env: Vec::new(),
        elevate: false,
    };
    let id = format!("remove:{slug}");
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || scripts::run(&handle, &id, run))
        .await
        .map_err(|error| error.to_string())??;
    app.state::<AppState>().forget(&slug);
    Ok(())
}

#[tauri::command]
pub async fn sandbox_logs(slug: String, tail: u32) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        scripts::logs_tail(&format!("{CONTAINER_PREFIX}{slug}"), tail)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn workspace_open(app: AppHandle) {
    crate::windows::show_workspace(&app);
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, settings: Settings) {
    state.save_settings(settings);
}
