//! MOVING A PC'S SANDBOXES BETWEEN ENGINES — `ic engine move --to intentic|docker-desktop` (2026-10-09).
#![cfg_attr(not(windows), allow(dead_code))]

/* Move all sandboxes for this side/account before switching engine.json active: stop/rename originals, transfer exact images and checked volumes,
 * then reshape placeholders through the normal run/health contract; carry companion containers too. Other WSL sides retain their engine.
 * Any failure restores all originals without switching. Success keeps stopped old copies in moves.json for KEEP_DAYS before cleanup.
 * Moving back is another move; never delete source data during transfer. */

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{paths, Kind};
use crate::docker::{self, Target};
use crate::logfile::Log;
use crate::sandbox::at_rest::key_file;
#[cfg(test)]
use crate::sandbox::at_rest::windows_path_of;
use crate::sandbox::{self, side, CONTAINER_PREFIX, DIND_PREFIX, MOVED_SUFFIX, TUNNEL_PREFIX};
use crate::ui;
use crate::util::{bail, Fail, Result};

/// How long the copies a move leaves behind are kept before cleanup removes them.
pub const KEEP_DAYS: u64 = 7;
/// The `from` of a copy a move to another device left on this one (sandbox/device_move): no engine of this PC, just
/// the docker this ic runs against.
pub const DEVICE_FROM: &str = "device";
pub(crate) const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// A running move says it is alive at least this often; one silent for longer died with its ic.
pub(crate) const STALE_HEARTBEAT_MS: u64 = 10 * 60 * 1000;
/// A copy that moves no byte for this long is stuck, not slow.
pub(crate) const STALL: Duration = Duration::from_secs(10 * 60);
/// Free space the target must keep beyond what is copied onto it.
pub(crate) const SPARE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Where a volume holding a Docker engine's own data is mounted: its overlay layers carry `trusted.*` attributes and
/// whiteout device files, which only a privileged helper can read and write back.
pub(crate) const DOCKER_DATA: &str = "/var/lib/docker";

/* ——— The journal: what moved, what it left behind, and a move in progress. ——— */

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    #[serde(default)]
    pub moving: Option<Moving>,
    #[serde(default)]
    pub moved: Vec<Moved>,
    /// What moves made on the engine they carry to and have not yet finished or undone: [`Made`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub made: Vec<Made>,
}

/* WHAT A MOVE MAKES ON THE OTHER ENGINE, WRITTEN DOWN BEFORE IT IS MADE (2026-11-20). A move cut off mid-copy (the installer
 * quit with its ic still copying, an undo whose `volume rm` the engine refused) left `intentic-history-<slug>` on our engine
 * with no word of whose it was, and every move after refused it as somebody else's ("remove or rename it"), which nobody
 * at that PC could do. Each volume and container a move creates on the target is recorded here first, and the record goes
 * once the move finishes (they are the live ones then) or its undo has removed them: a record still here names a copy of
 * what the source still has, which the next move may replace. */

/// One volume or container a move made on the engine `on` for `slug`: a copy, never the only one.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Made {
    pub slug: String,
    /// The engine it was made on (a [`Kind`] id).
    pub on: String,
    pub name: String,
    /// A container rather than a volume.
    #[serde(default)]
    pub container: bool,
}

/// Whether a move left `name` on `on` for `slug` without finishing or undoing it. Pure.
fn made_by_a_move(journal: &Journal, slug: &str, on: &str, name: &str) -> bool {
    journal
        .made
        .iter()
        .any(|made| made.slug == slug && made.on == on && made.name == name)
}

/// `name` written down as made on `on` for `slug`, once.
fn note_made(slug: &str, on: Kind, name: &str, container: bool) -> Result<()> {
    update_journal(|journal| {
        if !made_by_a_move(journal, slug, on.id(), name) {
            journal.made.push(Made {
                slug: slug.to_string(),
                on: on.id().to_string(),
                name: name.to_string(),
                container,
            });
        }
    })
}

/// The records of what was made on `on` for `slug`: of `names` only, or all of them with `None`. Pure.
fn forget_made(journal: &mut Journal, slug: &str, on: &str, names: Option<&[String]>) {
    journal.made.retain(|made| {
        !(made.slug == slug
            && made.on == on
            && names.is_none_or(|names| names.contains(&made.name)))
    });
}

/* A MOVE WRITES DOWN WHAT IT HAS DONE BEFORE IT DOES IT (2026-11-20). Somebody quit the desktop app during a 92 GB
 * volume copy; the app ends ic's whole process tree, so its undo never ran. The entry below stayed with a dead pid, every
 * ic run after refused with "sandboxes are being moved", and nothing on the PC could say which containers the move had
 * renamed aside. Each step that changes the source (a stop, a rename, a commit) is now recorded in `progress` first, so a
 * later ic finds the move interrupted ([`state_of`]) and undoes exactly those steps ([`recover`]). */

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Moving {
    pub pid: u32,
    pub to: String,
    pub started: u64,
    pub heartbeat: u64,
    /// The engine it carries from (a [`Kind`] id). An entry of ic 1.429.0 or older names only `to`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// The move's own log, where its rollback adds its line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
    /// What each sandbox's move has done so far, written before each step that changes the source. None in an entry an
    /// older ic wrote, which recorded nothing: that one is recovered by ic's own names alone ([`legacy_restores`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Vec<Carried>>,
}

/// Whether the ic doing a move still does it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveState {
    Running,
    Interrupted(Interruption),
}

/// How a move was found to have stopped without finishing or undoing itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interruption {
    /// No process with its pid is alive.
    ProcessGone,
    /// A process with its pid is alive, yet the move has not said so for [`STALE_HEARTBEAT_MS`]: a pid Windows gave to
    /// another program, or an ic hung beyond its own limits.
    HeartbeatStale,
}

impl Interruption {
    fn words(self, moving: &Moving) -> String {
        match self {
            Interruption::ProcessGone => format!("its ic (process {}) is gone", moving.pid),
            Interruption::HeartbeatStale => format!(
                "it has not said it was alive for {} minutes",
                STALE_HEARTBEAT_MS / 60_000
            ),
        }
    }
}

/// A move's state from its entry, the time and whether a pid is alive. A dead pid is proof the move ended; a live one is
/// not proof it runs, since Windows reuses pids, so a live pid still needs a fresh heartbeat. _(2026-11-20) Only the
/// heartbeat was read, so a move whose ic was killed blocked every ic run for ten minutes and, with a pid reused, longer._
/// Pure.
pub(crate) fn state_of(moving: &Moving, now: u64, alive: impl Fn(u32) -> bool) -> MoveState {
    if !alive(moving.pid) {
        MoveState::Interrupted(Interruption::ProcessGone)
    } else if now.saturating_sub(moving.heartbeat) >= STALE_HEARTBEAT_MS {
        MoveState::Interrupted(Interruption::HeartbeatStale)
    } else {
        MoveState::Running
    }
}

/// Whether a process with `pid` is alive on this machine. Unsure answers alive: reading a live move as dead would undo
/// it under its own feet. (Not `sandbox::fix::host`'s `alive`, which asks `tasklist.exe` and reads a timed-out ask as
/// dead.)
pub(crate) fn process_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    process_alive_here(pid)
}

#[cfg(windows)]
fn process_alive_here(pid: u32) -> bool {
    use std::ffi::c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_INVALID_PARAMETER: i32 = 87;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    // SAFETY: plain Win32 calls on a pid; the handle is closed before return.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // No such process is ERROR_INVALID_PARAMETER; anything else (access denied) means one exists.
        return std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INVALID_PARAMETER);
    }
    let mut code = 0u32;
    // SAFETY: `handle` is the valid handle just opened, and `code` outlives the call.
    let read = unsafe { GetExitCodeProcess(handle, &mut code) };
    // SAFETY: closed once, here.
    unsafe { CloseHandle(handle) };
    read == 0 || code == STILL_ACTIVE
}

#[cfg(target_os = "linux")]
fn process_alive_here(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_alive_here(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_or(true, |status| status.success())
}

/// One sandbox carried across, and the copies it left on the engine it left.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub slug: String,
    pub from: String,
    pub to: String,
    pub at: u64,
    /// The stopped containers left behind, by their `.moved` names.
    pub containers: Vec<String>,
    pub volumes: Vec<String>,
    /// The images committed from containers beside the sandbox to carry them, left on the engine they came from.
    #[serde(default)]
    pub images: Vec<String>,
    pub remove_after: u64,
    #[serde(default)]
    pub removed: bool,
}

pub(crate) fn load_journal() -> Journal {
    paths::moves_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_journal(journal: &Journal) -> Result<()> {
    let path = paths::moves_path().ok_or_else(|| Fail("no home folder".to_string()))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let staged = path.with_extension("json.new");
    std::fs::write(&staged, serde_json::to_string_pretty(journal)?)?;
    std::fs::rename(&staged, &path)?;
    Ok(())
}

pub(crate) fn update_journal(change: impl FnOnce(&mut Journal)) -> Result<()> {
    let mut journal = load_journal();
    change(&mut journal);
    save_journal(&journal)
}

fn now_ms() -> u64 {
    sandbox::now_ms()
}

/// A move whose ic is still alive: what every other ic run stays away from while it lasts.
pub fn in_progress() -> bool {
    state() == Some(MoveState::Running)
}

/// The move on this device, if its entry is there: running, or interrupted and not yet undone.
pub fn state() -> Option<MoveState> {
    load_journal()
        .moving
        .as_ref()
        .map(|moving| state_of(moving, now_ms(), process_alive))
}

/// What `ic engine status --json` says about moves, for the desktop app's card and Repair: None when nothing ever moved.
pub fn summary() -> Option<Value> {
    summary_of(&load_journal(), now_ms(), process_alive)
}

fn summary_of(journal: &Journal, now: u64, alive: impl Fn(u32) -> bool) -> Option<Value> {
    let state = journal
        .moving
        .as_ref()
        .map(|moving| state_of(moving, now, alive));
    let kept: Vec<&Moved> = journal
        .moved
        .iter()
        .filter(|moved| !moved.removed)
        .collect();
    if journal.moving.is_none() && journal.moved.is_empty() {
        return None;
    }
    let last = journal.moved.iter().max_by_key(|moved| moved.at);
    Some(json!({
        "moving": state == Some(MoveState::Running),
        // A move whose ic is gone and whose entry is still here: the next `ic engine move` or `ic docker prepare` rolls
        // it back, and `ic engine move --abort` does so on its own.
        "interrupted": matches!(state, Some(MoveState::Interrupted(_))),
        "to": journal.moving.as_ref().map(|moving| moving.to.clone()),
        "last": last.map(|moved| json!({ "from": moved.from, "to": moved.to, "at": moved.at })),
        "leftBehind": kept.iter().map(|moved| json!({
            "slug": moved.slug,
            "on": moved.from,
            "removeAfter": moved.remove_after,
        })).collect::<Vec<_>>(),
    }))
}

/// The copies whose days are up.
fn expired(journal: &Journal, now: u64) -> Vec<Moved> {
    journal
        .moved
        .iter()
        .filter(|moved| !moved.removed && moved.remove_after <= now)
        .cloned()
        .collect()
}

/* ——— The command. ——— */

pub struct Args {
    pub to: String,
    pub yes: bool,
}

pub fn run(args: Args) -> Result<()> {
    if !cfg!(windows) {
        bail!("moving sandboxes between engines is for Windows PCs: run it from Windows (the desktop app does), not from inside WSL.");
    }
    let Some(to) = Kind::parse(&args.to).filter(|kind| *kind != Kind::Native) else {
        bail!("move to `intentic` or `docker-desktop`, not '{}'.", args.to);
    };
    // A move cut off before is undone first: it left sandboxes renamed aside, which this one would refuse to carry.
    recover(false)?;
    let from = super::in_use();
    if from == to {
        ui::begin("move sandboxes between container engines", vec![], None);
        let _ = cleanup(false);
        ui::finished(
            "moved",
            None,
            &format!("this device's sandboxes already run on {}", to.name()),
            &[],
        );
        return Ok(());
    }
    if in_progress() {
        bail!("another move between engines is running on this device; wait for it to finish.");
    }
    let log = Log::create_named("engine", "move")?;
    log.line(&format!("move from {} to {}", from.id(), to.id()));
    let target = ready_target(to, &log)?;
    // No Docker Desktop and no engine answering where it would: nothing can be on it, so there is nothing to carry,
    // and waiting for a Docker Desktop that is not installed would be five minutes of nothing. Not so with Rancher
    // Desktop installed and stopped: its sandboxes are there, and switching would leave them where no `docker` looks.
    if from == Kind::DockerDesktop
        && !super::docker_desktop_installed()
        && !super::own_engine_installed()
        && !answers(&Target::DockerDesktop)
    {
        switch(to)?;
        ui::begin("move sandboxes between container engines", vec![], None);
        ui::plain(&format!("no other engine here to carry sandboxes from — this device now runs its sandboxes on {}.", to.name()));
        ui::finished("moved", None, &format!("no other engine here to carry sandboxes from — this device now runs its sandboxes on {}", to.name()), &[]);
        return Ok(());
    }
    let source = ready_source(from)?;
    let plan = plan(&source, &target, from, to, &log)?;
    for (slug, kept_by) in &plan.left_alone {
        ui::note(&format!("{slug} is kept by ic on {kept_by}, which reaches Docker Desktop by itself: it stays there."));
    }
    if plan.sandboxes.is_empty() {
        switch(to)?;
        ui::begin("move sandboxes between container engines", vec![], None);
        ui::plain(&format!(
            "no sandbox to carry — this device now runs its sandboxes on {}.",
            to.name()
        ));
        ui::finished(
            "moved",
            None,
            &format!(
                "no sandbox to carry — this device now runs its sandboxes on {}",
                to.name()
            ),
            &[],
        );
        return Ok(());
    }
    check_space(&plan, to)?;
    let names: Vec<&str> = plan.sandboxes.iter().map(|s| s.slug.as_str()).collect();
    let question = format!(
        "Move {} ({}, {}) from {} to {}?",
        plural(names.len(), "sandbox", "sandboxes"),
        names.join(", "),
        gigabytes(plan.bytes),
        from.name(),
        to.name(),
    );
    let consequence = format!(
        "Each is stopped while its files are copied. {} keeps its copy for {KEEP_DAYS} days.",
        from.name(),
    );
    if !ui::confirm(&question, &consequence, args.yes)? {
        ui::cancelled();
        return Ok(());
    }
    ui::begin("move sandboxes between container engines", vec![], None);
    let started = now_ms();
    update_journal(|journal| {
        journal.moving = Some(Moving {
            pid: std::process::id(),
            to: to.id().to_string(),
            started,
            heartbeat: started,
            from: Some(from.id().to_string()),
            log: Some(log.path.display().to_string()),
            progress: Some(Vec::new()),
        })
    })?;
    let mut locks = Vec::new();
    for sandbox in &plan.sandboxes {
        locks.push(crate::sandbox::lock::hold_for_person(&sandbox.slug)?);
    }
    let mut carried: Vec<Carried> = Vec::new();
    // Each sandbox's channel record as it was, written back by an undo (the reshape on the other engine rewrites it).
    let mut records: Vec<(String, crate::record::ChannelRecord)> = Vec::new();
    let mut failure: Option<String> = None;
    for (index, sandbox) in plan.sandboxes.iter().enumerate() {
        say(
            &sandbox.slug,
            "begin",
            json!({ "index": index, "count": plan.sandboxes.len(), "bytes": sandbox.bytes }),
        );
        if let Ok(record) = crate::record::read(&sandbox.slug) {
            records.push((sandbox.slug.clone(), record));
        }
        let mut carry = Carried::new(sandbox);
        match move_one(sandbox, &source, &target, to, &mut carry, &log) {
            Ok(()) => carried.push(carry),
            Err(Fail(reason)) => {
                failure = Some(format!("{}: {reason}", sandbox.slug));
                carried.push(carry);
                break;
            }
        }
    }
    docker::adopt_target(&source);
    if let Some(reason) = failure {
        ui::step(
            "undo",
            &format!(
                "the move stopped ({reason}) — putting every sandbox back on {}…",
                from.name()
            ),
        );
        for carry in carried.iter().rev() {
            undo(carry, &source, Some(&target), to, &log);
            if let Some((_, record)) = records.iter().find(|(slug, _)| *slug == carry.slug) {
                let _ = crate::record::write(&carry.slug, record);
            }
        }
        let _ = update_journal(|journal| journal.moving = None);
        drop(locks);
        say("", "failed", json!({ "reason": reason }));
        bail!(
            "{}", ui::explain(
                &format!("the move to {} did not finish", to.name()),
                Some(&reason),
                Some(&format!("every sandbox is back on {} as it was, and this device still runs on it. Log: {}", from.name(), log.path.display()))
            )
        );
    }
    switch(to)?;
    docker::adopt_target(&target);
    update_journal(|journal| record_finished(journal, &carried, from, to, now_ms()))?;
    drop(locks);
    if to == Kind::DockerDesktop {
        // Nothing runs on our engine now but the copies kept for the days: it rests until cleanup needs it.
        let _ = super::rest("not in use since this device's sandboxes moved to Docker Desktop");
    }
    say(
        "",
        "done",
        json!({ "engine": to.id(), "count": carried.len() }),
    );
    let instruction = if to == Kind::Intentic {
        "Docker Desktop no longer runs any of Intentic's sandboxes: quit it, or uninstall it if you do not use it yourself, to give its memory back. Rollback targets kept on Docker Desktop did not come along: a rollback downloads that version instead."
    } else {
        ""
    };
    ui::finished(
        "moved",
        None,
        &format!("This device now runs its sandboxes on {}. {}'s copies stay, stopped, for {KEEP_DAYS} days.", to.name(), from.name()),
        &[
            ("remove copies sooner".to_string(), "ic engine cleanup --now".to_string()),
            ("move them back".to_string(), format!("ic engine move --to {}", cli_id(from))),
        ],
    );
    if !instruction.is_empty() {
        ui::note(instruction);
    }
    Ok(())
}

/// A move that carried every sandbox, written down as finished: what it made is the sandboxes now, and the source's
/// copies are kept for [`KEEP_DAYS`]. Pure.
fn record_finished(journal: &mut Journal, carried: &[Carried], from: Kind, to: Kind, now: u64) {
    journal.moving = None;
    let remove_after = now + KEEP_DAYS * DAY_MS;
    for carry in carried {
        // What it made on the target is the sandbox now, no longer a copy to clear away.
        forget_made(journal, &carry.slug, to.id(), None);
        // A move back makes the copies the earlier move left on this engine the live ones again, and the record of
        // them is over.
        for earlier in journal.moved.iter_mut() {
            if earlier.slug == carry.slug && earlier.from == to.id() && !earlier.removed {
                earlier.removed = true;
            }
        }
        journal.moved.push(Moved {
            slug: carry.slug.clone(),
            from: from.id().to_string(),
            to: to.id().to_string(),
            at: now,
            containers: carry
                .renamed
                .iter()
                .map(|(_, moved)| moved.clone())
                .collect(),
            volumes: carry.volumes.clone(),
            images: carry.committed.clone(),
            remove_after,
            removed: false,
        });
    }
}

/* ——— A move found interrupted, and putting it right. ——— */

/// What to do about an interrupted move, decided from its entry and the engine this device runs on now.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Recovery {
    /// The switch was already made, so every sandbox had been carried: the move finished but for its journal, which is
    /// written now as the move would have.
    Finish {
        from: Kind,
        to: Kind,
        carried: Vec<Carried>,
    },
    /// Each sandbox's recorded steps undone, the last first: the source's containers get their names back and run if
    /// they ran, and what was made on the target is removed.
    Undo {
        from: Kind,
        to: Kind,
        carried: Vec<Carried>,
    },
    /// An entry an older ic wrote, with no steps recorded: only the containers ic's own naming says it set aside are
    /// given back ([`legacy_restores`]), and nothing is removed; the volumes it left on our engine are written down as
    /// made ([`legacy_leftovers`]). With the switch made there is nothing to give back.
    Legacy {
        from: Kind,
        to: Kind,
        switched: bool,
    },
    /// An entry naming no engine this ic knows: it is dropped, and nothing else is touched.
    Forget,
}

