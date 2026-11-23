//! The Windows service: where it lives, what `status` says, and the command line. `scm` installs and runs it, `launch`
//! starts the helper in the console session, `helper` is the helper, `finder` is how the person's remoted reaches it,
//! `admin` runs commands as the signed-in administrator (both the helper's side and `service admin-run`), `secure`
//! holds the access lists, the secret and the Ctrl+Alt+Del policy.

mod admin;
pub mod finder;
pub mod helper;
mod launch;
mod scm;
mod secure;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The service's name in the service manager.
pub const SERVICE: &str = "IntenticRemoted";
const DISPLAY_NAME: &str =
    "Intentic remote access: lock screen, admin prompts and administrator commands";
const DESCRIPTION: &str = "Lets people the owner allowed see and use this computer's sign-in and lock screen, Ctrl+Alt+Del and administrator (UAC) prompts through Intentic, and lets agents the owner allowed run commands as administrator with no prompt while this computer's \"Run commands as administrator\" switch is on. Does nothing while those switches are off. Remove it from Intentic's Remote access section.";

/// `%ProgramData%\Intentic\Remoted`: the service's binary, its configuration, the secret and its log.
/// `INTENTIC_REMOTED_SERVICE_HOME` stands another folder in, for a test that runs the helper by hand without an
/// administrator (the helper is then the user's own process, which sees no secure desktop).
pub fn home() -> PathBuf {
    if let Some(dir) = std::env::var_os("INTENTIC_REMOTED_SERVICE_HOME") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("ProgramData")
        .map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from);
    base.join("Intentic").join("Remoted")
}

/// The binary the service runs: the helper's process must run from it.
pub fn binary() -> PathBuf {
    home().join("bin").join("intentic-remoted.exe")
}

/// The helper's pipe in a session.
pub fn pipe_name(session: u32) -> String {
    format!(r"\\.\pipe\intentic-remoted-desktop-{session}")
}

/// The helper's pipe for administrator runs in a session: its own, with its own protocol ([`crate::service::admin`]).
pub fn admin_pipe_name(session: u32) -> String {
    format!(r"\\.\pipe\intentic-remoted-admin-{session}")
}

/// What `service install` recorded.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub version: String,
    /// The remoted binaries whose processes may connect (the agent's own).
    pub clients: Vec<PathBuf>,
    /// The user they belong to (the owner of the first), who alone may open the pipe and read the secret.
    pub user_sid: String,
    /// `SoftwareSASGeneration` as it was before install set it (None: absent), restored by uninstall.
    pub sas_policy_before: Option<u32>,
    /// Whether install changed it at all.
    pub sas_policy_set: bool,
    /// What this install's helper serves beyond the screen (`admin-run`); empty for one installed before there was more.
    #[serde(default)]
    pub features: Vec<String>,
    /// The sandboxes' keys (base64url of raw Ed25519 public keys) one of which must sign each administrator run's grant:
    /// every key any install pinned (`--trust`), so a second sandbox setting the service up keeps the first's.
    #[serde(default)]
    pub admin_keys: Vec<String>,
}

impl Installed {
    pub fn read() -> Option<Installed> {
        let text = std::fs::read_to_string(home().join("service.json")).ok()?;
        serde_json::from_str(&text).ok()
    }
}

/// What the service writes as its helper changes, for `status` and remoted's `/info`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperState {
    pub session: u32,
    pub pid: u32,
    pub desktop: Option<String>,
}

