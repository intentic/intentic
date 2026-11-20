//! Which encoder a monitor is sent with, and where its frames go for it. `auto` takes the first candidate that passes
//! its self-test, in this order:
//!
//! 1. **NVENC on the monitor's own GPU** (an NVIDIA adapter drives the monitor): zero-copy.
//! 2. **Media Foundation's hardware encoder on the monitor's own GPU** (Intel Quick Sync, AMD, or NVIDIA's own MFT):
//!    zero-copy.
//! 3. **NVENC on another GPU** (an Optimus laptop's panel is on the Intel iGPU, NVENC on the NVIDIA one): the damaged
//!    rows cross through memory.
//! 4. **openh264** in software, reading the picture back.
//!
//! `CAST_WIN_ENCODER=nvenc|mf|openh264` asks for one; it must pass its test or the monitor falls back to openh264,
//! saying why. A hardware encoder is tested the way cast-core's `self_test` tests one (an IDR with SPS and PPS, deltas
//! that come straight back, a rate change that adds no keyframe, an IDR on demand) but with textures on its GPU, since
//! it reads nothing else. Each result is kept for the process's life.

use crate::capture::Sink;
use crate::d3d::{Device, GpuFrame};
use crate::displays::{self, Display};
use cast_core::encoder::{EncoderConfig, EncoderKind, Encoders, codec_string, nal_types};
use cast_core::frame::{FrameFormat, NativeFrame, Picture};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use windows::Win32::Graphics::Direct3D11::D3D11_BOX;

/// The encoder a monitor is sent with, and where its frames go.
pub struct Choice {
    pub encoders: Encoders,
    pub sink: Sink,
    /// For `/info` and the log: `nvenc`, `mf (Intel(R) Graphics)`, `nvenc via memory`, `openh264`.
    pub label: String,
    /// Each candidate passed over, and why.
    pub passed_over: Vec<(String, String)>,
}

