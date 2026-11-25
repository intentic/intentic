//! The control endpoint (`run --control <endpoint>`): how a machine agent finds and adopts this remoted, so that
//! people's terminals and screens outlive the agent restarting (an upgrade, a watchdog kill, a sign-in's handover).
//!
//! - **One remoted per environment.** `remoted.lock` beside the config is held locked for the process's life (the
//!   system lets go when it ends, however it ends), and `remoted.pid` beside it says who holds it. Only the lock's holder
//!   touches the endpoint's name: a socket left at the path is a dead remoted's, since its lock is free, and is replaced.
//!   A second remoted waits [`LOCK_PATIENCE`] for the lock (one asked to stop may still be leaving) and then exits 3.
//! - **The endpoint is its owner's alone**: a Unix socket made 0600 whose peer must run as the same user, or a named
//!   pipe whose access list names only this process's user and refuses remote clients.
//! - **The protocol**: lines of JSON. On every connection remoted first says
//!   `{type: "hello", protocol, accepts, build, pid, startedAt}`. The agent answers `{type: "adopt", protocol}` with a
//!   protocol `accepts` lists, and from then on gets every status line (the stdout ones) and `{type: "log", line}` for
//!   each log record. A newer adopter replaces the older (`{type: "replaced"}`, then closed); a protocol remoted does not
//!   accept is `{type: "refused", reason}`, then closed. `{type: "stop"}` ends remoted as a signal would. Unknown types
//!   are ignored. The hello and `stop` keep their shape in every protocol, so any agent can tell what it found and ask an
//!   incompatible remoted to leave.
//! - **Unadopted**, remoted leaves after [`IDLE_EXIT`] with nothing open for a person, and after [`ORPHAN_LIMIT`]
//!   whatever is open: an agent restarting comes back within seconds, and one gone longer is not showing the person at
//!   the computer who is connected, nor passing their pause on.
//!
//! [`PROTOCOL`] moves when a message's meaning changes; the one it replaces goes into [`PREVIOUS_PROTOCOLS`] while this
//! remoted still speaks it. `_tools/checks/remoted-protocol.mjs` holds both lists to the machine agent's
//! (`_devices/machine/src/device/remote/remoted-control.ts`) and refuses a change that drops the protocol main speaks.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;

use crate::status::Status;
use crate::token::now_ms;

/// The control protocol this remoted speaks.
pub const PROTOCOL: u32 = 1;
/// Protocols an adopter may still ask for: an agent of the release before this one must adopt it (and this release's
/// agent the remoted before it), so a protocol replaced is kept here.
pub const PREVIOUS_PROTOCOLS: &[u32] = &[];

/// Unadopted with nothing open for a person: how long before remoted leaves.
pub const IDLE_EXIT: Duration = Duration::from_secs(60);
/// Unadopted with something open: how long before remoted leaves anyway.
pub const ORPHAN_LIMIT: Duration = Duration::from_secs(10 * 60);
/// How long a starting remoted waits for the environment's lock.
pub const LOCK_PATIENCE: Duration = Duration::from_secs(5);
// Lines waiting for an adopter that is not reading: past it, logs are dropped (a status line is whole, so the next one
// says everything the dropped one did).
const OUTBOX: usize = 4096;
// A request line longer than this is not an agent's.
const MAX_LINE: usize = 64 * 1024;

