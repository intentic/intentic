use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::say;
use super::wire::{Kind, Sealer, MAX_RECORD};
use crate::engine::moves;
use crate::util::{bail, Fail, Result};

/* A SECTION OF THE STREAM: one process's output on the source (a volume's tar, a `docker save`) becomes one process's
input on the target (its tar -x, a `docker load`), sealed record by record between them. engine/moves.rs's `pipe` does
the same between two docker CLIs on one PC; here the middle is the move's encrypted channel. A process that moves no
byte for the stall limit is killed rather than waited on, on either end. */

/// Run `command` and send its stdout as one section: Begin `begin`, its bytes, Finish `finish`. Answers the bytes sent.
#[allow(clippy::too_many_arguments)]
pub fn send(
    sealer: &mut Sealer,
    to: &mut impl Write,
    begin: &Value,
    mut command: Command,
    finish: &Value,
    slug: &str,
    step: &str,
    total: u64,
) -> Result<u64> {
    sealer.send(to, Kind::Begin, begin.to_string().as_bytes())?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| Fail(format!("could not run docker: {error}")))?;
    let said = moves::tail_of(child.stderr.take());
    let moved = Arc::new(AtomicU64::new(0));
    let mut watch = Watch::start(child.id(), Arc::clone(&moved));
    let mut input = child.stdout.take().expect("piped above");
    let mut buffer = vec![0u8; MAX_RECORD];
    let mut last_said = Instant::now();
    let mut sent: Result<()> = Ok(());
    loop {
        let read = match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                sent = Err(Fail(format!("reading it failed: {error}")));
                break;
            }
        };
        if let Err(error) = sealer.send(to, Kind::Data, &buffer[..read]) {
            sent = Err(error);
            break;
        }
        let done = moved.fetch_add(read as u64, Ordering::SeqCst) + read as u64;
        if last_said.elapsed() > Duration::from_secs(2) {
            last_said = Instant::now();
            say(
                slug,
                step,
                json!({ "done": done, "total": total.max(done) }),
            );
        }
    }
    if sent.is_err() {
        moves::kill_pid(child.id());
    }
    let status = child.wait();
    let stalled = watch.stop();
    sent?;
    if stalled {
        bail!(
            "reading it stopped moving for {} minutes.",
            moves::STALL.as_secs() / 60
        );
    }
    if !status.is_ok_and(|status| status.success()) {
        let words = said
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_default();
        bail!("reading it failed: {}", moves::copy_diagnostic(&words));
    }
    let done = moved.load(Ordering::SeqCst);
    say(
        slug,
        step,
        json!({ "done": done, "total": total.max(done) }),
    );
    sealer.send(to, Kind::Finish, finish.to_string().as_bytes())?;
    Ok(done)
}

/// The target's end of a section: a process whose stdin takes the section's bytes.
pub struct Incoming {
    child: Child,
    stdin: Option<ChildStdin>,
    said: std::sync::mpsc::Receiver<String>,
    moved: Arc<AtomicU64>,
    watch: Watch,
}

