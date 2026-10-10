//! OUR OWN CONTAINER ENGINE (2026-10-09): on a Windows PC without Docker Desktop, sandboxes run on the open-source
#![cfg_attr(not(windows), allow(dead_code))]
//! Docker engine in a small WSL distro of ours (`intentic-engine`), which ic imports, starts and points every `docker`
//! it runs at. A PC that already has Docker Desktop keeps it until its owner moves its sandboxes over
//! (`ic engine move`): the engine is installed there inactive, and only the move switches the PC onto it.

pub mod choice;
mod commands;
mod fetch;
mod install_plan;
pub mod moves;
mod paths;
mod pins;
mod record;
#[cfg(windows)]
mod wsl;

#[cfg(windows)]
mod relay;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod wsl_integration;

pub use moves::CopyArgs;
pub use record::EngineRecord;

/// The WSL distro our engine runs in, one per Windows account.
pub const DISTRO: &str = "intentic-engine";

/// The distro a new install imports: `IC_ENGINE_DISTRO` names another one for a test or CI engine that must never
/// touch a real one; an installed engine's own name is in its record.
pub fn install_distro() -> String {
    std::env::var("IC_ENGINE_DISTRO")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        })
        .unwrap_or_else(|| DISTRO.to_string())
}

/// Which container engine a PC's sandboxes run on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    DockerDesktop,
    Intentic,
    Native,
}

impl Kind {
    pub fn id(self) -> &'static str {
        match self {
            Kind::DockerDesktop => "dockerDesktop",
            Kind::Intentic => "intentic",
            Kind::Native => "native",
        }
    }

    pub fn parse(id: &str) -> Option<Kind> {
        match id {
            "dockerDesktop" | "docker-desktop" => Some(Kind::DockerDesktop),
            "intentic" => Some(Kind::Intentic),
            "native" => Some(Kind::Native),
            _ => None,
        }
    }

    /// How a person reads it.
    pub fn name(self) -> &'static str {
        match self {
            Kind::DockerDesktop => "Docker Desktop",
            Kind::Intentic => "Intentic's engine",
            Kind::Native => "this system's Docker",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    /// This account's sandboxes run on it (the record's switch).
    pub active: bool,
    /// Stopped on purpose: nothing restarts it until `ic engine start`.
    pub held: bool,
    pub distro: String,
    /// The network the running engine's dockerd is in, as its keeper wrote it: `isolated` (a namespace of its own, the
    /// way it runs since 2026-10-10) or `shared` (WSL's, the fallback). None when it is not running.
    pub network: Option<String>,
    /// The named pipe the relay serves the engine on (engine/relay.rs), when it is there now: docker reaches the
    /// engine through it, and over TLS on TCP without it.
    pub pipe: Option<String>,
}

/// The engine a fresh setup on this PC would put sandboxes on (choice.rs has the rules and the migration's switch).
pub fn choose(docker_desktop_installed: bool) -> Kind {
    if !cfg!(windows) {
        return Kind::Native;
    }
    choice::for_new_setup(
        &choice_facts(docker_desktop_installed),
        choice::DOCKER_DESKTOP_PCS,
    )
}

/// What the choice is made from, read off this PC: `IC_ENGINE`, the saved preference, the engines installed, and
/// whether this side of it already keeps sandboxes (a record of ic's per sandbox, `~/.intentic/sandbox-<slug>.channel`).
pub fn choice_facts(docker_desktop_installed: bool) -> choice::Facts {
    choice::Facts {
        forced: match std::env::var("IC_ENGINE").ok().as_deref() {
            Some("docker-desktop") => Some(Kind::DockerDesktop),
            Some("intentic") => Some(Kind::Intentic),
            _ => None,
        },
        preferred: preferred(),
        docker_desktop: docker_desktop_installed,
        own_engine: own_engine_installed(),
        sandboxes_here: sandboxes_recorded(),
        gpu: false,
    }
}

