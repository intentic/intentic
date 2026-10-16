use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow};

use super::ipc;
use crate::setup_link::{Roster, RosterEntry, ShellTarget};
use crate::state::AppState;

/// The destination survives the face swap: the newly mapped home/workspace window must follow it too.
fn destination() -> &'static Mutex<Option<String>> {
    static DESTINATION: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    DESTINATION.get_or_init(|| Mutex::new(None))
}

fn space_name(index: usize, sandbox: &RosterEntry) -> String {
    // A name is a label, never compositor syntax. Keep it on one line and make command separators harmless.
    let name: String = sandbox
        .name
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| {
            if matches!(c, '"' | '\\' | ';' | ',' | '[' | ']') {
                ' '
            } else {
                c
            }
        })
        .take(80)
        .collect();
    format!(
        "{index}:{}",
        if name.trim().is_empty() {
            "Sandbox"
        } else {
            name.trim()
        }
    )
}

fn named_space(roster: &Roster, number: usize) -> Option<String> {
    if number == 0 {
        return Some("0:This computer".into());
    }
    roster
        .sandboxes
        .get(number - 1)
        .map(|entry| space_name(number, entry))
}

fn quote(value: &str) -> String {
    serde_json::to_string(value).expect("IPC string")
}

fn binding(event: &Value) -> Option<usize> {
    let number = event["binding"]["command"]
        .as_str()?
        .strip_prefix("nop intentic-space ")?;
    // Exactly the configured decimal digit. A different nop is someone else's binding.
    (number.len() == 1)
        .then(|| number.parse::<usize>().ok())
        .flatten()
        .filter(|number| *number <= 9)
}

fn app_node(tree: &Value, title: &str) -> Option<i64> {
    if tree["pid"].as_u64() == Some(u64::from(std::process::id()))
        && tree["name"].as_str() == Some(title)
    {
        return tree["id"].as_i64();
    }
    ["nodes", "floating_nodes"]
        .iter()
        .filter_map(|key| tree[*key].as_array())
        .flatten()
        .find_map(|node| app_node(node, title))
}

fn move_face(title: &str, space: &str) -> bool {
    let Some(id) = ipc::request(4, "")
        .ok()
        .and_then(|tree| app_node(&tree, title))
    else {
        return false;
    };
    ipc::command(&format!("[con_id={id}] fullscreen disable; [con_id={id}] floating disable; [con_id={id}] border none; [con_id={id}] move container to workspace {}; workspace {}; [con_id={id}] focus", quote(space), quote(space))).is_ok()
}

