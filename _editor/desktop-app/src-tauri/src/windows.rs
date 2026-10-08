use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, Url, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::commands::SetupReport;
use crate::setup_link::{parse_link, Link, NoticeVerb, SetupArgs, Source, WindowVerb};
use crate::state::{AppState, CloseAction, Face, Mode};

/* ONE WINDOW OF THE APP ON SCREEN — these two labels are two FACES of it, not two windows: the hosted workspace, and
the main local window (`HOME`), the editor's shell on a folder of this computer with This device beside it. They swap
in one frame (`swap_in`). A second window is one the page asked for (a panel floated out, `FLOATING`) or one the
reader did (a folder or a document opened on its own, local.rs `FILES`). */
pub const WORKSPACE: &str = "workspace";
/// The main local window: where a launch without an account opens, and what the launcher's card became (2026-09-30).
pub const HOME: &str = "home";

/// The label prefix of a panel the page floated into a window of its own — `floating-chat` for
/// `/floating/chat` — built when the page's `window.open` names one (`page_window`'s new-window handler) and
/// destroyed when it is closed, however it is closed. As many as the page has panels, never two of one.
const FLOATING: &str = "floating-";

/// What a floating window opens at when the page names no size (it always does, from what it remembered),
/// and the least it can be dragged to: enough for the narrowest of the three panels to stay usable.
const FLOATING_SIZE: (f64, f64) = (1024.0, 720.0);
const FLOATING_MIN: (f64, f64) = (480.0, 320.0);

/* Chrome 142 made a request from a public origin to loopback a permission, collected with a dialog about "devices on your local network". */
const BROWSER_ARGS: &str = concat!(
    "--disable-features=",
    "msWebOOUI,msPdfOOUI,msSmartScreenProtection,",
    // Fetch, subresources and subframes — the /health probe and every daemon call after it.
    "LocalNetworkAccessChecks,",
    // Terminals and the browser view hold WebSockets on that same address (terminalSession.ts,
    // useBrowserView.ts); Chrome 147 brought them under the same permission.
    "LocalNetworkAccessChecksWebSockets,",
    "LocalNetworkAccessChecksWebTransport"
);

/// The third label, and NOT a third face: a dialog the app draws about the window it is standing in front of.
/// It keeps to the one-window rule the way a dialog does — off the taskbar, owned by the frame it is about,
/// and gone the moment it is answered.
pub const CONFIRM_CLOSE: &str = "confirm-close";

/// The workspace's frame on a cold start. A PREFERENCE rather than a size: what the window actually opens at
/// is this fitted to the screen, see `opening_bounds`.
const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);
const MIN_SIZE: (f64, f64) = (900.0, 600.0);

/// The margin a content-fitted window keeps from the edge of the work area, so a card that grows to the
/// screen's height still reads as a card on it rather than a window jammed against the taskbar.
const CONTENT_MARGIN: f64 = 24.0;
/// The least a face is ever fitted to: an empty manager still has its header and its one sentence.
const CONTENT_MIN_HEIGHT: f64 = 120.0;

