//! The tunnel over QUIC where UDP reaches the edge, held beside the WebSocket lanes rather than instead of them: the edge
//! sends every request down it while it lasts, and the lanes already standing carry everything the moment it goes. Each
//! stream the edge opens is one HTTP/1.1 exchange, served like any request the tunnel brings.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use front_wire::TunnelConfig;
use http::Uri;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use quinn::crypto::rustls::QuicClientConfig;
use quinn::{ConnectionError, Endpoint, RecvStream, SendStream, VarInt};
use tokio::sync::watch;
use tunnel::Close;
use tunnel::quic::{DISPLACED, Hello, REFUSED};

use crate::proxy::Front;
use crate::tunnel::{BACKOFF_CAP, BACKOFF_FLOOR, DISPLACED_WAIT, STABLE_AFTER, jitter, trusted};

// A handshake or hello not answered by now is UDP that does not reach the edge.
const HANDSHAKE_PATIENCE: Duration = Duration::from_secs(5);

// Where UDP never reached the edge, or the edge refused the hello, trying again soon would only repeat it.
const UNREACHABLE_WAIT: Duration = Duration::from_secs(300);

enum Ended {
    Unreachable(String),
    Displaced,
    Dropped(String),
    ClosedHere,
}

/// Dials and holds the QUIC tunnel for as long as `closed` stays empty.
pub async fn run(
    front: Arc<Front>,
    config: TunnelConfig,
    mut closed: watch::Receiver<Option<Close>>,
) {
    let mut rung = BACKOFF_FLOOR;
    loop {
        let started = Instant::now();
        let wait = match dial_once(&front, &config, closed.clone()).await {
            Ended::ClosedHere => return,
            Ended::Unreachable(why) => {
                tracing::info!(%why, "QUIC does not reach the edge; the WebSocket lanes carry the tunnel");
                UNREACHABLE_WAIT
            }
            Ended::Displaced => {
                tracing::warn!("another tunnel took this sandbox's QUIC connection; standing back");
                DISPLACED_WAIT
            }
            Ended::Dropped(why) => {
                tracing::warn!(%why, "the QUIC tunnel dropped; the WebSocket lanes carry it meanwhile");
                if started.elapsed() >= STABLE_AFTER {
                    rung = BACKOFF_FLOOR;
                }
                let ceiling = (rung * 2).min(BACKOFF_CAP);
                rung = ceiling;
                BACKOFF_FLOOR + (ceiling - BACKOFF_FLOOR).mul_f64(jitter())
            }
        };
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            _ = tunnel::raised(&mut closed) => return,
        }
    }
}

async fn dial_once(
    front: &Arc<Front>,
    config: &TunnelConfig,
    mut closed: watch::Receiver<Option<Close>>,
) -> Ended {
    let Some((host, port)) = edge_address(&config.url) else {
        return Ended::Unreachable(format!("{} names no host", config.url));
    };
    let address = match tokio::net::lookup_host((host.as_str(), port))
        .await
        .map(|mut found| found.next())
    {
        Ok(Some(address)) => address,
        Ok(None) => return Ended::Unreachable(format!("{host} resolves to nothing")),
        Err(error) => return Ended::Dropped(format!("{host} did not resolve: {error}")),
    };
    let bind: SocketAddr = if address.is_ipv6() {
        "[::]:0"
    } else {
        "0.0.0.0:0"
    }
    .parse()
    .expect("an unspecified address parses");
    let endpoint = match Endpoint::client(bind) {
        Ok(endpoint) => endpoint,
        Err(error) => return Ended::Dropped(format!("no UDP socket: {error}")),
    };
    let connection = match endpoint.connect_with(client_config(), address, &host) {
        Ok(connecting) => match tokio::time::timeout(HANDSHAKE_PATIENCE, connecting).await {
            Ok(Ok(connection)) => connection,
            Ok(Err(error)) => return Ended::Unreachable(format!("the handshake failed: {error}")),
            Err(_) => return Ended::Unreachable("no handshake answer".into()),
        },
        Err(error) => return Ended::Unreachable(format!("could not dial: {error}")),
    };
    match tokio::time::timeout(
        HANDSHAKE_PATIENCE,
        tunnel::quic::hello(&connection, &config.grant),
    )
    .await
    {
        Ok(Ok(Hello::Held)) => {}
        Ok(Ok(refusal)) => {
            return Ended::Unreachable(format!("the edge refused the hello: {refusal:?}"));
        }
        Ok(Err(error)) => return Ended::Dropped(format!("the hello failed: {error}")),
        Err(_) => return Ended::Dropped("the hello went unanswered".into()),
    }
    tracing::info!("reachable over QUIC: the edge carries requests on it");
    let serving = connection.clone();
    let front = front.clone();
    let accepting = tokio::spawn(async move {
        while let Ok((send, recv)) = serving.accept_bi().await {
            tokio::spawn(serve(front.clone(), send, recv));
        }
    });
    let ended = tokio::select! {
        error = connection.closed() => match error {
            ConnectionError::ApplicationClosed(close) if close.error_code == DISPLACED => Ended::Displaced,
            ConnectionError::ApplicationClosed(close) if close.error_code == REFUSED => {
                Ended::Unreachable("the edge refused the tunnel".into())
            }
            other => Ended::Dropped(other.to_string()),
        },
        close = tunnel::raised(&mut closed) => {
            connection.close(VarInt::from_u32(u32::from(close.code)), close.reason.as_bytes());
            Ended::ClosedHere
        }
    };
    accepting.abort();
    let _ = tokio::time::timeout(Duration::from_secs(1), endpoint.wait_idle()).await;
    ended
}

// One exchange the edge opened: plain HTTP/1.1, where an upgrade is itself.
async fn serve(front: Arc<Front>, send: SendStream, recv: RecvStream) {
    let service = service_fn(move |request| {
        let front = front.clone();
        async move { Ok::<_, Infallible>(front.tunnel(request).await) }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(tunnel::quic::stream(send, recv)), service)
        .with_upgrades()
        .await;
}

// The edge's name and port, as the tunnel URL spells them; `wss` defaults to 443, which UDP shares.
fn edge_address(url: &str) -> Option<(String, u16)> {
    let uri: Uri = url.parse().ok()?;
    let host = uri
        .host()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    Some((host, uri.port_u16().unwrap_or(443)))
}

fn client_config() -> quinn::ClientConfig {
    let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .expect("ring supports TLS 1.3")
    .with_root_certificates(trusted())
    .with_no_client_auth();
    tls.alpn_protocols = vec![tunnel::quic::ALPN.to_vec()];
    let mut config = quinn::ClientConfig::new(Arc::new(
        QuicClientConfig::try_from(tls).expect("a TLS 1.3 config suits QUIC"),
    ));
    config.transport_config(tunnel::quic::transport());
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_edge_is_the_tunnel_urls_host_on_its_port_or_443() {
        assert_eq!(
            edge_address("wss://ingress.sbx.example.test/tunnel/v1"),
            Some(("ingress.sbx.example.test".into(), 443))
        );
        assert_eq!(
            edge_address("wss://127.0.0.1:8443/tunnel/v1"),
            Some(("127.0.0.1".into(), 8443))
        );
        assert_eq!(
            edge_address("wss://[::1]:8443/tunnel/v1"),
            Some(("::1".into(), 8443))
        );
    }
}
