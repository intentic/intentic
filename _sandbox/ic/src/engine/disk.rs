//! THE ENGINE'S DISK (2026-11-03). Every sandbox on a Windows PC and every compose project its owner runs on the intentic
//! engine write to one ext4 disk inside its distro (a VHDX that reads as about 1 TB). On rog, 2026-11-03, one sandbox's
//! history volume (462 GB, nearly all Rust `target/` in conversation checkouts) filled it, and an unrelated Postgres of
//! the owner's PANICked on ENOSPC and stayed down. Nothing said so beforehand: Windows and WSL's own `df` show other
//! disks, a sandbox's disk-pressure watch can clean only its own checkouts, and `ic sandbox tidy` runs once a day. So:
//! - `ic engine disk` reads the disk from inside the distro (one `df` through `wsl.exe --exec`), and the level that makes
//!   ([`level`]). The level is read off what a process that is NOT root may still write: ext4 holds 5% back for root
//!   (54 GB of rog's disk), and a database in a container writes as its own user, so it meets ENOSPC there first;
//! - `--consumers` names what takes the space and whose it is (disk_consumers.rs). Docker measures every volume for it,
//!   which took from one minute to more than ten on rog, so a measurement is kept and reused for `--max-age` minutes,
//!   and `--kept` answers from it at any age without measuring;
//! - `--relieve` clears what is nobody's data, more of it at each level ([`relief_for`]): the build cache and dangling
//!   images, and when the disk is all but full the ballast the keeper holds back (rootfs/intentic-engine, THE DISK'S
//!   BALLAST). Never a volume, never an image a sandbox or a person can still use.
//!
//! The machine agent asks every minute and tells the owner once per level crossed
//! (`_devices/machine/src/device/sandbox-rounds/engine-disk.ts`).
#![cfg_attr(not(windows), allow(dead_code))]

use std::time::Duration;

use serde_json::{json, Value};

use super::disk_consumers::{self, Breakdown};
use super::Kind;
use crate::ui;
use crate::util::{Fail, Result};

const MIB: u64 = 1024 * 1024;

/// Under this share of the disk left to write, it is low: the sandboxes' own watch says low at the same share of their
/// history volume, which on this engine is this disk (`_sandbox/sandbox/src/system/resources/storage/disk-pressure.ts`).
pub const LOW_BELOW_PERCENT: u64 = 10;
/// Under this share, critical: one more big build or pull from full.
pub const CRITICAL_BELOW_PERCENT: u64 = 5;
/// The ballast the keeper holds back: this share of the disk, within the two bounds below. Big enough that giving it
/// back lets a database checkpoint, git finish a pack and the sandboxes' reapers start; small enough not to matter on
/// a disk with room.
pub const BALLAST_PERCENT: u64 = 2;
pub const BALLAST_MIN_MIB: u64 = 2 * 1024;
pub const BALLAST_MAX_MIB: u64 = 10 * 1024;
/// Where the keeper keeps it: on the engine's own disk, outside Docker's data root, so nothing Docker does counts it.
pub const BALLAST_PATH: &str = "/var/lib/intentic-engine/ballast";
/// Docker's data root in the distro (the keeper's `--data-root`).
pub const DATA_ROOT: &str = "/var/lib/docker";

/// What the distro is asked: the data root's `df` line, then the ballast's size in bytes (0 when there is none).
pub fn disk_script() -> String {
    format!("df -Pk {DATA_ROOT} | tail -n 1; stat -c %s {BALLAST_PATH} 2>/dev/null || echo 0")
}

/// How long `df` gets: it answers in milliseconds, and wsl.exe retries once on its own service timing out.
const READ_LIMIT: Duration = Duration::from_secs(20);
/// How long one prune gets: a cache of 80 GB is gone in a minute or two.
const PRUNE_LIMIT: Duration = Duration::from_secs(600);

/// One reading of the engine's disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reading {
    pub total_bytes: u64,
    /// What a process that is not root may still write (df's Available): where a database in a container stops.
    pub available_bytes: u64,
    /// Free blocks, root's reserve included.
    pub free_bytes: u64,
    /// The keeper's ballast, held back until the disk is all but full; 0 when there is none.
    pub ballast_bytes: u64,
}