/* THE SIZE TO OPEN AT, given what this screen can actually show. */
fn fit_to_screen(preferred: (f64, f64), available: (f64, f64)) -> (f64, f64) {
    // Never zero, whatever a desktop reports: a monitor unplugged mid-session can answer with an area of
    // nothing at all, and a window asked for 0×0 is one nobody can grab.
    (
        preferred.0.min(available.0.max(1.0)),
        preferred.1.min(available.1.max(1.0)),
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

/* WHERE A COLD-START WINDOW OPENS — the half of the fit that was missing, and the half the user meets first. */
fn opening_position(work: WorkArea, inner: (f64, f64)) -> (f64, f64) {
    let offset = |available: f64, outer: f64| ((available - outer) / 2.0).max(0.0);
    (
        work.origin.0 + offset(work.size.0, inner.0),
        work.origin.1 + offset(work.size.1, inner.1),
    )
}

/* The work area of the screen a window is about to open on — its usable rectangle rather than its full size, so a taskbar. */
fn work_area(app: &AppHandle) -> Option<WorkArea> {
    work_area_of(app.primary_monitor().ok().flatten())
}

/// The work area of the screen a window is ALREADY on, for a window being refitted in place: a card on a
/// second monitor is clamped to that monitor, not to the primary one.
fn window_work_area(window: &WebviewWindow) -> Option<WorkArea> {
    work_area_of(window.current_monitor().ok().flatten())
}

fn work_area_of(monitor: Option<Monitor>) -> Option<WorkArea> {
    let monitor = monitor?;
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

/// The dialog's frame: a card, fixed in width and fitted to its content. It opens at a
/// guess close to what its page measures a moment later, because it has to be on screen the instant the × is
/// clicked, before its page has run; the fit then corrects the guess by a few pixels at most. Taller on
/// Windows, the one platform where the tray option has to say where the icon goes (CloseConfirm.vue).
const CONFIRM_WIDTH: f64 = 440.0;
const CONFIRM_OPENING_HEIGHT: f64 = if cfg!(target_os = "windows") {
    312.0
} else {
    296.0
};

/// The height a content-fitted window gets: what its page measured, no less than a card's worth, and no more
/// than the work area leaves it with a margin above and below. Pure, for the tests: the cases that matter are
/// a requirements list taller than a laptop screen, and a screen smaller than any card.
fn fitted_height(content: f64, available: Option<f64>) -> f64 {
    let wanted = content.max(CONTENT_MIN_HEIGHT);
    match available {
        Some(available) => wanted.min((available - 2.0 * CONTENT_MARGIN).max(1.0)),
        None => wanted,
    }
}

/// A logical size as whole physical pixels, rounded UP. Tauri would convert this itself, and it ROUNDS: at a
/// fractional display scale (Windows' 125%, 150%, 175%) a size rounded down gives the webview a client area a
/// fraction shorter than the page that measured it, and the page answers that with a scrollbar down a card
/// which has nothing to scroll. A scale that is not a positive number is no scale at all.
fn whole_pixels(size: LogicalSize<f64>, scale: f64) -> PhysicalSize<u32> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    PhysicalSize::new(
        (size.width * scale).ceil() as u32,
        (size.height * scale).ceil() as u32,
    )
}

/// Where a window that has just been refitted keeps its top edge: where it was, unless its new bottom edge
/// would leave the work area, in which case it moves up by exactly the overhang, and never above the area's
/// top margin. A card grows DOWNWARD from a heading that stays put, which is what makes rows arriving under
/// it readable; one that grew off the bottom of the screen would hide the rows it grew for.
fn kept_on_screen(top: f64, height: f64, work: WorkArea) -> f64 {
    let lowest_top = work.origin.1 + work.size.1 - CONTENT_MARGIN - height;
    top.min(lowest_top).max(work.origin.1 + CONTENT_MARGIN)
}

/* THE PAGE SAYS HOW TALL IT IS, AND THE WINDOW FOLLOWS: the close question's card, the one window still fitted to its page. */
pub fn fit_to_content(app: &AppHandle, window: &WebviewWindow, content_height: f64) {
    if window.label() != CONFIRM_CLOSE || !content_height.is_finite() {
        return;
    }
    let work = window_work_area(window).or_else(|| work_area(app));
    let size = LogicalSize::new(
        CONFIRM_WIDTH,
        fitted_height(content_height, work.map(|work| work.size.1)),
    );
    let _ = window.set_size(whole_pixels(size, window.scale_factor().unwrap_or(1.0)));
    center_over(window, shown_face(app).as_ref(), size);
    if let (Some(work), Ok(at)) = (work, window.outer_position()) {
        let top = f64::from(at.y) / work.scale;
        let kept = kept_on_screen(top, size.height, work);
        if (kept - top).abs() >= 1.0 {
            let _ = window.set_position(PhysicalPosition::new(
                at.x,
                (kept * work.scale).round() as i32,
            ));
        }
    }
}

/// Bring `window` up and step `other` aside: shown first and hidden after, so nothing between the two is
/// ever on screen. The face coming up takes the frame of the one going (`take_frame`), called before this, so the
/// swap reads as one window changing what it shows.
fn swap_in(window: &WebviewWindow, other: Option<WebviewWindow>, keyboard: Keyboard) {
    let _ = window.show();
    // Its frame was just set while it was hidden, which is the change its webview is the last to hear of.
    crate::webview_sync::shown(window);
    if keyboard == Keyboard::Take {
        let _ = window.set_focus();
    }
    crate::shown::tell(window, false);
    if let Some(other) = other {
        // Hidden whatever it answers about itself: `is_visible` is a round trip to the event loop, and an
        // answer that fails to arrive reads as "already hidden", which is both faces on screen at once.
        // Hiding a window that is already hidden is a no-op, so nothing is spent asking.
        let _ = other.hide();
        crate::shown::tell(&other, false);
    }
}

/// Whether the keyboard comes with the face being raised: a face taking over a window somebody is reading has
/// to take it, one raising itself behind the user's back must not.
#[derive(Clone, Copy, PartialEq)]
enum Keyboard {
    Take,
    Leave,
}

/// The face coming up takes the frame of the face going, when that one is on screen: its place, its size, and
/// whether it is maximised. The two faces are one window to the reader, who moved and sized it once. A face with
/// nothing on screen to take over keeps the frame it has (the platform remembers a hidden window's).
fn take_frame(window: &WebviewWindow, from: Option<&WebviewWindow>) {
    let Some(from) = from.filter(|from| from.is_visible().unwrap_or(false)) else {
        return;
    };
    if from.is_maximized().unwrap_or(false) {
        let _ = window.maximize();
        return;
    }
    let _ = window.unmaximize();
    if let (Ok(position), Ok(size)) = (from.outer_position(), from.inner_size()) {
        let _ = window.set_position(position);
        let _ = window.set_size(size);
    }
}

/// The face on screen, the one a dialog about closing stands over: the workspace or the main local window.
fn shown_face(app: &AppHandle) -> Option<WebviewWindow> {
    [WORKSPACE, HOME]
        .into_iter()
        .filter_map(|label| app.get_webview_window(label))
        .find(|window| window.is_visible().unwrap_or(false))
}

/// Marks the page as running inside the desktop app. DETECTION ONLY — the handoff is the `intentic://`
/// navigation this window intercepts, so no IPC is ever exposed to remote content.
///
/// The install id rides along so the SPA's analytics can say which app an event came from, and join it to what
/// This device reported about the same install (state.rs). It is a random per-install id and grants nothing:
/// remote content that reads it learns only that it is inside an app, which the version already told it.
///
/// `update` is the third value and the newest: the version this app has already DOWNLOADED and is one restart
/// away from running, or null. It is here as well as on the event (update.rs `announce_to_workspace`) because
/// the two cover different orderings — the event reaches a page that is already open, and this reaches a page
/// that loads afterwards. Without it a webview navigated at any point after the download would draw no banner
/// and the app would look, from inside, exactly as up to date as it is not.
///
/// `loopbackUngated` is the fourth and is about the WINDOW rather than the app: this webview does not gate the
/// reach for loopback (`BROWSER_ARGS` on Windows, WebKit having no such check anywhere else), so the page may
/// dial the sandbox on this machine without first showing the card that explains a dialog nothing is going to
/// raise. It grants nothing — the page could always make the request; this only says nobody will interrupt it.
///
/// `frameless` is the fifth and is the page's INSTRUCTION TO DRAW A TITLE BAR: this window has no platform
/// frame, so the three buttons it used to carry are the page's to draw, in the bar it already has across the
/// top of every column (the SPA's WindowControls.vue). It is a claim about the window rather than a permission,
/// and it is the half that stops an app OLDER than the page from ending up with two sets of controls: a build
/// that still opens a decorated window simply never says this, and the page draws nothing.
///
/// `projectSync` is the sixth and is about what this BUILD understands: a sync link carrying `project=` (a
/// hosted sandbox holding one folder, setup_link.rs) is copied into that folder's project and nowhere else. The
/// web setup hands a folder to a hosted machine only when the app says this, because an older build reads the
/// same link as a whole-`/work` sync and would pour the sandbox's workspace into the user's folder.
///
/// `notices` is the seventh, and also about the build: it puts up the system's notifications and the tab's mark on
/// its icon when the page asks (`intentic://notice`, `intentic://badge`; notice.rs, badge.rs), so the page offers
/// them in its settings and sends them only to an app that says this.
fn workspace_init_script(install_id: &str, update: Option<&str>) -> String {
    let update = match update {
        Some(version) => format!("\"{}\"", crate::update::escape_js(version)),
        None => "null".to_string(),
    };
    format!(
        "(function () {{ if (!window.__INTENTIC_DESKTOP__) {{ window.__INTENTIC_DESKTOP__ = Object.freeze({{ version: \"{}\", installId: \"{install_id}\", update: {update}, loopbackUngated: true, frameless: true, projectSync: true, notices: true }}); }} }})();",
        env!("CARGO_PKG_VERSION")
    )
}

/// The downloaded update a window of the page is told of (`update` above): the workspace's and its floating panels',
/// whose banner offers it. A local window is told of none and draws no banner: the app's own version is the
/// workspace's to offer, and a banner over somebody's document offering a restart is one more way to lose what they
/// typed.
fn update_told(stage: &crate::update::Stage, local: bool) -> Option<&str> {
    if local {
        return None;
    }
    stage.ready_version()
}

/* THE APP'S OWN FACES ARE DRAWN IN THE WORKSPACE'S LIGHT. */

/// What the two local pages read before they paint (their index.html): the scheme the workspace was last
/// seen in, or nothing, in which case the page follows the OS. Absent rather than defaulted on purpose — a
/// binary that always said "dark" is how a reader who chose the light look got a dark card in the middle
/// of a light workspace.
fn face_init_script(mode: Option<Mode>) -> String {
    match mode {
        Some(mode) => format!("window.__INTENTIC_MODE__ = \"{}\";", mode.id()),
        None => String::new(),
    }
}

/// The frame between "window mapped" and the page's first paint, in the same light the page will paint in.
/// Mirrors `--color-canvas` (@intentic/ui semantic-colors.css) in each scheme. Nothing announced means light,
/// the same answer the pages themselves reach when the OS will not say — and [`settle_background`] corrects it
/// to the OS's own before the window is ever shown.
fn face_background(mode: Option<Mode>) -> tauri::window::Color {
    match mode {
        Some(Mode::Dark) => tauri::window::Color(15, 13, 10, 255),
        _ => tauri::window::Color(244, 241, 236, 255),
    }
}

/// The OS's light, which Tauri answers only per WINDOW — there is no system-wide getter, so the true answer
/// does not exist until a window has been built. Both local faces are built hidden and placed before they are
/// shown, so re-pointing the pre-paint frame here still lands before anything is on screen. Only consulted
/// when the workspace has announced no scheme of its own: what it announced outranks the OS, since the card
/// stands in the middle of that workspace.
fn settle_background(window: &WebviewWindow, mode: Option<Mode>) {
    if mode.is_some() || !matches!(window.theme(), Ok(tauri::Theme::Dark)) {
        return;
    }
    let _ = window.set_background_color(Some(face_background(Some(Mode::Dark))));
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
/// this is the only way out for a link that leaves the app.
///
/// What arrives here is a navigation or a `window.open`, NEVER a `target="_blank"` press: WebView2 raises its
/// new-window event for `window.open` and for a named target, and for `_blank` raises nothing at all, so that
/// press dies inside the webview. The page re-issues those as `window.open` before they are lost (`_editor/web`,
/// `environments/desktop.ts` `installDesktopLinks`), which is why every `target="_blank"` in the app reaches
/// this function at all.
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
    if let Some(window) = app.get_webview_window(WORKSPACE) {
        let home = app.get_webview_window(HOME);
        take_frame(&window, home.as_ref());
        swap_in(&window, home, Keyboard::Take);
        // The workspace coming back is the cheapest evidence this machine is awake and being used, which the
        // six-hourly timer cannot see through a night of sleep (update.rs).
        crate::update::nudge(app);
        if let Some(path) = path {
            // Told to the page already loaded, which routes there itself: a sandbox picked in a local window's
            // switcher is a switch, not a reload of the whole workspace (`open_in_place`).
            if let Err(error) = window.eval(open_in_place(&origin, path, &target)) {
                eprintln!(
                    "the workspace could not be told where to go ({error}); loading {target}"
                );
                match target.parse() {
                    Ok(url) => {
                        let _ = window.navigate(url);
                    }
                    Err(error) => eprintln!("workspace path is not a url: {target} ({error})"),
                }
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
    let screen = work_area(app);
    let (size, min) = opening_bounds(screen.map(|screen| screen.size));
    let builder = page_window(app, WORKSPACE, url)
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        // Built hidden so `swap_in` can place it on the frame it is taking over before it is ever on screen —
        // a finished setup hands the window back, and the workspace must appear where the setup was standing.
        .visible(false);
    match builder.build() {
        Ok(window) => {
            crate::webview_sync::watch(&window);
            crate::shown::watch(&window);
            // A page that cannot be reached gets the app's own screen, not the browser's (offline.rs).
            crate::offline::watch(&window, &app_origin(&app.state::<AppState>()));
            // Hidden until `swap_in`, so the OS's own light still lands before this window is on screen.
            settle_background(&window, app.state::<AppState>().ui_mode());
            let handle = app.clone();
            window.on_window_event(move |event| match event {
                // The × is a question, not an exit — see `request_close`. Whichever way it is answered, the
                // window is HIDDEN rather than destroyed, so reopening from the tray is instant and this
                // webview keeps the session it signed in with instead of reloading the SPA. The page's own ×
                // arrives here too: it asks the window to close rather than deciding anything itself.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    request_close(&handle);
                }
                /* WHAT THE PAGE'S MAXIMISE BUTTON DRAWS FOLLOWS THE WINDOW, NOT THE PRESS. */
                WindowEvent::Resized(_) => {
                    if let Some(window) = handle.get_webview_window(WORKSPACE) {
                        announce_frame(&window, false);
                    }
                }
                _ => {}
            });
            arm_frame_fallback(app, WORKSPACE);
            // Before `swap_in`, and while the window is still hidden. This is the placement for a COLD start —
            // a swap that has a frame to inherit overwrites it a line later, which is the right precedence:
            // the window the user is already looking at beats the middle of the screen.
            if let Some(screen) = screen {
                place_in_work_area(&window, screen, size);
            }
            let home = app.get_webview_window(HOME);
            take_frame(&window, home.as_ref());
            swap_in(&window, home, Keyboard::Take);
        }
        Err(error) => eprintln!("workspace window failed to open: {error}"),
    }
}

pub fn show_workspace(app: &AppHandle) {
    show_workspace_at(app, None);
}

/// What the workspace page registers to be told a path without a reload (the web's desktop.ts
/// `installDesktopOpener`).
const PAGE_OPENER: &str = "__INTENTIC_OPEN__";

/// The script that takes a loaded workspace page to `path`: through the page's own opener, which routes in place and
/// selects a sandbox the path names, when the page is the workspace's and has one; otherwise by loading `target`, as
/// every app did before the opener existed, so a page older than this app (or one still loading) is never left where
/// it was. Each value rides as a JSON string, which is a JavaScript string literal, so a path cannot end the statement.
fn open_in_place(origin: &str, path: &str, target: &str) -> String {
    let literal = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(() => {{ const open = window.{PAGE_OPENER}; if (location.origin === {origin} && typeof open === 'function') {{ open({path}); }} else {{ location.href = {target}; }} }})();",
        origin = literal(origin),
        path = literal(path),
        target = literal(target),
    )
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

/// The main window in the workspace's place, at `route` when given: built on its folder the first time (local.rs
/// `open_home`, which swaps it in once it is up), raised and taken there every time after.
fn show_home_at(app: &AppHandle, route: Option<&str>, keyboard: Keyboard) {
    let Some(window) = app.get_webview_window(HOME) else {
        crate::local::open_home_later(app, route.map(str::to_string));
        return;
    };
    let workspace = app.get_webview_window(WORKSPACE);
    take_frame(&window, workspace.as_ref());
    let _ = window.unminimize();
    swap_in(&window, workspace, keyboard);
    if let Some(route) = route {
        crate::local::navigate(&window, route);
    }
}

/// The face this app was last used through, as a bare launch and the tray's "Open Intentic" open it.
pub fn show_last_face(app: &AppHandle) {
    match app.state::<AppState>().last_face() {
        Face::Home => show_home(app),
        Face::Workspace => show_workspace(app),
    }
}

/// The origin the page is served from, which is also the one origin whose links stay inside a page window.
fn app_origin(state: &AppState) -> Url {
    state.app_url().parse().unwrap_or_else(|_| {
        crate::state::APP_URL
            .parse()
            .expect("static app url parses")
    })
}

/* EVERY WINDOW SHOWING THE PAGE IS BUILT HERE — the workspace, and each panel of it floating on its own. */

/// What the workspace and a floating panel have in common, which is everything but their size and when they
/// appear: no platform frame (the page draws the bar, see [`WindowVerb`]), the page's own dark under it, the
/// browser arguments, the page told what window it is in, and the same answer for every link out of it.
fn page_window<'a>(
    app: &'a AppHandle,
    label: &str,
    url: Url,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let state = app.state::<AppState>();
    let origin = app_origin(&state);
    let install_id = state.install_id();
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Intentic")
/* NO PLATFORM TITLE BAR ON ANY WINDOW OF THE PAGE — see [`WindowVerb`] for the bar the page draws in its place. */
        .decorations(false)
        .shadow(true)
        // The frame between "window mapped" and the REMOTE page's first paint, which is white by default and is
        // longest on the launch that has no HTTP cache to open from. The two local faces have always had this;
        // the windows that wait on a network were the ones without it. In the scheme the page was last seen in,
        // never a fixed one: this window used to open on near-black under a reader who had chosen daylight.
        .background_color(face_background(state.ui_mode()))
/* Windows uses either Tauri drag-drop or HTML5 drag-drop, never both. */
        .disable_drag_drop_handler()
        // The windows this is actually for — see BROWSER_ARGS, and `loopbackUngated` in the init script, which
        // tells the page it was done.
        .additional_browser_args(BROWSER_ARGS)
        .initialization_script(workspace_init_script(
            &install_id,
            update_told(&crate::update::stage(app), false),
        ))
        .on_navigation({
            let app = app.clone();
            let label = label.to_string();
            let origin = origin.clone();
            move |url| {
                if url.scheme() == "intentic" {
                    // Handle off the navigation callback — creating a window inside the webview's navigation
                    // event would re-enter the webview (WebView2 COM re-entrancy).
                    let app = app.clone();
                    let label = label.clone();
                    let link = url.to_string();
                    tauri::async_runtime::spawn(async move {
                        // The one direction that is this app's own window navigating — the SPA's button.
                        crate::handle_intentic_link(&app, &link, Source::App { window: &label });
                    });
                    return false;
                }
                // The app's own page for a workspace that cannot be reached (offline.rs), which sends the window here.
                if stays_in_webview(url, &origin) || crate::offline::is_offline_page(url) {
                    return true;
                }
                open_in_browser(&app, url.as_str());
                false
            }
        })
        // Something on screen: this launch has reached the reader, even if what it shows is an error.
        .on_page_load(|_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                crate::launch::reached(crate::launch::Stage::Shown);
            }
        })
        // A `window.open`: the page floating one of its own panels gets a window of this app's (its browser
        // popup, done natively); anything else opened this way leaves for the browser. Denied either way — the
        // window the page gets is built by this app, off the callback, for the same re-entrancy reason as above.
        .on_new_window({
            let app = app.clone();
            move |url, features| {
                match floating_panel(&url, &origin) {
                    Some(panel) => {
                        let app = app.clone();
                        let size = features.size();
                        let position = features.position();
                        tauri::async_runtime::spawn(async move {
                            show_floating(&app, &panel, url, size, position);
                        });
                    }
                    None => open_in_browser(&app, url.as_str()),
                }
                NewWindowResponse::Deny
            }
        })
}

/* A PANEL IN A WINDOW OF ITS OWN. */

/// The panel a `window.open` names, when it is the page floating one of its own panels: `/floating/<panel>`
/// under the app's origin (and under its path, where the page is served under one). Anything else — another
/// origin, a page of the app opened "in a new tab" — is not one, and goes to the browser as it always has.
fn floating_panel(url: &Url, app_origin: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") || url.origin() != app_origin.origin() {
        return None;
    }
    let panel = url
        .path()
        .strip_prefix(app_origin.path().trim_end_matches('/'))?
        .strip_prefix("/floating/")?;
    // One lowercase word: the route's own regex admits exactly that, and the label is built from it.
    (!panel.is_empty() && panel.bytes().all(|byte| byte.is_ascii_lowercase()))
        .then(|| panel.to_string())
}

