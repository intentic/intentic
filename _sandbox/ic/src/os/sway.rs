use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;

use super::{tool, Paths};
use crate::util::{bail, Result};

/* THE SCREEN, AS THE SETTINGS VERBS REACH IT. The desktop edition's screen is a sway session of the `intentic` user
(_os/os-image/desktop), and these verbs change it through sway's IPC with `swaymsg`, as any Linux desktop's settings
would. The machine agent that runs them starts at boot, before anyone's session and with no SWAYSOCK of its own, so
the socket is found the way sway names it: `sway-ipc.<uid>.<pid>.sock` in the session's runtime folder, the newest
whose sway still runs. What a person sets here is also written under /etc/intentic/sway.d, which the session's config
includes, so it holds at the next start; the folder belongs to the `intentic` user's group for that
(tmpfiles.d/intentic-os-desktop.conf).

The server edition has no screen: there the screen verbs stop with exit code 4 and say so, which callers tell apart
from a failure. */

/// The exit code of a screen verb on an edition with no screen (the contract's IC_OS_NO_SCREEN_EXIT).
pub const NO_SCREEN: i32 = 4;

/// What swaymsg is given to answer: sway answers from memory.
const SWAYMSG_LIMIT: Duration = Duration::from_secs(10);

/// The folder sway's settings are written to, which the session's config includes (`include /etc/intentic/sway.d/*`).
pub fn settings_dir(paths: &Paths) -> PathBuf {
    paths.at("/etc/intentic/sway.d")
}

/// Stop with exit code 4 unless this machine is the edition with a screen.
pub fn require_screen() -> Result<()> {
    let paths = Paths::here();
    if super::has_screen(&paths) {
        return Ok(());
    }
    let release = super::release(&paths)?;
    let edition = release["edition"].as_str().unwrap_or_default();
    if edition != "desktop" {
        tool::exit_with(
            NO_SCREEN,
            &format!(
                "This machine is the {} edition of Intentic OS, which has no screen to set.",
                if edition.is_empty() {
                    "server"
                } else {
                    edition
                }
            ),
        );
    }
    Ok(())
}

/// The pid in a socket's name, `sway-ipc.<uid>.<pid>.sock`. Pure.
pub fn socket_pid(file_name: &str) -> Option<u32> {
    let rest = file_name.strip_prefix("sway-ipc.")?.strip_suffix(".sock")?;
    let (uid, pid) = rest.split_once('.')?;
    uid.parse::<u32>().ok()?;
    pid.parse().ok()
}

/// One socket file found: its path, when it was made, and whether the sway that made it still runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub path: PathBuf,
    pub made: SystemTime,
    pub alive: bool,
}

/// The socket of the running sway: the newest of those whose sway still runs (a crashed session leaves its socket
/// behind, and the kiosk session restarts). Pure.
pub fn pick_socket(candidates: &[Candidate]) -> Option<PathBuf> {
    candidates
        .iter()
        .filter(|candidate| candidate.alive)
        .max_by_key(|candidate| candidate.made)
        .map(|candidate| candidate.path.clone())
}

/// Whether `pid` is a running sway.
fn is_sway(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .is_ok_and(|comm| comm.trim().starts_with("sway"))
}

/// The sockets in a runtime folder.
fn candidates(dir: &Path) -> Vec<Candidate> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let pid = socket_pid(name.to_str()?)?;
            let made = entry.metadata().and_then(|meta| meta.modified()).ok()?;
            Some(Candidate {
                path: entry.path(),
                made,
                alive: is_sway(pid),
            })
        })
        .collect()
}

/// The running sway's socket: SWAYSOCK when this process was started inside the session (the app is) and it is still
/// there, else the newest live one in the session's runtime folder. None while no screen session runs.
pub fn socket() -> Option<PathBuf> {
    if let Some(sock) = std::env::var_os("SWAYSOCK")
        .filter(|sock| !sock.is_empty())
        .map(PathBuf::from)
        .filter(|sock| sock.exists())
    {
        return Some(sock);
    }
    let dir = PathBuf::from(tool::session_runtime_dir(tool::uid()));
    pick_socket(&candidates(&dir))
}

/// The socket, or the stop for a screen whose session is not running (before sign-in, or between restarts).
pub fn require_socket() -> Result<PathBuf> {
    match socket() {
        Some(socket) => Ok(socket),
        None => bail!("The screen's session is not running right now, so the screen cannot be read or set. It starts with the machine; try again in a moment."),
    }
}

/// `swaymsg -t <kind>`, read: `get_outputs`, `get_inputs`.
pub fn get(socket: &Path, kind: &str) -> Result<Value> {
    let socket = socket.to_string_lossy();
    let said = tool::capture("swaymsg", &["-s", &socket, "-r", "-t", kind], SWAYMSG_LIMIT)?;
    serde_json::from_str(&said).map_err(|err| {
        crate::util::Fail(format!(
            "swaymsg -t {kind} answered what is not JSON: {err}"
        ))
    })
}

