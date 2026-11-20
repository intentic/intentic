//! NVIDIA's hardware H.264 encoder on D3D11, reading the textures the capture filled on the same GPU in place: the
//! picture never reaches the CPU. The driver's `nvEncodeAPI64.dll` is opened at runtime, so a computer without an
//! NVIDIA GPU runs the same binary and is told why NVENC is not offered.
//!
//! What castd's Linux NVENC does (cast-core's nvenc.rs) holds here: the NVENC API driven directly, a rate change is
//! `nvEncReconfigureEncoder` with neither a reset nor an IDR, no B-frames, no lookahead, an infinite GOP with an IDR on
//! demand, the ultra-low-latency tuning, and castd's quality floor under the controller's cap (paint-over lowers the
//! floor for its sharpening frames). The input is the desktop's own BGRA (`NV_ENC_BUFFER_FORMAT_ARGB`): the encoder
//! converts it to 4:2:0 on the GPU.
//!
//! The bindings (`generated/nvenc_sys.rs`) were made with castd's own bindgen setup (cast-core's build.rs,
//! `nvenc_bindings`), run on ffnvcodec's nvEncodeAPI.h with comments off; make them again the same way to move to a
//! newer API.

#![allow(non_camel_case_types, non_upper_case_globals, non_snake_case)]
// allow(bindgen-output): bindgen's code for the whole header, of which this module uses a fraction.
#[allow(unused_imports, unnecessary_transmutes, dead_code, clippy::all)]
mod ffi {
    include!("generated/nvenc_sys.rs");
}

use crate::d3d::{Device, GpuFrame};
use cast_core::encoder::{Encoded, EncoderConfig, EncoderKind, VideoEncoder, vbv_buffer_kbit};
use cast_core::frame::{FrameFormat, Picture};
use ffi::*;
use std::ffi::c_void;
use std::sync::OnceLock;
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
};
use windows::core::{Interface, s, w};

/// The driver's NVENC entry points, loaded once.
struct Api {
    fns: NV_ENCODE_API_FUNCTION_LIST,
}