fn floating_label(panel: &str) -> String {
    format!("{FLOATING}{panel}")
}

/// "Intentic · Chat": what the taskbar and alt-tab call the window, since a frameless window has no bar of its
/// own to read the page's `document.title` off.
fn floating_title(panel: &str) -> String {
    let mut letters = panel.chars();
    match letters.next() {
        Some(first) => format!(
            "Intentic · {}{}",
            first.to_ascii_uppercase(),
            letters.as_str()
        ),
        None => "Intentic".to_string(),
    }
}

/// Raise the floating window for `panel`, building it if there is none: the page never asks twice while one
/// is up (it raises the one it can see instead), so a second ask is a page that lost sight of it. Size and
/// position are what the page put in `window.open`'s features — the frame it remembered for that panel.
fn show_floating(
    app: &AppHandle,
    panel: &str,
    url: Url,
    size: Option<LogicalSize<f64>>,
    position: Option<tauri::LogicalPosition<f64>>,
) {
    let label = floating_label(panel);
    if let Some(window) = app.get_webview_window(&label) {
        raise(&window);
        return;
    }
    let size = size.unwrap_or_else(|| LogicalSize::new(FLOATING_SIZE.0, FLOATING_SIZE.1));
    let mut builder = page_window(app, &label, url)
        .title(floating_title(panel))
        .inner_size(size.width, size.height)
        .min_inner_size(FLOATING_MIN.0, FLOATING_MIN.1);
    builder = match position {
        Some(position) => builder.position(position.x, position.y),
        None => builder.center(),
    };
    match builder.build() {
        Ok(window) => {
            crate::webview_sync::watch(&window);
            crate::shown::watch(&window);
            // A page that cannot be reached gets the app's own screen, not the browser's (offline.rs).
            crate::offline::watch(&window, &app_origin(&app.state::<AppState>()));
            let handle = app.clone();
            let own = label.clone();
            window.on_window_event(move |event| match event {
                /* WHAT THE PAGE'S MAXIMISE BUTTON DRAWS FOLLOWS THE WINDOW, NOT THE PRESS. */
                WindowEvent::Resized(_) => {
                    if let Some(window) = handle.get_webview_window(&own) {
                        announce_frame(&window, false);
                    }
                }
                // Closing IS docking: the page in it stops announcing its claim and the workspace draws the
                // panel again (the SPA's floating.ts). Nothing is asked and nothing is hidden — a panel is
                // reopened by popping it out again, not from the tray.
                WindowEvent::Destroyed => forget_chrome(&own),
                _ => {}
            });
            arm_frame_fallback(app, &label);
            let _ = window.set_focus();
        }
        Err(error) => eprintln!("floating window for {panel} failed to open: {error}"),
    }
}

/* A WINDOW ON A FOLDER OF THE USER'S OWN DISK (local.rs). */

/// Where a local window may navigate in place: the app's own bundle (whichever scheme this platform serves it
/// under, or the dev server's), and the loopback editor ONLYOFFICE frames. Anything else leaves for the browser.
fn stays_in_files_window(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost" | "localhost" | "127.0.0.1")
        ),
        _ => false,
    }
}

/// How a local window comes up: on screen for the grant it was built for, hidden as the spare the next open wears
/// (local.rs, the warm window: a page that has already loaded the editor and waits for its face), or as the main
/// window (`HOME`), which takes the workspace's frame and place and, like the workspace, is hidden by its × rather
/// than closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilesWindow {
    Shown,
    Spare,
    Home,
}

