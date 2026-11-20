//! NVIDIA's hardware H.264 encoder, through the NVENC API itself rather than FFmpeg's wrapper: FFmpeg resets the
//! encoder and forces an IDR on every bitrate change (`reconfig_encoder` in libavcodec/nvenc.c sets `resetEncoder` and
//! `forceIDR`), and castd's controller moves the bitrate several times a second when a link is short. Here a rate
//! change is `nvEncReconfigureEncoder` with neither, so the stream carries on as P-frames.
//!
//! The driver's libnvidia-encode.so.1 and libcuda.so.1 are opened at runtime (on WSL2 they live in /usr/lib/wsl/lib),
//! so castd links nothing NVIDIA's and runs unchanged where there is no NVIDIA GPU. One CUDA context per process serves
//! every encoder castd opens; pictures go in as I420 through the driver's own pinned input buffers, synchronously: no
//! B-frames, no lookahead, an infinite GOP, the ultra-low-latency tuning, so each picture's access unit comes back from
//! the call that encoded it.
//!
//! Rate control is constant quality with a cap, as x264's CRF with VBV is: VBR with `targetQuality` at castd's CRF and
//! `maxBitRate` at the controller's cap. Paint-over keeps working unchanged: video.rs asks for its sharper CRF with
//! `set_rate` before a refine pass, and that is a reconfigure to a lower `targetQuality` for those frames.

// The header's own names (NV_ENC_CONFIG, rcParams), kept as NVIDIA spells them.
#![allow(non_camel_case_types, non_upper_case_globals, non_snake_case)]
// allow(bindgen-output): bindgen's code for the whole header: castd uses a fraction of it, and its re-exports, bitfield
// transmutes and lint findings are bindgen's style, not castd's.
#[allow(unused_imports, unnecessary_transmutes, dead_code, clippy::all)]
mod ffi {
    include!(concat!(env!("OUT_DIR"), "/nvenc.rs"));
}

use crate::encoder::{Encoded, EncoderConfig, Planes, VideoEncoder, vbv_buffer_kbit};
use ffi::*;
use std::ffi::c_void;
use std::sync::OnceLock;

type CuResult = i32;

/// What castd needs of libcuda: a context for NVENC to open its session on.
struct Cuda {
    _lib: libloading::Library,
    ctx: usize,
    device_name: String,
}

/// The driver's NVENC entry points and the process's CUDA context, loaded once.
struct Api {
    _lib: libloading::Library,
    fns: NV_ENCODE_API_FUNCTION_LIST,
    cuda: Cuda,
}

// The function table is plain function pointers, and the context a handle the driver makes safe across threads.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

/// Where WSL2 keeps the Windows driver's Linux libraries; a container's linker path may not name it.
const WSL_LIBS: &str = "/usr/lib/wsl/lib";

/// On WSL2 the driver's libraries sit in WSL_LIBS, which a container's linker path may not name, and opening them by
/// full path is not enough: libnvcuvid (which libnvidia-encode needs) needs libdxcore.so, which has no soname, so
/// the linker cannot match it to a copy already loaded by path. Only the search path itself helps, and glibc reads
/// LD_LIBRARY_PATH once, at start: so castd starts itself again with WSL_LIBS on it, once, before any thread exists.
/// The variable reaches nothing else: castd starts no programs.
pub fn reexec_with_wsl_libs() {
    use std::os::unix::process::CommandExt;
    if !std::path::Path::new(&format!("{WSL_LIBS}/libnvidia-encode.so.1")).exists()
        || std::env::var_os("CASTD_WSL_REEXEC").is_some()
    {
        return;
    }
    let current = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
    if current.split(':').any(|d| d == WSL_LIBS) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let path = if current.is_empty() {
        WSL_LIBS.to_string()
    } else {
        format!("{current}:{WSL_LIBS}")
    };
    let err = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .env("LD_LIBRARY_PATH", path)
        .env("CASTD_WSL_REEXEC", "1")
        .exec();
    log::warn!("could not restart with {WSL_LIBS} on the library path: {err}");
}

