/* THE STEPS OF AN UNINSTALL, one function each, in the order plan.rs gives them. Each answers how it ended rather than
stopping the run: a step that could not finish leaves its thing behind with the command that finishes it, and the steps
after it still run, because an uninstall that stops halfway leaves more behind than one that carries on and names what
is left. Only what is Intentic's is touched: Docker objects by our own name families (never the `intentic-app-*`
deployments a server runs for its owner), files under ic's own home, the app's own folders. */

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::host;
use super::inventory::{self, Inventory};
use super::plan::Choice;
use crate::docker;
use crate::engine::leave as engine;
use crate::sandbox::remove::{as_invoking_user, machine_agent, machine_dir};
use crate::sandbox::trash;
use crate::ui;

/// How one step ended.
pub enum End {
    Done(Option<String>),
    /// Nothing to do here after all, and why.
    Skipped(String),
    /// Something stays: what it is, and the command that finishes it.
    Left {
        problem: String,
        fix: String,
    },
}

fn left(problem: impl Into<String>, fix: impl Into<String>) -> End {
    End::Left {
        problem: problem.into(),
        fix: fix.into(),
    }
}

/// Stop what would put back what the uninstall removes: the app (its engine keeper, its supervisor that makes this
/// device's own sandbox) and, when everything goes, the resident agent, whose keeper restarts sandboxes and Docker.
pub fn stop(inventory: &Inventory, choice: Choice, without_app: bool) -> End {
    if inventory.app.is_some() && !without_app {
        host::stop_app();
    }
    if choice == Choice::Everything {
        if let Some(agent) = machine_agent() {
            let mut command = as_invoking_user(&agent);
            command.args(["run", "--stop"]);
            let _ = docker::bounded(command, Duration::from_secs(60));
        }
    }
    End::Done(None)
}

/// Inside each WSL distro of this PC: its own ic does its own uninstall (nested: this run already asked), and where a
/// distro has only an agent, the agent's own purge. An ic too old to know `uninstall` answers 2, and the agent is asked.
pub fn distros(inventory: &Inventory) -> End {
    let mut stuck = Vec::new();
    for distro in &inventory.facts.distros {
        ui::note(&format!("Removing Intentic from {distro}."));
        let ran = docker::run_bounded(
            "wsl.exe",
            &["-d", distro, "--exec", "sh", "-lc", INSIDE_A_DISTRO],
            Duration::from_secs(20 * 60),
        );
        match ran {
            Ok(ran) if ran.code == Some(0) => {}
            Ok(ran) => stuck.push(format!(
                "{distro} ({})",
                last_line(&ran.stderr).unwrap_or("it did not finish")
            )),
            Err(fail) => stuck.push(format!("{distro} ({})", fail.0)),
        }
    }
    if stuck.is_empty() {
        End::Done(None)
    } else {
        left(
            format!("Intentic could not be removed from {}.", stuck.join(", ")),
            "in that distro, run: ic uninstall",
        )
    }
}

/// What runs inside a distro: whichever ic is there, else the agent, else nothing.
const INSIDE_A_DISTRO: &str = r#"for ic in "$HOME/.intentic/ic/bin/ic" /usr/local/bin/ic; do
  if [ -x "$ic" ]; then
    "$ic" uninstall --nested --delete-data --without-app </dev/null
    code=$?
    [ "$code" = 2 ] || exit "$code"
    break
  fi
done
agent="$HOME/.intentic/machine/bin/intentic-machine"
if [ -x "$agent" ]; then "$agent" uninstall --purge --delete-data </dev/null; exit $?; fi
exit 0"#;

fn last_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).rfind(|line| !line.is_empty())
}

