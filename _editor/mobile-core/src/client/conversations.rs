//! Following the conversations the app has open: the kept page at once, the newest page from the daemon, then the
//! live run over `/agent/attach`, again whenever the board shows that agent starting a new one. A conversation's rows
//! live behind a lock the JNI row functions read; every change is said as an [`Event::Rows`].

use super::Client;
use crate::bridge::{Event, RowChange};
use crate::conversation::{Change, Conversation};
use crate::net::sse::Frame;
use crate::net::{Auth, HttpError};
use crate::wire::attach::{
    ATTACH, AgentTranscript, AttachFrame, AttachTurn, TRANSCRIPT, transcript_query,
};
use crate::wire::platform::RpcError;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// How many of the person's turns a page holds: a phone screen or two.
const PAGE_TURNS: u32 = 10;

pub(super) struct Open {
    pub(super) rows: Arc<Mutex<Conversation>>,
    pub(super) task: tokio::task::JoinHandle<()>,
    /// The agent's current run as the board last saw it.
    pub(super) runs: watch::Sender<Option<String>>,
}

pub(super) fn page_key(sandbox: &str, agent: &str) -> String {
    format!("conversation:{sandbox}:{agent}")
}

/// How one attach ended.
enum Attached {
    /// The run finished and every frame came.
    Ended,
    /// No run is live (the daemon says NOT_FOUND).
    Idle,
    /// The stream dropped mid-run.
    Dropped(String),
}

