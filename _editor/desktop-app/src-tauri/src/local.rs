//! THE WINDOWS ON THE USER'S OWN DISK: the app's main window (windows.rs `HOME`, the shell on a folder of this
//! computer, `~/intentic/local` at first), and a folder or a document opened from the tray, the shell's place chip, a
//! double-click or a second launch. Each is the editor's own shell (the local face, `files/local` in the bundle), its
//! files served by one sidecar process, `intentic-files` (`_devices/local-files`, kept alive by sidecar.rs).
//!
//! The sidecar listens on a loopback port and serves only what this module grants it on its stdin: one grant per
//! window, a random token that decides the folder. A page presents its token and nothing else, so no page, the
//! window's own included, can widen what it reads. What else a window may do is the app's commands its capability
//! names (capabilities/local.json): the shell's places and This device. The documents it draws can do none of it:
//! the page runs no script but the bundle's own (vite.local.config.ts), the frames a document opens are other
//! origins, which hold no capability, and a link is heard only as `window` or `local` (`setup_link.rs`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::setup_link::LocalVerb;
use crate::sidecar::Granted;
use crate::state::{AppState, RecentView};
use crate::windows::FilesWindow;

/// The label prefix of a local window: `files-1`, `files-2`, one per grant (and one for the spare).
pub const FILES: &str = "files-";

/// How long the workspace may read a file handed to it by "Ask about this": long enough to open it, never a
/// standing door into the folder.
const HANDOFF_LIFE: Duration = Duration::from_secs(15 * 60);

/// How long after a window opens the next spare is built: after the window's own page has loaded, not against it.
const SPARE_AFTER: Duration = Duration::from_secs(2);

/// How long a spare is kept with no local window open: a hidden editor is memory, and a user who has stopped
/// opening folders is not about to open the next one this second.
const SPARE_IDLE: Duration = Duration::from_secs(5 * 60);

/// How long a window's old grant outlives a [`point`] that took it to another folder. The page switches folders in
/// place, so reads it still had in flight on the folder it left finish rather than fail on a token the sidecar has
/// forgotten; nothing asks with that token once the switch is done.
const POINTED_GRACE: Duration = Duration::from_secs(10);

/// Where a window's face is kept for its reloads: the window's own session storage, which a reload keeps and no
/// other window shares. Written only by the app ([`face_given`], [`face_moved`], [`face_pointed`]).
const FACE_KEY: &str = "intentic.local.face";

/// What the app asks the sidecar to serve for one window, and what the sidecar made of it (the real folder, the
/// name, and the face the window was told).
#[derive(Clone, Debug)]
struct Grant {
    token: String,
    id: String,
    /// The path the user chose, as asked; a window for the same path is raised rather than opened twice.
    asked: PathBuf,
    folder: bool,
    root: PathBuf,
    file: Option<String>,
    /// What the window was told about itself (`__INTENTIC_LOCAL__`), kept so a sidecar that comes back on another
    /// port can tell it again ([`moved`]).
    face: serde_json::Value,
}

/// A file handed to the workspace read-only by "Ask about this" ([`hand_off`]): a grant of its own that no window
/// shows, so it never counts as one, kept until it expires so a restart hands it back to the sidecar.
#[derive(Clone, Debug)]
struct Handoff {
    token: String,
    id: String,
    path: PathBuf,
    /// The workspace's origin, the one page allowed to read it.
    origin: String,
    expires: Instant,
}

/// The hidden files window kept ready for the next open (the warm window): a page that has already loaded the
/// editor and waits for its face, so the next folder or document appears as soon as it is granted.
struct SpareWindow {
    label: String,
    /// Its page has finished loading: only then can a face evaluated into it land in it.
    loaded: bool,
}

#[derive(Default)]
pub struct LocalFiles {
    /// Open windows, by label.
    windows: Mutex<HashMap<String, Grant>>,
    handoffs: Mutex<Vec<Handoff>>,
    /// Paths an open is working on right now. A second open of one of them is dropped: the first raises its window
    /// when it is ready. Always locked BEFORE `windows`, never after.
    opening: Mutex<HashSet<PathBuf>>,
    spare: Mutex<Option<SpareWindow>>,
    /// The main window is being built: a second ask meanwhile (a launch and the tray at once) finds it on the way.
    home_opening: AtomicBool,
    next: AtomicU32,
    next_handoff: AtomicU32,
    /// A local window has been shown this run: the first one is what wants the office editor and starts the spares.
    shown_any: AtomicBool,
    /// Moved on by every open and by the last window closing, so a spare's retirement scheduled at a close can tell
    /// whether anything has happened since.
    idle: AtomicU64,
}

/* WHAT GOES WRONG, in the words the user reads. */

/// Why an open failed. The words shown are [`Trouble::friendly`]'s; the detail is the original error, which goes
/// to stderr and nowhere else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trouble {
    /// The path is not there.
    Gone(String),
    /// The OS will not let this user read it.
    NotAllowed(String),
    /// The sidecar's binary is not where the installer puts it.
    Missing(String),
    /// The sidecar would not start, did not say where it listens, or did not answer a grant in time.
    NotStarted(String),
    /// The sidecar refused the grant.
    Refused(String),
    Failed(String),
}

impl Trouble {
    fn io(error: &std::io::Error) -> Trouble {
        match error.kind() {
            std::io::ErrorKind::NotFound => Trouble::Gone(error.to_string()),
            std::io::ErrorKind::PermissionDenied => Trouble::NotAllowed(error.to_string()),
            _ => Trouble::Failed(error.to_string()),
        }
    }

    pub fn detail(&self) -> &str {
        match self {
            Trouble::Gone(detail)
            | Trouble::NotAllowed(detail)
            | Trouble::Missing(detail)
            | Trouble::NotStarted(detail)
            | Trouble::Refused(detail)
            | Trouble::Failed(detail) => detail,
        }
    }

    /// The sentence the dialog or Home shows, about the thing called `name`.
    pub fn friendly(&self, name: &str) -> String {
        match self {
            Trouble::Gone(_) => {
                format!("“{name}” isn't there any more. It may have been moved or deleted.")
            }
            Trouble::NotAllowed(_) => format!("Intentic isn't allowed to open “{name}”."),
            Trouble::Missing(_) => {
                "Part of Intentic is missing. Reinstalling Intentic fixes this.".to_string()
            }
            Trouble::NotStarted(_) => {
                "Intentic's file server didn't start. Try again, or restart Intentic.".to_string()
            }
            Trouble::Refused(_) | Trouble::Failed(_) => format!("Intentic couldn't open “{name}”."),
        }
    }
}

/// What a path is called where the user reads about it: its own name, or the whole of it for a drive root.
pub fn shown_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// An open that failed where nothing on screen was waiting for its answer (a dialog's pick, a double-click, a drop,
/// the tray): said in a native error dialog, since a Windows build has no console for stderr to reach.
fn say(app: &AppHandle, text: &str) {
    app.dialog()
        .message(text)
        .title("Intentic couldn't open this")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/* THE GRANTS, as the sidecar is handed them. */

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

/// A handoff's grant, with what is left of its life at `now`; none once it has expired. Read-only, one file, and
/// readable only from the workspace's origin (`_devices/local-files`, handoff grants).
fn handoff_line(handoff: &Handoff, now: Instant) -> Option<String> {
    let left = handoff.expires.checked_duration_since(now)?;
    let millis = u64::try_from(left.as_millis()).unwrap_or(u64::MAX);
    Some(format!(
        "{}\n",
        serde_json::json!({
            "op": "grant",
            "token": handoff.token,
            "id": handoff.id,
            "path": handoff.path.display().to_string(),
            "kind": "file",
            "readOnly": true,
            "origins": [handoff.origin],
            "expiresInMs": millis,
        })
    ))
}

fn revoke_line(token: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({ "op": "revoke", "token": token })
    )
}

