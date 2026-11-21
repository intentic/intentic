//! The helper's end of one connection: it duplicates the monitors remoted asks for (following the input desktop onto
//! the secure one, which it may open as SYSTEM), shares each mirror with remoted's process, and types remoted's input
//! where input goes. A Delete pressed with Ctrl and Alt held is not typed (SendInput cannot make a secure attention
//! sequence) but becomes one, sent by the service.

use super::pipe::Pipe;
use super::proto::{FromHelper, Input, PROTOCOL, ToHelper};
use crate::capture::{self, CursorState, DupOut, Open};
use crate::session::CaptureStatus;
use browser_wire::{KeyAction, MediaCursor};
use cast_core::input::InputEvent;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use windows::Win32::Foundation::{CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE};

pub struct Options {
    /// What a hello must carry: the secret the service wrote for the person's remoted to read.
    pub secret: String,
    /// The helper's version, said in the welcome.
    pub version: String,
    /// Sends a secure attention sequence (Ctrl+Alt+Del): the service's to do, as only a service may.
    pub sas: Arc<dyn Fn() + Send + Sync>,
    /// How many monitors are duplicated now across every connection: the notice shows while it is above zero.
    pub watched: Arc<AtomicUsize>,
    /// Asks the service to remove itself.
    pub uninstall: Arc<dyn Fn() + Send + Sync>,
}

/// Rectangles, the pointer and statuses of one duplication, down the pipe.
struct PipeOut {
    pipe: Arc<Pipe>,
    id: u64,
}

impl DupOut for PipeOut {
    fn rects(&self, rects: &[(u32, u32, u32, u32)]) {
        let rects = rects.iter().map(|&(a, b, c, d)| [a, b, c, d]).collect();
        let _ = self.pipe.send(&FromHelper::Rects { id: self.id, rects });
    }
    fn rebuild(&self) {
        let _ = self.pipe.send(&FromHelper::Rebuild { id: self.id });
    }
    fn gone(&self, why: String) {
        let _ = self.pipe.send(&FromHelper::Gone { id: self.id, why });
    }
    fn fallback(&self, why: String) {
        let _ = self.pipe.send(&FromHelper::Fallback { id: self.id, why });
    }
    fn cursor(&self, cursor: MediaCursor) {
        let _ = self.pipe.send(&FromHelper::Cursor { id: self.id, cursor });
    }
    fn status(&self, status: CaptureStatus) {
        let _ = self.pipe.send(&FromHelper::Status { id: self.id, status });
    }
}

struct Running {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Which keys each viewer holds that make Ctrl+Alt+Del.
#[derive(Default)]
struct Chord {
    held: HashMap<u64, HashSet<&'static str>>,
    /// Deletes turned into a secure attention sequence, whose key-up is not typed either.
    swallowed: HashSet<u64>,
}

/// What becomes of one input event.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Type,
    /// The Delete of a Ctrl+Alt+Del: a secure attention sequence, not a key.
    Sas,
    /// That Delete's key-up: nothing.
    Swallow,
}

impl Chord {
    fn judge(&mut self, ev: &Input) -> Verdict {
        let Input::Key {
            client,
            key,
            code,
            action,
            mods,
            ..
        } = ev
        else {
            if let Input::ReleaseAll { client } = ev {
                self.held.remove(client);
                self.swallowed.remove(client);
            }
            return Verdict::Type;
        };
        let which = match (key.as_str(), code.as_deref()) {
            ("Control", _) | (_, Some("ControlLeft" | "ControlRight")) => Some("ctrl"),
            ("Alt", _) | (_, Some("AltLeft" | "AltRight")) => Some("alt"),
            _ => None,
        };
        let held = self.held.entry(*client).or_default();
        if let Some(m) = which {
            match action {
                KeyAction::Down => {
                    held.insert(m);
                }
                KeyAction::Up => {
                    held.remove(m);
                }
                KeyAction::Press => {}
            }
            return Verdict::Type;
        }
        if key != "Delete" && code.as_deref() != Some("Delete") {
            return Verdict::Type;
        }
        match action {
            KeyAction::Up if self.swallowed.remove(client) => Verdict::Swallow,
            KeyAction::Up => Verdict::Type,
            KeyAction::Down | KeyAction::Press => {
                let ctrl = held.contains("ctrl") || mods.ctrl == Some(true);
                let alt = held.contains("alt") || mods.alt == Some(true);
                if !(ctrl && alt) {
                    return Verdict::Type;
                }
                if *action == KeyAction::Down {
                    self.swallowed.insert(*client);
                }
                Verdict::Sas
            }
        }
    }
}

