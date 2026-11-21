//! A screen end to end, the built binary against a fake sandbox, on an X server the suite starts: the media socket on
//! `/media/screen-<monitor>` down the uplink, frames acked as a browser acks them, input reaching the display through
//! XTEST at the monitor's origin, a watcher's and a switched-off person's input dropped, the view switch closing the
//! sockets, and the pipeline stopped after its linger. Linux; stands down where there is no Xvfb, or where the build
//! has no H.264 encoder (the default build's openh264; `--features x264` here).
//!
//! `measure` (ignored) streams a virtual desktop remoted starts itself, under painted motion, and prints frames per
//! second, kilobits per second, capture-to-arrival latency and CPU: what the README's numbers are.
#![cfg(target_os = "linux")]

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
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
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{self, ConnectionExt as _};

const PATIENCE: Duration = Duration::from_secs(60);
const KEY: [u8; 32] = [9; 32];
const TOKEN: &str = "uplink-token";
const DEVICE: &str = "screen-device";

fn media_key() -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(KEY)
}

fn viewer_token(subject: &str, ro: bool) -> String {
    let now = token::now_ms();
    token::sign(
        &KEY,
        &Claims {
            s: subject.to_owned(),
            exp: now + 600_000,
            ro,
            iat: now,
        },
    )
}

/// The fake sandbox's end of one uplink: streams opened down it as netd opens them.
struct Uplink {
    opener: Opener,
    _closing: watch::Sender<Option<tunnel::Close>>,
    _pumping: tunnel::Pumping,
}

impl Uplink {
    async fn stream(&self) -> Stream {
        self.opener
            .open()
            .await
            .expect("a stream opens down the uplink")
    }

    async fn call(&self, method: &str, path: &str) -> (u16, Value) {
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(self.stream().await))
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
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// A viewer on `screen-<monitor>`, or the status its upgrade was refused with.
    async fn viewer(&self, session: &str, token: &str) -> Result<MediaClient<Stream>, String> {
        MediaClient::over_at(
            self.stream().await,
            "/media",
            session,
            token,
            cast_core::media::Reach::default(),
        )
        .await
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
    let socket =
        tokio_tungstenite::accept_hdr_async_with_config(tcp, check, Some(tunnel::socket_config()))
            .await
            .ok()?;
    let (closing, closed) = watch::channel(None);
    let (session, pumping) = tunnel::pump(socket, Liveness::Pings, closed);
    let (opener, _driving) = tunnel::mux::client(session);
    Some(Uplink {
        opener,
        _closing: closing,
        _pumping: pumping,
    })
}

fn config(port: u16, view: bool, control: bool) -> Value {
    with_ice(port, view, control, None)
}

/// The config with the sandbox's STUN servers on its uplink (`iceServers`), as an agent advertising `remote-ice` writes.
fn with_ice(port: u16, view: bool, control: bool, ice: Option<Vec<String>>) -> Value {
    let mut config = json!({
        "uplinks": [{
            "id": "link-s",
            "url": format!("http://127.0.0.1:{port}"),
            "device": DEVICE,
            "uplinkToken": TOKEN,
            "mediaKey": media_key(),
            "allow": { "view": view, "control": control, "terminal": false },
            "generation": 1,
        }]
    });
    if let Some(ice) = ice {
        config["uplinks"][0]["iceServers"] = json!(ice);
    }
    config
}

/// remoted with a config file of its own, and the environment the test gives it.
struct Remoted {
    child: Child,
    config: PathBuf,
    dir: PathBuf,
}

impl Remoted {
    async fn start(first: &Value, env: &[(&str, String)]) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "remoted-screen-{}-{}",
            std::process::id(),
            first_free()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("remoted.json");
        write_config(&config, first);
        let mut command = Command::new(binary());
        command
            .args(["run", "--config"])
            .arg(&config)
            .arg("--parent-stdin")
            .env(
                "RUST_LOG",
                "remoted=debug,cast_core=info,cast_x11=info,info,zbus=warn,tracing=warn",
            )
            .env("INTENTIC_REMOTED_NO_RTC", "1")
            .env_remove("WAYLAND_DISPLAY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        // An empty value takes the variable away (`INTENTIC_REMOTED_NO_RTC` for a test of peers).
        for (key, value) in env {
            if value.is_empty() {
                command.env_remove(key);
            } else {
                command.env(key, value);
            }
        }
        let mut child = command.spawn().expect("remoted starts");
        let stdout = child.stdout.take().unwrap();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
        Self { child, config, dir }
    }

    fn rewrite(&self, config: &Value) {
        let staged = self.config.with_extension("tmp");
        write_config(&staged, config);
        std::fs::rename(&staged, &self.config).unwrap();
    }

    /// Ends remoted as the agent does (stdin closed) and waits for it.
    async fn end(mut self) {
        drop(self.child.stdin.take());
        let _ = tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn first_free() -> usize {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

fn write_config(path: &std::path::Path, config: &Value) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, config.to_string()).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

/// The remoted under test: `CARGO_BIN_EXE_intentic-remoted` at run time (the suite copied to another computer), else
/// where cargo built it, else found up from where the suite runs.
fn binary() -> PathBuf {
    if let Some(path) = std::env::var_os("CARGO_BIN_EXE_intentic-remoted").map(PathBuf::from) {
        return path;
    }
    if let Some(path) = option_env!("CARGO_BIN_EXE_intentic-remoted")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        return path;
    }
    let suite = std::env::current_exe().unwrap();
    suite
        .ancestors()
        .map(|dir| dir.join("intentic-remoted"))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("no intentic-remoted above {}", suite.display()))
}

/// An Xvfb of the suite's own, ended when dropped.
struct Xvfb {
    child: std::process::Child,
    display: String,
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let _ = self.child.wait();
    }
}

