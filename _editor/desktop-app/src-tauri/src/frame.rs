use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalPosition, Manager, Webview, Window, WindowEvent, Wry};

use crate::state::AppState;
use crate::windows::{HOME, WORKSPACE};

/* Hosted and local faces share one native frame, taskbar button and geometry; create each webview lazily and switch visibility.
 * Windows hides the child HWND while leaving WebView2's controller visible to avoid its tiny-viewport bug (webview_sync.rs).
 * Linux packs both in the frame but excludes hidden faces from GTK show_all.
 * Added child webviews lack Tauri's resize borders, so attach/raise them explicitly on Windows and install the handler on Linux. */

/// The native window both faces are drawn in. Never a page's label: capabilities name webviews (capabilities/*.json),
/// so nothing is granted to the frame as such.
pub const FRAME: &str = "frame";

/// The faces, by the label of their webview.
const FACES: [&str; 2] = [WORKSPACE, HOME];

/// The face the frame draws. Set by [`show`] alone; a face added to the frame is out of sight until it is shown.
static SHOWN: Mutex<Option<&'static str>> = Mutex::new(None);

/// What the taskbar and alt-tab call the frame while each face is drawn: the frame wears the title of the face it shows.
static TITLES: LazyLock<Mutex<HashMap<&'static str, String>>> = LazyLock::new(Mutex::default);

/// The face `label` names, as the constant the frame keeps.
pub fn face_label(label: &str) -> Option<&'static str> {
    FACES.into_iter().find(|face| *face == label)
}

/// Whether `label` is one of the two faces rather than a window of its own (a folder's, a floating panel's).
pub fn is_face(label: &str) -> bool {
    face_label(label).is_some()
}

pub fn frame(app: &AppHandle) -> Option<Window> {
    app.get_window(FRAME)
}

/// The face's webview, once it has been added to the frame.
pub fn face(app: &AppHandle, label: &str) -> Option<Webview> {
    face_label(label).and_then(|label| app.get_webview(label))
}

/// Every face added so far.
pub fn faces(app: &AppHandle) -> Vec<Webview> {
    FACES
        .into_iter()
        .filter_map(|label| app.get_webview(label))
        .collect()
}

/// The face the frame draws, whether or not the frame is on screen.
pub fn shown() -> Option<&'static str> {
    *SHOWN.lock().unwrap()
}

/// Whether `webview` is what its window draws: the face the frame shows, and any window's only page. A face the frame
/// is not showing is out of sight whatever the frame is doing.
pub fn drawn(webview: &Webview) -> bool {
    drawn_label(webview.label(), shown())
}

/// [`drawn`], for a page labelled `label` while the frame shows `shown`. Pure.
fn drawn_label(label: &str, shown: Option<&str>) -> bool {
    !is_face(label) || shown == Some(label)
}

/// Whether the frame is where the reader can see it: shown, and not minimised to the taskbar.
pub fn on_screen(app: &AppHandle) -> bool {
    frame(app).is_some_and(|frame| crate::windows::bounds::window_on_screen(&frame))
}

/// `work` run on the main thread, and its answer: at once on that thread, waited for from any other. Building and
/// swapping the faces happens there, so two asks for one face cannot both build it, and nothing between showing one
/// face and hiding the other is ever drawn.
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Option<T> {
    let (tell, heard) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tell.send(work(&handle));
    })
    .ok()?;
    heard.recv().ok()
}

/* THE FRAME ITSELF. */

/// The frame, built the first time a face is wanted: hidden, placed for a cold start, with no face in it yet.
fn ensure(app: &AppHandle) -> Option<Window> {
    if let Some(frame) = frame(app) {
        return Some(frame);
    }
    on_main(app, |app| frame(app).or_else(|| build(app))).flatten()
}