fn open_lib(name: &str) -> Result<libloading::Library, String> {
    unsafe { libloading::Library::new(name) }.map_err(|e| {
        let wsl = std::path::Path::new(&format!("{WSL_LIBS}/{name}")).exists();
        if wsl {
            format!("{name} not found ({e}): it is in {WSL_LIBS}, which LD_LIBRARY_PATH must name")
        } else {
            format!("{name} not found ({e})")
        }
    })
}

fn load_cuda() -> Result<Cuda, String> {
    let lib = open_lib("libcuda.so.1")?;
    unsafe {
        let init: libloading::Symbol<unsafe extern "C" fn(u32) -> CuResult> =
            lib.get(b"cuInit\0").map_err(|e| e.to_string())?;
        let device_get: libloading::Symbol<unsafe extern "C" fn(*mut i32, i32) -> CuResult> =
            lib.get(b"cuDeviceGet\0").map_err(|e| e.to_string())?;
        let device_name: libloading::Symbol<unsafe extern "C" fn(*mut i8, i32, i32) -> CuResult> =
            lib.get(b"cuDeviceGetName\0").map_err(|e| e.to_string())?;
        let ctx_create: libloading::Symbol<
            unsafe extern "C" fn(*mut *mut c_void, u32, i32) -> CuResult,
        > = lib.get(b"cuCtxCreate_v2\0").map_err(|e| e.to_string())?;
        let r = init(0);
        if r != 0 {
            return Err(format!("cuInit failed ({r}): no usable NVIDIA GPU"));
        }
        let ordinal = std::env::var("CASTD_CUDA_DEVICE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let mut dev = 0;
        let r = device_get(&mut dev, ordinal);
        if r != 0 {
            return Err(format!("cuDeviceGet({ordinal}) failed ({r})"));
        }
        let mut name = [0i8; 128];
        device_name(name.as_mut_ptr(), name.len() as i32, dev);
        let device_name = std::ffi::CStr::from_ptr(name.as_ptr())
            .to_string_lossy()
            .to_string();
        let mut ctx = std::ptr::null_mut();
        let r = ctx_create(&mut ctx, 0, dev);
        if r != 0 || ctx.is_null() {
            return Err(format!("cuCtxCreate failed ({r})"));
        }
        // cuCtxCreate makes the context current on this thread; NVENC is given it explicitly, so pop it to leave this
        // thread as it was.
        if let Ok(pop) =
            lib.get::<unsafe extern "C" fn(*mut *mut c_void) -> CuResult>(b"cuCtxPopCurrent_v2\0")
        {
            let mut popped = std::ptr::null_mut();
            pop(&mut popped);
        }
        Ok(Cuda {
            _lib: lib,
            ctx: ctx as usize,
            device_name,
        })
    }
}

fn load() -> Result<Api, String> {
    let lib = open_lib("libnvidia-encode.so.1")?;
    unsafe {
        let max_version: libloading::Symbol<unsafe extern "C" fn(*mut u32) -> NVENCSTATUS> = lib
            .get(b"NvEncodeAPIGetMaxSupportedVersion\0")
            .map_err(|e| e.to_string())?;
        let mut v = 0u32;
        check(max_version(&mut v), "NvEncodeAPIGetMaxSupportedVersion")?;
        let ours = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;
        if v < ours {
            return Err(format!(
                "the driver's NVENC is API {}.{}, castd needs {}.{}: update the NVIDIA driver",
                v >> 4,
                v & 0xf,
                NVENCAPI_MAJOR_VERSION,
                NVENCAPI_MINOR_VERSION
            ));
        }
        let create: libloading::Symbol<
            unsafe extern "C" fn(*mut NV_ENCODE_API_FUNCTION_LIST) -> NVENCSTATUS,
        > = lib
            .get(b"NvEncodeAPICreateInstance\0")
            .map_err(|e| e.to_string())?;
        let mut fns = NV_ENCODE_API_FUNCTION_LIST {
            version: NV_ENCODE_API_FUNCTION_LIST_VER,
            ..Default::default()
        };
        check(create(&mut fns), "NvEncodeAPICreateInstance")?;
        let cuda = load_cuda()?;
        Ok(Api {
            _lib: lib,
            fns,
            cuda,
        })
    }
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(load).as_ref().map_err(Clone::clone)
}

fn status_name(s: NVENCSTATUS) -> &'static str {
    match s {
        NV_ENC_ERR_NO_ENCODE_DEVICE => "no encode device",
        NV_ENC_ERR_UNSUPPORTED_DEVICE => "unsupported device",
        NV_ENC_ERR_INVALID_ENCODERDEVICE => "invalid encoder device",
        NV_ENC_ERR_INVALID_DEVICE => "invalid device",
        NV_ENC_ERR_DEVICE_NOT_EXIST => "device does not exist",
        NV_ENC_ERR_INVALID_PTR => "invalid pointer",
        NV_ENC_ERR_INVALID_PARAM => "invalid parameter",
        NV_ENC_ERR_INVALID_CALL => "invalid call",
        NV_ENC_ERR_OUT_OF_MEMORY => "out of memory",
        NV_ENC_ERR_ENCODER_NOT_INITIALIZED => "encoder not initialised",
        NV_ENC_ERR_UNSUPPORTED_PARAM => "unsupported parameter",
        NV_ENC_ERR_INVALID_VERSION => "invalid struct version",
        NV_ENC_ERR_ENCODER_BUSY => "encoder busy (no free session: a GeForce allows a few at once)",
        NV_ENC_ERR_NEED_MORE_INPUT => "needs more input",
        NV_ENC_ERR_GENERIC => "generic error",
        _ => "error",
    }
}

