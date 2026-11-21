//! The fallback where desktop duplication is not offered (a Remote Desktop session, a VM's basic display adapter, a
//! desktop already duplicated by four programs): GDI's BitBlt of the monitor's area of the screen, on a thread of the
//! capture's own, at most 30 times a second. GDI says nothing about what changed, so each picture is compared with the
//! last in tiles of 64x32 and only the tiles that differ become damage: a still screen costs the BitBlt and a compare,
//! and nothing is converted or encoded. The pointer is left out of the picture as with duplication; its shape comes
//! from `GetCursorInfo`.

use crate::displays::Display;
use cast_core::capture::{Capture, Damage};
use cast_core::geometry::{Band, Rect};
use cast_core::hub::Hub;
use cast_core::wake::{Waitable, Wake};
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC,
    CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW,
    HBITMAP, HDC, ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CURSOR_SHOWING, CURSORINFO, GetCursorInfo, GetIconInfo, HICON, ICONINFO,
};

const TILE_W: usize = 64;
const TILE_H: usize = 32;
const MIN_INTERVAL: Duration = Duration::from_millis(33);

struct Shared {
    /// The newest picture, BGRA, `w * 4` bytes a row.
    buf: Vec<u8>,
    rects: Vec<(u32, u32, u32, u32)>,
    failed: Option<String>,
}

pub struct GdiCapture {
    w: u32,
    h: u32,
    damage: Damage,
    wake: Arc<Wake>,
    shared: Arc<Mutex<Shared>>,
    /// What `pixels` reads: rows are copied in from `shared` at each grab.
    frame: Vec<u8>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    /// Set while duplication is refused: cleared, and the capture opened again, once a duplication works.
    retry: Option<Arc<AtomicBool>>,
    display: Display,
    last_retry: Instant,
    rebuild: bool,
    /// The screen's status, when its owner reports one: `gdi`, and the display off when it is.
    status: Option<crate::session::StatusCell>,
    display_off: bool,
}

/// How often a GDI capture standing in for duplication checks whether duplication works again.
const RETRY_EVERY: Duration = Duration::from_secs(5);

impl GdiCapture {
    pub fn open(
        display: &Display,
        hub: Arc<Hub>,
        retry: Option<Arc<AtomicBool>>,
        status: Option<crate::session::StatusCell>,
    ) -> Result<GdiCapture, String> {
        let (w, h) = (display.width() & !1, display.height() & !1);
        if w == 0 || h == 0 {
            return Err(format!("{} has no area", display.name));
        }
        let wake = Arc::new(Wake::new().map_err(|e| e.to_string())?);
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(Shared {
            buf: vec![0; w as usize * h as usize * 4],
            rects: Vec::new(),
            failed: None,
        }));
        let origin = (display.rect.left, display.rect.top);
        let thread = {
            let (shared, wake, stop) = (shared.clone(), wake.clone(), stop.clone());
            std::thread::Builder::new()
                .name(format!("gdi-{}", display.id))
                .spawn(move || poll(origin, (w, h), shared, wake, stop, hub))
                .map_err(|e| e.to_string())?
        };
        log::info!("capturing {} ({w}x{h}) with GDI", display.name);
        let mut me = GdiCapture {
            w,
            h,
            damage: Damage::new(w, h),
            wake,
            shared,
            frame: vec![0; w as usize * h as usize * 4],
            stop,
            thread: Some(thread),
            retry,
            display: display.clone(),
            last_retry: Instant::now(),
            rebuild: false,
            status,
            display_off: false,
        };
        if let Some(cell) = &me.status {
            // Keep the reason the source gave (duplication refused or not offered); a forced GDI says so.
            let mut next = cell.lock().clone();
            if next.via != "gdi" {
                next = crate::session::CaptureStatus {
                    reason: Some("GDI, as CAST_WIN_CAPTURE or the source asked".into()),
                    ..crate::session::CaptureStatus::new("gdi")
                };
            }
            crate::session::report(cell, &display.name, next);
        }
        let t = Instant::now();
        while me.shared.lock().rects.is_empty() && t.elapsed() < Duration::from_secs(1) {
            std::thread::sleep(Duration::from_millis(5));
        }
        me.grab(Band { y0: 0, y1: h })?;
        Ok(me)
    }
}

