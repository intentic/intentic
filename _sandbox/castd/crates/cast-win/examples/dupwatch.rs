//! cast-win-dupwatch: what duplication answers on each monitor over time, beside what Windows says about the session
//! (locked, the input desktop, the display's power, idle time) and whether GDI reads black: for finding out why a
//! computer stops letting itself be captured while nobody watches it. One JSON line per sample, then it ends.
//!
//! `dupwatch [--every 10] [--minutes 60]`

#[cfg(windows)]
fn main() {
    use std::time::{Duration, Instant};
    use windows::Win32::Graphics::Dxgi::IDXGIOutput1;
    use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
    use windows::core::Interface;
    cast_win::init_process();
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str, d: u64| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(d)
    };
    let every = Duration::from_secs(arg("--every", 10));
    let until = Instant::now() + Duration::from_secs(arg("--minutes", 60) * 60);
    // The display's state is a notification: registered now, answered at once.
    let _ = cast_win::session::display();
    while Instant::now() < until {
        let state = cast_win::session::State::now();
        let mut monitors = Vec::new();
        for d in cast_win::displays::displays() {
            let dup = match cast_win::d3d::Device::new(&d.adapter) {
                Ok(dev) => match d.output.cast::<IDXGIOutput1>() {
                    // SAFETY: a duplication on a device of the output's adapter, dropped at once.
                    Ok(o1) => match unsafe { o1.DuplicateOutput(&dev.device) } {
                        Ok(_) => "duplicated".to_string(),
                        Err(e) => format!("{:#x}", e.code().0),
                    },
                    Err(e) => e.to_string(),
                },
                Err(e) => e,
            };
            // Nine pixels across the monitor: all black reads as a display composing nothing.
            // SAFETY: the screen's DC, released after the reads.
            let lit = unsafe {
                let dc = GetDC(None);
                let mut lit = 0;
                for i in 1..=3 {
                    for j in 1..=3 {
                        let x = d.rect.left + (d.width() as i32 * i) / 4;
                        let y = d.rect.top + (d.height() as i32 * j) / 4;
                        if GetPixel(dc, x, y).0 & 0x00ff_ffff != 0 {
                            lit += 1;
                        }
                    }
                }
                ReleaseDC(None, dc);
                lit
            };
            monitors.push(serde_json::json!({ "id": d.id, "dup": dup, "gdiLit": lit }));
        }
        println!(
            "{}",
            serde_json::json!({
                "t": cast_win::session::epoch_ms(),
                "session": state,
                "blocked": state.blocked(false),
                "monitors": monitors,
            })
        );
        std::thread::sleep(every);
    }
}

#[cfg(not(windows))]
fn main() {}
