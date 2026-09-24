//! Round trips through the real edge in a network namespace whose link to this front drops and delays packets, the edge
//! reached by QUIC or by the TCP lanes alone. A measurement needing root, so ignored: with EDGE_BIN naming the edge,
//! `cargo test --release --test edge_loss -- --ignored --nocapture --test-threads=1`; LOSS and DELAY_MS shape the link.

mod support;

use std::process::Command as Shell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use bytes::Bytes;
use front_wire::{Endpoint, FromNode, ListenConfig, PreviewRoute, TerminalPlan, TunnelConfig};
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper_util::rt::TokioIo;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;

use support::{Harness, SANDBOX_ID, bound, free_port};

const NAMESPACE: &str = "front-loss-edge";
// The lossy link the tunnel crosses, and a clean one the measuring client reaches the edge by.
const TUNNEL_EDGE: &str = "10.99.0.1";
const TUNNEL_FRONT: &str = "10.99.0.2";
const CLIENT_EDGE: &str = "10.98.0.1";
const CLIENT_SIDE: &str = "10.98.0.2";
const EDGE_TLS: u16 = 8443;
const EDGE_PLAIN: u16 = 8080;
const EDGE_INTERNAL: u16 = 8081;
const TIMED: usize = 400;
const DOWNLOAD: usize = 16 * 1024 * 1024;

fn sh(command: &str) {
    let status = Shell::new("sh").arg("-c").arg(command).status().unwrap();
    assert!(status.success(), "{command}");
}

// The namespace and both links, torn down whether or not the measurement finished.
struct Link;

impl Link {
    fn up(loss: &str, delay_ms: u32) -> Self {
        Self::down();
        sh(&format!("ip netns add {NAMESPACE}"));
        for (outside, inside, near, far, shaped) in [
            ("floss-t", "floss-te", TUNNEL_FRONT, TUNNEL_EDGE, true),
            ("floss-c", "floss-ce", CLIENT_SIDE, CLIENT_EDGE, false),
        ] {
            sh(&format!(
                "ip link add {outside} type veth peer name {inside}"
            ));
            sh(&format!("ip link set {inside} netns {NAMESPACE}"));
            sh(&format!(
                "ip addr add {near}/24 dev {outside} && ip link set {outside} up"
            ));
            sh(&format!(
                "ip netns exec {NAMESPACE} sh -c 'ip addr add {far}/24 dev {inside} && ip link set {inside} up && ip link set lo up'"
            ));
            if shaped {
                sh(&format!(
                    "tc qdisc add dev {outside} root netem delay {delay_ms}ms loss {loss}"
                ));
                sh(&format!(
                    "ip netns exec {NAMESPACE} tc qdisc add dev {inside} root netem delay {delay_ms}ms loss {loss}"
                ));
            }
        }
        Self
    }

    fn down() {
        let _ = Shell::new("sh")
            .arg("-c")
            .arg(format!("ip netns del {NAMESPACE} 2>/dev/null; ip link del floss-t 2>/dev/null; ip link del floss-c 2>/dev/null"))
            .status();
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        Self::down();
    }
}

