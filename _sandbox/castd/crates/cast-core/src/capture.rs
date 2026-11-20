//! What a platform implements for the picture: a [`ScreenSource`] (one screen, or a region of it) that opens a
//! [`Capture`] at the current geometry, and opens it again after every change of size. The pipeline (video.rs) owns
//! the capture on its own thread (named `capture`): it waits on [`Capture::waitable`] and the hub's wake together, takes
//! damage with [`Capture::pump`], and once a frame is due asks the capture to bring the damaged rows into the frame
//! the encoder reads next ([`Capture::grab`], [`Capture::fill`]). Nothing is captured, converted or encoded while the
//! screen is still.
//!
//! - **X11** (cast-x11): XDamage on the root window says what changed; pixels are read in place from Xvfb's `-shmem`
//!   framebuffer, or fetched band by band with MIT-SHM GetImage. `pixels` is that memory.
//! - **DXGI** (a Windows backend, voxl's scheme): a thread of the capture's own runs `AcquireNextFrame`, adds each
//!   frame's dirty and move rectangles to the [`Damage`] it shares, and signals a [`Wake`](crate::wake::Wake) that is
//!   the `waitable`. A CPU path copies the damaged rectangles of the desktop texture into a staging texture and maps it
//!   (`pixels`); the zero-copy path answers `formats` with `Native`, makes D3D11 textures in `new_frame`, copies the
//!   damaged rows on the GPU in `fill`, and an encoder on the same device (NVENC on D3D11, a Media Foundation MFT)
//!   reads them through `Picture::Native` without the picture ever reaching the CPU. Duplication leaves the pointer
//!   out of the picture, as castd's X11 hides it: viewers draw it from `cursor` messages.

use crate::convert::convert_band;
use crate::frame::{Frame, FrameFormat};
use crate::geometry::{Band, Rect, ResizeLimits};
use crate::wake::Waitable;
use std::time::Instant;

/// What changed since the pipeline last looked, kept by the capture as the platform reports it: the rows a frame must
/// convert, the 16x16 macroblocks the encoder may skip, and the rectangles `/wait` counts. Damage is in picture pixels
/// (a crop's origin taken off).
pub struct Damage {
    width: u32,
    height: u32,
    /// Something changed since the last take (or nothing has been taken yet).
    pub damaged: bool,
    /// When the first damage since the last take arrived: a frame's capture time, and how long the burst coalesces.
    pub damaged_at: Option<Instant>,
    /// Rows touched since the last take.
    acc: Option<(u32, u32)>,
    /// Macroblocks (16x16) touched since the last take, row-major.
    mb_dirty: Vec<u8>,
    pub mb_cols: usize,
    /// Areas (x0, y0, x1, y1) changed since the pipeline last noted them for `/wait`.
    pub changes: Vec<(u32, u32, u32, u32)>,
}

impl Damage {
    /// Damage for a `width` x `height` picture, all of it pending: the first frame is the whole picture.
    pub fn new(width: u32, height: u32) -> Damage {
        let mb_cols = (width as usize).div_ceil(16);
        Damage {
            width,
            height,
            damaged: true,
            damaged_at: None,
            acc: None,
            mb_dirty: vec![0; mb_cols * (height as usize).div_ceil(16)],
            mb_cols,
            changes: Vec::new(),
        }
    }

    /// Notes that [x0, x1) x [y0, y1) of the picture changed (clamped to it; nothing for an empty area).
    pub fn add(&mut self, x0: u32, y0: u32, x1: u32, y1: u32) {
        let (x1, y1) = (x1.min(self.width), y1.min(self.height));
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let (c0, c1) = (x0 as usize / 16, (x1 as usize).div_ceil(16));
        for row in (y0 as usize / 16)..(y1 as usize).div_ceil(16) {
            self.mb_dirty[row * self.mb_cols + c0..row * self.mb_cols + c1].fill(1);
        }
        self.changes.push((x0, y0, x1, y1));
        self.acc = Some(match self.acc {
            Some((a, b)) => (a.min(y0), b.max(y1)),
            None => (y0, y1),
        });
        self.damaged = true;
        self.damaged_at.get_or_insert_with(Instant::now);
    }

    /// Takes the rows that changed as one band, aligned to even rows for 4:2:0.
    pub fn take_band(&mut self) -> Option<Band> {
        self.damaged = false;
        self.damaged_at = None;
        let (y0, y1) = self.acc.take()?;
        Some(Band {
            y0: y0 & !1,
            y1: ((y1 + 1) & !1).min(self.height),
        })
    }

    /// Takes the dirty-macroblock map accumulated with the current damage.
    pub fn take_mb_map(&mut self) -> Vec<u8> {
        let n = self.mb_dirty.len();
        std::mem::replace(&mut self.mb_dirty, vec![0; n])
    }

