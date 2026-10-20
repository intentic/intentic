//! The phase-1 flow end to end against a fake platform and daemon: sign in with Google, list the sandboxes, mint a
//! daemon session from an identity assertion, read the roster, go live on `/events`, and keep it all for the next
//! start. One test per binary: the core is one per process.

use intentic_mobile::Core;
use intentic_mobile::bridge::{
    Config, Event, LinkState, Outcome, Request, RowChange, SessionState,
};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const COOKIE: &str = "__Secure-better-auth.session_token=tok.sig";

fn sample(file: &str, schema: &str) -> Value {
    let samples: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("src/wire/samples/{file}.json")).unwrap(),
    )
    .unwrap();
    samples[schema]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone()
}

/// Events until one matches, failing after five seconds.
fn until(events: &Receiver<Event>, wanted: impl Fn(&Event) -> bool) -> Event {
    loop {
        let event = events
            .recv_timeout(Duration::from_secs(5))
            .expect("the event never came");
        if wanted(&event) {
            return event;
        }
    }
}

/// Events until every one of `wanted` has matched one, in any order, failing after five seconds of silence.
fn all(events: &Receiver<Event>, wanted: &[&dyn Fn(&Event) -> bool]) -> Vec<Event> {
    let mut found: Vec<Option<Event>> = vec![None; wanted.len()];
    while found.iter().any(Option::is_none) {
        let event = events
            .recv_timeout(Duration::from_secs(5))
            .expect("an event never came");
        for (slot, wanted) in found.iter_mut().zip(wanted) {
            if slot.is_none() && wanted(&event) {
                *slot = Some(event.clone());
            }
        }
    }
    found.into_iter().flatten().collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signs_in_and_shows_the_board_live() {
    let server = MockServer::start().await;
    let base = server.uri();
    let mut sandboxes = sample("platform", "sandbox.list:output");
    let mut first = sample("platform", "sandbox.list:output")["sandboxes"][0].clone();
    first["daemonUrl"] = json!(base);
    first["hosted"] = Value::Null;
    first["token"] = Value::Null;
    sandboxes["sandboxes"] = json!([first.clone()]);
    let mut session = sample("session", "DaemonSessionSchema");
    session["expiresAt"] = json!(4_102_444_800_000_i64); // 2100: never renewed during the test
    let roster = sample("agents", "AgentsListSchema");
    let rev = roster["rev"].clone();

    Mock::given(method("POST"))
        .and(path("/api/auth/one-tap/callback"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("set-cookie", format!("{COOKIE}; Path=/; HttpOnly; Secure"))
                .set_body_json(sample("auth", "unschemed:SignedIn")),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rpc/sandbox/list"))
        .and(header("cookie", COOKIE))
        .respond_with(ResponseTemplate::new(200).set_body_json(&sandboxes))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/rpc/sandbox/identity-assertion"))
        .and(header("cookie", COOKIE))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"assertion": "ia1.proof", "expiresAt": "2100-01-01T00:00:00.000Z"}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/system/session"))
        .and(header("authorization", "Bearer ia1.proof"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&session))
        .mount(&server)
        .await;
    let bearer = format!("Bearer {}", session["token"].as_str().unwrap());
    Mock::given(method("GET"))
        .and(path("/agents"))
        .and(header("authorization", bearer.as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(&roster))
        .mount(&server)
        .await;
    let stream = format!(
        "event: message\ndata: {}\n\n",
        json!({"kind": "heartbeat", "rev": rev})
    );
    Mock::given(method("GET"))
        .and(path("/events"))
        .and(header("authorization", bearer.as_str()))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(stream),
        )
        .mount(&server)
        .await;

    let dir = std::env::temp_dir().join(format!("intentic-mobile-flow-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (sender, events) = mpsc::channel();
    let sender = Mutex::new(sender);
    let config = Config {
        api_url: base.clone(),
        web_url: "https://app.test".into(),
        passkey_origin: None,
        secret_key: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".into(),
    };
    let core = Core::start(&dir, config, move |event| {
        if let Ok(sender) = sender.lock() {
            let _ = sender.send(event);
        }
    })
    .unwrap();
    until(&events, |event| {
        matches!(
            event,
            Event::Session {
                state: SessionState::SignedOut
            }
        )
    });

    let call = core.call(Request::SignInWithGoogle {
        id_token: "google-id-token".into(),
    });
    let seen = all(
        &events,
        &[
            &|event| {
                matches!(
                    event,
                    Event::Session {
                        state: SessionState::SignedIn { .. }
                    }
                )
            },
            &|event| matches!(event, Event::Board { cards, .. } if !cards.is_empty()),
            &|event| {
                matches!(
                    event,
                    Event::Link {
                        state: LinkState::Live,
                        ..
                    }
                )
            },
            &|event| matches!(event, Event::Reply { id, outcome: Outcome::Done } if *id == call),
        ],
    );
    let Event::Board { sandbox, cards } = &seen[1] else {
        unreachable!()
    };
    assert_eq!(sandbox, first["id"].as_str().unwrap());
    assert_eq!(cards.len(), roster["agents"].as_array().unwrap().len());
    assert_eq!(cards[0].id, roster["agents"][0]["id"].as_str().unwrap());

    // A conversation: its newest page, then its live run, a patch, and the run's end.
    let agent = cards[0].id.clone();
    let page = json!({
        "messages": [
            {"role": "user", "text": "Add soft deletes", "run": "r1"},
            {"role": "assistant", "text": "Done.", "run": "r1"},
        ],
        "from": 0,
        "more": false,
    });
    Mock::given(method("GET"))
        .and(path(format!("/agents/{agent}/transcript")))
        .respond_with(ResponseTemplate::new(200).set_body_json(&page))
        .mount(&server)
        .await;
    let frames = [
        json!({"kind": "attached", "run": "r2", "startedAt": 1, "seq": 1, "rows": [
            {"role": "user", "text": "Now the tests", "run": "r2"},
            {"role": "assistant", "text": "Running", "run": "r2"},
        ]}),
        json!({"kind": "patch", "seq": 2, "patch": {"op": "text", "index": 1, "text": " **them**"}}),
        json!({"kind": "end"}),
    ];
    let stream: String = frames
        .iter()
        .map(|frame| format!("event: message\ndata: {frame}\n\n"))
        .collect();
    Mock::given(method("POST"))
        .and(path("/agent/attach"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(stream),
        )
        .mount(&server)
        .await;
    core.call(Request::OpenConversation {
        agent: agent.clone(),
    });
    until(
        &events,
        |event| matches!(event, Event::Rows { agent: of, count: 4, live: false, .. } if *of == agent),
    );
    {
        let rows = core.conversation(&agent).unwrap();
        let mut rows = rows.lock().unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows.rendered(3).unwrap().1.text, "Running them");
    }

    // Sending: the row shows at once, the outbox keeps it until the daemon takes it, and the receipt names the run.
    Mock::given(method("POST"))
        .and(path("/agent"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"delivered": "started", "run": "r3"})),
        )
        .mount(&server)
        .await;
    let sent = core.call(Request::Send {
        agent: Some(agent.clone()),
        text: "Ship it".into(),
        attachments: Vec::new(),
    });
    all(
        &events,
        &[
            &|event| {
                matches!(
                    event,
                    Event::Rows {
                        count: 5,
                        change: RowChange::Inserted { at: 4, count: 1 },
                        ..
                    }
                )
            },
            &|event| matches!(event, Event::Reply { id, outcome: Outcome::Sent { queued: false, .. } } if *id == sent),
        ],
    );

    // What the next start draws before any network: the session, the sandboxes and the board, kept sealed on disk.
    let kept = std::fs::read(dir.join("core.sqlite3")).unwrap();
    assert!(
        !kept
            .windows(b"tok.sig".len())
            .any(|window| window == b"tok.sig"),
        "the cookie is sealed, not plain"
    );
}
