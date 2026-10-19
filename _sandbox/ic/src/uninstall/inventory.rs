/* WHAT INTENTIC HAS ON THIS DEVICE, read before anything is asked or touched. It is what the question names (so a
person deciding knows what goes), what the steps are planned from, and what `--dry-run --json` and `--ini` hand the
desktop app and the Windows uninstaller's page, which show the same choice.

It only reads, and every reading is bounded: an inventory that waits on a docker that does not answer would hold up
the uninstaller's first page. What could not be read is said as unknown (no size), never guessed. */

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::host::{self, App};
use super::plan::{self, Facts};
use crate::docker;
use crate::engine::leave as engine;
use crate::sandbox::trash;

/// One sandbox or runner as the inventory lists it.
#[derive(Debug, Clone, Serialize)]
pub struct SandboxRow {
    pub slug: String,
    pub kind: &'static str,
    pub state: String,
    pub bytes: Option<u64>,
}

pub struct Inventory {
    pub facts: Facts,
    pub rows: Vec<SandboxRow>,
    pub app: Option<App>,
}

/// Read the device.
pub fn gather() -> Inventory {
    let windows = cfg!(windows);
    let docker = docker::cli_present() && docker::daemon_reachable();
    let rows = sandbox_rows(docker);
    let data_bytes = rows
        .iter()
        .map(|row| row.bytes)
        .try_fold(0u64, |total, bytes| bytes.map(|bytes| total + bytes))
        .filter(|_| !rows.is_empty());
    let engine_here = engine::installed();
    let agent_dir = crate::sandbox::remove::machine_dir();
    let agent = crate::sandbox::remove::machine_agent().is_some();
    let mut distros = if windows {
        machine_children(&agent_dir)
    } else {
        Vec::new()
    };
    for served in engine::served_distros() {
        if !distros.contains(&served) {
            distros.push(served);
        }
    }
    let app = host::find_app();
    let facts = Facts {
        windows,
        sandboxes: rows.len(),
        data_bytes,
        passwords: passwords_here(),
        docker,
        engine: engine_here,
        engine_bytes: engine_here.then(engine::disk_bytes).flatten(),
        engine_holds_others: engine_here && engine::others_on_it().unwrap_or(0) > 0,
        agent,
        folders: synced_folders(&agent_dir),
        distros,
        app: app.is_some(),
        cache_bytes: cache_bytes(),
        deploys: cfg!(unix) && Path::new("/opt/intentic").is_dir(),
        stays: stays(engine_here),
    };
    Inventory { facts, rows, app }
}

/// The sandboxes and runners: from docker when it answers, the recoverable ones included, else from ic's own records,
/// so a device whose engine is down still says what an uninstall would delete.
fn sandbox_rows(docker_up: bool) -> Vec<SandboxRow> {
    let mut rows = Vec::new();
    if docker_up {
        let sizes = volume_sizes();
        let size_of = |slug: &str| sizes.as_ref().map(|sizes| slug_bytes(sizes, slug));
        for slug in crate::sandbox::list_slugs() {
            rows.push(SandboxRow {
                kind: kind_of(&slug),
                state: state_word(&crate::sandbox::container_status(&slug)).to_string(),
                bytes: size_of(&slug),
                slug,
            });
        }
        for entry in trash::list() {
            if rows.iter().any(|row| row.slug == entry.slug) {
                continue;
            }
            rows.push(SandboxRow {
                kind: kind_of(&entry.slug),
                state: "removed".to_string(),
                bytes: size_of(&entry.slug),
                slug: entry.slug,
            });
        }
        return rows;
    }
    for slug in recorded_slugs(&crate::logfile::intentic_home()) {
        rows.push(SandboxRow {
            kind: kind_of(&slug),
            state: "unknown".to_string(),
            bytes: None,
            slug,
        });
    }
    rows
}

