//! FIRST RUN (2026-10-09): the first task, written on This computer's card while this PC is set up, kept on disk so a
//! restart keeps it, and handed to the workspace once its folder's own sandbox has the folder in (folder_setup.rs; the
//! web's localHost.ts `LocalFirstTask` and `TASK_QUERY`; the app's half is src/onboarding/firstTask.ts, drawn by
//! src/device/pcSetup/PcSetupCard.vue).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::folder_setup::{Record, Standing};
use crate::local::FILES;
use crate::notice;
use crate::project::{self, folder_name};
use crate::setup_link::{FirstTaskLink, NoticeArgs, NoticeKind};
use crate::state::write_json;
use crate::windows::{self, HOME};

pub const EVENT: &str = "desktop://first-task";
/// A draft handed to This computer's card ([`prefill_from_ask`]), with the draft itself as its payload.
pub const DRAFT_EVENT: &str = "desktop://first-task-draft";
const FILE_NAME: &str = "first-task.json";

/// A first task not yet written, only begun: the folder and the opening words "Ask about this" filled in while no
/// sandbox can answer. Held here rather than in the route that opens the page (`/agents?draftFolder=…` until
/// 2026-10-12), so a main window still being built finds it when its card asks ([`first_task_take_draft`]); kept in
/// memory only, since a draft nobody saw before the app closed is not worth bringing back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Draft {
    folder: String,
    text: String,
}

static DRAFT: Mutex<Option<Draft>> = Mutex::new(None);

/// Serializes every read-modify-write of the task file. `create_named` can re-enter through folder_setup.rs's
/// `update` → `folder_changed`; the task is marked `Sending` before the folder is asked in so a re-entrant call does
/// nothing, and the gate is dropped before it so the outer call cannot deadlock.
static GATE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTask {
    id: String,
    folder: String,
    text: String,
    queued_at: u64,
    state: TaskState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// Set once the workspace was opened with the task query, so a later record change does not open twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    opened_at: Option<u64>,
    /// The names the folder may take in its sandbox, best first, as the page derived them (sandbox-contract's
    /// `projectDirCandidates`): the first is its name there. Empty for a task kept before the page sent any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    names: Vec<String>,
}

/// The most names a queued task is held to: the page sends a few, and is never trusted with more.
const NAMES_MAX: usize = 4;

