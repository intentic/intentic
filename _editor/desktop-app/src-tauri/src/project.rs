//! A FOLDER BECOMING A SANDBOX'S PROJECT: "Work on this with an agent" in a local window (local.rs).
//!
//! The folder is not the sandbox's `/work` (the daemon keeps its own state, a public `public/` and its starter at that
//! root), but a project inside it, `/work/<name>`. COPY-FIRST: the folder is copied into the sandbox and the copy is
//! kept up to date from here by the machine agent (`_devices/machine/src/sync`); agents change the copy, and nothing in
//! the folder changes until the window's "Bring back changes" brings what they did back, keeping a restore point first
//! ([`work`]).
//!
//! A folder ATTACHES to this computer's own sandbox (machine_sandbox.rs), which the app makes once, after sign-in, in
//! the background: [`project_preview`] says what the window's dialog draws (the folder's size, what to beware of, why
//! it cannot have one, how far this computer's sandbox is), and [`project_attach`] puts the folder in line for it and
//! answers at once. The supervisor attaches it the moment the sandbox is ready (`intentic-machine sync attach`) and
//! follows its first copy; the window's card and button draw both. A folder that already has a sandbox of its own (a
//! per-folder one from before, `projects.json`) keeps opening that one: nothing is moved. A hosted sandbox's project is
//! enrolled as `intentic://sync?…&project=<name>` ([`sync_project`]), and the workspace's own `/setup` page can still
//! hand a project's setup back as `intentic://setup?…&project=<name>` ([`bind`]). The path never rides a link or a
//! command, so no page can point a sandbox at a folder the user did not pick: it is always the folder of the window
//! that asked.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::account::Answered;
use crate::scripts::AgentSilence;
use crate::setup_link::{LocalVerb, Roster, RosterEntry, SetupArgs, SyncArgs};
use crate::state::{AppState, Project};

/// Past this many files the first sync is a long upload, and the folder's dialog says so.
const MANY_FILES: u64 = 20_000;
/// And past this many bytes.
const MANY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// How far the count walks before it stops counting: enough to know "many".
const COUNT_LIMIT: u64 = 60_000;

/// What a project folder's sync leaves on this computer, at any depth (`PROJECT_IGNORES` in
/// `_devices/machine/src/sync/ssh.ts`, which is what the sync actually does): skipped by the count as they are by
/// the sync. Held to that list by `project-ignores.fixture.json`, which both sides' tests read.
const NOT_SYNCED: [&str; 22] = [
    "node_modules",
    "dist",
    ".turbo",
    ".cache",
    ".next",
    ".angular",
    ".astro",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
    ".tmp",
    ".env",
    ".env.local",
    ".env.*.local",
    ".secrets.json",
    "claude.json",
    ".git",
    ".pnpm-store",
    ".image-out",
    "**/.intentic/cache",
    "**/.intentic/local",
];

/// Whether the file or folder at `relative` (under the project folder, `/`-separated) stays on this computer: a
/// [`NOT_SYNCED`] pattern names its last segment, where `*` stands for any run of characters, or a `**/a/b` pattern
/// names the run of folders it ends with, at any depth, as in the sync's own ignore patterns.
fn not_synced(relative: &str) -> bool {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    NOT_SYNCED
        .iter()
        .any(|pattern| match pattern.strip_prefix("**/") {
            Some(tail) => relative == tail || relative.ends_with(&format!("/{tail}")),
            None => matches_name(pattern, name),
        })
}

fn matches_name(pattern: &str, name: &str) -> bool {
    let mut parts = pattern.split('*');
    let Some(mut rest) = name.strip_prefix(parts.next().unwrap_or_default()) else {
        return false;
    };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else {
        return rest.is_empty();
    };
    for part in middle {
        let Some(at) = rest.find(part) else {
            return false;
        };
        rest = &rest[at + part.len()..];
    }
    rest.ends_with(last)
}

/// Top-level names the sandbox keeps for itself: `RESERVED_PROJECT_DIR_NAMES` in
/// `_shared/sandbox-contract/src/ids/project-dir.ts`, as `_sandbox/ic/src/sandbox/project_dir.rs` holds them too.
const RESERVED: [&str; 12] = [
    "public",
    "refs",
    "site",
    "root",
    "intent",
    "desired-state",
    "app",
    "AGENTS.md",
    "node_modules",
    "dist",
    "venv",
    "claude.json",
];

/// A project folder name as the sandbox takes it, the rule ic and the daemon enforce
/// (`_shared/sandbox-contract/src/ids/project-dir.ts`), held to the same cases by `project-dir.fixture.json`.
pub fn is_project_dir_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64
        && chars
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && chars.all(|rest| rest.is_ascii_alphanumeric() || matches!(rest, '.' | '_' | '-'))
        && !RESERVED.contains(&name)
}

/// Why a folder cannot become a project: drawn by the folder's dialog in the reader's language (the web's
/// local/projectWords.ts, by `kind`), and said as [`Refusal::sentence`] where the app speaks for itself (a folder picked
/// in the system's dialog for a hosted sandbox's project).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Refusal {
    /// A whole disk.
    Disk,
    /// The user's whole home folder.
    Home,
    /// A folder that holds the user's home folder.
    HoldsHome,
    /// Fedora Atomic's `/var/home`, which holds everyone's.
    Homes,
    /// A whole home folder under `/var/home`, the user's or another's.
    AHome,
    /// A folder of the system's own.
    System,
    /// Inside `other`, a folder that already has a sandbox.
    Inside { other: String },
    /// Around `other`, a folder that already has a sandbox of its own.
    Around { other: String },
}

impl Refusal {
    pub fn sentence(&self, path: &Path) -> String {
        let shown = path.display();
        match self {
            Refusal::Disk => {
                format!("{shown} is a whole disk. Pick the folder of one project in it.")
            }
            Refusal::Home => {
                format!("{shown} is your whole home folder. Pick the folder of one project in it.")
            }
            Refusal::HoldsHome => {
                format!("{shown} holds your home folder. Pick the folder of one project in it.")
            }
            Refusal::Homes => format!(
                "{shown} holds everyone's home folders. Pick the folder of one project in yours."
            ),
            Refusal::AHome => {
                format!("{shown} is a whole home folder. Pick the folder of one project in it.")
            }
            Refusal::System => format!("{shown} belongs to the system. Pick a folder of your own."),
            Refusal::Inside { other } => {
                format!("{shown} is inside {other}, which already has a sandbox. Open that folder instead.")
            }
            Refusal::Around { other } => {
                format!("{shown} holds {other}, which already has a sandbox of its own.")
            }
        }
    }
}

/// Why `path` cannot become a project, or nothing when it can. `taken` are the folders that already have one.
pub fn refusal(path: &Path, home: Option<&Path>, taken: &[PathBuf]) -> Option<Refusal> {
    if path.parent().is_none() {
        return Some(Refusal::Disk);
    }
    if let Some(inside) = inside_distro(&path.display().to_string()) {
        return distro_refusal(&inside).or_else(|| nested(path, taken));
    }
    if home == Some(path) {
        return Some(Refusal::Home);
    }
    if home.is_some_and(|home| home.starts_with(path)) {
        return Some(Refusal::HoldsHome);
    }
    // Fedora Atomic (Silverblue, Kinoite, Bazzite…) keeps the homes under `/var/home`, `/home` being a link to it:
    // a folder in somebody's home there is theirs, not the system's, whatever the rule for `/var` below says. The
    // homes' own folder, and a home itself, are refused as the ones at `/home` are.
    match path
        .strip_prefix("/var/home")
        .ok()
        .map(|rest| rest.components().count())
    {
        Some(0) => return Some(Refusal::Homes),
        Some(1) => return Some(Refusal::AHome),
        Some(_) => return nested(path, taken),
        None => {}
    }
    let system = if cfg!(windows) {
        windows_system(&path.display().to_string())
    } else {
        POSIX_SYSTEM
            .iter()
            .any(|root| path.starts_with(format!("/{root}")))
    };
    if system {
        return Some(Refusal::System);
    }
    nested(path, taken)
}

/// The system's own folders on a Linux or macOS disk, by their name under `/`.
const POSIX_SYSTEM: [&str; 13] = [
    "bin",
    "boot",
    "dev",
    "etc",
    "lib",
    "proc",
    "sbin",
    "sys",
    "usr",
    "var",
    "System",
    "Library",
    "Applications",
];

/// (2026-10-06) Whether a Windows path is in one of the system's folders, on whichever drive it is: a second disk can
/// hold a Windows install too. Read off the text, case folded, so the rule is checkable from any host.
fn windows_system(shown: &str) -> bool {
    let bytes = shown.as_bytes();
    if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\' {
        return false;
    }
    let first = shown[3..].split('\\').next().unwrap_or_default();
    [
        "windows",
        "program files",
        "program files (x86)",
        "programdata",
    ]
    .contains(&first.to_ascii_lowercase().as_str())
}

/// (2026-10-06) The Linux path inside a WSL distro of a folder Windows names `\\wsl.localhost\<distro>\…` (or
/// `\\wsl$\…`), `/` for the distro itself; nothing for any other path. The Windows home says nothing of whose the
/// distro's homes are, so such a folder is held to the distro's own rules ([`distro_refusal`]).
fn inside_distro(shown: &str) -> Option<String> {
    let lower = shown.to_ascii_lowercase();
    let prefix = [r"\\wsl.localhost\", r"\\wsl$\"]
        .into_iter()
        .find(|prefix| lower.starts_with(prefix))?;
    let inside = shown[prefix.len()..]
        .split_once('\\')
        .map_or("", |(_, inside)| inside);
    let parts: Vec<&str> = inside.split('\\').filter(|part| !part.is_empty()).collect();
    Some(format!("/{}", parts.join("/")))
}

/// Why a folder at `inside` in a distro cannot become a project: a whole mounted disk (`/mnt/c`), its homes, a whole
/// home in them or root's, and its system's folders, as this app refuses them on Linux.
fn distro_refusal(inside: &str) -> Option<Refusal> {
    let parts: Vec<&str> = inside.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        [] | ["mnt"] | ["mnt", _] => Some(Refusal::Disk),
        ["home"] | ["var", "home"] => Some(Refusal::Homes),
        ["home", _] | ["var", "home", _] | ["root"] => Some(Refusal::AHome),
        ["home", ..] | ["var", "home", ..] => None,
        [first, ..] if POSIX_SYSTEM.contains(first) => Some(Refusal::System),
        _ => None,
    }
}

