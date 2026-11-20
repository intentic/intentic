//! Media Foundation's hardware H.264 encoder (an MFT: Intel Quick Sync, AMD's, NVIDIA's own) on the D3D11 device the
//! capture fills its frames on, so the picture stays on the GPU. The transform is found by its adapter's LUID
//! (`MFT_ENUM_ADAPTER_LUID`), handed the device through a DXGI device manager, and fed the frame's texture as a DXGI
//! surface buffer: BGRA when it takes ARGB32, else converted to NV12 first by the GPU's video processor (BT.601,
//! limited range, as castd's other encoders signal).
//!
//! castd's contract holds as the self-test checks it: low-latency mode, no B-frames, an IDR only when asked
//! (`CODECAPI_AVEncVideoForceKeyFrame`), and a rate change (`CODECAPI_AVEncCommonMeanBitRate`) applied between pictures
//! without one. Paint-over lowers `CODECAPI_AVEncVideoMinQP` where the encoder takes it. Hardware MFTs are asynchronous:
//! `encode` gives the picture when the transform asks for input and waits for its output, so a picture's access unit
//! still comes back from the call that encoded it.

use crate::d3d::{Device, GpuFrame};
use cast_core::encoder::{Encoded, EncoderConfig, EncoderKind, VideoEncoder, nal_types};
use cast_core::frame::{FrameFormat, Picture};
use std::mem::ManuallyDrop;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_OPTIMAL_SPEED, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoContext1,
    ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P601,
    DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Variant::VARIANT;
use windows::core::{GUID, Interface};

/// Media Foundation, started once for the process.
fn started() -> Result<(), String> {
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    STARTED
        .get_or_init(|| {
            // SAFETY: process-wide initialisation, never shut down (the process ends first).
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(|e| format!("MFStartup: {e}"))
        })
        .clone()
}

/// The hardware H.264 encoders Media Foundation offers on each adapter: (adapter, encoder) names.
pub fn encoders() -> Vec<(String, String)> {
    crate::displays::adapters()
        .into_iter()
        .flat_map(|a| {
            activations(a.luid)
                .into_iter()
                .map(move |m| (a.name.clone(), friendly(&m)))
        })
        .collect()
}

/// The hardware H.264 encoders on the adapter with this LUID, the one Media Foundation prefers first.
fn activations(luid: i64) -> Vec<IMFActivate> {
    if started().is_err() {
        return Vec::new();
    }
    // MFTEnum2 with the adapter's LUID: MFTEnumEx lists every adapter's encoders and says nothing of which is whose.
    // SAFETY: an attribute store this function makes, holding the LUID as the 8 bytes of a LUID struct.
    let attrs = unsafe {
        let mut a = None;
        if MFCreateAttributes(&mut a, 1).is_err() {
            return Vec::new();
        }
        let Some(a) = a else { return Vec::new() };
        let bytes = [
            (luid as u32).to_le_bytes(),
            ((luid >> 32) as i32).to_le_bytes(),
        ]
        .concat();
        if a.SetBlob(&MFT_ENUM_ADAPTER_LUID, &bytes).is_err() {
            return Vec::new();
        }
        a
    };
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut ptr: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut n = 0u32;
    // SAFETY: an array Media Foundation allocates and this function frees, its entries moved out first.
    unsafe {
        if MFTEnum2(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            None,
            Some(&out_info),
            &attrs,
            &mut ptr,
            &mut n,
        )
        .is_err()
            || ptr.is_null()
        {
            return Vec::new();
        }
        let list: Vec<IMFActivate> = (0..n as usize)
            .filter_map(|i| (*ptr.add(i)).take())
            .collect();
        CoTaskMemFree(Some(ptr as *const _));
        list
    }
}

fn friendly(a: &IMFActivate) -> String {
    let mut buf = [0u16; 256];
    let mut len = 0u32;
    // SAFETY: a buffer and its length.
    match unsafe { a.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len)) } {
        Ok(()) => String::from_utf16_lossy(&buf[..len as usize]),
        Err(_) => "a hardware H.264 encoder".into(),
    }
}

