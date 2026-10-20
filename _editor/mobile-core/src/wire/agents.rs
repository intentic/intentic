//! The board: every conversation's card (`AgentSummarySchema`), as `GET /agents` lists them and the `/events` agents
//! frame republishes them. Typed are what a card draws and what `lanes.rs` files it by; the rest of the summary (the
//! land's drafting story, delivery, prompt-cache timing, reach, review tallies) is the web's, read by nothing here.

use super::endpoint::Endpoint;
use super::lenient::{Millis, Secs, Seq, open_enum};
use serde::{Deserialize, Serialize};

/// The live fleet, archived conversations left out: [`AgentsList`].
pub const AGENTS: Endpoint = Endpoint::get("/agents");
/// One conversation's card, `{id}`: [`AgentSummary`].
pub const AGENT: Endpoint = Endpoint::get("/agents/{id}");
/// Stamps the read marker behind one card's unread badge, `{id}`: answers the card. Reading never counts as activity.
pub const SEEN: Endpoint = Endpoint::post("/agents/{id}/seen");
/// Clears every unread badge: answers the refreshed [`AgentsList`].
pub const SEEN_ALL: Endpoint = Endpoint::post("/agents/seen");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentsList {
    pub agents: Vec<AgentSummary>,
    /// The fleet revision: drop any list older than the newest roster already applied.
    pub rev: Seq,
    /// Automation wakes waiting for a yes, drawn at the head of the Attention lane. Kept whole and unread for now.
    #[serde(default)]
    pub held: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    /// The first prompt cut to a line, unless renamed. Absent until a turn has named it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// One word for the kind of work (fix, audit), which tints a card; never part of its name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_action: Option<String>,
    pub status: AgentStatus,
    /// The sentence the last turn died on, and its error frame's code (`rate_limit`, `sandbox-memory-low`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_resets_at: Option<Secs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_held: Option<bool>,
    /// What carries it on with nobody pressing anything, and when; absent when only a press moves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<AgentNext>,
    /// The model provider, an open string (`claude`, `codex`, an extension's own).
    pub provider: String,
    pub harness: AgentHarness,
    /// The runner it runs on; absent means this sandbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Its worktree branch (`agent/<id>`); absent for one working in the shared tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Which persona its last turn acted as: who it speaks as now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_acts_as: Option<String>,
    /// Set when an outside message opened it (a chat mention, a webhook) rather than a person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<AgentOrigin>,
    /// Who asked for the first turn: an email, `token:<label>`, or `agent:<id>` for a child (see `lanes::parent_of`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by: Option<String>,
    /// The member answerable for it now; absent until somebody claims it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<SessionOwner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<f64>,
    /// The last tool it reached for and the item it is on, while a turn runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<AgentActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checklist: Option<Checklist>,
    /// When the running turn started; absent when none runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Millis>,
    /// The run under way, which a stop names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<ConversationQueue>,
    /// When it last did something. Reading it does not count.
    pub updated_at: Millis,
    /// When somebody last opened it; activity after this is what makes it unread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_at: Option<Millis>,
    /// Since when somebody's composer has held an unsent message for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsent_at: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<Millis>,
    pub attention: AgentAttention,
    /// The oldest permission its running turn waits on, answerable from the card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_ask: Option<PermissionAsk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub land_failure: Option<LandFailure>,
    /// Why its work will not merge: `workspace` (the reader's own uncommitted edits), `diverged`, `binary`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_causes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_uses: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagents: Option<SubagentCount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<DiffCount>,
    #[serde(default, rename = "loop", skip_serializing_if = "Option::is_none")]
    pub loop_: Option<AgentLoop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<WorkflowStep>,
    /// Outside conditions it is waiting on, each of which wakes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watches: Option<Vec<AgentWatch>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub awaiting_wake: Option<bool>,
    /// Commands it left running past their own call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jobs: Option<Vec<AgentJob>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs: Option<Vec<NeedSummary>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reactions: Option<Vec<Reaction>>,
}

