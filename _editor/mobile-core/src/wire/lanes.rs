//! Which board lane a card is filed in, and what of a fleet calls the person: a port of sandbox-contract's
//! `models/agent-lanes.ts` and `models/agent-standing.ts`, which the web board and the daemon's attention count both
//! read, so a phone that filed a card differently would disagree with every other surface. The web's client-only
//! statuses (a draft, a send not yet answered) never reach the wire and are left out.

use super::agents::{AgentStatus, AgentSummary, QueuePause};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane {
    Attention,
    Active,
    Finished,
}

impl AgentSummary {
    pub fn lane(&self) -> Lane {
        if self.blocked() || matches!(self.status, AgentStatus::Awaiting | AgentStatus::Conflict) {
            return Lane::Attention;
        }
        // Settled from the press: a waved-away question and a land end in the lane they were pressed in.
        if matches!(self.status, AgentStatus::Dismissing | AgentStatus::Landing) {
            return Lane::Finished;
        }
        // Each of these restarts by itself later, so filing it Finished would announce as over work that resumes.
        if self.turn_in_flight()
            || self.awaiting_wake == Some(true)
            || self.limit_scheduled()
            || self.scheduled_send()
        {
            return Lane::Active;
        }
        Lane::Finished
    }

    /// Activity since it was last opened, while no turn is running (a running one is news already).
    pub fn unread(&self) -> bool {
        !self.turn_in_flight() && self.updated_at > self.seen_at.unwrap_or_default()
    }

    /// The conversation that spawned this one, when one did.
    pub fn parent(&self) -> Option<&str> {
        self.started_by.as_deref()?.strip_prefix("agent:")
    }

    pub fn turn_in_flight(&self) -> bool {
        matches!(
            self.status,
            AgentStatus::Running
                | AgentStatus::Stopping
                | AgentStatus::Dismissing
                | AgentStatus::Resuming
                | AgentStatus::Landing
        )
    }

    /// Producing something right now: in flight, and neither merging nor being ended by a press.
    pub fn turn_working(&self) -> bool {
        self.turn_in_flight()
            && !matches!(
                self.status,
                AgentStatus::Landing | AgentStatus::Stopping | AgentStatus::Dismissing
            )
    }

    fn limited(&self) -> bool {
        self.status == AgentStatus::Error && self.failure_code.as_deref() == Some("rate_limit")
    }

    fn limit_scheduled(&self) -> bool {
        self.limited() && self.limit_scheduled == Some(true)
    }

    /// Messages booked to go by themselves: a scheduled pause, or any item with a time or a conversation to wait for.
    fn scheduled_send(&self) -> bool {
        let Some(queue) = &self.queue else {
            return false;
        };
        queue.paused == Some(QueuePause::Scheduled)
            || queue
                .items
                .iter()
                .any(|item| item.until.is_some() || item.after.is_some())
    }

    fn land_broken(&self) -> bool {
        self.land_failure.is_some() && !self.turn_in_flight()
    }

    /// Every armed watch is held by a job sitting at a prompt: nothing will wake it but a person.
    fn held_by_prompt(&self) -> bool {
        let watches = self.watches.as_deref().unwrap_or_default();
        if watches.is_empty() || self.turn_in_flight() {
            return false;
        }
        let prompts: HashSet<&str> = (self.jobs.as_deref().unwrap_or_default().iter())
            .filter(|job| job.ended_at.is_none() && job.input_wait.is_some())
            .filter_map(|job| job.watch.as_deref())
            .collect();
        watches
            .iter()
            .all(|watch| prompts.contains(watch.id.as_str()))
    }

    fn blocking_ending(&self) -> bool {
        matches!(
            self.status,
            AgentStatus::Error
                | AgentStatus::Interrupted
                | AgentStatus::Stopping
                | AgentStatus::Stopped
        )
    }

    /// An ending already answered by a booking: something goes by itself after it, so it no longer calls the reader.
    fn booking_answers(&self) -> bool {
        matches!(
            self.status,
            AgentStatus::Error | AgentStatus::Interrupted | AgentStatus::Stopped
        ) && self.scheduled_send()
    }

    fn blocked(&self) -> bool {
        if self.limit_scheduled() {
            return false;
        }
        let ask = &self.attention;
        ask.plan
            || ask.question
            || ask.permission
            || ask.capability
            || ask.conflict
            || (ask.need == Some(true) && self.status != AgentStatus::Running)
            || self.land_broken()
            || self.held_by_prompt()
            || (self.blocking_ending() && !self.booking_answers())
    }

    fn conflict_is_yours(&self) -> bool {
        let causes = self.conflict_causes.as_deref().unwrap_or_default();
        !causes.is_empty() && causes.iter().all(|cause| cause == "workspace")
    }

    fn only_owner_can_answer(&self) -> bool {
        let ask = &self.attention;
        ask.plan
            || ask.permission
            || ask.capability
            || ask.credential
            || ask.need == Some(true)
            || (self.status == AgentStatus::Awaiting && !ask.question)
            || ((ask.conflict || self.status == AgentStatus::Conflict) && self.conflict_is_yours())
    }

