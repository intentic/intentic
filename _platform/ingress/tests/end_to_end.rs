//! End to end over real sockets: a sandbox dials the tunnel door and browsers' requests route by their Host. The edge and
//! the sandbox agree: a signed grant is accepted, Host survives the hop, and refusals are refusals, not hangs.

mod support;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use http::{Method, Response};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use intentic_ingress::body;
use intentic_ingress::edge::{REPLAY_CACHE_TTL_SECS, VERDICT_HEADER};
use intentic_ingress::revocation::Revocation;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tunnel::{DISPLACED_CODE, Ended};

use support::{
    Keys, OTHER_ID, SANDBOX_ID, ZONE, daemon_host, dial, get, lone, platform, send, serving, start,
    upgrade, wait_for,
};

#[tokio::test]
async fn answers_its_own_health_and_404s_a_stray_subdomain() {
    let keys = Keys::default();
    let edge = start(lone(&keys)).await;
    let health = get(edge.port, &format!("ingress.{ZONE}"), "/health").await;
    assert_eq!(health.status, 200);
    let parsed: serde_json::Value = serde_json::from_str(&health.body).unwrap();
    assert_eq!(parsed["status"], "ok");
    assert_eq!(
        get(edge.port, &format!("nothing.{ZONE}"), "/").await.status,
        404
    );
    // The door exists but takes only a WebSocket, so a misconfigured client does not look like a wrong address.
    assert_eq!(
        get(edge.port, &format!("ingress.{ZONE}"), "/tunnel/v1")
            .await
            .status,
        426
    );
}

#[tokio::test]
async fn a_sandbox_with_no_tunnel_is_a_502_a_browser_can_read() {
    let keys = Keys::default();
    let edge = start(lone(&keys)).await;
    let host = daemon_host(SANDBOX_ID);

    let refused = send(
        edge.port,
        Method::GET,
        &host,
        "/",
        &[("origin", "https://app.example.test")],
        Bytes::new(),
    )
    .await;
    assert_eq!(refused.status, 502);
    assert!(
        refused.body.contains(&format!("sandbox-{SANDBOX_ID}")),
        "{}",
        refused.body
    );
    assert_eq!(refused.headers[VERDICT_HEADER], "no-tunnel");
    assert_eq!(refused.headers["access-control-allow-origin"], "*");
    assert_eq!(
        refused.headers["access-control-expose-headers"],
        VERDICT_HEADER
    );

    // A browser drops a non-2xx preflight and never sends the request behind it, which is the one carrying the verdict.
    let preflight = send(
        edge.port,
        Method::OPTIONS,
        &host,
        "/events",
        &[
            ("origin", "https://app.example.test"),
            ("access-control-request-method", "GET"),
            ("access-control-request-headers", "authorization"),
        ],
        Bytes::new(),
    )
    .await;
    assert_eq!(preflight.status, 204);
    assert_eq!(preflight.headers["access-control-allow-origin"], "*");
    assert_eq!(preflight.headers["access-control-allow-headers"], "*");

    // An OPTIONS no preflight sent is an ordinary request for a sandbox that is not there.
    let bare = send(edge.port, Method::OPTIONS, &host, "/", &[], Bytes::new()).await;
    assert_eq!(bare.status, 502);
}

#[tokio::test]
async fn a_tunnel_without_a_valid_grant_is_refused() {
    let keys = Keys::default();
    let edge = start(lone(&keys)).await;
    assert_eq!(
        dial(edge.port, "", None, serving("x")).await.err(),
        Some(401)
    );
    let stranger = Keys::default();
    assert_eq!(
        dial(edge.port, &stranger.grant(SANDBOX_ID), None, serving("x"))
            .await
            .err(),
        Some(401)
    );
    assert_eq!(edge.edge.registry().size(), 0);
}

