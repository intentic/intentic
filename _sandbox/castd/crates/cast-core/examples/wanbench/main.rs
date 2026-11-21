//! wanbench: cast-core serving a synthetic moving picture to a real browser across an impaired link, for measuring
//! what a person sees across the internet. The picture is a page of text-like lines scrolling a few pixels a frame
//! with a box moving over it, and its top row carries a stamp (the wall-clock millisecond it was painted, a counter and
//! a checksum, 16-pixel blocks) that the viewer page reads back off every picture it shows, so capture-to-glass is
//! measured on the pixels themselves, whichever way they travelled. `run.sh` puts this server and a headless Chrome in
//! two network namespaces joined by a veth pair whose qdiscs (netem, tbf) are the WAN; this binary changes the
//! bandwidth cap on its own end as the run goes (`--caps`), samples what it sent, and writes the page's report with its
//! own timeline to `--out`.
//!
//! `wanbench --listen IP:PORT --rtc IP:0 --out FILE [--encoder openh264|x264] [--size 1280x720] [--fps 60]
//!  [--seconds 60] [--warmup 4] [--dev IFACE --caps 0:8000,20:2000,40:8000 --buffer-ms 100] [--mode dc|track]`

mod scene;

use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use cast_core::encoder::{EncoderKind, Encoders};
use cast_core::hub::Hub;
use cast_core::server::{App, router};
use cast_core::video::{self, VideoConfig};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

const SESSION: &str = "wan";
const PAGE: &str = include_str!("page.html");

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

/// A bandwidth step: from `at` seconds into the measurement, the link's downstream carries `kbps`.
#[derive(Debug, Clone, Copy, serde::Serialize)]
struct Cap {
    at: f64,
    kbps: u32,
}

fn parse_caps(s: &str) -> Result<Vec<Cap>, String> {
    s.split(',')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (at, kbps) = p.split_once(':').ok_or(format!("--caps {p}: AT:KBPS"))?;
            Ok(Cap {
                at: at.parse().map_err(|e| format!("--caps {p}: {e}"))?,
                kbps: kbps.parse().map_err(|e| format!("--caps {p}: {e}"))?,
            })
        })
        .collect()
}

/// What the link's bottleneck is set to: tbf under netem on `dev` (run.sh made it), a buffer of `buffer_ms` at the rate.
fn set_cap(dev: &str, kbps: u32, buffer_ms: u32) {
    let bytes_per_s = kbps as u64 * 1000 / 8;
    let burst = (bytes_per_s / 200).max(3000);
    let limit = (bytes_per_s * buffer_ms as u64 / 1000).max(15_000);
    let status = std::process::Command::new("tc")
        .args([
            "qdisc", "change", "dev", dev, "parent", "1:1", "handle", "10:", "tbf",
        ])
        .args([
            "rate",
            &format!("{kbps}kbit"),
            "burst",
            &burst.to_string(),
            "limit",
            &limit.to_string(),
        ])
        .status();
    match status {
        Ok(s) if s.success() => log::info!("cap {kbps} kbit/s on {dev}"),
        other => log::error!("tc on {dev}: {other:?}"),
    }
}

/// One sample of what the server did, every quarter second of the measurement.
#[derive(Debug, Clone, serde::Serialize)]
struct Sample {
    t: f64,
    /// Video bytes the encoder handed viewers since the last sample, as kbit/s.
    sent_kbps: f64,
    target_kbps: u32,
    cap_kbps: Option<u32>,
    keyframes: u64,
    encoded: u64,
    rtt_ms: u32,
    on_peer: bool,
    /// Captures the steering viewer's backlog held back, and frames a lagging viewer skipped, so far.
    flow_blocked: u64,
    skipped: u64,
    /// The track's congestion estimate and its modelled queue, when the pictures ride one.
    estimate_kbps: Option<f64>,
    queue_ms: Option<f64>,
}

struct Run {
    started: Option<Instant>,
    samples: Vec<Sample>,
    done: bool,
}

#[derive(Clone)]
struct Bench {
    app: App,
    config: serde_json::Value,
    out: String,
    run: Arc<Mutex<Run>>,
    caps: Vec<Cap>,
    dev: Option<String>,
    buffer_ms: u32,
    seconds: f64,
}

