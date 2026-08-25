/* `ic runner` — RUNNERS on this machine: sandbox-image containers that belong to a parent sandbox instead
 * of a person, executing turns it dispatches (design: docs/remote-runners-plan.md at the workspace root;
 * the daemon halves are `sandbox/src/runners/` and the sandbox contract's runner contract).
 *
 * `up` is `sandbox connect` minus the platform: the same run contract, spoken by the image itself
 * (contract.rs — nothing here states a docker-run shape), with the runner seed in the env instead of a
 * setup code, no tunnel grant, no Google client, no local publish. The container boots as a loopback
 * daemon, redeems its pairing against the parent over HTTPS, and dials the parent's WebSocket; from there
 * the parent's Computers/agents surfaces are where it is watched, not this terminal. */

use crate::contract::{self, RunRequest};
use crate::docker;
use crate::health;
use crate::logfile::Log;
use crate::sandbox::{self, connect::env_or, CONTAINER_PREFIX};
use crate::ui;
use crate::util::{bail, nul_frame, Result};

/// Every runner slug wears this prefix inside the ordinary sandbox namespace, so every existing flow
/// (list, update, remove, cleanup.sh) already recognises a runner as a sandbox container — which it is.
const SLUG_PREFIX: &str = "runner-";

/// A generated name when the caller supplies none: short, unique enough for one machine, and obviously
/// machine-minted so nobody mistakes it for something they chose.
fn generated_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}").chars().rev().take(6).collect()
}

fn slug_of(name: &str) -> Result<String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        bail!("runner names are lowercase letters, digits and dashes — '{name}' is not.");
    }
    Ok(format!("{SLUG_PREFIX}{name}"))
}

pub fn up(parent_url: String, pair_token: String, name: Option<String>) -> Result<()> {
    docker::require_daemon()?;
    if !parent_url.starts_with("http://") && !parent_url.starts_with("https://") {
        bail!("the parent URL must be the sandbox's web address (https://…) — got '{parent_url}'.");
    }
    if pair_token.trim().is_empty() {
        bail!("the pairing token is empty — mint one in the parent sandbox (POST /system/runners/pair) and pass it with --pair.");
    }
    let name = name.unwrap_or_else(generated_name);
    let slug = slug_of(&name)?;
    let container = format!("{CONTAINER_PREFIX}{slug}");
    if docker::container_exists(&container) {
        bail!("a runner named '{name}' already exists here — remove it first: ic runner remove {name}");
    }
    let image = env_or("SANDBOX_IMAGE", "ghcr.io/intentic/sandbox:stable");
    let log = Log::create("runner-up")?;
    sandbox::connect::ensure_image(&image, &log)?;

    // The whole difference from a person's sandbox is these two values — and the absences around them: no
    // setup code, no tunnel grant, no Google client, so the daemon boots loopback and only ever dials OUT.
    let env_pairs = nul_frame(&[
        ("RUNNER_PARENT_URL", parent_url.as_str()),
        ("RUNNER_PAIR_TOKEN", pair_token.as_str()),
    ]);
    let request = RunRequest {
        image: &image,
        slug: &slug,
        base_image: &image,
        channel: None,
        previous_image: None,
        environment_hash: None,
        runtime: None,
        mounts: None,
        dns: None,
    };
    // no_local_publish unconditionally: the loopback shortcut exists for a browser on this machine, and
    // nobody browses to a runner — claiming a port here could only collide with the sandbox someone uses.
    let argv = contract::run_command(&request, &env_pairs, true, &[], &log)?;
    log.section(&format!("docker run {image}"));
    if !docker::run_argv(&argv, &log) {
        docker::quiet(&["rm", "-f", &container]);
        let tail = log.tail(5);
        bail!(
            "starting the runner failed — the full docker error is saved to {}.\n{tail}",
            log.path.display()
        );
    }
    ui::note("waiting for the runner daemon to come up…");
    health::wait_answering(&container, &log, "")?;
    println!("Runner '{name}' is up and enrolling with {parent_url}.");
    println!("Watch it from the parent sandbox (GET /system/runners); logs here: docker logs {container}");
    println!("Remove it (container and volumes): ic runner remove {name}");
    Ok(())
}

pub fn list() -> Result<()> {
    docker::require_daemon()?;
    let runners: Vec<String> = sandbox::list_slugs()
        .into_iter()
        .filter_map(|slug| slug.strip_prefix(SLUG_PREFIX).map(str::to_string))
        .collect();
    if runners.is_empty() {
        println!("intentic: no runners on this machine.");
        return Ok(());
    }
    for name in runners {
        println!(
            "{:<9} {name}",
            sandbox::container_status(&format!("{SLUG_PREFIX}{name}"))
        );
    }
    Ok(())
}

/// Removal IS sandbox removal — a runner is a sandbox container, and the flow that removes those already
/// handles containers, named volumes and networks, with the confirmation this one inherits. Its work lives
/// in the parent's git, so nothing user-owned dies with it.
pub fn remove(name: String, yes: bool) -> Result<()> {
    let slug = slug_of(&name)?;
    sandbox::remove::run(sandbox::remove::Args {
        slugs: vec![slug],
        all: false,
        yes,
        agent_auth: false,
    })
}