fn xvfb_path() -> Option<PathBuf> {
    let path = PathBuf::from(
        std::env::var("REMOTED_TEST_XVFB").unwrap_or_else(|_| "/usr/bin/Xvfb".into()),
    );
    path.exists().then_some(path)
}

/// The next display number this suite may try. Its tests start their servers side by side: a number is handed out once
/// in this process, so two never pick the same free one before either server took it.
static NEXT_DISPLAY: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(150);

fn start_xvfb(width: u32, height: u32) -> Option<Xvfb> {
    let xvfb = xvfb_path()?;
    loop {
        let n = NEXT_DISPLAY.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if n >= 250 {
            return None;
        }
        if std::path::Path::new(&format!("/tmp/.X11-unix/X{n}")).exists()
            || std::path::Path::new(&format!("/tmp/.X{n}-lock")).exists()
        {
            continue;
        }
        let display = format!(":{n}");
        let child = std::process::Command::new(&xvfb)
            .args([
                &display,
                "-screen",
                "0",
                &format!("{width}x{height}x24"),
                "-nolisten",
                "tcp",
                "-ac",
                "-noreset",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut x = Xvfb { child, display };
        let started = Instant::now();
        let mut lost = false;
        while x11rb::connect(Some(&x.display)).is_err() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "Xvfb did not start"
            );
            if matches!(x.child.try_wait(), Ok(Some(_))) {
                lost = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Another process's server took the number first (ours exits finding its lock): the next one.
        std::thread::sleep(Duration::from_millis(100));
        if lost || matches!(x.child.try_wait(), Ok(Some(_))) {
            continue;
        }
        return Some(x);
    }
}

/// Draws on the display's root window, and reads where its pointer is.
struct Painter {
    conn: x11rb::rust_connection::RustConnection,
    root: u32,
    gc: u32,
}

impl Painter {
    fn new(display: &str) -> Painter {
        let (conn, n) = cast_x11::connect::connect(Some(display)).expect("the painter connects");
        let root = conn.setup().roots[n].root;
        let gc = conn.generate_id().unwrap();
        conn.create_gc(gc, root, &xproto::CreateGCAux::new())
            .unwrap();
        Painter { conn, root, gc }
    }

    /// A painter on a window of its own over the screen's top left, above everything and undecorated (override-redirect):
    /// what changes on a real X server whose root window shows nothing (a rootless Xwayland), and under any window
    /// manager.
    fn window(display: &str, width: u16, height: u16) -> Painter {
        let mut painter = Painter::new(display);
        let window = painter.conn.generate_id().unwrap();
        painter
            .conn
            .create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                window,
                painter.root,
                0,
                0,
                width,
                height,
                0,
                xproto::WindowClass::INPUT_OUTPUT,
                x11rb::COPY_FROM_PARENT,
                &xproto::CreateWindowAux::new()
                    .override_redirect(1)
                    .background_pixel(0x0020_3040),
            )
            .unwrap();
        painter.conn.map_window(window).unwrap();
        painter.conn.flush().unwrap();
        painter.root = window;
        painter
    }

    fn fill(&self, x: i16, y: i16, w: u16, h: u16, rgb: u32) {
        self.conn
            .change_gc(self.gc, &xproto::ChangeGCAux::new().foreground(rgb))
            .unwrap();
        self.conn
            .poly_fill_rectangle(
                self.root,
                self.gc,
                &[xproto::Rectangle {
                    x,
                    y,
                    width: w,
                    height: h,
                }],
            )
            .unwrap();
        self.conn.flush().unwrap();
    }

    fn pointer(&self) -> (i16, i16) {
        let reply = self.conn.query_pointer(self.root).unwrap().reply().unwrap();
        (reply.root_x, reply.root_y)
    }

    /// A RandR 1.5 monitor over part of the screen: a second monitor as a person's dual-head would list.
    fn add_monitor(&self, name: &str, x: i16, y: i16, w: u16, h: u16) {
        use x11rb::protocol::randr::{ConnectionExt as _, MonitorInfo};
        let atom = self
            .conn
            .intern_atom(false, name.as_bytes())
            .unwrap()
            .reply()
            .unwrap()
            .atom;
        self.conn
            .randr_set_monitor(
                self.root,
                MonitorInfo {
                    name: atom,
                    primary: false,
                    automatic: false,
                    x,
                    y,
                    width: w,
                    height: h,
                    width_in_millimeters: u32::from(w) / 4,
                    height_in_millimeters: u32::from(h) / 4,
                    outputs: Vec::new(),
                },
            )
            .unwrap()
            .check()
            .unwrap();
    }
}

/// Reads until a video frame arrives, acking each as a browser does; answers the frames read and whether the first
/// was a keyframe.
async fn frames(
    viewer: &mut MediaClient<Stream>,
    wanted: usize,
    within: Duration,
) -> (usize, bool) {
    let deadline = Instant::now() + within;
    let mut got = 0;
    let mut first_key = None;
    while got < wanted && Instant::now() < deadline {
        match viewer.recv(Duration::from_millis(200)).await {
            Some(Received::Media { header, .. }) if header.kind == KIND_VIDEO => {
                got += 1;
                first_key.get_or_insert(header.flags & FLAG_KEY != 0);
                ack(viewer, header.id).await;
            }
            Some(_) => {}
            None => {}
        }
    }
    (got, first_key.unwrap_or(false))
}

async fn ack(viewer: &mut MediaClient<Stream>, id: u32) {
    let _ = viewer
        .send(&browser_wire::BrowserMediaClientMessage::Ack {
            id,
            decode_ms: Some(1.0),
        })
        .await;
}

/// The hello's picture size.
async fn hello(viewer: &mut MediaClient<Stream>) -> (u32, u32) {
    let deadline = Instant::now() + PATIENCE;
    while Instant::now() < deadline {
        if let Some(Received::Json(browser_wire::BrowserMediaServerMessage::Hello {
            width,
            height,
            ..
        })) = viewer.recv(Duration::from_secs(1)).await
        {
            return (width, height);
        }
    }
    panic!("no hello within {PATIENCE:?}");
}

async fn move_to(viewer: &mut MediaClient<Stream>, x: f64, y: f64) {
    viewer
        .send(&browser_wire::BrowserMediaClientMessage::Mouse {
            action: browser_wire::PointerAction::Move,
            x,
            y,
            button: None,
            buttons: None,
            click_count: None,
            ctrl: None,
            shift: None,
            alt: None,
        })
        .await
        .unwrap();
}

/// Reads (and acks) what arrives for `quiet`: input queued behind frames is handled meanwhile.
async fn settle(viewer: &mut MediaClient<Stream>, quiet: Duration) {
    let _ = frames(viewer, usize::MAX, quiet).await;
}

/// Reads until the socket closes; answers whether it did within `within`. `recv` answers None both when the socket
/// ended and when its wait ran out (the server's pings are not messages), so an end is a None well before the wait.
async fn closed(viewer: &mut MediaClient<Stream>, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        let asked = Instant::now();
        if viewer.recv(Duration::from_secs(2)).await.is_none()
            && asked.elapsed() < Duration::from_millis(1800)
        {
            return true;
        }
    }
    false
}