fn grant_for(pair: &Ed25519KeyPair) -> String {
    let payload = format!(r#"{{"sub":"{SANDBOX_ID}","iat":1700000000}}"#);
    format!(
        "ig1.{}.{}",
        URL_SAFE_NO_PAD.encode(&payload),
        URL_SAFE_NO_PAD.encode(pair.sign(payload.as_bytes()).as_ref())
    )
}

struct Measured {
    idle: Vec<Duration>,
    loaded: Vec<Duration>,
    echo: Vec<Duration>,
    download: f64,
}

async fn measure(quic: bool, bulk: bool) -> Measured {
    let loss = std::env::var("LOSS").unwrap_or_else(|_| "2%".into());
    let delay_ms: u32 = std::env::var("DELAY_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(20);
    let _link = Link::up(&loss, delay_ms);
    let dir = std::env::temp_dir().join(format!("front-loss-{}-{quic}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let issued = rcgen::generate_simple_self_signed(vec![TUNNEL_EDGE.to_owned()]).unwrap();
    std::fs::write(dir.join("chain.pem"), issued.cert.pem()).unwrap();
    std::fs::write(dir.join("key.pem"), issued.signing_key.serialize_pem()).unwrap();

    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
    let mut spki = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    spki.extend_from_slice(pair.public_key().as_ref());
    let public = format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        STANDARD.encode(spki)
    );

    let mut edge = Command::new("ip");
    edge.args(["netns", "exec", NAMESPACE])
        .arg(std::env::var("EDGE_BIN").expect("EDGE_BIN names the edge's binary"))
        .env("INGRESS_PUBLIC_KEY", &public)
        .env("INGRESS_HOST", "0.0.0.0")
        .env("INGRESS_PORT", EDGE_PLAIN.to_string())
        .env("INGRESS_INTERNAL_HOST", "127.0.0.1")
        .env("INGRESS_INTERNAL_PORT", EDGE_INTERNAL.to_string())
        .env("INGRESS_TLS_PORT", EDGE_TLS.to_string())
        .env("INGRESS_TLS_CERT_FILE", dir.join("chain.pem"))
        .env("INGRESS_TLS_KEY_FILE", dir.join("key.pem"))
        .env("PLATFORM_URL", "")
        .env("LOG_LEVEL", "warn")
        .kill_on_drop(true);
    if quic {
        edge.env("INGRESS_QUIC_PORT", EDGE_TLS.to_string());
    }
    let _edge = edge.spawn().unwrap();
    for _ in 0..200 {
        if TcpStream::connect((CLIENT_EDGE, EDGE_PLAIN)).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let ca = dir.join("chain.pem");
    let harness = Harness::launch(
        &format!("loss-{quic}"),
        Arc::new(|_: &str| PreviewRoute::Node),
        Arc::new(|_: &str| {
            (
                TerminalPlan::Refused {
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
    harness
        .send(&FromNode::Tunnel {
            tunnel: Some(TunnelConfig {
                url: format!("wss://{TUNNEL_EDGE}:{EDGE_TLS}/tunnel/v1"),
                grant: grant_for(&pair),
            }),
        })
        .await;
    harness.hello().await;
    bound(daemon).await;
    let mut tunnel = harness.tunnel.clone();
    tunnel
        .wait_for(|connected| *connected == Some(true))
        .await
        .unwrap();
    // Long enough for the QUIC dial beside the lanes to finish its handshake and hello across the lossy link.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let host = format!("sandbox-{SANDBOX_ID}.sbx.test");

    let mut sender = connect().await;
    for _ in 0..20 {
        fetch(&mut sender, &host, "/health").await;
    }
    let idle = timed(&mut sender, &host).await;

    // A raw workspace read is a bulk route, which the TCP lanes keep off the calls' connection.
    let download = if bulk {
        format!("/workspace/raw?bench={DOWNLOAD}")
    } else {
        format!("/bench/bytes/{DOWNLOAD}")
    };
    let stop = Arc::new(AtomicBool::new(false));
    let downloading = {
        let host = host.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut sender = connect().await;
            let started = Instant::now();
            let mut bytes = 0;
            while !stop.load(Ordering::Relaxed) {
                bytes += fetch(&mut sender, &host, &download).await;
            }
            bytes as f64 / 1e6 / started.elapsed().as_secs_f64()
        })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let loaded = timed(&mut sender, &host).await;
    let echo = echoes(&host).await;
    stop.store(true, Ordering::Relaxed);
    let download = downloading.await.unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    Measured {
        idle,
        loaded,
        echo,
        download,
    }
}

async fn timed(
    sender: &mut hyper::client::conn::http1::SendRequest<Empty<Bytes>>,
    host: &str,
) -> Vec<Duration> {
    let mut took = Vec::with_capacity(TIMED);
    for _ in 0..TIMED {
        let started = Instant::now();
        fetch(sender, host, "/health").await;
        took.push(started.elapsed());
    }
    took.sort();
    took
}

// Keystrokes through an upgrade: one byte out, the same byte back, as a terminal feels it.
async fn echoes(host: &str) -> Vec<Duration> {
    let mut stream = TcpStream::connect((CLIENT_EDGE, EDGE_PLAIN)).await.unwrap();
    stream.set_nodelay(true).unwrap();
    stream
        .write_all(
            format!(
                "GET /ws HTTP/1.1\r\nHost: {host}\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    assert!(
        head.starts_with(b"HTTP/1.1 101"),
        "{}",
        String::from_utf8_lossy(&head)
    );
    let mut took = Vec::with_capacity(TIMED);
    for index in 0..TIMED {
        let started = Instant::now();
        stream.write_all(&[index as u8]).await.unwrap();
        stream.read_exact(&mut byte).await.unwrap();
        took.push(started.elapsed());
    }
    took.sort();
    took
}

async fn connect() -> hyper::client::conn::http1::SendRequest<Empty<Bytes>> {
    let stream = TcpStream::connect((CLIENT_EDGE, EDGE_PLAIN)).await.unwrap();
    stream.set_nodelay(true).unwrap();
    let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection);
    sender
}

async fn fetch(
    sender: &mut hyper::client::conn::http1::SendRequest<Empty<Bytes>>,
    host: &str,
    path: &str,
) -> usize {
    let request = Request::get(path)
        .header("host", host)
        .body(Empty::new())
        .unwrap();
    sender.ready().await.unwrap();
    let response = sender.send_request(request).await.unwrap();
    assert_eq!(response.status(), 200, "{path}");
    response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .len()
}

fn at(took: &[Duration], share: f64) -> u128 {
    took[((took.len() as f64 * share) as usize).min(took.len() - 1)].as_millis()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "a measurement needing root: run with --ignored and EDGE_BIN set"]
async fn round_trips_across_a_lossy_link_by_quic_and_by_the_tcp_lanes() {
    for (shape, quic, bulk) in [
        ("TCP, download on the calls' lane", false, false),
        ("TCP, download on the bulk lane", false, true),
        ("QUIC", true, true),
    ] {
        let measured = measure(quic, bulk).await;
        println!(
            "{shape}: call p50 {} ms, p99 {}; during a download p50 {}, p99 {}; keystroke echo p50 {}, p99 {}; download {:.1} MB/s",
            at(&measured.idle, 0.5),
            at(&measured.idle, 0.99),
            at(&measured.loaded, 0.5),
            at(&measured.loaded, 0.99),
            at(&measured.echo, 0.5),
            at(&measured.echo, 0.99),
            measured.download
        );
    }
}