/// What sway answered a run of commands: Err with the first refusal's own words. Pure.
pub fn replies_ok(said: &str) -> std::result::Result<(), String> {
    let replies: Value =
        serde_json::from_str(said).map_err(|_| format!("sway answered: {}", said.trim()))?;
    let Some(replies) = replies.as_array() else {
        return Err(format!("sway answered: {}", said.trim()));
    };
    match replies.iter().find(|reply| reply["success"] != true) {
        None => Ok(()),
        Some(refused) => Err(refused["error"]
            .as_str()
            .unwrap_or("sway refused it")
            .to_string()),
    }
}

/// Run sway commands (joined with `;`, each answered in turn), and fail with sway's own words when one is refused.
/// swaymsg exits non-zero then, with the replies still on stdout.
pub fn command(socket: &Path, commands: &[String]) -> Result<()> {
    let socket = socket.to_string_lossy();
    let joined = commands.join("; ");
    let ran =
        crate::docker::run_bounded("swaymsg", &["-s", &socket, "-r", &joined], SWAYMSG_LIMIT)?;
    if ran.timed_out {
        bail!("sway did not answer within {}s.", SWAYMSG_LIMIT.as_secs());
    }
    replies_ok(&ran.stdout).map_err(|err| {
        if ran.stdout.trim().is_empty() {
            crate::util::Fail(tool::last_words(&ran.stdout, &ran.stderr, "swaymsg"))
        } else {
            crate::util::Fail(err)
        }
    })
}

/// A JSON number as people write it: whole numbers without a fraction (sway's `2.0` scale is `2`), the rest to three
/// decimals. Pure.
pub fn number(value: f64) -> Value {
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded.fract() == 0.0 && rounded.abs() < 1e15 {
        Value::from(rounded as i64)
    } else {
        Value::from(rounded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_socket_names_the_sway_that_made_it() {
        assert_eq!(socket_pid("sway-ipc.1990.2412.sock"), Some(2412));
        assert_eq!(socket_pid("sway-ipc.0.1127311.sock"), Some(1127311));
        assert_eq!(socket_pid("sway-ipc.1990.sock"), None);
        assert_eq!(socket_pid("wayland-1"), None);
        assert_eq!(socket_pid("sway-ipc.x.1.sock"), None);
    }

    #[test]
    fn the_newest_live_socket_is_the_screens_and_a_dead_one_never_is() {
        let at = |secs: u64| SystemTime::UNIX_EPOCH + Duration::from_secs(secs);
        let candidate = |name: &str, secs: u64, alive: bool| Candidate {
            path: PathBuf::from(format!("/run/user/1990/{name}")),
            made: at(secs),
            alive,
        };
        let found = [
            candidate("sway-ipc.1990.100.sock", 100, true),
            candidate("sway-ipc.1990.300.sock", 300, false),
            candidate("sway-ipc.1990.200.sock", 200, true),
        ];
        assert_eq!(
            pick_socket(&found),
            Some(PathBuf::from("/run/user/1990/sway-ipc.1990.200.sock"))
        );
        assert_eq!(pick_socket(&found[1..2]), None);
        assert_eq!(pick_socket(&[]), None);
    }

    /// The replies recorded from sway 1.10.1 (headless): a command taken, and a keymap xkb could not build.
    #[test]
    fn a_refusal_is_said_in_sways_own_words() {
        assert_eq!(
            replies_ok(r#"[{"success": true}, {"success": true}]"#),
            Ok(())
        );
        assert_eq!(
            replies_ok(
                r#"[{"success": true}, {"success": false, "parse_error": false, "error": "Failed to compile keymap: [XKB-338] Couldn't find file \"symbols/zz\" in include paths"}]"#
            ),
            Err("Failed to compile keymap: [XKB-338] Couldn't find file \"symbols/zz\" in include paths".to_string())
        );
        assert!(replies_ok("not json").is_err());
        assert!(replies_ok("{}").is_err());
    }

    #[test]
    fn numbers_read_as_people_write_them() {
        assert_eq!(number(2.0), json!(2));
        assert_eq!(number(1.5), json!(1.5));
        assert_eq!(number(59.999), json!(59.999));
        assert_eq!(number(59.9994), json!(59.999));
        assert_eq!(number(60.0), json!(60));
    }

    #[test]
    fn settings_go_where_the_session_includes_them() {
        assert_eq!(
            settings_dir(&Paths::under(Path::new("/tmp/os"))),
            Path::new("/tmp/os/etc/intentic/sway.d")
        );
    }
}