fn build(app: &AppHandle) -> Option<Window> {
    let mode = app.state::<AppState>().ui_mode();
    let screen = crate::windows::bounds::work_area(app);
    let (size, min) = crate::windows::bounds::opening_bounds(screen.map(|screen| screen.size));
    let built = WindowBuilder::new(app, FRAME)
        .title("Intentic")
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        // No platform title bar: each face's page draws the bar (windows.rs `WindowVerb`), and the frame gets the
        // platform's back only while the face it shows has none (windows.rs `fit_decorations`).
        .decorations(false)
        .shadow(true)
        // What shows before the first face has painted, in the light that face will paint in.
        .background_color(crate::windows::mode::face_background(mode))
        // Shown with the first face (`show`), placed first, so it never appears where the platform cascaded it.
        .visible(false)
        .build();
    let frame = match built {
        Ok(frame) => frame,
        Err(error) => {
            eprintln!("the app's window failed to open: {error}");
            return None;
        }
    };
    // On Windows this is what attaches the resize borders of a frameless window, which Tauri does by itself only for a
    // window built with its webview (tauri-runtime-wry's `undecorated_resizing`).
    let _ = frame.set_resizable(true);
    crate::windows::mode::settle_background(&frame, mode);
    watch(app, &frame);
    if let Some(screen) = screen {
        crate::windows::bounds::place_in_work_area(&frame, screen, size);
    }
    Some(frame)
}

/// What the frame does about what happens to it, for whichever face it draws.
fn watch(app: &AppHandle, frame: &Window) {
    crate::webview_sync::watch(frame);
    crate::shown::watch(frame);
    let handle = app.clone();
    frame.on_window_event(move |event| match event {
        // The × is a question, not an exit, whichever face it was pressed over (windows.rs `request_close`). Answered
        // either way, the frame is hidden rather than destroyed, so the tray brings it back as it was and the workspace
        // keeps the session it signed in with.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            crate::windows::close::request_close(&handle);
        }
        /* WHAT THE PAGE'S MAXIMISE BUTTON DRAWS FOLLOWS THE WINDOW, NOT THE PRESS — in both faces, so the hidden one
        is right when it comes back. */
        WindowEvent::Resized(_) => {
            for face in faces(&handle) {
                crate::windows::chrome::announce_frame(&face, false);
            }
        }
        _ => {}
    });
}

/* THE FACES IN IT. */

/// Add the face `label` to the frame, out of sight: built from `builder`, filling the frame and following its size.
/// The face already there when another ask built it first.
pub fn add_face(
    app: &AppHandle,
    label: &'static str,
    builder: WebviewBuilder<Wry>,
) -> Option<Webview> {
    let frame = ensure(app)?;
    let holder = frame.clone();
    let added = on_main(app, move |app| {
        if let Some(face) = app.get_webview(label) {
            return Ok(face);
        }
        let size = holder
            .inner_size()?
            .to_logical::<f64>(holder.scale_factor()?);
        // Built just below the frame's client area, where nothing of it can be seen while WebView2 makes its
        // controller (a wait during which the frame still paints), then hidden and moved into place. Its size is
        // the frame's from the start, so its page lays out for the frame it will be shown in.
        let face = holder.add_child(
            builder.auto_resize().focused(false),
            LogicalPosition::new(0.0, size.height),
            size,
        )?;
        step_aside(&face);
        face.set_position(LogicalPosition::new(0.0, 0.0))?;
        Ok::<_, tauri::Error>(face)
    })?;
    match added {
        Ok(face) => {
            borders(&frame, &face);
            Some(face)
        }
        Err(error) => {
            eprintln!("the {label} face failed to open: {error}");
            None
        }
    }
}

/// Draw the face `label` in the frame and put the other out of sight, then the frame on screen, out of the taskbar,
/// and with the keyboard: a reader's press asked for it (windows/present.rs), and nothing else may. The face, when
/// there is one to show.
pub fn show(
    app: &AppHandle,
    label: &'static str,
    _press: crate::windows::present::Press,
) -> Option<Webview> {
    let frame = frame(app)?;
    let face = face(app, label)?;
    let others: Vec<Webview> = faces(app)
        .into_iter()
        .filter(|other| other.label() != label)
        .collect();
    let title = TITLES.lock().unwrap().get(label).cloned();
    let (shown_face, held) = (face.clone(), frame.clone());
    on_main(app, move |_| {
        *SHOWN.lock().unwrap() = Some(label);
        // The one coming up first and the other after, in one turn of the main thread: nothing is drawn in between.
        come_forward(&shown_face);
        for other in &others {
            step_aside(other);
        }
        if let Some(title) = title {
            let _ = held.set_title(&title);
        }
        // In kiosk mode sway tiles the frame below the system bar. Fullscreen would hide that bar.
        if crate::os::kiosk() {
            let _ = held.set_fullscreen(false);
        }
        // Out of the taskbar first: `show` does nothing to a window Windows already counts as visible, and `set_focus`
        // nothing to a minimised one (2026-10-12).
        let _ = held.unminimize();
        let _ = held.show();
        let _ = held.set_focus();
        let _ = shown_face.set_focus();
    })?;
    crate::webview_sync::shown(&face);
    for each in faces(app) {
        crate::shown::tell(&each, false);
    }
    crate::shell::face_shown(&frame);
    Some(face)
}

