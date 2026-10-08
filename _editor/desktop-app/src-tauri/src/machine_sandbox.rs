//! THIS COMPUTER'S OWN SANDBOX: the one sandbox the app keeps on this machine for the folders the reader works on with
//! an agent, each attached to it as `/work/<name>` (project.rs `project_attach`).
//!
//! The app makes it after sign-in, in the background, and nothing waits on it: a supervisor thread started at launch
//! (lib.rs) owns it, not any window. Its state is a file (`machine-sandbox.json`) written on every change and sent whole
//! to every window (`desktop://machine-sandbox`), so a window opened late, a window closed mid-setup and an app quit
//! mid-setup all find the same truth. A setup the last quit cut short is found on launch (a `creating` record whose run
//! is gone), said as interrupted and run again on the same row, its code minted afresh: the platform hands back the
//! live one. Docker is never installed or started from here: a machine whose engine does not answer is `needsDocker`,
//! the reader starts it from This device, and the next round notices. The run is the connect script with
//! `SYNC_PROJECTS_HOST=1` (a sandbox with no folder of its own, whose desktop-sync step enrolls this machine as the
//! holder of its sync token), its `intentic: [phase]` lines read here into a step and a percent. One setup at a time
//! on this docker: a setup handed over from the workspace (`setup`) is waited for, never raced.
//!
//! Folders wait in the record (`folders`) until it is ready, then `intentic-machine sync attach` records each one's
//! pairing and the agent starts copying; the supervisor follows the first copy in `intentic-machine status --json`
//! until Mutagen says it is watching for changes.
//!
//! Every decision is a plain function of the record and what was found ([`decide`], [`Progress::hear`],
//! [`enqueue`]…), so the state machine is tested without a window, a platform or a docker.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::project::{Made, Minted};
use crate::scripts::{AgentSilence, Heard, Stream};
use crate::setup_link::{NoticeArgs, NoticeKind, SetupArgs};
use crate::state::{AppState, Project, SessionEnd};

/// What every window hears on each change: the whole record.
pub const EVENT: &str = "desktop://machine-sandbox";
/// The run id its setup streams under (`desktop://run`), and the one a handed-over setup waits for.
pub const RUN: &str = "machine-setup";
/// The record, in the app's config folder.
const FILE: &str = "machine-sandbox.json";

/// How long `intentic-machine sync attach` may take: it only records the pairing, the agent copies afterwards.
const ATTACH_LIMIT: Duration = Duration::from_secs(60);
/// How long `intentic-machine sync detach` may take.
const DETACH_LIMIT: Duration = Duration::from_secs(60);

/* THE RECORD — what is true of this computer's sandbox, as every window draws it. */

/// Why Docker is in the way, in the words the Docker card already uses for a start's outcome (commands.rs
/// `DockerStart`), which all begin the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)]
pub enum DockerReason {
    /// No docker on this machine at all.
    NotInstalled,
    /// Installed, and its engine is not answering.
    NotRunning,
    /// The engine answers and turns this account away: a group membership.
    NotAllowed,
}

/// What a setup stopped on a question waits for: the reader's go-ahead, or a session Windows has to end (desktop.ts
/// `SetupWaitingFor`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WaitingFor {
    Consent,
    Restart,
    SignOut,
}

/// Where this computer's sandbox stands.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Standing {
    /// Nobody is signed in: it is made after sign-in.
    #[default]
    SignedOut,
    /// Docker is not there or not answering; never installed or started from here.
    NeedsDocker {
        reason: DockerReason,
    },
    /// Being made: the running phase (setupPlan.ts ids), its sentence, and how far.
    Creating {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        percent: u8,
    },
    /// Stopped on a designed question (exit 3 or 4): answered on This device.
    Waiting {
        #[serde(rename = "for")]
        waiting_for: WaitingFor,
    },
    Ready,
    /// The container is here and not running.
    Stopped,
    /// Making it stopped, and why.
    Failed {
        reason: String,
    },
    /// A setup the last quit cut short, about to run again on the same row.
    Interrupted,
    /// The account no longer has it and it is not on this computer: a new one is offered.
    Gone,
}

impl Standing {
    /// The word the record's `state` is, for comparing two standings by kind.
    fn kind(&self) -> &'static str {
        match self {
            Standing::SignedOut => "signedOut",
            Standing::NeedsDocker { .. } => "needsDocker",
            Standing::Creating { .. } => "creating",
            Standing::Waiting { .. } => "waiting",
            Standing::Ready => "ready",
            Standing::Stopped => "stopped",
            Standing::Failed { .. } => "failed",
            Standing::Interrupted => "interrupted",
            Standing::Gone => "gone",
        }
    }
}

/// How far a folder is on its way into this computer's sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderState {
    /// Waiting for the sandbox to be ready.
    Queued,
    /// Its pairing being recorded.
    Attaching,
    /// Its first copy under way.
    Copying,
    /// Copied in, and kept up to date from here.
    Ready,
    Failed,
}

/// A folder asked into this computer's sandbox, by the window that shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    /// The folder, as its windows are told it (local.rs face `path`).
    pub path: String,
    /// Its name inside the sandbox's `/work`.
    pub name: String,
    pub state: FolderState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Mutagen's own word for the copy, while it copies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// `machine-sandbox.json`, and what every window is sent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    #[serde(flatten)]
    pub standing: Standing,
    /// The platform's row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_id: Option<String>,
    /// Its container's slug here, read off its address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    /// Its public address, which folders attach to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Whose it is: a different account signed in starts over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Where the last setup's transcript is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    /// A setup has finished for it: from here on a missing container is a sandbox gone, not one unfinished.
    #[serde(default)]
    pub made: bool,
    /// How many setups have been started for it.
    #[serde(default)]
    pub attempt: u32,
    /// When the last setup started, Unix seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    /// Unix seconds of the last change.
    #[serde(default)]
    pub updated_at: u64,
    /// The reader agreed to what the setup's first pass said it would change.
    #[serde(default)]
    pub consented: bool,
    /// Windows was asked to end the session for it: the next launch runs it again, already agreed to.
    #[serde(default)]
    pub resume_on_launch: bool,
    /// What a setup stopped on a question said this computer needs (`intentic-requirement:` lines, desktop.ts
    /// `Requirement`), for This device's card.
    #[serde(default)]
    pub requirements: Vec<serde_json::Value>,
    /// The folders asked into it, while they are on their way and once in.
    #[serde(default)]
    pub folders: Vec<Folder>,
    /// The last standing a notification was put up for, so a round that finds the same thing says nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noticed: Option<String>,
    /// A setup for this row got as far as starting its container ([`may_have_announced`]), whose daemon announces itself
    /// to the platform: from then on the row may be live somewhere, and a failure never takes it off the account.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub announced: bool,
}

/* READING THE SETUP'S OWN LINES. */

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

/// `intentic-requirement: {…}`: what this computer needs before it can run a sandbox, kept whole for This device's
/// card (desktop.ts `parseRequirement` reads the same object). One with no id is the log's.
pub fn parse_requirement(line: &str) -> Option<serde_json::Value> {
    let json = line.strip_prefix("intentic-requirement: ")?;
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value["id"]
        .as_str()
        .is_some_and(|id| !id.is_empty())
        .then_some(value)
}

/// The setup's phases in the order it runs them, each weighed in rough seconds (setupPlan.ts): Windows fetches `ic`
/// before it checks Docker; an image already here is a docker answer away. Docker is never installed by this run.
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
        ("verifying", 20),
        ("desktop-sync", 45),
        ("connecting-machine", 75),
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

    /// Why the run stopped, in its own words: a command that said it failed, else the last thing it said on stderr.
    pub fn reason(&self) -> Option<String> {
        self.command_failure
            .clone()
            .or_else(|| self.last_error.clone())
    }
}

/// What a designed stop waits for (exit 3: a yes nobody could give in a terminal; exit 4: a restart or a sign-out),
/// read as This device's card reads it (setup.ts `waitingFor`); none for any other exit.
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

/// Where a finished run leaves the sandbox.
pub fn outcome(success: bool, code: Option<i32>, progress: &Progress) -> Standing {
    if success {
        return Standing::Ready;
    }
    if let Some(waiting_for) = waiting_for(code, &progress.requirements) {
        return Standing::Waiting { waiting_for };
    }
    let reason = progress.reason().unwrap_or_else(|| match code {
        Some(code) => {
            format!("The setup stopped with status {code}. Its log says what it was doing.")
        }
        None => "The setup was stopped before it finished.".to_string(),
    });
    Standing::Failed { reason }
}

/* WHAT TO DO NEXT — the supervisor's one decision, a plain function of the record and what was found. */

/// The container, as `ic sandbox list --json` has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Running,
    Stopped,
    Missing,
    /// Not asked, or the listing failed.
    Unknown,
}

/// What a window asked of the supervisor since its last round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    /// "Try again" (a stopped setup), the requirements card's go-ahead (`consent`), or its "Check again".
    Retry { consent: bool },
    /// "Make a new one", for a sandbox that is gone.
    Recreate,
}

/// What a round found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    /// Who the workspace last said is signed in; none when nobody is, or the platform turned the session away.
    pub account: Option<String>,
    /// Ok when the engine answers.
    pub docker: Result<(), DockerReason>,
    pub container: Container,
    /// The first round of this run of the app.
    pub launch: bool,
    pub asked: Option<Ask>,
    /// Another environment of this computer whose machine agent keeps its sandboxes, when this one has none of its own
    /// (agents.rs `elsewhere`, `WSL (archlinux)`). Looked for only while the record holds no row.
    pub elsewhere: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Keep,
    Become(Standing),
    /// Run the setup (on the record's row, or a new one when it has none).
    Create {
        consent: bool,
    },
    /// A setup the last quit cut short: said as interrupted, then run again on the same row.
    Resume {
        consent: bool,
    },
    /// Another account is signed in: the record starts over for it, keeping the folders still waiting.
    Reset,
    /// A new sandbox in place of one that is gone.
    Recreate,
}

