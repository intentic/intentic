use std::time::Duration;

use crate::docker;
use crate::record;
use crate::sandbox::recreate::{self, Preflight};
use crate::sandbox::{desired, resolve_slug, CONTAINER_PREFIX, TUNNEL_PREFIX};
use crate::shape::Ask;
use crate::util::{bail, Result};

/* `ic sandbox start|stop|restart` — a sandbox's power, and the one door every restart goes through, so the shape saved for the next restart is applied whichever button asked. */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Power {
    Start,
    Stop,
    Restart,
}

impl Power {
    fn verb(self) -> &'static str {
        match self {
            Power::Start => "start",
            Power::Stop => "stop",
            Power::Restart => "restart",
        }
    }
}

/// Long enough for `docker stop`'s grace period plus a slow disk; a docker CLI that takes longer is a machine in
/// trouble, and the caller is a button somebody is watching.
const POWER_LIMIT: Duration = Duration::from_secs(180);

/// The order the containers are powered in: the tunnel sidecar goes wherever its sandbox goes, since a started
/// sandbox nobody can reach is not started. Stopping fells the tunnel first so nothing routes into a container on
/// its way down; starting raises it last. Pure, so the order is asserted without a daemon.
fn order(power: Power, container: &str, sidecar: Option<&str>) -> Vec<String> {
    let mut order: Vec<String> = vec![container.to_string()];
    if let Some(sidecar) = sidecar {
        if power == Power::Stop {
            order.insert(0, sidecar.to_string());
        } else {
            order.push(sidecar.to_string());
        }
    }
    order
}

pub fn run(power: Power, slug: Option<String>) -> Result<()> {
    docker::require_daemon()?;
    let slug = resolve_slug(slug, &format!("ic sandbox {}", power.verb()))?;
    let container = format!("{CONTAINER_PREFIX}{slug}");
    if !docker::container_exists(&container) {
        bail!("sandbox container {container} does not exist on this machine.");
    }
    let tunnel = format!("{TUNNEL_PREFIX}{slug}");
    // Optional: a sandbox reached over the owner's own proxy has none.
    let sidecar = docker::container_exists(&tunnel).then_some(tunnel.as_str());
    desired::adopt_legacy(&slug, &container)?;

    /* A START OR RESTART WITH A SHAPE WAITING IS THE RECREATE THAT APPLIES IT: the same image, the saved shape, the same pre-flight as any swap. */
    if power != Power::Stop {
        if let Some(waiting) = record::read(&slug)?.desired {
            println!(
                "intentic: {slug} has a shape saved for its next restart ({}) — recreating it with that shape.",
                waiting.describe()
            );
            recreate::reshape(slug.clone(), Ask::default(), Preflight::Run)?;
            if let Some(sidecar) = sidecar {
                power_one("start", sidecar)?;
            }
            return Ok(());
        }
    }

    // Every container is tried, and what refused is said after: a tunnel that would not stop must not leave the
    // sandbox itself running.
    let refused: Vec<String> = order(power, &container, sidecar)
        .iter()
        .filter_map(|name| power_one(power.verb(), name).err().map(|err| err.0))
        .collect();
    if !refused.is_empty() {
        bail!("{}", refused.join("\n       "));
    }
    let done = match power {
        Power::Start => "started",
        Power::Stop => "stopped",
        Power::Restart => "restarted",
    };
    println!(
        "intentic: {slug} {done}{}.",
        if sidecar.is_some() {
            ", with its tunnel"
        } else {
            ""
        }
    );
    Ok(())
}

fn power_one(verb: &str, name: &str) -> Result<()> {
    let ran = docker::capture_bounded(&[verb, name], POWER_LIMIT)?;
    if ran.timed_out {
        bail!(
            "docker {verb} {name} did not finish within {}s — the machine may be in trouble.",
            POWER_LIMIT.as_secs()
        );
    }
    if ran.code != Some(0) {
        bail!("docker {verb} {name} failed: {}", ran.stderr);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tunnel_falls_first_and_rises_last() {
        let sidecar = Some("intentic-sandbox-tunnel-work");
        assert_eq!(
            order(Power::Stop, "intentic-sandbox-work", sidecar),
            vec!["intentic-sandbox-tunnel-work", "intentic-sandbox-work"]
        );
        for power in [Power::Start, Power::Restart] {
            assert_eq!(
                order(power, "intentic-sandbox-work", sidecar),
                vec!["intentic-sandbox-work", "intentic-sandbox-tunnel-work"]
            );
        }
        assert_eq!(
            order(Power::Restart, "intentic-sandbox-work", None),
            vec!["intentic-sandbox-work"]
        );
    }
}
