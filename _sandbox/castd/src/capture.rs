//! X11 capture: the screen (or one region of it, `--crop`) as BGRX, driven by XDamage. With Xvfb started `-shmem`,
//! the framebuffer is read in place, with no copy at all; otherwise each damaged band is fetched with MIT-SHM GetImage.

use std::os::fd::{AsFd, BorrowedFd};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::Event;
use x11rb::protocol::damage::{self, ConnectionExt as _};
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto::{
    ChangeWindowAttributesAux, ConnectionExt as _, EventMask, ImageFormat,
};
use x11rb::rust_connection::RustConnection;

pub struct ShmBuf {
    pub ptr: *mut u8,
    pub len: usize,
    shmid: i32,
    /// Attached to someone else's segment (never removed by us).
    foreign: bool,
}

// The pointer is to a shared memory segment this process attached, valid until Drop detaches it.
unsafe impl Send for ShmBuf {}

impl ShmBuf {
    fn new(len: usize) -> Result<Self, String> {
        unsafe {
            let shmid = libc::shmget(libc::IPC_PRIVATE, len, libc::IPC_CREAT | 0o600);
            if shmid < 0 {
                return Err("shmget failed".into());
            }
            let ptr = libc::shmat(shmid, std::ptr::null(), 0);
            if ptr as isize == -1 {
                libc::shmctl(shmid, libc::IPC_RMID, std::ptr::null_mut());
                return Err("shmat failed".into());
            }
            Ok(ShmBuf {
                ptr: ptr as *mut u8,
                len,
                shmid,
                foreign: false,
            })
        }
    }

    fn attach_readonly(shmid: i32, len: usize) -> Option<Self> {
        unsafe {
            let ptr = libc::shmat(shmid, std::ptr::null(), libc::SHM_RDONLY);
            if ptr as isize == -1 {
                return None;
            }
            Some(ShmBuf {
                ptr: ptr as *mut u8,
                len,
                shmid,
                foreign: true,
            })
        }
    }