/// The engine a move between the two engines carries from, when its entry does not say. Pure.
fn other_engine(to: Kind) -> Kind {
    if to == Kind::Intentic {
        Kind::DockerDesktop
    } else {
        Kind::Intentic
    }
}

/// Pure.
fn recovery_of(moving: &Moving, in_use: Kind) -> Recovery {
    let Some(to) = Kind::parse(&moving.to).filter(|kind| *kind != Kind::Native) else {
        return Recovery::Forget;
    };
    let from = moving
        .from
        .as_deref()
        .and_then(Kind::parse)
        .unwrap_or_else(|| other_engine(to));
    let switched = in_use == to;
    match &moving.progress {
        None => Recovery::Legacy { from, to, switched },
        Some(carried) if switched => Recovery::Finish {
            from,
            to,
            carried: carried.clone(),
        },
        Some(carried) => Recovery::Undo {
            from,
            to,
            carried: carried.clone(),
        },
    }
}

/// One container an older ic's move set aside, to be given its name back.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Restore {
    slug: String,
    /// Its name now, `<name>.moved`.
    moved: String,
    name: String,
}

/// The containers on the source a move of ic 1.429.0 or older renamed aside before it was cut off, read off their names
/// alone: a sandbox's own container, its dind host or its tunnel, with [`MOVED_SUFFIX`] on a slug ic could have made,
/// whose own name is free (a sandbox still there by its name was never set aside), and which is not a copy a finished
/// move keeps for its days (`kept`). The sandbox's own container first, as a move sets them aside. Pure.
fn legacy_restores(names: &[String], kept: &[String]) -> Vec<Restore> {
    let mut restores: Vec<Restore> = Vec::new();
    for moved in names {
        if kept.contains(moved) {
            continue;
        }
        let Some(name) = moved.strip_suffix(MOVED_SUFFIX) else {
            continue;
        };
        // The tunnel's prefix starts with the sandbox's own: asked first.
        let slug = [TUNNEL_PREFIX, DIND_PREFIX, CONTAINER_PREFIX]
            .iter()
            .find_map(|prefix| name.strip_prefix(prefix));
        let Some(slug) = slug.filter(|slug| sandbox::is_slug(slug)) else {
            continue;
        };
        if slug.ends_with(crate::sandbox::PARKED_SUFFIX) || names.iter().any(|other| other == name)
        {
            continue;
        }
        restores.push(Restore {
            slug: slug.to_string(),
            moved: moved.clone(),
            name: name.to_string(),
        });
    }
    restores.sort_by_key(|restore| restore.name != sandbox::container_of(&restore.slug));
    restores
}

/// `ic engine move --abort`: roll back a move whose ic is gone. Refused while one runs.
pub fn abort() -> Result<()> {
    ui::begin("undo an interrupted move between engines", vec![], None);
    if !recover(true)? {
        ui::finished(
            "nothing to undo",
            None,
            "no move between engines was interrupted on this device: there is nothing to undo",
            &[],
        );
    }
    Ok(())
}

/// Find a move cut off part-way (its ic killed: the desktop app quit mid-copy, the PC shut down) and put this device back
/// as it was before it. Run by `ic engine move --abort` (`explicit`, which refuses while a move runs) and at the start of
/// every `ic engine move` and `ic docker prepare`, so the PC's own setup heals itself. Answers whether there was one.
/// Its entry stays while the source engine cannot be reached, for the next run to finish the job.
pub fn recover(explicit: bool) -> Result<bool> {
    let Some(moving) = load_journal().moving else {
        return Ok(false);
    };
    let why = match state_of(&moving, now_ms(), process_alive) {
        MoveState::Running if explicit => bail!(
            "a move between engines is running on this device (ic process {}): it can only be undone once it has stopped — let it finish, or end that process first.",
            moving.pid
        ),
        MoveState::Running => return Ok(false),
        MoveState::Interrupted(why) => why,
    };
    let log = log_of(&moving);
    let how = why.words(&moving);
    if let Some(log) = &log {
        log.section("found interrupted");
        log.line(&format!(
            "this move to {} was found interrupted: {how}. Putting it right.",
            moving.to
        ));
    }
    let said = |line: &str| {
        if let Some(log) = &log {
            log.line(line);
        }
    };
    let ended = match recovery_of(&moving, super::in_use()) {
        Recovery::Forget => "its entry named no engine this ic knows, so it was dropped and nothing else touched".to_string(),
        Recovery::Finish { from, to, carried } => {
            update_journal(|journal| record_finished(journal, &carried, from, to, now_ms()))?;
            format!(
                "it had carried every sandbox and switched this device to {}, so it was recorded as finished; {}'s copies stay, stopped, for {KEEP_DAYS} days",
                to.name(),
                from.name()
            )
        }
        Recovery::Undo { from, to, carried } => {
            let source = ready_source(from)?;
            let target = reachable(to);
            if target.is_none() {
                said(&format!("{} does not answer: what the move made there stays recorded, for the next move to replace.", to.name()));
            }
            let mut locks = Vec::new();
            for carry in &carried {
                if let Ok(lock) = crate::sandbox::lock::hold_for_person(&carry.slug) {
                    locks.push(lock);
                }
            }
            let fallback;
            let into = match &log {
                Some(log) => log,
                None => {
                    fallback = Log::create_named("engine", "move")?;
                    &fallback
                }
            };
            for carry in carried.iter().rev() {
                undo(carry, &source, target.as_ref(), to, into);
            }
            drop(locks);
            format!("rolled back: every sandbox it had begun is back on {}", from.name())
        }
        Recovery::Legacy { switched: true, .. } => {
            "this device had already switched engines, so its sandboxes run there; nothing was undone".to_string()
        }
        Recovery::Legacy {
            from,
            to,
            switched: false,
        } => {
            let source = ready_source(from)?;
            let (given, names) = give_back_legacy(&source, from, &said)?;
            if to == Kind::Intentic {
                note_legacy_leftovers(&source, &names, to, &said);
            }
            if given.is_empty() {
                format!("rolled back: no container on {} was set aside by it", from.name())
            } else {
                format!("rolled back: {} back on {} by their own names", given.join(", "), from.name())
            }
        }
    };
    update_journal(|journal| {
        if journal
            .moving
            .as_ref()
            .is_some_and(|now| now.started == moving.started && now.pid == moving.pid)
        {
            journal.moving = None;
        }
    })?;
    said(&format!("interrupted move: {ended}."));
    ui::note(&format!(
        "A move between engines on this device was interrupted ({how}) — {ended}.{}",
        log.as_ref()
            .map(|log| format!(" Log: {}", log.path.display()))
            .unwrap_or_default()
    ));
    Ok(true)
}

/// The log of the move itself, opened to add to: the one its entry names, else (an entry of an older ic) the newest
/// move log written since it started. None when there is none to be had, which is said on the terminal alone.
fn log_of(moving: &Moving) -> Option<Log> {
    if let Some(path) = moving.log.as_deref() {
        if let Ok(log) = Log::append(std::path::Path::new(path)) {
            return Some(log);
        }
    }
    let started = std::time::UNIX_EPOCH + Duration::from_millis(moving.started);
    let newest = std::fs::read_dir(crate::logfile::log_dir())
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("move-") && name.ends_with(".log")
        })
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .filter(|(modified, _)| *modified >= started)
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path);
    match newest {
        Some(path) => Log::append(&path).ok(),
        None => Log::create_named("engine", "move").ok(),
    }
}

/// The engine `kind` when it answers now, started if it is ours and stopped; None otherwise. Nothing is installed.
fn reachable(kind: Kind) -> Option<Target> {
    let target = match kind {
        Kind::Intentic => Target::Intentic(super::reach()?),
        _ => Target::DockerDesktop,
    };
    if answers(&target) {
        return Some(target);
    }
    if kind == Kind::Intentic && super::start().is_ok() && answers(&target) {
        return Some(target);
    }
    None
}

/// An older ic's interrupted move undone by names alone: each container [`legacy_restores`] finds on this side of the
/// device gets its name back and is started. Nothing is removed. Answers the names given back.
/// Answers the names given back, and the source's containers as they were listed before.
fn give_back_legacy(
    source: &Target,
    from: Kind,
    said: &dyn Fn(&str),
) -> Result<(Vec<String>, Vec<String>)> {
    let listed = docker::capture_on(
        source,
        &["ps", "-a", "--format", "{{.Names}}"],
        docker::READ_LIMIT,
    )?;
    if listed.code != Some(0) {
        bail!(
            "{} would not list its containers: {}",
            from.name(),
            last_words(&listed.stderr)
        );
    }
    let names: Vec<String> = listed
        .stdout
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let kept: Vec<String> = load_journal()
        .moved
        .iter()
        .filter(|moved| !moved.removed && moved.from == from.id())
        .flat_map(|moved| moved.containers.clone())
        .collect();
    let here = side::here();
    let mut given = Vec::new();
    for restore in legacy_restores(&names, &kept) {
        // Another side of this PC (a WSL distro with its own ic) keeps its own sandboxes: not ours to start.
        let Ok(inspect) = inspect_on(source, &restore.moved) else {
            continue;
        };
        if let side::Stamp::Side(kept_by) = side::stamp_in(env_of(&inspect).join("\0").as_bytes()) {
            if !kept_by.same(&here) {
                continue;
            }
        }
        match run_on(
            source,
            &["rename", &restore.moved, &restore.name],
            docker::READ_LIMIT,
        ) {
            Ok(()) => said(&format!("gave {} its name back", restore.name)),
            Err(Fail(reason)) => {
                ui::warn(&format!(
                    "could not give {} its name back: {reason}",
                    restore.name
                ));
                said(&format!(
                    "could not give {} its name back: {reason}",
                    restore.name
                ));
                continue;
            }
        }
        if let Err(Fail(reason)) =
            run_on(source, &["start", &restore.name], Duration::from_secs(120))
        {
            ui::warn(&format!("could not start {} again: {reason}", restore.name));
            said(&format!("could not start {}: {reason}", restore.name));
        }
        given.push(restore.name);
    }
    Ok((given, names))
}

/* WHAT AN OLDER IC'S MOVE LEFT ON OUR ENGINE (2026-11-20, intentic#48). ic 1.429.0 wrote nothing down of what it made on
 * the target, so a PC upgrading with its interrupted move found the next move refusing the move's own partial copy (about
 * 1.4 GB there) as somebody else's volume. Its rollback writes each such volume down as made, which the next move then
 * replaces; nothing is removed here. */

/// The volumes on the target that are one of `sources`' (slug, volume) pairs, which no move still keeps as a copy and
/// which are not yet written down as made: what an older ic's interrupted move left there. Pure.
fn legacy_leftovers(
    sources: &[(String, String)],
    on_target: &[String],
    journal: &Journal,
    to: &str,
) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = Vec::new();
    for (slug, volume) in sources {
        let kept = journal
            .moved
            .iter()
            .any(|moved| !moved.removed && moved.volumes.contains(volume));
        if on_target.contains(volume)
            && !kept
            && !made_by_a_move(journal, slug, to, volume)
            && !found.iter().any(|(_, seen)| seen == volume)
        {
            found.push((slug.clone(), volume.clone()));
        }
    }
    found
}

