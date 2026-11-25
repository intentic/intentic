//! What remoted tells the machine agent: one JSON object per line, the whole picture every time any of it changes (and
//! once at the start), on stdout and on the control connection of the agent that adopted it ([`crate::control`]). The
//! agent waits on an uplink's `up` to answer the sandbox's start, shows the person at the computer who is connected, and
//! restarts remoted when it exits. Logs go to stderr, never here.

use std::collections::BTreeMap;
use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Notify;

use crate::token::now_ms;

// Changes landing together (an uplink coming up as three viewers rejoin) are said as one line.
const SETTLE: Duration = Duration::from_millis(50);

/// Where one uplink stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UplinkState {
    /// Dialling, or waiting to dial again.
    Connecting,
    Up,
    /// Dropped; dialling again after a backoff.
    Down,
    /// The sandbox closed it for good (its switches went off there): dialled again only once the agent starts it again.
    Withdrawn,
    /// The sandbox does not know its token (401) or its device (403); tried again on a long backoff.
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UplinkStatus {
    pub id: String,
    pub state: UplinkState,
    /// The configuration's `generation` this state is of: the agent waits for `up` at the generation it wrote.
    pub generation: u64,
    pub since: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What a connected person does, the most a viewer's access lets it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PersonKind {
    Terminal,
    View,
    Control,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub uplink: String,
    pub kind: PersonKind,
    pub session: String,
    pub read_only: bool,
    pub since: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub version: &'static str,
    pub pid: u32,
    pub uplinks: Vec<UplinkStatus>,
    pub people: Vec<Person>,
    pub terminals: usize,
    pub environments: Vec<String>,
    pub monitors: Vec<crate::media::Monitor>,
    pub paused: bool,
}

#[derive(Default)]
struct Held {
    uplinks: BTreeMap<String, UplinkStatus>,
    people: BTreeMap<u64, Person>,
    terminals: usize,
    environments: Vec<String>,
    paused: bool,
}

/// The status as it stands, and a wake for the line writer.
#[derive(Default)]
pub struct Status {
    held: Mutex<Held>,
    changed: Notify,
}

impl Status {
    fn change(&self, change: impl FnOnce(&mut Held) -> bool) {
        let changed = change(&mut self.held.lock().expect("status poisoned"));
        if changed {
            // Every reader: the stdout writer, an adopter's connection, the idle clock.
            self.changed.notify_waiters();
        }
    }

    pub fn uplink(&self, id: &str, state: UplinkState, generation: u64, error: Option<String>) {
        self.change(|held| {
            if let Some(now) = held.uplinks.get(id)
                && now.state == state
                && now.generation == generation
                && now.error == error
            {
                return false;
            }
            let since = held
                .uplinks
                .get(id)
                .filter(|now| now.state == state)
                .map_or_else(now_ms, |now| now.since);
            held.uplinks.insert(
                id.to_owned(),
                UplinkStatus {
                    id: id.to_owned(),
                    state,
                    generation,
                    since,
                    error,
                },
            );
            true
        });
    }

    pub fn forget_uplink(&self, id: &str) {
        self.change(|held| held.uplinks.remove(id).is_some());
    }

    pub fn uplink_state(&self, id: &str) -> Option<UplinkState> {
        self.held
            .lock()
            .expect("status poisoned")
            .uplinks
            .get(id)
            .map(|status| status.state)
    }

    pub fn person_joined(&self, viewer: u64, person: Person) {
        self.change(|held| {
            held.people.insert(viewer, person);
            true
        });
    }

    pub fn person_left(&self, viewer: u64) {
        self.change(|held| held.people.remove(&viewer).is_some());
    }

    pub fn terminals(&self, count: usize) {
        self.change(|held| {
            let changed = held.terminals != count;
            held.terminals = count;
            changed
        });
    }

    pub fn environments(&self, environments: Vec<String>) {
        self.change(|held| {
            let changed = held.environments != environments;
            held.environments = environments;
            changed
        });
    }

