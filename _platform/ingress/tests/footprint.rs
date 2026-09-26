//! What the edge process holds idle and with a thousand tunnels, each a real WebSocket with a yamux session down it. A
//! measurement, so ignored: `cargo build --release`, then with EDGE_BIN=$PWD/target/release/intentic-ingress,
//! `cargo test --release --test footprint -- --ignored --nocapture`.

mod support;

use std::time::Duration;

use tokio::process::Command;

use support::{Keys, daemon_host, dial, get, serving};

const TUNNELS: usize = 1000;

fn resident_kib(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "a measurement: run with --ignored and EDGE_BIN set"]
async fn memory_held_per_tunnel() {
    let keys = Keys::default();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let internal = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let edge = Command::new(std::env::var("EDGE_BIN").expect("EDGE_BIN names the edge's binary"))
        .env("INGRESS_PUBLIC_KEY", &keys.public_pem)
        .env("INGRESS_HOST", "127.0.0.1")
        .env("INGRESS_PORT", port.to_string())
        .env("INGRESS_INTERNAL_HOST", "127.0.0.1")
        .env("INGRESS_INTERNAL_PORT", internal.to_string())
        .env("PLATFORM_URL", "")
        .env("LOG_LEVEL", "warn")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let pid = edge.id().unwrap();
    for _ in 0..200 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let idle = resident_kib(pid);

    let mut sandboxes = Vec::with_capacity(TUNNELS);
    for index in 0..TUNNELS {
        let id = format!("{index:012x}");
        sandboxes.push(dial(port, &keys.grant(&id), serving("held")).await.unwrap());
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    for index in (0..TUNNELS).step_by(100) {
        let answer = get(port, &daemon_host(&format!("{index:012x}")), "/").await;
        assert_eq!(answer.status, 200);
    }
    let held = resident_kib(pid);
    println!(
        "edge RSS idle {} KiB, with {TUNNELS} tunnels {} KiB: {:.1} KiB a tunnel",
        idle,
        held,
        (held - idle) as f64 / TUNNELS as f64
    );
    drop(sandboxes);
}