/// Every protocol an adopter may ask for, the current one last.
pub fn accepts() -> Vec<u32> {
    PREVIOUS_PROTOCOLS
        .iter()
        .copied()
        .chain([PROTOCOL])
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol: u32,
    accepts: Vec<u32>,
    build: &'static str,
    pid: u32,
    started_at: u64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Ask {
    Adopt {
        protocol: u32,
    },
    Stop,
    #[serde(other)]
    Other,
}

// --- one remoted per environment ------------------------------------------------------------------------------------

/// The environment's lock, held until the process ends.
pub struct Claim {
    _lock: File,
    pid_path: PathBuf,
}

impl Claim {
    /// The pidfile goes with a graceful end; after a crash the next holder writes it again.
    pub fn release(self) {
        let _ = std::fs::remove_file(&self.pid_path);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PidRecord<'a> {
    pid: u32,
    protocol: u32,
    accepts: Vec<u32>,
    build: &'static str,
    control: &'a str,
    started_at: u64,
}

/// Takes `dir`'s `remoted.lock`, waiting up to `patience` for another remoted to let go, and writes `remoted.pid`.
pub fn claim(dir: &Path, endpoint: &str, patience: Duration) -> Result<Claim, String> {
    let lock_path = dir.join("remoted.lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("{}: {e}", lock_path.display()))?;
    let deadline = std::time::Instant::now() + patience;
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(format!(
                    "another intentic-remoted holds {} (see remoted.pid beside it)",
                    lock_path.display()
                ));
            }
            Err(std::fs::TryLockError::Error(e)) => {
                return Err(format!("{}: {e}", lock_path.display()));
            }
        }
    }
    let pid_path = dir.join("remoted.pid");
    let record = PidRecord {
        pid: std::process::id(),
        protocol: PROTOCOL,
        accepts: accepts(),
        build: crate::VERSION,
        control: endpoint,
        started_at: now_ms(),
    };
    let part = dir.join("remoted.pid.part");
    std::fs::write(
        &part,
        serde_json::to_string(&record).expect("a pid record serializes"),
    )
    .and_then(|()| std::fs::rename(&part, &pid_path))
    .map_err(|e| format!("{}: {e}", pid_path.display()))?;
    Ok(Claim {
        _lock: lock,
        pid_path,
    })
}

// --- the log, also to the adopter -----------------------------------------------------------------------------------

static TAP: Mutex<Option<(u64, mpsc::Sender<String>)>> = Mutex::new(None);

/// The log's writer under `--control`: stderr (a file the agent opened), and each record to the adopter as a `log` line.
pub struct LogTee;

impl Write for LogTee {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        // stderr may be a pipe whose reader left: the record still goes to the adopter.
        let _ = std::io::stderr().write_all(bytes);
        if let Some((_, tap)) = TAP.lock().expect("log tap poisoned").as_ref() {
            for line in String::from_utf8_lossy(bytes).lines() {
                if !line.trim().is_empty() {
                    let message = serde_json::json!({"type": "log", "line": line});
                    let _ = tap.try_send(message.to_string());
                }
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::stderr().flush()
    }
}

// --- adoption -------------------------------------------------------------------------------------------------------

struct Adoption {
    // The adopting connection and its kick.
    adopter: Option<(u64, Arc<Notify>)>,
    next: u64,
    unadopted_since: Instant,
}

/// Who adopted this remoted, and the wake for `stop`.
pub struct Control {
    status: Arc<Status>,
    started_at: u64,
    adoption: Mutex<Adoption>,
    moved: Notify,
    stop: Notify,
}

impl Control {
    pub fn new(status: Arc<Status>) -> Arc<Control> {
        Arc::new(Control {
            status,
            started_at: now_ms(),
            adoption: Mutex::new(Adoption {
                adopter: None,
                next: 0,
                unadopted_since: Instant::now(),
            }),
            moved: Notify::new(),
            stop: Notify::new(),
        })
    }

    fn hello(&self) -> String {
        serde_json::to_string(&Hello {
            kind: "hello",
            protocol: PROTOCOL,
            accepts: accepts(),
            build: crate::VERSION,
            pid: std::process::id(),
            started_at: self.started_at,
        })
        .expect("a hello serializes")
    }

    fn connection_id(&self) -> u64 {
        let mut adoption = self.adoption.lock().expect("adoption poisoned");
        adoption.next += 1;
        adoption.next
    }

    fn adopt(&self, id: u64, kick: Arc<Notify>, out: mpsc::Sender<String>) {
        let mut adoption = self.adoption.lock().expect("adoption poisoned");
        if let Some((_, older)) = adoption.adopter.replace((id, kick)) {
            older.notify_one();
        }
        *TAP.lock().expect("log tap poisoned") = Some((id, out));
        drop(adoption);
        self.moved.notify_waiters();
    }

    fn let_go(&self, id: u64) {
        let mut adoption = self.adoption.lock().expect("adoption poisoned");
        if adoption
            .adopter
            .as_ref()
            .is_some_and(|(held, _)| *held == id)
        {
            adoption.adopter = None;
            adoption.unadopted_since = Instant::now();
            let mut tap = TAP.lock().expect("log tap poisoned");
            if tap.as_ref().is_some_and(|(held, _)| *held == id) {
                *tap = None;
            }
            drop(tap);
            drop(adoption);
            self.moved.notify_waiters();
        }
    }

    /// Whether an agent holds this remoted now.
    pub fn adopted(&self) -> bool {
        self.adoption
            .lock()
            .expect("adoption poisoned")
            .adopter
            .is_some()
    }

