use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::setup_link::{parse_link, Link};

pub const WORKSPACE: &str = "workspace";
pub const LAUNCHER: &str = "launcher";

/// Marks the page as running inside the desktop app. DETECTION ONLY — the handoff is the `intentic://`
/// navigation this window intercepts, so no IPC is ever exposed to remote content.
fn workspace_init_script() -> String {
    format!(
        "(function () {{ if (!window.__INTENTIC_DESKTOP__) {{ window.__INTENTIC_DESKTOP__ = Object.freeze({{ version: \"{}\" }}); }} }})();",
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
    let base = app.state::<crate::state::AppState>().app_url();
    let target = match path {
        Some(path) => format!("{}{path}", base.trim_end_matches('/')),
        None => base,
    };
    if let Some(window) = app.get_webview_window(WORKSPACE) {
        let _ = window.show();
        let _ = window.set_focus();
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
        Err(_) => crate::state::APP_URL.parse().expect("static app url parses"),
    };
    let link_handler = app.clone();
    let builder = WebviewWindowBuilder::new(app, WORKSPACE, WebviewUrl::External(url))
        .title("Intentic")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .initialization_script(workspace_init_script())
        .on_navigation(move |url| {
            if url.scheme() == "intentic" {
                // Handle off the navigation callback — creating a window inside the webview's navigation
                // event would re-enter the webview (WebView2 COM re-entrancy).
                let app = link_handler.clone();
                let link = url.to_string();
                tauri::async_runtime::spawn(async move {
                    crate::handle_intentic_link(&app, &link);
                });
                return false;
            }
            true
        });
    if let Err(error) = builder.build() {
        eprintln!("workspace window failed to open: {error}");
    }
}

pub fn show_workspace(app: &AppHandle) {
    show_workspace_at(app, None);
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

/// Links land here from three directions: the workspace webview's intercepted navigation, the second-instance
/// argv, and the OS handler. A setup parks its request for the launcher to pick up; an auth handoff goes
/// straight back into the workspace window, which is the only place it means anything.
pub fn handle_link(app: &AppHandle, link: &str) {
    match parse_link(link) {
        Some(Link::Setup(args)) => {
            *app.state::<crate::state::AppState>().pending.lock().unwrap() = Some(*args);
            show_launcher(app);
            let _ = tauri::Emitter::emit(app, "desktop://pending-setup", ());
        }
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