#[tokio::test(flavor = "multi_thread")]
async fn a_screen_is_streamed_typed_into_shared_gated_and_stopped() {
    let Some(x) = start_xvfb(1280, 720) else {
        eprintln!("remoted's screen test stands down: no Xvfb (REMOTED_TEST_XVFB)");
        return;
    };
    let painter = Painter::new(&x.display);
    // A person's dual-head: the right half is a monitor of its own.
    painter.add_monitor("TEST-RIGHT", 640, 0, 640, 720);
    let (port, mut uplinks) = sandbox().await;
    let remoted = Remoted::start(
        &config(port, true, true),
        &[
            ("INTENTIC_REMOTED_SCREEN", format!("x11:{}", x.display)),
            ("INTENTIC_REMOTED_LINGER_MS", "500".into()),
        ],
    )
    .await;
    let uplink = tokio::time::timeout(PATIENCE, uplinks.recv())
        .await
        .unwrap()
        .unwrap();

    let (status, info) = uplink.call("GET", "/info").await;
    assert_eq!(status, 200);
    assert_eq!(info["screen"]["mode"], "x11", "{info}");
    let encoders = info["encoders"].as_array().cloned().unwrap_or_default();
    if encoders.is_empty() {
        eprintln!("remoted's screen test stands down: this build has no H.264 encoder ({info})");
        remoted.end().await;
        return;
    }
    let ids: Vec<&str> = info["monitors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"TEST-RIGHT"), "{info}");

    // Refusals before any upgrade: a token for something else, a screen there is not.
    let wrong = viewer_token("terminal/screen-TEST-RIGHT", false);
    assert!(uplink.viewer("screen-TEST-RIGHT", &wrong).await.is_err());
    let missing = viewer_token("media/screen-nope", false);
    let refused = uplink.viewer("screen-nope", &missing).await.err().unwrap();
    assert!(refused.contains("404"), "{refused}");

    // The person who drives: the monitor's picture, frames as the screen changes, the first a keyframe.
    let control = viewer_token("media/screen-TEST-RIGHT", false);
    let mut driver = uplink.viewer("screen-TEST-RIGHT", &control).await.unwrap();
    assert_eq!(hello(&mut driver).await, (640, 720));
    let painting = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let paints = {
        let painting = painting.clone();
        let display = x.display.clone();
        std::thread::spawn(move || {
            let painter = Painter::new(&display);
            let mut i = 0u32;
            while painting.load(std::sync::atomic::Ordering::Relaxed) {
                painter.fill(700 + (i % 200) as i16, 100, 100, 100, 0x0030_60c0 + i);
                i += 1;
                std::thread::sleep(Duration::from_millis(16));
            }
        })
    };
    let (got, first_key) = frames(&mut driver, 10, Duration::from_secs(20)).await;
    assert!(got >= 10, "only {got} frames of the painted monitor");
    assert!(first_key, "the first frame is a keyframe");

    // Input lands on the display at the monitor's origin.
    move_to(&mut driver, 10.0, 20.0).await;
    settle(&mut driver, Duration::from_millis(500)).await;
    assert_eq!(painter.pointer(), (650, 20));

    // A watcher on the same pipeline: its picture, and its input dropped.
    let watch = viewer_token("media/screen-TEST-RIGHT", true);
    let mut watcher = uplink.viewer("screen-TEST-RIGHT", &watch).await.unwrap();
    assert_eq!(hello(&mut watcher).await, (640, 720));
    let (got, _) = frames(&mut watcher, 3, Duration::from_secs(10)).await;
    assert!(got >= 3, "the watcher got {got} frames");
    move_to(&mut watcher, 300.0, 300.0).await;
    settle(&mut watcher, Duration::from_millis(500)).await;
    assert_eq!(
        painter.pointer(),
        (650, 20),
        "a watcher's pointer moved the display"
    );
    let (_, stats) = uplink.call("GET", "/stats").await;
    assert_eq!(
        stats["screens"].as_array().map(Vec::len),
        Some(1),
        "{stats}"
    );
    assert_eq!(stats["screens"][0]["monitor"], "TEST-RIGHT", "{stats}");
    assert_eq!(stats["screens"][0]["viewers"], 2, "{stats}");
    // What the picture runs on, one of those /info lists (asked again: the encoder probe may have finished since).
    let encoder = stats["screens"][0]["encoder"].as_str().unwrap_or_default();
    let (_, now) = uplink.call("GET", "/info").await;
    assert!(
        now["encoders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e == encoder),
        "{stats} / {now}"
    );

    // Control switched off: the driver watches.
    remoted.rewrite(&config(port, true, false));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    move_to(&mut driver, 100.0, 100.0).await;
    settle(&mut driver, Duration::from_millis(500)).await;
    assert_eq!(
        painter.pointer(),
        (650, 20),
        "input reached the display with control off"
    );

    // Viewing switched off: both sockets close.
    remoted.rewrite(&config(port, false, false));
    painting.store(false, std::sync::atomic::Ordering::Relaxed);
    paints.join().unwrap();
    assert!(
        closed(&mut driver, Duration::from_secs(10)).await,
        "the driver's socket stayed open"
    );
    assert!(
        closed(&mut watcher, Duration::from_secs(10)).await,
        "the watcher's socket stayed open"
    );
    // And the pipeline stops once its linger passed.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (_, stats) = uplink.call("GET", "/stats").await;
        if stats["screens"] == json!([]) {
            break;
        }
        assert!(Instant::now() < deadline, "the screen still runs: {stats}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    remoted.end().await;
}

/// Whether this computer can start a virtual desktop: Xvfb and a window manager remoted knows.
fn can_start_a_desktop() -> bool {
    xvfb_path().is_some()
        && [
            "startxfce4",
            "openbox-session",
            "openbox",
            "icewm",
            "fluxbox",
            "twm",
            "xfwm4",
        ]
        .iter()
        .any(|wm| {
            std::env::var("PATH")
                .unwrap_or_default()
                .split(':')
                .any(|d| std::path::Path::new(d).join(wm).exists())
        })
}

/// The virtual desktop remoted starts when there is no display: opened on the first viewer, resized to the viewer's
/// box, and still there (the same display, its windows kept) for a viewer who comes back after the screen's pipeline
/// stopped and the thread that started it went idle (tokio retires a blocking thread after 10 s; a child tied to it by
/// PR_SET_PDEATHSIG died with it).
#[tokio::test(flavor = "multi_thread")]
async fn a_virtual_desktop_outlives_its_viewers_and_follows_the_viewers_box() {
    if !can_start_a_desktop() {
        eprintln!("remoted's virtual desktop test stands down: no Xvfb or window manager here");
        return;
    }
    let (port, mut uplinks) = sandbox().await;
    let remoted = Remoted::start(
        &config(port, true, true),
        &[
            ("INTENTIC_REMOTED_SCREEN", "virtual".into()),
            ("INTENTIC_REMOTED_LINGER_MS", "300".into()),
        ],
    )
    .await;
    let uplink = tokio::time::timeout(PATIENCE, uplinks.recv())
        .await
        .unwrap()
        .unwrap();
    let (_, info) = uplink.call("GET", "/info").await;
    if info["encoders"].as_array().is_none_or(|e| e.is_empty()) {
        eprintln!("remoted's virtual desktop test stands down: this build has no H.264 encoder");
        remoted.end().await;
        return;
    }
    assert_eq!(info["screen"]["mode"], "virtual", "{info}");
    assert_eq!(info["monitors"][0]["id"], "virtual");
    let token = viewer_token("media/screen-virtual", false);
    let mut viewer = uplink.viewer("screen-virtual", &token).await.unwrap();
    assert_eq!(hello(&mut viewer).await, (1920, 1080));
    assert_eq!(frames(&mut viewer, 1, PATIENCE).await.0, 1);
    // The viewer's box (CSS pixels at its scale) becomes the desktop's size.
    viewer
        .send(&browser_wire::BrowserMediaClientMessage::Resize {
            width: 640,
            height: 400,
            scale: 2.0,
            hz: None,
        })
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(Received::Json(browser_wire::BrowserMediaServerMessage::Hello {
            width,
            height,
            ..
        })) = viewer.recv(Duration::from_millis(500)).await
            && (width, height) == (1280, 800)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the desktop did not take the viewer's box"
        );
    }
    let (_, info) = uplink.call("GET", "/info").await;
    let display = info["screen"]["running"]
        .as_str()
        .expect("a running desktop")
        .to_owned();
    viewer.close().await;

    // Long enough for the pipeline to stop and the thread that opened the desktop to be retired.
    tokio::time::sleep(Duration::from_secs(12)).await;
    let (_, stats) = uplink.call("GET", "/stats").await;
    assert_eq!(
        stats["screens"],
        json!([]),
        "the pipeline stopped after its linger: {stats}"
    );
    let (_, info) = uplink.call("GET", "/info").await;
    assert_eq!(
        info["screen"]["running"],
        display.as_str(),
        "the desktop ended with its viewers: {info}"
    );
    let mut again = uplink.viewer("screen-virtual", &token).await.unwrap();
    assert_eq!(
        hello(&mut again).await,
        (1280, 800),
        "the desktop kept its size"
    );
    assert_eq!(frames(&mut again, 1, PATIENCE).await.0, 1);
    again.close().await;
    remoted.end().await;
    // remoted ending takes the desktop with it, its lock file too.
    let lock = format!("/tmp/.X{}-lock", display.trim_start_matches(':'));
    let deadline = Instant::now() + Duration::from_secs(5);
    while std::path::Path::new(&lock).exists() {
        assert!(Instant::now() < deadline, "{lock} outlived remoted");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Where TEST-NET-3 says a fake NAT puts this computer: nothing answers there.
const OUTSIDE: std::net::Ipv4Addr = std::net::Ipv4Addr::new(203, 0, 113, 7);

/// A STUN server on loopback that answers every binding request with [`OUTSIDE`] at the asker's port, as a NAT would.
async fn fake_stun() -> std::net::SocketAddr {
    use cast_core::rtc::stun;
    let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = socket.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 1500];
        while let Ok((n, from)) = socket.recv_from(&mut buf).await {
            if let Some(id) = stun::binding_request_id(&buf[..n]) {
                let mapped = std::net::SocketAddr::new(OUTSIDE.into(), from.port());
                let _ = socket
                    .send_to(&stun::binding_success_for(id, mapped), from)
                    .await;
            }
        }
    });
    addr
}