fn become_(record: &Record, standing: Standing) -> Decision {
    if record.standing == standing {
        Decision::Keep
    } else {
        Decision::Become(standing)
    }
}

/// The supervisor's decision. Stops that need the reader (a question, a failure, a sandbox gone) stay put until they
/// answer; everything else follows the account, Docker and the container.
pub fn decide(record: &Record, facts: &Facts) -> Decision {
    let Some(account) = facts.account.as_deref() else {
        return become_(record, Standing::SignedOut);
    };
    if record
        .account
        .as_deref()
        .is_some_and(|held| held != account)
    {
        return Decision::Reset;
    }
    let retry = match facts.asked {
        Some(Ask::Recreate) => return Decision::Recreate,
        Some(Ask::Retry { consent }) => Some(consent),
        None => None,
    };
    match (&record.standing, retry) {
        // Windows ended the session for it: the consented run brings Docker up itself, so nothing is checked first.
        (Standing::Waiting { .. }, _) if record.resume_on_launch && facts.launch => {
            return Decision::Create { consent: true };
        }
        // The reader's go-ahead on the requirements card: the consented run sees to Docker itself.
        (Standing::Waiting { .. }, Some(true)) => return Decision::Create { consent: true },
        (Standing::Gone, Some(_)) => return Decision::Recreate,
        (Standing::Waiting { .. } | Standing::Failed { .. } | Standing::Gone, None) => {
            return Decision::Keep;
        }
        // A setup this process is not running: the last one was cut short.
        (Standing::Creating { .. }, _) => {
            return Decision::Resume {
                consent: record.consented,
            };
        }
        _ => {}
    }
    if let Err(reason) = facts.docker {
        return become_(record, Standing::NeedsDocker { reason });
    }
    if let Some(consent) = retry.filter(|_| {
        matches!(
            record.standing,
            Standing::Waiting { .. } | Standing::Failed { .. } | Standing::Interrupted
        )
    }) {
        return Decision::Create { consent };
    }
    if record.standing == Standing::Interrupted {
        return Decision::Create {
            consent: record.consented,
        };
    }
    if record.sandbox_id.is_none() {
        // CHECKED FIRST (2026-10-05): another environment of this computer already runs a machine agent that keeps its
        // sandboxes (a WSL distro's), and this one has none. Setting one up here unasked would put a second agent and a
        // second sandbox on the same Docker, each running its own keeper. It stops for the reader instead, saying where
        // the sandboxes are kept; their "Try again" sets it up here all the same (the retry above).
        if let Some(place) = &facts.elsewhere {
            return become_(
                record,
                Standing::Failed {
                    reason: kept_elsewhere(place),
                },
            );
        }
        return Decision::Create { consent: false };
    }
    if !record.made {
        // A row whose setup never finished, finished now.
        return Decision::Create {
            consent: record.consented,
        };
    }
    match facts.container {
        Container::Running => become_(record, Standing::Ready),
        Container::Stopped => become_(record, Standing::Stopped),
        Container::Missing => become_(record, Standing::Gone),
        Container::Unknown => match record.standing {
            Standing::Ready | Standing::Stopped => Decision::Keep,
            _ => become_(record, Standing::Ready),
        },
    }
}

/// What the card says when another environment's agent keeps this computer's sandboxes (`decide`).
pub fn kept_elsewhere(place: &str) -> String {
    format!(
        "Intentic's machine agent already runs in {place} on this computer and keeps its sandboxes there, so a second \
         one wasn't set up here. Try again to set one up here anyway."
    )
}

/// The phases of a setup from which its container may be up and its daemon may have announced itself to the platform:
/// from `starting-sandbox` on (setupPlan.ts). Before it, nothing of the row ever ran anywhere.
const ANNOUNCING: [&str; 5] = [
    "starting-sandbox",
    "waiting-health",
    "verifying",
    "desktop-sync",
    "connecting-machine",
];

/// Whether a setup that reached `phase` may have had its sandbox announce itself. Pure.
pub fn may_have_announced(phase: Option<&str>) -> bool {
    phase.is_some_and(|phase| ANNOUNCING.contains(&phase))
}

/// Whether a setup that stopped leaves a row to take off the account (2026-10-05): one this computer's record holds,
/// that no setup finished and none got as far as starting a container for (so it never announced itself), and whose
/// container this machine does not have (`container`, read just now: a container that is here, or a listing that
/// failed, is never a licence). A row like that waited in the account's switcher as an unfinished sandbox for good,
/// since only a failed code minting ever discarded one. Pure.
pub fn discards_row(record: &Record, container: Container) -> bool {
    record.sandbox_id.is_some()
        && !record.made
        && !record.announced
        && (record.slug.is_none() || container == Container::Missing)
}

/// Whether a round needs Docker's answer and the container's: not for a stop that waits on the reader.
fn asks_the_machine(record: &Record, asked: Option<Ask>, launch: bool) -> bool {
    match record.standing {
        Standing::Waiting { .. } => asked.is_some() || (record.resume_on_launch && launch),
        Standing::Failed { .. } | Standing::Gone => asked.is_some(),
        _ => true,
    }
}

/// The record started over for another account: its row is that account's, and so are the folders already in it.
/// Folders still waiting wait for the new one.
pub fn reset_for(record: &Record, account: &str) -> Record {
    Record {
        account: Some(account.to_string()),
        folders: record
            .folders
            .iter()
            .filter(|folder| matches!(folder.state, FolderState::Queued | FolderState::Failed))
            .map(|folder| Folder {
                state: FolderState::Queued,
                reason: None,
                status: None,
                ..folder.clone()
            })
            .collect(),
        ..Record::default()
    }
}

/// The record as a launch finds it: an attach the last quit cut short is a folder copying (its pairing was recorded)
/// or one still waiting (it was not), and folders that finished are nobody's news any more.
pub fn settle_on_launch(record: &mut Record, projects: &[Project]) {
    let attached = |path: &str| {
        projects
            .iter()
            .any(|project| project.path == path && project.sandbox_id == record.sandbox_id)
    };
    let settled: Vec<Folder> = record
        .folders
        .iter()
        .filter(|folder| folder.state != FolderState::Ready)
        .map(|folder| match folder.state {
            FolderState::Attaching if attached(&folder.path) => Folder {
                state: FolderState::Copying,
                ..folder.clone()
            },
            FolderState::Attaching => Folder {
                state: FolderState::Queued,
                ..folder.clone()
            },
            _ => folder.clone(),
        })
        .collect();
    record.folders = settled;
}

/// How long the supervisor rests between rounds: briskly while a folder copies, often while Docker is awaited (the
/// reader is starting it), rarely once there is nothing to wait for.
pub fn pause_for(record: &Record) -> Duration {
    if record.folders.iter().any(|folder| {
        matches!(
            folder.state,
            FolderState::Attaching | FolderState::Copying | FolderState::Queued
        ) && record.standing == Standing::Ready
    }) {
        return Duration::from_secs(4);
    }
    match record.standing {
        Standing::NeedsDocker { .. } => Duration::from_secs(15),
        Standing::Ready => Duration::from_secs(300),
        _ => Duration::from_secs(60),
    }
}

/* FOLDERS — named, put in line, attached, and followed into the sandbox. */

/// A folder's name inside `/work`, unique among `taken` (any case): `name`, then `name-2`, `name-3`… cut to the 64
/// characters a project's name may have, as `projectDirNameFor` names one.
pub fn unique_name(name: &str, taken: &[String]) -> String {
    let free = |candidate: &str| {
        !taken
            .iter()
            .any(|held| held.eq_ignore_ascii_case(candidate))
    };
    if free(name) {
        return name.to_string();
    }
    (2..)
        .map(|number| {
            let suffix = format!("-{number}");
            let room = 64usize.saturating_sub(suffix.len());
            let stem: String = name.chars().take(room).collect();
            format!("{}{suffix}", stem.trim_end_matches(['.', '-']))
        })
        .find(|candidate| free(candidate))
        .unwrap_or_else(|| name.to_string())
}

/// `path` put in line under a name made unique among the folders already in this computer's sandbox (`attached`) and
/// those waiting for it. A folder already in line keeps its place and its name, and one that failed is asked again.
pub fn enqueue(record: &mut Record, path: &str, wanted: &str, attached: &[String]) -> String {
    if let Some(folder) = record.folders.iter_mut().find(|folder| folder.path == path) {
        if matches!(folder.state, FolderState::Failed | FolderState::Ready) {
            folder.state = FolderState::Queued;
            folder.reason = None;
            folder.status = None;
        }
        return folder.name.clone();
    }
    let mut taken: Vec<String> = attached.to_vec();
    taken.extend(record.folders.iter().map(|folder| folder.name.clone()));
    let name = unique_name(wanted, &taken);
    record.folders.push(Folder {
        path: path.to_string(),
        name: name.clone(),
        state: FolderState::Queued,
        reason: None,
        status: None,
    });
    name
}

/// The machine agent's command attaching `dir` to the sandbox at `hostname` as `/work/<name>`.
pub fn attach_args(hostname: &str, dir: &str, name: &str) -> Vec<String> {
    vec![
        "sync".into(),
        "attach".into(),
        "--sandbox-url".into(),
        format!("https://{hostname}"),
        "--dir".into(),
        dir.into(),
        "--name".into(),
        name.into(),
        "--json".into(),
    ]
}

/// What the agent said to an attach: its pairing recorded, or why not in its own words.
pub fn attach_answer(answer: Result<serde_json::Value, AgentSilence>) -> Result<(), String> {
    match answer {
        Ok(said) if said["ok"].as_bool() == Some(true) => Ok(()),
        Ok(said) => Err(said["error"]
            .as_str()
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .unwrap_or("The machine agent couldn't add this folder.")
            .to_string()),
        Err(silence) => Err(crate::project::said(&silence)),
    }
}

