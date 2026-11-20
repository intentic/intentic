//! Viewers' input as the platform receives it, and the thread it runs on. media.rs turns each viewer's messages into
//! `InputEvent`s (points already in screen pixels, keys as the DOM named them) and hands them to the platform's
//! [`InputSink`] on a thread of its own, in order, so the clipboard and the keys around it stay in order (a paste is the
//! clipboard, then Ctrl+V). Pointer moves that queued up behind one another collapse to the latest. What each viewer
//! holds down is the sink's to track per viewer, so one viewer's `releaseAll` (or its socket closing) lets go of its own
//! keys and buttons only.

use browser_wire::{KeyAction, PointerAction};
use std::sync::mpsc;

/// Modifier flags a key or mouse event carries: Some(true) to hold it for the event, Some(false) to say it is not held
/// (which lets go of one this viewer left stranded), None to leave it as it is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: Option<bool>,
    pub shift: Option<bool>,
    pub alt: Option<bool>,
}

pub enum InputEvent {
    Mouse {
        client: u64,
        action: PointerAction,
        /// Screen pixels: the picture's point moved by the crop's origin. A platform whose screen sits elsewhere on its
        /// desktop (a second monitor) adds its own origin.
        x: i32,
        y: i32,
        /// DOM button numbering (0 left, 1 middle, 2 right, 3 back, 4 forward).
        button: Option<u8>,
        /// DOM `buttons` bitmask of what is held.
        buttons: Option<u8>,
        mods: Mods,
    },
    /// Precise scrolling at a point (screen pixels), by picture pixels with their fractions. [`ScrollAcc`] carries what
    /// one event cannot send to the next.
    Scroll { x: i32, y: i32, dx: f64, dy: f64 },
    Key {
        client: u64,
        /// `KeyboardEvent.key`, the layout already applied on the viewer's machine (`ą`, `€`, `@`, `Enter`, `F5`): the
        /// character the key produced, which the sink types whatever its own layout is.
        key: String,
        /// `KeyboardEvent.code`, the physical key: settles left from right modifiers and the keypad's Enter, and names
        /// a key the browser could not (`Unidentified`).
        code: Option<String>,
        /// What identifies the physical key across its down and up (`code`, else the key name): Shift between them
        /// changes `a` into `A`, and the up must still find the key the down pressed.
        id: String,
        action: KeyAction,
        mods: Mods,
        /// A character AltGr made, reported as Ctrl+Alt (Windows does): typed with this viewer's Ctrl and Alt lifted.
        altgr: bool,
    },
    /// Characters to type, with no pause between them (an IME's commit, a dictation).
    Text { text: String },
    /// A viewer set the clipboard: the platform owns it with this content before the next event runs.
    Clipboard(crate::clipboard::ClipContent),
    /// Let go of everything this viewer holds.
    ReleaseAll { client: u64 },
    /// Release everything and undo what the sink changed (a keymap) before exit.
    Shutdown,
}

/// What a platform does with input: castd's is XTEST on its X display (cast-x11). Runs on the input thread
/// ([`spawn`]), which calls `pump`, then `handle` for each event of a batch, then `flush`.
pub trait InputSink: Send + 'static {
    /// Whether the sink types a DOM `key` (with `code`), asked on the viewer's socket before the key counts as input
    /// (and before it makes that viewer the driver): `Dead`, `Process` and an `Unidentified` with no known `code` type
    /// nothing anywhere.
    fn types_key(key: &str, code: Option<&str>) -> bool
    where
        Self: Sized;
    /// Reads what the platform said since the last batch (a keymap another client changed).
    fn pump(&mut self) {}
    fn handle(&mut self, ev: InputEvent);
    /// Sends what the batch queued (an X connection's buffer); also called right after `Shutdown`.
    fn flush(&mut self) {}
}

/// The hub's handle on the input thread.
#[derive(Clone)]
pub struct Input {
    tx: mpsc::Sender<InputEvent>,
    types_key: fn(&str, Option<&str>) -> bool,
}

impl Input {
    /// A handle on events a platform reads off `tx`'s receiver itself, on a thread of its own.
    pub fn from_channel(
        tx: mpsc::Sender<InputEvent>,
        types_key: fn(&str, Option<&str>) -> bool,
    ) -> Input {
        Input { tx, types_key }
    }

    pub fn send(&self, ev: InputEvent) {
        let _ = self.tx.send(ev);
    }

