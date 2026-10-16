//! THE KEYRING ON THIS COMPUTER (2026-10-16): This device's Passwords group, through `intentic-machine keyring`.
//!
//! The vault itself is `intentic-keyring`, a process of its own beside the machine agent (_devices/keyring); this app
//! never opens it. Every verb here runs the machine agent's `keyring` command with `--json`, the same producer the
//! terminal uses, and hands its one line of JSON to the webview, which has the schema; restating it in Rust would be one
//! more thing to keep in lockstep (the same reason `machine_report` passes the agent's status through raw).
//!
//! A SECRET NEVER GOES ON A COMMAND LINE. A value being added and the recovery passphrase of a new vault are written to
//! the child's standard input and the pipe closed, never put in argv, where any process of this user could read it,
//! never in an error, never in a log. The argument builders below are pure and tested to prove it: they are not handed
//! the value at all. What reaches stdin is held in a [`Secret`], which zeroes its bytes when it is dropped.
//!
//! Every change on the vault makes the keyring ask the person at this computer (Windows Hello, or its passphrase), so a
//! call can wait on a person for as long as the keyring gives them: two minutes, and a little more here.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::scripts::{self, Host};

type CommandResult<T> = Result<T, String>;

/// How long a read gets (`status`, `list`): the keyring answers those without asking anybody.
const READ_LIMIT: Duration = Duration::from_secs(30);

/// How long a change gets: the keyring may wait two minutes on Windows Hello or its passphrase, and the agent has to
/// start and relay around that.
const CONSENT_LIMIT: Duration = Duration::from_secs(150);

/// How long a finished child's pipes are waited on, the bounded crate's grace: a helper it left behind can hold them.
const DRAIN_GRACE: Duration = intentic_bounded::DRAIN_GRACE;

/// How often a fed child is asked whether it has exited.
const POLL: Duration = Duration::from_millis(25);

/// What the webview is told when this computer's agent has no `keyring` verb: it predates the keyring.
const TOO_OLD: &str =
    "This computer's Intentic agent has no keyring yet. Update the agent, then try again.";

/// A value bound for a child's standard input: zeroed when dropped, and never printed, by Debug or anything else.
pub struct Secret(Vec<u8>);

impl Secret {
    fn bytes(&self) -> &[u8] {
        &self.0
    }

    /// A second copy for the thread that feeds a child, zeroed on its own drop like the first.
    fn copy(&self) -> Secret {
        Secret(self.0.clone())
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Secret(value.into_bytes())
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.fill(0);
        // Keeps the zeroing from being dropped as a dead store on memory about to be freed.
        std::hint::black_box(&self.0);
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// What the Add password form sends. The value is not in here: it travels on its own, to stdin.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewEntry {
    pub name: String,
    /// `password` or `text`; absent is the keyring's own default.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub programs: Vec<String>,
    #[serde(default)]
    pub packages: Vec<String>,
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub any_field: bool,
    #[serde(default)]
    pub username: Option<String>,
    /// Write over an entry of that name rather than be refused.
    #[serde(default)]
    pub replace: bool,
}

/// A keyring entry's name, as `{{secret:NAME}}` carries it: a letter or underscore, then letters, digits, `_`, `.` or
/// `-`, 128 at most (sandbox-contract `KEYRING_NAME_RE`). Checked here because it rides argv, where a name like
/// `--replace` would be read as a flag.
pub fn valid_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let first_ok = chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_');
    let rest_ok =
        chars.all(|next| next.is_ascii_alphanumeric() || next == '_' || next == '.' || next == '-');
    if first_ok && rest_ok && name.len() <= 128 {
        Ok(())
    } else {
        Err(format!(
            "\"{name}\" is not a name the keyring takes: start with a letter or _, then letters, digits, _, . or -."
        ))
    }
}

/// One value of a list flag (a program, a package, a host, a sandbox): something, on one line, that cannot be read as
/// a flag of its own.
fn valid_word(what: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(format!("\"{value}\" is not a {what} the keyring takes."));
    }
    Ok(())
}

fn push_list(
    args: &mut Vec<String>,
    flag: &str,
    what: &str,
    values: &[String],
) -> Result<(), String> {
    for value in values {
        valid_word(what, value)?;
        args.push(flag.to_string());
        args.push(value.trim().to_string());
    }
    Ok(())
}

