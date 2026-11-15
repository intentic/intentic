//! A CEILING ON FILE SYNC, WHATEVER THE TREE HOLDS (2026-11-15). Mutagen's agent is how a device's folder sync reads and
//! writes this sandbox: the device's Mutagen starts it here through `docker exec` or the sandbox's sshd, so it lands in
//! the `workload` leaf at the daemon's own nice 0, outside everything the daemon classes as it spawns. On rog, after a
//! swap gave a sandbox a fresh container, its agent hashed every file of the state backup again: 77 GB of artifacts at
//! about 534 MB/s, 166 GB read in some ten minutes, the VM's IO pressure `full` near 20% throughout, and the owner's
//! whole PC stuttering with two sandboxes that were doing nothing. A scan's cost follows what the tree holds, and no
//! ignore list can promise what an agent will write next, so the bound is put on the process instead.
//!
//! Every Mutagen agent goes to a `sync` leaf of its own, beside the entrypoint's `daemon` and `workload`, with every
//! thread at nice 19. The leaf reads and writes at most 64 MiB/s on each block device holding `/work` or `/history`
//! (`io.max`), runs on half a core at most (`cpu.max`), and weighs 20 against everything else's 100 where the kernel
//! weighs cpu and io at all. `io.max` is the one IO bound that holds everywhere: WSL's disks run the `none` scheduler,
//! where ionice and `io.weight` do nothing, since both need BFQ or iocost. A hashed scan of a large tree then takes
//! longer and costs the machine little; an ordinary scan, which only `stat`s what its cache already knows, never comes
//! near the bound. The leaf's settings are written again every minute, as the daemon's are (daemon-cgroup.ts), so a
//! write refused at boot is tried again, and said once per file.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::cgroup::{Leaves, cgroup_of, lower_to};

/// The leaf's name, beside the entrypoint's `daemon` and `workload`.
pub const SYNC_LEAF: &str = "sync";
/// What `/proc/<pid>/comm` reads for Mutagen's agent, under ssh and docker alike.
pub const AGENT_COMM: &str = "mutagen-agent";
/// The niceness every thread of the agent runs at.
pub const SYNC_NICE: i32 = 19;
/// Bytes a second the leaf may read, and write, on each device holding the synced folders.
pub const SYNC_BYTES_PER_SECOND: u64 = 64 * 1024 * 1024;
/// Half a core: 50 ms of every 100 ms.
pub const SYNC_CPU_MAX: &str = "50000 100000";
const SYNC_CPU_WEIGHT: &str = "20";
const SYNC_IO_WEIGHT: &str = "default 20";
/// The mounts whose devices the leaf is bounded on: the workspace and the history volume, where Mutagen keeps its cache.
pub const SYNCED_MOUNTS: [&str; 2] = ["/work", "/history"];

/// How often agents are looked for: one started between two looks reads at most this long uncapped.
const LOOK: Duration = Duration::from_secs(2);
/// Looks between two writes of the leaf's settings: a minute.
const SETTLE_EVERY: u32 = 30;

/// The distinct block devices (`major:minor`) the given mount points sit on, read from `/proc/self/mountinfo` (field 3
/// is the device, field 5 the mount point). A mount point mounted more than once counts as its last line, the mount
/// that shows. Major 0 is no block device (overlay, tmpfs, a bind of one), which `io.max` refuses, so it is left out.
pub fn devices_of(mountinfo: &str, mounts: &[&str]) -> Vec<String> {
    let mut device_of: Vec<(&str, &str)> = Vec::new();
    for line in mountinfo.lines() {
        let mut fields = line.split_whitespace();
        let (Some(device), Some(point)) = (fields.nth(2), fields.nth(1)) else {
            continue;
        };
        if mounts.contains(&point) {
            device_of.retain(|(seen, _)| *seen != point);
            device_of.push((point, device));
        }
    }
    let mut devices: Vec<String> = Vec::new();
    for mount in mounts {
        let Some((_, device)) = device_of.iter().find(|(point, _)| point == mount) else {
            continue;
        };
        let block = device.split_once(':').is_some_and(|(major, minor)| {
            major != "0" && major.parse::<u32>().is_ok() && minor.parse::<u32>().is_ok()
        });
        if block && !devices.iter().any(|seen| seen == device) {
            devices.push((*device).to_owned());
        }
    }
    devices
}

/// The `io.max` line that bounds one device: both directions at the sync rate.
pub fn io_max_line(device: &str) -> String {
    format!("{device} rbps={SYNC_BYTES_PER_SECOND} wbps={SYNC_BYTES_PER_SECOND}")
}

