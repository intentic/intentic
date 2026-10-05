use std::io::Write;
use std::path::{Path, PathBuf};

use crate::logfile::intentic_home;
use crate::shape::Shape;
use crate::util::{Fail, Result};

/* The channel record: which tag this sandbox follows, what it was on before, and what is WAITING for it — an image built for it, a shape saved for it. */

/// How many rollback targets a sandbox keeps BEYOND `previous`: older builds `ic sandbox rollback --to` can reach
/// without a download. Each is a whole image, so the swap drops them when the disk runs short (see recreate.rs).
pub const MAX_KEPT: usize = 2;

/// One image a rollback can return to: a pinned local tag and what the image said it was when it was pinned.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pin {
    pub image: String,
    pub version: Option<String>,
}

/// Where a swap is. `Cutover` from the moment the old container is about to stop until the new one has passed its
/// first health check; `Probation` after that, while the old container stays parked and ready and the probation
/// watch (probation.rs) judges the new one. A record that names neither has no swap in flight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Cutover,
    Probation,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Cutover => "cutover",
            Phase::Probation => "probation",
        }
    }

    fn parse(value: &str) -> Option<Phase> {
        match value {
            "cutover" => Some(Phase::Cutover),
            "probation" => Some(Phase::Probation),
            _ => None,
        }
    }
}

/// A swap in flight or on probation. Written before the old container stops, so a swap that dies halfway leaves the
/// facts the next `ic` run (or the machine agent's watch tick) needs to finish it or undo it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Swap {
    pub phase: Phase,
    /// When the cutover began, in epoch milliseconds.
    pub at: u64,
    /// What was asked for: update, rollback, rebuild, dev, reshape.
    pub verb: String,
    /// The version (or image) being left, and the one being moved onto: what the owner is told.
    pub from: Option<String>,
    pub to: Option<String>,
    /// When the probation ends and the parked container is let go, in epoch milliseconds.
    pub until: Option<u64>,
    /// How the left container's own reach probe read before the swap (`reachable`, `unreachable`…): a new version
    /// is only held to a tunnel the old one had.
    pub reach: Option<String>,
    /// Consecutive probation checks the new version failed; three in a row is a rollback.
    pub strikes: u32,
    /// When the new version's daemon last started (its boot marker's `startedAt`), and how many times the probation
    /// watch has seen it start again since: a daemon that keeps restarting inside a running container is a crash
    /// loop the container's own restart count never shows.
    pub daemon_start: Option<u64>,
    pub daemon_restarts: u32,
    /// The last heartbeat of the ic run doing the cutover, in epoch milliseconds: a cutover whose heartbeat is fresh is
    /// in progress somewhere (another terminal, the other side of a Windows/WSL machine) and is left alone.
    pub alive: Option<u64>,
}

