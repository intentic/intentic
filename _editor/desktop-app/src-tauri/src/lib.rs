mod agent_status;
mod auth;
mod commands;
mod scripts;
mod setup_link;
mod state;
mod update;
mod windows;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};

/// Every `intentic://` link — intercepted webview navigation, OS deep link, or second-instance argv — funnels
/// through here, carrying which of those it was: only the first is a link this app watched its own window ask
/// for, and `setup_link::Source` is what that distinction buys.
pub(crate) fn handle_intentic_link(app: &AppHandle, link: &str, source: setup_link::Source) {
    windows::handle_link(app, link, source);
}

/// Open the platform's sign-in page in the default browser (see auth.rs).
#[tauri::command]
fn sign_in(app: AppHandle) -> Result<(), String> {
    auth::start(&app)
}

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        builder = builder
            // A second launch carrying a link IS the OS delivering that link, and the deep-link plugin below
            // forwards the same argv to `on_open_url` — so handling it here as well runs every external link
            // twice. This decides one thing: whether the second launch was a bare one.
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                if argv.iter().any(|arg| arg.starts_with("intentic://")) {
                    return;
                }
                windows::show_workspace(app);
            }))
            .plugin(tauri_plugin_deep_link::init());
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![
            sign_in,
            commands::desktop_info,
            commands::docker_ready,
            commands::take_pending_setup,
            commands::take_pending_recreate,
            commands::take_pending_sync,
            commands::sync_run,
            commands::folder_entries,
            commands::setup_run,
            commands::run_stop,
            commands::reveal_log,
            commands::restart_for_setup,
            commands::sign_out_for_setup,
            commands::resumable_setup,
            commands::forget_resumable_setup,
            commands::sandbox_list,
            commands::sandbox_power,
            commands::sandbox_recreate,
            commands::sandbox_reshape,
            commands::docker_engine,
            commands::sandbox_remove,
            commands::sandbox_logs,
            commands::machine_report,
            commands::machine_restart,
            commands::workspace_open,
            commands::setup_alert,
            commands::setup_progress,
            commands::fit_to_content,
            commands::close_workspace,
            commands::settings_get,
            commands::settings_set,
            commands::update_state,
            commands::update_install,
        ])
        .setup(|app| {
            app.manage(state::AppState::load(app.handle())?);
            app.manage(auth::PendingAuth::default());
            app.manage(update::UpdateState::default());
            create_tray(app.handle())?;
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

            /* BEFORE the link, nothing opens. */
            if app.webview_windows().is_empty() {
                // A setup parked across a restart or a sign-out is why this launch is happening at all
                // (RunOnce, commands.rs `end_session`), and the card that resumes it is the app's own face.
                // Opening the workspace instead left the user on the setup page they had already been
                // through, with the parked setup waiting behind a tray menu nobody had been shown.
                if app.state::<state::AppState>().parked_setup().is_some() {
                    windows::show_launcher(app.handle());
                } else {
                    windows::show_workspace(app.handle());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("intentic desktop failed to start");

    /* Quitting is the one moment with nothing to interrupt: the window is going anyway, no script run is being watched. */
    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            update::install_on_exit(app);
        }
    });
}

/// Where the app lives once its window is closed: the × hides the workspace rather than ending the app, so
/// `Open Intentic` here is the way back to it. That is a lot of weight on an icon the user may never have
/// seen, which is why the × asks the first time and names this tray in the asking (windows.rs) — and why
/// `Quit` is offered there too, rather than only here.
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open Intentic").build(app)?;
    // "This device", matching the window it opens — the screen covers the machine's sandboxes AND its desktop
    // sync, and a tray entry naming only half of that is the reason nobody looked there for the other half.
    let manager = MenuItemBuilder::with_id("manager", "This device").build(app)?;
    /* This app spends most of its life as a tray icon with nothing on screen. */
    let update = MenuItemBuilder::with_id("update", "Checking for updates…")
        .enabled(false)
        .build(app)?;
    /* The machine agent has no window because it runs headlessly at logon. */
    let agent = MenuItemBuilder::with_id("agent", "Machine agent: checking…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&manager)
        .separator()
        .item(&agent)
        .item(&update)
        .separator()
        .item(&quit)
        .build()?;
    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Intentic")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => windows::show_workspace(app),
            "manager" => windows::show_launcher(app),
            "agent" => windows::show_launcher(app),
            "update" => update::act(app),
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
    Ok(())
}
