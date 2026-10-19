/* WHAT AN UNINSTALL DOES, decided before anything is touched, from what this device holds (`Facts`) and what the person
asked for (`Asked`). Everything here is pure: the inventory gathers the facts (inventory.rs), mod.rs asks and runs, and
this file is the part a test holds to — which question is asked, which flag answers it, which steps run and what every
sentence says.

Two outcomes, and only two, because a third is a sandbox nobody can use:
- EVERYTHING: the sandboxes and runners with their data, the saved passwords, the intentic engine, the machine agent,
  folder sync, ic, the desktop app, caches and logs. Nothing of Intentic stays.
- KEEP SANDBOXES: the sandboxes stay and keep running, so whatever keeps them up stays with them: the engine they run
  on, the machine agent that starts them at sign-in and keeps them connected, ic, which the engine's sign-in start runs,
  and the keyring their agents ask. Only the app, folder sync and the caches go.
A "keep the data but remove what runs it" outcome was left out on purpose: a removed sandbox's volumes are recoverable
only through ic, a removal's trash is swept only by ic, and its at-rest key lives in ic's home, so the data kept that
way is a leftover nobody can read.

Data — a sandbox's files, the saved passwords — is never deleted by an unattended run: `--yes` keeps it, and only
`--delete-data` (with `--confirm <n>` when there are sandboxes, or the count typed) deletes it. On a terminal the pick
offers EVERYTHING first, because that is what someone uninstalling a product asked for, and the typed count is what
stands between Enter and a deletion — so the protocol's "the safe answer is the default" still holds: nothing is
deleted by a default. */

use serde::Serialize;

use crate::util::plural;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Choice {
    Everything,
    KeepSandboxes,
}

impl Choice {
    pub fn id(self) -> &'static str {
        match self {
            Choice::Everything => "everything",
            Choice::KeepSandboxes => "keep-sandboxes",
        }
    }
}

/// What the device holds, as the plan and the questions need it. Filled by inventory.rs; built by hand in tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    pub windows: bool,
    /// Sandboxes and runners, the recoverable ones included: what a deletion takes, and what `--confirm` must name.
    pub sandboxes: usize,
    /// Their data, when docker could say.
    pub data_bytes: Option<u64>,
    /// A keyring vault is on this device.
    pub passwords: bool,
    /// Docker answered, so there may be images and volumes of ours to delete even with no sandbox.
    pub docker: bool,
    /// Our engine is installed here (Windows).
    pub engine: bool,
    pub engine_bytes: Option<u64>,
    /// The engine also runs containers that are not Intentic's (a WSL distro's own, through `ic engine wsl`): it is
    /// not ours alone to delete, so it stays and the summary says how to remove it.
    pub engine_holds_others: bool,
    pub agent: bool,
    /// Folders the agent syncs to this device. Their files stay whatever happens.
    pub folders: usize,
    /// WSL distros that hold an agent or are served by our engine (Windows).
    pub distros: Vec<String>,
    pub app: bool,
    pub cache_bytes: u64,
    /// This is a server that runs deployments for its owner (`ic machine enroll`, /opt/intentic): they are not part of
    /// an uninstall, and ic, which manages and removes them (`ic machine remove`), stays with them.
    pub deploys: bool,
    /// Things on this device that are not Intentic's and stay, as a person names them.
    pub stays: Vec<String>,
}

impl Facts {
    /// Anything of the person's own that an uninstall could delete.
    pub fn has_data(&self) -> bool {
        self.sandboxes > 0 || self.passwords
    }
}

/// What the command line asked for.
#[derive(Debug, Clone, Default)]
pub struct Asked {
    pub keep_sandboxes: bool,
    pub delete_data: bool,
    pub confirm: Option<String>,
    pub yes: bool,
    /// A person is at a terminal to ask.
    pub interactive: bool,
    /// Run by an outer `ic uninstall` (inside a WSL distro) that has already asked.
    pub nested: bool,
}

