use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::{Manager, WebviewWindow, WindowEvent};

/* WHETHER A WINDOW OF THE PAGE IS WHERE THE READER CAN SEE IT, told to its page.

A page decides by `document.visibilityState` whether anybody is looking at it, and two things hang on the answer: the
idle flag it reports to its sandbox, which is what holds push back from the reader's phone (the daemon skips a member
with a tab in use, `_sandbox/sandbox/src/push/push.ts`), and whether news is told quietly or out loud. On Windows that
answer is always "visible": WebView2 hears it only from the controller's IsVisible, which this app leaves alone
(webview_sync.rs has why), so a workspace hidden in the tray for a whole day reported somebody watching it, and no
push reached their phone all that time. WebKitGTK follows its window, so on Linux this says what the page already
knew.

So the app says it: a window is shown when it is visible and not minimised, and its page hears
`intentic-desktop-shown` with `{ shown }` whenever that changes, and once when its bar comes up (windows.rs
`chrome_is_up`), which is a page that has just loaded and knows nothing. The page reads no event as shown, which is
what every app before this one meant. */

/// The DOM event the page listens on, dispatched by `eval` like every other word the app says to a page.
const SHOWN_EVENT: &str = "intentic-desktop-shown";

/// What each window's page was last told, by label, so a resize or a focus change that moves nothing says nothing.
static TOLD: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(Mutex::default);

/// Whether `window` is on screen. A window that cannot answer counts as shown: a page told it is unseen goes quiet
/// towards its sandbox, and the wrong way round that loses the reader's push rather than adding one.
fn on_screen(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
}

/// Record `shown` for `label`; whether that is a change from what was told before (a first telling is one).
fn changed(told: &Mutex<HashMap<String, bool>>, label: &str, shown: bool) -> bool {
    told.lock().unwrap().insert(label.to_string(), shown) != Some(shown)
}

/// Tell `window`'s page whether it is shown: when that changed, or `always` for a page that has just loaded. A window
/// coming back on screen also gets the app's mark back on its taskbar button, which Windows drops with the button
/// (badge.rs).
pub fn tell(window: &WebviewWindow, always: bool) {
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

/// Keep `window`'s page told for the life of the window. A minimise or a restore arrives as a resize (tao reports the
/// minimised one with a zero size), and a window the app hides or shows itself loses or takes the focus; the app's own
/// `show` and `hide` say it too (windows.rs), so this is the catch for what the platform did on its own.
pub fn watch(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
            if let Some(window) = app.get_webview_window(&label) {
                tell(&window, false);
            }
        }
        WindowEvent::Destroyed => {
            TOLD.lock().unwrap().remove(&label);
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
