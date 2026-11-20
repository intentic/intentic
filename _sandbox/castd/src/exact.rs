//! Where a viewer on this computer's loopback has an exact picture. Such a viewer (one that asked for browser-wire's
//! `lossless` and reaches castd through netd's loopback port) gets every video frame `clip`ped to the part of its
//! picture that is not exact yet, and, once the screen is still, an exact copy of that part (`lossless`), after which
//! none of it needs drawing again until something changes there. One rectangle per viewer, the bounding box of what
//! video drew since the last copy: a frame's clip is what it changed plus everything already lossy, so nothing exact is
//! ever drawn over with a lossy picture, and a copy that covers the box leaves the viewer exact everywhere.

use crate::capture::Rect;

/// One viewer's exactness, kept by the encode thread as it sends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Exact {
    /// The part of the viewer's picture video drew since its last exact copy; None when all of it is exact.
    pub lossy: Option<Rect>,
    /// The id of the last video frame sent to the viewer: the one an exact copy is drawn after.
    pub last_id: u32,
}

/// The smallest rectangle holding both.
pub fn union(a: Rect, b: Rect) -> Rect {
    let x0 = a.x.min(b.x);
    let y0 = a.y.min(b.y);
    let x1 = (a.x + a.w).max(b.x + b.w);
    let y1 = (a.y + a.h).max(b.y + b.h);
    Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

/// Whether `outer` holds all of `inner`.
pub fn contains(outer: Rect, inner: Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.w <= outer.x + outer.w
        && inner.y + inner.h <= outer.y + outer.h
}

/// Whether the two share any pixel.
pub fn overlaps(a: Rect, b: Rect) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/// The bounding box of the macroblocks marked in `map` (16x16 each, `cols` to a row), inside a `width`x`height`
/// picture. None when none is.
pub fn bounding_box(map: &[u8], cols: usize, width: u32, height: u32) -> Option<Rect> {
    if cols == 0 {
        return None;
    }
    let (mut c0, mut r0, mut c1, mut r1) = (usize::MAX, usize::MAX, 0, 0);
    for (i, _) in map.iter().enumerate().filter(|(_, d)| **d != 0) {
        let (row, col) = (i / cols, i % cols);
        c0 = c0.min(col);
        r0 = r0.min(row);
        c1 = c1.max(col + 1);
        r1 = r1.max(row + 1);
    }
    if c1 == 0 {
        return None;
    }
    let x = (c0 * 16) as u32;
    let y = (r0 * 16) as u32;
    let x1 = ((c1 * 16) as u32).min(width);
    let y1 = ((r1 * 16) as u32).min(height);
    (x1 > x && y1 > y).then_some(Rect {
        x,
        y,
        w: x1 - x,
        h: y1 - y,
    })
}

/// The rectangle a video frame `id` is drawn in for the viewer, which it then counts as lossy. `starting`: the frame is
/// the keyframe its picture starts from (a new viewer, a restart), drawn whole. `changed`: what the frame changed.
/// Everything already lossy is drawn again too: a refinement there only makes it better, and a bounding box drawn
/// whole is what keeps one rectangle enough.
pub fn frame_clip(
    st: &mut Exact,
    id: u32,
    starting: bool,
    changed: Option<Rect>,
    whole: Rect,
) -> Rect {
    st.last_id = id;
    let clip = if starting {
        Some(whole)
    } else {
        match (st.lossy, changed) {
            (Some(l), Some(c)) => Some(union(l, c)),
            (l, c) => l.or(c),
        }
    };
    st.lossy = clip;
    clip.unwrap_or(Rect {
        x: 0,
        y: 0,
        w: 0,
        h: 0,
    })
}

/// Whether an exact copy of `copied` is worth sending to the viewer: it covers part of what is lossy.
pub fn wants_copy(st: &Exact, copied: Rect) -> bool {
    st.lossy.is_some_and(|l| overlaps(l, copied))
}

/// Notes that the viewer was sent an exact copy of `copied`: all exact when it covers the lossy box, else the box
/// stays (what video drew after the copy was read is outside it, and the next copy takes it).
pub fn copied(st: &mut Exact, copied: Rect) {
    if st.lossy.is_some_and(|l| contains(copied, l)) {
        st.lossy = None;
    }
}

/// When an exact copy is due: once the screen has been still for `wait`. A copy the screen moves under before it has
/// held that long (an animation that pauses between steps) was wasted, so the next one waits twice as long, up to
/// [`MAX_COPY_WAIT`]; one that holds brings the wait back to the base. Measured 2026-11-20 on a page of 60 animated
/// cards at 16-18 fps, whose frames now and then came 100 ms apart: without it castd sent a whole-screen copy every
/// 250 ms or so, 29 MB/s at 2560x1600, each drawn over by the next frame.
#[derive(Debug, Clone, Copy)]
pub struct CopyPace {
    base: std::time::Duration,
    wait: std::time::Duration,
    /// A copy went out and has not yet held for `wait`.
    unproven: bool,
}

/// The longest a copy waits for the screen to hold still after copies kept being drawn over.
pub const MAX_COPY_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

impl CopyPace {
    pub fn new(base: std::time::Duration) -> Self {
        CopyPace {
            base,
            wait: base,
            unproven: false,
        }
    }

    /// How long the screen must be still before the next copy.
    pub fn wait(&self) -> std::time::Duration {
        self.wait
    }

    /// Notes a copy sent now.
    pub fn sent(&mut self) {
        self.unproven = true;
    }

    /// Notes that the screen moved, `since_copy` after the last copy.
    pub fn moved(&mut self, since_copy: std::time::Duration) {
        if self.unproven && since_copy < self.wait {
            self.wait = (self.wait * 2).min(MAX_COPY_WAIT);
        }
        self.unproven = false;
    }

    /// Notes that nothing moved for `since_copy` after the last copy: once that is its wait, the copy held.
    pub fn still(&mut self, since_copy: std::time::Duration) {
        if self.unproven && since_copy >= self.wait {
            self.wait = self.base;
            self.unproven = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: u32, y: u32, w: u32, h: u32) -> Rect {
        Rect { x, y, w, h }
    }

    const WHOLE: Rect = Rect {
        x: 0,
        y: 0,
        w: 1280,
        h: 880,
    };

    #[test]
    fn a_starting_keyframe_is_drawn_whole_and_leaves_all_of_it_lossy() {
        let mut st = Exact::default();
        assert_eq!(frame_clip(&mut st, 1, true, None, WHOLE), WHOLE);
        assert_eq!(
            st,
            Exact {
                lossy: Some(WHOLE),
                last_id: 1
            }
        );
    }

    #[test]
    fn a_frame_draws_what_it_changed_and_what_is_still_lossy() {
        let mut st = Exact::default();
        // Exact everywhere: only the typed glyph is drawn.
        assert_eq!(
            frame_clip(&mut st, 7, false, Some(r(32, 48, 16, 16)), WHOLE),
            r(32, 48, 16, 16)
        );
        // The next glyph widens the box over both.
        assert_eq!(
            frame_clip(&mut st, 8, false, Some(r(48, 48, 16, 16)), WHOLE),
            r(32, 48, 32, 16)
        );
        // A paint-over changes nothing and sharpens only what is lossy.
        assert_eq!(
            frame_clip(&mut st, 9, false, None, WHOLE),
            r(32, 48, 32, 16)
        );
        assert_eq!(st.last_id, 9);
    }

    #[test]
    fn a_frame_that_changes_nothing_on_an_exact_picture_draws_nothing() {
        let mut st = Exact::default();
        assert_eq!(frame_clip(&mut st, 3, false, None, WHOLE), r(0, 0, 0, 0));
        assert_eq!(st.lossy, None);
    }

    #[test]
    fn a_copy_over_the_whole_box_makes_it_exact_and_a_smaller_one_does_not() {
        let mut st = Exact {
            lossy: Some(r(32, 48, 32, 16)),
            last_id: 8,
        };
        assert!(!wants_copy(&st, r(400, 400, 16, 16)));
        assert!(wants_copy(&st, r(40, 40, 16, 16)));
        copied(&mut st, r(40, 40, 16, 16));
        assert_eq!(st.lossy, Some(r(32, 48, 32, 16)));
        copied(&mut st, r(32, 48, 32, 16));
        assert_eq!(st.lossy, None);
        assert!(!wants_copy(&st, WHOLE));
    }

    #[test]
    fn the_damage_map_bounds_its_marked_blocks_inside_the_picture() {
        // 3 columns by 2 rows of blocks over a 40x20 picture: the last column and row are partial.
        let mut map = vec![0u8; 6];
        assert_eq!(bounding_box(&map, 3, 40, 20), None);
        map[1] = 1;
        assert_eq!(bounding_box(&map, 3, 40, 20), Some(r(16, 0, 16, 16)));
        map[5] = 1;
        assert_eq!(bounding_box(&map, 3, 40, 20), Some(r(16, 0, 24, 20)));
        assert_eq!(bounding_box(&map, 0, 40, 20), None);
    }

    #[test]
    fn copies_the_screen_draws_over_at_once_wait_longer_until_one_holds() {
        use std::time::Duration;
        let ms = Duration::from_millis;
        let mut pace = CopyPace::new(ms(100));
        assert_eq!(pace.wait(), ms(100));
        // A copy, then a frame 20 ms later: wasted, so the next waits twice as long.
        pace.sent();
        pace.moved(ms(20));
        assert_eq!(pace.wait(), ms(200));
        for _ in 0..10 {
            pace.sent();
            pace.moved(ms(30));
        }
        assert_eq!(pace.wait(), MAX_COPY_WAIT);
        // Motion with no copy out says nothing about copies.
        pace.moved(ms(5));
        assert_eq!(pace.wait(), MAX_COPY_WAIT);
        // A copy that held for its whole wait brings it back to the base.
        pace.sent();
        pace.still(ms(1999));
        assert_eq!(pace.wait(), MAX_COPY_WAIT);
        pace.still(MAX_COPY_WAIT);
        assert_eq!(pace.wait(), ms(100));
        // Motion long after a copy that held changes nothing (a caret's blink after a keystroke's copy).
        pace.sent();
        pace.moved(ms(430));
        assert_eq!(pace.wait(), ms(100));
    }

    #[test]
    fn rectangles_join_hold_and_meet_by_their_pixels() {
        assert_eq!(union(r(0, 0, 10, 10), r(20, 5, 5, 20)), r(0, 0, 25, 25));
        assert!(contains(r(0, 0, 10, 10), r(2, 2, 8, 8)));
        assert!(!contains(r(0, 0, 10, 10), r(2, 2, 9, 8)));
        assert!(overlaps(r(0, 0, 10, 10), r(9, 9, 5, 5)));
        assert!(!overlaps(r(0, 0, 10, 10), r(10, 0, 5, 5)));
    }
}
