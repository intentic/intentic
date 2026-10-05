//! THE MACHINE AGENTS OF THIS COMPUTER, by environment (2026-10-05).
//!
//! On Windows one Docker engine serves Windows and every WSL distro, and each of them can hold Intentic's machine agent
//! and its own `ic`: a sandbox set up from a WSL terminal is kept by that distro's agent (its keeper, updates, backups),
//! and `ic sandbox list --json` names the other side that keeps a sandbox (`keptElsewhere`). This app read the Windows
//! home alone, so it was blind to a WSL agent: it drew WSL's sandboxes as its own and its setup put a second agent on a
//! computer that already ran one. Here every environment is looked at: this app's own home, and on Windows each WSL
//! distro that is RUNNING (found.rs `running_distros`, which never starts a stopped one), through `\\wsl.localhost`.
//!
//! What is read is only whether files are there: an agent's binary (`~/.intentic/machine/bin/intentic-machine`), its
//! pidfile (`machine.pid`, which a running agent holds and a stopped one removes), and `ic` (`~/.intentic/ic/bin/ic`,
//! or a root install). Nothing is started, asked or changed. This device draws it beside the sandboxes, the tray's agent
//! row names the other environments' agents (agent_status.rs), and this computer's own sandbox is not set up unasked
//! where another environment's agent keeps this computer's sandboxes already (machine_sandbox.rs `decide`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

/// One environment of this computer, and what of Intentic's machine side it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    /// `windows` or `linux` for this app's own, `wsl` for a distro of this PC.
    pub kind: &'static str,
    /// The distro's name, for `wsl`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
    /// This app's own environment: the one its scripts and its `ic` run in.
    pub here: bool,
    /// A machine agent is installed there.
    pub agent: bool,
    /// Its pidfile is there: it runs, or ran until a crash it has not come back from.
    pub running: bool,
    /// An `ic` is installed there.
    pub ic: bool,
}

impl Environment {
    /// How a person names it: `Windows`, `Linux`, `WSL (archlinux)`.
    pub fn label(&self) -> String {
        match (self.kind, &self.distro) {
            ("wsl", Some(distro)) => format!("WSL ({distro})"),
            ("wsl", None) => "WSL".to_string(),
            ("windows", _) => "Windows".to_string(),
            _ => "Linux".to_string(),
        }
    }
}

