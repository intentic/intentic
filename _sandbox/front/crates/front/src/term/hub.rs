//! One tmux control client per session, shared by every socket viewing it: the pane's output is decoded once and fanned
//! out through a bounded outbox per viewer, and a viewer that joins, or falls behind and drains, is handed a snapshot
//! cut exactly where its live output resumes.

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bytes::{Bytes, BytesMut};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, Command as Process};
use tokio::sync::{Notify, mpsc};

use super::control::{Event, Parser};
use super::screen::{self, PaneLocation};

/// tmux keeps 100k lines a pane; all of it on every attach would be tens of MB.
pub const HISTORY_LINES: u32 = 5000;

/// Past this much queued for one viewer, its output is dropped until it drains and takes a fresh snapshot.
pub const OUTBOX_HIGH: usize = 1024 * 1024;

// One hex byte per `send-keys -H` argument; a paste is sliced this wide so no command line grows unbounded.
const INPUT_CHUNK: usize = 1024;

// Inputs held while no pane is known yet, since eating the first keystroke reads as broken; past it they are dropped.
const QUEUED_INPUT_MAX: usize = 256;

// tmux's own words when it ends without an `%exit` saying any: its stderr, this much of it at most.
const STDERR_MAX: usize = 4096;

const READ_BUFFER: usize = 64 * 1024;

/// How the front runs tmux: `tmux` from PATH against the box's one server, the one Node's panes live on.
#[derive(Debug, Clone)]
pub struct Tmux {
    pub program: OsString,
    pub prefix: Vec<OsString>,
}

impl Default for Tmux {
    fn default() -> Self {
        Self {
            program: "tmux".into(),
            prefix: Vec::new(),
        }
    }
}

