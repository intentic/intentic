//! Phase 1 on the daemon: signing in, the `/events` stream, and the board's roster.

use crate::contract::{Samples, assert_daemon_route};
use intentic_mobile::wire::agents::{self, AgentStatus, AgentSummary, AgentsList};
use intentic_mobile::wire::events::{self, SystemEvent};
use intentic_mobile::wire::lanes::Lane;
use intentic_mobile::wire::session::{
    self, DaemonSession, PasskeyRequired, Refusal, RefusalReason,
};

#[test]
fn session() {
    let mut samples = Samples::load("session.json");
    let sessions = samples.checked::<DaemonSession>("DaemonSessionSchema");
    assert_eq!(sessions[0].1.email, "ada@example.com");
    let step_ups = samples.checked::<PasskeyRequired>("PasskeyRequiredSchema");
    assert_eq!(step_ups.len(), 2);
    let refusals = samples.decoded::<Refusal>("Refusal");
    let reasons: Vec<Option<RefusalReason>> = refusals
        .iter()
        .map(|(_, refusal)| refusal.reason.clone())
        .collect();
    assert!(reasons.contains(&Some(RefusalReason::PlatformKeyUnknown)));
    assert!(reasons.contains(&Some(RefusalReason::EmailSignInOff)));
    samples.finish();
    assert_daemon_route(session::SESSION);
}

#[test]
fn events() {
    let mut samples = Samples::load("events.json");
    for (label, event) in samples.checked::<SystemEvent>("SystemEventSchema") {
        // A frame of a kind this build reads must land in its own variant: `Other` would mean a shape it cannot read.
        let ignored = label.contains("ignores");
        assert_eq!(
            matches!(event, SystemEvent::Other(_)),
            ignored,
            "{label}: {event:?}"
        );
        if let SystemEvent::Hello(hello) = &event {
            assert!(!hello.workspace_id.is_empty());
        }
    }
    for (label, event) in samples.decoded::<SystemEvent>("SystemEvent") {
        assert!(matches!(event, SystemEvent::Other(_)), "{label}");
    }
    samples.finish();
    assert_daemon_route(events::EVENTS);
    assert_eq!(events::events_query(Some("c_8b1e")), "?clientId=c_8b1e");
}

#[test]
fn board() {
    let mut samples = Samples::load("agents.json");
    let cards = samples.checked::<AgentSummary>("AgentSummarySchema");
    let card = |label: &str| {
        &cards
            .iter()
            .find(|(name, _)| name.starts_with(label))
            .unwrap()
            .1
    };
    let lane = |label: &str| card(label).lane();
    assert_eq!(lane("running"), Lane::Active);
    assert_eq!(lane("waiting on a permission"), Lane::Attention);
    assert_eq!(lane("a spent allowance booked"), Lane::Active);
    assert_eq!(lane("a child that stopped"), Lane::Active);
    assert_eq!(lane("watching a CI run"), Lane::Attention);
    assert_eq!(lane("landed"), Lane::Finished);
    assert_eq!(lane("a land your own edits block"), Lane::Attention);
    let running = card("running");
    assert!(!running.unread() && running.status == AgentStatus::Running);
    assert!(!card("a spent allowance").unread() && card("a child that stopped").unread());
    let lists = samples.checked::<AgentsList>("AgentsListSchema");
    assert_eq!(lists[0].1.held.len(), 1);
    samples.finish();
    for route in [
        agents::AGENTS,
        agents::AGENT,
        agents::SEEN,
        agents::SEEN_ALL,
    ] {
        assert_daemon_route(route);
    }
}

/// The check that keeps the types honest refuses a renamed field and a missing required one.
#[test]
fn the_check_bites() {
    use crate::contract::is_valid;
    let session = serde_json::json!({ "token": "t", "expiresAt": 1, "email": "ada@example.com" });
    assert!(is_valid("DaemonSessionSchema", &session));
    let renamed = serde_json::json!({ "token": "t", "expires_at": 1, "email": "ada@example.com" });
    assert!(!is_valid("DaemonSessionSchema", &renamed));
    let short = serde_json::json!({ "token": "t", "expiresAt": 1 });
    assert!(!is_valid("DaemonSessionSchema", &short));
}

/// The same for a field deep inside a recursive schema (a tool card in the attach head, reached through `$ref`).
#[test]
fn the_check_reaches_nested_rows() {
    use crate::contract::is_valid;
    let head = |tool: serde_json::Value| {
        serde_json::json!({
            "kind": "attached", "run": "r", "startedAt": 1, "seq": 1,
            "rows": [{ "role": "assistant", "text": "", "tools": [tool] }]
        })
    };
    let tool =
        serde_json::json!({ "id": "t", "name": "Read", "category": "read", "status": "completed" });
    assert!(is_valid("AttachFrameSchema", &head(tool.clone())));
    let mut renamed = tool;
    renamed["exit_code"] = serde_json::json!(1);
    assert!(!is_valid("AttachFrameSchema", &head(renamed)));
}
