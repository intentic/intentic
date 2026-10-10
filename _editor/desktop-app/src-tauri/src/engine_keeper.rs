//! KEEPING INTENTIC'S ENGINE UP (2026-10-09).
//!
//! Docker Desktop supervises its own VM. Our engine is a `dockerd` kept alive by one `wsl.exe` that `ic engine start`
//! left running, and anything that ends it ends every sandbox on the PC: a `wsl --shutdown` some other tool ran, a
//! Windows update, a crash. The sign-in start (the Run key) brings it back once a day, and the machine agent's
//! `ic sandbox fix` once a sandbox has stopped answering long enough to be noticed. This app is open on the PCs that
//! matter most, so it looks every 20 seconds and starts the engine itself after two misses in a row.
//!
//! It only ever starts an engine this PC's sandboxes run on (engine.json `active`), never one stopped on purpose
//! (`held`), never during a move between engines or a setup, and with `--quiet`, which leaves all of those alone in
//! ic as well. A start that fails waits longer each time before the next (one, two, five, then fifteen minutes): an
//! engine that will not come up gets a person's attention through the card, not a start every 20 seconds.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::scripts;

/// How often the engine is looked at.
const EVERY: Duration = Duration::from_secs(20);
/// Misses in a row before a start: one can be a port caught between two keepers.
const MISSES: u32 = 2;
/// How long a start may take: a first start after a reboot boots WSL's VM.
const START_LIMIT: Duration = Duration::from_secs(150);
/// Seconds to wait after a failed start, by how many failed in a row.
const BACKOFF: [u64; 4] = [60, 120, 300, 900];

/// The event the windows hear the keeper's state on.
pub const EVENT: &str = "desktop://engine";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineState {
    /// `running`, `starting`, or `down` (a start failed; `reason` says why).
    pub state: &'static str,
    pub reason: Option<String>,
}

/// What the keeper sees on one look.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sight {
    /// This PC's sandboxes run on our engine.
    pub ours: bool,
    pub held: bool,
    pub moving: bool,
    pub setting_up: bool,
    pub listening: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Act {
    Nothing,
    Start,
}

/// The keeper's memory between looks. Pure, so the rules are tested without an engine.
#[derive(Debug, Default)]
pub struct Keeper {
    misses: u32,
    failures: u32,
    not_before: Option<Instant>,
}

impl Keeper {
    pub fn look(&mut self, sight: Sight, now: Instant) -> Act {
        if !sight.ours || sight.held || sight.moving || sight.setting_up || sight.listening {
            self.misses = 0;
            if sight.listening {
                self.failures = 0;
                self.not_before = None;
            }
            return Act::Nothing;
        }
        self.misses += 1;
        if self.misses < MISSES || self.not_before.is_some_and(|until| now < until) {
            return Act::Nothing;
        }
        Act::Start
    }

    pub fn started(&mut self, ok: bool, now: Instant) {
        self.misses = 0;
        if ok {
            self.failures = 0;
            self.not_before = None;
        } else {
            let wait = BACKOFF[(self.failures as usize).min(BACKOFF.len() - 1)];
            self.failures += 1;
            self.not_before = Some(now + Duration::from_secs(wait));
        }
    }

    pub fn attempt(&self) -> u32 {
        self.failures + 1
    }
}

pub fn start(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("engine-keeper".into())
        .spawn(move || run(app));
}

fn run(app: AppHandle) {
    let mut keeper = Keeper::default();
    let mut was_down = false;
    loop {
        std::thread::sleep(EVERY);
        let ours = scripts::engine_env().is_some();
        let held = ours && scripts::engine_held();
        let moving = ours && scripts::engine_move_running();
        let setting_up = crate::onboarding::setup_running();
        let listening = ours && !held && !moving && scripts::engine_listening();
        let sight = Sight {
            ours,
            held,
            moving,
            setting_up,
            listening,
        };
        if listening && was_down {
            was_down = false;
            emit(&app, "running", None);
        }
        if keeper.look(sight, Instant::now()) == Act::Nothing {
            continue;
        }
        let attempt = keeper.attempt();
        emit(&app, "starting", None);
        let began = Instant::now();
        let done = scripts::start_our_engine(true, START_LIMIT);
        let seconds = began.elapsed().as_secs();
        keeper.started(done.is_ok(), Instant::now());
        match done {
            Ok(()) => {
                was_down = false;
                emit(&app, "running", None);
                crate::launch::note_engine_restart(&app, true, seconds, attempt, None);
            }
            Err(reason) => {
                was_down = true;
                emit(&app, "down", Some(reason.clone()));
                crate::launch::note_engine_restart(&app, false, seconds, attempt, Some(reason));
            }
        }
    }
}

fn emit(app: &AppHandle, state: &'static str, reason: Option<String>) {
    let _ = app.emit(EVENT, EngineState { state, reason });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn down() -> Sight {
        Sight {
            ours: true,
            ..Sight::default()
        }
    }

    #[test]
    fn two_misses_in_a_row_start_it_and_one_does_not() {
        let mut keeper = Keeper::default();
        let now = Instant::now();
        assert_eq!(keeper.look(down(), now), Act::Nothing);
        assert_eq!(keeper.look(down(), now), Act::Start);
    }

    #[test]
    fn an_engine_that_answers_in_between_resets_the_count() {
        let mut keeper = Keeper::default();
        let now = Instant::now();
        assert_eq!(keeper.look(down(), now), Act::Nothing);
        let up = Sight {
            listening: true,
            ..down()
        };
        assert_eq!(keeper.look(up, now), Act::Nothing);
        assert_eq!(keeper.look(down(), now), Act::Nothing);
    }

    #[test]
    fn nothing_is_started_that_is_not_ours_to_start() {
        let now = Instant::now();
        for sight in [
            Sight::default(),
            Sight {
                held: true,
                ..down()
            },
            Sight {
                moving: true,
                ..down()
            },
            Sight {
                setting_up: true,
                ..down()
            },
        ] {
            let mut keeper = Keeper::default();
            for _ in 0..5 {
                assert_eq!(keeper.look(sight, now), Act::Nothing, "{sight:?}");
            }
        }
    }

    #[test]
    fn a_failed_start_waits_longer_each_time() {
        let mut keeper = Keeper::default();
        let now = Instant::now();
        keeper.look(down(), now);
        assert_eq!(keeper.look(down(), now), Act::Start);
        keeper.started(false, now);
        keeper.look(down(), now);
        assert_eq!(
            keeper.look(down(), now + Duration::from_secs(30)),
            Act::Nothing
        );
        assert_eq!(
            keeper.look(down(), now + Duration::from_secs(61)),
            Act::Start
        );
        keeper.started(false, now + Duration::from_secs(61));
        keeper.look(down(), now + Duration::from_secs(62));
        assert_eq!(
            keeper.look(down(), now + Duration::from_secs(61 + 119)),
            Act::Nothing
        );
        assert_eq!(keeper.attempt(), 3);
        keeper.started(true, now + Duration::from_secs(400));
        assert_eq!(keeper.attempt(), 1);
    }
}
