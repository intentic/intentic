//! A terminal socket's pane bytes, deflated for a browser that asked with `?deflate=1` (`TerminalServerMessage::Deflate`
//! says so on the socket before the first). Terminal output is text that repeats itself, a prompt, a progress bar, a
//! build log, and the redraws of a TUI more so: one raw deflate stream (RFC 1951) per socket keeps every earlier message
//! as the dictionary of the next, so a 200-byte chunk of output leaves at a fifth of its size where deflating it alone
//! would leave three quarters. Each message ends in a sync flush, so it decodes whole the moment it arrives, and carries
//! its unpacked length in front (4 bytes, big-endian) so the browser can hand each message to the terminal whole and in
//! order with the text messages between them. tungstenite has no permessage-deflate, and the editor's WebTransport carrier
//! speaks its own WebSocket, so this is done in the terminal's own protocol, the same on both.

use flate2::{Compress, Compression, FlushCompress};

// zlib's default: a few microseconds a frame here, against bytes saved on whatever link the browser is on.
const LEVEL: u32 = 6;

/// Whether the browser asked for deflated pane bytes: `deflate=1` in the socket's query. An older editor never asks.
pub fn asked(query: &str) -> bool {
    query.split('&').any(|pair| pair == "deflate=1")
}

/// One socket's deflate stream.
pub struct Deflater {
    compress: Compress,
}

impl Deflater {
    pub fn new() -> Self {
        Self {
            compress: Compress::new(Compression::new(LEVEL), false),
        }
    }

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

    // The browser's side: one inflate stream for the socket, each message's bytes after its length fed in turn.
    fn inflate(stream: &mut Decompress, message: &[u8]) -> Vec<u8> {
        let length = u32::from_be_bytes(message[..4].try_into().unwrap()) as usize;
        let mut out = Vec::with_capacity(length);
        stream
            .decompress_vec(&message[4..], &mut out, FlushDecompress::Sync)
            .unwrap();
        out
    }

    #[test]
    fn only_a_socket_that_asked_is_deflated() {
        assert!(asked("ticket=t&cols=80&rows=24&deflate=1"));
        assert!(asked("deflate=1"));
        assert!(!asked("ticket=t&cols=80&rows=24"));
        assert!(!asked("deflate=0&undeflate=1"));
    }

    #[test]
    fn every_message_decodes_whole_on_arrival_and_each_shrinks_with_the_last_as_its_dictionary() {
        let mut deflater = Deflater::new();
        let mut inflater = Decompress::new(false);
        let prompt =
            b"\x1b[1;32mradarsu@sandbox\x1b[0m:\x1b[1;34m~/work/intentic\x1b[0m$ ls -la\r\n";
        let first = deflater.message(prompt);
        let second = deflater.message(prompt);
        assert_eq!(inflate(&mut inflater, &first), prompt);
        assert_eq!(inflate(&mut inflater, &second), prompt);
        // The second is mostly a reference back into the first.
        assert!(
            second.len() < first.len() / 2,
            "{} then {}",
            first.len(),
            second.len()
        );
    }

    #[test]
    fn a_frame_larger_than_any_first_guess_at_its_size_still_ends_in_one_flush() {
        let mut deflater = Deflater::new();
        let mut inflater = Decompress::new(false);
        // Incompressible bytes: deflate's output outgrows the half-size room it starts with.
        let mut noise = vec![0u8; 256 * 1024];
        let mut seed = 0x2545_f491_u32;
        for byte in &mut noise {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *byte = seed as u8;
        }
        let message = deflater.message(&noise);
        assert_eq!(inflate(&mut inflater, &message), noise);
        // And the stream goes on from there.
        assert_eq!(
            inflate(&mut inflater, &deflater.message(b"after")),
            b"after"
        );
    }
}
