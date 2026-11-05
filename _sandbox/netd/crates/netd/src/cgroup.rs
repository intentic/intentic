//! Keeps the entrypoint's `daemon` cgroup leaf (no swap, top cpu/io weight) to netd and Node alone: anything else
//! that lands there by inheritance moves to the sibling `workload` leaf, Node moves back in whenever it is found
//! outside, and Node's children run at nice 10.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::sync::watch;

pub const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const POLL: Duration = Duration::from_millis(250);
const WORKLOAD_NICE: i32 = 10;

/// A process's cgroup from its `/proc/<pid>/cgroup`: the unified hierarchy's path, as the reader's cgroup namespace
/// names it (`/daemon`, `/workload`).
pub fn cgroup_of(proc_cgroup: &str) -> Option<&str> {
    proc_cgroup
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::trim_end)
}

/// netd's cgroup from `/proc/self/cgroup`, when it is the entrypoint's `daemon` leaf.
pub fn daemon_cgroup_of(proc_self_cgroup: &str) -> Option<&str> {
    let path = cgroup_of(proc_self_cgroup)?;
    path.ends_with("/daemon").then_some(path)
}

/// Every pid in `procs` but the ones that belong in the daemon leaf.
pub fn strays(procs: &str, keep: &[u32]) -> Vec<u32> {
    procs
        .split_whitespace()
        .filter_map(|pid| pid.parse().ok())
        .filter(|pid| !keep.contains(pid))
        .collect()
}

/// Which of the daemon leaf's strays move out this tick. A child of netd's own waits one tick the first time it is
/// seen: it may be the Node the supervisor is starting, which is in the leaf from its fork (it inherits netd's cgroup)
/// while its pid is told to this loop only once its exec went through, and on a loaded machine that is long enough for a
/// tick to fall between. Moved out then, it ran in `workload` for good, since nothing moved it back: what was seen
/// live on 2026-11-05, Node in `/workload` and netd alone in `/daemon`. Seen again and still not Node, it is a stray
/// like any other (a `git` of the change feed's, a terminal's `tmux` client). `waited` holds the children already let
/// wait, kept to the strays still there.
pub fn due(found: &[u32], waited: &mut HashSet<u32>, netd_child: impl Fn(u32) -> bool) -> Vec<u32> {
    waited.retain(|pid| found.contains(pid));
    found
        .iter()
        .copied()
        .filter(|&pid| !(netd_child(pid) && waited.insert(pid)))
        .collect()
}

/// Where Node is when that is not the daemon leaf (`daemon`, as `/proc/<pid>/cgroup` names it): moved out as a stray,
/// or put somewhere else by anything at all.
pub fn outside<'a>(proc_cgroup: &'a str, daemon: &str) -> Option<&'a str> {
    cgroup_of(proc_cgroup).filter(|path| *path != daemon)
}

