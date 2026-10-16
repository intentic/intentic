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
// Tauri says on no platform whether a navigation failed, so each is asked through its own webview: WebView2's
// NavigationCompleted on Windows, WebKitGTK's `load-failed` on Linux (2026-10-16). On Linux, and so on Intentic OS,
// whose whole screen this window is, the internet being out is not the end of the road either: the sandboxes on this
// computer still run, and the app's own copy of the editor opens them (machine_face.rs). There a window that cannot
// reach its page goes to that face, or to this page (which offers it) on a computer that hosts none.

/// The page, as a page window loads it. Tauri serves the app's bundle on `http://tauri.localhost` on Windows
/// (`useHttpsScheme` is not set in tauri.conf.json, which a test pins) and on `tauri://localhost` elsewhere.
#[cfg(windows)]
pub const PAGE: &str = "http://tauri.localhost/offline.html";
#[cfg(not(windows))]
pub const PAGE: &str = "tauri://localhost/offline.html";

/// Whether `url` is the offline page: the one local page a page window may navigate to besides the sandbox face.
pub fn is_offline_page(url: &url::Url) -> bool {
    let Ok(page) = url::Url::parse(PAGE) else {
        return false;
    };
    url.scheme() == page.scheme() && url.host_str() == page.host_str() && url.path() == page.path()
}

/// The offline page's address for a navigation to `target` that failed with `status`. It offers this computer's own
/// sandboxes (`face`, the bundled editor's address) where the face is built for this platform.
pub fn page_for(target: &str, status: &str) -> String {
    let mut url = url::Url::parse(PAGE).expect("the offline page's address parses");
    url.query_pairs_mut()
        .append_pair("to", target)
        .append_pair("status", status)
        .append_pair("face", crate::machine_face::FACE_URL);
    url.to_string()
}

/// The failures that mean "this computer cannot reach the page", by WebView2's name for them. Everything else
/// (a cancelled navigation, which is every link this app takes out of the window; an HTTP error, which is a page
/// the server did send) is left to the page.
#[cfg_attr(not(windows), allow(dead_code))] // WebView2's names; WebKitGTK says it with its error domains
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

/// A WebKitGTK load error that means "this computer cannot reach the page". A cancelled load (every link this app
/// takes out of the window) and a policy refusal (a navigation the window handler turned down) are not; everything else
/// that fails a load (a name that does not resolve, a refused or reset connection, a timeout) is. Pure.
#[cfg(target_os = "linux")]
fn unreachable_on_webkit(error: &webkit2gtk::glib::Error) -> bool {
    !error.matches(webkit2gtk::NetworkError::Cancelled)
        && error.kind::<webkit2gtk::PolicyError>().is_none()
}

/// Linux: a load of the page that fails for a network reason sends the window to this computer's sandboxes (or to the
/// offline page, on a computer that hosts none: machine_face.rs `fallback_for`), and so does a quick probe at the start,
/// so a name that takes WebKit half a minute to give up on is not half a minute of a blank screen. The probe never moves
/// a page that has started showing: only a load that has not committed by the time it answers is replaced.
#[cfg(target_os = "linux")]
pub fn watch(window: &tauri::WebviewWindow, app_origin: &url::Url) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use webkit2gtk::{LoadEvent, WebViewExt};

    let origin = app_origin.origin();
    // Whether a page of the workspace's origin has started showing in this window.
    let shown = Arc::new(AtomicBool::new(false));
    let handle = window.clone();
    let seen = shown.clone();
    let _ = window.with_webview(move |webview| {
        let webview = webview.inner();
        let ours = origin.clone();
        webview.connect_load_changed(move |view, event| {
            let at = view.uri().and_then(|uri| url::Url::parse(&uri).ok());
            if event == LoadEvent::Committed && at.is_some_and(|url| url.origin() == ours) {
                seen.store(true, Ordering::SeqCst);
            }
        });
        webview.connect_load_failed(move |_view, _event, failing, error| {
            let Ok(url) = url::Url::parse(failing) else {
                return false;
            };
            if url.origin() != origin || !unreachable_on_webkit(error) {
                return false;
            }
            crate::launch::note_unreachable("load-failed");
            leave_for_fallback(&handle, url.as_str(), "load-failed");
            // Handled: WebKitGTK draws no error page of its own under the one this is navigating to.
            true
        });
    });
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let app = tauri::Manager::app_handle(&window).clone();
        let target = tauri::Manager::state::<crate::state::AppState>(&app).app_url();
        if crate::machine_face::answers(&target, crate::machine_face::PROBE_LIMIT).await
            || shown.load(Ordering::SeqCst)
        {
            return;
        }
        crate::launch::note_unreachable("probe-failed");
        leave_for_fallback(&window, &target, "unreachable");
    });
}

/// Where a workspace window that could not reach its page goes, off the event that said so: navigating from inside
/// WebKitGTK's own signal re-enters it (the same rule as WebView2's callback above).
#[cfg(target_os = "linux")]
fn leave_for_fallback(window: &tauri::WebviewWindow, target: &str, status: &str) {
    let app = tauri::Manager::app_handle(window).clone();
    let hosts = tauri::Manager::state::<crate::state::AppState>(&app).hosts_sandboxes();
    let page = crate::machine_face::fallback_for(hosts, target, status);
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(page) = page.parse() {
            let _ = window.navigate(page);
        }
    });
}

/// Elsewhere the platform's error page stays: the webview there does not say a navigation failed.
#[cfg(not(any(windows, target_os = "linux")))]
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
            &PAGE.replace("offline.html", "index.html").parse().unwrap()
        ));
        assert!(!is_offline_page(
            &"https://tauri.localhost/offline.html".parse().unwrap()
        ));
        assert!(!is_offline_page(
            &"https://app.intentic.dev/offline.html".parse().unwrap()
        ));
    }

    #[test]
    fn the_page_offers_this_computers_sandboxes_by_the_faces_own_address() {
        let page: url::Url = page_for("https://app.intentic.dev/", "timeout")
            .parse()
            .unwrap();
        let pairs: std::collections::HashMap<_, _> = page.query_pairs().into_owned().collect();
        assert_eq!(pairs["face"], crate::machine_face::FACE_URL);
        // Compared by scheme and host: `tauri://` is not a special scheme, so its origins are opaque and never equal.
        let (face, page) = (
            url::Url::parse(&pairs["face"]).unwrap(),
            url::Url::parse(PAGE).unwrap(),
        );
        assert_eq!(
            (face.scheme(), face.host_str()),
            (page.scheme(), page.host_str()),
            "the face is the offline page's own bundle, so its button is a same-origin navigation"
        );
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