/// Every sandbox and runner deleted, each through the same removal `ic sandbox remove --now` makes (the platform hears
/// it leave, its sync pairings are retired), then what no sandbox names any more: orphan volumes and networks, the
/// shared logins volume, and our images.
pub fn sandboxes(inventory: &Inventory) -> End {
    if !inventory.facts.docker && !wake_engine(inventory) {
        // The engine about to be removed takes every sandbox in it along; anywhere else the data is out of reach.
        if inventory.facts.engine && !inventory.facts.engine_holds_others {
            return End::Done(Some(
                "Docker did not answer; the sandboxes go with the intentic engine.".to_string(),
            ));
        }
        if inventory.facts.sandboxes == 0 {
            return End::Skipped(
                "Docker is not running here, so there is nothing of Intentic's in it to delete."
                    .to_string(),
            );
        }
        return left(
            "Docker did not answer, so the sandboxes on this device could not be deleted.",
            "start Docker, then run ic uninstall again",
        );
    }
    let mut slugs = crate::sandbox::list_slugs();
    slugs.extend(trash::list().into_iter().map(|entry| entry.slug));
    let slugs = crate::sandbox::each_once(slugs);
    let mut failed = Vec::new();
    for slug in &slugs {
        match crate::sandbox::remove::delete_within_a_step(slug) {
            Ok(()) => ui::note(&format!("Deleted {slug}.")),
            Err(why) => failed.push(why),
        }
    }
    crate::sandbox::remove::sweep_orphans(true);
    let auth_gone = crate::sandbox::remove::delete_agent_auth_within_a_step();
    let swept = sweep_ours(&|args| docker::try_capture(args), &|args| {
        docker::quiet(args)
    });
    #[cfg(windows)]
    let swept = swept + sweep_docker_desktop();
    if swept > 0 {
        ui::note(&format!(
            "Also deleted {} of Intentic's {} that no sandbox used any more.",
            swept,
            if swept == 1 {
                "leftover image, volume or network"
            } else {
                "leftover images, volumes and networks"
            }
        ));
    }
    if !failed.is_empty() {
        return left(
            format!("{}.", failed.join("; ")),
            "ic uninstall, once Docker answers",
        );
    }
    if !auth_gone {
        return left(
            "the shared AI-logins volume is still in use by a container.",
            format!("docker volume rm {}", crate::sandbox::remove::auth_volume()),
        );
    }
    End::Done(None)
}

/// A PC whose sandboxes run on our engine while it is down: started, so each sandbox's platform record hears it leave
/// rather than waiting out its silence. True when Docker answers now.
fn wake_engine(inventory: &Inventory) -> bool {
    if !inventory.facts.engine || crate::engine::in_use() != crate::engine::Kind::Intentic {
        return false;
    }
    ui::note("Starting the intentic engine, so each sandbox can be deleted properly.");
    crate::engine::start().is_ok() && docker::daemon_reachable()
}

/// The kinds of Docker object the sweep lists, and how.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Container,
    Volume,
    Network,
    Image,
}

/// Whether a Docker object of `kind` named `name` is Intentic's own: a sandbox's or a runner's containers (live, parked,
/// moved, in the trash), its volumes and network, the trash markers and move copies, and the images ic builds or pulls
/// for sandboxes. Never `intentic-app-*`: those are the deployments a server runs for its owner. Pure.
pub fn ours(kind: Kind, name: &str) -> bool {
    if name.starts_with("intentic-app-") {
        return false;
    }
    match kind {
        Kind::Container => [
            "intentic-sandbox-",
            "intentic-trash-",
            "intentic-dind-host-",
            "intentic-backup-",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix)),
        Kind::Volume => [
            "intentic-workspace-",
            "intentic-history-",
            "intentic-docker-",
            "intentic-dind-docker-",
            "intentic-trashed-",
            "intentic-move-",
            "intentic-dev-agent-auth",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix)),
        Kind::Network => name.starts_with("intentic-workspace-"),
        Kind::Image => {
            let repository = name
                .rsplit_once(':')
                .map_or(name, |(repository, _)| repository);
            repository == "ghcr.io/intentic/sandbox"
                || repository.starts_with("intentic-sandbox-")
                || repository.starts_with("intentic-moved-")
        }
    }
}

