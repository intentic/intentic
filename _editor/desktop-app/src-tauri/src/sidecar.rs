//! THE FILE SERVER BEHIND THE LOCAL WINDOWS: one `intentic-files` process (`_devices/local-files`), started on the
//! first open (or a few seconds after a launch that is likely to open one) and kept for the app's life. It talks JSON
//! lines: grants, revocations and answers in on its stdin, what it made of them and what it asks out on its stdout
//! (`control.ts`). local.rs decides what is granted and to whom; this module keeps the process alive to hear it.
//!
//! EVERY SPAWN IS A GENERATION. A start that times out kills its child, a reader thread acts on its process's exit
//! only while that process is still the current one, and the `ready` a start waits on belongs to the one spawn that
//! can answer it: without that, a late `ready` or a stale exit from one process was taken for the next one's.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::local::Trouble;

/// How long a sidecar may take to say where it listens: a cold start of a compiled binary is well under this.
const READY_WAIT: Duration = Duration::from_secs(20);

/// How long a grant may take: a `realpath` and a `stat`.
const GRANT_WAIT: Duration = Duration::from_secs(10);

/// How long after a launch the sidecar is started when a local window is likely (lib.rs): long enough for the
/// first window of the launch to paint, short enough to be done before anybody picks a folder.
const EARLY_START: Duration = Duration::from_secs(3);

/// One line the sidecar writes on stdout (`_devices/local-files/src/control.ts`). An event this app does not know
/// is a sidecar newer than it, which is the ordinary skew between the two, and is passed over in silence.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "event", rename_all = "lowercase")]
enum Event {
    Ready {
        port: u16,
    },
    Granted {
        token: String,
        root: String,
        name: String,
        file: Option<String>,
    },
    Refused {
        token: String,
        error: String,
    },
    Revoked {
        token: String,
    },
    /// The sidecar asking the app for what a page may not do itself; answered on stdin by `id` ([`answer`]).
    Ask {
        id: String,
        verb: String,
        path: String,
    },
    /// Where the office editor's download went (`prefetch-office`), for the log.
    Office {
        state: String,
        error: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

/// What a grant came back as: the folder served and the names the window shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Granted {
    pub root: String,
    pub name: String,
    pub file: Option<String>,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    port: u16,
    generation: u64,
}

#[derive(Default)]
pub struct Sidecar {
    /// The process serving now, with the generation it was spawned as.
    running: Mutex<Option<Running>>,
    /// Held by the one call that is starting a process, for as long as it waits to hear where it listens: starts
    /// happen one at a time without `running`, and so every `send`, being held across the wait.
    starting: Mutex<()>,
    /// The newest spawn's generation.
    generation: AtomicU64,
    /// The port the last run took, asked for again by a restart so the open windows keep their address.
    port: Mutex<Option<u16>>,
    /// Where the start waiting on a spawn hears its port, and which spawn may answer it.
    ready: Mutex<Option<(u64, SyncSender<u16>)>>,
    waiting: Mutex<HashMap<String, SyncSender<Result<Granted, String>>>>,
    /// The office editor is wanted this run: Home was shown at launch, or a local window opened.
    office_wanted: AtomicBool,
    /// `prefetch-office` has been sent: once per run, whatever the process does after.
    office_asked: AtomicBool,
}

impl Sidecar {
    /// The port of a process that is still running.
    fn live_port(&self) -> Option<u16> {
        let mut running = self.running.lock().unwrap();
        let held = running.as_mut()?;
        matches!(held.child.try_wait(), Ok(None)).then_some(held.port)
    }

