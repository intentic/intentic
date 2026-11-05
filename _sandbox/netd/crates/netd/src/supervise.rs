//! Runs the Node daemon as a child and keeps it running. A crash restarts it with backoff while netd holds every
//! socket, once what the dead daemon left in its process group is gone; a Node netd found stuck is killed, the kill
//! written down (`netd-kills.jsonl`), and restarted the same way. A restart into a sandbox stalling on memory waits for
//! it to ease (memguard). A deliberate stop (exit 0) or a refused config (exit 78) ends netd too, as they ended the
//! container.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::process::ExitStatus;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use relay::Backoff;
use tokio::process::{Child, Command};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::watch;

use crate::memguard::{self, Container};
use crate::records::{self, NetdKill, NetdKillKind};
use crate::vitals::Verdict;

// Restarts climb from a second to thirty; a run of a minute counts as working, and the next crash starts from the floor.
const BACKOFF: Backoff = Backoff::new(
    Duration::from_secs(1),
    Duration::from_secs(30),
    Duration::from_secs(60),
);

// Node's own SIGTERM handler disposes every subsystem; past this it is killed outright.
const STOP_GRACE: Duration = Duration::from_secs(25);

// EX_CONFIG: the daemon refused its configuration, which no restart can fix.
const REFUSED_CONFIG: i32 = 78;

// How far back the vitals route counts restarts.
const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);

// How long a crashed daemon's leftovers get to end on SIGTERM before SIGKILL. Short, since nothing reads what they do
// any more, and short because the group's id only stays the dead daemon's while a member of it lives: a SIGKILL sent
// long after could find a process that took the number since.
const LEFTOVER_GRACE: Duration = Duration::from_secs(1);

/// When netd restarted Node, as far back as `RESTART_WINDOW`, and whether it ever did.
#[derive(Default)]
pub struct Restarts {
    recent: Mutex<VecDeque<Instant>>,
    ever: AtomicBool,
    // Raised by every restart, for whoever writes the count down (vitals.rs `keep_written`).
    recorded: tokio::sync::Notify,
}

impl Restarts {
    pub fn record(&self, at: Instant) {
        self.ever.store(true, Ordering::Relaxed);
        {
            let mut recent = self.recent.lock().expect("restarts poisoned");
            forget_before(&mut recent, at);
            recent.push_back(at);
        }
        // A permit is kept when nobody waits yet, so a restart between two waits is not missed.
        self.recorded.notify_one();
    }

    /// Returns once a restart was recorded since the last return.
    pub async fn recorded(&self) {
        self.recorded.notified().await;
    }

    /// How many restarts fall within `RESTART_WINDOW` of `now`.
    pub fn within_window(&self, now: Instant) -> u32 {
        let mut recent = self.recent.lock().expect("restarts poisoned");
        forget_before(&mut recent, now);
        u32::try_from(recent.len()).unwrap_or(u32::MAX)
    }

    pub fn ever(&self) -> bool {
        self.ever.load(Ordering::Relaxed)
    }
}

// Oldest first, so what fell out of the window is always at the front.
fn forget_before(recent: &mut VecDeque<Instant>, now: Instant) {
    while recent
        .front()
        .is_some_and(|at| now.saturating_duration_since(*at) > RESTART_WINDOW)
    {
        recent.pop_front();
    }
}

pub struct NodeCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

