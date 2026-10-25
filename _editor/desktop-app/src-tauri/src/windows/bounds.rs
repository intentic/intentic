use super::close::CONFIRM_CLOSE;
use super::shown_face;
use tauri::{
    AppHandle, LogicalSize, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow, Window,
};

/// The workspace's frame on a cold start. A PREFERENCE rather than a size: what the window actually opens at
/// is this fitted to the screen, see `opening_bounds`.
const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);

const MIN_SIZE: (f64, f64) = (900.0, 600.0);

/// The margin a content-fitted window keeps from the edge of the work area, so a card that grows to the
/// screen's height still reads as a card on it rather than a window jammed against the taskbar.
const CONTENT_MARGIN: f64 = 24.0;

/// The least a face is ever fitted to: an empty manager still has its header and its one sentence.
const CONTENT_MIN_HEIGHT: f64 = 120.0;

/* THE SIZE TO OPEN AT, given what this screen can actually show. */
fn fit_to_screen(preferred: (f64, f64), available: (f64, f64)) -> (f64, f64) {
    // Never zero, whatever a desktop reports: a monitor unplugged mid-session can answer with an area of
    // nothing at all, and a window asked for 0×0 is one nobody can grab.
    (
        preferred.0.min(available.0.max(1.0)),
        preferred.1.min(available.1.max(1.0)),
    )
}

/// The opening size and the minimum that goes with it — the minimum fitted to the same screen, so it can
/// never be the thing that holds a window bigger than the display it is on.
pub(crate) fn opening_bounds(available: Option<(f64, f64)>) -> ((f64, f64), (f64, f64)) {
    let Some(available) = available else {
        return (DEFAULT_SIZE, MIN_SIZE);
    };
    let size = fit_to_screen(DEFAULT_SIZE, available);
    (size, (MIN_SIZE.0.min(size.0), MIN_SIZE.1.min(size.1)))
}

/// The screen a window is about to open on: where its usable area STARTS and how big it is, logical, plus the
/// scale that turns the answer back into pixels. The origin is carried because it is not (0, 0) on a secondary
/// monitor, nor on a display with the taskbar docked to the left or the top.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct WorkArea {
    origin: (f64, f64),
    pub(crate) size: (f64, f64),
    scale: f64,
}

/* WHERE A COLD-START WINDOW OPENS — the half of the fit that was missing, and the half the user meets first. */
fn opening_position(work: WorkArea, inner: (f64, f64)) -> (f64, f64) {
    let offset = |available: f64, outer: f64| ((available - outer) / 2.0).max(0.0);
    (
        work.origin.0 + offset(work.size.0, inner.0),
        work.origin.1 + offset(work.size.1, inner.1),
    )
}

/* The work area of the screen a window is about to open on — its usable rectangle rather than its full size, so a taskbar. */
pub(crate) fn work_area(app: &AppHandle) -> Option<WorkArea> {
    work_area_of(app.primary_monitor().ok().flatten())
}

/// The work area of the screen a window is ALREADY on, for a window being refitted in place: a card on a
/// second monitor is clamped to that monitor, not to the primary one.
fn window_work_area(window: &WebviewWindow) -> Option<WorkArea> {
    work_area_of(window.current_monitor().ok().flatten())
}

fn work_area_of(monitor: Option<Monitor>) -> Option<WorkArea> {
    let monitor = monitor?;
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let area = monitor.work_area();
    Some(WorkArea {
        origin: (
            f64::from(area.position.x) / scale,
            f64::from(area.position.y) / scale,
        ),
        size: (
            f64::from(area.size.width) / scale,
            f64::from(area.size.height) / scale,
        ),
        scale,
    })
}

/// Put `window` in the middle of `work` at the inner size it was just built with. Physical, converted here
/// from the monitor's own scale rather than handed to Tauri as logical units: a logical position is resolved
/// against whatever scale the WINDOW reports, and a window the platform has just cascaded onto another display
/// reports that display's — which is how a placement computed for one screen lands on a different one.
pub(crate) fn place_in_work_area(window: &Window, work: WorkArea, inner: (f64, f64)) {
    let at = opening_position(work, inner);
    let _ = window.set_position(PhysicalPosition::new(
        (at.0 * work.scale).round() as i32,
        (at.1 * work.scale).round() as i32,
    ));
}