fn encoders(name: &str) -> Result<Encoders, String> {
    let kind: Arc<dyn EncoderKind> = match name {
        "x264" => Arc::new(cast_core::encoder::Backend::X264),
        "openh264" => Arc::new(cast_core::openh264::OpenH264),
        other => return Err(format!("--encoder {other}: x264 or openh264")),
    };
    Ok(Encoders {
        primary: kind.clone(),
        fallback: kind,
    })
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    env_logger_init();
    if let Err(e) = run(args()).await {
        eprintln!("wanbench: {e}");
        std::process::exit(1);
    }
}

fn env_logger_init() {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Info
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                eprintln!("{} {}: {}", r.level(), r.target(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
}

async fn run(a: HashMap<String, String>) -> Result<(), String> {
    let num = |k: &str, d: f64| a.get(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(d);
    let listen: SocketAddr = a
        .get("listen")
        .ok_or("--listen IP:PORT")?
        .parse()
        .map_err(|e| format!("--listen: {e}"))?;
    let rtc: SocketAddr = a
        .get("rtc")
        .ok_or("--rtc IP:0")?
        .parse()
        .map_err(|e| format!("--rtc: {e}"))?;
    let out = a.get("out").ok_or("--out FILE")?.clone();
    let (w, h) = a
        .get("size")
        .map(String::as_str)
        .unwrap_or("1280x720")
        .split_once('x')
        .and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?)))
        .ok_or("--size WxH")?;
    let fps = num("fps", 60.0) as u32;
    let encoder = a.get("encoder").map(String::as_str).unwrap_or("openh264");
    let caps = parse_caps(a.get("caps").map(String::as_str).unwrap_or(""))?;
    let dev = a.get("dev").cloned();
    let buffer_ms = num("buffer-ms", 100.0) as u32;
    let seconds = num("seconds", 60.0);

    let hub = Hub::new(1.0, None);
    let key = b"wanbench-key".to_vec();
    let token = cast_core::token::sign(
        &key,
        &cast_core::token::Claims {
            s: SESSION.into(),
            exp: cast_core::token::now_ms() + 3_600_000,
            ro: false,
            iat: 0,
        },
    );
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get()) as u32;
    let cfg = VideoConfig {
        crop: None,
        fps,
        preset: "ultrafast".into(),
        threads: (cores / 4).clamp(1, 4),
        convert_threads: (cores as usize / 2).clamp(1, 4),
        crf: 24.0,
        max_kbps: num("max-kbps", 30_000.0) as u32,
        paintover_crf: 16.0,
        paintover_burst: 3,
        paintover_delay_ms: 150,
        min_kbps: 300,
        local_crf: 18.0,
        local_max_kbps: 200_000,
        local_fps: fps,
        lossless: false,
        lossless_delay: Duration::from_millis(100),
        coalesce: Duration::ZERO,
        stripes: 1,
        adaptive_threads: true,
        encoder: encoders(encoder)?,
    };
    let source = scene::Scene::start(w, h, num("app-fps", fps as f64) as u32);
    video::spawn(cfg, hub.clone(), Box::new(source))?;
    let bound = cast_core::rtc::start(rtc, vec![rtc])
        .await
        .map_err(|e| format!("--rtc {rtc}: {e}"))?;
    log::info!("peer port {bound:?}");
    let app = App {
        hub: hub.clone(),
        key: Arc::new(key),
        session: Arc::new(SESSION.into()),
        recorder: cast_core::record::Recorder::new(hub.clone(), Duration::from_secs(5), None),
    };
    if let (Some(dev), Some(first)) = (&dev, caps.first()) {
        set_cap(dev, first.kbps, buffer_ms);
    }
    let bench = Bench {
        app: app.clone(),
        config: serde_json::json!({
            "session": SESSION,
            "token": token,
            "mode": a.get("mode").map(String::as_str).unwrap_or("dc"),
            "seconds": seconds,
            "warmup": num("warmup", 4.0),
            "label": a.get("label").cloned().unwrap_or_default(),
        }),
        out,
        run: Arc::new(Mutex::new(Run {
            started: None,
            samples: Vec::new(),
            done: false,
        })),
        caps,
        dev,
        buffer_ms,
        seconds,
    };
    let bench_routes = Router::new()
        .route("/", get(page))
        .route("/config", get(config))
        .route("/start", post(start))
        .route("/result", post(result))
        .with_state(bench.clone());
    let routes = router(app).merge(bench_routes);
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|e| format!("--listen {listen}: {e}"))?;
    log::info!("serving http://{listen}/");
    println!("READY http://{listen}/");
    let deadline = Duration::from_secs_f64(seconds + 120.0);
    tokio::select! {
        r = axum::serve(listener, routes) => r.map_err(|e| e.to_string()),
        () = tokio::time::sleep(deadline) => Err(format!("no result within {deadline:?}")),
        () = finished(bench.run.clone()) => Ok(()),
    }
}

