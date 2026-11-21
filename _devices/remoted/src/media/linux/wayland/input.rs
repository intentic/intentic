//! Viewers' input on a Wayland session, through the portal's RemoteDesktop: pointer motion in the stream's own
//! coordinates (`NotifyPointerMotionAbsolute`), buttons as evdev codes, wheel notches, and keys by the viewer's
//! physical `code` (`NotifyKeyboardKeycode`), so the compositor applies the person's own layout as it does to their
//! keyboard. What has no physical key (an IME's text, a key the browser could not place, an AltGr character) is typed
//! by its keysym (`NotifyKeyboardKeysym`). What each viewer holds is tracked per viewer, as on X11.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use browser_wire::{KeyAction, PointerAction};
use cast_core::input::{InputEvent, InputSink, MAX_SCROLL_PX, Mods, NOTCH, ScrollAcc};
use zbus::zvariant::{ObjectPath, Value};

use super::keycodes;
use super::portal::{Session, StreamInfo};

/// Picture pixels a wheel notch scrolls, as on X11.
const PX_PER_NOTCH: f64 = 120.0;

/// evdev's buttons.
const BTN_LEFT: i32 = 0x110;
const BTN_RIGHT: i32 = 0x111;
const BTN_MIDDLE: i32 = 0x112;
const BTN_SIDE: i32 = 0x113;
const BTN_EXTRA: i32 = 0x114;

const KEY_LEFTCTRL: u32 = 29;
/// A key no layout gives a symbol (`KEY_UNKNOWN`): what the session's first key event is spent on.
const KEY_UNKNOWN: u32 = 240;
const KEY_LEFTSHIFT: u32 = 42;
const KEY_LEFTALT: u32 = 56;

/// A key a viewer holds, as it was pressed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Pressed {
    Code(u32),
    Sym(u32),
}

pub struct WaylandInput {
    session: Arc<Session>,
    runtime: tokio::runtime::Handle,
    stream: StreamInfo,
    /// The picture's size in pixels (the stream's buffers'), which viewers' points are in.
    picture: Arc<Mutex<(u32, u32)>>,
    /// Keys held: (viewer, key id) to what was pressed.
    keys: HashMap<(u64, String), Pressed>,
    buttons: HashMap<i32, u64>,
    scroll: ScrollAcc,
    /// Whether the compositor has had its first key: mutter (GNOME 48) drops the first key event of a remote desktop
    /// session (measured: the first of `a`, `a`, `1`, Enter never reached the focused window, the rest did), so one
    /// that types nothing goes first, with the session's first input of any kind.
    primed: bool,
}

fn dom_button(b: u8) -> Option<i32> {
    Some(match b {
        0 => BTN_LEFT,
        1 => BTN_MIDDLE,
        2 => BTN_RIGHT,
        3 => BTN_SIDE,
        4 => BTN_EXTRA,
        _ => return None,
    })
}

fn dom_bit(b: i32) -> u8 {
    match b {
        BTN_LEFT => 1,
        BTN_RIGHT => 2,
        BTN_MIDDLE => 4,
        BTN_SIDE => 8,
        BTN_EXTRA => 16,
        _ => 0,
    }
}

fn no_options() -> HashMap<&'static str, Value<'static>> {
    HashMap::new()
}

impl WaylandInput {
    pub fn new(
        session: Arc<Session>,
        runtime: tokio::runtime::Handle,
        stream: StreamInfo,
        picture: Arc<Mutex<(u32, u32)>>,
    ) -> WaylandInput {
        WaylandInput {
            session,
            runtime,
            stream,
            picture,
            keys: HashMap::new(),
            buttons: HashMap::new(),
            scroll: ScrollAcc::default(),
            primed: false,
        }
    }

