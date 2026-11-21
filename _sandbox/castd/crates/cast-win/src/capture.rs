//! One monitor through DXGI Desktop Duplication, as cast-core's [`ScreenSource`] and [`Capture`].
//!
//! A duplication thread of the capture's own (named `dup-<id>`) waits in `AcquireNextFrame`, copies each new desktop
//! image's dirty and move rectangles into a texture it keeps (the mirror, on the GPU), releases the image at once, and
//! signals the [`Wake`] the pipeline waits on. Where the frames go is the screen's [`Sink`]:
//!
//! - **On the GPU** (`Sink::Gpu`): frames are textures on the encoder's device. `fill` copies the damaged rows from
//!   the mirror into the frame with `CopySubresourceRegion`, and NVENC or a Media Foundation transform reads it in place:
//!   the picture never reaches the CPU. When the monitor hangs off another GPU than the encoder (an Optimus laptop's
//!   panel on the Intel iGPU, NVENC on the NVIDIA one) the rows cross through memory instead (`bridge`), only the
//!   damaged ones.
//! - **In memory** (`Sink::Cpu`): `grab` reads the damaged rows back through a staging texture into a BGRA buffer,
//!   which cast-core converts to I420 for openh264.
//!
//! Windows takes duplication away on a mode change, a desktop switch (the lock screen, a UAC prompt, Ctrl+Alt+Del) and
//! a GPU reset (`DXGI_ERROR_ACCESS_LOST`, `DEVICE_REMOVED`). The thread duplicates again; a new size or device has the
//! pipeline open a new capture; a desktop it may not see shows a placeholder saying why ([`crate::session`] asks
//! Windows: the secure desktop, the display off, another session on the screen) rather than a frozen picture, and the
//! screen's [`CaptureStatus`] says the same to `/info` and `/stats`.
//!
//! The duplication thread reports through a [`DupOut`]: [`LocalOut`] hands its rectangles to this process's pipeline;
//! the lock screen and admin prompts helper ([`crate::helper`], a process running as SYSTEM in the session, which can
//! duplicate the secure desktop) runs the same thread and sends them down its pipe instead, the mirror texture shared
//! across the two processes as it is across two devices here.

use crate::cursor::{self, Pointer};
use crate::d3d::{Device, GpuFrame, Held};
use crate::displays::{self, Display};
use crate::session::{self, Blocked, CaptureStatus, StatusCell};
use browser_wire::MediaCursor;
use cast_core::capture::{Capture, Damage, ScreenSource};
use cast_core::frame::{Frame, FrameFormat};
use cast_core::geometry::{Band, Rect};
use cast_core::hub::Hub;
use cast_core::wake::{Waitable, Wake};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{E_ACCESSDENIED, RECT};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::{
    DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, DXGI_ERROR_SESSION_DISCONNECTED,
    DXGI_ERROR_UNSUPPORTED, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    DXGI_OUTDUPL_MOVE_RECT, DXGI_OUTDUPL_POINTER_SHAPE_INFO, IDXGIOutput, IDXGIOutput1,
    IDXGIOutput5, IDXGIOutputDuplication, IDXGIResource,
};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::core::Interface;

/// Where a screen's frames go.
#[derive(Clone)]
pub enum Sink {
    /// Textures on this device, read in place by its encoder.
    Gpu(Device),
    /// BGRA in memory, converted to I420 for a software encoder.
    Cpu,
}

/// Where the captured monitor sits on the virtual desktop, in physical pixels: what input maps a viewer's point with.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Geometry {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

/// What the duplication thread hands the pipeline.
#[derive(Default)]
pub(crate) struct Shared {
    /// Changed areas (x0, y0, x1, y1) since the last pump.
    rects: Vec<(u32, u32, u32, u32)>,
    /// The monitor changed size, moved to another GPU, or the GPU was reset: open a new capture.
    rebuild: bool,
    /// The monitor is gone: the screen ends, its viewers told why.
    gone: Option<String>,
    /// The duplication has been unavailable for a while for a reason a fallback may serve (a Remote Desktop session).
    unsupported: bool,
}

/// What a duplication thread tells its owner: this process's pipeline ([`LocalOut`]), or a viewer's process across the
/// helper's pipe.
pub(crate) trait DupOut: Send + Sync + 'static {
    /// Areas of the mirror that changed.
    fn rects(&self, rects: &[(u32, u32, u32, u32)]);
    /// The monitor changed size, moved to another GPU, or the GPU was reset.
    fn rebuild(&self);
    /// The monitor is gone.
    fn gone(&self, why: String);
    /// Duplication is not offered, or refused with the person's own desktop showing: GDI stands in.
    fn fallback(&self, why: String);
    fn cursor(&self, cursor: MediaCursor);
    fn status(&self, status: CaptureStatus);
    /// Whether to stop waiting for duplication and open the capture again: the lock screen and admin prompts helper
    /// became reachable while this process could not see the desktop.
    fn hand_over(&self) -> bool {
        false
    }
}

/// The pipeline of this process: rectangles into `shared` and a signal on `wake`, the pointer to the hub.
pub(crate) struct LocalOut {
    pub(crate) name: String,
    pub(crate) shared: Arc<Mutex<Shared>>,
    pub(crate) wake: Arc<Wake>,
    pub(crate) hub: Arc<Hub>,
    pub(crate) gdi: Arc<AtomicBool>,
    pub(crate) status: StatusCell,
    /// The helper this screen could use, asked now and then while the desktop cannot be seen.
    pub(crate) helper: Option<Arc<dyn crate::helper::Finder>>,
    /// Whether the duplication is the helper's (statuses read `helper` rather than `dxgi`).
    pub(crate) via_helper: bool,
    pub(crate) last_probe: Mutex<Option<Instant>>,
}