/// `df -Pk` (1024-blocks, used, available) and the ballast's bytes, as [`disk_script`] prints them. Pure.
pub fn parse_reading(said: &str) -> Option<Reading> {
    let lines: Vec<&str> = said
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let df = lines.iter().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let number = |at: usize| fields.get(at)?.parse::<u64>().ok();
        (fields.len() >= 6).then_some(())?;
        Some((number(1)?, number(2)?, number(3)?))
    })?;
    let (total_kib, used_kib, available_kib) = df;
    if total_kib == 0 {
        return None;
    }
    let ballast_bytes = lines
        .last()
        .and_then(|line| line.parse::<u64>().ok())
        .unwrap_or(0);
    Some(Reading {
        total_bytes: total_kib * 1024,
        available_bytes: available_kib * 1024,
        free_bytes: total_kib.saturating_sub(used_kib) * 1024,
        ballast_bytes,
    })
}

/// How short the disk is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Ok,
    Low,
    Critical,
    /// Less left than the ballast holds: writes are about to fail, and the ballast is given back.
    Full,
}

impl Level {
    pub fn id(self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::Low => "low",
            Level::Critical => "critical",
            Level::Full => "full",
        }
    }
}

/// The ballast for a disk of `total` bytes: [`BALLAST_PERCENT`] of it, within its bounds. Pure.
pub fn ballast_bytes(total: u64) -> u64 {
    (total / 100 * BALLAST_PERCENT).clamp(BALLAST_MIN_MIB * MIB, BALLAST_MAX_MIB * MIB)
}

/// Where each level begins, in bytes left to write. `full` is the ballast's own size, never above `critical`, so the
/// ballast is given back only when less than it is left: given back earlier it is spent before the disk is full.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lines {
    pub low: u64,
    pub critical: u64,
    pub full: u64,
    /// The keeper makes the ballast only with this much left, so that holding it back still leaves the disk `ok`.
    pub ballast_room: u64,
}

pub fn lines(total: u64) -> Lines {
    let low = total / 100 * LOW_BELOW_PERCENT;
    let critical = total / 100 * CRITICAL_BELOW_PERCENT;
    let ballast = ballast_bytes(total);
    Lines {
        low,
        critical,
        full: ballast.min(critical),
        ballast_room: low + ballast,
    }
}

pub fn level(reading: &Reading) -> Level {
    let lines = lines(reading.total_bytes);
    let left = reading.available_bytes;
    if left < lines.full {
        Level::Full
    } else if left < lines.critical {
        Level::Critical
    } else if left < lines.low {
        Level::Low
    } else {
        Level::Ok
    }
}

/// One thing relief clears. None of them is anybody's data: build cache is rebuilt by the next build that wants it, a
/// dangling image has no name left to run it by, and the ballast was held back for this moment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relief {
    Ballast,
    /// `all`: every cache record no build is using, not only the dangling ones.
    BuildCache {
        all: bool,
    },
    DanglingImages,
}

impl Relief {
    pub fn what(self) -> &'static str {
        match self {
            Relief::Ballast => "ballast",
            Relief::BuildCache { all: false } => "dangling build cache",
            Relief::BuildCache { all: true } => "build cache",
            Relief::DanglingImages => "dangling images",
        }
    }

    /// The docker command that clears it; None for the ballast, which is a file in the distro.
    pub fn docker_args(self) -> Option<&'static [&'static str]> {
        match self {
            Relief::Ballast => None,
            Relief::BuildCache { all: false } => Some(&["builder", "prune", "-f"]),
            Relief::BuildCache { all: true } => Some(&["builder", "prune", "-a", "-f"]),
            Relief::DanglingImages => Some(&["image", "prune", "-f"]),
        }
    }
}

/// What relief clears at a level, in order. At `full` the ballast goes first, so the prunes (which write as they go) and
/// every database on the disk have room at once. Pure.
pub fn relief_for(level: Level, ballast: u64) -> Vec<Relief> {
    match level {
        Level::Ok => Vec::new(),
        Level::Low => vec![Relief::BuildCache { all: false }, Relief::DanglingImages],
        Level::Critical => vec![Relief::BuildCache { all: true }, Relief::DanglingImages],
        Level::Full => {
            let mut steps = Vec::new();
            if ballast > 0 {
                steps.push(Relief::Ballast);
            }
            steps.extend([Relief::BuildCache { all: true }, Relief::DanglingImages]);
            steps
        }
    }
}

