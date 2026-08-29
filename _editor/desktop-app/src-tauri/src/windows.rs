use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::setup_link::{parse_link, Link, SetupArgs, Source};
use crate::state::CloseAction;

/* ONE WINDOW ON SCREEN, EVER — these two labels are two FACES of it, not two windows, and there is no
 * exception to that any more.
 *
 * There have to be two webviews. The workspace face is remote content (the hosted SPA) and gets no IPC at all;
 * the launcher face is local content holding this app's entire command surface. Tauri scopes capabilities by
 * window LABEL, so merging them into one label would hand app.intentic.dev the launcher's permissions — the one
 * thing this app's design exists to refuse.
 *
 * What the user is owed is not one webview but one WINDOW, and that is what `swap_in` enforces: whichever face
 * is being shown first takes the other's frame — same position, same size — and the other steps aside. Only
 * the title changes, because it is the label on a taskbar entry and ought to say which screen is up. So a
 * screen change reads as the window moving on rather than as a second app arriving on top of the first.
 *
 * THE SETUP SCREEN USED TO BE EXEMPT, on the argument that an install is not somewhere the user went but
 * something happening to the app they are in — so the launcher came up IN FRONT of the workspace instead of
 * replacing it. Whatever that argument was worth on paper, what it produced was two Intentic windows, two
 * taskbar buttons and two alt-tab stops at the exact moment a first-time user has the least idea what this
 * app is: the reported complaint was "I end up with two windows and I don't know which one is the product".
 * An install is a SCREEN of this app now, and it arrives the way every other screen does. */
pub const WORKSPACE: &str = "workspace";
pub const LAUNCHER: &str = "launcher";

/// The third label, and NOT a third face: a dialog the app draws about the window it is standing in front of.
/// It keeps to the one-window rule the way a dialog does — off the taskbar, owned by the frame it is about,
/// and gone the moment it is answered.
pub const CONFIRM_CLOSE: &str = "confirm-close";

/// The frame both faces share when neither has one to inherit — a cold start, on either face. A PREFERENCE
/// rather than a size: what a window actually opens at is this fitted to the screen, see `opening_bounds`.
const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);
const MIN_SIZE: (f64, f64) = (900.0, 600.0);

/* WHAT THE FRAME COSTS OUTSIDE THE SIZE THAT IS ASKED FOR. Every size here is an INNER one — the client area
 * — and the title bar and border are added back OUTSIDE it. So a window asked for exactly the work area's
 * height opens exactly a title bar taller than the screen can show.
 *
 * Logical units, and deliberately generous. The real figure varies by platform, theme and display scale, and
 * the cost of over-reserving is a few unused pixels at the edge of a window nobody has resized yet — against
 * a first impression that reads as broken. */
const FRAME_ALLOWANCE: (f64, f64) = (16.0, 48.0);

/* THE SIZE TO OPEN AT, given what this screen can actually show.
 *
 * `DEFAULT_SIZE` is 1440×900 and was treated as if it always fits. It is LOGICAL, so at the 150% scale most
 * laptops are sold at it is 2160×1350 physical — on a panel with 1080 physical rows. The first window a new
 * user ever sees opened a third taller than their display, with its bottom edge and everything near it off
 * the screen entirely. Both faces open through this, so it is one arithmetic rather than a rule each screen
 * has to remember.
 *
 * Pure and separate from the monitor lookup so it can be tested against the numbers that actually break, and
 * fitted rather than merely capped: the preference wins whenever it fits, the screen wins whenever it does
 * not. A screen smaller than `MIN_SIZE` is not a reason to open something bigger than the screen — the
 * minimum comes down too, because a floor above the ceiling is a window that cannot be resized onto its own
 * display. */
fn fit_to_screen(preferred: (f64, f64), available: (f64, f64)) -> (f64, f64) {
    let room = |available: f64, allowance: f64| (available - allowance).max(1.0);
    (
        preferred.0.min(room(available.0, FRAME_ALLOWANCE.0)),
        preferred.1.min(room(available.1, FRAME_ALLOWANCE.1)),
    )
}

/// The opening size and the minimum that goes with it — the minimum fitted to the same screen, so it can
/// never be the thing that holds a window bigger than the display it is on.
fn opening_bounds(available: Option<(f64, f64)>) -> ((f64, f64), (f64, f64)) {
    let Some(available) = available else {
        return (DEFAULT_SIZE, MIN_SIZE);
    };
    let size = fit_to_screen(DEFAULT_SIZE, available);
    (size, (MIN_SIZE.0.min(size.0), MIN_SIZE.1.min(size.1)))
}

/// The screen a window is about to open on: where its usable area STARTS and how big it is, logical, plus the
/// scale that turns the answer back into pixels. The origin is carried because it is not (0, 0) on a secondary
/// monitor, nor on a display with the taskbar docked to the left or the top.
#[derive(Clone, Copy, Debug, PartialEq)]
struct WorkArea {
    origin: (f64, f64),
    size: (f64, f64),
    scale: f64,
}

