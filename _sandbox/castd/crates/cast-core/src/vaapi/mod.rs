//! VA-API's H.264 encoder: Intel's (Quick Sync, through the iHD or i965 driver) and AMD's (Mesa's radeonsi), and on
//! WSL2 the GPU behind D3D12 (Mesa's d3d12 driver). libva and libva-drm are opened at run time (ffi.rs), so a binary
//! with the `vaapi` feature runs where there is neither; [`device`] finds the first render node whose driver encodes
//! H.264 and keeps it for the process.
//!
//! castd's contract, as NVENC keeps it: the low-power entry point where the driver has one (Intel's VDEnc), no
//! B-frames and one reference, an infinite GOP with an IDR only when asked, each picture's access unit back from the
//! call that encoded it, and a rate change that is a new rate-control parameter on the next picture rather than a new
//! sequence. Rate control is NVENC's "floor": VBR (CBR where the driver has no VBR, never stuffing) aiming at the
//! controller's cap inside castd's 1.25-frame buffer, with the QP held at or above castd's CRF, so easy content stops
//! at that quality instead of spending the cap.
//!
//! The SPS and PPS are castd's own (h264.rs), handed over as a packed header where the driver takes one, so the stream
//! says what x264's and NVENC's do: BT.601 limited range from sRGB, nothing reordered. Pictures go in as I420
//! interleaved into the NV12 surface; with [`VaapiKind::vpp`] as BGRA that the driver's video processor converts, the
//! CPU then only copying.
//!
//! A driver may crash rather than fail (Mesa's d3d12 does, in its video processor and without a packed header): a
//! daemon that must outlive its encoder runs [`crate::encoder::self_test`] in a child process first (remoted does).

// libva's constants keep libva's names, matched on below.
#![allow(non_upper_case_globals)]

pub mod ffi;
pub mod h264;

use crate::encoder::{Encoded, EncoderConfig, EncoderKind, Planes, VideoEncoder, vbv_buffer_kbit};
use crate::frame::{FrameFormat, Picture};
use ffi::*;
use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::{Arc, OnceLock};

/// The GOP length the driver is told: intra-only pictures come when asked, never on a schedule. 2^15 - 1, which
/// drivers that keep the GOP in 16 bits take (0 is "intra only" to some).
const GOP: u32 = 32_767;

/// frame_num's range: 2^16, so it wraps once every 18 minutes at 60 frames a second (which the standard allows).
const LOG2_MAX_FRAME_NUM: u32 = 16;

/// One VA display on a render node, shared by every encoder the process opens on it.
pub struct Device {
    va: Arc<Va>,
    dpy: VADisplay,
    _node: std::fs::File,
    /// `/dev/dri/renderD128`.
    pub node: String,
    /// The driver's own name for itself (`Intel iHD driver … 24.1.0`, `Mesa Gallium driver … for AMD …`).
    pub vendor: String,
    /// The H.264 profile and entry point encoders use, the best the driver offers.
    profile: VAProfile,
    entrypoint: VAEntrypoint,
    /// Whether the driver has a video processor (BGRA in, NV12 out).
    pub vpp: bool,
}

// The display is libva's handle, which libva and its drivers make safe across threads (each encoder has its own
// context); the function table is plain function pointers.
unsafe impl Send for Device {}
unsafe impl Sync for Device {}

impl Drop for Device {
    fn drop(&mut self) {
        // SAFETY: the display was initialized and nothing of it outlives the device (encoders hold an Arc).
        unsafe { (self.va.vaTerminate)(self.dpy) };
    }
}

unsafe extern "C" fn quiet(_ctx: *mut c_void, message: *const c_char) {
    if !message.is_null() {
        // SAFETY: libva hands a NUL-terminated message.
        let text = unsafe { CStr::from_ptr(message) }.to_string_lossy();
        log::debug!("libva: {}", text.trim_end());
    }
}

/// The process's VA-API device: `CAST_VAAPI_DEVICE` (a render node's path) when set, else the first render node whose
/// driver encodes H.264. Looked for once; the error says what was tried.
pub fn device() -> Result<Arc<Device>, String> {
    static DEVICE: OnceLock<Result<Arc<Device>, String>> = OnceLock::new();
    DEVICE.get_or_init(find).clone()
}

fn find() -> Result<Arc<Device>, String> {
    let va = Arc::new(Va::load()?);
    let nodes: Vec<String> = match std::env::var("CAST_VAAPI_DEVICE") {
        Ok(node) if !node.is_empty() => vec![node],
        _ => (128..136)
            .map(|n| format!("/dev/dri/renderD{n}"))
            .filter(|p| std::path::Path::new(p).exists())
            .collect(),
    };
    if nodes.is_empty() {
        return Err("no GPU render node (/dev/dri/renderD*)".into());
    }
    let mut why = Vec::new();
    for node in nodes {
        match Device::open(&va, &node) {
            Ok(d) => {
                log::info!(
                    "vaapi: {} ({}): H.264 {} on {}, {}",
                    d.node,
                    d.vendor,
                    profile_name(d.profile),
                    if d.entrypoint == VAEntrypointEncSliceLP {
                        "the low-power encoder"
                    } else {
                        "the encoder"
                    },
                    if d.vpp {
                        "a video processor"
                    } else {
                        "no video processor"
                    }
                );
                return Ok(Arc::new(d));
            }
            Err(e) => why.push(format!("{node}: {e}")),
        }
    }
    Err(why.join("; "))
}

