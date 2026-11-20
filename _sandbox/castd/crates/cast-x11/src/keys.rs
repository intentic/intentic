//! DOM key names to X keysyms. The editor sends `KeyboardEvent.key`, the layout already applied on the person's own
//! machine (`ą`, `€`, `@`, `Enter`, `F5`), so castd types the character the key produced rather than the physical key:
//! the display's X keymap (US on Xvfb) is not the person's, and a character it lacks goes through a spare keycode
//! (input.rs).
//! `code` (`KeyboardEvent.code`) only settles what the name alone cannot: which Shift, which Control, the keypad's Enter.

use crate::keysym_table::LEGACY;

pub const SHIFT_L: u32 = 0xffe1;
pub const SHIFT_R: u32 = 0xffe2;
pub const CONTROL_L: u32 = 0xffe3;
pub const CONTROL_R: u32 = 0xffe4;
pub const ALT_L: u32 = 0xffe9;
pub const ALT_R: u32 = 0xffea;
pub const SUPER_L: u32 = 0xffeb;
pub const SUPER_R: u32 = 0xffec;
pub const ISO_LEVEL3_SHIFT: u32 = 0xfe03;
pub const RETURN: u32 = 0xff0d;

/// The keysym X names a Unicode keysym by: 0x1000000 plus the code point.
pub const fn unicode_keysym(cp: u32) -> u32 {
    0x0100_0000 | cp
}

/// The keysym of a character: Latin-1 is its own code point, X's legacy keysyms cover most scripts' letters and signs
/// (`ą` is `aogonek`, 0x1b1; `€` is `EuroSign`), and anything else is its Unicode keysym. A few control characters are
/// keys of their own. None for what no key types (other control characters).
pub fn char_keysym(c: char) -> Option<u32> {
    let cp = c as u32;
    match c {
        '\n' | '\r' => return Some(RETURN),
        '\t' => return Some(0xff09),
        '\u{8}' => return Some(0xff08),
        '\u{1b}' => return Some(0xff1b),
        '\u{7f}' => return Some(0xffff),
        _ => {}
    }
    if cp < 0x20 || (0x80..0xa0).contains(&cp) {
        return None;
    }
    if cp <= 0xff {
        return Some(cp);
    }
    Some(
        LEGACY
            .binary_search_by_key(&cp, |&(c, _)| c)
            .map(|i| LEGACY[i].1)
            .unwrap_or_else(|_| unicode_keysym(cp)),
    )
}

/// Every keysym that types `c`, the preferred one first: a layout may carry either the legacy keysym or the Unicode
/// one, and either on a spare keycode types the character.
pub fn char_keysyms(c: char) -> Vec<u32> {
    let Some(first) = char_keysym(c) else {
        return Vec::new();
    };
    let unicode = unicode_keysym(c as u32);
    if first != unicode && (c as u32) > 0xff && first < 0xfd00 {
        vec![first, unicode]
    } else {
        vec![first]
    }
}

/// The keysym for a DOM `key`, with `code` as a hint where the name is ambiguous. None for what castd does not type:
/// `Dead` (the editor sends the composed character on the next keydown), `Process` (an IME at work, which commits with
/// `text`), `Unidentified` with no `code` it knows.
pub fn key_keysym(key: &str, code: Option<&str>) -> Option<u32> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.clone().next()) {
        // The keypad's Enter is a key name, never a character.
        return char_keysym(c);
    }
    let left = !code.is_some_and(|c| c.ends_with("Right"));
    let named = match key {
        "Enter" if code == Some("NumpadEnter") => 0xff8d,
        "Enter" => RETURN,
        "Tab" => 0xff09,
        "Backspace" => 0xff08,
        "Escape" | "Esc" => 0xff1b,
        "Delete" | "Del" => 0xffff,
        "Insert" => 0xff63,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "ArrowLeft" | "Left" => 0xff51,
        "ArrowUp" | "Up" => 0xff52,
        "ArrowRight" | "Right" => 0xff53,
        "ArrowDown" | "Down" => 0xff54,
        "Shift" => {
            if left {
                SHIFT_L
            } else {
                SHIFT_R
            }
        }
        "Control" => {
            if left {
                CONTROL_L
            } else {
                CONTROL_R
            }
        }
        "Alt" => {
            if left {
                ALT_L
            } else {
                ALT_R
            }
        }
        // Chromium on Linux calls the Super keys Meta.
        "Meta" | "OS" | "Super" => {
            if left {
                SUPER_L
            } else {
                SUPER_R
            }
        }
        "AltGraph" => ISO_LEVEL3_SHIFT,
        "CapsLock" => 0xffe5,
        "NumLock" => 0xff7f,
        "ScrollLock" => 0xff14,
        "Pause" => 0xff13,
        "PrintScreen" => 0xff61,
        "ContextMenu" | "Apps" => 0xff67,
        "Clear" => 0xff0b,
        "Help" => 0xff6a,
        "Select" => 0xff60,
        "Execute" => 0xff62,
        "Undo" => 0xff65,
        "Redo" | "Again" => 0xff66,
        "Find" => 0xff68,
        "Cancel" => 0xff69,
        "Spacebar" => 0x20,
        "Copy" => 0x1008ff57,
        "Cut" => 0x1008ff58,
        "Paste" => 0x1008ff6d,
        "AudioVolumeDown" => 0x1008ff11,
        "AudioVolumeMute" => 0x1008ff12,
        "AudioVolumeUp" => 0x1008ff13,
        "MediaPlayPause" => 0x1008ff14,
        "MediaStop" => 0x1008ff15,
        "MediaTrackPrevious" => 0x1008ff16,
        "MediaTrackNext" => 0x1008ff17,
        "BrowserHome" => 0x1008ff18,
        "BrowserSearch" => 0x1008ff1b,
        "BrowserBack" => 0x1008ff26,
        "BrowserForward" => 0x1008ff27,
        "BrowserStop" => 0x1008ff28,
        "BrowserRefresh" => 0x1008ff29,
        "BrowserFavorites" => 0x1008ff30,
        "Unidentified" => return code.and_then(code_keysym),
        _ => return function_key(key),
    };
    Some(named)
}

