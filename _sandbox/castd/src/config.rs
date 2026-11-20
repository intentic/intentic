//! castd's command line.

use crate::capture::Rect;
use std::collections::HashMap;

pub const USAGE: &str = "\
castd: one window's picture, sound and input on a Unix socket, in browser-wire's media protocol.

  --session NAME         the browser session, [A-Za-z0-9_-]{1,64} (required)
  --key-file PATH        the HMAC key media tokens are signed with, raw bytes (required)
  --display :N           the X display (default: $DISPLAY)
  --socket PATH          where to listen (default: /run/intentic/cast/<session>.sock)
  --socket-mode OCTAL    the socket file's permissions (default: 600)
  --crop X,Y,W,H         capture only this region of the screen; the screen is then never resized
  --max-size WxH         the largest screen a viewer's resize may ask for (default: what RandR allows)
  --scale S              display pixels per CSS pixel before any viewer says (default: 1)
  --fps N                frames per second at most (default: 60)
  --crf N                x264 quality of moving content (default: 24)
  --paintover-crf N      quality content is sharpened to once still (default: 16)
  --paintover-burst N    sharpening passes once still (default: 3)
  --paintover-delay-ms N how long content is still before it is sharpened (default: 150)
  --max-kbps N           bitrate ceiling (default: 30000)
  --min-kbps N           bitrate floor (default: 500)
  --preset NAME          x264 preset (default: ultrafast)
  --encoder-threads N    most x264 threads per stripe (default: min(4, cores/4), at least 1)
  --adaptive-threads B   one encoder thread until frames miss their budget (default: true)
  --convert-threads N    threads converting a large change to YUV (default: 4)
  --stripes N            independent horizontal stripes encoded in parallel (default: 1)
  --coalesce-us N        wait this long after the first damage for the rest of a frame (default: 0)
  --scroll-px-per-notch N  CSS pixels one wheel notch scrolls the page (default: 120, Chromium on X11)
  --rtc-udp ADDR         take viewers' peer connections on this UDP address (IP:PORT); no peers without it
  --rtc-candidates LIST  where a viewer reaches that port, comma-separated IP or IP:PORT (a bare IP or port 0 takes
                         the bound port; default: the bound address unless it is unspecified, which reaches no one)
  --audio-source NAME    the PulseAudio source to send as sound; sound is off without it
  --audio-bitrate N      Opus bits per second (default: 128000)
  --max-record-seconds N longest recording (default: 300)
  --record-dir DIR       where a recording started with `file=` is written, streamed as it is made; none without it
  --not-before MS        refuse media tokens minted before this (ms since the epoch): a drop the daemon asked of the
                         castd before this one, carried over a restart
  --encoder NAME         x264 (the default), nvenc, or auto: the first GPU encoder present that passes castd's
                         self-test, else x264
";

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub session: String,
    pub key_file: String,
    pub display: Option<String>,
    pub socket: String,
    pub socket_mode: u32,
    pub crop: Option<Rect>,
    pub max_size: Option<(u32, u32)>,
    pub scale: f64,
    pub fps: u32,
    pub crf: f32,
    pub paintover_crf: f32,
    pub paintover_burst: u32,
    pub paintover_delay_ms: u64,
    pub max_kbps: u32,
    pub min_kbps: u32,
    pub preset: String,
    pub encoder_threads: u32,
    pub adaptive_threads: bool,
    pub convert_threads: usize,
    pub stripes: u32,
    pub coalesce_us: u64,
    pub scroll_px_per_notch: f64,
    /// The UDP address castd takes viewers' peer connections on, and the addresses it tells them to send to.
    pub rtc_udp: Option<std::net::SocketAddr>,
    pub rtc_candidates: Vec<std::net::SocketAddr>,
    pub audio_source: Option<String>,
    pub audio_bitrate: i32,
    pub max_record_seconds: f64,
    /// Where a recording started with a file name is written (record.rs); None takes only in-memory ones.
    pub record_dir: Option<String>,
    /// Tokens minted before this (ms since the epoch) open nothing.
    pub not_before: u64,
    pub encoder: crate::encoder::Request,
}

/// Whether a session name is one browser-wire allows: `[A-Za-z0-9_-]{1,64}`.
pub fn valid_session(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn flags(args: &[String]) -> Result<HashMap<String, String>, String> {
    let mut m = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        let Some(k) = a.strip_prefix("--") else {
            return Err(format!("unexpected argument {a}"));
        };
        if let Some((k, v)) = k.split_once('=') {
            m.insert(k.to_string(), v.to_string());
        } else if i + 1 < args.len() && !args[i + 1].starts_with("--") {
            m.insert(k.to_string(), args[i + 1].clone());
            i += 1;
        } else {
            m.insert(k.to_string(), "true".into());
        }
        i += 1;
    }
    Ok(m)
}

fn num<T: std::str::FromStr>(
    m: &HashMap<String, String>,
    k: &str,
    default: T,
) -> Result<T, String> {
    match m.get(k) {
        None => Ok(default),
        Some(v) => v.parse().map_err(|_| format!("--{k} {v}: not a number")),
    }
}

