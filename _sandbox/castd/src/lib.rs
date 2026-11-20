//! castd: one browser window's media daemon. The capture, encoder, flow control, input, cursor, clipboard, sound,
//! recording and wait code is voxl's (<https://github.com/tembo/voxl>, MIT, v0.4.0 at 21f194f), Linux only; the socket,
//! the protocol (browser-wire's media protocol), the tokens, the key names and the bitrate policy are castd's.

#[cfg(feature = "audio")]
pub mod audio;
pub mod capture;
pub mod client;
pub mod config;
pub mod convert;
pub mod desktop;
pub mod encoder;
pub mod exact;
pub mod header;
pub mod hub;
pub mod input;
pub mod keys;
mod keysym_table;
pub mod media;
pub mod mp4;
#[cfg(feature = "nvenc")]
pub mod nvenc;
pub mod rate;
pub mod record;
pub mod rtc;
pub mod screen;
pub mod server;
pub mod token;
pub mod video;
pub mod wait;
pub mod x264;

use std::sync::OnceLock;

/// The socket castd listens on, removed by `exit`.
static SOCKET: OnceLock<String> = OnceLock::new();

pub fn set_socket_path(path: &str) {
    let _ = SOCKET.set(path.to_string());
}

/// Ends castd: the socket file goes with it, so a dead castd is never mistaken for a live one.
pub fn exit(code: i32) -> ! {
    if let Some(path) = SOCKET.get() {
        let _ = std::fs::remove_file(path);
    }
    std::process::exit(code)
}

/// The sound's format for `hello`, when castd captures sound: Opus, 48 kHz stereo. None without the `audio` feature.
pub fn audio_format(capturing: bool) -> Option<browser_wire::MediaAudio> {
    #[cfg(feature = "audio")]
    return capturing.then(|| browser_wire::MediaAudio {
        codec: "opus".into(),
        sample_rate: audio::RATE,
        channels: audio::CHANNELS,
    });
    #[cfg(not(feature = "audio"))]
    {
        let _ = capturing;
        None
    }
}
