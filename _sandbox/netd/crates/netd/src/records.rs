//! What netd leaves on the record about memory, as JSON lines in the history volume's `logs/`: each process its memory
//! guard killed (`memory-kills.jsonl`), what it did to the daemon (`netd-kills.jsonl`), and its samples while memory is
//! short (`pressure.jsonl`). netd writes them because netd stays responsive when the daemon does not: on 2026-11-05 a
//! runaway froze the daemon's event loop for 1 h 48 m, the daemon's own sampler went silent with it, and every kill netd
//! made went to stderr alone, so the boot after could only say "killed without warning". The daemon reads them back
//! (its post-mortem, and the notice a hurt conversation gets), and the shapes are its own, in
//! `_sandbox/sandbox/src/system/resources/memory-records.ts`: mirrored here by hand, so a field renamed there is renamed
//! here. Every line is written whole, in one write to a file opened for appending, and flushed to the disk at once: the
//! moment worth recording is the one most likely to end in a kill or a power cut.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

pub const MEMORY_KILLS_FILE: &str = "memory-kills.jsonl";
pub const NETD_KILLS_FILE: &str = "netd-kills.jsonl";
pub const PRESSURE_FILE: &str = "pressure.jsonl";

// The daemon's own history root and its default (`historyRoot` in its env.config.ts, `HISTORY_ROOT` in the container's
// environment, which `docker-entrypoint.sh` defaults the same way).
const HISTORY_ROOT_ENV: &str = "HISTORY_ROOT";
const HISTORY_ROOT: &str = "/history";

/// The history volume's `logs/`, where the daemon writes its own logs and reads these records back.
pub fn history_logs() -> PathBuf {
    std::env::var_os(HISTORY_ROOT_ENV)
        .filter(|root| !root.is_empty())
        .map_or_else(|| PathBuf::from(HISTORY_ROOT), PathBuf::from)
        .join("logs")
}

/// Now, as the records' `at`: epoch milliseconds.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, millis)
}

/// A duration as the records' whole milliseconds.
pub fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// The memory pressure over the whole sandbox: the share of the last ten seconds in which some task, or every task,
/// stalled waiting for memory, in percent (`PsiSchema`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Psi {
    pub some_avg10: f64,
    pub full_avg10: f64,
}

/// One process killed for memory (`MemoryKillSchema`). netd only ever writes its own guard's kills; the kernel's are
/// the daemon's to find.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryKill {
    pub at: u64,
    pub killer: Killer,
    pub pid: u32,
    pub comm: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argv: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rss_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oom_score: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pgid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cgroup: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub psi: Option<Psi>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Who killed it, as the schema names the killers; netd is only ever its own guard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Killer {
    #[serde(rename = "netd-guard")]
    NetdGuard,
}

/// What netd did to the daemon (`NetdKillSchema`'s `kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetdKillKind {
    /// A ping unanswered for vitals.rs's `STUCK_AFTER`: the event loop was not turning.
    Stuck,
    /// No hello within vitals.rs's `HELLO_DEADLINE` of its start: hung before it served.
    NoHello,
    /// A restart held back while the sandbox was short of memory (supervise.rs).
    RestartHeld,
}

/// One thing netd did to the daemon (`NetdKillSchema`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetdKill {
    pub at: u64,
    pub kind: NetdKillKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silent_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub psi: Option<Psi>,
}

/// One of the processes a pressure sample names (`PressureTopSchema`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureTop {
    pub pid: u32,
    pub comm: String,
    pub rss_bytes: u64,
    pub swap_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oom_score: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

/// netd's sample while memory is short (`PressureSampleSchema`): the workload leaf's use and bounds, the pressure, and
/// the processes the guard would reach for first.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureSample {
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_current: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_max: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_current: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_max: Option<u64>,
    pub psi: Psi,
    pub top: Vec<PressureTop>,
}

/// Where netd's records go, and which failures to write them it has already said. A record that cannot be written is
/// lost, and nothing else: a full or read-only volume never stops the guard or the supervisor that asked, and is said
/// once per file and step rather than once a second.
pub struct Records {
    dir: Option<PathBuf>,
    warned: Mutex<HashSet<String>>,
}

