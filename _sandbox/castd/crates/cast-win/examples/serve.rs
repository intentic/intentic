//! cast-win-serve: one monitor of this Windows PC served over TCP with cast-core's router (castd's routes and media
//! socket), for cast-core's `viewer` example on another computer to measure; prints this process's CPU every few
//! seconds as JSON lines on stdout.
//!
//! `serve [--monitor ID|primary|N] [--port 9750] [--bind 127.0.0.1] [--key TEXT] [--fps 60] [--max-kbps 30000] [--crf 24]`
//! The session is `screen-<monitor id>`; `CAST_WIN_ENCODER=nvenc|mf|openh264` forces an encoder.
//!
//! `--synthetic scroll|video --size WxH --encoder nvenc|mf|openh264` serves no monitor but a picture drawn on the GPU at
//! 60 fps (a text page scrolling 8 px a frame, or a picture panning), through the same pipeline: what it measures is
//! everything but desktop duplication itself (a locked or sleeping laptop cannot be duplicated, and a synthetic picture
//! is the same on every computer). Frames sit in a ring of textures on the encoder's GPU and each is copied into the
//! pipeline's frame on the GPU, as the duplicated desktop is.

#[cfg(windows)]
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    use cast_core::{encoder, hub, record, server, video};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();
    cast_win::init_process();
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let num = |k: &str, d: u32| arg(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let displays = cast_win::displays::displays();
    let pick = arg("--monitor").unwrap_or_else(|| "primary".into());
    let display = match pick.as_str() {
        "primary" => displays.first(),
        p => p
            .parse::<usize>()
            .ok()
            .and_then(|i| displays.get(i))
            .or_else(|| displays.iter().find(|d| d.id == p)),
    }
    .cloned()
    .unwrap_or_else(|| {
        eprintln!("no monitor {pick}");
        std::process::exit(2)
    });
    let session = format!("screen-{}", display.id);
    let key = arg("--key")
        .unwrap_or_else(|| "cast-win-bench".into())
        .into_bytes();
    let hub = hub::Hub::new(display.scale, None);
    let base = video::VideoConfig {
        crop: None,
        fps: num("--fps", 60),
        preset: "ultrafast".into(),
        threads: 2,
        convert_threads: 4,
        crf: num("--crf", 24) as f32,
        max_kbps: num("--max-kbps", 30000),
        paintover_crf: 16.0,
        paintover_burst: 3,
        paintover_delay_ms: 150,
        min_kbps: 500,
        local_crf: 18.0,
        local_max_kbps: 200_000,
        local_fps: num("--fps", 60),
        lossless: false,
        lossless_delay: Duration::from_millis(100),
        coalesce: Duration::ZERO,
        stripes: 1,
        adaptive_threads: true,
        encoder: encoder::Encoders {
            primary: cast_win::select::software(),
            fallback: cast_win::select::software(),
        },
    };
    let encoder_label;
    if let Some(mode) = arg("--synthetic") {
        let (w, h) = arg("--size")
            .and_then(|s| {
                let (w, h) = s.split_once('x')?;
                Some((w.parse().ok()?, h.parse().ok()?))
            })
            .unwrap_or((1920u32, 1080u32));
        let want = arg("--encoder").unwrap_or_else(|| "nvenc".into());
        let adapters = cast_win::displays::adapters();
        let adapter = adapters
            .iter()
            .find(|a| (want == "nvenc") == a.is_nvidia())
            .or(adapters.first())
            .expect("an adapter");
        let dev = cast_win::d3d::Device::new(adapter).expect("a device");
        let mut v = base;
        let gpu = want != "openh264";
        v.encoder = encoder::Encoders {
            primary: match want.as_str() {
                "nvenc" => Arc::new(cast_win::nvenc::NvencKind {
                    device: dev.clone(),
                }),
                "mf" => Arc::new(cast_win::mft::MftKind {
                    device: dev.clone(),
                }),
                _ => cast_win::select::software(),
            },
            fallback: cast_win::select::software(),
        };
        encoder_label = format!("{want} on {} (synthetic {mode} {w}x{h})", adapter.name);
        let source = synthetic::Source {
            dev,
            w,
            h,
            mode,
            gpu,
        };
        if let Err(e) = video::spawn(v, hub.clone(), Box::new(source)) {
            eprintln!("video: {e}");
            std::process::exit(1);
        }
    } else {
        let screen = match cast_win::screen::open(&display.id, &hub, base) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1)
            }
        };
        encoder_label = screen.encoder.clone();
        *hub.input.lock() = screen.input.clone();
        if let Err(e) = video::spawn(screen.video, hub.clone(), Box::new(screen.source)) {
            eprintln!("video: {e}");
            std::process::exit(1);
        }
    }
    let app = server::App {
        hub: hub.clone(),
        key: Arc::new(key),
        session: Arc::new(session.clone()),
        recorder: record::Recorder::new(hub.clone(), Duration::from_secs(60), None),
    };
    let port = num("--port", 9750);
    // Loopback unless asked: a listener on every address has Windows Firewall ask the person at the screen.
    let host = arg("--bind").unwrap_or_else(|| "127.0.0.1".into());
    let listener = tokio::net::TcpListener::bind((host.as_str(), port as u16))
        .await
        .unwrap_or_else(|e| {
            eprintln!("bind {port}: {e}");
            std::process::exit(1)
        });
    println!(
        "{}",
        serde_json::json!({"serving": session, "port": port, "monitor": display.name, "encoder": encoder_label,
            "size": [display.width(), display.height()]})
    );
    tokio::spawn(async move {
        let mut last = (Instant::now(), cast_win::screen::process_cpu_seconds());
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let now = (Instant::now(), cast_win::screen::process_cpu_seconds());
            let cores = (now.1 - last.1) / now.0.duration_since(last.0).as_secs_f64();
            println!(
                "{}",
                serde_json::json!({"cpuCores": (cores * 1000.0).round() / 1000.0, "encoder": *hub.encoder.lock(),
                    "captured": hub.stats.captured.load(std::sync::atomic::Ordering::Relaxed),
                    "encodeUsTotal": hub.stats.encode_us.load(std::sync::atomic::Ordering::Relaxed)})
            );
            last = now;
        }
    });
    if let Err(e) = axum::serve(listener, server::router(app)).await {
        eprintln!("serving: {e}");
    }
}