    /// A child's stop its parent has moved past since: the family's history, no longer the reader's to answer.
    fn heard_by_parent(&self, parent_at: i64) -> bool {
        self.blocking_ending()
            && self.status != AgentStatus::Stopping
            && !self.limit_scheduled()
            && !self.booking_answers()
            && !self.attention.question
            && !self.attention.conflict
            && !self.land_broken()
            && self.updated_at.0 < parent_at
    }

    /// Whether what a child stopped on is the reader's to answer rather than its parent's.
    fn calls_owner(&self, child: Lane, parent: Lane, parent_at: i64) -> bool {
        self.only_owner_can_answer()
            || (child == Lane::Attention
                && parent != Lane::Active
                && !self.heard_by_parent(parent_at))
    }
}

/// How many cards the Attention lane draws: a child rides under its eldest ancestor's one card and lifts it to
/// Attention only when it calls the reader, and a family counts once. `unsent` names the conversations whose composer
/// holds words, which keep a card of their own (the web knows that; the wire's `unsentAt` says it for other devices).
pub fn attention_cards(agents: &[AgentSummary], unsent: &dyn Fn(&AgentSummary) -> bool) -> usize {
    let by_id: HashMap<&str, &AgentSummary> = agents
        .iter()
        .map(|agent| (agent.id.as_str(), agent))
        .collect();
    let parent_in = |agent: &AgentSummary| agent.parent().and_then(|id| by_id.get(id).copied());
    let family_of = |agent: &AgentSummary| -> String {
        let mut seen = HashSet::from([agent.id.as_str()]);
        let mut top = agent;
        while let Some(above) = parent_in(top) {
            if !seen.insert(above.id.as_str()) {
                break;
            }
            top = above;
        }
        top.id.clone()
    };
    let mut cards = HashSet::new();
    for agent in agents {
        match parent_in(agent) {
            Some(parent) if !unsent(agent) => {
                if agent.calls_owner(agent.lane(), parent.lane(), parent.updated_at.0) {
                    cards.insert(family_of(agent));
                }
            }
            _ if agent.lane() == Lane::Attention => {
                cards.insert(agent.id.clone());
            }
            _ => {}
        }
    }
    cards.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::agents::{AgentAttention, AgentHarness, ConversationQueue, QueuedMessage};
    use crate::wire::lenient::Millis;

    fn agent(id: &str, status: AgentStatus) -> AgentSummary {
        serde_json::from_value(serde_json::json!({
            "id": id, "status": status.as_str(), "provider": "claude", "harness": AgentHarness::Native.as_str(),
            "updatedAt": 1000, "attention": AgentAttention::default(),
        }))
        .unwrap()
    }

    #[test]
    fn files_each_status_in_the_board_lane() {
        assert_eq!(agent("a", AgentStatus::Running).lane(), Lane::Active);
        assert_eq!(agent("a", AgentStatus::Awaiting).lane(), Lane::Attention);
        assert_eq!(agent("a", AgentStatus::Error).lane(), Lane::Attention);
        assert_eq!(agent("a", AgentStatus::Landing).lane(), Lane::Finished);
        assert_eq!(agent("a", AgentStatus::Landed).lane(), Lane::Finished);
        let mut asking = agent("a", AgentStatus::Running);
        asking.attention.permission = true;
        assert_eq!(asking.lane(), Lane::Attention);
    }

    #[test]
    fn a_booked_resend_answers_its_ending() {
        let mut limited = agent("a", AgentStatus::Error);
        limited.failure_code = Some("rate_limit".into());
        limited.limit_scheduled = Some(true);
        assert_eq!(limited.lane(), Lane::Active);
        let mut stopped = agent("b", AgentStatus::Stopped);
        stopped.queue = Some(ConversationQueue {
            items: vec![QueuedMessage {
                id: "m".into(),
                text: "later".into(),
                voice: "person".into(),
                queued_at: Millis(1),
                revision: 1,
                until: Some(Millis(5_000)),
                after: None,
            }],
            revision: 1,
            paused: None,
            until: None,
            after: None,
        });
        assert_eq!(stopped.lane(), Lane::Active);
    }

    #[test]
    fn unread_is_activity_since_it_was_opened() {
        let mut idle = agent("a", AgentStatus::Idle);
        assert!(idle.unread());
        idle.seen_at = Some(Millis(1000));
        assert!(!idle.unread());
        assert!(!agent("b", AgentStatus::Running).unread());
    }

    #[test]
    fn a_family_counts_once() {
        let parent = agent("p", AgentStatus::Error);
        let mut child = agent("c", AgentStatus::Awaiting);
        child.started_by = Some("agent:p".into());
        let mut grandchild = agent("g", AgentStatus::Running);
        grandchild.started_by = Some("agent:c".into());
        grandchild.attention.plan = true;
        assert_eq!(attention_cards(&[parent, child, grandchild], &|_| false), 1);
    }
}