/// The address the route out of this computer leaves from: remoted's host candidate.
fn route_out() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// A screen's peer connection: the uplink's STUN servers gathered (full ICE, the outside address in the answer beside the
/// host one), the viewer's peer opened, and the stream moved onto it.
#[tokio::test(flavor = "multi_thread")]
async fn a_screens_peer_connection_takes_the_uplinks_stun_servers_and_carries_the_stream() {
    let Some(x) = start_xvfb(640, 480) else {
        eprintln!("remoted's peer test stands down: no Xvfb (REMOTED_TEST_XVFB)");
        return;
    };
    let Some(host) = route_out() else {
        eprintln!(
            "remoted's peer test stands down: no route out of this computer for a host candidate"
        );
        return;
    };
    let stun_server = fake_stun().await;
    let (port, mut uplinks) = sandbox().await;
    let remoted = Remoted::start(
        &with_ice(
            port,
            true,
            true,
            Some(vec![
                format!("stun:{stun_server}"),
                "turn:relay.example".into(),
            ]),
        ),
        &[
            ("INTENTIC_REMOTED_SCREEN", format!("x11:{}", x.display)),
            ("INTENTIC_REMOTED_NO_RTC", String::new()),
        ],
    )
    .await;
    let uplink = tokio::time::timeout(PATIENCE, uplinks.recv())
        .await
        .unwrap()
        .unwrap();
    let (_, info) = uplink.call("GET", "/info").await;
    if info["encoders"].as_array().is_none_or(|e| e.is_empty()) {
        eprintln!("remoted's peer test stands down: this build has no H.264 encoder");
        remoted.end().await;
        return;
    }
    let monitor = info["monitors"][0]["id"].as_str().unwrap().to_owned();
    let session = format!("screen-{monitor}");
    let mut viewer = uplink
        .viewer(&session, &viewer_token(&format!("media/{session}"), false))
        .await
        .unwrap();
    let deadline = Instant::now() + PATIENCE;
    let rtc = loop {
        if let Some(Received::Json(browser_wire::BrowserMediaServerMessage::Hello {
            rtc, ..
        })) = viewer.recv(Duration::from_secs(1)).await
        {
            break rtc;
        }
        assert!(Instant::now() < deadline, "no hello");
    };
    assert_eq!(rtc, Some(true), "the hello offers a peer connection");

    let (mut peer, offer) = cast_core::rtc::viewer::RtcViewer::offer(host)
        .await
        .unwrap();
    viewer
        .send(&browser_wire::BrowserMediaClientMessage::RtcOffer { sdp: offer })
        .await
        .unwrap();
    let answer = loop {
        match viewer.recv(Duration::from_secs(1)).await {
            Some(Received::Json(browser_wire::BrowserMediaServerMessage::RtcAnswer { sdp })) => {
                break sdp;
            }
            Some(Received::Json(browser_wire::BrowserMediaServerMessage::RtcClosed { reason })) => {
                panic!("the offer was refused: {reason}")
            }
            Some(Received::Media { header, .. }) if header.kind == KIND_VIDEO => {
                ack(&mut viewer, header.id).await
            }
            _ => {}
        }
        assert!(Instant::now() < deadline, "no rtcAnswer");
    };
    assert!(!answer.contains("a=ice-lite"), "a full agent: {answer}");
    assert!(
        answer.contains(&format!("{host} ")) && answer.contains("typ host"),
        "the host candidate: {answer}"
    );
    assert!(
        answer.contains(&format!("{OUTSIDE} ")) && answer.contains("typ srflx"),
        "the STUN server's word: {answer}"
    );
    peer.answer(&answer).unwrap();

    // The peer opens and the stream moves onto it: a hello on `media`, then pictures while the screen changes.
    let painter = Painter::new(&x.display);
    let mut said_hello = false;
    let mut pictures = 0;
    let mut i = 0u32;
    let deadline = Instant::now() + Duration::from_secs(20);
    while pictures < 3 {
        assert!(
            Instant::now() < deadline,
            "the stream did not cross the peer (hello {said_hello}, {pictures} pictures)"
        );
        painter.fill(10 + (i % 300) as i16, 10, 50, 50, 0x0040_80c0 + i);
        i += 1;
        // The socket keeps reading, as a browser's does, for pings and anything the peer does not carry.
        let _ = viewer.recv(Duration::from_millis(1)).await;
        match peer.recv(Duration::from_millis(50)).await {
            Some(cast_core::rtc::viewer::Arrived::Text(text)) => {
                said_hello |= text.contains("\"hello\"")
            }
            Some(cast_core::rtc::viewer::Arrived::Media(bytes, _)) if said_hello => {
                if let Some(header) = cast_core::header::Header::read(&bytes)
                    && header.kind == KIND_VIDEO
                {
                    pictures += 1;
                    peer.send(&json!({ "type": "ack", "id": header.id }).to_string());
                }
            }
            _ => {}
        }
    }
    assert!(
        peer.checks_heard > 0,
        "remoted sent no checks of its own: not full ICE"
    );
    remoted.end().await;
}

