//! `GET /events`: the sandbox's one long-lived stream (`SystemEventSchema`), an oRPC event iterator over SSE. The app
//! reads the hello (which build answers, which routes it serves), the heartbeat (liveness, and the fleet revision that
//! proves no roster was dropped), boot progress, presence, and the fleet roster. The workspace and account frames the
//! web's file tree and settings live on arrive as [`SystemEvent::Other`].

use super::agents::AgentSummary;
use super::endpoint::{Endpoint, query};
use super::lenient::{Millis, Seq, open_enum};
use super::session::MemberRole;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const EVENTS: Endpoint = Endpoint::get("/events");

/// The query for [`EVENTS`]. A `client_id` puts this connection on the presence roster under that id, minted afresh
/// for each attempt; none watches without being seen.
pub fn events_query(client_id: Option<&str>) -> String {
    query(&[("clientId", client_id.map(str::to_owned))])
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SystemEvent {
    /// Boxed: it is one frame per connection, and the rest of the stream should not pay its size.
    Hello(Box<Hello>),
    /// Sent every few seconds. `rev` is the fleet revision as of an empty send queue: one newer than the last roster
    /// applied means a roster was dropped, and `GET /agents` fetches it.
    Heartbeat {
        rev: Seq,
    },
    Boot(BootProgress),
    Presence {
        users: Vec<PresenceUser>,
    },
    /// The whole fleet, sent on every change. Apply it only when `rev` is newer than the last applied: `GET /agents`
    /// and this stream can deliver out of order.
    Agents {
        agents: Vec<AgentSummary>,
        rev: Seq,
    },
    /// Every frame this build does not read, and a known one whose shape it cannot (a daemon bug, since the contract's
    /// frames only grow).
    #[serde(untagged)]
    Other(serde_json::Value),
}

/// The stream's first frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// Keys every cache of this sandbox's data, so a wiped workspace never hydrates stale rows.
    pub workspace_id: String,
    /// `<version>:<mtime>`; the version at its head is what a client holds against the oldest daemon it supports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    /// The procedures it serves, by contract name (`agents.list`): one missing is a feature this daemon predates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routes: Option<Vec<String>>,
    /// Each procedure's shape fingerprint, by the same names: one that differs from the app's is a route whose shape
    /// moved, read as "update the sandbox" rather than as a broken answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shapes: Option<BTreeMap<String, String>>,
    /// The same two for the hand-written routes (`POST /agent/attach` is one), keyed `METHOD /path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_routes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_fingerprints: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot: Option<BootProgress>,
    /// A project sandbox's folder, workspace-relative; absent on every other sandbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    /// A sandbox's daemon, or the desktop app's folder sidecar. Absent reads as a sandbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<Surface>,
}

impl Hello {
    /// The daemon's version, the head of `build`, or none for a build whose head is not a version (semver-ish, as
    /// sandbox-contract's `parseVersion` reads it: a `v` tolerated, then a number).
    pub fn daemon_version(&self) -> Option<&str> {
        let head = self.build.as_deref()?.split(':').next()?.trim();
        let digits = head.strip_prefix('v').unwrap_or(head);
        digits
            .starts_with(|first: char| first.is_ascii_digit())
            .then_some(head)
    }
}

open_enum! {
    pub enum Surface {
        Sandbox = "sandbox",
        Folder = "folder",
    }
}

/// Where the daemon stands in its boot. Its listeners come up before its state converges, so it can answer the stream
/// while every other read waits on `ready`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootProgress {
    pub ready: bool,
    pub started_at: Millis,
    /// The whole chain, pending steps included, so a slow one can be named.
    pub steps: Vec<BootStep>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BootStep {
    pub key: String,
    pub label: String,
    pub state: BootStepState,
    /// Elapsed milliseconds, once finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<f64>,
}

open_enum! {
    pub enum BootStepState {
        Pending = "pending",
        Running = "running",
        Done = "done",
        /// Counts as finished: the chain logs a failed step and carries on.
        Failed = "failed",
    }
}

/// One connected tab or app of a member. An entry lives exactly as long as its `/events` connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUser {
    pub client_id: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    pub role: MemberRole,
    pub idle: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    /// The conversation it has open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_off_the_build() {
        let hello = |build: &str| Hello {
            workspace_id: "w".into(),
            build: Some(build.into()),
            routes: None,
            shapes: None,
            raw_routes: None,
            raw_fingerprints: None,
            boot: None,
            project_dir: None,
            surface: None,
        };
        assert_eq!(
            hello("1.312.4:1729000000").daemon_version(),
            Some("1.312.4")
        );
        assert_eq!(hello("dev:1729000000").daemon_version(), None);
    }
}
