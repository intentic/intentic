//! A FOLDER BECOMING A SANDBOX'S PROJECT: "Work on this with an agent" in a local window (local.rs).
//!
//! One sandbox per folder. The folder is not the sandbox's `/work` (the daemon keeps its own state, a public
//! `public/` and its starter at that root), but a project inside it, `/work/<name>`, kept in two-way sync with the
//! folder by the machine agent's Mutagen (`_devices/machine/src/sync`). The setup is the ordinary one: the workspace's
//! `/setup` page mints the code and hands it back as `intentic://setup?…&project=<name>`, and only then does this
//! module attach the folder, which it parked itself. The path never rides a link, so no page can point a sandbox at
//! a folder the user did not pick.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::setup_link::SetupArgs;
use crate::state::{AppState, Project};

/// Past this many files the first sync is a long upload, and the confirmation says so.
const MANY_FILES: u64 = 20_000;
/// And past this many bytes.
const MANY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// How far the count walks before it stops counting: enough to know "many".
const COUNT_LIMIT: u64 = 60_000;

/// Folders the sync leaves on this computer whatever they hold (`_devices/machine/src/sync/ssh.ts`), skipped by the
/// count as they are by the sync.
const NOT_SYNCED: [&str; 10] = [
    ".git",
    "node_modules",
    "dist",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
];

/// A project folder name as the sandbox takes it: what ic and the daemon enforce in full (reserved names
/// included, `_shared/sandbox-contract/src/ids/project-dir.ts`), checked here for its shape only.
pub fn is_project_dir_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64
        && chars
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && chars.all(|rest| rest.is_ascii_alphanumeric() || matches!(rest, '.' | '_' | '-'))
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
            if kind.is_dir() {
                if !NOT_SYNCED.contains(&entry.file_name().to_string_lossy().as_ref()) {
                    pending.push(entry.path());
                }
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

/// "Work on this with an agent", from the local window showing `root`: the sandbox it already has, or the question
/// that makes one.
pub fn start(app: &AppHandle, root: PathBuf) {
    let state = app.state::<AppState>();
    let projects = state.projects();
    if let Some(project) = projects
        .iter()
        .find(|project| Path::new(&project.path) == root)
    {
        open_existing(app, project);
        return;
    }
    let taken: Vec<PathBuf> = projects
        .iter()
        .map(|project| PathBuf::from(&project.path))
        .collect();
    let home = app.path().home_dir().ok();
    if let Some(why) = refusal(&root, home.as_deref(), &taken) {
        app.dialog()
            .message(why)
            .title("This folder can't have a sandbox")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
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
    app.dialog()
        .message(format!(
            "Intentic will create a sandbox for {} and keep this folder in sync with it, both ways.\n\n\
             Agents in the sandbox edit and delete these files directly, on your disk. Your .git, node_modules, build output \
             and .env and .env.local files stay on this computer only, and your git history is never changed.{caution_text}",
            root.display()
        ))
        .title(format!("Work on {name} with an agent?"))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Create sandbox".into(), "Cancel".into()))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            *handle.state::<AppState>().pending_project.lock().unwrap() = Some(root);
            crate::windows::show_workspace_at(&handle, Some(&format!("/setup?project={}", urlencode(&name))));
        });
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

#[cfg(test)]
mod tests {
    use super::*;

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
        std::fs::write(dir.join("src/a.ts"), b"12345").unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), b"123").unwrap();
        assert_eq!(weigh(&dir), (1, 5));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
