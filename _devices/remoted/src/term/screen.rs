//! A terminal's screen as remoted holds it: every byte the program wrote goes through a vt100 parser, so a viewer joining
//! (or one that fell behind) is drawn the screen as it stands, history included, instead of being sent everything since
//! the start. remoted is also the terminal the program talks to: it answers the program's status and cursor-position
//! queries itself and keeps them from the viewers, so an answer is typed once whether nobody or five people are watching.
//! ConPTY asks for the cursor position as it starts (portable-pty opens it with PSEUDOCONSOLE_INHERIT_CURSOR) and holds
//! the program's output until it is answered, so a terminal with no viewer yet would otherwise hang.

/// Lines of history a terminal keeps for the snapshot.
pub const HISTORY_LINES: usize = 5000;

// What the parser hands back besides the screen: the window title, and the answers owed to the program.
#[derive(Default)]
struct Heard {
    title: Option<String>,
    replies: Vec<u8>,
}

impl vt100::Callbacks for Heard {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.title = Some(String::from_utf8_lossy(title).into_owned());
    }

    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i1: Option<u8>,
        _i2: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        if c != 'n' || i1.is_some() {
            return;
        }
        match params.first().and_then(|param| param.first()) {
            // Device status: OK.
            Some(5) => self.replies.extend_from_slice(b"\x1b[0n"),
            // Cursor position, 1-based.
            Some(6) => {
                let (row, col) = screen.cursor_position();
                self.replies
                    .extend_from_slice(format!("\x1b[{};{}R", row + 1, col + 1).as_bytes());
            }
            _ => {}
        }
    }
}

/// One terminal's screen.
pub struct Screen {
    parser: vt100::Parser<Heard>,
    queries: QueryFilter,
}

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(rows, cols, HISTORY_LINES, Heard::default()),
            queries: QueryFilter::default(),
        }
    }

    /// Takes the program's output: what the viewers are sent (its queries taken out), and what the program is owed.
    pub fn output(&mut self, bytes: &[u8]) -> (Vec<u8>, Vec<u8>) {
        self.parser.process(bytes);
        let replies = std::mem::take(&mut self.parser.callbacks_mut().replies);
        (self.queries.strip(bytes), replies)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.screen_mut().set_size(rows, cols);
    }

    pub fn size(&self) -> (u16, u16) {
        let (rows, cols) = self.parser.screen().size();
        (cols, rows)
    }

    /// The title the program last set, if it set one.
    pub fn title(&self) -> Option<&str> {
        self.parser.callbacks().title.as_deref()
    }

    /// Bytes that leave an xterm of this size holding what this screen holds: a reset, the history scrolled into its
    /// scrollback, the screen, then the cursor and the input modes.
    pub fn snapshot(&mut self) -> Vec<u8> {
        let (rows, cols) = self.parser.screen().size();
        // RIS: whatever the viewer's terminal held is gone, its modes with it.
        let mut out = b"\x1bc".to_vec();
        if !self.parser.screen().alternate_screen() {
            let history = self.history(rows, cols);
            if !history.is_empty() {
                for line in &history {
                    out.extend_from_slice(line);
                    out.extend_from_slice(b"\x1b[0m\r\n");
                }
                // Whatever of the history still shows is scrolled off: rows - 1 more lines, wherever the cursor is.
                out.extend(std::iter::repeat_n(
                    b'\n',
                    usize::from(rows.saturating_sub(1)),
                ));
            }
        } else {
            out.extend_from_slice(b"\x1b[?1049h");
        }
        // Clears the screen, draws it, and puts the cursor and its visibility back.
        out.extend_from_slice(&self.parser.screen().state_formatted());
        out
    }

    // The scrollback, oldest line first, each as formatted bytes.
    fn history(&mut self, rows: u16, cols: u16) -> Vec<Vec<u8>> {
        let screen = self.parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        let kept = screen.scrollback();
        let mut lines = Vec::with_capacity(kept);
        let mut offset = kept;
        while offset > 0 {
            screen.set_scrollback(offset);
            let take = offset.min(usize::from(rows));
            lines.extend(screen.rows_formatted(0, cols).take(take));
            offset -= take;
        }
        screen.set_scrollback(0);
        lines
    }
}

/// Takes the status and cursor-position queries (`ESC [ 5 n`, `ESC [ 6 n`) out of a byte stream, across reads.
#[derive(Default)]
pub struct QueryFilter {
    held: Vec<u8>,
}