/// Delete every object of ours on one Docker, containers first (they hold the rest). `list` and `remove` are the
/// docker calls, so a test drives it without one. Answers how many went.
pub fn sweep_ours(list: &dyn Fn(&[&str]) -> Option<String>, remove: &dyn Fn(&[&str])) -> usize {
    let mut swept = 0;
    let passes: [(Kind, &[&str], &[&str]); 4] = [
        (
            Kind::Container,
            &["ps", "-a", "--format", "{{.Names}}"],
            &["rm", "-f"],
        ),
        (
            Kind::Volume,
            &["volume", "ls", "--format", "{{.Name}}"],
            &["volume", "rm", "-f"],
        ),
        (
            Kind::Network,
            &["network", "ls", "--format", "{{.Name}}"],
            &["network", "rm"],
        ),
        // By id: an image a rebuild untagged is listed `<repository>:<none>`, which is no name docker takes back.
        (
            Kind::Image,
            &[
                "image",
                "ls",
                "--format",
                "{{.Repository}}:{{.Tag}} {{.ID}}",
            ],
            &["image", "rm", "-f"],
        ),
    ];
    for (kind, listing, removal) in passes {
        let Some(names) = list(listing) else {
            continue;
        };
        let mut done: Vec<&str> = Vec::new();
        for line in names.lines().map(str::trim) {
            let (name, handle) = match line.split_once(' ') {
                Some((name, id)) if kind == Kind::Image => (name, id.trim()),
                _ => (line, line),
            };
            if !ours(kind, name) || handle.is_empty() || done.contains(&handle) {
                continue;
            }
            done.push(handle);
            let mut args: Vec<&str> = removal.to_vec();
            args.push(handle);
            remove(&args);
            swept += 1;
        }
    }
    swept
}

/// Docker Desktop's copies of ours, on a PC whose sandboxes moved to our engine: what a move leaves for a week, and the
/// images it pulled before. Only when Docker Desktop answers; it is never started for this.
#[cfg(windows)]
fn sweep_docker_desktop() -> usize {
    if !docker::intentic_engine_in_use() || !crate::engine::docker_desktop_installed() {
        return 0;
    }
    let target = docker::Target::DockerDesktop;
    let answers = docker::capture_on(
        &target,
        &["info", "--format", "{{.ID}}"],
        Duration::from_secs(15),
    )
    .is_ok_and(|ran| ran.code == Some(0));
    if !answers {
        return 0;
    }
    sweep_ours(
        &|args| {
            docker::capture_on(&target, args, Duration::from_secs(30))
                .ok()
                .filter(|ran| ran.code == Some(0))
                .map(|ran| ran.stdout)
        },
        &|args| {
            let _ = docker::capture_on(&target, args, Duration::from_secs(120));
        },
    )
}

/// The agent's own purge: its links, sync, Mutagen, keyring, login entries, PATH entry and files
/// (`intentic-machine uninstall --purge --delete-data`). It narrates under this step. An agent from before `--purge`
/// refuses the flag (2), and its plain uninstall runs instead: what that leaves is ic's to delete in the files step.
pub fn agent(inventory: &Inventory) -> End {
    let Some(agent) = machine_agent() else {
        if inventory.facts.passwords {
            let keyring = intentic_root().join("keyring");
            return if host::remove_path(&keyring, 3) {
                End::Done(None)
            } else {
                left(
                    format!("{} could not be deleted.", keyring.display()),
                    format!("delete {}", keyring.display()),
                )
            };
        }
        return End::Skipped("No machine agent is installed here.".to_string());
    };
    let run = |args: &[&str]| -> Option<i32> {
        let mut command = as_invoking_user(&agent);
        command.args(args);
        if ui::is_rich() {
            command.env("INTENTIC_UI", "nested");
        }
        ui::suspend();
        let status = command.status();
        ui::resume();
        status.ok().and_then(|status| status.code())
    };
    match run(&["uninstall", "--purge", "--delete-data"]) {
        Some(0) => End::Done(None),
        Some(code) if older_agent(code) => match run(&["uninstall"]) {
            Some(0) => End::Done(Some(
                "An older machine agent: its links and login entry are gone, and its files go with Intentic's.".to_string(),
            )),
            _ => left("the machine agent could not remove itself.", "ic uninstall"),
        },
        _ => left(
            "the machine agent could not remove everything of its own; what it said is above.",
            "ic uninstall",
        ),
    }
}

