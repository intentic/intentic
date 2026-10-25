use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::{Manager, Webview, Window, WindowEvent};

/* Report visible, non-minimized, active-face windows through intentic-desktop-shown { shown }, and seed the state at chrome_is_up.
 * WebView2's unchanged IsVisible makes document.visibilityState unreliable, otherwise hidden windows suppress phone push and loud notices.
 * Linux already follows window visibility; missing events mean shown for compatibility with older apps. */

/// The DOM event the page listens on, dispatched by `eval` like every other word the app says to a page.
const SHOWN_EVENT: &str = "intentic-desktop-shown";

/// What each window's page was last told, by label, so a resize or a focus change that moves nothing says nothing.
static TOLD: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(Mutex::default);

/// Whether `page` is on screen. A window that cannot answer counts as shown: a page told it is unseen goes quiet
/// towards its sandbox, and the wrong way round that loses the reader's push rather than adding one. A face the frame
/// is not drawing is out of sight, which the app knows without asking anything.
fn on_screen(page: &Webview) -> bool {
    let window = page.window();
    crate::frame::drawn(page)
        && window.is_visible().unwrap_or(true)
        && !window.is_minimized().unwrap_or(false)
}

/// Record `shown` for `label`; whether that is a change from what was told before (a first telling is one).
fn changed(told: &Mutex<HashMap<String, bool>>, label: &str, shown: bool) -> bool {
    told.lock().unwrap().insert(label.to_string(), shown) != Some(shown)
}

/// Tell `window`'s page whether it is shown: when that changed, or `always` for a page that has just loaded. A window
/// coming back on screen also gets the app's mark back on its taskbar button, which Windows drops with the button
/// (badge.rs).
pub fn tell(window: &Webview, always: bool) {
    let shown = on_screen(window);
    let moved = changed(&TOLD, window.label(), shown);
    if moved && shown {
        crate::badge::window_shown(window);
    }
    if !always && !moved {
        return;
    }
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent('{SHOWN_EVENT}', {{ detail: {{ shown: {shown} }} }}));"
    ));
}

/// Keep the pages in `window` told for the life of the window: the two faces in the frame, or a window's own page. A
/// minimise or a restore arrives as a resize (tao reports the minimised one with a zero size), and a window the app
/// hides or shows itself loses or takes the focus; the app's own `show` and `hide` say it too (frame.rs, windows.rs), so
/// this is the catch for what the platform did on its own.
pub fn watch(window: &Window) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
            if let Some(window) = app.get_window(&label) {
                for page in window.webviews() {
                    tell(&page, false);
                }
            }
        }
        WindowEvent::Destroyed => {
            let mut told = TOLD.lock().unwrap();
            // A window's own page shares its label; the frame's faces go with the frame.
            told.remove(&label);
            if label == crate::frame::FRAME {
                told.remove(crate::windows::WORKSPACE);
                told.remove(crate::windows::HOME);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_told_once_per_change_and_first_of_all() {
        let told = Mutex::default();
        assert!(changed(&told, "workspace", true), "a first telling");
        assert!(!changed(&told, "workspace", true), "the same again");
        assert!(changed(&told, "workspace", false), "hidden in the tray");
        assert!(!changed(&told, "workspace", false));
        assert!(changed(&told, "workspace", true), "back from it");
    }

    #[test]
    fn each_window_is_told_about_itself() {
        let told = Mutex::default();
        assert!(changed(&told, "workspace", true));
        assert!(
            changed(&told, "floating-chat", true),
            "another window's first telling is its own"
        );
        assert!(changed(&told, "floating-chat", false));
        assert!(
            !changed(&told, "workspace", true),
            "the workspace has not moved"
        );
    }
}
