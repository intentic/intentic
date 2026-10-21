//! A SETUP'S OWN LINES, READ (2026-10-21, out of the one-per-computer sandbox's supervisor): `intentic: [<phase>]`
//! steps, docker's pull lines and `intentic-requirement:` objects folded into a step, a percent that never falls, what
//! the setup asks for and why it stopped. A folder's own setup reads its run with it (folder_setup.rs), whichever window
//! is open, since no window need be there. Pure, and held to sandbox-run's setup-progress.fixture.json as ic's ui.rs,
//! desktop.ts, setupPlan.ts and the web's agentHouse.ts are.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::scripts::Stream;

/// What a setup stopped on a question waits for: the reader's go-ahead, or a session Windows has to end (desktop.ts
/// `SetupWaitingFor`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WaitingFor {
    Consent,
    Restart,
    SignOut,
}

/// What ic's connect says on stderr when the folder's sync did not finish after the sandbox was made (its connect.rs
/// `sync_unfinished`). The setup still exits 0, so this line is the only word that no pairing is coming (2026-10-21: a
/// folder whose agent update failed mid-setup sat on "copying" for three minutes before the card said anything).
pub const SYNC_UNFINISHED: &str = "sync didn't finish.";

/// `intentic: [<phase>] <sentence>`, as desktop.ts `parseStep` reads it.
pub fn parse_step(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("intentic: [")?;
    let (phase, said) = rest.split_once("] ")?;
    let plain = !phase.is_empty()
        && phase
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-');
    plain.then(|| (phase.to_string(), said.trim().to_string()))
}

/// The states a layer of docker's pull reports, and how much of the layer each means (setupPlan.ts `LAYER_DONE`).
const LAYER_DONE: [(&str, f32); 8] = [
    ("Pulling fs layer", 0.0),
    ("Waiting", 0.0),
    ("Downloading", 0.15),
    ("Verifying Checksum", 0.6),
    ("Download complete", 0.6),
    ("Extracting", 0.8),
    ("Pull complete", 1.0),
    ("Already exists", 1.0),
];

/// One line of docker's pull: the layer and how far it is.
pub fn parse_layer(line: &str) -> Option<(String, f32)> {
    let (id, status) = line.split_once(": ")?;
    if id.len() < 6 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    LAYER_DONE
        .iter()
        .find(|(said, _)| status.starts_with(said))
        .map(|(_, done)| (id.to_string(), *done))
}

/// `intentic-requirement: {…}`: what this computer needs before it can run a sandbox, kept whole for the folder's card
/// (desktop.ts `parseRequirement` reads the same object). One with no id is the log's.
pub fn parse_requirement(line: &str) -> Option<serde_json::Value> {
    let json = line.strip_prefix("intentic-requirement: ")?;
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value["id"]
        .as_str()
        .is_some_and(|id| !id.is_empty())
        .then_some(value)
}

/// The setup's phases in the order it runs them, each weighed in rough seconds (setupPlan.ts, sandbox-run's
/// setup-progress.fixture.json): Windows fetches `ic` before it checks Docker; an image already here is a docker answer
/// away. Docker is never installed by this run, and a folder's setup always syncs: its folder's link comes right after
/// the daemon answers, ahead of the public address's checks (ic's connect.rs, 2026-10-21), so the first copy runs while
/// they wait on the edge.
pub fn plan(windows: bool, image_ready: bool) -> Vec<(&'static str, u32)> {
    let fetch = ("fetching-ic", 15);
    let check = ("checking-docker", if windows { 12 } else { 5 });
    let mut steps = if windows {
        vec![fetch, check]
    } else {
        vec![check, fetch]
    };
    steps.extend([
        ("preflight", 10),
        ("claiming-code", 5),
        ("pulling-image", if image_ready { 2 } else { 240 }),
        ("starting-sandbox", 25),
        ("waiting-health", 40),
        ("desktop-sync", 46),
        ("verifying", 8),
        ("connecting-machine", 13),
    ]);
    steps
}

/// A setup's run, as its lines arrive: where it is, what it says, how far, what it asks for and why it stopped.
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    plan: Vec<(&'static str, u32)>,
    index: Option<usize>,
    layers: BTreeMap<String, f32>,
    pub phase: Option<String>,
    pub step: Option<String>,
    /// Never falls, and never reaches 100 before the run says it is done.
    pub percent: u8,
    pub requirements: Vec<serde_json::Value>,
    command_failure: Option<String>,
    last_error: Option<String>,
    /// The run said its folder's sync did not finish (ic's connect.rs `sync_unfinished`): the sandbox is made, and no
    /// pairing for the folder is coming.
    pub sync_unfinished: bool,
}

