//! Viewers' input as Windows receives it: cast-core's [`InputSink`] on SendInput, run on cast-core's input thread.
//!
//! - **Keys** as cast-core defines them: `key` is the character the viewer's layout produced, `code` the physical
//!   key. A character is typed whatever this computer's layout is: on the key that types it here (found with
//!   `VkKeyScanEx` on the focused window's layout, Shift pressed or lifted around it as the character needs, Caps Lock
//!   allowed for), else as a Unicode character (`KEYEVENTF_UNICODE`), which is also how an AltGr character is typed,
//!   with this viewer's Ctrl and Alt lifted around it. Every other key (modifiers, Enter, arrows, F-keys, the keypad,
//!   media and browser keys) is sent as its scancode, read off `code`, with the E0 prefix where the key has one, so
//!   left and right modifiers, the keypad's Enter and the navigation cluster arrive as a real keyboard sends them.
//! - **`text`** is Unicode characters, Enter and Tab as their keys.
//! - **The pointer** is absolute over the virtual desktop (`MOUSEEVENTF_VIRTUALDESK`), the monitor's place on it added
//!   to the picture's point; buttons 1-5 (DOM 0-4); the DOM `buttons` mask lets go of a button whose `up` was lost.
//! - **Scrolling** is the high-resolution wheel: picture pixels become wheel units (120 a notch, a notch being what a
//!   browser here scrolls, 100 px at 100%), fractions carried to the next event by cast-core's `ScrollAcc`, so a
//!   trackpad's small steps add up and an application that takes partial notches scrolls smoothly.
//! - Each viewer's keys and buttons are its own: `releaseAll` (its socket closing) lets go of what it holds and nothing
//!   else; `Shutdown` lets go of everything. `BlockInput` is never used: the person at the computer keeps it.
//!
//! The keys' handling follows voxl's Windows backend (MIT), which typed X keysyms; DOM names and per-viewer state are
//! castd's.

use crate::capture::Geometry;
use crate::clipboard::Clipboard;
use browser_wire::{KeyAction, PointerAction};
use cast_core::input::{InputEvent, InputSink, Mods, NOTCH, ScrollAcc};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// A physical key: its set-1 scancode and whether it carries the E0 prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scan {
    pub code: u16,
    pub ext: bool,
}

const fn s(code: u16) -> Option<Scan> {
    Some(Scan { code, ext: false })
}

const fn e(code: u16) -> Option<Scan> {
    Some(Scan { code, ext: true })
}

