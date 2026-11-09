//! Asking the platform whether a sandbox exists, against a real platform: only its own deletion record refuses, and only
//! once said twice; every failure, and every other 404, answers that it exists, and an answer is kept for its time while
//! a failure never is.

mod support;

use std::collections::HashMap;
use std::time::Duration;

use intentic_ingress::revocation::{Revocation, Standing};

use support::{DELETION_RECORD, SANDBOX_ID, platform};

fn answering(status: u16, body: &str) -> HashMap<String, (u16, String)> {
    HashMap::from([(SANDBOX_ID.to_owned(), (status, body.to_owned()))])
}

// Confirms on the second question, however soon: what a test of the record itself wants.
fn confirming_at_once(url: &str) -> Revocation {
    Revocation::new(url).confirming_after(Duration::ZERO)
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
async fn the_platforms_deletion_record_refuses_once_said_twice() {
    for record in [
        DELETION_RECORD,
        r#"{"error":"deleted sandbox","deleted":true}"#,
    ] {
        let platform = platform(answering(404, record)).await;
        let revocation = confirming_at_once(&platform.url);
        assert_eq!(
            revocation.standing(SANDBOX_ID).await,
            Standing::Doubted,
            "{record}"
        );
        assert!(!revocation.allows(SANDBOX_ID).await, "{record}");
        assert_eq!(
            revocation.standing(SANDBOX_ID).await,
            Standing::Deleted,
            "{record}"
        );
        assert_eq!(
            platform.asked.lock().unwrap().len(),
            2,
            "the deletion is kept: {record}"
        );
    }
}

// Something in front of the api answers 404 too: a hostname routed elsewhere, a placeholder page, the api's own answer
// for an id outside the alphabet. None of them is the platform saying the sandbox was deleted.
#[tokio::test]
async fn a_404_that_is_not_the_record_and_every_failure_answer_that_it_exists() {
    for (status, body) in [
        (404, "gone"),
        (404, "404 Not Found"),
        (
            404,
            "<!DOCTYPE html><html><body>There is nothing here.</body></html>",
        ),
        (404, r#"{"error":"not a sandbox id"}"#),
        (404, "{}"),
        (404, ""),
        (500, DELETION_RECORD),
        (503, "later"),
    ] {
        let platform = platform(answering(status, body)).await;
        let revocation = confirming_at_once(&platform.url);
        for _ in 0..3 {
            assert_eq!(
                revocation.standing(SANDBOX_ID).await,
                Standing::Exists,
                "{status} {body}"
            );
        }
    }
    assert_eq!(
        confirming_at_once("http://127.0.0.1:1")
            .standing(SANDBOX_ID)
            .await,
        Standing::Exists
    );
}

// The second word must come a while after the first: asked sooner, the doubt stands without asking the platform.
#[tokio::test]
async fn a_doubt_is_confirmed_no_sooner_than_its_wait() {
    let platform = platform(answering(404, DELETION_RECORD)).await;
    let revocation = Revocation::new(&platform.url).confirming_after(Duration::from_millis(300));
    assert_eq!(revocation.standing(SANDBOX_ID).await, Standing::Doubted);
    assert_eq!(revocation.standing(SANDBOX_ID).await, Standing::Doubted);
    assert!(revocation.allows(SANDBOX_ID).await);
    assert_eq!(platform.asked.lock().unwrap().len(), 1);
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(revocation.standing(SANDBOX_ID).await, Standing::Deleted);
    assert_eq!(platform.asked.lock().unwrap().len(), 2);
}

// An answer that it exists between the two clears the doubt, and a failure between them neither clears nor confirms it.
#[tokio::test]
async fn an_answer_that_it_exists_clears_the_doubt_and_a_failure_does_not() {
    let platform = platform(answering(404, DELETION_RECORD)).await;
    let revocation =
        Revocation::keeping(&platform.url, Duration::ZERO).confirming_after(Duration::ZERO);
    assert_eq!(revocation.standing(SANDBOX_ID).await, Standing::Doubted);
    platform.answer(SANDBOX_ID, 200, r#"{"ok":true,"lane":"tunnel"}"#);
    assert_eq!(revocation.standing(SANDBOX_ID).await, Standing::Exists);
    platform.answer(SANDBOX_ID, 404, DELETION_RECORD);
    assert_eq!(
        revocation.standing(SANDBOX_ID).await,
        Standing::Doubted,
        "it starts over"
    );

    platform.answer(SANDBOX_ID, 502, "<html>Bad Gateway</html>");
    assert_eq!(revocation.standing(SANDBOX_ID).await, Standing::Exists);
    platform.answer(SANDBOX_ID, 404, "<html>Not Found</html>");
    assert_eq!(revocation.standing(SANDBOX_ID).await, Standing::Exists);
    platform.answer(SANDBOX_ID, 404, DELETION_RECORD);
    assert_eq!(revocation.standing(SANDBOX_ID).await, Standing::Deleted);
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