#[tokio::test]
async fn a_validly_signed_tunnel_carries_its_sandboxs_names_and_no_others() {
    let keys = Keys::default();
    let edge = start(lone(&keys)).await;
    let sandbox = dial(edge.port, &keys.grant(SANDBOX_ID), None, serving("served"))
        .await
        .unwrap();
    wait_for("the tunnel to register", || {
        edge.edge.registry().size() == 1
    })
    .await;
    assert_eq!(edge.edge.registry().ids(), [SANDBOX_ID]);

    let answer = get(edge.port, &daemon_host(SANDBOX_ID), "/health").await;
    assert_eq!(
        (answer.status, answer.body.as_str()),
        (
            200,
            format!("served sandbox-{SANDBOX_ID}.{ZONE}/health").as_str()
        )
    );
    let preview = get(edge.port, &format!("preview-web-{SANDBOX_ID}.{ZONE}"), "/").await;
    assert_eq!(
        preview.body,
        format!("served preview-web-{SANDBOX_ID}.{ZONE}/")
    );
    assert_eq!(
        get(edge.port, &daemon_host(OTHER_ID), "/").await.status,
        502
    );
    // Hop-by-hop headers never cross into the session.
    assert!(sandbox.last_seen().get("connection").is_none());
}

#[tokio::test]
async fn a_request_body_and_a_long_answer_stream_through_whole() {
    let keys = Keys::default();
    let edge = start(lone(&keys)).await;
    let answering: support::Answering = Arc::new(|request| {
        let length: usize = request
            .headers()
            .get("content-length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .unwrap_or_default();
        if request.uri().path() == "/upload" {
            return Response::new(body::full(format!("declared {length}")));
        }
        Response::new(body::full(vec![b'x'; 8 * 1024 * 1024]))
    });
    let _sandbox = dial(edge.port, &keys.grant(SANDBOX_ID), None, answering)
        .await
        .unwrap();
    wait_for("the tunnel to register", || {
        edge.edge.registry().size() == 1
    })
    .await;

    let download = get(edge.port, &daemon_host(SANDBOX_ID), "/big").await;
    assert_eq!(download.body.len(), 8 * 1024 * 1024);
    let upload = send(
        edge.port,
        Method::POST,
        &daemon_host(SANDBOX_ID),
        "/upload",
        &[],
        Bytes::from(vec![b'y'; 3 * 1024 * 1024]),
    )
    .await;
    assert_eq!(upload.body, "declared 3145728");
}

#[tokio::test]
async fn a_browser_that_goes_away_stops_the_daemons_answer() {
    let keys = Keys::default();
    let edge = start(lone(&keys)).await;
    let dropped = Arc::new(AtomicBool::new(false));
    let noticing = dropped.clone();
    let answering: support::Answering = Arc::new(move |_| {
        let guard = Guard(noticing.clone());
        let frames = futures_util::stream::unfold(Some(guard), |guard| async move {
            let guard = guard?;
            tokio::time::sleep(Duration::from_millis(20)).await;
            Some((
                Ok::<_, body::BoxError>(Frame::data(Bytes::from_static(b"data: tick\n\n"))),
                Some(guard),
            ))
        });
        Response::new(StreamBody::new(frames).boxed_unsync())
    });
    let _sandbox = dial(edge.port, &keys.grant(SANDBOX_ID), None, answering)
        .await
        .unwrap();
    wait_for("the tunnel to register", || {
        edge.edge.registry().size() == 1
    })
    .await;

    let mut browser = tokio::net::TcpStream::connect(("127.0.0.1", edge.port))
        .await
        .unwrap();
    browser
        .write_all(
            format!(
                "GET /events HTTP/1.1\r\nHost: {}\r\n\r\n",
                daemon_host(SANDBOX_ID)
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut first = [0_u8; 64];
    assert!(browser.read(&mut first).await.unwrap() > 0);
    drop(browser);
    wait_for("the daemon's stream to be cancelled", || {
        dropped.load(Ordering::Relaxed)
    })
    .await;
}

struct Guard(Arc<AtomicBool>);

impl Drop for Guard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

#[tokio::test]
async fn an_upgrade_rides_the_tunnel_and_is_spliced_to_the_browser() {
    let keys = Keys::default();
    let edge = start(lone(&keys)).await;
    let sandbox = dial(edge.port, &keys.grant(SANDBOX_ID), None, serving("served"))
        .await
        .unwrap();
    wait_for("the tunnel to register", || {
        edge.edge.registry().size() == 1
    })
    .await;

    let (head, mut socket) = upgrade(edge.port, &daemon_host(SANDBOX_ID), "/ws?x=1", "echo").await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    assert!(
        head.to_ascii_lowercase().contains("upgrade: echo"),
        "{head}"
    );
    socket.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    socket.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
    // The browser's own head crossed whole: its upgrade headers ride the envelope that h2 would otherwise refuse.
    let seen = sandbox.last_seen();
    assert_eq!(seen["upgrade"], "echo");
    assert_eq!(seen["host"], daemon_host(SANDBOX_ID).as_str());

    // A daemon that declines is relayed as its own answer, not hung on.
    let (head, _) = upgrade(
        edge.port,
        &format!("nobody-{SANDBOX_ID}.{ZONE}"),
        "/ws",
        "echo",
    )
    .await;
    assert!(head.starts_with("HTTP/1.1 502"), "{head}");
}

#[tokio::test]
async fn a_second_tunnel_displaces_the_first_with_the_displacement_code() {
    let keys = Keys::default();
    let edge = start(lone(&keys)).await;
    let first = dial(edge.port, &keys.grant(SANDBOX_ID), None, serving("first"))
        .await
        .unwrap();
    wait_for("the first tunnel", || edge.edge.registry().size() == 1).await;
    let _second = dial(edge.port, &keys.grant(SANDBOX_ID), None, serving("second"))
        .await
        .unwrap();
    assert_eq!(
        first.ended.await.unwrap(),
        Ended::Closed(Some(DISPLACED_CODE))
    );
    wait_for("the second tunnel to answer", || true).await;
    let answer = get(edge.port, &daemon_host(SANDBOX_ID), "/").await;
    assert!(answer.body.starts_with("second "), "{}", answer.body);
    assert_eq!(edge.edge.registry().size(), 1);
}

#[tokio::test]
async fn a_tunnel_that_closes_is_forgotten() {
    let keys = Keys::default();
    let edge = start(lone(&keys)).await;
    let sandbox = dial(edge.port, &keys.grant(SANDBOX_ID), None, serving("served"))
        .await
        .unwrap();
    wait_for("the tunnel to register", || {
        edge.edge.registry().size() == 1
    })
    .await;
    sandbox.close();
    wait_for("the tunnel to be forgotten", || {
        edge.edge.registry().size() == 0
    })
    .await;
    assert_eq!(
        get(edge.port, &daemon_host(SANDBOX_ID), "/").await.status,
        502
    );
}

#[tokio::test]
async fn a_tunnel_for_a_sandbox_the_platform_deleted_is_refused() {
    let keys = Keys::default();
    let platform = platform(HashMap::from([(
        OTHER_ID.to_owned(),
        (200, r#"{"ok":true,"lane":"tunnel"}"#.to_owned()),
    )]))
    .await;
    let mut options = lone(&keys);
    options.revocation = Revocation::new(&platform.url);
    let edge = start(options).await;
    assert_eq!(
        dial(edge.port, &keys.grant(SANDBOX_ID), None, serving("x"))
            .await
            .err(),
        Some(403)
    );
    assert!(
        dial(edge.port, &keys.grant(OTHER_ID), None, serving("x"))
            .await
            .is_ok()
    );
}

// A hosted sandbox is a Fly app with no tunnel; a request for its name gets the headers that make Fly's proxy replay it
// there. Pins which ids replay, to which app, and that a tunnel-lane sandbox still gets its 502.
mod replay {
    use super::*;

    const HOSTED_ID: &str = "feedfacecafe";
    const NAMED_ID: &str = "0badf00dbeef";
    const UNKNOWN_ID: &str = "abcdef000000";
    const GONE_ID: &str = "deadbeef0000";

    async fn router() -> (support::Running, support::Platform) {
        let keys = Keys::default();
        let platform = platform(HashMap::from([
            (
                HOSTED_ID.to_owned(),
                (200, r#"{"ok":true,"lane":"hosted"}"#.to_owned()),
            ),
            (
                NAMED_ID.to_owned(),
                (
                    200,
                    r#"{"ok":true,"lane":"hosted","app":"renamed-app"}"#.to_owned(),
                ),
            ),
            (
                SANDBOX_ID.to_owned(),
                (200, r#"{"ok":true,"lane":"tunnel"}"#.to_owned()),
            ),
            (UNKNOWN_ID.to_owned(), (200, r#"{"ok":true}"#.to_owned())),
        ]))
        .await;
        let mut options = lone(&keys);
        options.revocation = Revocation::new(&platform.url);
        options.hosted_app_prefix = Some("intentic-sbx".into());
        options.build = "turbo-testbuild".into();
        (start(options).await, platform)
    }

    #[tokio::test]
    async fn a_hosted_sandboxs_names_replay_to_its_app_each_cached_by_its_own_name() {
        let (edge, _platform) = router().await;
        let answer = get(edge.port, &daemon_host(HOSTED_ID), "/events").await;
        assert_eq!(answer.status, 200);
        assert_eq!(
            answer.headers["fly-replay"],
            format!("app=intentic-sbx-{HOSTED_ID}").as_str()
        );
        assert_eq!(
            answer.headers["fly-replay-cache"],
            format!("sandbox-{HOSTED_ID}.{ZONE}/*").as_str()
        );
        assert_eq!(
            answer.headers["fly-replay-cache-ttl-secs"],
            REPLAY_CACHE_TTL_SECS.to_string().as_str()
        );

        let preview = get(
            edge.port,
            &format!("preview-web-{HOSTED_ID}.{ZONE}:443"),
            "/",
        )
        .await;
        assert_eq!(
            preview.headers["fly-replay"],
            format!("app=intentic-sbx-{HOSTED_ID}").as_str()
        );
        assert_eq!(
            preview.headers["fly-replay-cache"],
            format!("preview-web-{HOSTED_ID}.{ZONE}/*").as_str()
        );
    }

    #[tokio::test]
    async fn the_app_the_platform_names_wins_and_an_unnamed_lane_still_replays() {
        let (edge, _platform) = router().await;
        assert_eq!(
            get(edge.port, &daemon_host(NAMED_ID), "/").await.headers["fly-replay"],
            "app=renamed-app"
        );
        assert_eq!(
            get(edge.port, &daemon_host(UNKNOWN_ID), "/").await.headers["fly-replay"],
            format!("app=intentic-sbx-{UNKNOWN_ID}").as_str()
        );
    }

    // Deleted and merely off are the same 502 on the wire; only the verdict separates "wait" from "never coming back".
    #[tokio::test]
    async fn a_tunnel_sandbox_keeps_its_502_and_a_deleted_one_is_named_unknown() {
        let (edge, _platform) = router().await;
        let off = get(edge.port, &daemon_host(SANDBOX_ID), "/").await;
        assert_eq!(off.status, 502);
        assert!(off.body.contains(&format!("sandbox-{SANDBOX_ID}")));
        assert_eq!(off.headers[VERDICT_HEADER], "no-tunnel");
        let gone = get(edge.port, &daemon_host(GONE_ID), "/").await;
        assert_eq!(gone.status, 502);
        assert!(gone.headers.get("fly-replay").is_none());
        assert_eq!(gone.headers[VERDICT_HEADER], "unknown-sandbox");
        assert!(gone.body.contains("no longer exists"));
    }

    // Fly requires the app sending a replay not to negotiate the WebSocket itself: the 101 comes from the sandbox.
    #[tokio::test]
    async fn an_upgrade_is_replayed_by_not_taking_it() {
        let (edge, _platform) = router().await;
        let (head, mut socket) = upgrade(
            edge.port,
            &daemon_host(HOSTED_ID),
            "/system/terminal",
            "websocket",
        )
        .await;
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(
            head.contains(&format!("fly-replay: app=intentic-sbx-{HOSTED_ID}")),
            "{head}"
        );
        let mut rest = Vec::new();
        socket.read_to_end(&mut rest).await.unwrap();
        assert!(!head.contains("101"));
    }

    #[tokio::test]
    async fn health_says_it_replays_and_names_its_build() {
        let (edge, _platform) = router().await;
        let health: serde_json::Value = serde_json::from_str(
            &get(edge.port, &format!("ingress.{ZONE}"), "/health")
                .await
                .body,
        )
        .unwrap();
        assert_eq!(health["replay"], true);
        assert_eq!(health["build"], "turbo-testbuild");
    }
}

// Two tunnels per sandbox: a transfer rides the bulk one when this machine holds it, and the interactive one otherwise.
mod lanes {
    use super::*;

    #[tokio::test]
    async fn a_transfer_and_a_previews_dev_server_ride_bulk_and_a_call_stays_interactive() {
        let keys = Keys::default();
        let edge = start(lone(&keys)).await;
        let _interactive = dial(
            edge.port,
            &keys.grant(SANDBOX_ID),
            None,
            serving("interactive"),
        )
        .await
        .unwrap();
        let _bulk = dial(
            edge.port,
            &keys.grant(SANDBOX_ID),
            Some("bulk"),
            serving("bulk"),
        )
        .await
        .unwrap();
        wait_for("both lanes", || {
            edge.edge
                .registry()
                .lookup(SANDBOX_ID, intentic_ingress::registry::Slot::Bulk)
                .is_some()
                && edge.edge.registry().size() == 1
        })
        .await;
        let host = daemon_host(SANDBOX_ID);
        assert!(
            get(edge.port, &host, "/workspace/media?path=a.mp4")
                .await
                .body
                .starts_with("bulk ")
        );
        assert!(
            get(
                edge.port,
                &format!("preview-web-{SANDBOX_ID}.{ZONE}"),
                "/src/main.ts"
            )
            .await
            .body
            .starts_with("bulk ")
        );
        assert!(
            get(edge.port, &host, "/agents")
                .await
                .body
                .starts_with("interactive ")
        );
        assert_eq!(edge.edge.registry().ids(), [SANDBOX_ID]);
    }

    #[tokio::test]
    async fn a_transfer_rides_the_interactive_tunnel_while_no_bulk_one_is_held() {
        let keys = Keys::default();
        let edge = start(lone(&keys)).await;
        let _interactive = dial(
            edge.port,
            &keys.grant(SANDBOX_ID),
            None,
            serving("interactive"),
        )
        .await
        .unwrap();
        wait_for("the tunnel", || edge.edge.registry().size() == 1).await;
        let answer = get(
            edge.port,
            &daemon_host(SANDBOX_ID),
            "/workspace/media?path=a.mp4",
        )
        .await;
        assert!(answer.body.starts_with("interactive "), "{}", answer.body);
    }
}

// A restart must not wait on the browsers: every stream through a tunnel is long-lived by design.
#[tokio::test]
async fn stopping_cuts_a_browser_still_holding_a_stream_and_closes_every_tunnel() {
    let keys = Keys::default();
    let running = start(lone(&keys)).await;
    let answering: support::Answering = Arc::new(|_| {
        let frames = futures_util::stream::once(async {
            Ok::<_, body::BoxError>(Frame::data(Bytes::from_static(b"data: open\n\n")))
        })
        .chain(futures_util::stream::pending());
        Response::new(StreamBody::new(frames).boxed_unsync())
    });
    let sandbox = dial(running.port, &keys.grant(SANDBOX_ID), None, answering)
        .await
        .unwrap();
    wait_for("the tunnel to register", || {
        running.edge.registry().size() == 1
    })
    .await;
    let mut browser = tokio::net::TcpStream::connect(("127.0.0.1", running.port))
        .await
        .unwrap();
    browser
        .write_all(
            format!(
                "GET /events HTTP/1.1\r\nHost: {}\r\n\r\n",
                daemon_host(SANDBOX_ID)
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut first = [0_u8; 256];
    assert!(browser.read(&mut first).await.unwrap() > 0);

    running.edge.registry().close_all(&tunnel::Close::AWAY);
    running.listening.stop().await;
    let mut rest = Vec::new();
    let cut = tokio::time::timeout(Duration::from_secs(5), browser.read_to_end(&mut rest)).await;
    assert!(cut.is_ok(), "the browser's stream was left open");
    assert_eq!(sandbox.ended.await.unwrap(), Ended::Closed(Some(1001)));
}

use futures_util::StreamExt;
