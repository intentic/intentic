//! cast-core: castd's streaming engine, with what a platform provides behind traits. The capture, encoder, flow
//! control, input, cursor, clipboard, sound, recording and wait code is voxl's (<https://github.com/tembo/voxl>, MIT,
//! v0.4.0 at 21f194f); the socket, the protocol (browser-wire's media protocol), the tokens, the bitrate policy, peer
//! connections and the traits are castd's.
//!
//! A platform implements [`capture::ScreenSource`] (the picture and its damage), [`input::InputSink`] (keys, text,
//! pointer, scroll, clipboard), optionally [`audio::AudioSource`], and pushes the cursor's shape and copies made on the
//! screen into the [`hub::Hub`]. [`video::spawn`] runs the pipeline, [`server::router`] serves viewers.

pub mod audio;
pub mod capture;
pub mod client;
pub mod clipboard;
pub mod convert;
pub mod encoder;
pub mod exact;
pub mod frame;
pub mod geometry;
pub mod header;
pub mod hub;
pub mod input;
pub mod media;
pub mod mp4;
#[cfg(all(feature = "nvenc", target_os = "linux"))]
pub mod nvenc;
#[cfg(feature = "openh264")]
pub mod openh264;
#[cfg(all(feature = "pulse", target_os = "linux"))]
pub mod pulse;
pub mod rate;
pub mod record;
pub mod rtc;
pub mod server;
pub mod token;
pub mod video;
pub mod wait;
pub mod wake;
#[cfg(feature = "x264")]
pub mod x264;

use std::sync::OnceLock;

/// A file the process removes when it ends through [`exit`]: castd's socket.
static REMOVE_ON_EXIT: OnceLock<String> = OnceLock::new();

/// Names the file [`exit`] removes (the first call holds), so a dead server is never mistaken for a live one.
pub fn remove_on_exit(path: &str) {
    let _ = REMOVE_ON_EXIT.set(path.to_string());
}

/// Ends the process: what the pipeline does when its capture fails for good, since a picture that stopped is better
/// restarted by whoever started it than left frozen behind a live socket.
pub fn exit(code: i32) -> ! {
    if let Some(path) = REMOVE_ON_EXIT.get() {
        let _ = std::fs::remove_file(path);
    }
    std::process::exit(code)
}