impl Tmux {
    // $TMUX in the front's own environment would make tmux refuse to attach as nested; a control client is not nesting.
    fn control(&self, argv: &[String]) -> std::io::Result<Child> {
        Process::new(&self.program)
            .args(&self.prefix)
            .arg("-C")
            .args(argv)
            .env_remove("TMUX")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Delivery {
    /// Owed the snapshot of this batch or a later one; live output before it is in that snapshot.
    Waiting(u64),
    Live,
    /// Fell behind: everything is dropped until the socket has drained.
    Stalled,
    /// Drained, and the socket has asked the hub for a snapshot.
    Resyncing,
}

struct Queue {
    bytes: BytesMut,
    delivery: Delivery,
    ended: Option<(i32, String)>,
}

/// What one socket has yet to send, filled by its hub or its log and emptied by the socket.
pub struct Outbox {
    queue: Mutex<Queue>,
    ready: Notify,
    room: Notify,
}

/// What a socket takes from its outbox next.
#[derive(Debug, PartialEq, Eq)]
pub enum Taken {
    Bytes(Bytes),
    /// Drained after a stall: the socket asks for a snapshot.
    Resync,
    Ended(i32, String),
    Nothing,
}

impl Outbox {
    fn new(delivery: Delivery) -> Self {
        Self {
            queue: Mutex::new(Queue {
                bytes: BytesMut::new(),
                delivery,
                ended: None,
            }),
            ready: Notify::new(),
            room: Notify::new(),
        }
    }

    /// An outbox a log fills from the start; its producer waits for room instead of dropping.
    pub fn live() -> Self {
        Self::new(Delivery::Live)
    }

    fn with<T>(&self, change: impl FnOnce(&mut Queue) -> T) -> T {
        let value = change(&mut self.queue.lock().expect("outbox poisoned"));
        self.ready.notify_one();
        value
    }

    fn output(&self, bytes: &[u8]) {
        self.with(|queue| {
            if queue.delivery != Delivery::Live {
                return;
            }
            queue.bytes.extend_from_slice(bytes);
            if queue.bytes.len() > OUTBOX_HIGH {
                queue.bytes = BytesMut::new();
                queue.delivery = Delivery::Stalled;
            }
        });
    }

    // A pane that changed under a live viewer redraws it too; a stalled one resyncs once it drains.
    fn cut(&self, batch: u64, snapshot: Option<&[u8]>, moved: bool) {
        self.with(|queue| {
            let owed = match queue.delivery {
                Delivery::Waiting(from) => from <= batch,
                Delivery::Live => moved,
                Delivery::Stalled | Delivery::Resyncing => false,
            };
            if owed {
                if let Some(snapshot) = snapshot {
                    queue.bytes.extend_from_slice(snapshot);
                }
                queue.delivery = Delivery::Live;
            }
        });
    }

    fn wait_for(&self, batch: u64) {
        self.with(|queue| queue.delivery = Delivery::Waiting(batch));
    }

    pub fn end(&self, code: i32, reason: String) {
        self.with(|queue| {
            queue.ended.get_or_insert((code, reason));
        });
    }

    /// Waits for room past the high mark instead of dropping: for a log, whose bytes exist nowhere else in order.
    pub async fn push(&self, bytes: &[u8]) {
        loop {
            let room = self.room.notified();
            let queued = self.with(|queue| {
                let fits = queue.bytes.len() < OUTBOX_HIGH;
                if fits {
                    queue.bytes.extend_from_slice(bytes);
                }
                fits
            });
            if queued {
                return;
            }
            room.await;
        }
    }

    /// At most `max` bytes, then the end once everything before it is taken.
    pub fn take(&self, max: usize) -> Taken {
        let mut queue = self.queue.lock().expect("outbox poisoned");
        if !queue.bytes.is_empty() {
            let length = queue.bytes.len().min(max);
            let bytes = queue.bytes.split_to(length).freeze();
            drop(queue);
            self.room.notify_one();
            return Taken::Bytes(bytes);
        }
        if let Some((code, reason)) = queue.ended.clone() {
            return Taken::Ended(code, reason);
        }
        if queue.delivery == Delivery::Stalled {
            queue.delivery = Delivery::Resyncing;
            return Taken::Resync;
        }
        Taken::Nothing
    }

    pub async fn changed(&self) {
        self.ready.notified().await;
    }
}

enum Command {
    Join {
        viewer: u64,
        outbox: Arc<Outbox>,
        cols: u16,
        rows: u16,
    },
    Leave {
        viewer: u64,
    },
    Input(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    Resync {
        viewer: u64,
    },
}

#[derive(Clone)]
struct Handle {
    id: u64,
    commands: mpsc::UnboundedSender<Command>,
}

/// Every session's hub, by session name.
pub struct Hubs {
    tmux: Tmux,
    hubs: Mutex<HashMap<String, Handle>>,
    next: AtomicU64,
}

/// One socket's seat at a hub; dropping it leaves.
pub struct Viewer {
    id: u64,
    pub outbox: Arc<Outbox>,
    commands: mpsc::UnboundedSender<Command>,
}

/// What a socket's reader sends its hub: keystrokes and sizes, from any viewer, into the one pane they share.
#[derive(Clone)]
pub struct Controls {
    commands: mpsc::UnboundedSender<Command>,
}

impl Controls {
    pub fn input(&self, bytes: Vec<u8>) {
        let _ = self.commands.send(Command::Input(bytes));
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.commands.send(Command::Resize { cols, rows });
    }
}

impl Viewer {
    pub fn controls(&self) -> Controls {
        Controls {
            commands: self.commands.clone(),
        }
    }

    pub fn resync(&self) {
        let _ = self.commands.send(Command::Resync { viewer: self.id });
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Leave { viewer: self.id });
    }
}

impl Hubs {
    pub fn new(tmux: Tmux) -> Arc<Self> {
        Arc::new(Self {
            tmux,
            hubs: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        })
    }

    /// Seats a viewer on `session`'s hub, starting one with `argv` when none is running.
    pub fn join(self: &Arc<Self>, session: &str, argv: &[String], cols: u16, rows: u16) -> Viewer {
        let outbox = Arc::new(Outbox::new(Delivery::Waiting(u64::MAX)));
        let viewer = self.next.fetch_add(1, Ordering::Relaxed);
        let mut hubs = self.hubs.lock().expect("hubs poisoned");
        let handle = match hubs.get(session) {
            Some(handle) => handle.clone(),
            None => {
                let handle = self.start(session, argv);
                hubs.insert(session.to_owned(), handle.clone());
                handle
            }
        };
        // Under the lock: a hub ends only with its queue empty under this same lock, so no join lands on one that ended.
        let _ = handle.commands.send(Command::Join {
            viewer,
            outbox: outbox.clone(),
            cols,
            rows,
        });
        Viewer {
            id: viewer,
            outbox,
            commands: handle.commands,
        }
    }

    fn start(self: &Arc<Self>, session: &str, argv: &[String]) -> Handle {
        let (commands, queue) = mpsc::unbounded_channel();
        let handle = Handle {
            id: self.next.fetch_add(1, Ordering::Relaxed),
            commands,
        };
        let hubs = self.clone();
        let session = session.to_owned();
        let argv = argv.to_vec();
        let id = handle.id;
        tokio::spawn(async move { hubs.run(session, id, argv, queue).await });
        handle
    }

    async fn run(
        self: Arc<Self>,
        session: String,
        id: u64,
        argv: Vec<String>,
        mut queue: mpsc::UnboundedReceiver<Command>,
    ) {
        let mut hub = Hub::default();
        let ended = match self.tmux.control(&argv) {
            Ok(child) => self.serve(&mut hub, child, &session, id, &mut queue).await,
            Err(error) => Some((1, format!("could not start tmux: {error}"))),
        };
        self.forget(&session, id);
        queue.close();
        let Some((code, reason)) = ended else {
            return;
        };
        tracing::debug!(%session, code, %reason, "a terminal session's control client ended");
        while let Ok(command) = queue.try_recv() {
            if let Command::Join { viewer, outbox, .. } = command {
                hub.viewers.insert(viewer, outbox);
            }
        }
        for outbox in hub.viewers.values() {
            outbox.end(code, reason.clone());
        }
    }

    fn forget(&self, session: &str, id: u64) {
        let mut hubs = self.hubs.lock().expect("hubs poisoned");
        if hubs.get(session).is_some_and(|handle| handle.id == id) {
            hubs.remove(session);
        }
    }

    // The client's exit as its viewers are told it, or none when it was ended for want of viewers.
    async fn serve(
        &self,
        hub: &mut Hub,
        mut child: Child,
        session: &str,
        id: u64,
        queue: &mut mpsc::UnboundedReceiver<Command>,
    ) -> Option<(i32, String)> {
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let (writes, pending) = mpsc::unbounded_channel();
        tokio::spawn(write_all(
            child.stdin.take().expect("stdin is piped"),
            pending,
        ));
        let stderr = tokio::spawn(read_stderr(child.stderr.take().expect("stderr is piped")));
        let mut parser = Parser::default();
        let mut events = Vec::new();
        let mut buffer = vec![0_u8; READ_BUFFER];
        let ended = loop {
            tokio::select! {
                read = stdout.read(&mut buffer) => {
                    let Ok(read @ 1..) = read else {
                        break None;
                    };
                    parser.feed(&buffer[..read], &mut events);
                    if let Some(exit) = events.drain(..).find_map(|event| hub.event(event)) {
                        break Some(exit);
                    }
                }
                command = queue.recv() => {
                    let Some(command) = command else {
                        break None;
                    };
                    hub.command(command);
                    if hub.viewers.is_empty() && self.idle(session, id, queue, hub) {
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        return None;
                    }
                }
            }
            let out = std::mem::take(&mut hub.out);
            if !out.is_empty() {
                let _ = writes.send(out);
            }
        };
        let status = match ended {
            Some(_) => {
                let _ = child.start_kill();
                child.wait().await
            }
            None => child.wait().await,
        };
        let stderr = stderr.await.unwrap_or_default();
        let attach_error = hub.attach_error.take();
        Some(match ended {
            Some((code, reason)) => (code, attach_error.unwrap_or(reason)),
            None => (
                status.ok().and_then(|status| status.code()).unwrap_or(1),
                attach_error.unwrap_or_else(|| stderr.trim().to_owned()),
            ),
        })
    }

    // Decided under the join lock with nothing queued: a join already queued keeps the hub running and is served next.
    fn idle(
        &self,
        session: &str,
        id: u64,
        queue: &mut mpsc::UnboundedReceiver<Command>,
        hub: &mut Hub,
    ) -> bool {
        let mut hubs = self.hubs.lock().expect("hubs poisoned");
        while let Ok(command) = queue.try_recv() {
            hub.command(command);
        }
        if !hub.viewers.is_empty() {
            return false;
        }
        if hubs.get(session).is_some_and(|handle| handle.id == id) {
            hubs.remove(session);
        }
        true
    }
}

async fn write_all(mut stdin: ChildStdin, mut pending: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(bytes) = pending.recv().await {
        if stdin.write_all(&bytes).await.is_err() {
            return;
        }
    }
}

async fn read_stderr(mut stderr: ChildStderr) -> String {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 1024];
    while let Ok(read @ 1..) = stderr.read(&mut buffer).await {
        let room = STDERR_MAX.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..read.min(room)]);
    }
    String::from_utf8_lossy(&kept).into_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    Location,
    State,
    Saved,
    Normal,
    Screen,
}

