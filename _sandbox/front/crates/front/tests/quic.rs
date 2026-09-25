//! The tunnel over QUIC against a stand-in edge: the front dials it only once the edge's answer to a lane declares it,
//! presents its grant in the hello, and serves every stream the edge opens as one HTTP/1.1 exchange, an upgrade included.

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use front_wire::{Endpoint as Listen, FromNode, ListenConfig, PreviewRoute, TunnelConfig};
use futures_util::StreamExt;
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper_util::rt::TokioIo;
use quinn::crypto::rustls::QuicServerConfig;
use quinn::{Endpoint, ServerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::handshake::server::{
    Request as Upgrade, Response as Switching,
};
use tunnel::quic::Hello;
use tunnel::{TRANSPORTS_HEADER, Transport};

use support::{Harness, SANDBOX_ID, bound, free_port};

const GRANT: &str = "ig1.quic-test-grant";

// An edge on 127.0.0.1 with a certificate the front is told to trust: its QUIC door on a UDP port, and its WebSocket lanes
// on the same port over TCP, answering each lane's upgrade with `declares` as the edge's declaration.
struct StandIn {
    quic: Endpoint,
    harness: Harness,
    dir: PathBuf,
}

impl StandIn {
    // tungstenite's handshake callback answers its own error type, whatever its size.
    #[allow(clippy::result_large_err)]
    async fn start(name: &str, declares: Option<String>) -> Self {
        let issued = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_owned()]).unwrap();
        let dir = std::env::temp_dir().join(format!("front-{name}-ca-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ca = dir.join("ca.pem");
        std::fs::write(&ca, issued.cert.pem()).unwrap();
        let tls = || {
            rustls::ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![issued.cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(issued.signing_key.serialize_der().into()),
            )
            .unwrap()
        };
        let mut quic_tls = tls();
        quic_tls.alpn_protocols = vec![tunnel::quic::ALPN.to_vec()];
        let server =
            ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(quic_tls).unwrap()));
        // One port number for both, as the edge's TLS door and its QUIC door share one; a random UDP port whose TCP twin
        // something else holds is simply drawn again.
        let (quic, lanes) = loop {
            let mut server = server.clone();
            server.transport_config(tunnel::quic::transport());
            let quic = Endpoint::server(server, "127.0.0.1:0".parse().unwrap()).unwrap();
            let port = quic.local_addr().unwrap().port();
            if let Ok(lanes) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                break (quic, lanes);
            }
        };
        let port = quic.local_addr().unwrap().port();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls()));
        tokio::spawn(async move {
            while let Ok((tcp, _)) = lanes.accept().await {
                let acceptor = acceptor.clone();
                let declares = declares.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let answered = tokio_tungstenite::accept_hdr_async(
                        tls,
                        |_: &Upgrade, mut switching: Switching| {
                            if let Some(declares) = &declares {
                                switching
                                    .headers_mut()
                                    .insert(TRANSPORTS_HEADER, declares.parse().unwrap());
                            }
                            Ok(switching)
                        },
                    )
                    .await;
                    // Held and never served: the lane only has to stand for its answer to have been read.
                    if let Ok(mut lane) = answered {
                        while lane.next().await.is_some() {}
                    }
                });
            }
        });

        let harness = Harness::launch(
            name,
            Arc::new(|_: &str| PreviewRoute::Node),
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
            &[("INTENTIC_TUNNEL_CA", ca.to_str().unwrap())],
        )
        .await;
        let daemon = free_port();
        harness
            .send(&FromNode::Listen {
                config: ListenConfig {
                    daemon: Listen {
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
        harness
            .send(&FromNode::Tunnel {
                tunnel: Some(TunnelConfig {
                    url: format!("wss://127.0.0.1:{port}/tunnel/v1"),
                    grant: GRANT.into(),
                }),
            })
            .await;
        harness.hello().await;
        bound(daemon).await;
        Self { quic, harness, dir }
    }
}

impl Drop for StandIn {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn an_edge_that_declares_no_quic_is_never_dialled_over_udp() {
    let stand_in = StandIn::start("quic-undeclared", None).await;
    let mut tunnel = stand_in.harness.tunnel.clone();
    tokio::time::timeout(
        Duration::from_secs(10),
        tunnel.wait_for(|held| *held == Some(true)),
    )
    .await
    .expect("the interactive lane is held")
    .unwrap();
    // The front dialled QUIC at once, before; a lane already answered is when it would.
    assert!(
        tokio::time::timeout(Duration::from_secs(2), stand_in.quic.accept())
            .await
            .is_err(),
        "the front dialled a QUIC door the edge never declared"
    );
}

#[tokio::test]
async fn the_front_holds_a_declared_quic_tunnel_and_serves_each_stream_as_http_1_1() {
    let stand_in = StandIn::start(
        "quic",
        Some(Transport::declare(&[
            Transport::Quic,
            Transport::WebTransport,
        ])),
    )
    .await;
    let edge = &stand_in.quic;
    let connection = edge.accept().await.unwrap().await.unwrap();
    let (grant, answering) = tunnel::quic::heard(&connection).await.unwrap();
    assert_eq!(grant, GRANT);
    tunnel::quic::answer(answering, Hello::Held).await.unwrap();

    let own = format!("sandbox-{SANDBOX_ID}.sbx.test");
    let (send, recv) = connection.open_bi().await.unwrap();
    let (mut sender, driving) =
        hyper::client::conn::http1::handshake(TokioIo::new(tunnel::quic::stream(send, recv)))
            .await
            .unwrap();
    tokio::spawn(driving);
    let response = sender
        .send_request(
            Request::get("/health?x=1")
                .header("host", own.as_str())
                .body(Empty::<Bytes>::new())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body, format!("node saw {own} /health?x=1 mark=-"));

    // An upgrade is itself on a stream: the head as the browser sent it, then bytes both ways.
    let (send, recv) = connection.open_bi().await.unwrap();
    let (mut sender, driving) =
        hyper::client::conn::http1::handshake(TokioIo::new(tunnel::quic::stream(send, recv)))
            .await
            .unwrap();
    tokio::spawn(driving.with_upgrades());
    let mut response = sender
        .send_request(
            Request::get("/ws")
                .header("host", own.as_str())
                .header("connection", "Upgrade")
                .header("upgrade", "echo")
                .body(Empty::<Bytes>::new())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 101);
    let mut stream = TokioIo::new(hyper::upgrade::on(&mut response).await.unwrap());
    stream.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    stream.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
}