/// Why `path` cannot become a project for being inside or around one that already is.
fn nested(path: &Path, taken: &[PathBuf]) -> Option<Refusal> {
    for other in taken {
        if path != other && path.starts_with(other) {
            return Some(Refusal::Inside {
                other: other.display().to_string(),
            });
        }
        if path != other && other.starts_with(path) {
            return Some(Refusal::Around {
                other: other.display().to_string(),
            });
        }
    }
    None
}

/// What to say before a folder becomes a project. None of these refuse; each is a way the sync can disappoint, drawn by
/// the folder's dialog by `kind` (the web's local/projectWords.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Caution {
    /// Another service already syncs the folder: two syncs on one folder can undo each other's changes.
    Synced { service: String },
    /// A network or removable drive: the sync is slower there and pauses while it is away.
    Away,
}

/// What to say before `path` becomes a project: a folder another service already syncs, one on a network or a
/// removable drive.
pub fn cautions(path: &Path) -> Vec<Caution> {
    let text = path.display().to_string();
    let mut said = Vec::new();
    for (marker, service) in [
        ("OneDrive", "OneDrive"),
        ("Dropbox", "Dropbox"),
        ("Google Drive", "Google Drive"),
        ("iCloud", "iCloud"),
        ("Mobile Documents", "iCloud"),
    ] {
        if text.contains(marker) {
            said.push(Caution::Synced {
                service: service.to_string(),
            });
            break;
        }
    }
    if text.starts_with(r"\\")
        || text.starts_with("/mnt/")
        || text.starts_with("/media/")
        || text.starts_with("/run/media/")
    {
        said.push(Caution::Away);
    }
    said
}

/// Files and bytes under `path` the sync would carry, counted up to [`COUNT_LIMIT`] files.
fn weigh(path: &Path) -> (u64, u64) {
    let mut files = 0;
    let mut bytes = 0;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let entry_path = entry.path();
            let relative = entry_path.strip_prefix(path).unwrap_or(&entry_path);
            if not_synced(&relative.to_string_lossy().replace('\\', "/")) {
                continue;
            }
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                files += 1;
                bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                if files >= COUNT_LIMIT {
                    return (files, bytes);
                }
            }
        }
    }
    (files, bytes)
}

/// The name the setup page is told the folder has, from which it derives the project's name in the sandbox.
pub(crate) fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_string())
}

/// The workspace, at the sandbox a project already has, looking at the project: the folder is the scope the workspace
/// opens on (the web's router/sandboxArrival.ts reads `project`), so the reader lands in the folder they asked about
/// rather than in the `/work` around it, where a project's sandbox keeps its own state. The owner's first project
/// opened on that `/work`, which read as "a sandbox in the parent of the folder I was viewing" (2026-10-05).
fn show_project(app: &AppHandle, project: &Project) {
    match &project.sandbox_id {
        Some(id) => crate::windows::show_workspace_at(app, Some(&project_path(id, &project.dir))),
        None => crate::windows::show_workspace(app),
    }
}

/// The workspace's address for a project's sandbox: the sandbox, and its folder to open on.
pub fn project_path(sandbox_id: &str, dir: &str) -> String {
    format!(
        "/?sandbox={}&project={}",
        urlencode(sandbox_id),
        urlencode(dir)
    )
}

/// Whether `rows` (`ic sandbox list --json`, the contract's `DeviceSandbox`) have `slug` here and stopped. A sandbox
/// this machine does not list is not this app's to start, and one whose state it cannot read is left as it is.
fn stopped_in(rows: &[serde_json::Value], slug: &str) -> bool {
    rows.iter()
        .any(|row| row["slug"].as_str() == Some(slug) && row["running"].as_bool() == Some(false))
}

/// The project's sandbox, started first when this machine has it stopped: a stopped sandbox is a workspace that
/// never answers, and the workspace has no way to start one. Off the calling thread, since a start can take a
/// minute (one with a shape saved for its next restart is recreated with it, `ic sandbox start`).
fn open_existing(app: &AppHandle, project: &Project) {
    let Some(slug) = project.slug.clone() else {
        show_project(app, project);
        return;
    };
    let app = app.clone();
    let project = project.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let version = crate::commands::VERSION;
        let host = crate::scripts::Host::current();
        let listed = crate::scripts::ic_listing(&app, crate::commands::list_script(host, version));
        if listed.is_ok_and(|rows| stopped_in(&rows, &slug)) {
            let started = crate::commands::power_script(&slug, "start", host, version)
                .and_then(|run| crate::scripts::run(&app, &format!("power:{slug}"), run));
            if let Err(error) = started {
                eprintln!("could not start {slug}: {error}");
            }
        }
        show_project(&app, &project);
    });
}

fn urlencode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// The project `root` is, if it is one of this machine's, live or not.
pub(crate) fn project_of(app: &AppHandle, root: &Path) -> Option<Project> {
    app.state::<AppState>()
        .projects()
        .into_iter()
        .find(|project| Path::new(&project.path) == root)
}

/// Whether a remembered project's sandbox is still the account's, as the workspace last listed them: one whose sandbox
/// was removed is a folder with none, asked about again rather than opened onto nothing. The owner's first project was
/// remembered against a machine of ours removed a minute later, and its folder's button kept opening that (2026-10-05).
/// Undecided (no account known, a record with no sandbox id) reads as live.
pub(crate) fn is_live(roster: &Roster, project: &Project) -> bool {
    match (&roster.account, &project.sandbox_id) {
        (Some(_), Some(id)) => roster.sandboxes.iter().any(|entry| &entry.id == id),
        _ => true,
    }
}

/// The project `root` is, while its sandbox is still there.
fn live_project_of(app: &AppHandle, root: &Path) -> Option<Project> {
    let roster = app.state::<AppState>().roster();
    project_of(app, root).filter(|project| is_live(&roster, project))
}

/// Whether the folder at `root` has a sandbox of its own to open: what a window on it is told (local.rs `face_of`).
pub fn has_live_project(app: &AppHandle, root: &Path) -> bool {
    live_project_of(app, root).is_some()
}

/// Why `root` cannot become a project on this machine, against the projects it still has and the user's home.
fn refusal_here(app: &AppHandle, root: &Path) -> Option<Refusal> {
    let roster = app.state::<AppState>().roster();
    let taken: Vec<PathBuf> = app
        .state::<AppState>()
        .projects()
        .iter()
        .filter(|project| is_live(&roster, project))
        .map(|project| PathBuf::from(&project.path))
        .collect();
    let home = app.path().home_dir().ok();
    refusal(root, home.as_deref(), &taken)
}

/// A refusal in a native dialog: only where the app asked in one of its own (a folder picked in the system's dialog for
/// a hosted sandbox's project). A folder's window says it in its own dialog.
fn refuse(app: &AppHandle, root: &Path, why: &Refusal) {
    app.dialog()
        .message(why.sentence(root))
        .title("This folder can't have a sandbox")
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}

/// "Work on this with an agent" asked by link (`intentic://local?do=sandbox`, the window's "Open this folder's
/// sandbox"): the sandbox the folder already has, opened. A folder with none is its window's to ask about, in its own
/// dialog, which the page is told to open (`intentic:project-ask`): the question used to be a native box, which said
/// too much in the system's own look, and then took the reader to a page of the workspace to wait on (2026-10-05).
pub fn start(app: &AppHandle, label: &str, root: PathBuf) {
    if let Some(project) = live_project_of(app, &root) {
        open_existing(app, &project);
        return;
    }
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.eval(ASK_EVENT);
    }
}

/// What the page hears when its folder's dialog is asked for by the app rather than by its own button.
const ASK_EVENT: &str = "window.dispatchEvent(new CustomEvent('intentic:project-ask'));";

/// A setup link for a project, bound to the folder this app parked for it: the one place a project's folder
/// enters a setup through a link. A project link with nothing parked is an ordinary setup with nothing synced.
pub fn bind(app: &AppHandle, mut args: SetupArgs) -> SetupArgs {
    if args.project.is_none() {
        return args;
    }
    match app
        .state::<AppState>()
        .pending_project
        .lock()
        .unwrap()
        .take()
    {
        Some(folder) => args.sync_dir = Some(folder.display().to_string()),
        None => args.project = None,
    }
    args
}

/// A project's setup finished: the folder has its sandbox, opening it again reaches that one, and every window on the
/// folder hears so (its button becomes the way to the sandbox, its bring-back appears).
pub fn remember(app: &AppHandle, args: &SetupArgs, slug: Option<String>) {
    let (Some(dir), Some(folder)) = (args.project.clone(), args.sync_dir.clone()) else {
        return;
    };
    app.state::<AppState>().remember_project(Project {
        path: folder.clone(),
        dir,
        sandbox_id: args.sandbox_id.clone(),
        slug,
    });
    crate::local::mark_sandbox(app, Path::new(&folder));
}

/* THE FOLDER'S OWN DIALOG — what it draws, and the sandbox it makes (the web's local/LocalProjectDialog.vue). */

