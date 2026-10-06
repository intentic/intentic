use std::time::Duration;

use crate::docker;
use crate::record;
use crate::sandbox::recreate::{self, Preflight};
use crate::sandbox::{
    desired, ledger, lock, mirror, parked_of, probation, resolve_slug, resume, CONTAINER_PREFIX,
    TUNNEL_PREFIX,
};
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

/// Who asked: a person (a terminal, the desktop app, the machine agent relaying a button), or the keeper's own repair.
/// Only the keeper's restarts count toward the ledger's limit on automatic ones (ledger.rs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum By {
    Person,
    Keeper,
}

pub fn run(power: Power, slug: Option<String>) -> Result<()> {
    run_by(power, slug, By::Person)
}

pub fn run_by(power: Power, slug: Option<String>, by: By) -> Result<()> {
    docker::require_daemon()?;
    let slug = resolve_slug(slug, &format!("ic sandbox {}", power.verb()))?;
    let _held = lock::hold_for_person(&slug)?;
    let container = format!("{CONTAINER_PREFIX}{slug}");
    if !docker::container_exists(&container) {
        // An interrupted swap parked the sandbox with no replacement: starting it IS putting it back.
        if power != Power::Stop && docker::container_exists(&parked_of(&slug)) {
            probation::watch_one(&slug)?;
            println!("intentic: {slug} was left set aside by an interrupted update — it is back under its own name.");
        } else {
            bail!("sandbox container {container} does not exist on this machine.");
        }
    }
    // The report key rides on the env this verb can read now, for a later `ic sandbox fix` that cannot.
    if let Some(env) = docker::ask(
        &[
            "inspect",
            "--format",
            "{{range .Config.Env}}{{.}}{{printf \"\\x00\"}}{{end}}",
            &container,
        ],
        docker::READ_LIMIT,
    )
    .said()
    {
        crate::sandbox::fix::report::remember_from_env(&slug, env.as_bytes());
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
            let kind = if power == Power::Restart {
                ledger::RESTART
            } else {
                ledger::START
            };
            ledger::note(&slug, kind, by == By::Keeper);
            return Ok(());
        }
    }

    // The turns a restart cuts are picked up again by the daemon's next boot (resume.rs).
    if power == Power::Restart && resume::ask(&container) {
        println!("intentic: {slug}'s agents pick up the turns this restart cuts once it is back.");
    }
    /* NOTED BEFORE IT IS MADE: the ledger's moment then falls before the daemon start it causes, which is how the
    probation watch tells a start made through ic from a crash (probation.rs restarts_seen). A start or restart docker
    refuses still counts as one tried. */
    match power {
        Power::Restart => ledger::note(&slug, ledger::RESTART, by == By::Keeper),
        Power::Start => ledger::note(&slug, ledger::START, by == By::Keeper),
        Power::Stop => {}
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
    hold(&slug, power == Power::Stop);
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

/* STOPPED ON PURPOSE. A stop through ic is the owner's decision, and `ic sandbox fix` (the machine agent's `--auto`
among its callers) must never undo it unasked; a start or restart through ic is the decision reversed. Read through
the mirror first, so a stale record on this side is never stamped as the newest. A stop a person made outside ic
(Docker Desktop's Stop button) is recorded here too once the fix engine has seen it (fix/chain.rs), and a sandbox found
running again is the decision reversed. */
pub(crate) fn hold(slug: &str, held: bool) {
    let saved = mirror::reconcile(slug);
    if saved.held == held {
        return;
    }
    if record::write(slug, &record::ChannelRecord { held, ..saved }).is_ok() {
        mirror::push(slug);
    }
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
