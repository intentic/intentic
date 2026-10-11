use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::docker;
use crate::sandbox::lock::{self, Wait};
use crate::sandbox::tidy::{orphan_fate, orphans, OrphanFate};
use crate::sandbox::trash;
use crate::sandbox::trash::GRACE_DAYS;
use crate::sandbox::{container_of, container_status, labels, list_slugs, side, CONTAINER_PREFIX};
use crate::tty;
use crate::ui;
use crate::util::{bail, plural, Result};

/* Remove sandboxes from THIS device — what cleanup.sh and cleanup.ps1 did, except that the data outlives the removal by
a week unless `--now` says otherwise. `--all` also does cleanup.sh's device-wide teardown: the volumes and networks no
container names any more, and the machine agent's connection once no sandbox is left. */

pub struct Args {
    pub slugs: Vec<String>,
    pub all: bool,
    pub yes: bool,
    pub agent_auth: bool,
    /// Skip the grace period and delete the data now. The only path in this file that destroys a /work volume.
    pub now: bool,
}

/// How a permanent delete (`--now`) is answered.
enum Permanent {
    /// By typing the name, or by `--confirm <name>`: the person's own `ic sandbox remove --now`. `--yes` never answers.
    Typed(Option<String>),
    /// By the ordinary yes/no, which `--yes` answers: ic's own callers whose removal deletes nothing of a person's (a
    /// runner, whose work lives in its parent's git, removed by the machine agent with -y).
    Asked,
}

/// The removal ic's own callers start (`ic runner remove`, setup's "remove some first"): `--yes` answers everything.
pub fn run(args: Args) -> Result<()> {
    remove(args, Permanent::Asked)
}

/// `ic sandbox remove`: a permanent delete is confirmed by typing, or by `--confirm` with the right name.
pub fn run_typed(args: Args, confirm: Option<String>) -> Result<()> {
    remove(args, Permanent::Typed(confirm))
}

fn remove(args: Args, permanent: Permanent) -> Result<()> {
    if !docker::cli_present() {
        bail!(
            "{}",
            ui::explain(
                "Nothing was removed.",
                Some("Docker is not installed on this device, so there is no sandbox here to remove."),
                None,
            )
        );
    }

    // Overdue trash goes before anything else asks for disk, so a device that keeps removing sandboxes keeps
    // collecting the week-old ones without anybody running a second verb.
    let swept = trash::sweep();
    if !swept.is_empty() {
        ui::note(&format!(
            "Deleted {} past the {GRACE_DAYS}-day recovery window: {}.",
            plural(swept.len(), "sandbox"),
            swept.join(", ")
        ));
    }

    let selected: Vec<String> = if args.all {
        let mut every = list_slugs();
        // "ALL sandboxes on this device" has to mean the recoverable ones too, or `--all --now` would leave
        // behind exactly the volumes it was run to reclaim. Without `--now` they are already removed, and
        // re-trashing them would restart a clock that is meant to run down.
        if args.now {
            every.extend(trash::list().into_iter().map(|entry| entry.slug));
        }
        crate::sandbox::each_once(every)
    } else if !args.slugs.is_empty() {
        // A name this device has neither running nor recoverable is said and passed over rather than "removed": nobody
        // is told a sandbox went that never was here. One already in the trash is already removed, and is said so.
        let live = list_slugs();
        let trashed = trash::list();
        let (mut here, mut already, mut unknown) = (Vec::new(), Vec::new(), Vec::new());
        for slug in crate::sandbox::each_once(args.slugs.clone()) {
            let in_trash = trashed.iter().find(|entry| entry.slug == slug);
            // A container removed by hand leaves its volumes, which a removal still puts away.
            let named = named_as(live.contains(&slug), in_trash.is_some(), args.now, || {
                docker::ok(&["volume", "inspect", &format!("intentic-workspace-{slug}")])
            });
            match (named, in_trash) {
                (Named::Here, _) => here.push(slug),
                (Named::AlreadyRemoved, Some(entry)) => {
                    already.push((slug, entry.days_left(trash::now_secs())))
                }
                _ => unknown.push(slug),
            }
        }
        for (slug, days) in &already {
            ui::note(&format!(
                "{slug} is already removed: ic sandbox restore {slug} brings it back, {}.",
                crate::sandbox::days_left(*days)
            ));
        }
        // Every name unknown is a stop that touches nothing: read as "nothing to remove", it went on to say there was
        // no sandbox on this device beside a running one, and took the shared agent logins with it (2026-10-11).
        if here.is_empty() && !unknown.is_empty() {
            bail!("{}", unknown_names(&unknown));
        }
        for slug in &unknown {
            ui::warn(&format!("There is no sandbox named {slug} on this device."));
        }
        if here.is_empty() {
            return Ok(());
        }
        here
    } else {
        let slugs = list_slugs();
        if slugs.is_empty() {
            ui::quiet("There is no sandbox on this device.");
            maybe_remove_agent_auth(&args)?;
            return Ok(());
        }
        let choices: Vec<(String, String)> = slugs
            .iter()
            .map(|slug| (slug.clone(), container_status(slug)))
            .collect();
        match ui::pick("Which sandboxes should be removed?", &choices, true)? {
            Some(picked) if !picked.is_empty() => picked
                .into_iter()
                .map(|index| slugs[index].clone())
                .collect(),
            _ => {
                ui::cancelled();
                return Ok(());
            }
        }
    };
    if selected.is_empty() {
        ui::quiet("There is no sandbox on this device.");
        maybe_remove_agent_auth(&args)?;
        return Ok(());
    }

    if !consent(&args, &selected, permanent)? {
        ui::cancelled();
        return Ok(());
    }
    let (mut removed, mut failed) = (0, Vec::new());
    for slug in &selected {
        match remove_slug(slug, args.now) {
            Ok(()) => removed += 1,
            Err(why) => failed.push((slug.clone(), why)),
        }
    }
    if args.all {
        teardown(args.now);
    }
    finish(&args, removed, &failed)
}