    fn path(&self) -> ObjectPath<'_> {
        self.session.handle.as_ref()
    }

    fn keycode(&self, code: u32, down: bool) {
        let body = (self.path(), no_options(), code as i32, down as u32);
        self.runtime
            .block_on(self.session.notify("NotifyKeyboardKeycode", &body));
    }

    fn keysym(&self, sym: u32, down: bool) {
        let body = (self.path(), no_options(), sym as i32, down as u32);
        self.runtime
            .block_on(self.session.notify("NotifyKeyboardKeysym", &body));
    }

    fn press(&self, p: Pressed, down: bool) {
        match p {
            Pressed::Code(c) => self.keycode(c, down),
            Pressed::Sym(s) => self.keysym(s, down),
        }
    }

    /// Moves the pointer to a picture point, in the stream's logical coordinates (a scaled monitor's differ).
    fn motion(&self, x: i32, y: i32) {
        let (pw, ph) = *self.picture.lock().expect("picture poisoned");
        let (lw, lh) = self.stream.size;
        let sx = if pw > 0 && lw > 0 {
            f64::from(lw) / f64::from(pw)
        } else {
            1.0
        };
        let sy = if ph > 0 && lh > 0 {
            f64::from(lh) / f64::from(ph)
        } else {
            1.0
        };
        let body = (
            self.path(),
            no_options(),
            self.stream.node,
            f64::from(x.max(0)) * sx,
            f64::from(y.max(0)) * sy,
        );
        self.runtime
            .block_on(self.session.notify("NotifyPointerMotionAbsolute", &body));
    }

    fn button(&self, b: i32, down: bool) {
        let body = (self.path(), no_options(), b, down as u32);
        self.runtime
            .block_on(self.session.notify("NotifyPointerButton", &body));
    }

    /// Holds or lets go of Ctrl, Shift and Alt the way `mods` says, for one event: the keys pressed only for it.
    fn apply_mods(&mut self, client: u64, mods: Mods, skip: Option<u32>) -> Vec<u32> {
        let families: [(Option<bool>, [u32; 2], u32); 3] = [
            (mods.ctrl, [KEY_LEFTCTRL, 97], KEY_LEFTCTRL),
            (mods.shift, [KEY_LEFTSHIFT, 54], KEY_LEFTSHIFT),
            (mods.alt, [KEY_LEFTALT, 100], KEY_LEFTALT),
        ];
        let mut added = Vec::new();
        for (flag, family, left) in families {
            if skip.is_some_and(|s| family.contains(&s)) {
                continue;
            }
            let held: Vec<(u64, String)> = self
                .keys
                .iter()
                .filter(|(_, p)| matches!(p, Pressed::Code(c) if family.contains(c)))
                .map(|(k, _)| k.clone())
                .collect();
            match flag {
                Some(true) if held.is_empty() => {
                    self.keycode(left, true);
                    added.push(left);
                }
                Some(false) => {
                    for key in held.into_iter().filter(|(c, _)| *c == client) {
                        if let Some(p) = self.keys.remove(&key) {
                            self.press(p, false);
                        }
                    }
                }
                _ => {}
            }
        }
        added
    }

    fn release_added(&self, added: Vec<u32>) {
        for k in added.into_iter().rev() {
            self.keycode(k, false);
        }
    }

    fn mouse(
        &mut self,
        client: u64,
        action: PointerAction,
        (x, y): (i32, i32),
        button: Option<u8>,
        buttons: Option<u8>,
        mods: Mods,
    ) {
        let b = button.and_then(dom_button);
        if let Some(mask) = buttons {
            let stranded: Vec<i32> = self
                .buttons
                .iter()
                .filter(|&(&held, &c)| c == client && Some(held) != b && mask & dom_bit(held) == 0)
                .map(|(&held, _)| held)
                .collect();
            for held in stranded {
                self.buttons.remove(&held);
                self.button(held, false);
            }
        }
        self.motion(x, y);
        let down = match action {
            PointerAction::Down => true,
            PointerAction::Up => false,
            PointerAction::Move | PointerAction::Wheel => return,
        };
        let Some(b) = b else { return };
        if down == self.buttons.contains_key(&b) {
            return;
        }
        let added = self.apply_mods(client, mods, None);
        if down {
            self.buttons.insert(b, client);
        } else {
            self.buttons.remove(&b);
        }
        self.button(b, down);
        self.release_added(added);
    }

    fn scroll(&mut self, (x, y): (i32, i32), dx: f64, dy: f64) {
        self.motion(x, y);
        let clean = |d: f64| {
            if d.is_finite() {
                d.clamp(-MAX_SCROLL_PX, MAX_SCROLL_PX)
            } else {
                0.0
            }
        };
        let units = NOTCH / PX_PER_NOTCH;
        let (nx, ny) = self
            .scroll
            .take(clean(dx) * units, clean(dy) * units, NOTCH);
        for (axis, steps) in [(0u32, ny), (1u32, nx)] {
            if steps != 0 {
                let body = (
                    self.path(),
                    no_options(),
                    axis,
                    steps.clamp(-1000, 1000) as i32,
                );
                self.runtime
                    .block_on(self.session.notify("NotifyPointerAxisDiscrete", &body));
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn key(
        &mut self,
        client: u64,
        key: &str,
        code: Option<&str>,
        id: String,
        action: KeyAction,
        mods: Mods,
        altgr: bool,
    ) {
        if action == KeyAction::Up {
            if let Some(p) = self.keys.remove(&(client, id)) {
                self.press(p, false);
            }
            return;
        }
        // A character AltGr made is typed by itself, the viewer's Ctrl and Alt lifted around it.
        let pressed = match code.and_then(keycodes::evdev) {
            Some(c) if !altgr => Pressed::Code(c),
            _ => match cast_x11::keys::key_keysym(key, code) {
                Some(sym) => Pressed::Sym(sym),
                None => return,
            },
        };
        let lifted: Vec<(u64, String)> = if altgr {
            self.keys
                .iter()
                .filter(|((c, _), p)| {
                    *c == client && matches!(p, Pressed::Code(k) if matches!(k, 29 | 97 | 56 | 100))
                })
                .map(|(k, _)| k.clone())
                .collect()
        } else {
            Vec::new()
        };
        for k in &lifted {
            if let Some(p) = self.keys.get(k) {
                self.press(*p, false);
            }
        }
        let skip = match pressed {
            Pressed::Code(c) if keycodes::is_modifier(c) => Some(c),
            _ => None,
        };
        let added = if altgr {
            Vec::new()
        } else {
            self.apply_mods(client, mods, skip)
        };
        self.press(pressed, true);
        if action == KeyAction::Press {
            self.press(pressed, false);
        } else if let Some(previous) = self.keys.insert((client, id), pressed)
            && previous != pressed
        {
            self.press(previous, false);
        }
        self.release_added(added);
        for k in &lifted {
            if let Some(p) = self.keys.get(k) {
                self.press(*p, true);
            }
        }
    }

    fn text(&self, text: &str) {
        for c in text.chars() {
            if let Some(sym) = cast_x11::keys::char_keysym(c) {
                self.keysym(sym, true);
                self.keysym(sym, false);
            }
        }
    }

    fn release_all(&mut self, client: Option<u64>) {
        let keys: Vec<(u64, String)> = self
            .keys
            .keys()
            .filter(|(c, _)| client.is_none_or(|w| w == *c))
            .cloned()
            .collect();
        for k in keys {
            if let Some(p) = self.keys.remove(&k) {
                self.press(p, false);
            }
        }
        let buttons: Vec<i32> = self
            .buttons
            .iter()
            .filter(|&(_, &c)| client.is_none_or(|w| w == c))
            .map(|(&b, _)| b)
            .collect();
        for b in buttons {
            self.buttons.remove(&b);
            self.button(b, false);
        }
    }
}

impl InputSink for WaylandInput {
    fn types_key(key: &str, code: Option<&str>) -> bool {
        code.and_then(keycodes::evdev).is_some() || cast_x11::keys::key_keysym(key, code).is_some()
    }

    fn handle(&mut self, ev: InputEvent) {
        if !self.primed {
            self.primed = true;
            self.keycode(KEY_UNKNOWN, true);
            self.keycode(KEY_UNKNOWN, false);
        }
        match ev {
            InputEvent::Mouse {
                client,
                action,
                x,
                y,
                button,
                buttons,
                mods,
            } => self.mouse(client, action, (x, y), button, buttons, mods),
            InputEvent::Scroll { x, y, dx, dy } => self.scroll((x, y), dx, dy),
            InputEvent::Key {
                client,
                key,
                code,
                id,
                action,
                mods,
                altgr,
            } => self.key(client, &key, code.as_deref(), id, action, mods, altgr),
            InputEvent::Text { text } => self.text(&text),
            // The portal's clipboard is not wired yet: a viewer's copy stays theirs.
            InputEvent::Clipboard(_) => {}
            InputEvent::ReleaseAll { client } => self.release_all(Some(client)),
            InputEvent::Shutdown => self.release_all(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dom_buttons_are_evdevs_and_their_bits_match() {
        for b in 0..5u8 {
            let code = dom_button(b).unwrap();
            assert_eq!(dom_bit(code), [1, 4, 2, 8, 16][b as usize]);
        }
        assert_eq!(dom_button(5), None);
    }
}