/// Runs Node until it stops on purpose or `stop` is raised; the answer is netd's own exit code. A verdict sent on
/// `stuck` while a Node runs kills it, which is written down with `container`'s pressure, and it is restarted as after
/// a crash. Every start after a crash or a failed start is recorded in `restarts`; one after a crash or a kill waits
/// while `container` is stalling on memory.
pub async fn supervise(
    command: NodeCommand,
    pid: watch::Sender<Option<u32>>,
    mut stop: watch::Receiver<bool>,
    mut stuck: watch::Receiver<Option<Verdict>>,
    restarts: &Restarts,
    container: &Container,
) -> i32 {
    let mut backoff = BACKOFF;
    // Which start of Node this is, told to each in `GENERATION_ENV` and said back in its hello: the control socket lets a
    // newer start take the link from an older one, and never a copy of the same start (link.rs).
    let mut generation = 0_u64;
    loop {
        let started = Instant::now();
        generation += 1;
        let mut child = match spawn(&command, generation) {
            Ok(child) => child,
            Err(error) => {
                tracing::error!(%error, "could not start the daemon");
                restarts.record(Instant::now());
                if wait_or_stop(backoff.after(started.elapsed()), &mut stop).await {
                    return 1;
                }
                continue;
            }
        };
        let node = child.id();
        pid.send_replace(node);
        // A verdict on an earlier Node says nothing of this one.
        stuck.mark_unchanged();
        let status = tokio::select! {
            status = child.wait() => status,
            () = raised(&mut stop) => terminate(&mut child, node).await,
            () = told(&mut stuck) => {
                let verdict = *stuck.borrow_and_update();
                let status = kill_stuck(&mut child).await;
                if let Some(verdict) = verdict {
                    record(container, killed(verdict, node)).await;
                }
                status
            }
        };
        pid.send_replace(None);
        let code = status.as_ref().map_or(1, exit_code);
        if *stop.borrow() || code == 0 || code == REFUSED_CONFIG {
            tracing::info!(code, "the daemon stopped");
            return code;
        }
        tracing::error!(code, ran = ?started.elapsed(), "the daemon crashed; restarting it");
        restarts.record(Instant::now());
        if let Some(group) = node {
            reclaim(group).await;
        }
        if wait_or_stop(backoff.after(started.elapsed()), &mut stop).await
            || hold_while_short(container, &mut stop).await
        {
            return code;
        }
    }
}

// What the kill of a stuck Node says: which verdict, the Node's pid, and how long it had been silent by the kill.
fn killed(verdict: Verdict, pid: Option<u32>) -> NetdKill {
    NetdKill {
        at: records::now_ms(),
        kind: verdict.kind,
        pid,
        silent_ms: Some(records::millis(verdict.since.elapsed())),
        held_ms: None,
        psi: None,
    }
}

// Written with the pressure of the moment, both off the async threads: a flush to a volume the thrash is paging
// through can take seconds.
async fn record(container: &Container, line: NetdKill) {
    let container = container.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let psi = container.psi();
        container.record(&NetdKill { psi, ..line });
    })
    .await;
}

// A restart after a crash or a kill, held while the sandbox stalls on memory (memguard's rule): a daemon started into a
// thrash pages in its modules for minutes, misses its hello deadline and is killed again, and its restarts are the
// load. Waits, reading the pressure every `hold_check`, until it eased or `hold_at_most` passed, then writes the hold
// down. True when stop was raised meanwhile.
async fn hold_while_short(container: &Container, stop: &mut watch::Receiver<bool>) -> bool {
    if !container.holds_restarts() {
        return false;
    }
    let psi = {
        let reading = container.clone();
        tokio::task::spawn_blocking(move || reading.psi())
            .await
            .ok()
            .flatten()
    };
    if !memguard::holds_restart(psi) {
        return false;
    }
    tracing::warn!(
        full_avg10 = psi.map(|psi| psi.full_avg10),
        "the sandbox is stalling on memory: the daemon's restart waits until it eases"
    );
    let began = Instant::now();
    let mut stopped = false;
    let mut psi = psi;
    while memguard::keeps_holding(psi, began.elapsed(), container.hold_at_most) {
        if wait_or_stop(container.hold_check, stop).await {
            stopped = true;
            break;
        }
        let reading = container.clone();
        psi = tokio::task::spawn_blocking(move || reading.psi())
            .await
            .ok()
            .flatten();
    }
    let held = began.elapsed();
    tracing::info!(held = ?held, full_avg10 = psi.map(|psi| psi.full_avg10), "the daemon's restart waited for memory");
    record(
        container,
        NetdKill {
            at: records::now_ms(),
            kind: NetdKillKind::RestartHeld,
            pid: None,
            silent_ms: None,
            held_ms: Some(records::millis(held)),
            psi: None,
        },
    )
    .await;
    stopped
}