/// How a name given to `ic sandbox remove` stands on this device.
#[derive(Debug, PartialEq, Eq)]
enum Named {
    /// Something to remove: a sandbox, the trash's copy of one under `--now`, or volumes a container removed by hand
    /// left behind.
    Here,
    /// In the trash already, and this is no `--now`.
    AlreadyRemoved,
    /// Nothing of it here.
    Unknown,
}

/// Pure but for `has_volumes`, which is asked only when nothing else decides.
fn named_as(live: bool, in_trash: bool, now: bool, has_volumes: impl FnOnce() -> bool) -> Named {
    if live || (now && in_trash) {
        Named::Here
    } else if in_trash {
        Named::AlreadyRemoved
    } else if has_volumes() {
        Named::Here
    } else {
        Named::Unknown
    }
}

/// The stop for a removal none of whose names this device has. Pure.
fn unknown_names(unknown: &[String]) -> String {
    ui::explain(
        "Nothing was removed.",
        Some(&format!(
            "there is no sandbox named {} on this device.",
            unknown.join(" or ")
        )),
        Some("ic sandbox list"),
    )
}

/// The stop for the sandboxes a removal could not finish, with what docker refused for each. Pure.
fn removal_stop(failed: &[(String, String)], now: bool) -> String {
    let slugs: Vec<&str> = failed.iter().map(|(slug, _)| slug.as_str()).collect();
    let reasons: Vec<&str> = failed.iter().map(|(_, why)| why.as_str()).collect();
    ui::explain(
        &format!(
            "{} could not be {}: {}.",
            plural(failed.len(), "sandbox"),
            if now { "deleted" } else { "removed" },
            slugs.join(", ")
        ),
        Some(&format!("{}.", reasons.join("; "))),
        Some(&format!(
            "ic sandbox remove {}{} runs it again",
            slugs.join(" "),
            if now { " --now" } else { "" }
        )),
    )
}

/// What the person typing a permanent delete has to type: the sandbox's name for one, the count for several. Pure.
pub fn typed_name(selected: &[String]) -> String {
    match selected {
        [one] => one.clone(),
        many => many.len().to_string(),
    }
}