/// `--rtc-udp` and `--rtc-candidates`: the address to bind and where viewers reach it. A candidate with no port takes
/// the bound one (a container's port is published as itself); an unspecified bind address is no candidate.
fn rtc_flags(
    m: &HashMap<String, String>,
) -> Result<(Option<std::net::SocketAddr>, Vec<std::net::SocketAddr>), String> {
    use std::net::{IpAddr, SocketAddr};
    let Some(bind) = m.get("rtc-udp") else {
        return match m.get("rtc-candidates") {
            Some(_) => Err("--rtc-candidates needs --rtc-udp".into()),
            None => Ok((None, Vec::new())),
        };
    };
    let bind: SocketAddr = bind
        .parse()
        .map_err(|_| format!("--rtc-udp {bind}: expected IP:PORT"))?;
    let candidates = match m.get("rtc-candidates") {
        None if bind.ip().is_unspecified() => Vec::new(),
        None => vec![bind],
        Some(list) => list
            .split(',')
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(|c| {
                c.parse::<SocketAddr>()
                    .or_else(|_| {
                        c.parse::<IpAddr>()
                            .map(|ip| SocketAddr::new(ip, bind.port()))
                    })
                    .map_err(|_| format!("--rtc-candidates {c}: expected IP or IP:PORT"))
            })
            .collect::<Result<_, _>>()?,
    };
    // Port 0 is the port bound, whatever it turns out to be (a test binding `:0`).
    if candidates.iter().any(|c| c.ip().is_unspecified()) {
        return Err("--rtc-candidates: an address a viewer can send to, not 0.0.0.0".into());
    }
    Ok((Some(bind), candidates))
}

