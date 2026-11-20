//! What a clipboard holds, as the platform's clipboard and the wire both carry it. A viewer's `clipboard` reaches the
//! platform as `InputEvent::Clipboard`, in order with the keys around it (a paste is the clipboard, then Ctrl+V); a
//! copy made on the screen comes back through `Hub::clipboard_changed`.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use browser_wire::{ClipboardContent, MediaCursor};

/// Largest image moved through the clipboard (X requests are capped near 16 MiB, and a media socket's largest message
/// is 24 MiB of base64).
pub const MAX_IMAGE: usize = 15 << 20;

/// What a clipboard holds, any part absent; the PNG as bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClipContent {
    pub text: Option<String>,
    pub html: Option<String>,
    pub png: Option<Vec<u8>>,
}

impl ClipContent {
    /// From the wire, dropping a PNG that is not base64 or is too large to move.
    pub fn from_wire(c: ClipboardContent) -> ClipContent {
        ClipContent {
            text: c.text,
            html: c.html,
            png: c
                .png
                .and_then(|b| STANDARD.decode(b.as_bytes()).ok())
                .filter(|p| !p.is_empty() && p.len() <= MAX_IMAGE),
        }
    }

    pub fn to_wire(&self) -> ClipboardContent {
        ClipboardContent {
            text: self.text.clone(),
            html: self.html.clone(),
            png: self.png.as_ref().map(|p| STANDARD.encode(p)),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_none() && self.html.is_none() && self.png.is_none()
    }
}

/// A pointer shape as viewers draw it: straight (not premultiplied) RGBA, `w` x `h`, its hotspot, and the CSS keyword
/// for it where the platform's name is a standard one. Hand the result to `Hub::set_cursor`.
pub fn cursor(w: u32, h: u32, rgba: &[u8], hot: (u32, u32), css: Option<&str>) -> MediaCursor {
    let png = (w > 0 && h > 0).then(|| encode_png(w, h, rgba)).flatten();
    MediaCursor {
        css: css.map(str::to_string),
        png: png.map(|p| STANDARD.encode(p)),
        hot_x: Some(hot.0),
        hot_y: Some(hot.1),
    }
}

fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().ok()?.write_image_data(rgba).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wire_png_that_is_not_base64_is_dropped() {
        let c = ClipContent::from_wire(ClipboardContent {
            text: Some("t".into()),
            html: None,
            png: Some("***".into()),
        });
        assert_eq!(c.png, None);
        assert_eq!(c.text.as_deref(), Some("t"));
        let round = ClipContent {
            png: Some(vec![1, 2, 3]),
            ..Default::default()
        };
        assert_eq!(ClipContent::from_wire(round.to_wire()), round);
    }

    #[test]
    fn a_cursor_is_a_png_with_its_hotspot() {
        let c = cursor(2, 1, &[255, 0, 0, 255, 0, 0, 0, 0], (1, 0), Some("default"));
        assert_eq!(
            (c.hot_x, c.hot_y, c.css.as_deref()),
            (Some(1), Some(0), Some("default"))
        );
        let png = STANDARD.decode(c.png.unwrap()).unwrap();
        assert_eq!(&png[1..4], b"PNG");
        // An empty image has no picture, only its keyword.
        assert_eq!(cursor(0, 0, &[], (0, 0), Some("none")).png, None);
    }
}