/// The question, and what answering yes does, said first. The two readings are not degrees of the same thing (one is
/// reversible for a week and the other is not), so they share no wording. Pure.
pub fn question(selected: &[String], now: bool, all: bool) -> (String, String) {
    let named = selected.join(", ");
    if now {
        let question = match selected {
            [one] => format!("Delete {one} for good?"),
            many => format!(
                "Delete {} for good? Type {} to confirm.",
                plural(many.len(), "sandbox"),
                many.len()
            ),
        };
        let mut consequence = format!(
            "This deletes {named} and their files and history (/work and /history). It cannot be undone."
        );
        if all {
            consequence.push_str(" The volumes and networks no sandbox uses any more go too, and this device's machine agent is disconnected along with its synced folders' restore points and its record of what agents did here.");
        }
        return (question, consequence);
    }
    let question = match selected {
        [one] => format!("Remove {one}?"),
        many => format!("Remove {}?", plural(many.len(), "sandbox")),
    };
    let mut consequence = format!(
        "This removes {named}. Their files and history (/work and /history) are kept for {GRACE_DAYS} days, and ic sandbox restore brings one back. --now deletes them instead."
    );
    if all {
        consequence.push_str(" Volumes no sandbox uses any more are kept for the same days, and this device's machine agent is disconnected once no sandbox is left.");
    }
    (question, consequence)
}

/// Asks before anything is removed. A permanent delete is answered only by typing (or `--confirm`), never by `--yes`.
fn consent(args: &Args, selected: &[String], permanent: Permanent) -> Result<bool> {
    let (asked, consequence) = question(selected, args.now, args.all);
    match permanent {
        Permanent::Typed(confirm) if args.now => ui::confirm_typed(
            &asked,
            &consequence,
            &typed_name(selected),
            confirm.as_deref(),
        ),
        _ => ui::confirm(&asked, &consequence, args.yes),
    }
}

/// The device-wide half of `--all`, run once every named sandbox is gone: what cleanup.sh did after its per-slug pass.
/// The volumes and networks no container names any more are put in the trash (or, under `--now`, deleted), and once
/// no sandbox is left on this side the machine agent's connection goes too.
fn teardown(now: bool) {
    sweep_orphans(now);
    let Some(remaining) = crate::sandbox::live_slugs() else {
        return;
    };
    if !remaining.is_empty() {
        return;
    }
    disconnect_machine_agent();
    // `--purge` in cleanup.sh: a permanent delete of everything leaves nothing to restore a synced folder for.
    if now && trash::list().is_empty() {
        purge_machine_records();
    }
}