/// What the homes of one environment hold, given which paths exist there. `windows` spells the binaries as Windows
/// does; `system_ic` are the places a root install of `ic` lands, in that environment's spelling. Pure.
pub fn environment_of(
    kind: &'static str,
    distro: Option<String>,
    here: bool,
    homes: &[PathBuf],
    system_ic: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Environment {
    let exe = |name: &str| {
        if kind == "windows" {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    };
    let machine = |home: &PathBuf| home.join(".intentic").join("machine");
    Environment {
        kind,
        distro,
        here,
        agent: homes
            .iter()
            .any(|home| exists(&machine(home).join("bin").join(exe("intentic-machine")))),
        running: homes
            .iter()
            .any(|home| exists(&machine(home).join("machine.pid"))),
        ic: homes.iter().any(|home| {
            exists(
                &home
                    .join(".intentic")
                    .join("ic")
                    .join("bin")
                    .join(exe("ic")),
            )
        }) || system_ic.iter().any(|path| exists(path)),
    }
}

/// The environment another one's agent keeps this computer's sandboxes from, when this app's own environment has no
/// agent of its own: what stops this computer's sandbox being set up here unasked (machine_sandbox.rs). One that only
/// has an agent installed and not running is not keeping anything. Pure.
pub fn elsewhere(environments: &[Environment]) -> Option<String> {
    if environments.iter().any(|env| env.here && env.agent) {
        return None;
    }
    environments
        .iter()
        .find(|env| !env.here && env.agent && env.running)
        .map(Environment::label)
}

/// The other environments whose agent runs, by name: what the tray's agent row adds after this one's. Pure.
pub fn others_running(environments: &[Environment]) -> Vec<String> {
    environments
        .iter()
        .filter(|env| !env.here && env.agent && env.running)
        .map(Environment::label)
        .collect()
}

/// The people's homes in a distro whose `/` is `root`: root's own (the default user of some distros, Arch's among
/// them) and each folder under `/home`, as found.rs reads them.
fn distro_homes(root: &Path) -> Vec<PathBuf> {
    let mut homes = vec![root.join("root")];
    if let Ok(entries) = std::fs::read_dir(root.join("home")) {
        homes.extend(
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .take(8)
                .map(|entry| entry.path()),
        );
    }
    homes
}

/// This app's own environment.
fn here() -> Environment {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from);
    let (kind, system_ic) = if cfg!(windows) {
        ("windows", Vec::new())
    } else {
        ("linux", vec![PathBuf::from("/usr/local/bin/ic")])
    };
    environment_of(
        kind,
        None,
        true,
        &home.into_iter().collect::<Vec<_>>(),
        &system_ic,
        Path::exists,
    )
}

/// Every environment of this computer, read now: this one, and each running WSL distro.
fn read() -> Vec<Environment> {
    let mut environments = vec![here()];
    for (name, root) in crate::found::running_distros() {
        let homes = distro_homes(&root);
        let system_ic = [root.join("usr").join("local").join("bin").join("ic")];
        environments.push(environment_of(
            "wsl",
            Some(name),
            false,
            &homes,
            &system_ic,
            Path::exists,
        ));
    }
    environments
}

/// How long one reading answers again: This device asks every 30 seconds and the tray every minute, and a reading of a
/// distro's files goes through WSL's file server.
const FRESH: Duration = Duration::from_secs(60);

static LAST: Mutex<Option<(Instant, Vec<Environment>)>> = Mutex::new(None);

/// Every environment of this computer, as last read within [`FRESH`]. BLOCKING: on Windows it asks `wsl.exe` which
/// distros run, and reads their files.
pub fn find() -> Vec<Environment> {
    if let Ok(held) = LAST.lock() {
        if let Some((at, environments)) = held.as_ref() {
            if at.elapsed() < FRESH {
                return environments.clone();
            }
        }
    }
    let environments = read();
    if let Ok(mut held) = LAST.lock() {
        *held = Some((Instant::now(), environments.clone()));
    }
    environments
}

/// Every environment of this computer and the machine agent each holds, for This device.
#[tauri::command]
pub async fn machine_agents() -> Vec<Environment> {
    tauri::async_runtime::spawn_blocking(find)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn existing(paths: &[&str]) -> impl Fn(&Path) -> bool {
        let held: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        move |path: &Path| held.contains(path)
    }

    #[test]
    fn a_distros_agent_and_ic_are_found_in_any_of_its_homes() {
        let root = PathBuf::from("/wsl/archlinux");
        let homes = vec![root.join("root"), root.join("home").join("ada")];
        let env = environment_of(
            "wsl",
            Some("archlinux".into()),
            false,
            &homes,
            &[root.join("usr/local/bin/ic")],
            existing(&[
                "/wsl/archlinux/root/.intentic/machine/bin/intentic-machine",
                "/wsl/archlinux/root/.intentic/machine/machine.pid",
                "/wsl/archlinux/usr/local/bin/ic",
            ]),
        );
        assert!(env.agent && env.running && env.ic);
        assert_eq!(env.label(), "WSL (archlinux)");

        let bare = environment_of(
            "wsl",
            Some("ubuntu".into()),
            false,
            &homes,
            &[],
            existing(&[]),
        );
        assert!(!bare.agent && !bare.running && !bare.ic);
    }

    #[test]
    fn windows_binaries_are_looked_for_by_their_windows_names() {
        let home = vec![PathBuf::from("C:/Users/ada")];
        let env = environment_of(
            "windows",
            None,
            true,
            &home,
            &[],
            existing(&[
                "C:/Users/ada/.intentic/machine/bin/intentic-machine.exe",
                "C:/Users/ada/.intentic/ic/bin/ic.exe",
            ]),
        );
        assert!(env.agent && env.ic && !env.running);
        assert_eq!(env.label(), "Windows");
    }

    fn env(
        kind: &'static str,
        distro: Option<&str>,
        here: bool,
        agent: bool,
        running: bool,
    ) -> Environment {
        Environment {
            kind,
            distro: distro.map(str::to_string),
            here,
            agent,
            running,
            ic: agent,
        }
    }

    /// The setup checks first: another environment's running agent keeps this computer's sandboxes only while this one
    /// has no agent of its own. With one here, the setup uses it and installs nothing.
    #[test]
    fn another_environments_agent_counts_only_where_this_one_has_none() {
        let windows_bare = env("windows", None, true, false, false);
        let windows_agent = env("windows", None, true, true, true);
        let arch = env("wsl", Some("archlinux"), false, true, true);
        let ubuntu_installed_only = env("wsl", Some("ubuntu"), false, true, false);
        assert_eq!(
            elsewhere(&[
                windows_bare.clone(),
                ubuntu_installed_only.clone(),
                arch.clone()
            ]),
            Some("WSL (archlinux)".to_string())
        );
        assert_eq!(elsewhere(&[windows_agent.clone(), arch.clone()]), None);
        assert_eq!(
            elsewhere(&[windows_bare.clone(), ubuntu_installed_only]),
            None
        );
        assert_eq!(elsewhere(&[windows_bare]), None);
        assert_eq!(
            others_running(&[windows_agent, arch]),
            vec!["WSL (archlinux)".to_string()]
        );
    }
}