fn profile_name(p: VAProfile) -> &'static str {
    match p {
        VAProfileH264High => "High",
        VAProfileH264Main => "Main",
        _ => "Constrained Baseline",
    }
}

/// Calls a libva function, an error naming the call.
macro_rules! va {
    ($va:expr, $f:ident($($arg:expr),* $(,)?)) => {{
        // SAFETY: every call passes the display it was opened with and objects created on it, and pointers to live
        // values of the types va.h names.
        let status = unsafe { ($va.$f)($($arg),*) };
        if status == VA_STATUS_SUCCESS {
            Ok(())
        } else {
            Err(format!("{}: {}", stringify!($f), $va.error(status)))
        }
    }};
}

impl Device {
    fn open(va: &Arc<Va>, node: &str) -> Result<Device, String> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(node)
            .map_err(|e| format!("cannot open it: {e}"))?;
        use std::os::fd::AsRawFd;
        let init = |driver: Option<&str>| -> Result<VADisplay, String> {
            // SAFETY: the fd is the open render node, kept open for the display's life.
            let dpy = unsafe { (va.vaGetDisplayDRM)(file.as_raw_fd()) };
            if dpy.is_null() {
                return Err("vaGetDisplayDRM failed".into());
            }
            // SAFETY: the callbacks only log the message they are given.
            unsafe {
                if let Some(f) = va.vaSetInfoCallback {
                    f(dpy, Some(quiet), std::ptr::null_mut());
                }
                if let Some(f) = va.vaSetErrorCallback {
                    f(dpy, Some(quiet), std::ptr::null_mut());
                }
            }
            if let (Some(name), Some(set)) = (driver, va.vaSetDriverName) {
                let name = CString::new(name).expect("a driver name");
                // SAFETY: a NUL-terminated name, copied by libva.
                unsafe { set(dpy, name.as_ptr() as *const c_char) };
            }
            let (mut major, mut minor) = (0, 0);
            if let Err(e) = va!(va, vaInitialize(dpy, &mut major, &mut minor)) {
                // SAFETY: a display that failed to initialize is still terminated to free it.
                unsafe { (va.vaTerminate)(dpy) };
                return Err(e);
            }
            Ok(dpy)
        };
        // On WSL2 the render node is a placeholder (vgem) and the GPU is reached through D3D12: libva cannot tell from
        // the node, so it is asked for by name when the first try fails.
        let wsl = std::path::Path::new("/dev/dxg").exists()
            && std::env::var_os("LIBVA_DRIVER_NAME").is_none();
        let dpy = match init(None) {
            Ok(d) => d,
            Err(e) if wsl => init(Some("d3d12")).map_err(|e2| format!("{e}; as d3d12: {e2}"))?,
            Err(e) => return Err(e),
        };
        // SAFETY: a static string of the driver's.
        let vendor = unsafe {
            let s = (va.vaQueryVendorString)(dpy);
            if s.is_null() {
                String::new()
            } else {
                CStr::from_ptr(s).to_string_lossy().into_owned()
            }
        };
        let mut device = Device {
            va: va.clone(),
            dpy,
            _node: file,
            node: node.to_owned(),
            vendor,
            profile: VAProfileNone,
            entrypoint: 0,
            vpp: false,
        };
        let max = unsafe { (device.va.vaMaxNumEntrypoints)(dpy) }.max(1) as usize;
        let entrypoints = |profile: VAProfile| -> Vec<VAEntrypoint> {
            let mut list = vec![0; max];
            let mut n = 0;
            let ok = va!(
                device.va,
                vaQueryConfigEntrypoints(dpy, profile, list.as_mut_ptr(), &mut n)
            );
            if ok.is_err() {
                return Vec::new();
            }
            list.truncate(n.max(0) as usize);
            list
        };
        let low_power = std::env::var("CAST_VAAPI_LOW_POWER").map_or(true, |v| v != "0");
        let mut found = None;
        for profile in [
            VAProfileH264High,
            VAProfileH264Main,
            VAProfileH264ConstrainedBaseline,
        ] {
            let eps = entrypoints(profile);
            let ep = if low_power && eps.contains(&VAEntrypointEncSliceLP) {
                Some(VAEntrypointEncSliceLP)
            } else if eps.contains(&VAEntrypointEncSlice) {
                Some(VAEntrypointEncSlice)
            } else if eps.contains(&VAEntrypointEncSliceLP) {
                Some(VAEntrypointEncSliceLP)
            } else {
                None
            };
            if let Some(ep) = ep {
                found = Some((profile, ep));
                break;
            }
        }
        let Some((profile, entrypoint)) = found else {
            return Err(format!(
                "{} has no H.264 encoder",
                if device.vendor.is_empty() {
                    "the driver"
                } else {
                    &device.vendor
                }
            ));
        };
        device.profile = profile;
        device.entrypoint = entrypoint;
        device.vpp = entrypoints(VAProfileNone).contains(&VAEntrypointVideoProc);
        Ok(device)
    }

    fn attribute(&self, entrypoint: VAEntrypoint, kind: i32) -> Option<u32> {
        let mut a = VAConfigAttrib {
            type_: kind,
            value: 0,
        };
        va!(
            self.va,
            vaGetConfigAttributes(self.dpy, self.profile, entrypoint, &mut a, 1)
        )
        .ok()?;
        (a.value != VA_ATTRIB_NOT_SUPPORTED).then_some(a.value)
    }

    fn surfaces(&self, format: u32, fourcc: Option<u32>, w: u32, h: u32, n: usize) -> Result<Vec<VASurfaceID>, String> {
        let mut ids = vec![VA_INVALID_SURFACE; n];
        let mut attrs: Vec<VASurfaceAttrib> = fourcc
            .map(|f| VASurfaceAttrib::int(VASurfaceAttribPixelFormat, f as i32))
            .into_iter()
            .collect();
        va!(
            self.va,
            vaCreateSurfaces(
                self.dpy,
                format,
                w,
                h,
                ids.as_mut_ptr(),
                n as u32,
                if attrs.is_empty() {
                    std::ptr::null_mut()
                } else {
                    attrs.as_mut_ptr()
                },
                attrs.len() as u32
            )
        )?;
        Ok(ids)
    }

    /// A parameter buffer holding `data`'s bytes.
    fn buffer<T: Copy>(&self, ctx: VAContextID, kind: VABufferType, data: &T) -> Result<VABufferID, String> {
        self.buffer_bytes(ctx, kind, std::ptr::from_ref(data).cast(), size_of::<T>())
    }

    fn buffer_bytes(&self, ctx: VAContextID, kind: VABufferType, data: *const u8, len: usize) -> Result<VABufferID, String> {
        let mut id = VA_INVALID_ID;
        va!(
            self.va,
            vaCreateBuffer(self.dpy, ctx, kind, len as u32, 1, data as *mut c_void, &mut id)
        )?;
        Ok(id)
    }

    /// A misc parameter buffer: its type, then `payload`.
    fn misc<T: Copy>(&self, ctx: VAContextID, kind: u32, payload: &T) -> Result<VABufferID, String> {
        let mut bytes = kind.to_ne_bytes().to_vec();
        // SAFETY: T is one of ffi.rs's plain-data payloads.
        bytes.extend_from_slice(unsafe {
            std::slice::from_raw_parts(std::ptr::from_ref(payload).cast::<u8>(), size_of::<T>())
        });
        self.buffer_bytes(ctx, VAEncMiscParameterBufferType, bytes.as_ptr(), bytes.len())
    }

    /// Writes into `surface` through `write(memory, pitches, offsets)`: mapped in place where the driver derives an
    /// image of it, else through an image of `format` put onto it.
    fn upload(
        &self,
        surface: VASurfaceID,
        format: &VAImageFormat,
        w: u32,
        h: u32,
        derive: &mut bool,
        write: impl FnOnce(*mut u8, [u32; 3], [u32; 3]),
    ) -> Result<(), String> {
        let mut image: VAImage = zeroed();
        let derived = *derive && va!(self.va, vaDeriveImage(self.dpy, surface, &mut image)).is_ok();
        if !derived {
            *derive = false;
            let mut f = *format;
            va!(self.va, vaCreateImage(self.dpy, &mut f, w as i32, h as i32, &mut image))?;
        }
        let result = (|| {
            let mut ptr = std::ptr::null_mut();
            va!(self.va, vaMapBuffer(self.dpy, image.buf, &mut ptr))?;
            write(ptr.cast(), image.pitches, image.offsets);
            va!(self.va, vaUnmapBuffer(self.dpy, image.buf))?;
            if !derived {
                va!(
                    self.va,
                    vaPutImage(self.dpy, surface, image.image_id, 0, 0, w, h, 0, 0, w, h)
                )?;
            }
            Ok(())
        })();
        let _ = va!(self.va, vaDestroyImage(self.dpy, image.image_id));
        result
    }
}

