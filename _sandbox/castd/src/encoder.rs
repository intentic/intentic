//! The seam between the pipeline and an H.264 encoder: x264 in software, castd's default, or the GPU's own encoder
//! (NVENC, through the NVIDIA driver castd loads at runtime). Every backend keeps castd's contract: one Annex B access
//! unit per picture with SPS and PPS before each IDR, an IDR whenever asked, rate changes from the bitrate controller
//! between any two pictures without a keyframe, and no reordering or lookahead (a picture's output comes back from the
//! call that encoded it).
//!
//! `--encoder` picks one: `x264` (the default), `nvenc`, or `auto`, which takes the first hardware encoder that is
//! present and passes [`self_test`], else x264. A hardware encoder that cannot open at a new size (a session limit, a
//! size it does not take) leaves that picture to x264 rather than to nothing.

use crate::mp4::nals;

#[derive(Clone)]
pub struct EncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub preset: String,
    pub threads: u32,
    pub crf: f32,
    /// VBV cap in kbit/s (0 = uncapped).
    pub max_kbps: u32,
}

/// One I420 picture (BT.601 limited range, as libyuv converts the screen).
pub struct Planes<'a> {
    pub y: &'a [u8],
    pub u: &'a [u8],
    pub v: &'a [u8],
    pub stride_y: usize,
    pub stride_uv: usize,
}

/// What an encoder made of one picture.
pub struct Encoded {
    pub keyframe: bool,
    /// The QP the frame started at, when the encoder says one the pipeline can reason about (x264). None turns off
    /// video.rs's MotionQuality, whose model is x264's own rate control.
    pub qp: Option<f32>,
    /// x264's "average effective CRF": the CRF the frame was encoded with plus what VBV added to its average QP.
    pub crf_avg: f32,
}

/// An H.264 encoder for one stripe of the picture.
pub trait VideoEncoder: Send {
    fn name(&self) -> &'static str;
    /// Whether sliced threads make it faster (x264); a hardware encoder is one engine whatever the threads.
    fn threaded(&self) -> bool;
    /// Quality and bitrate cap from now on (a buffer of ~1.25 frames at `max_kbps`). `crf` is x264's scale; a hardware
    /// encoder maps it onto its own constant-quality target.
    fn set_rate(&mut self, crf: f32, max_kbps: u32);
    /// The same with an explicit VBV buffer, in kbit.
    fn set_rate_buf(&mut self, crf: f32, max_kbps: u32, buf_kbit: u32);
    /// Encodes one picture, appending its Annex B access unit to `out`. `force_idr` asks for an IDR, `qp` forces the
    /// frame's QP, and `mb_info` (one byte per macroblock, 1 where nothing changed) lets an encoder skip unchanged
    /// blocks without analysing them; an encoder that cannot use it ignores it.
    fn encode(
        &mut self,
        p: &Planes,
        ts_ms: i64,
        force_idr: bool,
        qp: Option<i32>,
        mb_info: Option<&mut [u8]>,
        out: &mut Vec<u8>,
    ) -> Result<Encoded, String>;
    /// The stream's SPS and PPS, Annex B.
    fn headers(&mut self) -> Vec<u8>;
}

/// A VBV buffer of 1.25 frames at `max_kbps`, rounded up: x264 treats a buffer under 1.1 frames as a single-frame VBV,
/// which may lower rows of a frame below its starting QP (video.rs's MotionQuality relies on it not doing that).
pub fn vbv_buffer_kbit(max_kbps: u32, fps: u32) -> u32 {
    (max_kbps * 5).div_ceil(4 * fps.max(1))
}

/// The WebCodecs codec string of an H.264 stream (`avc1.PPCCLL`: profile, constraint flags and level, in hex), read off
/// the first SPS in Annex B `data`.
pub fn codec_string(data: &[u8]) -> Option<String> {
    let sps = nals(data)
        .into_iter()
        .find(|n| n[0] & 0x1f == 7 && n.len() >= 4)?;
    Some(format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]))
}

/// An encoder castd can drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    X264,
    Nvenc,
}

impl Backend {
    pub fn name(self) -> &'static str {
        match self {
            Backend::X264 => "x264",
            Backend::Nvenc => "nvenc",
        }
    }

    /// Hardware encoders `auto` tries, in order: those this castd was built with.
    pub fn hardware() -> &'static [Backend] {
        if cfg!(feature = "nvenc") {
            &[Backend::Nvenc]
        } else {
            &[]
        }
    }
}

/// What `--encoder` asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
    Auto,
    Only(Backend),
}

