//! What remoted serves, as the machine agent writes it: one file, mode 0600, holding every uplink's secrets and switches,
//! read again whenever it changes. The agent never restarts remoted to change a switch: a switch turned off reaches
//! remoted on the next look (every [`WATCH_EVERY`]), and what stays allowed keeps running.
//!
//! ```json
//! { "paused": false, "notBefore": 0,
//!   "uplinks": [{ "id": "…", "url": "https://…", "device": "…", "uplinkToken": "…", "mediaKey": "<base64url>",
//!                 "allow": { "view": false, "control": false, "terminal": true }, "generation": 1 }] }
//! ```
//!
//! With `--sandbox-url` and `--device` on the command line (a person running it by hand, a test), the file holds one
//! uplink's fields at its top level instead: `{ "uplinkToken", "mediaKey", "allow", "paused"?, "notBefore"? }`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::token;

/// How often the file is looked at: well inside the 2 s a switch has to reach a running remoted.
pub const WATCH_EVERY: Duration = Duration::from_millis(500);

/// What one uplink's people may do, from that sandbox's own grant on this computer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allow {
    #[serde(default)]
    pub view: bool,
    #[serde(default)]
    pub control: bool,
    #[serde(default)]
    pub terminal: bool,
}

impl Allow {
    pub fn any(self) -> bool {
        self.view || self.control || self.terminal
    }
}

/// One linked sandbox's uplink.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UplinkConfig {
    /// The link's name in the status remoted prints; any string, unique per uplink.
    pub id: String,
    /// The sandbox's daemon base (`https://…`, or `http://127.0.0.1:<port>` when it runs on this computer).
    pub url: String,
    /// The name this computer goes by on that sandbox's uplink, sent as `x-intentic-device`.
    pub device: String,
    pub uplink_token: String,
    /// base64url of the key viewers' tokens are signed with.
    pub media_key: String,
    #[serde(default)]
    pub allow: Allow,
    /// Bumped by the agent on every start it was asked for: an uplink the sandbox withdrew dials again only once this moves.
    #[serde(default)]
    pub generation: u64,
}

impl UplinkConfig {
    pub fn key(&self) -> Option<Vec<u8>> {
        token::decode_key(&self.media_key)
    }

    /// Whether the dial itself changed (where, as whom): a running uplink is closed and dialled again.
    pub fn same_dial(&self, other: &Self) -> bool {
        self.url == other.url
            && self.device == other.device
            && self.uplink_token == other.uplink_token
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Config {
    /// The person at this computer paused people's input (the agent's pause hotkey): everything typed is dropped.
    pub paused: bool,
    /// Every viewer opened by a token minted before this (ms since the epoch) is dropped, and such tokens refused: the
    /// person at this computer ending every session at once.
    pub not_before: u64,
    pub uplinks: Vec<UplinkConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    not_before: u64,
    #[serde(default)]
    uplinks: Vec<UplinkConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OneUplinkFile {
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    not_before: u64,
    uplink_token: String,
    media_key: String,
    #[serde(default)]
    allow: Allow,
    #[serde(default)]
    generation: u64,
}

/// The uplink the command line names, whose secrets the file holds at its top level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Named {
    pub url: String,
    pub device: String,
}

/// Reads the file's text. An uplink whose media key does not decode, or whose url is not http(s), is an error naming it:
/// the agent wrote it, and a silent skip would read as a dead uplink.
pub fn parse(text: &str, named: Option<&Named>) -> anyhow::Result<Config> {
    let config = match named {
        None => {
            let file: File = serde_json::from_str(text)?;
            Config {
                paused: file.paused,
                not_before: file.not_before,
                uplinks: file.uplinks,
            }
        }
        Some(named) => {
            let file: OneUplinkFile = serde_json::from_str(text)?;
            Config {
                paused: file.paused,
                not_before: file.not_before,
                uplinks: vec![UplinkConfig {
                    id: "default".into(),
                    url: named.url.clone(),
                    device: named.device.clone(),
                    uplink_token: file.uplink_token,
                    media_key: file.media_key,
                    allow: file.allow,
                    generation: file.generation,
                }],
            }
        }
    };
    let mut seen = std::collections::HashSet::new();
    for uplink in &config.uplinks {
        anyhow::ensure!(
            seen.insert(uplink.id.as_str()),
            "uplink {:?} is listed twice",
            uplink.id
        );
        anyhow::ensure!(
            uplink.key().is_some(),
            "uplink {:?}: mediaKey is not base64url",
            uplink.id
        );
        anyhow::ensure!(
            uplink.url.starts_with("http://") || uplink.url.starts_with("https://"),
            "uplink {:?}: url must be http:// or https://",
            uplink.id
        );
        anyhow::ensure!(
            !uplink.uplink_token.is_empty(),
            "uplink {:?}: uplinkToken is empty",
            uplink.id
        );
    }
    Ok(config)
}

/// Reads the file once.
pub fn read(path: &Path, named: Option<&Named>) -> anyhow::Result<Config> {
    let text = std::fs::read_to_string(path)?;
    warn_if_open(path);
    parse(&text, named)
}

// The file carries every uplink's token and key: one others can read is the agent's mistake, said once a change.
#[cfg(unix)]
fn warn_if_open(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path)
        && meta.permissions().mode() & 0o077 != 0
    {
        log::warn!(
            "{} can be read by others (mode {:o}); it holds the uplinks' secrets",
            path.display(),
            meta.permissions().mode() & 0o777
        );
    }
}

#[cfg(not(unix))]
fn warn_if_open(_path: &Path) {}

/// Follows the file: the receiver holds the newest config that parsed. One that does not parse (a write caught half
/// way, though the agent renames into place) leaves the last good one standing and is said once.
pub fn watch(path: PathBuf, named: Option<Named>, first: Config) -> watch::Receiver<Config> {
    let (sender, receiver) = watch::channel(first);
    tokio::spawn(async move {
        // Read again on the first look: the file may have moved since `first` was read from it.
        let mut last_text: Option<String> = None;
        let mut said: Option<String> = None;
        let mut every = tokio::time::interval(WATCH_EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            if sender.is_closed() {
                return;
            }
            let text = match tokio::fs::read_to_string(&path).await {
                Ok(text) => text,
                Err(error) => {
                    let words = format!("cannot read {}: {error}", path.display());
                    if said.as_deref() != Some(&words) {
                        log::warn!("{words}; keeping the last configuration");
                        said = Some(words);
                    }
                    continue;
                }
            };
            if last_text.as_deref() == Some(text.as_str()) {
                continue;
            }
            match parse(&text, named.as_ref()) {
                Ok(config) => {
                    warn_if_open(&path);
                    last_text = Some(text);
                    said = None;
                    sender.send_if_modified(|held| {
                        if *held == config {
                            return false;
                        }
                        *held = config;
                        true
                    });
                }
                Err(error) => {
                    let words = format!("{} does not read: {error}", path.display());
                    if said.as_deref() != Some(&words) {
                        log::warn!("{words}; keeping the last configuration");
                        said = Some(words);
                    }
                }
            }
        }
    });
    receiver
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

    fn uplink(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","url":"https://sandbox.example","device":"rog","uplinkToken":"t","mediaKey":"{KEY}","allow":{{"terminal":true}},"generation":2}}"#
        )
    }

