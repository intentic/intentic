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

pub fn try_lock(dir: &Path) -> Result<Option<File>, String> {
    paths::ensure_dir(dir)?;
    let path = lock_path(dir);
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
        Err(error) => Err(format!("could not lock {}: {error}", path.display())),
    }
}

pub fn verify_sha256_file(path: &Path, want: &str) -> Result<(), String> {
    verify_sha256(path, want)
}

fn verify_sha256(path: &Path, want: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
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
    if !tarball.exists() {
        if let Ok(local) = std::env::var("INTENTIC_ENGINE_TARBALL") {
            let local = PathBuf::from(local);
            if local.exists() {
                std::fs::copy(&local, &tarball)
                    .map_err(|error| format!("could not copy {}: {error}", local.display()))?;
            }
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