impl Records {
    pub fn in_dir(dir: PathBuf) -> Self {
        Self {
            dir: Some(dir),
            warned: Mutex::default(),
        }
    }

    /// Records that go nowhere: a test's supervisor, which has no history volume to write to.
    #[cfg(test)]
    pub fn nowhere() -> Self {
        Self {
            dir: None,
            warned: Mutex::default(),
        }
    }

    /// Appends `line` to `file` and flushes it to the disk.
    pub fn append(&self, file: &str, line: &impl Serialize) {
        self.write(file, line, None);
    }

    /// Appends as `append` does, first moving a file already past `limit` bytes to `<file>.1`, over the one before.
    pub fn append_rotating(&self, file: &str, line: &impl Serialize, limit: u64) {
        self.write(file, line, Some(limit));
    }

    fn write(&self, file: &str, line: &impl Serialize, limit: Option<u64>) {
        let Some(dir) = &self.dir else {
            return;
        };
        if let Err((step, error)) = append_line(dir, file, line, limit) {
            let first = self
                .warned
                .lock()
                .map(|mut warned| warned.insert(format!("{file} {step}")))
                .unwrap_or(false);
            if first {
                tracing::warn!(%error, file, step, dir = %dir.display(), "could not write a memory record; said once");
            }
        }
    }
}

