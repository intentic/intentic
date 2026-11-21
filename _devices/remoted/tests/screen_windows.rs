//! A Windows screen end to end, the built binary against a fake sandbox: the media socket on `/media/screen-<monitor>`
//! down the uplink, served from cast-win (DXGI duplication, the encoder its self-tests chose), frames acked as a browser
//! acks them. Windows only; run on the PC itself (`cargo xwin test --no-run`, then the suite and remoted copied there).
//!
//! `measure` (ignored) streams one monitor at its native size while cast-win's `pattern` example draws motion on it
//! (`REMOTED_MEASURE_PATTERN`, the path of `pattern.exe`), and prints frames per second, kilobits per second,
//! capture-to-arrival latency and remoted's CPU: what cast-win's README numbers are. `REMOTED_MEASURE_HELPER=1`
//! measures the same through the lock screen and admin prompts helper.
//!
//! The helper is run here by hand, as this user rather than SYSTEM (no administrator needed): it then sees what this
//! session sees, which is enough to prove the path itself (the pipe and its checks, the mirror shared across the two
//! processes, the rectangles, input typed by the helper). The secure desktop needs the real service.
#![cfg(windows)]

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use bytes::Bytes;
use cast_core::client::{MediaClient, Received};
use cast_core::header::{FLAG_KEY, KIND_VIDEO};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use remoted::token::{self, Claims};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tunnel::Liveness;
use tunnel::mux::{Opener, Stream};

const PATIENCE: Duration = Duration::from_secs(60);
const KEY: [u8; 32] = [5; 32];
const TOKEN: &str = "uplink-token";
const DEVICE: &str = "windows-screen-device";

fn media_key() -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(KEY)
}

fn viewer_token(subject: &str, ro: bool) -> String {
    let now = token::now_ms();
    token::sign(&KEY, &Claims { s: subject.to_owned(), exp: now + 600_000, ro, iat: now })
}

/// The fake sandbox's end of one uplink.
struct Uplink {
    opener: Opener,
    _closing: watch::Sender<Option<tunnel::Close>>,
    _pumping: tunnel::Pumping,
}

impl Uplink {
    async fn stream(&self) -> Stream {
        self.opener.open().await.expect("a stream opens down the uplink")
    }

    async fn call(&self, method: &str, path: &str) -> (u16, Value) {
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(self.stream().await))
            .await
            .expect("an HTTP/1.1 connection opens on a stream");
        tokio::spawn(connection);
        let request = hyper::Request::builder()
            .method(method)
            .uri(path)
            .header("host", "remoted")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let response = sender.send_request(request).await.expect("remoted answers");
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// A GET's status and body as bytes (a screenshot).
    async fn bytes(&self, path: &str) -> (u16, Bytes) {
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(self.stream().await))
            .await
            .expect("an HTTP/1.1 connection opens on a stream");
        tokio::spawn(connection);
        let request = hyper::Request::builder()
            .uri(path)
            .header("host", "remoted")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let response = sender.send_request(request).await.expect("remoted answers");
        let status = response.status().as_u16();
        (status, response.into_body().collect().await.unwrap().to_bytes())
    }

    async fn viewer(&self, session: &str, token: &str) -> Result<MediaClient<Stream>, String> {
        MediaClient::over_at(self.stream().await, "/media", session, token, cast_core::media::Reach::default()).await
    }
}

/// Takes remoted's uplink dials as netd does and hands each one's opener over.
async fn sandbox() -> (u16, mpsc::UnboundedReceiver<Uplink>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (taken, uplinks) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let (tcp, _) = listener.accept().await.unwrap();
            let taken = taken.clone();
            tokio::spawn(async move {
                if let Some(uplink) = take(tcp).await {
                    let _ = taken.send(uplink);
                }
            });
        }
    });
    (port, uplinks)
}

#[allow(clippy::result_large_err)]
async fn take(tcp: TcpStream) -> Option<Uplink> {
    let check = move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        if request.uri().path() != "/system/device-uplink"
            || request.headers()["authorization"] != format!("Bearer {TOKEN}").as_str()
        {
            let mut refused = ErrorResponse::new(Some("refused".into()));
            *refused.status_mut() = http::StatusCode::UNAUTHORIZED;
            return Err(refused);
        }
        Ok(response)
    };
    let socket = tokio_tungstenite::accept_hdr_async_with_config(tcp, check, Some(tunnel::socket_config()))
        .await
        .ok()?;
    let (closing, closed) = watch::channel(None);
    let (session, pumping) = tunnel::pump(socket, Liveness::Pings, closed);
    let (opener, _driving) = tunnel::mux::client(session);
    Some(Uplink { opener, _closing: closing, _pumping: pumping })
}

