//! AGENTS ON THIS COMPUTER (`_devices/host-agents`, served by the file server beside each window's folder): what the
//! app itself keeps of them. The turns, the harnesses and their sign-ins are the file server's; three things are the
//! app's, because only the app may say them or because they outlive a window:
//!
//! - **The reader's yes.** An agent here runs as the reader, with nothing between it and their files, so no turn
//!   starts until they have read that once and turned agents on for this computer. The answer is kept here
//!   (`host-agents.json` in the app's config folder) and told to the file server: as `--agents-accepted` when it is
//!   started, and on its control channel the moment it is given. A page can only ask the app for it by command, which
//!   needs script, which the local windows' policy lets only the bundle run: a document drawn in a window cannot turn
//!   agents on for itself.
//! - **How many turns run.** The file server says so each time it changes (`agents`), and they end with it, so a Quit
//!   asks first (windows/quit.rs).
//! - **The way in from a sandbox that cannot be reached.** `intentic://agent-here[?slug=…]`, from the app's own windows
//!   (the offline page, the workspace's recovery panel): a window on Intentic's own folder of this computer
//!   (`~/.intentic`), with a first message written out for the reader to send or change. Nothing is sent for them, and
//!   nothing of this path reaches the platform, so it works when Intentic's own servers are what is down.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::state::{read_json, write_json};

const FILE_NAME: &str = "host-agents.json";

/// Told to every local window when the reader's answer changes.
const EVENT: &str = "desktop://host-agents";

/// Told to every local window when a first message waits for the window on its folder.
const DRAFT_EVENT: &str = "desktop://host-agents-draft";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    accepted: bool,
    /// When they said so, in seconds, for whoever reads the file later.
    accepted_at: Option<u64>,
}

/// How many turns the file server last said are running.
static RUNNING: AtomicUsize = AtomicUsize::new(0);

/// A first message waiting for the window on `folder` to take it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Draft {
    folder: PathBuf,
    text: String,
}

static DRAFT: Mutex<Option<Draft>> = Mutex::new(None);

fn path_of(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(FILE_NAME))
        .unwrap_or_else(|| PathBuf::from(FILE_NAME))
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Whether the reader has turned agents on for this computer.
pub fn accepted(app: &AppHandle) -> bool {
    read_json::<Stored>(&path_of(app)).is_some_and(|stored| stored.accepted)
}

/// The control line that tells the file server (`_devices/local-files/src/control.ts`, `agents`).
pub fn control_line(accepted: bool) -> String {
    format!(
        "{}\n",
        serde_json::json!({ "op": "agents", "accepted": accepted })
    )
}

/// The file server said how many turns run now.
pub fn note_running(running: usize) {
    RUNNING.store(running, Ordering::SeqCst);
}

/// The file server is gone, and every turn with it.
pub fn note_stopped() {
    RUNNING.store(0, Ordering::SeqCst);
}

pub fn running() -> usize {
    RUNNING.load(Ordering::SeqCst)
}

fn state_of(app: &AppHandle) -> serde_json::Value {
    serde_json::json!({ "accepted": accepted(app), "running": running() })
}

/// Whether agents are on for this computer, and how many turns run.
#[tauri::command]
pub fn host_agents_state(app: AppHandle) -> serde_json::Value {
    state_of(&app)
}

/// The reader turned agents on for this computer: kept, told to the file server, and said to every local window.
#[tauri::command]
pub fn host_agents_accept(app: AppHandle) -> Result<serde_json::Value, String> {
    let stored = Stored {
        accepted: true,
        accepted_at: Some(now()),
    };
    if !write_json(&path_of(&app), &stored) {
        return Err("Intentic could not save that on this computer.".to_string());
    }
    // A file server that is not running yet is told when it starts (sidecar.rs `spawn`).
    if let Err(error) = crate::sidecar::send(&app, &control_line(true)) {
        eprintln!("intentic: the file server was not told agents are on: {error}");
    }
    let state = state_of(&app);
    if let Err(error) = app.emit(EVENT, &state) {
        eprintln!("intentic: the windows could not be told agents are on: {error}");
    }
    Ok(state)
}