/// `keyring add NAME --stdin …`: the value is read from stdin, so it is no argument here. Pure.
pub fn add_args(entry: &NewEntry) -> Result<Vec<String>, String> {
    valid_name(&entry.name)?;
    let mut args = vec![
        "keyring".to_string(),
        "add".to_string(),
        entry.name.clone(),
        "--stdin".to_string(),
    ];
    if let Some(kind) = &entry.kind {
        match kind.as_str() {
            "password" | "text" => {
                args.push("--kind".to_string());
                args.push(kind.clone());
            }
            other => {
                return Err(format!(
                    "\"{other}\" is not a kind of entry: password or text."
                ))
            }
        }
    }
    push_list(&mut args, "--program", "program", &entry.programs)?;
    push_list(&mut args, "--package", "package", &entry.packages)?;
    push_list(&mut args, "--host", "host", &entry.hosts)?;
    if entry.any_field {
        args.push("--any-field".to_string());
    }
    if let Some(username) = entry
        .username
        .as_deref()
        .filter(|name| !name.trim().is_empty())
    {
        valid_word("username", username)?;
        args.push("--username".to_string());
        args.push(username.trim().to_string());
    }
    if entry.replace {
        args.push("--replace".to_string());
    }
    args.push("--json".to_string());
    Ok(args)
}

/// `keyring setup --passphrase-stdin`: the recovery passphrase is read from stdin. `hello` off asks the keyring to set
/// up without Windows Hello, the passphrase alone unlocking it. Pure.
pub fn setup_args(hello: bool) -> Vec<String> {
    let mut args = vec![
        "keyring".to_string(),
        "setup".to_string(),
        "--passphrase-stdin".to_string(),
    ];
    if !hello {
        args.push("--no-hello".to_string());
    }
    args.push("--json".to_string());
    args
}

/// `keyring share NAME --sandbox S --mode M`. Pure.
pub fn share_args(name: &str, sandbox: &str, mode: &str) -> Result<Vec<String>, String> {
    valid_name(name)?;
    valid_word("sandbox", sandbox)?;
    if !matches!(mode, "each-use" | "while-here" | "copy") {
        return Err(format!(
            "\"{mode}\" is not a way to share: each-use, while-here or copy."
        ));
    }
    Ok(vec![
        "keyring".to_string(),
        "share".to_string(),
        name.to_string(),
        "--sandbox".to_string(),
        sandbox.trim().to_string(),
        "--mode".to_string(),
        mode.to_string(),
        "--json".to_string(),
    ])
}

/// `keyring unshare NAME --sandbox S`. Pure.
pub fn unshare_args(name: &str, sandbox: &str) -> Result<Vec<String>, String> {
    valid_name(name)?;
    valid_word("sandbox", sandbox)?;
    Ok(vec![
        "keyring".to_string(),
        "unshare".to_string(),
        name.to_string(),
        "--sandbox".to_string(),
        sandbox.trim().to_string(),
        "--json".to_string(),
    ])
}

/// `keyring remove NAME`. Pure.
pub fn remove_args(name: &str) -> Result<Vec<String>, String> {
    valid_name(name)?;
    Ok(vec![
        "keyring".to_string(),
        "remove".to_string(),
        name.to_string(),
        "--json".to_string(),
    ])
}

/// `keyring unlock [--minutes N]`. Pure.
pub fn unlock_args(minutes: Option<u32>) -> Vec<String> {
    let mut args = vec!["keyring".to_string(), "unlock".to_string()];
    if let Some(minutes) = minutes {
        args.push("--minutes".to_string());
        args.push(minutes.to_string());
    }
    args.push("--json".to_string());
    args
}

/// A verb that takes nothing but `--json`: `status`, `list`, `lock`, `upgrade`, `harden`. Pure.
pub fn plain_args(verb: &str) -> Vec<String> {
    vec![
        "keyring".to_string(),
        verb.to_string(),
        "--json".to_string(),
    ]
}

/// `keyring askpass install|uninstall|status`. Pure.
pub fn askpass_args(action: &str) -> Result<Vec<String>, String> {
    if !matches!(action, "install" | "uninstall" | "status") {
        return Err(format!(
            "\"{action}\" is not an askpass action: install, uninstall or status."
        ));
    }
    Ok(vec![
        "keyring".to_string(),
        "askpass".to_string(),
        action.to_string(),
        "--json".to_string(),
    ])
}