/// docker's container state as the inventory says it: `running`, or `stopped` for every other state a container can be
/// in (exited, created, paused, dead). Pure.
pub fn state_word(docker_state: &str) -> &'static str {
    if docker_state.trim() == "running" {
        "running"
    } else {
        "stopped"
    }
}

fn kind_of(slug: &str) -> &'static str {
    if slug.starts_with("runner-") {
        "runner"
    } else {
        "sandbox"
    }
}

/// The slugs ic keeps a record for (`sandbox-<slug>.channel`, record.rs). Pure but for the listing.
pub fn recorded_slugs(home: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(home) else {
        return Vec::new();
    };
    let mut slugs: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.strip_prefix("sandbox-")?
                .strip_suffix(".channel")
                .map(str::to_string)
        })
        .filter(|slug| crate::sandbox::is_slug(slug))
        .collect();
    slugs.sort();
    slugs
}

/// Every volume's size, as `docker system df -v` reports it. None when docker would not say in time.
fn volume_sizes() -> Option<Vec<(String, u64)>> {
    let ran = docker::capture_bounded(
        &["system", "df", "-v", "--format", "{{json .Volumes}}"],
        Duration::from_secs(20),
    )
    .ok()?;
    if ran.code != Some(0) {
        return None;
    }
    parse_volume_sizes(&ran.stdout)
}

/// `docker system df -v --format '{{json .Volumes}}'`: `[{"Name":"…","Size":"1.2GB",…}]`. Pure.
pub fn parse_volume_sizes(json: &str) -> Option<Vec<(String, u64)>> {
    let value: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    Some(
        value
            .as_array()?
            .iter()
            .filter_map(|volume| {
                let name = volume.get("Name")?.as_str()?.to_string();
                let size = parse_docker_size(volume.get("Size")?.as_str()?)?;
                Some((name, size))
            })
            .collect(),
    )
}

/// docker's own size words, decimal: `0B`, `512kB`, `1.234GB`, `N/A`. Pure.
pub fn parse_docker_size(text: &str) -> Option<u64> {
    let text = text.trim();
    let split = text
        .find(|c: char| c.is_ascii_alphabetic())
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let number: f64 = number.trim().parse().ok()?;
    let scale: f64 = match unit.trim().to_ascii_uppercase().as_str() {
        "B" | "" => 1.0,
        "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        _ => return None,
    };
    Some((number * scale) as u64)
}

/// The bytes of one sandbox's data volumes (trash.rs data_volumes). Pure.
pub fn slug_bytes(sizes: &[(String, u64)], slug: &str) -> u64 {
    [
        "intentic-workspace-",
        "intentic-history-",
        "intentic-docker-",
        "intentic-dind-docker-",
    ]
    .iter()
    .map(|family| format!("{family}{slug}"))
    .filter_map(|name| {
        sizes
            .iter()
            .find(|(volume, _)| *volume == name)
            .map(|(_, size)| *size)
    })
    .sum()
}

/// The distros the Windows side's agent supervises (`machine.json` `children`).
fn machine_children(agent_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(agent_dir.join("machine.json"))
        .ok()
        .map(|text| children_of(&text))
        .unwrap_or_default()
}

