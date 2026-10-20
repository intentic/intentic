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
    recoverable_in(&marker_volumes(), live)
}

/// The entries a marker listing holds, the live slugs left out, newest removal first. Pure.
fn recoverable_in(markers: &[String], live: &[String]) -> Vec<Trashed> {
    let mut entries: Vec<Trashed> = markers
        .iter()
        .filter_map(|volume| parse_marker(volume))
        .filter(|entry| !live.contains(&entry.slug))
        .collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.removed_at));
    entries
}

/// This slug's entry as the trash holds it NOW, read again rather than carried over from an earlier listing: the
/// verbs that delete decide what to delete before they hold the sandbox's lock, and a person can take as long as they
/// like over a purge's question. A restore that ran meanwhile brought the slug back to life, and the volumes that
/// listing named belong to a running sandbox now (2026-10-11: a purge confirmed after a restore deleted the restored
/// sandbox and its /work). None when docker would not list the containers either: a delete never guesses.
pub fn still_trashed(slug: &str) -> Option<Trashed> {
    let live = crate::sandbox::live_slugs()?;
    entry_of(slug, &marker_volumes(), &live)
}

/// One slug's entry in a marker listing, the newest marker standing for it; None once the slug is live again. Pure.
fn entry_of(slug: &str, markers: &[String], live: &[String]) -> Option<Trashed> {
    recoverable_in(markers, live)
        .into_iter()
        .find(|entry| entry.slug == slug)
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
    for trashed in trash_names(slug) {
        docker::quiet(&["rm", "-f", &trashed]);
    }
    for marker in markers_for(slug) {
        docker::quiet(&["volume", "rm", &marker]);
    }
}

/// What a removal does with one slug, by what it finds. Pure.
#[derive(Debug, PartialEq, Eq)]
enum Stash {
    /// Live containers to move into the trash, superseding whatever an earlier removal of the slug left there.
    Move,
    /// Nothing live, and the trash already holds the slug: that IS this sandbox, removed already (a second pass over
    /// the same name, or another ic run that got there first). Its containers and its clock are left as they are.
    AlreadyTrashed,
    /// Nothing live and nothing in the trash: the volumes a container removed by hand left, which the marker alone
    /// puts in the trash.
    MarkOnly,
}

fn stash_plan(live_containers: bool, in_trash: bool) -> Stash {
    match (live_containers, in_trash) {
        (true, _) => Stash::Move,
        (false, true) => Stash::AlreadyTrashed,
        (false, false) => Stash::MarkOnly,
    }
}

/// Moves one sandbox out of the live namespace with its data untouched. A second removal of the same slug
/// supersedes the first, whose containers would otherwise collide with the renames below — but only when there is a
/// live container to move: with none, what the trash holds under this slug is the sandbox itself (2026-10-11:
/// `ic sandbox remove a a` cleared, on its second pass, the containers its first had just put in the trash).
///
/// Err says what docker refused and where that left the sandbox. A rename or a marker that fails puts back what had
/// moved, so a sandbox is never half in the trash: trash names with no marker are restorable by nothing and listed
/// nowhere.
pub fn stash(slug: &str) -> std::result::Result<(), String> {
    settle_parked(slug);
    let present: Vec<(String, String)> = container_pairs(slug)
        .into_iter()
        .filter(|(live, _)| docker::container_exists(live))
        .collect();
    match stash_plan(!present.is_empty(), !markers_for(slug).is_empty()) {
        Stash::AlreadyTrashed => return Ok(()),
        Stash::MarkOnly if mark(slug) => {
            crate::sandbox::power::forget_sleep(slug);
            return Ok(());
        }
        Stash::MarkOnly => {
            return Err(format!(
                "docker would not create the marker that keeps {slug}'s data restorable, so its volumes were left as they are"
            ))
        }
        Stash::Move => {}
    }
    /* NOT ASLEEP IN THE TRASH (2026-10-19). A record that still said asleep kept `ic sandbox wakes` asking the platform
    about a sandbox nothing could start, and the machine agent polling for it every fifteen seconds for good (rog: two
    trashed sandboxes, one naming a dev platform that was not running, cost every wake two seconds). Once it is in the
    trash its record stops saying so (power.rs forget_sleep); a restore starts it anyway. The record is first made
    current from the sandbox's own volume, while a live name still reaches it (mirror.rs), so the home copy written
    after the move is never an older one stamped as the newest. */
    let asleep = crate::record::read(slug).is_ok_and(|record| record.asleep)
        && crate::sandbox::mirror::reconcile(slug).asleep;
    clear_trash_names(slug);
    let mut moved: Vec<(String, String)> = Vec::new();
    for (live, trashed) in present {
        docker::quiet(&["stop", &live]);
        if !docker::ok(&["rename", &live, &trashed]) {
            put_back(&moved);
            return Err(format!(
                "docker would not rename {live}, so {slug} is still on this device under its own name, stopped (ic sandbox start {slug} starts it again)"
            ));
        }
        moved.push((live, trashed));
    }
    if !mark(slug) {
        put_back(&moved);
        return Err(format!(
            "docker would not create the marker that keeps it restorable, so {slug} was put back under its own name, stopped (ic sandbox start {slug} starts it again)"
        ));
    }
    if asleep {
        crate::sandbox::power::forget_sleep(slug);
    }
    Ok(())
}