/// The engine a container made now runs on, as the sandbox is told it (`HOST_ENGINE`, beside HOST_ENV): the one this
/// process's `docker` reaches, which during a move is the engine being moved onto. `dockerDesktop`, `intentic`,
/// `own` (Rancher Desktop), `native` (Docker on Linux or macOS).
pub fn stamp() -> &'static str {
    if crate::docker::intentic_engine_in_use() {
        return Kind::Intentic.id();
    }
    if !cfg!(windows) {
        return Kind::Native.id();
    }
    if !commands::docker_desktop_installed() && own_engine_installed() {
        return "own";
    }
    Kind::DockerDesktop.id()
}

/// Whether the engine this PC's sandboxes run on is the person's own to keep running (choice.rs `bring_your_own`):
/// Docker Desktop once the migration's switch has flipped, or Rancher Desktop. Intentic then checks it and repairs
/// nothing of it.
pub fn bring_your_own() -> bool {
    if !cfg!(windows) {
        return false;
    }
    choice::bring_your_own(
        &choice_facts(commands::docker_desktop_installed()),
        choice::DOCKER_DESKTOP_PCS,
        in_use(),
    )
}

/// Whether the move onto our engine is to be put in front of the person now (choice.rs `offer_move`): read off this PC,
/// GPU sandboxes included, so an update can say it.
pub fn move_offered() -> bool {
    if !cfg!(windows) || choice::DOCKER_DESKTOP_PCS != Kind::Intentic {
        return false;
    }
    let mut facts = choice_facts(commands::docker_desktop_installed());
    facts.gpu = commands::gpu_in_use();
    choice::offer_move(&facts, choice::DOCKER_DESKTOP_PCS, in_use())
}

/// The preference the desktop app saved (`ic engine prefer`): `~/.intentic/engine/preference.json`.
pub fn preferred() -> Option<Kind> {
    let text = std::fs::read_to_string(paths::preference_path()?).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Kind::parse(value["engine"].as_str()?)
}

pub fn set_preferred(kind: Kind) -> Result<(), String> {
    let path = paths::preference_path().ok_or("could not find this account's home folder.")?;
    if let Some(parent) = path.parent() {
        paths::ensure_dir(parent)?;
    }
    let text =
        serde_json::json!({ "engine": kind.id(), "at": crate::sandbox::now_ms() }).to_string();
    std::fs::write(&path, text).map_err(|error| format!("{}: {error}", path.display()))
}

/// Rancher Desktop, the other engine people install on Windows for themselves: its own WSL distros and its own
/// `docker` pipe, which ic uses as it uses Docker Desktop's, and never installs or repairs.
fn own_engine_installed() -> bool {
    if !cfg!(windows) {
        return false;
    }
    let mut places = Vec::new();
    if let Some(dir) = std::env::var_os("ProgramFiles") {
        places.push(
            std::path::PathBuf::from(dir)
                .join("Rancher Desktop")
                .join("Rancher Desktop.exe"),
        );
    }
    if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
        places.push(
            std::path::PathBuf::from(dir)
                .join("Programs")
                .join("Rancher Desktop")
                .join("Rancher Desktop.exe"),
        );
    }
    places.iter().any(|place| place.exists())
}

/// This side of the PC keeps sandboxes: ic's record of one is there.
fn sandboxes_recorded() -> bool {
    std::fs::read_dir(crate::logfile::intentic_home())
        .map(|entries| {
            entries.flatten().any(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.starts_with("sandbox-") && name.ends_with(".channel")
            })
        })
        .unwrap_or(false)
}

/// The engine this account's sandboxes run on NOW, which every `docker` ic spawns is pointed at: ours when its record
/// is active, else whatever `docker` reaches by itself (Docker Desktop on Windows).
pub fn in_use() -> Kind {
    if !cfg!(windows) {
        return Kind::Native;
    }
    if EngineRecord::load().is_some_and(|record| record.is_active()) {
        Kind::Intentic
    } else {
        Kind::DockerDesktop
    }
}

pub fn status() -> Status {
    #[cfg(windows)]
    {
        windows::status()
    }
    #[cfg(not(windows))]
    {
        Status::default()
    }
}

