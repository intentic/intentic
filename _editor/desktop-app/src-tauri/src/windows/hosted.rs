use super::chrome::{announce_frame, arm_frame_fallback, forget_chrome};
use super::mode::{face_background, look_init_script};
use super::scripts::{update_told, workspace_init_script, BROWSER_ARGS};
use super::{raise, WORKSPACE};
use crate::setup_link::Source;
use crate::state::AppState;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalSize, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

/// The label prefix of a panel the page floated into a window of its own — `floating-chat` for
/// `/floating/chat` — built when the page's `window.open` names one (`page_window`'s new-window handler) and
/// destroyed when it is closed, however it is closed. As many as the page has panels, never two of one.
const FLOATING: &str = "floating-";

/// What a floating window opens at when the page names no size (it always does, from what it remembered),
/// and the least it can be dragged to: enough for the narrowest of the three panels to stay usable.
const FLOATING_SIZE: (f64, f64) = (1024.0, 720.0);

const FLOATING_MIN: (f64, f64) = (480.0, 320.0);

/// Whether a URL should stay inside the workspace webview. Everything else — a provider's token page, docs,
/// mailto — is opened in the user's default browser instead.
fn stays_in_webview(url: &Url, app_origin: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => url.origin() == app_origin.origin(),
        // intentic:// is handled before this is called.
        "about" | "blob" | "data" | "javascript" => true,
        _ => false,
    }
}

/// Open a link in the default browser, off the webview thread. The workspace webview has no IPC surface, so
/// this is the only way out for a link that leaves the app.
///
/// What arrives here is a navigation or a `window.open`, NEVER a `target="_blank"` press: WebView2 raises its
/// new-window event for `window.open` and for a named target, and for `_blank` raises nothing at all, so that
/// press dies inside the webview. The page re-issues those as `window.open` before they are lost (`_editor/web`,
/// `environments/desktop.ts` `installDesktopLinks`), which is why every `target="_blank"` in the app reaches
/// this function at all.
pub(super) fn open_in_browser(app: &AppHandle, url: &str) {
    let app = app.clone();
    let url = url.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = app.opener().open_url(&url, None::<&str>) {
            eprintln!("could not open link in browser: {url} ({error})");
        }
    });
}

/// The origin the page is served from, which is also the one origin whose links stay inside a page window.
pub(super) fn app_origin(state: &AppState) -> Url {
    state.app_url().parse().unwrap_or_else(|_| {
        crate::state::APP_URL
            .parse()
            .expect("static app url parses")
    })
}

/* EVERY PAGE OF THE HOSTED EDITOR IS BUILT HERE — the workspace face, and each panel of it floating on its own. */

/// What the workspace and a floating panel have in common, which is everything but their window: the page's own dark
/// under it, the browser arguments, the page told what window it is in, and the same answer for every link out of it.
/// One chain for two builders, since the workspace is a webview in the frame ([`page_webview`]) and a floating panel a
/// window of its own ([`page_window`]), and Tauri's two builders share their methods but no trait.
macro_rules! hosted_page {
    ($builder:expr, $app:expr, $label:expr) => {{
        let app: &AppHandle = $app;
        let label: &str = $label;
        let state = app.state::<AppState>();
        let origin = app_origin(&state);
        let install_id = state.install_id();
        $builder
            // The frame between "window mapped" and the REMOTE page's first paint, which is white by default and is
            // longest on the launch that has no HTTP cache to open from. The two local faces have always had this;
            // the windows that wait on a network were the ones without it. In the scheme the page was last seen in,
            // never a fixed one: this window used to open on near-black under a reader who had chosen daylight.
            .background_color(face_background(state.ui_mode()))
            // Windows uses either Tauri drag-drop or HTML5 drag-drop, never both.
            .disable_drag_drop_handler()
            // The windows this is actually for — see BROWSER_ARGS, and `loopbackUngated` in the init script, which
            // tells the page it was done.
            .additional_browser_args(BROWSER_ARGS)
            .initialization_script(workspace_init_script(
                &install_id,
                update_told(&crate::update::stage(app), false),
                label == WORKSPACE,
            ))
            // The look the reader was last seen in, on whichever of the app's pages: this origin's storage is not
            // theirs, and a first sandbox opened in a profile's daylight under a reader the app had just shown sanctum.
            .initialization_script(look_init_script(state.ui_look()))
            .on_navigation({
                let app = app.clone();
                let label = label.to_string();
                let origin = origin.clone();
                move |url| {
                    if url.scheme() == "intentic" {
                        // Handle off the navigation callback — creating a window inside the webview's navigation
                        // event would re-enter the webview (WebView2 COM re-entrancy).
                        let app = app.clone();
                        let label = label.clone();
                        let link = url.to_string();
                        tauri::async_runtime::spawn(async move {
                            // The one direction that is this app's own window navigating — the SPA's button.
                            crate::handle_intentic_link(&app, &link, Source::App { window: &label });
                        });
                        return false;
                    }
                    // The app's own page for a workspace that cannot be reached (offline.rs), which sends the window here,
                    // and its own copy of the editor on this computer's sandboxes (machine_face.rs), which it offers.
                    if stays_in_webview(url, &origin)
                        || crate::offline::is_offline_page(url)
                        || crate::machine_face::is_face_page(url)
                    {
                        return true;
                    }
                    open_in_browser(&app, url.as_str());
                    false
                }
            })
            // Something on screen: this launch has reached the reader, even if what it shows is an error.
            .on_page_load(|_, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    crate::launch::reached(crate::launch::Stage::Shown);
                }
            })
            // A `window.open`: the page floating one of its own panels gets a window of this app's (its browser
            // popup, done natively); anything else opened this way leaves for the browser. Denied either way — the
            // window the page gets is built by this app, off the callback, for the same re-entrancy reason as above.
            .on_new_window({
                let app = app.clone();
                move |url, features| {
                    match floating_panel(&url, &origin) {
                        Some(panel) => {
                            let app = app.clone();
                            let size = features.size();
                            let position = features.position();
                            tauri::async_runtime::spawn(async move {
                                show_floating(&app, &panel, url, size, position);
                            });
                        }
                        None => open_in_browser(&app, url.as_str()),
                    }
                    NewWindowResponse::Deny
                }
            })
    }};
}

