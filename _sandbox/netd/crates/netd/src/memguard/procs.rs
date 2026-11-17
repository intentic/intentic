//! The process table as the memory guard reads it, and the one kill it makes. Cheap reads first: a process's `stat`,
//! `status`, `oom_score`, `oom_score_adj` and `cgroup` come from the kernel's own bookkeeping, while `cmdline` and `environ` are read out of the
//! process's memory, which under the thrash the guard is for may sit in swap. So the whole table is judged on the cheap
//! five, and only the few processes a record names are read for their command line and owner, off the guard's thread
//! and with a deadline (`read_memory`).

use std::os::fd::{FromRawFd, OwnedFd};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use crate::cgroup::cgroup_of;

pub const PROC: &str = "/proc";

// The kernel's flag for a thread of its own (include/linux/sched.h): no memory of its own to free.
const PF_KTHREAD: u64 = 0x0020_0000;

// How much of a command line a record keeps (MemoryKillSchema's `argv`).
const ARGV_CHARS: usize = 300;

// The environment variable the daemon stamps on everything it starts for someone (src/seams/workload-stamp.ts): whose
// it was.
const OWNER_ENV: &str = "INTENTIC_TURN_OWNER";

// How long the guard waits for a command line and an owner read out of a process's memory before it goes on without
// them: a kill waits for nothing it can do without.
const PATIENCE: Duration = Duration::from_secs(2);

/// One process as the guard judges it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub pgid: u32,
    // When it started, in clock ticks since boot: with the pid, what tells it from a later process given the same pid.
    pub starttime: u64,
    // A kernel thread, a zombie or a process past its exit: nothing a kill would free.
    pub inert: bool,
    pub oom_score: u32,
    // The tier the daemon stamped on it (src/workload/workload-class.ts): an agent's command 600, a build 800.
    pub oom_score_adj: i32,
    // Its resident memory and swap together (`VmRSS` + `VmSwap`): what killing it would free.
    pub bytes: u64,
    pub cgroup: String,
}

/// What a `/proc/<pid>/stat` line says that the guard needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stat {
    pub state: char,
    pub pgid: u32,
    pub flags: u64,
    pub starttime: u64,
}

/// The fields of a `/proc/<pid>/stat` line, counted after the `)` that closes the command name, which may itself hold
/// spaces and parentheses: state (3), group (5), flags (9) and start time (22).
pub fn parse_stat(stat: &str) -> Option<Stat> {
    let rest: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    Some(Stat {
        state: rest.first()?.chars().next()?,
        pgid: rest.get(2)?.parse().ok()?,
        flags: rest.get(6)?.parse().ok()?,
        starttime: rest.get(19)?.parse().ok()?,
    })
}

/// What the guard never kills, however high it scores.
pub struct Spared<'a> {
    pub netd: u32,
    pub node: Option<u32>,
    /// The daemon leaf as `/proc/<pid>/cgroup` names it: everything in it is netd's or the daemon's.
    pub daemon: &'a str,
}

/// Whether the guard may kill `proc`: never pid 1 (the container's init), netd, Node (wherever it runs: until govern
/// moves it back, Node may be found in `workload`), anything in the daemon leaf, nor a process the kill would free
/// nothing of. An `oom_score` of 0 is one the kernel itself would never pick: `oom_score_adj` -1000, or no memory at all.
/// Anything else may die, whatever cgroup it is in: a process in a Docker container the sandbox runs itself
/// (`/docker/<id>`, outside both leaves) is as much the sandbox's runaway as one in `workload`.
pub fn killable(proc: &Proc, spared: &Spared) -> bool {
    proc.pid != 1
        && proc.pid != spared.netd
        && Some(proc.pid) != spared.node
        && !proc.inert
        && proc.oom_score > 0
        && !within(&proc.cgroup, spared.daemon)
}

