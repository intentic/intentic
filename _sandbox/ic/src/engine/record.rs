#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

use super::paths;
use super::Kind;

/// `%USERPROFILE%\.intentic\engine\engine.json` — written by `ic engine install`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineRecord {
    pub engine: String,
    pub host: String,
    #[serde(rename = "certPath")]
    pub cert_path: String,
    pub bin: String,
    pub version: String,
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
        std::fs::write(&path, text)
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
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn record_round_trips_json() {
        let record = EngineRecord {
            engine: "intentic".to_string(),
            host: "tcp://127.0.0.1:2378".to_string(),
            cert_path: r"C:\Users\me\.intentic\engine\tls".to_string(),
            bin: r"C:\Users\me\.intentic\engine\bin".to_string(),
            version: "1.0.0".to_string(),
        };
        let json = serde_json::to_string(&record).unwrap();
        let back: EngineRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(record, back);
    }

    #[test]
    fn load_missing_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("engine.json");
        assert!(!Path::new(&path).exists());
        let _ = dir;
    }
}
