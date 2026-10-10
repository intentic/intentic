//! MOVING A PC'S SANDBOXES BETWEEN ENGINES — `ic engine move --to intentic|docker-desktop` (2026-10-09).
#![cfg_attr(not(windows), allow(dead_code))]

/* One engine per side of a PC: every `docker` ic, the desktop app and the machine agent spawn goes to the engine this
account's sandboxes run on (engine.json's `active`), so the sandboxes move together and the PC switches once, at the end.

A sandbox moves in four steps. Its container is stopped and renamed `<name>.moved` on the engine it leaves, so nothing
there can start it again under its own name while its files are copied. Its image goes across by `docker save | docker
load` (the exact build, a locally-built environment included), and each of its volumes by a tar stream between two
helper containers, checked afterwards against a list of every file and its size on both sides. A stopped placeholder
carrying the old container's env and mounts is created on the new engine, and the ordinary reshape (recreate.rs) makes
the sandbox from it: the run contract, the same shape, the same health waits as every swap. Containers that live beside
a sandbox (the Windows deploy target, an old tunnel sidecar) are committed, carried and created again as they were.

Nothing on the engine being left is changed or deleted. A move that fails anywhere puts every sandbox of this run back
where it was, and the PC is not switched. A move that succeeds leaves the old copies stopped there for KEEP_DAYS, named
in the journal (moves.json), and `ic engine cleanup` (also run by the daily tidy) removes them once those days are up.
Moving back is a move in the other direction. Sandboxes kept by another side of the PC (ic inside a WSL distro) stay on
Docker Desktop, which that side keeps reaching through its WSL integration. */

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
use crate::sandbox::{self, side, CONTAINER_PREFIX, DIND_PREFIX, MOVED_SUFFIX, TUNNEL_PREFIX};
use crate::util::{bail, Fail, Result};

/// How long the copies a move leaves behind are kept before cleanup removes them.
pub const KEEP_DAYS: u64 = 7;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// A running move says it is alive at least this often; one silent for longer died with its ic.
const STALE_HEARTBEAT_MS: u64 = 10 * 60 * 1000;
/// A copy that moves no byte for this long is stuck, not slow.
const STALL: Duration = Duration::from_secs(10 * 60);
/// Free space the target must keep beyond what is copied onto it.
const SPARE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Where a volume holding a Docker engine's own data is mounted: its overlay layers carry `trusted.*` attributes and
/// whiteout device files, which only a privileged helper can read and write back.
const DOCKER_DATA: &str = "/var/lib/docker";

