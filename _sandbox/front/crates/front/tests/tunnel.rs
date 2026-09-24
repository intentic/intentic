//! The tunnel against a stand-in edge speaking what `_platform/ingress` speaks: the grant on the WebSocket upgrade,
//! h2 over binary frames, and a WebSocket upgrade carried as a CONNECT whose h1 head rides under `x-ingress-*`.

mod support;

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use front_wire::{Endpoint, FromNode, ListenConfig, PreviewRoute, TunnelConfig};
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Empty};
use hyper::{Method, Request};
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request as Upgrade, Response as Upgraded,
};

use support::{Harness, SANDBOX_ID, bound, free_port};

const GRANT: &str = "ig1.test-grant";

// Accepts the front's dial, keeps the grant it presented, and bridges the socket's binary frames to a byte stream.
// The handshake callback's signature, large error included, is tungstenite's to fix.
#[allow(clippy::result_large_err)]
async fn edge() -> (u16, tokio::sync::oneshot::Receiver<(String, DuplexStream)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (accepted, arrival) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let grant = Arc::new(Mutex::new(String::new()));
        let seen = grant.clone();
        let socket = tokio_tungstenite::accept_hdr_async(
            stream,
            move |request: &Upgrade, response: Upgraded| -> Result<Upgraded, ErrorResponse> {
                *seen.lock().unwrap() = request
                    .headers()
                    .get("x-intentic-grant")
                    .map(|value| value.to_str().unwrap().to_owned())
                    .unwrap_or_default();
                Ok(response)
            },
        )
        .await
        .unwrap();
        let (edge_side, pump_side) = tokio::io::duplex(256 * 1024);
        let (mut from_session, mut into_session) = tokio::io::split(pump_side);
        let (mut sink, mut frames) = socket.split();
        tokio::spawn(async move {
            while let Some(Ok(frame)) = frames.next().await {
                if let Message::Binary(bytes) = frame
                    && into_session.write_all(&bytes).await.is_err()
                {
                    return;
                }
            }
        });
        tokio::spawn(async move {
            let mut buffer = vec![0_u8; 64 * 1024];
            while let Ok(read) = from_session.read(&mut buffer).await {
                if read == 0
                    || sink
                        .send(Message::Binary(Bytes::copy_from_slice(&buffer[..read])))
                        .await
                        .is_err()
                {
                    return;
                }
            }
        });
        let grant = grant.lock().unwrap().clone();
        let _ = accepted.send((grant, edge_side));
    });
    (port, arrival)
}

#[tokio::test]
async fn the_edge_reaches_node_and_upgrades_through_the_tunnel() {
    let harness = Harness::start("tunnel", Arc::new(|_: &str| PreviewRoute::Node)).await;
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
    let (edge_port, arrival) = edge().await;
    harness
        .send(&FromNode::Tunnel {
            tunnel: Some(TunnelConfig {
                url: format!("ws://127.0.0.1:{edge_port}/tunnel/v1"),
                grant: GRANT.into(),
            }),
        })
        .await;
    harness.hello().await;
    bound(daemon).await;

    let (grant, session) = arrival.await.unwrap();
    assert_eq!(grant, GRANT);
    let mut tunnel = harness.tunnel.clone();
    tunnel
        .wait_for(|connected| *connected == Some(true))
        .await
        .unwrap();

    let (mut sender, connection) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(session))
            .await
            .unwrap();
    tokio::spawn(connection);
    let own = format!("sandbox-{SANDBOX_ID}.sbx.test");

    let request = Request::builder()
        .uri(format!("https://{own}/health"))
        .body(Empty::<Bytes>::new())
        .unwrap();
    let response = sender.send_request(request).await.unwrap();
    let body = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert_eq!(body, format!("node saw {own} /health mark=-"));

    let connect = Request::builder()
        .method(Method::CONNECT)
        .uri(format!("{own}:443"))
        .header("x-ingress-method", "GET")
        .header("x-ingress-path", "/ws")
        .header("x-ingress-h-host", own.as_str())
        .header("x-ingress-h-connection", "Upgrade")
        .header("x-ingress-h-upgrade", "echo")
        .body(Empty::<Bytes>::new())
        .unwrap();
    let mut response = sender.send_request(connect).await.unwrap();
    assert_eq!(response.status(), 200);
    let mut stream = TokioIo::new(hyper::upgrade::on(&mut response).await.unwrap());
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    let head = String::from_utf8(head).unwrap();
    assert!(
        head.starts_with("HTTP/1.1 101 Switching Protocols\r\n"),
        "{head}"
    );
    assert!(head.contains("upgrade: echo\r\n"), "{head}");
    stream.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    stream.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
}
