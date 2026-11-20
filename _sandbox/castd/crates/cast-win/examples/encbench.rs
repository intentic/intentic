//! cast-win-encbench: each encoder this PC has, alone, on synthetic pictures at the sizes asked, as JSON lines: the
//! wall time and the CPU time of an encode (p50, p90), the bitrate it made, and keyframes it added. The pictures (a ring
//! of `--ring` of them, drawn in memory) are uploaded to textures on the picture's GPU first; each frame then copies one
//! into the frame on the GPU, as the pipeline copies the duplicated desktop, so nothing is uploaded per frame. A path
//! that moves pictures through memory is charged for it (`moveCpuMsMean`): `nvenc-bridge` reads the picture back off the
//! iGPU and uploads it to the NVIDIA GPU (an Optimus laptop's panel), `openh264` reads it back and converts it to I420.
//! Frames are paced at `--fps` (60), as the pipeline sends them, so the GPU's clocks are what a stream sees.
//!
//! `encbench [--sizes 1920x1080,2560x1440] [--scenes scroll,video,still] [--frames 300] [--kbps 30000] [--ring 12]
//! [--fps 60] [--only nvenc]`

#[cfg(windows)]
fn main() {
    use cast_core::encoder::{EncoderConfig, EncoderKind, VideoEncoder};
    use cast_core::frame::{NativeFrame, Picture};
    use cast_win::d3d::{Device, GpuFrame};
    use std::time::Instant;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BOX, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    };

    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .try_init();
    cast_win::init_process();
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let sizes: Vec<(u32, u32)> = arg("--sizes")
        .unwrap_or_else(|| "1920x1080,2560x1440".into())
        .split(',')
        .filter_map(|s| {
            let (w, h) = s.split_once('x')?;
            Some((w.parse().ok()?, h.parse().ok()?))
        })
        .collect();
    let scenes: Vec<String> = arg("--scenes")
        .unwrap_or_else(|| "scroll,video,still".into())
        .split(',')
        .map(String::from)
        .collect();
    let frames: usize = arg("--frames").and_then(|s| s.parse().ok()).unwrap_or(300);
    let kbps: u32 = arg("--kbps").and_then(|s| s.parse().ok()).unwrap_or(30_000);
    let only = arg("--only");
    let ring: usize = arg("--ring").and_then(|s| s.parse().ok()).unwrap_or(12);
    let fps: f64 = arg("--fps").and_then(|s| s.parse().ok()).unwrap_or(60.0);

    let adapters = cast_win::displays::adapters();
    let nvidia = adapters
        .iter()
        .find(|a| a.is_nvidia())
        .and_then(|a| Device::new(a).ok());
    let other = adapters
        .iter()
        .find(|a| !a.is_nvidia())
        .and_then(|a| Device::new(a).ok());

    // The thread's CPU time in microseconds.
    let cpu_us = cast_core::wake::thread_cpu_us;

    for &(w, h) in &sizes {
        // A text page twice the picture's height for scrolling, a smooth picture twice its size for panning.
        let page = draw_page(w as usize, h as usize * 2);
        let film = draw_film(w as usize * 2, h as usize * 2);
        for scene in &scenes {
            let picture = |n: usize, out: &mut Vec<u8>| {
                let (w, h) = (w as usize, h as usize);
                match scene.as_str() {
                    "scroll" => {
                        let off = (n * 8) % h;
                        out.copy_from_slice(&page[off * w * 4..(off + h) * w * 4]);
                    }
                    "video" => {
                        let t = n as f32 / 60.0;
                        let ox = (((t * 0.7).sin() * 0.5 + 0.5) * w as f32) as usize;
                        let oy = (((t * 0.5).cos() * 0.5 + 0.5) * h as f32) as usize;
                        for y in 0..h {
                            let s = ((y + oy) * w * 2 + ox) * 4;
                            out[y * w * 4..(y + 1) * w * 4].copy_from_slice(&film[s..s + w * 4]);
                        }
                    }
                    _ => out.copy_from_slice(&page[..w * h * 4]),
                }
            };
            let cfg = EncoderConfig {
                width: w,
                height: h,
                fps: 60,
                preset: String::new(),
                threads: 2,
                crf: 24.0,
                max_kbps: kbps,
            };
            // (label, kind, the device frames are on, the device pictures start on)
            type Run = (
                &'static str,
                Box<dyn EncoderKind>,
                Option<Device>,
                Option<Device>,
            );
            let mut runs: Vec<Run> = Vec::new();
            if let Some(d) = &nvidia {
                runs.push((
                    "nvenc",
                    Box::new(cast_win::nvenc::NvencKind { device: d.clone() }),
                    Some(d.clone()),
                    Some(d.clone()),
                ));
                if let Some(o) = &other {
                    runs.push((
                        "nvenc-bridge",
                        Box::new(cast_win::nvenc::NvencKind { device: d.clone() }),
                        Some(d.clone()),
                        Some(o.clone()),
                    ));
                }
            }
            if let Some(o) = &other {
                runs.push((
                    "mf",
                    Box::new(cast_win::mft::MftKind { device: o.clone() }),
                    Some(o.clone()),
                    Some(o.clone()),
                ));
            }
            runs.push((
                "openh264",
                Box::new(cast_core::openh264::OpenH264),
                None,
                other.clone().or(nvidia.clone()),
            ));
            for (label, kind, target, source) in runs {
                if only.as_deref().is_some_and(|o| o != label) {
                    continue;
                }
                let mut enc: Box<dyn VideoEncoder> = match kind.open(&cfg) {
                    Ok(e) => e,
                    Err(e) => {
                        println!(
                            "{}",
                            serde_json::json!({"size": format!("{w}x{h}"), "scene": scene, "encoder": label, "error": e})
                        );
                        continue;
                    }
                };
                let source = source.expect("a device");
                let full = D3D11_BOX {
                    left: 0,
                    top: 0,
                    front: 0,
                    right: w,
                    bottom: h,
                    back: 1,
                };
                // The ring of pictures, uploaded once (not counted).
                let mut px = vec![0u8; (w * h * 4) as usize];
                let sources: Vec<_> = (0..ring)
                    .map(|i| {
                        let t = source.texture(w, h).unwrap();
                        picture(i, &mut px);
                        unsafe {
                            source.ctx.UpdateSubresource(
                                &t,
                                0,
                                Some(&full),
                                px.as_ptr().cast(),
                                w * 4,
                                0,
                            )
                        };
                        t
                    })
                    .collect();
                unsafe { source.ctx.Flush() };
                let staging = source.staging(w, h, true).unwrap();
                let frame = target.as_ref().map(|t| GpuFrame {
                    texture: t.texture(w, h).unwrap(),
                    width: w,
                    height: h,
                    luid: t.adapter.luid,
                });
                let mut cpu_frame = cast_core::convert::I420::new(w as usize, h as usize);
                let mut readback = vec![0u8; (w * h * 4) as usize];
                let interval = std::time::Duration::from_secs_f64(1.0 / fps);
                let mut next = Instant::now();
                let (mut wall, mut cpu, mut moved) = (Vec::new(), Vec::new(), Vec::new());
                let (mut bytes, mut keys) = (0usize, 0usize);
                for n in 0..frames {
                    let now = Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    }
                    next += interval;
                    let src_tex = &sources[n % ring];
                    // Moving it to where the encoder reads (counted).
                    let t0 = Instant::now();
                    let c0 = cpu_us();
                    let bridge = label == "nvenc-bridge" || label == "openh264";
                    if bridge {
                        source.copy_rect(&staging, src_tex, (0, 0, w, h));
                        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
                        unsafe {
                            source
                                .ctx
                                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut m))
                                .unwrap();
                            for y in 0..h as usize {
                                std::ptr::copy_nonoverlapping(
                                    (m.pData as *const u8).add(y * m.RowPitch as usize),
                                    readback.as_mut_ptr().add(y * w as usize * 4),
                                    w as usize * 4,
                                );
                            }
                            source.ctx.Unmap(&staging, 0);
                        }
                        match (&target, &frame) {
                            (Some(t), Some(f)) => unsafe {
                                t.ctx.UpdateSubresource(
                                    &f.texture,
                                    0,
                                    Some(&full),
                                    readback.as_ptr().cast(),
                                    w * 4,
                                    0,
                                );
                                t.ctx.Flush();
                            },
                            _ => cast_core::convert::convert_band(
                                &readback,
                                w as usize * 4,
                                &mut cpu_frame,
                                0,
                                h as usize,
                                4,
                            ),
                        }
                    } else if let (Some(t), Some(f)) = (&target, &frame) {
                        t.copy_rect(&f.texture, src_tex, (0, 0, w, h));
                    }
                    let c1 = cpu_us();
                    let t1 = Instant::now();
                    let mut out = Vec::new();
                    let cpu_holder = cast_core::frame::Frame::I420(std::mem::replace(
                        &mut cpu_frame,
                        cast_core::convert::I420::new(0, 0),
                    ));
                    let pic = match &frame {
                        Some(f) => Picture::Native(f as &dyn NativeFrame),
                        None => cpu_holder.picture(0, h as usize),
                    };
                    // `--flap N`: move the bitrate every N frames, as the controller does on a short link.
                    if let Some(every) = arg("--flap").and_then(|v| v.parse::<usize>().ok())
                        && n > 0
                        && n % every == 0
                    {
                        let k = if (n / every) % 2 == 0 { kbps } else { kbps / 3 };
                        enc.set_rate(24.0, k);
                    }
                    let r = enc.encode(&pic, n as i64 * 16, n == 0, None, None, &mut out);
                    let _ = pic;
                    if let cast_core::frame::Frame::I420(f) = cpu_holder {
                        cpu_frame = f;
                    }
                    let c2 = cpu_us();
                    match r {
                        Ok(e) => {
                            if n >= 10 {
                                wall.push(t1.elapsed().as_secs_f64() * 1000.0);
                                cpu.push((c2 - c1) as f64 / 1000.0);
                                moved.push(
                                    (c1 - c0) as f64 / 1000.0 + (t1 - t0).as_secs_f64() * 0.0,
                                );
                                bytes += out.len();
                                keys += usize::from(e.keyframe);
                            }
                        }
                        Err(e) => {
                            println!(
                                "{}",
                                serde_json::json!({"size": format!("{w}x{h}"), "scene": scene, "encoder": label, "error": e})
                            );
                            break;
                        }
                    }
                }
                let pct = |v: &mut Vec<f64>, p: f64| {
                    v.sort_by(f64::total_cmp);
                    v.get(((v.len().max(1) - 1) as f64 * p).round() as usize)
                        .copied()
                        .unwrap_or(f64::NAN)
                };
                let measured = wall.len().max(1) as f64;
                let r2 = |v: f64| (v * 100.0).round() / 100.0;
                let _ = &px;
                println!(
                    "{}",
                    serde_json::json!({
                        "size": format!("{w}x{h}"), "scene": scene, "encoder": label,
                        "encodeWallMs": {"p50": r2(pct(&mut wall, 0.5)), "p90": r2(pct(&mut wall, 0.9))},
                        "encodeCpuMs": {"p50": r2(pct(&mut cpu.clone(), 0.5)), "mean": r2(cpu.iter().sum::<f64>() / measured)},
                        "moveCpuMsMean": r2(moved.iter().sum::<f64>() / measured),
                        "kbpsAt60": r2(bytes as f64 * 8.0 / 1000.0 / (measured / 60.0)),
                        "keyframes": keys,
                    })
                );
            }
        }
    }
}

