//! castd-bench: connects to a castd socket as one viewer and reports, as JSON on stdout, the frames per second, the
//! bitrate, and each frame's capture -> receive latency read off its header (capture time since `hello`). It acks every
//! frame on arrival, like a decoder that takes no time, so castd's flow control never holds it back.
//!
//! `--scroll-px N` also drives the page: a scroll of N picture pixels at the picture's centre every `--scroll-hz`
//! (default 60), turning direction every `--flip-s` seconds (default 2) so a finite page keeps moving.

use browser_wire::{BrowserMediaClientMessage, BrowserMediaServerMessage};
use cast_core::client::{MediaClient, Received};
use cast_core::header::{FLAG_CLIP, FLAG_KEY, FLAG_REFINE, KIND_AUDIO, KIND_LOSSLESS, KIND_VIDEO};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const USAGE: &str = "\
castd-bench --socket PATH --session NAME (--key-file PATH | --token T) [options]

  --seconds N        how long to measure, after the first keyframe (default: 10)
  --warmup N         seconds to wait after the first keyframe before measuring (default: 1)
  --resize WxH@S     send this box (CSS px) and scale first, and measure the stream that follows
  --scroll-px N      scroll by N picture pixels per step while measuring
  --scroll-hz N      scroll steps per second (default: 60)
  --flip-s N         turn the scroll's direction every N seconds (default: 2)
  --read-only        mint a read-only token (with --key-file)
  --audio            ask for sound too, and count its packets
  --local            dial as a viewer on this computer's loopback (the header netd sets on such an upgrade)
  --lossless         ask for clipped frames and exact copies, and count them
  --hz N             say the display shows N pictures a second (with --resize)
";