/// The first message waiting for the window that asks, taken: only the window on the folder it was written for gets
/// it, and only once.
#[tauri::command]
pub fn host_agents_take_draft(app: AppHandle, window: Webview) -> Option<String> {
    let folder = crate::local::folder_of(&app, window.label())?;
    let mut draft = DRAFT.lock().unwrap_or_else(PoisonError::into_inner);
    if draft.as_ref().is_some_and(|held| held.folder == folder) {
        return draft.take().map(|held| held.text);
    }
    None
}

/// The first message for an agent asked to help with Intentic itself on this computer: what is known, where to look,
/// and to ask before changing anything. Written for the reader to read, change and send. Pure.
pub fn recovery_brief(home: &Path, slug: Option<&str>) -> String {
    let which = match slug {
        Some(slug) => format!("The sandbox \"{slug}\" on this computer cannot be reached."),
        None => "Something is wrong with Intentic on this computer.".to_string(),
    };
    let target = slug.unwrap_or("<slug>");
    format!(
        "{which} Help me find out why and fix it.\n\n\
         What you can use:\n\
         - `ic` is Intentic's command-line tool (in `{ic}` if it is not on PATH). `ic sandbox list --json` lists this \
         computer's sandboxes, `ic sandbox fix {target}` runs Intentic's own checks and repairs, and `ic sandbox logs \
         {target}` prints a sandbox's log.\n\
         - Intentic keeps its state and logs on this computer under `{state}`, the folder you are in.\n\
         - The sandboxes run in Docker: `docker ps -a` shows their containers, named `intentic-sandbox-…`.\n\n\
         Start by looking, tell me what you found, and ask me before you change or remove anything.",
        ic = home.join(".intentic").join("ic").join("bin").display(),
        state = home.join(".intentic").display(),
    )
}

/// `intentic://agent-here[?slug=…]`: a window on Intentic's own folder of this computer, with the first message
/// waiting in it. The window is the reader's to send from: nothing starts by itself.
pub fn requested(app: &AppHandle, slug: Option<String>) {
    let Some(home) = crate::repair::user_home() else {
        eprintln!("intentic: no home folder to open an agent in");
        return;
    };
    let folder = home.join(".intentic");
    if let Err(error) = std::fs::create_dir_all(&folder) {
        eprintln!("intentic: {} could not be made: {error}", folder.display());
        return;
    }
    // The window's folder is the real path the file server grants, so the draft is kept under that one.
    let shown = crate::local::plain(std::fs::canonicalize(&folder).unwrap_or(folder));
    let draft = Draft {
        folder: shown.clone(),
        text: recovery_brief(&home, slug.as_deref()),
    };
    *DRAFT.lock().unwrap_or_else(PoisonError::into_inner) = Some(draft);
    // A window already on that folder takes it now; one that opens for it takes it as its shell comes up.
    if let Err(error) = app.emit(DRAFT_EVENT, serde_json::Value::Null) {
        eprintln!("intentic: the windows could not be told a first message waits: {error}");
    }
    crate::local::open_later(app, shown);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_control_line_is_one_json_line_the_file_server_reads() {
        assert_eq!(
            control_line(true),
            "{\"accepted\":true,\"op\":\"agents\"}\n"
        );
        assert_eq!(
            control_line(false),
            "{\"accepted\":false,\"op\":\"agents\"}\n"
        );
    }

    #[test]
    fn the_recovery_brief_names_the_sandbox_and_where_to_look() {
        let brief = recovery_brief(Path::new("/home/ada"), Some("work"));
        assert!(brief.starts_with("The sandbox \"work\" on this computer cannot be reached."));
        assert!(brief.contains("`ic sandbox fix work`"));
        assert!(brief.contains("/home/ada/.intentic"));
        assert!(brief.ends_with("ask me before you change or remove anything."));
    }

    #[test]
    fn the_recovery_brief_without_a_sandbox_asks_about_intentic_itself() {
        let brief = recovery_brief(Path::new("/home/ada"), None);
        assert!(brief.starts_with("Something is wrong with Intentic on this computer."));
        assert!(brief.contains("`ic sandbox fix <slug>`"));
    }
}
