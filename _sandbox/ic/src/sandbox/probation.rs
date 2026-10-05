use serde_json::{json, Value};

use crate::docker;
use crate::logfile::Log;
use crate::record::{self, ChannelRecord, Phase, Swap};
use crate::sandbox::lock::{self, Wait};
use crate::sandbox::outcome::{self, Kind, Outcome};
use crate::sandbox::recreate::{self, Mode, Preflight};
use crate::sandbox::{container_of, live_slugs, mirror, now_ms, parked_of};
use crate::util::Result;

/* THE WAY BACK DOES NOT NEED THE SANDBOX.

After a swap the old container stays parked, stopped and ready, for a probation period. `ic sandbox watch` looks at the
new version and, when it keeps crashing, never becomes ready, cannot convert the stored files or loses the tunnel the
old one had, puts the old container back by itself: a rename and a start, no download, no build, nothing asked of the
broken daemon. The machine agent runs it every minute while a swap is on probation; without an agent, every ic run
that touches the sandbox finishes what an interrupted one left. The same look finishes a swap that died halfway
(Ctrl-C, a closed SSH session, an agent restart, a reboot): the record says a cutover was in flight, and what is on
docker says how far it got. */

/// How long the parked container is kept after a swap. `IC_PROBATION_SECONDS` shortens it for the nightly drill.
const PROBATION_SECS: u64 = 24 * 60 * 60;
/// How long a new version may stay not-ready, unreachable or silent before that counts against it. Longer than any
/// healthy first boot (state conversions, a cold cache), which the swap's own health check already waited through.
const GRACE_SECS: u64 = 10 * 60;
/// An open state journal is a boot still converting; past this it is a boot that will not finish.
const JOURNAL_SECS: u64 = 15 * 60;
/// Consecutive failed looks that end a probation in a rollback: the agent looks every minute, so about three minutes
/// of a version that is plainly down, never one bad answer.
const STRIKES: u32 = 3;
/// Container restarts that are a crash loop on their own, whatever the daemon says.
const RESTARTS: u64 = 3;
/// Daemon restarts inside a running container (the front restarts a crashed daemon without the container stopping)
/// that are a crash loop on their own.
const DAEMON_RESTARTS: u32 = 3;

const HEALTH_URL: &str = "http://localhost:8787/health";

/// How often an ic run doing a cutover says it is alive, and how long without that before its cutover counts as
/// interrupted. The gap is several beats wide: a heartbeat is a record write and a `docker cp`, and a busy machine is
/// allowed to be slow at both.
const HEARTBEAT_SECS: u64 = 15;
const STALE_MS: u64 = 90_000;

/// Whether a cutover the record names is being done right now by a live ic run (its own heartbeat is fresh), which
/// nothing else may finish or undo under it. A record with no heartbeat is judged by when the cutover began. Pure.
pub fn cutover_in_progress(swap: &Swap, now: u64) -> bool {
    swap.phase == Phase::Cutover && now.saturating_sub(swap.alive.unwrap_or(swap.at)) < STALE_MS
}