fn config(port: u16) -> Value {
    json!({
        "uplinks": [{
            "id": "link-w",
            "url": format!("http://127.0.0.1:{port}"),
            "device": DEVICE,
            "uplinkToken": TOKEN,
            "mediaKey": media_key(),
            "allow": { "view": true, "control": true, "terminal": false },
            "generation": 1,
        }]
    })
}

struct Remoted {
    child: Child,
    dir: PathBuf,
}

impl Remoted {
    async fn start(first: &Value) -> Self {
        Self::start_with(first, &[]).await
    }

    async fn start_with(first: &Value, env: &[(&str, String)]) -> Self {
        let dir = std::env::temp_dir().join(format!("remoted-wscreen-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("remoted.json");
        std::fs::write(&config, first.to_string()).unwrap();
        let mut child = Command::new(binary())
            .args(["run", "--config"])
            .arg(&config)
            .arg("--parent-stdin")
            .env("RUST_LOG", std::env::var("RUST_LOG").unwrap_or_else(|_| "remoted=debug,cast_win=info,cast_core=info,info".into()))
            .env("INTENTIC_REMOTED_NO_RTC", "1")
            .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("remoted starts");
        let stdout = child.stdout.take().unwrap();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
        Self { child, dir }
    }

    async fn end(mut self) {
        drop(self.child.stdin.take());
        let _ = tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The remoted under test: `CARGO_BIN_EXE_intentic-remoted` at run time (the suite copied to the PC), else beside the
/// suite or above it.
fn binary() -> PathBuf {
    if let Some(path) = std::env::var_os("CARGO_BIN_EXE_intentic-remoted").map(PathBuf::from) {
        return path;
    }
    if let Some(path) = option_env!("CARGO_BIN_EXE_intentic-remoted").map(PathBuf::from).filter(|p| p.is_file()) {
        return path;
    }
    let suite = std::env::current_exe().unwrap();
    suite
        .ancestors()
        .map(|dir| dir.join("intentic-remoted.exe"))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("no intentic-remoted.exe above {}", suite.display()))
}

/// The helper, run by hand from a folder standing in for the service's (`INTENTIC_REMOTED_SERVICE_HOME`): its own
/// copy of remoted in `bin\`, the secret beside it, its configuration on stdin.
struct Helper {
    child: std::process::Child,
    home: PathBuf,
}

impl Helper {
    fn start() -> Helper {
        let home = std::env::temp_dir().join(format!("remoted-helper-{}", std::process::id()));
        std::fs::create_dir_all(home.join("bin")).unwrap();
        let exe = home.join("bin").join("intentic-remoted.exe");
        std::fs::copy(binary(), &exe).unwrap();
        let secret = format!("test-{}-{}", std::process::id(), token::now_ms());
        std::fs::write(home.join("secret"), &secret).unwrap();
        let mut child = std::process::Command::new(&exe)
            .arg("desktop-helper")
            .env("RUST_LOG", "info")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the helper starts");
        let config = json!({
            "secret": secret,
            "clients": [binary()],
            "userSid": user_sid(),
            "version": "test",
        });
        use std::io::Write;
        writeln!(child.stdin.as_mut().unwrap(), "{config}").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        Helper { child, home }
    }

    fn env(&self) -> Vec<(&'static str, String)> {
        vec![("INTENTIC_REMOTED_SERVICE_HOME", self.home.display().to_string())]
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

/// This user's SID, as `whoami` says it.
fn user_sid() -> String {
    let out = std::process::Command::new("whoami").args(["/user", "/fo", "csv", "/nh"]).output().unwrap();
    let line = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    line.rsplit(',').next().unwrap_or_default().trim_matches('"').to_owned()
}

async fn ack(viewer: &mut MediaClient<Stream>, id: u32) {
    let _ = viewer.send(&browser_wire::BrowserMediaClientMessage::Ack { id, decode_ms: Some(1.0) }).await;
}

async fn hello(viewer: &mut MediaClient<Stream>) -> (u32, u32) {
    let deadline = Instant::now() + PATIENCE;
    while Instant::now() < deadline {
        if let Some(Received::Json(browser_wire::BrowserMediaServerMessage::Hello { width, height, .. })) =
            viewer.recv(Duration::from_secs(1)).await
        {
            return (width, height);
        }
    }
    panic!("no hello within {PATIENCE:?}");
}

/// Reads (and acks) video frames until `wanted` arrived or `within` passed: how many, and whether the first was a key.
async fn frames(viewer: &mut MediaClient<Stream>, wanted: usize, within: Duration) -> (usize, bool) {
    let deadline = Instant::now() + within;
    let (mut got, mut first_key) = (0, None);
    while got < wanted && Instant::now() < deadline {
        if let Some(Received::Media { header, .. }) = viewer.recv(Duration::from_millis(200)).await
            && header.kind == KIND_VIDEO
        {
            got += 1;
            first_key.get_or_insert(header.flags & FLAG_KEY != 0);
            ack(viewer, header.id).await;
        }
    }
    (got, first_key.unwrap_or(false))
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

/// CPU seconds a process (all its threads, user and kernel) used so far.
fn cpu_seconds(child: &Child) -> f64 {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetProcessTimes(process: *mut std::ffi::c_void, created: *mut u64, exited: *mut u64, kernel: *mut u64, user: *mut u64) -> i32;
    }
    let Some(handle) = child.raw_handle() else { return 0.0 };
    let (mut c, mut e, mut k, mut u) = (0u64, 0u64, 0u64, 0u64);
    // SAFETY: the live child's process handle and four FILETIMEs (two u32 each, as a u64) to fill.
    let ok = unsafe { GetProcessTimes(handle as *mut _, &mut c, &mut e, &mut k, &mut u) };
    if ok == 0 { 0.0 } else { (k + u) as f64 / 1e7 }
}

/// The monitor to stream: `REMOTED_MEASURE_MONITOR`, else the primary one.
fn pick(info: &Value) -> String {
    let monitors = info["monitors"].as_array().cloned().unwrap_or_default();
    if let Ok(id) = std::env::var("REMOTED_MEASURE_MONITOR") {
        return id;
    }
    monitors
        .iter()
        .find(|m| m["primary"] == true)
        .or(monitors.first())
        .and_then(|m| m["id"].as_str())
        .unwrap_or_else(|| panic!("no screen here: {info}"))
        .to_owned()
}

/// A monitor's picture arrives as frames, the first a keyframe, at its native size; `/stats` names the encoder `/info`
/// lists for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_monitor_is_streamed_at_its_native_size() {
    let (port, mut uplinks) = sandbox().await;
    let remoted = Remoted::start(&config(port)).await;
    let uplink = tokio::time::timeout(PATIENCE, uplinks.recv()).await.unwrap().unwrap();
    let (status, info) = uplink.call("GET", "/info").await;
    assert_eq!(status, 200);
    assert_eq!(info["screen"]["mode"], "dxgi", "{info}");
    let monitor = pick(&info);
    let size = info["monitors"].as_array().unwrap().iter().find(|m| m["id"] == monitor.as_str()).map(|m| {
        (m["width"].as_u64().unwrap() as u32 & !1, m["height"].as_u64().unwrap() as u32 & !1)
    });
    let session = format!("screen-{monitor}");
    let mut viewer = uplink.viewer(&session, &viewer_token(&format!("media/{session}"), false)).await.unwrap();
    assert_eq!(Some(hello(&mut viewer).await), size, "{info}");
    let (got, first_key) = frames(&mut viewer, 1, Duration::from_secs(20)).await;
    assert_eq!(got, 1, "no frame of {monitor}");
    assert!(first_key, "the first frame is a keyframe");
    let (_, stats) = uplink.call("GET", "/stats").await;
    assert_eq!(stats["screens"][0]["monitor"], monitor.as_str(), "{stats}");
    let encoder = stats["screens"][0]["encoder"].as_str().unwrap_or_default().to_owned();
    assert!(!encoder.is_empty(), "{stats}");
    assert!(stats["screens"][0]["capture"]["via"].is_string(), "{stats}");
    let (status, png) = uplink.bytes(&format!("/screenshot/{session}")).await;
    assert_eq!(status, 200);
    assert_eq!(&png[..4], b"\x89PNG");
    viewer.close().await;
    remoted.end().await;
}

/// The same monitor through the helper: its picture duplicated in the helper's process and read here from the mirror
/// it shares, the status saying so, a pointer move typed by the helper.
#[tokio::test(flavor = "multi_thread")]
async fn a_monitor_is_streamed_through_the_helper() {
    let helper = Helper::start();
    let (port, mut uplinks) = sandbox().await;
    let remoted = Remoted::start_with(&config(port), &helper.env()).await;
    let uplink = tokio::time::timeout(PATIENCE, uplinks.recv()).await.unwrap().unwrap();
    let (_, info) = uplink.call("GET", "/info").await;
    let monitor = pick(&info);
    let session = format!("screen-{monitor}");
    let mut viewer = uplink.viewer(&session, &viewer_token(&format!("media/{session}"), false)).await.unwrap();
    hello(&mut viewer).await;
    let (got, first_key) = frames(&mut viewer, 1, Duration::from_secs(20)).await;
    assert_eq!(got, 1, "no frame of {monitor} through the helper");
    assert!(first_key, "the first frame is a keyframe");
    let (_, stats) = uplink.call("GET", "/stats").await;
    assert_eq!(stats["screens"][0]["capture"]["via"], "helper", "{stats}");
    let (_, info) = uplink.call("GET", "/info").await;
    assert_eq!(info["screen"]["secureDesktop"]["connected"], true, "{info}");
    viewer.close().await;
    remoted.end().await;
    drop(helper);
}

/// `measure`: for each scene (cast-win's `pattern --mode scroll`, then `video`, in a window of `REMOTED_MEASURE_SIZE`,
/// default the whole monitor), `REMOTED_MEASURE_SECONDS` (default 10) of one viewer acking every frame.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn measure() {
    let seconds: u64 = std::env::var("REMOTED_MEASURE_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(10);
    let pattern = std::env::var("REMOTED_MEASURE_PATTERN").expect("REMOTED_MEASURE_PATTERN: the path of cast-win's pattern.exe");
    let helper = std::env::var_os("REMOTED_MEASURE_HELPER").map(|_| Helper::start());
    let (port, mut uplinks) = sandbox().await;
    let started = Instant::now();
    let env = helper.as_ref().map(Helper::env).unwrap_or_default();
    let remoted = Remoted::start_with(&config(port), &env).await;
    let uplink = tokio::time::timeout(PATIENCE, uplinks.recv()).await.unwrap().unwrap();
    let (_, info) = uplink.call("GET", "/info").await;
    println!("info: {info}");
    let monitor = pick(&info);
    let opened = Instant::now();
    let session = format!("screen-{monitor}");
    let mut viewer = uplink.viewer(&session, &viewer_token(&format!("media/{session}"), false)).await.unwrap();
    let size = hello(&mut viewer).await;
    let (got, _) = frames(&mut viewer, 1, PATIENCE).await;
    assert_eq!(got, 1);
    println!(
        "uplink up and /info {:?} after start; first frame {:.0} ms after the socket opened; {}x{}",
        opened - started,
        opened.elapsed().as_secs_f64() * 1000.0,
        size.0,
        size.1
    );
    for mode in ["scroll", "video"] {
        let mut args = vec![
            "--monitor".to_owned(),
            monitor.clone(),
            "--mode".into(),
            mode.into(),
            "--seconds".into(),
            (seconds + 3).to_string(),
            "--fps".into(),
            "60".into(),
        ];
        if let Ok(window) = std::env::var("REMOTED_MEASURE_SIZE") {
            args.extend(["--size".to_owned(), window]);
        }
        let mut painter = std::process::Command::new(&pattern).args(&args).spawn().expect("pattern.exe starts");
        let _ = frames(&mut viewer, usize::MAX, Duration::from_millis(1500)).await;
        let cpu0 = cpu_seconds(&remoted.child);
        let window = Instant::now();
        let (mut latencies, mut bytes, mut count, mut keys) = (Vec::new(), 0usize, 0usize, 0usize);
        while window.elapsed() < Duration::from_secs(seconds) {
            if let Some(Received::Media { header, len, at, .. }) = viewer.recv(Duration::from_millis(200)).await
                && header.kind == KIND_VIDEO
            {
                count += 1;
                bytes += len;
                keys += usize::from(header.flags & FLAG_KEY != 0);
                if let Some(ms) = viewer.latency_ms(&header, at) {
                    latencies.push(ms);
                }
                ack(&mut viewer, header.id).await;
            }
        }
        let elapsed = window.elapsed().as_secs_f64();
        let cpu = (cpu_seconds(&remoted.child) - cpu0) / elapsed;
        let _ = painter.wait();
        latencies.sort_by(f64::total_cmp);
        let (_, stats) = uplink.call("GET", "/stats").await;
        println!(
            "{mode}: {:.1} fps, {:.0} kbps, {keys} keyframes, capture to arrival p50 {:.1} ms / p95 {:.1} ms / p99 {:.1} ms, remoted CPU {:.2} cores, encoder {}, capture {}",
            count as f64 / elapsed,
            bytes as f64 * 8.0 / elapsed / 1000.0,
            percentile(&latencies, 0.5),
            percentile(&latencies, 0.95),
            percentile(&latencies, 0.99),
            cpu,
            stats["screens"][0]["encoder"],
            stats["screens"][0]["capture"]
        );
    }
    let (_, stats) = uplink.call("GET", "/stats").await;
    println!("stats: {stats}");
    viewer.close().await;
    remoted.end().await;
    drop(helper);
}

/// One key of a step, as the editor sends it.
async fn key(viewer: &mut MediaClient<Stream>, key: &str, code: &str, action: Option<browser_wire::KeyAction>) {
    viewer
        .send(&browser_wire::BrowserMediaClientMessage::Key {
            key: key.into(),
            code: (!code.is_empty()).then(|| code.into()),
            action,
            ctrl: None,
            shift: None,
            alt: None,
        })
        .await
        .unwrap();
}

/// `drive` (ignored): a person at the editor, scripted. Opens the primary monitor (through the lock screen and admin
/// prompts service's helper when it is installed, as remoted would for anyone) and runs `REMOTED_DRIVE`, steps split by
/// `;`: `shot:<name>` (the picture viewers get, into the folder `REMOTED_SHOTS`, with `/stats`' capture status
/// printed), `wait:<ms>`, `key:<Key>[:<Code>]` (pressed), `type:<text>`, `cad` (Ctrl+Alt+Del as the Keys menu sends
/// it: each key down in order, then up in reverse), `click:<x>,<y>`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn drive() {
    use browser_wire::{BrowserMediaClientMessage, KeyAction, PointerAction};
    let steps = std::env::var("REMOTED_DRIVE").unwrap_or_else(|_| "shot:now".into());
    let shots = PathBuf::from(std::env::var("REMOTED_SHOTS").unwrap_or_else(|_| ".".into()));
    std::fs::create_dir_all(&shots).unwrap();
    let (port, mut uplinks) = sandbox().await;
    let remoted = Remoted::start(&config(port)).await;
    let uplink = tokio::time::timeout(PATIENCE, uplinks.recv()).await.unwrap().unwrap();
    let (_, info) = uplink.call("GET", "/info").await;
    println!("screen: {}", info["screen"]);
    let monitor = pick(&info);
    let session = format!("screen-{monitor}");
    let mut viewer = uplink.viewer(&session, &viewer_token(&format!("media/{session}"), false)).await.unwrap();
    hello(&mut viewer).await;
    frames(&mut viewer, 1, PATIENCE).await;
    for step in steps.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        let (what, arg) = step.split_once(':').unwrap_or((step, ""));
        match what {
            "shot" => {
                frames(&mut viewer, usize::MAX, Duration::from_millis(700)).await;
                let (status, png) = uplink.bytes(&format!("/screenshot/{session}")).await;
                let path = shots.join(format!("{arg}.png"));
                if status == 200 {
                    std::fs::write(&path, &png).unwrap();
                }
                let (_, stats) = uplink.call("GET", "/stats").await;
                let (_, info) = uplink.call("GET", "/info").await;
                println!(
                    "shot {arg}: {status} -> {}; capture {}; session {}; service {}",
                    path.display(),
                    stats["screens"][0]["capture"],
                    info["screen"]["session"],
                    info["screen"]["secureDesktop"]
                );
            }
            "wait" => {
                frames(&mut viewer, usize::MAX, Duration::from_millis(arg.parse().unwrap_or(1000))).await;
            }
            "key" => {
                let (k, code) = arg.split_once(':').unwrap_or((arg, ""));
                key(&mut viewer, k, code, None).await;
            }
            "type" => viewer.send(&BrowserMediaClientMessage::Text { text: arg.into() }).await.unwrap(),
            "cad" => {
                let chord = [("Control", "ControlLeft"), ("Alt", "AltLeft"), ("Delete", "Delete")];
                for (k, c) in chord {
                    key(&mut viewer, k, c, Some(KeyAction::Down)).await;
                }
                for (k, c) in chord.iter().rev() {
                    key(&mut viewer, k, c, Some(KeyAction::Up)).await;
                }
            }
            "click" => {
                let (x, y) = arg.split_once(',').unwrap();
                let (x, y): (f64, f64) = (x.parse().unwrap(), y.parse().unwrap());
                for action in [PointerAction::Move, PointerAction::Down, PointerAction::Up] {
                    viewer
                        .send(&BrowserMediaClientMessage::Mouse {
                            action,
                            x,
                            y,
                            button: (action != PointerAction::Move).then_some(0),
                            buttons: Some(u8::from(action == PointerAction::Down)),
                            click_count: (action != PointerAction::Move).then_some(1),
                            ctrl: None,
                            shift: None,
                            alt: None,
                        })
                        .await
                        .unwrap();
                }
            }
            other => panic!("unknown step {other:?}"),
        }
        frames(&mut viewer, usize::MAX, Duration::from_millis(200)).await;
    }
    viewer.close().await;
    remoted.end().await;
}