    pub fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl Drop for ShmBuf {
    fn drop(&mut self) {
        unsafe {
            libc::shmdt(self.ptr as *const _);
            if !self.foreign {
                libc::shmctl(self.shmid, libc::IPC_RMID, std::ptr::null_mut());
            }
        }
    }
}

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

pub struct Capturer {
    pub conn: RustConnection,
    root: u32,
    /// The picture: the whole screen, or the crop of it.
    pub area: Rect,
    /// The whole screen's size.
    pub screen: (u32, u32),
    /// Whether `--crop` applies.
    pub cropped: bool,
    resize_pending: bool,
    /// Bytes per row of `pixels()`.
    pub stride: usize,
    seg: u32,
    buf: ShmBuf,
    /// Byte offset of the picture's first pixel inside `buf`.
    offset: usize,
    /// Reading Xvfb's framebuffer in place: no GetImage needed.
    pub direct: bool,
    /// Kept for the connection's lifetime; raw-rectangle events need no further requests.
    _damage: u32,
    pub damaged: bool,
    /// When the first damage since the last take arrived.
    pub damaged_at: Option<std::time::Instant>,
    /// Rows touched since the last take (raw damage rectangles, no server round trip).
    acc: Option<(u32, u32)>,
    /// Macroblocks (16x16) touched since the last take, row-major.
    mb_dirty: Vec<u8>,
    pub mb_cols: usize,
    /// Areas (x0, y0, x1, y1) changed since the video thread last took them, for `/wait`.
    pub changes: Vec<(u32, u32, u32, u32)>,
}

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Capturer {
    pub fn new(display: Option<&str>, crop: Option<Rect>) -> Result<Self, String> {
        let (conn, screen_num) =
            RustConnection::connect(display).map_err(|e| format!("X connect: {e}"))?;
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let depth = screen.root_depth;
        // Subscribe before querying geometry so a resize during initialization is not lost.
        conn.change_window_attributes(
            root,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY),
        )
        .map_err(e2s)?
        .check()
        .map_err(e2s)?;
        let geometry = conn.get_geometry(root).map_err(e2s)?.reply().map_err(e2s)?;
        let (sw, sh) = (u32::from(geometry.width), u32::from(geometry.height));
        if depth != 24 && depth != 32 {
            return Err(format!("unsupported root depth {depth}"));
        }
        let full = Rect {
            x: 0,
            y: 0,
            w: sw & !1,
            h: sh & !1,
        };
        let area = match crop {
            Some(c) => c
                .fit(sw, sh)
                .ok_or_else(|| format!("--crop {c:?} is not on the {sw}x{sh} screen"))?,
            None => full,
        };
        conn.extension_information(shm::X11_EXTENSION_NAME)
            .map_err(e2s)?
            .ok_or("no MIT-SHM")?;
        conn.shm_query_version()
            .map_err(e2s)?
            .reply()
            .map_err(e2s)?;
        conn.damage_query_version(1, 1)
            .map_err(e2s)?
            .reply()
            .map_err(e2s)?;
        conn.xfixes_query_version(5, 0)
            .map_err(e2s)?
            .reply()
            .map_err(e2s)?;
        let seg = conn.generate_id().map_err(e2s)?;
        let server_pid = display.and_then(xserver_pid);
        let (buf, offset, stride, direct) = match find_xvfb_framebuffer(
            &conn, root, sw, sh, server_pid,
        ) {
            Some((buf, offset, fb_stride)) => {
                log::info!(
                    "capturing directly from the Xvfb framebuffer (shmid {})",
                    buf.shmid
                );
                let at = offset + area.y as usize * fb_stride + area.x as usize * 4;
                (buf, at, fb_stride, true)
            }
            None => {
                log::warn!(
                    "Xvfb framebuffer not found (start Xvfb with -shmem); falling back to MIT-SHM GetImage"
                );
                let stride = area.w as usize * 4;
                let buf = ShmBuf::new(stride * area.h as usize)?;
                conn.shm_attach(seg, buf.shmid as u32, false)
                    .map_err(e2s)?
                    .check()
                    .map_err(e2s)?;
                // Mark for removal now; it stays alive while attached.
                unsafe { libc::shmctl(buf.shmid, libc::IPC_RMID, std::ptr::null_mut()) };
                (buf, 0, stride, false)
            }
        };
        let damage = conn.generate_id().map_err(e2s)?;
        conn.damage_create(damage, root, damage::ReportLevel::RAW_RECTANGLES)
            .map_err(e2s)?;
        conn.flush().map_err(e2s)?;
        let mb_cols = (area.w as usize).div_ceil(16);
        Ok(Capturer {
            conn,
            root,
            area,
            screen: (sw, sh),
            cropped: crop.is_some(),
            resize_pending: false,
            stride,
            seg,
            buf,
            offset,
            direct,
            _damage: damage,
            damaged: true,
            damaged_at: None,
            acc: None,
            mb_dirty: vec![0; mb_cols * (area.h as usize).div_ceil(16)],
            mb_cols,
            changes: Vec::new(),
        })
    }

    pub fn width(&self) -> u32 {
        self.area.w
    }

    pub fn height(&self) -> u32 {
        self.area.h
    }

