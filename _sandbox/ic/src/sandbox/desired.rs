use std::path::{Path, PathBuf};

use crate::docker;
use crate::logfile::intentic_home;
use crate::record;
use crate::sandbox::recreate::{self, Preflight};
use crate::sandbox::{containment, lock, mirror, CONTAINER_PREFIX};
use crate::shape::{Ask, Shape};
use crate::ui;
use crate::util::{bail, Fail, Result};

/* DESIRED VS RUNNING: the shape a sandbox runs with is on its container, the shape it should run with after its next restart is in its channel record, and this module is the only writer of the second. */

/// When a shape takes effect. `Now` restarts the sandbox onto it; `NextRestart` saves it for whichever flow restarts
/// the sandbox through ic next (`ic sandbox restart`/`start`, an update, a rollback, a rebuild), and restarts nothing.
/// Docker restarting the container by itself (`--restart unless-stopped`, after a crash or a reboot) is not one of
/// those: docker replays the container it has, and only ic recreates one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    Now,
    NextRestart,
}

/// The shape `container` runs with now: the owner's ask it carries in its env, with the swap a live reshape wrote into
/// it since (containment.rs), which changes no env var. The default shape when the container could not be read, which
/// only ever feeds a comparison or a base for an ask.
pub fn running(container: &str) -> Shape {
    let env: Vec<String> = docker::inspect(container, "{{json .Config.Env}}")
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    Shape::from_env(&env)
        .with_live_swap(containment::live_swap(container).map(containment::Live::ask))
}

/// `ic sandbox shape <slug> … --when now|next-restart` — the one verb that sets a sandbox's shape. The ask is laid
/// over the shape already saved for the next restart when there is one, else over what runs, so a person can type
/// only what they mean to change; the machine agent and the desktop app always send all four fields.
pub fn set(slug: String, ask: Ask, when: When, preflight: Preflight) -> Result<()> {
    if ask.is_empty() {
        bail!(
            "{}",
            ui::explain(
                "Nothing changed.",
                Some("the command names no change."),
                Some("add --memory, --cpus, --privileged, --gpus or --swap."),
            )
        );
    }
    let container = existing(&slug)?;
    // Read, laid over and written under the sandbox's lock, so a swap or another save in between cannot be lost.
    let _held = lock::hold_for_person(&slug)?;
    adopt_legacy(&slug, &container)?;
    let running = running(&container);
    let saved = mirror::reconcile(&slug).desired;
    let target = saved.clone().unwrap_or_else(|| running.clone()).with(&ask);
    target.check_spelling()?;
    match when {
        When::Now if running.differs_only_in_swap(&target) && runs(&container) => {
            match live_swap(&slug, &container, &target, saved.is_some())? {
                true => Ok(()),
                false => recreate::reshape(slug, target.as_ask(), preflight),
            }
        }
        When::Now => recreate::reshape(slug, target.as_ask(), preflight),
        When::NextRestart => save(&slug, &target, &running),
    }
}

fn runs(container: &str) -> bool {
    docker::inspect(container, "{{.State.Running}}").as_deref() == Some("true")
}

/// THE SWAP ALONE, NOW, WITH NO RESTART (2026-11-05). A swap bound is one number the kernel takes at once, so a change to
/// it and nothing else is written into the running sandbox (containment::apply_live) instead of recreating it: the
/// override file the sandbox reads its bounds from, and the workload leaf's own bound. Nothing about the container
/// changes, so its env still names the swap it was made with; every later read of the shape it runs with
/// (`running`, the listing) takes the override's over it, and every recreate carries the override's value in the env
/// it hands the new container (recreate.rs), which is how it survives the restart that drops the file. A shape saved for
/// the next restart that differed from what runs in the swap alone is now in force, and is dropped.
///
/// False when the container would not take it (an exec it refused or never answered): the caller then recreates, as a
/// `--when now` always did.
fn live_swap(slug: &str, container: &str, target: &Shape, had_saved: bool) -> Result<bool> {
    let Some((gib, leaf)) = containment::apply_live(container, target) else {
        ui::note(&format!(
            "{slug} did not take the new swap while running, so it is restarted onto it instead."
        ));
        return Ok(false);
    };
    if had_saved {
        clear(slug)?;
    }
    let in_force = containment::read(container)
        .map(|reading| format!(" In force now: {}.", containment::in_force_words(&reading)))
        .unwrap_or_default();
    let named = match &target.swap {
        Some(_) => format!("{gib} GiB"),
        None => format!("the default, {gib} GiB for its memory cap"),
    };
    match leaf {
        containment::Leaf::Bounded => ui::done(&format!(
            "{slug}'s work may now use {named} of swap, at once and with no restart. Every later restart and update keeps it.{in_force}"
        )),
        containment::Leaf::Missing => ui::warn(&format!(
            "{slug} runs an image from before a sandbox bounded its own work, so nothing inside it holds the {named} of swap yet: it is kept, and takes hold when the sandbox is next updated (ic sandbox update {slug}).{in_force}"
        )),
        containment::Leaf::Refused => ui::warn(&format!(
            "{slug} kept the {named} of swap but its workload refused the new bound for now; its next restart applies it (ic sandbox restart {slug}).{in_force}"
        )),
    }
    Ok(true)
}