    /// Every row of the picture.
    pub fn full(&self) -> Band {
        Band {
            y0: 0,
            y1: self.height,
        }
    }
}

/// One capture of the screen at one geometry. Rebuilt (a new one opened by the [`ScreenSource`]) when the screen
/// changes size, a crop moves, or the platform loses it.
pub trait Capture: Send {
    /// The picture: the whole screen, or the crop of it, in screen pixels; its size is even.
    fn area(&self) -> Rect;
    /// The whole screen's size.
    fn screen(&self) -> (u32, u32);
    /// Whether the picture is a crop of the screen (`--crop`).
    fn cropped(&self) -> bool;
    /// The damage this capture keeps, which `pump` adds to.
    fn damage(&mut self) -> &mut Damage;
    /// What the capture thread waits on beside the hub's wake for the platform's news: an X connection's socket, a
    /// DXGI thread's own wake. None to be woken by the hub alone (and by the timeouts the pipeline keeps).
    fn waitable(&self) -> Option<Waitable<'_>>;
    /// Takes what the platform reported since the last call, without blocking: damage, a change of size.
    fn pump(&mut self) -> Result<(), String>;
    /// The screen changed size (or the platform lost it): the pipeline drains and opens a new capture.
    fn needs_rebuild(&self) -> bool;
    /// Whether an error this capture returned came from a change of size racing it, which ends the capture without
    /// ending the process. Asked only after an error.
    fn geometry_changed(&self) -> bool {
        false
    }
    /// Brings `band` of the screen into what `pixels` (or `fill`) reads: a GetImage, a staging copy. Nothing where the
    /// pixels are read in place.
    fn grab(&mut self, band: Band) -> Result<(), String> {
        let _ = band;
        Ok(())
    }
    /// The current picture in memory as BGRX from its first pixel, and its stride. None for a capture whose picture is
    /// not in memory (on the GPU), which then implements `fill`, `snapshot` and `region` itself.
    fn pixels(&self) -> Option<(&[u8], usize)>;
    /// The frame formats `fill` writes, the best first. The CPU ones by default.
    fn formats(&self) -> &[FrameFormat] {
        &[FrameFormat::I420, FrameFormat::Bgra]
    }
    /// A frame of the picture's size in `format`, one of `formats`.
    fn new_frame(&mut self, format: FrameFormat) -> Result<Frame, String> {
        let a = self.area();
        Frame::cpu(format, a.w as usize, a.h as usize)
            .ok_or_else(|| "this capture makes no native frames".to_string())
    }
    /// Writes rows [y0, y1) (even) of the current picture into `dst`, on up to `threads` threads.
    fn fill(
        &mut self,
        dst: &mut Frame,
        y0: usize,
        y1: usize,
        threads: usize,
    ) -> Result<(), String> {
        let Some((px, stride)) = self.pixels() else {
            return Err("this capture keeps no picture in memory".into());
        };
        match dst {
            Frame::I420(buf) => convert_band(px, stride, buf, y0, y1, threads),
            Frame::Bgra(buf) => buf.copy_rows(px, stride, y0, y1),
            Frame::Native(_) => return Err("this capture makes no native frames".into()),
        }
        Ok(())
    }
    /// The whole picture as packed BGRX (`width * 4` bytes a row), for a screenshot, with the damage for exactly these
    /// pixels taken into `damage().changes` (a screenshot's `/wait` sequence covers what it shows).
    fn snapshot(&mut self) -> Result<Vec<u8>, String> {
        self.pump()?;
        let a = self.area();
        self.grab(Band { y0: 0, y1: a.h })?;
        Ok(copy_out(self.pixels(), Rect { x: 0, y: 0, ..a }))
    }
    /// An exact copy of `r` (picture pixels, clamped to the picture) as packed BGRX: what a `lossless` message carries.
    /// Asked for once the screen has been still; a repaint that lands meanwhile brings its own damage.
    fn region(&mut self, r: Rect) -> Result<Vec<u8>, String> {
        let a = self.area();
        let x = r.x.min(a.w);
        let y = r.y.min(a.h);
        let r = Rect {
            x,
            y,
            w: r.w.min(a.w - x),
            h: r.h.min(a.h - y),
        };
        self.grab(Band { y0: y, y1: y + r.h })?;
        Ok(copy_out(self.pixels(), r))
    }
}

/// `r` of a picture in memory, packed. Nothing where there is no picture in memory.
fn copy_out(pixels: Option<(&[u8], usize)>, r: Rect) -> Vec<u8> {
    let Some((px, stride)) = pixels else {
        return Vec::new();
    };
    let row = r.w as usize * 4;
    let mut out = Vec::with_capacity(row * r.h as usize);
    for line in r.y..r.y + r.h {
        let at = line as usize * stride + r.x as usize * 4;
        out.extend_from_slice(&px[at..at + row]);
    }
    out
}

