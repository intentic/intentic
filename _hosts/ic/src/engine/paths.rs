#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};

/// `%USERPROFILE%\.intentic\engine\engine.json` — how every `docker` this account runs is pointed at our engine.
pub fn record_path() -> Option<PathBuf> {
    home().map(|home| home.join(".intentic").join("engine").join("engine.json"))
}

/// `%USERPROFILE%\.intentic\engine\held` — the engine was stopped on purpose (record.rs `held`).
pub fn held_path() -> Option<PathBuf> {
    home().map(|home| home.join(".intentic").join("engine").join("held"))
}

/// `%USERPROFILE%\.intentic\engine\preference.json` — the engine the person chose in the app (`ic engine prefer`).
pub fn preference_path() -> Option<PathBuf> {
    home().map(|home| {
        home.join(".intentic")
            .join("engine")
            .join("preference.json")
    })
}

/// `%USERPROFILE%\.intentic\engine\moves.json` — sandboxes moved between engines, and what each left behind.
pub fn moves_path() -> Option<PathBuf> {
    home().map(|home| home.join(".intentic").join("engine").join("moves.json"))
}

/// `%USERPROFILE%\.intentic\engine\disk-consumers.json` — the last measurement of what takes the engine's disk
/// (disk_consumers.rs), kept because Docker takes minutes to make one.
pub fn disk_consumers_path() -> Option<PathBuf> {
    home().map(|home| {
        home.join(".intentic")
            .join("engine")
            .join("disk-consumers.json")
    })
}

/// `%USERPROFILE%\.intentic\engine-cache\` — resumable downloads ahead of install.
pub fn cache_dir() -> Option<PathBuf> {
    home().map(|home| home.join(".intentic").join("engine-cache"))
}

/// `%USERPROFILE%\.intentic\engine\tls\` — client TLS material copied out of the distro.
pub fn tls_dir() -> Option<PathBuf> {
    home().map(|home| home.join(".intentic").join("engine").join("tls"))
}

/// `%USERPROFILE%\.intentic\engine\bin\` — Windows static `docker.exe`.
pub fn bin_dir() -> Option<PathBuf> {
    home().map(|home| home.join(".intentic").join("engine").join("bin"))
}

/// The docker CLI's own plugin directory, the first it searches: `%DOCKER_CONFIG%\cli-plugins`, else
/// `%USERPROFILE%\.docker\cli-plugins`. The CLI reads no variable for a plugin directory of ours, and a system one
/// (`%ProgramFiles%\Docker\cli-plugins`) needs an elevated write, so the engine's buildx goes here, as the WSL
/// integration's links do.
pub fn user_cli_plugins_dir() -> Option<PathBuf> {
    std::env::var_os("DOCKER_CONFIG")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| home().map(|home| home.join(".docker")))
        .map(|config| config.join("cli-plugins"))
}

/// The CLI's system plugin directories on Windows, in the order it searches them after the user's own: where Docker
/// Desktop puts its buildx.
pub fn system_cli_plugins_dirs() -> Vec<PathBuf> {
    ["ProgramData", "ProgramFiles"]
        .iter()
        .filter_map(|var| std::env::var_os(var).filter(|dir| !dir.is_empty()))
        .map(|dir| PathBuf::from(dir).join("Docker").join("cli-plugins"))
        .collect()
}

/// `%LOCALAPPDATA%\Intentic\engine\` — where `wsl --import` keeps the distro's VHDX.
pub fn wsl_store() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(|local| PathBuf::from(local).join("Intentic").join("engine"))
}

/// The VHDX folder for `distro`: the default distro's is [`wsl_store`] itself, any other one a folder of its own
/// beside it, so a test engine never imports over the real one's disk.
pub fn wsl_store_for(distro: &str) -> Option<PathBuf> {
    let store = wsl_store()?;
    Some(if distro == super::DISTRO {
        store
    } else {
        store.with_file_name(format!("engine-{distro}"))
    })
}

/// Stable ic the desktop shims copy to (`~/.intentic/ic/bin/ic.exe`).
pub fn ic_exe() -> Option<PathBuf> {
    home().map(|home| home.join(".intentic").join("ic").join("bin").join("ic.exe"))
}

pub fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))
}