impl DupOut for LocalOut {
    fn rects(&self, rects: &[(u32, u32, u32, u32)]) {
        self.shared.lock().rects.extend_from_slice(rects);
        self.wake.signal();
    }
    fn rebuild(&self) {
        self.shared.lock().rebuild = true;
        self.wake.signal();
    }
    fn gone(&self, why: String) {
        self.shared.lock().gone = Some(why);
        self.wake.signal();
    }
    fn fallback(&self, why: String) {
        log::warn!("{}: {why}; capturing with GDI until desktop duplication works again", self.name);
        self.gdi.store(true, Ordering::Relaxed);
        self.shared.lock().unsupported = true;
        self.wake.signal();
    }
    fn cursor(&self, cursor: MediaCursor) {
        self.hub.set_cursor(cursor);
    }
    fn status(&self, mut status: CaptureStatus) {
        if self.via_helper && status.via == "dxgi" {
            status.via = "helper".into();
        }
        session::report(&self.status, &self.name, status);
    }
    fn hand_over(&self) -> bool {
        let Some(helper) = &self.helper else {
            return false;
        };
        if self.via_helper {
            return false;
        }
        let mut last = self.last_probe.lock();
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
            return false;
        }
        *last = Some(Instant::now());
        helper.present()
    }
}

/// One monitor, captured again after every change of size.
pub struct DxgiSource {
    id: String,
    hub: Arc<Hub>,
    sink: Sink,
    /// A device per adapter the monitor was captured on, kept across reopenings.
    devices: HashMap<i64, Device>,
    pub geometry: Arc<Mutex<Geometry>>,
    /// The last shape and visibility sent, so the next capture only sends a change.
    cursor: Arc<Mutex<CursorState>>,
    /// Duplication refused here (a Remote Desktop session, some VMs, a desktop Windows will not duplicate for this
    /// process although it is not a secure one): GDI until duplication works again, which the GDI capture checks.
    gdi: Arc<AtomicBool>,
    /// `CAST_WIN_CAPTURE=gdi`: GDI whatever duplication would do.
    gdi_forced: bool,
    /// How the picture is made now, and why not by duplication when it is not: `/info` and `/stats` read it.
    pub status: StatusCell,
    /// The lock screen and admin prompts helper, when this computer has it: its duplication (which sees the secure
    /// desktop too) is used before this process's own.
    helper: Option<Arc<dyn crate::helper::Finder>>,
}

#[derive(Default)]
pub(crate) struct CursorState {
    shape: Option<cursor::Shape>,
    css: Option<&'static str>,
    pointer: Pointer,
    sent_hidden: bool,
}

impl DxgiSource {
    pub fn new(id: &str, hub: Arc<Hub>, sink: Sink) -> DxgiSource {
        DxgiSource::with_helper(id, hub, sink, None)
    }

    /// As [`DxgiSource::new`], the picture taken from `helper` whenever it is reachable.
    pub fn with_helper(
        id: &str,
        hub: Arc<Hub>,
        sink: Sink,
        helper: Option<Arc<dyn crate::helper::Finder>>,
    ) -> DxgiSource {
        let mut devices = HashMap::new();
        if let Sink::Gpu(d) = &sink {
            devices.insert(d.adapter.luid, d.clone());
        }
        DxgiSource {
            id: id.to_string(),
            hub,
            sink,
            devices,
            geometry: Arc::new(Mutex::new(Geometry::default())),
            cursor: Arc::new(Mutex::new(CursorState::default())),
            gdi: Arc::new(AtomicBool::new(false)),
            gdi_forced: std::env::var("CAST_WIN_CAPTURE").is_ok_and(|v| v == "gdi"),
            status: Arc::new(Mutex::new(CaptureStatus::new("dxgi"))),
            helper,
        }
    }

