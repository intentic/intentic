use crate::docker;
use crate::sandbox::trash;
use crate::sandbox::trash::GRACE_DAYS;
use crate::sandbox::{container_status, list_slugs, CONTAINER_PREFIX};
use crate::tty;
use crate::util::{bail, plural, Result};

/* Remove sandboxes from THIS machine — cleanup.sh's flow, except that the data outlives the removal by a week. */

pub struct Args {
    pub slugs: Vec<String>,
    pub all: bool,
    pub yes: bool,
    pub agent_auth: bool,
    /// Skip the grace period and delete the data now. The only path in this file that destroys a /work volume.
    pub now: bool,
}

pub fn run(args: Args) -> Result<()> {
    if !docker::cli_present() {
        bail!("docker is not installed — nothing to clean up.");
    }

    // Overdue trash goes before anything else asks for disk, so a machine that keeps removing sandboxes keeps
    // collecting the week-old ones without anybody running a second verb.
    let swept = trash::sweep();
    if !swept.is_empty() {
        println!(
            "intentic: deleted {} past the {}-day recovery window: {}",
            plural(swept.len(), "sandbox"),
            GRACE_DAYS,
            swept.join(" ")
        );
    }

    if args.all {
        let live = list_slugs();
        // "ALL sandboxes on this machine" has to mean the recoverable ones too, or `--all --now` would leave
        // behind exactly the volumes it was run to reclaim. Without `--now` they are already removed, and
        // re-trashing them would restart a clock that is meant to run down.
        let trashed: Vec<String> = if args.now {
            trash::list().into_iter().map(|entry| entry.slug).collect()
        } else {
            Vec::new()
        };
        if live.is_empty() && trashed.is_empty() {
            println!("intentic: no sandboxes found on this machine.");
            maybe_remove_agent_auth(&args);
            return Ok(());
        }
        println!("{}", headline(live.len() + trashed.len(), args.now));
        for slug in &live {
            println!("    {slug}");
        }
        for slug in &trashed {
            println!("    {slug} (already removed, still recoverable)");
        }
        println!("{}", aftermath(args.now));
        if !tty::confirm("Remove all of them?", args.yes) {
            println!("intentic: cancelled — nothing removed.");
            return Ok(());
        }
        for slug in live.iter().chain(trashed.iter()) {
            remove_slug(slug, args.now);
        }
        if args.now {
            sweep_orphans();
        }
        finish(&args);
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
            "Select which to remove — numbers (e.g. \"1 3\"), \"a\" = all, \"q\" = cancel: ",
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

    // The count is spelled out at the one prompt where a person has to read carefully: "these sandbox(es)" is not
    // a number, and the difference between one and all of them is the whole decision.
    println!("{}", headline(selected.len(), args.now));
    for slug in &selected {
        println!("    {slug}");
    }
    println!("{}", aftermath(args.now));
    if !tty::confirm("Proceed?", args.yes) {
        println!("intentic: cancelled — nothing removed.");
        return Ok(());
    }
    for slug in &selected {
        remove_slug(slug, args.now);
    }
    finish(&args);
    Ok(())
}

/// What the prompt claims is about to happen. The two readings are not degrees of the same thing — one is
/// reversible for a week and the other is not — so they share no wording.
fn headline(count: usize, now: bool) -> String {
    if now {
        return format!(
            "intentic: about to PERMANENTLY DELETE {} and their data (/work + /history):",
            plural(count, "sandbox")
        );
    }
    format!("intentic: about to remove {}:", plural(count, "sandbox"))
}

fn aftermath(now: bool) -> String {
    if now {
        return "This cannot be undone.".to_string();
    }
    format!("Their data (/work + /history) is kept for {GRACE_DAYS} days — 'ic sandbox restore <slug>' brings one back. Add --now to delete it instead.")
}

/// Host-wide teardown, run once the machine holds nothing this flow could still be asked to bring back. Desktop
/// sync and the agent-auth volume are not per-slug, and the volume stays docker-locked while any container
/// references it — which a trashed sandbox's container still does.
fn finish(args: &Args) {
    let remaining = list_slugs();
    let recoverable = trash::list();
    if remaining.is_empty() && recoverable.is_empty() {
        remove_sync_state();
        maybe_remove_agent_auth(args);
    } else if args.agent_auth {
        eprintln!(
            "intentic: kept shared dev agent-auth volume '{}' — other sandboxes still reference it.",
            auth_volume()
        );
    }
    println!(
        "intentic: done. Remaining sandboxes: {}",
        remaining.join(" ")
    );
    if !recoverable.is_empty() {
        let now = trash::now_secs();
        println!("intentic: recoverable with 'ic sandbox restore <slug>':");
        for entry in &recoverable {
            println!(
                "    {:<24} {} day(s) left",
                entry.slug,
                entry.days_left(now)
            );
        }
    }
}

/// Tells the platform this sandbox is being deleted, BEFORE anything is deleted — the container's env is where
/// its connect token lives, and a removed container answers no questions. Silent on every failure: a sandbox
/// that was never connected to a platform, a machine that is offline, an old container missing either value.
/// The browser's fallback is the wait it already does, so nothing here is worth a word in a removal's output.
fn announce_removal(slug: &str) {
    let container = format!("{CONTAINER_PREFIX}{slug}");
    let (Some(token), Some(platform)) = (
        docker::container_env_value(&container, "CONNECT_TOKEN"),
        docker::container_env_value(&container, "PLATFORM_URL"),
    ) else {
        return;
    };
    crate::platform::farewell(&platform, &token, &crate::sandbox::connect::machine_label());
}

/// One sandbox by slug: its 3 containers, 4 named volumes, and network. Idempotent (missing = no-op). The
/// dind pair is the Windows self-host deploy target connect.ps1 stands up beside the sandbox.
pub fn remove_slug(slug: &str, now: bool) {
    announce_removal(slug);
    if now {
        println!("intentic: deleting sandbox '{slug}' (containers + named volumes + network)…");
        trash::purge(slug);
        return;
    }
    println!(
        "intentic: removing sandbox '{slug}' — its data stays recoverable for {GRACE_DAYS} days…"
    );
    trash::stash(slug);
}

/// Volumes and networks no per-slug pass would reach, because no container names them any more. Only ever
/// reached under `--now`: the same prefixes carry the data a trashed sandbox is waiting to be restored from.
/// The prefixes never overlap the platform's intentic-app-* resources.
fn sweep_orphans() {
    println!("intentic: sweeping orphaned volumes and networks…");
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

/// Host-side machine-agent state (per-user: ~/.intentic/machine, the ssh include, the Mutagen sessions + daemon
/// registration) — removed as the INVOKING user, mirroring how connect installed it. The agent's own
/// `uninstall` does the session/ssh-config work; best-effort, state may be absent.
#[cfg(unix)]
fn remove_sync_state() {
    println!("intentic: removing machine-agent state…");
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
    let agent = home.join(".intentic/machine/bin/intentic-machine");
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
        home.join(".intentic/machine"),
        home.join(".local/bin/intentic-machine"),
        home.join(".ssh/intentic-machine.conf"),
    ] {
        let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
    }
}

/// The Windows twin (cleanup.ps1) removes %USERPROFILE%\.intentic\machine and the agent's login entry via the
/// agent's own uninstall; mirror that shape.
#[cfg(windows)]
fn remove_sync_state() {
    println!("intentic: removing machine-agent state…");
    let home = std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default());
    let agent = home.join(".intentic\\machine\\bin\\intentic-machine.exe");
    if agent.exists() {
        let _ = std::process::Command::new(&agent)
            .arg("uninstall")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = std::fs::remove_dir_all(home.join(".intentic\\machine"));
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
