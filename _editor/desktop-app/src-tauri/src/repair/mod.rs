//! REPAIR: an agent in this app on this PC, outside every sandbox (localHost.ts `LocalRepairHost`).

mod scrub;
mod tools;

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use uuid::Uuid;

use crate::account::{platform_get, platform_post, Answered};
use crate::setup_link::RepairLink;
use crate::windows::HOME;

const EVENT: &str = "desktop://repair";
const STORE: &str = "repair-session.json";
const MAX_MODEL_TURNS: u8 = 8;
const DECLINED: &str = "The reader declined.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelMessage {
    role: String,
    #[serde(default)]
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ModelToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolRow {
    name: String,
    state: String,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    id: String,
    role: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<ToolRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    state: String,
    messages: Vec<Message>,
    history: Vec<ModelMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context: Option<Value>,
    #[serde(default)]
    model_turns: u8,
    #[serde(default, skip)]
    batch: Option<ActiveBatch>,
    #[serde(default, skip)]
    pending: Option<PendingApproval>,
    /// When the platform's daily allowance for Repair resets (its own `resetsAt`), set while it is spent: the view says
    /// so in the reader's own time, and the checks and fixes go on without the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    allowance_resets_at: Option<String>,
}

#[derive(Debug, Clone)]
struct ActiveBatch {
    calls: Vec<ModelToolCall>,
    index: usize,
}

#[derive(Debug, Clone)]
struct PendingApproval {
    approval_id: String,
    message_id: String,
    call: ModelToolCall,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn home_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(HOME)
        .ok_or_else(|| "Repair needs the main window.".into())
}

/// The reader's home folder: USERPROFILE first, as the rest of the app and `ic` read it (`%USERPROFILE%\.intentic`),
/// then HOME for Linux and macOS.
pub(crate) fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn home_dir() -> Option<PathBuf> {
    user_home().map(|home| home.join(".intentic"))
}

fn load_disk() -> Option<Session> {
    let path = home_dir()?.join(STORE);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_disk(session: &Session) {
    if let Some(dir) = home_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(
            dir.join(STORE),
            serde_json::to_string(session).unwrap_or_default(),
        );
    }
}

fn home_path() -> String {
    user_home()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/home/user".into())
}

fn emit(app: &AppHandle, session: &Session) {
    let _ = app.emit(EVENT, json!(session));
}

fn with_session<F>(app: &AppHandle, f: F)
where
    F: FnOnce(&mut Session),
{
    let mut guard = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
    if guard.is_none() {
        *guard = load_disk().or_else(|| {
            Some(Session {
                state: "idle".into(),
                messages: Vec::new(),
                history: Vec::new(),
                context: None,
                model_turns: 0,
                batch: None,
                pending: None,
                allowance_resets_at: None,
            })
        });
    }
    if let Some(session) = guard.as_mut() {
        f(session);
        save_disk(session);
        emit(app, session);
    }
}

fn tool_summary(name: &str, args: &Value) -> String {
    let slug = args.get("slug").and_then(Value::as_str);
    match name {
        "doctor" => slug
            .map(|slug| format!("Check sandbox {slug}"))
            .unwrap_or_else(|| "Check every sandbox on this PC".into()),
        "engine_status" => "Check the container engine on this PC".into(),
        "pc_check" => "Check this PC for Docker and disk issues".into(),
        "sandbox_list" => "List every sandbox on this PC".into(),
        "sandbox_logs" => slug
            .map(|slug| format!("Read recent logs for sandbox {slug}"))
            .unwrap_or_else(|| "Read sandbox logs".into()),
        "setup_log" => "Read the last PC setup transcript".into(),
        "fix" => {
            if let Some(description) = args
                .get("description")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                return description.to_string();
            }
            slug.map(|slug| format!("Apply the fix doctor suggested for {slug}"))
                .unwrap_or_else(|| "Apply the fix doctor suggested".into())
        }
        "engine_start" => "Start the container engine".into(),
        "sandbox_restart" => slug
            .map(|slug| format!("Restart sandbox {slug}"))
            .unwrap_or_else(|| "Restart a sandbox".into()),
        "sandbox_rollback" => slug
            .map(|slug| format!("Roll sandbox {slug} back to its previous image"))
            .unwrap_or_else(|| "Roll a sandbox back".into()),
        other => format!("Run {other}"),
    }
}

