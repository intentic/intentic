//! netd's memory guard: the last word on a runaway, from the one process that stays responsive while the sandbox
//! thrashes. On 2026-11-05 one process an agent started grew to 17.6 GB of RSS and 33 GB of swap (the container's swap
//! was unbounded), the WSL VM thrashed for 1 h 48 m, and the daemon's event loop froze with stalls of up to 145 s: its own
//! resource sampler went silent, and netd, which stayed up and answering throughout, could only kill the frozen daemon
//! and every one it restarted, every three minutes, until the kernel's global OOM killer ended the runaway. So netd
//! watches memory itself, on a thread of its own that needs neither Node nor netd's async runtime:
//!
//! - every second it reads the container's memory pressure and the `workload` leaf's use and bounds, five small files;
//! - when the sandbox has been stalling on memory long enough, or the workload leaf has spent its memory and its swap,
//!   it SIGKILLs the one process the kernel would pick first, outside the daemon's leaf, and writes down what it killed
//!   and why (`memory-kills.jsonl`), so the boot after and the conversation it hurt are told;
//! - while memory is short it writes a sample every ten seconds (`pressure.jsonl`), the trail the daemon's own sampler
//!   cannot leave while its loop is frozen.
//!
//! The bounds on the workload leaf (the entrypoint and the daemon set them) are the first line: the leaf's own OOM
//! killer acts within it, in seconds. The guard is for what those miss: a leaf left unbounded, a thrash on file pages a
//! swap bound does not stop, the sandbox's inner Docker containers. It runs only in the container's own netd, in the
//! entrypoint's daemon leaf (main.rs): it decides what may die by that leaf, and a netd a test or a developer runs must
//! never kill anything of theirs.

mod procs;

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::cgroup::Leaves;
use crate::records::{
    self, Killer, MemoryKill, NETD_KILLS_FILE, NetdKill, PRESSURE_FILE, PressureSample,
    PressureTop, Psi, Records,
};
use procs::{Kill, PROC, Procs, Spared};

// How often the guard reads. Five small cgroup files a second, which the kernel answers from counters.
const POLL: Duration = Duration::from_secs(1);

// THE TRIGGERS. (a) The container's `full` memory pressure, the share of time in which every task in it waited for
// memory at once, at or above 20% over the last ten seconds, for ten seconds on end: the sandbox is not working, it is
// paging. The 2026-11-05 thrash read ~47% for well over an hour; a large build that brushes its bound reads a few
// percent, in bursts. (b) The workload leaf at 95% of a bounded memory.max and 95% of a bounded, non-zero swap.max at
// once, for five seconds: everything it may use is spent, and its own OOM killer is all that is left, which a leaf
// reclaiming file pages can put off for minutes.
const FULL_TRIGGER: f64 = 20.0;
const FULL_HELD: Duration = Duration::from_secs(10);
// Trigger (a) counts only while the pressure is this sandbox's own: its workload, memory and swap together, at or above
// this share of the leaf's memory.max. Every sandbox on a host shares the VM's memory, so when ANOTHER one thrashes the
// VM, this sandbox's tasks stall on memory too and its `full` climbs while its own use is small. On 2026-11-05 the
// sandbox next to the runaway sat at 0.7 of 18 GiB with `full` near 50%: counted, the guard would have killed its
// innocent processes one by one every 25 s for the whole 1 h 48 m, and freed nothing the VM was short of. An unbounded
// leaf (the entrypoint could not write its bounds) gives no share to read, so there the pressure counts as it reads.
const OURS_PERCENT: u64 = 80;
const SPENT_PERCENT: u64 = 95;
const SPENT_HELD: Duration = Duration::from_secs(5);

// After a kill the pressure average still remembers the ten seconds before it, and the kernel needs a moment to free what
// the process held: no second kill for this long, and the trigger then has to hold afresh.
const COOLDOWN: Duration = Duration::from_secs(15);

