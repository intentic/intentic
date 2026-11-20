//! X11 capture: the screen (or one region of it, `--crop`) as BGRX, driven by XDamage. With Xvfb started `-shmem`,
//! the framebuffer is read in place, with no copy at all; otherwise each damaged band is fetched with MIT-SHM GetImage,
//! as on a real X server (a person's own `:0`), and with plain GetImage where the server cannot attach castd's shared
//! memory (a display across the network).

use cast_core::capture::{Capture, Damage, ScreenSource};
use cast_core::geometry::{Band, Rect, ResizeLimits};
use cast_core::wake::Waitable;
use std::os::fd::AsFd;
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::Event;
use x11rb::protocol::damage::{self, ConnectionExt as _};
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto::{
    ChangeWindowAttributesAux, ConnectionExt as _, EventMask, ImageFormat, ImageOrder,
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

/// Where the picture's pixels are: a shared memory segment (Xvfb's framebuffer, or castd's own that MIT-SHM GetImage
/// writes into), or plain memory a GetImage reply is copied into.
enum Store {
    Shm(ShmBuf),
    Plain(Vec<u8>),
}

impl Store {
    fn as_slice(&self) -> &[u8] {
        match self {
            Store::Shm(b) => b.as_slice(),
            Store::Plain(v) => v,
        }
    }
}

pub struct Capturer {
    pub conn: RustConnection,
    root: u32,
    /// The picture: the whole screen, or the crop of it.
    area: Rect,
    /// The whole screen's size.
    screen: (u32, u32),
    /// Whether `--crop` applies.
    cropped: bool,
    resize_pending: bool,
    /// Bytes per row of `pixels()`.
    stride: usize,
    seg: u32,
    buf: Store,
    /// Byte offset of the picture's first pixel inside `buf`.
    offset: usize,
    /// Reading Xvfb's framebuffer in place: no GetImage needed.
    pub direct: bool,
    /// Fetching bands with MIT-SHM GetImage (the server writes into shared memory) rather than plain GetImage.
    pub shared: bool,
    /// Kept for the connection's lifetime; raw-rectangle events need no further requests.
    _damage: u32,
    /// What XDamage reported since the pipeline last took it (raw damage rectangles, no server round trip).
    damage: Damage,
}

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Capturer {
    /// Captures `display` (None: $DISPLAY), or `crop` of it, with MIT-SHM unless CASTD_NO_SHM is set.
    pub fn new(display: Option<&str>, crop: Option<Rect>) -> Result<Self, String> {
        Self::open(display, crop, std::env::var_os("CASTD_NO_SHM").is_none())
    }

    /// The same, with MIT-SHM only when `shm` allows it (and the server offers it).
    pub fn open(display: Option<&str>, crop: Option<Rect>, shm: bool) -> Result<Self, String> {
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
        // Pixels are read as BGRX: 32 bits each, least significant byte first (every X server castd meets: Xvfb, Xorg
        // and XWayland on little-endian machines).
        let bpp = conn
            .setup()
            .pixmap_formats
            .iter()
            .find(|f| f.depth == depth)
            .map(|f| f.bits_per_pixel);
        if bpp != Some(32) || conn.setup().image_byte_order != ImageOrder::LSB_FIRST {
            return Err(format!(
                "unsupported pixel layout ({bpp:?} bits a pixel, {:?})",
                conn.setup().image_byte_order
            ));
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
        // MIT-SHM, unless the server cannot share memory with castd (or the caller says to do without): then each band
        // is a plain GetImage.
        let shm = shm
            && conn
                .extension_information(shm::X11_EXTENSION_NAME)
                .map_err(e2s)?
                .is_some()
            && conn.shm_query_version().map_err(e2s)?.reply().is_ok();
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
        let framebuffer = shm
            .then(|| find_xvfb_framebuffer(&conn, root, sw, sh, server_pid))
            .flatten();
        let (buf, offset, stride, direct) = match framebuffer {
            Some((buf, offset, fb_stride)) => {
                log::info!(
                    "capturing directly from the Xvfb framebuffer (shmid {})",
                    buf.shmid
                );
                let at = offset + area.y as usize * fb_stride + area.x as usize * 4;
                (Store::Shm(buf), at, fb_stride, true)
            }
            None => {
                let stride = area.w as usize * 4;
                let len = stride * area.h as usize;
                match shm.then(|| attach_segment(&conn, seg, len)) {
                    Some(Ok(buf)) => {
                        if server_pid.is_some_and(is_xvfb) {
                            log::warn!(
                                "Xvfb framebuffer not found (start Xvfb with -shmem); falling back to MIT-SHM GetImage"
                            );
                        } else {
                            log::info!("capturing with MIT-SHM GetImage");
                        }
                        (Store::Shm(buf), 0, stride, false)
                    }
                    other => {
                        let why = match other {
                            Some(Err(e)) => e,
                            _ => "the server has no MIT-SHM".into(),
                        };
                        log::warn!("capturing with plain GetImage: {why}");
                        (Store::Plain(vec![0; len]), 0, stride, false)
                    }
                }
            }
        };
        let damage = conn.generate_id().map_err(e2s)?;
        conn.damage_create(damage, root, damage::ReportLevel::RAW_RECTANGLES)
            .map_err(e2s)?;
        conn.flush().map_err(e2s)?;
        let shared = matches!(buf, Store::Shm(_)) && !direct;
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
            shared,
            _damage: damage,
            damage: Damage::new(area.w, area.h),
        })
    }

    /// Drains queued X events, noting damage inside the picture.
    fn pump_events(&mut self) -> Result<(), String> {
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
                self.damage.add(left, top, right, bot);
            }
        }
        Ok(())
    }

    /// The current picture as packed BGRX (`width * 4` bytes per row), for screenshots, with the damage for exactly
    /// these pixels taken into `changes`. Nothing draws while the server is grabbed (a few ms for the copy), so a
    /// repaint cannot land in the pixels without its damage, or after them with it.
    fn snapshot_whole(&mut self) -> Result<Vec<u8>, String> {
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
        self.pump_events()?;
        self.grab_band(Band {
            y0: 0,
            y1: self.area.h,
        })?;
        let (row, h) = (self.area.w as usize * 4, self.area.h as usize);
        let px = self.picture();
        let mut out = Vec::with_capacity(row * h);
        for y in 0..h {
            out.extend_from_slice(&px[y * self.stride..y * self.stride + row]);
        }
        Ok(out)
    }

    /// The current picture's pixels from its first: BGRX, `stride` bytes per row, `height` rows.
    fn picture(&self) -> &[u8] {
        let len = self.stride * (self.area.h as usize - 1) + self.area.w as usize * 4;
        &self.buf.as_slice()[self.offset..self.offset + len]
    }

    /// Fetches a band of the picture into the frame at its natural offset (GetImage paths only).
    fn grab_band(&mut self, band: Band) -> Result<(), String> {
        let h = band.y1.saturating_sub(band.y0);
        if h == 0 || self.direct {
            return Ok(());
        }
        let off = band.y0 as usize * self.stride;
        let (x, y, w) = (
            self.area.x as i16,
            (self.area.y + band.y0) as i16,
            self.area.w as u16,
        );
        match &mut self.buf {
            Store::Shm(_) => {
                self.conn
                    .shm_get_image(
                        self.root,
                        x,
                        y,
                        w,
                        h as u16,
                        !0,
                        ImageFormat::Z_PIXMAP.into(),
                        self.seg,
                        off as u32,
                    )
                    .map_err(e2s)?
                    .reply()
                    .map_err(e2s)?;
            }
            Store::Plain(frame) => {
                let img = self
                    .conn
                    .get_image(ImageFormat::Z_PIXMAP, self.root, x, y, w, h as u16, !0)
                    .map_err(e2s)?
                    .reply()
                    .map_err(e2s)?;
                let n = (h as usize * self.stride)
                    .min(img.data.len())
                    .min(frame.len() - off);
                frame[off..off + n].copy_from_slice(&img.data[..n]);
            }
        }
        Ok(())
    }
}