impl Incoming {
    pub fn start(mut command: Command) -> Result<Incoming> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| Fail(format!("could not run docker: {error}")))?;
        let said = moves::tail_of(child.stderr.take());
        let stdin = child.stdin.take();
        let moved = Arc::new(AtomicU64::new(0));
        let watch = Watch::start(child.id(), Arc::clone(&moved));
        Ok(Incoming {
            child,
            stdin,
            said,
            moved,
            watch,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<u64> {
        let stdin = self.stdin.as_mut().expect("open until closed");
        if let Err(error) = stdin.write_all(bytes) {
            let words = self
                .said
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or_default();
            bail!(
                "writing it failed ({error}): {}",
                moves::copy_diagnostic(&words)
            );
        }
        Ok(self.moved.fetch_add(bytes.len() as u64, Ordering::SeqCst) + bytes.len() as u64)
    }

    /// The section is over: end its input and wait for the process to say it took all of it.
    pub fn close(mut self) -> Result<u64> {
        drop(self.stdin.take());
        let status = self.child.wait();
        let stalled = self.watch.stop();
        if stalled {
            bail!(
                "writing it stopped moving for {} minutes.",
                moves::STALL.as_secs() / 60
            );
        }
        if !status.is_ok_and(|status| status.success()) {
            let words = self
                .said
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or_default();
            bail!("writing it failed: {}", moves::copy_diagnostic(&words));
        }
        Ok(self.moved.load(Ordering::SeqCst))
    }

    /// The stream broke mid-section: end the process without waiting on it.
    pub fn abandon(mut self) {
        moves::kill_pid(self.child.id());
        drop(self.stdin.take());
        let _ = self.child.wait();
        self.watch.stop();
    }
}

/// Kills a process that moves no byte for the stall limit.
struct Watch {
    finished: Arc<AtomicBool>,
    stalled: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Watch {
    fn start(pid: u32, moved: Arc<AtomicU64>) -> Watch {
        let finished = Arc::new(AtomicBool::new(false));
        let stalled = Arc::new(AtomicBool::new(false));
        let thread = {
            let finished = Arc::clone(&finished);
            let stalled = Arc::clone(&stalled);
            std::thread::spawn(move || {
                let mut last = 0u64;
                let mut since = Instant::now();
                while !finished.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(500));
                    let now = moved.load(Ordering::SeqCst);
                    if now != last {
                        last = now;
                        since = Instant::now();
                    } else if since.elapsed() > moves::STALL {
                        stalled.store(true, Ordering::SeqCst);
                        moves::kill_pid(pid);
                        return;
                    }
                }
            })
        };
        Watch {
            finished,
            stalled,
            thread: Some(thread),
        }
    }

    fn stop(&mut self) -> bool {
        self.finished.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.stalled.load(Ordering::SeqCst)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::wire::{agree, Keys, Role};
    use super::*;
    use std::io::Cursor;

    #[test]
    fn a_section_carries_a_processes_output_into_another_process() {
        let source = Keys::generate().unwrap();
        let target = Keys::generate().unwrap();
        let (sp, tp) = (source.public, target.public);
        let mut sending = agree(source, &tp, Role::Source, "m").unwrap();
        let mut receiving = agree(target, &sp, Role::Target, "m").unwrap();
        let mut wire = Vec::new();
        let mut command = Command::new("sh");
        command.args(["-c", "head -c 3000000 /dev/zero | tr '\\0' x"]);
        let sent = send(
            &mut sending.send,
            &mut wire,
            &json!({ "kind": "volume", "name": "v" }),
            command,
            &json!({ "files": 1 }),
            "s",
            "volume",
            3_000_000,
        )
        .unwrap();
        assert_eq!(sent, 3_000_000);
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out");
        let mut read = Cursor::new(wire);
        let (kind, begin) = receiving.receive.next(&mut read).unwrap();
        assert_eq!(
            (kind, begin),
            (Kind::Begin, br#"{"kind":"volume","name":"v"}"#.to_vec())
        );
        let mut command = Command::new("sh");
        command.args(["-c", &format!("cat > {}", out.display())]);
        let mut incoming = Incoming::start(command).unwrap();
        loop {
            let (kind, payload) = receiving.receive.next(&mut read).unwrap();
            match kind {
                Kind::Data => {
                    incoming.write(&payload).unwrap();
                }
                Kind::Finish => break,
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(incoming.close().unwrap(), 3_000_000);
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written.len(), 3_000_000);
        assert!(written.iter().all(|b| *b == b'x'));
    }

    #[test]
    fn a_failing_reader_is_a_failed_section() {
        let source = Keys::generate().unwrap();
        let target = Keys::generate().unwrap();
        let tp = target.public;
        let mut sending = agree(source, &tp, Role::Source, "m").unwrap();
        let mut command = Command::new("sh");
        command.args(["-c", "echo partial; echo 'tar: broken' >&2; exit 2"]);
        let error = send(
            &mut sending.send,
            &mut Vec::new(),
            &json!({}),
            command,
            &json!({}),
            "s",
            "volume",
            0,
        )
        .unwrap_err();
        assert!(error.0.contains("reading it failed"), "{}", error.0);
    }
}
