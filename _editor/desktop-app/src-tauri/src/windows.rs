use self::bounds::{take_frame, window_on_screen};
use self::chrome::{arm_frame_fallback, fit_decorations};
use self::hosted::{app_origin, page_webview};
use self::mode::settle_face_background;
use self::scripts::open_in_place;
use self::warmth::WARM;
use crate::state::{AppState, Face};
use tauri::{AppHandle, Manager, Url, Webview, Window};

pub(crate) mod bounds;
pub(crate) mod chrome;
pub(crate) mod close;
pub(crate) mod hosted;
pub(crate) mod links;
pub(crate) mod local_pages;
pub(crate) mod mode;
pub(crate) mod quit;
pub(crate) mod scripts;
pub(crate) mod setup;
pub(crate) mod unsaved;
pub(crate) mod warmth;

/* ONE WINDOW OF THE APP ON SCREEN — these two labels are two FACES of it, not two windows: the hosted workspace, and
the main local window (`HOME`), the editor's shell on a folder of this computer with This device beside it. They are two
webviews in the one window frame.rs builds, which shows one of them at a time (`swap_in`). A second window is one the
page asked for (a panel floated out, `FLOATING`) or one the reader did (a folder or a document opened on its own,
local.rs `FILES`). */
pub const WORKSPACE: &str = "workspace";

/// The main local window: where a launch without an account opens, and what the launcher's card became (2026-09-30).
pub const HOME: &str = "home";

/// Draw the face `label` in the frame, the other stepping aside in the same turn (frame.rs `show`), with the platform's
/// title bar on the frame only while that face's page has none of its own ([`fit_decorations`]). The face, when there
/// is one to draw.
fn swap_in(app: &AppHandle, label: &'static str, keyboard: Keyboard) -> Option<Webview> {
    let face = crate::frame::show(app, label, keyboard == Keyboard::Take)?;
    fit_decorations(app);
    Some(face)
}

/// Whether the keyboard comes with the face being raised: a face taking over a window somebody is reading has
/// to take it, one raising itself behind the user's back must not.
#[derive(Clone, Copy, PartialEq)]
enum Keyboard {
    Take,
    Leave,
}

