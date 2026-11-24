use serde_json::Value;

use super::model::Stage;
use crate::docker;
use crate::sandbox::inside::{self, Read};
use crate::sandbox::{compose, container_of, takeover};

/* SANDBOXES ANOTHER HAND RUNS (2026-11-11). Two kinds of sandbox are not this machine's to start, whoever runs the fix:

ON STANDBY. The platform names one active host per sandbox (api active-host.ts), and a copy told it is not that host
writes `/history/.ic/standby.json` (the daemon's standby.ts) and stands down. The keeper used to read such a copy as one
that stopped answering and start it again, and the machine it moved away from kept a stale copy fighting the real one
for its address. Now a copy on standby is settled as `elsewhere`, stopped as `ic sandbox stop` stops it (held, so no
sweep starts it again), and left so until a person runs `ic sandbox claim` here, whose takeover marker overrides it.

COMPOSE'S. A container Docker Compose made (a Komodo stack) is started and stopped by Compose: Compose's own `stop`
ends in a SIGKILL after ten seconds, an exit 137 the keeper read as a crash and undid. An unattended run never starts
one; it says so, naming the folder Compose's file is in. A running one is checked as any other. */

/// Why a sandbox is left to another hand.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Away {
    /// This copy is on standby: `host` (as the platform named it) runs the sandbox.
    Standby { host: Option<String>, running: bool },
    /// Docker Compose runs it from `working_dir`, and it does not run now.
    Compose { working_dir: Option<String> },
}

/// What was read off one container. `standby` is the file's content when it holds one.
#[derive(Clone, Debug, Default)]
pub struct Seen {
    pub standby: Option<Value>,
    pub takeover_pending: bool,
    pub compose_owned: bool,
    pub working_dir: Option<String>,
    pub running: bool,
}

/// Whether, and why, a sandbox is left to another hand: on standby with no takeover waiting, whoever runs the fix;
/// Compose's and not running, for an unattended run (`auto`). A person who runs the fix on a Compose sandbox is asking
/// for it to run. Pure.
pub fn away(seen: &Seen, auto: bool) -> Option<Away> {
    if let Some(standby) = seen.standby.as_ref().filter(|_| !seen.takeover_pending) {
        let host = standby["activeHost"]["host"]
            .as_str()
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .map(str::to_string);
        return Some(Away::Standby {
            host,
            running: seen.running,
        });
    }
    (auto && seen.compose_owned && !seen.running).then(|| Away::Compose {
        working_dir: seen.working_dir.clone(),
    })
}

/// The sentence a person and the report read. Pure.
pub fn sentence(away: &Away, slug: &str) -> String {
    match away {
        Away::Standby { host, .. } => format!(
            "on standby: {} runs this sandbox, so this copy stays stopped. To run it here instead: ic sandbox claim {slug}",
            host.as_deref().unwrap_or("another machine")
        ),
        Away::Compose { working_dir } => format!(
            "managed by Docker Compose{}: it is started with `docker compose up -d` there, never by the machine agent.",
            working_dir
                .as_deref()
                .map(|dir| format!(" (its file is in {dir})"))
                .unwrap_or_default()
        ),
    }
}

/// The `--json` answer for a sandbox left to another hand: settled (`elsewhere`, which the machine agent's keeper reads
/// as nothing to do, ever), with nothing checked. Pure.
pub fn report(away: &Away, slug: &str) -> Value {
    let mut report = serde_json::json!({
        "stage": Stage::Done.wire(),
        "outcome": "elsewhere",
        "doing": sentence(away, slug),
        "checks": [],
    });
    match away {
        Away::Standby { host, .. } => report["standby"] = serde_json::json!({ "activeHost": host }),
        Away::Compose { working_dir } => {
            report["compose"] = serde_json::json!({ "workingDir": working_dir });
        }
    }
    report
}

/// Read what decides it off the sandbox's container; None when there is no container to read.
pub fn look(slug: &str) -> Option<Seen> {
    let container = container_of(slug);
    if !docker::container_exists(&container) {
        return None;
    }
    let standby = match inside::read(&container, takeover::STANDBY_PATH) {
        Read::Found(value) => Some(value),
        Read::Missing | Read::Unreadable(_) => None,
    };
    let takeover_pending = standby.is_some() && takeover::pending(&container);
    let labels = compose::labels_of(&container);
    Some(Seen {
        standby,
        takeover_pending,
        compose_owned: compose::owns(&labels),
        working_dir: compose::working_dir(&labels).map(str::to_string),
        running: inside::running(&container),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn standby(host: &str) -> Option<Value> {
        Some(
            json!({ "v": 1, "since": 1, "activeHost": { "host": host, "manager": "compose", "since": "x" }, "activeEpoch": 2 }),
        )
    }

    #[test]
    fn a_copy_on_standby_is_left_whoever_runs_the_fix() {
        let seen = Seen {
            standby: standby("z440"),
            running: true,
            ..Seen::default()
        };
        let expected = Away::Standby {
            host: Some("z440".into()),
            running: true,
        };
        assert_eq!(away(&seen, true), Some(expected.clone()));
        assert_eq!(away(&seen, false), Some(expected));
    }

    // `ic sandbox claim` wrote a takeover the daemon has not sent yet: the copy is the one asked to run, not a standby.
    #[test]
    fn a_waiting_takeover_overrides_standby() {
        let seen = Seen {
            standby: standby("z440"),
            takeover_pending: true,
            ..Seen::default()
        };
        assert_eq!(away(&seen, true), None);
    }

    #[test]
    fn a_stopped_compose_sandbox_is_never_started_unattended() {
        let seen = Seen {
            compose_owned: true,
            working_dir: Some("/etc/komodo/stacks/translations".into()),
            ..Seen::default()
        };
        assert_eq!(
            away(&seen, true),
            Some(Away::Compose {
                working_dir: Some("/etc/komodo/stacks/translations".into())
            })
        );
        // A person asked for it to run; a running one is checked as any other.
        assert_eq!(away(&seen, false), None);
        assert_eq!(
            away(
                &Seen {
                    running: true,
                    ..seen
                },
                true
            ),
            None
        );
        assert_eq!(away(&Seen::default(), true), None);
    }

    #[test]
    fn the_report_is_settled_and_names_where_it_runs() {
        let compose = Away::Compose {
            working_dir: Some("/srv/stack".into()),
        };
        let line = report(&compose, "sandbox-850b3ad46a90");
        assert_eq!(line["outcome"], "elsewhere");
        assert_eq!(line["compose"]["workingDir"], "/srv/stack");
        assert!(line["doing"].as_str().unwrap().contains("/srv/stack"));
        let standing = Away::Standby {
            host: None,
            running: false,
        };
        let line = report(&standing, "sandbox-850b3ad46a90");
        assert_eq!(line["outcome"], "elsewhere");
        assert!(line["doing"]
            .as_str()
            .unwrap()
            .contains("ic sandbox claim sandbox-850b3ad46a90"));
    }
}
