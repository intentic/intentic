//! Reachability as outbound dials: two WebSockets at `/tunnel/v2`, `interactive` and `bulk`, each presenting the grant,
//! this netd's identity and the daemon's transfer routes, then serving every stream the edge opens on its yamux session
//! as one HTTP/1.1 connection (`Netd::serve_stream`), routed like any listener's request. Two, since streams on one TCP
//! connection still share its congestion window and its losses: the edge sends an announced transfer down the bulk
//! socket, and a keystroke never queues behind it. Neither ever gives up for long, since the tunnel is this sandbox's
//! reachability. The edge's answer declares what else it serves, and only a declared QUIC door is dialled (`quic.rs`),
//! beside the sockets.
//!
//! Each carrier redials at the pace its last dial set (`standing.rs`): a drop on the ladder, a displacement or another
//! copy's refusal standing back a drawn minute or two, three refusals in a row every 15 minutes, a deletion an hour.

use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::time::{Duration, Instant};

use http::{HeaderValue, StatusCode};
use netd_wire::TunnelConfig;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Error as SocketError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{Connector, MaybeTlsStream, connect_async_tls_with_config};
use tunnel::{
    BULK_HEADER, BulkRoutes, Close, DELETED_CODE, DISPLACED_CODE, Ended, GRANT_HEADER,
    HELD_ELSEWHERE_CODE, HOLDER_HEADER, HOST_HEADER, INSTANCE_HEADER, Identity, LANE_HEADER, Lane,
    Liveness, TRANSPORTS_HEADER, TUNNEL_PATH, Transport, mux,
};

use crate::link::Link;
use crate::proxy::Netd;
use crate::standing::{Outcome, Pace, Standing};

const TUNNEL_CA_ENV: &str = "INTENTIC_TUNNEL_CA";

// A dial the edge has not answered by now (TCP, TLS and the upgrade together) is a path that carries nothing; without a
// bound, one stalled dial held its carrier unreachable for good. Past the edge's slowest answer, which waits up to 5 s
// on the platform's existence check.
const DIAL_PATIENCE: Duration = Duration::from_secs(30);

// How long a session that ended waits for the socket's close frame, whose code says why it ended.
const CLOSE_HEARD_WITHIN: Duration = Duration::from_secs(1);

// Unsent bytes the kernel holds for the interactive socket: past this its session stops writing, so a keystroke is never
// queued behind a deep send buffer the way a transfer's bytes may be.
const INTERACTIVE_NOTSENT_LOWAT: libc::c_int = 16 * 1024;

// What both sockets send the edge when the sandbox stops, so it forgets them at once instead of after the dead window.
const SHUTTING_DOWN: Close = Close {
    code: 1001,
    reason: std::borrow::Cow::Borrowed("sandbox shutting down"),
};

// How long a stopping sandbox waits for every carrier's close to leave, all of them together. Node's grace
// (supervise.rs's STOP_GRACE) plus this stays inside the 30 s Docker gives a container to stop.
const SHUT_WAIT: Duration = Duration::from_secs(2);

// The config the carriers dial, their tasks, and what asks them to close.
type Running = (
    TunnelConfig,
    Vec<JoinHandle<()>>,
    watch::Sender<Option<Close>>,
);

pub struct Tunnel {
    netd: Arc<Netd>,
    link: &'static Link,
    identity: Identity,
    // The interactive socket's standing: what Node is told, since every request can ride it, and what the vitals show.
    standing: Arc<Standing>,
    running: Option<Running>,
}

impl Tunnel {
    pub fn new(
        netd: Arc<Netd>,
        link: &'static Link,
        identity: Identity,
        standing: Arc<Standing>,
    ) -> Self {
        Self {
            netd,
            link,
            identity,
            standing,
            running: None,
        }
    }