/// The page the reader is typing into, by label: the face the frame draws while the frame has the focus, or the page of
/// the window of its own that has it.
pub(crate) fn focused_page(app: &AppHandle) -> Option<String> {
    if crate::frame::frame(app).is_some_and(|frame| frame.is_focused().unwrap_or(false)) {
        return crate::frame::shown().map(str::to_string);
    }
    app.webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

/// The frame while it is shown, the window a dialog about closing stands over, whichever face it draws.
fn shown_face(app: &AppHandle) -> Option<Window> {
    crate::frame::frame(app).filter(|frame| frame.is_visible().unwrap_or(false))
}

/// Open the workspace window, optionally at a path under the app origin rather than its root — which is how
/// the sign-in handoff lands (`/desktop-auth/complete?handoff=…`): the webview does an ordinary HTTP round
/// trip and the platform sets its session cookie on that origin, so no cookie is ever injected from Rust.
///
/// There is no user-agent override here any more. The archived version spoofed Safari on WebKitGTK because
/// Google refuses OAuth from an embedded webview — a workaround that only ever held until Google's next
/// heuristic. Sign-in now happens in the real browser (auth.rs), so nothing in this window ever talks to
/// Google and the webview can present itself honestly.
pub fn show_workspace_at(app: &AppHandle, path: Option<&str>) {
    show_workspace_over(app, path, None);
}

/// The workspace opened by a press in `asked_in`, a local window's place chip (a sandbox, "Add a sandbox", the way to
/// agents) or its Settings: [`show_workspace_at`], in the place of the window that was pressed. The main window is the
/// workspace's other face and is swapped as always. A folder or document window (local.rs `FILES`) is a window of its
/// own, so the workspace takes ITS frame and the folder window goes ([`close_replaced`]): the reader sees the window they
/// pressed in change what it shows. _(2026-10-16) The workspace only ever took the main window's frame: a sandbox picked
/// in a window `intentic .` opened came up as a second window beside it, and the × of that one, answered "Quit", took
/// both down._
pub fn show_workspace_from(app: &AppHandle, path: Option<&str>, asked_in: &Webview) {
    let replaced = is_folder_window(asked_in.label()).then(|| asked_in.window());
    show_workspace_over(app, path, replaced);
}

/// A folder or document window (local.rs `FILES`): a window of the app's own beside its one window of two faces. The
/// workspace opened from one takes its place (`show_workspace_from`), and while one is on screen a face's × closes that
/// face alone (`face_close`). The main window is already the workspace's other face, and a floating panel is a part of
/// the workspace's page.
fn is_folder_window(label: &str) -> bool {
    label.starts_with(crate::local::FILES)
}

/// Whether a folder or document window other than `except` is where the reader can see it. A spare is never on screen.
fn folder_window_on_screen(app: &AppHandle, except: Option<&str>) -> bool {
    app.webview_windows().into_iter().any(|(label, window)| {
        is_folder_window(&label)
            && Some(label.as_str()) != except
            && window_on_screen(&window.as_ref().window())
    })
}

/// The folder window the workspace has just taken the place of goes as its own × would close it: hidden first, so the
/// two are never on screen together, then closed, which revokes its folder (local.rs `window_closed`). Unsaved edits
/// hold the close as they hold any other (`close_turn`): the window comes back in front with its page's question.
fn close_replaced(window: Option<Window>) {
    let Some(window) = window else {
        return;
    };
    let _ = window.hide();
    let _ = window.close();
}

/// [`show_workspace_at`], in the place of `replaced` when it is given (`show_workspace_from`), else where the frame is.
fn show_workspace_over(app: &AppHandle, path: Option<&str>, replaced: Option<Window>) {
    let state = app.state::<AppState>();
    state.remember_workspace_seen();
    // Whatever brought it up, the workspace is now the face this app is being used through: the next launch and
    // the tray's "Open Intentic" open it (lib.rs `opening`).
    state.remember_last_face(Face::Workspace);
    crate::offer_workspace(app);
    let base = state.app_url();
    let origin = url::Url::parse(&base)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    // A setup started here offers, once its sandbox is up, the subscriptions this computer is signed in to (found.rs).
    let found_path = path.map(|path| crate::found::with_found(app, path));
    let path = found_path.as_deref();
    let target = match path {
        Some(path) => format!("{}{path}", base.trim_end_matches('/')),
        None => base,
    };
    // A face already in the frame is told where to go; one added now loads there.
    let loaded = crate::frame::face(app, WORKSPACE);
    let face = match &loaded {
        Some(face) => face.clone(),
        None => {
            WARM.lock().unwrap().clear();
            let url: tauri::Url = target.parse().unwrap_or_else(|_| {
                crate::state::APP_URL
                    .parse()
                    .expect("static app url parses")
            });
            let Some(face) = build_workspace(app, url) else {
                return;
            };
            face
        }
    };
    if let Some(frame) = crate::frame::frame(app) {
        take_frame(&frame, replaced.as_ref());
    }
    swap_in(app, WORKSPACE, Keyboard::Take);
    close_replaced(replaced);
    if loaded.is_none() {
        return;
    }
    // The workspace coming back is the cheapest evidence this machine is awake and being used, which the six-hourly
    // timer cannot see through a night of sleep (update.rs).
    crate::update::nudge(app);
    if let Some(path) = path {
        // A page put up ahead of this open ([`warm_workspace`]) is at this very address already: told it again, it would
        // route again and could flash what it has drawn. Anywhere else, the page is going elsewhere, and what it said it
        // shows no longer holds.
        if !WARM.lock().unwrap().must_tell(path) {
            return;
        }
        // Told to the page already loaded, which routes there itself: a sandbox picked in a local window's switcher is
        // a switch, not a reload of the whole workspace (`open_in_place`).
        if let Err(error) = face.eval(open_in_place(&origin, path, &target)) {
            eprintln!("the workspace could not be told where to go ({error}); loading {target}");
            match target.parse() {
                Ok(url) => {
                    let _ = face.navigate(url);
                }
                Err(error) => eprintln!("workspace path is not a url: {target} ({error})"),
            }
        }
    }
}

pub fn show_workspace(app: &AppHandle) {
    show_workspace_at(app, None);
}

/* THE WORKSPACE'S PAGE, LOADED WHERE NOBODY SEES IT (2026-10-13) — for the wake word, which it listens for (wake.rs). */

/// Add the workspace to the frame at the app's address, out of sight, when there is none: a launch whose page was
/// listening when the app last ran (wake.rs `resume_on_launch`), and the tray's "Listen for …" with no page to tell. It
/// is the face the reader would get from the tray, with nothing put on screen, nothing focused and nothing remembered:
/// the face this app was last used through (`last-face.json`) and whether the workspace was ever shown are about what
/// somebody looked at, and nobody looked at this. Showing it later is the swap every other road takes
/// (`show_workspace_at`), onto a page that is already there.
pub fn load_workspace_hidden(app: &AppHandle) {
    if crate::frame::face(app, WORKSPACE).is_some() {
        return;
    }
    let url = app_origin(&app.state::<AppState>());
    let _ = build_workspace(app, url);
}

/// The workspace face at `url`, added to the frame out of sight: its page and its handlers. Its caller draws it
/// (`show_workspace_over`) or leaves it there (`load_workspace_hidden`).
fn build_workspace(app: &AppHandle, url: Url) -> Option<Webview> {
    let builder = page_webview(app, WORKSPACE, url);
    let face = crate::frame::add_face(app, WORKSPACE, builder)?;
    crate::frame::set_title(app, WORKSPACE, "Intentic");
    let origin = app_origin(&app.state::<AppState>());
    // A page that cannot be reached gets the app's own screen, not the browser's (offline.rs).
    crate::offline::watch(&face, &origin);
    // A big drop on the explorer, copied into a sandbox on this computer by the app (drop_copy.rs).
    crate::drop_copy::watch(&face, &origin);
    // The microphone for the wake word, granted to the workspace's own page and to nothing else (microphone.rs).
    crate::microphone::allow(&face, &origin);
    // Out of sight until `swap_in`, so the OS's own light still lands before this face is on screen.
    settle_face_background(&face, app.state::<AppState>().ui_mode());
    arm_frame_fallback(app, WORKSPACE);
    Some(face)
}

/// This computer, because the user asked for it (a launch into it, the tray's "This computer", "Open Intentic" on an
/// install last used through it, the workspace's own way back): the main local window, remembered as the face this app
/// is being used through. Shown for work of the app's own (a setup, a recreate, an engine asleep: `show_device`), it
/// changes nothing about what opens next.
pub fn show_home(app: &AppHandle) {
    app.state::<AppState>().remember_last_face(Face::Home);
    show_home_at(app, None, Keyboard::Take);
}

/// This device, in the main window: where the app shows its own work on this machine (a setup handed over, a
/// recreate, a sync enrollment, the recovery panel's fix, a sleeping engine), whichever face was in use.
pub fn show_device(app: &AppHandle) {
    show_home_at(app, Some(DEVICE_ROUTE), Keyboard::Take);
}

/// The route of This device in the local shell (the web's router, from the app's host view `device`).
pub const DEVICE_ROUTE: &str = "/device";

/// The route of the folder itself.
pub const FILES_ROUTE: &str = "/workspace";

/// The route of a folder's way to its own sandbox (the web's local/setup/setupPath.ts `SANDBOX_SETUP_PATH`).
pub const SANDBOX_SETUP_ROUTE: &str = "/sandbox-setup";

/// The main window in front, at a route of its own shell (`/repair?from=tray`): the way a link, the tray or a
/// notification opens one of the local shell's views.
pub(crate) fn show_home_route(app: &AppHandle, route: &str) {
    app.state::<AppState>().remember_last_face(Face::Home);
    show_home_at(app, Some(route), Keyboard::Take);
}

/// The main window in the workspace's place, at `route` when given: added to the frame on its folder the first time
/// (local.rs `open_home`, which draws it once it is up), drawn and taken there every time after.
fn show_home_at(app: &AppHandle, route: Option<&str>, keyboard: Keyboard) {
    if crate::frame::face(app, HOME).is_none() {
        crate::local::open_home_later(app, route.map(str::to_string));
        return;
    }
    let Some(face) = swap_in(app, HOME, keyboard) else {
        return;
    };
    if let Some(route) = route {
        crate::local::navigate(&face, route);
    }
}

/// The window a sign-in begun on a folder was asked from, in front again (auth.rs `take_asked_in`), in the place of
/// the workspace that sign-in put up to redeem the session: the main window at its folder, or a folder window of its
/// own raised, with the main window's face back where the workspace stood. A window gone since, or none named, is the
/// main window's folder, which is where this way back always went (2026-10-17: a folder window that asked was left
/// behind the workspace, and the main window came forward on a different folder).
///
/// The main window comes back on its folder's way to a sandbox ([`return_route`]), where the sign-in was asked and
/// where the sandbox's making now shows: it used to come back on the folder's files, so a reader who had just signed in
/// had to find their way back to see anything happen (2026-10-21).
fn show_folder_that_asked(app: &AppHandle, asked_in: Option<&str>) {
    app.state::<AppState>().remember_last_face(Face::Home);
    let asked = asked_in
        .filter(|label| is_folder_window(label))
        .and_then(|label| app.get_webview_window(label));
    let Some(asked) = asked else {
        show_home_at(app, Some(return_route(asked_in)), Keyboard::Take);
        return;
    };
    match crate::frame::face(app, HOME) {
        Some(_) => show_home_at(app, None, Keyboard::Leave),
        // No main window to draw in the workspace's place: the frame steps aside.
        None => crate::frame::hide(app),
    }
    let _ = asked.unminimize();
    let _ = asked.show();
    let _ = asked.set_focus();
}

/// Where the main window comes back after a sign-in begun on a folder: the folder's way to its sandbox when the main
/// window itself asked (the page the reader pressed on), its files when the window that asked is gone or none was
/// named, since nothing then says that folder is the main window's. Pure.
pub(crate) fn return_route(asked_in: Option<&str>) -> &'static str {
    if asked_in == Some(HOME) {
        SANDBOX_SETUP_ROUTE
    } else {
        FILES_ROUTE
    }
}

