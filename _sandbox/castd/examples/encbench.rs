//! Encoder cost alone, castd's seam with no capture or Chromium around it: one backend, one size, one synthetic scene,
//! as JSON. `cargo run --release --example encbench -- --backend nvenc --size 2560x1600 --scene scroll` (`x264`, `nvenc`
//! or `vaapi`)
//!
//! Scenes: `scroll` (rows of text-like detail moving 8 px a frame: every macroblock changes), `anim` (a 320 px square
//! sweeping over a still page: about a tenth of the picture changes), `still` (nothing changes after the first frame).
//! x264 gets castd's damage map (`mb_info`), as in the pipeline; the frame loop runs flat out, so the numbers are the
//! encoder's cost per frame, wall and CPU, not a frame rate.
//!
//! `--scene paintover` checks sharpening instead: a page shown at CRF 32, held still, then re-encoded three times at
//! CRF 16 the way video.rs's paint-over does (`set_rate` with the sharper CRF, the same picture again), printing each
//! frame's size and whether it was a keyframe: the refine passes must carry bits and none may be a keyframe.

use cast_core::encoder::{self, Backend, EncoderConfig, Planes};
use cast_core::frame::Picture;
use std::collections::HashMap;
use std::time::Instant;

fn cpu_ms() -> f64 {
    let mut r: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut r) };
    (r.ru_utime.tv_sec + r.ru_stime.tv_sec) as f64 * 1e3
        + (r.ru_utime.tv_usec + r.ru_stime.tv_usec) as f64 / 1e3
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut a = HashMap::new();
    for pair in args.chunks(2) {
        if let [k, v] = pair {
            a.insert(k.trim_start_matches("--").to_string(), v.clone());
        }
    }
    let backend = match a.get("backend").map_or("x264", String::as_str) {
        "nvenc" => Backend::Nvenc,
        "vaapi" => Backend::Vaapi,
        _ => Backend::X264,
    };
    let (w, h) = a
        .get("size")
        .and_then(|s| s.split_once('x'))
        .and_then(|(w, h)| Some((w.parse::<usize>().ok()?, h.parse::<usize>().ok()?)))
        .unwrap_or((1280, 880));
    let scene = a.get("scene").cloned().unwrap_or_else(|| "scroll".into());
    let frames: usize = a.get("frames").and_then(|f| f.parse().ok()).unwrap_or(300);
    let threads: u32 = a.get("threads").and_then(|f| f.parse().ok()).unwrap_or(1);
    let crf: f32 = a.get("crf").and_then(|f| f.parse().ok()).unwrap_or(24.0);
    // `--dump PREFIX`: the source as raw I420 (PREFIX.yuv) and the stream (PREFIX.h264), for a quality comparison with
    // `ffmpeg -i PREFIX.h264 -f rawvideo -s WxH -pix_fmt yuv420p -i PREFIX.yuv -lavfi psnr -f null -`.
    let mut dump = a.get("dump").map(|p| {
        (
            std::fs::File::create(format!("{p}.yuv")).unwrap(),
            std::fs::File::create(format!("{p}.h264")).unwrap(),
        )
    });
    let cfg = EncoderConfig {
        width: w as u32,
        height: h as u32,
        fps: 60,
        preset: "ultrafast".into(),
        threads,
        crf,
        max_kbps: a.get("kbps").and_then(|k| k.parse().ok()).unwrap_or(8000),
    };
    if scene == "paintover" {
        paintover(backend, &cfg);
        return;
    }
    let t = Instant::now();
    let mut enc = match encoder::open(backend, &cfg) {
        Ok(e) => e,
        Err(e) => {
            println!(
                "{}",
                serde_json::json!({ "backend": backend.name(), "error": e })
            );
            std::process::exit(1);
        }
    };
    let open_ms = t.elapsed().as_secs_f64() * 1e3;
    // A page: grey rows of dark "glyphs" on white, taller than the screen so a scroll always has new rows.
    let page_h = h * 3;
    let page: Vec<u8> = (0..page_h * w)
        .map(|i| {
            let (x, r) = (i % w, i / w);
            let line = r % 24;
            let glyph = ((x / 9) as u64 * 2_654_435_761 + (r / 24) as u64 * 40_503) >> 7;
            if line < 16 && (glyph >> (x % 9 + line % 6)) & 1 == 1 {
                40
            } else {
                235
            }
        })
        .collect();
    let (u, v) = (vec![128u8; w * h / 4], vec![128u8; w * h / 4]);
    let mut y = vec![0u8; w * h];
    let cols = w.div_ceil(16);
    let mbs = cols * h.div_ceil(16);
    let mut out = Vec::with_capacity(1 << 20);
    let (mut bytes, mut wall, mut cpu, mut worst) = (0usize, 0f64, 0f64, 0f64);
    let warm = 10;
    for n in 0..frames + warm {
        let mut info = vec![0u8; mbs];
        match scene.as_str() {
            "scroll" => {
                let top = (n * 8) % (page_h - h);
                y.copy_from_slice(&page[top * w..(top + h) * w]);
            }
            "anim" => {
                y.copy_from_slice(&page[..h * w]);
                let x0 = (n * 12) % (w - 320);
                let y0 = h / 4;
                for r in y0..y0 + 320 {
                    for x in x0..x0 + 320 {
                        y[r * w + x] = ((x - x0 + r - y0 + n * 4) % 200) as u8 + 30;
                    }
                }
                // Unchanged blocks are those outside both this frame's and the last's square.
                let prev = (n.max(1) - 1) * 12 % (w - 320);
                for (i, m) in info.iter_mut().enumerate() {
                    let (bx, by) = ((i % cols) * 16, (i / cols) * 16);
                    let inside =
                        |x0: usize| bx + 16 > x0 && bx < x0 + 320 && by + 16 > y0 && by < y0 + 320;
                    *m = u8::from(!(inside(x0) || inside(prev)));
                }
            }
            _ => {
                if n == 0 {
                    y.copy_from_slice(&page[..h * w]);
                }
                info.fill(1);
            }
        }
        let planes = Picture::I420(Planes {
            y: &y,
            u: &u,
            v: &v,
            stride_y: w,
            stride_uv: w / 2,
        });
        out.clear();
        let hint = (scene != "scroll" && n > 0).then_some(&mut info[..]);
        let (t0, c0) = (Instant::now(), cpu_ms());
        enc.encode(&planes, n as i64 * 16, n == 0, None, hint, &mut out)
            .unwrap();
        let (dt, dc) = (t0.elapsed().as_secs_f64() * 1e3, cpu_ms() - c0);
        if let Some((yuv, h264)) = dump.as_mut() {
            use std::io::Write;
            for plane in [&y[..], &u[..], &v[..]] {
                yuv.write_all(plane).unwrap();
            }
            h264.write_all(&out).unwrap();
        }
        if n >= warm {
            bytes += out.len();
            wall += dt;
            cpu += dc;
            worst = worst.max(dt);
        }
    }
    let f = frames as f64;
    println!(
        "{}",
        serde_json::json!({
            "backend": enc.name(),
            "size": format!("{w}x{h}"),
            "scene": scene,
            "frames": frames,
            "openMs": (open_ms * 10.0).round() / 10.0,
            "wallMsPerFrame": (wall / f * 1000.0).round() / 1000.0,
            "worstMs": (worst * 100.0).round() / 100.0,
            "cpuMsPerFrame": (cpu / f * 1000.0).round() / 1000.0,
            "coresAt60fps": (cpu / f * 60.0 / 1000.0 * 1000.0).round() / 1000.0,
            "kbitPerFrame": (bytes as f64 * 8.0 / 1000.0 / f * 10.0).round() / 10.0,
        })
    );
}

