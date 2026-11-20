//! A connected computer's uplink on the real binary: a fake `intentic-remoted` dials it as the real one does (a
//! WebSocket carrying yamux, accepting the streams netd opens and serving each as HTTP/1.1), and a person's viewer and
//! the daemon's socket reach it through netd.

mod support;

use std::convert::Infallible;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use browser_wire::{DEVICE_HEADER, DEVICE_UPLINK_PATH};
use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use netd_wire::{DeviceUplinkState, Endpoint, FromNode, ListenConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Error as SocketError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tunnel::{Ended, Liveness, Pumping, mux};

use support::{Harness, SANDBOX_ID, bound, free_port};

const PATIENCE: Duration = Duration::from_secs(10);

struct Ports {
    daemon: u16,
    loopback: u16,
    preview: u16,
}

async fn started(name: &str) -> (Harness, Ports) {
    let harness = Harness::start(name, Arc::new(|_: &str, _| support::nothing_here())).await;
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
                frame_ancestors: Vec::new(),
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

async fn register(harness: &Harness, device: &str, token: &str) {
    harness
        .send(&FromNode::DeviceUplink {
            device: device.into(),
            token_sha256: sha256_hex(token),
        })
        .await;
}

// Lowercase hex SHA-256 of the token's UTF-8 bytes, as Node registers it.
fn sha256_hex(token: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, token.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// What the fake remoted saw: each upgrade's head, as it arrived.
struct Remoted {
    seen: mpsc::UnboundedReceiver<String>,
    pumping: Pumping,
    _closing: watch::Sender<Option<tunnel::Close>>,
}

/// Dials netd's uplink as remoted does; the status netd refused the upgrade with, if it did.
async fn remoted(
    port: u16,
    token: &str,
    device: Option<&str>,
    name: &'static str,
) -> Result<Remoted, u16> {
    let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut request = format!("ws://127.0.0.1:{port}{DEVICE_UPLINK_PATH}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    if let Some(device) = device {
        request
            .headers_mut()
            .insert(DEVICE_HEADER, device.parse().unwrap());
    }
    let socket = match tokio_tungstenite::client_async_with_config(
        request,
        stream,
        Some(tunnel::socket_config()),
    )
    .await
    {
        Ok((socket, _)) => socket,
        Err(SocketError::Http(response)) => return Err(response.status().as_u16()),
        Err(error) => panic!("the uplink's dial failed: {error}"),
    };
    let (closing, closed) = watch::channel(None);
    let (session, pumping) = tunnel::pump(socket, Liveness::Listens, closed);
    let (mut arrivals, _driving) = mux::server(session);
    let (seen_sender, seen) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let _driving = _driving;
        while let Some(stream) = arrivals.recv().await {
            let seen = seen_sender.clone();
            tokio::spawn(serve(stream, seen, name));
        }
    });
    Ok(Remoted {
        seen,
        pumping,
        _closing: closing,
    })
}

// One stream as remoted serves it: `/health` names this remoted, and an upgrade at `/media/…` or `/terminal/…` is
// answered 101 and echoed back behind this remoted's name.
async fn serve(stream: mux::Stream, seen: mpsc::UnboundedSender<String>, name: &'static str) {
    let service = service_fn(move |mut request: Request<Incoming>| {
        let seen = seen.clone();
        async move {
            let path = request.uri().path().to_owned();
            if path == "/health" {
                return Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(format!(
                    "remoted {name}"
                )))));
            }
            let mut head = format!(
                "{} {} {:?}\r\n",
                request.method(),
                request.uri(),
                request.version()
            );
            for (header, value) in request.headers() {
                head.push_str(&format!("{header}: {}\r\n", value.to_str().unwrap_or("?")));
            }
            let _ = seen.send(head);
            let upgrading = hyper::upgrade::on(&mut request);
            tokio::spawn(async move {
                let Ok(upgraded) = upgrading.await else {
                    return;
                };
                let mut upgraded = TokioIo::new(upgraded);
                let mut buffer = [0_u8; 1024];
                while let Ok(read @ 1..) = upgraded.read(&mut buffer).await {
                    let answer = [name.as_bytes(), b":", &buffer[..read]].concat();
                    if upgraded.write_all(&answer).await.is_err() {
                        return;
                    }
                }
            });
            Ok(Response::builder()
                .status(StatusCode::SWITCHING_PROTOCOLS)
                .header("connection", "upgrade")
                .header("upgrade", "websocket")
                .body(Full::new(Bytes::new()))
                .unwrap())
        }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades()
        .await;
}

