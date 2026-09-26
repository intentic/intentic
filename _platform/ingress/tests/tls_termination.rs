//! The edge terminating TLS itself behind a TCP passthrough: the PROXY header names the browser, ALPN picks h2 or
//! HTTP/1.1, a sandbox's names reach its tunnel either way, and a renewed certificate reaches the next connection.

mod support;

use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use http::{Request, Response};
use http_body_util::{BodyExt, Empty};
use hyper_util::rt::{TokioExecutor, TokioIo};
use intentic_ingress::body;
use intentic_ingress::edge::{VERDICT_HEADER, Via};
use intentic_ingress::revocation::Revocation;
use intentic_ingress::serve::{self, Listening};
use intentic_ingress::tls::{self, CertificateSlot};
use rustls::pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use support::{
    Keys, SANDBOX_ID, ZONE, daemon_host, dial, get, lone, platform, serving, start, wait_for,
};

struct Issued {
    chain: String,
    key: String,
    der: CertificateDer<'static>,
}

fn issue() -> Issued {
    let issued =
        rcgen::generate_simple_self_signed(vec![format!("*.{ZONE}"), ZONE.to_owned()]).unwrap();
    Issued {
        chain: issued.cert.pem(),
        key: issued.signing_key.serialize_pem(),
        der: issued.cert.der().clone(),
    }
}

// A browser behind the passthrough: the PROXY line the passthrough writes, then a handshake offering `alpn`.
async fn browse(
    port: u16,
    trusted: &[&Issued],
    alpn: &[u8],
    proxy: Option<&str>,
) -> std::io::Result<TlsStream<TcpStream>> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    if let Some(proxy) = proxy {
        stream.write_all(proxy.as_bytes()).await?;
    }
    let mut roots = rustls::RootCertStore::empty();
    for issued in trusted {
        roots.add(issued.der.clone()).unwrap();
    }
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    config.alpn_protocols = vec![alpn.to_vec()];
    TlsConnector::from(Arc::new(config))
        .connect(
            ServerName::try_from(daemon_host(SANDBOX_ID)).unwrap(),
            stream,
        )
        .await
}

const PROXIED: &str = "PROXY TCP4 203.0.113.7 127.0.0.1 51234 443\r\n";

