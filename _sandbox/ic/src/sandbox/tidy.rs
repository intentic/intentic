use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde_json::{json, Value};

use crate::docker;
use crate::logfile::{intentic_home, Log};
use crate::record::{self, ChannelRecord, Pin};
use crate::sandbox::labels;
use crate::sandbox::lock::{self, Wait};
use crate::sandbox::side::{self, Adoption, Keeper, Side};
use crate::sandbox::{backup, container_of, live_slugs, mirror, now_ms, parked_of, trash};
use crate::util::{bail, Result};

/* WHAT UPDATES LEAVE BEHIND, cleared. Every overlay rebuild tags a new image and leaves the one before it dangling,
every removed sandbox leaves its environment builds and rollback pins, and every channel record outlives its sandbox.
On a machine that has hosted a dozen sandboxes that is tens of gigabytes, and a full disk is how the NEXT update
fails. `ic sandbox tidy` removes what nothing on this machine can use any more; it never deletes a volume.

Every store it looks after has a rule (the audit's rule 5, 2026-10-05):
- images of sandboxes that are gone, and builds and pins nothing names any more: removed, each sandbox's only while
  no other ic run holds it;
- overlay builds left dangling by a rebuild (they carry the `dev.intentic.base-id` label every build gets): removed;
- channel records of sandboxes that are gone, and report-only records of another side's sandboxes: moved to
  `records-archive/`, which keeps them 90 days;
- volumes no container, record or trash entry claims: named, and in an unattended run put into the trash, which
  starts the same seven-day window a removal does instead of leaving them for ever;
- this side's backups of a sandbox gone for 30 days, or of a sandbox another side keeps and has backed up since:
  removed, never the only copy of a live sandbox. */

/// The image families ic builds or pins per sandbox: `<prefix><slug>:<tag>`.
const FAMILIES: [&str; 3] = [
    "intentic-sandbox-rollback-",
    "intentic-sandbox-dev-env-",
    "intentic-sandbox-env-",
];

/// The volume families a sandbox's data lives in, the run contract's three and the Windows deploy target's.
const VOLUME_FAMILIES: [&str; 4] = [
    "intentic-workspace-",
    "intentic-history-",
    "intentic-docker-",
    "intentic-dind-docker-",
];

/// The sandbox network's prefix (sandboxNames().network).
const NETWORK_PREFIX: &str = "intentic-workspace-";

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// How long `records-archive/` keeps a record.
const ARCHIVE_KEEP_MS: u64 = 90 * DAY_MS;
/// How long this side keeps the backups of a sandbox that is gone.
const BACKUP_KEEP_MS: u64 = 30 * DAY_MS;
/// How much newer the keeping side's backup must be than this side's before this side's counts as a stale duplicate:
/// the two moments are read off two clocks.
const BACKUP_CLOCK_MARGIN_MS: u64 = 60 * 60 * 1000;

/// The sandbox an image of ours belongs to, and whether it is a rollback pin. Only the tags ic itself writes (twelve hex
/// characters of an id or a recipe hash, and `env-` before them for the environment build pinned beside a base) count: a
/// tag a person made under the same name is theirs to remove. Pure.
pub fn owner_of(reference: &str) -> Option<(String, bool)> {
    let (repository, tag) = reference.rsplit_once(':')?;
    let pinned_env = tag.strip_prefix("env-");
    let id = pinned_env.unwrap_or(tag);
    if id.len() != 12 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    FAMILIES.iter().find_map(|prefix| {
        let rollback = prefix.contains("rollback");
        repository
            .strip_prefix(prefix)
            .filter(|slug| !slug.is_empty() && (rollback || pinned_env.is_none()))
            .map(|slug| (slug.to_string(), rollback))
    })
}

/// Whether an image of a sandbox that still exists is still of use: what its containers run (live or parked), a
/// rollback target the record (or the pre-swap record) names, or the build a prepare left waiting. Pure.
pub fn in_use(reference: &str, id: &str, used_ids: &[String], named: &[String]) -> bool {
    used_ids.iter().any(|used| used == id) || named.iter().any(|name| name == reference)
}

/// The sandbox a data volume belongs to. A runner's volumes are never tidy's: a runner is its parent sandbox's to
/// remove. Pure.
pub fn volume_slug(volume: &str) -> Option<&str> {
    VOLUME_FAMILIES
        .iter()
        .find_map(|prefix| volume.strip_prefix(prefix))
        .filter(|slug| !slug.is_empty() && !slug.starts_with("runner-"))
}

/// The volumes and network one sandbox left with nothing claiming them, and the side its labels name, when they do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Orphan {
    pub slug: String,
    pub volumes: Vec<String>,
    pub network: Option<String>,
    pub side: Option<Side>,
}