    pub fn types_key(&self, key: &str, code: Option<&str>) -> bool {
        (self.types_key)(key, code)
    }
}

/// Starts the input thread (named `input`) on `sink`.
pub fn spawn<S: InputSink>(mut sink: S) -> Result<Input, String> {
    let (tx, rx) = mpsc::channel::<InputEvent>();
    std::thread::Builder::new()
        .name("input".into())
        .spawn(move || {
            while let Ok(first) = rx.recv() {
                sink.pump();
                // Moves that queued up behind other events collapse to the latest; anything else goes in order.
                let mut pending_move: Option<InputEvent> = None;
                let mut handle = |sink: &mut S, ev: InputEvent| match ev {
                    InputEvent::Mouse {
                        action: PointerAction::Move,
                        buttons: None,
                        ..
                    } => pending_move = Some(ev),
                    other => {
                        if let Some(m) = pending_move.take() {
                            sink.handle(m);
                        }
                        let shutdown = matches!(other, InputEvent::Shutdown);
                        sink.handle(other);
                        if shutdown {
                            sink.flush();
                        }
                    }
                };
                handle(&mut sink, first);
                while let Ok(ev) = rx.try_recv() {
                    handle(&mut sink, ev);
                }
                if let Some(m) = pending_move.take() {
                    sink.handle(m);
                }
                sink.flush();
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Input {
        tx,
        types_key: S::types_key,
    })
}

/// A character key whose event says both Control and Alt is AltGr on Windows (which reports AltGr as the two), the
/// character already composed: `ą` from AltGr+A on a Polish layout, `@` from AltGr+Q on a German one. Pressing Control
/// and Alt around it would make the application read a shortcut instead of the character. Letters and digits keep the
/// chord, since those are real Ctrl+Alt shortcuts on every layout.
pub fn is_altgr_character(key: &str, ctrl: bool, alt: bool) -> bool {
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => ctrl && alt && !c.is_ascii_alphanumeric() && !c.is_control(),
        _ => false,
    }
}

/// Scroll units per wheel notch (X's scroll increment for hi-res wheels; Windows' WHEEL_DELTA is the same 120).
pub const NOTCH: f64 = 120.0;

/// The largest scroll step taken from one event, in picture pixels: a garbled message cannot queue up minutes of
/// wheel clicks.
pub const MAX_SCROLL_PX: f64 = 100_000.0;

/// Scroll still owed to the page: what one event left over, kept for the next, so a trackpad's small steps add up
/// instead of rounding away. In scroll units (NOTCH per wheel notch).
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct ScrollAcc {
    pub x: f64,
    pub y: f64,
}

impl ScrollAcc {
    /// Adds `dx`, `dy` scroll units and takes what can be sent now, in whole multiples of `quantum` units (1 for smooth
    /// scroll axes, NOTCH for wheel clicks); the rest stays for the next call, never dropped.
    pub fn take(&mut self, dx: f64, dy: f64, quantum: f64) -> (i64, i64) {
        let clean = |d: f64| if d.is_finite() { d } else { 0.0 };
        self.x += clean(dx);
        self.y += clean(dy);
        let nx = (self.x / quantum).trunc();
        let ny = (self.y / quantum).trunc();
        self.x -= nx * quantum;
        self.y -= ny * quantum;
        (nx as i64, ny as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn a_trackpads_small_steps_add_up_to_whole_wheel_clicks() {
        let mut acc = ScrollAcc::default();
        let mut clicks = 0;
        // 50 steps of 7.2 units: 360 units, three notches, sent as each one fills.
        for _ in 0..50 {
            clicks += acc.take(0.0, 7.2, NOTCH).1;
        }
        assert_eq!(clicks, 3);
        assert!(acc.y.abs() < 1e-9, "{} left over", acc.y);
    }

    #[test]
    fn nothing_scrolled_is_ever_dropped() {
        let steps = [
            (3.3, -150.7),
            (-0.25, 0.9),
            (240.0, 13.0),
            (-500.1, -0.05),
            (1e-3, 119.999),
        ];
        for (quantum, label) in [(NOTCH, "clicks"), (1.0, "axes")] {
            let mut acc = ScrollAcc::default();
            let (mut sent_x, mut sent_y, mut in_x, mut in_y) = (0.0, 0.0, 0.0, 0.0);
            for &(dx, dy) in &steps {
                in_x += dx;
                in_y += dy;
                let (nx, ny) = acc.take(dx, dy, quantum);
                sent_x += nx as f64 * quantum;
                sent_y += ny as f64 * quantum;
                assert!(acc.x.abs() < quantum && acc.y.abs() < quantum, "{label}");
            }
            assert!((sent_x + acc.x - in_x).abs() < 1e-9, "{label}: x lost");
            assert!((sent_y + acc.y - in_y).abs() < 1e-9, "{label}: y lost");
        }
    }

    #[test]
    fn a_reversal_spends_the_remainder_first() {
        let mut acc = ScrollAcc::default();
        assert_eq!(acc.take(0.0, 100.0, NOTCH), (0, 0));
        // 100 owed down, 30 up: 70 still owed, no click either way.
        assert_eq!(acc.take(0.0, -30.0, NOTCH), (0, 0));
        assert!((acc.y - 70.0).abs() < 1e-9);
        assert_eq!(acc.take(0.0, 50.0, NOTCH), (0, 1));
    }

    #[test]
    fn garbage_scroll_values_are_ignored() {
        let mut acc = ScrollAcc::default();
        assert_eq!(acc.take(f64::NAN, f64::INFINITY, NOTCH), (0, 0));
        assert_eq!(acc, ScrollAcc::default());
    }

    #[test]
    fn altgr_reported_as_ctrl_alt_is_recognised() {
        assert!(is_altgr_character("ą", true, true));
        assert!(is_altgr_character("@", true, true));
        assert!(is_altgr_character("€", true, true));
        assert!(!is_altgr_character("a", true, true));
        assert!(!is_altgr_character("1", true, true));
        assert!(!is_altgr_character("ą", false, true));
        assert!(!is_altgr_character("Delete", true, true));
    }

    /// Records what the input thread hands it, batch by batch; holds the first `slow` key until the gate opens.
    struct Recorder(Arc<Mutex<Vec<String>>>, mpsc::Receiver<()>);

    impl InputSink for Recorder {
        fn types_key(key: &str, _code: Option<&str>) -> bool {
            key != "Dead"
        }
        fn handle(&mut self, ev: InputEvent) {
            if matches!(&ev, InputEvent::Key { key, .. } if key == "slow") {
                let _ = self.1.recv();
            }
            let what = match ev {
                InputEvent::Mouse { x, y, .. } => format!("move {x},{y}"),
                InputEvent::Key { key, .. } => format!("key {key}"),
                InputEvent::Shutdown => "shutdown".into(),
                _ => "other".into(),
            };
            self.0.lock().unwrap().push(what);
        }
        fn flush(&mut self) {
            self.0.lock().unwrap().push("flush".into());
        }
    }

    fn mv(x: i32) -> InputEvent {
        InputEvent::Mouse {
            client: 1,
            action: PointerAction::Move,
            x,
            y: 0,
            button: None,
            buttons: None,
            mods: Mods::default(),
        }
    }

    fn key(key: &str) -> InputEvent {
        InputEvent::Key {
            client: 1,
            key: key.into(),
            code: None,
            id: key.into(),
            action: KeyAction::Press,
            mods: Mods::default(),
            altgr: false,
        }
    }

    #[test]
    fn the_input_thread_keeps_order_and_collapses_queued_moves() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (gate, gated) = mpsc::channel();
        let input = spawn(Recorder(log.clone(), gated)).unwrap();
        assert!(input.types_key("a", None) && !input.types_key("Dead", None));
        // The sink is busy with the first key while the rest queue up behind it: one batch.
        input.send(key("slow"));
        for ev in [mv(1), mv(2), mv(3), key("a"), mv(4), InputEvent::Shutdown] {
            input.send(ev);
        }
        gate.send(()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !log.lock().unwrap().iter().any(|e| e == "shutdown") {
            assert!(
                std::time::Instant::now() < deadline,
                "the input thread never got there"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let seen: Vec<String> = log.lock().unwrap().clone();
        assert_eq!(
            seen,
            [
                "key slow", "move 3,0", "key a", "move 4,0", "shutdown", "flush", "flush"
            ],
        );
    }

    #[test]
    fn a_platform_with_its_own_thread_reads_the_channel() {
        let (tx, rx) = mpsc::channel();
        let input = Input::from_channel(tx, |key, _| key.chars().count() == 1);
        input.send(mv(7));
        assert!(matches!(rx.try_recv(), Ok(InputEvent::Mouse { x: 7, .. })));
        assert!(input.types_key("x", None) && !input.types_key("Enter", None));
    }
}
