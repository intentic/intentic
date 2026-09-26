use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::logfile::Log;
use crate::util::{bail, Fail, Result};

/* The docker CLI as a subprocess — deliberately NOT a docker API crate. */

fn docker(args: &[&str]) -> Command {
    let mut cmd = Command::new("docker");
    cmd.args(args);
    cmd
}

/// Docker Desktop's CLI folder beside `desktop_exe` (empty for unknown) or under the default install root.
#[cfg(windows)]
pub fn program_folder(desktop_exe: &str) -> Option<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = std::path::Path::new(desktop_exe)
        .parent()
        .filter(|_| !desktop_exe.is_empty())
    {
        roots.push(dir.join("resources").join("bin"));
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        roots.push(
            std::path::Path::new(&program_files)
                .join("Docker")
                .join("Docker")
                .join("resources")
                .join("bin"),
        );
    }
    roots
        .into_iter()
        .find(|dir| dir.join("docker.exe").exists())
}

/// Appends `dir` to this process's PATH, which every later `docker` spawn resolves against.
#[cfg(windows)]
pub fn append_to_path(dir: &std::path::Path) {
    let existing = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{existing};{}", dir.display()));
}

/// A PATH inherited before Docker Desktop was installed lacks its CLI, and each `ic` run is a process of its own.
#[cfg(windows)]
pub fn adopt_program_folder() {
    let on_path = std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| dir.join("docker.exe").exists())
    });
    if !on_path {
        if let Some(dir) = program_folder("") {
            append_to_path(&dir);
        }
    }
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

/// Why the daemon could not be reached, in the CLI's own words — `None` when it answered. The same round
/// trip as [`daemon_reachable`], kept separately because the WORDS matter on Windows: "Access is denied" is
/// an engine that is up and refusing this account, which is a different requirement from one that is not
/// running, and nothing but this text tells the two apart.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn daemon_refusal() -> Option<String> {
    let output = docker(&["version", "--format", "{{.Server.Version}}"])
        .stdout(Stdio::null())
        .output();
    match output {
        Ok(output) if output.status.success() => None,
        Ok(output) => Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        Err(error) => Some(format!("could not run docker: {error}")),
    }
}