    /// Dials the new door on both sockets, or stops dialling; the same config again changes nothing.
    pub fn configure(&mut self, wanted: Option<TunnelConfig>) {
        if self.running.as_ref().map(|(config, _, _)| config) == wanted.as_ref() {
            return;
        }
        if let Some((_, dialling, closing)) = self.running.take() {
            closing.send_replace(Some(SHUTTING_DOWN));
            for carrier in dialling {
                carrier.abort();
            }
        }
        self.standing.configure(wanted.is_some());
        let _ = self.link.tell(&self.standing.report());
        let Some(config) = wanted else {
            return;
        };
        let (closing, closed) = watch::channel(None);
        // Whether the edge's last answer declared its QUIC door; nothing does until a socket has been answered.
        let (declaring, declared) = watch::channel(false);
        let declaring = Arc::new(declaring);
        let mut dialling: Vec<JoinHandle<()>> = Lane::ALL
            .into_iter()
            .map(|lane| {
                tokio::spawn(run(
                    Carrier {
                        netd: self.netd.clone(),
                        link: self.link,
                        config: config.clone(),
                        identity: self.identity.clone(),
                        lane,
                        standing: self.standing.clone(),
                        declaring: declaring.clone(),
                    },
                    closed.clone(),
                ))
            })
            .collect();
        // QUIC is TLS or nothing, and shares the TLS door's host and port, so a plaintext edge is left to the sockets.
        if config.url.starts_with("wss://") {
            dialling.push(tokio::spawn(crate::quic::run(
                self.netd.clone(),
                config.clone(),
                self.identity.clone(),
                self.standing.clone(),
                declared,
                closed,
            )));
        }
        self.running = Some((config, dialling, closing));
    }

    /// Tells a Node that just said hello where the tunnel stands.
    pub fn report_again(&self) {
        let _ = self.link.tell(&self.standing.report());
    }

    /// Closes both sockets and the QUIC connection with 1001 so the edge forgets them at once, and waits briefly for
    /// the closes to leave. The carriers close together under one wait, not one after another: this runs after Node's
    /// own grace, and a wait per carrier could take the container past Docker's stop timeout and into a SIGKILL.
    pub async fn shut(&mut self) {
        if let Some((_, dialling, closing)) = self.running.take() {
            closing.send_replace(Some(SHUTTING_DOWN));
            closed_within(dialling, SHUT_WAIT).await;
        }
    }
}

// Waits for every carrier to end, all at once, for `within` at most; one still going past that is left behind.
async fn closed_within(carriers: Vec<JoinHandle<()>>, within: Duration) {
    let _ = tokio::time::timeout(within, futures_util::future::join_all(carriers)).await;
}

// One socket's dialling: what it presents, and where its standing goes.
struct Carrier {
    netd: Arc<Netd>,
    link: &'static Link,
    config: TunnelConfig,
    identity: Identity,
    lane: Lane,
    standing: Arc<Standing>,
    // Where the edge's declaration goes, for the QUIC carrier.
    declaring: Arc<watch::Sender<bool>>,
}

// How one dial ended, and whether the edge registered it first.
struct Dialled {
    outcome: Outcome,
    registered: bool,
}

async fn run(carrier: Carrier, closed: watch::Receiver<Option<Close>>) {
    let reports = carrier.lane == Lane::Interactive;
    let mut pace = Pace::default();
    loop {
        let started = Instant::now();
        let Dialled {
            outcome,
            registered,
        } = dial_once(&carrier, closed.clone()).await;
        if closed.borrow().is_some() {
            return;
        }
        let next = pace.next(&outcome, started.elapsed());
        let reason = outcome.reason();
        let lane = carrier.lane.name();
        match &outcome {
            Outcome::Elsewhere(_) if next.refused.is_some() => tracing::warn!(
                lane, %reason, wait = ?next.wait,
                "another copy of this sandbox keeps the tunnel; dialling every 15 minutes until it stops"
            ),
            Outcome::Elsewhere(_) | Outcome::Displaced => {
                tracing::warn!(lane, %reason, wait = ?next.wait, "standing back from the tunnel")
            }
            Outcome::Deleted => tracing::warn!(
                lane, wait = ?next.wait,
                "the platform deleted this sandbox; no longer dialling the ingress"
            ),
            Outcome::Dropped { .. } | Outcome::Demoted => {
                tracing::warn!(lane, %reason, wait = ?next.wait, "the ingress tunnel dropped")
            }
        }
        if reports {
            carrier
                .standing
                .not_held(registered, reason, next.refused, Instant::now());
            let _ = carrier.link.tell(&carrier.standing.report());
        }
        tokio::time::sleep(next.wait).await;
    }
}

fn not_registered(outcome: Outcome) -> Dialled {
    Dialled {
        outcome,
        registered: false,
    }
}

fn dropped(why: String) -> Dialled {
    not_registered(Outcome::Dropped { why, proven: false })
}