/// Undoes the renames of a removal that could not finish, last first.
fn put_back(moved: &[(String, String)]) {
    for (live, trashed) in moved.iter().rev() {
        docker::quiet(&["rename", trashed, live]);
    }
}

/// The marker that starts a sandbox's recovery window, labelled like everything ic makes (labels.rs).
fn mark(slug: &str) -> bool {
    mark_at(slug, now_secs())
}

fn mark_at(slug: &str, at: u64) -> bool {
    let mut args: Vec<String> = vec!["volume".to_string(), "create".to_string()];
    args.extend(crate::sandbox::labels::here(
        slug,
        crate::sandbox::labels::Kind::TrashMarker,
    ));
    args.push(marker_name(slug, at));
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker::ok(&refs)
}

/// Put a set of volumes no container, record or marker claims into the trash: nothing is renamed or deleted, the
/// marker alone starts the same recovery window a removal does, so `ic sandbox restore` and the week's grace apply to
/// it as to any removed sandbox (tidy.rs). True when the marker was made.
pub fn adopt_orphan(slug: &str) -> bool {
    markers_for(slug).is_empty() && mark(slug)
}

/// A swap's parked container, before the sandbox goes to the trash. Beside a live container it is the previous version
/// on probation, whose way back is also the pinned image, so it goes. Alone it IS the sandbox (a swap was interrupted
/// with no replacement), so it takes its name back and is trashed as the sandbox.
fn settle_parked(slug: &str) {
    let parked = crate::sandbox::parked_of(slug);
    if !docker::container_exists(&parked) {
        return;
    }
    let live = crate::sandbox::container_of(slug);
    if docker::container_exists(&live) {
        docker::quiet(&["rm", "-f", &parked]);
    } else {
        docker::quiet(&["rename", &parked, &live]);
    }
    if let Ok(record) = crate::record::read(slug) {
        if record.swap.is_some() {
            let _ = crate::record::write(
                slug,
                &crate::record::ChannelRecord {
                    swap: None,
                    ..record
                },
            );
        }
    }
    crate::record::remove_before(slug);
}

/// Whether the trash holds this sandbox's container, or only its data: a set of volumes tidy put there has no
/// container to bring back (tidy.rs, `adopt_orphan`).
pub fn has_container(slug: &str) -> bool {
    docker::container_exists(&format!("{TRASH_PREFIX}{slug}"))
}

