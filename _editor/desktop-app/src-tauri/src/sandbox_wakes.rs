//! `intentic://sandbox-wakes`: THE WORKSPACE FOUND ITS SANDBOX ASLEEP, AND THIS COMPUTER STARTS IT AT ONCE.
//!
//! A sandbox nobody used for a while is put to sleep by its machine's keeper (`ic sandbox sleep`), and a page that finds
//! it so asks the platform to wake it. The platform never calls a machine: the machine agent collects such requests on
//! its own poll, every fifteen seconds while anything there sleeps (`ic sandbox wakes`). When the app is on that same
//! computer, the page tells it right after asking, and the app collects them now with the very same command, so the
//! wait is a start and a boot rather than a poll as well.
//!
//! The link carries nothing: `ic` starts only what the platform says somebody asked for, so a page can neither name a
//! sandbox to start nor start one nobody asked for. A sandbox asleep on another computer is found by no `ic` here and
//! costs one look at this computer's own records; the keeper over there collects it as ever.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// `ic sandbox wakes` as this app runs it; `--source app` is what its report to the platform says ran it.
const ARGS: [&str; 5] = ["sandbox", "wakes", "--json", "--source", "app"];

/// How long one collection may take: the machine agent's deadline for the same command (`WAKES_DEADLINE_MS` in its
/// sandbox-rounds/sleep.ts), since a start may apply a saved shape, which recreates the container.
const LIMIT: Duration = Duration::from_secs(300);

/// Whether a collection is running.
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Whether a page asked since the running collection began: that one may have asked the platform before the newer
/// request was stamped, so one more follows it.
static ASKED: AtomicBool = AtomicBool::new(false);

/// Collects this computer's wake requests now, on a thread of its own, and returns at once. Asks that land while one
/// runs make one more after it, never one each.
pub fn requested() {
    ASKED.store(true, Ordering::SeqCst);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        while ASKED.swap(false, Ordering::SeqCst) {
            if let Err(error) = crate::scripts::run_ic_quietly(&ARGS, LIMIT) {
                eprintln!("ic sandbox wakes: {error}");
            }
        }
        RUNNING.store(false, Ordering::SeqCst);
        // An ask that landed between the loop's last look and the line above.
        if ASKED.load(Ordering::SeqCst) {
            requested();
        }
    });
}
