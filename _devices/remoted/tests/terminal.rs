//! remoted end to end, the built binary against a fake sandbox: a WebSocket server that takes the uplink as netd does
//! (its token and device header checked) and opens yamux streams down it (the tunnel crate's client), each one HTTP/1.1
//! connection. Everything a person's terminal goes through is real: the shell on a pseudo-terminal (ConPTY on Windows),
//! the screen, the viewer sockets, the tokens. Run on Linux here and natively on Windows.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use remoted::token::{self, Claims};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tunnel::mux::{Opener, Stream};
use tunnel::{Close, Liveness};

// Hang bounds, far above what any step takes (a cold pwsh starts in a few seconds).
const PATIENCE: Duration = Duration::from_secs(60);

const KEY: [u8; 32] = [7; 32];
const TOKEN: &str = "uplink-token";
const DEVICE: &str = "test-device";

fn media_key() -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(KEY)
}

fn viewer_token(session: &str, ro: bool, exp_in_ms: i64) -> String {
    let now = token::now_ms();
    token::sign(
        &KEY,
        &Claims {
            s: format!("terminal/{session}"),
            exp: (now as i64 + exp_in_ms) as u64,
            ro,
            iat: now,
        },
    )
}

/// How the fake sandbox answers the next uplink dial.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Answer {
    Accept,
    Unauthorized,
}

/// The fake sandbox: it takes uplinks and hands each one's stream opener to the test.
struct Sandbox {
    port: u16,
    uplinks: Mutex<mpsc::UnboundedReceiver<Uplink>>,
    answer: watch::Sender<Answer>,
    dials: Arc<std::sync::atomic::AtomicUsize>,
}

struct Uplink {
    opener: Opener,
    closing: watch::Sender<Option<Close>>,
    _pumping: tunnel::Pumping,
}

impl Uplink {
    async fn stream(&self) -> Stream {
        self.opener
            .open()
            .await
            .expect("a stream opens down the uplink")
    }

    /// One control call, as Node makes them through netd.
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(self.stream().await))
                .await
                .expect("an HTTP/1.1 connection opens on a stream");
        tokio::spawn(connection);
        let request = hyper::Request::builder()
            .method(method)
            .uri(path)
            .header("host", "remoted")
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(
                body.map(|body| body.to_string()).unwrap_or_default(),
            )))
            .unwrap();
        let response = sender.send_request(request).await.expect("remoted answers");
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// A viewer's socket, or the status remoted refused its upgrade with.
    async fn viewer(&self, session: &str, query: &str) -> Result<Viewer, u16> {
        let url = format!("ws://remoted/terminal/{session}?{query}");
        match tokio_tungstenite::client_async(url, self.stream().await).await {
            Ok((socket, _)) => Ok(Viewer::new(socket)),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                Err(response.status().as_u16())
            }
            Err(error) => panic!("the viewer's upgrade failed: {error}"),
        }
    }
}

impl Sandbox {
    async fn start() -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (taken, uplinks) = mpsc::unbounded_channel();
        let (answer, answering) = watch::channel(Answer::Accept);
        let dials = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = dials.clone();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let answer = *answering.borrow();
                let taken = taken.clone();
                let counted = counted.clone();
                tokio::spawn(async move {
                    if let Some(uplink) = take(tcp, answer, counted).await {
                        let _ = taken.send(uplink);
                    }
                });
            }
        });
        Arc::new(Self {
            port,
            uplinks: Mutex::new(uplinks),
            answer,
            dials,
        })
    }

    async fn next_uplink(&self) -> Uplink {
        tokio::time::timeout(PATIENCE, self.uplinks.lock().await.recv())
            .await
            .expect("remoted dialled the uplink in time")
            .unwrap()
    }
}

#[allow(clippy::result_large_err)] // tungstenite's own callback type
// What netd does with an uplink's upgrade: the path, the token and the device checked, then yamux as the opener.
// Only an uplink's upgrade is counted as a dial: whatever else connects to the port (this sandbox's own port watcher
// probes every new listener) is not remoted.
async fn take(
    tcp: TcpStream,
    answer: Answer,
    dials: Arc<std::sync::atomic::AtomicUsize>,
) -> Option<Uplink> {
    let check = move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let refuse = |status: http::StatusCode| {
            let mut refused = ErrorResponse::new(Some("refused".into()));
            *refused.status_mut() = status;
            refused
        };
        if request.uri().path() != "/system/device-uplink" {
            return Err(refuse(http::StatusCode::NOT_FOUND));
        }
        dials.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(request.headers()["x-intentic-device"], DEVICE);
        let authorized = request.headers()["authorization"] == format!("Bearer {TOKEN}").as_str();
        if answer == Answer::Unauthorized || !authorized {
            let mut refused = ErrorResponse::new(Some("unknown uplink token".into()));
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
        closing,
        _pumping: pumping,
    })
}

