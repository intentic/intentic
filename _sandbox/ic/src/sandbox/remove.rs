use crate::docker;
use crate::sandbox::{container_status, list_slugs, CONTAINER_PREFIX, DIND_PREFIX, TUNNEL_PREFIX};
use crate::tty;
use crate::util::{bail, Result};

/* Remove sandboxes' Docker footprint on THIS machine, INCLUDING the named /work volumes — cleanup.sh's flow.
 *
 * Why removal is a flow at all: a sandbox's /work is a NAMED volume, and `docker rm -v` (and lazydocker's
 * "remove with volumes") prune only ANONYMOUS volumes — a named volume survives every container remove, so a
 * stale /work persists across re-runs and the daemon's boot gate then skips re-scaffolding.
 *
 * By DEFAULT this lists and lets the user PICK; it never wipes everything unless asked. Removing a sandbox
 * DELETES its data (/work + /history), so every removal is confirmed unless -y. Non-interactive runs with no
 * selection NEVER auto-remove: they print the list and stop.
 *
 * cleanup.sh stays shipped as-is beside this: removal is the flow you reach for when things are broken, and
 * it must not depend on a binary that might itself be what's broken. Keep the two in lockstep. */

pub struct Args {
    pub slugs: Vec<String>,
    pub all: bool,
    pub yes: bool,
    pub agent_auth: bool,
}

pub fn run(args: Args) -> Result<()> {
    if !docker::cli_present() {
        bail!("docker is not installed — nothing to clean up.");
    }

    if args.all {
        let all = list_slugs();
        if all.is_empty() {
            println!("intentic: no sandboxes found on this machine.");
            maybe_remove_agent_auth(&args);
            return Ok(());
        }
        println!("intentic: about to PERMANENTLY DELETE ALL sandboxes on this machine and their data (/work + /history):");
        for slug in &all {
            println!("    {slug}");
        }
        println!("This cannot be undone.");
        if !tty::confirm("Remove all of them?", args.yes) {
            println!("intentic: cancelled — nothing removed.");
            return Ok(());
        }
        remove_all();
        remove_sync_state();
        maybe_remove_agent_auth(&args);
        println!("intentic: all sandboxes removed. Re-run connect to start fresh.");
        return Ok(());
    }

    let mut selected = args.slugs.clone();
    if selected.is_empty() {
        let slugs = list_slugs();
        if slugs.is_empty() {
            println!("intentic: no sandboxes found on this machine.");
            maybe_remove_agent_auth(&args);
            return Ok(());
        }
        println!("intentic: sandboxes on this machine:");
        for (i, slug) in slugs.iter().enumerate() {
            println!("  {}) {:<9} {slug}", i + 1, container_status(slug));
        }
        if !tty::have_tty() {
            bail!("no terminal for interactive selection — nothing removed.\nRe-run with a SLUG, or --all to remove every sandbox (add -y to skip prompts).");
        }
        let Some(reply) = tty::ask(
            "Select sandbox(es) to remove — numbers (e.g. \"1 3\"), \"a\" = all, \"q\" = cancel: ",
        ) else {
            println!("intentic: cancelled — nothing removed.");
            return Ok(());
        };
        match reply.trim() {
            "" | "q" | "Q" => {
                println!("intentic: cancelled — nothing removed.");
                return Ok(());
            }
            "a" | "A" => selected = slugs.clone(),
            picks => {
                for token in picks.split_whitespace() {
                    match token.parse::<usize>() {
                        Ok(number) if (1..=slugs.len()).contains(&number) => {
                            selected.push(slugs[number - 1].clone())
                        }
                        _ => eprintln!("intentic: ignoring invalid selection '{token}'."),
                    }
                }
            }
        }
    }
    if selected.is_empty() {
        println!("intentic: nothing selected — nothing removed.");
        return Ok(());
    }

    println!("intentic: about to PERMANENTLY DELETE these sandbox(es) and their data (/work + /history):");
    for slug in &selected {
        println!("    {slug}");
    }
    println!("This cannot be undone.");
    if !tty::confirm("Proceed?", args.yes) {
        println!("intentic: cancelled — nothing removed.");
        return Ok(());
    }
    for slug in &selected {
        remove_slug(slug);
    }

    // Desktop sync and the agent-auth volume are host-wide, not per-slug (and the volume stays docker-locked
    // while any sandbox container references it): tear them down only once every sandbox is gone.
    let remaining = list_slugs();
    if remaining.is_empty() {
        remove_sync_state();
        maybe_remove_agent_auth(&args);
    } else if args.agent_auth {
        eprintln!("intentic: kept shared dev agent-auth volume '{}' — other sandboxes still reference it.", auth_volume());
    }
    println!(
        "intentic: done. Remaining sandboxes: {}",
        remaining.join(" ")
    );
    Ok(())
}

/// One sandbox by slug: its 3 containers, 4 named volumes, and network. Idempotent (missing = no-op). The
/// dind pair is the Windows self-host deploy target connect.ps1 stands up beside the sandbox.
pub fn remove_slug(slug: &str) {
    println!("intentic: removing sandbox '{slug}' (containers + named volumes + network)…");
    for container in [
        format!("{CONTAINER_PREFIX}{slug}"),
        format!("{TUNNEL_PREFIX}{slug}"),
        format!("{DIND_PREFIX}{slug}"),
    ] {
        docker::quiet(&["rm", "-f", &container]);
    }
    for volume in [
        format!("intentic-workspace-{slug}"),
        format!("intentic-history-{slug}"),
        format!("intentic-docker-{slug}"),
        format!("intentic-dind-docker-{slug}"),
    ] {
        docker::quiet(&["volume", "rm", &volume]);
    }
    docker::quiet(&["network", "rm", &format!("intentic-workspace-{slug}")]);
}

