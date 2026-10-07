use std::path::Path;

use serde_json::{json, Map, Value};

use crate::docker;

/* WHAT THE HOST LAST DID ABOUT A SANDBOX'S VERSION, told to the sandbox. The daemon cannot see the host, and after a
swap that went wrong the owner is looking at whichever version ended up running: `/history/update-outcome.json` sits on
the volume both containers share, so that version reads what happened to the other one (the daemon returns it as
`/info` `lastUpdate`; its shape is `UpdateOutcomeSchema` in @intentic/sandbox-contract, schemas/updates.ts). */

pub const FILE: &str = "/history/update-outcome.json";

/// What happened, in the contract's words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The new version passed its first health check and runs; the previous one is parked until `keep_until`.
    Updated,
    /// The probation ended and the new version stays.
    Kept,
    /// The new version never came up, and the parked container was put back at once.
    Restored,
    /// The new version came up and then failed its probation, and the host went back by itself.
    RolledBack,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Updated => "updated",
            Kind::Kept => "kept",
            Kind::Restored => "restored",
            Kind::RolledBack => "rolled-back",
        }
    }
}

pub struct Outcome<'a> {
    pub result: Kind,
    pub verb: &'a str,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub reason: Option<&'a str>,
    pub log: Option<&'a Path>,
    pub keep_until: Option<u64>,
}

/// The file's JSON. Pure, so its shape is asserted without a container.
pub fn json_of(outcome: &Outcome, at: u64) -> String {
    let mut fields = Map::new();
    fields.insert("result".into(), json!(outcome.result.as_str()));
    if !outcome.verb.is_empty() {
        fields.insert("verb".into(), json!(outcome.verb));
    }
    fields.insert("at".into(), json!(at));
    for (key, value) in [
        ("from", outcome.from),
        ("to", outcome.to),
        ("reason", outcome.reason),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            fields.insert(key.into(), json!(value));
        }
    }
    if let Some(log) = outcome.log {
        fields.insert("log".into(), json!(log.display().to_string()));
    }
    if let Some(until) = outcome.keep_until {
        fields.insert("keepUntil".into(), json!(until));
    }
    Value::Object(fields).to_string()
}

/// Leave the outcome where the sandbox reads it. Best-effort by construction: the swap and its undoing are the real
/// outcome, and a container that is stopped, wedged or too old to hold the file must not turn either into a failure.
/// A running container gets it through a rename, so its daemon never reads half a file; a stopped one through `docker
/// cp`, since nothing reads it until it starts.
pub fn write(container: &str, outcome: &Outcome) {
    let body = json_of(outcome, crate::sandbox::now_ms());
    let running = docker::inspect(container, "{{.State.Running}}").as_deref() == Some("true");
    if running {
        let script = format!("cat > {FILE}.tmp && mv {FILE}.tmp {FILE}");
        docker::exec_stdin_ok(container, &["sh", "-c", &script], body.as_bytes());
        return;
    }
    let Ok(dir) = tempfile::tempdir() else { return };
    let staged = dir.path().join("update-outcome.json");
    if std::fs::write(&staged, &body).is_ok() {
        docker::quiet(&[
            "cp",
            &staged.to_string_lossy(),
            &format!("{container}:{FILE}"),
        ]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_update_that_took_says_until_when_the_way_back_is_parked() {
        let outcome = Outcome {
            result: Kind::Updated,
            verb: "update",
            from: Some("1.315.0"),
            to: Some("1.316.0"),
            reason: None,
            log: None,
            keep_until: Some(1_790_000_000_000),
        };
        let parsed: Value = serde_json::from_str(&json_of(&outcome, 7)).expect("JSON");
        assert_eq!(
            parsed,
            json!({"result": "updated", "verb": "update", "at": 7, "from": "1.315.0", "to": "1.316.0", "keepUntil": 1_790_000_000_000u64})
        );
    }

    #[test]
    fn a_rollback_says_why_and_where_the_log_is_and_leaves_out_what_it_does_not_know() {
        let log = std::path::PathBuf::from("/home/me/.intentic/logs/recreate-watch-1.log");
        let outcome = Outcome {
            result: Kind::RolledBack,
            verb: "watch",
            from: None,
            to: Some("1.316.0"),
            reason: Some("the daemon kept restarting"),
            log: Some(&log),
            keep_until: None,
        };
        let parsed: Value = serde_json::from_str(&json_of(&outcome, 9)).expect("JSON");
        assert_eq!(parsed["result"], "rolled-back");
        assert_eq!(parsed["reason"], "the daemon kept restarting");
        assert_eq!(
            parsed["log"],
            "/home/me/.intentic/logs/recreate-watch-1.log"
        );
        assert!(parsed.get("from").is_none() && parsed.get("keepUntil").is_none());
    }
}
