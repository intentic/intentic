//! What the kept store survives, end to end against a fake platform: an outage, a page in front of the api, and a list
//! from another database never sign the app out or empty its sandboxes; the platform's own word does. One test per
//! binary: the core is one per process.

use intentic_mobile::Core;
use intentic_mobile::bridge::{Config, Event, Outcome, Request, SessionState};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const COOKIE: &str = "__Secure-better-auth.session_token=tok.sig";
const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const UNAUTHORIZED: &str =
    r#"{"defined":false,"code":"UNAUTHORIZED","status":401,"message":"Unauthorized"}"#;

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

fn identity(name: &str) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .set_body_json(json!({"identity": name, "since": "2026-10-02T08:00:00.000Z"}))
}

fn page(status: u16) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_raw(
        "<!DOCTYPE html><html><body>We'll be right back</body></html>",
        "text/html",
    )
}

/// The platform as it answers from now on: the list and the identity as given, and identity assertions refused, so
/// the open sandbox's link only ever retries.
async fn answering(server: &MockServer, list: ResponseTemplate, identity: ResponseTemplate) {
    server.reset().await;
    Mock::given(method("GET"))
        .and(path("/rpc/sandbox/list"))
        .respond_with(list)
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/identity"))
        .respond_with(identity)
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/rpc/sandbox/identity-assertion"))
        .respond_with(ResponseTemplate::new(503))
        .mount(server)
        .await;
}

/// The events up to the reply to call `id`, and that reply.
fn through_reply(events: &Receiver<Event>, id: i32) -> (Vec<Event>, Outcome) {
    let mut seen = Vec::new();
    loop {
        let event = events
            .recv_timeout(Duration::from_secs(10))
            .expect("the reply never came");
        if let Event::Reply { id: of, outcome } = &event
            && *of == id
        {
            return (seen, outcome.clone());
        }
        seen.push(event);
    }
}

fn signed_out(seen: &[Event]) -> bool {
    seen.iter().any(|event| {
        matches!(
            event,
            Event::Session {
                state: SessionState::SignedOut
            }
        )
    })
}

/// The sandboxes the last `Sandboxes` event drew, by id; None when none was drawn.
fn drawn(seen: &[Event]) -> Option<Vec<String>> {
    seen.iter().rev().find_map(|event| match event {
        Event::Sandboxes { sandboxes, .. } => {
            Some(sandboxes.iter().map(|row| row.id.clone()).collect())
        }
        _ => None,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_platforms_own_word_signs_out_or_forgets_a_sandbox() {
    let server = MockServer::start().await;
    let base = server.uri();
    let mut list = sample("platform", "sandbox.list:output");
    let rows: Vec<Value> = list["sandboxes"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut row = row.clone();
            row["daemonUrl"] = json!(format!("{base}/sandbox-{index}"));
            row["hosted"] = Value::Null;
            row
        })
        .collect();
    assert_eq!(rows.len(), 2, "the sample lists two sandboxes");
    let ids: Vec<String> = rows
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    list["sandboxes"] = json!(rows);
    let empty = json!({"sandboxes": []});

    answering(
        &server,
        ResponseTemplate::new(200).set_body_json(&list),
        identity("db-1"),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/api/auth/one-tap/callback"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("set-cookie", format!("{COOKIE}; Path=/; HttpOnly; Secure"))
                .set_body_json(sample("auth", "unschemed:SignedIn")),
        )
        .mount(&server)
        .await;

    let dir = std::env::temp_dir().join(format!("intentic-mobile-outage-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (sender, events) = mpsc::channel();
    let sender = Mutex::new(sender);
    let config = Config {
        api_url: base.clone(),
        web_url: "https://app.test".into(),
        passkey_origin: None,
        secret_key: KEY.into(),
    };
    let core = Core::start(&dir, config, move |event| {
        if let Ok(sender) = sender.lock() {
            let _ = sender.send(event);
        }
    })
    .unwrap();

    let signing_in = core.call(Request::SignInWithGoogle {
        id_token: "google-id-token".into(),
    });
    let (seen, outcome) = through_reply(&events, signing_in);
    assert_eq!(outcome, Outcome::Done);
    assert_eq!(
        drawn(&seen),
        Some(ids.clone()),
        "the list, kept from database db-1"
    );

    // An outage, a proxy's page in a 200 and in a 401: each is an error, and nothing kept goes.
    for (label, list) in [
        ("a 503", ResponseTemplate::new(503)),
        ("a page answered 200", page(200)),
        ("a page answered 401", page(401)),
        ("an empty 200", ResponseTemplate::new(200)),
    ] {
        answering(&server, list, ResponseTemplate::new(503)).await;
        let refreshing = core.call(Request::RefreshSandboxes);
        let (seen, outcome) = through_reply(&events, refreshing);
        assert!(
            matches!(outcome, Outcome::Failed { .. }),
            "{label}: {outcome:?}"
        );
        assert!(!signed_out(&seen), "{label}");
        assert_eq!(drawn(&seen), None, "{label}: nothing redrawn");
    }

    // An empty list from another database, or from one that cannot say which it is, is a reset: the rows stay.
    for (label, named) in [
        ("another database", identity("db-2")),
        ("an unnamed one", page(200)),
    ] {
        answering(
            &server,
            ResponseTemplate::new(200).set_body_json(&empty),
            named,
        )
        .await;
        let refreshing = core.call(Request::RefreshSandboxes);
        let (seen, outcome) = through_reply(&events, refreshing);
        assert_eq!(outcome, Outcome::Done, "{label}");
        assert_eq!(drawn(&seen), Some(ids.clone()), "{label}");
    }

    // The database the rows came from: a row its list lacks is gone.
    let mut one = list.clone();
    one["sandboxes"] = json!([list["sandboxes"][0].clone()]);
    answering(
        &server,
        ResponseTemplate::new(200).set_body_json(&one),
        identity("db-1"),
    )
    .await;
    let refreshing = core.call(Request::RefreshSandboxes);
    let (seen, outcome) = through_reply(&events, refreshing);
    assert_eq!(outcome, Outcome::Done);
    assert_eq!(drawn(&seen), Some(vec![ids[0].clone()]));

    // The platform's own refusal ends the session, and with it everything kept.
    answering(
        &server,
        ResponseTemplate::new(401).set_body_raw(UNAUTHORIZED, "application/json"),
        identity("db-1"),
    )
    .await;
    let refreshing = core.call(Request::RefreshSandboxes);
    let (seen, outcome) = through_reply(&events, refreshing);
    assert!(matches!(outcome, Outcome::Failed { .. }), "{outcome:?}");
    assert!(signed_out(&seen));
    assert_eq!(drawn(&seen), Some(Vec::new()));
}