/// A viewer's socket and the screen it would draw.
struct Viewer {
    socket: WebSocketStream<Stream>,
    screen: vt100::Parser,
    grids: Vec<(u16, u16)>,
    exit: Option<Value>,
    inflate: Option<flate2::Decompress>,
}

impl Viewer {
    fn new(socket: WebSocketStream<Stream>) -> Self {
        Self {
            socket,
            screen: vt100::Parser::new(24, 80, 1000),
            grids: Vec::new(),
            exit: None,
            inflate: None,
        }
    }

    async fn send(&mut self, message: Value) {
        self.socket
            .send(Message::text(message.to_string()))
            .await
            .unwrap();
    }

    async fn type_line(&mut self, line: &str) {
        self.send(json!({ "type": "input", "data": format!("{line}\r") }))
            .await;
    }

    // One message in, drawn: false once the socket ended.
    async fn read_one(&mut self) -> bool {
        match self.socket.next().await {
            Some(Ok(Message::Binary(bytes))) => {
                let bytes = match self.inflate.as_mut() {
                    Some(stream) => {
                        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
                        let mut out = Vec::with_capacity(length);
                        stream
                            .decompress_vec(&bytes[4..], &mut out, flate2::FlushDecompress::Sync)
                            .unwrap();
                        assert_eq!(out.len(), length);
                        out
                    }
                    None => bytes.to_vec(),
                };
                self.screen.process(&bytes);
                true
            }
            Some(Ok(Message::Text(text))) => {
                let message: Value = serde_json::from_str(&text).unwrap();
                match message["type"].as_str() {
                    Some("grid") => {
                        let cols = message["cols"].as_u64().unwrap() as u16;
                        let rows = message["rows"].as_u64().unwrap() as u16;
                        self.grids.push((cols, rows));
                        self.screen.screen_mut().set_size(rows, cols);
                    }
                    Some("deflate") => self.inflate = Some(flate2::Decompress::new(false)),
                    Some("exit") => self.exit = Some(message),
                    _ => {}
                }
                true
            }
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => false,
            Some(Ok(_)) => true,
        }
    }

    fn rows(&self) -> Vec<String> {
        self.screen
            .screen()
            .contents()
            .lines()
            .map(|row| row.trim_end().to_owned())
            .collect()
    }

    /// Reads until `done` holds for what this viewer was drawn.
    async fn until(&mut self, what: &str, done: impl Fn(&Self) -> bool) {
        let reading = async {
            while !done(self) {
                assert!(
                    self.read_one().await,
                    "the socket ended while waiting for {what}"
                );
            }
        };
        if tokio::time::timeout(PATIENCE, reading).await.is_err() {
            panic!(
                "no {what} within {PATIENCE:?}; the screen:\n{}",
                self.rows().join("\n")
            );
        }
    }

    /// Types a command whose output differs from the command line (an addition the shell does), and waits for that
    /// output: proof the shell is at its prompt and reading, whatever it printed before.
    async fn until_ready(&mut self, marker: &str) {
        let (command, output) = computed(marker);
        self.type_line(&command).await;
        let wanted = output.clone();
        self.until(&format!("{output:?} printed"), move |viewer| {
            viewer.rows().iter().any(|row| row.contains(&wanted))
        })
        .await;
    }

    async fn until_row(&mut self, row: &str) {
        let wanted = row.to_owned();
        self.until(&format!("a row {row:?}"), move |viewer| {
            viewer.rows().contains(&wanted)
        })
        .await;
    }

    /// Reads what arrives for `quiet`.
    async fn drain(&mut self, quiet: Duration) {
        while let Ok(true) = tokio::time::timeout(quiet, self.read_one()).await {}
    }
}