// The cgroup itself or one below it.
fn within(cgroup: &str, leaf: &str) -> bool {
    cgroup
        .strip_prefix(leaf)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// The killable processes, the one whose kill frees the most first: its resident memory and swap, weighed up by its
/// tier (`oom_score_adj`: an agent's command 600, a build 800, a runtime 100 and up), so between two of about one size
/// the build goes first, but never a small build before a big command. A tie goes to the later pid.
///
/// 2026-11-17, the shinobi-society audit: this was the kernel's own `oom_score`, which adds the tier to a process's share
/// of all memory in thousandths. A tier 200 points up outweighs 20% of the box, so a 20 KB `sccache` under cargo (800)
/// outranked a 9.9 GB `bake.py` (600): six sccache kills in one burst, a 60 MB thread killed while the 9.9 GB process
/// ran on, and the same job killed three times, each kill freeing nothing.
pub fn ranked(procs: Vec<Proc>, spared: &Spared) -> Vec<Proc> {
    let mut ranked: Vec<Proc> = procs
        .into_iter()
        .filter(|proc| killable(proc, spared))
        .collect();
    ranked.sort_unstable_by_key(|proc| std::cmp::Reverse((weight(proc), proc.pid)));
    ranked
}

// Its size times (1000 + tier) / 1000: a build (800) weighs 1.8 times its size, a command (600) 1.6, a runtime (100)
// 1.1. The tier is clamped to the kernel's range, and a killable process has one above -1000 (its oom_score is not 0).
fn weight(proc: &Proc) -> u128 {
    let tier = u128::from(
        proc.oom_score_adj
            .clamp(-1000, 1000)
            .saturating_add(1000)
            .unsigned_abs(),
    );
    u128::from(proc.bytes) * tier
}

// The least a victim may hold, whatever else there is: a kill that frees less than this frees nothing the guard is for.
const VICTIM_AT_LEAST: u64 = 32 * 1024 * 1024;
// And the share of the sandbox's memory and swap in use that a victim should hold when any process does: under a 20 GB
// thrash, a 60 MB process is not the runaway.
const VICTIM_SHARE_PERCENT: u64 = 2;

/// The process to kill out of `ranked`, with `in_use` the bytes of memory and swap the sandbox holds: the first that
/// holds at least `VICTIM_SHARE_PERCENT` of that (and `VICTIM_AT_LEAST`), else the first that holds `VICTIM_AT_LEAST`,
/// else none: killing a process of a few kilobytes frees nothing, and the leaf's own OOM killer is still there.
pub fn victim(ranked: &[Proc], in_use: Option<u64>) -> Option<&Proc> {
    let share = in_use.unwrap_or(0) / 100 * VICTIM_SHARE_PERCENT;
    let floor = share.max(VICTIM_AT_LEAST);
    ranked
        .iter()
        .find(|proc| proc.bytes >= floor)
        .or_else(|| ranked.iter().find(|proc| proc.bytes >= VICTIM_AT_LEAST))
}

/// What a record says of a process beyond what `scan` read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Detail {
    pub comm: String,
    pub rss_bytes: Option<u64>,
    pub swap_bytes: Option<u64>,
    pub argv: Option<String>,
    pub owner: Option<String>,
}

/// A `/proc/<pid>/status` field in kB (`VmRSS:`, `VmSwap:`), in bytes.
pub fn status_bytes(status: &str, field: &str) -> Option<u64> {
    status
        .lines()
        .find_map(|line| line.strip_prefix(field))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()
        .map(|kib| kib.saturating_mul(1024))
}

/// A command line as `/proc/<pid>/cmdline` holds it (arguments ended by NULs), as one line cut to `ARGV_CHARS`.
pub fn argv_of(cmdline: &[u8]) -> Option<String> {
    let line = String::from_utf8_lossy(cmdline)
        .split('\0')
        .filter(|argument| !argument.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!line.is_empty()).then(|| line.chars().take(ARGV_CHARS).collect())
}

/// The daemon's owner stamp in a `/proc/<pid>/environ` (variables ended by NULs): a conversation id, `daemon` or
/// `one-shot`.
pub fn owner_of(environ: &[u8]) -> Option<String> {
    environ
        .split(|byte| *byte == 0)
        .find_map(|entry| entry.strip_prefix(OWNER_ENV.as_bytes())?.strip_prefix(b"="))
        .map(|owner| String::from_utf8_lossy(owner).into_owned())
        .filter(|owner| !owner.is_empty())
}

/// The process table under a procfs root: `/proc`, or a test's fake one.
pub struct Procs {
    root: PathBuf,
    // Set while a reader `read_memory` started has not come back: the next one goes without rather than stacking another
    // thread behind a process whose memory will not page in.
    reading: Arc<AtomicBool>,
}

