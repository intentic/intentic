//! The Windows clipboard both ways, as cast-core carries it: text (`CF_UNICODETEXT`), HTML (`HTML Format`, its
//! fragment) and an image (`PNG`, else a DIB made into one). A viewer's copy is put on the clipboard in order with the
//! keys around it, before the next event runs (a paste is the clipboard, then Ctrl+V); a copy made on the computer goes
//! to the viewers that may type, never echoing back what a viewer just put there (the clipboard's sequence number after
//! our own write is skipped, and so is content equal to what a viewer set). The DIB conversions are voxl's (MIT).

use crate::displays::wide;
use cast_core::clipboard::{ClipContent, MAX_IMAGE};
use cast_core::hub::Hub;
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::Graphics::Gdi::{BI_RGB, BITMAPINFOHEADER};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
};
use windows::core::PCWSTR;

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;

fn format(name: &str) -> u32 {
    let w = wide(name);
    // SAFETY: a zero-terminated name.
    unsafe { RegisterClipboardFormatW(PCWSTR(w.as_ptr())) }
}

/// The clipboard as one screen's viewers share it.
#[derive(Clone)]
pub struct Clipboard {
    shared: Arc<Shared>,
}

struct Shared {
    /// The sequence number our own last write left: that change is ours, not the computer's.
    own: AtomicU32,
    /// What a viewer set last: the same content read back is not sent out again.
    last_set: Mutex<Option<ClipContent>>,
    stop: AtomicBool,
}

impl Clipboard {
    /// Starts watching the clipboard for `hub`'s viewers (every 250 ms: the sequence number is one call).
    pub fn spawn(hub: Arc<Hub>) -> Result<Clipboard, String> {
        let shared = Arc::new(Shared {
            own: AtomicU32::new(0),
            last_set: Mutex::new(None),
            stop: AtomicBool::new(false),
        });
        let watch = shared.clone();
        std::thread::Builder::new()
            .name("clipboard".into())
            .spawn(move || watch_loop(&hub, &watch))
            .map_err(|e| e.to_string())?;
        Ok(Clipboard { shared })
    }

    /// Stops the watcher (a screen's last viewer left).
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }

    /// Puts a viewer's content on the clipboard, returning once it is there.
    pub fn set(&self, content: ClipContent) {
        if content.is_empty() {
            return;
        }
        let Some(_open) = Open::new(owner()) else {
            log::warn!("the clipboard is held by another program; a viewer's copy was dropped");
            return;
        };
        // SAFETY: the clipboard is open (and ours) until `_open` drops.
        unsafe {
            let _ = EmptyClipboard();
            if let Some(t) = &content.text {
                let w: Vec<u8> = wide(t).iter().flat_map(|u| u.to_le_bytes()).collect();
                put(CF_UNICODETEXT, &w);
            }
            if let Some(h) = &content.html {
                put(format("HTML Format"), &cf_html(h));
            }
            if let Some(png) = &content.png {
                put(format("PNG"), png);
                // Most programs read an image as a DIB.
                if let Some(dib) = png_to_dib(png) {
                    put(CF_DIB, &dib);
                }
            }
        }
        // SAFETY: a plain query.
        self.shared
            .own
            .store(unsafe { GetClipboardSequenceNumber() }, Ordering::Relaxed);
        *self.shared.last_set.lock() = Some(content);
    }
}

/// A message-only window to own the clipboard: with no owner, `SetClipboardData` may fail. One per thread that sets.
fn owner() -> Option<HWND> {
    thread_local! {
        static OWNER: Option<isize> = {
            // SAFETY: a message-only window of the built-in STATIC class, kept for the thread's life.
            unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    windows::core::w!("STATIC"),
                    windows::core::w!("cast-win clipboard"),
                    WINDOW_STYLE(0),
                    0, 0, 0, 0,
                    Some(HWND_MESSAGE),
                    None,
                    None,
                    None,
                )
            }
            .ok()
            .map(|h| h.0 as isize)
        };
    }
    OWNER.with(|o| o.map(|h| HWND(h as *mut _)))
}

/// The clipboard, open for as long as this lives. Another program may hold it a moment: opening retries briefly.
struct Open;

