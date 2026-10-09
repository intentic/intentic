//! OUR OWN CONTAINER ENGINE (2026-10-09): on a Windows PC without Docker Desktop, sandboxes run on the open-source
#![cfg_attr(not(windows), allow(dead_code))]
//! Docker engine in a small WSL distro of ours (`intentic-engine`), which ic imports, starts and points every `docker`
//! it runs at. A PC that already has Docker Desktop keeps it.

mod commands;
mod fetch;
mod install_plan;
mod paths;
mod pins;
mod record;
#[cfg(windows)]
mod wsl;

#[cfg(windows)]
mod windows;

pub use record::EngineRecord;

/// The WSL distro our engine runs in, one per Windows account.
pub const DISTRO: &str = "intentic-engine";

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
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
}

pub fn choose(docker_desktop_installed: bool) -> Kind {
    if !cfg!(windows) {
        return Kind::Native;
    }
    match std::env::var("IC_ENGINE").ok().as_deref() {
        Some("docker-desktop") => Kind::DockerDesktop,
        Some("intentic") => Kind::Intentic,
        _ if docker_desktop_installed => Kind::DockerDesktop,
        _ => Kind::Intentic,
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
        wsl::distro_installed(DISTRO) && EngineRecord::load().is_some()
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

pub fn install(progress: &mut dyn FnMut(&str, Option<u64>)) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::install(progress)
    }
    #[cfg(not(windows))]
    {
        let _ = progress;
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

static ADOPTED: std::sync::Once = std::sync::Once::new();

/// Point this process's `docker` spawns at our engine when this account uses it.
pub fn adopt() {
    ADOPTED.call_once(|| {
        #[cfg(windows)]
        windows::adopt_env();
    });
}

pub use commands::{
    default_action, run_fetch, run_hold, run_install, run_remove, run_start, run_status, run_stop,
    run_update,
};