/// The frame to the tray, with both faces in it as they are.
pub fn hide(app: &AppHandle) {
    let Some(frame) = frame(app) else {
        return;
    };
    let _ = frame.hide();
    for face in faces(app) {
        crate::shown::tell(&face, false);
    }
}

/// What the frame is called while the face `label` is drawn: the folder of the main window ("<folder> · Intentic",
/// local.rs), a setup running in it (src/device/title.ts), the workspace's "Intentic". What it was called before.
pub fn set_title(app: &AppHandle, label: &'static str, title: &str) -> Option<String> {
    let before = TITLES.lock().unwrap().insert(label, title.to_string());
    if shown() == Some(label) {
        if let Some(frame) = frame(app) {
            let _ = frame.set_title(title);
        }
    }
    before
}

/* HOW A FACE STEPS ASIDE, per platform (see the top of this file). */

fn step_aside(face: &Webview) {
    set_drawn(face, false);
}

fn come_forward(face: &Webview) {
    set_drawn(face, true);
}

/// The face's own child window, shown or hidden, with its controller left as it is: a hidden face is exactly what a
/// hidden window was to WebView2. `with_webview` runs at once on the main thread, which is where this is called.
#[cfg(windows)]
fn set_drawn(face: &Webview, drawn: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNA};
    let _ = face.with_webview(move |webview| {
        let mut container = HWND::default();
        // SAFETY: a getter on the controller this webview owns and a ShowWindow on the child window it names, both on
        // the thread that created them.
        unsafe {
            if webview.controller().ParentWindow(&mut container).is_ok() && !container.is_invalid()
            {
                let _ = ShowWindow(container, if drawn { SW_SHOWNA } else { SW_HIDE });
            }
        }
    });
}

/// The face's GTK widget, shown or hidden in the frame's box, which gives the one shown its whole height. Kept out of
/// GTK's `show_all`, which tao answers every `show` of a window with: it would bring the face that stepped aside back
/// beside the one drawn, each in half the frame. Shown with a plain `show`, since `show_all` skips a widget kept out of
/// it (so Tauri's own `Webview::show`, which is wry's `show_all`, would never draw it again).
#[cfg(target_os = "linux")]
fn set_drawn(face: &Webview, drawn: bool) {
    use gtk::prelude::WidgetExt;
    let _ = face.with_webview(move |webview| {
        let view = webview.inner();
        view.set_no_show_all(true);
        if drawn {
            view.show();
        } else {
            view.hide();
        }
    });
}

#[cfg(not(any(windows, target_os = "linux")))]
fn set_drawn(face: &Webview, drawn: bool) {
    let _ = if drawn { face.show() } else { face.hide() };
}

/* THE RESIZE BORDERS OF A FRAMELESS FRAME (see the top of this file). */

/// Windows: Tauri's border window is a child of the frame laid over the edges of its client area, put on top when it
/// is made. Each face added after it lands above it, so it goes back on top, or the edges would be the page's.
#[cfg(windows)]
fn borders(frame: &Window, _face: &Webview) {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, SetWindowPos, HWND_TOP, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOOWNERZORDER, SWP_NOSIZE,
    };
    let Ok(parent) = frame.hwnd() else {
        return;
    };
    // SAFETY: a lookup among the frame's own children by the class and name tauri-runtime-wry registers for its border
    // window, and a z-order change of that window; nothing is read through the handle.
    unsafe {
        let Ok(border) = FindWindowExW(
            Some(parent),
            None,
            w!("TAURI_DRAG_RESIZE_BORDERS"),
            w!("TAURI_DRAG_RESIZE_WINDOW"),
        ) else {
            return;
        };
        let _ = SetWindowPos(
            border,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOOWNERZORDER | SWP_NOSIZE,
        );
    }
}

