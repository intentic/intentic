use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Webview, Window, WindowEvent};

/* Hidden/moved/scaled Windows windows can leave WebView2's layout and hit testing out of sync despite wry's WM_SIZE/WM_MOVE handling.
 * Nudge controller height down one pixel and back at those transitions to resend size/scale without crossing width breakpoints.
 * Do not toggle controller IsVisible: hidden WebView2 reports a ~70×39 viewport, switching the page to its mobile shell. */

/// How long after a window comes back, or changes scale, before its webview is nudged: long enough for the resize
/// the platform sends behind a restore (and tao behind a new scale) to land, and for WebView2 to have noticed the new
/// monitor's scale by itself.
const SETTLE: Duration = Duration::from_millis(250);

/// The windows on the taskbar, by label: the size one of them reports next is a return, not a resize. wry skips the
/// minimised WM_SIZE and answers the restoring one by setting the bounds the controller already had, which WebView2
/// takes as no change at all.
static MINIMISED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// Nudge the webview `window` draws whenever its scale changes or it comes back from the taskbar: the face the frame
/// shows (frame.rs), or a window's own page. Once per window, as it is built; the listener goes with the window.
pub fn watch(window: &Window) {
    if !cfg!(windows) {
        return;
    }
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let drawn = move |app: &AppHandle| {
        app.get_window(&label)
            .into_iter()
            .flat_map(|window| window.webviews())
            .filter(crate::frame::drawn)
            .for_each(|page| nudge_later(app, page.label()));
    };
    let own = window.label().to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::ScaleFactorChanged { .. } => drawn(&app),
        WindowEvent::Resized(size) => {
            if returned(&MINIMISED, &own, size.width == 0 && size.height == 0) {
                drawn(&app);
            }
        }
        WindowEvent::Destroyed => {
            MINIMISED.lock().unwrap().remove(&own);
        }
        _ => {}
    });
}

/// `window` has just been put on screen: from the tray, from behind the other face, or for the first time after its
/// page loaded while it was hidden.
pub fn shown(window: &Webview) {
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
        let Some(page) = app.get_webview(&label) else {
            return;
        };
        // A page that went away again meanwhile is nudged when it is next shown, not while nobody can see it.
        let window = page.window();
        if crate::frame::drawn(&page)
            && matches!(window.is_visible(), Ok(true))
            && matches!(window.is_minimized(), Ok(false))
        {
            nudge(&page);
        }
    });
}

/// Tell the controller its parent moved, then resize it one pixel shorter and back, on the main thread
/// (`with_webview` runs there).
#[cfg(windows)]
fn nudge(window: &Webview) {
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
fn nudge(_window: &Webview) {}

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
