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

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{CheckMenuItem, MenuItem};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::scripts;

/// How often the engine is looked at.
const EVERY: Duration = Duration::from_secs(20);
/// Misses in a row before a start: one can be a port caught between two keepers.
const MISSES: u32 = 2;
/// How long a start may take: a first start after a reboot boots WSL's VM.
pub(crate) const START_LIMIT: Duration = Duration::from_secs(150);
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

/// Ours when this PC's sandboxes run on it, or a WSL distro uses it as its Docker (ic engine wsl enable).
pub(crate) fn ours() -> bool {
    scripts::engine_env().is_some() || scripts::engine_serves_wsl()
}

/* THE BACKGROUND SETTING, AS THIS APP CARRIES IT OUT (2026-11-24; ic's engine/background.rs has the setting itself).
 * This app open is what `whenOpen` waits for: its launch asks ic for the app's start, which starts the engine there and
 * lifts the hold its last quit left (and, in `always`, is the sign-in start once this app starts at sign-in). Its quit
 * stops the engine in `whenOpen` ([`before_exit`]). And an engine stopped under it, by a `wsl --shutdown` somebody ran,
 * is not fought: in `whenOpen` it is left stopped until somebody starts it, and in `always` it is started again, as that
 * setting promises, with one notification saying so and where to keep it stopped. */

fn run(app: AppHandle) {
    let mut keeper = Keeper::default();
    let mut was_down = false;
    // Up at a look since the last start: a miss after that is the engine stopped under this app, not one never started.
    let mut seen_up = false;
    let mut told_restart = false;
    if ours() && !crate::onboarding::setup_running() && !scripts::engine_move_running() {
        tell_starting(&app, true);
        let _ = scripts::start_our_engine_for_app(START_LIMIT);
        tell_starting(&app, false);
        show_at_sign_in();
    }
    tell_background(&app);
    let mut last_tray = tray_reading();
    loop {
        std::thread::sleep(EVERY);
        let ours = ours();
        let held = ours && scripts::engine_held();
        let moving = ours && scripts::engine_move_running();
        let setting_up = crate::onboarding::setup_running();
        let listening = ours && !held && !moving && scripts::our_engine_listening();
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
        if listening {
            seen_up = true;
        }
        let tray = tray_reading();
        if tray != last_tray {
            last_tray = tray;
            tell_background(&app);
        }
        if keeper.look(sight, Instant::now()) == Act::Nothing {
            continue;
        }
        if std::mem::take(&mut seen_up) {
            let vm_down = !distro_running(&scripts::engine_distro());
            match stopped_under_us(scripts::engine_mode().as_deref(), vm_down, told_restart) {
                UnderUs::LeaveStopped => {
                    if let Err(problem) = crate::engine::stop_until_app_opens() {
                        eprintln!("intentic: the engine WSL stopped could not be held down: {problem}");
                    }
                    keeper.started(true, Instant::now());
                    tell_background(&app);
                    continue;
                }
                UnderUs::RestartAndTell => {
                    told_restart = true;
                    tell_restarted(&app);
                }
                UnderUs::Restart => {}
            }
        }
        let attempt = keeper.attempt();
        emit(&app, "starting", None);
        tell_starting(&app, true);
        let began = Instant::now();
        let done = scripts::start_our_engine_for_app(START_LIMIT);
        tell_starting(&app, false);
        let seconds = began.elapsed().as_secs();
        keeper.started(done.is_ok(), Instant::now());
        match done {
            Ok(()) => {
                was_down = false;
                emit(&app, "running", None);
                crate::launch::note_engine_restart(&app, true, seconds, attempt, None);
            }
            Err(failure) => {
                was_down = true;
                emit(&app, "down", Some(failure.said.clone()));
                crate::launch::note_engine_restart(&app, false, seconds, attempt, Some(&failure));
            }
        }
    }
}

fn emit(app: &AppHandle, state: &'static str, reason: Option<String>) {
    let _ = app.emit(EVENT, EngineState { state, reason });
    tell_background(app);
}

