//! The public listener as the edge binds it by default (`::`), reached the two ways it is on Fly: IPv4 from Fly's proxy,
//! and IPv6 from a peer machine forwarding a request for a tunnel only it does not hold, over the IPv6-only private
//! network. Bound to `0.0.0.0` the peer's forward was refused, and every sandbox whose tunnel sat on the other machine
//! answered `no-tunnel` (2026-11-04, after a deploy rolled both machines).

use http::Response;
use intentic_ingress::body;
use intentic_ingress::serve;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

// What the listener read the caller's address as, from a bare HTTP/1.1 request.
async fn seen_from(address: &str) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: edge\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    answer
        .rsplit("\r\n\r\n")
        .next()
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn the_default_public_listener_takes_a_peers_ipv6_forward_and_reads_ipv4_callers_as_ipv4() {
    let config_host = intentic_ingress::config::Config::from_env().unwrap().host;
    let listening = serve::listen((config_host.as_str(), 0), |_request, remote| async move {
        Response::new(body::full(remote.ip().to_string()))
    })
    .await
    .unwrap();
    let port = listening.address.port();
    assert_eq!(seen_from(&format!("[::1]:{port}")).await, "::1");
    assert_eq!(seen_from(&format!("127.0.0.1:{port}")).await, "127.0.0.1");
    listening.stop().await;
}