async fn finished(run: Arc<Mutex<Run>>) {
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if run.lock().done {
            return;
        }
    }
}

async fn page() -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], PAGE).into_response()
}

async fn config(State(b): State<Bench>) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        b.config.to_string(),
    )
        .into_response()
}

/// The page is measuring from now: the cap schedule and the server's samples start.
async fn start(State(b): State<Bench>) -> Response {
    {
        let mut run = b.run.lock();
        if run.started.is_some() {
            return StatusCode::OK.into_response();
        }
        run.started = Some(Instant::now());
    }
    let hub = b.app.hub.clone();
    tokio::spawn(sample(b.clone(), hub));
    StatusCode::OK.into_response()
}

async fn sample(b: Bench, hub: Arc<Hub>) {
    let t0 = Instant::now();
    let mut next_cap = 0usize;
    let mut cap_now = None;
    let mut last_bytes = hub.stats.bytes.load(Ordering::Relaxed);
    let mut last_at = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    loop {
        tick.tick().await;
        let t = t0.elapsed().as_secs_f64();
        while next_cap < b.caps.len() && b.caps[next_cap].at <= t {
            let cap = b.caps[next_cap];
            if let Some(dev) = &b.dev {
                set_cap(dev, cap.kbps, b.buffer_ms);
            }
            cap_now = Some(cap.kbps);
            next_cap += 1;
        }
        let bytes = hub.stats.bytes.load(Ordering::Relaxed);
        let dt = last_at.elapsed().as_secs_f64().max(1e-3);
        last_at = Instant::now();
        let client = hub.clients.lock().first().cloned();
        let s = Sample {
            t,
            sent_kbps: (bytes - last_bytes) as f64 * 8.0 / 1000.0 / dt,
            target_kbps: hub.target_kbps.load(Ordering::Relaxed),
            cap_kbps: cap_now,
            keyframes: hub.stats.keyframes.load(Ordering::Relaxed),
            encoded: hub.stats.encoded.load(Ordering::Relaxed),
            rtt_ms: client
                .as_ref()
                .map_or(0, |c| c.min_rtt_ms.load(Ordering::Relaxed)),
            on_peer: client
                .as_ref()
                .is_some_and(|c| c.on_peer.load(Ordering::Relaxed)),
            flow_blocked: hub.stats.flow_blocked.load(Ordering::Relaxed),
            skipped: hub.stats.skipped.load(Ordering::Relaxed),
            estimate_kbps: client
                .as_ref()
                .and_then(|c| c.on_track())
                .and_then(|t| t.estimate_kbps()),
            queue_ms: client
                .as_ref()
                .and_then(|c| c.on_track())
                .map(|t| t.queue_ms()),
        };
        last_bytes = bytes;
        let mut run = b.run.lock();
        run.samples.push(s);
        if run.done || t > b.seconds + 30.0 {
            return;
        }
    }
}

/// The page's report: written with the server's timeline, and the run is over.
async fn result(State(b): State<Bench>, body: String) -> Response {
    let page: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    let samples = b.run.lock().samples.clone();
    let report = serde_json::json!({
        "config": b.config,
        "caps": b.caps,
        "bufferMs": b.buffer_ms,
        "server": samples,
        "page": page,
    });
    if let Err(e) = std::fs::write(&b.out, serde_json::to_string_pretty(&report).unwrap()) {
        log::error!("writing {}: {e}", b.out);
    }
    b.run.lock().done = true;
    StatusCode::OK.into_response()
}