impl QueryFilter {
    pub fn strip(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len() + self.held.len());
        let mut input = std::mem::take(&mut self.held);
        input.extend_from_slice(bytes);
        let mut at = 0;
        while at < input.len() {
            if input[at] != 0x1b {
                out.push(input[at]);
                at += 1;
                continue;
            }
            let rest = &input[at..];
            // A query cut by the read's end is held for the next.
            if rest.len() < 4 && b"\x1b[5n".starts_with(rest)
                || rest.len() < 4 && b"\x1b[6n".starts_with(rest)
            {
                self.held = rest.to_vec();
                break;
            }
            if rest.starts_with(b"\x1b[5n") || rest.starts_with(b"\x1b[6n") {
                at += 4;
                continue;
            }
            out.push(0x1b);
            at += 1;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // What an xterm shows after `bytes`, as plain rows: the snapshot's proof is that a fresh terminal fed it shows the same.
    fn shown(cols: u16, rows: u16, bytes: &[u8]) -> (String, (u16, u16)) {
        let mut parser = vt100::Parser::new(rows, cols, 0);
        parser.process(bytes);
        (
            parser.screen().contents(),
            parser.screen().cursor_position(),
        )
    }

    #[test]
    fn a_snapshot_draws_a_fresh_terminal_into_the_same_screen_and_cursor() {
        let mut screen = Screen::new(40, 5);
        let (forwarded, _) = screen.output(b"first\r\n\x1b[31mred\x1b[0m line\r\n$ ech");
        assert_eq!(forwarded, b"first\r\n\x1b[31mred\x1b[0m line\r\n$ ech");
        let (contents, cursor) = shown(40, 5, &screen.snapshot());
        assert_eq!(contents, "first\nred line\n$ ech");
        assert_eq!(cursor, (2, 5));
    }

    #[test]
    fn a_snapshot_carries_the_history_into_the_viewers_scrollback() {
        let mut screen = Screen::new(20, 3);
        for line in 0..10 {
            screen.output(format!("line {line}\r\n").as_bytes());
        }
        let snapshot = screen.snapshot();
        let mut viewer = vt100::Parser::new(3, 20, 100);
        viewer.process(&snapshot);
        assert_eq!(viewer.screen().contents(), "line 8\nline 9");
        viewer.screen_mut().set_scrollback(usize::MAX);
        let scrolled = viewer.screen().scrollback();
        assert!(scrolled >= 8, "only {scrolled} lines of history arrived");
        viewer.screen_mut().set_scrollback(scrolled);
        assert_eq!(viewer.screen().contents().lines().next(), Some("line 0"));
    }

    #[test]
    fn the_alternate_screen_is_drawn_as_the_alternate_screen() {
        let mut screen = Screen::new(20, 3);
        screen.output(b"prompt$ vim\r\n\x1b[?1049h\x1b[H~ editing");
        let snapshot = screen.snapshot();
        let mut viewer = vt100::Parser::new(3, 20, 0);
        viewer.process(&snapshot);
        assert!(viewer.screen().alternate_screen());
        assert_eq!(viewer.screen().contents(), "~ editing");
    }

    #[test]
    fn the_cursor_position_and_status_queries_are_answered_here_and_kept_from_viewers() {
        let mut screen = Screen::new(80, 24);
        let (forwarded, replies) = screen.output(b"ab\x1b[6ncd\x1b[5n");
        assert_eq!(forwarded, b"abcd");
        assert_eq!(replies, b"\x1b[1;3R\x1b[0n");
    }

    #[test]
    fn a_query_cut_between_two_reads_is_still_taken_out_and_anything_else_passes() {
        let mut filter = QueryFilter::default();
        assert_eq!(filter.strip(b"x\x1b["), b"x");
        assert_eq!(filter.strip(b"6ny"), b"y");
        assert_eq!(filter.strip(b"\x1b"), b"");
        assert_eq!(filter.strip(b"[31m"), b"\x1b[31m");
        assert_eq!(filter.strip(b"\x1b[6"), b"");
        assert_eq!(filter.strip(b"0n"), b"\x1b[60n");
    }

    #[test]
    fn the_title_the_program_set_is_kept() {
        let mut screen = Screen::new(80, 24);
        screen.output(b"\x1b]2;build: running\x07");
        assert_eq!(screen.title(), Some("build: running"));
    }
}
