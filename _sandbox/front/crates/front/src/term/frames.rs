//! A terminal's messages on a stream no WebSocket rides, as `front_wire` frames them, read and written as the WebSocket's
//! own messages so one pump serves both.

use std::io;

use bytes::{Buf, BufMut, Bytes, BytesMut};
use front_wire::{FrameKind, TERMINAL_FRAME_HEADER};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};
use tokio_util::codec::{Decoder, Encoder};

pub struct Frames {
    max: usize,
}

impl Frames {
    /// Frames of at most `max` bytes; a longer one ends the stream.
    pub fn new(max: usize) -> Self {
        Self { max }
    }
}

fn unreadable(why: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, why)
}

impl Decoder for Frames {
    type Item = Message;
    type Error = io::Error;

    fn decode(&mut self, source: &mut BytesMut) -> io::Result<Option<Message>> {
        let Some(header) = source.get(..TERMINAL_FRAME_HEADER) else {
            return Ok(None);
        };
        let kind = FrameKind::of(header[0])
            .ok_or_else(|| unreadable("no terminal frame is of this kind"))?;
        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        if length > self.max {
            return Err(unreadable("a terminal frame past the largest message"));
        }
        if source.len() < TERMINAL_FRAME_HEADER + length {
            source.reserve(TERMINAL_FRAME_HEADER + length - source.len());
            return Ok(None);
        }
        source.advance(TERMINAL_FRAME_HEADER);
        let payload = source.split_to(length).freeze();
        let message = match kind {
            FrameKind::Pane => Message::Binary(payload),
            FrameKind::Message => Message::Text(
                Utf8Bytes::try_from(payload)
                    .map_err(|_| unreadable("a message that is not UTF-8"))?,
            ),
            FrameKind::Close => Message::Close(closing(payload)?),
            FrameKind::Ping => Message::Ping(payload),
            FrameKind::Pong => Message::Pong(payload),
        };
        Ok(Some(message))
    }
}

fn closing(mut payload: Bytes) -> io::Result<Option<CloseFrame>> {
    match payload.len() {
        0 => Ok(None),
        1 => Err(unreadable("a close frame's code is two bytes")),
        _ => {
            let code = payload.get_u16();
            let reason = Utf8Bytes::try_from(payload)
                .map_err(|_| unreadable("a close reason that is not UTF-8"))?;
            Ok(Some(CloseFrame {
                code: code.into(),
                reason,
            }))
        }
    }
}

impl Encoder<Message> for Frames {
    type Error = io::Error;

    fn encode(&mut self, message: Message, out: &mut BytesMut) -> io::Result<()> {
        let (kind, payload) = match message {
            Message::Binary(bytes) => (FrameKind::Pane, bytes),
            Message::Text(text) => (FrameKind::Message, Bytes::from(text)),
            Message::Close(None) => (FrameKind::Close, Bytes::new()),
            Message::Close(Some(frame)) => {
                let mut payload = BytesMut::with_capacity(2 + frame.reason.len());
                payload.put_u16(frame.code.into());
                payload.put_slice(frame.reason.as_bytes());
                (FrameKind::Close, payload.freeze())
            }
            Message::Ping(bytes) => (FrameKind::Ping, bytes),
            Message::Pong(bytes) => (FrameKind::Pong, bytes),
            Message::Frame(_) => {
                return Err(unreadable("a raw WebSocket frame has no terminal frame"));
            }
        };
        let length = u32::try_from(payload.len())
            .map_err(|_| unreadable("a message past a frame's length"))?;
        out.reserve(TERMINAL_FRAME_HEADER + payload.len());
        out.put_u8(kind as u8);
        out.put_u32(length);
        out.put_slice(&payload);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    const MAX: usize = 16 * 1024 * 1024;

    fn hex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&value[at..at + 2], 16).unwrap())
            .collect()
    }

    fn message_of(frame: &serde_json::Value) -> Message {
        let text = |key: &str| frame[key].as_str().unwrap_or_default().to_owned();
        match frame["kind"].as_str().unwrap() {
            "pane" => Message::Binary(hex(&text("bytes")).into()),
            "message" => Message::text(text("text")),
            "close" => Message::Close(frame["code"].as_u64().map(|code| CloseFrame {
                code: CloseCode::from(u16::try_from(code).unwrap()),
                reason: text("reason").into(),
            })),
            "ping" => Message::Ping(hex(&text("bytes")).into()),
            "pong" => Message::Pong(hex(&text("bytes")).into()),
            other => panic!("no frame is {other}"),
        }
    }

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../../../_shared/sandbox-contract/src/front/terminal-frames.fixture.json"
        ))
        .unwrap()
    }

    #[test]
    fn every_frame_the_shared_fixture_names_encodes_to_its_bytes_and_reads_back() {
        let fixture = fixture();
        assert_eq!(
            fixture["upgrade"],
            front_wire::TerminalUpgrade::Frames.token()
        );
        for case in fixture["frames"].as_array().unwrap() {
            let encoded = hex(case["encoded"].as_str().unwrap());
            let mut out = BytesMut::new();
            Frames::new(MAX)
                .encode(message_of(&case["frame"]), &mut out)
                .unwrap();
            assert_eq!(out.as_ref(), encoded, "{case}");
            let mut source = BytesMut::from(&encoded[..]);
            assert_eq!(
                Frames::new(MAX).decode(&mut source).unwrap(),
                Some(message_of(&case["frame"])),
                "{case}"
            );
            assert!(source.is_empty());
        }
    }

    #[test]
    fn a_frame_waits_for_its_last_byte_and_one_no_browser_sends_ends_the_stream() {
        let fixture = fixture();
        let encoded = hex(fixture["frames"][1]["encoded"].as_str().unwrap());
        let mut frames = Frames::new(MAX);
        let mut source = BytesMut::new();
        for byte in &encoded[..encoded.len() - 1] {
            source.put_u8(*byte);
            assert_eq!(frames.decode(&mut source).unwrap(), None);
        }
        source.put_u8(encoded[encoded.len() - 1]);
        assert!(frames.decode(&mut source).unwrap().is_some());

        for unreadable in fixture["unreadable"].as_array().unwrap() {
            let mut source = BytesMut::from(&hex(unreadable.as_str().unwrap())[..]);
            assert!(
                Frames::new(MAX).decode(&mut source).is_err(),
                "{unreadable}"
            );
        }
    }
}