/// `ic sandbox reshape <slug> … --later`, the spelling machine agents released before `shape` send. Kept for one
/// release: the ask is laid over what RUNS (what `--later` always meant: it replaced whatever was saved), and the
/// result is validated and saved exactly as `shape --when next-restart` saves it.
pub fn save_later(slug: String, ask: Ask) -> Result<()> {
    if ask.is_empty() {
        bail!(
            "{}",
            ui::explain(
                "Nothing was saved.",
                Some("the command names no change."),
                Some("add --memory, --cpus, --privileged, --gpus or --swap, or --forget to drop what is saved."),
            )
        );
    }
    let container = existing(&slug)?;
    let _held = lock::hold_for_person(&slug)?;
    adopt_legacy(&slug, &container)?;
    let running = running(&container);
    let target = running.with(&ask);
    target.check_spelling()?;
    save(&slug, &target, &running)
}

/// Save `target` for the next restart, after the image has said it would start with it. A target that is what
/// already runs leaves nothing waiting, so it forgets instead of saving a restart that changes nothing.
///
/// (2026-10-05) Under the sandbox's lock, read through the mirror and pushed back to it: the record is the one every
/// side of this computer reads (mirror.rs), and a save written to this home alone was invisible to the side whose ic
/// restarts the sandbox next, and could be written over by a swap that read the record before it.
fn save(slug: &str, target: &Shape, running: &Shape) -> Result<()> {
    let _held = lock::hold_for_person(slug)?;
    if target == running {
        clear(slug)?;
        ui::quiet(&format!(
            "{slug} already runs with {}, so nothing is saved for its next restart.",
            target.describe()
        ));
        return Ok(());
    }
    recreate::check_shape(slug, target).map_err(|Fail(reason)| {
        Fail(format!(
            "{reason}\n   Nothing was saved, and the sandbox is untouched."
        ))
    })?;
    // An unreadable home record is still an error: writing over it would lose the rollback target it names.
    record::read(slug)?;
    let saved = mirror::reconcile(slug);
    record::write(
        slug,
        &record::ChannelRecord {
            desired: Some(target.clone()),
            ..saved
        },
    )?;
    mirror::push(slug);
    ui::done(&format!(
        "Saved for the next restart of {slug}: {}. The sandbox keeps running as it is.",
        target.describe()
    ));
    ui::later(&[(
        "apply it now".to_string(),
        format!("ic sandbox restart {slug}"),
    )]);
    Ok(())
}

/// `ic sandbox shape <slug> --forget` (and the old `reshape --forget`) — drop the shape saved for the next restart.
/// Idempotent.
pub fn forget(slug: String) -> Result<()> {
    let container = format!("{CONTAINER_PREFIX}{slug}");
    if docker::container_exists(&container) {
        adopt_legacy(&slug, &container)?;
    }
    clear(&slug)?;
    ui::done(&format!(
        "Nothing is saved for the next restart of {slug} any more."
    ));
    Ok(())
}

fn clear(slug: &str) -> Result<()> {
    let _held = lock::hold_for_person(slug)?;
    record::read(slug)?;
    let saved = mirror::reconcile(slug);
    if saved.desired.is_some() {
        record::write(
            slug,
            &record::ChannelRecord {
                desired: None,
                ..saved
            },
        )?;
        mirror::push(slug);
    }
    Ok(())
}

fn existing(slug: &str) -> Result<String> {
    let container = format!("{CONTAINER_PREFIX}{slug}");
    if !docker::container_exists(&container) {
        bail!("{}", crate::sandbox::missing(slug));
    }
    Ok(container)
}

/* THE SHARE AN OLDER ic SAVED, read once: `sandbox-<slug>.shape` beside the channel record, a DELTA against what ran. */

