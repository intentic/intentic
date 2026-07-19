mod commands;
mod reporter;
mod setup_link;
mod state;
mod sync_agent;
mod windows;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

/// Every `intentic://` link — intercepted webview navigation, OS deep link, or second-instance
/// argv — funnels through here.
pub fn handle_intentic_link(app: &AppHandle, link: &str) {
    windows::handle_link(app, link);
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
            commands::desktop_info,
            commands::pending_setup,
            commands::environment_probe,
            commands::environment_fix,
            commands::setup_run,
            commands::sandbox_list,
            commands::sandbox_start,
            commands::sandbox_stop,
            commands::sandbox_update,
            commands::sandbox_remove,
            commands::sandbox_logs,
            commands::workspace_open,
            commands::settings_get,
            commands::settings_set,
        ])
        .setup(|app| {
            app.manage(state::AppState::load(app.handle())?);
            create_tray(app.handle())?;

            // AppImage/dev runs have no installer to register the scheme — best-effort at runtime.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_intentic_link(&handle, url.as_str());
                    }
                });
            }

            windows::show_workspace(app.handle());

            #[cfg(any(target_os = "linux", target_os = "windows"))]
            spawn_update_check(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("intentic desktop failed to start");

    app.run(|_app, event| {
        // Closing the last window keeps the app (and its tray) alive; only Quit exits.
        if let RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open Intentic").build(app)?;
    let manager = MenuItemBuilder::with_id("manager", "Sandbox Manager").build(app)?;
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

/// One startup check; the launcher shows the result and drives the install on request.
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