#[derive(Debug, Clone, Copy)]
enum Expect {
    Ignore,
    Part(u64, Part),
}

#[derive(Default)]
struct Parts {
    location: Option<Vec<Vec<u8>>>,
    state: Option<Vec<Vec<u8>>>,
    saved: Option<Vec<Vec<u8>>>,
    normal: Option<Vec<Vec<u8>>>,
    screen: Option<Vec<Vec<u8>>>,
}

fn first_line(lines: Option<&Vec<Vec<u8>>>) -> String {
    lines
        .and_then(|lines| lines.first())
        .map(|line| String::from_utf8_lossy(line).into_owned())
        .unwrap_or_default()
}

/// One control client's state: what it has asked and not yet heard, where its session stands, who watches.
#[derive(Default)]
struct Hub {
    viewers: HashMap<u64, Arc<Outbox>>,
    expected: VecDeque<Expect>,
    batch: u64,
    parts: Parts,
    location: Option<PaneLocation>,
    queued: Vec<Vec<u8>>,
    attach_error: Option<String>,
    out: Vec<u8>,
}

impl Hub {
    fn ask(&mut self, command: &str, expect: Expect) {
        self.out.extend_from_slice(command.as_bytes());
        self.out.push(b'\n');
        self.expected.push_back(expect);
    }