impl Progress {
    pub fn new(windows: bool, image_ready: bool) -> Progress {
        Progress {
            plan: plan(windows, image_ready),
            index: None,
            layers: BTreeMap::new(),
            phase: None,
            step: None,
            percent: 0,
            requirements: Vec::new(),
            command_failure: None,
            last_error: None,
            sync_unfinished: false,
        }
    }

    /// One line of the run folded in; true when what the card shows changed.
    pub fn hear(&mut self, stream: Stream, line: &str) -> bool {
        if let Some((phase, said)) = parse_step(line) {
            let before = (self.phase.clone(), self.step.clone(), self.percent);
            // A phase the plan does not know is narration, and one already passed is no step back.
            if let Some(at) = self.plan.iter().position(|(known, _)| *known == phase) {
                if self.index.is_none_or(|index| at > index) {
                    self.index = Some(at);
                    self.layers.clear();
                    self.phase = Some(phase);
                }
            }
            if !said.is_empty() {
                self.step = Some(said);
            }
            // A step after a command that said it failed: the setup went on after all.
            self.command_failure = None;
            self.percent = self.percent.max(self.percent_now());
            return before != (self.phase.clone(), self.step.clone(), self.percent);
        }
        if let Some((layer, done)) = parse_layer(line) {
            self.layers.insert(layer, done);
            let percent = self.percent.max(self.percent_now());
            let moved = percent != self.percent;
            self.percent = percent;
            return moved;
        }
        if let Some(requirement) = parse_requirement(line) {
            self.requirements
                .retain(|held| held["id"] != requirement["id"]);
            self.requirements.push(requirement);
            return true;
        }
        if stream == Stream::Stderr {
            let said = line.trim();
            if said.contains(SYNC_UNFINISHED) {
                self.sync_unfinished = true;
                return false;
            }
            if let Some(failure) = said.strip_prefix("Command failed,") {
                self.command_failure = Some(failure.trim().to_string());
            } else if !said.is_empty() {
                self.last_error = Some(said.to_string());
            }
        }
        false
    }

    fn percent_now(&self) -> u8 {
        let Some(index) = self.index else {
            return self.percent;
        };
        let total: u32 = self.plan.iter().map(|(_, weight)| weight).sum();
        if total == 0 {
            return self.percent;
        }
        let behind: u32 = self.plan[..index].iter().map(|(_, weight)| weight).sum();
        let inside = if self.layers.is_empty() {
            0.0
        } else {
            self.layers.values().sum::<f32>() / self.layers.len() as f32
        };
        let weight = self.plan[index].1 as f32;
        let share = (behind as f32 + weight * inside) / total as f32;
        ((share * 100.0) as u8).min(99)
    }

    /// Roughly how many seconds the run has left, by the plan's weights: everything not behind it yet, the phase under
    /// way counted by its pull's layers where it has them. The whole plan before the run has said where it is.
    pub fn seconds_left(&self) -> Option<u32> {
        let total: u32 = self.plan.iter().map(|(_, weight)| weight).sum();
        let Some(index) = self.index else {
            return Some(total);
        };
        let behind: u32 = self.plan[..index].iter().map(|(_, weight)| weight).sum();
        let inside = if self.layers.is_empty() {
            0.0
        } else {
            self.layers.values().sum::<f32>() / self.layers.len() as f32
        };
        let done = behind as f32 + self.plan[index].1 as f32 * inside;
        Some((total as f32 - done).max(0.0).round() as u32)
    }

    /// Why the run stopped, in its own words: a command that said it failed, else the last thing it said on stderr.
    pub fn reason(&self) -> Option<String> {
        self.command_failure
            .clone()
            .or_else(|| self.last_error.clone())
    }
}

