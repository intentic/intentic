//! THE APP'S PROCESSES, ONE LIST FOR BOTH FACES (2026-10-26).
//!
//! Every process that runs on this computer or for it (a sign-in in the browser, this PC's own setup, a sandbox's setup,
//! a folder's, a Docker start, a recreate, a fix, a sync, a repair) is one report in one list, which both faces draw where
//! the reader already is: a tile in the rail and a page in the face's own place (the web's shell/rail/processes/). The
//! reader is never moved to a process (windows/present.rs); what a run needs of them is asked on its tile and its page,
//! answered there, and said by the system's notification while nobody is looking ([`attend`]).
//!
//! The shape is the web's `processReport.ts`, held to the same rules here: a report out of shape is nothing, a field out
//! of shape is dropped. Who writes it: the main window's page for the runs it drives ([`process_report`], src/processes.ts),
//! this app for its own (auth.rs, folder_setup.rs, first_task.rs, repair), and the workspace's page for the runs only it
//! holds (`intentic://process`, a machine of ours or a connected machine). Who hears it: the workspace's page by the
//! `intentic-processes` event, every local window by `desktop://processes`. An answer comes back from either face
//! ([`act`]) and goes to the run's owner.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::windows::present::Press;
use crate::windows::{HOME, WORKSPACE};

/// What every local window hears the whole list as.
pub const EVENT: &str = "desktop://processes";
/// What the main window's page hears an answer to one of its runs as (src/processes.ts).
pub const ACT_EVENT: &str = "desktop://process-act";
/// The event the workspace's page hears the list as (processReport.ts `DESKTOP_PROCESSES_EVENT`).
const WORKSPACE_EVENT: &str = "intentic-processes";
/// The event the workspace's page hears an answer to one of its own runs as (`DESKTOP_PROCESS_ACT_EVENT`).
const WORKSPACE_ACT_EVENT: &str = "intentic-process-act";

pub const KINDS: &[&str] = &[
    "sandbox-setup",
    "pc-setup",
    "docker",
    "folder-setup",
    "sign-in",
    "recreate",
    "fix",
    "sync",
    "repair",
    "engine-move",
    "first-task",
];
pub const STATES: &[&str] = &["running", "waiting", "failed", "stopped", "done"];
pub const WAITS: &[&str] = &[
    "consent", "restart", "signOut", "pcSetup", "browser", "answer",
];
pub const ACTIONS: &[&str] = &[
    "consent",
    "stop",
    "retry",
    "dismiss",
    "restart-now",
    "restart-in-10",
    "restart-later",
    "sign-out",
    "use-hosted",
    "fresh-code",
    "open",
    "sign-in-again",
    "cancel",
    "allow",
    "deny",
];

/// One thing a run asks of the reader: a requirement to consent to, an approval to give.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNeed {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<String>,
}

/// One process, as both faces draw it (the web's processReport.ts `ProcessReport`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessReport {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_for: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub needs: Vec<ProcessNeed>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<f64>,
}

impl ProcessReport {
    /// A report of this app's own, with nothing said yet beyond what it is and how it stands.
    pub fn of(kind: &str, about: &str, state: &str) -> Self {
        ProcessReport {
            id: format!("{kind}:{about}"),
            kind: kind.to_string(),
            state: state.to_string(),
            origin: "app".to_string(),
            at: Some(now_ms()),
            ..ProcessReport::default()
        }
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as f64)
        .unwrap_or(0.0)
}

/* THE SHAPE, held as processReport.ts holds it. */

/// `<kind>:<what it is about>`, no whitespace, as processReport.ts's `ID`.
pub fn is_id(id: &str) -> bool {
    let Some((kind, rest)) = id.split_once(':') else {
        return false;
    };
    let rest_len = rest.chars().count();
    kind.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && kind.chars().all(|c| c.is_ascii_lowercase() || c == '-')
        && (1..=400).contains(&rest_len)
        && !rest.chars().any(char::is_whitespace)
}

/// A need's id, as processReport.ts's `ACTION_ID`.
pub fn is_need_id(id: &str) -> bool {
    (1..=80).contains(&id.chars().count())
        && id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == ':' || c == '-')
}

