//! A browser's WebTransport session against the edge, by a client of another implementation: each stream reaches the
//! sandbox the session was opened on as one HTTP/1.1 connection, upgrades included, and a session is opened only at its
//! path on a sandbox's address.

mod support;

use std::net::SocketAddr;
use std::pin::Pin;

use bytes::Bytes;
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Empty};
use hyper_util::rt::TokioIo;
use intentic_ingress::webtransport::PATH;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wtransport::config::{DnsLookupFuture, DnsResolver};
use wtransport::endpoint::ConnectOptions;
use wtransport::error::ConnectingError;
use wtransport::{ClientConfig, Endpoint};

use support::{Door, Keys, OTHER_ID, SANDBOX_ID, ZONE, daemon_host, dial, door, serving, wait_for};

// Every name the browser dials resolves to the door, as the zone's wildcard record does.
#[derive(Debug)]
struct Resolving(SocketAddr);

impl DnsResolver for Resolving {
    fn resolve(&self, _: &str) -> Pin<Box<dyn DnsLookupFuture>> {
        let address = self.0;
        Box::pin(async move { Ok(Some(address)) })
    }
}

async fn session(
    door: &Door,
    host: &str,
    path: &str,
) -> Result<wtransport::Connection, ConnectingError> {
    let mut config = ClientConfig::builder()
        .with_bind_default()
        .with_no_cert_validation()
        .build();
    config.set_dns_resolver(Resolving(door.quic));
    Endpoint::client(config)
        .unwrap()
        .connect(ConnectOptions::builder(format!("https://{host}{path}")).build())
        .await
}

// One bidirectional stream as the HTTP/1.1 connection the edge serves it as.
async fn over_stream(
    session: &wtransport::Connection,
) -> hyper::client::conn::http1::SendRequest<Empty<Bytes>> {
    let (send, recv) = session.open_bi().await.unwrap().await.unwrap();
    let (sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(tokio::io::join(recv, send)))
            .await
            .unwrap();
    tokio::spawn(connection.with_upgrades());
    sender
}

#[tokio::test]
async fn each_stream_reaches_the_sessions_sandbox_as_http_1_upgrades_included() {
    let keys = Keys::default();
    let door = door(&keys).await;
    let _socket = dial(
        door.running.port,
        &keys.grant(SANDBOX_ID),
        serving("websocket"),
    )
    .await
    .unwrap();
    wait_for("the socket", || door.running.edge.registry().size() == 1).await;
    let session = session(&door, &daemon_host(SANDBOX_ID), PATH)
        .await
        .unwrap();

    // The Host a stream writes names another sandbox; it still reaches only the session's.
    let mut asking = over_stream(&session).await;
    let request = Request::get("/health?over=wt")
        .header("host", daemon_host(OTHER_ID))
        .body(Empty::new())
        .unwrap();
    let response = asking.send_request(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        body,
        format!("websocket {}/health?over=wt", daemon_host(SANDBOX_ID))
    );

    let mut upgrading = over_stream(&session).await;
    let request = Request::get("/ws")
        .header("host", daemon_host(SANDBOX_ID))
        .header("connection", "upgrade")
        .header("upgrade", "echo")
        .body(Empty::new())
        .unwrap();
    let response = upgrading.send_request(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    let mut socket = TokioIo::new(hyper::upgrade::on(response).await.unwrap());
    socket.write_all(b"keys").await.unwrap();
    let mut echoed = [0_u8; 4];
    socket.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"keys");

    // A stream opened while another holds an upgrade answers at once: streams never queue behind each other.
    let mut beside = over_stream(&session).await;
    let request = Request::get("/")
        .header("host", daemon_host(SANDBOX_ID))
        .body(Empty::new())
        .unwrap();
    assert_eq!(
        beside.send_request(request).await.unwrap().status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_session_opens_only_at_its_path_on_a_sandboxs_address() {
    let keys = Keys::default();
    let door = door(&keys).await;
    for (host, path) in [
        (daemon_host(SANDBOX_ID), "/elsewhere".to_owned()),
        (format!("ingress.{ZONE}"), PATH.to_owned()),
    ] {
        match session(&door, &host, &path).await {
            Err(ConnectingError::SessionRejected) => {}
            other => panic!("{host}{path} was answered {:?}", other.map(|_| "a session")),
        }
    }
}
