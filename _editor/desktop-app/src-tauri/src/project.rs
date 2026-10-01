//! A FOLDER BECOMING A SANDBOX'S PROJECT: "Work on this with an agent" in a local window (local.rs).
//!
//! One sandbox per folder. The folder is not the sandbox's `/work` (the daemon keeps its own state, a public
//! `public/` and its starter at that root), but a project inside it, `/work/<name>`. COPY-FIRST: the folder is
//! copied into the sandbox and the copy is kept up to date from here by the machine agent (`_devices/machine/src/sync`);
//! agents change the copy, and nothing in the folder changes until the window's "Bring back changes" brings what
//! they did back, keeping a restore point first ([`work`]). The setup is the ordinary one: the workspace's `/setup`
//! page mints the code and hands it back as `intentic://setup?…&project=<name>` (a sandbox on this machine), or
//! enrolls the folder with a hosted one as `intentic://sync?…&project=<name>` ([`sync_project`]), and only then does
//! this module attach the folder, which it parked itself. The path never rides a link, so no page can point a
//! sandbox at a folder the user did not pick.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::scripts::AgentSilence;
use crate::setup_link::{LocalVerb, SetupArgs, SyncArgs};
use crate::state::{AppState, Project};

/// Past this many files the first sync is a long upload, and the confirmation says so.
const MANY_FILES: u64 = 20_000;
/// And past this many bytes.
const MANY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// How far the count walks before it stops counting: enough to know "many".
const COUNT_LIMIT: u64 = 60_000;

/// What a project folder's sync leaves on this computer, at any depth (`PROJECT_IGNORES` in
/// `_devices/machine/src/sync/ssh.ts`, which is what the sync actually does): skipped by the count as they are by
/// the sync. Held to that list by `project-ignores.fixture.json`, which both sides' tests read.
const NOT_SYNCED: [&str; 20] = [
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
];

/// Whether a file or folder called `name` stays on this computer: a [`NOT_SYNCED`] pattern names it, where `*`
/// stands for any run of characters, as in the sync's own ignore patterns.
fn not_synced(name: &str) -> bool {
    NOT_SYNCED.iter().any(|pattern| matches_name(pattern, name))
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

/// Why `path` cannot become a project, or nothing when it can. `taken` are the folders that already have one.
pub fn refusal(path: &Path, home: Option<&Path>, taken: &[PathBuf]) -> Option<String> {
    let shown = path.display();
    if path.parent().is_none() {
        return Some(format!(
            "{shown} is a whole disk. Pick the folder of one project in it."
        ));
    }
    if home == Some(path) {
        return Some(format!(
            "{shown} is your whole home folder. Pick the folder of one project in it."
        ));
    }
    if home.is_some_and(|home| home.starts_with(path)) {
        return Some(format!(
            "{shown} holds your home folder. Pick the folder of one project in it."
        ));
    }
    // Fedora Atomic (Silverblue, Kinoite, Bazzite…) keeps the homes under `/var/home`, `/home` being a link to it:
    // a folder in somebody's home there is theirs, not the system's, whatever the rule for `/var` below says. The
    // homes' own folder, and a home itself, are refused as the ones at `/home` are.
    match path
        .strip_prefix("/var/home")
        .ok()
        .map(|rest| rest.components().count())
    {
        Some(0) => {
            return Some(format!(
                "{shown} holds everyone's home folders. Pick the folder of one project in yours."
            ))
        }
        Some(1) => {
            return Some(format!(
                "{shown} is a whole home folder. Pick the folder of one project in it."
            ))
        }
        Some(_) => return nested(path, taken),
        None => {}
    }
    let system: &[&str] = if cfg!(windows) {
        &[
            r"C:\Windows",
            r"C:\Program Files",
            r"C:\Program Files (x86)",
            r"C:\ProgramData",
        ]
    } else {
        &[
            "/bin",
            "/boot",
            "/dev",
            "/etc",
            "/lib",
            "/proc",
            "/sbin",
            "/sys",
            "/usr",
            "/var",
            "/System",
            "/Library",
            "/Applications",
        ]
    };
    if system.iter().any(|root| path.starts_with(root)) {
        return Some(format!(
            "{shown} belongs to the system. Pick a folder of your own."
        ));
    }
    nested(path, taken)
}

/// Why `path` cannot become a project for being inside or around one that already is.
fn nested(path: &Path, taken: &[PathBuf]) -> Option<String> {
    let shown = path.display();
    for other in taken {
        if path != other && path.starts_with(other) {
            return Some(format!(
                "{shown} is inside {}, which already has a sandbox. Open that folder instead.",
                other.display()
            ));
        }
        if path != other && other.starts_with(path) {
            return Some(format!(
                "{shown} holds {}, which already has a sandbox of its own.",
                other.display()
            ));
        }
    }
    None
}

/// What to say before `path` becomes a project: a folder another service already syncs, one on a network or a
/// removable drive. None of these refuse; each is a way the sync can disappoint.
pub fn cautions(path: &Path) -> Vec<String> {
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
            said.push(format!("{service} already syncs this folder. Two syncs on one folder can undo each other's changes."));
            break;
        }
    }
    if text.starts_with(r"\\")
        || text.starts_with("/mnt/")
        || text.starts_with("/media/")
        || text.starts_with("/run/media/")
    {
        said.push("This folder is on a network or removable drive: the sync is slower there and pauses while it is away.".to_string());
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
            if not_synced(&entry.file_name().to_string_lossy()) {
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
fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_string())
}

