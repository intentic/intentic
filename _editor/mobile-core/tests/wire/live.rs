//! Decodes what this sandbox's own daemon sent, when `fixtures/record-live.mjs` has recorded it into `fixtures/live/`
//! (ignored by git: it holds the owner's conversations). Skipped where nothing was recorded, as on CI. The samples
//! prove the types match the contract; this proves they match a daemon that is actually running, which can be newer.

use crate::contract::is_valid;
use intentic_mobile::wire::agents::AgentsList;
use intentic_mobile::wire::attach::{AgentTranscript, AttachFrame, TranscriptPatch, TurnFact};
use intentic_mobile::wire::events::SystemEvent;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn recorded<T: DeserializeOwned>(name: &str) -> Option<T> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/live")
        .join(name);
    let text = std::fs::read_to_string(&path).ok()?;
    Some(serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display())))
}

/// Written back, a typed value must still be what the contract allows.
fn still_valid<T: Serialize>(key: &str, what: &str, value: &T) {
    let written = serde_json::to_value(value).unwrap();
    assert!(
        is_valid(key, &written),
        "{what}, written back, is not a valid {key}"
    );
}

#[test]
fn live_events() {
    let Some(frames) = recorded::<Vec<serde_json::Value>>("events.json") else {
        return;
    };
    for frame in frames {
        let kind = frame["kind"].as_str().unwrap_or_default().to_owned();
        let event: SystemEvent =
            serde_json::from_value(frame).unwrap_or_else(|error| panic!("{kind}: {error}"));
        let read = ["hello", "heartbeat", "boot", "presence", "agents"].contains(&kind.as_str());
        assert_eq!(
            !matches!(event, SystemEvent::Other(_)),
            read,
            "{kind} landed in the wrong variant"
        );
        still_valid("SystemEventSchema", &kind, &event);
    }
}

#[test]
fn live_board() {
    let Some(fleet) = recorded::<AgentsList>("agents.json") else {
        return;
    };
    for agent in &fleet.agents {
        let _ = (agent.lane(), agent.unread());
    }
    still_valid("AgentsListSchema", "the fleet", &fleet);
}

#[test]
fn live_conversations() {
    if let Some(pages) = recorded::<BTreeMap<String, AgentTranscript>>("transcripts.json") {
        for (id, page) in &pages {
            still_valid("AgentTranscriptSchema", id, page);
        }
    }
    let Some(runs) = recorded::<BTreeMap<String, Vec<serde_json::Value>>>("attach.json") else {
        return;
    };
    for (id, frames) in runs {
        for frame in frames {
            let frame: AttachFrame =
                serde_json::from_value(frame).unwrap_or_else(|error| panic!("{id}: {error}"));
            match &frame {
                AttachFrame::Other(other) => {
                    panic!("{id}: a frame this build cannot read: {other}")
                }
                AttachFrame::Patch {
                    patch: TranscriptPatch::Other(other),
                    ..
                } => panic!("{id}: a patch this build cannot read: {other}"),
                // Facts this build does not show land in Other by design; the ones it shows must not.
                AttachFrame::Fact { fact, .. } => {
                    if let TurnFact::Other(other) = fact.as_ref() {
                        let kind = other["kind"].as_str().unwrap_or_default();
                        let shown = [
                            "session",
                            "worktree",
                            "usage",
                            "context_usage",
                            "agent_status",
                            "provider_retry",
                            "mode",
                            "error",
                        ];
                        assert!(
                            !shown.contains(&kind),
                            "{id}: a {kind} fact this build cannot read: {other}"
                        );
                    }
                }
                _ => {}
            }
            still_valid("AttachFrameSchema", &id, &frame);
        }
    }
}