/// What a designed stop waits for (exit 3: a yes nobody could give in a terminal; exit 4: a restart or a sign-out),
/// read as a handed-over setup's card reads it (setup.ts `waitingFor`); none for any other exit.
pub fn waiting_for(code: Option<i32>, requirements: &[serde_json::Value]) -> Option<WaitingFor> {
    let code = code.filter(|code| *code == 3 || *code == 4)?;
    let asks = |action: &str| {
        requirements
            .iter()
            .any(|requirement| requirement["action"].as_str() == Some(action))
    };
    Some(if asks("restart") {
        WaitingFor::Restart
    } else if asks("signOut") {
        WaitingFor::SignOut
    } else if code == 4 {
        WaitingFor::Restart
    } else {
        WaitingFor::Consent
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /* THE SETUP'S LINES. */

    /// The setup-progress record ic, desktop.ts, setupPlan.ts and the web's agentHouse.ts are tested against too.
    fn progress_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-run/src/setup-progress.fixture.json"
        ))
        .expect("the setup-progress fixture is JSON")
    }

    #[test]
    fn step_and_layer_lines_read_as_the_shared_record_says() {
        let fixture = progress_fixture();
        for case in fixture["steps"].as_array().expect("steps") {
            let line = case["line"].as_str().expect("line");
            let expected = case["phase"].as_str().map(|phase| {
                (
                    phase.to_string(),
                    case["message"].as_str().expect("message").to_string(),
                )
            });
            assert_eq!(parse_step(line), expected, "{line:?}");
        }
        for case in fixture["layers"].as_array().expect("layers") {
            let line = case["line"].as_str().expect("line");
            let expected = case["id"]
                .as_str()
                .map(|id| (id.to_string(), case["done"].as_f64().expect("done") as f32));
            assert_eq!(parse_layer(line), expected, "{line:?}");
        }
        let states = fixture["layerDone"].as_object().expect("layerDone");
        assert_eq!(states.len(), LAYER_DONE.len());
        for (state, done) in LAYER_DONE {
            assert_eq!(
                states[state].as_f64().map(|value| value as f32),
                Some(done),
                "{state}"
            );
        }
    }

    #[test]
    fn the_plan_is_the_shared_records_phases_and_weights() {
        let fixture = progress_fixture();
        let phases = fixture["phases"].as_array().expect("phases");
        let mut checked = 0;
        for case in fixture["plans"].as_array().expect("plans") {
            let input = &case["input"];
            // A folder's own setup never installs Docker and always syncs: only the plans of that shape are its.
            if input["dockerReady"] != true || input["syncing"] != true {
                continue;
            }
            let expected: Vec<(String, u32)> = case["steps"]
                .as_array()
                .expect("steps")
                .iter()
                .map(|step| {
                    (
                        step[0].as_str().expect("phase").to_string(),
                        step[1].as_u64().expect("weight") as u32,
                    )
                })
                .collect();
            let drawn: Vec<(String, u32)> =
                plan(input["os"] == "windows", input["imageReady"] == true)
                    .into_iter()
                    .map(|(phase, weight)| (phase.to_string(), weight))
                    .collect();
            assert_eq!(drawn, expected, "{input}");
            assert!(drawn
                .iter()
                .all(|(phase, _)| phases.iter().any(|known| known == phase.as_str())));
            checked += 1;
        }
        assert!(
            checked >= 2,
            "the record has to hold this app's plans at all"
        );
    }

    #[test]
    fn a_step_is_the_scripts_own_marker_and_nothing_else() {
        assert_eq!(
            parse_step("intentic: [pulling-image] using the image already here."),
            Some((
                "pulling-image".into(),
                "using the image already here.".into()
            ))
        );
        assert_eq!(
            parse_step("intentic: [preflight] "),
            Some(("preflight".into(), String::new()))
        );
        assert_eq!(parse_step("intentic: [Preflight] x"), None);
        assert_eq!(parse_step("intentic: [] x"), None);
        assert_eq!(parse_step("Pulling from intentic/sandbox"), None);
        assert_eq!(parse_step("intentic: [preflight]"), None);
    }

    #[test]
    fn a_pull_line_says_how_far_its_layer_is() {
        assert_eq!(
            parse_layer("a1b2c3d4e5f6: Downloading [==>  ] 12MB/80MB"),
            Some(("a1b2c3d4e5f6".into(), 0.15))
        );
        assert_eq!(
            parse_layer("a1b2c3d4e5f6: Pull complete"),
            Some(("a1b2c3d4e5f6".into(), 1.0))
        );
        assert_eq!(parse_layer("stable: Pulling from intentic/sandbox"), None);
        assert_eq!(parse_layer("a1b2: Pull complete"), None);
    }

    #[test]
    fn the_time_left_is_what_the_plan_has_not_run_yet() {
        // Linux, the image already here: 5 + 15 + 10 + 5 + 2 + 25 + 40 + 46 + 8 + 13 seconds.
        let mut progress = Progress::new(false, true);
        assert_eq!(progress.seconds_left(), Some(169));
        progress.hear(
            Stream::Stdout,
            "intentic: [checking-docker] Docker is running",
        );
        assert_eq!(progress.seconds_left(), Some(169));
        progress.hear(Stream::Stdout, "intentic: [starting-sandbox] starting");
        assert_eq!(progress.seconds_left(), Some(25 + 40 + 46 + 8 + 13));
        // A pull's layers count inside its own step.
        let mut pulling = Progress::new(false, false);
        pulling.hear(Stream::Stdout, "intentic: [pulling-image] downloading");
        let before = pulling.seconds_left().expect("left");
        pulling.hear(Stream::Stdout, "a1b2c3d4e5f6: Pull complete");
        assert_eq!(pulling.seconds_left(), Some(before - 240));
    }

    #[test]
    fn the_bar_moves_forward_by_the_plan_and_never_back() {
        let mut progress = Progress::new(false, false);
        assert!(progress.hear(
            Stream::Stdout,
            "intentic: [checking-docker] Docker is running"
        ));
        let checked = progress.percent;
        assert!(progress.hear(Stream::Stdout, "intentic: [pulling-image] downloading"));
        let pulling = progress.percent;
        assert!(pulling > checked);
        assert!(progress.hear(Stream::Stdout, "abcdef123456: Extracting"));
        assert!(
            progress.percent > pulling,
            "the pull's own progress moves the bar"
        );
        // A phase already passed is narration: the phase stays, the bar does not fall.
        let at = progress.percent;
        progress.hear(Stream::Stdout, "intentic: [preflight] again");
        assert_eq!(
            (progress.phase.as_deref(), progress.step.as_deref()),
            (Some("pulling-image"), Some("again"))
        );
        assert_eq!(progress.percent, at);
        progress.hear(Stream::Stdout, "intentic: [connecting-machine] connecting");
        assert!(progress.percent < 100, "only the exit says it is done");
        // Unknown output says nothing.
        assert!(!progress.hear(Stream::Stdout, "some narration"));
    }

    #[test]
    fn an_image_already_here_weighs_almost_nothing() {
        let mut fresh = Progress::new(false, false);
        let mut kept = Progress::new(false, true);
        for progress in [&mut fresh, &mut kept] {
            progress.hear(Stream::Stdout, "intentic: [starting-sandbox] starting");
        }
        assert!(fresh.percent > kept.percent);
        // Windows fetches the installer first and checks Docker after it.
        assert_eq!(plan(true, true)[0].0, "fetching-ic");
        assert_eq!(plan(false, true)[0].0, "checking-docker");
    }

    #[test]
    fn a_failure_is_said_in_the_runs_own_words() {
        let mut progress = Progress::new(false, true);
        progress.hear(Stream::Stderr, "warning: something");
        progress.hear(
            Stream::Stderr,
            "Command failed, the platform refused the setup code.",
        );
        progress.hear(Stream::Stderr, "! trailing noise");
        assert_eq!(
            progress.reason().as_deref(),
            Some("the platform refused the setup code.")
        );
        // A step after it: the setup went on, and the failure is not its last word.
        progress.hear(Stream::Stdout, "intentic: [verifying] checking");
        assert_eq!(progress.reason().as_deref(), Some("! trailing noise"));
        assert_eq!(Progress::new(false, true).reason(), None);
    }

    #[test]
    fn a_designed_stop_waits_for_what_its_requirements_ask() {
        let mut progress = Progress::new(true, true);
        assert!(progress.hear(
            Stream::Stdout,
            r#"intentic-requirement: {"id":"wsl-features","title":"Turn on WSL","action":"fixElevated"}"#
        ));
        assert!(!progress.hear(Stream::Stdout, r#"intentic-requirement: {"title":"no id"}"#));
        assert_eq!(progress.requirements.len(), 1);
        assert_eq!(
            waiting_for(Some(3), &progress.requirements),
            Some(WaitingFor::Consent)
        );
        progress.hear(
            Stream::Stdout,
            r#"intentic-requirement: {"id":"reboot","action":"restart"}"#,
        );
        assert_eq!(
            waiting_for(Some(3), &progress.requirements),
            Some(WaitingFor::Restart)
        );
        let sign_out = [serde_json::json!({ "id": "docker-users", "action": "signOut" })];
        assert_eq!(waiting_for(Some(4), &sign_out), Some(WaitingFor::SignOut));
        assert_eq!(waiting_for(Some(4), &[]), Some(WaitingFor::Restart));
        assert_eq!(waiting_for(Some(1), &sign_out), None);
        assert_eq!(waiting_for(None, &sign_out), None);
    }

    #[test]
    fn a_folder_sync_that_did_not_finish_is_heard_and_is_not_the_runs_failure() {
        let mut progress = Progress::new(true, true);
        progress.hear(
            Stream::Stderr,
            "intentic: folder sync didn't finish. Your sandbox is fine; set it up again from the desktop app to sync your folder.",
        );
        assert!(progress.sync_unfinished);
        assert_eq!(progress.reason(), None);
        // The sentence is ic's own: held to its source, so a reworded warning cannot go unheard.
        let connect = include_str!("../../../../_sandbox/ic/src/sandbox/connect.rs");
        assert!(connect.contains(&format!("folder {SYNC_UNFINISHED}")));
        assert!(!Progress::new(true, true).sync_unfinished);
    }

    /* THE DECISION. */
}