/// True when the engine payload is on disk and the distro is registered — `ic engine fetch` prints `ready`.
pub fn prefetch_already_done() -> bool {
    #[cfg(windows)]
    {
        let Some(record) = EngineRecord::load() else {
            return false;
        };
        wsl::distro_installed(&record.distro)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn download_bytes() -> u64 {
    #[cfg(windows)]
    {
        windows::download_bytes()
    }
    #[cfg(not(windows))]
    {
        0
    }
}

pub fn fetch(progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::fetch(progress)
    }
    #[cfg(not(windows))]
    {
        let _ = progress;
        Ok(())
    }
}

/// Install (or repair) the engine. `activate`: this account's sandboxes run on it once it is in — a fresh PC's setup;
/// a Docker Desktop PC installs it inactive, ready for `ic engine move`.
pub fn install(progress: &mut dyn FnMut(&str, Option<u64>), activate: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::install(progress, activate)
    }
    #[cfg(not(windows))]
    {
        let _ = (progress, activate);
        Err("the intentic engine is installed only on Windows.".to_string())
    }
}

pub fn start() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::start()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

/// `ic engine wsl [enable|disable] <distro>`: this engine as a WSL distro's Docker (engine/wsl_integration.rs).
pub fn wsl(action: Option<&str>, distro: Option<&str>) -> Result<(), String> {
    #[cfg(windows)]
    {
        match (action, distro) {
            (Some("enable"), Some(distro)) => wsl_integration::enable(distro),
            (Some("disable"), Some(distro)) => wsl_integration::disable(distro),
            (None, _) => wsl_integration::list(),
            _ => Err("usage: ic engine wsl [enable|disable <distro>]".to_string()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (action, distro);
        Err("WSL integration is set up from Windows: ic engine wsl enable <distro>".to_string())
    }
}

/// `ic engine relay`: the engine's named pipe (engine/relay.rs). Windows only.
pub fn relay() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::relay()
    }
    #[cfg(not(windows))]
    {
        Err("the engine's named pipe exists only on Windows.".to_string())
    }
}

pub fn start_quiet() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::start_quiet()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

pub fn stop() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::stop()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

/// Stop, then start, with no hold in between: an engine that is up and does not answer.
pub fn restart() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::restart()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

pub fn hold() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::hold()
    }
    #[cfg(not(windows))]
    {
        stop()
    }
}

/// Whether the engine was stopped on purpose (record.rs `held`).
pub fn held() -> bool {
    record::held()
}

/// Stop the engine and hold it down, saying why: an engine no sandbox runs on gives its memory back.
pub fn rest(reason: &str) -> Result<(), String> {
    record::hold_as(reason)?;
    #[cfg(windows)]
    {
        windows::terminate()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

pub fn update() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::update()
    }
    #[cfg(not(windows))]
    {
        Err("the intentic engine is updated only on Windows.".to_string())
    }
}

pub fn remove(yes: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::remove(yes)
    }
    #[cfg(not(windows))]
    {
        let _ = yes;
        Ok(())
    }
}

/// Switch this account's sandboxes onto our engine, or off it (`ic engine move` does, once they are across).
pub fn set_active(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::set_active(on)
    }
    #[cfg(not(windows))]
    {
        let _ = on;
        Err("the intentic engine runs only on Windows.".to_string())
    }
}

/// How to reach our engine whether or not it is active: what a move talks to on the far side.
pub fn reach() -> Option<crate::docker::EngineEnv> {
    #[cfg(windows)]
    {
        windows::reach()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

static ADOPTED: std::sync::Once = std::sync::Once::new();

/// Point this process's `docker` spawns at our engine when this account's sandboxes run on it.
pub fn adopt() {
    ADOPTED.call_once(|| {
        #[cfg(windows)]
        windows::adopt_env();
    });
}

pub use commands::{
    default_action, docker_desktop_installed, run_copy, run_fetch, run_hold, run_install,
    run_prefer, run_relay, run_remove, run_restart, run_start, run_status, run_stop, run_update,
    run_wsl,
};