/// What the folder's dialog draws when "Work on this with an agent" is pressed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Preview {
    /// The folder has its sandbox already: the press opens it.
    Existing,
    /// A document opened on its own: a sandbox works on a whole folder, which this window does not show.
    Document,
    /// The folder cannot have a sandbox, and why.
    Refused { refusal: Refusal },
    /// It can go into this computer's sandbox.
    #[serde(rename_all = "camelCase")]
    New {
        /// The folder's own name, which the sandbox is called after.
        name: String,
        /// Where the folder is, as the reader knows it.
        path: String,
        /// What the first copy carries, counted as the sync counts it, up to [`COUNT_LIMIT`] files.
        files: u64,
        bytes: u64,
        /// The count stopped short: there are more than `files`.
        more: bool,
        /// Enough that the first copy is a long upload.
        large: bool,
        cautions: Vec<Caution>,
        /// How far this computer's own sandbox is, which the folder goes into (machine_sandbox.rs): the dialog says
        /// whether the copy starts now or once it is ready.
        machine: crate::machine_sandbox::Standing,
    },
}

/// What the folder's dialog asks for when its button is pressed: the folder's name inside `/work`, which the page
/// derived from the folder's own (sandbox-contract's `projectDirNameFor`) and which is held to its rule here and made
/// unique among the folders already in this computer's sandbox. Never a folder: that is always the window's own.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachAsk {
    pub project: String,
}

/// What came of the press. It never waits on the sandbox: the window's card and button follow the folder from here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Attached {
    /// In line for this computer's sandbox under `name`: attached as soon as it is ready, at once when it is.
    Queued { name: String },
    /// The folder had its sandbox by the time the press arrived, and it was opened.
    Opened,
}

/// A sandbox's name as the platform takes one (`sandbox.create`: one to sixty characters), and nothing a line can't hold.
pub(crate) fn is_sandbox_name(name: &str) -> bool {
    (1..=60).contains(&name.chars().count())
        && !name.trim().is_empty()
        && !name.chars().any(char::is_control)
}

const DOCUMENT: &str = "A sandbox works on a whole folder. Open the folder this document is in, then ask again from there.";

/// What the folder's dialog draws: the sandbox the folder has, why it cannot have one, or what going into this
/// computer's sandbox involves.
#[tauri::command]
pub async fn project_preview(app: AppHandle, window: WebviewWindow) -> Result<Preview, String> {
    let Some(root) = crate::local::folder_of(&app, window.label()) else {
        return Ok(Preview::Document);
    };
    if live_project_of(&app, &root).is_some() {
        return Ok(Preview::Existing);
    }
    if let Some(refusal) = refusal_here(&app, &root) {
        return Ok(Preview::Refused { refusal });
    }
    // Off the calling thread: a large folder's count takes its time.
    let counted = root.clone();
    let (files, bytes) = tauri::async_runtime::spawn_blocking(move || weigh(&counted))
        .await
        .map_err(|error| error.to_string())?;
    Ok(Preview::New {
        name: folder_name(&root),
        path: root.display().to_string(),
        files,
        bytes,
        more: files >= COUNT_LIMIT,
        large: files >= MANY_FILES || bytes >= MANY_BYTES,
        cautions: cautions(&root),
        machine: crate::machine_sandbox::status(&app).standing,
    })
}

/// "Work on this with an agent" in the folder's dialog: the folder put in line for this computer's sandbox, and the
/// supervisor told. Answered at once, whatever the sandbox is doing: nobody signed in, no Docker, a sandbox still going
/// up all leave the folder waiting, and the window's card says what it waits for (2026-10-05).
#[tauri::command]
pub async fn project_attach(
    app: AppHandle,
    window: WebviewWindow,
    ask: AttachAsk,
) -> Result<Attached, String> {
    let Some(root) = crate::local::folder_of(&app, window.label()) else {
        return Err(DOCUMENT.to_string());
    };
    if let Some(project) = live_project_of(&app, &root) {
        open_existing(&app, &project);
        return Ok(Attached::Opened);
    }
    // Remembered against a sandbox that is gone: its folder goes into this computer's, once the old one lets go of it.
    let stale = project_of(&app, &root).is_some();
    if let Some(why) = refusal_here(&app, &root) {
        return Err(why.sentence(&root));
    }
    if !is_project_dir_name(&ask.project) {
        return Err(format!(
            "{} can't be used to name a folder in a sandbox. Rename the folder and try again.",
            folder_name(&root)
        ));
    }
    if stale {
        let folder = root.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || release_folder(&folder)).await;
    }
    attach_at_path(&app, &root, &ask.project)
}

/// A folder put in line for this computer's sandbox by path alone (first_task.rs): the same queueing as
/// [`project_attach`], without a window's folder.
pub fn attach_at_path(app: &AppHandle, root: &Path, project: &str) -> Result<Attached, String> {
    if let Some(existing) = live_project_of(app, root) {
        open_existing(app, &existing);
        return Ok(Attached::Opened);
    }
    let stale = project_of(app, root).is_some();
    if let Some(why) = refusal_here(app, root) {
        return Err(why.sentence(root));
    }
    if !is_project_dir_name(project) {
        return Err(format!(
            "{} can't be used to name a folder in a sandbox. Rename the folder and try again.",
            folder_name(root)
        ));
    }
    if stale {
        release_folder(root);
    }
    let name = crate::machine_sandbox::queue(app, root, project);
    Ok(Attached::Queued { name })
}

/// Why a folder cannot be the first task's project, in the reader's words.
pub fn refusal_for_first_task(app: &AppHandle, root: &Path) -> Option<String> {
    refusal_here(app, root).map(|why| why.sentence(root))
}

/// The account's sandboxes with one just made added, as the workspace's switcher would list it: where it runs is this
/// computer's own (`own`, placement.ts), until the workspace says better.
pub(crate) fn with_row(mut roster: Roster, id: &str, name: &str) -> Roster {
    if !roster.sandboxes.iter().any(|entry| entry.id == id) {
        roster.sandboxes.push(RosterEntry {
            id: id.to_string(),
            name: name.to_string(),
            place: "own".to_string(),
            shared: false,
        });
    }
    roster
}

/// The machine agent's pairings syncing the folder at `folder` (`intentic-machine status --json`, `sync.pairings`): the
/// same folder, spelled as the platform compares one (case folded, either slash, on Windows).
fn pairings_on(status: &serde_json::Value, folder: &Path, windows: bool) -> Vec<String> {
    pairings_of(status, folder, windows)
        .into_iter()
        .filter_map(|pairing| pairing["sandboxId"].as_str().map(str::to_string))
        .collect()
}

/// One folder path, spelled as the platform compares them (case folded, either slash, on Windows; verbatim prefix
/// stripped when present).
pub(crate) fn folder_path_key(path: &Path, windows: bool) -> String {
    let plain = crate::local::plain(path.canonicalize().unwrap_or_else(|_| path.to_path_buf()));
    let trimmed = plain
        .display()
        .to_string()
        .trim_end_matches(['/', '\\'])
        .to_string();
    if windows {
        trimmed.replace('/', "\\").to_lowercase()
    } else {
        trimmed
    }
}

/// Whether two folder paths name the same folder on disk.
pub(crate) fn folder_paths_same(a: &Path, b: &Path, windows: bool) -> bool {
    folder_path_key(a, windows) == folder_path_key(b, windows)
}

