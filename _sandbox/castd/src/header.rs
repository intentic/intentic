//! The fixed header every binary message on a media socket starts with, as browser-wire defines it
//! ([`browser_wire::MEDIA_HEADER_LEN`] and the layout in its doc comment): kind, flags, frame id, capture time since the
//! viewer's `hello`, and where the stripe sits.

use browser_wire::{MEDIA_FLAGS, MEDIA_HEADER_LEN, MEDIA_KINDS};

pub const LEN: usize = MEDIA_HEADER_LEN;

const fn named(table: &[(&str, u8)], name: &str) -> u8 {
    let mut i = 0;
    while i < table.len() {
        if const_eq(table[i].0, name) {
            return table[i].1;
        }
        i += 1;
    }
    panic!("a media constant browser-wire does not define");
}

const fn const_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

pub const KIND_VIDEO: u8 = named(&MEDIA_KINDS, "video");
pub const KIND_AUDIO: u8 = named(&MEDIA_KINDS, "audio");
pub const FLAG_KEY: u8 = named(&MEDIA_FLAGS, "key");
pub const FLAG_REFINE: u8 = named(&MEDIA_FLAGS, "refine");

/// One message's header fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Header {
    pub kind: u8,
    pub flags: u8,
    /// Video only: what `ack` names. Zero on audio.
    pub id: u32,
    /// When the content was captured, in milliseconds since this viewer's latest `hello`.
    pub capture_ms: u32,
    /// The stripe's top row in picture pixels; zero on audio.
    pub stripe_top: u16,
    pub stripe_index: u8,
    /// How many stripes the picture is cut into, 1 when whole; zero on audio, which is no picture.
    pub stripe_count: u8,
}

impl Header {
    pub fn write(&self, out: &mut [u8]) {
        out[0] = self.kind;
        out[1] = self.flags;
        out[2..6].copy_from_slice(&self.id.to_be_bytes());
        out[6..10].copy_from_slice(&self.capture_ms.to_be_bytes());
        out[10..12].copy_from_slice(&self.stripe_top.to_be_bytes());
        out[12] = self.stripe_index;
        out[13] = self.stripe_count;
        out[14] = 0;
        out[15] = 0;
    }

    /// The header and the payload after it, as one message.
    pub fn message(&self, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; LEN + payload.len()];
        self.write(&mut out[..LEN]);
        out[LEN..].copy_from_slice(payload);
        out
    }

    /// Reads a header back; None for a message shorter than one.
    pub fn read(b: &[u8]) -> Option<Header> {
        if b.len() < LEN {
            return None;
        }
        Some(Header {
            kind: b[0],
            flags: b[1],
            id: u32::from_be_bytes([b[2], b[3], b[4], b[5]]),
            capture_ms: u32::from_be_bytes([b[6], b[7], b[8], b[9]]),
            stripe_top: u16::from_be_bytes([b[10], b[11]]),
            stripe_index: b[12],
            stripe_count: b[13],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_header_is_browser_wires_layout() {
        assert_eq!(LEN, 16);
        let h = Header {
            kind: KIND_VIDEO,
            flags: FLAG_KEY | FLAG_REFINE,
            id: 0x0102_0304,
            capture_ms: 0x0a0b_0c0d,
            stripe_top: 0x0320,
            stripe_index: 2,
            stripe_count: 4,
        };
        let msg = h.message(&[0xaa, 0xbb]);
        assert_eq!(
            msg,
            [
                KIND_VIDEO,
                FLAG_KEY | FLAG_REFINE,
                1,
                2,
                3,
                4,
                0x0a,
                0x0b,
                0x0c,
                0x0d,
                0x03,
                0x20,
                2,
                4,
                0,
                0,
                0xaa,
                0xbb
            ]
        );
        assert_eq!(Header::read(&msg), Some(h));
        assert_eq!(Header::read(&msg[..15]), None);
    }

    #[test]
    fn kinds_and_flags_come_from_browser_wire() {
        let kinds: std::collections::HashMap<_, _> = MEDIA_KINDS.into_iter().collect();
        let flags: std::collections::HashMap<_, _> = MEDIA_FLAGS.into_iter().collect();
        assert_eq!(KIND_VIDEO, kinds["video"]);
        assert_eq!(KIND_AUDIO, kinds["audio"]);
        assert_eq!(FLAG_KEY, flags["key"]);
        assert_eq!(FLAG_REFINE, flags["refine"]);
        assert_eq!(FLAG_KEY & FLAG_REFINE, 0);
    }
}
