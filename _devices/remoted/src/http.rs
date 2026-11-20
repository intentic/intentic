//! What remoted answers on each stream netd opens down an uplink: one HTTP/1.1 connection per stream, as castd serves
//! its Unix socket. A person's viewer arrives as an upgrade netd relays with the path rewritten
//! (`/terminal/<session>?token=…`, `/media/<session>?token=…`); the daemon's own calls (Node, through netd's
//! per-device socket) carry no token, the uplink being the sandbox's alone.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /health` | `{ok, version}` |
//! | `GET /info` | `{version, monitors, environments, encoders, allow, paused}` |
//! | `POST /terminals` | `{session, environment?, shell?, cwd?, cols?, rows?}` → 201 the terminal as listed; 400, 403, 409, 429, 500 |
//! | `GET /terminals` | `[{session, title, environment, createdAt, viewers}]` |
//! | `DELETE /terminals/<session>` | `{ok: true}`, or 404 |
//! | `POST /viewers/drop[?read_write=1]` | `{dropped: n}`: castd's drop, for this uplink's viewers |
//! | `GET /stats` | `{uptimeS, terminals, viewers, uplinks}` |
//! | `GET /terminal/<session>?token=` | the terminal socket (upgrade); 401 without a token, 403 refused |
//! | `GET /media/<session>?token=` | 501 until phase 2 |

use std::convert::Infallible;
use std::sync::Arc;

use bytes::Bytes;
use http::header::{
    CONNECTION, CONTENT_TYPE, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION,
    UPGRADE,
};
use http::{HeaderMap, Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

use crate::daemon::{Daemon, TerminalGate};
use crate::status::PersonKind;
use crate::term::{self, Refused as CreateRefused, socket};
use crate::{media, token};

/// The path a terminal socket arrives on, the session after it (browser-wire's `DEVICE_TERMINAL_UPSTREAM`).
pub const TERMINAL_UPSTREAM: &str = "/terminal";

/// The path a screen's media socket arrives on (browser-wire's `DEVICE_MEDIA_UPSTREAM`).
pub const MEDIA_UPSTREAM: &str = "/media";

// A create's body is a few fields.
const BODY_MAX: usize = 64 * 1024;

type Answer = Response<Full<Bytes>>;

/// Serves one stream until its connection ends; an upgraded socket goes on in a task of its own.
pub async fn serve<S>(io: S, daemon: Arc<Daemon>, uplink: String)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let service = service_fn(move |request| {
        let daemon = daemon.clone();
        let uplink = uplink.clone();
        async move { Ok::<_, Infallible>(route(request, daemon, uplink).await) }
    });
    if let Err(error) = http1::Builder::new()
        .serve_connection(TokioIo::new(io), service)
        .with_upgrades()
        .await
    {
        log::debug!("a stream's connection ended: {error}");
    }
}

fn answer(status: StatusCode, body: &Value) -> Answer {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .expect("a JSON answer always builds")
}

fn refusal(status: StatusCode, words: &str) -> Answer {
    answer(status, &json!({ "error": words }))
}

/// One query parameter, as given: tokens and flags are URL-safe as minted.
pub fn param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