/// How far a first copy is, by the agent's word for its Mutagen session (`mutagenStatus`): `watching` is a copy that is
/// done; every other word (`connecting-beta`, `scanning`, `reconciling`, `staging-beta`, `transitioning`, `saving`,
/// and any it may add) is one still going. The first `watching` is the end of it: a folder found ready is not followed
/// again, so the same words passing through for a later edit never read as a copy starting over.
pub fn copy_state(status: &str) -> FolderState {
    if status.to_ascii_lowercase().contains("watching") {
        FolderState::Ready
    } else {
        FolderState::Copying
    }
}

/// The sandbox's name on the account: this computer's own, as the reader calls it, numbered past one the account
/// already gives another.
pub fn sandbox_name(host: Option<&str>, taken: &[String]) -> String {
    let host: Option<String> = host
        .map(str::trim)
        .filter(|host| !host.is_empty() && !host.chars().any(char::is_control))
        .map(|host| host.chars().take(40).collect());
    let base = match host {
        Some(host) => format!("{host} sandbox"),
        None => "This computer's sandbox".to_string(),
    };
    let free = |candidate: &str| {
        !taken
            .iter()
            .any(|held| held.eq_ignore_ascii_case(candidate))
    };
    if free(&base) {
        return base;
    }
    (2..)
        .map(|number| format!("{base} {number}"))
        .find(|candidate| free(candidate))
        .unwrap_or(base)
}

/// This computer's name, as its system gives it.
fn host_name() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").ok()
    }
    #[cfg(not(windows))]
    {
        std::fs::read_to_string("/proc/sys/kernel/hostname")
            .or_else(|_| std::fs::read_to_string("/etc/hostname"))
            .ok()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .or_else(|| std::env::var("HOSTNAME").ok())
    }
}

/* THE SUPERVISOR — one thread, started at launch, for the life of the app. */

/// The record and where it is kept (lib.rs `manage`).
pub struct MachineSandbox {
    path: PathBuf,
    record: Mutex<Record>,
}

impl MachineSandbox {
    pub fn load(app: &AppHandle) -> tauri::Result<MachineSandbox> {
        let path = app.path().app_config_dir()?.join(FILE);
        let record = crate::state::read_json(&path).unwrap_or_default();
        Ok(MachineSandbox {
            path,
            record: Mutex::new(record),
        })
    }
}

/// What wakes the supervisor before its rest is over, and what for.
#[derive(Default)]
struct Wake {
    kicked: bool,
    asked: Option<Ask>,
}

static WAKE: LazyLock<(Mutex<Wake>, Condvar)> = LazyLock::new(Default::default);
/// The platform turned the session away: not asked again until the workspace says who is signed in.
static REFUSED: AtomicBool = AtomicBool::new(false);
/// The app is quitting: a setup stopped now was cut short, not failed.
static EXITING: AtomicBool = AtomicBool::new(false);

/// Wake the supervisor for a round now.
pub fn kick() {
    let (wake, bell) = &*WAKE;
    if let Ok(mut wake) = wake.lock() {
        wake.kicked = true;
    }
    bell.notify_all();
}

fn ask(asked: Ask) {
    let (wake, bell) = &*WAKE;
    if let Ok(mut wake) = wake.lock() {
        wake.kicked = true;
        wake.asked = Some(asked);
    }
    bell.notify_all();
}

/// The workspace said who is signed in (`intentic://roster`), or someone signed in or out: asked again from scratch.
pub fn account_changed() {
    REFUSED.store(false, Ordering::SeqCst);
    kick();
}

/// Rest for `pause`, or until kicked; answers what was asked meanwhile.
fn rest(pause: Duration) -> Option<Ask> {
    let (wake, bell) = &*WAKE;
    let Ok(held) = wake.lock() else {
        std::thread::sleep(pause);
        return None;
    };
    let mut held = match bell.wait_timeout_while(held, pause, |wake| !wake.kicked) {
        Ok((held, _)) => held,
        Err(poisoned) => poisoned.into_inner().0,
    };
    held.kicked = false;
    held.asked.take()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// The record as it stands.
pub fn status(app: &AppHandle) -> Record {
    app.state::<MachineSandbox>().record.lock().unwrap().clone()
}

/// One change to the record: written, sent to every window, and a notification put up when it is news.
fn update(app: &AppHandle, change: impl FnOnce(&mut Record)) -> Record {
    let held = app.state::<MachineSandbox>();
    let (before, after) = {
        let mut record = held.record.lock().unwrap();
        let before = record.clone();
        change(&mut record);
        if *record == before {
            return before;
        }
        record.updated_at = now();
        if let Some(key) = news(
            &before.standing,
            &record.standing,
            record.noticed.as_deref(),
        ) {
            record.noticed = Some(key);
        } else if moved_on(&before.standing, &record.standing) {
            // Under way again, or up: whatever stops it next is news again.
            record.noticed = None;
        }
        crate::state::write_json(&held.path, &*record);
        (before, record.clone())
    };
    if let Err(error) = app.emit(EVENT, &after) {
        eprintln!("intentic: the windows could not be told about this computer's sandbox: {error}");
    }
    if after.noticed.is_some() && after.noticed != before.noticed {
        notify(app, &after);
    }
    after
}

/// The sandbox went from a stop to being made or being up: what was noticed about the stop is over.
fn moved_on(before: &Standing, after: &Standing) -> bool {
    before.kind() != after.kind() && matches!(after, Standing::Ready | Standing::Creating { .. })
}

/// Whether a change is worth a notification, and the key it is noticed under: the sandbox ready after its setup, and
/// each time it newly needs the reader (a failure, Docker, a question). Never twice for the same standing.
fn news(before: &Standing, after: &Standing, noticed: Option<&str>) -> Option<String> {
    let key = match after {
        Standing::Ready if matches!(before, Standing::Creating { .. } | Standing::Interrupted) => {
            "ready"
        }
        Standing::Failed { .. } => "failed",
        Standing::NeedsDocker { .. } => "needsDocker",
        Standing::Waiting { .. } => "waiting",
        _ => return None,
    };
    if before.kind() == after.kind() || noticed == Some(key) {
        return None;
    }
    Some(key.to_string())
}

/// The reader is in a window of this computer (the main one or a folder's), where the card already says it.
fn reader_here(app: &AppHandle) -> bool {
    app.webview_windows().iter().any(|(label, window)| {
        (label == crate::windows::HOME || label.starts_with("files-"))
            && window.is_focused().unwrap_or(false)
    })
}

/// The system's notification for the record's news.
fn notify(app: &AppHandle, record: &Record) {
    if reader_here(app) {
        return;
    }
    let this_device = Some(crate::notice::THIS_DEVICE.to_string());
    let (kind, title, body, path) = match &record.standing {
        Standing::Ready => (
            NoticeKind::Finished,
            "This computer's sandbox is ready",
            "Folders you work on with an agent go into it.".to_string(),
            record
                .sandbox_id
                .as_deref()
                .map(|id| format!("/?sandbox={id}")),
        ),
        Standing::Failed { reason } => (
            NoticeKind::Asks,
            "This computer's sandbox wasn't set up",
            reason.clone(),
            this_device,
        ),
        Standing::NeedsDocker { reason } => (
            NoticeKind::Asks,
            "This computer's sandbox needs Docker",
            match reason {
                DockerReason::NotInstalled => "Install Docker Desktop, and Intentic sets it up.",
                DockerReason::NotRunning => "Start Docker, and Intentic carries on.",
                DockerReason::NotAllowed => {
                    "Docker turns this account away. This computer says how to fix it."
                }
            }
            .to_string(),
            this_device,
        ),
        Standing::Waiting { .. } => (
            NoticeKind::Asks,
            "This computer's sandbox needs your OK",
            "This computer needs a few things before it can run a sandbox.".to_string(),
            this_device,
        ),
        _ => return,
    };
    let body: String = body.chars().take(200).collect();
    crate::notice::show(
        app,
        NoticeArgs {
            key: "machine-sandbox".to_string(),
            kind,
            title: title.to_string(),
            body: Some(body).filter(|body| !body.is_empty()),
            path,
            silent: false,
        },
    );
}

/// Start the supervisor (lib.rs, once the state is managed).
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("machine-sandbox".into())
        .spawn(move || supervise(&app));
    if let Err(error) = spawned {
        eprintln!("intentic: no thread for this computer's sandbox: {error}");
    }
}

fn supervise(app: &AppHandle) {
    let projects = app.state::<AppState>().projects();
    update(app, |record| settle_on_launch(record, &projects));
    let mut launch = true;
    let mut asked = None;
    loop {
        round(app, launch, asked);
        launch = false;
        asked = rest(pause_for(&status(app)));
    }
}

/// One round: decide, act, then the folders.
fn round(app: &AppHandle, launch: bool, asked: Option<Ask>) {
    let record = status(app);
    let facts = gather(app, &record, launch, asked);
    match decide(&record, &facts) {
        Decision::Keep => {}
        Decision::Become(standing) => {
            update(app, |record| record.standing = standing);
        }
        Decision::Create { consent } => create(app, consent),
        Decision::Resume { consent } => {
            update(app, |record| record.standing = Standing::Interrupted);
            if facts.docker.is_ok() || record.resume_on_launch {
                create(app, consent);
            } else {
                kick();
            }
        }
        Decision::Reset => {
            if let Some(account) = facts.account.as_deref() {
                update(app, |record| *record = reset_for(record, account));
            }
            kick();
        }
        Decision::Recreate => recreate(app),
    }
    attach_queued(app);
    follow_copies(app);
}

/// What a round finds: who is signed in, and Docker and the container only when they can change anything.
fn gather(app: &AppHandle, record: &Record, launch: bool, asked: Option<Ask>) -> Facts {
    let account = app
        .state::<AppState>()
        .roster()
        .account
        .map(|account| account.email)
        .filter(|_| !REFUSED.load(Ordering::SeqCst));
    let looked = account.is_some() && asks_the_machine(record, asked, launch);
    let docker = if looked { docker_facts() } else { Ok(()) };
    let container = match (&record.slug, looked && docker.is_ok() && record.made) {
        (Some(slug), true) => container_of(app, slug),
        _ => Container::Unknown,
    };
    // Only where a setup could start from scratch: a row already held is this computer's, wherever else agents run.
    let elsewhere = (looked && record.sandbox_id.is_none())
        .then(|| crate::agents::elsewhere(&crate::agents::find()))
        .flatten();
    Facts {
        account,
        docker,
        container,
        launch,
        asked,
        elsewhere,
    }
}

