//! A runner's uplink on two real binaries: a runner's netd dials its parent's netd as the real one does, and a person's
//! view of the runner and a runner-slot preview reach the runner's netd, its Node and its dev server through the parent.
//! Everything the parent must refuse is refused there, and nothing a stranger sends the runner directly is read as the
//! parent's word.

mod support;

use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use browser_wire::{RUNNER_HEADER, RUNNER_UPLINK_PATH};
use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use netd_wire::{
    Answer, Endpoint, FromNode, ListenConfig, ParentUplinkConfig, PreviewRoute, RunnerUplinkState,
    Scheme, TerminalPlan, Upstream,
};
use support::{Harness, Planner, Router, SANDBOX_ID, bound, free_port};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Error as SocketError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const PATIENCE: Duration = Duration::from_secs(10);
const TOKEN: &str = "irt_runner-token";
const MEMBER: &str = "maintainer@example.test";

struct Ports {
    daemon: u16,
    loopback: u16,
    preview: u16,
}

fn refusing_terminals() -> Planner {
    Arc::new(|_| {
        (
            TerminalPlan::Refused {
                code: 1008,
                reason: "no terminals here".into(),
            },
            None,
        )
    })
}

async fn started(name: &str, route: Router, terminal: Planner) -> (Harness, Ports) {
    let harness = Harness::launch(name, route, terminal, None, &[]).await;
    let ports = Ports {
        daemon: free_port(),
        loopback: free_port(),
        preview: free_port(),
    };
    let endpoint = |port| Endpoint {
        host: "127.0.0.1".into(),
        port,
    };
    harness
        .send(&FromNode::Listen {
            config: ListenConfig {
                daemon: endpoint(ports.daemon),
                preview: Some(endpoint(ports.preview)),
                loopback: Some(endpoint(ports.loopback)),
                sandbox_id: Some(SANDBOX_ID.into()),
                frame_ancestors: vec!["https://app.example.test".into()],
                preview_probe_path: "/__probe".into(),
                preview_guard: None,
            },
        })
        .await;
    harness.hello().await;
    for port in [ports.daemon, ports.loopback, ports.preview] {
        bound(port).await;
    }
    (harness, ports)
}

fn sha256_hex(token: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, token.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn register(parent: &Harness, runner: &str, token: &str) {
    parent
        .send(&FromNode::RunnerUplink {
            runner: runner.into(),
            token_sha256: sha256_hex(token),
        })
        .await;
}

async fn dial(runner: &Harness, parent: &Ports, id: &str, token: &str) {
    runner
        .send(&FromNode::ParentUplink {
            uplink: Some(ParentUplinkConfig {
                url: format!("http://127.0.0.1:{}/", parent.daemon),
                runner: id.into(),
                token: token.into(),
            }),
        })
        .await;
}

async fn runners_are(parent: &Harness, wanted: &[(&str, bool)]) {
    let wanted: Vec<RunnerUplinkState> = wanted
        .iter()
        .map(|(runner, connected)| RunnerUplinkState {
            runner: (*runner).into(),
            connected: *connected,
        })
        .collect();
    let mut runners = parent.runners.clone();
    tokio::time::timeout(PATIENCE, runners.wait_for(|(_, held)| *held == wanted))
        .await
        .unwrap_or_else(|_| {
            panic!(
                "the parent never reported {wanted:?}: {:?}",
                parent.runners.borrow()
            )
        })
        .unwrap();
}

// Waits for the runner's own report of its uplink to say `connected` with a reason containing `why`.
async fn uplink_is(runner: &Harness, connected: bool, why: &str) {
    let mut parent = runner.parent.clone();
    tokio::time::timeout(
        PATIENCE,
        parent.wait_for(|(told, up, reason)| {
            *told > 0 && *up == connected && reason.as_deref().unwrap_or("").contains(why)
        }),
    )
    .await
    .unwrap_or_else(|_| {
        panic!(
            "the runner never reported connected={connected} for {why:?}: {:?}",
            runner.parent.borrow()
        )
    })
    .unwrap();
}

// A parent and its runner, the runner's uplink up.
async fn linked(name: &str, route: Router, terminal: Planner) -> (Harness, Ports, Harness, Ports) {
    let (parent, parent_ports) =
        started(&format!("{name}-parent"), route, refusing_terminals()).await;
    let (runner, runner_ports) = started(
        &format!("{name}-runner"),
        Arc::new(|_: &str, _| support::nothing_here()),
        terminal,
    )
    .await;
    register(&parent, "r1", TOKEN).await;
    runners_are(&parent, &[("r1", false)]).await;
    dial(&runner, &parent_ports, "r1", TOKEN).await;
    runners_are(&parent, &[("r1", true)]).await;
    uplink_is(&runner, true, "").await;
    (parent, parent_ports, runner, runner_ports)
}

// The tickets the parent's stand-in daemon admits, each once, for `r1` only; and every path it was asked about.
fn tickets(parent: &Harness, valid: &[&str]) -> Arc<Mutex<Vec<String>>> {
    let valid: Arc<Mutex<HashSet<String>>> =
        Arc::new(Mutex::new(valid.iter().map(|t| (*t).to_owned()).collect()));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let asking = asked.clone();
    parent.set_viewer(Arc::new(move |runner: &str, path: &str, query: &str| {
        asking
            .lock()
            .unwrap()
            .push(format!("{runner} {path} {query}"));
        let ticket = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("ticket="))
            .unwrap_or("");
        let allowed = (runner == "r1" || runner == "r9") && valid.lock().unwrap().remove(ticket);
        Answer::RunnerView {
            allowed,
            member: allowed.then(|| MEMBER.to_owned()),
            reason: (!allowed).then(|| "no such ticket".to_owned()),
        }
    }));
    asked
}