#[derive(Clone, Default, Debug, PartialEq)]
pub struct ChannelRecord {
    pub channel: Option<String>,
    pub current: Option<String>,
    pub previous: Option<String>,
    /// The image `ic sandbox prepare` built and left ready to swap onto. Present only between a prepare and
    /// the swap that consumes it — every flow that MOVES the container clears all five keys, because an image
    /// the sandbox has just taken is not one still waiting for it.
    pub staged: Option<String>,
    /// The id the staged image's base resolved to when it was built. Identity, not a name: `:stable` is a tag
    /// the registry moves, so the only way to ask "has this sandbox already taken what is staged?" is to
    /// compare what the container actually runs against what the build actually used.
    pub staged_base: Option<String>,
    /// sha256 of the approved overlay the staged image was built with, absent for a stock sandbox. An owner
    /// who re-approves a different recipe invalidates the staged build, and this is what notices.
    pub staged_env: Option<String>,
    /// The release channel it was staged FROM. Held separately from `channel` on purpose: preparing a beta
    /// build is not moving onto beta, and a prepare that is never applied must leave `ic sandbox update`
    /// following exactly what it followed before.
    pub staged_channel: Option<String>,
    /// The readable version the staged image reports (`intentic --version` inside it). Absent when the image
    /// would not say — an older build, a probe that failed — and every reader treats that as "ready, version
    /// unknown" rather than as nothing being ready.
    pub staged_version: Option<String>,
    /// The shape saved for the sandbox's next restart (`ic sandbox shape … --when next-restart`), whole: what it
    /// runs with once any flow recreates it, whatever it ran with before. Present only between the save and the
    /// recreate that applies it — that recreate writes the record without it, in the same write that names its new
    /// image, so a swap that fails and is rewound gets it back with the rest of the record.
    pub desired: Option<Shape>,
    /// What the image `current` names said it was when the swap that recorded it asked.
    pub current_version: Option<String>,
    /// What `previous` said it was when it was pinned.
    pub previous_version: Option<String>,
    /// Older rollback targets kept beyond `previous`, newest first, at most MAX_KEPT.
    pub kept: Vec<Pin>,
    /// A swap in flight or on probation.
    pub swap: Option<Swap>,
    /// The version the probation watch last went back FROM. The background download never stages it again; a
    /// person's own update still takes it.
    pub rolled_back_from: Option<String>,
    /// When this record was written, in epoch milliseconds: which of two copies (this machine's home and the one
    /// on the sandbox's own /history, see mirror.rs) is newer.
    pub written: Option<u64>,
    /// The owner stopped this sandbox on purpose (`ic sandbox stop`). Set by stop, cleared by start, restart and
    /// every flow that moves the container; `ic sandbox fix` only starts a held sandbox when someone says yes.
    pub held: bool,
    /// The sandbox's host-report key (sandbox/fix/report.rs): derived wherever ic reads the container's env, and
    /// kept here so a later run can still report while Docker is down and the env cannot be read.
    pub report_key: Option<String>,
    /// The platform origin that key reports to, as this machine spells it.
    pub report_platform: Option<String>,
    /// The side of this computer that keeps the sandbox the record describes (side.rs's wire form, `windows`,
    /// `linux/archlinux`): named by the first write, from the container's own stamp (else the side writing), and kept by
    /// every write after, whichever side makes it and whichever home it is copied into (mirror.rs). What tells a record
    /// of this side's own sandbox from a copy of another side's. Absent from a record an ic before it wrote.
    /// (2026-10-05)
    pub side: Option<String>,
}

impl ChannelRecord {
    /// The same record with nothing staged. What every flow that moves the container writes: it is taking an
    /// image now, so nothing is waiting for it any more.
    ///
    /// Everything else stays: the shape saved for the next restart (a prepare that is dropped has not restarted
    /// anything), the rollback targets, and a swap on probation.
    pub fn without_staged(&self) -> ChannelRecord {
        ChannelRecord {
            staged: None,
            staged_base: None,
            staged_env: None,
            staged_channel: None,
            staged_version: None,
            ..self.clone()
        }
    }

    /// Every rollback target, newest first: `previous`, then the older ones kept.
    pub fn targets(&self) -> Vec<Pin> {
        let mut targets: Vec<Pin> = Vec::new();
        if let Some(image) = &self.previous {
            targets.push(Pin {
                image: image.clone(),
                version: self.previous_version.clone(),
            });
        }
        targets.extend(self.kept.iter().cloned());
        targets
    }
}

pub fn record_path(slug: &str) -> PathBuf {
    intentic_home().join(format!("sandbox-{slug}.channel"))
}

/// The record as it stood before the swap in flight: what the probation watch puts back when it undoes the swap.
pub fn before_path(slug: &str) -> PathBuf {
    intentic_home().join(format!("sandbox-{slug}.channel.before"))
}

pub fn read(slug: &str) -> Result<ChannelRecord> {
    read_file(&record_path(slug))
}