/// The software encoder every monitor can fall back to.
pub fn software() -> Arc<dyn EncoderKind> {
    Arc::new(cast_core::openh264::OpenH264)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Want {
    Auto,
    Nvenc,
    Mf,
    Software,
}

fn want() -> Want {
    match std::env::var("CAST_WIN_ENCODER").ok().as_deref() {
        Some("nvenc") => Want::Nvenc,
        Some("mf") => Want::Mf,
        Some("openh264") => Want::Software,
        _ => Want::Auto,
    }
}

/// A hardware candidate: its label, the device it encodes on, and how it is opened there.
struct Candidate {
    label: String,
    kind: &'static str,
    device: Device,
}

/// Self-test results by (encoder, adapter LUID).
type Tested = Mutex<HashMap<(&'static str, i64), Result<(), String>>>;

fn tested() -> &'static Tested {
    static T: OnceLock<Tested> = OnceLock::new();
    T.get_or_init(Default::default)
}

fn kind_of(kind: &str, device: &Device) -> Arc<dyn EncoderKind> {
    match kind {
        "mf" => Arc::new(crate::mft::MftKind {
            device: device.clone(),
        }),
        _ => Arc::new(crate::nvenc::NvencKind {
            device: device.clone(),
        }),
    }
}

/// Picks the encoder for `display`.
pub fn choose(display: &Display) -> Choice {
    let want = want();
    let mut passed_over = Vec::new();
    let mut candidates = Vec::new();
    let mut own: Option<Device> = None;
    if !display.adapter.software && want != Want::Software {
        match Device::new(&display.adapter) {
            Ok(d) => own = Some(d),
            Err(e) => passed_over.push((display.adapter.name.clone(), e)),
        }
    }
    if let Some(d) = &own {
        if display.adapter.is_nvidia() && matches!(want, Want::Auto | Want::Nvenc) {
            candidates.push(Candidate {
                label: "nvenc".into(),
                kind: "nvenc",
                device: d.clone(),
            });
        }
        // Not NVIDIA's own MFT where NVENC is driven directly: activating it (and failing, seen on both laptops)
        // left the driver refusing the next NVENC session in the process with "invalid struct version".
        if matches!(want, Want::Auto | Want::Mf) && !display.adapter.is_nvidia() {
            candidates.push(Candidate {
                label: format!("mf ({})", display.adapter.name),
                kind: "mf",
                device: d.clone(),
            });
        }
    }
    if !display.adapter.is_nvidia() && matches!(want, Want::Auto | Want::Nvenc) {
        for a in displays::adapters().into_iter().filter(|a| a.is_nvidia()) {
            match Device::new(&a) {
                Ok(d) => candidates.push(Candidate {
                    label: "nvenc via memory".into(),
                    kind: "nvenc",
                    device: d,
                }),
                Err(e) => passed_over.push((a.name.clone(), e)),
            }
        }
    }
    for c in candidates {
        let key = (c.kind, c.device.adapter.luid);
        let cached = tested().lock().get(&key).cloned();
        let result = cached.unwrap_or_else(|| {
            let t = std::time::Instant::now();
            let kind = kind_of(c.kind, &c.device);
            let r = gpu_self_test(kind.as_ref(), &c.device);
            log::info!(
                "{} on {} self-test: {} ({} ms)",
                c.kind,
                c.device.adapter.name,
                r.as_ref().map_or_else(|e| e.as_str(), |()| "passed"),
                t.elapsed().as_millis()
            );
            tested().lock().insert(key, r.clone());
            r
        });
        match result {
            Ok(()) => {
                return Choice {
                    encoders: Encoders {
                        primary: kind_of(c.kind, &c.device),
                        fallback: software(),
                    },
                    sink: Sink::Gpu(c.device),
                    label: c.label,
                    passed_over,
                };
            }
            Err(e) => passed_over.push((c.label, e)),
        }
    }
    Choice {
        encoders: Encoders {
            primary: software(),
            fallback: software(),
        },
        sink: Sink::Cpu,
        label: "openh264".into(),
        passed_over,
    }
}

/// The encoders that passed their test on any adapter so far, for `/info`.
pub fn passed() -> Vec<String> {
    let mut out: Vec<String> = tested()
        .lock()
        .iter()
        .filter(|(_, r)| r.is_ok())
        .map(|((kind, _), _)| (*kind).to_string())
        .collect();
    out.sort();
    out.dedup();
    out.push("openh264".into());
    out
}

/// cast-core's self-test, with the pictures as textures on `device`.
pub fn gpu_self_test(kind: &dyn EncoderKind, device: &Device) -> Result<(), String> {
    let (w, h) = (320u32, 240u32);
    let cfg = EncoderConfig {
        width: w,
        height: h,
        fps: 60,
        preset: String::new(),
        threads: 1,
        crf: 24.0,
        max_kbps: 4000,
    };
    let mut enc = kind.open(&cfg)?;
    if !enc.formats().contains(&FrameFormat::Native) {
        return cast_core::encoder::self_test(kind);
    }
    let frames = [
        GpuFrame {
            texture: device.texture(w, h)?,
            width: w,
            height: h,
            luid: device.adapter.luid,
        },
        GpuFrame {
            texture: device.texture(w, h)?,
            width: w,
            height: h,
            luid: device.adapter.luid,
        },
    ];
    let mut px = vec![0u8; (w * h * 4) as usize];
    let mut frame = |enc: &mut Box<dyn cast_core::encoder::VideoEncoder>, n: usize, idr: bool| {
        // A bright square that moves 8 px a frame over a ramp: something to code as motion.
        let (w, h) = (w as usize, h as usize);
        for (i, p) in px.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let (x, r) = (i % w, i / w);
            let l = if (x + w - (8 * n) % w) % w < 64 && (40..104).contains(&r) {
                235
            } else {
                (32 + (x + r) % 160) as u8
            };
            p.copy_from_slice(&[l, (l / 2).wrapping_add(n as u8 * 4), 255 - l, 255]);
        }
        let f = &frames[n % 2];
        let b = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: w as u32,
            bottom: h as u32,
            back: 1,
        };
        // SAFETY: a w x h BGRA buffer into the whole texture.
        unsafe {
            device.ctx.UpdateSubresource(
                &f.texture,
                0,
                Some(&b),
                px.as_ptr().cast(),
                (w * 4) as u32,
                0,
            )
        };
        let mut out = Vec::new();
        let e = enc.encode(
            &Picture::Native(f as &dyn NativeFrame),
            n as i64 * 16,
            idr,
            None,
            None,
            &mut out,
        )?;
        Ok::<_, String>((e, out))
    };
    let (first, au) = frame(&mut enc, 0, true)?;
    let types = nal_types(&au);
    if !(au.starts_with(&[0, 0, 0, 1]) || au.starts_with(&[0, 0, 1])) {
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
    if codec_string(&enc.headers()).is_none() {
        return Err("the encoder hands out no SPS".into());
    }
    Ok(())
}
