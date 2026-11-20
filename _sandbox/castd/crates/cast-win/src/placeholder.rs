//! The picture a viewer sees while the desktop cannot be captured (the secure desktop of a lock screen, a UAC prompt
//! or Ctrl+Alt+Del, until a service running as SYSTEM captures it): a dark screen saying so, drawn with GDI, rather
//! than the last picture frozen as if it were live.

use crate::displays::wide;
use windows::Win32::Foundation::{COLORREF, RECT};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS,
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CENTER,
    DT_NOPREFIX, DT_VCENTER, DT_WORDBREAK, DeleteDC, DeleteObject, DrawTextW, FF_DONTCARE,
    FW_NORMAL, OUT_DEFAULT_PRECIS, SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
};

/// A `w` x `h` BGRA picture: a dark grey screen with `text` in its middle.
pub fn render(w: u32, h: u32, text: &str) -> Vec<u8> {
    let mut px = vec![0u8; w as usize * h as usize * 4];
    for p in px.as_chunks_mut::<4>().0 {
        p.copy_from_slice(&[0x26, 0x22, 0x20, 0xff]);
    }
    // SAFETY: a memory DC and a top-down DIB section of this size, freed below; the text is a zero-terminated buffer.
    unsafe {
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return px;
        }
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
        let Ok(bmp) = CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) else {
            let _ = DeleteDC(dc);
            return px;
        };
        let old = SelectObject(dc, bmp.into());
        std::ptr::copy_nonoverlapping(px.as_ptr(), bits.cast::<u8>(), px.len());
        let size = (h / 28).clamp(14, 64) as i32;
        let face = wide("Segoe UI");
        let font = CreateFontW(
            size,
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
            windows::core::PCWSTR(face.as_ptr()),
        );
        let old_font = SelectObject(dc, font.into());
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, COLORREF(0x00d8_d8d8));
        let mut words: Vec<u16> = text.encode_utf16().collect();
        let mut r = RECT {
            left: (w / 10) as i32,
            top: 0,
            right: (w - w / 10) as i32,
            bottom: h as i32,
        };
        // One line in the middle; a narrow screen wraps it (DT_VCENTER centres single lines only, so a wrapped text sits
        // at the top third, which reads as well).
        let flags = if (text.len() as i32) * size / 2 < r.right - r.left {
            DT_CENTER | DT_VCENTER | windows::Win32::Graphics::Gdi::DT_SINGLELINE | DT_NOPREFIX
        } else {
            r.top = (h / 3) as i32;
            DT_CENTER | DT_WORDBREAK | DT_NOPREFIX
        };
        DrawTextW(dc, &mut words, &mut r, flags);
        std::ptr::copy_nonoverlapping(bits.cast::<u8>(), px.as_mut_ptr(), px.len());
        SelectObject(dc, old_font);
        SelectObject(dc, old);
        let _ = DeleteObject(font.into());
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(dc);
    }
    // GDI leaves alpha at zero where it drew; the picture is opaque.
    for p in px.as_chunks_mut::<4>().0 {
        p[3] = 0xff;
    }
    px
}
