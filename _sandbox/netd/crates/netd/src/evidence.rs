//! What netd keeps of a daemon before it kills it stuck (supervise.rs `kill_stuck`). Until 2026-11-24 the kill took the
//! process with nothing kept but how long it had been silent, so a post-mortem could not tell a JS loop spinning on the
//! CPU from a main thread asleep in the kernel on a hung network mount. Two things are kept now, both bounded, both
//! before the SIGKILL:
//! - every thread's state, kernel wait channel, current syscall and (where the kernel lets netd read it) kernel stack,
//!   with the process's `status`, as one JSON document `netd-stuck.<at>.<pid>.json` beside the records; the newest
//!   `CAPTURES_KEPT` stay.
//! - a Node diagnostic report, asked for with the signal the daemon was started to answer (`--report-on-signal`,
//!   docker-entrypoint.sh) and waited for `REPORT_WITHIN`. Node handles that signal on the event loop, so a loop that is
//!   truly stuck never writes it: the report comes for a start hung before its hello, or a loop still turning, slowly.
//!   The signal is sent only when the daemon's command line asks for reports on it and the process catches it, so a
//!   daemon started without the flag is never killed by the signal's default action.
//!
//! What was kept is named on the kill's line in `netd-kills.jsonl` (`evidence`), where the daemon's post-mortem reads it
//! (`_sandbox/sandbox/src/system/boot/restarts/stuck-evidence.ts`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

// /proc of a process stalled on memory can block a reader on its mmap lock; past this the kill goes ahead without it.
const CAPTURE_WITHIN: Duration = Duration::from_secs(5);
// How long a report gets to be written once asked for: a turning loop writes it in well under a second.
const REPORT_WITHIN: Duration = Duration::from_secs(5);
const REPORT_POLL: Duration = Duration::from_millis(200);
// One per stuck kill; enough to compare a few, small enough to never matter on the volume.
const CAPTURES_KEPT: usize = 10;
const CAPTURE_PREFIX: &str = "netd-stuck.";
// A process with more threads than this is described by its first ones; Node runs some 50.
const THREADS_READ: usize = 256;
// Node's own default when `--report-signal` is not given.
const DEFAULT_REPORT_SIGNAL: &str = "SIGUSR2";

/// What the kill's line says was kept (`NetdKillSchema.evidence` in the daemon's memory-records.ts).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    /// The capture's file name, in the records' directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<String>,
    /// The main thread's state as /proc says it (`R`, `S`, `D`), its wait channel and its syscall line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wchan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syscall: Option<String>,
    /// The signal sent for a report, when one was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    /// The report's path, when one was written whole within `REPORT_WITHIN`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
    at: u64,
    pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    threads: Vec<Thread>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    tid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    comm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wchan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    syscall: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stack: Option<String>,
}

/// Where a report would be asked for: the signal's name and number, and the directory Node writes it to.
#[derive(Debug, PartialEq, Eq)]
struct ReportTarget {
    signal: &'static str,
    number: libc::c_int,
    dir: PathBuf,
}

/// Keeps what can be kept of `pid` before it is killed, writing the capture into `records` (none: nothing written,
/// as for a test's supervisor), and never takes much longer than `CAPTURE_WITHIN` and `REPORT_WITHIN` together.
pub async fn gather(pid: u32, records: Option<PathBuf>, at: u64) -> Evidence {
    let reading = tokio::task::spawn_blocking(move || capture(pid, records.as_deref(), at));
    let Ok(Ok((mut evidence, target))) = tokio::time::timeout(CAPTURE_WITHIN, reading).await else {
        tracing::warn!(
            pid,
            "the stuck daemon's /proc could not be read in time; killing it without a capture"
        );
        return Evidence::default();
    };
    if let Some(target) = target {
        evidence.report = ask_for_report(pid, &target).await;
        evidence.signal = Some(target.signal.to_owned());
    }
    tracing::warn!(
        ?evidence,
        "kept what the stuck daemon was doing before killing it"
    );
    evidence
}

