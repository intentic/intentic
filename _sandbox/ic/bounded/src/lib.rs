//! A child process with a time limit, and everything it printed.
//!
//! `ic` and the desktop app both wait on short commands (`docker inspect`, `docker run --rm`, `ic sandbox list`)
//! that must not be able to hang the flow waiting on them. They used to carry a copy each, and a fix reached one:
//! ic's killed only the child it spawned, the desktop's killed the whole tree. This is the one copy.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How a bounded run ended, and what it printed on each stream (as it printed it: nothing is trimmed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    /// The exit code; None when the child did not exit on its own (the deadline ended it, or a signal did).
    pub code: Option<i32>,
    /// The deadline ended it. What it printed before then is still in the two streams.
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

impl Captured {
    /// Exited on its own, with status zero.
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

/// What the deadline kills. `Tree` gives the child a process group of its own on Unix and kills the group, and
/// reaches the tree through `taskkill /T` on Windows: the right reach for a shell or a CLI that starts helpers of
/// its own. `Child` leaves the child in its parent's group, so a Ctrl-C at the terminal still reaches it, and kills
/// only it: right for a child that is itself the work (`docker run`, whose container is removed by name).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Child,
    Tree,
}

/// How often a bounded child is asked whether it has exited.
const POLL: Duration = Duration::from_millis(25);

/// How long the pipes of a child that has exited (or been killed) are waited on. A background process the child
/// left behind inherits them, and would otherwise hold the answer open for as long as it lives.
pub const DRAIN_GRACE: Duration = Duration::from_millis(750);

/// Run `command` to its exit, or kill it at `limit`. stdin is closed. Both pipes drain on threads of their own,
/// because a child blocked writing into a full pipe never exits; the child is polled rather than waited on,
/// because a blocking wait cannot be given up on. `Err` only when the child could not be started at all.
pub fn capture(command: Command, limit: Duration, reach: Reach) -> std::io::Result<Captured> {
    let mut command = command;
    if reach == Reach::Tree {
        own_group(&mut command);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (drained, drains) = channel::<()>();
    let stdout = collect(child.stdout.take(), drained.clone());
    let stderr = collect(child.stderr.take(), drained);
    let deadline = Instant::now() + limit;
    let (code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL),
            Ok(None) | Err(_) => {
                if reach == Reach::Tree {
                    let _ = kill_tree(child.id(), Signal::Kill);
                }
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
        }
    };
    await_drain(&drains, 2, DRAIN_GRACE);
    let text = |bytes: &Mutex<Vec<u8>>| {
        String::from_utf8_lossy(&bytes.lock().map(|held| held.clone()).unwrap_or_default())
            .to_string()
    };
    Ok(Captured {
        code,
        timed_out,
        stdout: text(&stdout),
        stderr: text(&stderr),
    })
}

/// Give `command` a process group of its own, so one signal reaches everything it starts. Windows reaches the
/// tree through `taskkill /T` and needs nothing here.
#[cfg(unix)]
pub fn own_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
pub fn own_group(_command: &mut Command) {}

/// Which signal [`kill_tree`] sends on Unix. Windows has one answer, `taskkill /T /F`, whichever is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

