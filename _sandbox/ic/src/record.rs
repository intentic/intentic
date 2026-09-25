use std::io::Write;
use std::path::PathBuf;

use crate::logfile::intentic_home;
use crate::shape::Shape;
use crate::util::{Fail, Result};

/* The channel record: which tag this sandbox follows, what it was on before, and what is WAITING for it — an image built for it, a shape saved for it. */

#[derive(Clone, Default)]
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
}

impl ChannelRecord {
    /// The same record with nothing staged. What every flow that moves the container writes: it is taking an
    /// image now, so nothing is waiting for it any more.
    ///
    /// The shape saved for the next restart stays: a prepare that is dropped has not restarted anything.
    pub fn without_staged(&self) -> ChannelRecord {
        ChannelRecord {
            channel: self.channel.clone(),
            current: self.current.clone(),
            previous: self.previous.clone(),
            desired: self.desired.clone(),
            ..ChannelRecord::default()
        }
    }
}

pub fn record_path(slug: &str) -> PathBuf {
    intentic_home().join(format!("sandbox-{slug}.channel"))
}

pub fn read(slug: &str) -> Result<ChannelRecord> {
    read_file(&record_path(slug))
}

/// Parse a record file. Split from the path derivation so the format's rules — last occurrence wins, an
/// absent file reads as "nothing recorded", an unknown key is ignored — are assertable without touching the
/// process's environment. A file that is there but unreadable is an error: every flow writes the record back.
fn read_file(path: &std::path::Path) -> Result<ChannelRecord> {
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
    let mut record = ChannelRecord::default();
    // The shape's four keys are read together at the end: all four, or no shape.
    let mut desired: [Option<String>; 4] = Default::default();
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
    Ok(record)
}

/// Temp-then-rename, like every other record this repo writes: a reader landing mid-write must see the whole
/// previous file or the whole next one, never a seam. An absent value is an OMITTED key, never an empty one —
/// `previous=` would read back as a rollback target named "".
pub fn write(slug: &str, record: &ChannelRecord) -> Result<()> {
    write_file(&record_path(slug), record)
}

fn write_file(path: &std::path::Path, record: &ChannelRecord) -> Result<()> {
    let dir = path.parent().expect("record path has a parent");
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    for (key, value) in [
        ("channel", &record.channel),
        ("current", &record.current),
        ("previous", &record.previous),
        ("staged", &record.staged),
        ("staged_base", &record.staged_base),
        ("staged_env", &record.staged_env),
        ("staged_channel", &record.staged_channel),
        ("staged_version", &record.staged_version),
    ] {
        if let Some(value) = value {
            writeln!(tmp, "{key}={value}")?;
        }
    }
    if let Some(desired) = &record.desired {
        let keys = [
            "desired_memory",
            "desired_cpus",
            "desired_privileged",
            "desired_gpus",
        ];
        for (key, value) in keys.iter().zip(desired.to_record()) {
            writeln!(tmp, "{key}={value}")?;
        }
    }
    tmp.persist(path).map_err(|err| err.error)?;
    Ok(())
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