fn args() -> Result<HashMap<String, String>, String> {
    let v: Vec<String> = std::env::args().skip(1).collect();
    let mut m = HashMap::new();
    let mut i = 0;
    while i < v.len() {
        let k = v[i]
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected {}", v[i]))?;
        if let Some((k, val)) = k.split_once('=') {
            m.insert(k.to_string(), val.to_string());
        } else if i + 1 < v.len() && !v[i + 1].starts_with("--") {
            m.insert(k.to_string(), v[i + 1].clone());
            i += 1;
        } else {
            m.insert(k.to_string(), "true".into());
        }
        i += 1;
    }
    Ok(m)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let i = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[i]
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let a = match args() {
        Ok(a) if a.contains_key("socket") && a.contains_key("session") => a,
        Ok(_) | Err(_) => {
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    };
    match run(&a).await {
        Ok(report) => println!("{}", serde_json::to_string_pretty(&report).unwrap()),
        Err(e) => {
            eprintln!("castd-bench: {e}");
            std::process::exit(1);
        }
    }
}

async fn run(a: &HashMap<String, String>) -> Result<serde_json::Value, String> {
    let num = |k: &str, d: f64| a.get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let session = &a["session"];
    let token = match (a.get("token"), a.get("key-file")) {
        (Some(t), _) => t.clone(),
        (None, Some(path)) => {
            let key = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
            cast_core::token::sign(
                &key,
                &cast_core::token::Claims {
                    s: session.clone(),
                    exp: cast_core::token::now_ms() + 3_600_000,
                    ro: a.contains_key("read-only"),
                    iat: cast_core::token::now_ms(),
                },
            )
        }
        (None, None) => return Err("--key-file or --token is required".into()),
    };
    let reach = cast_core::media::Reach {
        local: a.contains_key("local"),
        lossless: a.contains_key("lossless"),
    };
    let mut c = MediaClient::connect_as(&a["socket"], session, &token, reach).await?;
    if a.contains_key("audio") {
        c.send(&BrowserMediaClientMessage::Audio { on: true })
            .await?;
    }
    let mut want_hellos = 1;
    // The screen the resize asks for, in display pixels: one the screen has already gets no second hello.
    let mut asked = None;
    if let Some(r) = a.get("resize") {
        let (wh, s) = r.split_once('@').unwrap_or((r, "1"));
        let (w, h) = wh.split_once('x').ok_or("--resize WxH@S")?;
        let (width, height, scale): (u32, u32, f64) = (
            w.parse().map_err(|_| "--resize width")?,
            h.parse().map_err(|_| "--resize height")?,
            s.parse().map_err(|_| "--resize scale")?,
        );
        asked = Some((
            (f64::from(width) * scale).round() as u32 & !1,
            (f64::from(height) * scale).round() as u32 & !1,
        ));
        c.send(&BrowserMediaClientMessage::Resize {
            width,
            height,
            scale,
            hz: a.get("hz").and_then(|v| v.parse().ok()),
        })
        .await?;
        want_hellos = 2;
    }
    let seconds = num("seconds", 10.0);
    let warmup = num("warmup", 1.0);
    let scroll_px = num("scroll-px", 0.0);
    let scroll_every = Duration::from_secs_f64(1.0 / num("scroll-hz", 60.0).max(1.0));
    let flip = num("flip-s", 2.0).max(0.1);

    // Wait for the stream to settle into the geometry asked for: its hello, then a keyframe.
    let start = Instant::now();
    let mut hellos = 0;
    let mut hello = serde_json::Value::Null;
    let mut size = (0u32, 0u32);
    let mut first_key_ms = None;
    while first_key_ms.is_none() {
        if start.elapsed() > Duration::from_secs(15) {
            return Err("no keyframe within 15 s".into());
        }
        match c.recv(Duration::from_secs(15)).await {
            None => return Err("the socket closed before a keyframe".into()),
            Some(Received::Json(m @ BrowserMediaServerMessage::Hello { .. })) => {
                hellos += 1;
                if let BrowserMediaServerMessage::Hello { width, height, .. } = &m {
                    size = (*width, *height);
                    if hellos == 1 && asked == Some(size) {
                        want_hellos = 1;
                    }
                }
                hello = serde_json::to_value(&m).unwrap_or_default();
                // A resize to the size the screen already has sends no second hello: give it a moment.
                if hellos < want_hellos && want_hellos == 2 {
                    continue;
                }
            }
            Some(Received::Media { header, .. }) if header.kind == KIND_VIDEO => {
                c.send(&BrowserMediaClientMessage::Ack {
                    id: header.id,
                    decode_ms: Some(0.0),
                })
                .await?;
                if header.flags & FLAG_KEY != 0
                    && (hellos >= want_hellos || start.elapsed() > Duration::from_secs(2))
                {
                    first_key_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
                }
            }
            _ => {}
        }
    }

    let measure_from = Instant::now() + Duration::from_secs_f64(warmup);
    let measure_to = measure_from + Duration::from_secs_f64(seconds);
    let mut latencies = Vec::new();
    let (mut frames, mut keyframes, mut refines, mut bytes, mut audio) =
        (0u64, 0u64, 0u64, 0u64, 0u64);
    // Clipped frames, those that draw nothing, exact copies and their bytes.
    let (mut clipped, mut undrawn, mut copies, mut copy_bytes) = (0u64, 0u64, 0u64, 0u64);
    let mut last_stats = serde_json::Value::Null;
    let mut next_scroll = Instant::now();
    let mut dir = 1.0;
    let mut flipped_at = Instant::now();
    loop {
        let now = Instant::now();
        if now >= measure_to {
            break;
        }
        if scroll_px > 0.0 && now >= next_scroll {
            if flipped_at.elapsed().as_secs_f64() >= flip {
                dir = -dir;
                flipped_at = now;
            }
            c.send(&BrowserMediaClientMessage::Scroll {
                x: f64::from(size.0) / 2.0,
                y: f64::from(size.1) / 2.0,
                dx: 0.0,
                dy: scroll_px * dir,
            })
            .await?;
            next_scroll += scroll_every;
        }
        let wait = if scroll_px > 0.0 {
            next_scroll
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1))
        } else {
            measure_to.saturating_duration_since(Instant::now())
        };
        match c.recv(wait).await {
            Some(Received::Media {
                header,
                len,
                at,
                rect,
                ..
            }) if header.kind == KIND_VIDEO => {
                c.send(&BrowserMediaClientMessage::Ack {
                    id: header.id,
                    decode_ms: Some(0.0),
                })
                .await?;
                if at < measure_from {
                    continue;
                }
                frames += 1;
                if header.flags & FLAG_CLIP != 0 {
                    clipped += 1;
                    undrawn += u64::from(rect.is_some_and(|r| r.w == 0 || r.h == 0));
                }
                bytes += len as u64;
                keyframes += u64::from(header.flags & FLAG_KEY != 0);
                refines += u64::from(header.flags & FLAG_REFINE != 0);
                if let Some(ms) = c.latency_ms(&header, at) {
                    latencies.push(ms);
                }
            }
            Some(Received::Media { header, .. }) if header.kind == KIND_AUDIO => audio += 1,
            Some(Received::Media {
                header, len, at, ..
            }) if header.kind == KIND_LOSSLESS => {
                if at >= measure_from {
                    copies += 1;
                    copy_bytes += len as u64;
                }
            }
            Some(Received::Json(m @ BrowserMediaServerMessage::Stats { .. })) => {
                last_stats = serde_json::to_value(&m).unwrap_or_default();
            }
            Some(_) => {}
            None if Instant::now() < measure_to && scroll_px == 0.0 => {
                return Err("the socket closed".into());
            }
            None => {}
        }
    }
    c.close().await;
    latencies.sort_by(f64::total_cmp);
    let mean = if latencies.is_empty() {
        f64::NAN
    } else {
        latencies.iter().sum::<f64>() / latencies.len() as f64
    };
    let round = |v: f64| (v * 100.0).round() / 100.0;
    Ok(serde_json::json!({
        "seconds": seconds,
        "hello": hello,
        "firstKeyframeMs": first_key_ms.map(round),
        "frames": frames,
        "keyframes": keyframes,
        "refines": refines,
        "audioPackets": audio,
        "clippedFrames": clipped,
        "undrawnFrames": undrawn,
        "losslessCopies": copies,
        "losslessBytes": copy_bytes,
        "fps": round(frames as f64 / seconds),
        "kbps": round(bytes as f64 * 8.0 / 1000.0 / seconds),
        "bytes": bytes,
        "latencyMs": {
            "p50": round(percentile(&latencies, 0.5)),
            "p90": round(percentile(&latencies, 0.9)),
            "p99": round(percentile(&latencies, 0.99)),
            "max": round(latencies.last().copied().unwrap_or(f64::NAN)),
            "mean": round(mean),
        },
        "lastStats": last_stats,
    }))
}
