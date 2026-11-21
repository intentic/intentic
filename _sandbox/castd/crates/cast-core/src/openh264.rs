//! Cisco's openh264 (BSD-2-Clause, built from source by openh264-sys2) as an [`EncoderKind`]: the software encoder a
//! build without x264 falls back to, so a Windows binary carries no GPL. Constrained Baseline, which every browser
//! decodes; screen-content mode; one reference frame, no B-frames, no lookahead, so a picture's access unit comes back
//! from the call that encoded it.
//!
//! Rate control is openh264's bitrate mode aiming at the controller's cap, with frame skipping off (castd's contract: a
//! picture always comes back). Scene-change IDRs are asked off too, but screen-content mode turns the detection back on
//! (openh264 says so and does it), and with no long-term references a scene change, a window switch, is an IDR. A rate change is
//! `ENCODER_OPTION_BITRATE`, which openh264 applies without resetting the encoder, so the stream carries on as P-frames.
//! openh264 cannot move its QP range without a reset, so `crf` sets nothing: paint-over still works, because a still
//! picture re-encoded under the cap converges on the QP floor within a frame or two.

use crate::encoder::{Encoded, EncoderConfig, EncoderKind, VideoEncoder};
use crate::frame::Picture;
use openh264_sys2::{self as sys, API};
use std::ffi::{c_int, c_void};

/// The encoder kind the pipeline opens: `cast_core::openh264::OpenH264`.
pub struct OpenH264;

impl EncoderKind for OpenH264 {
    fn name(&self) -> &'static str {
        "openh264"
    }

    fn hardware(&self) -> bool {
        false
    }

    fn open(&self, cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
        Ok(Box::new(Encoder::new(cfg)?))
    }
}

/// The QP floor: lower spends bits a still picture has room for on sharper text.
const MIN_QP: c_int = 14;
/// The QP ceiling under a short cap: openh264 holds a frame here rather than skip it.
const MAX_QP: c_int = 46;

pub struct Encoder {
    api: sys::source::APILoader,
    enc: *mut sys::ISVCEncoder,
    width: c_int,
    height: c_int,
    bitrate: u32,
    info: Box<sys::SFrameBSInfo>,
    headers: Vec<u8>,
}

// One thread (the stripe's encode worker) uses the encoder at a time.
unsafe impl Send for Encoder {}

/// Calls one of the encoder's vtable entries, which openh264 always fills.
macro_rules! vcall {
    ($enc:expr, $f:ident ( $($arg:expr),* )) => {{
        // SAFETY: `enc` is a live encoder WelsCreateSVCEncoder made; its vtable is openh264's own.
        let f = unsafe { (**$enc).$f }.ok_or(concat!("openh264 has no ", stringify!($f)))?;
        unsafe { f($enc, $($arg),*) }
    }};
}

fn check(r: c_int, what: &str) -> Result<(), String> {
    if r == 0 {
        Ok(())
    } else {
        Err(format!("openh264 {what} failed ({r})"))
    }
}

impl Encoder {
    pub fn new(cfg: &EncoderConfig) -> Result<Encoder, String> {
        let api = sys::source::APILoader;
        let mut enc: *mut sys::ISVCEncoder = std::ptr::null_mut();
        // SAFETY: openh264 writes a new encoder into `enc`, or leaves it null.
        check(
            unsafe { api.WelsCreateSVCEncoder(&mut enc) },
            "WelsCreateSVCEncoder",
        )?;
        if enc.is_null() {
            return Err("openh264 made no encoder".into());
        }
        // From here on a failure must destroy the encoder: build the struct first, so Drop does.
        let mut me = Encoder {
            api,
            enc,
            width: cfg.width as c_int,
            height: cfg.height as c_int,
            bitrate: cfg.max_kbps.max(100) * 1000,
            info: Box::default(),
            headers: Vec::new(),
        };
        me.initialize(cfg)?;
        Ok(me)
    }