fn check(s: NVENCSTATUS, what: &str) -> Result<(), String> {
    if s == NV_ENC_SUCCESS {
        Ok(())
    } else {
        Err(format!("{what}: {} ({s})", status_name(s)))
    }
}

/// Calls one of the function table's entries, which the driver always fills.
macro_rules! call {
    ($api:expr, $f:ident ( $($arg:expr),* )) => {
        match $api.fns.$f {
            Some(f) => check(unsafe { f($($arg),*) }, stringify!($f)),
            None => Err(format!("the driver's NVENC has no {}", stringify!($f))),
        }
    };
}

/// NVENC's preset, P1 (fastest) to P7 (most thorough): `CASTD_NVENC_PRESET=4` to try another. Every preset runs on
/// the GPU's encoder engine, so a slower one costs latency and engine time, not CPU.
fn preset_guid() -> GUID {
    match std::env::var("CASTD_NVENC_PRESET")
        .ok()
        .as_deref()
        .map(|p| p.trim_start_matches(['p', 'P']))
    {
        Some("2") => NV_ENC_PRESET_P2_GUID,
        Some("3") => NV_ENC_PRESET_P3_GUID,
        Some("4") => NV_ENC_PRESET_P4_GUID,
        Some("5") => NV_ENC_PRESET_P5_GUID,
        Some("6") => NV_ENC_PRESET_P6_GUID,
        Some("7") => NV_ENC_PRESET_P7_GUID,
        _ => NV_ENC_PRESET_P1_GUID,
    }
}

/// How castd's "CRF under a cap" becomes NVENC rate control (`CASTD_NVENC_RC` to compare them).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RcMode {
    /// Constant quality as FFmpeg sets it: VBR, `targetQuality`, no average and no VBV, only the cap.
    Cq,
    /// A quality floor: VBR aiming at the cap with QP held at or above castd's CRF, inside castd's 1.25-frame VBV. Easy
    /// content stops at the floor's quality instead of spending the cap; hard content is held to the cap.
    Floor,
    /// Constant quality inside castd's VBV.
    CqVbv,
}

fn rc_mode() -> RcMode {
    match std::env::var("CASTD_NVENC_RC").ok().as_deref() {
        Some("cq") => RcMode::Cq,
        Some("cqvbv") => RcMode::CqVbv,
        _ => RcMode::Floor,
    }
}

