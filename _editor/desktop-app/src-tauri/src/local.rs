//! THE WINDOWS ON THE USER'S OWN DISK: a folder or a document opened from the tray, Home, a double-click or a
//! second launch, shown by the editor's own file views (the local face, `files/local` in the bundle) and served by
//! one sidecar process, `intentic-files` (`_devices/local-files`).
//!
//! The sidecar listens on a loopback port and serves only what this module grants it on its stdin: one grant per
//! window, a random token that decides the folder. A page presents its token and nothing else, so no page, the
//! window's own included, can widen what it reads. The window holds no capability at all (see `setup_link.rs`
//! `Source::Files` for the two links it is heard on).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::setup_link::LocalVerb;
use crate::state::AppState;

/// The label prefix of a local window: `files-1`, `files-2`, one per grant.
pub const FILES: &str = "files-";

/// How long a sidecar may take to say where it listens: a cold start of a compiled binary is well under this.
const READY_WAIT: Duration = Duration::from_secs(20);

/// How long a grant may take: a `realpath` and a `stat`.
const GRANT_WAIT: Duration = Duration::from_secs(10);

/// What the app asks the sidecar to serve, and what the sidecar made of it (the real folder, the name).
#[derive(Clone, Debug)]
struct Grant {
    token: String,
    id: String,
    /// The path the user chose, as asked; a window for the same path is raised rather than opened twice.
    asked: PathBuf,
    folder: bool,
    root: PathBuf,
    file: Option<String>,
}

/// One line the sidecar writes on stdout (`_devices/local-files/src/control.ts`).
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
}

/// What a grant came back as: the folder served and the names the window shows.
struct Granted {
    root: String,
    name: String,
    file: Option<String>,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    port: u16,
}

#[derive(Default)]
pub struct LocalFiles {
    running: Mutex<Option<Running>>,
    /// The port the first run took, asked for again by a restart so the open windows keep their address.
    port: Mutex<Option<u16>>,
    /// Open windows, by label.
    windows: Mutex<HashMap<String, Grant>>,
    ready: Mutex<Option<SyncSender<u16>>>,
    waiting: Mutex<HashMap<String, SyncSender<Result<Granted, String>>>>,
    next: AtomicU32,
}

/* THE SIDECAR. */