async fn dial_once(carrier: &Carrier, closed: watch::Receiver<Option<Close>>) -> Dialled {
    let Carrier {
        netd,
        link,
        config,
        identity,
        lane,
        standing,
        declaring,
    } = carrier;
    let lane = *lane;
    let url = door(&config.url);
    let mut request = match url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => return dropped(format!("the tunnel URL is unusable: {error}")),
    };
    let announced = BulkRoutes::announce(&config.bulk);
    let headers = [
        (GRANT_HEADER, config.grant.as_str()),
        (LANE_HEADER, lane.name()),
        (BULK_HEADER, announced.as_str()),
        (INSTANCE_HEADER, identity.instance.as_str()),
        (HOST_HEADER, identity.host.as_str()),
    ];
    for (name, value) in headers {
        match HeaderValue::from_str(value) {
            Ok(value) => request.headers_mut().insert(name, value),
            Err(error) => return dropped(format!("{name} is not a header value: {error}")),
        };
    }
    let dialling = connect_async_tls_with_config(
        request,
        Some(tunnel::socket_config()),
        true,
        Some(Connector::Rustls(client_tls())),
    );
    let (socket, answer) = match tokio::time::timeout(DIAL_PATIENCE, dialling).await {
        Ok(Ok(opened)) => opened,
        Ok(Err(SocketError::Http(refused))) => return not_registered(refusal(&refused)),
        Ok(Err(error)) => return dropped(format!("could not dial the edge: {error}")),
        Err(_) => {
            return dropped(format!(
                "the edge did not answer the dial within {DIAL_PATIENCE:?}"
            ));
        }
    };
    let declared = Transport::declared(
        answer
            .headers()
            .get(TRANSPORTS_HEADER)
            .and_then(|value| value.to_str().ok()),
    );
    declaring.send_replace(declared.contains(&Transport::Quic));
    if lane == Lane::Interactive
        && let Some(tcp) = tcp_of(socket.get_ref())
    {
        notsent_lowat(tcp, INTERACTIVE_NOTSENT_LOWAT);
    }
    let (session_side, mut pumping) = tunnel::pump(socket, Liveness::Pings, closed);
    let heard = pumping.heard();
    let (mut streams, mut driving) = mux::server(session_side);
    let serving = netd.clone();
    let accepting = tokio::spawn(async move {
        while let Some(stream) = streams.recv().await {
            let netd = serving.clone();
            tokio::spawn(async move { netd.serve_stream(stream).await });
        }
    });
    if lane == Lane::Interactive {
        standing.held();
        let _ = link.tell(&standing.report());
    }
    tracing::info!(
        lane = lane.name(),
        "reachable: the ingress tunnel is registered"
    );

    let ended = tokio::select! {
        ended = pumping.ended() => ended,
        driven = &mut driving => {
            // The far end's close ends the session too, and may be read here first: its code says what to do next.
            match tokio::time::timeout(CLOSE_HEARD_WITHIN, pumping.ended()).await {
                Ok(closed @ Ended::Closed(_)) => closed,
                _ => Ended::Dropped(match driven {
                    Ok(Ok(())) => "the session ended".into(),
                    Ok(Err(error)) => format!("the session failed: {error}"),
                    Err(error) => error.to_string(),
                }),
            }
        }
    };
    driving.abort();
    accepting.abort();
    let outcome = match ended {
        Ended::Closed(Some(DISPLACED_CODE)) => Outcome::Displaced,
        Ended::Closed(Some(HELD_ELSEWHERE_CODE)) => {
            Outcome::Elsewhere(pumping.close_reason().unwrap_or_default())
        }
        Ended::Closed(Some(DELETED_CODE)) => Outcome::Deleted,
        Ended::Closed(code) => Outcome::Dropped {
            why: match code {
                Some(code) => format!("the edge closed the tunnel ({code})"),
                None => "the edge closed the tunnel".into(),
            },
            proven: heard.answered(),
        },
        Ended::Dropped(why) => Outcome::Dropped {
            why,
            proven: heard.answered(),
        },
    };
    Dialled {
        outcome,
        registered: true,
    }
}