pub fn is_action(act: &str) -> bool {
    ACTIONS.contains(&act)
}

/// Words, trimmed, within `max` characters, or nothing.
fn text(raw: &Value, key: &str, max: usize) -> Option<String> {
    let value = raw.get(key)?.as_str()?.trim();
    (1..=max)
        .contains(&value.chars().count())
        .then(|| value.to_string())
}

fn clock(raw: &Value, key: &str) -> Option<f64> {
    raw.get(key)?
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn actions_of(raw: &Value, key: &str) -> Vec<String> {
    raw.get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|act| is_action(act))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn need_of(raw: &Value) -> Option<ProcessNeed> {
    let id = raw.get("id")?.as_str()?;
    let label = raw.get("label")?.as_str()?.trim();
    if !is_need_id(id) || !(1..=200).contains(&label.chars().count()) {
        return None;
    }
    Some(ProcessNeed {
        id: id.to_string(),
        label: label.to_string(),
        detail: text(raw, "detail", 600),
        actions: actions_of(raw, "actions"),
    })
}

/// A report read back from what a page sent, or nothing: as processReport.ts's `ProcessReportSchema`.
pub fn read(raw: &Value) -> Option<ProcessReport> {
    let id = raw.get("id")?.as_str()?;
    let kind = raw.get("kind")?.as_str()?;
    let state = raw.get("state")?.as_str()?;
    if !is_id(id) || !KINDS.contains(&kind) || !STATES.contains(&state) {
        return None;
    }
    let origin = match raw.get("origin").and_then(Value::as_str) {
        Some("workspace") => "workspace",
        _ => "app",
    };
    Some(ProcessReport {
        id: id.to_string(),
        kind: kind.to_string(),
        state: state.to_string(),
        origin: origin.to_string(),
        subject: text(raw, "subject", 120),
        sandbox_id: text(raw, "sandboxId", 80),
        folder: text(raw, "folder", 1000),
        percent: raw
            .get("percent")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 100.0)),
        position: text(raw, "position", 80),
        remaining: text(raw, "remaining", 80),
        step: text(raw, "step", 80),
        line: text(raw, "line", 300),
        waiting_for: raw
            .get("waitingFor")
            .and_then(Value::as_str)
            .filter(|wait| WAITS.contains(wait))
            .map(str::to_string),
        failure: text(raw, "failure", 600),
        needs: raw
            .get("needs")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(need_of).collect())
            .unwrap_or_default(),
        actions: actions_of(raw, "actions"),
        started_at: clock(raw, "startedAt"),
        at: clock(raw, "at"),
    })
}

/// Whether a run asks something of the reader now (processReport.ts `processAsks`).
pub fn asks(report: &ProcessReport) -> bool {
    report.state == "failed"
        || (report.state == "waiting"
            && !matches!(
                report.waiting_for.as_deref(),
                Some("pcSetup") | Some("browser")
            ))
        || !report.needs.is_empty()
}

/// Whether it still works or waits (`processLive`).
pub fn live(report: &ProcessReport) -> bool {
    report.state == "running" || report.state == "waiting"
}

/* THE LIST. */

#[derive(Debug, Default)]
struct Book {
    /// In the order they first came.
    reports: Vec<ProcessReport>,
    /// The runs whose last report asked the reader something: a notification is put up once, as one starts asking.
    asking: HashSet<String>,
}

/// What a change to the list means for the reader's eye: the run started asking, stopped asking, or neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Turn {
    StartedAsking,
    StoppedAsking,
    Same,
}

impl Book {
    /// `report` in its place (a new one at the end), and what that changed about asking. Pure.
    fn put(&mut self, report: ProcessReport) -> Turn {
        let asking = asks(&report);
        let was = self.asking.contains(&report.id);
        if asking {
            self.asking.insert(report.id.clone());
        } else {
            self.asking.remove(&report.id);
        }
        match self.reports.iter_mut().find(|held| held.id == report.id) {
            Some(held) => *held = report,
            None => self.reports.push(report),
        }
        match (was, asking) {
            (false, true) => Turn::StartedAsking,
            (true, false) => Turn::StoppedAsking,
            _ => Turn::Same,
        }
    }