/// The workspace face's webview, added to the frame (frame.rs `add_face`), whose window draws no platform title bar.
pub(super) fn page_webview(app: &AppHandle, label: &str, url: Url) -> WebviewBuilder<tauri::Wry> {
    hosted_page!(
        WebviewBuilder::new(label, WebviewUrl::External(url)),
        app,
        label
    )
}

/// A floating panel's window.
fn page_window<'a>(
    app: &'a AppHandle,
    label: &str,
    url: Url,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    hosted_page!(
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(url)),
        app,
        label
    )
    .title("Intentic")
    /* NO PLATFORM TITLE BAR ON ANY WINDOW OF THE PAGE — see [`WindowVerb`] for the bar the page draws in its place. */
    .decorations(false)
    .shadow(true)
}

/* A PANEL IN A WINDOW OF ITS OWN. */

/// The panel a `window.open` names, when it is the page floating one of its own panels: `/floating/<panel>`
/// under the app's origin (and under its path, where the page is served under one). Anything else — another
/// origin, a page of the app opened "in a new tab" — is not one, and goes to the browser as it always has.
fn floating_panel(url: &Url, app_origin: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") || url.origin() != app_origin.origin() {
        return None;
    }
    let panel = url
        .path()
        .strip_prefix(app_origin.path().trim_end_matches('/'))?
        .strip_prefix("/floating/")?;
    // One lowercase word: the route's own regex admits exactly that, and the label is built from it.
    (!panel.is_empty() && panel.bytes().all(|byte| byte.is_ascii_lowercase()))
        .then(|| panel.to_string())
}

fn floating_label(panel: &str) -> String {
    format!("{FLOATING}{panel}")
}

/// "Intentic · Chat": what the taskbar and alt-tab call the window, since a frameless window has no bar of its
/// own to read the page's `document.title` off.
fn floating_title(panel: &str) -> String {
    let mut letters = panel.chars();
    match letters.next() {
        Some(first) => format!(
            "Intentic · {}{}",
            first.to_ascii_uppercase(),
            letters.as_str()
        ),
        None => "Intentic".to_string(),
    }
}

