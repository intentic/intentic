use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::sandbox::inside;

/* WHY THE SANDBOX IS ABOUT TO GO DOWN, told to the sandbox before it does. From inside, a restart ic makes reads like
any other: the daemon's next boot finds itself started again and cannot tell a person's `ic sandbox restart` from the
keeper's repair, an update, or a crash, and an agent reading the sandbox's logs afterwards cannot either (in one
incident ic on Windows and ic in WSL both kept the same sandbox, and nothing said which restarted it or why). So before
ic stops, restarts or recreates a running sandbox it leaves `/history/logs/restart-intent.json` on the sandbox's own
volume: who acted (`ic`, or `keeper` when the machine agent's unattended round ran it), on which machine and which side
of it, what it is about to do, and the specific reason, down to the check that failed and what it found. The daemon
reads it on its next boot and records the restart against it; `ic sandbox doctor --json` shows the last one.

Best-effort and bounded by construction: the act is the point, so a container too wedged to take the file costs at
most a few seconds and never the act itself. */

pub const FILE: &str = "/history/logs/restart-intent.json";

/// How long leaving the file may hold up the act it explains.
const BUDGET: Duration = Duration::from_secs(3);

/// The longest reason written: a sentence and its evidence, never a log.
const REASON_MAX: usize = 1000;

/// What ic is about to do to the container, in the file's words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Restart,
    Stop,
    Update,
    /// Onto another version that is not the channel's newest: a rollback, or going back from a failed update.
    Swap,
    Reshape,
    /// The same sandbox, set up again (a connect that replaces it).
    Recreate,
    Rebuild,
}

impl Action {
    pub fn wire(self) -> &'static str {
        match self {
            Action::Restart => "restart",
            Action::Stop => "stop",
            Action::Update => "update",
            Action::Swap => "swap",
            Action::Reshape => "reshape",
            Action::Recreate => "recreate",
            Action::Rebuild => "rebuild",
        }
    }
}

static KEEPER: AtomicBool = AtomicBool::new(false);

/// This run is the machine agent's unattended round (its keeper, sleep or watch): every intent it leaves says so.
pub fn by_keeper() {
    KEEPER.store(true, Ordering::SeqCst);
}

fn by() -> &'static str {
    if KEEPER.load(Ordering::SeqCst) {
        "keeper"
    } else {
        "ic"
    }
}

/// Why the act a caller is about to start happens, said by whoever knows it (the fix engine knows which check failed and
/// what it found; the verb it calls only knows its own name).
struct Because {
    reason: String,
    checks: Vec<String>,
}

static BECAUSE: Mutex<Option<Because>> = Mutex::new(None);

/// The reason every intent left while this is held gives instead of its verb's own sentence. The innermost holder
/// knows best (the probation watch's own going back, inside the fix engine's repair that ran it); dropped, the reason
/// held before it is back.
pub struct Reason(Option<Because>);

impl Reason {
    pub fn hold(reason: impl Into<String>, checks: &[&str]) -> Reason {
        let next = Because {
            reason: reason.into(),
            checks: checks.iter().map(|check| check.to_string()).collect(),
        };
        let before = BECAUSE.lock().ok().and_then(|mut held| held.replace(next));
        Reason(before)
    }
}

impl Drop for Reason {
    fn drop(&mut self) {
        if let Ok(mut held) = BECAUSE.lock() {
            *held = self.0.take();
        }
    }
}

/// The side of the machine this ic runs on, in the file's words: `windows`, `wsl` (any distro, or WSL unnamed),
/// `mac`, or `linux`. Pure.
pub fn side_word(platform: &str, env: Option<&str>) -> &'static str {
    match (platform, env) {
        ("windows", _) => "windows",
        (_, Some("macos")) => "mac",
        (_, Some("linux")) => "linux",
        // Inside WSL the environment is the distro's name, or unknown when WSL did not start the process itself.
        ("linux", _) => "wsl",
        _ => "linux",
    }
}

