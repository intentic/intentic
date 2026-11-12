//! THE MACHINE AGENT, PUT ON THIS COMPUTER AHEAD OF ITS FIRST SANDBOX (2026-10-22).
//!
//! A folder's sandbox needs `intentic-machine` on this computer to sync the folder, and a computer that never had one
//! downloaded it in the middle of the folder's first setup, inside its sync step (the agent's ~42 MB, which the
//! desktop-sync step's 46 s median is mostly made of on a fresh computer). So at launch, a computer with no agent has
//! one put in place, in the background, by the same bundled sync script a setup runs, told to fetch the agent and stop
//! (`INTENTIC_AGENT_ONLY=1`: nothing is redeemed, enrolled or started). A setup that starts while it runs waits for it
//! ([`wait`]), since both would write the same partial download. Nothing depends on it: one that fails leaves the
//! setup's own script to fetch the agent as it always has.
//!
//! SECURITY SOFTWARE THAT WILL NOT HAVE IT (2026-11-12). One thing no setup can fetch its way past: an antivirus that
//! refuses `intentic-machine.exe` (Bitdefender Endpoint Security Tools, run from a company's console, refused the very
//! name, for an empty file as much as for the agent). The bootstrap tells that refusal apart and says it as a
//! `security-software` requirement (scripts-kit/agent-fetch.ps1), in whichever run met it: this one at launch, a
//! folder's setup, a sync. Every run's lines pass [`hear`] (scripts.rs `follow`), so the computer has ONE process about
//! it (`agent-install:this`), however many runs met it: what was refused and what to ask for, the note to hand whoever
//! manages the antivirus (the page's Copy), and Try again, which runs this install again. Nothing here adds an
//! exclusion: software that exempts itself from a scanner is what malware does, and scanners treat it so.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::AppHandle;

use crate::processes::{ProcessNeed, ProcessReport};
use crate::scripts::{self, Host, ScriptRun};
use crate::setup_progress::{blocked_words, Progress, BLOCKED};

/// The run's id: what a setup waits on.
pub const RUN: &str = "agent-install";

/// The process kind, and its one id: one computer, one agent.
const KIND: &str = "agent-install";
pub const PROCESS: &str = "agent-install:this";

/// How long after launch it starts: behind the window, the check and the image's own download starting.
const START_DELAY: Duration = Duration::from_secs(5);

/// How long a setup waits for it at most. The download it saves is the setup's own anyway, so a slow one only moves
/// where the wait is; this bound is for one that hangs.
const WAIT_AT_MOST: Duration = Duration::from_secs(5 * 60);

/// One per run of this app.
static STARTED: AtomicBool = AtomicBool::new(false);

/// Where this computer's agent is, as its installer puts it, under `home`.
fn installed_at(host: Host, home: Option<&str>) -> Option<String> {
    home.filter(|home| !home.is_empty()).and_then(|home| {
        scripts::sync_agent_candidates(host, Some(home))
            .into_iter()
            .next()
    })
}

/// Whether to put the agent here now: none at its installed place, and no setup running that fetches one itself. Pure.
pub fn wanted(installed: bool, setup_running: bool) -> bool {
    !installed && !setup_running
}

/// The run: the bundled sync script, with the app's own environment and told to fetch the agent alone.
pub fn script(host: Host, version: &str) -> ScriptRun {
    let mut env = crate::commands::app_env(version);
    env.push(("INTENTIC_AGENT_ONLY".into(), "1".into()));
    ScriptRun {
        file: host.script("sync.sh", "sync.ps1"),
        args: Vec::new(),
        env,
        elevate: false,
        host,
    }
}

/// At launch (lib.rs): put the agent in place, off this thread, when this computer has none.
pub fn begin(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(START_DELAY);
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok();
        let host = Host::current();
        let installed =
            installed_at(host, home.as_deref()).is_some_and(|path| Path::new(&path).is_file());
        let setup_running =
            scripts::is_running(crate::commands::SETUP_RUN) || crate::folder_setup::running();
        if !wanted(installed, setup_running) || STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(error) = scripts::run(&app, RUN, script(host, crate::commands::VERSION)) {
            eprintln!("intentic: the machine agent was not put in place ahead ({error}); a setup fetches it itself");
        }
    });
}

/// A line of any run (scripts.rs `follow`): security software refusing the agent becomes this computer's process about
/// it, whichever run said so.
pub fn hear(app: &AppHandle, line: &str) {
    if let Some(requirement) = refusal(line) {
        crate::processes::report(app, blocked_report(&requirement));
    }
}

/// Why the agent is kept off this computer right now, as its process says it, while security software refuses it.
pub fn blocked_now(app: &AppHandle) -> Option<String> {
    crate::processes::get(app, PROCESS)
        .filter(|held| held.needs.iter().any(|need| need.id == BLOCKED))
        .and_then(|held| held.failure)
}

