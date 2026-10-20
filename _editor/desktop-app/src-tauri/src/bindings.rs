//! WHICH FOLDER OF THIS COMPUTER IS IN WHICH SANDBOX: the machine agent's pairings, and nothing else (2026-10-20).
//!
//! The agent keeps one pairing per synced folder (`intentic-machine sync attach`, `sync setup`), and that pairing is
//! what syncs the folder: it is the binding. This app reads it through the agent (`intentic-machine status --json`,
//! scripts.rs [`crate::scripts::sync_report`]) and writes it only through the agent's own verbs (attach, detach,
//! uninstall, forget), then reads again. What it last read is held in memory alone ([`crate::state::AppState`]
//! `bindings`), never written to a file of its own.
//!
//! Before, the same fact lived in three places: `projects.json` (written by this app after an attach or a project's
//! setup), the folders of `machine-sandbox.json`, and the agent's pairings. Each could be lost or outlive the others: a
//! reinstall took the app's two files and left the agent syncing, so a folder that had a sandbox was offered "Start a
//! sandbox" again (quick-lantern, 2026-10-19); a pairing the agent retired by itself stayed in `projects.json`, whose
//! folder's button opened a sandbox that no longer had it. Rejected: keeping `projects.json` as a cache refreshed from the
//! agent, which is the same second copy with a better excuse; reading the agent's `sync.json` directly, which holds its
//! sync tokens and may sit inside a WSL distro the agent alone resolves.

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::state::{AppState, Project};

/// The sandbox folder a project pairing syncs, `/work/<name>`, read back to `<name>`. Anything else (`/work` itself, a
/// deeper path) is no project folder. Pure.
fn project_dir(remote: &str) -> Option<&str> {
    remote
        .strip_prefix("/work/")
        .filter(|name| !name.is_empty() && !name.contains('/'))
}

/// The bindings the agent's report (`intentic-machine status --json`) holds: every pairing that syncs a folder of this
/// computer into a project folder of a sandbox. A pairing of a whole `/work` (an older desktop sync), the projects host
/// (no folder of its own) and a mirror-only pairing bind no folder. Pure.
pub fn read(report: &serde_json::Value) -> Vec<Project> {
    report["sync"]["pairings"]
        .as_array()
        .map(|pairings| {
            pairings
                .iter()
                .filter(|pairing| pairing["mode"].as_str() == Some("sync"))
                .filter_map(|pairing| {
                    Some(Project {
                        path: pairing["localDir"].as_str()?.to_string(),
                        dir: project_dir(pairing["remoteDir"].as_str()?)?.to_string(),
                        sandbox_id: pairing["sandboxId"].as_str().map(str::to_string),
                        slug: pairing["slug"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The folders bound now that were not in `before`: the ones whose windows are told they have a sandbox. Pure.
pub fn newly_bound<'a>(before: &[Project], now: &'a [Project]) -> Vec<&'a Project> {
    now.iter()
        .filter(|project| !before.iter().any(|held| held.path == project.path))
        .collect()
}

/// The agent's report read again, its bindings taken in, and every window on a folder newly bound told so. Answers the
/// report for a caller that reads more of it (machine_sandbox.rs follows first copies off the same one), or None when
/// there is no agent or it could not be read, which leaves what was last read as it was: a doubt changes nothing.
pub fn refresh(app: &AppHandle) -> Option<serde_json::Value> {
    let report = match crate::scripts::sync_report() {
        Ok(Some(report)) => serde_json::from_str::<serde_json::Value>(&report).ok()?,
        Ok(None) => serde_json::json!({}),
        Err(error) => {
            eprintln!("intentic: {error}");
            return None;
        }
    };
    let before = app.state::<AppState>().hear_bindings(read(&report));
    for project in newly_bound(&before, &app.state::<AppState>().projects()) {
        crate::local::mark_sandbox(app, Path::new(&project.path));
    }
    Some(report)
}

/// [`refresh`] off the calling thread, after a write through the agent from a thread that must not wait on it.
pub fn refresh_soon(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        refresh(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairing(local: Option<&str>, remote: Option<&str>) -> serde_json::Value {
        let mut pairing =
            serde_json::json!({ "sandboxId": "cm1", "mode": "sync", "slug": "sandbox-cm1" });
        if let Some(local) = local {
            pairing["localDir"] = local.into();
        }
        if let Some(remote) = remote {
            pairing["remoteDir"] = remote.into();
        }
        pairing
    }

    /// A folder is bound by its pairing alone, read off the agent's report: the sandbox, the folder's name in `/work` and
    /// the slug to start or forget it by all come from there, so an app reinstalled with no files of its own still knows
    /// every folder the agent syncs (quick-lantern, 2026-10-19).
    #[test]
    fn a_folder_is_bound_by_the_agents_pairing_and_by_nothing_else() {
        let report = serde_json::json!({ "sync": { "pairings": [
            pairing(Some("/home/ada/code/app"), Some("/work/app")),
            // The whole /work of an older desktop sync, a deeper folder, the projects host and a mirror bind no folder.
            pairing(Some("/home/ada/intentic/cm1"), None),
            pairing(Some("/home/ada/x"), Some("/work/a/b")),
            serde_json::json!({ "sandboxId": "cm1", "mode": "sync", "projectsHost": true }),
            serde_json::json!({ "sandboxId": "cm2", "mode": "mirror", "localDir": "/m", "remoteDir": "/work/m" }),
        ] } });
        assert_eq!(
            read(&report),
            vec![Project {
                path: "/home/ada/code/app".to_string(),
                dir: "app".to_string(),
                sandbox_id: Some("cm1".to_string()),
                slug: Some("sandbox-cm1".to_string()),
            }]
        );
        // An agent that says nothing of pairings binds nothing; one older than `slug` binds without it.
        assert_eq!(read(&serde_json::json!({})), Vec::<Project>::new());
        let older = serde_json::json!({ "sync": { "pairings": [
            { "sandboxId": "cm1", "mode": "sync", "localDir": "/a", "remoteDir": "/work/a" }
        ] } });
        assert_eq!(read(&older)[0].slug, None);
    }

    #[test]
    fn only_folders_not_bound_before_are_newly_bound() {
        let bound = |path: &str| Project {
            path: path.to_string(),
            dir: "x".to_string(),
            sandbox_id: Some("cm1".to_string()),
            slug: None,
        };
        let before = vec![bound("/a")];
        let now = vec![bound("/a"), bound("/b")];
        let newly: Vec<&str> = newly_bound(&before, &now)
            .into_iter()
            .map(|project| project.path.as_str())
            .collect();
        assert_eq!(newly, vec!["/b"]);
    }
}
