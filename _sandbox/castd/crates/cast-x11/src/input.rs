//! Input injection through XTEST: cast-core's input sink on an X display, run on cast-core's input thread so it stays
//! in order with the clipboard (a paste is the clipboard, then Ctrl+V). DOM keys become keysyms (keys.rs) resolved
//! against the server's keymap, falling back to spare keycodes remapped on the fly for symbols the layout lacks (voxl's
//! scheme). What each viewer holds down is tracked per viewer, so one viewer's `releaseAll` (or its socket closing)
//! lets go of its own keys and buttons only.

use crate::keys;
use browser_wire::{KeyAction, PointerAction};
use cast_core::input::{Input, InputEvent, InputSink, MAX_SCROLL_PX, Mods, NOTCH, ScrollAcc};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{self, ConnectionExt as _};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

enum ShiftFix {
    None,
    /// Symbol lives on the shifted level but no Shift is held.
    Add,
    /// Symbol lives on the plain level but Shift is held.
    Lift,
}

/// Where castd notes the spare keycodes it remapped, to undo them after a crash: one file per display and session, since
/// several castds (one per window region) can share a desktop and must not undo each other's.
fn scratch_file(display: Option<&str>, session: &str) -> std::path::PathBuf {
    let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    let d = display.unwrap_or(":0").replace([':', '/'], "_");
    std::path::Path::new(&dir).join(format!("castd-keymap{d}-{session}"))
}

/// X keycodes (evdev + 8) with no entry in Chromium's DOM code table: a remapped one cannot be mistaken for a physical
/// key that has a meaning of its own (a "New" key would open tabs instead of typing).
const SAFE_SCRATCH: &[u8] = &[
    92, 109, 120, 126, 138, 147, 149, 153, 154, 155, 156, 157, 159, 161, 162, 165, 168, 170, 178,
    183, 184, 185, 186, 203, 204, 205, 206, 207, 208, 210, 211, 213, 219, 220, 221, 222, 223, 224,
    226, 227, 228, 229, 230, 231, 234, 235, 244, 245, 246, 247, 248, 249, 250, 251, 253, 254, 255,
];

/// Smooth scrolling through relative motion on the XTEST pointer's scroll axes. Stock X servers give that device no
/// scroll axes; Xvfb built with patches/xorg-server-xtest-scroll.patch does.
struct SmoothScroll {
    device: u16,
    vaxis: u8,
    haxis: u8,
    xtest_opcode: u8,
    xi_first_event: u8,
}

impl SmoothScroll {
    fn detect(conn: &RustConnection) -> Option<Self> {
        use x11rb::connection::RequestConnection;
        use x11rb::protocol::xinput::{self, ConnectionExt as _, DeviceClassData, ScrollType};
        let xtest = conn
            .extension_information(x11rb::protocol::xtest::X11_EXTENSION_NAME)
            .ok()??;
        let xi = conn
            .extension_information(xinput::X11_EXTENSION_NAME)
            .ok()??;
        conn.xinput_xi_query_version(2, 2).ok()?.reply().ok()?;
        let reply = conn
            .xinput_xi_query_device(xinput::Device::ALL)
            .ok()?
            .reply()
            .ok()?;
        for dev in reply.infos {
            if !String::from_utf8_lossy(&dev.name).contains("XTEST pointer") {
                continue;
            }
            let (mut v, mut h) = (None, None);
            for class in &dev.classes {
                if let DeviceClassData::Scroll(sc) = &class.data {
                    match sc.scroll_type {
                        ScrollType::VERTICAL => v = Some(sc.number as u8),
                        ScrollType::HORIZONTAL => h = Some(sc.number as u8),
                        _ => {}
                    }
                }
            }
            if let (Some(vaxis), Some(haxis)) = (v.filter(|&a| a < 6), h.filter(|&a| a < 6)) {
                return Some(SmoothScroll {
                    device: dev.deviceid,
                    vaxis,
                    haxis,
                    xtest_opcode: xtest.major_opcode,
                    xi_first_event: xi.first_event,
                });
            }
        }
        None
    }