/// The scancode of a DOM `KeyboardEvent.code`.
pub fn scan_of(code: &str) -> Option<Scan> {
    if let Some(d) = code
        .strip_prefix("Digit")
        .and_then(|d| d.parse::<u16>().ok())
    {
        return s(if d == 0 { 0x0b } else { 0x01 + d });
    }
    if let Some(f) = code.strip_prefix('F').and_then(|f| f.parse::<u16>().ok()) {
        return match f {
            1..=10 => s(0x3a + f),
            11 => s(0x57),
            12 => s(0x58),
            13..=23 => s(0x64 + (f - 13)),
            24 => s(0x76),
            _ => None,
        };
    }
    if let Some(k) = code.strip_prefix("Key").filter(|k| k.len() == 1) {
        let row = "QWERTYUIOP";
        let home = "ASDFGHJKL";
        let low = "ZXCVBNM";
        return if let Some(i) = row.find(k) {
            s(0x10 + i as u16)
        } else if let Some(i) = home.find(k) {
            s(0x1e + i as u16)
        } else {
            low.find(k).and_then(|i| s(0x2c + i as u16))
        };
    }
    match code {
        "Escape" => s(0x01),
        "Minus" => s(0x0c),
        "Equal" => s(0x0d),
        "Backspace" => s(0x0e),
        "Tab" => s(0x0f),
        "BracketLeft" => s(0x1a),
        "BracketRight" => s(0x1b),
        "Enter" => s(0x1c),
        "ControlLeft" => s(0x1d),
        "Semicolon" => s(0x27),
        "Quote" => s(0x28),
        "Backquote" => s(0x29),
        "ShiftLeft" => s(0x2a),
        "Backslash" => s(0x2b),
        "Comma" => s(0x33),
        "Period" => s(0x34),
        "Slash" => s(0x35),
        "ShiftRight" => s(0x36),
        "NumpadMultiply" => s(0x37),
        "AltLeft" => s(0x38),
        "Space" => s(0x39),
        "CapsLock" => s(0x3a),
        // NumLock is 0x45 with the extended flag as SendInput wants it (VK_NUMLOCK is an extended key).
        "NumLock" => e(0x45),
        "ScrollLock" => s(0x46),
        "Numpad7" => s(0x47),
        "Numpad8" => s(0x48),
        "Numpad9" => s(0x49),
        "NumpadSubtract" => s(0x4a),
        "Numpad4" => s(0x4b),
        "Numpad5" => s(0x4c),
        "Numpad6" => s(0x4d),
        "NumpadAdd" => s(0x4e),
        "Numpad1" => s(0x4f),
        "Numpad2" => s(0x50),
        "Numpad3" => s(0x51),
        "Numpad0" => s(0x52),
        "NumpadDecimal" => s(0x53),
        "IntlBackslash" => s(0x56),
        "KanaMode" => s(0x70),
        "IntlRo" => s(0x73),
        "Convert" => s(0x79),
        "NonConvert" => s(0x7b),
        "IntlYen" => s(0x7d),
        "NumpadEqual" => s(0x59),
        "Pause" => s(0x45),
        "NumpadEnter" => e(0x1c),
        "ControlRight" => e(0x1d),
        "NumpadDivide" => e(0x35),
        "PrintScreen" => e(0x37),
        "AltRight" => e(0x38),
        "Home" => e(0x47),
        "ArrowUp" => e(0x48),
        "PageUp" => e(0x49),
        "ArrowLeft" => e(0x4b),
        "ArrowRight" => e(0x4d),
        "End" => e(0x4f),
        "ArrowDown" => e(0x50),
        "PageDown" => e(0x51),
        "Insert" => e(0x52),
        "Delete" => e(0x53),
        "MetaLeft" | "OSLeft" => e(0x5b),
        "MetaRight" | "OSRight" => e(0x5c),
        "ContextMenu" => e(0x5d),
        "MediaTrackPrevious" => e(0x10),
        "MediaTrackNext" => e(0x19),
        "AudioVolumeMute" => e(0x20),
        "LaunchApp2" => e(0x21),
        "MediaPlayPause" => e(0x22),
        "MediaStop" => e(0x24),
        "AudioVolumeDown" => e(0x2e),
        "AudioVolumeUp" => e(0x30),
        "BrowserHome" => e(0x32),
        "BrowserSearch" => e(0x65),
        "BrowserFavorites" => e(0x66),
        "BrowserRefresh" => e(0x67),
        "BrowserStop" => e(0x68),
        "BrowserForward" => e(0x69),
        "BrowserBack" => e(0x6a),
        "LaunchApp1" => e(0x6b),
        "LaunchMail" => e(0x6c),
        "MediaSelect" => e(0x6d),
        _ => None,
    }
}