/// Whether Docker answers, and why not: no socket and no CLI is no Docker at all.
fn docker_facts() -> Result<(), DockerReason> {
    if crate::scripts::engine_listening() {
        return match crate::scripts::daemon_refusal() {
            None => Ok(()),
            Some(refusal) if crate::scripts::engine_denied(&refusal) => {
                Err(DockerReason::NotAllowed)
            }
            Some(_) if !crate::scripts::docker_cli_present() => Err(DockerReason::NotInstalled),
            Some(_) => Err(DockerReason::NotRunning),
        };
    }
    if crate::scripts::docker_cli_present() {
        Err(DockerReason::NotRunning)
    } else {
        Err(DockerReason::NotInstalled)
    }
}

/// The container, as `ic` lists this machine's sandboxes.
fn container_of(app: &AppHandle, slug: &str) -> Container {
    let listing = crate::scripts::ic_listing(
        app,
        crate::commands::list_script(crate::scripts::Host::current(), crate::commands::VERSION),
    );
    match listing {
        Ok(rows) => match rows.iter().find(|row| row["slug"].as_str() == Some(slug)) {
            Some(row) if row["running"].as_bool() == Some(false) => Container::Stopped,
            Some(_) => Container::Running,
            None => Container::Missing,
        },
        Err(error) => {
            eprintln!("intentic: this computer's sandboxes could not be listed: {error}");
            Container::Unknown
        }
    }
}

/// A window whose webview holds the workspace's session (every window shares one browser profile, account.rs).
fn any_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(crate::windows::WORKSPACE)
        .or_else(|| app.get_webview_window(crate::windows::HOME))
        .or_else(|| app.webview_windows().into_values().next())
}

const WAITING_FOR_SETUP: &str = "Waiting for another sandbox's setup on this computer to finish.";

/// Make it, or finish making it: the row (when the record has none), its setup code, and the connect script. BLOCKING,
/// for minutes, on the supervisor's own thread.
fn create(app: &AppHandle, consent: bool) {
    let Some(window) = any_window(app) else {
        // No window to read the session from: the next round, once one is open.
        return;
    };
    // One setup at a time on this docker: a setup handed over from the workspace finishes first.
    let mut said = false;
    while crate::scripts::is_running("setup") {
        if !said {
            update(app, |record| {
                record.standing = Standing::Creating {
                    phase: None,
                    step: Some(WAITING_FOR_SETUP.to_string()),
                    percent: 0,
                };
            });
            said = true;
        }
        std::thread::sleep(Duration::from_secs(5));
    }
    // A setup a crashed launch left running: followed to its end rather than raced, then the round decides again.
    if follow_live_run(app) {
        kick();
        return;
    }
    let roster = app.state::<AppState>().roster();
    let Some(account) = roster.account.as_ref().map(|account| account.email.clone()) else {
        update(app, |record| record.standing = Standing::SignedOut);
        return;
    };
    let taken: Vec<String> = roster
        .sandboxes
        .iter()
        .map(|entry| entry.name.clone())
        .collect();
    let record = update(app, |record| {
        record.account = Some(account);
        record.attempt += 1;
        record.started_at = Some(now());
        record.standing = Standing::Creating {
            phase: None,
            step: None,
            percent: 0,
        };
        record.requirements.clear();
        record.consented = consent;
        record.resume_on_launch = false;
        if !record
            .name
            .as_deref()
            .is_some_and(crate::project::is_sandbox_name)
        {
            record.name = Some(sandbox_name(host_name().as_deref(), &taken));
        }
    });
    let name = record.name.clone().unwrap_or_default();

    let reused = record.sandbox_id.is_some();
    let sandbox_id = match record.sandbox_id.clone() {
        Some(id) => id,
        None => {
            let made = tauri::async_runtime::block_on(crate::account::platform_post(
                app,
                &window,
                "/rpc/sandbox/create",
                &serde_json::json!({ "name": name }),
            ));
            match made.map(crate::project::made_row) {
                Ok(Made::Row(id)) => {
                    update(app, |record| record.sandbox_id = Some(id.clone()));
                    // Listed at once, so the folders attached to it are live before the workspace next lists the
                    // account's sandboxes (project.rs `is_live`).
                    let state = app.state::<AppState>();
                    state.remember_roster(crate::project::with_row(state.roster(), &id, &name));
                    id
                }
                Ok(Made::SignedOut) => return signed_out(app),
                Ok(Made::Refused(why)) | Err(why) => return failed(app, why),
            }
        }
    };

    let minted =
        tauri::async_runtime::block_on(crate::project::mint_code(app, &window, &sandbox_id, None));
    // A row this record made earlier that the platform no longer has (deleted from another device, or the account's
    // sandbox list cleaned up) refuses every new code the same way; a Try again could never get past it, so the record
    // says the sandbox is gone and the card offers a new one.
    if minted
        .as_ref()
        .is_ok_and(|answered| row_gone(reused, answered))
    {
        update(app, |record| record.standing = Standing::Gone);
        return;
    }
    let (code, slug) = match minted.map(crate::project::minted_code) {
        Ok(Minted::Code {
            code,
            slug,
            hostname,
        }) => {
            update(app, |record| {
                if slug.is_some() {
                    record.slug.clone_from(&slug);
                }
                if hostname.is_some() {
                    record.hostname = hostname;
                }
            });
            (code, slug)
        }
        Ok(Minted::SignedOut) => return signed_out(app),
        Ok(Minted::Refused(why)) | Err(why) => {
            discard_unannounced(app, &window);
            return failed(app, why);
        }
    };

    let image_ready = crate::commands::sandbox_image_ready();
    let args = SetupArgs {
        code,
        sandbox_id: Some(sandbox_id.clone()),
        name: Some(name.clone()),
        cf_token: None,
        sync_dir: None,
        platform_url: None,
        project: None,
        slug: slug.clone(),
        minted_at: Some(now()),
        profile: None,
    };
    let mut script =
        crate::commands::setup_script(&args, &crate::commands::SetupContext::of(app, consent));
    // A sandbox with no folder of its own: folders attach to it afterwards, each as /work/<name>.
    script
        .env
        .push(("SYNC_PROJECTS_HOST".to_string(), "1".to_string()));

    let progress = Arc::new(Mutex::new(Progress::new(cfg!(windows), image_ready)));
    let heard = hearing(app, &progress);
    // The run lock is taken the moment the script starts, and given back however it ends.
    let lock = lock_path(app);
    let spawned: crate::scripts::OnSpawn = {
        let lock = lock.clone();
        Box::new(move |child: &crate::scripts::Spawned| take_lock(&lock, child))
    };
    // The sandbox image, fetched ahead while this setup installs Docker (prefetch.rs), as a handed-over setup does.
    crate::prefetch::begin_for_setup(app, consent);
    let ended = crate::scripts::run_heard(app, RUN, script, Some(heard), Some(spawned));
    if let Some(lock) = &lock {
        let _ = std::fs::remove_file(lock);
    }
    if EXITING.load(Ordering::SeqCst) {
        // Stopped by the app's own quit: the next launch finds it creating, and runs it again.
        return;
    }
    let progress = progress
        .lock()
        .map(|held| held.clone())
        .unwrap_or_else(|poisoned| poisoned.into_inner().clone());
    match ended {
        Ok(ended) => {
            let standing = outcome(ended.success, ended.code, &progress);
            if standing == Standing::Ready {
                finished(app, &sandbox_id, slug.as_deref(), &name);
            }
            if matches!(standing, Standing::Failed { .. }) {
                discard_unannounced(app, &window);
            }
            update(app, |record| {
                record.log_path = ended.log.clone();
                record.requirements.clone_from(&progress.requirements);
                if standing == Standing::Ready {
                    record.made = true;
                    record.consented = false;
                    record.requirements.clear();
                }
                record.standing = standing;
            });
        }
        Err(why) => {
            discard_unannounced(app, &window);
            failed(app, why);
        }
    }
}

/// A setup that stopped before its sandbox could have announced itself ([`discards_row`]): its row is taken off the
/// account (`/rpc/sandbox/delete`, which the platform holds in its own trash for the recovery window), the record
/// forgets it, so the next try makes a fresh one, and the local windows stop listing it. Best effort: a row the platform
/// would not delete stays, as before, and the next try sets it up.
fn discard_unannounced(app: &AppHandle, window: &WebviewWindow) {
    let record = status(app);
    let container = match &record.slug {
        Some(slug) => container_of(app, slug),
        None => Container::Missing,
    };
    if !discards_row(&record, container) {
        return;
    }
    let Some(id) = record.sandbox_id else {
        return;
    };
    let body = serde_json::json!({ "sandboxId": id });
    let answered = tauri::async_runtime::block_on(crate::account::platform_post(
        app,
        window,
        "/rpc/sandbox/delete",
        &body,
    ));
    match answered {
        // Gone already is as good as deleted.
        Ok(crate::account::Answered::Json { status, .. })
            if (200..300).contains(&status) || status == 404 => {}
        Ok(other) => {
            eprintln!(
                "intentic: the unfinished sandbox {id} was not taken off the account: {other:?}"
            );
            return;
        }
        Err(error) => {
            eprintln!(
                "intentic: the unfinished sandbox {id} was not taken off the account: {error}"
            );
            return;
        }
    }
    update(app, |record| {
        if record.sandbox_id.as_deref() == Some(id.as_str()) {
            record.sandbox_id = None;
            record.slug = None;
            record.hostname = None;
        }
    });
    let state = app.state::<AppState>();
    state.remember_roster(without_row(state.roster(), &id));
}