/// What happens before anything is touched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Go ahead with this outcome.
    Go(Choice),
    /// Ask a yes/no about this outcome (no data is deleted by it, or the deletion was named on the command line).
    Confirm(Choice),
    /// Ask which outcome: there is data, and nothing on the command line said what to do with it.
    Pick,
    /// Ask for the count of sandboxes typed: EVERYTHING was chosen and it deletes sandboxes.
    Typed,
    /// Stop without touching anything, with a message for `ui::error`.
    Stop(String),
}

/// The flag-and-terminal rules. Pure.
pub fn decide(facts: &Facts, asked: &Asked) -> Decision {
    let count = facts.sandboxes.to_string();
    if asked.keep_sandboxes {
        return if asked.yes || asked.nested {
            Decision::Go(Choice::KeepSandboxes)
        } else if asked.interactive {
            Decision::Confirm(Choice::KeepSandboxes)
        } else {
            Decision::Stop(nobody("--keep-sandboxes --yes"))
        };
    }
    if asked.delete_data {
        if facts.sandboxes > 0 && !asked.nested {
            return match asked.confirm.as_deref() {
                Some(given) if given == count => Decision::Go(Choice::Everything),
                Some(given) => Decision::Stop(crate::ui::explain(
                    "Nothing was uninstalled.",
                    Some(&format!(
                        "--confirm names {given}, and this device holds {}.",
                        plural(facts.sandboxes, "sandbox")
                    )),
                    Some(&format!("ic uninstall --dry-run, then --confirm {count}")),
                )),
                None if asked.interactive => Decision::Typed,
                None => Decision::Stop(nobody(&format!("--delete-data --confirm {count}"))),
            };
        }
        return if asked.yes || asked.nested {
            Decision::Go(Choice::Everything)
        } else if asked.interactive {
            Decision::Confirm(Choice::Everything)
        } else {
            Decision::Stop(nobody("--delete-data --yes"))
        };
    }
    if !facts.has_data() {
        return if asked.yes || asked.nested {
            Decision::Go(Choice::Everything)
        } else if asked.interactive {
            Decision::Confirm(Choice::Everything)
        } else {
            Decision::Stop(nobody("--yes"))
        };
    }
    if asked.yes || asked.nested {
        // Never a deletion nobody asked for by name: an unattended uninstall keeps the person's data, and so what
        // keeps it running.
        return Decision::Go(Choice::KeepSandboxes);
    }
    if asked.interactive {
        Decision::Pick
    } else {
        Decision::Stop(crate::ui::explain(
            "Nothing was uninstalled.",
            Some(&format!(
                "nobody is at this terminal to say what happens to {}.",
                data_phrase(facts)
            )),
            Some(&if facts.sandboxes > 0 {
                format!("--yes keeps them; --delete-data --confirm {count} deletes them")
            } else {
                "--yes keeps them; --delete-data --yes deletes them".to_string()
            }),
        ))
    }
}

fn nobody(flags: &str) -> String {
    crate::ui::explain(
        "Nothing was uninstalled.",
        Some("nobody is at this terminal to answer."),
        Some(&format!("run it again with {flags}")),
    )
}

/// One step of an uninstall, as the wire names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Stop what would undo the uninstall while it runs: the app, the resident agent.
    Stop,
    /// Inside each WSL distro (Windows).
    Distros,
    Sandboxes,
    Agent,
    /// KEEP SANDBOXES: folder sync only, the agent stays.
    Sync,
    Engine,
    Files,
    App,
    Ic,
}

