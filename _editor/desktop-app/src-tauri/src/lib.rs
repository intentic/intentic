mod auth;
mod commands;
mod scripts;
mod setup_link;
mod state;
mod windows;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

/// Every `intentic://` link — intercepted webview navigation, OS deep link, or second-instance argv — funnels
/// through here.
pub fn handle_intentic_link(app: &AppHandle, link: &str) {
    windows::handle_link(app, link);
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
        .plugin(tauri_plugin_process::init());

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                for arg in &argv {
                    if arg.starts_with("intentic://") {
                        handle_intentic_link(app, arg);
                        return;
                    }
                }
                windows::show_workspace(app);
            }))
            .plugin(tauri_plugin_deep_link::init())
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![
            sign_in,
            commands::desktop_info,
            commands::pending_setup,
            commands::take_pending_recreate,
            commands::setup_run,
            commands::sandbox_list,
            commands::sandbox_power,
            commands::sandbox_recreate,
            commands::sandbox_remove,
            commands::sandbox_logs,
            commands::machine_report,
            commands::workspace_open,
            commands::settings_get,
            commands::settings_set,
        ])
        .setup(|app| {
            app.manage(state::AppState::load(app.handle())?);
            app.manage(auth::PendingAuth::default());
            create_tray(app.handle())?;

            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // AppImage/dev runs have no installer to register the scheme — best-effort at runtime.
                let _ = app.deep_link().register_all();
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_intentic_link(&handle, url.as_str());
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
                        handle_intentic_link(app.handle(), url.as_str());
                    }
                }
                spawn_update_check(app.handle().clone());
            }

            /* BEFORE the link, nothing opens. A first-time user's very first act is clicking "Set up on this
             * computer" in their browser, which starts this process WITH that link — and opening the workspace
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

    app.run(|_app, _event| {});
}

/// Where the app lives once its window is closed, and the only way back out of it: closing the workspace hides
/// rather than quits, so `Quit` here is the sole exit. That is a lot of weight on an icon the user may never
/// have seen, which is why the first hide says in words that this menu is where the app went.
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open Intentic").build(app)?;
    // "This computer", matching the window it opens — the screen covers the machine's sandboxes AND its desktop
    // sync, and a tray entry naming only half of that is the reason nobody looked there for the other half.
    let manager = MenuItemBuilder::with_id("manager", "This computer").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&manager)
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
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// One startup check; the launcher shows the result and offers the install.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn spawn_update_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;
        let Ok(updater) = app.updater() else {
            return;
        };
        if let Ok(Some(update)) = updater.check().await {
            let _ = app.emit("desktop://update-available", update.version.clone());
        }
    });
}