/// Every keysym that types a DOM `key`, the preferred first: a character's legacy and Unicode keysyms, else the one
/// named key. Empty for what castd does not type.
pub fn key_keysyms(key: &str, code: Option<&str>) -> Vec<u32> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return char_keysyms(c);
    }
    key_keysym(key, code).into_iter().collect()
}

/// F1 to F35.
fn function_key(key: &str) -> Option<u32> {
    let n: u32 = key.strip_prefix('F')?.parse().ok()?;
    (1..=35).contains(&n).then(|| 0xffbe + n - 1)
}

/// The US layout's keysym for a physical key, for a `key` the browser could not name.
pub fn code_keysym(code: &str) -> Option<u32> {
    if let Some(letter) = code.strip_prefix("Key") {
        let mut c = letter.chars();
        if let (Some(l), None) = (c.next(), c.next()) {
            return l
                .is_ascii_uppercase()
                .then(|| l.to_ascii_lowercase() as u32);
        }
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let mut c = digit.chars();
        if let (Some(d), None) = (c.next(), c.next()) {
            return d.is_ascii_digit().then_some(d as u32);
        }
    }
    let ascii = match code {
        "Space" => ' ',
        "Minus" => '-',
        "Equal" => '=',
        "BracketLeft" => '[',
        "BracketRight" => ']',
        "Backslash" | "IntlBackslash" => '\\',
        "Semicolon" => ';',
        "Quote" => '\'',
        "Backquote" => '`',
        "Comma" => ',',
        "Period" => '.',
        "Slash" => '/',
        _ => {
            let name = match code {
                "Enter" | "NumpadEnter" | "Tab" | "Backspace" | "Escape" | "Delete" | "Insert"
                | "Home" | "End" | "PageUp" | "PageDown" | "ArrowLeft" | "ArrowUp"
                | "ArrowRight" | "ArrowDown" | "CapsLock" | "ContextMenu" => code,
                "ShiftLeft" | "ShiftRight" => "Shift",
                "ControlLeft" | "ControlRight" => "Control",
                "AltLeft" | "AltRight" => "Alt",
                "MetaLeft" | "MetaRight" | "OSLeft" | "OSRight" => "Meta",
                c if c.starts_with('F') => c,
                _ => return None,
            };
            let named = if name == "NumpadEnter" { "Enter" } else { name };
            return key_keysym(named, Some(code));
        }
    };
    Some(ascii as u32)
}

