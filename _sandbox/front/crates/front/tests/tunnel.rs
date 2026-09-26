//! The tunnel against a stand-in edge speaking what `_platform/ingress` speaks at `/tunnel/v2`: the grant on the
//! WebSocket's upgrade, then yamux over its binary frames, the edge opening a stream per exchange and every stream one
//! HTTP/1.1 connection, where an upgrade (a terminal's included) is itself.

mod support;

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use front_wire::{Endpoint, FromNode, ListenConfig, TunnelConfig};
use futures_util::StreamExt;
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper::client::conn::http1::SendRequest;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request as Upgrade, Response as Upgraded,
};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tunnel::{Liveness, mux};

use support::{Harness, SANDBOX_ID, bound, free_port};

const GRANT: &str = "ig1.test-grant";

// One dial as the edge saw it: the path, grant, lane and transfer routes its upgrade presented, and the session to open
// streams on.
struct Dial {
    path: String,
    grant: String,
    lane: String,
    bulk: String,
    opener: mux::Opener,
}

// Accepts the front's dials as the edge does: the socket pumped without pinging, yamux run as the side that opens.
// The handshake callback's signature, large error included, is tungstenite's to fix.
#[allow(clippy::result_large_err)]
async fn edge() -> (u16, tokio::sync::mpsc::UnboundedReceiver<Dial>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (accepted, arrivals) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let accepted = accepted.clone();
            tokio::spawn(async move {
                let heard = Arc::new(Mutex::new(Vec::new()));
                let seen = heard.clone();
                let socket = tokio_tungstenite::accept_hdr_async(
                    stream,
                    move |request: &Upgrade,
                          response: Upgraded|
                          -> Result<Upgraded, ErrorResponse> {
                        let header = |name: &str| {
                            request
                                .headers()
                                .get(name)
                                .map(|value| value.to_str().unwrap().to_owned())
                                .unwrap_or_default()
                        };
                        *seen.lock().unwrap() = vec![
                            request.uri().path().to_owned(),
                            header("x-intentic-grant"),
                            header("x-intentic-lane"),
                            header("x-intentic-bulk"),
                        ];
                        Ok(response)
                    },
                )
                .await
                .unwrap();
                let (closing, closed) = watch::channel(None);
                let (session, mut pumping) = tunnel::pump(socket, Liveness::Listens, closed);
                let (opener, _driving) = mux::client(session);
                let heard = heard.lock().unwrap().clone();
                let [path, grant, lane, bulk] = <[String; 4]>::try_from(heard).unwrap();
                let _ = accepted.send(Dial {
                    path,
                    grant,
                    lane,
                    bulk,
                    opener,
                });
                let _held = closing;
                pumping.ended().await;
            });
        }
    });
    (port, arrivals)
}

// A stream the edge opened, as an HTTP/1.1 client connection.
async fn exchange(opener: &mux::Opener) -> SendRequest<Empty<Bytes>> {
    let stream = opener.open().await.unwrap();
    let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection.with_upgrades());
    sender
}

#[tokio::test]
async fn the_edge_reaches_node_and_upgrades_through_the_tunnel() {
    let harness = Harness::start("tunnel", Arc::new(|_: &str, _| support::nothing_here())).await;
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
    let (edge_port, mut arrivals) = edge().await;
    // An older daemon names the legacy door; the front dials the one it speaks.
    harness
        .send(&FromNode::Tunnel {
            tunnel: Some(TunnelConfig {
                url: format!("ws://127.0.0.1:{edge_port}/tunnel/v1"),
                grant: GRANT.into(),
                bulk: vec![
                    "GET /workspace/media".into(),
                    "POST /extensions/{id}/bundle".into(),
                ],
            }),
        })
        .await;
    harness.hello().await;
    bound(daemon).await;

    // Two sockets, each naming its lane and announcing the daemon's transfers, on the door this front speaks.
    let mut dials = vec![
        arrivals.recv().await.unwrap(),
        arrivals.recv().await.unwrap(),
    ];
    dials.sort_by(|a, b| a.lane.cmp(&b.lane));
    let lanes: Vec<(&str, &str, &str, &str)> = dials
        .iter()
        .map(|dial| {
            (
                dial.path.as_str(),
                dial.grant.as_str(),
                dial.lane.as_str(),
                dial.bulk.as_str(),
            )
        })
        .collect();
    let announced = "GET /workspace/media, POST /extensions/{id}/bundle";
    assert_eq!(
        lanes,
        [
            ("/tunnel/v2", GRANT, "bulk", announced),
            ("/tunnel/v2", GRANT, "interactive", announced)
        ]
    );
    let dial = dials.pop().unwrap();
    let mut tunnel = harness.tunnel.clone();
    tunnel
        .wait_for(|connected| *connected == Some(true))
        .await
        .unwrap();
    let own = format!("sandbox-{SANDBOX_ID}.sbx.test");

    // Every exchange a stream of its own, a transfer and a call alike, so nothing is routed by what it is for.
    for path in ["/health", "/workspace/media?path=a.mp4"] {
        let mut sender = exchange(&dial.opener).await;
        let request = Request::builder()
            .uri(path)
            .header("host", own.as_str())
            .body(Empty::<Bytes>::new())
            .unwrap();
        let response = sender.send_request(request).await.unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            String::from_utf8_lossy(&body),
            format!("node saw {own} {path} mark=-")
        );
    }

    let mut sender = exchange(&dial.opener).await;
    let request = Request::builder()
        .uri("/ws")
        .header("host", own.as_str())
        .header("connection", "Upgrade")
        .header("upgrade", "echo")
        .body(Empty::<Bytes>::new())
        .unwrap();
    let mut response = sender.send_request(request).await.unwrap();
    assert_eq!(response.status(), 101);
    let mut echoing = TokioIo::new(hyper::upgrade::on(&mut response).await.unwrap());
    echoing.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    echoing.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");

    // A terminal is the front's own: it asks Node, answers the 101 itself, and speaks the WebSocket on the stream.
    let stream = dial.opener.open().await.unwrap();
    let request = format!("ws://{own}/system/terminal?ticket=t&session=main")
        .into_client_request()
        .unwrap();
    let (mut terminal, _) = tokio_tungstenite::client_async(request, stream)
        .await
        .unwrap();
    let Some(Ok(Message::Close(Some(frame)))) = terminal.next().await else {
        panic!("the harness's Node refuses every terminal");
    };
    assert_eq!(
        (frame.code, frame.reason.as_str()),
        (CloseCode::Policy, "no terminals here")
    );

    // The length-framed upgrade an earlier editor spoke on a WebTransport stream is no terminal at all, refused with no
    // edge verdict, which sends that editor to its WebSocket.
    let mut sender = exchange(&dial.opener).await;
    let request = Request::builder()
        .uri("/system/terminal?ticket=t&session=main")
        .header("host", own.as_str())
        .header("connection", "Upgrade")
        .header("upgrade", "intentic-terminal")
        .body(Empty::<Bytes>::new())
        .unwrap();
    let response = sender.send_request(request).await.unwrap();
    assert_eq!(response.status(), 426);
    assert!(response.headers().get("x-intentic-edge").is_none());
}