    /// The ready sender, if it is still `generation`'s: taken, so nothing else can answer that start.
    fn take_ready(&self, generation: u64) -> Option<SyncSender<u16>> {
        let mut ready = self.ready.lock().unwrap();
        if ready.as_ref().is_some_and(|(held, _)| *held == generation) {
            return ready.take().map(|(_, sender)| sender);
        }
        None
    }
}

/// Where the binary is: beside this app's own executable, where the installer puts it (tauri.conf.json
/// `externalBin`), unless `INTENTIC_FILES_BIN` names another (a dev build of `_devices/local-files`).
fn sidecar_binary() -> Result<PathBuf, Trouble> {
    if let Some(path) = std::env::var_os("INTENTIC_FILES_BIN") {
        return Ok(PathBuf::from(path));
    }
    let exe = std::env::current_exe().map_err(|error| {
        Trouble::Missing(format!("cannot find this app's own executable: {error}"))
    })?;
    let name = if cfg!(windows) {
        "intentic-files.exe"
    } else {
        "intentic-files"
    };
    let path = exe
        .parent()
        .map(|dir| dir.join(name))
        .ok_or_else(|| Trouble::Missing("this app's executable has no folder".to_string()))?;
    if path.exists() {
        Ok(path)
    } else {
        Err(Trouble::Missing(format!(
            "the file server is missing from this install ({})",
            path.display()
        )))
    }
}

/// The page origins the sidecar answers: the bundle under the scheme each platform serves it by, and the dev
/// server's in a debug build.
fn origins() -> Vec<&'static str> {
    let mut origins = vec![
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ];
    if cfg!(debug_assertions) {
        origins.push("http://localhost:47146");
    }
    origins
}