/* ——— The journal: what moved, what it left behind, and a move in progress. ——— */

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    #[serde(default)]
    pub moving: Option<Moving>,
    #[serde(default)]
    pub moved: Vec<Moved>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Moving {
    pub pid: u32,
    pub to: String,
    pub started: u64,
    pub heartbeat: u64,
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

fn load_journal() -> Journal {
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

fn update_journal(change: impl FnOnce(&mut Journal)) -> Result<()> {
    let mut journal = load_journal();
    change(&mut journal);
    save_journal(&journal)
}

fn now_ms() -> u64 {
    sandbox::now_ms()
}

/// A move whose ic is still alive: what every other ic run stays away from while it lasts.
pub fn in_progress() -> bool {
    moving_now(&load_journal(), now_ms())
}

fn moving_now(journal: &Journal, now: u64) -> bool {
    journal
        .moving
        .as_ref()
        .is_some_and(|moving| now.saturating_sub(moving.heartbeat) < STALE_HEARTBEAT_MS)
}

/// What `ic engine status --json` says about moves, for the desktop app's card and Repair: None when nothing ever moved.
pub fn summary() -> Option<Value> {
    summary_of(&load_journal(), now_ms())
}

fn summary_of(journal: &Journal, now: u64) -> Option<Value> {
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
        "moving": moving_now(journal, now),
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
    let from = super::in_use();
    if from == to {
        println!(
            "intentic: this PC's sandboxes already run on {}.",
            to.name()
        );
        let _ = cleanup(false);
        return Ok(());
    }
    if in_progress() {
        bail!("another move between engines is running on this PC; wait for it to finish.");
    }
    let log = Log::create_named("engine", "move")?;
    log.line(&format!("move from {} to {}", from.id(), to.id()));
    let target = ready_target(to, &log)?;
    // No Docker Desktop and no engine answering where it would: nothing can be on it, so there is nothing to carry,
    // and waiting for a Docker Desktop that is not installed would be five minutes of nothing.
    if from == Kind::DockerDesktop
        && !super::docker_desktop_installed()
        && !answers(&Target::DockerDesktop)
    {
        switch(to)?;
        println!(
            "intentic: no other engine here to carry sandboxes from — this PC now runs its sandboxes on {}.",
            to.name()
        );
        return Ok(());
    }
    let source = ready_source(from)?;
    let plan = plan(&source, &target, from, to, &log)?;
    for (slug, kept_by) in &plan.left_alone {
        println!(
            "intentic: {slug} is kept by ic on {kept_by}, which reaches Docker Desktop by itself: it stays there."
        );
    }
    if plan.sandboxes.is_empty() {
        switch(to)?;
        println!(
            "intentic: no sandbox to carry — this PC now runs its sandboxes on {}.",
            to.name()
        );
        return Ok(());
    }
    check_space(&plan, to)?;
    let names: Vec<&str> = plan.sandboxes.iter().map(|s| s.slug.as_str()).collect();
    let question = format!(
        "Move {} ({}, {}) from {} to {}? Each is stopped while its files are copied. {} keeps its copy for {KEEP_DAYS} days; `ic engine move --to {}` moves them back.",
        plural(names.len(), "sandbox", "sandboxes"),
        names.join(", "),
        gigabytes(plan.bytes),
        from.name(),
        to.name(),
        from.name(),
        cli_id(from),
    );
    if !args.yes {
        if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            bail!("{question}\n       Nothing was moved: say yes with --yes (there is no terminal to ask on).");
        }
        if !crate::tty::confirm(&question, false) {
            println!("intentic: nothing was moved.");
            return Ok(());
        }
    }
    let started = now_ms();
    update_journal(|journal| {
        journal.moving = Some(Moving {
            pid: std::process::id(),
            to: to.id().to_string(),
            started,
            heartbeat: started,
        })
    })?;
    let mut locks = Vec::new();
    for sandbox in &plan.sandboxes {
        locks.push(crate::sandbox::lock::hold_for_person(&sandbox.slug)?);
    }
    let mut carried: Vec<Carried> = Vec::new();
    let mut failure: Option<String> = None;
    for (index, sandbox) in plan.sandboxes.iter().enumerate() {
        say(
            &sandbox.slug,
            "begin",
            json!({ "index": index, "count": plan.sandboxes.len(), "bytes": sandbox.bytes }),
        );
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
        println!(
            "intentic: the move stopped ({reason}) — putting every sandbox back on {}…",
            from.name()
        );
        for carry in carried.iter().rev() {
            undo(carry, &source, &target, &log);
        }
        let _ = update_journal(|journal| journal.moving = None);
        drop(locks);
        say("", "failed", json!({ "reason": reason }));
        bail!(
            "the move to {} did not finish: {reason}\n       Every sandbox is back on {} as it was, and this PC still runs on it. Log: {}",
            to.name(),
            from.name(),
            log.path.display()
        );
    }
    switch(to)?;
    docker::adopt_target(&target);
    let remove_after = now_ms() + KEEP_DAYS * DAY_MS;
    update_journal(|journal| {
        journal.moving = None;
        for carry in &carried {
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
                at: now_ms(),
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
    })?;
    drop(locks);
    if to == Kind::DockerDesktop {
        // Nothing runs on our engine now but the copies kept for the days: it rests until cleanup needs it.
        let _ = super::rest("not in use since this PC's sandboxes moved to Docker Desktop");
    }
    say(
        "",
        "done",
        json!({ "engine": to.id(), "count": carried.len() }),
    );
    println!(
        "intentic: moved {} to {}. This PC now runs its sandboxes on {}.",
        plural(carried.len(), "sandbox", "sandboxes"),
        to.name(),
        to.name()
    );
    println!(
        "          {}'s copies stay, stopped, for {KEEP_DAYS} days; `ic engine cleanup --now` removes them sooner.",
        from.name()
    );
    if to == Kind::Intentic {
        println!("          Docker Desktop no longer runs any of Intentic's sandboxes: quit it, or uninstall it if you do not use it yourself, to give its memory back.");
        println!("          Rollback targets kept on Docker Desktop did not come along: a rollback downloads that version instead.");
    }
    Ok(())
}

/// `ic engine cleanup [--now]`: remove the copies a move left behind whose days are up (all of them with `now`).
pub fn cleanup(now: bool) -> Result<()> {
    if !cfg!(windows) {
        return Ok(());
    }
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
    if due.is_empty() {
        return Ok(());
    }
    if in_progress() {
        return Ok(());
    }
    let mut removed: Vec<(String, u64)> = Vec::new();
    for moved in &due {
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
        println!(
            "intentic: removed the copy of {} that {} kept after it moved.",
            moved.slug,
            kind.name()
        );
        removed.push((moved.slug.clone(), moved.at));
        if kind == Kind::Intentic && super::in_use() != Kind::Intentic {
            let _ = super::rest("not in use since this PC's sandboxes moved to Docker Desktop");
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
    })
}

/* ——— Getting both engines ready. ——— */

fn ready_target(to: Kind, log: &Log) -> Result<Target> {
    match to {
        Kind::Intentic => {
            let status = super::status();
            if !status.installed || super::reach().is_none() {
                println!("intentic: installing Intentic's engine first (about 95 MB)…");
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
                .ok_or_else(|| Fail("Intentic's engine did not install.".to_string()))?;
            let target = Target::Intentic(env);
            if !answers(&target) {
                bail!("Intentic's engine is installed but does not answer — `ic engine start`, then try again.");
            }
            Ok(target)
        }
        _ => {
            if !super::docker_desktop_installed() {
                bail!("Docker Desktop is not installed on this PC, so there is nothing to move back to.");
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
                Fail("Intentic's engine is not installed on this PC.".to_string())
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
        if to == Kind::Intentic && uses_gpu(&inspect, &env) {
            bail!("{slug} uses this PC's GPU, which Intentic's engine cannot pass through yet. It stays on Docker Desktop, and so does this PC: nothing was moved.");
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

/// What a sandbox's move has done so far, so a failure anywhere undoes exactly that.
#[derive(Debug, Default)]
struct Carried {
    slug: String,
    /// Containers renamed aside on the source: (own name, `.moved` name), and whether each was running.
    renamed: Vec<(String, String)>,
    running: Vec<String>,
    /// Images committed from companions on the source, to carry them.
    committed: Vec<String>,
    /// Volumes this move created on the target.
    created_volumes: Vec<String>,
    /// Containers this move created on the target, the sandbox's included.
    created_containers: Vec<String>,
    /// Every volume carried, by name: what the source keeps for the days.
    volumes: Vec<String>,
    record: Option<crate::record::ChannelRecord>,
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
    carry.record = crate::record::read(slug).ok();
    // Stopped and set aside, the sandbox first and what lives beside it after.
    let mut aside: Vec<(String, &Value)> = vec![(sandbox.container.clone(), &sandbox.inspect)];
    aside.extend(
        sandbox
            .companions
            .iter()
            .map(|(name, inspect)| (name.clone(), inspect)),
    );
    for (name, inspect) in &aside {
        if inspect["State"]["Running"].as_bool() == Some(true) {
            carry.running.push(name.clone());
        }
        say(slug, "stopping", json!({ "container": name }));
        run_on(
            source,
            &["stop", "-t", "60", name],
            Duration::from_secs(120),
        )?;
        let moved = format!("{name}{MOVED_SUFFIX}");
        let _ = run_on(source, &["rm", "-f", &moved], docker::READ_LIMIT);
        run_on(source, &["rename", name, &moved], docker::READ_LIMIT)?;
        carry.renamed.push((name.clone(), moved));
    }
    heartbeat();

    // The companions' own files (an SSH key the deploy target was given lives in its container, not on a volume) go
    // across as images of themselves.
    let mut images = sandbox.images.clone();
    let mut companion_images = Vec::new();
    for (name, _) in &sandbox.companions {
        let image = format!("intentic-moved-{}:{}", name, now_ms());
        run_on(
            source,
            &["commit", &format!("{name}{MOVED_SUFFIX}"), &image],
            Duration::from_secs(600),
        )?;
        carry.committed.push(image.clone());
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
        let mut save: Vec<&str> = vec!["save"];
        save.extend(missing.iter().map(String::as_str));
        let total: u64 = missing
            .iter()
            .filter_map(|image| image_bytes(source, image))
            .sum();
        pipe(
            docker::command_on(source, &save),
            docker::command_on(target, &["load", "-q"]),
            slug,
            "image",
            total,
            log,
        )?;
        for image in &missing {
            if !same_image(source, target, image) {
                bail!("{image} did not arrive whole on the other engine.");
            }
        }
    }

    // The volumes, each checked against the original after the copy.
    let helper = &sandbox.images[0];
    for (volume, docker_data) in &sandbox.volumes {
        prepare_volume(source, target, to, slug, volume, carry)?;
        let total = volume_bytes(source, volume, helper).unwrap_or(0);
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
        let theirs = manifest(source, volume, helper, *docker_data)?;
        let ours = manifest(target, volume, helper, *docker_data)?;
        if theirs != ours {
            bail!(
                "the copy of {volume} does not match the original ({} files there, {} here).",
                theirs.0,
                ours.0
            );
        }
        log.line(&format!("{volume}: {} files match", ours.0));
        carry.volumes.push(volume.clone());
        heartbeat();
    }

    // The sandbox's network, then a stopped placeholder the reshape makes the sandbox from.
    ensure_network_on(target, slug)?;
    let placeholder = placeholder_args(&sandbox.inspect, &sandbox.container, &sandbox.images[0]);
    let refs: Vec<&str> = placeholder.iter().map(String::as_str).collect();
    run_on(target, &refs, Duration::from_secs(120))?;
    carry.created_containers.push(sandbox.container.clone());
    carry.created_containers.push(sandbox::parked_of(slug));

    say(slug, "starting", json!({}));
    let made = with_engine(target, || {
        crate::sandbox::recreate::run(
            crate::sandbox::recreate::Mode::Reshape(crate::shape::Ask::default()),
            Some(slug.clone()),
            crate::sandbox::recreate::Preflight::Skip,
        )
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
/// names back and run again if they ran. Best effort, and said when a step fails.
fn undo(carry: &Carried, source: &Target, target: &Target, log: &Log) {
    log.section(&format!("undoing {}", carry.slug));
    for container in carry.created_containers.iter().rev() {
        let _ = docker::capture_on(target, &["rm", "-f", container], docker::READ_LIMIT);
    }
    for volume in &carry.created_volumes {
        let _ = docker::capture_on(target, &["volume", "rm", "-f", volume], docker::READ_LIMIT);
    }
    for (name, moved) in &carry.renamed {
        if let Err(Fail(reason)) = run_on(source, &["rename", moved, name], docker::READ_LIMIT) {
            crate::ui::warn(&format!("could not give {name} its name back: {reason}"));
        }
    }
    for name in &carry.running {
        if let Err(Fail(reason)) = run_on(source, &["start", name], Duration::from_secs(120)) {
            crate::ui::warn(&format!("could not start {name} again: {reason}"));
        }
    }
    for image in &carry.committed {
        let _ = docker::capture_on(source, &["image", "rm", image], docker::READ_LIMIT);
    }
    if let Some(record) = &carry.record {
        let _ = crate::record::write(&carry.slug, record);
    }
    println!("intentic: {} is back as it was.", carry.slug);
}

/// A volume of the same name on the target is one an earlier move left there, which this move supersedes (removed with
/// its stopped container), or somebody else's, which it refuses to touch.
fn prepare_volume(
    source: &Target,
    target: &Target,
    to: Kind,
    slug: &str,
    volume: &str,
    carry: &mut Carried,
) -> Result<()> {
    let exists = docker::capture_on(target, &["volume", "inspect", volume], docker::READ_LIMIT)
        .is_ok_and(|ran| ran.code == Some(0));
    // Only a copy an earlier move left on THIS engine: the journal names each by the engine it stayed on.
    let left_by_us = load_journal().moved.iter().any(|moved| {
        !moved.removed
            && moved.slug == slug
            && moved.from == to.id()
            && moved.volumes.iter().any(|v| v == volume)
    });
    match volume_action(exists, left_by_us) {
        VolumeAction::Create => {}
        VolumeAction::Replace => {
            for moved in load_journal()
                .moved
                .iter()
                .filter(|moved| moved.slug == slug && !moved.removed && moved.from == to.id())
            {
                for container in &moved.containers {
                    let _ = docker::capture_on(target, &["rm", "-f", container], docker::READ_LIMIT);
                }
            }
            run_on(target, &["volume", "rm", volume], docker::READ_LIMIT)?;
        }
        VolumeAction::Refuse => bail!("a volume named {volume} already exists on the other engine and no earlier move left it there — remove or rename it, then try again."),
    }
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
    run_on(target, &refs, docker::READ_LIMIT)?;
    carry.created_volumes.push(volume.to_string());
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum VolumeAction {
    Create,
    Replace,
    Refuse,
}

fn volume_action(exists_on_target: bool, left_by_an_earlier_move: bool) -> VolumeAction {
    match (exists_on_target, left_by_an_earlier_move) {
        (false, _) => VolumeAction::Create,
        (true, true) => VolumeAction::Replace,
        (true, false) => VolumeAction::Refuse,
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
    let copied = pipe(
        docker::command_on(source, &out),
        docker::command_on(target, &into),
        slug,
        "volume",
        total,
        log,
    );
    // A CLI killed for a stall leaves its container running in the daemon: named, it is found and ended here.
    let _ = docker::capture_on(source, &["rm", "-f", &reading], docker::READ_LIMIT);
    let _ = docker::capture_on(target, &["rm", "-f", &writing], docker::READ_LIMIT);
    copied
}

/// A helper container's name: per sandbox and per end, so one left by a killed run is the next run's to remove.
fn helper_name(slug: &str, end: &str) -> String {
    format!("intentic-move-{slug}-{end}")
}

/// GNU tar on both ends (the sandbox image is Debian): numeric owners, extended attributes of every namespace (an
/// overlay layer's `trusted.overlay.*` are what make its deletions deletions), ACLs, sparse files kept sparse.
const TAR_OUT: &[&str] = &[
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
const TAR_IN: &[&str] = &[
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

fn manifest(on: &Target, volume: &str, helper: &str, docker_data: bool) -> Result<(u64, String)> {
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

fn parse_manifest(out: &str) -> Option<(u64, String)> {
    let mut lines = out.lines().map(str::trim).filter(|line| !line.is_empty());
    let count = lines.next()?.parse().ok()?;
    let hash = lines.next()?.split_whitespace().next()?.to_string();
    Some((count, hash))
}

/// `from`'s stdout into `to`'s stdin, counted for the progress line, and killed if no byte moves for [`STALL`].
fn pipe(
    mut from: Command,
    mut to: Command,
    slug: &str,
    step: &str,
    total: u64,
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
        bail!("reading it failed: {}", last_words(&from_said));
    }
    if !ok(to_status) || copied.is_err() {
        bail!("writing it failed: {}", last_words(&to_said));
    }
    Ok(())
}

fn tail_of(stream: Option<impl Read + Send + 'static>) -> std::sync::mpsc::Receiver<String> {
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

fn last_words(said: &str) -> String {
    said.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("docker said nothing")
        .trim()
        .to_string()
}

fn kill_pid(pid: u32) {
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

fn inspect_on(on: &Target, name: &str) -> Result<Value> {
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

fn env_of(inspect: &Value) -> Vec<String> {
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

fn env_value(env: &[String], name: &str) -> Option<String> {
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
fn named_volumes(inspect: &Value) -> Vec<(String, String)> {
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

/// The sandbox, created stopped on the other engine with what the reshape reads off it: its env (the shape and the
/// side ride there), its volumes where they were, its resolvers and labels. It never runs: its entrypoint exits.
fn placeholder_args(inspect: &Value, name: &str, image: &str) -> Vec<String> {
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

fn strings(value: &Value) -> Vec<String> {
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

fn ensure_network_on(on: &Target, slug: &str) -> Result<()> {
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
fn same_image(source: &Target, target: &Target, image: &str) -> bool {
    match (layers_on(source, image), layers_on(target, image)) {
        (Some(theirs), Some(ours)) => theirs == ours,
        _ => false,
    }
}

fn layers_on(on: &Target, image: &str) -> Option<String> {
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

fn image_id_on(on: &Target, image: &str) -> Option<String> {
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

fn image_bytes(on: &Target, image: &str) -> Option<u64> {
    docker::capture_on(
        on,
        &["image", "inspect", "--format", "{{.Size}}", image],
        docker::READ_LIMIT,
    )
    .ok()
    .filter(|ran| ran.code == Some(0))
    .and_then(|ran| ran.stdout.trim().parse().ok())
}

fn volume_bytes(on: &Target, volume: &str, helper: &str) -> Option<u64> {
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

fn run_on(on: &Target, args: &[&str], limit: Duration) -> Result<()> {
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

fn heartbeat() {
    let _ = update_journal(|journal| {
        if let Some(moving) = journal.moving.as_mut() {
            moving.heartbeat = now_ms();
        }
    });
}

/// One `intentic-move:` line for the desktop app's card.
fn say(slug: &str, step: &str, detail: Value) {
    let mut line = json!({ "slug": slug, "step": step });
    if let (Some(line), Some(detail)) = (line.as_object_mut(), detail.as_object()) {
        for (key, value) in detail {
            line.insert(key.clone(), value.clone());
        }
    }
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

    #[test]
    fn a_move_is_in_progress_only_while_its_ic_says_so() {
        let mut journal = Journal::default();
        assert!(!moving_now(&journal, 1_000_000));
        journal.moving = Some(Moving {
            pid: 1,
            to: "intentic".into(),
            started: 0,
            heartbeat: 1_000_000,
        });
        assert!(moving_now(&journal, 1_000_000 + 60_000));
        assert!(!moving_now(&journal, 1_000_000 + STALE_HEARTBEAT_MS + 1));
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
        };
        let due: Vec<String> = expired(&journal, 200).into_iter().map(|m| m.slug).collect();
        assert_eq!(due, vec!["a".to_string()]);
    }

    #[test]
    fn the_summary_names_what_is_kept_and_where() {
        assert_eq!(summary_of(&Journal::default(), 0), None);
        let journal = Journal {
            moving: None,
            moved: vec![moved("a", 10, 100)],
        };
        let summary = summary_of(&journal, 20).unwrap();
        assert_eq!(summary["moving"], false);
        assert_eq!(summary["last"]["to"], "intentic");
        assert_eq!(summary["leftBehind"][0]["slug"], "a");
        assert_eq!(summary["leftBehind"][0]["on"], "dockerDesktop");
    }

    #[test]
    fn a_volume_already_there_is_replaced_only_when_an_earlier_move_left_it() {
        assert_eq!(volume_action(false, false), VolumeAction::Create);
        assert_eq!(volume_action(false, true), VolumeAction::Create);
        assert_eq!(volume_action(true, true), VolumeAction::Replace);
        assert_eq!(volume_action(true, false), VolumeAction::Refuse);
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
            moving: Some(Moving {
                pid: 7,
                to: "intentic".into(),
                started: 1,
                heartbeat: 2,
            }),
            moved: vec![moved("a", 1, 2)],
        };
        let text = serde_json::to_string(&journal).unwrap();
        assert!(text.contains("\"removeAfter\""));
        let back: Journal = serde_json::from_str(&text).unwrap();
        assert_eq!(back, journal);
    }
}