impl Procs {
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            reading: Arc::default(),
        }
    }

    /// Every process the table lists that can be read whole; one gone mid-read is simply not there.
    pub fn scan(&self) -> Vec<Proc> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(|pid| self.read(pid))
            .collect()
    }

    fn read(&self, pid: u32) -> Option<Proc> {
        let dir = self.root.join(pid.to_string());
        let stat = parse_stat(&std::fs::read_to_string(dir.join("stat")).ok()?)?;
        let oom_score = std::fs::read_to_string(dir.join("oom_score"))
            .ok()?
            .trim()
            .parse()
            .ok()?;
        let cgroup = cgroup_of(&std::fs::read_to_string(dir.join("cgroup")).ok()?)?.to_owned();
        // A kernel thread's status has no VmRSS: it holds nothing a kill would free. An unreadable tier is the daemon's
        // default, 0.
        let status = std::fs::read_to_string(dir.join("status")).unwrap_or_default();
        let oom_score_adj = std::fs::read_to_string(dir.join("oom_score_adj"))
            .ok()
            .and_then(|adj| adj.trim().parse().ok())
            .unwrap_or(0);
        Some(Proc {
            pid,
            pgid: stat.pgid,
            starttime: stat.starttime,
            inert: stat.flags & PF_KTHREAD != 0 || matches!(stat.state, 'Z' | 'X' | 'x'),
            oom_score,
            oom_score_adj,
            bytes: status_bytes(&status, "VmRSS:")
                .unwrap_or(0)
                .saturating_add(status_bytes(&status, "VmSwap:").unwrap_or(0)),
            cgroup,
        })
    }

    /// What a record says of each of `pids`: the cheap reads here, the command line (when `argv`) and owner from memory.
    pub fn details(&self, pids: &[u32], argv: bool) -> Vec<Detail> {
        let mut remembered = self.read_memory(pids, argv).into_iter();
        pids.iter()
            .map(|pid| {
                let dir = self.root.join(pid.to_string());
                let status = std::fs::read_to_string(dir.join("status")).unwrap_or_default();
                let (argv, owner) = remembered.next().unwrap_or_default();
                Detail {
                    comm: std::fs::read_to_string(dir.join("comm"))
                        .map(|comm| comm.trim_end().to_owned())
                        .unwrap_or_default(),
                    rss_bytes: status_bytes(&status, "VmRSS:"),
                    swap_bytes: status_bytes(&status, "VmSwap:"),
                    argv,
                    owner,
                }
            })
            .collect()
    }

    // Each pid's command line (when `argv`) and owner, read on a thread of its own that the guard waits `PATIENCE` for.
    // Reading them takes the process's memory lock and faults in whatever of its arguments and environment is in swap,
    // and under a thrash either can take seconds; the guard does not wait that long to kill. A reader that outlives its
    // patience finishes by itself (its process's memory is freed by the kill, or comes back), and the records meanwhile
    // go without these two fields.
    fn read_memory(&self, pids: &[u32], argv: bool) -> Vec<(Option<String>, Option<String>)> {
        if pids.is_empty() || self.reading.swap(true, Ordering::AcqRel) {
            return Vec::new();
        }
        let (sender, received) = mpsc::channel();
        let root = self.root.clone();
        let reading = self.reading.clone();
        let pids = pids.to_vec();
        let started = std::thread::Builder::new()
            .name("netd-memguard-read".into())
            .spawn(move || {
                let read = pids
                    .iter()
                    .map(|pid| {
                        let dir = root.join(pid.to_string());
                        let argv = argv
                            .then(|| std::fs::read(dir.join("cmdline")).ok())
                            .flatten()
                            .and_then(|cmdline| argv_of(&cmdline));
                        let owner = std::fs::read(dir.join("environ"))
                            .ok()
                            .and_then(|environ| owner_of(&environ));
                        (argv, owner)
                    })
                    .collect::<Vec<_>>();
                reading.store(false, Ordering::Release);
                let _ = sender.send(read);
            });
        if started.is_err() {
            self.reading.store(false, Ordering::Release);
            return Vec::new();
        }
        received.recv_timeout(PATIENCE).unwrap_or_default()
    }

    /// SIGKILLs `victim` alone, never its group: whatever started it (a job's shell) reports it gone as for any other
    /// death. The process is pinned first (a pidfd), checked to be the one scanned (its start time), and only then read
    /// for its record and signalled through the pin, so a pid that changed hands since the scan is never a kill of the
    /// new one.
    pub fn kill(&self, victim: &Proc) -> Kill {
        let pin = pidfd_open(victim.pid);
        if let Err(error) = &pin
            && error.raw_os_error() != Some(libc::ENOSYS)
        {
            return Kill::Gone;
        }
        let same = std::fs::read_to_string(self.root.join(victim.pid.to_string()).join("stat"))
            .ok()
            .and_then(|stat| parse_stat(&stat))
            .is_some_and(|stat| stat.starttime == victim.starttime);
        if !same {
            return Kill::Gone;
        }
        let detail = self.details(&[victim.pid], true).pop().unwrap_or_default();
        let sent = match &pin {
            Ok(pin) => pidfd_kill(pin),
            // A kernel before 5.3 has no pidfd: the plain kill, right after the check.
            Err(_) => plain_kill(victim.pid),
        };
        match sent {
            Ok(()) => Kill::Done(detail),
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Kill::Gone,
            Err(error) => Kill::Refused(error),
        }
    }
}