/// Group the volumes (`name`, the `dev.intentic.side` label or empty) and networks no live or trashed sandbox claims by
/// the sandbox they belong to. Pure.
pub fn orphans(
    volumes: &[(String, String)],
    networks: &[String],
    known: &dyn Fn(&str) -> bool,
) -> Vec<Orphan> {
    let mut sets: BTreeMap<String, Orphan> = BTreeMap::new();
    for (volume, label) in volumes {
        let Some(slug) = volume_slug(volume).filter(|slug| !known(slug)) else {
            continue;
        };
        let set = sets.entry(slug.to_string()).or_insert_with(|| Orphan {
            slug: slug.to_string(),
            volumes: Vec::new(),
            network: None,
            side: None,
        });
        set.volumes.push(volume.clone());
        if set.side.is_none() {
            set.side = Side::parse(label);
        }
    }
    for network in networks {
        let Some(slug) = network
            .strip_prefix(NETWORK_PREFIX)
            .filter(|slug| !slug.is_empty() && !slug.starts_with("runner-") && !known(slug))
        else {
            continue;
        };
        sets.entry(slug.to_string())
            .or_insert_with(|| Orphan {
                slug: slug.to_string(),
                volumes: Vec::new(),
                network: None,
                side: None,
            })
            .network = Some(network.clone());
    }
    sets.into_values().collect()
}

/// What an unattended tidy does with an orphan set: trash it when nothing claims it and no other side's label names
/// it; a set with no volumes (a network alone) has nothing to keep. Pure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrphanFate {
    Trash,
    /// This side's home still holds its record: its sandbox is known here, if gone; the record goes first.
    Recorded,
    /// Another side made these volumes: that side's tidy decides.
    OtherSide(Side),
    /// Only a network, which holds nothing: named.
    NetworkOnly,
}

pub fn orphan_fate(orphan: &Orphan, recorded: bool, here: &Side) -> OrphanFate {
    if orphan.volumes.is_empty() {
        return OrphanFate::NetworkOnly;
    }
    if recorded {
        return OrphanFate::Recorded;
    }
    match &orphan.side {
        Some(side) if !side.same(here) => OrphanFate::OtherSide(side.clone()),
        _ => OrphanFate::Trash,
    }
}

/// A record that holds nothing but a report key (the key, its platform, its stamps): the kind an older `ic sandbox
/// list` made for every container on the engine, the other side's included. Pure.
pub fn report_only(record: &ChannelRecord) -> bool {
    let bare = ChannelRecord {
        report_key: None,
        report_platform: None,
        written: None,
        side: None,
        held: false,
        ..record.clone()
    };
    bare == ChannelRecord::default()
}

/// Whether an archived record is past its keeping, by the moment it was archived (its file's modified time). Pure.
pub fn archive_expired(archived_at: u64, now: u64) -> bool {
    now.saturating_sub(archived_at) >= ARCHIVE_KEEP_MS
}

/// Where a sandbox this side holds backups of stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Standing {
    /// Its container is here, and this side keeps it (or adopts it while its keeper is silent).
    Ours,
    /// Its container is here, and another side keeps it.
    Theirs(Side),
    /// Docker would not say whose it is.
    Unknown,
    /// In the trash: it may yet come back.
    Trashed,
    /// No container, no trash entry, no record in this home.
    Gone,
}

/// What becomes of this side's backups of one sandbox, and why: the reason is said for both answers, and logged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackupFate {
    Keep(String),
    Remove(String),
}

/// The rule for this side's backups (the audit's item 17). A backup of a live sandbox goes only when the side that
/// keeps it has backed it up since, so it is never the only copy; one of a sandbox gone goes once it has been gone 30
/// days, counted from the later of its record's archiving and this side's last backup of it (a backup proves the
/// sandbox was there). `ours_last` is this side's last backup, `keepers_last` what the keeping side's `backup.json`
/// says (its side and moment). Pure.
pub fn backup_fate(
    standing: &Standing,
    ours_last: Option<u64>,
    keepers_last: Option<(Side, u64)>,
    archived_at: Option<u64>,
    now: u64,
) -> BackupFate {
    match standing {
        Standing::Ours => BackupFate::Keep("this side keeps the sandbox".to_string()),
        Standing::Unknown => BackupFate::Keep("docker would not say whose the sandbox is".to_string()),
        Standing::Trashed => BackupFate::Keep("the sandbox is in the trash and may come back".to_string()),
        Standing::Theirs(keeper) => match keepers_last {
            Some((side, at))
                if side.same(keeper)
                    && at > ours_last.unwrap_or(0).saturating_add(BACKUP_CLOCK_MARGIN_MS) =>
            {
                BackupFate::Remove(format!(
                    "{} keeps the sandbox and backed it up at {}, after this side's last backup{}: this copy is a stale duplicate",
                    keeper.name(),
                    crate::util::utc_minute(at),
                    ours_last
                        .map(|ours| format!(" ({})", crate::util::utc_minute(ours)))
                        .unwrap_or_default()
                ))
            }
            _ => BackupFate::Keep(format!(
                "{} keeps the sandbox and has not backed it up since this side did",
                keeper.name()
            )),
        },
        Standing::Gone => {
            let since = [archived_at, ours_last].into_iter().flatten().max();
            match since {
                Some(since) if now.saturating_sub(since) >= BACKUP_KEEP_MS => {
                    BackupFate::Remove(format!(
                        "the sandbox has been gone since at least {} (more than 30 days)",
                        crate::util::utc_minute(since)
                    ))
                }
                Some(since) => BackupFate::Keep(format!(
                    "the sandbox has been gone only since {}; its backups are kept 30 days",
                    crate::util::utc_minute(since)
                )),
                None => BackupFate::Keep(
                    "nothing says when the sandbox went, so its backups are kept".to_string(),
                ),
            }
        }
    }
}