/// The account's sandboxes without the one with `id`. Pure.
pub(crate) fn without_row(
    mut roster: crate::setup_link::Roster,
    id: &str,
) -> crate::setup_link::Roster {
    roster.sandboxes.retain(|entry| entry.id != id);
    roster
}

/// What hears a setup's lines (its own run, or one a crashed launch left running): each folded into `progress`, and
/// the record moved on when what the card shows changed.
fn hearing(app: &AppHandle, progress: &Arc<Mutex<Progress>>) -> Heard {
    let app = app.clone();
    let progress = Arc::clone(progress);
    Arc::new(move |stream: Stream, line: &str| {
        let shown = {
            let Ok(mut progress) = progress.lock() else {
                return;
            };
            if !progress.hear(stream, line) {
                return;
            }
            progress.clone()
        };
        update(&app, |record| {
            if matches!(record.standing, Standing::Creating { .. }) {
                record.standing = Standing::Creating {
                    phase: shown.phase.clone(),
                    step: shown.step.clone(),
                    percent: shown.percent,
                };
            }
            if may_have_announced(shown.phase.as_deref()) {
                record.announced = true;
            }
            record.requirements.clone_from(&shown.requirements);
        });
    })
}

/* ONE SETUP RUN AT A TIME, ACROSS LAUNCHES TOO (2026-10-05).
 *
 * A quit stops the setup it is running (`before_exit`), but a hard crash stops nothing: its script goes on, writing to its
 * own files (scripts.rs `Spool`), and the next launch found the record `creating` and started a second setup beside the
 * first, both claiming one row and driving one docker. So a run holds a lock while it lives, a pidfile in the app's data
 * folder with the script's pid and the start time its system gives that process, so a pid the system handed to another
 * process since is not taken for the run. A launch that finds the lock's process alive follows that run from its files
 * until it ends ([`follow_live_run`]), then decides again, which runs the setup once more on the same row exactly as
 * after an interrupted one, never two at once. A lock whose process is gone is taken over. */

/// The lock, in the app's data folder.
const LOCK_FILE: &str = "machine-setup.pid.json";

/// How long a lock whose process start could not be read is believed while its pid is alive: longer than any setup.
const LOCK_TRUST: Duration = Duration::from_secs(60 * 60);

/// How often a run a crashed launch left behind is asked whether it still lives.
const LIVE_RUN_POLL: Duration = Duration::from_secs(5);

/// What the card says while it follows a setup a crashed launch left running.
const FOLLOWING_RUN: &str = "Picking up the setup that was already running.";

/// The setup run holding the lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLock {
    /// The setup script's process.
    pub pid: u32,
    /// When its system says that process started, in the system's own unit; none when it could not be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<String>,
    /// Unix seconds when the lock was taken.
    pub at: u64,
    /// The files the run writes its two streams to, which a later launch follows it by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
}

/// Who holds the lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    /// No lock: the setup may start.
    Free,
    /// The run that took it is still going: followed, never raced.
    Live,
    /// Its process is gone, or the pid is another process's now: the lock is taken over.
    Stale,
}

/// Who holds `lock`, given the start time the system gives its pid now (`None`: no such process) and the time now.
/// A lock that recorded no start time is believed for [`LOCK_TRUST`] while its pid lives. Pure.
pub fn holder(lock: Option<&RunLock>, started_now: Option<&str>, now: u64) -> Holder {
    let Some(lock) = lock else {
        return Holder::Free;
    };
    let Some(started_now) = started_now else {
        return Holder::Stale;
    };
    match &lock.started {
        Some(started) if started == started_now => Holder::Live,
        Some(_) => Holder::Stale,
        None if now.saturating_sub(lock.at) < LOCK_TRUST.as_secs() => Holder::Live,
        None => Holder::Stale,
    }
}

/// The start time field of a `/proc/<pid>/stat` line (the 22nd, in clock ticks since boot), or none for a zombie,
/// which is a process that has ended. The command name is skipped by its closing parenthesis, since it may hold spaces.
/// Pure.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn start_time_in_stat(stat: &str) -> Option<String> {
    let (_, fields) = stat.rsplit_once(')')?;
    let mut fields = fields.split_whitespace();
    if fields.next()? == "Z" {
        return None;
    }
    fields.nth(18).map(str::to_string)
}

/// When the system says process `pid` started, or none when there is no such process.
#[cfg(target_os = "linux")]
fn process_started(pid: u32) -> Option<String> {
    start_time_in_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// When Windows says process `pid` started (UTC ticks), or none when there is no such process. Asked of PowerShell,
/// which every Windows this app runs on has, rather than through a Win32 binding added to the build for this alone.
#[cfg(windows)]
fn process_started(pid: u32) -> Option<String> {
    let mut command = std::process::Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!("(Get-Process -Id {pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks"),
    ]);
    intentic_bounded::no_window(&mut command);
    let answer = crate::scripts::capture("Get-Process", command, Duration::from_secs(20)).ok()?;
    let ticks = answer.stdout.trim();
    (answer.success && !ticks.is_empty() && ticks.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| ticks.to_string())
}

#[cfg(not(any(target_os = "linux", windows)))]
fn process_started(_pid: u32) -> Option<String> {
    None
}

/// Where the lock lives: the app's data folder.
fn lock_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(LOCK_FILE))
}

/// The lock, taken by the run that just started.
fn take_lock(lock: &Option<PathBuf>, child: &crate::scripts::Spawned) {
    let Some(lock) = lock else {
        return;
    };
    crate::state::write_json(
        lock,
        &RunLock {
            pid: child.pid,
            started: process_started(child.pid),
            at: now(),
            out: Some(child.out.display().to_string()),
            err: Some(child.err.display().to_string()),
        },
    );
}

/// A setup a crashed launch left running, followed from its files until it ends: true when there was one. A lock whose
/// run is gone is taken over (removed here, taken again by the run about to start). A quit while following leaves the
/// lock to the run, which the next launch follows again.
fn follow_live_run(app: &AppHandle) -> bool {
    let Some(path) = lock_path(app) else {
        return false;
    };
    let Some(lock) = crate::state::read_json::<RunLock>(&path) else {
        return false;
    };
    let live = || holder(Some(&lock), process_started(lock.pid).as_deref(), now()) == Holder::Live;
    if !live() {
        let _ = std::fs::remove_file(&path);
        return false;
    }
    update(app, |record| {
        record.standing = Standing::Creating {
            phase: None,
            step: Some(FOLLOWING_RUN.to_string()),
            percent: 0,
        };
    });
    let progress = Arc::new(Mutex::new(Progress::new(cfg!(windows), false)));
    let heard = hearing(app, &progress);
    let ended = Arc::new(AtomicBool::new(false));
    let readers: Vec<_> = [(&lock.out, Stream::Stdout), (&lock.err, Stream::Stderr)]
        .into_iter()
        .filter_map(|(file, stream)| {
            let file = PathBuf::from(file.as_ref()?);
            let (heard, ended) = (Arc::clone(&heard), Arc::clone(&ended));
            Some(std::thread::spawn(move || {
                crate::scripts::tail(&file, &ended, |line| heard(stream, line));
            }))
        })
        .collect();
    let mut gone = false;
    while !EXITING.load(Ordering::SeqCst) {
        if !live() {
            gone = true;
            break;
        }
        std::thread::sleep(LIVE_RUN_POLL);
    }
    ended.store(true, Ordering::Release);
    for reader in readers {
        let _ = reader.join();
    }
    if gone {
        let _ = std::fs::remove_file(&path);
    }
    true
}

/// The platform id of this computer's own sandbox while the app is making it or keeps it (not one the account no longer
/// has): what the folders of `projects.json` are never pruned against (project.rs), and what counts as a sandbox this
/// machine hosts (commands.rs `sandbox_list`).
pub fn kept_sandbox_id(app: &AppHandle) -> Option<String> {
    let record = status(app);
    record
        .sandbox_id
        .filter(|_| record.standing != Standing::Gone)
}

/// A setup that finished: a sandbox runs here (this machine's stopped Docker is the app's to start from now on), named
/// as the account names it, and listed.
fn finished(app: &AppHandle, sandbox_id: &str, slug: Option<&str>, name: &str) {
    let state = app.state::<AppState>();
    state.remember_hosts_sandboxes();
    if let Some(slug) = slug {
        state.remember_name(slug, Some(name));
    }
    state.remember_roster(crate::project::with_row(state.roster(), sandbox_id, name));
}

/// Whether minting a code for a row this record already held says the row is gone: the platform answers a sandbox it
/// has no row for (or not for this account) with 404. A row made by this very attempt is never read as gone.
fn row_gone(reused: bool, answered: &crate::account::Answered) -> bool {
    reused && matches!(answered, crate::account::Answered::Json { status: 404, .. })
}

fn signed_out(app: &AppHandle) {
    REFUSED.store(true, Ordering::SeqCst);
    update(app, |record| record.standing = Standing::SignedOut);
}

fn failed(app: &AppHandle, reason: String) {
    update(app, |record| record.standing = Standing::Failed { reason });
}

/// A new sandbox in place of one that is gone: the folders that were in the old one go into the new one under the
/// same names, once the machine agent has let go of them.
fn recreate(app: &AppHandle) {
    let old = status(app);
    let moved: Vec<Project> = app
        .state::<AppState>()
        .projects()
        .into_iter()
        .filter(|project| old.sandbox_id.is_some() && project.sandbox_id == old.sandbox_id)
        .collect();
    for project in &moved {
        let args = [
            "sync".to_string(),
            "detach".to_string(),
            "--dir".to_string(),
            project.path.clone(),
            "--json".to_string(),
        ];
        if let Err(silence) = crate::scripts::agent_json(&args, DETACH_LIMIT) {
            eprintln!("intentic: {} was not let go of: {silence:?}", project.path);
        }
    }
    update(app, |record| {
        let account = record.account.clone();
        let mut fresh = reset_for(record, account.as_deref().unwrap_or_default());
        fresh.account = account;
        for project in &moved {
            enqueue(&mut fresh, &project.path, &project.dir, &[]);
        }
        *record = fresh;
    });
    create(app, false);
}

