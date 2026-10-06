//! The tunnel over QUIC, dialled only once the edge has declared it serves one (its answer to the socket's upgrade names
//! `quic`), and held beside the WebSocket rather than instead of it: the edge sends every request down it while it
//! lasts, and the socket already standing carries everything the moment it goes. Each stream the edge opens is one
//! HTTP/1.1 connection, served as the socket's streams are (`Netd::serve_stream`), except the edge's probe, answered
//! here. A network that carries no UDP to a declaring edge is retried on the socket's own ladder, never probed for.
//!
//! 2026-10-05: the hello waits `tunnel::HELLO_PATIENCE`, past the edge's slowest answer (it was 5 s, the same as the
//! edge's platform lookup, so the edge could register a connection this netd had abandoned), carries this netd's
//! identity, and is acknowledged before the edge registers it. A dead accept loop now closes the connection.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use http::Uri;
use netd_wire::TunnelConfig;
use quinn::crypto::rustls::QuicClientConfig;
use quinn::{ConnectionError, Endpoint, VarInt};
use tokio::sync::watch;
use tunnel::quic::{DELETED, DEMOTED, DISPLACED, HELD_ELSEWHERE, Hello, REFUSED};
use tunnel::{Close, HELLO_PATIENCE, Heard, Identity};

use crate::proxy::Netd;
use crate::standing::{Outcome, Pace, Standing};
use crate::tunnel::trusted;

// A connection held this long counts as working: the next failure is news again.
const STABLE_AFTER: Duration = Duration::from_secs(60);

// A TLS handshake not answered by now is UDP that does not reach the edge; the edge answers it without asking anyone.
const HANDSHAKE_PATIENCE: Duration = Duration::from_secs(5);

// How a dial ended, as `standing.rs` paces the next, or this end closing it.
enum Dialled {
    Ended(Outcome),
    ClosedHere,
}

/// Dials and holds the QUIC tunnel whenever `declared` holds, for as long as `closed` stays empty.
pub async fn run(
    netd: Arc<Netd>,
    config: TunnelConfig,
    identity: Identity,
    standing: Arc<Standing>,
    mut declared: watch::Receiver<bool>,
    mut closed: watch::Receiver<Option<Close>>,
) {
    let mut pace = Pace::default();
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
        let dialled = dial_once(&netd, &config, &identity, &standing, closed.clone()).await;
        standing.quic(false);
        let lived = started.elapsed();
        let outcome = match dialled {
            Dialled::ClosedHere => return,
            Dialled::Ended(outcome) => outcome,
        };
        if lived >= STABLE_AFTER || matches!(outcome, Outcome::Dropped { proven: true, .. }) {
            told = false;
        }
        let next = pace.next(&outcome, lived);
        let reason = outcome.reason();
        match &outcome {
            Outcome::Displaced | Outcome::Elsewhere(_) => {
                tracing::warn!(%reason, wait = ?next.wait, "standing back from the QUIC tunnel");
            }
            Outcome::Deleted => {
                tracing::warn!(wait = ?next.wait, "the platform deleted this sandbox; no longer dialling QUIC");
            }
            Outcome::Demoted => {
                tracing::warn!(wait = ?next.wait, "the edge demoted the QUIC tunnel; the WebSocket carries it meanwhile");
            }
            Outcome::Dropped { .. } => {
                if told {
                    tracing::debug!(%reason, "the QUIC tunnel is still not held");
                } else {
                    tracing::info!(%reason, "the edge declares QUIC and it is not held; the WebSocket carries the tunnel meanwhile");
                    told = true;
                }
            }
        }
        tokio::select! {
            () = tokio::time::sleep(next.wait) => {}
            _ = tunnel::raised(&mut closed) => return,
        }
    }
}

fn dropped(why: String) -> Dialled {
    Dialled::Ended(Outcome::Dropped { why, proven: false })
}

