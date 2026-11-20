//! One terminal: its program on a pseudo-terminal (ConPTY on Windows, openpty elsewhere), the screen remoted keeps of it,
//! and the hub every viewer's socket is seated at. The hub is one task, so a viewer's snapshot is cut exactly where its
//! live output resumes: nothing the program wrote is in both, and nothing in neither.
//!
//! The grid is netd's rule: the smallest columns and rows across the viewers that show the terminal and may type in it,
//! recomputed on join, resize, `away` and leave, and applied to the pseudo-terminal only when it changes. A read-only
//! viewer is drawn the grid and bounds nothing, as castd ignores a read-only viewer's resize.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{ChildKiller, MasterPty, PtySize};
use tokio::sync::{mpsc, oneshot};

use super::outbox::Outbox;
use super::screen::Screen;
use super::shell::Launch;

// What the reader thread hands the hub at once.
const READ_CHUNK: usize = 64 * 1024;

// Chunks in flight from the reader to the hub; past it the reader waits, and so does the program's output.
const READ_QUEUE: usize = 64;

// After the program exits, output still on its way is waited for until the pseudo-terminal goes quiet this long...
const DRAIN_QUIET: Duration = Duration::from_millis(200);

// ...and no longer than this in all: on Windows the reader only ends once the pseudo-console is closed.
const DRAIN_MAX: Duration = Duration::from_secs(2);

/// What a terminal is, as `GET /terminals` lists it.
pub struct Info {
    pub session: String,
    pub environment: String,
    pub created_at: u64,
    pub title: Mutex<String>,
    pub viewers: AtomicUsize,
}

enum Command {
    Join {
        viewer: u64,
        outbox: Arc<Outbox>,
        cols: u16,
        rows: u16,
        shown: bool,
        read_only: bool,
    },
    Leave {
        viewer: u64,
    },
    Input(Vec<u8>),
    Resize {
        viewer: u64,
        cols: u16,
        rows: u16,
    },
    Away {
        viewer: u64,
    },
    Resync {
        viewer: u64,
    },
    End {
        reason: String,
    },
}

/// A running terminal.
pub struct Session {
    pub info: Arc<Info>,
    commands: mpsc::UnboundedSender<Command>,
}

/// One viewer's seat at a terminal; dropping it leaves.
pub struct Seat {
    pub outbox: Arc<Outbox>,
    controls: Controls,
}

/// What a viewer's reader sends its terminal: keystrokes and sizes.
#[derive(Clone)]
pub struct Controls {
    viewer: u64,
    commands: mpsc::UnboundedSender<Command>,
}

impl Controls {
    pub fn input(&self, bytes: Vec<u8>) {
        let _ = self.commands.send(Command::Input(bytes));
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.commands.send(Command::Resize {
            viewer: self.viewer,
            cols,
            rows,
        });
    }

    pub fn away(&self) {
        let _ = self.commands.send(Command::Away {
            viewer: self.viewer,
        });
    }
}

impl Seat {
    pub fn controls(&self) -> Controls {
        self.controls.clone()
    }

    pub fn resync(&self) {
        let _ = self.controls.commands.send(Command::Resync {
            viewer: self.controls.viewer,
        });
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        let _ = self.controls.commands.send(Command::Leave {
            viewer: self.controls.viewer,
        });
    }
}

/// How a terminal ended, for its viewers' `exit` message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub code: i32,
    pub reason: Option<String>,
}

