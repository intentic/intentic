//! Reading a conversation: `POST /agent/attach` streams its newest run (`AttachFrameSchema`), and
//! `GET /agents/{id}/transcript` pages back through the record before it (`AgentTranscriptSchema`).
//!
//! The stream opens on a head holding the run's rows so far, then sends patches and facts as they land, then `end`. A
//! stream that closes without `end` was dropped mid-run: attach again rather than assume the turn finished. Facts are
//! replayed on every attach, so a late joiner learns the turn's standing; patches never are, so the head's rows plus
//! the patches after it are the whole run.

use super::endpoint::{Endpoint, query};
use super::lenient::{Millis, Secs, Seq};
use super::transcript::{Tool, TranscriptRow};
use serde::{Deserialize, Serialize};

/// [`AttachTurn`] in, a stream of [`AttachFrame`] out.
pub const ATTACH: Endpoint = Endpoint::post("/agent/attach");
/// One page of a conversation's record, `{id}`, with [`transcript_query`]: [`AgentTranscript`].
pub const TRANSCRIPT: Endpoint = Endpoint::get("/agents/{id}/transcript");
/// A delegation's own calls, `{id}` and `{toolId}`, for a card a page left `nested`: [`ToolChildren`].
pub const TOOL_CHILDREN: Endpoint = Endpoint::get("/agents/{id}/transcript/tools/{toolId}");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachTurn {
    pub conversation_id: String,
    /// The run already shown. The stream opens on the newest run whatever this names; a head naming another run means
    /// a newer turn started since.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AttachFrame {
    /// The head: the run joined and its rows so far. Draw these, then apply the patches that follow.
    #[serde(rename_all = "camelCase")]
    Attached {
        run: String,
        started_at: Millis,
        /// How many frames the run has produced: a fact at or below it is a replay.
        seq: Seq,
        rows: Vec<TranscriptRow>,
    },
    Patch {
        seq: Seq,
        patch: TranscriptPatch,
    },
    /// Boxed for the same reason as a patch's row: a failure's fact is several times the size of the others.
    Fact {
        seq: Seq,
        fact: Box<TurnFact>,
    },
    /// The run is over and every frame has been delivered.
    End,
    #[serde(untagged)]
    Other(serde_json::Value),
}

/// One change to a run's rows, so a client keeps rows rather than frames (`TranscriptPatchSchema`). Indices count the
/// run's rows from the head's first. Rows and tools are boxed: most patches are a few words of text, and every one
/// would otherwise be the size of a whole row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum TranscriptPatch {
    /// A new row at the end.
    Append { row: Box<TranscriptRow> },
    /// This row, whole, in place of the one at `index`.
    Replace { index: u64, row: Box<TranscriptRow> },
    /// The row at `index` opened and was never written into.
    Drop { index: u64 },
    /// More prose onto that row's `text`.
    Text { index: u64, text: String },
    /// More reasoning onto that row's `thinking`.
    Thinking { index: u64, text: String },
    /// More of a delegated subagent's reasoning, onto the `thinking` of the card `id`, wherever it nests.
    ToolThinking {
        index: u64,
        id: String,
        text: String,
    },
    /// A tool card's own fields, new or the latest state of one already there, matched by id wherever it nests. It
    /// carries no `children` or `thinking`: a card already there keeps its own. `parent` names the card a delegated
    /// subagent's own call nests under.
    Tool {
        index: u64,
        tool: Box<Tool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
    },
    #[serde(untagged)]
    Other(serde_json::Value),
}

/// Something about the turn that is not a row (`TurnFactSchema`). Typed are the ones the conversation screen shows;
/// the terminal, browser and command lists, rate-limit and account readings, page drafts and fast mode arrive as
/// [`TurnFact::Other`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnFact {
    /// The provider session the turn runs in.
    #[serde(rename_all = "camelCase")]
    Session {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
    },
    /// The branch its private copy works on, and the commit it started from.
    Worktree {
        branch: String,
        base: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        remote: Option<String>,
    },
    /// What the turn has cost so far.
    #[serde(rename_all = "camelCase")]
    Usage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_tokens: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
    },
    /// How full the context window is: the gap is how close the conversation is to being compacted.
    #[serde(rename_all = "camelCase")]
    ContextUsage {
        tokens: f64,
        context_window: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cached_at: Option<Millis>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_ttl_ms: Option<f64>,
    },
    /// A status line the runtime set under `key`; null `text` clears it.
    AgentStatus {
        key: String,
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    /// The provider refused a request and the runtime is trying again.
    #[serde(rename_all = "camelCase")]
    ProviderRetry {
        attempt: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_attempts: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_attempt_at: Option<Millis>,
        /// The HTTP status it was refused with.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<f64>,
    },
    /// How tool calls are gated now: `default`, `plan`, `bypassPermissions`. The agent can move itself.
    Mode { mode: String },
    /// The turn failed. `code` sorts it (`rate_limit`, `provider-outage`, `sandbox-memory-low`, …); what the
    /// refused turn is held as, the outage's backoff, the retry ladder and the memory reading stay whole.
    #[serde(rename_all = "camelCase")]
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
        /// When a spent allowance reopens.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resets_at: Option<Secs>,
        /// When the sandbox sends the turn again by itself.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_at: Option<Secs>,
        /// `scheduled` or `available`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_resume: Option<String>,
        /// Nobody was at the composer when it was refused.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unattended: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        held: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outage: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retries: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        memory: Option<serde_json::Value>,
    },
    #[serde(untagged)]
    Other(serde_json::Value),
}

/// The query for [`TRANSCRIPT`]: `before` is the `from` of the page below (absent asks for the newest turns), `turns`
/// how many of the user's turns to return (1 to 200; absent takes the daemon's default).
pub fn transcript_query(before: Option<u64>, turns: Option<u32>) -> String {
    query(&[
        ("before", before.map(|position| position.to_string())),
        ("turns", turns.map(|count| count.to_string())),
    ])
}

/// One page of the record, oldest row first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscript {
    pub messages: Vec<TranscriptRow>,
    /// Where the first message sits in the whole record: the `before` that asks for the page above, and what every
    /// `rewind_index` on the page counts from.
    pub from: u64,
    /// Whether older messages precede this page.
    pub more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// How the last turn ended when one press finishes it (a stop, a spent allowance): what the composer offers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ending: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolChildren {
    pub children: Vec<Tool>,
}