async fn dial_once(
    netd: &Arc<Netd>,
    config: &TunnelConfig,
    identity: &Identity,
    standing: &Standing,
    mut closed: watch::Receiver<Option<Close>>,
) -> Dialled {
    let Some((host, port)) = edge_address(&config.url) else {
        return dropped(format!("{} names no host", config.url));
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
        Ok(None) => return dropped(format!("{host} resolves to nothing")),
        Err(error) => return dropped(format!("{host} did not resolve: {error}")),
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
        Err(error) => return dropped(format!("no UDP socket: {error}")),
    };
    let connection = match endpoint.connect_with(client_config(), address, &host) {
        Ok(connecting) => match tokio::time::timeout(HANDSHAKE_PATIENCE, connecting).await {
            Ok(Ok(connection)) => connection,
            Ok(Err(error)) => return dropped(format!("the handshake failed: {error}")),
            Err(_) => return dropped("no handshake answer".into()),
        },
        Err(error) => return dropped(format!("could not dial: {error}")),
    };
    let greeting = match tokio::time::timeout(
        HELLO_PATIENCE,
        tunnel::quic::introduce(&connection, &config.grant, identity),
    )
    .await
    {
        Ok(Ok(greeting)) => greeting,
        Ok(Err(error)) => return dropped(format!("the hello failed: {error}")),
        Err(_) => {
            // Said, so the edge drops it at once rather than after its idle timeout.
            connection.close(VarInt::from_u32(0), b"the hello went unanswered");
            return dropped("the hello went unanswered".into());
        }
    };
    match greeting.hello {
        Hello::Held => {}
        Hello::Gone => return Dialled::Ended(Outcome::Deleted),
        Hello::HeldElsewhere => return Dialled::Ended(Outcome::Elsewhere(greeting.holder)),
        Hello::Refused => return dropped("the edge refused the hello: no valid grant".into()),
    }
    tracing::info!("reachable over QUIC: the edge carries requests on it");
    standing.quic(true);
    // Marked by every probe this netd answers: a carrier that served one worked, whatever ends it later.
    let heard = Arc::new(Heard::default());
    let serving = connection.clone();
    let netd = netd.clone();
    let probed = heard.clone();
    let mut accepting = tokio::spawn(async move {
        while let Ok((send, recv)) = serving.accept_bi().await {
            let netd = netd.clone();
            let probed = probed.clone();
            tokio::spawn(async move {
                match tunnel::quic::accepted(send, recv).await {
                    Some(stream) => netd.serve_stream(stream).await,
                    None => probed.answer(),
                }
            });
        }
    });
    let ended = tokio::select! {
        error = connection.closed() => Dialled::Ended(outcome_of(error, &heard)),
        // Its streams would arrive nowhere: the edge would send requests down a connection nobody serves.
        _ = &mut accepting => {
            connection.close(VarInt::from_u32(0), b"the accept loop ended");
            dropped("the accept loop ended".into())
        }
        close = tunnel::raised(&mut closed) => {
            connection.close(VarInt::from_u32(u32::from(close.code)), close.reason.as_bytes());
            Dialled::ClosedHere
        }
    };
    accepting.abort();
    let _ = tokio::time::timeout(Duration::from_secs(1), endpoint.wait_idle()).await;
    ended
}

// What the edge's close of a held connection says.
fn outcome_of(error: ConnectionError, heard: &Heard) -> Outcome {
    match error {
        ConnectionError::ApplicationClosed(close) if close.error_code == DISPLACED => {
            Outcome::Displaced
        }
        ConnectionError::ApplicationClosed(close) if close.error_code == HELD_ELSEWHERE => {
            Outcome::Elsewhere(String::from_utf8_lossy(&close.reason).into_owned())
        }
        ConnectionError::ApplicationClosed(close) if close.error_code == DELETED => {
            Outcome::Deleted
        }
        ConnectionError::ApplicationClosed(close) if close.error_code == DEMOTED => {
            Outcome::Demoted
        }
        ConnectionError::ApplicationClosed(close) if close.error_code == REFUSED => {
            Outcome::Dropped {
                why: "the edge refused the tunnel".into(),
                proven: false,
            }
        }
        other => Outcome::Dropped {
            why: other.to_string(),
            proven: heard.answered(),
        },
    }
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