/// remoted, running with a config file of its own.
struct Remoted {
    child: Child,
    statuses: mpsc::UnboundedReceiver<Value>,
    config: PathBuf,
    _dir: TempDir,
}

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// As the agent writes it: the file holds the uplink's secrets.
fn owner_only(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn config(port: u16, generation: u64, terminal: bool) -> Value {
    json!({
        "uplinks": [{
            "id": "link-1",
            "url": format!("http://127.0.0.1:{port}"),
            "device": DEVICE,
            "uplinkToken": TOKEN,
            "mediaKey": media_key(),
            "allow": { "view": false, "control": false, "terminal": terminal },
            "generation": generation,
        }]
    })
}

impl Remoted {
    async fn start(first: &Value) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "remoted-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("remoted.json");
        std::fs::write(&config, first.to_string()).unwrap();
        owner_only(&config);
        let mut child = Command::new(binary())
            .args(["run", "--config"])
            .arg(&config)
            .arg("--parent-stdin")
            .env("RUST_LOG", "remoted=debug,info")
            // A plain prompt on Linux, whatever the login shell of whoever runs the suite.
            .env("SHELL", "/bin/sh")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("remoted starts");
        let stdout = child.stdout.take().unwrap();
        let (said, statuses) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(status) = serde_json::from_str::<Value>(&line) {
                    let _ = said.send(status);
                }
            }
        });
        Self {
            child,
            statuses,
            config,
            _dir: TempDir(dir),
        }
    }

    fn rewrite(&self, config: &Value) {
        let staged = self.config.with_extension("tmp");
        std::fs::write(&staged, config.to_string()).unwrap();
        owner_only(&staged);
        std::fs::rename(&staged, &self.config).unwrap();
    }

    /// Waits for a status line `holds` is true of, and answers it.
    async fn until(&mut self, what: &str, holds: impl Fn(&Value) -> bool) -> Value {
        let waiting = async {
            loop {
                let status = self
                    .statuses
                    .recv()
                    .await
                    .expect("remoted is still running");
                if holds(&status) {
                    return status;
                }
            }
        };
        tokio::time::timeout(PATIENCE, waiting)
            .await
            .unwrap_or_else(|_| panic!("remoted's status never said {what}"))
    }

    async fn until_uplink(&mut self, state: &str) -> Value {
        let wanted = state.to_owned();
        self.until(&format!("the uplink {state}"), move |status| {
            status["uplinks"][0]["state"] == wanted.as_str()
        })
        .await
    }
}

// The binary cargo built for this suite: named by cargo where it says, else found up from where the suite runs
// (`target/<profile>/deps/`, or a build directory under `target/<profile>/build/` on a newer cargo).
fn binary() -> PathBuf {
    let name = format!("intentic-remoted{}", std::env::consts::EXE_SUFFIX);
    if let Some(path) = option_env!("CARGO_BIN_EXE_intentic-remoted")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CARGO_BIN_EXE_intentic-remoted").map(PathBuf::from))
    {
        return path;
    }
    let suite = std::env::current_exe().expect("the suite knows where it runs");
    suite
        .ancestors()
        .map(|dir| dir.join(&name))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("no {name} above {}", suite.display()))
}

// A command printing `<marker>-42`, which its own command line does not contain.
fn computed(marker: &str) -> (String, String) {
    let command = if cfg!(windows) {
        format!("echo \"{marker}-$(40+2)\"")
    } else {
        format!("echo \"{marker}-$((40+2))\"")
    };
    (command, format!("{marker}-42"))
}

