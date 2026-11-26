/* THE QUIT CARD (2026-11-25): every question a close or a quit asks, on ONE card in the app's own look.
 *
 * A quit used to ask in native message boxes, one after another: unsaved windows, then agents at work, then work under
 * way ("Intentic is still a task on this computer on this computer"), then what happens to the sandboxes, each a grey
 * Windows box with three buttons, and the × card (the one in the app's own look) could be followed by all four. The
 * sandboxes box was asked once, but its "Stop them too" held for that one quit only, so the next quit quietly did the
 * opposite of what had been answered.
 *
 * Now a close or a quit gathers what it would interrupt as facts ([`Card`]), and the confirm-close window draws them all
 * at once (`QuitCard.vue`, which has the words in every language): one card, each thing under way a row with what quitting
 * does to it, and the answers as whole outcomes pressed once. The × card is the same card with "Keep Intentic in the
 * tray" among its answers, so choosing Quit there asks nothing more.
 *
 * What is answered is remembered where it can be. The sandboxes question is the background setting itself (ic's
 * `engine mode`): asked only where nobody has ever chosen one, and "Stop them" is `whenOpen` from then on. The answer about
 * work under way is kept when "always do this" is ticked ([`QuitBusy`]), but never over unsaved changes or a move between
 * engines, which a quit would lose. Work the person never started (the machine agent put in place ahead) is not asked
 * about at all. */

use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, Mutex, PoisonError};
use tauri::{AppHandle, Manager};

use crate::state::{AppState, CloseAction, QuitBusy};

/// What a close or a quit would interrupt, as facts: the page has the words.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    /// The ×'s question: keeping the app in the tray is one of the answers.
    pub from_close: bool,
    /// Local windows holding unsaved changes: lost by a quit.
    pub unsaved: usize,
    /// Agent turns running on this computer: they stop with the app.
    pub agents: usize,
    /// Work under way, in the order it is named.
    pub work: Vec<Work>,
    /// A setup is moving this PC's sandboxes between engines, and a quit stops the move.
    pub moving: bool,
    /// What a quit does to the sandboxes on this computer.
    pub sandboxes: Sandboxes,
}

/// What a quit does to the sandboxes on this computer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sandboxes {
    /// Nothing of this computer's runs that a quit could stop: nothing to say.
    #[default]
    Idle,
    /// They keep running (the setting is `always`, or they run on Docker Desktop, or on another computer).
    Keep,
    /// They stop with the app until it opens again (`whenOpen`).
    Stop,
    /// They run, and nobody has chosen: the card asks, once.
    Ask,
}

/// One piece of work under way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    /// `setup` (a quit stops it), `power`, `update`, `remove`, `fix`, `move`, `sync`, `system`, `drive`, `pair`,
    /// `bringBack`, or `other`: each carries on by itself.
    pub kind: &'static str,
    /// The sandbox it is about, for the kinds about one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
}

impl Card {
    /// Something a quit could wait for.
    pub fn busy(&self) -> bool {
        self.agents > 0 || !self.work.is_empty() || self.moving
    }

    /// Anything to ask at all.
    pub fn asks(&self) -> bool {
        self.from_close || self.unsaved > 0 || self.busy() || self.sandboxes == Sandboxes::Ask
    }

    /// Whether "always do this" may retire the question about work under way: never over what a quit loses.
    pub fn remembers_busy(&self) -> bool {
        self.busy() && self.unsaved == 0 && !self.moving
    }

    /// The sandboxes question waits for a quit that has nothing else to ask: beside work under way it would be a second
    /// decision on the card. Until then a quit does what the unchosen setting does, which is keep them running.
    fn settled(mut self) -> Card {
        if self.sandboxes == Sandboxes::Ask && (self.busy() || self.unsaved > 0) {
            self.sandboxes = Sandboxes::Keep;
        }
        self
    }
}

/// What a quit makes of a card, before anything is drawn. Pure.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing to ask: the quit goes ahead.
    Go,
    /// Answered already ("always do this").
    Do(Choice),
    /// The card asks.
    Ask,
}

/// `remembered` is the kept answer about work under way; `waiting` says a "quit when it's done" is being waited out, and a
/// quit then means now.
pub fn decide(card: &Card, remembered: Option<QuitBusy>, waiting: bool) -> Decision {
    if !card.asks() {
        return Decision::Go;
    }
    if card.from_close || card.sandboxes == Sandboxes::Ask || !card.remembers_busy() {
        return Decision::Ask;
    }
    match remembered {
        Some(QuitBusy::Now) => Decision::Do(Choice::Now),
        Some(QuitBusy::Wait) if waiting => Decision::Do(Choice::Now),
        Some(QuitBusy::Wait) => Decision::Do(Choice::Wait),
        None => Decision::Ask,
    }
}