    /// The run gone; whether it was asking.
    fn take(&mut self, id: &str) -> Option<(ProcessReport, bool)> {
        let at = self.reports.iter().position(|held| held.id == id)?;
        Some((self.reports.remove(at), self.asking.remove(id)))
    }

    fn get(&self, id: &str) -> Option<&ProcessReport> {
        self.reports.iter().find(|held| held.id == id)
    }
}

/// The app's processes (lib.rs manages one).
#[derive(Default)]
pub struct Processes(Mutex<Book>);

/// Every process, in the order they came.
pub fn list(app: &AppHandle) -> Vec<ProcessReport> {
    app.state::<Processes>().0.lock().unwrap().reports.clone()
}

/// One process by id.
pub fn get(app: &AppHandle, id: &str) -> Option<ProcessReport> {
    app.state::<Processes>().0.lock().unwrap().get(id).cloned()
}

/// A run's news: kept, both faces told, and the reader's eye asked for when it starts asking something.
pub fn report(app: &AppHandle, report: ProcessReport) {
    let turn = {
        let held = app.state::<Processes>();
        let mut book = held.0.lock().unwrap();
        if book.get(&report.id) == Some(&report) {
            return;
        }
        book.put(report.clone())
    };
    match turn {
        Turn::StartedAsking => attend(app, &report),
        Turn::StoppedAsking => crate::notice::withdraw(app, &notice_key(&report.id)),
        Turn::Same => {}
    }
    broadcast(app);
}

/// A run gone from the list (ended and seen, or given up).
pub fn clear(app: &AppHandle, id: &str) {
    let taken = app.state::<Processes>().0.lock().unwrap().take(id);
    let Some((_, asking)) = taken else {
        return;
    };
    if asking {
        crate::notice::withdraw(app, &notice_key(id));
    }
    broadcast(app);
}

/// Every run of `kind` whose id `keep` does not name, gone: an owner that reports its whole set at once.
pub fn keep_only(app: &AppHandle, kind: &str, keep: &[String]) {
    let gone: Vec<String> = list(app)
        .into_iter()
        .filter(|held| held.kind == kind && held.origin == "app" && !keep.contains(&held.id))
        .map(|held| held.id)
        .collect();
    for id in gone {
        clear(app, &id);
    }
}

/// A run only the workspace's page holds: kept as the workspace's, never over a run of this app's under the same id.
pub fn report_from_workspace(app: &AppHandle, mut told: ProcessReport) {
    told.origin = "workspace".to_string();
    if get(app, &told.id).is_some_and(|held| held.origin == "app") {
        return;
    }
    report(app, told);
}

/// The workspace's run gone; a run of this app's is not the page's to clear.
pub fn clear_from_workspace(app: &AppHandle, id: &str) {
    if get(app, id).is_some_and(|held| held.origin == "workspace") {
        clear(app, id);
    }
}

/// The workspace's page started listening: what it held before (a page before a reload) is forgotten, since the page
/// tells its runs again as it finds them, and it hears the whole list at once.
pub fn hello(app: &AppHandle) {
    let stale: Vec<String> = list(app)
        .into_iter()
        .filter(|held| held.origin == "workspace")
        .map(|held| held.id)
        .collect();
    for id in stale {
        clear(app, &id);
    }
    tell_workspace(app);
}

/* TELLING BOTH FACES. */

fn announcement(event: &str, detail: &Value) -> String {
    format!("window.dispatchEvent(new CustomEvent('{event}', {{ detail: {detail} }}));")
}

fn workspace_script(reports: &[ProcessReport]) -> String {
    announcement(
        WORKSPACE_EVENT,
        &serde_json::json!({ "processes": reports }),
    )
}

fn tell_workspace(app: &AppHandle) {
    let Some(face) = crate::frame::face(app, WORKSPACE) else {
        return;
    };
    let _ = face.eval(workspace_script(&list(app)));
}

fn broadcast(app: &AppHandle) {
    tell_workspace(app);
    let _ = app.emit(EVENT, list(app));
    keep_heartbeat(app);
}

/* THE HEARTBEAT: a workspace page loaded after the last change (a reload, a face built since) hears the list again
 * within a few seconds while anything runs, even if it is from before `hello`. */
const HEARTBEAT_EVERY: Duration = Duration::from_secs(5);
static BEATING: AtomicBool = AtomicBool::new(false);

