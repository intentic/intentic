//! What remoted (the viewer's side, in the person's session) and the helper (SYSTEM, in the same session) say over
//! their pipe. JSON, one message per frame of [`super::pipe::Pipe`]; the picture itself never crosses it, only where
//! it changed: the helper's mirror texture is shared with remoted's pipeline device by an NT handle the helper
//! duplicates into remoted's process.

use crate::session::CaptureStatus;
use browser_wire::{KeyAction, MediaCursor, PointerAction};
use cast_core::input::{InputEvent, Mods};
use serde::{Deserialize, Serialize};

/// Moves when either side's messages change meaning; a hello with another one is refused.
pub const PROTOCOL: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ToHelper {
    /// The first message: the protocol, and the secret the service wrote where only this user can read it.
    Hello { protocol: u32, secret: String },
    /// Duplicate this monitor for me; `id` names this duplication in every answer (a monitor captured again after a
    /// mode change overlaps its previous capture for a moment).
    Open { id: u64, monitor: String },
    /// Stop that duplication.
    Close { id: u64 },
    /// A viewer's input for this monitor (its clipboard stays in remoted, which owns the person's clipboard).
    Input { monitor: String, event: Input },
    /// Remove the service: the installing user may take away what an administrator gave without another yes.
    Uninstall,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum FromHelper {
    Welcome {
        protocol: u32,
        version: String,
    },
    Refused {
        why: String,
    },
    /// The duplication's mirror: an NT handle valid in remoted's process, the texture's size.
    Opened {
        id: u64,
        handle: u64,
        width: u32,
        height: u32,
    },
    OpenFailed {
        id: u64,
        why: String,
    },
    Rects {
        id: u64,
        rects: Vec<[u32; 4]>,
    },
    Rebuild {
        id: u64,
    },
    Gone {
        id: u64,
        why: String,
    },
    Fallback {
        id: u64,
        why: String,
    },
    Cursor {
        id: u64,
        cursor: MediaCursor,
    },
    Status {
        id: u64,
        status: CaptureStatus,
    },
    /// The service is removing itself.
    Uninstalling,
}

/// [`Mods`] on the wire.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct WireMods {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctrl: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shift: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<bool>,
}

impl From<Mods> for WireMods {
    fn from(m: Mods) -> WireMods {
        WireMods {
            ctrl: m.ctrl,
            shift: m.shift,
            alt: m.alt,
        }
    }
}

impl From<WireMods> for Mods {
    fn from(m: WireMods) -> Mods {
        Mods {
            ctrl: m.ctrl,
            shift: m.shift,
            alt: m.alt,
        }
    }
}

/// [`InputEvent`] on the wire, all but the clipboard (remoted keeps it).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "camelCase")]
pub enum Input {
    Mouse {
        client: u64,
        action: PointerAction,
        x: i32,
        y: i32,
        button: Option<u8>,
        buttons: Option<u8>,
        mods: WireMods,
    },
    Scroll {
        x: i32,
        y: i32,
        dx: f64,
        dy: f64,
    },
    Key {
        client: u64,
        key: String,
        code: Option<String>,
        id: String,
        action: KeyAction,
        mods: WireMods,
        altgr: bool,
    },
    Text {
        text: String,
    },
    ReleaseAll {
        client: u64,
    },
    Shutdown,
}

impl Input {
    /// The wire form of an event; None for the clipboard.
    pub fn from_event(ev: &InputEvent) -> Option<Input> {
        Some(match ev {
            InputEvent::Mouse {
                client,
                action,
                x,
                y,
                button,
                buttons,
                mods,
            } => Input::Mouse {
                client: *client,
                action: *action,
                x: *x,
                y: *y,
                button: *button,
                buttons: *buttons,
                mods: (*mods).into(),
            },
            InputEvent::Scroll { x, y, dx, dy } => Input::Scroll {
                x: *x,
                y: *y,
                dx: *dx,
                dy: *dy,
            },
            InputEvent::Key {
                client,
                key,
                code,
                id,
                action,
                mods,
                altgr,
            } => Input::Key {
                client: *client,
                key: key.clone(),
                code: code.clone(),
                id: id.clone(),
                action: *action,
                mods: (*mods).into(),
                altgr: *altgr,
            },
            InputEvent::Text { text } => Input::Text { text: text.clone() },
            InputEvent::ReleaseAll { client } => Input::ReleaseAll { client: *client },
            InputEvent::Shutdown => Input::Shutdown,
            InputEvent::Clipboard(_) => return None,
        })
    }

    pub fn into_event(self) -> InputEvent {
        match self {
            Input::Mouse {
                client,
                action,
                x,
                y,
                button,
                buttons,
                mods,
            } => InputEvent::Mouse {
                client,
                action,
                x,
                y,
                button,
                buttons,
                mods: mods.into(),
            },
            Input::Scroll { x, y, dx, dy } => InputEvent::Scroll { x, y, dx, dy },
            Input::Key {
                client,
                key,
                code,
                id,
                action,
                mods,
                altgr,
            } => InputEvent::Key {
                client,
                key,
                code,
                id,
                action,
                mods: mods.into(),
                altgr,
            },
            Input::Text { text } => InputEvent::Text { text },
            Input::ReleaseAll { client } => InputEvent::ReleaseAll { client },
            Input::Shutdown => InputEvent::Shutdown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_crosses_the_wire_unchanged() {
        let key = InputEvent::Key {
            client: 3,
            key: "Delete".into(),
            code: Some("Delete".into()),
            id: "Delete".into(),
            action: KeyAction::Down,
            mods: Mods {
                ctrl: Some(true),
                shift: None,
                alt: Some(true),
            },
            altgr: false,
        };
        let wire = Input::from_event(&key).unwrap();
        let back: Input = serde_json::from_str(&serde_json::to_string(&wire).unwrap()).unwrap();
        match back.into_event() {
            InputEvent::Key {
                client, key, mods, ..
            } => {
                assert_eq!((client, key.as_str()), (3, "Delete"));
                assert_eq!(mods.ctrl, Some(true));
                assert_eq!(mods.alt, Some(true));
            }
            _ => panic!("not a key"),
        }
        let clip = InputEvent::Clipboard(cast_core::clipboard::ClipContent::default());
        assert!(Input::from_event(&clip).is_none());
    }

    #[test]
    fn messages_round_trip() {
        let m = FromHelper::Rects {
            id: 7,
            rects: vec![[0, 0, 10, 20]],
        };
        let text = serde_json::to_string(&m).unwrap();
        assert!(text.contains("\"t\":\"rects\""), "{text}");
        let back: FromHelper = serde_json::from_str(&text).unwrap();
        assert!(matches!(back, FromHelper::Rects { rects, .. } if rects == vec![[0, 0, 10, 20]]));
    }
}