/// Build the window that shows one grant of the sidecar: the local face of the app's own bundle
/// (`files/local`), told who it is by `init` (`__INTENTIC_LOCAL__`, local.rs) before any of its script runs, or,
/// for a [`FilesWindow::Spare`], by [`wear_face`] later. Frameless like every page window, drawn by the same page
/// bar. Unlike the workspace it holds a capability (capabilities/local.json): the commands its shell and This device
/// call. Its links are still only `window` and `local` (setup_link.rs), and its files come from the sidecar's port.
///
/// Built hidden and placed before it is shown, as the workspace is, so it never appears for a frame wherever the
/// platform's cascade put it.
pub fn show_files_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    init: &str,
    how: FilesWindow,
) -> Result<WebviewWindow, String> {
    let state = app.state::<AppState>();
    let screen = work_area(app);
    let (size, min) = opening_bounds(screen.map(|screen| screen.size));
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("files/local".into()))
        .title(title)
        .decorations(false)
        .shadow(true)
        .background_color(face_background(state.ui_mode()))
        // Drops land in the page: the explorer copies a dragged file into the folder, as the workspace does.
        .disable_drag_drop_handler()
        .additional_browser_args(BROWSER_ARGS)
        // No update: a local window draws no update banner (`update_told`).
        .initialization_script(workspace_init_script(
            &state.install_id(),
            update_told(&crate::update::stage(app), true),
        ))
        .initialization_script(init)
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        .visible(false)
        // A page starting over has no unsaved changes yet: it says again what it holds once it mounts, and until then
        // nothing of the page before it may hold a close. And whether a spare's page has loaded, so only one that
        // has is worn: a face evaluated into a page still navigating lands in the document it is leaving (local.rs
        // `take_spare`).
        .on_page_load({
            let app = app.clone();
            move |window, payload| match payload.event() {
                PageLoadEvent::Started => page_started(window.label()),
                PageLoadEvent::Finished => {
                    crate::launch::reached(crate::launch::Stage::Shown);
                    crate::local::page_loaded(&app, window.label())
                }
            }
        })
        .on_navigation({
            let app = app.clone();
            let label = label.to_string();
            move |url| {
                if url.scheme() == "intentic" {
                    let app = app.clone();
                    let label = label.clone();
                    let link = url.to_string();
                    tauri::async_runtime::spawn(async move {
                        crate::handle_intentic_link(&app, &link, Source::Files { window: &label });
                    });
                    return false;
                }
                if stays_in_files_window(url) {
                    return true;
                }
                open_in_browser(&app, url.as_str());
                false
            }
        })
        .on_new_window({
            let app = app.clone();
            move |url, _features| {
                open_in_browser(&app, url.as_str());
                NewWindowResponse::Deny
            }
        });
    let window = builder
        .build()
        .map_err(|error| format!("the window for {title} did not open: {error}"))?;
    crate::webview_sync::watch(&window);
    // The main window carries the app's mark on its taskbar button, which comes back with each showing (badge.rs).
    if how == FilesWindow::Home {
        crate::shown::watch(&window);
    }
    let handle = app.clone();
    let own = label.to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            if let Some(window) = handle.get_webview_window(&own) {
                announce_frame(&window, false);
            }
        }
        // The main window's × is the workspace's: a question, and a hide rather than a close (`request_close`), so
        // nothing it holds unsaved is lost, and the tray brings it back as it was.
        WindowEvent::CloseRequested { api, .. } if own == HOME => {
            api.prevent_close();
            request_close(&handle);
        }
        // Unsaved changes hold the close, whoever asked for it (the platform's ×, the page's own, Alt+F4): the
        // window comes to the front and its page asks what to do with them, answering with a confirmed close — or,
        // for a page that never takes the question, the app asks in its place (`close_turn`).
        WindowEvent::CloseRequested { api, .. } => {
            let turn = UNSAVED.lock().unwrap().close_turn(&own, Instant::now());
            if turn != CloseTurn::Close {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window(&own) {
                    match turn {
                        CloseTurn::AskPage(id) => ask_page(&handle, &window, id),
                        CloseTurn::AskHere => ask_here(&handle, &window),
                        CloseTurn::Wait | CloseTurn::Close => raise(&window),
                    }
                }
            }
        }
        // The folder stops being served the moment nothing shows it (local.rs).
        WindowEvent::Destroyed => {
            forget_chrome(&own);
            forget_unsaved(&own);
            crate::local::window_closed(&handle, &own);
        }
        _ => {}
    });
    if let Some(screen) = screen {
        place_in_work_area(&window, screen, size);
    }
    // A spare's bar is judged from when it is worn, not from when it was built: its page draws nothing until it
    // has a face, and a fallback fired meanwhile would hand it the platform's frame for no reason.
    match how {
        FilesWindow::Shown => {
            arm_frame_fallback(app, label);
            let _ = window.show();
            let _ = window.set_focus();
            crate::webview_sync::shown(&window);
        }
        // In the workspace's frame and place, as the other face of the one window.
        FilesWindow::Home => {
            arm_frame_fallback(app, label);
            let workspace = app.get_webview_window(WORKSPACE);
            take_frame(&window, workspace.as_ref());
            swap_in(&window, workspace, Keyboard::Take);
        }
        FilesWindow::Spare => {}
    }
    Ok(window)
}

/// The spare becoming a window of its own (local.rs): `script` hands its page the face, and the window takes the
/// title, the frame and the place a window built for this grant would have had, and only then comes on screen.
pub fn wear_face(app: &AppHandle, window: &WebviewWindow, title: &str, script: &str) {
    let _ = window.eval(script);
    let _ = window.set_title(title);
    let screen = work_area(app);
    let (size, min) = opening_bounds(screen.map(|screen| screen.size));
    let _ = window.set_min_size(Some(LogicalSize::new(min.0, min.1)));
    let _ = window.set_size(LogicalSize::new(size.0, size.1));
    if let Some(screen) = screen {
        place_in_work_area(window, screen, size);
    }
    arm_frame_fallback(app, window.label());
    let _ = window.show();
    let _ = window.set_focus();
    crate::webview_sync::shown(window);
}

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
struct Unsaved {
    dirty: HashSet<String>,
    confirmed: HashSet<String>,
    held: HashMap<String, Held>,
    asking: HashSet<String>,
    next: u64,
}

/// What one close request of a local window comes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloseTurn {
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
    fn close_turn(&mut self, label: &str, now: Instant) -> CloseTurn {
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

    fn mark_dirty(&mut self, label: &str, dirty: bool) {
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

static UNSAVED: LazyLock<Mutex<Unsaved>> = LazyLock::new(Mutex::default);

/// Set by "Quit anyway": the exit that follows is not asked about again, and nothing counts as unsaved any more,
/// so an update staged for the way out still installs (update.rs `refusal`).
static QUITTING: AtomicBool = AtomicBool::new(false);

/// A Quit question is on screen. A second Quit while it is up is held without asking twice.
static ASKING_QUIT: AtomicBool = AtomicBool::new(false);

/// Set by the runs question's "Quit now", or by its wait ending: the exit that follows leaves what still runs to finish
/// on its own, and is not asked about again.
static RUNS_ANSWERED: AtomicBool = AtomicBool::new(false);

/// The runs question's "Quit when it's done" is being waited out.
static WAITING_TO_QUIT: AtomicBool = AtomicBool::new(false);

/// Only local windows keep the question: the workspace's × hides it and a floating panel's docks, so neither loses
/// anything by closing. The main window's × hides it too, but Quit still ends it, so it keeps the question as well.
fn is_local_window(label: &str) -> bool {
    label == HOME || label.starts_with(crate::local::FILES)
}

fn page_started(label: &str) {
    if is_local_window(label) {
        UNSAVED.lock().unwrap().page_started(label);
    }
}

fn forget_unsaved(label: &str) {
    UNSAVED.lock().unwrap().forget(label);
}

/// Hand the page the question, and give it [`PAGE_SILENCE`] to take it. The eval's own completion is the receipt:
/// it runs only if the page's script does, so a page that has died or hung never sends one, and the app asks in its
/// place ([`ask_here`]).
fn ask_page(app: &AppHandle, window: &WebviewWindow, id: u64) {
    raise(window);
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
        match app.get_webview_window(&label) {
            Some(window) => ask_here(&app, &window),
            None => forget_unsaved(&label),
        }
    });
}

/// The page's question, asked by the app, over the window, for a page that never took it: "Close anyway" closes
/// the window with its edits, "Cancel" keeps it, and the next close hands the question to the page again.
fn ask_here(app: &AppHandle, window: &WebviewWindow) {
    raise(window);
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
        .parent(window)
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

/// The app is about to end with `code` (the tray's Quit, the ×'s "Quit", a restart): with local windows holding
/// unsaved changes, ask first, in a native dialog. `true` means the exit was held for the question, and the caller
/// prevents it; "Quit anyway" ends the app with the same code, and nothing is asked a second time. Then, with work
/// still under way on this computer, that is asked about too ([`hold_quit_for_runs`], 2026-10-05).
///
/// A restart cannot be held (Tauri ignores a prevented restart), which is why an update refuses to start while
/// anything is unsaved or running (update.rs `refusal`) rather than relying on this.
pub fn hold_quit(app: &AppHandle, code: i32) -> bool {
    if code == tauri::RESTART_EXIT_CODE {
        return false;
    }
    let count = unsaved_windows();
    if count == 0 {
        return hold_quit_for_runs(app, code);
    }
    if ASKING_QUIT.swap(true, Ordering::SeqCst) {
        return true;
    }
    let handle = app.clone();
    app.dialog()
        .message(quit_question(count))
        .title("Quit Intentic?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit anyway".into(),
            "Cancel".into(),
        ))
        .show(move |quit| {
            ASKING_QUIT.store(false, Ordering::SeqCst);
            if quit {
                QUITTING.store(true, Ordering::SeqCst);
                handle.exit(code);
            }
        });
    true
}

