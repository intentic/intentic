use std::time::{Duration, Instant};

use crate::docker;
use crate::logfile::Log;
use crate::util::{bail, Result};

/* The two waits after a launch, in order — because a daemon that ANSWERS is not yet a daemon that SERVES. */

const HEALTH_URL: &str = "http://localhost:8787/health";

/// How long the readiness wait holds. A clock rather than a count of reads: while its daemon restarts, the
/// front holds a request for up to half a minute before answering 503, so a count could stretch into an hour.
const READY_BUDGET: Duration = Duration::from_secs(120);

/// How long an open state journal may take to commit before the swap is undone. Longer than the plain wait,
/// since the journal only opens on an update that converts files, and a slow first boot after one is still a
/// healthy boot; rolling it back would undo work that was about to succeed.
const JOURNAL_BUDGET: Duration = Duration::from_secs(600);

/// Returns the first answer, which the readiness wait reads too (see [`wait_ready`]).
pub fn wait_answering(container: &str, log: &Log, remedy: &str) -> Result<String> {
    for _ in 0..15 {
        if let Some(answer) = docker::exec_capture(container, &["curl", "-sf", HEALTH_URL]) {
            return Ok(answer);
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    log.section(&format!("container logs ({container})"));
    docker::logs_into(container, "500", log);
    bail!(
        "the sandbox did not become healthy within 30s — its logs are saved to {}.{remedy}",
        log.path.display()
    );
}

/// The readiness gate: hold until `"ready":true`, echoing the running boot step's label as it changes — the
/// same chain the browser's warm-up screen shows. No hard failure: a slow boot is a slow boot, not a broken
/// sandbox, and the daemon is already reachable; past two minutes say so and hand the prompt back. A daemon
/// too old to report a boot answers neither field, which reads as "ready" — the old single-wait behaviour.
///
/// One answer makes it a hard gate: a state journal reported open (see [`Readiness`]). A journal still open
/// when the budget runs out is the Err a caller rolls back on. `answered` is what `wait_answering` got back.
pub fn wait_ready(container: &str, answered: &str) -> Result<()> {
    let mut readiness = Readiness::default();
    // A daemon that opened its journal and fell over before the first read below would otherwise answer
    // nothing, and pass for one too old to report anything.
    if let Ok(first) = serde_json::from_str::<serde_json::Value>(answered) {
        readiness.note(&first);
    }
    let started = Instant::now();
    let mut last_step = String::new();
    loop {
        let health =
            docker::exec_capture(container, &["curl", "-sf", HEALTH_URL]).unwrap_or_default();
        let parsed = serde_json::from_str::<serde_json::Value>(&health).ok();
        if readiness.admits(parsed.as_ref()) {
            return Ok(());
        }
        if let Some(step) = parsed.as_ref().and_then(running_step) {
            if step != last_step {
                // The boot chain names its own steps; they are detail under the wait, never steps of their
                // own — a terminal shows the newest beside the spinner, a pipe gets one line each as before.
                crate::ui::detail(&step);
                if !crate::ui::is_rich() {
                    println!("intentic:   {step}…");
                }
                last_step = step;
            }
        }
        let budget = if readiness.journal_seen {
            JOURNAL_BUDGET
        } else {
            READY_BUDGET
        };
        if started.elapsed() >= budget {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    if readiness.journal_open {
        bail!(
            "the new version never finished converting the workspace state: its state journal was still open {}s after it started answering.",
            JOURNAL_BUDGET.as_secs()
        );
    }
    crate::ui::warn(&format!(
        "the daemon is still warming up after 2 minutes — it keeps going in the background.\nWatch it with: docker logs -f {container}"
    ));
    Ok(())
}

/// What one readiness wait has learned from the answers so far.
///
/// A daemon reports its state journal open from its start until it commits the conversions a new version
/// made, right after its readiness gate opens; until then the previous version can still restore the
/// pre-images. So once any answer said open, only a ready answer with the journal closed ends the wait, and
/// silence stops meaning "an old daemon that reports nothing": it is the front answering 503 while it
/// restarts a daemon that crashed mid-conversion.
#[derive(Default)]
struct Readiness {
    /// Some answer in this wait reported the journal open.
    journal_seen: bool,
    /// The newest readable answer still did.
    journal_open: bool,
}

impl Readiness {
    fn note(&mut self, health: &serde_json::Value) {
        self.journal_open = journal_open(health);
        self.journal_seen |= self.journal_open;
    }

    /// May the wait end on this answer? None is no readable answer at all: an empty or unparsable body, or no
    /// answer (`curl -sf` fails on the front's 503 as it does on a refused connection).
    fn admits(&mut self, health: Option<&serde_json::Value>) -> bool {
        let Some(health) = health else {
            return !self.journal_seen;
        };
        self.note(health);
        !self.journal_open && ready_flag(health) != Some(false)
    }
}

/// The daemon's readiness: `boot.ready` where the daemon reports it, a top-level `ready` for anything older
/// that did. Neither is a daemon too old to report a boot at all.
fn ready_flag(health: &serde_json::Value) -> Option<bool> {
    health
        .get("boot")
        .and_then(|boot| boot.get("ready"))
        .or_else(|| health.get("ready"))
        .and_then(|ready| ready.as_bool())
}

/// Whether a health document reports its state journal open (`"state":{"journal":"open"}`). A daemon too old
/// to know the conversion engine has no `state` at all, which reads as closed, and so does any shape this
/// binary does not recognise: only the one spelling the contract names counts.
pub fn journal_open(health: &serde_json::Value) -> bool {
    health
        .get("state")
        .and_then(|state| state.get("journal"))
        .and_then(|journal| journal.as_str())
        == Some("open")
}

/// The label of any object in the health document with `"state":"running"` — a tree walk rather than a
/// schema, matching what the shell's grep did: the boot chain's shape belongs to the daemon, and this reader
/// must keep working as it grows. The doctor's daemon check names the same step.
pub fn running_step(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if map.get("state").and_then(|state| state.as_str()) == Some("running") {
                if let Some(label) = map.get("label").and_then(|label| label.as_str()) {
                    return Some(label.to_string());
                }
            }
            map.values().find_map(running_step)
        }
        serde_json::Value::Array(items) => items.iter().find_map(running_step),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_running_step_wherever_the_schema_puts_it() {
        let health = serde_json::json!({
            "ready": false,
            "boot": { "steps": [
                { "state": "done", "label": "restore snapshots" },
                { "state": "running", "label": "index the workspace" },
            ]}
        });
        assert_eq!(
            running_step(&health).as_deref(),
            Some("index the workspace")
        );
        assert_eq!(running_step(&serde_json::json!({"ready": true})), None);
        // The journal's `state` is an object, not a step's state string, and must not be read as one.
        let converting = serde_json::json!({
            "state": { "journal": "open", "engine": 7 },
            "boot": { "steps": [{ "state": "running", "label": "convert state" }] }
        });
        assert_eq!(running_step(&converting).as_deref(), Some("convert state"));
    }

    #[test]
    fn only_the_contracts_own_spelling_reads_as_an_open_journal() {
        assert!(journal_open(
            &serde_json::json!({ "state": { "journal": "open", "engine": 7 } })
        ));
        assert!(!journal_open(
            &serde_json::json!({ "state": { "journal": "none", "engine": 7 } })
        ));
        // A daemon from before the engine answers no `state` at all.
        assert!(!journal_open(
            &serde_json::json!({ "ok": true, "ready": true })
        ));
        // Shapes this binary does not know are closed, never guessed open: a guess here fails a swap.
        assert!(!journal_open(&serde_json::json!({ "state": "open" })));
        assert!(!journal_open(
            &serde_json::json!({ "state": { "journal": true } })
        ));
        assert!(!journal_open(
            &serde_json::json!({ "state": { "journal": "OPEN" } })
        ));
        assert!(!journal_open(&serde_json::json!(["state"])));
    }

    #[test]
    fn a_daemon_that_never_reports_a_journal_is_waited_for_exactly_as_before() {
        let mut readiness = Readiness::default();
        // Still booting: hold.
        assert!(!readiness.admits(Some(&serde_json::json!({ "ready": false }))));
        // An unreadable answer from a daemon that never opened a journal is the old single-wait "ready".
        assert!(readiness.admits(None));
        assert!(readiness.admits(Some(&serde_json::json!({ "ready": true }))));
        // Neither field at all: a daemon too old to report a boot.
        assert!(readiness.admits(Some(&serde_json::json!({ "ok": true }))));
        assert!(!readiness.journal_open);
    }

    #[test]
    fn once_a_journal_was_open_only_a_ready_answer_with_it_committed_ends_the_wait() {
        let mut readiness = Readiness::default();
        let open =
            serde_json::json!({ "ready": true, "state": { "journal": "open", "engine": 7 } });
        // Ready is not enough while the conversions are uncommitted.
        assert!(!readiness.admits(Some(&open)));
        // The front's 503 while it restarts a crashed daemon: silence is no longer readiness.
        assert!(!readiness.admits(None));
        assert!(
            readiness.journal_open,
            "an unreadable answer leaves the last word standing"
        );
        // Committed, but not ready.
        let committed_booting =
            serde_json::json!({ "ready": false, "state": { "journal": "none", "engine": 7 } });
        assert!(!readiness.admits(Some(&committed_booting)));
        assert!(!readiness.journal_open);
        // Still no readiness in silence, even after the commit: the rule is "once seen".
        assert!(!readiness.admits(None));
        assert!(readiness.admits(Some(&serde_json::json!({ "state": { "journal": "none" } }))));
    }

    #[test]
    fn readiness_is_read_where_the_daemon_reports_it() {
        let mut readiness = Readiness::default();
        // The daemon nests it under `boot`; a top-level-only reader returned on the first answer.
        assert!(!readiness.admits(Some(
            &serde_json::json!({ "ok": true, "boot": { "ready": false, "steps": [] } })
        )));
        assert!(readiness.admits(Some(
            &serde_json::json!({ "ok": true, "boot": { "ready": true, "steps": [] } })
        )));
        assert_eq!(
            ready_flag(&serde_json::json!({ "ready": false })),
            Some(false)
        );
        assert_eq!(ready_flag(&serde_json::json!({ "ok": true })), None);
    }

    #[test]
    fn the_answer_that_ended_the_first_wait_counts_toward_the_second() {
        // What wait_ready seeds from wait_answering: the journal opened, then the daemon went quiet.
        let mut readiness = Readiness::default();
        readiness.note(&serde_json::json!({ "state": { "journal": "open", "engine": 7 } }));
        assert!(!readiness.admits(None));
        assert!(readiness.journal_open);
    }
}