// Reads every thread's /proc, writes the capture, and works out whether a report can be asked for. Blocking.
fn capture(pid: u32, records: Option<&Path>, at: u64) -> (Evidence, Option<ReportTarget>) {
    let proc = PathBuf::from(format!("/proc/{pid}"));
    let threads: Vec<Thread> = tids(&proc)
        .into_iter()
        .take(THREADS_READ)
        .map(|tid| thread(&proc.join("task").join(tid.to_string()), tid))
        .collect();
    let status = read_text(&proc.join("status"));
    let main = threads.iter().find(|thread| thread.tid == pid);
    let mut evidence = Evidence {
        state: main.and_then(|main| main.state.clone()),
        wchan: main.and_then(|main| main.wchan.clone()),
        syscall: main.and_then(|main| main.syscall.clone()),
        ..Evidence::default()
    };
    let target = std::fs::read(proc.join("cmdline"))
        .ok()
        .and_then(|cmdline| report_target(&cmdline, &proc))
        .filter(|target| {
            status
                .as_deref()
                .is_some_and(|status| catches(status, target.number))
        });
    if let Some(dir) = records {
        let name = format!("{CAPTURE_PREFIX}{at}.{pid}.json");
        let document = Capture {
            at,
            pid,
            status,
            threads,
        };
        match serde_json::to_vec_pretty(&document)
            .map_err(std::io::Error::from)
            .and_then(|bytes| {
                std::fs::create_dir_all(dir)?;
                std::fs::write(dir.join(&name), bytes)
            }) {
            Ok(()) => {
                evidence.capture = Some(name);
                prune_captures(dir, CAPTURES_KEPT);
            }
            Err(error) => {
                tracing::warn!(%error, dir = %dir.display(), "could not write the stuck daemon's capture")
            }
        }
    }
    (evidence, target)
}

fn tids(proc: &Path) -> Vec<u32> {
    let mut tids: Vec<u32> = std::fs::read_dir(proc.join("task"))
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    tids.sort_unstable();
    tids
}

fn thread(task: &Path, tid: u32) -> Thread {
    Thread {
        tid,
        comm: read_text(&task.join("comm")).map(|comm| comm.trim().to_owned()),
        state: read_text(&task.join("stat")).as_deref().and_then(state_of),
        // "0" is a thread on no wait channel: running, or runnable.
        wchan: read_text(&task.join("wchan")).filter(|wchan| !wchan.is_empty() && wchan != "0"),
        syscall: read_text(&task.join("syscall")).map(|line| line.trim().to_owned()),
        // Readable only with CAP_SYS_ADMIN, which a container's netd seldom has: absent then, never an error.
        stack: read_text(&task.join("stack")).filter(|stack| !stack.trim().is_empty()),
    }
}

fn read_text(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

// The state letter of a stat line: the first field after the command name, which may itself hold spaces and parens.
fn state_of(stat: &str) -> Option<String> {
    let (_, rest) = stat.rsplit_once(')')?;
    rest.split_whitespace().next().map(str::to_owned)
}

// The daemon asks for reports with `--report-on-signal`, names the signal with `--report-signal=` and the directory
// with `--report-directory=`; Node's defaults are SIGUSR2 and its working directory.
fn report_target(cmdline: &[u8], proc: &Path) -> Option<ReportTarget> {
    let args: Vec<&str> = cmdline
        .split(|byte| *byte == 0)
        .filter_map(|arg| std::str::from_utf8(arg).ok())
        .collect();
    if !args.contains(&"--report-on-signal") {
        return None;
    }
    let value = |flag: &str| {
        args.iter()
            .find_map(|arg| arg.strip_prefix(flag)?.strip_prefix('='))
    };
    let (signal, number) = signal_named(value("--report-signal").unwrap_or(DEFAULT_REPORT_SIGNAL))?;
    let dir = match value("--report-directory") {
        Some(dir) => PathBuf::from(dir),
        None => std::fs::read_link(proc.join("cwd")).ok()?,
    };
    Some(ReportTarget {
        signal,
        number,
        dir,
    })
}

// Only the signals Node lets a report be asked on and that end nothing when caught.
fn signal_named(name: &str) -> Option<(&'static str, libc::c_int)> {
    match name {
        "SIGUSR2" => Some(("SIGUSR2", libc::SIGUSR2)),
        "SIGUSR1" => Some(("SIGUSR1", libc::SIGUSR1)),
        "SIGHUP" => Some(("SIGHUP", libc::SIGHUP)),
        "SIGQUIT" => Some(("SIGQUIT", libc::SIGQUIT)),
        _ => None,
    }
}

// Whether `status`'s SigCgt mask says the process handles `signal` itself.
fn catches(status: &str, signal: libc::c_int) -> bool {
    status
        .lines()
        .find_map(|line| line.strip_prefix("SigCgt:"))
        .and_then(|mask| u64::from_str_radix(mask.trim(), 16).ok())
        .and_then(|mask| Some(mask & 1_u64.checked_shl(u32::try_from(signal - 1).ok()?)? != 0))
        .unwrap_or(false)
}

// A report Node wrote for `pid`: report.<date>.<time>.<pid>.<thread>.<sequence>.json.
fn is_report_of(name: &str, pid: u32) -> bool {
    let Some(inner) = name
        .strip_prefix("report.")
        .and_then(|rest| rest.strip_suffix(".json"))
    else {
        return false;
    };
    let fields: Vec<&str> = inner.split('.').collect();
    fields.len() == 5
        && fields
            .iter()
            .all(|field| !field.is_empty() && field.bytes().all(|byte| byte.is_ascii_digit()))
        && fields[2] == pid.to_string()
}

fn reports_of(dir: &Path, pid: u32) -> HashSet<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .filter(|name| is_report_of(name, pid))
                .collect()
        })
        .unwrap_or_default()
}