/// A picture drawn on the GPU, for measuring the pipeline without desktop duplication.
#[cfg(windows)]
mod synthetic {
    use cast_core::capture::{Capture, Damage, ScreenSource};
    use cast_core::frame::{Frame, FrameFormat};
    use cast_core::geometry::Rect;
    use cast_core::wake::{Waitable, Wake};
    use cast_win::d3d::{Device, GpuFrame};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{Duration, Instant};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BOX, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, ID3D11Texture2D,
    };

    const RING: usize = 30;

    pub struct Source {
        pub dev: Device,
        pub w: u32,
        pub h: u32,
        pub mode: String,
        pub gpu: bool,
    }

    impl ScreenSource for Source {
        fn open(&mut self, _crop: Option<Rect>) -> Result<Box<dyn Capture>, String> {
            let (w, h) = (self.w as usize, self.h as usize);
            let full = D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: self.w,
                bottom: self.h,
                back: 1,
            };
            let mut px = vec![255u8; w * h * 4];
            let mut ring = Vec::new();
            for i in 0..RING {
                draw(&self.mode, i, w, h, &mut px);
                let t = self.dev.texture(self.w, self.h)?;
                unsafe {
                    self.dev.ctx.UpdateSubresource(
                        &t,
                        0,
                        Some(&full),
                        px.as_ptr().cast(),
                        self.w * 4,
                        0,
                    )
                };
                ring.push(t);
            }
            let wake = Arc::new(Wake::new().map_err(|e| e.to_string())?);
            let tick = Arc::new(AtomicU64::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            {
                let (wake, tick, stop) = (wake.clone(), tick.clone(), stop.clone());
                std::thread::spawn(move || {
                    let mut next = Instant::now();
                    while !stop.load(Ordering::Relaxed) {
                        next += Duration::from_micros(16_667);
                        let now = Instant::now();
                        if next > now {
                            std::thread::sleep(next - now);
                        }
                        tick.fetch_add(1, Ordering::Relaxed);
                        wake.signal();
                    }
                });
            }
            Ok(Box::new(Synthetic {
                dev: self.dev.clone(),
                ring,
                staging: self.dev.staging(self.w, self.h, true)?,
                cpu: vec![0; w * h * 4],
                w: self.w,
                h: self.h,
                damage: Damage::new(self.w, self.h),
                wake,
                tick,
                seen: 0,
                stop,
                gpu: self.gpu,
            }))
        }
    }

    /// Picture `n` of a scene: a text-like page scrolled 8 px a frame, or a smooth field panned.
    fn draw(mode: &str, n: usize, w: usize, h: usize, px: &mut [u8]) {
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let v = if mode == "video" {
                    let fx = (x + n * 6) as f32 / w as f32;
                    let fy = (y + n * 3) as f32 / h as f32;
                    [
                        (128.0 + 127.0 * ((fx + fy) * 13.0).sin()) as u8,
                        (128.0 + 127.0 * (fy * 7.0 - fx * 2.0).cos()) as u8,
                        (128.0 + 127.0 * (fx * 9.0 + fy * 3.0).sin()) as u8,
                    ]
                } else {
                    let yy = y + n * 8;
                    let line = yy % 22;
                    let glyph = ((x / 8 * 2654435761usize) ^ (yy / 22 * 40503)) >> 7;
                    let ink = line > 4
                        && line < 18
                        && x % 8 < 6
                        && (glyph >> (line + x % 8)) & 1 == 1
                        && (x / 64) % 9 != 8;
                    if ink { [30, 30, 30] } else { [255, 255, 255] }
                };
                px[i..i + 4].copy_from_slice(&[v[0], v[1], v[2], 255]);
            }
        }
    }

    struct Synthetic {
        dev: Device,
        ring: Vec<ID3D11Texture2D>,
        staging: ID3D11Texture2D,
        cpu: Vec<u8>,
        w: u32,
        h: u32,
        damage: Damage,
        wake: Arc<Wake>,
        tick: Arc<AtomicU64>,
        seen: u64,
        stop: Arc<AtomicBool>,
        gpu: bool,
    }

    unsafe impl Send for Synthetic {}

    impl Drop for Synthetic {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
        }
    }

    impl Capture for Synthetic {
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
            let t = self.tick.load(Ordering::Relaxed);
            if t != self.seen {
                self.seen = t;
                self.damage.add(0, 0, self.w, self.h);
            }
            Ok(())
        }
        fn needs_rebuild(&self) -> bool {
            false
        }
        fn pixels(&self) -> Option<(&[u8], usize)> {
            None
        }
        fn formats(&self) -> &[FrameFormat] {
            if self.gpu {
                &[FrameFormat::Native]
            } else {
                &[FrameFormat::I420]
            }
        }
        fn new_frame(&mut self, format: FrameFormat) -> Result<Frame, String> {
            match format {
                FrameFormat::Native => Ok(Frame::Native(Box::new(GpuFrame {
                    texture: self.dev.texture(self.w, self.h)?,
                    width: self.w,
                    height: self.h,
                    luid: self.dev.adapter.luid,
                }))),
                f => {
                    Frame::cpu(f, self.w as usize, self.h as usize).ok_or_else(|| "no frame".into())
                }
            }
        }
        fn fill(
            &mut self,
            dst: &mut Frame,
            y0: usize,
            y1: usize,
            threads: usize,
        ) -> Result<(), String> {
            let src = &self.ring[self.seen as usize % RING];
            match dst {
                Frame::Native(n) => {
                    let f = n.as_any_mut().downcast_mut::<GpuFrame>().ok_or("frame")?;
                    self.dev
                        .copy_rect(&f.texture, src, (0, y0 as u32, self.w, y1 as u32));
                }
                Frame::I420(buf) => {
                    // What the CPU path pays: the rows read back, then converted.
                    self.dev
                        .copy_rect(&self.staging, src, (0, y0 as u32, self.w, y1 as u32));
                    let mut m = D3D11_MAPPED_SUBRESOURCE::default();
                    unsafe {
                        self.dev
                            .ctx
                            .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut m))
                            .map_err(|e| e.to_string())?;
                        let row = self.w as usize * 4;
                        for y in y0..y1 {
                            std::ptr::copy_nonoverlapping(
                                (m.pData as *const u8).add(y * m.RowPitch as usize),
                                self.cpu.as_mut_ptr().add(y * row),
                                row,
                            );
                        }
                        self.dev.ctx.Unmap(&self.staging, 0);
                    }
                    cast_core::convert::convert_band(
                        &self.cpu,
                        self.w as usize * 4,
                        buf,
                        y0,
                        y1,
                        threads,
                    );
                }
                Frame::Bgra(_) => return Err("no BGRA frames here".into()),
            }
            Ok(())
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("cast-win-serve runs on Windows");
}