impl Capture for GdiCapture {
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
        Some(self.wake.waitable())
    }
    fn pump(&mut self) -> Result<(), String> {
        self.wake.drain();
        let rects = {
            let mut s = self.shared.lock();
            if let Some(e) = s.failed.take() {
                return Err(e);
            }
            std::mem::take(&mut s.rects)
        };
        for (x0, y0, x1, y1) in rects {
            self.damage.add(x0, y0, x1, y1);
        }
        if let Some(flag) = &self.retry
            && self.last_retry.elapsed() >= RETRY_EVERY
        {
            self.last_retry = Instant::now();
            // GDI reads a display Windows turned off as black: say so rather than pass it off as the desktop.
            let off = crate::session::display() == crate::session::Display::Off;
            if off != self.display_off
                && let Some(cell) = &self.status
            {
                self.display_off = off;
                let blocked = crate::session::Blocked::DisplayOff;
                let next = if off {
                    crate::session::CaptureStatus::blocked("gdi", blocked, None)
                } else {
                    crate::session::CaptureStatus {
                        reason: Some("desktop duplication refused; GDI stands in".into()),
                        ..crate::session::CaptureStatus::new("gdi")
                    }
                };
                crate::session::report(cell, &self.display.name, next);
            }
            if duplication_works(&self.display) {
                log::info!(
                    "{}: desktop duplication works again; leaving GDI",
                    self.display.name
                );
                flag.store(false, Ordering::Relaxed);
                self.rebuild = true;
            }
        }
        Ok(())
    }
    fn needs_rebuild(&self) -> bool {
        self.rebuild
    }
    fn geometry_changed(&self) -> bool {
        self.rebuild
    }
    fn grab(&mut self, band: Band) -> Result<(), String> {
        let row = self.w as usize * 4;
        let (a, b) = (band.y0 as usize * row, band.y1 as usize * row);
        let s = self.shared.lock();
        self.frame[a..b].copy_from_slice(&s.buf[a..b]);
        Ok(())
    }
    fn pixels(&self) -> Option<(&[u8], usize)> {
        Some((&self.frame, self.w as usize * 4))
    }
}

impl Drop for GdiCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Whether this monitor can be duplicated now (a duplication made and let go at once).
fn duplication_works(display: &Display) -> bool {
    use windows::Win32::Graphics::Dxgi::IDXGIOutput1;
    use windows::core::Interface;
    let Ok(dev) = crate::d3d::Device::new(&display.adapter) else {
        return false;
    };
    let Ok(o1) = display.output.cast::<IDXGIOutput1>() else {
        return false;
    };
    // SAFETY: a duplication on a device of the output's adapter, dropped at once.
    unsafe { o1.DuplicateOutput(&dev.device) }.is_ok()
}

/// A memory DC with a top-down 32-bit DIB section selected into it.
struct Surface {
    dc: HDC,
    bmp: HBITMAP,
    bits: *mut u8,
}

impl Surface {
    fn new(w: u32, h: u32) -> Option<Surface> {
        // SAFETY: a memory DC and a DIB section of this size, freed on drop.
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return None;
            }
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let Ok(bmp) = CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            else {
                let _ = DeleteDC(dc);
                return None;
            };
            SelectObject(dc, bmp.into());
            Some(Surface {
                dc,
                bmp,
                bits: bits.cast(),
            })
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        // SAFETY: what `new` made.
        unsafe {
            let _ = DeleteDC(self.dc);
            let _ = DeleteObject(self.bmp.into());
        }
    }
}

