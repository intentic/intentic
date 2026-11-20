//! cast-win-probe: what this Windows computer offers cast-win, as JSON: its adapters and monitors, a capture of each
//! monitor (damage for a few seconds, a screenshot written beside the binary), and each encoder's self-test.
//! `probe [--seconds N] [--shots DIR]`.

#[cfg(windows)]
fn main() {
    use cast_core::capture::ScreenSource;
    use cast_win::capture::{DxgiSource, Sink};
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
    let seconds: f64 = arg("--seconds").and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let shots = arg("--shots").unwrap_or_else(|| ".".into());
    let adapters: Vec<_> = cast_win::displays::adapters()
        .iter()
        .map(|a| serde_json::json!({"name": a.name, "vendor": format!("{:04x}", a.vendor), "luid": a.luid}))
        .collect();
    let mut monitors = Vec::new();
    for d in cast_win::displays::displays() {
        let hub = cast_core::hub::Hub::new(1.0, None);
        let mut report = serde_json::json!({
            "id": d.id, "name": d.name, "gdi": d.gdi, "adapter": d.adapter.name,
            "rect": [d.rect.left, d.rect.top, d.rect.right, d.rect.bottom], "scale": d.scale, "primary": d.primary,
        });
        for (label, sink) in [
            ("cpu", Sink::Cpu),
            (
                "gpu",
                cast_win::d3d::Device::new(&d.adapter)
                    .map(Sink::Gpu)
                    .unwrap_or(Sink::Cpu),
            ),
        ] {
            let mut src = DxgiSource::new(&d.id, hub.clone(), sink);
            let t = Instant::now();
            let mut cap = match src.open(None) {
                Ok(c) => c,
                Err(e) => {
                    report[label] = serde_json::json!({"error": e});
                    continue;
                }
            };
            let open_ms = t.elapsed().as_secs_f64() * 1000.0;
            let (mut pumps, mut damaged) = (0u32, 0u32);
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs_f64(seconds) {
                if let Some(w) = cap.waitable() {
                    cast_core::wake::wait_any(&[w], 100);
                }
                if let Err(e) = cap.pump() {
                    report[label]["pumpError"] = e.into();
                    break;
                }
                pumps += 1;
                if cap.damage().damaged {
                    damaged += 1;
                    let _ = cap.damage().take_band();
                    let _ = cap.damage().take_mb_map();
                }
            }
            let shot = cap.snapshot();
            let mut frame = serde_json::Value::Null;
            if let Some(&f) = cap.formats().first() {
                let h = cap.area().h;
                let mut times = Vec::new();
                let mut err = None;
                match cap.new_frame(f) {
                    Ok(mut fr) => {
                        for _ in 0..20 {
                            let t = Instant::now();
                            if let Err(e) = cap
                                .grab(cast_core::geometry::Band { y0: 0, y1: h })
                                .and_then(|()| cap.fill(&mut fr, 0, h as usize, 4))
                            {
                                err = Some(e);
                                break;
                            }
                            times.push(t.elapsed().as_secs_f64() * 1000.0);
                            std::thread::sleep(Duration::from_millis(5));
                        }
                    }
                    Err(e) => err = Some(e),
                }
                times.sort_by(f64::total_cmp);
                frame = serde_json::json!({"format": format!("{f:?}"), "fullGrabFillMs": {"min": times.first(), "p50": times.get(times.len() / 2), "max": times.last()}, "error": err});
            }
            let a = cap.area();
            let file = format!("{shots}/probe-{}-{label}.png", d.id);
            if let Ok(bgrx) = &shot {
                let mut rgba = bgrx.clone();
                for p in rgba.as_chunks_mut::<4>().0 {
                    p.swap(0, 2);
                    p[3] = 255;
                }
                let out = std::fs::File::create(&file).unwrap();
                let mut enc = png::Encoder::new(std::io::BufWriter::new(out), a.w, a.h);
                enc.set_color(png::ColorType::Rgba);
                enc.write_header().unwrap().write_image_data(&rgba).unwrap();
            }
            report[label] = serde_json::json!({
                "size": [a.w, a.h], "openMs": open_ms, "pumps": pumps, "damagedPumps": damaged,
                "snapshot": shot.as_ref().map(|_| file.clone()).map_err(|e| e.clone()), "frame": frame,
            });
        }
        monitors.push(report);
    }
    let t = Instant::now();
    let openh264 = cast_core::encoder::self_test(&cast_core::openh264::OpenH264);
    let openh264_ms = t.elapsed().as_millis() as u64;
    // Every hardware encoder on every adapter, on its own GPU.
    let mut hardware = Vec::new();
    for a in cast_win::displays::adapters() {
        let Ok(dev) = cast_win::d3d::Device::new(&a) else {
            continue;
        };
        let mut kinds: Vec<(&str, Box<dyn cast_core::encoder::EncoderKind>)> = Vec::new();
        if a.is_nvidia() {
            kinds.push((
                "nvenc",
                Box::new(cast_win::nvenc::NvencKind {
                    device: dev.clone(),
                }),
            ));
        } else {
            kinds.push((
                "mf",
                Box::new(cast_win::mft::MftKind {
                    device: dev.clone(),
                }),
            ));
        }
        for (name, kind) in kinds {
            let t = Instant::now();
            let r = cast_win::select::gpu_self_test(kind.as_ref(), &dev);
            hardware.push(serde_json::json!({"encoder": name, "adapter": a.name, "ok": r.as_ref().err(), "ms": t.elapsed().as_millis() as u64}));
        }
    }
    let mf: Vec<_> = cast_win::mft::encoders()
        .into_iter()
        .map(|(a, n)| serde_json::json!({"adapter": a, "name": n}))
        .collect();
    let choices: Vec<_> = cast_win::displays::displays()
        .iter()
        .map(|d| {
            let c = cast_win::select::choose(d);
            serde_json::json!({"monitor": d.id, "encoder": c.label, "passedOver": c.passed_over})
        })
        .collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "adapters": adapters,
            "monitors": monitors,
            "selfTests": {"openh264": {"ok": openh264.as_ref().err(), "ms": openh264_ms}, "hardware": hardware},
            "mfEncoders": mf,
            "displayConfig": cast_win::displays::config(),
            "choices": choices,
        }))
        .unwrap()
    );
}

#[cfg(not(windows))]
fn main() {
    eprintln!("cast-win-probe runs on Windows");
}
