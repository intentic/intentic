use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
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
 * the title changes, because it is the label on a taskbar entry and ought to say which screen is up. So "Set
 * up on this computer" reads as the window moving on rather than as a second app arriving on top of the first.
 * Before this, a first-time install ended with an unasked-for window called "Sandbox Manager" in front of the
 * one the user was reading, which is where they stopped. */
pub const WORKSPACE: &str = "workspace";
pub const LAUNCHER: &str = "launcher";

/// The third label, and NOT a third face: a dialog the app draws about the window it is standing in front of.
/// It keeps to the one-window rule the way a dialog does — off the taskbar, owned by the frame it is about,
/// and gone the moment it is answered.
pub const CONFIRM_CLOSE: &str = "confirm-close";

/// The frame both faces share when neither has one to inherit — a cold start, on either face.
const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);
const MIN_SIZE: (f64, f64) = (900.0, 600.0);

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
            center_over(&window, parent.as_ref());
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => {
            eprintln!("close confirmation failed to open: {error}");
            apply_close(app, CloseAction::Tray);
        }
    }
}

/// The middle of the window being asked about, not the middle of the screen — a dialog that opens away from
/// the thing it is about reads as belonging to something else.
fn center_over(window: &WebviewWindow, over: Option<&WebviewWindow>) {
    let placed = over.and_then(|over| {
        let position = over.outer_position().ok()?;
        let frame = over.outer_size().ok()?;
        let own = window.outer_size().ok()?;
        Some(tauri::PhysicalPosition::new(
            position.x + (frame.width as i32 - own.width as i32) / 2,
            position.y + (frame.height as i32 - own.height as i32) / 2,
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

/// The app's own face — the setup it was handed, and the sandboxes on this machine afterwards. The title here
/// is only what it wears until its UI boots: this face has two screens and App.vue names whichever is up.
pub fn show_launcher(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LAUNCHER) {
        swap_in(&window, app.get_webview_window(WORKSPACE));
        return;
    }
    let result = WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("index.html".into()))
        .title("Intentic")
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
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
            swap_in(&window, app.get_webview_window(WORKSPACE));
        }
        Err(error) => eprintln!("launcher window failed to open: {error}"),
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

/// Hand a setup to the launcher face, which runs it on arrival (App.vue says why).
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
