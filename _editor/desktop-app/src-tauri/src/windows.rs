use self::bounds::{take_frame, window_on_screen};
use self::chrome::{arm_frame_fallback, fit_decorations};
use self::hosted::{app_origin, page_webview};
use self::mode::settle_face_background;
use self::present::Press;
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
pub(crate) mod present;
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
/// title bar on the frame only while that face's page has none of its own ([`fit_decorations`]), and remember it as the
/// face the app is used through: only a reader's press draws a face (present.rs), so whatever it draws is the reader's
/// choice. The face, when there is one to draw.
fn swap_in(app: &AppHandle, label: &'static str, press: Press) -> Option<Webview> {
    let face = crate::frame::show(app, label, press)?;
    fit_decorations(app);
    app.state::<AppState>()
        .remember_last_face(if label == HOME {
            Face::Home
        } else {
            Face::Workspace
        });
    Some(face)
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
pub fn show_workspace_at(app: &AppHandle, press: Press, path: Option<&str>) {
    show_workspace_over(app, press, path, None);
}

/// The workspace opened by a press in `asked_in`, a local window's place chip (a sandbox, "Add a sandbox", the way to
/// agents) or its Settings: [`show_workspace_at`], in the place of the window that was pressed. The main window is the
/// workspace's other face and is swapped as always. A folder or document window (local.rs `FILES`) is a window of its
/// own, so the workspace takes ITS frame and the folder window goes ([`close_replaced`]): the reader sees the window they
/// pressed in change what it shows. _(2026-10-16) The workspace only ever took the main window's frame: a sandbox picked
/// in a window `intentic .` opened came up as a second window beside it, and the × of that one, answered "Quit", took
/// both down._
pub fn show_workspace_from(app: &AppHandle, press: Press, path: Option<&str>, asked_in: &Webview) {
    let replaced = is_folder_window(asked_in.label()).then(|| asked_in.window());
    show_workspace_over(app, press, path, replaced);
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
fn show_workspace_over(
    app: &AppHandle,
    press: Press,
    path: Option<&str>,
    replaced: Option<Window>,
) {
    let state = app.state::<AppState>();
    state.remember_workspace_seen();
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
    swap_in(app, WORKSPACE, press);
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

pub fn show_workspace(app: &AppHandle, press: Press) {
    show_workspace_at(app, press, None);
}

/// The face (machine_face.rs), the app's own copy of the editor on this computer's sandboxes, in the workspace's place,
/// on `sandbox` when it names one by its key there: what the offline page's "Use this computer's sandboxes" does, asked
/// for by the hosted page itself (`intentic://machine-face`) or by Devices' Open while the workspace does not answer
/// (`local_sandbox_open`). A workspace face already in the frame is sent there; none yet is built there, so the hosted
/// page is never loaded only to fail. Opened from a folder window, the face takes its place as the workspace would
/// ([`show_workspace_from`]). It is the workspace face that is in use, so the next launch opens the workspace, which
/// comes back to the face by itself while the platform is still out of reach (offline.rs).
pub fn show_machine_face_from(
    app: &AppHandle,
    press: Press,
    sandbox: Option<&str>,
    asked_in: Option<&Webview>,
) {
    let Ok(url) = crate::machine_face::face_url_for(sandbox).parse::<Url>() else {
        return;
    };
    let replaced = asked_in
        .filter(|window| is_folder_window(window.label()))
        .map(|window| window.window());
    match crate::frame::face(app, WORKSPACE) {
        Some(face) => {
            if let Err(error) = face.navigate(url) {
                eprintln!("the workspace could not be sent to this computer's sandboxes ({error})");
                return;
            }
        }
        None => {
            WARM.lock().unwrap().clear();
            if build_workspace(app, url).is_none() {
                return;
            }
        }
    }
    if let Some(frame) = crate::frame::frame(app) {
        take_frame(&frame, replaced.as_ref());
    }
    swap_in(app, WORKSPACE, press);
    close_replaced(replaced);
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

/// This computer, because the reader asked for it (a launch into it, the tray's "This computer", "Open Intentic" on an
/// install last used through it, the workspace's own way back), on whichever screen it was left on.
pub fn show_home(app: &AppHandle, press: Press) {
    show_home_at(app, press, None);
}

/// Devices, in the main window: the tray's agent row, Intentic OS's key for this computer, a notification about this
/// computer, a page's way back to the work it handed over. Asked for by name, as every face is.
pub fn show_device(app: &AppHandle, press: Press) {
    show_home_at(app, press, Some(DEVICE_ROUTE));
}

/// The route of This device in the local shell (the web's router, from the app's host view `device`).
pub const DEVICE_ROUTE: &str = "/device";

/// The route of the folder itself.
pub const FILES_ROUTE: &str = "/workspace";

/// The route of a process's own page in the local shell (the web's local routes, shell/rail/processes/), which hands a
/// process with a page of its own (a folder's setup, Repair, Devices' runs) to that page.
pub const PROCESS_ROUTE: &str = "/process";

/// The main window in front, at a route of its own shell (`/repair?from=tray`): the way the tray, a page's "Manage on
/// this computer" or a notification opens one of the local shell's views.
pub(crate) fn show_home_route(app: &AppHandle, press: Press, route: &str) {
    show_home_at(app, press, Some(route));
}

/// The main window in the workspace's place, at `route` when given: added to the frame on its folder the first time
/// (local.rs `open_home`, which draws it once it is up), drawn and taken there every time after. Only a press takes it
/// anywhere: a process says what it needs on its tile and leaves the screen the reader is on alone (present.rs).
fn show_home_at(app: &AppHandle, press: Press, route: Option<&str>) {
    if crate::frame::face(app, HOME).is_none() {
        crate::local::open_home_later(app, press, route.map(str::to_string));
        return;
    }
    let Some(face) = swap_in(app, HOME, press) else {
        return;
    };
    if let Some(route) = route {
        crate::local::navigate(&face, route);
    }
}

/// The face this app was last used through, as a bare launch and the tray's "Open Intentic" open it.
pub fn show_last_face(app: &AppHandle, press: Press) {
    match app.state::<AppState>().last_face() {
        Face::Home => show_home(app, press),
        Face::Workspace => show_workspace(app, press),
    }
}

/// The workspace's page told to go to `path` where nobody sees it, the face in the frame left as it is: a sign-in's
/// completion (auth.rs), which only that page can redeem, since its session cookie is set on that page's origin. A page
/// already up is told in place (its own sign-in dialog redeems it there, the web's signInDialog.ts) and routes there
/// itself; none yet is built there, out of sight. Nothing is shown, focused or remembered (present.rs).
pub fn tell_workspace(app: &AppHandle, path: &str) {
    let state = app.state::<AppState>();
    let base = state.app_url();
    let origin = url::Url::parse(&base)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    let target = format!("{}{path}", base.trim_end_matches('/'));
    match crate::frame::face(app, WORKSPACE) {
        Some(face) => {
            WARM.lock().unwrap().clear();
            if let Err(error) = face.eval(open_in_place(&origin, path, &target)) {
                eprintln!("the workspace could not be told where to go ({error})");
            }
        }
        None => {
            let Ok(url) = target.parse::<Url>() else {
                return;
            };
            let _ = build_workspace(app, url);
        }
    }
}

/// Bring a local window back in front of the reader, as the tray or a second double-click on the same file asks. The
/// main window is a face, so it comes up in the workspace's place, as the tray's "This computer" brings it (2026-10-12:
/// raised on its own, it stood beside the workspace). Shown by the reader's own doing, so it is the face in use from
/// then.
pub fn raise_window(app: &AppHandle, press: Press, window: &Webview) {
    if window.label() == HOME {
        show_home(app, press);
        return;
    }
    raise(press, window);
}

/// In front of the reader, whatever it was doing: hidden, minimised, or under the window that asked. A face is drawn
/// in the frame as well, since a frame raised over the other face would show the reader the wrong one.
fn raise(press: Press, page: &Webview) {
    if let Some(face) = crate::frame::face_label(page.label()) {
        swap_in(page.app_handle(), face, press);
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
