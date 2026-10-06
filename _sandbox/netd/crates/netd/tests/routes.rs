//! The real binary on real ports: each listener reaches what its Host names, previews are relayed with the headers an
//! upstream and the editor need, TLS on the loopback port speaks h2, and upgrades are spliced byte for byte.

mod support;

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use browser_wire::{NodeLink, SandboxVitals};
use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{HeaderMap, Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo};
use netd_wire::{
    Certificate, Endpoint, FromNode, ListenConfig, Page, PreviewRoute, Scheme, Upstream,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use support::{Harness, SANDBOX_ID, bound, free_port};

struct Answer {
    status: u16,
    headers: HeaderMap,
    body: String,
}

async fn get(port: u16, host: &str, path: &str, extra: &[(&str, &str)]) -> Answer {
    send(port, "GET", host, path, extra).await
}

async fn send(port: u16, method: &str, host: &str, path: &str, extra: &[(&str, &str)]) -> Answer {
    let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection);
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", host);
    for (name, value) in extra {
        request = request.header(*name, *value);
    }
    let response = sender
        .send_request(request.body(Empty::<Bytes>::new()).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
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
    Answer {
        status,
        headers,
        body,
    }
}

// A dev server that names the Host, Origin and forwarding headers it received, and refuses to be framed.
async fn upstream() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let service = service_fn(|request: Request<Incoming>| async move {
                    let header = |name: &str| {
                        request
                            .headers()
                            .get(name)
                            .map_or("-", |value| value.to_str().unwrap())
                            .to_owned()
                    };
                    let body = format!(
                        "upstream saw host={} origin={} forwarded={} proto={}",
                        header("host"),
                        header("origin"),
                        header("x-forwarded-host"),
                        header("x-forwarded-proto")
                    );
                    Ok::<_, Infallible>(
                        Response::builder()
                            .header("x-frame-options", "DENY")
                            .header(
                                "content-security-policy",
                                "default-src 'self'; frame-ancestors 'none'",
                            )
                            .body(Full::new(Bytes::from(body)))
                            .unwrap(),
                    )
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    port
}

fn config(daemon: u16, preview: u16, loopback: u16) -> ListenConfig {
    let endpoint = |port| Endpoint {
        host: "127.0.0.1".into(),
        port,
    };
    ListenConfig {
        daemon: endpoint(daemon),
        preview: Some(endpoint(preview)),
        loopback: Some(endpoint(loopback)),
        sandbox_id: Some(SANDBOX_ID.into()),
        frame_ancestors: vec!["https://app.example".into()],
        preview_probe_path: "/__intentic/preview-probe".into(),
    }
}

async fn started(name: &str, upstream_port: u16) -> (Harness, u16, u16, u16) {
    let route = Arc::new(move |host: &str, probe: bool| {
        if probe {
            PreviewRoute::Page {
                page: Page {
                    status: 200,
                    headers: [("access-control-allow-origin".to_owned(), "*".to_owned())].into(),
                    body: format!("probed {host}"),
                },
            }
        } else if host.starts_with("public-") {
            PreviewRoute::Outbox
        } else if host.starts_with("preview-web-") {
            PreviewRoute::Upstream {
                upstream: Upstream {
                    host: "127.0.0.1".into(),
                    port: upstream_port,
                    scheme: Scheme::Http,
                    localhost: true,
                    frameable: true,
                },
            }
        } else {
            support::nothing_here()
        }
    });
    let harness = Harness::start(name, route).await;
    let (daemon, preview, loopback) = (free_port(), free_port(), free_port());
    harness
        .send(&FromNode::Listen {
            config: config(daemon, preview, loopback),
        })
        .await;
    harness.hello().await;
    for port in [daemon, preview, loopback] {
        bound(port).await;
    }
    (harness, daemon, preview, loopback)
}

#[tokio::test]
async fn each_listener_reaches_what_its_host_names() {
    let (_harness, daemon, preview, loopback) = started("listeners", upstream().await).await;
    let own = format!("sandbox-{SANDBOX_ID}.sbx.test");
    let web = format!("preview-web-{SANDBOX_ID}.sbx.test");

    assert_eq!(
        get(daemon, &own, "/health?x=1", &[]).await.body,
        format!("node saw {own} /health?x=1 mark=-")
    );
    assert_eq!(
        get(daemon, &web, "/", &[]).await.body,
        format!("node saw {web} / mark=-")
    );
    assert_eq!(
        get(preview, &own, "/fleet", &[]).await.body,
        format!("node saw {own} /fleet mark=-")
    );
    // What Node decided is what netd does, asked once: a page it rendered is written as it stands, the probe too
    // (whatever a cached upstream says), and only the outbox is handed back to Node, marked as what it is.
    let stray = "port-zz-0123456789ab.sbx.test";
    let refused = get(preview, stray, "/", &[]).await;
    assert_eq!(
        (refused.status, refused.body.as_str()),
        (404, "no preview here")
    );
    assert_eq!(refused.headers["content-type"], "text/plain");
    assert!(
        get(preview, &web, "/app.js", &[])
            .await
            .body
            .starts_with("upstream saw")
    );
    let probed = get(preview, &web, "/__intentic/preview-probe", &[]).await;
    assert_eq!((probed.status, probed.body), (200, format!("probed {web}")));
    assert_eq!(probed.headers["access-control-allow-origin"], "*");
    let outbox = format!("public-salt-{SANDBOX_ID}.sbx.test");
    assert_eq!(
        get(preview, &outbox, "/report.pdf", &[]).await.body,
        format!("node saw {outbox} /report.pdf mark=outbox")
    );
    assert_eq!(
        get(loopback, "127.0.0.1:28123", "/agents", &[]).await.body,
        "node saw 127.0.0.1:28123 /agents mark=-"
    );
}

#[tokio::test]
async fn a_preview_is_relayed_as_its_localhost_with_the_editors_framing() {
    let upstream_port = upstream().await;
    let (_harness, _daemon, preview, loopback) = started("preview", upstream_port).await;
    let web = format!("preview-web-{SANDBOX_ID}.sbx.test");
    let relayed = get(
        preview,
        &web,
        "/app.js",
        &[("origin", "https://preview.example")],
    )
    .await;
    assert_eq!(relayed.status, 200);
    assert_eq!(
        relayed.body,
        format!(
            "upstream saw host=localhost:{upstream_port} origin=http://localhost:{upstream_port} forwarded={web} proto=http"
        )
    );
    assert!(relayed.headers.get("x-frame-options").is_none());
    assert_eq!(
        relayed.headers["content-security-policy"],
        "default-src 'self'; frame-ancestors 'self' https://app.example"
    );

    let local = format!("preview-web-{SANDBOX_ID}.localhost:28123");
    let forwarded = get(loopback, &local, "/", &[("x-forwarded-proto", "https")]).await;
    assert_eq!(
        forwarded.body,
        format!(
            "upstream saw host=localhost:{upstream_port} origin=- forwarded={local} proto=https"
        )
    );
}

#[tokio::test]
async fn a_forged_netd_header_never_reaches_node() {
    let (_harness, daemon, _preview, _loopback) = started("forged", upstream().await).await;
    let own = format!("sandbox-{SANDBOX_ID}.sbx.test");
    let answer = get(
        daemon,
        &own,
        "/",
        &[
            ("x-intentic-preview", "outbox"),
            ("x-intentic-preview-unreachable", "1"),
        ],
    )
    .await;
    assert_eq!(answer.body, format!("node saw {own} / mark=-"));
}

#[tokio::test]
async fn an_upgrade_is_spliced_byte_for_byte() {
    let (_harness, daemon, _preview, _loopback) = started("upgrade", upstream().await).await;
    let mut stream = TcpStream::connect(("127.0.0.1", daemon)).await.unwrap();
    let head = format!(
        "GET /ws HTTP/1.1\r\nHost: sandbox-{SANDBOX_ID}.sbx.test\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    let mut byte = [0_u8; 1];
    while !answer.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        answer.push(byte[0]);
    }
    let answer = String::from_utf8_lossy(&answer).to_lowercase();
    assert!(answer.starts_with("http/1.1 101"), "{answer}");
    // Origin form, as an h1 server expects it from anything but a proxy.
    assert!(answer.contains("\r\nx-node-saw: /ws\r\n"), "{answer}");
    stream.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    stream.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
}

// A dev server's upgrade, read as it arrived: its request line is sent on `seen`, it answers 101 to anything, and
// echoes. `ws` (with `path`) and Vite's HMR match the request-target as a path, so an absolute-form one is refused there
// (2026-10-06: Vite's HMR socket went unanswered through a preview, and a `ws` server on `/ws` answered 400).
async fn upgrade_upstream() -> (u16, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (seen, lines) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0_u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read_exact(&mut byte).await.is_err() {
                        return;
                    }
                    head.push(byte[0]);
                }
                let line = String::from_utf8_lossy(&head)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                let _ = seen.send(line);
                let switching = b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n";
                if stream.write_all(switching).await.is_err() {
                    return;
                }
                let mut buffer = [0_u8; 1024];
                while let Ok(read @ 1..) = stream.read(&mut buffer).await {
                    if stream.write_all(&buffer[..read]).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (port, lines)
}

#[tokio::test]
async fn a_previews_upgrade_reaches_its_upstream_in_origin_form() {
    let (upstream_port, mut lines) = upgrade_upstream().await;
    let (_harness, _daemon, preview, _loopback) = started("upgrade-preview", upstream_port).await;
    let mut stream = TcpStream::connect(("127.0.0.1", preview)).await.unwrap();
    let head = format!(
        "GET /hmr?token=t HTTP/1.1\r\nHost: preview-web-{SANDBOX_ID}.sbx.test\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    let mut byte = [0_u8; 1];
    while !answer.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        answer.push(byte[0]);
    }
    assert!(String::from_utf8_lossy(&answer).starts_with("HTTP/1.1 101"));
    assert_eq!(lines.recv().await.unwrap(), "GET /hmr?token=t HTTP/1.1");
    stream.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    stream.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
}

// One request written as it stands, its whole answer read back: for heads a client library would not write.
async fn raw(port: u16, head: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer).await;
    String::from_utf8_lossy(&answer).into_owned()
}

#[tokio::test]
async fn an_absolute_form_request_names_its_target_in_the_host_it_forwards() {
    let (_harness, _daemon, preview, _loopback) = started("absolute", upstream().await).await;
    let own = format!("sandbox-{SANDBOX_ID}.sbx.test");
    let web = format!("preview-web-{SANDBOX_ID}.sbx.test");
    // Routed by its target (RFC 9112 §3.2.2), so Node must hear that target as its Host, never the Host it came with.
    let answer = raw(
        preview,
        &format!("GET http://{own}/hello HTTP/1.1\r\nHost: {web}\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(
        answer.ends_with(&format!("node saw {own} /hello mark=-")),
        "{answer}"
    );
}

#[tokio::test]
async fn a_request_naming_two_hosts_is_refused() {
    let (_harness, daemon, preview, _loopback) = started("two-hosts", upstream().await).await;
    let own = format!("sandbox-{SANDBOX_ID}.sbx.test");
    let web = format!("preview-web-{SANDBOX_ID}.sbx.test");
    for port in [daemon, preview] {
        let answer = raw(
            port,
            &format!("GET / HTTP/1.1\r\nHost: {own}\r\nHost: {web}\r\nConnection: close\r\n\r\n"),
        )
        .await;
        assert!(answer.starts_with("HTTP/1.1 400"), "{answer}");
    }
}

#[tokio::test]
async fn a_port_moved_to_another_host_is_bound_there() {
    let (harness, daemon, preview, loopback) = started("rehost", upstream().await).await;
    let mut moved = config(daemon, preview, loopback);
    moved.daemon.host = "0.0.0.0".into();
    harness.send(&FromNode::Listen { config: moved }).await;
    // 127.0.0.2 reaches only the wildcard listener: the one on 127.0.0.1 it replaces never answers there.
    for _ in 0..200 {
        if TcpStream::connect(("127.0.0.2", daemon)).await.is_ok() {
            let own = format!("sandbox-{SANDBOX_ID}.sbx.test");
            assert_eq!(
                get(daemon, &own, "/moved", &[]).await.body,
                format!("node saw {own} /moved mark=-")
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the daemon's port was never bound on its new host");
}

// Past hyper's 30 s for a request head, and past the 10 s a loopback connection has to classify itself, with room for
// a loaded machine: a connection still open here was never going to be closed.
const STALLED_GIVE_UP: Duration = Duration::from_secs(45);

// Whether netd hangs up on `stream` before `STALLED_GIVE_UP`, and how long it took.
async fn hung_up(mut stream: TcpStream) -> Option<Duration> {
    let started = std::time::Instant::now();
    let mut buffer = [0_u8; 256];
    tokio::time::timeout(STALLED_GIVE_UP, async {
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    })
    .await
    .ok()
    .map(|()| started.elapsed())
}

#[tokio::test]
async fn a_request_head_that_never_ends_is_hung_up_on() {
    let (_harness, daemon, _preview, _loopback) = started("slow-head", upstream().await).await;
    let mut stream = TcpStream::connect(("127.0.0.1", daemon)).await.unwrap();
    stream
        .write_all(format!("GET / HTTP/1.1\r\nHost: sandbox-{SANDBOX_ID}.sbx.test\r\n").as_bytes())
        .await
        .unwrap();
    let took = hung_up(stream)
        .await
        .expect("netd hangs up on a head that never ends");
    assert!(took >= Duration::from_secs(25), "hung up after {took:?}");
}

#[tokio::test]
async fn a_tls_handshake_that_never_ends_is_hung_up_on() {
    let (harness, _daemon, _preview, loopback) = started("slow-tls", upstream().await).await;
    let issued =
        rcgen::generate_simple_self_signed(vec![format!("{SANDBOX_ID}.local.sbx.test")]).unwrap();
    harness
        .send(&FromNode::Certificate {
            certificate: Some(Certificate {
                certificate: issued.cert.pem(),
                private_key: issued.signing_key.serialize_pem(),
            }),
        })
        .await;
    // The certificate lands asynchronously; without one a hello is closed at once, which proves nothing here.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut stream = TcpStream::connect(("127.0.0.1", loopback)).await.unwrap();
    // A TLS record header and nothing of the hello it announces.
    stream
        .write_all(&[0x16, 0x03, 0x01, 0x02, 0x00])
        .await
        .unwrap();
    let took = hung_up(stream)
        .await
        .expect("netd hangs up on a handshake that never ends");
    assert!(took >= Duration::from_secs(5), "hung up after {took:?}");
}

#[tokio::test]
async fn the_loopback_port_speaks_h2_over_tls_once_it_holds_a_certificate() {
    let (harness, _daemon, _preview, loopback) = started("tls", upstream().await).await;
    let name = format!("{SANDBOX_ID}.local.sbx.test");
    let issued = rcgen::generate_simple_self_signed(vec![name.clone()]).unwrap();
    harness
        .send(&FromNode::Certificate {
            certificate: Some(Certificate {
                certificate: issued.cert.pem(),
                private_key: issued.signing_key.serialize_pem(),
            }),
        })
        .await;
    let mut roots = rustls::RootCertStore::empty();
    roots.add(issued.cert.der().clone()).unwrap();
    let mut client = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    client.alpn_protocols = vec![b"h2".to_vec()];
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client));
    let server_name = rustls::pki_types::ServerName::try_from(name.clone()).unwrap();
    // The certificate lands asynchronously; the first hellos may meet the plain-only listener.
    let tls = loop {
        let tcp = TcpStream::connect(("127.0.0.1", loopback)).await.unwrap();
        if let Ok(tls) = connector.connect(server_name.clone(), tcp).await {
            break tls;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    assert_eq!(tls.get_ref().1.alpn_protocol(), Some(&b"h2"[..]));
    let (mut sender, connection) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(tls))
            .await
            .unwrap();
    tokio::spawn(connection);
    let request = Request::builder()
        .uri(format!("https://{name}:28123/info"))
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
    assert_eq!(body, format!("node saw {name}:28123 /info mark=-"));
}

// Far below the 30 s a request for a restarting Node waits before its 503, and far above any answer netd makes
// itself: a vitals request that waited for Node fails here instead of passing late.
const WITHOUT_NODE: Duration = Duration::from_secs(10);

async fn vitals(port: u16, host: &str) -> (Answer, SandboxVitals) {
    let answer = tokio::time::timeout(WITHOUT_NODE, get(port, host, "/system/vitals", &[]))
        .await
        .expect("netd answers its vitals without waiting for Node");
    assert_eq!(answer.status, 200, "{}", answer.body);
    let vitals = serde_json::from_str(&answer.body).unwrap();
    (answer, vitals)
}

// Until netd's view of Node settles on `node`: a hello and a new connection land asynchronously.
async fn vitals_once(
    port: u16,
    host: &str,
    settled: impl Fn(&SandboxVitals) -> bool,
) -> SandboxVitals {
    for _ in 0..250 {
        let (_, read) = vitals(port, host).await;
        if settled(&read) {
            return read;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the vitals never settled");
}

#[tokio::test]
async fn the_netd_answers_its_vitals_itself_whatever_state_node_is_in() {
    let harness = Harness::start("vitals", Arc::new(|_: &str, _| support::nothing_here())).await;
    let (daemon, preview, loopback) = (free_port(), free_port(), free_port());
    harness
        .send(&FromNode::Listen {
            config: config(daemon, preview, loopback),
        })
        .await;
    bound(daemon).await;
    let own = format!("sandbox-{SANDBOX_ID}.sbx.test");

    // Node has handed over its ports and not said hello.
    let (answer, starting) = vitals(daemon, &own).await;
    assert_eq!(
        (starting.node, starting.lag_ms, starting.restarts),
        (NodeLink::Starting, None, 0)
    );
    assert_eq!(answer.headers["content-type"], "application/json");
    assert_eq!(answer.headers["cache-control"], "no-store");
    assert_eq!(answer.headers["access-control-allow-origin"], "*");
    assert!(
        answer
            .headers
            .get("access-control-allow-credentials")
            .is_none()
    );

    // Up, and pinged at once: the stand-in answers every ping.
    harness.hello().await;
    let up = vitals_once(daemon, &own, |read| read.lag_ms.is_some()).await;
    assert_eq!(up.node, NodeLink::Up);
    let preflight = send(
        daemon,
        "OPTIONS",
        &own,
        "/system/vitals",
        &[
            ("origin", "https://app.example"),
            ("access-control-request-method", "GET"),
            ("access-control-request-headers", "authorization"),
        ],
    )
    .await;
    assert_eq!(preflight.status, 204);
    assert_eq!(preflight.headers["access-control-allow-origin"], "*");
    assert_eq!(
        preflight.headers["access-control-allow-headers"],
        "authorization"
    );
    // The daemon's name on the tunnel's port is the daemon's too; a preview's app keeps its own path of that name.
    assert_eq!(vitals(preview, &own).await.1.node, NodeLink::Up);
    let web = format!("preview-web-{SANDBOX_ID}.sbx.test");
    let previewed = get(preview, &web, "/system/vitals", &[]).await;
    assert_eq!(
        (previewed.status, previewed.body.as_str()),
        (404, "no preview here")
    );

    // Whatever else dials the control socket leaves Node's link as it was: here an agent that took it for HTTP.
    let mut stray = tokio::net::UnixStream::connect(harness.dir.join("netd.sock"))
        .await
        .unwrap();
    stray
        .write_all(b"GET /agents HTTP/1.1\r\nHost: sandbox\r\n\r\n")
        .await
        .unwrap();
    let mut refused = String::new();
    stray.read_to_string(&mut refused).await.unwrap();
    assert!(refused.starts_with("HTTP/1.1 400 "), "{refused}");
    assert_eq!(vitals(daemon, &own).await.1.node, NodeLink::Up);

    // A second daemon's first frame no longer takes the link from one that said hello (2026-10-05): it is held back
    // until its own hello, which takes the link only when it names a newer start.
    let mut next = tokio::net::UnixStream::connect(harness.dir.join("netd.sock"))
        .await
        .unwrap();
    let first = FromNode::Unwatch {
        dir: "/nowhere".into(),
    };
    next.write_all(&netd_wire::frame(&first).unwrap())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(vitals(daemon, &own).await.1.node, NodeLink::Up);
    let newer = FromNode::Hello {
        build: "test".into(),
        pid: 2,
        generation: Some(2),
    };
    next.write_all(&netd_wire::frame(&newer).unwrap())
        .await
        .unwrap();
    // The newer start holds the link: it is told where the tunnel stands, as every Node that says hello is, and the
    // netd's next ping goes to it.
    let pinged = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let mut length = [0_u8; netd_wire::LENGTH_BYTES];
            next.read_exact(&mut length).await.unwrap();
            let mut told = vec![0; u32::from_be_bytes(length) as usize];
            next.read_exact(&mut told).await.unwrap();
            if let netd_wire::ToNode::Ask {
                question: netd_wire::Question::Ping,
                ..
            } = serde_json::from_slice::<netd_wire::ToNode>(&told).unwrap()
            {
                return;
            }
        }
    });
    pinged
        .await
        .expect("netd pings the daemon holding the link");
    // And once it goes, netd reads Node as restarting.
    drop(next);
    let restarting = vitals_once(daemon, &own, |read| read.node != NodeLink::Up).await;
    assert_eq!(
        (restarting.node, restarting.lag_ms),
        (NodeLink::Restarting, None)
    );
}