/// The parent pid in a `/proc/<pid>/stat` line: field 4, counted after the `)` that closes the command name.
pub fn parent_of(stat: &str) -> Option<u32> {
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// The entrypoint's two leaves, when netd runs in its `daemon` one: what this loop keeps, and what the memory guard
/// (memguard) reads and spares.
#[derive(Debug, Clone)]
pub struct Leaves {
    /// The daemon leaf as `/proc/<pid>/cgroup` names it: `/daemon`.
    pub daemon_path: String,
    /// The daemon leaf's directory under the cgroup filesystem.
    pub daemon: PathBuf,
    /// The `workload` leaf's directory, beside it.
    pub workload: PathBuf,
}

impl Leaves {
    /// The cgroup holding both leaves: the container's own, whose pressure covers everything in the box.
    pub fn container(&self) -> &Path {
        self.daemon.parent().unwrap_or(Path::new(CGROUP_ROOT))
    }
}

/// The leaves, when netd runs in the entrypoint's daemon leaf and its workload sibling exists: the container's own netd.
/// A netd anywhere else (a test's, a developer's) keeps nothing, and nothing guards memory from it.
pub fn leaves() -> Option<Leaves> {
    let own = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let daemon_path = daemon_cgroup_of(&own)?.to_owned();
    let daemon = Path::new(CGROUP_ROOT).join(daemon_path.trim_start_matches('/'));
    let workload = daemon.parent()?.join("workload");
    workload.join("cgroup.procs").exists().then_some(Leaves {
        daemon_path,
        daemon,
        workload,
    })
}

pub async fn govern(leaves: Option<Leaves>, node: watch::Receiver<Option<u32>>) {
    let netd = std::process::id();
    let mut reniced: HashSet<u32> = HashSet::new();
    let mut refused: HashSet<u32> = HashSet::new();
    let mut waited: HashSet<u32> = HashSet::new();
    let mut returned: HashSet<u32> = HashSet::new();
    let mut tick = tokio::time::interval(POLL);
    loop {
        tick.tick().await;
        let node = *node.borrow();
        if let Some(leaves) = &leaves {
            if let Some(node) = node {
                keep_in(leaves, node, &mut returned);
            }
            move_strays(
                leaves,
                netd,
                &[Some(netd), node].into_iter().flatten().collect::<Vec<_>>(),
                &mut waited,
                &mut refused,
            );
        }
        if let Some(node) = node {
            renice_children(node, &mut reniced);
        }
    }
}

// Node back into the daemon leaf, wherever it was found: the guarantee, whatever moved it out (the race `due` closes, or
// anything this loop cannot see). Only the process moves, every thread of it; what Node already started stays where it
// runs, in `workload`, as it should. Memory Node was charged for while outside stays charged there (cgroup v2 never
// moves a charge), which is only what it allocated in the meantime. Said once per Node, moved or refused.
fn keep_in(leaves: &Leaves, node: u32, said: &mut HashSet<u32>) {
    said.retain(|pid| *pid == node);
    let Ok(text) = std::fs::read_to_string(format!("/proc/{node}/cgroup")) else {
        return;
    };
    let Some(found) = outside(&text, &leaves.daemon_path) else {
        return;
    };
    match std::fs::write(leaves.daemon.join("cgroup.procs"), node.to_string()) {
        Ok(()) => {
            if said.insert(node) {
                tracing::warn!(
                    pid = node,
                    found,
                    "the daemon was outside its cgroup leaf; moved it back in"
                );
            }
        }
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
        Err(error) => {
            if said.insert(node) {
                tracing::warn!(%error, pid = node, found, "the daemon is outside its cgroup leaf: moving it back was refused");
            }
        }
    }
}

// One pid per write, as cgroup.procs takes them; a process that exits mid-move (ESRCH) is no loss. Any other refusal
// leaves it in the daemon's leaf every tick after, so it is said once per pid rather than retried in silence.
fn move_strays(
    leaves: &Leaves,
    netd: u32,
    keep: &[u32],
    waited: &mut HashSet<u32>,
    refused: &mut HashSet<u32>,
) {
    let Ok(procs) = std::fs::read_to_string(leaves.daemon.join("cgroup.procs")) else {
        return;
    };
    let found = strays(&procs, keep);
    refused.retain(|pid| found.contains(pid));
    let netd_child = |pid: u32| {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| parent_of(&stat))
            == Some(netd)
    };
    let workload = leaves.workload.join("cgroup.procs");
    for pid in due(&found, waited, netd_child) {
        if let Err(error) = std::fs::write(&workload, pid.to_string())
            && error.raw_os_error() != Some(libc::ESRCH)
            && refused.insert(pid)
        {
            tracing::warn!(%error, pid, "a stray process stays in the daemon's cgroup: moving it was refused");
        }
    }
}

