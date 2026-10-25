use super::chrome::work_the_window;
use super::mode::announced;
use super::{show_device, show_folder_that_asked, show_home_at, Keyboard, FILES_ROUTE};
use crate::setup_link::{parse_link, LauncherTo, Link, NoticeVerb, SetupArgs, Source, WindowVerb};
use crate::state::{AppState, Face};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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
        Some(Link::Shell(target)) => crate::shell::open(app, target),
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
        // The page asked the platform to wake its sandbox: one asleep on this computer is started now rather than on
        // the keeper's next poll (sandbox_wakes.rs). Nothing is shown; the page draws the wake itself.
        Some(Link::SandboxWakes) => crate::sandbox_wakes::requested(),
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
        // Asked for by link rather than by a window's press: the workspace's own road back in, so it ends there.
        Some(Link::SignIn { switch_account }) => {
            if let Err(error) = crate::auth::start(app, switch_account, None) {
                eprintln!("{error}");
            }
        }
        Some(Link::Auth(args)) => crate::auth::complete(app, &args),
        // The banner's button. Nothing is parked and no face is swapped: the bytes are already on this machine
        // (update.rs), so this either installs and comes back, or opens the download page for a copy that
        // cannot install anything.
        Some(Link::Update) => crate::update::act(app),
        Some(Link::AnalyticsConsent(allow)) => {
            crate::launch::set_analytics_consent(if allow { "allow" } else { "deny" });
            let _ = tauri::Emitter::emit(app, "desktop://analytics-consent", allow);
        }
        // The workspace's way back to this computer: This device (a setup page's way back to the run it handed over,
        // a sandbox's "restart in the app"), or the folder itself (the sandbox switcher's "This computer").
        Some(Link::Launcher {
            to: LauncherTo::Files,
        }) => {
            app.state::<AppState>().remember_last_face(Face::Home);
            show_home_at(app, Some(FILES_ROUTE), Keyboard::Take);
        }
        Some(Link::Launcher {
            to: LauncherTo::Device,
        }) => show_device(app),
        // The way back from a sign-in that began on a folder (auth.rs `complete_path`): the folder asked for an agent,
        // so the reader is put back on it, its own sandbox's setup starting by itself and its card saying how far, or
        // what it waits for.
        Some(Link::Launcher {
            to: LauncherTo::Agent,
        }) => {
            let asked_in = crate::auth::take_asked_in();
            show_folder_that_asked(app, asked_in.as_deref());
            // The page redeemed the session just before saying so: a folder waiting on the sign-in finds it now.
            crate::folder_setup::kick();
        }
        // The setup page took this sandbox to a machine of ours, or its reader called the install off there: the main
        // window stops the install it runs for it as the card's own Stop does, or gives up the setup waiting on this PC
        // (src/device/setup.ts `stopForPage`). Nothing is shown or swapped: the reader stays on that page.
        Some(Link::SetupStop { sandbox_id }) => {
            let _ = tauri::Emitter::emit(app, "desktop://setup-stop", sandbox_id);
        }
        // The workspace's account and sandboxes, for the local windows to show (state.rs `remember_roster`). Nothing
        // is shown now: the page sends it whenever either changes, not because the reader asked for anything.
        Some(Link::Roster(roster)) => {
            // A sandbox the account lists no more: its folders' records and this machine's sync of it go (project.rs).
            let before = app.state::<AppState>().roster();
            crate::project::roster_changed(app, before, roster.clone());
            app.state::<AppState>().remember_roster(roster.clone());
            let _ = tauri::Emitter::emit(app, "desktop://roster", &roster);
            crate::shell::roster_changed(app);
            // Who is signed in is what a folder's sandbox waits for (folder_setup.rs).
            crate::folder_setup::account_changed();
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
        // The workspace's listening for its wake word: for the tray's rows and the next launch (wake.rs).
        Some(Link::Wake(args)) => crate::wake::reported(app, args),
        // The page saying what light it is drawn in; about this app's faces, not the workspace window.
        Some(Link::Window(WindowVerb::Mode(mode, look))) => announced(app, mode, look),
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
        // The workspace saying what became of the first task the app handed it (first_task.rs).
        Some(Link::FirstTask(args)) => crate::first_task::on_link(app, args),
        // Repair, opened on this computer from the recovery panel, a page or the system (repair.rs).
        Some(Link::Repair(args)) => crate::repair::on_link(app, args),
        // Passwords, opened from the hosted editor's "Manage on this computer" (keyring.rs).
        Some(Link::Passwords { entry }) => crate::keyring::on_link(app, entry.as_deref()),
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
/// A link does not say when its code was minted, so its arrival stands in for that (`SetupArgs::minted_at`).
fn park_setup(app: &AppHandle, mut args: SetupArgs) {
    args.minted_at = args.minted_at.or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|since| since.as_secs())
    });
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