/// The file's JSON, its moment left for `inside` to fill in. Pure.
pub fn body(
    action: Action,
    reason: &str,
    checks: &[String],
    by: &str,
    host: &str,
    side: &str,
) -> Value {
    let mut reason: String = reason.trim().to_string();
    if reason.chars().count() > REASON_MAX {
        reason = reason.chars().take(REASON_MAX - 1).collect();
        reason.push('…');
    }
    let mut body = json!({
        "at": inside::NOW_ISO,
        "by": by,
        "host": host,
        "side": side,
        "action": action.wire(),
        "reason": reason,
    });
    if !checks.is_empty() {
        body["checks"] = json!(checks);
    }
    body
}

/// Before ic stops, restarts or recreates `container`: say why, on its volume. `reason` is the verb's own sentence,
/// used when no caller holds a more specific [`Reason`]. Nothing for a container that does not exist. Returns whether
/// the file was left.
pub fn leave(container: &str, action: Action, reason: &str) -> bool {
    let (reason, checks) = match BECAUSE.lock().ok().as_deref().and_then(Option::as_ref) {
        Some(because) => (because.reason.clone(), because.checks.clone()),
        None => (reason.to_string(), Vec::new()),
    };
    let here = crate::sandbox::side::here();
    let body = body(
        action,
        &reason,
        &checks,
        by(),
        &crate::sandbox::connect::machine_label(),
        side_word(&here.platform, here.env.as_deref()),
    );
    inside::write_stamped_within(container, FILE, &body, BUDGET).is_some()
}

/// The last intent left on a sandbox's volume, for `ic sandbox doctor --json`; None when there is none to read.
pub fn last(container: &str) -> Option<Value> {
    match inside::read(container, FILE) {
        inside::Read::Found(value) => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_intent_names_who_where_what_and_why_with_the_moment_as_a_date() {
        let checks = vec!["daemon".to_string()];
        let written = inside::stamp(
            &body(
                Action::Restart,
                " Restarting the sandbox, because Daemon health: /health did not answer in 10 s ",
                &checks,
                "keeper",
                "omen",
                "wsl",
            )
            .to_string(),
            1_791_240_330_000,
        );
        let parsed: Value = serde_json::from_str(&written).expect("JSON");
        assert_eq!(
            parsed,
            json!({
                "at": "2026-10-05T22:45:30.000Z",
                "by": "keeper",
                "host": "omen",
                "side": "wsl",
                "action": "restart",
                "reason": "Restarting the sandbox, because Daemon health: /health did not answer in 10 s",
                "checks": ["daemon"],
            })
        );
    }

    #[test]
    fn no_checks_leaves_the_field_out_and_a_long_reason_is_cut() {
        let long = "x".repeat(REASON_MAX + 50);
        let parsed = body(Action::Swap, &long, &[], "ic", "pc", "windows");
        assert!(parsed.get("checks").is_none());
        assert_eq!(parsed["action"], "swap");
        let reason = parsed["reason"].as_str().expect("a reason");
        assert_eq!(reason.chars().count(), REASON_MAX);
        assert!(reason.ends_with('…'));
    }

    #[test]
    fn each_side_of_a_machine_has_its_word() {
        assert_eq!(side_word("windows", Some("windows")), "windows");
        assert_eq!(side_word("linux", Some("archlinux")), "wsl");
        assert_eq!(side_word("linux", None), "wsl");
        assert_eq!(side_word("linux", Some("linux")), "linux");
        assert_eq!(side_word("linux", Some("macos")), "mac");
    }

    #[test]
    fn a_held_reason_gives_way_to_an_inner_one_and_is_forgotten_when_dropped() {
        let reason = || {
            BECAUSE
                .lock()
                .expect("lock")
                .as_ref()
                .map(|because| (because.reason.clone(), because.checks.clone()))
        };
        {
            let _outer = Reason::hold("because the check failed", &["container"]);
            {
                let _inner = Reason::hold("the watch went back", &[]);
                assert_eq!(reason(), Some(("the watch went back".to_string(), vec![])));
            }
            assert_eq!(
                reason(),
                Some((
                    "because the check failed".to_string(),
                    vec!["container".to_string()]
                ))
            );
        }
        assert_eq!(reason(), None);
    }
}
