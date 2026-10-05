use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use crate::sandbox::inside;

/* PICKING UP WHAT A RESTART CUTS. A restart from outside reads, inside the sandbox, like a crash: every agent turn it
cuts is recorded as interrupted and waits in Attention for a message (audit 2026-10, class 5). The daemon already honours
one ask to resume them: `/history/restart-resume.json`, `{"askedAt": <ms>}`, read once by its next boot and good for two
hours (the daemon's agent/run/turn/restart-resume.ts). Its own owner paths write it; ic now writes it too, before every
restart or recreate it makes of a running sandbox (a fix's restart, `ic sandbox restart`, an update, a rollback, a
rebuild, a reshape, the probation going back), so a turn a restart cut runs again on the far side of it. `askedAt` is the
container's own clock, since the daemon compares it with its own. A person who would rather the cut turns wait for them
passes `--no-resume`, which also withdraws an ask still standing from an earlier restart, as the daemon's own unticked
box does. */

pub const FILE: &str = "/history/restart-resume.json";

static ASKED: AtomicBool = AtomicBool::new(true);

/// `--no-resume`: the restarts of this run leave what they cut for a person.
pub fn decline() {
    ASKED.store(false, Ordering::SeqCst);
}

/// What the file says for this run's restarts: the ask, its moment left for `inside` to fill in, or the empty
/// document that withdraws one. Pure.
pub fn body(asked: bool) -> Value {
    if asked {
        json!({ "askedAt": inside::NOW })
    } else {
        json!({})
    }
}

/// Before ic restarts or recreates `container`: ask its next boot to resume the turns this cuts. Nothing for a
/// container that is not running, which has no turn to cut. Best-effort: the restart is the point, and a container too
/// wedged to take the file is about to be restarted anyway. Returns whether the ask was left.
pub fn ask(container: &str) -> bool {
    if !inside::running(container) {
        return false;
    }
    let asked = ASKED.load(Ordering::SeqCst);
    let written = inside::write_stamped(container, FILE, &body(asked)).is_some();
    written && asked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ask_is_the_daemons_own_shape_and_declining_withdraws_it() {
        let asked: Value =
            serde_json::from_str(&inside::stamp(&body(true).to_string(), 1_791_240_330_000))
                .expect("JSON");
        assert_eq!(asked, json!({ "askedAt": 1_791_240_330_000u64 }));
        assert_eq!(body(false), json!({}));
    }
}