/// The dialog's frame: a card, fixed in width and fitted to its content. It opens at a
/// guess close to what its page measures a moment later, because it has to be on screen the instant the × is
/// clicked, before its page has run; the fit then corrects the guess by a few pixels at most. Taller on
/// Windows, the one platform where the tray option has to say where the icon goes (CloseConfirm.vue).
pub(super) const CONFIRM_WIDTH: f64 = 440.0;

pub(super) const CONFIRM_OPENING_HEIGHT: f64 = if cfg!(target_os = "windows") {
    312.0
} else {
    296.0
};

/// The height a content-fitted window gets: what its page measured, no less than a card's worth, and no more
/// than the work area leaves it with a margin above and below. Pure, for the tests: the cases that matter are
/// a requirements list taller than a laptop screen, and a screen smaller than any card.
fn fitted_height(content: f64, available: Option<f64>) -> f64 {
    let wanted = content.max(CONTENT_MIN_HEIGHT);
    match available {
        Some(available) => wanted.min((available - 2.0 * CONTENT_MARGIN).max(1.0)),
        None => wanted,
    }
}

/// A logical size as whole physical pixels, rounded UP. Tauri would convert this itself, and it ROUNDS: at a
/// fractional display scale (Windows' 125%, 150%, 175%) a size rounded down gives the webview a client area a
/// fraction shorter than the page that measured it, and the page answers that with a scrollbar down a card
/// which has nothing to scroll. A scale that is not a positive number is no scale at all.
fn whole_pixels(size: LogicalSize<f64>, scale: f64) -> PhysicalSize<u32> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    PhysicalSize::new(
        (size.width * scale).ceil() as u32,
        (size.height * scale).ceil() as u32,
    )
}

/// Where a window that has just been refitted keeps its top edge: where it was, unless its new bottom edge
/// would leave the work area, in which case it moves up by exactly the overhang, and never above the area's
/// top margin. A card grows DOWNWARD from a heading that stays put, which is what makes rows arriving under
/// it readable; one that grew off the bottom of the screen would hide the rows it grew for.
fn kept_on_screen(top: f64, height: f64, work: WorkArea) -> f64 {
    let lowest_top = work.origin.1 + work.size.1 - CONTENT_MARGIN - height;
    top.min(lowest_top).max(work.origin.1 + CONTENT_MARGIN)
}

/* THE PAGE SAYS HOW TALL IT IS, AND THE WINDOW FOLLOWS: the close question's card, the one window still fitted to its page. */
pub fn fit_to_content(app: &AppHandle, window: &WebviewWindow, content_height: f64) {
    if window.label() != CONFIRM_CLOSE || !content_height.is_finite() {
        return;
    }
    // The dialog may have been opened always-on-top to survive the face's restore animation (ask_before_closing,
    // 2026-10-24). By the time the page has rendered its content and called this, the restore is over and the
    // ownership alone keeps the dialog above the face, so the flag comes off. Leaving it on would keep the dialog
    // above every other application on the desktop.
    if window.is_always_on_top().unwrap_or(false) {
        let _ = window.set_always_on_top(false);
    }
    let work = window_work_area(window).or_else(|| work_area(app));
    let size = LogicalSize::new(
        CONFIRM_WIDTH,
        fitted_height(content_height, work.map(|work| work.size.1)),
    );
    let _ = window.set_size(whole_pixels(size, window.scale_factor().unwrap_or(1.0)));
    center_over(window, shown_face(app).as_ref(), size);
    if let (Some(work), Ok(at)) = (work, window.outer_position()) {
        let top = f64::from(at.y) / work.scale;
        let kept = kept_on_screen(top, size.height, work);
        if (kept - top).abs() >= 1.0 {
            let _ = window.set_position(PhysicalPosition::new(
                at.x,
                (kept * work.scale).round() as i32,
            ));
        }
    }
}