/// The pre-swap record, None when no swap left one.
pub fn read_before(slug: &str) -> Result<Option<ChannelRecord>> {
    let path = before_path(slug);
    if !path.exists() {
        return Ok(None);
    }
    read_file(&path).map(Some)
}

pub fn write_before(slug: &str, record: &ChannelRecord) -> Result<()> {
    write_file(&before_path(slug), record)
}

pub fn remove_before(slug: &str) {
    let _ = std::fs::remove_file(before_path(slug));
}

/// Parse a record file. Split from the path derivation so the format's rules — last occurrence wins, an
/// absent file reads as "nothing recorded", an unknown key is ignored — are assertable without touching the
/// process's environment. A file that is there but unreadable is an error: every flow writes the record back.
fn read_file(path: &Path) -> Result<ChannelRecord> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(ChannelRecord::default()),
        Err(err) => {
            return Err(Fail(format!(
                "could not read {}: {err}\n       It names this sandbox's rollback target, and writing over it would lose that, so nothing was changed.",
                path.display()
            )))
        }
    };
    Ok(parse(&content))
}

/// The record's text, read. Pure: the home file and the copy on the sandbox's volume are read the same way.
pub fn parse(content: &str) -> ChannelRecord {
    let mut record = ChannelRecord::default();
    // The shape's four keys are read together at the end: all four, or no shape.
    let mut desired: [Option<String>; 4] = Default::default();
    // So are a kept target's image and version, and a swap's keys: a half-written group is no group.
    let mut kept: [(Option<String>, Option<String>); MAX_KEPT] = Default::default();
    let mut swap: [Option<String>; 11] = Default::default();
    let mut rest: [Option<String>; 8] = Default::default();
    for line in content.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let field = match key {
            "desired_memory" => &mut desired[0],
            "desired_cpus" => &mut desired[1],
            "desired_privileged" => &mut desired[2],
            "desired_gpus" => &mut desired[3],
            "channel" => &mut record.channel,
            "current" => &mut record.current,
            "previous" => &mut record.previous,
            "staged" => &mut record.staged,
            "staged_base" => &mut record.staged_base,
            "staged_env" => &mut record.staged_env,
            "staged_channel" => &mut record.staged_channel,
            "staged_version" => &mut record.staged_version,
            "current_version" => &mut rest[0],
            "previous_version" => &mut rest[1],
            "rolled_back_from" => &mut rest[2],
            "written" => &mut rest[3],
            "held" => &mut rest[4],
            "report_key" => &mut rest[5],
            "report_platform" => &mut rest[6],
            "side" => &mut rest[7],
            "kept_1" => &mut kept[0].0,
            "kept_1_version" => &mut kept[0].1,
            "kept_2" => &mut kept[1].0,
            "kept_2_version" => &mut kept[1].1,
            "swap_phase" => &mut swap[0],
            "swap_at" => &mut swap[1],
            "swap_verb" => &mut swap[2],
            "swap_from" => &mut swap[3],
            "swap_to" => &mut swap[4],
            "probation_until" => &mut swap[5],
            "swap_reach" => &mut swap[6],
            "probation_strikes" => &mut swap[7],
            "probation_daemon_start" => &mut swap[8],
            "probation_daemon_restarts" => &mut swap[9],
            "swap_alive" => &mut swap[10],
            // A key written by a NEWER ic than this one. Ignored rather than refused: a user who downgrades
            // their host binary must still be able to update and roll back.
            _ => continue,
        };
        *field = Some(value.to_string());
    }
    let [memory, cpus, privileged, gpus] = &desired;
    record.desired = Shape::from_record(
        memory.as_deref(),
        cpus.as_deref(),
        privileged.as_deref(),
        gpus.as_deref(),
    );
    let [current_version, previous_version, rolled_back_from, written, held, report_key, report_platform, side] =
        rest;
    record.current_version = current_version;
    record.previous_version = previous_version;
    record.rolled_back_from = rolled_back_from;
    record.written = written.and_then(|value| value.parse().ok());
    record.held = held.as_deref() == Some("1");
    record.report_key = report_key.filter(|key| !key.is_empty());
    record.report_platform = report_platform.filter(|url| !url.is_empty());
    record.side = side.filter(|side| !side.is_empty());
    record.kept = kept
        .into_iter()
        .filter_map(|(image, version)| {
            image
                .filter(|image| !image.is_empty())
                .map(|image| Pin { image, version })
        })
        .collect();
    record.swap = swap_of(swap);
    record
}