/// In `always`, this app starts at sign-in too, so that whenever the engine runs its tray is there to say so and to
/// stop it: an engine that held gigabytes with no Intentic anywhere on screen is what this setting was made for. ic
/// drops the engine's own sign-in entry at its next start, since this app then starts the engine. Not from a build
/// run out of a checkout, which would put itself at sign-in, nor under a test engine (`IC_ENGINE_AUTOSTART=0`).
fn show_at_sign_in() {
    if cfg!(debug_assertions) || std::env::var("IC_ENGINE_AUTOSTART").as_deref() == Ok("0") {
        return;
    }
    if scripts::engine_mode().as_deref() == Some("always") && !crate::autostart::starts_at_login() {
        if let Err(problem) = crate::autostart::set_start_at_login(true) {
            eprintln!("intentic: the app could not be put at sign-in beside its engine: {problem}");
        }
    }
}

/// What to do about an engine stopped under this app.
#[derive(Debug, PartialEq, Eq)]
enum UnderUs {
    /// `whenOpen`, and the whole of WSL (or our distro) went: somebody stopped it, and it is theirs to start.
    LeaveStopped,
    /// `always`, after a `wsl --shutdown`: started again, as the setting promises, and said once.
    RestartAndTell,
    /// The engine fell over inside a running distro, or the restart was said already.
    Restart,
}

/// Pure: an engine that was up and is not, by the setting and whether its distro still runs. A setting not written yet is
/// `always`'s (a PC that never chose keeps doing what it did). `off` never gets here: its hold keeps the keeper away.
fn stopped_under_us(mode: Option<&str>, distro_down: bool, told: bool) -> UnderUs {
    match (mode.unwrap_or("always"), distro_down) {
        ("whenOpen", true) => UnderUs::LeaveStopped,
        ("always", true) if !told => UnderUs::RestartAndTell,
        _ => UnderUs::Restart,
    }
}

#[cfg(windows)]
fn distro_running(distro: &str) -> bool {
    crate::found::running_distros()
        .iter()
        .any(|(name, _)| name == distro)
}

#[cfg(not(windows))]
fn distro_running(_distro: &str) -> bool {
    true
}

/// The one notification after a `wsl --shutdown` in `always`: what happened, and where to keep it stopped.
fn tell_restarted(app: &AppHandle) {
    crate::notice::show(
        app,
        crate::setup_link::NoticeArgs {
            key: "engine-restarted".to_string(),
            kind: crate::setup_link::NoticeKind::Asks,
            title: "WSL was shut down, so Intentic started its engine again".to_string(),
            body: Some(
                "Intentic is set to keep your sandboxes running. To keep it stopped, choose Stop now or Off on This computer."
                    .to_string(),
            ),
            path: Some(crate::notice::THIS_DEVICE.to_string()),
            silent: false,
        },
    );
}

/// Every window's page is told the setting or the engine's state moved (This computer reloads it), and the tray says it.
pub const BACKGROUND_EVENT: &str = "desktop://engine-background";

pub(crate) fn tell_background(app: &AppHandle) {
    let _ = app.emit(BACKGROUND_EVENT, BackgroundPing { starting: None });
    refresh_tray(app);
}

/// What [`BACKGROUND_EVENT`] carries: `starting` while this app is starting the engine itself (its launch's start, the
/// keeper's restarts), so the page says "Starting…" rather than "Not running" with a Start under it.
#[derive(Clone, Serialize)]
struct BackgroundPing {
    #[serde(skip_serializing_if = "Option::is_none")]
    starting: Option<bool>,
}

fn tell_starting(app: &AppHandle, starting: bool) {
    let _ = app.emit(BACKGROUND_EVENT, BackgroundPing { starting: Some(starting) });
    if !starting {
        refresh_tray(app);
    }
}

/* THE TRAY'S ROWS FOR IT (lib.rs `create_tray`, on a PC whose sandboxes run on our engine): what runs now, Stop or
 * Start, and the setting as three choices, in place of "Start Intentic at login", which the setting now decides. */

pub const ROW_TOGGLE: &str = "engine-toggle";
pub const ROW_ALWAYS: &str = "engine-mode-always";
pub const ROW_WHEN_OPEN: &str = "engine-mode-when-open";
pub const ROW_OFF: &str = "engine-mode-off";

pub struct TrayEngine {
    pub status: MenuItem<Wry>,
    pub toggle: MenuItem<Wry>,
    pub always: CheckMenuItem<Wry>,
    pub when_open: CheckMenuItem<Wry>,
    pub off: CheckMenuItem<Wry>,
}

/// What the tray shows, read without spawning anything but a socket's connect: the setting, the hold, and whether
/// the engine answers.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayReading {
    mode: String,
    hold: Option<&'static str>,
    listening: bool,
}

