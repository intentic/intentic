//! A media message cut to fit a DataChannel message (browser-wire's `RTC_MESSAGE_MAX`): each chunk is the message's
//! 16-byte header with byte 14 the chunk's index and byte 15 their count, then the next slice of its payload. A message
//! that fits goes whole, its reserved bytes zero as on the socket. The viewer joins the chunks in order on the ordered
//! `media` channel; nothing else changes for its decoder.
//!
//! The viewer's own messages longer than the cap arrive the other way round, as binary chunks on `input`: one byte of
//! index, one of count, then the next slice of the JSON's UTF-8 ([`TextJoiner`]).

use browser_wire::{MEDIA_HEADER_LEN, RTC_MESSAGE_MAX};

/// `message` (a header and its payload) as the DataChannel messages that carry it. None for one too long to cut into
/// 255 chunks, or too short to have a header.
pub fn media_chunks(message: &[u8]) -> Option<Vec<Vec<u8>>> {
    if message.len() < MEDIA_HEADER_LEN {
        return None;
    }
    if message.len() <= RTC_MESSAGE_MAX {
        return Some(vec![message.to_vec()]);
    }
    let (header, payload) = message.split_at(MEDIA_HEADER_LEN);
    let slice = RTC_MESSAGE_MAX - MEDIA_HEADER_LEN;
    let count = payload.len().div_ceil(slice);
    let count = u8::try_from(count).ok()?;
    Some(
        payload
            .chunks(slice)
            .enumerate()
            .map(|(index, part)| {
                let mut chunk = Vec::with_capacity(MEDIA_HEADER_LEN + part.len());
                chunk.extend_from_slice(header);
                chunk[14] = index as u8;
                chunk[15] = count;
                chunk.extend_from_slice(part);
                chunk
            })
            .collect(),
    )
}

/// Joins the viewer's chunked JSON messages: binary messages on `input` of `[index][count]` and a slice of UTF-8.
#[derive(Default)]
pub struct TextJoiner {
    parts: Vec<u8>,
    next: u8,
}

impl TextJoiner {
    /// The whole text once its last chunk arrived. A chunk out of turn drops what was gathered, and so does a text that
    /// is not UTF-8: the channel is ordered and reliable, so either is a viewer's bug, and the next text starts afresh.
    pub fn push(&mut self, chunk: &[u8]) -> Option<String> {
        let (&[index, count], part) = chunk.split_first_chunk::<2>()?;
        if index != self.next || count == 0 || index >= count {
            self.parts.clear();
            self.next = 0;
            if index != 0 || count == 0 {
                return None;
            }
        }
        self.parts.extend_from_slice(part);
        self.next = index + 1;
        if self.next < count {
            return None;
        }
        self.next = 0;
        String::from_utf8(std::mem::take(&mut self.parts)).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(payload_len: usize) -> Vec<u8> {
        let mut m = vec![1u8, 1, 0, 0, 0, 9, 0, 0, 0, 5, 0, 0, 0, 1, 0, 0];
        m.extend((0..payload_len).map(|i| (i % 251) as u8));
        m
    }

    #[test]
    fn a_message_that_fits_goes_whole() {
        let m = message(RTC_MESSAGE_MAX - MEDIA_HEADER_LEN);
        assert_eq!(media_chunks(&m), Some(vec![m.clone()]));
    }

    #[test]
    fn a_longer_one_is_cut_behind_its_own_header_and_joins_back_whole() {
        let slice = RTC_MESSAGE_MAX - MEDIA_HEADER_LEN;
        let m = message(2 * slice + 1);
        let chunks = media_chunks(&m).unwrap();
        assert_eq!(chunks.len(), 3);
        assert_eq!(
            chunks.iter().map(Vec::len).collect::<Vec<_>>(),
            [RTC_MESSAGE_MAX, RTC_MESSAGE_MAX, MEDIA_HEADER_LEN + 1]
        );
        for (index, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk[..14], m[..14]);
            assert_eq!((chunk[14], chunk[15]), (index as u8, 3));
        }
        let joined: Vec<u8> = chunks
            .iter()
            .flat_map(|c| c[MEDIA_HEADER_LEN..].to_vec())
            .collect();
        assert_eq!(joined, m[MEDIA_HEADER_LEN..]);
    }

    #[test]
    fn past_255_chunks_or_short_of_a_header_it_is_not_sent() {
        let slice = RTC_MESSAGE_MAX - MEDIA_HEADER_LEN;
        assert!(media_chunks(&message(255 * slice)).is_some());
        assert_eq!(media_chunks(&message(255 * slice + 1)), None);
        assert_eq!(media_chunks(&[1, 2, 3]), None);
    }

    #[test]
    fn the_viewers_long_text_joins_in_order_and_a_chunk_out_of_turn_starts_over() {
        let mut joiner = TextJoiner::default();
        assert_eq!(joiner.push(&[0, 2, b'{', b'"']), None);
        assert_eq!(
            joiner.push(&[1, 2, b'a', b'"', b'}']),
            Some("{\"a\"}".into())
        );
        assert_eq!(joiner.push(&[0, 1, b'x']), Some("x".into()));
        // Index 1 of 3 with nothing before it: dropped; a fresh first chunk starts again.
        assert_eq!(joiner.push(&[1, 3, b'y']), None);
        assert_eq!(joiner.push(&[0, 2, b'a']), None);
        assert_eq!(joiner.push(&[0, 2, b'b']), None);
        assert_eq!(joiner.push(&[1, 2, b'c']), Some("bc".into()));
        assert_eq!(joiner.push(&[0, 0]), None);
        assert_eq!(joiner.push(&[5]), None);
    }
}
