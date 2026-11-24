use super::close::hide_faces;
use super::unsaved::{unsaved_windows, QUITTING};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// A Quit question is on screen. A second Quit while it is up is held without asking twice.
static ASKING_QUIT: AtomicBool = AtomicBool::new(false);

/// Set by the runs question's "Quit now", or by its wait ending: the exit that follows leaves what still runs to finish
/// on its own, and is not asked about again.
static RUNS_ANSWERED: AtomicBool = AtomicBool::new(false);

/// The runs question's "Quit when it's done", while it is waited out.
static QUIT_WAIT: LazyLock<Mutex<QuitWait>> = LazyLock::new(Mutex::default);

/// Set by "Quit anyway" on the question about agents still working on this computer: the exit that follows ends them
/// and is not asked about again.
static AGENTS_ANSWERED: AtomicBool = AtomicBool::new(false);

/// "Quit when it's done", as one wait at a time with a number of its own, so a Cancel can take it back. It used to be a
/// flag the waiting thread never looked at again: a later Quit's "Cancel" left the app to quit anyway the moment the
/// work ended, and a wait that ended in a Cancel at the unsaved-changes question left the flag set, so "Quit when it's
/// done" did nothing at all from then on (2026-10-12).
#[derive(Debug, Default)]
struct QuitWait {
    waiting: Option<u64>,
    last: u64,
}

impl QuitWait {
    /// A wait starts, with its number; none when one is already being waited out, which this one joins.
    fn begin(&mut self) -> Option<u64> {
        if self.waiting.is_some() {
            return None;
        }
        self.last += 1;
        self.waiting = Some(self.last);
        self.waiting
    }

    /// Whether wait `id` is still the one being waited out: a Cancel since, or a later wait, says no.
    fn holds(&self, id: u64) -> bool {
        self.waiting == Some(id)
    }

    /// Wait `id` saw the work end: true when it is still the one waited out, which then quits.
    fn finish(&mut self, id: u64) -> bool {
        let holds = self.holds(id);
        if holds {
            self.waiting = None;
        }
        holds
    }

    fn cancel(&mut self) {
        self.waiting = None;
    }
}

/// "Cancel" on either Quit question: the app stays, and nothing of a quit under way is left for the next one to trip
/// over. "Quit anyway" no longer stands (its windows' changes count again, and an update waits for them), the work under
/// way is asked about again, and a "Quit when it's done" being waited out is let go.
fn quit_cancelled() {
    QUITTING.store(false, Ordering::SeqCst);
    RUNS_ANSWERED.store(false, Ordering::SeqCst);
    AGENTS_ANSWERED.store(false, Ordering::SeqCst);
    ENGINE_ANSWERED.store(false, Ordering::SeqCst);
    QUIT_WAIT.lock().unwrap().cancel();
}

/// The app is about to end with `code` (the tray's Quit, the ×'s "Quit", a restart): with local windows holding
/// unsaved changes, ask first, in a native dialog. `true` means the exit was held for the question, and the caller
/// prevents it; "Quit anyway" ends the app with the same code, and nothing is asked a second time. Then, with work
/// still under way on this computer, that is asked about too ([`hold_quit_for_runs`], 2026-10-05).
///
/// A restart cannot be held (Tauri ignores a prevented restart), which is why an update refuses to start while
/// anything is unsaved or running (update.rs `refusal`) rather than relying on this.
pub fn hold_quit(app: &AppHandle, code: i32) -> bool {
    if code == tauri::RESTART_EXIT_CODE {
        return false;
    }
    let count = unsaved_windows();
    if count == 0 {
        return hold_quit_for_agents(app, code)
            || hold_quit_for_runs(app, code)
            || hold_quit_for_engine(app, code);
    }
    if ASKING_QUIT.swap(true, Ordering::SeqCst) {
        return true;
    }
    let handle = app.clone();
    app.dialog()
        .message(quit_question(count))
        .title("Quit Intentic?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit anyway".into(),
            "Cancel".into(),
        ))
        .show(move |quit| {
            ASKING_QUIT.store(false, Ordering::SeqCst);
            if quit {
                QUITTING.store(true, Ordering::SeqCst);
                handle.exit(code);
            } else {
                quit_cancelled();
            }
        });
    true
}

