//! A runner's uplink to its parent sandbox (2026-11-23). A runner is another machine's sandbox container that runs a
//! conversation's turns for a parent; nothing can reach its netd, which publishes no port, so it dials out: one WebSocket
//! to browser-wire's `RUNNER_UPLINK_PATH` on the parent's origin, presenting the runner's durable token and its id, then
//! yamux, on which the parent's netd opens a stream per person's view or preview. Every stream is served here as one
//! HTTP/1.1 connection arriving on `Listener::Parent` (`Netd::serve_stream`), routed as the loopback port is and marked
//! `parent` to Node and castd. The runner runs without auth, so the parent's netd, its allowlist and its daemon's
//! tickets are the only gate; this end opens nothing towards the parent (the parent's session refuses such a stream).
//!
//! The dial is `tunnel.rs`'s skeleton, kept apart so the edge's carrier stays the edge's. It redials at the pace its last
//! dial set (`standing::Pace`): a drop on the ladder; a displacement (`RUNNER_UPLINK_DISPLACED`, another copy of this
//! runner took the slot) standing back a drawn minute or two; a refusal (401 or 403: the parent does not hold this
//! token, 404: a parent older than the uplink, or `RUNNER_UPLINK_WITHDRAWN`) standing back the same, and after three in a
//! row every 15 minutes.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use browser_wire::{
    RUNNER_HEADER, RUNNER_UPLINK_DISPLACED, RUNNER_UPLINK_PATH, RUNNER_UPLINK_WITHDRAWN,
};
use http::{HeaderValue, StatusCode};
use netd_wire::{ParentUplinkConfig, ToNode};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Error as SocketError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{Connector, connect_async_tls_with_config};
use tunnel::{Close, Ended, Liveness, mux};

use crate::proxy::Netd;
use crate::route::Listener;
use crate::standing::{Outcome, Pace};

// A dial the parent has not answered by now is a path that carries nothing.
const DIAL_PATIENCE: Duration = Duration::from_secs(30);

// How long a session that ended waits for the socket's close frame, whose code says why it ended.
const CLOSE_HEARD_WITHIN: Duration = Duration::from_secs(1);

const STOPPED: Close = Close {
    code: 1001,
    reason: std::borrow::Cow::Borrowed("the runner stopped dialling its parent"),
};

/// What netd tells Node, handed in so the dialer is tested without a link.
pub type Tell = Arc<dyn Fn(&ToNode) + Send + Sync>;

// Where the uplink stands, as Node is told.
#[derive(Default)]
struct Standing {
    connected: bool,
    reason: Option<String>,
}

pub struct ParentUplink {
    netd: Arc<Netd>,
    tell: Tell,
    standing: Arc<Mutex<Standing>>,
    running: Option<(
        ParentUplinkConfig,
        JoinHandle<()>,
        watch::Sender<Option<Close>>,
    )>,
}

impl ParentUplink {
    pub fn new(netd: Arc<Netd>, tell: Tell) -> Self {
        Self {
            netd,
            tell,
            standing: Arc::default(),
            running: None,
        }
    }

    /// Dials this parent, or stops dialling with none; the same config again changes nothing.
    pub fn configure(&mut self, wanted: Option<ParentUplinkConfig>) {
        if self.running.as_ref().map(|(config, _, _)| config) == wanted.as_ref() {
            return;
        }
        if let Some((_, dialling, closing)) = self.running.take() {
            closing.send_replace(Some(STOPPED));
            dialling.abort();
        }
        *self.standing.lock().expect("parent standing poisoned") = Standing::default();
        self.report_again();
        let Some(config) = wanted else {
            return;
        };
        let (closing, closed) = watch::channel(None);
        let dialling = tokio::spawn(run(
            self.netd.clone(),
            config.clone(),
            self.tell.clone(),
            self.standing.clone(),
            closed,
        ));
        self.running = Some((config, dialling, closing));
    }

    /// Tells Node where the uplink stands: on every change, and to a Node that just said hello, configured or not.
    pub fn report_again(&self) {
        (self.tell)(&report(&self.standing));
    }
}

fn report(standing: &Mutex<Standing>) -> ToNode {
    let standing = standing.lock().expect("parent standing poisoned");
    ToNode::ParentUplink {
        connected: standing.connected,
        reason: standing.reason.clone(),
    }
}

fn set(standing: &Mutex<Standing>, tell: &Tell, connected: bool, reason: Option<String>) {
    {
        let mut held = standing.lock().expect("parent standing poisoned");
        held.connected = connected;
        held.reason = reason;
    }
    tell(&report(standing));
}

async fn run(
    netd: Arc<Netd>,
    config: ParentUplinkConfig,
    tell: Tell,
    standing: Arc<Mutex<Standing>>,
    closed: watch::Receiver<Option<Close>>,
) {
    let mut pace = Pace::default();
    loop {
        let started = Instant::now();
        let outcome = dial_once(&netd, &config, &tell, &standing, closed.clone()).await;
        if closed.borrow().is_some() {
            return;
        }
        let next = pace.next(&outcome, started.elapsed());
        let reason = match &outcome {
            // Stood back from like another copy's refusal; its words are the refusal's own.
            Outcome::Elsewhere(why) => why.clone(),
            Outcome::Displaced => "a newer uplink of this runner took its place".into(),
            other => other.reason(),
        };
        tracing::warn!(runner = %config.runner, %reason, wait = ?next.wait, "the uplink to the parent sandbox is down");
        set(&standing, &tell, false, Some(reason));
        tokio::time::sleep(next.wait).await;
    }
}