fn push_tool_message(
    session: &mut Session,
    name: &str,
    state: &str,
    args: &Value,
    detail: Option<String>,
    approval_id: Option<String>,
) -> String {
    let id = Uuid::new_v4().to_string();
    let summary = tool_summary(name, args);
    session.messages.push(Message {
        id: id.clone(),
        role: "tool".into(),
        text: summary.clone(),
        tool: Some(ToolRow {
            name: name.into(),
            state: state.into(),
            summary,
            detail,
            approval_id,
        }),
    });
    id
}

fn set_tool_row(session: &mut Session, message_id: &str, state: &str, detail: Option<String>) {
    if let Some(row) = session.messages.iter_mut().find(|row| row.id == message_id) {
        if let Some(tool) = row.tool.as_mut() {
            tool.state = state.into();
            if let Some(text) = detail {
                tool.detail = Some(text.clone());
                row.text = tool.summary.clone();
            }
        }
    }
}

fn history_payload(history: &[ModelMessage]) -> Vec<Value> {
    history
        .iter()
        .map(|message| {
            if message.role == "assistant" {
                let mut row = json!({ "role": "assistant", "content": message.content });
                if let Some(calls) = &message.tool_calls {
                    row["toolCalls"] = json!(calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "name": call.name,
                                "arguments": call.arguments,
                            })
                        })
                        .collect::<Vec<_>>());
                }
                row
            } else if message.role == "tool" {
                json!({
                    "role": "tool",
                    "toolCallId": message.tool_call_id,
                    "name": message.name,
                    "content": message.content,
                })
            } else {
                json!({ "role": "user", "content": message.content })
            }
        })
        .collect()
}

async fn run_tool(app: &AppHandle, name: &str, args: &Value, home: &str) -> Result<String, String> {
    let app = app.clone();
    let name = name.to_string();
    let args = args.clone();
    let home = home.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        if tools::needs_approval(&name) {
            tools::run_mutating(&app, &name, &args, &home)
        } else {
            tools::run_read_only(&app, &name, &args, &home)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

fn parse_args(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or(json!({}))
}

fn push_doctor_checks(offers: &mut Vec<(String, String, String)>, slug: &str, report: &Value) {
    let Some(checks) = report.get("checks").and_then(Value::as_array) else {
        return;
    };
    for check in checks {
        let fix = check.get("fix").and_then(Value::as_str);
        if fix != Some("consent") {
            continue;
        }
        let Some(code) = check.get("id").and_then(Value::as_str) else {
            continue;
        };
        let description = check
            .get("remedy")
            .and_then(Value::as_str)
            .or_else(|| check.get("label").and_then(Value::as_str))
            .unwrap_or(code);
        offers.push((slug.to_string(), code.to_string(), description.to_string()));
    }
}

fn fixes_from_doctor(raw: &str) -> Vec<(String, String, String)> {
    let mut offers = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        if let Some(array) = value.as_array() {
            for row in array {
                if let (Some(slug), Some(report)) =
                    (row.get("slug").and_then(Value::as_str), row.get("report"))
                {
                    push_doctor_checks(&mut offers, slug, report);
                }
            }
        } else if let (Some(slug), Some(report)) = (
            value.get("slug").and_then(Value::as_str),
            value.get("report"),
        ) {
            push_doctor_checks(&mut offers, slug, report);
        } else if value.get("checks").is_some() {
            push_doctor_checks(&mut offers, "", &value);
        }
    } else {
        for line in raw.lines() {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                if let (Some(slug), Some(report)) = (
                    value.get("slug").and_then(Value::as_str),
                    value.get("report"),
                ) {
                    push_doctor_checks(&mut offers, slug, report);
                }
            }
        }
    }
    offers
}