/// The workspace, at the sandbox a project already has.
fn show_project(app: &AppHandle, project: &Project) {
    match &project.sandbox_id {
        Some(id) => {
            crate::windows::show_workspace_at(app, Some(&format!("/?sandbox={}", urlencode(id))))
        }
        None => crate::windows::show_workspace(app),
    }
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

/// Why `root` cannot become a project on this machine, against the projects it already has and the user's home.
fn refusal_here(app: &AppHandle, root: &Path) -> Option<String> {
    let taken: Vec<PathBuf> = app
        .state::<AppState>()
        .projects()
        .iter()
        .map(|project| PathBuf::from(&project.path))
        .collect();
    let home = app.path().home_dir().ok();
    refusal(root, home.as_deref(), &taken)
}

fn refuse(app: &AppHandle, why: String) {
    app.dialog()
        .message(why)
        .title("This folder can't have a sandbox")
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}

/// "Work on this with an agent", from the local window showing `root`: the sandbox it already has, or the question
/// that makes one.
pub fn start(app: &AppHandle, root: PathBuf) {
    let projects = app.state::<AppState>().projects();
    if let Some(project) = projects
        .iter()
        .find(|project| Path::new(&project.path) == root)
    {
        open_existing(app, project);
        return;
    }
    if let Some(why) = refusal_here(app, &root) {
        refuse(app, why);
        return;
    }
    let (files, bytes) = weigh(&root);
    let mut cautions = cautions(&root);
    if files >= MANY_FILES || bytes >= MANY_BYTES {
        cautions.push(format!(
            "It holds {}{files} files ({} MB). The first sync uploads them all, which can take a while.",
            if files >= COUNT_LIMIT { "more than " } else { "" },
            bytes / (1024 * 1024)
        ));
    }
    let caution_text = if cautions.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", cautions.join("\n\n"))
    };
    let handle = app.clone();
    let name = folder_name(&root);
    let dialog = app
        .dialog()
        .message(copy_first(&root, &caution_text))
        .title(format!("Work on {name} with an agent?"))
        .kind(MessageDialogKind::Info);
    // With this computer's engine up, the sandbox runs here unless the owner picks one of intentic's machines in the
    // same question. Without one, the setup page decides, as it always has: a machine of ours where one can be started.
    if crate::scripts::engine_listening() {
        dialog
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                HERE_LABEL.into(),
                HOSTED_LABEL.into(),
                "Cancel".into(),
            ))
            .show_with_result(move |result| {
                if let Some(placement) = placement_of(&result) {
                    park_and_open(&handle, root, &name, Some(placement));
                }
            });
    } else {
        dialog
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Create sandbox".into(),
                "Cancel".into(),
            ))
            .show(move |confirmed| {
                if confirmed {
                    park_and_open(&handle, root, &name, None);
                }
            });
    }
}

/// Where a folder's sandbox runs, as its question answered: on this computer, or on one of intentic's machines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    Here,
    Hosted,
}

/// The answer that makes the sandbox on this computer, the first and default one.
const HERE_LABEL: &str = "Create sandbox here";
/// The answer that asks intentic for a machine instead.
const HOSTED_LABEL: &str = "Use an intentic machine";

/// The placement a pressed button chose, or none for Cancel. A custom button answers with its own label; a dialog
/// that answers yes or no instead is read by position, the same order the buttons were given in.
fn placement_of(result: &MessageDialogResult) -> Option<Placement> {
    match result {
        MessageDialogResult::Custom(label) if label == HERE_LABEL => Some(Placement::Here),
        MessageDialogResult::Custom(label) if label == HOSTED_LABEL => Some(Placement::Hosted),
        MessageDialogResult::Yes => Some(Placement::Here),
        MessageDialogResult::No => Some(Placement::Hosted),
        _ => None,
    }
}