/// The paint-over sequence: what video.rs does once a picture has gone still.
fn paintover(backend: Backend, cfg: &EncoderConfig) {
    let (w, h) = (cfg.width as usize, cfg.height as usize);
    let mut enc = encoder::open(
        backend,
        &EncoderConfig {
            crf: 32.0,
            ..cfg.clone()
        },
    )
    .unwrap();
    let y: Vec<u8> = (0..w * h)
        .map(|i| {
            let (x, r) = (i % w, i / w);
            let glyph = ((x / 7) as u64 * 2_654_435_761 + (r / 20) as u64 * 40_503) >> 5;
            if r % 20 < 14 && (glyph >> (x % 7 + r % 5)) & 1 == 1 {
                30
            } else {
                230
            }
        })
        .collect();
    let (u, v) = (vec![128u8; w * h / 4], vec![128u8; w * h / 4]);
    let planes = Picture::I420(Planes {
        y: &y,
        u: &u,
        v: &v,
        stride_y: w,
        stride_uv: w / 2,
    });
    let mut frames = Vec::new();
    for n in 0..8 {
        // Frames 0-3 at CRF 32 (the motion quality), 4-6 the paint-over at CRF 16, 7 back at 32.
        let crf = if (4..7).contains(&n) { 16.0 } else { 32.0 };
        enc.set_rate(crf, cfg.max_kbps.max(20_000));
        let mut out = Vec::new();
        let e = enc
            .encode(&planes, n * 16, n == 0, None, None, &mut out)
            .unwrap();
        frames.push(
            serde_json::json!({ "n": n, "crf": crf, "bytes": out.len(), "keyframe": e.keyframe }),
        );
    }
    println!(
        "{}",
        serde_json::json!({ "backend": enc.name(), "scene": "paintover", "frames": frames })
    );
}
