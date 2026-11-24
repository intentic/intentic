use crate::docker;
use crate::sandbox::lock;
use crate::sandbox::trash::GRACE_DAYS;
use crate::sandbox::{days_left, list_slugs, trash};
use crate::ui;
use crate::util::{bail, plural, Result};

/* Bring a removed sandbox back from the trash, inside the week its data is kept. */

pub struct Args {
    /// Which sandbox to bring back; none = pick interactively.
    pub slug: Option<String>,
    pub yes: bool,
}

fn no_docker(what: &str) -> String {
    ui::explain(
        &format!("Nothing was {what}."),
        Some("Docker is not installed on this device, so there is no removed sandbox here."),
        None,
    )
}

pub fn run(args: Args) -> Result<()> {
    if !docker::cli_present() {
        bail!("{}", no_docker("restored"));
    }
    // Anything past its window is gone before it can be offered: listing it would promise a recovery this
    // device can no longer perform.
    trash::sweep();

    let recoverable = trash::list();
    if recoverable.is_empty() {
        ui::quiet(&format!(
            "Nothing to restore: no sandbox was removed from this device in the last {GRACE_DAYS} days."
        ));
        return Ok(());
    }

    let now = trash::now_secs();
    let slug = match args.slug {
        Some(slug) => slug,
        None => {
            let choices: Vec<(String, String)> = recoverable
                .iter()
                .map(|entry| (entry.slug.clone(), days_left(entry.days_left(now))))
                .collect();
            match ui::pick("Which sandbox should be restored?", &choices, false)? {
                Some(picked) if !picked.is_empty() => recoverable[picked[0]].slug.clone(),
                _ => {
                    ui::cancelled();
                    return Ok(());
                }
            }
        }
    };

    // Checked before the lookup: a live slug is deliberately absent from the trash listing, so asking there first
    // would answer "not recoverable" to somebody whose sandbox is simply already back.
    if list_slugs().iter().any(|live| live == &slug) {
        bail!(
            "{}",
            ui::explain(
                &format!("{slug} is already running on this device."),
                Some("it holds the same /work the removed one left behind, so there is nothing to bring back."),
                None,
            )
        );
    }
    let Some(entry) = recoverable.iter().find(|entry| entry.slug == slug) else {
        let names: Vec<&str> = recoverable
            .iter()
            .map(|entry| entry.slug.as_str())
            .collect();
        bail!(
            "{}",
            ui::explain(
                &format!("No removed sandbox named {slug} can still be restored."),
                Some(&format!("these can: {}.", names.join(", "))),
                Some(&format!("ic sandbox restore {}", names[0])),
            )
        );
    };

    // Only data in the trash (volumes tidy put there) is said before the question: there is nothing to start, and the
    // marker stays, so neither its clock nor its place in the trash changes.
    if !trash::has_container(&slug) {
        bail!("{}", data_only(&slug, entry.days_left(now)));
    }

    if !ui::confirm(
        &format!("Restore {}?", entry.slug),
        &restore_consequence(&entry.slug, entry.days_left(now)),
        args.yes,
    )? {
        ui::cancelled();
        return Ok(());
    }

    // One ic at a time on a sandbox: a sweep or a purge of the same slug must not run underneath the restore.
    let _held = lock::hold_for_person(&slug)?;
    // Read again under the lock: a purge or a sweep that held it while the question waited may have deleted it.
    let Some(entry) = trash::still_trashed(&slug) else {
        bail!("{}", gone_meanwhile(&slug));
    };
    if !trash::has_container(&slug) {
        bail!("{}", data_only(&slug, entry.days_left(trash::now_secs())));
    }
    ui::act(&format!("Restoring {slug}"));
    if let Err(why) = trash::restore(&slug) {
        bail!(
            "{}",
            ui::explain(
                &format!("{slug} was not restored."),
                Some(&format!("{why}.")),
                Some(&format!("ic sandbox restore {slug}")),
            )
        );
    }
    ui::done(&format!(
        "{slug} is restored. Its /work and /history are as they were."
    ));
    // Its address is minted per connection, so a restored container answers where it used to only if the
    // platform still knows it; say so rather than let a stale bookmark be the discovery.
    ui::later(&[(
        "if the browser can't reach it".to_string(),
        format!("ic sandbox doctor {slug}"),
    )]);
    ui::plain(&format!(
        "intentic: if the browser can't reach it, run 'ic sandbox doctor {slug}'."
    ));
    Ok(())
}