/// [`legacy_leftovers`] read off both engines and written down as made. Only on our own engine, and only when it
/// answers: best effort, said in the log.
fn note_legacy_leftovers(source: &Target, names: &[String], to: Kind, said: &dyn Fn(&str)) {
    let Some(target) = reachable(to) else {
        said(&format!(
            "{} does not answer: what the move left there is not written down.",
            to.name()
        ));
        return;
    };
    // Every sandbox the move set aside, and every one the source has by its name.
    let mut slugs: Vec<String> = legacy_restores(names, &[])
        .into_iter()
        .map(|restore| restore.slug)
        .collect();
    for slug in sandbox::slugs_of(names) {
        if !slugs.contains(&slug) {
            slugs.push(slug);
        }
    }
    let here = side::here();
    let mut sources: Vec<(String, String)> = Vec::new();
    for slug in &slugs {
        for name in [
            sandbox::container_of(slug),
            format!("{DIND_PREFIX}{slug}"),
            format!("{TUNNEL_PREFIX}{slug}"),
        ] {
            let Some(inspect) = [name.clone(), format!("{name}{MOVED_SUFFIX}")]
                .iter()
                .find_map(|candidate| inspect_on(source, candidate).ok())
            else {
                continue;
            };
            if let side::Stamp::Side(kept_by) =
                side::stamp_in(env_of(&inspect).join("\0").as_bytes())
            {
                if !kept_by.same(&here) {
                    continue;
                }
            }
            for (volume, _) in named_volumes(&inspect) {
                sources.push((slug.clone(), volume));
            }
        }
    }
    let Ok(listed) = docker::capture_on(
        &target,
        &["volume", "ls", "--format", "{{.Name}}"],
        docker::READ_LIMIT,
    ) else {
        return;
    };
    if listed.code != Some(0) {
        return;
    }
    let on_target: Vec<String> = listed
        .stdout
        .lines()
        .map(|line| line.trim().to_string())
        .collect();
    for (slug, volume) in legacy_leftovers(&sources, &on_target, &load_journal(), to.id()) {
        if note_made(&slug, to, &volume, false).is_ok() {
            said(&format!(
                "{volume} on {} is this move's partial copy: written down for the next move to replace",
                to.name()
            ));
        }
    }
}

/// `ic engine cleanup [--now]`: remove the copies a move left behind whose days are up (all of them with `now`).
pub fn cleanup(now: bool) -> Result<()> {
    // Off Windows the only copies left behind are a device move's (sandbox/device_move), on this machine's own docker.
    let device_only = !cfg!(windows);
    let mut acted = false;
    let journal = load_journal();
    let due: Vec<Moved> = if now {
        journal
            .moved
            .iter()
            .filter(|moved| !moved.removed)
            .cloned()
            .collect()
    } else {
        expired(&journal, now_ms())
    };
    let due: Vec<Moved> = due
        .into_iter()
        .filter(|moved| !device_only || moved.from == DEVICE_FROM)
        .collect();
    if due.is_empty() {
        return Ok(());
    }
    // An interrupted move's entry holds cleanup off too: the copies it set aside may share their names with the ones due.
    if journal.moving.is_some() {
        return Ok(());
    }
    let mut removed: Vec<(String, u64)> = Vec::new();
    for moved in &due {
        if moved.from == DEVICE_FROM {
            for container in &moved.containers {
                let _ = docker::capture_on(
                    &Target::DockerDesktop,
                    &["rm", "-f", container],
                    docker::READ_LIMIT,
                );
            }
            for volume in &moved.volumes {
                let _ = docker::capture_on(
                    &Target::DockerDesktop,
                    &["volume", "rm", volume],
                    docker::READ_LIMIT,
                );
            }
            if !acted {
                ui::act("clean up moved copies");
                acted = true;
            }
            ui::quiet(&format!(
                "removed the copy of {} this device kept after it moved to {}.",
                moved.slug, moved.to
            ));
            removed.push((moved.slug.clone(), moved.at));
            continue;
        }
        let Some(kind) = Kind::parse(&moved.from) else {
            continue;
        };
        // The engine the copies sit on is not the one in use: ours is started for the cleanup and rests again after;
        // Docker Desktop is only used when it already answers, and its copies wait for the next round otherwise.
        let engine = match kind {
            Kind::Intentic => {
                let Some(env) = super::reach() else { continue };
                if super::start().is_err() {
                    continue;
                }
                Target::Intentic(env)
            }
            _ => Target::DockerDesktop,
        };
        if !answers(&engine) {
            continue;
        }
        for container in &moved.containers {
            let _ = docker::capture_on(&engine, &["rm", "-f", container], docker::READ_LIMIT);
        }
        for volume in &moved.volumes {
            let _ = docker::capture_on(&engine, &["volume", "rm", volume], docker::READ_LIMIT);
        }
        for image in &moved.images {
            let _ = docker::capture_on(&engine, &["image", "rm", image], docker::READ_LIMIT);
        }
        if !acted {
            ui::act("clean up moved copies");
            acted = true;
        }
        ui::quiet(&format!(
            "removed the copy of {} that {} kept after it moved.",
            moved.slug,
            kind.name()
        ));
        removed.push((moved.slug.clone(), moved.at));
        if kind == Kind::Intentic && super::in_use() != Kind::Intentic {
            let _ = super::rest("not in use since this device's sandboxes moved to Docker Desktop");
        }
    }
    update_journal(|journal| {
        for moved in journal.moved.iter_mut() {
            if removed
                .iter()
                .any(|(slug, at)| *slug == moved.slug && *at == moved.at)
            {
                moved.removed = true;
            }
        }
    })?;
    if acted {
        ui::done("cleaned up");
    }
    Ok(())
}

/* ——— Getting both engines ready. ——— */

fn ready_target(to: Kind, log: &Log) -> Result<Target> {
    match to {
        Kind::Intentic => {
            let status = super::status();
            if !status.installed || super::reach().is_none() {
                ui::note("installing the intentic engine first (about 95 MB)…");
                let mut last: Option<(String, Option<u64>)> = None;
                super::install(
                    &mut |sentence, percent| {
                        let now = (sentence.to_string(), percent);
                        if last.as_ref() == Some(&now) {
                            return;
                        }
                        last = Some(now);
                        log.line(sentence);
                        say(
                            "",
                            "engine",
                            json!({ "sentence": sentence, "percent": percent }),
                        );
                    },
                    false,
                )
                .map_err(Fail)?;
            } else if !status.running {
                super::start().map_err(Fail)?;
            }
            let env = super::reach()
                .ok_or_else(|| Fail("the intentic engine did not install.".to_string()))?;
            let target = Target::Intentic(env);
            if !answers(&target) {
                bail!("the intentic engine is installed but does not answer — `ic engine start`, then try again.");
            }
            Ok(target)
        }
        _ => {
            if !super::docker_desktop_installed() {
                bail!("Docker Desktop is not installed on this device, so there is nothing to move back to.");
            }
            let target = Target::DockerDesktop;
            if !answers(&target) {
                start_docker_desktop();
                if !wait_answering(&target, Duration::from_secs(300)) {
                    bail!("Docker Desktop did not start within 5 minutes — open it, wait until it says the engine is running, then try again.");
                }
            }
            Ok(target)
        }
    }
}

fn ready_source(from: Kind) -> Result<Target> {
    let source = match from {
        Kind::Intentic => {
            let env = super::reach().ok_or_else(|| {
                Fail("the intentic engine is not installed on this device.".to_string())
            })?;
            if !answers(&Target::Intentic(env.clone())) {
                super::start().map_err(Fail)?;
            }
            Target::Intentic(env)
        }
        _ => Target::DockerDesktop,
    };
    if !answers(&source) {
        if source == Target::DockerDesktop {
            // Up to five minutes with nothing else to say: the app's card says what the move waits for meanwhile.
            say("", "source", json!({ "starting": "dockerDesktop" }));
            start_docker_desktop();
            if wait_answering(&source, Duration::from_secs(300)) {
                return Ok(source);
            }
        }
        bail!(
            "{} does not answer, so its sandboxes cannot be read — start it, then try again.",
            from.name()
        );
    }
    Ok(source)
}

fn answers(target: &Target) -> bool {
    docker::capture_on(
        target,
        &["version", "--format", "{{.Server.Os}}"],
        Duration::from_secs(20),
    )
    .is_ok_and(|ran| ran.code == Some(0) && ran.stdout.trim() == "linux")
}