    /// XTestFakeInput with an XI DeviceMotionNotify (relative) followed by a DeviceValuator event carrying the scroll
    /// deltas. x11rb's FakeInput helper cannot attach valuator events, so the request is assembled here.
    fn send(&self, conn: &RustConnection, vertical: i32, horizontal: i32) {
        use x11rb::connection::RequestConnection;
        // Always start at axis 0: XTest stores valuators at absolute indices but builds the event mask relative to the
        // first one, so a non-zero first valuator loses the values. x/y get relative 0 (no pointer motion).
        let n = self.vaxis.max(self.haxis) as usize + 1;
        let mut vals = [0i32; 6];
        vals[self.vaxis as usize] = vertical;
        vals[self.haxis as usize] = horizontal;
        let mut req = Vec::with_capacity(4 + 64);
        req.extend_from_slice(&[self.xtest_opcode, 2, 17, 0]); // FakeInput, 68 bytes = 17 words
        let mut ev = [0u8; 32];
        ev[0] = self.xi_first_event + 5; // XI DeviceMotionNotify
        ev[1] = 1; // relative
        ev[31] = self.device as u8;
        req.extend_from_slice(&ev);
        let mut dv = [0u8; 32];
        dv[0] = self.xi_first_event; // XI DeviceValuator
        dv[1] = self.device as u8;
        dv[6] = n as u8; // num_valuators
        dv[7] = 0; // first_valuator
        for (i, v) in vals.iter().take(n).enumerate() {
            dv[8 + i * 4..12 + i * 4].copy_from_slice(&v.to_ne_bytes());
        }
        req.extend_from_slice(&dv);
        let _ = conn.send_request_without_reply(&[std::io::IoSlice::new(&req)], vec![]);
    }
}

/// A key a viewer holds: the keycode pressed and the keysym it typed.
#[derive(Clone, Copy)]
struct Held {
    kc: u8,
    keysym: u32,
}

/// The X button for a DOM button number.
pub fn x_button(dom: u8) -> Option<u8> {
    match dom {
        0 => Some(1),
        1 => Some(2),
        2 => Some(3),
        3 => Some(8),
        4 => Some(9),
        _ => None,
    }
}

/// The DOM `buttons` bit for an X button.
fn dom_bit(x: u8) -> u8 {
    match x {
        1 => 1,
        3 => 2,
        2 => 4,
        8 => 8,
        9 => 16,
        _ => 0,
    }
}

/// XTEST on one display, as cast-core's input sink.
pub struct Injector {
    conn: RustConnection,
    root: u32,
    min_kc: u8,
    per: usize,
    syms: Vec<u32>,
    lookup: HashMap<u32, (u8, usize)>,
    scratch: Vec<u8>,
    /// keysym -> scratch keycode currently mapped (with last-use time).
    scratch_map: HashMap<u32, (u8, Instant)>,
    /// What each viewer holds: (viewer, key id) -> key.
    pressed: HashMap<(u64, String), Held>,
    /// X buttons down, and the viewer holding each.
    buttons: HashMap<u8, u64>,
    clipboard: Option<crate::desktop::ClipboardHandle>,
    smooth: Option<SmoothScroll>,
    scroll: ScrollAcc,
    /// CSS pixels one wheel notch scrolls the page; times the hub's scale, picture pixels.
    css_px_per_notch: f64,
    hub: Arc<cast_core::hub::Hub>,
    shift_kc: u8,
    scratch_path: std::path::PathBuf,
}

