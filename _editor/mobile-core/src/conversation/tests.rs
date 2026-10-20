use super::*;
use crate::wire::transcript::{Role, ToolKind, ToolStatus};

fn row(role: Role, text: &str, run: Option<&str>) -> TranscriptRow {
    serde_json::from_value(serde_json::json!({
        "role": role.as_str(), "text": text, "run": run,
    }))
    .unwrap()
}

fn tool(id: &str, status: ToolStatus) -> Tool {
    Tool {
        id: id.into(),
        name: "Read".into(),
        category: ToolKind::Read,
        status,
        target: Some("api/src/users.ts".into()),
        locations: None,
        content: None,
        children: None,
        nested: None,
        thinking: None,
        subagent: None,
        input: None,
        started_at: None,
        ended_at: None,
        exit_code: None,
    }
}

fn page(rows: Vec<TranscriptRow>, from: u64, more: bool) -> AgentTranscript {
    serde_json::from_value(serde_json::json!({ "messages": rows, "from": from, "more": more }))
        .unwrap()
}

#[test]
fn a_head_takes_the_place_of_its_own_run_and_patches_count_from_it() {
    let mut conversation = Conversation::default();
    conversation.reset(page(
        vec![
            row(Role::User, "old", Some("r1")),
            row(Role::User, "go", Some("r2")),
            row(Role::Assistant, "Wor", Some("r2")),
        ],
        40,
        true,
    ));
    let changes = conversation.attached(
        "r2".into(),
        vec![
            row(Role::User, "go", Some("r2")),
            row(Role::Assistant, "Working", Some("r2")),
        ],
    );
    assert_eq!(changes, [Change::Changed { at: 1, count: 2 }]);
    // Index 1 of the run is row 2 of the conversation.
    let change = conversation.apply(TranscriptPatch::Text {
        index: 1,
        text: " on it".into(),
    });
    assert_eq!(change, [Change::Changed { at: 2, count: 1 }]);
    assert_eq!(conversation.rows[2].text, "Working on it");
    // A page of older rows in front shifts the run, and later patches still land on the right row.
    let change = conversation.older(page(vec![row(Role::User, "older", None)], 39, false));
    assert_eq!(change, Change::Inserted { at: 0, count: 1 });
    conversation.apply(TranscriptPatch::Text {
        index: 1,
        text: ".".into(),
    });
    assert_eq!(conversation.rows[3].text, "Working on it.");
    assert_eq!(conversation.from(), 39);
    assert!(!conversation.more());
}

#[test]
fn a_tool_patch_updates_in_place_keeps_children_and_nests_a_delegations_calls() {
    let mut conversation = Conversation::default();
    conversation.attached("r".into(), vec![row(Role::Assistant, "", Some("r"))]);
    conversation.apply(TranscriptPatch::Tool {
        index: 0,
        tool: Box::new(tool("t1", ToolStatus::InProgress)),
        parent: None,
    });
    conversation.apply(TranscriptPatch::Tool {
        index: 0,
        tool: Box::new(tool("t2", ToolStatus::InProgress)),
        parent: Some("t1".into()),
    });
    conversation.apply(TranscriptPatch::ToolThinking {
        index: 0,
        id: "t2".into(),
        text: "hmm".into(),
    });
    conversation.apply(TranscriptPatch::Tool {
        index: 0,
        tool: Box::new(tool("t1", ToolStatus::Completed)),
        parent: None,
    });
    let tools = conversation.rows[0].tools.as_ref().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].status, ToolStatus::Completed);
    let children = tools[0].children.as_ref().unwrap();
    assert_eq!(children[0].id, "t2");
    assert_eq!(children[0].thinking.as_deref(), Some("hmm"));
}

#[test]
fn renders_once_per_change() {
    let mut conversation = Conversation::default();
    conversation.attached("r".into(), vec![row(Role::Assistant, "**a**", Some("r"))]);
    let first = conversation.rendered(0).unwrap();
    assert!(Arc::ptr_eq(&first, &conversation.rendered(0).unwrap()));
    conversation.apply(TranscriptPatch::Text {
        index: 0,
        text: "b".into(),
    });
    assert_eq!(conversation.rendered(0).unwrap().1.text, "ab");
    assert_eq!(
        conversation.apply(TranscriptPatch::Drop { index: 0 }),
        [Change::Removed { at: 0, count: 1 }]
    );
    assert!(conversation.rendered(0).is_none());
}

#[test]
fn a_sent_row_shows_at_once_and_gives_way_to_the_daemons_copy() {
    let mut conversation = Conversation::default();
    let mut mine = row(Role::User, "hi", None);
    mine.message_id = Some("m1".into());
    assert_eq!(
        conversation.sent(mine.clone()),
        Change::Inserted { at: 0, count: 1 }
    );
    let mut theirs = mine;
    theirs.run = Some("r".into());
    let changes = conversation.attached("r".into(), vec![theirs]);
    assert_eq!(
        changes,
        [
            Change::Removed { at: 0, count: 1 },
            Change::Inserted { at: 0, count: 1 }
        ]
    );
    assert_eq!(conversation.len(), 1);
    assert_eq!(conversation.rows[0].run.as_deref(), Some("r"));
}

#[test]
fn a_row_read_outside_the_lock_is_kept_only_while_its_row_is_unchanged() {
    let rows = std::sync::Mutex::new(Conversation::default());
    rows.lock()
        .unwrap()
        .attached("r".into(), vec![row(Role::Assistant, "a", Some("r"))]);
    let first = read(&rows, 0).unwrap();
    assert!(
        Arc::ptr_eq(&first, &read(&rows, 0).unwrap()),
        "kept after the first read"
    );
    rows.lock().unwrap().apply(TranscriptPatch::Text {
        index: 0,
        text: "b".into(),
    });
    assert_eq!(read(&rows, 0).unwrap().1.text, "ab");
    assert!(read(&rows, 1).is_none());
}

#[test]
fn keeps_only_the_rows_read_last_drawn() {
    let mut conversation = Conversation::default();
    let rows: Vec<_> = (0..KEPT + 40)
        .map(|index| row(Role::Assistant, &format!("row {index}"), Some("r")))
        .collect();
    conversation.attached("r".into(), rows);
    for index in 0..KEPT + 40 {
        conversation.rendered(index);
    }
    let drawn = conversation
        .rendered
        .iter()
        .filter(|slot| slot.drawn.is_some())
        .count();
    assert_eq!(drawn, KEPT);
    assert!(
        conversation.rendered[0].drawn.is_none(),
        "the first read went first"
    );
    assert!(conversation.rendered[KEPT + 39].drawn.is_some());
}