/// The heartbeat of a cutover in flight, on a thread of its own: every few seconds, while the record still names this
/// cutover, it stamps `swap_alive` and copies the record to the sandbox's volume. Stopped (joined) before the flow
/// writes the record that settles the swap, so a late beat can never write a finished swap back as in flight.
pub struct Heartbeat {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Heartbeat {
    pub fn start(slug: &str, at: u64) -> Heartbeat {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let slug = slug.to_string();
        let handle = std::thread::spawn(move || {
            let stopped = || flag.load(std::sync::atomic::Ordering::SeqCst);
            loop {
                for _ in 0..HEARTBEAT_SECS {
                    if stopped() {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
                let Ok(record) = record::read(&slug) else {
                    continue;
                };
                let Some(swap) = record
                    .swap
                    .clone()
                    .filter(|swap| swap.phase == Phase::Cutover && swap.at == at)
                else {
                    return;
                };
                if stopped() {
                    return;
                }
                let beat = ChannelRecord {
                    swap: Some(Swap {
                        alive: Some(now_ms()),
                        ..swap
                    }),
                    ..record
                };
                if record::write(&slug, &beat).is_ok() {
                    mirror::push(&slug);
                }
            }
        });
        Heartbeat {
            stop,
            handle: Some(handle),
        }
    }

    /// Idempotent: the flow stops it on whichever path it leaves the cutover by.
    pub fn stop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.stop();
    }
}

fn seconds_env(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

/// The probation length in milliseconds; 0 turns it off (the parked container is removed once the swap passes).
pub fn probation_ms() -> u64 {
    seconds_env("IC_PROBATION_SECONDS", PROBATION_SECS) * 1000
}

fn grace_ms() -> u64 {
    seconds_env("IC_WATCH_GRACE_SECONDS", GRACE_SECS) * 1000
}

/// "3 h 20 min", "12 min": how long is left of a probation, for a person.
pub fn remaining(until: u64) -> String {
    let minutes = until.saturating_sub(now_ms()) / 60_000;
    match minutes {
        0 => "less than a minute".to_string(),
        m if m < 60 => format!("{m} min"),
        m => format!("{} h {} min", m / 60, m % 60),
    }
}

/// What one look at the new version found.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Look {
    pub running: bool,
    pub restarting: bool,
    pub restarts: u64,
    /// `/health` answered with a document.
    pub answered: bool,
    /// `boot.ready` (or an older daemon's top-level `ready`); None from a daemon that reports neither.
    pub ready: Option<bool>,
    /// `state.journal`: open, none, failed.
    pub journal: Option<String>,
    /// `reach.state`: off, checking, reachable, unreachable.
    pub reach: Option<String>,
    /// What the daemon wrote to /history/boot-failure.json, when it wrote it after the swap began.
    pub boot_failure: Option<String>,
    /// When the daemon last started, off its boot marker (/history/logs/daemon-exit.json).
    pub daemon_started: Option<u64>,
    /// How many times the probation has seen that daemon start again (restarts_seen).
    pub daemon_restarts: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    /// Healthy: the strikes start over.
    Healthy,
    /// Too early to hold anything against it.
    Pending,
    /// One failed look.
    Strike(String),
    /// Nothing to wait for: go back now.
    Fail(String),
}

/// The judgement, pure over one look, the swap and the clock.
pub fn judge(look: &Look, swap: &Swap, now: u64, grace_ms: u64) -> Verdict {
    let since = now.saturating_sub(swap.at);
    let late = since >= grace_ms;
    if let Some(error) = &look.boot_failure {
        return Verdict::Fail(format!("the new version could not start: {error}"));
    }
    if look.journal.as_deref() == Some("failed") {
        return Verdict::Fail(
            "the new version could not convert this sandbox's stored files; it put them back as they were".to_string(),
        );
    }
    if look.daemon_restarts >= DAEMON_RESTARTS {
        return Verdict::Fail(format!(
            "the new version's daemon kept crashing ({} restarts)",
            look.daemon_restarts
        ));
    }
    if !look.running || look.restarting {
        if look.restarts >= RESTARTS {
            return Verdict::Fail(format!(
                "the new version kept crashing ({} restarts)",
                look.restarts
            ));
        }
        return Verdict::Strike("the new version's container is not running".to_string());
    }
    if !look.answered {
        return if late {
            Verdict::Strike("the new version's daemon is not answering".to_string())
        } else {
            Verdict::Pending
        };
    }
    if look.journal.as_deref() == Some("open") {
        return if since >= JOURNAL_SECS * 1000 {
            Verdict::Strike(
                "the new version is still converting stored files after 15 minutes".to_string(),
            )
        } else {
            Verdict::Pending
        };
    }
    if look.ready == Some(false) {
        return if late {
            Verdict::Strike("the new version never finished starting up".to_string())
        } else {
            Verdict::Pending
        };
    }
    // Held only to a tunnel the old version had: a sandbox reached on loopback alone has none to lose.
    if swap.reach.as_deref() == Some("reachable") {
        match look.reach.as_deref() {
            Some("unreachable") if late => {
                return Verdict::Strike(
                    "the new version cannot be reached through its tunnel".to_string(),
                );
            }
            Some("checking") if since >= grace_ms + 5 * 60_000 => {
                return Verdict::Strike("the new version's tunnel never came up".to_string());
            }
            Some("unreachable" | "checking") => return Verdict::Pending,
            _ => {}
        }
    }
    Verdict::Healthy
}

/// One look at `container`, through docker alone: its state, its `/health`, and the boot failure its daemon left.
pub fn look(container: &str, swap_at: u64) -> Look {
    let mut found = Look::default();
    if let Some(state) = docker::inspect(
        container,
        "{{.State.Running}} {{.State.Restarting}} {{.RestartCount}}",
    ) {
        let mut fields = state.split_whitespace();
        found.running = fields.next() == Some("true");
        found.restarting = fields.next() == Some("true");
        found.restarts = fields
            .next()
            .and_then(|count| count.parse().ok())
            .unwrap_or(0);
    }
    if found.running {
        if let Some(health) =
            docker::exec_capture(container, &["curl", "-sf", "-m", "10", HEALTH_URL])
                .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        {
            found.answered = true;
            found.ready = health
                .get("boot")
                .and_then(|boot| boot.get("ready"))
                .or_else(|| health.get("ready"))
                .and_then(Value::as_bool);
            found.journal = health["state"]["journal"].as_str().map(str::to_string);
            found.reach = health["reach"]["state"].as_str().map(str::to_string);
        }
    }
    found.boot_failure = boot_failure_since(container, swap_at);
    found.daemon_started = file_json(container, "/history/logs/daemon-exit.json")
        .and_then(|marker| marker["startedAt"].as_u64());
    found
}

/// A small JSON file off the sandbox's volume. `docker cp` reads it whether or not the container is running.
fn file_json(container: &str, path: &str) -> Option<Value> {
    let dir = tempfile::tempdir().ok()?;
    let dest = dir.path().join("read.json");
    docker::cp_out(container, path, &dest)
        .is_none()
        .then(|| std::fs::read_to_string(&dest).ok())
        .flatten()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
}

/// The daemon start this look saw, folded into what the probation already knew: a start the watch has not seen
/// before, after one it had, is a restart. Pure.
pub fn restarts_seen(swap: &Swap, started: Option<u64>) -> (Option<u64>, u32) {
    match (swap.daemon_start, started) {
        (Some(before), Some(now)) if now != before && now >= swap.at => {
            (Some(now), swap.daemon_restarts + 1)
        }
        (None, Some(now)) => (Some(now), swap.daemon_restarts),
        (known, _) => (known, swap.daemon_restarts),
    }
}

/// The error the daemon recorded on /history/boot-failure.json, when it recorded it after `since`. `docker cp` reads
/// it off a container that is not running too, which is the state a crash-looping one is often found in.
pub fn boot_failure_since(container: &str, since: u64) -> Option<String> {
    file_json(container, "/history/boot-failure.json")
        .filter(|failure| failure["at"].as_u64().is_some_and(|at| at >= since))
        .map(|failure| {
            failure["error"]
                .as_str()
                .unwrap_or("it gave no reason")
                .lines()
                .next()
                .unwrap_or("")
                .to_string()
        })
}

/// What `watch` did to one sandbox, for the agent (`--json`) and a person.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub slug: String,
    pub action: &'static str,
    pub reason: Option<String>,
}

impl Report {
    fn new(slug: &str, action: &'static str, reason: Option<String>) -> Report {
        Report {
            slug: slug.to_string(),
            action,
            reason,
        }
    }

