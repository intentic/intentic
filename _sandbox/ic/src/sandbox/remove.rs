use std::time::Duration;

use crate::docker;
use crate::sandbox::lock;
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

/// Host-wide teardown, run once the machine holds nothing this flow could still be asked to bring back. The agent-auth
/// volume is not per-slug, and it stays docker-locked while any container references it — which a trashed sandbox's
/// container still does.
///
/// (2026-10-05) The machine agent's own folder is no longer deleted here: `~/.intentic/machine` also holds the restore
/// points of every synced folder and the audit log, which the agent's own uninstall deliberately keeps, and removing
/// it under a running agent broke it rather than retiring it. Each removed sandbox's pairings are retired through the
/// agent instead (`forget_pairings`), and the agent retires itself once it has nothing left to serve, as it already
/// does.
fn finish(args: &Args) {
    let Some(remaining) = crate::sandbox::live_slugs() else {
        eprintln!("intentic: docker could not list this machine's sandboxes, so the host-wide state they share was kept.");
        return;
    };
    let recoverable = trash::list();
    if remaining.is_empty() && recoverable.is_empty() {
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

/// How many times the removal notice is tried, and how long a removal waits on it in all: a flaky network must not
/// cost the platform the one positive "gone" it gets for a sandbox (the audit's rule 3), and a dead one must not hold
/// the removal for long.
const FAREWELL_TRIES: u32 = 3;
const FAREWELL_BUDGET: Duration = Duration::from_secs(20);

/// Whether a refused notice is worth another try: no answer at all, a server error, or a rate limit. A 4xx is the
/// platform's considered answer (an unknown token, a sandbox it already forgot) and another try changes nothing. Pure.
pub fn farewell_again(refusal: &crate::platform::Refusal) -> bool {
    match refusal {
        crate::platform::Refusal::Unreached => true,
        crate::platform::Refusal::Status(status) => *status >= 500 || *status == 429,
    }
}

/// Tells the platform this sandbox is being deleted, BEFORE anything is deleted — the container's env is where
/// its connect token lives, and a removed container answers no questions. Tried a few times within a budget, then
/// let go silently: a sandbox that was never connected to a platform, a machine that is offline, an old container
/// missing either value. The browser's fallback is the wait it already does, so nothing here is worth a word in a
/// removal's output.
fn announce_removal(slug: &str) {
    let container = format!("{CONTAINER_PREFIX}{slug}");
    let (Some(token), Some(platform)) = (
        docker::container_env_value(&container, "CONNECT_TOKEN"),
        docker::container_env_value(&container, "PLATFORM_URL"),
    ) else {
        return;
    };
    let machine = crate::sandbox::connect::machine_label();
    let started = std::time::Instant::now();
    for attempt in 1..=FAREWELL_TRIES {
        match crate::platform::farewell(&platform, &token, &machine) {
            Ok(()) => return,
            Err(refusal) if !farewell_again(&refusal) => return,
            Err(_) => {}
        }
        let pause = Duration::from_secs(u64::from(attempt) * 2);
        if attempt == FAREWELL_TRIES || started.elapsed() + pause >= FAREWELL_BUDGET {
            return;
        }
        std::thread::sleep(pause);
    }
}

/// One sandbox by slug: its 3 containers, 4 named volumes, and network. Idempotent (missing = no-op). The
/// dind pair is the Windows self-host deploy target connect.ps1 stands up beside the sandbox. Takes the sandbox's lock,
/// waiting for a swap or a backup of it to finish rather than pulling its containers out from under it.
pub fn remove_slug(slug: &str, now: bool) {
    let _held = match lock::hold_for_person(slug) {
        Ok(held) => held,
        Err(fail) => {
            eprintln!("intentic: {slug} was left as it is: {}", fail.0);
            return;
        }
    };
    announce_removal(slug);
    if now {
        println!("intentic: deleting sandbox '{slug}' (containers + named volumes + network)…");
        if let Err(why) = trash::purge(slug) {
            eprintln!("intentic: {why}.");
        }
    } else {
        println!(
            "intentic: removing sandbox '{slug}' — its data stays recoverable for {GRACE_DAYS} days…"
        );
        trash::stash(slug);
    }
    forget_pairings(slug);
}

/// How long the machine agent gets to retire a sandbox's pairings.
const FORGET_LIMIT: Duration = Duration::from_secs(60);

/// Retire this sandbox's folder-sync pairings in every environment of this machine, through its machine agent
/// (`intentic-machine sync forget <slug>`): a removed sandbox otherwise stays paired, and its sessions are retried
/// against an address that no longer answers, forever (audit 2026-10, the gone signal). Best-effort and quiet: no
/// agent, or one too old to know the verb, is a machine with nothing to forget. Run as the invoking user under sudo,
/// whose agent it is.
fn forget_pairings(slug: &str) {
    let Some(agent) = machine_agent() else {
        return;
    };
    let mut command = match invoking_user() {
        Some(user) => {
            let mut sudo = std::process::Command::new("sudo");
            sudo.args(["-u", &user, "-H"]).arg(&agent);
            sudo
        }
        None => std::process::Command::new(&agent),
    };
    command.args(["sync", "forget", slug]);
    if let Ok(ran) = docker::bounded(command, FORGET_LIMIT) {
        if ran.code == Some(0) {
            println!("intentic: {slug}'s folder sync was retired on this machine.");
        }
    }
}

/// The machine agent's binary: on PATH, else where its installer puts it.
fn machine_agent() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) {
        "intentic-machine.exe"
    } else {
        "intentic-machine"
    };
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    });
    on_path.or_else(|| {
        let installed = crate::logfile::intentic_home()
            .join("machine")
            .join("bin")
            .join(name);
        installed.is_file().then_some(installed)
    })
}

/// The user who ran `sudo ic …`, whose agent and home these are; None when this is not a sudo run.
fn invoking_user() -> Option<String> {
    #[cfg(unix)]
    {
        if docker::is_root() {
            return std::env::var("SUDO_USER")
                .ok()
                .filter(|user| !user.is_empty());
        }
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::Refusal;

    #[test]
    fn the_removal_notice_is_tried_again_only_when_another_try_could_land() {
        assert!(farewell_again(&Refusal::Unreached));
        assert!(farewell_again(&Refusal::Status(502)));
        assert!(farewell_again(&Refusal::Status(429)));
        assert!(!farewell_again(&Refusal::Status(401)));
        assert!(!farewell_again(&Refusal::Status(404)));
    }
}