/// The card's answer. Cancelling is not one: it is the card's window closing ([`gone`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    /// The faces to the tray, the app staying up (the × card only).
    Tray,
    /// Wait in the tray for the work under way, then quit.
    Wait,
    /// Quit now.
    Now,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub choice: Choice,
    /// The sandboxes question's answer, when the card asked it: whether they keep running after a quit.
    #[serde(default)]
    pub keep_sandboxes: Option<bool>,
    /// "Always do this: don't ask again".
    #[serde(default)]
    pub remember: bool,
}

/// What an answer leaves behind. Pure, from the card it answered.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Kept {
    /// What the × does from now on.
    pub close: Option<CloseAction>,
    /// What a quit does about work under way from now on.
    pub busy: Option<QuitBusy>,
    /// The sandboxes question's answer: keep them running (`true`) or stop them with the app.
    pub sandboxes: Option<bool>,
}

pub fn kept(card: &Card, answer: &Answer) -> Kept {
    let quits = answer.choice != Choice::Tray;
    Kept {
        close: (card.from_close && answer.remember).then_some(if quits {
            CloseAction::Quit
        } else {
            CloseAction::Tray
        }),
        busy: (answer.remember && quits && card.remembers_busy()).then_some(
            if answer.choice == Choice::Wait {
                QuitBusy::Wait
            } else {
                QuitBusy::Now
            },
        ),
        sandboxes: if quits && card.sandboxes == Sandboxes::Ask {
            answer.keep_sandboxes
        } else {
            None
        },
    }
}

/// What a quit does to the sandboxes on this computer, by the background setting, whether its engine answers, and
/// whether the question was answered before. Pure. A setting not written yet behaves as `always`.
pub fn sandboxes_of(mode: Option<&str>, running: bool, told: bool) -> Sandboxes {
    if !running {
        return Sandboxes::Idle;
    }
    match mode {
        Some("whenOpen") => Sandboxes::Stop,
        None if !told => Sandboxes::Ask,
        _ => Sandboxes::Keep,
    }
}

/// The work under way a quit asks about, out of this app's runs and whether a folder's bring-back is going. A folder's own
/// sandbox's setup is not asked about (a quit stops it and the next launch runs it again by design, folder_setup.rs
/// `before_exit`), and neither is the machine agent put in place ahead (agent_install.rs): nobody started it, and a setup
/// fetches it itself. Pure.
pub fn work_of(runs: &[String], project_busy: bool) -> Vec<Work> {
    let mut work: Vec<Work> = runs.iter().filter_map(|run| work_said(run)).collect();
    if project_busy {
        work.push(Work {
            kind: "bringBack",
            sandbox: None,
        });
    }
    work.dedup();
    work
}

fn work_said(run: &str) -> Option<Work> {
    if run.starts_with(crate::folder_setup::RUN_PREFIX) || run == crate::agent_install::RUN {
        return None;
    }
    let (verb, about) = match run.split_once(':') {
        Some((verb, about)) => (verb, Some(about)),
        None => (run, None),
    };
    let kind = match verb {
        "setup" => "setup",
        "power" => "power",
        "recreate" => "update",
        "remove" => "remove",
        // This device's move (engine.rs) or Repair's: every sandbox stopped in turn while its files are copied.
        "engine-move" | "repair-engine-move" => "move",
        // Fix, and Repair's own verbs on a sandbox (`repair-start:work`, `repair-rollback:work`).
        "fix" => "fix",
        repair if repair.starts_with("repair-") => "fix",
        "sync-setup" | "project-sync" => "sync",
        // A change to Intentic OS from This device (os.rs): a download, a rollback queued, a restart on its way.
        "os-update" | "os-rollback" | "os-channel" | "os-reboot" => "system",
        "os-drive-import" => "drive",
        "device-pair" => "pair",
        _ => "other",
    };
    let sandbox = match kind {
        "power" | "update" | "remove" | "fix" => {
            about.filter(|slug| !slug.is_empty()).map(str::to_string)
        }
        _ => None,
    };
    Some(Work { kind, sandbox })
}

/* ASKING: the card up, what it asked, and the exit it holds. */