async fn head_of(stream: &mut TcpStream) -> String {
    let mut answer = Vec::new();
    let mut byte = [0_u8; 1];
    while !answer.ends_with(b"\r\n\r\n") {
        if stream.read_exact(&mut byte).await.is_err() {
            break;
        }
        answer.push(byte[0]);
    }
    String::from_utf8_lossy(&answer).into_owned()
}

// An upgrade at `path` on `port` with `upgrade` as its protocol, `extra` header lines added; its answer's head and the
// open stream.
async fn upgrade(
    port: u16,
    host: &str,
    path: &str,
    upgrade: &str,
    extra: &str,
) -> (String, TcpStream) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}Connection: Upgrade\r\nUpgrade: {upgrade}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let answer = tokio::time::timeout(PATIENCE, head_of(&mut stream))
        .await
        .expect("an answer");
    (answer, stream)
}

fn own_host() -> String {
    format!("sandbox-{SANDBOX_ID}.sbx.test")
}

// One request written as it stands, its whole answer read back.
async fn raw(port: u16, head: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    let _ = tokio::time::timeout(PATIENCE, stream.read_to_end(&mut answer)).await;
    String::from_utf8_lossy(&answer).into_owned()
}

async fn echoed(stream: &mut TcpStream, sent: &[u8]) {
    stream.write_all(sent).await.unwrap();
    let mut answer = vec![0_u8; sent.len()];
    tokio::time::timeout(PATIENCE, stream.read_exact(&mut answer))
        .await
        .expect("the far side answers")
        .unwrap();
    assert_eq!(answer, sent);
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.split("\r\n").find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

// Dials the parent's runner uplink as a runner would, with `token` and `named`: the status it was refused with.
async fn dial_status(port: u16, token: &str, named: &str) -> Result<(), u16> {
    let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut request = format!("ws://127.0.0.1:{port}{RUNNER_UPLINK_PATH}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    request
        .headers_mut()
        .insert(RUNNER_HEADER, named.parse().unwrap());
    match tokio_tungstenite::client_async_with_config(
        request,
        stream,
        Some(tunnel::socket_config()),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(SocketError::Http(response)) => Err(response.status().as_u16()),
        Err(error) => panic!("the dial failed: {error}"),
    }
}

// A dev server on the runner's loopback: names the Host and the netd headers it saw, and says no to framing.
async fn dev_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let service = service_fn(|request: Request<Incoming>| async move {
                    let seen = |name: &str| {
                        request
                            .headers()
                            .get(name)
                            .map_or("-".to_owned(), |value| value.to_str().unwrap().to_owned())
                    };
                    let body = format!(
                        "dev saw host={} path={} listener={} port={} forwarded={}",
                        seen("host"),
                        request.uri(),
                        seen("x-intentic-listener"),
                        seen("x-intentic-runner-port"),
                        seen("x-forwarded-host"),
                    );
                    Ok::<_, Infallible>(
                        Response::builder()
                            .header("x-frame-options", "DENY")
                            .body(Full::new(Bytes::from(body)))
                            .unwrap(),
                    )
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    port
}

#[tokio::test]
async fn a_runner_dials_its_parent_and_is_displaced_and_withdrawn() {
    let (parent, parent_ports, first, _) = linked(
        "runners-dial",
        Arc::new(|_: &str, _| support::nothing_here()),
        refusing_terminals(),
    )
    .await;
    // Another copy of the runner takes the slot; the first stands back.
    let (second, _) = started(
        "runners-dial-second",
        Arc::new(|_: &str, _| support::nothing_here()),
        refusing_terminals(),
    )
    .await;
    dial(&second, &parent_ports, "r1", TOKEN).await;
    uplink_is(&second, true, "").await;
    uplink_is(&first, false, "a newer uplink").await;
    runners_are(&parent, &[("r1", true)]).await;
    // The same config again changes nothing: no new report, the uplink stays up.
    let told = second.parent.borrow().0;
    dial(&second, &parent_ports, "r1", TOKEN).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(second.parent.borrow().0, told);
    // A Node saying hello again hears where the uplink stands.
    second.hello().await;
    let mut reports = second.parent.clone();
    tokio::time::timeout(
        PATIENCE,
        reports.wait_for(|(count, up, _)| *count > told && *up),
    )
    .await
    .expect("a hello is told the uplink")
    .unwrap();
    // Withdrawn by the parent's daemon: closed, and redialled only slowly.
    parent
        .send(&FromNode::RunnerWithdraw {
            runner: "r1".into(),
        })
        .await;
    uplink_is(&second, false, "withdrew").await;
    runners_are(&parent, &[]).await;
    assert_eq!(
        dial_status(parent_ports.daemon, TOKEN, "r1").await,
        Err(401)
    );
    // Told to stop, the runner reports nothing held.
    second.send(&FromNode::ParentUplink { uplink: None }).await;
    uplink_is(&second, false, "").await;
}

#[tokio::test]
async fn only_a_runners_own_token_opens_its_uplink() {
    let (parent, parent_ports) = started(
        "runners-tokens-parent",
        Arc::new(|_: &str, _| support::nothing_here()),
        refusing_terminals(),
    )
    .await;
    register(&parent, "r1", TOKEN).await;
    parent
        .send(&FromNode::DeviceUplink {
            device: "rog".into(),
            token_sha256: sha256_hex("device-token"),
        })
        .await;
    runners_are(&parent, &[("r1", false)]).await;
    // A device's token is nothing to the runners' registry, and a runner's token nothing to the devices'.
    assert_eq!(
        dial_status(parent_ports.daemon, "device-token", "rog").await,
        Err(401)
    );
    assert_eq!(
        dial_status(parent_ports.daemon, "guessed", "r1").await,
        Err(401)
    );
    assert_eq!(
        dial_status(parent_ports.daemon, TOKEN, "r2").await,
        Err(403)
    );
    let answer = raw(
        parent_ports.daemon,
        &format!("GET {RUNNER_UPLINK_PATH} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 426"), "{answer}");
    // A runner netd holding a device's token is refused, and says so.
    let (runner, _) = started(
        "runners-tokens-runner",
        Arc::new(|_: &str, _| support::nothing_here()),
        refusing_terminals(),
    )
    .await;
    dial(&runner, &parent_ports, "rog", "device-token").await;
    uplink_is(&runner, false, "401").await;
    runners_are(&parent, &[("r1", false)]).await;
}

#[tokio::test]
async fn a_parent_older_than_the_uplink_is_stood_back_from() {
    // An older parent's netd has no such route: its daemon answers 404.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buffer = [0_u8; 2048];
            let _ = stream.read(&mut buffer).await;
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await;
        }
    });
    let (runner, _) = started(
        "runners-older-parent",
        Arc::new(|_: &str, _| support::nothing_here()),
        refusing_terminals(),
    )
    .await;
    runner
        .send(&FromNode::ParentUplink {
            uplink: Some(ParentUplinkConfig {
                url: format!("http://127.0.0.1:{port}"),
                runner: "r1".into(),
                token: TOKEN.into(),
            }),
        })
        .await;
    uplink_is(&runner, false, "predates runner uplinks").await;
}