/// The `security-software` requirement a line says, if it says one. Pure.
fn refusal(line: &str) -> Option<Value> {
    if !line.starts_with("intentic-requirement: ") {
        return None;
    }
    crate::setup_progress::parse_requirement(line)
        .filter(|requirement| requirement["id"].as_str() == Some(BLOCKED))
}

/// The process for a refusal: why, in the requirement's words; the note for whoever manages the antivirus, which the
/// page copies (`copy`, the need's own press, answered in the page); and Try again. Pure.
pub fn blocked_report(requirement: &Value) -> ProcessReport {
    let mut report = ProcessReport::of(KIND, "this", "failed");
    report.failure = blocked_words(requirement);
    let label = requirement["title"]
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("Security software is blocking intentic-machine.exe");
    let note: Option<String> = requirement["detail"]
        .as_str()
        .map(str::trim)
        .filter(|note| !note.is_empty())
        .map(|note| note.chars().take(600).collect());
    report.needs = vec![ProcessNeed {
        id: BLOCKED.to_string(),
        label: label.chars().take(200).collect(),
        actions: if note.is_some() {
            vec!["copy".to_string()]
        } else {
            Vec::new()
        },
        detail: note,
    }];
    report.actions = vec!["retry".to_string(), "dismiss".to_string()];
    report
}

/// How a run of this install ended, as its process says it: done, refused again (the requirement's own process), or
/// stopped for another reason in the run's own words. Pure.
pub fn ended_report(success: bool, code: Option<i32>, progress: &Progress) -> ProcessReport {
    if success {
        let mut report = ProcessReport::of(KIND, "this", "done");
        report.actions = vec!["dismiss".to_string()];
        return report;
    }
    if let Some(requirement) = crate::setup_progress::blocked(&progress.requirements) {
        return blocked_report(requirement);
    }
    let mut report = ProcessReport::of(KIND, "this", "failed");
    report.failure = Some(
        progress
            .reason()
            .unwrap_or_else(|| match code {
                Some(code) => format!("intentic-machine was not put on this computer: the install stopped with status {code}. Its log says why."),
                None => "intentic-machine was not put on this computer: the install was stopped before it finished.".to_string(),
            })
            .chars()
            .take(600)
            .collect(),
    );
    report.actions = vec!["retry".to_string(), "dismiss".to_string()];
    report
}

/// The reader's answer to the process (processes.rs `act`): Try again runs this install again, whether or not an
/// agent is in place (the one in place may be the one a handover could not use), after any setup fetching one.
pub fn act(app: &AppHandle, act: &str) {
    match act {
        "dismiss" => crate::processes::clear(app, PROCESS),
        "retry" if !scripts::is_running(RUN) => {
            crate::processes::report(app, ProcessReport::of(KIND, "this", "running"));
            let app = app.clone();
            std::thread::spawn(move || {
                let since = Instant::now();
                while (scripts::is_running(crate::commands::SETUP_RUN)
                    || crate::folder_setup::running())
                    && since.elapsed() < WAIT_AT_MOST
                {
                    std::thread::sleep(Duration::from_millis(500));
                }
                let progress = Arc::new(Mutex::new(Progress::new(cfg!(windows), true)));
                let heard: scripts::Heard = {
                    let progress = Arc::clone(&progress);
                    Arc::new(move |stream: scripts::Stream, line: &str| {
                        if let Ok(mut progress) = progress.lock() {
                            progress.hear(stream, line);
                        }
                    })
                };
                let script = script(Host::current(), crate::commands::VERSION);
                let report = match scripts::run_heard(&app, RUN, script, Some(heard), None) {
                    Ok(ended) => {
                        let progress = progress
                            .lock()
                            .map(|held| held.clone())
                            .unwrap_or_else(|poisoned| poisoned.into_inner().clone());
                        ended_report(ended.success, ended.code, &progress)
                    }
                    Err(why) => {
                        let mut report = ProcessReport::of(KIND, "this", "failed");
                        report.failure = Some(why.chars().take(600).collect());
                        report.actions = vec!["retry".to_string(), "dismiss".to_string()];
                        report
                    }
                };
                crate::processes::report(&app, report);
            });
        }
        _ => {}
    }
}

