//! Asking the platform whether a sandbox exists, against a real platform: only a 404 refuses, every failure answers that
//! it exists, and an answer is kept for its time while a failure never is.

mod support;

use std::collections::HashMap;
use std::time::Duration;

use intentic_ingress::revocation::Revocation;

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
}

// The lane the platform names is no longer read: a hosted sandbox and a tunnel one both exist, and so does one on a
// platform too old to name any, or one answering something that is not JSON at all.
#[tokio::test]
async fn any_success_says_the_sandbox_exists_whatever_its_body() {
    for body in [
        r#"{"ok":true,"lane":"hosted","app":"intentic-sbx-abcdef012345"}"#,
        r#"{"ok":true,"lane":"tunnel"}"#,
        r#"{"ok":true}"#,
        "ok",
    ] {
        let answering = platform(answering(200, body)).await;
        assert!(
            Revocation::new(&answering.url).allows(SANDBOX_ID).await,
            "{body}"
        );
    }
}
