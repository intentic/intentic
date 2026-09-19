use crate::docker;
use crate::sandbox::{list_slugs, trash};
use crate::tty;
use crate::util::{bail, Result};

/* Bring a removed sandbox back from the trash, inside the week its data is kept. */

pub struct Args {
    /// Which sandbox to bring back; none = pick interactively.
    pub slug: Option<String>,
    pub yes: bool,
}

pub fn run(args: Args) -> Result<()> {
    if !docker::cli_present() {
        bail!("docker is not installed — nothing to restore from.");
    }
    // Anything past its window is gone before it can be offered: listing it would promise a recovery this
    // machine can no longer perform.
    trash::sweep();

    let recoverable = trash::list();
    if recoverable.is_empty() {
        println!("intentic: nothing to restore — no sandbox has been removed in the last {GRACE_DAYS} days.");
        return Ok(());
    }

    let now = trash::now_secs();
    let slug = match args.slug {
        Some(slug) => slug,
        None => {
            println!("intentic: sandboxes you can bring back:");
            for (i, entry) in recoverable.iter().enumerate() {
                println!(
                    "  {}) {:<24} {} day(s) left",
                    i + 1,
                    entry.slug,
                    entry.days_left(now)
                );
            }
            if !tty::have_tty() {
                bail!("no terminal for interactive selection — nothing restored.\nRe-run with a SLUG, e.g. 'ic sandbox restore {}'.", recoverable[0].slug);
            }
            let Some(reply) = tty::ask("Restore which — a number, \"q\" = cancel: ") else {
                println!("intentic: cancelled — nothing restored.");
                return Ok(());
            };
            match reply.trim().parse::<usize>() {
                Ok(number) if (1..=recoverable.len()).contains(&number) => {
                    recoverable[number - 1].slug.clone()
                }
                _ => {
                    println!("intentic: cancelled — nothing restored.");
                    return Ok(());
                }
            }
        }
    };

    // Checked before the lookup: a live slug is deliberately absent from the trash listing, so asking there first
    // would answer "not recoverable" to somebody whose sandbox is simply already back.
    if list_slugs().iter().any(|live| live == &slug) {
        bail!("a sandbox named '{slug}' is already running on this machine — it is holding the same /work the removed one left behind, so there is nothing to bring back.");
    }
    let Some(entry) = recoverable.iter().find(|entry| entry.slug == slug) else {
        let names: String = recoverable
            .iter()
            .map(|entry| format!("  {}\n", entry.slug))
            .collect();
        bail!("no removed sandbox named '{slug}' is still recoverable. These are:\n{names}");
    };

    println!(
        "intentic: about to restore '{}' ({} day(s) of its recovery window left).",
        entry.slug,
        entry.days_left(now)
    );
    if !tty::confirm("Restore it?", args.yes) {
        println!("intentic: cancelled — nothing restored.");
        return Ok(());
    }

    trash::restore(&slug);
    println!("intentic: restored '{slug}'. Its /work and /history are as they were.");
    // Its address is minted per connection, so a restored container answers where it used to only if the
    // platform still knows it; say so rather than let a stale bookmark be the discovery.
    println!("intentic: if the browser can't reach it, run 'ic sandbox doctor {slug}'.");
    Ok(())
}

/// Whole days of grace, for the sentences that quote it.
const GRACE_DAYS: u64 = trash::GRACE_SECS / (24 * 60 * 60);

/// `ic sandbox purge` — end the grace period early for one slug, or for everything in the trash.
pub struct PurgeArgs {
    pub slugs: Vec<String>,
    pub all: bool,
    pub yes: bool,
}

pub fn purge(args: PurgeArgs) -> Result<()> {
    if !docker::cli_present() {
        bail!("docker is not installed — nothing to purge.");
    }
    let recoverable = trash::list();
    if recoverable.is_empty() {
        println!("intentic: nothing to purge — the trash is empty.");
        return Ok(());
    }
    let selected: Vec<String> = if args.all {
        recoverable.iter().map(|entry| entry.slug.clone()).collect()
    } else {
        args.slugs.clone()
    };
    if selected.is_empty() {
        bail!(
            "name a sandbox to purge, or pass --all. In the trash now:\n{}",
            recoverable
                .iter()
                .map(|entry| format!("  {}\n", entry.slug))
                .collect::<String>()
        );
    }
    for slug in &selected {
        if !recoverable.iter().any(|entry| &entry.slug == slug) {
            bail!("'{slug}' is not in the trash — nothing purged.");
        }
    }

    println!(
        "intentic: about to PERMANENTLY DELETE the data of {}:",
        crate::util::plural(selected.len(), "removed sandbox")
    );
    for slug in &selected {
        println!("    {slug}");
    }
    println!("This cannot be undone.");
    if !tty::confirm("Proceed?", args.yes) {
        println!("intentic: cancelled — nothing purged.");
        return Ok(());
    }
    for slug in &selected {
        println!("intentic: deleting '{slug}'…");
        trash::purge(slug);
    }
    println!("intentic: done.");
    Ok(())
}