/// A setup about to start waits for the agent's download, when one runs, rather than starting a second one beside it.
pub fn wait() {
    let since = Instant::now();
    while scripts::is_running(RUN) && since.elapsed() < WAIT_AT_MOST {
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_is_put_in_place_only_on_a_computer_without_one_and_with_no_setup_fetching_it() {
        assert!(wanted(false, false));
        assert!(!wanted(true, false));
        // A setup running fetches its own: a second download beside it would write the same partial file.
        assert!(!wanted(false, true));
    }

    #[test]
    fn it_runs_the_bundled_sync_script_told_to_fetch_the_agent_alone() {
        let run = script(Host::Windows, "1.2.3");
        assert_eq!(run.file, "sync.ps1");
        assert!(run.args.is_empty());
        assert!(!run.elevate);
        let env = |name: &str| {
            run.env
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(env("INTENTIC_AGENT_ONLY"), Some("1"));
        // No sandbox to set up: none of a setup's own values ride along.
        assert_eq!(env("SANDBOX_URL"), None);
        assert_eq!(env("PAIR_TOKEN"), None);
        assert_eq!(script(Host::Unix, "1.2.3").file, "sync.sh");
    }

    const REFUSED: &str = r#"intentic-requirement: {"id":"security-software","title":"Bitdefender Endpoint Security Tools is blocking intentic-machine.exe","problem":"Windows refused to save intentic-machine.exe.","remedy":"Ask your IT to allow the folder, then try again.","action":"user","detail":"Please allow Intentic on this PC.\nFile: intentic-machine 1.410.1"}"#;

    #[test]
    fn security_software_refusing_the_agent_is_one_process_with_a_note_to_copy_and_try_again() {
        assert_eq!(refusal("intentic: [desktop-sync] downloading"), None);
        assert_eq!(
            refusal(r#"intentic-requirement: {"id":"wsl-features","action":"fixElevated"}"#),
            None
        );
        let requirement = refusal(REFUSED).expect("the refusal is heard");
        let report = blocked_report(&requirement);
        assert_eq!(report.id, PROCESS);
        assert!(crate::processes::is_id(&report.id));
        assert!(crate::processes::KINDS.contains(&report.kind.as_str()));
        assert_eq!(report.state, "failed");
        assert_eq!(
            report.failure.as_deref(),
            Some("Windows refused to save intentic-machine.exe.\n\nAsk your IT to allow the folder, then try again.")
        );
        assert_eq!(report.needs.len(), 1);
        let need = &report.needs[0];
        assert_eq!(need.id, BLOCKED);
        assert_eq!(
            need.label,
            "Bitdefender Endpoint Security Tools is blocking intentic-machine.exe"
        );
        assert_eq!(
            need.detail.as_deref(),
            Some("Please allow Intentic on this PC.\nFile: intentic-machine 1.410.1")
        );
        assert_eq!(need.actions, ["copy"]);
        assert_eq!(report.actions, ["retry", "dismiss"]);
        assert!(report
            .actions
            .iter()
            .chain(&need.actions)
            .all(|act| crate::processes::is_action(act)));
        // It asks the reader: its tile is marked and a notification is put up while nobody looks.
        assert!(crate::processes::asks(&report));
        // No note, nothing to copy.
        let bare = blocked_report(&serde_json::json!({ "id": BLOCKED, "problem": "Refused." }));
        assert!(bare.needs[0].actions.is_empty());
        assert_eq!(
            bare.needs[0].label,
            "Security software is blocking intentic-machine.exe"
        );
    }

    #[test]
    fn a_try_again_ends_done_refused_again_or_stopped_in_its_own_words() {
        let mut progress = Progress::new(true, true);
        assert_eq!(ended_report(true, Some(0), &progress).state, "done");
        progress.hear(
            scripts::Stream::Stderr,
            "error: intentic-machine could not be downloaded.",
        );
        let stopped = ended_report(false, Some(1), &progress);
        assert_eq!(stopped.state, "failed");
        assert_eq!(
            stopped.failure.as_deref(),
            Some("error: intentic-machine could not be downloaded.")
        );
        assert!(stopped.needs.is_empty());
        assert_eq!(stopped.actions, ["retry", "dismiss"]);
        progress.hear(scripts::Stream::Stdout, REFUSED);
        let refused = ended_report(false, Some(1), &progress);
        assert_eq!(refused.needs[0].id, BLOCKED);
        let silent = ended_report(false, Some(1), &Progress::new(true, true));
        assert!(silent.failure.unwrap().contains("status 1"));
    }

    #[test]
    fn the_agent_is_looked_for_where_its_installer_puts_it() {
        assert_eq!(
            installed_at(Host::Windows, Some("C:\\Users\\Ada")).as_deref(),
            Some("C:\\Users\\Ada\\.intentic\\machine\\bin\\intentic-machine.exe")
        );
        // No home, no place to look: never the bare name a PATH lookup would need running to answer.
        assert_eq!(installed_at(Host::Unix, None), None);
        assert_eq!(installed_at(Host::Unix, Some("")), None);
    }
}