fn spawn(app: &AppHandle, port: Option<u16>) -> Result<(Child, ChildStdin, ChildStdout), Trouble> {
    let paths = app.path();
    let cache = paths
        .app_cache_dir()
        .map_err(|error| Trouble::NotStarted(format!("no cache folder for this app: {error}")))?
        .join("office");
    let page = match std::env::var_os("INTENTIC_OFFICE_PAGE") {
        Some(page) => PathBuf::from(page),
        None => paths
            .resource_dir()
            .map_err(|error| {
                Trouble::NotStarted(format!("no resource folder for this app: {error}"))
            })?
            .join("onlyoffice-page"),
    };
    let mut command = Command::new(sidecar_binary()?);
    command.arg("serve");
    for origin in origins() {
        command.arg("--origin").arg(origin);
    }
    command
        .arg("--cache")
        .arg(&cache)
        .arg("--office-page")
        .arg(&page)
        .arg("--port")
        .arg(port.unwrap_or(0).to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => Trouble::Missing(format!(
            "the file server is not where it was named: {error}"
        )),
        _ => Trouble::NotStarted(format!("the file server did not start: {error}")),
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| Trouble::NotStarted("the file server has no stdin".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Trouble::NotStarted("the file server has no stdout".to_string()))?;
    Ok((child, stdin, stdout))
}

/// Why one spawn did not come up. `Exited` is the one worth a second try on a fresh port: a process that ends
/// before it says where it listens is, on a restart, a process that could not have its old port back.
enum Start {
    Exited(String),
    Other(Trouble),
}

/// One spawn, as far as its `ready`. Its child is killed on the way out of every failure, so a start that gave up
/// never leaves a process behind that a later one would be mistaken for.
fn start(app: &AppHandle, port: Option<u16>) -> Result<(Child, ChildStdin, u16, u64), Start> {
    let sidecar = app.state::<Sidecar>();
    let generation = sidecar.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (sender, receiver) = mpsc::sync_channel(1);
    *sidecar.ready.lock().unwrap() = Some((generation, sender));
    let (mut child, stdin, stdout) = match spawn(app, port) {
        Ok(spawned) => spawned,
        Err(trouble) => {
            drop(sidecar.take_ready(generation));
            return Err(Start::Other(trouble));
        }
    };
    let reader = app.clone();
    std::thread::spawn(move || read_events(&reader, stdout, generation));
    match receiver.recv_timeout(READY_WAIT) {
        Ok(port) => Ok((child, stdin, port, generation)),
        // The reader dropped the sender: the process ended without a `ready`.
        Err(RecvTimeoutError::Disconnected) => {
            reap(&mut child);
            Err(Start::Exited(
                "the file server stopped before it said where it listens".to_string(),
            ))
        }
        Err(RecvTimeoutError::Timeout) => {
            drop(sidecar.take_ready(generation));
            reap(&mut child);
            Err(Start::Other(Trouble::NotStarted(format!(
                "the file server did not say where it listens within {}s",
                READY_WAIT.as_secs()
            ))))
        }
    }
}

fn reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// The sidecar's port, starting it if it is not running. A restart asks for the port the last run had and hands it
/// every grant the app still holds (local.rs), so a page mid-session reconnects to the same address. A restart that
/// cannot have that port back takes a fresh one: every grant is given a new token before the new process hears of
/// any (local.rs `rehome`), since whatever holds the old port hears the old tokens from pages still calling it, and
/// the windows are then moved onto their new address and token (local.rs `moved`).
pub fn ensure(app: &AppHandle) -> Result<u16, Trouble> {
    let sidecar = app.state::<Sidecar>();
    let starting = sidecar.starting.lock().unwrap();
    if let Some(port) = sidecar.live_port() {
        return Ok(port);
    }
    let last = *sidecar.port.lock().unwrap();
    let started = match start(app, last) {
        Err(Start::Exited(detail)) if last.is_some() => {
            eprintln!("intentic-files could not listen where it did before ({detail}): taking a fresh port");
            start(app, None)
        }
        other => other,
    };
    let (child, mut stdin, port, generation) = started.map_err(|failed| match failed {
        Start::Exited(detail) => Trouble::NotStarted(detail),
        Start::Other(trouble) => trouble,
    })?;
    let moved = last.is_some_and(|last| last != port);
    if moved {
        crate::local::rehome(app, port);
    }
    for line in crate::local::live_grant_lines(app) {
        let _ = stdin.write_all(line.as_bytes());
    }
    let _ = stdin.flush();
    *sidecar.port.lock().unwrap() = Some(port);
    let replaced = sidecar.running.lock().unwrap().replace(Running {
        child,
        stdin,
        port,
        generation,
    });
    // A process that had already exited, found by `live_port` before its reader got there: reaped, not left.
    if let Some(mut old) = replaced {
        reap(&mut old.child);
    }
    drop(starting);
    if moved {
        crate::local::moved(app);
    }
    ask_for_office(app);
    Ok(port)
}

/// Write one control line. Never waits on a start: a start in progress holds `starting`, not this.
pub fn send(app: &AppHandle, line: &str) -> Result<(), String> {
    let sidecar = app.state::<Sidecar>();
    let mut running = sidecar.running.lock().unwrap();
    let held = running.as_mut().ok_or("the file server is not running")?;
    held.stdin
        .write_all(line.as_bytes())
        .and_then(|()| held.stdin.flush())
        .map_err(|error| format!("the file server stopped listening: {error}"))
}

/// Grant `line` (whose token is `token`) and wait for what the sidecar made of it.
pub fn grant(app: &AppHandle, token: &str, line: &str) -> Result<Granted, Trouble> {
    let sidecar = app.state::<Sidecar>();
    let (sender, receiver) = mpsc::sync_channel(1);
    sidecar
        .waiting
        .lock()
        .unwrap()
        .insert(token.to_string(), sender);
    if let Err(error) = send(app, line) {
        sidecar.waiting.lock().unwrap().remove(token);
        return Err(Trouble::NotStarted(error));
    }
    let answer = receiver.recv_timeout(GRANT_WAIT);
    sidecar.waiting.lock().unwrap().remove(token);
    match answer {
        Ok(Ok(granted)) => Ok(granted),
        Ok(Err(error)) => Err(Trouble::Refused(error)),
        Err(_) => Err(Trouble::NotStarted(format!(
            "the file server did not answer a grant within {}s",
            GRANT_WAIT.as_secs()
        ))),
    }
}

/// Everything one process says, until it exits. An exit is acted on only while that process is the current one:
/// a process a start gave up on, or one already replaced, ends without anything following from it. An exit of the
/// current one with windows still open is a crash, answered by a restart that serves them again.
fn read_events(app: &AppHandle, stdout: ChildStdout, generation: u64) {
    let sidecar = app.state::<Sidecar>();
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Event>(&line) {
            Ok(Event::Ready { port }) => {
                if let Some(sender) = sidecar.take_ready(generation) {
                    let _ = sender.send(port);
                }
            }
            Ok(Event::Granted {
                token,
                root,
                name,
                file,
            }) => {
                if let Some(sender) = sidecar.waiting.lock().unwrap().remove(&token) {
                    let _ = sender.send(Ok(Granted { root, name, file }));
                }
            }
            Ok(Event::Refused { token, error }) => {
                if let Some(sender) = sidecar.waiting.lock().unwrap().remove(&token) {
                    let _ = sender.send(Err(error));
                }
            }
            Ok(Event::Ask { id, verb, path }) => answer(app, id, verb, path),
            Ok(Event::Office { state, error }) => match error {
                Some(error) => eprintln!("intentic-files: the office editor is {state}: {error}"),
                None => eprintln!("intentic-files: the office editor is {state}"),
            },
            Ok(Event::Revoked { .. } | Event::Unknown) => {}
            Err(error) => {
                eprintln!("intentic-files said something this app does not read: {line} ({error})")
            }
        }
    }
    // A start still waiting on this process hears that it is gone, rather than waiting out READY_WAIT.
    drop(sidecar.take_ready(generation));
    let gone = {
        let mut running = sidecar.running.lock().unwrap();
        if running
            .as_ref()
            .is_some_and(|held| held.generation == generation)
        {
            running.take()
        } else {
            None
        }
    };
    // Reaped outside the lock, and killed first: a process that closed its stdout may not have exited, and a
    // wait on it under `running` would hold every `send` behind it.
    let Some(mut gone) = gone else {
        return;
    };
    reap(&mut gone.child);
    if !crate::local::serving(app) {
        return;
    }
    eprintln!("intentic-files stopped with windows open: starting it again");
    std::thread::sleep(Duration::from_secs(1));
    if let Err(trouble) = ensure(app) {
        eprintln!("{}", trouble.detail());
    }
}