/// The machine agent's pairings (`intentic-machine status --json`, `sync.pairings`) whose folder is `folder`, spelled
/// as the platform compares one (case folded, either slash, on Windows): what a folder's first copy into this
/// computer's sandbox is followed by too (machine_sandbox.rs).
pub(crate) fn pairings_of<'a>(
    status: &'a serde_json::Value,
    folder: &Path,
    windows: bool,
) -> Vec<&'a serde_json::Value> {
    let wanted = folder_path_key(folder, windows);
    status["sync"]["pairings"]
        .as_array()
        .map(|pairings| {
            pairings
                .iter()
                .filter(|pairing| {
                    pairing["localDir"]
                        .as_str()
                        .is_some_and(|dir| folder_path_key(Path::new(dir), windows) == wanted)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A folder whose sandbox was removed, let go by this machine's sync: the agent keeps one sync per folder, so the dead
/// sandbox's pairing would turn the new one's away and leave its copy of the folder empty. Best effort: a folder this
/// fails for is said by the setup's own folder-sync step, as before.
pub(crate) fn release_folder(folder: &Path) {
    let status = match crate::scripts::sync_report() {
        Ok(Some(report)) => serde_json::from_str::<serde_json::Value>(&report).unwrap_or_default(),
        Ok(None) => return,
        Err(error) => {
            eprintln!("intentic: {error}");
            return;
        }
    };
    for sandbox in pairings_on(&status, folder, cfg!(windows)) {
        match crate::scripts::agent_unpair(&sandbox) {
            Ok(said) => eprintln!(
                "intentic: {} let go of {}: {said}",
                sandbox,
                folder.display()
            ),
            Err(error) => eprintln!(
                "intentic: {sandbox} could not let go of {}: {error}",
                folder.display()
            ),
        }
    }
}

/* WHEN A SANDBOX IS GONE, its folders' records and this machine's sync of it go too (2026-10-05).
 *
 * Neither went before. A sandbox removed from This device lost only its display name (commands.rs `sandbox_remove`),
 * the machine agent kept syncing its folder until a NEW sandbox was made for that same folder (`release_folder`), and
 * `projects.json` kept every folder's entry for good. Now the agent is told to let go whenever a sandbox goes: removed
 * here, or dropped from the account's own listing (the workspace's roster, read from the platform, for the same
 * account as before). A folder's entry goes once the account no longer lists its sandbox. The account listing a sandbox
 * no more is the platform's record of it, not an absence guessed here; a roster with nobody signed in decides nothing. */

/// The projects whose sandbox the account no longer lists, read off a roster that names who is signed in. Never the
/// sandbox this computer's own supervisor keeps (`kept`, machine_sandbox.rs), which says for itself when that one is
/// gone, nor an entry with no sandbox id. Pure.
pub(crate) fn stale_projects(
    projects: &[Project],
    roster: &Roster,
    kept: Option<&str>,
) -> Vec<Project> {
    if roster.account.is_none() {
        return Vec::new();
    }
    projects
        .iter()
        .filter(|project| {
            project.sandbox_id.as_deref().is_some_and(|id| {
                Some(id) != kept && !roster.sandboxes.iter().any(|entry| entry.id == id)
            })
        })
        .cloned()
        .collect()
}

/// The sandboxes the account listed before and lists no more, when both listings are the same account's: a sign-out or
/// another account signing in is not a sandbox going. Pure.
pub(crate) fn dropped_sandboxes(before: &Roster, after: &Roster) -> Vec<String> {
    let same_account = match (&before.account, &after.account) {
        (Some(before), Some(after)) => before.email == after.email,
        _ => false,
    };
    if !same_account {
        return Vec::new();
    }
    before
        .sandboxes
        .iter()
        .filter(|entry| !after.sandboxes.iter().any(|now| now.id == entry.id))
        .map(|entry| entry.id.clone())
        .collect()
}

/// The platform id of the sandbox whose container is `slug` here, as this app remembers it: a folder's project, or this
/// computer's own sandbox.
pub(crate) fn sandbox_id_of_slug(app: &AppHandle, slug: &str) -> Option<String> {
    app.state::<AppState>()
        .projects()
        .into_iter()
        .find(|project| project.slug.as_deref() == Some(slug))
        .and_then(|project| project.sandbox_id)
        .or_else(|| {
            let record = crate::machine_sandbox::status(app);
            record
                .slug
                .as_deref()
                .filter(|held| *held == slug)
                .and(record.sandbox_id)
        })
}

/// The slug of the sandbox with platform id `id` here, as this app remembers it.
fn slug_of_sandbox(app: &AppHandle, id: &str) -> Option<String> {
    app.state::<AppState>()
        .projects()
        .into_iter()
        .find(|project| project.sandbox_id.as_deref() == Some(id))
        .and_then(|project| project.slug)
        .or_else(|| {
            let record = crate::machine_sandbox::status(app);
            record
                .sandbox_id
                .as_deref()
                .filter(|held| *held == id)
                .and(record.slug)
        })
}

/// This machine's sync lets go of a sandbox that is gone (scripts.rs `agent_forget`). Best effort, and said in the log:
/// a sync the agent still holds is retried by the agent itself, and costs nothing here.
pub(crate) fn forget_sandbox(slug: Option<&str>, sandbox_id: Option<&str>) {
    let named = slug.or(sandbox_id).unwrap_or("a sandbox");
    match crate::scripts::agent_forget(slug, sandbox_id) {
        Ok(said) => eprintln!("intentic: this machine let go of {named}: {said}"),
        Err(error) => eprintln!("intentic: this machine did not let go of {named}: {error}"),
    }
}

/// The sandboxes this machine's agent syncs (`intentic-machine status --json`, `sync.pairings`): only those are told
/// to let go, since the account's other sandboxes (hosted, shared) were never synced here. None when the agent could
/// not be read.
fn paired_sandboxes() -> Option<HashSet<String>> {
    let report = crate::scripts::sync_report().ok()??;
    let status: serde_json::Value = serde_json::from_str(&report).ok()?;
    Some(
        status["sync"]["pairings"]
            .as_array()
            .map(|pairings| {
                pairings
                    .iter()
                    .filter_map(|pairing| pairing["sandboxId"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// The workspace said again which sandboxes the account has (windows.rs, `intentic://roster`): folders whose sandbox
/// is no longer listed are forgotten, and this machine's sync lets go of every sandbox that went. Off the calling
/// thread, since the agent is asked.
pub fn roster_changed(app: &AppHandle, before: Roster, after: Roster) {
    if after.account.is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let kept = crate::machine_sandbox::kept_sandbox_id(&app);
        let stale = stale_projects(&app.state::<AppState>().projects(), &after, kept.as_deref());
        let forgotten = app
            .state::<AppState>()
            .forget_projects(|project| stale.contains(project));
        let mut gone: Vec<(Option<String>, String)> = forgotten
            .into_iter()
            .filter_map(|project| Some((project.slug, project.sandbox_id?)))
            .collect();
        for id in dropped_sandboxes(&before, &after) {
            if Some(&id) != kept.as_ref() && !gone.iter().any(|(_, held)| *held == id) {
                gone.push((slug_of_sandbox(&app, &id), id));
            }
        }
        if gone.is_empty() {
            return;
        }
        let Some(paired) = paired_sandboxes() else {
            return;
        };
        for (slug, id) in gone.iter().filter(|(_, id)| paired.contains(id)) {
            forget_sandbox(slug.as_deref(), Some(id));
        }
    });
}

/// What `sandbox/create` came back with.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Made {
    Row(String),
    SignedOut,
    Refused(String),
}

pub(crate) fn made_row(answered: Answered) -> Made {
    match answered {
        Answered::SignedOut => Made::SignedOut,
        Answered::Json { status, body } if (200..300).contains(&status) => {
            match body["id"].as_str().filter(|id| crate::setup_link::is_sandbox_id(id)) {
                Some(id) => Made::Row(id.to_string()),
                None => Made::Refused(
                    "The platform's answer didn't name the new sandbox. Updating Intentic may fix this.".to_string(),
                ),
            }
        }
        Answered::Json { status, body } => Made::Refused(refused_by(status, &body)),
    }
}

/// What `sandbox/setup-code` came back with: the code, and the slug its address gives the container (`ic` names it
/// after the hostname's first label), so the finished setup knows its own sandbox rather than guessing the newest.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Minted {
    Code {
        code: String,
        slug: Option<String>,
        /// The sandbox's public address, which a folder attaches to (`--sandbox-url https://<hostname>`).
        hostname: Option<String>,
    },
    SignedOut,
    Refused(String),
}

/// A public hostname as the platform hands one out: labels of letters, digits and dashes, and nothing a URL could be
/// bent by.
fn is_hostname(hostname: &str) -> bool {
    (1..=253).contains(&hostname.len())
        && hostname.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

/// Ask the platform for a setup code for the row `sandbox_id`, with the workspace's session the webview of `window`
/// holds: this computer's own sandbox (machine_sandbox.rs), and a setup whose code ran out (commands.rs
/// `setup_fresh_code`). [`minted_code`] reads the answer.
pub(crate) async fn mint_code(
    app: &AppHandle,
    window: &WebviewWindow,
    sandbox_id: &str,
    profile: Option<&str>,
) -> Result<Answered, String> {
    crate::account::platform_post(
        app,
        window,
        "/rpc/sandbox/setup-code",
        &mint_ask(sandbox_id, profile),
    )
    .await
}

/// What a mint asks for: the sandbox, and the profile its setup page's reader arrived with when there was one (the
/// web's own mint sends it the same way, useCommandLane.ts). Pure.
pub(crate) fn mint_ask(sandbox_id: &str, profile: Option<&str>) -> serde_json::Value {
    match profile {
        Some(profile) => serde_json::json!({ "sandboxId": sandbox_id, "profile": profile }),
        None => serde_json::json!({ "sandboxId": sandbox_id }),
    }
}

pub(crate) fn minted_code(answered: Answered) -> Minted {
    match answered {
        Answered::SignedOut => Minted::SignedOut,
        Answered::Json { status, body } if (200..300).contains(&status) => {
            let hostname = body["hostname"]
                .as_str()
                .filter(|hostname| is_hostname(hostname))
                .map(str::to_string);
            let slug = hostname
                .as_deref()
                .and_then(|hostname| hostname.split('.').next())
                .filter(|slug| crate::setup_link::is_slug(slug))
                .map(str::to_string);
            match body["code"].as_str().filter(|code| !code.is_empty()) {
                Some(code) => Minted::Code {
                    code: code.to_string(),
                    slug,
                    hostname,
                },
                None => Minted::Refused(
                    "The platform's answer carried no setup code. Updating Intentic may fix this."
                        .to_string(),
                ),
            }
        }
        Answered::Json { status, body } => Minted::Refused(refused_by(status, &body)),
    }
}

/// The platform's own reason for a refusal, as its errors say it (`message`), or its status where it gave none.
fn refused_by(status: u16, body: &serde_json::Value) -> String {
    match body["message"]
        .as_str()
        .map(str::trim)
        .filter(|said| !said.is_empty())
    {
        Some(said) => format!("The platform couldn't make the sandbox: {said}"),
        None => format!(
            "The platform couldn't make the sandbox (it answered {status}). Try again in a moment."
        ),
    }
}

/* WHAT A PROJECT'S WINDOW ASKS OF ITS SYNC — each one run of the machine agent, answered into that window. */

/// One run of `intentic-machine` for a project verb: what the window called it, what its answer is called, the
/// arguments, and how long it may take (a bring-back copies a whole folder's worth of changes back).
#[derive(Debug, PartialEq, Eq)]
struct AgentRun {
    verb: &'static str,
    kind: &'static str,
    args: Vec<String>,
    limit: Duration,
}

/// The name a project verb goes by on the window's side, for the verbs this module runs; none for any other.
fn project_verb(verb: &LocalVerb) -> Option<&'static str> {
    match verb {
        LocalVerb::Changes => Some("changes"),
        LocalVerb::BringBack(_) => Some("bring-back"),
        LocalVerb::Restore(_) => Some("restore"),
        LocalVerb::Direction(_) => Some("direction"),
        _ => None,
    }
}

/// The machine agent's command for `verb` on the project at `root` (the commands `_devices/machine` names). A
/// bring-back of chosen paths names them in `paths_file` (`--paths-file`, a JSON array of the root-relative paths),
/// never on the command line: Windows caps a command line at 32,767 characters, which a few hundred paths reach.
/// Chosen paths with no file to name them in are no run at all, rather than a bring-back of everything.
fn agent_run(verb: &LocalVerb, root: &Path, paths_file: Option<&Path>) -> Option<AgentRun> {
    let dir = root.display().to_string();
    let base = |command: &str| -> Vec<String> {
        vec!["sync".into(), command.into(), "--dir".into(), dir.clone()]
    };
    let (verb, kind, mut args, seconds) = match verb {
        LocalVerb::Changes => ("changes", "changes", base("changes"), 90),
        LocalVerb::BringBack(paths) => {
            let mut args = base("bring-back");
            if paths.is_some() {
                args.push("--paths-file".into());
                args.push(paths_file?.display().to_string());
            }
            ("bring-back", "brought-back", args, 600)
        }
        LocalVerb::Restore(point) => {
            let mut args = base("restore");
            args.push("--point".into());
            args.push(point.clone());
            ("restore", "restored", args, 120)
        }
        LocalVerb::Direction(value) => {
            let mut args = base("direction");
            args.push(value.clone());
            ("direction", "direction", args, 60)
        }
        _ => return None,
    };
    args.push("--json".into());
    Some(AgentRun {
        verb,
        kind,
        args,
        limit: Duration::from_secs(seconds),
    })
}

/// The chosen paths of a bring-back, written where `--paths-file` reads them: a JSON array of root-relative paths,
/// in a file of its own under `dir`, named so no two runs meet.
fn write_paths(dir: &Path, paths: &[String]) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let file = dir.join(format!("bring-back-{}.json", uuid::Uuid::new_v4().simple()));
    std::fs::write(&file, serde_json::to_vec(paths)?)?;
    Ok(file)
}

/// How old a bring-back's paths file is before a launch sweeps it: no run lasts a day, so one that old belongs to a run a
/// crash ended, whose own removal ([`PathsFile`]'s drop) never ran.
const PATHS_FILE_STALE: Duration = Duration::from_secs(24 * 60 * 60);

/// The paths files among `files` (name and when it was last written) older than `stale` at `now`: only this module's own
/// (`bring-back-<id>.json`), and never one dated in the future, which is a clock that moved rather than an old file.
/// Pure.
pub(crate) fn stale_paths_files(
    files: &[(PathBuf, std::time::SystemTime)],
    now: std::time::SystemTime,
    stale: Duration,
) -> Vec<PathBuf> {
    files
        .iter()
        .filter(|(path, _)| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("bring-back-") && name.ends_with(".json"))
        })
        .filter(|(_, written)| now.duration_since(*written).is_ok_and(|age| age > stale))
        .map(|(path, _)| path.clone())
        .collect()
}

/// The paths files a crash left in the app's cache folder, swept at launch (lib.rs, 2026-10-05): only a run that ended
/// removed its own, so every crash mid bring-back left one behind for good, naming the reader's files.
pub fn sweep_paths_files(app: &AppHandle) {
    let Ok(dir) = app.path().app_cache_dir().map(|dir| dir.join("bring-back")) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let files: Vec<(PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|entry| Some((entry.path(), entry.metadata().ok()?.modified().ok()?)))
        .collect();
    for path in stale_paths_files(&files, std::time::SystemTime::now(), PATHS_FILE_STALE) {
        let _ = std::fs::remove_file(path);
    }
}

/// A bring-back's paths file, in the app's own cache folder, removed however the run ends.
struct PathsFile(PathBuf);

impl PathsFile {
    fn write(app: &AppHandle, paths: &[String]) -> Result<PathsFile, String> {
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("no cache folder for this app: {error}"))?
            .join("bring-back");
        write_paths(&dir, paths)
            .map(PathsFile)
            .map_err(|error| format!("the paths could not be written: {error}"))
    }
}

impl Drop for PathsFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Folders a changing run is under way for right now.
static WORKING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Mutex::default);

/// Whether a bring-back, a restore or a direction change is under way: what an update waits for, like a script run
/// (update.rs `refusal`), since a restart in the middle would leave the window that asked with no answer.
pub fn busy() -> bool {
    WORKING.lock().map(|held| !held.is_empty()).unwrap_or(true)
}

/// A folder's claim on its one changing run at a time, given back however the run ends.
struct Working(PathBuf);

impl Working {
    fn claim(root: &Path) -> Option<Working> {
        WORKING
            .lock()
            .unwrap()
            .insert(root.to_path_buf())
            .then(|| Working(root.to_path_buf()))
    }
}

impl Drop for Working {
    fn drop(&mut self) {
        if let Ok(mut working) = WORKING.lock() {
            working.remove(&self.0);
        }
    }
}

/// A project verb from the window showing `root` (local.rs): only for a folder that IS a project of this machine's
/// (`projects.json`), run off the main thread, and answered into that window as `intentic:project` whatever
/// happens, so the page is never left waiting on a button it pressed.
pub fn work(app: &AppHandle, label: &str, root: &Path, verb: &LocalVerb) {
    let Some(name) = project_verb(verb) else {
        return;
    };
    let is_project = app
        .state::<AppState>()
        .projects()
        .iter()
        .any(|project| Path::new(&project.path) == root);
    if !is_project {
        eprintln!(
            "{label} asked to {name} {}, which has no sandbox of its own",
            root.display()
        );
        return;
    }
    let refused =
        |error: &str| serde_json::json!({ "kind": "error", "verb": name, "error": error });
    let claim = match name {
        "changes" => None,
        _ => match Working::claim(root) {
            Some(claim) => Some(claim),
            None => {
                tell(
                    app,
                    label,
                    &refused("Intentic is still working on this folder's last request. Try again when it's done."),
                );
                return;
            }
        },
    };
    let paths = match verb {
        LocalVerb::BringBack(Some(paths)) => match PathsFile::write(app, paths) {
            Ok(file) => Some(file),
            Err(error) => {
                eprintln!("{label} asked to bring back {} paths: {error}", paths.len());
                tell(
                    app,
                    label,
                    &refused("Intentic couldn't hand the machine agent the files to bring back. Try again."),
                );
                return;
            }
        },
        _ => None,
    };
    let Some(run) = agent_run(verb, root, paths.as_ref().map(|file| file.0.as_path())) else {
        return;
    };
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let answer = crate::scripts::agent_json(&run.args, run.limit);
        // Given back before the window hears, so a request it makes on hearing is not turned away.
        drop(paths);
        drop(claim);
        tell(&app, &label, &project_detail(&run, answer));
    });
}