/// A swap's keys as one value: a phase this build knows and a start time, or no swap at all.
fn swap_of(keys: [Option<String>; 11]) -> Option<Swap> {
    let [phase, at, verb, from, to, until, reach, strikes, daemon_start, daemon_restarts, alive] =
        keys;
    Some(Swap {
        phase: Phase::parse(phase.as_deref()?)?,
        at: at?.parse().ok()?,
        verb: verb.unwrap_or_default(),
        from,
        to,
        until: until.and_then(|value| value.parse().ok()),
        reach,
        strikes: strikes.and_then(|value| value.parse().ok()).unwrap_or(0),
        daemon_start: daemon_start.and_then(|value| value.parse().ok()),
        daemon_restarts: daemon_restarts
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        alive: alive.and_then(|value| value.parse().ok()),
    })
}

/// The record's text. An absent value is an OMITTED key, never an empty one — `previous=` would read back as a
/// rollback target named "".
pub fn serialize(record: &ChannelRecord) -> String {
    let mut text = String::new();
    let mut put = |key: &str, value: Option<&str>| {
        if let Some(value) = value {
            text.push_str(key);
            text.push('=');
            text.push_str(value);
            text.push('\n');
        }
    };
    put("channel", record.channel.as_deref());
    put("current", record.current.as_deref());
    put("previous", record.previous.as_deref());
    put("staged", record.staged.as_deref());
    put("staged_base", record.staged_base.as_deref());
    put("staged_env", record.staged_env.as_deref());
    put("staged_channel", record.staged_channel.as_deref());
    put("staged_version", record.staged_version.as_deref());
    put("current_version", record.current_version.as_deref());
    put("previous_version", record.previous_version.as_deref());
    for (slot, pin) in record.kept.iter().take(MAX_KEPT).enumerate() {
        put(&format!("kept_{}", slot + 1), Some(&pin.image));
        put(
            &format!("kept_{}_version", slot + 1),
            pin.version.as_deref(),
        );
    }
    if let Some(swap) = &record.swap {
        put("swap_phase", Some(swap.phase.as_str()));
        put("swap_at", Some(&swap.at.to_string()));
        put(
            "swap_verb",
            (!swap.verb.is_empty()).then_some(swap.verb.as_str()),
        );
        put("swap_from", swap.from.as_deref());
        put("swap_to", swap.to.as_deref());
        put(
            "probation_until",
            swap.until.map(|until| until.to_string()).as_deref(),
        );
        put("swap_reach", swap.reach.as_deref());
        put(
            "probation_strikes",
            (swap.strikes > 0)
                .then(|| swap.strikes.to_string())
                .as_deref(),
        );
        put(
            "probation_daemon_start",
            swap.daemon_start.map(|start| start.to_string()).as_deref(),
        );
        put(
            "probation_daemon_restarts",
            (swap.daemon_restarts > 0)
                .then(|| swap.daemon_restarts.to_string())
                .as_deref(),
        );
        put(
            "swap_alive",
            swap.alive.map(|alive| alive.to_string()).as_deref(),
        );
    }
    put("rolled_back_from", record.rolled_back_from.as_deref());
    put(
        "written",
        record.written.map(|written| written.to_string()).as_deref(),
    );
    put("held", record.held.then_some("1"));
    put("report_key", record.report_key.as_deref());
    put("report_platform", record.report_platform.as_deref());
    put("side", record.side.as_deref());
    if let Some(desired) = &record.desired {
        let keys = [
            "desired_memory",
            "desired_cpus",
            "desired_privileged",
            "desired_gpus",
        ];
        for (key, value) in keys.iter().zip(desired.to_record()) {
            put(key, Some(&value));
        }
    }
    text
}