/// Whether an agent's exit code is it refusing `--purge` as a flag it does not know: stricli's invalid-argument code,
/// -4, which a Unix exit status reads as 252 and Windows hands over as -4 itself; 2 is the usual CLI word for it too.
/// Pure.
pub fn older_agent(code: i32) -> bool {
    matches!(code, 2 | 252 | -4)
}

/// KEEP SANDBOXES: only the folders the agent syncs to this device stop; the agent stays to keep the sandboxes up.
pub fn sync(inventory: &Inventory) -> End {
    let Some(agent) = machine_agent() else {
        return End::Skipped("No machine agent is installed here.".to_string());
    };
    let mut command = as_invoking_user(&agent);
    command.args(["sync", "uninstall", "--folders"]);
    match docker::bounded(command, Duration::from_secs(5 * 60)) {
        Ok(ran) if ran.code == Some(0) => End::Done(Some(
            if inventory.facts.folders == 1 {
                "The synced folder keeps its files."
            } else {
                "The synced folders keep their files."
            }
            .to_string(),
        )),
        _ => left(
            "folder sync to this device did not stop.",
            "intentic-machine sync uninstall --folders",
        ),
    }
}

/// The engine, with its WSL integrations taken out of the distros it served first, and everything of it `ic engine
/// remove` keeps on purpose. It goes only when the plan said so: never while it runs containers that are not ours.
pub fn engine_step() -> End {
    let mut notes = Vec::new();
    for distro in engine::served_distros() {
        if let Err(why) = engine::release_distro(&distro) {
            notes.push(format!("{distro} keeps its docker integration ({why})"));
        }
    }
    if let Err(why) = crate::engine::remove(true) {
        return left(
            format!("the intentic engine was not removed: {}", why.trim()),
            "ic engine remove --yes",
        );
    }
    let stuck = engine::forget_leftovers();
    if !stuck.is_empty() {
        notes.push(format!("{} could not be deleted", stuck.join(", ")));
    }
    if notes.is_empty() {
        End::Done(None)
    } else {
        End::Done(Some(format!("{}.", notes.join("; "))))
    }
}

/// ic's home folder, the one an uninstall clears.
pub fn intentic_root() -> PathBuf {
    crate::logfile::intentic_home()
}

/// The names under ic's home that are Intentic's, for a home moved somewhere shared (`INTENTIC_HOME`), where only these
/// are deleted. Under the default `~/.intentic` everything but ic's own folder goes: the whole folder is Intentic's.
const KNOWN: [&str; 19] = [
    "logs",
    "locks",
    "sessions",
    "image-cache",
    "records-archive",
    "keys",
    "backups",
    "browser",
    "acp",
    "engine",
    "engine-cache",
    "machine",
    "keyring",
    "host",
    "sync",
    "repair-session.json",
    "onboarding-pc-parked.json",
    "onboarding-pc-running.json",
    "trash",
];

/// Whether a name under ic's home is one of ours to delete: the known folders and files, and ic's per-sandbox records
/// (`sandbox-<slug>.channel`, `.channel.before`, `.shape`). Pure.
pub fn known_name(name: &str) -> bool {
    KNOWN.contains(&name)
        || (name.starts_with("sandbox-") && (name.contains(".channel") || name.ends_with(".shape")))
}

/// Whether ic's home is the default `~/.intentic`, a folder that is Intentic's alone.
fn home_is_dedicated() -> bool {
    std::env::var_os("INTENTIC_HOME").is_none_or(|value| value.is_empty())
}

