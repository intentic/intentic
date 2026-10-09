#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};

/// `%USERPROFILE%\.intentic\engine\engine.json` — how every `docker` this account runs is pointed at our engine.
pub fn record_path() -> Option<PathBuf> {
    home().map(|home| home.join(".intentic").join("engine").join("engine.json"))
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

/// `%LOCALAPPDATA%\Intentic\engine\` — where `wsl --import` keeps the distro's VHDX.
pub fn wsl_store() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(|local| PathBuf::from(local).join("Intentic").join("engine"))
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