#[tokio::test]
async fn a_browser_reaches_a_tunnel_over_the_edges_own_tls_in_h2_and_in_http_1_1() {
    let keys = Keys::default();
    let running = start(lone(&keys)).await;
    let slot = Arc::new(CertificateSlot::default());
    let issued = issue();
    slot.replace(&issued.chain, &issued.key).unwrap();
    let edge = running.edge.clone();
    let secure = serve::serve_tls_on(
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        tls::acceptor(slot),
        true,
        move |request, remote| {
            edge.clone()
                .handle(request.map(body::incoming), remote, Via::Direct)
        },
    )
    .unwrap();
    let _sandbox = dial(running.port, &keys.grant(SANDBOX_ID), serving("served"))
        .await
        .unwrap();
    wait_for("the tunnel to register", || {
        running.edge.registry().size() == 1
    })
    .await;

    let tls = browse(secure.address.port(), &[&issued], b"h2", Some(PROXIED))
        .await
        .unwrap();
    assert_eq!(tls.get_ref().1.alpn_protocol(), Some(&b"h2"[..]));
    let (mut sender, connection) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(tls))
            .await
            .unwrap();
    tokio::spawn(connection);
    let response = sender
        .send_request(
            Request::get(format!("https://{}/health", daemon_host(SANDBOX_ID)))
                .body(Empty::<Bytes>::new())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let answer = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(answer, format!("served {}/health", daemon_host(SANDBOX_ID)));

    // HTTP/1.1 over the same TLS, where a WebSocket still opens as an upgrade and is spliced to the tunnel.
    let mut tls = browse(
        secure.address.port(),
        &[&issued],
        b"http/1.1",
        Some(PROXIED),
    )
    .await
    .unwrap();
    tls.write_all(
        format!(
            "GET /ws HTTP/1.1\r\nHost: {}\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n",
            daemon_host(SANDBOX_ID)
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        tls.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    assert!(
        head.starts_with(b"HTTP/1.1 101"),
        "{}",
        String::from_utf8_lossy(&head)
    );
    tls.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    tls.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
}

// The handler here answers with the address it was handed, which is what the edge logs and forwards as the browser's.
async fn naming_the_browser(slot: Arc<CertificateSlot>, proxied: bool) -> Listening {
    serve::serve_tls_on(
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        tls::acceptor(slot),
        proxied,
        |_, remote: SocketAddr| async move { Response::new(body::full(remote.to_string())) },
    )
    .unwrap()
}

async fn named(tls: TlsStream<TcpStream>) -> String {
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .unwrap();
    tokio::spawn(connection);
    let response = sender
        .send_request(
            Request::get("/")
                .header("host", daemon_host(SANDBOX_ID))
                .body(Empty::<Bytes>::new())
                .unwrap(),
        )
        .await
        .unwrap();
    String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap()
}

#[tokio::test]
async fn the_proxy_header_names_the_browser_and_a_connection_without_one_is_dropped() {
    let slot = Arc::new(CertificateSlot::default());
    let issued = issue();
    slot.replace(&issued.chain, &issued.key).unwrap();
    let proxied = naming_the_browser(slot.clone(), true).await;
    let tls = browse(
        proxied.address.port(),
        &[&issued],
        b"http/1.1",
        Some(PROXIED),
    )
    .await
    .unwrap();
    assert_eq!(named(tls).await, "203.0.113.7:51234");
    assert!(
        browse(proxied.address.port(), &[&issued], b"http/1.1", None)
            .await
            .is_err()
    );

    // Without a passthrough in front, the socket's own peer is the browser.
    let direct = naming_the_browser(slot, false).await;
    let tls = browse(direct.address.port(), &[&issued], b"http/1.1", None)
        .await
        .unwrap();
    assert!(named(tls).await.starts_with("127.0.0.1:"));
}

#[tokio::test]
async fn a_renewed_certificate_reaches_the_next_connection_and_an_empty_slot_refuses() {
    let slot = Arc::new(CertificateSlot::default());
    let listening = naming_the_browser(slot.clone(), false).await;
    let port = listening.address.port();
    let (first, second) = (issue(), issue());
    assert!(browse(port, &[&first], b"h2", None).await.is_err());

    slot.replace(&first.chain, &first.key).unwrap();
    let tls = browse(port, &[&first, &second], b"h2", None).await.unwrap();
    assert_eq!(tls.get_ref().1.peer_certificates().unwrap()[0], first.der);

    // A pair whose key is not its certificate's is refused, and the slot keeps what it held.
    assert!(slot.replace(&second.chain, &first.key).is_err());
    slot.replace(&second.chain, &second.key).unwrap();
    let tls = browse(port, &[&first, &second], b"h2", None).await.unwrap();
    assert_eq!(tls.get_ref().1.peer_certificates().unwrap()[0], second.der);
}

#[tokio::test]
async fn a_pem_pair_on_disk_fills_the_slot() {
    let issued = issue();
    let dir = std::env::temp_dir().join(format!("ingress-tls-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("chain.pem"), &issued.chain).unwrap();
    std::fs::write(dir.join("key.pem"), &issued.key).unwrap();
    let slot = Arc::new(CertificateSlot::default());
    let keeping = intentic_ingress::certificate::keep(
        slot.clone(),
        intentic_ingress::certificate::Source::Files {
            chain: dir.join("chain.pem"),
            key: dir.join("key.pem"),
        },
    );
    wait_for("the slot to fill", || slot.present()).await;
    keeping.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

// A replay only means something to Fly's proxy: on TLS the edge terminated, a hosted sandbox with no tunnel is refused in
// the verdict the editor wakes it on, and one that dialled in is served down its tunnel like any other.
#[tokio::test]
async fn a_hosted_sandbox_replays_only_behind_the_proxy_and_is_tunnelled_on_the_edges_own_tls() {
    const HOSTED_ID: &str = "feedfacecafe";
    let keys = Keys::default();
    let platform = platform(std::collections::HashMap::from([(
        HOSTED_ID.to_owned(),
        (200, r#"{"ok":true,"lane":"hosted"}"#.to_owned()),
    )]))
    .await;
    let mut options = lone(&keys);
    options.revocation = Revocation::new(&platform.url);
    options.hosted_app_prefix = Some("intentic-sbx".into());
    let running = start(options).await;
    let slot = Arc::new(CertificateSlot::default());
    let issued = issue();
    slot.replace(&issued.chain, &issued.key).unwrap();
    let edge = running.edge.clone();
    let secure = serve::serve_tls_on(
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        tls::acceptor(slot),
        false,
        move |request, remote| {
            edge.clone()
                .handle(request.map(body::incoming), remote, Via::Direct)
        },
    )
    .unwrap();

    let behind_the_proxy = get(running.port, &daemon_host(HOSTED_ID), "/").await;
    assert_eq!(
        behind_the_proxy.headers["fly-replay"],
        "app=intentic-sbx-feedfacecafe"
    );

    let fetch = |port: u16| {
        let issued = &issued;
        async move {
            let tls = browse(port, &[issued], b"http/1.1", None).await.unwrap();
            let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
                .await
                .unwrap();
            tokio::spawn(connection);
            sender
                .send_request(
                    Request::get("/")
                        .header("host", daemon_host(HOSTED_ID))
                        .body(Empty::<Bytes>::new())
                        .unwrap(),
                )
                .await
                .unwrap()
        }
    };
    let direct = fetch(secure.address.port()).await;
    assert_eq!(direct.status(), 502);
    assert!(direct.headers().get("fly-replay").is_none());
    assert_eq!(direct.headers()[VERDICT_HEADER], "no-tunnel");

    let _hosted = dial(running.port, &keys.grant(HOSTED_ID), serving("hosted"))
        .await
        .unwrap();
    wait_for("the hosted machine's tunnel", || {
        running.edge.registry().size() == 1
    })
    .await;
    let tunnelled = fetch(secure.address.port()).await;
    assert_eq!(tunnelled.status(), 200);
    let answer = tunnelled.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(answer, format!("hosted {}/", daemon_host(HOSTED_ID)));
}