/// Which kind of container this daemon runs, lowercased — `linux`, or `windows` on a Docker Desktop switched
/// to Windows containers. `docker version` rather than `docker info` for the reason [`daemon_reachable`]
/// gives: same fast round-trip, no CLI-plugin aggregation to hang on.
pub fn server_os() -> Option<String> {
    try_capture(&["version", "--format", "{{.Server.Os}}"])
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

/* A sandbox is a Linux container, and until now nothing on any path asked whether the daemon could run one. */
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

/// What a bounded run left behind: how it ended, and everything it printed.
pub struct Bounded {
    /// The exit code; None when it did not exit on its own (the deadline ended it, or a signal did).
    pub code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Capture a docker command that must not be able to hang the flow: every other capture here waits as long as
/// its child takes. Killing the CLI at the deadline is all this can do, though. A container that a `docker run`
/// started keeps running inside the daemon without it, so a caller that starts one names it and removes it by
/// that name when `timed_out` comes back.
pub fn capture_bounded(args: &[&str], limit: Duration) -> Result<Bounded> {
    bounded(docker(args), limit)
}

/// The deadline itself, for any command: the helper the desktop app shares (`intentic-bounded`), with the child
/// left in ic's own process group so a Ctrl-C at the terminal still reaches it. Output is trimmed at the end,
/// which is how every reader here takes it.
fn bounded(command: Command, limit: Duration) -> Result<Bounded> {
    let program = command.get_program().to_string_lossy().into_owned();
    let ran = intentic_bounded::capture(command, limit, intentic_bounded::Reach::Child)
        .map_err(|err| Fail(format!("could not run {program}: {err}")))?;
    Ok(Bounded {
        code: ran.code,
        timed_out: ran.timed_out,
        stdout: ran.stdout.trim_end().to_string(),
        stderr: ran.stderr.trim_end().to_string(),
    })
}

/// What a streamed command did: its exit, and the tail of what it printed. The log holds all of it, but the
/// log is on the user's machine — `said` is the only copy a caller can put into the sentence it fails with.
pub struct Streamed {
    pub ok: bool,
    pub said: String,
}

/// The tail of a streamed command's output, shared by its two reader threads. Capped at [`SAID_TAIL`] bytes:
/// a pull's chatter is unbounded, and only its last words diagnose a failure.
#[derive(Clone, Default)]
struct Said(std::sync::Arc<std::sync::Mutex<String>>);

const SAID_TAIL: usize = 4096;

impl Said {
    fn push(&self, text: &str) {
        let Ok(mut held) = self.0.lock() else { return };
        held.push_str(text);
        if held.len() > SAID_TAIL {
            // Drop from the front to the next char boundary — a cut through a multi-byte char would panic.
            let mut cut = held.len() - SAID_TAIL;
            while cut < held.len() && !held.is_char_boundary(cut) {
                cut += 1;
            }
            held.drain(..cut);
        }
    }

    fn into_inner(self) -> String {
        self.0
            .lock()
            .map(|held| held.clone())
            .unwrap_or_else(|_| String::new())
    }
}

/// How a streamed command's output reaches the terminal: byte for byte, or as the lines `keep` lets through to `show`.
#[derive(Clone, Copy)]
pub enum Shown {
    Raw,
    Lines {
        keep: fn(&str) -> bool,
        show: fn(&str),
    },
}

/// Live output to the terminal and the log; `ok` is false on a non-zero exit, and the caller decides what that ends.
pub fn stream(args: &[&str], stdin: Option<&[u8]>, shown: Shown, log: &Log) -> Result<Streamed> {
    let mut command = docker(args);
    command
        // Every image's `RUN --mount=type=cache` fails the legacy builder, which a host's `DOCKER_BUILDKIT=0` would pick.
        .env("DOCKER_BUILDKIT", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|err| Fail(format!("could not run docker: {err}")))?;
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .expect("stdin was piped")
            .write_all(input)
            .map_err(|err| Fail(format!("could not write to docker's stdin: {err}")))?;
    }
    let said = Said::default();
    let out_thread = pump(
        child.stdout.take().expect("stdout was piped"),
        std::io::stdout(),
        shown,
        log,
        &said,
    );
    let err_thread = pump(
        child.stderr.take().expect("stderr was piped"),
        std::io::stderr(),
        shown,
        log,
        &said,
    );
    let status = child
        .wait()
        .map_err(|err| Fail(format!("docker did not finish: {err}")))?;
    let _ = out_thread.join();
    let _ = err_thread.join();
    Ok(Streamed {
        ok: status.success(),
        said: said.into_inner(),
    })
}

fn pump(
    from: impl Read + Send + 'static,
    mut terminal: impl Write + Send + 'static,
    shown: Shown,
    log: &Log,
    said: &Said,
) -> std::thread::JoinHandle<()> {
    let (log, said) = (log.clone(), said.clone());
    std::thread::spawn(move || match shown {
        Shown::Raw => tee(from, &log, &mut terminal, &said),
        Shown::Lines { keep, show } => sift(from, &log, keep, show, &said),
    })
}

fn tee(mut from: impl Read, log: &Log, terminal: &mut impl Write, said: &Said) {
    let mut buf = [0u8; 8192];
    while let Ok(read) = from.read(&mut buf) {
        if read == 0 {
            break;
        }
        let _ = terminal.write_all(&buf[..read]);
        let _ = terminal.flush();
        log.write(&buf[..read]);
        said.push(&String::from_utf8_lossy(&buf[..read]));
    }
}

/// Line-buffered because the decision is per LINE and the kernel's read sizes are not: a chunk boundary
/// through the middle of `6e3729cf69e0: Extracting` would leak half a layer report onto the screen and hide
/// the other half. Docker also rewrites its status lines with a carriage return, so those split too.
fn sift(from: impl Read, log: &Log, keep: fn(&str) -> bool, show: fn(&str), said: &Said) {
    let mut reader = std::io::BufReader::new(from);
    let mut pending = Vec::new();
    let mut buf = [0u8; 8192];
    while let Ok(read) = reader.read(&mut buf) {
        if read == 0 {
            break;
        }
        log.write(&buf[..read]);
        said.push(&String::from_utf8_lossy(&buf[..read]));
        pending.extend_from_slice(&buf[..read]);
        while let Some(at) = pending
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r')
        {
            let line = String::from_utf8_lossy(&pending[..at]).into_owned();
            pending.drain(..=at);
            if !line.trim().is_empty() && keep(&line) {
                show(&line);
            }
        }
    }
    let tail = String::from_utf8_lossy(&pending).into_owned();
    if !tail.trim().is_empty() && keep(&tail) {
        show(&tail);
    }
}

/// Execute an argv the run contract printed (`--format json`), all output into the log — the launch itself
/// is silent on success, exactly as `sh "$run_command" >/dev/null 2>>"$LOG"` was.
///
/// The contract's json form is docker's ARGUMENTS (`["run", "-d", …]`) — only its sh form carries the
/// `docker` word, because that one is text for a shell. Spawning argv[0] as the program would exec `run`.
///
/// Err is docker's own refusal, the words a failure message quotes: never the command line, which carries
/// every env pair the launch was given (a runner's pairing token among them) to whoever reads the error.
pub fn run_argv(argv: &[String], log: &Log) -> std::result::Result<(), String> {
    if argv.is_empty() {
        return Err("the run contract printed no docker command.".to_string());
    }
    // Logged HERE, not by the caller: every caller runs a second, differently-shaped attempt when the first
    // is refused, and a postmortem that shows only the first command describes a launch that never happened.
    log.line(&format!("docker {}", argv.join(" ")));
    let out = match Command::new("docker").args(argv).output() {
        Ok(out) => out,
        // Silence here reads as "docker refused the flags" in every caller's error message, so the one
        // failure that isn't docker's answer at all has to say so.
        Err(err) => {
            let said = format!("could not run docker: {err}");
            log.line(&said);
            return Err(said);
        }
    };
    log.write(&out.stdout);
    log.write(&out.stderr);
    if out.status.success() {
        return Ok(());
    }
    Err(refusal_of(&out.stderr)
        .unwrap_or_else(|| format!("docker exited with {} and said nothing.", out.status)))
}

/// Docker's stderr, trimmed, without the usage pointer it appends to every refusal; None when that is all it said.
fn refusal_of(stderr: &[u8]) -> Option<String> {
    let said = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = said
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty() && !line.starts_with("Run 'docker "))
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
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

/// What a container has mounted at `destination`, spelled the way `-v` takes it back; None when nothing is.
/// Read off the container rather than derived from its slug: that is the data its daemon actually runs on,
/// whichever runner created it. Works on a stopped container, like every inspect.
pub fn mount_source(container: &str, destination: &str) -> Option<String> {
    inspect(container, &mount_source_format(destination)).filter(|source| !source.is_empty())
}

/// A named volume answers with its NAME (the path under docker's own data root is not a bind source anyone may
/// hand back), anything else with its host path.
fn mount_source_format(destination: &str) -> String {
    format!(
        "{{{{range .Mounts}}}}{{{{if eq .Destination \"{destination}\"}}}}{{{{if eq .Type \"volume\"}}}}{{{{.Name}}}}{{{{else}}}}{{{{.Source}}}}{{{{end}}}}{{{{end}}}}{{{{end}}}}"
    )
}

pub fn container_exists(name: &str) -> bool {
    ok(&["inspect", name])
}

/// One value out of a container's env, empty read as absent. Works on a stopped container, like the framed read
/// above — and on a doomed one, which is what lets a removal speak for the sandbox before deleting it.
pub fn container_env_value(container: &str, name: &str) -> Option<String> {
    let env = container_env_nul(container).ok()?;
    let text = String::from_utf8_lossy(&env);
    text.split('\0')
        .find_map(|pair| pair.strip_prefix(&format!("{name}=")).map(str::to_string))
        .filter(|value| !value.is_empty())
}

/// `docker ps [-a]` names matching a name filter.
pub fn ps_names(all: bool, name_filter: &str) -> Option<Vec<String>> {
    let filter = format!("name={name_filter}");
    let mut args = vec!["ps"];
    if all {
        args.push("-a");
    }
    args.extend_from_slice(&["--filter", &filter, "--format", "{{.Names}}"]);
    try_capture(&args).map(|names| {
        names
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    })
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

/// The container's log tail straight onto this process's own stdout and stderr, docker's two streams kept apart: what
/// `ic sandbox logs` prints, for a person or for the machine agent reading it back.
pub fn logs_passthrough(container: &str, tail: u32) -> Result<()> {
    let status = docker(&["logs", "--tail", &tail.to_string(), container]).status()?;
    if !status.success() {
        bail!("docker logs {container} failed.");
    }
    Ok(())
}

/// The container's log tail into OUR log — captured before an rm destroys it.
pub fn logs_into(container: &str, tail: &str, log: &Log) {
    if let Ok(out) = docker(&["logs", "--tail", tail, container]).output() {
        log.write(&out.stdout);
        log.write(&out.stderr);
    }
}

/// Why a pull stopped, as docker's own words say it — and every branch here answers a different question:
/// who has to act. Only a registry that refuses the image to everyone is ours; a transfer that broke is
/// nobody's fault and beaten by another attempt, so a failure is never called a packaging fault on the
/// strength of a non-zero exit alone.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PullRefusal {
    /// The registry answered and refuses this package anonymously: it is private, and publishing it is ours.
    Refused,
    /// The registry answered and has no such reference: the tag is missing from the package, also ours.
    Missing,
    /// Docker could not read its own credential store, so nothing reached the registry: the machine's to fix.
    Credentials,
    /// The registry answered and the transfer did not finish: network, and a re-run usually beats it.
    Broken,
}

/// Attempts a broken transfer gets before the flow stops. A pull that dies mid-transfer keeps the layers that
/// finished, so each retry is cheaper than the one before.
const PULL_ATTEMPTS: u32 = 3;

/// Pull a published image, with the recoveries this can make itself: an existing local copy beats a failed
/// pull, a stale `docker login ghcr.io` (Docker Desktop's credential store) makes docker present a dead token
/// instead of pulling anonymously, and a broken transfer is retried. The login is cleared only for a failure
/// shaped like an auth refusal — a user's own ghcr.io login is not a network blip's to throw away.
pub fn pull(image: &str, log: &Log) -> Result<()> {
    log.section(&format!("docker pull {image}"));
    let mut cleared_login = false;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let pulled = pull_once(image, log)?;
        if pulled.ok {
            return Ok(());
        }
        if image_exists(image) {
            crate::ui::warn("pull failed but the image exists locally — using the local copy.");
            return Ok(());
        }
        let refusal = pull_refusal(&pulled.said);
        match refusal {
            PullRefusal::Refused if !cleared_login => {
                cleared_login = true;
                crate::ui::warn(
                    "the registry refused the pull — clearing a stale ghcr.io login and retrying anonymously…",
                );
                quiet(&["logout", "ghcr.io"]);
            }
            PullRefusal::Broken if attempt < PULL_ATTEMPTS => {
                let wait = pull_backoff(attempt);
                crate::ui::warn(&format!(
                    "the download broke before it finished — retrying in {wait}s (attempt {} of {PULL_ATTEMPTS})…",
                    attempt + 1
                ));
                std::thread::sleep(std::time::Duration::from_secs(wait));
            }
            _ => bail!("{}", pull_refusal_message(image, refusal, &pulled.said)),
        }
    }
}