fn wait_answering(target: &Target, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if answers(target) {
            return true;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    false
}

fn start_docker_desktop() {
    #[cfg(windows)]
    {
        use intentic_docker_host::desktop_app;
        if let Some(exe) = desktop_app::default_installs_here()
            .into_iter()
            .find(|path| std::path::Path::new(path).exists())
        {
            let _ = docker::run_bounded(
                "cmd.exe",
                &["/c", "start", "", &exe],
                Duration::from_secs(30),
            );
        }
    }
}

/// The record's switch, and this process's own `docker` with it.
fn switch(to: Kind) -> Result<()> {
    match to {
        Kind::Intentic => super::set_active(true).map_err(Fail),
        _ => {
            if super::EngineRecord::load().is_some() {
                super::set_active(false).map_err(Fail)?;
            }
            Ok(())
        }
    }
}

/* ——— What moves. ——— */

/// One sandbox and what lives beside it, read off the engine it leaves.
#[derive(Debug, Clone)]
struct Sandbox {
    slug: String,
    container: String,
    /// The whole `docker inspect` of its container.
    inspect: Value,
    /// The image its container runs (SANDBOX_IMAGE), and the base it composes against when that is another image here.
    images: Vec<String>,
    /// Containers beside it: the Windows deploy target, an old tunnel sidecar.
    companions: Vec<(String, Value)>,
    /// Every named volume those containers mount, with whether it holds a Docker engine's data.
    volumes: Vec<(String, bool)>,
    bytes: u64,
}

struct Plan {
    sandboxes: Vec<Sandbox>,
    left_alone: Vec<(String, String)>,
    bytes: u64,
}

fn plan(source: &Target, target: &Target, from: Kind, to: Kind, log: &Log) -> Result<Plan> {
    let listed = docker::capture_on(
        source,
        &[
            "ps",
            "-a",
            "--format",
            "{{.Names}}",
            "--filter",
            &format!("name=^{CONTAINER_PREFIX}"),
        ],
        docker::READ_LIMIT,
    )?;
    if listed.code != Some(0) {
        bail!(
            "{} would not list its containers: {}",
            from.name(),
            listed.stderr
        );
    }
    let names: Vec<String> = listed
        .stdout
        .lines()
        .map(|line| line.trim().to_string())
        .collect();
    let here = side::here();
    let mut sandboxes = Vec::new();
    let mut left_alone = Vec::new();
    let mut bytes = 0u64;
    for slug in sandbox::slugs_of(&names) {
        let container = sandbox::container_of(&slug);
        if !names.contains(&container) {
            bail!("an interrupted update left {slug} set aside on {} — start it (`ic sandbox start {slug}`) before moving.", from.name());
        }
        let inspect = inspect_on(source, &container)?;
        let env = env_of(&inspect);
        if let side::Stamp::Side(kept) = side::stamp_in(env.join("\0").as_bytes()) {
            if !kept.same(&here) {
                left_alone.push((slug.clone(), kept.name()));
                continue;
            }
        }
        mounted_key_file(&inspect)?;
        if to == Kind::Intentic && uses_gpu(&inspect, &env) {
            bail!("{slug} uses this device's GPU, which the intentic engine cannot pass through yet. It stays on Docker Desktop, and so does this device: nothing was moved.");
        }
        let Some(image) = env_value(&env, "SANDBOX_IMAGE") else {
            bail!("{slug} predates the run contract, so it cannot be made again on another engine — run `ic sandbox update {slug}` once, then move.");
        };
        let mut images = vec![image.clone()];
        if let Some(base) = env_value(&env, "SANDBOX_BASE_IMAGE") {
            if base != image && image_id_on(source, &base).is_some() {
                images.push(base);
            }
        }
        let mut companions = Vec::new();
        for name in [
            format!("{DIND_PREFIX}{slug}"),
            format!("{TUNNEL_PREFIX}{slug}"),
        ] {
            if names.contains(&name)
                || docker::capture_on(source, &["inspect", &name], docker::READ_LIMIT)
                    .is_ok_and(|ran| ran.code == Some(0))
            {
                companions.push((name.clone(), inspect_on(source, &name)?));
            }
        }
        let mut volumes: Vec<(String, bool)> = Vec::new();
        for spec in std::iter::once(&inspect).chain(companions.iter().map(|(_, inspect)| inspect)) {
            for (volume, destination) in named_volumes(spec) {
                if !volumes.iter().any(|(seen, _)| *seen == volume) {
                    volumes.push((volume, destination == DOCKER_DATA));
                }
            }
        }
        let mut size = 0u64;
        for (volume, _) in &volumes {
            size += volume_bytes(source, volume, &image).unwrap_or(0);
        }
        for image in &images {
            if !same_image(source, target, image) {
                size += image_bytes(source, image).unwrap_or(0);
            }
        }
        log.line(&format!(
            "{slug}: {} volumes, {} bytes",
            volumes.len(),
            size
        ));
        bytes += size;
        sandboxes.push(Sandbox {
            slug,
            container,
            inspect,
            images,
            companions,
            volumes,
            bytes: size,
        });
    }
    Ok(Plan {
        sandboxes,
        left_alone,
        bytes,
    })
}

fn check_space(plan: &Plan, to: Kind) -> Result<()> {
    #[cfg(windows)]
    {
        let (free, root) = crate::checks::windows_free_bytes();
        if let Some(free) = free {
            if free < plan.bytes.saturating_add(SPARE_BYTES) {
                bail!(
                    "{} needs about {} free on {root} for the copies, and {} is free — free some space, then try again.",
                    to.name(),
                    gigabytes(plan.bytes.saturating_add(SPARE_BYTES)),
                    gigabytes(free)
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (plan, to);
    }
    Ok(())
}

/* ——— Moving one sandbox, and undoing it. ——— */

/// What a sandbox's move has done so far, so a failure anywhere undoes exactly that: kept in memory, and in the
/// journal's `moving.progress` for an ic that finds the move interrupted. Each source step is written down before it is
/// taken, so an entry may name a step that never happened; [`undo`] reads the engine before acting on one.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Carried {
    slug: String,
    /// Containers renamed aside on the source: (own name, `.moved` name).
    #[serde(default)]
    renamed: Vec<(String, String)>,
    /// Which of them were running, to start again.
    #[serde(default)]
    running: Vec<String>,
    /// Images committed from companions on the source, to carry them.
    #[serde(default)]
    committed: Vec<String>,
    /// Volumes this move created on the target.
    #[serde(default)]
    created_volumes: Vec<String>,
    /// Containers this move created on the target, the sandbox's included.
    #[serde(default)]
    created_containers: Vec<String>,
    /// Every volume carried, by name: what the source keeps for the days.
    #[serde(default)]
    volumes: Vec<String>,
}

impl Carried {
    fn new(sandbox: &Sandbox) -> Carried {
        Carried {
            slug: sandbox.slug.clone(),
            ..Carried::default()
        }
    }
}

fn move_one(
    sandbox: &Sandbox,
    source: &Target,
    target: &Target,
    to: Kind,
    carry: &mut Carried,
    log: &Log,
) -> Result<()> {
    let slug = &sandbox.slug;
    log.section(&format!("moving {slug}"));
    // Stopped and set aside, the sandbox first and what lives beside it after.
    let mut aside: Vec<(String, &Value)> = vec![(sandbox.container.clone(), &sandbox.inspect)];
    aside.extend(
        sandbox
            .companions
            .iter()
            .map(|(name, inspect)| (name.clone(), inspect)),
    );
    for (name, inspect) in &aside {
        let moved = format!("{name}{MOVED_SUFFIX}");
        if inspect["State"]["Running"].as_bool() == Some(true) {
            carry.running.push(name.clone());
        }
        // Written down before the stop and the rename, so an ic killed between them is undone by the next one.
        carry.renamed.push((name.clone(), moved.clone()));
        keep_progress(carry)?;
        say(slug, "stopping", json!({ "container": name }));
        run_on(
            source,
            &["stop", "-t", "60", name],
            Duration::from_secs(120),
        )?;
        let _ = run_on(source, &["rm", "-f", &moved], docker::READ_LIMIT);
        run_on(source, &["rename", name, &moved], docker::READ_LIMIT)?;
    }

    // The companions' own files (an SSH key the deploy target was given lives in its container, not on a volume) go
    // across as images of themselves.
    let mut images = sandbox.images.clone();
    let mut companion_images = Vec::new();
    for (name, _) in &sandbox.companions {
        let image = format!("intentic-moved-{}:{}", name, now_ms());
        carry.committed.push(image.clone());
        keep_progress(carry)?;
        run_on(
            source,
            &["commit", &format!("{name}{MOVED_SUFFIX}"), &image],
            Duration::from_secs(600),
        )?;
        images.push(image.clone());
        companion_images.push(image);
    }
    let missing: Vec<String> = images
        .iter()
        .filter(|image| !same_image(source, target, image))
        .cloned()
        .collect();
    if !missing.is_empty() {
        say(slug, "image", json!({ "images": missing }));
        carry_images(source, target, &missing, slug, log)?;
        for image in &missing {
            if !same_image(source, target, image) {
                bail!("{image} did not arrive whole on the other engine.");
            }
        }
    }

    // The volumes, each checked against the original after the copy.
    let helper = &sandbox.images[0];
    for (volume, docker_data) in &sandbox.volumes {
        prepare_volume(source, target, to, slug, volume, helper, carry)?;
        keep_progress(carry)?;
        let total = beating(|| volume_bytes(source, volume, helper)).unwrap_or(0);
        say(slug, "volume", json!({ "volume": volume, "total": total }));
        copy_volume(
            source,
            target,
            volume,
            *docker_data,
            helper,
            slug,
            total,
            log,
        )?;
        let theirs = beating(|| manifest(source, volume, helper, *docker_data))?;
        let ours = beating(|| manifest(target, volume, helper, *docker_data))?;
        if theirs != ours {
            bail!(
                "the copy of {volume} does not match the original ({} files there, {} here).",
                theirs.0,
                ours.0
            );
        }
        log.line(&format!("{volume}: {} files match", ours.0));
        carry.volumes.push(volume.clone());
        keep_progress(carry)?;
    }

    // The sandbox's network, then a stopped placeholder the reshape makes the sandbox from.
    ensure_network_on(target, slug)?;
    let placeholder = placeholder_args(&sandbox.inspect, &sandbox.container, &sandbox.images[0]);
    let refs: Vec<&str> = placeholder.iter().map(String::as_str).collect();
    note_made(slug, to, &sandbox.container, true)?;
    note_made(slug, to, &sandbox::parked_of(slug), true)?;
    run_on(target, &refs, Duration::from_secs(120))?;
    carry.created_containers.push(sandbox.container.clone());
    carry.created_containers.push(sandbox::parked_of(slug));
    keep_progress(carry)?;

    say(slug, "starting", json!({}));
    // The placeholder carries no bind, so the reshape finds no key mounted on it: handed the key the sandbox had as the
    // operator's file, it mounts that one, by the same door it mounts its own (at_rest.rs `Source::Given`).
    let key = mounted_key_file(&sandbox.inspect)?;
    let made = beating(|| {
        with_key_file(key.as_deref(), || {
            with_engine(target, || {
                crate::sandbox::recreate::run(
                    crate::sandbox::recreate::Mode::Reshape(crate::shape::Ask::default()),
                    Some(slug.clone()),
                    crate::sandbox::recreate::Preflight::Skip,
                )
            })
        })
    });
    made.map_err(|Fail(reason)| {
        Fail(format!(
            "the sandbox did not come up on the other engine: {reason}"
        ))
    })?;
    heartbeat();

    // What lived beside it, as it was.
    for ((name, inspect), image) in sandbox.companions.iter().zip(&companion_images) {
        let args = clone_args(inspect, name, image);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_on(target, &refs, Duration::from_secs(120))?;
        carry.created_containers.push(name.clone());
        keep_progress(carry)?;
        if carry.running.contains(name) {
            run_on(target, &["start", name], Duration::from_secs(120))?;
        }
    }

    // A sandbox somebody had stopped stays stopped.
    if !carry.running.contains(&sandbox.container) {
        with_engine(target, || {
            crate::sandbox::power::run(crate::sandbox::power::Power::Stop, Some(slug.clone()))
        })?;
    }
    say(slug, "moved", json!({}));
    Ok(())
}

/// Put a sandbox back as it was on the source: what the target got is removed, and the source's copies take their
/// names back and run again if they ran. Best effort, and said when a step fails. Without a `target` (it does not
/// answer: an interrupted move's recovery) nothing is removed there, and what the move made stays recorded as [`Made`].
fn undo(carry: &Carried, source: &Target, target: Option<&Target>, to: Kind, log: &Log) {
    log.section(&format!("undoing {}", carry.slug));
    if let Some(target) = target {
        remove_made(carry, target, to, log);
    }
    for (name, moved) in &carry.renamed {
        match give_back(source, name, moved) {
            Ok(true) => log.line(&format!("gave {name} its name back")),
            Ok(false) => {}
            Err(Fail(reason)) => {
                log.line(&format!("could not give {name} its name back: {reason}"));
                crate::ui::warn(&format!("could not give {name} its name back: {reason}"));
            }
        }
    }
    for name in &carry.running {
        if let Err(Fail(reason)) = run_on(source, &["start", name], Duration::from_secs(120)) {
            log.line(&format!("could not start {name} again: {reason}"));
            crate::ui::warn(&format!("could not start {name} again: {reason}"));
        }
    }
    for image in &carry.committed {
        let _ = docker::capture_on(source, &["image", "rm", image], docker::READ_LIMIT);
    }
    ui::note(&format!("{} is back as it was.", carry.slug));
}

/// `moved` renamed back to `name` on the source, when the move got that far: a container still under its own name was
/// never set aside (its rename is written down before it is made), and is left as it is. Answers whether it renamed.
fn give_back(source: &Target, name: &str, moved: &str) -> Result<bool> {
    let there = |container: &str| {
        docker::capture_on(
            source,
            &["container", "inspect", container],
            docker::READ_LIMIT,
        )
        .is_ok_and(|ran| ran.code == Some(0) && !ran.timed_out)
    };
    if there(name) || !there(moved) {
        return Ok(false);
    }
    run_on(source, &["rename", moved, name], docker::READ_LIMIT)?;
    Ok(true)
}

/// What a sandbox's move made on the target, removed. Removed only when the engine says so: what it refused stays
/// recorded as made ([`Made`]), for the next move to replace.
fn remove_made(carry: &Carried, target: &Target, to: Kind, log: &Log) {
    let mut gone: Vec<String> = Vec::new();
    let mut removed = |args: &[&str], name: &str| {
        let ran = docker::capture_on(target, args, docker::READ_LIMIT);
        if ran
            .as_ref()
            .is_ok_and(|ran| ran.code == Some(0) && !ran.timed_out)
        {
            gone.push(name.to_string());
        } else {
            let why = ran.map_or_else(|Fail(why)| why, |ran| ran.stderr.trim().to_string());
            log.line(&format!(
                "could not remove {name} from the other engine: {why}"
            ));
        }
    };
    for container in carry.created_containers.iter().rev() {
        removed(&["rm", "-f", container], container);
    }
    for volume in &carry.created_volumes {
        removed(&["volume", "rm", "-f", volume], volume);
    }
    let _ = update_journal(|journal| forget_made(journal, &carry.slug, to.id(), Some(&gone)));
}

/// A volume of the same name on the target is one an earlier move left there (a copy it kept, or one it made and never
/// finished: [`Made`]), which this move supersedes, or an empty one, which holds nothing to lose; anything else is
/// somebody else's, which it refuses to touch.
fn prepare_volume(
    source: &Target,
    target: &Target,
    to: Kind,
    slug: &str,
    volume: &str,
    helper: &str,
    carry: &mut Carried,
) -> Result<()> {
    let exists = docker::capture_on(target, &["volume", "inspect", volume], docker::READ_LIMIT)
        .is_ok_and(|ran| ran.code == Some(0));
    let journal = load_journal();
    // Only a copy an earlier move left on THIS engine: the journal names each by the engine it stayed on.
    let left_by_us = journal.moved.iter().any(|moved| {
        !moved.removed
            && moved.slug == slug
            && moved.from == to.id()
            && moved.volumes.iter().any(|v| v == volume)
    }) || made_by_a_move(&journal, slug, to.id(), volume);
    let empty = (exists && !left_by_us)
        .then(|| volume_empty(target, volume, helper))
        .flatten();
    match volume_action(exists, left_by_us, empty) {
        VolumeAction::Create => {}
        VolumeAction::Replace => {
            for moved in journal
                .moved
                .iter()
                .filter(|moved| moved.slug == slug && !moved.removed && moved.from == to.id())
            {
                for container in &moved.containers {
                    let _ = docker::capture_on(target, &["rm", "-f", container], docker::READ_LIMIT);
                }
            }
            clear_leftovers(target, &journal, slug, to);
            run_on(target, &["volume", "rm", volume], docker::READ_LIMIT)?;
        }
        VolumeAction::Adopt => run_on(target, &["volume", "rm", volume], docker::READ_LIMIT)?,
        VolumeAction::Refuse => bail!("a volume named {volume} already exists on the other engine, holds files, and no earlier move left it there — remove or rename it, then try again."),
    }
    note_made(slug, to, volume, false)?;
    create_like(source, target, volume)?;
    carry.created_volumes.push(volume.to_string());
    Ok(())
}

/// What a move for `slug` cut off before its undo left running or standing on the target and holding its volumes: its
/// copy helpers, and the containers it recorded as made. Best effort: `volume rm` after it says what still holds one.
fn clear_leftovers(target: &Target, journal: &Journal, slug: &str, to: Kind) {
    let mut names = vec![helper_name(slug, "write"), helper_name(slug, "read")];
    names.extend(
        journal
            .made
            .iter()
            .filter(|made| made.container && made.slug == slug && made.on == to.id())
            .map(|made| made.name.clone()),
    );
    for name in names {
        let _ = docker::capture_on(target, &["rm", "-f", &name], docker::READ_LIMIT);
    }
}

/// Whether `volume` on `on` holds nothing at all; None when that could not be read.
fn volume_empty(on: &Target, volume: &str, helper: &str) -> Option<bool> {
    let mount = format!("{volume}:/v:ro");
    let ran = docker::capture_on(
        on,
        &[
            "run",
            "--rm",
            "--network",
            "none",
            "--log-driver",
            "none",
            "-v",
            &mount,
            "--entrypoint",
            "find",
            helper,
            "/v",
            "-mindepth",
            "1",
            "-print",
            "-quit",
        ],
        Duration::from_secs(120),
    )
    .ok()
    .filter(|ran| ran.code == Some(0) && !ran.timed_out)?;
    Some(ran.stdout.trim().is_empty())
}

/// `volume` made on `target` with the labels it has on `source` (compose finds its own volumes by them).
pub(crate) fn create_like(source: &Target, target: &Target, volume: &str) -> Result<()> {
    let labels = docker::capture_on(
        source,
        &["volume", "inspect", "--format", "{{json .Labels}}", volume],
        docker::READ_LIMIT,
    )
    .ok()
    .and_then(|ran| serde_json::from_str::<Value>(&ran.stdout).ok())
    .unwrap_or(Value::Null);
    let mut args: Vec<String> = vec!["volume".into(), "create".into()];
    if let Some(labels) = labels.as_object() {
        for (key, value) in labels {
            args.push("--label".into());
            args.push(format!("{key}={}", value.as_str().unwrap_or_default()));
        }
    }
    args.push(volume.to_string());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_on(target, &refs, docker::READ_LIMIT)
}

/// `ic engine copy`: what to carry, and onto which engine.
pub struct CopyArgs {
    pub to: String,
    pub volumes: Vec<String>,
    pub images: Vec<String>,
    pub helper: Option<String>,
    /// Containers to carry as a stopped placeholder each (their image, labels, env and named volumes, the volumes
    /// copied too), which the ordinary recreate makes the container from on the other engine, as after a move.
    pub containers: Vec<String>,
    /// Both engines named by their sockets instead (`unix:///run/docker.sock`, `unix:///mnt/wsl/intentic-engine/
    /// docker.sock`): the copy then runs where both are, inside WSL, with no Windows hop between them.
    pub from_host: Option<String>,
    pub to_host: Option<String>,
}

/// An engine named by its socket or pipe, as `ic engine copy --from-host/--to-host` takes one.
fn by_host(host: &str) -> Target {
    Target::Intentic(docker::EngineEnv {
        host: host.to_string(),
        cert_path: String::new(),
        bin: std::path::PathBuf::new(),
        pipe: None,
    })
}

/// Named volumes and images from one engine to the other, the way a move carries a sandbox's (each image's layers
/// compared after, each volume's every file and size), for what a move leaves alone: the containers a WSL distro keeps
/// for itself, such as a developer's dev sandbox and the database its `docker compose` runs. Nothing is switched, stopped
/// or removed: a volume something still runs on is refused, one already on the other engine is never overwritten, and
/// the containers are made again by whoever made them (`pnpm swap:sandbox`, `docker compose up`) once the distro's
/// docker reaches the other engine (`ic engine wsl enable`).
pub fn copy(args: CopyArgs) -> Result<()> {
    let explicit = match (&args.from_host, &args.to_host) {
        (Some(from), Some(to)) => Some((from.clone(), to.clone())),
        (None, None) => None,
        _ => bail!("name both engines by their sockets (--from-host and --to-host), or neither."),
    };
    if explicit.is_none() && !cfg!(windows) {
        bail!("ic engine copy runs on Windows, where both engines are reachable, or anywhere with --from-host and --to-host.");
    }
    let to = Kind::parse(&args.to)
        .filter(|kind| *kind != Kind::Native)
        .unwrap_or(Kind::Intentic);
    if explicit.is_none() && Kind::parse(&args.to).is_none() {
        bail!("copy to `intentic` or `docker-desktop`, not '{}'.", args.to);
    }
    let from = if to == Kind::Intentic {
        Kind::DockerDesktop
    } else {
        Kind::Intentic
    };
    if args.volumes.is_empty() && args.images.is_empty() && args.containers.is_empty() {
        bail!("name what to copy: --container, --volume and --image, each as often as needed.");
    }
    let log = Log::create_named("engine", "copy")?;
    let (source, target) = match &explicit {
        Some((from_host, to_host)) => {
            let (source, target) = (by_host(from_host), by_host(to_host));
            for (end, host) in [(&source, from_host), (&target, to_host)] {
                if !answers(end) {
                    bail!("no engine answers at {host}.");
                }
            }
            (source, target)
        }
        None => (ready_source(from)?, ready_target(to, &log)?),
    };
    let from_name = explicit
        .as_ref()
        .map(|(host, _)| host.clone())
        .unwrap_or_else(|| from.name().to_string());
    let to_name = explicit
        .as_ref()
        .map(|(_, host)| host.clone())
        .unwrap_or_else(|| to.name().to_string());
    ui::begin("copy sandboxes between engines", vec![], None);
    // A container brings its image and its named volumes along.
    let mut args = args;
    let mut placeholders: Vec<(String, Value)> = Vec::new();
    for name in &args.containers {
        let inspect = inspect_on(&source, name)?;
        if inspect["State"]["Running"].as_bool() == Some(true) {
            bail!(
                "{name} is running on {}: stop it first, so its volumes are copied as they stay.",
                from_name
            );
        }
        if docker::capture_on(&target, &["container", "inspect", name], docker::READ_LIMIT)
            .is_ok_and(|ran| ran.code == Some(0))
        {
            bail!("a container named {name} is on {} already.", to_name);
        }
        if let Some(image) = inspect["Config"]["Image"].as_str() {
            if !args.images.iter().any(|known| known == image) {
                args.images.push(image.to_string());
            }
        }
        for (volume, _) in named_volumes(&inspect) {
            if !args.volumes.contains(&volume) {
                args.volumes.push(volume);
            }
        }
        placeholders.push((name.clone(), inspect));
    }
    // The image that copies the volumes: the one named, else the first image, a container's own included (checked
    // after the containers added theirs: `--container` alone names one).
    let helper = args.helper.clone().or_else(|| args.images.first().cloned());
    if helper.is_none() && !args.volumes.is_empty() {
        bail!("name the image that copies the volumes (--helper, or an --image): one with GNU tar and find, as the sandbox image has.");
    }
    for volume in &args.volumes {
        if docker::capture_on(&source, &["volume", "inspect", volume], docker::READ_LIMIT)
            .map(|ran| ran.code != Some(0))
            .unwrap_or(true)
        {
            bail!("there is no volume named {volume} on {}.", from_name);
        }
        let users = docker::capture_on(
            &source,
            &[
                "ps",
                "--format",
                "{{.Names}}",
                "--filter",
                &format!("volume={volume}"),
            ],
            docker::READ_LIMIT,
        )
        .map(|ran| ran.stdout.split_whitespace().collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
        if !users.is_empty() {
            bail!("{volume} is in use by {users} on {}: stop it first, so the copy is of files that stay put.", from_name);
        }
        if docker::capture_on(&target, &["volume", "inspect", volume], docker::READ_LIMIT)
            .is_ok_and(|ran| ran.code == Some(0))
        {
            bail!("a volume named {volume} is on {} already: remove it there first if it is to be replaced.", to_name);
        }
    }
    let mut images = args.images.clone();
    if let Some(helper) = &helper {
        if !args.volumes.is_empty()
            && image_id_on(&target, helper).is_none()
            && !images.contains(helper)
        {
            images.push(helper.clone());
        }
    }
    let missing: Vec<String> = images
        .iter()
        .filter(|image| !same_image(&source, &target, image))
        .cloned()
        .collect();
    if !missing.is_empty() {
        let total: u64 = missing
            .iter()
            .filter_map(|image| image_bytes(&source, image))
            .sum();
        ui::step(
            "copy-images",
            &format!(
                "copying {} ({}) to {}…",
                missing.join(", "),
                gigabytes(total),
                to_name
            ),
        );
        carry_images(&source, &target, &missing, "copy", &log)?;
        for image in &missing {
            if !same_image(&source, &target, image) {
                bail!("{image} did not arrive whole on {}.", to_name);
            }
        }
    }
    let Some(helper) = helper else {
        ui::finished("copied", None, &format!("copied to {}", to_name), &[]);
        return Ok(());
    };
    let helper_image = helper.clone();
    for volume in &args.volumes {
        let docker_data = volume.starts_with("intentic-docker-");
        let total = volume_bytes(&source, volume, &helper).unwrap_or(0);
        ui::step(
            "copy-volume",
            &format!(
                "copying volume {volume} ({}) to {}…",
                gigabytes(total),
                to_name
            ),
        );
        create_like(&source, &target, volume)?;
        let copied = copy_volume(
            &source,
            &target,
            volume,
            docker_data,
            &helper,
            "copy",
            total,
            &log,
        )
        .and_then(|()| {
            let theirs = manifest(&source, volume, &helper, docker_data)?;
            let ours = manifest(&target, volume, &helper, docker_data)?;
            if theirs != ours {
                bail!(
                    "{volume} on {} does not list the same files as on {}.",
                    to_name,
                    from_name
                );
            }
            Ok(theirs.0)
        });
        match copied {
            Ok(files) => ui::detail(&format!("{volume}: {files} files, the same on both.")),
            Err(error) => {
                let _ = docker::capture_on(&target, &["volume", "rm", volume], docker::READ_LIMIT);
                return Err(error);
            }
        }
    }
    for (name, inspect) in &placeholders {
        let image = inspect["Config"]["Image"].as_str().unwrap_or(&helper_image);
        let create = placeholder_args(inspect, name, image);
        let refs: Vec<&str> = create.iter().map(String::as_str).collect();
        run_on(&target, &refs, docker::READ_LIMIT)?;
        ui::detail(&format!(
            "{name}: a stopped placeholder on {}, for its recreate to make it from.",
            to_name
        ));
    }
    ui::finished(
        "copied",
        None,
        &format!(
            "Copied to {}. {} keeps its own copies until you remove them.",
            to_name, from_name
        ),
        &[],
    );
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum VolumeAction {
    Create,
    /// A copy a move left there: removed with what it left beside it, then made again.
    Replace,
    /// Nobody's record, and nothing in it: made again, with nothing lost.
    Adopt,
    Refuse,
}

/// `empty`: whether a volume no move left there holds nothing (None when that could not be read, which refuses). Pure.
fn volume_action(
    exists_on_target: bool,
    left_by_an_earlier_move: bool,
    empty: Option<bool>,
) -> VolumeAction {
    match (exists_on_target, left_by_an_earlier_move, empty) {
        (false, _, _) => VolumeAction::Create,
        (true, true, _) => VolumeAction::Replace,
        (true, false, Some(true)) => VolumeAction::Adopt,
        (true, false, _) => VolumeAction::Refuse,
    }
}

#[allow(clippy::too_many_arguments)]
fn copy_volume(
    source: &Target,
    target: &Target,
    volume: &str,
    docker_data: bool,
    helper: &str,
    slug: &str,
    total: u64,
    log: &Log,
) -> Result<()> {
    let from_mount = format!("{volume}:/from:ro");
    let to_mount = format!("{volume}:/to");
    let reading = helper_name(slug, "read");
    let writing = helper_name(slug, "write");
    let mut out: Vec<&str> = vec![
        "run",
        "--rm",
        "--name",
        reading.as_str(),
        "--network",
        "none",
        "--log-driver",
        "none",
    ];
    let mut into: Vec<&str> = vec![
        "run",
        "--rm",
        "-i",
        "--name",
        writing.as_str(),
        "--network",
        "none",
        "--log-driver",
        "none",
    ];
    if docker_data {
        out.push("--privileged");
        into.push("--privileged");
    }
    out.extend_from_slice(&["-v", from_mount.as_str(), "--entrypoint", "tar", helper]);
    out.extend_from_slice(TAR_OUT);
    into.extend_from_slice(&["-v", to_mount.as_str(), "--entrypoint", "tar", helper]);
    into.extend_from_slice(TAR_IN);
    // A stream cut short is sent again: tar extracts over what the cut attempt left, and the manifest the caller
    // compares afterwards is what proves the copy whole.
    let mut attempt = 1;
    let copied = loop {
        let _ = docker::capture_on(source, &["rm", "-f", &reading], docker::READ_LIMIT);
        let _ = docker::capture_on(target, &["rm", "-f", &writing], docker::READ_LIMIT);
        let copied = pipe(
            archive_command(source, &out),
            archive_command(target, &into),
            slug,
            "volume",
            total,
            GNU_TAR_RECORD,
            log,
        );
        match &copied {
            Err(Fail(why)) if why.starts_with(CUT_SHORT) && attempt < COPY_ATTEMPTS => {
                log.line(&format!("{volume}: attempt {attempt} of {COPY_ATTEMPTS} was cut short; sending it again"));
                attempt += 1;
            }
            _ => break copied,
        }
    };
    // A CLI killed for a stall leaves its container running in the daemon: named, it is found and ended here.
    let _ = docker::capture_on(source, &["rm", "-f", &reading], docker::READ_LIMIT);
    let _ = docker::capture_on(target, &["rm", "-f", &writing], docker::READ_LIMIT);
    copied
}

/// A helper container's name: per sandbox and per end, so one left by a killed run is the next run's to remove.
pub(crate) fn helper_name(slug: &str, end: &str) -> String {
    format!("intentic-move-{slug}-{end}")
}

/// GNU tar on both ends (the sandbox image is Debian): numeric owners, extended attributes of every namespace (an
/// overlay layer's `trusted.overlay.*` are what make its deletions deletions), ACLs, sparse files kept sparse.
pub(crate) const TAR_OUT: &[&str] = &[
    "-C",
    "/from",
    "--numeric-owner",
    "--xattrs",
    "--xattrs-include=*",
    "--acls",
    "--sparse",
    "-cf",
    "-",
    ".",
];
pub(crate) const TAR_IN: &[&str] = &[
    "-C",
    "/to",
    "--numeric-owner",
    "--xattrs",
    "--xattrs-include=*",
    "--acls",
    "--same-owner",
    "-xpf",
    "-",
];

/// Every file, link and device in a volume with its size, listed and hashed: the same on both sides after a copy that
/// lost nothing. Sockets are left out, since tar does not carry them. Answers (entries, hash).
const MANIFEST: &str = "cd /v && find . -xdev ! -type d ! -type s -printf '%y %s %p\\n' | LC_ALL=C sort > /tmp/m && wc -l < /tmp/m && sha256sum < /tmp/m";

pub(crate) fn manifest(
    on: &Target,
    volume: &str,
    helper: &str,
    docker_data: bool,
) -> Result<(u64, String)> {
    let mount = format!("{volume}:/v:ro");
    let mut args: Vec<&str> = vec!["run", "--rm", "--network", "none", "--log-driver", "none"];
    if docker_data {
        args.push("--privileged");
    }
    args.extend_from_slice(&[
        "-v",
        mount.as_str(),
        "--entrypoint",
        "sh",
        helper,
        "-c",
        MANIFEST,
    ]);
    let ran = docker::capture_on(on, &args, Duration::from_secs(1800))?;
    if ran.code != Some(0) {
        bail!("could not list the files of {volume}: {}", ran.stderr);
    }
    parse_manifest(&ran.stdout)
        .ok_or_else(|| Fail(format!("could not read the file list of {volume}")))
}

pub(crate) fn parse_manifest(out: &str) -> Option<(u64, String)> {
    let mut lines = out.lines().map(str::trim).filter(|line| !line.is_empty());
    let count = lines.next()?.parse().ok()?;
    let hash = lines.next()?.split_whitespace().next()?.to_string();
    Some((count, hash))
}

/// Bulk archives use the engine's TLS endpoint directly. The optional pipe relay can end a tar stream early while
/// docker still exits 0 (nightly 40291565927); file listings and ordinary commands can keep using the faster relay.
pub(crate) fn archive_command(on: &Target, args: &[&str]) -> Command {
    match on {
        Target::Intentic(env) => {
            let mut direct = env.clone();
            direct.pipe = None;
            docker::command_on(&Target::Intentic(direct), args)
        }
        Target::DockerDesktop => docker::command_on(on, args),
    }
}

/// `from`'s stdout into `to`'s stdin, counted for the progress line, and killed if no byte moves for [`STALL`]. A
/// stream is whole `record`s; one the writer refused that stops between them was cut short ([`CUT_SHORT`]).
#[allow(clippy::too_many_arguments)]
pub(crate) fn pipe(
    mut from: Command,
    mut to: Command,
    slug: &str,
    step: &str,
    total: u64,
    record: u64,
    log: &Log,
) -> Result<()> {
    from.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    to.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut reader = from
        .spawn()
        .map_err(|error| Fail(format!("could not run docker: {error}")))?;
    let mut writer = match to.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = reader.kill();
            bail!("could not run docker: {error}");
        }
    };
    let from_err = tail_of(reader.stderr.take());
    let to_err = tail_of(writer.stderr.take());
    let moved = Arc::new(AtomicU64::new(0));
    let finished = Arc::new(AtomicBool::new(false));
    let stalled = Arc::new(AtomicBool::new(false));
    let watch = {
        let moved = Arc::clone(&moved);
        let finished = Arc::clone(&finished);
        let stalled = Arc::clone(&stalled);
        let reader_id = reader.id();
        let writer_id = writer.id();
        std::thread::spawn(move || {
            let mut last = 0u64;
            let mut since = Instant::now();
            while !finished.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(2));
                let now = moved.load(Ordering::SeqCst);
                if now != last {
                    last = now;
                    since = Instant::now();
                } else if since.elapsed() > STALL {
                    stalled.store(true, Ordering::SeqCst);
                    kill_pid(reader_id);
                    kill_pid(writer_id);
                    return;
                }
            }
        })
    };
    let copied = {
        let mut input = reader.stdout.take().expect("piped above");
        let mut output = writer.stdin.take().expect("piped above");
        let mut buffer = vec![0u8; 1 << 20];
        let mut last_said = Instant::now();
        let mut last_beat = Instant::now();
        let mut result: std::io::Result<()> = Ok(());
        loop {
            let read = match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => {
                    result = Err(error);
                    break;
                }
            };
            if let Err(error) = output.write_all(&buffer[..read]) {
                result = Err(error);
                break;
            }
            let done = moved.fetch_add(read as u64, Ordering::SeqCst) + read as u64;
            if last_said.elapsed() > Duration::from_secs(2) {
                last_said = Instant::now();
                say(slug, step, json!({ "done": done, "total": total }));
            }
            if last_beat.elapsed() > Duration::from_secs(30) {
                last_beat = Instant::now();
                heartbeat();
            }
        }
        drop(output);
        result
    };
    // The far side stopped taking bytes (it failed, or was killed): the near side would wait forever on a pipe nobody
    // reads, so it is ended rather than waited on.
    if copied.is_err() {
        kill_pid(reader.id());
    }
    let from_status = reader.wait();
    let to_status = writer.wait();
    finished.store(true, Ordering::SeqCst);
    let _ = watch.join();
    let done = moved.load(Ordering::SeqCst);
    say(
        slug,
        step,
        json!({ "done": done, "total": total.max(done) }),
    );
    let said = |tail: &std::sync::mpsc::Receiver<String>| {
        tail.recv_timeout(Duration::from_secs(5))
            .unwrap_or_default()
    };
    let (from_said, to_said) = (said(&from_err), said(&to_err));
    log.line(&format!(
        "{step}: {done} bytes; sent: {from_said}; received: {to_said}"
    ));
    if stalled.load(Ordering::SeqCst) {
        bail!(
            "the copy stopped moving for {} minutes.",
            STALL.as_secs() / 60
        );
    }
    let ok = |status: std::io::Result<std::process::ExitStatus>| {
        status.is_ok_and(|status| status.success())
    };
    if !ok(from_status) {
        bail!("reading it failed: {}", copy_diagnostic(&from_said));
    }
    let wrote = ok(to_status) && copied.is_ok();
    if !wrote && cut_short(done, record) {
        bail!(
            "{CUT_SHORT} after {done} bytes, though the reading side said it finished: {}",
            copy_diagnostic(&to_said)
        );
    }
    if !wrote {
        bail!("writing it failed: {}", copy_diagnostic(&to_said));
    }
    Ok(())
}

