use std::io::{Read, Write};
use std::process::{Command, Stdio};

use crate::logfile::Log;
use crate::util::{bail, Fail, Result};

/* The docker CLI as a subprocess — deliberately NOT a docker API crate. The shell flows this binary replaces
 * spoke to docker the way the user does, which means every failure they can hit is one the user can reproduce
 * by pasting the same command; an API socket client would trade that for a second connection path with its
 * own auth/socket-location matrix (Docker Desktop, rootless, remote contexts) that `docker` already solves. */

fn docker(args: &[&str]) -> Command {
    let mut cmd = Command::new("docker");
    cmd.args(args);
    cmd
}

pub fn cli_present() -> bool {
    // `docker --version` is client-only: no daemon round-trip, fails only when the binary is absent.
    docker(&["--version"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `docker info` aggregates CLI-plugin data and can hang (docker-scout/buildx); `docker version` with a
/// server format does a fast daemon round-trip and fails cleanly when the daemon is unreachable.
pub fn daemon_reachable() -> bool {
    ok(&["version", "--format", "{{.Server.Version}}"])
}

/// The connect preflight: docker must be present AND reachable, with the one diagnosis worth making — a
/// running daemon this user may not TALK to is indistinguishable from a stopped one at the CLI, except that
/// the socket is there to be seen. Docker installs it root-owned with a `docker` group, so naming the group
/// is the actual fix; "start Docker" would send the user to restart a daemon that is already up.
pub fn require_daemon() -> Result<()> {
    if !cli_present() {
        bail!("docker is not installed. Install Docker (https://docs.docker.com/get-docker/), then re-run — or run the connect one-liner, which offers to install it.");
    }
    if daemon_reachable() {
        return Ok(());
    }
    #[cfg(unix)]
    if std::path::Path::new("/var/run/docker.sock").exists() && !is_root() {
        let user = std::env::var("USER").unwrap_or_else(|_| "$USER".to_string());
        bail!(
            "the docker daemon is running, but this user can't talk to it.\n       add yourself to the docker group (then log out and back in):\n           sudo usermod -aG docker {user} && newgrp docker\n       or re-run this command with sudo."
        );
    }
    bail!("the docker daemon is not running or not reachable. Start Docker, then re-run.");
}

#[cfg(unix)]
pub fn is_root() -> bool {
    // Effective uid via /proc-free libc-free probe: root can always read a 0000 file it owns. Cheaper and
    // truer: the euid is what docker-group questions are about, and id -u answers exactly that.
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "0")
        .unwrap_or(false)
}

/// Exit-status probe with all streams quiet — the `docker … >/dev/null 2>&1` shape.
pub fn ok(args: &[&str]) -> bool {
    docker(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Best-effort side effect (`docker rm -f … || true`).
pub fn quiet(args: &[&str]) {
    let _ = docker(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Capture stdout; a non-zero exit is an Err carrying stderr, trimmed to its useful core.
pub fn capture(args: &[&str]) -> Result<String> {
    let out = docker(args)
        .output()
        .map_err(|err| Fail(format!("could not run docker: {err}")))?;
    if !out.status.success() {
        bail!(
            "docker {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Probe capture: None on any failure, no output anywhere.
pub fn try_capture(args: &[&str]) -> Option<String> {
    let out = docker(args).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Run with stdin fed from `input`, stdout captured, stderr into the log — the shape every run-contract
/// invocation uses (`docker run -i --rm --entrypoint intentic … <env pairs on stdin>`).
pub fn capture_with_stdin(args: &[&str], input: &[u8], log: &Log) -> Result<String> {
    let mut child = docker(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| Fail(format!("could not run docker: {err}")))?;
    child
        .stdin
        .take()
        .expect("stdin was piped")
        .write_all(input)
        .map_err(|err| Fail(format!("could not write to docker's stdin: {err}")))?;
    let out = child
        .wait_with_output()
        .map_err(|err| Fail(format!("docker did not finish: {err}")))?;
    log.write(&out.stderr);
    if !out.status.success() {
        bail!("docker run failed (see the log)");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Live output to the terminal AND the log — pulls and builds, where progress is the user experience and
/// the log is the postmortem. Ok(true) on success, Ok(false) on a non-zero exit (the caller decides whether
/// that ends the flow — a failed pull may fall back to a local image).
pub fn stream(args: &[&str], log: &Log) -> Result<bool> {
    let mut child = docker(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| Fail(format!("could not run docker: {err}")))?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let out_log = log.clone();
    let err_log = log.clone();
    let out_thread = std::thread::spawn(move || tee(stdout, &out_log, &mut std::io::stdout()));
    let err_thread = std::thread::spawn(move || tee(stderr, &err_log, &mut std::io::stderr()));
    let status = child
        .wait()
        .map_err(|err| Fail(format!("docker did not finish: {err}")))?;
    let _ = out_thread.join();
    let _ = err_thread.join();
    Ok(status.success())
}

/// `stream`, with stdin fed from `input` — the stdin `docker build -t <tag> -` shape, where progress is the
/// user experience (the terminal) and the log is the postmortem.
pub fn stream_with_stdin(args: &[&str], input: &[u8], log: &Log) -> Result<bool> {
    let mut child = docker(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| Fail(format!("could not run docker: {err}")))?;
    child
        .stdin
        .take()
        .expect("stdin was piped")
        .write_all(input)
        .map_err(|err| Fail(format!("could not write to docker's stdin: {err}")))?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let out_log = log.clone();
    let err_log = log.clone();
    let out_thread = std::thread::spawn(move || tee(stdout, &out_log, &mut std::io::stdout()));
    let err_thread = std::thread::spawn(move || tee(stderr, &err_log, &mut std::io::stderr()));
    let status = child
        .wait()
        .map_err(|err| Fail(format!("docker did not finish: {err}")))?;
    let _ = out_thread.join();
    let _ = err_thread.join();
    Ok(status.success())
}

fn tee(mut from: impl Read, log: &Log, terminal: &mut impl Write) {
    let mut buf = [0u8; 8192];
    while let Ok(read) = from.read(&mut buf) {
        if read == 0 {
            break;
        }
        let _ = terminal.write_all(&buf[..read]);
        let _ = terminal.flush();
        log.write(&buf[..read]);
    }
}

/// Execute an argv the run contract printed (`--format json`), all output into the log — the launch itself
/// is silent on success, exactly as `sh "$run_command" >/dev/null 2>>"$LOG"` was.
pub fn run_argv(argv: &[String], log: &Log) -> bool {
    let Some((program, rest)) = argv.split_first() else {
        return false;
    };
    let Ok(out) = Command::new(program).args(rest).output() else {
        return false;
    };
    log.write(&out.stdout);
    log.write(&out.stderr);
    out.status.success()
}

pub fn image_exists(image: &str) -> bool {
    ok(&["image", "inspect", image])
}

pub fn image_id(image: &str) -> Option<String> {
    try_capture(&["image", "inspect", "--format", "{{.Id}}", image])
}

pub fn inspect(target: &str, format: &str) -> Option<String> {
    try_capture(&["inspect", "--format", format, target])
}

pub fn container_exists(name: &str) -> bool {
    ok(&["inspect", name])
}

/// `docker ps [-a]` names matching a name filter.
pub fn ps_names(all: bool, name_filter: &str) -> Vec<String> {
    let filter = format!("name={name_filter}");
    let mut args = vec!["ps"];
    if all {
        args.push("-a");
    }
    args.extend_from_slice(&["--filter", &filter, "--format", "{{.Names}}"]);
    try_capture(&args)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .filter(|line| !line.is_empty())
        .collect()
}

pub fn exec_ok(container: &str, cmd: &[&str]) -> bool {
    let mut args = vec!["exec", container];
    args.extend_from_slice(cmd);
    ok(&args)
}

pub fn exec_capture(container: &str, cmd: &[&str]) -> Option<String> {
    let mut args = vec!["exec", container];
    args.extend_from_slice(cmd);
    try_capture(&args)
}

/// The old container's env, NUL-framed — `.Config.Env` is the values `docker run` was given plus the image's
/// own ENV, which is precisely what the run contract replays. Template framing (not `tr`) because
/// HOST_SSH_KEY is multi-line. Works on a STOPPED container: a daemon that broke badly enough left its
/// container exited, and requiring it to run made the one flow that could fix it unreachable.
pub fn container_env_nul(container: &str) -> Result<Vec<u8>> {
    let out = docker(&[
        "inspect",
        "--format",
        "{{range .Config.Env}}{{.}}{{printf \"\\x00\"}}{{end}}",
        container,
    ])
    .output()
    .map_err(|err| Fail(format!("could not run docker: {err}")))?;
    if !out.status.success() {
        bail!(
            "could not read the env of {container}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(out.stdout)
}

/// `docker cp` a file out of the container to `dest` — byte-exact (command substitution would strip trailing
/// newlines and change the overlay's hash), and it too works on a stopped container. False when absent.
pub fn cp_out(container: &str, path: &str, dest: &std::path::Path) -> bool {
    ok(&[
        "cp",
        &format!("{container}:{path}"),
        &dest.to_string_lossy(),
    ])
}

/// The container's log tail into OUR log — captured before an rm destroys it.
pub fn logs_into(container: &str, tail: &str, log: &Log) {
    if let Ok(out) = docker(&["logs", "--tail", tail, container]).output() {
        log.write(&out.stdout);
        log.write(&out.stderr);
    }
}

/// Pull a published image, with the two recoveries the scripts learned: an existing local copy beats a
/// failed pull, and a stale `docker login ghcr.io` (Docker Desktop's credential store) makes docker present
/// a dead token instead of pulling anonymously — clear it and retry once. After that, "denied" means the
/// registry refuses the package to EVERYONE: a packaging fault on our side, and the message says so, because
/// the older wording sent users hunting through their own Docker config for a fault that was ours.
pub fn pull(image: &str, log: &Log) -> Result<()> {
    log.section(&format!("docker pull {image}"));
    if stream(&["pull", image], log)? {
        return Ok(());
    }
    if image_exists(image) {
        eprintln!("intentic: pull failed but the image exists locally — using the local copy.");
        return Ok(());
    }
    eprintln!("intentic: pull failed — clearing a stale ghcr.io login and retrying anonymously…");
    quiet(&["logout", "ghcr.io"]);
    if stream(&["pull", image], log)? {
        return Ok(());
    }
    bail!(
        "{image} could not be pulled without a login. An \"unauthorized\" or \"denied\" above means the image's registry package is not public — that is a packaging fault on our side, not a problem with your machine. Report it, or if this org is yours make the package public at https://github.com/orgs/intentic/packages, then re-run."
    );
}
