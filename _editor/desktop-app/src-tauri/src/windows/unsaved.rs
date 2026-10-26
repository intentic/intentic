use super::close::quit_with_last_window;
use super::present::{Asked, Press};
use super::{raise, HOME};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/* A LOCAL WINDOW'S UNSAVED CHANGES — what its close and the app's Quit ask about first. */

/// What the page of a local window dispatches when a close is held for its changes: it asks the reader, then
/// saves and sends `window?do=close`, or sends `window?do=close&confirmed=1` to let them go.
const CLOSE_REQUESTED: &str = "window.dispatchEvent(new CustomEvent('intentic:close-requested'));";

/// How long a page has to take the question it was handed (its script to run the dispatch) before the app asks in
/// its place: a page that has died or hung never will, and would otherwise hold its window open for good.
const PAGE_SILENCE: Duration = Duration::from_secs(3);

/// A second close within this of the first is the same press twice (a double-click on the ×), not a page that
/// failed to take the question.
const SAME_PRESS: Duration = Duration::from_millis(800);

/// What the app asks when the page cannot, under the page's own title and buttons ("Discard unsaved changes?",
/// "Close anyway").
const NOT_ANSWERING: &str = "This window isn't responding, so it can't ask about its unsaved edits itself. Closing it discards them. This can't be undone.";

/// A close held for a page to ask about: which question it was (so a late receipt of an earlier one counts for
/// nothing), when it was handed over, and whether the page's script has run it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Held {
    id: u64,
    at: Instant,
    received: bool,
}

/// What local windows' pages have said about their changes, by label: `dirty` is the page's own word
/// (`window?do=dirty&value=1`), `confirmed` a close its page has already asked about (`close&confirmed=1`), `held` the
/// close last handed to the page, `asking` the windows the app's own question is up for. All of it goes with the
/// window (`Destroyed`), and all but `asking` with the page when a new one starts in the window.
#[derive(Default)]
pub(super) struct Unsaved {
    pub(super) dirty: HashSet<String>,
    pub(super) confirmed: HashSet<String>,
    held: HashMap<String, Held>,
    asking: HashSet<String>,
    next: u64,
}

/// What one close request of a local window comes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CloseTurn {
    /// Nothing unsaved, or its page has already asked: it closes.
    Close,
    /// Held, and its page is handed the question; the id is the one its receipt names.
    AskPage(u64),
    /// Held, and the app asks: the page never took the question it was last handed.
    AskHere,
    /// Held with nothing new to do: the same press twice, or the app's own question already up.
    Wait,
}

impl Unsaved {
    /// A close request at `now`. A page that took the question it was last handed is alive, and is asked again
    /// (its reader may have kept the window open, which the page tells nobody); one that did not take it is asked
    /// in its place, unless this is the same press twice.
    pub(super) fn close_turn(&mut self, label: &str, now: Instant) -> CloseTurn {
        if !self.dirty.contains(label) || self.confirmed.contains(label) {
            return CloseTurn::Close;
        }
        if self.asking.contains(label) {
            return CloseTurn::Wait;
        }
        match self.held.get(label) {
            Some(held) if !held.received && now.saturating_duration_since(held.at) < SAME_PRESS => {
                CloseTurn::Wait
            }
            Some(held) if !held.received => {
                self.asking.insert(label.to_string());
                CloseTurn::AskHere
            }
            _ => {
                self.next += 1;
                self.held.insert(
                    label.to_string(),
                    Held {
                        id: self.next,
                        at: now,
                        received: false,
                    },
                );
                CloseTurn::AskPage(self.next)
            }
        }
    }

    /// The page's script ran question `id`: the page is alive, and the question is its reader's to answer.
    fn received(&mut self, label: &str, id: u64) {
        if let Some(held) = self.held.get_mut(label).filter(|held| held.id == id) {
            held.received = true;
        }
    }

    /// [`PAGE_SILENCE`] after question `id` was handed over: whether the app asks in the page's place, which it does
    /// only while that same question is still held and untaken, and nothing else is asking.
    fn unanswered(&mut self, label: &str, id: u64) -> bool {
        let silent = self.dirty.contains(label)
            && !self.confirmed.contains(label)
            && !self.asking.contains(label)
            && self
                .held
                .get(label)
                .is_some_and(|held| held.id == id && !held.received);
        if silent {
            self.asking.insert(label.to_string());
        }
        silent
    }

    pub(super) fn mark_dirty(&mut self, label: &str, dirty: bool) {
        if dirty {
            self.dirty.insert(label.to_string());
        } else {
            // Clean again, so a close handed to the page before is moot.
            self.dirty.remove(label);
            self.held.remove(label);
        }
    }