/// EVERY sandbox by name prefix — also sweeps orphaned volumes/networks a per-slug pass would miss. The
/// prefixes never overlap the platform's intentic-app-* resources.
fn remove_all() {
    println!("intentic: removing sandbox containers…");
    for filter in [CONTAINER_PREFIX, DIND_PREFIX] {
        for name in docker::ps_names(true, filter) {
            docker::quiet(&["rm", "-f", &name]);
        }
    }
    println!("intentic: removing named volumes (the persistent /work)…");
    for prefix in [
        "intentic-workspace-",
        "intentic-history-",
        "intentic-docker-",
        "intentic-dind-docker-",
    ] {
        for volume in volume_names(prefix) {
            docker::quiet(&["volume", "rm", &volume]);
        }
    }
    println!("intentic: removing sandbox network(s)…");
    if let Some(networks) = docker::try_capture(&[
        "network",
        "ls",
        "-q",
        "--filter",
        "name=intentic-workspace-",
    ]) {
        for network in networks.lines().filter(|line| !line.is_empty()) {
            docker::quiet(&["network", "rm", network]);
        }
    }
}

fn volume_names(prefix: &str) -> Vec<String> {
    docker::try_capture(&["volume", "ls", "-q", "--filter", &format!("name={prefix}")])
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .filter(|line| !line.is_empty())
        .collect()
}

/// Host-side desktop-sync state (per-user: ~/.intentic/sync, the ssh include, the Mutagen session + daemon
/// registration) — removed as the INVOKING user, mirroring how connect installed it. The agent's own
/// `uninstall` does the session/ssh-config work; best-effort, state may be absent.
#[cfg(unix)]
fn remove_sync_state() {
    println!("intentic: removing desktop-sync state…");
    let (as_user, home) = match (docker::is_root(), std::env::var("SUDO_USER")) {
        (true, Ok(user)) if !user.is_empty() => {
            let home = std::process::Command::new("sh")
                .args(["-c", &format!("eval echo ~{user}")])
                .output()
                .ok()
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                .unwrap_or_default();
            (Some(user), std::path::PathBuf::from(home))
        }
        _ => (
            None,
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()),
        ),
    };
    let agent = home.join(".intentic/sync/bin/intentic-sync");
    if agent.exists() {
        let mut cmd = match &as_user {
            Some(user) => {
                let mut sudo = std::process::Command::new("sudo");
                sudo.args(["-u", user, "-H", &agent.to_string_lossy()]);
                sudo
            }
            None => std::process::Command::new(&agent),
        };
        let _ = cmd
            .arg("uninstall")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    for path in [
        home.join(".intentic/sync"),
        home.join(".local/bin/intentic-sync"),
        home.join(".ssh/intentic-sync.conf"),
    ] {
        let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
    }
}

/// The Windows twin (cleanup.ps1) removes %USERPROFILE%\.intentic\sync and the agent's login task via the
/// agent's own uninstall; mirror that shape.
#[cfg(windows)]
fn remove_sync_state() {
    println!("intentic: removing desktop-sync state…");
    let home = std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default());
    let agent = home.join(".intentic\\sync\\bin\\intentic-sync.exe");
    if agent.exists() {
        let _ = std::process::Command::new(&agent)
            .arg("uninstall")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = std::fs::remove_dir_all(home.join(".intentic\\sync"));
}

fn auth_volume() -> String {
    std::env::var("INTENTIC_AGENT_AUTH_VOLUME")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "intentic-dev-agent-auth".to_string())
}

/// The shared dev agent-auth volume: the AI-provider OAuth stores for ALL dev sandboxes on this machine. It
/// survives cleanup on purpose and is removed only on explicit --agent-auth or an interactive yes — NEVER
/// implied by -y, which callers rely on to keep their AI logins across resets.
fn maybe_remove_agent_auth(args: &Args) {
    let volume = auth_volume();
    if volume.starts_with('/') {
        return; // an absolute host path (connect option) — no docker volume to remove
    }
    if !docker::ok(&["volume", "inspect", &volume]) {
        return;
    }
    if args.agent_auth {
        remove_agent_auth(&volume);
        return;
    }
    if args.yes || !tty::have_tty() {
        println!("intentic: kept shared dev agent-auth volume '{volume}' (AI logins) — pass --agent-auth to remove.");
        return;
    }
    if let Some(reply) = tty::ask(&format!(
        "Also remove the shared dev agent-auth volume '{volume}'? Logs AI accounts out of ALL dev sandboxes. [y/N] "
    )) {
        if reply.starts_with(['y', 'Y']) {
            remove_agent_auth(&volume);
        }
    }
}

fn remove_agent_auth(volume: &str) {
    println!("intentic: removing shared dev agent-auth volume '{volume}' (AI logins)…");
    if !docker::ok(&["volume", "rm", volume]) {
        eprintln!("intentic: could not remove '{volume}' — still referenced by a container.");
    }
}