/* A QUIT WHILE THE APP IS STILL WORKING ON THIS COMPUTER (2026-10-05). Quit asked only about unsaved windows, and ended the
 * app under a recreate, a removal or a bring-back as readily as under nothing: the scripts and the `ic` under them were
 * abandoned mid-flow, a bring-back's machine agent with them. Now a Quit with work under way asks first: wait for it and
 * quit then, quit now, or cancel. A run's child no longer writes to a pipe of this process (scripts.rs `Spool`), so a
 * "Quit now" leaves it to finish on its own with its own words in its files, which its transcript names. This
 * computer's own sandbox's setup is not asked about: a quit stops it and the next launch runs it again by design
 * (machine_sandbox.rs `before_exit`). */

/// What still runs that a Quit should ask about: every script and `ic` run but this computer's own sandbox's setup, and
/// a folder's bring-back, restore or direction change (`project_busy`). Pure.
pub fn quit_waits_for(runs: &[String], project_busy: bool) -> Vec<String> {
    let mut waits: Vec<String> = runs
        .iter()
        .filter(|run| run.as_str() != crate::machine_sandbox::RUN)
        .cloned()
        .collect();
    if project_busy {
        waits.push("project".to_string());
    }
    waits
}

/// What a run is doing, in the question's words. Pure.
pub fn run_said(run: &str) -> String {
    let (kind, slug) = run.split_once(':').unwrap_or((run, ""));
    match kind {
        "setup" => "setting up a sandbox".to_string(),
        "power" => format!("starting or stopping {slug}"),
        "recreate" => format!("updating {slug}"),
        "remove" => format!("removing {slug}"),
        "fix" => "fixing a sandbox".to_string(),
        "sync-setup" | "project-sync" => "setting up folder sync".to_string(),
        "project" => "bringing changes back to a folder".to_string(),
        _ => "a task on this computer".to_string(),
    }
}

/// The question about work still under way, as one sentence. Pure.
pub fn runs_question(waits: &[String]) -> String {
    let mut doing: Vec<String> = waits.iter().map(|run| run_said(run)).collect();
    doing.dedup();
    format!(
        "Intentic is still {} on this computer. If you quit now, it carries on without Intentic, and Intentic won't \
         show you how it ends.",
        doing.join(", ")
    )
}

/// The second half of [`hold_quit`]: work still under way is asked about, and the exit held for the answer. "Quit when
/// it's done" waits for it in the background and then quits with the same code; "Quit now" quits; "Cancel" stays.
fn hold_quit_for_runs(app: &AppHandle, code: i32) -> bool {
    if RUNS_ANSWERED.load(Ordering::SeqCst) {
        return false;
    }
    let waits = quit_waits_for(&crate::scripts::running_ids(), crate::project::busy());
    if waits.is_empty() {
        return false;
    }
    if ASKING_QUIT.swap(true, Ordering::SeqCst) {
        return true;
    }
    const WAIT: &str = "Quit when it's done";
    const NOW: &str = "Quit now";
    let handle = app.clone();
    app.dialog()
        .message(runs_question(&waits))
        .title("Quit Intentic?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            WAIT.into(),
            NOW.into(),
            "Cancel".into(),
        ))
        .show_with_result(move |answer| {
            ASKING_QUIT.store(false, Ordering::SeqCst);
            use tauri_plugin_dialog::MessageDialogResult;
            match answer {
                MessageDialogResult::Yes => wait_then_quit(handle, code),
                MessageDialogResult::Custom(said) if said == WAIT => wait_then_quit(handle, code),
                MessageDialogResult::No => quit_now(&handle, code),
                MessageDialogResult::Custom(said) if said == NOW => quit_now(&handle, code),
                _ => {}
            }
        });
    true
}

fn quit_now(app: &AppHandle, code: i32) {
    RUNS_ANSWERED.store(true, Ordering::SeqCst);
    crate::scripts::note_quit(&[crate::machine_sandbox::RUN]);
    app.exit(code);
}

/// Wait out the work under way, then quit with `code`. Once: a second "Quit when it's done" joins the first.
fn wait_then_quit(app: AppHandle, code: i32) {
    if WAITING_TO_QUIT.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        while !quit_waits_for(&crate::scripts::running_ids(), crate::project::busy()).is_empty() {
            std::thread::sleep(Duration::from_secs(1));
        }
        RUNS_ANSWERED.store(true, Ordering::SeqCst);
        app.exit(code);
    });
}

/// The question, counted the way it is read.
fn quit_question(count: usize) -> String {
    let windows = if count == 1 {
        "1 window has".to_string()
    } else {
        format!("{count} windows have")
    };
    format!("{windows} unsaved changes. If you quit now, those changes are lost.")
}

/// Bring a window back in front of the reader, as the tray or a second double-click on the same file asks.
pub fn raise_window(window: &WebviewWindow) {
    raise(window);
}

/// In front of the reader, whatever it was doing: hidden, minimised, or under the window that asked.
fn raise(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    crate::webview_sync::shown(window);
    crate::shown::tell(window, false);
}

/* THE TITLE BAR THE PAGE DRAWS, AND THE FRAME THAT COMES BACK IF IT DOES NOT. */

/// What the page has said about one frameless window: that its bar is up (`Ready`), and the maximised state
/// last announced to it, so a resize that changes nothing sends nothing. One per window, by label — a floating
/// panel's page announces its own bar, and the workspace's answer must not stand in for it.
#[derive(Default)]
struct Chrome {
    ready: AtomicBool,
    maximized: AtomicBool,
}

static CHROMES: LazyLock<Mutex<HashMap<String, Arc<Chrome>>>> = LazyLock::new(Mutex::default);

fn chrome_of(label: &str) -> Arc<Chrome> {
    CHROMES
        .lock()
        .unwrap()
        .entry(label.to_string())
        .or_default()
        .clone()
}

/// A destroyed window's record goes with it, so the next window under that label starts unannounced and gets
/// its own grace rather than inheriting a bar that was up in a window that no longer exists.
fn forget_chrome(label: &str) {
    CHROMES.lock().unwrap().remove(label);
}

/// The event the page listens on for what the window is doing to itself. A DOM event dispatched by `eval` —
/// the update banner's channel exactly (update.rs `announce_to_workspace`), and one-way for the same reason:
/// nothing is returned and nothing becomes callable.
const FRAME_EVENT: &str = "intentic-desktop-window";

/* The app and the SPA ship separately — a binary somebody installed once, against a page deployed continuously. */
const CHROME_GRACE: Duration = Duration::from_secs(8);

/// What a page that has drawn its bar carries on its root element: WindowControls sets it as it mounts, in the same
/// breath as it sends `ready`.
const BAR_DRAWN: &str = "document.documentElement.hasAttribute('data-frameless')";

/// How long a page gets to answer whether its bar is drawn, before the frame comes back anyway.
const BAR_ANSWER: Duration = Duration::from_secs(2);

/// Hand the platform's frame back if nothing draws a bar in time. Armed once, when the window is built (a spare's,
/// when it is worn); the record it holds is that build's, so a window destroyed and rebuilt within the grace is
/// judged by its own.
///
/// A missing `ready` is not yet a missing bar. `ready` is a link, and a page that sets two links in one task keeps
/// only the last: WebKit schedules each `location.href` and drops the one pending when the next is set, and the bar
/// announces its scheme right behind `ready` (a local window's unsaved-changes guard says its state in the same
/// breath). So the page is asked whether its bar is drawn, and only a page that says no, or says nothing, gets the
/// frame back.
fn arm_frame_fallback(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_string();
    let chrome = chrome_of(&label);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CHROME_GRACE).await;
        if chrome.ready.load(Ordering::Relaxed) || !Arc::ptr_eq(&chrome, &chrome_of(&label)) {
            return;
        }
        let Some(window) = app.get_webview_window(&label) else {
            return;
        };
        if bar_drawn(&window).await {
            chrome_is_up(&window);
            return;
        }
        eprintln!("no title bar from the page in {label}: handing back the platform's frame");
        let _ = window.set_decorations(true);
    });
}

/// Whether the page in `window` has drawn its bar ([`BAR_DRAWN`]), within [`BAR_ANSWER`]; a page that does not
/// answer has not.
async fn bar_drawn(window: &WebviewWindow) -> bool {
    let (tell, heard) = std::sync::mpsc::channel::<String>();
    let asked = window.eval_with_callback(BAR_DRAWN, move |answer| {
        let _ = tell.send(answer);
    });
    if asked.is_err() {
        return false;
    }
    let started = Instant::now();
    loop {
        if let Ok(answer) = heard.try_recv() {
            return says_yes(&answer);
        }
        if started.elapsed() >= BAR_ANSWER {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// An evaluated script's answer, as the webview hands it back (JSON), read as a yes.
fn says_yes(answer: &str) -> bool {
    answer.trim() == "true"
}

/// The page saying its bar is up. `set_decorations(false)` is a no-op in the ordinary case and the whole point
/// in the slow one: a page that arrives after the fallback fired takes the frame off again, so the window ends
/// in the state the page can actually drive either way round.
fn chrome_is_up(window: &WebviewWindow) {
    chrome_of(window.label())
        .ready
        .store(true, Ordering::Relaxed);
    let _ = window.set_decorations(false);
    // Unconditionally, because this is a page that has just loaded: it knows nothing yet about a window that
    // may have been maximised before it got here, or hidden.
    announce_frame(window, true);
    crate::shown::tell(window, true);
}

/// Tell the page whether the window is maximised. `always` is for a page that has just announced itself and
/// has no state at all; every other caller is an event, and sends only what CHANGED.
fn announce_frame(window: &WebviewWindow, always: bool) {
    let maximized = window.is_maximized().unwrap_or(false);
    let changed = chrome_of(window.label())
        .maximized
        .swap(maximized, Ordering::Relaxed)
        != maximized;
    if !always && !changed {
        return;
    }
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent('{FRAME_EVENT}', {{ detail: {{ maximized: {maximized} }} }}));"
    ));
}