async fn connected(harness: &Harness, wanted: &[(&str, bool)]) {
    let wanted: Vec<DeviceUplinkState> = wanted
        .iter()
        .map(|(device, connected)| DeviceUplinkState {
            device: (*device).into(),
            connected: *connected,
        })
        .collect();
    let mut devices = harness.devices.clone();
    tokio::time::timeout(PATIENCE, devices.wait_for(|(_, held)| *held == wanted))
        .await
        .unwrap_or_else(|_| {
            panic!(
                "netd never reported {wanted:?}: {:?}",
                harness.devices.borrow()
            )
        })
        .unwrap();
}

async fn head_of(stream: &mut TcpStream) -> String {
    let mut answer = Vec::new();
    let mut byte = [0_u8; 1];
    while !answer.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        answer.push(byte[0]);
    }
    String::from_utf8_lossy(&answer).into_owned()
}

// A viewer's upgrade at `path` on `port`, its answer's head and the open stream.
async fn view(port: u16, path: &str, extra: &str) -> (String, TcpStream) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!(
        "GET {path} HTTP/1.1\r\nHost: sandbox-{SANDBOX_ID}.sbx.test\r\n{extra}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    (head_of(&mut stream).await, stream)
}

// One request written as it stands, its whole answer read back.
async fn raw(port: u16, head: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    let _ = tokio::time::timeout(PATIENCE, stream.read_to_end(&mut answer)).await;
    String::from_utf8_lossy(&answer).into_owned()
}

async fn echoed(stream: &mut TcpStream, sent: &[u8], expected: &[u8]) {
    stream.write_all(sent).await.unwrap();
    let mut answer = vec![0_u8; expected.len()];
    tokio::time::timeout(PATIENCE, stream.read_exact(&mut answer))
        .await
        .expect("the far side answers")
        .unwrap();
    assert_eq!(answer, expected);
}

async fn ended(remoted: &mut Remoted) -> Ended {
    tokio::time::timeout(PATIENCE, remoted.pumping.ended())
        .await
        .expect("netd ends the uplink")
}

#[tokio::test]
async fn an_uplink_is_taken_only_for_a_token_registered_for_its_device() {
    let (harness, ports) = started("devices-refused").await;
    // Nothing registered: no token opens anything.
    assert_eq!(
        remoted(ports.daemon, "rog-token", Some("rog"), "a")
            .await
            .err(),
        Some(401)
    );
    register(&harness, "rog", "rog-token").await;
    connected(&harness, &[("rog", false)]).await;
    assert_eq!(
        remoted(ports.daemon, "guessed", Some("rog"), "a")
            .await
            .err(),
        Some(401)
    );
    // The token decides, and a header naming another device than the token's is refused.
    assert_eq!(
        remoted(ports.daemon, "rog-token", Some("omen"), "a")
            .await
            .err(),
        Some(403)
    );
    // Only an upgrade.
    let answer = raw(
        ports.daemon,
        &format!("GET {DEVICE_UPLINK_PATH} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer rog-token\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 426"), "{answer}");
    // A remoted that names no device is admitted by its token alone.
    let _uplink = remoted(ports.daemon, "rog-token", None, "a")
        .await
        .expect("the token opens it");
    connected(&harness, &[("rog", true)]).await;
}

