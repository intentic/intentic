use std::io::Write;
use std::path::{Path, PathBuf};

use crate::logfile::intentic_home;
use crate::sandbox::recreate::Reshape;
use crate::util::{Fail, Result};

/* THE SHARE SAVED FOR THE NEXT RESTART: a reshape asked for with `--later`, held on the host until a flow recreates the container anyway. */

/// `sandbox-<slug>.shape`, beside the channel record. One `key=value` per line, and an absent key is "leave it":
///
///   memory=12g    a cap in the contract's spelling; `memory=` (empty) is "back to the default"
///   cpus=4        likewise; `cpus=` clears the CPU cap
///   privileged=on the owner's own privileged ask, `on` or `off`
///   gpus=off      the owner's GPU pass-through, `on` or `off`
///
/// The machine agent reads this same file to show what is saved (`@intentic/machine`, `savedShapeFrom`), so
/// the spelling is a contract between the two and changes in both places at once.
pub fn path(slug: &str) -> PathBuf {
    intentic_home().join(format!("sandbox-{slug}.shape"))
}

/// What is saved for `slug`, or None when nothing is. A file that exists but cannot be read is an error rather
/// than "nothing saved": a restart that silently dropped the owner's saved share would look like it took.
pub fn read(slug: &str) -> Result<Option<Reshape>> {
    read_file(&path(slug))
}

fn read_file(path: &Path) -> Result<Option<Reshape>> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(Fail(format!(
                "could not read {}: {err}\n       It holds the share saved for this sandbox's next restart, so nothing was changed.",
                path.display()
            )))
        }
    };
    let mut shape = Reshape::default();
    for line in content.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "memory" => shape.memory = Some(value.to_string()),
            "cpus" => shape.cpus = Some(value.to_string()),
            "privileged" => shape.privileged = switch(value),
            "gpus" => shape.gpus = switch(value),
            // A key a newer ic wrote: ignored, as the channel record ignores one.
            _ => {}
        }
    }
    Ok((!shape.is_empty()).then_some(shape))
}

fn switch(value: &str) -> Option<bool> {
    match value {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

/// Save `shape` for the next restart, REPLACING whatever was saved before: what is saved is what was last
/// asked for, the whole of it, which is what a form that re-opens on the saved values sends back.
/// Temp-then-rename, like the channel record.
pub fn write(slug: &str, shape: &Reshape) -> Result<()> {
    write_file(&path(slug), shape)
}

fn write_file(path: &Path, shape: &Reshape) -> Result<()> {
    let dir = path.parent().expect("shape path has a parent");
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    if let Some(memory) = &shape.memory {
        writeln!(tmp, "memory={memory}")?;
    }
    if let Some(cpus) = &shape.cpus {
        writeln!(tmp, "cpus={cpus}")?;
    }
    for (key, value) in [("privileged", shape.privileged), ("gpus", shape.gpus)] {
        if let Some(on) = value {
            writeln!(tmp, "{key}={}", if on { "on" } else { "off" })?;
        }
    }
    tmp.persist(path).map_err(|err| err.error)?;
    Ok(())
}

/// Forget what is saved. Absent already is not an error: forgetting is idempotent.
pub fn clear(slug: &str) -> Result<()> {
    clear_file(&path(slug))
}

fn clear_file(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Fail(format!("could not remove {}: {err}", path.display()))),
    }
}

/// The saved share with `ask` laid over it: a field the ask names wins, a field it leaves falls through to what
/// was saved. What an immediate reshape applies, so a share saved for later is never silently dropped by a
/// reshape that happened to touch something else.
pub fn merged(saved: Option<&Reshape>, ask: &Reshape) -> Reshape {
    let base = saved.cloned().unwrap_or_default();
    Reshape {
        memory: ask.memory.clone().or(base.memory),
        cpus: ask.cpus.clone().or(base.cpus),
        privileged: ask.privileged.or(base.privileged),
        gpus: ask.gpus.or(base.gpus),
    }
}

/// The saved share in words, for the lines that say it was saved or is being applied.
pub fn describe(shape: &Reshape) -> String {
    let cap = |name: &str, value: &Option<String>| {
        value.as_ref().map(|value| {
            if value.is_empty() {
                format!("{name} default")
            } else {
                format!("{name} {value}")
            }
        })
    };
    let switch = |name: &str, value: Option<bool>| {
        value.map(|on| format!("{name} {}", if on { "on" } else { "off" }))
    };
    [
        cap("memory", &shape.memory),
        cap("cpus", &shape.cpus),
        switch("privileged", shape.privileged),
        switch("gpus", shape.gpus),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full() -> Reshape {
        Reshape {
            memory: Some("20g".to_string()),
            cpus: Some(String::new()),
            privileged: Some(false),
            gpus: Some(true),
        }
    }

    #[test]
    fn a_saved_shape_round_trips_with_default_and_off_kept_apart_from_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("sandbox-abc.shape");
        write_file(&file, &full()).expect("write");
        assert_eq!(
            std::fs::read_to_string(&file).expect("read"),
            "memory=20g\ncpus=\nprivileged=off\ngpus=on\n"
        );
        assert_eq!(read_file(&file).expect("read"), Some(full()));

        let memory_only = Reshape {
            memory: Some("8g".to_string()),
            ..Reshape::default()
        };
        write_file(&file, &memory_only).expect("write");
        assert_eq!(read_file(&file).expect("read"), Some(memory_only));
    }

    #[test]
    fn nothing_saved_reads_as_none_and_forgetting_twice_is_fine() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("sandbox-abc.shape");
        assert_eq!(read_file(&file).expect("read"), None);
        write_file(&file, &full()).expect("write");
        clear_file(&file).expect("clear");
        clear_file(&file).expect("clear again");
        assert_eq!(read_file(&file).expect("read"), None);
        // A file whose every line is unknown or unreadable saves nothing either.
        std::fs::write(&file, "future=1\nprivileged=maybe\n").expect("write");
        assert_eq!(read_file(&file).expect("read"), None);
    }

    #[test]
    fn an_immediate_ask_wins_field_by_field_over_what_was_saved() {
        let ask = Reshape {
            cpus: Some("4".to_string()),
            gpus: Some(false),
            ..Reshape::default()
        };
        assert_eq!(
            merged(Some(&full()), &ask),
            Reshape {
                memory: Some("20g".to_string()),
                cpus: Some("4".to_string()),
                privileged: Some(false),
                gpus: Some(false),
            }
        );
        assert_eq!(merged(None, &ask), ask);
    }

    #[test]
    fn a_shape_is_described_in_the_order_the_form_shows_it() {
        assert_eq!(
            describe(&full()),
            "memory 20g, cpus default, privileged off, gpus on"
        );
    }
}