impl Injector {
    fn new(
        display: Option<&str>,
        session: &str,
        hub: Arc<cast_core::hub::Hub>,
    ) -> Result<Self, String> {
        let (conn, n) = RustConnection::connect(display).map_err(|e| e.to_string())?;
        let root = conn.setup().roots[n].root;
        let min_kc = conn.setup().min_keycode;
        let max_kc = conn.setup().max_keycode;
        let mut me = Injector {
            conn,
            root,
            min_kc,
            per: 0,
            syms: vec![],
            lookup: HashMap::new(),
            scratch: vec![],
            scratch_map: HashMap::new(),
            pressed: HashMap::new(),
            buttons: HashMap::new(),
            clipboard: None,
            smooth: None,
            scroll: ScrollAcc::default(),
            css_px_per_notch: 120.0,
            hub,
            shift_kc: 0,
            scratch_path: scratch_file(display, session),
        };
        // Undo remaps left behind by a previous run that did not exit cleanly.
        if let Ok(old) = std::fs::read_to_string(&me.scratch_path) {
            me.load_keymap(max_kc)?;
            for kc in old.split_whitespace().filter_map(|k| k.parse::<u8>().ok()) {
                if kc >= min_kc && kc <= max_kc {
                    let _ = me
                        .conn
                        .change_keyboard_mapping(1, kc, me.per as u8, &vec![0; me.per]);
                }
            }
            let _ = me.conn.sync();
            let _ = std::fs::remove_file(&me.scratch_path);
        }
        me.load_keymap(max_kc)?;
        me.shift_kc = me.lookup.get(&keys::SHIFT_L).map(|&(k, _)| k).unwrap_or(50);
        me.smooth = SmoothScroll::detect(&me.conn);
        match &me.smooth {
            Some(s) => log::info!(
                "smooth scrolling via XTEST device {} (axes {}/{})",
                s.device,
                s.vaxis,
                s.haxis
            ),
            None => log::info!("XTEST pointer has no scroll axes; scrolling with wheel clicks"),
        }
        Ok(me)
    }

    fn load_keymap(&mut self, max_kc: u8) -> Result<(), String> {
        let count = max_kc - self.min_kc + 1;
        let r = self
            .conn
            .get_keyboard_mapping(self.min_kc, count)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        self.per = r.keysyms_per_keycode as usize;
        self.syms = r.keysyms;
        self.lookup.clear();
        self.scratch.clear();
        for i in 0..count as usize {
            let kc = self.min_kc + i as u8;
            let row = &self.syms[i * self.per..(i + 1) * self.per];
            if row.iter().all(|&s| s == 0) {
                self.scratch.push(kc);
                continue;
            }
            // Only the first two levels (plain, shift) are reachable without extra modifiers.
            for (lvl, &s) in row.iter().take(2).enumerate() {
                if s != 0 {
                    self.lookup.entry(s).or_insert((kc, lvl));
                }
            }
        }
        self.scratch.retain(|k| SAFE_SCRATCH.contains(k));
        self.scratch.reverse();
        log::info!(
            "keymap: {} keysyms, {} scratch keycodes",
            self.lookup.len(),
            self.scratch.len()
        );
        Ok(())
    }

    fn row(&self, kc: u8) -> &[u32] {
        let i = (kc - self.min_kc) as usize;
        &self.syms[i * self.per..(i + 1) * self.per]
    }

    fn fake(&self, ty: u8, detail: u8, x: i16, y: i16) {
        let _ = self
            .conn
            .xtest_fake_input(ty, detail, x11rb::CURRENT_TIME, self.root, x, y, 0);
    }

    fn key_event(&self, down: bool, kc: u8) {
        let ty = if down {
            xproto::KEY_PRESS_EVENT
        } else {
            xproto::KEY_RELEASE_EVENT
        };
        self.fake(ty, kc, 0, 0);
    }

    fn shift_held(&self) -> bool {
        self.pressed
            .values()
            .any(|h| h.keysym == keys::SHIFT_L || h.keysym == keys::SHIFT_R)
    }

    /// The keycode for one of `keysyms` the keymap has at its plain or shifted level, with what Shift needs doing.
    fn in_keymap(&self, keysyms: &[u32]) -> Option<(u8, ShiftFix)> {
        let want_level = usize::from(self.shift_held());
        let (keysym, &(kc, lvl)) = keysyms
            .iter()
            .find_map(|k| self.lookup.get(k).map(|v| (*k, v)))?;
        let row = self.row(kc);
        let l0 = row[0];
        let l1 = if row.len() > 1 { row[1] } else { 0 };
        let shift_neutral = l1 == 0 || l0 == l1 || (0xfd00..0x10000).contains(&keysym);
        if lvl == want_level || shift_neutral {
            return Some((kc, ShiftFix::None));
        }
        Some((
            kc,
            if lvl == 1 {
                ShiftFix::Add
            } else {
                ShiftFix::Lift
            },
        ))
    }

