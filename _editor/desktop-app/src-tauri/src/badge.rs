use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::{AppHandle, Manager, Webview, Window};

use crate::setup_link::BadgeArgs;

/* THE WORKSPACE TAB'S MARK, ON THE APP'S OWN ICON — where it can be seen with every window of the app out of sight.

The browser tab is the one surface of the web app that stays in view from another tab or app, and this app's window
has no tab: its title is fixed, and most of its life is spent in the tray. So the mark the tab would show (the web's
tabSignal.ts: a count of what needs the reader, a check for a turn that finished while they were away, a dot while
agents work, grey while the sandbox is unreachable) goes on the app's icon instead, in three places:

- the tray icon, on both systems: the icon with the mark drawn on it, and the mark's meaning in its tooltip;
- the taskbar button on Windows, as its overlay: the mark alone, in the corner Windows keeps for one;
- the dock on Linux, as a count of what needs the reader, for the docks that draw one (Ubuntu's, Dash to Dock, KDE's
  task manager, Plank), through the `com.canonical.Unity.LauncherEntry` signal they all listen for.

The page draws both images (`intentic://badge`, setup_link.rs `BadgeArgs`) from the drawing its tab icon is made of, so
the three cannot disagree, and the app draws nothing itself. Rejected (2026-10-02): flashing the taskbar button and a
dock's "urgent" state for an ask, which repeat what the mark already shows and do it again every time, and the
taskbar's progress bar while agents work, a moving thing in the corner of the eye for something the reader started on
purpose. */

/// The tray's id (lib.rs `create_tray`).
pub const TRAY: &str = "main";

/// Every tooltip opens with the app's name, which is all the tray says while nothing is marked.
const NAME: &str = "Intentic";

/// The widest image a badge puts up. The page draws 64 pixels for the tray and 32 for the overlay; this bounds what a
/// link can make the platform scale.
const IMAGE_SIDE_MAX: u32 = 256;

/// What the badge last put up, kept for a taskbar button Windows makes anew (a window coming back from the tray) and
/// so a dock is told a count only when it moves.
#[derive(Default)]
pub struct Badge(Mutex<Standing>);

#[derive(Default)]
struct Standing {
    /// The mark alone, for the overlay of each face's taskbar button. Read on Windows only, kept everywhere: one shape.
    #[cfg_attr(not(windows), allow(dead_code))]
    overlay: Option<Image<'static>>,
    /// The count a Linux dock was last told.
    count: Option<u32>,
}

/// A PNG the page drew, read as an image, or nothing for one that is not a PNG or is too large to be an icon.
fn image_of(png: &[u8]) -> Option<Image<'static>> {
    let image = Image::from_bytes(png).ok()?;
    (image.width() <= IMAGE_SIDE_MAX && image.height() <= IMAGE_SIDE_MAX).then_some(image)
}

/// The tray's tooltip for what the page said the mark means, or the app's name alone.
fn tooltip_of(said: Option<&str>) -> String {
    match said {
        Some(said) => format!("{NAME} · {said}"),
        None => NAME.to_string(),
    }
}

/// Put the workspace tab's mark on the app's icon. An image that will not decode is the app's own icon, never a
/// blank one.
pub fn show(app: &AppHandle, args: BadgeArgs) {
    let icon = args.icon.as_deref().and_then(image_of);
    if let Some(tray) = app.tray_by_id(TRAY) {
        let icon = icon.or_else(|| app.default_window_icon().cloned().map(Image::to_owned));
        if let Err(error) = tray.set_icon(icon) {
            eprintln!("intentic: the tray icon could not be marked: {error}");
        }
        let _ = tray.set_tooltip(Some(tooltip_of(args.tooltip.as_deref())));
    }
    let overlay = args.overlay.as_deref().and_then(image_of);
    let count = args.count;
    let tell_dock = {
        let badge = app.state::<Badge>();
        let mut standing = badge.0.lock().unwrap();
        standing.overlay = overlay;
        standing.count.replace(count) != Some(count)
    };
    if let Some(frame) = crate::frame::frame(app) {
        overlay_now(app, &frame);
    }
    if tell_dock {
        dock(app, count);
    }
}