/// Media Foundation's hardware encoder on one device's GPU.
pub struct MftKind {
    pub device: Device,
}

impl EncoderKind for MftKind {
    fn name(&self) -> &'static str {
        "mf"
    }

    fn hardware(&self) -> bool {
        true
    }

    fn open(&self, cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
        Ok(Box::new(Mft::new(&self.device, cfg)?))
    }
}

fn hr<T>(r: windows::core::Result<T>, what: &str) -> Result<T, String> {
    r.map_err(|e| format!("{what}: {e}"))
}

pub struct Mft {
    device: Device,
    name: String,
    transform: IMFTransform,
    events: Option<IMFMediaEventGenerator>,
    codec: Option<ICodecAPI>,
    _manager: IMFDXGIDeviceManager,
    convert: Option<Converter>,
    width: u32,
    height: u32,
    fps: u32,
    /// Inputs the asynchronous transform asked for and has not been given yet.
    need: u32,
    provides_samples: bool,
    out_size: u32,
    headers: Vec<u8>,
    /// The bitrate and QP floor applied, so an unchanged `set_rate` costs nothing.
    applied: (u32, u32),
    /// The peak bitrate, set once: the mean moves under it.
    peak: u32,
    min_qp: bool,
    /// The next picture must be an IDR (the priming picture that gave the headers was one).
    idr_next: bool,
}

// One thread (the encode thread) uses the transform at a time; its COM objects are free-threaded.
unsafe impl Send for Mft {}

