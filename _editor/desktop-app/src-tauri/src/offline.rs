/* THE WORKSPACE THAT CANNOT BE REACHED — our own screen, not the browser's. */
//
// The workspace window is remote content (app.intentic.dev) in a frameless window whose title bar the page draws.
// When the page cannot be reached at all (no network in the first minutes after a restart, a DNS failure, a
// captive portal) WebView2 shows its own error page instead: "Hmmm... can't reach this page", a Refresh button,
// no title bar until the frame fallback (windows.rs `arm_frame_fallback`) gives one back, and nothing that ever
// tries again by itself. A user whose PC had just restarted for the Docker setup met it and read Intentic as broken.
//
// So a navigation of a page window that fails for a NETWORK reason is answered with `offline.html`, a page in the
// app's own bundle (public/offline.html): it says what happened in our words, keeps trying on its own, and goes
// back to the workspace the moment it answers. The window wears the platform's frame while it is there (the page
// draws no bar of its own: it is local content in a window whose capabilities are the remote page's, which are
// none), and the workspace's page takes the frame off again as it always does (`chrome_is_up`).
//
// Windows only: WebView2 says whether a navigation failed and why; Tauri does not, on any platform.
#![cfg_attr(not(windows), allow(dead_code))]

/// The page, as a page window loads it. Tauri serves the app's bundle on `http://tauri.localhost` on Windows
/// (`useHttpsScheme` is not set in tauri.conf.json, which a test pins).
pub const PAGE: &str = "http://tauri.localhost/offline.html";

/// Whether `url` is the offline page: the one local page a page window may navigate to.
pub fn is_offline_page(url: &url::Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost")
        && url.path() == "/offline.html"
}

/// The offline page's address for a navigation to `target` that failed with `status`.
pub fn page_for(target: &str, status: &str) -> String {
    let mut url = url::Url::parse(PAGE).expect("the offline page's address parses");
    url.query_pairs_mut()
        .append_pair("to", target)
        .append_pair("status", status);
    url.to_string()
}

/// The failures that mean "this computer cannot reach the page", by WebView2's name for them. Everything else
/// (a cancelled navigation, which is every link this app takes out of the window; an HTTP error, which is a page
/// the server did send) is left to the page.
pub fn unreachable(status: &str) -> bool {
    matches!(
        status,
        "cannot-connect"
            | "connection-aborted"
            | "connection-reset"
            | "disconnected"
            | "host-name-not-resolved"
            | "server-unreachable"
            | "timeout"
            | "certificate-common-name-is-incorrect"
            | "certificate-expired"
            | "certificate-is-invalid"
            | "certificate-revoked"
            | "redirect-failed"
    )
}

#[cfg(windows)]
pub fn watch(window: &tauri::WebviewWindow, app_origin: &url::Url) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::NavigationCompletedEventHandler;

    let handle = window.clone();
    let origin = app_origin.origin();
    // Whether the window is on the offline page, so a load of the workspace after it is the one that recovers.
    let away = Arc::new(AtomicBool::new(false));
    let _ = window.with_webview(move |webview| {
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
            return;
        };
        let mut token = 0i64;
        let handler = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
            };
            let mut source = windows::core::PWSTR::null();
            unsafe { sender.Source(&mut source)? };
            let source = webview2_com::take_pwstr(source);
            let Ok(url) = url::Url::parse(&source) else {
                return Ok(());
            };
            if url.origin() != origin {
                return Ok(());
            }
            let mut success = windows::core::BOOL::default();
            unsafe { args.IsSuccess(&mut success)? };
            if success.as_bool() {
                if away.swap(false, Ordering::SeqCst) {
                    // Back: what this launch could not send while it was away goes now.
                    let app = tauri::Manager::app_handle(&handle).clone();
                    tauri::async_runtime::spawn(async move { crate::launch::send_reports(&app) });
                }
                return Ok(());
            }
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
            unsafe { args.WebErrorStatus(&mut status)? };
            let status = status_name(status);
            if !unreachable(status) {
                return Ok(());
            }
            away.store(true, Ordering::SeqCst);
            crate::launch::note_unreachable(status);
            let window = handle.clone();
            let page = page_for(url.as_str(), status);
            // Off the event: navigating from inside WebView2's own callback re-enters it (the same rule as the
            // window handlers in windows.rs).
            tauri::async_runtime::spawn(async move {
                let _ = window.set_decorations(true);
                if let Ok(page) = page.parse() {
                    let _ = window.navigate(page);
                }
            });
            Ok(())
        }));
        unsafe {
            let _ = core.add_NavigationCompleted(&handler, &mut token);
        }
    });

    fn status_name(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> &'static str {
        match status {
            COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT => "cannot-connect",
            COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED => "connection-aborted",
            COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET => "connection-reset",
            COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => "disconnected",
            COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => "host-name-not-resolved",
            COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE => "server-unreachable",
            COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => "timeout",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT => {
                "certificate-common-name-is-incorrect"
            }
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED => "certificate-expired",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID => "certificate-is-invalid",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED => "certificate-revoked",
            COREWEBVIEW2_WEB_ERROR_STATUS_REDIRECT_FAILED => "redirect-failed",
            COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED => "operation-canceled",
            _ => "other",
        }
    }
}

/// Off Windows the platform's error page stays: the webview there does not say a navigation failed.
#[cfg(not(windows))]
pub fn watch(_window: &tauri::WebviewWindow, _app_origin: &url::Url) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_offline_page_is_recognised_as_it() {
        assert!(is_offline_page(&PAGE.parse().unwrap()));
        assert!(is_offline_page(
            &page_for("https://app.intentic.dev/", "timeout")
                .parse()
                .unwrap()
        ));
        assert!(!is_offline_page(
            &"http://tauri.localhost/index.html".parse().unwrap()
        ));
        assert!(!is_offline_page(
            &"https://tauri.localhost/offline.html".parse().unwrap()
        ));
        assert!(!is_offline_page(
            &"https://app.intentic.dev/offline.html".parse().unwrap()
        ));
    }

    #[test]
    fn the_page_is_told_where_to_go_back_to_and_why() {
        let page: url::Url = page_for(
            "https://app.intentic.dev/workspace?x=1&y=2",
            "host-name-not-resolved",
        )
        .parse()
        .unwrap();
        let pairs: std::collections::HashMap<_, _> = page.query_pairs().into_owned().collect();
        assert_eq!(pairs["to"], "https://app.intentic.dev/workspace?x=1&y=2");
        assert_eq!(pairs["status"], "host-name-not-resolved");
    }

    #[test]
    fn a_cancelled_navigation_or_an_http_error_is_not_offline() {
        assert!(unreachable("host-name-not-resolved"));
        assert!(unreachable("disconnected"));
        assert!(
            !unreachable("operation-canceled"),
            "every link this app takes to the browser is a cancelled navigation"
        );
        assert!(!unreachable("other"));
    }

    #[test]
    fn the_bundle_is_served_on_plain_http_on_windows() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        let windows = config["app"]["windows"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(
            windows.iter().all(|window| window.get("useHttpsScheme").is_none()),
            "PAGE is http://tauri.localhost; a window with useHttpsScheme serves the bundle on https"
        );
        assert!(
            std::path::Path::new(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../public/offline.html"
            ))
            .exists(),
            "the page this sends a window to ships in the bundle"
        );
    }
}