/// Host-wide teardown, run once the device holds nothing this flow could still be asked to bring back. The agent-auth
/// volume is not per-slug, and it stays docker-locked while any container references it — which a trashed sandbox's
/// container still does.
///
/// (2026-10-05) The machine agent's own folder is no longer deleted here: `~/.intentic/machine` also holds the restore
/// points of every synced folder and the audit log, which the agent's own uninstall deliberately keeps, and removing
/// it under a running agent broke it rather than retiring it. Each removed sandbox's pairings are retired through the
/// agent instead (`forget_pairings`), and the agent retires itself once it has nothing left to serve, as it already
/// does.
fn finish(args: &Args, removed: usize, failed: &[(String, String)]) -> Result<()> {
    let stop = (!failed.is_empty()).then(|| removal_stop(failed, args.now));
    let Some(remaining) = crate::sandbox::live_slugs() else {
        ui::warn(
            "Docker could not list the sandboxes on this device, so the state they share was kept.",
        );
        return match stop {
            Some(stop) => Err(crate::util::Fail(stop)),
            None => Ok(()),
        };
    };
    let recoverable = trash::list();
    // A removal that did not finish leaves the shared state alone: what it left behind may still use it.
    if remaining.is_empty() && recoverable.is_empty() && failed.is_empty() {
        maybe_remove_agent_auth(args)?;
    } else if args.agent_auth {
        ui::warn(&format!(
            "Kept the shared dev agent-auth volume {}: other sandboxes still use it.",
            auth_volume()
        ));
    }
    if removed > 0 {
        ui::done(&format!(
            "{} {}.",
            plural(removed, "sandbox"),
            if args.now { "deleted" } else { "removed" }
        ));
    }
    ui::plain(&format!(
        "intentic: remaining sandboxes: {}",
        if remaining.is_empty() {
            "none".to_string()
        } else {
            remaining.join(" ")
        }
    ));
    if !recoverable.is_empty() {
        let now = trash::now_secs();
        let rows: Vec<ui::Item> = recoverable
            .iter()
            .map(|entry| {
                ui::Item::new(
                    ui::Tone::Skip,
                    entry.slug.clone(),
                    crate::sandbox::days_left(entry.days_left(now)),
                )
            })
            .collect();
        ui::section("removed, recoverable");
        ui::items(&rows);
        ui::later(&[(
            "bring one back".to_string(),
            format!("ic sandbox restore {}", recoverable[0].slug),
        )]);
    }
    match stop {
        Some(stop) => Err(crate::util::Fail(stop)),
        None => Ok(()),
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
///
/// Err says what was not done and where that left the sandbox; the caller counts it as not removed (2026-10-11: every
/// selected slug was counted, so a removal docker refused said "1 sandbox removed" and exited 0).
pub fn remove_slug(slug: &str, now: bool) -> std::result::Result<(), String> {
    let _held = lock::hold_for_person(slug).map_err(|fail| {
        let why: Vec<&str> = fail.0.lines().map(str::trim).collect();
        format!("{slug} was left as it is: {}", why.join(" "))
    })?;
    announce_removal(slug);
    let outcome = if now {
        ui::act(&format!("Deleting {slug}"));
        trash::delete(slug)
    } else {
        ui::act(&format!("Removing {slug}"));
        trash::stash(slug)
    };
    // Its pairings go once it has left the live namespace, whether or not every step after that went through.
    if !docker::container_exists(&container_of(slug)) {
        forget_pairings(slug);
    }
    outcome
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
    let mut command = as_invoking_user(&agent);
    command.args(["sync", "forget", slug]);
    if let Ok(ran) = docker::bounded(command, FORGET_LIMIT) {
        if ran.code == Some(0) {
            ui::note(&format!("{slug}'s folder sync was retired on this device."));
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

/// How long the machine agent gets to disconnect itself.
const UNINSTALL_LIMIT: Duration = Duration::from_secs(120);

/// The machine agent, run as the user whose agent it is: `sudo -u <user> -H` under sudo, else as it is.
fn as_invoking_user(program: &Path) -> std::process::Command {
    match invoking_user() {
        Some(user) => {
            let mut sudo = std::process::Command::new("sudo");
            sudo.args(["-u", &user, "-H"]).arg(program);
            sudo
        }
        None => std::process::Command::new(program),
    }
}

/// cleanup.sh's `remove_sync_state`, through the agent's own `intentic-machine uninstall`: every sandbox link, every
/// sync pairing and the login entry go, and the agent retires itself (on a Windows PC it may stay to keep the WSL
/// distros running, and says so). What it keeps on purpose (the restore points and the audit log) stays unless the
/// removal was permanent (`purge_machine_records`). Best-effort: no agent is a device with nothing to disconnect.
fn disconnect_machine_agent() {
    let Some(agent) = machine_agent() else {
        return;
    };
    ui::act("Disconnecting this device's machine agent");
    let mut command = as_invoking_user(&agent);
    command.arg("uninstall");
    match docker::bounded(command, UNINSTALL_LIMIT) {
        Ok(ran) if ran.code == Some(0) => ui::done("This device's machine agent is disconnected."),
        _ => {
            ui::warn("This device's machine agent could not be disconnected.");
            ui::later(&[(
                "disconnect it by hand".to_string(),
                "intentic-machine uninstall".to_string(),
            )]);
        }
    }
}

/// The machine agent's own folder, in the home of the user whose agent it is.
fn machine_dir() -> PathBuf {
    let home = invoking_user()
        .and_then(|user| {
            std::fs::read_to_string("/etc/passwd")
                .ok()
                .and_then(|passwd| home_of(&passwd, &user))
        })
        .map(|home| PathBuf::from(home).join(".intentic"))
        .unwrap_or_else(crate::logfile::intentic_home);
    home.join("machine")
}

/// A user's home directory from /etc/passwd's text. Pure.
pub fn home_of(passwd: &str, user: &str) -> Option<String> {
    passwd.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        (fields.len() >= 6 && fields[0] == user && !fields[5].is_empty())
            .then(|| fields[5].to_string())
    })
}

/// What the agent's uninstall keeps on purpose: copies of the owner's own files from before each bring-back, and the
/// record of what agents ran on this device. cleanup.sh's `--purge` deleted them; a permanent removal of every sandbox
/// does the same.
pub const MACHINE_RECORDS: [&str; 3] = ["restore", "audit.jsonl", "audit.jsonl.1"];

fn purge_machine_records() {
    let dir = machine_dir();
    for name in MACHINE_RECORDS {
        let path = dir.join(name);
        let gone = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(err) = gone {
            if err.kind() != std::io::ErrorKind::NotFound {
                ui::warn(&format!("{} could not be deleted: {err}", path.display()));
            }
        }
    }
}

/// Volumes and networks no per-slug pass would reach, because no container names them any more: grouped by the
/// sandbox they belong to, as `ic sandbox tidy` groups them. A set this side made goes to the trash like any removed
/// sandbox (under `--now`, it is deleted); a network alone holds nothing and goes; a set another side of this
/// computer made is that side's to decide. The prefixes never overlap the platform's intentic-app-* resources.
fn sweep_orphans(now: bool) {
    let Some(live) = crate::sandbox::live_slugs() else {
        return;
    };
    let trashed: Vec<String> = trash::list().into_iter().map(|entry| entry.slug).collect();
    let known = |slug: &str| live.iter().any(|l| l == slug) || trashed.iter().any(|t| t == slug);
    let side_label = format!("{{{{.Name}}}}\t{{{{.Label \"{}\"}}}}", labels::SIDE);
    let (Some(volumes), Some(networks)) = (
        docker::try_capture(&["volume", "ls", "--format", &side_label]),
        docker::try_capture(&["network", "ls", "--format", "{{.Name}}"]),
    ) else {
        return;
    };
    let volume_rows: Vec<(String, String)> = volumes
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let (name, label) = line.split_once('\t').unwrap_or((line, ""));
            (name.trim().to_string(), label.trim().to_string())
        })
        .collect();
    let network_rows: Vec<String> = networks
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    let here = side::here();
    for orphan in orphans(&volume_rows, &network_rows, &known) {
        let recorded = crate::record::record_path(&orphan.slug).exists();
        match orphan_fate(&orphan, recorded, &here) {
            OrphanFate::OtherSide(_) => continue,
            OrphanFate::NetworkOnly => {}
            OrphanFate::Trash | OrphanFate::Recorded => {
                let Ok(Some(_held)) = lock::hold(&orphan.slug, Wait::Skip) else {
                    continue;
                };
                // Looked at once more: a setup that made its volumes a moment ago has a container by now.
                if docker::container_exists(&container_of(&orphan.slug)) {
                    continue;
                }
                if now {
                    for volume in &orphan.volumes {
                        docker::quiet(&["volume", "rm", volume]);
                    }
                } else if trash::adopt_orphan(&orphan.slug) {
                    ui::note(&format!(
                        "{}'s leftover volumes are kept for {GRACE_DAYS} days, like a removed sandbox.",
                        orphan.slug
                    ));
                }
            }
        }
        if let Some(network) = &orphan.network {
            docker::quiet(&["network", "rm", network]);
        }
    }
}

fn auth_volume() -> String {
    std::env::var("INTENTIC_AGENT_AUTH_VOLUME")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "intentic-dev-agent-auth".to_string())
}