/// Called after a face is shown; sway may learn of its surface just after Tauri returns from show().
pub(super) fn face_shown(window: &WebviewWindow) {
    if !matches!(
        window.label(),
        crate::windows::HOME | crate::windows::WORKSPACE
    ) {
        return;
    }
    let Some(space) = destination().lock().unwrap().clone() else {
        return;
    };
    let Ok(title) = window.title() else {
        return;
    };
    std::thread::spawn(move || {
        for _ in 0..20 {
            // A later keypress wins over a delayed surface from the preceding one.
            if destination().lock().unwrap().as_ref() != Some(&space) || move_face(&title, &space) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
}

fn activate(app: &AppHandle, number: usize, agents: bool, chat: bool) {
    let roster = app.state::<AppState>().roster();
    let Some(space) = named_space(&roster, number) else {
        return;
    };
    *destination().lock().unwrap() = Some(space.clone());
    // Move the face already on screen before asking Tauri to focus it: otherwise it could pull focus back to its
    // previous Space while the in-page navigation is being handed over.
    for label in [crate::windows::HOME, crate::windows::WORKSPACE] {
        if let Some(window) = app
            .get_webview_window(label)
            .filter(|w| w.is_visible().unwrap_or(false))
        {
            if let Ok(title) = window.title() {
                let _ = move_face(&title, &space);
            }
        }
    }
    // Select the destination before mapping a cold face. No process is spawned for this keypress.
    let _ = ipc::command(&format!("workspace {}", quote(&space)));
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if number == 0 {
            crate::windows::show_device(&handle);
        } else if let Some(sandbox) = roster.sandboxes.get(number - 1) {
            let path = if chat {
                format!(
                    "/chat?sandbox={}&shellChat={}",
                    sandbox.id,
                    uuid::Uuid::new_v4()
                )
            } else {
                format!(
                    "/{}?sandbox={}",
                    if agents { "agents" } else { "" },
                    sandbox.id
                )
            };
            crate::windows::show_workspace_at(&handle, Some(&path));
        }
    });
}

pub(super) fn open(app: &AppHandle, target: ShellTarget) {
    match target {
        ShellTarget::Device => activate(app, 0, false, false),
        ShellTarget::Sandbox { id, agents } => {
            let roster = app.state::<AppState>().roster();
            if let Some(index) = roster.sandboxes.iter().position(|entry| entry.id == id) {
                activate(app, index + 1, agents, false);
            }
        }
    }
}

/// Rename existing spaces in place so a sandbox window follows its sandbox across a reordered roster.
fn rename_spaces(before: &Roster, after: &Roster, workspaces: &Value) -> Vec<String> {
    let mut moves = Vec::new();
    for row in workspaces.as_array().into_iter().flatten() {
        let Some(name) = row["name"].as_str() else {
            continue;
        };
        let Some(number) = row["num"].as_u64().filter(|number| *number > 0) else {
            continue;
        };
        let old = before.sandboxes.get(number as usize - 1);
        let next = old
            .and_then(|old| after.sandboxes.iter().position(|entry| entry.id == old.id))
            .map(|index| space_name(index + 1, &after.sandboxes[index]));
        if let Some(next) = next.filter(|next| next != name) {
            // Temporary names let two occupied Spaces exchange numbers without colliding.
            moves.push((name.to_string(), next));
        }
    }
    moves
        .iter()
        .enumerate()
        .map(|(i, (old, _))| {
            format!(
                "rename workspace {} to {}",
                quote(old),
                quote(&format!("intentic-moving-{i}"))
            )
        })
        .chain(moves.iter().enumerate().map(|(i, (_, next))| {
            format!(
                "rename workspace {} to {}",
                quote(&format!("intentic-moving-{i}")),
                quote(next)
            )
        }))
        .collect()
}

pub(super) fn roster_changed(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut before = last_roster().lock().unwrap();
        let after = handle.state::<AppState>().roster();
        let mut desired = destination().lock().unwrap();
        if let Some(number) = desired
            .as_ref()
            .and_then(|name| name.split(':').next()?.parse::<usize>().ok())
            .filter(|n| *n > 0)
        {
            if let Some(old) = before.sandboxes.get(number - 1) {
                *desired = after
                    .sandboxes
                    .iter()
                    .position(|entry| entry.id == old.id)
                    .map(|index| space_name(index + 1, &after.sandboxes[index]));
            }
        }
        drop(desired);
        if let Ok(workspaces) = ipc::request(1, "") {
            for command in rename_spaces(&before, &after, &workspaces) {
                let _ = ipc::command(&command);
            }
        }
        *before = after;
        // A window may have opened before the account's roster arrived, or before its platform id was known.
        // Reconcile existing attested windows as well as new-window events when the account changes.
        if let Ok(tree) = ipc::request(4, "") {
            let local = local_sandboxes();
            for command in tree_commands(&tree, &before, &local) {
                let _ = ipc::command(&command);
            }
        }
    });
}

fn last_roster() -> &'static Mutex<Roster> {
    static ROSTER: OnceLock<Mutex<Roster>> = OnceLock::new();
    ROSTER.get_or_init(|| Mutex::new(Roster::default()))
}

