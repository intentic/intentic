use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::setup_link::{parse_link, Link, SetupArgs, Source};
use crate::state::CloseAction;

/* ONE WINDOW ON SCREEN, EVER — these two labels are two FACES of it, not two windows.
 *
 * There have to be two webviews. The workspace face is remote content (the hosted SPA) and gets no IPC at all;
 * the launcher face is local content holding this app's entire command surface. Tauri scopes capabilities by
 * window LABEL, so merging them into one label would hand app.intentic.dev the launcher's permissions — the one
 * thing this app's design exists to refuse.
 *
 * What the user is owed is not one webview but one WINDOW, and that is what `swap_in` enforces: whichever face
 * is being shown first takes the other's frame — same position, same size — and the other steps aside. Only
 * the title changes, because it is the label on a taskbar entry and ought to say which screen is up. So the
 * sandbox manager reads as the window moving on rather than as a second app arriving on top of the first.
 * Before this, a first-time install ended with an unasked-for window called "Sandbox Manager" in front of the
 * one the user was reading, which is where they stopped.
 *
 * THE ONE EXCEPTION IS THE SETUP WINDOW, and it is the rule rather than a hole in it. An install is not
 * somewhere the user went, it is something happening to the app they are in, so the launcher comes up IN FRONT
 * of the workspace instead of replacing it — but as an ordinary small window over it, not as a sheet across
 * the screen (`set_setup_frame`). Two mapped windows, one thing being asked of the user. */
pub const WORKSPACE: &str = "workspace";
pub const LAUNCHER: &str = "launcher";

/// The third label, and NOT a third face: a dialog the app draws about the window it is standing in front of.
/// It keeps to the one-window rule the way a dialog does — off the taskbar, owned by the frame it is about,
/// and gone the moment it is answered.
pub const CONFIRM_CLOSE: &str = "confirm-close";

/// The frame both faces share when neither has one to inherit — a cold start, on either face.
const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);
const MIN_SIZE: (f64, f64) = (900.0, 600.0);

/* THE SETUP WINDOW'S OWN FRAME — a dialog, sized to the card in it rather than to the screen.
 *
 * This used to be the workspace's whole rectangle, undecorated and topmost, with the card floating in a dim
 * that filled it. On the path that matters most — a first install, started from a link in the browser, with no
 * workspace window open yet — there was nothing to take a rectangle from, so it opened at DEFAULT_SIZE
 * instead: 1440×900 logical, which on a 150% display is 2160×1350 physical and covers a laptop screen whole.
 * Undecorated meant no title bar to drag it by and no button to minimise it, and topmost put it over every
 * other application, so an install that legitimately takes minutes took the machine with it.
 *
 * So the setup face is a window a person can deal with: its own small frame, decorations on, movable,
 * minimisable, resizable, and never topmost. It still comes up centred on the workspace when there is one, so
 * it still reads as something happening to the app you are in rather than a second app arriving.
 *
 * Measured against what App.vue draws in it — the card at its `max-w-xl`, plus the ten-step progress list and
 * the requirements list a stopped Windows install adds under it. The minimum is small enough to leave the
 * window useful when it is shrunk, since the card scrolls inside it. */
const SETUP_SIZE: (f64, f64) = (620.0, 640.0);
const SETUP_MIN: (f64, f64) = (420.0, 380.0);

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
        if frame_is_inheritable(&other) {
            if let Ok(position) = other.outer_position() {
                let _ = window.set_position(position);
            }
            if let Ok(size) = other.inner_size() {
                let _ = window.set_size(size);
            }
        }
        let _ = window.show();
        let _ = window.set_focus();
        let _ = other.hide();
        return;
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Whether `window`'s frame is one to hand on. The SETUP frame is not: it is a dialog sized to its card, and a
/// workspace that inherited it would come back from an install shrunk to the size of the installer that ran.
/// It still steps aside — it just leaves nothing behind.
fn frame_is_inheritable(window: &WebviewWindow) -> bool {
    window.label() != LAUNCHER
        || !window
            .app_handle()
            .state::<crate::state::AppState>()
            .in_setup_frame()
}

