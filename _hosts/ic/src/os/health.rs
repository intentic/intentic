use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{reboot, Paths};
use crate::docker::{self, Asked};
use crate::sandbox::{container_of, inside, now_ms};
use crate::util::{bail, Result};

/* THE BOOT'S HEALTH VERDICT, which greenboot acts on. greenboot runs `ic os health --wait 600` as a required check on
every boot; a red verdict makes it reboot, and after three red boots it rolls back to the previous deployment. So green
has to mean the machine does its one job again: dockerd answers, and every sandbox that ran when the machine last went
down in order (`expected-running.json`, reboot.rs) runs again with its daemon answering. Docker's `--restart
unless-stopped` starts them by itself; this only waits for them, and starts nothing. A sandbox somebody stopped before
the reboot is not in the record and is not expected.

What one look found and what it means are kept apart: `verdict` is a pure function of the observations, so the rule
greenboot's rollback hangs on is a test, not a reading of a polling loop. */

/// How long one read of a sandbox's daemon may take.
const READ_LIMIT: Duration = Duration::from_secs(15);
/// How long docker may take to say it is up, per look.
const ENGINE_LIMIT: Duration = Duration::from_secs(15);
/// Between two looks.
const POLL: Duration = Duration::from_secs(5);

/// What one look found of an expected sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Found {
    /// Its container is missing or not running.
    Stopped,
    /// Its container runs and its daemon did not answer `/health`.
    Silent,
    /// Its container runs and its daemon answered.
    Answering,
}

/// The failed check when docker never answered.
const DOCKER_SILENT: &str = "dockerd did not answer";

/// One look at the machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    pub docker: bool,
    pub sandboxes: Vec<(String, Found)>,
}

/// Green with nothing failed, or red with every failed check named in the words the contract's examples use
/// (golden/intentic-os.json), which the desktop app and the agent's card show as they are: `dockerd did not answer`,
/// `sandbox <slug> is not running` (its container is missing or stopped), `sandbox <slug>'s daemon did not answer`. With
/// docker down nothing else could be looked at, so docker is the one check named. Pure.
pub fn verdict(observed: &Observed) -> (bool, Vec<String>) {
    if !observed.docker {
        return (false, vec![DOCKER_SILENT.to_string()]);
    }
    let failed: Vec<String> = observed
        .sandboxes
        .iter()
        .filter_map(|(slug, found)| match found {
            Found::Answering => None,
            Found::Stopped => Some(format!("sandbox {slug} is not running")),
            Found::Silent => Some(format!("sandbox {slug}'s daemon did not answer")),
        })
        .collect();
    (failed.is_empty(), failed)
}

/// What `/run/intentic-os/health.json` says. Pure.
pub fn health_body(green: bool, failed: &[String], at: u64) -> Value {
    json!({ "verdict": if green { "green" } else { "red" }, "failed": failed, "at": at })
}

/// `ic os health [--wait <seconds>]`: look until everything passes or the wait is over, write the verdict, and exit 0
/// for green, 1 for red.
pub fn run(wait: u64) -> Result<()> {
    let paths = Paths::here();
    let expected = reboot::expected_slugs(super::read_json(&paths.expected_running()).as_ref());
    if !expected.is_empty() {
        crate::ui::note(&format!(
            "waiting up to {wait}s for docker and {} to answer: {}.",
            crate::util::plural(expected.len(), "sandbox"),
            expected.join(", ")
        ));
    }
    let deadline = Instant::now() + Duration::from_secs(wait);
    let (green, failed) = loop {
        let (green, failed) = verdict(&look(&expected));
        if green || Instant::now() + POLL >= deadline {
            break (green, failed);
        }
        std::thread::sleep(POLL);
    };
    let body = health_body(green, &failed, now_ms());
    if let Err(err) = super::write_atomic(&paths.health(), format!("{body}\n").as_bytes()) {
        crate::ui::warn(&format!("the verdict was not written: {}", err.0));
    }
    if !green {
        bail!(
            "This boot is not healthy after {wait}s: {}.",
            failed.join(", ")
        );
    }
    crate::ui::done(&if expected.is_empty() {
        "Healthy: docker answers, and no sandbox was expected to run.".to_string()
    } else {
        format!(
            "Healthy: docker answers and {} answer{} again.",
            crate::util::plural(expected.len(), "sandbox"),
            if expected.len() == 1 { "s" } else { "" }
        )
    });
    Ok(())
}

/// One look: docker first, and each expected sandbox only when docker answered.
fn look(expected: &[String]) -> Observed {
    let docker = docker::engine(ENGINE_LIMIT).up();
    let sandboxes = if docker {
        expected
            .iter()
            .map(|slug| (slug.clone(), found(&container_of(slug))))
            .collect()
    } else {
        Vec::new()
    };
    Observed { docker, sandboxes }
}

/// One sandbox's container and daemon, each read with a deadline: the curl connect.rs waits on, from inside.
fn found(container: &str) -> Found {
    if !inside::running(container) {
        return Found::Stopped;
    }
    let asked = docker::ask(
        &[
            "exec",
            container,
            "curl",
            "-fsS",
            "--max-time",
            "5",
            crate::health::HEALTH_URL,
        ],
        READ_LIMIT,
    );
    match asked {
        Asked::Said(_) => Found::Answering,
        Asked::Refused(_) | Asked::Silent => Found::Silent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observed(docker: bool, sandboxes: &[(&str, Found)]) -> Observed {
        Observed {
            docker,
            sandboxes: sandboxes
                .iter()
                .map(|(slug, found)| (slug.to_string(), *found))
                .collect(),
        }
    }

    #[test]
    fn green_is_docker_and_every_expected_sandbox_answering() {
        assert_eq!(verdict(&observed(true, &[])), (true, Vec::new()));
        assert_eq!(
            verdict(&observed(
                true,
                &[("work", Found::Answering), ("lab", Found::Answering)]
            )),
            (true, Vec::new())
        );
    }

    #[test]
    fn red_names_every_check_that_failed_in_order() {
        assert_eq!(
            verdict(&observed(
                true,
                &[
                    ("work", Found::Answering),
                    ("lab", Found::Stopped),
                    ("site", Found::Silent)
                ]
            )),
            (
                false,
                vec![
                    "sandbox lab is not running".to_string(),
                    "sandbox site's daemon did not answer".to_string()
                ]
            )
        );
    }

    #[test]
    fn docker_down_is_the_one_failure_named() {
        assert_eq!(
            verdict(&observed(false, &[])),
            (false, vec!["dockerd did not answer".to_string()])
        );
        // Even with nothing expected: a machine whose docker never answers runs no sandbox.
        assert_eq!(
            verdict(&observed(false, &[("work", Found::Answering)])).1,
            vec!["dockerd did not answer".to_string()]
        );
    }

    #[test]
    fn the_verdict_file_is_the_shape_status_reads() {
        assert_eq!(
            health_body(false, &["sandbox work is not running".to_string()], 7),
            json!({ "verdict": "red", "failed": ["sandbox work is not running"], "at": 7 })
        );
        assert_eq!(
            health_body(true, &[], 9),
            json!({ "verdict": "green", "failed": [], "at": 9 })
        );
    }
}