impl LocalFiles {
    /// Every grant the app still holds, as lines for a sidecar that has just (re)started: each window's, and each
    /// handoff that has not expired at `now`. Expired handoffs are dropped here.
    fn grant_lines(&self, now: Instant) -> Vec<String> {
        let mut lines: Vec<String> = self
            .windows
            .lock()
            .unwrap()
            .values()
            .map(grant_line)
            .collect();
        let mut handoffs = self.handoffs.lock().unwrap();
        handoffs.retain(|handoff| handoff.expires > now);
        lines.extend(
            handoffs
                .iter()
                .filter_map(|handoff| handoff_line(handoff, now)),
        );
        lines
    }

    /// The roots of the folders windows show: the only places a delete may reach (sidecar.rs `trashable`). A
    /// document window's folder is not among them, since it may write only its own document, and neither is a
    /// handoff's, which is not a window at all.
    fn folder_roots(&self) -> Vec<PathBuf> {
        self.windows
            .lock()
            .unwrap()
            .values()
            .filter(|grant| grant.folder)
            .map(|grant| grant.root.clone())
            .collect()
    }

    /// The sidecar is coming back on `port`, another than before, where whatever took the old one may be collecting
    /// the tokens pages still send there, to replay against the new one. So before anything is granted again,
    /// every window and every handoff gets a fresh token, and each window's face carries it with the new address.
    fn rehome(&self, port: u16) {
        for grant in self.windows.lock().unwrap().values_mut() {
            grant.token = token();
            grant.face["token"] = serde_json::Value::String(grant.token.clone());
            grant.face["daemonUrl"] = serde_json::Value::String(daemon_url(port));
        }
        for handoff in self.handoffs.lock().unwrap().iter_mut() {
            handoff.token = token();
        }
    }

    /// Each window's face, by label.
    fn faces(&self) -> Vec<(String, serde_json::Value)> {
        self.windows
            .lock()
            .unwrap()
            .iter()
            .map(|(label, grant)| (label.clone(), grant.face.clone()))
            .collect()
    }

    /// Every folder window on `folder` told it has its sandbox now, in the face kept for its reloads and a sidecar's
    /// move: the windows to tell, each with its face as it now reads.
    fn mark_sandbox(&self, folder: &Path) -> Vec<(String, serde_json::Value)> {
        let mut windows = self.windows.lock().unwrap();
        windows
            .iter_mut()
            .filter(|(_, grant)| grant.folder && grant.root == folder)
            .map(|(label, grant)| {
                if let Some(face) = grant.face.as_object_mut() {
                    face.insert("sandbox".to_string(), serde_json::Value::Bool(true));
                }
                (label.clone(), grant.face.clone())
            })
            .collect()
    }
}

/// Every grant the app still holds, for a sidecar that has just (re)started (sidecar.rs `ensure`).
pub fn live_grant_lines(app: &AppHandle) -> Vec<String> {
    app.state::<LocalFiles>().grant_lines(Instant::now())
}

/// Whether any window is being served: what makes a sidecar that stopped one to start again. Handoffs never count.
pub fn serving(app: &AppHandle) -> bool {
    !app.state::<LocalFiles>().windows.lock().unwrap().is_empty()
}

/// The roots of the folders windows show (`LocalFiles::folder_roots`).
pub fn folder_roots(app: &AppHandle) -> Vec<PathBuf> {
    app.state::<LocalFiles>().folder_roots()
}

/// Fresh tokens for every grant before a sidecar on a new port is granted anything (`LocalFiles::rehome`).
pub fn rehome(app: &AppHandle, port: u16) {
    app.state::<LocalFiles>().rehome(port);
}

/* WHAT A WINDOW IS TOLD ABOUT ITSELF. */

/// What a local window is told about itself before any of its modules run: the web app's `LocalFace`
/// (`_editor/web/src/app/environments/local.ts`). `file` is there only for a document opened alone: the face reads an
/// absent one as a folder, and a `null` would read as a document with no name. `home` marks the main window, the one
/// the app shows for work of its own (a setup handed over, a sleeping engine), whose page takes that work.
fn face_of(
    port: u16,
    grant: &Grant,
    granted: &Granted,
    has_sandbox: bool,
    home: bool,
) -> serde_json::Value {
    let mut face = serde_json::json!({
        "daemonUrl": daemon_url(port),
        "token": grant.token,
        "id": grant.id,
        "name": granted.name,
        "path": granted.root,
        "sandbox": has_sandbox,
    });
    if let Some(file) = &granted.file {
        face["file"] = serde_json::Value::String(file.clone());
    }
    if home {
        face["home"] = serde_json::Value::Bool(true);
    }
    face
}

fn daemon_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The initialization script that tells a window its face before any of its modules run, on every load: the face
/// kept for this window's reloads if the app has handed it one since (a spare worn, a sidecar moved), else the one
/// it was built with. A spare is built with none, and its page waits for `intentic:face`.
fn face_init(face: Option<&serde_json::Value>) -> String {
    let built = face.map_or_else(|| "null".to_string(), serde_json::Value::to_string);
    format!(
        "(function () {{ var face = {built}; try {{ var kept = window.sessionStorage.getItem(\"{FACE_KEY}\"); if (kept) {{ face = JSON.parse(kept); }} }} catch (error) {{}} if (face) {{ window.__INTENTIC_LOCAL__ = Object.freeze(face); }} }})();"
    )
}

/// The spare being worn: its page, already loaded and waiting, is handed its face, which is kept for its reloads
/// (its init script has none of its own).
fn face_given(face: &serde_json::Value) -> String {
    format!(
        "(function () {{ var face = {face}; try {{ window.sessionStorage.setItem(\"{FACE_KEY}\", JSON.stringify(face)); }} catch (error) {{}} window.__INTENTIC_LOCAL__ = Object.freeze(face); window.dispatchEvent(new CustomEvent('intentic:face')); }})();"
    )
}

/// A running page whose sidecar came back on another port: its new face is kept, and the page reloads onto it.
fn face_moved(face: &serde_json::Value) -> String {
    format!(
        "(function () {{ try {{ window.sessionStorage.setItem(\"{FACE_KEY}\", JSON.stringify({face})); }} catch (error) {{}} window.location.reload(); }})();"
    )
}

/// A window pointed at another folder (`point`): its new face is kept for its reloads and handed to the page as a
/// cancelable `intentic:repoint`. A page that takes it (the web's local/folderSwitch.ts) moves to the folder in place,
/// with no reload, so the window never goes blank between the two. One that does not, still booting, reloads onto the
/// folder's files rather than onto whatever screen of the old one it was on.
fn face_pointed(face: &serde_json::Value) -> String {
    format!(
        "(function () {{ var face = {face}; try {{ window.sessionStorage.setItem(\"{FACE_KEY}\", JSON.stringify(face)); }} catch (error) {{}} var taken = !window.dispatchEvent(new CustomEvent('intentic:repoint', {{ cancelable: true, detail: face }})); if (!taken) {{ window.history.replaceState(null, \"\", window.location.pathname + \"#/workspace\"); window.location.reload(); }} }})();"
    )
}

/// A running page whose folder has its own sandbox now (project.rs `remember`): its face is kept with the news, for its
/// reloads, and the page hears it as `intentic:sandbox` rather than reloading over whatever the reader is doing.
fn face_sandboxed(face: &serde_json::Value) -> String {
    format!(
        "(function () {{ try {{ window.sessionStorage.setItem(\"{FACE_KEY}\", JSON.stringify({face})); }} catch (error) {{}} window.dispatchEvent(new CustomEvent('intentic:sandbox', {{ detail: {{ sandbox: true }} }})); }})();"
    )
}

/// The screen a window's shell opens on when it has none of its own yet (`route`, `/device`): its hash, which the
/// shell's router reads (the web's router/index.ts), set only on a page that has none, so a reload keeps its own.
fn route_init(route: &str) -> String {
    let hash = serde_json::Value::String(format!("#{route}"));
    format!("(function () {{ if (!window.location.hash) {{ window.history.replaceState(null, \"\", window.location.pathname + {hash}); }} }})();")
}

/// The app showing an open window for a reason of its own: the shell takes it to `route` (the web's
/// local/LocalShell.vue, `intentic:navigate`).
fn navigate_to(route: &str) -> String {
    let detail = serde_json::json!({ "path": route });
    format!("window.dispatchEvent(new CustomEvent('intentic:navigate', {{ detail: {detail} }}));")
}

