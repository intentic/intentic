//! cast-viewer: castd-bench over TCP, for a server that is not on this computer's Unix socket (cast-win's `serve`
//! example on a Windows PC, across the LAN). Connects as one viewer, acks every frame on arrival like a decoder that
//! takes no time, and prints JSON: frames per second, kbps, keyframes, and capture-to-arrival latency percentiles off
//! the headers (the capture time since the `hello`, so the hello's own transit is taken off: on a LAN that is well
//! under a millisecond). Builds wherever cast-core does, Windows included.
//!
//! `viewer --tcp HOST:PORT --session NAME (--key-file PATH | --key TEXT | --token T) [--seconds N] [--warmup N]`

use browser_wire::{BrowserMediaClientMessage, BrowserMediaServerMessage};
use cast_core::client::{MediaClient, Received};
use cast_core::header::{FLAG_KEY, FLAG_REFINE, KIND_VIDEO};
use std::collections::HashMap;
use std::time::{Duration, Instant};

fn args() -> HashMap<String, String> {
    let v: Vec<String> = std::env::args().skip(1).collect();
    let mut m = HashMap::new();
    let mut i = 0;
    while i < v.len() {
        let k = v[i].trim_start_matches("--").to_string();
        if i + 1 < v.len() && !v[i + 1].starts_with("--") {
            m.insert(k, v[i + 1].clone());
            i += 2;
        } else {
            m.insert(k, "true".into());
            i += 1;
        }
    }
    m
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let a = args();
    match run(&a).await {
        Ok(r) => println!("{}", serde_json::to_string_pretty(&r).unwrap()),
        Err(e) => {
            eprintln!("viewer: {e}");
            std::process::exit(1);
        }
    }
}

async fn run(a: &HashMap<String, String>) -> Result<serde_json::Value, String> {
    let addr = a.get("tcp").ok_or("--tcp HOST:PORT")?;
    let session = a.get("session").ok_or("--session NAME")?;
    let num = |k: &str, d: f64| a.get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let key = match (a.get("key-file"), a.get("key")) {
        (Some(p), _) => Some(std::fs::read(p).map_err(|e| format!("{p}: {e}"))?),
        (None, Some(k)) => Some(k.as_bytes().to_vec()),
        _ => None,
    };
    let token = match (a.get("token"), key) {
        (Some(t), _) => t.clone(),
        (None, Some(key)) => cast_core::token::sign(
            &key,
            &cast_core::token::Claims {
                s: session.clone(),
                exp: cast_core::token::now_ms() + 3_600_000,
                ro: true,
                iat: cast_core::token::now_ms(),
            },
        ),
        _ => return Err("--key-file, --key or --token".into()),
    };
    let stream = tokio::net::TcpStream::connect(addr)
        .await
        .map_err(|e| format!("connect {addr}: {e}"))?;
    let _ = stream.set_nodelay(true);
    let mut c =
        MediaClient::over(stream, session, &token, cast_core::media::Reach::default()).await?;
    let seconds = num("seconds", 10.0);
    let warmup = num("warmup", 1.0);
    let start = Instant::now();
    let mut hello = serde_json::Value::Null;
    let mut first_key_ms = None;
    while first_key_ms.is_none() {
        if start.elapsed() > Duration::from_secs(15) {
            return Err("no keyframe within 15 s".into());
        }
        match c.recv(Duration::from_secs(15)).await {
            None => return Err("the socket closed before a keyframe".into()),
            Some(Received::Json(m @ BrowserMediaServerMessage::Hello { .. })) => {
                hello = serde_json::to_value(&m).unwrap_or_default();
            }
            Some(Received::Media { header, .. }) if header.kind == KIND_VIDEO => {
                c.send(&BrowserMediaClientMessage::Ack {
                    id: header.id,
                    decode_ms: Some(0.0),
                })
                .await?;
                if header.flags & FLAG_KEY != 0 {
                    first_key_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
                }
            }
            _ => {}
        }
    }
    let from = Instant::now() + Duration::from_secs_f64(warmup);
    let to = from + Duration::from_secs_f64(seconds);
    let (mut frames, mut keys, mut refines, mut bytes) = (0u64, 0u64, 0u64, 0u64);
    let mut lat = Vec::new();
    let mut stats = serde_json::Value::Null;
    let mut gaps = Vec::new();
    let mut last_at: Option<Instant> = None;
    while Instant::now() < to {
        match c.recv(to.saturating_duration_since(Instant::now())).await {
            Some(Received::Media {
                header, len, at, ..
            }) if header.kind == KIND_VIDEO => {
                c.send(&BrowserMediaClientMessage::Ack {
                    id: header.id,
                    decode_ms: Some(0.0),
                })
                .await?;
                if at < from {
                    continue;
                }
                if let Some(prev) = last_at {
                    gaps.push(at.duration_since(prev).as_secs_f64() * 1000.0);
                }
                last_at = Some(at);
                frames += 1;
                bytes += len as u64;
                keys += u64::from(header.flags & FLAG_KEY != 0);
                refines += u64::from(header.flags & FLAG_REFINE != 0);
                if let Some(ms) = c.latency_ms(&header, at) {
                    lat.push(ms);
                }
            }
            Some(Received::Json(m @ BrowserMediaServerMessage::Stats { .. })) => {
                stats = serde_json::to_value(&m).unwrap_or_default();
            }
            Some(_) => {}
            None if Instant::now() < to => return Err("the socket closed".into()),
            None => {}
        }
    }
    c.close().await;
    lat.sort_by(f64::total_cmp);
    gaps.sort_by(f64::total_cmp);
    let r = |v: f64| (v * 100.0).round() / 100.0;
    Ok(serde_json::json!({
        "seconds": seconds,
        "hello": hello,
        "firstKeyframeMs": first_key_ms.map(r),
        "frames": frames,
        "keyframes": keys,
        "refines": refines,
        "fps": r(frames as f64 / seconds),
        "kbps": r(bytes as f64 * 8.0 / 1000.0 / seconds),
        "latencyMs": {
            "p50": r(percentile(&lat, 0.5)),
            "p90": r(percentile(&lat, 0.9)),
            "p99": r(percentile(&lat, 0.99)),
            "max": r(lat.last().copied().unwrap_or(f64::NAN)),
        },
        "gapMs": { "p50": r(percentile(&gaps, 0.5)), "p99": r(percentile(&gaps, 0.99)) },
        "lastStats": stats,
    }))
}
