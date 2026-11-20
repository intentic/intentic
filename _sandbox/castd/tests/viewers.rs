//! Who may stay on a window's media socket, with castd's router on a Unix socket and nothing of X behind it: the
//! daemon dropping every viewer (a member's access revoked) or only the read-write ones (a desktop's control handed
//! back), the tokens minted before a drop opening nothing after it, and a socket whose newest token expired long ago
//! closed unless the viewer sent a fresh one on it.

use browser_wire::{BrowserMediaClientMessage, BrowserMediaServerMessage, MEDIA_CLOSE_CODES};
use castd::hub::Hub;
use castd::record::Recorder;
use castd::server::{App, router};
use castd::token::{Claims, now_ms, sign};
use futures_util::{SinkExt, StreamExt};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const KEY: &[u8] = b"viewers-test-key";
const SESSION: &str = "viewers";

fn code(name: &str) -> u16 {
    MEDIA_CLOSE_CODES
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap()
        .1
}

struct Castd {
    socket: PathBuf,
    hub: Arc<Hub>,
    dir: PathBuf,
}

impl Drop for Castd {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// castd's router on a socket of its own: the hub nobody captures into, which is all a viewer's socket needs.
async fn castd(name: &str) -> Castd {
    let dir = std::env::temp_dir().join(format!("castd-viewers-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("castd.sock");
    let hub = Hub::new(1.0, None);
    let app = App {
        hub: hub.clone(),
        key: Arc::new(KEY.to_vec()),
        session: Arc::new(SESSION.into()),
        recorder: Recorder::new(hub.clone(), Duration::from_secs(60), None),
    };
    let listener = UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router(app)).await;
    });
    Castd { socket, hub, dir }
}

fn token(ro: bool, exp: u64, iat: u64) -> String {
    sign(
        KEY,
        &Claims {
            s: SESSION.into(),
            exp,
            ro,
            iat,
        },
    )
}

type Viewer = WebSocketStream<UnixStream>;

/// A viewer's socket opened with `token`, its `hello` read; Err when castd refused the upgrade.
async fn open(castd: &Castd, token: &str) -> Result<Viewer, String> {
    let stream = UnixStream::connect(&castd.socket).await.unwrap();
    let url = format!(
        "ws://castd{}/{SESSION}?token={token}",
        browser_wire::BROWSER_MEDIA_PATH
    );
    let (mut ws, _) = tokio_tungstenite::client_async(url.into_client_request().unwrap(), stream)
        .await
        .map_err(|e| e.to_string())?;
    let hello = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("a hello within 5 s")
        .unwrap()
        .unwrap();
    let Message::Text(t) = hello else {
        panic!("a hello first, not {hello:?}")
    };
    assert!(matches!(
        serde_json::from_str::<BrowserMediaServerMessage>(t.as_str()).unwrap(),
        BrowserMediaServerMessage::Hello { .. }
    ));
    Ok(ws)
}

/// The close code the socket ends with within `within`, or None when it is still open then.
async fn closed_with(ws: &mut Viewer, within: Duration) -> Option<u16> {
    let until = tokio::time::Instant::now() + within;
    loop {
        match tokio::time::timeout_at(until, ws.next()).await {
            Err(_) => return None,
            Ok(Some(Ok(Message::Close(frame)))) => {
                return Some(frame.map_or(1005, |f| f.code.into()));
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => panic!("the socket broke instead of closing: {e}"),
            Ok(None) => panic!("the socket ended with no close frame"),
        }
    }
}

/// `POST <path>` on castd's control socket; the response's body.
async fn post(castd: &Castd, path: &str) -> String {
    let mut stream = UnixStream::connect(&castd.socket).await.unwrap();
    stream
        .write_all(format!("POST {path} HTTP/1.1\r\nhost: castd\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    answer
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_drop_ends_every_viewer_and_the_tokens_minted_before_it_open_nothing() {
    let castd = castd("all").await;
    let later = now_ms() + 600_000;
    let issued = now_ms();
    let (driving, watching) = (token(false, later, issued), token(true, later, issued));
    let mut a = open(&castd, &driving).await.unwrap();
    let mut b = open(&castd, &watching).await.unwrap();

    let body = post(&castd, "/viewers/drop?reason=access%20revoked").await;
    assert!(body.contains(r#""dropped":2"#), "{body}");
    assert_eq!(
        closed_with(&mut a, Duration::from_secs(5)).await,
        Some(code("dropped"))
    );
    assert_eq!(
        closed_with(&mut b, Duration::from_secs(5)).await,
        Some(code("dropped"))
    );

    // Whatever was handed out before the drop is dead, however long it had left; a token minted since opens.
    assert!(open(&castd, &driving).await.is_err());
    assert!(open(&castd, &watching).await.is_err());
    tokio::time::sleep(Duration::from_millis(5)).await;
    let mut fresh = open(&castd, &token(false, later, now_ms())).await.unwrap();
    assert_eq!(
        closed_with(&mut fresh, Duration::from_millis(300)).await,
        None
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_write_drop_leaves_the_watchers_and_their_tokens_alone() {
    let castd = castd("rw").await;
    let later = now_ms() + 600_000;
    let issued = now_ms();
    let (driving, watching) = (token(false, later, issued), token(true, later, issued));
    let mut a = open(&castd, &driving).await.unwrap();
    let mut b = open(&castd, &watching).await.unwrap();

    let body = post(&castd, "/viewers/drop?read_write=1").await;
    assert!(body.contains(r#""dropped":1"#), "{body}");
    assert_eq!(
        closed_with(&mut a, Duration::from_secs(5)).await,
        Some(code("dropped"))
    );
    assert_eq!(closed_with(&mut b, Duration::from_millis(300)).await, None);
    // The old driving token no longer drives; the old watching one still watches.
    assert!(open(&castd, &driving).await.is_err());
    assert!(open(&castd, &watching).await.is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_socket_whose_token_expired_long_ago_closes_unless_a_fresh_one_came_on_it() {
    let castd = castd("lapse").await;
    // A grace of a fifth of a second stands in for browser-wire's ten minutes.
    castd.hub.token_grace_ms.store(200, Ordering::Relaxed);
    let soon = now_ms() + 300;
    let mut stale = open(&castd, &token(false, soon, now_ms())).await.unwrap();
    let mut kept = open(&castd, &token(false, soon, now_ms())).await.unwrap();
    let refresh = BrowserMediaClientMessage::Token {
        token: token(false, now_ms() + 600_000, now_ms()),
    };
    kept.send(Message::Text(
        serde_json::to_string(&refresh).unwrap().into(),
    ))
    .await
    .unwrap();
    // A token for other access refreshes nothing: it is the viewer's to dial again with.
    let mut other = open(&castd, &token(false, soon, now_ms())).await.unwrap();
    let readonly = BrowserMediaClientMessage::Token {
        token: token(true, now_ms() + 600_000, now_ms()),
    };
    other
        .send(Message::Text(
            serde_json::to_string(&readonly).unwrap().into(),
        ))
        .await
        .unwrap();

    // Past the expiry and the grace, with the ticker's half second on top.
    assert_eq!(
        closed_with(&mut stale, Duration::from_secs(3)).await,
        Some(code("expired"))
    );
    assert_eq!(
        closed_with(&mut other, Duration::from_secs(1)).await,
        Some(code("expired"))
    );
    assert_eq!(
        closed_with(&mut kept, Duration::from_millis(500)).await,
        None
    );
}
