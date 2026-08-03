use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::scripts::{self, Host, ScriptRun};
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
}

impl SetupContext {
    fn of(app: &AppHandle) -> SetupContext {
        let state = app.state::<AppState>();
        SetupContext {
            platform_url: state.platform_url(),
            app_url: state.app_url(),
            docker_ready: scripts::docker_ready(),
            sandbox_image: std::env::var("INTENTIC_SANDBOX_IMAGE")
                .ok()
                .filter(|image| !image.is_empty()),
            host: Host::current(),
        }
    }
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
    let mut env: Vec<(String, String)> = Vec::new();
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

    // Elevate only to install Docker, and only when there is none — the same trade the setup screen's "I
    // already have Docker" checkbox makes. Windows never elevates here: connect.ps1 installs Docker Desktop
    // through winget, which asks for itself. INSTALL_DOCKER=1 goes with the elevation because the script's
    // consent prompt has no terminal to be answered in: the launcher asked before we got here.
    let elevate = ctx.host == Host::Unix && !ctx.docker_ready;
    if elevate {
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

#[tauri::command]
pub async fn setup_run(app: AppHandle, args: SetupArgs) -> CommandResult<()> {
    *app.state::<AppState>().pending.lock().unwrap() = None;

    let run = setup_script(&args, &SetupContext::of(&app));
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
pub fn recreate_script(slug: &str, hash: Option<&str>, host: Host) -> ScriptRun {
    // Named on PowerShell, positional on sh — see setup_script for why the two are not interchangeable.
    let mut args = match host {
        Host::Windows => vec!["-Slug".into(), slug.to_string()],
        Host::Unix => vec![slug.to_string()],
    };
    if let Some(hash) = hash.filter(|hash| !hash.is_empty()) {
        if host == Host::Windows {
            args.push("-Hash".into());
        }
        args.push(hash.to_string());
    }
    ScriptRun {
        file: host.script("recreate.sh", "recreate.ps1"),
        args,
        env: Vec::new(),
        elevate: false,
        host,
    }
}

#[tauri::command]
pub async fn sandbox_recreate(
    app: AppHandle,
    slug: String,
    hash: Option<String>,
) -> CommandResult<()> {
    let run = recreate_script(&slug, hash.as_deref(), Host::current());
    let id = format!("recreate:{slug}");
    tauri::async_runtime::spawn_blocking(move || scripts::run(&app, &id, run))
        .await
        .map_err(|error| error.to_string())?
}

/// Remove the sandbox, its volumes and its network — cleanup.sh, which is the only thing that also drops the
/// NAMED /work volume a plain `docker rm -v` leaves behind.
pub fn remove_script(slug: &str, host: Host) -> ScriptRun {
    ScriptRun {
        file: host.script("cleanup.sh", "cleanup.ps1"),
        args: match host {
            Host::Windows => vec!["-Slug".into(), slug.to_string(), "-Yes".into()],
            Host::Unix => vec![slug.to_string(), "-y".into()],
        },
        env: Vec::new(),
        elevate: false,
        host,
    }
}

#[tauri::command]
pub async fn sandbox_remove(app: AppHandle, slug: String) -> CommandResult<()> {
    let run = remove_script(&slug, Host::current());
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

    fn context(host: Host, docker_ready: bool) -> SetupContext {
        SetupContext {
            platform_url: "https://api.intentic.dev".into(),
            app_url: "https://app.intentic.dev".into(),
            docker_ready,
            sandbox_image: None,
            host,
        }
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

        // Windows never elevates here — connect.ps1 installs Docker Desktop via winget, which asks for itself.
        let windows = setup_script(&setup_args("c"), &context(Host::Windows, false));
        assert!(!windows.elevate);
        assert_eq!(env_of(&windows, "INSTALL_DOCKER"), None);
    }

    #[test]
    fn recreate_passes_the_slug_and_the_optional_hash_per_host() {
        assert_eq!(recreate_script("work", None, Host::Unix).args, vec!["work"]);
        assert_eq!(
            recreate_script("work", Some("deadbeef"), Host::Unix).args,
            vec!["work", "deadbeef"]
        );
        assert_eq!(
            recreate_script("work", None, Host::Windows).args,
            vec!["-Slug", "work"]
        );
        assert_eq!(
            recreate_script("work", Some("deadbeef"), Host::Windows).args,
            vec!["-Slug", "work", "-Hash", "deadbeef"]
        );
        assert_eq!(
            recreate_script("work", None, Host::Unix).file,
            "recreate.sh"
        );
        assert_eq!(
            recreate_script("work", None, Host::Windows).file,
            "recreate.ps1"
        );
    }

    #[test]
    fn an_empty_hash_is_an_update_not_an_overlay_build() {
        // `recreate.sh <slug> ""` would build an overlay pinned to no digest; the update path passes no hash.
        assert_eq!(
            recreate_script("work", Some(""), Host::Unix).args,
            vec!["work"]
        );
        assert_eq!(
            recreate_script("work", Some(""), Host::Windows).args,
            vec!["-Slug", "work"]
        );
    }

    #[test]
    fn remove_confirms_itself_per_host() {
        let unix = remove_script("work", Host::Unix);
        assert_eq!(unix.file, "cleanup.sh");
        assert_eq!(unix.args, vec!["work", "-y"]);

        let windows = remove_script("work", Host::Windows);
        assert_eq!(windows.file, "cleanup.ps1");
        assert_eq!(windows.args, vec!["-Slug", "work", "-Yes"]);
    }

    #[test]
    fn no_flow_but_setup_ever_elevates() {
        assert!(!recreate_script("work", None, Host::Unix).elevate);
        assert!(!remove_script("work", Host::Unix).elevate);
    }
}
