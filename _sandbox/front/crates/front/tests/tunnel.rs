//! The tunnel against a stand-in edge speaking what `_platform/ingress` speaks at `/tunnel/v2`: the grant on the
//! WebSocket's upgrade, then yamux over its binary frames, the edge opening a stream per exchange and every stream one
//! HTTP/1.1 connection, where an upgrade (a terminal's included) is itself.

mod support;

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use front_wire::{Endpoint, FromNode, ListenConfig, ToNode, TunnelConfig};
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
    instance: String,
    host: String,
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
                            header("x-intentic-instance"),
                            header("x-intentic-host"),
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
                let [path, grant, lane, bulk, instance, host] =
                    <[String; 6]>::try_from(heard).unwrap();
                let _ = accepted.send(Dial {
                    path,
                    grant,
                    lane,
                    bulk,
                    instance,
                    host,
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
    // Both sockets present this front's one instance, so the edge can tell it from another copy of the sandbox.
    assert_eq!(dials[0].instance, dials[1].instance);
    assert_eq!(dials[0].instance.len(), 16, "{}", dials[0].instance);
    assert_eq!(dials[0].host, dials[1].host);
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

// A stand-in edge that answers every upgrade as `answer` says, counting the dials it heard.
#[allow(clippy::result_large_err)]
async fn refusing_edge(
    answer: fn(&Upgrade) -> Result<(), ErrorResponse>,
    then_close: Option<(u16, &'static str)>,
) -> (u16, Arc<Mutex<Vec<(String, String, String)>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let dials = Arc::new(Mutex::new(Vec::new()));
    let heard = dials.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let heard = heard.clone();
            tokio::spawn(async move {
                let accepted = tokio_tungstenite::accept_hdr_async(
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
                        heard.lock().unwrap().push((
                            header("x-intentic-lane"),
                            header("x-intentic-instance"),
                            header("x-intentic-host"),
                        ));
                        answer(request).map(|()| response)
                    },
                )
                .await;
                let Ok(mut socket) = accepted else {
                    return;
                };
                if let Some((code, reason)) = then_close {
                    use futures_util::SinkExt;
                    let frame = tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: code.into(),
                        reason: reason.into(),
                    };
                    let _ = socket.send(Message::Close(Some(frame))).await;
                }
                while socket.next().await.is_some() {}
            });
        }
    });
    (port, dials)
}

async fn dialling(harness: &Harness, port: u16) {
    harness
        .send(&FromNode::Tunnel {
            tunnel: Some(TunnelConfig {
                url: format!("ws://127.0.0.1:{port}/tunnel/v2"),
                grant: GRANT.into(),
                bulk: vec![],
            }),
        })
        .await;
    harness.hello().await;
}

// The edge refuses a second copy of a sandbox with 409, naming where the copy holding it runs: the front says so to Node
// and stands back a minute or more instead of redialling at once, so two copies stop trading the tunnel.
// tungstenite's handshake callback answers its own error type, whatever its size.
#[allow(clippy::result_large_err)]
#[tokio::test]
async fn a_front_another_copy_holds_out_stands_back_and_tells_node_where_it_runs() {
    let harness = Harness::launch(
        "tunnel-elsewhere",
        Arc::new(|_: &str, _| support::nothing_here()),
        Arc::new(|_: &str| {
            (
                front_wire::TerminalPlan::Refused {
                    code: 1008,
                    reason: "no terminals here".into(),
                },
                None,
            )
        }),
        None,
        &[
            ("HOST_LABEL", "rog"),
            ("HOST_PLATFORM", "linux"),
            ("HOST_ENV", "Ubuntu"),
        ],
    )
    .await;
    let (port, dials) = refusing_edge(
        |_| {
            let mut refused = ErrorResponse::new(Some("held by another copy".into()));
            *refused.status_mut() = http::StatusCode::CONFLICT;
            refused
                .headers_mut()
                .insert("x-intentic-holder", "omen (windows)".parse().unwrap());
            Err(refused)
        },
        None,
    )
    .await;
    dialling(&harness, port).await;
    let mut reports = harness.reports.clone();
    let told = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        reports.wait_for(|told| {
            told.iter().any(|report| {
                matches!(report, ToNode::Tunnel { connected: false, reason: Some(reason), .. }
                    if reason.contains("omen (windows)"))
            })
        }),
    )
    .await
    .expect("Node hears why")
    .unwrap()
    .clone();
    // One refusal is not yet a copy that stays: Node is told why, not that it should say so to its owner.
    assert!(told.iter().all(|report| !matches!(
        report,
        ToNode::Tunnel {
            refused: Some(_),
            ..
        }
    )));
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let dials = dials.lock().unwrap().clone();
    assert_eq!(
        dials.len(),
        2,
        "one dial per socket, then standing back: {dials:?}"
    );
    for (_, instance, host) in &dials {
        assert_eq!(instance.len(), 16);
        assert_eq!(host, "rog (linux, Ubuntu)");
    }
}

// The edge closes a held tunnel with the deleted code once the platform recorded the sandbox's deletion: the front stops
// dialling, and tells Node.
#[allow(clippy::result_large_err)]
#[tokio::test]
async fn a_tunnel_closed_for_a_deleted_sandbox_is_not_redialled() {
    let harness = Harness::start(
        "tunnel-deleted",
        Arc::new(|_: &str, _| support::nothing_here()),
    )
    .await;
    let (port, dials) = refusing_edge(|_| Ok(()), Some((tunnel::DELETED_CODE, "deleted"))).await;
    dialling(&harness, port).await;
    let mut reports = harness.reports.clone();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        reports.wait_for(|told| {
            told.iter().any(|report| {
                matches!(
                    report,
                    ToNode::Tunnel {
                        connected: false,
                        refused: Some(front_wire::TunnelRefusal::Deleted),
                        ..
                    }
                )
            })
        }),
    )
    .await
    .expect("Node hears the sandbox is deleted")
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    assert_eq!(dials.lock().unwrap().len(), 2, "never redialled");
}
