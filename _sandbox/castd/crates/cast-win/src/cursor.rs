//! The pointer's shape as viewers draw it. Desktop duplication leaves the pointer out of the picture and hands its
//! shape over separately, in one of three forms, each turned here into straight RGBA for a PNG:
//!
//! - **Colour**: 32-bit BGRA with straight alpha; only the channels' order changes.
//! - **Monochrome**: two 1-bit masks stacked (AND above XOR). AND 0 paints XOR's black or white; AND 1 with XOR 0 is
//!   transparent; AND 1 with XOR 1 inverts what is under it, which a browser cannot draw, so it is drawn black with a
//!   white rim one pixel wide (the I-beam over text, a resize arrow), visible on any background.
//! - **Masked colour**: BGRA whose alpha byte is a mask: 0 paints the colour, 0xFF XORs it onto the screen (nothing
//!   where the colour is black, an inversion otherwise, drawn as above).
//!
//! A standard system cursor also gets its CSS keyword, so a viewer may draw its own at its own resolution.

use browser_wire::MediaCursor;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Dxgi::DXGI_OUTDUPL_POINTER_SHAPE_INFO;
use windows::Win32::UI::WindowsAndMessaging::{
    CURSORINFO, GetCursorInfo, HCURSOR, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP,
    IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_WAIT,
    LoadCursorW,
};
use windows::core::PCWSTR;

const MONOCHROME: u32 = 1;
const COLOR: u32 = 2;
const MASKED_COLOR: u32 = 4;

/// A pointer shape in straight RGBA, with its hotspot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shape {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub hot: (u32, u32),
}

/// Converts the shape `GetFramePointerShape` filled `buf` with.
pub fn convert(info: &DXGI_OUTDUPL_POINTER_SHAPE_INFO, buf: &[u8]) -> Option<Shape> {
    let (w, pitch) = (info.Width as usize, info.Pitch as usize);
    let hot = (info.HotSpot.x.max(0) as u32, info.HotSpot.y.max(0) as u32);
    match info.Type {
        COLOR => {
            let h = info.Height as usize;
            let mut rgba = vec![0u8; w * h * 4];
            for y in 0..h {
                let row = buf.get(y * pitch..y * pitch + w * 4)?;
                for (x, px) in row.as_chunks::<4>().0.iter().enumerate() {
                    rgba[(y * w + x) * 4..][..4].copy_from_slice(&[px[2], px[1], px[0], px[3]]);
                }
            }
            Some(shape(w, h, rgba, hot))
        }
        MONOCHROME => {
            let h = info.Height as usize / 2;
            let bit = |plane: usize, x: usize, y: usize| -> Option<bool> {
                let byte = buf.get((plane * h + y) * pitch + x / 8)?;
                Some(byte & (0x80 >> (x % 8)) != 0)
            };
            let mut px = vec![Px::Clear; w * h];
            for y in 0..h {
                for x in 0..w {
                    px[y * w + x] = match (bit(0, x, y)?, bit(1, x, y)?) {
                        (false, false) => Px::Solid([0, 0, 0]),
                        (false, true) => Px::Solid([255, 255, 255]),
                        (true, false) => Px::Clear,
                        (true, true) => Px::Invert,
                    };
                }
            }
            Some(shape(w, h, paint(&px, w, h), hot))
        }
        MASKED_COLOR => {
            let h = info.Height as usize;
            let mut px = vec![Px::Clear; w * h];
            for y in 0..h {
                let row = buf.get(y * pitch..y * pitch + w * 4)?;
                for (x, p) in row.as_chunks::<4>().0.iter().enumerate() {
                    px[y * w + x] = match (p[3], [p[2], p[1], p[0]]) {
                        (0, rgb) => Px::Solid(rgb),
                        (_, [0, 0, 0]) => Px::Clear,
                        _ => Px::Invert,
                    };
                }
            }
            Some(shape(w, h, paint(&px, w, h), hot))
        }
        _ => None,
    }
}