/* WHERE A COLD-START WINDOW OPENS — the half of the fit that was missing, and the half the user meets first.
 *
 * `fit_to_screen` stopped this app asking for a window taller than the display. It did not put the window
 * anywhere, and an unplaced window is not a centred one: Tauri leaves the position to the platform, and the
 * platform's answer on Windows is `CW_USEDEFAULT` — the cascade, which steps each new window down and to the
 * right of the last. Fit a window to the full height of the work area and then let the cascade push it down,
 * and its bottom edge is under the taskbar. On a first run that is exactly the strip the chat composer lives
 * in: the one control the whole screen exists for, missing, in the first impression the app ever makes.
 *
 * Centring is the placement that cannot do that, and it is what a window with nothing remembered about it is
 * expected to do anyway. Two details are load-bearing:
 *
 * - It centres on the WORK AREA, not on the monitor — which is why this is arithmetic here rather than
 *   Tauri's own `center()`. That one centres on the full screen, so with a taskbar at the bottom it hands
 *   back half a taskbar of the very overhang this exists to remove.
 * - It centres the OUTER rectangle. Every size in this file is an inner one with the frame added outside it
 *   (`FRAME_ALLOWANCE`), so centring the inner size leaves the title bar over the top edge of the screen and
 *   the same distance of window past the bottom.
 *
 * Never negative: a window bigger than the work area starts AT the origin, where the part of it that is on
 * screen is the top-left — the corner carrying the title bar to drag it by and the controls to resize it. */
fn opening_position(work: WorkArea, inner: (f64, f64)) -> (f64, f64) {
    let offset = |available: f64, outer: f64| ((available - outer) / 2.0).max(0.0);
    (
        work.origin.0 + offset(work.size.0, inner.0 + FRAME_ALLOWANCE.0),
        work.origin.1 + offset(work.size.1, inner.1 + FRAME_ALLOWANCE.1),
    )
}

/* The work area of the screen a window is about to open on — its usable rectangle rather than its full size,
 * so a taskbar, a dock or a panel is space this app neither sizes into nor places into.
 *
 * `None` when the platform will not say, which is a real answer on a headless or freshly-plugged display and
 * is read as "no reason to shrink the preference, and no better guess than the platform's own placement".
 *
 * The PRIMARY monitor, because a window that does not exist yet is not on any of them — which is the same
 * assumption the OS makes when it places an unplaced window, so the two agree on which screen this is about. */
fn work_area(app: &AppHandle) -> Option<WorkArea> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let area = monitor.work_area();
    Some(WorkArea {
        origin: (
            f64::from(area.position.x) / scale,
            f64::from(area.position.y) / scale,
        ),
        size: (
            f64::from(area.size.width) / scale,
            f64::from(area.size.height) / scale,
        ),
        scale,
    })
}

/// Put `window` in the middle of `work` at the inner size it was just built with. Physical, converted here
/// from the monitor's own scale rather than handed to Tauri as logical units: a logical position is resolved
/// against whatever scale the WINDOW reports, and a window the platform has just cascaded onto another display
/// reports that display's — which is how a placement computed for one screen lands on a different one.
fn place_in_work_area(window: &WebviewWindow, work: WorkArea, inner: (f64, f64)) {
    let at = opening_position(work, inner);
    let _ = window.set_position(PhysicalPosition::new(
        (at.0 * work.scale).round() as i32,
        (at.1 * work.scale).round() as i32,
    ));
}

/// The dialog's frame. Fixed, because everything in it is: two choices and a line of small print — measured
/// against the rendered content rather than guessed, with slack for a wider font. Taller on Windows, the one
/// platform where the tray option has to say where the icon goes (CloseConfirm.vue).
const CONFIRM_SIZE: (f64, f64) = if cfg!(target_os = "windows") {
    (460.0, 360.0)
} else {
    (460.0, 300.0)
};