/// Take a shown window's shell to `route`.
pub fn navigate(window: &WebviewWindow, route: &str) {
    let _ = window.eval(navigate_to(route));
}

/// A document handed to the folder window that holds it (`intentic:open`), at its root-relative path.
fn open_in_window(path: &str) -> String {
    let detail = serde_json::json!({ "path": path });
    format!("window.dispatchEvent(new CustomEvent('intentic:open', {{ detail: {detail} }}));")
}

/// The sidecar came back on another port, so every window's page holds an address nobody listens on and a token
/// nothing honours any more ([`rehome`] gave each a new one). Each window is handed its new face and reloaded onto
/// it ([`face_moved`]): the simplest thing that leaves every window working, and one that loses nothing a page could
/// still have saved, its server having gone. Closing them instead would lose the same and the windows too.
pub fn moved(app: &AppHandle) {
    for (label, face) in app.state::<LocalFiles>().faces() {
        if let Some(window) = app.get_webview_window(&label) {
            eprintln!("intentic-files moved to another port: reloading {label} onto it");
            let _ = window.eval(face_moved(&face));
        }
    }
}

/* OPENING. */

/// A path without the verbatim prefix Windows' canonical form carries, which no dialog, file manager or person
/// reads as the same folder: `\\?\C:\x` is `C:\x`, and `\\?\UNC\server\share\x` is `\\server\share\x`.
pub fn plain(path: PathBuf) -> PathBuf {
    let text = path.display().to_string();
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{share}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
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
/// the one that draws every window (a dialog's answer, a second launch, a link). What fails is said in a dialog.
pub fn open_later(app: &AppHandle, path: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(text) = open(&app, &path) {
            say(&app, &text);
        }
    });
}

/// Open `path` in a window of its own, or bring back the one already showing it, or hand a document to the folder
/// window that holds it. What fails comes back as the sentence to show; the original goes to stderr.
pub fn open(app: &AppHandle, path: &Path) -> Result<(), String> {
    open_path(app, path).map_err(|trouble| {
        eprintln!(
            "intentic: could not open {}: {}",
            path.display(),
            trouble.detail()
        );
        trouble.friendly(&shown_name(path))
    })
}

/// Where an open goes, given the windows open now.
#[derive(Debug, PartialEq, Eq)]
enum Destination {
    /// A window already shows it: raised.
    Shown(String),
    /// A document inside the root of a folder window: that window is raised and opens it itself (`intentic:open`),
    /// at this root-relative, forward-slashed path. The deepest such root, when folders nest.
    Inside { label: String, path: String },
    /// A window of its own.
    New,
}

fn destination(windows: &HashMap<String, Grant>, asked: &Path, folder: bool) -> Destination {
    if let Some((label, _)) = windows.iter().find(|(_, grant)| grant.asked == asked) {
        return Destination::Shown(label.clone());
    }
    if folder {
        return Destination::New;
    }
    let owner = windows
        .iter()
        .filter(|(_, grant)| grant.folder && asked.starts_with(&grant.root) && asked != grant.root)
        .max_by_key(|(_, grant)| grant.root.components().count());
    match owner.and_then(|(label, grant)| Some((label, asked.strip_prefix(&grant.root).ok()?))) {
        Some((label, relative)) => Destination::Inside {
            label: label.clone(),
            path: slashed(relative),
        },
        None => Destination::New,
    }
}

/// A relative path as the page names entries: its segments joined by forward slashes, whatever the platform.
fn slashed(relative: &Path) -> String {
    relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn open_path(app: &AppHandle, path: &Path) -> Result<(), Trouble> {
    let asked = plain(std::fs::canonicalize(path).map_err(|error| Trouble::io(&error))?);
    let folder = std::fs::metadata(&asked)
        .map_err(|error| Trouble::io(&error))?
        .is_dir();
    let files = app.state::<LocalFiles>();
    let mut opening = files.opening.lock().unwrap();
    let destination = destination(&files.windows.lock().unwrap(), &asked, folder);
    if destination == Destination::New && !opening.insert(asked.clone()) {
        // Already being opened: that open brings its window up when it is ready.
        return Ok(());
    }
    drop(opening);
    match destination {
        Destination::Shown(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                crate::windows::raise_window(&window);
            }
            Ok(())
        }
        Destination::Inside { label, path } => {
            if let Some(window) = app.get_webview_window(&label) {
                crate::windows::raise_window(&window);
                let _ = window.eval(open_in_window(&path));
                app.state::<AppState>().remember_recent(&asked, false);
            }
            Ok(())
        }
        Destination::New => {
            let opened = open_new(app, &asked, folder);
            files.opening.lock().unwrap().remove(&asked);
            opened
        }
    }
}

/// A window of its own for `asked`: granted, then shown, in the spare when there is one ready.
fn open_new(app: &AppHandle, asked: &Path, folder: bool) -> Result<(), Trouble> {
    let port = crate::sidecar::ensure(app)?;
    let files = app.state::<LocalFiles>();
    let mut grant = Grant {
        token: token(),
        id: id_of(asked),
        asked: asked.to_path_buf(),
        folder,
        root: asked.to_path_buf(),
        file: None,
        face: serde_json::Value::Null,
    };
    let granted =
        crate::sidecar::grant(app, &grant.token, &grant_line(&grant)).map_err(|trouble| {
            match trouble {
                // Refused because it went between the look and the grant: said as gone, which is what it is.
                Trouble::Refused(detail) if !asked.exists() => Trouble::Gone(detail),
                other => other,
            }
        })?;
    grant.root = PathBuf::from(&granted.root);
    grant.file.clone_from(&granted.file);
    // Whether the way to an agent is a new sandbox or this folder's own (project.rs), whose sandbox is still there.
    let has_sandbox = folder && crate::project::has_live_project(app, &grant.root);
    grant.face = face_of(port, &grant, &granted, has_sandbox, false);
    let title = format!("{} · Intentic", granted.name);
    match take_spare(app) {
        Some(window) => {
            files
                .windows
                .lock()
                .unwrap()
                .insert(window.label().to_string(), grant.clone());
            crate::windows::wear_face(app, &window, &title, &face_given(&grant.face));
        }
        None => {
            let label = next_label(&files);
            files
                .windows
                .lock()
                .unwrap()
                .insert(label.clone(), grant.clone());
            if let Err(error) = crate::windows::show_files_window(
                app,
                &label,
                &title,
                &face_init(Some(&grant.face)),
                FilesWindow::Shown,
            ) {
                files.windows.lock().unwrap().remove(&label);
                let _ = crate::sidecar::send(app, &revoke_line(&grant.token));
                return Err(Trouble::Failed(error));
            }
        }
    }
    app.state::<AppState>().remember_recent(asked, folder);
    shown_one(app, Spare::Keep);
    Ok(())
}

fn next_label(files: &LocalFiles) -> String {
    format!("{FILES}{}", files.next.fetch_add(1, Ordering::Relaxed) + 1)
}

/// Whether a window that came up keeps a spare coming for the next one.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Spare {
    Keep,
    /// The main window: it is up on every launch, and a hidden editor built beside it for a second window that most
    /// runs never open would be memory spent for nothing. The first folder window of a run starts the spares.
    None,
}

/// A local window came up. The first of the run is what asks for the office editor (sidecar.rs); every one moves
/// the idle clock on, and a folder or document window keeps a spare coming for the next.
fn shown_one(app: &AppHandle, spare: Spare) {
    let files = app.state::<LocalFiles>();
    files.idle.fetch_add(1, Ordering::SeqCst);
    if !files.shown_any.swap(true, Ordering::SeqCst) {
        crate::sidecar::want_office(app);
    }
    if spare == Spare::Keep {
        keep_a_spare(app);
    }
}

/* THE MAIN WINDOW (windows.rs `HOME`): the shell on this computer's own folder, where a launch opens. */