fn tray_reading() -> TrayReading {
    let hold = scripts::engine_hold_kind();
    TrayReading {
        mode: scripts::engine_mode().unwrap_or_else(|| "always".to_string()),
        hold,
        listening: hold.is_none() && scripts::our_engine_listening(),
    }
}

/// Pure: the status row's words and the toggle row's.
fn tray_words(reading: &TrayReading) -> (&'static str, &'static str) {
    let status = match (reading.listening, reading.hold, reading.mode.as_str()) {
        (true, _, _) => "Sandboxes running",
        (false, Some("off"), _) | (false, None, "off") => "Intentic is off on this computer",
        (false, Some(_), _) => "Sandboxes stopped",
        (false, None, _) => "Sandboxes starting…",
    };
    let toggle = if reading.listening {
        "Stop sandboxes and engine"
    } else {
        "Start sandboxes"
    };
    (status, toggle)
}

/// The tray's rows made to say what is true now, off the calling thread.
pub fn refresh_tray(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(rows) = app.try_state::<TrayEngine>() else {
            return;
        };
        let reading = tray_reading();
        let (status, toggle) = tray_words(&reading);
        let _ = rows.status.set_text(status);
        let _ = rows.toggle.set_text(toggle);
        let _ = rows.always.set_checked(reading.mode == "always");
        let _ = rows.when_open.set_checked(reading.mode == "whenOpen");
        let _ = rows.off.set_checked(reading.mode == "off");
    });
}

/// A press on one of the tray's rows for it: Stop or Start, or a setting. Off the menu's thread; the rows are told the
/// outcome either way, so a choice that failed shows the setting as it still is.
pub fn tray_pressed(app: &AppHandle, row: &str) {
    let app = app.clone();
    let row = row.to_string();
    std::thread::spawn(move || {
        let done = match row.as_str() {
            ROW_TOGGLE if tray_reading().listening => crate::engine::stop_now_blocking(),
            ROW_TOGGLE => scripts::start_our_engine(false, START_LIMIT).map_err(|failure| failure.said),
            ROW_ALWAYS => crate::engine::set_mode_blocking("always"),
            ROW_WHEN_OPEN => crate::engine::set_mode_blocking("whenOpen"),
            ROW_OFF => crate::engine::set_mode_blocking("off"),
            _ => Ok(()),
        };
        if let Err(problem) = done {
            eprintln!("intentic: the tray's {row} did not go through: {problem}");
        }
        tell_background(&app);
    });
}

/* QUITTING (windows/quit.rs asks; lib.rs carries it out at the exit). In `whenOpen` a quit stops the engine, held until
 * this app's next start; in `always` it keeps running, unless the person quitting said to stop it this time. The first
 * quit says which, once, with the other way at hand. */

/// The quit said to stop the engine this time.
static QUIT_STOPS: AtomicBool = AtomicBool::new(false);
/// The exit is a restart (an update): the app is back in a moment, and the engine stays as it is.
static RESTARTING: AtomicBool = AtomicBool::new(false);

pub fn quit_stops_engine() {
    QUIT_STOPS.store(true, Ordering::SeqCst);
}

/// The exit's code, as the app heard it asked for.
pub fn exiting(code: i32) {
    RESTARTING.store(code == tauri::RESTART_EXIT_CODE, Ordering::SeqCst);
}

/// Pure: whether the exit stops the engine: never at a restart; when the quit said so; and in `whenOpen` unless the
/// quit said to keep it running this time.
fn stops_at_exit(mode: Option<&str>, quit_said_stop: bool, quit_said_keep: bool, restarting: bool) -> bool {
    !restarting && (quit_said_stop || (mode == Some("whenOpen") && !quit_said_keep))
}

/// At the app's exit (lib.rs `RunEvent::Exit`, a sign-out's included): the engine stopped and held until this app's next
/// start when the setting or the quit says so. BLOCKING for the few seconds `wsl --terminate` takes.
pub fn before_exit() {
    if !cfg!(windows) || !ours() {
        return;
    }
    let stop = stops_at_exit(
        scripts::engine_mode().as_deref(),
        QUIT_STOPS.load(Ordering::SeqCst),
        QUIT_KEEPS.load(Ordering::SeqCst),
        RESTARTING.load(Ordering::SeqCst),
    );
    if stop {
        if let Err(problem) = crate::engine::stop_until_app_opens() {
            eprintln!("intentic: the engine did not stop with the app: {problem}");
        }
    }
}