// The function table is plain function pointers into the driver.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn load() -> Result<Api, String> {
    // SAFETY: a system DLL by name from System32 only, and two exports with the signatures NVIDIA documents.
    unsafe {
        let lib = LoadLibraryExW(w!("nvEncodeAPI64.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32)
            .map_err(|e| format!("nvEncodeAPI64.dll not found ({e}): no NVIDIA driver"))?;
        let max = GetProcAddress(lib, s!("NvEncodeAPIGetMaxSupportedVersion"))
            .ok_or("nvEncodeAPI64.dll has no NvEncodeAPIGetMaxSupportedVersion")?;
        let max: unsafe extern "C" fn(*mut u32) -> NVENCSTATUS = std::mem::transmute(max);
        let mut v = 0u32;
        check(max(&mut v), "NvEncodeAPIGetMaxSupportedVersion")?;
        let ours = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;
        if v < ours {
            return Err(format!(
                "the driver's NVENC is API {}.{}, cast-win needs {}.{}: update the NVIDIA driver",
                v >> 4,
                v & 0xf,
                NVENCAPI_MAJOR_VERSION,
                NVENCAPI_MINOR_VERSION
            ));
        }
        let create = GetProcAddress(lib, s!("NvEncodeAPICreateInstance"))
            .ok_or("nvEncodeAPI64.dll has no NvEncodeAPICreateInstance")?;
        let create: unsafe extern "C" fn(*mut NV_ENCODE_API_FUNCTION_LIST) -> NVENCSTATUS =
            std::mem::transmute(create);
        let mut fns = NV_ENCODE_API_FUNCTION_LIST {
            version: NV_ENCODE_API_FUNCTION_LIST_VER,
            ..Default::default()
        };
        check(create(&mut fns), "NvEncodeAPICreateInstance")?;
        // The library stays loaded for the process's life: the table points into it.
        Ok(Api { fns })
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
        NV_ENC_ERR_RESOURCE_REGISTER_FAILED => "the texture could not be registered",
        NV_ENC_ERR_MAP_FAILED => "the texture could not be mapped",
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

/// NVENC's preset, P1 (fastest) to P7: `CASTD_NVENC_PRESET=4` to try another, as castd's Linux NVENC reads it. Every
/// preset runs on the GPU's encoder engine, so a slower one costs latency and engine time, not CPU.
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

/// castd's quality floor under a cap: VBR aiming at the cap with QP held at or above the CRF, inside the VBV the
/// controller sets. Easy content stops at the floor's quality instead of spending the cap.
fn apply_rc(rc: &mut NV_ENC_RC_PARAMS, quality: u8, max_bps: u32, vbv_bits: u32) {
    rc.rateControlMode = NV_ENC_PARAMS_RC_VBR;
    rc.maxBitRate = max_bps;
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

/// The QP floor for castd's CRF: the same 0-51 quantiser scale, so the number carries over.
fn target_quality(crf: f32) -> u8 {
    crf.round().clamp(1.0, 51.0) as u8
}

/// NVENC on one D3D11 device: what the pipeline opens, again at each new size.
pub struct NvencKind {
    pub device: Device,
}

impl EncoderKind for NvencKind {
    fn name(&self) -> &'static str {
        "nvenc"
    }

    fn hardware(&self) -> bool {
        true
    }

    fn open(&self, cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
        Ok(Box::new(Nvenc::new(&self.device, cfg)?))
    }
}

/// Whether this computer's driver offers NVENC at all, with the reason when it does not.
pub fn available() -> Result<(), String> {
    api().map(|_| ())
}

struct Registered {
    texture: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
    ptr: NV_ENC_REGISTERED_PTR,
}

pub struct Nvenc {
    api: &'static Api,
    enc: *mut c_void,
    device: Device,
    output: NV_ENC_OUTPUT_PTR,
    config: Box<NV_ENC_CONFIG>,
    init: Box<NV_ENC_INITIALIZE_PARAMS>,
    width: u32,
    height: u32,
    fps: u32,
    frame: u32,
    applied: (u8, u32, u32),
    registered: Vec<Registered>,
}

// The session is used by one thread at a time: the encode thread that owns it.
unsafe impl Send for Nvenc {}

impl Nvenc {
    pub fn new(device: &Device, cfg: &EncoderConfig) -> Result<Nvenc, String> {
        let api = api()?;
        let mut session = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
            version: NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
            deviceType: NV_ENC_DEVICE_TYPE_DIRECTX,
            device: device.device.as_raw(),
            apiVersion: NVENCAPI_VERSION,
            ..Default::default()
        };
        let mut enc: *mut c_void = std::ptr::null_mut();
        call!(api, nvEncOpenEncodeSessionEx(&mut session, &mut enc))?;
        // From here on a failure must close the session: build the struct first, so Drop does.
        let mut me = Nvenc {
            api,
            enc,
            device: device.clone(),
            output: std::ptr::null_mut(),
            config: Box::default(),
            init: Box::default(),
            width: cfg.width,
            height: cfg.height,
            fps: cfg.fps.max(1),
            frame: 0,
            applied: (0, 0, 0),
            registered: Vec::new(),
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
        // SAFETY: the H.264 member of the codec union, the codec this session encodes.
        let h264 = unsafe { &mut c.encodeCodecConfig.h264Config };
        h264.idrPeriod = NVENC_INFINITE_GOPLENGTH;
        h264.set_repeatSPSPPS(1);
        h264.set_outputAUD(0);
        h264.set_enableIntraRefresh(0);
        h264.chromaFormatIDC = 1;
        h264.sliceMode = 0;
        h264.sliceModeData = 0;
        // What castd's encoders say: sRGB content in BT.601 limited range, as NVENC converts the desktop's RGB.
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
        let mut output = NV_ENC_CREATE_BITSTREAM_BUFFER {
            version: NV_ENC_CREATE_BITSTREAM_BUFFER_VER,
            ..Default::default()
        };
        call!(api, nvEncCreateBitstreamBuffer(self.enc, &mut output))?;
        self.output = output.bitstreamBuffer;
        Ok(())
    }

    /// Moves rate control without resetting the encoder: the next picture is a P frame like any other.
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
                log::warn!("nvenc: rate change to QP {quality}+, {max_bps} bit/s refused: {e}")
            }
        }
    }

    /// The registration of `frame`'s texture, made on first use: the pipeline's two frames take turns, so two.
    fn registered(&mut self, frame: &GpuFrame) -> Result<NV_ENC_REGISTERED_PTR, String> {
        let raw = frame.texture.as_raw();
        if let Some(r) = self.registered.iter().find(|r| r.texture.as_raw() == raw) {
            return Ok(r.ptr);
        }
        let mut reg = NV_ENC_REGISTER_RESOURCE {
            version: NV_ENC_REGISTER_RESOURCE_VER,
            resourceType: NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX,
            width: frame.width,
            height: frame.height,
            pitch: 0,
            subResourceIndex: 0,
            resourceToRegister: raw,
            bufferFormat: NV_ENC_BUFFER_FORMAT_ARGB,
            bufferUsage: NV_ENC_INPUT_IMAGE,
            ..Default::default()
        };
        call!(self.api, nvEncRegisterResource(self.enc, &mut reg))?;
        self.registered.push(Registered {
            texture: frame.texture.clone(),
            ptr: reg.registeredResource,
        });
        Ok(reg.registeredResource)
    }
}

