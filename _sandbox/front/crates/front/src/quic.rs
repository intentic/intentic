//! The tunnel over QUIC, dialled only once the edge has declared it serves one (its answer to the socket's upgrade names
//! `quic`), and held beside the WebSocket rather than instead of it: the edge sends every request down it while it
//! lasts, and the socket already standing carries everything the moment it goes. Each stream the edge opens is one
//! HTTP/1.1 connection, served as the socket's streams are (`Front::serve_stream`). A network that carries no UDP to a
//! declaring edge is retried on the socket's own ladder, never probed for.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use front_wire::TunnelConfig;
use http::Uri;
use quinn::crypto::rustls::QuicClientConfig;
use quinn::{ConnectionError, Endpoint, VarInt};
use tokio::sync::watch;
use tunnel::Close;
use tunnel::quic::{DISPLACED, Hello, REFUSED};

use crate::proxy::Front;
use crate::tunnel::{DISPLACED_WAIT, REDIAL, trusted};

// A connection held this long counts as working: the next failure is news again.
const STABLE_AFTER: Duration = Duration::from_secs(60);

// A handshake or hello not answered by now is UDP that does not reach the edge.
const HANDSHAKE_PATIENCE: Duration = Duration::from_secs(5);

enum Ended {
    Displaced,
    Dropped(String),
    ClosedHere,
}

/// Dials and holds the QUIC tunnel whenever `declared` holds, for as long as `closed` stays empty.
pub async fn run(
    front: Arc<Front>,
    config: TunnelConfig,
    mut declared: watch::Receiver<bool>,
    mut closed: watch::Receiver<Option<Close>>,
) {
    let mut backoff = REDIAL;
    // Said once per run of failures, so a network without UDP is one line, not one every backoff.
    let mut told = false;
    loop {
        tokio::select! {
            waited = declared.wait_for(|declared| *declared) => if waited.is_err() {
                return;
            },
            _ = tunnel::raised(&mut closed) => return,
        }
        let started = Instant::now();
        let ended = dial_once(&front, &config, closed.clone()).await;
        let lived = started.elapsed();
        if lived >= STABLE_AFTER {
            told = false;
        }
        let wait = match ended {
            Ended::ClosedHere => return,
            Ended::Displaced => {
                tracing::warn!("another tunnel took this sandbox's QUIC connection; standing back");
                DISPLACED_WAIT
            }
            Ended::Dropped(why) => {
                if told {
                    tracing::debug!(%why, "the QUIC tunnel is still not held");
                } else {
                    tracing::info!(%why, "the edge declares QUIC and it is not held; the WebSocket carries the tunnel meanwhile");
                    told = true;
                }
                backoff.after(lived)
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
        return Ended::Dropped(format!("{} names no host", config.url));
    };
    // IPv4 first: an edge on Fly takes UDP on its dedicated IPv4 only, and a resolver ranks an AAAA answer ahead of it.
    let address = match tokio::net::lookup_host((host.as_str(), port))
        .await
        .map(|found| {
            let found: Vec<SocketAddr> = found.collect();
            found
                .iter()
                .find(|address| address.is_ipv4())
                .or_else(|| found.first())
                .copied()
        }) {
        Ok(Some(address)) => address,
        Ok(None) => return Ended::Dropped(format!("{host} resolves to nothing")),
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
            Ok(Err(error)) => return Ended::Dropped(format!("the handshake failed: {error}")),
            Err(_) => return Ended::Dropped("no handshake answer".into()),
        },
        Err(error) => return Ended::Dropped(format!("could not dial: {error}")),
    };
    match tokio::time::timeout(
        HANDSHAKE_PATIENCE,
        tunnel::quic::hello(&connection, &config.grant),
    )
    .await
    {
        Ok(Ok(Hello::Held)) => {}
        Ok(Ok(refusal)) => {
            return Ended::Dropped(format!("the edge refused the hello: {refusal:?}"));
        }
        Ok(Err(error)) => return Ended::Dropped(format!("the hello failed: {error}")),
        Err(_) => return Ended::Dropped("the hello went unanswered".into()),
    }
    tracing::info!("reachable over QUIC: the edge carries requests on it");
    let serving = connection.clone();
    let front = front.clone();
    let accepting = tokio::spawn(async move {
        while let Ok((send, recv)) = serving.accept_bi().await {
            let front = front.clone();
            tokio::spawn(async move { front.serve_stream(tunnel::quic::stream(send, recv)).await });
        }
    });
    let ended = tokio::select! {
        error = connection.closed() => match error {
            ConnectionError::ApplicationClosed(close) if close.error_code == DISPLACED => Ended::Displaced,
            ConnectionError::ApplicationClosed(close) if close.error_code == REFUSED => {
                Ended::Dropped("the edge refused the tunnel".into())
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
            edge_address("wss://ingress.sbx.example.test/tunnel/v2"),
            Some(("ingress.sbx.example.test".into(), 443))
        );
        assert_eq!(
            edge_address("wss://127.0.0.1:8443/tunnel/v2"),
            Some(("127.0.0.1".into(), 8443))
        );
        assert_eq!(
            edge_address("wss://[::1]:8443/tunnel/v2"),
            Some(("::1".into(), 8443))
        );
    }
}