/// `machine.json`'s `children`. Pure.
pub fn children_of(machine_json: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(machine_json)
        .ok()
        .and_then(|value| {
            value.get("children")?.as_array().map(|children| {
                children
                    .iter()
                    .filter_map(|child| child.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// The folders the agent syncs to this device (`sync.json`).
fn synced_folders(agent_dir: &Path) -> usize {
    std::fs::read_to_string(agent_dir.join("sync.json"))
        .ok()
        .map(|text| folders_in(&text))
        .unwrap_or(0)
}

/// The pairings of `sync.json` that sync a folder: `mode: "sync"`, not the projects host (sync/uninstall.ts
/// `syncsAFolder`). Pure.
pub fn folders_in(sync_json: &str) -> usize {
    serde_json::from_str::<serde_json::Value>(sync_json)
        .ok()
        .and_then(|value| {
            value.get("pairings")?.as_array().map(|pairings| {
                pairings
                    .iter()
                    .filter(|pairing| {
                        pairing.get("mode").and_then(|mode| mode.as_str()) == Some("sync")
                            && pairing.get("projectsHost").and_then(|host| host.as_bool())
                                != Some(true)
                    })
                    .count()
            })
        })
        .unwrap_or(0)
}

/// A keyring vault is here: its folder (keyring/src/address.ts), or a hardened one under ProgramData.
fn passwords_here() -> bool {
    let home = crate::sandbox::remove::machine_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(crate::logfile::intentic_home);
    if home.join("keyring").join("vault.json").exists() {
        return true;
    }
    #[cfg(windows)]
    {
        if let Some(data) = std::env::var_os("ProgramData") {
            let hardened = PathBuf::from(data).join("Intentic").join("Keyring");
            if let Ok(entries) = std::fs::read_dir(hardened) {
                return entries
                    .flatten()
                    .any(|entry| entry.file_name().to_string_lossy().ends_with(".hardened"));
            }
        }
    }
    false
}

/// What the caches, downloads and logs take: what both outcomes delete.
fn cache_bytes() -> u64 {
    cache_paths()
        .iter()
        .filter_map(|path| engine::folder_bytes(path))
        .sum()
}

/// ic's caches and logs, and the app's cache folders.
pub fn cache_paths() -> Vec<PathBuf> {
    let home = crate::logfile::intentic_home();
    let mut paths: Vec<PathBuf> = crate::image_cache::cache_root().into_iter().collect();
    paths.extend([
        home.join("engine-cache"),
        home.join("logs"),
        home.join("records-archive"),
        home.join("ic").join("prefetch"),
        // The Docker Desktop installer `ic docker prepare` keeps across runs (prepare/fix.rs).
        std::env::temp_dir().join("intentic-docker"),
    ]);
    paths
}

/// What is not Intentic's and stays, named the way a person knows it.
fn stays(engine_here: bool) -> Vec<String> {
    let mut stays = Vec::new();
    if cfg!(windows) {
        if crate::engine::docker_desktop_installed() {
            stays.push("Docker Desktop".to_string());
        }
        if engine_here || Path::new(r"C:\Windows\System32\wsl.exe").exists() {
            stays.push("WSL".to_string());
        }
    } else if docker::cli_present() {
        stays.push("Docker".to_string());
    }
    stays
}

/// The JSON `--dry-run --json` answers (the desktop app's dialog reads it: uninstall.rs there).
#[derive(Serialize)]
pub struct Document<'a> {
    pub version: u32,
    pub os: &'static str,
    pub sandboxes: &'a [SandboxRow],
    #[serde(rename = "deleteCount")]
    pub delete_count: usize,
    pub passwords: bool,
    pub engine: Option<EngineDoc>,
    pub agent: Option<AgentDoc>,
    pub app: Option<AppDoc>,
    #[serde(rename = "cacheBytes")]
    pub cache_bytes: u64,
    pub stays: Vec<String>,
    pub found: Vec<String>,
    pub steps: StepsDoc,
}

#[derive(Serialize)]
pub struct EngineDoc {
    pub bytes: Option<u64>,
    #[serde(rename = "holdsOthers")]
    pub holds_others: bool,
}

#[derive(Serialize)]
pub struct AgentDoc {
    pub folders: usize,
    pub distros: Vec<String>,
}

#[derive(Serialize)]
pub struct AppDoc {
    pub version: Option<String>,
}

#[derive(Serialize)]
pub struct StepDoc {
    pub step: &'static str,
    pub label: String,
}

#[derive(Serialize)]
pub struct StepsDoc {
    pub everything: Vec<StepDoc>,
    #[serde(rename = "keep-sandboxes")]
    pub keep_sandboxes: Vec<StepDoc>,
}

impl Inventory {
    pub fn document(&self, without_app: bool) -> Document<'_> {
        let facts = &self.facts;
        let steps = |choice| {
            plan::steps(facts, choice, without_app)
                .into_iter()
                .map(|planned| StepDoc {
                    step: planned.step.id(),
                    label: planned.label,
                })
                .collect()
        };
        Document {
            version: 1,
            os: if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            },
            sandboxes: &self.rows,
            delete_count: facts.sandboxes,
            passwords: facts.passwords,
            engine: facts.engine.then_some(EngineDoc {
                bytes: facts.engine_bytes,
                holds_others: facts.engine_holds_others,
            }),
            agent: facts.agent.then(|| AgentDoc {
                folders: facts.folders,
                distros: facts.distros.clone(),
            }),
            app: self.app.as_ref().map(|app| AppDoc {
                version: app.version.clone(),
            }),
            cache_bytes: facts.cache_bytes,
            stays: plan::stays(facts),
            found: plan::found(facts),
            steps: StepsDoc {
                everything: steps(plan::Choice::Everything),
                keep_sandboxes: steps(plan::Choice::KeepSandboxes),
            },
        }
    }

    /// The sandboxes' names for a report row: the first three, and how many more.
    pub fn sandbox_list_names(&self) -> String {
        let names: Vec<&str> = self.rows.iter().map(|row| row.slug.as_str()).collect();
        if names.len() <= 3 {
            names.join(", ")
        } else {
            format!("{} and {} more", names[..3].join(", "), names.len() - 3)
        }
    }

    /// The sandboxes as the uninstaller's page lists them: `sandbox-a (4.1 GB), runner-b`.
    pub fn sandbox_list(&self) -> String {
        self.rows
            .iter()
            .map(|row| match row.bytes.filter(|bytes| *bytes > 0) {
                Some(bytes) => format!("{} ({})", row.slug, plan::size(bytes)),
                None => row.slug.clone(),
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_states_are_said_in_two_words() {
        assert_eq!(state_word("running"), "running");
        assert_eq!(state_word("exited"), "stopped");
        assert_eq!(state_word("created"), "stopped");
    }

    #[test]
    fn docker_sizes_are_read_in_its_own_units() {
        assert_eq!(parse_docker_size("0B"), Some(0));
        assert_eq!(parse_docker_size("512kB"), Some(512_000));
        assert_eq!(parse_docker_size("1.5GB"), Some(1_500_000_000));
        assert_eq!(parse_docker_size("N/A"), None);
    }

    #[test]
    fn a_sandboxs_bytes_are_its_data_volumes() {
        let sizes = parse_volume_sizes(
            r#"[{"Name":"intentic-workspace-a","Size":"2GB"},{"Name":"intentic-history-a","Size":"1GB"},{"Name":"intentic-workspace-b","Size":"5GB"},{"Name":"other","Size":"9GB"}]"#,
        )
        .unwrap();
        assert_eq!(slug_bytes(&sizes, "a"), 3_000_000_000);
        assert_eq!(slug_bytes(&sizes, "c"), 0);
    }

    #[test]
    fn only_folder_pairings_count_as_synced_folders() {
        let json = r#"{"pairings":[{"mode":"sync","localDir":"/a"},{"mode":"sync","projectsHost":true},{"mode":"mirror"}]}"#;
        assert_eq!(folders_in(json), 1);
        assert_eq!(folders_in("not json"), 0);
    }

    #[test]
    fn the_supervised_distros_come_from_machine_json() {
        assert_eq!(
            children_of(r#"{"children":["Arch","Ubuntu"]}"#),
            vec!["Arch", "Ubuntu"]
        );
        assert!(children_of("{}").is_empty());
    }

    #[test]
    fn records_name_the_sandboxes_when_docker_does_not_answer() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "sandbox-ab12.channel",
            "sandbox-ab12.channel.before",
            "sandbox-runner-x.channel",
            "notes.txt",
        ] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }
        assert_eq!(recorded_slugs(dir.path()), vec!["ab12", "runner-x"]);
    }
}