/// Said when the stream ended mid-archive; [`copy_volume`] retries a copy that failed this way.
const CUT_SHORT: &str = "the archive stream ended mid-block";

/// GNU `tar -cf -` writes whole records of 20 blocks, its end included; `docker save` (Go's archive/tar) pads only to
/// whole 512-byte blocks.
pub(crate) const GNU_TAR_RECORD: u64 = 10_240;
pub(crate) const TAR_BLOCK: u64 = 512;

/// A stream that is not whole records was cut short on the way: the reading `docker` CLI on Intentic's engine has
/// exited 0 with the stream ended mid-record, over the pipe relay (nightly 40291565927) and over the direct TLS
/// endpoint too (nightly 43471063277: 336459776 bytes of a volume's GNU tar, the writer's tar "Unexpected EOF in
/// archive"), while the same volume had crossed whole the other way minutes before.
pub(crate) fn cut_short(bytes: u64, record: u64) -> bool {
    !bytes.is_multiple_of(record)
}

/// How many times one volume's stream is sent before a cut-short stream fails the move.
const COPY_ATTEMPTS: u32 = 3;

/// How long one image's pull onto the other engine may take: a sandbox image is gigabytes on a home connection.
const PULL_LIMIT: Duration = Duration::from_secs(90 * 60);

