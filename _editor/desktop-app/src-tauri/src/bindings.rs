//! Machine-agent pairings are the sole folder/sandbox bindings: read status --json, mutate through agent verbs, then read again.
//! Keep only an in-memory snapshot in AppState; never duplicate pairings in an app file or read sync.json and its tokens directly.
//! agent_id_of resolves a pairing's address; platform_id resolves the roster row using folder setup records and listed_rows from ic.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::state::{AppState, Project};

/// A sandbox's platform row, with what this machine knows it by: its slug here and its public address.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub slug: Option<String>,
    pub hostname: Option<String>,
}

/// The rows a listing (`ic sandbox list --json`) names: each sandbox's slug beside the platform's id for it. Pure.
pub fn rows_listed(rows: &[serde_json::Value]) -> Vec<Row> {
    rows.iter()
        .filter_map(|row| {
            Some(Row {
                id: row["platformId"]
                    .as_str()
                    .filter(|id| crate::setup_link::is_sandbox_id(id))?
                    .to_string(),
                slug: row["slug"].as_str().map(str::to_string),
                hostname: None,
            })
        })
        .collect()
}

/// What the last listing said, and when.
static LISTED: Mutex<Option<(Instant, Vec<Row>)>> = Mutex::new(None);
/// A listing this fresh is not asked again for a pairing whose row it did not name.
const LISTED_FOR: Duration = Duration::from_secs(120);

/// A listing this app made for its own reasons (Devices, commands.rs `sandbox_list`), taken in.
pub fn heard_listing(rows: &[serde_json::Value]) {
    *LISTED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((Instant::now(), rows_listed(rows)));
}

/// What the last listing said; asked again (seconds of `ic`) only when a pairing's sandbox is one no row names and the
/// last listing is older than [`LISTED_FOR`].
fn listed_rows(app: &AppHandle, wanted: bool) -> Vec<Row> {
    let held = LISTED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let stale = held
        .as_ref()
        .is_none_or(|(at, _)| at.elapsed() > LISTED_FOR);
    if wanted && stale {
        let listing = crate::scripts::ic_listing(
            app,
            crate::commands::list_script(crate::scripts::Host::current(), crate::commands::VERSION),
        );
        if let Ok(rows) = listing {
            heard_listing(&rows);
            return rows_listed(&rows);
        }
    }
    held.map(|(_, rows)| rows).unwrap_or_default()
}

/// Every row this app knows: the folders' own sandboxes first, then the last listing's.
fn known_rows(app: &AppHandle, wanted: bool) -> Vec<Row> {
    let mut rows = crate::folder_setup::known_rows(app);
    for row in listed_rows(app, wanted) {
        if !rows.iter().any(|held| held.id == row.id) {
            rows.push(row);
        }
    }
    rows
}

/// The sandbox folder a project pairing syncs, `/work/<name>`, read back to `<name>`. Anything else (`/work` itself, a
/// deeper path) is no project folder. Pure.
fn project_dir(remote: &str) -> Option<&str> {
    remote
        .strip_prefix("/work/")
        .filter(|name| !name.is_empty() && !name.contains('/'))
}

/// The machine agent's own name for the sandbox at `hostname`, the one it files every pairing of that sandbox under: the
/// address's host, lowercased, with every run of other characters one `-` (the agent's `sanitizeId(new URL(url).host)`;
/// nothing this app runs gives it another). Pure.
pub fn agent_id_of(hostname: &str) -> String {
    let mut id = String::new();
    for character in hostname.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            id.push(character);
        } else if !id.is_empty() && !id.ends_with('-') {
            id.push('-');
        }
    }
    id.trim_end_matches('-').to_string()
}

/// The platform's row for the sandbox a pairing syncs with, where this app knows it (2026-10-21). The agent never learns
/// the row: it names a sandbox by [`agent_id_of`] its address. Everything here that asks whether a folder's sandbox is
/// live or gone compares rows (the roster's), and read as the row, the agent's own id made every folder one whose
/// sandbox the account no longer lists: the next roster had this machine let go of the sandbox's sync. A pairing is told
/// by its slug or its address against the rows this app knows ([`Row`]); a sandbox whose row is unknown here is
/// undecided, which every reader takes as live, never as gone. Pure.
pub fn platform_id(pairing: &serde_json::Value, rows: &[Row]) -> Option<String> {
    let named = |said: Option<&str>, held: Option<&str>| said.is_some() && said == held;
    rows.iter()
        .find(|row| {
            let agent_id = row.hostname.as_deref().map(agent_id_of);
            named(pairing["sandboxId"].as_str(), agent_id.as_deref())
                || named(pairing["slug"].as_str(), row.slug.as_deref())
        })
        .map(|row| row.id.clone())
}