/// The frame takes the frame of the folder or document window the workspace is opened from (`show_workspace_from`),
/// when that one is on screen: its place, its size, and whether it is maximised. The reader sees the window they pressed
/// in change what it shows. A window with nothing on screen to hand over leaves the frame where it is.
///
/// In kiosk mode sway tiles the frame edge to edge below the system bar, and nothing is taken.
pub(super) fn take_frame(window: &Window, from: Option<&Window>) {
    if crate::os::kiosk() {
        return;
    }
    let Some(from) = from else {
        return;
    };
    // "Not minimised" is what is asked, so a window that cannot answer is treated as minimised and hands over nothing.
    let taken = frame_taken(
        from.is_visible().unwrap_or(false),
        !matches!(from.is_minimized(), Ok(false)),
        from.is_maximized().unwrap_or(false),
    );
    match taken {
        FrameTaken::Nothing => {}
        FrameTaken::Maximized => {
            let _ = window.unminimize();
            let _ = window.maximize();
        }
        FrameTaken::Place => {
            let _ = window.unminimize();
            let _ = window.unmaximize();
            if let (Ok(position), Ok(size)) = (from.outer_position(), from.inner_size()) {
                let _ = window.set_position(position);
                let _ = window.set_size(size);
            }
        }
    }
}

/// What the frame takes from the window it replaces ([`take_frame`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameTaken {
    /// The window going is not on screen: the frame keeps its own place.
    Nothing,
    /// The window going is maximised: so is the frame, wherever it was.
    Maximized,
    /// Its place and its size.
    Place,
}

/// Pure, for the tests. A window minimised to the taskbar is NOT on screen, though Windows calls it visible: its frame
/// is where Windows parks a minimised window, (-32000, -32000) at nothing by nothing, and a face that took it opened
/// there, off every screen, frameless and out of reach until Quit (2026-10-12). And a minimised window is never
/// maximised as far as tao says, so it hands over neither its place nor its maximised state.
fn frame_taken(visible: bool, minimized: bool, maximized: bool) -> FrameTaken {
    if !visible || minimized {
        return FrameTaken::Nothing;
    }
    if maximized {
        FrameTaken::Maximized
    } else {
        FrameTaken::Place
    }
}

/// Whether a window is where the reader can see it: shown, and not minimised to the taskbar. A window that cannot answer
/// counts as not on screen, so nothing is placed against a frame that was never read.
pub(crate) fn window_on_screen(window: &Window) -> bool {
    window.is_visible().unwrap_or(false) && matches!(window.is_minimized(), Ok(false))
}

/// Widen to `width` CSS pixels (logical, which is what the page measures in), keeping the height; never
/// narrows, so a window the reader already made wider is left as they made it.
pub(super) fn fit_width(window: &Window, width: f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(size) = window.inner_size() else {
        return;
    };
    let size = size.to_logical::<f64>(scale);
    if size.width >= width {
        return;
    }
    let _ = window.set_size(LogicalSize::new(width, size.height));
}

/// The middle of the window being asked about, not the middle of the screen — a window that opens away from
/// the thing it is about reads as belonging to something else. Falls back to the middle of the screen when
/// there is nothing to be about, which is an ordinary state for both callers: a confirmation with no workspace
/// behind it, and a setup started from a link that opened this app cold. A window that is not on screen is nothing
/// to be about: a minimised one's frame is Windows' parking place for it, off every screen.
///
/// `size` is what the window will be WEARING when it is shown, passed in rather than read back off it. A
/// window that has just been asked to resize does not answer with its new size on every platform — GTK
/// resizes on its own clock — and a setup placed against the size it is leaving lands half a window off.
pub(super) fn center_over(window: &WebviewWindow, over: Option<&Window>, size: LogicalSize<f64>) {
    let own: PhysicalSize<u32> = size.to_physical(window.scale_factor().unwrap_or(1.0));
    let placed = over.filter(|over| window_on_screen(over)).and_then(|over| {
        Some(centered(
            over.outer_position().ok()?,
            over.outer_size().ok()?,
            own,
        ))
    });
    match placed {
        Some(position) => {
            let _ = window.set_position(position);
        }
        None => {
            let _ = window.center();
        }
    }
}