// THE SAMPLES: while `full` is at or above 10%, or the workload leaf's swap is half spent, one line every ten seconds,
// and one more once it is not. The file moves to `.1` past 5 MB, a few days of continuous samples.
const SAMPLE_FULL: f64 = 10.0;
const SAMPLE_SWAP_PERCENT: u64 = 50;
const SAMPLE_EVERY: Duration = Duration::from_secs(10);
const SAMPLE_TOP: usize = 3;
const PRESSURE_FILE_LIMIT: u64 = 5 * 1024 * 1024;

// THE RESTART HOLD (supervise.rs): a daemon started into a thrash spends minutes paging in its 2,800 modules, misses its
// hello deadline and is killed again, which is what netd did every three minutes on 2026-11-05. After a crash or a kill,
// with `full` at or above 20%, the restart waits until it is below 10%, read every five seconds, for ten minutes at
// most: past that the daemon is better started into whatever is left than not at all.
const HOLD_ABOVE: f64 = 20.0;
const RELEASE_BELOW: f64 = 10.0;
const HOLD_CHECK: Duration = Duration::from_secs(5);
const HOLD_AT_MOST: Duration = Duration::from_secs(10 * 60);

/// The memory pressure in a `memory.pressure` file: `avg10` of its `some` and `full` lines.
pub fn parse_psi(text: &str) -> Option<Psi> {
    let avg10 = |kind: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(kind)?.strip_prefix(' '))?
            .split_whitespace()
            .find_map(|field| field.strip_prefix("avg10="))?
            .parse::<f64>()
            .ok()
            .filter(|share| share.is_finite())
    };
    Some(Psi {
        some_avg10: avg10("some")?,
        full_avg10: avg10("full")?,
    })
}

/// A cgroup's byte count or bound: `max`, no bound, reads as none, as does a file that is not there.
pub fn parse_bytes(text: &str) -> Option<u64> {
    text.trim().parse().ok()
}

fn read_psi(cgroup: &Path) -> Option<Psi> {
    parse_psi(&std::fs::read_to_string(cgroup.join("memory.pressure")).ok()?)
}

fn read_bytes(path: PathBuf) -> Option<u64> {
    parse_bytes(&std::fs::read_to_string(path).ok()?)
}

/// The workload leaf's memory and swap, used and allowed. A bound of none is no bound.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Workload {
    pub memory_current: Option<u64>,
    pub memory_max: Option<u64>,
    pub swap_current: Option<u64>,
    pub swap_max: Option<u64>,
}

impl Workload {
    fn read(leaf: &Path) -> Self {
        Self {
            memory_current: read_bytes(leaf.join("memory.current")),
            memory_max: read_bytes(leaf.join("memory.max")),
            swap_current: read_bytes(leaf.join("memory.swap.current")),
            swap_max: read_bytes(leaf.join("memory.swap.max")),
        }
    }

    // Whether the pressure the container reads is this sandbox's own doing: memory and swap together at or above
    // `OURS_PERCENT` of a bounded memory.max, or a leaf with no bound to measure against.
    fn pressure_is_ours(&self) -> bool {
        match self.memory_max.filter(|max| *max > 0) {
            None => true,
            Some(max) => {
                let used = u128::from(self.memory_current.unwrap_or(0))
                    + u128::from(self.swap_current.unwrap_or(0));
                used * 100 >= u128::from(max) * u128::from(OURS_PERCENT)
            }
        }
    }

    // The leaf's memory, all but spent.
    fn memory_spent(&self) -> bool {
        share_at_least(self.memory_current, self.memory_max, SPENT_PERCENT)
    }

    // A swap bound of 0 is no swap, and "all of none is spent" would make every full page cache a verdict; a leaf
    // without swap meets its own OOM killer instead.
    fn swap_at_least(&self, percent: u64) -> bool {
        share_at_least(self.swap_current, self.swap_max, percent)
    }
}

// `current` at or above `percent` of a bound above zero.
fn share_at_least(current: Option<u64>, max: Option<u64>, percent: u64) -> bool {
    match (current, max.filter(|max| *max > 0)) {
        (Some(current), Some(max)) => {
            u128::from(current) * 100 >= u128::from(max) * u128::from(percent)
        }
        _ => false,
    }
}