impl Mft {
    pub fn new(device: &Device, cfg: &EncoderConfig) -> Result<Mft, String> {
        started()?;
        let activate = activations(device.adapter.luid)
            .into_iter()
            .next()
            .ok_or_else(|| {
                format!(
                    "Media Foundation has no hardware H.264 encoder on {}",
                    device.adapter.name
                )
            })?;
        let name = friendly(&activate);
        // SAFETY: activation of the transform the enumeration offered.
        let transform: IMFTransform = hr(unsafe { activate.ActivateObject() }, "ActivateObject")?;
        let attrs = hr(unsafe { transform.GetAttributes() }, "GetAttributes")?;
        // SAFETY: plain attribute reads and writes on the transform's own store.
        let asynchronous = unsafe { attrs.GetUINT32(&MF_TRANSFORM_ASYNC) }.unwrap_or(0) != 0;
        if asynchronous {
            hr(
                unsafe { attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1) },
                "MF_TRANSFORM_ASYNC_UNLOCK",
            )?;
        }
        let _ = unsafe { attrs.SetUINT32(&MF_LOW_LATENCY, 1) };
        let mut token = 0u32;
        let mut manager = None;
        hr(
            unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager) },
            "MFCreateDXGIDeviceManager",
        )?;
        let manager: IMFDXGIDeviceManager = manager.ok_or("no DXGI device manager")?;
        hr(
            unsafe { manager.ResetDevice(&device.device, token) },
            "ResetDevice",
        )?;
        hr(
            unsafe {
                transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
            },
            "MFT_MESSAGE_SET_D3D_MANAGER",
        )?;
        let codec = transform.cast::<ICodecAPI>().ok();
        let fps = cfg.fps.max(1);
        let bps = cfg.max_kbps.max(100) * 1000;
        let mut me = Mft {
            device: device.clone(),
            name,
            events: if asynchronous {
                transform.cast().ok()
            } else {
                None
            },
            transform,
            codec,
            _manager: manager,
            convert: None,
            width: cfg.width,
            height: cfg.height,
            fps,
            need: 0,
            provides_samples: false,
            out_size: 0,
            headers: Vec::new(),
            applied: (0, 0),
            // Room for the controller's bursts (a keyframe's, a new page's) above the cap it opened with.
            peak: bps.saturating_mul(2),
            min_qp: false,
            idr_next: false,
        };
        // Rate control first: some transforms take its mode only before their media types.
        me.set(&CODECAPI_AVLowLatencyMode, VARIANT::from(true));
        let low_delay = me.set(
            &CODECAPI_AVEncCommonRateControlMode,
            VARIANT::from(eAVEncCommonRateControlMode_LowDelayVBR.0 as u32),
        );
        if !low_delay {
            me.set(
                &CODECAPI_AVEncCommonRateControlMode,
                VARIANT::from(eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32),
            );
        }
        me.set(&CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(bps));
        me.set(&CODECAPI_AVEncCommonMaxBitRate, VARIANT::from(me.peak));
        me.set(&CODECAPI_AVEncMPVDefaultBPictureCount, VARIANT::from(0u32));
        // No periodic keyframes: castd asks for one when a viewer needs it.
        if !me.set(&CODECAPI_AVEncMPVGOPSize, VARIANT::from(u32::MAX >> 1)) {
            me.set(&CODECAPI_AVEncMPVGOPSize, VARIANT::from(65535u32));
        }
        me.set(&CODECAPI_AVEncH264CABACEnable, VARIANT::from(true));
        me.min_qp = me.set(&CODECAPI_AVEncVideoMinQP, VARIANT::from(target_qp(cfg.crf)));
        me.applied = (bps, target_qp(cfg.crf));
        me.set_types(bps)?;
        // SAFETY: the stream info of output stream 0.
        if let Ok(info) = unsafe { me.transform.GetOutputStreamInfo(0) } {
            me.provides_samples = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
            me.out_size = info.cbSize.max(1 << 20);
            log::debug!(
                "{}: async {}, output stream flags {:#x}, size {}",
                me.name,
                me.events.is_some(),
                info.dwFlags,
                info.cbSize
            );
        }
        hr(
            unsafe {
                me.transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
            },
            "BEGIN_STREAMING",
        )?;
        hr(
            unsafe {
                me.transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
            },
            "START_OF_STREAM",
        )?;
        me.headers = me.sequence_header();
        if me.headers.is_empty() {
            me.prime()?;
        }
        log::info!(
            "mf: {} on {} at {}x{}, {} input, {} rate control",
            me.name,
            device.adapter.name,
            me.width,
            me.height,
            if me.convert.is_some() { "NV12" } else { "BGRA" },
            if low_delay {
                "low-delay VBR"
            } else {
                "peak-constrained VBR"
            },
        );
        Ok(me)
    }

    /// Sets one codec property; whether the transform took it.
    fn set(&self, api: &GUID, value: VARIANT) -> bool {
        let Some(c) = &self.codec else {
            return false;
        };
        // SAFETY: a property GUID and a VARIANT that outlives the call.
        unsafe { c.IsSupported(api).is_ok() && c.SetValue(api, &value).is_ok() }
    }

    fn set_types(&mut self, bps: u32) -> Result<(), String> {
        let (w, h) = (self.width, self.height);
        // SAFETY: media types this function makes and hands to the transform.
        unsafe {
            let out = hr(MFCreateMediaType(), "MFCreateMediaType")?;
            hr(
                out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video),
                "major type",
            )?;
            hr(out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264), "subtype")?;
            hr(out.SetUINT32(&MF_MT_AVG_BITRATE, bps), "bitrate")?;
            hr(
                out.SetUINT64(&MF_MT_FRAME_SIZE, (u64::from(w) << 32) | u64::from(h)),
                "frame size",
            )?;
            hr(
                out.SetUINT64(&MF_MT_FRAME_RATE, (u64::from(self.fps) << 32) | 1),
                "frame rate",
            )?;
            hr(
                out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1),
                "aspect",
            )?;
            hr(
                out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32),
                "interlace",
            )?;
            hr(
                out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32),
                "profile",
            )?;
            let _ = out.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32);
            let _ = out.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601.0 as u32);
            let _ = out.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32);
            let _ = out.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_sRGB.0 as u32);
            hr(self.transform.SetOutputType(0, &out, 0), "SetOutputType")?;
            // BGRA straight in where the transform takes it; else NV12, converted on the GPU.
            let mut argb = false;
            let mut i = 0;
            while let Ok(t) = self.transform.GetInputAvailableType(0, i) {
                i += 1;
                if t.GetGUID(&MF_MT_SUBTYPE).ok() == Some(MFVideoFormat_ARGB32) {
                    argb = true;
                }
            }
            let nv12_only = std::env::var("CAST_WIN_MF_NV12").is_ok();
            for subtype in [MFVideoFormat_ARGB32, MFVideoFormat_NV12] {
                if subtype == MFVideoFormat_ARGB32 && (!argb || nv12_only) {
                    continue;
                }
                let input = hr(MFCreateMediaType(), "MFCreateMediaType")?;
                hr(
                    input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video),
                    "major type",
                )?;
                hr(input.SetGUID(&MF_MT_SUBTYPE, &subtype), "subtype")?;
                hr(
                    input.SetUINT64(&MF_MT_FRAME_SIZE, (u64::from(w) << 32) | u64::from(h)),
                    "frame size",
                )?;
                hr(
                    input.SetUINT64(&MF_MT_FRAME_RATE, (u64::from(self.fps) << 32) | 1),
                    "frame rate",
                )?;
                hr(
                    input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1),
                    "aspect",
                )?;
                hr(
                    input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32),
                    "interlace",
                )?;
                match self.transform.SetInputType(0, &input, 0) {
                    Ok(()) => {
                        if subtype == MFVideoFormat_NV12 {
                            self.convert = Some(Converter::new(&self.device, w, h, self.fps)?);
                        }
                        return Ok(());
                    }
                    Err(e) if subtype == MFVideoFormat_NV12 => {
                        return Err(format!("SetInputType (NV12): {e}"));
                    }
                    Err(e) => log::debug!("mf: BGRA input refused ({e}); NV12 it is"),
                }
            }
        }
        Err("the encoder takes neither BGRA nor NV12".into())
    }

    /// SPS and PPS from the output type, once the transform has them there.
    fn sequence_header(&self) -> Vec<u8> {
        // SAFETY: a blob read off the transform's current output type.
        unsafe {
            let Ok(t) = self.transform.GetOutputCurrentType(0) else {
                return Vec::new();
            };
            let Ok(size) = t.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) else {
                return Vec::new();
            };
            let mut b = vec![0u8; size as usize];
            if t.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut b, None)
                .is_err()
            {
                return Vec::new();
            }
            b
        }
    }

    /// Encodes one black picture to learn SPS and PPS from its IDR, where the output type does not carry them.
    fn prime(&mut self) -> Result<(), String> {
        let tex = self.device.texture(self.width, self.height)?;
        let frame = GpuFrame {
            texture: tex,
            width: self.width,
            height: self.height,
            luid: self.device.adapter.luid,
        };
        let mut out = Vec::new();
        self.encode_texture(&frame.texture, 0, true, &mut out)?;
        log::trace!(
            "{}: priming picture: NAL types {:?}",
            self.name,
            nal_types(&out)
        );
        self.headers = cast_core::mp4::nals(&out)
            .into_iter()
            .filter(|n| matches!(n[0] & 0x1f, 7 | 8))
            .flat_map(|n| [&[0u8, 0, 0, 1][..], n].concat())
            .collect();
        self.idr_next = true;
        if self.headers.is_empty() {
            return Err("the encoder's IDR carries no SPS".into());
        }
        Ok(())
    }

    /// Waits for the asynchronous transform's next event of interest: whether it asks for input (else it has output).
    fn next_event(&mut self, want_output: bool) -> Result<bool, String> {
        let Some(events) = &self.events else {
            return Ok(!want_output);
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            // SAFETY: a poll of the transform's event queue.
            match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(ev) => {
                    let kind = unsafe { ev.GetType() }.unwrap_or(0);
                    if kind == METransformNeedInput.0 as u32 {
                        self.need += 1;
                        if !want_output {
                            return Ok(true);
                        }
                    } else if kind == METransformHaveOutput.0 as u32 {
                        return Ok(false);
                    } else if kind == METransformDrainComplete.0 as u32 {
                        continue;
                    } else {
                        let status = unsafe { ev.GetStatus() }.unwrap_or_default();
                        log::debug!("{}: event {kind} ({status:?})", self.name);
                        if status.is_err() {
                            return Err(format!(
                                "{}: the encoder failed (event {kind}: {status:?})",
                                self.name
                            ));
                        }
                    }
                }
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                    if Instant::now() > deadline {
                        return Err(format!(
                            "{}: no {} within 2 s: the encoder holds pictures back",
                            self.name,
                            if want_output {
                                "output"
                            } else {
                                "request for input"
                            }
                        ));
                    }
                    std::thread::sleep(Duration::from_micros(200));
                }
                Err(e) => return Err(format!("{}: GetEvent: {e}", self.name)),
            }
        }
    }

    fn encode_texture(
        &mut self,
        tex: &ID3D11Texture2D,
        ts_ms: i64,
        force_idr: bool,
        out: &mut Vec<u8>,
    ) -> Result<bool, String> {
        let input = match &mut self.convert {
            Some(c) => c.convert(&self.device, tex)?,
            None => tex.clone(),
        };
        // SAFETY: a sample wrapping the texture, handed to the transform and released after its output came back.
        let sample = unsafe {
            let buffer = hr(
                MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &input, 0, false),
                "MFCreateDXGISurfaceBuffer",
            )?;
            if let Ok(b2) = buffer.cast::<IMF2DBuffer>()
                && let Ok(len) = b2.GetContiguousLength()
            {
                let _ = buffer.SetCurrentLength(len);
            }
            let sample = hr(MFCreateSample(), "MFCreateSample")?;
            hr(sample.AddBuffer(&buffer), "AddBuffer")?;
            hr(sample.SetSampleTime(ts_ms.max(0) * 10_000), "SetSampleTime")?;
            hr(
                sample.SetSampleDuration(10_000_000 / i64::from(self.fps)),
                "SetSampleDuration",
            )?;
            sample
        };
        if force_idr {
            self.set(&CODECAPI_AVEncVideoForceKeyFrame, VARIANT::from(1u32));
        }
        let forced = force_idr;
        while self.events.is_some() && self.need == 0 {
            if !self.next_event(false)? {
                // Output nobody waited for: take it, so the transform goes on.
                self.take_output(&mut Vec::new())?;
            }
        }
        // SAFETY: stream 0 and the sample made above.
        hr(
            unsafe { self.transform.ProcessInput(0, &sample, 0) },
            "ProcessInput",
        )?;
        self.need = self.need.saturating_sub(1);
        loop {
            if self.events.is_some() && self.next_event(true)? {
                continue;
            }
            match self.take_output(out) {
                Ok(Some(key)) => {
                    // Some encoders keep the request standing until it is taken back.
                    if forced && std::env::var("CAST_WIN_MF_UNFORCE").is_ok() {
                        self.set(&CODECAPI_AVEncVideoForceKeyFrame, VARIANT::from(0u32));
                    }
                    return Ok(key);
                }
                Ok(None) if self.events.is_none() => {
                    return Err(format!("{}: the encoder holds pictures back", self.name));
                }
                Ok(None) => continue,
                Err(e) => return Err(e),
            }
        }
    }

    /// Takes one output sample's bytes into `out`: Some(keyframe), or None when there was none after all.
    fn take_output(&mut self, out: &mut Vec<u8>) -> Result<Option<bool>, String> {
        loop {
            let own = if self.provides_samples {
                None
            } else {
                // SAFETY: a memory buffer the transform writes into.
                unsafe {
                    let s = hr(MFCreateSample(), "MFCreateSample")?;
                    let b = hr(MFCreateMemoryBuffer(self.out_size), "MFCreateMemoryBuffer")?;
                    hr(s.AddBuffer(&b), "AddBuffer")?;
                    Some(s)
                }
            };
            let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(own),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            }];
            let mut status = 0u32;
            // SAFETY: one output buffer for stream 0; its sample and events are dropped below.
            let r = unsafe { self.transform.ProcessOutput(0, &mut buffers, &mut status) };
            log::trace!(
                "{}: ProcessOutput {r:?}, status {status:#x}, buffer status {:#x}",
                self.name,
                buffers[0].dwStatus
            );
            let sample = unsafe { ManuallyDrop::take(&mut buffers[0].pSample) };
            drop(unsafe { ManuallyDrop::take(&mut buffers[0].pEvents) });
            match r {
                Ok(()) => {}
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(None),
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    // The transform settled its output type: take the one it offers and ask again.
                    // SAFETY: the transform's own offer, handed back.
                    unsafe {
                        let t = hr(
                            self.transform.GetOutputAvailableType(0, 0),
                            "GetOutputAvailableType",
                        )?;
                        hr(self.transform.SetOutputType(0, &t, 0), "SetOutputType")?;
                    }
                    if self.headers.is_empty() {
                        self.headers = self.sequence_header();
                    }
                    // An asynchronous transform says when the output is ready again (its next HaveOutput event).
                    if self.events.is_some() {
                        return Ok(None);
                    }
                    continue;
                }
                Err(e) => return Err(format!("{}: ProcessOutput: {e}", self.name)),
            }
            let Some(sample) = sample else {
                return Ok(None);
            };
            // SAFETY: the sample's buffer, locked for reading and unlocked below.
            let key = unsafe {
                let key = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0;
                let buf = hr(
                    sample.ConvertToContiguousBuffer(),
                    "ConvertToContiguousBuffer",
                )?;
                let mut p = std::ptr::null_mut();
                let mut len = 0u32;
                hr(buf.Lock(&mut p, None, Some(&mut len)), "Lock")?;
                let bytes = std::slice::from_raw_parts(p, len as usize);
                let types = nal_types(bytes);
                let key = key || types.contains(&5);
                if key && !types.contains(&7) {
                    out.extend_from_slice(&self.headers);
                }
                out.extend_from_slice(bytes);
                let _ = buf.Unlock();
                key
            };
            return Ok(Some(key));
        }
    }
}

