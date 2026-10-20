//! A conversation's rows (`TranscriptRowSchema`): one shape for the live row a run streams, the stored one a reopened
//! conversation pages back, and the ones the app keeps. Each block of the agent's prose is its own row, with the tool
//! calls that block made, so a turn redraws the way it unfolded. Typed is what the chat view draws; a need, a review's
//! findings, a page, and a notice's i18n facts stay `Value` until the app draws them natively.

use super::cards::{Card, CardKind};
use super::lenient::{Millis, open_enum};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRow {
    pub role: Role,
    /// The words, as markdown. A notice's English sentence, which `notice_code` lets a reader say in its own language.
    pub text: String,
    /// The run that produced it: how a client knows it already shows this run, since the last row keeps growing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    /// When a user row was sent; the agent's rows and notices carry `opened_at` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<Millis>,
    /// A sent message's own id, which an outbox resend reuses so the daemon recognises it rather than delivering twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// Uploaded files, as workspace paths (user rows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,
    /// The saved point this message can be rewound to, and its position in the record: looked up on each read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewind_index: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Tool>>,
    /// The agent's checklist as of this row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todos: Option<Vec<TodoItem>>,
    /// What the turn cost, on the row its answer ended in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    /// What the sandbox added to this message before the model saw it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<Vec<TurnNote>>,
    /// Who sent a message row, as the sandbox verified it; absent on older rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<Speaker>,
    /// What a message the sandbox composed is for (`land-conflict`, `ci-fix`); absent on a person's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errand: Option<String>,
    /// A person wrote this in the agent's voice, with no turn behind it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placed: Option<bool>,
    /// The one-press follow-up a notice offers; the app decides whether it still stands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice_action: Option<NoticeAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_held: Option<bool>,
    /// The wait a notice describes, and which one when several of its kind run at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice_wait: Option<NoticeWait>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice_wait_id: Option<String>,
    /// Which of the sandbox's own notices this is, with the facts it was worded from (`{ code, params }`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice_code: Option<serde_json::Value>,
    /// A notice the agent's runtime or an extension said, rather than the sandbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_notice: Option<AgentNotice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<Card>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<Card>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<Card>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_help: Option<Card>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_help: Option<Card>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_offer: Option<Card>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment_offer: Option<Card>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_offer: Option<Card>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_ask: Option<Card>,
    /// The prompts nobody typed: a condition watch firing, an answered need, another agent's words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_wake: Option<WatchWake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub need_wake: Option<NeedWake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_words: Option<AgentWords>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_job: Option<BackgroundJob>,
    /// Something the agent asked a person for, as raised; its live state is read by its id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub need: Option<serde_json::Value>,
    /// A page the agent showed (`show_page`), drawn inline: `{ id, title, path, height?, … }`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<serde_json::Value>,
    /// A code review's findings, drawn as one block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<serde_json::Value>,
}

impl TranscriptRow {
    /// The card this row holds, if any: at most one, and a card closes its row.
    pub fn card(&self) -> Option<(CardKind, &Card)> {
        [
            (CardKind::Plan, &self.plan),
            (CardKind::Question, &self.question),
            (CardKind::Permission, &self.permission),
            (CardKind::BrowserHelp, &self.browser_help),
            (CardKind::TerminalHelp, &self.terminal_help),
            (CardKind::CapabilityOffer, &self.capability_offer),
            (CardKind::PaymentOffer, &self.payment_offer),
            (CardKind::CredentialOffer, &self.credential_offer),
            (CardKind::PageAsk, &self.page_ask),
        ]
        .into_iter()
        .find_map(|(kind, card)| card.as_ref().map(|card| (kind, card)))
    }
}

open_enum! {
    /// A notice is neither side: something that happened to the turn (a refusal, a land, a stop).
    pub enum Role {
        User = "user",
        Assistant = "assistant",
        Notice = "notice",
    }
}

/// One tool call. A delegated subagent's own calls nest under the call that started it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub category: ToolKind,
    pub status: ToolStatus,
    /// What it acted on, in one line (a file, a command, an address): the card's summary line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locations: Option<Vec<ToolLocation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<ToolContent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Tool>>,
    /// How many calls sit under this one when a transcript page left `children` behind; fetch them when it opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nested: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<Subagent>,
    /// What the call was given, as JSON text cut to a few kilobytes, where no one-line target says it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
}

open_enum! {
    /// What a call does, named the same whatever the backend called the tool (ACP's ToolKind).
    pub enum ToolKind {
        Read = "read",
        Edit = "edit",
        Delete = "delete",
        Move = "move",
        Search = "search",
        Execute = "execute",
        Think = "think",
        Fetch = "fetch",
        /// ACP's `other`: a tool that fits none of the kinds above.
        Generic = "other",
    }
}

open_enum! {
    pub enum ToolStatus {
        Pending = "pending",
        InProgress = "in_progress",
        Completed = "completed",
        Failed = "failed",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolLocation {
    pub path: String,
    /// Counting from one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<f64>,
}

/// What a call produced (ACP's ToolCallContent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolContent {
    Text {
        text: String,
    },
    /// Hunk-level for an edit, the whole file for a write. `old_text` is absent for a new file.
    #[serde(rename_all = "camelCase")]
    Diff {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        old_text: Option<String>,
        new_text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        truncated: Option<bool>,
    },
    /// A workspace path, not bytes: the daemon serves it.
    Image {
        path: String,
    },
    #[serde(untagged)]
    Other(serde_json::Value),
}

/// The helper a call started, as the daemon's registry sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    /// Its own conversation id, for a spawned one; absent, the card's id is its id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// subagent (in-process), spawned, linked.
    pub kind: String,
    /// pending, running, blocked, completed, failed, killed, paused.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_uses: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
    /// How to say it while it is happening.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

open_enum! {
    pub enum TodoStatus {
        Pending = "pending",
        InProgress = "in_progress",
        Completed = "completed",
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_turns: Option<f64>,
}

/// A note the daemon put before a message: the reader sees `title`, the model was told `text`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnNote {
    pub title: String,
    pub text: String,
}

/// Who sent a message: a person, a program's control token, another conversation, or the sandbox itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Speaker {
    Person {
        email: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Program {
        token: String,
    },
    #[serde(rename_all = "camelCase")]
    Agent {
        conversation_id: String,
    },
    Sandbox {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    #[serde(untagged)]
    Other(serde_json::Value),
}

open_enum! {
    pub enum NoticeAction {
        LandHold = "landHold",
        DepsInstall = "depsInstall",
        WatchStop = "watchStop",
        SandboxMemory = "sandboxMemory",
        SendAnyway = "sendAnyway",
        SendAgain = "sendAgain",
        SwitchModel = "switchModel",
    }
}

open_enum! {
    pub enum NoticeWait {
        CredentialRenewal = "credentialRenewal",
        ChatRoute = "chatRoute",
        Watch = "watch",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentNotice {
    /// info, warning, error.
    pub level: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// `sent` on each of these is the whole prompt the model received, disclosed under the row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WatchWake {
    /// met, timeout, restart-expired, broken.
    pub outcome: String,
    pub note: String,
    /// Already worded (`43m`).
    pub elapsed: String,
    pub sent: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NeedWake {
    /// met, declined.
    pub outcome: String,
    pub title: String,
    pub id: String,
    pub sent: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentWords {
    /// peer (another conversation) or child (a subagent this one started).
    pub kind: String,
    pub from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<bool>,
    pub sent: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJob {
    pub id: String,
    pub label: String,
    pub command: String,
    pub started_at: Millis,
}