    /// The monitor, waiting out the moment a mode change re-enumerates outputs.
    fn display(&self) -> Result<Display, String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(d) = displays::find(&self.id) {
                return Ok(d);
            }
            if Instant::now() >= deadline {
                return Err(format!("monitor {} is no longer attached", self.id));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn device_for(&mut self, display: &Display) -> Result<Device, String> {
        if let Some(d) = self.devices.get(&display.adapter.luid) {
            if d.removed().is_none() {
                return Ok(d.clone());
            }
            log::warn!("{} was reset; a new device is opened", display.adapter.name);
        }
        let d = Device::new(&display.adapter)?;
        self.devices.insert(display.adapter.luid, d.clone());
        Ok(d)
    }

    fn local_out(&self, display: &Display, shared: &Arc<Mutex<Shared>>, wake: &Arc<Wake>, via_helper: bool) -> LocalOut {
        LocalOut {
            name: display.name.clone(),
            shared: shared.clone(),
            wake: wake.clone(),
            hub: self.hub.clone(),
            gdi: self.gdi.clone(),
            status: self.status.clone(),
            helper: self.helper.clone(),
            via_helper,
            last_probe: Mutex::new(None),
        }
    }
}

impl ScreenSource for DxgiSource {
    fn open(&mut self, crop: Option<Rect>) -> Result<Box<dyn Capture>, String> {
        if crop.is_some() {
            log::warn!("a monitor is captured whole; the crop is ignored");
        }
        let display = self.display()?;
        self.hub.set_scale(display.scale);
        *self.geometry.lock() = Geometry {
            left: display.rect.left,
            top: display.rect.top,
            width: display.width(),
            height: display.height(),
        };
        if self.gdi_forced || self.gdi.load(Ordering::Relaxed) {
            let retry = (!self.gdi_forced).then(|| self.gdi.clone());
            return Ok(Box::new(crate::gdi::GdiCapture::open(
                &display,
                self.hub.clone(),
                retry,
                Some(self.status.clone()),
            )?));
        }
        // The sink's own device after a reset, before the capture's.
        if let Sink::Gpu(d) = &self.sink
            && let Some(why) = d.removed()
        {
            return Err(format!("the encoder's GPU was reset ({why})"));
        }
        let dev = self.device_for(&display)?;
        if let Some(link) = self.helper.as_ref().and_then(|h| h.link()) {
            match DxgiCapture::open_helper(&display, dev.clone(), self.sink.clone(), self, &link) {
                Ok(c) => return Ok(Box::new(c)),
                Err(why) => log::warn!(
                    "{}: the lock screen and admin prompts helper did not open it ({why}); duplicating here",
                    display.name
                ),
            }
        }
        match DxgiCapture::open(&display, dev, self.sink.clone(), self) {
            Ok(c) => Ok(Box::new(c)),
            Err(Open::Unsupported(why)) => {
                log::warn!(
                    "desktop duplication unavailable on {} ({why}); capturing with GDI",
                    display.name
                );
                self.gdi.store(true, Ordering::Relaxed);
                session::report(
                    &self.status,
                    &display.name,
                    CaptureStatus {
                        reason: Some(format!("desktop duplication is not offered here ({why})")),
                        ..CaptureStatus::new("gdi")
                    },
                );
                Ok(Box::new(crate::gdi::GdiCapture::open(
                    &display,
                    self.hub.clone(),
                    Some(self.gdi.clone()),
                    Some(self.status.clone()),
                )?))
            }
            Err(Open::Failed(why)) => Err(why),
        }
    }
}

pub(crate) enum Open {
    /// Duplication is not offered here (Remote Desktop, some VMs, too many duplications): GDI serves instead.
    Unsupported(String),
    Failed(String),
}

/// A duplication thread running on one monitor, and the mirror it copies each desktop image into: shared (an NT
/// handle) so the pipeline's device, in this process or the viewer's, opens it.
pub(crate) struct Started {
    pub(crate) thread: std::thread::JoinHandle<()>,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) handle: crate::d3d::Shared,
    pub(crate) size: (u32, u32),
}