/// One look at the sandbox's memory.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Reading {
    pub psi: Option<Psi>,
    pub workload: Workload,
}

impl Reading {
    /// Short enough of memory to keep a trail of.
    pub fn short(&self) -> bool {
        self.psi.is_some_and(|psi| psi.full_avg10 >= SAMPLE_FULL)
            || self.workload.swap_at_least(SAMPLE_SWAP_PERCENT)
    }
}

const MIB: u64 = 1024 * 1024;

fn mib(bytes: Option<u64>) -> u64 {
    bytes.unwrap_or(0) / MIB
}

/// When to kill: each trigger's run of readings that met it, and the cooldown after a kill. Pure over the readings and
/// the clock it is handed, so the rule is tested without a cgroup.
#[derive(Debug, Default)]
pub struct Trigger {
    stalled_since: Option<Instant>,
    spent_since: Option<Instant>,
    resting_until: Option<Instant>,
}

impl Trigger {
    /// The reading at `now`; the reason to kill, when one of the triggers has held long enough. A reading that misses a
    /// trigger ends its run, as does an unreadable one: ten seconds on end means every reading in them.
    pub fn observe(&mut self, now: Instant, reading: &Reading) -> Option<String> {
        if self.resting_until.is_some_and(|until| now < until) {
            self.stalled_since = None;
            self.spent_since = None;
            return None;
        }
        self.resting_until = None;
        let full = reading.psi.map(|psi| psi.full_avg10);
        self.stalled_since = if full.is_some_and(|full| full >= FULL_TRIGGER)
            && reading.workload.pressure_is_ours()
        {
            Some(self.stalled_since.unwrap_or(now))
        } else {
            None
        };
        let workload = &reading.workload;
        self.spent_since = if workload.memory_spent() && workload.swap_at_least(SPENT_PERCENT) {
            Some(self.spent_since.unwrap_or(now))
        } else {
            None
        };
        if let Some(since) = self.stalled_since
            && now.duration_since(since) >= FULL_HELD
        {
            return Some(format!(
                "memory pressure: every task in the sandbox stalled on memory {:.1}% of the last 10 s (full avg10), \
                 at or above {FULL_TRIGGER}% for {} s",
                full.unwrap_or_default(),
                now.duration_since(since).as_secs()
            ));
        }
        if let Some(since) = self.spent_since
            && now.duration_since(since) >= SPENT_HELD
        {
            return Some(format!(
                "the workload's memory is spent: {} of {} MiB in memory and {} of {} MiB of swap, both at or above \
                 {SPENT_PERCENT}% for {} s",
                mib(workload.memory_current),
                mib(workload.memory_max),
                mib(workload.swap_current),
                mib(workload.swap_max),
                now.duration_since(since).as_secs()
            ));
        }
        None
    }

    /// A kill was made, or there was nothing to kill: rest for `COOLDOWN`, then start every run afresh.
    pub fn rest(&mut self, now: Instant) {
        self.stalled_since = None;
        self.spent_since = None;
        self.resting_until = Some(now + COOLDOWN);
    }
}

/// When to write a sample: every `SAMPLE_EVERY` while memory is short, the first at once, and one last when it no longer
/// is.
#[derive(Debug, Default)]
pub struct Sampler {
    last: Option<Instant>,
}

impl Sampler {
    pub fn observe(&mut self, now: Instant, short: bool) -> bool {
        match (short, self.last) {
            (true, Some(last)) if now.duration_since(last) < SAMPLE_EVERY => false,
            (true, _) => {
                self.last = Some(now);
                true
            }
            (false, Some(_)) => {
                self.last = None;
                true
            }
            (false, None) => false,
        }
    }
}

/// Whether a restart is held: `full` at or above `HOLD_ABOVE` now.
pub fn holds_restart(psi: Option<Psi>) -> bool {
    psi.is_some_and(|psi| psi.full_avg10 >= HOLD_ABOVE)
}

/// Whether a held restart keeps waiting, `held` into the hold: until `full` is below `RELEASE_BELOW` (or cannot be read),
/// for `at_most` in all.
pub fn keeps_holding(psi: Option<Psi>, held: Duration, at_most: Duration) -> bool {
    held < at_most && psi.is_some_and(|psi| psi.full_avg10 >= RELEASE_BELOW)
}