/// The names already taken in this computer's sandbox: its folders, as projects.json remembers them.
fn attached_names(app: &AppHandle, sandbox_id: Option<&str>) -> Vec<String> {
    app.state::<AppState>()
        .projects()
        .into_iter()
        .filter(|project| sandbox_id.is_some() && project.sandbox_id.as_deref() == sandbox_id)
        .map(|project| project.dir)
        .collect()
}

/// A folder put in line for this computer's sandbox (project.rs `project_attach`), under the name it gets there.
pub fn queue(app: &AppHandle, root: &Path, wanted: &str) -> String {
    let path = root.display().to_string();
    let sandbox_id = status(app).sandbox_id;
    let attached = attached_names(app, sandbox_id.as_deref());
    let mut name = String::new();
    update(app, |record| {
        name = enqueue(record, &path, wanted, &attached)
    });
    kick();
    name
}

fn set_folder(
    app: &AppHandle,
    path: &str,
    state: FolderState,
    reason: Option<String>,
    said: Option<String>,
) {
    update(app, |record| {
        if let Some(folder) = record.folders.iter_mut().find(|folder| folder.path == path) {
            folder.state = state;
            folder.reason = reason;
            folder.status = said;
        }
    });
}

/// Every folder waiting, attached now that the sandbox is ready: its pairing recorded by the machine agent, the folder
/// remembered as this sandbox's project, and its windows told.
fn attach_queued(app: &AppHandle) {
    let record = status(app);
    if record.standing != Standing::Ready {
        return;
    }
    let waiting: Vec<Folder> = record
        .folders
        .iter()
        .filter(|folder| folder.state == FolderState::Queued)
        .cloned()
        .collect();
    for folder in waiting {
        let Some(hostname) = record.hostname.as_deref() else {
            set_folder(
                app,
                &folder.path,
                FolderState::Failed,
                Some("This computer's sandbox has no address to add a folder to. Make a new one from This computer.".to_string()),
                None,
            );
            continue;
        };
        set_folder(app, &folder.path, FolderState::Attaching, None, None);
        let answer = crate::scripts::agent_json(
            &attach_args(hostname, &folder.path, &folder.name),
            ATTACH_LIMIT,
        );
        match attach_answer(answer) {
            Ok(()) => {
                app.state::<AppState>().remember_project(Project {
                    path: folder.path.clone(),
                    dir: folder.name.clone(),
                    sandbox_id: record.sandbox_id.clone(),
                    slug: record.slug.clone(),
                });
                crate::local::mark_sandbox(app, Path::new(&folder.path));
                set_folder(app, &folder.path, FolderState::Copying, None, None);
            }
            Err(reason) => set_folder(app, &folder.path, FolderState::Failed, Some(reason), None),
        }
    }
}

/// Each folder's first copy, as the machine agent reports its pairing: done once Mutagen watches for changes.
fn follow_copies(app: &AppHandle) {
    let record = status(app);
    let copying: Vec<String> = record
        .folders
        .iter()
        .filter(|folder| folder.state == FolderState::Copying)
        .map(|folder| folder.path.clone())
        .collect();
    if copying.is_empty() {
        return;
    }
    let report = match crate::scripts::sync_report() {
        Ok(Some(report)) => serde_json::from_str::<serde_json::Value>(&report).unwrap_or_default(),
        Ok(None) => return,
        Err(error) => {
            eprintln!("intentic: {error}");
            return;
        }
    };
    for path in copying {
        let pairings = crate::project::pairings_of(&report, Path::new(&path), cfg!(windows));
        let ours = pairings
            .iter()
            .find(|pairing| pairing["sandboxId"].as_str() == record.sandbox_id.as_deref())
            .or_else(|| pairings.first());
        if let Some(said) = ours.and_then(|pairing| pairing["mutagenStatus"].as_str()) {
            set_folder(app, &path, copy_state(said), None, Some(said.to_string()));
        }
    }
}

/// The app is quitting: a setup under way is stopped with everything it started, and left `creating` for the next
/// launch to run again (lib.rs, `RunEvent::Exit`).
pub fn before_exit() {
    EXITING.store(true, Ordering::SeqCst);
    if crate::scripts::is_running(RUN) {
        if let Err(error) = crate::scripts::stop(RUN) {
            eprintln!("intentic: this computer's sandbox setup was not stopped: {error}");
        }
    }
}

/* WHAT THE WINDOWS CALL. */

/// The record, for a window opening after the last change (every later one arrives as `desktop://machine-sandbox`).
#[tauri::command]
pub fn machine_sandbox_status(app: AppHandle) -> Record {
    status(&app)
}

/// "Try again", the requirements card's go-ahead (`consent`) and its "Check again".
#[tauri::command]
pub fn machine_sandbox_retry(consent: bool) {
    ask(Ask::Retry { consent });
}

/// Look again now: Docker was just started from This device, or the reader is waiting on the card.
#[tauri::command]
pub fn machine_sandbox_check() {
    kick();
}

/// "Make a new one", for a sandbox the account no longer has.
#[tauri::command]
pub fn machine_sandbox_recreate() {
    ask(Ask::Recreate);
}

/// "Start", for a sandbox whose container is stopped: `ic` starts it (a shape saved for its next restart included).
#[tauri::command]
pub async fn machine_sandbox_start(app: AppHandle) -> Result<(), String> {
    let Some(slug) = status(&app).slug else {
        return Err("This computer's sandbox isn't on this computer yet.".to_string());
    };
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let run = crate::commands::power_script(
            &slug,
            "start",
            crate::scripts::Host::current(),
            crate::commands::VERSION,
        )?;
        crate::scripts::run(&handle, &format!("power:{slug}"), run)
    })
    .await
    .map_err(|error| error.to_string())??;
    kick();
    Ok(())
}

