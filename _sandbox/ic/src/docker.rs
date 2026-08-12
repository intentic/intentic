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

/// Which kind of container this daemon runs, lowercased — `linux`, or `windows` on a Docker Desktop switched
/// to Windows containers. `docker version` rather than `docker info` for the reason [`daemon_reachable`]
/// gives: same fast round-trip, no CLI-plugin aggregation to hang on.
pub fn server_os() -> Option<String> {
    try_capture(&["version", "--format", "{{.Server.Os}}"])
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

/* A REACHABLE DAEMON THAT CANNOT RUN OUR CONTAINERS.
 *
 * A sandbox is a Linux container, and until now nothing on any path asked whether the daemon could run one.
 * Every probe this file makes — the CLI is present, the daemon answers — succeeds against a Docker Desktop in
 * WINDOWS-container mode, and the run then dies several minutes later on an image pull, with a manifest error
 * that names no remedy and reads as a broken release.
 *
 * That is not a corner case: Windows-container mode is the DEFAULT of the docker preinstalled on Windows CI
 * images, and it is one tray-menu click away on any developer's machine. The check is a string comparison; the
 * value it adds is the sentence.
 *
 * An unknown platform is NOT a refusal. A daemon too old to report `Server.Os`, or a context that answers
 * something unexpected, is a daemon that has done nothing wrong — and a preflight that refuses what it cannot
 * identify would turn "we could not tell" into "you are misconfigured", which is the failure mode this whole
 * function exists to avoid. Only an explicit non-linux answer refuses. */
pub fn wrong_container_platform(server_os: Option<&str>) -> Option<(String, String)> {
    match server_os {
        Some(os) if os != "linux" => Some((
            format!("the docker daemon is running, but it runs {os} containers — a sandbox is a Linux container."),
            "on Windows: switch Docker Desktop to Linux containers (right-click the tray icon → \"Switch to Linux containers\"), then re-run.".to_string(),
        )),
        _ => None,
    }
}

/// The docker gate every flow shares: present AND reachable AND able to run our containers. The diagnoses —
/// and their prose — live in checks::docker_outcome, so the all-at-once preflight and this hard gate can
/// never drift apart; this joins problem and fix back into the one terminal sentence a bailing flow prints.
pub fn require_daemon() -> Result<()> {
    match crate::checks::check_docker() {
        crate::checks::Outcome::Fail { problem, remedy } => bail!("{problem}\n       {remedy}"),
        _ => Ok(()),
    }
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
///
/// The contract's json form is docker's ARGUMENTS (`["run", "-d", …]`) — only its sh form carries the
/// `docker` word, because that one is text for a shell. Spawning argv[0] as the program would exec `run`.
pub fn run_argv(argv: &[String], log: &Log) -> bool {
    if argv.is_empty() {
        return false;
    }
    // Logged HERE, not by the caller: every caller runs a second, differently-shaped attempt when the first
    // is refused, and a postmortem that shows only the first command describes a launch that never happened.
    log.line(&format!("docker {}", argv.join(" ")));
    let out = match Command::new("docker").args(argv).output() {
        Ok(out) => out,
        // Silence here reads as "docker refused the flags" in every caller's error message, so the one
        // failure that isn't docker's answer at all has to say so.
        Err(err) => {
            log.line(&format!("could not run docker: {err}"));
            return false;
        }
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

/// Run a command IN the container, true when it exited 0. A container that is not running — where exec is
/// refused — answers false, which is what every caller wants: they ask this to confirm something is there,
/// and a stopped sandbox has nothing to confirm.
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
/// newlines and change the overlay's hash), and it too works on a stopped container. `None` when the file
/// landed; otherwise what docker SAID it could not do. The message is the answer, not a nicety: "this sandbox
/// has no such file" and "the copy broke" leave the same exit code behind, and only one of them may be
/// treated as "there is nothing to re-apply" (see `stage_overlay`).
pub fn cp_out(container: &str, path: &str, dest: &std::path::Path) -> Option<String> {
    let out = docker(&[
        "cp",
        &format!("{container}:{path}"),
        &dest.to_string_lossy(),
    ])
    .output();
    match out {
        Ok(out) if out.status.success() => None,
        Ok(out) => Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(err) => Some(format!("could not run docker: {err}")),
    }
}

/// The container's log tail into OUR log — captured before an rm destroys it.
pub fn logs_into(container: &str, tail: &str, log: &Log) {
    if let Ok(out) = docker(&["logs", "--tail", tail, container]).output() {
        log.write(&out.stdout);
        log.write(&out.stderr);
    }
}

/// The container's log tail as text, both streams merged — cloudflared writes to stderr, and the doctor's
/// connector check classifies whatever the process actually said. None when the container is gone.
pub fn logs_tail(container: &str, tail: &str) -> Option<String> {
    let out = docker(&["logs", "--tail", tail, container]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(text)
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

#[cfg(test)]
mod tests {
    use super::wrong_container_platform;

    /* The one decision in this file that is pure, and the one whose absence let a whole class of Windows
     * install failure through: the daemon answers, so every existing probe passes, and the run dies minutes
     * later on an image pull. */

    #[test]
    fn a_linux_daemon_is_what_we_want() {
        assert!(wrong_container_platform(Some("linux")).is_none());
    }

    #[test]
    fn a_windows_daemon_is_refused_with_the_click_that_fixes_it() {
        let (problem, remedy) =
            wrong_container_platform(Some("windows")).expect("windows containers must be refused");
        assert!(
            problem.contains("windows containers"),
            "names what it found: {problem}"
        );
        assert!(
            remedy.contains("Switch to Linux containers"),
            "names the remedy: {remedy}"
        );
    }

    #[test]
    fn an_unidentifiable_daemon_is_not_a_misconfigured_one() {
        // A daemon too old to report Server.Os has done nothing wrong. Refusing what we cannot identify would
        // turn "we could not tell" into "you are misconfigured" — the exact failure this preflight avoids.
        assert!(wrong_container_platform(None).is_none());
    }
}