/// Bring `window` up in `other`'s place. Placed and sized BEFORE it is shown and `other` hidden only after, so
/// nothing between the two frames is ever on screen. Physical units throughout: outer position with inner size
/// is the same rectangle for two windows wearing the same decorations.
fn swap_in(window: &WebviewWindow, other: Option<WebviewWindow>) {
    if let Some(other) = other.filter(|other| other.is_visible().unwrap_or(false)) {
        if let Ok(position) = other.outer_position() {
            let _ = window.set_position(position);
        }
        if let Ok(size) = other.inner_size() {
            let _ = window.set_size(size);
        }
        let _ = window.show();
        let _ = window.set_focus();
        let _ = other.hide();
        return;
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Marks the page as running inside the desktop app. DETECTION ONLY — the handoff is the `intentic://`
/// navigation this window intercepts, so no IPC is ever exposed to remote content.
///
/// The install id rides along so the SPA's analytics can say which app an event came from, and join it to what
/// the launcher reported about the same install (state.rs). It is a random per-install id and grants nothing:
/// remote content that reads it learns only that it is inside an app, which the version already told it.
///
/// `update` is the third value and the newest: the version this app has already DOWNLOADED and is one restart
/// away from running, or null. It is here as well as on the event (update.rs `announce_to_workspace`) because
/// the two cover different orderings — the event reaches a page that is already open, and this reaches a page
/// that loads afterwards. Without it a webview navigated at any point after the download would draw no banner
/// and the app would look, from inside, exactly as up to date as it is not.
fn workspace_init_script(install_id: &str, update: Option<&str>) -> String {
    let update = match update {
        Some(version) => format!("\"{}\"", crate::update::escape_js(version)),
        None => "null".to_string(),
    };
    format!(
        "(function () {{ if (!window.__INTENTIC_DESKTOP__) {{ window.__INTENTIC_DESKTOP__ = Object.freeze({{ version: \"{}\", installId: \"{install_id}\", update: {update} }}); }} }})();",
        env!("CARGO_PKG_VERSION")
    )
}

/// Whether a URL should stay inside the workspace webview. Everything else — a provider's token page, docs,
/// mailto — is opened in the user's default browser instead.
fn stays_in_webview(url: &Url, app_origin: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => url.origin() == app_origin.origin(),
        // intentic:// is handled before this is called.
        "about" | "blob" | "data" | "javascript" => true,
        _ => false,
    }
}

/// Open a link in the default browser, off the webview thread. The workspace webview has no IPC surface, so
/// this is the only way out for external links the SPA renders with target="_blank".
fn open_in_browser(app: &AppHandle, url: &str) {
    let app = app.clone();
    let url = url.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = app.opener().open_url(&url, None::<&str>) {
            eprintln!("could not open link in browser: {url} ({error})");
        }
    });
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
    let state = app.state::<crate::state::AppState>();
    let base = state.app_url();
    let install_id = state.install_id();
    let target = match path {
        Some(path) => format!("{}{path}", base.trim_end_matches('/')),
        None => base,
    };
    if let Some(window) = app.get_webview_window(WORKSPACE) {
        swap_in(&window, app.get_webview_window(LAUNCHER));
        // The workspace coming back is the cheapest evidence this machine is awake and being used, which the
        // six-hourly timer cannot see through a night of sleep (update.rs).
        crate::update::nudge(app);
        if path.is_some() {
            match target.parse() {
                Ok(url) => {
                    let _ = window.navigate(url);
                }
                Err(error) => eprintln!("workspace path is not a url: {target} ({error})"),
            }
        }
        return;
    }
    let url: tauri::Url = match target.parse() {
        Ok(url) => url,
        Err(_) => crate::state::APP_URL
            .parse()
            .expect("static app url parses"),
    };
    let link_handler = app.clone();
    let app_origin: Url = state.app_url().parse().unwrap_or_else(|_| {
        crate::state::APP_URL
            .parse()
            .expect("static app url parses")
    });
    let screen = work_area(app);
    let (size, min) = opening_bounds(screen.map(|screen| screen.size));
    let builder = WebviewWindowBuilder::new(app, WORKSPACE, WebviewUrl::External(url))
        .title("Intentic")
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        /* Tauri's native drag-drop handler and the webview's HTML5 drag-drop API are mutually exclusive on
         * Windows (and the same on Linux): with the handler on, OS files never reach the SPA's drop handlers
         * (WorkspaceDesktop.vue, WorkspaceTree.vue), so drag-and-drop from Explorer works in the browser but
         * not here. The workspace upload pipeline is built on DataTransfer/webkitGetAsEntry, so the handler
         * stays off on this window. */
        .disable_drag_drop_handler()
        // Built hidden so `swap_in` can place it on the frame it is taking over before it is ever on screen —
        // a finished setup hands the window back, and the workspace must appear where the setup was standing.
        .visible(false)
        .initialization_script(workspace_init_script(
            &install_id,
            crate::update::stage(app).ready_version(),
        ))
        .on_navigation({
            let link_handler = link_handler.clone();
            let app_origin = app_origin.clone();
            move |url| {
                if url.scheme() == "intentic" {
                    // Handle off the navigation callback — creating a window inside the webview's navigation
                    // event would re-enter the webview (WebView2 COM re-entrancy).
                    let app = link_handler.clone();
                    let link = url.to_string();
                    tauri::async_runtime::spawn(async move {
                        // The one direction that is this app's own window navigating — the SPA's button.
                        crate::handle_intentic_link(&app, &link, Source::App);
                    });
                    return false;
                }
                if stays_in_webview(url, &app_origin) {
                    return true;
                }
                open_in_browser(&link_handler, url.as_str());
                false
            }
        })
        .on_new_window({
            let link_handler = link_handler.clone();
            move |url, _features| {
                open_in_browser(&link_handler, url.as_str());
                NewWindowResponse::Deny
            }
        });
    match builder.build() {
        Ok(window) => {
            // The × is a question, not an exit — see `request_close`. Whichever way it is answered, the window
            // is HIDDEN rather than destroyed, so reopening from the tray is instant and this webview keeps the
            // session it signed in with instead of reloading the SPA.
            let handle = app.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    request_close(&handle);
                }
            });
            // Before `swap_in`, and while the window is still hidden. This is the placement for a COLD start —
            // a swap that has a frame to inherit overwrites it a line later, which is the right precedence:
            // the window the user is already looking at beats the middle of the screen.
            if let Some(screen) = screen {
                place_in_work_area(&window, screen, size);
            }
            swap_in(&window, app.get_webview_window(LAUNCHER));
        }
        Err(error) => eprintln!("workspace window failed to open: {error}"),
    }
}