/// The encoder castd's pipeline opens through [`EncoderKind`], and how it takes pictures.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaapiKind {
    /// BGRA in, converted to NV12 by the driver's video processor, where it has one. Off by default
    /// (`CAST_VAAPI_VPP=1` turns it on): Mesa's d3d12 driver (WSL2) crashes in its video processor, FFmpeg's
    /// `scale_vaapi` included, and no Intel or AMD machine has checked its colours yet. Off, the pipeline converts to
    /// I420 and the encoder interleaves it into NV12.
    pub vpp: bool,
}

impl Default for VaapiKind {
    fn default() -> Self {
        VaapiKind {
            vpp: std::env::var("CAST_VAAPI_VPP").is_ok_and(|v| v == "1"),
        }
    }
}

impl EncoderKind for VaapiKind {
    fn name(&self) -> &'static str {
        "vaapi"
    }

    fn hardware(&self) -> bool {
        true
    }

    fn open(&self, cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
        Ok(Box::new(Vaapi::new(cfg, *self)?))
    }
}

/// What rate control is told, applied before the next picture when it changed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Rate {
    bps: u32,
    buffer_bits: u32,
    min_qp: u32,
}

/// The video processor that turns a BGRA picture into the encoder's NV12 input.
struct Vpp {
    config: VAConfigID,
    ctx: VAContextID,
    rgb: VASurfaceID,
    derive: bool,
}