/// Duplicates `display` on a device of the thread's own and starts the thread reporting to `out`. `secure_visible`:
/// this process runs as SYSTEM and follows the input desktop, the secure one included.
pub(crate) fn start(
    display: &Display,
    out: Arc<dyn DupOut>,
    cursor: Arc<Mutex<CursorState>>,
    secure_visible: bool,
) -> Result<Started, Open> {
    let stop = Arc::new(AtomicBool::new(false));
    // The first duplication is made here, so a refusal chooses the fallback before any thread runs.
    let mut tries = 0;
    let dup_dev = Device::new(&display.adapter).map_err(Open::Failed)?;
    if secure_visible {
        crate::follow_input_desktop();
    }
    let dup = loop {
        match duplicate(&dup_dev, &display.output) {
            Ok(d) => break Some(d),
            // A desktop this process may not see now (locked, a UAC prompt, the display off): open anyway, showing the
            // placeholder until it is back.
            Err(e) if e.code() == E_ACCESSDENIED || e.code() == DXGI_ERROR_SESSION_DISCONNECTED => {
                log::info!("{}: the desktop cannot be duplicated now ({e})", display.name);
                break None;
            }
            Err(e) if e.code() == DXGI_ERROR_UNSUPPORTED => {
                return Err(Open::Unsupported(e.to_string()));
            }
            // Four duplications per output at most, across every program.
            Err(e) if e.code() == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE && tries >= 10 => {
                return Err(Open::Unsupported(e.to_string()));
            }
            Err(e) if tries >= 10 => return Err(Open::Failed(format!("DuplicateOutput: {e}"))),
            Err(e) => {
                log::debug!("DuplicateOutput: {e}; retrying");
                tries += 1;
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    };
    let (full_w, full_h) = dup
        .as_ref()
        .map_or((display.width(), display.height()), dup_size);
    // The mirror lives on the duplication's own device and is opened on the pipeline's: AcquireNextFrame holds its
    // device's lock while it waits (measured on omen: a copy on the same device waited 219-435 ms on a still screen),
    // so nothing else may share that device. A keyed mutex orders the two devices' copies.
    let (dup_mirror, handle) = dup_dev
        .shared_texture(full_w, full_h)
        .map_err(Open::Failed)?;
    let ctx = DupThread {
        id: display.id.clone(),
        name: display.name.clone(),
        dev: dup_dev,
        luid: display.adapter.luid,
        mirror: dup_mirror,
        size: (full_w, full_h),
        stop: stop.clone(),
        cursor,
        out,
        secure_visible,
    };
    let thread = std::thread::Builder::new()
        .name(format!("dup-{}", display.id))
        .spawn(move || ctx.run(dup))
        .map_err(|e| Open::Failed(e.to_string()))?;
    Ok(Started {
        thread,
        stop,
        handle,
        size: (full_w, full_h),
    })
}

/// Duplicates `output` on `dev`: BGRA from `DuplicateOutput1` (Windows converts an HDR desktop), else the original
/// `DuplicateOutput`.
fn duplicate(dev: &Device, output: &IDXGIOutput) -> windows::core::Result<IDXGIOutputDuplication> {
    if let Ok(o5) = output.cast::<IDXGIOutput5>() {
        let formats = [DXGI_FORMAT_B8G8R8A8_UNORM];
        // SAFETY: the device and a format list that outlives the call.
        match unsafe { o5.DuplicateOutput1(&dev.device, 0, &formats) } {
            Ok(d) => return Ok(d),
            Err(e) => log::debug!("DuplicateOutput1: {e}; trying DuplicateOutput"),
        }
    }
    let o1: IDXGIOutput1 = output.cast()?;
    // SAFETY: the device to duplicate on.
    unsafe { o1.DuplicateOutput(&dev.device) }
}

/// The duplicated desktop's size.
fn dup_size(dup: &IDXGIOutputDuplication) -> (u32, u32) {
    // SAFETY: a plain query.
    let desc = unsafe { dup.GetDesc() };
    (desc.ModeDesc.Width, desc.ModeDesc.Height)
}

pub struct DxgiCapture {
    id: String,
    /// The picture's size: the desktop's, made even.
    w: u32,
    h: u32,
    /// The desktop texture's size.
    full_w: u32,
    damage: Damage,
    wake: Arc<Wake>,
    shared: Arc<Mutex<Shared>>,
    /// What fills the mirror: a thread of this process, or the helper.
    producer: Producer,
    /// The pipeline's device on the monitor's GPU (the encoder's, when it is on the same one), and the duplication's
    /// mirror opened on it.
    dev: Device,
    mirror: ID3D11Texture2D,
    sink: Sink,
    /// The picture read back into memory: the CPU sink's frames, a screenshot, a cross-adapter bridge.
    cpu: Option<Readback>,
    rebuild: bool,
    changed: bool,
    geometry: Arc<Mutex<Geometry>>,
    /// The monitor's HMONITOR, as a number (the handle type is not Send).
    monitor: isize,
    last_check: Instant,
}

/// What fills a capture's mirror.
enum Producer {
    /// A duplication thread of this process.
    Local {
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    },
    /// The helper's duplication thread: closed on its side when the lease is dropped.
    Helper { _lease: crate::helper::client::Lease },
}

/// A staging texture on the capture's device and the BGRA buffer rows are read back into.
struct Readback {
    staging: ID3D11Texture2D,
    buf: Vec<u8>,
    stride: usize,
}

impl DxgiCapture {
    fn open(
        display: &Display,
        dev: Device,
        sink: Sink,
        source: &DxgiSource,
    ) -> Result<DxgiCapture, Open> {
        let wake = Arc::new(Wake::new().map_err(|e| Open::Failed(e.to_string()))?);
        let shared = Arc::new(Mutex::new(Shared::default()));
        let out = Arc::new(source.local_out(display, &shared, &wake, false));
        let started = start(display, out, source.cursor.clone(), false)?;
        let mirror = dev.open_shared(&started.handle).map_err(Open::Failed)?;
        drop(started.handle);
        let producer = Producer::Local {
            stop: started.stop,
            thread: Some(started.thread),
        };
        DxgiCapture::assemble(display, dev, sink, source, mirror, started.size, wake, shared, producer)
            .map_err(Open::Failed)
    }

    /// The monitor duplicated by the lock screen and admin prompts helper: its mirror opened here from the handle it
    /// gave this process, its rectangles and pointer arriving over its pipe.
    fn open_helper(
        display: &Display,
        dev: Device,
        sink: Sink,
        source: &DxgiSource,
        link: &Arc<crate::helper::client::Link>,
    ) -> Result<DxgiCapture, String> {
        let wake = Arc::new(Wake::new().map_err(|e| e.to_string())?);
        let shared = Arc::new(Mutex::new(Shared::default()));
        let out = Arc::new(source.local_out(display, &shared, &wake, true));
        let (lease, handle, size) = link.open(&display.id, out)?;
        let mirror = dev.open_shared(&handle)?;
        drop(handle);
        log::info!(
            "{}: duplicated by the lock screen and admin prompts helper ({}x{})",
            display.name,
            size.0,
            size.1
        );
        DxgiCapture::assemble(display, dev, sink, source, mirror, size, wake, shared, Producer::Helper { _lease: lease })
    }

    #[allow(clippy::too_many_arguments)]
    fn assemble(
        display: &Display,
        dev: Device,
        sink: Sink,
        source: &DxgiSource,
        mirror: ID3D11Texture2D,
        (full_w, full_h): (u32, u32),
        wake: Arc<Wake>,
        shared: Arc<Mutex<Shared>>,
        producer: Producer,
    ) -> Result<DxgiCapture, String> {
        let (w, h) = (full_w & !1, full_h & !1);
        log::info!(
            "capturing {} ({}x{} at {},{}, scale {}) on {} with desktop duplication, frames {}",
            display.name,
            full_w,
            full_h,
            display.rect.left,
            display.rect.top,
            display.scale,
            display.adapter.name,
            match &sink {
                Sink::Gpu(d) if d.same_gpu(&dev) => "on the same GPU".to_string(),
                Sink::Gpu(d) => format!("crossing to {} through memory", d.adapter.name),
                Sink::Cpu => "in memory".to_string(),
            }
        );
        let mut me = DxgiCapture {
            id: display.id.clone(),
            w,
            h,
            full_w,
            damage: Damage::new(w, h),
            wake,
            shared,
            producer,
            dev,
            mirror,
            sink,
            cpu: None,
            rebuild: false,
            changed: false,
            geometry: source.geometry.clone(),
            monitor: display.monitor.0 as isize,
            last_check: Instant::now(),
        };
        // Duplication opens with the whole desktop as its first frame; have it before anything reads the mirror.
        let t = Instant::now();
        while t.elapsed() < Duration::from_millis(500) {
            if !me.shared.lock().rects.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        if matches!(me.sink, Sink::Cpu) {
            me.readback(0, me.h)?;
        }
        Ok(me)
    }

    /// Reads rows [y0, y1) of the mirror back into memory.
    fn readback(&mut self, y0: u32, y1: u32) -> Result<(), String> {
        if y1 <= y0 {
            return Ok(());
        }
        if self.cpu.is_none() {
            let staging = self.dev.staging(self.full_w, self.h, true)?;
            let stride = self.w as usize * 4;
            self.cpu = Some(Readback {
                staging,
                buf: vec![0; stride * self.h as usize],
                stride,
            });
        }
        let rb = self.cpu.as_mut().expect("made above");
        {
            let _held = Held::take(&self.mirror)?;
            self.dev
                .copy_rect(&rb.staging, &self.mirror, (0, y0, self.w, y1));
        }
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: a staging texture of this device, mapped for reading and unmapped below.
        unsafe {
            self.dev
                .ctx
                .Map(&rb.staging, 0, D3D11_MAP_READ, 0, Some(&mut m))
        }
        .map_err(|e| format!("Map: {e}"))?;
        let pitch = m.RowPitch as usize;
        let src = m.pData as *const u8;
        for y in y0 as usize..y1 as usize {
            // SAFETY: row y of the mapped texture (pitch bytes a row, at least w * 4) into row y of the buffer.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    src.add(y * pitch),
                    rb.buf.as_mut_ptr().add(y * rb.stride),
                    rb.stride,
                )
            };
        }
        // SAFETY: the mapping made above.
        unsafe { self.dev.ctx.Unmap(&rb.staging, 0) };
        Ok(())
    }

    /// Notices the monitor moving on the virtual desktop (another monitor arranged) and changing size.
    fn check_geometry(&mut self) {
        if self.last_check.elapsed() < Duration::from_secs(1) {
            return;
        }
        self.last_check = Instant::now();
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: a monitor handle and a sized struct; a stale handle fails and changes nothing.
        if !unsafe { GetMonitorInfoW(HMONITOR(self.monitor as *mut _), &mut mi) }.as_bool() {
            return;
        }
        let r: RECT = mi.rcMonitor;
        let mut g = self.geometry.lock();
        let (w, h) = ((r.right - r.left) as u32, (r.bottom - r.top) as u32);
        if (w & !1, h & !1) != (self.w, self.h) {
            log::info!("monitor {} is now {w}x{h}; capturing it again", self.id);
            self.rebuild = true;
        } else if (r.left, r.top) != (g.left, g.top) {
            log::info!("monitor {} moved to {},{}", self.id, r.left, r.top);
            g.left = r.left;
            g.top = r.top;
        }
    }
}

impl Capture for DxgiCapture {
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
            if let Some(why) = s.gone.take() {
                return Err(why);
            }
            if s.rebuild || s.unsupported {
                self.rebuild = true;
                self.changed = true;
            }
            std::mem::take(&mut s.rects)
        };
        for (x0, y0, x1, y1) in rects {
            self.damage.add(x0, y0, x1, y1);
        }
        self.check_geometry();
        Ok(())
    }

    fn needs_rebuild(&self) -> bool {
        self.rebuild
    }

    fn geometry_changed(&self) -> bool {
        self.changed
    }

    fn grab(&mut self, band: Band) -> Result<(), String> {
        match self.sink {
            Sink::Cpu => self.readback(band.y0, band.y1),
            Sink::Gpu(_) => Ok(()),
        }
    }

    fn pixels(&self) -> Option<(&[u8], usize)> {
        match self.sink {
            Sink::Cpu => self.cpu.as_ref().map(|r| (r.buf.as_slice(), r.stride)),
            Sink::Gpu(_) => None,
        }
    }

    fn formats(&self) -> &[FrameFormat] {
        // On the GPU sink the CPU frames are still offered: the fallback encoder (openh264) takes a picture the hardware
        // one cannot open at, and reads I420, which `fill` then reads back for.
        match self.sink {
            Sink::Gpu(_) => &[FrameFormat::Native, FrameFormat::I420, FrameFormat::Bgra],
            Sink::Cpu => &[FrameFormat::I420, FrameFormat::Bgra],
        }
    }

    fn new_frame(&mut self, format: FrameFormat) -> Result<Frame, String> {
        match (&self.sink, format) {
            (Sink::Gpu(d), FrameFormat::Native) => Ok(Frame::Native(Box::new(GpuFrame {
                texture: d.texture(self.w, self.h)?,
                width: self.w,
                height: self.h,
                luid: d.adapter.luid,
            }))),
            (_, FrameFormat::Native) => Err("frames of this capture are in memory".into()),
            (_, f) => Frame::cpu(f, self.w as usize, self.h as usize)
                .ok_or_else(|| "no such frame".to_string()),
        }
    }

    fn fill(
        &mut self,
        dst: &mut Frame,
        y0: usize,
        y1: usize,
        threads: usize,
    ) -> Result<(), String> {
        let (y0, y1) = (y0 as u32, (y1 as u32).min(self.h));
        match dst {
            Frame::Native(native) => {
                let Sink::Gpu(target) = self.sink.clone() else {
                    return Err("this capture makes no native frames".into());
                };
                let frame = native
                    .as_any_mut()
                    .downcast_mut::<GpuFrame>()
                    .ok_or("a native frame of another platform")?;
                if target.same_gpu(&self.dev) {
                    let _held = Held::take(&self.mirror)?;
                    self.dev
                        .copy_rect(&frame.texture, &self.mirror, (0, y0, self.w, y1));
                } else {
                    // Another GPU: through memory, the damaged rows only.
                    self.readback(y0, y1)?;
                    let rb = self.cpu.as_ref().expect("readback made it");
                    let b = D3D11_BOX {
                        left: 0,
                        top: y0,
                        front: 0,
                        right: self.w,
                        bottom: y1,
                        back: 1,
                    };
                    // SAFETY: rows y0..y1 of the buffer, `stride` bytes apart, into the same box of the frame.
                    unsafe {
                        target.ctx.UpdateSubresource(
                            &frame.texture,
                            0,
                            Some(&b),
                            rb.buf.as_ptr().add(y0 as usize * rb.stride).cast(),
                            rb.stride as u32,
                            0,
                        )
                    };
                    // SAFETY: a plain flush, so the upload starts before the encoder waits on it.
                    unsafe { target.ctx.Flush() };
                }
                Ok(())
            }
            Frame::I420(buf) => {
                if matches!(self.sink, Sink::Gpu(_)) {
                    self.readback(y0, y1)?;
                }
                let rb = self.cpu.as_ref().ok_or("nothing read back yet")?;
                cast_core::convert::convert_band(
                    &rb.buf,
                    rb.stride,
                    buf,
                    y0 as usize,
                    y1 as usize,
                    threads,
                );
                Ok(())
            }
            Frame::Bgra(buf) => {
                if matches!(self.sink, Sink::Gpu(_)) {
                    self.readback(y0, y1)?;
                }
                let rb = self.cpu.as_ref().ok_or("nothing read back yet")?;
                buf.copy_rows(&rb.buf, rb.stride, y0 as usize, y1 as usize);
                Ok(())
            }
        }
    }

    fn snapshot(&mut self) -> Result<Vec<u8>, String> {
        self.pump()?;
        self.readback(0, self.h)?;
        let rb = self.cpu.as_ref().expect("read back above");
        Ok(rb.buf.clone())
    }

    fn region(&mut self, r: Rect) -> Result<Vec<u8>, String> {
        let x = r.x.min(self.w);
        let y = r.y.min(self.h);
        let (w, h) = (r.w.min(self.w - x), r.h.min(self.h - y));
        self.readback(y, y + h)?;
        let rb = self.cpu.as_ref().expect("read back above");
        let mut out = Vec::with_capacity(w as usize * h as usize * 4);
        for line in y..y + h {
            let at = line as usize * rb.stride + x as usize * 4;
            out.extend_from_slice(&rb.buf[at..at + w as usize * 4]);
        }
        Ok(out)
    }
}

