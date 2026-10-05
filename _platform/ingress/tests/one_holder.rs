//! One holder per sandbox (2026-10-05): a front names its instance, the edge refuses a second live copy instead of
//! letting the two trade the tunnel every minute, proves a QUIC carrier with probes before and while it takes requests,
//! moves a request a stalled QUIC carrier would not answer onto the socket, and closes the tunnels of a sandbox the
//! platform deleted while they were held.

mod support;

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use http::{Request, Response, StatusCode};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use intentic_ingress::body;
use intentic_ingress::edge::EdgeOptions;
use intentic_ingress::registry::Slot;
use intentic_ingress::revocation::Revocation;
use intentic_ingress::serve;
use quinn::crypto::rustls::QuicClientConfig;
use quinn::{Connection, Endpoint};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tunnel::quic::{Greeting, Hello};
use tunnel::{DELETED_CODE, DISPLACED_CODE, Ended, Identity};

use support::{
    Door, Keys, SANDBOX_ID, ZONE, daemon_host, dial, dial_as, door, get, lone, serving, start,
    wait_for,
};

fn named(instance: &str, host: &str) -> Identity {
    Identity {
        instance: instance.into(),
        host: host.into(),
    }
}

// How a QUIC front treats the streams the edge opens: as HTTP/1.1, as an older front does (a probe is answered 400), only
// the first, or none at all, as a front on a path that carries nothing more.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Serves {
    Every,
    First,
    Nothing,
}

// A front dialling the QUIC door with today's hello, naming itself.
async fn dial_quic_as(
    door: &Door,
    grant: &str,
    identity: &Identity,
    serves: Serves,
) -> (Greeting, Connection) {
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
    let greeting = tunnel::quic::introduce(&connection, grant, identity)
        .await
        .unwrap();
    let serving_from = connection.clone();
    tokio::spawn(async move {
        let _endpoint = endpoint;
        if serves == Serves::Nothing {
            std::future::pending::<()>().await;
        }
        while let Ok((send, recv)) = serving_from.accept_bi().await {
            tokio::spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| async move {
                    Ok::<_, Infallible>(serving("quic")(&request))
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tunnel::quic::stream(send, recv)), service)
                    .await;
            });
            if serves == Serves::First {
                std::future::pending::<()>().await;
            }
        }
    });
    (greeting, connection)
}

// The upgrade's answer to a dial the edge refused: its status and the holder it named.
async fn refused_dial(port: u16, grant: &str, instance: &str) -> (u16, Option<String>) {
    let mut request = format!("ws://127.0.0.1:{port}{}", tunnel::TUNNEL_PATH)
        .into_client_request()
        .unwrap();
    for (name, value) in [
        (tunnel::GRANT_HEADER, grant),
        (tunnel::INSTANCE_HEADER, instance),
        (tunnel::HOST_HEADER, "omen (windows)"),
    ] {
        request.headers_mut().insert(name, value.parse().unwrap());
    }
    match tokio_tungstenite::connect_async(request).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(answer)) => (
            answer.status().as_u16(),
            answer
                .headers()
                .get(tunnel::HOLDER_HEADER)
                .map(|value| value.to_str().unwrap().to_owned()),
        ),
        Ok(_) => panic!("the edge took a second copy"),
        Err(error) => panic!("the dial failed: {error}"),
    }
}