/// Serves one connected client (`peer`, its process id, already checked by the caller) until it hangs up.
pub fn serve(pipe: Arc<Pipe>, peer: u32, options: &Options) -> Result<(), String> {
    match pipe.recv::<ToHelper>()? {
        ToHelper::Hello { protocol, secret } => {
            if !same_secret(&secret, &options.secret) {
                let _ = pipe.send(&FromHelper::Refused {
                    why: "a wrong secret".into(),
                });
                return Err(format!("process {peer} said hello with a wrong secret"));
            }
            pipe.send(&FromHelper::Welcome {
                protocol: PROTOCOL,
                version: options.version.clone(),
            })?;
            if protocol != PROTOCOL {
                return Err(format!("process {peer} speaks protocol {protocol}, this helper {PROTOCOL}"));
            }
        }
        other => return Err(format!("process {peer} began with {other:?} rather than a hello")),
    }
    // SAFETY: a handle on the client's process, to duplicate mirrors into; closed below.
    let process = unsafe { OpenProcess(PROCESS_DUP_HANDLE, false, peer) }
        .map_err(|e| format!("the client's process {peer}: {e}"))?;
    let mut running: HashMap<u64, Running> = HashMap::new();
    let inputs: Mutex<HashMap<String, cast_core::input::Input>> = Mutex::new(HashMap::new());
    let mut chord = Chord::default();
    let ended = loop {
        let message = match pipe.recv::<ToHelper>() {
            Ok(m) => m,
            Err(e) => break e,
        };
        match message {
            ToHelper::Open { id, monitor } => {
                let answer = open(&pipe, process, id, &monitor);
                match answer {
                    Ok((r, handle, (width, height))) => {
                        running.insert(id, r);
                        options.watched.fetch_add(1, Ordering::Relaxed);
                        let _ = pipe.send(&FromHelper::Opened {
                            id,
                            handle,
                            width,
                            height,
                        });
                    }
                    Err(why) => {
                        log::warn!("{monitor}: not opened for process {peer}: {why}");
                        let _ = pipe.send(&FromHelper::OpenFailed { id, why });
                    }
                }
            }
            ToHelper::Close { id } => {
                if running.remove(&id).is_some() {
                    options.watched.fetch_sub(1, Ordering::Relaxed);
                }
            }
            ToHelper::Input { monitor, event } => match chord.judge(&event) {
                Verdict::Sas => {
                    log::info!("Ctrl+Alt+Del from a viewer: a secure attention sequence");
                    (options.sas)();
                }
                Verdict::Swallow => {}
                Verdict::Type => type_input(&inputs, &monitor, event.into_event()),
            },
            ToHelper::Uninstall => {
                log::info!("process {peer} asked for the service to be removed");
                let _ = pipe.send(&FromHelper::Uninstalling);
                (options.uninstall)();
            }
            ToHelper::Hello { .. } => {}
        }
    };
    options.watched.fetch_sub(running.len(), Ordering::Relaxed);
    drop(running);
    for (_, input) in inputs.lock().drain() {
        input.send(InputEvent::Shutdown);
    }
    // SAFETY: the process handle opened above.
    unsafe {
        let _ = CloseHandle(process);
    }
    log::info!("process {peer} hung up ({ended})");
    Ok(())
}

/// Starts duplicating `monitor` and duplicates its mirror's handle into the client's process.
fn open(pipe: &Arc<Pipe>, process: HANDLE, id: u64, monitor: &str) -> Result<(Running, u64, (u32, u32)), String> {
    let display = crate::displays::find(monitor).ok_or_else(|| format!("no monitor {monitor} here"))?;
    let out = Arc::new(PipeOut { pipe: pipe.clone(), id });
    let started = capture::start(&display, out, Arc::new(Mutex::new(CursorState::default())), true).map_err(|e| match e {
        Open::Unsupported(why) => format!("desktop duplication is not offered here ({why})"),
        Open::Failed(why) => why,
    })?;
    let running = Running {
        stop: started.stop,
        thread: Some(started.thread),
    };
    let mut theirs = HANDLE::default();
    // SAFETY: this process's handle on the mirror into the client's process, with the same access.
    unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            started.handle.raw(),
            process,
            &mut theirs,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    }
    .map_err(|e| format!("the mirror's handle into the client: {e}"))?;
    Ok((running, theirs.0 as u64, started.size))
}

/// Types an event on `monitor`'s input thread, started on first use with the monitor's place on the desktop.
fn type_input(inputs: &Mutex<HashMap<String, cast_core::input::Input>>, monitor: &str, ev: InputEvent) {
    let mut inputs = inputs.lock();
    if !inputs.contains_key(monitor) {
        let Some(display) = crate::displays::find(monitor) else {
            return;
        };
        let geometry = Arc::new(Mutex::new(crate::capture::Geometry {
            left: display.rect.left,
            top: display.rect.top,
            width: display.width(),
            height: display.height(),
        }));
        match crate::input::spawn(geometry, None, display.scale) {
            Ok(input) => {
                inputs.insert(monitor.to_owned(), input);
            }
            Err(e) => {
                log::warn!("{monitor}: no input ({e})");
                return;
            }
        }
    }
    if let Some(input) = inputs.get(monitor) {
        input.send(ev);
    }
}

/// Compares two secrets in time that does not depend on where they differ.
fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::proto::WireMods;

    fn key(client: u64, key: &str, code: &str, action: KeyAction) -> Input {
        Input::Key {
            client,
            key: key.into(),
            code: Some(code.into()),
            id: code.into(),
            action,
            mods: WireMods::default(),
            altgr: false,
        }
    }

    #[test]
    fn ctrl_alt_delete_is_a_secure_attention_sequence() {
        let mut chord = Chord::default();
        assert_eq!(chord.judge(&key(1, "Control", "ControlLeft", KeyAction::Down)), Verdict::Type);
        assert_eq!(chord.judge(&key(1, "Alt", "AltLeft", KeyAction::Down)), Verdict::Type);
        // Another viewer's Delete is its own.
        assert_eq!(chord.judge(&key(2, "Delete", "Delete", KeyAction::Down)), Verdict::Type);
        assert_eq!(chord.judge(&key(1, "Delete", "Delete", KeyAction::Down)), Verdict::Sas);
        assert_eq!(chord.judge(&key(1, "Delete", "Delete", KeyAction::Up)), Verdict::Swallow);
        assert_eq!(chord.judge(&key(1, "Alt", "AltLeft", KeyAction::Up)), Verdict::Type);
        assert_eq!(chord.judge(&key(1, "Delete", "Delete", KeyAction::Down)), Verdict::Type);
        assert_eq!(chord.judge(&key(1, "Delete", "Delete", KeyAction::Up)), Verdict::Type);
    }

    #[test]
    fn secrets_compare_whole() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "ab"));
        assert!(!same_secret("", ""));
    }
}
