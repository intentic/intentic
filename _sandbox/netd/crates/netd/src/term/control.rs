//! tmux control mode (`tmux -C`) read line by line: `%output` lines carry a pane's bytes octal-escaped, command replies
//! are `%begin`/`%end` blocks, and every other `%` line is a notice tmux broadcasts to all of its control clients.

/// What one line of a control client's stdout says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A pane's bytes, unescaped; never decoded as UTF-8 here, since one line can end inside a character.
    Output {
        pane: String,
        bytes: Vec<u8>,
    },
    /// One command's reply; `initial` marks the attach's own block, which no command asked for.
    Reply {
        ok: bool,
        initial: bool,
        lines: Vec<Vec<u8>>,
    },
    Notice {
        name: String,
        args: String,
    },
    /// The client is ending: its session was destroyed, or it was detached.
    Exit {
        reason: String,
    },
}

// `-CC` opens its first line with this DCS; `-C` does not, and it is stripped either way.
const DCS_PREFIX: &[u8] = b"\x1bP1000p";

/// Bytes below 0x20 and the backslash itself arrive as `\ooo`; everything else, UTF-8's upper range included, as is.
pub fn decode_output(value: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len());
    let mut at = 0;
    while at < value.len() {
        let byte = value[at];
        if byte == b'\\'
            && let Some(octal) = value.get(at + 1..at + 4)
            && octal.iter().all(|digit| (b'0'..=b'7').contains(digit))
        {
            let decoded = octal
                .iter()
                .fold(0_u32, |sum, digit| sum * 8 + u32::from(digit - b'0'));
            out.push((decoded & 0xff) as u8);
            at += 4;
        } else {
            out.push(byte);
            at += 1;
        }
    }
    out
}

#[derive(Debug, PartialEq, Eq)]
enum Verb {
    Begin,
    End,
    Error,
}

// `%begin <time> <number> <flags>`: the first two are the stamp the closing `%end`/`%error` repeats.
fn block_line(text: &[u8]) -> Option<(Verb, &[u8], bool)> {
    let prefixes: [(Verb, &[u8]); 3] = [
        (Verb::Begin, b"%begin "),
        (Verb::End, b"%end "),
        (Verb::Error, b"%error "),
    ];
    let (verb, rest) = prefixes
        .into_iter()
        .find_map(|(verb, prefix)| Some((verb, text.strip_prefix(prefix)?)))?;
    let fields: Vec<&[u8]> = rest.split(|byte| *byte == b' ').collect();
    let [time, number, flags] = fields.as_slice() else {
        return None;
    };
    if [time, number, flags]
        .iter()
        .any(|field| field.is_empty() || !field.iter().all(u8::is_ascii_digit))
    {
        return None;
    }
    Some((verb, &rest[..time.len() + 1 + number.len()], *flags == b"0"))
}