#[tokio::test]
async fn a_second_live_copy_is_refused_naming_the_holder_and_the_holder_keeps_serving() {
    let keys = Keys::default();
    let running = start(lone(&keys)).await;
    let grant = keys.grant(SANDBOX_ID);
    let holder = dial_as(running.port, &grant, "a1", "rog (linux)", serving("first"))
        .await
        .unwrap();
    wait_for("the first copy", || running.edge.registry().size() == 1).await;

    assert_eq!(
        refused_dial(running.port, &grant, "b2").await,
        (409, Some("rog (linux)".into()))
    );
    let answer = get(running.port, &daemon_host(SANDBOX_ID), "/").await;
    assert!(answer.body.starts_with("first "), "{}", answer.body);
    assert!(!holder.ended.is_finished());

    // Its own redial replaces it, as always.
    let again = dial_as(running.port, &grant, "a1", "rog (linux)", serving("again"))
        .await
        .unwrap();
    assert_eq!(
        holder.ended.await.unwrap(),
        Ended::Closed(Some(DISPLACED_CODE))
    );
    wait_for("the redial to serve", || {
        running
            .edge
            .registry()
            .lookup(SANDBOX_ID, Slot::Socket)
            .is_some()
    })
    .await;
    let answer = get(running.port, &daemon_host(SANDBOX_ID), "/").await;
    assert!(answer.body.starts_with("again "), "{}", answer.body);

    // A front from before instances names none, and the newest still wins against a named one during the roll.
    let older = dial(running.port, &grant, serving("older")).await.unwrap();
    assert_eq!(
        again.ended.await.unwrap(),
        Ended::Closed(Some(DISPLACED_CODE))
    );
    drop(older);
}

#[tokio::test]
async fn a_named_quic_front_is_refused_while_another_copy_holds_the_socket() {
    let keys = Keys::default();
    let door = door(&keys).await;
    let grant = keys.grant(SANDBOX_ID);
    let _holder = dial_as(
        door.running.port,
        &grant,
        "a1",
        "rog (linux)",
        serving("socket"),
    )
    .await
    .unwrap();
    wait_for("the socket", || door.running.edge.registry().size() == 1).await;
    let (greeting, connection) =
        dial_quic_as(&door, &grant, &named("b2", "omen"), Serves::Every).await;
    assert_eq!(
        greeting,
        Greeting {
            hello: Hello::HeldElsewhere,
            holder: "rog (linux)".into()
        }
    );
    match connection.closed().await {
        quinn::ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, tunnel::quic::HELD_ELSEWHERE)
        }
        other => panic!("closed otherwise: {other}"),
    }
    assert!(
        door.running
            .edge
            .registry()
            .holding(SANDBOX_ID, Slot::Quic)
            .is_none()
    );

    // The holder's own QUIC connection is welcome, and carries requests once a probe proved it.
    let (greeting, _connection) =
        dial_quic_as(&door, &grant, &named("a1", "rog (linux)"), Serves::Every).await;
    assert_eq!(greeting.hello, Hello::Held);
    wait_for("the QUIC carrier to be proven", || {
        door.running
            .edge
            .registry()
            .lookup(SANDBOX_ID, Slot::Quic)
            .is_some()
    })
    .await;
    let answer = get(door.running.port, &daemon_host(SANDBOX_ID), "/").await;
    assert!(answer.body.starts_with("quic "), "{}", answer.body);
}

// The 2026-10-05 half-dead path: QUIC's handshake and keep-alive crossed, streams did not, and QUIC outranked the socket.
#[tokio::test]
async fn a_quic_carrier_that_serves_no_probe_never_takes_a_request_and_is_demoted() {
    let keys = Keys::default();
    let door = door(&keys).await;
    let grant = keys.grant(SANDBOX_ID);
    let _socket = dial_as(door.running.port, &grant, "a1", "rog", serving("socket"))
        .await
        .unwrap();
    wait_for("the socket", || door.running.edge.registry().size() == 1).await;
    let (greeting, connection) =
        dial_quic_as(&door, &grant, &named("a1", "rog"), Serves::Nothing).await;
    assert_eq!(greeting.hello, Hello::Held);
    wait_for("the QUIC registration", || {
        door.running
            .edge
            .registry()
            .holding(SANDBOX_ID, Slot::Quic)
            .is_some()
    })
    .await;
    let answer = get(door.running.port, &daemon_host(SANDBOX_ID), "/").await;
    assert!(answer.body.starts_with("socket "), "{}", answer.body);
    let closed = tokio::time::timeout(
        tunnel::PROBE_PATIENCE + Duration::from_secs(5),
        connection.closed(),
    )
    .await
    .expect("demoted within the probe's patience");
    match closed {
        quinn::ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, tunnel::quic::DEMOTED)
        }
        other => panic!("closed otherwise: {other}"),
    }
}