/// The virtual key of a named DOM `key` (one that types no character), for a key with no usable `code`, and for the
/// keys whose virtual key no layout derives from the scancode (media and browser keys).
pub fn vk_of(key: &str) -> Option<VIRTUAL_KEY> {
    if let Some(f) = key.strip_prefix('F').and_then(|f| f.parse::<u16>().ok()) {
        return (1..=24).contains(&f).then(|| VIRTUAL_KEY(VK_F1.0 + f - 1));
    }
    Some(match key {
        "Enter" => VK_RETURN,
        "Tab" => VK_TAB,
        "Backspace" => VK_BACK,
        "Escape" => VK_ESCAPE,
        "Delete" => VK_DELETE,
        "Insert" => VK_INSERT,
        "Home" => VK_HOME,
        "End" => VK_END,
        "PageUp" => VK_PRIOR,
        "PageDown" => VK_NEXT,
        "ArrowLeft" => VK_LEFT,
        "ArrowRight" => VK_RIGHT,
        "ArrowUp" => VK_UP,
        "ArrowDown" => VK_DOWN,
        "Shift" => VK_LSHIFT,
        "Control" => VK_LCONTROL,
        "Alt" => VK_LMENU,
        "AltGraph" => VK_RMENU,
        "Meta" | "OS" => VK_LWIN,
        "CapsLock" => VK_CAPITAL,
        "NumLock" => VK_NUMLOCK,
        "ScrollLock" => VK_SCROLL,
        "Pause" => VK_PAUSE,
        "PrintScreen" => VK_SNAPSHOT,
        "ContextMenu" => VK_APPS,
        "AudioVolumeUp" => VK_VOLUME_UP,
        "AudioVolumeDown" => VK_VOLUME_DOWN,
        "AudioVolumeMute" => VK_VOLUME_MUTE,
        "MediaPlayPause" => VK_MEDIA_PLAY_PAUSE,
        "MediaStop" => VK_MEDIA_STOP,
        "MediaTrackNext" => VK_MEDIA_NEXT_TRACK,
        "MediaTrackPrevious" => VK_MEDIA_PREV_TRACK,
        "BrowserBack" => VK_BROWSER_BACK,
        "BrowserForward" => VK_BROWSER_FORWARD,
        "BrowserRefresh" => VK_BROWSER_REFRESH,
        "BrowserStop" => VK_BROWSER_STOP,
        "BrowserSearch" => VK_BROWSER_SEARCH,
        "BrowserFavorites" => VK_BROWSER_FAVORITES,
        "BrowserHome" => VK_BROWSER_HOME,
        "LaunchMail" => VK_LAUNCH_MAIL,
        "LaunchApp1" => VK_LAUNCH_APP1,
        "LaunchApp2" => VK_LAUNCH_APP2,
        "MediaSelect" => VK_LAUNCH_MEDIA_SELECT,
        _ => return None,
    })
}

/// Whether `key` is one character a layout types (not a control character).
fn character(key: &str) -> Option<char> {
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if !c.is_control() => Some(c),
        _ => None,
    }
}

/// The modifier a key is, for the per-viewer bookkeeping of what it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Modifier {
    Ctrl,
    Shift,
    Alt,
}

fn modifier_of(vk: VIRTUAL_KEY) -> Option<Modifier> {
    match vk {
        VK_LCONTROL | VK_RCONTROL | VK_CONTROL => Some(Modifier::Ctrl),
        VK_LSHIFT | VK_RSHIFT | VK_SHIFT => Some(Modifier::Shift),
        VK_LMENU | VK_RMENU | VK_MENU => Some(Modifier::Alt),
        _ => None,
    }
}

/// A key a viewer holds down, as it went down, so its up lets go of the same key.
#[derive(Debug, Clone, Copy)]
struct Held {
    vk: VIRTUAL_KEY,
    scan: u16,
    ext: bool,
    /// Sent as a scancode (a physical key), else as a virtual key with its scancode.
    by_scan: bool,
}

#[derive(Default)]
struct Viewer {
    keys: HashMap<String, Held>,
    /// DOM `buttons` bits this viewer holds.
    buttons: u8,
}

impl Viewer {
    fn holds(&self, m: Modifier) -> Vec<Held> {
        self.keys
            .values()
            .filter(|h| modifier_of(h.vk) == Some(m))
            .copied()
            .collect()
    }
}

/// What goes before a key or a click and what goes after it: modifiers held around it, Shift pressed or lifted.
type Around = (Vec<INPUT>, Vec<INPUT>);

/// SendInput for one monitor's viewers.
pub struct Sink {
    geometry: Arc<Mutex<Geometry>>,
    clipboard: Option<Clipboard>,
    /// Picture pixels a wheel notch scrolls: 100 CSS px at the monitor's scale.
    px_per_notch: f64,
    viewers: HashMap<u64, Viewer>,
    scroll: ScrollAcc,
    refused: bool,
}