// The daemon puts what it starts for a purpose in a workload class as it spawns it (src/workload/workload-class.ts),
// niceness included, and every class runs at this nice or lower. This loop is the floor for the rest: the git fork
// broker and every plain spawn (rules, runner commands, the JS tool, Xvfb, VPN clients) would otherwise run at the
// daemon's own priority. It sets 10 once per child and never raises one a class already lowered further.
fn renice_children(node: u32, reniced: &mut HashSet<u32>) {
    let Ok(children) = std::fs::read_to_string(format!("/proc/{node}/task/{node}/children")) else {
        return;
    };
    let current: HashSet<u32> = children
        .split_whitespace()
        .filter_map(|pid| pid.parse().ok())
        .collect();
    reniced.retain(|pid| current.contains(pid));
    for pid in current {
        // SAFETY: setpriority on a pid read from procfs; a pid gone since is an error, retried never.
        if !reniced.contains(&pid) && lower_to_workload(pid) {
            reniced.insert(pid);
        }
    }
}

// Down to WORKLOAD_NICE, never back up: a child spawned at 19 (an agent's build) stays at 19. True once every thread of
// the child sits at or below it, so it is not looked at again. Thread by thread, since Linux keeps a niceness per thread:
// a pid alone lowered only the main thread, and by the first look a Node or a build already runs threads of its own,
// which stayed at the daemon's priority (2026-10-06). Threads started later inherit their starter's.
fn lower_to_workload(pid: u32) -> bool {
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return false;
    };
    let mut lowered = true;
    for task in tasks.flatten() {
        let Some(tid) = task
            .file_name()
            .to_str()
            .and_then(|tid| tid.parse::<u32>().ok())
        else {
            continue;
        };
        let Some(current) = std::fs::read_to_string(task.path().join("stat"))
            .ok()
            .and_then(|stat| nice_of(&stat))
        else {
            lowered = false;
            continue;
        };
        // SAFETY: setpriority on a thread id read from procfs; one gone since is an error, and the child is looked at
        // again next tick.
        if current < WORKLOAD_NICE
            && unsafe { libc::setpriority(libc::PRIO_PROCESS, tid, WORKLOAD_NICE) } != 0
        {
            lowered = false;
        }
    }
    lowered
}