pub struct Vaapi {
    dev: Arc<Device>,
    stream: h264::Stream,
    config: VAConfigID,
    ctx: VAContextID,
    /// NV12, what is encoded.
    input: VASurfaceID,
    /// The reconstructed pictures: the one being made and the reference, taking turns.
    recon: [VASurfaceID; 2],
    coded: VABufferID,
    vpp: Option<Vpp>,
    derive_nv12: bool,
    /// SPS and PPS go in as a packed header (castd's own); else the driver writes its own.
    packed: bool,
    headers: Vec<u8>,
    fps: u32,
    rate: Rate,
    applied: Option<Rate>,
    /// Pictures since the last IDR; None before the first.
    since_idr: Option<u64>,
    idr_pic_id: u16,
    current: usize,
}

impl Drop for Vaapi {
    fn drop(&mut self) {
        let d = &self.dev;
        let _ = va!(d.va, vaDestroyBuffer(d.dpy, self.coded));
        let _ = va!(d.va, vaDestroyContext(d.dpy, self.ctx));
        let _ = va!(d.va, vaDestroyConfig(d.dpy, self.config));
        if let Some(v) = &mut self.vpp {
            let _ = va!(d.va, vaDestroyContext(d.dpy, v.ctx));
            let _ = va!(d.va, vaDestroyConfig(d.dpy, v.config));
            let _ = va!(d.va, vaDestroySurfaces(d.dpy, &mut v.rgb, 1));
        }
        let mut surfaces = [self.input, self.recon[0], self.recon[1]];
        let _ = va!(d.va, vaDestroySurfaces(d.dpy, surfaces.as_mut_ptr(), 3));
    }
}

fn nv12_format() -> VAImageFormat {
    VAImageFormat {
        fourcc: VA_FOURCC_NV12,
        byte_order: VA_LSB_FIRST,
        bits_per_pixel: 12,
        ..Default::default()
    }
}

fn bgrx_format() -> VAImageFormat {
    VAImageFormat {
        fourcc: VA_FOURCC_BGRX,
        byte_order: VA_LSB_FIRST,
        bits_per_pixel: 32,
        depth: 24,
        red_mask: 0x00ff_0000,
        green_mask: 0x0000_ff00,
        blue_mask: 0x0000_00ff,
        alpha_mask: 0,
        ..Default::default()
    }
}

/// castd's CRF as the lowest QP rate control may go to (NVENC's floor).
fn floor_qp(crf: f32) -> u32 {
    crf.round().clamp(1.0, 51.0) as u32
}