    /// Maps `keysyms` (none of them in the keymap) onto spare keycodes at every level, in one go. Returns whether any
    /// mapping changed, so the caller waits once for clients to read the new keymap instead of once per key.
    fn map_scratch(&mut self, keysyms: &[u32]) -> bool {
        let mut changed = false;
        for &keysym in keysyms {
            if let Some((_, t)) = self.scratch_map.get_mut(&keysym) {
                *t = Instant::now();
                continue;
            }
            if self.scratch.is_empty() {
                return changed;
            }
            let kc = if self.scratch_map.len() < self.scratch.len() {
                self.scratch[self.scratch_map.len()]
            } else {
                // The least recently used, sparing those this batch just mapped.
                let Some((&old, _)) = self
                    .scratch_map
                    .iter()
                    .filter(|(k, _)| !keysyms.contains(k))
                    .min_by_key(|(_, (_, t))| *t)
                else {
                    return changed;
                };
                self.scratch_map.remove(&old).map(|(kc, _)| kc).unwrap_or(0)
            };
            if kc == 0 {
                return changed;
            }
            let row = vec![keysym; self.per];
            let _ = self
                .conn
                .change_keyboard_mapping(1, kc, self.per as u8, &row);
            let i = (kc - self.min_kc) as usize;
            let per = self.per;
            self.syms[i * per..(i + 1) * per].copy_from_slice(&row);
            self.scratch_map.insert(keysym, (kc, Instant::now()));
            changed = true;
        }
        if changed {
            let _ = self.conn.sync();
            let used: Vec<String> = self
                .scratch_map
                .values()
                .map(|(k, _)| k.to_string())
                .collect();
            let _ = std::fs::write(&self.scratch_path, used.join(" "));
        }
        changed
    }

    /// Another client changed the keymap (another castd on the same desktop remapping a spare keycode): forget every
    /// spare keycode of ours that no longer types what castd mapped it to, so its next use maps it again.
    fn on_mapping_change(&mut self) {
        if self.scratch_map.is_empty() {
            return;
        }
        let max_kc = self.min_kc as usize + self.syms.len() / self.per.max(1) - 1;
        let Ok(Ok(r)) = self
            .conn
            .get_keyboard_mapping(self.min_kc, (max_kc - self.min_kc as usize + 1) as u8)
            .map(|c| c.reply())
        else {
            return;
        };
        if r.keysyms_per_keycode as usize != self.per || r.keysyms.len() != self.syms.len() {
            return;
        }
        let per = self.per;
        let min = self.min_kc;
        self.scratch_map.retain(|&keysym, &mut (kc, _)| {
            let i = (kc - min) as usize;
            r.keysyms[i * per] == keysym
        });
        for &(kc, _) in self.scratch_map.values() {
            let i = (kc - min) as usize;
            self.syms[i * per..(i + 1) * per].copy_from_slice(&r.keysyms[i * per..(i + 1) * per]);
        }
    }

    /// Reads what the X server sent this connection: only MappingNotify matters.
    fn pump_events(&mut self) {
        let mut changed = false;
        while let Ok(Some(ev)) = self.conn.poll_for_event() {
            if let x11rb::protocol::Event::MappingNotify(e) = ev {
                changed |= e.request == xproto::Mapping::KEYBOARD;
            }
        }
        if changed {
            self.on_mapping_change();
        }
    }

    /// Clients must process MappingNotify before they see a key on a remapped keycode.
    fn settle_mapping(&self) {
        std::thread::sleep(Duration::from_millis(8));
    }

    /// The keycode that types one of `keysyms`, remapping a spare one if the keymap has none.
    fn resolve(&mut self, keysyms: &[u32]) -> Option<(u8, ShiftFix)> {
        if let Some(found) = self.in_keymap(keysyms) {
            return Some(found);
        }
        let first = *keysyms.first()?;
        if self.map_scratch(&[first]) {
            self.settle_mapping();
        }
        self.scratch_map
            .get(&first)
            .map(|&(kc, _)| (kc, ShiftFix::None))
    }