    fn json(&self) -> String {
        let mut value = json!({"slug": self.slug, "action": self.action});
        if let Some(reason) = &self.reason {
            value["reason"] = json!(reason);
        }
        value.to_string()
    }

    pub(crate) fn sentence(&self) -> String {
        let what = match self.action {
            "none" => "nothing to do".to_string(),
            "watching" => "on probation, watching".to_string(),
            "kept" => "probation over, the new version stays".to_string(),
            "restored" => {
                "an interrupted swap was undone, the previous version is back".to_string()
            }
            "rolled-back" => {
                "the new version kept failing, so the previous version is back".to_string()
            }
            "busy" => "another ic run is working on it; looked again next time".to_string(),
            "elsewhere" => "the other side of this computer watches it".to_string(),
            other => other.to_string(),
        };
        match &self.reason {
            Some(reason) => format!("intentic: {}: {what} ({reason}).", self.slug),
            None => format!("intentic: {}: {what}.", self.slug),
        }
    }
}

/// `ic sandbox watch [slug] [--json]` — finish or undo a swap that was interrupted, and judge a probation. Changes
/// nothing when no swap is in flight. With no slug, every sandbox on this machine.
pub fn run(slug: Option<String>, as_json: bool) -> Result<()> {
    docker::require_daemon()?;
    let slugs = match slug {
        Some(slug) => vec![slug],
        None => live_slugs().unwrap_or_default(),
    };
    for slug in slugs {
        // Unattended (the machine agent's round has no terminal), the other side's swap is that side's to judge: two
        // watches on one swap each hold only their own side's lock, and could both roll it back (side.rs).
        let elsewhere = (!crate::tty::have_tty())
            .then(|| super::side::kept_elsewhere(&slug))
            .flatten();
        let report = match elsewhere {
            Some(side) => Report::new(&slug, "elsewhere", Some(super::side::sentence(&side))),
            None => match lock::hold(&slug, Wait::Skip)? {
                None => Report::new(&slug, "busy", None),
                Some(_held) => watch_one(&slug)?,
            },
        };
        if as_json {
            println!("{}", report.json());
        } else {
            println!("{}", report.sentence());
        }
    }
    Ok(())
}

/// One sandbox. The caller holds its lock.
pub fn watch_one(slug: &str) -> Result<Report> {
    let record = mirror::reconcile(slug);
    let container = container_of(slug);
    let parked = parked_of(slug);
    let live = docker::container_exists(&container);
    let has_parked = docker::container_exists(&parked);
    let Some(swap) = record.swap.clone() else {
        // A swap an ic from before the record's swap keys left parked with no replacement.
        if !live && has_parked {
            unpark(&container, &parked);
            return Ok(Report::new(
                slug,
                "restored",
                Some("an update was interrupted before the new version started".to_string()),
            ));
        }
        return Ok(Report::new(slug, "none", None));
    };
    match swap.phase {
        Phase::Cutover => recover_cutover(slug, &record, &swap, live, has_parked),
        Phase::Probation => judge_probation(slug, &record, &swap, live, has_parked),
    }
}

/// A cutover the record says was in flight, found in whatever state it was interrupted in. One that is still alive
/// (its ic run's heartbeat is fresh) is not interrupted, and is left to finish.
fn recover_cutover(
    slug: &str,
    record: &ChannelRecord,
    swap: &Swap,
    live: bool,
    has_parked: bool,
) -> Result<Report> {
    if cutover_in_progress(swap, now_ms()) {
        return Ok(Report::new(
            slug,
            "busy",
            Some("a swap is in progress".to_string()),
        ));
    }
    let container = container_of(slug);
    let parked = parked_of(slug);
    match (live, has_parked) {
        // Parked, and no replacement was started: put it back.
        (false, true) => {
            undo(
                slug,
                record,
                swap,
                Kind::Restored,
                "the update was interrupted before the new version started",
            )?;
            Ok(Report::new(
                slug,
                "restored",
                Some("the update was interrupted before the new version started".to_string()),
            ))
        }
        // A replacement exists beside the parked one: judge it like any new version on probation.
        (true, true) => {
            let running =
                docker::inspect(&container, "{{.State.Running}}").as_deref() == Some("true");
            if !running {
                undo(
                    slug,
                    record,
                    swap,
                    Kind::Restored,
                    "the update was interrupted and the new version never started",
                )?;
                return Ok(Report::new(
                    slug,
                    "restored",
                    Some("the new version never started".to_string()),
                ));
            }
            let promoted = Swap {
                phase: Phase::Probation,
                until: Some(swap.until.unwrap_or(swap.at + probation_ms())),
                ..swap.clone()
            };
            let record = ChannelRecord {
                swap: Some(promoted.clone()),
                ..record.clone()
            };
            record::write(slug, &record)?;
            mirror::push(slug);
            judge_probation(slug, &record, &promoted, true, true)
        }
        // Stopped before it was set aside: the old container is still here under its own name.
        (true, false) => {
            if docker::inspect(&container, "{{.State.Running}}").as_deref() != Some("true") {
                docker::quiet(&["start", &container]);
            }
            settle(slug, record, true)?;
            Ok(Report::new(
                slug,
                "restored",
                Some("the update was interrupted before the swap began".to_string()),
            ))
        }
        (false, false) => {
            settle(slug, record, true)?;
            let _ = parked;
            Ok(Report::new(
                slug,
                "none",
                Some("no container is left for this sandbox".to_string()),
            ))
        }
    }
}

fn judge_probation(
    slug: &str,
    record: &ChannelRecord,
    swap: &Swap,
    live: bool,
    has_parked: bool,
) -> Result<Report> {
    let container = container_of(slug);
    if !live {
        if has_parked {
            undo(
                slug,
                record,
                swap,
                Kind::RolledBack,
                "the new version's container is gone",
            )?;
            return Ok(Report::new(
                slug,
                "rolled-back",
                Some("the new version's container is gone".to_string()),
            ));
        }
        settle(slug, record, false)?;
        return Ok(Report::new(
            slug,
            "none",
            Some("no container is left for this sandbox".to_string()),
        ));
    }
    let now = now_ms();
    let mut seen = look(&container, swap.at);
    let (daemon_start, daemon_restarts) = restarts_seen(swap, seen.daemon_started);
    seen.daemon_restarts = daemon_restarts;
    let tracked = Swap {
        daemon_start,
        daemon_restarts,
        ..swap.clone()
    };
    let verdict = judge(&seen, &tracked, now, grace_ms());
    let over = tracked.until.is_some_and(|until| now >= until);
    match verdict {
        Verdict::Fail(reason) => {
            undo(slug, record, &tracked, Kind::RolledBack, &reason)?;
            Ok(Report::new(slug, "rolled-back", Some(reason)))
        }
        Verdict::Strike(reason) if tracked.strikes + 1 >= STRIKES => {
            undo(slug, record, &tracked, Kind::RolledBack, &reason)?;
            Ok(Report::new(slug, "rolled-back", Some(reason)))
        }
        Verdict::Strike(reason) => {
            write_swap(
                slug,
                record,
                Swap {
                    strikes: tracked.strikes + 1,
                    ..tracked
                },
            )?;
            Ok(Report::new(slug, "watching", Some(reason)))
        }
        Verdict::Healthy | Verdict::Pending if over => {
            keep(slug, record, &tracked)?;
            Ok(Report::new(slug, "kept", None))
        }
        Verdict::Healthy => {
            let settled = Swap {
                strikes: 0,
                ..tracked
            };
            if settled != *swap {
                write_swap(slug, record, settled)?;
            }
            Ok(Report::new(slug, "watching", None))
        }
        Verdict::Pending => {
            if tracked != *swap {
                write_swap(slug, record, tracked)?;
            }
            Ok(Report::new(slug, "watching", None))
        }
    }
}

fn write_swap(slug: &str, record: &ChannelRecord, swap: Swap) -> Result<()> {
    record::write(
        slug,
        &ChannelRecord {
            swap: Some(swap),
            ..record.clone()
        },
    )?;
    mirror::push(slug);
    Ok(())
}

/// Put a parked container back under its name and start it. The replacement, if any, is removed first.
fn unpark(container: &str, parked: &str) {
    docker::quiet(&["rm", "-f", container]);
    docker::quiet(&["rename", parked, container]);
    docker::quiet(&["start", container]);
}

/// Go back to the version the swap left: the parked container when it is still here (seconds, nothing downloaded or
/// built), else a rollback to the pinned image. The record becomes what it was before the swap, remembering which
/// version was given up on, and the sandbox is told why.
fn undo(slug: &str, record: &ChannelRecord, swap: &Swap, kind: Kind, reason: &str) -> Result<()> {
    let container = container_of(slug);
    let parked = parked_of(slug);
    let log = Log::create_named("recreate", "recreate-watch")?;
    log.section(&format!(
        "going back from {} ({reason})",
        swap.to.as_deref().unwrap_or("the new version")
    ));
    if docker::container_exists(&container) {
        log.section(&format!("container logs ({container})"));
        docker::logs_into(&container, "500", &log);
    }
    let before = record::read_before(slug).ok().flatten();
    if docker::container_exists(&parked) {
        unpark(&container, &parked);
        let restored = ChannelRecord {
            swap: None,
            rolled_back_from: swap.to.clone().or_else(|| record.rolled_back_from.clone()),
            ..before.unwrap_or_else(|| record.clone())
        };
        record::write(slug, &restored)?;
        record::remove_before(slug);
    } else {
        // No parked container: the pin the swap recorded is the way back, through the ordinary rollback flow.
        settle(slug, record, false)?;
        recreate::run(
            Mode::Rollback { to: None },
            Some(slug.to_string()),
            Preflight::Run,
        )?;
        let after = record::read(slug)?;
        record::write(
            slug,
            &ChannelRecord {
                rolled_back_from: swap.to.clone(),
                ..after
            },
        )?;
    }
    mirror::push(slug);
    outcome::write(
        &container,
        &Outcome {
            result: kind,
            verb: "watch",
            from: swap.from.as_deref(),
            to: swap.to.as_deref(),
            reason: Some(reason),
            log: Some(&log.path),
            keep_until: None,
        },
    );
    crate::ui::warn(&format!(
        "{slug}: went back from {} — {reason}. Log: {}",
        swap.to.as_deref().unwrap_or("the new version"),
        log.path.display()
    ));
    Ok(())
}

/// The probation is over and the new version stays: let the parked container go, drop the pins nothing names any
/// more, and tell the sandbox.
fn keep(slug: &str, record: &ChannelRecord, swap: &Swap) -> Result<()> {
    docker::quiet(&["rm", "-f", &parked_of(slug)]);
    let before = record::read_before(slug).ok().flatten();
    record::write(
        slug,
        &ChannelRecord {
            swap: None,
            ..record.clone()
        },
    )?;
    record::remove_before(slug);
    if let Some(before) = before {
        drop_unnamed_pins(slug, &before, record);
    }
    mirror::push(slug);
    outcome::write(
        &container_of(slug),
        &Outcome {
            result: Kind::Kept,
            verb: &swap.verb,
            from: swap.from.as_deref(),
            to: swap.to.as_deref(),
            reason: None,
            log: None,
            keep_until: None,
        },
    );
    Ok(())
}

/// Pins the record before the swap named that the record now does not: what the swap pushed off the end of the list.
/// Kept through the probation so going back finds every one of them; only this sandbox's own pins are ever removed.
pub fn drop_unnamed_pins(slug: &str, before: &ChannelRecord, now: &ChannelRecord) {
    let named: Vec<String> = now.targets().into_iter().map(|pin| pin.image).collect();
    for pin in before.targets() {
        if pin
            .image
            .starts_with(&format!("intentic-sandbox-rollback-{slug}:"))
            && !named.contains(&pin.image)
        {
            docker::quiet(&["rmi", &pin.image]);
        }
    }
}

/// A swap that is over without being judged (a new swap superseding it, an interrupted one undone by hand): the record
/// loses its swap keys, and an interrupted CUTOVER's record goes back to what it was before it, since the swap it
/// described did not happen.
pub fn settle(slug: &str, record: &ChannelRecord, interrupted: bool) -> Result<ChannelRecord> {
    let before = record::read_before(slug).ok().flatten();
    let settled = match (interrupted, before) {
        (true, Some(before)) => ChannelRecord {
            swap: None,
            ..before
        },
        _ => ChannelRecord {
            swap: None,
            ..record.clone()
        },
    };
    record::write(slug, &settled)?;
    record::remove_before(slug);
    mirror::push(slug);
    Ok(settled)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    fn swap(at: u64, reach: Option<&str>) -> Swap {
        Swap {
            phase: Phase::Probation,
            at,
            verb: "update".to_string(),
            from: Some("1.315.0".to_string()),
            to: Some("1.316.0".to_string()),
            until: Some(at + 24 * 60 * MIN),
            reach: reach.map(str::to_string),
            strikes: 0,
            daemon_start: None,
            daemon_restarts: 0,
            alive: None,
        }
    }

    fn healthy() -> Look {
        Look {
            running: true,
            answered: true,
            ready: Some(true),
            journal: Some("none".to_string()),
            reach: Some("reachable".to_string()),
            ..Look::default()
        }
    }

    #[test]
    fn a_healthy_new_version_is_healthy_at_any_time() {
        assert_eq!(
            judge(&healthy(), &swap(0, Some("reachable")), 1, 10 * MIN),
            Verdict::Healthy
        );
        assert_eq!(
            judge(&healthy(), &swap(0, Some("reachable")), 600 * MIN, 10 * MIN),
            Verdict::Healthy
        );
    }

    #[test]
    fn slowness_inside_the_grace_is_waited_out_and_held_against_it_after() {
        let starting = Look {
            ready: Some(false),
            ..healthy()
        };
        assert_eq!(
            judge(&starting, &swap(0, None), 5 * MIN, 10 * MIN),
            Verdict::Pending
        );
        assert!(matches!(
            judge(&starting, &swap(0, None), 11 * MIN, 10 * MIN),
            Verdict::Strike(_)
        ));
        let silent = Look {
            answered: false,
            ..healthy()
        };
        assert_eq!(
            judge(&silent, &swap(0, None), 5 * MIN, 10 * MIN),
            Verdict::Pending
        );
        assert!(matches!(
            judge(&silent, &swap(0, None), 11 * MIN, 10 * MIN),
            Verdict::Strike(_)
        ));
    }

    #[test]
    fn a_crash_loop_a_failed_conversion_or_a_failed_boot_goes_back_at_once() {
        let looping = Look {
            running: false,
            restarts: 3,
            ..Look::default()
        };
        assert!(matches!(
            judge(&looping, &swap(0, None), MIN, 10 * MIN),
            Verdict::Fail(_)
        ));
        let failed = Look {
            journal: Some("failed".to_string()),
            ..healthy()
        };
        assert!(matches!(
            judge(&failed, &swap(0, None), MIN, 10 * MIN),
            Verdict::Fail(_)
        ));
        let boot = Look {
            boot_failure: Some("SQLITE_CORRUPT".to_string()),
            ..Look::default()
        };
        match judge(&boot, &swap(0, None), MIN, 10 * MIN) {
            Verdict::Fail(reason) => assert!(reason.contains("SQLITE_CORRUPT"), "{reason}"),
            other => panic!("expected a failure, got {other:?}"),
        }
        // A container that stopped once is a strike, not yet a loop.
        let stopped = Look {
            running: false,
            restarts: 1,
            ..Look::default()
        };
        assert!(matches!(
            judge(&stopped, &swap(0, None), MIN, 10 * MIN),
            Verdict::Strike(_)
        ));
    }

    #[test]
    fn a_tunnel_is_only_required_of_a_version_whose_predecessor_had_one() {
        let lost = Look {
            reach: Some("unreachable".to_string()),
            ..healthy()
        };
        assert!(matches!(
            judge(&lost, &swap(0, Some("reachable")), 11 * MIN, 10 * MIN),
            Verdict::Strike(_)
        ));
        assert_eq!(
            judge(&lost, &swap(0, Some("reachable")), 5 * MIN, 10 * MIN),
            Verdict::Pending
        );
        // The old version had no tunnel to lose (a loopback-only sandbox, or one whose edge was already down).
        assert_eq!(
            judge(&lost, &swap(0, Some("unreachable")), 11 * MIN, 10 * MIN),
            Verdict::Healthy
        );
        assert_eq!(
            judge(&lost, &swap(0, None), 11 * MIN, 10 * MIN),
            Verdict::Healthy
        );
        // A daemon too old to probe itself is not held to a probe.
        let unprobed = Look {
            reach: None,
            ..healthy()
        };
        assert_eq!(
            judge(&unprobed, &swap(0, Some("reachable")), 11 * MIN, 10 * MIN),
            Verdict::Healthy
        );
    }

    #[test]
    fn a_long_open_journal_is_a_boot_that_will_not_finish() {
        let converting = Look {
            journal: Some("open".to_string()),
            ..healthy()
        };
        assert_eq!(
            judge(&converting, &swap(0, None), 14 * MIN, 10 * MIN),
            Verdict::Pending
        );
        assert!(matches!(
            judge(&converting, &swap(0, None), 16 * MIN, 10 * MIN),
            Verdict::Strike(_)
        ));
    }

    #[test]
    fn a_daemon_that_keeps_starting_again_inside_a_running_container_is_a_crash_loop() {
        let at = 1_000;
        let first = swap(at, None);
        // The first start the watch sees is the baseline, not a restart.
        assert_eq!(restarts_seen(&first, Some(at + 10)), (Some(at + 10), 0));
        let known = Swap {
            daemon_start: Some(at + 10),
            ..first.clone()
        };
        assert_eq!(restarts_seen(&known, Some(at + 10)), (Some(at + 10), 0));
        assert_eq!(restarts_seen(&known, Some(at + 50)), (Some(at + 50), 1));
        // A marker that cannot be read changes nothing.
        assert_eq!(restarts_seen(&known, None), (Some(at + 10), 0));
        let looping = Look {
            daemon_restarts: 3,
            ..healthy()
        };
        assert!(
            matches!(judge(&looping, &first, 2 * MIN, 10 * MIN), Verdict::Fail(reason) if reason.contains("3 restarts"))
        );
    }

    #[test]
    fn a_cutover_with_a_fresh_heartbeat_is_in_progress_and_one_gone_quiet_is_interrupted() {
        let cutover = Swap {
            phase: Phase::Cutover,
            ..swap(1_000, None)
        };
        assert!(cutover_in_progress(&cutover, 1_000 + 30_000));
        assert!(!cutover_in_progress(&cutover, 1_000 + 120_000));
        let beating = Swap {
            alive: Some(200_000),
            ..cutover.clone()
        };
        assert!(cutover_in_progress(&beating, 250_000));
        assert!(!cutover_in_progress(&beating, 400_000));
        // A probation is never a cutover in progress, however recent.
        assert!(!cutover_in_progress(&swap(1_000, None), 1_001));
    }

    #[test]
    fn what_watch_says_is_one_json_line_the_agent_reads() {
        let report = Report::new(
            "abc",
            "rolled-back",
            Some("the new version kept crashing (3 restarts)".to_string()),
        );
        let parsed: Value = serde_json::from_str(&report.json()).expect("JSON");
        assert_eq!(
            parsed,
            json!({"slug": "abc", "action": "rolled-back", "reason": "the new version kept crashing (3 restarts)"})
        );
        assert_eq!(
            Report::new("abc", "none", None).json(),
            r#"{"action":"none","slug":"abc"}"#
        );
    }
}
