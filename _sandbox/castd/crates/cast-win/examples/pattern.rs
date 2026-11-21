//! cast-win-pattern: content for a bench to capture, in a window of its own on one monitor, for a few seconds, then
//! gone. It never takes focus (WS_EX_NOACTIVATE) and leaves nothing behind.
//!
//! `pattern [--monitor N|ID] [--mode still|scroll|video|noise] [--seconds 20] [--fps 60] [--size WxH]`
//! - `--size`: a window of that size in the monitor's middle instead of the whole monitor (a computer someone is using).
//! - `still`: a page of text, drawn once.
//! - `scroll`: the page scrolling 8 px a frame, as castd's scroll fixture does.
//! - `video`: a picture panning and a box bouncing across it, smooth motion as a film has.
//! - `noise`: every pixel new every frame: the worst case any encoder sees.

#[cfg(windows)]
fn main() {
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::*;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::w;

    cast_win::init_process();
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let displays = cast_win::displays::displays();
    let pick = arg("--monitor").unwrap_or_else(|| "0".into());
    let d = pick
        .parse::<usize>()
        .ok()
        .and_then(|i| displays.get(i))
        .or_else(|| displays.iter().find(|d| d.id == pick))
        .cloned()
        .expect("no such monitor");
    let mode = arg("--mode").unwrap_or_else(|| "scroll".into());
    let seconds: f64 = arg("--seconds")
        .and_then(|s| s.parse().ok())
        .unwrap_or(20.0);
    let fps: f64 = arg("--fps").and_then(|s| s.parse().ok()).unwrap_or(60.0);
    let (w, h) = arg("--size")
        .and_then(|s| {
            let (a, b) = s.split_once('x')?;
            Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?))
        })
        .map_or((d.width(), d.height()), |(a, b)| (a.min(d.width()), b.min(d.height())));
    let (left, top) = (
        d.rect.left + (d.width() - w) as i32 / 2,
        d.rect.top + (d.height() - h) as i32 / 2,
    );
    let (w, h) = (w as usize, h as usize);

    extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        // SAFETY: the default handling of a window this process made.
        unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
    }
    // SAFETY: a window class and a popup window of this process, destroyed before it returns; GDI objects freed below.
    unsafe {
        let inst = GetModuleHandleW(None).unwrap();
        let class = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: inst.into(),
            lpszClassName: w!("cast-win-pattern"),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            ..Default::default()
        };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            w!("cast-win-pattern"),
            w!("cast-win pattern"),
            WS_POPUP,
            left,
            top,
            w as i32,
            h as i32,
            None,
            None,
            Some(inst.into()),
            None,
        )
        .expect("CreateWindowExW");
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        // The frame, drawn in memory and copied to the window each tick.
        let mem = CreateCompatibleDC(None);
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bmp = CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0).unwrap();
        SelectObject(mem, bmp.into());
        let frame = std::slice::from_raw_parts_mut(bits.cast::<u32>(), w * h);
        // The source picture: a text page twice the monitor's height (scroll), or a picture twice its size (video).
        let src_w = w * 2;
        let src_h = h * 2;
        let mut page = vec![0u32; src_w * src_h];
        {
            let pdc = CreateCompatibleDC(None);
            let pbmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biWidth: src_w as i32,
                    biHeight: -(src_h as i32),
                    ..bmi.bmiHeader
                },
                ..Default::default()
            };
            let mut pbits = std::ptr::null_mut();
            let pbmp =
                CreateDIBSection(Some(pdc), &pbmi, DIB_RGB_COLORS, &mut pbits, None, 0).unwrap();
            SelectObject(pdc, pbmp.into());
            let px = std::slice::from_raw_parts_mut(pbits.cast::<u32>(), src_w * src_h);
            if mode == "video" {
                for y in 0..src_h {
                    for x in 0..src_w {
                        let fx = x as f32 / src_w as f32;
                        let fy = y as f32 / src_h as f32;
                        let r = (128.0 + 127.0 * (fx * 9.0 + fy * 3.0).sin()) as u32;
                        let g = (128.0 + 127.0 * (fy * 7.0 - fx * 2.0).cos()) as u32;
                        let b = (128.0 + 127.0 * ((fx + fy) * 13.0).sin()) as u32;
                        px[y * src_w + x] = (r << 16) | (g << 8) | b;
                    }
                }
            } else {
                px.fill(0x00ff_ffff);
                SetBkMode(pdc, TRANSPARENT);
                let font = CreateFontW(
                    (h / 60).max(14) as i32,
                    0,
                    0,
                    0,
                    FW_NORMAL.0 as i32,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET,
                    OUT_DEFAULT_PRECIS,
                    CLIP_DEFAULT_PRECIS,
                    CLEARTYPE_QUALITY,
                    FF_DONTCARE.0 as u32,
                    w!("Segoe UI"),
                );
                SelectObject(pdc, font.into());
                let line = (h / 60).max(14) as i32 + 6;
                let mut y = 10;
                let mut n = 0;
                while y < src_h as i32 {
                    let text = format!(
                        "{n:04}  The quick brown fox jumps over the lazy dog; remote access streams this page at sixty frames a second, text sharp once still."
                    );
                    let mut t: Vec<u16> = text.encode_utf16().collect();
                    let mut r = RECT {
                        left: 20,
                        top: y,
                        right: src_w as i32,
                        bottom: y + line,
                    };
                    SetTextColor(
                        pdc,
                        COLORREF(if n % 7 == 0 { 0x00a0_4010 } else { 0x0020_2020 }),
                    );
                    DrawTextW(pdc, &mut t, &mut r, DT_LEFT | DT_SINGLELINE | DT_NOPREFIX);
                    y += line;
                    n += 1;
                }
                let _ = DeleteObject(font.into());
            }
            page.copy_from_slice(px);
            let _ = DeleteDC(pdc);
            let _ = DeleteObject(pbmp.into());
        }
        let started = Instant::now();
        let interval = Duration::from_secs_f64(1.0 / fps);
        let mut next = Instant::now();
        let mut n: usize = 0;
        let mut seed: u32 = 0x1234_5678;
        let mut painted = false;
        while started.elapsed().as_secs_f64() < seconds {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let draw = match mode.as_str() {
                "still" => !painted || n.is_multiple_of(60),
                _ => true,
            };
            if draw {
                match mode.as_str() {
                    "scroll" => {
                        let off = (n * 8) % h;
                        for y in 0..h {
                            let s = (y + off) * src_w;
                            frame[y * w..y * w + w].copy_from_slice(&page[s..s + w]);
                        }
                    }
                    "video" => {
                        let t = n as f32 / 60.0;
                        let ox = ((t * 0.7).sin() * 0.5 + 0.5) * (src_w - w) as f32;
                        let oy = ((t * 0.5).cos() * 0.5 + 0.5) * (src_h - h) as f32;
                        let (ox, oy) = (ox as usize, oy as usize);
                        for y in 0..h {
                            let s = (y + oy) * src_w + ox;
                            frame[y * w..y * w + w].copy_from_slice(&page[s..s + w]);
                        }
                        let bx = ((t * 1.3).sin() * 0.5 + 0.5) * (w - w / 5) as f32;
                        let by = ((t * 1.7).cos() * 0.5 + 0.5) * (h - h / 5) as f32;
                        for y in by as usize..by as usize + h / 5 {
                            frame[y * w + bx as usize..y * w + bx as usize + w / 5]
                                .fill(0x00ff_d020);
                        }
                    }
                    "noise" => {
                        for p in frame.iter_mut() {
                            seed ^= seed << 13;
                            seed ^= seed >> 17;
                            seed ^= seed << 5;
                            *p = seed & 0x00ff_ffff;
                        }
                    }
                    _ => {
                        for y in 0..h {
                            frame[y * w..y * w + w]
                                .copy_from_slice(&page[y * src_w..y * src_w + w]);
                        }
                    }
                }
                let dc = GetDC(Some(hwnd));
                let _ = BitBlt(dc, 0, 0, w as i32, h as i32, Some(mem), 0, 0, SRCCOPY);
                ReleaseDC(Some(hwnd), dc);
                painted = true;
            }
            n += 1;
            next += interval;
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            } else {
                next = now;
            }
        }
        let _ = DestroyWindow(hwnd);
        let _ = DeleteDC(mem);
        let _ = DeleteObject(bmp.into());
        println!(
            "{}",
            serde_json::json!({"mode": mode, "frames": n, "seconds": started.elapsed().as_secs_f64()})
        );
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("cast-win-pattern runs on Windows");
}