// What an upgrade the edge answered with something other than 101 says: another copy holds the sandbox (409, naming
// where), the sandbox is deleted (403 with the edge's `unknown-sandbox` verdict), the edge predates this door (404),
// or anything else, which is a drop like any other.
fn refusal(answer: &http::Response<Option<Vec<u8>>>) -> Outcome {
    let header = |name: &str| {
        answer
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    match answer.status() {
        StatusCode::CONFLICT => Outcome::Elsewhere(header(HOLDER_HEADER).unwrap_or("").to_owned()),
        StatusCode::FORBIDDEN
            if header(browser_wire::VERDICT_HEADER)
                == Some(browser_wire::EdgeVerdict::UnknownSandbox.name()) =>
        {
            Outcome::Deleted
        }
        StatusCode::NOT_FOUND => Outcome::Dropped {
            why: format!(
                "the edge does not serve {TUNNEL_PATH}: it predates this netd, and serves it once redeployed"
            ),
            proven: false,
        },
        status => Outcome::Dropped {
            why: format!("the edge refused the tunnel: {status}"),
            proven: false,
        },
    }
}

// Node names the edge's door; whatever path it names, this netd dials the one it speaks.
fn door(url: &str) -> String {
    let origin = url
        .find("://")
        .and_then(|scheme| url[scheme + 3..].find('/').map(|path| scheme + 3 + path))
        .map_or(url, |path| &url[..path]);
    format!("{origin}{TUNNEL_PATH}")
}

fn tcp_of(stream: &MaybeTlsStream<TcpStream>) -> Option<&TcpStream> {
    match stream {
        MaybeTlsStream::Plain(tcp) => Some(tcp),
        MaybeTlsStream::Rustls(tls) => Some(tls.get_ref().0),
        _ => None,
    }
}

// Best effort: a kernel without TCP_NOTSENT_LOWAT keeps its default and the socket still works.
fn notsent_lowat(tcp: &TcpStream, bytes: libc::c_int) {
    // SAFETY: setsockopt on a socket this process owns, with a correctly sized int option.
    unsafe {
        libc::setsockopt(
            tcp.as_raw_fd(),
            libc::IPPROTO_TCP,
            libc::TCP_NOTSENT_LOWAT,
            (&raw const bytes).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
}

fn client_tls() -> Arc<rustls::ClientConfig> {
    Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .with_root_certificates(trusted())
        .with_no_client_auth(),
    )
}

/// The web's roots, and any a PEM file at `INTENTIC_TUNNEL_CA` names: a self-hosted edge on a private CA.
pub fn trusted() -> rustls::RootCertStore {
    let mut roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let Some(path) = std::env::var_os(TUNNEL_CA_ENV) else {
        return roots;
    };
    match std::fs::read(&path) {
        Ok(pem) => {
            for certificate in CertificateDer::pem_slice_iter(&pem).flatten() {
                let _ = roots.add(certificate);
            }
        }
        Err(error) => tracing::warn!(%error, path = ?path, "the tunnel's extra CA did not read"),
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answered(status: u16, headers: &[(&str, &str)]) -> http::Response<Option<Vec<u8>>> {
        let mut answer = http::Response::builder().status(status);
        for (name, value) in headers {
            answer = answer.header(*name, *value);
        }
        answer.body(None).unwrap()
    }

    #[test]
    fn an_answer_other_than_101_says_who_holds_the_sandbox_or_that_it_is_gone() {
        assert_eq!(
            refusal(&answered(409, &[(HOLDER_HEADER, "rog (linux)")])),
            Outcome::Elsewhere("rog (linux)".into())
        );
        assert_eq!(
            refusal(&answered(
                403,
                &[(browser_wire::VERDICT_HEADER, "unknown-sandbox")]
            )),
            Outcome::Deleted
        );
        // An edge from before the verdict on this answer: a refusal like any other, redialled on the ladder.
        assert!(matches!(
            refusal(&answered(403, &[])),
            Outcome::Dropped { .. }
        ));
        assert!(matches!(
            refusal(&answered(502, &[])),
            Outcome::Dropped { .. }
        ));
    }

    #[tokio::test]
    async fn carriers_that_never_close_hold_a_stop_for_one_wait_not_one_each() {
        let stuck: Vec<JoinHandle<()>> = (0..3)
            .map(|_| tokio::spawn(std::future::pending::<()>()))
            .collect();
        let within = Duration::from_millis(300);
        let started = Instant::now();
        closed_within(stuck, within).await;
        let took = started.elapsed();
        assert!(took >= within, "returned before the wait was up: {took:?}");
        assert!(
            took < within * 2,
            "three stuck carriers waited {took:?}, one wait each rather than one for all"
        );
        // Carriers that close at once end the wait at once.
        let quick: Vec<JoinHandle<()>> = (0..3).map(|_| tokio::spawn(async {})).collect();
        let started = Instant::now();
        closed_within(quick, Duration::from_secs(5)).await;
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn the_door_dialled_is_this_netds_whatever_path_node_named() {
        assert_eq!(
            door("wss://ingress.sbx.example.test/tunnel/v1"),
            "wss://ingress.sbx.example.test/tunnel/v2"
        );
        assert_eq!(
            door("ws://127.0.0.1:8080/tunnel/v2"),
            "ws://127.0.0.1:8080/tunnel/v2"
        );
        assert_eq!(
            door("wss://ingress.sbx.example.test"),
            "wss://ingress.sbx.example.test/tunnel/v2"
        );
    }
}
