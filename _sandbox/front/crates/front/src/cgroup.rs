//! Keeps the entrypoint's `daemon` cgroup leaf (no swap, top cpu/io weight) to the front and Node alone: anything else
//! that lands there by inheritance moves to the sibling `workload` leaf, and Node's children run at nice 10.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::sync::watch;

const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const POLL: Duration = Duration::from_millis(250);
const WORKLOAD_NICE: i32 = 10;

/// The front's cgroup from `/proc/self/cgroup`, when it is the entrypoint's `daemon` leaf.
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
    let front = std::process::id();
    let mut reniced: HashSet<u32> = HashSet::new();
    let mut tick = tokio::time::interval(POLL);
    loop {
        tick.tick().await;
        let node = *node.borrow();
        if let Some(leaves) = &leaves {
            move_strays(
                leaves,
                &[Some(front), node]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>(),
            );
        }
        if let Some(node) = node {
            renice_children(node, &mut reniced);
        }
    }
}

// One pid per write, as cgroup.procs takes them; a process that exits mid-move is no loss.
fn move_strays(leaves: &Leaves, keep: &[u32]) {
    let Ok(procs) = std::fs::read_to_string(&leaves.daemon) else {
        return;
    };
    for pid in strays(&procs, keep) {
        let _ = std::fs::write(&leaves.workload, pid.to_string());
    }
}

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
        if !reniced.contains(&pid)
            && unsafe { libc::setpriority(libc::PRIO_PROCESS, pid, WORKLOAD_NICE) } == 0
        {
            reniced.insert(pid);
        }
    }
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
    fn everything_but_the_kept_pids_is_a_stray() {
        assert_eq!(strays("1\n42\n43\n", &[1, 42]), vec![43]);
        assert_eq!(strays("", &[1]), Vec::<u32>::new());
    }
}