    pub fn fd(&self) -> BorrowedFd<'_> {
        self.conn.stream().as_fd()
    }

    /// Drains queued X events, noting damage inside the picture.
    pub fn pump(&mut self) -> Result<(), String> {
        while let Some(ev) = self.conn.poll_for_event().map_err(e2s)? {
            if let Event::ConfigureNotify(e) = &ev
                && e.window == self.root
                && (u32::from(e.width), u32::from(e.height)) != self.screen
            {
                self.resize_pending = true;
            }
            if let Event::DamageNotify(e) = ev {
                let Some((left, top, right, bot)) = self.area.clip(
                    e.area.x as i32,
                    e.area.y as i32,
                    e.area.width as i32,
                    e.area.height as i32,
                ) else {
                    continue;
                };
                let (x0, x1) = (left as usize / 16, (right as usize).div_ceil(16));
                for row in (top as usize / 16)..(bot as usize).div_ceil(16) {
                    self.mb_dirty[row * self.mb_cols + x0..row * self.mb_cols + x1].fill(1);
                }
                self.changes.push((left, top, right, bot));
                self.acc = Some(match self.acc {
                    Some((a, b)) => (a.min(top), b.max(bot)),
                    None => (top, bot),
                });
                self.damaged = true;
                self.damaged_at.get_or_insert_with(std::time::Instant::now);
            }
        }
        Ok(())
    }

    /// Takes accumulated damage as a row band. Raw-rectangle reporting delivers the areas in the events themselves, so
    /// this never waits on the X server.
    pub fn take_damage(&mut self) -> Option<Band> {
        self.damaged = false;
        self.damaged_at = None;
        let (y0, y1) = self.acc.take()?;
        // Align to even rows for 4:2:0.
        Some(Band {
            y0: y0 & !1,
            y1: ((y1 + 1) & !1).min(self.area.h),
        })
    }

    /// Takes the dirty-macroblock map accumulated with the current damage.
    pub fn take_mb_map(&mut self) -> Vec<u8> {
        let n = self.mb_dirty.len();
        std::mem::replace(&mut self.mb_dirty, vec![0; n])
    }

    pub fn full(&self) -> Band {
        Band {
            y0: 0,
            y1: self.area.h,
        }
    }

    /// Converts rows [y0, y1) of the current picture into `dst`.
    pub fn convert(&self, dst: &mut crate::convert::I420, y0: usize, y1: usize, threads: usize) {
        crate::convert::convert_band(self.pixels(), self.stride, dst, y0, y1, threads);
    }

    /// The current picture as packed BGRX (`width * 4` bytes per row), for screenshots, with the damage for exactly
    /// these pixels taken into `changes`. Nothing draws while the server is grabbed (a few ms for the copy), so a
    /// repaint cannot land in the pixels without its damage, or after them with it.
    pub fn snapshot(&mut self) -> Result<Vec<u8>, String> {
        self.conn.grab_server().map_err(e2s)?;
        let shot = self.snapshot_grabbed();
        // Release the server even if the copy failed.
        self.conn.ungrab_server().map_err(e2s)?;
        self.conn.flush().map_err(e2s)?;
        shot
    }

    fn snapshot_grabbed(&mut self) -> Result<Vec<u8>, String> {
        // Damage for everything drawn before the grab arrives ahead of this reply.
        self.conn
            .get_input_focus()
            .map_err(e2s)?
            .reply()
            .map_err(e2s)?;
        self.pump()?;
        self.grab(self.full())?;
        let (row, h) = (self.area.w as usize * 4, self.area.h as usize);
        let px = self.pixels();
        let mut out = Vec::with_capacity(row * h);
        for y in 0..h {
            out.extend_from_slice(&px[y * self.stride..y * self.stride + row]);
        }
        Ok(out)
    }

    /// An exact copy of `r` of the picture as packed BGRX (`r.w * 4` bytes per row), clamped to the picture: what a
    /// `lossless` message carries. Read without grabbing the server: it is asked for once the screen has been still, and
    /// a repaint that lands meanwhile brings its own damage, so the next frame draws it over the copy anyway.
    pub fn region(&self, r: Rect) -> Result<Vec<u8>, String> {
        let x = r.x.min(self.area.w);
        let y = r.y.min(self.area.h);
        let w = r.w.min(self.area.w - x) as usize;
        let h = r.h.min(self.area.h - y);
        self.grab(Band { y0: y, y1: y + h })?;
        let px = self.pixels();
        let row = w * 4;
        let mut out = Vec::with_capacity(row * h as usize);
        for line in y..y + h {
            let at = line as usize * self.stride + x as usize * 4;
            out.extend_from_slice(&px[at..at + row]);
        }
        Ok(out)
    }

    /// Whether a root configure event changed the screen's size.
    pub fn needs_rebuild(&self) -> bool {
        self.resize_pending
    }

    /// A resize can race a GetImage request before its configure event is processed.
    pub fn geometry_changed(&self) -> bool {
        self.conn
            .get_geometry(self.root)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some_and(|g| (u32::from(g.width), u32::from(g.height)) != self.screen)
    }

    /// The current picture's pixels from its first: BGRX, `stride` bytes per row, `height` rows.
    fn pixels(&self) -> &[u8] {
        let len = self.stride * (self.area.h as usize - 1) + self.area.w as usize * 4;
        &self.buf.as_slice()[self.offset..self.offset + len]
    }

    /// Fetches a band of the picture into the shm frame at its natural offset (GetImage path only).
    pub fn grab(&self, band: Band) -> Result<(), String> {
        let h = band.y1.saturating_sub(band.y0);
        if h == 0 || self.direct {
            return Ok(());
        }
        let off = band.y0 as usize * self.stride;
        self.conn
            .shm_get_image(
                self.root,
                self.area.x as i16,
                (self.area.y + band.y0) as i16,
                self.area.w as u16,
                h as u16,
                !0,
                ImageFormat::Z_PIXMAP.into(),
                self.seg,
                off as u32,
            )
            .map_err(e2s)?
            .reply()
            .map_err(e2s)?;
        Ok(())
    }
}