/// Where an ic before the channel record's `desired_*` keys kept `reshape --later`'s ask.
fn legacy_path(slug: &str) -> PathBuf {
    intentic_home().join(format!("sandbox-{slug}.shape"))
}

/// Turn an old `.shape` file into the record's desired shape and retire the file. Its delta is laid over what the
/// container runs NOW, which is what it was always applied to. A value no contract could take (`privileged=maybe`,
/// `memory=lots`) is dropped with a note rather than carried into a restart it would break; an unreadable file is an
/// error, as it always was, since dropping the owner's saved share silently would look like it took.
pub fn adopt_legacy(slug: &str, container: &str) -> Result<()> {
    adopt_legacy_at(&legacy_path(slug), slug, || running(container))
}

fn adopt_legacy_at(path: &Path, slug: &str, running: impl FnOnce() -> Shape) -> Result<()> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(Fail(ui::explain(
                "Nothing changed.",
                Some(&format!("{} could not be read: {err}. It holds the share saved for this sandbox's next restart.", path.display())),
                None,
            )))
        }
    };
    let (ask, dropped) = legacy_ask(&content);
    for line in &dropped {
        // stderr: `ic sandbox list --json` adopts too, and its stdout is JSON.
        ui::warn(&format!("Dropped '{line}' from the share saved for {slug}'s next restart: no sandbox could start with it."));
    }
    let running = running();
    let target = running.with(&ask);
    if !ask.is_empty() && target != running {
        let saved = record::read(slug)?;
        // A shape saved through the new verb since wins over the file an older ic left behind.
        if saved.desired.is_none() {
            record::write(
                slug,
                &record::ChannelRecord {
                    desired: Some(target),
                    ..saved
                },
            )?;
        }
    }
    std::fs::remove_file(path)
        .or_else(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(err)
            }
        })
        .map_err(|err| Fail(format!("could not retire {}: {err}", path.display())))
}

/// The old file's `key=value` lines as an ask, and every line it held that no contract could take. An unknown key
/// is a newer ic's and is ignored, as the old reader ignored it.
fn legacy_ask(content: &str) -> (Ask, Vec<String>) {
    let mut ask = Ask::default();
    let mut dropped = Vec::new();
    for line in content.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        let switch = match value {
            "on" => Some(true),
            "off" => Some(false),
            _ => None,
        };
        let cap_ok = |value: &str, field: fn(String) -> Shape| {
            value.is_empty() || field(value.to_string()).check_spelling().is_ok()
        };
        match key.trim() {
            "memory"
                if cap_ok(value, |memory| Shape {
                    memory: Some(memory),
                    ..Shape::default()
                }) =>
            {
                ask.memory = Some(value.to_string())
            }
            "cpus"
                if cap_ok(value, |cpus| Shape {
                    cpus: Some(cpus),
                    ..Shape::default()
                }) =>
            {
                ask.cpus = Some(value.to_string())
            }
            "privileged" if switch.is_some() => ask.privileged = switch,
            "gpus" if switch.is_some() => ask.gpus = switch,
            "memory" | "cpus" | "privileged" | "gpus" => dropped.push(line.trim().to_string()),
            _ => {}
        }
    }
    (ask, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_files_lines_are_an_ask_and_what_no_contract_takes_is_named_not_kept() {
        let (ask, dropped) = legacy_ask("memory=20g\ncpus=\nprivileged=maybe\ngpus=on\nfuture=1\n");
        assert_eq!(
            ask,
            Ask {
                memory: Some("20g".to_string()),
                cpus: Some(String::new()),
                privileged: None,
                gpus: Some(true),
                swap: None,
            }
        );
        assert_eq!(dropped, vec!["privileged=maybe".to_string()]);
        let (ask, dropped) = legacy_ask("memory=lots\ncpus=0\n");
        assert!(ask.is_empty());
        assert_eq!(
            dropped,
            vec!["memory=lots".to_string(), "cpus=0".to_string()]
        );
    }

    #[test]
    fn a_missing_file_adopts_nothing_and_asks_nothing_of_the_container() {
        let dir = tempfile::tempdir().expect("tempdir");
        adopt_legacy_at(&dir.path().join("sandbox-abc.shape"), "abc", || {
            panic!("nothing to adopt, so the container is never read")
        })
        .expect("nothing to adopt");
    }

    #[test]
    fn an_unreadable_file_is_an_error_rather_than_a_share_silently_dropped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-abc.shape");
        std::fs::create_dir(&path).expect("a directory where the file should be");
        assert!(adopt_legacy_at(&path, "abc", Shape::default).is_err());
    }
}