    /// Presses `kc` with Shift fixed up as `fix` says.
    fn press_fixed(&self, kc: u8, fix: ShiftFix) {
        match fix {
            ShiftFix::None => self.key_event(true, kc),
            ShiftFix::Add => {
                self.key_event(true, self.shift_kc);
                self.key_event(true, kc);
                self.key_event(false, self.shift_kc);
            }
            ShiftFix::Lift => {
                let held: Vec<u8> = self
                    .pressed
                    .values()
                    .filter(|h| h.keysym == keys::SHIFT_L || h.keysym == keys::SHIFT_R)
                    .map(|h| h.kc)
                    .collect();
                for &h in &held {
                    self.key_event(false, h);
                }
                self.key_event(true, kc);
                for &h in &held {
                    self.key_event(true, h);
                }
            }
        }
    }

    /// Brings this viewer's modifiers in line with `mods` for one event: presses those asked for and not held (returned,
    /// to release after the event), and releases those it holds but says are not held (stranded by a lost key-up).
    /// `skip` is the modifier the event is itself about, whose own flag describes it.
    fn apply_mods(&mut self, client: u64, mods: Mods, skip: Option<u32>) -> Vec<u8> {
        let families: [(Option<bool>, [u32; 2]); 3] = [
            (mods.ctrl, [keys::CONTROL_L, keys::CONTROL_R]),
            (mods.shift, [keys::SHIFT_L, keys::SHIFT_R]),
            (mods.alt, [keys::ALT_L, keys::ALT_R]),
        ];
        let mut added = Vec::new();
        for (flag, family) in families {
            if skip.is_some_and(|s| family.contains(&s)) {
                continue;
            }
            let held: Vec<(u64, String)> = self
                .pressed
                .iter()
                .filter(|(_, h)| family.contains(&h.keysym))
                .map(|(k, _)| k.clone())
                .collect();
            match flag {
                Some(true) if held.is_empty() => {
                    if let Some((kc, _)) = self.in_keymap(&[family[0]]) {
                        self.key_event(true, kc);
                        added.push(kc);
                    }
                }
                Some(false) => {
                    for key in held.into_iter().filter(|(c, _)| *c == client) {
                        if let Some(h) = self.pressed.remove(&key) {
                            self.key_event(false, h.kc);
                        }
                    }
                }
                _ => {}
            }
        }
        added
    }

    fn release_added(&self, added: Vec<u8>) {
        for kc in added.into_iter().rev() {
            self.key_event(false, kc);
        }
    }

    /// Lets go of this viewer's Ctrl, Alt and AltGr around a character AltGr composed; returns them to press again.
    fn lift_altgr(&self, client: u64) -> Vec<u8> {
        let lifted: Vec<u8> = self
            .pressed
            .iter()
            .filter(|((c, _), h)| {
                *c == client
                    && [
                        keys::CONTROL_L,
                        keys::CONTROL_R,
                        keys::ALT_L,
                        keys::ALT_R,
                        keys::ISO_LEVEL3_SHIFT,
                    ]
                    .contains(&h.keysym)
            })
            .map(|(_, h)| h.kc)
            .collect();
        for &kc in &lifted {
            self.key_event(false, kc);
        }
        lifted
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
        let keysyms = keys::key_keysyms(key, code);
        let mods = if altgr {
            Mods {
                ctrl: None,
                alt: None,
                ..mods
            }
        } else {
            mods
        };
        let Some(&keysym) = keysyms.first() else {
            return;
        };
        let skip = keys::is_modifier(keysym).then_some(keysym);
        let lifted = if altgr {
            self.lift_altgr(client)
        } else {
            Vec::new()
        };
        let added = self.apply_mods(client, mods, skip);
        let key = (client, id);
        if matches!(action, KeyAction::Down | KeyAction::Press) {
            if let Some(h) = self.pressed.get(&key) {
                // Autorepeat: a press without a release is fine for X.
                self.key_event(true, h.kc);
            } else {
                if let Some((kc, fix)) = self.resolve(&keysyms) {
                    self.press_fixed(kc, fix);
                    self.pressed.insert(key.clone(), Held { kc, keysym });
                }
            }
        }
        if matches!(action, KeyAction::Up | KeyAction::Press)
            && let Some(h) = self.pressed.remove(&key)
        {
            self.key_event(false, h.kc);
        }
        self.release_added(added);
        for kc in lifted {
            self.key_event(true, kc);
        }
    }