/// What one run printed, and how it ended.
#[derive(Debug, PartialEq, Eq)]
pub struct Fed {
    pub code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Read one stream to its end on a thread of its own, reporting on `drained` when it gets there.
fn drain(handle: Option<impl Read + Send + 'static>, drained: Sender<()>) -> Arc<Mutex<Vec<u8>>> {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&bytes);
    std::thread::spawn(move || {
        if let Some(mut handle) = handle {
            let mut chunk = [0u8; 8192];
            while let Ok(read) = handle.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                if let Ok(mut held) = sink.lock() {
                    held.extend_from_slice(&chunk[..read]);
                }
            }
        }
        let _ = drained.send(());
    });
    bytes
}

/// Run `command` with `input` on its standard input, then closed, to its exit or its whole tree killed at `limit`: the
/// bounded crate's `capture` (which closes stdin) with a feed. The input is written on a thread of its own, so a child
/// that does not read it cannot hold this call past its deadline, and a child that refuses at once and closes the pipe
/// is answered with what it said. `Err` only when the child could not be started; the caller's value is left whole, for
/// the next place the program might be.
pub fn capture_fed(mut command: Command, input: &Secret, limit: Duration) -> std::io::Result<Fed> {
    intentic_bounded::own_group(&mut command);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (drained, drains) = channel::<()>();
    let stdout = drain(child.stdout.take(), drained.clone());
    let stderr = drain(child.stderr.take(), drained);
    if let Some(mut stdin) = child.stdin.take() {
        let input = input.copy();
        std::thread::spawn(move || {
            // A child that exits before reading all of it closes the pipe: a broken pipe here is its answer, not ours.
            let _ = stdin.write_all(input.bytes());
            // Dropping both ends the feed (EOF) and zeroes the value.
            drop(stdin);
            drop(input);
        });
    }
    let deadline = Instant::now() + limit;
    let (code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL),
            Ok(None) | Err(_) => {
                let _ = intentic_bounded::kill_tree(child.id(), intentic_bounded::Signal::Kill);
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
        }
    };
    intentic_bounded::await_drain(&drains, 2, DRAIN_GRACE);
    let text = |bytes: &Mutex<Vec<u8>>| {
        String::from_utf8_lossy(&bytes.lock().map(|held| held.clone()).unwrap_or_default())
            .to_string()
    };
    Ok(Fed {
        code,
        timed_out,
        stdout: text(&stdout),
        stderr: text(&stderr),
    })
}

/// The agent's answer as the webview reads it: the last line of its stdout that is a JSON object, which `--json`
/// prints whether the verb succeeded (`{"ok":true,…}`) or was refused (`{"ok":false,"code":…,"refusal":…}`, exit 1).
/// An agent with no `keyring` verb is answered as a refusal of its own, so the webview has one shape to read. Pure.
pub fn answer_of(stdout: &str, stderr: &str) -> Result<String, String> {
    if let Some(line) = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('{'))
    {
        return Ok(line.to_string());
    }
    let said = format!("{stdout}{stderr}");
    if scripts::unknown_verb(&said) {
        return Ok(
            serde_json::json!({ "ok": false, "code": "agent-too-old", "refusal": TOO_OLD })
                .to_string(),
        );
    }
    let said = said.trim();
    Err(if said.is_empty() {
        "the keyring did not answer".to_string()
    } else {
        said.to_string()
    })
}

/// Run one keyring verb against this computer's machine agent, in the places it is installed. `Ok(None)`: there is no
/// machine agent here, an ordinary state. `what` names the command for a sentence about it, and is argv, which never
/// holds a secret.
fn run(args: &[String], input: Option<Secret>, limit: Duration) -> CommandResult<Option<String>> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let what = format!("intentic-machine {}", args.join(" "));
    for candidate in scripts::sync_agent_candidates(Host::current(), home.as_deref()) {
        let mut command = Command::new(&candidate);
        intentic_bounded::no_window(&mut command);
        command.args(args);
        let ran = match &input {
            Some(secret) => capture_fed(command, secret, limit),
            None => intentic_bounded::capture(command, limit, intentic_bounded::Reach::Tree).map(
                |ran| Fed {
                    code: ran.code,
                    timed_out: ran.timed_out,
                    stdout: ran.stdout,
                    stderr: ran.stderr,
                },
            ),
        };
        match ran {
            // Not at this path: the next one, fed the same value.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("{what} would not run: {error}")),
            Ok(fed) if fed.timed_out => {
                return Err(format!(
                    "Nobody answered on this computer within {}s, so nothing changed.",
                    limit.as_secs()
                ))
            }
            Ok(fed) => return answer_of(&fed.stdout, &fed.stderr).map(Some),
        }
    }
    Ok(None)
}