async fn route(request: Request<Incoming>, daemon: Arc<Daemon>, uplink: String) -> Answer {
    let path = request.uri().path().to_owned();
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let method = request.method().clone();
    match (&method, segments.as_slice()) {
        (&Method::GET, ["health"]) => answer(
            StatusCode::OK,
            &json!({ "ok": true, "version": crate::VERSION }),
        ),
        (&Method::GET, ["info"]) => info(&daemon, &uplink).await,
        (&Method::GET, ["stats"]) => stats(&daemon),
        (&Method::GET, ["terminals"]) => {
            answer(StatusCode::OK, &json!(daemon.terminals.list(&uplink)))
        }
        (&Method::POST, ["terminals"]) => create(request, &daemon, &uplink).await,
        (&Method::DELETE, ["terminals", session]) => {
            if daemon
                .terminals
                .end(&uplink, session, "ended from the sandbox")
            {
                answer(StatusCode::OK, &json!({ "ok": true }))
            } else {
                refusal(StatusCode::NOT_FOUND, "no such terminal")
            }
        }
        (&Method::POST, ["viewers", "drop"]) => {
            let read_write = request
                .uri()
                .query()
                .and_then(|query| param(query, "read_write"))
                == Some("1");
            let dropped = daemon.drop_viewers(Some(&uplink), read_write);
            log::info!("uplink {uplink}: {dropped} viewer(s) dropped by the sandbox");
            answer(StatusCode::OK, &json!({ "dropped": dropped }))
        }
        (&Method::GET, ["terminal", session]) => {
            let session = (*session).to_owned();
            terminal(request, daemon, uplink, session)
        }
        (&Method::GET, ["media", _]) => refusal(StatusCode::NOT_IMPLEMENTED, media::NOT_YET),
        _ => refusal(StatusCode::NOT_FOUND, "no such route"),
    }
}

async fn info(daemon: &Daemon, uplink: &str) -> Answer {
    let allow = daemon
        .uplink(uplink)
        .map(|held| held.allow)
        .unwrap_or_default();
    answer(
        StatusCode::OK,
        &json!({
            "version": crate::VERSION,
            "monitors": media::monitors(),
            "environments": crate::environments::list().await,
            "encoders": media::encoders(),
            "allow": allow,
            "paused": daemon.paused(),
        }),
    )
}

fn stats(daemon: &Daemon) -> Answer {
    answer(
        StatusCode::OK,
        &json!({
            "uptimeS": daemon.started.elapsed().as_secs(),
            "terminals": daemon.terminals.count(),
            "viewers": daemon.viewers(),
            "uplinks": daemon.status.line().uplinks,
        }),
    )
}

async fn create(request: Request<Incoming>, daemon: &Daemon, uplink: &str) -> Answer {
    let Some(held) = daemon.uplink(uplink) else {
        return refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "this uplink is being closed",
        );
    };
    if !held.allow.terminal {
        return refusal(
            StatusCode::FORBIDDEN,
            "terminals are switched off for this sandbox on this computer",
        );
    }
    let body = match Limited::new(request.into_body(), BODY_MAX).collect().await {
        Ok(body) => body.to_bytes(),
        Err(error) => {
            return refusal(
                StatusCode::BAD_REQUEST,
                &format!("the body did not arrive: {error}"),
            );
        }
    };
    let asked: term::Create = match serde_json::from_slice(&body) {
        Ok(asked) => asked,
        Err(error) => {
            return refusal(
                StatusCode::BAD_REQUEST,
                &format!("the body does not read: {error}"),
            );
        }
    };
    match daemon.terminals.create(uplink, asked).await {
        Ok(listed) => answer(StatusCode::CREATED, &json!(listed)),
        Err(CreateRefused::Asked(words)) => refusal(StatusCode::BAD_REQUEST, &words),
        Err(CreateRefused::Exists) => {
            refusal(StatusCode::CONFLICT, "a terminal of this name already runs")
        }
        Err(CreateRefused::TooMany) => refusal(
            StatusCode::TOO_MANY_REQUESTS,
            &format!(
                "{} terminals at most for one sandbox on this computer",
                term::MAX_PER_UPLINK
            ),
        ),
        Err(CreateRefused::Failed(words)) => {
            log::warn!("uplink {uplink}: a terminal could not start: {words}");
            refusal(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("the terminal could not start: {words}"),
            )
        }
    }
}

/// The `Sec-WebSocket-Accept` a request's WebSocket handshake is answered with, when it is one.
pub fn handshake(headers: &HeaderMap) -> Option<String> {
    let names = |header, token: &str| {
        headers
            .get_all(header)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .any(|value| {
                value
                    .split(',')
                    .any(|named| named.trim().eq_ignore_ascii_case(token))
            })
    };
    if !names(CONNECTION, "upgrade")
        || !names(UPGRADE, "websocket")
        || headers.get(SEC_WEBSOCKET_VERSION)?.as_bytes() != b"13"
    {
        return None;
    }
    Some(derive_accept_key(
        headers.get(SEC_WEBSOCKET_KEY)?.as_bytes(),
    ))
}