// Sends the report signal and waits for a new report of `pid` that parses whole; its path, or none in time.
async fn ask_for_report(pid: u32, target: &ReportTarget) -> Option<String> {
    let before = {
        let dir = target.dir.clone();
        tokio::task::spawn_blocking(move || reports_of(&dir, pid))
            .await
            .ok()?
    };
    let Ok(signalled) = i32::try_from(pid) else {
        return None;
    };
    // SAFETY: signalling a pid this process spawned and has not yet reaped, with a signal it was just seen to catch.
    if unsafe { libc::kill(signalled, target.number) } != 0 {
        return None;
    }
    let deadline = Instant::now() + REPORT_WITHIN;
    while Instant::now() < deadline {
        tokio::time::sleep(REPORT_POLL).await;
        let dir = target.dir.clone();
        let before = before.clone();
        let written = tokio::task::spawn_blocking(move || {
            reports_of(&dir, pid)
                .into_iter()
                .filter(|name| !before.contains(name))
                .map(|name| dir.join(name))
                .find(|path| whole(path))
        })
        .await
        .ok()
        .flatten();
        if let Some(path) = written {
            return Some(path.display().to_string());
        }
    }
    tracing::warn!(
        pid,
        signal = target.signal,
        "no report came from the stuck daemon: its event loop never turned to write it"
    );
    None
}

// Written to the end: Node writes a report in pieces, and one cut short does not parse.
fn whole(path: &Path) -> bool {
    std::fs::read(path)
        .is_ok_and(|bytes| serde_json::from_slice::<serde::de::IgnoredAny>(&bytes).is_ok())
}