/// Seconds before the next attempt: long enough for a blip to pass, short enough that a person waits it out.
fn pull_backoff(attempt: u32) -> u64 {
    match attempt {
        1 => 3,
        _ => 10,
    }
}

/// Read docker's output for the one distinction that decides who acts. Needles are the registry's own error
/// codes, matched narrowly: Windows' "Access is denied." is a daemon refusing this account, not a registry
/// refusing this package, and must never be read as one.
fn pull_refusal(said: &str) -> PullRefusal {
    let text = said.to_lowercase();
    // Read first: the credential store fails before any registry answer, and its message is the only one
    // carrying these words.
    if text.contains("error getting credentials")
        || text.contains("credential helper")
        || text.contains("credsstore")
    {
        return PullRefusal::Credentials;
    }
    if text.contains("unauthorized")
        || text.contains("authentication required")
        || text.contains("denied:")
        || text.contains("access denied")
        || text.contains("insufficient_scope")
        || text.contains("forbidden")
    {
        return PullRefusal::Refused;
    }
    if text.contains("manifest unknown")
        || text.contains("manifest for")
        || text.contains("repository does not exist")
        || text.contains("name unknown")
    {
        return PullRefusal::Missing;
    }
    PullRefusal::Broken
}

/// The sentence a stopped pull ends on: what happened, who fixes it, and docker's own last line — which is
/// the only trace of the cause that reaches a user whose install log stays on their machine.
fn pull_refusal_message(image: &str, refusal: PullRefusal, said: &str) -> String {
    let body = match refusal {
        PullRefusal::Refused => format!(
            "the registry refused an anonymous pull of {image} — its package is not public, which is a packaging fault on our side, not a problem with your machine. Report it, or if this org is yours make the package public at https://github.com/orgs/intentic/packages, then re-run."
        ),
        PullRefusal::Missing => format!(
            "the registry has no {image} — that reference is missing from the package, which is ours to fix, not a problem with your machine. Report it, then re-run."
        ),
        PullRefusal::Credentials => format!(
            "docker could not read its own saved credentials, so the pull of {image} never reached the registry. Run 'docker logout ghcr.io' (or remove \"credsStore\" from ~/.docker/config.json), then re-run."
        ),
        PullRefusal::Broken => format!(
            "{image} did not finish downloading in {PULL_ATTEMPTS} attempts. The registry answered and the transfer broke, so this is the network between this machine and the registry rather than anything to fix here — re-run when it is steadier: the layers that finished are kept, so the next pull resumes rather than starting over."
        ),
    };
    match docker_last_words(said) {
        Some(words) => format!("{body} Docker said: {words}"),
        None => body,
    }
}