fn append_line(
    dir: &Path,
    file: &str,
    line: &impl Serialize,
    limit: Option<u64>,
) -> Result<(), (&'static str, std::io::Error)> {
    let mut bytes = serde_json::to_vec(line).map_err(|error| ("serialize", error.into()))?;
    bytes.push(b'\n');
    std::fs::create_dir_all(dir).map_err(|error| ("create the directory", error))?;
    let path = dir.join(file);
    if let Some(limit) = limit
        && std::fs::metadata(&path).is_ok_and(|meta| meta.len() > limit)
    {
        std::fs::rename(&path, dir.join(format!("{file}.1"))).map_err(|error| ("rotate", error))?;
    }
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| ("open", error))?;
    out.write_all(&bytes).map_err(|error| ("write", error))?;
    out.sync_data().map_err(|error| ("flush", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("netd-records-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn keys(json: &serde_json::Value) -> Vec<&str> {
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        keys
    }

    // The daemon parses these with memory-records.ts's zod schemas: the names and kinds are theirs, and a field netd does
    // not know is left out, never written as null (an optional zod number refuses null).
    #[test]
    fn a_memory_kill_is_written_as_the_daemons_schema_names_it() {
        let kill = MemoryKill {
            at: 1_762_310_000_000,
            killer: Killer::NetdGuard,
            pid: 4242,
            comm: "node".into(),
            argv: Some("node build.js".into()),
            rss_bytes: Some(17 << 30),
            swap_bytes: Some(1 << 30),
            oom_score: Some(1650),
            pgid: Some(4200),
            owner: Some("brisk-ridge-27nl".into()),
            cgroup: Some("/workload".into()),
            psi: Some(Psi {
                some_avg10: 81.5,
                full_avg10: 47.25,
            }),
            reason: Some("pressure".into()),
        };
        let json = serde_json::to_value(&kill).unwrap();
        assert_eq!(
            keys(&json),
            [
                "argv",
                "at",
                "cgroup",
                "comm",
                "killer",
                "oomScore",
                "owner",
                "pgid",
                "pid",
                "psi",
                "reason",
                "rssBytes",
                "swapBytes"
            ]
        );
        assert_eq!(json["killer"], "netd-guard");
        assert_eq!(
            json["psi"],
            serde_json::json!({ "someAvg10": 81.5, "fullAvg10": 47.25 })
        );
        let bare = MemoryKill {
            argv: None,
            rss_bytes: None,
            swap_bytes: None,
            oom_score: None,
            pgid: None,
            owner: None,
            cgroup: None,
            psi: None,
            reason: None,
            ..kill
        };
        assert_eq!(
            keys(&serde_json::to_value(&bare).unwrap()),
            ["at", "comm", "killer", "pid"]
        );
    }

    #[test]
    fn a_netd_kill_names_its_kind_as_the_schema_does() {
        let line = |kind| {
            serde_json::to_value(NetdKill {
                at: 1,
                kind,
                pid: Some(64),
                silent_ms: Some(300_000),
                held_ms: None,
                psi: None,
            })
            .unwrap()
        };
        assert_eq!(line(NetdKillKind::Stuck)["kind"], "stuck");
        assert_eq!(line(NetdKillKind::NoHello)["kind"], "no-hello");
        assert_eq!(line(NetdKillKind::RestartHeld)["kind"], "restart-held");
        assert_eq!(
            keys(&line(NetdKillKind::Stuck)),
            ["at", "kind", "pid", "silentMs"]
        );
    }

    #[test]
    fn a_pressure_sample_always_carries_its_pressure_and_its_top() {
        let sample = PressureSample {
            at: 1,
            memory_current: Some(10),
            memory_max: None,
            swap_current: Some(3),
            swap_max: None,
            psi: Psi {
                some_avg10: 12.0,
                full_avg10: 10.5,
            },
            top: vec![PressureTop {
                pid: 9,
                comm: "cc1plus".into(),
                rss_bytes: 1,
                swap_bytes: 0,
                oom_score: Some(900),
                owner: None,
            }],
        };
        let json = serde_json::to_value(&sample).unwrap();
        assert_eq!(
            keys(&json),
            ["at", "memoryCurrent", "psi", "swapCurrent", "top"]
        );
        assert_eq!(
            keys(&json["top"][0]),
            ["comm", "oomScore", "pid", "rssBytes", "swapBytes"]
        );
    }

    #[test]
    fn lines_are_appended_one_per_record_and_a_full_file_moves_aside() {
        let dir = temp("append");
        let records = Records::in_dir(dir.join("logs"));
        let line = serde_json::json!({ "at": 1 });
        records.append(NETD_KILLS_FILE, &line);
        records.append(NETD_KILLS_FILE, &line);
        assert_eq!(
            std::fs::read_to_string(dir.join("logs").join(NETD_KILLS_FILE)).unwrap(),
            "{\"at\":1}\n{\"at\":1}\n",
            "the directory is made, and each record is one whole line"
        );

        // Past the limit, the file moves to `.1` before the next line, which starts the file afresh.
        records.append_rotating(PRESSURE_FILE, &line, 12);
        records.append_rotating(PRESSURE_FILE, &line, 12);
        assert!(!dir.join("logs").join("pressure.jsonl.1").exists());
        records.append_rotating(PRESSURE_FILE, &line, 12);
        assert_eq!(
            std::fs::read_to_string(dir.join("logs").join("pressure.jsonl.1")).unwrap(),
            "{\"at\":1}\n{\"at\":1}\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("logs").join(PRESSURE_FILE)).unwrap(),
            "{\"at\":1}\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_that_cannot_be_written_is_lost_without_a_fuss() {
        let dir = temp("refused");
        std::fs::create_dir_all(&dir).unwrap();
        // A file where the directory should be: every write fails, and none panics.
        std::fs::write(dir.join("logs"), "").unwrap();
        let records = Records::in_dir(dir.join("logs"));
        records.append(MEMORY_KILLS_FILE, &serde_json::json!({ "at": 1 }));
        records.append(MEMORY_KILLS_FILE, &serde_json::json!({ "at": 2 }));
        assert_eq!(records.warned.lock().unwrap().len(), 1, "said once");
        Records::nowhere().append(MEMORY_KILLS_FILE, &serde_json::json!({ "at": 3 }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_history_root_is_the_daemons() {
        // The environment is the process's, shared by every test thread: only its absence's default is checked here.
        if std::env::var_os(HISTORY_ROOT_ENV).is_none() {
            assert_eq!(history_logs(), Path::new("/history/logs"));
        }
    }
}