/// What answering the restore's question does. Pure.
fn restore_consequence(slug: &str, days_left: u64) -> String {
    format!(
        "{slug} comes back with its files and history as they were. {} of its recovery window {} left.",
        plural(days_left as usize, "day"),
        if days_left == 1 { "is" } else { "are" }
    )
}

/// The stop for a trash entry that is data alone: volumes tidy put in the trash when no container claimed them. Pure.
fn data_only(slug: &str, days_left: u64) -> String {
    ui::explain(
        &format!("{slug} was not restored: only its data is in the trash."),
        Some(&format!(
            "there is no container of {slug} to start, only its /work and /history. They stay in the trash, untouched, for {}.",
            plural(days_left as usize, "more day")
        )),
        Some(&format!(
            "connecting {slug} again from intentic uses this data: the setup command on its page sets it up under the same name."
        )),
    )
}

/// The stop for a restore whose slug the trash no longer held by the time this run held its lock. Pure.
fn gone_meanwhile(slug: &str) -> String {
    ui::explain(
        &format!("{slug} was not restored."),
        Some("it is no longer in the trash: another ic run restored, set up or deleted it while this one waited."),
        Some("ic sandbox list"),
    )
}

/// `ic sandbox purge` — end the grace period early for one slug, or for everything in the trash.
pub struct PurgeArgs {
    pub slugs: Vec<String>,
    pub all: bool,
    /// The typed answer given on the command line: the sandbox's name, or the count. `--yes` never stands in for it.
    pub confirm: Option<String>,
}

pub fn purge(args: PurgeArgs) -> Result<()> {
    if !docker::cli_present() {
        bail!("{}", no_docker("deleted"));
    }
    let recoverable = trash::list();
    if recoverable.is_empty() {
        ui::quiet("Nothing to delete: no removed sandbox is waiting on this device.");
        return Ok(());
    }
    let names: Vec<&str> = recoverable
        .iter()
        .map(|entry| entry.slug.as_str())
        .collect();
    let selected: Vec<String> = if args.all {
        names.iter().map(|name| name.to_string()).collect()
    } else {
        crate::sandbox::each_once(args.slugs.clone())
    };
    if selected.is_empty() {
        bail!(
            "{}",
            ui::explain(
                "Nothing was deleted.",
                Some(&format!(
                    "the command names no sandbox. Removed and waiting: {}.",
                    names.join(", ")
                )),
                Some(&format!(
                    "ic sandbox purge {}, or --all for every one",
                    names[0]
                )),
            )
        );
    }
    for slug in &selected {
        if !names.contains(&slug.as_str()) {
            bail!(
                "{}",
                ui::explain(
                    "Nothing was deleted.",
                    Some(&format!(
                        "{slug} is not a removed sandbox. Removed and waiting: {}.",
                        names.join(", ")
                    )),
                    None,
                )
            );
        }
    }

    let (asked, consequence) = purge_question(&selected);
    if !ui::confirm_typed(
        &asked,
        &consequence,
        &crate::sandbox::remove::typed_name(&selected),
        args.confirm.as_deref(),
    )? {
        ui::cancelled();
        return Ok(());
    }
    let (mut deleted, mut back, mut kept) = (0, Vec::new(), Vec::new());
    for slug in &selected {
        let _held = lock::hold_for_person(slug)?;
        // Read again under the lock: the question above waits on a person for as long as they take, and a restore of
        // the same slug meanwhile put a running sandbox on the very volumes this would delete (2026-10-11).
        if trash::still_trashed(slug).is_none() {
            back.push(slug.clone());
            continue;
        }
        ui::act(&format!("Deleting {slug}"));
        match trash::purge(slug) {
            Ok(()) => deleted += 1,
            Err(why) => {
                ui::warn(&format!("{why}."));
                kept.push(slug.clone());
            }
        }
    }
    if deleted > 0 {
        ui::done(&format!("{} deleted.", plural(deleted, "sandbox")));
    }
    if let Some(stop) = purge_stop(&back, &kept) {
        bail!("{stop}");
    }
    Ok(())
}