/// Set once the engine question is answered: the exit that follows is not asked about it again.
static ENGINE_ANSWERED: AtomicBool = AtomicBool::new(false);

/// The first quit while Intentic's engine runs says what quitting does to the sandboxes on this computer, by the
/// background setting (engine_keeper.rs `quit_question`), with the other way at hand for this once: keep them running,
/// or stop them too. Asked once ever; after that a quit does what the setting says. `true` means the exit was held for
/// the answer. (2026-11-24)
fn hold_quit_for_engine(app: &AppHandle, code: i32) -> bool {
    use crate::state::AppState;
    use tauri::Manager;
    if !cfg!(windows) || ENGINE_ANSWERED.load(Ordering::SeqCst) {
        return false;
    }
    if app.state::<AppState>().quit_engine_told() || !crate::engine_keeper::ours() {
        return false;
    }
    let mode = crate::scripts::engine_mode();
    let running =
        crate::scripts::engine_hold_kind().is_none() && crate::scripts::our_engine_listening();
    let Some((title, message, own, other)) =
        crate::engine_keeper::quit_question(mode.as_deref(), running)
    else {
        return false;
    };
    if ASKING_QUIT.swap(true, Ordering::SeqCst) {
        return true;
    }
    let handle = app.clone();
    let other_stops = crate::engine_keeper::other_way_stops(mode.as_deref());
    let (own, other) = (own.to_string(), other.to_string());
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            own.clone(),
            other.clone(),
            "Cancel".into(),
        ))
        .show_with_result(move |answer| {
            ASKING_QUIT.store(false, Ordering::SeqCst);
            use tauri_plugin_dialog::MessageDialogResult;
            let chose_other = match answer {
                MessageDialogResult::Yes => false,
                MessageDialogResult::Custom(said) if said == own => false,
                MessageDialogResult::No => true,
                MessageDialogResult::Custom(said) if said == other => true,
                _ => {
                    quit_cancelled();
                    return;
                }
            };
            if chose_other {
                if other_stops {
                    crate::engine_keeper::quit_stops_engine();
                } else {
                    crate::engine_keeper::quit_keeps_engine();
                }
            }
            handle.state::<AppState>().remember_quit_engine_told();
            ENGINE_ANSWERED.store(true, Ordering::SeqCst);
            handle.exit(code);
        });
    true
}

/// Agents working on this computer itself end with the app: their harnesses are the file server's children, and it
/// ends with the app (host_agents.rs). A Quit while any turn runs asks first, and says how many. `true` means the exit
/// was held for the answer. (2026-11-24)
fn hold_quit_for_agents(app: &AppHandle, code: i32) -> bool {
    let running = crate::host_agents::running();
    if running == 0 || AGENTS_ANSWERED.load(Ordering::SeqCst) {
        return false;
    }
    if ASKING_QUIT.swap(true, Ordering::SeqCst) {
        return true;
    }
    let handle = app.clone();
    app.dialog()
        .message(crate::host_agents::quit_question(running))
        .title("Quit Intentic?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit anyway".into(),
            "Cancel".into(),
        ))
        .show(move |quit| {
            ASKING_QUIT.store(false, Ordering::SeqCst);
            if quit {
                AGENTS_ANSWERED.store(true, Ordering::SeqCst);
                handle.exit(code);
            } else {
                quit_cancelled();
            }
        });
    true
}

