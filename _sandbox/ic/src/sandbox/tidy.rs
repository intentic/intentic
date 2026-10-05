use serde_json::{json, Value};

use crate::docker;
use crate::logfile::intentic_home;
use crate::record;
use crate::sandbox::{container_of, live_slugs, parked_of, trash};
use crate::util::{bail, Result};

/* WHAT UPDATES LEAVE BEHIND, cleared. Every overlay rebuild tags a new image and leaves the one before it dangling,
every removed sandbox leaves its environment builds and rollback pins, and every channel record outlives its sandbox.
On a machine that has hosted a dozen sandboxes that is tens of gigabytes, and a full disk is how the NEXT update
fails. `ic sandbox tidy` removes what nothing on this machine can use any more; it never deletes a volume: data
without a sandbox is reported, for a person to trash or keep. */

/// The image families ic builds or pins per sandbox: `<prefix><slug>:<tag>`.
const FAMILIES: [&str; 3] = [
    "intentic-sandbox-rollback-",
    "intentic-sandbox-dev-env-",
    "intentic-sandbox-env-",
];

/// The sandbox an image of ours belongs to, and whether it is a rollback pin. Only the tags ic itself writes (twelve hex
/// characters of an id or a recipe hash) count: a tag a person made under the same name is theirs to remove. Pure.
pub fn owner_of(reference: &str) -> Option<(String, bool)> {
    let (repository, tag) = reference.rsplit_once(':')?;
    if tag.len() != 12 || !tag.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    FAMILIES.iter().find_map(|prefix| {
        repository
            .strip_prefix(prefix)
            .filter(|slug| !slug.is_empty())
            .map(|slug| (slug.to_string(), prefix.contains("rollback")))
    })
}

/// Whether an image of a sandbox that still exists is still of use: what its containers run (live or parked), a
/// rollback target the record (or the pre-swap record) names, or the build a prepare left waiting. Pure.
pub fn in_use(reference: &str, id: &str, used_ids: &[String], named: &[String]) -> bool {
    used_ids.iter().any(|used| used == id) || named.iter().any(|name| name == reference)
}

/// `ic sandbox tidy [--dry-run] [--json]`.
pub fn run(dry_run: bool, as_json: bool) -> Result<()> {
    docker::require_daemon()?;
    let Some(live) = live_slugs() else {
        bail!("docker could not list this machine's sandboxes, so nothing was removed.");
    };
    let trashed: Vec<String> = trash::list().into_iter().map(|entry| entry.slug).collect();
    // The trash's own overdue entries go first, as every other verb that touches sandboxes does.
    let purged = if dry_run { Vec::new() } else { trash::sweep() };
    let known = |slug: &str| live.iter().any(|l| l == slug) || trashed.iter().any(|t| t == slug);

    let listing = docker::try_capture(&["images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"])
        .unwrap_or_default();
    let mut removable: Vec<String> = Vec::new();
    let mut elsewhere_checked: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    for line in listing.lines() {
        let Some((reference, short_id)) = line.split_once(' ') else {
            continue;
        };
        let Some((slug, _pin)) = owner_of(reference) else {
            continue;
        };
        if !known(&slug) {
            removable.push(reference.to_string());
            continue;
        }
        // Which of the other side's images are still of use is in that side's record, not this one's: its own tidy
        // decides (side.rs). Without this, each side deleted the rollback images only the other side's record named.
        if !elsewhere_checked.contains_key(&slug) {
            let side = super::side::kept_elsewhere(&slug);
            elsewhere_checked.insert(slug.clone(), side);
        }
        if elsewhere_checked.get(&slug).is_some_and(Option::is_some) {
            continue;
        }
        let used_ids: Vec<String> = [container_of(&slug), parked_of(&slug)]
            .iter()
            .filter_map(|container| docker::inspect(container, "{{.Image}}"))
            .collect();
        let mut named: Vec<String> = Vec::new();
        for rec in [
            record::read(&slug).ok(),
            record::read_before(&slug).ok().flatten(),
        ]
        .into_iter()
        .flatten()
        {
            named.extend(rec.targets().into_iter().map(|pin| pin.image));
            named.extend(rec.staged.clone());
            named.extend(rec.current.clone());
        }
        let id = docker::image_id(reference).unwrap_or_else(|| short_id.to_string());
        if !in_use(reference, &id, &used_ids, &named) {
            removable.push(reference.to_string());
        }
    }
    let mut removed: Vec<String> = Vec::new();
    if !dry_run {
        for reference in &removable {
            // Never -f: an image a container still uses is refused, which is the right answer for anything missed.
            if docker::ok(&["rmi", reference]) {
                removed.push(reference.clone());
            }
        }
    }

    // Records of sandboxes that are gone, moved aside rather than deleted: a record names a rollback target.
    let mut archived: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(intentic_home()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(slug) = name
                .strip_prefix("sandbox-")
                .and_then(|rest| rest.strip_suffix(".channel"))
            else {
                continue;
            };
            if known(slug) {
                continue;
            }
            archived.push(slug.to_string());
            if !dry_run {
                let archive = intentic_home().join("records-archive");
                let _ = std::fs::create_dir_all(&archive);
                let _ = std::fs::rename(entry.path(), archive.join(&name));
                let _ = std::fs::rename(
                    record::before_path(slug),
                    archive.join(format!("{name}.before")),
                );
            }
        }
    }

    // Volumes whose sandbox is neither here nor in the trash: named, never deleted.
    let volumes =
        docker::try_capture(&["volume", "ls", "--format", "{{.Name}}"]).unwrap_or_default();
    let orphans: Vec<String> = volumes
        .lines()
        .filter_map(|volume| {
            ["intentic-workspace-", "intentic-history-"]
                .iter()
                .find_map(|prefix| volume.strip_prefix(prefix))
                .filter(|slug| !slug.starts_with("runner-") && !known(slug))
                .map(|_| volume.to_string())
        })
        .collect();

    if as_json {
        let report: Value = json!({
            "dryRun": dry_run,
            "images": if dry_run { removable.clone() } else { removed.clone() },
            "records": archived,
            "purgedFromTrash": purged,
            "orphanVolumes": orphans,
        });
        println!("{report}");
        return Ok(());
    }
    let verb = if dry_run { "would remove" } else { "removed" };
    let images = if dry_run { &removable } else { &removed };
    println!(
        "intentic: tidy {verb} {} image(s) no sandbox here can use.",
        images.len()
    );
    for image in images {
        println!("          {image}");
    }
    if !archived.is_empty() {
        println!(
            "intentic: {} record(s) of sandboxes that are gone {} to {}.",
            archived.len(),
            if dry_run { "would move" } else { "moved" },
            intentic_home().join("records-archive").display()
        );
    }
    if !purged.is_empty() {
        println!(
            "intentic: deleted {} sandbox(es) whose recovery window ran out: {}.",
            purged.len(),
            purged.join(", ")
        );
    }
    if !orphans.is_empty() {
        println!(
            "intentic: these volumes belong to no sandbox on this machine and were left alone:"
        );
        for volume in &orphans {
            println!("          {volume}");
        }
        println!("          If you don't need them: docker volume rm <name>. If you might, they are safe where they are.");
    }
    Ok(())
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
}