/// The folder the main window opens on: the one it was last pointed at, while it is there, else `~/intentic/local`,
/// made on the way. A folder that cannot be made is said in the reader's words.
fn home_folder(state: &AppState) -> Result<PathBuf, Trouble> {
    let remembered = state.home_folder();
    if remembered.is_dir() {
        return Ok(remembered);
    }
    let fallback = state.default_home().to_path_buf();
    std::fs::create_dir_all(&fallback).map_err(|error| Trouble::io(&error))?;
    Ok(fallback)
}

/// [`open_home`], off the calling thread: it may wait on the sidecar's first start, and the thread asking is often the
/// one that draws every window (a launch, the tray). What fails is said in a dialog.
pub fn open_home_later(app: &AppHandle, route: Option<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(trouble) = open_home(&app, route.as_deref()) {
            eprintln!(
                "intentic: the main window did not open: {}",
                trouble.detail()
            );
            let folder = app.state::<AppState>().home_folder();
            say(&app, &trouble.friendly(&shown_name(&folder)));
        }
    });
}

/// Build the main window on its folder, at `route` when given, in the frame the workspace holds when it is on
/// screen (windows.rs). Never twice: a second caller while the first is still building finds it being built.
fn open_home(app: &AppHandle, route: Option<&str>) -> Result<(), Trouble> {
    let files = app.state::<LocalFiles>();
    if files.home_opening.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let opened = build_home(app, route);
    files.home_opening.store(false, Ordering::SeqCst);
    opened
}

fn build_home(app: &AppHandle, route: Option<&str>) -> Result<(), Trouble> {
    if app.get_webview_window(crate::windows::HOME).is_some() {
        return Ok(());
    }
    let state = app.state::<AppState>();
    let folder =
        plain(std::fs::canonicalize(home_folder(&state)?).map_err(|error| Trouble::io(&error))?);
    let port = crate::sidecar::ensure(app)?;
    let files = app.state::<LocalFiles>();
    let (grant, name) = granted_folder(app, port, &folder, true)?;
    files
        .windows
        .lock()
        .unwrap()
        .insert(crate::windows::HOME.to_string(), grant.clone());
    let init = format!(
        "{}{}",
        face_init(Some(&grant.face)),
        route.map(route_init).unwrap_or_default()
    );
    if let Err(error) = crate::windows::show_files_window(
        app,
        crate::windows::HOME,
        &format!("{name} · Intentic"),
        &init,
        FilesWindow::Home,
    ) {
        files.windows.lock().unwrap().remove(crate::windows::HOME);
        let _ = crate::sidecar::send(app, &revoke_line(&grant.token));
        return Err(Trouble::Failed(error));
    }
    state.remember_recent(&folder, true);
    state.remember_home_folder(&folder);
    shown_one(app, Spare::None);
    Ok(())
}

/// A grant of `folder` for one window, answered by the sidecar, and the face that window is told: the folder's own
/// name, whether it has a sandbox of its own (project.rs), whether the window is the main one.
fn granted_folder(
    app: &AppHandle,
    port: u16,
    folder: &Path,
    home: bool,
) -> Result<(Grant, String), Trouble> {
    let mut grant = Grant {
        token: token(),
        id: id_of(folder),
        asked: folder.to_path_buf(),
        folder: true,
        root: folder.to_path_buf(),
        file: None,
        face: serde_json::Value::Null,
    };
    let granted =
        crate::sidecar::grant(app, &grant.token, &grant_line(&grant)).map_err(|trouble| {
            match trouble {
                Trouble::Refused(detail) if !folder.exists() => Trouble::Gone(detail),
                other => other,
            }
        })?;
    grant.root = PathBuf::from(&granted.root);
    let has_sandbox = crate::project::has_live_project(app, &grant.root);
    grant.face = face_of(port, &grant, &granted, has_sandbox, home);
    Ok((grant, granted.name))
}

/* POINTING A WINDOW AT ANOTHER FOLDER — the folder menu (the web's local/LocalFolderMenu.vue). */

/// Show `path`, a folder, in the window `label`, in place of the folder it shows: a grant of its own, the old one
/// revoked once the page has had time to leave it, the page moved onto the new face in place ([`face_pointed`]). A
/// folder another window already shows is that window's, which is
/// raised instead: two windows on one folder would each keep their own unsaved copy of its documents. The main
/// window remembers where it was pointed, so the next launch opens there.
pub fn point(app: &AppHandle, label: &str, path: &Path) -> Result<(), Trouble> {
    let asked = plain(std::fs::canonicalize(path).map_err(|error| Trouble::io(&error))?);
    if !std::fs::metadata(&asked)
        .map_err(|error| Trouble::io(&error))?
        .is_dir()
    {
        return open_path(app, &asked);
    }
    let files = app.state::<LocalFiles>();
    let shown = files
        .windows
        .lock()
        .unwrap()
        .iter()
        .find(|(_, grant)| grant.asked == asked)
        .map(|(shows, _)| shows.clone());
    if let Some(shows) = shown {
        if shows != label {
            if let Some(window) = app.get_webview_window(&shows) {
                crate::windows::raise_window(&window);
            }
        }
        return Ok(());
    }
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| Trouble::Failed(format!("{label} is not open")))?;
    let port = crate::sidecar::ensure(app)?;
    let home = label == crate::windows::HOME;
    let (grant, name) = granted_folder(app, port, &asked, home)?;
    let replaced = files
        .windows
        .lock()
        .unwrap()
        .insert(label.to_string(), grant.clone());
    if let Some(old) = replaced {
        revoke_later(app, old.token);
    }
    let _ = window.set_title(&format!("{name} · Intentic"));
    let _ = window.eval(face_pointed(&grant.face));
    let state = app.state::<AppState>();
    state.remember_recent(&asked, true);
    if home {
        state.remember_home_folder(&asked);
    }
    Ok(())
}

/// Revoke a grant the window has just left, after [`POINTED_GRACE`]. A sidecar that came back on another port meanwhile
/// never knew the token, and a revoke of a token it does not hold is nothing to it.
fn revoke_later(app: &AppHandle, token: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(POINTED_GRACE).await;
        let _ = crate::sidecar::send(&app, &revoke_line(&token));
    });
}

/* THE WARM WINDOW — one hidden files window, already loaded, that the next open wears. */

/// Build a spare after [`SPARE_AFTER`], unless there is one. `INTENTIC_WARM_WINDOW=0` turns spares off.
fn keep_a_spare(app: &AppHandle) {
    if std::env::var("INTENTIC_WARM_WINDOW").is_ok_and(|value| value == "0") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SPARE_AFTER).await;
        build_spare(&app);
    });
}

/// The spare: the same window a grant gets (`show_files_window`: builder, label, desktop facts, handlers), hidden,
/// with no face. Its slot is taken before it is built and not held while it is: building waits on the main thread,
/// which is where [`page_loaded`] takes the same lock.
fn build_spare(app: &AppHandle) {
    let files = app.state::<LocalFiles>();
    let label = {
        let mut spare = files.spare.lock().unwrap();
        if spare.is_some() {
            return;
        }
        let label = next_label(&files);
        *spare = Some(SpareWindow {
            label: label.clone(),
            loaded: false,
        });
        label
    };
    if let Err(error) = crate::windows::show_files_window(
        app,
        &label,
        "Intentic",
        &face_init(None),
        FilesWindow::Spare,
    ) {
        eprintln!("the spare local window did not open: {error}");
        let mut spare = files.spare.lock().unwrap();
        if spare.as_ref().is_some_and(|held| held.label == label) {
            *spare = None;
        }
    }
}

/// A files window's page finished loading: the spare's is what makes it wearable.
pub fn page_loaded(app: &AppHandle, label: &str) {
    if let Some(spare) = app
        .state::<LocalFiles>()
        .spare
        .lock()
        .unwrap()
        .as_mut()
        .filter(|spare| spare.label == label)
    {
        spare.loaded = true;
    }
}

/// The spare, taken to be worn, when its page has loaded; otherwise none, and it stays for the next open.
fn take_spare(app: &AppHandle) -> Option<WebviewWindow> {
    let files = app.state::<LocalFiles>();
    let label = {
        let mut spare = files.spare.lock().unwrap();
        match spare.as_ref() {
            Some(held) if held.loaded => spare.take().map(|held| held.label),
            _ => None,
        }
    }?;
    app.get_webview_window(&label)
}

