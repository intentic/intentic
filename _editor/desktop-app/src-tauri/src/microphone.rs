/* THE MICROPHONE, FOR THE WORKSPACE'S OWN PAGE AND NOTHING ELSE (2026-10-13).
 *
 * The workspace's page can listen for its wake word ("Leon") and do everything about it itself: the microphone through
 * getUserMedia, the transcription in an AudioWorklet (wake.rs has the rest). What the page cannot do is answer the
 * webview's question about the microphone. WebView2 asks the reader in a prompt of its own, once per origin, over a
 * window that is often hidden in the tray, where nobody answers it; WebKitGTK refuses every such request outright unless
 * the app answers it. So the app answers, for the workspace face alone (windows.rs `build_workspace`): yes to the
 * microphone, asked by a page of the app's own origin, and nothing said about anything else, which leaves every other
 * request (the camera, the screen, a frame of another origin, a floating panel's or a local window's request) to the
 * webview's own default: WebView2's prompt, WebKitGTK's no.
 *
 * Tauri 2.11 has no hook of its own for this on either system, so each is reached through its webview (`with_webview`),
 * as offline.rs reaches WebView2's navigation event. */
#![cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]

/// Whether a request is the one the app grants: the microphone alone (`audio`, with no camera and no screen beside it,
/// `sight`), asked by a page at `page` whose origin is the app's. Pure, and the same rule on both systems.
pub fn granted(audio: bool, sight: bool, page: &str, origin: &url::Origin) -> bool {
    audio && !sight && url::Url::parse(page).is_ok_and(|page| page.origin() == *origin)
}

/// WebView2 raises PermissionRequested before it would prompt. A microphone asked for by the app's own origin is
/// allowed there and then, for this request alone (`SavesInProfile` off: the profile is shared with every window of the
/// app, and a grant kept in it would answer a floating panel of the same origin too), and marked handled so no later
/// handler revisits it. Everything else is left untouched, so the prompt WebView2 would have shown still shows.
#[cfg(windows)]
pub fn allow(window: &tauri::WebviewWindow, app_origin: &url::Url) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::PermissionRequestedEventHandler;
    use windows::core::Interface;

    let origin = app_origin.origin();
    let _ = window.with_webview(move |webview| {
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
            return;
        };
        let mut token = 0i64;
        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            unsafe { args.PermissionKind(&mut kind)? };
            let mut uri = windows::core::PWSTR::null();
            unsafe { args.Uri(&mut uri)? };
            let uri = webview2_com::take_pwstr(uri);
            if !granted(
                kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                false,
                &uri,
                &origin,
            ) {
                return Ok(());
            }
            unsafe {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                // Both are later versions of the event's arguments; a runtime without them still has the grant above.
                if let Ok(args) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    let _ = args.SetSavesInProfile(false);
                }
                if let Ok(args) = args.cast::<ICoreWebView2PermissionRequestedEventArgs2>() {
                    let _ = args.SetHandled(true);
                }
            }
            Ok(())
        }));
        unsafe {
            let _ = core.add_PermissionRequested(&handler, &mut token);
        }
    });
}

/// WebKitGTK exposes `navigator.mediaDevices` only with its media stream setting on (off by default), and refuses every
/// permission request nobody handles. The setting is turned on for this webview alone, and its `permission-request`
/// signal answers yes to a request for a microphone alone (not a camera, not the screen) while the page is the app's;
/// anything else returns unhandled, to WebKitGTK's own refusal.
///
/// The setting lands before the page can read it: the window's first load was sent to the web process as it was built,
/// this change is sent after it on the same connection, and the document that reads it is made only once the network
/// has answered that load.
#[cfg(target_os = "linux")]
pub fn allow(window: &tauri::WebviewWindow, app_origin: &url::Url) {
    use webkit2gtk::glib::prelude::*;
    use webkit2gtk::{
        PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };

    let origin = app_origin.origin();
    let _ = window.with_webview(move |webview| {
        let webview = webview.inner();
        if let Some(settings) = WebViewExt::settings(&webview) {
            settings.set_enable_media_stream(true);
            // wry turns this on for every webview; said here too, since the wake word needs it.
            if !settings.enables_webaudio() {
                settings.set_enable_webaudio(true);
            }
        }
        webview.connect_permission_request(move |view, request| {
            let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                return false;
            };
            // SAFETY: a plain getter on the request this signal is delivering, alive for the length of the call. The
            // crate binds no method for it; WebKitGTK has had it since 2.34, and Tauri already builds against 2.40.
            let screen = unsafe {
                webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(media.as_ptr())
            } != 0;
            let page = view.uri().map(|uri| uri.to_string()).unwrap_or_default();
            if !granted(
                media.is_for_audio_device(),
                media.is_for_video_device() || screen,
                &page,
                &origin,
            ) {
                return false;
            }
            media.allow();
            true
        });
    });
}

/// Nowhere else does this app build.
#[cfg(not(any(windows, target_os = "linux")))]
pub fn allow(_window: &tauri::WebviewWindow, _app_origin: &url::Url) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(url: &str) -> url::Origin {
        url::Url::parse(url).unwrap().origin()
    }

    #[test]
    fn the_workspace_page_gets_the_microphone() {
        let app = origin("https://app.intentic.dev");
        assert!(granted(
            true,
            false,
            "https://app.intentic.dev/?sandbox=abc",
            &app
        ));
        // A development origin is its own app origin.
        assert!(granted(
            true,
            false,
            "http://localhost:5173/workspace",
            &origin("http://localhost:5173")
        ));
    }

    /// The camera and the screen are never the app's to give, even to its own page, nor is the microphone to any other
    /// origin: another host, another port, another scheme, a frame of somebody else's, or no page at all.
    #[test]
    fn nothing_else_and_nobody_else_gets_anything() {
        let app = origin("https://app.intentic.dev");
        assert!(!granted(true, true, "https://app.intentic.dev/", &app));
        assert!(!granted(false, true, "https://app.intentic.dev/", &app));
        assert!(!granted(false, false, "https://app.intentic.dev/", &app));
        for page in [
            "https://evil.example/",
            "https://app.intentic.dev.evil.example/",
            "http://app.intentic.dev/",
            "https://app.intentic.dev:8443/",
            "http://tauri.localhost/offline.html",
            "about:blank",
            "",
        ] {
            assert!(!granted(true, false, page, &app), "{page}");
        }
    }
}