/* A QUIT WHILE THE APP IS STILL WORKING ON THIS COMPUTER (2026-10-05). Quit asked only about unsaved windows, and ended the
 * app under a recreate, a removal or a bring-back as readily as under nothing: the scripts and the `ic` under them were
 * abandoned mid-flow, a bring-back's machine agent with them. Now a Quit with work under way asks first: wait for it and
 * quit then, quit now, or cancel. A run's child no longer writes to a pipe of this process (scripts.rs `Spool`), so a
 * "Quit now" leaves it to finish on its own with its own words in its files, which its transcript names. A folder's own
 * sandbox's setup is not asked about: a quit stops it and the next launch runs it again by design (folder_setup.rs
 * `before_exit`).
 *
 * A SETUP HANDED OVER STOPS WITH THE APP (2026-10-12). Left to carry on, it went on unwatched: a reader who quit mid-
 * download and set the sandbox up again had two `ic connect`s racing for one sandbox, and the first reported its failure
 * twenty minutes after he had gone, to nobody. "Quit now" stops it with everything it started, and says so; setting it
 * up again from the workspace reuses what it already downloaded. Before it goes, the window running it is given a moment
 * to send where it was left (`desktop_install_abandoned`, [`tell_quitting`]). A setup a crash left going is stopped by
 * the next one instead (scripts.rs `stop_left_running`). */

/// What still runs that a Quit should ask about: every script and `ic` run but a folder's own sandbox's setup, and a
/// folder's bring-back, restore or direction change (`project_busy`). Pure.
pub fn quit_waits_for(runs: &[String], project_busy: bool) -> Vec<String> {
    let mut waits: Vec<String> = runs
        .iter()
        .filter(|run| !run.starts_with(crate::folder_setup::RUN_PREFIX))
        .cloned()
        .collect();
    if project_busy {
        waits.push("project".to_string());
    }
    waits
}

/// What a run is doing, in the question's words. Pure.
pub fn run_said(run: &str) -> String {
    let (kind, slug) = run.split_once(':').unwrap_or((run, ""));
    match kind {
        "setup" => "setting up a sandbox".to_string(),
        "power" => format!("starting or stopping {slug}"),
        "recreate" => format!("updating {slug}"),
        "remove" => format!("removing {slug}"),
        "fix" => "fixing a sandbox".to_string(),
        // This device's move (engine.rs) or Repair's: every sandbox stopped in turn while its files are copied.
        "engine-move" | "repair-engine-move" => {
            "moving your sandboxes to another engine".to_string()
        }
        "sync-setup" | "project-sync" => "setting up folder sync".to_string(),
        // A change to Intentic OS from This device (os.rs): a download, a rollback queued, a restart on its way.
        "os-update" | "os-rollback" | "os-channel" | "os-reboot" => {
            "updating this computer's system".to_string()
        }
        "project" => "bringing changes back to a folder".to_string(),
        _ => "a task on this computer".to_string(),
    }
}

/// The question about work still under way, as one sentence. A setup stops with the app, and everything else carries
/// on: the question says which is which. Pure.
pub fn runs_question(waits: &[String]) -> String {
    let mut doing: Vec<String> = waits.iter().map(|run| run_said(run)).collect();
    doing.dedup();
    let setup = waits.iter().any(|run| run == crate::commands::SETUP_RUN);
    let others = waits.iter().any(|run| run != crate::commands::SETUP_RUN);
    let then = match (setup, others) {
        (true, false) => {
            "If you quit now, the setup stops. Set it up again from your workspace whenever you like: it reuses what \
             it already downloaded."
        }
        (true, true) => {
            "If you quit now, the setup stops (set it up again from your workspace whenever you like), and the rest \
             carries on without Intentic, which won't show you how it ends."
        }
        _ => "If you quit now, it carries on without Intentic, and Intentic won't show you how it ends.",
    };
    format!(
        "Intentic is still {} on this computer. {then}",
        doing.join(", ")
    )
}

