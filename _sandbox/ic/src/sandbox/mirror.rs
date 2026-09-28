use crate::docker;
use crate::record::{self, ChannelRecord};

/* ONE RECORD PER SANDBOX, WHICHEVER ic READS IT.

The channel record lives in the home directory of whoever ran ic, and one Docker engine can be driven from several: on
a Windows PC with WSL the Windows side's ic and a distro's ic see the same containers from two homes, and `sudo ic`
sees root's. Each kept its own record, so a rollback target recorded from one side was invisible from the other, and
the probation watch of one side knew nothing of a swap made from the other. A copy on the sandbox's own /history
volume travels with the sandbox instead: every flow that moves the container writes it beside the home file, and reads
whichever copy is newer. */

const DIR: &str = "/history/.ic";

/// Put the home record (and the pre-swap record, when there is one) on the sandbox's volume, through whichever of its
/// containers exists: the live one, or the one a swap parked. Best-effort: the home file is still the record.
pub fn push(slug: &str) {
    let Some(container) = holder(slug) else {
        return;
    };
    let Ok(dir) = tempfile::tempdir() else { return };
    let staged = dir.path().join(".ic");
    if std::fs::create_dir_all(&staged).is_err() {
        return;
    }
    let Ok(current) = record::read(slug) else {
        return;
    };
    if std::fs::write(staged.join("channel"), record::serialize(&current)).is_err() {
        return;
    }
    match record::read_before(slug) {
        Ok(Some(before)) => {
            let _ = std::fs::write(staged.join("channel.before"), record::serialize(&before));
        }
        // No swap in flight: an older pre-swap copy on the volume must not outlive the one at home.
        _ => {
            let _ = std::fs::write(staged.join("channel.before"), "");
        }
    }
    // `docker cp <dir> <container>:/history` lands it at /history/.ic whether or not that exists yet, and works on a
    // stopped container, which is exactly the state of the one a swap has parked.
    docker::quiet(&[
        "cp",
        &staged.to_string_lossy(),
        &format!("{container}:/history"),
    ]);
}

/// The record this machine should act on: the home copy, unless the one on the sandbox's volume is newer, in which
/// case it is adopted here first (both files), so every later read in this run agrees with it.
pub fn reconcile(slug: &str) -> ChannelRecord {
    let home = record::read(slug).unwrap_or_default();
    let Some(container) = holder(slug) else {
        return home;
    };
    let Some(volume) = fetch(&container, "channel").map(|text| record::parse(&text)) else {
        return home;
    };
    if !newer(&volume, &home) {
        return home;
    }
    let _ = record::write_file(&record::record_path(slug), &volume);
    match fetch(&container, "channel.before").filter(|text| !text.trim().is_empty()) {
        Some(before) => {
            let _ = record::write_before(slug, &record::parse(&before));
        }
        None => record::remove_before(slug),
    }
    volume
}

/// Whether the volume's copy should win: it was written later, or the home has none at all. Pure.
pub fn newer(volume: &ChannelRecord, home: &ChannelRecord) -> bool {
    match (volume.written, home.written) {
        (Some(volume), Some(home)) => volume > home,
        (Some(_), None) => *home == ChannelRecord::default() || home.current.is_none(),
        _ => false,
    }
}

/// The container that holds the sandbox's volume: the live one, else the parked one.
fn holder(slug: &str) -> Option<String> {
    [
        crate::sandbox::container_of(slug),
        crate::sandbox::parked_of(slug),
    ]
    .into_iter()
    .find(|name| docker::container_exists(name))
}

fn fetch(container: &str, name: &str) -> Option<String> {
    let dir = tempfile::tempdir().ok()?;
    let dest = dir.path().join(name);
    docker::cp_out(container, &format!("{DIR}/{name}"), &dest)
        .is_none()
        .then(|| std::fs::read_to_string(&dest).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(written: Option<u64>, current: Option<&str>) -> ChannelRecord {
        ChannelRecord {
            written,
            current: current.map(str::to_string),
            ..ChannelRecord::default()
        }
    }

    #[test]
    fn the_later_copy_wins_and_a_tie_keeps_the_home_one() {
        assert!(newer(&at(Some(20), Some("a")), &at(Some(10), Some("b"))));
        assert!(!newer(&at(Some(10), Some("a")), &at(Some(20), Some("b"))));
        assert!(!newer(&at(Some(10), Some("a")), &at(Some(10), Some("b"))));
    }

    #[test]
    fn a_home_with_no_record_takes_the_volumes_and_an_unstamped_volume_copy_never_wins() {
        // The other side of a Windows/WSL machine updated this sandbox: this home has never seen it.
        assert!(newer(&at(Some(5), Some("a")), &ChannelRecord::default()));
        // A home record written by an ic from before the stamp still names what runs; it is not overwritten blind.
        assert!(!newer(&at(Some(5), Some("a")), &at(None, Some("b"))));
        assert!(!newer(&at(None, Some("a")), &at(None, None)));
    }
}