// Its own process group, so the daemon's "my group" still means its own descendants and never netd; and it dies
// with netd, so a netd killed outright never leaves a daemon serving a socket nobody dials.
fn spawn(command: &NodeCommand, generation: u64) -> std::io::Result<Child> {
    let mut spawning = Command::new(&command.program);
    spawning
        .args(&command.args)
        .envs(command.env.iter().cloned())
        .env(netd_wire::GENERATION_ENV, generation.to_string())
        .process_group(0)
        .kill_on_drop(false);
    // SAFETY: prctl is async-signal-safe, and nothing else runs between fork and exec here.
    unsafe {
        spawning.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    spawning.spawn()
}

async fn terminate(child: &mut Child, pid: Option<u32>) -> std::io::Result<ExitStatus> {
    if let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) {
        // SAFETY: signalling a pid this process spawned and has not yet reaped.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    match tokio::time::timeout(STOP_GRACE, child.wait()).await {
        Ok(status) => status,
        Err(_) => {
            tracing::warn!("the daemon ignored SIGTERM for {STOP_GRACE:?}; killing it");
            child.kill().await?;
            child.wait().await
        }
    }
}

// SIGKILL, never SIGTERM: Node's SIGTERM handler runs on the very event loop that is stuck, and were the loop to turn
// again the handler would stop the daemon cleanly, exit 0, and take netd and the container down with it.
async fn kill_stuck(child: &mut Child) -> std::io::Result<ExitStatus> {
    tracing::error!("killing the stuck daemon; it restarts as after a crash");
    child.kill().await?;
    child.wait().await
}

/// Ends what a crashed daemon left in its process group. Whatever it started without a group of its own (a pooled
/// agent, the translator, a turn's runtime mid-answer, an `intentic` run) outlives it, nothing in the next daemon adopts
/// it, and that daemon's own sweep reads only its own group, so each would run on beside its replacement. What is meant
/// to outlive a restart starts in a group of its own (a service, an X display, a tmux pane), and this never reaches it.
async fn reclaim(group: u32) {
    let Ok(group) = i32::try_from(group) else {
        return;
    };
    if !signal_group(group, libc::SIGTERM) {
        return;
    }
    tracing::warn!(
        group,
        "the crashed daemon left processes behind; ending them"
    );
    tokio::time::sleep(LEFTOVER_GRACE).await;
    signal_group(group, libc::SIGKILL);
}

// Whether the group still had a member to signal; ESRCH, a group nobody is left in, is the outcome wanted.
fn signal_group(group: i32, signal: libc::c_int) -> bool {
    // SAFETY: killpg takes no pointers, and a group with no member left answers ESRCH.
    unsafe { libc::killpg(group, signal) == 0 }
}

fn exit_code(status: &ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

// True when stop was raised during the wait.
async fn wait_or_stop(wait: Duration, stop: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        () = tokio::time::sleep(wait) => false,
        () = raised(stop) => true,
    }
}

// The guard `wait_for` hands back must not live across the await that follows it.
async fn raised(flag: &mut watch::Receiver<bool>) {
    let _ = flag.wait_for(|raised| *raised).await;
}

