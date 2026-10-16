mod account;
mod agent_status;
mod agents;
mod auth;
mod autostart;
mod badge;
mod cli_path;
mod commands;
mod drop_copy;
mod engine;
mod engine_keeper;
mod first_task;
mod fix;
mod found;
mod keyring;
mod launch;
mod local;
mod machine_sandbox;
mod microphone;
mod notice;
mod offline;
mod onboarding;
mod os;
mod prefetch;
mod project;
mod repair;
mod resume;
mod sandbox_wakes;
mod scripts;
mod setup_link;
mod shown;
mod sidecar;
mod state;
mod update;
mod wake;
mod webview_sync;
mod windows;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem,
};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Wry};

use state::Face;

/// Every `intentic://` link — intercepted webview navigation, OS deep link, or second-instance argv — funnels
/// through here, carrying which of those it was: only the first is a link this app watched its own window ask
/// for, and `setup_link::Source` is what that distinction buys.
pub(crate) fn handle_intentic_link(app: &AppHandle, link: &str, source: setup_link::Source<'_>) {
    windows::handle_link(app, link, source);
}

/// Open the platform's sign-in page in the default browser (see auth.rs): the local shell's way to agents. It has no
/// account to reject, so this road never asks for the chooser; the link `intentic://signin?switch=1` is the one that
/// does.
///
/// Which window pressed it decides where the reader lands afterwards: any window but the workspace is a local one —
/// a folder's — and a sign-in asked for there is a sign-in about that folder, so it hands them back to this
/// computer's face rather than to the account's sandbox list (auth.rs `complete_path`).
#[tauri::command]
fn sign_in(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    auth::start(&app, false, window.label() != windows::WORKSPACE)
}

/// What a launch opens onto. This device, in the main window, is for the two things a workspace window cannot
/// show: work parked across a restart, and a machine whose engine is not running under a sandbox that lives on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Opening {
    Workspace,
    ParkedSetup,
    SleepingEngine,
    /// An install last used through the main window (a first launch included): the editor's shell on a folder of
    /// this computer, `~/intentic/local` at first (local.rs), which needs no account at all.
    Home,
}

/// The launch decision, as a function of four facts — pure, because a launch is the one moment with no window
/// for anything to go wrong in front of.
///
/// A PARKED SETUP OUTRANKS THE ENGINE: it is why this launch is happening at all (the sign-in entry, resume.rs),
/// and the card that resumes it is the app's own face — opening the workspace instead left the user on the setup
/// page they had already been through, with the parked setup waiting behind a tray menu nobody had been shown. It
/// also starts Docker as one of its own steps (`ic docker prepare`), so a second thing starting it would draw two
/// cards about one wait.
///
/// A SLEEPING ENGINE is the morning after a restart, and the reason a non-technical owner meets this face far
/// more often than the first one: Docker Desktop does not start itself (scripts.rs has the whole of why), so a
/// machine that hosts a sandbox has no engine, and the workspace this window would otherwise open loads onto
/// nothing at all.
///
/// Past those two, the face the user was last seen choosing (state.rs `Face`): the workspace once it has been
/// shown, the main window until then or once they go back to it. A machine that hosts a sandbox is no exception any
/// more: the main window is a place to work, not a card on the way to the workspace, so going back to it is a choice
/// the next launch keeps (2026-09-30; before, such a machine always opened the workspace).
const fn opening(
    parked: bool,
    hosts_sandboxes: bool,
    engine_listening: bool,
    last_face: Face,
) -> Opening {
    if parked {
        return Opening::ParkedSetup;
    }
    if hosts_sandboxes && !engine_listening {
        return Opening::SleepingEngine;
    }
    match last_face {
        Face::Home => Opening::Home,
        Face::Workspace => Opening::Workspace,
    }
}

/// What a launch at sign-in (`--background`, autostart.rs) opens of what an ordinary one would: nothing, since it is the
/// app going into the tray rather than somebody asking for a window, except a setup parked across a restart, which is
/// the work the resume entry starts this app for (resume.rs) and which either launch may be the one to run. A sleeping
/// engine is not shown at every sign-in: Docker coming up a minute after the desktop is an ordinary morning, and This
/// device says so the moment the reader opens anything.
const fn in_background(opening: Opening) -> Option<Opening> {
    match opening {
        Opening::ParkedSetup => Some(Opening::ParkedSetup),
        Opening::Workspace | Opening::SleepingEngine | Opening::Home => None,
    }
}