pub fn show_workspace(app: &AppHandle) {
    show_workspace_at(app, None);
}

/* THE × IS A QUESTION, ASKED BEFORE ANYTHING HAPPENS — and asked in this app's own voice.
 *
 * A window that disappears into a tray icon is only a good deal if the user can find the icon, and on Windows
 * they often cannot: new tray icons are filed behind the overflow arrow by default, and nothing an app can do
 * promotes itself out of there. That is how this app came to be met as the uninstaller's "Intentic is running"
 * prompt — a process nobody could see, announcing itself at the worst possible moment.
 *
 * The first answer to that was a notice AFTER the fact: the window vanished, and an OS message box said where
 * it had gone. Two things were wrong with it and both were the same thing. It reported rather than asked, so
 * the one gesture it left was "OK" to something already done — and every native message box carries an icon,
 * which is what makes Windows play the alert chime at it. A window closing the way its author intended is not
 * an event that should sound like a fault.
 *
 * So the close asks first, offers the two answers that actually exist, and is drawn by this app rather than by
 * the platform — which is also the only way to draw it silently. Answer it once with "always do this" and the
 * question is gone for good (`AppState::close_action`).
 */
fn request_close(app: &AppHandle) {
    match app.state::<crate::state::AppState>().close_action() {
        Some(action) => apply_close(app, action),
        None => ask_before_closing(app),
    }
}

/// Both answers, once one has been given. Hiding rather than destroying is what makes the tray instant, and
/// `exit` is the tray menu's own Quit reached from the × instead — same exit, so a downloaded update installs
/// on the way out exactly as it would there.
fn apply_close(app: &AppHandle, action: CloseAction) {
    match action {
        CloseAction::Tray => {
            if let Some(window) = app.get_webview_window(WORKSPACE) {
                let _ = window.hide();
            }
        }
        CloseAction::Quit => app.exit(0),
    }
}

