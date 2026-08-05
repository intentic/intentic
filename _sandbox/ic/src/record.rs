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
    let Ok(content) = std::fs::read_to_string(record_path(slug)) else {
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
    let path = record_path(slug);
    let dir = path.parent().expect("record path has a parent");
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    writeln!(tmp, "channel={channel}")?;
    writeln!(tmp, "current={current}")?;
    if let Some(previous) = previous {
        writeln!(tmp, "previous={previous}")?;
    }
    tmp.persist(&path).map_err(|err| err.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_last_occurrence_wins() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::env::set_var("INTENTIC_HOME", dir.path());
        write(
            "testslug",
            "stable",
            "ghcr.io/intentic/sandbox:stable",
            Some("ghcr.io/intentic/sandbox:1.2.3"),
        )
        .expect("write");
        let record = read("testslug");
        assert_eq!(record.channel.as_deref(), Some("stable"));
        assert_eq!(
            record.previous.as_deref(),
            Some("ghcr.io/intentic/sandbox:1.2.3")
        );

        // A hand-edited record with duplicate keys reads like the shell version read it: last wins.
        std::fs::write(
            record_path("testslug"),
            "channel=stable\nchannel=beta\ncurrent=x\n",
        )
        .expect("write");
        assert_eq!(read("testslug").channel.as_deref(), Some("beta"));
        assert_eq!(read("testslug").previous, None);
        std::env::remove_var("INTENTIC_HOME");
    }
}