/// The second half of [`hold_quit`]: work still under way is asked about, and the exit held for the answer. "Quit when
/// it's done" waits for it in the background and then quits with the same code; "Quit now" quits; "Cancel" stays.
fn hold_quit_for_runs(app: &AppHandle, code: i32) -> bool {
    if RUNS_ANSWERED.load(Ordering::SeqCst) {
        return false;
    }
    let waits = quit_waits_for(&crate::scripts::running_ids(), crate::project::busy());
    let moving = moves_stopped(&crate::scripts::running_ids(), crate::scripts::moving);
    if waits.is_empty() && moving.is_empty() {
        return false;
    }
    if ASKING_QUIT.swap(true, Ordering::SeqCst) {
        return true;
    }
    // A move the quit would stop is asked about in the reader's own words, and says what stopping it costs.
    let asked = if moving.is_empty() {
        Asked::runs(&waits)
    } else {
        Asked::moving(&MOVE_WORDS.lock().unwrap_or_else(PoisonError::into_inner))
    };
    let (wait, now) = (asked.wait.clone(), asked.now.clone());
    let handle = app.clone();
    app.dialog()
        .message(asked.message)
        .title(asked.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            asked.wait,
            asked.now,
            asked.cancel,
        ))
        .show_with_result(move |answer| {
            ASKING_QUIT.store(false, Ordering::SeqCst);
            use tauri_plugin_dialog::MessageDialogResult;
            match answer {
                MessageDialogResult::Yes => wait_then_quit(handle, code),
                MessageDialogResult::Custom(said) if said == wait => wait_then_quit(handle, code),
                MessageDialogResult::No => quit_now(&handle, code),
                MessageDialogResult::Custom(said) if said == now => quit_now(&handle, code),
                // Cancel, or the dialog closed: stays, and an earlier "Quit when it's done" no longer stands.
                _ => quit_cancelled(),
            }
        });
    true
}

fn quit_now(app: &AppHandle, code: i32) {
    use crate::commands::SETUP_RUN;
    if !crate::scripts::is_running(SETUP_RUN) {
        RUNS_ANSWERED.store(true, Ordering::SeqCst);
        note_moves_stopped();
        let stopped = folder_setup_runs();
        crate::scripts::note_quit(&stopped.iter().map(String::as_str).collect::<Vec<_>>());
        app.exit(code);
        return;
    }
    // Held while the setup's window has its moment: a second Quit meanwhile joins this one rather than ending the app
    // ahead of it, with the setup still running.
    ASKING_QUIT.store(true, Ordering::SeqCst);
    let handle = app.clone();
    std::thread::spawn(move || {
        tell_quitting(&handle, QUIT_FLUSH);
        crate::scripts::note(
            SETUP_RUN,
            "[Intentic quit while this setup was running, and stopped it with everything it started.]",
        );
        note_moves_stopped();
        if let Err(error) = crate::scripts::stop(SETUP_RUN) {
            eprintln!("intentic: the setup did not stop with the app: {error}");
        }
        let mut stopped = folder_setup_runs();
        stopped.push(SETUP_RUN.to_string());
        crate::scripts::note_quit(&stopped.iter().map(String::as_str).collect::<Vec<_>>());
        RUNS_ANSWERED.store(true, Ordering::SeqCst);
        ASKING_QUIT.store(false, Ordering::SeqCst);
        handle.exit(code);
    });
}

/* A QUIT IN THE MIDDLE OF A MOVE BETWEEN ENGINES (issue #48, 2026-11-20). A setup moves this PC's sandboxes off Docker
 * Desktop inside `ic docker prepare`, for as long as their files take to copy (92 GB, in the report). A reader quit
 * during the copy, the question said only "If you quit now, the setup stops", and "Quit now" stopped it with everything
 * it started, ic's move included, which never got to put anything back. Now a quit that would stop a move asks in the
 * reader's own words ([`MoveWords`], handed over by the page, which has the translations) and says what it costs: the
 * move stops, and the sandboxes go back on Docker Desktop the next time this PC is set up. Its log says it too.
 *
 * Nothing runs `ic engine move --abort` on the way out. Putting a move back starts every sandbox again on Docker Desktop,
 * which may have to start Docker Desktop first: minutes, not something a quit can wait on. Left running past the app it
 * would go on unwatched, beside the next setup, as the setup did before 2026-10-12. ic finds the move it left on its own
 * next run (`ic docker prepare`, `ic engine move`) and puts it back then, with the person watching. */

/// The note a run's log gets when a quit stopped the move under way in it.
const MOVE_STOPPED_NOTE: &str = "[Intentic quit while this setup was moving this PC's sandboxes between engines, and \
     stopped the move mid-copy. ic puts the sandboxes back where they were the next time this PC is set up.]";