/// The bindings the agent's report (`intentic-machine status --json`) holds: every pairing that syncs a folder of this
/// computer into a project folder of a sandbox, filed under the sandbox's platform row ([`platform_id`]). A pairing of a
/// whole `/work` (an older desktop sync) and a mirror-only pairing bind no folder. Pure.
pub fn read(report: &serde_json::Value, rows: &[Row]) -> Vec<Project> {
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
                        sandbox_id: platform_id(pairing, rows),
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
/// report for a caller that reads more of it (folder_setup.rs follows first copies off the same one), or None when
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
    let mut rows = known_rows(app, false);
    // A project pairing whose sandbox no row names yet: the listing is asked (at most every two minutes).
    let unnamed = report["sync"]["pairings"]
        .as_array()
        .is_some_and(|pairings| {
            pairings.iter().any(|pairing| {
                pairing["mode"].as_str() == Some("sync")
                    && pairing["remoteDir"]
                        .as_str()
                        .and_then(project_dir)
                        .is_some()
                    && platform_id(pairing, &rows).is_none()
            })
        });
    if unnamed {
        rows = known_rows(app, true);
    }
    let before = app.state::<AppState>().hear_bindings(read(&report, &rows));
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

    /// What the agent and the app hold of a sandbox, as on a real computer (rog, 2026-10-21): the agent names it by its
    /// address (`sandboxId`, `sync setup` given no `--sandbox-id`, which nothing passes), the app's records and the
    /// roster by the platform's row.
    const AGENT_ID: &str = "sandbox-7953ae151fa4-sbx-intentic-dev";
    const SLUG: &str = "sandbox-7953ae151fa4";
    const ROW: &str = "cmvc7h3cl002801mkboza1qz6";

    fn mine() -> Vec<Row> {
        vec![Row {
            id: ROW.to_string(),
            slug: Some(SLUG.to_string()),
            hostname: Some("sandbox-7953ae151fa4.sbx.intentic.dev".to_string()),
        }]
    }

    fn pairing(local: Option<&str>, remote: Option<&str>) -> serde_json::Value {
        let mut pairing =
            serde_json::json!({ "sandboxId": AGENT_ID, "mode": "sync", "slug": SLUG });
        if let Some(local) = local {
            pairing["localDir"] = local.into();
        }
        if let Some(remote) = remote {
            pairing["remoteDir"] = remote.into();
        }
        pairing
    }

    fn roster(rows: &[&str]) -> crate::setup_link::Roster {
        crate::setup_link::Roster {
            account: Some(crate::setup_link::RosterAccount {
                email: "ada@example.com".to_string(),
                name: None,
                image: None,
            }),
            sandboxes: rows
                .iter()
                .map(|id| crate::setup_link::RosterEntry {
                    id: id.to_string(),
                    name: "Local".to_string(),
                    place: "own".to_string(),
                    shared: false,
                })
                .collect(),
        }
    }

    /// A folder is bound by its pairing alone, read off the agent's report: the sandbox, the folder's name in `/work` and
    /// the slug to start or forget it by all come from there, so an app reinstalled with no files of its own still knows
    /// every folder the agent syncs (quick-lantern, 2026-10-19).
    #[test]
    fn a_folder_is_bound_by_the_agents_pairing_and_by_nothing_else() {
        let report = serde_json::json!({ "sync": { "pairings": [
            pairing(Some("/home/ada/code/app"), Some("/work/app")),
            // The whole /work of an older desktop sync, a deeper folder, a folderless pairing and a mirror bind no folder.
            pairing(Some("/home/ada/intentic/cm1"), None),
            pairing(Some("/home/ada/x"), Some("/work/a/b")),
            serde_json::json!({ "sandboxId": AGENT_ID, "mode": "sync", "projectsHost": true }),
            serde_json::json!({ "sandboxId": "sandbox-0123456789ab-sbx-intentic-dev", "mode": "mirror", "localDir": "/m", "remoteDir": "/work/m" }),
        ] } });
        assert_eq!(
            read(&report, &mine()),
            vec![Project {
                path: "/home/ada/code/app".to_string(),
                dir: "app".to_string(),
                sandbox_id: Some(ROW.to_string()),
                slug: Some(SLUG.to_string()),
            }]
        );
        // An agent that says nothing of pairings binds nothing; one older than `slug` binds without it.
        assert_eq!(read(&serde_json::json!({}), &mine()), Vec::<Project>::new());
        let older = serde_json::json!({ "sync": { "pairings": [
            { "sandboxId": AGENT_ID, "mode": "sync", "localDir": "/a", "remoteDir": "/work/a" }
        ] } });
        assert_eq!(read(&older, &mine())[0].slug, None);
        assert_eq!(read(&older, &mine())[0].sandbox_id.as_deref(), Some(ROW));
    }

    /// (2026-10-21) The agent's id for a sandbox is never the platform's row, and a binding filed under it read as a folder
    /// whose sandbox the account no longer lists: every roster the workspace sent had this machine let go of the sandbox's
    /// sync. A binding is filed under the row, found by the sandbox's address or its slug; one whose row this app does not
    /// know (a hosted sandbox's) is undecided, never gone.
    #[test]
    fn a_folder_is_filed_under_its_sandboxs_platform_row_so_a_roster_listing_it_keeps_it() {
        let report = serde_json::json!({ "sync": { "pairings": [
            { "sandboxId": AGENT_ID, "mode": "sync", "projectsHost": true, "slug": SLUG },
            pairing(Some("/home/ada/code/auto-translate"), Some("/work/auto-translate")),
            { "sandboxId": "sandbox-0123456789ab-sbx-intentic-dev", "mode": "sync", "slug": "sandbox-0123456789ab",
              "localDir": "/home/ada/code/site", "remoteDir": "/work/site" },
        ] } });
        let bound = read(&report, &mine());
        let rows: Vec<Option<&str>> = bound
            .iter()
            .map(|project| project.sandbox_id.as_deref())
            .collect();
        assert_eq!(rows, vec![Some(ROW), None]);
        let listed = roster(&[ROW, "cmvhzf5fr001501nteemkn3r9"]);
        let mut owners = std::collections::BTreeMap::new();
        crate::state::learn_owners(&mut owners, &listed);
        assert!(crate::project::stale_projects(&bound, &listed, &owners, &[]).is_empty());
        assert!(bound
            .iter()
            .all(|project| crate::project::is_live(&listed, project)));
        // Once the account no longer lists it, its folder is one whose sandbox went; the hosted one stays undecided.
        let gone = crate::project::stale_projects(
            &bound,
            &roster(&["cmvhzf5fr001501nteemkn3r9"]),
            &owners,
            &[],
        );
        assert_eq!(
            gone.iter()
                .map(|project| project.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/home/ada/code/auto-translate"]
        );
        // An agent older than `slug` is told by the address alone, and a record with no row files nothing.
        let older = serde_json::json!({ "sandboxId": AGENT_ID, "mode": "sync" });
        assert_eq!(platform_id(&older, &mine()).as_deref(), Some(ROW));
        assert_eq!(platform_id(&pairing(None, None), &[]), None);
        // A sandbox only the listing names is told by its slug.
        let listed = rows_listed(&[
            serde_json::json!({ "slug": "sandbox-0123456789ab", "platformId": "cmvhzf5fr001501nteemkn3r9" }),
            serde_json::json!({ "slug": "lab", "platformId": null }),
        ]);
        assert_eq!(listed.len(), 1);
        let hosted = serde_json::json!({ "sandboxId": "sandbox-0123456789ab-sbx-intentic-dev", "slug": "sandbox-0123456789ab" });
        assert_eq!(
            platform_id(&hosted, &listed).as_deref(),
            Some("cmvhzf5fr001501nteemkn3r9")
        );
    }

    #[test]
    fn the_agents_id_for_a_sandbox_is_its_address_spelled_as_the_agent_spells_it() {
        assert_eq!(
            agent_id_of("sandbox-7953ae151fa4.sbx.intentic.dev"),
            AGENT_ID
        );
        assert_eq!(agent_id_of("Work.Example.com"), "work-example-com");
        assert_eq!(agent_id_of(".a..b-c:8443."), "a-b-c-8443");
    }

    #[test]
    fn only_folders_not_bound_before_are_newly_bound() {
        let bound = |path: &str| Project {
            path: path.to_string(),
            dir: "x".to_string(),
            sandbox_id: Some(ROW.to_string()),
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