/// The face this app was last used through, as a bare launch and the tray's "Open Intentic" open it.
pub fn show_last_face(app: &AppHandle) {
    match app.state::<AppState>().last_face() {
        Face::Home => show_home(app),
        Face::Workspace => show_workspace(app),
    }
}

/// Bring a local window back in front of the reader, as the tray or a second double-click on the same file asks. The
/// main window is a face, so it comes up in the workspace's place, as the tray's "This computer" brings it (2026-10-12:
/// raised on its own, it stood beside the workspace). Shown by the reader's own doing, so it is the face in use from
/// then.
pub fn raise_window(app: &AppHandle, window: &Webview) {
    if window.label() == HOME {
        show_home(app);
        return;
    }
    raise(window);
}

/// In front of the reader, whatever it was doing: hidden, minimised, or under the window that asked. A face is drawn
/// in the frame as well, since a frame raised over the other face would show the reader the wrong one.
fn raise(page: &Webview) {
    if let Some(face) = crate::frame::face_label(page.label()) {
        swap_in(page.app_handle(), face, Keyboard::Take);
        return;
    }
    let window = page.window();
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    crate::webview_sync::shown(page);
    crate::shown::tell(page, false);
}

#[cfg(test)]
mod tests {
    use super::close::CONFIRM_CLOSE;
    use super::*;

    /// A sign-in pressed on the main window's way to a sandbox comes back to that page, not to the folder's files.
    #[test]
    fn a_sign_in_asked_from_the_main_window_comes_back_to_its_folders_way_to_a_sandbox() {
        assert_eq!(return_route(Some(HOME)), SANDBOX_SETUP_ROUTE);
        assert_eq!(return_route(None), FILES_ROUTE);
        assert_eq!(return_route(Some("files-gone")), FILES_ROUTE);
    }

    /// A sandbox picked in a folder or document window opens the workspace in that window's place; picked in the main
    /// window, it is the usual swap of the two faces.
    #[test]
    fn the_workspace_takes_the_place_of_the_folder_window_it_was_opened_from() {
        assert!(is_folder_window("files-1"));
        assert!(is_folder_window("files-12"));
        assert!(!is_folder_window(HOME));
        assert!(!is_folder_window(WORKSPACE));
        assert!(!is_folder_window("floating-chat"));
        assert!(!is_folder_window(CONFIRM_CLOSE));
    }
}
