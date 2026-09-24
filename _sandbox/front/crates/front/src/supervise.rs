//! Runs the Node daemon as a child and keeps it running. A crash restarts it with backoff while the front holds every
//! socket; a deliberate stop (exit 0) or a refused config (exit 78) ends the front too, as they ended the container.

use std::ffi::OsString;
use std::process::ExitStatus;
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::watch;

const BACKOFF_FLOOR: Duration = Duration::from_secs(1);
const BACKOFF_CAP: Duration = Duration::from_secs(30);

// A run this long counts as working: the next crash restarts from the floor rather than climbing on.
const STABLE_AFTER: Duration = Duration::from_secs(60);

// Node's own SIGTERM handler disposes every subsystem; past this it is killed outright.
const STOP_GRACE: Duration = Duration::from_secs(25);

// EX_CONFIG: the daemon refused its configuration, which no restart can fix.
const REFUSED_CONFIG: i32 = 78;

pub struct NodeCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

/// Runs Node until it stops on purpose or `stop` is raised; the answer is the front's own exit code.
pub async fn supervise(
    command: NodeCommand,
    pid: watch::Sender<Option<u32>>,
    mut stop: watch::Receiver<bool>,
) -> i32 {
    let mut backoff = BACKOFF_FLOOR;
    loop {
        let started = Instant::now();
        let mut child = match spawn(&command) {
            Ok(child) => child,
            Err(error) => {
                tracing::error!(%error, "could not start the daemon");
                if wait_or_stop(backoff, &mut stop).await {
                    return 1;
                }
                backoff = (backoff * 2).min(BACKOFF_CAP);
                continue;
            }
        };
        let node = child.id();
        pid.send_replace(node);
        let status = tokio::select! {
            status = child.wait() => status,
            () = raised(&mut stop) => terminate(&mut child, node).await,
        };
        pid.send_replace(None);
        let code = status.as_ref().map_or(1, exit_code);
        if *stop.borrow() || code == 0 || code == REFUSED_CONFIG {
            tracing::info!(code, "the daemon stopped");
            return code;
        }
        tracing::error!(code, ran = ?started.elapsed(), "the daemon crashed; restarting it");
        if started.elapsed() >= STABLE_AFTER {
            backoff = BACKOFF_FLOOR;
        }
        if wait_or_stop(backoff, &mut stop).await {
            return code;
        }
        backoff = (backoff * 2).min(BACKOFF_CAP);
    }
}

// Its own process group, so the daemon's "my group" still means its own descendants and never the front; and it dies
// with the front, so a front killed outright never leaves a daemon serving a socket nobody dials.
fn spawn(command: &NodeCommand) -> std::io::Result<Child> {
    let mut spawning = Command::new(&command.program);
    spawning
        .args(&command.args)
        .envs(command.env.iter().cloned())
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
    use super::*;

    fn sh(script: &str) -> NodeCommand {
        NodeCommand {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            env: vec![],
        }
    }

    #[tokio::test]
    async fn a_deliberate_stop_ends_the_front_with_it() {
        let (pid, _) = watch::channel(None);
        let (_stop, stopping) = watch::channel(false);
        assert_eq!(supervise(sh("exit 0"), pid, stopping).await, 0);
    }

    #[tokio::test]
    async fn a_refused_config_is_not_retried() {
        let (pid, _) = watch::channel(None);
        let (_stop, stopping) = watch::channel(false);
        assert_eq!(supervise(sh("exit 78"), pid, stopping).await, 78);
    }

    #[tokio::test]
    async fn a_crash_restarts_the_daemon() {
        let marker = std::env::temp_dir().join(format!("front-supervise-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        // Crashes on the first run, stops cleanly on the second: the second run is proof of the restart.
        let script = format!(
            "if [ -e {0} ]; then exit 0; fi; touch {0}; exit 3",
            marker.display()
        );
        let (pid, _) = watch::channel(None);
        let (_stop, stopping) = watch::channel(false);
        assert_eq!(supervise(sh(&script), pid, stopping).await, 0);
        let _ = std::fs::remove_file(&marker);
    }

    #[tokio::test]
    async fn stop_forwards_sigterm_and_waits_for_the_daemon() {
        let (pid, mut started) = watch::channel(None);
        let (stop, stopping) = watch::channel(false);
        let running = tokio::spawn(supervise(
            sh("trap 'exit 0' TERM; while :; do sleep 0.05; done"),
            pid,
            stopping,
        ));
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
}