/// The QP floor for castd's CRF, on the same 0-51 scale.
fn target_qp(crf: f32) -> u32 {
    crf.round().clamp(1.0, 51.0) as u32
}

impl VideoEncoder for Mft {
    fn name(&self) -> &'static str {
        "mf"
    }

    fn threaded(&self) -> bool {
        false
    }

    fn formats(&self) -> &'static [FrameFormat] {
        &[FrameFormat::Native]
    }

    fn set_rate(&mut self, crf: f32, max_kbps: u32) {
        let bps = max_kbps.max(100) * 1000;
        let qp = target_qp(crf);
        if self.applied == (bps, qp) {
            return;
        }
        // The mean alone, under the peak set at the open: changing both at once had Intel's encoder start over with an
        // IDR (rog and omen, 2026-11-20), either one alone did not.
        let bps = bps.min(self.peak);
        if self.applied.0 != bps {
            self.set(&CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(bps));
        }
        if self.min_qp && self.applied.1 != qp {
            self.set(&CODECAPI_AVEncVideoMinQP, VARIANT::from(qp));
        }
        self.applied = (bps, qp);
    }

    fn set_rate_buf(&mut self, crf: f32, max_kbps: u32, _buf_kbit: u32) {
        self.set_rate(crf, max_kbps);
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
            return Err("mf reads textures on its GPU, not frames in memory".into());
        };
        let frame = native
            .as_any()
            .downcast_ref::<GpuFrame>()
            .ok_or("mf: a native frame of another platform")?;
        if frame.luid != self.device.adapter.luid {
            return Err("mf: the frame is on another GPU".into());
        }
        let primed = std::mem::take(&mut self.idr_next);
        let idr = force_idr || primed;
        let before = out.len();
        let keyframe = self.encode_texture(&frame.texture, ts_ms, idr, out)?;
        log::trace!(
            "{}: picture at {ts_ms} ms, IDR asked {idr}: NAL types {:?}",
            self.name,
            nal_types(&out[before..])
        );
        Ok(Encoded {
            keyframe,
            qp: None,
            crf_avg: 0.0,
        })
    }

    fn headers(&mut self) -> Vec<u8> {
        self.headers.clone()
    }
}