    fn initialize(&mut self, cfg: &EncoderConfig) -> Result<(), String> {
        let enc = self.enc;
        // Errors only: openh264's warnings (no frame skipping, no scene-change IDRs) are what castd asks for.
        let mut level: c_int = sys::WELS_LOG_ERROR as c_int;
        check(
            vcall!(
                enc,
                SetOption(
                    sys::ENCODER_OPTION_TRACE_LEVEL,
                    (&mut level as *mut c_int).cast::<c_void>()
                )
            ),
            "SetOption(TRACE_LEVEL)",
        )?;
        let mut p = sys::SEncParamExt::default();
        check(vcall!(enc, GetDefaultParams(&mut p)), "GetDefaultParams")?;
        let fps = cfg.fps.max(1) as f32;
        let threads = cfg.threads.clamp(1, 8) as c_int;
        p.iUsageType = sys::SCREEN_CONTENT_REAL_TIME;
        p.iPicWidth = self.width;
        p.iPicHeight = self.height;
        p.iRCMode = sys::RC_BITRATE_MODE;
        p.iTargetBitrate = self.bitrate as c_int;
        p.iMaxBitrate = self.bitrate as c_int;
        p.fMaxFrameRate = fps;
        p.iTemporalLayerNum = 1;
        p.iSpatialLayerNum = 1;
        p.iComplexityMode = sys::LOW_COMPLEXITY;
        p.uiIntraPeriod = 0;
        p.iNumRefFrame = 1;
        p.eSpsPpsIdStrategy = sys::CONSTANT_ID;
        p.bEnableFrameSkip = false;
        p.bEnableSceneChangeDetect = false;
        // Neither is supported for screen content: openh264 turns them off itself, and says so.
        p.bEnableBackgroundDetection = false;
        p.bEnableAdaptiveQuant = false;
        p.bEnableDenoise = false;
        p.bEnableLongTermReference = false;
        p.iLoopFilterDisableIdc = 0;
        p.iMinQp = MIN_QP;
        p.iMaxQp = MAX_QP;
        p.iMultipleThreadIdc = threads as u16;
        let layer = &mut p.sSpatialLayers[0];
        layer.iVideoWidth = self.width;
        layer.iVideoHeight = self.height;
        layer.fFrameRate = fps;
        layer.iSpatialBitrate = self.bitrate as c_int;
        layer.iMaxSpatialBitrate = self.bitrate as c_int;
        layer.uiProfileIdc = sys::PRO_BASELINE;
        if threads > 1 {
            layer.sSliceArgument.uiSliceMode = sys::SM_FIXEDSLCNUM_SLICE;
            layer.sSliceArgument.uiSliceNum = threads as u32;
        } else {
            layer.sSliceArgument.uiSliceMode = sys::SM_SINGLE_SLICE;
            layer.sSliceArgument.uiSliceNum = 1;
        }
        // What castd's other encoders say (x264.rs, nvenc.rs): sRGB content in BT.601 limited range, as convert.rs makes it.
        layer.bVideoSignalTypePresent = true;
        layer.uiVideoFormat = 5;
        layer.bFullRange = false;
        layer.bColorDescriptionPresent = true;
        layer.uiColorPrimaries = 1;
        layer.uiTransferCharacteristics = 13;
        layer.uiColorMatrix = 6;
        check(vcall!(enc, InitializeExt(&p)), "InitializeExt")?;
        let mut format: c_int = sys::videoFormatI420 as c_int;
        check(
            vcall!(
                enc,
                SetOption(
                    sys::ENCODER_OPTION_DATAFORMAT,
                    (&mut format as *mut c_int).cast::<c_void>()
                )
            ),
            "SetOption(DATAFORMAT)",
        )?;
        check(
            vcall!(enc, EncodeParameterSets(&mut *self.info)),
            "EncodeParameterSets",
        )?;
        let mut headers = Vec::new();
        collect(&self.info, &mut headers);
        self.headers = headers;
        Ok(())
    }