impl Vaapi {
    pub fn new(cfg: &EncoderConfig, kind: VaapiKind) -> Result<Vaapi, String> {
        let dev = device()?;
        if cfg.width < 16 || cfg.height < 16 || cfg.width % 2 == 1 || cfg.height % 2 == 1 {
            return Err(format!("vaapi: a {}x{} picture", cfg.width, cfg.height));
        }
        let rc_modes = dev.attribute(dev.entrypoint, VAConfigAttribRateControl).unwrap_or(0);
        // CBR where the driver's VBR misbehaves (`CAST_VAAPI_RC=cbr`); never stuffing either way.
        let cbr = std::env::var("CAST_VAAPI_RC").is_ok_and(|v| v == "cbr");
        let rc = if rc_modes & VA_RC_VBR != 0 && !cbr {
            VA_RC_VBR
        } else if rc_modes & VA_RC_CBR != 0 {
            VA_RC_CBR
        } else {
            return Err(format!(
                "vaapi: {} offers no bitrate control (rate control modes {rc_modes:#x})",
                dev.vendor
            ));
        };
        let packed = dev
                .attribute(dev.entrypoint, VAConfigAttribEncPackedHeaders)
                .is_some_and(|v| v & VA_ENC_PACKED_HEADER_SEQUENCE != 0);
        let mut attrs = vec![
            VAConfigAttrib {
                type_: VAConfigAttribRTFormat,
                value: VA_RT_FORMAT_YUV420,
            },
            VAConfigAttrib {
                type_: VAConfigAttribRateControl,
                value: rc,
            },
        ];
        if packed {
            attrs.push(VAConfigAttrib {
                type_: VAConfigAttribEncPackedHeaders,
                value: VA_ENC_PACKED_HEADER_SEQUENCE,
            });
        }
        let mut config = VA_INVALID_ID;
        va!(
            dev.va,
            vaCreateConfig(
                dev.dpy,
                dev.profile,
                dev.entrypoint,
                attrs.as_mut_ptr(),
                attrs.len() as i32,
                &mut config
            )
        )?;
        let stream = h264::Stream {
            profile_idc: match dev.profile {
                VAProfileH264High => 100,
                VAProfileH264Main => 77,
                _ => 66,
            },
            level_idc: h264::level_for(cfg.width, cfg.height, cfg.fps),
            width: cfg.width,
            height: cfg.height,
            log2_max_frame_num: LOG2_MAX_FRAME_NUM,
            cabac: dev.profile != VAProfileH264ConstrainedBaseline,
            transform_8x8: dev.profile == VAProfileH264High,
            pic_init_qp: 26,
        };
        // Surfaces are whole macroblocks; the SPS crops what is past the picture.
        let (sw, sh) = (stream.mb_width() * 16, stream.mb_height() * 16);
        let mut made = Vaapi {
            dev: dev.clone(),
            stream,
            config,
            ctx: VA_INVALID_ID,
            input: VA_INVALID_SURFACE,
            recon: [VA_INVALID_SURFACE; 2],
            coded: VA_INVALID_ID,
            vpp: None,
            derive_nv12: true,
            packed,
            headers: Vec::new(),
            fps: cfg.fps.max(1),
            rate: Rate {
                bps: cfg.max_kbps.max(100) * 1000,
                buffer_bits: vbv_buffer_kbit(cfg.max_kbps.max(100), cfg.fps) * 1000,
                min_qp: floor_qp(cfg.crf),
            },
            applied: None,
            since_idr: None,
            idr_pic_id: 0,
            current: 0,
        };
        // From here a failure drops `made`, which destroys what was made so far.
        let ids = dev.surfaces(VA_RT_FORMAT_YUV420, Some(VA_FOURCC_NV12), sw, sh, 3)?;
        (made.input, made.recon) = (ids[0], [ids[1], ids[2]]);
        let mut targets = ids.clone();
        va!(
            dev.va,
            vaCreateContext(
                dev.dpy,
                config,
                sw as i32,
                sh as i32,
                VA_PROGRESSIVE,
                targets.as_mut_ptr(),
                targets.len() as i32,
                &mut made.ctx
            )
        )?;
        // Room for the worst picture: raw 4:2:0 and then some.
        let coded_size = sw * sh * 3 / 2 + (1 << 20);
        va!(
            dev.va,
            vaCreateBuffer(
                dev.dpy,
                made.ctx,
                VAEncCodedBufferType,
                coded_size,
                1,
                std::ptr::null_mut(),
                &mut made.coded
            )
        )?;
        if kind.vpp && dev.vpp {
            match made.open_vpp(cfg.width, cfg.height) {
                Ok(v) => made.vpp = Some(v),
                Err(e) => log::info!("vaapi: no video processor ({e}): I420 is uploaded instead"),
            }
        }
        if packed {
            made.headers = h264::sps(&made.stream);
            made.headers.extend_from_slice(&h264::pps(&made.stream));
        }
        Ok(made)
    }

    fn open_vpp(&self, w: u32, h: u32) -> Result<Vpp, String> {
        let d = &self.dev;
        let mut config = VA_INVALID_ID;
        va!(
            d.va,
            vaCreateConfig(d.dpy, VAProfileNone, VAEntrypointVideoProc, std::ptr::null_mut(), 0, &mut config)
        )?;
        let mut vpp = Vpp {
            config,
            ctx: VA_INVALID_ID,
            rgb: VA_INVALID_SURFACE,
            derive: true,
        };
        let made = (|| {
            vpp.rgb = d.surfaces(VA_RT_FORMAT_RGB32, Some(VA_FOURCC_BGRX), w, h, 1)?[0];
            let mut target = self.input;
            va!(
                d.va,
                vaCreateContext(d.dpy, config, w as i32, h as i32, VA_PROGRESSIVE, &mut target, 1, &mut vpp.ctx)
            )
        })();
        if let Err(e) = made {
            if vpp.ctx != VA_INVALID_ID {
                let _ = va!(d.va, vaDestroyContext(d.dpy, vpp.ctx));
            }
            if vpp.rgb != VA_INVALID_SURFACE {
                let _ = va!(d.va, vaDestroySurfaces(d.dpy, &mut vpp.rgb, 1));
            }
            let _ = va!(d.va, vaDestroyConfig(d.dpy, config));
            return Err(e);
        }
        Ok(vpp)
    }

