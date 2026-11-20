//! The router on a byte stream that is no socket at all (an in-memory pipe standing in for a yamux stream a device
//! daemon accepted inside its WebSocket): the control endpoints answer and a viewer's media socket upgrades, its token
//! checked, its `hello` first.

use browser_wire::BrowserMediaServerMessage;
use cast_core::client::{MediaClient, Received};
use cast_core::hub::Hub;
use cast_core::media::Reach;
use cast_core::record::Recorder;
use cast_core::server::{App, router, serve_connection};
use cast_core::token::{Claims, now_ms, sign};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

const KEY: &[u8] = b"serve-test-key";
const SESSION: &str = "serve";

fn app() -> App {
    let hub = Hub::new(1.5, None);
    App {
        hub: hub.clone(),
        key: Arc::new(KEY.to_vec()),
        session: Arc::new(SESSION.into()),
        recorder: Recorder::new(hub, Duration::from_secs(60), None),
    }
}

/// One connection: the server's end served with `app`'s router, the client's end handed back.
fn connect(app: &App) -> DuplexStream {
    let (client, server) = tokio::io::duplex(1 << 16);
    let router = router(app.clone());
    tokio::spawn(async move {
        let _ = serve_connection(server, router).await;
    });
    client
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_control_request_is_answered_on_any_stream() {
    let app = app();
    let mut stream = connect(&app);
    stream
        .write_all(b"GET /health HTTP/1.1\r\nhost: castd\r\nconnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut answer = String::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut answer))
        .await
        .expect("an answer within 5 s")
        .unwrap();
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    let body: serde_json::Value =
        serde_json::from_str(answer.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        (body["ok"].as_bool(), body["session"].as_str()),
        (Some(true), Some(SESSION))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_viewer_upgrades_on_any_stream_and_hears_hello_first() {
    let app = app();
    let token = sign(
        KEY,
        &Claims {
            s: SESSION.into(),
            exp: now_ms() + 600_000,
            ro: true,
            iat: now_ms(),
        },
    );
    let mut viewer = MediaClient::over(connect(&app), SESSION, &token, Reach::default())
        .await
        .expect("the upgrade");
    match viewer.recv(Duration::from_secs(5)).await {
        Some(Received::Json(BrowserMediaServerMessage::Hello {
            scale, read_only, ..
        })) => assert_eq!((scale, read_only), (1.5, true)),
        other => panic!("a hello first, not {other:?}"),
    }
    assert_eq!(app.hub.clients.lock().len(), 1);
    viewer.close().await;
    // A token for another session is refused before any upgrade.
    let other = sign(
        KEY,
        &Claims {
            s: "another".into(),
            exp: now_ms() + 600_000,
            ro: false,
            iat: now_ms(),
        },
    );
    let refused = MediaClient::over(connect(&app), SESSION, &other, Reach::default()).await;
    assert!(
        refused.is_err_and(|e| e.contains("403")),
        "a foreign token opened a socket"
    );
}
