//! castd end to end, on a real X server and a real Chromium: Xvfb started `-shmem`, Chromium in kiosk mode showing
//! tests/fixtures/page.html, castd on the display, and this test as the viewer over the Unix socket with a minted token.
//! It needs Xvfb and Chromium (Playwright's build, or CASTD_TEST_CHROME), and stands down with its reason when either
//! is missing; xclip is optional (the X-side clipboard read-back is skipped without it).

use browser_wire::{
    BrowserMediaClientMessage as C, BrowserMediaServerMessage as S, ClipboardContent, KeyAction,
};
use cast_core::client::{MediaClient, Received};
use cast_core::header::{FLAG_CLIP, FLAG_KEY, KIND_LOSSLESS, KIND_VIDEO};
use cast_core::token::{Claims, now_ms, sign};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// A child process that dies with the test.
struct Proc(Child);

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn chromium() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CASTD_TEST_CHROME") {
        return Some(PathBuf::from(p));
    }
    let cache = PathBuf::from(std::env::var("HOME").ok()?).join(".cache/ms-playwright");
    let mut found: Vec<PathBuf> = std::fs::read_dir(cache)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("chromium-"))
        .flat_map(|e| ["chrome-linux64", "chrome-linux"].map(|d| e.path().join(d).join("chrome")))
        .filter(|p| p.exists())
        .collect();
    found.sort();
    found.pop()
}

fn xvfb() -> Option<PathBuf> {
    let p =
        PathBuf::from(std::env::var("CASTD_TEST_XVFB").unwrap_or_else(|_| "/usr/bin/Xvfb".into()));
    p.exists().then_some(p)
}