/// A verb whose answer is needed: one the webview only offers once the agent is known to be here.
fn run_present(args: Vec<String>, input: Option<Secret>, limit: Duration) -> CommandResult<String> {
    run(&args, input, limit)?
        .ok_or_else(|| "There is no Intentic agent on this computer.".to_string())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

/// `keyring status --json`, raw. `None`: no machine agent on this computer.
#[tauri::command]
pub async fn keyring_status() -> CommandResult<Option<String>> {
    blocking(|| run(&plain_args("status"), None, READ_LIMIT)).await
}

/// `keyring list --json`, raw: names, rules and shares, never a value.
#[tauri::command]
pub async fn keyring_list() -> CommandResult<String> {
    blocking(|| run_present(plain_args("list"), None, READ_LIMIT)).await
}

/// A new vault, its recovery passphrase on stdin.
#[tauri::command]
pub async fn keyring_setup(passphrase: String, hello: bool) -> CommandResult<String> {
    let secret = Secret::from(passphrase);
    blocking(move || run_present(setup_args(hello), Some(secret), CONSENT_LIMIT)).await
}

/// One entry added, its value on stdin.
#[tauri::command]
pub async fn keyring_add(entry: NewEntry, value: String) -> CommandResult<String> {
    let secret = Secret::from(value);
    blocking(move || run_present(add_args(&entry)?, Some(secret), CONSENT_LIMIT)).await
}

#[tauri::command]
pub async fn keyring_remove(name: String) -> CommandResult<String> {
    blocking(move || run_present(remove_args(&name)?, None, CONSENT_LIMIT)).await
}

#[tauri::command]
pub async fn keyring_share(name: String, sandbox: String, mode: String) -> CommandResult<String> {
    blocking(move || run_present(share_args(&name, &sandbox, &mode)?, None, CONSENT_LIMIT)).await
}

#[tauri::command]
pub async fn keyring_unshare(name: String, sandbox: String) -> CommandResult<String> {
    blocking(move || run_present(unshare_args(&name, &sandbox)?, None, CONSENT_LIMIT)).await
}

#[tauri::command]
pub async fn keyring_unlock(minutes: Option<u32>) -> CommandResult<String> {
    blocking(move || run_present(unlock_args(minutes), None, CONSENT_LIMIT)).await
}

#[tauri::command]
pub async fn keyring_lock() -> CommandResult<String> {
    blocking(|| run_present(plain_args("lock"), None, READ_LIMIT)).await
}

/// `keyring askpass install|uninstall|status`: whether ssh, sudo and git ask the keyring for their passwords.
#[tauri::command]
pub async fn keyring_askpass(action: String) -> CommandResult<String> {
    blocking(move || run_present(askpass_args(&action)?, None, CONSENT_LIMIT)).await
}

/// `keyring harden` (Windows): moves the vault under its own Windows service, one UAC prompt.
#[tauri::command]
pub async fn keyring_harden() -> CommandResult<String> {
    blocking(|| run_present(plain_args("harden"), None, CONSENT_LIMIT)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALUE: &str = "hunter2-correct-horse";

    fn entry() -> NewEntry {
        NewEntry {
            name: "VPN_PASSWORD".to_string(),
            kind: Some("password".to_string()),
            programs: vec!["FortiClient.exe".to_string()],
            packages: vec!["com.fortinet.forticlient".to_string()],
            hosts: vec!["vpn.example.com".to_string()],
            any_field: true,
            username: Some("ann".to_string()),
            replace: true,
        }
    }

    /// The value is read from stdin: the builder is never handed it, and nothing it builds could carry it.
    #[test]
    fn an_added_value_never_reaches_the_command_line() {
        let args = add_args(&entry()).expect("a valid entry");
        assert_eq!(
            args,
            [
                "keyring",
                "add",
                "VPN_PASSWORD",
                "--stdin",
                "--kind",
                "password",
                "--program",
                "FortiClient.exe",
                "--package",
                "com.fortinet.forticlient",
                "--host",
                "vpn.example.com",
                "--any-field",
                "--username",
                "ann",
                "--replace",
                "--json"
            ]
        );
        assert!(args.iter().all(|arg| !arg.contains(VALUE)));
        // A setup's passphrase goes the same way.
        assert_eq!(
            setup_args(true),
            ["keyring", "setup", "--passphrase-stdin", "--json"]
        );
        assert_eq!(
            setup_args(false),
            [
                "keyring",
                "setup",
                "--passphrase-stdin",
                "--no-hello",
                "--json"
            ]
        );
    }

    /// Argv has no shell to escape, but the agent's parser reads a leading dash as a flag: a name or list value that
    /// starts with one is refused rather than becoming `--replace`.
    #[test]
    fn nothing_from_the_form_can_become_a_flag() {
        assert!(add_args(&NewEntry {
            name: "--replace".to_string(),
            ..entry()
        })
        .is_err());
        assert!(add_args(&NewEntry {
            programs: vec!["--any-field".to_string()],
            ..entry()
        })
        .is_err());
        assert!(add_args(&NewEntry {
            hosts: vec!["vpn.example.com\n--replace".to_string()],
            ..entry()
        })
        .is_err());
        assert!(add_args(&NewEntry {
            kind: Some("secret".to_string()),
            ..entry()
        })
        .is_err());
        assert!(share_args("VPN_PASSWORD", "--mode", "copy").is_err());
        assert!(share_args("VPN_PASSWORD", "https://ann.intentic.dev", "always").is_err());
        assert!(askpass_args("--json").is_err());
        assert_eq!(
            share_args("VPN_PASSWORD", " https://ann.intentic.dev ", "each-use").expect("valid"),
            [
                "keyring",
                "share",
                "VPN_PASSWORD",
                "--sandbox",
                "https://ann.intentic.dev",
                "--mode",
                "each-use",
                "--json"
            ]
        );
    }

    #[test]
    fn a_name_is_the_one_a_reference_carries() {
        for name in ["VPN_PASSWORD", "_x", "vpn.password", "a-b.c_d1"] {
            assert!(valid_name(name).is_ok(), "{name}");
        }
        for name in ["", "1abc", "-x", "a b", "a/b", &"a".repeat(129)] {
            assert!(valid_name(name).is_err(), "{name}");
        }
    }

    #[test]
    fn the_answer_is_the_agents_json_line_or_a_refusal_of_its_own() {
        assert_eq!(
            answer_of("starting\n{\"ok\":true,\"entries\":[]}\n", ""),
            Ok("{\"ok\":true,\"entries\":[]}".to_string())
        );
        // Refused with exit 1: still the agent's own line.
        assert_eq!(
            answer_of(
                "{\"ok\":false,\"code\":\"locked\",\"refusal\":\"Locked.\"}",
                ""
            ),
            Ok("{\"ok\":false,\"code\":\"locked\",\"refusal\":\"Locked.\"}".to_string())
        );
        let old = answer_of("", "No command registered for `keyring`").expect("an answer");
        assert!(old.contains("\"code\":\"agent-too-old\""));
        assert_eq!(answer_of("", "  boom \n"), Err("boom".to_string()));
    }

    #[test]
    fn a_secret_says_nothing_of_itself() {
        let secret = Secret::from(VALUE.to_string());
        assert_eq!(format!("{secret:?}"), "Secret(..)");
    }

    /// What was fed arrives on the child's stdin, whole and followed by its end, and not one byte of it on argv.
    #[cfg(unix)]
    #[test]
    fn a_fed_value_arrives_on_stdin_and_nowhere_else() {
        let mut command = Command::new("sh");
        // Prints its own argv, then what came on stdin.
        command.args([
            "-c",
            "printf 'argv:%s\\n' \"$0\" \"$@\"; printf 'stdin:'; cat",
            "keyring",
            "add",
            "X",
        ]);
        let fed = capture_fed(
            command,
            &Secret::from(VALUE.to_string()),
            Duration::from_secs(20),
        )
        .expect("sh runs");
        assert_eq!(fed.code, Some(0));
        let (argv, stdin) = fed.stdout.split_once("stdin:").expect("both halves");
        assert!(!argv.contains(VALUE));
        assert_eq!(stdin, VALUE);
    }

    /// A child that never reads its input, and never exits, is killed at the deadline, the feed with it.
    #[cfg(unix)]
    #[test]
    fn a_fed_child_that_hangs_is_killed_at_its_deadline() {
        let began = Instant::now();
        let mut command = Command::new("sh");
        command.args(["-c", "exec sleep 30"]);
        let fed = capture_fed(
            command,
            &Secret::from("x".repeat(256 * 1024)),
            Duration::from_millis(300),
        )
        .expect("sh runs");
        assert!(fed.timed_out);
        assert!(began.elapsed() < Duration::from_secs(10));
    }
}