    pub fn paused(&self, paused: bool) {
        self.change(|held| {
            let changed = held.paused != paused;
            held.paused = paused;
            changed
        });
    }

    pub fn people(&self) -> Vec<Person> {
        self.held
            .lock()
            .expect("status poisoned")
            .people
            .values()
            .cloned()
            .collect()
    }

    pub fn line(&self) -> Line {
        let held = self.held.lock().expect("status poisoned");
        Line {
            kind: "status",
            version: crate::VERSION,
            pid: std::process::id(),
            uplinks: held.uplinks.values().cloned().collect(),
            people: held.people.values().cloned().collect(),
            terminals: held.terminals,
            environments: held.environments.clone(),
            monitors: crate::media::monitors(),
            paused: held.paused,
        }
    }

    /// Whether anything is open for a person: a terminal, or someone on a screen or a terminal.
    pub fn busy(&self) -> bool {
        let held = self.held.lock().expect("status poisoned");
        held.terminals > 0 || !held.people.is_empty()
    }

    /// Resolves at the next change (registered as it is called, before it is polled).
    pub fn changed(&self) -> tokio::sync::futures::Notified<'_> {
        self.changed.notified()
    }

    /// Hands `send` a line now, then one after every change, until it answers false.
    pub async fn each_line(&self, mut send: impl FnMut(String) -> bool) {
        loop {
            let changed = self.changed.notified();
            let line = serde_json::to_string(&self.line()).expect("a status line serializes");
            if !send(line) {
                return;
            }
            changed.await;
            tokio::time::sleep(SETTLE).await;
        }
    }

    /// Writes a line now, then one after every change, until the process ends.
    pub async fn write_lines(&self, mut out: impl Write) {
        // Nobody reads it any more: the agent is gone, and stdin's end (or the control connection's) will say so.
        self.each_line(|line| writeln!(out, "{line}").and_then(|()| out.flush()).is_ok())
            .await;
    }

    /// One more line, for the moment before the process ends.
    pub fn write_last(&self, mut out: impl Write) {
        let line = serde_json::to_string(&self.line()).expect("a status line serializes");
        let _ = writeln!(out, "{line}").and_then(|()| out.flush());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_says_every_uplink_and_person_in_the_agents_shape() {
        let status = Status::default();
        status.uplink("link-a", UplinkState::Up, 3, None);
        status.uplink("link-b", UplinkState::Refused, 1, Some("401".into()));
        status.person_joined(
            7,
            Person {
                uplink: "link-a".into(),
                kind: PersonKind::Terminal,
                session: "t-1".into(),
                read_only: true,
                since: 1,
            },
        );
        status.terminals(2);
        let json: serde_json::Value = serde_json::to_value(status.line()).unwrap();
        assert_eq!(json["type"], "status");
        assert_eq!(json["uplinks"][0]["id"], "link-a");
        assert_eq!(json["uplinks"][0]["state"], "up");
        assert_eq!(json["uplinks"][0]["generation"], 3);
        assert_eq!(json["uplinks"][1]["state"], "refused");
        assert_eq!(json["uplinks"][1]["error"], "401");
        assert_eq!(
            json["people"][0],
            serde_json::json!({"uplink": "link-a", "kind": "terminal", "session": "t-1", "readOnly": true, "since": 1})
        );
        assert_eq!(json["terminals"], 2);
        // Whatever screens this computer has (a virtual desktop wherever Xvfb is installed): a list either way.
        assert!(json["monitors"].is_array());
    }

    #[test]
    fn an_uplink_keeps_its_since_while_its_state_holds() {
        let status = Status::default();
        status.uplink("a", UplinkState::Down, 1, Some("one".into()));
        let first = status.line().uplinks[0].since;
        std::thread::sleep(std::time::Duration::from_millis(5));
        status.uplink("a", UplinkState::Down, 1, Some("two".into()));
        assert_eq!(status.line().uplinks[0].since, first);
        assert_eq!(status.line().uplinks[0].error.as_deref(), Some("two"));
    }
}
