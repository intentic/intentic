//! Round trips through the real edge in front of this front: `EDGE_BIN` names the edge's binary (_platform/ingress,
//! `cargo build --release` there). A measurement, not a check, so ignored:
//!   EDGE_BIN=<path> cargo test --release --test edge_rtt -- --ignored --nocapture

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use bytes::Bytes;
use front_wire::{Endpoint, FromNode, ListenConfig, TunnelConfig};
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper_util::rt::TokioIo;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use tokio::net::TcpStream;
use tokio::process::Command;

use support::{Harness, SANDBOX_ID, bound, free_port};

const WARM: usize = 300;
const TIMED: usize = 3000;
const CONCURRENT: usize = 16;
const EACH: usize = 500;
const DOWNLOAD: usize = 64 * 1024 * 1024;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "a measurement: run with --ignored and EDGE_BIN set"]
async fn round_trips_through_a_real_edge() {
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
    let payload = format!(r#"{{"sub":"{SANDBOX_ID}","iat":1700000000}}"#);
    let grant = format!(
        "ig1.{}.{}",
        URL_SAFE_NO_PAD.encode(&payload),
        URL_SAFE_NO_PAD.encode(pair.sign(payload.as_bytes()).as_ref())
    );

    let (port, internal) = (free_port(), free_port());
    let mut edge =
        Command::new(std::env::var("EDGE_BIN").expect("EDGE_BIN names the edge's binary"));
    let _edge = edge
        .env("INGRESS_PUBLIC_KEY", &public)
        .env("INGRESS_HOST", "127.0.0.1")
        .env("INGRESS_PORT", port.to_string())
        .env("INGRESS_INTERNAL_HOST", "127.0.0.1")
        .env("INGRESS_INTERNAL_PORT", internal.to_string())
        .env("PLATFORM_URL", "")
        .env("LOG_LEVEL", "warn")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    bound(port).await;

    let harness = Harness::start("edge-rtt", Arc::new(|_: &str, _| support::nothing_here())).await;
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
                url: format!("ws://127.0.0.1:{port}/tunnel/v2"),
                grant,
                bulk: vec![],
            }),
        })
        .await;
    harness.hello().await;
    let mut tunnel = harness.tunnel.clone();
    tunnel
        .wait_for(|connected| *connected == Some(true))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let host = format!("sandbox-{SANDBOX_ID}.sbx.test");

    let mut sender = connect(port).await;
    for _ in 0..WARM {
        fetch(&mut sender, &host, "/health").await;
    }
    let mut took = Vec::with_capacity(TIMED);
    for _ in 0..TIMED {
        let started = Instant::now();
        fetch(&mut sender, &host, "/health").await;
        took.push(started.elapsed());
    }
    took.sort();
    let at =
        |share: f64| took[((took.len() as f64 * share) as usize).min(took.len() - 1)].as_micros();

    let started = Instant::now();
    let length = fetch(&mut sender, &host, &format!("/bench/bytes/{DOWNLOAD}")).await;
    assert_eq!(length, DOWNLOAD);
    let download = DOWNLOAD as f64 / 1e6 / started.elapsed().as_secs_f64();

    let started = Instant::now();
    let clients: Vec<_> = (0..CONCURRENT)
        .map(|_| {
            let host = host.clone();
            tokio::spawn(async move {
                let mut sender = connect(port).await;
                for _ in 0..EACH {
                    fetch(&mut sender, &host, "/health").await;
                }
            })
        })
        .collect();
    for client in clients {
        client.await.unwrap();
    }
    let rate = (CONCURRENT * EACH) as f64 / started.elapsed().as_secs_f64();

    println!(
        "small request p50 {} µs, p90 {}, p99 {}, max {}; {download:.0} MB/s down; {rate:.0} requests/s from {CONCURRENT} clients",
        at(0.5),
        at(0.9),
        at(0.99),
        took.last().unwrap().as_micros()
    );
}

async fn connect(port: u16) -> hyper::client::conn::http1::SendRequest<Empty<Bytes>> {
    let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
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