/// A sandbox's security context is supplied by sway, never inferred from its title or app_id alone.
fn sandbox_commands(event: &Value, roster: &Roster, local: &Value) -> Vec<String> {
    let window = &event["container"];
    if window["sandbox_engine"] != "dev.intentic.sandbox" {
        return Vec::new();
    }
    let Some(id) = window["id"].as_i64().filter(|id| *id > 0) else {
        return Vec::new();
    };
    let mut commands = Vec::new();
    if window["fullscreen_mode"].as_u64().unwrap_or(0) > 0 {
        // Keep the system bar and Space label visible: sandbox content must never impersonate the whole desktop.
        commands.push(format!("[con_id={id}] fullscreen disable"));
    }
    // Sway reports the security context's app_id as sandbox_app_id. The ordinary app_id is client-controlled.
    let platform = window["sandbox_app_id"].as_str().and_then(|slug| {
        local
            .as_array()?
            .iter()
            .find(|row| row["slug"].as_str() == Some(slug))?["platformId"]
            .as_str()
    });
    if matches!(event["change"].as_str(), Some("new" | "app_id")) {
        if let Some(index) =
            platform.and_then(|platform| roster.sandboxes.iter().position(|s| s.id == platform))
        {
            commands.push(format!(
                "[con_id={id}] move container to workspace {}",
                quote(&space_name(index + 1, &roster.sandboxes[index]))
            ));
        }
    }
    commands
}

fn tree_commands(tree: &Value, roster: &Roster, local: &Value) -> Vec<String> {
    let mut commands = sandbox_commands(
        &serde_json::json!({"change":"new","container":tree}),
        roster,
        local,
    );
    for node in ["nodes", "floating_nodes"]
        .iter()
        .filter_map(|key| tree[*key].as_array())
        .flatten()
    {
        commands.extend(tree_commands(node, roster, local));
    }
    commands
}

fn local_sandboxes() -> Value {
    let mut command = std::process::Command::new("/usr/bin/ic");
    command.args(["sandbox", "list", "--json"]);
    intentic_bounded::capture(
        command,
        Duration::from_secs(5),
        intentic_bounded::Reach::Tree,
    )
    .ok()
    .filter(|ran| ran.success())
    .and_then(|ran| serde_json::from_str(&ran.stdout).ok())
    .unwrap_or(Value::Null)
}

fn focused_number() -> Option<usize> {
    ipc::request(1, "")
        .ok()?
        .as_array()?
        .iter()
        .find(|row| row["focused"] == true)?["num"]
        .as_u64()
        .map(|n| n as usize)
}