/// The setup page a folder's answer opens: the project's name, and where it runs when the question asked. The page
/// takes `machine` as the reader's own pick (setupArrival.ts `requestedMachine`), so `mine` installs here at once and
/// `hosted` starts one of intentic's machines; none leaves the choice to the page.
fn setup_path(name: &str, placement: Option<Placement>) -> String {
    let machine = match placement {
        Some(Placement::Here) => "&machine=mine",
        Some(Placement::Hosted) => "&machine=hosted",
        None => "",
    };
    format!("/setup?project={}{machine}", urlencode(name))
}

/// Parks the folder for the setup that follows (`bind` takes it), and opens that setup.
fn park_and_open(app: &AppHandle, root: PathBuf, name: &str, placement: Option<Placement>) {
    *app.state::<AppState>().pending_project.lock().unwrap() = Some(root);
    crate::windows::show_workspace_at(app, Some(&setup_path(name, placement)));
}

/// A setup link for a project, bound to the folder this app parked for it: the one place a project's folder
/// enters a setup. A project link with nothing parked is an ordinary setup with nothing synced.
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

/// A project's setup finished: the folder has its sandbox, and opening it again reaches that one.
pub fn remember(app: &AppHandle, args: &SetupArgs, slug: Option<String>) {
    let (Some(dir), Some(folder)) = (args.project.clone(), args.sync_dir.clone()) else {
        return;
    };
    app.state::<AppState>().remember_project(Project {
        path: folder,
        dir,
        sandbox_id: args.sandbox_id.clone(),
        slug,
    });
}

/// What "Work on this with an agent" says before anything is made: copy-first, in the order it happens. The folder
/// is copied and kept up to date from here; agents change the copy; this folder changes only when the window's
/// "Bring back changes" is pressed, and each of those keeps a restore point.
fn copy_first(root: &Path, cautions: &str) -> String {
    format!(
        "Intentic will copy {} into a sandbox and keep the copy up to date from here as you work.\n\n\
         Agents change the copy, never this folder. Nothing here changes until you press \"Bring back changes\" \
         in this window, and every bring-back keeps a restore point you can go back to. Your .git, node_modules, \
         build output and .env and .env.local files stay on this computer only.{cautions}",
        root.display()
    )
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
fn said(silence: &AgentSilence) -> String {
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
                refuse(&handle, why);
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

    /// What the confirmation counts without is what the machine agent's sync leaves behind, entry for entry.
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

    /// The owner's answer is where the sandbox runs, and Cancel makes nothing.
    #[test]
    fn the_answer_says_where_the_sandbox_runs_and_cancel_makes_nothing() {
        assert_eq!(
            placement_of(&MessageDialogResult::Custom(HERE_LABEL.into())),
            Some(Placement::Here)
        );
        assert_eq!(
            placement_of(&MessageDialogResult::Custom(HOSTED_LABEL.into())),
            Some(Placement::Hosted)
        );
        assert_eq!(
            placement_of(&MessageDialogResult::Yes),
            Some(Placement::Here)
        );
        assert_eq!(
            placement_of(&MessageDialogResult::No),
            Some(Placement::Hosted)
        );
        assert_eq!(
            placement_of(&MessageDialogResult::Custom("Cancel".into())),
            None
        );
        assert_eq!(placement_of(&MessageDialogResult::Cancel), None);
    }

    #[test]
    fn the_setup_page_is_told_where_the_owner_chose_and_left_to_decide_otherwise() {
        assert_eq!(
            setup_path("my app", Some(Placement::Here)),
            "/setup?project=my+app&machine=mine"
        );
        assert_eq!(
            setup_path("my-app", Some(Placement::Hosted)),
            "/setup?project=my-app&machine=hosted"
        );
        assert_eq!(setup_path("my-app", None), "/setup?project=my-app");
    }

    /// The question says what copy-first is, in the order it happens: a copy, kept up to date from here, changed by
    /// agents, and nothing here changing until "Bring back changes", which keeps a restore point.
    #[test]
    fn the_question_before_a_sandbox_is_made_says_copy_first() {
        let text = copy_first(Path::new("/home/me/app"), "");
        for said in [
            "copy /home/me/app into a sandbox",
            "keep the copy up to date from here",
            "Agents change the copy, never this folder.",
            "Nothing here changes until you press \"Bring back changes\" in this window",
            "restore point",
        ] {
            assert!(text.contains(said), "{said:?} missing from {text:?}");
        }
        assert!(!text.contains("both ways"));
        assert!(copy_first(Path::new("/a"), "\n\nCAUTION").ends_with("\n\nCAUTION"));
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
        assert_eq!(cautions(Path::new("/home/me/Dropbox/app")).len(), 1);
        assert_eq!(cautions(Path::new("/mnt/nas/app")).len(), 1);
        assert!(cautions(Path::new("/home/me/code/app")).is_empty());
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
