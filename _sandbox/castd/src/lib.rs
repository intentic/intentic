//! castd: one browser window's media daemon, cast-core's engine on cast-x11's X display. The capture, encoder, flow
//! control, input, cursor, clipboard, sound, recording and wait code is voxl's (<https://github.com/tembo/voxl>, MIT,
//! v0.4.0 at 21f194f); the socket, the protocol (browser-wire's media protocol), the tokens, the key names and the
//! bitrate policy are castd's. This library is castd's command line; the binary wires the crates together.

pub mod config;
