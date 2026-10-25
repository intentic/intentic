use super::bounds::fit_width;
use super::close::request_close;
use super::mode::announced;
use super::unsaved::{is_local_window, UNSAVED};
use super::warmth::workspace_shown;
use super::{raise, show_home_at, show_workspace, Keyboard, HOME, WORKSPACE};
use crate::setup_link::WindowVerb;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Webview};

/* THE TITLE BAR THE PAGE DRAWS, AND THE FRAME THAT COMES BACK IF IT DOES NOT. */

/// What the page has said about one frameless window: that its bar is up (`Ready`), and the maximised state
/// last announced to it, so a resize that changes nothing sends nothing. One per window, by label — a floating
/// panel's page announces its own bar, and the workspace's answer must not stand in for it.
#[derive(Default)]
struct Chrome {
    ready: AtomicBool,
    maximized: AtomicBool,
    /// The page has no bar of its own to be moved and closed by (none drawn in time, or the app's offline page), so the
    /// window it is drawn in wears the platform's: a window of its own at once, the frame while it draws this face.
    bare: AtomicBool,
}

static CHROMES: LazyLock<Mutex<HashMap<String, Arc<Chrome>>>> = LazyLock::new(Mutex::default);

fn chrome_of(label: &str) -> Arc<Chrome> {
    CHROMES
        .lock()
        .unwrap()
        .entry(label.to_string())
        .or_default()
        .clone()
}

/// A destroyed window's record goes with it, so the next window under that label starts unannounced and gets
/// its own grace rather than inheriting a bar that was up in a window that no longer exists.
pub(super) fn forget_chrome(label: &str) {
    CHROMES.lock().unwrap().remove(label);
}

/// The event the page listens on for what the window is doing to itself. A DOM event dispatched by `eval` —
/// the update banner's channel exactly (update.rs `announce_to_workspace`), and one-way for the same reason:
/// nothing is returned and nothing becomes callable.
const FRAME_EVENT: &str = "intentic-desktop-window";

/* The app and the SPA ship separately — a binary somebody installed once, against a page deployed continuously. */
const CHROME_GRACE: Duration = Duration::from_secs(8);

/// What a page that has drawn its bar carries on its root element: WindowControls sets it as it mounts, in the same
/// breath as it sends `ready`.
const BAR_DRAWN: &str = "document.documentElement.hasAttribute('data-frameless')";

/// How long a page gets to answer whether its bar is drawn, before the frame comes back anyway.
const BAR_ANSWER: Duration = Duration::from_secs(2);

/// Hand the platform's frame back if nothing draws a bar in time. Armed once, when the window is built (a spare's,
/// when it is worn); the record it holds is that build's, so a window destroyed and rebuilt within the grace is
/// judged by its own.
///
/// A missing `ready` is not yet a missing bar. `ready` is a link, and a page that sets two links in one task keeps
/// only the last: WebKit schedules each `location.href` and drops the one pending when the next is set, and the bar
/// announces its scheme right behind `ready` (a local window's unsaved-changes guard says its state in the same
/// breath). So the page is asked whether its bar is drawn, and only a page that says no, or says nothing, gets the
/// frame back.
pub(super) fn arm_frame_fallback(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_string();
    let chrome = chrome_of(&label);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CHROME_GRACE).await;
        if chrome.ready.load(Ordering::Relaxed) || !Arc::ptr_eq(&chrome, &chrome_of(&label)) {
            return;
        }
        let Some(page) = app.get_webview(&label) else {
            return;
        };
        if bar_drawn(&page).await {
            chrome_is_up(&page);
            return;
        }
        eprintln!("no title bar from the page in {label}: handing back the platform's frame");
        wear_platform_bar(&page, true);
    });
}