/// The sandbox's memory as the supervisor needs it: the pressure over the whole container, whether to hold a restart
/// for it, and where netd's records go.
#[derive(Clone)]
pub struct Container {
    cgroup: PathBuf,
    holds_restarts: bool,
    records: Arc<Records>,
    // `HOLD_CHECK` and `HOLD_AT_MOST`, fields so a test holds a restart for a second rather than minutes.
    pub hold_check: Duration,
    pub hold_at_most: Duration,
}

impl Container {
    /// `cgroup` is the container's (its `memory.pressure` covers everything in the box); `holds_restarts` is whether
    /// this netd is the container's own, the one whose restarts would land in the pressure it reads.
    pub fn new(cgroup: PathBuf, holds_restarts: bool, records: Arc<Records>) -> Self {
        Self {
            cgroup,
            holds_restarts,
            records,
            hold_check: HOLD_CHECK,
            hold_at_most: HOLD_AT_MOST,
        }
    }

    /// A test's: no pressure read, no restart held, nothing written.
    #[cfg(test)]
    pub fn detached() -> Self {
        Self::new(PathBuf::new(), false, Arc::new(Records::nowhere()))
    }

    pub fn psi(&self) -> Option<Psi> {
        read_psi(&self.cgroup)
    }

    pub fn holds_restarts(&self) -> bool {
        self.holds_restarts
    }

    /// Appends what netd did to the daemon to `netd-kills.jsonl`.
    pub fn record(&self, line: &NetdKill) {
        self.records.append(NETD_KILLS_FILE, line);
    }
}

/// Starts the guard on a thread of its own, for as long as netd runs. `node` is the daemon's pid as the supervisor
/// publishes it, spared wherever it is.
pub fn start(leaves: Leaves, records: Arc<Records>, node: watch::Receiver<Option<u32>>) {
    let mut guard = Guard {
        container: leaves.container().to_owned(),
        leaves,
        records,
        node,
        netd: std::process::id(),
        procs: Procs::at(PROC),
        trigger: Trigger::default(),
        sampler: Sampler::default(),
        nothing_said: false,
        failed_said: false,
    };
    let started = std::thread::Builder::new()
        .name("netd-memguard".into())
        .spawn(move || guard.run());
    match started {
        Ok(_) => tracing::info!("the memory guard watches the sandbox's memory"),
        Err(error) => tracing::error!(%error, "the memory guard could not start"),
    }
}

struct Guard {
    leaves: Leaves,
    container: PathBuf,
    records: Arc<Records>,
    node: watch::Receiver<Option<u32>>,
    netd: u32,
    procs: Procs,
    trigger: Trigger,
    sampler: Sampler,
    // Said once until the next kill: a trigger with nothing it may kill, which would otherwise repeat every cooldown.
    nothing_said: bool,
    // Said once: a pass that panicked.
    failed_said: bool,
}

impl Guard {
    // Never returns. A pass that panics (a bug: nothing in it should) is said once and the next pass runs anyway, since
    // a guard that stops is worse than one that misses a second.
    fn run(&mut self) {
        loop {
            std::thread::sleep(POLL);
            let pass = std::panic::catch_unwind(AssertUnwindSafe(|| self.pass()));
            if pass.is_err() && !self.failed_said {
                self.failed_said = true;
                tracing::error!("a pass of the memory guard failed; it goes on");
            }
        }
    }

    fn pass(&mut self) {
        let now = Instant::now();
        let reading = Reading {
            psi: read_psi(&self.container),
            workload: Workload::read(&self.leaves.workload),
        };
        if let Some(reason) = self.trigger.observe(now, &reading) {
            self.act(&reason, &reading);
            self.trigger.rest(Instant::now());
        }
        if self.sampler.observe(now, reading.short()) {
            self.sample(&reading);
        }
    }