impl VideoEncoder for Nvenc {
    fn name(&self) -> &'static str {
        "nvenc"
    }

    fn threaded(&self) -> bool {
        false
    }

    fn formats(&self) -> &'static [FrameFormat] {
        &[FrameFormat::Native]
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
        p: &Picture,
        ts_ms: i64,
        force_idr: bool,
        _qp: Option<i32>,
        _mb_info: Option<&mut [u8]>,
        out: &mut Vec<u8>,
    ) -> Result<Encoded, String> {
        let Picture::Native(native) = p else {
            return Err("nvenc reads textures on its GPU, not frames in memory".into());
        };
        let frame = native
            .as_any()
            .downcast_ref::<GpuFrame>()
            .ok_or("nvenc: a native frame of another platform")?;
        if frame.luid != self.device.adapter.luid {
            return Err("nvenc: the frame is on another GPU".into());
        }
        let registered = self.registered(frame)?;
        let mut map = NV_ENC_MAP_INPUT_RESOURCE {
            version: NV_ENC_MAP_INPUT_RESOURCE_VER,
            registeredResource: registered,
            ..Default::default()
        };
        call!(self.api, nvEncMapInputResource(self.enc, &mut map))?;
        let mut pic = NV_ENC_PIC_PARAMS {
            version: NV_ENC_PIC_PARAMS_VER,
            inputWidth: self.width,
            inputHeight: self.height,
            inputPitch: self.width,
            encodePicFlags: if force_idr {
                NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS
            } else {
                0
            },
            frameIdx: self.frame,
            inputTimeStamp: ts_ms.max(0) as u64,
            inputBuffer: map.mappedResource,
            outputBitstream: self.output,
            bufferFmt: map.mappedBufferFmt,
            pictureStruct: NV_ENC_PIC_STRUCT_FRAME,
            ..Default::default()
        };
        self.frame = self.frame.wrapping_add(1);
        let encoded = call!(self.api, nvEncEncodePicture(self.enc, &mut pic)).and_then(|()| {
            let mut lock = NV_ENC_LOCK_BITSTREAM {
                version: NV_ENC_LOCK_BITSTREAM_VER,
                outputBitstream: self.output,
                ..Default::default()
            };
            call!(self.api, nvEncLockBitstream(self.enc, &mut lock))?;
            if !lock.bitstreamBufferPtr.is_null() {
                // SAFETY: the driver's locked buffer, its size as it says, until the unlock below.
                out.extend_from_slice(unsafe {
                    std::slice::from_raw_parts(
                        lock.bitstreamBufferPtr as *const u8,
                        lock.bitstreamSizeInBytes as usize,
                    )
                });
            }
            let keyframe = lock.pictureType == NV_ENC_PIC_TYPE_IDR;
            let qp = lock.frameAvgQP as f32;
            call!(self.api, nvEncUnlockBitstream(self.enc, self.output))?;
            Ok((keyframe, qp))
        });
        let unmapped = call!(
            self.api,
            nvEncUnmapInputResource(self.enc, map.mappedResource)
        );
        let (keyframe, qp) = encoded?;
        unmapped?;
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
        for r in std::mem::take(&mut self.registered) {
            let _ = call!(self.api, nvEncUnregisterResource(self.enc, r.ptr));
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
        let api = NVENCAPI_MAJOR_VERSION | (NVENCAPI_MINOR_VERSION << 24);
        assert_eq!(NV_ENC_REGISTER_RESOURCE_VER, api | (4 << 16) | (0x7 << 28));
        assert_eq!(NV_ENC_CONFIG_VER & (1 << 31), 1 << 31);
        assert_eq!(NV_ENC_CODEC_H264_GUID.Data1, 0x6bc8_2762);
    }

    #[test]
    fn the_structs_the_driver_reads_have_the_headers_sizes() {
        // nvEncodeAPI.h 12.1's own sizes on x64: a struct bindgen laid out differently would be refused by its version
        // check at best, misread at worst.
        assert_eq!(std::mem::size_of::<NV_ENC_REGISTER_RESOURCE>(), 1536);
        assert_eq!(std::mem::size_of::<NV_ENC_MAP_INPUT_RESOURCE>(), 1544);
    }
}