/// Writes castd's quality and cap into `rc` the way `rc_mode` says.
fn apply_rc(rc: &mut NV_ENC_RC_PARAMS, quality: u8, max_bps: u32, vbv_bits: u32) {
    rc.rateControlMode = NV_ENC_PARAMS_RC_VBR;
    rc.maxBitRate = max_bps;
    match rc_mode() {
        RcMode::Cq => {
            rc.averageBitRate = 0;
            rc.vbvBufferSize = 0;
            rc.vbvInitialDelay = 0;
            rc.targetQuality = quality;
            rc.set_enableMinQP(0);
        }
        RcMode::CqVbv => {
            rc.averageBitRate = 0;
            rc.vbvBufferSize = vbv_bits;
            rc.vbvInitialDelay = vbv_bits;
            rc.targetQuality = quality;
            rc.set_enableMinQP(0);
        }
        RcMode::Floor => {
            rc.averageBitRate = max_bps;
            rc.vbvBufferSize = vbv_bits;
            rc.vbvInitialDelay = vbv_bits;
            rc.targetQuality = 0;
            rc.set_enableMinQP(1);
            let q = u32::from(quality);
            rc.minQP = NV_ENC_QP {
                qpInterP: q,
                qpInterB: q,
                qpIntra: q.saturating_sub(2).max(1),
            };
        }
    }
}

/// The CQ level NVENC targets for castd's CRF: the same 0-51 quantiser scale, so the number carries over.
fn target_quality(crf: f32) -> u8 {
    crf.round().clamp(1.0, 51.0) as u8
}

pub struct Nvenc {
    api: &'static Api,
    enc: *mut c_void,
    input: NV_ENC_INPUT_PTR,
    output: NV_ENC_OUTPUT_PTR,
    config: Box<NV_ENC_CONFIG>,
    init: Box<NV_ENC_INITIALIZE_PARAMS>,
    width: u32,
    height: u32,
    fps: u32,
    frame: u32,
    applied: (u8, u32, u32),
}

// The session is used by one thread at a time: the stripe worker that owns it.
unsafe impl Send for Nvenc {}

impl Nvenc {
    /// The GPU NVENC runs on, for the log (after a successful open).
    pub fn device_name() -> Option<String> {
        api().ok().map(|a| a.cuda.device_name.clone())
    }