impl Drop for DxgiCapture {
    fn drop(&mut self) {
        if let Producer::Local { stop, thread } = &mut self.producer {
            stop.store(true, Ordering::Relaxed);
            if let Some(t) = thread.take() {
                let _ = t.join();
            }
        }
    }
}

/// What the duplication thread owns.
struct DupThread {
    id: String,
    name: String,
    dev: Device,
    luid: i64,
    mirror: ID3D11Texture2D,
    size: (u32, u32),
    stop: Arc<AtomicBool>,
    cursor: Arc<Mutex<CursorState>>,
    out: Arc<dyn DupOut>,
    /// This process runs as SYSTEM (the helper): it follows the input desktop onto a secure one.
    secure_visible: bool,
}

/// How long the duplication may be gone before the placeholder is shown.
const PLACEHOLDER_AFTER: Duration = Duration::from_millis(300);
/// How long a monitor may be missing before the screen ends.
const GONE_AFTER: Duration = Duration::from_secs(5);
/// How often a duplication that delivers nothing asks whether the display went off.
const DISPLAY_CHECK: Duration = Duration::from_secs(1);

impl DupThread {
    fn run(self, first: Option<IDXGIOutputDuplication>) {
        crate::keep_display_on();
        let full = (0, 0, self.size.0, self.size.1);
        let mut dup = match first {
            Some(d) => {
                self.out.status(CaptureStatus::new("dxgi"));
                d
            }
            None => match self.again() {
                Some(d) => d,
                None => return,
            },
        };
        let mut whole = true;
        let mut shape_buf: Vec<u8> = Vec::new();
        let mut last_frame = Instant::now();
        let mut last_display_check = Instant::now();
        while !self.stop.load(Ordering::Relaxed) {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut image: Option<IDXGIResource> = None;
            // SAFETY: out-pointers for the frame's info and image.
            match unsafe { dup.AcquireNextFrame(100, &mut info, &mut image) } {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    // Nothing new: a still screen, or a display Windows turned off (it composes nothing then, and the
                    // last picture would read as live).
                    if last_frame.elapsed() > DISPLAY_CHECK && last_display_check.elapsed() > DISPLAY_CHECK {
                        last_display_check = Instant::now();
                        if session::display() == session::Display::Off {
                            drop(dup);
                            match self.while_display_off() {
                                Some(d) => {
                                    dup = d;
                                    whole = true;
                                    continue;
                                }
                                None => return,
                            }
                        }
                    }
                    continue;
                }
                Err(e) => {
                    log::info!("{}: desktop duplication interrupted ({e})", self.name);
                    drop(image);
                    // Windows duplicates an output once per device: the old one goes first.
                    drop(dup);
                    match self.again() {
                        Some(d) => {
                            dup = d;
                            whole = true;
                            continue;
                        }
                        None => return,
                    }
                }
            }
            last_frame = Instant::now();
            if info.LastMouseUpdateTime != 0 {
                self.pointer(&dup, &info, &mut shape_buf);
            }
            // Only the pointer moved: no new desktop image.
            if info.LastPresentTime == 0 && !whole {
                // SAFETY: the frame acquired above.
                let _ = unsafe { dup.ReleaseFrame() };
                continue;
            }
            let rects = if whole {
                vec![full]
            } else {
                frame_rects(&dup, &info, self.size)
            };
            if let Some(img) = &image
                && !rects.is_empty()
            {
                match img
                    .cast::<ID3D11Texture2D>()
                    .map_err(|e| e.to_string())
                    .and_then(|tex| Held::take(&self.mirror).map(|h| (tex, h)))
                {
                    Ok((tex, _held)) => {
                        if rects.len() > 24 || whole {
                            // SAFETY: two textures of the same size and format on this device.
                            unsafe { self.dev.ctx.CopyResource(&self.mirror, &tex) };
                        } else {
                            for &r in &rects {
                                self.dev.copy_rect(&self.mirror, &tex, r);
                            }
                        }
                    }
                    Err(e) => log::warn!("{}: the desktop image was not copied: {e}", self.name),
                }
            }
            drop(image);
            // SAFETY: the frame acquired above, its image's copies queued.
            let _ = unsafe { dup.ReleaseFrame() };
            if !rects.is_empty() {
                whole = false;
                self.out.rects(&rects);
            }
        }
    }

    /// The display went off while duplicating: the placeholder says so until it is on again, then the monitor is
    /// duplicated afresh (a new duplication's first image is the whole desktop, which repaints over the placeholder).
    fn while_display_off(&self) -> Option<IDXGIOutputDuplication> {
        log::info!("{}: the display is off", self.name);
        self.placeholder(Blocked::DisplayOff.words());
        self.out.status(CaptureStatus::blocked("placeholder", Blocked::DisplayOff, None));
        while session::display() == session::Display::Off {
            if self.stop.load(Ordering::Relaxed) {
                return None;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        log::info!("{}: the display is on again", self.name);
        self.again()
    }

    /// Duplicates the monitor again after Windows took it away, showing the placeholder (and saying why in the
    /// screen's status) while it may not be seen. None when this thread is done: stopped, handed over, or the pipeline
    /// must open a new capture.
    fn again(&self) -> Option<IDXGIOutputDuplication> {
        let started = Instant::now();
        let mut shown: Option<Blocked> = None;
        let mut said = String::new();
        loop {
            if self.stop.load(Ordering::Relaxed) {
                return None;
            }
            crate::follow_input_desktop();
            let display = displays::displays().into_iter().find(|d| d.id == self.id);
            let Some(display) = display else {
                if started.elapsed() > GONE_AFTER {
                    self.out.gone(format!("the monitor {} was unplugged", self.name));
                    return None;
                }
                std::thread::sleep(Duration::from_millis(250));
                continue;
            };
            if display.adapter.luid != self.luid || self.dev.removed().is_some() {
                self.out.rebuild();
                return None;
            }
            match duplicate(&self.dev, &display.output) {
                Ok(d) => {
                    if dup_size(&d) != self.size {
                        drop(d);
                        self.out.rebuild();
                        return None;
                    }
                    log::info!("{}: desktop duplication is back", self.name);
                    self.out.status(CaptureStatus::new("dxgi"));
                    return Some(d);
                }
                Err(e) => {
                    let words = e.to_string();
                    if words != said {
                        log::info!("{}: duplicating again: {words}", self.name);
                        said.clone_from(&words);
                    }
                    let state = session::State::now();
                    let blocked = state.blocked(self.secure_visible);
                    if e.code() == DXGI_ERROR_UNSUPPORTED && started.elapsed() > Duration::from_secs(2) {
                        self.out.fallback(format!("desktop duplication is not offered here ({e})"));
                        return None;
                    }
                    // Refused with nothing Windows says explaining it: the person's own desktop showing, the session
                    // unlocked and on the screen, the display on. GDI can read what duplication will not (seen on rog,
                    // 2026-11-20, for minutes on end) and checks every 5 s whether duplication works again.
                    if e.code() == E_ACCESSDENIED
                        && blocked == Blocked::Unknown
                        && started.elapsed() > Duration::from_secs(2)
                    {
                        log::warn!("{}: duplication refused although nothing blocks it: {state:?}", self.name);
                        self.out.fallback(format!(
                            "desktop duplication refused ({e}) with the person's own desktop showing"
                        ));
                        return None;
                    }
                    if started.elapsed() > PLACEHOLDER_AFTER && shown != Some(blocked) {
                        if shown.is_none() {
                            log::info!("{}: {} ({state:?})", self.name, blocked.words());
                        }
                        shown = Some(blocked);
                        self.placeholder(blocked.words());
                        self.out.status(CaptureStatus::blocked("placeholder", blocked, Some(words)));
                    }
                    if shown.is_some() && self.out.hand_over() {
                        log::info!("{}: the lock screen and admin prompts helper is here; handing over", self.name);
                        self.out.rebuild();
                        return None;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(if shown.is_some() { 250 } else { 50 }));
        }
    }

    /// Paints the placeholder into the mirror and sends it as the picture.
    fn placeholder(&self, text: &str) {
        let (w, h) = self.size;
        let px = crate::placeholder::render(w, h, text);
        let b = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: w,
            bottom: h,
            back: 1,
        };
        let Ok(_held) = Held::take(&self.mirror) else {
            return;
        };
        // SAFETY: a w x h BGRA buffer into the whole mirror.
        unsafe {
            self.dev
                .ctx
                .UpdateSubresource(&self.mirror, 0, Some(&b), px.as_ptr().cast(), w * 4, 0)
        };
        self.out.cursor(cursor::hidden());
        self.cursor.lock().sent_hidden = true;
        self.out.rects(&[(0, 0, w, h)]);
    }

    /// Takes the pointer's position and, when it changed, its shape, and tells viewers what changed.
    fn pointer(
        &self,
        dup: &IDXGIOutputDuplication,
        info: &DXGI_OUTDUPL_FRAME_INFO,
        buf: &mut Vec<u8>,
    ) {
        let p = Pointer::from(
            info.PointerPosition.Visible.as_bool(),
            info.PointerPosition.Position,
        );
        // Where it is on this output (duplication's position is the output's own), or off the picture while it is on
        // another output or hidden: viewers draw it there when it is not their own (`pointer`).
        let (x, y) = if p.visible { (p.x, p.y) } else { (-1, -1) };
        self.hub.pointer_at(x, y);
        let mut st = self.cursor.lock();
        st.pointer = p;
        let mut changed = false;
        if info.PointerShapeBufferSize > 0 {
            buf.resize(info.PointerShapeBufferSize as usize, 0);
            let mut need = 0u32;
            let mut si = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
            // SAFETY: a buffer of the size the frame info gave, and out-pointers.
            let got = unsafe {
                dup.GetFramePointerShape(
                    buf.len() as u32,
                    buf.as_mut_ptr().cast(),
                    &mut need,
                    &mut si,
                )
            };
            if got.is_ok()
                && let Some(shape) = cursor::convert(&si, buf)
                && st.shape.as_ref() != Some(&shape)
            {
                st.shape = Some(shape);
                st.css = cursor::css_now();
                changed = true;
            }
        }
        if !p.visible {
            if !st.sent_hidden {
                st.sent_hidden = true;
                drop(st);
                self.out.cursor(cursor::hidden());
            }
            return;
        }
        if (changed || st.sent_hidden)
            && let Some(shape) = &st.shape
        {
            let msg = cursor::message(shape, st.css);
            st.sent_hidden = false;
            drop(st);
            self.out.cursor(msg);
        }
    }
}

/// The changed rectangles of the frame just acquired, clipped to the desktop: where moves landed, and what was drawn.
fn frame_rects(
    dup: &IDXGIOutputDuplication,
    info: &DXGI_OUTDUPL_FRAME_INFO,
    (w, h): (u32, u32),
) -> Vec<(u32, u32, u32, u32)> {
    let (w, h) = (w as i32, h as i32);
    let mut out = Vec::new();
    let mut push = |r: RECT| {
        let (x0, y0) = (r.left.clamp(0, w), r.top.clamp(0, h));
        let (x1, y1) = (r.right.clamp(0, w), r.bottom.clamp(0, h));
        if x1 > x0 && y1 > y0 {
            out.push((x0 as u32, y0 as u32, x1 as u32, y1 as u32));
        }
    };
    let size = info.TotalMetadataBufferSize as usize;
    if size == 0 {
        return out;
    }
    let mut need = 0u32;
    let mut moves = vec![
        DXGI_OUTDUPL_MOVE_RECT::default();
        size / std::mem::size_of::<DXGI_OUTDUPL_MOVE_RECT>() + 1
    ];
    let bytes = std::mem::size_of_val(moves.as_slice()) as u32;
    // SAFETY: a buffer of `bytes` and the count to fill.
    if unsafe { dup.GetFrameMoveRects(bytes, moves.as_mut_ptr(), &mut need) }.is_ok() {
        for m in &moves[..need as usize / std::mem::size_of::<DXGI_OUTDUPL_MOVE_RECT>()] {
            push(m.DestinationRect);
        }
    }
    let mut dirty = vec![RECT::default(); size / std::mem::size_of::<RECT>() + 1];
    let bytes = std::mem::size_of_val(dirty.as_slice()) as u32;
    // SAFETY: as above.
    if unsafe { dup.GetFrameDirtyRects(bytes, dirty.as_mut_ptr(), &mut need) }.is_ok() {
        for &r in &dirty[..need as usize / std::mem::size_of::<RECT>()] {
            push(r);
        }
    }
    out
}
