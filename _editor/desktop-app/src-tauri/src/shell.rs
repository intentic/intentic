//! Intentic OS's desktop shell. The compositor integration runs only in the Linux kiosk session.

pub mod lock;
pub mod screen;

#[cfg(target_os = "linux")]
mod ipc;
#[cfg(target_os = "linux")]
mod spaces;

pub fn start(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    if crate::os::kiosk() {
        spaces::start(app);
    }
    let _ = app;
}

pub fn roster_changed(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    if crate::os::kiosk() {
        spaces::roster_changed(app);
    }
    let _ = app;
}

pub fn face_shown(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    if crate::os::kiosk() {
        spaces::face_shown(window);
    }
    let _ = window;
}

pub fn open(app: &tauri::AppHandle, target: crate::setup_link::ShellTarget) {
    #[cfg(target_os = "linux")]
    if crate::os::kiosk() {
        spaces::open(app, target);
        return;
    }
    match target {
        crate::setup_link::ShellTarget::Device => crate::windows::show_device(app),
        crate::setup_link::ShellTarget::Sandbox { id, agents } => {
            use tauri::Manager;
            // A stale bar cannot take the account somewhere it no longer lists.
            if app
                .state::<crate::state::AppState>()
                .roster()
                .sandboxes
                .iter()
                .any(|s| s.id == id)
            {
                crate::windows::show_workspace_at(
                    app,
                    Some(&format!(
                        "/{}?sandbox={id}",
                        if agents { "agents" } else { "" }
                    )),
                );
            }
        }
    }
}