    fn set_bitrate(&mut self, bps: u32) -> Result<(), String> {
        if bps == self.bitrate {
            return Ok(());
        }
        let enc = self.enc;
        let info = |option, layer, bitrate: u32| -> Result<(), String> {
            let mut b = sys::SBitrateInfo {
                iLayer: layer,
                iBitrate: bitrate as c_int,
            };
            check(
                vcall!(
                    enc,
                    SetOption(option, (&mut b as *mut sys::SBitrateInfo).cast::<c_void>())
                ),
                "SetOption(BITRATE)",
            )
        };
        // The layer's own maximum is what the target is checked against (the all-layers maximum is not), and the target
        // may never pass it: raise the maximum first, lower it last.
        let max = |bitrate| {
            info(
                sys::ENCODER_OPTION_MAX_BITRATE,
                sys::SPATIAL_LAYER_0,
                bitrate,
            )?;
            info(
                sys::ENCODER_OPTION_MAX_BITRATE,
                sys::SPATIAL_LAYER_ALL,
                bitrate,
            )
        };
        if bps > self.bitrate {
            max(bps)?;
            info(sys::ENCODER_OPTION_BITRATE, sys::SPATIAL_LAYER_ALL, bps)?;
        } else {
            info(sys::ENCODER_OPTION_BITRATE, sys::SPATIAL_LAYER_ALL, bps)?;
            max(bps)?;
        }
        self.bitrate = bps;
        Ok(())
    }
}

/// Appends every NAL unit of an encoded frame (Annex B, as openh264 writes them) to `out`.
fn collect(info: &sys::SFrameBSInfo, out: &mut Vec<u8>) {
    for layer in &info.sLayerInfo[..info.iLayerNum.clamp(0, 128) as usize] {
        if layer.pBsBuf.is_null() || layer.pNalLengthInByte.is_null() {
            continue;
        }
        // SAFETY: openh264 says the layer holds iNalCount NAL units back to back in pBsBuf, their lengths in
        // pNalLengthInByte, valid until the next call on the encoder.
        let lens = unsafe {
            std::slice::from_raw_parts(layer.pNalLengthInByte, layer.iNalCount.max(0) as usize)
        };
        let size: usize = lens.iter().map(|&n| n.max(0) as usize).sum();
        out.extend_from_slice(unsafe { std::slice::from_raw_parts(layer.pBsBuf, size) });
    }
}

