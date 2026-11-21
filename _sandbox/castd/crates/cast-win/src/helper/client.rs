//! remoted's end of the helper's pipe: one [`Link`] per process, shared by every screen; each duplication the helper
//! runs for a screen is routed by its id to that screen's [`DupOut`], so the capture reads the helper's rectangles
//! exactly as it reads its own thread's. The link checks the helper before trusting it: the pipe's server process must
//! be in this session and run from the path the service was installed to, which only an administrator can write.

use super::pipe::{self, Pipe};
use super::proto::{FromHelper, Input, PROTOCOL, ToHelper};
use crate::capture::DupOut;
use crate::d3d::Shared;
use cast_core::input::{InputEvent, InputSink};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// How long a monitor may take to open in the helper (its first duplication, a device on its GPU).
const OPEN_PATIENCE: Duration = Duration::from_secs(10);

type Waiter = mpsc::SyncSender<Result<(u64, (u32, u32)), String>>;

pub struct Link {
    pipe: Arc<Pipe>,
    routes: Mutex<HashMap<u64, Arc<dyn DupOut>>>,
    waiting: Mutex<HashMap<u64, Waiter>>,
    next: AtomicU64,
    alive: AtomicBool,
    /// The helper's version (the service's binary).
    pub version: String,
}

impl Link {
    /// Connects to the helper at `name` (this session's), checks the pipe is owned by one of `server_owners` and its
    /// process runs from `server_image`, says hello with `secret`, and starts reading its messages. (A process of the
    /// user may not ask a SYSTEM process's session; the pipe's name is the session's.)
    pub fn connect(
        name: &str,
        secret: &str,
        server_image: Option<&Path>,
        server_owners: Option<&[&str]>,
    ) -> Result<Arc<Link>, String> {
        let pipe = Pipe::open(name, 200)?;
        let pid = pipe.peer_pid().ok_or("the helper's process is unknown")?;
        if let Some(want) = server_owners {
            let owner = pipe.owner_sid().ok_or("the pipe's owner is unknown")?;
            if !want.contains(&owner.as_str()) {
                return Err(format!("the pipe is owned by {owner}, not by any of {want:?}"));
            }
        }
        if let (Some(theirs), Some(ours)) =
            (pipe::process_session(pid), pipe::process_session(std::process::id()))
            && theirs != ours
        {
            return Err(format!("the helper (pid {pid}) is in session {theirs}, not {ours}"));
        }
        if let Some(want) = server_image {
            // A process the user may not open (a SYSTEM one with the default access list) cannot be asked: the owner
            // check above stands for it then.
            match pipe::process_image(pid) {
                Some(image) if !pipe::same_path(&image, want) => {
                    return Err(format!(
                        "the pipe's server runs {} rather than the service's {}",
                        image.display(),
                        want.display()
                    ));
                }
                Some(_) => {}
                None if server_owners.is_some() => {}
                None => return Err(format!("the helper's image (pid {pid}) is unknown")),
            }
        }
        pipe.send(&ToHelper::Hello {
            protocol: PROTOCOL,
            secret: secret.to_owned(),
        })?;
        let version = match pipe.recv::<FromHelper>()? {
            FromHelper::Welcome { protocol, version } if protocol == PROTOCOL => version,
            FromHelper::Welcome { protocol, version } => {
                return Err(format!(
                    "the helper ({version}) speaks protocol {protocol}, this remoted {PROTOCOL}: set the service up again"
                ));
            }
            FromHelper::Refused { why } => return Err(format!("the helper refused: {why}")),
            other => return Err(format!("the helper answered {other:?}")),
        };
        let link = Arc::new(Link {
            pipe: Arc::new(pipe),
            routes: Mutex::new(HashMap::new()),
            waiting: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            version,
        });
        let reading = link.clone();
        std::thread::Builder::new()
            .name("helper-link".into())
            .spawn(move || reading.read())
            .map_err(|e| e.to_string())?;
        log::info!("the lock screen and admin prompts helper is connected (pid {pid}, {})", link.version);
        Ok(link)
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    fn read(self: Arc<Self>) {
        let why = loop {
            match self.pipe.recv::<FromHelper>() {
                Ok(message) => self.dispatch(message),
                Err(e) => break e,
            }
        };
        self.alive.store(false, Ordering::Relaxed);
        log::warn!("the lock screen and admin prompts helper went away ({why}); screens capture by themselves");
        for (_, waiter) in self.waiting.lock().drain() {
            let _ = waiter.send(Err("the helper went away".into()));
        }
        // Each screen on the helper opens its capture again, here this time.
        for (_, out) in self.routes.lock().drain() {
            out.rebuild();
        }
    }

    fn route(&self, id: u64) -> Option<Arc<dyn DupOut>> {
        self.routes.lock().get(&id).cloned()
    }

    fn dispatch(&self, message: FromHelper) {
        match message {
            FromHelper::Opened {
                id,
                handle,
                width,
                height,
            } => {
                if let Some(waiter) = self.waiting.lock().remove(&id) {
                    let _ = waiter.send(Ok((handle, (width, height))));
                }
            }
            FromHelper::OpenFailed { id, why } => {
                if let Some(waiter) = self.waiting.lock().remove(&id) {
                    let _ = waiter.send(Err(why));
                }
            }
            FromHelper::Rects { id, rects } => {
                if let Some(out) = self.route(id) {
                    let rects: Vec<(u32, u32, u32, u32)> = rects.into_iter().map(|[a, b, c, d]| (a, b, c, d)).collect();
                    out.rects(&rects);
                }
            }
            FromHelper::Rebuild { id } => self.route(id).into_iter().for_each(|out| out.rebuild()),
            FromHelper::Gone { id, why } => self.route(id).into_iter().for_each(|out| out.gone(why.clone())),
            FromHelper::Fallback { id, why } => self.route(id).into_iter().for_each(|out| out.fallback(why.clone())),
            FromHelper::Cursor { id, cursor } => self.route(id).into_iter().for_each(|out| out.cursor(cursor.clone())),
            FromHelper::Status { id, status } => self.route(id).into_iter().for_each(|out| out.status(status.clone())),
            FromHelper::Welcome { .. } | FromHelper::Refused { .. } | FromHelper::Uninstalling => {}
        }
    }

    /// Has the helper duplicate `monitor`, its rectangles and pointer going to `out`: the lease (closing it on the
    /// helper when dropped), the mirror's handle, and its size.
    pub(crate) fn open(
        self: &Arc<Self>,
        monitor: &str,
        out: Arc<dyn DupOut>,
    ) -> Result<(Lease, Shared, (u32, u32)), String> {
        if !self.alive() {
            return Err("the helper went away".into());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        // Routed before it is asked for: the first rectangles may arrive with the answer.
        self.routes.lock().insert(id, out);
        self.waiting.lock().insert(id, tx);
        let lease = Lease {
            link: self.clone(),
            id,
        };
        self.pipe.send(&ToHelper::Open {
            id,
            monitor: monitor.to_owned(),
        })?;
        let (handle, size) = rx
            .recv_timeout(OPEN_PATIENCE)
            .map_err(|_| format!("the helper did not open {monitor} within {OPEN_PATIENCE:?}"))??;
        Ok((lease, Shared::from_raw(handle), size))
    }

    /// Asks the service behind the helper to remove itself (no administrator needed: it only takes away).
    pub fn uninstall(&self) -> Result<(), String> {
        self.pipe.send(&ToHelper::Uninstall)
    }

    /// Sends a viewer's input for `monitor` to the helper; false when it is gone (the caller types it itself).
    pub fn input(&self, monitor: &str, ev: &InputEvent) -> bool {
        if !self.alive() {
            return false;
        }
        let Some(event) = Input::from_event(ev) else {
            return true;
        };
        self.pipe
            .send(&ToHelper::Input {
                monitor: monitor.to_owned(),
                event,
            })
            .is_ok()
    }
}

/// One duplication the helper runs for a screen: closed there when the capture drops it.
pub struct Lease {
    link: Arc<Link>,
    id: u64,
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.link.routes.lock().remove(&self.id);
        self.link.waiting.lock().remove(&self.id);
        if self.link.alive() {
            let _ = self.link.pipe.send(&ToHelper::Close { id: self.id });
        }
    }
}

/// Input for one monitor: to the helper while it is connected (it types on whichever desktop takes input, a secure
/// one or an elevated window included), else here, with this process's own SendInput. The clipboard is always this
/// process's: the person's clipboard is their session's.
pub struct Forward {
    pub monitor: String,
    pub finder: Arc<dyn super::Finder>,
    pub local: crate::input::Sink,
    pub clipboard: Option<crate::clipboard::Clipboard>,
}

impl InputSink for Forward {
    fn types_key(key: &str, code: Option<&str>) -> bool {
        <crate::input::Sink as InputSink>::types_key(key, code)
    }

    fn handle(&mut self, ev: InputEvent) {
        if let InputEvent::Clipboard(content) = ev {
            if let Some(c) = &self.clipboard {
                c.set(content);
            }
            return;
        }
        let shutdown = matches!(ev, InputEvent::Shutdown);
        if let Some(link) = self.finder.current()
            && link.input(&self.monitor, &ev)
        {
            if shutdown {
                self.local.handle(ev);
            }
            return;
        }
        self.local.handle(ev);
    }
}