/// Docker's last sentence about the pull, picked out of the layer chatter the readout already absorbed —
/// trimmed to fit a message a person reads. None when docker printed nothing but chatter.
fn docker_last_words(said: &str) -> Option<String> {
    let line = said
        .split(['\n', '\r'])
        .map(str::trim)
        .rfind(|line| !line.is_empty() && !is_layer_chatter(line))?;
    let kept: String = line.chars().take(200).collect();
    Some(if kept.chars().count() < line.chars().count() {
        format!("{kept}…")
    } else {
        kept
    })
}

/// A line the pull readout accounts for: a layer report, the `tag: Pulling from repo` header, or a bare
/// token (an image reference, a digest). Everything else docker prints is a sentence about the pull.
fn is_layer_chatter(line: &str) -> bool {
    let Some((head, rest)) = line.split_once(": ") else {
        return !line.contains(char::is_whitespace);
    };
    (head.len() >= 6 && head.chars().all(|c| c.is_ascii_hexdigit()))
        || rest.starts_with("Pulling from ")
}

/// One attempt. A pipe gets docker's own output byte for byte — it is what an install log has always held,
/// and the desktop app counts those same layer lines for its bar. A terminal gets the count instead.
fn pull_once(image: &str, log: &Log) -> Result<Streamed> {
    let shown = if crate::ui::is_rich() {
        Shown::Lines {
            keep: |line| !crate::ui::pull_line(line),
            show: crate::ui::note,
        }
    } else {
        Shown::Raw
    };
    stream(&["pull", image], None, shown, log)
}

