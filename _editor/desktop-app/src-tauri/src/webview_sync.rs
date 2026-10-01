use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};

/* WEBVIEW2 TAKES ITS WINDOW'S GEOMETRY AGAIN EVERY TIME THE WINDOW COMES BACK (Windows only).

wry keeps the WebView2 controller in step with two messages, WM_SIZE (skipped while minimised) and WM_MOVE, and
Tauri never sets the controller's visibility. Most of what this app does to a page window happens where the webview
cannot see it: windows are built hidden and their page loaded before they are shown, sized, placed and maximised while
hidden (windows.rs `take_frame`), hidden to the tray for hours, minimised, and dragged between monitors of different
scale. The page's own copy of its size and scale can be left behind the window's by that, and what the reader then
gets is a page DRAWN in one place and HIT-TESTED in another.

(2026-10-01) Seen as every control of the right-docked chat answering only at its bottom-right corner (the effort
picker, the composer's buttons) on WebView2 runtime 154 across a 100% and a 150% monitor, and cured by F5. A reload
changes nothing about the window, its bounds or its scale; what it does is re-send the page every size and scale it
has, and so does a resize, so this resizes: at each moment the copy can have gone stale, the controller's bounds go one pixel shorter and straight back.
The page sees two `resize` events, nothing it lays out is persisted from them (usePanelHeight clamps on a drag,
not on a resize), and the height moves rather than the width so no width breakpoint flips on the way. Rejected:
keeping the controller's IsVisible in step with the window, which Microsoft recommends for minimise/restore. It would
have made `document.visibilityState` honest too, but a hidden WebView2 on runtime 152+ reports a ~70×39 viewport
(WebView2Feedback#5689), and this page answers a narrow viewport by switching to its mobile shell and undocking the
chat. */

/// How long after a window comes back, or changes scale, before its webview is nudged: long enough for the resize
/// the platform sends behind a restore (and tao behind a new scale) to land, and for WebView2 to have noticed the new
/// monitor's scale by itself.
const SETTLE: Duration = Duration::from_millis(250);

/// The windows on the taskbar, by label: the size one of them reports next is a return, not a resize. wry skips the
/// minimised WM_SIZE and answers the restoring one by setting the bounds the controller already had, which WebView2
/// takes as no change at all.
static MINIMISED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// Nudge `window`'s webview whenever its scale changes or it comes back from the taskbar. Once per window, as it is
/// built; the listener goes with the window.
pub fn watch(window: &WebviewWindow) {
    if !cfg!(windows) {
        return;
    }
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::ScaleFactorChanged { .. } => nudge_later(&app, &label),
        WindowEvent::Resized(size) => {
            if returned(&MINIMISED, &label, size.width == 0 && size.height == 0) {
                nudge_later(&app, &label);
            }
        }
        WindowEvent::Destroyed => {
            MINIMISED.lock().unwrap().remove(&label);
        }
        _ => {}
    });
}

/// `window` has just been put on screen: from the tray, from behind the other face, or for the first time after its
/// page loaded while it was hidden.
pub fn shown(window: &WebviewWindow) {
    if !cfg!(windows) {
        return;
    }
    nudge_later(window.app_handle(), window.label());
}

/// Whether a resize is a window coming back from the taskbar. A 0×0 resize is one going there: tao reports the
/// SIZE_MINIMIZED WM_SIZE with the zero size it carries.
fn returned(minimised: &Mutex<HashSet<String>>, label: &str, to_taskbar: bool) -> bool {
    let mut minimised = minimised.lock().unwrap();
    if to_taskbar {
        minimised.insert(label.to_string());
        return false;
    }
    minimised.remove(label)
}

fn nudge_later(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SETTLE).await;
        let Some(window) = app.get_webview_window(&label) else {
            return;
        };
        // A window that went away again meanwhile is nudged when it is next shown, not while nobody can see it.
        if matches!(window.is_visible(), Ok(true)) && matches!(window.is_minimized(), Ok(false)) {
            nudge(&window);
        }
    });
}

/// Tell the controller its parent moved, then resize it one pixel shorter and back, on the main thread
/// (`with_webview` runs there).
#[cfg(windows)]
fn nudge(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        let controller = webview.controller();
        // SAFETY: plain COM calls on the controller this webview owns, made on the thread that created it.
        unsafe {
            let _ = controller.NotifyParentWindowPositionChanged();
            let mut bounds = Default::default();
            if controller.Bounds(&mut bounds).is_err() {
                return;
            }
            let mut shorter = bounds;
            shorter.bottom -= 1;
            if shorter.bottom <= shorter.top {
                return;
            }
            let _ = controller.SetBounds(shorter);
            let _ = controller.SetBounds(bounds);
        }
    });
}

#[cfg(not(windows))]
fn nudge(_window: &WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Mutex<HashSet<String>> {
        Mutex::default()
    }

    #[test]
    fn a_restore_is_a_return_once_and_only_after_a_minimise() {
        let minimised = fresh();
        assert!(
            !returned(&minimised, "workspace", false),
            "an ordinary resize"
        );
        assert!(
            !returned(&minimised, "workspace", true),
            "going to the taskbar"
        );
        assert!(returned(&minimised, "workspace", false), "coming back");
        assert!(
            !returned(&minimised, "workspace", false),
            "the resize after that is ordinary again"
        );
    }

    #[test]
    fn each_window_answers_for_its_own_trip_to_the_taskbar() {
        let minimised = fresh();
        assert!(!returned(&minimised, "workspace", true));
        assert!(
            !returned(&minimised, "floating-chat", false),
            "another window's resize is not this one's return"
        );
        assert!(returned(&minimised, "workspace", false));
    }

    #[test]
    fn two_minimised_frames_in_a_row_are_still_one_return() {
        let minimised = fresh();
        assert!(!returned(&minimised, "home", true));
        assert!(!returned(&minimised, "home", true));
        assert!(returned(&minimised, "home", false));
        assert!(!returned(&minimised, "home", false));
    }
}
