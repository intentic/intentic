use super::close::CONFIRM_CLOSE;
use crate::state::{AppState, Look, Mode};
use tauri::{AppHandle, Manager, Webview, Window};

/* THE APP'S OWN FACES ARE DRAWN IN THE WORKSPACE'S LIGHT. */

/// What the two local pages read before they paint (their index.html): the scheme the workspace was last
/// seen in, or nothing, in which case the page follows the OS. Absent rather than defaulted on purpose — a
/// binary that always said "dark" is how a reader who chose the light look got a dark card in the middle
/// of a light workspace.
pub(super) fn face_init_script(mode: Option<Mode>) -> String {
    match mode {
        Some(mode) => format!("window.__INTENTIC_MODE__ = \"{}\";", mode.id()),
        None => String::new(),
    }
}

/// What every page of the editor the app builds reads before it paints (web index.html, the app's local.html and
/// sandbox.html): the reader's look as a page last announced it (state.rs `Look`), adopted there while that page's own
/// origin holds no look the reader chose. Nothing when no page has said, and the page decides as a browser tab would.
pub(super) fn look_init_script(look: Option<Look>) -> String {
    match look {
        Some(look) => format!("window.__INTENTIC_LOOK__ = \"{}\";", look.id()),
        None => String::new(),
    }
}

/// The frame between "window mapped" and the page's first paint, in the same light the page will paint in.
/// Mirrors `--color-canvas` (@intentic/ui semantic-colors.css) in each scheme. Nothing announced means light,
/// the same answer the pages themselves reach when the OS will not say — and [`settle_background`] corrects it
/// to the OS's own before the window is ever shown.
pub(crate) fn face_background(mode: Option<Mode>) -> tauri::window::Color {
    match mode {
        Some(Mode::Dark) => tauri::window::Color(15, 13, 10, 255),
        _ => tauri::window::Color(244, 241, 236, 255),
    }
}

/// The OS's light, which Tauri answers only per WINDOW — there is no system-wide getter, so the true answer
/// does not exist until a window has been built. The frame and every local window are built hidden and placed before
/// they are shown, so re-pointing the pre-paint frame here still lands before anything is on screen. Only consulted
/// when the workspace has announced no scheme of its own: what it announced outranks the OS, since the card
/// stands in the middle of that workspace.
pub(crate) fn settle_background(window: &Window, mode: Option<Mode>) {
    if os_says_dark(window, mode) {
        let _ = window.set_background_color(Some(face_background(Some(Mode::Dark))));
    }
}

/// [`settle_background`] for a face, whose webview paints its own background over the frame's until its page has.
pub(super) fn settle_face_background(face: &Webview, mode: Option<Mode>) {
    if os_says_dark(&face.window(), mode) {
        let _ = face.set_background_color(Some(face_background(Some(Mode::Dark))));
    }
}

fn os_says_dark(window: &Window, mode: Option<Mode>) -> bool {
    mode.is_none() && matches!(window.theme(), Ok(tauri::Theme::Dark))
}

/// A page announced its scheme and, from a page that knows it, the look it is in: the look is what the next page built
/// adopts (`look_init_script`), the scheme what the app's own faces are drawn in.
pub(super) fn announced(app: &AppHandle, mode: Mode, look: Option<Look>) {
    if let Some(look) = look {
        app.state::<AppState>().remember_ui_look(look);
    }
    apply_mode(app, mode);
}

/// The page announced its scheme, or the sign-in handoff implied one: remember it, and repaint the close question if
/// it is up, since it is built from the app's own bundle and drawn in the light of the window it stands over.
pub fn apply_mode(app: &AppHandle, mode: Mode) {
    let state = app.state::<crate::state::AppState>();
    if !state.remember_ui_mode(mode) {
        return;
    }
    if let Some(window) = app.get_webview_window(CONFIRM_CLOSE) {
        let _ = window.set_background_color(Some(face_background(Some(mode))));
        let _ = window.eval(mode_script(mode));
    }
}

/// What the running page does with a scheme that arrived after it painted — the same attribute its own
/// pre-paint script sets, flipped in place.
fn mode_script(mode: Mode) -> String {
    match mode {
        Mode::Dark => "document.documentElement.setAttribute('data-mode', 'dark');".to_string(),
        Mode::Light => "document.documentElement.removeAttribute('data-mode');".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* WHAT THE LOCAL PAGES READ BEFORE THEY PAINT, and what flips them afterwards. */
    #[test]
    fn a_known_mode_is_handed_to_the_page_and_an_unknown_one_leaves_it_to_the_os() {
        assert_eq!(
            face_init_script(Some(Mode::Light)),
            "window.__INTENTIC_MODE__ = \"light\";"
        );
        assert_eq!(
            face_init_script(Some(Mode::Dark)),
            "window.__INTENTIC_MODE__ = \"dark\";"
        );
        assert_eq!(
            face_init_script(None),
            "",
            "nothing said means the page asks the OS"
        );
        assert!(mode_script(Mode::Dark).contains("setAttribute('data-mode', 'dark')"));
        assert!(mode_script(Mode::Light).contains("removeAttribute('data-mode')"));
    }

    /* THE LOOK EVERY EDITOR PAGE IS HANDED: the name its pre-paint script and the Theme row both use. */
    #[test]
    fn a_known_look_is_handed_to_every_page_and_none_leaves_it_to_the_page() {
        assert_eq!(
            look_init_script(Some(Look::Sanctum)),
            "window.__INTENTIC_LOOK__ = \"sanctum\";"
        );
        assert_eq!(
            look_init_script(Some(Look::System)),
            "window.__INTENTIC_LOOK__ = \"system\";"
        );
        assert_eq!(look_init_script(None), "");
    }

    #[test]
    fn the_frame_behind_a_face_is_the_canvas_it_will_paint() {
        assert_eq!(
            face_background(Some(Mode::Dark)),
            tauri::window::Color(15, 13, 10, 255)
        );
        assert_eq!(
            face_background(Some(Mode::Light)),
            tauri::window::Color(244, 241, 236, 255)
        );
        assert_eq!(
            face_background(None),
            face_background(Some(Mode::Light)),
            "nothing said means light, the same answer the page reaches when the OS will not say"
        );
    }
}