/// Stops the sidecar with the app, which would otherwise leave it waiting on a stdin nobody holds. Taken out of
/// `running` first, so its reader's exit is not the current process's and starts nothing.
pub fn shutdown(app: &AppHandle) {
    let running = app.state::<Sidecar>().running.lock().unwrap().take();
    if let Some(mut running) = running {
        let _ = running.child.kill();
    }
}

/* WHAT THE SIDECAR ASKS OF THE APP. */

/// What a Recycle Bin is called where this build runs.
const BIN: &str = if cfg!(windows) {
    "Recycle Bin"
} else {
    "Trash"
};

/// Answer one ask, off the reader thread: a move to the trash can take seconds (a big folder, a slow disk), and
/// every other answer the sidecar is waiting for arrives on that thread.
fn answer(app: &AppHandle, id: String, verb: String, path: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = match verb.as_str() {
            "trash" => trash(&crate::local::folder_roots(&app), Path::new(&path)),
            _ => Err(format!("Intentic can't do “{verb}” to a file.")),
        };
        if let Err(error) = &outcome {
            eprintln!("intentic-files asked to {verb} {path}: {error}");
        }
        if let Err(error) = send(&app, &answer_line(&id, &outcome)) {
            eprintln!("intentic-files could not be answered: {error}");
        }
    });
}