/// Whether the list is worth repeating: anything in it still works or waits. Pure.
fn heartbeat_due(reports: &[ProcessReport]) -> bool {
    reports.iter().any(live)
}

fn keep_heartbeat(app: &AppHandle) {
    if BEATING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(HEARTBEAT_EVERY);
        if heartbeat_due(&list(&app)) {
            tell_workspace(&app);
        }
    });
}

/* THE READER'S EYE: asked for, never taken. */

/// What a run that starts asking does for the reader's eye, by where the app stands on screen. Pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attention {
    /// They are looking at the app: its tile's mark says it.
    Nothing,
    /// On screen but not in front: the taskbar's flash.
    Flash,
    /// Not on screen at all (in the tray, minimised): the system's notification, a press on which opens its page.
    Notify,
}

fn attention_for(on_screen: bool, focused: bool) -> Attention {
    match (on_screen, focused) {
        (true, true) => Attention::Nothing,
        (true, false) => Attention::Flash,
        (false, _) => Attention::Notify,
    }
}

/// Kinds that put up notifications of their own, worded for themselves (folder_setup.rs `notify`): only flashed here.
fn notices_itself(kind: &str) -> bool {
    kind == "folder-setup"
}

fn notice_key(id: &str) -> String {
    format!("process:{}", crate::folder_setup::key_of(id))
}

/// The run started asking the reader something: nothing moves (windows/present.rs). The reader looking at the app sees
/// its tile's mark; one who is not is asked to look, by the taskbar or by a notification.
pub fn attend(app: &AppHandle, report: &ProcessReport) {
    let frame = crate::frame::frame(app);
    let on_screen = frame.as_ref().is_some_and(|frame| {
        frame.is_visible().unwrap_or(false) && !frame.is_minimized().unwrap_or(false)
    }) || crate::windows::focused_page(app).is_some();
    let focused = crate::windows::focused_page(app).is_some();
    match attention_for(on_screen, focused) {
        Attention::Nothing => {}
        Attention::Flash => {
            if let Some(frame) = frame {
                let _ = frame.request_user_attention(Some(tauri::UserAttentionType::Critical));
            }
        }
        Attention::Notify if notices_itself(&report.kind) => {}
        Attention::Notify => {
            let (title, body) = notice_words(report);
            crate::notice::show(
                app,
                crate::setup_link::NoticeArgs {
                    key: notice_key(&report.id),
                    kind: crate::setup_link::NoticeKind::Asks,
                    title,
                    body,
                    path: Some(format!("{}{}", crate::notice::PROCESS, report.id)),
                    silent: false,
                },
            );
        }
    }
}

/// What the notification says: the system's own words, in the app's language (English, as the tray and every other
/// notification of the app's own). Pure.
fn notice_words(report: &ProcessReport) -> (String, Option<String>) {
    let subject = report
        .subject
        .clone()
        .unwrap_or_else(|| "Your sandbox".to_string());
    let title = match (report.kind.as_str(), report.state.as_str()) {
        ("sign-in", _) => "Finish signing in to Intentic".to_string(),
        ("pc-setup", "failed") => "This PC's setup stopped".to_string(),
        ("pc-setup", _) => "Setting up this PC needs you".to_string(),
        ("docker", _) => "Docker needs you".to_string(),
        ("repair", _) => "Repair needs your OK".to_string(),
        (_, "failed") => format!("{subject} stopped"),
        _ => format!("{subject} needs you"),
    };
    let body = match report.waiting_for.as_deref() {
        _ if report.state == "failed" => report.failure.clone(),
        Some("restart") => Some("Windows has to restart before it can carry on.".to_string()),
        Some("signOut") => {
            Some("Windows has to sign you out and back in before it can carry on.".to_string())
        }
        Some("consent") => Some("It needs your OK for a few changes to this computer.".to_string()),
        _ => report.line.clone(),
    };
    let body = body.map(|body| body.chars().take(200).collect::<String>());
    (title, body)
}

/* THE READER'S ANSWER. */

/// Who answers a run's act. Pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Owner {
    /// The workspace's page, which runs it.
    Workspace,
    /// This app itself (auth.rs, folder_setup.rs, first_task.rs, repair).
    App,
    /// The main window's page, which runs it (src/processes.ts).
    MainWindow,
}

