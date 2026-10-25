use super::bounds::{center_over, window_on_screen, CONFIRM_OPENING_HEIGHT, CONFIRM_WIDTH};
use super::mode::{face_background, face_init_script, settle_background};
use super::scripts::{launch_id_script, BROWSER_ARGS};
use super::unsaved::forget_unsaved;
use super::{folder_window_on_screen, shown_face};
use crate::state::CloseAction;
use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, Window};

/// The third label, and NOT a third face: a dialog the app draws about the window it is standing in front of.
/// It keeps to the one-window rule the way a dialog does — off the taskbar, owned by the frame it is about,
/// and gone the moment it is answered.
pub const CONFIRM_CLOSE: &str = "confirm-close";

/* THE × IS A QUESTION, ASKED BEFORE ANYTHING HAPPENS — and asked in this app's own voice. */
pub(crate) fn request_close(app: &AppHandle) {
    // In kiosk mode this app is the screen (os.rs `kiosk`): hiding a face to a tray leaves it empty, and a Quit only has
    // the session start the app again. The × is refused, and the face stays where it is (2026-10-13).
    if crate::os::kiosk() {
        return;
    }
    let chosen = app.state::<crate::state::AppState>().close_action();
    match face_close(folder_window_on_screen(app, None), chosen) {
        Some(action) => apply_close(app, action),
        None => ask_before_closing(app),
    }
}

/// What a face's × comes to. Beside a folder or document window still on screen it closes the face alone, as the × of
/// one of an app's windows does, and asks nothing, since the app is not closing; the app ends, when the reader chose
/// "Quit", with its last window (`quit_with_last_window`). Otherwise it is what the reader chose, and `None` asks.
/// _(2026-10-16) "Quit" ended the app from any face's ×, and took every folder window open beside it down too._
fn face_close(folder_window_on_screen: bool, chosen: Option<CloseAction>) -> Option<CloseAction> {
    if folder_window_on_screen {
        Some(CloseAction::Tray)
    } else {
        chosen
    }
}

/// The reader closed the folder or document window `own`. When it was the last window of the app on screen, the app does
/// what the reader chose the × to do: "Quit" ends it, as a face's × would; the tray, or nothing chosen yet, leaves it
/// running there as before. Never in kiosk mode, where the session would only start the app again.
pub(super) fn quit_with_last_window(app: &AppHandle, own: &str) {
    if crate::os::kiosk() {
        return;
    }
    let another_on_screen = crate::frame::on_screen(app) || folder_window_on_screen(app, Some(own));
    let chosen = app.state::<crate::state::AppState>().close_action();
    if quits_with_last_window(another_on_screen, chosen) {
        // Its close goes ahead (nothing unsaved, or the reader let it go), so the Quit does not ask about it again.
        forget_unsaved(own);
        app.exit(0);
    }
}

/// Pure, for the tests: whether a folder or document window's close ends the app.
fn quits_with_last_window(another_on_screen: bool, chosen: Option<CloseAction>) -> bool {
    !another_on_screen && chosen == Some(CloseAction::Quit)
}

/// Both answers, once one has been given. Hiding rather than destroying is what makes the tray instant, and
/// `exit` is the tray menu's own Quit reached from the × instead — same exit, so a downloaded update installs
/// on the way out exactly as it would there. The frame steps aside with both faces in it, and the × was its.
fn apply_close(app: &AppHandle, action: CloseAction) {
    match action {
        CloseAction::Tray => hide_faces(app),
        CloseAction::Quit => app.exit(0),
    }
}

/// The frame to the tray, from where "Open Intentic" brings back the face last in use.
pub(super) fn hide_faces(app: &AppHandle) {
    crate::frame::hide(app);
}

