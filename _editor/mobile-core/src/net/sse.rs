//! Server-sent events read off a byte stream that may be cut anywhere: inside a UTF-8 character, inside a `\r\n`,
//! inside an event. The same grammar as the daemon's own reader (`_shared/sandbox-contract/src/protocol/sse.ts`):
//! lines end at `\r\n`, `\r` or `\n`, a `:` line is a comment, data lines join with `\n`, a blank line ends the event.
//! Then oRPC's event iterators on top: an event named `message`, `done` or `error`, whose data is JSON or empty.

use serde::de::DeserializeOwned;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseEvent {
    /// The `event:` field; `None` reads as "message".
    pub event: Option<String>,
    /// The data lines joined with `\n`; `None` for a block with none, a keep-alive comment.
    pub data: Option<String>,
    /// The last id the stream set; it carries over to later events until set again.
    pub id: Option<String>,
}

#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    started: bool,
    // The last chunk ended in `\r`: a `\n` starting the next one belongs to that line ending, not a blank line.
    after_cr: bool,
    name: Option<String>,
    data: Option<Vec<String>>,
    last_id: Option<String>,
}

impl SseParser {
    pub fn feed(&mut self, mut bytes: &[u8], out: &mut Vec<SseEvent>) {
        if self.after_cr && bytes.first() == Some(&b'\n') {
            bytes = &bytes[1..];
        }
        self.after_cr = false;
        self.buffer.extend_from_slice(bytes);
        let mut start = 0;
        let mut index = 0;
        while index < self.buffer.len() {
            let byte = self.buffer[index];
            if byte == b'\n' || byte == b'\r' {
                let line = String::from_utf8_lossy(&self.buffer[start..index]).into_owned();
                let crlf = byte == b'\r' && self.buffer.get(index + 1) == Some(&b'\n');
                if byte == b'\r' && index + 1 == self.buffer.len() {
                    self.after_cr = true;
                }
                index += if crlf { 2 } else { 1 };
                start = index;
                self.line(&line, out);
            } else {
                index += 1;
            }
        }
        self.buffer.drain(..start);
    }

    /// The stream ended: an event it ended inside is dispatched as it stands.
    pub fn end(&mut self, out: &mut Vec<SseEvent>) {
        if !self.buffer.is_empty() {
            let line = String::from_utf8_lossy(&self.buffer).into_owned();
            self.buffer.clear();
            self.line(&line, out);
        }
        if self.name.is_some() || self.data.is_some() {
            self.line("", out);
        }
    }

    fn line(&mut self, mut line: &str, out: &mut Vec<SseEvent>) {
        if !self.started {
            self.started = true;
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
        }
        if line.is_empty() {
            out.push(SseEvent {
                event: self.name.take(),
                data: self.data.take().map(|lines| lines.join("\n")),
                id: self.last_id.clone(),
            });
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.name = Some(value.to_owned()),
            "data" => self
                .data
                .get_or_insert_with(Vec::new)
                .push(value.to_owned()),
            "id" if !value.contains('\0') => self.last_id = Some(value.to_owned()),
            _ => {}
        }
    }
}

/// One event of an oRPC event iterator.
#[derive(Debug, PartialEq)]
pub enum Frame<T> {
    Message(T),
    /// The iterator returned, with its return value if it had one.
    Done(Option<T>),
    /// The server threw: its error, as JSON.
    Error(serde_json::Value),
}

/// The oRPC frame an event carries; `None` for a keep-alive or an event oRPC does not send.
pub fn orpc_frame<T: DeserializeOwned>(
    event: &SseEvent,
) -> Option<Result<Frame<T>, serde_json::Error>> {
    let data = event.data.as_deref()?;
    let parse = |data: &str| -> Result<Option<T>, serde_json::Error> {
        if data.trim().is_empty() {
            Ok(None)
        } else {
            serde_json::from_str(data).map(Some)
        }
    };
    Some(match event.event.as_deref().unwrap_or("message") {
        "message" => match parse(data) {
            Ok(Some(value)) => Ok(Frame::Message(value)),
            Ok(None) => return None,
            Err(error) => Err(error),
        },
        "done" => parse(data).map(Frame::Done),
        "error" => serde_json::from_str(data)
            .map(Frame::Error)
            .or_else(|_| Ok(Frame::Error(serde_json::Value::String(data.to_owned())))),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut parser = SseParser::default();
        let mut out = Vec::new();
        for chunk in chunks {
            parser.feed(chunk, &mut out);
        }
        parser.end(&mut out);
        out
    }

    #[test]
    fn reads_events_cut_anywhere() {
        let whole: &[u8] =
            "event: message\r\ndata: {\"a\":\"é\"}\r\n\r\n: keep-alive\n\ndata: x\rdata: y\r\r"
                .as_bytes();
        let expected = parse(&[whole]);
        // Every cut, including inside the two-byte é and between a \r and its \n.
        for cut in 1..whole.len() {
            assert_eq!(
                parse(&[&whole[..cut], &whole[cut..]]),
                expected,
                "cut at {cut}"
            );
        }
        assert_eq!(expected.len(), 3);
        assert_eq!(expected[0].event.as_deref(), Some("message"));
        assert_eq!(expected[0].data.as_deref(), Some("{\"a\":\"é\"}"));
        assert_eq!(
            expected[1].data, None,
            "a comment-only block carries no data"
        );
        assert_eq!(expected[2].data.as_deref(), Some("x\ny"));
    }

    #[test]
    fn reads_orpc_messages_done_and_errors() {
        let events = parse(&[b"event: message\ndata: {\"n\":1}\n\nevent: done\ndata:\n\nevent: error\ndata: {\"code\":\"GONE\"}\n\n"]);
        let frames: Vec<_> = events
            .iter()
            .filter_map(orpc_frame::<serde_json::Value>)
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            frames,
            [
                Frame::Message(serde_json::json!({"n": 1})),
                Frame::Done(None),
                Frame::Error(serde_json::json!({"code": "GONE"})),
            ]
        );
    }
}