// A command that prints the terminal's width, in the shell this platform's terminal opens.
fn width_command() -> &'static str {
    if cfg!(windows) {
        "[Console]::WindowWidth"
    } else {
        "stty size | cut -d' ' -f2"
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_is_created_attached_typed_in_resized_shared_and_refused() {
    let sandbox = Sandbox::start().await;
    let mut remoted = Remoted::start(&config(sandbox.port, 1, true)).await;
    let uplink = sandbox.next_uplink().await;
    remoted.until_uplink("up").await;

    let (status, health) = uplink.call("GET", "/health", None).await;
    assert_eq!(status, 200);
    assert_eq!(health["ok"], true);
    let (status, info) = uplink.call("GET", "/info", None).await;
    assert_eq!(status, 200);
    assert_eq!(
        info["allow"],
        json!({ "view": false, "control": false, "terminal": true })
    );
    assert_eq!(info["environments"][0], "native");
    assert_eq!(info["monitors"], json!([]));

    let (status, created) = uplink
        .call(
            "POST",
            "/terminals",
            Some(json!({ "session": "t-1", "cols": 80, "rows": 24 })),
        )
        .await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["session"], "t-1");
    assert_eq!(created["environment"], "native");
    let (status, _) = uplink
        .call("POST", "/terminals", Some(json!({ "session": "t-1" })))
        .await;
    assert_eq!(status, 409);
    let (status, _) = uplink
        .call("POST", "/terminals", Some(json!({ "session": "../x" })))
        .await;
    assert_eq!(status, 400);
    let (_, listed) = uplink.call("GET", "/terminals", None).await;
    assert_eq!(listed[0]["session"], "t-1");

    // A typist, at 100x30.
    let mut typist = uplink
        .viewer(
            "t-1",
            &format!(
                "token={}&cols=100&rows=30",
                viewer_token("t-1", false, 60_000)
            ),
        )
        .await
        .expect("the typist's token opens the terminal");
    typist
        .until("the grid", |viewer| viewer.grids.contains(&(100, 30)))
        .await;
    remoted
        .until("the typist counted", |status| {
            status["people"][0]["kind"] == "terminal"
        })
        .await;
    typist.until_ready("ready").await;
    typist.type_line("echo hi").await;
    typist.until_row("hi").await;

    // Resized: the grid follows, and so does the program's own terminal.
    typist
        .send(json!({ "type": "resize", "cols": 90, "rows": 20 }))
        .await;
    typist
        .until("the new grid", |viewer| {
            viewer.grids.last() == Some(&(90, 20))
        })
        .await;
    typist.type_line(width_command()).await;
    typist.until_row("90").await;

    // A second viewer, larger, asking for deflate: the grid stays the smaller, and it is drawn what is there.
    let mut second = uplink
        .viewer(
            "t-1",
            &format!(
                "token={}&cols=120&rows=40&deflate=1",
                viewer_token("t-1", false, 60_000)
            ),
        )
        .await
        .expect("a second viewer opens the terminal");
    second
        .until("the shared grid", |viewer| viewer.grids.contains(&(90, 20)))
        .await;
    second.until_row("hi").await;
    assert!(
        second.inflate.is_some(),
        "the deflated socket never said deflate"
    );

    // A watcher: what it types never arrives.
    let mut watcher = uplink
        .viewer(
            "t-1",
            &format!(
                "token={}&cols=40&rows=10",
                viewer_token("t-1", true, 60_000)
            ),
        )
        .await
        .expect("a read-only token opens the terminal");
    watcher.until_row("hi").await;
    watcher.type_line("echo watcher-typed").await;
    watcher
        .send(json!({ "type": "resize", "cols": 30, "rows": 8 }))
        .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    typist.type_line("echo after").await;
    typist.until_row("after").await;
    assert!(
        !typist
            .rows()
            .iter()
            .any(|row| row.contains("watcher-typed")),
        "{:?}",
        typist.rows()
    );
    // The watcher bounds nothing: the grid is still the typists'.
    assert_eq!(typist.grids.last(), Some(&(90, 20)));

    // Refused: no token, a bad one, an expired one, one for another terminal.
    assert_eq!(uplink.viewer("t-1", "cols=80").await.err(), Some(401));
    assert_eq!(uplink.viewer("t-1", "token=nope").await.err(), Some(403));
    let expired = viewer_token("t-1", false, -1000);
    assert_eq!(
        uplink
            .viewer("t-1", &format!("token={expired}"))
            .await
            .err(),
        Some(403)
    );
    let other = viewer_token("t-2", false, 60_000);
    assert_eq!(
        uplink.viewer("t-1", &format!("token={other}")).await.err(),
        Some(403)
    );

    // A drop of the typists closes them with 4001 and refuses tokens minted before it; the watcher stays.
    let before_the_drop = viewer_token("t-1", false, 60_000);
    tokio::time::sleep(Duration::from_millis(5)).await;
    let (status, dropped) = uplink
        .call("POST", "/viewers/drop?read_write=1", None)
        .await;
    assert_eq!(status, 200);
    assert_eq!(dropped["dropped"], 2);
    typist.drain(Duration::from_millis(500)).await;
    assert_eq!(
        uplink
            .viewer("t-1", &format!("token={before_the_drop}"))
            .await
            .err(),
        Some(403)
    );
    tokio::time::sleep(Duration::from_millis(5)).await;
    let mut again = uplink
        .viewer(
            "t-1",
            &format!("token={}", viewer_token("t-1", false, 60_000)),
        )
        .await
        .expect("a token minted after the drop opens the terminal");
    again.until_row("after").await;

    // Ended from the sandbox: every viewer is told, and it is gone from the list.
    let (status, _) = uplink.call("DELETE", "/terminals/t-1", None).await;
    assert_eq!(status, 200);
    again
        .until("the exit", |viewer| viewer.exit.is_some())
        .await;
    watcher
        .until("the exit", |viewer| viewer.exit.is_some())
        .await;
    let (_, listed) = uplink.call("GET", "/terminals", None).await;
    assert_eq!(listed, json!([]));
    let (status, _) = uplink.call("DELETE", "/terminals/t-1", None).await;
    assert_eq!(status, 404);
    remoted
        .until("no terminals", |status| status["terminals"] == 0)
        .await;
    drop(remoted.child.stdin.take());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_outlives_its_uplink_dropping_and_a_refused_or_withdrawn_uplink_waits() {
    let sandbox = Sandbox::start().await;
    let mut remoted = Remoted::start(&config(sandbox.port, 1, true)).await;
    let uplink = sandbox.next_uplink().await;
    remoted.until_uplink("up").await;
    let (status, _) = uplink
        .call("POST", "/terminals", Some(json!({ "session": "t-keep" })))
        .await;
    assert_eq!(status, 201);
    let mut viewer = uplink
        .viewer(
            "t-keep",
            &format!("token={}", viewer_token("t-keep", false, 60_000)),
        )
        .await
        .unwrap();
    viewer.until_ready("before-the-drop").await;

    // The sandbox restarts: the uplink drops, remoted dials again, and the terminal is still there with its screen.
    drop(uplink);
    drop(viewer);
    remoted.until_uplink("down").await;
    let uplink = sandbox.next_uplink().await;
    remoted.until_uplink("up").await;
    let (_, listed) = uplink.call("GET", "/terminals", None).await;
    assert_eq!(listed[0]["session"], "t-keep");
    let mut viewer = uplink
        .viewer(
            "t-keep",
            &format!("token={}", viewer_token("t-keep", false, 60_000)),
        )
        .await
        .unwrap();
    viewer
        .until("the screen from before the drop", |viewer| {
            viewer
                .rows()
                .iter()
                .any(|row| row.contains("before-the-drop-42"))
        })
        .await;

    // Withdrawn by the sandbox: no more dials until the agent starts it again.
    let _ = uplink.closing.send(Some(Close {
        code: 4003,
        reason: "withdrawn".into(),
    }));
    remoted.until_uplink("withdrawn").await;
    let dials = sandbox.dials.load(std::sync::atomic::Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        sandbox.dials.load(std::sync::atomic::Ordering::SeqCst),
        dials
    );

    // Started again, with a token the sandbox no longer knows: refused, and said so.
    sandbox.answer.send_replace(Answer::Unauthorized);
    remoted.rewrite(&config(sandbox.port, 2, true));
    remoted.until_uplink("refused").await;

    // Known again, and the terminal switch turned off on the way: the terminal ends, the uplink stays.
    sandbox.answer.send_replace(Answer::Accept);
    remoted.rewrite(&config(sandbox.port, 3, false));
    let uplink = sandbox.next_uplink().await;
    remoted
        .until("up at the generation the agent wrote", |status| {
            status["uplinks"][0]["state"] == "up" && status["uplinks"][0]["generation"] == 3
        })
        .await;
    remoted
        .until("the terminal ended", |status| status["terminals"] == 0)
        .await;
    let (status, _) = uplink
        .call("POST", "/terminals", Some(json!({ "session": "t-no" })))
        .await;
    assert_eq!(status, 403);
    drop(remoted.child.stdin.take());
    let ended = tokio::time::timeout(PATIENCE, remoted.child.wait()).await;
    assert!(ended.is_ok(), "remoted outlived its stdin");
}

// Numbers for the README, not a pass/fail: `cargo test --test terminal -- --ignored --nocapture measure`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "a measurement, run by hand"]
async fn measure() {
    use std::time::Instant;
    let sandbox = Sandbox::start().await;
    let started = Instant::now();
    let mut remoted = Remoted::start(&config(sandbox.port, 1, true)).await;
    let uplink = sandbox.next_uplink().await;
    remoted.until_uplink("up").await;
    let uplink_up = started.elapsed();

    let created = Instant::now();
    let (status, _) = uplink
        .call(
            "POST",
            "/terminals",
            Some(json!({ "session": "t-m", "cols": 120, "rows": 40 })),
        )
        .await;
    assert_eq!(status, 201);
    let create_answered = created.elapsed();
    let mut viewer = uplink
        .viewer(
            "t-m",
            &format!(
                "token={}&cols=120&rows=40&deflate=1",
                viewer_token("t-m", false, 600_000)
            ),
        )
        .await
        .unwrap();
    viewer.until_ready("ready").await;
    let shell_ready = created.elapsed();

    // One keystroke at the prompt to its echo, through the uplink both ways, twenty times.
    let mut echoes = Vec::new();
    for _ in 0..20 {
        let before = viewer.screen.screen().contents();
        let sent = Instant::now();
        viewer.send(json!({ "type": "input", "data": "x" })).await;
        viewer
            .until("the echo", |viewer| {
                viewer.screen.screen().contents() != before
            })
            .await;
        echoes.push(sent.elapsed());
        let before = viewer.screen.screen().contents();
        viewer
            .send(json!({ "type": "input", "data": "\u{7f}" }))
            .await;
        viewer
            .until("the erase", |viewer| {
                viewer.screen.screen().contents() != before
            })
            .await;
    }
    echoes.sort();

    // 20,000 lines of output, to the last one drawn.
    let flood = if cfg!(windows) {
        "1..20000"
    } else {
        "seq 1 20000"
    };
    let flooded = Instant::now();
    viewer.type_line(flood).await;
    viewer.until_row("20000").await;
    let flood_time = flooded.elapsed();

    // A second viewer: the snapshot of a full history.
    let joined = Instant::now();
    let mut second = uplink
        .viewer(
            "t-m",
            &format!(
                "token={}&cols=120&rows=40",
                viewer_token("t-m", false, 600_000)
            ),
        )
        .await
        .unwrap();
    second.until_row("20000").await;
    let snapshot_time = joined.elapsed();

    eprintln!(
        "MEASURED on {}: uplink up {:?} after start; create answered in {:?}, shell at its prompt {:?} after the create; \
         keystroke echo median {:?}, p90 {:?}, worst {:?}; 20000 lines drawn in {:?}; a joining viewer drawn the screen \
         and its history in {:?}",
        std::env::consts::OS,
        uplink_up,
        create_answered,
        shell_ready,
        echoes[echoes.len() / 2],
        echoes[echoes.len() * 9 / 10],
        echoes[echoes.len() - 1],
        flood_time,
        snapshot_time,
    );
    drop(remoted.child.stdin.take());
}

// A WSL distro's terminal, reached through `wsl.exe -d` from the Windows side: run by hand on a Windows PC with a distro
// (`cargo test --test terminal -- --ignored wsl`), since it starts the distro when it is not running.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a Windows PC with a WSL distro, and starts it"]
async fn a_wsl_distro_opens_as_its_own_environment() {
    let sandbox = Sandbox::start().await;
    let mut remoted = Remoted::start(&config(sandbox.port, 1, true)).await;
    let uplink = sandbox.next_uplink().await;
    remoted.until_uplink("up").await;
    let (_, info) = uplink.call("GET", "/info", None).await;
    let Some(distro) = info["environments"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .find(|name| name.starts_with("wsl:"))
        .map(str::to_owned)
    else {
        panic!("no WSL distro listed here: {info}");
    };
    let (status, created) = uplink
        .call(
            "POST",
            "/terminals",
            Some(json!({ "session": "t-wsl", "environment": distro, "cwd": "/tmp" })),
        )
        .await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["environment"], distro.as_str());
    let mut viewer = uplink
        .viewer(
            "t-wsl",
            &format!("token={}", viewer_token("t-wsl", false, 60_000)),
        )
        .await
        .unwrap();
    // The distro's own shell, so the Linux spelling of the addition.
    viewer.type_line("echo \"in-wsl-$((40+2))\" && pwd").await;
    viewer.until_row("in-wsl-42").await;
    viewer.until_row("/tmp").await;
    drop(remoted.child.stdin.take());
}