impl Open {
    fn new(owner: Option<HWND>) -> Option<Open> {
        for _ in 0..20 {
            // SAFETY: opens the clipboard for this thread, closed on drop.
            if unsafe { OpenClipboard(owner) }.is_ok() {
                return Some(Open);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        None
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        // SAFETY: the clipboard this struct opened.
        let _ = unsafe { CloseClipboard() };
    }
}

/// Puts `data` on the open clipboard as `format`; the clipboard owns the memory from then on.
unsafe fn put(format: u32, data: &[u8]) {
    // SAFETY (all of it): movable global memory of the data's size, filled, unlocked and handed over.
    unsafe {
        let Ok(mem) = GlobalAlloc(GMEM_MOVEABLE, data.len().max(1)) else {
            return;
        };
        let p = GlobalLock(mem) as *mut u8;
        if p.is_null() {
            return;
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), p, data.len());
        let _ = GlobalUnlock(mem);
        let _ = SetClipboardData(format, Some(HANDLE(mem.0)));
    }
}

/// The bytes of `format` on the open clipboard.
unsafe fn get(format: u32) -> Option<Vec<u8>> {
    // SAFETY (all of it): a handle the clipboard owns, locked for the copy and unlocked after.
    unsafe {
        let h = GetClipboardData(format).ok()?;
        let mem = HGLOBAL(h.0);
        let p = GlobalLock(mem) as *const u8;
        if p.is_null() {
            return None;
        }
        let v = std::slice::from_raw_parts(p, GlobalSize(mem)).to_vec();
        let _ = GlobalUnlock(mem);
        Some(v)
    }
}

/// What is on the clipboard now: its text, its HTML fragment, its image as a PNG.
fn read() -> Option<ClipContent> {
    let _open = Open::new(None)?;
    let has = |f: u32| unsafe { IsClipboardFormatAvailable(f) }.is_ok();
    let png_format = format("PNG");
    let html_format = format("HTML Format");
    // SAFETY: the clipboard is open until `_open` drops.
    let content = unsafe {
        let text = has(CF_UNICODETEXT)
            .then(|| get(CF_UNICODETEXT))
            .flatten()
            .map(|raw| {
                let units: Vec<u16> = raw
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                crate::displays::from_wide(&units)
            })
            .filter(|t| !t.is_empty());
        let html = has(html_format)
            .then(|| get(html_format))
            .flatten()
            .and_then(|raw| html_fragment(&raw));
        let png = if has(png_format) {
            get(png_format)
        } else if has(CF_DIBV5) {
            get(CF_DIBV5).and_then(|d| dib_to_png(&d))
        } else if has(CF_DIB) {
            get(CF_DIB).and_then(|d| dib_to_png(&d))
        } else {
            None
        }
        .filter(|p| !p.is_empty() && p.len() <= MAX_IMAGE);
        ClipContent { text, html, png }
    };
    (!content.is_empty()).then_some(content)
}

fn watch_loop(hub: &Hub, shared: &Shared) {
    // SAFETY: a plain query.
    let mut seen = unsafe { GetClipboardSequenceNumber() };
    while !shared.stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(250));
        // SAFETY: a plain query.
        let n = unsafe { GetClipboardSequenceNumber() };
        if n == seen {
            continue;
        }
        seen = n;
        if shared.own.load(Ordering::Relaxed) == n {
            continue;
        }
        let Some(content) = read() else {
            continue;
        };
        if shared.last_set.lock().as_ref() == Some(&content) {
            continue;
        }
        hub.clipboard_changed(&content);
    }
}

/// The fragment of `HTML Format` (CF_HTML: a header of byte offsets, then the document).
fn html_fragment(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw.split(|&b| b == 0).next()?);
    let offset = |name: &str| -> Option<usize> {
        text.lines()
            .find_map(|l| l.strip_prefix(name))
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|&v| v >= 0)
            .map(|v| v as usize)
    };
    let (a, b) = match (offset("StartFragment:"), offset("EndFragment:")) {
        (Some(a), Some(b)) => (a, b),
        _ => (offset("StartHTML:")?, offset("EndHTML:")?),
    };
    let bytes = raw.get(a..b.min(raw.len()))?;
    Some(String::from_utf8_lossy(bytes).into_owned()).filter(|h| !h.is_empty())
}

/// HTML as `HTML Format`: its header of byte offsets, then a document holding the fragment.
fn cf_html(fragment: &str) -> Vec<u8> {
    const HEADER: &str = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    let pre = "<html><body>\r\n<!--StartFragment-->";
    let post = "<!--EndFragment-->\r\n</body></html>";
    let start_html = HEADER.len();
    let start_fragment = start_html + pre.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + post.len();
    let header = format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n"
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(pre.as_bytes());
    out.extend_from_slice(fragment.as_bytes());
    out.extend_from_slice(post.as_bytes());
    out.push(0);
    out
}