/// Raise the floating window for `panel`, building it if there is none: the page never asks twice while one
/// is up (it raises the one it can see instead), so a second ask is a page that lost sight of it. Size and
/// position are what the page put in `window.open`'s features — the frame it remembered for that panel.
fn show_floating(
    app: &AppHandle,
    panel: &str,
    url: Url,
    size: Option<LogicalSize<f64>>,
    position: Option<tauri::LogicalPosition<f64>>,
) {
    let label = floating_label(panel);
    if let Some(window) = app.get_webview_window(&label) {
        raise(window.as_ref());
        return;
    }
    let size = size.unwrap_or_else(|| LogicalSize::new(FLOATING_SIZE.0, FLOATING_SIZE.1));
    let mut builder = page_window(app, &label, url)
        .title(floating_title(panel))
        .inner_size(size.width, size.height)
        .min_inner_size(FLOATING_MIN.0, FLOATING_MIN.1);
    builder = match position {
        Some(position) => builder.position(position.x, position.y),
        None => builder.center(),
    };
    match builder.build() {
        Ok(window) => {
            crate::webview_sync::watch(&window.as_ref().window());
            crate::shown::watch(&window.as_ref().window());
            // A page that cannot be reached gets the app's own screen, not the browser's (offline.rs).
            crate::offline::watch(window.as_ref(), &app_origin(&app.state::<AppState>()));
            // A big drop on the explorer, copied into a sandbox on this computer by the app (drop_copy.rs).
            crate::drop_copy::watch(window.as_ref(), &app_origin(&app.state::<AppState>()));
            let handle = app.clone();
            let own = label.clone();
            window.on_window_event(move |event| match event {
                /* WHAT THE PAGE'S MAXIMISE BUTTON DRAWS FOLLOWS THE WINDOW, NOT THE PRESS. */
                WindowEvent::Resized(_) => {
                    if let Some(page) = handle.get_webview(&own) {
                        announce_frame(&page, false);
                    }
                }
                // Closing IS docking: the page in it stops announcing its claim and the workspace draws the
                // panel again (the SPA's floating.ts). Nothing is asked and nothing is hidden — a panel is
                // reopened by popping it out again, not from the tray.
                WindowEvent::Destroyed => forget_chrome(&own),
                _ => {}
            });
            arm_frame_fallback(app, &label);
            let _ = window.set_focus();
        }
        Err(error) => eprintln!("floating window for {panel} failed to open: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(url: &str) -> Url {
        url.parse().unwrap()
    }

    #[test]
    fn same_origin_http_stays_in_the_webview() {
        let app = origin("https://app.intentic.dev");
        assert!(stays_in_webview(
            &origin("https://app.intentic.dev/capabilities/github"),
            &app
        ));
    }

    #[test]
    fn a_provider_token_page_leaves_the_webview() {
        let app = origin("https://app.intentic.dev");
        assert!(!stays_in_webview(
            &origin("https://github.com/settings/tokens/new"),
            &app
        ));
    }

    #[test]
    fn localhost_dev_origin_matches_itself() {
        let app = origin("http://localhost:47146");
        assert!(stays_in_webview(
            &origin("http://localhost:47146/capabilities/github"),
            &app
        ));
        assert!(!stays_in_webview(
            &origin("https://github.com/settings/tokens/new"),
            &app
        ));
    }

    #[test]
    fn mailto_leaves_the_webview() {
        let app = origin("https://app.intentic.dev");
        assert!(!stays_in_webview(
            &origin("mailto:support@intentic.dev"),
            &app
        ));
    }

    /* THE ONE `window.open` THAT GETS A WINDOW OF THIS APP'S: the page floating a panel of its own. */
    #[test]
    fn a_panel_of_the_page_floats_into_a_window_of_this_app() {
        let app = origin("https://app.intentic.dev");
        assert_eq!(
            floating_panel(&origin("https://app.intentic.dev/floating/chat"), &app).as_deref(),
            Some("chat")
        );
        assert_eq!(
            floating_panel(
                &origin("http://localhost:47146/floating/terminal"),
                &origin("http://localhost:47146")
            )
            .as_deref(),
            Some("terminal")
        );
        // Served under a path, the panel is under that path too.
        assert_eq!(
            floating_panel(
                &origin("https://example.dev/app/floating/browsers"),
                &origin("https://example.dev/app/")
            )
            .as_deref(),
            Some("browsers")
        );
    }

    #[test]
    fn every_other_new_window_is_the_browsers() {
        let app = origin("https://app.intentic.dev");
        for url in [
            // A page of the app opened "in a new tab" is still a tab, not a panel.
            "https://app.intentic.dev/agents",
            "https://app.intentic.dev/floating/",
            "https://app.intentic.dev/floating/chat/extra",
            "https://app.intentic.dev/floating/Chat",
            "https://app.intentic.dev/floating/chat-2",
            // The same path on somebody else's origin is somebody else's page.
            "https://evil.example/floating/chat",
            "http://app.intentic.dev/floating/chat",
            "https://app.intentic.dev/app/floating/chat",
        ] {
            assert_eq!(floating_panel(&origin(url), &app), None, "{url}");
        }
    }

    #[test]
    fn a_floating_window_is_labelled_and_titled_after_its_panel() {
        assert_eq!(floating_label("chat"), "floating-chat");
        assert_eq!(floating_title("chat"), "Intentic · Chat");
        assert_eq!(floating_title("browsers"), "Intentic · Browsers");
    }
}
