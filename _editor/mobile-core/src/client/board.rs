//! The board's cards from the daemon's agent roster: the web board's lanes and unread rule (`wire::lanes`), newest
//! activity first, archived agents left off.

use crate::bridge::{BoardCard, BoardLane};
use crate::wire::agents::AgentSummary;
use crate::wire::lanes::Lane;

pub(super) fn cards(agents: &[AgentSummary]) -> Vec<BoardCard> {
    let mut cards: Vec<BoardCard> = agents
        .iter()
        .filter(|agent| agent.archived_at.is_none())
        .map(card)
        .collect();
    cards.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at));
    cards
}

fn card(agent: &AgentSummary) -> BoardCard {
    let activity = agent.activity.as_ref().and_then(|activity| {
        activity.todo.clone().or_else(|| {
            let tool = activity.tool.as_deref()?;
            Some(match activity.target.as_deref() {
                Some(target) => format!("{tool} {target}"),
                None => tool.to_owned(),
            })
        })
    });
    BoardCard {
        id: agent.id.clone(),
        title: agent.title.clone(),
        lane: match agent.lane() {
            Lane::Attention => BoardLane::Attention,
            Lane::Active => BoardLane::Active,
            Lane::Finished => BoardLane::Finished,
        },
        status: agent.status.as_str().to_owned(),
        working: agent.turn_working(),
        unread: agent.unread(),
        model: agent.model.clone(),
        activity,
        failure: agent.failure.clone(),
        updated_at: agent.updated_at.0 as f64,
        parent: agent.parent().map(str::to_owned),
        checklist_done: agent.checklist.as_ref().map(|list| list.done as u32),
        checklist_total: agent.checklist.as_ref().map(|list| list.total as u32),
    }
}
