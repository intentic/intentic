//! The tunnel over QUIC against a front speaking it: the hello's grant is checked as a WebSocket's is, every request and
//! upgrade is a stream of its own carrying HTTP/1.1, QUIC is preferred while held and the WebSocket lanes take over
//! when it goes, and a newer connection displaces an older one.

mod support;

use std::convert::Infallible;
use std::sync::Arc;

use http::{Request, Response, StatusCode};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use intentic_ingress::body;
use intentic_ingress::registry::Slot;
use quinn::crypto::rustls::QuicClientConfig;
use quinn::{Connection, Endpoint};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tunnel::quic::Hello;

use support::{
    Door, Keys, SANDBOX_ID, ZONE, daemon_host, dial, door, get, serving, upgrade, wait_for,
};

// A front dialling the QUIC door: its hello's answer, and the connection, whose streams it serves as HTTP/1.1.
async fn dial_quic(door: &Door, grant: &str, name: &'static str) -> (Hello, Connection) {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(door.trust.clone()).unwrap();
    let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    tls.alpn_protocols = vec![tunnel::quic::ALPN.to_vec()];
    let mut client = quinn::ClientConfig::new(Arc::new(QuicClientConfig::try_from(tls).unwrap()));
    client.transport_config(tunnel::quic::transport());
    let mut endpoint = Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
    endpoint.set_default_client_config(client);
    let connection = endpoint
        .connect(door.quic, &format!("ingress.{ZONE}"))
        .unwrap()
        .await
        .unwrap();
    let hello = tunnel::quic::hello(&connection, grant).await.unwrap();
    let serving_from = connection.clone();
    tokio::spawn(async move {
        let _endpoint = endpoint;
        while let Ok((send, recv)) = serving_from.accept_bi().await {
            tokio::spawn(async move {
                let service = service_fn(move |mut request: Request<Incoming>| async move {
                    if request
                        .headers()
                        .get("upgrade")
                        .is_some_and(|value| value == "echo")
                    {
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
                        return Ok::<_, Infallible>(
                            Response::builder()
                                .status(StatusCode::SWITCHING_PROTOCOLS)
                                .header("connection", "upgrade")
                                .header("upgrade", "echo")
                                .body(body::empty())
                                .unwrap(),
                        );
                    }
                    Ok(serving(name)(&request))
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tunnel::quic::stream(send, recv)), service)
                    .with_upgrades()
                    .await;
            });
        }
    });
    (hello, connection)
}

#[tokio::test]
async fn a_front_over_quic_carries_requests_and_upgrades_and_is_preferred_while_held() {
    let keys = Keys::default();
    let door = door(&keys).await;
    let _lanes = dial(
        door.running.port,
        &keys.grant(SANDBOX_ID),
        None,
        serving("websocket"),
    )
    .await
    .unwrap();
    let (hello, connection) = dial_quic(&door, &keys.grant(SANDBOX_ID), "quic").await;
    assert_eq!(hello, Hello::Held);
    wait_for("the QUIC carrier", || {
        door.running
            .edge
            .registry()
            .lookup(SANDBOX_ID, Slot::Quic)
            .is_some()
    })
    .await;

    let answer = get(door.running.port, &daemon_host(SANDBOX_ID), "/health?x=1").await;
    assert_eq!(
        answer.body,
        format!("quic {}/health?x=1", daemon_host(SANDBOX_ID))
    );
    let bulk = get(
        door.running.port,
        &daemon_host(SANDBOX_ID),
        "/workspace/media?path=a.mp4",
    )
    .await;
    assert!(bulk.body.starts_with("quic "), "{}", bulk.body);

    let (head, mut socket) =
        upgrade(door.running.port, &daemon_host(SANDBOX_ID), "/ws", "echo").await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    socket.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    socket.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");

    // The WebSocket lanes were held all along, so the moment QUIC goes they carry everything.
    connection.close(0_u32.into(), b"gone");
    wait_for("the QUIC carrier to be dropped", || {
        door.running
            .edge
            .registry()
            .lookup(SANDBOX_ID, Slot::Quic)
            .is_none()
    })
    .await;
    let answer = get(door.running.port, &daemon_host(SANDBOX_ID), "/health").await;
    assert!(answer.body.starts_with("websocket "), "{}", answer.body);
}

