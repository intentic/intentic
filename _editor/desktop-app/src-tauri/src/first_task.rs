//! FIRST RUN (2026-10-09): the first task, written on the local shell's Agents view while this PC is set up, kept on
//! disk so a restart keeps it, and handed to the workspace once this computer's sandbox is ready (the web's
//! localHost.ts `LocalFirstTask` and `TASK_QUERY`; the app's half is src/onboarding/firstTask.ts).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::local::FILES;
use crate::machine_sandbox::{self, FolderState, Record, Standing};
use crate::notice;
use crate::project::{self, folder_name};
use crate::setup_link::{FirstTaskLink, NoticeArgs, NoticeKind};
use crate::state::write_json;
use crate::windows::{self, HOME};

pub const EVENT: &str = "desktop://first-task";
const FILE_NAME: &str = "first-task.json";

/// Serializes every read-modify-write of the task file. `attach_at_path` can re-enter through
/// `machine_sandbox::change` → `machine_changed` → `try_send`; the task is marked `Sending` before attach so a
/// re-entrant call does nothing, and the gate is dropped before attach so the outer call cannot deadlock.
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

/// What to do next for a kept task, given sandbox standing and whether its folder is ready in the record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskStep {
    Nothing,
    Attach,
    Open,
}

fn task_step(
    task_state: TaskState,
    standing: &Standing,
    folder_ready: bool,
    opened_at: Option<u64>,
) -> TaskStep {
    match task_state {
        TaskState::Queued if *standing == Standing::Ready => TaskStep::Attach,
        TaskState::Sending
            if *standing == Standing::Ready && folder_ready && opened_at.is_none() =>
        {
            TaskStep::Open
        }
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

fn queue_task(app: &AppHandle, folder: String, text: String) -> Result<(), String> {
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
    };
    save(app, &task);
    drop(_gate);
    try_send(app);
    Ok(())
}

/// "Ask about this" while no sandbox can answer yet: open Agents with a draft, not a queued task.
pub fn prefill_from_ask(app: &AppHandle, folder: &Path, file_name: &str) {
    let text = format!("About {file_name}: ");
    let route = format!(
        "/agents?draftFolder={}&draftText={}",
        urlencode(&folder.display().to_string()),
        urlencode(&text),
    );
    windows::show_home_route(app, &route);
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

/// Keep a task to send once this computer's sandbox is ready, in place of any kept before.
#[tauri::command]
pub fn first_task_queue(app: AppHandle, folder: String, text: String) -> Result<(), String> {
    queue_task(&app, folder, text)
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
    let parent = app.get_webview_window(HOME);
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

/// This computer's sandbox changed (machine_sandbox.rs `change`, after every change): the moment a kept task may go.
pub fn machine_changed(app: &AppHandle, record: &Record) {
    if record.standing != Standing::Ready {
        return;
    }
    try_send(app);
    let _gate = GATE.lock().unwrap();
    let Some(task) = read(app) else {
        return;
    };
    let folder_ready = folder_ready_in(record, &task.folder);
    if task_step(task.state, &record.standing, folder_ready, task.opened_at) == TaskStep::Open {
        drop(_gate);
        maybe_open(app, record, &task);
    }
}

fn folder_ready_in(record: &Record, folder: &str) -> bool {
    let wanted = PathBuf::from(folder);
    record.folders.iter().any(|entry| {
        project::folder_paths_same(Path::new(&entry.path), &wanted, cfg!(windows))
            && entry.state == FolderState::Ready
    })
}

fn try_send(app: &AppHandle) {
    let record = machine_sandbox::status(app);
    let folder_path;
    let name;
    {
        let _gate = GATE.lock().unwrap();
        let Some(mut task) = read(app) else {
            return;
        };
        let folder_ready = folder_ready_in(&record, &task.folder);
        match task_step(task.state, &record.standing, folder_ready, task.opened_at) {
            TaskStep::Nothing => return,
            TaskStep::Open => {
                drop(_gate);
                maybe_open(app, &record, &task);
                return;
            }
            TaskStep::Attach => {}
        }
        folder_path = PathBuf::from(&task.folder);
        if let Some(why) = project::refusal_for_first_task(app, &folder_path) {
            task.state = TaskState::Failed;
            task.reason = Some(why);
            save(app, &task);
            return;
        }
        name = folder_name(&folder_path);
        task.state = TaskState::Sending;
        save(app, &task);
    }
    // Gate dropped before attach: `machine_sandbox::queue` may call `change` → `machine_changed` re-entrantly; state is
    // already `Sending`, so the inner `try_send` does not attach twice.
    let attach_result = project::attach_at_path(app, &folder_path, &name);
    let record = machine_sandbox::status(app);
    let _gate = GATE.lock().unwrap();
    let Some(mut task) = read(app) else {
        return;
    };
    if task.state != TaskState::Sending {
        return;
    }
    if let Err(reason) = attach_result {
        task.state = TaskState::Failed;
        task.reason = Some(reason);
        save(app, &task);
        return;
    }
    drop(_gate);
    maybe_open(app, &record, &task);
}

fn maybe_open(app: &AppHandle, record: &Record, task: &StoredTask) {
    let folder_ready = folder_ready_in(record, &task.folder);
    if task_step(task.state, &record.standing, folder_ready, task.opened_at) != TaskStep::Open {
        return;
    }
    let wanted = PathBuf::from(&task.folder);
    let Some(folder) = record
        .folders
        .iter()
        .find(|folder| project::folder_paths_same(Path::new(&folder.path), &wanted, cfg!(windows)))
    else {
        return;
    };
    let Some(sandbox_id) = record.sandbox_id.as_deref() else {
        return;
    };
    let Some(path) = workspace_path(sandbox_id, &folder.name, task) else {
        return;
    };
    let _gate = GATE.lock().unwrap();
    let Some(mut opened) = read(app) else {
        return;
    };
    if opened.id != task.id || opened.opened_at.is_some() {
        return;
    }
    opened.opened_at = Some(now());
    save(app, &opened);
    drop(_gate);
    windows::show_workspace_at(app, Some(&path));
    if !reader_here(app) {
        notice::show(
            app,
            NoticeArgs {
                key: "first-task".to_string(),
                kind: NoticeKind::Finished,
                title: "Your first task started".to_string(),
                body: Some("Intentic opened your workspace and sent it to an agent.".to_string()),
                path: Some(path.clone()),
                silent: false,
            },
        );
    }
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
    app.webview_windows().iter().any(|(label, window)| {
        (label == windows::HOME || label.starts_with(FILES)) && window.is_focused().unwrap_or(false)
    })
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
        };
        let path = workspace_path("sb1", "work", &task).expect("path");
        assert!(path.contains("task="));
        assert!(path.contains("sandbox=sb1"));
        assert!(path.contains("project=work"));
    }

    #[test]
    fn task_step_decisions() {
        assert_eq!(
            task_step(TaskState::Queued, &Standing::Ready, false, None),
            TaskStep::Attach
        );
        assert_eq!(
            task_step(TaskState::Queued, &Standing::SignedOut, false, None),
            TaskStep::Nothing
        );
        assert_eq!(
            task_step(TaskState::Sending, &Standing::Ready, true, None),
            TaskStep::Open
        );
        assert_eq!(
            task_step(TaskState::Sending, &Standing::Ready, false, None),
            TaskStep::Nothing
        );
        assert_eq!(
            task_step(TaskState::Sending, &Standing::Ready, true, Some(1)),
            TaskStep::Nothing
        );
        assert_eq!(
            task_step(TaskState::Sent, &Standing::Ready, true, None),
            TaskStep::Nothing
        );
    }
}