/// Pid of the local X server for `display` (":N" or "host:N.S"), from its lock file.
fn xserver_pid(display: &str) -> Option<u32> {
    let after = display.rsplit(':').next()?;
    let n: u32 = after.split('.').next()?.parse().ok()?;
    std::fs::read_to_string(format!("/tmp/.X{n}-lock"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn be32(b: &[u8], i: usize) -> u32 {
    u32::from_be_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]])
}

/// Xvfb started with `-shmem` keeps each screen as an XWD image in a SysV segment. Find it, check the header and verify
/// pixels against the server before trusting it. After a RandR resize the header still describes the size Xvfb started
/// with: the screen is the top-left `width`x`height` of it, at the header's stride.
fn find_xvfb_framebuffer(
    conn: &RustConnection,
    root: u32,
    width: u32,
    height: u32,
    server_pid: Option<u32>,
) -> Option<(ShmBuf, usize, usize)> {
    if std::env::var("CASTD_NO_DIRECT_FB").is_ok() {
        return None;
    }
    let table = std::fs::read_to_string("/proc/sysvipc/shm").ok()?;
    for line in table.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 5 {
            continue;
        }
        let (Ok(shmid), Ok(size)) = (f[1].parse::<i32>(), f[3].parse::<usize>()) else {
            continue;
        };
        // Several Xvfbs can run side by side with similar (or blank) screens, so only look at segments our X server
        // created when we know its pid.
        if server_pid.is_some_and(|pid| f[4].parse::<u32>().ok() != Some(pid)) {
            continue;
        }
        if size < (width * height * 4) as usize || size < 100 * 4 {
            continue;
        }
        let Some(buf) = ShmBuf::attach_readonly(shmid, size) else {
            continue;
        };
        let b = buf.as_slice();
        let header_size = be32(b, 0) as usize;
        let (w, h, bpp, bpl, ncolors) = (
            be32(b, 4),
            be32(b, 5),
            be32(b, 11),
            be32(b, 12) as usize,
            be32(b, 19) as usize,
        );
        if be32(b, 1) != 7 || w < width || h < height || bpp != 32 || bpl < (w * 4) as usize {
            continue;
        }
        let offset = header_size + ncolors * 12;
        if offset + bpl * h as usize > size {
            continue;
        }
        // Compare a strip of real pixels with what the server reports. The screen may be animating between the two
        // reads, so retry and accept a near-total match.
        let (sy, sh) = (height / 2, 16u32.min(height / 2));
        let mut ok = false;
        for _ in 0..10 {
            let Ok(Ok(img)) = conn
                .get_image(
                    ImageFormat::Z_PIXMAP,
                    root,
                    0,
                    sy as i16,
                    width as u16,
                    sh as u16,
                    !0,
                )
                .map(|c| c.reply())
            else {
                break;
            };
            let mut same = 0usize;
            let total = (width * sh) as usize;
            for r in 0..sh as usize {
                let fb = &b[offset + (sy as usize + r) * bpl..][..width as usize * 4];
                let im = &img.data[r * width as usize * 4..][..width as usize * 4];
                same += fb
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(im.as_chunks::<4>().0)
                    .filter(|(a, c)| a[..3] == c[..3])
                    .count();
            }
            if same * 100 >= total * 98 {
                ok = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        if ok {
            return Some((buf, offset, bpl));
        }
    }
    None
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
}