/* A PRESS ON THE PAGE'S OWN TITLE BAR — answered on the window it was pressed in. */
fn work_the_window(app: &AppHandle, label: &str, verb: WindowVerb) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    match verb {
        WindowVerb::Ready => chrome_is_up(&window),
        WindowVerb::Minimize => {
            let _ = window.minimize();
        }
        WindowVerb::Maximize => {
            let _ = if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            };
            // The resize event says the same thing a moment later and is deduplicated against this; sending it
            // here is what makes the glyph flip on the press rather than on the platform's next frame.
            announce_frame(&window, false);
        }
        // A face's × is a question and hides (`request_close`), the workspace's and the main window's alike; a
        // floating panel's × is its dock, and the window simply goes. Any other local window's goes through its
        // CloseRequested, where unsaved changes hold it until its page has asked (`close_turn`), which `confirmed`
        // says it has.
        WindowVerb::Close { .. } if label == WORKSPACE || label == HOME => request_close(app),
        WindowVerb::Close { confirmed } => {
            if confirmed && is_local_window(label) {
                UNSAVED.lock().unwrap().confirmed.insert(label.to_string());
            }
            let _ = window.close();
        }
        WindowVerb::Dirty(dirty) => {
            if is_local_window(label) {
                UNSAVED.lock().unwrap().mark_dirty(label, dirty);
            }
        }
        // The platform's own move loop, started while the button is still down — the same call a Tauri drag
        // region makes, reached by a link instead of by a command.
        WindowVerb::Drag => {
            let _ = window.start_dragging();
        }
        // A face comes back the way the tray brings it back, in the other face's place.
        WindowVerb::Raise if label == WORKSPACE => show_workspace(app),
        WindowVerb::Raise if label == HOME => show_home_at(app, None, Keyboard::Take),
        WindowVerb::Raise => raise(&window),
        WindowVerb::Fit(width) => fit_width(&window, f64::from(width)),
        // Answered before this is reached (`handle_link`); it is about the app's faces, not this window.
        WindowVerb::Mode(mode) => apply_mode(app, mode),
    }
}

/// Widen to `width` CSS pixels (logical, which is what the page measures in), keeping the height; never
/// narrows, so a window the reader already made wider is left as they made it.
fn fit_width(window: &WebviewWindow, width: f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(size) = window.inner_size() else {
        return;
    };
    let size = size.to_logical::<f64>(scale);
    if size.width >= width {
        return;
    }
    let _ = window.set_size(LogicalSize::new(width, size.height));
}

/* THE × IS A QUESTION, ASKED BEFORE ANYTHING HAPPENS — and asked in this app's own voice. */
fn request_close(app: &AppHandle) {
    match app.state::<crate::state::AppState>().close_action() {
        Some(action) => apply_close(app, action),
        None => ask_before_closing(app),
    }
}