/// What a prune says it reclaimed: its last `Total` line's size (`Total:\t1.2GB` from buildx, `Total reclaimed space:
/// 1.2GB` from the engine's own). Pure.
pub fn reclaimed(said: &str) -> Option<u64> {
    said.lines()
        .filter(|line| line.contains("Total"))
        .filter_map(|line| line.split_whitespace().last())
        .filter_map(crate::uninstall::parse_docker_size)
        .last()
}

/// What one relief step did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Done {
    Cleared(Relief, u64),
    Failed(Relief, String),
}

/// What the engine's disk is, as far as this side can tell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Seen {
    Measured(Reading),
    /// This PC's sandboxes run on another engine, whose disk is not ours to watch.
    NotOurs(Kind),
    /// Ours, and its distro is not running: nothing writes to it, and reading it would start it.
    Stopped,
    Unreadable(String),
}

/// The keeper-side numbers in one document, for `--json`. Pure.
pub fn reading_json(reading: &Reading, at: u64) -> Value {
    let lines = lines(reading.total_bytes);
    json!({
        "engine": Kind::Intentic.id(),
        "state": "measured",
        "level": level(reading).id(),
        "totalBytes": reading.total_bytes,
        "availableBytes": reading.available_bytes,
        "freeBytes": reading.free_bytes,
        "ballastBytes": reading.ballast_bytes,
        "lines": {
            "low": lines.low,
            "critical": lines.critical,
            "full": lines.full,
            "ballastRoom": lines.ballast_room,
        },
        "measuredAt": at,
    })
}

/// The `--json` answer for a disk that was not measured. Pure.
pub fn unmeasured_json(seen: &Seen) -> Value {
    match seen {
        Seen::Measured(reading) => reading_json(reading, 0),
        Seen::NotOurs(kind) => json!({
            "engine": kind.id(),
            "state": "notOurs",
            "reason": format!("this PC's sandboxes run on {}, whose disk ic does not watch.", kind.name()),
        }),
        Seen::Stopped => json!({
            "engine": Kind::Intentic.id(),
            "state": "stopped",
            "reason": "the intentic engine is not running, so nothing is writing to its disk.",
        }),
        Seen::Unreadable(why) => json!({
            "engine": Kind::Intentic.id(),
            "state": "unreadable",
            "reason": why,
        }),
    }
}

/// Relief's outcome in the answer: what went, and what would not. Pure.
pub fn relief_json(done: &[Done], before: &Reading) -> Value {
    let relieved: Vec<Value> = done
        .iter()
        .filter_map(|step| match step {
            Done::Cleared(relief, bytes) => Some(json!({ "what": relief.what(), "bytes": bytes })),
            Done::Failed(..) => None,
        })
        .collect();
    let failed: Vec<Value> = done
        .iter()
        .filter_map(|step| match step {
            Done::Failed(relief, why) => Some(json!({ "what": relief.what(), "reason": why })),
            Done::Cleared(..) => None,
        })
        .collect();
    json!({
        "relieved": relieved,
        "failed": failed,
        "before": { "level": level(before).id(), "availableBytes": before.available_bytes },
    })
}