/// EVERYTHING: ic's home emptied but for ic's own folder (the last step's), the image cache wherever it was moved, the
/// installer downloads in the temp folder, and the app's per-user folders unless the app removes itself.
/// KEEP SANDBOXES: only the caches and the app's logs; the records, keys and logs the kept sandboxes need stay.
pub fn files(choice: Choice, without_app: bool, keep_agent: bool) -> End {
    let root = intentic_root();
    let mut stuck: Vec<String> = Vec::new();
    let mut remove = |path: &Path| {
        if !host::remove_path(path, 3) {
            stuck.push(path.display().to_string());
        }
    };
    match choice {
        Choice::Everything => {
            if let Ok(entries) = std::fs::read_dir(&root) {
                let dedicated = home_is_dedicated();
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    // ic is the last step's; the agent's folder stays when its own removal failed, since that is
                    // what the next `ic uninstall` finishes it with.
                    if name == "ic"
                        || (keep_agent && name == "machine")
                        || (!dedicated && !known_name(&name))
                    {
                        continue;
                    }
                    remove(&entry.path());
                }
            }
            for path in inventory::cache_paths() {
                remove(&path);
            }
            for log in temp_logs() {
                remove(&log);
            }
        }
        Choice::KeepSandboxes => {
            for path in inventory::cache_paths()
                .into_iter()
                .filter(|path| !path.ends_with("logs"))
            {
                remove(&path);
            }
            if let Ok(entries) = std::fs::read_dir(root.join("logs")) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if ["desktop-", "prefetch-", "explorer-menu"]
                        .iter()
                        .any(|prefix| name.starts_with(prefix))
                    {
                        remove(&entry.path());
                    }
                }
            }
            for name in [
                "repair-session.json",
                "onboarding-pc-parked.json",
                "onboarding-pc-running.json",
            ] {
                remove(&root.join(name));
            }
        }
    }
    if !without_app {
        stuck.extend(host::remove_app_files());
    }
    if stuck.is_empty() {
        End::Done(None)
    } else {
        left(
            format!(
                "{} could not be deleted: a program still holds {}.",
                stuck.join(", "),
                if stuck.len() == 1 { "it" } else { "them" }
            ),
            "close Intentic and anything run from it, then run ic uninstall again",
        )
    }
}

/// The logs an elevated step of `ic docker prepare` wrote in the temp folder (prepare/shell.rs).
fn temp_logs() -> Vec<PathBuf> {
    std::fs::read_dir(std::env::temp_dir())
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("intentic-elevated-")
                })
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default()
}

/// The desktop app, through whatever installed it.
pub fn app(inventory: &Inventory) -> End {
    let Some(app) = &inventory.app else {
        return End::Skipped("The Intentic app is not installed here.".to_string());
    };
    match host::remove_app(app) {
        host::AppRemoval::Done => End::Done(None),
        host::AppRemoval::Left { problem, fix } => left(problem, fix),
    }
}

/// ic itself, last: the PATH entries and links the scripts made for it and the agent, its folder, and the binary,
/// which on Windows is moved aside and deleted once this process has exited. Then ic's home, if nothing is left in it.
pub fn ic() -> End {
    let root = intentic_root();
    let ic_dir = root.join("ic");
    let mut problems = Vec::new();
    let bins = [ic_dir.join("bin"), machine_dir().join("bin")];
    if let Some(problem) = host::unlink_commands(&bins) {
        problems.push(problem);
    }
    let exe = ic_dir
        .join("bin")
        .join(if cfg!(windows) { "ic.exe" } else { "ic" });
    if let Some(problem) = host::remove_binary(&exe) {
        problems.push(problem);
    }
    if !host::remove_path(&ic_dir, 3) {
        problems.push(format!("{} could not be deleted", ic_dir.display()));
    }
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut fix = "delete what is named above".to_string();
    #[cfg(unix)]
    {
        // A root install's copy (connect.sh as root): removed when this run is root, else said with the command.
        let system = Path::new("/usr/local/bin/ic");
        if system.exists() && is_ic(system) {
            if docker::is_root() {
                if let Some(problem) = host::remove_binary(system) {
                    problems.push(problem);
                }
            } else {
                problems.push("/usr/local/bin/ic was installed as root".to_string());
                fix = "sudo rm /usr/local/bin/ic".to_string();
            }
        }
    }
    host::remove_if_empty(&root);
    if root.exists() {
        let left_over: Vec<String> = std::fs::read_dir(&root)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        if !left_over.is_empty() && home_is_dedicated() {
            problems.push(format!(
                "{} still holds {}",
                root.display(),
                left_over.join(", ")
            ));
        }
    }
    if problems.is_empty() {
        End::Done(None)
    } else {
        left(format!("{}.", problems.join("; ")), fix)
    }
}

