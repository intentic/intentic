//! The synthetic screen: a painter thread draws a page of text-like lines scrolling `SCROLL_PX` a frame, a box crossing
//! it, and the stamp row, at the app's own rate, and the capture brings each paint in as a screen's damage would come
//! (a DXGI thread's way: a wake, then the damaged rows copied in `grab`).
//!
//! The stamp, rows 0..16 from the left: `STAMP_BITS` blocks of 16x16 pixels, black for a 1, white for a 0, most
//! significant first: the wall-clock millisecond the picture was painted (u32, Unix ms modulo 2^32), a counter (u16) and
//! the XOR of those six bytes (u8). Blocks this size on the macroblock grid survive any quantiser a bitrate cap forces.

use cast_core::capture::{Capture, Damage, ScreenSource};
use cast_core::geometry::{Band, Rect};
use cast_core::wake::{Waitable, Wake};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const STAMP_BITS: usize = 56;
const BLOCK: usize = 16;
const SCROLL_PX: usize = 3;
const LINE_PX: usize = 20;

struct Shared {
    w: u32,
    h: u32,
    px: Vec<u8>,
    dirty: bool,
}

pub struct Scene {
    shared: Arc<Mutex<Shared>>,
    wake: Arc<Wake>,
}

impl Scene {
    /// Starts painting a `w` x `h` screen `app_fps` times a second, for the process's life.
    pub fn start(w: u32, h: u32, app_fps: u32) -> Scene {
        let shared = Arc::new(Mutex::new(Shared {
            w,
            h,
            px: vec![0xff; (w * h * 4) as usize],
            dirty: true,
        }));
        let wake = Arc::new(Wake::new().expect("wake"));
        let (s, k) = (shared.clone(), wake.clone());
        std::thread::Builder::new()
            .name("painter".into())
            .spawn(move || paint_loop(s, k, w as usize, h as usize, app_fps.max(1)))
            .expect("painter thread");
        Scene { shared, wake }
    }
}

/// A tall page of "text": lines of words, each word glyph-like strokes, and now and then a coloured picture.
fn page_texture(w: usize, h: usize) -> Vec<u8> {
    let mut px = vec![0xffu8; w * h * 4];
    let mut seed: u32 = 0x1234_5678;
    let mut rand = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    let mut y = 8;
    while y + LINE_PX < h {
        if rand() % 9 == 0 {
            // A picture: a gradient block a few lines tall.
            let (bw, bh) = (160 + (rand() % 240) as usize, LINE_PX * 4);
            let bx = 20 + (rand() as usize % (w - bw - 40));
            let (r0, g0, b0) = (
                (rand() & 0xff) as u8,
                (rand() & 0xff) as u8,
                (rand() & 0xff) as u8,
            );
            for yy in y..(y + bh).min(h) {
                for xx in bx..bx + bw {
                    let i = (yy * w + xx) * 4;
                    px[i] = b0.wrapping_add((xx - bx) as u8);
                    px[i + 1] = g0.wrapping_add((yy - y) as u8 * 2);
                    px[i + 2] = r0;
                }
            }
            y += bh + 8;
            continue;
        }
        let mut x = 20;
        let end = w - 20 - (rand() as usize % (w / 3));
        while x < end {
            let glyphs = 2 + (rand() % 9) as usize;
            for _ in 0..glyphs {
                let bits = rand();
                for col in 0..6 {
                    for row in 0..11 {
                        if bits >> ((col * 5 + row) % 32) & 1 == 1 {
                            let i = ((y + row) * w + x + col) * 4;
                            if x + col < w {
                                px[i..i + 3].copy_from_slice(&[0x30, 0x30, 0x30]);
                            }
                        }
                    }
                }
                x += 7;
            }
            x += 6;
        }
        y += LINE_PX;
    }
    px
}

fn stamp(px: &mut [u8], w: usize, ms: u32, counter: u16) {
    let mut bytes = [0u8; 7];
    bytes[..4].copy_from_slice(&ms.to_be_bytes());
    bytes[4..6].copy_from_slice(&counter.to_be_bytes());
    bytes[6] = bytes[..6].iter().fold(0, |a, b| a ^ b);
    for bit in 0..STAMP_BITS {
        let on = bytes[bit / 8] >> (7 - bit % 8) & 1 == 1;
        let v = if on { 0x00 } else { 0xff };
        for row in 0..BLOCK {
            let at = (row * w + bit * BLOCK) * 4;
            px[at..at + BLOCK * 4].fill(v);
        }
    }
}

fn paint_loop(shared: Arc<Mutex<Shared>>, wake: Arc<Wake>, w: usize, h: usize, fps: u32) {
    let tex_h = h * 4;
    let texture = page_texture(w, tex_h);
    let interval = Duration::from_secs_f64(1.0 / fps as f64);
    let mut next = Instant::now();
    let mut frame: usize = 0;
    let mut counter: u16 = 0;
    let row = w * 4;
    let span = tex_h - h;
    loop {
        next += interval;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
        frame += 1;
        counter = counter.wrapping_add(1);
        // Back and forth over the page, so the content keeps moving with no seam.
        let travel = (frame * SCROLL_PX) % (2 * span);
        let offset = if travel < span {
            travel
        } else {
            2 * span - travel
        };
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64) as u32;
        let mut s = shared.lock().unwrap();
        s.px.copy_from_slice(&texture[offset * row..(offset + h) * row]);
        // The box: 96 px, crossing the lower half.
        let bx = (frame * 6) % (w - 96);
        let by = h / 2 + (frame / 3) % (h / 2 - 96);
        for yy in by..by + 96 {
            let at = yy * row + bx * 4;
            for p in s.px[at..at + 96 * 4].as_chunks_mut::<4>().0 {
                *p = [0x20, 0x80, 0xe0, 0];
            }
        }
        stamp(&mut s.px, w, ms, counter);
        s.dirty = true;
        drop(s);
        wake.signal();
    }
}

impl ScreenSource for Scene {
    fn open(&mut self, crop: Option<Rect>) -> Result<Box<dyn Capture>, String> {
        if crop.is_some() {
            return Err("the scene is never cropped".into());
        }
        let s = self.shared.lock().unwrap();
        let (w, h) = (s.w, s.h);
        drop(s);
        Ok(Box::new(SceneCapture {
            shared: self.shared.clone(),
            wake: self.wake.clone(),
            w,
            h,
            frame: vec![0xff; (w * h * 4) as usize],
            damage: Damage::new(w, h),
        }))
    }
}

struct SceneCapture {
    shared: Arc<Mutex<Shared>>,
    wake: Arc<Wake>,
    w: u32,
    h: u32,
    frame: Vec<u8>,
    damage: Damage,
}

impl Capture for SceneCapture {
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
        let mut s = self.shared.lock().unwrap();
        if std::mem::take(&mut s.dirty) {
            self.damage.add(0, 0, self.w, self.h);
        }
        Ok(())
    }
    fn needs_rebuild(&self) -> bool {
        false
    }
    fn grab(&mut self, band: Band) -> Result<(), String> {
        let row = self.w as usize * 4;
        let s = self.shared.lock().unwrap();
        let (a, b) = (band.y0 as usize * row, band.y1 as usize * row);
        self.frame[a..b].copy_from_slice(&s.px[a..b]);
        Ok(())
    }
    fn pixels(&self) -> Option<(&[u8], usize)> {
        Some((&self.frame, self.w as usize * 4))
    }
}