/// The moment a file was last modified, in epoch milliseconds.
fn modified_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
}

fn archive_dir() -> std::path::PathBuf {
    intentic_home().join("records-archive")
}

/// Move a record (and its pre-swap copy) into the archive, dated now: its modified time is when it was archived,
/// which is what the archive's 90 days and a gone sandbox's backups count from (a rename alone keeps the time the
/// record was last written, which can be long before its sandbox went).
fn archive_record(slug: &str) {
    let archive = archive_dir();
    let _ = std::fs::create_dir_all(&archive);
    let name = format!("sandbox-{slug}.channel");
    let target = archive.join(&name);
    if std::fs::rename(record::record_path(slug), &target).is_ok() {
        if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&target) {
            let _ = file.set_modified(std::time::SystemTime::now());
        }
    }
    let _ = std::fs::rename(
        record::before_path(slug),
        archive.join(format!("{name}.before")),
    );
}

/// What one tidy found and did, for the person and for `--json`.
#[derive(Default)]
struct Tally {
    images: Vec<String>,
    busy: Vec<String>,
    adopted: Vec<(String, Adoption)>,
    dangling: usize,
    records: Vec<String>,
    records_pruned: usize,
    orphan_volumes: Vec<String>,
    orphan_networks: Vec<String>,
    trashed_sets: Vec<String>,
    other_sides: Vec<(String, Side)>,
    backups: Vec<(String, String, u64)>,
}

