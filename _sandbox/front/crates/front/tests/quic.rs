//! The tunnel over QUIC against a stand-in edge: the front dials beside its WebSocket lanes, presents its grant in the
//! hello, and serves every stream the edge opens as one HTTP/1.1 exchange, an upgrade included.

mod support;

use std::sync::Arc;

use bytes::Bytes;
use front_wire::{Endpoint as Listen, FromNode, ListenConfig, PreviewRoute, TunnelConfig};
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper_util::rt::TokioIo;
use quinn::crypto::rustls::QuicServerConfig;
use quinn::{Endpoint, ServerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tunnel::quic::Hello;

use support::{Harness, SANDBOX_ID, bound, free_port};

const GRANT: &str = "ig1.quic-test-grant";

#[tokio::test]
async fn the_front_holds_a_quic_tunnel_and_serves_each_stream_as_http_1_1() {
    // An edge on 127.0.0.1 with a certificate the front is told to trust.
    let issued = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_owned()]).unwrap();
    let dir = std::env::temp_dir().join(format!("front-quic-ca-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ca = dir.join("ca.pem");
    std::fs::write(&ca, issued.cert.pem()).unwrap();
    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![issued.cert.der().clone()],
        rustls::pki_types::PrivateKeyDer::Pkcs8(issued.signing_key.serialize_der().into()),
    )
    .unwrap();
    tls.alpn_protocols = vec![tunnel::quic::ALPN.to_vec()];
    let mut server = ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(tls).unwrap()));
    server.transport_config(tunnel::quic::transport());
    let edge = Endpoint::server(server, "127.0.0.1:0".parse().unwrap()).unwrap();
    let port = edge.local_addr().unwrap().port();

    let harness = Harness::launch(
        "quic",
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
    // The same URL the lanes dial: TCP finds nothing there and backs off, UDP finds this edge.
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
    let _ = std::fs::remove_dir_all(&dir);
}