/// The shared dev agent-auth volume: the AI-provider OAuth stores for ALL dev sandboxes on this device. It
/// survives cleanup on purpose and is removed only on explicit --agent-auth or an interactive yes — NEVER
/// implied by -y, which callers rely on to keep their AI logins across resets.
fn maybe_remove_agent_auth(args: &Args) -> Result<()> {
    let volume = auth_volume();
    if volume.starts_with('/') {
        return Ok(()); // an absolute host path (connect option) — no docker volume to remove
    }
    if !docker::ok(&["volume", "inspect", &volume]) {
        return Ok(());
    }
    if args.agent_auth {
        remove_agent_auth(&volume);
        return Ok(());
    }
    if args.yes || !tty::have_tty() {
        ui::quiet(&format!(
            "Kept the shared dev agent-auth volume {volume} (AI logins). --agent-auth removes it."
        ));
        return Ok(());
    }
    if ui::confirm(
        &format!("Also remove the shared dev agent-auth volume {volume}?"),
        "It holds the AI logins of every dev sandbox on this device, so they are all signed out.",
        false,
    )? {
        remove_agent_auth(&volume);
    }
    Ok(())
}

fn remove_agent_auth(volume: &str) {
    ui::act(&format!(
        "Removing the shared dev agent-auth volume {volume}"
    ));
    if docker::ok(&["volume", "rm", volume]) {
        ui::done("The AI logins of every dev sandbox are removed.");
    } else {
        ui::warn(&format!(
            "{volume} could not be removed: a container still uses it."
        ));
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

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn a_permanent_delete_is_confirmed_by_the_name_of_one_or_the_count_of_several() {
        assert_eq!(typed_name(&names(&["work"])), "work");
        assert_eq!(typed_name(&names(&["a", "b", "c"])), "3");
        let (asked, _) = question(&names(&["a", "b", "c"]), true, false);
        assert_eq!(asked, "Delete 3 sandboxes for good? Type 3 to confirm.");
        let (asked, consequence) = question(&names(&["work"]), true, false);
        assert_eq!(asked, "Delete work for good?");
        assert!(consequence.contains("cannot be undone"));
    }

    #[test]
    fn a_removal_says_it_is_recoverable_and_never_uses_the_word_delete_for_itself() {
        let (asked, consequence) = question(&names(&["a", "b"]), false, false);
        assert_eq!(asked, "Remove 2 sandboxes?");
        assert!(consequence.contains(&format!("kept for {GRACE_DAYS} days")));
        assert!(!asked.contains("Delete"));
        let (_, everything) = question(&names(&["a"]), false, true);
        assert!(everything.contains("machine agent is disconnected"));
    }

    #[test]
    fn the_typed_confirmation_is_answered_by_the_right_name_and_nothing_else() {
        // --confirm with the right name answers without a terminal; a wrong one stops rather than deleting.
        assert!(crate::ui::confirm_typed("q", "c", "3", Some("3")).unwrap());
        assert!(crate::ui::confirm_typed("q", "c", "work", Some("other")).is_err());
    }

    #[test]
    fn a_name_is_removed_only_when_something_of_it_is_here() {
        let never = || -> bool { panic!("volumes are asked about only when nothing else decides") };
        assert_eq!(named_as(true, false, false, never), Named::Here);
        assert_eq!(named_as(false, true, true, never), Named::Here);
        // In the trash and no --now: already removed, never removed again (which would restart its clock).
        assert_eq!(named_as(false, true, false, never), Named::AlreadyRemoved);
        assert_eq!(named_as(false, false, false, || true), Named::Here);
        assert_eq!(named_as(false, false, false, || false), Named::Unknown);
    }

    #[test]
    fn a_removal_of_names_this_device_does_not_have_stops_and_names_them() {
        let stop = unknown_names(&names(&["sandbox-typo"]));
        assert!(stop.starts_with("Nothing was removed."));
        assert!(stop.contains("there is no sandbox named sandbox-typo on this device."));
        assert!(stop.contains("ic sandbox list"));
        assert!(!stop.contains("There is no sandbox on this device"));
    }

    #[test]
    fn a_removal_docker_refused_is_counted_as_not_removed_and_says_why() {
        let failed = vec![(
            "sandbox-aaa".to_string(),
            "docker would not rename intentic-sandbox-sandbox-aaa".to_string(),
        )];
        let stop = removal_stop(&failed, false);
        assert!(stop.starts_with("1 sandbox could not be removed: sandbox-aaa."));
        assert!(stop.contains("docker would not rename intentic-sandbox-sandbox-aaa."));
        assert!(stop.contains("ic sandbox remove sandbox-aaa runs it again"));
        let deleted = removal_stop(&failed, true);
        assert!(deleted.starts_with("1 sandbox could not be deleted: sandbox-aaa."));
        assert!(deleted.contains("ic sandbox remove sandbox-aaa --now"));
    }

    #[test]
    fn a_sandbox_named_twice_is_removed_once_and_confirmed_by_its_name() {
        let twice = crate::sandbox::each_once(names(&["work", "work"]));
        assert_eq!(typed_name(&twice), "work");
        assert_eq!(question(&twice, true, false).0, "Delete work for good?");
        assert_eq!(question(&twice, false, false).0, "Remove work?");
    }

    #[test]
    fn the_invoking_users_home_is_read_from_passwd() {
        let passwd = "root:x:0:0:root:/root:/bin/sh\nradar:x:1000:1000::/home/radar:/bin/zsh\n";
        assert_eq!(home_of(passwd, "radar").as_deref(), Some("/home/radar"));
        assert_eq!(home_of(passwd, "nobody"), None);
        assert_eq!(MACHINE_RECORDS, ["restore", "audit.jsonl", "audit.jsonl.1"]);
    }
}
