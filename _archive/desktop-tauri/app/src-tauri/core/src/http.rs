use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use crate::progress::Reporter;
use crate::types::{Error, Result};

/// Hosts whose TLS we don't verify — the connect.sh `curl -k`-for-localhost gate and the daemon's
/// LOCAL_HOSTS set, for driving a dev platform behind the self-signed localhost cert.
const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "host.docker.internal"];

pub fn client_for(url: &str) -> Result<reqwest::blocking::Client> {
    let local = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| LOCAL_HOSTS.contains(&h)))
        .unwrap_or(false);
    Ok(reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .danger_accept_invalid_certs(local)
        .build()?)
}

/// Download `url` to `dest` streaming percent progress (GitLab release assets redirect; reqwest follows).
pub fn download(url: &str, dest: &Path, reporter: &dyn Reporter, stage: &str) -> Result<()> {
    let response = client_for(url)?.get(url).send()?.error_for_status()?;
    let total = response.content_length();
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::File::create(dest)?;
    let mut reader = response;
    let mut buffer = [0u8; 1 << 16];
    let mut received: u64 = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])?;
        received += read as u64;
        if let Some(total) = total {
            if total > 0 {
                reporter.percent(
                    stage,
                    (received as f32 / total as f32) * 100.0,
                    &format!("{} / {} MB", received / (1 << 20), total / (1 << 20)),
                );
            }
        }
    }
    file.flush()?;
    Ok(())
}

pub fn post_form(url: &str, form: &[(&str, &str)]) -> Result<String> {
    let response = client_for(url)?.post(url).form(form).send()?;
    let status = response.status();
    let body = response.text()?;
    if !status.is_success() {
        return Err(Error::Setup(format!(
            "{url} answered {status}: {}",
            body.trim()
        )));
    }
    Ok(body)
}
