use std::time::{SystemTime, UNIX_EPOCH};

use crate::docker;
use crate::sandbox::{CONTAINER_PREFIX, DIND_PREFIX, TUNNEL_PREFIX};

/* A removed sandbox's whole Docker footprint, held under a parallel set of names until its grace period runs out. */

/* These mirror the live prefixes one for one, so a trashed sandbox is invisible to every listing keyed on those. */
pub const TRASH_PREFIX: &str = "intentic-trash-";
pub const TRASH_TUNNEL_PREFIX: &str = "intentic-trash-tunnel-";
pub const TRASH_DIND_PREFIX: &str = "intentic-trash-dind-";

/// The marker volume, `intentic-trashed-<unix seconds>-<slug>`. The moment lives in the NAME because `ic` links no
/// date library, so a volume's own CreatedAt would be unreadable here.
const MARKER_PREFIX: &str = "intentic-trashed-";

const DAY_SECS: u64 = 24 * 60 * 60;

/// Whole days a removed sandbox stays recoverable, compiled in from the platform's own declaration.
pub const GRACE_DAYS: u64 =
    declared_days(include_str!("../../../../_shared/api-contract/src/schemas.ts").as_bytes());

const GRACE_SECS: u64 = GRACE_DAYS * DAY_SECS;

/// The integer in `SANDBOX_RECOVERY_DAYS = <n>;`; a source that stops saying it that way fails the build.
const fn declared_days(source: &[u8]) -> u64 {
    const KEY: &[u8] = b"SANDBOX_RECOVERY_DAYS = ";
    let mut at = 0;
    'scan: while at + KEY.len() < source.len() {
        let mut i = 0;
        while i < KEY.len() {
            if source[at + i] != KEY[i] {
                at += 1;
                continue 'scan;
            }
            i += 1;
        }
        let (mut end, mut days) = (at + KEY.len(), 0);
        while source[end].is_ascii_digit() {
            days = days * 10 + (source[end] - b'0') as u64;
            end += 1;
        }
        assert!(
            days > 0 && source[end] == b';',
            "SANDBOX_RECOVERY_DAYS must be a whole number of days"
        );
        return days;
    }
    panic!("_shared/api-contract/src/schemas.ts no longer declares SANDBOX_RECOVERY_DAYS");
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// One removed sandbox still inside its grace period.
pub struct Trashed {
    pub slug: String,
    /// The marker volume this reading came from; removing it is what ends the grace period.
    pub marker: String,
    pub removed_at: u64,
}

impl Trashed {
    /// Whole days still on the clock, rounded up — 0 only once the sandbox is due for purging.
    pub fn days_left(&self, now: u64) -> u64 {
        let spent = now.saturating_sub(self.removed_at);
        GRACE_SECS.saturating_sub(spent).div_ceil(DAY_SECS)
    }

    pub fn expired(&self, now: u64) -> bool {
        now.saturating_sub(self.removed_at) >= GRACE_SECS
    }
}

fn marker_name(slug: &str, at: u64) -> String {
    format!("{MARKER_PREFIX}{at}-{slug}")
}

/// Splits ONCE, so a slug carrying its own hyphens survives the round trip; an unparsable stamp reads as
/// removed-at-the-epoch and is therefore swept on the next pass rather than kept forever.
pub fn parse_marker(volume: &str) -> Option<Trashed> {
    let (stamp, slug) = volume.strip_prefix(MARKER_PREFIX)?.split_once('-')?;
    if slug.is_empty() {
        return None;
    }
    Some(Trashed {
        slug: slug.to_string(),
        marker: volume.to_string(),
        removed_at: stamp.parse().unwrap_or(0),
    })
}

/// The three container names a live sandbox answers to, paired with the names it takes in the trash.
fn container_pairs(slug: &str) -> [(String, String); 3] {
    [
        (
            format!("{CONTAINER_PREFIX}{slug}"),
            format!("{TRASH_PREFIX}{slug}"),
        ),
        (
            format!("{TUNNEL_PREFIX}{slug}"),
            format!("{TRASH_TUNNEL_PREFIX}{slug}"),
        ),
        (
            format!("{DIND_PREFIX}{slug}"),
            format!("{TRASH_DIND_PREFIX}{slug}"),
        ),
    ]
}

