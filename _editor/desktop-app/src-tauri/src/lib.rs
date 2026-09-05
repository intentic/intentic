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
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                for arg in &argv {
                    if arg.starts_with("intentic://") {
                        handle_intentic_link(app, arg, setup_link::Source::External);
                        return;
                    }
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
            commands::sandbox_remove,
            commands::sandbox_logs,
            commands::machine_report,
            commands::workspace_open,
            commands::setup_alert,
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

            /* BEFORE the link, nothing opens. A first-time user's very first act is clicking "Set up on this
             * device" in their browser, which starts this process WITH that link — and opening the workspace
             * first would load app.intentic.dev only for the setup face to take the frame a moment later. What
             * they would see is the app opening something and immediately throwing it away.
             *
             * So the link chooses the face, and this is the fallback for every start that had no link (or had
             * one that only opened a browser, like sign-in): whatever happened above, if it left nothing on
             * screen, the app opens on the thing it is for. */
            if app.webview_windows().is_empty() {
                windows::show_workspace(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("intentic desktop failed to start");

    /* THE WAY OUT IS ALSO THE WAY A DOWNLOADED UPDATE GETS APPLIED.
     *
     * Quitting is the one moment with nothing to interrupt: the window is going anyway, no script run is being
     * watched, and the next launch is simply the new version with nobody having been asked about it. This is
     * what the launcher's notice used to CLAIM happened while nothing in the crate installed anything.
     *
     * `Exit` rather than `ExitRequested`, because the latter can still be cancelled and an app that installed
     * its update and then stayed open would be running one version while its files are another. */
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
    /* THE APP'S OWN VERSION, ON THE ONE SURFACE THAT IS THERE WHEN NO WINDOW IS.
     *
     * This app spends most of its life as a tray icon with nothing on screen, so a "an update is ready" that
     * lives only in a window is one most people will never meet. The row is always present and always says
     * something true — up to date, downloading, ready — rather than appearing out of nowhere on the day there
     * is news, because a menu that changes shape is a menu nobody learns. It is clickable in exactly the two
     * states where a click does something: the swap is downloaded, or this copy cannot swap itself at all
     * (update.rs `Stage::tray`).
     */
    let update = MenuItemBuilder::with_id("update", "Checking for updates…")
        .enabled(false)
        .build(app)?;
    /* THE MACHINE AGENT'S ROW, same reasoning as the update row: the agent is a headless resident process with
     * no face of its own (its logon start maps no window, by design), and the tray is the one surface a user
     * meets without opening anything. The sentence is the agent's own `status --json` summary (agent_status.rs),
     * so this row and `intentic-machine status` in a terminal cannot disagree. Clickable, and the click opens
     * the "This device" screen, which renders the full report behind the sentence. */
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