/// One screen a platform captures: castd's is an X display (cast-x11); a Windows backend's a DXGI output.
pub trait ScreenSource: Send + 'static {
    /// Opens a capture of the screen, or of `crop` of it (screen pixels, fitted to the screen).
    fn open(&mut self, crop: Option<Rect>) -> Result<Box<dyn Capture>, String>;
    /// The smallest and the largest size `resize` may set; None when the screen keeps its size (a monitor that is
    /// someone's own display, a crop). Viewers' boxes then only change the scale.
    fn resize_limits(&self) -> Option<ResizeLimits> {
        None
    }
    /// Resizes the screen to `w` x `h` (within the limits, even), between two captures: the pipeline has drained the
    /// old one and opens a new one after.
    fn resize(&mut self, w: u32, h: u32) -> Result<(), String> {
        Err(format!("this screen cannot be resized to {w}x{h}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn damage_accumulates_rows_blocks_and_changes_until_taken() {
        let mut d = Damage::new(100, 50);
        assert!(
            d.damaged,
            "a new capture's first frame is the whole picture"
        );
        assert_eq!(d.take_band(), None);
        d.add(10, 3, 20, 9);
        d.add(40, 30, 200, 41);
        assert!(d.damaged && d.damaged_at.is_some());
        assert_eq!(d.changes, [(10, 3, 20, 9), (40, 30, 100, 41)]);
        let map = d.take_mb_map();
        // Blocks (0,0), (1,0) for the first; (2..7, 1..3) for the second, clamped to the picture.
        assert_eq!(map.iter().filter(|&&m| m == 1).count(), 2 + 5 * 2);
        assert_eq!(map[0..2], [1, 1]);
        assert_eq!(d.take_band(), Some(Band { y0: 2, y1: 42 }));
        assert!(!d.damaged && d.damaged_at.is_none());
        assert_eq!(d.take_mb_map(), vec![0; map.len()]);
        // Nothing of an empty area, and the last row rounds up to the even height at most.
        d.add(5, 5, 5, 9);
        assert_eq!(d.take_band(), None);
        d.add(0, 49, 1, 50);
        assert_eq!(d.take_band(), Some(Band { y0: 48, y1: 50 }));
    }

    /// A capture whose picture is a buffer in memory: the defaults do the rest.
    struct Memory {
        w: u32,
        h: u32,
        px: Vec<u8>,
        damage: Damage,
    }

    impl Capture for Memory {
        fn area(&self) -> Rect {
            Rect {
                x: 0,
                y: 0,
                w: self.w,
                h: self.h,
            }
        }
        fn screen(&self) -> (u32, u32) {
            (self.w, self.h)
        }
        fn cropped(&self) -> bool {
            false
        }
        fn damage(&mut self) -> &mut Damage {
            &mut self.damage
        }
        fn waitable(&self) -> Option<Waitable<'_>> {
            None
        }
        fn pump(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn needs_rebuild(&self) -> bool {
            false
        }
        fn pixels(&self) -> Option<(&[u8], usize)> {
            Some((&self.px, self.w as usize * 4 + 8))
        }
    }

    #[test]
    fn a_capture_in_memory_snapshots_copies_regions_and_fills_frames_by_default() {
        let (w, h) = (6u32, 4u32);
        let stride = w as usize * 4 + 8;
        let px: Vec<u8> = (0..stride * h as usize).map(|i| i as u8).collect();
        let mut cap = Memory {
            w,
            h,
            px: px.clone(),
            damage: Damage::new(w, h),
        };
        let shot = cap.snapshot().unwrap();
        assert_eq!(shot.len(), (w * h * 4) as usize);
        assert_eq!(&shot[24..48], &px[stride..stride + 24]);
        let r = cap
            .region(Rect {
                x: 4,
                y: 3,
                w: 10,
                h: 10,
            })
            .unwrap();
        // Clamped to the 2x1 left at (4, 3).
        assert_eq!(r, px[3 * stride + 16..3 * stride + 24].to_vec());
        let mut f = cap.new_frame(FrameFormat::Bgra).unwrap();
        cap.fill(&mut f, 0, 4, 1).unwrap();
        let Frame::Bgra(b) = &f else { panic!() };
        assert_eq!(b.data, shot);
        let mut f = cap.new_frame(FrameFormat::I420).unwrap();
        cap.fill(&mut f, 0, 4, 1).unwrap();
        assert!(cap.new_frame(FrameFormat::Native).is_err());
    }
}
