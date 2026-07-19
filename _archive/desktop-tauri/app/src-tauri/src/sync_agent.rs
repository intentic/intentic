use std::path::{Path, PathBuf};

use intentic_desktop_core::engine::quiet;
use intentic_desktop_core::http;
use intentic_desktop_core::progress::Reporter;
use intentic_desktop_core::types::{Error, Result};

/// Enroll desktop sync after a tunnel-mode setup — the native analog of connect.sh's
/// run_desktop_sync: fetch the released `intentic-sync` binary once, then `setup --url --pair --dir`.
/// Failures must never fail the sandbox setup; the caller treats errors as a warning.
pub fn enroll(
    data_dir: &Path,
    sandbox_url: &str,
    pair_token: &str,
    sync_dir: &str,
    reporter: &dyn Reporter,
) -> Result<()> {
    let binary = ensure_binary(data_dir, reporter)?;
    reporter.log("sync", "enrolling desktop sync…");
    let output = quiet(std::process::Command::new(&binary))
        .args([
            "setup",
            "--url",
            sandbox_url,
            "--pair",
            pair_token,
            "--dir",
            sync_dir,
        ])
        .output()?;
    if !output.status.success() {
        return Err(Error::Command {
            command: "intentic-sync setup".into(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(())
}

fn ensure_binary(data_dir: &Path, reporter: &dyn Reporter) -> Result<PathBuf> {
    let (os, extension) = if cfg!(windows) {
        ("windows", ".exe")
    } else {
        ("linux", "")
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "amd64",
    };
    let destination = data_dir.join(format!("intentic-sync{extension}"));
    if destination.exists() {
        return Ok(destination);
    }
    let url = format!(
        "https://gitlab.com/radarsu/intentic/-/releases/permalink/latest/downloads/bin/intentic-sync-{os}-{arch}{extension}"
    );
    reporter.log("sync", "downloading the sync agent…");
    http::download(&url, &destination, reporter, "sync")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(destination)
}
