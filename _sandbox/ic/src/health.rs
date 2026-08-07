use std::time::Duration;

use crate::docker;
use crate::logfile::Log;
use crate::util::{bail, Result};

/* The two waits after a launch, in order — because a daemon that ANSWERS is not yet a daemon that SERVES.
 *
 * First: /health responds at all. A container that starts but crash-loops (an overlay that breaks the
 * daemon) would otherwise read as success and time out silently in the setup wizard. Second: /health says
 * `"ready":true`. The daemon listens the moment the process can (so a restart never reads as an outage) and
 * converges its state behind a readiness gate, during which every route but /health and /events parks —
 * returning at the first 200 handed the user a prompt back and a browser that sat on its first click.
 *
 * Probed INSIDE the container (docker exec + the image's curl): a local check with no tunnel or DNS in the
 * loop, so a slow DNS propagation can neither fail nor poison it. */

pub fn wait_answering(container: &str, log: &Log, remedy: &str) -> Result<()> {
    for _ in 0..15 {
        if docker::exec_ok(container, &["curl", "-sf", "http://localhost:8787/health"]) {
            return Ok(());
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
pub fn wait_ready(container: &str) {
    let mut last_step = String::new();
    for _ in 0..120 {
        let health =
            docker::exec_capture(container, &["curl", "-sf", "http://localhost:8787/health"])
                .unwrap_or_default();
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&health) else {
            return;
        };
        if parsed.get("ready").and_then(|ready| ready.as_bool()) != Some(false) {
            return;
        }
        if let Some(step) = running_step(&parsed) {
            if step != last_step {
                println!("intentic:   {step}…");
                last_step = step;
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    println!("intentic: the daemon is still warming up after 2 minutes — it keeps going in the background.");
    println!("          Watch it with: docker logs -f {container}");
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
    }
}