/// A delete in a local window: to the OS's own Recycle Bin or Trash, where the user can take it back from, and
/// only for an entry strictly inside a folder a window shows ([`trashable`]).
fn trash(roots: &[PathBuf], path: &Path) -> Result<(), String> {
    let entry = trashable(roots, path)?;
    trash::delete(&entry).map_err(|error| {
        format!(
            "“{}” couldn't be moved to the {BIN}: {error}",
            crate::local::shown_name(&entry)
        )
    })
}

/// The entry `path` names, if it may be trashed: the real folder it is in joined with its own name (so a link is
/// moved as a link, never the thing it points at), strictly inside the root of a folder a window shows. Never a
/// root itself, and never an entry a document window or a handoff reaches, since only folder roots are passed in.
pub(crate) fn trashable(roots: &[PathBuf], path: &Path) -> Result<PathBuf, String> {
    let outside = || "That isn't inside a folder open in Intentic.".to_string();
    if !path.is_absolute() {
        return Err(outside());
    }
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(outside());
    };
    let gone = || format!("“{}” isn't there any more.", name.to_string_lossy());
    let parent = crate::local::plain(std::fs::canonicalize(parent).map_err(|_| gone())?);
    let entry = parent.join(name);
    std::fs::symlink_metadata(&entry).map_err(|_| gone())?;
    if roots
        .iter()
        .any(|root| entry.starts_with(root) && entry != *root)
    {
        Ok(entry)
    } else {
        Err(outside())
    }
}

fn answer_line(id: &str, outcome: &Result<(), String>) -> String {
    let answer = match outcome {
        Ok(()) => serde_json::json!({ "op": "answer", "id": id, "ok": true }),
        Err(error) => serde_json::json!({ "op": "answer", "id": id, "ok": false, "error": error }),
    };
    format!("{answer}\n")
}

/* THE OFFICE EDITOR, fetched before the first document needs it. */

/// The office editor is wanted this run: Home was shown at launch (lib.rs), or the first local window opened
/// (local.rs). Asked for once the sidecar is up, if it is not already.
pub fn want_office(app: &AppHandle) {
    app.state::<Sidecar>()
        .office_wanted
        .store(true, Ordering::SeqCst);
    ask_for_office(app);
}

/// `prefetch-office`, once per run, when it is wanted and there is a process to ask. Never on an air-gapped
/// install: `INTENTIC_DISABLE_UPDATE_CHECK` is the switch that promises a process that does not touch the network
/// on its own (lib.rs), and the download is exactly that.
fn ask_for_office(app: &AppHandle) {
    let sidecar = app.state::<Sidecar>();
    if !sidecar.office_wanted.load(Ordering::SeqCst)
        || std::env::var_os("INTENTIC_DISABLE_UPDATE_CHECK").is_some()
        || sidecar.running.lock().unwrap().is_none()
        || sidecar.office_asked.swap(true, Ordering::SeqCst)
    {
        return;
    }
    if let Err(error) = send(app, "{\"op\":\"prefetch-office\"}\n") {
        sidecar.office_asked.store(false, Ordering::SeqCst);
        eprintln!("intentic-files was not asked for the office editor: {error}");
    }
}

