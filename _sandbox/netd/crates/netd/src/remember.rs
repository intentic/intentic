//! What Node last told netd to be: its ports, its loopback certificate and its tunnel, written down as Node says them
//! and applied again when netd starts, before any Node has said anything. Every address netd has comes from Node, so a
//! Node that dies before it speaks left netd listening on nothing and holding no tunnel: a sandbox whose daemon crashed
//! on every start answered nobody at all, not even with the vitals that say it is crashing, and its owner watched a
//! spinner (2026-10-06: a restarted container whose daemon could not load a package). With the last config applied,
//! the same box answers its vitals and netd's own "restarting" over the tunnel and on its ports, and a Node that does
//! speak replaces all of it as it always did.
//!
//! The file lives in netd's run directory, root's alone, on the container's own filesystem: it survives a restart of
//! the container and goes with it on a recreate, where the next Node's word is the first. It holds the tunnel's grant
//! and the loopback key, neither of which reaches further than it already did: the grant is in this process's own
//! environment (the container's, which only root reads), and the key in the daemon's certificate store on disk.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use netd_wire::{Certificate, ListenConfig, TunnelConfig};
use serde::{Deserialize, Serialize};

/// The file's name in netd's run directory.
pub const FILE: &str = "last-config.json";

/// Node's last word on each of the three, `None` where it has said none yet or said there is none.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remembered {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<ListenConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate: Option<Certificate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel: Option<TunnelConfig>,
}

pub struct Memory {
    path: PathBuf,
    held: Remembered,
}

impl Memory {
    /// What the run directory remembers, or nothing: a file missing, unreadable or of another shape is no memory, and
    /// netd starts as it always did, waiting for Node.
    pub fn open(run_dir: &Path) -> Self {
        let path = run_dir.join(FILE);
        let held = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self { path, held }
    }

    pub fn held(&self) -> &Remembered {
        &self.held
    }

    pub fn listen(&mut self, config: &ListenConfig) {
        self.change(|held| held.listen = Some(config.clone()));
    }

    pub fn certificate(&mut self, certificate: Option<&Certificate>) {
        self.change(|held| held.certificate = certificate.cloned());
    }

    pub fn tunnel(&mut self, tunnel: Option<&TunnelConfig>) {
        self.change(|held| held.tunnel = tunnel.cloned());
    }

    // Written only when it changed: Node re-sends the same config on every start.
    fn change(&mut self, edit: impl FnOnce(&mut Remembered)) {
        let mut next = self.held.clone();
        edit(&mut next);
        if next == self.held {
            return;
        }
        self.held = next;
        if let Err(error) = self.write() {
            tracing::warn!(%error, path = %self.path.display(), "could not remember the daemon's config");
        }
    }

    // Owner-only from its first byte, whole and then renamed into place: it holds the tunnel's grant and the loopback
    // key, and a netd starting while it is written must read the last one or none.
    fn write(&self) -> std::io::Result<()> {
        let json = serde_json::to_vec(&self.held).expect("a config always serializes");
        let partial = self.path.with_extension("json.partial");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&partial)?;
        file.write_all(&json)?;
        file.sync_all()?;
        std::fs::rename(&partial, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("netd-remember-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn listen(port: u16) -> ListenConfig {
        serde_json::from_value(serde_json::json!({
            "daemon": { "host": "0.0.0.0", "port": port },
            "frameAncestors": [],
            "previewProbePath": "/__probe",
        }))
        .unwrap()
    }

    #[test]
    fn what_node_said_is_what_the_next_netd_starts_with() {
        let run = dir("round-trip");
        let mut memory = Memory::open(&run);
        assert_eq!(memory.held(), &Remembered::default());
        let tunnel = TunnelConfig {
            url: "wss://ingress.example/tunnel".to_string(),
            grant: "grant-1".to_string(),
            bulk: vec!["PUT /files".to_string()],
        };
        let certificate = Certificate {
            certificate: "-----BEGIN CERTIFICATE-----".to_string(),
            private_key: "-----BEGIN PRIVATE KEY-----".to_string(),
        };
        memory.listen(&listen(8787));
        memory.certificate(Some(&certificate));
        memory.tunnel(Some(&tunnel));
        assert_eq!(
            Memory::open(&run).held(),
            &Remembered {
                listen: Some(listen(8787)),
                certificate: Some(certificate),
                tunnel: Some(tunnel),
            }
        );
        // Node saying there is no tunnel (loopback only) is remembered too.
        memory.tunnel(None);
        assert_eq!(Memory::open(&run).held().tunnel, None);
        let _ = std::fs::remove_dir_all(&run);
    }

    #[test]
    fn the_file_is_roots_alone_and_never_read_half_written() {
        let run = dir("mode");
        let mut memory = Memory::open(&run);
        memory.listen(&listen(8787));
        let mode = std::fs::metadata(run.join(FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(!run.join(FILE).with_extension("json.partial").exists());
        let _ = std::fs::remove_dir_all(&run);
    }

    #[test]
    fn a_file_netd_cannot_read_is_no_memory() {
        let run = dir("garbage");
        std::fs::write(run.join(FILE), b"{not json").unwrap();
        assert_eq!(Memory::open(&run).held(), &Remembered::default());
        std::fs::write(run.join(FILE), br#"{"listen":{"daemon":7}}"#).unwrap();
        assert_eq!(Memory::open(&run).held(), &Remembered::default());
        let _ = std::fs::remove_dir_all(&run);
    }

    #[test]
    fn the_same_config_again_is_not_written_again() {
        let run = dir("unchanged");
        let mut memory = Memory::open(&run);
        memory.listen(&listen(8787));
        let written = std::fs::metadata(run.join(FILE))
            .unwrap()
            .modified()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        memory.listen(&listen(8787));
        assert_eq!(
            std::fs::metadata(run.join(FILE))
                .unwrap()
                .modified()
                .unwrap(),
            written
        );
        memory.listen(&listen(8788));
        assert_eq!(
            Memory::open(&run)
                .held()
                .listen
                .as_ref()
                .map(|config| config.daemon.port),
            Some(8788)
        );
        let _ = std::fs::remove_dir_all(&run);
    }
}
