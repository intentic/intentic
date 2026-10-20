//! The open sandbox's link: a daemon session, the agent roster, then the daemon's `/events` stream for as long as it
//! lives, reconnecting with backoff when it drops. The stream's `agents` frames carry the whole roster; a heartbeat
//! whose revision the board has not seen means a frame was missed, and the roster is read again.

use super::{Client, session_key};
use crate::bridge::{Event, LinkState};
use crate::net::{Auth, HttpError};
use crate::session::SessionError;
use crate::wire::Millis;
use crate::wire::agents::{AGENTS, AgentsList};
use crate::wire::events::{EVENTS, SystemEvent, events_query};
use crate::wire::platform::SandboxSummary;
use crate::wire::session::{DaemonSession, SessionRefusal};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const FIRST_RETRY: Duration = Duration::from_secs(1);
const LAST_RETRY: Duration = Duration::from_secs(30);

pub(super) fn now() -> Millis {
    Millis(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis() as i64),
    )
}

/// Why one attempt ended.
enum Ended {
    /// Try again at once: the session was stale, or the board missed a frame.
    Again,
    /// Try again after the backoff.
    Lost(String),
    /// Stop: the sandbox will not open for this account, or the platform session ended.
    Stop(LinkState),
}

pub(super) async fn run(client: &'static Client, sandbox: SandboxSummary, cookie: String) {
    let say = |state: LinkState| {
        client.emit(Event::Link {
            sandbox: sandbox.id.clone(),
            state,
        });
    };
    let mut retry = FIRST_RETRY;
    let mut woke = false;
    loop {
        say(LinkState::Connecting);
        match attempt(client, &sandbox, &cookie).await {
            Ended::Again => continue,
            Ended::Stop(state) => {
                say(state);
                return;
            }
            Ended::Lost(why) => {
                log::info!("link to {}: {why}", sandbox.id);
                // A hosted sandbox that sleeps answers nothing until woken: ask once per outage.
                if !woke && sandbox.hosted.is_some() {
                    woke = client.platform().wake(&cookie, &sandbox.id).await.is_ok();
                }
                say(LinkState::Reconnecting {
                    retry_in_ms: retry.as_millis() as u32,
                });
                tokio::time::sleep(retry).await;
                retry = (retry * 2).min(LAST_RETRY);
            }
        }
    }
}

async fn attempt(client: &'static Client, sandbox: &SandboxSummary, cookie: &str) -> Ended {
    let key = session_key(&sandbox.id);
    let held: Option<DaemonSession> = client.stored(|store| {
        Ok(store
            .secret(&key)?
            .and_then(|json| serde_json::from_str(&json).ok()))
    });
    let session = match client
        .platform()
        .daemon_session(cookie, sandbox, held.as_ref(), now())
        .await
    {
        Ok(session) => session,
        Err(error) => return refused(error),
    };
    if held.as_ref() != Some(&session) {
        let json = serde_json::to_string(&session).unwrap_or_default();
        client.stored(|store| store.put_secret(&key, &json));
    }
    let Some(base) = sandbox.daemon_url.as_deref() else {
        return Ended::Stop(LinkState::Refused {
            reason: "This sandbox has no address yet.".into(),
        });
    };
    let auth = Auth::Bearer(&session.token);
    let roster = client
        .http
        .json::<AgentsList>(
            reqwest::Method::GET,
            &format!("{base}{}", AGENTS.path),
            auth,
            &[],
            None::<&()>,
        )
        .await;
    let mut rev = match roster {
        Ok(answer) => {
            client.board_changed(&sandbox.id, &answer.value.agents);
            answer.value.rev
        }
        Err(error) => return lost(client, &key, error),
    };
    client.emit(Event::Link {
        sandbox: sandbox.id.clone(),
        state: LinkState::Live,
    });
    client.flush_outbox(&sandbox.id).await;
    let url = format!("{base}{}{}", EVENTS.path, events_query(None));
    let mut missed = false;
    let streamed = client
        .http
        .events::<SystemEvent>(
            reqwest::Method::GET,
            &url,
            auth,
            None::<&()>,
            |frame| match frame {
                Ok(crate::net::sse::Frame::Message(SystemEvent::Agents { agents, rev: next })) => {
                    rev = next;
                    client.board_changed(&sandbox.id, &agents);
                    true
                }
                Ok(crate::net::sse::Frame::Message(SystemEvent::Heartbeat { rev: beat })) => {
                    missed = beat != rev;
                    !missed
                }
                Ok(crate::net::sse::Frame::Message(_)) => true,
                Ok(_) => false,
                Err(error) => {
                    log::info!("an /events frame did not read: {error}");
                    true
                }
            },
        )
        .await;
    match streamed {
        _ if missed => Ended::Again,
        Ok(()) => Ended::Lost("the stream ended".into()),
        Err(error) => lost(client, &key, error),
    }
}

/// A failed call on a live link: a refused token is forgotten and minted afresh at once, anything else waits.
fn lost(client: &Client, key: &str, error: HttpError) -> Ended {
    match error {
        HttpError::Status { status: 401, .. } => {
            client.stored(|store| store.forget_secret(key));
            Ended::Again
        }
        error => Ended::Lost(error.to_string()),
    }
}

fn refused(error: SessionError) -> Ended {
    let reason = match error {
        SessionError::SignedOut => return Ended::Stop(LinkState::SignInRequired),
        SessionError::Refused(SessionRefusal::StepUp(required)) => {
            return Ended::Stop(LinkState::PasskeyRequired {
                enrolled: required.enrolled,
            });
        }
        SessionError::Refused(SessionRefusal::EmailSignInOff) => {
            "This sandbox does not allow email sign-in for you: ask its owner."
        }
        SessionError::Refused(SessionRefusal::Forbidden(_) | SessionRefusal::Unauthorized(_)) => {
            "This sandbox does not open for this account."
        }
        SessionError::NoAddress => "This sandbox has no address yet.",
        other => return Ended::Lost(other.to_string()),
    };
    Ended::Stop(LinkState::Refused {
        reason: reason.into(),
    })
}