/// What the window is told: the agent's own object as `result`, or why there is none as a sentence.
fn project_detail(
    run: &AgentRun,
    answer: Result<serde_json::Value, AgentSilence>,
) -> serde_json::Value {
    match answer {
        Ok(result) => serde_json::json!({ "kind": run.kind, "result": result }),
        Err(silence) => {
            eprintln!("intentic-machine {}: {silence:?}", run.args.join(" "));
            serde_json::json!({ "kind": "error", "verb": run.verb, "error": said(&silence) })
        }
    }
}

/// Why the agent gave no answer, in the words the window shows. An agent that is there and would not start says
/// why, rather than being called missing.
pub(crate) fn said(silence: &AgentSilence) -> String {
    match silence {
        AgentSilence::Missing => "Intentic's machine agent isn't on this computer, so this folder's sandbox can't be reached from here. Setting the sandbox up again installs it.".to_string(),
        AgentSilence::WouldNotStart(reason) => format!("The machine agent on this computer wouldn't start ({reason})."),
        AgentSilence::TimedOut(_) => "The machine agent didn't answer in time. Try again in a moment.".to_string(),
        AgentSilence::Unreadable(_) => "The machine agent's answer couldn't be read. Updating Intentic may fix this.".to_string(),
    }
}

/// `intentic:project` into the window `label`, one event carrying `detail`.
fn tell(app: &AppHandle, label: &str, detail: &serde_json::Value) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.eval(project_event(detail));
    }
}

/// The event as the page receives it: JSON is a JavaScript literal, and serde escapes what the agent said.
fn project_event(detail: &serde_json::Value) -> String {
    format!("window.dispatchEvent(new CustomEvent('intentic:project', {{ detail: {detail} }}));")
}

/* A HOSTED SANDBOX'S PROJECT — `intentic://sync?…&project=<name>`, the desktop half of a folder whose sandbox is not
 * on this machine. */

/// The workspace enrolled the parked folder with a hosted sandbox's `/work/<name>`: run the sync script on it here,
/// with no screen of the app's in between, and remember the project once it runs. Nothing parked (the question was
/// asked before a restart of this app) is a folder asked for in a system dialog, and held to the same refusals the
/// window's own question is.
pub fn sync_project(app: &AppHandle, args: SyncArgs) {
    let Some(name) = args.project.clone() else {
        return;
    };
    let parked = app
        .state::<AppState>()
        .pending_project
        .lock()
        .unwrap()
        .take();
    if let Some(folder) = parked {
        run_project_sync(app, args, folder);
        return;
    }
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title(format!("Choose the folder to work on as {name}"))
        .pick_folder(move |picked| {
            let Some(picked) = picked.and_then(|picked| picked.into_path().ok()) else {
                return;
            };
            let folder = match std::fs::canonicalize(&picked) {
                Ok(folder) => crate::local::plain(folder),
                Err(error) => {
                    eprintln!("{} cannot be read: {error}", picked.display());
                    return;
                }
            };
            if let Some(why) = refusal_here(&handle, &folder) {
                refuse(&handle, &folder, &why);
                return;
            }
            run_project_sync(&handle, args, folder);
        });
}