/// The folder's name in the sandbox and the ones it may take instead: the page's, held to the project rule, else the
/// folder's own name, as a task kept before the page sent names was asked under. Pure.
fn names_for(names: &[String], folder: &Path) -> (String, Vec<String>) {
    let mut valid = names
        .iter()
        .filter(|name| project::is_project_dir_name(name))
        .take(NAMES_MAX)
        .cloned();
    match valid.next() {
        Some(first) => (first, valid.collect()),
        None => (folder_name(folder), Vec::new()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum TaskState {
    Queued,
    Sending,
    Sent,
    Failed,
}

impl TaskState {
    fn wire(self) -> &'static str {
        match self {
            TaskState::Queued => "queued",
            TaskState::Sending => "sending",
            TaskState::Sent => "sent",
            TaskState::Failed => "failed",
        }
    }
}

/// What to do next for a kept task, given whether its folder's sandbox has it in, and whether it was opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskStep {
    Nothing,
    /// Ask the folder in, for a sandbox of its own.
    Ask,
    Open,
}

fn task_step(task_state: TaskState, folder_in: bool, opened_at: Option<u64>) -> TaskStep {
    match task_state {
        TaskState::Queued => TaskStep::Ask,
        TaskState::Sending if folder_in && opened_at.is_none() => TaskStep::Open,
        _ => TaskStep::Nothing,
    }
}

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

fn read(app: &AppHandle) -> Option<StoredTask> {
    let path = path_of(app);
    if !path.exists() {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save(app: &AppHandle, task: &StoredTask) {
    write_json(&path_of(app), task);
    emit(app, task);
}

fn emit(app: &AppHandle, task: &StoredTask) {
    let payload = serde_json::json!({
        "folder": task.folder,
        "text": task.text,
        "queuedAt": task.queued_at,
        "state": task.state.wire(),
        "reason": task.reason,
    });
    if let Err(error) = app.emit(EVENT, payload) {
        eprintln!("intentic: the windows could not be told about the first task: {error}");
    }
}

fn mint_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn queue_task(
    app: &AppHandle,
    folder: String,
    text: String,
    names: Vec<String>,
) -> Result<(), String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.is_dir() {
        return Err("Pick a folder that is still there.".to_string());
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Say what you want the agents to do.".to_string());
    }
    let _gate = GATE.lock().unwrap();
    let task = StoredTask {
        id: mint_id(),
        folder,
        text: trimmed.to_string(),
        queued_at: now(),
        state: TaskState::Queued,
        reason: None,
        opened_at: None,
        names: names.into_iter().take(NAMES_MAX).collect(),
    };
    save(app, &task);
    drop(_gate);
    // Off the calling thread: asking the folder in may first have the machine agent let go of a dead sandbox's sync.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || try_send(&app));
    Ok(())
}

/// A launch: a task kept across it moves on from where it was (its folder asked in, or opened on once it is in).
pub fn on_launch(app: &AppHandle) {
    try_send(app);
}

fn draft_from_ask(folder: &Path, file_name: &str) -> Draft {
    Draft {
        folder: folder.display().to_string(),
        text: format!("About {file_name}: "),
    }
}

/// "Ask about this" while no sandbox can answer yet: This computer's first-task box filled with a draft rather than a
/// task queued. Every window open hears it at once; a main window still being built takes it when it asks. Nobody is
/// taken there (windows/present.rs): a tile on both faces' rails says the draft is waiting, and its Open is the way.
pub fn prefill_from_ask(app: &AppHandle, folder: &Path, file_name: &str) {
    let draft = draft_from_ask(folder, file_name);
    *DRAFT.lock().unwrap_or_else(PoisonError::into_inner) = Some(draft.clone());
    if let Err(error) = app.emit(DRAFT_EVENT, &draft) {
        eprintln!("intentic: the windows could not be told about the draft task: {error}");
    }
    let mut report = crate::processes::ProcessReport::of("first-task", DRAFT_ABOUT, "waiting");
    report.subject = Some(file_name.to_string());
    report.folder = Some(draft.folder.clone());
    report.waiting_for = Some("answer".into());
    report.actions = vec!["open".into(), "dismiss".into()];
    crate::processes::report(app, report);
}

/// What a first task's process is about: the draft "Ask about this" left, or the task kept on disk.
const DRAFT_ABOUT: &str = "draft";
const TASK_ABOUT: &str = "task";

/// Where a press on a first task's Open goes (processes.rs makes the press): This computer's card for a draft, the
/// workspace on the task's folder for a task whose folder is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opens {
    Device,
    Workspace(String),
}

/// The reader's answer on a first task's tile. `about` is the process's own part of its id.
pub fn act(app: &AppHandle, about: &str, act: &str) -> Option<Opens> {
    match (about, act) {
        (DRAFT_ABOUT, "open") => Some(Opens::Device),
        (DRAFT_ABOUT, "dismiss") => {
            DRAFT.lock().unwrap_or_else(PoisonError::into_inner).take();
            crate::processes::clear(app, &format!("first-task:{DRAFT_ABOUT}"));
            None
        }
        (TASK_ABOUT, "open") => {
            let task = read(app)?;
            let (sandbox_id, dir) = folder_in(app, Path::new(&task.folder))?;
            let path = opened(app, &task, &sandbox_id, &dir)?;
            crate::processes::clear(app, &format!("first-task:{TASK_ABOUT}"));
            Some(Opens::Workspace(path))
        }
        (TASK_ABOUT, "dismiss") => {
            let _ = first_task_clear(app.clone());
            crate::processes::clear(app, &format!("first-task:{TASK_ABOUT}"));
            None
        }
        _ => None,
    }
}

/// The draft "Ask about this" left for This computer's card, taken: the next window to ask gets none.
#[tauri::command]
pub fn first_task_take_draft() -> Option<serde_json::Value> {
    DRAFT
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
        .and_then(|draft| serde_json::to_value(draft).ok())
}

/// The task kept on disk, as `LocalFirstTask` names it, or none.
#[tauri::command]
pub fn first_task_read(app: AppHandle) -> Option<serde_json::Value> {
    read(&app).map(|task| {
        serde_json::json!({
            "folder": task.folder,
            "text": task.text,
            "queuedAt": task.queued_at,
            "state": task.state.wire(),
            "reason": task.reason,
        })
    })
}

/// Keep a task to send once its folder's own sandbox has it in, in place of any kept before.
#[tauri::command]
pub fn first_task_queue(
    app: AppHandle,
    folder: String,
    text: String,
    names: Option<Vec<String>>,
) -> Result<(), String> {
    queue_task(&app, folder, text, names.unwrap_or_default())
}

/// Forget the task kept, whatever became of it.
#[tauri::command]
pub fn first_task_clear(app: AppHandle) -> Result<(), String> {
    let _gate = GATE.lock().unwrap();
    let path = path_of(&app);
    if path.is_file() {
        if let Err(error) = std::fs::remove_file(&path) {
            eprintln!("intentic: could not forget the first task: {error}");
        }
    }
    if let Err(error) = app.emit(EVENT, serde_json::Value::Null) {
        eprintln!("intentic: the windows could not be told the first task was cleared: {error}");
    }
    Ok(())
}

/// The system's folder dialog for the task's folder: none when nothing was chosen.
#[tauri::command]
pub async fn first_task_pick_folder(app: AppHandle) -> Option<String> {
    // Over the app's one window, where the main window is drawn (frame.rs).
    let parent = crate::frame::face(&app, HOME).map(|face| face.window());
    let (tx, rx) = std::sync::mpsc::channel();
    let mut dialog = app.dialog().file();
    if let Some(window) = parent.as_ref() {
        dialog = dialog.set_parent(window);
    }
    dialog.pick_folder(move |path| {
        let _ = tx.send(path.and_then(|path| path.into_path().ok()));
    });
    rx.recv()
        .ok()
        .flatten()
        .map(|path| path.display().to_string())
}

/// A folder's setup changed (folder_setup.rs `update`, after every change): the moment a kept task on that folder may
/// go, once its first copy is in.
pub fn folder_changed(app: &AppHandle, record: &Record) {
    if !matches!(record.standing, Standing::Ready | Standing::Failed { .. }) {
        return;
    }
    let _gate = GATE.lock().unwrap();
    let Some(mut task) = read(app) else {
        return;
    };
    if !project::folder_paths_same(
        Path::new(&record.path),
        Path::new(&task.folder),
        cfg!(windows),
    ) {
        return;
    }
    // Its folder's sandbox could not be made: the task says why, where it was written.
    if let Standing::Failed { reason } = &record.standing {
        if task.state == TaskState::Sending {
            task.state = TaskState::Failed;
            task.reason = Some(reason.clone());
            save(app, &task);
        }
        return;
    }
    if task_step(task.state, true, task.opened_at) != TaskStep::Open {
        return;
    }
    drop(_gate);
    if let Some(sandbox_id) = record.sandbox_id.as_deref() {
        offer(app, &task, sandbox_id, &record.name);
    }
}

/// Where a kept task's folder is now: its sandbox and its name there, once the folder is in one.
fn folder_in(app: &AppHandle, folder: &Path) -> Option<(String, String)> {
    let project = project::live_project_of(app, folder)?;
    Some((project.sandbox_id?, project.dir))
}

/// A kept task moved on: its folder asked in, or, already in, the workspace opened on it.
fn try_send(app: &AppHandle) {
    let folder_path;
    let names;
    {
        let _gate = GATE.lock().unwrap();
        let Some(mut task) = read(app) else {
            return;
        };
        let folder = PathBuf::from(&task.folder);
        let found = folder_in(app, &folder);
        match task_step(task.state, found.is_some(), task.opened_at) {
            TaskStep::Nothing => return,
            TaskStep::Open => {
                drop(_gate);
                if let Some((sandbox_id, dir)) = found {
                    offer(app, &task, &sandbox_id, &dir);
                }
                return;
            }
            TaskStep::Ask => {}
        }
        if let Some(why) = project::refusal_for_first_task(app, &folder) {
            task.state = TaskState::Failed;
            task.reason = Some(why);
            save(app, &task);
            return;
        }
        folder_path = folder;
        names = names_for(&task.names, &folder_path);
        task.state = TaskState::Sending;
        save(app, &task);
    }
    // Gate dropped first: the folder's setup may call back into `folder_changed` while it is asked in; the task is
    // already `Sending`, so that call does not ask twice.
    let asked = project::create_named(app, &folder_path, &names.0);
    let _gate = GATE.lock().unwrap();
    let Some(mut task) = read(app) else {
        return;
    };
    if task.state != TaskState::Sending {
        return;
    }
    match asked {
        Err(reason) => {
            task.state = TaskState::Failed;
            task.reason = Some(reason);
            save(app, &task);
        }
        // The folder had its sandbox already: the task is ready for the reader's Open.
        Ok(project::Created::Opened) => {
            drop(_gate);
            if let Some((sandbox_id, dir)) = folder_in(app, &folder_path) {
                offer(app, &task, &sandbox_id, &dir);
            }
        }
        Ok(project::Created::Started { .. }) => {}
    }
}

/// The task's folder is in: the task is ready to start, on both faces' rails with an Open, and the system's notification
/// says so while nobody is looking. It goes when the reader opens it (windows/present.rs). _(2026-10-26) The workspace
/// went up on it by itself, whatever the reader was doing._
fn offer(app: &AppHandle, task: &StoredTask, sandbox_id: &str, dir: &str) {
    let fresh = crate::processes::get(app, &format!("first-task:{TASK_ABOUT}")).is_none();
    let mut report = crate::processes::ProcessReport::of("first-task", TASK_ABOUT, "waiting");
    report.subject = Some(dir.to_string());
    report.sandbox_id = Some(sandbox_id.to_string());
    report.folder = Some(task.folder.clone());
    report.waiting_for = Some("answer".into());
    report.actions = vec!["open".into(), "dismiss".into()];
    crate::processes::report(app, report);
    if fresh && !reader_here(app) {
        notice::show(
            app,
            NoticeArgs {
                key: "first-task".to_string(),
                kind: NoticeKind::Finished,
                title: "Your first task is ready".to_string(),
                body: Some(format!(
                    "{dir} is in its sandbox. Open it to hand the task to an agent."
                )),
                path: Some(format!("{}first-task:{TASK_ABOUT}", notice::PROCESS)),
                silent: false,
            },
        );
    }
}

/// The workspace's address with the task handed to it, once: marked opened, so a later record change offers nothing.
fn opened(app: &AppHandle, task: &StoredTask, sandbox_id: &str, dir: &str) -> Option<String> {
    let path = workspace_path(sandbox_id, dir, task)?;
    let _gate = GATE.lock().unwrap();
    let mut opened = read(app)?;
    if opened.id != task.id || opened.opened_at.is_some() {
        return None;
    }
    opened.opened_at = Some(now());
    save(app, &opened);
    Some(path)
}

fn workspace_path(sandbox_id: &str, project_dir: &str, task: &StoredTask) -> Option<String> {
    let handoff = serde_json::json!({ "v": 1, "id": task.id, "text": task.text });
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(handoff.to_string());
    Some(format!(
        "/?sandbox={}&project={}&task={}",
        urlencode(sandbox_id),
        urlencode(project_dir),
        urlencode(&encoded)
    ))
}

fn urlencode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn reader_here(app: &AppHandle) -> bool {
    windows::focused_page(app)
        .is_some_and(|label| label == windows::HOME || label.starts_with(FILES))
}

/// The workspace saying what became of the task it was handed (`intentic://first-task`).
pub fn on_link(app: &AppHandle, link: FirstTaskLink) {
    let _gate = GATE.lock().unwrap();
    let Some(mut task) = read(app) else {
        return;
    };
    if task.id != link.id {
        return;
    }
    if let Some(reason) = link.failed {
        task.state = TaskState::Failed;
        task.reason = Some(reason);
    } else {
        task.state = TaskState::Sent;
        task.reason = None;
    }
    save(app, &task);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_query_encodes_handoff() {
        let task = StoredTask {
            id: "abc-123".to_string(),
            folder: "C:\\work".to_string(),
            text: "Fix the bug".to_string(),
            queued_at: 1,
            state: TaskState::Sending,
            reason: None,
            opened_at: None,
            names: Vec::new(),
        };
        let path = workspace_path("sb1", "work", &task).expect("path");
        assert!(path.contains("task="));
        assert!(path.contains("sandbox=sb1"));
        assert!(path.contains("project=work"));
    }

    // The page's names for the folder are taken, held to the project rule; a task kept before it sent any is asked under
    // the folder's own name, as it always was.
    #[test]
    fn a_task_goes_in_under_the_names_the_page_gave_it() {
        let names = vec![
            "My-App".to_string(),
            "public".to_string(),
            "code-My-App".to_string(),
        ];
        assert_eq!(
            names_for(&names, Path::new("/home/ada/code/My App")),
            ("My-App".to_string(), vec!["code-My-App".to_string()])
        );
        assert_eq!(
            names_for(&[], Path::new("/home/ada/shop")),
            ("shop".to_string(), Vec::new())
        );
    }

    #[test]
    fn a_draft_from_ask_names_the_folder_and_the_file() {
        let draft = draft_from_ask(Path::new("/home/ada/shop"), "notes.md");
        assert_eq!(
            serde_json::to_value(&draft).expect("serialized"),
            serde_json::json!({ "folder": "/home/ada/shop", "text": "About notes.md: " })
        );
    }

    #[test]
    fn a_draft_is_taken_once() {
        *DRAFT.lock().unwrap() = Some(draft_from_ask(Path::new("/home/ada/shop"), "a.txt"));
        assert_eq!(
            first_task_take_draft(),
            Some(serde_json::json!({ "folder": "/home/ada/shop", "text": "About a.txt: " }))
        );
        assert_eq!(first_task_take_draft(), None);
    }

    /// A kept task asks its folder in at once (the folder's own setup waits for a sign-in or Docker itself), and opens
    /// the workspace once, when the folder is in.
    #[test]
    fn task_step_decisions() {
        assert_eq!(task_step(TaskState::Queued, false, None), TaskStep::Ask);
        assert_eq!(task_step(TaskState::Queued, true, None), TaskStep::Ask);
        assert_eq!(task_step(TaskState::Sending, true, None), TaskStep::Open);
        assert_eq!(
            task_step(TaskState::Sending, false, None),
            TaskStep::Nothing
        );
        assert_eq!(
            task_step(TaskState::Sending, true, Some(1)),
            TaskStep::Nothing
        );
        assert_eq!(task_step(TaskState::Sent, true, None), TaskStep::Nothing);
    }
}