// Keeps the newest `keep` captures in `dir`; their names start with the epoch milliseconds of the kill, so by name.
fn prune_captures(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with(CAPTURE_PREFIX) && name.ends_with(".json"))
        .collect();
    names.sort_unstable();
    let excess = names.len().saturating_sub(keep);
    for name in &names[..excess] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("netd-evidence-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cmdline(args: &[&str]) -> Vec<u8> {
        args.iter().flat_map(|arg| arg.bytes().chain([0])).collect()
    }

    #[test]
    fn a_report_is_asked_for_only_of_a_daemon_started_to_answer_one() {
        let proc = Path::new("/proc/self");
        assert_eq!(
            report_target(
                &cmdline(&[
                    "node",
                    "--report-on-fatalerror",
                    "--report-directory=/h/logs",
                    "main.js"
                ]),
                proc
            ),
            None
        );
        assert_eq!(
            report_target(
                &cmdline(&[
                    "node",
                    "--report-on-signal",
                    "--report-signal=SIGUSR2",
                    "--report-directory=/h/logs",
                    "main.js"
                ]),
                proc
            ),
            Some(ReportTarget {
                signal: "SIGUSR2",
                number: libc::SIGUSR2,
                dir: "/h/logs".into()
            })
        );
        // Node's defaults: SIGUSR2, written in its working directory.
        let defaulted =
            report_target(&cmdline(&["node", "--report-on-signal", "main.js"]), proc).unwrap();
        assert_eq!(defaulted.signal, "SIGUSR2");
        assert_eq!(defaulted.dir, std::env::current_dir().unwrap());
        // A signal whose default action could end something else, or one netd does not know, is never sent.
        assert_eq!(
            report_target(
                &cmdline(&["node", "--report-on-signal", "--report-signal=SIGTERM"]),
                proc
            ),
            None
        );
    }

    #[test]
    fn the_signal_is_sent_only_to_a_process_that_catches_it() {
        // SIGUSR2 is 12: bit 11.
        assert!(catches(
            "Name:\tnode\nSigCgt:\t0000000000000800\n",
            libc::SIGUSR2
        ));
        assert!(!catches(
            "Name:\tnode\nSigCgt:\t0000000000004000\n",
            libc::SIGUSR2
        ));
        assert!(!catches("Name:\tnode\n", libc::SIGUSR2));
    }

    #[test]
    fn a_report_is_known_by_the_pid_in_its_name() {
        assert!(is_report_of("report.20261123.225125.111.0.001.json", 111));
        assert!(!is_report_of("report.20261123.225125.111.0.001.json", 11));
        assert!(!is_report_of("report.20261123.225125.111.0.json", 111));
        assert!(!is_report_of("netd-stuck.1.111.json", 111));
    }

    #[test]
    fn a_state_is_read_past_a_command_name_holding_parens() {
        assert_eq!(
            state_of("111 (node (main)) D 1 111 111").as_deref(),
            Some("D")
        );
    }

    #[test]
    fn only_the_newest_captures_are_kept() {
        let dir = temp("prune");
        for at in 1..=4 {
            std::fs::write(dir.join(format!("{CAPTURE_PREFIX}{at}000.7.json")), "{}").unwrap();
        }
        std::fs::write(dir.join("netd-kills.jsonl"), "").unwrap();
        prune_captures(&dir, 2);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort_unstable();
        assert_eq!(
            left,
            [
                "netd-kills.jsonl",
                "netd-stuck.3000.7.json",
                "netd-stuck.4000.7.json"
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A shell standing in for Node: started with the report flags, it writes a report named for its own pid on SIGUSR2,
    // as Node does from a turning loop. The capture names its threads, and the report is found once it is whole.
    #[tokio::test]
    async fn a_capture_is_written_and_a_report_asked_for_and_found() {
        let dir = temp("gather");
        let logs = dir.join("logs");
        let script = format!(
            "trap 'printf %s \"{{\\\"header\\\":{{}}}}\" > {0}/report.20261124.000000.$$.0.001.json' USR2; while :; do sleep 0.05; done",
            dir.display()
        );
        let mut child = tokio::process::Command::new("sh")
            .args([
                "-c",
                &script,
                "--report-on-signal",
                &format!("--report-directory={}", dir.display()),
            ])
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        // Until the trap is set, the shell does not catch the signal and none is sent.
        for _ in 0..50 {
            if read_text(Path::new(&format!("/proc/{pid}/status")))
                .is_some_and(|status| catches(&status, libc::SIGUSR2))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let evidence = gather(pid, Some(logs.clone()), 1_764_000_000_000).await;
        child.kill().await.unwrap();

        let name = evidence.capture.clone().unwrap();
        assert_eq!(name, format!("netd-stuck.1764000000000.{pid}.json"));
        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(logs.join(&name)).unwrap()).unwrap();
        assert_eq!(document["pid"], pid);
        assert_eq!(document["threads"][0]["tid"], pid);
        assert!(document["status"].as_str().unwrap().contains("SigCgt:"));
        assert!(evidence.state.is_some());
        assert_eq!(evidence.signal.as_deref(), Some("SIGUSR2"));
        assert_eq!(
            evidence.report,
            Some(
                dir.join(format!("report.20261124.000000.{pid}.0.001.json"))
                    .display()
                    .to_string()
            )
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // No report flag: nothing is signalled, and the capture is still kept.
    #[tokio::test]
    async fn a_daemon_without_the_report_flag_gets_no_signal() {
        let dir = temp("plain");
        let mut child = tokio::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let evidence = gather(pid, Some(dir.clone()), 1).await;
        child.kill().await.unwrap();
        assert!(evidence.capture.is_some());
        assert_eq!(evidence.signal, None);
        assert_eq!(evidence.report, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