struct Asking {
    card: Card,
    code: i32,
}

static ASKING: LazyLock<Mutex<Option<Asking>>> = LazyLock::new(Mutex::default);

fn asking() -> std::sync::MutexGuard<'static, Option<Asking>> {
    ASKING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a close or a quit would interrupt now.
fn gather(app: &AppHandle, from_close: bool) -> Card {
    let runs = crate::scripts::running_ids();
    Card {
        from_close,
        unsaved: super::unsaved::unsaved_windows(),
        agents: crate::host_agents::running(),
        work: work_of(&runs, crate::project::busy()),
        moving: !super::quit::moves_stopped(&runs, crate::scripts::moving).is_empty(),
        sandboxes: sandboxes_now(app),
    }
    .settled()
}

fn sandboxes_now(app: &AppHandle) -> Sandboxes {
    if !cfg!(windows) || !crate::engine_keeper::ours() {
        return Sandboxes::Keep;
    }
    let running =
        crate::scripts::engine_hold_kind().is_none() && crate::scripts::our_engine_listening();
    sandboxes_of(
        crate::scripts::engine_mode().as_deref(),
        running,
        app.state::<AppState>().quit_engine_told(),
    )
}

/// The × with nothing chosen yet, or a quit (`from_close` false) exiting with `code`: decided, done, or asked on the card.
/// `true` means the exit is held for an answer, or was taken care of.
pub fn ask(app: &AppHandle, from_close: bool, code: i32) -> bool {
    if asking().is_some() {
        // Asked again while the card is up: put it back on screen rather than a second one.
        let _ = super::close::show_card(app, None);
        return true;
    }
    let card = gather(app, from_close);
    let remembered = app.state::<AppState>().quit_busy();
    match decide(&card, remembered, super::quit::waiting()) {
        Decision::Go => false,
        Decision::Do(choice) => {
            carry_out(app, &card, code, choice);
            true
        }
        Decision::Ask => {
            let script = format!(
                "window.__INTENTIC_QUIT_CARD__ = {};",
                serde_json::to_string(&card).unwrap_or_else(|_| "null".into())
            );
            *asking() = Some(Asking {
                card: card.clone(),
                code,
            });
            if let Err(problem) = super::close::show_card(app, Some(script)) {
                eprintln!("intentic: the quit card failed to open: {problem}");
                asking().take();
                fall_back(app, &card, code);
            }
            true
        }
    }
}

/// The card could not be drawn. A close goes to the tray, as it always fell through; a quit goes ahead when it loses
/// nothing (waiting out what runs), and otherwise the app stays: a quit that seems ignored is recoverable, lost work is not.
fn fall_back(app: &AppHandle, card: &Card, code: i32) {
    if card.from_close {
        super::close::hide_faces(app);
    } else if card.unsaved == 0 && !card.moving {
        let choice = if card.busy() {
            Choice::Wait
        } else {
            Choice::Now
        };
        carry_out(app, card, code, choice);
    } else {
        super::quit::quit_cancelled();
    }
}

/// The card's window is gone without an answer (its ×, Escape, Alt+F4): the app stays as it was.
pub(super) fn gone() {
    if asking().take().is_some() {
        super::quit::quit_cancelled();
    }
}

/// The card's answer, from the one command it can call. Off the calling webview's thread, since answering destroys it, and
/// since a sandboxes answer may wait on ic.
#[tauri::command]
pub fn quit_card_answer(app: AppHandle, answer: Answer) {
    std::thread::spawn(move || resolve(&app, answer));
}

fn resolve(app: &AppHandle, answer: Answer) {
    let Some(Asking { card, code }) = asking().take() else {
        return;
    };
    // Before anything it is about moves, so the two never animate against each other.
    if let Some(window) = app.get_webview_window(super::close::CONFIRM_CLOSE) {
        let _ = window.destroy();
    }
    let state = app.state::<AppState>();
    let kept = kept(&card, &answer);
    if let Some(action) = kept.close {
        state.remember_close_action(action);
    }
    if let Some(busy) = kept.busy {
        state.remember_quit_busy(busy);
    }
    if let Some(keep) = kept.sandboxes {
        answer_sandboxes(app, keep);
    }
    carry_out(app, &card, code, answer.choice);
}

