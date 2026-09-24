//! Asking the platform whether a sandbox exists, against a real platform: only a 404 refuses, every failure answers that
//! it exists, and an answer is kept for its time while a failure never is.

mod support;

use std::collections::HashMap;
use std::time::Duration;

use intentic_ingress::revocation::{Reach, Reachability, Revocation};

use support::{SANDBOX_ID, platform};

fn answering(status: u16, body: &str) -> HashMap<String, (u16, String)> {
    HashMap::from([(SANDBOX_ID.to_owned(), (status, body.to_owned()))])
}

#[tokio::test]
async fn the_platform_is_asked_by_the_sandboxs_id_trailing_slash_or_not() {
    let platform = platform(answering(200, "ok")).await;
    assert!(Revocation::new(&platform.url).allows(SANDBOX_ID).await);
    assert!(
        Revocation::new(&format!("{}/", platform.url))
            .allows(SANDBOX_ID)
            .await
    );
    assert_eq!(
        *platform.asked.lock().unwrap(),
        [
            format!("/api/reachability/{SANDBOX_ID}"),
            format!("/api/reachability/{SANDBOX_ID}")
        ]
    );
}

#[tokio::test]
async fn only_a_404_refuses() {
    assert!(
        !Revocation::new(&platform(answering(404, "gone")).await.url)
            .allows(SANDBOX_ID)
            .await
    );
    assert!(
        Revocation::new(&platform(answering(500, "boom")).await.url)
            .allows(SANDBOX_ID)
            .await
    );
    assert!(
        Revocation::new("http://127.0.0.1:1")
            .allows(SANDBOX_ID)
            .await
    );
}

#[tokio::test]
async fn an_answer_is_kept_for_its_time_and_a_failure_never() {
    let platform_ok = platform(answering(200, "ok")).await;
    let revocation = Revocation::keeping(&platform_ok.url, Duration::from_millis(300));
    revocation.allows(SANDBOX_ID).await;
    revocation.allows(SANDBOX_ID).await;
    assert_eq!(platform_ok.asked.lock().unwrap().len(), 1);
    tokio::time::sleep(Duration::from_millis(350)).await;
    revocation.allows(SANDBOX_ID).await;
    let asked = platform_ok.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 2, "{asked:?}");

    let failing = platform(answering(503, "later")).await;
    let revocation = Revocation::new(&failing.url);
    revocation.allows(SANDBOX_ID).await;
    revocation.allows(SANDBOX_ID).await;
    let asked = failing.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 2, "{asked:?}");
}

#[tokio::test]
async fn with_no_platform_nothing_is_asked_and_everything_exists() {
    let revocation = Revocation::new("");
    assert!(!revocation.enforced());
    assert!(revocation.allows(SANDBOX_ID).await);
    assert_eq!(
        revocation.lookup(SANDBOX_ID).await,
        Reachability {
            exists: true,
            reach: None,
            app: None
        }
    );
}

#[tokio::test]
async fn a_lookup_reads_the_lane_and_the_app_and_shares_its_cache_with_the_gate() {
    let hosted = platform(answering(
        200,
        r#"{"ok":true,"lane":"hosted","app":"intentic-sbx-abcdef012345"}"#,
    ))
    .await;
    let revocation = Revocation::new(&hosted.url);
    assert_eq!(
        revocation.lookup(SANDBOX_ID).await,
        Reachability {
            exists: true,
            reach: Some(Reach::Hosted),
            app: Some("intentic-sbx-abcdef012345".into())
        }
    );
    assert!(revocation.allows(SANDBOX_ID).await);
    assert_eq!(hosted.asked.lock().unwrap().len(), 1);

    let tunnel = platform(answering(200, r#"{"ok":true,"lane":"tunnel"}"#)).await;
    assert_eq!(
        Revocation::new(&tunnel.url).lookup(SANDBOX_ID).await.reach,
        Some(Reach::Tunnel)
    );
    // An older platform answers `{ ok: true }` alone: the sandbox exists on a lane it did not name.
    let older = platform(answering(200, r#"{"ok":true}"#)).await;
    assert_eq!(
        Revocation::new(&older.url).lookup(SANDBOX_ID).await,
        Reachability {
            exists: true,
            reach: None,
            app: None
        }
    );
    let gone = platform(answering(404, "{}")).await;
    assert!(!Revocation::new(&gone.url).lookup(SANDBOX_ID).await.exists);
    assert!(
        Revocation::new("http://127.0.0.1:1")
            .lookup(SANDBOX_ID)
            .await
            .exists
    );
}