// A refusal that stands back like another copy's: a minute or two, then every 15 minutes after three in a row.
fn refused(why: String) -> Outcome {
    Outcome::Elsewhere(why)
}

fn dropped(why: String) -> Outcome {
    Outcome::Dropped { why, proven: false }
}

async fn dial_once(
    netd: &Arc<Netd>,
    config: &ParentUplinkConfig,
    tell: &Tell,
    standing: &Mutex<Standing>,
    closed: watch::Receiver<Option<Close>>,
) -> Outcome {
    let Some(url) = door(&config.url) else {
        return refused(format!("the parent's address is unusable: {}", config.url));
    };
    let mut request = match url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => return refused(format!("the parent's address is unusable: {error}")),
    };
    for (name, value) in [
        ("authorization", format!("Bearer {}", config.token)),
        (RUNNER_HEADER, config.runner.clone()),
    ] {
        match HeaderValue::from_str(&value) {
            Ok(value) => request.headers_mut().insert(name, value),
            Err(error) => return refused(format!("{name} is not a header value: {error}")),
        };
    }
    let dialling = connect_async_tls_with_config(
        request,
        Some(tunnel::socket_config()),
        true,
        Some(Connector::Rustls(crate::tunnel::client_tls())),
    );
    let socket = match tokio::time::timeout(DIAL_PATIENCE, dialling).await {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(SocketError::Http(answer))) => return refusal(answer.status()),
        Ok(Err(error)) => return dropped(format!("could not dial the parent: {error}")),
        Err(_) => {
            return dropped(format!(
                "the parent did not answer the dial within {DIAL_PATIENCE:?}"
            ));
        }
    };
    let (session_side, mut pumping) = tunnel::pump(socket, Liveness::Pings, closed);
    let heard = pumping.heard();
    let (mut streams, mut driving) = mux::server(session_side);
    let serving = netd.clone();
    let accepting = tokio::spawn(async move {
        while let Some(stream) = streams.recv().await {
            let netd = serving.clone();
            tokio::spawn(async move { netd.serve_stream(stream, Listener::Parent).await });
        }
    });
    tracing::info!(runner = %config.runner, "the uplink to the parent sandbox is up");
    set(standing, tell, true, None);
    let ended = tokio::select! {
        ended = pumping.ended() => ended,
        driven = &mut driving => {
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
    match ended {
        Ended::Closed(Some(RUNNER_UPLINK_DISPLACED)) => Outcome::Displaced,
        Ended::Closed(Some(RUNNER_UPLINK_WITHDRAWN)) => {
            refused("the parent withdrew this runner's uplink".into())
        }
        Ended::Closed(code) => Outcome::Dropped {
            why: match code {
                Some(code) => format!("the parent closed the uplink ({code})"),
                None => "the parent closed the uplink".into(),
            },
            proven: heard.answered(),
        },
        Ended::Dropped(why) => Outcome::Dropped {
            why,
            proven: heard.answered(),
        },
    }
}

// What an answer other than 101 says: the parent does not hold this runner's token, or predates the uplink, each stood
// back from slowly; anything else is a drop like any other.
fn refusal(status: StatusCode) -> Outcome {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            refused(format!("the parent refused this runner's uplink: {status}"))
        }
        StatusCode::NOT_FOUND => refused(format!(
            "the parent does not serve {RUNNER_UPLINK_PATH}: its netd predates runner uplinks"
        )),
        status => dropped(format!("the parent refused the uplink: {status}")),
    }
}

// The parent's origin, whatever path Node named, as the WebSocket scheme of its own: `http(s)` becomes `ws(s)`.
fn door(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = match scheme.to_ascii_lowercase().as_str() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        _ => return None,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{authority}{RUNNER_UPLINK_PATH}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_door_is_the_parents_origin_as_a_websocket() {
        assert_eq!(
            door("https://sandbox-abc.sbx.example.test").as_deref(),
            Some("wss://sandbox-abc.sbx.example.test/system/runner-uplink")
        );
        assert_eq!(
            door("http://127.0.0.1:8787/").as_deref(),
            Some("ws://127.0.0.1:8787/system/runner-uplink")
        );
        assert_eq!(
            door("wss://p.example/some/path?x=1").as_deref(),
            Some("wss://p.example/system/runner-uplink")
        );
        assert_eq!(door("ftp://p.example"), None);
        assert_eq!(door("p.example"), None);
        assert_eq!(door("https://"), None);
    }

    #[test]
    fn a_refusal_stands_back_and_anything_else_is_a_drop() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
        ] {
            assert!(matches!(refusal(status), Outcome::Elsewhere(_)), "{status}");
        }
        assert!(matches!(
            refusal(StatusCode::BAD_GATEWAY),
            Outcome::Dropped { .. }
        ));
        // Three refusals in a row slow the dial to a quarter of an hour.
        let mut pace = Pace::default();
        let waits: Vec<Duration> = (0..3)
            .map(|_| {
                pace.next(&refusal(StatusCode::NOT_FOUND), Duration::ZERO)
                    .wait
            })
            .collect();
        assert!(waits[0] >= Duration::from_secs(60) && waits[0] <= Duration::from_secs(120));
        assert!(waits[2] >= Duration::from_secs(15 * 60));
    }
}
