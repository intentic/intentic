//! Acting in a conversation: sending a message, steering a running turn, answering a card, stopping a turn.
//!
//! A message carries the sender's own `message_id`. Sending again under an id the daemon already took is answered
//! with what became of it the first time (`duplicate`), never a second delivery, which is what lets an offline outbox
//! resend blindly.

use super::agents::AgentHarness;
use super::endpoint::Endpoint;
use super::lenient::True;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Starts a turn, or queues the message behind the running one: [`SendMessage`] in, [`MessageReceipt`] out.
pub const SEND: Endpoint = Endpoint::post("/agent");
/// Says something into the running turn between its tool calls: [`Steer`] in, [`MessageReceipt`] out. Answers 404
/// when nothing is running to steer; send it as a message then.
pub const STEER: Endpoint = Endpoint::post("/agent/steer");
/// Answers the card a turn is parked on: [`Reply`] in, [`Accepted`] out.
pub const REPLY: Endpoint = Endpoint::post("/agent/reply");
/// Cancels a running turn on the daemon: [`StopTurn`] in, [`StopResult`] out.
pub const STOP: Endpoint = Endpoint::post("/agent/stop");

/// The composer's message (`AgentRunSchema`, of which this is the part a phone sends). Every choice left out keeps
/// what the conversation already runs with.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessage {
    /// The words; may be empty when only attaching files.
    pub prompt: String,
    /// Which conversation. The sender chooses it: naming one that does not exist opens it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// The sender's id for this message, 1 to 128 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// Uploaded files, as workspace paths (at most 20).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,
    /// Paths the prompt `@`-mentions; one that names no file is ignored rather than refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<String>>,
    /// The model provider (`claude` when left out). The contract calls it `agent`.
    #[serde(default, rename = "agent", skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<AgentHarness>,
    /// Which connected account pays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Which persona the turn speaks as.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acts_as: Option<String>,
    /// `default` (ask before each tool), `plan` (propose a plan first) or `bypassPermissions`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// Work in the conversation's own copy of the repos rather than the shared tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolated: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Steer {
    pub conversation_id: String,
    /// What to say, up to 20,000 characters; may be empty when attaching files.
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<String>>,
}

/// What became of a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageReceipt {
    pub delivered: Delivered,
    /// The run it started or was said into: hand it to `attach::AttachTurn`. Absent while it waits in the queue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    /// The daemon had this id already: this is what became of it then, and nothing new happened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate: Option<True>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Delivered {
    Started,
    Steered,
    Queued,
}

/// An answer to a card, by its `request_id` (`AgentReplySchema`): no conversation id, since request ids are unique.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reply {
    /// Approving lets the plan run without a prompt per tool. `feedback` goes back to the model as the reason.
    #[serde(rename_all = "camelCase")]
    Plan {
        request_id: String,
        approve: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
    /// The chosen labels or the person's own words, keyed by each question's text; `cancelled` dismisses it so the
    /// agent carries on with sensible defaults.
    #[serde(rename_all = "camelCase")]
    Question {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answers: Option<BTreeMap<String, Vec<String>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attachments: Option<BTreeMap<String, Vec<String>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    Permission {
        request_id: String,
        decision: Decision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
        /// For a request to start a subagent: the whole run to start it on instead.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        child: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    BrowserHelp {
        request_id: String,
        helped: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TerminalHelp {
        request_id: String,
        helped: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// Yes keeps the agent waiting while the person sets it up; the reply itself connects nothing.
    #[serde(rename_all = "camelCase")]
    CapabilityOffer { request_id: String, connect: bool },
    /// Yes releases exactly one payment.
    #[serde(rename_all = "camelCase")]
    PaymentOffer { request_id: String, approve: bool },
    /// What the page sent back, as JSON text.
    #[serde(rename_all = "camelCase")]
    PageAsk {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
    },
    /// Only the people the card names may answer, yes or no.
    #[serde(rename_all = "camelCase")]
    CredentialOffer { request_id: String, approve: bool },
}

/// `once` allows this call; `always` what the card's always-label names, for the conversation; `everything` this call
/// and every later one an allow-once could settle; `deny` blocks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Once,
    Always,
    Everything,
    Deny,
}

/// The daemon's acknowledgement, `{ ok: true }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Accepted {
    pub ok: True,
}

/// Which turn a stop means, so one arriving after that turn settled cannot cancel the next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StopTurn {
    /// The run, as sending or attaching named it.
    #[serde(rename_all = "camelCase")]
    Run {
        conversation_id: String,
        run: String,
    },
    /// A send not answered yet has only its message id: cancels the turn that message is in.
    #[serde(rename_all = "camelCase")]
    Message {
        conversation_id: String,
        message_id: String,
    },
    /// Whatever runs now: only for a turn nobody can name (a scheduled automation's).
    #[serde(rename_all = "camelCase")]
    Live { conversation_id: String, live: True },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StopResult {
    pub stopped: bool,
    /// The run live instead of the one named, left running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running: Option<String>,
}
