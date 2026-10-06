//! Keeps the entrypoint's `daemon` cgroup leaf (no swap, top cpu/io weight) to netd and Node alone: anything else
//! that lands there by inheritance moves to the sibling `workload` leaf, and Node's children run at nice 10.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::sync::watch;

const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const POLL: Duration = Duration::from_millis(250);
const WORKLOAD_NICE: i32 = 10;

/// netd's cgroup from `/proc/self/cgroup`, when it is the entrypoint's `daemon` leaf.
pub fn daemon_cgroup_of(proc_self_cgroup: &str) -> Option<&str> {
    let path = proc_self_cgroup
        .lines()
        .find_map(|line| line.strip_prefix("0::"))?;
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

struct Leaves {
    daemon: PathBuf,
    workload: PathBuf,
}

fn leaves() -> Option<Leaves> {
    let own = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let daemon = Path::new(CGROUP_ROOT).join(daemon_cgroup_of(&own)?.trim_start_matches('/'));
    let workload = daemon.parent()?.join("workload").join("cgroup.procs");
    workload.exists().then(|| Leaves {
        daemon: daemon.join("cgroup.procs"),
        workload,
    })
}

pub async fn govern(node: watch::Receiver<Option<u32>>) {
    let leaves = leaves();
    let netd = std::process::id();
    let mut reniced: HashSet<u32> = HashSet::new();
    let mut refused: HashSet<u32> = HashSet::new();
    let mut tick = tokio::time::interval(POLL);
    loop {
        tick.tick().await;
        let node = *node.borrow();
        if let Some(leaves) = &leaves {
            move_strays(
                leaves,
                &[Some(netd), node].into_iter().flatten().collect::<Vec<_>>(),
                &mut refused,
            );
        }
        if let Some(node) = node {
            renice_children(node, &mut reniced);
        }
    }
}

// One pid per write, as cgroup.procs takes them; a process that exits mid-move (ESRCH) is no loss. Any other refusal
// leaves it in the daemon's leaf every tick after, so it is said once per pid rather than retried in silence.
fn move_strays(leaves: &Leaves, keep: &[u32], refused: &mut HashSet<u32>) {
    let Ok(procs) = std::fs::read_to_string(&leaves.daemon) else {
        return;
    };
    let found = strays(&procs, keep);
    refused.retain(|pid| found.contains(pid));
    for pid in found {
        if let Err(error) = std::fs::write(&leaves.workload, pid.to_string())
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
}