fn shape(w: usize, h: usize, rgba: Vec<u8>, hot: (u32, u32)) -> Shape {
    Shape {
        width: w as u32,
        height: h as u32,
        rgba,
        hot: (
            hot.0.min(w.saturating_sub(1) as u32),
            hot.1.min(h.saturating_sub(1) as u32),
        ),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Px {
    Clear,
    Solid([u8; 3]),
    /// Inverts the screen under it: drawn black, rimmed in white.
    Invert,
}

fn paint(px: &[Px], w: usize, h: usize) -> Vec<u8> {
    let mut rgba = vec![0u8; w * h * 4];
    for (i, p) in px.iter().enumerate() {
        let out = &mut rgba[i * 4..i * 4 + 4];
        match p {
            Px::Solid([r, g, b]) => out.copy_from_slice(&[*r, *g, *b, 255]),
            Px::Invert => out.copy_from_slice(&[0, 0, 0, 255]),
            Px::Clear => {}
        }
    }
    // The white rim: every clear pixel touching an inverting one.
    for y in 0..h {
        for x in 0..w {
            if px[y * w + x] != Px::Clear {
                continue;
            }
            let touches = (y.saturating_sub(1)..(y + 2).min(h)).any(|ny| {
                (x.saturating_sub(1)..(x + 2).min(w)).any(|nx| px[ny * w + nx] == Px::Invert)
            });
            if touches {
                rgba[(y * w + x) * 4..][..4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
    }
    rgba
}

/// The cursor message for a shape, with the CSS keyword of the standard cursor showing now, if it is one.
pub fn message(s: &Shape, css: Option<&str>) -> MediaCursor {
    cast_core::clipboard::cursor(s.width, s.height, &s.rgba, s.hot, css)
}

/// The cursor message for a pointer that is not showing on this monitor (hidden while typing, or on another monitor).
pub fn hidden() -> MediaCursor {
    MediaCursor {
        css: Some("none".into()),
        png: None,
        hot_x: None,
        hot_y: None,
    }
}

/// The CSS keyword of the system cursor showing now, where it is a standard one.
pub fn css_now() -> Option<&'static str> {
    let mut ci = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: a sized struct to fill.
    unsafe { GetCursorInfo(&mut ci) }.ok()?;
    let table: [(PCWSTR, &str); 13] = [
        (IDC_ARROW, "default"),
        (IDC_IBEAM, "text"),
        (IDC_WAIT, "wait"),
        (IDC_APPSTARTING, "progress"),
        (IDC_CROSS, "crosshair"),
        (IDC_HAND, "pointer"),
        (IDC_HELP, "help"),
        (IDC_NO, "not-allowed"),
        (IDC_SIZEALL, "move"),
        (IDC_SIZENS, "ns-resize"),
        (IDC_SIZEWE, "ew-resize"),
        (IDC_SIZENWSE, "nwse-resize"),
        (IDC_SIZENESW, "nesw-resize"),
    ];
    table.iter().find_map(|(id, css)| {
        // SAFETY: a shared system cursor, never destroyed.
        let h: HCURSOR = unsafe { LoadCursorW(None, *id) }.ok()?;
        (h == ci.hCursor).then_some(*css)
    })
}

/// Where the pointer is on this monitor (picture pixels) and whether it shows there, from the duplication's frame info.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Pointer {
    pub visible: bool,
    pub x: i32,
    pub y: i32,
}

impl Pointer {
    pub fn from(visible: bool, at: POINT) -> Pointer {
        Pointer {
            visible,
            x: at.x,
            y: at.y,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(kind: u32, w: u32, h: u32, pitch: u32) -> DXGI_OUTDUPL_POINTER_SHAPE_INFO {
        DXGI_OUTDUPL_POINTER_SHAPE_INFO {
            Type: kind,
            Width: w,
            Height: h,
            Pitch: pitch,
            HotSpot: POINT { x: 1, y: 0 },
        }
    }

    #[test]
    fn colour_is_reordered_to_rgba() {
        let s = convert(&info(COLOR, 1, 1, 4), &[10, 20, 30, 40]).unwrap();
        assert_eq!(s.rgba, [30, 20, 10, 40]);
        assert_eq!(s.hot, (0, 0), "the hotspot is held inside the shape");
    }

    #[test]
    fn monochrome_masks_paint_black_white_clear_and_rimmed_inversion() {
        // 4x1: AND row then XOR row, one byte each. Pixels: black, white, clear, invert.
        let and = 0b0011_0000u8;
        let xor = 0b0101_0000u8;
        let s = convert(&info(MONOCHROME, 4, 2, 1), &[and, xor]).unwrap();
        assert_eq!((s.width, s.height), (4, 1));
        assert_eq!(&s.rgba[0..4], &[0, 0, 0, 255]);
        assert_eq!(&s.rgba[4..8], &[255, 255, 255, 255]);
        // The clear pixel touches the inverting one: it becomes the white rim.
        assert_eq!(&s.rgba[8..12], &[255, 255, 255, 255]);
        assert_eq!(&s.rgba[12..16], &[0, 0, 0, 255]);
    }

    #[test]
    fn masked_colour_xor_of_black_is_clear() {
        let px = [
            [0, 0, 255, 0],        // paint red
            [0, 0, 0, 0xff],       // XOR black: nothing
            [0, 0, 0, 0xff],       // XOR black: nothing (rim? no inversion beside it)
            [255, 255, 255, 0xff], // XOR white: inversion
        ];
        let buf: Vec<u8> = px.iter().flatten().copied().collect();
        let s = convert(&info(MASKED_COLOR, 4, 1, 16), &buf).unwrap();
        assert_eq!(&s.rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&s.rgba[4..8], &[0, 0, 0, 0]);
        assert_eq!(&s.rgba[8..12], &[255, 255, 255, 255]);
        assert_eq!(&s.rgba[12..16], &[0, 0, 0, 255]);
    }
}
