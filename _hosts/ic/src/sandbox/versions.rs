use serde_json::{json, Map, Value};

use crate::docker;
use crate::record::{self, ChannelRecord, Pin};
use crate::sandbox::recreate::DEFAULT_REGISTRY;
use crate::sandbox::{container_of, mirror, resolve_slug};
use crate::ui;
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
        kept: rest.collect(),
        ..record.with_previous(previous.as_ref())
    }
}

/// One way back: the kept pin, and the image a rollback onto it runs (`reachable`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WayBack {
    pub pin: Pin,
    pub image: String,
}

/// THE WAYS BACK this sandbox has, newest first: every kept pin a rollback can still reach, each once, since two pruned
/// pins of one release are one download. The one list the listing offers, a plain rollback takes the first of, and
/// `--to` is matched against, so a menu row and the rollback it starts cannot name different builds (2026-10: a version
/// matched a pruned pin the menu had already hidden, and a plain rollback took a `previous` the menu never listed).
/// Pure over `on_machine`.
pub fn ways_back(record: &ChannelRecord, on_machine: &dyn Fn(&str) -> bool) -> Vec<WayBack> {
    let mut ways: Vec<WayBack> = Vec::new();
    for pin in record.targets() {
        if let Some(image) = reachable(&pin, on_machine(&pin.image)) {
            if !ways.iter().any(|way| way.image == image) {
                ways.push(WayBack { pin, image });
            }
        }
    }
    ways
}