pub(super) async fn follow(
    client: &'static Client,
    sandbox: String,
    agent: String,
    rows: Arc<Mutex<Conversation>>,
    mut runs: watch::Receiver<Option<String>>,
) {
    let say = |rows: &Conversation, change: Change| {
        client.emit(Event::Rows {
            agent: agent.clone(),
            count: rows.len() as u32,
            change: row_change(change),
            live: rows.live(),
            more: rows.more(),
        });
    };
    let kept: Option<AgentTranscript> =
        client.stored(|store| store.get_json(&page_key(&sandbox, &agent)));
    if let Some(page) = kept
        && let Ok(mut held) = rows.lock()
    {
        let change = held.reset(page);
        say(&held, change);
    }
    let mut paged = false;
    let mut retry = Duration::from_secs(1);
    loop {
        let Some((base, token)) = client.daemon(&sandbox).await else {
            // The link has not minted a session yet: it will, or it has said why not.
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        if !paged {
            let url = format!(
                "{base}{}{}",
                TRANSCRIPT.path_with(&[("id", &agent)]),
                transcript_query(None, Some(PAGE_TURNS))
            );
            match client
                .http
                .json::<AgentTranscript>(
                    reqwest::Method::GET,
                    &url,
                    Auth::Bearer(&token),
                    &[],
                    None::<&()>,
                )
                .await
            {
                Ok(answer) => {
                    client
                        .stored(|store| store.put_json(&page_key(&sandbox, &agent), &answer.value));
                    if let Ok(mut held) = rows.lock() {
                        let change = held.reset(answer.value);
                        say(&held, change);
                    }
                    paged = true;
                }
                Err(error) => {
                    log::info!("conversation {agent}: {error}");
                    tokio::time::sleep(retry).await;
                    retry = (retry * 2).min(Duration::from_secs(30));
                    continue;
                }
            }
        }
        let wanted = runs.borrow_and_update().clone();
        let (held_run, live) = rows
            .lock()
            .map(|held| (held.run().map(str::to_owned), held.live()))
            .unwrap_or_default();
        if wanted.is_some() && !(live && held_run == wanted) {
            match attach(client, &base, &token, &agent, held_run, &rows, &say).await {
                Attached::Dropped(why) => {
                    log::info!("conversation {agent}: {why}");
                    tokio::time::sleep(retry).await;
                    retry = (retry * 2).min(Duration::from_secs(30));
                    continue;
                }
                Attached::Ended | Attached::Idle => retry = Duration::from_secs(1),
            }
        }
        if runs.changed().await.is_err() {
            return;
        }
    }
}

async fn attach(
    client: &Client,
    base: &str,
    token: &str,
    agent: &str,
    run: Option<String>,
    rows: &Mutex<Conversation>,
    say: &(dyn Fn(&Conversation, Change) + Sync),
) -> Attached {
    let body = AttachTurn {
        conversation_id: agent.to_owned(),
        run,
    };
    let mut ended = None;
    let streamed = client
        .http
        .events::<AttachFrame>(
            reqwest::Method::POST,
            &format!("{base}{}", ATTACH.path),
            Auth::Bearer(token),
            Some(&body),
            |frame| {
                let Ok(mut held) = rows.lock() else {
                    return false;
                };
                match frame {
                    Ok(Frame::Message(AttachFrame::Attached { run, rows, .. })) => {
                        for change in held.attached(run, rows) {
                            say(&held, change);
                        }
                        true
                    }
                    Ok(Frame::Message(AttachFrame::Patch { patch, .. })) => {
                        for change in held.apply(patch) {
                            say(&held, change);
                        }
                        true
                    }
                    Ok(Frame::Message(AttachFrame::End) | Frame::Done(_)) => {
                        held.ended();
                        let count = held.len();
                        say(
                            &held,
                            Change::Changed {
                                at: count,
                                count: 0,
                            },
                        );
                        ended = Some(Attached::Ended);
                        false
                    }
                    Ok(Frame::Error(error)) => {
                        let error: Option<RpcError> = serde_json::from_value(error).ok();
                        ended = Some(match error {
                            Some(error) if error.code == "NOT_FOUND" => Attached::Idle,
                            other => Attached::Dropped(format!("the stream threw: {other:?}")),
                        });
                        false
                    }
                    Ok(Frame::Message(_)) => true,
                    Err(error) => {
                        log::info!("an attach frame did not read: {error}");
                        true
                    }
                }
            },
        )
        .await;
    match (ended, streamed) {
        (Some(ended), _) => ended,
        (None, Ok(())) => Attached::Dropped("the stream closed before its end".into()),
        (None, Err(HttpError::Status { status: 404, .. })) => Attached::Idle,
        (None, Err(error)) => Attached::Dropped(error.to_string()),
    }
}

pub(super) fn row_change(change: Change) -> RowChange {
    let both = |at: usize, count: usize| (at as u32, count as u32);
    match change {
        Change::Reset => RowChange::Reset,
        Change::Inserted { at, count } => {
            let (at, count) = both(at, count);
            RowChange::Inserted { at, count }
        }
        Change::Changed { at, count } => {
            let (at, count) = both(at, count);
            RowChange::Changed { at, count }
        }
        Change::Removed { at, count } => {
            let (at, count) = both(at, count);
            RowChange::Removed { at, count }
        }
    }
}

/// The fixture conversation (`Request::OpenFixture`): its rows at once, then its streamed turn if one was asked for.
pub(super) async fn fixture(
    client: &'static Client,
    agent: String,
    rows: Arc<Mutex<Conversation>>,
    json: String,
    count: usize,
    stream_ms: u64,
    stream_delay_ms: u64,
) {
    use crate::conversation::fixture::{Stream, inflate};
    let say = |held: &Conversation, change: Change| {
        client.emit(Event::Rows {
            agent: agent.clone(),
            count: held.len() as u32,
            change: row_change(change),
            live: held.live(),
            more: held.more(),
        });
    };
    let Ok((inflated, spec)) = inflate(&json, count) else {
        return;
    };
    if let Ok(mut held) = rows.lock() {
        let change = held.local(inflated);
        say(&held, change);
    }
    if stream_ms == 0 {
        return;
    }
    tokio::time::sleep(Duration::from_millis(stream_delay_ms)).await;
    let started = std::time::Instant::now();
    let mut stream = Stream::new(spec, 0, stream_ms);
    if let Ok(mut held) = rows.lock() {
        held.attached("fixture".into(), Vec::new());
    }
    // A frame's worth at a time, as a daemon's patches arrive between frames.
    let mut ticks = tokio::time::interval(Duration::from_millis(16));
    while !stream.done() {
        ticks.tick().await;
        let patches = stream.tick(started.elapsed().as_millis() as u64);
        let Ok(mut held) = rows.lock() else {
            return;
        };
        for patch in patches {
            for change in held.apply(patch) {
                say(&held, change);
            }
        }
    }
    if let Ok(mut held) = rows.lock() {
        held.ended();
        let count = held.len();
        say(
            &held,
            Change::Changed {
                at: count,
                count: 0,
            },
        );
    }
    log::info!("SPIKE_STREAM_DONE arm=app");
}