impl Request {
    /// Parses `--encoder`. `vaapi` is named so the answer can say why it is refused: castd has no VA-API backend yet.
    pub fn parse(s: &str) -> Result<Request, String> {
        match s {
            "auto" => Ok(Request::Auto),
            "x264" => Ok(Request::Only(Backend::X264)),
            "nvenc" if cfg!(feature = "nvenc") => Ok(Request::Only(Backend::Nvenc)),
            "nvenc" => Err("--encoder nvenc: this castd was built without the `nvenc` feature".into()),
            "vaapi" => Err(
                "--encoder vaapi: castd has no VA-API backend (no VA-API encoder was reachable to build one against)"
                    .into(),
            ),
            other => Err(format!("--encoder {other}: expected auto, x264 or nvenc")),
        }
    }
}

/// Which backend castd runs, and what it tried on the way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selected {
    pub backend: Backend,
    /// Each hardware encoder tried and why it was passed over, for the log and /geometry.
    pub passed_over: Vec<(Backend, String)>,
}

/// Picks the encoder for `request`: `auto` takes the first of `hardware` whose `test` passes, else x264; a named
/// backend must pass its own test, and is refused with the reason when it does not. x264 is never tested: it is the
/// floor everything falls back to.
pub fn select(
    request: Request,
    hardware: &[Backend],
    mut test: impl FnMut(Backend) -> Result<(), String>,
) -> Result<Selected, String> {
    match request {
        Request::Only(Backend::X264) => Ok(Selected {
            backend: Backend::X264,
            passed_over: Vec::new(),
        }),
        Request::Only(b) => match test(b) {
            Ok(()) => Ok(Selected {
                backend: b,
                passed_over: Vec::new(),
            }),
            Err(e) => Err(format!("--encoder {}: {e}", b.name())),
        },
        Request::Auto => {
            let mut passed_over = Vec::new();
            for &b in hardware {
                match test(b) {
                    Ok(()) => {
                        return Ok(Selected {
                            backend: b,
                            passed_over,
                        });
                    }
                    Err(e) => passed_over.push((b, e)),
                }
            }
            Ok(Selected {
                backend: Backend::X264,
                passed_over,
            })
        }
    }
}

/// Opens `backend` for one stripe.
pub fn open(backend: Backend, cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
    match backend {
        Backend::X264 => Ok(Box::new(crate::x264::X264::new(cfg)?)),
        #[cfg(feature = "nvenc")]
        Backend::Nvenc => Ok(Box::new(crate::nvenc::Nvenc::new(cfg)?)),
        #[cfg(not(feature = "nvenc"))]
        Backend::Nvenc => Err("built without the `nvenc` feature".into()),
    }
}

/// The NAL unit types in an Annex B access unit, in order.
pub fn nal_types(au: &[u8]) -> Vec<u8> {
    nals(au).into_iter().map(|n| n[0] & 0x1f).collect()
}