/// Whether `io.max` as it reads back already bounds `device` as `io_max_line` asks. The kernel lists a bounded device
/// with all four keys (`8:64 rbps=… wbps=… riops=max wiops=max`) and leaves an unbounded one out.
pub fn io_max_holds(current: &str, device: &str) -> bool {
    let rate = SYNC_BYTES_PER_SECOND.to_string();
    current.lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields.next() == Some(device) && {
            let keys: Vec<&str> = fields.collect();
            keys.contains(&format!("rbps={rate}").as_str())
                && keys.contains(&format!("wbps={rate}").as_str())
        }
    })
}

/// The sync leaf as `/proc/<pid>/cgroup` names it: the daemon leaf's sibling (`/daemon` → `/sync`).
pub fn sync_path_of(daemon_path: &str) -> Option<String> {
    daemon_path
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/{SYNC_LEAF}"))
}

// A cgroup file's value as written: its first line, trimmed (io.weight lists per-device overrides after the default).
fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("").trim()
}

struct Cap {
    dir: PathBuf,
    path: String,
    // Files whose write was refused, said once until one goes through.
    refused: HashSet<String>,
    // Agents already moved and lowered; kept to the ones still running.
    capped: HashSet<u32>,
    // Agents whose move was refused, said once each.
    unmoved: HashSet<u32>,
}

impl Cap {
    fn write(&mut self, file: &str, value: &str) {
        let path = self.dir.join(file);
        match std::fs::write(&path, value) {
            Ok(()) => {
                self.refused.remove(file);
            }
            Err(error) => {
                if self.refused.insert(file.to_owned()) {
                    tracing::warn!(%error, file, value, "file sync's cgroup leaf: a bound was refused, so sync runs without it");
                }
            }
        }
    }

    // Each setting read, and written where it differs. A file this kernel lacks (io.weight without iocost or BFQ) is
    // nothing to keep.
    fn settle(&mut self) {
        if let Err(error) = std::fs::create_dir_all(&self.dir)
            && self.refused.insert("mkdir".to_owned())
        {
            tracing::warn!(%error, dir = %self.dir.display(), "file sync's cgroup leaf could not be made: Mutagen's agent runs unbounded");
            return;
        }
        for (file, value) in [
            ("cpu.max", SYNC_CPU_MAX),
            ("cpu.weight", SYNC_CPU_WEIGHT),
            ("io.weight", SYNC_IO_WEIGHT),
        ] {
            let Ok(current) = std::fs::read_to_string(self.dir.join(file)) else {
                continue;
            };
            if first_line(&current) != value {
                self.write(file, value);
            }
        }
        let Ok(current) = std::fs::read_to_string(self.dir.join("io.max")) else {
            return;
        };
        let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
        for device in devices_of(&mountinfo, &SYNCED_MOUNTS) {
            if !io_max_holds(&current, &device) {
                self.write("io.max", &io_max_line(&device));
            }
        }
    }

    // Every running agent into the leaf and down to SYNC_NICE. A process that exits mid-move (ESRCH) is no loss.
    fn take_agents(&mut self) {
        let agents = running_agents();
        self.capped.retain(|pid| agents.contains(pid));
        self.unmoved.retain(|pid| agents.contains(pid));
        let procs = self.dir.join("cgroup.procs");
        for pid in agents {
            let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/cgroup")) else {
                continue;
            };
            if cgroup_of(&text) != Some(self.path.as_str()) {
                match std::fs::write(&procs, pid.to_string()) {
                    Ok(()) => {}
                    Err(error) if error.raw_os_error() == Some(libc::ESRCH) => continue,
                    Err(error) => {
                        if self.unmoved.insert(pid) {
                            tracing::warn!(%error, pid, "Mutagen's agent stays outside file sync's cgroup leaf: moving it was refused");
                        }
                    }
                }
            }
            if !self.capped.contains(&pid) && lower_to(pid, SYNC_NICE) {
                self.capped.insert(pid);
            }
        }
    }
}

fn running_agents() -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .is_ok_and(|comm| comm.trim_end() == AGENT_COMM)
        })
        .collect()
}

/// Keeps the sync leaf bounded and every Mutagen agent in it, for as long as netd runs. Only the container's own netd,
/// in the entrypoint's daemon leaf, runs it (main.rs).
pub async fn govern(leaves: Leaves) {
    let Some(path) = sync_path_of(&leaves.daemon_path) else {
        return;
    };
    let mut cap = Cap {
        dir: sync_dir(leaves.container()),
        path,
        refused: HashSet::new(),
        capped: HashSet::new(),
        unmoved: HashSet::new(),
    };
    let mut tick = tokio::time::interval(LOOK);
    let mut looks: u32 = 0;
    loop {
        tick.tick().await;
        if looks.is_multiple_of(SETTLE_EVERY) {
            cap.settle();
        }
        looks = looks.wrapping_add(1);
        if cap.dir.join("cgroup.procs").exists() {
            cap.take_agents();
        }
    }
}