/// The stop for a purge that did not delete every sandbox it was asked to: the ones the trash no longer held once
/// their lock was free, and the ones docker would not finish deleting. None when nothing is left over. Pure.
fn purge_stop(back: &[String], kept: &[String]) -> Option<String> {
    let was = |many: &[String]| if many.len() == 1 { "was" } else { "were" };
    match (back.is_empty(), kept.is_empty()) {
        (true, true) => None,
        (false, true) => Some(ui::explain(
            &format!(
                "{} {} not deleted: {}.",
                plural(back.len(), "sandbox"),
                was(back),
                back.join(", ")
            ),
            Some(&format!(
                "{} no longer in the trash: another ic run restored, set up or deleted {} while this purge waited.",
                if back.len() == 1 { "it is" } else { "they are" },
                if back.len() == 1 { "it" } else { "them" }
            )),
            Some("ic sandbox list"),
        )),
        (true, false) => Some(ui::explain(
            &format!(
                "{} could not be deleted completely: {}.",
                plural(kept.len(), "sandbox"),
                kept.join(", ")
            ),
            Some("they stay removed, and the next purge or the weekly sweep tries again."),
            Some("ic sandbox purge --all"),
        )),
        (false, false) => Some(ui::explain(
            &format!(
                "{} {} not deleted: {}.",
                plural(back.len() + kept.len(), "sandbox"),
                was(&[back, kept].concat()),
                [back, kept].concat().join(", ")
            ),
            Some(&format!(
                "{} left the trash while this purge waited; docker would not finish deleting {}, which stay removed for the next purge or sweep to try again.",
                back.join(", "),
                kept.join(", ")
            )),
            Some("ic sandbox list"),
        )),
    }
}

/// The purge's question and what answering does, said first. Pure.
pub fn purge_question(selected: &[String]) -> (String, String) {
    let asked = match selected {
        [one] => format!("Delete {one} for good?"),
        many => format!(
            "Delete {} for good? Type {} to confirm.",
            plural(many.len(), "removed sandbox"),
            many.len()
        ),
    };
    (
        asked,
        format!(
            "This deletes the files and history of {}, which are otherwise kept until their {GRACE_DAYS} days are up. It cannot be undone.",
            selected.join(", ")
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_purge_asks_for_the_name_of_one_or_the_count_of_several() {
        let one = vec!["work".to_string()];
        assert_eq!(purge_question(&one).0, "Delete work for good?");
        assert!(purge_question(&one).1.contains("cannot be undone"));
        let three: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            purge_question(&three).0,
            "Delete 3 removed sandboxes for good? Type 3 to confirm."
        );
        assert_eq!(crate::sandbox::remove::typed_name(&three), "3");
    }

    #[test]
    fn the_window_left_is_counted_in_words_that_agree_with_it() {
        assert!(restore_consequence("work", 1).ends_with("1 day of its recovery window is left."));
        assert!(restore_consequence("work", 6).ends_with("6 days of its recovery window are left."));
    }

    #[test]
    fn data_alone_in_the_trash_is_never_called_restored() {
        let stop = data_only("sandbox-ccc", 1);
        assert!(stop.starts_with("sandbox-ccc was not restored: only its data is in the trash."));
        assert!(stop.contains("for 1 more day."));
        assert!(stop.contains("connecting sandbox-ccc again from intentic uses this data"));
        assert!(!stop.contains("is restored"));
    }

    #[test]
    fn a_purge_says_which_it_did_not_delete_and_why() {
        let one = |slug: &str| vec![slug.to_string()];
        assert!(purge_stop(&[], &[]).is_none());
        let back = purge_stop(&one("bbb"), &[]).expect("a stop");
        assert!(back.starts_with("1 sandbox was not deleted: bbb."));
        assert!(back.contains("it is no longer in the trash"));
        let kept = purge_stop(&[], &one("ccc")).expect("a stop");
        assert!(kept.starts_with("1 sandbox could not be deleted completely: ccc."));
        let both = purge_stop(&one("bbb"), &one("ccc")).expect("a stop");
        assert!(both.starts_with("2 sandboxes were not deleted: bbb, ccc."));
    }

    #[test]
    fn a_sandbox_named_twice_is_purged_once_and_confirmed_by_its_name() {
        let twice = crate::sandbox::each_once(vec!["bbb".to_string(), "bbb".to_string()]);
        assert_eq!(crate::sandbox::remove::typed_name(&twice), "bbb");
        assert_eq!(purge_question(&twice).0, "Delete bbb for good?");
    }
}