pub fn run() {
    // Before anything else: a stuck copy is cleared before the single-instance plugin would wait on it, and this
    // launch writes down how far it gets (launch.rs).
    launch::begin();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Rust-side opening only. The plugin's default injects a click listener into EVERY webview that takes
        // `target="_blank"` and Ctrl/Shift-click with `preventDefault` and then invokes `plugin:opener|open_url` —
        // an IPC command no capability here grants, and the workspace window is remote content that gets none by
        // design. So every press it took died as `not allowed by ACL` with nothing on screen. The page answers both
        // shapes itself (`_editor/web`, `environments/desktop.ts`), which is the road the new-window handler hears.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        builder = builder
            // A second launch carrying a link IS the OS delivering that link, and the deep-link plugin below
            // forwards the same argv to `on_open_url` — so handling it here as well runs every external link
            // twice. This decides one thing: whether the second launch was a bare one.
            .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
                if argv.iter().any(|arg| arg.starts_with("intentic://")) {
                    return;
                }
                // A launch at sign-in (autostart.rs) that finds the app already up: in the tray is all it asks for.
                if argv.iter().any(|arg| arg == autostart::ARG) {
                    return;
                }
                // The resume entry's launch (resume.rs) finding the app already up, started at the same sign-in by the
                // start at login: the parked setup is what it came for, not the last face.
                if argv.iter().any(|arg| arg == resume::ARG)
                    && app.state::<state::AppState>().parked_setup().is_some()
                {
                    windows::show_device(app);
                    return;
                }
                // A double-click on a document, or "Open with Intentic" on a folder, while the app is up.
                if local::open_args(
                    app,
                    argv.into_iter().skip(1),
                    Some(std::path::Path::new(&cwd)),
                ) {
                    return;
                }
                // A bare second launch is the app being asked for: what the tray's "Open Intentic" opens.
                windows::show_last_face(app);
            }))
            .plugin(tauri_plugin_deep_link::init());
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![
            sign_in,
            commands::desktop_info,
            commands::docker_ready,
            commands::docker_listening,
            commands::docker_start,
            commands::docker_open,
            commands::hosts_sandboxes,
            commands::take_pending_docker,
            commands::take_pending_setup,
            commands::take_pending_recreate,
            fix::take_pending_fix,
            fix::sandbox_fix,
            commands::take_pending_sync,
            commands::sync_run,
            commands::folder_entries,
            commands::setup_run,
            commands::run_stop,
            commands::reveal_log,
            commands::open_url,
            commands::restart_for_setup,
            commands::sign_out_for_setup,
            commands::resumable_setup,
            commands::forget_resumable_setup,
            commands::park_setup_for_pc,
            commands::setup_fresh_code,
            commands::sandbox_list,
            commands::sandbox_power,
            commands::sandbox_recreate,
            commands::sandbox_shape,
            commands::docker_engine,
            commands::sandbox_remove,
            commands::sandbox_logs,
            commands::machine_report,
            commands::machine_restart,
            // The keyring on this computer, This device's Passwords group (keyring.rs).
            keyring::keyring_status,
            keyring::keyring_list,
            keyring::keyring_setup,
            keyring::keyring_add,
            keyring::keyring_remove,
            keyring::keyring_share,
            keyring::keyring_unshare,
            keyring::keyring_unlock,
            keyring::keyring_lock,
            keyring::keyring_askpass,
            keyring::keyring_harden,
            commands::workspace_open,
            commands::home_facts,
            commands::setup_alert,
            commands::setup_progress,
            commands::fit_to_content,
            commands::close_workspace,
            commands::settings_get,
            commands::settings_set,
            commands::update_state,
            commands::update_install,
            local::local_pick,
            local::local_point,
            local::local_open_path,
            local::local_recents,
            local::local_forget_recent,
            local::local_roster,
            account::account_relay,
            project::project_preview,
            project::project_attach,
            machine_sandbox::machine_sandbox_status,
            machine_sandbox::machine_sandbox_retry,
            machine_sandbox::machine_sandbox_check,
            machine_sandbox::machine_sandbox_recreate,
            machine_sandbox::machine_sandbox_leftovers,
            machine_sandbox::machine_sandbox_remove_leftovers,
            machine_sandbox::machine_sandbox_start,
            machine_sandbox::machine_sandbox_end_session,
            found::found_on_machine,
            agents::machine_agents,
            // FIRST RUN (2026-10-09): this PC's check, download and setup (onboarding.rs).
            onboarding::onboarding_state,
            onboarding::onboarding_recheck,
            onboarding::onboarding_set_up,
            onboarding::onboarding_pause,
            onboarding::onboarding_restart,
            onboarding::onboarding_use_cloud,
            // The first task, kept until this computer's sandbox is ready (first_task.rs).
            first_task::first_task_read,
            first_task::first_task_queue,
            first_task::first_task_clear,
            first_task::first_task_pick_folder,
            first_task::first_task_take_draft,
            // Repair, the agent that runs on this computer outside every sandbox (repair.rs).
            repair::repair_state,
            repair::repair_start,
            repair::repair_send,
            repair::repair_answer,
            repair::repair_reset,
            // Which engine this PC's sandboxes run on, and the move to the other (engine.rs).
            engine::engine_status,
            engine::engine_move,
            engine::engine_prefer,
            engine::engine_cleanup,
            // Intentic OS: this computer's system, and the changes This device makes to it (os.rs).
            os::os_status,
            os::os_update_check,
            os::os_update,
            os::os_rollback,
            os::os_reboot,
            os::os_channel,
        ])
        .setup(|app| {
            // The plugins are up, the single-instance handoff among them: this launch is the copy that runs.
            launch::reached(launch::Stage::Ready);
            app.manage(state::AppState::load(app.handle())?);
            app.manage(auth::PendingAuth::default());
            app.manage(update::UpdateState::default());
            app.manage(local::LocalFiles::default());
            app.manage(found::FoundCache::default());
            app.manage(sidecar::Sidecar::default());
            app.manage(badge::Badge::default());
            app.manage(notice::Notices::default());
            app.manage(machine_sandbox::MachineSandbox::load(app.handle())?);
            // Before the tray, whose rows it titles (wake.rs).
            app.manage(wake::Wake::load(app.handle())?);
            create_tray(app.handle())?;
            // `intentic .` onto PATH, where the installer's own attempt ran out of time (cli_path.rs).
            cli_path::finish_pending(app.handle());
            // After the tray exists: the refresh loop retitles the agent row this row-handle now points at.
            agent_status::start(app.handle());

            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // AppImage/dev runs have no installer to register the scheme — best-effort at runtime.
                let _ = app.deep_link().register_all();
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_intentic_link(&handle, url.as_str(), setup_link::Source::External);
                    }
                });
                // A COLD start: the OS starts the app with the link in argv (that is the whole Linux/Windows
                // deep-link mechanism — there is no running process to deliver it to). The plugin reads argv
                // during ITS OWN setup, which is over before the listener above exists, so the event it emits
                // there is announced to an empty room. Nothing replays it — `on_open_url` is a plain listener —
                // and the link a first-time user clicked would be silently dropped. What the plugin kept is the
                // url itself, so ask for it.
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        handle_intentic_link(
                            app.handle(),
                            url.as_str(),
                            setup_link::Source::External,
                        );
                    }
                }
            }

            // Air-gapped installs and executable smoke tiers can disable the one background request this
            // process otherwise makes independently of the workspace origin. Everything else this app does
            // about its own version — the schedule, the silent download, the install on the way out — is
            // behind this switch, so a tier that sets it gets a process that never touches the network.
            if std::env::var_os("INTENTIC_DISABLE_UPDATE_CHECK").is_none() {
                update::start(app.handle());
            }

            // A COLD start on a document or a folder (a double-click, "Open with Intentic"): its window is what
            // this launch is for, so no face opens beside it.
            let opened_local = local::open_args(
                app.handle(),
                std::env::args().skip(1),
                std::env::current_dir().ok().as_deref(),
            );

            // A launch at sign-in, which the reader asked for once, from the tray (autostart.rs).
            let background = std::env::args().any(|arg| arg == autostart::ARG);

            /* BEFORE the link, nothing opens. */
            if app.webview_windows().is_empty() && !opened_local {
                let state = app.state::<state::AppState>();
                // The engine is asked for by its socket, never by `docker info`, which would hold the first
                // window of the launch for tens of seconds on exactly the machines this is about (scripts.rs).
                let opening = opening(
                    state.parked_setup().is_some(),
                    state.hosts_sandboxes(),
                    scripts::engine_listening(),
                    state.last_face(),
                );
                let opening = if background {
                    in_background(opening)
                } else {
                    Some(opening)
                };
                // A launch that shows This device for the engine hands over to the workspace once it wakes, when the
                // workspace is the face it would otherwise have opened; one last used through the main window stays.
                if opening == Some(Opening::SleepingEngine) && state.last_face() == Face::Workspace
                {
                    *state.pending_docker.lock().unwrap() = true;
                }
                match opening {
                    Some(Opening::Workspace) => windows::show_workspace(app.handle()),
                    // A launch into the main window is that window shown by the user's own doing: remembered as the
                    // face in use. It starts the file server itself, since it is a window on a folder.
                    Some(Opening::Home) => windows::show_home(app.handle()),
                    Some(Opening::ParkedSetup | Opening::SleepingEngine) => {
                        windows::show_device(app.handle())
                    }
                    None => {}
                }
            }
            let windowed = !app.webview_windows().is_empty();
            if windowed {
                launch::reached(launch::Stage::Window);
            } else if background {
                // The tray is all a launch at sign-in puts in front of anyone, and it is up: this launch has done what
                // it was started for, and is no stalled launch for the next one to report (launch.rs).
                launch::reached(launch::Stage::Shown);
            }
            // A page that was listening for its wake word when the app last ran goes on listening, in the workspace
            // loaded hidden (wake.rs); after the window this launch put up has had its first paint, when it put one up.
            wake::resume_on_launch(
                app.handle(),
                std::time::Duration::from_secs(if windowed { 3 } else { 0 }),
            );
            // What earlier launches left to report (a launch that never showed a window, a panic), sent off this thread.
            launch::send_reports(app.handle());
            // This computer's own sandbox, made after sign-in and kept, by a thread of its own rather than any window
            // (machine_sandbox.rs): a setup the last quit cut short is picked up here.
            onboarding::begin(app.handle());
            machine_sandbox::start(app.handle());
            // Intentic's engine, started again when it stops while this app runs (engine_keeper.rs).
            engine_keeper::start(app.handle());
            // What earlier runs left on disk (2026-10-05): run transcripts past the newest few (scripts.rs), and the paths
            // files of bring-backs a crash cut short (project.rs). Off the launch's thread: it is a folder or two read.
            let sweeping = app.handle().clone();
            std::thread::spawn(move || {
                scripts::prune_logs();
                project::sweep_paths_files(&sweeping);
                // A sign-in entry with nothing parked for it is taken away, so a launch it made is its last (resume.rs).
                resume::settle(&sweeping);
            });
            // The file server a few seconds in, when a local window is likely: an install that has opened any is likely
            // to again.
            if !app.state::<state::AppState>().recents().is_empty() {
                sidecar::start_early(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("intentic desktop failed to start");

    /* Quitting is the one moment with nothing to interrupt: the window is going anyway, no script run is being watched. */
    app.run(|app, event| match event {
        // The last window closing is not the app ending: it lives in the tray (a local window closed, a face hidden
        // by its ×). Only Quit, which exits with a code, ends it.
        RunEvent::ExitRequested {
            api, code: None, ..
        } => api.prevent_exit(),
        // Quit, the ×'s "Quit", a restart: a local window with unsaved changes is asked about first, and the exit
        // waits for the answer (windows.rs `hold_quit`).
        RunEvent::ExitRequested {
            api,
            code: Some(code),
            ..
        } => {
            if windows::hold_quit(app, code) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            // Quitting is not stalling: a launch that ends here is not reported, wherever it got to.
            launch::reached(launch::Stage::Exited);
            // A setup of this computer's sandbox under way is stopped with all it started, and run again next launch.
            machine_sandbox::before_exit();
            // Nothing the app put up can be answered once it has gone.
            notice::clear_before_exit(app);
            sidecar::shutdown(app);
            update::install_on_exit(app);
        }
        _ => {}
    });
}

/// The tray's "Open workspace" row, and whether it is in the menu yet: it is offered only once an account has
/// been seen (state.rs `account_seen`), which can happen while the app runs, so it is inserted then rather than
/// the menu rebuilt — a rebuilt tray menu flickers on Windows and loses whatever the user has open.
///
/// The wake word's two rows and the rule under them come with it (wake.rs): listening is the workspace page's, and an
/// install with no account has no workspace to listen in.
struct TrayWorkspace {
    menu: Menu<Wry>,
    row: MenuItem<Wry>,
    wake_gap: PredefinedMenuItem<Wry>,
    offered: AtomicBool,
}

/// Where the row goes: after "Open Intentic" and "This computer".
const WORKSPACE_ROW_AT: usize = 2;

/// The row the wake word's rows go above: the machine agent's, at the head of the group about this computer.
const AGENT_ROW: &str = "agent";

/// Put "Open workspace" in the tray, once, when an account has been seen (a sign-in, or the workspace shown), and the
/// wake word's rows with it.
pub(crate) fn offer_workspace(app: &AppHandle) {
    let Some(tray) = app.try_state::<TrayWorkspace>() else {
        return;
    };
    if !app.state::<state::AppState>().account_seen() || tray.offered.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(error) = tray.menu.insert(&tray.row, WORKSPACE_ROW_AT) {
        tray.offered.store(false, Ordering::SeqCst);
        eprintln!("intentic: the tray could not offer the workspace: {error}");
        return;
    }
    let Some(wake) = app.try_state::<wake::TrayWake>() else {
        return;
    };
    let at = tray.menu.items().ok().and_then(|items| {
        items
            .iter()
            .position(|item| item.id().as_ref() == AGENT_ROW)
    });
    let inserted = match at {
        Some(at) => tray
            .menu
            .insert_items(&[&wake.listen, &wake.pause, &tray.wake_gap], at),
        None => Ok(()),
    };
    if let Err(error) = inserted {
        eprintln!("intentic: the tray could not offer the wake word: {error}");
    }
}

/// Where the app lives once its window is closed: the × hides a face (the workspace or the main window) rather than
/// ending the app, so `Open Intentic` here is the way back to whichever face was last in use. That is a lot of weight
/// on an icon the user may never have seen, which is why the × asks the first time and names this tray in the asking
/// (windows.rs) — and why `Quit` is offered there too, rather than only here.
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open Intentic").build(app)?;
    // "This computer", as the workspace's sandbox switcher names the same place: the main window, on this computer's
    // folder, with This device beside it. The id is the one the row has always had.
    let manager = MenuItemBuilder::with_id("manager", "This computer").build(app)?;
    let workspace = MenuItemBuilder::with_id("workspace", "Open workspace").build(app)?;
    /* This app spends most of its life as a tray icon with nothing on screen. */
    let update = MenuItemBuilder::with_id("update", "Checking for updates…")
        .enabled(false)
        .build(app)?;
    /* The machine agent has no window because it runs headlessly at logon. */
    let agent = MenuItemBuilder::with_id("agent", "Machine agent: checking…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    // A folder or a document of this computer, in a window of its own (local.rs): no sandbox, no sign-in.
    let open_folder = MenuItemBuilder::with_id("open-folder", "Open a folder…").build(app)?;
    let open_file = MenuItemBuilder::with_id("open-file", "Open a file…").build(app)?;
    let repair = MenuItemBuilder::with_id("repair", "Repair Intentic…").build(app)?;
    // Ticked as the system has it, read off this thread just below (autostart.rs).
    let login = CheckMenuItemBuilder::with_id(autostart::ROW, "Start Intentic at login")
        .checked(false)
        .build(app)?;
    // The wake word's rows, and the rule between them and the agent's; in the menu once there is a workspace.
    let wake_rows = wake::tray_rows(app)?;
    let wake_gap = PredefinedMenuItem::separator(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&manager)
        .separator()
        .item(&open_folder)
        .item(&open_file)
        .item(&repair)
        .separator()
        .item(&agent)
        .item(&update)
        .item(&login)
        .separator()
        .item(&quit)
        .build()?;
    let mut tray = TrayIconBuilder::with_id(badge::TRAY)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Intentic")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => windows::show_last_face(app),
            "manager" => windows::show_home(app),
            "workspace" => windows::show_workspace(app),
            "agent" => windows::show_device(app),
            "open-folder" => local::pick(app, true),
            "open-file" => local::pick(app, false),
            "repair" => windows::show_home_route(app, "/repair?from=tray"),
            "update" => update::act(app),
            wake::LISTEN_ROW => wake::listen_pressed(app),
            wake::PAUSE_ROW => wake::pause_pressed(app),
            autostart::ROW => autostart::pressed(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    // Held so the state can retitle them without rebuilding the menu — a rebuilt tray menu flickers on Windows
    // and loses whatever the user has open.
    app.manage(update::TrayUpdate(update));
    app.manage(agent_status::TrayAgent(agent));
    app.manage(autostart::TrayLogin(login));
    autostart::refresh(app);
    app.manage(wake_rows);
    app.manage(TrayWorkspace {
        menu,
        row: workspace,
        wake_gap,
        offered: AtomicBool::new(false),
    });
    offer_workspace(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* WHAT OPENS, for the four facts that decide it. */

    #[test]
    fn a_machine_whose_sandbox_has_no_engine_opens_on_that_and_not_on_a_dead_workspace() {
        assert_eq!(
            opening(false, true, false, Face::Workspace),
            Opening::SleepingEngine
        );
        // Last used through the main window or not, the engine is still what this launch has to say something about.
        assert_eq!(
            opening(false, true, false, Face::Home),
            Opening::SleepingEngine
        );
        // Engine up: there is nothing to say, and the workspace is what the app is for.
        assert_eq!(
            opening(false, true, true, Face::Workspace),
            Opening::Workspace
        );
    }

    #[test]
    fn a_parked_setup_outranks_a_sleeping_engine_because_its_own_run_starts_it() {
        assert_eq!(
            opening(true, true, false, Face::Workspace),
            Opening::ParkedSetup
        );
        assert_eq!(opening(true, false, true, Face::Home), Opening::ParkedSetup);
    }

    /// Somebody using this app as a window onto a sandbox we host has a perfectly good reason for their Docker
    /// to be off, and starting it for them would be this app helping itself to their machine.
    #[test]
    fn a_machine_no_sandbox_has_run_on_opens_the_workspace_whatever_docker_is_doing() {
        assert_eq!(
            opening(false, false, false, Face::Workspace),
            Opening::Workspace
        );
        assert_eq!(
            opening(false, false, true, Face::Workspace),
            Opening::Workspace
        );
    }

    /// A launch at sign-in puts nothing on screen but a setup parked for exactly that sign-in.
    #[test]
    fn a_launch_at_sign_in_opens_nothing_but_a_parked_setup() {
        assert_eq!(
            in_background(Opening::ParkedSetup),
            Some(Opening::ParkedSetup)
        );
        for opening in [Opening::Workspace, Opening::Home, Opening::SleepingEngine] {
            assert_eq!(in_background(opening), None, "{opening:?}");
        }
    }

    /// A launch opens the face the user was last seen choosing: the main window for a first launch (there is no
    /// workspace to show anyone without an account) and for anyone who went back to it, on the folder they can work in
    /// right now.
    #[test]
    fn an_install_last_used_through_the_main_window_opens_it() {
        assert_eq!(opening(false, false, true, Face::Home), Opening::Home);
        assert_eq!(opening(false, false, false, Face::Home), Opening::Home);
        // A machine that hosts a sandbox too: the main window is a place to work, not a card on the way to the
        // workspace, so going back to it is kept.
        assert_eq!(opening(false, true, true, Face::Home), Opening::Home);
    }
}