/// The sync script for `folder` as the project `args` names, off the main thread; on success the project is
/// remembered with its sandbox, so the folder's window reaches it from then on. A failure is said in a dialog: the
/// page that sent the link is waiting for an enrollment, and has no other way to hear this one will not come.
fn run_project_sync(app: &AppHandle, args: SyncArgs, folder: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = args.project.clone() else {
            return;
        };
        let path = folder.display().to_string();
        let run = crate::commands::sync_script(
            &args,
            Some(&path),
            crate::scripts::Host::current(),
            crate::commands::VERSION,
        );
        match crate::scripts::run(&app, &format!("project-sync:{dir}"), run) {
            Ok(()) => app.state::<AppState>().remember_project(Project {
                path,
                dir,
                sandbox_id: args.sandbox_id.clone(),
                slug: None,
            }),
            Err(error) => {
                eprintln!("the sync for {path} did not start: {error}");
                app.dialog()
                    .message(format!(
                        "Intentic couldn't start keeping {path} up to date in the sandbox ({error}). Try again from the workspace."
                    ))
                    .title("The folder isn't syncing")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    });
}

#[cfg(test)]
mod tests {
    /// A code the app mints asks for what the web's own mint asked for: the sandbox, and the profile when there is one.
    #[test]
    fn a_mint_asks_for_the_profile_its_setup_came_with() {
        assert_eq!(
            mint_ask("sbx_7", None),
            serde_json::json!({ "sandboxId": "sbx_7" })
        );
        assert_eq!(
            mint_ask("sbx_7", Some("desk")),
            serde_json::json!({ "sandboxId": "sbx_7", "profile": "desk" })
        );
    }

    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct NameCase {
        name: String,
        valid: bool,
    }

    #[derive(Deserialize)]
    struct NameCases {
        names: Vec<NameCase>,
    }

    #[derive(Deserialize)]
    struct Ignores {
        ignores: Vec<String>,
    }