    #[test]
    fn the_agents_file_reads_with_every_uplink_and_switch() {
        let text = format!(
            r#"{{"paused":true,"notBefore":5,"uplinks":[{},{}]}}"#,
            uplink("a"),
            uplink("b")
        );
        let config = parse(&text, None).unwrap();
        assert!(config.paused);
        assert_eq!(config.not_before, 5);
        assert_eq!(config.uplinks.len(), 2);
        assert_eq!(config.uplinks[0].id, "a");
        assert_eq!(
            config.uplinks[0].allow,
            Allow {
                view: false,
                control: false,
                terminal: true
            }
        );
        assert_eq!(config.uplinks[0].generation, 2);
        assert_eq!(config.uplinks[0].key(), Some(vec![7_u8; 32]));
    }

    #[test]
    fn an_empty_file_object_serves_nothing() {
        assert_eq!(parse("{}", None).unwrap(), Config::default());
    }

    #[test]
    fn a_command_line_uplink_takes_its_secrets_from_the_top_level() {
        let named = Named {
            url: "http://127.0.0.1:9".into(),
            device: "dev".into(),
        };
        let text = format!(r#"{{"uplinkToken":"tok","mediaKey":"{KEY}","allow":{{"view":true}}}}"#);
        let config = parse(&text, Some(&named)).unwrap();
        assert_eq!(config.uplinks.len(), 1);
        assert_eq!(config.uplinks[0].url, "http://127.0.0.1:9");
        assert_eq!(config.uplinks[0].device, "dev");
        assert_eq!(config.uplinks[0].uplink_token, "tok");
        assert!(config.uplinks[0].allow.view);
    }

    #[test]
    fn a_bad_key_a_bad_url_or_a_repeated_id_is_refused_by_name() {
        let bad_key = uplink("a").replace(KEY, "!!!");
        let error = parse(&format!(r#"{{"uplinks":[{bad_key}]}}"#), None).unwrap_err();
        assert!(error.to_string().contains("mediaKey"), "{error}");
        let bad_url = uplink("a").replace("https://sandbox.example", "ftp://x");
        let error = parse(&format!(r#"{{"uplinks":[{bad_url}]}}"#), None).unwrap_err();
        assert!(error.to_string().contains("url"), "{error}");
        let twice = format!(r#"{{"uplinks":[{},{}]}}"#, uplink("a"), uplink("a"));
        let error = parse(&twice, None).unwrap_err();
        assert!(error.to_string().contains("twice"), "{error}");
    }

    #[tokio::test]
    async fn a_change_to_the_file_reaches_the_watcher_and_a_broken_write_keeps_the_last() {
        let dir = std::env::temp_dir().join(format!("remoted-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("remoted.json");
        std::fs::write(&path, "{}").unwrap();
        let first = read(&path, None).unwrap();
        let mut watching = watch(path.clone(), None, first);
        std::fs::write(&path, r#"{"paused":true}"#).unwrap();
        tokio::time::timeout(Duration::from_secs(5), watching.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(watching.borrow().paused);
        std::fs::write(&path, r#"{"paused":"#).unwrap();
        tokio::time::sleep(WATCH_EVERY * 3).await;
        assert!(watching.borrow_and_update().paused);
        std::fs::remove_dir_all(&dir).ok();
    }
}