#[tokio::test]
async fn a_viewer_is_spliced_down_the_uplink_both_ways() {
    let (harness, ports) = started("devices-view").await;
    register(&harness, "rog", "rog-token").await;
    let mut uplink = remoted(ports.loopback, "rog-token", Some("rog"), "rog")
        .await
        .expect("the uplink is taken");
    connected(&harness, &[("rog", true)]).await;

    // A screen from the daemon's port, its path rewritten to remoted's and its token kept, never said to be local even
    // when the viewer claims it.
    let spoof = format!(
        "{}: {}\r\n",
        browser_wire::MEDIA_LISTENER_HEADER,
        browser_wire::MEDIA_LOOPBACK
    );
    let (answer, mut stream) = view(
        ports.daemon,
        "/system/device-media/rog/screen-0?token=a.b",
        &spoof,
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 101"), "{answer}");
    let seen = uplink.seen.recv().await.unwrap();
    assert!(
        seen.starts_with("GET /media/screen-0?token=a.b HTTP/1.1\r\n"),
        "{seen}"
    );
    assert!(
        !seen.to_ascii_lowercase().contains("x-intentic-listener"),
        "{seen}"
    );
    echoed(&mut stream, b"frame", b"rog:frame").await;

    // A terminal from the loopback port, which remoted is told is this computer's.
    let (answer, mut stream) = view(
        ports.loopback,
        "/system/device-terminal/rog/t-Abc?token=t.k&deflate=1",
        "",
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 101"), "{answer}");
    let seen = uplink.seen.recv().await.unwrap();
    assert!(
        seen.starts_with("GET /terminal/t-Abc?token=t.k&deflate=1 HTTP/1.1\r\n"),
        "{seen}"
    );
    assert_eq!(
        seen.to_ascii_lowercase()
            .matches("x-intentic-listener: loopback")
            .count(),
        1,
        "{seen}"
    );
    echoed(&mut stream, b"ls\r", b"rog:ls\r").await;

    // The daemon's host on the preview port, where the tunnel's streams are routed alike.
    let (answer, mut stream) = view(
        ports.preview,
        "/system/device-media/rog/screen-1?token=x",
        "",
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 101"), "{answer}");
    let seen = uplink.seen.recv().await.unwrap();
    assert!(
        seen.starts_with("GET /media/screen-1?token=x HTTP/1.1\r\n"),
        "{seen}"
    );
    echoed(&mut stream, b"k", b"rog:k").await;

    // A Node that says hello again hears the uplinks whole.
    let told = harness.devices.borrow().0;
    harness.hello().await;
    let mut devices = harness.devices.clone();
    tokio::time::timeout(PATIENCE, devices.wait_for(|(count, _)| *count > told))
        .await
        .expect("a hello is told the uplinks")
        .unwrap();
    assert_eq!(
        harness.devices.borrow().1,
        [DeviceUplinkState {
            device: "rog".into(),
            connected: true
        }]
    );
}

#[tokio::test]
async fn a_newer_uplink_replaces_the_one_before_it() {
    let (harness, ports) = started("devices-replace").await;
    register(&harness, "rog", "rog-token").await;
    let mut first = remoted(ports.daemon, "rog-token", Some("rog"), "first")
        .await
        .expect("taken");
    connected(&harness, &[("rog", true)]).await;
    let mut second = remoted(ports.daemon, "rog-token", Some("rog"), "second")
        .await
        .expect("taken");
    assert_eq!(
        ended(&mut first).await,
        Ended::Closed(Some(browser_wire::DEVICE_UPLINK_DISPLACED))
    );
    let (answer, mut stream) =
        view(ports.daemon, "/system/device-terminal/rog/t-1?token=x", "").await;
    assert!(answer.starts_with("HTTP/1.1 101"), "{answer}");
    assert!(
        second
            .seen
            .recv()
            .await
            .unwrap()
            .starts_with("GET /terminal/t-1?token=x ")
    );
    echoed(&mut stream, b"hi", b"second:hi").await;
    connected(&harness, &[("rog", true)]).await;
}

#[tokio::test]
async fn a_withdrawn_device_is_dropped_and_refused() {
    let (harness, ports) = started("devices-withdraw").await;
    register(&harness, "rog", "rog-token").await;
    let mut uplink = remoted(ports.daemon, "rog-token", Some("rog"), "rog")
        .await
        .expect("taken");
    connected(&harness, &[("rog", true)]).await;
    let socket = harness.dir.join("devices/rog.sock");
    assert!(socket.exists());
    harness
        .send(&FromNode::DeviceWithdraw {
            device: "rog".into(),
        })
        .await;
    assert_eq!(
        ended(&mut uplink).await,
        Ended::Closed(Some(browser_wire::DEVICE_UPLINK_WITHDRAWN))
    );
    connected(&harness, &[]).await;
    assert!(!socket.exists());
    let answer = raw(
        ports.daemon,
        &format!(
            "GET /system/device-media/rog/screen-0 HTTP/1.1\r\nHost: sandbox-{SANDBOX_ID}.sbx.test\r\nConnection: Upgrade, close\r\nUpgrade: websocket\r\n\r\n"
        ),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 502"), "{answer}");
    assert_eq!(
        remoted(ports.daemon, "rog-token", Some("rog"), "rog")
            .await
            .err(),
        Some(401)
    );
}

#[tokio::test]
async fn a_device_without_an_uplink_or_named_wrongly_is_answered_by_netd() {
    let (harness, ports) = started("devices-missing").await;
    register(&harness, "rog", "rog-token").await;
    connected(&harness, &[("rog", false)]).await;
    let upgrade = "Connection: Upgrade, close\r\nUpgrade: websocket\r\n";
    let own = format!("sandbox-{SANDBOX_ID}.sbx.test");
    // Registered and not dialled, and never registered: netd's own 502, naming the device.
    for device in ["rog", "omen"] {
        let answer = raw(
            ports.daemon,
            &format!("GET /system/device-media/{device}/screen-0 HTTP/1.1\r\nHost: {own}\r\n{upgrade}\r\n"),
        )
        .await;
        assert!(answer.starts_with("HTTP/1.1 502"), "{answer}");
        assert!(
            answer.ends_with(&format!(
                "the device {device} has no uplink: its remote access is not running"
            )),
            "{answer}"
        );
    }
    // A name that could leave a directory or a path never goes further.
    for path in [
        "/system/device-media/rog",
        "/system/device-terminal/../t-1",
        "/system/device-terminal/rog/a.b",
    ] {
        let answer = raw(
            ports.daemon,
            &format!("GET {path} HTTP/1.1\r\nHost: {own}\r\n{upgrade}\r\n"),
        )
        .await;
        assert!(answer.starts_with("HTTP/1.1 404"), "{path}: {answer}");
    }
    let answer = raw(
        ports.daemon,
        &format!("GET /system/device-media/rog/screen-0 HTTP/1.1\r\nHost: {own}\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(answer.starts_with("HTTP/1.1 426"), "{answer}");
}

#[tokio::test]
async fn the_daemon_reaches_remoted_on_the_devices_socket() {
    let (harness, ports) = started("devices-socket").await;
    register(&harness, "rog", "rog-token").await;
    let _uplink = remoted(ports.daemon, "rog-token", Some("rog"), "rog")
        .await
        .expect("taken");
    connected(&harness, &[("rog", true)]).await;
    let socket = harness.dir.join("devices/rog.sock");
    assert_eq!(
        std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // Two calls on two connections, each a stream of its own down the one uplink.
    for _ in 0..2 {
        let stream = UnixStream::connect(&socket).await.unwrap();
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        tokio::spawn(connection);
        let answer = sender
            .send_request(
                Request::get("/health")
                    .header("host", "remoted")
                    .body(Empty::<Bytes>::new())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::OK);
        let body = answer.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"remoted rog");
    }
}