/// Marks the page as running inside the desktop app. DETECTION ONLY — the handoff is the `intentic://`
/// navigation this window intercepts, so no IPC is ever exposed to remote content.
///
/// The install id rides along so the SPA's analytics can say which app an event came from, and join it to what
/// the launcher reported about the same install (state.rs). It is a random per-install id and grants nothing:
/// remote content that reads it learns only that it is inside an app, which the version already told it.
fn workspace_init_script(install_id: &str) -> String {
    format!(
        "(function () {{ if (!window.__INTENTIC_DESKTOP__) {{ window.__INTENTIC_DESKTOP__ = Object.freeze({{ version: \"{}\", installId: \"{install_id}\" }}); }} }})();",
        env!("CARGO_PKG_VERSION")
    )
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
    let builder = WebviewWindowBuilder::new(app, WORKSPACE, WebviewUrl::External(url))
        .title("Intentic")
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        // Built hidden so `swap_in` can place it on the frame it is taking over before it is ever on screen —
        // a finished setup hands the window back, and the workspace must appear where the setup was standing.
        .visible(false)
        .initialization_script(workspace_init_script(&install_id))
        .on_navigation(move |url| {
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
            true
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

/// The app's own face, built once and shown by whichever of its two screens is asking (`show_launcher` for
/// the manager, `set_setup_frame` for the setup window). Never shown from here: the two want the window in
/// two different places and at two different sizes, and one that appears before it has been put somewhere
/// flashes in the old one.
fn launcher(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(LAUNCHER) {
        return Some(window);
    }
    let result = WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("index.html".into()))
        .title("Intentic")
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        /* The frame between "window mapped" and "webview painted", which is white by default and reads as a
         * flash on a dark screen. Mirrors `--color-canvas` in dark mode (@intentic/ui semantic-colors.css),
         * which index.html pins — the same colour the confirmation dialog paints for the same reason.
         *
         * This window used to be built `transparent` instead, for a setup face that was a dim across the
         * workspace. Nothing is drawn through it now: both faces paint an opaque surface, and the setup one is
         * a window of its own rather than a sheet over another. */
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
            Some(window)
        }
        Err(error) => {
            eprintln!("launcher window failed to open: {error}");
            None
        }
    }
}

/// The MANAGER screen — the sandboxes on this machine. An ordinary window, in the workspace's place.
pub fn show_launcher(app: &AppHandle) {
    if let Some(window) = launcher(app) {
        set_setup_frame(app, false);
        swap_in(&window, app.get_webview_window(WORKSPACE));
    }
}

/* THE SETUP SCREEN IS A WINDOW IN FRONT, NOT A SHEET ACROSS THE SCREEN.
 *
 * It used to arrive the way the manager does: the launcher took the workspace's frame and the workspace
 * stepped aside. That is right for a manager, which is somewhere you GO, and wrong for an install, which is
 * something that HAPPENS to the app you are already in — it read as a second application that had opened
 * itself on top of the first.
 *
 * The first correction went too far the other way. The setup face became an undecorated, topmost window on
 * the workspace's exact rectangle, with App.vue drawing a dim across it, and on the path that matters most it
 * was unusable: a first install starts from a link in the BROWSER, so there is no workspace window to take a
 * rectangle from, and the window opened at its default 1440×900 — the better part of a laptop screen at any
 * display scale above 100%, over every other application, with no title bar to move it by and no way to
 * minimise it. An install takes minutes; that took the machine for all of them.
 *
 * So this is a window a person can deal with: its own dialog-sized frame (`SETUP_SIZE`), decorations on,
 * movable, minimisable, resizable, never topmost — centred on the workspace when one is up, which is what
 * keeps it reading as something happening to the app you are in. It has a taskbar entry, because a window
 * that can be minimised has to have somewhere to be minimised TO.
 *
 * Driven from App.vue rather than fixed at open, because which face is up is that screen's own state: a
 * setup can arrive at a manager window, and a finished one hands the window back.
 */
