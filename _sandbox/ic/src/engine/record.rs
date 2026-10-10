#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

use super::paths;
use super::Kind;

/// `%USERPROFILE%\.intentic\engine\engine.json` — written by `ic engine install`.
///
/// It says two things, kept apart since 2026-10-09: how to reach our engine (`host`, `certPath`, `bin`, `distro`), and
/// whether this account's sandboxes RUN on it (`active`). Every `docker` that ic, the desktop app and the machine agent
/// spawn goes to our engine only while it is active; an installed engine that is not active is one a Docker Desktop PC
/// holds ready for `ic engine move`, and nothing else talks to it. A record written before the field existed came
/// from a PC whose sandboxes run on it, so a missing `active` reads as true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineRecord {
    pub engine: String,
    pub host: String,
    #[serde(rename = "certPath")]
    pub cert_path: String,
    pub bin: String,
    pub version: String,
    #[serde(default = "yes")]
    pub active: bool,
    /// The WSL distro the engine runs in. Missing on records from before the name could be chosen: the default one.
    #[serde(default = "default_distro")]
    pub distro: String,
    /// The named pipe `ic engine relay` serves the engine on (`npipe:////./pipe/<distro>.<user>`, engine/relay.rs), which
    /// every client uses while it is there and the TLS `host` otherwise. Missing until a start has run the relay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipe: Option<String>,
}

fn yes() -> bool {
    true
}

fn default_distro() -> String {
    super::DISTRO.to_string()
}

impl EngineRecord {
    pub fn load() -> Option<EngineRecord> {
        let path = paths::record_path()?;
        let text = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = paths::record_path().ok_or("could not find this account's home folder.")?;
        if let Some(parent) = path.parent() {
            paths::ensure_dir(parent)?;
        }
        let text = serde_json::to_string(self)
            .map_err(|error| format!("could not write the engine record: {error}"))?;
        // Written whole beside it and renamed over it: a reader (the desktop app reads it before every `docker` it
        // spawns) never sees half a record, which it would read as "no engine" and send a command to Docker Desktop.
        let staged = path.with_extension("json.new");
        std::fs::write(&staged, text)
            .map_err(|error| format!("could not write {}: {error}", staged.display()))?;
        std::fs::rename(&staged, &path)
            .map_err(|error| format!("could not write {}: {error}", path.display()))
    }

    pub fn remove_file() -> Result<(), String> {
        if let Some(path) = paths::record_path() {
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|error| format!("could not remove {}: {error}", path.display()))?;
            }
        }
        Ok(())
    }

    pub fn is_ours(&self) -> bool {
        self.engine == Kind::Intentic.id()
    }

    /// Ours, and the engine this account's sandboxes run on.
    pub fn is_active(&self) -> bool {
        self.is_ours() && self.active
    }
}

/// `%USERPROFILE%\.intentic\engine\held`: the engine was stopped on purpose (`ic engine stop`, `hold`, a move), so
/// whatever keeps it running leaves it down until `ic engine start`. Its text says who held it, for a person reading.
pub fn held() -> bool {
    paths::held_path().is_some_and(|path| path.exists())
}

pub fn hold_as(reason: &str) -> Result<(), String> {
    let path = paths::held_path().ok_or("could not find this account's home folder.")?;
    if let Some(parent) = path.parent() {
        paths::ensure_dir(parent)?;
    }
    std::fs::write(&path, reason).map_err(|error| format!("{}: {error}", path.display()))
}

pub fn release() {
    if let Some(path) = paths::held_path() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_round_trips_json() {
        let record = EngineRecord {
            engine: "intentic".to_string(),
            host: "tcp://127.0.0.1:2378".to_string(),
            cert_path: r"C:\Users\me\.intentic\engine\tls".to_string(),
            bin: r"C:\Users\me\.intentic\engine\bin".to_string(),
            version: "1.0.0".to_string(),
            active: false,
            distro: "intentic-engine".to_string(),
            pipe: Some("npipe:////./pipe/intentic-engine.me".to_string()),
        };
        let json = serde_json::to_string(&record).unwrap();
        let back: EngineRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(record, back);
        assert!(!back.is_active());
    }

    #[test]
    fn a_record_from_before_the_switch_is_active_on_the_default_distro() {
        let old = r#"{"engine":"intentic","host":"tcp://127.0.0.1:2378","certPath":"C:\\t","bin":"C:\\b","version":"1.0.0"}"#;
        let record: EngineRecord = serde_json::from_str(old).unwrap();
        assert!(record.active);
        assert!(record.is_active());
        assert_eq!(record.distro, "intentic-engine");
        // No relay has run yet: clients reach the TLS endpoint, and the record says no pipe when written back.
        assert_eq!(record.pipe, None);
        assert!(serde_json::to_value(&record).unwrap().get("pipe").is_none());
    }

    #[test]
    fn the_desktop_app_reads_the_same_switch() {
        // _editor/desktop-app/src-tauri/src/scripts.rs `parse_engine_record` reads these names: renaming one here
        // without it would send the app's every `docker` to the wrong engine.
        let json = serde_json::to_value(EngineRecord {
            engine: "intentic".into(),
            host: "h".into(),
            cert_path: "c".into(),
            bin: "b".into(),
            version: "v".into(),
            active: true,
            distro: "d".into(),
            pipe: Some("p".into()),
        })
        .unwrap();
        for key in [
            "engine", "host", "certPath", "bin", "active", "distro", "pipe",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }
    }
}