fn owner_of(report: &ProcessReport) -> Owner {
    if report.origin == "workspace" {
        return Owner::Workspace;
    }
    match report.kind.as_str() {
        "sign-in" | "folder-setup" | "first-task" | "repair" => Owner::App,
        _ => Owner::MainWindow,
    }
}

/// Where a finished run's Open goes in the workspace, for a run that made a sandbox. Pure.
fn opened_at(report: &ProcessReport) -> Option<String> {
    let id = report.sandbox_id.as_deref()?;
    let id: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
    Some(format!("/?sandbox={id}"))
}

/// The reader's answer to a run, from whichever face drew it: given to the run's owner. A run that has ended and is
/// dismissed leaves the list here, whoever owns it.
pub fn act(app: &AppHandle, id: &str, act: &str, need: Option<&str>) {
    if !is_action(act) {
        return;
    }
    let Some(held) = get(app, id) else {
        return;
    };
    match owner_of(&held) {
        Owner::Workspace => {
            if let Some(face) = crate::frame::face(app, WORKSPACE) {
                let detail = serde_json::json!({ "id": id, "act": act, "need": need });
                let _ = face.eval(announcement(WORKSPACE_ACT_EVENT, &detail));
            }
        }
        Owner::App => act_here(app, &held, act, need),
        // A finished sandbox's Open is the reader's press naming it: the workspace on it, whichever face asked.
        Owner::MainWindow if act == "open" && opened_at(&held).is_some() => {
            crate::windows::show_workspace_at(
                app,
                Press::by(crate::windows::present::Asked::Page),
                opened_at(&held).as_deref(),
            );
        }
        Owner::MainWindow => {
            let detail = serde_json::json!({ "id": id, "act": act, "need": need });
            match crate::frame::face(app, HOME) {
                Some(face) => {
                    let _ = face.emit(ACT_EVENT, detail);
                }
                None => eprintln!("intentic: {id} was answered with no main window to run it"),
            }
        }
    }
    if act == "dismiss" && !live(&held) {
        clear(app, id);
    }
}

/// An answer to one of this app's own runs. An Open the reader pressed is the one press made here: the run's owner
/// says where it goes, and this goes there (windows/present.rs).
fn act_here(app: &AppHandle, held: &ProcessReport, act: &str, need: Option<&str>) {
    let press = Press::by(crate::windows::present::Asked::Page);
    match held.kind.as_str() {
        "sign-in" => crate::auth::act(app, act),
        "folder-setup" => {
            let opens = held
                .folder
                .as_deref()
                .and_then(|folder| crate::folder_setup::act(app, folder, act));
            if let Some(path) = opens {
                crate::windows::show_workspace_at(app, press, Some(&path));
            }
        }
        "first-task" => {
            let about = held.id.split_once(':').map_or("", |(_, about)| about);
            match crate::first_task::act(app, about, act) {
                Some(crate::first_task::Opens::Device) => crate::windows::show_device(app, press),
                Some(crate::first_task::Opens::Workspace(path)) => {
                    crate::windows::show_workspace_at(app, press, Some(&path));
                }
                None => {}
            }
        }
        "repair" if crate::repair::act(app, act, need) => {
            crate::windows::show_home_route(app, press, "/repair");
        }
        _ => {}
    }
}

/// A press on a process's notification: the face the reader last used, on that process's page there. The press is the
/// reader's (notice.rs), so this is a way to the run, never the run moving anybody.
pub fn open_page(app: &AppHandle, press: Press, id: &str) {
    if !is_id(id) {
        return;
    }
    let id: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
    match app.state::<crate::state::AppState>().last_face() {
        crate::state::Face::Home => crate::windows::show_home_route(
            app,
            press,
            &format!("{}/{id}", crate::windows::PROCESS_ROUTE),
        ),
        crate::state::Face::Workspace => {
            crate::windows::show_workspace_at(app, press, Some(&format!("/home?process={id}")))
        }
    }
}

/* THE MAIN WINDOW'S AND EVERY LOCAL WINDOW'S DOOR. */

