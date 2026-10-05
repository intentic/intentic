use serde_json::{json, Map, Value};

use crate::docker;
use crate::record::{self, ChannelRecord, Pin};
use crate::sandbox::recreate::DEFAULT_REGISTRY;
use crate::sandbox::{container_of, mirror, resolve_slug};
use crate::util::{bail, Result};

/* THE WAYS BACK A SANDBOX HAS ON THIS MACHINE: `previous`, which `ic sandbox rollback` returns to, and up to
record::MAX_KEPT older builds behind it, each a whole image pinned under a tag no other flow writes, so a routine
`docker image prune` leaves it alone. */

/// The rollback targets after a swap moves this sandbox onto `target_image`, leaving `left` (the pin of the base it
/// ran, when that identity is known): what `previous` and `kept` become, and the pins nothing names any more.
///
/// A rollback SWAPS: the build being left becomes `previous`, so pressing it twice goes forward again, and the build
/// moved onto leaves the list. An update pushes the old `previous` down into `kept`. An unknown or unchanged identity
/// (`left` None) keeps the list, rather than inventing a target. Pure.
pub fn next_targets(
    saved: &ChannelRecord,
    left: Option<Pin>,
    target_image: &str,
    max_kept: usize,
) -> (Option<Pin>, Vec<Pin>, Vec<String>) {
    let mut all: Vec<Pin> = Vec::new();
    for pin in left.into_iter().chain(saved.targets()) {
        if pin.image != target_image && !all.iter().any(|seen| seen.image == pin.image) {
            all.push(pin);
        }
    }
    let mut rest = all.into_iter();
    let previous = rest.next();
    let kept: Vec<Pin> = rest.by_ref().take(max_kept).collect();
    let dropped: Vec<String> = rest.map(|pin| pin.image).collect();
    (previous, kept, dropped)
}

/// The record with the target `image` taken off its rollback list: a pin whose image is gone, once a rollback has
/// gone back to the release it was instead. Pure.
pub fn without(record: &ChannelRecord, image: &str) -> ChannelRecord {
    let mut rest = record
        .targets()
        .into_iter()
        .filter(|pin| pin.image != image);
    let previous = rest.next();
    ChannelRecord {
        previous: previous.as_ref().map(|pin| pin.image.clone()),
        previous_version: previous.and_then(|pin| pin.version),
        kept: rest.collect(),
        ..record.clone()
    }
}

/// Which kept build `to` names: a version, a whole image reference, or the short id a pin tag ends with. Pure.
pub fn find_target<'a>(targets: &'a [Pin], to: &str) -> Option<&'a Pin> {
    targets.iter().find(|pin| {
        pin.version.as_deref() == Some(to)
            || pin.image == to
            || pin.image.rsplit(':').next() == Some(to)
    })
}