impl Session {
    /// Starts `launch` on a pseudo-terminal of `cols` x `rows`; `ended` is called once, as the terminal ends.
    pub fn start(
        session: String,
        environment: String,
        launch: Launch,
        cols: u16,
        rows: u16,
        ended: impl FnOnce(Ended) + Send + 'static,
    ) -> anyhow::Result<Arc<Self>> {
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = portable_pty::native_pty_system().openpty(size)?;
        let mut child = pair.slave.spawn_command(launch.command)?;
        // The program holds its own end now; ours closing is what tells a Unix reader the program is gone.
        drop(pair.slave);
        let killer = child.clone_killer();
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let (output, chunks) = mpsc::channel(READ_QUEUE);
        std::thread::Builder::new()
            .name(format!("pty-read-{session}"))
            .spawn(move || read_into(reader, output))?;
        let (writes, pending) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::Builder::new()
            .name(format!("pty-write-{session}"))
            .spawn(move || write_from(writer, pending))?;
        let (exited, exit) = oneshot::channel();
        std::thread::Builder::new()
            .name(format!("pty-wait-{session}"))
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => i32::try_from(status.exit_code()).unwrap_or(i32::MAX),
                    Err(_) => -1,
                };
                let _ = exited.send(code);
            })?;

        let info = Arc::new(Info {
            session,
            environment,
            created_at: crate::token::now_ms(),
            title: Mutex::new(launch.title),
            viewers: AtomicUsize::new(0),
        });
        let (commands, queue) = mpsc::unbounded_channel();
        let hub = Hub {
            screen: Screen::new(cols, rows),
            master: Some(pair.master),
            writes,
            viewers: HashMap::new(),
            grid: (cols, rows),
            info: info.clone(),
        };
        tokio::spawn(hub.run(queue, chunks, exit, killer, ended));
        Ok(Arc::new(Self { info, commands }))
    }

    /// Seats a viewer: it is drawn the screen as it stands, then everything after. `shown` false for a socket opened out
    /// of sight (`away=1`).
    pub fn join(&self, viewer: u64, cols: u16, rows: u16, shown: bool, read_only: bool) -> Seat {
        let outbox = Arc::new(Outbox::default());
        let _ = self.commands.send(Command::Join {
            viewer,
            outbox: outbox.clone(),
            cols,
            rows,
            shown,
            read_only,
        });
        Seat {
            outbox,
            controls: Controls {
                viewer,
                commands: self.commands.clone(),
            },
        }
    }

    /// Ends the program, and with it the terminal; its viewers are told `reason`.
    pub fn end(&self, reason: &str) {
        let _ = self.commands.send(Command::End {
            reason: reason.to_owned(),
        });
    }
}

fn read_into(mut reader: Box<dyn Read + Send>, output: mpsc::Sender<Vec<u8>>) {
    let mut buffer = vec![0_u8; READ_CHUNK];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                if output.blocking_send(buffer[..read].to_vec()).is_err() {
                    return;
                }
            }
        }
    }
}