pub fn read_state() -> Option<HelperState> {
    let text = std::fs::read_to_string(home().join("state.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// `service status`'s answer.
pub fn status() -> serde_json::Value {
    let Some(state) = scm::query() else {
        return serde_json::json!({ "supported": true, "installed": false });
    };
    let installed = Installed::read().unwrap_or_default();
    let helper = (state == "running").then(read_state).flatten();
    serde_json::json!({
        "supported": true,
        "installed": true,
        "state": state,
        "version": installed.version,
        "binary": binary(),
        "clients": installed.clients,
        "helper": helper,
        "adminRuns": installed.features.iter().any(|f| f == crate::service::admin::FEATURE),
        "adminKeys": installed.admin_keys.len(),
    })
}

const USAGE: &str = "\
usage:
  intentic-remoted service status
  intentic-remoted service install --client <path of the person's intentic-remoted.exe> [--client <path>…]
                                   [--trust <sandbox key>…] [--result <file>]
  intentic-remoted service uninstall [--result <file>]
  intentic-remoted service admin-run --status <file> [--cwd <dir>] [--grant <envelope>] -- <program> [<arg>…]
  intentic-remoted service run          (the service manager's)

install needs an administrator; uninstall too, except that the installing user's own remoted may ask the running
service to remove itself (through its helper, so in a session it serves). Each prints one JSON line: the service's
status, or {\"error\": …};
--result writes the same line to a file too, for a caller whose elevated run's output does not come back (UAC).
--trust pins a sandbox's key (base64url of its raw Ed25519 public key), added to those pinned before: an administrator
run must carry a grant one of them signed for exactly its command.

admin-run needs no administrator, only the installing user's own remoted: the service's helper starts <program> with
the signed-in person's administrator token in their session (what Yes on a UAC prompt gives), in <dir> (default: this
process's folder), and this process passes its output on as it comes and exits with its exit code. --status gets one
JSON line before it exits: {\"ran\":true,\"exitCode\":<n>}, or {\"ran\":false,\"reason\":…,\"error\":…} with exit code 125.
--grant is the sandbox's grant for the command (its envelope's JSON), without which the helper refuses it.
";

/// Asks the running service, through the helper of this session, to remove itself, and waits up to 15 s for it to go.
fn uninstall_through_helper() -> Result<(), String> {
    if scm::query().is_none() {
        return Ok(());
    }
    let finder = finder::finder().ok_or("the helper is switched off here")?;
    let link = finder
        .link()
        .ok_or("the helper is not reachable from this session")?;
    link.uninstall()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        if scm::query().is_none() {
            // The folder goes a few seconds after the service ended.
            std::thread::sleep(std::time::Duration::from_secs(5));
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    Err("the service did not go within 15 s".into())
}

pub fn cli(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("admin-run") {
        return admin::cli(&args[1..]);
    }
    let mut clients = Vec::new();
    let mut trust: Vec<String> = Vec::new();
    let mut result: Option<PathBuf> = None;
    let mut rest = args.iter().skip(1);
    while let Some(arg) = rest.next() {
        match (arg.as_str(), rest.next()) {
            ("--client", Some(path)) => clients.push(PathBuf::from(path)),
            ("--trust", Some(key)) => trust.push(key.clone()),
            ("--result", Some(path)) => result = Some(PathBuf::from(path)),
            _ => {
                eprint!("unknown argument {arg:?}\n{USAGE}");
                return 2;
            }
        }
    }
    let say = |code: i32, line: serde_json::Value| {
        println!("{line}");
        if let Some(path) = &result {
            let _ = std::fs::write(path, format!("{line}\n"));
        }
        code
    };
    let fail = |code: i32, words: String| say(code, serde_json::json!({ "error": words }));
    match args.first().map(String::as_str) {
        Some("status") => say(0, status()),
        Some("install") => {
            if clients.is_empty() {
                return fail(2, "install takes --client".into());
            }
            if let Some(bad) = trust.iter().find(|k| !crate::service::admin::valid_key(k)) {
                return fail(
                    2,
                    format!(
                        "--trust {bad:?} is not a sandbox key: base64url without padding (43 characters) of a 32-byte Ed25519 public key"
                    ),
                );
            }
            if !secure::elevated() {
                return fail(3, "needs an administrator".into());
            }
            match scm::install(&clients, &trust) {
                Ok(()) => say(0, status()),
                Err(e) => fail(1, e),
            }
        }
        Some("uninstall") => {
            if !secure::elevated() {
                // The installing user's own remoted may ask the service to remove itself through its helper.
                return match uninstall_through_helper() {
                    Ok(()) => say(0, status()),
                    Err(why) => fail(3, format!("needs an administrator ({why})")),
                };
            }
            match scm::uninstall() {
                Ok(()) => say(0, status()),
                Err(e) => fail(1, e),
            }
        }
        Some("run") => scm::run(),
        _ => {
            eprint!("{USAGE}");
            2
        }
    }
}