/// Raise the dialog over the window it is about. Built hidden and placed before it is ever shown, the same as
/// the frame, so nothing appears in the wrong spot for a frame.
///
/// Every failure here falls through to the tray rather than leaving the × doing nothing: a close that seems to
/// be ignored is the worst outcome available, and the app staying up is the recoverable one.
fn ask_before_closing(app: &AppHandle) {
    let (face, was_minimized) = match face_to_ask_over(app) {
        Some(pair) => (Some(pair.0), pair.1),
        None => (None, false),
    };
    if let Some(window) = app.get_webview_window(CONFIRM_CLOSE) {
        // Asked again while the question is up: put it back over the face, on screen, rather than only focusing it
        // wherever it is. A question nobody can see that every × only focuses is a × that does nothing.
        let size = window
            .outer_size()
            .ok()
            .zip(window.scale_factor().ok())
            .map(|(size, scale)| size.to_logical::<f64>(scale))
            .unwrap_or_else(|| LogicalSize::new(CONFIRM_WIDTH, CONFIRM_OPENING_HEIGHT));
        center_over(&window, face.as_ref(), size);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    // Owned by the frame only while it is on screen: a dialog owned by a minimised window is hidden with it.
    // When the face was just unminimized, `is_minimized()` can still read true because Windows restores
    // asynchronously — but the face WILL be on screen, so the dialog must be owned by it: ownership is what
    // keeps the dialog above the face. Without it, the face's restore animation and the dialog fight for the
    // foreground, and the dialog flickers behind the face (2026-10-24).
    let parent = if was_minimized {
        face
    } else {
        face.filter(window_on_screen)
    };
    let mode = app.state::<crate::state::AppState>().ui_mode();
    let mut builder =
        WebviewWindowBuilder::new(app, CONFIRM_CLOSE, WebviewUrl::App("index.html".into()))
            .title("Close Intentic?")
            .inner_size(CONFIRM_WIDTH, CONFIRM_OPENING_HEIGHT)
            // A card, not a window: the page draws its own header and ×, and there is nothing in a two-answer
            // question for an OS title bar to add. Its shadow is what separates it from the workspace under
            // it once the frame is gone. Resizable so `fit_to_content` can size it to its rendered content:
            // GTK pins a non-resizable window to its child's requisition and ignores a resize.
            .decorations(false)
            .shadow(true)
            .maximizable(false)
            .minimizable(false)
            // No second taskbar entry and no second alt-tab stop: this app is one window, and a dialog is
            // something you answer, not something you switch to.
            .skip_taskbar(true)
            // The frame between "window mapped" and "webview painted", which is white by default and reads as
            // a flash on a dark dialog — the exact impression of malfunction this whole change is about.
            .background_color(face_background(mode))
            .initialization_script(launch_id_script())
            .initialization_script(face_init_script(mode))
            // Nothing here reaches loopback. It carries the arguments so every window in this process agrees
            // on them, because the first one built is the one that configures the environment (BROWSER_ARGS).
            .additional_browser_args(BROWSER_ARGS)
            .visible(false)
            // When the face was just unminimized from the taskbar, Windows restores it with a foreground
            // activation that races the dialog's own `set_focus`. Always-on-top keeps the dialog above the
            // face throughout the restore animation; `fit_to_content` clears it once the dialog's content has
            // rendered and the restore is over (2026-10-24).
            .always_on_top(was_minimized);
    if let Some(parent) = &parent {
        builder = match owned_by(builder, parent) {
            Ok(owned) => owned,
            Err(error) => {
                eprintln!("close confirmation could not be owned by the app's window: {error}");
                return apply_close(app, CloseAction::Tray);
            }
        };
    }
    match builder.build() {
        Ok(window) => {
            settle_background(&window.as_ref().window(), mode);
            center_over(
                &window,
                parent.as_ref(),
                LogicalSize::new(CONFIRM_WIDTH, CONFIRM_OPENING_HEIGHT),
            );
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => {
            eprintln!("close confirmation failed to open: {error}");
            apply_close(app, CloseAction::Tray);
        }
    }
}

/// The face a close question stands over, brought back from the taskbar first. A × reaches a minimised face from its
/// taskbar button ("Close window"), and the question used to be centred on where Windows parks a minimised window,
/// (-32000, -32000): off every screen, and every × after it only focused that question again, so the × did nothing for
/// the rest of the run (2026-10-12). The reader asked about this window, so it comes back to be asked about.
///
/// Returns `(face, was_minimized)`: the caller needs to know whether the face was just unminimized, because
/// `is_minimized()` answers from the OS and can still read `true` for a window whose restore animation has not
/// finished yet — on Windows `unminimize()` is asynchronous. When it was, the dialog must still be owned by the
/// face (ownership is what keeps it on top), and it must not test `window_on_screen` against a state the OS has
/// not committed to yet (2026-10-24).
fn face_to_ask_over(app: &AppHandle) -> Option<(Window, bool)> {
    let face = shown_face(app)?;
    let was_minimized = !matches!(face.is_minimized(), Ok(false));
    if was_minimized {
        let _ = face.unminimize();
    }
    Some((face, was_minimized))
}

/// The dialog `builder` makes, owned by `parent` as Tauri's own `parent` would own it by a window of a page: on
/// Windows always above it and minimised with it, on Linux transient for it. The frame is a window with no page of
/// its own, which that `parent` cannot take.
fn owned_by<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    parent: &Window,
) -> tauri::Result<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>> {
    #[cfg(windows)]
    let owned = builder.owner_raw(parent.hwnd()?);
    #[cfg(target_os = "linux")]
    let owned = builder.transient_for_raw(&parent.gtk_window()?);
    #[cfg(not(any(windows, target_os = "linux")))]
    let owned = {
        let _ = parent;
        builder
    };
    Ok(owned)
}

/// The dialog's answer, arriving from the one command it can call (commands.rs). Cancelling is not an answer
/// and never reaches here — it is the dialog closing itself and the window staying exactly as it was.
pub fn resolve_close(app: &AppHandle, action: CloseAction, remember: bool) {
    if remember {
        app.state::<crate::state::AppState>()
            .remember_close_action(action);
    }
    // Before the window it is about moves, so the two never animate against each other.
    if let Some(window) = app.get_webview_window(CONFIRM_CLOSE) {
        let _ = window.destroy();
    }
    apply_close(app, action);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Beside a folder window on screen, a face's × closes the face alone and asks nothing, whatever was chosen; on its
    /// own, it does what was chosen, and asks when nothing was.
    #[test]
    fn a_face_closes_alone_beside_a_folder_window() {
        for chosen in [None, Some(CloseAction::Tray), Some(CloseAction::Quit)] {
            assert_eq!(
                face_close(true, chosen),
                Some(CloseAction::Tray),
                "{chosen:?}"
            );
            assert_eq!(face_close(false, chosen), chosen, "{chosen:?}");
        }
    }

    /// "Quit" ends the app with its last window on screen, and never while another is up; the tray, or nothing chosen,
    /// never ends it from a folder window.
    #[test]
    fn quit_ends_the_app_with_its_last_window() {
        assert!(quits_with_last_window(false, Some(CloseAction::Quit)));
        assert!(!quits_with_last_window(true, Some(CloseAction::Quit)));
        for another in [false, true] {
            assert!(!quits_with_last_window(another, Some(CloseAction::Tray)));
            assert!(!quits_with_last_window(another, None));
        }
    }
}