impl Step {
    pub fn id(self) -> &'static str {
        match self {
            Step::Stop => "stop",
            Step::Distros => "distros",
            Step::Sandboxes => "sandboxes",
            Step::Agent => "agent",
            Step::Sync => "sync",
            Step::Engine => "engine",
            Step::Files => "files",
            Step::App => "app",
            Step::Ic => "ic",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub step: Step,
    pub label: String,
}

fn planned(step: Step, label: impl Into<String>) -> Planned {
    Planned {
        step,
        label: label.into(),
    }
}

/// The steps an outcome runs on this device, in order, each labelled the way the checklist shows it. Pure.
///
/// The order is the argument. What would undo the work stops first (the app's engine keeper, the agent's keeper that
/// restarts sandboxes); the sandboxes go while the agent can still retire their sync pairings and the engine still
/// holds them, so the platform hears each one leave; the agent goes before the engine, since its keeper would start
/// the engine again; ic goes last, because it is what is running.
pub fn steps(facts: &Facts, choice: Choice, without_app: bool) -> Vec<Planned> {
    let app = facts.app && !without_app;
    let mut planned_steps = Vec::new();
    match choice {
        Choice::Everything => {
            if facts.agent || app {
                planned_steps.push(planned(Step::Stop, "Stop Intentic"));
            }
            if facts.windows && !facts.distros.is_empty() {
                planned_steps.push(planned(
                    Step::Distros,
                    format!("Remove Intentic from {}", wsl_names(&facts.distros)),
                ));
            }
            if facts.sandboxes > 0 {
                planned_steps.push(planned(
                    Step::Sandboxes,
                    format!("Delete {}", plural(facts.sandboxes, "sandbox")),
                ));
            } else if facts.docker {
                planned_steps.push(planned(
                    Step::Sandboxes,
                    "Delete Intentic's images and volumes",
                ));
            }
            if facts.agent {
                planned_steps.push(planned(Step::Agent, agent_label(facts)));
            } else if facts.passwords {
                planned_steps.push(planned(Step::Agent, "Delete your saved passwords"));
            }
            if facts.engine && !facts.engine_holds_others {
                planned_steps.push(planned(Step::Engine, "Remove the intentic engine"));
            }
            planned_steps.push(planned(Step::Files, "Delete Intentic's files and caches"));
            if app {
                planned_steps.push(planned(Step::App, "Uninstall the Intentic app"));
            }
            if !facts.deploys {
                planned_steps.push(planned(Step::Ic, "Remove ic"));
            }
        }
        Choice::KeepSandboxes => {
            if app {
                planned_steps.push(planned(Step::Stop, "Close the Intentic app"));
            }
            if facts.agent && facts.folders > 0 {
                planned_steps.push(planned(
                    Step::Sync,
                    format!("Stop syncing {}", plural(facts.folders, "folder")),
                ));
            }
            planned_steps.push(planned(Step::Files, "Delete caches"));
            if app {
                planned_steps.push(planned(Step::App, "Uninstall the Intentic app"));
            }
        }
    }
    planned_steps
}

fn agent_label(facts: &Facts) -> String {
    let mut parts = vec!["the machine agent".to_string()];
    if facts.folders > 0 {
        parts.push("folder sync".to_string());
    }
    if facts.passwords {
        parts.push("your saved passwords".to_string());
    }
    format!("Remove {}", and_list(&parts))
}

fn wsl_names(distros: &[String]) -> String {
    match distros {
        [one] => format!("WSL ({one})"),
        many => format!("{} WSL distros ({})", many.len(), many.join(", ")),
    }
}

/// `a`, `a and b`, `a, b and c`. Pure.
pub fn and_list(parts: &[String]) -> String {
    match parts {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// A count of bytes as a person reads it, rounded the way a disk tool rounds: `4.1 GB`, `820 MB`. Pure.
pub fn size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} bytes")
    } else if value >= 10.0 {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// "your 3 sandboxes (22 GB) and your saved passwords". Pure.
pub fn data_phrase(facts: &Facts) -> String {
    let mut parts = Vec::new();
    if facts.sandboxes > 0 {
        let mut sandboxes = format!("your {}", plural(facts.sandboxes, "sandbox"));
        if let Some(bytes) = facts.data_bytes.filter(|bytes| *bytes > 0) {
            sandboxes.push_str(&format!(" ({})", size(bytes)));
        }
        parts.push(sandboxes);
    }
    if facts.passwords {
        parts.push("your saved passwords".to_string());
    }
    and_list(&parts)
}

/// Everything Intentic has on this device, in one sentence's worth of phrases. Pure.
pub fn found(facts: &Facts) -> Vec<String> {
    let mut parts = Vec::new();
    if facts.app {
        parts.push("the Intentic app".to_string());
    }
    if facts.sandboxes > 0 {
        let mut sandboxes = plural(facts.sandboxes, "sandbox");
        if let Some(bytes) = facts.data_bytes.filter(|bytes| *bytes > 0) {
            sandboxes.push_str(&format!(" ({})", size(bytes)));
        }
        parts.push(sandboxes);
    }
    if facts.passwords {
        parts.push("your saved passwords".to_string());
    }
    if facts.engine {
        parts.push(match facts.engine_bytes.filter(|bytes| *bytes > 0) {
            Some(bytes) => format!("the intentic engine ({})", size(bytes)),
            None => "the intentic engine".to_string(),
        });
    }
    if facts.agent {
        parts.push(if facts.folders > 0 {
            format!(
                "the machine agent syncing {}",
                plural(facts.folders, "folder")
            )
        } else {
            "the machine agent".to_string()
        });
    }
    if facts.windows && !facts.distros.is_empty() {
        parts.push(format!("Intentic in {}", wsl_names(&facts.distros)));
    }
    if facts.cache_bytes > 0 {
        parts.push(format!("{} of caches and logs", size(facts.cache_bytes)));
    }
    parts.push("ic".to_string());
    parts
}

/// What a person is told stays, whatever they chose: what is not Intentic's, and the files of theirs it synced. Pure.
pub fn stays(facts: &Facts) -> Vec<String> {
    let mut stays = facts.stays.clone();
    if facts.deploys {
        stays.push("the deployments this server runs, with ic to manage them (ic machine remove takes them off)".to_string());
    }
    if facts.folders > 0 {
        stays.push("the files in your synced folders".to_string());
    }
    stays
}

/// The question a yes/no asks, and what answering yes does. Pure.
pub fn confirm_question(facts: &Facts, choice: Choice) -> (String, String) {
    match choice {
        Choice::Everything => {
            let mut consequence = format!("This removes {}.", and_list(&found(facts)));
            if facts.has_data() {
                consequence.push_str(&format!(
                    " {} {} deleted for good.",
                    capitalize(&data_phrase(facts)),
                    if facts.sandboxes + usize::from(facts.passwords) == 1 {
                        "is"
                    } else {
                        "are"
                    }
                ));
            }
            if facts.engine && facts.engine_holds_others {
                consequence.push_str(
                    " The intentic engine stays: it also runs containers that are not Intentic's.",
                );
            }
            let stays = stays(facts);
            if !stays.is_empty() {
                consequence.push_str(&format!(" {} stay.", capitalize(&and_list(&stays))));
            }
            (
                "Uninstall Intentic from this device?".to_string(),
                consequence,
            )
        }
        Choice::KeepSandboxes => (
            "Uninstall the Intentic app and keep your sandboxes?".to_string(),
            keep_consequence(facts),
        ),
    }
}

fn keep_consequence(facts: &Facts) -> String {
    let what = if facts.sandboxes > 0 {
        format!(
            "Your {} keep running on this device",
            plural_noun(facts.sandboxes)
        )
    } else {
        "Your saved passwords stay on this device".to_string()
    };
    format!("{what}, with the engine, the machine agent and ic that keep them up. The app, folder sync and caches are removed, and ic uninstall removes the rest later.")
}

fn plural_noun(count: usize) -> String {
    plural(count, "sandbox")
}

/// The pick's question and its two rows, EVERYTHING first. Pure.
pub fn pick_question(facts: &Facts) -> (String, Vec<(String, String)>) {
    let question = format!("What should happen to {}?", data_phrase(facts));
    let everything = format!(
        "delete {}; nothing of Intentic stays on this device",
        data_phrase(facts).replace("your ", "")
    );
    let keep = if facts.sandboxes > 0 {
        "they keep running here; only the app, folder sync and caches go"
    } else {
        "they stay here; only the app, folder sync and caches go"
    };
    (
        question,
        vec![
            ("Remove everything".to_string(), everything),
            (
                if facts.sandboxes > 0 {
                    "Keep my sandboxes"
                } else {
                    "Keep my passwords"
                }
                .to_string(),
                keep.to_string(),
            ),
        ],
    )
}

/// The typed confirmation of a deletion: question and consequence. Pure.
pub fn typed_question(facts: &Facts) -> (String, String) {
    let question = format!("Delete {} for good?", data_phrase(facts));
    let consequence = "Their files and history (/work and /history) are deleted with Intentic. This cannot be undone.".to_string();
    (question, consequence)
}

/// The INI file the Windows uninstaller's page reads (installer-hooks.nsh, ReadINIStr), one `[inventory]` section.
/// Values are single lines: the page shows them as they are. Pure.
pub fn ini(facts: &Facts, sandbox_list: &str) -> String {
    let flag = |on: bool| if on { "1" } else { "0" };
    let line = |text: &str| text.replace(['\r', '\n'], " ");
    let found_sentence = format!("{}.", capitalize(&and_list(&found(facts))));
    let stays_list = stays(facts);
    let stays_sentence = if stays_list.is_empty() {
        String::new()
    } else {
        format!("{} stay.", capitalize(&and_list(&stays_list)))
    };
    [
        "[inventory]".to_string(),
        format!("sandboxes={}", facts.sandboxes),
        format!("deleteCount={}", facts.sandboxes),
        format!("sandboxList={}", line(sandbox_list)),
        format!(
            "dataSize={}",
            facts
                .data_bytes
                .filter(|bytes| *bytes > 0)
                .map(size)
                .unwrap_or_default()
        ),
        format!("passwords={}", flag(facts.passwords)),
        format!(
            "engine={}",
            flag(facts.engine && !facts.engine_holds_others)
        ),
        format!(
            "engineSize={}",
            facts
                .engine_bytes
                .filter(|bytes| *bytes > 0)
                .map(size)
                .unwrap_or_default()
        ),
        format!("agent={}", flag(facts.agent)),
        format!("app={}", flag(facts.app)),
        format!("found={}", line(&found_sentence)),
        format!("stays={}", line(&stays_sentence)),
        String::new(),
    ]
    .join("\r\n")
}

/// The INI's bytes: UTF-16LE behind its byte-order mark. NSIS reads the file through GetPrivateProfileStringW, which
/// takes a file with that mark as Unicode and any other as the ANSI code page, so a UTF-8 distro or sandbox name would
/// reach the page garbled. Pure.
pub fn utf16_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

pub fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The verdict a finished run settles on. Pure.
pub fn verdict(facts: &Facts, choice: Choice, failed: usize) -> String {
    match (choice, failed) {
        (Choice::Everything, 0) => {
            "Intentic is uninstalled. Nothing of it is left on this device.".to_string()
        }
        (Choice::Everything, _) => {
            "Intentic is uninstalled, except for what is listed below.".to_string()
        }
        (Choice::KeepSandboxes, _) if facts.sandboxes > 0 => format!(
            "The Intentic app is uninstalled. Your {} keep running on this device.",
            plural(facts.sandboxes, "sandbox")
        ),
        (Choice::KeepSandboxes, _) => {
            "The Intentic app is uninstalled. Your saved passwords stay on this device.".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device() -> Facts {
        Facts {
            windows: true,
            sandboxes: 3,
            data_bytes: Some(22_000_000_000),
            passwords: true,
            docker: true,
            engine: true,
            engine_bytes: Some(18_000_000_000),
            engine_holds_others: false,
            agent: true,
            folders: 2,
            distros: vec![],
            app: true,
            cache_bytes: 1_400_000_000,
            deploys: false,
            stays: vec!["Docker Desktop".to_string(), "WSL".to_string()],
        }
    }

    fn asked() -> Asked {
        Asked {
            interactive: true,
            ..Asked::default()
        }
    }

    #[test]
    fn a_person_with_data_is_asked_which_outcome() {
        assert_eq!(decide(&device(), &asked()), Decision::Pick);
    }

    #[test]
    fn yes_alone_never_deletes_data() {
        let yes = Asked {
            yes: true,
            ..asked()
        };
        assert_eq!(decide(&device(), &yes), Decision::Go(Choice::KeepSandboxes));
        let unattended = Asked {
            yes: true,
            interactive: false,
            ..Asked::default()
        };
        assert_eq!(
            decide(&device(), &unattended),
            Decision::Go(Choice::KeepSandboxes)
        );
    }

    #[test]
    fn deleting_sandboxes_needs_the_count() {
        let mut flags = Asked {
            delete_data: true,
            yes: true,
            interactive: false,
            ..Asked::default()
        };
        assert!(
            matches!(decide(&device(), &flags), Decision::Stop(stop) if stop.contains("--confirm 3"))
        );
        flags.confirm = Some("2".to_string());
        assert!(
            matches!(decide(&device(), &flags), Decision::Stop(stop) if stop.contains("--confirm names 2"))
        );
        flags.confirm = Some("3".to_string());
        assert_eq!(decide(&device(), &flags), Decision::Go(Choice::Everything));
    }

    #[test]
    fn a_terminal_asked_to_delete_types_the_count() {
        let flags = Asked {
            delete_data: true,
            ..asked()
        };
        assert_eq!(decide(&device(), &flags), Decision::Typed);
    }

    #[test]
    fn passwords_alone_are_deleted_by_naming_the_deletion() {
        let only_passwords = Facts {
            sandboxes: 0,
            data_bytes: None,
            ..device()
        };
        let flags = Asked {
            delete_data: true,
            yes: true,
            interactive: false,
            ..Asked::default()
        };
        assert_eq!(
            decide(&only_passwords, &flags),
            Decision::Go(Choice::Everything)
        );
    }

    #[test]
    fn nothing_of_the_persons_own_is_a_plain_yes_no() {
        let empty = Facts {
            sandboxes: 0,
            data_bytes: None,
            passwords: false,
            ..device()
        };
        assert_eq!(
            decide(&empty, &asked()),
            Decision::Confirm(Choice::Everything)
        );
        let yes = Asked {
            yes: true,
            interactive: false,
            ..Asked::default()
        };
        assert_eq!(decide(&empty, &yes), Decision::Go(Choice::Everything));
    }

    #[test]
    fn nobody_at_the_terminal_stops_and_names_both_flags() {
        let unattended = Asked::default();
        match decide(&device(), &unattended) {
            Decision::Stop(stop) => {
                assert!(stop.contains("--yes keeps them"));
                assert!(stop.contains("--delete-data --confirm 3"));
            }
            other => panic!("expected a stop, got {other:?}"),
        }
    }

    #[test]
    fn a_nested_run_does_what_its_parent_asked() {
        let nested = Asked {
            delete_data: true,
            nested: true,
            ..Asked::default()
        };
        assert_eq!(decide(&device(), &nested), Decision::Go(Choice::Everything));
    }

    #[test]
    fn everything_runs_in_dependency_order() {
        let ids: Vec<&str> = steps(&device(), Choice::Everything, false)
            .iter()
            .map(|planned| planned.step.id())
            .collect();
        assert_eq!(
            ids,
            vec!["stop", "sandboxes", "agent", "engine", "files", "app", "ic"]
        );
    }

    #[test]
    fn an_engine_that_runs_other_containers_stays() {
        let shared = Facts {
            engine_holds_others: true,
            ..device()
        };
        assert!(!steps(&shared, Choice::Everything, false)
            .iter()
            .any(|planned| planned.step == Step::Engine));
        let (_, consequence) = confirm_question(&shared, Choice::Everything);
        assert!(consequence.contains("The intentic engine stays"));
    }

    #[test]
    fn keeping_sandboxes_touches_only_the_app_sync_and_caches() {
        let ids: Vec<&str> = steps(&device(), Choice::KeepSandboxes, false)
            .iter()
            .map(|planned| planned.step.id())
            .collect();
        assert_eq!(ids, vec!["stop", "sync", "files", "app"]);
        let without_app: Vec<&str> = steps(&device(), Choice::KeepSandboxes, true)
            .iter()
            .map(|planned| planned.step.id())
            .collect();
        assert_eq!(without_app, vec!["sync", "files"]);
    }

    #[test]
    fn wsl_distros_are_their_own_step_on_windows() {
        let with_wsl = Facts {
            distros: vec!["Ubuntu".to_string()],
            ..device()
        };
        let labels: Vec<String> = steps(&with_wsl, Choice::Everything, false)
            .into_iter()
            .map(|planned| planned.label)
            .collect();
        assert!(labels.contains(&"Remove Intentic from WSL (Ubuntu)".to_string()));
    }

    #[test]
    fn labels_spell_out_what_goes() {
        let labels: Vec<String> = steps(&device(), Choice::Everything, false)
            .into_iter()
            .map(|planned| planned.label)
            .collect();
        assert_eq!(labels[1], "Delete 3 sandboxes");
        assert_eq!(
            labels[2],
            "Remove the machine agent, folder sync and your saved passwords"
        );
    }

    #[test]
    fn sizes_read_like_a_disk_tool() {
        assert_eq!(size(512), "512 bytes");
        assert_eq!(size(4_100_000_000), "4.1 GB");
        assert_eq!(size(820_000_000), "820 MB");
        assert_eq!(size(22_000_000_000), "22 GB");
    }

    #[test]
    fn the_pick_offers_everything_first() {
        let (question, rows) = pick_question(&device());
        assert_eq!(
            question,
            "What should happen to your 3 sandboxes (22 GB) and your saved passwords?"
        );
        assert_eq!(rows[0].0, "Remove everything");
        assert_eq!(rows[1].0, "Keep my sandboxes");
    }

    #[test]
    fn the_ini_carries_the_count_and_one_line_values() {
        let text = ini(&device(), "sandbox-a (4.1 GB), sandbox-b\nrunner-c");
        assert!(text.starts_with("[inventory]\r\n"));
        assert!(text.contains("deleteCount=3\r\n"));
        assert!(text.contains("sandboxList=sandbox-a (4.1 GB), sandbox-b runner-c\r\n"));
        assert!(text.contains("passwords=1\r\n"));
        assert!(text.contains("engineSize=18 GB\r\n"));
        assert!(text
            .contains("stays=Docker Desktop, WSL and the files in your synced folders stay.\r\n"));
    }

    #[test]
    fn the_ini_is_written_as_windows_reads_unicode() {
        assert_eq!(utf16_with_bom("é"), vec![0xFF, 0xFE, 0xE9, 0x00]);
        assert_eq!(
            utf16_with_bom("a\r\n"),
            vec![0xFF, 0xFE, b'a', 0, b'\r', 0, b'\n', 0]
        );
    }

    #[test]
    fn the_consequence_names_what_is_deleted_and_what_stays() {
        let (question, consequence) = confirm_question(&device(), Choice::Everything);
        assert_eq!(question, "Uninstall Intentic from this device?");
        assert!(consequence
            .contains("Your 3 sandboxes (22 GB) and your saved passwords are deleted for good."));
        assert!(
            consequence.ends_with("Docker Desktop, WSL and the files in your synced folders stay.")
        );
    }

    #[test]
    fn a_server_keeps_ic_for_its_deployments() {
        let server = Facts {
            deploys: true,
            windows: false,
            ..device()
        };
        assert!(!steps(&server, Choice::Everything, false)
            .iter()
            .any(|planned| planned.step == Step::Ic));
        assert!(stays(&server)
            .iter()
            .any(|stay| stay.contains("ic machine remove")));
    }

    #[test]
    fn verdicts() {
        assert_eq!(
            verdict(&device(), Choice::Everything, 0),
            "Intentic is uninstalled. Nothing of it is left on this device."
        );
        assert_eq!(
            verdict(&device(), Choice::KeepSandboxes, 0),
            "The Intentic app is uninstalled. Your 3 sandboxes keep running on this device."
        );
    }
}