#[tokio::test]
async fn a_hello_without_a_valid_grant_is_refused_and_a_newer_connection_displaces_an_older() {
    let keys = Keys::default();
    let door = door(&keys).await;
    let (refused, _) = dial_quic(&door, &Keys::default().grant(SANDBOX_ID), "stranger").await;
    assert_eq!(refused, Hello::Refused);
    assert!(
        door.running
            .edge
            .registry()
            .lookup(SANDBOX_ID, Slot::Quic)
            .is_none()
    );

    let (_, first) = dial_quic(&door, &keys.grant(SANDBOX_ID), "first").await;
    wait_for("the first carrier", || {
        door.running
            .edge
            .registry()
            .lookup(SANDBOX_ID, Slot::Quic)
            .is_some()
    })
    .await;
    let (_, _second) = dial_quic(&door, &keys.grant(SANDBOX_ID), "second").await;
    match first.closed().await {
        quinn::ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, tunnel::quic::DISPLACED)
        }
        other => panic!("the first connection ended otherwise: {other}"),
    }
    let answer = get(door.running.port, &daemon_host(SANDBOX_ID), "/").await;
    assert!(answer.body.starts_with("second "), "{}", answer.body);
}

// A browser speaking HTTP/3 to the same endpoint reaches the sandbox down whatever tunnel holds it, here a WebSocket lane.
#[tokio::test]
async fn a_browser_over_http_3_reaches_a_sandbox_down_its_tunnel() {
    let keys = Keys::default();
    let door = door(&keys).await;
    let _lanes = dial(
        door.running.port,
        &keys.grant(SANDBOX_ID),
        None,
        serving("websocket"),
    )
    .await
    .unwrap();
    wait_for("the lane", || door.running.edge.registry().size() == 1).await;

    let mut roots = rustls::RootCertStore::empty();
    roots.add(door.trust.clone()).unwrap();
    let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    tls.alpn_protocols = vec![b"h3".to_vec()];
    let mut endpoint = Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
    endpoint.set_default_client_config(quinn::ClientConfig::new(Arc::new(
        QuicClientConfig::try_from(tls).unwrap(),
    )));
    let connection = endpoint
        .connect(door.quic, &daemon_host(SANDBOX_ID))
        .unwrap()
        .await
        .unwrap();
    let (mut driver, mut requests) = h3::client::new(h3_quinn::Connection::new(connection))
        .await
        .unwrap();
    tokio::spawn(async move { std::future::poll_fn(|cx| driver.poll_close(cx)).await });

    let request = Request::get(format!(
        "https://{}/health?over=h3",
        daemon_host(SANDBOX_ID)
    ))
    .body(())
    .unwrap();
    let mut stream = requests.send_request(request).await.unwrap();
    stream.finish().await.unwrap();
    let response = stream.recv_response().await.unwrap();
    assert_eq!(response.status(), 200);
    let mut body = Vec::new();
    while let Some(mut chunk) = stream.recv_data().await.unwrap() {
        use bytes::Buf;
        body.extend_from_slice(&chunk.copy_to_bytes(chunk.remaining()));
    }
    assert_eq!(
        String::from_utf8(body).unwrap(),
        format!("websocket {}/health?over=h3", daemon_host(SANDBOX_ID))
    );

    // A sandbox with no tunnel is refused over HTTP/3 in the words TCP uses, with no replay to offer.
    let request = Request::get(format!("https://{}/", daemon_host("0123456789ab")))
        .body(())
        .unwrap();
    let mut stream = requests.send_request(request).await.unwrap();
    stream.finish().await.unwrap();
    let response = stream.recv_response().await.unwrap();
    assert_eq!(response.status(), 502);
    assert_eq!(response.headers()["x-intentic-edge"], "no-tunnel");
}

// What a front and the platform read to know whether to reach for QUIC, HTTP/3 and WebTransport at all: the edge's own
// declaration, off what it binds, on its answer to every tunnel and on `/health`. An edge binding no UDP declares nothing.
#[tokio::test]
async fn the_edge_declares_what_it_serves_on_every_tunnels_answer_and_on_health() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tunnel::{GRANT_HEADER, TRANSPORTS_HEADER};

    let keys = Keys::default();
    let declaring = door(&keys).await;
    let silent = support::start(support::lone(&keys)).await;
    for (port, declared, tokens) in [
        (
            declaring.running.port,
            Some("quic, h3, webtransport"),
            serde_json::json!(["quic", "h3", "webtransport"]),
        ),
        (silent.port, None, serde_json::json!([])),
    ] {
        let mut request = format!("ws://127.0.0.1:{port}/tunnel/v1")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(GRANT_HEADER, keys.grant(SANDBOX_ID).parse().unwrap());
        let (_socket, answer) = tokio_tungstenite::connect_async(request).await.unwrap();
        assert_eq!(
            answer
                .headers()
                .get(TRANSPORTS_HEADER)
                .map(|value| value.to_str().unwrap()),
            declared
        );
        let health = get(port, &format!("ingress.{ZONE}"), "/health").await;
        let health: serde_json::Value = serde_json::from_str(&health.body).unwrap();
        assert_eq!(health["transports"], tokens);
    }
}