pub fn set_setup_frame(app: &AppHandle, setup: bool) {
    let Some(window) = app.get_webview_window(LAUNCHER) else {
        return;
    };
    let state = app.state::<crate::state::AppState>();
    let was_setup = state.in_setup_frame();
    // Before the frame moves, so anything reading it while this runs already sees which one it is wearing.
    state.mark_setup_frame(setup);
    if !setup {
        let _ = window.set_min_size(Some(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1)));
        /* And a full window's SIZE back, when this is a setup frame being taken off. `show_launcher` swaps in
         * the workspace's frame straight after and would make this redundant — but only when there is a
         * workspace on screen to take one from, and the tray's Manager item reaches here with no promise of
         * that. Without it the manager face draws in a 620-wide window, under its own 900 minimum. */
        if was_setup {
            let _ = window.set_size(LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1));
        }
        return;
    }
    // The minimum comes down FIRST: it is the floor the size below has to clear, and the manager's floor is
    // wider than this whole window.
    let _ = window.set_min_size(Some(LogicalSize::new(SETUP_MIN.0, SETUP_MIN.1)));
    let size = LogicalSize::new(SETUP_SIZE.0, SETUP_SIZE.1);
    let _ = window.set_size(size);
    /* Centred on the workspace, or on the screen when there is none — computed from the size just ASKED for
     * rather than read back off the window. GTK resizes on its own clock, so a read-back here answers with
     * the frame this window had a moment ago, and the setup that opened cold would be placed as if it were
     * still 1440 wide. The title bar's height is not accounted for and does not need to be: it is a handful
     * of pixels on a placement whose only job is "in the middle of what it is about". */
    let behind = app
        .get_webview_window(WORKSPACE)
        .filter(|behind| behind.is_visible().unwrap_or(false));
    center_over(&window, behind.as_ref(), size);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Bring the setup window up in front of the workspace. The parked request is already in state; this is the
/// frame.
pub fn show_setup(app: &AppHandle) {
    if launcher(app).is_some() {
        set_setup_frame(app, true);
    }
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
        Some(Link::SignIn) => {
            if let Err(error) = crate::auth::start(app) {
                eprintln!("{error}");
            }
        }
        Some(Link::Auth(args)) => crate::auth::complete(app, &args),
        None => {}
    }
}

/// Hand a setup to the launcher face, which runs it on arrival (App.vue says why) — as an overlay over the
/// workspace that asked for it, rather than in its place.
fn park_setup(app: &AppHandle, args: SetupArgs) {
    *app.state::<crate::state::AppState>()
        .pending
        .lock()
        .unwrap() = Some(args);
    show_setup(app);
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
mod frame_tests {
    use super::*;
    use tauri::PhysicalPosition;

    /// The setup window opens in the MIDDLE of the workspace, not on its corner — which is what says it is
    /// about that window. Asserted on the arithmetic because the windows themselves exist only in a running
    /// desktop session; the smoke tiers assert the same property against real ones.
    #[test]
    fn the_setup_window_lands_in_the_middle_of_the_workspace() {
        let workspace = PhysicalSize::new(1440u32, 900u32);
        let setup = PhysicalSize::new(620u32, 640u32);
        let at = centered(PhysicalPosition::new(100, 50), workspace, setup);
        assert_eq!(at, PhysicalPosition::new(100 + 410, 50 + 130));
        // Concentric: the gap left on one side is the gap left on the other.
        assert_eq!(
            at.x - 100,
            (workspace.width as i32 - setup.width as i32) - (at.x - 100)
        );
    }

    /// A window CENTRED on a smaller one hangs off it on both sides — the two stay concentric, where clamping
    /// the offset to zero would shove it into a corner. The workspace can be dragged smaller than the setup
    /// window's minimum, so this is a state a user can reach, not a hypothetical.
    #[test]
    fn a_window_larger_than_the_one_it_is_about_stays_concentric() {
        let at = centered(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(400, 300),
            PhysicalSize::new(620, 640),
        );
        assert_eq!(at, PhysicalPosition::new(-110, -170));
    }
}