impl Drop for Mft {
    fn drop(&mut self) {
        // SAFETY: plain messages ending the stream.
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            if let Ok(s) = self.transform.cast::<IMFShutdown>() {
                let _ = s.Shutdown();
            }
        }
    }
}

/// BGRA to NV12 on the GPU's video processor, for a transform that takes no BGRA.
struct Converter {
    vctx: ID3D11VideoContext,
    vdev: ID3D11VideoDevice,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    output: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
    /// An input view per source texture (the pipeline's two frames).
    inputs: Vec<(ID3D11Texture2D, ID3D11VideoProcessorInputView)>,
}

impl Converter {
    fn new(device: &Device, w: u32, h: u32, fps: u32) -> Result<Converter, String> {
        let vdev: ID3D11VideoDevice = hr(device.device.cast(), "ID3D11VideoDevice")?;
        let vctx: ID3D11VideoContext = hr(device.ctx.cast(), "ID3D11VideoContext")?;
        let rate = DXGI_RATIONAL {
            Numerator: fps,
            Denominator: 1,
        };
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: w,
            InputHeight: h,
            OutputFrameRate: rate,
            OutputWidth: w,
            OutputHeight: h,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        // SAFETY: video objects of this device, made from descriptions that outlive the calls.
        unsafe {
            let enumerator = hr(
                vdev.CreateVideoProcessorEnumerator(&desc),
                "CreateVideoProcessorEnumerator",
            )?;
            let processor = hr(
                vdev.CreateVideoProcessor(&enumerator, 0),
                "CreateVideoProcessor",
            )?;
            let tdesc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut output = None;
            hr(
                device
                    .device
                    .CreateTexture2D(&tdesc, None, Some(&mut output)),
                "CreateTexture2D (NV12)",
            )?;
            let output: ID3D11Texture2D = output.ok_or("no NV12 texture")?;
            let vdesc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut output_view = None;
            hr(
                vdev.CreateVideoProcessorOutputView(
                    &output,
                    &enumerator,
                    &vdesc,
                    Some(&mut output_view),
                ),
                "CreateVideoProcessorOutputView",
            )?;
            if let Ok(v1) = vctx.cast::<ID3D11VideoContext1>() {
                v1.VideoProcessorSetStreamColorSpace1(
                    &processor,
                    0,
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                );
                v1.VideoProcessorSetOutputColorSpace1(
                    &processor,
                    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P601,
                );
            }
            vctx.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            Ok(Converter {
                vctx,
                vdev,
                enumerator,
                processor,
                output,
                output_view: output_view.ok_or("no output view")?,
                inputs: Vec::new(),
            })
        }
    }

