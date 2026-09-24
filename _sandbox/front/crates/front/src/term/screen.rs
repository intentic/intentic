//! Re-stating a pane into an empty xterm: its state and captures as tmux reports them, drawn back as one sequence of
//! bytes that leaves the browser's terminal where the pane is.

/// Space-separated, in this exact order; `pane_state` reads it back positionally.
pub const PANE_STATE_FORMAT: &str = concat!(
    "#{cursor_x} #{cursor_y} #{alternate_on} #{alternate_saved_x} #{alternate_saved_y} #{cursor_flag} ",
    "#{insert_flag} #{keypad_cursor_flag} #{keypad_flag} #{mouse_standard_flag} #{mouse_button_flag} ",
    "#{mouse_all_flag} #{mouse_sgr_flag} #{mouse_utf8_flag} #{wrap_flag} #{origin_flag} #{scroll_region_upper} ",
    "#{scroll_region_lower} #{pane_height} #{pane_width} #{pane_current_command}",
);

/// Where the client stands: `$3 %7 @2`, read back by `location`.
pub const LOCATION_FORMAT: &str = "#{session_id} #{pane_id} #{window_id}";

const STATE_FIELDS: usize = 21;

// tmux's UINT_MAX: nothing is saved.
const UNSET: u64 = 4_294_967_295;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneState {
    pub cursor_x: u64,
    pub cursor_y: u64,
    pub alternate: bool,
    /// The normal screen's cursor while the alternate one is up.
    pub saved: Option<(u64, u64)>,
    pub cursor_visible: bool,
    pub insert: bool,
    pub cursor_keys_application: bool,
    pub keypad_application: bool,
    pub mouse_standard: bool,
    pub mouse_button: bool,
    pub mouse_all: bool,
    pub mouse_sgr: bool,
    pub mouse_utf8: bool,
    pub wrap: bool,
    pub origin: bool,
    pub scroll_top: u64,
    pub scroll_bottom: u64,
    pub height: u64,
    pub width: u64,
    pub command: String,
}

