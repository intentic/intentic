//! A terminal socket's pane bytes deflated for a viewer that asked with `?deflate=1`, exactly as netd sends them
//! (browser-wire's `TerminalServerMessage::Deflate`): each binary message is its unpacked length (4 bytes, big-endian)
//! then raw deflate (RFC 1951) through a sync flush, one deflate stream per socket, so each message decodes whole on
//! arrival with every earlier one as its dictionary. Mirrors `_sandbox/netd/crates/netd/src/term/deflate.rs`, which is a
//! binary crate's module and cannot be depended on.

use flate2::{Compress, Compression, FlushCompress};

const LEVEL: u32 = 6;

/// Whether the viewer asked for deflated pane bytes.
pub fn asked(query: &str) -> bool {
    query.split('&').any(|pair| pair == "deflate=1")
}

pub struct Deflater {
    compress: Compress,
}

impl Default for Deflater {
    fn default() -> Self {
        Self {
            compress: Compress::new(Compression::new(LEVEL), false),
        }
    }
}

impl Deflater {
    /// `raw` as one binary message: its length, then its deflated bytes through a sync flush.
    pub fn message(&mut self, raw: &[u8]) -> Vec<u8> {
        let length = u32::try_from(raw.len()).expect("a terminal frame is far under 4 GiB");
        let mut out = Vec::with_capacity(4 + raw.len() / 2 + 64);
        out.extend_from_slice(&length.to_be_bytes());
        let mut consumed = 0;
        loop {
            out.reserve(raw.len().saturating_sub(consumed).max(64));
            let before = self.compress.total_in();
            self.compress
                .compress_vec(&raw[consumed..], &mut out, FlushCompress::Sync)
                .expect("deflating into a growable buffer never fails");
            consumed +=
                usize::try_from(self.compress.total_in() - before).expect("a frame's length fits");
            // zlib's rule: the flush is complete once all input is in and deflate left room it did not use.
            if consumed == raw.len() && out.len() < out.capacity() {
                break;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Decompress, FlushDecompress};

    fn inflate(stream: &mut Decompress, message: &[u8]) -> Vec<u8> {
        let length = u32::from_be_bytes(message[..4].try_into().unwrap()) as usize;
        let mut out = Vec::with_capacity(length);
        stream
            .decompress_vec(&message[4..], &mut out, FlushDecompress::Sync)
            .unwrap();
        out
    }

    #[test]
    fn every_message_decodes_whole_on_arrival_and_large_ones_still_end_in_one_flush() {
        let mut deflater = Deflater::default();
        let mut inflater = Decompress::new(false);
        let prompt = b"PS C:\\Users\\radar> dir\r\n";
        let first = deflater.message(prompt);
        let second = deflater.message(prompt);
        assert_eq!(inflate(&mut inflater, &first), prompt);
        assert_eq!(inflate(&mut inflater, &second), prompt);
        assert!(second.len() < first.len());
        let mut noise = vec![0_u8; 256 * 1024];
        let mut seed = 0x2545_f491_u32;
        for byte in &mut noise {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *byte = seed as u8;
        }
        assert_eq!(inflate(&mut inflater, &deflater.message(&noise)), noise);
        assert!(asked("token=x&deflate=1"));
        assert!(!asked("deflate=0"));
    }
}