pub(super) fn start(app: &AppHandle) {
    if std::env::var_os("SWAYSOCK").is_none() {
        return;
    }
    *last_roster().lock().unwrap() = app.state::<AppState>().roster();
    let handle = app.clone();
    std::thread::spawn(move || loop {
        if let Ok(mut events) = ipc::subscribe() {
            let mut current = focused_number();
            let mut local = Value::Null;
            let mut local_at = Instant::now()
                .checked_sub(Duration::from_secs(10))
                .unwrap_or_else(Instant::now);
            while let Ok((kind, event)) = ipc::read_frame(&mut events) {
                match kind {
                    0x8000_0005 => {
                        if let Some(number) = binding(&event) {
                            current = Some(number);
                            activate(&handle, number, false, false);
                        } else if event["binding"]["command"] == "nop intentic-chat" {
                            if let Some(number) = focused_number() {
                                activate(&handle, number, false, number > 0);
                            }
                        }
                    }
                    0x8000_0000 if event["change"] == "focus" => {
                        let number = event["current"]["num"].as_u64().map(|n| n as usize);
                        if current != number {
                            current = number;
                            if let Some(number) = number {
                                // The selected Space may have come from a shell link with a more precise route
                                // (Agents or a new chat). Its focus event must not replace that route with `/`.
                                let selected = destination().lock().unwrap().clone();
                                if selected.as_deref() != event["current"]["name"].as_str() {
                                    activate(&handle, number, false, false);
                                }
                            }
                        }
                    }
                    0x8000_0003 => {
                        let roster = handle.state::<AppState>().roster();
                        // Undo fullscreen before the bounded sandbox-list read: a slow engine must not leave a
                        // sandbox covering the system bar while we work out which Space it belongs to.
                        for command in sandbox_commands(&event, &roster, &Value::Null) {
                            let _ = ipc::command(&command);
                        }
                        if event["container"]["sandbox_engine"] == "dev.intentic.sandbox"
                            && local_at.elapsed() >= Duration::from_secs(10)
                        {
                            local = local_sandboxes();
                            local_at = Instant::now();
                        }
                        for command in sandbox_commands(&event, &roster, &local) {
                            let _ = ipc::command(&command);
                        }
                    }
                    _ => {}
                }
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roster() -> Roster {
        Roster {
            account: None,
            sandboxes: vec![RosterEntry {
                id: "box-a".into(),
                name: "My work; exec bad".into(),
                place: "own".into(),
                shared: false,
            }],
        }
    }

    #[test]
    fn only_the_shells_digit_bindings_select_roster_order() {
        assert_eq!(
            binding(&json!({"binding":{"command":"nop intentic-space 1"}})),
            Some(1)
        );
        assert_eq!(
            binding(&json!({"binding":{"command":"nop intentic-space 10"}})),
            None
        );
        assert_eq!(
            binding(&json!({"binding":{"command":"exec intentic-space 1"}})),
            None
        );
        assert_eq!(
            named_space(&roster(), 1),
            Some("1:My work  exec bad".into())
        );
        assert_eq!(named_space(&roster(), 0), Some("0:This computer".into()));
        assert_eq!(named_space(&roster(), 2), None);
    }

    #[test]
    fn only_attested_sandbox_windows_move_and_fullscreen_is_always_undone() {
        let event = json!({"change":"new","container":{"id":42,"sandbox_engine":"dev.intentic.sandbox","sandbox_app_id":"work","app_id":"untrusted-other-name","fullscreen_mode":1}});
        let local = json!([{"slug":"work","platformId":"box-a"}]);
        assert_eq!(
            sandbox_commands(&event, &roster(), &local),
            vec![
                "[con_id=42] fullscreen disable",
                "[con_id=42] move container to workspace \"1:My work  exec bad\""
            ]
        );
        assert_eq!(
            sandbox_commands(
                &event,
                &roster(),
                &json!([{"slug":"work","platformId":null}])
            ),
            vec!["[con_id=42] fullscreen disable"]
        );
        let mut impostor = event.clone();
        impostor["container"]["sandbox_engine"] = Value::Null;
        assert_eq!(
            sandbox_commands(&impostor, &roster(), &local),
            Vec::<String>::new()
        );
        let mut missing_context = event.clone();
        missing_context["container"]["sandbox_app_id"] = Value::Null;
        missing_context["container"]["app_id"] = json!("work");
        assert_eq!(
            sandbox_commands(&missing_context, &roster(), &local),
            vec!["[con_id=42] fullscreen disable"]
        );
    }

    #[test]
    fn a_roster_change_reconciles_existing_tiled_and_floating_windows() {
        let tree = json!({"nodes":[{"id":42,"sandbox_engine":"dev.intentic.sandbox","sandbox_app_id":"work","fullscreen_mode":0}],"floating_nodes":[{"id":43,"sandbox_engine":"dev.intentic.sandbox","sandbox_app_id":"work","fullscreen_mode":1}]});
        assert_eq!(
            tree_commands(
                &tree,
                &roster(),
                &json!([{"slug":"work","platformId":"box-a"}])
            ),
            vec![
                "[con_id=42] move container to workspace \"1:My work  exec bad\"",
                "[con_id=43] fullscreen disable",
                "[con_id=43] move container to workspace \"1:My work  exec bad\""
            ]
        );
    }

    #[test]
    fn renamed_spaces_keep_their_sandbox_identity() {
        let before = roster();
        let mut after = before.clone();
        after.sandboxes[0].name = "New name".into();
        assert_eq!(
            rename_spaces(&before, &after, &json!([{"num":1,"name":"1:Old name"}])),
            vec![
                "rename workspace \"1:Old name\" to \"intentic-moving-0\"",
                "rename workspace \"intentic-moving-0\" to \"1:New name\""
            ]
        );
    }
}