/// A white page of black text lines, BGRA.
#[cfg(windows)]
fn draw_page(w: usize, h: usize) -> Vec<u8> {
    let mut px = vec![255u8; w * h * 4];
    // Glyph-like strokes: short dark runs on a text grid, irregular as words are.
    let mut seed: u32 = 0x9e37_79b9;
    let line = 22;
    for row in (8..h.saturating_sub(16)).step_by(line) {
        let mut x = 16;
        while x + 12 < w - 16 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let word = 3 + (seed % 9) as usize;
            for _ in 0..word {
                for gy in 0..14 {
                    for gx in 0..7 {
                        if (seed >> ((gx + gy * 7) % 31)) & 1 == 1 && gx < 6 {
                            let i = ((row + gy) * w + x + gx) * 4;
                            px[i..i + 3].copy_from_slice(&[30, 30, 30]);
                        }
                    }
                }
                x += 8;
                seed = seed.rotate_left(5) ^ 0x5bd1_e995;
                if x + 12 >= w - 16 {
                    break;
                }
            }
            x += 8;
        }
    }
    px
}

/// A smooth colour field, BGRA: what panning across a film looks like to an encoder.
#[cfg(windows)]
fn draw_film(w: usize, h: usize) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let fx = x as f32 / w as f32;
            let fy = y as f32 / h as f32;
            let r = (128.0 + 127.0 * (fx * 9.0 + fy * 3.0).sin()) as u8;
            let g = (128.0 + 127.0 * (fy * 7.0 - fx * 2.0).cos()) as u8;
            let b = (128.0 + 127.0 * ((fx + fy) * 13.0).sin()) as u8;
            let i = (y * w + x) * 4;
            px[i..i + 4].copy_from_slice(&[b, g, r, 255]);
        }
    }
    px
}

#[cfg(not(windows))]
fn main() {
    eprintln!("cast-win-encbench runs on Windows");
}
