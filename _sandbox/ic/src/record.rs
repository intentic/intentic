use std::io::Write;
use std::path::PathBuf;

use crate::logfile::intentic_home;
use crate::util::Result;

/* The channel record: which tag this sandbox follows, and what it was on before.
 *
 * Both facts live HERE, on the machine that runs the container, because both are about a swap this machine
 * performed and neither survives one otherwise: the container's env carries the image it is running, and
 * `docker rm -f` is the moment the previous one stops being knowable at all. Writing it down before that rm
 * is the whole of what makes a bad update reversible.
 *
 * Plain KEY=VALUE, same file recreate.sh wrote (~/.intentic/sandbox-<slug>.channel) — existing records keep
 * working. Last occurrence wins on read, matching the `sed | tail -n 1` that read it before. */

#[derive(Default)]
pub struct ChannelRecord {
    pub channel: Option<String>,
    pub current: Option<String>,
    pub previous: Option<String>,
}

pub fn record_path(slug: &str) -> PathBuf {
    intentic_home().join(format!("sandbox-{slug}.channel"))
}

pub fn read(slug: &str) -> ChannelRecord {
    read_file(&record_path(slug))
}

/// Parse a record file. Split from the path derivation so the format's rules — last occurrence wins, an
/// absent file reads as "nothing recorded" — are assertable without touching the process's environment.
fn read_file(path: &std::path::Path) -> ChannelRecord {
    let Ok(content) = std::fs::read_to_string(path) else {
        return ChannelRecord::default();
    };
    let mut record = ChannelRecord::default();
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("channel=") {
            record.channel = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("current=") {
            record.current = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("previous=") {
            record.previous = Some(value.to_string());
        }
    }
    record
}

/// Temp-then-rename, like every other record this repo writes: a reader landing mid-write must see the whole
/// previous file or the whole next one, never a seam. `previous` is omitted when there is nothing to roll
/// back to — absent is the honest answer, not an empty value.
pub fn write(slug: &str, channel: &str, current: &str, previous: Option<&str>) -> Result<()> {
    write_file(&record_path(slug), channel, current, previous)
}

fn write_file(
    path: &std::path::Path,
    channel: &str,
    current: &str,
    previous: Option<&str>,
) -> Result<()> {
    let dir = path.parent().expect("record path has a parent");
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    writeln!(tmp, "channel={channel}")?;
    writeln!(tmp, "current={current}")?;
    if let Some(previous) = previous {
        writeln!(tmp, "previous={previous}")?;
    }
    tmp.persist(path).map_err(|err| err.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* No env mutation here on purpose: `set_var` is process-global and Rust runs tests in parallel threads,
     * so a test that repoints INTENTIC_HOME races every other test that reads a path. These drive the file
     * helpers directly against a tempdir instead. */

    #[test]
    fn a_record_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        write_file(
            &path,
            "stable",
            "ghcr.io/intentic/sandbox:stable",
            Some("ghcr.io/intentic/sandbox:1.2.3"),
        )
        .expect("write");
        let record = read_file(&path);
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
    fn nothing_to_roll_back_to_is_an_absent_key_not_an_empty_one() {
        // A first-ever swap records no rollback target; the daemon then offers no rollback, honestly. An
        // empty `previous=` would instead read back as a rollback target named "".
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        write_file(&path, "stable", "img:1", None).expect("write");
        assert!(!std::fs::read_to_string(&path)
            .expect("read")
            .contains("previous="));
        assert_eq!(read_file(&path).previous, None);
    }

    #[test]
    fn a_missing_record_reads_as_nothing_recorded() {
        // Every sandbox created before this file existed is in exactly this state — it must not error.
        let dir = tempfile::tempdir().expect("tempdir");
        let record = read_file(&dir.path().join("absent.channel"));
        assert!(record.channel.is_none() && record.current.is_none() && record.previous.is_none());
    }

    #[test]
    fn a_hand_edited_duplicate_key_takes_the_last_occurrence() {
        // Matching how the shell version read it (`sed -n 's/^k=//p' | tail -n 1`), so a record a user
        // appended to by hand behaves the same way it always did.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.channel");
        std::fs::write(&path, "channel=stable\nchannel=beta\ncurrent=x\n").expect("write");
        assert_eq!(read_file(&path).channel.as_deref(), Some("beta"));
        assert_eq!(read_file(&path).previous, None);
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