    #[test]
    fn the_shared_name_cases_validate_as_the_contract_validates_them() {
        let cases: NameCases = serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-contract/src/ids/project-dir.fixture.json"
        ))
        .unwrap();
        assert!(cases.names.len() > 10);
        for case in cases.names {
            assert_eq!(
                is_project_dir_name(&case.name),
                case.valid,
                "name {:?}",
                case.name
            );
        }
    }

    /// What the dialog counts without is what the machine agent's sync leaves behind, entry for entry.
    #[test]
    fn the_count_leaves_out_exactly_what_a_project_folder_s_sync_ignores() {
        let fixture: Ignores = serde_json::from_str(include_str!(
            "../../../../_devices/machine/src/sync/project-ignores.fixture.json"
        ))
        .unwrap();
        assert_eq!(NOT_SYNCED.to_vec(), fixture.ignores);
    }

    #[test]
    fn a_pattern_s_star_stands_for_any_run_of_characters_and_nothing_else_does() {
        assert!(not_synced(".env.production.local"));
        assert!(not_synced(".env..local"));
        assert!(not_synced(".env.local"));
        assert!(not_synced(".astro"));
        assert!(!not_synced(".env.production"));
        assert!(!not_synced(".env.example"));
        assert!(!not_synced("my.env.local"));
        assert!(!not_synced("dist-old"));
        assert!(!not_synced("src"));
    }

    #[test]
    fn a_repository_s_machine_local_intentic_folders_stay_here_at_any_depth() {
        assert!(not_synced(".intentic/cache"));
        assert!(not_synced("intentic/.intentic/local"));
        assert!(!not_synced(".intentic"));
        assert!(!not_synced(".intentic/checks.json"));
        assert!(!not_synced("x.intentic/cache"));
        assert!(not_synced("web/node_modules"));
    }

    #[test]
    fn a_project_name_is_a_plain_folder_name() {
        assert!(is_project_dir_name("my-app"));
        assert!(is_project_dir_name("App_2.0"));
        assert!(!is_project_dir_name(".intentic"));
        assert!(!is_project_dir_name("-x"));
        assert!(!is_project_dir_name("a/b"));
        assert!(!is_project_dir_name("../etc"));
        assert!(!is_project_dir_name(""));
        assert!(!is_project_dir_name(&"a".repeat(65)));
    }

    #[cfg(not(windows))]
    #[test]
    fn a_disk_a_home_folder_or_a_system_folder_is_refused() {
        let home = Path::new("/home/me");
        assert!(refusal(Path::new("/"), Some(home), &[]).is_some());
        assert!(refusal(home, Some(home), &[]).is_some());
        assert!(refusal(Path::new("/etc/nginx"), Some(home), &[]).is_some());
        assert_eq!(
            refusal(Path::new("/home/me/code/app"), Some(home), &[]),
            None
        );
    }

    /// One sandbox per folder, and never one folder synced into two sandboxes by nesting.
    #[cfg(not(windows))]
    #[test]
    fn a_folder_inside_or_around_one_that_has_a_sandbox_is_refused() {
        let taken = [PathBuf::from("/home/me/code/app")];
        assert!(refusal(Path::new("/home/me/code/app/web"), None, &taken).is_some());
        assert!(refusal(Path::new("/home/me/code"), None, &taken).is_some());
        assert_eq!(
            refusal(Path::new("/home/me/code/other"), None, &taken),
            None
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn a_folder_holding_the_home_folder_is_refused() {
        let home = Path::new("/home/me");
        assert!(refusal(Path::new("/home"), Some(home), &[]).is_some());
        assert_eq!(refusal(Path::new("/home/me/code"), Some(home), &[]), None);
    }

    /// Fedora Atomic's homes live under `/var/home`: a folder in one is the user's own, while the homes' folder and a
    /// home itself are refused as they are at `/home` — whichever of the two spellings the OS reports the home by.
    #[cfg(not(windows))]
    #[test]
    fn a_folder_in_a_fedora_atomic_home_is_the_user_s_own() {
        for home in [Path::new("/var/home/me"), Path::new("/home/me")] {
            assert_eq!(
                refusal(Path::new("/var/home/me/code/app"), Some(home), &[]),
                None,
                "home {}",
                home.display()
            );
            assert!(refusal(Path::new("/var/home/me"), Some(home), &[]).is_some());
            assert!(refusal(Path::new("/var/home"), Some(home), &[]).is_some());
            assert!(refusal(Path::new("/var/home/other"), Some(home), &[]).is_some());
        }
        // The rest of /var is still the system's, and a project's neighbours are still refused in there.
        assert!(refusal(Path::new("/var/lib/app"), None, &[]).is_some());
        let taken = [PathBuf::from("/var/home/me/code/app")];
        assert!(refusal(Path::new("/var/home/me/code/app/web"), None, &taken).is_some());
        assert!(refusal(Path::new("/var/home/me/code"), None, &taken).is_some());
    }

    /// A WSL distro's folder as Windows names it is held to the distro's own rules: its homes, a whole home in it, a
    /// mounted disk and its system's folders, whatever the Windows home is. Read off the text, so checkable anywhere.
    #[test]
    fn a_wsl_distro_s_homes_and_system_folders_are_refused_as_windows_names_them() {
        let home = Path::new(r"C:\Users\me");
        for (path, refused) in [
            (r"\\wsl.localhost\arch\home", Some(Refusal::Homes)),
            (r"\\wsl.localhost\arch\home\me", Some(Refusal::AHome)),
            (r"\\wsl$\Ubuntu\root", Some(Refusal::AHome)),
            (r"\\wsl.localhost\arch\etc", Some(Refusal::System)),
            (r"\\WSL.LOCALHOST\arch\usr\src", Some(Refusal::System)),
            (r"\\wsl.localhost\arch\mnt\c", Some(Refusal::Disk)),
            (r"\\wsl.localhost\arch\home\me\code\shop", None),
        ] {
            assert_eq!(refusal(Path::new(path), Some(home), &[]), refused, "{path}");
        }
    }

    #[test]
    fn the_system_s_folders_are_refused_on_whichever_drive_they_are() {
        assert!(windows_system(r"C:\Windows\System32"));
        assert!(windows_system(r"D:\Windows"));
        assert!(windows_system(r"e:\program files\app"));
        assert!(windows_system(r"C:\ProgramData"));
        assert!(!windows_system(r"D:\Windowsill"));
        assert!(!windows_system(r"D:\work\shop"));
        assert!(!windows_system("/usr"));
    }

    /// Every refusal is said, natively, as it always was, and drawn by the dialog by its kind.
    #[test]
    fn a_refusal_is_said_as_a_sentence_and_drawn_by_its_kind() {
        let path = Path::new("/home/me/code");
        assert_eq!(
            Refusal::Inside {
                other: "/home/me".into()
            }
            .sentence(path),
            "/home/me/code is inside /home/me, which already has a sandbox. Open that folder instead."
        );
        assert_eq!(
            Refusal::System.sentence(path),
            "/home/me/code belongs to the system. Pick a folder of your own."
        );
        assert_eq!(
            serde_json::to_value(Refusal::Around {
                other: "/home/me/code/app".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "around", "other": "/home/me/code/app" })
        );
        assert_eq!(
            serde_json::to_value(Refusal::HoldsHome).unwrap(),
            serde_json::json!({ "kind": "holdsHome" })
        );
    }

    /// What the dialog is handed, in the shape the page reads (desktop-app's src/desktop.ts `ProjectPreview`).
    #[test]
    fn the_dialog_reads_the_preview_in_its_own_shape() {
        let preview = Preview::New {
            name: "test-remove-me".into(),
            path: r"C:\Users\me\Documents\test-remove-me".into(),
            files: 3,
            bytes: 355,
            more: false,
            large: false,
            cautions: vec![Caution::Synced {
                service: "OneDrive".into(),
            }],
            machine: crate::machine_sandbox::Standing::Creating {
                phase: Some("pulling-image".into()),
                step: None,
                percent: 42,
            },
        };
        assert_eq!(
            serde_json::to_value(preview).unwrap(),
            serde_json::json!({
                "kind": "new",
                "name": "test-remove-me",
                "path": r"C:\Users\me\Documents\test-remove-me",
                "files": 3,
                "bytes": 355,
                "more": false,
                "large": false,
                "cautions": [{ "kind": "synced", "service": "OneDrive" }],
                "machine": { "state": "creating", "phase": "pulling-image", "percent": 42 },
            })
        );
        assert_eq!(
            serde_json::to_value(Preview::Refused {
                refusal: Refusal::Disk
            })
            .unwrap(),
            serde_json::json!({ "kind": "refused", "refusal": { "kind": "disk" } })
        );
        assert_eq!(
            serde_json::to_value(Preview::Existing).unwrap(),
            serde_json::json!({ "kind": "existing" })
        );
    }

    /// A project's sandbox opens on the project, never on the `/work` around it.
    #[test]
    fn a_projects_sandbox_opens_on_its_folder() {
        assert_eq!(
            project_path("cmuudvkwr001b01r822aawr1l", "test-remove-me"),
            "/?sandbox=cmuudvkwr001b01r822aawr1l&project=test-remove-me"
        );
        assert_eq!(project_path("a b", "x&y"), "/?sandbox=a+b&project=x%26y");
    }

    /// The press's two platform calls, read: a row's id, a code and the slug its address gives the container, nobody
    /// signed in, or the platform's own reason for a refusal.
    #[test]
    fn the_platforms_answers_are_read_into_a_row_and_a_code() {
        let ok = |body: serde_json::Value| Answered::Json { status: 200, body };
        assert_eq!(
            made_row(ok(
                serde_json::json!({ "id": "cmuudvkwr001b01r822aawr1l", "name": "app" })
            )),
            Made::Row("cmuudvkwr001b01r822aawr1l".into())
        );
        assert_eq!(made_row(Answered::SignedOut), Made::SignedOut);
        assert!(matches!(
            made_row(ok(serde_json::json!({ "id": "../x" }))),
            Made::Refused(_)
        ));
        assert_eq!(
            made_row(Answered::Json {
                status: 400,
                body: serde_json::json!({ "message": "Input validation failed" })
            }),
            Made::Refused("The platform couldn't make the sandbox: Input validation failed".into())
        );
        assert_eq!(
            minted_code(ok(serde_json::json!({
                "code": "c0de",
                "hostname": "sandbox-2c8eb2c5b3a5.sbx.intentic.dev",
                "expiresAt": "2026-10-05T00:00:00Z"
            }))),
            Minted::Code {
                code: "c0de".into(),
                slug: Some("sandbox-2c8eb2c5b3a5".into()),
                hostname: Some("sandbox-2c8eb2c5b3a5.sbx.intentic.dev".into())
            }
        );
        // A hostname that names no slug `ic` would use leaves the finished setup to find its container itself.
        assert_eq!(
            minted_code(ok(
                serde_json::json!({ "code": "c0de", "hostname": "-x.example" })
            )),
            Minted::Code {
                code: "c0de".into(),
                slug: None,
                hostname: Some("-x.example".into())
            }
        );
        // An address that is not a plain hostname is no address to attach a folder to.
        assert_eq!(
            minted_code(ok(
                serde_json::json!({ "code": "c0de", "hostname": "evil.example/x?y" })
            )),
            Minted::Code {
                code: "c0de".into(),
                slug: None,
                hostname: None
            }
        );
        assert!(matches!(
            minted_code(ok(serde_json::json!({ "code": "" }))),
            Minted::Refused(_)
        ));
        assert_eq!(
            minted_code(Answered::Json {
                status: 404,
                body: serde_json::Value::Null
            }),
            Minted::Refused(
                "The platform couldn't make the sandbox (it answered 404). Try again in a moment."
                    .into()
            )
        );
    }

    #[test]
    fn a_sandbox_name_is_one_the_platform_takes() {
        assert!(is_sandbox_name("test-remove-me"));
        assert!(is_sandbox_name("Café 2"));
        assert!(is_sandbox_name(&"a".repeat(60)));
        assert!(!is_sandbox_name(&"a".repeat(61)));
        assert!(!is_sandbox_name(""));
        assert!(!is_sandbox_name("   "));
        assert!(!is_sandbox_name("a\nb"));
    }

    fn roster_of(ids: &[&str], signed_in: bool) -> Roster {
        Roster {
            account: signed_in.then(|| crate::setup_link::RosterAccount {
                email: "me@example.com".into(),
                name: None,
                image: None,
            }),
            sandboxes: ids
                .iter()
                .map(|id| RosterEntry {
                    id: (*id).to_string(),
                    name: (*id).to_string(),
                    place: "own".into(),
                    shared: false,
                })
                .collect(),
        }
    }

    fn project(sandbox_id: Option<&str>) -> Project {
        Project {
            path: r"C:\Users\me\Documents\test-remove-me".into(),
            dir: "test-remove-me".into(),
            sandbox_id: sandbox_id.map(str::to_string),
            slug: None,
        }
    }

    /// A folder's entry goes once the account's own listing no longer has its sandbox; never on a roster with nobody
    /// signed in, never one with no sandbox id, and never this computer's own sandbox, whose supervisor says when it is
    /// gone.
    #[test]
    fn a_projects_entry_goes_with_the_sandbox_the_account_no_longer_lists() {
        let projects = vec![
            project(Some("cm-gone")),
            project(Some("cm-live")),
            project(None),
            project(Some("cm-machine")),
        ];
        let listed = roster_of(&["cm-live"], true);
        let stale = stale_projects(&projects, &listed, Some("cm-machine"));
        assert_eq!(stale, vec![project(Some("cm-gone"))]);
        assert!(stale_projects(&projects, &roster_of(&[], false), None).is_empty());
    }

    /// Only the same account's listing losing a sandbox says it went: a sign-out or another account says nothing.
    #[test]
    fn a_sandbox_dropped_from_the_same_accounts_listing_is_one_that_went() {
        let before = roster_of(&["cm-a", "cm-b"], true);
        assert_eq!(
            dropped_sandboxes(&before, &roster_of(&["cm-b", "cm-c"], true)),
            vec!["cm-a".to_string()]
        );
        assert!(dropped_sandboxes(&before, &roster_of(&[], false)).is_empty());
        let mut other = roster_of(&[], true);
        other.account.as_mut().unwrap().email = "someone@example.com".into();
        assert!(dropped_sandboxes(&before, &other).is_empty());
        assert!(dropped_sandboxes(&roster_of(&["cm-a"], false), &roster_of(&[], true)).is_empty());
    }

    #[test]
    fn a_launch_sweeps_only_this_modules_paths_files_older_than_a_day() {
        let now = std::time::UNIX_EPOCH + Duration::from_secs(10 * 24 * 60 * 60);
        let ago = |hours: u64| now - Duration::from_secs(hours * 60 * 60);
        let files = vec![
            (
                PathBuf::from("/cache/bring-back/bring-back-old.json"),
                ago(25),
            ),
            (
                PathBuf::from("/cache/bring-back/bring-back-new.json"),
                ago(2),
            ),
            (PathBuf::from("/cache/bring-back/notes.txt"), ago(100)),
            (
                PathBuf::from("/cache/bring-back/bring-back-ahead.json"),
                now + Duration::from_secs(60),
            ),
        ];
        assert_eq!(
            stale_paths_files(&files, now, PATHS_FILE_STALE),
            vec![PathBuf::from("/cache/bring-back/bring-back-old.json")]
        );
    }

    /// The owner's first project was remembered against a machine of ours removed a minute later: a folder whose
    /// sandbox the account no longer lists has none, and is asked about again rather than opened onto nothing.
    #[test]
    fn a_project_whose_sandbox_the_account_no_longer_lists_is_none() {
        let listed = roster_of(&["cm-horus", "cm-new"], true);
        assert!(is_live(&listed, &project(Some("cm-new"))));
        assert!(!is_live(
            &listed,
            &project(Some("cmuudvkwr001b01r822aawr1l"))
        ));
        // Nothing to judge by: no account known (signed out, or never told), or a record that kept no sandbox id.
        assert!(is_live(&roster_of(&[], false), &project(Some("cm-gone"))));
        assert!(is_live(&listed, &project(None)));
    }

    /// A row just made is listed at once, as the workspace will list it, and never twice.
    #[test]
    fn a_new_sandbox_is_listed_at_once_and_only_once() {
        let listed = with_row(roster_of(&["cm-horus"], true), "cm-new", "test-remove-me");
        assert_eq!(listed.sandboxes.len(), 2);
        assert_eq!(
            listed.sandboxes[1],
            RosterEntry {
                id: "cm-new".into(),
                name: "test-remove-me".into(),
                place: "own".into(),
                shared: false
            }
        );
        assert_eq!(
            with_row(listed.clone(), "cm-new", "again").sandboxes,
            listed.sandboxes
        );
        assert!(is_live(&listed, &project(Some("cm-new"))));
    }

    /// The pairings that sync the folder itself, and no other, as the agent reports them.
    #[test]
    fn the_folders_own_pairings_are_found_as_the_platform_compares_folders() {
        let status = serde_json::json!({
            "sync": { "pairings": [
                { "sandboxId": "sandbox-2c8eb2c5b3a5-sbx-intentic-dev", "localDir": r"C:\Users\radar\Documents\test-remove-me" },
                { "sandboxId": "sandbox-574ea8038415-sbx-intentic-dev", "localDir": r"C:\Users\radar\intentic\workspace-574ea8038415" },
                { "sandboxId": "sandbox-mirror", "mode": "mirror" }
            ] }
        });
        let folder = Path::new(r"c:\users\radar\documents\TEST-REMOVE-ME\");
        assert_eq!(
            pairings_on(&status, folder, true),
            vec!["sandbox-2c8eb2c5b3a5-sbx-intentic-dev"]
        );
        // Elsewhere names keep their case, and a folder inside another is not that folder.
        assert!(pairings_on(&status, folder, false).is_empty());
        assert!(pairings_on(&status, Path::new(r"C:\Users\radar\Documents"), true).is_empty());
        assert!(pairings_on(&serde_json::json!({}), folder, true).is_empty());
    }

    /// The app's own ask for the folder's dialog, as the page listens for it.
    #[test]
    fn the_window_is_asked_to_open_its_dialog_by_an_event() {
        assert_eq!(
            ASK_EVENT,
            "window.dispatchEvent(new CustomEvent('intentic:project-ask'));"
        );
    }

    /// Each project verb is the machine agent's own command, with the folder and only the values the link carried.
    #[test]
    fn each_project_verb_is_one_machine_agent_command() {
        let root = Path::new("/home/me/app");
        let run = |verb: LocalVerb| agent_run(&verb, root, None).unwrap();
        let changes = run(LocalVerb::Changes);
        assert_eq!(
            changes.args,
            vec!["sync", "changes", "--dir", "/home/me/app", "--json"]
        );
        assert_eq!(
            (changes.kind, changes.limit),
            ("changes", Duration::from_secs(90))
        );
        let all = run(LocalVerb::BringBack(None));
        assert_eq!(
            all.args,
            vec!["sync", "bring-back", "--dir", "/home/me/app", "--json"]
        );
        assert_eq!(
            (all.kind, all.limit),
            ("brought-back", Duration::from_secs(600))
        );
        let restore = run(LocalVerb::Restore("p-1".into()));
        assert_eq!(
            restore.args,
            vec![
                "sync",
                "restore",
                "--dir",
                "/home/me/app",
                "--point",
                "p-1",
                "--json"
            ]
        );
        assert_eq!(
            (restore.kind, restore.limit),
            ("restored", Duration::from_secs(120))
        );
        let direction = run(LocalVerb::Direction("both".into()));
        assert_eq!(
            direction.args,
            vec![
                "sync",
                "direction",
                "--dir",
                "/home/me/app",
                "both",
                "--json"
            ]
        );
        assert_eq!(
            (direction.kind, direction.limit),
            ("direction", Duration::from_secs(60))
        );
        assert_eq!(agent_run(&LocalVerb::Sandbox, root, None), None);
        assert_eq!(agent_run(&LocalVerb::Ask("a.md".into()), root, None), None);
        // Which verbs these are, by the names the window's side knows them by; only `changes` changes nothing.
        assert_eq!(project_verb(&LocalVerb::Changes), Some("changes"));
        assert_eq!(
            project_verb(&LocalVerb::BringBack(None)),
            Some("bring-back")
        );
        assert_eq!(
            project_verb(&LocalVerb::Restore("p".into())),
            Some("restore")
        );
        assert_eq!(
            project_verb(&LocalVerb::Direction("both".into())),
            Some("direction")
        );
        assert_eq!(project_verb(&LocalVerb::OpenFolder), None);
    }

    /// Chosen paths ride in a file, never on the command line (Windows caps one at 32,767 characters, which a few
    /// hundred paths pass): the command names the file, and chosen paths with no file are no run, never a bring-back
    /// of everything.
    #[test]
    fn a_bring_back_of_chosen_paths_names_them_in_a_file() {
        let root = Path::new("/home/me/app");
        let chosen = LocalVerb::BringBack(Some(vec!["a.md".into(), "src/b c.ts".into()]));
        let file = Path::new("/cache/bring-back/bring-back-1.json");
        let run = agent_run(&chosen, root, Some(file)).unwrap();
        assert_eq!(
            run.args,
            vec![
                "sync",
                "bring-back",
                "--dir",
                "/home/me/app",
                "--paths-file",
                "/cache/bring-back/bring-back-1.json",
                "--json"
            ]
        );
        assert_eq!(agent_run(&chosen, root, None), None);
        // A thousand long paths still make a short command.
        let many: Vec<String> = (0..1000)
            .map(|index| format!("src/{}/file-{index}.ts", "deep/".repeat(10)))
            .collect();
        let long = agent_run(&LocalVerb::BringBack(Some(many)), root, Some(file)).unwrap();
        assert!(long.args.iter().map(String::len).sum::<usize>() < 200);
    }

    /// The file is the JSON array of the chosen paths as the link carried them, and goes when its run is over.
    #[test]
    fn the_paths_file_holds_the_chosen_paths_and_goes_with_its_run() {
        let dir = std::env::temp_dir().join(format!("intentic-paths-{}", uuid::Uuid::new_v4()));
        let paths = vec!["a.md".to_string(), "src/b \"c\".ts".to_string()];
        let file = write_paths(&dir, &paths).unwrap();
        assert!(file.starts_with(&dir));
        assert_eq!(
            serde_json::from_slice::<Vec<String>>(&std::fs::read(&file).unwrap()).unwrap(),
            paths
        );
        let second = write_paths(&dir, &paths).unwrap();
        assert_ne!(file, second, "no two runs share a file");
        drop(PathsFile(file.clone()));
        assert!(!file.exists());
        drop(PathsFile(second.clone()));
        assert!(!second.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// One changing run per folder at a time, and the claim is given back however the run ends.
    #[test]
    fn a_folder_has_one_changing_run_at_a_time() {
        let root = std::env::temp_dir().join(format!("intentic-working-{}", uuid::Uuid::new_v4()));
        let claim = Working::claim(&root).expect("the first run claims the folder");
        assert!(Working::claim(&root).is_none(), "a second is turned away");
        assert!(busy());
        drop(claim);
        assert!(Working::claim(&root).is_some(), "the folder is free again");
    }

    /// The window hears the agent's own object, or a sentence when there was none, never silence.
    #[test]
    fn the_window_hears_the_agents_answer_or_why_there_is_none() {
        let run = agent_run(&LocalVerb::BringBack(None), Path::new("/home/me/app"), None).unwrap();
        assert_eq!(
            project_detail(&run, Ok(serde_json::json!({ "ok": true, "point": "p-1" }))),
            serde_json::json!({ "kind": "brought-back", "result": { "ok": true, "point": "p-1" } })
        );
        assert_eq!(
            project_detail(
                &run,
                Ok(serde_json::json!({ "ok": false, "error": "conflict" }))
            ),
            serde_json::json!({ "kind": "brought-back", "result": { "ok": false, "error": "conflict" } })
        );
        for silence in [
            AgentSilence::Missing,
            AgentSilence::WouldNotStart("Permission denied (os error 13)".into()),
            AgentSilence::TimedOut(Duration::from_secs(600)),
            AgentSilence::Unreadable("garbage".into()),
        ] {
            let error = said(&silence);
            assert_eq!(
                project_detail(&run, Err(silence)),
                serde_json::json!({ "kind": "error", "verb": "bring-back", "error": error })
            );
        }
        // An agent that is there and would not start is said as that, with the OS's reason, never as missing.
        assert_eq!(
            said(&AgentSilence::WouldNotStart(
                "Permission denied (os error 13)".into()
            )),
            "The machine agent on this computer wouldn't start (Permission denied (os error 13))."
        );
        assert!(said(&AgentSilence::Missing).contains("isn't on this computer"));
        assert_eq!(
            project_event(
                &serde_json::json!({ "kind": "changes", "result": { "note": "it's \"done\"" } })
            ),
            r#"window.dispatchEvent(new CustomEvent('intentic:project', { detail: {"kind":"changes","result":{"note":"it's \"done\""}} }));"#
        );
    }

    /// Only a sandbox this machine lists as stopped is started; a running one, another machine's, or a row it
    /// cannot read is left alone.
    #[test]
    fn only_a_sandbox_listed_here_as_stopped_is_started() {
        let rows = vec![
            serde_json::json!({ "slug": "app", "running": false }),
            serde_json::json!({ "slug": "web", "running": true }),
            serde_json::json!({ "slug": "odd" }),
        ];
        assert!(stopped_in(&rows, "app"));
        assert!(!stopped_in(&rows, "web"));
        assert!(!stopped_in(&rows, "odd"));
        assert!(!stopped_in(&rows, "elsewhere"));
    }

    #[test]
    fn another_sync_service_or_a_network_drive_is_said_before_anything_is_made() {
        assert_eq!(
            cautions(Path::new("/home/me/Dropbox/app")),
            vec![Caution::Synced {
                service: "Dropbox".into()
            }]
        );
        assert_eq!(cautions(Path::new("/mnt/nas/app")), vec![Caution::Away]);
        assert!(cautions(Path::new("/home/me/code/app")).is_empty());
        assert_eq!(
            serde_json::to_value(cautions(Path::new("/mnt/OneDrive/app"))).unwrap(),
            serde_json::json!([{ "kind": "synced", "service": "OneDrive" }, { "kind": "away" }])
        );
    }

    #[test]
    fn the_count_skips_what_the_sync_leaves_behind() {
        let dir = std::env::temp_dir().join(format!("intentic-weigh-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join("web/.astro")).unwrap();
        std::fs::write(dir.join("src/a.ts"), b"12345").unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), b"123").unwrap();
        std::fs::write(dir.join("web/.astro/dev.json"), b"1234").unwrap();
        std::fs::write(dir.join("web/.env.production.local"), b"SECRET=1").unwrap();
        assert_eq!(weigh(&dir), (1, 5));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