    pub fn new(cfg: &EncoderConfig) -> Result<Self, String> {
        let api = api()?;
        let mut session = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
            version: NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
            deviceType: NV_ENC_DEVICE_TYPE_CUDA,
            device: api.cuda.ctx as *mut c_void,
            apiVersion: NVENCAPI_VERSION,
            ..Default::default()
        };
        let mut enc: *mut c_void = std::ptr::null_mut();
        call!(api, nvEncOpenEncodeSessionEx(&mut session, &mut enc))?;
        // From here on a failure must close the session: build the struct first, so Drop does.
        let mut me = Nvenc {
            api,
            enc,
            input: std::ptr::null_mut(),
            output: std::ptr::null_mut(),
            config: Box::default(),
            init: Box::default(),
            width: cfg.width,
            height: cfg.height,
            fps: cfg.fps.max(1),
            frame: 0,
            applied: (0, 0, 0),
        };
        me.initialize(cfg)?;
        Ok(me)
    }

    fn initialize(&mut self, cfg: &EncoderConfig) -> Result<(), String> {
        let api = self.api;
        let mut preset = NV_ENC_PRESET_CONFIG {
            version: NV_ENC_PRESET_CONFIG_VER,
            presetCfg: NV_ENC_CONFIG {
                version: NV_ENC_CONFIG_VER,
                ..Default::default()
            },
            ..Default::default()
        };
        // P1, the fastest preset unless CASTD_NVENC_PRESET says, tuned for ultra-low latency.
        call!(
            api,
            nvEncGetEncodePresetConfigEx(
                self.enc,
                NV_ENC_CODEC_H264_GUID,
                preset_guid(),
                NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
                &mut preset
            )
        )?;
        let mut c = preset.presetCfg;
        c.version = NV_ENC_CONFIG_VER;
        c.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
        c.gopLength = NVENC_INFINITE_GOPLENGTH;
        c.frameIntervalP = 1;
        let rc = &mut c.rcParams;
        apply_rc(
            rc,
            target_quality(cfg.crf),
            cfg.max_kbps.max(100) * 1000,
            vbv_buffer_kbit(cfg.max_kbps.max(100), self.fps) * 1000,
        );
        rc.set_enableLookahead(0);
        rc.set_zeroReorderDelay(1);
        let h264 = unsafe { &mut c.encodeCodecConfig.h264Config };
        h264.idrPeriod = NVENC_INFINITE_GOPLENGTH;
        h264.set_repeatSPSPPS(1);
        h264.set_outputAUD(0);
        h264.set_enableIntraRefresh(0);
        h264.chromaFormatIDC = 1;
        h264.sliceMode = 0;
        h264.sliceModeData = 0;
        // What x264's VUI says too (x264.rs): sRGB content in BT.601 limited range, as libyuv converts it.
        let vui = &mut h264.h264VUIParameters;
        vui.videoSignalTypePresentFlag = 1;
        vui.videoFormat = NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;
        vui.videoFullRangeFlag = 0;
        vui.colourDescriptionPresentFlag = 1;
        vui.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT709;
        vui.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_SRGB;
        vui.colourMatrix = NV_ENC_VUI_MATRIX_COEFFS_SMPTE170M;
        *self.config = c;
        *self.init = NV_ENC_INITIALIZE_PARAMS {
            version: NV_ENC_INITIALIZE_PARAMS_VER,
            encodeGUID: NV_ENC_CODEC_H264_GUID,
            presetGUID: preset_guid(),
            encodeWidth: self.width,
            encodeHeight: self.height,
            darWidth: self.width,
            darHeight: self.height,
            frameRateNum: self.fps,
            frameRateDen: 1,
            enableEncodeAsync: 0,
            enablePTD: 1,
            encodeConfig: &mut *self.config,
            maxEncodeWidth: self.width,
            maxEncodeHeight: self.height,
            tuningInfo: NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
            ..Default::default()
        };
        call!(api, nvEncInitializeEncoder(self.enc, &mut *self.init))?;
        self.applied = (
            target_quality(cfg.crf),
            self.config.rcParams.maxBitRate,
            self.config.rcParams.vbvBufferSize,
        );
        let mut input = NV_ENC_CREATE_INPUT_BUFFER {
            version: NV_ENC_CREATE_INPUT_BUFFER_VER,
            width: self.width,
            height: self.height,
            bufferFmt: NV_ENC_BUFFER_FORMAT_IYUV,
            ..Default::default()
        };
        call!(api, nvEncCreateInputBuffer(self.enc, &mut input))?;
        self.input = input.inputBuffer;
        let mut output = NV_ENC_CREATE_BITSTREAM_BUFFER {
            version: NV_ENC_CREATE_BITSTREAM_BUFFER_VER,
            ..Default::default()
        };
        call!(api, nvEncCreateBitstreamBuffer(self.enc, &mut output))?;
        self.output = output.bitstreamBuffer;
        Ok(())
    }

    /// Moves rate control to `quality`, `max_bps` and `vbv_bits` without resetting the encoder: the next picture is a P
    /// frame like any other.
    fn reconfigure(&mut self, quality: u8, max_bps: u32, vbv_bits: u32) {
        if self.applied == (quality, max_bps, vbv_bits) {
            return;
        }
        apply_rc(&mut self.config.rcParams, quality, max_bps, vbv_bits);
        let mut params = NV_ENC_RECONFIGURE_PARAMS {
            version: NV_ENC_RECONFIGURE_PARAMS_VER,
            reInitEncodeParams: *self.init,
            ..Default::default()
        };
        params.reInitEncodeParams.encodeConfig = &mut *self.config;
        params.set_resetEncoder(0);
        params.set_forceIDR(0);
        match call!(self.api, nvEncReconfigureEncoder(self.enc, &mut params)) {
            Ok(()) => self.applied = (quality, max_bps, vbv_bits),
            Err(e) => {
                log::warn!("nvenc: rate change to CQ {quality}, {max_bps} bit/s refused: {e}")
            }
        }
    }

    /// Copies an I420 picture into the driver's input buffer, at its pitch.
    fn upload(&mut self, p: &Planes) -> Result<(), String> {
        let mut lock = NV_ENC_LOCK_INPUT_BUFFER {
            version: NV_ENC_LOCK_INPUT_BUFFER_VER,
            inputBuffer: self.input,
            ..Default::default()
        };
        call!(self.api, nvEncLockInputBuffer(self.enc, &mut lock))?;
        let (w, h) = (self.width as usize, self.height as usize);
        let pitch = lock.pitch as usize;
        let base = lock.bufferDataPtr as *mut u8;
        let (cw, ch, cpitch) = (w.div_ceil(2), h.div_ceil(2), pitch.div_ceil(2));
        let fits = p.y.len() >= p.stride_y * (h - 1) + w
            && p.u.len() >= p.stride_uv * (ch - 1) + cw
            && p.v.len() >= p.stride_uv * (ch - 1) + cw;
        if fits && !base.is_null() {
            // The driver's buffer holds `pitch` bytes per luma row and half that per chroma row, planes in order.
            unsafe {
                for r in 0..h {
                    std::ptr::copy_nonoverlapping(
                        p.y.as_ptr().add(r * p.stride_y),
                        base.add(r * pitch),
                        w,
                    );
                }
                let u0 = base.add(pitch * h);
                let v0 = u0.add(cpitch * ch);
                for r in 0..ch {
                    std::ptr::copy_nonoverlapping(
                        p.u.as_ptr().add(r * p.stride_uv),
                        u0.add(r * cpitch),
                        cw,
                    );
                    std::ptr::copy_nonoverlapping(
                        p.v.as_ptr().add(r * p.stride_uv),
                        v0.add(r * cpitch),
                        cw,
                    );
                }
            }
        }
        let unlocked = call!(self.api, nvEncUnlockInputBuffer(self.enc, self.input));
        if !fits {
            return Err("nvenc: the picture is smaller than the encoder".into());
        }
        unlocked
    }
}

