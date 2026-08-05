use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::util::{timestamp, Fail, Result};

/* Every connect/recreate leaves a log on this machine — otherwise a failed setup is only ever seen on the
 * terminal it scrolled past, and a recreate's `docker rm` destroys the old container's `docker logs` before
 * anyone thinks to save them. Same dir the shell flows always used (~/.intentic/logs, INTENTIC_LOG_DIR to
 * move it), same retention: the newest 10 per flow prefix. */

pub fn log_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("INTENTIC_LOG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    home_dir().join(".intentic").join("logs")
}

/// ~/.intentic — the per-user state dir (channel records, logs). INTENTIC_HOME to move it, as recreate.sh
/// honored for its channel record.
pub fn intentic_home() -> PathBuf {
    if let Ok(dir) = std::env::var("INTENTIC_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    home_dir().join(".intentic")
}

fn home_dir() -> PathBuf {
    #[cfg(unix)]
    let home = std::env::var("HOME").unwrap_or_default();
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home)
}

/// Clonable so the tee threads that mirror a docker build/pull into the log can share it with the flow.
#[derive(Clone)]
pub struct Log {
    pub path: PathBuf,
    file: Arc<Mutex<std::fs::File>>,
}

impl Log {
    /// Open `<log dir>/<prefix>-<timestamp>.log`, pruning that prefix to the newest 10 first.
    pub fn create(prefix: &str) -> Result<Log> {
        Log::create_named(prefix, prefix)
    }

    /// Same, with a longer filename prefix pruned under a shared family — recreate logs are named
    /// `recreate-<mode>-…` but all count against one `recreate-` retention, as the script's were.
    pub fn create_named(family: &str, prefix: &str) -> Result<Log> {
        let dir = log_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|err| Fail(format!("could not create log dir {}: {err}", dir.display())))?;
        prune(&dir, family);
        let path = dir.join(format!("{prefix}-{}.log", timestamp()));
        let file = std::fs::File::create(&path)
            .map_err(|err| Fail(format!("could not create {}: {err}", path.display())))?;
        Ok(Log {
            path,
            file: Arc::new(Mutex::new(file)),
        })
    }

    pub fn line(&self, text: &str) {
        self.write(format!("{text}\n").as_bytes());
    }

    /// A `== title ==` section header, the shape the shell logs used — greppable seams between phases.
    pub fn section(&self, title: &str) {
        self.line(&format!("== {title} =="));
    }

    pub fn write(&self, bytes: &[u8]) {
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(bytes);
        }
    }

    /// The log's last few lines, for surfacing next to "the full error is saved to <path>" — the terminal
    /// user should not have to open a file to see WHAT failed, only for the detail.
    pub fn tail(&self, lines: usize) -> String {
        let Ok(content) = std::fs::read_to_string(&self.path) else {
            return String::new();
        };
        let all: Vec<&str> = content.lines().collect();
        let start = all.len().saturating_sub(lines);
        all[start..].join("\n")
    }
}

/// Keep the newest 10 `<prefix>-*.log` (by name — the timestamp format sorts), delete the rest. Best-effort,
/// exactly like the `ls -1t | tail -n +10 | xargs rm -f` it replaces.
fn prune(dir: &std::path::Path, prefix: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(&format!("{prefix}-")) && name.ends_with(".log")
                })
        })
        .collect();
    logs.sort();
    logs.reverse();
    for stale in logs.iter().skip(9) {
        let _ = std::fs::remove_file(stale);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prunes_to_the_newest_ten_including_the_one_about_to_be_created() {
        let dir = tempfile::tempdir().expect("tempdir");
        for i in 0..15 {
            std::fs::write(
                dir.path()
                    .join(format!("connect-2026010{}-0000{i:02}.log", i % 10)),
                "x",
            )
            .expect("write");
        }
        std::fs::write(dir.path().join("recreate-20260101-000000.log"), "x").expect("write");
        prune(dir.path(), "connect");
        let connect_logs = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("connect-"))
            .count();
        assert_eq!(
            connect_logs, 9,
            "9 kept + the one Log::create then writes = 10"
        );
        assert!(
            dir.path().join("recreate-20260101-000000.log").exists(),
            "other prefixes untouched"
        );
    }
}
