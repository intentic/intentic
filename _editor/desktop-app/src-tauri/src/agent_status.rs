use std::time::Duration;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};

use crate::scripts;

/* THE MACHINE AGENT'S OWN ROW IN THE TRAY — whether this device's `intentic-machine` loop is alive, and what it is serving. */
pub struct TrayAgent(pub MenuItem<Wry>);

/// How often the row is refreshed. Status is a local process spawn (the agent asks Mutagen about its sessions),
/// so it is cheap but not free; the facts it reports move in minutes.
const REFRESH_EVERY: Duration = Duration::from_secs(60);

/// The row's text for one probe result. `None` = no agent installed, which is an ordinary state for a machine
/// that only runs sandboxes — said plainly rather than hidden, so the row keeps its place in the menu.
///
/// `others` are the other environments of this computer whose own agent runs (agents.rs), named after this one's
/// (2026-10-05): a WSL distro's agent keeps the sandboxes set up from that distro, and a row that said "not installed"
/// on such a PC told its owner that nothing looked after them.
fn row_text(probe: Result<Option<String>, String>, others: &[String]) -> String {
    let here = here_text(probe);
    match (others.is_empty(), here.as_str()) {
        (true, _) => here,
        (false, "Machine agent: not installed") => {
            format!("Machine agent: in {}", others.join(", "))
        }
        (false, _) => format!("{here} · also in {}", others.join(", ")),
    }
}

/// The row's text for this environment's own agent.
fn here_text(probe: Result<Option<String>, String>) -> String {
    match probe {
        Ok(None) => "Machine agent: not installed".to_string(),
        Ok(Some(raw)) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(status) => match status.get("summary").and_then(|summary| summary.as_str()) {
                Some(summary) => format!("Machine agent: {summary}"),
                // An agent from before the summary field: installed and answering is still worth a row.
                None => "Machine agent: installed".to_string(),
            },
            Err(_) => "Machine agent: installed".to_string(),
        },
        Err(_) => "Machine agent: not responding".to_string(),
    }
}

async fn refresh(app: &AppHandle) {
    let probe = tauri::async_runtime::spawn_blocking(scripts::sync_report)
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    let others = tauri::async_runtime::spawn_blocking(|| {
        crate::agents::others_running(&crate::agents::find())
    })
    .await
    .unwrap_or_default();
    if let Some(tray) = app.try_state::<TrayAgent>() {
        let _ = tray.0.set_text(row_text(probe, &others));
    }
}

/// Keep the row current for the life of the process. First probe straight away — the menu can be opened within
/// seconds of login, and "checking…" is only the honest text until there has been time to ask.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            refresh(&app).await;
            tokio::time::sleep(REFRESH_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::row_text;

    #[test]
    fn displays_the_agents_own_sentence_verbatim() {
        let raw = r#"{"version":"1.0.0","running":4242,"summary":"1 sandbox connected · syncing 2 sandboxes","device":{"links":[]},"sync":{}}"#;
        assert_eq!(
            row_text(Ok(Some(raw.to_string())), &[]),
            "Machine agent: 1 sandbox connected · syncing 2 sandboxes"
        );
    }

    // The row must never be the thing that breaks on an agent from another version: an unknown shape reads as
    // "installed", which is what is still known to be true of a binary that answered at all.
    #[test]
    fn degrades_to_installed_when_the_shape_is_not_the_one_expected() {
        assert_eq!(
            row_text(Ok(Some("{\"pairings\":[]}".to_string())), &[]),
            "Machine agent: installed"
        );
        assert_eq!(
            row_text(Ok(Some("not json at all".to_string())), &[]),
            "Machine agent: installed"
        );
    }

    /// A PC whose WSL distro runs its own agent says so, whether or not Windows has one.
    #[test]
    fn names_the_agents_of_this_computers_other_environments() {
        let wsl = ["WSL (archlinux)".to_string()];
        assert_eq!(
            row_text(Ok(None), &wsl),
            "Machine agent: in WSL (archlinux)"
        );
        let raw = r#"{"summary":"1 sandbox connected"}"#;
        assert_eq!(
            row_text(Ok(Some(raw.to_string())), &wsl),
            "Machine agent: 1 sandbox connected · also in WSL (archlinux)"
        );
    }

    #[test]
    fn names_the_two_states_a_user_can_act_on() {
        assert_eq!(row_text(Ok(None), &[]), "Machine agent: not installed");
        assert_eq!(
            row_text(Err("boom".to_string()), &[]),
            "Machine agent: not responding"
        );
    }
}