/// Whether a keysym is a modifier key's (Shift, Control, Alt, Super, AltGr).
pub fn is_modifier(keysym: u32) -> bool {
    (SHIFT_L..=SUPER_R).contains(&keysym) || keysym == ISO_LEVEL3_SHIFT
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(key: &str) -> Option<u32> {
        key_keysym(key, None)
    }

    #[test]
    fn letters_digits_and_ascii_are_their_code_points() {
        assert_eq!(k("a"), Some(0x61));
        assert_eq!(k("A"), Some(0x41));
        assert_eq!(k("z"), Some(0x7a));
        assert_eq!(k("7"), Some(0x37));
        assert_eq!(k(" "), Some(0x20));
        assert_eq!(k("@"), Some(0x40));
        assert_eq!(k("~"), Some(0x7e));
    }

    #[test]
    fn altgr_characters_are_their_legacy_keysyms() {
        // Polish programmer's layout: AltGr+A, E, L, Z (and X for ź), U for €.
        assert_eq!(k("ą"), Some(0x1b1)); // aogonek
        assert_eq!(k("Ą"), Some(0x1a1)); // Aogonek
        assert_eq!(k("ę"), Some(0x1ea)); // eogonek
        assert_eq!(k("ł"), Some(0x1b3)); // lstroke
        assert_eq!(k("ż"), Some(0x1bf)); // zabovedot
        assert_eq!(k("ź"), Some(0x1bc)); // zacute
        assert_eq!(k("€"), Some(0x20ac)); // EuroSign
        // German AltGr+Q and AltGr+E.
        assert_eq!(k("@"), Some(0x40));
        assert_eq!(k("ß"), Some(0xdf));
        // Cyrillic and Greek letters have legacy keysyms too.
        assert_eq!(k("ж"), Some(0x6d6)); // Cyrillic_zhe
        assert_eq!(k("λ"), Some(0x7eb)); // Greek_lamda
    }

    #[test]
    fn dead_key_results_type_and_dead_keys_do_not() {
        // What a dead key composes arrives as the next keydown's key.
        assert_eq!(k("é"), Some(0xe9));
        assert_eq!(k("ñ"), Some(0xf1));
        assert_eq!(k("ü"), Some(0xfc));
        assert_eq!(k("ŝ"), Some(0x2fe)); // scircumflex
        assert_eq!(k("ǎ"), Some(unicode_keysym(0x1ce))); // no legacy keysym: Unicode
        assert_eq!(k("Dead"), None);
        assert_eq!(k("Process"), None);
        assert_eq!(k("Unidentified"), None);
        assert_eq!(key_keysym("Unidentified", Some("KeyQ")), Some(0x71));
        assert_eq!(key_keysym("Unidentified", Some("Digit4")), Some(0x34));
    }

    #[test]
    fn emoji_and_other_scripts_fall_back_to_unicode_keysyms() {
        assert_eq!(k("😀"), Some(unicode_keysym(0x1f600)));
        assert_eq!(k("中"), Some(unicode_keysym(0x4e2d)));
        assert_eq!(char_keysyms('ą'), vec![0x1b1, unicode_keysym(0x105)]);
        assert_eq!(char_keysyms('a'), vec![0x61]);
    }

    #[test]
    fn function_and_navigation_keys_are_named() {
        assert_eq!(k("F1"), Some(0xffbe));
        assert_eq!(k("F5"), Some(0xffc2));
        assert_eq!(k("F12"), Some(0xffc9));
        assert_eq!(k("F24"), Some(0xffd5));
        assert_eq!(k("F0"), None);
        assert_eq!(k("F36"), None);
        assert_eq!(k("Enter"), Some(0xff0d));
        assert_eq!(key_keysym("Enter", Some("NumpadEnter")), Some(0xff8d));
        assert_eq!(k("Tab"), Some(0xff09));
        assert_eq!(k("Backspace"), Some(0xff08));
        assert_eq!(k("Escape"), Some(0xff1b));
        assert_eq!(k("Delete"), Some(0xffff));
        assert_eq!(k("ArrowLeft"), Some(0xff51));
        assert_eq!(k("ArrowUp"), Some(0xff52));
        assert_eq!(k("ArrowRight"), Some(0xff53));
        assert_eq!(k("ArrowDown"), Some(0xff54));
        assert_eq!(k("Home"), Some(0xff50));
        assert_eq!(k("End"), Some(0xff57));
        assert_eq!(k("PageUp"), Some(0xff55));
        assert_eq!(k("PageDown"), Some(0xff56));
        assert_eq!(k("Insert"), Some(0xff63));
        assert_eq!(k("ContextMenu"), Some(0xff67));
        assert_eq!(k("NoSuchKey"), None);
        assert_eq!(k(""), None);
    }

    #[test]
    fn code_tells_left_from_right_modifiers() {
        assert_eq!(key_keysym("Shift", Some("ShiftLeft")), Some(SHIFT_L));
        assert_eq!(key_keysym("Shift", Some("ShiftRight")), Some(SHIFT_R));
        assert_eq!(key_keysym("Control", None), Some(CONTROL_L));
        assert_eq!(key_keysym("Control", Some("ControlRight")), Some(CONTROL_R));
        assert_eq!(key_keysym("Alt", Some("AltRight")), Some(ALT_R));
        assert_eq!(key_keysym("Meta", Some("MetaLeft")), Some(SUPER_L));
        assert_eq!(k("AltGraph"), Some(ISO_LEVEL3_SHIFT));
        assert!(is_modifier(SHIFT_L) && is_modifier(SUPER_R) && is_modifier(ISO_LEVEL3_SHIFT));
        assert!(!is_modifier(0x61));
    }

    #[test]
    fn control_characters_in_text_are_keys() {
        assert_eq!(char_keysym('\n'), Some(RETURN));
        assert_eq!(char_keysym('\t'), Some(0xff09));
        assert_eq!(char_keysym('\u{1}'), None);
        assert_eq!(char_keysym('\u{85}'), None);
    }
}