async fn bootstrap(app: &AppHandle, slug: Option<&str>) -> Result<(), String> {
    let home = home_path();
    let mut doctor_args = json!({});
    if let Some(slug) = slug {
        doctor_args["slug"] = json!(slug);
    }
    with_session(app, |session| {
        session.state = "thinking".into();
        session.history.clear();
        session.messages.clear();
        session.batch = None;
        session.pending = None;
        session.model_turns = 0;
    });

    let doctor_row = {
        let mut id = String::new();
        with_session(app, |session| {
            id = push_tool_message(session, "doctor", "running", &doctor_args, None, None);
        });
        id
    };
    let doctor = run_tool(app, "doctor", &doctor_args, &home).await;
    with_session(app, |session| {
        let detail = doctor.as_ref().ok().cloned();
        let state = if doctor.is_ok() { "done" } else { "failed" };
        set_tool_row(session, &doctor_row, state, detail);
    });

    let engine_row = {
        let mut id = String::new();
        with_session(app, |session| {
            id = push_tool_message(session, "engine_status", "running", &json!({}), None, None);
        });
        id
    };
    let engine = run_tool(app, "engine_status", &json!({}), &home).await;
    with_session(app, |session| {
        let detail = engine.as_ref().ok().cloned();
        let state = if engine.is_ok() { "done" } else { "failed" };
        set_tool_row(session, &engine_row, state, detail);
        session.history.push(ModelMessage {
            role: "assistant".into(),
            content: String::new(),
            tool_calls: Some(vec![
                ModelToolCall {
                    id: "boot-doctor".into(),
                    name: "doctor".into(),
                    arguments: serde_json::to_string(&doctor_args).unwrap_or_else(|_| "{}".into()),
                },
                ModelToolCall {
                    id: "boot-engine".into(),
                    name: "engine_status".into(),
                    arguments: "{}".into(),
                },
            ]),
            tool_call_id: None,
            name: None,
        });
        session.history.push(ModelMessage {
            role: "tool".into(),
            content: doctor.clone().unwrap_or_else(|error| error),
            tool_call_id: Some("boot-doctor".into()),
            name: Some("doctor".into()),
            tool_calls: None,
        });
        session.history.push(ModelMessage {
            role: "tool".into(),
            content: engine.clone().unwrap_or_else(|error| error),
            tool_call_id: Some("boot-engine".into()),
            name: Some("engine_status".into()),
            tool_calls: None,
        });
    });

    if !signed_in(app).await {
        let doctor_text = doctor.unwrap_or_default();
        let offers = fixes_from_doctor(&doctor_text);
        with_session(app, |session| {
            for (slug, code, description) in offers {
                let args = json!({ "slug": slug, "code": code, "description": description });
                let approval_id = Uuid::new_v4().to_string();
                push_tool_message(
                    session,
                    "fix",
                    "needsApproval",
                    &args,
                    None,
                    Some(approval_id),
                );
            }
            session.state = "signedOut".into();
        });
    } else {
        with_session(app, |session| session.state = "idle".into());
    }
    Ok(())
}

async fn signed_in(app: &AppHandle) -> bool {
    let Ok(window) = home_window(app) else {
        return false;
    };
    matches!(
        platform_get(app, &window, "/api/auth/get-session").await,
        Ok(Answered::Json { status: 200, .. })
    )
}

fn session_busy(state: &str) -> bool {
    state == "thinking" || state == "waiting"
}

async fn model_turn(app: &AppHandle, session: &Session) -> Result<Value, String> {
    let window = home_window(app)?;
    let body = json!({
        "messages": history_payload(&session.history),
        "context": session.context,
    });
    match platform_post(app, &window, "/api/repair/turn", &body).await? {
        Answered::SignedOut => Err("signedOut".into()),
        Answered::Json { status, body } => {
            if status == 429 {
                let resets = body
                    .get("repair")
                    .and_then(|repair| repair.get("resetsAt"))
                    .and_then(Value::as_str)
                    .unwrap_or("midnight UTC");
                Err(format!("allowance:{resets}"))
            } else if status == 502 || status == 503 {
                Err("offline".into())
            } else if (200..300).contains(&status) {
                Ok(body)
            } else {
                Err(format!("upstream:{status}"))
            }
        }
    }
}

/// Returns `true` when every call in the batch has a result and the model should run again.
async fn finish_batch(app: &AppHandle) -> Result<bool, String> {
    loop {
        let snapshot = SESSION
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or_else(|| "no session".to_string())?;
        if snapshot.pending.is_some() {
            with_session(app, |session| session.state = "waiting".into());
            return Ok(false);
        }
        let Some(batch) = snapshot.batch.clone() else {
            return Ok(false);
        };
        if batch.index >= batch.calls.len() {
            with_session(app, |session| session.batch = None);
            return Ok(true);
        }
        let call = batch.calls[batch.index].clone();
        let args = parse_args(&call.arguments);
        let home = home_path();
        if tools::needs_approval(&call.name) {
            let approval_id = Uuid::new_v4().to_string();
            let message_id = {
                let mut id = String::new();
                with_session(app, |session| {
                    id = push_tool_message(
                        session,
                        &call.name,
                        "needsApproval",
                        &args,
                        None,
                        Some(approval_id.clone()),
                    );
                    session.pending = Some(PendingApproval {
                        approval_id,
                        message_id: id.clone(),
                        call: call.clone(),
                    });
                    session.state = "waiting".into();
                });
                id
            };
            let _ = message_id;
            return Ok(false);
        }
        let message_id = {
            let mut id = String::new();
            with_session(app, |session| {
                id = push_tool_message(session, &call.name, "running", &args, None, None);
            });
            id
        };
        let output = run_tool(app, &call.name, &args, &home).await;
        with_session(app, |session| {
            let detail = output.as_ref().ok().cloned();
            let state = if output.is_ok() { "done" } else { "failed" };
            set_tool_row(session, &message_id, state, detail);
            session.history.push(ModelMessage {
                role: "tool".into(),
                content: output.clone().unwrap_or_else(|error| error),
                tool_call_id: Some(call.id.clone()),
                name: Some(call.name.clone()),
                tool_calls: None,
            });
            if let Some(batch) = session.batch.as_mut() {
                batch.index += 1;
            }
        });
    }
}