#[tokio::test]
async fn a_view_reaches_the_runner_only_with_a_ticket_for_it() {
    let planned = Arc::new(Mutex::new(Vec::new()));
    let planning = planned.clone();
    let terminal: Planner = Arc::new(move |query: &str| {
        planning.lock().unwrap().push(query.to_owned());
        (
            TerminalPlan::Exit {
                code: 0,
                reason: "the runner's terminal".into(),
            },
            None,
        )
    });
    let (parent, parent_ports, _runner, _) = linked(
        "runners-view",
        Arc::new(|_: &str, _| support::nothing_here()),
        terminal,
    )
    .await;
    let asked = tickets(&parent, &["t-term", "t-view", "t-r9", "t-reuse"]);
    let host = own_host();

    // The terminal: netd's own on the runner, its ticket gone before the runner's daemon is asked.
    let (answer, _stream) = upgrade(
        parent_ports.daemon,
        &host,
        "/system/runner-view/r1/system/terminal?session=agent-1&ticket=t-term",
        "websocket",
        "",
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 101"), "{answer}");
    assert_eq!(planned.lock().unwrap().as_slice(), ["session=agent-1"]);
    assert_eq!(
        asked.lock().unwrap().as_slice(),
        ["r1 /system/terminal session=agent-1&ticket=t-term"]
    );

    // The browser view: the runner's daemon, which hears it came from the parent, without the parent's credentials.
    let (answer, mut stream) = upgrade(
        parent_ports.preview,
        &host,
        "/system/runner-view/r1/system/browser-view?session=s1&ticket=t-view",
        "echo",
        "Authorization: Bearer member-secret\r\nCookie: session=member-cookie\r\nOrigin: https://app.example.test\r\nx-intentic-listener: loopback\r\n",
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 101"), "{answer}");
    assert_eq!(
        header(&answer, "x-node-saw"),
        Some("/system/browser-view?session=s1")
    );
    assert_eq!(header(&answer, "x-node-listener"), Some("parent"));
    assert_eq!(header(&answer, "x-node-host"), Some("localhost"));
    let heard = header(&answer, "x-node-headers")
        .unwrap_or_default()
        .to_owned();
    for gone in [
        "authorization",
        "cookie",
        "origin",
        "x-intentic-runner-port",
    ] {
        assert!(
            !heard.split(',').any(|name| name == gone),
            "{gone} reached the runner: {heard}"
        );
    }
    echoed(&mut stream, b"frame").await;

    // A ticket is spent by its first use; none, or one for nothing, opens nothing.
    for path in [
        "/system/runner-view/r1/system/browser-view?session=s1&ticket=t-view",
        "/system/runner-view/r1/system/browser-view?session=s1",
        "/system/runner-view/r1/system/desktop-view?ticket=forged",
    ] {
        let (answer, _) = upgrade(parent_ports.daemon, &host, path, "echo", "").await;
        assert!(answer.starts_with("HTTP/1.1 403"), "{path}: {answer}");
    }
    // A ticket for a runner with no uplink: admitted, and still nothing to reach.
    let (answer, _) = upgrade(
        parent_ports.daemon,
        &host,
        "/system/runner-view/r9/system/terminal?session=a&ticket=t-r9",
        "websocket",
        "",
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 502"), "{answer}");
    // Anything off the allowlist, or a name netd cannot use, is netd's own 404 before any ticket is looked at; a plain
    // request is 426.
    let spent = asked.lock().unwrap().len();
    for path in [
        "/system/runner-view/r1/workspace/raw?path=.env&ticket=t-reuse",
        "/system/runner-view/r1/orpc/agents/list?ticket=t-reuse",
        "/system/runner-view/r1/system/terminal/../../orpc?ticket=t-reuse",
        "/system/runner-view/r1/system/vitals?ticket=t-reuse",
        "/system/runner-view/r1/system/device-uplink?ticket=t-reuse",
        "/system/runner-view/r.1/system/terminal?ticket=t-reuse",
        "/system/runner-view/r1?ticket=t-reuse",
    ] {
        let (answer, _) = upgrade(parent_ports.daemon, &host, path, "websocket", "").await;
        assert!(answer.starts_with("HTTP/1.1 404"), "{path}: {answer}");
    }
    let answer = raw(
        parent_ports.daemon,
        &format!("GET /system/runner-view/r1/system/browser-view?session=s1&ticket=t-reuse HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 426"), "{answer}");
    assert_eq!(
        asked.lock().unwrap().len(),
        spent,
        "an allowlist refusal never asked the daemon"
    );
}

#[tokio::test]
async fn a_media_socket_rides_castds_token_and_a_revocation_ends_a_members_views() {
    let (parent, parent_ports, runner, _) = linked(
        "runners-media",
        Arc::new(|_: &str, _| support::nothing_here()),
        refusing_terminals(),
    )
    .await;
    let _asked = tickets(&parent, &["t-view"]);
    let host = own_host();
    // A media socket needs no ticket of the parent's: it reaches the runner's castd socket path (none listens here, so
    // the runner's netd answers its own 502 naming the session).
    let (answer, _) = upgrade(
        parent_ports.daemon,
        &host,
        "/system/runner-view/r1/system/browser-media/desk_1?token=castd-token",
        "websocket",
        "",
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 502"), "{answer}");
    assert!(runner.dir.exists());

    let (answer, mut stream) = upgrade(
        parent_ports.daemon,
        &host,
        "/system/runner-view/r1/system/browser-view?session=s1&ticket=t-view",
        "echo",
        "",
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 101"), "{answer}");
    echoed(&mut stream, b"before").await;
    // Another member's revocation leaves it open.
    parent
        .send(&FromNode::Revoke {
            member: Some("someone-else@example.test".into()),
        })
        .await;
    echoed(&mut stream, b"still").await;
    parent
        .send(&FromNode::Revoke {
            member: Some(MEMBER.into()),
        })
        .await;
    let mut buffer = [0_u8; 16];
    let read = tokio::time::timeout(PATIENCE, stream.read(&mut buffer))
        .await
        .expect("the revoked view ends");
    assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");
}

#[tokio::test]
async fn a_runner_slot_preview_reaches_the_runners_port_through_the_parent() {
    let dev = dev_server().await;
    let route: Router = Arc::new(move |host: &str, _| {
        if host.starts_with("port-s1-") {
            PreviewRoute::Runner {
                runner: "r1".into(),
                port: dev,
                frameable: true,
            }
        } else {
            support::nothing_here()
        }
    });
    let (_parent, parent_ports, _runner, runner_ports) =
        linked("runners-preview", route, refusing_terminals()).await;
    let preview = format!("port-s1-{SANDBOX_ID}.sbx.test");
    let answer = raw(
        parent_ports.preview,
        &format!("GET /app?x=1 HTTP/1.1\r\nHost: {preview}\r\nx-intentic-runner-port: 1\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    assert!(
        answer.ends_with(&format!(
            "dev saw host=localhost:{dev} path=/app?x=1 listener=- port=- forwarded={preview}"
        )),
        "{answer}"
    );
    let lower = answer.to_ascii_lowercase();
    assert!(!lower.contains("x-frame-options"), "{answer}");
    assert!(
        lower.contains("content-security-policy: frame-ancestors 'self' https://app.example.test"),
        "{answer}"
    );
    // A second request rides the cached route.
    let again = raw(
        parent_ports.preview,
        &format!("GET /two HTTP/1.1\r\nHost: {preview}\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(again.contains("path=/two"), "{again}");

    // The port instruction is the parent's word only: sent to the runner directly, on any of its own listeners, it is
    // stripped, and the request goes where it would have gone without it.
    let spoof = format!("x-intentic-runner-port: {dev}\r\nx-intentic-listener: parent\r\n");
    for port in [
        runner_ports.daemon,
        runner_ports.loopback,
        runner_ports.preview,
    ] {
        let answer = raw(
            port,
            &format!("GET /x HTTP/1.1\r\nHost: sandbox-{SANDBOX_ID}.sbx.test\r\n{spoof}Connection: close\r\n\r\n"),
        )
        .await;
        assert!(answer.starts_with("HTTP/1.1 200"), "{port}: {answer}");
        assert!(!answer.contains("dev saw"), "{port}: {answer}");
        assert!(answer.contains("node saw"), "{port}: {answer}");
    }
    // And Node never hears a stranger's `parent`: the daemon's own port says nothing, the loopback port its own word.
    for (port, said) in [
        (runner_ports.daemon, "-"),
        (runner_ports.loopback, "loopback"),
        (runner_ports.preview, "-"),
    ] {
        let (answer, _) = upgrade(port, &own_host(), "/ws", "echo", &spoof).await;
        assert!(answer.starts_with("HTTP/1.1 101"), "{answer}");
        assert_eq!(
            header(&answer, "x-node-listener"),
            Some(said),
            "{port}: {answer}"
        );
        let heard = header(&answer, "x-node-headers").unwrap_or_default();
        assert!(!heard.contains("x-intentic-runner-port"), "{heard}");
    }
}

// A Node that routes `port-p<port>-…` to that port: each case a host of its own, so no cached route answers another.
fn aimed_router(runner: bool) -> Router {
    Arc::new(move |host: &str, _| {
        let Some(port) = host
            .strip_prefix("port-p")
            .and_then(|rest| rest.split('-').next())
            .and_then(|port| port.parse::<u16>().ok())
        else {
            return support::nothing_here();
        };
        if runner {
            PreviewRoute::Runner {
                runner: "r1".into(),
                port,
                frameable: true,
            }
        } else {
            PreviewRoute::Upstream {
                upstream: Upstream {
                    host: if port % 2 == 0 {
                        "127.0.0.1"
                    } else {
                        "localhost"
                    }
                    .into(),
                    port,
                    scheme: Scheme::Http,
                    localhost: true,
                    frameable: true,
                },
            }
        }
    })
}

async fn preview_answer(port: u16, aimed: u16) -> String {
    raw(
        port,
        &format!("GET / HTTP/1.1\r\nHost: port-p{aimed}-{SANDBOX_ID}.sbx.test\r\nConnection: close\r\n\r\n"),
    )
    .await
}

#[tokio::test]
async fn a_runner_slot_aimed_at_the_runners_own_listeners_is_refused() {
    let (_parent, parent_ports, _runner, runner_ports) =
        linked("runners-own-port", aimed_router(true), refusing_terminals()).await;
    // The loopback port above all: there the runner's daemon would answer as the machine's own, unauthenticated.
    for own in [
        runner_ports.loopback,
        runner_ports.daemon,
        runner_ports.preview,
    ] {
        let answer = preview_answer(parent_ports.preview, own).await;
        assert!(answer.starts_with("HTTP/1.1 403"), "{own}: {answer}");
        assert!(
            answer.ends_with("a preview never reaches one of this sandbox's own listeners"),
            "{own}: {answer}"
        );
    }
    // A dev server's port still goes through.
    let answer = preview_answer(parent_ports.preview, dev_server().await).await;
    assert!(answer.contains("dev saw"), "{answer}");
}

#[tokio::test]
async fn a_local_preview_upstream_on_netds_own_listener_is_refused() {
    let (_parent, ports) = started(
        "runners-own-upstream",
        aimed_router(false),
        refusing_terminals(),
    )
    .await;
    for own in [ports.loopback, ports.daemon, ports.preview] {
        let answer = preview_answer(ports.preview, own).await;
        assert!(answer.starts_with("HTTP/1.1 403"), "{own}: {answer}");
        assert!(
            answer.ends_with("a preview never reaches one of this sandbox's own listeners"),
            "{own}: {answer}"
        );
    }
    let answer = preview_answer(ports.preview, dev_server().await).await;
    assert!(answer.contains("dev saw"), "{answer}");
}