/// Temp-then-rename, like every other record this repo writes: a reader landing mid-write must see the whole
/// previous file or the whole next one, never a seam. Stamped with the time it is written, which is how the copy on
/// the sandbox's volume and this one are told apart (mirror.rs).
pub fn write(slug: &str, record: &ChannelRecord) -> Result<()> {
    let mut next = stamped(record);
    if next.side.is_none() {
        next.side = Some(owner(slug));
    }
    write_file(&record_path(slug), &next)
}

/// The side a new record names: the one the sandbox's container is stamped with, else this one.
fn owner(slug: &str) -> String {
    owner_of(
        crate::sandbox::side::created_on(slug),
        crate::sandbox::side::here(),
    )
}

/// The same, pure over what was read. Pure.
fn owner_of(
    created: Option<crate::sandbox::side::Side>,
    here: crate::sandbox::side::Side,
) -> String {
    created.unwrap_or(here).wire()
}

/* A DERIVED FACT, KEPT WITHOUT A STAMP. The report key is the same for as long as the container's token is, so
caching it changes nothing about the record's history: `write` would stamp it as the newest copy and a stale home record
could then win over a newer one on the sandbox's volume (mirror.rs). Written only when it changed. */
pub fn remember_report(slug: &str, key: &str, platform: Option<&str>) {
    let Ok(record) = read(slug) else { return };
    let platform = platform
        .map(str::to_string)
        .or(record.report_platform.clone());
    if record.report_key.as_deref() == Some(key) && record.report_platform == platform {
        return;
    }
    // A record this call creates names the side that keeps its sandbox (`side`); one that exists keeps what it says.
    let side = if record_path(slug).exists() {
        record.side.clone()
    } else {
        Some(owner(slug))
    };
    let _ = write_file(
        &record_path(slug),
        &ChannelRecord {
            report_key: Some(key.to_string()),
            report_platform: platform,
            side,
            ..record
        },
    );
}

/// The record with `written` set to now.
pub fn stamped(record: &ChannelRecord) -> ChannelRecord {
    ChannelRecord {
        written: Some(crate::sandbox::now_ms()),
        ..record.clone()
    }
}

/// Written through to the disk before the rename that publishes it, and the rename itself flushed with its
/// directory: this file names the only way back to the version before an update, and a machine that loses power
/// right after a swap (a laptop lid, a WSL shutdown) must not wake to an empty record that reads as "nothing to roll
/// back to".
pub fn write_file(path: &Path, record: &ChannelRecord) -> Result<()> {
    let dir = path.parent().expect("record path has a parent");
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(serialize(record).as_bytes())?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|err| err.error)?;
    sync_dir(dir);
    Ok(())
}