/// Put `images` on `target` as they are on `source`. An image that came from a registry is pulled there by the digest
/// it was pulled as; the rest go through `docker save | docker load`. Docker Desktop's containerd store keeps the
/// compressed blob only of a layer it downloaded, not of one another image had already unpacked, and its `docker save`
/// then exits 0 with the manifests and none of the layers (53 KB for an 8 GB sandbox image, 2026-10-18), so a save
/// is the last resort, not the first. The caller checks each image arrived whole either way.
fn carry_images(
    source: &Target,
    target: &Target,
    images: &[String],
    slug: &str,
    log: &Log,
) -> Result<()> {
    let mut rest: Vec<&str> = Vec::new();
    for image in images {
        let pulled = repo_digest(source, image)
            .is_some_and(|digest| pull_as(target, &digest, image, slug, log))
            && same_image(source, target, image);
        if !pulled {
            rest.push(image);
        }
    }
    if rest.is_empty() {
        return Ok(());
    }
    let total: u64 = rest
        .iter()
        .filter_map(|image| image_bytes(source, image))
        .sum();
    let mut save: Vec<&str> = vec!["save"];
    save.extend(rest.iter().copied());
    pipe(
        archive_command(source, &save),
        archive_command(target, &["load", "-q"]),
        slug,
        "image",
        total,
        TAR_BLOCK,
        log,
    )
}

/// The `repo@sha256:…` `image` was pulled as on `on`, of its own repository; None for an image built or committed
/// there, which no registry holds.
pub(crate) fn repo_digest(on: &Target, image: &str) -> Option<String> {
    let ran = docker::capture_on(
        on,
        &[
            "image",
            "inspect",
            "--format",
            "{{json .RepoDigests}}",
            image,
        ],
        docker::READ_LIMIT,
    )
    .ok()
    .filter(|ran| ran.code == Some(0))?;
    let digests: Vec<String> = serde_json::from_str(ran.stdout.trim()).ok()?;
    let repo = repository_of(image);
    digests
        .into_iter()
        .find(|digest| digest.split_once('@').is_some_and(|(name, _)| name == repo))
}

/// `ghcr.io/intentic/sandbox` of `ghcr.io/intentic/sandbox:latest`: the name less its tag, where a `:` before the
/// last `/` is a registry's port.
pub(crate) fn repository_of(image: &str) -> &str {
    let name = image.split_once('@').map_or(image, |(name, _)| name);
    match name.rfind(':') {
        Some(colon) if !name[colon..].contains('/') => &name[..colon],
        _ => name,
    }
}

/// Pull `digest` on `on` and give it `image`'s name, beating the move's heartbeat while the download runs. False when
/// the registry could not be reached or refused it: the save is what is left.
pub(crate) fn pull_as(on: &Target, digest: &str, image: &str, slug: &str, log: &Log) -> bool {
    say(slug, "image", json!({ "pulling": image }));
    let mut command = docker::command_on(on, &["pull", "-q", digest]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let said = tail_of(child.stderr.take());
    let started = Instant::now();
    let mut last_beat = Instant::now();
    let pulled = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() > PULL_LIMIT => {
                kill_pid(child.id());
                let _ = child.wait();
                break false;
            }
            Ok(None) => {}
            Err(_) => break false,
        }
        if last_beat.elapsed() > Duration::from_secs(30) {
            last_beat = Instant::now();
            heartbeat();
        }
        std::thread::sleep(Duration::from_secs(2));
    };
    let words = said
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_default();
    log.line(&format!(
        "pull {digest}: {}",
        if pulled {
            "done".to_string()
        } else {
            last_words(&words)
        }
    ));
    pulled && run_on(on, &["tag", digest, image], docker::READ_LIMIT).is_ok()
}

pub(crate) fn tail_of(
    stream: Option<impl Read + Send + 'static>,
) -> std::sync::mpsc::Receiver<String> {
    let (send, receive) = std::sync::mpsc::channel();
    if let Some(mut stream) = stream {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stream.read_to_string(&mut text);
            let tail: String = text
                .chars()
                .rev()
                .take(2000)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let _ = send.send(tail);
        });
    } else {
        let _ = send.send(String::new());
    }
    receive
}

/// `tail_of` already bounds this text. Tar ends fatal errors with a generic summary, so keep the diagnostic before it.
pub(crate) fn copy_diagnostic(said: &str) -> &str {
    let said = said.trim();
    if said.is_empty() {
        "docker said nothing"
    } else {
        said
    }
}

pub(crate) fn last_words(said: &str) -> String {
    said.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("docker said nothing")
        .trim()
        .to_string()
}

pub(crate) fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/* ——— Reading a container, and making one again. ——— */

pub(crate) fn inspect_on(on: &Target, name: &str) -> Result<Value> {
    let ran = docker::capture_on(on, &["inspect", name], docker::READ_LIMIT)?;
    if ran.code != Some(0) {
        bail!("could not read {name}: {}", ran.stderr);
    }
    let parsed: Value = serde_json::from_str(&ran.stdout)?;
    parsed
        .as_array()
        .and_then(|all| all.first())
        .cloned()
        .ok_or_else(|| Fail(format!("docker said nothing about {name}")))
}

