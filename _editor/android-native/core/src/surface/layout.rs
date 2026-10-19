//! Where rows sit, measured from the bottom: the newest row's bottom is at 0 and the scroll offset is how far the
//! viewport has moved up from there, so a chat opens at its end without measuring what is above. Rows are measured
//! (shaped) only when the walk up from the bottom reaches them; a row never reached counts as the average of the
//! measured ones, which only the estimate of how far one can scroll uses. When the walk reaches the first row the top
//! is known and the scroll is clamped to it.
//!
//! A row the stream changed or added is re-measured before anything is placed. At the bottom (offset 0) the view
//! stays there, so a growing answer stays in sight; scrolled up, the offset grows by what the rows from the one at the
//! viewport's top edge down grew, so what is on screen does not move, as RecyclerView's anchoring keeps it in arm A.

/// An offset this close to 0 is at the bottom, and stays there as rows grow.
pub(crate) const PINNED: f32 = 0.5;

#[derive(Default)]
pub(crate) struct Layout {
    /// Each row's height, `None` until it is first measured.
    heights: Vec<Option<f32>>,
    /// Changed since it was measured; its old height stands until it is measured again.
    stale: Vec<bool>,
    /// How many rows the previous placement knew of: rows past it are new. `None` before the first placement, when
    /// no row is new.
    known: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Placed {
    pub index: usize,
    /// The row's top, in pixels from the viewport's top.
    pub top: f32,
}

#[derive(Debug)]
pub(crate) struct Placement {
    /// The rows the viewport shows, newest first.
    pub rows: Vec<Placed>,
    /// The offset actually used: clamped to the content, and moved by the rows that grew below the viewport.
    pub scroll: f32,
    /// The largest offset, exact once the first row has been measured, an estimate until then.
    pub max_scroll: f32,
    /// The requested offset was past an end of the content.
    pub clamped: bool,
}

impl Layout {
    pub fn changed(&mut self, index: usize) {
        if let Some(stale) = self.stale.get_mut(index) {
            *stale = true;
        }
    }

    /// Forgets every height, for a new text width.
    pub fn reset(&mut self) {
        self.heights.iter_mut().for_each(|height| *height = None);
        self.stale.iter_mut().for_each(|stale| *stale = false);
    }

    fn sync(&mut self, count: usize) {
        self.heights.resize(count, None);
        self.stale.resize(count, false);
    }

    fn measured(&mut self, index: usize, measure: &mut dyn FnMut(usize) -> f32) -> f32 {
        match self.heights[index] {
            Some(height) if !self.stale[index] => height,
            _ => {
                let height = measure(index);
                self.heights[index] = Some(height);
                self.stale[index] = false;
                height
            }
        }
    }

    /// How much the rows from the one under the viewport's top edge down grew since the last placement.
    fn growth_below_top(
        &mut self,
        count: usize,
        edge: f32,
        measure: &mut dyn FnMut(usize) -> f32,
    ) -> f32 {
        let known = self.known.unwrap_or(count).min(count);
        let mut bottom = 0.0;
        let mut anchor = count;
        for index in (0..count).rev() {
            let height = if index >= known {
                0.0
            } else {
                match self.heights[index] {
                    Some(height) => height,
                    None => break,
                }
            };
            anchor = index;
            if bottom + height > edge {
                break;
            }
            bottom += height;
        }
        let mut growth = 0.0;
        for index in anchor..count {
            let before = if index >= known {
                Some(0.0)
            } else {
                self.heights[index]
            };
            if self.stale[index] || self.heights[index].is_none() {
                let after = self.measured(index, measure);
                growth += after - before.unwrap_or(after);
            }
        }
        growth
    }

