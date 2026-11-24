#![cfg_attr(not(windows), allow(dead_code))]

/* THE ENGINE AS `ic uninstall` SEES IT: whether it is here, how much disk it holds, whether anything that is not
Intentic's runs on it, and everything of it that `ic engine remove` keeps on purpose (the download cache, the person's
word on the move, the move ledger), which an uninstall does not. `remove` itself stays the one way the distro goes
(windows.rs). Every function answers on any platform, and says "nothing here" off Windows. */

use std::path::Path;

#[cfg(windows)]
use super::paths;
#[cfg(windows)]
use super::EngineRecord;

/// Our engine's distro is registered on this account.
pub fn installed() -> bool {
    #[cfg(windows)]
    {
        super::status().installed
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// The bytes its disk takes (the VHDX folder), when there is one to measure.
pub fn disk_bytes() -> Option<u64> {
    #[cfg(windows)]
    {
        let distro = EngineRecord::load()
            .map(|record| record.distro)
            .unwrap_or_else(super::install_distro);
        paths::wsl_store_for(&distro).and_then(|store| folder_bytes(&store))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// The WSL distros it serves as their Docker (`ic engine wsl enable`).
pub fn served_distros() -> Vec<String> {
    #[cfg(windows)]
    {
        EngineRecord::load()
            .filter(EngineRecord::is_ours)
            .map(|record| record.wsl)
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// How many containers on it are not Intentic's: a WSL distro's own, run through the engine's integration. None when it
/// could not be asked (not running, not reachable). Ours are named `intentic-…` (sandbox/mod.rs, moves.rs).
pub fn others_on_it() -> Option<usize> {
    #[cfg(windows)]
    {
        let env = super::reach()?;
        let target = crate::docker::Target::Intentic(env);
        let listed = crate::docker::capture_on(
            &target,
            &["ps", "-a", "--format", "{{.Names}}"],
            std::time::Duration::from_secs(20),
        )
        .ok()?;
        if listed.code != Some(0) {
            return None;
        }
        Some(foreign_names(&listed.stdout))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// The containers in a `docker ps --format {{.Names}}` listing that are not Intentic's. Pure.
pub fn foreign_names(listing: &str) -> usize {
    listing
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.starts_with("intentic-"))
        .count()
}

/// Take a served distro's Docker integration out before the engine goes: it would otherwise keep a `docker` that
/// reaches nothing, and a systemd unit that waits for an engine that is not coming.
pub fn release_distro(distro: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        super::wsl_integration::disable(distro)
    }
    #[cfg(not(windows))]
    {
        let _ = distro;
        Ok(())
    }
}

/// What `ic engine remove` keeps on purpose, removed: the download cache (so a reinstall would not fetch it again),
/// the preference and move ledgers, the engine's folder under ~/.intentic, and the emptied VHDX folders. Answers the
/// paths it could not remove.
pub fn forget_leftovers() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut stuck = Vec::new();
        let engine_dir = paths::record_path().and_then(|path| path.parent().map(Path::to_path_buf));
        for dir in [paths::cache_dir(), engine_dir].into_iter().flatten() {
            if dir.exists() {
                if let Err(error) = std::fs::remove_dir_all(&dir) {
                    stuck.push(format!("{} ({error})", dir.display()));
                }
            }
        }
        // The VHDX folders `wsl --unregister` empties: the default one and any test engine's beside it. Only removed when
        // empty, since a folder that still holds a disk belongs to a distro that is still registered.
        if let Some(store) = paths::wsl_store() {
            if let Some(parent) = store.parent() {
                if let Ok(entries) = std::fs::read_dir(parent) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name == "engine" || name.starts_with("engine-") {
                            let _ = std::fs::remove_dir(entry.path());
                        }
                    }
                }
            }
        }
        stuck
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Bytes under a folder: its regular files, without following links out of it.
pub fn folder_bytes(dir: &Path) -> Option<u64> {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0usize;
    while let Some(next) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            // A cache of millions of files is measured in part rather than holding the question up.
            if seen > 200_000 {
                return Some(total);
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                total += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            }
        }
    }
    dir.exists().then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_containers_not_named_intentic_count_as_someone_elses() {
        let listing = "intentic-sandbox-ab\nintentic-trash-cd\nmy-postgres\n\nweb\n";
        assert_eq!(foreign_names(listing), 2);
        assert_eq!(foreign_names(""), 0);
    }

    #[test]
    fn a_folder_is_measured_by_its_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), vec![0u8; 10]).unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("b"), vec![0u8; 5]).unwrap();
        assert_eq!(folder_bytes(dir.path()), Some(15));
        assert_eq!(folder_bytes(&dir.path().join("missing")), None);
    }
}