fn terminal(
    mut request: Request<Incoming>,
    daemon: Arc<Daemon>,
    uplink_id: String,
    session: String,
) -> Answer {
    let Some(uplink) = daemon.uplink(&uplink_id) else {
        return refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "this uplink is being closed",
        );
    };
    let query = request.uri().query().unwrap_or("").to_owned();
    let Some(token) = param(&query, "token") else {
        return refusal(StatusCode::UNAUTHORIZED, "a terminal opens with ?token=");
    };
    let subject = format!("{}{session}", token::TERMINAL_SUBJECT);
    let claims = match daemon.check(&uplink, &subject, token) {
        Ok(claims) => claims,
        Err(refused) => return refusal(StatusCode::FORBIDDEN, refused.words()),
    };
    if !uplink.allow.terminal {
        return refusal(
            StatusCode::FORBIDDEN,
            "terminals are switched off for this sandbox on this computer",
        );
    }
    let Some(accept) = handshake(request.headers()) else {
        return refusal(StatusCode::UPGRADE_REQUIRED, "a terminal is a WebSocket");
    };
    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        let io = match upgrade.await {
            Ok(io) => TokioIo::new(io),
            Err(error) => return log::debug!("a terminal upgrade did not complete: {error}"),
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(socket::MESSAGE_MAX))
            .max_frame_size(Some(socket::MESSAGE_MAX));
        let mut ws = WebSocketStream::from_raw_socket(io, Role::Server, Some(config)).await;
        let Some(running) = daemon.terminals.get(&uplink_id, &session) else {
            use futures_util::SinkExt;
            let _ = ws
                .feed(socket::exit(-1, Some("this terminal has ended".into())))
                .await;
            let _ = ws.close(None).await;
            return;
        };
        let viewer = daemon.viewer(&uplink_id, PersonKind::Terminal, &session, claims.ro);
        let (cols, rows) = socket::size_of(&query);
        let seat = running.join(viewer.id, cols, rows, !socket::away(&query), claims.ro);
        log::info!(
            "uplink {uplink_id}: a person {} terminal {session}",
            if claims.ro { "watches" } else { "opened" }
        );
        socket::serve(
            ws,
            socket::Viewing {
                seat,
                read_only: claims.ro,
                expires: claims.exp,
                revocation: viewer.revocation.clone(),
                gate: Arc::new(TerminalGate {
                    daemon: daemon.clone(),
                    uplink: uplink_id.clone(),
                    subject,
                }),
                deflate: term::deflate::asked(&query),
            },
        )
        .await;
        log::info!("uplink {uplink_id}: a person left terminal {session}");
        drop(viewer);
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header(SEC_WEBSOCKET_ACCEPT, accept)
        .body(Full::new(Bytes::new()))
        .expect("a switching answer always builds")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_parameter_is_read_by_its_exact_name() {
        assert_eq!(param("token=a.b&deflate=1", "token"), Some("a.b"));
        assert_eq!(param("xtoken=a&token=b", "token"), Some("b"));
        assert_eq!(param("deflate=1", "token"), None);
    }

    #[test]
    fn only_a_websockets_handshake_is_answered_with_its_accept() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, "keep-alive, Upgrade".parse().unwrap());
        headers.insert(UPGRADE, "websocket".parse().unwrap());
        headers.insert(SEC_WEBSOCKET_VERSION, "13".parse().unwrap());
        headers.insert(
            SEC_WEBSOCKET_KEY,
            "dGhlIHNhbXBsZSBub25jZQ==".parse().unwrap(),
        );
        // RFC 6455's own example.
        assert_eq!(
            handshake(&headers).as_deref(),
            Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        );
        headers.insert(SEC_WEBSOCKET_VERSION, "8".parse().unwrap());
        assert_eq!(handshake(&headers), None);
    }
}