fn sync_dir(container: &Path) -> PathBuf {
    container.join(SYNC_LEAF)
}

#[cfg(test)]
mod tests {
    use super::*;

    // As read inside a sandbox on rog, 2026-11-15: the workspace and history volumes on the VM's data disk, the root an
    // overlay.
    const MOUNTINFO: &str = "\
1203 1150 0:180 / / rw,relatime master:612 - overlay overlay rw,lowerdir=/x
1210 1203 8:64 /docker/volumes/intentic-history-sandbox-a4ba63bf2aa5/_data /history rw,relatime - ext4 /dev/sde rw,discard
1211 1203 8:64 /docker/volumes/intentic-workspace-sandbox-a4ba63bf2aa5/_data /work rw,relatime - ext4 /dev/sde rw,discard
1212 1203 0:190 / /dev rw,nosuid - tmpfs tmpfs rw
";

    #[test]
    fn one_device_holding_both_volumes_is_bounded_once() {
        assert_eq!(devices_of(MOUNTINFO, &SYNCED_MOUNTS), vec!["8:64"]);
    }

    #[test]
    fn each_device_is_bounded_in_the_order_the_mounts_are_named() {
        let mountinfo = "\
1 0 8:16 / /history rw - ext4 /dev/sdb rw
2 0 259:3 / /work rw - ext4 /dev/nvme0n1p3 rw
";
        assert_eq!(devices_of(mountinfo, &SYNCED_MOUNTS), vec!["259:3", "8:16"]);
    }

    #[test]
    fn no_block_device_is_nothing_to_bound() {
        let mountinfo = "\
1 0 0:45 / /work rw - overlay overlay rw
2 0 0:46 / /history rw - tmpfs tmpfs rw
";
        assert!(devices_of(mountinfo, &SYNCED_MOUNTS).is_empty());
        assert!(devices_of("", &SYNCED_MOUNTS).is_empty());
        assert!(devices_of("garbage line\n", &SYNCED_MOUNTS).is_empty());
    }

    #[test]
    fn a_mount_point_mounted_twice_is_its_last_mount() {
        let mountinfo = "\
1 0 8:1 / /work rw - ext4 /dev/sda1 rw
2 1 8:32 / /work rw - ext4 /dev/sdc rw
";
        assert_eq!(devices_of(mountinfo, &["/work"]), vec!["8:32"]);
    }

    #[test]
    fn a_mount_below_a_synced_one_is_not_it() {
        assert!(
            devices_of(
                "1 0 8:1 / /work/sub rw - ext4 /dev/sda1 rw\n",
                &SYNCED_MOUNTS
            )
            .is_empty()
        );
    }

    #[test]
    fn the_bound_is_both_directions_at_the_sync_rate() {
        assert_eq!(io_max_line("8:64"), "8:64 rbps=67108864 wbps=67108864");
    }

    #[test]
    fn a_bound_holds_only_as_written_for_its_own_device() {
        let bounded = "8:64 rbps=67108864 wbps=67108864 riops=max wiops=max\n";
        assert!(io_max_holds(bounded, "8:64"));
        assert!(!io_max_holds(bounded, "8:6"));
        assert!(!io_max_holds("", "8:64"));
        assert!(!io_max_holds(
            "8:64 rbps=1048576 wbps=67108864 riops=max wiops=max\n",
            "8:64"
        ));
        assert!(!io_max_holds(
            "8:64 rbps=67108864 wbps=max riops=max wiops=max\n",
            "8:64"
        ));
    }

    #[test]
    fn the_leaf_is_the_daemon_leafs_sibling() {
        assert_eq!(sync_path_of("/daemon").as_deref(), Some("/sync"));
        assert_eq!(
            sync_path_of("/docker/abc/daemon").as_deref(),
            Some("/docker/abc/sync")
        );
        assert_eq!(sync_path_of("daemon"), None);
    }

    #[test]
    fn a_setting_reads_as_its_first_line() {
        assert_eq!(first_line("default 20\n8:64 100\n"), "default 20");
        assert_eq!(first_line("50000 100000\n"), "50000 100000");
        assert_eq!(first_line(""), "");
    }

    #[test]
    fn this_process_is_no_agent() {
        assert!(!running_agents().contains(&std::process::id()));
    }
}