    /// Serves one connection: the hello, then what the peer asks, until either end closes it.
    pub async fn serve<S>(self: Arc<Self>, conn: S)
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let id = self.connection_id();
        let (read, mut write) = tokio::io::split(conn);
        let (out, mut outbox) = mpsc::channel::<String>(OUTBOX);
        let writer = tokio::spawn(async move {
            while let Some(line) = outbox.recv().await {
                let sent = async {
                    write.write_all(line.as_bytes()).await?;
                    write.write_all(b"\n").await?;
                    write.flush().await
                };
                if sent.await.is_err() {
                    return;
                }
            }
        });
        let _ = out.try_send(self.hello());
        let kick = Arc::new(Notify::new());
        let mut forwarding: Option<tokio::task::JoinHandle<()>> = None;
        let mut lines = BufReader::new(read);
        let mut text = String::new();
        loop {
            text.clear();
            let mut bounded = (&mut lines).take(MAX_LINE as u64);
            let read = tokio::select! {
                read = bounded.read_line(&mut text) => read,
                () = kick.notified() => {
                    let _ = out.try_send(r#"{"type":"replaced"}"#.to_owned());
                    break;
                }
            };
            match read {
                Ok(0) | Err(_) => break,
                Ok(_) if !text.ends_with('\n') && text.len() >= MAX_LINE => break,
                Ok(_) => {}
            }
            match serde_json::from_str::<Ask>(text.trim()) {
                Ok(Ask::Adopt { protocol }) if !accepts().contains(&protocol) => {
                    let reason = format!(
                        "this remoted ({}) speaks control protocols {:?}, not {protocol}",
                        crate::VERSION,
                        accepts()
                    );
                    let _ = out.try_send(
                        serde_json::json!({"type": "refused", "reason": reason}).to_string(),
                    );
                    break;
                }
                Ok(Ask::Adopt { protocol }) => {
                    if forwarding.is_none() {
                        log::info!("adopted by a machine agent (control protocol {protocol})");
                        self.adopt(id, kick.clone(), out.clone());
                        let status = self.status.clone();
                        let lines_out = out.clone();
                        forwarding = Some(tokio::spawn(async move {
                            status
                                .each_line(|line| {
                                    !matches!(
                                        lines_out.try_send(line),
                                        Err(mpsc::error::TrySendError::Closed(_))
                                    )
                                })
                                .await;
                        }));
                    }
                }
                Ok(Ask::Stop) => {
                    log::info!("the machine agent asked it to stop");
                    let _ = out.try_send(r#"{"type":"stopping"}"#.to_owned());
                    self.stop.notify_one();
                }
                Ok(Ask::Other) | Err(_) => {}
            }
        }
        if let Some(task) = forwarding {
            task.abort();
            self.let_go(id);
            log::info!(
                "the machine agent let go of it; it leaves once nothing is open for {} s, or after {} min unadopted",
                IDLE_EXIT.as_secs(),
                ORPHAN_LIMIT.as_secs() / 60
            );
        }
        drop(out);
        let _ = writer.await;
    }

    /// Resolves with why remoted should end: an agent's `stop`, or too long unadopted.
    pub async fn ended(&self) -> &'static str {
        let mut quiet_since: Option<Instant> = None;
        loop {
            let moved = self.moved.notified();
            let changed = self.status.changed();
            let now = Instant::now();
            quiet_since = if self.status.busy() {
                None
            } else {
                Some(quiet_since.unwrap_or(now))
            };
            let deadline = {
                let adoption = self.adoption.lock().expect("adoption poisoned");
                adoption.adopter.is_none().then(|| {
                    let orphan = (
                        adoption.unadopted_since + ORPHAN_LIMIT,
                        "no machine agent adopted it for too long",
                    );
                    match quiet_since {
                        Some(quiet) => {
                            let idle = (
                                adoption.unadopted_since.max(quiet) + IDLE_EXIT,
                                "nobody adopted it and nothing was open",
                            );
                            if idle.0 <= orphan.0 { idle } else { orphan }
                        }
                        None => orphan,
                    }
                })
            };
            let expire = async {
                match deadline {
                    Some((at, _)) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                () = self.stop.notified() => return "the machine agent asked it to stop",
                () = moved => {}
                () = changed => {}
                () = expire => {
                    if let Some((_, why)) = deadline {
                        return why;
                    }
                }
            }
        }
    }
}

// --- the endpoint ---------------------------------------------------------------------------------------------------

/// Listens on `endpoint` and serves each connection; answers only when it cannot listen any more.
#[cfg(unix)]
pub async fn listen(endpoint: String, control: Arc<Control>) -> String {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let path = Path::new(&endpoint);
    // This process holds the lock, so whatever is at the path is a dead remoted's.
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return format!("{endpoint}: {e}"),
    }
    let listener = match tokio::net::UnixListener::bind(path) {
        Ok(listener) => listener,
        Err(e) => return format!("{endpoint}: {e}"),
    };
    let owner = match std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .and_then(|()| std::fs::metadata(path))
    {
        Ok(meta) => meta.uid(),
        Err(e) => return format!("{endpoint}: {e}"),
    };
    log::info!("control endpoint {endpoint}");
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                // The socket's mode already says so; a peer of another user is refused all the same.
                if stream.peer_cred().is_ok_and(|peer| peer.uid() == owner) {
                    tokio::spawn(control.clone().serve(stream));
                }
            }
            Err(e) => {
                log::warn!("control endpoint: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Listens on the named pipe `endpoint`, open to this process's user alone, and serves each connection.
#[cfg(windows)]
pub async fn listen(endpoint: String, control: Arc<Control>) -> String {
    use tokio::net::windows::named_pipe::ServerOptions;
    let descriptor = match crate::service::owner_only_descriptor() {
        Ok(descriptor) => descriptor,
        Err(e) => return format!("{endpoint}: {e}"),
    };
    let mut first = true;
    loop {
        // SAFETY: attributes naming a descriptor that lives for this whole function.
        let server = unsafe {
            let mut attributes = descriptor.attributes();
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    &endpoint,
                    std::ptr::from_mut(&mut attributes).cast(),
                )
        };
        let server = match server {
            Ok(server) => server,
            Err(e) if first => return format!("{endpoint}: {e}"),
            Err(e) => {
                log::warn!("control endpoint: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        if first {
            log::info!("control endpoint {endpoint}");
        }
        first = false;
        if server.connect().await.is_ok() {
            tokio::spawn(control.clone().serve(server));
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn listen(endpoint: String, _control: Arc<Control>) -> String {
    format!("{endpoint}: no control endpoint on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn connect(
        control: &Arc<Control>,
    ) -> (
        tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
    ) {
        let (ours, theirs) = tokio::io::duplex(1 << 16);
        tokio::spawn(control.clone().serve(theirs));
        let (read, write) = tokio::io::split(ours);
        (BufReader::new(read).lines(), write)
    }

    async fn next(
        lines: &mut tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
    ) -> serde_json::Value {
        loop {
            let line = lines.next_line().await.unwrap().expect("a line");
            let value: serde_json::Value = serde_json::from_str(&line).unwrap();
            if value["type"] != "log" {
                return value;
            }
        }
    }

    #[tokio::test]
    async fn every_connection_is_greeted_with_the_protocol_and_the_build() {
        let control = Control::new(Arc::new(Status::default()));
        let (mut lines, _write) = connect(&control).await;
        let hello = next(&mut lines).await;
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["protocol"], PROTOCOL);
        assert_eq!(hello["accepts"], serde_json::json!(accepts()));
        assert_eq!(hello["build"], crate::VERSION);
        assert_eq!(hello["pid"], std::process::id());
        assert!(!control.adopted());
    }

    #[tokio::test]
    async fn an_adopter_gets_the_status_and_a_protocol_not_accepted_is_refused() {
        let status = Arc::new(Status::default());
        let control = Control::new(status.clone());
        let (mut lines, mut write) = connect(&control).await;
        next(&mut lines).await;
        write.write_all(b"{\"type\":\"whatever\"}\n").await.unwrap();
        write
            .write_all(format!("{{\"type\":\"adopt\",\"protocol\":{PROTOCOL}}}\n").as_bytes())
            .await
            .unwrap();
        let first = next(&mut lines).await;
        assert_eq!(first["type"], "status");
        assert_eq!(first["terminals"], 0);
        assert!(control.adopted());
        status.terminals(2);
        assert_eq!(next(&mut lines).await["terminals"], 2);

        let (mut other, mut asks) = connect(&control).await;
        next(&mut other).await;
        asks.write_all(b"{\"type\":\"adopt\",\"protocol\":999}\n")
            .await
            .unwrap();
        let refused = next(&mut other).await;
        assert_eq!(refused["type"], "refused");
        assert!(other.next_line().await.unwrap().is_none());
        // The adopter it has is kept.
        assert!(control.adopted());
    }

    #[tokio::test]
    async fn a_newer_adopter_replaces_the_older_and_closing_lets_go() {
        let control = Control::new(Arc::new(Status::default()));
        let adopt = format!("{{\"type\":\"adopt\",\"protocol\":{PROTOCOL}}}\n");
        let (mut old, mut old_write) = connect(&control).await;
        next(&mut old).await;
        old_write.write_all(adopt.as_bytes()).await.unwrap();
        next(&mut old).await;
        let (mut new, mut new_write) = connect(&control).await;
        next(&mut new).await;
        new_write.write_all(adopt.as_bytes()).await.unwrap();
        assert_eq!(next(&mut new).await["type"], "status");
        assert_eq!(next(&mut old).await["type"], "replaced");
        assert!(control.adopted());
        drop(new_write);
        drop(new);
        tokio::time::timeout(Duration::from_secs(5), async {
            while control.adopted() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("closing lets go");
    }

    #[tokio::test]
    async fn stop_ends_it() {
        let control = Control::new(Arc::new(Status::default()));
        let (mut lines, mut write) = connect(&control).await;
        next(&mut lines).await;
        write.write_all(b"{\"type\":\"stop\"}\n").await.unwrap();
        assert_eq!(next(&mut lines).await["type"], "stopping");
        let why = tokio::time::timeout(Duration::from_secs(5), control.ended())
            .await
            .unwrap();
        assert_eq!(why, "the machine agent asked it to stop");
    }

    #[tokio::test(start_paused = true)]
    async fn unadopted_it_leaves_once_idle_and_with_something_open_after_the_orphan_limit() {
        let status = Arc::new(Status::default());
        let control = Control::new(status.clone());
        let started = Instant::now();
        assert_eq!(
            control.ended().await,
            "nobody adopted it and nothing was open"
        );
        assert_eq!(started.elapsed().as_secs(), IDLE_EXIT.as_secs());

        let status = Arc::new(Status::default());
        status.terminals(1);
        let control = Control::new(status.clone());
        let started = Instant::now();
        assert_eq!(
            control.ended().await,
            "no machine agent adopted it for too long"
        );
        assert_eq!(started.elapsed().as_secs(), ORPHAN_LIMIT.as_secs());
    }

    #[tokio::test(start_paused = true)]
    async fn adopted_it_stays_and_the_idle_clock_starts_when_the_last_terminal_ends() {
        let status = Arc::new(Status::default());
        status.terminals(1);
        let control = Control::new(status.clone());
        let (mut lines, mut write) = connect(&control).await;
        next(&mut lines).await;
        write
            .write_all(format!("{{\"type\":\"adopt\",\"protocol\":{PROTOCOL}}}\n").as_bytes())
            .await
            .unwrap();
        next(&mut lines).await;
        let ended = control.clone();
        let ending = tokio::spawn(async move { ended.ended().await });
        tokio::time::sleep(ORPHAN_LIMIT * 3).await;
        assert!(!ending.is_finished());
        drop(write);
        drop(lines);
        tokio::time::sleep(IDLE_EXIT * 2).await;
        assert!(!ending.is_finished(), "a terminal is still open");
        let quiet = Instant::now();
        status.terminals(0);
        assert_eq!(
            ending.await.unwrap(),
            "nobody adopted it and nothing was open"
        );
        assert_eq!(quiet.elapsed().as_secs(), IDLE_EXIT.as_secs());
    }

    #[test]
    fn one_remoted_holds_an_environment() {
        let dir = std::env::temp_dir().join(format!("remoted-claim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let held = claim(&dir, "/tmp/x.sock", Duration::ZERO).expect("the first claims it");
        let record: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("remoted.pid")).unwrap())
                .unwrap();
        assert_eq!(record["pid"], std::process::id());
        assert_eq!(record["control"], "/tmp/x.sock");
        let second = claim(&dir, "/tmp/x.sock", Duration::from_millis(200));
        assert!(second.is_err_and(|e| e.contains("another intentic-remoted")));
        held.release();
        assert!(!dir.join("remoted.pid").exists());
        // The lock goes with its file's handle (with the process, however it ends).
        claim(&dir, "/tmp/x.sock", Duration::ZERO).expect("free again");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