/// The runs a quit stops (a handed-over setup, a folder's own setup) that are moving sandboxes between engines right now,
/// as `moving` says of each. Pure.
pub fn moves_stopped(runs: &[String], moving: impl Fn(&str) -> bool) -> Vec<String> {
    runs.iter()
        .filter(|run| {
            *run == crate::commands::SETUP_RUN || run.starts_with(crate::folder_setup::RUN_PREFIX)
        })
        .filter(|run| moving(run))
        .cloned()
        .collect()
}

/// Each move the quit stops gets its line in its run's log, before it is stopped.
fn note_moves_stopped() {
    for run in moves_stopped(&crate::scripts::running_ids(), crate::scripts::moving) {
        crate::scripts::note(&run, MOVE_STOPPED_NOTE);
    }
}

/// The words of the question about a move, in the reader's language: the page hands them over
/// (`quit_move_words`), since this side has no translations; English until a page has.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveWords {
    pub title: String,
    pub message: String,
    pub wait: String,
    pub quit: String,
    pub cancel: String,
}

impl Default for MoveWords {
    fn default() -> MoveWords {
        MoveWords {
            title: "Stop moving your sandboxes?".into(),
            message: "Intentic is moving this PC's sandboxes to its own engine right now. If you quit, the move stops, \
                      and your sandboxes are put back on Docker Desktop the next time this PC is set up."
                .into(),
            wait: "Quit when it's done".into(),
            quit: "Stop the move and quit".into(),
            cancel: "Cancel".into(),
        }
    }
}

/// The longest a button may be, and the question.
const BUTTON_MAX: usize = 60;
const MESSAGE_MAX: usize = 600;

impl MoveWords {
    /// Words a native dialog can carry: none empty, the buttons short, no line breaks but the question's. Pure.
    fn valid(&self) -> bool {
        let fits = |text: &str, most: usize, breaks: bool| {
            (1..=most).contains(&text.trim().chars().count())
                && !text
                    .chars()
                    .any(|character| character.is_control() && !(breaks && character == '\n'))
        };
        fits(&self.title, BUTTON_MAX * 2, false)
            && fits(&self.message, MESSAGE_MAX, true)
            && [&self.wait, &self.quit, &self.cancel]
                .iter()
                .all(|button| fits(button, BUTTON_MAX, false))
            // Two answers worded alike could not be told apart once pressed.
            && self.wait != self.quit
            && self.wait != self.cancel
            && self.quit != self.cancel
    }
}

static MOVE_WORDS: LazyLock<Mutex<MoveWords>> = LazyLock::new(Mutex::default);

/// The page's words for the question about a move, in the reader's language (its i18n catalog): a window hands them over
/// as it starts, and each language change after.
#[tauri::command]
pub fn quit_move_words(words: MoveWords) -> Result<(), String> {
    if !words.valid() {
        return Err(
            "the quit question's words are a title, a question and three different buttons".into(),
        );
    }
    *MOVE_WORDS.lock().unwrap_or_else(PoisonError::into_inner) = words;
    Ok(())
}

/// A question about work under way, as the dialog shows it.
struct Asked {
    title: String,
    message: String,
    wait: String,
    now: String,
    cancel: String,
}

impl Asked {
    fn runs(waits: &[String]) -> Asked {
        Asked {
            title: "Quit Intentic?".into(),
            message: runs_question(waits),
            wait: "Quit when it's done".into(),
            now: "Quit now".into(),
            cancel: "Cancel".into(),
        }
    }

    fn moving(words: &MoveWords) -> Asked {
        Asked {
            title: words.title.clone(),
            message: words.message.clone(),
            wait: words.wait.clone(),
            now: words.quit.clone(),
            cancel: words.cancel.clone(),
        }
    }
}

/// The folders' setups running now: a quit stops them (folder_setup.rs `before_exit`), so their transcripts are not told
/// they carry on.
fn folder_setup_runs() -> Vec<String> {
    crate::scripts::running_ids()
        .into_iter()
        .filter(|id| id.starts_with(crate::folder_setup::RUN_PREFIX))
        .collect()
}

/// How long a Quit with a setup running waits for the setup's window to send where the run was left. The window
/// answers as soon as it has (src/device/useDevice.ts), and gives its own send 1.5 s (analytics.ts `trackBeforeExit`).
const QUIT_FLUSH: Duration = Duration::from_millis(2500);