open_enum! {
    /// `stopping`/`stopped` are the two halves of a Stop; `dismissing` the same for a waved-away question; `resuming`
    /// a turn the sandbox is already putting right; `landing` work being merged right now; `ready` clean work held on
    /// its branch because auto-land is off; `interrupted` a turn the daemon died under.
    pub enum AgentStatus {
        Idle = "idle",
        Running = "running",
        Awaiting = "awaiting",
        Stopping = "stopping",
        Dismissing = "dismissing",
        Stopped = "stopped",
        Resuming = "resuming",
        Landing = "landing",
        Ready = "ready",
        Landed = "landed",
        Conflict = "conflict",
        Error = "error",
        Interrupted = "interrupted",
    }
}

open_enum! {
    /// Which agentic loop runs it.
    pub enum AgentHarness {
        Native = "native",
        ClaudeCode = "claude-code",
        Codex = "codex",
        Opencode = "opencode",
        Pi = "pi",
        Muse = "muse",
        Vendor = "vendor",
    }
}

/// Which kinds of waiting-for-you it is doing.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AgentAttention {
    pub plan: bool,
    pub question: bool,
    pub permission: bool,
    pub capability: bool,
    /// Waiting on a named person to release a credential: the one pause the reader may not be able to clear.
    pub credential: bool,
    pub conflict: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub need: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrigin {
    pub automation_id: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionOwner {
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub since: Millis,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AgentActivity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Checklist {
    pub done: f64,
    /// Never zero: a conversation that kept no list carries no checklist at all.
    pub total: f64,
}

/// What carries a conversation on by itself (`AgentNextSchema`): the one reading its lane and its corner take.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentNext {
    /// A held turn goes again at `at`, or moves `onto` another account.
    Rerun {
        at: Millis,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        onto: Option<String>,
    },
    /// Held for memory: it goes once memory has stayed free a while.
    Room,
    /// Messages booked for a time: the soonest at `at`.
    Send { at: Millis, count: u32 },
    /// Messages booked for after another conversation's work lands.
    Land { after: String, count: u32 },
    /// A kind this build does not know: still something that carries it on.
    #[serde(other)]
    Other,
}

/// Messages waiting for its next turn, and whether they are held.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationQueue {
    pub items: Vec<QueuedMessage>,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<QueuePause>,
    /// For a `scheduled` pause: the instant the queue goes, or the conversation it waits to see landed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

open_enum! {
    pub enum QueuePause {
        Stopped = "stopped",
        Refused = "refused",
        Scheduled = "scheduled",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
    /// Who it is from: `person`, `sandbox` or `agent`.
    pub voice: String,
    pub queued_at: Millis,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionAsk {
    /// What a reply names (`act::Reply::Permission`).
    pub request_id: String,
    /// What it asks to do, on one line.
    pub ask: String,
    /// The program it holds, with highlight spans; drawn by the web, kept whole here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LandFailure {
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub at: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubagentCount {
    pub running: f64,
    pub total: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiffCount {
    pub files: f64,
    pub insertions: f64,
    pub deletions: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoop {
    /// running, done, exhausted, stalled, overspent, stopped, error, unpriced.
    pub state: String,
    pub iteration: u64,
    pub max_iterations: u64,
    pub goal: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    pub run_id: String,
    pub name: String,
    pub step: String,
    pub index: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWatch {
    pub id: String,
    pub note: String,
    pub interval_seconds: u64,
    pub deadline_at: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentJob {
    pub id: String,
    pub label: String,
    pub session: String,
    pub started_at: Millis,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    /// Sitting at a prompt for input since then: with an armed `watch`, the job holds the conversation's wait.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_wait: Option<JobInputWait>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobInputWait {
    pub since: Millis,
    pub program: String,
}

/// A need the conversation raised, as its card lists it; its live state is the needs store's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NeedSummary {
    pub id: String,
    /// capability, secret, grant, release, environment, automation.
    pub kind: String,
    pub title: String,
    /// open, working, met, declined, cancelled.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reaction {
    pub emoji: String,
    /// Everyone wearing it, oldest first; never empty.
    pub by: Vec<Reactor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reactor {
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub at: Millis,
}
