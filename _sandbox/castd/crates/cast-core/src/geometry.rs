//! Rectangles and row bands of the picture, and the sizes a resizable screen may take.

/// Rows [y0, y1) of the picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Band {
    pub y0: u32,
    pub y1: u32,
}

/// A rectangle of the screen, in screen pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    /// Parses `x,y,w,h`.
    pub fn parse(s: &str) -> Option<Rect> {
        let n: Vec<u32> = s
            .split(',')
            .map(|p| p.trim().parse().ok())
            .collect::<Option<_>>()?;
        match n[..] {
            [x, y, w, h] if w > 0 && h > 0 => Some(Rect { x, y, w, h }),
            _ => None,
        }
    }

    /// This rectangle inside a `sw`x`sh` screen, its size rounded down to even (4:2:0) and at least 16x16. None when
    /// nothing of it is on screen.
    pub fn fit(self, sw: u32, sh: u32) -> Option<Rect> {
        if self.x >= sw || self.y >= sh {
            return None;
        }
        let w = self.w.min(sw - self.x) & !1;
        let h = self.h.min(sh - self.y) & !1;
        (w >= 16 && h >= 16).then_some(Rect { w, h, ..self })
    }

    /// A damage rectangle in screen pixels, clipped to this one and moved into its coordinates: (x0, y0, x1, y1).
    pub fn clip(&self, x: i32, y: i32, w: i32, h: i32) -> Option<(u32, u32, u32, u32)> {
        let (cx0, cy0) = (self.x as i64, self.y as i64);
        let (cx1, cy1) = (cx0 + self.w as i64, cy0 + self.h as i64);
        let x0 = (x as i64).max(cx0);
        let y0 = (y as i64).max(cy0);
        let x1 = (x as i64 + w as i64).min(cx1);
        let y1 = (y as i64 + h as i64).min(cy1);
        (x1 > x0 && y1 > y0).then(|| {
            (
                (x0 - cx0) as u32,
                (y0 - cy0) as u32,
                (x1 - cx0) as u32,
                (y1 - cy0) as u32,
            )
        })
    }
}

/// The smallest and the largest screen a resize may set, (width, height) each.
pub type ResizeLimits = ((u32, u32), (u32, u32));

/// Smallest screen a viewer may ask for: a phone's narrowest box, and room for the encoder's 16-pixel blocks.
pub const MIN: (u32, u32) = (64, 64);

/// A size the screen can take: within [min, max], both sides even (4:2:0 video), rounding down. Where the maximum is
/// below the minimum, that side stays at the maximum.
pub fn fit(w: u32, h: u32, min: (u32, u32), max: (u32, u32)) -> (u32, u32) {
    // clamp panics when min > max, and a viewer's resize must never take castd down.
    (
        w.clamp(min.0.min(max.0), max.0) & !1,
        h.clamp(min.1.min(max.1), max.1) & !1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_crop_parses_and_fits_the_screen() {
        assert_eq!(
            Rect::parse("10, 20,301,201"),
            Some(Rect {
                x: 10,
                y: 20,
                w: 301,
                h: 201
            })
        );
        assert_eq!(Rect::parse("1,2,3"), None);
        assert_eq!(Rect::parse("1,2,0,4"), None);
        assert_eq!(Rect::parse("a,b,c,d"), None);
        let r = Rect {
            x: 100,
            y: 50,
            w: 301,
            h: 1000,
        };
        assert_eq!(
            r.fit(1280, 800),
            Some(Rect {
                x: 100,
                y: 50,
                w: 300,
                h: 750
            })
        );
        assert_eq!(r.fit(100, 800), None);
    }

    #[test]
    fn damage_is_clipped_to_the_crop_and_moved_into_it() {
        let crop = Rect {
            x: 100,
            y: 50,
            w: 200,
            h: 100,
        };
        assert_eq!(crop.clip(0, 0, 50, 50), None);
        assert_eq!(crop.clip(90, 40, 20, 20), Some((0, 0, 10, 10)));
        assert_eq!(crop.clip(150, 60, 10, 10), Some((50, 10, 60, 20)));
        assert_eq!(crop.clip(0, 0, 4000, 4000), Some((0, 0, 200, 100)));
        assert_eq!(crop.clip(300, 50, 10, 10), None);
        assert_eq!(crop.clip(-5, -5, 200, 100), Some((0, 0, 95, 45)));
    }

    #[test]
    fn fit_stays_within_min_and_max_and_even() {
        let (min, max) = (MIN, (3840, 2400));
        assert_eq!(fit(1921, 1081, min, max), (1920, 1080));
        assert_eq!(fit(1279, 879, min, max), (1278, 878));
        assert_eq!(fit(10, 10, min, max), MIN);
        assert_eq!(fit(9999, 9999, min, max), max);
    }

    #[test]
    fn fit_handles_a_maximum_below_the_minimum() {
        assert_eq!(fit(1920, 1080, (640, 480), (600, 400)), (600, 400));
        assert_eq!(fit(100, 100, (640, 480), (800, 450)), (640, 450));
    }
}