#[cfg(unix)]
fn is_ic(path: &Path) -> bool {
    docker::run_bounded(
        &path.to_string_lossy(),
        &["--version"],
        Duration::from_secs(10),
    )
    .is_ok_and(|ran| ran.stdout.starts_with("ic "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn only_intentics_own_docker_objects_are_swept() {
        assert!(ours(Kind::Container, "intentic-sandbox-ab12"));
        assert!(ours(Kind::Container, "intentic-sandbox-ab12.moved"));
        assert!(ours(Kind::Container, "intentic-trash-ab12"));
        assert!(!ours(Kind::Container, "intentic-app-web"));
        assert!(!ours(Kind::Container, "postgres"));
        assert!(ours(Kind::Volume, "intentic-workspace-ab12"));
        assert!(ours(Kind::Volume, "intentic-trashed-1790000000-ab12"));
        assert!(!ours(Kind::Volume, "intentic-app-db"));
        assert!(ours(Kind::Network, "intentic-workspace-ab12"));
        assert!(!ours(Kind::Network, "bridge"));
        assert!(ours(Kind::Image, "ghcr.io/intentic/sandbox:stable"));
        assert!(ours(Kind::Image, "intentic-sandbox-env-ab12:0123456789ab"));
        assert!(!ours(Kind::Image, "ghcr.io/intentic/sandbox-tools:1"));
        assert!(!ours(Kind::Image, "node:22"));
    }

    #[test]
    fn the_sweep_removes_containers_before_what_they_hold() {
        let removed = RefCell::new(Vec::new());
        let swept = sweep_ours(
            &|args| {
                Some(
                    match args[0] {
                        "ps" => "intentic-sandbox-a\nweb\n",
                        "volume" => "intentic-workspace-a\nmine\n",
                        "network" => "bridge\nintentic-workspace-a\n",
                        _ => "ghcr.io/intentic/sandbox:stable 1a\nghcr.io/intentic/sandbox:1.2 1a\nintentic-sandbox-env-a:<none> 2b\nnode:22 3c\n",
                    }
                    .to_string(),
                )
            },
            &|args| removed.borrow_mut().push(args.join(" ")),
        );
        assert_eq!(swept, 5);
        assert_eq!(
            removed.into_inner(),
            vec![
                "rm -f intentic-sandbox-a",
                "volume rm -f intentic-workspace-a",
                "network rm intentic-workspace-a",
                "image rm -f 1a",
                "image rm -f 2b",
            ]
        );
    }

    #[test]
    fn an_agent_that_does_not_know_purge_is_told_apart_from_one_that_failed() {
        assert!(older_agent(252));
        assert!(older_agent(-4));
        assert!(older_agent(2));
        assert!(!older_agent(1));
        assert!(!older_agent(0));
    }

    #[test]
    fn a_shared_home_loses_only_intentics_names() {
        assert!(known_name("logs"));
        assert!(known_name("sandbox-ab12.channel"));
        assert!(known_name("sandbox-ab12.channel.before"));
        assert!(known_name("sandbox-ab12.shape"));
        assert!(!known_name("ic"));
        assert!(!known_name("projects"));
        assert!(!known_name("sandbox-notes.txt"));
    }
}