/// Raise the dialog over the window it is about. Built hidden and placed before it is ever shown, the same as
/// `swap_in`, so nothing appears in the wrong spot for a frame.
///
/// Every failure here falls through to the tray rather than leaving the × doing nothing: a close that seems to
/// be ignored is the worst outcome available, and the app staying up is the recoverable one.
fn ask_before_closing(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CONFIRM_CLOSE) {
        let _ = window.set_focus();
        return;
    }
    let parent = app.get_webview_window(WORKSPACE);
    let mut builder =
        WebviewWindowBuilder::new(app, CONFIRM_CLOSE, WebviewUrl::App("index.html".into()))
            .title("Close Intentic?")
            .inner_size(CONFIRM_SIZE.0, CONFIRM_SIZE.1)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            // No second taskbar entry and no second alt-tab stop: this app is one window, and a dialog is
            // something you answer, not something you switch to.
            .skip_taskbar(true)
            // The frame between "window mapped" and "webview painted", which is white by default and reads as
            // a flash on a dark dialog — the exact impression of malfunction this whole change is about.
            // Mirrors `--color-canvas` in dark mode (@intentic/ui semantic-colors.css), which index.html pins.
            .background_color(tauri::window::Color(15, 13, 10, 255))
            .visible(false);
    if let Some(parent) = &parent {
        builder = match builder.parent(parent) {
            Ok(owned) => owned,
            Err(error) => {
                eprintln!("close confirmation could not be owned by the workspace: {error}");
                return apply_close(app, CloseAction::Tray);
            }
        };
    }
    match builder.build() {
        Ok(window) => {
            center_over(
                &window,
                parent.as_ref(),
                LogicalSize::new(CONFIRM_SIZE.0, CONFIRM_SIZE.1),
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

/// The middle of the window being asked about, not the middle of the screen — a window that opens away from
/// the thing it is about reads as belonging to something else. Falls back to the middle of the screen when
/// there is nothing to be about, which is an ordinary state for both callers: a confirmation with no workspace
/// behind it, and a setup started from a link that opened this app cold.
///
/// `size` is what the window will be WEARING when it is shown, passed in rather than read back off it. A
/// window that has just been asked to resize does not answer with its new size on every platform — GTK
/// resizes on its own clock — and a setup placed against the size it is leaving lands half a window off.
fn center_over(window: &WebviewWindow, over: Option<&WebviewWindow>, size: LogicalSize<f64>) {
    let own: PhysicalSize<u32> = size.to_physical(window.scale_factor().unwrap_or(1.0));
    let placed = over.and_then(|over| {
        Some(centered(
            over.outer_position().ok()?,
            over.outer_size().ok()?,
            own,
        ))
    });
    match placed {
        Some(position) => {
            let _ = window.set_position(position);
        }
        None => {
            let _ = window.center();
        }
    }
}

/// Where a window of `own` goes to sit in the middle of the rectangle at `position` of size `frame`. Signed
/// throughout: a window wider than the one it is centred on gets a negative offset, which is the correct
/// answer — the two stay concentric — where clamping it to zero would hang it off to one side.
fn centered(
    position: tauri::PhysicalPosition<i32>,
    frame: PhysicalSize<u32>,
    own: PhysicalSize<u32>,
) -> tauri::PhysicalPosition<i32> {
    tauri::PhysicalPosition::new(
        position.x + (frame.width as i32 - own.width as i32) / 2,
        position.y + (frame.height as i32 - own.height as i32) / 2,
    )
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

/// The app's own face, built once and shown by `show_launcher` — whichever of its two screens is up. Never
/// shown from here: it has to be placed on the frame it is taking over before it is ever on screen, or it
/// flashes in the old one.
fn launcher(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(LAUNCHER) {
        return Some(window);
    }
    let screen = work_area(app);
    let (size, min) = opening_bounds(screen.map(|screen| screen.size));
    let result = WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("index.html".into()))
        .title("Intentic")
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        /* The frame between "window mapped" and "webview painted", which is white by default and reads as a
         * flash on a dark screen — and this window maps at the exact moment the workspace steps aside, so a
         * white frame here is a white flash in the middle of somebody's app. Mirrors `--color-canvas` in dark
         * mode (@intentic/ui semantic-colors.css), which index.html pins — the same colour the confirmation
         * dialog paints for the same reason. */
        .background_color(tauri::window::Color(15, 13, 10, 255))
        .visible(false)
        .build();
    match result {
        Ok(window) => {
            // Closing this face means "I am done here", not "quit" — so the workspace comes back. Ending the
            // app here instead would take it away from a user one gesture after the setup they just ran, and
            // the screen that setup was for is the one behind this window.
            let handle = app.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    show_workspace(&handle);
                }
            });
            // The same cold-start placement the workspace gets, and needed for the same reason: this face can
            // be the FIRST window an install ever shows (a link from the browser, nothing else running), and
            // the platform's cascade puts a work-area-tall window's bottom edge under the taskbar. A swap with
            // a workspace frame to inherit overrides it a moment later, so this only decides where a window
            // nothing else has an opinion about goes.
            if let Some(screen) = screen {
                place_in_work_area(&window, screen, size);
            }
            Some(window)
        }
        Err(error) => {
            eprintln!("launcher window failed to open: {error}");
            None
        }
    }
}

/* THIS APP'S OWN FACE, IN THE WORKSPACE'S PLACE — for BOTH of the screens it draws.
 *
 * There is one entry point because there is one gesture: the window stops showing the hosted product and
 * starts showing this app, at the same size, in the same spot, under a title that says which screen it is on.
 * WHICH screen is App.vue's business, not this file's (a setup can arrive at a manager window, and a finished
 * one hands the window back), and the frame is identical either way, so there is nothing here to choose.
 *
 * The setup screen used to have a second entry point and a frame of its own — a small window centred on the
 * workspace, with that window left mapped behind it. It was defended as "an install is not somewhere you go",
 * and the user it was for saw two Intentic windows during the one flow where they know least about the app.
 * A screen of this app is a screen of this app. */
pub fn show_launcher(app: &AppHandle) {
    if let Some(window) = launcher(app) {
        swap_in(&window, app.get_webview_window(WORKSPACE));
    }
}

/* A RUN THAT STOPPED HAS TO REACH THE PERSON WHO STARTED IT.
 *
 * An install runs for minutes, and this window is deliberately minimisable and deliberately never topmost,
 * because taking someone's screen for those minutes would be indefensible. The cost of that is the case this
 * exists for: a setup that fails while the window is minimised, or while the user has gone back to their
 * workspace, changes only pixels nobody is looking at. "The error did not surface and did not notify user"
 * is precisely that.
 *
 * `request_user_attention` is the OS's own way to point at a window — a flashing taskbar button on Windows,
 * the equivalent hint on Linux — and it is the polite one: it does not steal focus, it waits to be noticed.
 * The unminimise and the show are what make there be something to notice.
 *
 * IT SWAPS WHEN, AND ONLY WHEN, THE WORKSPACE HAS THE FRAME. Walking away from a running install hands the
 * window back, and a bare `show()` from there would put this face up BESIDE the workspace — reintroducing the
 * second window at the worst possible moment, on the one screen that exists to be read carefully. That case
 * has to take focus, because the window the user was looking at is the one stepping aside. Every other case
 * does not, so it stays a show and a hint: raising a window somebody is not looking at over the application
 * they moved on to is exactly what `request_user_attention` exists to avoid.
 */