/// Proves `backend` keeps castd's contract on this machine before castd trusts it with a window: it opens at a small
/// size, encodes an IDR (SPS, PPS and an IDR slice, Annex B), deltas that follow at once (no reordering), a rate change
/// that adds no keyframe, and a second IDR on demand.
pub fn self_test(backend: Backend) -> Result<(), String> {
    let (w, h) = (320usize, 240usize);
    let cfg = EncoderConfig {
        width: w as u32,
        height: h as u32,
        fps: 60,
        preset: "ultrafast".into(),
        threads: 1,
        crf: 24.0,
        max_kbps: 4000,
    };
    let mut enc = open(backend, &cfg)?;
    let (mut y, u, v) = (
        vec![16u8; w * h],
        vec![128u8; w * h / 4],
        vec![128u8; w * h / 4],
    );
    let mut frame = |enc: &mut Box<dyn VideoEncoder>,
                     n: usize,
                     idr: bool|
     -> Result<(Encoded, Vec<u8>), String> {
        // A bright square that moves 8 px a frame over a grey ramp: something to code as motion.
        for (i, p) in y.iter_mut().enumerate() {
            let (x, r) = (i % w, i / w);
            *p = if (x + w - (8 * n) % w) % w < 64 && (40..104).contains(&r) {
                235
            } else {
                (32 + (x + r) % 160) as u8
            };
        }
        let planes = Planes {
            y: &y,
            u: &u,
            v: &v,
            stride_y: w,
            stride_uv: w / 2,
        };
        let mut out = Vec::new();
        let e = enc.encode(&planes, n as i64 * 16, idr, None, None, &mut out)?;
        Ok((e, out))
    };
    let (first, au) = frame(&mut enc, 0, true)?;
    let types = nal_types(&au);
    if !au.starts_with(&[0, 0, 0, 1]) && !au.starts_with(&[0, 0, 1]) {
        return Err("the first access unit is not Annex B".into());
    }
    if !(first.keyframe && types.contains(&7) && types.contains(&8) && types.contains(&5)) {
        return Err(format!(
            "the first access unit is no IDR with SPS and PPS (NAL types {types:?})"
        ));
    }
    for n in 1..4 {
        if n == 2 {
            enc.set_rate(28.0, 2000);
        }
        let (e, au) = frame(&mut enc, n, false)?;
        let types = nal_types(&au);
        if au.is_empty() {
            return Err(format!(
                "picture {n} came back empty: the encoder holds pictures back"
            ));
        }
        if e.keyframe || types.contains(&5) {
            return Err(format!(
                "picture {n} was a keyframe nobody asked for (NAL types {types:?})"
            ));
        }
    }
    let (e, au) = frame(&mut enc, 4, true)?;
    let types = nal_types(&au);
    if !(e.keyframe && types.contains(&7) && types.contains(&5)) {
        return Err(format!(
            "an IDR on demand came back without SPS and an IDR slice (NAL types {types:?})"
        ));
    }
    if enc.headers().is_empty() || codec_string(&enc.headers()).is_none() {
        return Err("the encoder hands out no SPS".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tester(
        results: &'static [(Backend, Result<(), &'static str>)],
    ) -> impl FnMut(Backend) -> Result<(), String> {
        move |b| {
            results
                .iter()
                .find(|(r, _)| *r == b)
                .map(|(_, r)| r.map_err(String::from))
                .unwrap_or_else(|| Err("not present".into()))
        }
    }

    #[test]
    fn auto_takes_hardware_that_passes_its_test() {
        let s = select(
            Request::Auto,
            &[Backend::Nvenc],
            tester(&[(Backend::Nvenc, Ok(()))]),
        )
        .unwrap();
        assert_eq!(s.backend, Backend::Nvenc);
        assert!(s.passed_over.is_empty());
    }

    #[test]
    fn auto_falls_back_to_x264_and_says_why() {
        let s = select(
            Request::Auto,
            &[Backend::Nvenc],
            tester(&[(Backend::Nvenc, Err("libnvidia-encode.so.1 not found"))]),
        )
        .unwrap();
        assert_eq!(s.backend, Backend::X264);
        assert_eq!(
            s.passed_over,
            vec![(
                Backend::Nvenc,
                "libnvidia-encode.so.1 not found".to_string()
            )]
        );
        // Without any hardware built in, auto is x264 and tests nothing.
        let mut tested = false;
        let s = select(Request::Auto, &[], |_| {
            tested = true;
            Ok(())
        })
        .unwrap();
        assert_eq!(s.backend, Backend::X264);
        assert!(!tested);
    }

    #[test]
    fn a_named_backend_must_pass_or_is_refused() {
        let ok = select(
            Request::Only(Backend::Nvenc),
            &[],
            tester(&[(Backend::Nvenc, Ok(()))]),
        );
        assert_eq!(ok.map(|s| s.backend), Ok(Backend::Nvenc));
        let refused = select(
            Request::Only(Backend::Nvenc),
            &[Backend::Nvenc],
            tester(&[(Backend::Nvenc, Err("no CUDA device"))]),
        );
        assert_eq!(refused, Err("--encoder nvenc: no CUDA device".to_string()));
        // x264 is the floor: never tested, never refused.
        let mut tested = false;
        let x = select(Request::Only(Backend::X264), &[Backend::Nvenc], |_| {
            tested = true;
            Err("unused".into())
        });
        assert_eq!(x.map(|s| s.backend), Ok(Backend::X264));
        assert!(!tested);
    }

    #[test]
    fn encoder_names_parse() {
        assert_eq!(Request::parse("auto"), Ok(Request::Auto));
        assert_eq!(Request::parse("x264"), Ok(Request::Only(Backend::X264)));
        assert_eq!(
            Request::parse("nvenc").is_ok(),
            cfg!(feature = "nvenc"),
            "nvenc parses exactly when built in"
        );
        assert!(
            Request::parse("vaapi")
                .unwrap_err()
                .contains("no VA-API backend")
        );
        assert!(Request::parse("qsv").is_err());
    }

    /// On a machine with an NVIDIA driver (a container started with `--gpus all`), NVENC must pass the same test;
    /// elsewhere this stands down, saying why.
    #[cfg(feature = "nvenc")]
    #[test]
    fn nvenc_passes_the_self_test_where_there_is_a_driver() {
        match crate::nvenc::Nvenc::device_name() {
            Some(gpu) => {
                self_test(Backend::Nvenc).unwrap_or_else(|e| panic!("NVENC on {gpu}: {e}"))
            }
            None => eprintln!("nvenc self-test stands down: no NVIDIA driver here"),
        }
    }

    #[test]
    fn x264_passes_the_self_test() {
        // The test the hardware backends must pass, run on the backend that is always there: proves the test itself.
        self_test(Backend::X264).unwrap();
    }
}
