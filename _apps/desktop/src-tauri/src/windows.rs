use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::setup_link::parse_setup_link;

pub const WORKSPACE: &str = "workspace";
pub const LAUNCHER: &str = "launcher";

/// Marks the page as running inside the desktop app. Detection only — the actual handoff is an
/// `intentic://` navigation this window intercepts, so no IPC is ever exposed to remote content.
fn workspace_init_script() -> String {
    format!(
        "(function () {{ if (!window.__INTENTIC_DESKTOP__) {{ window.__INTENTIC_DESKTOP__ = Object.freeze({{ version: \"{}\" }}); }} }})();",
        env!("CARGO_PKG_VERSION")
    )
}

/// WebKitGTK's default UA advertises the embedded engine, which Google's sign-in refuses; a plain
/// Safari UA keeps the flow working. WebView2 already presents as Edge and needs no override.
#[cfg(target_os = "linux")]
const LINUX_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

pub fn show_workspace(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WORKSPACE) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let state = app.state::<crate::state::AppState>();
    let url: tauri::Url = match state.app_url().parse() {
        Ok(url) => url,
        Err(_) => crate::state::APP_URL
            .parse()
            .expect("static app url parses"),
    };
    let link_handler = app.clone();
    let builder = WebviewWindowBuilder::new(app, WORKSPACE, WebviewUrl::External(url))
        .title("Intentic")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .initialization_script(workspace_init_script())
        .on_navigation(move |url| {
            if url.scheme() == "intentic" {
                // Handle off the navigation callback — creating the launcher window inside the
                // webview's navigation event would re-enter the webview (WebView2 COM re-entrancy).
                let app = link_handler.clone();
                let link = url.to_string();
                tauri::async_runtime::spawn(async move {
                    crate::handle_intentic_link(&app, &link);
                });
                return false;
            }
            true
        });
    #[cfg(target_os = "linux")]
    let builder = builder.user_agent(LINUX_UA);
    if let Err(error) = builder.build() {
        eprintln!("workspace window failed to open: {error}");
    }
}

pub fn show_launcher(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LAUNCHER) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let result = WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("index.html".into()))
        .title("Intentic — Sandbox Manager")
        .inner_size(640.0, 760.0)
        .min_inner_size(520.0, 600.0)
        .build();
    if let Err(error) = result {
        eprintln!("launcher window failed to open: {error}");
    }
}

/// Deep links land here from three directions: the workspace webview's intercepted navigation, the
/// second-instance argv, and the OS handler. All converge on the same pending-setup handoff.
pub fn handle_link(app: &AppHandle, link: &str) {
    let Some(args) = parse_setup_link(link) else {
        return;
    };
    let state = app.state::<crate::state::AppState>();
    *state.pending.lock().unwrap() = Some(args);
    show_launcher(app);
    let _ = tauri::Emitter::emit(app, "desktop://pending-setup", ());
}