pub fn alert_setup(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LAUNCHER) else {
        return;
    };
    let _ = window.unminimize();
    match app
        .get_webview_window(WORKSPACE)
        .filter(|workspace| workspace.is_visible().unwrap_or(false))
    {
        Some(workspace) => swap_in(&window, Some(workspace)),
        None => {
            let _ = window.show();
        }
    }
    let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
}

/// Links land here from three directions: the workspace webview's intercepted navigation, the second-instance
/// argv, and the OS handler. A setup parks its request for the launcher face to pick up and run — which it
/// does in the frame the workspace was just occupying; an auth handoff goes straight back into the workspace
/// face, which is the only place it means anything.
///
/// `source` separates the first direction from the other two: only the webview's own navigation is a link
/// this app watched its own window ask for. See [`Source`] for what an external one loses, and
/// [`confirm_setup`] for what it has to answer first.
pub fn handle_link(app: &AppHandle, link: &str, source: Source) {
    match parse_link(link, source) {
        Some(Link::Setup(args)) => match source {
            Source::App => park_setup(app, *args),
            Source::External => confirm_setup(app, *args),
        },
        Some(Link::Recreate(args)) => {
            *app.state::<crate::state::AppState>()
                .pending_recreate
                .lock()
                .unwrap() = Some(args);
            show_launcher(app);
            let _ = tauri::Emitter::emit(app, "desktop://pending-recreate", ());
        }
        // The Desktop sync card's enrollment, handed over so the folder can be picked in a system dialog
        // rather than typed into a one-liner. App-source only by construction (setup_link.rs), so unlike a
        // setup there is nothing to confirm here: the SPA's own button said what it does, and the picker
        // and its confirmation are still ahead (App.vue).
        Some(Link::Sync(args)) => {
            *app.state::<crate::state::AppState>()
                .pending_sync
                .lock()
                .unwrap() = Some(args);
            show_launcher(app);
            let _ = tauri::Emitter::emit(app, "desktop://pending-sync", ());
        }
        Some(Link::SignIn) => {
            if let Err(error) = crate::auth::start(app) {
                eprintln!("{error}");
            }
        }
        Some(Link::Auth(args)) => crate::auth::complete(app, &args),
        // The banner's button. Nothing is parked and no face is swapped: the bytes are already on this machine
        // (update.rs), so this either installs and comes back, or opens the download page for a copy that
        // cannot install anything.
        Some(Link::Update) => crate::update::act(app),
        None => {}
    }
}

/// Hand a setup to the launcher face, which runs it on arrival (App.vue says why) — in the frame the
/// workspace that asked for it was occupying, which is the same handover every other screen of this app makes.
fn park_setup(app: &AppHandle, args: SetupArgs) {
    *app.state::<crate::state::AppState>()
        .pending
        .lock()
        .unwrap() = Some(args);
    show_launcher(app);
    let _ = tauri::Emitter::emit(app, "desktop://pending-setup", ());
}

/* A SETUP THIS APP NEVER SAW ITS OWN WINDOW ASK FOR — so ask, before anything runs.
 *
 * A parked setup runs immediately, and the consent for that is the SPA's own "Set up on this computer"
 * button, which states what it does in the sentence directly above it. That argument holds for exactly one of
 * the three directions a link arrives from. An `intentic://setup` from the OS is a link ANY page can navigate
 * to, and all the user was shown before it got here is the browser's "Open Intentic?" — a question about
 * opening an app, answered by someone who is about to get a container, a tunnel putting it on the internet,
 * and (with `syncDir`) a folder of theirs mirrored into it.
 *
 * So this says those things out loud and defaults to no. It is the same shape as the `state` nonce on an auth
 * handoff (auth.rs): a request this process cannot tie to something it started is not one it acts on.
 *
 * Non-blocking, like the tray notice and for the same reason: links reach here from the deep-link callback
 * and from a second instance's argv, either of which can be the main thread — and waiting there for an answer
 * waits on the thread that has to draw it. */
fn confirm_setup(app: &AppHandle, args: SetupArgs) {
    let sync = match args.sync_dir.as_deref() {
        Some(dir) => {
            format!("\n\nIt will also keep {dir} on this computer in sync with that sandbox.")
        }
        None => String::new(),
    };
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "Something asked Intentic to set up a sandbox on this computer.\n\n\
             That starts a container here and publishes it on the internet, where it is reachable by whoever \
             the setup link came from.{sync}\n\n\
             If you did not just choose \"Set up on this computer\" in Intentic, cancel this.",
        ))
        .title("Set up a sandbox on this computer?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Set up".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            if confirmed {
                park_setup(&handle, args);
            }
        });
}

#[cfg(test)]
mod link_tests {
    use super::*;