/// Where a window of `own` goes to sit in the middle of the rectangle at `position` of size `frame`. Signed
/// throughout: a window wider than the one it is centred on gets a negative offset, which is the correct
/// answer — the two stay concentric — where clamping it to zero would hang it off to one side.
fn centered(
    position: tauri::PhysicalPosition<i32>,
    frame: PhysicalSize<u32>,
    own: PhysicalSize<u32>,
) -> tauri::PhysicalPosition<i32> {
    tauri::PhysicalPosition::new(
        position.x + (frame.width as i32 - own.width as i32) / 2,
        position.y + (frame.height as i32 - own.height as i32) / 2,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /* WHAT A FACE COMING UP TAKES FROM THE FACE GOING. */
    #[test]
    fn a_face_takes_the_frame_only_of_a_face_on_screen() {
        assert_eq!(frame_taken(true, false, false), FrameTaken::Place);
        assert_eq!(frame_taken(true, false, true), FrameTaken::Maximized);
        assert_eq!(
            frame_taken(false, false, false),
            FrameTaken::Nothing,
            "hidden in the tray"
        );
        // Minimised to the taskbar: Windows calls it visible, and its frame is (-32000, -32000) at nothing by nothing.
        assert_eq!(frame_taken(true, true, false), FrameTaken::Nothing);
        assert_eq!(frame_taken(true, true, true), FrameTaken::Nothing);
    }

    /// A screen to open onto, as the platform would describe it: a work area starting at the top-left with a
    /// taskbar taken off the bottom.
    fn screen(size: (f64, f64)) -> WorkArea {
        WorkArea {
            origin: (0.0, 0.0),
            size,
            scale: 1.0,
        }
    }

    /// The bottom edge of the window `opening_bounds` + `opening_position` agree on, against the bottom edge
    /// of the work area it was given. The whole of what the reported bug was: those two numbers, in the wrong
    /// order.
    fn bottom_edge(work: WorkArea) -> (f64, f64) {
        let (size, _) = opening_bounds(Some(work.size));
        let at = opening_position(work, size);
        (at.1 + size.1, work.origin.1 + work.size.1)
    }

    /// THE BUG THIS SHIPPED WITH, in the numbers that caused it: a 1080p panel at the 150% scale most laptops
    /// are sold with leaves 1080 physical rows, which is 720 logical — and the preference is 900. The first
    /// window a new user ever saw opened a third taller than the display and hung off the bottom of it.
    #[test]
    fn a_scaled_laptop_panel_does_not_get_a_window_taller_than_itself() {
        // 1920×1080 at 150%, less a 48px taskbar: what the platform reports as the work area, logical.
        let available = (1280.0, 688.0);
        let (size, min) = opening_bounds(Some(available));

        // At most the screen, which for an undecorated window is exactly the screen: there is no title bar
        // left to reserve rows for, so a fit that fills the work area IS the window fitting on it.
        assert!(size.1 <= available.1, "opened {size:?} into {available:?}");
        assert!(size.0 <= available.0, "opened {size:?} into {available:?}");
        // And the floor cannot be what puts it back over the edge.
        assert!(
            min.1 <= size.1 && min.0 <= size.0,
            "min {min:?} over size {size:?}"
        );
    }

    /// A screen with room to spare gets the preference untouched — the fit is a ceiling, not a resize.
    #[test]
    fn a_large_display_still_opens_at_the_preferred_size() {
        assert_eq!(
            opening_bounds(Some((2560.0, 1400.0))),
            (DEFAULT_SIZE, MIN_SIZE)
        );
    }

    /// No monitor to ask is a real answer on a headless or freshly-plugged display, and is not a reason to
    /// shrink anything.
    #[test]
    fn an_unknown_screen_changes_nothing() {
        assert_eq!(opening_bounds(None), (DEFAULT_SIZE, MIN_SIZE));
    }

    /// A screen smaller than the minimum is still a screen the window has to fit on: the floor comes down
    /// with it, because a floor above the ceiling is a window that cannot be resized onto its own display.
    #[test]
    fn a_screen_below_the_minimum_lowers_the_minimum_too() {
        let (size, min) = opening_bounds(Some((800.0, 500.0)));

        assert!(size.0 <= 800.0 && size.1 <= 500.0, "opened {size:?}");
        assert_eq!(min, size);
    }

    /// Never zero or negative, whatever a desktop reports — a monitor unplugged mid-session can answer with an
    /// area of a few pixels, and a window asked for 0×0 is one nobody can grab.
    #[test]
    fn an_absurd_screen_still_asks_for_a_window() {
        let (size, _) = opening_bounds(Some((4.0, 4.0)));

        assert!(size.0 >= 1.0 && size.1 >= 1.0, "opened {size:?}");
    }

    /// A face is as tall as its content, and no taller than the screen it is on leaves it a margin: the
    /// requirements list of a PC that needs everything is taller than a laptop's work area, and the card
    /// scrolls inside from there rather than growing under the taskbar.
    #[test]
    fn a_face_is_fitted_to_its_content_within_the_screen() {
        assert_eq!(fitted_height(500.0, Some(883.0)), 500.0);
        assert_eq!(
            fitted_height(1400.0, Some(883.0)),
            883.0 - 2.0 * CONTENT_MARGIN
        );
        // A page that measured nothing yet is still a card, never a strip.
        assert_eq!(fitted_height(0.0, Some(883.0)), CONTENT_MIN_HEIGHT);
        // No screen to ask is no reason to clamp.
        assert_eq!(fitted_height(1400.0, None), 1400.0);
        // A screen smaller than the margins still asks for a window somebody can see.
        assert!(fitted_height(300.0, Some(20.0)) >= 1.0);
    }

    /// A fitted window is never a fraction of a pixel SHORTER than the page it was measured from: that
    /// fraction is the scrollbar the install card grew down its right edge whenever its height changed.
    #[test]
    fn a_fitted_window_is_never_rounded_below_the_content_it_was_measured_from() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
            for content in [120.0, 427.0, 451.0, 632.5] {
                let size = LogicalSize::new(CONFIRM_WIDTH, content);
                let pixels = whole_pixels(size, scale);
                assert!(
                    f64::from(pixels.height) >= content * scale,
                    "{content} at {scale}x fitted to {} physical pixels",
                    pixels.height
                );
                assert!(f64::from(pixels.width) >= CONFIRM_WIDTH * scale);
            }
        }
        // A monitor that reports nothing usable is no scale at all, not a window of zero height.
        assert_eq!(
            whole_pixels(LogicalSize::new(620.0, 440.0), 0.0),
            PhysicalSize::new(620, 440)
        );
    }

    /// A card grows downward under a heading that stays put — until its bottom edge would leave the work
    /// area, and then it moves up by exactly the overhang, never above the top margin.
    #[test]
    fn a_growing_card_keeps_its_heading_still_and_its_bottom_on_screen() {
        let work = screen((1531.0, 883.0));
        assert_eq!(kept_on_screen(200.0, 400.0, work), 200.0);
        // 200 + 700 = 900 > 883 - 24: pushed up to end exactly at the margin.
        assert_eq!(
            kept_on_screen(200.0, 700.0, work),
            883.0 - CONTENT_MARGIN - 700.0
        );
        // Taller than the screen leaves it: the top margin wins, and the fit above is what keeps this rare.
        assert_eq!(kept_on_screen(200.0, 2000.0, work), CONTENT_MARGIN);
        // On a second monitor the area's own origin is where "the top" is.
        let second = WorkArea {
            origin: (1920.0, 0.0),
            size: (1400.0, 1080.0),
            scale: 1.0,
        };
        assert_eq!(
            kept_on_screen(1000.0, 200.0, second),
            1080.0 - CONTENT_MARGIN - 200.0
        );
    }

    /// The close confirmation opens in the MIDDLE of the window it is asking about, not on its corner — which
    /// is what says it is about that window. Asserted on the arithmetic because the windows themselves exist
    /// only in a running desktop session.
    #[test]
    fn the_close_dialog_lands_in_the_middle_of_the_window_it_is_about() {
        let workspace = PhysicalSize::new(1440u32, 900u32);
        let dialog = PhysicalSize::new(460u32, 300u32);
        let at = centered(PhysicalPosition::new(100, 50), workspace, dialog);
        assert_eq!(at, PhysicalPosition::new(100 + 490, 50 + 300));
        // Concentric: the gap left on one side is the gap left on the other.
        assert_eq!(
            at.x - 100,
            (workspace.width as i32 - dialog.width as i32) - (at.x - 100)
        );
    }

    /* THE BUG AS REPORTED, which the fit alone did not cover: the window opened with its bottom edge — and the chat composer in it — under the taskbar. */
    #[test]
    fn a_cold_start_window_opens_fully_inside_the_work_area() {
        let work = screen((1531.0, 883.0));
        let (window, available) = bottom_edge(work);

        assert!(
            window <= available,
            "window ends at {window}, screen at {available}"
        );
        // And it is not merely on screen by being tiny: the fit gives it every row the screen has to spare,
        // which is now all of them — the 48 that used to go to a title bar are the window's.
        let (size, _) = opening_bounds(Some(work.size));
        assert_eq!(size.1, work.size.1);
    }

    /// The same, on the screens this app is actually met on — including the one where the preference fits and
    /// the cascade was therefore never the thing that broke it.
    #[test]
    fn no_ordinary_screen_gets_a_window_hanging_off_its_bottom() {
        for size in [
            (1531.0, 883.0),  // 1920×1080 at 150%, the reported one
            (1280.0, 688.0),  // 1920×1080 at 150% with a taller taskbar
            (2560.0, 1400.0), // room to spare — the preference wins and still has to be placed
            (1024.0, 700.0),  // a small laptop
            (800.0, 500.0),   // smaller than MIN_SIZE
        ] {
            let (window, available) = bottom_edge(screen(size));
            assert!(
                window <= available,
                "{size:?}: window ends at {window}, screen at {available}"
            );
        }
    }

    /// Centred, not merely on screen — the same gap above the window as below it, so nothing about the opening
    /// frame reads as having been shoved against an edge.
    #[test]
    fn a_cold_start_window_is_centred_in_the_work_area() {
        let work = screen((2560.0, 1400.0));
        let (size, _) = opening_bounds(Some(work.size));
        let at = opening_position(work, size);

        let above = at.1 - work.origin.1;
        let below = (work.origin.1 + work.size.1) - (at.1 + size.1);
        assert!(
            (above - below).abs() < 0.001,
            "above {above}, below {below}"
        );
        let left = at.0 - work.origin.0;
        let right = (work.origin.0 + work.size.0) - (at.0 + size.0);
        assert!((left - right).abs() < 0.001, "left {left}, right {right}");
    }

    /// The work area does not start at the origin of the screen, let alone of the desktop: a taskbar docked to
    /// the left or the top moves it, and so does every monitor that is not the first. A placement that ignored
    /// that would open the window over the taskbar, or on the wrong display entirely.
    #[test]
    fn the_window_opens_inside_the_work_area_wherever_that_area_starts() {
        let work = WorkArea {
            // A second monitor to the right, with the taskbar docked to the left of it.
            origin: (1920.0, 0.0),
            size: (1400.0, 1080.0),
            scale: 1.0,
        };
        let (size, _) = opening_bounds(Some(work.size));
        let at = opening_position(work, size);

        assert!(
            at.0 >= work.origin.0,
            "opened at {at:?}, area starts {:?}",
            work.origin
        );
        assert!(
            at.1 >= work.origin.1,
            "opened at {at:?}, area starts {:?}",
            work.origin
        );
        assert!(at.0 + size.0 <= work.origin.0 + work.size.0);
        assert!(at.1 + size.1 <= work.origin.1 + work.size.1);
    }

    /// A window that cannot fit starts AT the corner rather than at a negative offset — the piece of it left on
    /// screen is then the top-left, which is the piece carrying the bar to drag it by.
    #[test]
    fn a_window_too_big_for_its_screen_starts_at_the_corner() {
        let work = WorkArea {
            origin: (100.0, 50.0),
            size: (300.0, 200.0),
            scale: 1.0,
        };
        assert_eq!(opening_position(work, DEFAULT_SIZE), work.origin);
    }

    /// A window CENTRED on a smaller one hangs off it on both sides — the two stay concentric, where clamping
    /// the offset to zero would shove it into a corner. A workspace dragged narrower than the close dialog is
    /// a state a user can reach, not a hypothetical.
    #[test]
    fn a_window_larger_than_the_one_it_is_about_stays_concentric() {
        let at = centered(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(400, 200),
            PhysicalSize::new(460, 300),
        );
        assert_eq!(at, PhysicalPosition::new(-30, -50));
    }
}