pub fn pane_state(line: &str) -> Option<PaneState> {
    let fields: Vec<&str> = line.trim().split(' ').collect();
    if fields.len() < STATE_FIELDS {
        return None;
    }
    let number = |index: usize| fields[index].parse::<u64>().unwrap_or(0);
    let flag = |index: usize| fields[index] == "1";
    let saved = |index: usize| Some(number(index)).filter(|value| *value != UNSET);
    Some(PaneState {
        cursor_x: number(0),
        cursor_y: number(1),
        alternate: flag(2),
        saved: saved(3).zip(saved(4)),
        cursor_visible: flag(5),
        insert: flag(6),
        cursor_keys_application: flag(7),
        keypad_application: flag(8),
        mouse_standard: flag(9),
        mouse_button: flag(10),
        mouse_all: flag(11),
        mouse_sgr: flag(12),
        mouse_utf8: flag(13),
        wrap: flag(14),
        origin: flag(15),
        scroll_top: number(16),
        scroll_bottom: number(17),
        height: number(18),
        width: number(19),
        // The command may itself hold spaces: everything from the last field on is it.
        command: fields[STATE_FIELDS - 1..].join(" "),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneLocation {
    pub session: String,
    pub pane: String,
    pub window: String,
}

fn is_id(value: &str, sigil: char) -> bool {
    value
        .strip_prefix(sigil)
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

/// None when tmux had nothing to say (a closed window errors, and an empty reply reads the same), never a partial one.
pub fn location(line: &str) -> Option<PaneLocation> {
    let mut fields = line.trim().split(' ');
    let (session, pane, window) = (fields.next()?, fields.next()?, fields.next()?);
    (is_id(session, '$') && is_id(pane, '%') && is_id(window, '@')).then(|| PaneLocation {
        session: session.to_owned(),
        pane: pane.to_owned(),
        window: window.to_owned(),
    })
}

// No format reports live bracketed-paste state; it is assumed for a shell at its prompt on the normal screen.
const SHELLS: [&str; 5] = ["zsh", "bash", "fish", "sh", "dash"];

fn cup(out: &mut Vec<u8>, row: u64, col: u64) {
    out.extend_from_slice(format!("\x1b[{};{}H", row + 1, col + 1).as_bytes());
}

// The scroll region first (DECSTBM homes the cursor), origin mode after: it makes a row number region-relative.
fn cursor(out: &mut Vec<u8>, state: &PaneState) {
    let full_region = state.scroll_top == 0 && state.scroll_bottom + 1 >= state.height;
    if !full_region && state.height > 0 {
        out.extend_from_slice(
            format!("\x1b[{};{}r", state.scroll_top + 1, state.scroll_bottom + 1).as_bytes(),
        );
    }
    if state.origin {
        out.extend_from_slice(b"\x1b[?6h");
        cup(
            out,
            state.cursor_y.saturating_sub(state.scroll_top),
            state.cursor_x,
        );
    } else {
        cup(out, state.cursor_y, state.cursor_x);
    }
}

// Each mode tmux tracks, and the sequence that turns it on (or off, for the two that default on).
fn modes(out: &mut Vec<u8>, state: &PaneState) {
    let sequences: [(bool, &[u8]); 11] = [
        (!state.cursor_visible, b"\x1b[?25l"),
        (state.insert, b"\x1b[4h"),
        (state.cursor_keys_application, b"\x1b[?1h"),
        (state.keypad_application, b"\x1b="),
        (!state.wrap, b"\x1b[?7l"),
        (state.mouse_standard, b"\x1b[?1000h"),
        (state.mouse_button, b"\x1b[?1002h"),
        (state.mouse_all, b"\x1b[?1003h"),
        (state.mouse_utf8, b"\x1b[?1005h"),
        (state.mouse_sgr, b"\x1b[?1006h"),
        (
            !state.alternate && SHELLS.contains(&state.command.as_str()),
            b"\x1b[?2004h",
        ),
    ];
    for (applies, sequence) in sequences {
        if applies {
            out.extend_from_slice(sequence);
        }
    }
}

fn join_rows(out: &mut Vec<u8>, rows: &[Vec<u8>]) {
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(row);
    }
}

/// Opens with RIS, clearing whatever the xterm held; rows are CRLF-joined and unterminated, leaving the cursor on the
/// last captured row as `-J`'s rejoined wrapping expects. `normal` holds the history under the normal screen.
pub fn synthesize(normal: &[Vec<u8>], alternate: Option<&[Vec<u8>]>, state: &PaneState) -> Vec<u8> {
    let mut out = b"\x1bc".to_vec();
    join_rows(&mut out, normal);
    if state.alternate {
        if let Some((x, y)) = state.saved {
            cup(&mut out, y, x);
        }
        out.extend_from_slice(b"\x1b[?1049h");
        join_rows(&mut out, alternate.unwrap_or_default());
    }
    cursor(&mut out, state);
    modes(&mut out, state);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // A fresh zsh in a 100x30 pane, as tmux printed its state.
    const FRESH_SHELL: &str = "4 1 0 4294967295 4294967295 1 0 1 1 0 0 0 0 0 1 0 0 29 30 100 zsh";

    fn fresh() -> PaneState {
        pane_state(FRESH_SHELL).unwrap()
    }

    fn rows(rows: &[&str]) -> Vec<Vec<u8>> {
        rows.iter().map(|row| row.as_bytes().to_vec()).collect()
    }

    fn text(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn the_state_line_reads_back_positionally_in_the_formats_own_order() {
        assert_eq!(PANE_STATE_FORMAT.split(' ').count(), STATE_FIELDS);
        assert_eq!(
            fresh(),
            PaneState {
                cursor_x: 4,
                cursor_y: 1,
                alternate: false,
                saved: None,
                cursor_visible: true,
                insert: false,
                cursor_keys_application: true,
                keypad_application: true,
                mouse_standard: false,
                mouse_button: false,
                mouse_all: false,
                mouse_sgr: false,
                mouse_utf8: false,
                wrap: true,
                origin: false,
                scroll_top: 0,
                scroll_bottom: 29,
                height: 30,
                width: 100,
                command: "zsh".into(),
            }
        );
        assert_eq!(pane_state("too short"), None);
        let spaced = pane_state(&format!("{} extra words", FRESH_SHELL)).unwrap();
        assert_eq!(spaced.command, "zsh extra words");
    }

    #[test]
    fn a_location_reads_back_the_session_it_is_in() {
        assert_eq!(
            location("$3 %7 @2"),
            Some(PaneLocation {
                session: "$3".into(),
                pane: "%7".into(),
                window: "@2".into()
            })
        );
        assert_eq!(location(""), None);
        assert_eq!(location("can't find window: @9"), None);
        // Sigil-checked, so a field in the wrong position never reads as a location.
        assert_eq!(location("%7 @2 $3"), None);
        assert_eq!(location("$ %7 @2"), None);
    }

    #[test]
    fn a_normal_screen_is_reset_then_its_rows_then_the_cursor_then_the_modes() {
        let state = PaneState {
            cursor_x: 2,
            cursor_y: 2,
            ..fresh()
        };
        let bytes = text(synthesize(&rows(&["$ ls", "a  b", "$ "]), None, &state));
        assert!(bytes.starts_with("\x1bc$ ls\r\na  b\r\n$ "));
        assert!(bytes.contains("$ \x1b[3;3H"));
        // A full-height scroll region is the default and left unstated.
        assert!(!bytes.contains('r'));
        assert!(bytes.ends_with("\x1b[?1h\x1b=\x1b[?2004h"));
    }

    #[test]
    fn the_alternate_screen_goes_over_the_saved_normal_one() {
        let state = PaneState {
            alternate: true,
            saved: Some((2, 1)),
            cursor_x: 0,
            cursor_y: 0,
            mouse_all: true,
            mouse_sgr: true,
            command: "vim".into(),
            ..fresh()
        };
        let bytes = text(synthesize(
            &rows(&["$ vim", "$ "]),
            Some(&rows(&["~", "~", "-- INSERT --"])),
            &state,
        ));
        assert_eq!(
            bytes,
            "\x1bc$ vim\r\n$ \x1b[2;3H\x1b[?1049h~\r\n~\r\n-- INSERT --\x1b[1;1H\x1b[?1h\x1b=\x1b[?1003h\x1b[?1006h"
        );
    }

    #[test]
    fn a_scroll_region_precedes_the_cursor_and_origin_mode_makes_it_region_relative() {
        let state = PaneState {
            scroll_top: 2,
            scroll_bottom: 20,
            cursor_y: 5,
            cursor_x: 0,
            origin: true,
            ..fresh()
        };
        let bytes = text(synthesize(&rows(&["x"]), None, &state));
        assert!(bytes.contains("\x1b[3;21r\x1b[?6h\x1b[4;1H"));
    }

    #[test]
    fn a_hidden_cursor_insert_mode_and_no_wrap_are_restated() {
        let state = PaneState {
            cursor_visible: false,
            insert: true,
            wrap: false,
            command: "less".into(),
            ..fresh()
        };
        let bytes = text(synthesize(&[], None, &state));
        assert!(bytes.contains("\x1b[?25l"));
        assert!(bytes.contains("\x1b[4h"));
        assert!(bytes.contains("\x1b[?7l"));
        // `less` is no shell: no bracketed paste is guessed for it.
        assert!(!bytes.contains("2004h"));
    }
}