/// Where the binary is: beside this app's own executable, where the installer puts it (tauri.conf.json
/// `externalBin`), unless `INTENTIC_FILES_BIN` names another (a dev build of `_devices/local-files`).
fn sidecar_binary() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("INTENTIC_FILES_BIN") {
        return Ok(PathBuf::from(path));
    }
    let exe = std::env::current_exe()
        .map_err(|error| format!("cannot find this app's own executable: {error}"))?;
    let name = if cfg!(windows) {
        "intentic-files.exe"
    } else {
        "intentic-files"
    };
    let path = exe
        .parent()
        .map(|dir| dir.join(name))
        .ok_or_else(|| "this app's executable has no folder".to_string())?;
    if path.exists() {
        Ok(path)
    } else {
        Err(format!(
            "the file server is missing from this install ({})",
            path.display()
        ))
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

fn spawn(app: &AppHandle, port: Option<u16>) -> Result<(Child, ChildStdin, ChildStdout), String> {
    let paths = app.path();
    let cache = paths
        .app_cache_dir()
        .map_err(|error| format!("no cache folder for this app: {error}"))?
        .join("office");
    let page = match std::env::var_os("INTENTIC_OFFICE_PAGE") {
        Some(page) => PathBuf::from(page),
        None => paths
            .resource_dir()
            .map_err(|error| format!("no resource folder for this app: {error}"))?
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
    let mut child = command
        .spawn()
        .map_err(|error| format!("the file server did not start: {error}"))?;
    let stdin = child.stdin.take().ok_or("the file server has no stdin")?;
    let stdout = child.stdout.take().ok_or("the file server has no stdout")?;
    Ok((child, stdin, stdout))
}

/// The sidecar's port, starting it if it is not running. A restart takes the port the last run had and hands
/// every open window's grant back to it, so a page mid-session reconnects to the same address.
fn ensure(app: &AppHandle) -> Result<u16, String> {
    let files = app.state::<LocalFiles>();
    let mut running = files.running.lock().unwrap();
    if let Some(held) = running.as_mut() {
        if matches!(held.child.try_wait(), Ok(None)) {
            return Ok(held.port);
        }
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    *files.ready.lock().unwrap() = Some(sender);
    let last = *files.port.lock().unwrap();
    let (child, mut stdin, stdout) = spawn(app, last)?;
    let reader = app.clone();
    std::thread::spawn(move || read_events(&reader, stdout));
    let port = receiver
        .recv_timeout(READY_WAIT)
        .map_err(|_| "the file server did not say where it listens".to_string())?;
    for grant in files.windows.lock().unwrap().values() {
        let _ = stdin.write_all(grant_line(grant).as_bytes());
    }
    *files.port.lock().unwrap() = Some(port);
    *running = Some(Running { child, stdin, port });
    Ok(port)
}

fn grant_line(grant: &Grant) -> String {
    let kind = if grant.folder { "folder" } else { "file" };
    let path = if grant.folder {
        grant.root.clone()
    } else {
        grant.asked.clone()
    };
    format!(
        "{}\n",
        serde_json::json!({ "op": "grant", "token": grant.token, "id": grant.id, "path": path.display().to_string(), "kind": kind })
    )
}

fn send(app: &AppHandle, line: &str) -> Result<(), String> {
    let files = app.state::<LocalFiles>();
    let mut running = files.running.lock().unwrap();
    let held = running.as_mut().ok_or("the file server is not running")?;
    held.stdin
        .write_all(line.as_bytes())
        .and_then(|()| held.stdin.flush())
        .map_err(|error| format!("the file server stopped listening: {error}"))
}

/// Everything the sidecar says, until it exits. An exit with windows still open is a crash, answered by a
/// restart that serves them again.
fn read_events(app: &AppHandle, stdout: ChildStdout) {
    let files = app.state::<LocalFiles>();
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        match serde_json::from_str::<Event>(&line) {
            Ok(Event::Ready { port }) => {
                if let Some(sender) = files.ready.lock().unwrap().take() {
                    let _ = sender.send(port);
                }
            }
            Ok(Event::Granted {
                token,
                root,
                name,
                file,
            }) => {
                if let Some(sender) = files.waiting.lock().unwrap().remove(&token) {
                    let _ = sender.send(Ok(Granted { root, name, file }));
                }
            }
            Ok(Event::Refused { token, error }) => {
                if let Some(sender) = files.waiting.lock().unwrap().remove(&token) {
                    let _ = sender.send(Err(error));
                }
            }
            Ok(Event::Revoked { .. }) => {}
            Err(error) => {
                eprintln!("intentic-files said something this app does not read: {line} ({error})")
            }
        }
    }
    *files.running.lock().unwrap() = None;
    if files.windows.lock().unwrap().is_empty() {
        return;
    }
    eprintln!("intentic-files stopped with windows open: starting it again");
    std::thread::sleep(Duration::from_secs(1));
    if let Err(error) = ensure(app) {
        eprintln!("{error}");
    }
}

/// Stops the sidecar with the app, which would otherwise leave it waiting on a stdin nobody holds.
pub fn shutdown(app: &AppHandle) {
    let files = app.state::<LocalFiles>();
    files.windows.lock().unwrap().clear();
    let running = files.running.lock().unwrap().take();
    if let Some(mut running) = running {
        let _ = running.child.kill();
    }
}

/* OPENING. */

/// A path without the `\\?\` prefix Windows' canonical form carries, which no dialog, file manager or person
/// reads as the same folder.
fn plain(path: PathBuf) -> PathBuf {
    let text = path.display().to_string();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

/// Stable per path, so the editor finds a folder's tabs again when it is opened again (`local-<id>`).
fn id_of(path: &Path) -> String {
    let digest = Sha256::digest(path.display().to_string().as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// [`open`], off the calling thread: it may wait on the sidecar's first start, and the thread asking is often
/// the one that draws every window (a dialog's answer, a second launch, a link).
pub fn open_later(app: &AppHandle, path: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = open(&app, &path) {
            eprintln!("{error}");
        }
    });
}

/// Open `path` in a window of its own, or bring back the one already showing it.
pub fn open(app: &AppHandle, path: &Path) -> Result<(), String> {
    let asked = plain(
        std::fs::canonicalize(path)
            .map_err(|error| format!("{} cannot be opened: {error}", path.display()))?,
    );
    let folder = std::fs::metadata(&asked)
        .map_err(|error| format!("{} cannot be read: {error}", asked.display()))?
        .is_dir();
    let files = app.state::<LocalFiles>();
    let existing = files
        .windows
        .lock()
        .unwrap()
        .iter()
        .find(|(_, grant)| grant.asked == asked)
        .map(|(label, _)| label.clone());
    if let Some(window) = existing.and_then(|label| app.get_webview_window(&label)) {
        crate::windows::raise_window(&window);
        return Ok(());
    }
    let port = ensure(app)?;
    let mut grant = Grant {
        token: token(),
        id: id_of(&asked),
        asked: asked.clone(),
        folder,
        root: asked.clone(),
        file: None,
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    files
        .waiting
        .lock()
        .unwrap()
        .insert(grant.token.clone(), sender);
    send(app, &grant_line(&grant))?;
    let granted = receiver
        .recv_timeout(GRANT_WAIT)
        .map_err(|_| "the file server did not answer".to_string())??;
    grant.root = PathBuf::from(&granted.root);
    grant.file.clone_from(&granted.file);
    let label = format!("{FILES}{}", files.next.fetch_add(1, Ordering::Relaxed) + 1);
    // Whether the way to an agent is a new sandbox or this folder's own (project.rs).
    let has_sandbox = folder
        && app
            .state::<AppState>()
            .projects()
            .iter()
            .any(|project| Path::new(&project.path) == grant.root);
    let face = face_of(port, &grant, &granted, has_sandbox);
    let init = format!("window.__INTENTIC_LOCAL__ = Object.freeze({face});");
    files
        .windows
        .lock()
        .unwrap()
        .insert(label.clone(), grant.clone());
    if let Err(error) = crate::windows::show_files_window(
        app,
        &label,
        &format!("{} · Intentic", granted.name),
        &init,
    ) {
        files.windows.lock().unwrap().remove(&label);
        let _ = send(app, &revoke_line(&grant.token));
        return Err(error);
    }
    app.state::<AppState>().remember_recent(&asked, folder);
    Ok(())
}

/// What a local window is told about itself before any of its modules run: the web app's `LocalFace`
/// (`_editor/web/src/app/environments/local.ts`). `file` is there only for a document opened alone: the face reads an
/// absent one as a folder, and a `null` would read as a document with no name.
fn face_of(port: u16, grant: &Grant, granted: &Granted, has_sandbox: bool) -> serde_json::Value {
    let mut face = serde_json::json!({
        "daemonUrl": format!("http://127.0.0.1:{port}"),
        "token": grant.token,
        "id": grant.id,
        "name": granted.name,
        "path": granted.root,
        "sandbox": has_sandbox,
    });
    if let Some(file) = &granted.file {
        face["file"] = serde_json::Value::String(file.clone());
    }
    face
}

fn revoke_line(token: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({ "op": "revoke", "token": token })
    )
}

/// The window is gone, and so is what it could read.
pub fn window_closed(app: &AppHandle, label: &str) {
    let removed = app
        .state::<LocalFiles>()
        .windows
        .lock()
        .unwrap()
        .remove(label);
    if let Some(grant) = removed {
        let _ = send(app, &revoke_line(&grant.token));
    }
}

/// Open each path a launch was handed (a double-click, "Open with", a drop on the icon), as the OS spells them:
/// plain paths relative to where the launch happened, or `file://` URIs. Links and flags are someone else's.
/// Whether there was anything to open, so a launch that opens a window does not also open another face.
pub fn open_args<I: IntoIterator<Item = String>>(
    app: &AppHandle,
    args: I,
    cwd: Option<&Path>,
) -> bool {
    let paths: Vec<PathBuf> = args
        .into_iter()
        .filter_map(|arg| path_of_arg(&arg, cwd))
        .collect();
    for path in &paths {
        open_later(app, path.clone());
    }
    !paths.is_empty()
}

fn path_of_arg(arg: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    if arg.is_empty() || arg.starts_with('-') || arg.starts_with("intentic://") {
        return None;
    }
    let path = if arg.starts_with("file://") {
        url::Url::parse(arg).ok()?.to_file_path().ok()?
    } else {
        PathBuf::from(arg)
    };
    let path = match cwd {
        Some(cwd) if path.is_relative() => cwd.join(path),
        _ => path,
    };
    path.exists().then_some(path)
}

/* WHAT A LOCAL WINDOW ASKS FOR (setup_link.rs `LocalVerb`). */

pub fn act(app: &AppHandle, label: &str, verb: LocalVerb) {
    match verb {
        LocalVerb::OpenFolder => pick(app, true),
        LocalVerb::OpenFile => pick(app, false),
        LocalVerb::Reveal(path) => reveal(app, label, path.as_deref()),
        LocalVerb::Sandbox => sandbox(app, label),
    }
}

/// "Work on this with an agent", for the folder a window shows (project.rs); a document opened alone has no
/// folder of its own to hand over, so the window is told to open its folder first.
fn sandbox(app: &AppHandle, label: &str) {
    let Some(grant) = app
        .state::<LocalFiles>()
        .windows
        .lock()
        .unwrap()
        .get(label)
        .cloned()
    else {
        return;
    };
    if grant.folder {
        crate::project::start(app, grant.root);
    } else {
        app.dialog()
            .message("A sandbox works on a whole folder. Open the folder this document is in, then ask again from there.")
            .title("Open the folder first")
            .show(|_| {});
    }
}

/// The system dialog, then a window for what was chosen. Nothing chosen is nothing opened.
pub fn pick(app: &AppHandle, folder: bool) {
    let handle = app.clone();
    let dialog = app.dialog().file();
    let chosen = move |path: Option<tauri_plugin_dialog::FilePath>| {
        if let Some(path) = path.and_then(|path| path.into_path().ok()) {
            open_later(&handle, path);
        }
    };
    if folder {
        dialog.pick_folder(chosen);
    } else {
        dialog.pick_file(chosen);
    }
}

/// Show an entry of the window's own folder in the file manager: `path` is resolved inside that folder and
/// refused anywhere else; none means the folder (or, for a document opened alone, the document).
fn reveal(app: &AppHandle, label: &str, path: Option<&str>) {
    let Some(grant) = app
        .state::<LocalFiles>()
        .windows
        .lock()
        .unwrap()
        .get(label)
        .cloned()
    else {
        return;
    };
    let target = match path.and_then(|path| inside(&grant.root, path)) {
        Some(target) => target,
        None if grant.folder => grant.root.clone(),
        None => grant.asked.clone(),
    };
    if let Err(error) = app.opener().reveal_item_in_dir(&target) {
        eprintln!(
            "could not show {} in the file manager: {error}",
            target.display()
        );
    }
}

/// `path` (root-relative, forward slashes) under `root`, when it really is under it; undefined for a `..`, an
/// absolute path, or a link that leads out.
fn inside(root: &Path, path: &str) -> Option<PathBuf> {
    if path
        .split('/')
        .any(|segment| segment == ".." || segment.contains('\\'))
        || path.starts_with('/')
    {
        return None;
    }
    let joined = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .fold(root.to_path_buf(), |dir, segment| dir.join(segment));
    let real = plain(std::fs::canonicalize(&joined).ok()?);
    real.starts_with(root).then_some(real)
}

/* THE LAUNCHER'S COMMANDS (Home). */

#[tauri::command]
pub fn local_open(app: AppHandle, folder: bool) {
    pick(&app, folder);
}

#[tauri::command]
pub async fn local_open_path(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open(&app, Path::new(&path)))
        .await
        .map_err(|error| format!("opening stopped: {error}"))?
}

#[tauri::command]
pub fn local_recents(app: AppHandle) -> Vec<crate::state::Recent> {
    app.state::<AppState>().recents()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_opens_paths_and_file_uris_but_never_a_link_or_a_flag() {
        let dir = std::env::temp_dir().join(format!("intentic-local-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("brief.docx");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            path_of_arg("brief.docx", Some(&dir)),
            Some(dir.join("brief.docx"))
        );
        let uri = url::Url::from_file_path(&file).unwrap().to_string();
        assert_eq!(path_of_arg(&uri, None), Some(file.clone()));
        assert_eq!(path_of_arg("intentic://setup?code=x", Some(&dir)), None);
        assert_eq!(path_of_arg("--minimized", Some(&dir)), None);
        assert_eq!(path_of_arg("", Some(&dir)), None);
        // A path that is not there is not opened, rather than opened onto an error.
        assert_eq!(path_of_arg("missing.docx", Some(&dir)), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_reveal_stays_inside_the_window_s_own_folder() {
        let root = plain(std::fs::canonicalize(std::env::temp_dir()).unwrap())
            .join(format!("intentic-local-reveal-{}", std::process::id()));
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/a.md"), b"x").unwrap();
        let root = plain(std::fs::canonicalize(&root).unwrap());
        assert_eq!(
            inside(&root, "docs/a.md"),
            Some(root.join("docs").join("a.md"))
        );
        assert_eq!(inside(&root, "../etc/passwd"), None);
        assert_eq!(inside(&root, "/etc/passwd"), None);
        assert_eq!(inside(&root, "docs/missing.md"), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_id_a_folder_is_remembered_by_is_stable_and_short() {
        let a = id_of(Path::new("/home/me/project"));
        assert_eq!(a, id_of(Path::new("/home/me/project")));
        assert_ne!(a, id_of(Path::new("/home/me/other")));
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn a_token_is_long_random_and_only_what_the_sidecar_accepts() {
        let one = token();
        assert_eq!(one.len(), 64);
        assert!(one.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(one, token());
    }

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
    }

    /// A folder's face has no `file` at all: the window shows its tree only when the key is absent.
    #[test]
    fn a_folder_window_is_told_of_no_file_and_a_document_window_of_its_own() {
        let grant = Grant {
            token: "t".repeat(64),
            id: "abc".into(),
            asked: PathBuf::from("/home/me/app"),
            folder: true,
            root: PathBuf::from("/home/me/app"),
            file: None,
        };
        let folder = Granted {
            root: "/home/me/app".into(),
            name: "app".into(),
            file: None,
        };
        let face = face_of(4100, &grant, &folder, true);
        assert_eq!(face["daemonUrl"], "http://127.0.0.1:4100");
        assert_eq!(face["sandbox"], true);
        assert!(face.get("file").is_none(), "{face}");
        let document = Granted {
            root: "/home/me/app".into(),
            name: "brief.docx".into(),
            file: Some("brief.docx".into()),
        };
        assert_eq!(
            face_of(4100, &grant, &document, false)["file"],
            "brief.docx"
        );
    }

    #[test]
    fn windows_paths_lose_the_verbatim_prefix_but_not_a_share() {
        assert_eq!(
            plain(PathBuf::from(r"\\?\C:\Users\me")),
            PathBuf::from(r"C:\Users\me")
        );
        assert_eq!(
            plain(PathBuf::from(r"\\?\UNC\server\share")),
            PathBuf::from(r"\\?\UNC\server\share")
        );
        assert_eq!(plain(PathBuf::from("/home/me")), PathBuf::from("/home/me"));
    }
}