/// Start the sidecar a moment after a launch that is likely to open a local window (lib.rs), so the first one opens
/// on a server that is already listening.
pub fn start_early(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(EARLY_START);
        if let Err(trouble) = ensure(&app) {
            eprintln!("intentic-files did not start early: {}", trouble.detail());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_event_the_sidecar_writes() {
        assert_eq!(
            serde_json::from_str::<Event>(r#"{"event":"ready","port":4100,"version":"1.2.3"}"#)
                .unwrap(),
            Event::Ready { port: 4100 }
        );
        assert_eq!(
            serde_json::from_str::<Event>(
                r#"{"event":"granted","token":"t","root":"/r","name":"r"}"#
            )
            .unwrap(),
            Event::Granted {
                token: "t".into(),
                root: "/r".into(),
                name: "r".into(),
                file: None
            }
        );
        assert_eq!(
            serde_json::from_str::<Event>(r#"{"event":"refused","token":"t","error":"gone"}"#)
                .unwrap(),
            Event::Refused {
                token: "t".into(),
                error: "gone".into()
            }
        );
        assert_eq!(
            serde_json::from_str::<Event>(
                r#"{"event":"ask","id":"a1","verb":"trash","path":"/home/me/app/old.md"}"#
            )
            .unwrap(),
            Event::Ask {
                id: "a1".into(),
                verb: "trash".into(),
                path: "/home/me/app/old.md".into()
            }
        );
        assert_eq!(
            serde_json::from_str::<Event>(r#"{"event":"office","state":"ready"}"#).unwrap(),
            Event::Office {
                state: "ready".into(),
                error: None
            }
        );
        assert_eq!(
            serde_json::from_str::<Event>(
                r#"{"event":"office","state":"failed","error":"offline"}"#
            )
            .unwrap(),
            Event::Office {
                state: "failed".into(),
                error: Some("offline".into())
            }
        );
    }

    /// A sidecar newer than this app says things this app has no name for: they are passed over, fields and all,
    /// rather than logged as lines it cannot read.
    #[test]
    fn an_event_this_app_does_not_know_is_passed_over() {
        assert_eq!(
            serde_json::from_str::<Event>(r#"{"event":"progress","percent":40,"of":{"a":1}}"#)
                .unwrap(),
            Event::Unknown
        );
        // A line that is not an event at all is still not read as one.
        assert!(serde_json::from_str::<Event>(r#"{"port":4100}"#).is_err());
    }

    #[test]
    fn an_answer_carries_its_id_and_either_ok_or_why_not() {
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&answer_line("a1", &Ok(()))).unwrap(),
            serde_json::json!({ "op": "answer", "id": "a1", "ok": true })
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&answer_line(
                "a2",
                &Err("no \"way\"".into())
            ))
            .unwrap(),
            serde_json::json!({ "op": "answer", "id": "a2", "ok": false, "error": "no \"way\"" })
        );
        assert!(answer_line("a1", &Ok(())).ends_with('\n'));
    }

    /// Only an entry strictly inside a folder a window shows goes to the trash: never the folder itself, nothing
    /// outside it, nothing reached by stepping out, and a link inside is the link, not what it points at.
    #[cfg(unix)]
    #[test]
    fn only_an_entry_inside_a_shown_folder_may_go_to_the_trash() {
        let base = crate::local::plain(std::fs::canonicalize(std::env::temp_dir()).unwrap())
            .join(format!("intentic-trash-{}", uuid::Uuid::new_v4()));
        let root = base.join("app");
        let outside = base.join("elsewhere");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("docs/a.md"), b"x").unwrap();
        std::fs::write(outside.join("secret.md"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), root.join("link.md")).unwrap();
        let roots = [root.clone()];

        assert_eq!(
            trashable(&roots, &root.join("docs/a.md")),
            Ok(root.join("docs").join("a.md"))
        );
        assert_eq!(trashable(&roots, &root.join("docs")), Ok(root.join("docs")));
        // The link, as a link: its own path, inside, never the file outside it points at.
        assert_eq!(
            trashable(&roots, &root.join("link.md")),
            Ok(root.join("link.md"))
        );
        assert!(trashable(&roots, &root).is_err(), "never the root itself");
        assert!(trashable(&roots, &outside.join("secret.md")).is_err());
        assert!(trashable(&roots, &root.join("docs/../../elsewhere/secret.md")).is_err());
        assert!(trashable(&roots, &root.join("docs/missing.md")).is_err());
        assert!(trashable(&roots, Path::new("docs/a.md")).is_err());
        // No folder window, no trash. Which roots there are is local.rs `folder_roots`, tested there with a document
        // window and a handoff beside a folder window.
        assert!(trashable(&[], &root.join("docs/a.md")).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