/// Both answers, once one has been given. Hiding rather than destroying is what makes the tray instant, and
/// `exit` is the tray menu's own Quit reached from the × instead — same exit, so a downloaded update installs
/// on the way out exactly as it would there. Both faces step aside: only one is ever on screen, and the × was its.
fn apply_close(app: &AppHandle, action: CloseAction) {
    match action {
        CloseAction::Tray => {
            for label in [WORKSPACE, HOME] {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.hide();
                    crate::shown::tell(&window, false);
                }
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
    let parent = shown_face(app);
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
            .initialization_script(face_init_script(mode))
            // Nothing here reaches loopback. It carries the arguments so every window in this process agrees
            // on them, because the first one built is the one that configures the environment (BROWSER_ARGS).
            .additional_browser_args(BROWSER_ARGS)
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
            settle_background(&window, mode);
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

/* An install runs for minutes, and the main window is deliberately minimisable and deliberately never topmost. */
pub fn alert_setup(app: &AppHandle) {
    // The keyboard only when the workspace is the window being read; a run that takes minutes must not pull the user
    // out of whatever they moved on to. Wrong here costs a focus, never a second window.
    let reading_workspace = app
        .get_webview_window(WORKSPACE)
        .is_some_and(|workspace| workspace.is_visible().unwrap_or(false));
    let keyboard = if reading_workspace {
        Keyboard::Take
    } else {
        Keyboard::Leave
    };
    // The swap the setup arrived through, run again rather than a bare `show`: a run settling while the workspace
    // holds the frame has to end with one face up, and only the swap takes the other off screen.
    show_home_at(app, Some(DEVICE_ROUTE), keyboard);
    if let Some(window) = app.get_webview_window(HOME) {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
}

/* "Back to your workspace" hands the frame back to the SPA's setup page, and that page used to know nothing from then on: it sat on "Handed to the app. */
pub fn announce_setup(app: &AppHandle, report: &SetupReport) {
    let Some(window) = app.get_webview_window(WORKSPACE) else {
        return;
    };
    let _ = window.eval(setup_announcement(report));
}

/// The event as the page receives it. JSON is a JavaScript object literal since ES2019 (the two line
/// separators included), and serde escapes the quotes, so a sandbox named `"</script>` arrives as a name.
fn setup_announcement(report: &SetupReport) -> String {
    let detail = serde_json::to_string(report).unwrap_or_else(|_| "null".to_string());
    format!(
        "window.dispatchEvent(new CustomEvent('intentic-desktop-setup', {{ detail: {detail} }}));"
    )
}

/// Links land here from three directions: the workspace webview's intercepted navigation, the second-instance
/// argv, and the OS handler. A setup parks its request for This device to pick up and run, in the main window, in
/// the frame the workspace was just occupying; an auth handoff goes straight back into the workspace face, which is
/// the only place it means anything.
///
/// `source` separates the first direction from the other two: only the webview's own navigation is a link
/// this app watched its own window ask for. See [`Source`] for what an external one loses, and
/// [`confirm_setup`] for what it has to answer first.
pub fn handle_link(app: &AppHandle, link: &str, source: Source) {
    match parse_link(link, source) {
        Some(Link::Setup(args)) => match source {
            // A project's setup gets the folder this app parked for it, and only here (project.rs).
            Source::App { .. } => park_setup(app, crate::project::bind(app, *args)),
            Source::External => confirm_setup(app, *args),
            // Never parsed from a local window (setup_link.rs); named so a new source is a decision here too.
            Source::Files { .. } => {}
        },
        Some(Link::Recreate(args)) => {
            *app.state::<crate::state::AppState>()
                .pending_recreate
                .lock()
                .unwrap() = Some(args);
            show_device(app);
            let _ = tauri::Emitter::emit(app, "desktop://pending-recreate", ());
        }
        // The recovery panel's button: `ic sandbox fix`, run and drawn on This device (fix.rs). A link while one
        // runs brings that run forward instead of starting a second.
        Some(Link::Fix(args)) => crate::fix::requested(app, args),
        // A folder of this computer becoming a project of a hosted sandbox: bound to the folder this app parked
        // for it and run here, with no screen of the app's in between (project.rs `sync_project`).
        Some(Link::Sync(args)) if args.project.is_some() => {
            crate::project::sync_project(app, args);
        }
        // The Desktop sync card's enrollment, handed over so the folder can be picked in a system dialog
        // rather than typed into a one-liner. App-source only by construction (setup_link.rs), so unlike a
        // setup there is nothing to confirm here: the SPA's own button said what it does, and the picker
        // and its confirmation are still ahead (This device, src/device/useDevice.ts).
        Some(Link::Sync(args)) => {
            *app.state::<crate::state::AppState>()
                .pending_sync
                .lock()
                .unwrap() = Some(args);
            show_device(app);
            let _ = tauri::Emitter::emit(app, "desktop://pending-sync", ());
        }
        Some(Link::SignIn { switch_account }) => {
            if let Err(error) = crate::auth::start(app, switch_account) {
                eprintln!("{error}");
            }
        }
        Some(Link::Auth(args)) => crate::auth::complete(app, &args),
        // The banner's button. Nothing is parked and no face is swapped: the bytes are already on this machine
        // (update.rs), so this either installs and comes back, or opens the download page for a copy that
        // cannot install anything.
        Some(Link::Update) => crate::update::act(app),
        // The workspace's way back to this computer: This device (a setup page's way back to the run it handed over,
        // a sandbox's "restart in the app"), or the folder itself (the sandbox switcher's "This computer").
        Some(Link::Launcher { files: true }) => {
            app.state::<AppState>().remember_last_face(Face::Home);
            show_home_at(app, Some(FILES_ROUTE), Keyboard::Take);
        }
        Some(Link::Launcher { files: false }) => show_device(app),
        // The workspace's account and sandboxes, for the local windows to show (state.rs `remember_roster`). Nothing
        // is shown now: the page sends it whenever either changes, not because the reader asked for anything.
        Some(Link::Roster(roster)) => {
            // A sandbox the account lists no more: its folders' records and this machine's sync of it go (project.rs).
            let before = app.state::<AppState>().roster();
            crate::project::roster_changed(app, before, roster.clone());
            app.state::<AppState>().remember_roster(roster);
            // Who is signed in is what this computer's sandbox is made for (machine_sandbox.rs).
            crate::machine_sandbox::account_changed();
        }
        // The workspace tab's mark, for the app's icon (badge.rs); its notifications, for the system's (notice.rs).
        Some(Link::Badge(args)) => crate::badge::show(app, args),
        Some(Link::Notice(NoticeVerb::Show(args))) => crate::notice::show(app, args),
        Some(Link::Notice(NoticeVerb::Withdraw(key))) => crate::notice::withdraw(app, &key),
        Some(Link::Notice(NoticeVerb::Clear)) => crate::notice::clear(app),
        Some(Link::Notice(NoticeVerb::Open(token))) => crate::notice::open(app, &token),
        Some(Link::Notice(NoticeVerb::Status)) => {
            if let Some(window) = source.window() {
                crate::notice::status(app, window);
            }
        }
        // The page saying what light it is drawn in; about this app's faces, not the workspace window.
        Some(Link::Window(WindowVerb::Mode(mode))) => apply_mode(app, mode),
        // The page's own title bar, working the window it is drawn in (`work_the_window`). Nothing is parked
        // and no face is swapped: these are presses on one window, answered on that window — and only a window
        // of the app's own sends them (`parse_link`).
        Some(Link::Window(verb)) => {
            let Some(window) = source.window() else {
                return;
            };
            work_the_window(app, window, verb);
        }
        // A local window asking for a dialog or the file manager, about its own folder (local.rs).
        Some(Link::Local(verb)) => {
            if let Source::Files { window } = source {
                crate::local::act(app, window, verb);
            }
        }
        None => {}
    }
}

/// Hand a setup to This device, which runs it on arrival (src/device/useDevice.ts says why), in the main window, in
/// the frame the workspace that asked for it was occupying: the same handover every other screen of this app makes.
fn park_setup(app: &AppHandle, args: SetupArgs) {
    *app.state::<crate::state::AppState>()
        .pending
        .lock()
        .unwrap() = Some(args);
    show_device(app);
    let _ = tauri::Emitter::emit(app, "desktop://pending-setup", ());
}

/* A SETUP THIS APP NEVER SAW ITS OWN WINDOW ASK FOR — so ask, before anything runs. */
fn confirm_setup(app: &AppHandle, args: SetupArgs) {
    let sync = match args.sync_dir.as_deref() {
        Some(dir) => {
            format!("\n\nIt will also keep {dir} on this device in sync with that sandbox.")
        }
        None => String::new(),
    };
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "Something asked Intentic to set up a sandbox on this device.\n\n\
             That starts a container here and publishes it on the internet, where it is reachable by whoever \
             the setup link came from.{sync}\n\n\
             Intentic sets itself up from its own window, so nothing you did in the app asked for this. \
             If you were not expecting it, cancel.",
        ))
        .title("Set up a sandbox on this device?")
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

/* THE PAIR THAT HAS TO STAY A PAIR: the flag that stops the webview gating loopback, and the claim the page believes about it. */
#[cfg(test)]
mod loopback_tests {
    use super::*;

    /// Setting our own arguments replaces wry's default rather than adding to it, and Chromium reads only the
    /// last `--disable-features` — so one list, holding wry's three as well as ours.
    #[test]
    fn the_browser_arguments_keep_wrys_own_defaults() {
        assert_eq!(BROWSER_ARGS.matches("--disable-features=").count(), 1);
        for feature in ["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"] {
            assert!(BROWSER_ARGS.contains(feature), "dropped {feature}");
        }
    }

    /// Every transport the SPA takes to the daemon on this machine: fetch for the probe and the calls,
    /// WebSockets for terminals and the browser view.
    #[test]
    fn the_browser_arguments_disable_every_local_network_check_we_meet() {
        for feature in [
            "LocalNetworkAccessChecks",
            "LocalNetworkAccessChecksWebSockets",
            "LocalNetworkAccessChecksWebTransport",
        ] {
            assert!(BROWSER_ARGS.contains(feature), "still gated: {feature}");
        }
    }

    /// And the page is told, because it skips its own card on the strength of this word alone
    /// (loopbackPermission.ts). A build that disables the check without saying so costs the user a dialog with
    /// nothing on screen to explain it; one that says so without disabling it costs them the same dialog.
    #[test]
    fn the_page_is_told_the_reach_is_ungated() {
        let script = workspace_init_script("install-1", None);
        assert!(script.contains("loopbackUngated: true"), "{script}");
    }

    /* THE OTHER PAIR THAT HAS TO STAY A PAIR: this window opens with no platform frame, and the page is told so. */
    #[test]
    fn the_page_is_told_the_window_has_no_frame_of_its_own() {
        let script = workspace_init_script("install-1", None);
        assert!(script.contains("frameless: true"), "{script}");
    }

    /// The web hands a folder to a hosted machine only on this word (setup's `desktopTakesProjects`): a build
    /// that parses `project=` on a sync link says so, and one that doesn't never reaches that lane.
    #[test]
    fn the_page_is_told_this_build_copies_a_folder_into_its_project() {
        let script = workspace_init_script("install-1", None);
        assert!(script.contains("projectSync: true"), "{script}");
    }

    /// The page offers the app's notifications in its settings, and sends them, only on this word (desktop.ts
    /// `desktopNotices`): a build that hears `notice` and `badge` says so.
    #[test]
    fn the_page_is_told_this_build_puts_up_notifications() {
        let script = workspace_init_script("install-1", None);
        assert!(script.contains("notices: true"), "{script}");
    }
}

#[cfg(test)]
mod unsaved_tests {
    use super::*;

    /// The Quit question counts the windows the way it is read, and says what quitting costs.
    #[test]
    fn the_quit_question_counts_the_windows_holding_changes() {
        assert_eq!(
            quit_question(1),
            "1 window has unsaved changes. If you quit now, those changes are lost."
        );
        assert_eq!(
            quit_question(3),
            "3 windows have unsaved changes. If you quit now, those changes are lost."
        );
    }

    /// A Quit asks about every run under way but this computer's own sandbox's setup, which a quit stops and the next
    /// launch runs again by design, and about a folder's bring-back; and says what each is doing.
    #[test]
    fn a_quit_asks_about_the_work_still_under_way_and_names_it() {
        let runs = vec![
            crate::machine_sandbox::RUN.to_string(),
            "recreate:work".to_string(),
            "remove:old".to_string(),
        ];
        assert_eq!(
            quit_waits_for(&runs, false),
            vec!["recreate:work".to_string(), "remove:old".to_string()]
        );
        assert!(quit_waits_for(&[crate::machine_sandbox::RUN.to_string()], false).is_empty());
        assert_eq!(quit_waits_for(&[], true), vec!["project".to_string()]);
        assert_eq!(
            runs_question(&quit_waits_for(&runs, true)),
            "Intentic is still updating work, removing old, bringing changes back to a folder on this computer. If \
             you quit now, it carries on without Intentic, and Intentic won't show you how it ends."
        );
        assert_eq!(run_said("power:work"), "starting or stopping work");
        assert_eq!(run_said("setup"), "setting up a sandbox");
        assert_eq!(run_said("anything-new"), "a task on this computer");
    }

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

    /// A local window draws no update banner: the choice `show_files_window` makes names no downloaded version,
    /// where the workspace's names the one that is ready.
    #[test]
    fn a_local_window_is_told_of_no_update() {
        let ready = crate::update::Stage::Ready {
            version: "9.9.9".into(),
        };
        assert_eq!(update_told(&ready, true), None);
        assert_eq!(update_told(&ready, false), Some("9.9.9"));
        assert!(
            workspace_init_script("install-1", update_told(&ready, true)).contains("update: null")
        );
        assert!(
            workspace_init_script("install-1", update_told(&ready, false))
                .contains("update: \"9.9.9\"")
        );
        assert_eq!(update_told(&crate::update::Stage::Current, false), None);
    }

    /// The page's answer to whether its bar is drawn, as a webview hands an evaluated boolean back.
    #[test]
    fn a_page_says_its_bar_is_drawn_with_a_plain_true() {
        assert!(says_yes("true"));
        assert!(says_yes(" true\n"));
        assert!(!says_yes("false"));
        assert!(!says_yes("null"));
        assert!(!says_yes(""));
        assert_eq!(
            BAR_DRAWN,
            "document.documentElement.hasAttribute('data-frameless')"
        );
    }
}

#[cfg(test)]
mod mode_tests {
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
mod floating_tests {
    use super::*;

    fn origin(url: &str) -> Url {
        url.parse().unwrap()
    }

    /* THE ONE `window.open` THAT GETS A WINDOW OF THIS APP'S: the page floating a panel of its own. */
    #[test]
    fn a_panel_of_the_page_floats_into_a_window_of_this_app() {
        let app = origin("https://app.intentic.dev");
        assert_eq!(
            floating_panel(&origin("https://app.intentic.dev/floating/chat"), &app).as_deref(),
            Some("chat")
        );
        assert_eq!(
            floating_panel(
                &origin("http://localhost:47146/floating/terminal"),
                &origin("http://localhost:47146")
            )
            .as_deref(),
            Some("terminal")
        );
        // Served under a path, the panel is under that path too.
        assert_eq!(
            floating_panel(
                &origin("https://example.dev/app/floating/browsers"),
                &origin("https://example.dev/app/")
            )
            .as_deref(),
            Some("browsers")
        );
    }

    #[test]
    fn every_other_new_window_is_the_browsers() {
        let app = origin("https://app.intentic.dev");
        for url in [
            // A page of the app opened "in a new tab" is still a tab, not a panel.
            "https://app.intentic.dev/agents",
            "https://app.intentic.dev/floating/",
            "https://app.intentic.dev/floating/chat/extra",
            "https://app.intentic.dev/floating/Chat",
            "https://app.intentic.dev/floating/chat-2",
            // The same path on somebody else's origin is somebody else's page.
            "https://evil.example/floating/chat",
            "http://app.intentic.dev/floating/chat",
            "https://app.intentic.dev/app/floating/chat",
        ] {
            assert_eq!(floating_panel(&origin(url), &app), None, "{url}");
        }
    }

    #[test]
    fn a_floating_window_is_labelled_and_titled_after_its_panel() {
        assert_eq!(floating_label("chat"), "floating-chat");
        assert_eq!(floating_title("chat"), "Intentic · Chat");
        assert_eq!(floating_title("browsers"), "Intentic · Browsers");
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
        (at.1 + size.1, work.origin.1 + work.size.1)
    }

    /// THE BUG THIS SHIPPED WITH, in the numbers that caused it: a 1080p panel at the 150% scale most laptops
    /// are sold with leaves 1080 physical rows, which is 720 logical — and the preference is 900. The first
    /// window a new user ever saw opened a third taller than the display and hung off the bottom of it.
    #[test]
    fn a_scaled_laptop_panel_does_not_get_a_window_taller_than_itself() {
        // 1920×1080 at 150%, less a 48px taskbar: what the platform reports as the work area, logical.
        let available = (1280.0, 688.0);
        let (size, min) = opening_bounds(Some(available));

        // At most the screen, which for an undecorated window is exactly the screen: there is no title bar
        // left to reserve rows for, so a fit that fills the work area IS the window fitting on it.
        assert!(size.1 <= available.1, "opened {size:?} into {available:?}");
        assert!(size.0 <= available.0, "opened {size:?} into {available:?}");
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

        assert!(size.0 <= 800.0 && size.1 <= 500.0, "opened {size:?}");
        assert_eq!(min, size);
    }

    /// Never zero or negative, whatever a desktop reports — a monitor unplugged mid-session can answer with an
    /// area of a few pixels, and a window asked for 0×0 is one nobody can grab.
    #[test]
    fn an_absurd_screen_still_asks_for_a_window() {
        let (size, _) = opening_bounds(Some((4.0, 4.0)));

        assert!(size.0 >= 1.0 && size.1 >= 1.0, "opened {size:?}");
    }

    /// A face is as tall as its content, and no taller than the screen it is on leaves it a margin: the
    /// requirements list of a PC that needs everything is taller than a laptop's work area, and the card
    /// scrolls inside from there rather than growing under the taskbar.
    #[test]
    fn a_face_is_fitted_to_its_content_within_the_screen() {
        assert_eq!(fitted_height(500.0, Some(883.0)), 500.0);
        assert_eq!(
            fitted_height(1400.0, Some(883.0)),
            883.0 - 2.0 * CONTENT_MARGIN
        );
        // A page that measured nothing yet is still a card, never a strip.
        assert_eq!(fitted_height(0.0, Some(883.0)), CONTENT_MIN_HEIGHT);
        // No screen to ask is no reason to clamp.
        assert_eq!(fitted_height(1400.0, None), 1400.0);
        // A screen smaller than the margins still asks for a window somebody can see.
        assert!(fitted_height(300.0, Some(20.0)) >= 1.0);
    }

    /// A fitted window is never a fraction of a pixel SHORTER than the page it was measured from: that
    /// fraction is the scrollbar the install card grew down its right edge whenever its height changed.
    #[test]
    fn a_fitted_window_is_never_rounded_below_the_content_it_was_measured_from() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
            for content in [120.0, 427.0, 451.0, 632.5] {
                let size = LogicalSize::new(CONFIRM_WIDTH, content);
                let pixels = whole_pixels(size, scale);
                assert!(
                    f64::from(pixels.height) >= content * scale,
                    "{content} at {scale}x fitted to {} physical pixels",
                    pixels.height
                );
                assert!(f64::from(pixels.width) >= CONFIRM_WIDTH * scale);
            }
        }
        // A monitor that reports nothing usable is no scale at all, not a window of zero height.
        assert_eq!(
            whole_pixels(LogicalSize::new(620.0, 440.0), 0.0),
            PhysicalSize::new(620, 440)
        );
    }

    /// A card grows downward under a heading that stays put — until its bottom edge would leave the work
    /// area, and then it moves up by exactly the overhang, never above the top margin.
    #[test]
    fn a_growing_card_keeps_its_heading_still_and_its_bottom_on_screen() {
        let work = screen((1531.0, 883.0));
        assert_eq!(kept_on_screen(200.0, 400.0, work), 200.0);
        // 200 + 700 = 900 > 883 - 24: pushed up to end exactly at the margin.
        assert_eq!(
            kept_on_screen(200.0, 700.0, work),
            883.0 - CONTENT_MARGIN - 700.0
        );
        // Taller than the screen leaves it: the top margin wins, and the fit above is what keeps this rare.
        assert_eq!(kept_on_screen(200.0, 2000.0, work), CONTENT_MARGIN);
        // On a second monitor the area's own origin is where "the top" is.
        let second = WorkArea {
            origin: (1920.0, 0.0),
            size: (1400.0, 1080.0),
            scale: 1.0,
        };
        assert_eq!(
            kept_on_screen(1000.0, 200.0, second),
            1080.0 - CONTENT_MARGIN - 200.0
        );
    }

    /// What the workspace page receives: the event it listens for, carrying the report as one object. The
    /// name is the one value a user typed, and it arrives as a string however it was spelled.
    #[test]
    fn the_setup_announcement_is_one_event_carrying_the_report() {
        let script = setup_announcement(&SetupReport {
            name: Some("my \"site\" </script>".into()),
            state: "running".into(),
            percent: 42.5,
            position: Some("Step 4 of 10".into()),
            remaining: Some("about 3 min left".into()),
            step: Some("pulling-image".into()),
            waiting_for: None,
            requirements: None,
        });
        assert!(script.starts_with("window.dispatchEvent(new CustomEvent('intentic-desktop-setup'"));
        assert!(script.contains("\"percent\":42.5"), "{script}");
        assert!(script.contains("\"state\":\"running\""), "{script}");
        // The quotes inside the name are escaped, so the script is still one statement.
        assert!(script.contains("my \\\"site\\\" </script>"), "{script}");
    }

    /// A setup stopped on a question says which one, so the page can word a restart as a restart; a running one
    /// carries neither field rather than two nulls.
    #[test]
    fn a_waiting_setup_says_what_it_waits_for() {
        let waiting = setup_announcement(&SetupReport {
            name: None,
            state: "waiting".into(),
            percent: 10.0,
            position: None,
            remaining: None,
            step: None,
            waiting_for: Some("restart".into()),
            requirements: Some(vec!["pending-restart".into()]),
        });
        assert!(waiting.contains("\"waitingFor\":\"restart\""), "{waiting}");
        assert!(
            waiting.contains("\"requirements\":[\"pending-restart\"]"),
            "{waiting}"
        );
        let running = setup_announcement(&SetupReport {
            name: None,
            state: "running".into(),
            percent: 10.0,
            position: None,
            remaining: None,
            step: None,
            waiting_for: None,
            requirements: None,
        });
        assert!(!running.contains("waitingFor"), "{running}");
    }

    /// A loaded workspace is told the path through its own opener, and falls back to loading the address; the path
    /// arrives as one string however it is spelled.
    #[test]
    fn a_loaded_workspace_is_told_the_path_and_loads_it_only_without_an_opener() {
        let script = open_in_place(
            "https://app.intentic.dev",
            "/?sandbox=a\"b');x",
            "https://app.intentic.dev/?sandbox=a\"b');x",
        );
        assert_eq!(
            script,
            "(() => { const open = window.__INTENTIC_OPEN__; if (location.origin === \"https://app.intentic.dev\" && typeof open === 'function') { open(\"/?sandbox=a\\\"b');x\"); } else { location.href = \"https://app.intentic.dev/?sandbox=a\\\"b');x\"; } })();"
        );
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

    /* THE BUG AS REPORTED, which the fit alone did not cover: the window opened with its bottom edge — and the chat composer in it — under the taskbar. */
    #[test]
    fn a_cold_start_window_opens_fully_inside_the_work_area() {
        let work = screen((1531.0, 883.0));
        let (window, available) = bottom_edge(work);

        assert!(
            window <= available,
            "window ends at {window}, screen at {available}"
        );
        // And it is not merely on screen by being tiny: the fit gives it every row the screen has to spare,
        // which is now all of them — the 48 that used to go to a title bar are the window's.
        let (size, _) = opening_bounds(Some(work.size));
        assert_eq!(size.1, work.size.1);
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
        let below = (work.origin.1 + work.size.1) - (at.1 + size.1);
        assert!(
            (above - below).abs() < 0.001,
            "above {above}, below {below}"
        );
        let left = at.0 - work.origin.0;
        let right = (work.origin.0 + work.size.0) - (at.0 + size.0);
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
        assert!(at.0 + size.0 <= work.origin.0 + work.size.0);
        assert!(at.1 + size.1 <= work.origin.1 + work.size.1);
    }

    /// A window that cannot fit starts AT the corner rather than at a negative offset — the piece of it left on
    /// screen is then the top-left, which is the piece carrying the bar to drag it by.
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