    /// Puts the picture into the NV12 input surface.
    fn load(&mut self, p: &Picture) -> Result<(), String> {
        let (w, h) = (self.stream.width, self.stream.height);
        match p {
            Picture::I420(planes) => self.load_i420(planes),
            Picture::Bgra { data, stride } => {
                let Some(vpp) = &mut self.vpp else {
                    return Err("vaapi: a BGRA picture without a video processor".into());
                };
                let d = &self.dev;
                let row = w as usize * 4;
                d.upload(vpp.rgb, &bgrx_format(), w, h, &mut vpp.derive, |mem, pitch, offset| {
                    for y in 0..h as usize {
                        let src = &data[y * stride..y * stride + row];
                        // SAFETY: the mapped image holds `h` rows of `pitch[0]` bytes from `offset[0]`.
                        unsafe {
                            std::ptr::copy_nonoverlapping(
                                src.as_ptr(),
                                mem.add(offset[0] as usize + y * pitch[0] as usize),
                                row,
                            )
                        };
                    }
                })?;
                let region = VARectangle {
                    x: 0,
                    y: 0,
                    width: w as u16,
                    height: h as u16,
                };
                let mut params: VAProcPipelineParameterBuffer = zeroed();
                params.surface = vpp.rgb;
                params.surface_region = &region;
                params.output_region = &region;
                params.output_background_color = 0xff00_0000;
                params.surface_color_standard = VAProcColorStandardSRGB;
                params.output_color_standard = VAProcColorStandardBT601;
                params.input_color_properties.color_range = VA_SOURCE_RANGE_FULL;
                params.input_color_properties.matrix_coefficients = MATRIX_RGB;
                params.output_color_properties.color_range = VA_SOURCE_RANGE_REDUCED;
                params.output_color_properties.matrix_coefficients = MATRIX_SMPTE170M;
                params.output_color_properties.colour_primaries = 1;
                params.output_color_properties.transfer_characteristics = 13;
                let mut buf = d.buffer(vpp.ctx, VAProcPipelineParameterBufferType, &params)?;
                let run = (|| {
                    va!(d.va, vaBeginPicture(d.dpy, vpp.ctx, self.input))?;
                    va!(d.va, vaRenderPicture(d.dpy, vpp.ctx, &mut buf, 1))?;
                    va!(d.va, vaEndPicture(d.dpy, vpp.ctx))
                })();
                let _ = va!(d.va, vaDestroyBuffer(d.dpy, buf));
                run
            }
            Picture::Native(_) => Err("vaapi: this encoder takes no native frames".into()),
        }
    }

    fn load_i420(&mut self, p: &Planes) -> Result<(), String> {
        let (w, h) = (self.stream.width as usize, self.stream.height as usize);
        let d = self.dev.clone();
        d.upload(
            self.input,
            &nv12_format(),
            w as u32,
            h as u32,
            &mut self.derive_nv12,
            |mem, pitch, offset| {
                for y in 0..h {
                    // SAFETY: the mapped image's luma plane holds `h` rows of `pitch[0]` bytes from `offset[0]`.
                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            p.y[y * p.stride_y..].as_ptr(),
                            mem.add(offset[0] as usize + y * pitch[0] as usize),
                            w,
                        )
                    };
                }
                for y in 0..h / 2 {
                    let u = &p.u[y * p.stride_uv..y * p.stride_uv + w / 2];
                    let v = &p.v[y * p.stride_uv..y * p.stride_uv + w / 2];
                    // SAFETY: the chroma plane holds `h / 2` rows of `pitch[1]` bytes from `offset[1]`, `w` used.
                    let dst = unsafe {
                        std::slice::from_raw_parts_mut(mem.add(offset[1] as usize + y * pitch[1] as usize), w)
                    };
                    for (i, pair) in dst.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                        *pair = [u[i], v[i]];
                    }
                }
            },
        )
    }

    fn rate_buffers(&self, out: &mut Vec<VABufferID>) -> Result<(), String> {
        let d = &self.dev;
        let r = self.rate;
        let rc = VAEncMiscParameterRateControl {
            bits_per_second: r.bps,
            target_percentage: 100,
            window_size: 1000,
            min_qp: r.min_qp,
            max_qp: 51,
            rc_flags: rc_flags::DISABLE_FRAME_SKIP | rc_flags::DISABLE_BIT_STUFFING,
            ..Default::default()
        };
        out.push(d.misc(self.ctx, VAEncMiscParameterTypeRateControl, &rc)?);
        let hrd = VAEncMiscParameterHRD {
            initial_buffer_fullness: r.buffer_bits,
            buffer_size: r.buffer_bits,
            ..Default::default()
        };
        out.push(d.misc(self.ctx, VAEncMiscParameterTypeHRD, &hrd)?);
        let fr = VAEncMiscParameterFrameRate {
            framerate: self.fps,
            ..Default::default()
        };
        out.push(d.misc(self.ctx, VAEncMiscParameterTypeFrameRate, &fr)?);
        Ok(())
    }

    fn sequence(&self) -> VAEncSequenceParameterBufferH264 {
        let s = &self.stream;
        let mut seq: VAEncSequenceParameterBufferH264 = zeroed();
        seq.level_idc = s.level_idc;
        seq.intra_period = GOP;
        seq.intra_idr_period = GOP;
        seq.ip_period = 1;
        seq.bits_per_second = self.rate.bps;
        seq.max_num_ref_frames = 1;
        seq.picture_width_in_mbs = s.mb_width() as u16;
        seq.picture_height_in_mbs = s.mb_height() as u16;
        seq.seq_fields = seq_fields::chroma_format_idc(1)
            | seq_fields::frame_mbs_only_flag(1)
            | seq_fields::direct_8x8_inference_flag(1)
            | seq_fields::log2_max_frame_num_minus4(LOG2_MAX_FRAME_NUM - 4)
            | seq_fields::pic_order_cnt_type(2);
        if let Some((right, bottom)) = s.crop() {
            seq.frame_cropping_flag = 1;
            seq.frame_crop_right_offset = right;
            seq.frame_crop_bottom_offset = bottom;
        }
        // What the packed SPS says, for a driver that writes its own: the bitstream restriction with the largest
        // vectors and vectors over the edges allowed.
        seq.vui_parameters_present_flag = 1;
        seq.vui_fields = (1 << 2) | (15 << 3) | (15 << 8) | (1 << 15);
        seq.num_units_in_tick = 1;
        seq.time_scale = self.fps * 2;
        seq
    }
}

