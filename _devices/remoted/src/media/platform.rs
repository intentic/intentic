//! What a computer's screens are made of, one implementation per OS: which monitors there are, how each is captured,
//! encoded and typed into, and what `/info` says about why a screen cannot be served. [`super::Screens`] owns the rest
//! (one pipeline per monitor shared by every viewer of every uplink, started on the first and stopped after the last),
//! so a platform only opens.
//!
//! - Linux ([`super::linux`]): an X11 session's display through cast-x11, a virtual desktop remoted starts on a
//!   computer with no display at all, and a Wayland session through the desktop portal and PipeWire.
//! - Windows (`super::windows`, cast-win): DXGI duplication, D3D11 encoders, SendInput.

use std::sync::Arc;

use browser_wire::MediaAudio;
use cast_core::audio::AudioSource;
use cast_core::capture::ScreenSource;
use cast_core::hub::Hub;
use cast_core::input::Input;
use cast_core::video::VideoConfig;

use super::Monitor;

/// One OS's screens. Called from any thread: `open` on a blocking one (it may start a display, ask a portal, test an
/// encoder), the rest from `/info` and the status line, often, so they answer from what they know without blocking
/// long.
pub trait Platform: Send + Sync + 'static {
    /// Every screen a viewer could open now (a monitor plugged in or out shows on the next call). A screen's session
    /// is `screen-<id>`; ids are `[A-Za-z0-9_-]{1,57}` and stable across calls while the screen is there.
    fn monitors(&self) -> Vec<Monitor>;

    /// The encoders a screen could be sent with, the one tried first first (`nvenc`, `openh264`).
    fn encoders(&self) -> Vec<String>;

    /// What `/info` says under `screen` about how this computer's screens are reached, for the editor to show when
    /// `monitors` is empty: `{mode, …}`, and `missing` naming the packages to install where something is absent.
    fn describe(&self) -> serde_json::Value;

    /// The sound a screen's viewers may turn on, asked before its hub exists (the hub's `hello` carries it). None: no
    /// sound for this screen.
    fn audio_format(&self, monitor: &str) -> Option<MediaAudio> {
        let _ = monitor;
        None
    }

    /// Opens one screen for its first viewer. `hub` is the screen's (the platform's cursor and clipboard threads push
    /// into it); `base` is remoted's pipeline configuration, which the platform tunes for its encoders and returns in
    /// [`Opened::video`]. An error is said to the viewer as the reason the screen did not open (a monitor gone, a
    /// display that did not start, a consent the person refused).
    fn open(&self, monitor: &str, hub: &Arc<Hub>, base: VideoConfig) -> Result<Opened, String>;

    /// remoted is ending, every screen already stopped: end what outlives a screen (a virtual desktop).
    fn shutdown(&self) {}

    /// How a running screen's picture is made now, and why when it is not the desktop itself (Windows: `{via,
    /// blocked?, reason?, error?, since}`), for `/stats`. None where the platform says nothing more.
    fn screen_status(&self, monitor: &str) -> Option<serde_json::Value> {
        let _ = monitor;
        None
    }
}

/// What a platform runs once a screen stopped: its cursor and clipboard threads, a display it started.
pub type Stop = Box<dyn FnOnce() + Send>;

/// A screen opened for viewing: what remoted runs until its last viewer has been gone a while.
pub struct Opened {
    /// The picture, handed to `cast_core::video::spawn`.
    pub source: Box<dyn ScreenSource>,
    /// The pipeline's configuration: the base `open` was given, with the platform's encoders and tuning.
    pub video: VideoConfig,
    /// Where viewers' input goes; None leaves every viewer a watcher. Sent `ReleaseAll` for each socket that closes
    /// and `Shutdown` when the screen stops, then dropped (which ends its thread).
    pub input: Option<Input>,
    /// The sound, started with the screen when the build has Opus. Its format is `audio_format`'s.
    pub audio: Option<Box<dyn AudioSource>>,
    /// Run once the pipeline stopped, in order: the cursor and clipboard threads, a virtual display remoted started.
    pub stops: Vec<Stop>,
}

/// A computer remoted serves no screen on (macOS for now): nothing listed, and `/info` says why.
pub struct Unsupported;

impl Platform for Unsupported {
    fn monitors(&self) -> Vec<Monitor> {
        Vec::new()
    }

    fn encoders(&self) -> Vec<String> {
        Vec::new()
    }

    fn describe(&self) -> serde_json::Value {
        serde_json::json!({
            "mode": "unsupported",
            "reason": format!("intentic-remoted serves no screen on {} yet", std::env::consts::OS),
        })
    }

    fn open(&self, _monitor: &str, _hub: &Arc<Hub>, _base: VideoConfig) -> Result<Opened, String> {
        Err(format!(
            "intentic-remoted serves no screen on {} yet",
            std::env::consts::OS
        ))
    }
}