    // Where the client stands and what its pane shows, asked in one write so tmux answers them all at one moment: the
    // last reply is the cut, output before it is in the captures and output after it is new.
    fn snapshot(&mut self) -> u64 {
        self.batch += 1;
        let batch = self.batch;
        let history = format!("-S -{HISTORY_LINES}");
        self.ask(
            &format!("display-message -p -F '{}'", screen::LOCATION_FORMAT),
            Expect::Part(batch, Part::Location),
        );
        self.ask(
            &format!("display-message -p -F '{}'", screen::PANE_STATE_FORMAT),
            Expect::Part(batch, Part::State),
        );
        // `-a` is the screen saved under an alternate one, and an error without one; it has the history.
        self.ask(
            &format!("capture-pane -p -e -J -a {history}"),
            Expect::Part(batch, Part::Saved),
        );
        self.ask(
            &format!("capture-pane -p -e -J {history}"),
            Expect::Part(batch, Part::Normal),
        );
        self.ask("capture-pane -p -e -J", Expect::Part(batch, Part::Screen));
        batch
    }

    fn send_keys(&mut self, pane: &str, bytes: &[u8]) {
        for chunk in bytes.chunks(INPUT_CHUNK) {
            let mut command = format!("send-keys -t {pane} -H");
            for byte in chunk {
                let _ = write!(command, " {byte:02x}");
            }
            self.ask(&command, Expect::Ignore);
        }
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        self.ask(&format!("refresh-client -C {cols}x{rows}"), Expect::Ignore);
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Join {
                viewer,
                outbox,
                cols,
                rows,
            } => {
                self.resize(cols, rows);
                outbox.wait_for(self.snapshot());
                self.viewers.insert(viewer, outbox);
            }
            Command::Leave { viewer } => {
                self.viewers.remove(&viewer);
            }
            Command::Input(bytes) if bytes.is_empty() => {}
            Command::Input(bytes) => match self.location.as_ref().map(|at| at.pane.clone()) {
                Some(pane) => self.send_keys(&pane, &bytes),
                None if self.queued.len() < QUEUED_INPUT_MAX => self.queued.push(bytes),
                None => {}
            },
            Command::Resize { cols, rows } => self.resize(cols, rows),
            Command::Resync { viewer } => {
                if self.viewers.contains_key(&viewer) {
                    let batch = self.snapshot();
                    self.viewers[&viewer].wait_for(batch);
                }
            }
        }
    }

    // The client's exit when this event is it.
    fn event(&mut self, event: Event) -> Option<(i32, String)> {
        match event {
            Event::Output { pane, bytes } => {
                if self.location.as_ref().is_some_and(|at| at.pane == pane) {
                    for outbox in self.viewers.values() {
                        outbox.output(&bytes);
                    }
                }
            }
            Event::Reply { ok, initial, lines } => self.reply(ok, initial, lines),
            Event::Notice { name, args } => self.notice(&name, &args),
            Event::Exit { reason } => return Some((0, reason)),
        }
        None
    }

    fn reply(&mut self, ok: bool, initial: bool, lines: Vec<Vec<u8>>) {
        // The attach's own answer: a failure is followed by a bare `%exit`, so its words are kept for that.
        if initial {
            if !ok {
                let words: Vec<String> = lines
                    .iter()
                    .map(|line| String::from_utf8_lossy(line).into_owned())
                    .collect();
                self.attach_error = Some(words.join(" ").trim().to_owned());
            }
            return;
        }
        let Some(Expect::Part(batch, part)) = self.expected.pop_front() else {
            return;
        };
        let lines = ok.then_some(lines);
        match part {
            Part::Location => self.parts.location = lines,
            Part::State => self.parts.state = lines,
            Part::Saved => self.parts.saved = lines,
            Part::Normal => self.parts.normal = lines,
            Part::Screen => {
                self.parts.screen = lines;
                self.cut(batch);
            }
        }
    }

    fn cut(&mut self, batch: u64) {
        let parts = std::mem::take(&mut self.parts);
        let found = screen::location(&first_line(parts.location.as_ref()));
        let snapshot = screen::pane_state(&first_line(parts.state.as_ref())).map(|state| {
            if state.alternate {
                screen::synthesize(
                    parts.saved.as_deref().unwrap_or_default(),
                    Some(parts.screen.as_deref().unwrap_or_default()),
                    &state,
                )
            } else {
                screen::synthesize(parts.normal.as_deref().unwrap_or_default(), None, &state)
            }
        });
        let moved = found.as_ref().is_some_and(|found| {
            self.location
                .as_ref()
                .is_none_or(|at| at.pane != found.pane)
        });
        if let Some(found) = found {
            let pane = found.pane.clone();
            self.location = Some(found);
            for bytes in std::mem::take(&mut self.queued) {
                self.send_keys(&pane, &bytes);
            }
        }
        for outbox in self.viewers.values() {
            outbox.cut(batch, snapshot.as_deref(), moved);
        }
    }

    // Notices are broadcast to every control client on the server: the session or window each names is how one is told
    // apart as this client's own.
    fn notice(&mut self, name: &str, args: &str) {
        let Some(at) = &self.location else {
            return;
        };
        let (first, second) = args.split_once(' ').unwrap_or((args, ""));
        let follow = match name {
            "session-window-changed" => first == at.session && second != at.window,
            "window-pane-changed" => first == at.window && second != at.pane,
            "session-changed" => true,
            _ => false,
        };
        if follow {
            self.snapshot();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &[u8] = b"2 0 0 4294967295 4294967295 1 0 0 0 0 0 0 0 0 1 0 0 23 24 80 sh";

    fn lines(lines: &[&[u8]]) -> Vec<Vec<u8>> {
        lines.iter().map(|line| line.to_vec()).collect()
    }

    // Answers what the hub asked as tmux would, its next snapshot with the pane at `pane` showing `row`.
    fn answer(hub: &mut Hub, pane: &str, row: &[u8]) {
        while matches!(hub.expected.front(), Some(Expect::Ignore)) {
            hub.reply(true, false, Vec::new());
        }
        let location = format!("$1 {pane} @1");
        let replies: [(bool, Vec<Vec<u8>>); 5] = [
            (true, lines(&[location.as_bytes()])),
            (true, lines(&[STATE])),
            (false, lines(&[b"no alternate screen"])),
            (true, lines(&[b"history", row])),
            (true, lines(&[row])),
        ];
        for (ok, lines) in replies {
            hub.reply(ok, false, lines);
        }
    }

    fn joined(hub: &mut Hub, viewer: u64) -> Arc<Outbox> {
        let outbox = Arc::new(Outbox::new(Delivery::Waiting(u64::MAX)));
        hub.command(Command::Join {
            viewer,
            outbox: outbox.clone(),
            cols: 80,
            rows: 24,
        });
        outbox
    }

    fn taken(outbox: &Outbox) -> Vec<u8> {
        match outbox.take(usize::MAX) {
            Taken::Bytes(bytes) => bytes.to_vec(),
            other => panic!("expected bytes, took {other:?}"),
        }
    }

    fn output(pane: &str, bytes: &[u8]) -> Event {
        Event::Output {
            pane: pane.into(),
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn a_joiner_gets_its_snapshot_at_the_cut_and_only_what_follows_it() {
        let mut hub = Hub::default();
        let first = joined(&mut hub, 1);
        let asked = String::from_utf8(std::mem::take(&mut hub.out)).unwrap();
        assert!(asked.starts_with("refresh-client -C 80x24\ndisplay-message -p -F '#{session_id}"));
        assert_eq!(asked.lines().count(), 6);
        // Before the cut: in the capture, so never delivered on its own.
        hub.event(output("%3", b"before"));
        answer(&mut hub, "%3", b"$ ls");
        hub.event(output("%3", b"after"));
        let bytes = String::from_utf8(taken(&first)).unwrap();
        assert!(bytes.starts_with("\x1bchistory\r\n$ ls"));
        assert!(bytes.ends_with("after"));
        assert!(!bytes.contains("before"));
        assert_eq!(first.take(usize::MAX), Taken::Nothing);

        // A second viewer joins; the first keeps its live stream and is not redrawn.
        let second = joined(&mut hub, 2);
        hub.event(output("%3", b"meanwhile"));
        answer(&mut hub, "%3", b"$ ls");
        assert_eq!(taken(&first), b"meanwhile");
        assert!(taken(&second).starts_with(b"\x1bc"));
    }

    #[test]
    fn keystrokes_before_the_pane_is_known_are_sent_to_it_in_order_once_it_is() {
        let mut hub = Hub::default();
        let _viewer = joined(&mut hub, 1);
        hub.command(Command::Input(b"ab".to_vec()));
        hub.command(Command::Input(b"c".to_vec()));
        hub.out.clear();
        answer(&mut hub, "%9", b"$ ");
        let sent = String::from_utf8(std::mem::take(&mut hub.out)).unwrap();
        assert_eq!(sent, "send-keys -t %9 -H 61 62\nsend-keys -t %9 -H 63\n");
        hub.command(Command::Input(vec![0x1b; INPUT_CHUNK + 1]));
        let sent = String::from_utf8(std::mem::take(&mut hub.out)).unwrap();
        assert_eq!(sent.lines().count(), 2);
    }

    #[test]
    fn a_viewer_past_its_mark_stalls_then_resyncs_once_drained() {
        let mut hub = Hub::default();
        let slow = joined(&mut hub, 1);
        let fast = joined(&mut hub, 2);
        answer(&mut hub, "%3", b"$ ");
        answer(&mut hub, "%3", b"$ ");
        let _ = taken(&fast);
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..(OUTBOX_HIGH / chunk.len() + 1) {
            hub.event(output("%3", &chunk));
            let _ = taken(&fast);
        }
        // Dropped whole at the mark, not trimmed: a partial stream would draw a torn screen.
        assert_eq!(slow.take(usize::MAX), Taken::Resync);
        hub.event(output("%3", b"lost"));
        hub.command(Command::Resync { viewer: 1 });
        hub.event(output("%3", b"in the capture"));
        answer(&mut hub, "%3", b"$ caught up");
        let bytes = String::from_utf8(taken(&slow)).unwrap();
        assert!(bytes.starts_with("\x1bc"));
        assert!(bytes.contains("$ caught up"));
        assert!(!bytes.contains("lost") && !bytes.contains("in the capture"));
        assert!(taken(&fast).ends_with(b"in the capture"));
    }

    #[test]
    fn another_sessions_window_leaves_this_one_where_it_is_and_its_own_is_followed() {
        let mut hub = Hub::default();
        let viewer = joined(&mut hub, 1);
        answer(&mut hub, "%3", b"$ ");
        let _ = taken(&viewer);
        hub.out.clear();
        hub.event(Event::Notice {
            name: "session-window-changed".into(),
            args: "$2 @7".into(),
        });
        assert!(hub.out.is_empty());
        hub.event(Event::Notice {
            name: "session-window-changed".into(),
            args: "$1 @8".into(),
        });
        assert!(!hub.out.is_empty());
        // Another pane's output is never this tab's, not even the pane it is about to follow.
        hub.event(output("%4", b"new window"));
        assert_eq!(viewer.take(usize::MAX), Taken::Nothing);
        answer(&mut hub, "%4", b"second window");
        assert!(
            String::from_utf8(taken(&viewer))
                .unwrap()
                .contains("second window")
        );
    }

    #[test]
    fn a_failed_attach_ends_with_tmuxs_own_words() {
        let mut hub = Hub::default();
        let _viewer = joined(&mut hub, 1);
        hub.reply(false, true, lines(&[b"can't find session: gone"]));
        assert_eq!(
            hub.event(Event::Exit {
                reason: String::new()
            }),
            Some((0, String::new()))
        );
        assert_eq!(
            hub.attach_error.as_deref(),
            Some("can't find session: gone")
        );
    }

    #[tokio::test]
    async fn a_log_waits_for_room_instead_of_dropping() {
        let outbox = Arc::new(Outbox::live());
        outbox.push(&vec![b'a'; OUTBOX_HIGH]).await;
        let waiting = {
            let outbox = outbox.clone();
            tokio::spawn(async move { outbox.push(b"tail").await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!waiting.is_finished());
        assert_eq!(taken(&outbox).len(), OUTBOX_HIGH);
        waiting.await.unwrap();
        assert_eq!(taken(&outbox), b"tail");
    }
}