/// Percentile of sorted samples.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

/// `REMOTED_MEASURE_SCREEN=wayland cargo test --test screen -- --ignored --nocapture wayland_input`: on a Wayland
/// session (its bus in `DBUS_SESSION_BUS_ADDRESS`, its Xwayland at `REMOTED_MEASURE_DISPLAY` with `XAUTHORITY`), a
/// viewer's pointer moves the session's own (its position comes back from the cast's cursor metadata), and a click and
/// keys typed by their physical code reach an X window there.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn wayland_input() {
    let display =
        std::env::var("REMOTED_MEASURE_DISPLAY").expect("REMOTED_MEASURE_DISPLAY names Xwayland");
    let (port, mut uplinks) = sandbox().await;
    let remoted = Remoted::start(
        &config(port, true, true),
        &[("INTENTIC_REMOTED_SCREEN", "wayland".into())],
    )
    .await;
    let uplink = tokio::time::timeout(PATIENCE, uplinks.recv())
        .await
        .unwrap()
        .unwrap();
    let token = viewer_token("media/screen-wayland", false);
    let (mut viewer, size) = patient_viewer(&uplink, "screen-wayland", &token).await;
    println!("opened at {}x{}", size.0, size.1);

    // A window of the person's: where mutter put it, and the events it wants.
    let (conn, n) = cast_x11::connect::connect(Some(&display)).expect("Xwayland connects");
    let root = conn.setup().roots[n].root;
    let window = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        window,
        root,
        0,
        0,
        600,
        400,
        0,
        xproto::WindowClass::INPUT_OUTPUT,
        x11rb::COPY_FROM_PARENT,
        &xproto::CreateWindowAux::new()
            .background_pixel(0x00c0_c0c0)
            .event_mask(
                xproto::EventMask::KEY_PRESS
                    | xproto::EventMask::BUTTON_PRESS
                    | xproto::EventMask::POINTER_MOTION,
            ),
    )
    .unwrap();
    conn.map_window(window).unwrap();
    conn.flush().unwrap();
    settle(&mut viewer, Duration::from_millis(1500)).await;
    let at = conn
        .translate_coordinates(window, root, 0, 0)
        .unwrap()
        .reply()
        .unwrap();
    let (cx, cy) = (f64::from(at.dst_x) + 300.0, f64::from(at.dst_y) + 200.0);
    println!("the window is at {},{}", at.dst_x, at.dst_y);

    // The pointer: moved there (from somewhere else, so it moves), and seen there in the cursor metadata.
    move_to(&mut viewer, cx - 120.0, cy - 60.0).await;
    settle(&mut viewer, Duration::from_millis(300)).await;
    move_to(&mut viewer, cx, cy).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen = None;
    while Instant::now() < deadline {
        match viewer.recv(Duration::from_millis(200)).await {
            Some(Received::Json(browser_wire::BrowserMediaServerMessage::Pointer { x, y })) => {
                seen = Some((x, y));
                if (f64::from(x) - cx).abs() < 2.0 && (f64::from(y) - cy).abs() < 2.0 {
                    break;
                }
            }
            Some(Received::Media { header, .. }) if header.kind == KIND_VIDEO => {
                ack(&mut viewer, header.id).await
            }
            _ => {}
        }
    }
    println!("the session's pointer is at {seen:?}, sent to {cx},{cy}");
    assert!(
        seen.is_some_and(
            |(x, y)| (f64::from(x) - cx).abs() < 2.0 && (f64::from(y) - cy).abs() < 2.0
        ),
        "the pointer did not arrive: {seen:?}"
    );

    // A click focuses the window; keys by their physical code land in it.
    for action in [
        browser_wire::PointerAction::Down,
        browser_wire::PointerAction::Up,
    ] {
        viewer
            .send(&browser_wire::BrowserMediaClientMessage::Mouse {
                action,
                x: cx,
                y: cy,
                button: Some(0),
                buttons: None,
                click_count: None,
                ctrl: None,
                shift: None,
                alt: None,
            })
            .await
            .unwrap();
    }
    // The window has the keyboard once Xwayland says so (the compositor focuses it on the click).
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        settle(&mut viewer, Duration::from_millis(100)).await;
        let focus = conn.get_input_focus().unwrap().reply().unwrap().focus;
        if focus == window || Instant::now() > deadline {
            println!(
                "focus is {}the window",
                if focus == window { "" } else { "not " }
            );
            break;
        }
    }
    for (key, code) in [("a", "KeyA"), ("1", "Digit1"), ("Enter", "Enter")] {
        for action in [browser_wire::KeyAction::Down, browser_wire::KeyAction::Up] {
            // As a person types: some milliseconds between a key's press and its release.
            settle(&mut viewer, Duration::from_millis(40)).await;
            viewer
                .send(&browser_wire::BrowserMediaClientMessage::Key {
                    key: key.into(),
                    code: Some(code.into()),
                    action: Some(action),
                    ctrl: None,
                    shift: None,
                    alt: None,
                })
                .await
                .unwrap();
        }
    }
    settle(&mut viewer, Duration::from_millis(1000)).await;
    let (mut buttons, mut keys, mut motions) = (Vec::new(), Vec::new(), 0);
    while let Ok(Some(event)) = conn.poll_for_event() {
        match event {
            x11rb::protocol::Event::ButtonPress(e) => buttons.push(e.detail),
            x11rb::protocol::Event::KeyPress(e) => keys.push(e.detail),
            x11rb::protocol::Event::MotionNotify(_) => motions += 1,
            _ => {}
        }
    }
    println!("the window saw {motions} motions, buttons {buttons:?}, keys {keys:?}");
    assert_eq!(buttons, vec![1], "the click");
    // evdev + 8: KEY_A 30, KEY_1 2, KEY_ENTER 28.
    assert_eq!(keys, vec![38, 10, 36], "the keys");
    viewer.close().await;
    remoted.end().await;
}