/// Three dot-separated numbers, optionally with a prerelease or build suffix: a release `ic` can pull by its tag.
pub fn is_version(value: &str) -> bool {
    let core = value.trim_start_matches('v');
    let core = core.split_once(['-', '+']).map_or(core, |(core, _)| core);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// The target `ic sandbox rollback --to <to>` moves onto: a kept build when one matches, else the published image of
/// that release (every release is also tagged by its version, and a published reference is taken as it is), which is
/// pulled like any update.
pub fn resolve_to(record: &ChannelRecord, to: &str) -> Result<Pin> {
    if let Some(pin) = find_target(&record.targets(), to) {
        return Ok(pin.clone());
    }
    if is_version(to) {
        let version = to.trim_start_matches('v');
        return Ok(Pin {
            image: format!("{DEFAULT_REGISTRY}:{version}"),
            version: Some(version.to_string()),
        });
    }
    if to
        .strip_prefix(&format!("{DEFAULT_REGISTRY}:"))
        .is_some_and(|tag| !tag.is_empty())
    {
        return Ok(Pin {
            image: to.to_string(),
            version: None,
        });
    }
    let kept: Vec<String> = record
        .targets()
        .iter()
        .map(|pin| pin.version.clone().unwrap_or_else(|| pin.image.clone()))
        .collect();
    bail!(
        "nothing kept on this machine matches {to}, and it is not a release version to download.\n       Kept: {}",
        if kept.is_empty() { "nothing".to_string() } else { kept.join(", ") }
    );
}

/* A PIN DELETED OUTSIDE ic. The rollback tags are local-only (`intentic-sandbox-rollback-<slug>:<id>`), so a person's
`docker image prune -a` takes the image and leaves the record naming it, and a rollback then "pulled" a tag no registry
ever had (audit 2026-10, item 19). A pin whose image is gone is reached again through its version, since every release
is also published under its version tag; a pin that names neither a local image nor a version is no way back at all,
and is no longer offered as one. */

/// What a rollback to `pin` would run: the pinned image while this machine holds it, a published reference as it is,
/// else the release its version names; None when nothing can be had. Pure.
pub fn reachable(pin: &Pin, on_machine: bool) -> Option<String> {
    if on_machine || !crate::sandbox::connect::is_registryless(&pin.image) {
        return Some(pin.image.clone());
    }
    pin.version
        .as_deref()
        .filter(|version| is_version(version))
        .map(|version| format!("{DEFAULT_REGISTRY}:{}", version.trim_start_matches('v')))
}

/// The rollback targets that can still be had, newest first, each as what a rollback would run. Pure over `on_machine`.
pub fn reachable_targets(record: &ChannelRecord, on_machine: &dyn Fn(&str) -> bool) -> Vec<Pin> {
    record
        .targets()
        .into_iter()
        .filter_map(|pin| {
            reachable(&pin, on_machine(&pin.image)).map(|image| Pin {
                image,
                version: pin.version,
            })
        })
        .collect()
}

/// The listing's `rollbackTargets` (DeviceSandboxSchema): newest first, as JSON, only the ones a rollback can reach.
/// `download` marks one whose pinned image is gone, which a rollback downloads by its version. Pure over `on_machine`.
pub fn targets_json(record: &ChannelRecord, on_machine: &dyn Fn(&str) -> bool) -> Value {
    Value::Array(
        reachable_targets(record, on_machine)
            .into_iter()
            .map(|pin| {
                let mut entry = Map::new();
                if !on_machine(&pin.image) {
                    entry.insert("download".into(), json!(true));
                }
                entry.insert("image".into(), json!(pin.image));
                if let Some(version) = pin.version {
                    entry.insert("version".into(), json!(version));
                }
                Value::Object(entry)
            })
            .collect(),
    )
}

/// `ic sandbox versions [slug] [--json]` — what this sandbox runs and every version it can go back to without a
/// download (read-only).
pub fn run(slug: Option<String>, as_json: bool) -> Result<()> {
    docker::require_daemon()?;
    let slug = resolve_slug(slug, "ic sandbox versions")?;
    let record = mirror::reconcile(&slug);
    let running = docker::inspect(&container_of(&slug), "{{.Config.Image}}");
    if as_json {
        let mut out = Map::new();
        out.insert("slug".into(), json!(slug));
        let mut current = Map::new();
        if let Some(image) = running.clone().or_else(|| record.current.clone()) {
            current.insert("image".into(), json!(image));
        }
        if let Some(version) = &record.current_version {
            current.insert("version".into(), json!(version));
        }
        out.insert("current".into(), Value::Object(current));
        out.insert(
            "targets".into(),
            targets_json(&record, &|image| docker::image_exists(image)),
        );
        if let Some(until) = record.swap.as_ref().and_then(|swap| swap.until) {
            out.insert("probationUntil".into(), json!(until));
        }
        println!("{}", Value::Object(out));
        return Ok(());
    }
    println!(
        "intentic: {slug} runs {}{}.",
        running
            .or_else(|| record.current.clone())
            .unwrap_or_else(|| "an image this ic has no record of".to_string()),
        record
            .current_version
            .as_deref()
            .map(|version| format!(" ({version})"))
            .unwrap_or_default()
    );
    let targets: Vec<(Pin, bool)> = record
        .targets()
        .into_iter()
        .map(|pin| {
            let here = docker::image_exists(&pin.image);
            (pin, here)
        })
        .collect();
    if targets.is_empty() {
        println!(
            "          Nothing is kept to go back to yet: the next update keeps what runs now."
        );
    }
    for (index, (pin, here)) in targets.iter().enumerate() {
        let label = if index == 0 {
            "rollback goes back to"
        } else {
            "also kept"
        };
        // A pin is a local tag no registry has: once its image is gone, only its version brings it back.
        let note = match (here, reachable(pin, *here)) {
            (true, _) => String::new(),
            (false, Some(source)) => {
                format!(" — its pinned image is gone from this machine, so {source} is downloaded instead")
            }
            (false, None) => " — its image is gone from this machine and it names no version to download, so it can no longer be gone back to".to_string(),
        };
        println!(
            "          {label}: {}{note}",
            pin.version.as_deref().unwrap_or("an unnamed build"),
        );
    }
    if let Some(swap) = record
        .swap
        .as_ref()
        .filter(|swap| swap.phase == record::Phase::Probation)
    {
        if let Some(until) = swap.until {
            println!(
                "          The version before this update is parked and ready for {} more.",
                crate::sandbox::probation::remaining(until)
            );
        }
    }
    println!(
        "          Go back with: ic sandbox rollback {slug}   (or --to <version> for an older one)"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(image: &str, version: &str) -> Pin {
        Pin {
            image: image.to_string(),
            version: Some(version.to_string()),
        }
    }

    fn with_targets(previous: Option<Pin>, kept: Vec<Pin>) -> ChannelRecord {
        ChannelRecord {
            previous: previous.as_ref().map(|pin| pin.image.clone()),
            previous_version: previous.and_then(|pin| pin.version),
            kept,
            ..ChannelRecord::default()
        }
    }

    #[test]
    fn an_update_keeps_what_ran_first_and_pushes_the_rest_down_dropping_the_oldest() {
        let saved = with_targets(
            Some(pin("pin:b", "1.2.0")),
            vec![pin("pin:a", "1.1.0"), pin("pin:z", "1.0.0")],
        );
        let (previous, kept, dropped) = next_targets(
            &saved,
            Some(pin("pin:c", "1.3.0")),
            "ghcr.io/intentic/sandbox:stable",
            2,
        );
        assert_eq!(previous, Some(pin("pin:c", "1.3.0")));
        assert_eq!(kept, vec![pin("pin:b", "1.2.0"), pin("pin:a", "1.1.0")]);
        assert_eq!(dropped, vec!["pin:z".to_string()]);
    }

    #[test]
    fn a_rollback_swaps_so_pressing_it_twice_goes_forward_again() {
        let saved = with_targets(Some(pin("pin:b", "1.2.0")), vec![pin("pin:a", "1.1.0")]);
        // Running c, going back to b: c becomes the way forward, b leaves the list, a stays.
        let (previous, kept, dropped) =
            next_targets(&saved, Some(pin("pin:c", "1.3.0")), "pin:b", 2);
        assert_eq!(previous, Some(pin("pin:c", "1.3.0")));
        assert_eq!(kept, vec![pin("pin:a", "1.1.0")]);
        assert!(dropped.is_empty());
        // And back again.
        let after = with_targets(previous, kept);
        let (previous, kept, _) = next_targets(&after, Some(pin("pin:b", "1.2.0")), "pin:c", 2);
        assert_eq!(previous, Some(pin("pin:b", "1.2.0")));
        assert_eq!(kept, vec![pin("pin:a", "1.1.0")]);
    }

    #[test]
    fn going_back_further_takes_that_build_out_of_the_list_and_keeps_the_rest() {
        let saved = with_targets(
            Some(pin("pin:b", "1.2.0")),
            vec![pin("pin:a", "1.1.0"), pin("pin:z", "1.0.0")],
        );
        let (previous, kept, dropped) =
            next_targets(&saved, Some(pin("pin:c", "1.3.0")), "pin:a", 2);
        assert_eq!(previous, Some(pin("pin:c", "1.3.0")));
        assert_eq!(kept, vec![pin("pin:b", "1.2.0"), pin("pin:z", "1.0.0")]);
        assert!(dropped.is_empty());
    }

    #[test]
    fn an_unknown_identity_keeps_the_list_and_a_short_disk_keeps_only_previous() {
        let saved = with_targets(Some(pin("pin:b", "1.2.0")), vec![pin("pin:a", "1.1.0")]);
        let (previous, kept, dropped) = next_targets(&saved, None, "img:new", 2);
        assert_eq!(
            (previous, kept, dropped.len()),
            (Some(pin("pin:b", "1.2.0")), vec![pin("pin:a", "1.1.0")], 0)
        );
        let (previous, kept, dropped) =
            next_targets(&saved, Some(pin("pin:c", "1.3.0")), "img:new", 0);
        assert_eq!(previous, Some(pin("pin:c", "1.3.0")));
        assert!(kept.is_empty());
        assert_eq!(dropped, vec!["pin:b".to_string(), "pin:a".to_string()]);
    }

    #[test]
    fn a_target_is_found_by_its_version_its_image_or_its_short_id() {
        let targets = vec![pin("intentic-sandbox-rollback-x:0123456789ab", "1.2.0")];
        assert!(find_target(&targets, "1.2.0").is_some());
        assert!(find_target(&targets, "intentic-sandbox-rollback-x:0123456789ab").is_some());
        assert!(find_target(&targets, "0123456789ab").is_some());
        assert!(find_target(&targets, "1.2.1").is_none());
    }

    #[test]
    fn a_version_nobody_kept_is_downloaded_by_its_release_tag_and_anything_else_is_refused() {
        let record = with_targets(Some(pin("pin:b", "1.2.0")), Vec::new());
        assert_eq!(resolve_to(&record, "1.2.0").unwrap().image, "pin:b");
        assert_eq!(
            resolve_to(&record, "1.1.0").unwrap(),
            pin("ghcr.io/intentic/sandbox:1.1.0", "1.1.0")
        );
        assert_eq!(
            resolve_to(&record, "v1.1.0").unwrap().image,
            "ghcr.io/intentic/sandbox:1.1.0"
        );
        assert_eq!(
            resolve_to(&record, "ghcr.io/intentic/sandbox:1.1.0")
                .unwrap()
                .image,
            "ghcr.io/intentic/sandbox:1.1.0",
            "what the listing offers for a pin whose image is gone"
        );
        let refused = resolve_to(&record, "yesterday").unwrap_err();
        assert!(refused.0.contains("Kept: 1.2.0"), "{}", refused.0);
    }

    #[test]
    fn a_pin_gone_back_past_leaves_the_list_and_the_rest_move_up() {
        let saved = with_targets(
            Some(pin("pin:b", "1.2.0")),
            vec![pin("pin:a", "1.1.0"), pin("pin:z", "1.0.0")],
        );
        let rest = without(&saved, "pin:b");
        assert_eq!(rest.previous.as_deref(), Some("pin:a"));
        assert_eq!(rest.previous_version.as_deref(), Some("1.1.0"));
        assert_eq!(rest.kept, vec![pin("pin:z", "1.0.0")]);
        assert_eq!(without(&saved, "pin:q"), saved);
    }

    #[test]
    fn a_pin_whose_image_was_pruned_is_reached_through_its_version_or_not_offered() {
        let local = pin("intentic-sandbox-rollback-x:0123456789ab", "1.2.0");
        assert_eq!(
            reachable(&local, true).as_deref(),
            Some("intentic-sandbox-rollback-x:0123456789ab")
        );
        assert_eq!(
            reachable(&local, false).as_deref(),
            Some("ghcr.io/intentic/sandbox:1.2.0")
        );
        let nameless = Pin {
            image: "intentic-sandbox-rollback-x:fedcba987654".to_string(),
            version: None,
        };
        assert_eq!(reachable(&nameless, false), None);
        // An older record named the registry's own tag: pulled as it is.
        let published = Pin {
            image: "ghcr.io/intentic/sandbox:1.1.0".to_string(),
            version: None,
        };
        assert_eq!(
            reachable(&published, false).as_deref(),
            Some("ghcr.io/intentic/sandbox:1.1.0")
        );
        let record = with_targets(Some(local), vec![nameless]);
        let gone = |_: &str| false;
        assert_eq!(
            targets_json(&record, &gone),
            json!([{ "image": "ghcr.io/intentic/sandbox:1.2.0", "version": "1.2.0", "download": true }])
        );
        let all_here = |_: &str| true;
        assert_eq!(
            targets_json(&record, &all_here).as_array().map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn a_release_version_is_three_numbers_with_an_optional_suffix() {
        assert!(is_version("1.316.0") && is_version("v1.316.0") && is_version("1.316.0-rc.1"));
        assert!(!is_version("1.316") && !is_version("stable") && !is_version("1.x.0"));
    }
}