    fn origin(url: &str) -> Url {
        url.parse().unwrap()
    }

    #[test]
    fn same_origin_http_stays_in_the_webview() {
        let app = origin("https://app.intentic.dev");
        assert!(stays_in_webview(
            &origin("https://app.intentic.dev/capabilities/github"),
            &app
        ));
    }

    #[test]
    fn a_provider_token_page_leaves_the_webview() {
        let app = origin("https://app.intentic.dev");
        assert!(!stays_in_webview(
            &origin("https://github.com/settings/tokens/new"),
            &app
        ));
    }

    #[test]
    fn localhost_dev_origin_matches_itself() {
        let app = origin("http://localhost:47146");
        assert!(stays_in_webview(
            &origin("http://localhost:47146/capabilities/github"),
            &app
        ));
        assert!(!stays_in_webview(
            &origin("https://github.com/settings/tokens/new"),
            &app
        ));
    }

    #[test]
    fn mailto_leaves_the_webview() {
        let app = origin("https://app.intentic.dev");
        assert!(!stays_in_webview(
            &origin("mailto:support@intentic.dev"),
            &app
        ));
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    /// A screen to open onto, as the platform would describe it: a work area starting at the top-left with a
    /// taskbar taken off the bottom.
    fn screen(size: (f64, f64)) -> WorkArea {
        WorkArea {
            origin: (0.0, 0.0),
            size,
            scale: 1.0,
        }
    }

    /// The bottom edge of the window `opening_bounds` + `opening_position` agree on, against the bottom edge
    /// of the work area it was given. The whole of what the reported bug was: those two numbers, in the wrong
    /// order.
    fn bottom_edge(work: WorkArea) -> (f64, f64) {
        let (size, _) = opening_bounds(Some(work.size));
        let at = opening_position(work, size);
        (
            at.1 + size.1 + FRAME_ALLOWANCE.1,
            work.origin.1 + work.size.1,
        )
    }

    /// THE BUG THIS SHIPPED WITH, in the numbers that caused it: a 1080p panel at the 150% scale most laptops
    /// are sold with leaves 1080 physical rows, which is 720 logical — and the preference is 900. The first
    /// window a new user ever saw opened a third taller than the display and hung off the bottom of it.
    #[test]
    fn a_scaled_laptop_panel_does_not_get_a_window_taller_than_itself() {
        // 1920×1080 at 150%, less a 48px taskbar: what the platform reports as the work area, logical.
        let available = (1280.0, 688.0);
        let (size, min) = opening_bounds(Some(available));

        assert!(size.1 < available.1, "opened {size:?} into {available:?}");
        assert!(size.0 < available.0, "opened {size:?} into {available:?}");
        // And the floor cannot be what puts it back over the edge.
        assert!(
            min.1 <= size.1 && min.0 <= size.0,
            "min {min:?} over size {size:?}"
        );
    }

    /// A screen with room to spare gets the preference untouched — the fit is a ceiling, not a resize.
    #[test]
    fn a_large_display_still_opens_at_the_preferred_size() {
        assert_eq!(
            opening_bounds(Some((2560.0, 1400.0))),
            (DEFAULT_SIZE, MIN_SIZE)
        );
    }

    /// No monitor to ask is a real answer on a headless or freshly-plugged display, and is not a reason to
    /// shrink anything.
    #[test]
    fn an_unknown_screen_changes_nothing() {
        assert_eq!(opening_bounds(None), (DEFAULT_SIZE, MIN_SIZE));
    }

    /// A screen smaller than the minimum is still a screen the window has to fit on: the floor comes down
    /// with it, because a floor above the ceiling is a window that cannot be resized onto its own display.
    #[test]
    fn a_screen_below_the_minimum_lowers_the_minimum_too() {
        let (size, min) = opening_bounds(Some((800.0, 500.0)));

        assert!(size.0 < 800.0 && size.1 < 500.0, "opened {size:?}");
        assert_eq!(min, size);
    }

    /// Never zero or negative, whatever a desktop reports — a monitor unplugged mid-session can answer with
    /// an area smaller than the frame allowance, and a window asked for 0×0 is one nobody can grab.
    #[test]
    fn an_absurd_screen_still_asks_for_a_window() {
        let (size, _) = opening_bounds(Some((4.0, 4.0)));

        assert!(size.0 >= 1.0 && size.1 >= 1.0, "opened {size:?}");
    }

    /// The close confirmation opens in the MIDDLE of the window it is asking about, not on its corner — which
    /// is what says it is about that window. Asserted on the arithmetic because the windows themselves exist
    /// only in a running desktop session.
    #[test]
    fn the_close_dialog_lands_in_the_middle_of_the_window_it_is_about() {
        let workspace = PhysicalSize::new(1440u32, 900u32);
        let dialog = PhysicalSize::new(460u32, 300u32);
        let at = centered(PhysicalPosition::new(100, 50), workspace, dialog);
        assert_eq!(at, PhysicalPosition::new(100 + 490, 50 + 300));
        // Concentric: the gap left on one side is the gap left on the other.
        assert_eq!(
            at.x - 100,
            (workspace.width as i32 - dialog.width as i32) - (at.x - 100)
        );
    }

    /* THE BUG AS REPORTED, which the fit alone did not cover: the window opened with its bottom edge — and the
     * chat composer in it — under the taskbar. Sizing it to the screen was never enough on its own, because
     * nothing then said where it went, and Windows' answer to that is a cascade DOWN from the top-left.
     *
     * The numbers are the ones off the screenshot: a work area 1531×883 logical, which is a 2297×1324 pixel
     * usable rectangle at the 150% scale the display was running. */
    #[test]
    fn a_cold_start_window_opens_fully_inside_the_work_area() {
        let work = screen((1531.0, 883.0));
        let (window, available) = bottom_edge(work);

        assert!(
            window <= available,
            "window ends at {window}, screen at {available}"
        );
        // And it is not merely on screen by being tiny: the fit gives it every row the screen has to spare.
        let (size, _) = opening_bounds(Some(work.size));
        assert_eq!(size.1 + FRAME_ALLOWANCE.1, work.size.1);
    }

    /// The same, on the screens this app is actually met on — including the one where the preference fits and
    /// the cascade was therefore never the thing that broke it.
    #[test]
    fn no_ordinary_screen_gets_a_window_hanging_off_its_bottom() {
        for size in [
            (1531.0, 883.0),  // 1920×1080 at 150%, the reported one
            (1280.0, 688.0),  // 1920×1080 at 150% with a taller taskbar
            (2560.0, 1400.0), // room to spare — the preference wins and still has to be placed
            (1024.0, 700.0),  // a small laptop
            (800.0, 500.0),   // smaller than MIN_SIZE
        ] {
            let (window, available) = bottom_edge(screen(size));
            assert!(
                window <= available,
                "{size:?}: window ends at {window}, screen at {available}"
            );
        }
    }

    /// Centred, not merely on screen — the same gap above the window as below it, so nothing about the opening
    /// frame reads as having been shoved against an edge.
    #[test]
    fn a_cold_start_window_is_centred_in_the_work_area() {
        let work = screen((2560.0, 1400.0));
        let (size, _) = opening_bounds(Some(work.size));
        let at = opening_position(work, size);

        let above = at.1 - work.origin.1;
        let below = (work.origin.1 + work.size.1) - (at.1 + size.1 + FRAME_ALLOWANCE.1);
        assert!(
            (above - below).abs() < 0.001,
            "above {above}, below {below}"
        );
        let left = at.0 - work.origin.0;
        let right = (work.origin.0 + work.size.0) - (at.0 + size.0 + FRAME_ALLOWANCE.0);
        assert!((left - right).abs() < 0.001, "left {left}, right {right}");
    }

    /// The work area does not start at the origin of the screen, let alone of the desktop: a taskbar docked to
    /// the left or the top moves it, and so does every monitor that is not the first. A placement that ignored
    /// that would open the window over the taskbar, or on the wrong display entirely.
    #[test]
    fn the_window_opens_inside_the_work_area_wherever_that_area_starts() {
        let work = WorkArea {
            // A second monitor to the right, with the taskbar docked to the left of it.
            origin: (1920.0, 0.0),
            size: (1400.0, 1080.0),
            scale: 1.0,
        };
        let (size, _) = opening_bounds(Some(work.size));
        let at = opening_position(work, size);

        assert!(
            at.0 >= work.origin.0,
            "opened at {at:?}, area starts {:?}",
            work.origin
        );
        assert!(
            at.1 >= work.origin.1,
            "opened at {at:?}, area starts {:?}",
            work.origin
        );
        assert!(at.0 + size.0 + FRAME_ALLOWANCE.0 <= work.origin.0 + work.size.0);
        assert!(at.1 + size.1 + FRAME_ALLOWANCE.1 <= work.origin.1 + work.size.1);
    }

    /// A window that cannot fit starts AT the corner rather than at a negative offset — the piece of it left on
    /// screen is then the top-left, which is the piece carrying the title bar and the resize controls.
    #[test]
    fn a_window_too_big_for_its_screen_starts_at_the_corner() {
        let work = WorkArea {
            origin: (100.0, 50.0),
            size: (300.0, 200.0),
            scale: 1.0,
        };
        assert_eq!(opening_position(work, DEFAULT_SIZE), work.origin);
    }

    /// A window CENTRED on a smaller one hangs off it on both sides — the two stay concentric, where clamping
    /// the offset to zero would shove it into a corner. A workspace dragged narrower than the close dialog is
    /// a state a user can reach, not a hypothetical.
    #[test]
    fn a_window_larger_than_the_one_it_is_about_stays_concentric() {
        let at = centered(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(400, 200),
            PhysicalSize::new(460, 300),
        );
        assert_eq!(at, PhysicalPosition::new(-30, -50));
    }
}