// A request a proven QUIC carrier stopped answering: once a probe beside it fails, the carrier is demoted and the
// request, which streamed no body, is carried by the socket instead.
#[tokio::test]
async fn a_request_a_stalled_quic_carrier_does_not_answer_is_carried_by_the_socket() {
    let keys = Keys::default();
    let door = door(&keys).await;
    let grant = keys.grant(SANDBOX_ID);
    let _socket = dial_as(door.running.port, &grant, "a1", "rog", serving("socket"))
        .await
        .unwrap();
    wait_for("the socket", || door.running.edge.registry().size() == 1).await;
    let (_, connection) = dial_quic_as(&door, &grant, &named("a1", "rog"), Serves::First).await;
    wait_for("the QUIC carrier to be proven", || {
        door.running
            .edge
            .registry()
            .lookup(SANDBOX_ID, Slot::Quic)
            .is_some()
    })
    .await;
    let answer = tokio::time::timeout(
        Duration::from_secs(40),
        get(
            door.running.port,
            &daemon_host(SANDBOX_ID),
            "/after-a-stall",
        ),
    )
    .await
    .expect("answered once the stall was found");
    assert_eq!(
        answer.body,
        format!("socket {}/after-a-stall", daemon_host(SANDBOX_ID))
    );
    match connection.closed().await {
        quinn::ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, tunnel::quic::DEMOTED)
        }
        other => panic!("closed otherwise: {other}"),
    }
}

// A platform whose answer for the sandbox can change: 200 until told otherwise.
async fn changing_platform() -> (String, Arc<AtomicU16>, serve::Listening) {
    let status = Arc::new(AtomicU16::new(200));
    let answering = status.clone();
    let listening = serve::listen("127.0.0.1:0", move |_request, _| {
        let status = answering.load(Ordering::Relaxed);
        async move {
            let mut response = Response::new(body::full("{}"));
            *response.status_mut() = StatusCode::from_u16(status).unwrap();
            response
        }
    })
    .await
    .unwrap();
    (
        format!("http://127.0.0.1:{}", listening.address.port()),
        status,
        listening,
    )
}

#[tokio::test]
async fn a_held_sandbox_the_platform_deleted_is_closed_and_refused_with_the_verdict() {
    let keys = Keys::default();
    let (url, status, _platform) = changing_platform().await;
    let running = start(EdgeOptions {
        revocation: Revocation::keeping(&url, Duration::ZERO),
        ..lone(&keys)
    })
    .await;
    let grant = keys.grant(SANDBOX_ID);
    let held = dial_as(running.port, &grant, "a1", "rog", serving("held"))
        .await
        .unwrap();
    wait_for("the tunnel", || running.edge.registry().size() == 1).await;
    assert_eq!(running.edge.recheck_once().await, 0, "it still exists");
    assert!(!held.ended.is_finished());

    status.store(404, Ordering::Relaxed);
    assert_eq!(running.edge.recheck_once().await, 1);
    assert_eq!(held.ended.await.unwrap(), Ended::Closed(Some(DELETED_CODE)));
    wait_for("the tunnel to go", || running.edge.registry().size() == 0).await;

    // A redial is refused, with the verdict that tells a front it was a deletion.
    let mut request = format!("ws://127.0.0.1:{}{}", running.port, tunnel::TUNNEL_PATH)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(tunnel::GRANT_HEADER, grant.parse().unwrap());
    let Err(tokio_tungstenite::tungstenite::Error::Http(answer)) =
        tokio_tungstenite::connect_async(request).await
    else {
        panic!("a deleted sandbox's tunnel is refused");
    };
    assert_eq!(answer.status(), 403);
    assert_eq!(answer.headers()["x-intentic-edge"], "unknown-sandbox");
}
