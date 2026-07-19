use std::io::{BufRead, BufReader};
use std::process::Stdio;

use serde::Deserialize;

use crate::progress::Reporter;
use crate::types::{Engine, Error, Result};

/// What `docker info` tells us about the daemon, classified for the reconcile checklist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockerProbe {
    Ready,
    PermissionDenied,
    DaemonDown,
    NotInstalled,
    Failed(String),
}

pub fn probe(engine: &Engine) -> DockerProbe {
    let output = engine
        .docker(["info", "--format", "{{.ServerVersion}}"])
        .output();
    match output {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DockerProbe::NotInstalled,
        Err(error) => DockerProbe::Failed(error.to_string()),
        Ok(output) => classify_probe(
            output.status.success(),
            &String::from_utf8_lossy(&output.stderr),
        ),
    }
}

/// Pure classification of `docker info` results so the messy real-world stderr strings are testable.
pub fn classify_probe(success: bool, stderr: &str) -> DockerProbe {
    if success {
        return DockerProbe::Ready;
    }
    let lowered = stderr.to_lowercase();
    if lowered.contains("permission denied") {
        return DockerProbe::PermissionDenied;
    }
    if lowered.contains("cannot connect to the docker daemon")
        || lowered.contains("daemon is not running")
        || lowered.contains("error during connect")
    {
        return DockerProbe::DaemonDown;
    }
    if lowered.contains("not found") || lowered.contains("not recognized") {
        return DockerProbe::NotInstalled;
    }
    DockerProbe::Failed(stderr.trim().to_string())
}