pub(crate) fn env_of(inspect: &Value) -> Vec<String> {
    inspect["Config"]["Env"]
        .as_array()
        .map(|env| {
            env.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn env_value(env: &[String], name: &str) -> Option<String> {
    env.iter()
        .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// A GPU handed to the container, or asked for in the owner's directives.
fn uses_gpu(inspect: &Value, env: &[String]) -> bool {
    let requested = inspect["HostConfig"]["DeviceRequests"]
        .as_array()
        .is_some_and(|requests| !requests.is_empty());
    requested || env_value(env, "SANDBOX_RUNTIME").is_some_and(|runtime| runtime.contains("--gpus"))
}

/// Each named volume a container mounts, with where.
pub(crate) fn named_volumes(inspect: &Value) -> Vec<(String, String)> {
    inspect["Mounts"]
        .as_array()
        .map(|mounts| {
            mounts
                .iter()
                .filter(|mount| mount["Type"] == "volume")
                .filter_map(|mount| {
                    Some((
                        mount["Name"].as_str()?.to_string(),
                        mount["Destination"].as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Refuse a missing mounted key while planning, before stopping any sandbox. Docker's `-v` would otherwise create a
/// directory at its missing source, and neither that directory nor a newly generated key can read the old stores.
pub(crate) fn mounted_key_file(inspect: &Value) -> Result<Option<std::path::PathBuf>> {
    let key = key_file(inspect);
    if let Some(path) = &key {
        if !path.is_file() {
            bail!(
                "the mounted at-rest key {} is not a file. Restore the original key before moving; no replacement key can read its encrypted credentials.",
                path.display()
            );
        }
    }
    Ok(key)
}

/// Run `work` with `key` as the operator's key file (HOST_FILE_ENV), unless the operator named one on this run, then
/// take the variable away again.
pub(crate) fn with_key_file<T>(
    key: Option<&std::path::Path>,
    work: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let name = sandbox::at_rest::HOST_FILE_ENV;
    let named = std::env::var(name).is_ok_and(|value| !value.is_empty());
    let Some(key) = key.filter(|_| !named) else {
        return work();
    };
    std::env::set_var(name, key);
    let result = work();
    std::env::remove_var(name);
    result
}

/// The sandbox, created stopped on the other engine with what the reshape reads off it: its env (the shape and the
/// side ride there), its volumes where they were, its resolvers and labels. It never runs: its entrypoint exits.
pub(crate) fn placeholder_args(inspect: &Value, name: &str, image: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["create".into(), "--name".into(), name.into()];
    args.extend(["--entrypoint".into(), "true".into()]);
    push_labels(&mut args, inspect);
    for (volume, destination) in named_volumes(inspect) {
        args.push("-v".into());
        args.push(format!("{volume}:{destination}"));
    }
    for pair in env_of(inspect) {
        args.push("-e".into());
        args.push(pair);
    }
    for server in strings(&inspect["HostConfig"]["Dns"]) {
        args.push("--dns".into());
        args.push(server);
    }
    args.push(image.into());
    args
}

/// A container beside a sandbox, created again from an image of itself with the options it was made with.
fn clone_args(inspect: &Value, name: &str, image: &str) -> Vec<String> {
    let host = &inspect["HostConfig"];
    let config = &inspect["Config"];
    let mut args: Vec<String> = vec!["create".into(), "--name".into(), name.into()];
    push_labels(&mut args, inspect);
    if host["Privileged"].as_bool() == Some(true) {
        args.push("--privileged".into());
    }
    if let Some(policy) = host["RestartPolicy"]["Name"]
        .as_str()
        .filter(|policy| !policy.is_empty() && *policy != "no")
    {
        args.push("--restart".into());
        args.push(policy.into());
    }
    if let Some(network) = host["NetworkMode"]
        .as_str()
        .filter(|mode| !mode.is_empty() && *mode != "default")
    {
        args.push("--network".into());
        args.push(network.into());
    }
    for (volume, destination) in named_volumes(inspect) {
        args.push("-v".into());
        args.push(format!("{volume}:{destination}"));
    }
    for pair in env_of(inspect) {
        args.push("-e".into());
        args.push(pair);
    }
    for server in strings(&host["Dns"]) {
        args.push("--dns".into());
        args.push(server);
    }
    for capability in strings(&host["CapAdd"]) {
        args.push("--cap-add".into());
        args.push(capability);
    }
    for extra in strings(&host["ExtraHosts"]) {
        args.push("--add-host".into());
        args.push(extra);
    }
    if let Some(bindings) = host["PortBindings"].as_object() {
        for (port, hosts) in bindings {
            for binding in hosts.as_array().into_iter().flatten() {
                let ip = binding["HostIp"].as_str().unwrap_or_default();
                let at = binding["HostPort"].as_str().unwrap_or_default();
                args.push("-p".into());
                args.push(match (ip.is_empty(), at.is_empty()) {
                    (true, true) => port.clone(),
                    (true, false) => format!("{at}:{port}"),
                    (false, _) => format!("{ip}:{at}:{port}"),
                });
            }
        }
    }
    if let Some(dir) = config["WorkingDir"].as_str().filter(|dir| !dir.is_empty()) {
        args.push("--workdir".into());
        args.push(dir.into());
    }
    if let Some(user) = config["User"].as_str().filter(|user| !user.is_empty()) {
        args.push("--user".into());
        args.push(user.into());
    }
    let entrypoint = strings(&config["Entrypoint"]);
    if let Some((first, rest)) = entrypoint.split_first() {
        args.push("--entrypoint".into());
        args.push(first.clone());
        args.push(image.into());
        args.extend(rest.iter().cloned());
    } else {
        args.push(image.into());
    }
    args.extend(strings(&config["Cmd"]));
    args
}

fn push_labels(args: &mut Vec<String>, inspect: &Value) {
    if let Some(labels) = inspect["Config"]["Labels"].as_object() {
        let mut keys: Vec<&String> = labels.keys().collect();
        keys.sort();
        for key in keys {
            // The image's own labels come back with it; only the ones the container was given are worth repeating, and
            // repeating an image's is harmless.
            args.push("--label".into());
            args.push(format!(
                "{key}={}",
                labels[key].as_str().unwrap_or_default()
            ));
        }
    }
}

pub(crate) fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn ensure_network_on(on: &Target, slug: &str) -> Result<()> {
    let network = crate::sandbox::trash::network(slug);
    let exists = docker::capture_on(on, &["network", "inspect", &network], docker::READ_LIMIT)
        .is_ok_and(|ran| ran.code == Some(0));
    if exists {
        return Ok(());
    }
    let mut args: Vec<String> = vec!["network".into(), "create".into()];
    args.extend(crate::sandbox::labels::here(
        slug,
        crate::sandbox::labels::Kind::Network,
    ));
    args.push(network);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_on(on, &refs, docker::READ_LIMIT)
}

/// The same image on both engines: the same uncompressed layers, in order. Not the image ID, which is the config's
/// digest on a classic image store and the manifest's on Docker Desktop's containerd store, so one image has two IDs
/// across them (omen, 2026-10-09: an 8.75 GB image that arrived whole was refused for it).
pub(crate) fn same_image(source: &Target, target: &Target, image: &str) -> bool {
    match (layers_on(source, image), layers_on(target, image)) {
        (Some(theirs), Some(ours)) => theirs == ours,
        _ => false,
    }
}

pub(crate) fn layers_on(on: &Target, image: &str) -> Option<String> {
    docker::capture_on(
        on,
        &[
            "image",
            "inspect",
            "--format",
            "{{json .RootFS.Layers}}",
            image,
        ],
        docker::READ_LIMIT,
    )
    .ok()
    .filter(|ran| ran.code == Some(0))
    .map(|ran| ran.stdout.trim().to_string())
    .filter(|layers| layers.starts_with('['))
}

pub(crate) fn image_id_on(on: &Target, image: &str) -> Option<String> {
    docker::capture_on(
        on,
        &["image", "inspect", "--format", "{{.Id}}", image],
        docker::READ_LIMIT,
    )
    .ok()
    .filter(|ran| ran.code == Some(0))
    .map(|ran| ran.stdout.trim().to_string())
    .filter(|id| !id.is_empty())
}

pub(crate) fn image_bytes(on: &Target, image: &str) -> Option<u64> {
    docker::capture_on(
        on,
        &["image", "inspect", "--format", "{{.Size}}", image],
        docker::READ_LIMIT,
    )
    .ok()
    .filter(|ran| ran.code == Some(0))
    .and_then(|ran| ran.stdout.trim().parse().ok())
}

pub(crate) fn volume_bytes(on: &Target, volume: &str, helper: &str) -> Option<u64> {
    let mount = format!("{volume}:/v:ro");
    docker::capture_on(
        on,
        &[
            "run",
            "--rm",
            "--network",
            "none",
            "--log-driver",
            "none",
            "-v",
            mount.as_str(),
            "--entrypoint",
            "du",
            helper,
            "-sxb",
            "/v",
        ],
        Duration::from_secs(900),
    )
    .ok()
    .filter(|ran| ran.code == Some(0))
    .and_then(|ran| ran.stdout.split_whitespace().next()?.parse().ok())
}

pub(crate) fn run_on(on: &Target, args: &[&str], limit: Duration) -> Result<()> {
    let ran = docker::capture_on(on, args, limit)?;
    if ran.timed_out {
        bail!(
            "docker {} did not finish within {} s.",
            args.first().unwrap_or(&""),
            limit.as_secs()
        );
    }
    if ran.code != Some(0) {
        bail!(
            "docker {} failed: {}",
            args.join(" "),
            last_words(&ran.stderr)
        );
    }
    Ok(())
}

/// Run `work` with every `docker` of this process pointed at `on` and the swap's probation off — a moved sandbox has
/// nothing on this engine to go back to — then point it back at the source.
fn with_engine<T>(on: &Target, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let probation = std::env::var("IC_PROBATION_SECONDS").ok();
    std::env::set_var("IC_PROBATION_SECONDS", "0");
    let previous = if docker::intentic_engine_in_use() {
        super::reach()
            .map(Target::Intentic)
            .unwrap_or(Target::DockerDesktop)
    } else {
        Target::DockerDesktop
    };
    docker::adopt_target(on);
    let done = work();
    docker::adopt_target(&previous);
    match probation {
        Some(value) => std::env::set_var("IC_PROBATION_SECONDS", value),
        None => std::env::remove_var("IC_PROBATION_SECONDS"),
    }
    done
}

/// How often a move says it is alive while it waits on one long step that prints nothing.
const BEAT_EVERY: Duration = Duration::from_secs(60);

/// `work`, with the move's heartbeat kept fresh while it runs. For the steps that are silent yet bounded by their own
/// limits (listing and hashing a volume's files, up to 30 minutes; sizing it; the reshape on the other engine). _(2026-11-20)
/// Their heartbeat came only between steps, so one longer than [`STALE_HEARTBEAT_MS`] read as a move whose ic had died, and
/// every other ic run, a second move included, went ahead beside a move still copying._
fn beating<T>(work: impl FnOnce() -> T) -> T {
    beating_with(BEAT_EVERY, heartbeat, work)
}

fn beating_with<T>(every: Duration, beat: fn(), work: impl FnOnce() -> T) -> T {
    let done = Arc::new(AtomicBool::new(false));
    let pulse = {
        let done = Arc::clone(&done);
        std::thread::spawn(move || {
            let tick = every.min(Duration::from_secs(1));
            let mut since = Instant::now();
            while !done.load(Ordering::SeqCst) {
                std::thread::sleep(tick);
                if since.elapsed() >= every && !done.load(Ordering::SeqCst) {
                    since = Instant::now();
                    beat();
                }
            }
        })
    };
    let answer = work();
    done.store(true, Ordering::SeqCst);
    let _ = pulse.join();
    answer
}

fn heartbeat() {
    let _ = update_journal(|journal| {
        if let Some(moving) = journal.moving.as_mut() {
            moving.heartbeat = now_ms();
        }
    });
}

/// A sandbox's progress written into the move's entry, with a heartbeat: before each step that changes the source, so
/// an ic killed at any point leaves what its successor needs to undo it ([`recover`]).
fn keep_progress(carry: &Carried) -> Result<()> {
    update_journal(|journal| {
        if let Some(moving) = journal.moving.as_mut() {
            record_progress(moving, carry);
            moving.heartbeat = now_ms();
        }
    })
}

/// `carry` as the entry's record of its sandbox, replacing the one before. Pure.
fn record_progress(moving: &mut Moving, carry: &Carried) {
    let progress = moving.progress.get_or_insert_with(Vec::new);
    match progress.iter_mut().find(|known| known.slug == carry.slug) {
        Some(known) => *known = carry.clone(),
        None => progress.push(carry.clone()),
    }
}

/// One `intentic-move:` line for the desktop app's card.
pub(crate) fn say(slug: &str, step: &str, detail: Value) {
    let mut line = json!({ "slug": slug, "step": step });
    if let (Some(line), Some(detail)) = (line.as_object_mut(), detail.as_object()) {
        for (key, value) in detail {
            line.insert(key.clone(), value.clone());
        }
    }
    // allow(terminal-output): a column-0 marker the desktop app parses (engine.rs).
    println!("intentic-move: {line}");
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn gigabytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1_000_000_000.0)
}

fn cli_id(kind: Kind) -> &'static str {
    match kind {
        Kind::DockerDesktop => "docker-desktop",
        Kind::Intentic => "intentic",
        Kind::Native => "native",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_of_whole_tar_blocks_is_not_cut_short_and_one_ending_mid_block_is() {
        // The two streams of nightly 43471063277: whole on the way to Intentic's engine, cut on the way back.
        assert!(!cut_short(339_148_800, GNU_TAR_RECORD));
        assert!(cut_short(336_459_776, GNU_TAR_RECORD));
        assert!(!cut_short(336_459_776, TAR_BLOCK));
        assert!(cut_short(511, TAR_BLOCK));
    }

    #[test]
    fn archive_commands_use_the_tls_endpoint_and_its_credential_even_with_a_relay() {
        let leaf = format!("intentic-engine-archive-test-{}", std::process::id());
        let pipe = intentic_docker_host::engine_pipe::host_for(&leaf);
        #[cfg(windows)]
        let _relay = test_relay_pipe(&leaf);
        let on = Target::Intentic(docker::EngineEnv {
            host: "tcp://127.0.0.1:2378".into(),
            cert_path: "engine-test-tls".into(),
            bin: std::path::PathBuf::from("engine-test-bin"),
            pipe: Some(pipe.clone()),
        });
        #[cfg(windows)]
        {
            let normal = docker::command_on(&on, &["info"]);
            let env: std::collections::BTreeMap<_, _> = normal.get_envs().collect();
            assert_eq!(
                env[std::ffi::OsStr::new("DOCKER_HOST")],
                Some(std::ffi::OsStr::new(&pipe))
            );
        }
        for args in [
            &["run", "--rm", "tar"][..],
            &["save", "image"],
            &["load", "-q"],
        ] {
            let command = archive_command(&on, args);
            let env: std::collections::BTreeMap<_, _> = command.get_envs().collect();
            let value = |name: &str| env[std::ffi::OsStr::new(name)].unwrap();
            assert_eq!(value("DOCKER_HOST"), "tcp://127.0.0.1:2378");
            assert_eq!(value("DOCKER_TLS_VERIFY"), "1");
            assert_eq!(value("DOCKER_CERT_PATH"), "engine-test-tls");
            assert_eq!(
                std::env::split_paths(value("PATH")).next(),
                Some(std::path::PathBuf::from("engine-test-bin"))
            );
            assert_eq!(command.get_args().collect::<Vec<_>>(), args);
        }
        assert!(matches!(on, Target::Intentic(env) if env.pipe.as_deref() == Some(pipe.as_str())));
    }

    /// A listening pipe, so the routing test exercises a relay that ordinary commands really would choose.
    #[cfg(windows)]
    fn test_relay_pipe(leaf: &str) -> std::os::windows::io::OwnedHandle {
        use std::ffi::{c_char, c_void, CString};
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        extern "system" {
            fn CreateNamedPipeA(
                name: *const c_char,
                open: u32,
                mode: u32,
                instances: u32,
                out_buffer: u32,
                in_buffer: u32,
                timeout: u32,
                security: *const c_void,
            ) -> *mut c_void;
        }
        let name = CString::new(format!(r"\\.\pipe\{leaf}")).unwrap();
        // SAFETY: name is NUL-terminated and lives through the call; no security attributes are passed.
        let handle =
            unsafe { CreateNamedPipeA(name.as_ptr(), 3, 0, 1, 4096, 4096, 0, std::ptr::null()) };
        assert_ne!(handle as isize, -1, "{}", std::io::Error::last_os_error());
        // SAFETY: the call returned a new valid handle; OwnedHandle closes it at the end of the test.
        unsafe { OwnedHandle::from_raw_handle(handle) }
    }

    #[test]
    fn archive_commands_keep_docker_desktop_on_its_own_endpoint() {
        let command = archive_command(&Target::DockerDesktop, &["load", "-q"]);
        let env: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        for name in [
            "DOCKER_HOST",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
            "DOCKER_CONTEXT",
        ] {
            assert_eq!(env[std::ffi::OsStr::new(name)], None);
        }
    }

    #[test]
    fn archive_commands_keep_wsl_socket_transfers_without_tls() {
        let on = Target::Intentic(docker::EngineEnv {
            host: "unix:///mnt/wsl/intentic-engine/docker.sock".into(),
            cert_path: String::new(),
            bin: std::path::PathBuf::new(),
            pipe: None,
        });
        let command = archive_command(&on, &["save", "image"]);
        let env: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        assert_eq!(
            env[std::ffi::OsStr::new("DOCKER_HOST")],
            Some(std::ffi::OsStr::new(
                "unix:///mnt/wsl/intentic-engine/docker.sock"
            ))
        );
        assert_eq!(env[std::ffi::OsStr::new("DOCKER_TLS_VERIFY")], None);
        assert_eq!(env[std::ffi::OsStr::new("DOCKER_CERT_PATH")], None);
    }

    #[test]
    fn a_failed_copy_reports_the_cause_before_tars_final_summary() {
        let said = "\ntar: Unexpected EOF in archive\ntar: Error is not recoverable: exiting now\n";
        assert_eq!(
            copy_diagnostic(said),
            "tar: Unexpected EOF in archive\ntar: Error is not recoverable: exiting now"
        );
        assert_eq!(copy_diagnostic(" \n"), "docker said nothing");
    }

    #[test]
    fn the_key_file_is_read_off_the_binds_as_this_machine_names_it() {
        let desktop = json!({ "HostConfig": { "Binds": [
            "intentic-workspace-a:/work",
            r"C:\Users\me\.intentic\keys\at-rest-a.key:/run/secrets/intentic-at-rest-key:ro",
            r"D:\keys\old.key:/run/secrets/intentic-at-rest-previous-key:ro",
        ] } });
        let expected = Some(std::path::PathBuf::from(
            r"C:\Users\me\.intentic\keys\at-rest-a.key",
        ));
        assert_eq!(key_file(&desktop), expected);
        let ours = json!({ "HostConfig": { "Binds": [
            "/mnt/c/Users/me/.intentic/keys/at-rest-a.key:/run/secrets/intentic-at-rest-key:ro",
        ] } });
        assert_eq!(key_file(&ours), expected);
        assert_eq!(key_file(&json!({ "HostConfig": { "Binds": null } })), None);
    }

    #[test]
    fn a_key_replayed_from_docker_desktops_linux_drive_path_is_a_windows_file() {
        for root in ["/run/desktop/mnt/host/", "/host_mnt/", "/"] {
            let source = format!("{root}c/Users/me/.intentic/keys/at-rest-a.key");
            let inspect = json!({ "HostConfig": { "Binds": [
                format!("{source}:{}:ro", sandbox::at_rest::KEY_MOUNT),
            ] } });
            assert_eq!(
                key_file(&inspect),
                Some(std::path::PathBuf::from(
                    r"C:\Users\me\.intentic\keys\at-rest-a.key"
                )),
            );
        }
        for source in ["/run/desktop/mnt/host/wsl/Ubuntu/key", "/srv/keys/a.key"] {
            assert_eq!(windows_path_of(source), source);
        }
    }

    #[test]
    fn a_key_created_with_mount_is_recovered_only_from_its_bind_destination() {
        let mut inspect = json!({ "HostConfig": { "Binds": null }, "Mounts": [
            { "Type": "bind", "Source": "D:/keys/old.key", "Destination": sandbox::at_rest::PREVIOUS_KEY_MOUNT },
            { "Type": "volume", "Source": "/var/lib/docker/volumes/key", "Destination": sandbox::at_rest::KEY_MOUNT },
        ] });
        assert_eq!(key_file(&inspect), None);
        inspect["Mounts"].as_array_mut().unwrap().push(json!({
            "Type": "bind", "Source": "/run/desktop/mnt/host/d/keys/current.key",
            "Destination": sandbox::at_rest::KEY_MOUNT,
        }));
        assert_eq!(
            key_file(&inspect),
            Some(std::path::PathBuf::from(r"D:\keys\current.key"))
        );
    }

    #[test]
    fn a_move_refuses_a_missing_or_directory_key_and_keeps_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("key");
        let inspect = json!({ "Mounts": [{
            "Type": "bind", "Source": key.to_str().unwrap(),
            "Destination": sandbox::at_rest::KEY_MOUNT,
        }] });
        let refusal = format!(
            "the mounted at-rest key {} is not a file. Restore the original key before moving; no replacement key can read its encrypted credentials.",
            key.display()
        );
        assert_eq!(mounted_key_file(&inspect).unwrap_err().0, refusal);
        std::fs::create_dir(&key).unwrap();
        assert_eq!(mounted_key_file(&inspect).unwrap_err().0, refusal);
        std::fs::remove_dir(&key).unwrap();
        std::fs::write(&key, [7u8; 32]).unwrap();
        assert_eq!(mounted_key_file(&inspect).unwrap(), Some(key));
        assert_eq!(mounted_key_file(&json!({})).unwrap(), None);
    }

    #[test]
    fn repository_of_drops_the_tag_and_keeps_a_registry_port() {
        assert_eq!(
            repository_of("ghcr.io/intentic/sandbox:latest"),
            "ghcr.io/intentic/sandbox"
        );
        assert_eq!(
            repository_of("localhost:5000/sandbox:dev"),
            "localhost:5000/sandbox"
        );
        assert_eq!(
            repository_of("localhost:5000/sandbox"),
            "localhost:5000/sandbox"
        );
        assert_eq!(repository_of("alpine"), "alpine");
        assert_eq!(repository_of("alpine@sha256:abc"), "alpine");
    }

    fn moved(slug: &str, at: u64, remove_after: u64) -> Moved {
        Moved {
            slug: slug.into(),
            from: "dockerDesktop".into(),
            to: "intentic".into(),
            at,
            containers: vec![format!("intentic-sandbox-{slug}.moved")],
            volumes: vec![format!("intentic-workspace-{slug}")],
            images: Vec::new(),
            remove_after,
            removed: false,
        }
    }

    /// An entry as this ic writes one, with nothing done yet.
    fn moving(pid: u32, heartbeat: u64) -> Moving {
        Moving {
            pid,
            to: "intentic".into(),
            started: 0,
            heartbeat,
            from: Some("dockerDesktop".into()),
            log: Some("C:\\Users\\x\\.intentic\\logs\\move-1.log".into()),
            progress: Some(Vec::new()),
        }
    }

    #[test]
    fn a_move_runs_only_while_its_process_is_alive_and_its_heartbeat_fresh() {
        let entry = moving(70892, 1_000_000);
        let fresh = 1_000_000 + 60_000;
        let stale = 1_000_000 + STALE_HEARTBEAT_MS;
        let alive = |_: u32| true;
        let dead = |_: u32| false;
        assert_eq!(state_of(&entry, fresh, alive), MoveState::Running);
        // The incident's shape: the desktop app killed ic mid-copy, seconds after its last heartbeat.
        assert_eq!(
            state_of(&entry, fresh, dead),
            MoveState::Interrupted(Interruption::ProcessGone)
        );
        // A live pid with a silent move is another program holding a reused pid, or an ic hung past its limits.
        assert_eq!(
            state_of(&entry, stale, alive),
            MoveState::Interrupted(Interruption::HeartbeatStale)
        );
        assert_eq!(
            state_of(&entry, stale, dead),
            MoveState::Interrupted(Interruption::ProcessGone)
        );
        // Only its own pid is asked about.
        assert_eq!(
            state_of(&entry, fresh, |pid| pid == 70892),
            MoveState::Running
        );
        assert!(process_alive(std::process::id()));
    }

    #[test]
    fn the_summary_says_when_a_move_was_interrupted() {
        let journal = Journal {
            moving: Some(moving(70892, 1_000)),
            ..Journal::default()
        };
        let running = summary_of(&journal, 2_000, |_| true).unwrap();
        assert_eq!(running["moving"], true);
        assert_eq!(running["interrupted"], false);
        let dead = summary_of(&journal, 2_000, |_| false).unwrap();
        assert_eq!(dead["moving"], false);
        assert_eq!(dead["interrupted"], true);
        assert_eq!(dead["to"], "intentic");
        let stale = summary_of(&journal, 1_000 + STALE_HEARTBEAT_MS, |_| true).unwrap();
        assert_eq!(stale["interrupted"], true);
    }

    #[test]
    fn the_journal_an_older_ic_left_mid_move_still_reads_and_is_recovered_by_names() {
        // moves.json as ic 1.429.0 left it when the desktop app was quit mid-copy (intentic#48).
        let text = r#"{ "moving": { "pid": 70892, "to": "intentic", "started": 1763600000000, "heartbeat": 1763600420000 }, "moved": [] }"#;
        let journal: Journal = serde_json::from_str(text).unwrap();
        let entry = journal.moving.clone().unwrap();
        assert_eq!(entry.pid, 70892);
        assert_eq!(
            (
                entry.from.as_deref(),
                entry.log.as_deref(),
                entry.progress.as_ref()
            ),
            (None, None, None)
        );
        assert!(journal.made.is_empty());
        assert_eq!(
            recovery_of(&entry, Kind::DockerDesktop),
            Recovery::Legacy {
                from: Kind::DockerDesktop,
                to: Kind::Intentic,
                switched: false
            }
        );
        assert_eq!(
            recovery_of(&entry, Kind::Intentic),
            Recovery::Legacy {
                from: Kind::DockerDesktop,
                to: Kind::Intentic,
                switched: true
            }
        );
        let unknown = Moving {
            to: "podman".into(),
            ..entry
        };
        assert_eq!(recovery_of(&unknown, Kind::DockerDesktop), Recovery::Forget);
    }

    #[test]
    fn an_interrupted_move_with_progress_is_undone_or_finished_by_whether_it_switched() {
        let mut entry = moving(70892, 1_000);
        let mut first = Carried {
            slug: "a".into(),
            ..Carried::default()
        };
        first.running.push("intentic-sandbox-a".into());
        first.renamed.push((
            "intentic-sandbox-a".into(),
            "intentic-sandbox-a.moved".into(),
        ));
        first.created_volumes.push("intentic-workspace-a".into());
        first.volumes.push("intentic-workspace-a".into());
        record_progress(&mut entry, &first);
        let second = Carried {
            slug: "b".into(),
            renamed: vec![(
                "intentic-sandbox-b".into(),
                "intentic-sandbox-b.moved".into(),
            )],
            ..Carried::default()
        };
        record_progress(&mut entry, &second);
        // A later step of the same sandbox replaces its record rather than adding one.
        first.created_containers.push("intentic-sandbox-a".into());
        record_progress(&mut entry, &first);
        assert_eq!(
            entry.progress.as_deref(),
            Some(&[first.clone(), second.clone()][..])
        );
        // What it wrote survives the file.
        let text = serde_json::to_string(&Journal {
            moving: Some(entry.clone()),
            ..Journal::default()
        })
        .unwrap();
        assert!(text.contains("\"createdVolumes\""));
        let back: Journal = serde_json::from_str(&text).unwrap();
        assert_eq!(back.moving.as_ref(), Some(&entry));

        assert_eq!(
            recovery_of(&entry, Kind::DockerDesktop),
            Recovery::Undo {
                from: Kind::DockerDesktop,
                to: Kind::Intentic,
                carried: vec![first.clone(), second.clone()],
            }
        );
        assert_eq!(
            recovery_of(&entry, Kind::Intentic),
            Recovery::Finish {
                from: Kind::DockerDesktop,
                to: Kind::Intentic,
                carried: vec![first.clone(), second.clone()],
            }
        );
        // An entry naming no `from` carries from the other engine.
        let back_to_desktop = Moving {
            to: "dockerDesktop".into(),
            from: None,
            ..entry.clone()
        };
        assert!(matches!(
            recovery_of(&back_to_desktop, Kind::Intentic),
            Recovery::Undo {
                from: Kind::Intentic,
                to: Kind::DockerDesktop,
                ..
            }
        ));

        // Finished, it is written down as the move itself would have.
        let mut journal = Journal {
            moving: Some(entry),
            made: vec![made("a", "intentic-workspace-a", false)],
            ..Journal::default()
        };
        record_finished(
            &mut journal,
            &[first, second],
            Kind::DockerDesktop,
            Kind::Intentic,
            5,
        );
        assert_eq!(journal.moving, None);
        assert!(journal.made.is_empty());
        assert_eq!(journal.moved.len(), 2);
        assert_eq!(
            journal.moved[0].containers,
            vec!["intentic-sandbox-a.moved".to_string()]
        );
        assert_eq!(journal.moved[0].remove_after, 5 + KEEP_DAYS * DAY_MS);
    }

    #[test]
    fn an_older_move_s_partial_copy_on_our_engine_is_found_and_nothing_else() {
        let pair = |slug: &str, volume: &str| (slug.to_string(), volume.to_string());
        let sources = vec![
            pair("a", "intentic-history-a"),
            pair("a", "intentic-workspace-a"),
            pair("a", "intentic-docker-a"),
            // A volume two containers of one sandbox mount is found once.
            pair("a", "intentic-history-a"),
            pair("b", "intentic-workspace-b"),
            pair("c", "intentic-workspace-c"),
        ];
        let on_target: Vec<String> = [
            "intentic-history-a",
            "intentic-docker-a",
            "intentic-workspace-b",
            "intentic-workspace-c",
            // On the target but no source sandbox's: somebody else's.
            "postgres-data",
        ]
        .iter()
        .map(|name| name.to_string())
        .collect();
        let mut journal = Journal {
            // b's volume is the copy a finished move keeps for its days.
            moved: vec![Moved {
                from: "intentic".into(),
                to: "dockerDesktop".into(),
                volumes: vec!["intentic-workspace-b".into()],
                ..moved("b", 1, 2)
            }],
            // c's is already written down as made.
            made: vec![made("c", "intentic-workspace-c", false)],
            ..Journal::default()
        };
        assert_eq!(
            legacy_leftovers(&sources, &on_target, &journal, "intentic"),
            vec![
                pair("a", "intentic-history-a"),
                pair("a", "intentic-docker-a")
            ]
        );
        // A removed record keeps nothing.
        journal.moved[0].removed = true;
        assert_eq!(
            legacy_leftovers(&sources, &on_target, &journal, "intentic"),
            vec![
                pair("a", "intentic-history-a"),
                pair("a", "intentic-docker-a"),
                pair("b", "intentic-workspace-b")
            ]
        );
        assert!(legacy_leftovers(&sources, &[], &journal, "intentic").is_empty());
    }

    #[test]
    fn an_older_move_gives_back_only_ic_s_own_set_aside_names_whose_own_name_is_free() {
        let names: Vec<String> = [
            // Set aside by the cut-off move: the sandbox and its dind host.
            "intentic-dind-host-a.moved",
            "intentic-sandbox-a.moved",
            // b was set aside too, but something already took its name back: left alone.
            "intentic-sandbox-b.moved",
            "intentic-sandbox-b",
            // c's copy is one a finished move keeps for its days.
            "intentic-sandbox-c.moved",
            // d's tunnel.
            "intentic-sandbox-tunnel-d.moved",
            // Nobody's to touch: not ic's naming, a parked swap, a name no slug could have.
            "postgres.moved",
            "intentic-sandbox-e.previous.moved",
            "intentic-sandbox-../x.moved",
        ]
        .iter()
        .map(|name| name.to_string())
        .collect();
        let kept = vec!["intentic-sandbox-c.moved".to_string()];
        let restores = legacy_restores(&names, &kept);
        let pairs: Vec<(&str, &str, &str)> = restores
            .iter()
            .map(|r| (r.slug.as_str(), r.moved.as_str(), r.name.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("a", "intentic-sandbox-a.moved", "intentic-sandbox-a"),
                ("a", "intentic-dind-host-a.moved", "intentic-dind-host-a"),
                (
                    "d",
                    "intentic-sandbox-tunnel-d.moved",
                    "intentic-sandbox-tunnel-d"
                ),
            ]
        );
    }

    #[test]
    fn only_copies_whose_days_are_up_are_due() {
        let journal = Journal {
            moving: None,
            moved: vec![moved("a", 1, 100), moved("b", 1, 300), {
                let mut gone = moved("c", 1, 50);
                gone.removed = true;
                gone
            }],
            made: Vec::new(),
        };
        let due: Vec<String> = expired(&journal, 200).into_iter().map(|m| m.slug).collect();
        assert_eq!(due, vec!["a".to_string()]);
    }

    #[test]
    fn the_summary_names_what_is_kept_and_where() {
        assert_eq!(summary_of(&Journal::default(), 0, |_| true), None);
        let journal = Journal {
            moving: None,
            moved: vec![moved("a", 10, 100)],
            made: Vec::new(),
        };
        let summary = summary_of(&journal, 20, |_| true).unwrap();
        assert_eq!(summary["moving"], false);
        assert_eq!(summary["last"]["to"], "intentic");
        assert_eq!(summary["leftBehind"][0]["slug"], "a");
        assert_eq!(summary["leftBehind"][0]["on"], "dockerDesktop");
    }

    #[test]
    fn a_volume_already_there_is_replaced_only_when_an_earlier_move_left_it_or_it_is_empty() {
        for empty in [None, Some(true), Some(false)] {
            assert_eq!(volume_action(false, false, empty), VolumeAction::Create);
            assert_eq!(volume_action(false, true, empty), VolumeAction::Create);
            assert_eq!(volume_action(true, true, empty), VolumeAction::Replace);
        }
        assert_eq!(volume_action(true, false, Some(true)), VolumeAction::Adopt);
        // Files nobody's record accounts for, or a look inside that failed: never removed.
        assert_eq!(
            volume_action(true, false, Some(false)),
            VolumeAction::Refuse
        );
        assert_eq!(volume_action(true, false, None), VolumeAction::Refuse);
    }

    fn made(slug: &str, name: &str, container: bool) -> Made {
        Made {
            slug: slug.into(),
            on: "intentic".into(),
            name: name.into(),
            container,
        }
    }

    #[test]
    fn what_a_cut_off_move_made_is_known_by_its_slug_engine_and_name() {
        // 2026-11-20: a move cut off mid-copy left intentic-history-<slug> on the intentic engine with no record.
        let journal = Journal {
            made: vec![made("e695", "intentic-history-e695", false)],
            ..Journal::default()
        };
        assert!(made_by_a_move(
            &journal,
            "e695",
            "intentic",
            "intentic-history-e695"
        ));
        assert!(!made_by_a_move(
            &journal,
            "e695",
            "dockerDesktop",
            "intentic-history-e695"
        ));
        assert!(!made_by_a_move(
            &journal,
            "other",
            "intentic",
            "intentic-history-e695"
        ));
        assert!(!made_by_a_move(
            &journal,
            "e695",
            "intentic",
            "intentic-workspace-e695"
        ));
    }

    #[test]
    fn an_undo_forgets_only_what_it_removed_and_a_finished_move_forgets_all_it_made() {
        let mut journal = Journal {
            made: vec![
                made("a", "intentic-history-a", false),
                made("a", "intentic-workspace-a", false),
                made("a", "intentic-sandbox-a", true),
                made("b", "intentic-history-b", false),
            ],
            ..Journal::default()
        };
        forget_made(
            &mut journal,
            "a",
            "intentic",
            Some(&[
                "intentic-workspace-a".to_string(),
                "intentic-sandbox-a".to_string(),
            ]),
        );
        let names: Vec<&str> = journal.made.iter().map(|made| made.name.as_str()).collect();
        assert_eq!(names, vec!["intentic-history-a", "intentic-history-b"]);
        forget_made(&mut journal, "a", "dockerDesktop", None);
        assert_eq!(journal.made.len(), 2);
        forget_made(&mut journal, "a", "intentic", None);
        let names: Vec<&str> = journal.made.iter().map(|made| made.name.as_str()).collect();
        assert_eq!(names, vec!["intentic-history-b"]);
    }

    #[test]
    fn a_journal_written_before_made_existed_still_reads_and_one_with_none_writes_none() {
        let old = r#"{"moving":null,"moved":[]}"#;
        let journal: Journal = serde_json::from_str(old).unwrap();
        assert!(journal.made.is_empty());
        assert!(!serde_json::to_string(&journal).unwrap().contains("made"));
    }

    static BEATS: AtomicU64 = AtomicU64::new(0);
    fn count_beat() {
        BEATS.fetch_add(1, Ordering::SeqCst);
    }

    #[test]
    fn a_long_silent_step_keeps_the_heartbeat_fresh_and_stops_beating_when_it_ends() {
        let answer = beating_with(Duration::from_millis(20), count_beat, || {
            std::thread::sleep(Duration::from_millis(150));
            7
        });
        assert_eq!(answer, 7);
        let beats = BEATS.load(Ordering::SeqCst);
        assert!(beats >= 3, "beat {beats} times in 150 ms at one per 20 ms");
        std::thread::sleep(Duration::from_millis(80));
        assert_eq!(BEATS.load(Ordering::SeqCst), beats);
    }

    fn inspect() -> Value {
        json!({
            "Config": {
                "Env": ["SANDBOX_IMAGE=intentic-sandbox-env-abc:1234", "HOST_PLATFORM=windows", "A=b=c"],
                "Labels": { "dev.intentic.sandbox": "abc", "dev.intentic.kind": "sandbox" },
                "Image": "intentic-sandbox-env-abc:1234",
                "Entrypoint": ["dockerd-entrypoint.sh"],
                "Cmd": ["--tls=false"],
                "WorkingDir": "",
                "User": ""
            },
            "HostConfig": {
                "Privileged": true,
                "RestartPolicy": { "Name": "unless-stopped" },
                "NetworkMode": "intentic-abc",
                "Dns": ["1.1.1.1", "1.0.0.1"],
                "PortBindings": { "8787/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "41234" }] },
                "DeviceRequests": null
            },
            "Mounts": [
                { "Type": "volume", "Name": "intentic-workspace-abc", "Destination": "/work" },
                { "Type": "volume", "Name": "intentic-docker-abc", "Destination": "/var/lib/docker" },
                { "Type": "bind", "Source": "/x", "Destination": "/y" }
            ],
            "State": { "Running": true }
        })
    }

    #[test]
    fn the_placeholder_carries_env_volumes_resolvers_and_labels_and_never_runs() {
        let args = placeholder_args(
            &inspect(),
            "intentic-sandbox-abc",
            "intentic-sandbox-env-abc:1234",
        );
        let joined = args.join(" ");
        assert!(joined.starts_with("create --name intentic-sandbox-abc --entrypoint true"));
        assert!(args.contains(&"intentic-workspace-abc:/work".to_string()));
        assert!(args.contains(&"intentic-docker-abc:/var/lib/docker".to_string()));
        assert!(args.contains(&"A=b=c".to_string()));
        assert!(args.contains(&"dev.intentic.sandbox=abc".to_string()));
        assert_eq!(args.iter().filter(|arg| *arg == "--dns").count(), 2);
        assert_eq!(args.last().unwrap(), "intentic-sandbox-env-abc:1234");
        assert!(
            !args.contains(&"/x:/y".to_string()),
            "binds are the contract's to make"
        );
    }

    #[test]
    fn a_companion_is_made_again_with_the_options_it_had() {
        let args = clone_args(&inspect(), "intentic-dind-host-abc", "intentic-moved-x:1");
        let at = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .map(|i| args[i + 1].clone())
        };
        assert!(args.contains(&"--privileged".to_string()));
        assert_eq!(at("--restart").as_deref(), Some("unless-stopped"));
        assert_eq!(at("--network").as_deref(), Some("intentic-abc"));
        assert_eq!(at("-p").as_deref(), Some("127.0.0.1:41234:8787/tcp"));
        assert_eq!(at("--entrypoint").as_deref(), Some("dockerd-entrypoint.sh"));
        // The image comes right after the options, and the command after it.
        let image = args
            .iter()
            .position(|arg| arg == "intentic-moved-x:1")
            .unwrap();
        assert_eq!(args[image + 1], "--tls=false");
    }

    #[test]
    fn a_gpu_is_seen_in_the_devices_or_the_owners_directives() {
        let mut with_device = inspect();
        with_device["HostConfig"]["DeviceRequests"] = json!([{ "Capabilities": [["gpu"]] }]);
        assert!(uses_gpu(&with_device, &[]));
        assert!(uses_gpu(
            &inspect(),
            &["SANDBOX_RUNTIME=--gpus=all".to_string()]
        ));
        assert!(!uses_gpu(&inspect(), &env_of(&inspect())));
    }

    #[test]
    fn the_manifest_answer_reads_as_entries_and_hash() {
        assert_eq!(
            parse_manifest("1234\nabcdef0123  -\n"),
            Some((1234, "abcdef0123".to_string()))
        );
        assert_eq!(parse_manifest(""), None);
    }

    #[test]
    fn the_journal_round_trips_with_the_names_the_desktop_app_reads() {
        let journal = Journal {
            moving: Some(moving(7, 2)),
            moved: vec![moved("a", 1, 2)],
            made: vec![made("a", "intentic-history-a", false)],
        };
        let text = serde_json::to_string(&journal).unwrap();
        assert!(text.contains("\"removeAfter\""));
        let back: Journal = serde_json::from_str(&text).unwrap();
        assert_eq!(back, journal);
    }
}