impl VideoEncoder for Nvenc {
    fn name(&self) -> &'static str {
        "nvenc"
    }

    fn threaded(&self) -> bool {
        false
    }

    fn set_rate(&mut self, crf: f32, max_kbps: u32) {
        let max = max_kbps.max(100);
        self.reconfigure(
            target_quality(crf),
            max * 1000,
            vbv_buffer_kbit(max, self.fps) * 1000,
        );
    }

    fn set_rate_buf(&mut self, crf: f32, max_kbps: u32, buf_kbit: u32) {
        self.reconfigure(
            target_quality(crf),
            max_kbps.max(100) * 1000,
            buf_kbit.max(1) * 1000,
        );
    }

    fn encode(
        &mut self,
        p: &Planes,
        ts_ms: i64,
        force_idr: bool,
        _qp: Option<i32>,
        _mb_info: Option<&mut [u8]>,
        out: &mut Vec<u8>,
    ) -> Result<Encoded, String> {
        self.upload(p)?;
        let mut pic = NV_ENC_PIC_PARAMS {
            version: NV_ENC_PIC_PARAMS_VER,
            inputWidth: self.width,
            inputHeight: self.height,
            inputPitch: 0,
            encodePicFlags: if force_idr {
                NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS
            } else {
                0
            },
            frameIdx: self.frame,
            inputTimeStamp: ts_ms.max(0) as u64,
            inputBuffer: self.input,
            outputBitstream: self.output,
            bufferFmt: NV_ENC_BUFFER_FORMAT_IYUV,
            pictureStruct: NV_ENC_PIC_STRUCT_FRAME,
            ..Default::default()
        };
        self.frame = self.frame.wrapping_add(1);
        call!(self.api, nvEncEncodePicture(self.enc, &mut pic))?;
        let mut lock = NV_ENC_LOCK_BITSTREAM {
            version: NV_ENC_LOCK_BITSTREAM_VER,
            outputBitstream: self.output,
            ..Default::default()
        };
        call!(self.api, nvEncLockBitstream(self.enc, &mut lock))?;
        if !lock.bitstreamBufferPtr.is_null() {
            let bytes = unsafe {
                std::slice::from_raw_parts(
                    lock.bitstreamBufferPtr as *const u8,
                    lock.bitstreamSizeInBytes as usize,
                )
            };
            out.extend_from_slice(bytes);
        }
        let keyframe = lock.pictureType == NV_ENC_PIC_TYPE_IDR;
        let qp = lock.frameAvgQP as f32;
        call!(self.api, nvEncUnlockBitstream(self.enc, self.output))?;
        Ok(Encoded {
            keyframe,
            // NVENC's rate control is its own: video.rs's MotionQuality (a model of x264's) stays out of it.
            qp: None,
            crf_avg: qp,
        })
    }

    fn headers(&mut self) -> Vec<u8> {
        let mut buf = vec![0u8; 1024];
        let mut size = 0u32;
        let mut payload = NV_ENC_SEQUENCE_PARAM_PAYLOAD {
            version: NV_ENC_SEQUENCE_PARAM_PAYLOAD_VER,
            inBufferSize: buf.len() as u32,
            spsppsBuffer: buf.as_mut_ptr() as *mut c_void,
            outSPSPPSPayloadSize: &mut size,
            ..Default::default()
        };
        if call!(self.api, nvEncGetSequenceParams(self.enc, &mut payload)).is_err() {
            return Vec::new();
        }
        buf.truncate(size as usize);
        buf
    }
}

