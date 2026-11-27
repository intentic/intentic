//! A plain request to a sandbox holding no tunnel asks the platform whether it may wake it (wakes.rs), over real
//! sockets: a start the platform began answers 503 with `Retry-After`, everything else answers exactly as before, the
//! ask carries digests and never the secret, and an upgrade, a preflight, a held tunnel or an old platform asks nothing
//! twice.

mod support;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{Method, Response, StatusCode};
use http_body_util::BodyExt;
use intentic_ingress::body;
use intentic_ingress::edge::{EdgeOptions, VERDICT_HEADER};
use intentic_ingress::serve::{self, Listening};
use intentic_ingress::wakes::{WAKE_PATH, Wakes};
use ring::digest::{SHA256, digest};

use support::{
    Keys, OTHER_ID, SANDBOX_ID, daemon_host, dial, get, lone, send, serving, start, upgrade,
    wait_for,
};

const TOKEN: &str = "edge-platform-token";
const SECRET: &str = "fire-secret-xyz";

/// What the fake platform heard: the authorization and body of every ask, in order.
type Heard = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

struct Platform {
    url: String,
    heard: Heard,
    _listening: Listening,
}

// A platform answering every ask at the wake route with `status` and `body`, after `delay`.
async fn platform(status: u16, answer: &'static str, delay: Duration) -> Platform {
    let heard: Heard = Arc::default();
    let recording = heard.clone();
    let listening = serve::listen("127.0.0.1:0", move |request, _| {
        let recording = recording.clone();
        async move {
            if request.uri().path() != WAKE_PATH {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(body::empty())
                    .unwrap();
            }
            let authorization = request
                .headers()
                .get(http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let asked = request.into_body().collect().await.unwrap().to_bytes();
            recording.lock().unwrap().push((
                authorization,
                serde_json::from_slice(&asked).unwrap_or_default(),
            ));
            tokio::time::sleep(delay).await;
            Response::builder()
                .status(status)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(body::full(answer))
                .unwrap()
        }
    })
    .await
    .unwrap();
    Platform {
        url: format!("http://127.0.0.1:{}", listening.address.port()),
        heard,
        _listening: listening,
    }
}

async fn edge_asking(platform: &Platform) -> support::Running {
    let keys = Keys::default();
    start(EdgeOptions {
        wakes: Wakes::new(&platform.url, TOKEN),
        ..lone(&keys)
    })
    .await
}

fn sha(value: &str) -> String {
    digest(&SHA256, value.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fire_path() -> String {
    format!("/automations/auto-1/fire?token={SECRET}")
}

#[tokio::test]
async fn a_start_the_platform_began_is_a_503_naming_when_to_come_back() {
    let platform = platform(
        200,
        r#"{"waking":true,"listening":true,"retryAfter":42}"#,
        Duration::ZERO,
    )
    .await;
    let edge = edge_asking(&platform).await;
    let answer = send(
        edge.port,
        Method::POST,
        &daemon_host(SANDBOX_ID),
        &fire_path(),
        &[("authorization", "Bearer hook-bearer")],
        Bytes::from_static(b"{\"event\":1}"),
    )
    .await;
    assert_eq!(answer.status, 503);
    assert_eq!(answer.headers["retry-after"], "42");
    assert_eq!(answer.headers[VERDICT_HEADER], "no-tunnel");
    assert_eq!(answer.headers["cache-control"], "no-store");
    assert!(answer.body.contains("waking up"), "{}", answer.body);

    let heard = platform.heard.lock().unwrap().clone();
    assert_eq!(heard.len(), 1);
    let (authorization, asked) = &heard[0];
    assert_eq!(authorization, &format!("Bearer {TOKEN}"));
    assert_eq!(asked["sandboxId"], SANDBOX_ID);
    assert_eq!(asked["path"], "/automations/auto-1/fire");
    assert_eq!(
        asked["digests"],
        serde_json::json!([sha("hook-bearer"), sha(SECRET)])
    );
    assert!(
        !asked.to_string().contains(SECRET) && !asked.to_string().contains("hook-bearer"),
        "the ask carries digests, never the secret: {asked}"
    );
}

#[tokio::test]
async fn a_request_that_wakes_nothing_is_answered_as_before_and_asked_again_next_time() {
    let platform = platform(200, r#"{"waking":false,"listening":true}"#, Duration::ZERO).await;
    let edge = edge_asking(&platform).await;
    for _ in 0..2 {
        let answer = get(edge.port, &daemon_host(SANDBOX_ID), &fire_path()).await;
        assert_eq!(answer.status, 502);
        assert_eq!(answer.headers[VERDICT_HEADER], "no-tunnel");
        assert!(answer.headers.get("retry-after").is_none());
    }
    assert_eq!(platform.heard.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_sandbox_with_no_doors_is_not_asked_about_again_for_a_while() {
    let platform = platform(200, r#"{"waking":false,"listening":false}"#, Duration::ZERO).await;
    let edge = edge_asking(&platform).await;
    for _ in 0..3 {
        assert_eq!(
            get(edge.port, &daemon_host(SANDBOX_ID), "/hook")
                .await
                .status,
            502
        );
    }
    get(edge.port, &daemon_host(OTHER_ID), "/hook").await;
    let asked: Vec<serde_json::Value> = platform
        .heard
        .lock()
        .unwrap()
        .iter()
        .map(|(_, asked)| asked["sandboxId"].clone())
        .collect();
    assert_eq!(asked, [SANDBOX_ID, OTHER_ID]);
}

// A platform from before request wakes answers the route 404: the miss is answered as before, silently, and the platform
// is not asked again for any sandbox for a while.
#[tokio::test]
async fn an_older_platform_is_tolerated_and_left_alone() {
    let platform = platform(404, "Not Found", Duration::ZERO).await;
    let edge = edge_asking(&platform).await;
    for id in [SANDBOX_ID, OTHER_ID] {
        let answer = get(edge.port, &daemon_host(id), &fire_path()).await;
        assert_eq!(answer.status, 502);
        assert_eq!(answer.headers[VERDICT_HEADER], "no-tunnel");
    }
    assert_eq!(platform.heard.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_platform_slow_to_answer_never_holds_the_request_past_its_patience() {
    let platform = platform(
        200,
        r#"{"waking":true,"listening":true}"#,
        Duration::from_secs(10),
    )
    .await;
    let edge = edge_asking(&platform).await;
    let began = Instant::now();
    let answer = get(edge.port, &daemon_host(SANDBOX_ID), &fire_path()).await;
    assert_eq!(answer.status, 502);
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
}

#[tokio::test]
async fn an_upgrade_a_preflight_and_a_held_tunnel_ask_nothing() {
    let platform = platform(200, r#"{"waking":true,"listening":true}"#, Duration::ZERO).await;
    let keys = Keys::default();
    let edge = start(EdgeOptions {
        wakes: Wakes::new(&platform.url, TOKEN),
        ..lone(&keys)
    })
    .await;
    let (head, _) = upgrade(edge.port, &daemon_host(SANDBOX_ID), "/hook", "websocket").await;
    assert!(head.starts_with("HTTP/1.1 502"), "{head}");
    let preflight = send(
        edge.port,
        Method::OPTIONS,
        &daemon_host(SANDBOX_ID),
        "/hook",
        &[("access-control-request-method", "POST")],
        Bytes::new(),
    )
    .await;
    assert_eq!(preflight.status, 204);
    let _held = dial(edge.port, &keys.grant(SANDBOX_ID), serving("held"))
        .await
        .unwrap();
    wait_for("the tunnel", || edge.edge.registry().size() == 1).await;
    let served = get(edge.port, &daemon_host(SANDBOX_ID), &fire_path()).await;
    assert_eq!(served.status, 200);
    assert!(platform.heard.lock().unwrap().is_empty());
}