/// A count of bytes as a person reads it, in decimal units as Docker prints them: `462.0 GB`. Pure.
pub fn human(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    if value < 1000.0 {
        return format!("{bytes} B");
    }
    let mut unit = 0;
    value /= 1000.0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// The disk in one sentence: how much is left to write, of how much. Pure.
pub fn sentence(reading: &Reading) -> String {
    let percent = reading.available_bytes.saturating_mul(100) / reading.total_bytes.max(1);
    format!(
        "{} of {} left to write ({percent}%)",
        human(reading.available_bytes),
        human(reading.total_bytes)
    )
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading and relieving the real disk: Windows, where the engine is.
// ---------------------------------------------------------------------------------------------------------------------

/// The engine's disk now: one `wsl.exe --exec` into its distro, and only while that distro runs, since `wsl -d` would
/// start a stopped one.
pub fn look() -> Seen {
    let kind = super::in_use();
    if kind != Kind::Intentic {
        return Seen::NotOurs(kind);
    }
    look_into_distro()
}

#[cfg(windows)]
fn look_into_distro() -> Seen {
    let Some(record) = super::EngineRecord::load() else {
        return Seen::NotOurs(Kind::DockerDesktop);
    };
    let running = super::wsl::running_distros();
    if !running
        .iter()
        .any(|name| name.eq_ignore_ascii_case(&record.distro))
    {
        return Seen::Stopped;
    }
    let script = disk_script();
    let args = [
        "-d",
        record.distro.as_str(),
        "-u",
        "root",
        "--exec",
        "sh",
        "-c",
        script.as_str(),
    ];
    match super::wsl::run_wsl(&args, READ_LIMIT) {
        Ok((0, said, _)) => parse_reading(&said).map(Seen::Measured).unwrap_or_else(|| {
            Seen::Unreadable(format!("df in {} said: {}", record.distro, said.trim()))
        }),
        Ok((code, said, stderr)) => Seen::Unreadable(format!(
            "df in {} ended with {code}: {}",
            record.distro,
            if stderr.trim().is_empty() {
                said.trim()
            } else {
                stderr.trim()
            }
        )),
        Err(why) => Seen::Unreadable(why),
    }
}

#[cfg(not(windows))]
fn look_into_distro() -> Seen {
    Seen::NotOurs(Kind::Native)
}

/// Clear one thing. Docker's own prunes go through the engine in use; the ballast is a file in the distro.
fn apply(relief: Relief, ballast: u64) -> Done {
    let Some(args) = relief.docker_args() else {
        return match release_ballast() {
            Ok(()) => Done::Cleared(relief, ballast),
            Err(why) => Done::Failed(relief, why),
        };
    };
    match crate::docker::capture_bounded(args, PRUNE_LIMIT) {
        Ok(ran) if ran.timed_out => Done::Failed(
            relief,
            format!(
                "docker {} did not finish within {} minutes",
                args.join(" "),
                PRUNE_LIMIT.as_secs() / 60
            ),
        ),
        Ok(ran) if ran.code == Some(0) => {
            Done::Cleared(relief, reclaimed(&ran.stdout).unwrap_or(0))
        }
        Ok(ran) => Done::Failed(
            relief,
            ran.stderr
                .lines()
                .last()
                .unwrap_or("no reason given")
                .to_string(),
        ),
        Err(Fail(why)) => Done::Failed(relief, why),
    }
}

#[cfg(windows)]
fn release_ballast() -> std::result::Result<(), String> {
    let record = super::EngineRecord::load().ok_or("the engine has no record on this PC")?;
    let args = [
        "-d",
        record.distro.as_str(),
        "-u",
        "root",
        "--exec",
        "rm",
        "-f",
        BALLAST_PATH,
    ];
    match super::wsl::run_wsl(&args, READ_LIMIT)? {
        (0, _, _) => Ok(()),
        (code, _, stderr) => Err(format!("rm ended with {code}: {}", stderr.trim())),
    }
}

#[cfg(not(windows))]
fn release_ballast() -> std::result::Result<(), String> {
    Err("the ballast is on the intentic engine, which runs only on Windows".to_string())
}

/// Relieve the disk at its level, then read it again.
fn relieve(before: &Reading) -> (Vec<Done>, Reading) {
    let steps = relief_for(level(before), before.ballast_bytes);
    if steps.is_empty() {
        return (Vec::new(), *before);
    }
    let done: Vec<Done> = steps
        .into_iter()
        .map(|step| apply(step, before.ballast_bytes))
        .collect();
    let after = match look() {
        Seen::Measured(after) => after,
        _ => *before,
    };
    (done, after)
}

/// `ic engine disk` as the CLI hands it over.
pub struct DiskArgs {
    pub json: bool,
    pub consumers: bool,
    pub max_age_minutes: u64,
    /// With `consumers`: the kept measurement however old, never one made now.
    pub kept: bool,
    pub relieve: bool,
}

pub fn run(args: DiskArgs) -> Result<()> {
    let seen = look();
    let Seen::Measured(before) = seen else {
        if args.json {
            // allow(terminal-output): --json: one document on stdout for the machine agent.
            println!("{}", unmeasured_json(&seen));
            return Ok(());
        }
        return match seen {
            Seen::Unreadable(why) => Err(Fail(format!(
                "could not read the intentic engine's disk: {why}"
            ))),
            other => {
                ui::quiet(
                    unmeasured_json(&other)["reason"]
                        .as_str()
                        .unwrap_or_default(),
                );
                Ok(())
            }
        };
    };
    if args.relieve && !args.json {
        ui::act("Clearing what is nobody's data on the intentic engine's disk");
    }
    let (done, reading) = if args.relieve {
        relieve(&before)
    } else {
        (Vec::new(), before)
    };
    let breakdown = args.consumers.then(|| {
        if !args.json && !args.kept {
            ui::act(
                "Measuring what takes the space (Docker reads every volume: minutes on a big disk)",
            );
        }
        disk_consumers::current(args.max_age_minutes, args.kept)
    });
    let now = crate::sandbox::now_ms();
    if args.json {
        let mut answer = reading_json(&reading, now);
        if args.relieve {
            merge(&mut answer, relief_json(&done, &before));
        }
        if let Some(breakdown) = &breakdown {
            merge(&mut answer, disk_consumers::breakdown_json(breakdown));
        }
        // allow(terminal-output): --json: one document on stdout for the machine agent.
        println!("{answer}");
        return Ok(());
    }
    print_human(
        &reading,
        args.relieve.then_some(&done[..]),
        breakdown.as_ref(),
    );
    Ok(())
}

fn merge(into: &mut Value, from: Value) {
    if let (Some(into), Value::Object(from)) = (into.as_object_mut(), from) {
        into.extend(from);
    }
}

fn print_human(
    reading: &Reading,
    done: Option<&[Done]>,
    breakdown: Option<&std::result::Result<Breakdown, String>>,
) {
    let level = level(reading);
    let lines = lines(reading.total_bytes);
    if let Some(done) = done {
        if done.is_empty() {
            ui::done("Nothing to clear: the disk is not short.");
        } else {
            for step in done {
                match step {
                    Done::Cleared(relief, bytes) => {
                        ui::detail(&format!("{}: {} cleared", relief.what(), human(*bytes)))
                    }
                    Done::Failed(relief, why) => {
                        ui::note(&format!("{} was not cleared: {why}", relief.what()))
                    }
                }
            }
            ui::done("Cleared what is nobody's data. Volumes are never touched.");
        }
    }
    ui::report("intentic · engine disk", None);
    let ballast = if reading.ballast_bytes > 0 {
        format!(
            "{} held back, given back when less than {} is left",
            human(reading.ballast_bytes),
            human(lines.full)
        )
    } else {
        format!(
            "none held now; the keeper holds {} back once {} is left",
            human(ballast_bytes(reading.total_bytes)),
            human(lines.ballast_room)
        )
    };
    ui::fields(&[
        ("Disk".to_string(), sentence(reading)),
        (
            "Level".to_string(),
            format!(
                "{} (low under {}, critical under {})",
                level.id(),
                human(lines.low),
                human(lines.critical)
            ),
        ),
        (
            "Root's reserve".to_string(),
            human(reading.free_bytes.saturating_sub(reading.available_bytes)),
        ),
        ("Ballast".to_string(), ballast),
    ]);
    match breakdown {
        Some(Ok(breakdown)) => disk_consumers::print_human(breakdown),
        Some(Err(why)) => ui::note(&format!(
            "What takes the space could not be measured: {why}"
        )),
        None => ui::later(&[(
            "what takes the space".to_string(),
            "ic engine disk --consumers".to_string(),
        )]),
    }
    if level != Level::Ok && done.is_none() {
        ui::later(&[(
            "clear build cache and dangling images".to_string(),
            "ic engine disk --relieve".to_string(),
        )]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * MIB;
    const TB: u64 = 1_000_000_000_000;

    fn reading(total: u64, available: u64) -> Reading {
        Reading {
            total_bytes: total,
            available_bytes: available,
            free_bytes: available,
            ballast_bytes: 0,
        }
    }

    #[test]
    fn the_reading_is_df_in_kib_and_the_ballast_in_bytes() {
        // rog's engine on 2026-11-03, as the distro printed it.
        let said = "/dev/sde             1055762868 956303376  45756020  95% /\n10737418240\n";
        assert_eq!(
            parse_reading(said),
            Some(Reading {
                total_bytes: 1_055_762_868 * 1024,
                available_bytes: 45_756_020 * 1024,
                free_bytes: (1_055_762_868 - 956_303_376) * 1024,
                ballast_bytes: 10_737_418_240,
            })
        );
        // No ballast: stat failed and the script said 0.
        assert_eq!(
            parse_reading("/dev/sde 100 40 50 45% /\n0").map(|r| r.ballast_bytes),
            Some(0)
        );
        assert_eq!(
            parse_reading("df: /var/lib/docker: No such file or directory\n0"),
            None
        );
        assert_eq!(parse_reading(""), None);
    }

    #[test]
    fn the_level_is_read_off_what_a_process_that_is_not_root_may_write() {
        let total = TB;
        assert_eq!(level(&reading(total, total / 100 * 10)), Level::Ok);
        assert_eq!(level(&reading(total, total / 100 * 10 - 1)), Level::Low);
        assert_eq!(level(&reading(total, total / 100 * 5 - 1)), Level::Critical);
        // On a 1 TB disk the ballast is its 10 GiB ceiling, and full begins under it.
        assert_eq!(level(&reading(total, 10 * GIB)), Level::Critical);
        assert_eq!(level(&reading(total, 10 * GIB - 1)), Level::Full);
        // rog's after the hand clean-up: 46.8 GB left of 1.08 TB is under the critical line.
        let rog = parse_reading("/dev/sde 1055762868 956303376 45756020 95% /\n0")
            .expect("rog's line reads");
        assert_eq!(level(&rog), Level::Critical);
    }

    #[test]
    fn the_ballast_is_two_percent_within_two_and_ten_gib_and_full_never_passes_critical() {
        assert_eq!(ballast_bytes(TB), 10 * GIB);
        assert_eq!(ballast_bytes(200_000_000_000), 4_000_000_000);
        assert_eq!(ballast_bytes(50_000_000_000), 2 * GIB);
        // A 30 GB disk: its 2 GiB ballast is more than its critical 1.5 GB, so full begins at critical.
        let small = lines(30_000_000_000);
        assert_eq!(small.critical, 1_500_000_000);
        assert_eq!(small.full, 1_500_000_000);
        // The keeper makes it only where holding it back still leaves the disk ok.
        let big = lines(TB);
        assert_eq!(big.ballast_room, big.low + 10 * GIB);
        assert_eq!(level(&reading(TB, big.ballast_room - 10 * GIB)), Level::Ok);
    }

    #[test]
    fn relief_clears_more_at_each_level_and_gives_the_ballast_back_first_and_only_when_full() {
        assert_eq!(relief_for(Level::Ok, 10 * GIB), Vec::<Relief>::new());
        assert_eq!(
            relief_for(Level::Low, 10 * GIB),
            vec![Relief::BuildCache { all: false }, Relief::DanglingImages]
        );
        assert_eq!(
            relief_for(Level::Critical, 10 * GIB),
            vec![Relief::BuildCache { all: true }, Relief::DanglingImages]
        );
        assert_eq!(
            relief_for(Level::Full, 10 * GIB),
            vec![
                Relief::Ballast,
                Relief::BuildCache { all: true },
                Relief::DanglingImages
            ]
        );
        assert_eq!(
            relief_for(Level::Full, 0),
            vec![Relief::BuildCache { all: true }, Relief::DanglingImages]
        );
        // Nothing relief runs names a volume, a container or an image anybody can use.
        for relief in relief_for(Level::Full, 1) {
            let args = relief.docker_args().unwrap_or_default().join(" ");
            assert!(
                !args.contains("volume") && !args.contains("system") && !args.contains("container"),
                "{args}"
            );
            assert_ne!(args, "image prune -a -f");
        }
    }

    #[test]
    fn what_a_prune_reclaimed_is_its_total_line() {
        assert_eq!(
            reclaimed("ID\tRECLAIMABLE\tSIZE\nabc\ttrue\t1.2GB\nTotal:\t11.19GB"),
            Some(11_190_000_000)
        );
        assert_eq!(
            reclaimed("Deleted Images:\ndeleted: sha256:1\n\nTotal reclaimed space: 512.5MB"),
            Some(512_500_000)
        );
        assert_eq!(reclaimed("Total reclaimed space: 0B"), Some(0));
        assert_eq!(reclaimed(""), None);
    }

    #[test]
    fn the_json_answer_names_the_level_and_the_lines_it_was_read_against() {
        let answer = reading_json(
            &Reading {
                total_bytes: TB,
                available_bytes: 40_000_000_000,
                free_bytes: 90_000_000_000,
                ballast_bytes: 0,
            },
            7,
        );
        assert_eq!(answer["state"], "measured");
        assert_eq!(answer["level"], "critical");
        assert_eq!(answer["availableBytes"], 40_000_000_000u64);
        assert_eq!(answer["lines"]["low"], 100_000_000_000u64);
        assert_eq!(answer["lines"]["full"], 10 * GIB);
        assert_eq!(answer["measuredAt"], 7);
        assert_eq!(
            unmeasured_json(&Seen::NotOurs(Kind::DockerDesktop))["state"],
            "notOurs"
        );
        assert_eq!(unmeasured_json(&Seen::Stopped)["state"], "stopped");
        assert_eq!(
            unmeasured_json(&Seen::Unreadable("x".into()))["reason"],
            "x"
        );
        let before = reading(TB, 9 * GIB);
        let done = [
            Done::Cleared(Relief::Ballast, 10 * GIB),
            Done::Failed(Relief::DanglingImages, "busy".into()),
        ];
        assert_eq!(
            relief_json(&done, &before),
            json!({
                "relieved": [{ "what": "ballast", "bytes": 10 * GIB }],
                "failed": [{ "what": "dangling images", "reason": "busy" }],
                "before": { "level": "full", "availableBytes": 9 * GIB },
            })
        );
    }

    #[test]
    fn sizes_read_as_docker_prints_them() {
        assert_eq!(human(462_000_000_000), "462.0 GB");
        assert_eq!(human(1_081_101_000_000), "1.1 TB");
        assert_eq!(human(999), "999 B");
        assert_eq!(
            sentence(&reading(TB, 46_000_000_000)),
            "46.0 GB of 1.0 TB left to write (4%)"
        );
    }

    /// The keeper holds the ballast by the same numbers (rootfs/intentic-engine, THE DISK'S BALLAST): read off its text,
    /// so the two cannot drift apart unseen.
    #[test]
    fn the_keeper_holds_the_ballast_by_these_numbers() {
        let keeper = include_str!("../../engine/rootfs/intentic-engine");
        let value = |name: &str| -> String {
            keeper
                .lines()
                .find_map(|line| line.trim().strip_prefix(&format!("{name}=")))
                .unwrap_or_else(|| panic!("the keeper no longer sets {name}"))
                .trim_matches('"')
                .to_string()
        };
        assert_eq!(value("BALLAST"), BALLAST_PATH);
        assert_eq!(value("DATA_ROOT"), DATA_ROOT);
        assert_eq!(value("BALLAST_PERCENT"), BALLAST_PERCENT.to_string());
        assert_eq!(
            value("BALLAST_MIN_KIB"),
            (BALLAST_MIN_MIB * 1024).to_string()
        );
        assert_eq!(
            value("BALLAST_MAX_KIB"),
            (BALLAST_MAX_MIB * 1024).to_string()
        );
        assert_eq!(value("LOW_BELOW_PERCENT"), LOW_BELOW_PERCENT.to_string());
        assert_eq!(
            value("CRITICAL_BELOW_PERCENT"),
            CRITICAL_BELOW_PERCENT.to_string()
        );
        assert_eq!(
            disk_script(),
            "df -Pk /var/lib/docker | tail -n 1; stat -c %s /var/lib/intentic-engine/ballast 2>/dev/null || echo 0"
        );
    }
}