/// Linux: the face's webview takes the presses at the frame's edges, as Tauri's own content webview does.
#[cfg(target_os = "linux")]
fn borders(_frame: &Window, face: &Webview) {
    let _ = face.with_webview(|webview| resize::attach(&webview.inner()));
}

#[cfg(not(any(windows, target_os = "linux")))]
fn borders(_frame: &Window, _face: &Webview) {}

/// Which edge of a frame `width` by `height` the point (`x`, `y`) inside it is on, within `border` of it: corners
/// first, nothing in the middle. Pure.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn edge_at(width: f64, height: f64, x: f64, y: f64, border: f64) -> Option<Edge> {
    let left = x < border;
    let right = x >= width - border;
    let top = y < border;
    let bottom = y >= height - border;
    match (left, right, top, bottom) {
        (true, false, true, false) => Some(Edge::TopLeft),
        (false, true, true, false) => Some(Edge::TopRight),
        (true, false, false, true) => Some(Edge::BottomLeft),
        (false, true, false, true) => Some(Edge::BottomRight),
        (true, false, false, false) => Some(Edge::Left),
        (false, true, false, false) => Some(Edge::Right),
        (false, false, true, false) => Some(Edge::Top),
        (false, false, false, true) => Some(Edge::Bottom),
        // In the middle, or a frame narrower than its two borders.
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum Edge {
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// Tauri's handler for a frameless window's edges (tauri-runtime-wry `undecorated_resizing`, gtk), for a face: the
/// cursor says the edge, and a press there starts the window manager's resize.
#[cfg(target_os = "linux")]
mod resize {
    use gtk::gdk::{self, CursorType, WindowEdge};
    use gtk::glib::Propagation;
    use gtk::prelude::*;

    use super::{edge_at, Edge};

    /// How far in from each edge a press resizes, in logical pixels.
    const INSET: i32 = 5;

    fn window_edge(edge: Edge) -> WindowEdge {
        match edge {
            Edge::Left => WindowEdge::West,
            Edge::Right => WindowEdge::East,
            Edge::Top => WindowEdge::North,
            Edge::Bottom => WindowEdge::South,
            Edge::TopLeft => WindowEdge::NorthWest,
            Edge::TopRight => WindowEdge::NorthEast,
            Edge::BottomLeft => WindowEdge::SouthWest,
            Edge::BottomRight => WindowEdge::SouthEast,
        }
    }

    fn cursor(edge: Edge) -> CursorType {
        match edge {
            Edge::Left => CursorType::LeftSide,
            Edge::Right => CursorType::RightSide,
            Edge::Top => CursorType::TopSide,
            Edge::Bottom => CursorType::BottomSide,
            Edge::TopLeft => CursorType::TopLeftCorner,
            Edge::TopRight => CursorType::TopRightCorner,
            Edge::BottomLeft => CursorType::BottomLeftCorner,
            Edge::BottomRight => CursorType::BottomRightCorner,
        }
    }

    /// The frame's GDK window, while it is one a reader may resize: frameless, resizable and not maximised. The face's
    /// webview sits in the frame's box, which sits in the frame.
    fn resizable(webview: &webkit2gtk::WebView) -> Option<gdk::Window> {
        let window = webview.parent()?.parent()?.downcast::<gtk::Window>().ok()?;
        if window.is_decorated() || !window.is_resizable() || window.is_maximized() {
            return None;
        }
        window.window()
    }

    /// The edge under a point given relative to the frame's GDK window.
    fn edge(window: &gdk::Window, x: f64, y: f64) -> Option<Edge> {
        let border = f64::from(window.scale_factor() * INSET);
        edge_at(
            f64::from(window.width()),
            f64::from(window.height()),
            x,
            y,
            border,
        )
    }

    /// The edge under a point given on the screen.
    fn edge_from_root(window: &gdk::Window, root_x: f64, root_y: f64) -> Option<Edge> {
        let (left, top) = window.position();
        edge(window, root_x - f64::from(left), root_y - f64::from(top))
    }

    pub fn attach(webview: &webkit2gtk::WebView) {
        webview.add_events(
            gdk::EventMask::POINTER_MOTION_MASK
                | gdk::EventMask::BUTTON1_MOTION_MASK
                | gdk::EventMask::BUTTON_PRESS_MASK
                | gdk::EventMask::TOUCH_MASK,
        );
        webview.connect_motion_notify_event(|webview, event| {
            let Some(window) = resizable(webview) else {
                return Propagation::Proceed;
            };
            let (x, y) = event.position();
            let Some(edge) = edge(&window, x, y) else {
                return Propagation::Proceed;
            };
            let cursor = gdk::Cursor::for_display(&window.display(), cursor(edge));
            window.set_cursor(cursor.as_ref());
            Propagation::Stop
        });
        webview.connect_button_press_event(|webview, event| {
            if event.button() != 1 {
                return Propagation::Proceed;
            }
            let Some(window) = resizable(webview) else {
                return Propagation::Proceed;
            };
            let (root_x, root_y) = event.root();
            let Some(edge) = edge_from_root(&window, root_x, root_y) else {
                return Propagation::Proceed;
            };
            window.begin_resize_drag(
                window_edge(edge),
                1,
                root_x as i32,
                root_y as i32,
                event.time(),
            );
            // The press was the edge's, not the page's.
            Propagation::Stop
        });
        webview.connect_touch_event(|webview, event| {
            let Some(window) = resizable(webview) else {
                return Propagation::Proceed;
            };
            let (Some((root_x, root_y)), Some(device)) = (event.root_coords(), event.device())
            else {
                return Propagation::Proceed;
            };
            if let Some(edge) = edge_from_root(&window, root_x, root_y) {
                window.begin_resize_drag_for_device(
                    window_edge(edge),
                    &device,
                    0,
                    root_x as i32,
                    root_y as i32,
                    event.time(),
                );
            }
            Propagation::Proceed
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_faces_are_known_by_their_webviews_and_nothing_else_is_one() {
        assert_eq!(face_label(WORKSPACE), Some(WORKSPACE));
        assert_eq!(face_label(HOME), Some(HOME));
        assert!(!is_face(FRAME));
        assert!(!is_face("files-1"));
        assert!(!is_face("floating-chat"));
        assert!(!is_face("confirm-close"));
    }

    #[test]
    fn a_face_is_drawn_only_while_the_frame_shows_it_and_any_other_page_always() {
        assert!(drawn_label(WORKSPACE, Some(WORKSPACE)));
        assert!(!drawn_label(WORKSPACE, Some(HOME)));
        assert!(!drawn_label(HOME, None), "a face added and never shown");
        assert!(drawn_label("files-1", Some(WORKSPACE)));
        assert!(drawn_label("floating-chat", None));
    }

    #[test]
    fn the_frame_resizes_from_its_edges_and_corners_and_nowhere_else() {
        let at = |x, y| edge_at(1000.0, 800.0, x, y, 5.0);
        assert_eq!(at(500.0, 400.0), None);
        assert_eq!(at(2.0, 400.0), Some(Edge::Left));
        assert_eq!(at(997.0, 400.0), Some(Edge::Right));
        assert_eq!(at(500.0, 0.0), Some(Edge::Top));
        assert_eq!(at(500.0, 799.0), Some(Edge::Bottom));
        assert_eq!(at(1.0, 1.0), Some(Edge::TopLeft));
        assert_eq!(at(999.0, 2.0), Some(Edge::TopRight));
        assert_eq!(at(0.0, 796.0), Some(Edge::BottomLeft));
        assert_eq!(at(995.0, 795.0), Some(Edge::BottomRight));
        assert_eq!(
            at(5.0, 5.0),
            None,
            "the border is five pixels deep, not six"
        );
        assert_eq!(
            edge_at(6.0, 800.0, 3.0, 400.0, 5.0),
            None,
            "a frame narrower than its two borders has no side to take"
        );
    }
}