    /// Types `text` character by character with no pause between them: every character the keymap lacks is mapped
    /// onto a spare keycode up front, in batches as large as the spare keycodes allow, with one wait per batch for
    /// clients to read the new keymap.
    fn text(&mut self, text: &str) {
        let chars: Vec<(char, Vec<u32>)> = text
            .chars()
            .map(|c| (c, keys::char_keysyms(c)))
            .filter(|(_, k)| !k.is_empty())
            .collect();
        let mut i = 0;
        while i < chars.len() {
            // The longest run from i whose missing keysyms fit the spare keycodes at once.
            let mut batch: Vec<u32> = Vec::new();
            let mut j = i;
            while j < chars.len() {
                let ks = &chars[j].1;
                if self.in_keymap(ks).is_none() && !batch.contains(&ks[0]) {
                    if batch.len() >= self.scratch.len().max(1) {
                        break;
                    }
                    batch.push(ks[0]);
                }
                j += 1;
            }
            if j == i {
                j = i + 1;
            }
            if self.map_scratch(&batch) {
                self.settle_mapping();
            }
            for (_, ks) in &chars[i..j] {
                let found = self.in_keymap(ks).or_else(|| {
                    self.scratch_map
                        .get(&ks[0])
                        .map(|&(kc, _)| (kc, ShiftFix::None))
                });
                if let Some((kc, fix)) = found {
                    self.press_fixed(kc, fix);
                    self.key_event(false, kc);
                }
            }
            let _ = self.conn.flush();
            i = j;
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
        let xb = button.and_then(x_button);
        // A button this viewer holds that `buttons` says is up lost its release: let go of it now.
        if let Some(mask) = buttons {
            let stranded: Vec<u8> = self
                .buttons
                .iter()
                .filter(|&(&b, &c)| c == client && Some(b) != xb && mask & dom_bit(b) == 0)
                .map(|(&b, _)| b)
                .collect();
            for b in stranded {
                self.buttons.remove(&b);
                self.fake(xproto::BUTTON_RELEASE_EVENT, b, 0, 0);
            }
        }
        self.fake(xproto::MOTION_NOTIFY_EVENT, 0, clamp16(x), clamp16(y));
        let down = match action {
            PointerAction::Down => true,
            PointerAction::Up => false,
            PointerAction::Move | PointerAction::Wheel => return,
        };
        let Some(b) = xb else {
            return;
        };
        if down == self.buttons.contains_key(&b) {
            return;
        }
        let added = self.apply_mods(client, mods, None);
        if down {
            self.buttons.insert(b, client);
            self.fake(xproto::BUTTON_PRESS_EVENT, b, 0, 0);
        } else {
            self.buttons.remove(&b);
            self.fake(xproto::BUTTON_RELEASE_EVENT, b, 0, 0);
        }
        self.release_added(added);
    }

    fn scroll(&mut self, (x, y): (i32, i32), dx: f64, dy: f64) {
        self.fake(xproto::MOTION_NOTIFY_EVENT, 0, clamp16(x), clamp16(y));
        let clean = |d: f64| {
            if d.is_finite() {
                d.clamp(-MAX_SCROLL_PX, MAX_SCROLL_PX)
            } else {
                0.0
            }
        };
        let px_per_notch = (self.css_px_per_notch * self.hub.scale()).max(1.0);
        let units = |d: f64| clean(d) * NOTCH / px_per_notch;
        if let Some(sm) = &self.smooth {
            let (ux, uy) = self.scroll.take(units(dx), units(dy), 1.0);
            if ux != 0 || uy != 0 {
                sm.send(&self.conn, uy as i32, ux as i32);
            }
            return;
        }
        let (nx, ny) = self.scroll.take(units(dx), units(dy), NOTCH);
        // X buttons: 4/5 scroll up/down, 6/7 left/right.
        let click = |b: u8, n: i64| {
            for _ in 0..n {
                self.fake(xproto::BUTTON_PRESS_EVENT, b, 0, 0);
                self.fake(xproto::BUTTON_RELEASE_EVENT, b, 0, 0);
            }
        };
        match ny.cmp(&0) {
            std::cmp::Ordering::Greater => click(5, ny),
            std::cmp::Ordering::Less => click(4, -ny),
            std::cmp::Ordering::Equal => {}
        }
        match nx.cmp(&0) {
            std::cmp::Ordering::Greater => click(7, nx),
            std::cmp::Ordering::Less => click(6, -nx),
            std::cmp::Ordering::Equal => {}
        }
    }

    fn release_all(&mut self, client: Option<u64>) {
        let keys: Vec<(u64, String)> = self
            .pressed
            .keys()
            .filter(|(c, _)| client.is_none_or(|w| *c == w))
            .cloned()
            .collect();
        for k in keys {
            if let Some(h) = self.pressed.remove(&k) {
                self.key_event(false, h.kc);
            }
        }
        let held: Vec<u8> = self
            .buttons
            .iter()
            .filter(|&(_, &c)| client.is_none_or(|w| c == w))
            .map(|(&b, _)| b)
            .collect();
        for b in held {
            self.buttons.remove(&b);
            self.fake(xproto::BUTTON_RELEASE_EVENT, b, 0, 0);
        }
    }

    fn restore_keymap(&mut self) {
        for (_, (kc, _)) in std::mem::take(&mut self.scratch_map) {
            let _ = self
                .conn
                .change_keyboard_mapping(1, kc, self.per as u8, &vec![0; self.per]);
        }
        let _ = self.conn.sync();
        let _ = std::fs::remove_file(&self.scratch_path);
    }

    fn handle_event(&mut self, ev: InputEvent) {
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
            InputEvent::Clipboard(content) => {
                if let Some(c) = &self.clipboard {
                    c.set_blocking(content);
                }
            }
            InputEvent::ReleaseAll { client } => self.release_all(Some(client)),
            InputEvent::Shutdown => {
                self.release_all(None);
                self.restore_keymap();
            }
        }
    }
}

