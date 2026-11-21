//! DOM `KeyboardEvent.code` (the physical key, by its US-layout position) to Linux evdev key codes, which the
//! portal's `NotifyKeyboardKeycode` takes: the compositor then applies the person's own layout, as it would to their
//! keyboard. The table is the USB HID usages both sides name, as input-event-codes.h numbers them.

/// The evdev code of a DOM `code`, None for a code with no key.
pub fn evdev(code: &str) -> Option<u32> {
    let letter = |c: u8| -> Option<u32> {
        // QWERTY rows: evdev numbers keys by position.
        const ROW: &[(u8, u32)] = &[
            (b'Q', 16),
            (b'W', 17),
            (b'E', 18),
            (b'R', 19),
            (b'T', 20),
            (b'Y', 21),
            (b'U', 22),
            (b'I', 23),
            (b'O', 24),
            (b'P', 25),
            (b'A', 30),
            (b'S', 31),
            (b'D', 32),
            (b'F', 33),
            (b'G', 34),
            (b'H', 35),
            (b'J', 36),
            (b'K', 37),
            (b'L', 38),
            (b'Z', 44),
            (b'X', 45),
            (b'C', 46),
            (b'V', 47),
            (b'B', 48),
            (b'N', 49),
            (b'M', 50),
        ];
        ROW.iter().find(|(l, _)| *l == c).map(|(_, k)| *k)
    };
    if let Some(l) = code.strip_prefix("Key").filter(|l| l.len() == 1) {
        return letter(l.as_bytes()[0]);
    }
    if let Some(d) = code
        .strip_prefix("Digit")
        .and_then(|d| d.parse::<u32>().ok())
    {
        return Some(if d == 0 { 11 } else { d + 1 });
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        return match n {
            1..=10 => Some(58 + n),
            11 => Some(87),
            12 => Some(88),
            13..=24 => Some(170 + n),
            _ => None,
        };
    }
    if let Some(d) = code
        .strip_prefix("Numpad")
        .and_then(|d| d.parse::<u32>().ok())
    {
        return [82, 79, 80, 81, 75, 76, 77, 71, 72, 73]
            .get(d as usize)
            .copied();
    }
    Some(match code {
        "Escape" => 1,
        "Minus" => 12,
        "Equal" => 13,
        "Backspace" => 14,
        "Tab" => 15,
        "BracketLeft" => 26,
        "BracketRight" => 27,
        "Enter" => 28,
        "ControlLeft" => 29,
        "Semicolon" => 39,
        "Quote" => 40,
        "Backquote" => 41,
        "ShiftLeft" => 42,
        "Backslash" => 43,
        "Comma" => 51,
        "Period" => 52,
        "Slash" => 53,
        "ShiftRight" => 54,
        "NumpadMultiply" => 55,
        "AltLeft" => 56,
        "Space" => 57,
        "CapsLock" => 58,
        "NumLock" => 69,
        "ScrollLock" => 70,
        "NumpadSubtract" => 74,
        "NumpadAdd" => 78,
        "NumpadDecimal" => 83,
        "IntlBackslash" => 86,
        "IntlRo" => 89,
        "Convert" => 92,
        "KanaMode" => 93,
        "NonConvert" => 94,
        "NumpadEnter" => 96,
        "ControlRight" => 97,
        "NumpadDivide" => 98,
        "PrintScreen" => 99,
        "AltRight" => 100,
        "Home" => 102,
        "ArrowUp" => 103,
        "PageUp" => 104,
        "ArrowLeft" => 105,
        "ArrowRight" => 106,
        "End" => 107,
        "ArrowDown" => 108,
        "PageDown" => 109,
        "Insert" => 110,
        "Delete" => 111,
        "AudioVolumeMute" => 113,
        "AudioVolumeDown" => 114,
        "AudioVolumeUp" => 115,
        "Power" => 116,
        "NumpadEqual" => 117,
        "Pause" => 119,
        "NumpadComma" => 121,
        "Lang1" => 122,
        "Lang2" => 123,
        "IntlYen" => 124,
        "MetaLeft" | "OSLeft" => 125,
        "MetaRight" | "OSRight" => 126,
        "ContextMenu" => 127,
        "BrowserStop" => 128,
        "Again" => 129,
        "Undo" => 131,
        "Copy" => 133,
        "Open" => 134,
        "Paste" => 135,
        "Find" => 136,
        "Cut" => 137,
        "Help" => 138,
        "LaunchApp2" => 140,
        "Sleep" => 142,
        "WakeUp" => 143,
        "LaunchApp1" => 144,
        "LaunchMail" => 155,
        "BrowserFavorites" => 156,
        "BrowserBack" => 158,
        "BrowserForward" => 159,
        "Eject" => 161,
        "MediaTrackNext" => 163,
        "MediaPlayPause" => 164,
        "MediaTrackPrevious" => 165,
        "MediaStop" => 166,
        "BrowserRefresh" => 173,
        "BrowserHome" => 172,
        "BrowserSearch" => 217,
        "MediaSelect" => 226,
        _ => return None,
    })
}

/// Whether an evdev code is a modifier (held across other keys, released with the viewer's own).
pub fn is_modifier(key: u32) -> bool {
    matches!(key, 29 | 42 | 54 | 56 | 97 | 100 | 125 | 126)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_keys_map_to_evdev_by_position() {
        assert_eq!(evdev("KeyA"), Some(30));
        assert_eq!(evdev("KeyQ"), Some(16));
        assert_eq!(evdev("KeyM"), Some(50));
        assert_eq!(evdev("Digit1"), Some(2));
        assert_eq!(evdev("Digit0"), Some(11));
        assert_eq!(evdev("F1"), Some(59));
        assert_eq!(evdev("F10"), Some(68));
        assert_eq!(evdev("F12"), Some(88));
        assert_eq!(evdev("F13"), Some(183));
        assert_eq!(evdev("Numpad0"), Some(82));
        assert_eq!(evdev("Numpad9"), Some(73));
        assert_eq!(evdev("NumpadEnter"), Some(96));
        assert_eq!(evdev("ShiftRight"), Some(54));
        assert_eq!(evdev("MetaLeft"), Some(125));
        assert_eq!(evdev("IntlBackslash"), Some(86));
        assert_eq!(evdev("Fn"), None);
        assert_eq!(evdev("KeyAB"), None);
        assert!(is_modifier(evdev("AltRight").unwrap()));
        assert!(!is_modifier(evdev("KeyA").unwrap()));
    }
}