async fn drive_model(app: &AppHandle) -> Result<(), String> {
    loop {
        let snapshot = SESSION
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or_else(|| "no session".to_string())?;
        if snapshot.model_turns >= MAX_MODEL_TURNS {
            with_session(app, |session| {
                session.messages.push(Message {
                    id: Uuid::new_v4().to_string(),
                    role: "assistant".into(),
                    text: "Repair stopped after 8 steps. Ask again to carry on.".into(),
                    tool: None,
                });
                session.state = "idle".into();
                session.model_turns = 0;
            });
            return Ok(());
        }
        with_session(app, |session| session.state = "thinking".into());
        let answer = model_turn(app, &snapshot).await;
        match answer {
            Ok(body) => {
                let content = body["message"]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let tool_calls: Vec<ModelToolCall> = body["message"]["toolCalls"]
                    .as_array()
                    .map(|calls| {
                        calls
                            .iter()
                            .filter_map(|call| {
                                Some(ModelToolCall {
                                    id: call["id"].as_str()?.to_string(),
                                    name: call["name"].as_str()?.to_string(),
                                    arguments: call["arguments"].as_str()?.to_string(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let has_tools = !tool_calls.is_empty();
                with_session(app, |session| {
                    session.model_turns += 1;
                    if !content.is_empty() {
                        session.messages.push(Message {
                            id: Uuid::new_v4().to_string(),
                            role: "assistant".into(),
                            text: content.clone(),
                            tool: None,
                        });
                    }
                    session.history.push(ModelMessage {
                        role: "assistant".into(),
                        content,
                        tool_calls: if has_tools {
                            Some(tool_calls.clone())
                        } else {
                            None
                        },
                        tool_call_id: None,
                        name: None,
                    });
                    if has_tools {
                        session.batch = Some(ActiveBatch {
                            calls: tool_calls,
                            index: 0,
                        });
                    } else {
                        session.state = "idle".into();
                    }
                });
                if !has_tools {
                    return Ok(());
                }
                while finish_batch(app).await? {}
            }
            Err(code) if code == "signedOut" => {
                with_session(app, |session| session.state = "signedOut".into());
                return Ok(());
            }
            Err(code) if code.starts_with("allowance:") => {
                let resets = code.trim_start_matches("allowance:").to_string();
                with_session(app, |session| {
                    session.allowance_resets_at = Some(resets);
                    session.state = "idle".into();
                });
                return Ok(());
            }
            Err(code) if code == "offline" => {
                with_session(app, |session| session.state = "offline".into());
                return Ok(());
            }
            Err(error) => {
                with_session(app, |session| {
                    session.state = "offline".into();
                    session.messages.push(Message {
                        id: Uuid::new_v4().to_string(),
                        role: "assistant".into(),
                        text: format!("Repair could not reach the model ({error})."),
                        tool: None,
                    });
                });
                return Ok(());
            }
        }
    }
}

#[tauri::command]
pub fn repair_state(_app: AppHandle) -> Value {
    let guard = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(session) = guard.as_ref() {
        return json!(session);
    }
    if let Some(session) = load_disk() {
        return json!(session);
    }
    json!({ "state": "idle", "messages": [], "history": [] })
}

#[tauri::command]
pub async fn repair_start(app: AppHandle, context: Option<Value>) -> Result<(), String> {
    {
        let mut guard = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_none() {
            *guard = Some(Session {
                state: "idle".into(),
                messages: Vec::new(),
                history: Vec::new(),
                context: context.clone(),
                model_turns: 0,
                batch: None,
                pending: None,
                allowance_resets_at: None,
            });
        } else if let Some(session) = guard.as_mut() {
            session.context = context.clone();
        }
    }
    let needs_bootstrap = SESSION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .is_none_or(|session| session.messages.is_empty() && session.history.is_empty());
    if !needs_bootstrap {
        return Ok(());
    }
    let slug = context
        .as_ref()
        .and_then(|value| value.get("slug"))
        .and_then(Value::as_str)
        .map(str::to_string);
    bootstrap(&app, slug.as_deref()).await
}

#[tauri::command]
pub async fn repair_send(app: AppHandle, text: String) -> Result<(), String> {
    let busy = SESSION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .map(|session| session_busy(&session.state))
        .unwrap_or(false);
    if busy {
        return Err("Repair is still working on the last message".into());
    }
    if !signed_in(&app).await {
        with_session(&app, |session| session.state = "signedOut".into());
        return Ok(());
    }
    with_session(&app, |session| {
        session.model_turns = 0;
        session.batch = None;
        session.pending = None;
        // A new message is a new try: the note about a spent allowance stands only until the platform says so again.
        session.allowance_resets_at = None;
        session.messages.push(Message {
            id: Uuid::new_v4().to_string(),
            role: "user".into(),
            text: text.clone(),
            tool: None,
        });
        session.history.push(ModelMessage {
            role: "user".into(),
            content: text,
            tool_calls: None,
            tool_call_id: None,
            name: None,
        });
    });
    drive_model(&app).await
}

#[tauri::command]
pub async fn repair_answer(app: AppHandle, approval_id: String, allow: bool) -> Result<(), String> {
    let pending = {
        let mut guard = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(session) = guard.as_mut() else {
            return Ok(());
        };
        let Some(pending) = session.pending.take() else {
            return Ok(());
        };
        if pending.approval_id != approval_id {
            session.pending = Some(pending);
            return Ok(());
        }
        pending
    };
    let args = parse_args(&pending.call.arguments);
    let home = home_path();
    let standalone = SESSION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .and_then(|session| session.batch.as_ref())
        .is_none();
    if !allow {
        with_session(&app, |session| {
            set_tool_row(
                session,
                &pending.message_id,
                "refused",
                Some(DECLINED.into()),
            );
            if !standalone {
                session.history.push(ModelMessage {
                    role: "tool".into(),
                    content: DECLINED.into(),
                    tool_call_id: Some(pending.call.id.clone()),
                    name: Some(pending.call.name.clone()),
                    tool_calls: None,
                });
                if let Some(batch) = session.batch.as_mut() {
                    batch.index += 1;
                }
                session.state = "thinking".into();
            } else {
                session.state = "signedOut".into();
            }
        });
        return if standalone {
            Ok(())
        } else {
            finish_batch(&app).await.map(|_| ())
        };
    }
    with_session(&app, |session| {
        set_tool_row(session, &pending.message_id, "running", None);
        session.state = "thinking".into();
    });
    let output = run_tool(&app, &pending.call.name, &args, &home).await;
    with_session(&app, |session| {
        let detail = output.as_ref().ok().cloned();
        let state = if output.is_ok() { "done" } else { "failed" };
        set_tool_row(session, &pending.message_id, state, detail);
        if !standalone {
            session.history.push(ModelMessage {
                role: "tool".into(),
                content: output.clone().unwrap_or_else(|error| error),
                tool_call_id: Some(pending.call.id.clone()),
                name: Some(pending.call.name.clone()),
                tool_calls: None,
            });
            if let Some(batch) = session.batch.as_mut() {
                batch.index += 1;
            }
        } else {
            session.state = "signedOut".into();
        }
    });
    if standalone {
        Ok(())
    } else {
        finish_batch(&app).await.map(|_| ())
    }
}

#[tauri::command]
pub fn repair_reset(app: AppHandle) -> Result<(), String> {
    {
        let mut guard = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
        *guard = None;
    }
    if let Some(dir) = home_dir() {
        let _ = std::fs::remove_file(dir.join(STORE));
    }
    emit(
        &app,
        &Session {
            state: "idle".into(),
            messages: Vec::new(),
            history: Vec::new(),
            context: None,
            model_turns: 0,
            batch: None,
            pending: None,
            allowance_resets_at: None,
        },
    );
    Ok(())
}

pub fn on_link(app: &AppHandle, link: RepairLink) {
    let mut route = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in [
        ("slug", &link.slug),
        ("from", &link.from),
        ("reason", &link.reason),
    ] {
        if let Some(value) = value {
            route.append_pair(key, value);
        }
    }
    let query = route.finish();
    let target = if query.is_empty() {
        "/repair".to_string()
    } else {
        format!("/repair?{query}")
    };
    crate::windows::show_home_route(app, &target);
}

#[cfg(test)]
mod tests {
    use super::tools;

    #[test]
    fn mutating_tools_are_named() {
        assert!(tools::needs_approval("fix"));
        assert!(!tools::needs_approval("doctor"));
    }
}