fn poll(
    origin: (i32, i32),
    (w, h): (u32, u32),
    shared: Arc<Mutex<Shared>>,
    wake: Arc<Wake>,
    stop: Arc<AtomicBool>,
    hub: Arc<Hub>,
) {
    crate::keep_display_on();
    let Some(surface) = Surface::new(w, h) else {
        shared.lock().failed = Some("GDI: no surface to capture into".into());
        wake.signal();
        return;
    };
    let len = w as usize * h as usize * 4;
    let mut last = vec![0u8; len];
    let mut first = true;
    let mut cursor: Option<isize> = None;
    let mut failures = 0;
    while !stop.load(Ordering::Relaxed) {
        let t = Instant::now();
        // SAFETY: the screen's DC, released right after the copy into this thread's own surface.
        let ok = unsafe {
            let screen = GetDC(None);
            let r = BitBlt(
                surface.dc,
                0,
                0,
                w as i32,
                h as i32,
                Some(screen),
                origin.0,
                origin.1,
                SRCCOPY | CAPTUREBLT,
            );
            ReleaseDC(None, screen);
            r.is_ok()
        };
        if !ok {
            failures += 1;
            if failures > 50 {
                shared.lock().failed = Some("GDI: the screen cannot be read".into());
                wake.signal();
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        failures = 0;
        // SAFETY: the DIB section holds w * h * 4 bytes for as long as `surface` lives.
        let now = unsafe { std::slice::from_raw_parts(surface.bits, len) };
        let rects = if first {
            vec![(0, 0, w, h)]
        } else {
            changed_tiles(&last, now, w as usize, h as usize)
        };
        if !rects.is_empty() {
            let row = w as usize * 4;
            let mut s = shared.lock();
            for &(x0, y0, x1, y1) in &rects {
                for y in y0 as usize..y1 as usize {
                    let (a, b) = (y * row + x0 as usize * 4, y * row + x1 as usize * 4);
                    s.buf[a..b].copy_from_slice(&now[a..b]);
                    last[a..b].copy_from_slice(&now[a..b]);
                }
                // GDI leaves alpha as the desktop had it: the picture is opaque either way.
            }
            s.rects.extend_from_slice(&rects);
            drop(s);
            wake.signal();
            first = false;
        }
        track_cursor(&mut cursor, &hub);
        // Never more than half the time capturing, never faster than 30 times a second.
        let spent = t.elapsed();
        std::thread::sleep(MIN_INTERVAL.saturating_sub(spent).max(spent));
    }
}

/// The tiles that differ between two pictures, merged along each row of tiles.
fn changed_tiles(a: &[u8], b: &[u8], w: usize, h: usize) -> Vec<(u32, u32, u32, u32)> {
    let row = w * 4;
    let mut out = Vec::new();
    for ty in (0..h).step_by(TILE_H) {
        let y1 = (ty + TILE_H).min(h);
        let mut run: Option<usize> = None;
        let mut tx = 0;
        while tx < w {
            let x1 = (tx + TILE_W).min(w);
            let differs = (ty..y1).any(|y| {
                a[y * row + tx * 4..y * row + x1 * 4] != b[y * row + tx * 4..y * row + x1 * 4]
            });
            match (differs, run) {
                (true, None) => run = Some(tx),
                (false, Some(start)) => {
                    out.push((start as u32, ty as u32, tx as u32, y1 as u32));
                    run = None;
                }
                _ => {}
            }
            tx = x1;
        }
        if let Some(start) = run {
            out.push((start as u32, ty as u32, w as u32, y1 as u32));
        }
    }
    out
}

/// Sends the pointer's shape when the cursor showing changes.
fn track_cursor(last: &mut Option<isize>, hub: &Hub) {
    let mut ci = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: a sized struct to fill.
    if unsafe { GetCursorInfo(&mut ci) }.is_err() {
        return;
    }
    let showing = ci.flags.0 & CURSOR_SHOWING.0 != 0;
    let key = if showing { ci.hCursor.0 as isize } else { 0 };
    if *last == Some(key) {
        return;
    }
    *last = Some(key);
    if !showing {
        hub.set_cursor(crate::cursor::hidden());
        return;
    }
    if let Some(shape) = icon_shape(HICON(ci.hCursor.0)) {
        hub.set_cursor(crate::cursor::message(&shape, crate::cursor::css_now()));
    }
}

/// A cursor's image as straight RGBA: its colour bitmap with alpha (or the mask's transparency where it has none),
/// or, for a monochrome cursor, the AND and XOR masks painted as duplication's are.
fn icon_shape(icon: HICON) -> Option<crate::cursor::Shape> {
    let mut ii = ICONINFO::default();
    // SAFETY: a cursor handle the system gave out; the bitmaps GetIconInfo makes are deleted below.
    unsafe { GetIconInfo(icon, &mut ii) }.ok()?;
    let hot = (ii.xHotspot, ii.yHotspot);
    let bits = |bmp: HBITMAP| -> Option<(usize, usize, Vec<u8>)> {
        if bmp.is_invalid() {
            return None;
        }
        let mut bm = BITMAP::default();
        // SAFETY: a bitmap and a struct of its size.
        if unsafe {
            GetObjectW(
                bmp.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some((&mut bm as *mut BITMAP).cast()),
            )
        } == 0
        {
            return None;
        }
        let (w, h) = (bm.bmWidth as usize, bm.bmHeight as usize);
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut px = vec![0u8; w * h * 4];
        // SAFETY: the screen's DC for the conversion, released after; a buffer of the size asked for.
        let n = unsafe {
            let dc = GetDC(None);
            let n = GetDIBits(
                dc,
                bmp,
                0,
                h as u32,
                Some(px.as_mut_ptr().cast()),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            ReleaseDC(None, dc);
            n
        };
        (n > 0).then_some((w, h, px))
    };
    let color = bits(ii.hbmColor);
    let mask = bits(ii.hbmMask);
    // SAFETY: the bitmaps GetIconInfo made for us.
    unsafe {
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(ii.hbmColor.into());
        }
        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(ii.hbmMask.into());
        }
    }
    let (w, h, rgba) = match (color, mask) {
        (Some((w, h, c)), mask) => {
            let has_alpha = c.as_chunks::<4>().0.iter().any(|p| p[3] != 0);
            let mut rgba = vec![0u8; w * h * 4];
            for (i, p) in c.as_chunks::<4>().0.iter().enumerate() {
                let transparent = mask
                    .as_ref()
                    .is_some_and(|(_, _, m)| m.get(i * 4).is_some_and(|&v| v != 0));
                let a = if has_alpha {
                    p[3]
                } else if transparent {
                    0
                } else {
                    255
                };
                rgba[i * 4..i * 4 + 4].copy_from_slice(&[p[2], p[1], p[0], a]);
            }
            (w, h, rgba)
        }
        (None, Some((w, h2, m))) => {
            // AND above XOR, each h2 / 2 rows; a set bit reads as white (0xff) after the conversion.
            let h = h2 / 2;
            let mut rgba = vec![0u8; w * h * 4];
            for i in 0..w * h {
                let and = m[i * 4] != 0;
                let xor = m[(w * h + i) * 4] != 0;
                let px = match (and, xor) {
                    (false, false) => [0, 0, 0, 255],
                    (false, true) => [255, 255, 255, 255],
                    (true, false) => [0, 0, 0, 0],
                    (true, true) => [0, 0, 0, 255],
                };
                rgba[i * 4..i * 4 + 4].copy_from_slice(&px);
            }
            (w, h, rgba)
        }
        _ => return None,
    };
    Some(crate::cursor::Shape {
        width: w as u32,
        height: h as u32,
        rgba,
        hot: (hot.0.min(w as u32 - 1), hot.1.min(h as u32 - 1)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_tiles_that_differ_are_damage() {
        let (w, h) = (200usize, 70usize);
        let a = vec![0u8; w * h * 4];
        let mut b = a.clone();
        // One pixel in the second tile column of the first row of tiles, and two adjacent tiles in the third row.
        b[(5 * w + 70) * 4] = 1;
        b[(65 * w + 10) * 4] = 1;
        b[(65 * w + 100) * 4] = 1;
        assert_eq!(
            changed_tiles(&a, &b, w, h),
            vec![(64, 0, 128, 32), (0, 64, 128, 70)]
        );
        assert!(changed_tiles(&a, &a, w, h).is_empty());
    }
}