fn clamp16(v: i32) -> i16 {
    v.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

impl InputSink for Injector {
    fn types_key(key: &str, code: Option<&str>) -> bool {
        !keys::key_keysyms(key, code).is_empty()
    }

    fn pump(&mut self) {
        self.pump_events();
    }

    fn handle(&mut self, ev: InputEvent) {
        self.handle_event(ev);
    }

    fn flush(&mut self) {
        let _ = self.conn.flush();
    }
}

/// XTEST on `display`, with the clipboard set through `clipboard` in order with the keys, and a wheel notch scrolling
/// `css_px_per_notch` CSS pixels (times the hub's scale) on a server whose XTEST pointer has no scroll axes.
pub fn sink(
    display: Option<String>,
    session: &str,
    clipboard: Option<crate::desktop::ClipboardHandle>,
    css_px_per_notch: f64,
    hub: Arc<cast_core::hub::Hub>,
) -> Result<Injector, String> {
    let mut inj = Injector::new(display.as_deref(), session, hub)?;
    inj.clipboard = clipboard;
    inj.css_px_per_notch = if css_px_per_notch.is_finite() {
        css_px_per_notch.max(1.0)
    } else {
        120.0
    };
    Ok(inj)
}

/// The sink, started on cast-core's input thread.
pub fn spawn(
    display: Option<String>,
    session: &str,
    clipboard: Option<crate::desktop::ClipboardHandle>,
    css_px_per_notch: f64,
    hub: Arc<cast_core::hub::Hub>,
) -> Result<Input, String> {
    cast_core::input::spawn(sink(display, session, clipboard, css_px_per_notch, hub)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dom_buttons_map_to_x_buttons_and_back() {
        for dom in 0..5u8 {
            let x = x_button(dom).unwrap();
            let bit = dom_bit(x);
            // DOM `buttons` bits: 1 left, 2 right, 4 middle, 8 back, 16 forward.
            let expected = [1, 4, 2, 8, 16][dom as usize];
            assert_eq!(bit, expected, "DOM button {dom}");
        }
        assert_eq!(x_button(7), None);
    }
}