/// Restart or sign out for what the setup's first pass asked of Windows: the next launch runs it again, agreed to.
#[tauri::command]
pub fn machine_sandbox_end_session(app: AppHandle, how: SessionEnd) -> Result<(), String> {
    update(&app, |record| {
        record.resume_on_launch = true;
        record.consented = true;
    });
    crate::commands::end_session(how).inspect_err(|_| {
        update(&app, |record| record.resume_on_launch = false);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(standing: Standing) -> Record {
        Record {
            standing,
            account: Some("me@example.com".into()),
            ..Record::default()
        }
    }

    fn made(standing: Standing) -> Record {
        Record {
            sandbox_id: Some("cm-machine".into()),
            slug: Some("sandbox-2c8eb2c5b3a5".into()),
            hostname: Some("sandbox-2c8eb2c5b3a5.sbx.intentic.dev".into()),
            made: true,
            ..record(standing)
        }
    }

    fn facts() -> Facts {
        Facts {
            account: Some("me@example.com".into()),
            docker: Ok(()),
            container: Container::Running,
            launch: false,
            asked: None,
            elsewhere: None,
        }
    }

    /* THE RECORD ON DISK AND ON THE WIRE. */

    #[test]
    fn the_record_is_one_object_its_state_a_word_beside_the_rest() {
        let mut held = made(Standing::Creating {
            phase: Some("pulling-image".into()),
            step: None,
            percent: 42,
        });
        held.folders.push(Folder {
            path: "/home/me/app".into(),
            name: "app".into(),
            state: FolderState::Queued,
            reason: None,
            status: None,
        });
        let wire = serde_json::to_value(&held).unwrap();
        assert_eq!(wire["state"], "creating");
        assert_eq!(wire["phase"], "pulling-image");
        assert_eq!(wire["percent"], 42);
        assert!(wire.get("step").is_none(), "{wire}");
        assert_eq!(wire["sandboxId"], "cm-machine");
        assert_eq!(
            wire["folders"][0],
            serde_json::json!({ "path": "/home/me/app", "name": "app", "state": "queued" })
        );
        let back: Record = serde_json::from_value(wire).unwrap();
        assert_eq!(back, held);
        let waiting = serde_json::to_value(record(Standing::Waiting {
            waiting_for: WaitingFor::SignOut,
        }))
        .unwrap();
        assert_eq!(
            (waiting["state"].clone(), waiting["for"].clone()),
            ("waiting".into(), "signOut".into())
        );
        let docker = serde_json::to_value(record(Standing::NeedsDocker {
            reason: DockerReason::NotInstalled,
        }))
        .unwrap();
        assert_eq!(docker["reason"], "notInstalled");
        // A record holding only its state reads with everything else at rest.
        assert_eq!(
            serde_json::from_str::<Record>(r#"{ "state": "signedOut" }"#).unwrap(),
            Record::default()
        );
    }

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
            // This app's own setup never installs Docker and always syncs: only the plans of that shape are its.
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
        assert_eq!(
            outcome(false, Some(1), &progress),
            Standing::Failed {
                reason: "the platform refused the setup code.".into()
            }
        );
        // A step after it: the setup went on, and the failure is not its last word.
        progress.hear(Stream::Stdout, "intentic: [verifying] checking");
        assert_eq!(progress.reason().as_deref(), Some("! trailing noise"));
        let silent = Progress::new(false, true);
        assert!(
            matches!(outcome(false, Some(7), &silent), Standing::Failed { reason } if reason.contains("status 7"))
        );
        assert_eq!(outcome(true, Some(0), &silent), Standing::Ready);
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
            outcome(false, Some(3), &progress),
            Standing::Waiting {
                waiting_for: WaitingFor::Consent
            }
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

    /* THE DECISION. */

    #[test]
    fn nobody_signed_in_is_signed_out_whatever_it_was() {
        let none = Facts {
            account: None,
            ..facts()
        };
        assert_eq!(
            decide(&made(Standing::Ready), &none),
            Decision::Become(Standing::SignedOut)
        );
        assert_eq!(decide(&record(Standing::SignedOut), &none), Decision::Keep);
    }

    #[test]
    fn another_account_starts_over_keeping_the_folders_still_waiting() {
        let other = Facts {
            account: Some("someone@example.com".into()),
            ..facts()
        };
        let mut held = made(Standing::Ready);
        held.folders = vec![
            Folder {
                path: "/a".into(),
                name: "a".into(),
                state: FolderState::Copying,
                reason: None,
                status: None,
            },
            Folder {
                path: "/b".into(),
                name: "b".into(),
                state: FolderState::Failed,
                reason: Some("x".into()),
                status: None,
            },
        ];
        assert_eq!(decide(&held, &other), Decision::Reset);
        let fresh = reset_for(&held, "someone@example.com");
        assert_eq!(fresh.sandbox_id, None);
        assert!(!fresh.made);
        assert_eq!(fresh.account.as_deref(), Some("someone@example.com"));
        assert_eq!(
            fresh.folders,
            vec![Folder {
                path: "/b".into(),
                name: "b".into(),
                state: FolderState::Queued,
                reason: None,
                status: None
            }]
        );
    }

    #[test]
    fn a_first_sign_in_makes_it() {
        assert_eq!(
            decide(&Record::default(), &facts()),
            Decision::Create { consent: false }
        );
        assert_eq!(
            decide(&record(Standing::SignedOut), &facts()),
            Decision::Create { consent: false }
        );
    }

    /// Another environment of this computer already keeps its sandboxes with its own agent (a WSL distro's): the first
    /// setup is not run unasked, which would put a second agent on the same Docker. The reader's "Try again" runs it all
    /// the same, and a row already held is this computer's whatever else runs.
    #[test]
    fn a_setup_where_another_environments_agent_keeps_the_sandboxes_waits_for_the_reader() {
        let wsl = Facts {
            elsewhere: Some("WSL (archlinux)".into()),
            ..facts()
        };
        let Decision::Become(Standing::Failed { reason }) =
            decide(&record(Standing::SignedOut), &wsl)
        else {
            panic!("a first setup beside another environment's agent ran unasked");
        };
        assert!(reason.contains("WSL (archlinux)"), "{reason}");
        let stopped = record(Standing::Failed { reason });
        assert_eq!(decide(&stopped, &wsl), Decision::Keep);
        assert_eq!(
            decide(
                &stopped,
                &Facts {
                    asked: Some(Ask::Retry { consent: false }),
                    ..wsl.clone()
                }
            ),
            Decision::Create { consent: false }
        );
        assert_eq!(
            decide(&made(Standing::Ready), &wsl),
            Decision::Keep,
            "a sandbox already made here stays this computer's"
        );
    }

    /* A ROW THAT NEVER RAN goes with the setup that made it; one that may have announced itself never does. */

    #[test]
    fn a_row_is_announced_from_the_moment_its_container_is_started() {
        assert!(!may_have_announced(None));
        for phase in [
            "fetching-ic",
            "checking-docker",
            "preflight",
            "claiming-code",
            "pulling-image",
        ] {
            assert!(!may_have_announced(Some(phase)), "{phase}");
        }
        for phase in ANNOUNCING {
            assert!(may_have_announced(Some(phase)), "{phase}");
        }
    }

    #[test]
    fn only_a_row_nothing_of_which_ever_ran_is_taken_off_the_account() {
        let unminted = Record {
            sandbox_id: Some("cm-new".into()),
            ..record(Standing::Failed { reason: "x".into() })
        };
        // Its code was never minted: no container can exist.
        assert!(discards_row(&unminted, Container::Unknown));
        let minted = Record {
            slug: Some("sandbox-abc".into()),
            ..unminted.clone()
        };
        assert!(discards_row(&minted, Container::Missing));
        // A container here, or a listing that failed, is never a licence.
        assert!(!discards_row(&minted, Container::Running));
        assert!(!discards_row(&minted, Container::Stopped));
        assert!(!discards_row(&minted, Container::Unknown));
        // A setup that got as far as starting it, or finished once.
        assert!(!discards_row(
            &Record {
                announced: true,
                ..minted.clone()
            },
            Container::Missing
        ));
        assert!(!discards_row(&made(Standing::Ready), Container::Missing));
        assert!(!discards_row(
            &record(Standing::SignedOut),
            Container::Missing
        ));
        // The flag rides the record only when it is set.
        let wire = serde_json::to_value(&minted).unwrap();
        assert!(wire.get("announced").is_none(), "{wire}");
    }

    /* ONE RUN AT A TIME: a live run's lock is followed, a dead one's taken over. */

    fn lock(started: Option<&str>, at: u64) -> RunLock {
        RunLock {
            pid: 4242,
            started: started.map(str::to_string),
            at,
            out: Some("/logs/desktop-machine-setup-1.out".into()),
            err: Some("/logs/desktop-machine-setup-1.err".into()),
        }
    }

    #[test]
    fn a_lock_is_held_only_by_the_very_process_that_took_it() {
        let now = 10_000;
        assert_eq!(holder(None, Some("77"), now), Holder::Free);
        let taken = lock(Some("77"), now - 60);
        assert_eq!(holder(Some(&taken), Some("77"), now), Holder::Live);
        // The process is gone: its lock is taken over.
        assert_eq!(holder(Some(&taken), None, now), Holder::Stale);
        // The pid is alive, started at another time: a process the system gave that pid since.
        assert_eq!(holder(Some(&taken), Some("78"), now), Holder::Stale);
        // A start that could not be read is believed for a while, never for good.
        let unread = lock(None, now - 60);
        assert_eq!(holder(Some(&unread), Some("anything"), now), Holder::Live);
        let old = lock(None, now - LOCK_TRUST.as_secs() - 1);
        assert_eq!(holder(Some(&old), Some("anything"), now), Holder::Stale);
        assert_eq!(holder(Some(&old), None, now), Holder::Stale);
        // On disk as it is read back.
        let back: RunLock = serde_json::from_value(serde_json::to_value(&taken).unwrap()).unwrap();
        assert_eq!(back, taken);
    }

    #[test]
    fn a_processs_start_is_read_past_a_command_name_that_holds_spaces() {
        let stat = "4242 (power shell (x)) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10";
        assert_eq!(start_time_in_stat(stat).as_deref(), Some("987654"));
        let zombie = "4242 (sh) Z 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 0 0";
        assert_eq!(start_time_in_stat(zombie), None);
        assert_eq!(start_time_in_stat("garbage"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_process_has_a_start_and_a_pid_nobody_holds_has_none() {
        assert!(process_started(std::process::id()).is_some());
        assert_eq!(process_started(u32::MAX - 1), None);
    }

    #[test]
    fn docker_is_waited_for_and_never_started() {
        let asleep = Facts {
            docker: Err(DockerReason::NotRunning),
            ..facts()
        };
        assert_eq!(
            decide(&record(Standing::SignedOut), &asleep),
            Decision::Become(Standing::NeedsDocker {
                reason: DockerReason::NotRunning
            })
        );
        assert_eq!(
            decide(&made(Standing::Ready), &asleep),
            Decision::Become(Standing::NeedsDocker {
                reason: DockerReason::NotRunning
            })
        );
        assert_eq!(
            decide(
                &record(Standing::NeedsDocker {
                    reason: DockerReason::NotRunning
                }),
                &asleep
            ),
            Decision::Keep
        );
        // The engine came up: the next round carries on.
        assert_eq!(
            decide(
                &record(Standing::NeedsDocker {
                    reason: DockerReason::NotRunning
                }),
                &facts()
            ),
            Decision::Create { consent: false }
        );
    }

    #[test]
    fn a_setup_the_last_quit_cut_short_is_run_again_on_the_same_row() {
        let mut cut = record(Standing::Creating {
            phase: Some("pulling-image".into()),
            step: None,
            percent: 30,
        });
        cut.sandbox_id = Some("cm-machine".into());
        cut.consented = true;
        assert_eq!(
            decide(
                &cut,
                &Facts {
                    launch: true,
                    ..facts()
                }
            ),
            Decision::Resume { consent: true }
        );
        let mut interrupted = cut.clone();
        interrupted.standing = Standing::Interrupted;
        assert_eq!(
            decide(&interrupted, &facts()),
            Decision::Create { consent: true }
        );
        // A row whose setup never finished, found with no container: finished now, not called gone.
        let mut unfinished = record(Standing::SignedOut);
        unfinished.sandbox_id = Some("cm-machine".into());
        assert_eq!(
            decide(
                &unfinished,
                &Facts {
                    container: Container::Missing,
                    ..facts()
                }
            ),
            Decision::Create { consent: false }
        );
    }

    #[test]
    fn a_stop_that_needs_the_reader_stays_until_they_answer() {
        let failed = made(Standing::Failed { reason: "x".into() });
        let waiting = made(Standing::Waiting {
            waiting_for: WaitingFor::Consent,
        });
        assert_eq!(decide(&failed, &facts()), Decision::Keep);
        assert_eq!(decide(&waiting, &facts()), Decision::Keep);
        assert_eq!(decide(&made(Standing::Gone), &facts()), Decision::Keep);
        let retry = |consent| Facts {
            asked: Some(Ask::Retry { consent }),
            ..facts()
        };
        assert_eq!(
            decide(&failed, &retry(false)),
            Decision::Create { consent: false }
        );
        assert_eq!(
            decide(&waiting, &retry(true)),
            Decision::Create { consent: true }
        );
        assert_eq!(
            decide(&made(Standing::Gone), &retry(false)),
            Decision::Recreate
        );
        assert_eq!(
            decide(
                &made(Standing::Gone),
                &Facts {
                    asked: Some(Ask::Recreate),
                    ..facts()
                }
            ),
            Decision::Recreate
        );
        // The requirements card's go-ahead is a run that sees to Docker itself; any other retry still needs it.
        assert_eq!(
            decide(
                &waiting,
                &Facts {
                    docker: Err(DockerReason::NotInstalled),
                    ..retry(true)
                }
            ),
            Decision::Create { consent: true }
        );
        assert_eq!(
            decide(
                &failed,
                &Facts {
                    docker: Err(DockerReason::NotInstalled),
                    ..retry(false)
                }
            ),
            Decision::Become(Standing::NeedsDocker {
                reason: DockerReason::NotInstalled
            })
        );
    }

    #[test]
    fn a_restart_windows_asked_for_resumes_on_the_next_launch_already_agreed_to() {
        let mut parked = made(Standing::Waiting {
            waiting_for: WaitingFor::Restart,
        });
        parked.made = false;
        parked.resume_on_launch = true;
        let asleep = Facts {
            docker: Err(DockerReason::NotRunning),
            launch: true,
            ..facts()
        };
        assert_eq!(decide(&parked, &asleep), Decision::Create { consent: true });
        assert_eq!(
            decide(
                &parked,
                &Facts {
                    launch: false,
                    ..asleep
                }
            ),
            Decision::Keep
        );
    }

    #[test]
    fn a_made_sandbox_is_what_its_container_is() {
        assert_eq!(
            decide(&made(Standing::SignedOut), &facts()),
            Decision::Become(Standing::Ready)
        );
        assert_eq!(decide(&made(Standing::Ready), &facts()), Decision::Keep);
        assert_eq!(
            decide(
                &made(Standing::Ready),
                &Facts {
                    container: Container::Stopped,
                    ..facts()
                }
            ),
            Decision::Become(Standing::Stopped)
        );
        assert_eq!(
            decide(
                &made(Standing::Ready),
                &Facts {
                    container: Container::Missing,
                    ..facts()
                }
            ),
            Decision::Become(Standing::Gone)
        );
        // A listing that failed changes nothing it could be wrong about.
        assert_eq!(
            decide(
                &made(Standing::Stopped),
                &Facts {
                    container: Container::Unknown,
                    ..facts()
                }
            ),
            Decision::Keep
        );
    }

    #[test]
    fn only_a_round_that_can_change_something_asks_the_machine() {
        assert!(!asks_the_machine(
            &made(Standing::Failed { reason: "x".into() }),
            None,
            false
        ));
        assert!(asks_the_machine(
            &made(Standing::Failed { reason: "x".into() }),
            Some(Ask::Retry { consent: false }),
            false
        ));
        assert!(!asks_the_machine(
            &made(Standing::Waiting {
                waiting_for: WaitingFor::Consent
            }),
            None,
            true
        ));
        assert!(asks_the_machine(&made(Standing::Ready), None, false));
    }

    /* NEWS, ONCE. */

    #[test]
    fn a_notification_is_put_up_once_for_each_thing_that_is_news() {
        let creating = Standing::Creating {
            phase: None,
            step: None,
            percent: 99,
        };
        assert_eq!(
            news(&creating, &Standing::Ready, None).as_deref(),
            Some("ready")
        );
        // Ready again from a stopped container is no news.
        assert_eq!(news(&Standing::Stopped, &Standing::Ready, None), None);
        let docker = Standing::NeedsDocker {
            reason: DockerReason::NotRunning,
        };
        assert_eq!(
            news(&Standing::Ready, &docker, None).as_deref(),
            Some("needsDocker")
        );
        assert_eq!(news(&docker, &docker, Some("needsDocker")), None);
        // Signed out and in again with Docker still off: said once.
        assert_eq!(
            news(&Standing::SignedOut, &docker, Some("needsDocker")),
            None
        );
        let failed = Standing::Failed { reason: "x".into() };
        assert_eq!(
            news(&creating, &failed, Some("needsDocker")).as_deref(),
            Some("failed")
        );
        assert_eq!(news(&creating, &Standing::Stopped, None), None);
        // Up or under way again, a later stop is news again: the morning's sleeping engine is said each morning.
        assert!(moved_on(&docker, &Standing::Ready));
        assert!(moved_on(&failed, &creating));
        assert!(!moved_on(&Standing::Ready, &Standing::Ready));
        assert!(!moved_on(&Standing::Ready, &docker));
    }

    /* FOLDERS. */

    #[test]
    fn a_folder_is_named_once_and_never_onto_another() {
        assert_eq!(unique_name("app", &[]), "app");
        assert_eq!(unique_name("app", &["App".into(), "app-2".into()]), "app-3");
        let long = "a".repeat(64);
        let numbered = unique_name(&long, std::slice::from_ref(&long));
        assert_eq!(numbered.len(), 64);
        assert!(numbered.ends_with("-2"));
        assert!(crate::project::is_project_dir_name(&numbered));
        assert_eq!(unique_name("app.", &["app.".into()]), "app-2");
    }

    #[test]
    fn a_folder_waits_in_line_keeping_its_place() {
        let mut held = record(Standing::Creating {
            phase: None,
            step: None,
            percent: 5,
        });
        assert_eq!(
            enqueue(&mut held, "/home/me/app", "app", &["app".into()]),
            "app-2"
        );
        assert_eq!(
            enqueue(&mut held, "/work/other/app", "app", &["app".into()]),
            "app-3"
        );
        // Asked again: the same name, the same place.
        assert_eq!(enqueue(&mut held, "/home/me/app", "app", &[]), "app-2");
        assert_eq!(held.folders.len(), 2);
        held.folders[0].state = FolderState::Failed;
        held.folders[0].reason = Some("refused".into());
        enqueue(&mut held, "/home/me/app", "app", &[]);
        assert_eq!(
            (held.folders[0].state, held.folders[0].reason.clone()),
            (FolderState::Queued, None)
        );
    }

    #[test]
    fn a_launch_settles_what_the_last_quit_left_mid_attach() {
        let mut held = made(Standing::Ready);
        let folder = |path: &str, state| Folder {
            path: path.into(),
            name: path.trim_start_matches('/').into(),
            state,
            reason: None,
            status: None,
        };
        held.folders = vec![
            folder("/attached", FolderState::Attaching),
            folder("/not-yet", FolderState::Attaching),
            folder("/done", FolderState::Ready),
            folder("/copying", FolderState::Copying),
        ];
        let projects = [Project {
            path: "/attached".into(),
            dir: "attached".into(),
            sandbox_id: Some("cm-machine".into()),
            slug: None,
        }];
        settle_on_launch(&mut held, &projects);
        assert_eq!(
            held.folders
                .iter()
                .map(|folder| (folder.path.as_str(), folder.state))
                .collect::<Vec<_>>(),
            vec![
                ("/attached", FolderState::Copying),
                ("/not-yet", FolderState::Queued),
                ("/copying", FolderState::Copying)
            ]
        );
    }

    #[test]
    fn an_attach_is_the_agents_command_and_its_answer_is_its_own() {
        assert_eq!(
            attach_args("sandbox-2c8e.sbx.intentic.dev", r"C:\Users\me\app", "app"),
            [
                "sync",
                "attach",
                "--sandbox-url",
                "https://sandbox-2c8e.sbx.intentic.dev",
                "--dir",
                r"C:\Users\me\app",
                "--name",
                "app",
                "--json"
            ]
        );
        assert_eq!(
            attach_answer(Ok(
                serde_json::json!({ "ok": true, "pairing": "k", "remoteDir": "/work/app" })
            )),
            Ok(())
        );
        assert_eq!(
            attach_answer(Ok(
                serde_json::json!({ "ok": false, "error": "That folder is already attached." })
            )),
            Err("That folder is already attached.".into())
        );
        assert!(attach_answer(Ok(serde_json::json!({}))).is_err());
        assert!(attach_answer(Err(AgentSilence::Missing))
            .unwrap_err()
            .contains("machine agent"));
    }

    #[test]
    fn a_first_copy_is_done_once_mutagen_watches_for_changes() {
        assert_eq!(copy_state("watching"), FolderState::Ready);
        assert_eq!(copy_state("Watching for changes"), FolderState::Ready);
        for going in [
            "connecting-beta",
            "scanning",
            "reconciling",
            "staging-beta",
            "transitioning",
            "saving",
            "something-new",
        ] {
            assert_eq!(copy_state(going), FolderState::Copying, "{going}");
        }
    }

    #[test]
    fn the_sandbox_is_named_after_this_computer() {
        assert_eq!(
            sandbox_name(Some("ada-laptop\n"), &[]),
            "ada-laptop sandbox"
        );
        assert_eq!(
            sandbox_name(Some("ada-laptop"), &["ADA-LAPTOP sandbox".into()]),
            "ada-laptop sandbox 2"
        );
        assert_eq!(sandbox_name(None, &[]), "This computer's sandbox");
        assert_eq!(sandbox_name(Some("  "), &[]), "This computer's sandbox");
        let long = sandbox_name(Some(&"x".repeat(200)), &[]);
        assert!(crate::project::is_sandbox_name(&long), "{long}");
    }

    #[test]
    fn the_supervisor_rests_by_what_it_waits_for() {
        let mut held = made(Standing::Ready);
        assert_eq!(pause_for(&held), Duration::from_secs(300));
        held.folders.push(Folder {
            path: "/a".into(),
            name: "a".into(),
            state: FolderState::Copying,
            reason: None,
            status: None,
        });
        assert_eq!(pause_for(&held), Duration::from_secs(4));
        assert_eq!(
            pause_for(&record(Standing::NeedsDocker {
                reason: DockerReason::NotRunning
            })),
            Duration::from_secs(15)
        );
        assert_eq!(
            pause_for(&record(Standing::SignedOut)),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn a_held_row_the_platform_no_longer_has_reads_as_gone() {
        use crate::account::Answered;
        let missing = Answered::Json {
            status: 404,
            body: serde_json::json!({ "message": "not found" }),
        };
        let refused = Answered::Json {
            status: 409,
            body: serde_json::json!({}),
        };
        assert!(row_gone(true, &missing));
        assert!(!row_gone(false, &missing));
        assert!(!row_gone(true, &refused));
        assert!(!row_gone(true, &Answered::SignedOut));
    }
}