/// A viewer of a screen that may not open at once (a Wayland session's portal asking the person at it): opened again
/// every two seconds until its hello comes, for up to five minutes.
async fn patient_viewer(
    uplink: &Uplink,
    session: &str,
    token: &str,
) -> (MediaClient<Stream>, (u32, u32)) {
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        let attempt = async {
            let mut viewer = uplink.viewer(session, token).await.ok()?;
            let tried = Instant::now();
            while tried.elapsed() < Duration::from_secs(10) {
                match viewer.recv(Duration::from_secs(1)).await {
                    Some(Received::Json(browser_wire::BrowserMediaServerMessage::Hello {
                        width,
                        height,
                        ..
                    })) => {
                        return Some((viewer, (width, height)));
                    }
                    Some(_) => {}
                    None => return None,
                }
            }
            None
        };
        if let Ok(Some(opened)) = tokio::time::timeout(Duration::from_secs(15), attempt).await {
            return opened;
        }
        if let Ok((_, info)) =
            tokio::time::timeout(Duration::from_secs(5), uplink.call("GET", "/info")).await
        {
            println!("not open yet: {}", info["screen"]);
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    panic!("the screen did not open within five minutes");
}

/// CPU seconds a process (and its threads) used so far.
fn cpu_seconds(pid: u32) -> f64 {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    let fields: Vec<&str> = stat
        .rsplit_once(')')
        .map(|(_, rest)| rest)
        .unwrap_or("")
        .split_whitespace()
        .collect();
    let ticks = |i: usize| {
        fields
            .get(i)
            .and_then(|f| f.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    (ticks(11) + ticks(12)) / hz
}

/// The virtual desktop remoted started: its display and cookie file, from the runtime directory it writes them to.
fn virtual_display() -> Option<(String, PathBuf)> {
    let uid = unsafe { libc::geteuid() };
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(|d| PathBuf::from(d).join("intentic-remoted"))
        .unwrap_or_else(|| PathBuf::from(format!("/tmp/intentic-remoted-{uid}")));
    let entry = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().starts_with("Xauthority-"))?;
    let number = entry
        .file_name()
        .to_string_lossy()
        .trim_start_matches("Xauthority-")
        .to_owned();
    Some((format!(":{number}"), entry.path()))
}

/// `cargo test --test screen -- --ignored --nocapture measure`: a virtual desktop at 1920x1080, a 400x300 box moving
/// across it at 60 Hz (a window dragged), then the whole screen repainted at 30 Hz, each for `REMOTED_MEASURE_SECONDS`
/// (default 10), one viewer acking every frame. `REMOTED_MEASURE_DISPLAY=:0` measures an X display that is already
/// there instead (its first monitor), as a person's session is served; `REMOTED_MEASURE_SCREEN=wayland` measures the
/// Wayland session on the session bus in `DBUS_SESSION_BUS_ADDRESS` through the desktop portal (painted through
/// Xwayland at `REMOTED_MEASURE_DISPLAY`), opening the screen again until the person at it allows it.
/// `REMOTED_MEASURE_SIZE=2560x1440` paints that much of the screen instead of 1920x1080.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn measure() {
    let seconds: u64 = std::env::var("REMOTED_MEASURE_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);
    let (port, mut uplinks) = sandbox().await;
    let started = Instant::now();
    let existing = std::env::var("REMOTED_MEASURE_DISPLAY").ok();
    let wayland = std::env::var("REMOTED_MEASURE_SCREEN").is_ok_and(|s| s == "wayland");
    let (paint_w, paint_h): (u16, u16) = std::env::var("REMOTED_MEASURE_SIZE")
        .ok()
        .and_then(|s| {
            let (w, h) = s.split_once('x')?;
            Some((w.parse().ok()?, h.parse().ok()?))
        })
        .unwrap_or((1920, 1080));
    let screen = match &existing {
        _ if wayland => "wayland".into(),
        Some(display) => format!("x11:{display}"),
        None => "virtual".into(),
    };
    let remoted = Remoted::start(
        &config(port, true, true),
        &[("INTENTIC_REMOTED_SCREEN", screen)],
    )
    .await;
    let pid = remoted.child.id().unwrap();
    let uplink = tokio::time::timeout(PATIENCE, uplinks.recv())
        .await
        .unwrap()
        .unwrap();
    let (_, info) = uplink.call("GET", "/info").await;
    println!("info: {info}");
    let monitor = info["monitors"][0]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("no screen here: {}", info["screen"]))
        .to_owned();
    if existing.is_none() {
        assert_eq!(
            monitor, "virtual",
            "no virtual desktop here: {}",
            info["screen"]
        );
    }
    let opened = Instant::now();
    let session = format!("screen-{monitor}");
    let token = viewer_token(&format!("media/{session}"), false);
    let (mut viewer, size) = if wayland {
        patient_viewer(&uplink, &session, &token).await
    } else {
        let mut viewer = uplink.viewer(&session, &token).await.unwrap();
        let size = hello(&mut viewer).await;
        (viewer, size)
    };
    let (got, _) = frames(&mut viewer, 1, PATIENCE).await;
    assert_eq!(got, 1);
    println!(
        "uplink up and /info {:?} after start; first frame {:.0} ms after the socket opened (the desktop started), {}x{}",
        opened - started,
        opened.elapsed().as_secs_f64() * 1000.0,
        size.0,
        size.1
    );
    let display = match existing {
        Some(display) => display,
        None => {
            let (display, authority) = virtual_display().expect("the virtual desktop's cookie");
            cast_x11::connect::set_authority(Some(authority));
            display
        }
    };
    let xvfb_pid: Option<u32> =
        std::fs::read_to_string(format!("/tmp/.X{}-lock", display.trim_start_matches(':')))
            .ok()
            .and_then(|s| s.trim().parse().ok());
    let mut lines = Vec::new();
    for (name, hz, whole) in [
        ("box 400x300 moving at 60 Hz", 60u64, false),
        ("whole screen repainted at 30 Hz", 30, true),
    ] {
        settle(&mut viewer, Duration::from_millis(800)).await;
        let painting = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let paints = {
            let painting = painting.clone();
            let display = display.clone();
            std::thread::spawn(move || {
                let painter = Painter::window(&display, paint_w, paint_h);
                let mut i = 0u32;
                let every = Duration::from_micros(1_000_000 / hz);
                let mut next = Instant::now();
                while painting.load(std::sync::atomic::Ordering::Relaxed) {
                    if whole {
                        // Bands of changing colour: the encoder sees new content everywhere, every frame.
                        let band_h = u32::from(paint_h).div_ceil(12);
                        for band in 0..12u32 {
                            let rgb = ((i * 37 + band * 91) & 0xff) << 16
                                | ((i * 11 + band * 7) & 0xff) << 8
                                | (band * 20);
                            painter.fill(0, (band * band_h) as i16, paint_w, band_h as u16, rgb);
                        }
                    } else {
                        let x = (i * 8 % (u32::from(paint_w) - 520)) as i16;
                        painter.fill(x.saturating_sub(8), 300, 8, 300, 0x203040);
                        painter.fill(x, 300, 400, 300, 0x00c0_6020 ^ (i & 0xff));
                    }
                    i += 1;
                    next += every;
                    if let Some(wait) = next.checked_duration_since(Instant::now()) {
                        std::thread::sleep(wait);
                    }
                }
            })
        };
        settle(&mut viewer, Duration::from_millis(500)).await;
        let cpu0 = cpu_seconds(pid);
        let xcpu0 = xvfb_pid.map(cpu_seconds).unwrap_or(0.0);
        let window = Instant::now();
        let mut latencies = Vec::new();
        let mut bytes = 0usize;
        let mut count = 0usize;
        while window.elapsed() < Duration::from_secs(seconds) {
            if let Some(Received::Media {
                header, len, at, ..
            }) = viewer.recv(Duration::from_millis(200)).await
                && header.kind == KIND_VIDEO
            {
                count += 1;
                bytes += len;
                if let Some(ms) = viewer.latency_ms(&header, at) {
                    latencies.push(ms);
                }
                ack(&mut viewer, header.id).await;
            }
        }
        let elapsed = window.elapsed().as_secs_f64();
        let cpu = (cpu_seconds(pid) - cpu0) / elapsed * 100.0;
        let xcpu = xvfb_pid.map(|p| (cpu_seconds(p) - xcpu0) / elapsed * 100.0);
        painting.store(false, std::sync::atomic::Ordering::Relaxed);
        paints.join().unwrap();
        latencies.sort_by(f64::total_cmp);
        let line = format!(
            "{name}: {:.1} fps, {:.0} kbps, capture to arrival p50 {:.0} ms / p95 {:.0} ms, remoted CPU {:.0}% of a core{}",
            count as f64 / elapsed,
            bytes as f64 * 8.0 / elapsed / 1000.0,
            percentile(&latencies, 0.5),
            percentile(&latencies, 0.95),
            cpu,
            xcpu.map(|c| format!(", Xvfb {c:.0}%")).unwrap_or_default()
        );
        println!("{line}");
        lines.push(line);
    }
    let (_, stats) = uplink.call("GET", "/stats").await;
    println!("stats: {stats}");
    viewer.close().await;
    remoted.end().await;
}