/// Whether any window is open beside the main one: a folder or a document opened on its own, the windows a spare is
/// kept for. The main window alone keeps none, however long it is open.
fn beside_home(windows: &HashMap<String, Grant>) -> bool {
    windows.keys().any(|label| label != crate::windows::HOME)
}

fn opened_beside_home(files: &LocalFiles) -> bool {
    beside_home(&files.windows.lock().unwrap())
}

/// The last folder or document window closed: the spare goes too if nothing opens for [`SPARE_IDLE`].
fn retire_spare_later(app: &AppHandle) {
    let epoch = app
        .state::<LocalFiles>()
        .idle
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SPARE_IDLE).await;
        let files = app.state::<LocalFiles>();
        if files.idle.load(Ordering::SeqCst) != epoch || opened_beside_home(&files) {
            return;
        }
        let label = files.spare.lock().unwrap().take().map(|held| held.label);
        if let Some(window) = label.and_then(|label| app.get_webview_window(&label)) {
            let _ = window.destroy();
        }
    });
}

/// The window is gone, and so is what it could read.
pub fn window_closed(app: &AppHandle, label: &str) {
    let files = app.state::<LocalFiles>();
    {
        let mut spare = files.spare.lock().unwrap();
        if spare.as_ref().is_some_and(|held| held.label == label) {
            *spare = None;
        }
    }
    let (removed, none_left) = {
        let mut windows = files.windows.lock().unwrap();
        let removed = windows.remove(label);
        (removed, !beside_home(&windows))
    };
    if let Some(grant) = removed {
        let _ = crate::sidecar::send(app, &revoke_line(&grant.token));
        if none_left {
            retire_spare_later(app);
        }
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
    arg_path(arg, cwd).filter(|path| path.exists())
}

/// `arg` read as a path, before anything asks whether it is there.
fn arg_path(arg: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    if arg.is_empty() || arg.starts_with('-') || arg.starts_with("intentic://") {
        return None;
    }
    let path = if arg.starts_with("file://") {
        url::Url::parse(arg).ok()?.to_file_path().ok()?
    } else {
        PathBuf::from(drive_root(arg).unwrap_or_else(|| arg.to_string()))
    };
    Some(match cwd {
        Some(cwd) if path.is_relative() => cwd.join(path),
        _ => path,
    })
}

/// A drive root as Explorer hands it to "Open with Intentic" on the empty space of one: the command is `"%V"`, `%V`
/// is `E:\`, and the command line reads the `\"` of `"E:\"` as an escaped quote, so the argument arrives as `E:"`.
fn drive_root(arg: &str) -> Option<String> {
    match arg.as_bytes() {
        [letter, b':', b'"'] if letter.is_ascii_alphabetic() => {
            Some(format!("{}:\\", char::from(*letter)))
        }
        _ => None,
    }
}

/* WHAT A LOCAL WINDOW ASKS FOR (setup_link.rs `LocalVerb`). */

pub fn act(app: &AppHandle, label: &str, verb: LocalVerb) {
    match verb {
        LocalVerb::OpenFolder => pick(app, true),
        LocalVerb::OpenFile => pick(app, false),
        LocalVerb::Reveal(path) => reveal(app, label, path.as_deref()),
        LocalVerb::Sandbox => sandbox(app, label),
        LocalVerb::Ask(path) => ask(app, label, &path),
        LocalVerb::Changes
        | LocalVerb::BringBack(_)
        | LocalVerb::Restore(_)
        | LocalVerb::Direction(_) => {
            // A project is a folder: a document window has none to work.
            if let Some(grant) = grant_of(app, label).filter(|grant| grant.folder) {
                crate::project::work(app, label, &grant.root, &verb);
            }
        }
    }
}

fn grant_of(app: &AppHandle, label: &str) -> Option<Grant> {
    app.state::<LocalFiles>()
        .windows
        .lock()
        .unwrap()
        .get(label)
        .cloned()
}

/// What the window `label` shows: its folder, or none for a document opened on its own and for a window that is not a
/// local one. The only place a project's folder comes from (project.rs): the page asks about "this folder" and never
/// names one.
pub fn folder_of(app: &AppHandle, label: &str) -> Option<PathBuf> {
    grant_of(app, label)
        .filter(|grant| grant.folder)
        .map(|grant| grant.root)
}

/// Every window on `folder` hears that it has its own sandbox now: its "Work on this with an agent" becomes the way to
/// that sandbox, and its bring-back appears, without a reload (the web's local/folderSandbox.ts).
pub fn mark_sandbox(app: &AppHandle, folder: &Path) {
    for (label, face) in app.state::<LocalFiles>().mark_sandbox(folder) {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.eval(face_sandboxed(&face));
        }
    }
}

/// "Work on this with an agent", for the folder a window shows (project.rs): its sandbox opened, or its own dialog
/// asked for. A document opened alone has no folder of its own to hand over, so the window is told to open its folder
/// first.
fn sandbox(app: &AppHandle, label: &str) {
    let Some(grant) = grant_of(app, label) else {
        return;
    };
    if grant.folder {
        crate::project::start(app, label, grant.root);
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
    let Some(grant) = grant_of(app, label) else {
        return;
    };
    let entry = path.and_then(|path| inside(&grant.root, path));
    let (target, shown) = match showing(&grant, entry) {
        Showing::Open(folder) => {
            let shown = app
                .opener()
                .open_path(folder.to_string_lossy(), None::<&str>);
            (folder, shown)
        }
        Showing::Select(entry) => {
            let shown = app.opener().reveal_item_in_dir(&entry);
            (entry, shown)
        }
    };
    if let Err(error) = shown {
        eprintln!(
            "could not show {} in the file manager: {error}",
            target.display()
        );
    }
}

/// What the file manager is asked to show for a reveal.
#[derive(Debug, PartialEq, Eq)]
enum Showing {
    /// A folder, opened on its own contents: what the window's tree lists.
    Open(PathBuf),
    /// An entry, selected in the folder that holds it.
    Select(PathBuf),
}

/// A folder window's own folder is opened, never selected in its parent. "Reveal" on the root used to open the
/// folder ABOVE it (a project in Downloads showed Downloads, with the project merely highlighted), which is not the
/// folder the window shows. An entry inside it is selected where it lies, and a document opened alone is selected
/// in its own folder.
fn showing(grant: &Grant, entry: Option<PathBuf>) -> Showing {
    match entry {
        Some(entry) if entry != grant.root => Showing::Select(entry),
        _ if grant.folder => Showing::Open(grant.root.clone()),
        _ => Showing::Select(grant.asked.clone()),
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

/* "ASK ABOUT THIS" — one file of a window's, handed to the workspace. */

/// The file a window asks about: `path` inside a folder window's own folder, or a document window's document
/// whatever it names. Only a file: a folder is not something the workspace can be handed to read.
fn ask(app: &AppHandle, label: &str, path: &str) {
    let Some(grant) = grant_of(app, label) else {
        return;
    };
    let target = if grant.folder {
        inside(&grant.root, path)
    } else {
        Some(grant.asked.clone())
    };
    let Some(file) = target.filter(|target| target.is_file()) else {
        eprintln!("{label} asked about {path}, which is not a file of its own");
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(trouble) = hand_off(&app, &file) {
            eprintln!(
                "intentic: could not hand {} to the workspace: {}",
                file.display(),
                trouble.detail()
            );
            say(&app, &trouble.friendly(&shown_name(&file)));
        }
    });
}

/// A read-only grant of `file` for the workspace's origin alone, for [`HANDOFF_LIFE`], and the workspace opened on
/// it (`/?handoff=…`). The grant is never a window's: it is not shown, not counted, and gone when it expires.
fn hand_off(app: &AppHandle, file: &Path) -> Result<(), Trouble> {
    let port = crate::sidecar::ensure(app)?;
    let files = app.state::<LocalFiles>();
    let now = Instant::now();
    let handoff = Handoff {
        token: token(),
        id: format!(
            "handoff-{}",
            files.next_handoff.fetch_add(1, Ordering::Relaxed) + 1
        ),
        path: file.to_path_buf(),
        origin: origin_of(&app.state::<AppState>().app_url()),
        expires: now + HANDOFF_LIFE,
    };
    let line = handoff_line(&handoff, now)
        .ok_or_else(|| Trouble::Failed("a handoff expired before it was granted".to_string()))?;
    let granted = crate::sidecar::grant(app, &handoff.token, &line)?;
    files.handoffs.lock().unwrap().push(handoff.clone());
    crate::windows::show_workspace_at(app, Some(&handoff_path(port, &handoff.token, &granted)));
    Ok(())
}

/// The origin of the workspace's address, the one page the handoff may be read from.
fn origin_of(app_url: &str) -> String {
    let parsed = url::Url::parse(app_url)
        .ok()
        .filter(|url| url.origin().is_tuple())
        .unwrap_or_else(|| {
            url::Url::parse(crate::state::APP_URL).expect("the static app url parses")
        });
    parsed.origin().ascii_serialization()
}

/// Where the workspace opens to take the handoff (`/?handoff=`, the web's side): base64url, unpadded, of
/// `{ url, token, name }`, where `url` reads the file from the sidecar by its name relative to the grant's root.
fn handoff_path(port: u16, token: &str, granted: &Granted) -> String {
    let relative = granted.file.clone().unwrap_or_else(|| granted.name.clone());
    let mut url = url::Url::parse(&format!("{}/workspace/raw", daemon_url(port)))
        .expect("a loopback url parses");
    url.query_pairs_mut().append_pair("path", &relative);
    let handoff = serde_json::json!({ "url": url.as_str(), "token": token, "name": granted.name });
    format!(
        "/?handoff={}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(handoff.to_string())
    )
}

/* THE SHELL'S COMMANDS: its folder menu and place chip, from a local window's page (the web's localHost.ts, this app's src/host.ts). */

/// The system dialog, then what was chosen: a folder shown in the window that asked, in place of its own (`point`), a
/// document opened where [`open`] puts it. Nothing chosen changes nothing; what fails is said in a dialog, since the
/// answer comes long after the press.
#[tauri::command]
pub fn local_pick(app: AppHandle, window: WebviewWindow, folder: bool) {
    let label = window.label().to_string();
    let handle = app.clone();
    let chosen = move |path: Option<tauri_plugin_dialog::FilePath>| {
        let Some(path) = path.and_then(|path| path.into_path().ok()) else {
            return;
        };
        if !folder {
            open_later(&handle, path);
            return;
        }
        let app = handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(trouble) = point(&app, &label, &path) {
                eprintln!(
                    "intentic: could not show {}: {}",
                    path.display(),
                    trouble.detail()
                );
                say(&app, &trouble.friendly(&shown_name(&path)));
            }
        });
    };
    let dialog = app.dialog().file().set_parent(&window);
    if folder {
        dialog.pick_folder(chosen);
    } else {
        dialog.pick_file(chosen);
    }
}