impl Sink {
    pub fn new(geometry: Arc<Mutex<Geometry>>, clipboard: Option<Clipboard>, scale: f64) -> Sink {
        Sink {
            geometry,
            clipboard,
            px_per_notch: 100.0 * scale.max(0.5),
            viewers: HashMap::new(),
            scroll: ScrollAcc::default(),
            refused: false,
        }
    }

    fn send(&mut self, inputs: &[INPUT]) {
        if inputs.is_empty() {
            return;
        }
        // SAFETY: a slice of fully initialised INPUTs and their size.
        let n = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) } as usize;
        if n < inputs.len() {
            // Another desktop took input (a UAC prompt), or UIPI refused it (an elevated window has focus).
            crate::follow_input_desktop();
            // SAFETY: as above, the rest.
            let m =
                unsafe { SendInput(&inputs[n..], std::mem::size_of::<INPUT>() as i32) } as usize;
            if n + m < inputs.len() && !self.refused {
                self.refused = true;
                log::warn!(
                    "SendInput refused input ({}): an elevated window has focus, or the desktop is a secure one",
                    std::io::Error::last_os_error()
                );
            }
        } else {
            self.refused = false;
        }
    }

    /// A picture point as SendInput's absolute coordinates over the virtual desktop.
    fn absolute(&self, x: i32, y: i32) -> (i32, i32) {
        let g = *self.geometry.lock();
        // SAFETY: plain metric queries.
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
                GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
            )
        };
        let px = i64::from(g.left + x.clamp(0, g.width.max(1) as i32 - 1) - vx);
        let py = i64::from(g.top + y.clamp(0, g.height.max(1) as i32 - 1) - vy);
        // Windows maps n back to n * size / 65536 pixels: aim at the pixel's centre.
        (
            ((px * 65536 + 32768) / i64::from(vw)) as i32,
            ((py * 65536 + 32768) / i64::from(vh)) as i32,
        )
    }

    fn mouse_to(&self, x: i32, y: i32) -> INPUT {
        let (ax, ay) = self.absolute(x, y);
        mouse(
            ax,
            ay,
            0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn mouse(
        &mut self,
        client: u64,
        action: PointerAction,
        x: i32,
        y: i32,
        button: Option<u8>,
        buttons: Option<u8>,
        mods: Mods,
    ) {
        let mut v = vec![self.mouse_to(x, y)];
        let (before, after) = self.mod_wrap(client, mods);
        // DOM button numbers to their `buttons` bits: 0 left 1, 1 middle 4, 2 right 2, 3 back 8, 4 forward 16.
        let bit = |b: u8| match b {
            0 => 1u8,
            1 => 4,
            2 => 2,
            3 => 8,
            4 => 16,
            _ => 0,
        };
        let viewer = self.viewers.entry(client).or_default();
        let mut changes: Vec<(u8, bool)> = Vec::new();
        if let (Some(b), PointerAction::Down | PointerAction::Up) = (button, action) {
            let down = action == PointerAction::Down;
            let held = viewer.buttons & bit(b) != 0;
            if down != held {
                changes.push((bit(b), down));
            }
        }
        // A button this viewer holds that its `buttons` says is up: its `up` was lost.
        if let Some(mask) = buttons {
            for b in [1u8, 2, 4, 8, 16] {
                if viewer.buttons & b != 0 && mask & b == 0 && !changes.iter().any(|(c, _)| *c == b)
                {
                    changes.push((b, false));
                }
            }
        }
        for (b, down) in &changes {
            if *down {
                viewer.buttons |= b;
            } else {
                viewer.buttons &= !b;
            }
        }
        v.extend(before);
        for (b, down) in changes {
            v.push(button_input(b, down));
        }
        v.extend(after);
        self.send(&v);
    }

    fn scroll(&mut self, x: i32, y: i32, dx: f64, dy: f64) {
        let k = NOTCH / self.px_per_notch;
        // DOM: positive dy scrolls down, dx right. The wheel: positive scrolls up (away), the tilt wheel right.
        let (nx, ny) = self.scroll.take(dx * k, -dy * k, 1.0);
        let mut v = vec![self.mouse_to(x, y)];
        let clamp = |n: i64| n.clamp(-(NOTCH as i64) * 50, NOTCH as i64 * 50) as i32;
        if ny != 0 {
            v.push(mouse(0, 0, clamp(ny), MOUSEEVENTF_WHEEL));
        }
        if nx != 0 {
            v.push(mouse(0, 0, clamp(nx), MOUSEEVENTF_HWHEEL));
        }
        if v.len() > 1 {
            self.send(&v);
        }
    }

    /// What a key event's modifier flags press before it and let go after: Some(true) holds one this viewer does not;
    /// Some(false) lets go of one it holds, stranded.
    fn mod_wrap(&mut self, client: u64, mods: Mods) -> Around {
        let (mut before, mut after) = (Vec::new(), Vec::new());
        let viewer = self.viewers.entry(client).or_default();
        for (flag, m, vk) in [
            (mods.ctrl, Modifier::Ctrl, VK_LCONTROL),
            (mods.shift, Modifier::Shift, VK_LSHIFT),
            (mods.alt, Modifier::Alt, VK_LMENU),
        ] {
            let held = viewer.holds(m);
            match flag {
                Some(true) if held.is_empty() => {
                    before.push(vk_input(vk, false, true));
                    after.push(vk_input(vk, false, false));
                }
                Some(false) if !held.is_empty() => {
                    for h in held {
                        before.push(key_input(h, false));
                        viewer.keys.retain(|_, k| k.vk != h.vk);
                    }
                }
                _ => {}
            }
        }
        after.reverse();
        (before, after)
    }

    #[allow(clippy::too_many_arguments)]
    fn key(
        &mut self,
        client: u64,
        key: &str,
        code: Option<&str>,
        id: &str,
        action: KeyAction,
        mods: Mods,
        altgr: bool,
    ) {
        if action == KeyAction::Up {
            let held = self.viewers.entry(client).or_default().keys.remove(id);
            if let Some(h) = held {
                self.send(&[key_input(h, false)]);
            }
            return;
        }
        let down_only = action == KeyAction::Down;
        // An AltGr character: lift this viewer's Ctrl and Alt, type the character, put them back.
        if altgr && let Some(c) = character(key) {
            let viewer = self.viewers.entry(client).or_default();
            let lifted: Vec<Held> = [Modifier::Ctrl, Modifier::Alt]
                .into_iter()
                .flat_map(|m| viewer.holds(m))
                .collect();
            let mut v: Vec<INPUT> = lifted.iter().map(|h| key_input(*h, false)).collect();
            v.extend(unicode(c));
            v.extend(lifted.iter().map(|h| key_input(*h, true)));
            self.send(&v);
            return;
        }
        let physical = code.and_then(scan_of);
        let ch = character(key);
        // The keypad's digits and operators stay the keypad's keys, whatever character they made.
        let keypad = code.is_some_and(|c| c.starts_with("Numpad"));
        let typed = match (ch, keypad) {
            (Some(c), false) => self.typed(client, c, mods),
            _ => None,
        };
        let (before, after) = self.mod_wrap(client, mods);
        let mut v = before;
        let held = match typed {
            Some((h, shift_fix)) => {
                // The character's own key on this layout, Shift as the character needs around its down.
                v.extend(shift_fix.0);
                v.push(key_input(h, true));
                v.extend(shift_fix.1);
                Some(h)
            }
            None => match (physical, ch) {
                (Some(scan), _) => {
                    let vk = vk_of(key)
                        .filter(|_| ch.is_none())
                        .or_else(|| layout_vk(scan))
                        .unwrap_or(VIRTUAL_KEY(0));
                    let h = Held {
                        vk,
                        scan: scan.code,
                        ext: scan.ext,
                        by_scan: vk_of(key).is_none() || modifier_of(vk).is_some() || keypad,
                    };
                    v.push(key_input(h, true));
                    Some(h)
                }
                (None, Some(c)) => {
                    v.extend(unicode(c));
                    None
                }
                (None, None) => vk_of(key).map(|vk| {
                    // SAFETY: a plain table lookup on the focused window's layout.
                    let scan = unsafe {
                        MapVirtualKeyExW(u32::from(vk.0), MAPVK_VK_TO_VSC_EX, Some(layout()))
                    };
                    let h = Held {
                        vk,
                        scan: (scan & 0xff) as u16,
                        ext: scan & 0xff00 == 0xe000 || extended_vk(vk),
                        by_scan: false,
                    };
                    v.push(key_input(h, true));
                    h
                }),
            },
        };
        if let Some(h) = held {
            if down_only {
                self.viewers
                    .entry(client)
                    .or_default()
                    .keys
                    .insert(id.to_string(), h);
            } else {
                v.push(key_input(h, false));
            }
        }
        v.extend(after);
        self.send(&v);
    }

    /// Where character `c` is on this computer's layout, with the Shift presses or lifts around its down that type it
    /// as the viewer sees it; None where the layout cannot type it with Shift alone (it is typed as Unicode then).
    fn typed(&mut self, client: u64, c: char, mods: Mods) -> Option<(Held, Around)> {
        let mut units = [0u16; 2];
        if c.encode_utf16(&mut units).len() != 1 {
            return None;
        }
        let hkl = layout();
        // SAFETY: a plain table lookup on the focused window's layout.
        let r = unsafe { VkKeyScanExW(units[0], hkl) };
        if r == -1 {
            return None;
        }
        let vk = VIRTUAL_KEY((r as u16) & 0xff);
        let need = ((r as u16) >> 8) & 0xff;
        let viewer = self.viewers.entry(client).or_default();
        let ctrl = !viewer.holds(Modifier::Ctrl).is_empty() || mods.ctrl == Some(true);
        let alt = !viewer.holds(Modifier::Alt).is_empty() || mods.alt == Some(true);
        let shortcut = ctrl || alt;
        // Ctrl or Alt to type it is AltGr on this layout: Unicode instead, unless it is a shortcut being pressed.
        if need & 6 != 0 && !shortcut {
            return None;
        }
        // SAFETY: as above.
        let scan = unsafe { MapVirtualKeyExW(u32::from(vk.0), MAPVK_VK_TO_VSC_EX, Some(hkl)) };
        let h = Held {
            vk,
            scan: (scan & 0xff) as u16,
            ext: scan & 0xff00 == 0xe000,
            by_scan: false,
        };
        if shortcut {
            // Ctrl+C is the C key with Ctrl held, as held: Shift stays as the viewer has it.
            return Some((h, (Vec::new(), Vec::new())));
        }
        let mut want_shift = need & 1 != 0;
        // Caps Lock here flips Shift on letters: the viewer already sent the character cased.
        // SAFETY: a plain state query.
        let caps = unsafe { GetKeyState(i32::from(VK_CAPITAL.0)) } & 1 != 0;
        if caps && c.is_alphabetic() && c.to_uppercase().ne(c.to_lowercase()) {
            want_shift = !want_shift;
        }
        let shifts = viewer.holds(Modifier::Shift);
        let held_shift = !shifts.is_empty() || mods.shift == Some(true);
        let fix = match (want_shift, held_shift) {
            (true, false) => (
                vec![vk_input(VK_LSHIFT, false, true)],
                vec![vk_input(VK_LSHIFT, false, false)],
            ),
            (false, true) => (
                shifts.iter().map(|s| key_input(*s, false)).collect(),
                shifts.iter().map(|s| key_input(*s, true)).collect(),
            ),
            _ => (Vec::new(), Vec::new()),
        };
        Some((h, fix))
    }

    fn text(&mut self, text: &str) {
        let mut v = Vec::new();
        for c in text.chars() {
            match c {
                '\n' => v.extend([
                    vk_input(VK_RETURN, false, true),
                    vk_input(VK_RETURN, false, false),
                ]),
                '\r' => {}
                '\t' => v.extend([
                    vk_input(VK_TAB, false, true),
                    vk_input(VK_TAB, false, false),
                ]),
                c => v.extend(unicode(c)),
            }
        }
        self.send(&v);
    }

    fn release(&mut self, client: u64) {
        let Some(viewer) = self.viewers.remove(&client) else {
            return;
        };
        let mut v: Vec<INPUT> = viewer.keys.values().map(|h| key_input(*h, false)).collect();
        for b in [1u8, 2, 4, 8, 16] {
            if viewer.buttons & b != 0 {
                v.push(button_input(b, false));
            }
        }
        self.send(&v);
    }
}

impl InputSink for Sink {
    fn types_key(key: &str, code: Option<&str>) -> bool {
        match key {
            "Dead" | "Process" | "Compose" => false,
            "Unidentified" => code.and_then(scan_of).is_some(),
            k => character(k).is_some() || vk_of(k).is_some() || code.and_then(scan_of).is_some(),
        }
    }

    fn handle(&mut self, ev: InputEvent) {
        match ev {
            InputEvent::Mouse {
                client,
                action,
                x,
                y,
                button,
                buttons,
                mods,
            } => self.mouse(client, action, x, y, button, buttons, mods),
            InputEvent::Scroll { x, y, dx, dy } => self.scroll(x, y, dx, dy),
            InputEvent::Key {
                client,
                key,
                code,
                id,
                action,
                mods,
                altgr,
            } => self.key(client, &key, code.as_deref(), &id, action, mods, altgr),
            InputEvent::Text { text } => self.text(&text),
            InputEvent::Clipboard(content) => {
                if let Some(c) = &self.clipboard {
                    c.set(content);
                }
            }
            InputEvent::ReleaseAll { client } => self.release(client),
            InputEvent::Shutdown => {
                let clients: Vec<u64> = self.viewers.keys().copied().collect();
                for c in clients {
                    self.release(c);
                }
            }
        }
    }
}

/// Starts the input thread for one monitor.
pub fn spawn(
    geometry: Arc<Mutex<Geometry>>,
    clipboard: Option<Clipboard>,
    scale: f64,
) -> Result<cast_core::input::Input, String> {
    crate::follow_input_desktop();
    cast_core::input::spawn(Sink::new(geometry, clipboard, scale))
}

/// The keyboard layout of the window that has focus (layouts are per thread).
fn layout() -> HKL {
    // SAFETY: plain queries.
    unsafe {
        let tid = GetWindowThreadProcessId(GetForegroundWindow(), None);
        GetKeyboardLayout(tid)
    }
}

/// The virtual key this layout gives a scancode.
fn layout_vk(scan: Scan) -> Option<VIRTUAL_KEY> {
    let code = u32::from(scan.code) | if scan.ext { 0xe000 } else { 0 };
    // SAFETY: a plain table lookup.
    let vk = unsafe { MapVirtualKeyExW(code, MAPVK_VSC_TO_VK_EX, Some(layout())) };
    (vk != 0).then_some(VIRTUAL_KEY(vk as u16))
}

/// Keys that carry the E0 prefix whatever the layout's table says.
fn extended_vk(vk: VIRTUAL_KEY) -> bool {
    matches!(
        vk,
        VK_RCONTROL
            | VK_RMENU
            | VK_LWIN
            | VK_RWIN
            | VK_APPS
            | VK_INSERT
            | VK_DELETE
            | VK_HOME
            | VK_END
            | VK_PRIOR
            | VK_NEXT
            | VK_LEFT
            | VK_RIGHT
            | VK_UP
            | VK_DOWN
            | VK_DIVIDE
            | VK_NUMLOCK
            | VK_SNAPSHOT
    )
}

fn key_input(h: Held, down: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if h.ext {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    // A physical key goes as its scancode alone, as a keyboard sends it: Windows reads the virtual key off this
    // computer's layout, and raw input (games) sees the scancode.
    let vk = if h.by_scan {
        flags |= KEYEVENTF_SCANCODE;
        VIRTUAL_KEY(0)
    } else {
        h.vk
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: h.scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn vk_input(vk: VIRTUAL_KEY, ext: bool, down: bool) -> INPUT {
    // SAFETY: a plain table lookup.
    let scan = unsafe { MapVirtualKeyExW(u32::from(vk.0), MAPVK_VK_TO_VSC, Some(layout())) };
    key_input(
        Held {
            vk,
            scan: scan as u16,
            ext: ext || extended_vk(vk),
            by_scan: false,
        },
        down,
    )
}

/// A character as Unicode key events: down and up of each UTF-16 unit.
fn unicode(c: char) -> Vec<INPUT> {
    let mut units = [0u16; 2];
    let mut v = Vec::new();
    for &u in c.encode_utf16(&mut units).iter() {
        for up in [false, true] {
            v.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: u,
                        dwFlags: if up {
                            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                        } else {
                            KEYEVENTF_UNICODE
                        },
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }
    v
}

fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// A button's DOM `buttons` bit going down or up.
fn button_input(bit: u8, down: bool) -> INPUT {
    let (flags, data) = match (bit, down) {
        (1, true) => (MOUSEEVENTF_LEFTDOWN, 0),
        (1, false) => (MOUSEEVENTF_LEFTUP, 0),
        (2, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
        (2, false) => (MOUSEEVENTF_RIGHTUP, 0),
        (4, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        (4, false) => (MOUSEEVENTF_MIDDLEUP, 0),
        (8, true) => (MOUSEEVENTF_XDOWN, 1),
        (8, false) => (MOUSEEVENTF_XUP, 1),
        (16, true) => (MOUSEEVENTF_XDOWN, 2),
        _ => (MOUSEEVENTF_XUP, 2),
    };
    mouse(0, 0, data, flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dom_codes_map_to_set_one_scancodes_with_their_prefix() {
        assert_eq!(scan_of("KeyA"), s(0x1e));
        assert_eq!(scan_of("KeyQ"), s(0x10));
        assert_eq!(scan_of("KeyM"), s(0x32));
        assert_eq!(scan_of("Digit1"), s(0x02));
        assert_eq!(scan_of("Digit0"), s(0x0b));
        assert_eq!(scan_of("F1"), s(0x3b));
        assert_eq!(scan_of("F10"), s(0x44));
        assert_eq!(scan_of("F11"), s(0x57));
        assert_eq!(scan_of("F13"), s(0x64));
        assert_eq!(scan_of("Enter"), s(0x1c));
        assert_eq!(scan_of("NumpadEnter"), e(0x1c));
        assert_eq!(scan_of("ControlRight"), e(0x1d));
        assert_eq!(scan_of("AltRight"), e(0x38));
        assert_eq!(scan_of("ArrowLeft"), e(0x4b));
        assert_eq!(
            scan_of("Numpad4"),
            s(0x4b),
            "the keypad's 4 is the left arrow's code without E0"
        );
        assert_eq!(scan_of("AudioVolumeUp"), e(0x30));
        assert_eq!(scan_of("Nonsense"), None);
    }

    #[test]
    fn what_types_nothing_is_not_taken() {
        assert!(Sink::types_key("a", Some("KeyA")));
        assert!(Sink::types_key("ą", Some("KeyA")));
        assert!(Sink::types_key("Enter", Some("Enter")));
        assert!(Sink::types_key("AudioVolumeUp", None));
        assert!(!Sink::types_key("Dead", Some("BracketLeft")));
        assert!(!Sink::types_key("Process", None));
        assert!(Sink::types_key("Unidentified", Some("F13")));
        assert!(!Sink::types_key("Unidentified", None));
    }
}