/// The named volumes holding everything a person would miss: /work, /history, and the two docker stores.
pub fn data_volumes(slug: &str) -> [String; 4] {
    [
        format!("intentic-workspace-{slug}"),
        format!("intentic-history-{slug}"),
        format!("intentic-docker-{slug}"),
        format!("intentic-dind-docker-{slug}"),
    ]
}

pub fn network(slug: &str) -> String {
    format!("intentic-workspace-{slug}")
}

fn marker_volumes() -> Vec<String> {
    docker::try_capture(&[
        "volume",
        "ls",
        "-q",
        "--filter",
        &format!("name={MARKER_PREFIX}"),
    ])
    .unwrap_or_default()
    .lines()
    .filter(|line| !line.is_empty())
    .map(str::to_string)
    .collect()
}

/// Every recoverable sandbox, newest removal first.
///
/// A slug that is LIVE again is not one of them, however recently it was removed: connecting a sandbox under the
/// same slug re-attaches the very volumes this entry stands for, so the data is already back and the marker
/// describes nothing. Excluded here rather than at each reader, because the alternative reading — that those
/// volumes are still the trash's to delete — is how a sweep would erase a running sandbox.
pub fn list() -> Vec<Trashed> {
    recoverable(&crate::sandbox::list_slugs())
}

fn recoverable(live: &[String]) -> Vec<Trashed> {
    let mut entries: Vec<Trashed> = marker_volumes()
        .iter()
        .filter_map(|volume| parse_marker(volume))
        .filter(|entry| !live.contains(&entry.slug))
        .collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.removed_at));
    entries
}

/// This slug's markers, live or not. Deliberately NOT `list`: the callers below are the ones that delete, and a
/// marker skipped for being superseded is one left behind to describe volumes that no longer exist.
fn markers_for(slug: &str) -> Vec<String> {
    marker_volumes()
        .iter()
        .filter_map(|volume| parse_marker(volume))
        .filter(|entry| entry.slug == slug)
        .map(|entry| entry.marker)
        .collect()
}

/// Markers whose slug has come back to life, so nothing keeps claiming a recovery that already happened.
fn drop_superseded_markers(live: &[String]) {
    for volume in marker_volumes() {
        let Some(entry) = parse_marker(&volume) else {
            continue;
        };
        if live.contains(&entry.slug) {
            docker::quiet(&["volume", "rm", &entry.marker]);
        }
    }
}

/// Clears what an earlier removal of this slug left in the trash NAMESPACE — never the data volumes, which carry
/// one name per slug and so already belong to whatever lives under it now.
fn clear_trash_names(slug: &str) {
    for (_, trashed) in container_pairs(slug) {
        docker::quiet(&["rm", "-f", &trashed]);
    }
    for marker in markers_for(slug) {
        docker::quiet(&["volume", "rm", &marker]);
    }
}

/// Moves one sandbox out of the live namespace with its data untouched. A second removal of the same slug
/// supersedes the first, whose containers would otherwise collide with the renames below.
pub fn stash(slug: &str) {
    clear_trash_names(slug);
    for (live, trashed) in container_pairs(slug) {
        if !docker::container_exists(&live) {
            continue;
        }
        docker::quiet(&["stop", &live]);
        docker::quiet(&["rename", &live, &trashed]);
    }
    docker::quiet(&["volume", "create", &marker_name(slug, now_secs())]);
}

/// Brings one back under its live names and starts it. The volumes never moved, so nothing is copied here.
pub fn restore(slug: &str) {
    for (live, trashed) in container_pairs(slug) {
        if docker::container_exists(&trashed) {
            docker::quiet(&["rename", &trashed, &live]);
        }
    }
    for marker in markers_for(slug) {
        docker::quiet(&["volume", "rm", &marker]);
    }
    for (live, _) in container_pairs(slug) {
        if docker::container_exists(&live) {
            docker::quiet(&["start", &live]);
        }
    }
}