/// The folder menu's folder: shown in the window that asked, in place of its own. What fails comes back as the
/// sentence the menu shows under the row, so no dialog is raised.
#[tauri::command]
pub async fn local_point(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&path);
        point(&app, &label, &path).map_err(|trouble| {
            eprintln!(
                "intentic: could not show {}: {}",
                path.display(),
                trouble.detail()
            );
            trouble.friendly(&shown_name(&path))
        })
    })
    .await
    .map_err(|error| format!("opening stopped: {error}"))?
}

/// The folder menu's document, or a folder asked for by name: what fails comes back as the sentence the menu shows
/// under the row, so no dialog is raised.
#[tauri::command]
pub async fn local_open_path(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open(&app, Path::new(&path)))
        .await
        .map_err(|error| format!("opening stopped: {error}"))?
}

/// The recents with whether each is there now: off the main thread, since asking a network drive that has gone
/// away whether a path exists can take the OS's whole timeout.
#[tauri::command]
pub async fn local_recents(app: AppHandle) -> Result<Vec<RecentView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        crate::state::recent_views(state.recents(), &state.projects(), Path::exists)
    })
    .await
    .map_err(|error| format!("the recents could not be read: {error}"))
}

#[tauri::command]
pub fn local_forget_recent(app: AppHandle, path: String) {
    app.state::<AppState>().forget_recent(&path);
}