/// A face has just come on screen (shown.rs): the frame both faces are drawn in carries the app's taskbar button, and a
/// floating panel or a document's window keeps a button of its own, unmarked, as a second window of an app does. Windows
/// makes that button anew each time the frame comes back from the tray, with no overlay, and only once the shell has got
/// round to it, so the mark is put back a moment later and once more after that rather than straight away, when there
/// is no button yet to put it on.
pub fn window_shown(window: &Webview) {
    if !cfg!(windows) || !is_face(window.label()) {
        return;
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        for wait in [Duration::from_millis(300), Duration::from_millis(1500)] {
            tokio::time::sleep(wait).await;
            if let Some(frame) = crate::frame::frame(&app) {
                overlay_now(&app, &frame);
            }
        }
    });
}

fn is_face(label: &str) -> bool {
    crate::frame::is_face(label)
}

/// The overlay on the frame's taskbar button, as the badge stands. A hidden frame has no button to mark, and gets its
/// mark when it is shown again ([`window_shown`]).
#[cfg(windows)]
fn overlay_now(app: &AppHandle, window: &Window) {
    if !matches!(window.is_visible(), Ok(true)) {
        return;
    }
    let overlay = app.state::<Badge>().0.lock().unwrap().overlay.clone();
    let _ = window.set_overlay_icon(overlay);
}

#[cfg(not(windows))]
fn overlay_now(_app: &AppHandle, _window: &Window) {}

/// The count on a Linux dock's icon for the app, through the signal Unity defined and every dock that draws a count
/// listens for. tao's own `set_badge_count` speaks it only while Unity itself is running, which no desktop since 2017
/// is, so the app sends the signal itself, naming the desktop entry its packages install (`<productName>.desktop`, as
/// tauri-bundler names it). An AppImage has no such entry, and no dock draws anything for it.
#[cfg(target_os = "linux")]
fn dock(app: &AppHandle, count: u32) {
    let entry = format!("application://{}.desktop", app.package_info().name);
    crate::notice::later(move || {
        let Some(bus) = crate::notice::session_bus() else {
            return;
        };
        let mut properties = std::collections::HashMap::new();
        properties.insert("count", zbus::wire::Variant::I64(i64::from(count)));
        properties.insert("count-visible", zbus::wire::Variant::Bool(count > 0));
        if let Err(error) = tauri::async_runtime::block_on(bus.emit_signal(
            None::<&str>,
            "/dev/intentic/desktop/launcher",
            "com.canonical.Unity.LauncherEntry",
            "Update",
            &(entry.as_str(), properties),
        )) {
            eprintln!("intentic: the dock could not be told the count: {error}");
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn dock(_app: &AppHandle, _count: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tooltip_names_the_app_and_then_what_the_mark_means() {
        assert_eq!(tooltip_of(None), "Intentic");
        assert_eq!(tooltip_of(Some("2 need you")), "Intentic · 2 need you");
    }

    #[test]
    fn only_the_two_faces_carry_the_taskbar_mark() {
        assert!(is_face(crate::windows::WORKSPACE));
        assert!(is_face(crate::windows::HOME));
        assert!(!is_face("floating-chat"));
        assert!(!is_face("files-1"));
    }

    #[test]
    fn an_image_that_is_not_an_icon_is_not_put_up() {
        assert!(image_of(b"\x89PNG\r\n\x1a\nnot really").is_none());
        let icon = include_bytes!("../icons/32x32.png");
        let image = image_of(icon).expect("the app's own icon reads");
        assert_eq!((image.width(), image.height()), (32, 32));
        // Wider than any icon: the 512-pixel one the bundle carries.
        assert!(image_of(include_bytes!("../icons/icon.png")).is_none());
    }
}