/// Flush a directory's entries (the rename above). Only POSIX has, or needs, a directory to open for this.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;

    /* No env mutation here on purpose: `set_var` is process-global and Rust runs tests in parallel threads. */

    fn swap(current: &str, previous: Option<&str>) -> ChannelRecord {
        ChannelRecord {
            channel: Some("stable".to_string()),
            current: Some(current.to_string()),
            previous: previous.map(str::to_string),
            ..ChannelRecord::default()
        }
    }

    #[test]
    fn a_record_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        write_file(
            &path,
            &swap(
                "ghcr.io/intentic/sandbox:stable",
                Some("ghcr.io/intentic/sandbox:1.2.3"),
            ),
        )
        .expect("write");
        let record = read_file(&path).expect("read");
        assert_eq!(record.channel.as_deref(), Some("stable"));
        assert_eq!(
            record.current.as_deref(),
            Some("ghcr.io/intentic/sandbox:stable")
        );
        assert_eq!(
            record.previous.as_deref(),
            Some("ghcr.io/intentic/sandbox:1.2.3")
        );
    }

    #[test]
    fn what_prepare_staged_round_trips_beside_what_the_sandbox_runs() {
        // The five staged keys are the fast update path's whole input: the image to swap onto, the base
        // identity that says whether it has already been taken, the recipe it was built with, the channel it
        // came from, and the version to tell the owner about.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        let staged = ChannelRecord {
            staged: Some("intentic-sandbox-env-abc:0123456789ab".to_string()),
            staged_base: Some("sha256:feed".to_string()),
            staged_env: Some("deadbeef".to_string()),
            staged_channel: Some("beta".to_string()),
            staged_version: Some("1.4.2".to_string()),
            ..swap("ghcr.io/intentic/sandbox:stable", None)
        };
        write_file(&path, &staged).expect("write");
        let read = read_file(&path).expect("read");
        assert_eq!(
            read.staged.as_deref(),
            Some("intentic-sandbox-env-abc:0123456789ab")
        );
        assert_eq!(read.staged_base.as_deref(), Some("sha256:feed"));
        assert_eq!(read.staged_env.as_deref(), Some("deadbeef"));
        assert_eq!(read.staged_version.as_deref(), Some("1.4.2"));
        // The channel the sandbox FOLLOWS is untouched by staging one from somewhere else — a prepared beta
        // build that is never applied must not move a stable sandbox onto beta.
        assert_eq!(read.staged_channel.as_deref(), Some("beta"));
        assert_eq!(read.channel.as_deref(), Some("stable"));
    }

    #[test]
    fn a_swap_clears_every_staged_key() {
        // The image is being TAKEN, so nothing is waiting for it any more. Left behind, the sandbox would
        // keep being told an update is ready that it is already running.
        let staged = ChannelRecord {
            staged: Some("img:next".to_string()),
            staged_base: Some("sha256:feed".to_string()),
            staged_env: Some("deadbeef".to_string()),
            staged_channel: Some("stable".to_string()),
            staged_version: Some("1.4.2".to_string()),
            ..swap("img:now", Some("img:before"))
        };
        let after = staged.without_staged();
        assert_eq!(after.current.as_deref(), Some("img:now"));
        assert_eq!(after.previous.as_deref(), Some("img:before"));
        assert!(
            after.staged.is_none()
                && after.staged_base.is_none()
                && after.staged_env.is_none()
                && after.staged_channel.is_none()
                && after.staged_version.is_none()
        );
    }

    #[test]
    fn the_shape_saved_for_the_next_restart_round_trips_and_survives_a_dropped_prepare() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        let desired = Shape {
            memory: Some("20g".to_string()),
            cpus: None,
            privileged: false,
            gpus: true,
        };
        let waiting = ChannelRecord {
            staged: Some("img:next".to_string()),
            desired: Some(desired.clone()),
            ..swap("img:now", None)
        };
        write_file(&path, &waiting).expect("write");
        let written = std::fs::read_to_string(&path).expect("read");
        assert!(written.contains(
            "desired_memory=20g\ndesired_cpus=default\ndesired_privileged=off\ndesired_gpus=on\n"
        ));
        assert_eq!(
            read_file(&path).expect("read").desired,
            Some(desired.clone())
        );
        // A prepare that no longer fits is dropped; nothing restarted, so the shape is still waiting.
        assert_eq!(waiting.without_staged().desired, Some(desired));
        // Half a shape (a hand edit, a crash mid-write of some other tool) is no shape rather than a guess.
        std::fs::write(
            &path,
            "channel=stable\ndesired_memory=20g\ndesired_gpus=on\n",
        )
        .expect("write");
        assert_eq!(read_file(&path).expect("read").desired, None);
    }

    #[test]
    fn nothing_to_roll_back_to_is_an_absent_key_not_an_empty_one() {
        // A first-ever swap records no rollback target; the daemon then offers no rollback, honestly. An
        // empty `previous=` would instead read back as a rollback target named "".
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        write_file(&path, &swap("img:1", None)).expect("write");
        let written = std::fs::read_to_string(&path).expect("read");
        assert!(!written.contains("previous="));
        assert!(!written.contains("staged"));
        assert!(!written.contains("desired"));
        assert_eq!(read_file(&path).expect("read").previous, None);
    }

    #[test]
    fn a_missing_record_reads_as_nothing_recorded() {
        // Every sandbox created before this file existed is in exactly this state — it must not error.
        let dir = tempfile::tempdir().expect("tempdir");
        let record = read_file(&dir.path().join("absent.channel")).expect("read");
        assert!(record.channel.is_none() && record.current.is_none() && record.previous.is_none());
        assert!(record.staged.is_none());
    }

    #[test]
    fn a_record_that_is_there_but_unreadable_is_an_error_not_nothing_recorded() {
        // Read as "nothing recorded", the next swap would write a record without the rollback target this one names.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        std::fs::write(&path, [b'p', b'r', b'e', b'v', 0xff, 0xfe]).expect("write");
        assert!(read_file(&path).is_err());
    }

    #[test]
    fn a_hand_edited_duplicate_key_takes_the_last_occurrence() {
        // Matching how the shell version read it (`sed -n 's/^k=//p' | tail -n 1`), so a record a user
        // appended to by hand behaves the same way it always did.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        std::fs::write(&path, "channel=stable\nchannel=core-stable\ncurrent=x\n").expect("write");
        assert_eq!(
            read_file(&path).expect("read").channel.as_deref(),
            Some("core-stable")
        );
        assert_eq!(read_file(&path).expect("read").previous, None);
    }

    #[test]
    fn a_key_this_build_does_not_know_is_ignored_rather_than_fatal() {
        // A user who downgrades their host binary after a newer one wrote the record must still be able to
        // update and roll back — the keys this build knows are read, the rest are skipped.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        std::fs::write(&path, "channel=stable\nsomething_new=1\ncurrent=x\n").expect("write");
        let record = read_file(&path).expect("read");
        assert_eq!(record.channel.as_deref(), Some("stable"));
        assert_eq!(record.current.as_deref(), Some("x"));
    }

    #[test]
    fn the_ways_back_and_a_swap_in_flight_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        let record = ChannelRecord {
            current_version: Some("1.316.0".to_string()),
            previous_version: Some("1.315.0".to_string()),
            kept: vec![
                Pin {
                    image: "intentic-sandbox-rollback-abc:111111111111".to_string(),
                    version: Some("1.314.0".to_string()),
                },
                Pin {
                    image: "intentic-sandbox-rollback-abc:222222222222".to_string(),
                    version: None,
                },
            ],
            swap: Some(Swap {
                phase: Phase::Probation,
                at: 1_000,
                verb: "update".to_string(),
                from: Some("1.315.0".to_string()),
                to: Some("1.316.0".to_string()),
                until: Some(2_000),
                reach: Some("reachable".to_string()),
                strikes: 2,
                daemon_start: Some(1_500),
                daemon_restarts: 1,
                alive: Some(1_200),
            }),
            rolled_back_from: Some("1.313.0".to_string()),
            written: Some(42),
            ..swap(
                "ghcr.io/intentic/sandbox:stable",
                Some("intentic-sandbox-rollback-abc:000000000000"),
            )
        };
        write_file(&path, &record).expect("write");
        assert_eq!(read_file(&path).expect("read"), record);
        // The targets, newest first, are what `ic sandbox rollback` and `--to` choose from.
        let targets: Vec<String> = record.targets().into_iter().map(|pin| pin.image).collect();
        assert_eq!(
            targets,
            vec![
                "intentic-sandbox-rollback-abc:000000000000".to_string(),
                "intentic-sandbox-rollback-abc:111111111111".to_string(),
                "intentic-sandbox-rollback-abc:222222222222".to_string(),
            ]
        );
    }

    #[test]
    fn a_half_written_swap_is_no_swap_and_a_settled_one_leaves_no_key_behind() {
        // A phase with no start time (a hand edit, another tool) must not read as a swap to finish or undo.
        assert_eq!(parse("current=x\nswap_phase=cutover\n").swap, None);
        assert_eq!(
            parse("current=x\nswap_phase=elsewhere\nswap_at=1\n").swap,
            None
        );
        let settled = serialize(&ChannelRecord {
            swap: None,
            ..swap("x", None)
        });
        assert!(
            !settled.contains("swap_") && !settled.contains("probation_"),
            "{settled}"
        );
    }

    /* THE FIX ENGINE'S TWO KEYS, and the older ic that must not choke on them. */
    #[test]
    fn a_hold_and_a_cached_report_key_round_trip_and_an_absent_one_leaves_no_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        let held = ChannelRecord {
            held: true,
            report_key: Some("ab".repeat(32)),
            report_platform: Some("https://api.intentic.dev".to_string()),
            ..swap("ghcr.io/intentic/sandbox:stable", None)
        };
        write_file(&path, &held).expect("write");
        let read = read_file(&path).expect("read");
        assert!(read.held);
        assert_eq!(read.report_key.as_deref(), Some("ab".repeat(32).as_str()));
        assert_eq!(
            read.report_platform.as_deref(),
            Some("https://api.intentic.dev")
        );
        let text = serialize(&ChannelRecord::default());
        assert!(!text.contains("held"), "{text}");
        assert!(!text.contains("report_"), "{text}");
        assert!(!parse("held=0\n").held, "only 1 holds");
        assert_eq!(parse("report_key=\n").report_key, None);
    }

    #[test]
    fn a_write_stamps_the_time_it_was_written() {
        let record = stamped(&swap("x", None));
        assert!(record
            .written
            .is_some_and(|written| written > 1_700_000_000_000));
        assert_eq!(
            record.side, None,
            "the side is the write's to name, from the sandbox"
        );
        let kept = stamped(&ChannelRecord {
            side: Some("linux/archlinux".to_string()),
            ..swap("x", None)
        });
        assert_eq!(
            kept.side.as_deref(),
            Some("linux/archlinux"),
            "and once named, kept"
        );
    }

    #[test]
    fn a_new_record_names_the_side_its_sandbox_is_stamped_with() {
        use crate::sandbox::side::Side;
        let here = Side::new("windows", Some("windows"));
        assert_eq!(
            owner_of(Some(Side::new("linux", Some("archlinux"))), here.clone()),
            "linux/archlinux"
        );
        assert_eq!(owner_of(None, here), "windows");
    }

    #[test]
    fn the_side_that_wrote_a_record_round_trips_and_an_older_record_names_none() {
        let written = ChannelRecord {
            side: Some("linux/archlinux".to_string()),
            ..swap("x", None)
        };
        assert_eq!(
            parse(&serialize(&written)).side.as_deref(),
            Some("linux/archlinux")
        );
        assert_eq!(parse("current=x\nside=\n").side, None);
        assert_eq!(parse("current=x\n").side, None);
    }

    #[test]
    fn the_record_lives_beside_the_logs_under_the_state_home() {
        // The path shape existing sandboxes' records already use — renaming it would strand every rollback
        // target on the machine.
        assert!(record_path("abc123").ends_with("sandbox-abc123.channel"));
        assert_eq!(
            record_path("abc123").parent(),
            Some(intentic_home()).as_deref()
        );
    }
}
