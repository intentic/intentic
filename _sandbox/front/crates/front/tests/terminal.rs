//! Terminals as a browser meets them, against a real tmux on a private server: the replay, the pane's raw bytes, one
//! control client shared by every viewer, the exits tmux gives, refusals and revocations Node decides, a followed log.

mod support;

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use front_wire::{Endpoint, FromNode, ListenConfig, PreviewRoute, TerminalPlan};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use support::{Harness, Planner, SANDBOX_ID, bound, free_port};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const PATIENCE: Duration = Duration::from_secs(10);

// A tmux server of the test's own, reached through a `tmux` on the front's PATH that names its socket; the machine's
// server, and whatever runs on it, is never touched.
struct Server {
    dir: PathBuf,
    socket: PathBuf,
}

impl Server {
    async fn start(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("front-tmux-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let socket = dir.join("tmux.sock");
        let real = String::from_utf8(
            std::process::Command::new("sh")
                .args(["-c", "command -v tmux"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let shim = dir.join("bin/tmux");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\nunset TMUX\nexec {} -S {} \"$@\"\n",
                real.trim(),
                socket.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        let server = Self { dir, socket };
        // A server with no sessions exits at once; the pin holds it up for the whole test.
        server.tmux(&["new-session", "-d", "-s", "pin"]).await;
        server
            .tmux(&["set-option", "-g", "exit-empty", "off"])
            .await;
        server
    }

    fn bin(&self) -> PathBuf {
        self.dir.join("bin")
    }

    // A sibling test forking while this one's shim was still open for writing leaves a child holding it until that
    // child execs; running the shim meanwhile fails with ETXTBSY, and is simply tried again.
    async fn tmux(&self, args: &[&str]) -> String {
        for _ in 0..100 {
            match tokio::process::Command::new(self.bin().join("tmux"))
                .args(args)
                .output()
                .await
            {
                Ok(output) => return String::from_utf8_lossy(&output.stdout).trim().to_owned(),
                Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("could not run tmux: {error}"),
            }
        }
        panic!("the tmux shim stayed busy");
    }

    // Plain `sh` with no rc files for a known prompt, attached only once that prompt is drawn.
    async fn session(&self, name: &str, cols: u16, rows: u16) {
        let (cols, rows) = (cols.to_string(), rows.to_string());
        self.tmux(&[
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            &cols,
            "-y",
            &rows,
            "-c",
            "/tmp",
            "sh",
        ])
        .await;
        let target = format!("={name}:");
        for _ in 0..400 {
            if !self
                .tmux(&["capture-pane", "-p", "-t", &target])
                .await
                .is_empty()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("the shell in {name} never drew its prompt");
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::process::Command::new(self.bin().join("tmux"))
            .arg("kill-server")
            .status();
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

// What Node would decide, spelled in the query so each socket asks for its own case.
fn planner() -> Planner {
    Arc::new(|raw: &str| {
        let asked = query(raw);
        let value = |key: &str| asked.get(key).cloned().unwrap_or_default();
        let plan = match value("plan").as_str() {
            "tmux" => TerminalPlan::Tmux {
                session: value("session"),
                argv: vec![
                    "attach-session".into(),
                    "-t".into(),
                    format!("={}", value("session")),
                ],
            },
            "tail" => TerminalPlan::Tail {
                path: value("path"),
            },
            "exit" => TerminalPlan::Exit {
                code: 0,
                reason: "no such service".into(),
            },
            _ => TerminalPlan::Refused {
                code: 1008,
                reason: "unauthorized".into(),
            },
        };
        (plan, asked.get("member").cloned())
    })
}

async fn started(name: &str, server: &Server) -> (Harness, u16) {
    let harness = Harness::launch(
        name,
        Arc::new(|_: &str| PreviewRoute::Node),
        planner(),
        Some(server.bin()),
        &[],
    )
    .await;
    let daemon = free_port();
    harness
        .send(&FromNode::Listen {
            config: ListenConfig {
                daemon: Endpoint {
                    host: "127.0.0.1".into(),
                    port: daemon,
                },
                preview: None,
                loopback: None,
                sandbox_id: Some(SANDBOX_ID.into()),
                frame_ancestors: vec![],
                preview_probe_path: "/__intentic/preview-probe".into(),
            },
        })
        .await;
    harness.hello().await;
    bound(daemon).await;
    (harness, daemon)
}

async fn open(port: u16, query: &str) -> Socket {
    let url = format!("ws://127.0.0.1:{port}/system/terminal?{query}");
    tokio_tungstenite::connect_async(url).await.unwrap().0
}

struct Seen {
    bytes: Vec<u8>,
    texts: Vec<String>,
    closed: Option<(CloseCode, String)>,
}

impl Seen {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

// Everything the socket says until `done` holds of it, or the socket ends.
async fn read_until(socket: &mut Socket, done: impl Fn(&Seen) -> bool) -> Seen {
    let mut seen = Seen {
        bytes: Vec::new(),
        texts: Vec::new(),
        closed: None,
    };
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while !done(&seen) {
        let Ok(next) = tokio::time::timeout_at(deadline, socket.next()).await else {
            panic!(
                "timed out; the socket said {:?} {:?}",
                seen.text(),
                seen.texts
            );
        };
        match next {
            Some(Ok(Message::Binary(bytes))) => seen.bytes.extend_from_slice(&bytes),
            Some(Ok(Message::Text(text))) => seen.texts.push(text.to_string()),
            Some(Ok(Message::Close(frame))) => {
                seen.closed = frame.map(|frame| (frame.code, frame.reason.to_string()));
                return seen;
            }
            Some(Ok(_)) => {}
            Some(Err(_)) | None => return seen,
        }
    }
    seen
}

// Everything the socket says for `window`, however little; for asserting that nothing arrives.
async fn heard_for(socket: &mut Socket, window: Duration) -> Vec<u8> {
    let mut bytes = Vec::new();
    let deadline = tokio::time::Instant::now() + window;
    while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, socket.next()).await {
        if let Message::Binary(chunk) = message {
            bytes.extend_from_slice(&chunk);
        }
    }
    bytes
}

async fn type_in(socket: &mut Socket, keys: &str) {
    let input = serde_json::json!({ "type": "input", "data": keys }).to_string();
    socket.send(Message::text(input)).await.unwrap();
}

#[tokio::test]
async fn an_attach_replays_the_pane_then_streams_its_bytes_intact() {
    let server = Server::start("replay").await;
    server.session("replay", 80, 24).await;
    let (_harness, daemon) = started("term-replay", &server).await;
    let mut socket = open(daemon, "plan=tmux&session=replay&cols=80&rows=24").await;
    let replay = read_until(&mut socket, |seen| seen.text().contains("\x1bc")).await;
    assert!(replay.text().contains("\x1b[?2004h"), "{:?}", replay.text());

    type_in(
        &mut socket,
        "printf 'h\\303\\251llo \\033[31mred\\033[0m\\n'\r",
    )
    .await;
    let output = read_until(&mut socket, |seen| seen.text().contains("\x1b[31mred")).await;
    assert!(
        output.text().contains("h\u{e9}llo \x1b[31mred\x1b[0m"),
        "{:?}",
        output.text()
    );
}

#[tokio::test]
async fn viewers_of_one_session_share_one_control_client() {
    let server = Server::start("shared").await;
    server.session("shared", 80, 24).await;
    let (_harness, daemon) = started("term-shared", &server).await;
    let mut first = open(daemon, "plan=tmux&session=shared").await;
    let mut second = open(daemon, "plan=tmux&session=shared").await;
    for socket in [&mut first, &mut second] {
        read_until(socket, |seen| seen.text().contains("\x1bc")).await;
    }
    assert_eq!(
        server
            .tmux(&["list-clients", "-t", "=shared"])
            .await
            .lines()
            .count(),
        1
    );

    type_in(&mut second, "echo SHARED''-OUTPUT\r").await;
    for socket in [&mut first, &mut second] {
        read_until(socket, |seen| seen.text().contains("SHARED-OUTPUT")).await;
    }

    // The last viewer leaving ends the client; the session itself lives on in tmux.
    drop(first);
    drop(second);
    for _ in 0..200 {
        if server
            .tmux(&["list-clients", "-t", "=shared"])
            .await
            .is_empty()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(server.tmux(&["list-clients", "-t", "=shared"]).await, "");
    assert!(
        server
            .tmux(&["list-sessions", "-F", "#{session_name}"])
            .await
            .contains("shared")
    );
}

#[tokio::test]
async fn a_resize_reaches_the_pane() {
    let server = Server::start("resize").await;
    server.session("resize", 80, 24).await;
    let (_harness, daemon) = started("term-resize", &server).await;
    let mut socket = open(daemon, "plan=tmux&session=resize&cols=100&rows=30").await;
    read_until(&mut socket, |seen| seen.text().contains("\x1bc")).await;
    let size = || {
        server.tmux(&[
            "display-message",
            "-p",
            "-t",
            "=resize:",
            "#{pane_width}x#{pane_height}",
        ])
    };
    assert_eq!(size().await, "100x30");
    let resize = serde_json::json!({ "type": "resize", "cols": 120, "rows": 40 }).to_string();
    socket.send(Message::text(resize)).await.unwrap();
    for _ in 0..200 {
        if size().await == "120x40" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(size().await, "120x40");
}

#[tokio::test]
async fn tmux_ending_the_session_or_refusing_the_attach_is_an_exit_with_its_words() {
    let server = Server::start("exits").await;
    server.session("doomed", 80, 24).await;
    let (_harness, daemon) = started("term-exits", &server).await;

    let mut missing = open(daemon, "plan=tmux&session=nowhere").await;
    let refused = read_until(&mut missing, |seen| !seen.texts.is_empty()).await;
    let exit: serde_json::Value = serde_json::from_str(&refused.texts[0]).unwrap();
    assert_eq!(exit["type"], "exit");
    assert!(
        exit["reason"]
            .as_str()
            .unwrap()
            .contains("can't find session"),
        "{exit}"
    );
    assert_eq!(refused.text(), "");

    let mut doomed = open(daemon, "plan=tmux&session=doomed").await;
    read_until(&mut doomed, |seen| seen.text().contains("\x1bc")).await;
    server.tmux(&["kill-session", "-t", "=doomed"]).await;
    let ended = read_until(&mut doomed, |seen| !seen.texts.is_empty()).await;
    let exit: serde_json::Value = serde_json::from_str(&ended.texts[0]).unwrap();
    assert_eq!(
        (exit["type"].as_str(), exit["code"].as_i64()),
        (Some("exit"), Some(0))
    );
}

#[tokio::test]
async fn node_refuses_ends_and_revokes_what_it_decides() {
    let server = Server::start("revoke").await;
    server.session("kept", 80, 24).await;
    let (harness, daemon) = started("term-revoke", &server).await;

    let mut refused = open(daemon, "plan=refuse").await;
    let closed = read_until(&mut refused, |_| false).await;
    assert_eq!(
        closed.closed,
        Some((CloseCode::Policy, "unauthorized".into()))
    );

    let mut ended = open(daemon, "plan=exit").await;
    let said = read_until(&mut ended, |_| false).await;
    assert_eq!(
        said.texts,
        [r#"{"type":"exit","code":0,"reason":"no such service"}"#]
    );

    let mut theirs = open(daemon, "plan=tmux&session=kept&member=gone@example.com").await;
    let mut mine = open(daemon, "plan=tmux&session=kept&member=kept@example.com").await;
    for socket in [&mut theirs, &mut mine] {
        read_until(socket, |seen| seen.text().contains("\x1bc")).await;
    }
    harness
        .send(&FromNode::Revoke {
            member: Some("gone@example.com".into()),
        })
        .await;
    let revoked = read_until(&mut theirs, |_| false).await;
    assert_eq!(
        revoked.closed,
        Some((CloseCode::Policy, "authorization revoked".into()))
    );
    // The other member's socket still answers.
    mine.send(Message::text(r#"{"type":"ping"}"#))
        .await
        .unwrap();
    let answered = read_until(&mut mine, |seen| !seen.texts.is_empty()).await;
    assert_eq!(answered.texts, [r#"{"type":"pong"}"#]);
}

#[tokio::test]
async fn a_services_log_is_followed_from_its_first_line_as_a_terminal_draws_it() {
    let server = Server::start("log").await;
    let (_harness, daemon) = started("term-log", &server).await;
    let log = server.dir.join("service.log");
    std::fs::write(&log, "first\nsecond\n").unwrap();
    let mut socket = open(daemon, &format!("plan=tail&path={}", log.display())).await;
    let seen = read_until(&mut socket, |seen| seen.text().contains("second")).await;
    assert_eq!(seen.text(), "first\r\nsecond\r\n");
    let mut file = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
    std::io::Write::write_all(&mut file, b"third\n").unwrap();
    let more = read_until(&mut socket, |seen| seen.text().contains("third")).await;
    assert_eq!(more.text(), "third\r\n");
}

#[tokio::test]
async fn a_replay_puts_the_panes_rows_and_cursor_on_an_empty_terminal() {
    let server = Server::start("replay-exact").await;
    server.session("exact", 40, 8).await;
    let (_harness, daemon) = started("term-exact", &server).await;
    let mut typing = open(daemon, "plan=tmux&session=exact&cols=40&rows=8").await;
    read_until(&mut typing, |seen| seen.text().contains("\x1bc")).await;
    // Twelve 58-column lines through a 40-column pane: each wraps onto two rows, and most scroll into history.
    type_in(
        &mut typing,
        "for i in $(seq 1 12); do printf 'line-%02d-%s\\n' $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\r",
    )
    .await;
    read_until(&mut typing, |seen| seen.text().contains("line-12-")).await;
    heard_for(&mut typing, Duration::from_millis(500)).await;

    // A second viewer is handed the snapshot: fed to an empty terminal of the pane's size, it must draw the pane.
    let mut joining = open(daemon, "plan=tmux&session=exact&cols=40&rows=8").await;
    let mut replay = read_until(&mut joining, |seen| seen.text().contains("line-12-"))
        .await
        .bytes;
    replay.extend(heard_for(&mut joining, Duration::from_millis(500)).await);
    let mut terminal = vt100::Parser::new(8, 40, 1000);
    terminal.process(&replay);
    let shown: Vec<String> = terminal
        .screen()
        .rows(0, 40)
        .map(|row| row.trim_end().to_owned())
        .collect();
    let pane: Vec<String> = server
        .tmux(&["capture-pane", "-p", "-t", "=exact:"])
        .await
        .split('\n')
        .map(|row| row.trim_end().to_owned())
        .collect();
    let mut expected = pane.clone();
    expected.resize(8, String::new());
    assert_eq!(shown, expected);
    let cursor = server
        .tmux(&[
            "display-message",
            "-p",
            "-t",
            "=exact:",
            "#{cursor_y} #{cursor_x}",
        ])
        .await;
    let (row, col) = terminal.screen().cursor_position();
    assert_eq!(format!("{row} {col}"), cursor);
    // The history went under the screen, oldest first: the first line is in the scrollback, not lost.
    terminal.screen_mut().set_scrollback(1000);
    let history: Vec<String> = terminal.screen().rows(0, 40).collect();
    assert!(
        history.iter().any(|row| row.starts_with("line-01-")),
        "{history:?}"
    );
}

#[tokio::test]
async fn a_tab_follows_its_own_sessions_windows_and_no_other_sessions() {
    let server = Server::start("follow").await;
    server.session("follow", 80, 6).await;
    server.session("elsewhere", 80, 6).await;
    let (_harness, daemon) = started("term-follow", &server).await;
    let mut socket = open(daemon, "plan=tmux&session=follow").await;
    read_until(&mut socket, |seen| seen.text().contains("\x1bc")).await;
    type_in(&mut socket, "echo FIRST''-WINDOW\r").await;
    read_until(&mut socket, |seen| seen.text().contains("FIRST-WINDOW")).await;
    heard_for(&mut socket, Duration::from_millis(300)).await;

    // tmux tells every control client when any session changes window; another session's is not this tab's.
    server
        .tmux(&[
            "new-window",
            "-t",
            "=elsewhere:",
            "-n",
            "run",
            "sh",
            "-c",
            "echo STRANGERS-WINDOW; sleep 30",
        ])
        .await;
    assert_eq!(
        heard_for(&mut socket, Duration::from_millis(1500)).await,
        b""
    );

    // A job opening its next command as a window in this session is drawn, and closing it returns the first.
    server
        .tmux(&[
            "new-window",
            "-t",
            "=follow:",
            "-n",
            "run",
            "sh",
            "-c",
            "echo SECOND''-WINDOW; sleep 30",
        ])
        .await;
    let second = read_until(&mut socket, |seen| seen.text().contains("SECOND-WINDOW")).await;
    assert!(second.text().contains("\x1bc"), "{:?}", second.text());
    server.tmux(&["kill-window", "-t", "=follow:run"]).await;
    read_until(&mut socket, |seen| seen.text().contains("FIRST-WINDOW")).await;
}