/// The sandboxes question answered: it is the background setting from now on, and never asked again. "Stop them" is
/// `whenOpen`, and this quit stops them whether or not ic took the setting.
fn answer_sandboxes(app: &AppHandle, keep: bool) {
    app.state::<AppState>().remember_quit_engine_told();
    if keep {
        return;
    }
    crate::engine_keeper::quit_stops_engine();
    if let Err(problem) = crate::engine::set_mode_blocking("whenOpen") {
        eprintln!("intentic: the sandboxes' setting did not change at the quit: {problem}");
    }
    crate::engine_keeper::tell_background(app);
}

fn carry_out(app: &AppHandle, card: &Card, code: i32, choice: Choice) {
    match choice {
        Choice::Tray => super::close::hide_faces(app),
        Choice::Wait if card.busy() => super::quit::wait_then_quit(app.clone(), code),
        Choice::Wait | Choice::Now => super::quit::quit_now(app, code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(kind: &'static str, sandbox: Option<&str>) -> Work {
        Work {
            kind,
            sandbox: sandbox.map(str::to_string),
        }
    }

    fn busy() -> Card {
        Card {
            work: vec![work("update", Some("work"))],
            sandboxes: Sandboxes::Keep,
            ..Card::default()
        }
    }

    /// The machine agent put in place ahead is nobody's work: it used to be "a task on this computer on this computer"
    /// at every quit in the first minutes of a launch. Everything else is named, with its sandbox where it has one.
    #[test]
    fn a_quit_names_the_work_under_way_and_leaves_out_what_nobody_started() {
        let runs: Vec<String> = [
            crate::agent_install::RUN.to_string(),
            crate::folder_setup::run_id("/home/ada/shop"),
            "recreate:work".to_string(),
            "remove:old".to_string(),
            "repair-start:web".to_string(),
            "repair-engine-move".to_string(),
            "project-sync:/work/site".to_string(),
            "setup".to_string(),
            "device-pair".to_string(),
            "anything-new".to_string(),
        ]
        .to_vec();
        assert_eq!(
            work_of(&runs, true),
            vec![
                work("update", Some("work")),
                work("remove", Some("old")),
                work("fix", Some("web")),
                work("move", None),
                work("sync", None),
                work("setup", None),
                work("pair", None),
                work("other", None),
                work("bringBack", None),
            ]
        );
        assert!(work_of(&[crate::agent_install::RUN.to_string()], false).is_empty());
        assert_eq!(
            work_of(&[crate::engine::RUN.to_string()], false),
            vec![work("move", None)]
        );
        for verb in [
            crate::os::Verb::Update { apply: false },
            crate::os::Verb::Rollback { apply: true },
            crate::os::Verb::Channel(crate::os::Channel::Beta),
            crate::os::Verb::Reboot,
        ] {
            assert_eq!(
                work_of(&[verb.run().to_string()], false),
                vec![work("system", None)]
            );
        }
        assert_eq!(
            work_of(&[crate::os_settings::IMPORT_RUN.to_string()], false),
            vec![work("drive", None)]
        );
    }

    /// The sandboxes question is asked only while they run and nobody has chosen: a setting written on This computer or
    /// in the tray is a choice, and so is an earlier answer.
    #[test]
    fn the_sandboxes_question_is_asked_once_and_only_where_nobody_chose() {
        assert_eq!(sandboxes_of(None, true, false), Sandboxes::Ask);
        assert_eq!(sandboxes_of(None, true, true), Sandboxes::Keep);
        assert_eq!(sandboxes_of(Some("always"), true, false), Sandboxes::Keep);
        assert_eq!(sandboxes_of(Some("whenOpen"), true, false), Sandboxes::Stop);
        assert_eq!(
            sandboxes_of(Some("whenOpen"), false, false),
            Sandboxes::Idle
        );
        assert_eq!(sandboxes_of(None, false, false), Sandboxes::Idle);
    }

    /// One card asks everything, and the sandboxes question waits for a quit with nothing else on it.
    #[test]
    fn the_sandboxes_question_waits_for_a_quiet_quit() {
        let asked = Card {
            sandboxes: Sandboxes::Ask,
            ..Card::default()
        };
        assert_eq!(asked.clone().settled().sandboxes, Sandboxes::Ask);
        let with_work = Card {
            agents: 1,
            ..asked.clone()
        };
        assert_eq!(with_work.settled().sandboxes, Sandboxes::Keep);
        let with_changes = Card {
            unsaved: 2,
            ..asked
        };
        assert_eq!(with_changes.settled().sandboxes, Sandboxes::Keep);
    }

    #[test]
    fn a_quit_with_nothing_to_ask_goes_ahead() {
        let quiet = Card {
            sandboxes: Sandboxes::Keep,
            ..Card::default()
        };
        assert_eq!(decide(&quiet, None, false), Decision::Go);
        assert_eq!(decide(&quiet, Some(QuitBusy::Wait), false), Decision::Go);
        // The × always asks: it is the question whose answer decides.
        let close = Card {
            from_close: true,
            ..quiet
        };
        assert_eq!(decide(&close, Some(QuitBusy::Now), false), Decision::Ask);
    }

    /// "Always do this" answers the question about work under way from then on, and a second quit while one waits
    /// means now. Never over unsaved changes or a move, which a quit would lose.
    #[test]
    fn a_kept_answer_about_work_under_way_is_used_until_something_would_be_lost() {
        assert_eq!(decide(&busy(), None, false), Decision::Ask);
        assert_eq!(
            decide(&busy(), Some(QuitBusy::Wait), false),
            Decision::Do(Choice::Wait)
        );
        assert_eq!(
            decide(&busy(), Some(QuitBusy::Wait), true),
            Decision::Do(Choice::Now)
        );
        assert_eq!(
            decide(&busy(), Some(QuitBusy::Now), false),
            Decision::Do(Choice::Now)
        );
        let losing = Card {
            unsaved: 1,
            ..busy()
        };
        assert_eq!(decide(&losing, Some(QuitBusy::Now), false), Decision::Ask);
        let moving = Card {
            moving: true,
            ..busy()
        };
        assert_eq!(decide(&moving, Some(QuitBusy::Now), false), Decision::Ask);
    }

    /// The answer keeps what it may: the ×'s answer and the one about work under way when "always" was ticked, and the
    /// sandboxes answer whenever it was asked and the app quits.
    #[test]
    fn an_answer_keeps_what_it_may() {
        let answer = |choice, keep_sandboxes, remember| Answer {
            choice,
            keep_sandboxes,
            remember,
        };
        let close = Card {
            from_close: true,
            sandboxes: Sandboxes::Ask,
            ..Card::default()
        };
        assert_eq!(
            kept(&close, &answer(Choice::Now, Some(false), false)),
            Kept {
                sandboxes: Some(false),
                ..Kept::default()
            }
        );
        assert_eq!(
            kept(&close, &answer(Choice::Now, Some(true), true)),
            Kept {
                close: Some(CloseAction::Quit),
                sandboxes: Some(true),
                ..Kept::default()
            }
        );
        // To the tray, the sandboxes were not answered.
        assert_eq!(
            kept(&close, &answer(Choice::Tray, Some(false), true)),
            Kept {
                close: Some(CloseAction::Tray),
                ..Kept::default()
            }
        );
        assert_eq!(
            kept(&busy(), &answer(Choice::Wait, None, true)).busy,
            Some(QuitBusy::Wait)
        );
        assert_eq!(kept(&busy(), &answer(Choice::Wait, None, false)).busy, None);
        let losing = Card {
            unsaved: 2,
            ..busy()
        };
        assert_eq!(
            kept(&losing, &answer(Choice::Now, None, true)),
            Kept::default()
        );
        // A sandboxes answer the card did not ask is not taken.
        assert_eq!(
            kept(&busy(), &answer(Choice::Now, Some(false), false)).sandboxes,
            None
        );
    }

    /// The page reads the card as JSON, in its own words for each kind.
    #[test]
    fn the_card_reaches_the_page_as_facts() {
        let card = Card {
            from_close: true,
            work: vec![work("update", Some("work")), work("setup", None)],
            sandboxes: Sandboxes::Ask,
            ..Card::default()
        };
        assert_eq!(
            serde_json::to_value(&card).unwrap(),
            serde_json::json!({
                "fromClose": true,
                "unsaved": 0,
                "agents": 0,
                "work": [{ "kind": "update", "sandbox": "work" }, { "kind": "setup" }],
                "moving": false,
                "sandboxes": "ask",
            })
        );
        let answer: Answer =
            serde_json::from_str(r#"{"choice":"wait","keepSandboxes":false,"remember":true}"#)
                .unwrap();
        assert_eq!(answer.choice, Choice::Wait);
        assert_eq!(answer.keep_sandboxes, Some(false));
        let bare: Answer = serde_json::from_str(r#"{"choice":"tray"}"#).unwrap();
        assert!(!bare.remember && bare.keep_sandboxes.is_none());
    }
}