impl Drop for Nvenc {
    fn drop(&mut self) {
        if !self.input.is_null() {
            let _ = call!(self.api, nvEncDestroyInputBuffer(self.enc, self.input));
        }
        if !self.output.is_null() {
            let _ = call!(self.api, nvEncDestroyBitstreamBuffer(self.enc, self.output));
        }
        let _ = call!(self.api, nvEncDestroyEncoder(self.enc));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn struct_versions_are_the_headers_own() {
        // NVENCAPI_STRUCT_VERSION(ver) = API version | ver << 16 | 0x7 << 28, some with bit 31: the driver rejects a
        // struct whose version word is off by a bit, so check the computation against two by hand.
        let api = NVENCAPI_MAJOR_VERSION | (NVENCAPI_MINOR_VERSION << 24);
        assert_eq!(
            NV_ENC_CREATE_INPUT_BUFFER_VER,
            api | (1 << 16) | (0x7 << 28)
        );
        assert_eq!(NV_ENC_CONFIG_VER & (1 << 31), 1 << 31);
        assert_eq!(NV_ENC_CODEC_H264_GUID.Data1, 0x6bc8_2762);
    }

    #[test]
    fn crf_maps_onto_nvencs_quality_scale() {
        assert_eq!(target_quality(24.0), 24);
        assert_eq!(target_quality(16.4), 16);
        assert_eq!(target_quality(0.0), 1);
        assert_eq!(target_quality(80.0), 51);
    }

    #[test]
    fn a_machine_without_the_driver_is_told_so() {
        // Here, or wherever libnvidia-encode is missing, opening fails with words and does not panic.
        if open_lib("libnvidia-encode.so.1").is_err() {
            let e = Nvenc::new(&EncoderConfig {
                width: 320,
                height: 240,
                fps: 60,
                preset: String::new(),
                threads: 1,
                crf: 24.0,
                max_kbps: 4000,
            })
            .err()
            .unwrap();
            assert!(e.contains("libnvidia-encode.so.1"), "{e}");
        }
    }
}