/// Who is signed in to the workspace and the sandboxes it last listed, for the place chip's Sandboxes and the rail's
/// account: a local window cannot ask the platform itself (it holds no session, and its page reaches nothing but
/// loopback and the app).
#[tauri::command]
pub fn local_roster(app: AppHandle) -> crate::setup_link::Roster {
    app.state::<AppState>().roster()
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

    /// "Open with Intentic" on the empty space of a drive: `"%V"` delivers `E:"`, which is the root `E:\`.
    #[test]
    fn a_drive_root_delivered_with_a_stray_quote_is_that_root() {
        assert_eq!(drive_root("E:\""), Some(r"E:\".to_string()));
        assert_eq!(drive_root("c:\""), Some(r"c:\".to_string()));
        assert_eq!(arg_path("E:\"", None), Some(PathBuf::from(r"E:\")));
        // Only a bare drive: anything longer is a path of its own, and a quote elsewhere is not this.
        assert_eq!(drive_root("E:"), None);
        assert_eq!(drive_root("E:\\"), None);
        assert_eq!(drive_root("EE\""), None);
        assert_eq!(drive_root("1:\""), None);
        assert_eq!(arg_path("E:\\work", None), Some(PathBuf::from(r"E:\work")));
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

    /// The window's own folder opens on its contents; it is never selected in the folder above it.
    #[test]
    fn a_reveal_opens_the_window_s_folder_and_selects_an_entry_in_it() {
        let folder = grant("/home/me/Downloads/site", true, "/home/me/Downloads/site");
        let root = PathBuf::from("/home/me/Downloads/site");
        assert_eq!(showing(&folder, None), Showing::Open(root.clone()));
        assert_eq!(
            showing(&folder, Some(root.clone())),
            Showing::Open(root.clone())
        );
        assert_eq!(
            showing(&folder, Some(root.join("index.html"))),
            Showing::Select(root.join("index.html"))
        );
        assert_eq!(
            showing(&folder, Some(root.join("src"))),
            Showing::Select(root.join("src"))
        );
        // A document opened on its own is selected in the folder that holds it.
        let document = grant("/home/me/notes.md", false, "/home/me");
        assert_eq!(
            showing(&document, None),
            Showing::Select(PathBuf::from("/home/me/notes.md"))
        );
        assert_eq!(
            showing(&document, Some(PathBuf::from("/home/me"))),
            Showing::Select(PathBuf::from("/home/me/notes.md"))
        );
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

    fn grant(asked: &str, folder: bool, root: &str) -> Grant {
        Grant {
            token: "t".repeat(64),
            id: "abc".into(),
            asked: PathBuf::from(asked),
            folder,
            root: PathBuf::from(root),
            file: None,
            face: serde_json::Value::Null,
        }
    }

    /// A folder's face has no `file` at all: the window shows its tree only when the key is absent.
    #[test]
    fn a_folder_window_is_told_of_no_file_and_a_document_window_of_its_own() {
        let grant = grant("/home/me/app", true, "/home/me/app");
        let folder = Granted {
            root: "/home/me/app".into(),
            name: "app".into(),
            file: None,
        };
        let face = face_of(4100, &grant, &folder, true, false);
        assert_eq!(face["daemonUrl"], "http://127.0.0.1:4100");
        assert_eq!(face["sandbox"], true);
        assert!(face.get("file").is_none(), "{face}");
        let document = Granted {
            root: "/home/me/app".into(),
            name: "brief.docx".into(),
            file: Some("brief.docx".into()),
        };
        assert_eq!(
            face_of(4100, &grant, &document, false, false)["file"],
            "brief.docx"
        );
    }

    /// Only the main window is told it is one, and a folder window is told nothing of it at all: the page reads an
    /// absent `home` as any other window, the one that leaves the app's parked work alone.
    #[test]
    fn the_main_window_alone_is_told_it_is_the_main_window() {
        let grant = grant("/home/me/intentic/local", true, "/home/me/intentic/local");
        let folder = Granted {
            root: "/home/me/intentic/local".into(),
            name: "local".into(),
            file: None,
        };
        assert_eq!(face_of(4100, &grant, &folder, false, true)["home"], true);
        let other = face_of(4100, &grant, &folder, false, false);
        assert!(other.get("home").is_none(), "{other}");
    }

    /// A window opened for a screen of its own starts there, and a reload keeps whatever screen it moved to since.
    #[test]
    fn a_window_opened_for_this_device_starts_there_but_a_reload_keeps_its_own_screen() {
        let init = route_init("/device");
        assert!(init.contains("if (!window.location.hash)"), "{init}");
        assert!(init.contains("\"#/device\""), "{init}");
        assert_eq!(
            navigate_to("/device"),
            "window.dispatchEvent(new CustomEvent('intentic:navigate', { detail: {\"path\":\"/device\"} }));"
        );
    }

    #[test]
    fn windows_paths_lose_the_verbatim_prefix_a_share_included() {
        assert_eq!(
            plain(PathBuf::from(r"\\?\C:\Users\me")),
            PathBuf::from(r"C:\Users\me")
        );
        assert_eq!(
            plain(PathBuf::from(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
        assert_eq!(
            plain(PathBuf::from(r"\\?\UNC\server\share")),
            PathBuf::from(r"\\server\share")
        );
        assert_eq!(plain(PathBuf::from("/home/me")), PathBuf::from("/home/me"));
    }

    /// Each failure in the words the user reads: named for what could not be opened, never an OS error code.
    #[test]
    fn every_open_failure_is_said_in_the_user_s_words() {
        let gone = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(
            Trouble::io(&gone).friendly("brief.docx"),
            "“brief.docx” isn't there any more. It may have been moved or deleted."
        );
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            Trouble::io(&denied).friendly("Finance"),
            "Intentic isn't allowed to open “Finance”."
        );
        assert_eq!(
            Trouble::Missing("no binary".into()).friendly("x"),
            "Part of Intentic is missing. Reinstalling Intentic fixes this."
        );
        assert_eq!(
            Trouble::NotStarted("timed out".into()).friendly("x"),
            "Intentic's file server didn't start. Try again, or restart Intentic."
        );
        assert_eq!(
            Trouble::Refused("is not a folder".into()).friendly("x"),
            "Intentic couldn't open “x”."
        );
        // The original survives for stderr.
        assert_eq!(
            Trouble::NotStarted("timed out".into()).detail(),
            "timed out"
        );
        assert_eq!(shown_name(Path::new("/home/me/brief.docx")), "brief.docx");
        assert_eq!(shown_name(Path::new("/")), "/");
    }

    fn windows_of(grants: &[(&str, Grant)]) -> HashMap<String, Grant> {
        grants
            .iter()
            .map(|(label, grant)| (label.to_string(), grant.clone()))
            .collect()
    }

    /// Where an open goes: the window already showing it, the deepest folder window holding a document, or a window
    /// of its own. A document window never takes another document, and a folder is never handed to a window.
    #[test]
    fn an_open_goes_to_the_window_that_shows_or_holds_it() {
        let windows = windows_of(&[
            ("files-1", grant("/home/me/app", true, "/home/me/app")),
            (
                "files-2",
                grant("/home/me/app/web", true, "/home/me/app/web"),
            ),
            (
                "files-3",
                grant("/home/me/notes/todo.md", false, "/home/me/notes"),
            ),
        ]);
        assert_eq!(
            destination(&windows, Path::new("/home/me/app"), true),
            Destination::Shown("files-1".into())
        );
        assert_eq!(
            destination(&windows, Path::new("/home/me/notes/todo.md"), false),
            Destination::Shown("files-3".into())
        );
        assert_eq!(
            destination(&windows, Path::new("/home/me/app/docs/a b.md"), false),
            Destination::Inside {
                label: "files-1".into(),
                path: "docs/a b.md".into()
            }
        );
        assert_eq!(
            destination(&windows, Path::new("/home/me/app/web/src/main.ts"), false),
            Destination::Inside {
                label: "files-2".into(),
                path: "src/main.ts".into()
            }
        );
        assert_eq!(
            destination(&windows, Path::new("/home/me/notes/other.md"), false),
            Destination::New
        );
        assert_eq!(
            destination(&windows, Path::new("/home/me/app/docs"), true),
            Destination::New
        );
        assert_eq!(
            destination(&windows, Path::new("/home/me/apple.md"), false),
            Destination::New
        );
    }

    /// What a page is handed by eval is one statement whatever the path holds: serde escapes it.
    #[test]
    fn a_document_handed_to_its_folder_window_arrives_as_a_path() {
        assert_eq!(
            open_in_window("docs/it's \"here\".md"),
            r#"window.dispatchEvent(new CustomEvent('intentic:open', { detail: {"path":"docs/it's \"here\".md"} }));"#
        );
    }

    /// The face a window reads on every load: the one kept for its reloads first, then the one it was built with,
    /// none for a spare; and what a spare is handed is kept, set and announced.
    #[test]
    fn a_face_survives_the_window_s_reloads() {
        let face = serde_json::json!({ "daemonUrl": "http://127.0.0.1:4100", "token": "t" });
        let built = face_init(Some(&face));
        assert!(
            built.contains(r#"var face = {"daemonUrl":"http://127.0.0.1:4100","token":"t"};"#),
            "{built}"
        );
        assert!(
            built.contains(r#"sessionStorage.getItem("intentic.local.face")"#),
            "{built}"
        );
        assert!(
            built.contains("window.__INTENTIC_LOCAL__ = Object.freeze(face)"),
            "{built}"
        );
        assert!(face_init(None).contains("var face = null;"));
        let given = face_given(&face);
        assert!(
            given.contains(r#"sessionStorage.setItem("intentic.local.face""#),
            "{given}"
        );
        assert!(
            given.contains("window.dispatchEvent(new CustomEvent('intentic:face'))"),
            "{given}"
        );
        let moved = face_moved(&face);
        assert!(moved.contains("window.location.reload()"), "{moved}");
        // A folder that has its sandbox now keeps that for its reloads, and its page hears it without one.
        let sandboxed = face_sandboxed(&face);
        assert!(
            sandboxed.contains(r#"sessionStorage.setItem("intentic.local.face""#),
            "{sandboxed}"
        );
        assert!(
            sandboxed.contains(
                "window.dispatchEvent(new CustomEvent('intentic:sandbox', { detail: { sandbox: true } }))"
            ),
            "{sandboxed}"
        );
        assert!(!sandboxed.contains("reload"), "{sandboxed}");
        // A window pointed at another folder keeps it for its reloads and offers it to the page, which moves in place;
        // only a page that does not take it reloads, and onto the folder's files.
        let pointed = face_pointed(&face);
        assert!(
            pointed
                .contains(r#"sessionStorage.setItem("intentic.local.face", JSON.stringify(face))"#),
            "{pointed}"
        );
        assert!(
            pointed.contains(
                "var taken = !window.dispatchEvent(new CustomEvent('intentic:repoint', { cancelable: true, detail: face }));"
            ),
            "{pointed}"
        );
        assert!(
            pointed.contains(r##"if (!taken) { window.history.replaceState(null, "", window.location.pathname + "#/workspace"); window.location.reload(); }"##),
            "{pointed}"
        );
    }

    /// Only the windows on that very folder are told it has a sandbox: not a document opened from inside it, and not a
    /// window on another folder.
    #[test]
    fn only_the_folder_s_own_windows_hear_it_has_a_sandbox() {
        let files = LocalFiles::default();
        let grant = |root: &str, folder: bool| Grant {
            token: "t".into(),
            id: "i".into(),
            asked: PathBuf::from(root),
            folder,
            root: PathBuf::from(root),
            file: None,
            face: serde_json::json!({ "path": root, "sandbox": false }),
        };
        {
            let mut windows = files.windows.lock().unwrap();
            windows.insert("home".into(), grant("/home/me/app", true));
            windows.insert("files-1".into(), grant("/home/me/app", false));
            windows.insert("files-2".into(), grant("/home/me/other", true));
        }
        let told = files.mark_sandbox(Path::new("/home/me/app"));
        assert_eq!(
            told,
            vec![(
                "home".to_string(),
                serde_json::json!({ "path": "/home/me/app", "sandbox": true })
            )]
        );
        let windows = files.windows.lock().unwrap();
        assert_eq!(windows["home"].face["sandbox"], true);
        assert_eq!(windows["files-1"].face["sandbox"], false);
        assert_eq!(windows["files-2"].face["sandbox"], false);
    }

    /// The handoff grant: one file, read-only, for the workspace's origin alone, for a quarter of an hour, never a
    /// window's; and none at all once it has expired.
    #[test]
    fn a_handoff_is_a_read_only_grant_for_the_workspace_alone() {
        let now = Instant::now();
        let handoff = Handoff {
            token: "k".repeat(64),
            id: "handoff-1".into(),
            path: PathBuf::from("/home/me/app/brief.docx"),
            origin: origin_of("https://app.intentic.dev/"),
            expires: now + HANDOFF_LIFE,
        };
        let line = handoff_line(&handoff, now).unwrap();
        assert!(line.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line).unwrap(),
            serde_json::json!({
                "op": "grant",
                "token": "k".repeat(64),
                "id": "handoff-1",
                "path": "/home/me/app/brief.docx",
                "kind": "file",
                "readOnly": true,
                "origins": ["https://app.intentic.dev"],
                "expiresInMs": 900_000,
            })
        );
        assert_eq!(
            handoff_line(&handoff, now + HANDOFF_LIFE + Duration::from_secs(1)),
            None
        );
        assert_eq!(
            origin_of("http://localhost:47146/app"),
            "http://localhost:47146"
        );
        assert_eq!(origin_of("not a url"), "https://app.intentic.dev");
    }

    /// Where the workspace opens to take a handoff: base64url of `{ url, token, name }`, the url naming the file by
    /// its path relative to the grant's root, encoded.
    #[test]
    fn the_workspace_is_handed_a_url_a_token_and_a_name() {
        let granted = Granted {
            root: "/home/me/app/docs".into(),
            name: "Q3 & plans.docx".into(),
            file: Some("Q3 & plans.docx".into()),
        };
        let path = handoff_path(4100, "tok", &granted);
        let encoded = path.strip_prefix("/?handoff=").unwrap();
        assert!(
            encoded
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
            "{encoded}"
        );
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&decoded).unwrap(),
            serde_json::json!({
                "url": "http://127.0.0.1:4100/workspace/raw?path=Q3+%26+plans.docx",
                "token": "tok",
                "name": "Q3 & plans.docx",
            })
        );
    }

    fn handoff_of(path: &Path, now: Instant) -> Handoff {
        Handoff {
            token: "h".repeat(64),
            id: "handoff-1".into(),
            path: path.to_path_buf(),
            origin: "https://app.intentic.dev".into(),
            expires: now + HANDOFF_LIFE,
        }
    }

    /// A delete reaches only inside the folder a folder window shows: never the folder of a document window, which
    /// may write only its document, nor a handoff's, which is not a window at all. `folder_roots` is what the trash
    /// is checked against (sidecar.rs `trashable`), so it is asked here with all three granted.
    #[test]
    fn only_a_folder_window_s_folder_is_a_place_a_delete_may_reach() {
        let base = plain(std::fs::canonicalize(std::env::temp_dir()).unwrap())
            .join(format!("intentic-roots-{}", uuid::Uuid::new_v4()));
        let (app, notes, shared) = (base.join("app"), base.join("notes"), base.join("shared"));
        for dir in [&app, &notes, &shared] {
            std::fs::create_dir_all(dir).unwrap();
        }
        for file in [
            app.join("a.md"),
            notes.join("todo.md"),
            notes.join("other.md"),
            shared.join("brief.docx"),
        ] {
            std::fs::write(file, b"x").unwrap();
        }
        let files = LocalFiles::default();
        files.windows.lock().unwrap().extend([
            (
                "files-1".to_string(),
                grant(&app.display().to_string(), true, &app.display().to_string()),
            ),
            (
                "files-2".to_string(),
                grant(
                    &notes.join("todo.md").display().to_string(),
                    false,
                    &notes.display().to_string(),
                ),
            ),
        ]);
        files
            .handoffs
            .lock()
            .unwrap()
            .push(handoff_of(&shared.join("brief.docx"), Instant::now()));

        let roots = files.folder_roots();
        assert_eq!(roots, vec![app.clone()]);
        assert_eq!(
            crate::sidecar::trashable(&roots, &app.join("a.md")),
            Ok(app.join("a.md"))
        );
        for reached in [
            notes.join("todo.md"),
            notes.join("other.md"),
            shared.join("brief.docx"),
        ] {
            assert!(
                crate::sidecar::trashable(&roots, &reached).is_err(),
                "{} is not inside a folder window",
                reached.display()
            );
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// A sidecar back on another port: every window and handoff has a new token before anything is granted again,
    /// each window's face carries its new token and address, and no line handed to the new process names an old one.
    #[test]
    fn a_new_port_means_new_tokens_for_every_grant() {
        let now = Instant::now();
        let files = LocalFiles::default();
        let mut window = grant("/home/me/app", true, "/home/me/app");
        window.face = serde_json::json!({ "daemonUrl": daemon_url(4100), "token": window.token, "id": "abc" });
        files
            .windows
            .lock()
            .unwrap()
            .insert("files-1".into(), window);
        files
            .handoffs
            .lock()
            .unwrap()
            .push(handoff_of(Path::new("/home/me/app/brief.docx"), now));
        let before = files.grant_lines(now);
        assert_eq!(before.len(), 2);

        files.rehome(4200);

        let windows = files.windows.lock().unwrap();
        let moved = &windows["files-1"];
        assert_ne!(moved.token, "t".repeat(64));
        assert_eq!(moved.token.len(), 64);
        assert_eq!(moved.face["token"], moved.token.as_str());
        assert_eq!(moved.face["daemonUrl"], "http://127.0.0.1:4200");
        assert_eq!(
            moved.face["id"], "abc",
            "the rest of the face is the window's still"
        );
        drop(windows);
        assert_ne!(files.handoffs.lock().unwrap()[0].token, "h".repeat(64));
        let after = files.grant_lines(now);
        assert_eq!(after.len(), 2);
        for line in &after {
            assert!(
                !line.contains(&"t".repeat(64)) && !line.contains(&"h".repeat(64)),
                "{line}"
            );
        }
        assert_eq!(
            files.faces()[0].1["token"],
            files.windows.lock().unwrap()["files-1"].token.as_str()
        );
    }

    /// Only the handoffs still alive are handed to a new process, with what is left of their life.
    #[test]
    fn a_restart_hands_back_every_window_and_the_handoffs_still_alive() {
        let now = Instant::now();
        let files = LocalFiles::default();
        files.windows.lock().unwrap().insert(
            "files-1".into(),
            grant("/home/me/app", true, "/home/me/app"),
        );
        let mut expired = handoff_of(Path::new("/home/me/app/old.docx"), now);
        expired.expires = now;
        files.handoffs.lock().unwrap().extend([
            expired,
            handoff_of(Path::new("/home/me/app/brief.docx"), now),
        ]);
        let lines = files.grant_lines(now + Duration::from_secs(60));
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"kind\":\"folder\""), "{}", lines[0]);
        assert!(lines[1].contains("\"expiresInMs\":840000"), "{}", lines[1]);
        assert_eq!(
            files.handoffs.lock().unwrap().len(),
            1,
            "the expired one is dropped"
        );
    }

    #[test]
    fn a_relative_path_is_forward_slashed_on_every_platform() {
        assert_eq!(
            slashed(Path::new("a").join("b").join("c.md").as_path()),
            "a/b/c.md"
        );
        assert_eq!(slashed(Path::new("c.md")), "c.md");
    }
}