fn write_from(mut writer: Box<dyn Write + Send>, pending: std::sync::mpsc::Receiver<Vec<u8>>) {
    while let Ok(bytes) = pending.recv() {
        if writer
            .write_all(&bytes)
            .and_then(|()| writer.flush())
            .is_err()
        {
            return;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Viewport {
    cols: u16,
    rows: u16,
    shown: bool,
}

struct Viewer {
    outbox: Arc<Outbox>,
    // None for a read-only viewer: it bounds nothing.
    viewport: Option<Viewport>,
}

struct Hub {
    screen: Screen,
    master: Option<Box<dyn MasterPty + Send>>,
    writes: std::sync::mpsc::Sender<Vec<u8>>,
    viewers: HashMap<u64, Viewer>,
    grid: (u16, u16),
    info: Arc<Info>,
}

impl Hub {
    async fn run(
        mut self,
        mut queue: mpsc::UnboundedReceiver<Command>,
        mut chunks: mpsc::Receiver<Vec<u8>>,
        mut exit: oneshot::Receiver<i32>,
        killer: Box<dyn ChildKiller + Send + Sync>,
        ended: impl FnOnce(Ended) + Send + 'static,
    ) {
        let mut killer = killer;
        let mut reason: Option<String> = None;
        let mut code: Option<i32> = None;
        let mut reading = true;
        let mut quiet_until = tokio::time::Instant::now();
        let mut drain_until = tokio::time::Instant::now();
        loop {
            if code.is_some() && (!reading || tokio::time::Instant::now() >= drain_until) {
                break;
            }
            tokio::select! {
                chunk = chunks.recv(), if reading => match chunk {
                    Some(bytes) => {
                        self.output(&bytes);
                        quiet_until = tokio::time::Instant::now() + DRAIN_QUIET;
                    }
                    None => reading = false,
                },
                command = queue.recv() => match command {
                    Some(Command::End { reason: said }) => {
                        reason.get_or_insert(said);
                        let _ = killer.kill();
                    }
                    Some(command) => self.command(command),
                    // Every handle is gone (remoted is ending): the program goes with it.
                    None => {
                        let _ = killer.kill();
                        reason.get_or_insert_with(|| "remoted stopped".to_owned());
                        break;
                    }
                },
                status = &mut exit, if code.is_none() => {
                    code = Some(status.unwrap_or(-1));
                    let now = tokio::time::Instant::now();
                    quiet_until = now + DRAIN_QUIET;
                    drain_until = now + DRAIN_MAX;
                },
                () = tokio::time::sleep_until(quiet_until.min(drain_until)), if code.is_some() => {
                    if tokio::time::Instant::now() >= quiet_until {
                        break;
                    }
                },
            }
        }
        let ending = Ended {
            code: code.unwrap_or(-1),
            reason,
        };
        for viewer in self.viewers.values() {
            viewer.outbox.end(ending.code, ending.reason.clone());
        }
        // Closing a pseudo-console waits on its host: off the runtime's threads.
        if let Some(master) = self.master.take() {
            tokio::task::spawn_blocking(move || drop(master));
        }
        ended(ending);
        // Viewers that join between the end and their socket's next look are told too.
        queue.close();
        while let Some(command) = queue.recv().await {
            if let Command::Join { outbox, .. } = command {
                outbox.end(-1, Some("this terminal has ended".to_owned()));
            }
        }
    }

    fn output(&mut self, bytes: &[u8]) {
        let (forwarded, replies) = self.screen.output(bytes);
        if !replies.is_empty() {
            let _ = self.writes.send(replies);
        }
        if let Some(title) = self.screen.title() {
            let mut held = self.info.title.lock().expect("title poisoned");
            if *held != title {
                title.clone_into(&mut held);
            }
        }
        if forwarded.is_empty() {
            return;
        }
        for viewer in self.viewers.values() {
            viewer.outbox.output(&forwarded);
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Join {
                viewer,
                outbox,
                cols,
                rows,
                shown,
                read_only,
            } => {
                let viewport =
                    (!read_only && cols > 0 && rows > 0).then_some(Viewport { cols, rows, shown });
                self.viewers.insert(
                    viewer,
                    Viewer {
                        outbox: outbox.clone(),
                        viewport,
                    },
                );
                self.info
                    .viewers
                    .store(self.viewers.len(), Ordering::Relaxed);
                self.reconcile_grid();
                outbox.grid(self.grid.0, self.grid.1);
                outbox.snapshot(&self.screen.snapshot());
            }
            Command::Leave { viewer } => {
                self.viewers.remove(&viewer);
                self.info
                    .viewers
                    .store(self.viewers.len(), Ordering::Relaxed);
                self.reconcile_grid();
            }
            Command::Input(bytes) => {
                if !bytes.is_empty() {
                    let _ = self.writes.send(bytes);
                }
            }
            Command::Resize { viewer, cols, rows } => {
                if let Some(seated) = self.viewers.get_mut(&viewer)
                    && let Some(viewport) = seated.viewport.as_mut()
                    && cols > 0
                    && rows > 0
                {
                    *viewport = Viewport {
                        cols,
                        rows,
                        shown: true,
                    };
                    self.reconcile_grid();
                }
            }
            Command::Away { viewer } => {
                if let Some(viewport) = self
                    .viewers
                    .get_mut(&viewer)
                    .and_then(|seated| seated.viewport.as_mut())
                {
                    viewport.shown = false;
                    self.reconcile_grid();
                }
            }
            Command::Resync { viewer } => {
                if let Some(seated) = self.viewers.get(&viewer) {
                    seated.outbox.grid(self.grid.0, self.grid.1);
                    seated.outbox.snapshot(&self.screen.snapshot());
                }
            }
            Command::End { .. } => {}
        }
    }

    // Per-axis minima over the viewers in sight that may type; with none in sight the grid stays where it is.
    fn reconcile_grid(&mut self) {
        let Some(grid) = self
            .viewers
            .values()
            .filter_map(|viewer| viewer.viewport)
            .filter(|viewport| viewport.shown)
            .map(|viewport| (viewport.cols, viewport.rows))
            .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1)))
        else {
            return;
        };
        if grid == self.grid {
            return;
        }
        self.grid = grid;
        let (cols, rows) = grid;
        if let Some(master) = &self.master
            && let Err(error) = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
        {
            log::warn!(
                "terminal {}: resize to {cols}x{rows} failed: {error}",
                self.info.session
            );
        }
        self.screen.resize(cols, rows);
        for viewer in self.viewers.values() {
            viewer.outbox.grid(cols, rows);
        }
    }
}