/// Which way back `to` names: exactly, by the image the listing offers for it, its pin's own image or the short id that
/// tag ends with; else by its version, the newest way back carrying it. Pure.
pub fn find_way<'a>(ways: &'a [WayBack], to: &str) -> Option<&'a WayBack> {
    ways.iter()
        .find(|way| {
            way.image == to || way.pin.image == to || way.pin.image.rsplit(':').next() == Some(to)
        })
        .or_else(|| {
            ways.iter()
                .find(|way| way.pin.version.as_deref() == Some(to))
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

/// What every build from a checkout says it is: never published, so no registry has an image under it.
const DEV_VERSION: &str = "0.0.0";

/// A release version the registry publishes an image under: a version, and not the one every dev build says. Pure.
pub fn is_published(value: &str) -> bool {
    is_version(value) && value.trim_start_matches('v') != DEV_VERSION
}

/// The way back `ic sandbox rollback --to <to>` takes: one of `ways` when one matches, else the published image of that
/// release (every release is also tagged by its version, and a published reference is taken as it is), which is pulled
/// like any update.
pub fn resolve_to(ways: &[WayBack], to: &str) -> Result<WayBack> {
    if let Some(way) = find_way(ways, to) {
        return Ok(way.clone());
    }
    let published = |image: String, version: Option<String>| WayBack {
        pin: Pin {
            image: image.clone(),
            version,
            ..Pin::default()
        },
        image,
    };
    if is_published(to) {
        let version = to.trim_start_matches('v');
        return Ok(published(
            format!("{DEFAULT_REGISTRY}:{version}"),
            Some(version.to_string()),
        ));
    }
    if to
        .strip_prefix(&format!("{DEFAULT_REGISTRY}:"))
        .is_some_and(|tag| !tag.is_empty())
    {
        return Ok(published(to.to_string(), None));
    }
    let kept: Vec<String> = ways
        .iter()
        .map(|way| way.pin.version.clone().unwrap_or_else(|| way.image.clone()))
        .collect();
    bail!(
        "{}",
        ui::explain(
            &format!("Nothing kept on this device matches {to}, and it is not a release version to download."),
            Some(&format!(
                "kept: {}.",
                if kept.is_empty() { "nothing".to_string() } else { kept.join(", ") }
            )),
            Some("ic sandbox versions"),
        )
    );
}

/* A PIN DELETED OUTSIDE ic. The rollback tags are local-only (`intentic-sandbox-rollback-<slug>:<id>`), so a person's
`docker image prune -a` takes the image and leaves the record naming it, and a rollback then "pulled" a tag no registry
ever had (audit 2026-10, item 19). A pin whose image is gone is reached again through its version, since every release
is also published under its version tag; a pin that names neither a local image nor a version is no way back at all,
and is no longer offered as one. Nor is a dev build's (2026-10-19): it says 0.0.0, which no registry publishes, and
several pruned ones each offered the same download of it, three menu rows of "0.0.0" none of which could be had. */

/// What a rollback to `pin` would run: the pinned image while this machine holds it, a published reference as it is,
/// else the release its version names; None when nothing can be had. Pure.
pub fn reachable(pin: &Pin, on_machine: bool) -> Option<String> {
    if on_machine || !crate::sandbox::connect::is_registryless(&pin.image) {
        return Some(pin.image.clone());
    }
    pin.version
        .as_deref()
        .filter(|version| is_published(version))
        .map(|version| format!("{DEFAULT_REGISTRY}:{}", version.trim_start_matches('v')))
}

/* THE ENVIRONMENT BUILD KEPT BESIDE A PIN. A rollback used to rebuild today's approved recipe on the pinned base, so a
recipe that no longer builds (a broken capability fragment, a package gone from its mirror) made going back impossible
exactly when it was needed. The build the sandbox actually ran on that base is pinned with it, and run as it is. */

/// The environment build a rollback onto `pin` runs as it is, and the hash its container carries: the one pinned
/// beside that base, while this machine still holds both. None sends the rollback down the older road, rebuilding today's
/// approved recipe on `target`: when the pinned base is gone and its release is run instead (`reachable`), and when the
/// sandbox has no approved recipe any more, since the owner removed what that build installs. Pure over `on_machine`.
pub fn pinned_environment(
    pin: &Pin,
    target: &str,
    has_recipe: bool,
    on_machine: &dyn Fn(&str) -> bool,
) -> Option<(String, String)> {
    let image = pin.env_image.as_ref()?;
    let hash = pin.env_hash.as_ref()?;
    (has_recipe && target == pin.image && on_machine(image)).then(|| (image.clone(), hash.clone()))
}

/// The listing's `rollbackTargets` (DeviceSandboxSchema): the ways back, as JSON. `download` marks one whose pinned image
/// is gone, which a rollback downloads by its version. Pure over `on_machine`.
pub fn targets_json(record: &ChannelRecord, on_machine: &dyn Fn(&str) -> bool) -> Value {
    Value::Array(
        ways_back(record, on_machine)
            .into_iter()
            .map(|way| {
                let mut entry = Map::new();
                if !on_machine(&way.image) {
                    entry.insert("download".into(), json!(true));
                }
                entry.insert("image".into(), json!(way.image));
                if let Some(version) = way.pin.version {
                    entry.insert("version".into(), json!(version));
                }
                Value::Object(entry)
            })
            .collect(),
    )
}

/// One way back as a report row: the version, which way back it is, and whether its image is still on this device.
/// Pure.
fn target_item(index: usize, pin: &Pin, here: bool) -> ui::Item {
    let label = if index == 0 {
        "rollback goes back to this"
    } else {
        "also kept"
    };
    // A pin is a local tag no registry has: once its image is gone, only its version brings it back.
    let (tone, meta) = match (here, reachable(pin, here)) {
        (true, _) => (ui::Tone::Ok, label.to_string()),
        (false, Some(source)) => (
            ui::Tone::Warn,
            format!("{label}; its image is gone from this device, so {source} is downloaded instead"),
        ),
        (false, None) => (
            ui::Tone::Fail,
            "its image is gone from this device and it names no version to download, so it is no way back".to_string(),
        ),
    };
    ui::Item::new(
        tone,
        pin.version
            .as_deref()
            .unwrap_or("an unnamed build")
            .to_string(),
        meta,
    )
}

/// `ic sandbox versions [slug] [--json]` — what this sandbox runs and every version it can go back to without a
/// download (read-only).
pub fn run(slug: Option<String>, as_json: bool) -> Result<()> {
    docker::require_daemon()?;
    let slug = resolve_slug(slug, "ic sandbox versions")?;
    let running = docker::inspect(&container_of(&slug), "{{.Config.Image}}");
    // A name this device has never had answers as one, not with an empty history that reads like a real sandbox's.
    if running.is_none() && !super::list_slugs().contains(&slug) {
        bail!("{}", super::missing(&slug));
    }
    let record = mirror::reconcile(&slug);
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
        // allow(terminal-output): the --json answer, one line the desktop app and the machine agent read.
        println!("{}", Value::Object(out));
        return Ok(());
    }
    let runs = running
        .or_else(|| record.current.clone())
        .unwrap_or_else(|| "an image this ic has no record of".to_string());
    ui::report(
        &format!("intentic · {slug} versions"),
        Some(&format!(
            "runs {runs}{}",
            record
                .current_version
                .as_deref()
                .map(|version| format!(" ({version})"))
                .unwrap_or_default()
        )),
    );
    ui::plain(&format!(
        "intentic: {slug} runs {runs}{}.",
        record
            .current_version
            .as_deref()
            .map(|version| format!(" ({version})"))
            .unwrap_or_default()
    ));
    let targets: Vec<(Pin, bool)> = record
        .targets()
        .into_iter()
        .map(|pin| {
            let here = docker::image_exists(&pin.image);
            (pin, here)
        })
        .collect();
    if targets.is_empty() {
        ui::quiet("Nothing is kept to go back to yet: the next update keeps what runs now.");
    }
    let rows: Vec<ui::Item> = targets
        .iter()
        .enumerate()
        .map(|(index, (pin, here))| target_item(index, pin, *here))
        .collect();
    ui::items(&rows);
    if let Some(swap) = record
        .swap
        .as_ref()
        .filter(|swap| swap.phase == record::Phase::Probation)
    {
        if let Some(until) = swap.until {
            ui::note(&format!(
                "The version before this update is parked and ready for {} more.",
                crate::sandbox::probation::remaining(until)
            ));
        }
    }
    if !targets.is_empty() {
        ui::later(&[
            ("go back".to_string(), format!("ic sandbox rollback {slug}")),
            (
                "go back further".to_string(),
                format!("ic sandbox rollback {slug} --to <version>"),
            ),
        ]);
        ui::plain(&format!(
            "Go back with: ic sandbox rollback {slug}   (or --to <version> for an older one)"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(image: &str, version: &str) -> Pin {
        Pin {
            image: image.to_string(),
            version: Some(version.to_string()),
            ..Pin::default()
        }
    }

    fn with_targets(previous: Option<Pin>, kept: Vec<Pin>) -> ChannelRecord {
        ChannelRecord {
            kept,
            ..ChannelRecord::default()
        }
        .with_previous(previous.as_ref())
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
    fn a_way_back_is_found_by_its_image_its_short_id_or_its_version() {
        let record = with_targets(
            Some(pin("intentic-sandbox-rollback-x:0123456789ab", "1.2.0")),
            vec![],
        );
        let ways = ways_back(&record, &|_| true);
        assert!(find_way(&ways, "1.2.0").is_some());
        assert!(find_way(&ways, "intentic-sandbox-rollback-x:0123456789ab").is_some());
        assert!(find_way(&ways, "0123456789ab").is_some());
        assert!(find_way(&ways, "1.2.1").is_none());
    }

    #[test]
    fn a_version_nobody_kept_is_downloaded_by_its_release_tag_and_anything_else_is_refused() {
        let ways = ways_back(
            &with_targets(Some(pin("pin:b", "1.2.0")), Vec::new()),
            &|_| true,
        );
        assert_eq!(resolve_to(&ways, "1.2.0").unwrap().image, "pin:b");
        let release = resolve_to(&ways, "1.1.0").unwrap();
        assert_eq!(release.pin, pin("ghcr.io/intentic/sandbox:1.1.0", "1.1.0"));
        assert_eq!(release.image, "ghcr.io/intentic/sandbox:1.1.0");
        assert_eq!(
            resolve_to(&ways, "v1.1.0").unwrap().image,
            "ghcr.io/intentic/sandbox:1.1.0"
        );
        assert_eq!(
            resolve_to(&ways, "ghcr.io/intentic/sandbox:1.1.0")
                .unwrap()
                .image,
            "ghcr.io/intentic/sandbox:1.1.0",
            "what the listing offers for a pin whose image is gone"
        );
        let refused = resolve_to(&ways, "yesterday").unwrap_err();
        assert!(refused.0.contains("kept: 1.2.0"), "{}", refused.0);
    }

    // The menu offers the ways back and sends a row's exact image; the plain rollback and `--to` read the same list, so
    // neither reaches a build the menu hid (2026-10: a version matched a pruned pin first, and a plain rollback took a
    // pruned `previous` the menu never listed).
    #[test]
    fn a_rollback_and_the_menu_offering_it_name_the_same_builds() {
        let gone = "intentic-sandbox-rollback-x:0d0d0d0d0d0d";
        let record = with_targets(
            Some(pin(gone, "0.0.0")),
            vec![
                pin("intentic-sandbox-rollback-x:aaaaaaaaaaaa", "1.3.0"),
                pin("intentic-sandbox-rollback-x:f5eb7476ff5c", "0.0.0"),
            ],
        );
        let ways = ways_back(&record, &|image| image != gone);
        assert_eq!(
            ways.iter()
                .map(|way| way.image.as_str())
                .collect::<Vec<_>>(),
            [
                "intentic-sandbox-rollback-x:aaaaaaaaaaaa",
                "intentic-sandbox-rollback-x:f5eb7476ff5c"
            ],
            "the pruned dev build is no way back, and the plain rollback takes the first that is"
        );
        assert_eq!(
            resolve_to(&ways, "0.0.0").unwrap().image,
            "intentic-sandbox-rollback-x:f5eb7476ff5c"
        );
        for listed in targets_json(&record, &|image| image != gone)
            .as_array()
            .unwrap()
        {
            let image = listed["image"].as_str().unwrap();
            assert_eq!(
                resolve_to(&ways, image).unwrap().image,
                image,
                "a menu row's `to` reaches its own build"
            );
        }
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
            ..Pin::default()
        };
        assert_eq!(reachable(&nameless, false), None);
        // An older record named the registry's own tag: pulled as it is.
        let published = Pin {
            image: "ghcr.io/intentic/sandbox:1.1.0".to_string(),
            ..Pin::default()
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
    fn pruned_dev_builds_are_no_way_back_and_one_release_is_offered_once() {
        // Every dev build says 0.0.0, which no registry publishes: pruned, it cannot be downloaded again.
        let dev = pin("intentic-sandbox-rollback-x:c6cc76cfeece", "0.0.0");
        assert_eq!(reachable(&dev, false), None);
        assert_eq!(
            reachable(&dev, true).as_deref(),
            Some("intentic-sandbox-rollback-x:c6cc76cfeece")
        );
        let record = with_targets(
            Some(dev),
            vec![
                pin("intentic-sandbox-rollback-x:f5eb7476ff5c", "0.0.0"),
                pin("intentic-sandbox-rollback-x:aaaaaaaaaaaa", "1.2.0"),
                pin("intentic-sandbox-rollback-x:bbbbbbbbbbbb", "1.2.0"),
            ],
        );
        let gone = |_: &str| false;
        assert_eq!(
            targets_json(&record, &gone),
            json!([{ "image": "ghcr.io/intentic/sandbox:1.2.0", "version": "1.2.0", "download": true }])
        );
        assert!(resolve_to(&[], "0.0.0").is_err());
        assert!(is_published("1.2.0") && !is_published("0.0.0") && !is_published("v0.0.0"));
    }

    fn env_pin(image: &str, version: &str, env: &str) -> Pin {
        Pin {
            env_image: Some(env.to_string()),
            env_hash: Some(format!("hash-of-{env}")),
            ..pin(image, version)
        }
    }

    #[test]
    fn a_rollback_runs_the_environment_build_kept_beside_its_base_and_rebuilds_only_when_it_is_gone(
    ) {
        let kept = env_pin("pin:b", "1.2.0", "pin:env-b");
        assert_eq!(
            pinned_environment(&kept, "pin:b", true, &|_| true),
            Some(("pin:env-b".to_string(), "hash-of-pin:env-b".to_string()))
        );
        // Pruned outside ic: today's recipe is rebuilt on the base, as before.
        assert_eq!(
            pinned_environment(&kept, "pin:b", true, &|image| image != "pin:env-b"),
            None
        );
        // The base itself gone, its release run instead: the build rode a base that is not the one going back to.
        assert_eq!(
            pinned_environment(&kept, "ghcr.io/intentic/sandbox:1.2.0", true, &|_| true),
            None
        );
        // No approved recipe now: the owner removed what that build installs.
        assert_eq!(pinned_environment(&kept, "pin:b", false, &|_| true), None);
        // A stock sandbox's pin, or one an older ic wrote, has nothing beside it.
        assert_eq!(
            pinned_environment(&pin("pin:b", "1.2.0"), "pin:b", true, &|_| true),
            None
        );
    }

    #[test]
    fn the_environment_build_travels_with_its_pin_through_a_rollback_and_back() {
        let saved = with_targets(Some(env_pin("pin:b", "1.2.0", "pin:env-b")), Vec::new());
        // Running c on its own environment build, going back to b: c's pair becomes the way forward.
        let (previous, kept, _) = next_targets(
            &saved,
            Some(env_pin("pin:c", "1.3.0", "pin:env-c")),
            "pin:b",
            2,
        );
        assert_eq!(previous, Some(env_pin("pin:c", "1.3.0", "pin:env-c")));
        assert!(kept.is_empty());
        // And forward again: b's pair is the way back, environment build and all.
        let after = with_targets(previous, kept);
        let (previous, _, _) = next_targets(
            &after,
            Some(env_pin("pin:b", "1.2.0", "pin:env-b")),
            "pin:c",
            2,
        );
        assert_eq!(previous, Some(env_pin("pin:b", "1.2.0", "pin:env-b")));
        // Taking a gone pin off the list takes its environment build with it.
        let rest = without(&after, "pin:c");
        assert_eq!((rest.previous, rest.previous_env), (None, None));
    }

    #[test]
    fn a_release_version_is_three_numbers_with_an_optional_suffix() {
        assert!(is_version("1.316.0") && is_version("v1.316.0") && is_version("1.316.0-rc.1"));
        assert!(!is_version("1.316") && !is_version("stable") && !is_version("1.x.0"));
    }
}