    fn spared(&self) -> Spared<'_> {
        Spared {
            netd: self.netd,
            node: *self.node.borrow(),
            daemon: &self.leaves.daemon_path,
        }
    }

    // The one process the kernel would pick first, outside the daemon's leaf, killed and written down. A process gone
    // before the kill is not replaced by the next one: it freed what it held by itself, and the trigger holds afresh
    // after the cooldown if that was not enough.
    fn act(&mut self, reason: &str, reading: &Reading) {
        let ranked = procs::ranked(self.procs.scan(), &self.spared());
        let Some(victim) = ranked.first() else {
            if !self.nothing_said {
                self.nothing_said = true;
                tracing::warn!(
                    reason,
                    "memory is short, and nothing outside the daemon's cgroup leaf is the guard's to kill"
                );
            }
            return;
        };
        match self.procs.kill(victim) {
            Kill::Done(detail) => {
                self.nothing_said = false;
                tracing::error!(
                    pid = victim.pid,
                    comm = %detail.comm,
                    rss_bytes = detail.rss_bytes,
                    swap_bytes = detail.swap_bytes,
                    oom_score = victim.oom_score,
                    owner = detail.owner.as_deref().unwrap_or(""),
                    reason,
                    "killed a process for memory"
                );
                self.records.append(
                    records::MEMORY_KILLS_FILE,
                    &MemoryKill {
                        at: records::now_ms(),
                        killer: Killer::NetdGuard,
                        pid: victim.pid,
                        comm: detail.comm,
                        argv: detail.argv,
                        rss_bytes: detail.rss_bytes,
                        swap_bytes: detail.swap_bytes,
                        oom_score: Some(victim.oom_score),
                        pgid: Some(victim.pgid),
                        owner: detail.owner,
                        cgroup: Some(victim.cgroup.clone()),
                        psi: reading.psi,
                        reason: Some(reason.to_owned()),
                    },
                );
            }
            Kill::Gone => {
                tracing::info!(
                    pid = victim.pid,
                    reason,
                    "the process the memory guard chose ended before its kill"
                );
            }
            Kill::Refused(error) => {
                tracing::error!(%error, pid = victim.pid, reason, "the memory guard's kill was refused");
            }
        }
    }

    // Written only with a pressure reading, which the sample's schema requires; a kernel without pressure accounting
    // (CONFIG_PSI off) leaves no samples.
    fn sample(&self, reading: &Reading) {
        let Some(psi) = reading.psi else {
            return;
        };
        let top: Vec<_> = procs::ranked(self.procs.scan(), &self.spared())
            .into_iter()
            .take(SAMPLE_TOP)
            .collect();
        let pids: Vec<u32> = top.iter().map(|proc| proc.pid).collect();
        let details = self.procs.details(&pids, false);
        let workload = reading.workload;
        self.records.append_rotating(
            PRESSURE_FILE,
            &PressureSample {
                at: records::now_ms(),
                memory_current: workload.memory_current,
                memory_max: workload.memory_max,
                swap_current: workload.swap_current,
                swap_max: workload.swap_max,
                psi,
                top: top
                    .iter()
                    .zip(details)
                    .map(|(proc, detail)| PressureTop {
                        pid: proc.pid,
                        comm: detail.comm,
                        rss_bytes: detail.rss_bytes.unwrap_or(0),
                        swap_bytes: detail.swap_bytes.unwrap_or(0),
                        oom_score: Some(proc.oom_score),
                        owner: detail.owner,
                    })
                    .collect(),
            },
            PRESSURE_FILE_LIMIT,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PSI: &str = "some avg10=61.20 avg60=40.00 avg300=12.00 total=99\nfull avg10=47.05 avg60=30.00 avg300=9.00 total=42\n";

    fn psi(full: f64) -> Option<Psi> {
        Some(Psi {
            some_avg10: full,
            full_avg10: full,
        })
    }

    fn stalled(full: f64) -> Reading {
        Reading {
            psi: psi(full),
            workload: Workload::default(),
        }
    }

    const GIB: u64 = 1024 * MIB;

    // A leaf bounded at 8 GiB of memory and 2 GiB of swap, using `memory` and `swap` of them.
    fn leaf(memory: u64, swap: u64) -> Reading {
        Reading {
            psi: psi(0.0),
            workload: Workload {
                memory_current: Some(memory),
                memory_max: Some(8 * GIB),
                swap_current: Some(swap),
                swap_max: Some(2 * GIB),
            },
        }
    }

    #[test]
    fn pressure_is_both_avg10s_or_none() {
        assert_eq!(
            parse_psi(PSI),
            Some(Psi {
                some_avg10: 61.2,
                full_avg10: 47.05
            })
        );
        assert_eq!(
            parse_psi("some avg10=1.00 avg60=0.00 avg300=0.00 total=0\n"),
            None
        );
        assert_eq!(parse_psi("fuller avg10=1.00\nsome avg10=1.00\n"), None);
        assert_eq!(parse_psi(""), None);
    }

    #[test]
    fn a_bound_of_max_is_none() {
        assert_eq!(parse_bytes("8589934592\n"), Some(8 * GIB));
        assert_eq!(parse_bytes("max\n"), None);
        assert_eq!(parse_bytes(""), None);
    }

    // (a): ten seconds of readings at or above 20, and not one fewer; a dip below starts the run again.
    #[test]
    fn a_stall_held_ten_seconds_triggers_and_a_dip_starts_it_again() {
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let mut trigger = Trigger::default();
        for s in 0..10 {
            assert_eq!(trigger.observe(at(s), &stalled(20.0)), None, "{s} s in");
        }
        assert_eq!(trigger.observe(at(10), &stalled(19.99)), None, "a dip");
        for s in 11..21 {
            assert_eq!(trigger.observe(at(s), &stalled(47.0)), None, "{s} s in");
        }
        let reason = trigger.observe(at(21), &stalled(47.0)).expect("held 10 s");
        assert!(reason.contains("47.0%"), "{reason}");
        assert!(reason.contains("for 10 s"), "{reason}");

        // An unreadable pressure breaks a run as a dip does.
        let mut trigger = Trigger::default();
        trigger.observe(at(0), &stalled(50.0));
        trigger.observe(at(5), &Reading::default());
        assert_eq!(trigger.observe(at(10), &stalled(50.0)), None);
    }

    // (a) counts only the sandbox's own pressure: a neighbour thrashing the VM stalls this sandbox too while it uses a
    // sliver of its bound (2026-11-05: 0.7 of 18 GiB, `full` near 50%), and killing here frees nothing the VM lacks.
    #[test]
    fn a_stall_while_the_workload_is_small_is_a_neighbours_and_kills_nothing() {
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let with = |memory: u64, swap: u64| Reading {
            psi: psi(47.0),
            ..leaf(memory, swap)
        };
        let mut trigger = Trigger::default();
        for s in 0..=30 {
            assert_eq!(
                trigger.observe(at(s), &with(GIB, 0)),
                None,
                "{s} s in, 1 of 8 GiB"
            );
        }
        // Memory and swap together at 80% of the leaf's 8 GiB: the pressure is this sandbox's own.
        let mut trigger = Trigger::default();
        for s in 0..10 {
            assert_eq!(
                trigger.observe(at(s), &with(6 * GIB, 410 * MIB)),
                None,
                "{s} s in"
            );
        }
        assert!(
            trigger.observe(at(10), &with(6 * GIB, 410 * MIB)).is_some(),
            "own pressure, held 10 s"
        );
    }

    // (b): both shares at or above 95% of a bound, five seconds on end.
    #[test]
    fn a_spent_leaf_held_five_seconds_triggers() {
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let full_memory = 8 * GIB / 100 * 96;
        let full_swap = 2 * GIB / 100 * 96;
        let mut trigger = Trigger::default();
        for s in 0..5 {
            assert_eq!(trigger.observe(at(s), &leaf(full_memory, full_swap)), None);
        }
        let reason = trigger
            .observe(at(5), &leaf(full_memory, full_swap))
            .expect("held 5 s");
        assert!(reason.contains("of 8192 MiB in memory"), "{reason}");
        assert!(reason.contains("of 2048 MiB of swap"), "{reason}");

        // Memory spent with swap to spare, or the reverse, is not spent.
        let mut trigger = Trigger::default();
        for s in 0..20 {
            assert_eq!(trigger.observe(at(s), &leaf(full_memory, GIB)), None);
            assert_eq!(trigger.observe(at(s), &leaf(4 * GIB, full_swap)), None);
        }
    }

    // A leaf with no bound, or a swap bound of 0, never meets (b): there is no share of nothing to have spent.
    #[test]
    fn an_unbounded_leaf_or_one_without_swap_is_never_spent() {
        let start = Instant::now();
        let mut unbounded = leaf(8 * GIB, 2 * GIB);
        unbounded.workload.memory_max = None;
        let mut no_swap = leaf(8 * GIB, 0);
        no_swap.workload.swap_max = Some(0);
        let mut trigger = Trigger::default();
        for s in 0..20 {
            let now = start + Duration::from_secs(s);
            assert_eq!(trigger.observe(now, &unbounded), None);
            assert_eq!(trigger.observe(now, &no_swap), None);
        }
        assert!(!no_swap.short(), "nor is it short of swap");
    }

    // After a kill nothing triggers for the cooldown, however short memory is, and then the trigger has to hold afresh.
    #[test]
    fn a_kill_rests_the_trigger_and_it_must_hold_again_after() {
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let mut trigger = Trigger::default();
        for s in 0..10 {
            trigger.observe(at(s), &stalled(60.0));
        }
        assert!(trigger.observe(at(10), &stalled(60.0)).is_some());
        trigger.rest(at(10));
        for s in 11..25 {
            assert_eq!(
                trigger.observe(at(s), &stalled(60.0)),
                None,
                "{s} s: resting"
            );
        }
        for s in 25..35 {
            assert_eq!(
                trigger.observe(at(s), &stalled(60.0)),
                None,
                "{s} s: holding afresh"
            );
        }
        assert!(trigger.observe(at(35), &stalled(60.0)).is_some());
    }

    #[test]
    fn samples_come_every_ten_seconds_while_short_and_once_more_after() {
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let mut sampler = Sampler::default();
        assert!(!sampler.observe(at(0), false));
        let written: Vec<u64> = (1..25).filter(|s| sampler.observe(at(*s), true)).collect();
        assert_eq!(
            written,
            vec![1, 11, 21],
            "the first at once, then every 10 s"
        );
        assert!(sampler.observe(at(25), false), "the last, once it eased");
        assert!(!sampler.observe(at(26), false));
        assert!(
            sampler.observe(at(27), true),
            "a new episode starts at once"
        );
    }

    #[test]
    fn short_is_full_pressure_or_half_the_swap() {
        assert!(!stalled(9.99).short());
        assert!(stalled(10.0).short());
        assert!(leaf(0, GIB).short(), "half of 2 GiB of swap");
        assert!(!leaf(0, GIB - 1).short());
        assert!(!Reading::default().short());
    }

    #[test]
    fn a_restart_is_held_from_twenty_until_below_ten_for_ten_minutes_at_most() {
        assert!(!holds_restart(psi(19.9)));
        assert!(holds_restart(psi(20.0)));
        assert!(!holds_restart(None));
        let minute = Duration::from_secs(60);
        assert!(keeps_holding(psi(10.0), minute, HOLD_AT_MOST));
        assert!(!keeps_holding(psi(9.9), minute, HOLD_AT_MOST));
        assert!(!keeps_holding(None, minute, HOLD_AT_MOST), "unreadable: go");
        assert!(!keeps_holding(psi(80.0), HOLD_AT_MOST, HOLD_AT_MOST));
    }

    #[test]
    fn the_containers_pressure_is_read_from_its_cgroup() {
        let dir = std::env::temp_dir().join(format!("netd-memguard-psi-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("memory.pressure"), PSI).unwrap();
        let container = Container::new(dir.clone(), true, Arc::new(Records::nowhere()));
        assert_eq!(container.psi().map(|psi| psi.full_avg10), Some(47.05));
        assert!(Container::detached().psi().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