/// Deletes one sandbox for good — both namespaces, since a purge may be aimed at a slug that was never trashed.
/// Idempotent: every step no-ops on what is already gone.
pub fn purge(slug: &str) {
    for (live, trashed) in container_pairs(slug) {
        docker::quiet(&["rm", "-f", &trashed]);
        docker::quiet(&["rm", "-f", &live]);
    }
    for volume in data_volumes(slug) {
        docker::quiet(&["volume", "rm", &volume]);
    }
    docker::quiet(&["network", "rm", &network(slug)]);
    for marker in markers_for(slug) {
        docker::quiet(&["volume", "rm", &marker]);
    }
}

/// Purges everything past its grace period. Runs at the head of the verbs that touch this machine's sandboxes,
/// so the disk comes back without anybody remembering to ask. `list` is what keeps a slug that is live again out
/// of this: its volumes belong to the running sandbox, not to the removal they outlived.
pub fn sweep() -> Vec<String> {
    let Some(live) = crate::sandbox::live_slugs() else {
        eprintln!("intentic: docker could not list this machine's sandboxes, so nothing past its recovery window was deleted this time.");
        return Vec::new();
    };
    drop_superseded_markers(&live);
    let now = now_secs();
    let due: Vec<String> = recoverable(&live)
        .into_iter()
        .filter(|entry| entry.expired(now))
        .map(|entry| entry.slug)
        .collect();
    for slug in &due {
        purge(slug);
    }
    due
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = DAY_SECS;

    #[test]
    fn the_grace_is_read_from_the_declaration_the_platform_exports() {
        assert_eq!(
            declared_days(b"/* x */\nexport const SANDBOX_RECOVERY_DAYS = 12;\n"),
            12
        );
    }

    #[test]
    fn marker_round_trips_a_slug_with_hyphens() {
        let name = marker_name("workspace-2", 1_700_000_000);
        let parsed = parse_marker(&name).expect("parsed");
        assert_eq!(parsed.slug, "workspace-2");
        assert_eq!(parsed.removed_at, 1_700_000_000);
    }

    #[test]
    fn a_volume_that_is_not_a_marker_parses_to_nothing() {
        assert!(parse_marker("intentic-workspace-abc").is_none());
        assert!(parse_marker("intentic-trashed-").is_none());
        // A stamp with no slug after it names no sandbox to restore.
        assert!(parse_marker("intentic-trashed-1700000000").is_none());
    }

    #[test]
    fn an_unreadable_stamp_is_swept_rather_than_kept_forever() {
        let parsed = parse_marker("intentic-trashed-nonsense-abc").expect("parsed");
        assert_eq!(parsed.removed_at, 0);
        assert!(parsed.expired(GRACE_SECS));
    }

    #[test]
    fn the_grace_period_is_a_full_week() {
        let entry = Trashed {
            slug: "abc".to_string(),
            marker: "m".to_string(),
            removed_at: 10 * DAY,
        };
        assert_eq!(entry.days_left(10 * DAY), 7);
        assert!(!entry.expired(10 * DAY));
        // A day short of the week still leaves a day on the clock, and is not yet due.
        assert_eq!(entry.days_left(16 * DAY), 1);
        assert!(!entry.expired(16 * DAY + DAY - 1));
        assert_eq!(entry.days_left(17 * DAY), 0);
        assert!(entry.expired(17 * DAY));
    }

    #[test]
    fn part_days_round_up_so_the_count_never_promises_less_than_it_has() {
        let entry = Trashed {
            slug: "abc".to_string(),
            marker: "m".to_string(),
            removed_at: 0,
        };
        assert_eq!(entry.days_left(1), 7);
        assert_eq!(entry.days_left(DAY + 1), 6);
    }

    #[test]
    fn the_trash_prefixes_never_collide_with_the_live_ones() {
        for (live, trashed) in container_pairs("abc") {
            assert!(!live.starts_with(TRASH_PREFIX));
            assert!(trashed.starts_with(TRASH_PREFIX));
        }
        // The tunnel and dind names must stay distinguishable from the primary, which shares their prefix.
        let [(primary, trashed_primary), (tunnel, trashed_tunnel), _] = container_pairs("abc");
        assert_ne!(primary, tunnel);
        assert!(trashed_tunnel.starts_with(TRASH_TUNNEL_PREFIX));
        assert!(!trashed_primary.starts_with(TRASH_TUNNEL_PREFIX));
    }
}