/// Signal a child that leads its own process group (see [`own_group`]) and everything it started.
pub fn kill_tree(pid: u32, signal: Signal) -> std::io::Result<std::process::ExitStatus> {
    if cfg!(windows) {
        let mut taskkill = Command::new("taskkill.exe");
        no_window(&mut taskkill);
        return taskkill
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let flag = match signal {
        Signal::Term => "-TERM",
        Signal::Kill => "-KILL",
    };
    Command::new("kill")
        .args([flag, "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
}

/// Suppress the console window Windows gives every process a GUI app spawns.
#[cfg(windows)]
pub fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn no_window(_command: &mut Command) {}

/// Wait for `pumps` pipe readers to reach the end of their stream, for at most `grace` in total. True when every
/// one did; false when the window ran out with a reader still parked on a handle somebody else holds open.
pub fn await_drain(drains: &Receiver<()>, pumps: usize, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    for _ in 0..pumps {
        if drains
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_err()
        {
            return false;
        }
    }
    true
}

/// Read one stream to its end on a thread of its own, reporting on `drained` when it gets there. What arrived is
/// readable at any moment, so a finished child's output is kept even while a leftover holder keeps the pipe open.
fn collect(handle: Option<impl Read + Send + 'static>, drained: Sender<()>) -> Arc<Mutex<Vec<u8>>> {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&bytes);
    std::thread::spawn(move || {
        if let Some(mut handle) = handle {
            let mut chunk = [0u8; 8192];
            while let Ok(read) = handle.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                if let Ok(mut held) = sink.lock() {
                    held.extend_from_slice(&chunk[..read]);
                }
            }
        }
        let _ = drained.send(());
    });
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_exits_is_answered_with_its_code_and_both_streams() {
        for reach in [Reach::Child, Reach::Tree] {
            let answer = capture(
                shell("echo out; echo err >&2; exit 3"),
                Duration::from_secs(20),
                reach,
            )
            .expect("sh runs");
            assert_eq!(
                answer,
                Captured {
                    code: Some(3),
                    timed_out: false,
                    stdout: "out\n".to_string(),
                    stderr: "err\n".to_string(),
                }
            );
            assert!(!answer.success());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_child_past_its_deadline_is_killed_and_what_it_printed_is_kept() {
        for reach in [Reach::Child, Reach::Tree] {
            let began = Instant::now();
            // `exec`, so under `Child` the killed process IS the sleep rather than a shell leaving it behind.
            let answer = capture(
                shell("echo started; exec sleep 30"),
                Duration::from_millis(300),
                reach,
            )
            .expect("sh runs");
            assert!(answer.timed_out);
            assert_eq!(answer.code, None);
            assert_eq!(answer.stdout, "started\n");
            // Far above the deadline, far below the 30s the child asked for: a hang bound, not a timing.
            assert!(began.elapsed() < Duration::from_secs(10), "{reach:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_tree_reach_kills_what_the_child_started_too() {
        let began = Instant::now();
        // No `exec`: the sleep is a grandchild holding both pipes, which only a group kill reaches.
        let answer = capture(
            shell("echo started; sleep 30; true"),
            Duration::from_millis(300),
            Reach::Tree,
        )
        .expect("sh runs");
        assert!(answer.timed_out);
        assert_eq!(answer.stdout, "started\n");
        assert!(began.elapsed() < Duration::from_secs(10));
    }

    /// The Windows shape of `intentic-machine run`: the child exits at once, and the loop it left behind holds its
    /// stdout for as long as the loop lives.
    #[cfg(unix)]
    #[test]
    fn a_background_holder_of_the_pipes_costs_only_the_grace() {
        let began = Instant::now();
        let answer = capture(
            shell("echo started; sleep 20 & exit 0"),
            Duration::from_secs(10),
            Reach::Tree,
        )
        .expect("the child itself exits at once");
        assert!(answer.success());
        assert_eq!(answer.stdout, "started\n");
        assert!(began.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_binary_that_is_not_there_never_started() {
        assert!(capture(
            Command::new("intentic-no-such-binary-here"),
            Duration::from_secs(1),
            Reach::Tree
        )
        .is_err());
    }

    /* A setup run installs resident background agents, and on Windows a detached process inherits the pipes of whoever spawned it. */
    #[test]
    fn a_drain_that_completes_costs_nothing() {
        let (drained, drains) = channel::<()>();
        drained.send(()).expect("first pump reports");
        drained.send(()).expect("second pump reports");

        let started = Instant::now();
        assert!(await_drain(&drains, 2, Duration::from_secs(30)));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "two pumps that already reported must not wait on the grace at all"
        );
    }

    #[test]
    fn a_pump_that_never_finishes_costs_only_the_grace() {
        let grace = Duration::from_millis(200);
        let (drained, drains) = channel::<()>();
        drained.send(()).expect("the one pump that ends reports");
        // The other end stays alive and silent — a background agent holding the write handle open.
        let _held_open = drained;

        let started = Instant::now();
        assert!(!await_drain(&drains, 2, grace));
        let waited = started.elapsed();
        assert!(waited >= grace, "the grace is a real window, not a poll");
        assert!(
            waited < grace * 10,
            "waited {waited:?} — a silent pump must never hold a finished run open"
        );
    }
}