/// The niceness in a `/proc/<pid>/stat` line: field 19, counted after the `)` that closes the command name, which may
/// itself hold spaces and parentheses.
pub fn nice_of(stat: &str) -> Option<i32> {
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(16)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_entrypoints_daemon_leaf_counts() {
        assert_eq!(daemon_cgroup_of("0::/daemon\n"), Some("/daemon"));
        assert_eq!(
            daemon_cgroup_of("0::/docker/abc/daemon"),
            Some("/docker/abc/daemon")
        );
        assert_eq!(daemon_cgroup_of("0::/workload"), None);
        assert_eq!(daemon_cgroup_of("0::/daemons"), None);
        assert_eq!(daemon_cgroup_of("12:cpu:/daemon"), None);
    }

    #[test]
    fn the_niceness_is_read_after_the_command_name_whatever_it_holds() {
        let stat = "4242 (a (b) c) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 10 1 0 123 4096 25 18446744073709551615";
        assert_eq!(nice_of(stat), Some(10));
        assert_eq!(
            nice_of("4242 (sleep) S 1 2 3 0 -1 0 0 0 0 0 0 0 0 0 39 19 1 0 5"),
            Some(19)
        );
        assert_eq!(nice_of("garbage"), None);
    }

    // Set on the copy of this test binary `every_thread_of_a_child_is_lowered` starts, which then runs only
    // `a_threaded_child` below.
    const THREADED_CHILD: &str = "NETD_TEST_THREADED_CHILD";

    // What that copy is: a process running three threads besides its own, as a Node or a build is by netd's first look.
    #[test]
    #[ignore = "the child every_thread_of_a_child_is_lowered starts, and only that"]
    fn a_threaded_child() {
        if std::env::var_os(THREADED_CHILD).is_none() {
            return;
        }
        let threads: Vec<_> = (0..3)
            .map(|_| std::thread::spawn(|| std::thread::sleep(Duration::from_secs(30))))
            .collect();
        for thread in threads {
            let _ = thread.join();
        }
    }

    fn nices(pid: u32) -> Vec<i32> {
        std::fs::read_dir(format!("/proc/{pid}/task"))
            .unwrap()
            .flatten()
            .filter_map(|task| std::fs::read_to_string(task.path().join("stat")).ok())
            .filter_map(|stat| nice_of(&stat))
            .collect()
    }

    #[test]
    fn every_thread_of_a_child_is_lowered() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "cgroup::tests::a_threaded_child", "--ignored"])
            .env(THREADED_CHILD, "1")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        // The harness's own thread for the test, and the test's three.
        let mut before = nices(pid);
        for _ in 0..500 {
            if before.len() >= 5 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
            before = nices(pid);
        }
        let lowered = lower_to_workload(pid);
        let after = nices(pid);
        let _ = child.kill();
        let _ = child.wait();
        assert!(before.len() >= 5, "the child runs its threads: {before:?}");
        assert!(lowered);
        assert!(
            after.iter().all(|nice| *nice >= WORKLOAD_NICE),
            "every thread at nice {WORKLOAD_NICE} or above, from {before:?}: {after:?}"
        );
    }

    #[test]
    fn everything_but_the_kept_pids_is_a_stray() {
        assert_eq!(strays("1\n42\n43\n", &[1, 42]), vec![43]);
        assert_eq!(strays("", &[1]), Vec::<u32>::new());
    }

    #[test]
    fn a_process_cgroup_is_the_unified_line() {
        assert_eq!(cgroup_of("0::/workload\n"), Some("/workload"));
        assert_eq!(
            cgroup_of("12:memory:/x\n0::/docker/abc\n"),
            Some("/docker/abc")
        );
        assert_eq!(cgroup_of("12:memory:/x\n"), None);
    }

    // The supervisor's new Node is a child of netd's in the leaf before its pid is told: it waits a tick, and only a child
    // still there and still not Node a tick later moves. Anything else moves at once.
    #[test]
    fn a_child_of_netds_waits_one_tick_before_it_moves() {
        let netd_child = |pid: u32| pid >= 100;
        let mut waited = HashSet::new();
        assert_eq!(due(&[42, 100], &mut waited, netd_child), vec![42]);
        assert_eq!(
            due(&[100, 101], &mut waited, netd_child),
            vec![100],
            "a tick later the first moves, and the next new child waits its own tick"
        );
        assert_eq!(due(&[101], &mut waited, netd_child), vec![101]);
        // Kept as Node (so no longer found), a pid is forgotten, and a child that takes the number again waits afresh.
        assert_eq!(due(&[], &mut waited, netd_child), Vec::<u32>::new());
        assert!(waited.is_empty());
        assert_eq!(due(&[100], &mut waited, netd_child), Vec::<u32>::new());
    }

    // 2026-11-05: Node seen live in `/workload`, with netd alone in `/daemon`.
    #[test]
    fn node_anywhere_but_the_daemon_leaf_is_outside() {
        assert_eq!(outside("0::/workload\n", "/daemon"), Some("/workload"));
        assert_eq!(outside("0::/\n", "/daemon"), Some("/"));
        assert_eq!(outside("0::/daemon\n", "/daemon"), None);
        assert_eq!(
            outside("0::/docker/abc/daemon\n", "/docker/abc/daemon"),
            None
        );
        assert_eq!(
            outside("", "/daemon"),
            None,
            "a cgroup unread is no verdict"
        );
    }

    #[test]
    fn the_parent_is_read_after_the_command_name_whatever_it_holds() {
        assert_eq!(
            parent_of("64 (node (main)) S 7 64 64 0 -1 4194560 100"),
            Some(7)
        );
        assert_eq!(parent_of("garbage"), None);
    }
}