impl Capture for Capturer {
    fn area(&self) -> Rect {
        self.area
    }

    fn screen(&self) -> (u32, u32) {
        self.screen
    }

    fn cropped(&self) -> bool {
        self.cropped
    }

    fn damage(&mut self) -> &mut Damage {
        &mut self.damage
    }

    fn waitable(&self) -> Option<Waitable<'_>> {
        Some(self.conn.stream().as_fd())
    }

    fn pump(&mut self) -> Result<(), String> {
        self.pump_events()
    }

    /// Whether a root configure event changed the screen's size.
    fn needs_rebuild(&self) -> bool {
        self.resize_pending
    }

    /// A resize can race a GetImage request before its configure event is processed.
    fn geometry_changed(&self) -> bool {
        self.conn
            .get_geometry(self.root)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some_and(|g| (u32::from(g.width), u32::from(g.height)) != self.screen)
    }

    fn grab(&mut self, band: Band) -> Result<(), String> {
        self.grab_band(band)
    }

    fn pixels(&self) -> Option<(&[u8], usize)> {
        Some((self.picture(), self.stride))
    }

    fn snapshot(&mut self) -> Result<Vec<u8>, String> {
        self.snapshot_whole()
    }
}

/// An X display as castd's screen: captured with XDamage, resized with RandR when it may be (Xvfb with no `--crop`).
pub struct X11Screen {
    display: Option<String>,
    randr: Option<crate::screen::Screen>,
}

impl X11Screen {
    /// The display `display` names (`:N`; None: $DISPLAY), resized through `randr` when given.
    pub fn new(display: Option<String>, randr: Option<crate::screen::Screen>) -> X11Screen {
        X11Screen { display, randr }
    }
}

impl ScreenSource for X11Screen {
    fn open(&mut self, crop: Option<Rect>) -> Result<Box<dyn Capture>, String> {
        Ok(Box::new(Capturer::new(self.display.as_deref(), crop)?))
    }

    fn resize_limits(&self) -> Option<ResizeLimits> {
        self.randr.as_ref().map(|s| s.limits())
    }

    fn resize(&mut self, w: u32, h: u32) -> Result<(), String> {
        match self.randr.as_mut() {
            Some(s) => s.resize(w, h),
            None => Err("RandR was not opened for this screen".into()),
        }
    }
}

/// castd's own segment for MIT-SHM GetImage, attached by the server; refused where the server cannot reach this
/// process's shared memory.
fn attach_segment(conn: &RustConnection, seg: u32, len: usize) -> Result<ShmBuf, String> {
    let buf = ShmBuf::new(len)?;
    conn.shm_attach(seg, buf.shmid as u32, false)
        .map_err(e2s)?
        .check()
        .map_err(e2s)?;
    // Mark for removal now; it stays alive while attached.
    unsafe { libc::shmctl(buf.shmid, libc::IPC_RMID, std::ptr::null_mut()) };
    Ok(buf)
}

/// Whether the process `pid` is an Xvfb, whose `-shmem` framebuffer is worth looking for.
fn is_xvfb(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .is_ok_and(|c| c.trim_end().starts_with("Xvfb"))
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
    // A real X server (Xorg on a person's `:0`) keeps no framebuffer in a segment: look only where the server is an
    // Xvfb, or where who it is cannot be told.
    if server_pid
        .is_some_and(|pid| std::path::Path::new(&format!("/proc/{pid}")).exists() && !is_xvfb(pid))
    {
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