/// A PNG as a bottom-up 32-bit DIB (BITMAPINFOHEADER and BGRA rows).
fn png_to_dib(png: &[u8]) -> Option<Vec<u8>> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(png));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut r = dec.read_info().ok()?;
    let mut buf = vec![0; r.output_buffer_size()?];
    let info = r.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width as usize, info.height as usize);
    let ch = match info.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Grayscale => 1,
        _ => return None,
    };
    let hdr = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w as i32,
        biHeight: h as i32,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: (w * h * 4) as u32,
        ..Default::default()
    };
    let mut out = Vec::with_capacity(40 + w * h * 4);
    // SAFETY: the header's bytes, as the DIB starts with them.
    out.extend_from_slice(unsafe {
        std::slice::from_raw_parts(
            (&hdr as *const BITMAPINFOHEADER).cast::<u8>(),
            std::mem::size_of_val(&hdr),
        )
    });
    for y in (0..h).rev() {
        for x in 0..w {
            let p = &buf[(y * w + x) * ch..][..ch];
            let (r, g, b, a) = match ch {
                4 => (p[0], p[1], p[2], p[3]),
                3 => (p[0], p[1], p[2], 255),
                2 => (p[0], p[0], p[0], p[1]),
                _ => (p[0], p[0], p[0], 255),
            };
            out.extend_from_slice(&[b, g, r, a]);
        }
    }
    Some(out)
}

/// RGBA pixels as a PNG.
fn encode_png(w: usize, h: usize, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    enc.write_header().ok()?.write_image_data(rgba).ok()?;
    Some(out)
}

/// A clipboard DIB (24 or 32 bits a pixel, uncompressed or bit fields; a V5 header too) as a PNG.
fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
    let le32 = |o: usize| Some(u32::from_le_bytes(dib.get(o..o + 4)?.try_into().ok()?));
    let size = le32(0)? as usize;
    let w = le32(4)? as i32;
    let h = le32(8)? as i32;
    let bpp = u16::from_le_bytes(dib.get(14..16)?.try_into().ok()?);
    let comp = le32(16)?;
    let colors = le32(32)? as usize;
    if w <= 0 || h == 0 || !(bpp == 24 || bpp == 32) || !(comp == 0 || comp == 3) {
        return None;
    }
    let (w, top_down, h) = (w as usize, h < 0, h.unsigned_abs() as usize);
    if w * h > 64 << 20 {
        return None;
    }
    // Bit-field masks follow a plain BITMAPINFOHEADER; palettes are unused at 24/32 bpp.
    let mut off = size + colors * 4;
    if comp == 3 && size == 40 {
        off += 12;
    }
    let stride = (w * bpp as usize / 8).div_ceil(4) * 4;
    let px = dib.get(off..off + stride * h)?;
    let mut rgba = vec![0u8; w * h * 4];
    let mut any_alpha = false;
    for y in 0..h {
        let src = &px[(if top_down { y } else { h - 1 - y }) * stride..];
        for x in 0..w {
            let s = &src[x * bpp as usize / 8..];
            let a = if bpp == 32 { s[3] } else { 255 };
            any_alpha |= bpp == 32 && a != 0;
            rgba[(y * w + x) * 4..][..4].copy_from_slice(&[s[2], s[1], s[0], a]);
        }
    }
    // Most 32-bit DIBs leave alpha at zero: they are opaque.
    if bpp == 32 && !any_alpha {
        for p in rgba.as_chunks_mut::<4>().0 {
            p[3] = 255;
        }
    }
    encode_png(w, h, &rgba)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_goes_out_and_comes_back_as_its_fragment() {
        let raw = cf_html("<b>żółw</b> & co");
        assert_eq!(html_fragment(&raw).as_deref(), Some("<b>żółw</b> & co"));
        let head = String::from_utf8_lossy(&raw[..120]).to_string();
        assert!(
            head.starts_with("Version:0.9\r\nStartHTML:0000000105"),
            "{head}"
        );
    }

    #[test]
    fn an_image_survives_the_dib_round_trip() {
        let rgba = [
            255u8, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 255,
        ];
        let png = encode_png(2, 2, &rgba).unwrap();
        let dib = png_to_dib(&png).unwrap();
        let back = dib_to_png(&dib).unwrap();
        let mut dec = png::Decoder::new(std::io::Cursor::new(back))
            .read_info()
            .unwrap();
        let mut buf = vec![0; dec.output_buffer_size().unwrap()];
        dec.next_frame(&mut buf).unwrap();
        assert_eq!(buf, rgba);
    }
}