/// `ic sandbox tidy [--dry-run] [--json] [--auto]`. Unattended (`--auto`, or no terminal: the machine agent's daily
/// round, or `ic sandbox fix --auto`'s repair) it also moves unclaimed volumes into the trash.
pub fn run(dry_run: bool, as_json: bool, auto: bool) -> Result<()> {
    docker::require_daemon()?;
    // The copies a move between engines left on the other engine, once their days are up (engine/moves.rs): they sit
    // where this tidy's own listing never looks, so they are named to the move's own cleanup instead.
    if !dry_run {
        if let Err(crate::util::Fail(reason)) = crate::engine::moves::cleanup(false) {
            crate::ui::warn(&format!(
                "the copies an engine move left behind were not removed this time: {reason}"
            ));
        }
    }
    let unattended = auto || !crate::tty::have_tty();
    let Some(live) = live_slugs() else {
        bail!("docker could not list this machine's sandboxes, so nothing was removed.");
    };
    let trashed: Vec<String> = trash::list().into_iter().map(|entry| entry.slug).collect();
    // The trash's own overdue entries go first, as every other verb that touches sandboxes does.
    let purged = if dry_run { Vec::new() } else { trash::sweep() };
    let known = |slug: &str| live.iter().any(|l| l == slug) || trashed.iter().any(|t| t == slug);

    // A listing docker would not give is a failure, never an empty machine: read as empty, it reported "nothing to
    // clear" while the snapshotter was failing, and hid the volumes it should have named.
    let Some(listing) =
        docker::try_capture(&["images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"])
    else {
        bail!("docker could not list this machine's images, so nothing was removed.");
    };
    let side_label = format!("{{{{.Name}}}}\t{{{{.Label \"{}\"}}}}", labels::SIDE);
    let Some(volumes) = docker::try_capture(&["volume", "ls", "--format", &side_label]) else {
        bail!("docker could not list this machine's volumes, so nothing was removed.");
    };
    let Some(networks) = docker::try_capture(&["network", "ls", "--format", "{{.Name}}"]) else {
        bail!("docker could not list this machine's networks, so nothing was removed.");
    };
    let here = side::here();
    let mut tally = Tally::default();

    /* IMAGES, per sandbox. */
    let mut images: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for line in listing.lines() {
        let Some((reference, short_id)) = line.split_once(' ') else {
            continue;
        };
        if let Some((slug, _pin)) = owner_of(reference) {
            images
                .entry(slug)
                .or_default()
                .push((reference.to_string(), short_id.to_string()));
        }
    }
    let mut keepers: HashMap<String, Keeper> = HashMap::new();
    for (slug, references) in &images {
        let gone = !known(slug);
        if !gone {
            // Which of the other side's images are still of use is in that side's record, not this one's: its own
            // tidy decides (side.rs), unless it has fallen silent and this run adopts the sandbox. A sandbox docker
            // would not say the side of is left alone too: deleting needs a yes, never a guess.
            let keeper = match side::keeper(slug) {
                Keeper::Elsewhere(side) => match side::lease(slug, &side) {
                    Some(adoption) => {
                        tally.adopted.push((slug.clone(), adoption));
                        Keeper::Here
                    }
                    None => Keeper::Elsewhere(side),
                },
                keeper => keeper,
            };
            keepers.insert(slug.clone(), keeper.clone());
            if keeper != Keeper::Here {
                continue;
            }
        }
        // What is in use is decided, and the images removed, while this run holds the sandbox's lock: a swap in flight
        // is about to name the very build that looks unused (2026-10-05: tidy took no lock).
        let _held = if dry_run {
            None
        } else {
            match lock::hold(slug, Wait::Skip) {
                Ok(Some(held)) => Some(held),
                _ => {
                    tally.busy.push(slug.clone());
                    continue;
                }
            }
        };
        let removable: Vec<&String> = if gone {
            references.iter().map(|(reference, _)| reference).collect()
        } else {
            let used_ids: Vec<String> = [container_of(slug), parked_of(slug)]
                .iter()
                .filter_map(|container| docker::inspect(container, "{{.Image}}"))
                .collect();
            let mut named: Vec<String> = Vec::new();
            // The record on the sandbox's own volume too: an adopted sandbox's rollback pins are named in its
            // keeper's record.
            for rec in [
                record::read(slug).ok(),
                record::read_before(slug).ok().flatten(),
                mirror::volume_record(slug),
            ]
            .into_iter()
            .flatten()
            {
                named.extend(rec.targets().iter().flat_map(Pin::images));
                named.extend(rec.staged.clone());
                named.extend(rec.current.clone());
            }
            references
                .iter()
                .filter(|(reference, short_id)| {
                    let id = docker::image_id(reference).unwrap_or_else(|| short_id.clone());
                    !in_use(reference, &id, &used_ids, &named)
                })
                .map(|(reference, _)| reference)
                .collect()
        };
        for reference in removable {
            // Never -f: an image a container still uses is refused, which is the right answer for anything missed.
            if dry_run || docker::ok(&["rmi", reference]) {
                tally.images.push(reference.clone());
            }
        }
    }

    /* OVERLAY BUILDS LEFT DANGLING: a rebuild retags, and the build before it keeps only its label. */
    tally.dangling = dangling_builds(dry_run);

    /* RECORDS. */
    if let Ok(entries) = std::fs::read_dir(intentic_home()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(slug) = name
                .strip_prefix("sandbox-")
                .and_then(|rest| rest.strip_suffix(".channel"))
            else {
                continue;
            };
            let record = record::read(slug).unwrap_or_default();
            let archive = if !known(slug) {
                true
            } else {
                // Another side's sandbox, of which this home holds only a report key an older listing made.
                report_only(&record)
                    && matches!(
                        keepers
                            .get(slug)
                            .cloned()
                            .unwrap_or_else(|| side::keeper(slug)),
                        Keeper::Elsewhere(_)
                    )
            };
            if archive {
                tally.records.push(slug.to_string());
                if !dry_run {
                    archive_record(slug);
                }
            } else if record.side.is_none() && !dry_run {
                // A record from before records named their side says from now on whose sandbox it describes: this
                // side's, or the side that keeps it, so a run with Docker down no longer reads the other side's
                // sandbox as one of its own (fix/mod.rs, own_records). One docker cannot place is left as it is.
                let owner = match side::keeper(slug) {
                    Keeper::Here => Some(here.wire()),
                    Keeper::Elsewhere(keeper) => Some(keeper.wire()),
                    Keeper::Unknown => None,
                };
                if owner.is_some() {
                    let _ = record::write_file(
                        &record::record_path(slug),
                        &ChannelRecord {
                            side: owner,
                            ..record
                        },
                    );
                }
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(archive_dir()) {
        let now = now_ms();
        for entry in entries.flatten() {
            if modified_ms(&entry.path()).is_some_and(|at| archive_expired(at, now)) {
                tally.records_pruned += 1;
                if !dry_run {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    /* VOLUMES AND NETWORKS nothing claims. */
    let volume_rows: Vec<(String, String)> = volumes
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let (name, label) = line.split_once('\t').unwrap_or((line, ""));
            (name.trim().to_string(), label.trim().to_string())
        })
        .collect();
    let network_rows: Vec<String> = networks
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    for orphan in orphans(&volume_rows, &network_rows, &known) {
        tally.orphan_volumes.extend(orphan.volumes.iter().cloned());
        tally.orphan_networks.extend(orphan.network.iter().cloned());
        let recorded = record::record_path(&orphan.slug).exists();
        match orphan_fate(&orphan, recorded, &here) {
            OrphanFate::Trash if unattended => {
                if dry_run {
                    tally.trashed_sets.push(orphan.slug.clone());
                    continue;
                }
                let Ok(Some(_held)) = lock::hold(&orphan.slug, Wait::Skip) else {
                    tally.busy.push(orphan.slug.clone());
                    continue;
                };
                // Looked at once more: a setup that made its volumes a moment ago has a container by now.
                if docker::container_exists(&container_of(&orphan.slug)) {
                    continue;
                }
                if trash::adopt_orphan(&orphan.slug) {
                    tally.trashed_sets.push(orphan.slug.clone());
                }
            }
            OrphanFate::OtherSide(side) => tally.other_sides.push((orphan.slug.clone(), side)),
            _ => {}
        }
    }

    /* BACKUPS this side holds. */
    backups(dry_run, &known, &mut tally);

    if as_json {
        println!("{}", report(&tally, dry_run, &purged));
        return Ok(());
    }
    say(&tally, dry_run, &purged, unattended);
    Ok(())
}

/// Remove the overlay builds a rebuild left dangling, by the label every build ic makes carries (identity.rs), and
/// nothing else: a dangling image of anyone else's is theirs. The count is the listing before less the one after.
fn dangling_builds(dry_run: bool) -> usize {
    let filter = format!("label={}", crate::sandbox::identity::BASE_ID_LABEL);
    let count = || {
        docker::try_capture(&[
            "images",
            "-q",
            "--no-trunc",
            "--filter",
            "dangling=true",
            "--filter",
            &filter,
        ])
        .map(|ids| ids.lines().filter(|line| !line.trim().is_empty()).count())
    };
    let Some(before) = count() else {
        return 0;
    };
    if dry_run || before == 0 {
        return before;
    }
    docker::quiet(&["image", "prune", "-f", "--filter", &filter]);
    before.saturating_sub(count().unwrap_or(before))
}

/// Decide, and in a real run carry out, the fate of every sandbox's backups this side holds; every decision is logged.
fn backups(dry_run: bool, known: &dyn Fn(&str) -> bool, tally: &mut Tally) {
    let held = backup::held_here();
    if held.is_empty() {
        return;
    }
    let log = Log::create("tidy").ok();
    let note = |line: &str| {
        if let Some(log) = &log {
            log.line(line);
        }
    };
    let trashed: Vec<String> = trash::list().into_iter().map(|entry| entry.slug).collect();
    let now = now_ms();
    for slug in held {
        let live = docker::container_exists(&container_of(&slug))
            || docker::container_exists(&parked_of(&slug));
        let standing = if live {
            match side::keeper(&slug) {
                Keeper::Here => Standing::Ours,
                Keeper::Unknown => Standing::Unknown,
                // A keeper fallen silent is adopted here, and this side's backup may be the freshest there is.
                Keeper::Elsewhere(keeper) => match side::lease(&slug, &keeper) {
                    Some(_) => Standing::Ours,
                    None => Standing::Theirs(keeper),
                },
            }
        } else if trashed.contains(&slug) {
            Standing::Trashed
        } else if known(&slug) || record::record_path(&slug).exists() {
            Standing::Unknown
        } else {
            Standing::Gone
        };
        let keepers_last = match &standing {
            Standing::Theirs(_) => backup::last_said(&slug),
            _ => None,
        };
        let archived_at = modified_ms(&archive_dir().join(format!("sandbox-{slug}.channel")));
        let fate = backup_fate(
            &standing,
            backup::last_here(&slug),
            keepers_last,
            archived_at,
            now,
        );
        let (BackupFate::Keep(why) | BackupFate::Remove(why)) = &fate;
        note(&format!(
            "backups of {slug}: {} — {why}",
            if matches!(fate, BackupFate::Remove(_)) {
                if dry_run {
                    "would remove"
                } else {
                    "remove"
                }
            } else {
                "keep"
            }
        ));
        let BackupFate::Remove(why) = fate else {
            continue;
        };
        if dry_run {
            tally.backups.push((slug.clone(), why, 0));
            continue;
        }
        let Ok(Some(_held)) = lock::hold(&slug, Wait::Skip) else {
            tally.busy.push(slug.clone());
            continue;
        };
        match backup::discard(&slug) {
            Ok(bytes) => tally.backups.push((slug.clone(), why, bytes)),
            Err(failed) => note(&format!("backups of {slug}: could not remove — {failed}")),
        }
    }
}

/// The `--json` answer. Pure over what was found.
fn report(tally: &Tally, dry_run: bool, purged: &[String]) -> Value {
    json!({
        "dryRun": dry_run,
        "images": tally.images,
        "skippedBusy": tally.busy,
        "adopted": tally.adopted.iter().map(|(slug, adoption)| {
            let mut entry = adoption.json();
            entry["slug"] = json!(slug);
            entry
        }).collect::<Vec<Value>>(),
        "danglingBuilds": tally.dangling,
        "records": tally.records,
        "recordsPruned": tally.records_pruned,
        "purgedFromTrash": purged,
        "orphanVolumes": tally.orphan_volumes,
        "orphanNetworks": tally.orphan_networks,
        "trashedVolumeSets": tally.trashed_sets,
        "otherSidesVolumes": tally.other_sides.iter().map(|(slug, side)| json!({ "slug": slug, "side": side.wire() })).collect::<Vec<Value>>(),
        "backups": tally.backups.iter().map(|(slug, why, bytes)| json!({ "slug": slug, "reason": why, "bytes": bytes })).collect::<Vec<Value>>(),
    })
}

/// What a person reads.
fn say(tally: &Tally, dry_run: bool, purged: &[String], unattended: bool) {
    let verb = if dry_run { "would remove" } else { "removed" };
    println!(
        "intentic: tidy {verb} {} image(s) no sandbox here can use.",
        tally.images.len()
    );
    for image in &tally.images {
        println!("          {image}");
    }
    for (slug, adoption) in &tally.adopted {
        println!("intentic: {slug}: {}", adoption.sentence());
    }
    if !tally.busy.is_empty() {
        println!(
            "intentic: left for the next tidy, another ic run holds them: {}.",
            tally.busy.join(", ")
        );
    }
    if tally.dangling > 0 {
        println!(
            "intentic: {verb} {} environment build(s) a rebuild left behind.",
            tally.dangling
        );
    }
    if !tally.records.is_empty() {
        println!(
            "intentic: {} record(s) of sandboxes that are gone or kept by another side {} to {}.",
            tally.records.len(),
            if dry_run { "would move" } else { "moved" },
            archive_dir().display()
        );
    }
    if tally.records_pruned > 0 {
        println!(
            "intentic: {verb} {} archived record(s) older than 90 days.",
            tally.records_pruned
        );
    }
    if !purged.is_empty() {
        println!(
            "intentic: deleted {} sandbox(es) whose recovery window ran out: {}.",
            purged.len(),
            purged.join(", ")
        );
    }
    if !tally.trashed_sets.is_empty() {
        println!(
            "intentic: {} the volumes of {} into the trash: nothing on this machine claims them. `ic sandbox restore <slug>` takes them back out within {} days.",
            if dry_run { "would move" } else { "moved" },
            tally.trashed_sets.join(", "),
            trash::GRACE_DAYS
        );
    }
    let named: Vec<&String> = tally
        .orphan_volumes
        .iter()
        .chain(tally.orphan_networks.iter())
        .filter(|name| {
            volume_slug(name)
                .or_else(|| name.strip_prefix(NETWORK_PREFIX))
                .is_none_or(|slug| !tally.trashed_sets.iter().any(|set| set == slug))
        })
        .collect();
    if !named.is_empty() {
        println!(
            "intentic: these volumes and networks belong to no sandbox on this machine and were left alone:"
        );
        for name in &named {
            println!("          {name}");
        }
        for (slug, side) in &tally.other_sides {
            println!(
                "          ({slug}'s were made by ic on {}, whose own tidy decides.)",
                side.name()
            );
        }
        if !unattended {
            println!("          If you don't need them: docker volume rm <name>. If you might, they are safe where they are; the machine agent's daily tidy moves unclaimed ones into the trash.");
        }
    }
    for (slug, why, bytes) in &tally.backups {
        println!(
            "intentic: {verb} this side's backups of {slug}{} — {why}.",
            if *bytes > 0 {
                format!(" ({:.1} GB)", *bytes as f64 / 1e9)
            } else {
                String::new()
            }
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_is_ours_only_by_the_families_ic_writes() {
        assert_eq!(
            owner_of("intentic-sandbox-rollback-sandbox-abc:0123456789ab"),
            Some(("sandbox-abc".to_string(), true))
        );
        assert_eq!(
            owner_of("intentic-sandbox-env-sandbox-abc:91a8ec75fa46"),
            Some(("sandbox-abc".to_string(), false))
        );
        // The environment build pinned beside a base is a rollback pin too, and only in that family.
        assert_eq!(
            owner_of("intentic-sandbox-rollback-sandbox-abc:env-91a8ec75fa46"),
            Some(("sandbox-abc".to_string(), true))
        );
        assert_eq!(
            owner_of("intentic-sandbox-env-sandbox-abc:env-91a8ec75fa46"),
            None
        );
        assert_eq!(
            owner_of("intentic-sandbox-rollback-sandbox-abc:env-latest"),
            None
        );
        assert_eq!(
            owner_of("intentic-sandbox-dev-env-sandbox-abc:2238823e9835"),
            Some(("sandbox-abc".to_string(), false))
        );
        // A tag a person made by hand under one of those names is theirs, whatever it is called.
        assert_eq!(
            owner_of("intentic-sandbox-dev-env-sandbox-abc:prefix-rollback-20260922"),
            None
        );
        // The base images, a runner's build under another name, and anything else on the machine are not.
        assert_eq!(owner_of("ghcr.io/intentic/sandbox:stable"), None);
        assert_eq!(owner_of("intentic-sandbox:dev"), None);
        assert_eq!(owner_of("postgres:18"), None);
    }

    #[test]
    fn the_environment_build_a_record_pins_is_kept_with_its_base() {
        let record = ChannelRecord {
            kept: vec![Pin {
                image: "intentic-sandbox-rollback-x:111111111111".to_string(),
                env_image: Some("intentic-sandbox-rollback-x:env-aaaaaaaaaaaa".to_string()),
                env_hash: Some("feed".to_string()),
                ..Pin::default()
            }],
            ..ChannelRecord::default()
        };
        let named: Vec<String> = record.targets().iter().flat_map(Pin::images).collect();
        assert!(in_use(
            "intentic-sandbox-rollback-x:env-aaaaaaaaaaaa",
            "sha256:old-env",
            &[],
            &named
        ));
        assert!(in_use(
            "intentic-sandbox-rollback-x:111111111111",
            "sha256:old-base",
            &[],
            &named
        ));
    }

    #[test]
    fn an_image_in_use_is_one_a_container_runs_or_a_record_names() {
        let used = vec!["sha256:run".to_string()];
        let named = vec!["intentic-sandbox-rollback-x:pin".to_string()];
        assert!(in_use(
            "intentic-sandbox-env-x:a",
            "sha256:run",
            &used,
            &named
        ));
        assert!(in_use(
            "intentic-sandbox-rollback-x:pin",
            "sha256:other",
            &used,
            &named
        ));
        assert!(!in_use(
            "intentic-sandbox-env-x:old",
            "sha256:old",
            &used,
            &named
        ));
    }

    #[test]
    fn all_four_volume_families_and_the_network_are_grouped_by_their_sandbox() {
        let volumes: Vec<(String, String)> = [
            ("intentic-workspace-gone", ""),
            ("intentic-history-gone", ""),
            ("intentic-docker-gone", ""),
            ("intentic-dind-docker-gone", ""),
            ("intentic-workspace-live", ""),
            ("intentic-history-runner-ci", ""),
            ("intentic-workspace-theirs", "linux/ubuntu"),
            ("intentic-trashed-1-old", ""),
            ("intentic-dev-agent-auth", ""),
            ("postgres-data", ""),
        ]
        .iter()
        .map(|(name, label)| (name.to_string(), label.to_string()))
        .collect();
        let networks = vec![
            "bridge".to_string(),
            "intentic-workspace-gone".to_string(),
            "intentic-workspace-netonly".to_string(),
            "intentic-workspace-live".to_string(),
        ];
        let known = |slug: &str| slug == "live";
        let sets = orphans(&volumes, &networks, &known);
        let slugs: Vec<&str> = sets.iter().map(|set| set.slug.as_str()).collect();
        assert_eq!(slugs, vec!["gone", "netonly", "theirs"]);
        assert_eq!(sets[0].volumes.len(), 4, "every family, the dind one too");
        assert_eq!(sets[0].network.as_deref(), Some("intentic-workspace-gone"));
        assert!(sets[1].volumes.is_empty());
        assert_eq!(sets[2].side, Side::parse("linux/ubuntu"));

        let here = Side::new("linux", Some("archlinux"));
        assert_eq!(orphan_fate(&sets[0], false, &here), OrphanFate::Trash);
        assert_eq!(
            orphan_fate(&sets[0], true, &here),
            OrphanFate::Recorded,
            "a record here still claims it"
        );
        assert_eq!(orphan_fate(&sets[1], false, &here), OrphanFate::NetworkOnly);
        assert_eq!(
            orphan_fate(&sets[2], false, &here),
            OrphanFate::OtherSide(Side::new("linux", Some("ubuntu")))
        );
        assert_eq!(
            orphan_fate(&sets[2], false, &Side::new("linux", None)),
            OrphanFate::Trash,
            "a side with no environment cannot tell, and the label's platform is its own"
        );
    }

    #[test]
    fn a_runners_volumes_are_never_tidys() {
        assert_eq!(volume_slug("intentic-workspace-runner-omen"), None);
        assert_eq!(volume_slug("intentic-docker-sandbox-1"), Some("sandbox-1"));
        assert_eq!(volume_slug("intentic-workspace-"), None);
    }

    #[test]
    fn a_record_holding_only_a_report_key_is_told_from_one_that_names_images() {
        let only_key = ChannelRecord {
            report_key: Some("k".to_string()),
            report_platform: Some("https://api.intentic.dev".to_string()),
            written: Some(5),
            side: Some("windows".to_string()),
            ..ChannelRecord::default()
        };
        assert!(report_only(&only_key));
        assert!(!report_only(&ChannelRecord {
            current: Some("ghcr.io/intentic/sandbox:stable".to_string()),
            ..only_key.clone()
        }));
        assert!(!report_only(&ChannelRecord {
            previous: Some("pin".to_string()),
            ..only_key
        }));
    }

    #[test]
    fn the_archive_keeps_a_record_ninety_days() {
        assert!(!archive_expired(0, 89 * DAY_MS));
        assert!(archive_expired(0, 90 * DAY_MS));
    }

    #[test]
    fn a_backup_goes_only_when_it_is_a_stale_duplicate_or_its_sandbox_is_long_gone() {
        let now = 1_791_240_330_000;
        let wsl = Side::new("linux", Some("archlinux"));
        // rog: a Windows-side backup of a WSL-kept sandbox, made before the side split; WSL has backed it up since.
        assert!(matches!(
            backup_fate(
                &Standing::Theirs(wsl.clone()),
                Some(now - 40 * DAY_MS),
                Some((wsl.clone(), now - DAY_MS)),
                None,
                now
            ),
            BackupFate::Remove(_)
        ));
        // The keeper has not backed it up since: this side's may be the only copy.
        assert!(matches!(
            backup_fate(
                &Standing::Theirs(wsl.clone()),
                Some(now - DAY_MS),
                Some((wsl.clone(), now - 2 * DAY_MS)),
                None,
                now
            ),
            BackupFate::Keep(_)
        ));
        assert!(matches!(
            backup_fate(
                &Standing::Theirs(wsl.clone()),
                Some(now - DAY_MS),
                None,
                None,
                now
            ),
            BackupFate::Keep(_)
        ));
        // Within the margin of two clocks: kept.
        assert!(matches!(
            backup_fate(
                &Standing::Theirs(wsl.clone()),
                Some(now - DAY_MS),
                Some((wsl.clone(), now - DAY_MS + 60_000)),
                None,
                now
            ),
            BackupFate::Keep(_)
        ));
        // Another side's backup.json, not the keeper's: proves nothing about the keeper's copy.
        assert!(matches!(
            backup_fate(
                &Standing::Theirs(wsl.clone()),
                Some(now - 40 * DAY_MS),
                Some((Side::new("windows", Some("windows")), now)),
                None,
                now
            ),
            BackupFate::Keep(_)
        ));
        // Ours, unknown, trashed: always kept.
        for standing in [Standing::Ours, Standing::Unknown, Standing::Trashed] {
            assert!(matches!(
                backup_fate(&standing, Some(0), None, Some(0), now),
                BackupFate::Keep(_)
            ));
        }
        // Gone: thirty days from the later of its archiving and the last backup.
        assert!(matches!(
            backup_fate(
                &Standing::Gone,
                Some(now - 31 * DAY_MS),
                None,
                Some(now - 40 * DAY_MS),
                now
            ),
            BackupFate::Remove(_)
        ));
        assert!(matches!(
            backup_fate(
                &Standing::Gone,
                Some(now - 40 * DAY_MS),
                None,
                Some(now - 10 * DAY_MS),
                now
            ),
            BackupFate::Keep(_)
        ));
        assert!(matches!(
            backup_fate(
                &Standing::Gone,
                Some(now - 5 * DAY_MS),
                None,
                Some(now - 40 * DAY_MS),
                now
            ),
            BackupFate::Keep(_)
        ));
        assert!(matches!(
            backup_fate(&Standing::Gone, None, None, None, now),
            BackupFate::Keep(_)
        ));
    }
}