#[cfg(test)]
mod tests {
    use super::{
        docker_last_words, mount_source_format, pull_refusal, pull_refusal_message, refusal_of,
        wrong_container_platform, PullRefusal,
    };

    #[test]
    fn a_mount_is_named_the_way_docker_run_takes_it_back() {
        // Byte for byte the template the /agent-auth replay used before it moved here: the recreate that mounts
        // the shared credentials and the pre-flight that mounts /work and /history read one template.
        assert_eq!(
            mount_source_format("/agent-auth"),
            "{{range .Mounts}}{{if eq .Destination \"/agent-auth\"}}{{if eq .Type \"volume\"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}"
        );
        // The destination is matched exactly, so /work never also answers for a mount at /workspace.
        assert!(mount_source_format("/work").contains("eq .Destination \"/work\"}}"));
    }

    /* THE ONE WAIT IN THIS FILE THAT GIVES UP, exercised on a real child: a probe that never exits must not hold an update with it. */

    #[cfg(unix)]
    #[test]
    fn a_command_past_its_deadline_is_killed_and_what_it_printed_is_kept() {
        let mut hangs = std::process::Command::new("sh");
        // `exec`, so the killed child IS the sleep: a sleep left behind as a grandchild would hold the pipes open.
        hangs.args(["-c", "echo started; exec sleep 30"]);
        let began = std::time::Instant::now();
        let ran = super::bounded(hangs, std::time::Duration::from_millis(300)).expect("sh runs");
        assert!(ran.timed_out);
        assert_eq!(ran.code, None);
        assert_eq!(ran.stdout, "started");
        // Far above the 300ms deadline, far below the 30s the child asked for: a hang bound, not a timing.
        assert!(began.elapsed() < std::time::Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_finishes_in_time_reports_its_exit_and_both_streams() {
        let mut answers = std::process::Command::new("sh");
        answers.args(["-c", "echo '{\"plan\":1}'; echo oops >&2; exit 3"]);
        let ran = super::bounded(answers, std::time::Duration::from_secs(20)).expect("sh runs");
        assert!(!ran.timed_out);
        assert_eq!(ran.code, Some(3));
        assert_eq!(ran.stdout, "{\"plan\":1}");
        assert_eq!(ran.stderr, "oops");
    }

    // Verbatim from a runner launch on Windows whose network was missing.
    #[test]
    fn a_refused_launch_is_quoted_as_docker_said_it_without_the_usage_pointer() {
        let stderr = b"docker: Error response from daemon: failed to set up container networking: network intentic-workspace-runner-omen not found\n\nRun 'docker run --help' for more information\n";
        assert_eq!(
            refusal_of(stderr).as_deref(),
            Some("docker: Error response from daemon: failed to set up container networking: network intentic-workspace-runner-omen not found")
        );
    }

    #[test]
    fn a_launch_refused_in_silence_has_no_words_to_quote() {
        assert_eq!(
            refusal_of(b"\nRun 'docker run --help' for more information\n"),
            None
        );
        assert_eq!(refusal_of(b""), None);
    }

    /* WHO HAS TO ACT, read out of docker's words — the one question a failed pull must not guess at. */

    #[test]
    fn a_registry_that_refuses_the_package_is_ours() {
        assert_eq!(
            pull_refusal("denied: requested access to the resource is denied"),
            PullRefusal::Refused
        );
        assert_eq!(
            pull_refusal("Error response from daemon: unauthorized: authentication required"),
            PullRefusal::Refused
        );
        assert_eq!(
            pull_refusal(
                "pull access denied for x, repository does not exist or may require 'docker login'"
            ),
            PullRefusal::Refused
        );
    }

    #[test]
    fn a_missing_reference_is_ours_too() {
        assert_eq!(
            pull_refusal(
                "manifest for ghcr.io/intentic/sandbox:stable not found: manifest unknown"
            ),
            PullRefusal::Missing
        );
    }

    #[test]
    fn a_transfer_that_broke_is_nobodys_packaging_fault() {
        // Every one of these ended a real pull mid-download. None of them says anything about our registry,
        // and calling them a refusal sends a user to settings they cannot change and did not break.
        for said in [
            "failed to copy: httpReadSeeker: failed open: unexpected status code 503",
            "error pulling image configuration: download failed after attempts=6: dial tcp: i/o timeout",
            "net/http: TLS handshake timeout",
            "read tcp 10.0.0.2:52344->140.82.121.33:443: read: connection reset by peer",
            "failed to register layer: no space left on device",
            "toomanyrequests: retry-after 300s",
        ] {
            assert_eq!(pull_refusal(said), PullRefusal::Broken, "{said}");
        }
    }

    #[test]
    fn a_windows_daemon_refusing_this_account_is_not_a_registry_refusal() {
        // "Access is denied." is the engine refusing this user, one word away from the registry's "denied:".
        assert_eq!(
            pull_refusal(
                "error during connect: in the default daemon configuration on Windows, ... Access is denied."
            ),
            PullRefusal::Broken
        );
    }

    #[test]
    fn a_broken_credential_store_points_at_the_store() {
        let refusal = pull_refusal("error getting credentials - err: exit status 1, out: ``");
        assert_eq!(refusal, PullRefusal::Credentials);
        let message = pull_refusal_message("ghcr.io/intentic/sandbox:stable", refusal, "");
        assert!(message.contains("docker logout ghcr.io"), "{message}");
    }

    #[test]
    fn only_a_real_refusal_sends_a_user_to_our_packaging() {
        let ours = pull_refusal_message(
            "ghcr.io/intentic/sandbox:stable",
            PullRefusal::Refused,
            "denied: requested access to the resource is denied",
        );
        assert!(ours.contains("packaging fault on our side"), "{ours}");
        assert!(
            ours.contains("https://github.com/orgs/intentic/packages"),
            "{ours}"
        );

        let theirs = pull_refusal_message(
            "ghcr.io/intentic/sandbox:stable",
            PullRefusal::Broken,
            "net/http: TLS handshake timeout",
        );
        assert!(!theirs.contains("packaging"), "{theirs}");
        assert!(!theirs.contains("not public"), "{theirs}");
        assert!(theirs.contains("re-run"), "{theirs}");
        // Docker's own line rides along: the install log stays on the user's machine, this message does not.
        assert!(theirs.contains("TLS handshake timeout"), "{theirs}");
    }

    #[test]
    fn dockers_last_words_survive_the_layer_chatter() {
        let said = concat!(
            "stable: Pulling from intentic/sandbox\n",
            "6e3729cf69e0: Pulling fs layer\r",
            "6e3729cf69e0: Downloading [===>   ] 12MB/45MB\r",
            "error pulling image configuration: download failed after attempts=6: i/o timeout\n",
            "c4e6c4d4ab21: Already exists\n",
        );
        assert_eq!(
            docker_last_words(said).as_deref(),
            Some(
                "error pulling image configuration: download failed after attempts=6: i/o timeout"
            )
        );
    }

    #[test]
    fn a_pull_that_printed_only_chatter_says_nothing() {
        assert_eq!(
            docker_last_words(
                "stable: Pulling from intentic/sandbox\nghcr.io/intentic/sandbox:stable\n"
            ),
            None
        );
        assert_eq!(docker_last_words(""), None);
    }

    #[test]
    fn a_long_line_is_cut_where_a_person_stops_reading() {
        let words = docker_last_words(&format!("error: {}", "x".repeat(400)))
            .expect("a sentence is not chatter");
        assert_eq!(words.chars().count(), 201, "200 chars and the ellipsis");
        assert!(words.ends_with('…'), "{words}");
    }

    /* The one decision in this file that is pure, and the one whose absence let a whole class of Windows install failure through: the daemon answers. */

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