    /// A new page in the window: nothing of the one before it holds a close. The app's own question, if it is up,
    /// is answered by its own dialog.
    fn page_started(&mut self, label: &str) {
        self.dirty.remove(label);
        self.confirmed.remove(label);
        self.held.remove(label);
    }

    fn forget(&mut self, label: &str) {
        self.page_started(label);
        self.asking.remove(label);
    }
}

pub(super) static UNSAVED: LazyLock<Mutex<Unsaved>> = LazyLock::new(Mutex::default);

/// Set by "Quit anyway": the exit that follows is not asked about again, and nothing counts as unsaved any more,
/// so an update staged for the way out still installs (update.rs `refusal`).
pub(super) static QUITTING: AtomicBool = AtomicBool::new(false);

/// Only local windows keep the question: the workspace's × hides it and a floating panel's docks, so neither loses
/// anything by closing. The main window's × hides it too, but Quit still ends it, so it keeps the question as well.
pub(super) fn is_local_window(label: &str) -> bool {
    label == HOME || label.starts_with(crate::local::FILES)
}

pub(super) fn page_started(label: &str) {
    if is_local_window(label) {
        UNSAVED.lock().unwrap().page_started(label);
    }
}

pub(super) fn forget_unsaved(label: &str) {
    UNSAVED.lock().unwrap().forget(label);
}

/// Hand the page the question, and give it [`PAGE_SILENCE`] to take it. The eval's own completion is the receipt:
/// it runs only if the page's script does, so a page that has died or hung never sends one, and the app asks in its
/// place ([`ask_here`]).
pub(super) fn ask_page(app: &AppHandle, window: &Webview, id: u64) {
    raise(Press::by(Asked::Window), window);
    let label = window.label().to_string();
    let receipt = label.clone();
    if let Err(error) = window.eval_with_callback(CLOSE_REQUESTED, move |_| {
        UNSAVED.lock().unwrap().received(&receipt, id);
    }) {
        eprintln!("{label} could not be asked about its unsaved changes: {error}");
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PAGE_SILENCE).await;
        let unanswered = UNSAVED.lock().unwrap().unanswered(&label, id);
        if !unanswered {
            return;
        }
        match app.get_webview(&label) {
            Some(window) => ask_here(&app, &window),
            None => forget_unsaved(&label),
        }
    });
}

/// The page's question, asked by the app, over the window, for a page that never took it: "Close anyway" closes
/// the window with its edits, "Cancel" keeps it, and the next close hands the question to the page again.
pub(super) fn ask_here(app: &AppHandle, window: &Webview) {
    raise(Press::by(Asked::Window), window);
    let label = window.label().to_string();
    let handle = app.clone();
    app.dialog()
        .message(NOT_ANSWERING)
        .title("Discard unsaved changes?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Close anyway".into(),
            "Cancel".into(),
        ))
        .parent(&window.window())
        .show(move |close| {
            {
                let mut unsaved = UNSAVED.lock().unwrap();
                unsaved.asking.remove(&label);
                unsaved.held.remove(&label);
                if close {
                    unsaved.confirmed.insert(label.clone());
                }
            }
            // Destroyed rather than closed: the answer is in, and a page that cannot take a question cannot be
            // relied on to let its window go either.
            if close {
                quit_with_last_window(&handle, &label);
                if let Some(window) = handle.get_webview_window(&label) {
                    let _ = window.destroy();
                }
            }
        });
}

/// How many local windows hold unsaved changes: what the app's Quit asks about, and what an update waits for.
pub fn unsaved_windows() -> usize {
    if QUITTING.load(Ordering::SeqCst) {
        return 0;
    }
    UNSAVED.lock().unwrap().dirty.len()
}

#[cfg(test)]
mod tests {
    use super::super::WORKSPACE;
    use super::*;

    /// A close is held only while the page says it has changes and has not itself asked about them, and it is the
    /// page that is handed the question.
    #[test]
    fn a_close_is_held_only_for_changes_nobody_has_asked_about() {
        let now = Instant::now();
        let mut unsaved = Unsaved::default();
        assert_eq!(unsaved.close_turn("files-1", now), CloseTurn::Close);
        unsaved.mark_dirty("files-1", true);
        assert_eq!(unsaved.close_turn("files-1", now), CloseTurn::AskPage(1));
        unsaved.confirmed.insert("files-1".into());
        assert_eq!(
            unsaved.close_turn("files-1", now),
            CloseTurn::Close,
            "the page asked, and was answered"
        );
        // Clean again: nothing to ask, and nothing held.
        unsaved.confirmed.clear();
        unsaved.mark_dirty("files-1", false);
        assert_eq!(unsaved.close_turn("files-1", now), CloseTurn::Close);
        assert!(unsaved.held.is_empty());
    }

