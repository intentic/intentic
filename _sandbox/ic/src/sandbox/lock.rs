use std::collections::HashSet;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::logfile::intentic_home;
use crate::util::{bail, Fail, Result};

/* ONE ic AT A TIME PER SANDBOX. A person's `ic sandbox update` in a terminal, the machine agent's background prepare and
its probation watch, and the desktop app's buttons are separate processes, and two swaps interleaved on one sandbox can
delete each other's parked container or write each other's record over. */

/// How long a person's command waits for another ic run on the same sandbox. A swap that builds an environment overlay
/// can take many minutes; past this, something is stuck rather than slow.
const WAIT_LIMIT: Duration = Duration::from_secs(60 * 60);
const WAIT_STEP: Duration = Duration::from_secs(2);

/// Slugs this process already holds. The lock is advisory and per open file, so a flow that calls another flow on the
/// same sandbox (a start that applies a saved shape through a reshape, a watch that rolls back) would otherwise wait
/// on itself forever.
static HELD: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// A held sandbox lock, released when dropped. `file` is None when this process already held it further up the stack.
pub struct Held {
    slug: String,
    file: Option<File>,
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = file.unlock();
            if let Ok(mut held) = HELD.lock() {
                if let Some(set) = held.as_mut() {
                    set.remove(&self.slug);
                }
            }
        }
    }
}

/// Whether a caller waits for the sandbox or gives up at once: a person waits, a background tick comes back later.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    Block,
    Skip,
}

fn path(slug: &str) -> PathBuf {
    intentic_home()
        .join("locks")
        .join(format!("sandbox-{slug}.lock"))
}

fn already_held(slug: &str) -> bool {
    HELD.lock()
        .ok()
        .and_then(|held| held.as_ref().map(|set| set.contains(slug)))
        .unwrap_or(false)
}

fn remember(slug: &str) {
    if let Ok(mut held) = HELD.lock() {
        held.get_or_insert_with(HashSet::new)
            .insert(slug.to_string());
    }
}

/// Take the sandbox's lock. `Ok(None)` only with `Wait::Skip`, when another ic run holds it. The lock lives in this
/// user's ic home, so it orders the runs that share that home: an ic run from another account, or from the other side
/// of a Windows/WSL machine, has a home of its own.
pub fn hold(slug: &str, wait: Wait) -> Result<Option<Held>> {
    if already_held(slug) {
        return Ok(Some(Held {
            slug: slug.to_string(),
            file: None,
        }));
    }
    let path = path(slug);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|err| Fail(format!("could not create {}: {err}", dir.display())))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|err| Fail(format!("could not open {}: {err}", path.display())))?;
    let started = Instant::now();
    let mut told = false;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(TryLockError::WouldBlock) => {
                if wait == Wait::Skip {
                    return Ok(None);
                }
                if !told {
                    println!(
                        "intentic: another ic run is working on {slug} — waiting for it to finish…"
                    );
                    told = true;
                }
                if started.elapsed() >= WAIT_LIMIT {
                    bail!(
                        "another ic run has held {slug} for over {} minutes, so this one gave up without changing anything. If nothing is running, remove {} and try again.",
                        WAIT_LIMIT.as_secs() / 60,
                        path.display()
                    );
                }
                std::thread::sleep(WAIT_STEP);
            }
            // A filesystem that cannot lock at all (some network mounts) must not stop every flow: run unordered, as
            // every ic before the lock did.
            Err(TryLockError::Error(_)) => break,
        }
    }
    remember(slug);
    Ok(Some(Held {
        slug: slug.to_string(),
        file: Some(file),
    }))
}

/// A person's lock: wait for it, and fail only when waiting was pointless.
pub fn hold_for_person(slug: &str) -> Result<Held> {
    hold(slug, Wait::Block)?.ok_or_else(|| Fail(format!("{slug} is busy with another ic run.")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /* No env mutation here: INTENTIC_HOME is process-global and tests run in parallel, so the lock file is exercised
    directly and the re-entrancy set by its own rules. */

    #[test]
    fn a_second_holder_in_another_handle_is_refused_while_the_first_holds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sandbox-x.lock");
        let first = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .expect("open");
        first.try_lock().expect("the first handle takes it");
        let second = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .expect("open");
        assert!(matches!(second.try_lock(), Err(TryLockError::WouldBlock)));
        first.unlock().expect("unlock");
        second
            .try_lock()
            .expect("free again once the first lets go");
    }

    #[test]
    fn a_process_that_holds_a_sandbox_is_let_through_again_instead_of_waiting_on_itself() {
        let slug = "reentrant-test-slug";
        remember(slug);
        assert!(already_held(slug));
        {
            let inner = hold(slug, Wait::Skip).expect("hold").expect("let through");
            assert!(
                inner.file.is_none(),
                "the inner hold owns no file, so dropping it releases nothing"
            );
        }
        assert!(already_held(slug), "the outer hold still stands");
        if let Ok(mut held) = HELD.lock() {
            held.get_or_insert_with(HashSet::new).remove(slug);
        }
    }
}