/// Brings one back under its live names and starts it. The volumes never moved, so nothing is copied here.
///
/// Err, with the marker kept and so the clock still running, when there is no container in the trash to bring back
/// (only data, which a restore cannot start: 2026-10-11, it dropped the marker and said "restored" over volumes no
/// container ran on, and the next tidy put them back in the trash with a fresh week), or when docker would not rename
/// it back.
pub fn restore(slug: &str) -> std::result::Result<(), String> {
    let [(live, trashed), others @ ..] = container_pairs(slug);
    if !docker::container_exists(&trashed) {
        return Err(format!(
            "the trash holds only {slug}'s data, no container to start"
        ));
    }
    if !docker::ok(&["rename", &trashed, &live]) {
        return Err(format!(
            "docker would not rename {trashed} back to {live}, so {slug} stays in the trash"
        ));
    }
    for (live, trashed) in others {
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
    Ok(())
}

/// The container names a purge removes: the trash's alone. Pure.
fn trash_names(slug: &str) -> [String; 3] {
    container_pairs(slug).map(|(_, trashed)| trashed)
}

/// Whether the slug runs on this device, under its own name or parked by a swap.
fn is_live(slug: &str) -> bool {
    docker::container_exists(&crate::sandbox::container_of(slug))
        || docker::container_exists(&crate::sandbox::parked_of(slug))
}

/// Deletes one removed sandbox for good: its containers in the trash and its data. Idempotent: every step no-ops on
/// what is already gone.
///
/// Never a live-named container (2026-10-11): it used to `rm -f` those too, so a purge decided on before a restore of
/// the same slug deleted the restored sandbox. A slug that is live again is refused whole, since its volumes are the
/// running sandbox's. Deleting a sandbox that is live is `delete`, which only `ic sandbox remove --now` asks for.
///
/// The marker goes only once every data volume has (2026-10-05): it is the one record that these volumes are the
/// trash's, and dropping it beside a volume docker refused to remove left that volume claimed by nothing, for good
/// (rog's `sandbox-fc55412d2c28`). Err names what is still there, or that docker would not say.
pub fn purge(slug: &str) -> std::result::Result<(), String> {
    if is_live(slug) {
        return Err(format!(
            "{slug} is on this device again (restored or set up anew), so none of it was deleted"
        ));
    }
    discard(slug)
}

/// A sandbox deleted for good whether it runs or sits in the trash: `ic sandbox remove --now`. Its live containers go
/// first, then everything `purge` deletes. What docker would not delete stays in the trash, due at once, so the next
/// sweep tries again rather than leaving volumes no marker claims.
pub fn delete(slug: &str) -> std::result::Result<(), String> {
    // A parked container holds the same volumes, and docker refuses to remove a volume any container still names.
    docker::quiet(&["rm", "-f", &crate::sandbox::parked_of(slug)]);
    for (live, _) in container_pairs(slug) {
        docker::quiet(&["rm", "-f", &live]);
    }
    if is_live(slug) {
        return Err(format!(
            "docker would not remove {}, so none of {slug} was deleted",
            crate::sandbox::container_of(slug)
        ));
    }
    let deleted = discard(slug);
    if deleted.is_err() && markers_for(slug).is_empty() {
        mark_at(slug, now_secs().saturating_sub(GRACE_SECS));
    }
    deleted
}

fn discard(slug: &str) -> std::result::Result<(), String> {
    for trashed in trash_names(slug) {
        docker::quiet(&["rm", "-f", &trashed]);
    }
    for volume in data_volumes(slug) {
        docker::quiet(&["volume", "rm", &volume]);
    }
    docker::quiet(&["network", "rm", &network(slug)]);
    let Some(names) = docker::try_capture(&["volume", "ls", "--format", "{{.Name}}"]) else {
        return Err(format!(
            "docker would not list its volumes, so {slug} stays in the trash until the next try"
        ));
    };
    let left = still_there(slug, &names);
    if !left.is_empty() {
        return Err(format!(
            "docker would not remove {} of {slug}, so it stays in the trash until the next try",
            left.join(", ")
        ));
    }
    for marker in markers_for(slug) {
        docker::quiet(&["volume", "rm", &marker]);
    }
    // Its at-rest key goes with the data it encrypted, once none of it is left on this side (at_rest.rs).
    crate::sandbox::at_rest::forget_with_data(slug);
    Ok(())
}

/// Which of a sandbox's data volumes a volume listing still holds. Pure.
pub fn still_there(slug: &str, listing: &str) -> Vec<String> {
    let names: Vec<&str> = listing.lines().map(str::trim).collect();
    data_volumes(slug)
        .into_iter()
        .filter(|volume| names.contains(&volume.as_str()))
        .collect()
}

/// Purges everything past its grace period. Runs at the head of the verbs that touch this machine's sandboxes,
/// so the disk comes back without anybody remembering to ask. `list` is what keeps a slug that is live again out
/// of this: its volumes belong to the running sandbox, not to the removal they outlived.
pub fn sweep() -> Vec<String> {
    let Some(live) = crate::sandbox::live_slugs() else {
        crate::ui::warn("Docker could not list the sandboxes on this device, so nothing past its recovery window was deleted this time.");
        return Vec::new();
    };
    drop_superseded_markers(&live);
    let now = now_secs();
    let due: Vec<String> = recoverable(&live)
        .into_iter()
        .filter(|entry| entry.expired(now))
        .map(|entry| entry.slug)
        .collect();
    let mut purged = Vec::new();
    for slug in due {
        // A sandbox another ic run on this side is working on (a restore of it, say) waits for the next sweep.
        let Ok(Some(_held)) = crate::sandbox::lock::hold(&slug, crate::sandbox::lock::Wait::Skip)
        else {
            continue;
        };
        // Read again under the lock: a restore that finished between the listing above and the lock brought it
        // back, and a removal of the same slug since restarted its clock.
        if !still_trashed(&slug).is_some_and(|entry| entry.expired(now_secs())) {
            continue;
        }
        match purge(&slug) {
            Ok(()) => purged.push(slug),
            Err(why) => crate::ui::warn(&format!("{why}.")),
        }
    }
    purged
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
    fn a_purge_is_done_only_once_no_volume_of_the_sandbox_is_listed() {
        let listing = "intentic-workspace-abc\nintentic-history-abcd\nintentic-trashed-1-abc\n";
        assert_eq!(still_there("abc", listing), vec!["intentic-workspace-abc"]);
        assert!(still_there("abc", "intentic-history-abcd\n").is_empty());
        assert_eq!(
            still_there("abc", "intentic-dind-docker-abc\n"),
            vec!["intentic-dind-docker-abc"]
        );
    }

    fn markers(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn a_slug_that_came_back_to_life_is_no_longer_the_trashs_to_delete() {
        let listing = markers(&["intentic-trashed-100-bbb", "intentic-trashed-100-ccc"]);
        // A restore between a purge's listing and its lock: the slug is live, so nothing of it is the trash's.
        assert!(entry_of("bbb", &listing, &markers(&["aaa", "bbb"])).is_none());
        assert_eq!(
            entry_of("bbb", &listing, &markers(&["aaa"]))
                .expect("still trashed")
                .marker,
            "intentic-trashed-100-bbb"
        );
        // Its marker gone meanwhile (a restore, or another purge that got there first): nothing to delete.
        assert!(entry_of("bbb", &markers(&["intentic-trashed-100-ccc"]), &[]).is_none());
    }

    #[test]
    fn the_newest_marker_decides_whether_a_slug_is_due() {
        let now = 100 * DAY;
        let listing = markers(&[
            &format!("intentic-trashed-{}-bbb", 10 * DAY),
            &format!("intentic-trashed-{}-bbb", 99 * DAY),
        ]);
        let entry = entry_of("bbb", &listing, &[]).expect("trashed");
        assert_eq!(entry.removed_at, 99 * DAY);
        assert!(!entry.expired(now), "a removal a day old is not due");
    }

    #[test]
    fn a_second_removal_with_nothing_live_leaves_what_the_trash_holds() {
        // `ic sandbox remove a a`: the second pass finds no live container and the slug already in the trash.
        assert_eq!(stash_plan(false, true), Stash::AlreadyTrashed);
        assert_eq!(stash_plan(true, true), Stash::Move);
        assert_eq!(stash_plan(true, false), Stash::Move);
        assert_eq!(stash_plan(false, false), Stash::MarkOnly);
    }

    #[test]
    fn a_purge_names_only_the_trashs_containers_never_a_live_one() {
        let live = [
            crate::sandbox::container_of("abc"),
            crate::sandbox::parked_of("abc"),
        ];
        for name in trash_names("abc") {
            assert!(name.starts_with(TRASH_PREFIX), "{name}");
            for prefix in [CONTAINER_PREFIX, TUNNEL_PREFIX, DIND_PREFIX] {
                assert!(!name.starts_with(prefix), "{name} is a live name");
            }
            assert!(!live.contains(&name));
        }
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
