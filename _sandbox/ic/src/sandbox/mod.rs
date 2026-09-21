pub mod connect;
pub mod doctor;
pub mod recreate;
pub mod remove;
pub mod restore;
pub mod staged;
pub mod trash;

use crate::docker;
use crate::util::{bail, Result};

/* The name shapes shared with the run contract (@intentic/sandbox-run sandboxNames) and cleanup.sh. */
pub const CONTAINER_PREFIX: &str = "intentic-sandbox-";
pub const TUNNEL_PREFIX: &str = "intentic-sandbox-tunnel-";
pub const DIND_PREFIX: &str = "intentic-dind-host-";

/// Every sandbox slug on this machine — the primary containers only (`-tunnel-` shares the prefix).
/// `ps -a`, not `ps`: a daemon that broke badly enough left its container EXITED, and requiring it to run
/// made the one flow that could fix it the one flow you could not reach.
pub fn list_slugs() -> Vec<String> {
    docker::ps_names(true, &format!("^{CONTAINER_PREFIX}"))
        .into_iter()
        .filter(|name| !name.starts_with(TUNNEL_PREFIX))
        .filter_map(|name| name.strip_prefix(CONTAINER_PREFIX).map(str::to_string))
        .collect()
}

/// An explicit slug names the sandbox; only its absence falls back to detecting the single one — never
/// guess which sandbox to touch when the machine runs several (`verb` names the re-run, e.g. "ic sandbox
/// update <slug>").
pub fn resolve_slug(given: Option<String>, verb: &str) -> Result<String> {
    if let Some(slug) = given {
        return Ok(slug);
    }
    let slugs = list_slugs();
    match slugs.len() {
        0 => bail!("no sandbox container found — run the connect one-liner first."),
        1 => Ok(slugs.into_iter().next().expect("one slug")),
        _ => {
            let listing: String = slugs.iter().map(|slug| format!("  {slug}\n")).collect();
            bail!("this machine runs more than one sandbox — name the one to touch, '{verb} <slug>':\n{listing}")
        }
    }
}

/// The sandbox's own network, before any container joins it: docker mints a missing named volume at run
/// time but never a missing network, so `--network` naming one that is absent refuses the whole launch.
pub fn ensure_network(slug: &str) -> Result<()> {
    let network = trash::network(slug);
    if !docker::ok(&["network", "inspect", &network]) {
        docker::capture(&["network", "create", &network])?;
    }
    Ok(())
}

pub fn container_status(slug: &str) -> String {
    docker::inspect(&format!("{CONTAINER_PREFIX}{slug}"), "{{.State.Status}}")
        .unwrap_or_else(|| "?".to_string())
}

/// `ic sandbox list` — what the pickers show, as a verb of its own (the desktop app's manager reads this).
pub fn list() -> Result<()> {
    docker::require_daemon()?;
    let slugs = list_slugs();
    if slugs.is_empty() {
        println!("intentic: no sandboxes on this machine.");
        print_recoverable();
        return Ok(());
    }
    for slug in slugs {
        println!("{:<9} {slug}", container_status(&slug));
    }
    print_recoverable();
    Ok(())
}

/// The trash, under the live listing rather than in it: these are not sandboxes you can open, only ones you can
/// still get back. Silent when empty, so the ordinary listing is unchanged.
pub fn print_recoverable() {
    let recoverable = trash::list();
    if recoverable.is_empty() {
        return;
    }
    let now = trash::now_secs();
    println!("\nremoved, still recoverable ('ic sandbox restore <slug>'):");
    for entry in &recoverable {
        println!(
            "{:<9} {} ({} day(s) left)",
            "removed",
            entry.slug,
            entry.days_left(now)
        );
    }
}