/// The question the first quit asks while the engine runs, by the setting: its title, what it says, the button for the
/// setting's own way and the one for the other way this time. None when nothing is worth asking (`off`, or the engine
/// down). Pure.
pub fn quit_question(mode: Option<&str>, running: bool) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    if !running {
        return None;
    }
    match mode.unwrap_or("always") {
        "always" => Some((
            "Keep your sandboxes running?",
            "Intentic is set to keep the sandboxes on this computer running, so you can still reach them from the browser after you quit. You can change this on This computer.",
            "Keep them running",
            "Stop them too",
        )),
        "whenOpen" => Some((
            "Stop your sandboxes?",
            "Intentic is set to run only while it's open, so quitting stops the sandboxes on this computer. You can change this on This computer.",
            "Stop them",
            "Keep them running this time",
        )),
        _ => None,
    }
}

/// The setting's own way at a quit, for the answer to [`quit_question`]: whether "the other way" means stopping.
pub fn other_way_stops(mode: Option<&str>) -> bool {
    mode.unwrap_or("always") == "always"
}

/// In `whenOpen`, "Keep them running this time": this exit leaves the engine up.
static QUIT_KEEPS: AtomicBool = AtomicBool::new(false);

pub fn quit_keeps_engine() {
    QUIT_KEEPS.store(true, Ordering::SeqCst);
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
    fn an_engine_stopped_under_the_app_follows_the_setting() {
        // A `wsl --shutdown` under an app set to run it only while open: left for the person to start.
        assert_eq!(stopped_under_us(Some("whenOpen"), true, false), UnderUs::LeaveStopped);
        // The same under `always` (or a PC that never chose): started again, and said once.
        assert_eq!(stopped_under_us(Some("always"), true, false), UnderUs::RestartAndTell);
        assert_eq!(stopped_under_us(None, true, false), UnderUs::RestartAndTell);
        assert_eq!(stopped_under_us(Some("always"), true, true), UnderUs::Restart);
        // dockerd fell over in a distro still running: a fault, put right whatever the setting.
        assert_eq!(stopped_under_us(Some("whenOpen"), false, false), UnderUs::Restart);
        assert_eq!(stopped_under_us(Some("always"), false, false), UnderUs::Restart);
    }

    #[test]
    fn a_quit_stops_the_engine_by_the_setting_and_the_answer() {
        assert!(stops_at_exit(Some("whenOpen"), false, false, false));
        assert!(!stops_at_exit(Some("whenOpen"), false, true, false));
        assert!(!stops_at_exit(Some("always"), false, false, false));
        assert!(stops_at_exit(Some("always"), true, false, false));
        assert!(!stops_at_exit(None, false, false, false));
        // An update's restart is back in a moment: nothing stops.
        assert!(!stops_at_exit(Some("whenOpen"), true, false, true));
    }

    #[test]
    fn the_first_quit_asks_only_while_there_is_something_running() {
        assert!(quit_question(Some("always"), false).is_none());
        assert!(quit_question(Some("off"), true).is_none());
        let (_, said, own, other) = quit_question(Some("always"), true).unwrap();
        assert!(said.contains("still reach them"));
        assert_eq!((own, other), ("Keep them running", "Stop them too"));
        assert!(other_way_stops(Some("always")));
        let (_, said, _, other) = quit_question(Some("whenOpen"), true).unwrap();
        assert!(said.contains("quitting stops"));
        assert_eq!(other, "Keep them running this time");
        assert!(!other_way_stops(Some("whenOpen")));
    }

    #[test]
    fn the_tray_says_what_runs_and_offers_the_other_way() {
        let reading = |mode: &str, hold: Option<&'static str>, listening: bool| TrayReading {
            mode: mode.to_string(),
            hold,
            listening,
        };
        assert_eq!(tray_words(&reading("always", None, true)), ("Sandboxes running", "Stop sandboxes and engine"));
        assert_eq!(tray_words(&reading("off", Some("off"), false)).0, "Intentic is off on this computer");
        assert_eq!(tray_words(&reading("whenOpen", Some("closed"), false)), ("Sandboxes stopped", "Start sandboxes"));
        assert_eq!(tray_words(&reading("always", None, false)).0, "Sandboxes starting…");
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