fn text_of(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

// A `%` line outside any block: a pane's output, the exit, or one of tmux's state notices.
fn notification(text: &[u8]) -> Event {
    let body = &text[1..];
    let (name, args) = match body.iter().position(|byte| *byte == b' ') {
        Some(space) => (&body[..space], &body[space + 1..]),
        None => (body, &b""[..]),
    };
    match name {
        b"output" => {
            // An empty payload after `%output %5 ` is a real line, not a missing one.
            let (pane, escaped) = match args.iter().position(|byte| *byte == b' ') {
                Some(gap) => (&args[..gap], &args[gap + 1..]),
                None => (args, &b""[..]),
            };
            Event::Output {
                pane: text_of(pane),
                bytes: decode_output(escaped),
            }
        }
        b"exit" => Event::Exit {
            reason: text_of(args),
        },
        _ => Event::Notice {
            name: text_of(name),
            args: text_of(args),
        },
    }
}

struct Block {
    stamp: Vec<u8>,
    initial: bool,
    lines: Vec<Vec<u8>>,
}

/// Holds a partial line across reads, and the reply block a line may be inside.
#[derive(Default)]
pub struct Parser {
    rest: Vec<u8>,
    block: Option<Block>,
}

impl Parser {
    pub fn feed(&mut self, chunk: &[u8], events: &mut Vec<Event>) {
        let mut data = chunk;
        if !self.rest.is_empty() {
            let Some(end) = memchr::memchr(b'\n', data) else {
                self.rest.extend_from_slice(data);
                return;
            };
            let mut line = std::mem::take(&mut self.rest);
            line.extend_from_slice(&data[..end]);
            self.line(&line, events);
            data = &data[end + 1..];
        }
        while let Some(end) = memchr::memchr(b'\n', data) {
            self.line(&data[..end], events);
            data = &data[end + 1..];
        }
        self.rest.extend_from_slice(data);
    }

    fn line(&mut self, raw: &[u8], events: &mut Vec<Event>) {
        let text = raw.strip_prefix(DCS_PREFIX).unwrap_or(raw);
        if let Some(open) = &mut self.block {
            // Only the block's own stamp closes it, so a captured line that reads `%end …` is content.
            match block_line(text) {
                Some((verb, stamp, _)) if verb != Verb::Begin && stamp == open.stamp.as_slice() => {
                    let open = self.block.take().expect("a block is open");
                    events.push(Event::Reply {
                        ok: verb == Verb::End,
                        initial: open.initial,
                        lines: open.lines,
                    });
                }
                _ => open.lines.push(text.to_vec()),
            }
            return;
        }
        // Nothing tmux writes outside a block is unprefixed: noise, not data.
        if !text.starts_with(b"%") {
            return;
        }
        match block_line(text) {
            Some((Verb::Begin, stamp, initial)) => {
                self.block = Some(Block {
                    stamp: stamp.to_vec(),
                    initial,
                    lines: Vec::new(),
                });
            }
            // A stray `%end`/`%error` closes nothing.
            Some(_) => {}
            None => events.push(notification(text)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // tmux control-mode transcripts fed in the shapes a pipe delivers them: whole lines, half lines, several at once.
    fn feed(chunks: &[&[u8]]) -> Vec<Event> {
        let mut parser = Parser::default();
        let mut events = Vec::new();
        for chunk in chunks {
            parser.feed(chunk, &mut events);
        }
        events
    }

    fn reply(ok: bool, initial: bool, lines: &[&[u8]]) -> Event {
        Event::Reply {
            ok,
            initial,
            lines: lines.iter().map(|line| line.to_vec()).collect(),
        }
    }

    #[test]
    fn octal_escapes_become_bytes_and_everything_else_passes_as_the_byte_it_is() {
        let bytes = decode_output(b"\\033[31mred\\134\\015\\012h\xc3\xa9");
        assert_eq!(bytes, b"\x1b[31mred\\\r\nh\xc3\xa9");
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "\x1b[31mred\\\r\nh\u{e9}"
        );
    }

    #[test]
    fn a_backslash_not_followed_by_three_octal_digits_stays_a_backslash() {
        assert_eq!(decode_output(b"a\\b\\12x\\8"), b"a\\b\\12x\\8");
        assert_eq!(decode_output(b"end\\01"), b"end\\01");
    }

    #[test]
    fn the_attachs_reply_is_initial_a_commands_is_not_and_an_error_fails() {
        let events = feed(&[
            b"%begin 1788688249 476510 0\n%end 1788688249 476510 0\n",
            b"%begin 1788688250 476530 1\n%5 100x30\n%end 1788688250 476530 1\n",
            b"%begin 1788688253 476628 1\nparse error: unknown command: nope\n%error 1788688253 476628 1\n",
        ]);
        assert_eq!(
            events,
            vec![
                reply(true, true, &[]),
                reply(true, false, &[b"%5 100x30"]),
                reply(false, false, &[b"parse error: unknown command: nope"]),
            ]
        );
    }

    #[test]
    fn a_line_is_a_line_however_the_pipe_cuts_it_and_a_split_escape_decodes_whole() {
        let events = feed(&[b"%outp", b"ut %7 he\\03", b"3[1mllo\n%exit\n"]);
        assert_eq!(
            events,
            vec![
                Event::Output {
                    pane: "%7".into(),
                    bytes: b"he\x1b[1mllo".to_vec()
                },
                Event::Exit {
                    reason: String::new()
                },
            ]
        );
    }

    #[test]
    fn inside_a_block_only_the_matching_stamp_closes_it() {
        let events =
            feed(&[b"%begin 10 20 1\n%end 99 99 1\n%output %1 not-output\n%end 10 20 1\n"]);
        assert_eq!(
            events,
            vec![reply(
                true,
                false,
                &[b"%end 99 99 1", b"%output %1 not-output"]
            )]
        );
    }

    #[test]
    fn notices_carry_their_name_and_the_rest_and_the_cc_preamble_is_stripped() {
        let events = feed(&[
            b"\x1bP1000p%begin 1 2 0\n%end 1 2 0\n%session-window-changed $66 @1864\n%exit detached\n",
        ]);
        assert_eq!(
            events,
            vec![
                reply(true, true, &[]),
                Event::Notice {
                    name: "session-window-changed".into(),
                    args: "$66 @1864".into()
                },
                Event::Exit {
                    reason: "detached".into()
                },
            ]
        );
    }

    #[test]
    fn an_empty_output_payload_is_a_line_and_unprefixed_noise_is_skipped() {
        let events = feed(&[b"stray noise\n%output %5 \n%output %5\n"]);
        assert_eq!(
            events,
            vec![
                Event::Output {
                    pane: "%5".into(),
                    bytes: Vec::new()
                },
                Event::Output {
                    pane: "%5".into(),
                    bytes: Vec::new()
                },
            ]
        );
    }
}
