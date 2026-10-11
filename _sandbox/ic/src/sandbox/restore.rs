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

    if !ui::confirm(
        &format!("Restore {}?", entry.slug),
        &format!(
            "{} comes back with its files and history as they were. {} of its recovery window are left.",
            entry.slug,
            plural(entry.days_left(now) as usize, "day")
        ),
        args.yes,
    )? {
        ui::cancelled();
        return Ok(());
    }

    // One ic at a time on a sandbox: a sweep or a purge of the same slug must not run underneath the restore.
    let _held = lock::hold_for_person(&slug)?;
    ui::act(&format!("Restoring {slug}"));
    trash::restore(&slug);
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
        args.slugs.clone()
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
    let mut kept: Vec<String> = Vec::new();
    for slug in &selected {
        let _held = lock::hold_for_person(slug)?;
        ui::act(&format!("Deleting {slug}"));
        if let Err(why) = trash::purge(slug) {
            ui::warn(&format!("{why}."));
            kept.push(slug.clone());
        }
    }
    if !kept.is_empty() {
        bail!(
            "{}",
            ui::explain(
                &format!(
                    "{} could not be deleted completely: {}.",
                    plural(kept.len(), "sandbox"),
                    kept.join(", ")
                ),
                Some("they stay removed, and the next purge or the weekly sweep tries again."),
                Some("ic sandbox purge --all"),
            )
        );
    }
    ui::done(&format!("{} deleted.", plural(selected.len(), "sandbox")));
    Ok(())
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
}
