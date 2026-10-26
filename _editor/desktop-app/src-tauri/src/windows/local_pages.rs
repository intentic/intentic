use super::bounds::{opening_bounds, place_in_work_area, work_area};
use super::chrome::{announce_frame, arm_frame_fallback, forget_chrome};
use super::close::quit_with_last_window;
use super::hosted::open_in_browser;
use super::mode::{face_background, look_init_script, settle_face_background};
use super::scripts::{update_told, workspace_init_script, BROWSER_ARGS};
use super::unsaved::{ask_here, ask_page, forget_unsaved, page_started, CloseTurn, UNSAVED};
use super::{raise, swap_in, Keyboard, HOME};
use crate::setup_link::Source;
use crate::state::AppState;
use std::time::Instant;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, LogicalSize, Manager, Url, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

/* A WINDOW ON A FOLDER OF THE USER'S OWN DISK (local.rs). */

/// Where a local window may navigate in place: the app's own bundle (whichever scheme this platform serves it
/// under, or the dev server's), and the loopback editor ONLYOFFICE frames. Anything else leaves for the browser.
fn stays_in_files_window(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost" | "localhost" | "127.0.0.1")
        ),
        _ => false,
    }
}

/// How a folder's or a document's window comes up: on screen for the grant it was built for, or hidden as the spare the
/// next open wears (local.rs, the warm window: a page that has already loaded the editor and waits for its face). The
/// main window is not one of these: it is a face of the frame ([`show_home_face`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilesWindow {
    Shown,
    Spare,
}

/// What every page of the app's own bundle on a folder has in common, the main window's and each folder's or
/// document's window: the local face of `files/local`, told who it is by `init` (`__INTENTIC_LOCAL__`, local.rs) before
/// any of its script runs, its own dark under it, and its links kept to the bundle. One chain for two builders, as
/// [`hosted_page`] is.
macro_rules! local_page {
    ($builder:expr, $app:expr, $label:expr, $init:expr) => {{
        let app: &AppHandle = $app;
        let label: &str = $label;
        let state = app.state::<AppState>();
        $builder
            .background_color(face_background(state.ui_mode()))
            // Drops land in the page: the explorer copies a dragged file into the folder, as the workspace does.
            .disable_drag_drop_handler()
            .additional_browser_args(BROWSER_ARGS)
            // No update: a local window draws no update banner (`update_told`).
            .initialization_script(workspace_init_script(
                &state.install_id(),
                update_told(&crate::update::stage(app), true),
                false,
            ))
            // The look the reader was last seen in, as every hosted page is handed it (`hosted_page`).
            .initialization_script(look_init_script(state.ui_look()))
            .initialization_script($init)
            // A page starting over has no unsaved changes yet: it says again what it holds once it mounts, and until
            // then nothing of the page before it may hold a close. And whether a spare's page has loaded, so only one
            // that has is worn: a face evaluated into a page still navigating lands in the document it is leaving
            // (local.rs `take_spare`).
            .on_page_load({
                let app = app.clone();
                move |page, payload| match payload.event() {
                    PageLoadEvent::Started => page_started(page.label()),
                    PageLoadEvent::Finished => {
                        crate::launch::reached(crate::launch::Stage::Shown);
                        crate::local::page_loaded(&app, page.label())
                    }
                }
            })
            .on_navigation({
                let app = app.clone();
                let label = label.to_string();
                move |url| {
                    if url.scheme() == "intentic" {
                        let app = app.clone();
                        let label = label.clone();
                        let link = url.to_string();
                        tauri::async_runtime::spawn(async move {
                            crate::handle_intentic_link(
                                &app,
                                &link,
                                Source::Files { window: &label },
                            );
                        });
                        return false;
                    }
                    if stays_in_files_window(url) {
                        return true;
                    }
                    open_in_browser(&app, url.as_str());
                    false
                }
            })
            .on_new_window({
                let app = app.clone();
                move |url, _features| {
                    open_in_browser(&app, url.as_str());
                    NewWindowResponse::Deny
                }
            })
    }};
}

