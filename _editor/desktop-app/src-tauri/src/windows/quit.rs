use super::close::hide_faces;
use super::unsaved::QUITTING;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::AppHandle;

/// This quit was answered on the quit card (quit_card.rs), or by an answer kept from an earlier one: the exit that follows
/// goes ahead without asking again.
static ANSWERED: AtomicBool = AtomicBool::new(false);

/// A "Quit now" is on its way out, giving a setup's window its moment first: a second Quit meanwhile joins it.
static LEAVING: AtomicBool = AtomicBool::new(false);

/// The quit card's "Quit when it's done", while it is waited out.
static QUIT_WAIT: LazyLock<Mutex<QuitWait>> = LazyLock::new(Mutex::default);

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

/// A "Quit when it's done" is being waited out: a quit that would wait again means now.
pub(super) fn waiting() -> bool {
    QUIT_WAIT.lock().unwrap().waiting.is_some()
}

/// The quit card closed without an answer: the app stays, and nothing of a quit under way is left for the next one to
/// trip over. "Quit anyway" no longer stands (its windows' changes count again, and an update waits for them), the next
/// quit asks again, and a "Quit when it's done" being waited out is let go.
pub(super) fn quit_cancelled() {
    QUITTING.store(false, Ordering::SeqCst);
    ANSWERED.store(false, Ordering::SeqCst);
    QUIT_WAIT.lock().unwrap().cancel();
}

/// The quit was answered: the exit goes through, and windows with unsaved changes no longer hold it (or an update).
fn answered() {
    QUITTING.store(true, Ordering::SeqCst);
    ANSWERED.store(true, Ordering::SeqCst);
}

/// The app is about to end with `code` (the tray's Quit, the ×'s "Quit", a folder window's last ×): what it would
/// interrupt is asked about first, all on one card (quit_card.rs). `true` means the exit was held, and the caller prevents
/// it; the answer ends the app with the same code, and nothing is asked a second time.
///
/// A restart cannot be held (Tauri ignores a prevented restart), which is why an update refuses to start while
/// anything is unsaved or running (update.rs `refusal`) rather than relying on this.
pub fn hold_quit(app: &AppHandle, code: i32) -> bool {
    if code == tauri::RESTART_EXIT_CODE || ANSWERED.load(Ordering::SeqCst) {
        return false;
    }
    if LEAVING.load(Ordering::SeqCst) {
        return true;
    }
    super::quit_card::ask(app, false, code)
}

/* A QUIT WHILE THE APP IS STILL WORKING ON THIS COMPUTER (2026-10-05). Quit asked only about unsaved windows, and ended the
 * app under a recreate, a removal or a bring-back as readily as under nothing: the scripts and the `ic` under them were
 * abandoned mid-flow, a bring-back's machine agent with them. Now a Quit with work under way asks first, on the quit card
 * (quit_card.rs `work_of` says which work): wait for it and quit then, quit now, or cancel. A run's child no longer writes
 * to a pipe of this process (scripts.rs `Spool`), so a "Quit now" leaves it to finish on its own with its own words in
 * its files, which its transcript names.
 *
 * A SETUP HANDED OVER STOPS WITH THE APP (2026-10-12). Left to carry on, it went on unwatched: a reader who quit mid-
 * download and set the sandbox up again had two `ic connect`s racing for one sandbox, and the first reported its failure
 * twenty minutes after he had gone, to nobody. "Quit now" stops it with everything it started, and says so; setting it
 * up again from the workspace reuses what it already downloaded. Before it goes, the window running it is given a moment
 * to send where it was left (`desktop_install_abandoned`, [`tell_quitting`]). A setup a crash left going is stopped by
 * the next one instead (scripts.rs `stop_left_running`). */

/// Quit now: a handed-over setup stops first, after its window has had its moment; everything else carries on by itself.
pub(super) fn quit_now(app: &AppHandle, code: i32) {
    use crate::commands::SETUP_RUN;
    if !crate::scripts::is_running(SETUP_RUN) {
        answered();
        note_moves_stopped();
        let stopped = folder_setup_runs();
        crate::scripts::note_quit(&stopped.iter().map(String::as_str).collect::<Vec<_>>());
        app.exit(code);
        return;
    }
    // Held while the setup's window has its moment: a second Quit meanwhile joins this one rather than ending the app
    // ahead of it, with the setup still running.
    LEAVING.store(true, Ordering::SeqCst);
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
        answered();
        LEAVING.store(false, Ordering::SeqCst);
        handle.exit(code);
    });
}

/* A QUIT IN THE MIDDLE OF A MOVE BETWEEN ENGINES (issue #48, 2026-11-20). A setup moves this PC's sandboxes off Docker
 * Desktop inside `ic docker prepare`, for as long as their files take to copy (92 GB, in the report). A reader quit
 * during the copy, the question said only "If you quit now, the setup stops", and "Quit now" stopped it with everything
 * it started, ic's move included, which never got to put anything back. Now a quit that would stop a move says what it
 * costs on the quit card (quit_card.rs `Card::moving`): the move stops, and the sandboxes go back where they were the
 * next time this PC is set up. Its log says it too, and no "always do this" ever answers it.
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
/// It waits for everything the card named: the runs, the moves, and the agents' turns.
pub(super) fn wait_then_quit(app: AppHandle, code: i32) {
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
            if super::quit_card::work_of(&runs, crate::project::busy()).is_empty()
                && moves_stopped(&runs, crate::scripts::moving).is_empty()
                && crate::host_agents::running() == 0
            {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        if !QUIT_WAIT.lock().unwrap().finish(id) {
            return;
        }
        answered();
        app.exit(code);
    });
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
