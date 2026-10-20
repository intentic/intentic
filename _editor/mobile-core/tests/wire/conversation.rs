//! Phases 2 and 3 on the daemon: reading a conversation (its rows, the attach stream, history pages) and acting in it.

use crate::contract::{Samples, assert_daemon_route};
use intentic_mobile::wire::act::{
    self, Accepted, MessageReceipt, Reply, SendMessage, Steer, StopResult, StopTurn,
};
use intentic_mobile::wire::attach::{
    self, AgentTranscript, AttachFrame, AttachTurn, ToolChildren, TranscriptPatch, TurnFact,
};
use intentic_mobile::wire::cards::{CardKind, CardStatus};
use intentic_mobile::wire::push::{self, PushChannel, PushChannelId, PushConfig, SentNotification};
use intentic_mobile::wire::transcript::{Role, Speaker, ToolContent, TranscriptRow};

#[test]
fn rows() {
    let mut samples = Samples::load("transcript.json");
    let rows = samples.checked::<TranscriptRow>("TranscriptRowSchema");
    let row = |label: &str| {
        &rows
            .iter()
            .find(|(name, _)| name.starts_with(label))
            .unwrap()
            .1
    };
    let cards: Vec<(CardKind, CardStatus)> = rows
        .iter()
        .filter_map(|(_, row)| row.card().map(|(kind, card)| (kind, card.status.clone())))
        .collect();
    assert_eq!(cards.len(), 9, "one sample per card kind: {cards:?}");
    assert!(cards.contains(&(CardKind::Permission, CardStatus::Always)));
    let plan = row("a plan").card().unwrap().1;
    assert!(plan.status.is_pending() && plan.text("text").unwrap().starts_with("1."));
    let prose = row("the agent's prose");
    let tools = prose.tools.as_deref().unwrap();
    assert!(matches!(
        tools[1].content.as_deref().unwrap()[0],
        ToolContent::Diff { .. }
    ));
    assert_eq!(tools[3].children.as_ref().unwrap().len(), 1);
    assert_eq!(row("a person's").role, Role::User);
    assert!(matches!(
        row("a child").speaker,
        Some(Speaker::Agent { .. })
    ));
    samples.finish();
}

#[test]
fn attach_stream() {
    let mut samples = Samples::load("attach.json");
    samples.checked::<AttachTurn>("AttachTurnSchema");
    for (label, frame) in samples.checked::<AttachFrame>("AttachFrameSchema") {
        let typed = match &frame {
            AttachFrame::Fact { fact, .. } => !matches!(**fact, TurnFact::Other(_)),
            AttachFrame::Patch { patch, .. } => !matches!(patch, TranscriptPatch::Other(_)),
            AttachFrame::Other(_) => false,
            AttachFrame::Attached { .. } | AttachFrame::End => true,
        };
        assert_eq!(typed, !label.contains("ignores"), "{label}: {frame:?}");
    }
    samples.checked::<TranscriptPatch>("TranscriptPatchSchema");
    let pages = samples.checked::<AgentTranscript>("AgentTranscriptSchema");
    assert!(pages[0].1.more && pages[0].1.from == 12);
    samples.checked::<ToolChildren>("AgentToolChildrenSchema");
    for (label, frame) in samples.decoded::<AttachFrame>("AttachFrame") {
        assert!(matches!(frame, AttachFrame::Other(_)), "{label}");
    }
    for (label, patch) in samples.decoded::<TranscriptPatch>("TranscriptPatch") {
        assert!(matches!(patch, TranscriptPatch::Other(_)), "{label}");
    }
    samples.finish();
    for route in [attach::ATTACH, attach::TRANSCRIPT, attach::TOOL_CHILDREN] {
        assert_daemon_route(route);
    }
    assert_eq!(
        attach::transcript_query(Some(12), Some(10)),
        "?before=12&turns=10"
    );
}

#[test]
fn acting() {
    let mut samples = Samples::load("act.json");
    samples.checked::<SendMessage>("AgentRunSchema");
    let receipts = samples.checked::<MessageReceipt>("MessageReceiptSchema");
    assert!(
        receipts
            .iter()
            .any(|(_, receipt)| receipt.duplicate.is_some())
    );
    samples.checked::<Steer>("SteerSchema");
    let replies = samples.checked::<Reply>("AgentReplySchema");
    assert_eq!(replies.len(), 13);
    samples.checked::<Accepted>("OkSchema");
    let stops = samples.checked::<StopTurn>("StopTurnSchema");
    assert!(
        stops
            .iter()
            .any(|(_, stop)| matches!(stop, StopTurn::Message { .. }))
    );
    assert!(
        stops
            .iter()
            .any(|(_, stop)| matches!(stop, StopTurn::Live { .. }))
    );
    samples.checked::<StopResult>("StopResultSchema");
    samples.finish();
    for route in [act::SEND, act::STEER, act::REPLY, act::STOP] {
        assert_daemon_route(route);
    }
}

#[test]
fn notifications() {
    let mut samples = Samples::load("push.json");
    samples.checked::<PushChannel>("PushChannelSchema");
    samples.checked::<PushChannelId>("PushChannelIdSchema");
    samples.checked::<PushConfig>("PushConfigSchema");
    samples.checked::<SentNotification>("PushSentNotificationSchema");
    samples.checked::<serde_json::Value>("PushSentQuerySchema");
    samples.finish();
    for route in [
        push::SUBSCRIBE,
        push::UNSUBSCRIBE,
        push::CONFIG,
        push::NOTIFICATION,
    ] {
        assert_daemon_route(route);
    }
}
