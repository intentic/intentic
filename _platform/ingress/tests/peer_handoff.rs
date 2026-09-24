//! Handing a request to the peer that holds its tunnel, against a real peer: the Host, the body and the answer cross, the
//! hop is marked, an upgrade is spliced, a refusal is relayed, and a peer that is not there is told apart.

mod support;

use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http::header::HeaderMap;
use http::{Method, Request, Response, StatusCode};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use intentic_ingress::body::{self, Body};
use intentic_ingress::cluster::HOP_HEADER;
use intentic_ingress::forward::{ForwardError, Forwarder};
use intentic_ingress::peers::Peer;
use intentic_ingress::serve::{self, Listening};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use support::{send, upgrade};

const HOST: &str = "sandbox-abcdef012345.zone.test";
const BROWSER: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

struct Holder {
    peer: Peer,
    seen: Arc<Mutex<Option<HeaderMap>>>,
    _listening: Listening,
}

// The holding machine: answers with what it was asked, echoes an upgrade, and refuses one for a host it does not hold.
async fn holder() -> Holder {
    let seen = Arc::new(Mutex::new(None));
    let seeing = seen.clone();
    let listening = serve::listen("127.0.0.1:0", move |mut request: Request<Incoming>, _| {
        let seen = seeing.clone();
        async move {
            *seen.lock().unwrap() = Some(request.headers().clone());
            let host = request.headers()["host"].to_str().unwrap().to_owned();
            if request.headers().contains_key("upgrade") {
                if host.starts_with("nobody") {
                    let mut refused = Response::new(body::full("nope"));
                    *refused.status_mut() = StatusCode::BAD_GATEWAY;
                    return refused;
                }
                let upgrading = hyper::upgrade::on(&mut request);
                tokio::spawn(async move {
                    let mut stream = TokioIo::new(upgrading.await.unwrap());
                    let mut buffer = [0_u8; 1024];
                    while let Ok(read) = stream.read(&mut buffer).await {
                        if read == 0 || stream.write_all(&buffer[..read]).await.is_err() {
                            return;
                        }
                    }
                });
                return Response::builder()
                    .status(StatusCode::SWITCHING_PROTOCOLS)
                    .header("upgrade", "echo")
                    .header("connection", "Upgrade")
                    .body(body::empty())
                    .unwrap();
            }
            let path = request.uri().path_and_query().unwrap().to_string();
            let sent = request.into_body().collect().await.unwrap().to_bytes();
            Response::builder()
                .header("x-answered-by", "peer")
                .body(body::full(format!(
                    "served {host}{path} body={}",
                    String::from_utf8_lossy(&sent)
                )))
                .unwrap()
        }
    })
    .await
    .unwrap();
    Holder {
        peer: Peer {
            host: "127.0.0.1".into(),
            port: listening.address.port(),
            internal_port: 0,
        },
        seen,
        _listening: listening,
    }
}

// The machine a request missed on, handing everything to `peer`.
async fn edge(peer: Peer) -> Listening {
    let forwarder = Arc::new(Forwarder::default());
    serve::listen("127.0.0.1:0", move |request: Request<Incoming>, _| {
        let forwarder = forwarder.clone();
        let peer = peer.clone();
        async move {
            let host = request.headers()["host"].to_str().unwrap().to_owned();
            let forwarded = if request.headers().contains_key("upgrade") {
                forwarder
                    .upgrade(&peer, request.map(body::incoming), &host, BROWSER)
                    .await
            } else {
                forwarder
                    .request(&peer, request.map(body::incoming), &host, BROWSER)
                    .await
            };
            forwarded.unwrap_or_else(|_| {
                let mut failed: Response<Body> = Response::new(body::full("edge: peer failed"));
                *failed.status_mut() = StatusCode::BAD_GATEWAY;
                failed
            })
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn the_host_the_body_and_the_answer_cross_and_the_hop_is_marked() {
    let holder = holder().await;
    let edge = edge(holder.peer.clone()).await;
    let answer = send(
        edge.address.port(),
        Method::POST,
        HOST,
        "/api/x?y=1",
        &[],
        Bytes::from_static(b"hello"),
    )
    .await;
    assert_eq!(answer.status, 200);
    assert_eq!(answer.body, format!("served {HOST}/api/x?y=1 body=hello"));
    assert_eq!(answer.headers["x-answered-by"], "peer");
    let seen = holder.seen.lock().unwrap().clone().unwrap();
    assert_eq!(seen[HOP_HEADER], "1");
    assert_eq!(seen["x-forwarded-for"], "127.0.0.1");
}

#[tokio::test]
async fn an_upgrade_is_spliced_through_and_a_refused_one_is_relayed() {
    let holder = holder().await;
    let edge = edge(holder.peer.clone()).await;
    let (head, mut socket) = upgrade(edge.address.port(), HOST, "/ws", "echo").await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    assert!(
        head.to_ascii_lowercase().contains("upgrade: echo"),
        "{head}"
    );
    socket.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    socket.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
    assert_eq!(
        holder.seen.lock().unwrap().clone().unwrap()[HOP_HEADER],
        "1"
    );

    // A peer that turns out not to hold the sandbox answers 502; the browser reads it rather than waiting on a socket.
    let (head, _) = upgrade(
        edge.address.port(),
        "nobody-abcdef012345.zone.test",
        "/ws",
        "echo",
    )
    .await;
    assert!(head.starts_with("HTTP/1.1 502"), "{head}");
}

#[tokio::test]
async fn a_peer_that_is_not_there_is_unreachable_with_nothing_said_to_the_browser() {
    let gone = Peer {
        host: "127.0.0.1".into(),
        port: 1,
        internal_port: 0,
    };
    let forwarder = Forwarder::default();
    let listening = serve::listen("127.0.0.1:0", move |request: Request<Incoming>, _| {
        let forwarder = Forwarder::default();
        let gone = gone.clone();
        async move {
            match forwarder
                .request(&gone, request.map(body::incoming), HOST, BROWSER)
                .await
            {
                Err(ForwardError::Unreachable(_)) => Response::new(body::full("unreachable")),
                Err(ForwardError::Failed(why)) => {
                    Response::new(body::full(format!("failed: {why}")))
                }
                Ok(_) => Response::new(body::full("answered")),
            }
        }
    })
    .await
    .unwrap();
    drop(forwarder);
    let answer = send(
        listening.address.port(),
        Method::GET,
        HOST,
        "/",
        &[],
        Bytes::new(),
    )
    .await;
    assert_eq!(answer.body, "unreachable");
}