impl VideoEncoder for Encoder {
    fn name(&self) -> &'static str {
        "openh264"
    }

    fn threaded(&self) -> bool {
        false
    }

    fn set_rate(&mut self, _crf: f32, max_kbps: u32) {
        if let Err(e) = self.set_bitrate(max_kbps.max(100) * 1000) {
            log::warn!("{e}");
        }
    }

    fn set_rate_buf(&mut self, crf: f32, max_kbps: u32, _buf_kbit: u32) {
        // No VBV to widen: openh264's bitrate mode already lets one frame overshoot and pays it back after.
        self.set_rate(crf, max_kbps);
    }

    fn set_rate_key(&mut self, crf: f32, max_kbps: u32, most_kbit: u32) {
        // openh264 has no VBV, and its IDR's size is not its target's: it clamps an IDR's QP to a range it picks from
        // bits per pixel (QP 24 to 36 at 2.6 Mbit/s for 720p at 60 Hz), and dense text at QP 36 is some 130 kB. A
        // bitrate whose second is the most a keyframe may be gives the lowest bits per pixel, the range topping out at
        // QP 40, and the smallest IDR openh264 makes; the next picture's `set_rate` brings the bitrate back.
        self.set_rate(crf, max_kbps.min(most_kbit));
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
        let planes = p.i420()?;
        let (w, h) = (self.width as usize, self.height as usize);
        let fits = planes.y.len() >= planes.stride_y * (h - 1) + w
            && planes.u.len() >= planes.stride_uv * (h / 2 - 1) + w / 2
            && planes.v.len() >= planes.stride_uv * (h / 2 - 1) + w / 2;
        if !fits {
            return Err("openh264: the picture is smaller than the encoder".into());
        }
        let enc = self.enc;
        if force_idr {
            check(vcall!(enc, ForceIntraFrame(true)), "ForceIntraFrame")?;
        }
        let src = sys::SSourcePicture {
            iColorFormat: sys::videoFormatI420 as c_int,
            iStride: [
                planes.stride_y as c_int,
                planes.stride_uv as c_int,
                planes.stride_uv as c_int,
                0,
            ],
            // openh264 only reads the source picture.
            pData: [
                planes.y.as_ptr().cast_mut(),
                planes.u.as_ptr().cast_mut(),
                planes.v.as_ptr().cast_mut(),
                std::ptr::null_mut(),
            ],
            iPicWidth: self.width,
            iPicHeight: self.height,
            uiTimeStamp: ts_ms.max(0),
            bPsnrY: false,
            bPsnrU: false,
            bPsnrV: false,
        };
        check(
            vcall!(enc, EncodeFrame(&src, &mut *self.info)),
            "EncodeFrame",
        )?;
        collect(&self.info, out);
        let keyframe = self.info.eFrameType == sys::videoFrameTypeIDR;
        Ok(Encoded {
            keyframe,
            // openh264's rate control is its own: video.rs's MotionQuality (a model of x264's) stays out of it.
            qp: None,
            crf_avg: 0.0,
        })
    }

    fn headers(&mut self) -> Vec<u8> {
        self.headers.clone()
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        let enc = self.enc;
        // SAFETY: the encoder this struct made, uninitialised and destroyed once.
        unsafe {
            if let Some(f) = (**enc).Uninitialize {
                f(enc);
            }
            self.api.WelsDestroySVCEncoder(enc);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openh264_passes_the_self_test() {
        crate::encoder::self_test(&OpenH264).unwrap();
    }

    #[test]
    fn the_bitrate_moves_up_past_where_it_opened_and_back_down() {
        let mut e = Encoder::new(&EncoderConfig {
            width: 320,
            height: 240,
            fps: 60,
            preset: String::new(),
            threads: 1,
            crf: 24.0,
            max_kbps: 30_000,
        })
        .unwrap();
        // What the controller asks for in a burst (a keyframe's room), then a short link.
        for kbps in [32_000, 64_000, 8_000, 30_000, 500] {
            e.set_bitrate(kbps * 1000)
                .unwrap_or_else(|err| panic!("{kbps} kbit/s: {err}"));
        }
    }

    /// One IDR of a 720p page of text-like strokes, after `prepare` sets the encoder's rate; its size in bytes.
    fn idr_bytes(prepare: impl FnOnce(&mut Encoder)) -> usize {
        let (w, h) = (1280usize, 720usize);
        let mut e = Encoder::new(&EncoderConfig {
            width: w as u32,
            height: h as u32,
            fps: 60,
            preset: String::new(),
            threads: 1,
            crf: 24.0,
            max_kbps: 2600,
        })
        .unwrap();
        prepare(&mut e);
        let mut seed: u32 = 0x9e37_79b9;
        let y: Vec<u8> = (0..w * h)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                // Dark strokes on white in lines of 11 rows every 20, as text is.
                if (i / w) % 20 < 11 && seed.is_multiple_of(3) {
                    40
                } else {
                    235
                }
            })
            .collect();
        let (u, v) = (vec![128u8; w * h / 4], vec![128u8; w * h / 4]);
        let picture = Picture::I420(crate::encoder::Planes {
            y: &y,
            u: &u,
            v: &v,
            stride_y: w,
            stride_uv: w / 2,
        });
        let mut out = Vec::new();
        let encoded = e.encode(&picture, 0, true, None, None, &mut out).unwrap();
        assert!(encoded.keyframe);
        out.len()
    }

    #[test]
    fn a_keyframe_held_to_a_slow_links_budget_comes_out_smaller() {
        // What a channel's keyframe gets (four times the cap), and what a track's at 2.7 Mbit/s gets (200 ms of it).
        let boosted = idr_bytes(|e| e.set_rate_buf(24.0, 4 * 2600, 4 * 2600 / 60 * 8));
        let held = idr_bytes(|e| e.set_rate_key(24.0, 2600, 540));
        assert!(
            held * 10 < boosted * 8,
            "held to the budget {held} bytes, boosted {boosted} bytes"
        );
    }

    #[test]
    fn the_parameter_sets_are_there_before_the_first_picture() {
        let mut e = Encoder::new(&EncoderConfig {
            width: 640,
            height: 360,
            fps: 60,
            preset: String::new(),
            threads: 2,
            crf: 24.0,
            max_kbps: 8000,
        })
        .unwrap();
        let codec = crate::encoder::codec_string(&e.headers()).unwrap();
        assert!(codec.starts_with("avc1.42"), "{codec}");
    }
}