/// Build the window that shows one grant of the sidecar ([`local_page`]), or, for a [`FilesWindow::Spare`], one told
/// who it is later by [`wear_face`]. Frameless like every page window, drawn by the same page bar. Unlike the
/// workspace it holds a capability (capabilities/local.json): the commands its shell and This device call. Its links
/// are still only `window` and `local` (setup_link.rs), and its files come from the sidecar's port.
///
/// Built hidden and placed before it is shown, as the frame is, so it never appears for a frame wherever the
/// platform's cascade put it.
pub fn show_files_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    init: &str,
    how: FilesWindow,
) -> Result<WebviewWindow, String> {
    let screen = work_area(app);
    let (size, min) = opening_bounds(screen.map(|screen| screen.size));
    let builder = local_page!(
        WebviewWindowBuilder::new(app, label, WebviewUrl::App("files/local".into())),
        app,
        label,
        init
    )
    .title(title)
    .decorations(false)
    .shadow(true)
    .inner_size(size.0, size.1)
    .min_inner_size(min.0, min.1)
    .visible(false);
    let window = builder
        .build()
        .map_err(|error| format!("the window for {title} did not open: {error}"))?;
    crate::webview_sync::watch(&window.as_ref().window());
    let handle = app.clone();
    let own = label.to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            if let Some(page) = handle.get_webview(&own) {
                announce_frame(&page, false);
            }
        }
        // Unsaved changes hold the close, whoever asked for it (the platform's ×, the page's own, Alt+F4): the
        // window comes to the front and its page asks what to do with them, answering with a confirmed close — or,
        // for a page that never takes the question, the app asks in its place (`close_turn`).
        WindowEvent::CloseRequested { api, .. } => {
            let turn = UNSAVED.lock().unwrap().close_turn(&own, Instant::now());
            if turn == CloseTurn::Close {
                quit_with_last_window(&handle, &own);
            } else {
                api.prevent_close();
                if let Some(page) = handle.get_webview(&own) {
                    match turn {
                        CloseTurn::AskPage(id) => ask_page(&handle, &page, id),
                        CloseTurn::AskHere => ask_here(&handle, &page),
                        CloseTurn::Wait | CloseTurn::Close => raise(&page),
                    }
                }
            }
        }
        // The folder stops being served the moment nothing shows it (local.rs).
        WindowEvent::Destroyed => {
            forget_chrome(&own);
            forget_unsaved(&own);
            crate::local::window_closed(&handle, &own);
        }
        _ => {}
    });
    if let Some(screen) = screen {
        place_in_work_area(&window.as_ref().window(), screen, size);
    }
    // A spare's bar is judged from when it is worn, not from when it was built: its page draws nothing until it
    // has a face, and a fallback fired meanwhile would hand it the platform's frame for no reason.
    if how == FilesWindow::Shown {
        arm_frame_fallback(app, label);
        let _ = window.show();
        let _ = window.set_focus();
        crate::webview_sync::shown(window.as_ref());
    }
    Ok(window)
}

/// The main window: the local face of the frame on `init`'s folder ([`local_page`]), added out of sight and drawn in
/// the workspace's place. Like the workspace, its × hides the frame rather than closing anything (`request_close`), so
/// nothing it holds unsaved is lost and the tray brings it back as it was.
pub fn show_home_face(
    app: &AppHandle,
    title: &str,
    init: &str,
    shown: bool,
) -> Result<Webview, String> {
    let builder = local_page!(
        WebviewBuilder::new(HOME, WebviewUrl::App("files/local".into())),
        app,
        HOME,
        init
    );
    let face = crate::frame::add_face(app, HOME, builder)
        .ok_or_else(|| format!("the window for {title} did not open"))?;
    crate::frame::set_title(app, HOME, title);
    settle_face_background(&face, app.state::<AppState>().ui_mode());
    arm_frame_fallback(app, HOME);
    // Built for work it runs out of sight (local.rs `open_home_hidden_later`), it stays where `add_face` put it.
    if shown {
        swap_in(app, HOME, Keyboard::Take);
    }
    Ok(face)
}

/// The spare becoming a window of its own (local.rs): `script` hands its page the face, and the window takes the
/// title, the frame and the place a window built for this grant would have had, and only then comes on screen.
pub fn wear_face(app: &AppHandle, window: &WebviewWindow, title: &str, script: &str) {
    let _ = window.eval(script);
    let _ = window.set_title(title);
    let screen = work_area(app);
    let (size, min) = opening_bounds(screen.map(|screen| screen.size));
    let _ = window.set_min_size(Some(LogicalSize::new(min.0, min.1)));
    let _ = window.set_size(LogicalSize::new(size.0, size.1));
    if let Some(screen) = screen {
        place_in_work_area(&window.as_ref().window(), screen, size);
    }
    arm_frame_fallback(app, window.label());
    let _ = window.show();
    let _ = window.set_focus();
    crate::webview_sync::shown(window.as_ref());
}