/// Run a docker command, returning trimmed stdout; a non-zero exit becomes `Error::Command`.
pub fn capture(engine: &Engine, args: &[&str]) -> Result<String> {
    let output = engine.docker(args).output()?;
    if !output.status.success() {
        return Err(Error::Command {
            command: format!("docker {}", args.join(" ")),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Run a docker command relaying every output line to the reporter (pull layers, build steps).
pub fn stream(engine: &Engine, args: &[&str], reporter: &dyn Reporter, stage: &str) -> Result<()> {
    let mut child = engine
        .docker(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    std::thread::scope(|scope| {
        for pipe in [stdout.map(boxed_reader), stderr.map(boxed_reader)]
            .into_iter()
            .flatten()
        {
            scope.spawn(move || {
                for line in pipe.lines().map_while(|line| line.ok()) {
                    if !line.trim().is_empty() {
                        reporter.log(stage, line.trim());
                    }
                }
            });
        }
    });
    let status = child.wait()?;
    if !status.success() {
        return Err(Error::Command {
            command: format!("docker {}", args.join(" ")),
            stderr: format!("exited with {status}"),
        });
    }
    Ok(())
}

fn boxed_reader<R: std::io::Read + Send + 'static>(
    reader: R,
) -> BufReader<Box<dyn std::io::Read + Send>> {
    BufReader::new(Box::new(reader))
}

pub fn container_state(engine: &Engine, name: &str) -> Option<String> {
    capture(engine, &["inspect", "--format", "{{.State.Status}}", name]).ok()
}

pub fn rm_force(engine: &Engine, name: &str) {
    let _ = engine.docker(["rm", "-f", name]).output();
}

pub fn ensure_network(engine: &Engine, name: &str) -> Result<()> {
    if capture(engine, &["network", "inspect", "--format", "{{.Id}}", name]).is_ok() {
        return Ok(());
    }
    capture(engine, &["network", "create", name]).map(|_| ())
}

pub fn inspect_env(engine: &Engine, container: &str) -> Result<Vec<(String, String)>> {
    let raw = capture(
        engine,
        &["inspect", "--format", "{{json .Config.Env}}", container],
    )?;
    let entries: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(entries
        .into_iter()
        .filter_map(|entry| {
            entry
                .split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect())
}

/// The named volume (or bind source) mounted at `destination`, if any — rebuild.sh's mount replay.
pub fn mount_source(engine: &Engine, container: &str, destination: &str) -> Option<String> {
    let format = format!(
        r#"{{{{range .Mounts}}}}{{{{if eq .Destination "{destination}"}}}}{{{{if eq .Type "volume"}}}}{{{{.Name}}}}{{{{else}}}}{{{{.Source}}}}{{{{end}}}}{{{{end}}}}{{{{end}}}}"#
    );
    let source = capture(engine, &["inspect", "--format", &format, container]).ok()?;
    if source.is_empty() {
        return None;
    }
    Some(source)
}

/// Published host ports of a container (`8787/tcp` → host port), for replaying local-mode publishes.
pub fn published_ports(engine: &Engine, container: &str) -> Vec<(String, String)> {
    let raw = capture(
        engine,
        &[
            "inspect",
            "--format",
            "{{json .NetworkSettings.Ports}}",
            container,
        ],
    )
    .unwrap_or_default();
    parse_published_ports(&raw)
}

#[derive(Deserialize)]
struct PortBinding {
    #[serde(rename = "HostIp")]
    host_ip: String,
    #[serde(rename = "HostPort")]
    host_port: String,
}

pub fn parse_published_ports(raw: &str) -> Vec<(String, String)> {
    let ports: std::collections::BTreeMap<String, Option<Vec<PortBinding>>> =
        serde_json::from_str(raw).unwrap_or_default();
    ports
        .into_iter()
        .filter_map(|(container_port, bindings)| {
            let binding = bindings?.into_iter().next()?;
            let port = container_port.split('/').next()?.to_string();
            let host = if binding.host_ip.is_empty() {
                "127.0.0.1".to_string()
            } else {
                binding.host_ip
            };
            Some((format!("{host}:{}", binding.host_port), port))
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
pub struct PsRow {
    #[serde(rename = "Names")]
    pub names: String,
    #[serde(rename = "State")]
    pub state: String,
    #[serde(rename = "Image")]
    pub image: String,
}

/// All intentic sandbox containers (running or not), tunnel sidecars included.
pub fn ps_intentic(engine: &Engine) -> Result<Vec<PsRow>> {
    let raw = capture(
        engine,
        &[
            "ps",
            "-a",
            "--filter",
            "name=intentic-sandbox-",
            "--format",
            "{{json .}}",
        ],
    )?;
    Ok(raw
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect())
}

pub fn exec_capture(engine: &Engine, container: &str, command: &[&str]) -> Result<String> {
    let mut args = vec!["exec", container];
    args.extend_from_slice(command);
    capture(engine, &args)
}

pub fn logs_tail(engine: &Engine, container: &str, lines: u32) -> Result<String> {
    let tail = lines.to_string();
    let output = engine
        .docker(["logs", "--tail", &tail, container])
        .output()?;
    // Container logs interleave stdout+stderr; both matter for diagnosing a crash-looping daemon.
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_daemon_states_from_stderr() {
        assert_eq!(classify_probe(true, ""), DockerProbe::Ready);
        assert_eq!(
            classify_probe(
                false,
                "permission denied while trying to connect to the Docker daemon socket"
            ),
            DockerProbe::PermissionDenied
        );
        assert_eq!(
            classify_probe(
                false,
                "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
            ),
            DockerProbe::DaemonDown
        );
        assert_eq!(
            classify_probe(false, "error during connect: open //./pipe/docker_engine: The system cannot find the file"),
            DockerProbe::DaemonDown
        );
        assert_eq!(
            classify_probe(
                false,
                "'docker' is not recognized as an internal or external command"
            ),
            DockerProbe::NotInstalled
        );
    }

    #[test]
    fn parses_published_ports() {
        let raw = r#"{"22/tcp":null,"8787/tcp":[{"HostIp":"127.0.0.1","HostPort":"8787"}]}"#;
        assert_eq!(
            parse_published_ports(raw),
            vec![("127.0.0.1:8787".to_string(), "8787".to_string())]
        );
        assert!(parse_published_ports("").is_empty());
    }
}