/// Told to every window when the app is about to quit with a setup running.
pub const QUITTING_EVENT: &str = "desktop://quitting";

/// The setup's window saying it has said its piece.
pub const QUIT_READY_EVENT: &str = "desktop://quit-ready";

/// Tell the windows the app is quitting, and wait up to `limit` for the one running the setup to answer that it has
/// sent what it had to: true when it answered. BLOCKING.
fn tell_quitting(app: &AppHandle, limit: Duration) -> bool {
    let (said, heard) = std::sync::mpsc::channel::<()>();
    let listening = tauri::Listener::once_any(app, QUIT_READY_EVENT, move |_| {
        let _ = said.send(());
    });
    let _ = tauri::Emitter::emit(app, QUITTING_EVENT, ());
    let answered = heard.recv_timeout(limit).is_ok();
    if !answered {
        tauri::Listener::unlisten(app, listening);
    }
    answered
}

/// Wait out the work under way in the tray, then quit with `code`. The faces go to the tray at once, as the ×'s "Keep
/// Intentic in the tray" puts them, which is where the question promised the wait would be (it left them on screen, and
/// the app then vanished from under whoever had gone on using it). Once: a second "Quit when it's done" joins the
/// first. A later Quit's Cancel takes the wait back ([`quit_cancelled`]), and then this thread lets go without quitting.
fn wait_then_quit(app: AppHandle, code: i32) {
    hide_faces(&app);
    let Some(id) = QUIT_WAIT.lock().unwrap().begin() else {
        return;
    };
    std::thread::spawn(move || {
        loop {
            if !QUIT_WAIT.lock().unwrap().holds(id) {
                return;
            }
            let runs = crate::scripts::running_ids();
            if quit_waits_for(&runs, crate::project::busy()).is_empty()
                && moves_stopped(&runs, crate::scripts::moving).is_empty()
            {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        if !QUIT_WAIT.lock().unwrap().finish(id) {
            return;
        }
        RUNS_ANSWERED.store(true, Ordering::SeqCst);
        app.exit(code);
    });
}

/// The question, counted the way it is read.
fn quit_question(count: usize) -> String {
    let windows = if count == 1 {
        "1 window has".to_string()
    } else {
        format!("{count} windows have")
    };
    format!("{windows} unsaved changes. If you quit now, those changes are lost.")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A quit asks about a move only where it would stop it: in a handed-over setup or a folder's own, never in a run a
    /// quit leaves to carry on (issue #48).
    #[test]
    fn a_quit_asks_about_the_moves_it_would_stop() {
        let folder = format!("{}work", crate::folder_setup::RUN_PREFIX);
        let runs = vec![
            "engine-move".to_string(),
            "pc-setup".to_string(),
            crate::commands::SETUP_RUN.to_string(),
            folder.clone(),
        ];
        assert_eq!(
            moves_stopped(&runs, |_| true),
            vec![crate::commands::SETUP_RUN.to_string(), folder]
        );
        assert!(moves_stopped(&runs, |_| false).is_empty());
        assert!(moves_stopped(&runs[..2], |_| true).is_empty());
    }

    /// The page's words for the question about a move: taken when a dialog can carry them, refused otherwise.
    #[test]
    fn the_move_questions_words_are_checked_before_they_are_kept() {
        let english = MoveWords::default();
        assert!(english.valid());
        assert!(english.message.contains("Docker Desktop"));
        let polish = MoveWords {
            title: "Przerwać przenoszenie piaskownic?".into(),
            message: "Zamknięcie przerwie przenoszenie.\nPiaskownice wrócą do Docker Desktop."
                .into(),
            wait: "Zamknij po zakończeniu".into(),
            quit: "Przerwij i zamknij".into(),
            cancel: "Anuluj".into(),
        };
        assert!(polish.valid());
        assert!(quit_move_words(polish).is_ok());
        assert!(!MoveWords {
            quit: String::new(),
            ..english.clone()
        }
        .valid());
        assert!(!MoveWords {
            quit: english.wait.clone(),
            ..english.clone()
        }
        .valid());
        assert!(!MoveWords {
            title: "a\nb".into(),
            ..english.clone()
        }
        .valid());
        assert!(!MoveWords {
            wait: "x".repeat(BUTTON_MAX + 1),
            ..english
        }
        .valid());
        *MOVE_WORDS.lock().unwrap() = MoveWords::default();
    }

    /// The Quit question counts the windows the way it is read, and says what quitting costs.
    #[test]
    fn the_quit_question_counts_the_windows_holding_changes() {
        assert_eq!(
            quit_question(1),
            "1 window has unsaved changes. If you quit now, those changes are lost."
        );
        assert_eq!(
            quit_question(3),
            "3 windows have unsaved changes. If you quit now, those changes are lost."
        );
    }

    /// A Quit asks about every run under way but a folder's own sandbox's setup, which a quit stops and the next
    /// launch runs again by design, and about a folder's bring-back; and says what each is doing.
    #[test]
    fn a_quit_asks_about_the_work_still_under_way_and_names_it() {
        let runs = vec![
            crate::folder_setup::run_id("/home/ada/shop"),
            "recreate:work".to_string(),
            "remove:old".to_string(),
        ];
        assert_eq!(
            quit_waits_for(&runs, false),
            vec!["recreate:work".to_string(), "remove:old".to_string()]
        );
        assert!(quit_waits_for(&[crate::folder_setup::run_id("/a")], false).is_empty());
        assert_eq!(quit_waits_for(&[], true), vec!["project".to_string()]);
        assert_eq!(
            runs_question(&quit_waits_for(&runs, true)),
            "Intentic is still updating work, removing old, bringing changes back to a folder on this computer. If \
             you quit now, it carries on without Intentic, and Intentic won't show you how it ends."
        );
        // A setup handed over stops with the app, and the question says so, apart from what carries on.
        assert_eq!(
            runs_question(&["setup".to_string()]),
            "Intentic is still setting up a sandbox on this computer. If you quit now, the setup stops. Set it up \
             again from your workspace whenever you like: it reuses what it already downloaded."
        );
        assert_eq!(
            runs_question(&["recreate:work".to_string(), "setup".to_string()]),
            "Intentic is still updating work, setting up a sandbox on this computer. If you quit now, the setup stops \
             (set it up again from your workspace whenever you like), and the rest carries on without Intentic, which \
             won't show you how it ends."
        );
        assert_eq!(run_said("power:work"), "starting or stopping work");
        assert_eq!(run_said("setup"), "setting up a sandbox");
        assert_eq!(run_said("anything-new"), "a task on this computer");
        assert_eq!(
            run_said(crate::engine::RUN),
            "moving your sandboxes to another engine"
        );
        assert_eq!(
            run_said("repair-engine-move"),
            "moving your sandboxes to another engine"
        );
        // Every change to Intentic OS from This device, whichever verb it is.
        for verb in [
            crate::os::Verb::Update { apply: false },
            crate::os::Verb::Rollback { apply: true },
            crate::os::Verb::Channel(crate::os::Channel::Beta),
            crate::os::Verb::Reboot,
        ] {
            assert_eq!(run_said(verb.run()), "updating this computer's system");
        }
    }

    /// "Quit when it's done" is one wait at a time, which a Cancel takes back: the thread waiting it out then lets go
    /// rather than quitting, and a new "Quit when it's done" after a Cancel waits again.
    #[test]
    fn a_wait_to_quit_is_taken_back_by_a_cancel() {
        let mut wait = QuitWait::default();
        let first = wait.begin().expect("nothing was waiting");
        assert_eq!(wait.begin(), None, "a second joins the first");
        assert!(wait.holds(first));
        wait.cancel();
        assert!(!wait.holds(first), "cancelled");
        assert!(!wait.finish(first), "the cancelled wait does not quit");
        let second = wait.begin().expect("waits again after a Cancel");
        assert_ne!(first, second);
        assert!(
            !wait.finish(first),
            "the old wait's thread does not quit for the new one"
        );
        assert!(wait.finish(second));
        assert!(
            wait.begin().is_some(),
            "a wait that ended leaves room for the next"
        );
    }
}