    /// A page that has died or hung never takes the question: a second close asks in its place, the same press
    /// twice does not, and while the app's question is up nothing more is asked.
    #[test]
    fn a_page_that_never_takes_the_question_is_asked_for_by_the_app() {
        let now = Instant::now();
        let mut unsaved = Unsaved::default();
        unsaved.mark_dirty("files-1", true);
        assert_eq!(unsaved.close_turn("files-1", now), CloseTurn::AskPage(1));
        assert_eq!(
            unsaved.close_turn("files-1", now + SAME_PRESS - Duration::from_millis(1)),
            CloseTurn::Wait,
            "a double press is one press"
        );
        assert_eq!(
            unsaved.close_turn("files-1", now + SAME_PRESS),
            CloseTurn::AskHere
        );
        assert_eq!(
            unsaved.close_turn("files-1", now + Duration::from_secs(10)),
            CloseTurn::Wait,
            "the app's own question is up"
        );
    }

    /// A page that took the question is alive, and its reader may have kept the window (which the page tells
    /// nobody): the next close hands it the question again rather than asking over it.
    #[test]
    fn a_page_that_took_the_question_is_asked_again_and_a_late_receipt_counts_for_nothing() {
        let now = Instant::now();
        let mut unsaved = Unsaved::default();
        unsaved.mark_dirty("files-1", true);
        assert_eq!(unsaved.close_turn("files-1", now), CloseTurn::AskPage(1));
        unsaved.received("files-1", 1);
        assert!(!unsaved.unanswered("files-1", 1), "taken in time");
        assert_eq!(
            unsaved.close_turn("files-1", now + Duration::from_secs(60)),
            CloseTurn::AskPage(2)
        );
        // The receipt of the first question says nothing about the second.
        unsaved.received("files-1", 1);
        assert!(unsaved.unanswered("files-1", 2));
        assert_eq!(
            unsaved.close_turn("files-1", now + Duration::from_secs(61)),
            CloseTurn::Wait,
            "the app is asking already"
        );
    }

    /// PAGE_SILENCE after the question, the app asks only for that question, still untaken, with nothing else
    /// asking and the changes still unsaved.
    #[test]
    fn the_app_asks_after_the_silence_only_for_the_question_still_held() {
        let now = Instant::now();
        let mut unsaved = Unsaved::default();
        unsaved.mark_dirty("files-1", true);
        let CloseTurn::AskPage(id) = unsaved.close_turn("files-1", now) else {
            panic!("the page is asked first");
        };
        unsaved.mark_dirty("files-1", false);
        assert!(!unsaved.unanswered("files-1", id), "saved meanwhile");
        unsaved.mark_dirty("files-1", true);
        let CloseTurn::AskPage(id) = unsaved.close_turn("files-1", now) else {
            panic!("the page is asked again");
        };
        assert!(unsaved.unanswered("files-1", id));
        assert!(
            !unsaved.unanswered("files-1", id),
            "asked once, not once per timer"
        );
    }

    /// A page starting over in the window has no changes until it says so, and holds no close of the page before
    /// it; a destroyed window takes everything with it.
    #[test]
    fn a_new_page_starts_with_nothing_unsaved() {
        let now = Instant::now();
        let mut unsaved = Unsaved::default();
        unsaved.mark_dirty("files-1", true);
        unsaved.confirmed.insert("files-1".into());
        let _ = unsaved.close_turn("files-1", now);
        unsaved.page_started("files-1");
        assert!(
            unsaved.dirty.is_empty() && unsaved.confirmed.is_empty() && unsaved.held.is_empty()
        );
        assert_eq!(unsaved.close_turn("files-1", now), CloseTurn::Close);
        unsaved.mark_dirty("files-1", true);
        unsaved.asking.insert("files-1".into());
        unsaved.forget("files-1");
        assert!(unsaved.dirty.is_empty() && unsaved.asking.is_empty());
    }

    #[test]
    fn only_local_windows_keep_the_question() {
        assert!(is_local_window("files-3"));
        assert!(is_local_window(HOME));
        assert!(!is_local_window(WORKSPACE));
        assert!(!is_local_window("floating-chat"));
    }
}