    fn convert(
        &mut self,
        device: &Device,
        tex: &ID3D11Texture2D,
    ) -> Result<ID3D11Texture2D, String> {
        let _ = device;
        let view = match self.inputs.iter().find(|(t, _)| t.as_raw() == tex.as_raw()) {
            Some((_, v)) => v.clone(),
            None => {
                let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    FourCC: 0,
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                        Texture2D: D3D11_TEX2D_VPIV {
                            MipSlice: 0,
                            ArraySlice: 0,
                        },
                    },
                };
                let mut v = None;
                // SAFETY: a texture of this device and a description that outlives the call.
                hr(
                    unsafe {
                        self.vdev.CreateVideoProcessorInputView(
                            tex,
                            &self.enumerator,
                            &desc,
                            Some(&mut v),
                        )
                    },
                    "CreateVideoProcessorInputView",
                )?;
                let v = v.ok_or("no input view")?;
                if self.inputs.len() >= 4 {
                    self.inputs.remove(0);
                }
                self.inputs.push((tex.clone(), v.clone()));
                v
            }
        };
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: ManuallyDrop::new(Some(view)),
            ..Default::default()
        };
        let streams = [stream];
        // SAFETY: the processor's own views; the stream's view is released after the call.
        let r = unsafe {
            self.vctx
                .VideoProcessorBlt(&self.processor, &self.output_view, 0, &streams)
        };
        let [mut s] = streams;
        drop(unsafe { ManuallyDrop::take(&mut s.pInputSurface) });
        hr(r, "VideoProcessorBlt")?;
        Ok(self.output.clone())
    }
}