// The next value sent after the last one seen; never, once nobody is left to send one.
async fn told<T>(signal: &mut watch::Receiver<T>) {
    if signal.changed().await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// As PID 1 (a hosted machine runs without an init), reaps every orphan that dies; the daemon itself is left to the
/// supervisor's own wait, which would otherwise lose its exit status.
pub async fn reap_orphans(node: watch::Receiver<Option<u32>>) {
    let Ok(mut children) = signal(SignalKind::child()) else {
        return;
    };
    while children.recv().await.is_some() {
        loop {
            // SAFETY: zeroed siginfo_t is a valid out-parameter for waitid.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // SAFETY: WNOWAIT only peeks; nothing is reaped until the pid is known not to be the daemon's.
            let peeked = unsafe {
                libc::waitid(
                    libc::P_ALL,
                    0,
                    &raw mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            // SAFETY: si_pid is valid once waitid reports an exited child.
            let pid = unsafe { info.si_pid() };
            if peeked != 0 || pid == 0 || u32::try_from(pid).ok() == *node.borrow() {
                break;
            }
            // SAFETY: reaping a zombie child by its own pid.
            unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn sh(script: &str) -> NodeCommand {
        NodeCommand {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            env: vec![],
        }
    }

    // A stuck verdict nobody will ever send.
    fn never_stuck() -> watch::Receiver<Option<Verdict>> {
        watch::channel(None).1
    }

    fn verdict(kind: NetdKillKind) -> Option<Verdict> {
        Some(Verdict {
            kind,
            since: Instant::now(),
        })
    }

    // A container whose records go to `dir/logs` and whose pressure is read off `dir/memory.pressure`, which the test
    // writes; restarts are held for it, checked every 50 ms.
    fn container_in(dir: &std::path::Path) -> Container {
        let mut container = Container::new(
            dir.to_owned(),
            true,
            Arc::new(crate::records::Records::in_dir(dir.join("logs"))),
        );
        container.hold_check = Duration::from_millis(50);
        container
    }

    fn netd_kills(dir: &std::path::Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(dir.join("logs").join(crate::records::NETD_KILLS_FILE))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn pressure(full: f64) -> String {
        format!(
            "some avg10={full:.2} avg60=0.00 avg300=0.00 total=1\nfull avg10={full:.2} avg60=0.00 avg300=0.00 total=1\n"
        )
    }

    // Alive, as opposed to gone or a zombie nobody has reaped yet.
    fn running(pid: i32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
            stat.rsplit_once(')')
                .is_some_and(|(_, rest)| !rest.trim_start().starts_with('Z'))
        })
    }

    #[test]
    fn restarts_are_counted_over_the_last_ten_minutes() {
        let restarts = Restarts::default();
        let start = Instant::now();
        assert_eq!(restarts.within_window(start), 0);
        restarts.record(start);
        restarts.record(start + Duration::from_secs(60));
        restarts.record(start + Duration::from_secs(9 * 60));
        assert_eq!(
            restarts.within_window(start + Duration::from_secs(9 * 60)),
            3
        );
        // The window's edge still counts; a second past it does not.
        assert_eq!(restarts.within_window(start + RESTART_WINDOW), 3);
        assert_eq!(
            restarts.within_window(start + RESTART_WINDOW + Duration::from_secs(1)),
            2
        );
        assert_eq!(
            restarts.within_window(start + Duration::from_secs(9 * 60) + RESTART_WINDOW),
            1
        );
        assert_eq!(
            restarts.within_window(start + Duration::from_secs(20 * 60)),
            0
        );
        assert!(restarts.ever());
    }

    #[tokio::test]
    async fn a_deliberate_stop_ends_the_netd_with_it() {
        let (pid, _) = watch::channel(None);
        let (_stop, stopping) = watch::channel(false);
        let restarts = Restarts::default();
        assert_eq!(
            supervise(
                sh("exit 0"),
                pid,
                stopping,
                never_stuck(),
                &restarts,
                &Container::detached()
            )
            .await,
            0
        );
        assert!(!restarts.ever());
    }

    #[tokio::test]
    async fn a_refused_config_is_not_retried() {
        let (pid, _) = watch::channel(None);
        let (_stop, stopping) = watch::channel(false);
        assert_eq!(
            supervise(
                sh("exit 78"),
                pid,
                stopping,
                never_stuck(),
                &Restarts::default(),
                &Container::detached()
            )
            .await,
            78
        );
    }

    #[tokio::test]
    async fn a_crash_restarts_the_daemon() {
        let marker = std::env::temp_dir().join(format!("netd-supervise-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        // Crashes on the first run, stops cleanly on the second: the second run is proof of the restart.
        let script = format!(
            "if [ -e {0} ]; then exit 0; fi; touch {0}; exit 3",
            marker.display()
        );
        let (pid, _) = watch::channel(None);
        let (_stop, stopping) = watch::channel(false);
        let restarts = Restarts::default();
        assert_eq!(
            supervise(
                sh(&script),
                pid,
                stopping,
                never_stuck(),
                &restarts,
                &Container::detached()
            )
            .await,
            0
        );
        assert_eq!(restarts.within_window(Instant::now()), 1);
        assert!(restarts.ever());
        let _ = std::fs::remove_file(&marker);
    }

    #[tokio::test]
    async fn stop_forwards_sigterm_and_waits_for_the_daemon() {
        let (pid, mut started) = watch::channel(None);
        let (stop, stopping) = watch::channel(false);
        let running = tokio::spawn(async move {
            supervise(
                sh("trap 'exit 0' TERM; while :; do sleep 0.05; done"),
                pid,
                stopping,
                never_stuck(),
                &Restarts::default(),
                &Container::detached(),
            )
            .await
        });
        started.wait_for(Option::is_some).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        stop.send_replace(true);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), running)
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }

    // What a crashed Node leaves behind: a child it started in its own group outlives it, until netd reclaims the
    // group. This one ignores SIGTERM, as a runtime busy unwinding might, so only the SIGKILL after the grace ends it.
    #[tokio::test]
    async fn a_crashed_daemons_process_group_goes_with_it() {
        let dir = std::env::temp_dir().join(format!("netd-supervise-group-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let written = dir.join("leftover");
        let mut daemon = spawn(
            &sh(&format!(
                "(trap '' TERM; exec sleep 1000) & echo $! > {}; exit 3",
                written.display()
            )),
            1,
        )
        .unwrap();
        let group = daemon.id().unwrap();
        assert_eq!(daemon.wait().await.unwrap().code(), Some(3));
        let leftover: i32 = std::fs::read_to_string(&written)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(running(leftover), "it outlives the daemon by itself");

        reclaim(group).await;
        let deadline = Instant::now() + Duration::from_secs(2);
        while running(leftover) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!running(leftover), "the reclaim ended it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_stuck_daemon_is_killed_written_down_and_restarted_as_after_a_crash() {
        let dir = std::env::temp_dir().join(format!("netd-supervise-stuck-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("marker");
        // The first run ignores SIGTERM, as a Node whose event loop is stuck does, and never ends by itself; the second
        // stops cleanly, which is proof of the restart. No pressure file: nothing holds the restart.
        let script = format!(
            "if [ -e {0} ]; then exit 0; fi; touch {0}; trap '' TERM; while :; do sleep 0.05; done",
            marker.display()
        );
        let (pid, mut started) = watch::channel(None);
        let (_stop, stopping) = watch::channel(false);
        let (stuck, verdicts) = watch::channel(None);
        stuck.send_replace(verdict(NetdKillKind::NoHello));
        let restarts = Arc::new(Restarts::default());
        let counted = restarts.clone();
        let container = container_in(&dir);
        let running = tokio::spawn(async move {
            supervise(sh(&script), pid, stopping, verdicts, &counted, &container).await
        });
        let first = *started.wait_for(Option::is_some).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            *started.borrow(),
            first,
            "a verdict sent before this Node started kills nothing"
        );

        stuck.send_replace(Some(Verdict {
            kind: NetdKillKind::Stuck,
            since: Instant::now() - Duration::from_secs(300),
        }));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(10), running)
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert_eq!(restarts.within_window(Instant::now()), 1);
        let kills = netd_kills(&dir);
        assert_eq!(kills.len(), 1, "{kills:?}");
        assert_eq!(kills[0]["kind"], "stuck");
        assert_eq!(kills[0]["pid"], first.unwrap());
        assert!(kills[0]["silentMs"].as_u64().unwrap() >= 300_000);
        assert!(kills[0].get("psi").is_none(), "no pressure to read");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A crash while the sandbox stalls on memory: the restart waits until the pressure eases below 10, and the wait is
    // written down. A first start is never held, however short memory is.
    #[tokio::test]
    async fn a_restart_waits_while_the_sandbox_stalls_on_memory() {
        let dir = std::env::temp_dir().join(format!("netd-supervise-held-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("memory.pressure"), pressure(35.0)).unwrap();
        let marker = dir.join("marker");
        let script = format!(
            "if [ -e {0} ]; then exit 0; fi; touch {0}; exit 3",
            marker.display()
        );
        let (pid, mut started) = watch::channel(None);
        let (_stop, stopping) = watch::channel(false);
        let container = container_in(&dir);
        let running = tokio::spawn(async move {
            supervise(
                sh(&script),
                pid,
                stopping,
                never_stuck(),
                &Restarts::default(),
                &container,
            )
            .await
        });
        started.wait_for(Option::is_some).await.unwrap();
        started.wait_for(Option::is_none).await.unwrap();
        let crashed = Instant::now();

        // Past the backoff (one to two seconds after a first crash), still held; and still at 15, which is below the 20
        // that holds but not below the 10 that releases.
        tokio::time::sleep(Duration::from_millis(2_300)).await;
        std::fs::write(dir.join("memory.pressure"), pressure(15.0)).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(started.borrow().is_none(), "held while memory is short");
        assert!(!running.is_finished());

        std::fs::write(dir.join("memory.pressure"), pressure(4.0)).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(10), running)
                .await
                .unwrap()
                .unwrap(),
            0
        );
        let kills = netd_kills(&dir);
        assert_eq!(kills.len(), 1, "{kills:?}");
        assert_eq!(kills[0]["kind"], "restart-held");
        let held = kills[0]["heldMs"].as_u64().unwrap();
        assert!(
            held >= 500 && u128::from(held) <= crashed.elapsed().as_millis(),
            "{held} ms"
        );
        assert_eq!(kills[0]["psi"]["fullAvg10"], 4.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The hold has a ceiling: past it the daemon starts into whatever memory is left.
    #[tokio::test]
    async fn a_held_restart_goes_ahead_after_its_ceiling() {
        let dir =
            std::env::temp_dir().join(format!("netd-supervise-ceiling-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("memory.pressure"), pressure(80.0)).unwrap();
        let mut container = container_in(&dir);
        container.hold_at_most = Duration::from_millis(300);
        let (_stop, mut stopping) = watch::channel(false);
        let began = Instant::now();
        assert!(!hold_while_short(&container, &mut stopping).await);
        assert!(began.elapsed() >= Duration::from_millis(300));
        assert_eq!(netd_kills(&dir)[0]["kind"], "restart-held");

        // One not the container's own netd holds nothing.
        let detached = Container::new(
            dir.clone(),
            false,
            Arc::new(crate::records::Records::nowhere()),
        );
        let began = Instant::now();
        assert!(!hold_while_short(&detached, &mut stopping).await);
        assert!(began.elapsed() < Duration::from_millis(300));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Each start is told which one it is, which it says back in its hello (link.rs).
    #[tokio::test]
    async fn every_start_is_told_its_generation() {
        let mut child = spawn(&sh(&format!("exit ${}", netd_wire::GENERATION_ENV)), 7).unwrap();
        assert_eq!(child.wait().await.unwrap().code(), Some(7));
    }
}