fn has(bin: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {bin}")])
        .stdout(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// A display number nobody uses, away from the ones the sandbox's own browsers take (:99 up).
fn free_display() -> u32 {
    (170..260)
        .find(|n| {
            !Path::new(&format!("/tmp/.X{n}-lock")).exists()
                && !Path::new(&format!("/tmp/.X11-unix/X{n}")).exists()
        })
        .expect("a free X display number")
}

/// Waits for a mapped toplevel of at least 200x200 on `display`: Chromium's window.
async fn window_up(display: &str, within: Duration) -> bool {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt, MapState};
    let Ok((conn, n)) = x11rb::rust_connection::RustConnection::connect(Some(display)) else {
        return false;
    };
    let root = conn.setup().roots[n].root;
    let end = Instant::now() + within;
    while Instant::now() < end {
        let up = conn
            .query_tree(root)
            .ok()
            .and_then(|t| t.reply().ok())
            .is_some_and(|t| {
                t.children.iter().any(|&w| {
                    let mapped = conn
                        .get_window_attributes(w)
                        .ok()
                        .and_then(|a| a.reply().ok())
                        .is_some_and(|a| a.map_state == MapState::VIEWABLE);
                    let big = conn
                        .get_geometry(w)
                        .ok()
                        .and_then(|g| g.reply().ok())
                        .is_some_and(|g| g.width >= 200 && g.height >= 200);
                    mapped && big
                })
            });
        if up {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// One HTTP/1.1 request on castd's socket: (status, body).
fn http(socket: &Path, method: &str, path: &str) -> (u16, Vec<u8>) {
    let mut s = std::os::unix::net::UnixStream::connect(socket).expect("connect castd");
    s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: castd\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    )
    .unwrap();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("an HTTP response");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let mut body = raw[split + 4..].to_vec();
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        body = dechunk(&body);
    }
    (status, body)
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(eol) = b.windows(2).position(|w| w == b"\r\n") else {
            return out;
        };
        let n = usize::from_str_radix(String::from_utf8_lossy(&b[..eol]).trim(), 16).unwrap_or(0);
        if n == 0 {
            return out;
        }
        out.extend_from_slice(&b[eol + 2..eol + 2 + n]);
        b = &b[eol + 2 + n + 2..];
    }
}

fn json(socket: &Path, method: &str, path: &str) -> serde_json::Value {
    let (status, body) = http(socket, method, path);
    assert_eq!(
        status,
        200,
        "{method} {path}: {}",
        String::from_utf8_lossy(&body)
    );
    serde_json::from_slice(&body).expect("JSON")
}

/// castd's CPU time so far, in seconds.
fn cpu_seconds(pid: u32) -> f64 {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let fields: Vec<&str> = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .collect();
    let ticks: f64 = fields[11].parse::<f64>().unwrap() + fields[12].parse::<f64>().unwrap();
    ticks / unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64
}

/// The viewer's side: acks every frame, and keeps what else arrives for the test to look for.
struct Viewer {
    c: MediaClient,
    frames: Vec<(u8, Instant)>,
    json: Vec<S>,
}

impl Viewer {
    async fn send(&mut self, m: C) {
        self.c.send(&m).await.expect("send");
    }

    /// Reads for up to `within`, until `done` says so; true if it did.
    async fn until(&mut self, within: Duration, mut done: impl FnMut(&Viewer) -> bool) -> bool {
        let end = Instant::now() + within;
        loop {
            if done(self) {
                return true;
            }
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            match self.c.recv(left).await {
                Some(Received::Media { header, at, .. }) if header.kind == KIND_VIDEO => {
                    self.c
                        .send(&C::Ack {
                            id: header.id,
                            decode_ms: Some(1.0),
                        })
                        .await
                        .expect("ack");
                    self.frames.push((header.flags, at));
                }
                Some(Received::Json(m)) => self.json.push(m),
                Some(_) => {}
                None => return done(self),
            }
        }
    }

    /// Reads until no frame came for `quiet`, at most `within`.
    async fn settle(&mut self, quiet: Duration, within: Duration) {
        let end = Instant::now() + within;
        while Instant::now() < end {
            let before = self.frames.len();
            self.until(quiet, |_| false).await;
            if self.frames.len() == before {
                return;
            }
        }
    }

    async fn key(&mut self, key: &str, ctrl: bool) {
        self.send(C::Key {
            key: key.into(),
            code: None,
            action: Some(KeyAction::Press),
            ctrl: Some(ctrl),
            shift: None,
            alt: None,
        })
        .await;
    }

    async fn click(&mut self, x: f64, y: f64) {
        for action in [
            browser_wire::PointerAction::Move,
            browser_wire::PointerAction::Down,
            browser_wire::PointerAction::Up,
        ] {
            self.send(C::Mouse {
                action,
                x,
                y,
                button: Some(0),
                buttons: Some(u8::from(action == browser_wire::PointerAction::Down)),
                click_count: Some(1),
                ctrl: None,
                shift: None,
                alt: None,
            })
            .await;
        }
    }

    /// Selects the field's text and copies it; returns what castd sends back as the window's clipboard.
    async fn copy_field(&mut self) -> Option<String> {
        self.json.clear();
        self.key("a", true).await;
        self.key("c", true).await;
        self.until(Duration::from_secs(5), |v| {
            v.json.iter().any(|m| matches!(m, S::Clipboard { .. }))
        })
        .await;
        self.json.iter().find_map(|m| match m {
            S::Clipboard { content } => content.text.clone(),
            _ => None,
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn castd_streams_types_pastes_and_idles_on_a_real_chromium() {
    let (Some(xvfb), Some(chrome)) = (xvfb(), chromium()) else {
        eprintln!(
            "castd integration test stands down: needs Xvfb (CASTD_TEST_XVFB) and Chromium (CASTD_TEST_CHROME)"
        );
        return;
    };
    let dir = std::env::temp_dir().join(format!("castd-itest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let n = free_display();
    let display = format!(":{n}");
    let (sw, sh) = (1600u32, 1000u32);
    let _x = Proc(
        Command::new(&xvfb)
            .args([
                &display,
                "-screen",
                "0",
                &format!("{sw}x{sh}x24"),
                "-shmem",
                "-nolisten",
                "tcp",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("Xvfb"),
    );
    let x_socket = PathBuf::from(format!("/tmp/.X11-unix/X{n}"));
    let t0 = Instant::now();
    while !x_socket.exists() && t0.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(x_socket.exists(), "Xvfb did not start on {display}");
    let page = format!(
        "file://{}/tests/fixtures/page.html",
        env!("CARGO_MANIFEST_DIR")
    );
    let _chrome = Proc(
        Command::new(&chrome)
            .env("DISPLAY", &display)
            .args([
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-gpu",
                "--disable-features=Translate,MediaRouter",
                "--password-store=basic",
                &format!("--user-data-dir={}", dir.join("profile").display()),
                "--kiosk",
                "--window-position=0,0",
                &format!("--window-size={sw},{sh}"),
                &page,
            ])
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(dir.join("chrome.log")).unwrap())
            .spawn()
            .expect("Chromium"),
    );
    assert!(
        window_up(&display, Duration::from_secs(30)).await,
        "Chromium showed no window on {display} (see {})",
        dir.join("chrome.log").display()
    );
    let key_file = dir.join("key");
    std::fs::write(&key_file, b"integration-test-key").unwrap();
    let socket = dir.join("castd.sock");
    let castd = Proc(
        Command::new(env!("CARGO_BIN_EXE_castd"))
            .args(["--session", "itest", "--display", &display, "--fps", "60"])
            // A peer port on loopback, the bound port its candidate.
            .args(["--rtc-udp", "127.0.0.1:0"])
            .arg("--key-file")
            .arg(&key_file)
            .arg("--socket")
            .arg(&socket)
            .env("RUST_LOG", "info")
            .stderr(std::fs::File::create(dir.join("castd.log")).unwrap())
            .spawn()
            .expect("castd"),
    );
    let pid = castd.0.id();
    let t0 = Instant::now();
    while !socket.exists() && t0.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let health = json(&socket, "GET", "/health");
    assert_eq!(health["ok"], true);
    // Chromium's first paint, before anything is measured.
    let waited = json(&socket, "GET", "/wait?quiet_ms=700&timeout_ms=20000");
    assert_eq!(
        waited["timed_out"], false,
        "the page never settled: {waited}"
    );

    let sock = socket.to_str().unwrap();
    let key = b"integration-test-key";
    let token = |ro: bool, session: &str, exp: u64| {
        sign(
            key,
            &Claims {
                s: session.into(),
                exp,
                ro,
                iat: now_ms(),
            },
        )
    };
    // Refused at the upgrade: another key, another session, an expired token, none at all.
    let later = now_ms() + 600_000;
    for bad in [
        sign(
            b"not-the-key",
            &Claims {
                s: "itest".into(),
                exp: later,
                ro: false,
                iat: now_ms(),
            },
        ),
        token(false, "other", later),
        token(false, "itest", now_ms() - 1),
    ] {
        let refused = MediaClient::connect(sock, "itest", &bad).await;
        assert!(
            refused.as_ref().is_err_and(|e| e.contains("403")),
            "{:?}",
            refused.err()
        );
    }
    assert_eq!(http(&socket, "GET", "/system/browser-media/itest").0, 401);

    // The viewer: hello first, then resize the screen to its box, then the new hello and a keyframe.
    let mut v = Viewer {
        c: MediaClient::connect(sock, "itest", &token(false, "itest", later))
            .await
            .expect("connect"),
        frames: Vec::new(),
        json: Vec::new(),
    };
    assert!(
        v.until(Duration::from_secs(5), |v| v
            .json
            .iter()
            .any(|m| matches!(m, S::Hello { .. })))
            .await
    );
    match &v.json[0] {
        S::Hello {
            width,
            height,
            codec,
            read_only,
            audio,
            ..
        } => {
            assert_eq!((*width, *height), (sw, sh));
            assert!(codec.starts_with("avc1."), "{codec}");
            assert!(!read_only);
            assert!(audio.is_none());
        }
        other => panic!("first message {other:?}"),
    }
    // The X cursor comes right after the hello: a PNG with its hotspot.
    let has_cursor = |v: &Viewer| {
        v.json.iter().any(
            |m| matches!(m, S::Cursor { cursor } if cursor.png.is_some() && cursor.hot_x.is_some()),
        )
    };
    assert!(
        v.until(Duration::from_secs(5), has_cursor).await,
        "no cursor after the hello: {:?}",
        v.json
    );
    v.json.clear();
    v.send(C::Resize {
        width: 640,
        height: 400,
        scale: 1.5,
        hz: None,
    })
    .await;
    let resized = v
        .until(Duration::from_secs(10), |v| {
            v.json.iter().any(|m| {
                matches!(
                    m,
                    S::Hello {
                        width: 960,
                        height: 600,
                        ..
                    }
                )
            })
        })
        .await;
    assert!(resized, "no hello at 960x600 after resize: {:?}", v.json);
    let hello_at = v.frames.len();
    assert!(
        v.until(Duration::from_secs(5), |v| v.frames[hello_at..]
            .iter()
            .any(|(f, _)| f & FLAG_KEY != 0))
            .await,
        "no keyframe after the new hello"
    );
    let geometry = json(&socket, "GET", "/geometry");
    assert_eq!(
        (geometry["width"].as_u64(), geometry["height"].as_u64()),
        (Some(960), Some(600))
    );
    assert_eq!(geometry["scale"].as_f64(), Some(1.5));
    assert_eq!(geometry["screen"]["width"].as_u64(), Some(960));
    // Chromium's window covered the old screen, so castd fitted it to the new one.
    let (conn, screen_num) =
        x11rb::rust_connection::RustConnection::connect(Some(&display)).unwrap();
    {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::ConnectionExt;
        let root = conn.setup().roots[screen_num].root;
        let tree = conn.query_tree(root).unwrap().reply().unwrap();
        let fitted = tree.children.iter().any(|&w| {
            conn.get_geometry(w)
                .ok()
                .and_then(|g| g.reply().ok())
                .is_some_and(|g| (g.width, g.height) == (960, 600))
        });
        let seen: Vec<String> = tree
            .children
            .iter()
            .filter_map(|&w| {
                let g = conn.get_geometry(w).ok()?.reply().ok()?;
                let a = conn.get_window_attributes(w).ok()?.reply().ok()?;
                Some(format!(
                    "{w:#x} {}x{}+{}+{} {:?} or={}",
                    g.width, g.height, g.x, g.y, a.map_state, a.override_redirect
                ))
            })
            .collect();
        assert!(
            fitted,
            "no toplevel was fitted to the 960x600 screen: {seen:?}"
        );
    }
    v.settle(Duration::from_millis(600), Duration::from_secs(10))
        .await;

    // A pin holds the screen whatever the viewer's box says, and answers once it is in effect; unpin goes back to the
    // box the viewer asked for meanwhile.
    let pinned = json(&socket, "POST", "/pin?width=500&height=300&scale=1");
    assert_eq!(pinned["applied"], true, "{pinned}");
    assert_eq!(
        (pinned["width"].as_u64(), pinned["height"].as_u64()),
        (Some(500), Some(300))
    );
    v.send(C::Resize {
        width: 700,
        height: 500,
        scale: 1.0,
        hz: None,
    })
    .await;
    v.until(Duration::from_millis(500), |_| false).await;
    assert_eq!(
        json(&socket, "GET", "/geometry")["width"].as_u64(),
        Some(500),
        "a pinned screen followed a viewer"
    );
    let unpinned = json(&socket, "POST", "/unpin");
    assert_eq!(
        (unpinned["width"].as_u64(), unpinned["height"].as_u64()),
        (Some(700), Some(500))
    );
    v.json.clear();
    v.send(C::Resize {
        width: 640,
        height: 400,
        scale: 1.5,
        hz: None,
    })
    .await;
    assert!(
        v.until(Duration::from_secs(10), |v| v
            .json
            .iter()
            .any(|m| matches!(m, S::Hello { width: 960, .. })))
            .await,
        "no hello back at 960x600"
    );
    v.settle(Duration::from_millis(600), Duration::from_secs(10))
        .await;

    // A key makes a frame follow.
    v.click(480.0, 100.0).await;
    v.settle(Duration::from_millis(400), Duration::from_secs(5))
        .await;
    let before = v.frames.len();
    let sent = Instant::now();
    v.key("x", false).await;
    let followed = v
        .until(Duration::from_secs(3), |v| v.frames.len() > before)
        .await;
    if !followed {
        std::fs::write(
            dir.join("after-key.png"),
            http(&socket, "GET", "/screenshot").1,
        )
        .unwrap();
    }
    assert!(followed, "no frame after a key (see {})", dir.display());
    let key_to_frame = v.frames[before].1.duration_since(sent);
    eprintln!("key -> first frame: {key_to_frame:?}");

    // Characters the US keymap lacks go through spare keycodes; text types as it stands; Ctrl+A, Ctrl+C in the page
    // comes back as the window's clipboard.
    for k in ["ą", "€", "@", "Ł"] {
        v.key(k, false).await;
    }
    v.send(C::Text {
        text: "zażółć ŝ".into(),
    })
    .await;
    let typed = v.copy_field().await;
    assert_eq!(
        typed.as_deref(),
        Some("xą€@Łzażółć ŝ"),
        "what the field holds"
    );

    // Setting the clipboard is immediate and in order with the keys: a paste is the clipboard, then Ctrl+V.
    let pasted = "pasted ą — ".to_string() + &"0123456789".repeat(1000);
    let t = Instant::now();
    v.send(C::Clipboard {
        content: ClipboardContent {
            text: Some(pasted.clone()),
            html: Some("<b>x</b>".into()),
            png: None,
        },
    })
    .await;
    v.key("a", true).await;
    v.key("Y", false).await;
    v.key("v", true).await;
    let roundtrip = v.copy_field().await;
    let paste_ms = t.elapsed().as_millis();
    assert_eq!(roundtrip.as_deref().map(str::len), Some(1 + pasted.len()));
    assert_eq!(roundtrip, Some(format!("Y{pasted}")));
    eprintln!("10k-character paste, then select-all and copy back: {paste_ms} ms");
    assert!(paste_ms < 3000, "the paste round trip took {paste_ms} ms");
    if has("xclip") {
        v.send(C::Clipboard {
            content: ClipboardContent {
                text: Some("from the viewer ż".into()),
                html: None,
                png: None,
            },
        })
        .await;
        v.until(Duration::from_millis(300), |_| false).await;
        for selection in ["clipboard", "primary"] {
            let out = Command::new("xclip")
                .args(["-selection", selection, "-o"])
                .env("DISPLAY", &display)
                .output()
                .expect("xclip");
            assert_eq!(
                String::from_utf8_lossy(&out.stdout),
                "from the viewer ż",
                "{selection}"
            );
        }
    }

    // Control endpoints.
    let (status, png) = http(&socket, "GET", "/screenshot");
    assert_eq!(status, 200);
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(
        http(&socket, "POST", "/crop?x=0&y=0&w=100&h=100").0,
        400,
        "a whole-screen castd moved a crop"
    );
    let rec = json(&socket, "POST", "/record/start");
    let id = rec["id"].as_u64().unwrap();
    v.key("z", false).await;
    v.until(Duration::from_millis(800), |_| false).await;
    let (status, mp4) = http(&socket, "POST", &format!("/record/stop?id={id}"));
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&mp4));
    assert_eq!(&mp4[4..8], b"ftyp");

    // A read-only viewer is told so.
    let mut ro = MediaClient::connect(sock, "itest", &token(true, "itest", later))
        .await
        .unwrap();
    match ro.recv(Duration::from_secs(5)).await {
        Some(Received::Json(S::Hello { read_only, .. })) => assert!(read_only),
        other => panic!("read-only viewer got {other:?}"),
    }
    ro.close().await;

    peer_carries_the_stream_and_hands_it_back(sock, &token(false, "itest", later)).await;

    // Nothing focused, so nothing blinks: the next viewer's first exact copy is of a screen that holds still.
    v.click(f64::from(sw) / 2.0, f64::from(sh) * 0.75).await;
    assert_eq!(
        json(&socket, "GET", "/wait?quiet_ms=700&timeout_ms=10000")["timed_out"],
        false
    );
    a_local_viewer_gets_exact_pictures(sock, &socket, &token(false, "itest", later)).await;

    // A second castd on the same desktop serves one region of it, and moves the region without a restart.
    let crop_socket = dir.join("crop.sock");
    let crop = Proc(
        Command::new(env!("CARGO_BIN_EXE_castd"))
            .args([
                "--session",
                "region",
                "--display",
                &display,
                "--crop",
                "0,0,400,300",
            ])
            .arg("--key-file")
            .arg(&key_file)
            .arg("--socket")
            .arg(&crop_socket)
            .stderr(std::fs::File::create(dir.join("crop.log")).unwrap())
            .spawn()
            .expect("castd --crop"),
    );
    let t0 = Instant::now();
    while !crop_socket.exists() && t0.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut region = Viewer {
        c: MediaClient::connect(
            crop_socket.to_str().unwrap(),
            "region",
            &token(false, "region", later),
        )
        .await
        .expect("connect to the region"),
        frames: Vec::new(),
        json: Vec::new(),
    };
    assert!(
        region
            .until(Duration::from_secs(5), |v| v.json.iter().any(|m| matches!(
                m,
                S::Hello {
                    width: 400,
                    height: 300,
                    ..
                }
            )))
            .await,
        "the region's first hello: {:?}",
        region.json
    );
    let moved = json(&crop_socket, "POST", "/crop?x=100&y=100&w=201&h=161");
    assert_eq!(moved["applied"], true, "{moved}");
    assert_eq!(moved["crop"]["w"].as_u64(), Some(200));
    assert!(
        region
            .until(Duration::from_secs(5), |v| v.json.iter().any(|m| matches!(
                m,
                S::Hello {
                    width: 200,
                    height: 160,
                    ..
                }
            )))
            .await,
        "no hello for the moved region: {:?}",
        region.json
    );
    let n = region.frames.len();
    assert!(
        region
            .until(Duration::from_secs(5), |v| v.frames[n..]
                .iter()
                .any(|(f, _)| f & FLAG_KEY != 0))
            .await,
        "no keyframe of the moved region"
    );
    assert_eq!(
        json(&crop_socket, "GET", "/geometry")["crop"]["x"].as_u64(),
        Some(100)
    );
    region.c.close().await;
    drop(crop);

    // A still page costs nothing: blur the field (no caret blink), settle, and measure castd's CPU with the viewer
    // still connected.
    v.click(900.0, 580.0).await;
    v.key("Escape", false).await;
    v.settle(Duration::from_millis(1000), Duration::from_secs(10))
        .await;
    let (c0, t0) = (cpu_seconds(pid), Instant::now());
    let frames_before = v.frames.len();
    v.until(Duration::from_secs(4), |_| false).await;
    let idle_cores = (cpu_seconds(pid) - c0) / t0.elapsed().as_secs_f64();
    eprintln!(
        "idle: {idle_cores:.4} cores, {} frames in 4 s",
        v.frames.len() - frames_before
    );
    assert!(
        idle_cores < 0.02,
        "castd used {idle_cores:.3} cores on a still page"
    );

    // SIGTERM: a clean exit that takes the socket file with it.
    v.c.close().await;
    unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    let mut castd = castd;
    let t0 = Instant::now();
    let status = loop {
        if let Some(s) = castd.0.try_wait().unwrap() {
            break Some(s);
        }
        if t0.elapsed() > Duration::from_secs(5) {
            break None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(
        status.is_some_and(|s| s.success()),
        "castd did not exit cleanly on SIGTERM: {status:?}"
    );
    assert!(!socket.exists(), "the socket file outlived castd");
    drop(castd);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A viewer on this computer's loopback that asks for exact pictures: its frames are clipped (the first one whole), the
/// still screen comes as an exact copy identical to castd's own screenshot, and after a keystroke only the area that
/// changed is drawn by video and then copied. A viewer that asks but is not local, or is local and does not ask, gets the
/// stream as before.
async fn a_local_viewer_gets_exact_pictures(sock: &str, socket: &Path, token: &str) {
    use cast_core::media::Reach;
    const WITHIN: Duration = Duration::from_secs(5);
    let mut v = MediaClient::connect_as(
        sock,
        "itest",
        token,
        Reach {
            local: true,
            lossless: true,
        },
    )
    .await
    .expect("connect");
    let (w, h) = match v.recv(WITHIN).await {
        Some(Received::Json(S::Hello {
            width,
            height,
            local,
            ..
        })) => {
            assert_eq!(local, Some(true), "a local viewer is told so");
            (width, height)
        }
        other => panic!("expected a hello, got {other:?}"),
    };
    let whole = cast_core::geometry::Rect { x: 0, y: 0, w, h };
    // The starting keyframe is drawn whole, then the still screen comes exact.
    let mut first_clip = None;
    let mut copy = None;
    let end = Instant::now() + Duration::from_secs(5);
    while copy.is_none() && Instant::now() < end {
        match v.recv(WITHIN).await {
            Some(Received::Media { header, rect, .. }) if header.kind == KIND_VIDEO => {
                assert_ne!(header.flags & FLAG_CLIP, 0, "every frame is clipped");
                first_clip.get_or_insert(rect);
                v.send(&C::Ack {
                    id: header.id,
                    decode_ms: Some(1.0),
                })
                .await
                .unwrap();
            }
            Some(Received::Media {
                header,
                rect,
                pixels,
                ..
            }) if header.kind == KIND_LOSSLESS => copy = Some((rect, pixels)),
            Some(_) => {}
            None => break,
        }
    }
    assert_eq!(
        first_clip,
        Some(Some(whole)),
        "the starting keyframe is drawn whole"
    );
    let (rect, pixels) = copy.expect("an exact copy of the still screen");
    assert_eq!(rect, Some(whole));
    let pixels = pixels.expect("the copy's pixels");
    assert_eq!(pixels.len(), (w * h * 4) as usize);
    // Exact: the X server's pixels, as castd's screenshot reads them.
    let (status, png_bytes) = http(socket, "GET", "/screenshot");
    assert_eq!(status, 200);
    let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes))
        .read_info()
        .unwrap();
    let mut rgb = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut rgb).unwrap();
    assert_eq!((info.width, info.height), (w, h));
    let channels = info.color_type.samples();
    let differing = (0..(w * h) as usize)
        .filter(|&i| {
            let (b, g, r) = (pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
            [r, g, b] != rgb[i * channels..i * channels + 3]
        })
        .count();
    assert_eq!(
        differing, 0,
        "the copy differs from the screen in {differing} pixels"
    );

    // A keystroke: video draws only around what changed, and that area is copied again once still.
    for (action, buttons) in [
        (browser_wire::PointerAction::Move, 0),
        (browser_wire::PointerAction::Down, 1),
        (browser_wire::PointerAction::Up, 0),
    ] {
        v.send(&C::Mouse {
            action,
            x: f64::from(w) / 2.0,
            y: f64::from(h) / 8.0,
            button: Some(0),
            buttons: Some(buttons),
            click_count: Some(1),
            ctrl: None,
            shift: None,
            alt: None,
        })
        .await
        .unwrap();
    }
    v.send(&C::Key {
        key: "q".into(),
        code: None,
        action: Some(KeyAction::Press),
        ctrl: None,
        shift: None,
        alt: None,
    })
    .await
    .unwrap();
    let (mut clips, mut small_copy) = (Vec::new(), None);
    let end = Instant::now() + Duration::from_secs(5);
    while small_copy.is_none() && Instant::now() < end {
        match v.recv(WITHIN).await {
            Some(Received::Media { header, rect, .. }) if header.kind == KIND_VIDEO => {
                clips.push(rect.expect("a clipped frame's rectangle"));
                v.send(&C::Ack {
                    id: header.id,
                    decode_ms: Some(1.0),
                })
                .await
                .unwrap();
            }
            Some(Received::Media { header, rect, .. }) if header.kind == KIND_LOSSLESS => {
                small_copy = rect
            }
            Some(_) => {}
            None => break,
        }
    }
    let area = |r: &cast_core::geometry::Rect| u64::from(r.w) * u64::from(r.h);
    assert!(!clips.is_empty(), "the keystroke was drawn");
    assert!(
        clips.iter().all(|r| area(r) * 4 <= area(&whole)),
        "frames after a keystroke draw only near it: {clips:?}"
    );
    let small_copy = small_copy.expect("the changed area copied once still");
    assert!(area(&small_copy) * 4 <= area(&whole), "{small_copy:?}");
    v.close().await;

    // Asking without being local, or being local without asking: the stream as it always was.
    for reach in [
        Reach {
            local: false,
            lossless: true,
        },
        Reach {
            local: true,
            lossless: false,
        },
    ] {
        let mut other = MediaClient::connect_as(sock, "itest", token, reach)
            .await
            .expect("connect");
        let mut key = None;
        let end = Instant::now() + Duration::from_secs(5);
        while key.is_none() && Instant::now() < end {
            match other.recv(WITHIN).await {
                Some(Received::Media { header, .. }) if header.kind == KIND_VIDEO => {
                    key = Some(header.flags)
                }
                Some(Received::Media { header, .. }) => {
                    assert_ne!(header.kind, KIND_LOSSLESS, "{reach:?} got a copy")
                }
                Some(_) => {}
                None => break,
            }
        }
        let flags = key.expect("a keyframe");
        assert_eq!(flags & FLAG_CLIP, 0, "{reach:?} got a clipped frame");
        other.close().await;
    }
}

/// A viewer's peer connection beside its socket: castd answers the offer the socket carries, says `hello` on the peer's
/// `media` channel once it opens and sends the pictures there from a keyframe on, takes input typed on `input`, and when
/// the viewer lets go of the peer brings the stream back to the socket with `rtcClosed`, a `hello` and a keyframe.
async fn peer_carries_the_stream_and_hands_it_back(sock: &str, token: &str) {
    use cast_core::rtc::viewer::{Arrived, RtcViewer};
    let mut v = Viewer {
        c: MediaClient::connect(sock, "itest", token)
            .await
            .expect("connect"),
        frames: Vec::new(),
        json: Vec::new(),
    };
    assert!(
        v.until(Duration::from_secs(5), |v| v.json.iter().any(|m| matches!(
            m,
            S::Hello {
                rtc: Some(true),
                ..
            }
        )))
        .await,
        "a castd with a peer port says so in its hello: {:?}",
        v.json
    );
    let (mut peer, offer) = RtcViewer::offer("127.0.0.1".parse().unwrap())
        .await
        .unwrap();
    v.send(C::RtcOffer { sdp: offer }).await;
    assert!(
        v.until(Duration::from_secs(5), |v| v
            .json
            .iter()
            .any(|m| matches!(m, S::RtcAnswer { .. })))
            .await,
        "no answer to the offer: {:?}",
        v.json
    );
    let answer = v
        .json
        .iter()
        .find_map(|m| match m {
            S::RtcAnswer { sdp } => Some(sdp.clone()),
            _ => None,
        })
        .unwrap();
    peer.answer(&answer).unwrap();
    // The socket is still read (its pings answered) while the peer comes up.
    let mut hello = false;
    let mut key_on_peer = None;
    let until = Instant::now() + Duration::from_secs(10);
    while key_on_peer.is_none() && Instant::now() < until {
        tokio::join!(v.until(Duration::from_millis(20), |_| false), async {
            match peer.recv(Duration::from_millis(20)).await {
                Some(Arrived::Text(text)) if text.contains(r#""type":"hello""#) => hello = true,
                Some(Arrived::Media(bytes, _)) if bytes[0] == KIND_VIDEO => {
                    let header = cast_core::header::Header::read(&bytes).unwrap();
                    assert!(hello, "a picture on the peer before its hello");
                    peer.send(
                        &serde_json::to_string(&C::Ack {
                            id: header.id,
                            decode_ms: Some(1.0),
                        })
                        .unwrap(),
                    );
                    if header.flags & FLAG_KEY != 0 {
                        key_on_peer = Some(header.id);
                    }
                }
                _ => {}
            }
        });
    }
    assert!(key_on_peer.is_some(), "no keyframe arrived on the peer");
    // Typing on the peer changes the page, whose pictures come over the peer too.
    v.frames.clear();
    let typed = serde_json::to_string(&C::Key {
        key: "q".into(),
        code: None,
        action: Some(KeyAction::Press),
        ctrl: None,
        shift: None,
        alt: None,
    })
    .unwrap();
    assert!(peer.send(&typed));
    let mut after_key = 0;
    let until = Instant::now() + Duration::from_secs(5);
    while after_key == 0 && Instant::now() < until {
        tokio::join!(v.until(Duration::from_millis(20), |_| false), async {
            if let Some(Arrived::Media(bytes, _)) = peer.recv(Duration::from_millis(20)).await
                && bytes[0] == KIND_VIDEO
            {
                let header = cast_core::header::Header::read(&bytes).unwrap();
                peer.send(
                    &serde_json::to_string(&C::Ack {
                        id: header.id,
                        decode_ms: Some(1.0),
                    })
                    .unwrap(),
                );
                after_key += 1;
            }
        });
    }
    assert!(
        after_key > 0,
        "the key typed on the peer drew nothing on it"
    );
    assert!(
        v.frames.is_empty(),
        "pictures still came on the socket while the peer carried them"
    );

    // The viewer lets go: the socket hears why, then a hello and a keyframe.
    v.json.clear();
    v.send(C::RtcClose).await;
    assert!(
        v.until(Duration::from_secs(5), |v| v
            .frames
            .iter()
            .any(|(f, _)| f & FLAG_KEY != 0))
            .await,
        "the stream did not come back to the socket: {:?}",
        v.json
    );
    let said: Vec<&str> = v
        .json
        .iter()
        .filter_map(|m| match m {
            S::RtcClosed { .. } => Some("rtcClosed"),
            S::Hello { .. } => Some("hello"),
            _ => None,
        })
        .collect();
    assert_eq!(said, ["rtcClosed", "hello"]);
    v.c.close().await;
}