/// A run the main window's page drives, reported as it changes (src/processes.ts). Out of shape is refused, so the
/// page finds out in its console rather than drawing a tile the workspace would not.
#[tauri::command]
pub fn process_report(app: AppHandle, report: Value) -> Result<(), String> {
    let mut read = read(&report).ok_or("that is not a process report")?;
    read.origin = "app".to_string();
    self::report(&app, read);
    Ok(())
}

#[tauri::command]
pub fn process_clear(app: AppHandle, id: String) {
    if get(&app, &id).is_some_and(|held| held.origin == "app") {
        clear(&app, &id);
    }
}

/// The list as it stands, for a window's first read (the event carries every change after it).
#[tauri::command]
pub fn processes_list(app: AppHandle) -> Vec<ProcessReport> {
    list(&app)
}

/// The reader's answer, given in a local window.
#[tauri::command]
pub fn process_act(
    app: AppHandle,
    _window: Webview,
    id: String,
    act: String,
    need: Option<String>,
) {
    self::act(&app, &id, &act, need.as_deref());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> ProcessReport {
        ProcessReport {
            subject: Some("shop".into()),
            sandbox_id: Some("sbx_7".into()),
            percent: Some(40.0),
            waiting_for: Some("consent".into()),
            needs: vec![ProcessNeed {
                id: "wsl".into(),
                label: "Windows Subsystem for Linux".into(),
                ..ProcessNeed::default()
            }],
            actions: vec!["consent".into(), "stop".into()],
            ..ProcessReport::of("sandbox-setup", "sbx_7", "waiting")
        }
    }

    /// What this app sends is what the workspace's schema reads back, and what it reads is the same report.
    #[test]
    fn a_report_reads_back_as_it_was_sent() {
        let sent = setup();
        let raw = serde_json::to_value(&sent).unwrap();
        assert_eq!(raw["sandboxId"], "sbx_7");
        assert_eq!(raw["waitingFor"], "consent");
        assert!(raw.get("folder").is_none(), "absent, not null: {raw}");
        assert_eq!(read(&raw), Some(sent));
    }

    /// Out of shape is nothing; a field out of shape is dropped, as the page's schema does.
    #[test]
    fn a_report_out_of_shape_is_nothing_and_a_field_out_of_shape_is_dropped() {
        for broken in [
            serde_json::json!({ "id": "no colon", "kind": "sandbox-setup", "state": "running" }),
            serde_json::json!({ "id": "sandbox-setup:a b", "kind": "sandbox-setup", "state": "running" }),
            serde_json::json!({ "id": "sandbox-setup:x", "kind": "mystery", "state": "running" }),
            serde_json::json!({ "id": "sandbox-setup:x", "kind": "sandbox-setup", "state": "lost" }),
        ] {
            assert_eq!(read(&broken), None, "{broken}");
        }
        let read = read(&serde_json::json!({
            "id": "sandbox-setup:x", "kind": "sandbox-setup", "state": "running", "origin": "elsewhere",
            "percent": 140, "actions": ["stop", "rm -rf"], "waitingFor": "forever", "step": 7,
            "needs": [{ "id": "x" }, { "id": "wsl", "label": "  WSL  " }], "subject": "   ",
        }))
        .unwrap();
        assert_eq!(read.origin, "app");
        assert_eq!(read.percent, Some(100.0));
        assert_eq!(read.actions, vec!["stop".to_string()]);
        assert_eq!(read.waiting_for, None);
        assert_eq!(read.step, None);
        assert_eq!(read.subject, None);
        assert_eq!(read.needs.len(), 1);
        assert_eq!(read.needs[0].label, "WSL");
    }

    #[test]
    fn a_run_asks_on_a_failure_a_question_and_a_need_and_not_while_it_waits_on_this_pc_or_a_browser(
    ) {
        assert!(asks(&setup()));
        let mut waiting = setup();
        waiting.needs.clear();
        waiting.waiting_for = Some("pcSetup".into());
        assert!(!asks(&waiting));
        waiting.waiting_for = Some("browser".into());
        assert!(!asks(&waiting));
        waiting.state = "failed".into();
        assert!(asks(&waiting));
        let running = ProcessReport::of("docker", "engine", "running");
        assert!(!asks(&running));
    }

    /// A notification goes up once, as a run starts asking, and is taken down as it stops.
    #[test]
    fn the_list_says_when_a_run_starts_and_stops_asking() {
        let mut book = Book::default();
        assert_eq!(
            book.put(ProcessReport::of("sandbox-setup", "x", "running")),
            Turn::Same
        );
        let mut asking = setup();
        asking.id = "sandbox-setup:x".into();
        assert_eq!(book.put(asking.clone()), Turn::StartedAsking);
        assert_eq!(book.put(asking), Turn::Same);
        assert_eq!(
            book.put(ProcessReport::of("sandbox-setup", "x", "running")),
            Turn::StoppedAsking
        );
        assert_eq!(book.reports.len(), 1, "one run under one id");
        assert_eq!(
            book.take("sandbox-setup:x").map(|(_, asking)| asking),
            Some(false)
        );
        assert!(book.take("sandbox-setup:x").is_none());
    }

    /// The workspace hears the whole list as one event; a name the reader typed arrives as a string however it is spelled.
    #[test]
    fn the_workspace_hears_the_list_as_one_event() {
        let mut named = setup();
        named.subject = Some("my \"site\" </script>".into());
        let script = workspace_script(&[named]);
        assert!(script.starts_with(
            "window.dispatchEvent(new CustomEvent('intentic-processes', { detail: {\"processes\":["
        ));
        assert!(script.contains("my \\\"site\\\" </script>"), "{script}");
    }

    #[test]
    fn the_list_is_repeated_only_while_something_runs_or_waits() {
        assert!(!heartbeat_due(&[]));
        assert!(heartbeat_due(&[setup()]));
        assert!(!heartbeat_due(&[ProcessReport::of(
            "sandbox-setup",
            "x",
            "done"
        )]));
    }

    /// Nothing ever moves: a reader looking is told by the tile, one elsewhere on screen by the taskbar, one not on
    /// screen by a notification.
    #[test]
    fn a_run_asks_for_the_readers_eye_and_never_moves_them() {
        assert_eq!(attention_for(true, true), Attention::Nothing);
        assert_eq!(attention_for(true, false), Attention::Flash);
        assert_eq!(attention_for(false, false), Attention::Notify);
        assert_eq!(attention_for(false, true), Attention::Notify);
    }

    /// An answer goes to whoever runs the run: the workspace's page for its own, this app for its own kinds, the main
    /// window's page for the rest.
    #[test]
    fn an_answer_goes_to_the_runs_owner() {
        let mut workspace = setup();
        workspace.origin = "workspace".into();
        assert_eq!(owner_of(&workspace), Owner::Workspace);
        for kind in ["sign-in", "folder-setup", "first-task", "repair"] {
            assert_eq!(
                owner_of(&ProcessReport::of(kind, "x", "running")),
                Owner::App,
                "{kind}"
            );
        }
        for kind in [
            "sandbox-setup",
            "pc-setup",
            "docker",
            "recreate",
            "fix",
            "sync",
            "engine-move",
        ] {
            assert_eq!(
                owner_of(&ProcessReport::of(kind, "x", "running")),
                Owner::MainWindow,
                "{kind}"
            );
        }
        assert_eq!(opened_at(&setup()).as_deref(), Some("/?sandbox=sbx_7"));
    }

    #[test]
    fn ids_actions_and_needs_are_held_to_their_shapes() {
        assert!(is_id("folder-setup:3fa9c1d2e4b5"));
        assert!(!is_id("Folder:x"));
        assert!(!is_id("sign-in:"));
        assert!(is_action("restart-in-10"));
        assert!(!is_action("format-c"));
        assert!(is_need_id("approval-1"));
        assert!(!is_need_id("a b"));
    }

    #[test]
    fn a_notification_says_what_the_run_needs_in_a_line() {
        let (title, body) = notice_words(&setup());
        assert_eq!(title, "shop needs you");
        assert!(body.unwrap().contains("your OK"));
        let mut failed = setup();
        failed.state = "failed".into();
        failed.failure = Some("Docker would not start.".into());
        assert_eq!(
            notice_words(&failed),
            (
                "shop stopped".to_string(),
                Some("Docker would not start.".to_string())
            )
        );
    }
}
