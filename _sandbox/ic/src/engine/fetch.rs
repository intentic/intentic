use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::paths;
use super::pins;
use crate::fetch as http_fetch;

/// `intentic-prefetch:` line shape shared with `ic image prefetch`.
pub fn prefetch_line(state: &str, done: u64, total: u64) -> String {
    serde_json::json!({ "state": state, "done": done, "total": total }).to_string()
}

pub fn say_prefetch(state: &str, done: u64, total: u64) {
    println!("intentic-prefetch: {}", prefetch_line(state, done, total));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchOutcome {
    Complete,
    /// Another process holds the cache lock.
    HeldByAnother,
}

fn lock_path(dir: &Path) -> PathBuf {
    dir.join("lock")
}

/// The cache's lock: an OS lock on the `lock` file, held for as long as this value lives and released by the OS
/// itself if the process dies (the image cache's pattern, image_cache.rs). Before 2026-10-09 the lock was the file's
/// existence, never removed, so every fetch after the first one on a PC reported the cache held by another; and on omen
/// the same day an ic that crashed mid-install would have left one behind for good.
pub struct CacheLock {
    _file: File,
}

pub fn try_lock(dir: &Path) -> Result<Option<CacheLock>, String> {
    paths::ensure_dir(dir)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path(dir))
        .map_err(|error| format!("could not open the engine cache's lock: {error}"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(CacheLock { _file: file })),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => {
            Err(format!("could not lock the engine cache: {error}"))
        }
    }
}

/// How long a fetch waits on another one before giving up: the engine is 95 MB.
const WAIT_FOR_OTHER: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Another process is fetching into the cache: wait for it to finish (its lock is released), reporting the bytes on
/// disk, then fetch whatever it left missing.
pub fn wait_for_other(progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    let dir = paths::cache_dir().ok_or("could not find this account's home folder.")?;
    let deadline = std::time::Instant::now() + WAIT_FOR_OTHER;
    let total = pins::prefetch_total_bytes();
    while std::time::Instant::now() < deadline {
        match fetch_all(progress)? {
            FetchOutcome::Complete => return Ok(()),
            FetchOutcome::HeldByAnother => {
                let done = http_fetch::on_disk(&dir.join(pins::TARBALL_NAME))
                    + http_fetch::on_disk(&dir.join("docker-cli.zip"));
                progress(done.min(total), total);
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        }
    }
    Err("another ic has been downloading the engine for half an hour; try again later.".to_string())
}

pub fn verify_sha256_file(path: &Path, want: &str) -> Result<(), String> {
    verify_sha256(path, want)
}

fn verify_sha256(path: &Path, want: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    // On the heap: a Windows main thread has a 1 MB stack, and a 1 MiB array on it overflowed it on the first real
    // install (omen, 2026-10-09).
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let got: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if got != want {
        return Err(format!(
            "sha256 mismatch for {}: got {got}, expected {want}",
            path.display()
        ));
    }
    Ok(())
}

fn download_pinned(
    url: &str,
    into: &Path,
    sha256: &str,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    let agent = http_fetch::agent();
    let total_hint = http_fetch::on_disk(into);
    http_fetch::resumable(&agent, url, &[], into, true, &mut |done, total| {
        let total = if total > 0 {
            total
        } else {
            total_hint.max(done)
        };
        progress(done, total);
    })?;
    verify_sha256(into, sha256)?;
    Ok(())
}

/// Fetch the distro tarball and Windows docker CLI into the engine cache. Never prints; the `ic engine fetch`
/// command drives `intentic-prefetch:` lines from the progress callback.
pub fn fetch_all(progress: &mut dyn FnMut(u64, u64)) -> Result<FetchOutcome, String> {
    let dir = paths::cache_dir().ok_or("could not find this account's home folder.")?;
    paths::ensure_dir(&dir)?;
    let Some(_lock) = try_lock(&dir)? else {
        return Ok(FetchOutcome::HeldByAnother);
    };
    let tarball = dir.join(pins::TARBALL_NAME);
    let cli_zip = dir.join("docker-cli.zip");
    let total = pins::prefetch_total_bytes();
    let mut report = |done: u64, part_total: u64| {
        let whole = total.max(part_total);
        progress(done, whole);
    };
    // A tarball handed in (CI, a test PC) replaces whatever the cache holds: it is the build under test, and a cached
    // one from an earlier run would quietly test the old engine.
    if let Ok(local) = std::env::var("INTENTIC_ENGINE_TARBALL") {
        let local = PathBuf::from(local);
        if local.exists() {
            std::fs::copy(&local, &tarball)
                .map_err(|error| format!("could not copy {}: {error}", local.display()))?;
        }
    }
    if !tarball.exists() {
        let url = tarball_url();
        let agent = http_fetch::agent();
        http_fetch::resumable(&agent, &url, &[], &tarball, true, &mut |d, t| report(d, t))?;
        let sidecar = dir.join(format!("{}.sha256", pins::TARBALL_NAME));
        if sidecar.exists() {
            let want = std::fs::read_to_string(&sidecar)
                .map_err(|error| error.to_string())?
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string();
            if !want.is_empty() {
                verify_sha256(&tarball, &want)?;
            }
        }
    }
    download_pinned(
        pins::DOCKER_CLI_URL,
        &cli_zip,
        pins::DOCKER_CLI_SHA256,
        &mut |d, t| report(d, t),
    )?;
    Ok(FetchOutcome::Complete)
}

pub fn tarball_url() -> String {
    if let Ok(url) = std::env::var("INTENTIC_ENGINE_URL") {
        return url;
    }
    let tag = if crate::VERSION == "0.0.0" {
        std::env::var("IC_ENGINE_RELEASE_TAG").unwrap_or_else(|_| "latest".to_string())
    } else {
        format!("v{}", crate::VERSION)
    };
    format!(
        "https://github.com/intentic/intentic/releases/download/{tag}/{}",
        pins::TARBALL_NAME
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch as http_fetch;

    #[test]
    fn prefetch_line_matches_image_cache_shape() {
        let line = prefetch_line("fetching", 100, 1000);
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["state"], "fetching");
        assert_eq!(value["done"], 100);
        assert_eq!(value["total"], 1000);
    }

    #[test]
    fn range_resume_matches_fetch_crate() {
        assert_eq!(
            http_fetch::resume_from(100, Some("\"abc\""), false),
            (100, Some("\"abc\"".to_string()))
        );
        assert_eq!(http_fetch::resume_from(100, None, true), (100, None));
        assert_eq!(http_fetch::resume_from(100, None, false), (0, None));
    }
}
