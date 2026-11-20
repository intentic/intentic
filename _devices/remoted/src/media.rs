//! A person's view of this computer's screens: browser-wire's media socket on `/media/<session>`, sessions
//! `screen-<monitor id>`. Phase 2 serves it from cast-core (the capture, encoder, input and flow control castd is built
//! from, made portable), behind the same token as a terminal with `s = media/<session>`. Until then every upgrade is
//! answered 501, no monitor is listed and no encoder offered, and nothing here links a capture library.
//!
//! What phase 2 plugs in, and nothing else needs to change for it:
//! - [`monitors`]: the screens `/info` and the status line list (and `screen-<id>` sessions open).
//! - [`encoders`]: what `/info` offers.
//! - [`serve`]: the upgrade, after the router checked the token (`MEDIA_SUBJECT`) and `allow.view`; `allow.control`
//!   and the config's `paused` gate input, as [`crate::daemon::Daemon::input_allowed`] does for terminals.

use serde::Serialize;

/// One screen, as `/info` lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

/// Every screen a viewer could open. None before phase 2.
pub fn monitors() -> Vec<Monitor> {
    Vec::new()
}

/// The encoders a screen could be sent with. None before phase 2.
pub fn encoders() -> Vec<String> {
    Vec::new()
}

/// Why `/media/<session>` answers what it does before phase 2.
pub const NOT_YET: &str = "screens are not served by this intentic-remoted yet";