/// Whether `page` has drawn its bar ([`BAR_DRAWN`]), within [`BAR_ANSWER`]; a page that does not answer has not.
async fn bar_drawn(page: &Webview) -> bool {
    let (tell, heard) = std::sync::mpsc::channel::<String>();
    let asked = page.eval_with_callback(BAR_DRAWN, move |answer| {
        let _ = tell.send(answer);
    });
    if asked.is_err() {
        return false;
    }
    let started = Instant::now();
    loop {
        if let Ok(answer) = heard.try_recv() {
            return says_yes(&answer);
        }
        if started.elapsed() >= BAR_ANSWER {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// An evaluated script's answer, as the webview hands it back (JSON), read as a yes.
fn says_yes(answer: &str) -> bool {
    answer.trim() == "true"
}

/// The page saying its bar is up. Taking the platform's frame off is a no-op in the ordinary case and the whole point
/// in the slow one: a page that arrives after the fallback fired takes the frame off again, so the window ends in the
/// state the page can actually drive either way round.
fn chrome_is_up(page: &Webview) {
    chrome_of(page.label()).ready.store(true, Ordering::Relaxed);
    wear_platform_bar(page, false);
    // Unconditionally, because this is a page that has just loaded: it knows nothing yet about a window that
    // may have been maximised before it got here, or hidden.
    announce_frame(page, true);
    crate::shown::tell(page, true);
}

/// Whether the window `page` is drawn in wears the platform's title bar, because the page has none (`bare`) or not.
/// A window of its own takes it at once; the frame takes what the face it draws needs ([`fit_decorations`]), so a
/// face out of sight never puts a bar over the one on screen.
fn wear_platform_bar(page: &Webview, bare: bool) {
    chrome_of(page.label()).bare.store(bare, Ordering::Relaxed);
    if crate::frame::is_face(page.label()) {
        fit_decorations(page.app_handle());
    } else {
        let _ = page.window().set_decorations(bare);
    }
}

/// The workspace face is on a page of the app's own that draws no bar (offline.rs): the frame wears the platform's
/// while it shows it, until a page that draws one says so (`chrome_is_up`).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn page_has_no_bar(page: &Webview) {
    wear_platform_bar(page, true);
}

/// The frame wears the platform's title bar while the face it draws has no bar of its own, and only then. Asked only
/// when it would change: taking a frame off that is already off still makes Windows recompute the window's frame.
pub(super) fn fit_decorations(app: &AppHandle) {
    let (Some(frame), Some(shown)) = (crate::frame::frame(app), crate::frame::shown()) else {
        return;
    };
    let bare = chrome_of(shown).bare.load(Ordering::Relaxed);
    if frame.is_decorated().unwrap_or(!bare) != bare {
        let _ = frame.set_decorations(bare);
    }
}

/// Tell the page whether the window it is drawn in is maximised. `always` is for a page that has just announced itself
/// and has no state at all; every other caller is an event, and sends only what CHANGED.
pub(crate) fn announce_frame(page: &Webview, always: bool) {
    let maximized = page.window().is_maximized().unwrap_or(false);
    let changed = chrome_of(page.label())
        .maximized
        .swap(maximized, Ordering::Relaxed)
        != maximized;
    if !always && !changed {
        return;
    }
    let _ = page.eval(format!(
        "window.dispatchEvent(new CustomEvent('{FRAME_EVENT}', {{ detail: {{ maximized: {maximized} }} }}));"
    ));
}

/* A PRESS ON THE PAGE'S OWN TITLE BAR — answered on the window it was pressed in. */
///
/// A face's page works the frame it is drawn in.
pub(super) fn work_the_window(app: &AppHandle, label: &str, verb: WindowVerb) {
    let Some(page) = app.get_webview(label) else {
        return;
    };
    let window = page.window();
    let face = crate::frame::is_face(label);
    match verb {
        WindowVerb::Ready => chrome_is_up(&page),
        WindowVerb::Shown(sandbox) if label == WORKSPACE => workspace_shown(app, sandbox),
        WindowVerb::Shown(_) => {}
        // Sway owns kiosk sizing: these buttons must not hide the face or cover the system bar.
        WindowVerb::Minimize | WindowVerb::Maximize if crate::os::kiosk() && face => {}
        WindowVerb::Minimize => {
            let _ = window.minimize();
        }
        WindowVerb::Maximize => {
            let _ = if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            };
            // The resize event says the same thing a moment later and is deduplicated against this; sending it
            // here is what makes the glyph flip on the press rather than on the platform's next frame.
            announce_frame(&page, false);
        }
        // A face's × is a question and hides (`request_close`), the workspace's and the main window's alike; a
        // floating panel's × is its dock, and the window simply goes. Any other local window's goes through its
        // CloseRequested, where unsaved changes hold it until its page has asked (`close_turn`), which `confirmed`
        // says it has.
        WindowVerb::Close { .. } if face => request_close(app),
        WindowVerb::Close { confirmed } => {
            if confirmed && is_local_window(label) {
                UNSAVED.lock().unwrap().confirmed.insert(label.to_string());
            }
            let _ = window.close();
        }
        WindowVerb::Dirty(dirty) => {
            if is_local_window(label) {
                UNSAVED.lock().unwrap().mark_dirty(label, dirty);
            }
        }
        // The platform's own move loop, started while the button is still down — the same call a Tauri drag
        // region makes, reached by a link instead of by a command.
        WindowVerb::Drag => {
            let _ = window.start_dragging();
        }
        // A face comes back the way the tray brings it back, in the other face's place.
        WindowVerb::Raise if label == WORKSPACE => show_workspace(app),
        WindowVerb::Raise if label == HOME => show_home_at(app, None, Keyboard::Take),
        WindowVerb::Raise => raise(&page),
        WindowVerb::Fit(width) => fit_width(&window, f64::from(width)),
        // Answered before this is reached (`handle_link`); it is about the app's faces, not this window.
        WindowVerb::Mode(mode, look) => announced(app, mode, look),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page's answer to whether its bar is drawn, as a webview hands an evaluated boolean back.
    #[test]
    fn a_page_says_its_bar_is_drawn_with_a_plain_true() {
        assert!(says_yes("true"));
        assert!(says_yes(" true\n"));
        assert!(!says_yes("false"));
        assert!(!says_yes("null"));
        assert!(!says_yes(""));
        assert_eq!(
            BAR_DRAWN,
            "document.documentElement.hasAttribute('data-frameless')"
        );
    }
}