/// How a kill ended.
#[derive(Debug)]
pub enum Kill {
    /// Killed, with what it was the moment before.
    Done(Detail),
    /// It had ended by itself, or its pid is another process's by now: nothing was killed.
    Gone,
    /// The kernel refused.
    Refused(std::io::Error),
}

fn pidfd_open(pid: u32) -> std::io::Result<OwnedFd> {
    let pid =
        libc::pid_t::try_from(pid).map_err(|_| std::io::Error::from_raw_os_error(libc::ESRCH))?;
    // SAFETY: pidfd_open takes a pid and flags and returns a new descriptor this function then owns, or -1.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let fd = i32::try_from(fd).map_err(|_| std::io::Error::from_raw_os_error(libc::EBADF))?;
    // SAFETY: the kernel just handed this descriptor over, and nothing else holds it.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn pidfd_kill(pin: &OwnedFd) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: a signal through a descriptor this process holds open, with no siginfo and no flags.
    let sent = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pin.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if sent == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn plain_kill(pid: u32) -> std::io::Result<()> {
    let pid =
        libc::pid_t::try_from(pid).map_err(|_| std::io::Error::from_raw_os_error(libc::ESRCH))?;
    // SAFETY: kill takes no pointers; a pid gone since answers ESRCH.
    if unsafe { libc::kill(pid, libc::SIGKILL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    const MIB: u64 = 1024 * 1024;

    // A process of `oom_score` MiB in the daemon's tier, so its size orders it as its score would.
    fn proc(pid: u32, oom_score: u32, cgroup: &str) -> Proc {
        Proc {
            pid,
            pgid: pid,
            starttime: 100,
            inert: false,
            oom_score,
            oom_score_adj: 0,
            bytes: u64::from(oom_score) * MIB,
            cgroup: cgroup.into(),
        }
    }

    fn sized(pid: u32, mib: u64, oom_score_adj: i32) -> Proc {
        Proc {
            oom_score_adj,
            bytes: mib * MIB,
            ..proc(pid, 900, "/workload")
        }
    }

    const SPARED: Spared = Spared {
        netd: 7,
        node: Some(64),
        daemon: "/daemon",
    };

    #[test]
    fn the_stat_line_is_read_after_the_command_name() {
        let stat =
            "4242 (a (b) c) S 7 4200 4200 0 -1 4194560 100 0 0 0 5 3 0 0 20 10 1 0 123456 4096 25";
        assert_eq!(
            parse_stat(stat),
            Some(Stat {
                state: 'S',
                pgid: 4200,
                flags: 4_194_560,
                starttime: 123_456,
            })
        );
        assert_eq!(parse_stat("4242 (short) S 7 4200"), None);
    }

    // The guard's whole choice, over plain data: what it may never touch, then the largest.
    #[test]
    fn the_largest_goes_first_outside_the_daemons_leaf() {
        let procs = vec![
            proc(1, 2000, "/workload"),
            proc(7, 1999, "/daemon"),
            proc(64, 1998, "/workload"),
            proc(70, 1997, "/daemon"),
            proc(71, 1996, "/daemon/inner"),
            Proc {
                inert: true,
                ..proc(80, 1995, "/workload")
            },
            proc(81, 0, "/workload"),
            proc(300, 900, "/workload"),
            proc(301, 1400, "/docker/abc"),
            proc(302, 1400, "/workload"),
            proc(303, 1500, "/daemons"),
        ];
        let ranked: Vec<u32> = ranked(procs, &SPARED).iter().map(|proc| proc.pid).collect();
        assert_eq!(
            ranked,
            vec![303, 302, 301, 300],
            "pid 1, netd, Node outside its leaf, the leaf and below it, a kernel thread and a score of 0 are spared; \
             a tie goes to the later pid; a leaf named like the daemon's is not it; an inner Docker container's \
             process is one to kill"
        );
        assert!(
            ranked_of(vec![proc(7, 2000, "/workload")]).is_empty(),
            "netd is spared wherever it is"
        );
    }

    fn ranked_of(procs: Vec<Proc>) -> Vec<Proc> {
        ranked(procs, &SPARED)
    }

    fn victim_of(procs: Vec<Proc>, in_use_mib: u64) -> Option<u32> {
        victim(&ranked_of(procs), Some(in_use_mib * MIB)).map(|proc| proc.pid)
    }

    // 2026-11-17, the shinobi-society audit: the kernel's score put a 20 KB sccache in the build tier ahead of a 9.9 GB
    // command, and the guard killed sccache after sccache.
    #[test]
    fn the_victim_is_the_process_whose_kill_frees_the_most() {
        let sccache = sized(400, 0, 800);
        let thread = sized(401, 60, 800);
        let bake = sized(402, 9_900, 600);
        assert_eq!(
            victim_of(vec![sccache.clone(), thread.clone(), bake.clone()], 20_000),
            Some(402),
            "the 9.9 GB command, not the build's 20 KB helper or 60 MB thread"
        );
        assert_eq!(
            ranked_of(vec![sized(500, 1_000, 600), sized(501, 1_000, 800)])
                .first()
                .map(|proc| proc.pid),
            Some(501),
            "of two of one size, the higher tier goes first"
        );
        assert_eq!(
            ranked_of(vec![sized(502, 1_000, 600), sized(503, 600, 800)])
                .first()
                .map(|proc| proc.pid),
            Some(502),
            "a tier weighs a size up, it does not outrank a bigger process"
        );
        assert_eq!(
            victim_of(vec![sccache.clone(), thread.clone()], 20_000),
            Some(401),
            "with nothing near 2% of what is in use, the largest above the 32 MiB floor"
        );
        assert_eq!(
            victim_of(vec![sccache, sized(404, 31, 800)], 20_000),
            None,
            "a kill that frees a few kilobytes is no kill"
        );
        assert_eq!(
            victim(&ranked_of(vec![thread]), None).map(|proc| proc.pid),
            Some(401),
            "an unread cgroup leaves the absolute floor"
        );
    }

    #[test]
    fn a_command_line_is_one_line_cut_to_three_hundred_characters() {
        assert_eq!(
            argv_of(b"node\0--max-old-space-size=3072\0main.js\0"),
            Some("node --max-old-space-size=3072 main.js".into())
        );
        assert_eq!(argv_of(b""), None, "a kernel thread's");
        let long = format!("cc\0{}\0", "é".repeat(400));
        let cut = argv_of(long.as_bytes()).unwrap();
        assert_eq!(cut.chars().count(), 300);
        assert!(cut.starts_with("cc é"));
    }

    #[test]
    fn the_owner_is_the_daemons_stamp() {
        assert_eq!(
            owner_of(b"PATH=/bin\0INTENTIC_TURN_OWNER=brisk-ridge-27nl\0HOME=/root\0"),
            Some("brisk-ridge-27nl".into())
        );
        assert_eq!(owner_of(b"INTENTIC_TURN_OWNER_X=1\0"), None);
        assert_eq!(owner_of(b"INTENTIC_TURN_OWNER=\0"), None);
        assert_eq!(owner_of(b""), None);
    }

    #[test]
    fn memory_is_read_off_the_status_in_bytes() {
        let status = "Name:\tnode\nVmRSS:\t 17600000 kB\nVmSwap:\t      12 kB\n";
        assert_eq!(status_bytes(status, "VmRSS:"), Some(17_600_000 * 1024));
        assert_eq!(status_bytes(status, "VmSwap:"), Some(12 * 1024));
        assert_eq!(status_bytes("Name:\tkthreadd\n", "VmRSS:"), None);
    }

    // A whole table of fakes, laid out as procfs lays it out: what scan reads and what a record says.
    #[test]
    fn the_table_and_a_records_detail_are_read_as_procfs_lays_them_out() {
        let root = std::env::temp_dir().join(format!("netd-memguard-proc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let write = |pid: &str, file: &str, text: &[u8]| {
            std::fs::create_dir_all(root.join(pid)).unwrap();
            std::fs::write(root.join(pid).join(file), text).unwrap();
        };
        write(
            "300",
            "stat",
            b"300 (cc1plus) R 250 250 1 0 -1 4194304 0 0 0 0 0 0 0 0 30 10 1 0 777 0 0",
        );
        write("300", "oom_score", b"1650\n");
        write("300", "oom_score_adj", b"800\n");
        write("300", "cgroup", b"0::/workload\n");
        write("300", "comm", b"cc1plus\n");
        write(
            "300",
            "status",
            b"Name:\tcc1plus\nVmRSS:\t2048 kB\nVmSwap:\t1024 kB\n",
        );
        write("300", "cmdline", b"cc1plus\0-O2\0big.cc\0");
        write("300", "environ", b"INTENTIC_TURN_OWNER=calm-arrow-4pe9\0");
        write(
            "2",
            "stat",
            b"2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0",
        );
        write("2", "oom_score", b"0\n");
        write("2", "cgroup", b"0::/\n");
        write("9", "stat", b"9 (half) S 1 9");
        write("self", "stat", b"not a pid");

        let table = Procs::at(&root);
        let mut procs = table.scan();
        procs.sort_by_key(|proc| proc.pid);
        assert_eq!(
            procs,
            vec![
                Proc {
                    pid: 2,
                    pgid: 0,
                    starttime: 1,
                    inert: true,
                    oom_score: 0,
                    oom_score_adj: 0,
                    bytes: 0,
                    cgroup: "/".into(),
                },
                Proc {
                    pid: 300,
                    pgid: 250,
                    starttime: 777,
                    inert: false,
                    oom_score: 1650,
                    oom_score_adj: 800,
                    bytes: 3 * MIB,
                    cgroup: "/workload".into(),
                },
            ]
        );
        assert_eq!(
            table.details(&[300], true),
            vec![Detail {
                comm: "cc1plus".into(),
                rss_bytes: Some(2048 * 1024),
                swap_bytes: Some(1024 * 1024),
                argv: Some("cc1plus -O2 big.cc".into()),
                owner: Some("calm-arrow-4pe9".into()),
            }]
        );
        assert_eq!(
            table.details(&[300], false)[0].argv,
            None,
            "a sample names the owner alone"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // The kill on a real process, a child of this test's in a group of its own: pinned, checked, read, killed, and only
    // that process, not the sleep beside it in its group.
    #[test]
    fn the_kill_ends_the_process_scanned_and_only_it() {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 1000 & wait"])
            .env(OWNER_ENV, "netd-test")
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        let table = Procs::at(PROC);
        let sleeper = || {
            table
                .scan()
                .into_iter()
                .find(|proc| proc.pgid == pid && proc.pid != pid && !proc.inert)
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut asleep = sleeper();
        while asleep.is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
            asleep = sleeper();
        }
        let asleep = asleep.expect("the shell started its sleep");
        let scanned = table.read(pid).expect("the shell is in the table");

        let other = Proc {
            starttime: scanned.starttime + 1,
            ..scanned.clone()
        };
        assert!(
            matches!(table.kill(&other), Kill::Gone),
            "a process started at another time is another process"
        );

        let Kill::Done(detail) = table.kill(&scanned) else {
            panic!("the shell was killed");
        };
        assert_eq!(detail.comm, "sh");
        assert_eq!(detail.owner.as_deref(), Some("netd-test"));
        assert!(detail.argv.unwrap().starts_with("sh -c sleep 1000"));
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
        assert!(
            matches!(table.kill(&scanned), Kill::Gone),
            "gone once killed"
        );

        // Its group's other member lives on: the kill was the one process.
        assert_eq!(table.read(asleep.pid).map(|proc| proc.inert), Some(false));
        assert!(matches!(table.kill(&asleep), Kill::Done(_)));
    }
}