    /// Places `count` rows in a viewport `viewport` pixels tall at `scroll` pixels up from the bottom, measuring the
    /// rows it needs with `measure`.
    pub fn place(
        &mut self,
        count: usize,
        scroll: f32,
        viewport: f32,
        measure: &mut dyn FnMut(usize) -> f32,
    ) -> Placement {
        self.sync(count);
        let viewport = viewport.max(0.0);
        let below_bottom = scroll < 0.0;
        let mut scroll = if scroll.is_finite() {
            scroll.max(0.0)
        } else {
            0.0
        };
        if scroll > PINNED {
            scroll += self.growth_below_top(count, scroll + viewport, measure);
        }
        self.known = Some(count);

        // Up from the bottom until past the viewport's top edge: (index, its bottom, its height).
        let mut walked = Vec::new();
        let mut bottom = 0.0;
        let mut top_reached = count == 0;
        for index in (0..count).rev() {
            if bottom > scroll + viewport {
                break;
            }
            let height = self.measured(index, measure);
            walked.push((index, bottom, height));
            bottom += height;
            top_reached = index == 0;
        }

        let max_scroll = if top_reached {
            (bottom - viewport).max(0.0)
        } else {
            let (sum, measured) = self
                .heights
                .iter()
                .flatten()
                .fold((0.0, 0usize), |(sum, measured), height| {
                    (sum + height, measured + 1)
                });
            let average = if measured == 0 {
                viewport
            } else {
                sum / measured as f32
            };
            (sum + average * (count - measured) as f32 - viewport).max(scroll)
        };
        let clamped = below_bottom || scroll > max_scroll;
        let scroll = scroll.min(max_scroll);

        let rows = walked
            .iter()
            .filter(|(_, bottom, height)| bottom + height > scroll && *bottom < scroll + viewport)
            .map(|&(index, bottom, height)| Placed {
                index,
                top: viewport + scroll - bottom - height,
            })
            .collect();
        Placement {
            rows,
            scroll,
            max_scroll,
            clamped,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rows of the given heights, counting how many were measured.
    struct Rows {
        heights: Vec<f32>,
        measured: usize,
    }

    impl Rows {
        fn new(count: usize, height: f32) -> Self {
            Rows {
                heights: vec![height; count],
                measured: 0,
            }
        }

        fn place(&mut self, layout: &mut Layout, scroll: f32, viewport: f32) -> Placement {
            let heights = self.heights.clone();
            let measured = &mut self.measured;
            layout.place(heights.len(), scroll, viewport, &mut |index| {
                *measured += 1;
                heights[index]
            })
        }
    }

    fn indices(placement: &Placement) -> Vec<usize> {
        placement.rows.iter().map(|row| row.index).collect()
    }

    #[test]
    fn opens_at_the_bottom_measuring_only_what_shows() {
        let mut rows = Rows::new(2000, 100.0);
        let mut layout = Layout::default();
        let placement = rows.place(&mut layout, 0.0, 450.0);
        assert_eq!(indices(&placement), [1999, 1998, 1997, 1996, 1995]);
        assert_eq!(
            placement.rows[0].top, 350.0,
            "the newest row ends at the viewport's bottom"
        );
        assert!(rows.measured <= 6, "measured {} rows", rows.measured);
        assert!(
            (placement.max_scroll - (200_000.0 - 450.0)).abs() < 1.0,
            "unmeasured rows are estimated at the average"
        );
    }

    #[test]
    fn clamps_to_the_top_once_it_is_reached() {
        let mut rows = Rows::new(10, 100.0);
        let mut layout = Layout::default();
        let placement = rows.place(&mut layout, 5_000.0, 450.0);
        assert!(placement.clamped);
        assert_eq!(placement.scroll, 550.0);
        assert_eq!(
            placement.rows.last().map(|row| (row.index, row.top)),
            Some((0, 0.0))
        );
        let below = rows.place(&mut layout, -20.0, 450.0);
        assert!(below.clamped);
        assert_eq!(below.scroll, 0.0);
    }

    #[test]
    fn short_content_sits_at_the_bottom() {
        let mut rows = Rows::new(2, 100.0);
        let placement = rows.place(&mut Layout::default(), 0.0, 450.0);
        assert_eq!(placement.max_scroll, 0.0);
        assert_eq!(
            placement.rows.iter().map(|row| row.top).collect::<Vec<_>>(),
            [350.0, 250.0]
        );
    }

    #[test]
    fn stays_at_the_bottom_while_the_last_row_grows_and_rows_arrive() {
        let mut rows = Rows::new(100, 100.0);
        let mut layout = Layout::default();
        rows.place(&mut layout, 0.0, 450.0);
        rows.heights[99] = 300.0;
        layout.changed(99);
        rows.heights.push(80.0);
        let placement = rows.place(&mut layout, 0.0, 450.0);
        assert_eq!(placement.scroll, 0.0);
        assert_eq!(
            placement.rows[0],
            Placed {
                index: 100,
                top: 370.0
            }
        );
        assert_eq!(
            placement.rows[1],
            Placed {
                index: 99,
                top: 70.0
            }
        );
    }

    #[test]
    fn keeps_what_is_on_screen_still_when_scrolled_up() {
        let mut rows = Rows::new(100, 100.0);
        let mut layout = Layout::default();
        let before = rows.place(&mut layout, 1_000.0, 450.0);
        rows.heights[99] = 300.0;
        layout.changed(99);
        rows.heights.push(80.0);
        let after = rows.place(&mut layout, before.scroll, 450.0);
        assert_eq!(after.scroll, 1_000.0 + 200.0 + 80.0);
        assert_eq!(after.rows, before.rows, "the same rows, at the same places");
    }
}