impl VideoEncoder for Vaapi {
    fn name(&self) -> &'static str {
        "vaapi"
    }

    fn threaded(&self) -> bool {
        false
    }

    fn formats(&self) -> &'static [FrameFormat] {
        if self.vpp.is_some() {
            &[FrameFormat::Bgra, FrameFormat::I420]
        } else {
            &[FrameFormat::I420]
        }
    }

    fn set_rate(&mut self, crf: f32, max_kbps: u32) {
        let max = max_kbps.max(100);
        self.rate = Rate {
            bps: max * 1000,
            buffer_bits: vbv_buffer_kbit(max, self.fps) * 1000,
            min_qp: floor_qp(crf),
        };
    }

    fn set_rate_buf(&mut self, crf: f32, max_kbps: u32, buf_kbit: u32) {
        self.rate = Rate {
            bps: max_kbps.max(100) * 1000,
            buffer_bits: buf_kbit.max(1) * 1000,
            min_qp: floor_qp(crf),
        };
    }

    fn encode(
        &mut self,
        p: &Picture,
        _ts_ms: i64,
        force_idr: bool,
        _qp: Option<i32>,
        _mb_info: Option<&mut [u8]>,
        out: &mut Vec<u8>,
    ) -> Result<Encoded, String> {
        self.load(p)?;
        let idr = force_idr || self.since_idr.is_none();
        let count = if idr { 0 } else { self.since_idr.unwrap_or(0) + 1 };
        let frame_num = (count % (1 << LOG2_MAX_FRAME_NUM)) as u32;
        let poc = (2 * count) as i32;
        let reference = self.recon[1 - self.current];
        let current = self.recon[self.current];
        let d = self.dev.clone();
        let mut buffers = Vec::new();
        let result = (|| {
            if idr {
                buffers.push(d.buffer(self.ctx, VAEncSequenceParameterBufferType, &self.sequence())?);
            }
            if idr || self.applied != Some(self.rate) {
                self.rate_buffers(&mut buffers)?;
            }
            let previous = VAPictureH264 {
                picture_id: reference,
                frame_idx: ((count.wrapping_sub(1)) % (1 << LOG2_MAX_FRAME_NUM)) as u32,
                flags: VA_PICTURE_H264_SHORT_TERM_REFERENCE,
                TopFieldOrderCnt: poc - 2,
                BottomFieldOrderCnt: poc - 2,
                va_reserved: [0; 4],
            };
            let mut pic: VAEncPictureParameterBufferH264 = zeroed();
            pic.CurrPic = VAPictureH264 {
                picture_id: current,
                frame_idx: frame_num,
                flags: 0,
                TopFieldOrderCnt: poc,
                BottomFieldOrderCnt: poc,
                va_reserved: [0; 4],
            };
            pic.ReferenceFrames = [VAPictureH264::INVALID; 16];
            if !idr {
                pic.ReferenceFrames[0] = previous;
            }
            pic.coded_buf = self.coded;
            pic.frame_num = frame_num as u16;
            pic.pic_init_qp = self.stream.pic_init_qp;
            pic.pic_fields = pic_fields::idr_pic_flag(idr as u32)
                | pic_fields::reference_pic_flag(1)
                | pic_fields::entropy_coding_mode_flag(self.stream.cabac as u32)
                | pic_fields::transform_8x8_mode_flag(self.stream.transform_8x8 as u32)
                | pic_fields::deblocking_filter_control_present_flag(1);
            buffers.push(d.buffer(self.ctx, VAEncPictureParameterBufferType, &pic)?);
            if idr && self.packed {
                let param = VAEncPackedHeaderParameterBuffer {
                    type_: VAEncPackedHeaderSequence,
                    bit_length: (self.headers.len() * 8) as u32,
                    has_emulation_bytes: 1,
                    ..Default::default()
                };
                buffers.push(d.buffer(self.ctx, VAEncPackedHeaderParameterBufferType, &param)?);
                buffers.push(d.buffer_bytes(
                    self.ctx,
                    VAEncPackedHeaderDataBufferType,
                    self.headers.as_ptr(),
                    self.headers.len(),
                )?);
            }
            let mut slice: VAEncSliceParameterBufferH264 = zeroed();
            slice.num_macroblocks = self.stream.mb_width() * self.stream.mb_height();
            slice.macroblock_info = VA_INVALID_ID;
            slice.slice_type = if idr { SLICE_TYPE_I } else { SLICE_TYPE_P };
            slice.idr_pic_id = self.idr_pic_id;
            slice.direct_spatial_mv_pred_flag = 1;
            slice.RefPicList0 = [VAPictureH264::INVALID; 32];
            slice.RefPicList1 = [VAPictureH264::INVALID; 32];
            if !idr {
                slice.RefPicList0[0] = previous;
            }
            buffers.push(d.buffer(self.ctx, VAEncSliceParameterBufferType, &slice)?);
            va!(d.va, vaBeginPicture(d.dpy, self.ctx, self.input))?;
            va!(
                d.va,
                vaRenderPicture(d.dpy, self.ctx, buffers.as_mut_ptr(), buffers.len() as i32)
            )?;
            va!(d.va, vaEndPicture(d.dpy, self.ctx))?;
            va!(d.va, vaSyncSurface(d.dpy, self.input))?;
            let mut seg = std::ptr::null_mut();
            va!(d.va, vaMapBuffer(d.dpy, self.coded, &mut seg))?;
            let start = out.len();
            while !seg.is_null() {
                // SAFETY: the mapped coded buffer is a list of segments, each `size` bytes at `buf`.
                let s = unsafe { &*(seg as *const VACodedBufferSegment) };
                if !s.buf.is_null() && s.size > 0 {
                    out.extend_from_slice(unsafe {
                        std::slice::from_raw_parts(s.buf as *const u8, s.size as usize)
                    });
                }
                seg = s.next;
            }
            va!(d.va, vaUnmapBuffer(d.dpy, self.coded))?;
            Ok::<_, String>(start)
        })();
        for b in buffers {
            let _ = va!(d.va, vaDestroyBuffer(d.dpy, b));
        }
        let start = result.map_err(|e| format!("vaapi: {e}"))?;
        if out.len() == start {
            // Mesa's d3d12 driver on an Intel GPU under WSL2 does this for every picture, FFmpeg's included.
            return Err(format!("vaapi: {} encoded nothing", self.dev.vendor));
        }
        if idr {
            if !self.packed {
                // The driver's own SPS and PPS, for `headers`.
                let au = &out[start..];
                let sps_pps: Vec<u8> = crate::mp4::nals(au)
                    .into_iter()
                    .filter(|n| matches!(n[0] & 0x1f, 7 | 8))
                    .flat_map(|n| [&[0u8, 0, 0, 1][..], n].concat())
                    .collect();
                if !sps_pps.is_empty() {
                    self.headers = sps_pps;
                }
            }
            self.idr_pic_id = self.idr_pic_id.wrapping_add(1);
        }
        self.applied = Some(self.rate);
        self.since_idr = Some(count);
        self.current = 1 - self.current;
        Ok(Encoded {
            keyframe: idr,
            qp: None,
            crf_avg: 0.0,
        })
    }

    fn headers(&mut self) -> Vec<u8> {
        self.headers.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where a VA-API driver encodes H.264, the encoder must pass the self-test every hardware encoder passes; elsewhere
    /// this stands down, saying why.
    #[test]
    fn vaapi_passes_the_self_test_where_a_driver_encodes() {
        match device() {
            Ok(d) => {
                crate::encoder::self_test(&VaapiKind::default())
                    .unwrap_or_else(|e| panic!("VA-API on {} ({}): {e}", d.node, d.vendor));
                eprintln!("vaapi passed the self-test on {} ({})", d.node, d.vendor);
            }
            Err(e) => eprintln!("vaapi self-test stands down: {e}"),
        }
    }
}