impl Config {
    pub fn parse(args: &[String]) -> Result<Config, String> {
        let m = flags(args)?;
        const KNOWN: &[&str] = &[
            "session",
            "key-file",
            "display",
            "socket",
            "socket-mode",
            "crop",
            "max-size",
            "scale",
            "fps",
            "crf",
            "paintover-crf",
            "paintover-burst",
            "paintover-delay-ms",
            "max-kbps",
            "min-kbps",
            "preset",
            "encoder-threads",
            "adaptive-threads",
            "convert-threads",
            "stripes",
            "coalesce-us",
            "scroll-px-per-notch",
            "rtc-udp",
            "rtc-candidates",
            "audio-source",
            "audio-bitrate",
            "max-record-seconds",
            "record-dir",
            "not-before",
            "encoder",
        ];
        if let Some(unknown) = m.keys().find(|k| !KNOWN.contains(&k.as_str())) {
            return Err(format!("unknown flag --{unknown}"));
        }
        let session = m.get("session").cloned().ok_or("--session is required")?;
        if !valid_session(&session) {
            return Err(format!(
                "--session {session}: must match [A-Za-z0-9_-]{{1,64}}"
            ));
        }
        let key_file = m.get("key-file").cloned().ok_or("--key-file is required")?;
        let crop = match m.get("crop") {
            None => None,
            Some(v) => Some(Rect::parse(v).ok_or_else(|| format!("--crop {v}: expected x,y,w,h"))?),
        };
        let max_size = match m.get("max-size") {
            None => None,
            Some(v) => {
                let parsed = v
                    .split_once(['x', 'X'])
                    .and_then(|(w, h)| Some((w.trim().parse().ok()?, h.trim().parse().ok()?)))
                    .filter(|&(w, h): &(u32, u32)| w > 0 && h > 0);
                Some(parsed.ok_or_else(|| format!("--max-size {v}: expected WxH"))?)
            }
        };
        let cores = std::thread::available_parallelism().map_or(4, |n| n.get()) as u32;
        let scale: f64 = num(&m, "scale", 1.0)?;
        if !(scale.is_finite() && (0.25..=8.0).contains(&scale)) {
            return Err(format!("--scale {scale}: expected 0.25 to 8"));
        }
        let fps: u32 = num(&m, "fps", 60)?;
        let (rtc_udp, rtc_candidates) = rtc_flags(&m)?;
        let socket_mode = match m.get("socket-mode") {
            None => 0o600,
            Some(v) => {
                u32::from_str_radix(v, 8).map_err(|_| format!("--socket-mode {v}: not octal"))?
            }
        };
        Ok(Config {
            socket: m.get("socket").cloned().unwrap_or_else(|| {
                format!("{}/{session}.sock", browser_wire::BROWSER_MEDIA_SOCKET_DIR)
            }),
            session,
            key_file,
            display: m
                .get("display")
                .cloned()
                .or_else(|| std::env::var("DISPLAY").ok()),
            socket_mode,
            crop,
            max_size,
            scale,
            fps: fps.clamp(1, 240),
            crf: num(&m, "crf", 24.0)?,
            paintover_crf: num(&m, "paintover-crf", 16.0)?,
            paintover_burst: num(&m, "paintover-burst", 3)?,
            paintover_delay_ms: num(&m, "paintover-delay-ms", 150)?,
            max_kbps: num(&m, "max-kbps", 30_000)?,
            min_kbps: num(&m, "min-kbps", 500)?,
            preset: m
                .get("preset")
                .cloned()
                .unwrap_or_else(|| "ultrafast".into()),
            encoder_threads: num(&m, "encoder-threads", (cores / 4).clamp(1, 4))?.max(1),
            adaptive_threads: m
                .get("adaptive-threads")
                .is_none_or(|v| matches!(v.as_str(), "true" | "1" | "yes" | "on")),
            convert_threads: num(&m, "convert-threads", 4)?,
            stripes: num(&m, "stripes", 1)?,
            coalesce_us: num(&m, "coalesce-us", 0)?,
            scroll_px_per_notch: num(&m, "scroll-px-per-notch", 120.0)?,
            rtc_udp,
            rtc_candidates,
            audio_source: m.get("audio-source").cloned().filter(|s| !s.is_empty()),
            audio_bitrate: num(&m, "audio-bitrate", 128_000)?,
            max_record_seconds: num(&m, "max-record-seconds", 300.0)?,
            record_dir: m.get("record-dir").cloned().filter(|d| !d.is_empty()),
            not_before: num(&m, "not-before", 0)?,
            // x264 unless asked: the GPU is the owner's, shared with whatever else they run, and a window must not
            // take it by accident (software-rendering.ts says the same for the browser's own rendering).
            encoder: crate::encoder::Request::parse(
                m.get("encoder").map_or("x264", String::as_str),
            )?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn the_flags_parse_with_their_defaults() {
        let c = Config::parse(&args(
            "--session browser-own --key-file /k --display :99 --crop 0,0,800,600 --max-size 3840x2400 --fps=30",
        ))
        .unwrap();
        assert_eq!(c.session, "browser-own");
        assert_eq!(c.socket, "/run/intentic/cast/browser-own.sock");
        assert_eq!(c.display.as_deref(), Some(":99"));
        assert_eq!(
            c.crop,
            Some(Rect {
                x: 0,
                y: 0,
                w: 800,
                h: 600
            })
        );
        assert_eq!(c.max_size, Some((3840, 2400)));
        assert_eq!(c.fps, 30);
        assert_eq!(c.socket_mode, 0o600);
        assert!(c.adaptive_threads);
        assert_eq!(c.audio_source, None);
    }

    #[test]
    fn bad_flags_are_refused_with_words() {
        assert!(Config::parse(&args("--key-file /k")).is_err());
        assert!(Config::parse(&args("--session a/b --key-file /k")).is_err());
        assert!(Config::parse(&args("--session s --key-file /k --crop 1,2")).is_err());
        assert!(Config::parse(&args("--session s --key-file /k --max-size 12")).is_err());
        assert!(Config::parse(&args("--session s --key-file /k --fps fast")).is_err());
        assert!(Config::parse(&args("--session s --key-file /k --nope 1")).is_err());
        assert!(Config::parse(&args("--session s --key-file /k --scale 0")).is_err());
    }

    #[test]
    fn a_peer_port_is_bound_and_named_where_viewers_reach_it() {
        let none = Config::parse(&args("--session s --key-file /k")).unwrap();
        assert_eq!((none.rtc_udp, none.rtc_candidates.len()), (None, 0));
        let c = Config::parse(&args(
            "--session s --key-file /k --rtc-udp 0.0.0.0:47800 --rtc-candidates 192.168.0.24,10.0.0.7:5000",
        ))
        .unwrap();
        assert_eq!(c.rtc_udp, Some("0.0.0.0:47800".parse().unwrap()));
        assert_eq!(
            c.rtc_candidates,
            [
                "192.168.0.24:47800".parse().unwrap(),
                "10.0.0.7:5000".parse().unwrap()
            ]
        );
        // Bound to an address a viewer can send to, that address is the candidate; bound to every address, none is.
        let own = Config::parse(&args("--session s --key-file /k --rtc-udp 127.0.0.1:9")).unwrap();
        assert_eq!(own.rtc_candidates, ["127.0.0.1:9".parse().unwrap()]);
        let any = Config::parse(&args("--session s --key-file /k --rtc-udp 0.0.0.0:9")).unwrap();
        assert!(any.rtc_candidates.is_empty());
        for bad in [
            "--rtc-udp 47800",
            "--rtc-candidates 1.2.3.4",
            "--rtc-udp 0.0.0.0:1 --rtc-candidates 0.0.0.0",
            "--rtc-udp 0.0.0.0:1 --rtc-candidates nope",
        ] {
            assert!(
                Config::parse(&args(&format!("--session s --key-file /k {bad}"))).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn session_names_are_browser_wires() {
        assert!(valid_session("browser-own_2"));
        assert!(!valid_session(""));
        assert!(!valid_session(&"a".repeat(65)));
        assert!(!valid_session("a.b"));
        assert!(!valid_session("../x"));
    }
}
