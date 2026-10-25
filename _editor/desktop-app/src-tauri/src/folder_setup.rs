//! Makes one sandbox per folder via the connect script (SYNC_DIR, SYNC_REMOTE_DIR=/work/<name>, SYNC_PROJECT=1).
//! One app supervisor serializes setups, persists folder-setups.json and broadcasts progress; interrupted creating runs retry with fresh codes.
//! Require an already-running Docker engine. After setup, follow the first copy until Mutagen watches; bindings then come from agent pairings.
//! Transient completed records are forgotten on relaunch. Pure decision functions let tests cover the state machine without external services.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::project::{Made, Minted};
use crate::scripts::{Heard, Stream};
use crate::setup_link::{NoticeArgs, NoticeKind, SetupArgs};
use crate::setup_progress::{waiting_for, Progress, WaitingFor};
use crate::state::{AppState, SessionEnd};

/// What every window hears on each change: every folder's record.
pub const EVENT: &str = "desktop://folder-setups";
/// Every folder setup's run id begins so (`folder-setup:<key>`): a Quit stops them, and the next launch runs one again.
pub const RUN_PREFIX: &str = "folder-setup:";
/// The records, in the app's config folder.
const FILE: &str = "folder-setups.json";
/// What the one-per-computer sandbox left behind, removed at launch: its record (config folder) and run lock (data).
const RETIRED_RECORD: &str = "machine-sandbox.json";
const RETIRED_LOCK: &str = "machine-setup.pid.json";
/// A setup that finished with no pairing for its folder this long after: the folder's sync never started.
const COPY_SILENCE: Duration = Duration::from_secs(3 * 60);

/* THE RECORD — what is true of one folder's way to its own sandbox, as its windows draw it. */

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

/// Where a folder's setup stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Standing {
    /// Asked for, and in line: the next round takes it, or another folder's setup goes first (`behind`, its name).
    Queued {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        behind: Option<String>,
    },
    /// Nobody is signed in: the setup starts by itself after a sign-in.
    SignedOut,
    /// A sign-in came back from the browser moments ago (auth.rs `complete`), and the workspace has not said who yet.
    SignedIn,
    /// Docker is not there or not answering; never installed or started from here.
    NeedsDocker { reason: DockerReason },
    /// Being made: the running phase (setupPlan.ts ids), its sentence, how far, and roughly how many seconds are left
    /// by the plan's weights (setup_progress.rs `seconds_left`), none until the run has said where it is.
    Creating {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        percent: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        left: Option<u32>,
    },
    /// Stopped on a designed question (exit 3 or 4), or on this PC's own setup: answered on the folder's card.
    Waiting {
        #[serde(rename = "for")]
        waiting_for: WaitingFor,
    },
    /// The sandbox is made and the folder's first copy is under way (`status`, `heldBy` on the record).
    Copying,
    /// The first copy is in, and Mutagen watches for changes: agents can start.
    Ready,
    /// Making it stopped, and why.
    Failed { reason: String },
    /// A setup the last quit cut short, about to run again on the same row.
    Interrupted,
}

impl Default for Standing {
    fn default() -> Standing {
        Standing::Queued { behind: None }
    }
}

impl Standing {
    /// The word the record's `state` is, for comparing two standings by kind.
    fn kind(&self) -> &'static str {
        match self {
            Standing::Queued { .. } => "queued",
            Standing::SignedOut => "signedOut",
            Standing::SignedIn => "signedIn",
            Standing::NeedsDocker { .. } => "needsDocker",
            Standing::Creating { .. } => "creating",
            Standing::Waiting { .. } => "waiting",
            Standing::Copying => "copying",
            Standing::Ready => "ready",
            Standing::Failed { .. } => "failed",
            Standing::Interrupted => "interrupted",
        }
    }

    /// Whether the folder is still on its way to its sandbox: in line, being made, or its first copy under way. A
    /// folder on its way is never asked into a second sandbox, and one inside or around it is turned away (project.rs).
    pub fn on_its_way(&self) -> bool {
        !matches!(self, Standing::Ready | Standing::Failed { .. })
    }
}

/// One folder's line of `folder-setups.json`, and what its windows are sent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// The folder, as its windows are told it (local.rs face `path`).
    pub path: String,
    /// Its name inside its sandbox's `/work` (sandbox-contract's `projectDirNameFor`).
    pub name: String,
    #[serde(flatten)]
    pub standing: Standing,
    /// The sandbox's name on the account: the folder's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_name: Option<String>,
    /// The platform's row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_id: Option<String>,
    /// Its container's slug here, read off its address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    /// Its public address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    /// Whose it is: a different account signed in starts it over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Where the last setup's transcript is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    /// A setup has finished for it: the sandbox runs, and the row is never taken off the account for a failure.
    #[serde(default)]
    pub made: bool,
    /// How many setups have been started for it.
    #[serde(default)]
    pub attempt: u32,
    /// When the folder was asked in, Unix milliseconds: what the press-to-copied time is measured from.
    #[serde(default)]
    pub asked_at: u64,
    /// When the last setup started, Unix milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    /// When a setup finished for it, Unix milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub made_at: Option<u64>,
    /// Unix milliseconds of the last change: an older answer never replaces a newer one in a window.
    #[serde(default)]
    pub updated_at: u64,
    /// The reader agreed to what the setup's first pass said it would change.
    #[serde(default)]
    pub consented: bool,
    /// Windows was asked to end the session for it: the next launch runs it again, already agreed to.
    #[serde(default)]
    pub resume_on_launch: bool,
    /// What a setup stopped on a question said this computer needs (`intentic-requirement:` lines, desktop.ts
    /// `Requirement`), for the folder's card.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requirements: Vec<serde_json::Value>,
    /// The first copy's status: paused, or Mutagen's word while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// While it is paused, why the agent holds its file sync still (`heldBy`, the agent's holds.ts), owner's first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub held_by: Vec<String>,
    /// How far the first copy is, as the agent counts it off Mutagen (its pairing's `copy`); none from an older agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<CopyMeasure>,
    /// When its first copy was seen in, Unix milliseconds: from then on it waits only for its workspace's page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copied_at: Option<u64>,
    /// Its first copy's session has been seen running ([`copy_seen`]).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ran: bool,
    /// The last standing a notification was put up for, so a round that finds the same thing says nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noticed: Option<String>,
    /// A setup got as far as starting its container ([`may_have_announced`]): from then on the row may be live, and
    /// a failure never takes it off the account.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub announced: bool,
}

/// How far a first copy is, in Mutagen's counts as the machine agent reports them (the contract's `DeviceCopySchema`):
/// the folder's files and bytes, and of the pass the sandbox stages, how many files it has and how many bytes crossed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyMeasure {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_files: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staging_files: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_bytes: Option<u64>,
}

/* WHAT TO DO NEXT — the supervisor's decision for one folder, a plain function of its record and what was found. */

/// What a window asked of the supervisor for its folder since the last round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    /// "Try again", or the card's go-ahead for what this computer needs first (`consent`).
    Retry { consent: bool },
}

/// This PC's own setup (WSL, the container engine), for a round that finds no engine answering.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Pc {
    /// No check has landed, or it found the PC ready: an engine that does not answer is Docker's own trouble.
    #[default]
    Unknown,
    /// The PC cannot run a sandbox at all (no virtualization, too little memory, S mode).
    CantRun,
    /// The PC still needs its own setup, which waits for the reader's one consent.
    NeedsSetup,
    /// The PC's own setup is running now: the folder's waits for it.
    SettingUp,
}

impl Pc {
    /// What onboarding.rs knows now: its last check, and whether its setup is running.
    fn now() -> Pc {
        let Some(check) = crate::onboarding::check_snapshot() else {
            return Pc::Unknown;
        };
        match check.state.as_str() {
            "cantRun" => Pc::CantRun,
            "needsSetup" | "checking" | "unknown" if crate::onboarding::setup_running() => {
                Pc::SettingUp
            }
            "needsSetup" | "checking" | "unknown" => Pc::NeedsSetup,
            _ => Pc::Unknown,
        }
    }
}

/// What a round found, for one folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    /// Who the workspace last said is signed in; none when nobody is, or the platform turned the session away.
    pub account: Option<String>,
    /// Ok when the engine answers.
    pub docker: Result<(), DockerReason>,
    /// The first round of this run of the app.
    pub launch: bool,
    pub asked: Option<Ask>,
    pub pc: Pc,
    /// A sign-in came back from the browser less than [`SIGNED_IN_GRACE`] ago: an account not heard of yet is one on
    /// its way, not nobody.
    pub just_signed_in: bool,
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
    /// Another account is signed in: the folder starts over for it.
    Reset,
}

fn become_(record: &Record, standing: Standing) -> Decision {
    if record.standing == standing {
        Decision::Keep
    } else {
        Decision::Become(standing)
    }
}

/// What the card says while this PC's own setup runs ahead of the folder's.
pub const PC_SETTING_UP: &str = "Finishing setup on this PC…";

/// The standing while this PC's own setup runs ahead of the folder's: being made, its first step this PC's.
fn pc_setting_up() -> Standing {
    Standing::Creating {
        phase: None,
        step: Some(PC_SETTING_UP.to_string()),
        percent: 0,
        left: None,
    }
}

/// The supervisor's decision for one folder. A folder whose sandbox is made is only followed; stops that need the
/// reader (a question, a failure) stay put until they answer; everything else follows the account and Docker. Pure.
pub fn decide(record: &Record, facts: &Facts) -> Decision {
    if matches!(record.standing, Standing::Copying | Standing::Ready) {
        return Decision::Keep;
    }
    let Some(account) = facts.account.as_deref() else {
        // Signed in in the browser, the workspace still to say who: on its way until the grace is over.
        if facts.just_signed_in && record.standing == Standing::SignedIn {
            return Decision::Keep;
        }
        return become_(record, Standing::SignedOut);
    };
    if !record.made
        && record
            .account
            .as_deref()
            .is_some_and(|held| held != account)
    {
        return Decision::Reset;
    }
    let retry = facts.asked.map(|Ask::Retry { consent }| consent);
    match (&record.standing, retry) {
        // Windows ended the session for it: the consented run brings Docker up itself, so nothing is checked first.
        (Standing::Waiting { .. }, _) if record.resume_on_launch && facts.launch => {
            return Decision::Create { consent: true };
        }
        // The reader's go-ahead on the card: the consented run (or this PC's own setup) sees to Docker itself.
        (Standing::Waiting { .. }, Some(true)) => return Decision::Create { consent: true },
        (Standing::Waiting { .. } | Standing::Failed { .. }, None) => return Decision::Keep,
        _ => {}
    }
    if facts.docker.is_err() && facts.pc == Pc::SettingUp {
        return become_(record, pc_setting_up());
    }
    // A setup this process is not running: the last one was cut short.
    if matches!(record.standing, Standing::Creating { .. }) {
        return Decision::Resume {
            consent: record.consented,
        };
    }
    if let Err(reason) = facts.docker {
        match facts.pc {
            Pc::CantRun => {
                return become_(
                    record,
                    Standing::Failed {
                        reason: "This PC cannot run a sandbox here. Use a cloud workspace instead."
                            .into(),
                    },
                );
            }
            // This PC's own setup is the way to an engine: it waits for the reader's one consent, never starts unasked.
            Pc::NeedsSetup => {
                return become_(
                    record,
                    Standing::Waiting {
                        waiting_for: WaitingFor::Consent,
                    },
                );
            }
            Pc::SettingUp | Pc::Unknown => {}
        }
        if !matches!(record.standing, Standing::Waiting { .. }) {
            return become_(record, Standing::NeedsDocker { reason });
        }
        return Decision::Keep;
    }
    Decision::Create {
        consent: retry.unwrap_or(record.consented),
    }
}

/// The phases of a setup from which its container may be up and its daemon may have announced itself to the platform:
/// from `starting-sandbox` on (setupPlan.ts). Before it, nothing of the row ever ran anywhere.
const ANNOUNCING: [&str; 5] = [
    "starting-sandbox",
    "waiting-health",
    "desktop-sync",
    "verifying",
    "connecting-machine",
];

/// Whether a setup that reached `phase` may have had its sandbox announce itself. Pure.
pub fn may_have_announced(phase: Option<&str>) -> bool {
    phase.is_some_and(|phase| ANNOUNCING.contains(&phase))
}

/// Whether a container is here, as `ic sandbox list --json` says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Here,
    Missing,
    /// The listing failed: a doubt, never a licence.
    Unknown,
}

/// Whether a setup that stopped leaves a row to take off the account: one that no setup finished and none got as far
/// as starting a container for (so it never announced itself), and whose container this machine does not have. A row
/// like that would wait in the account's switcher as an unfinished sandbox for good. Pure.
pub fn discards_row(record: &Record, container: Container) -> bool {
    record.sandbox_id.is_some()
        && !record.made
        && !record.announced
        && (record.slug.is_none() || container == Container::Missing)
}

/// Whether a round needs Docker's answer for this folder: not for a stop that waits on the reader, nor for a folder
/// whose sandbox is made.
fn asks_the_machine(record: &Record, asked: Option<Ask>, launch: bool) -> bool {
    match record.standing {
        Standing::Waiting { .. } => asked.is_some() || (record.resume_on_launch && launch),
        Standing::Failed { .. } => asked.is_some(),
        Standing::Copying | Standing::Ready => false,
        _ => true,
    }
}

/// The record started over for another account: the folder and its name stay, nothing of the row does. Pure.
pub fn reset_for(record: &Record) -> Record {
    Record {
        path: record.path.clone(),
        name: record.name.clone(),
        asked_at: record.asked_at,
        updated_at: record.updated_at,
        ..Record::default()
    }
}

/// The records as a launch finds them: folders whose first copy finished are nobody's news any more, and a setup cut
/// short stays `creating`, for the first round to run again. Pure.
pub fn settle_on_launch(records: &mut Vec<Record>) {
    records.retain(|record| record.standing != Standing::Ready);
}

/// How long the supervisor rests between rounds: briskly while a copy runs or a folder waits its turn, often while
/// Docker is awaited (the reader is starting it), rarely once there is nothing to wait for. Pure.
pub fn pause_for(records: &[Record]) -> Duration {
    let any = |kind: &str| records.iter().any(|record| record.standing.kind() == kind);
    if any("copying") {
        Duration::from_secs(3)
    } else if any("queued") || any("interrupted") {
        Duration::from_secs(5)
    } else if any("signedIn") {
        // Back from the browser: the platform is asked each round until the session is there, so the folder moves on
        // within moments of the sign-in rather than at the next slow round.
        Duration::from_secs(2)
    } else if any("needsDocker") || any("creating") {
        Duration::from_secs(15)
    } else {
        Duration::from_secs(120)
    }
}

/* THE FIRST COPY — followed in the agent's report until Mutagen watches for changes. */

/// The status a held session is said with.
const PAUSED: &str = "paused";
/// The status of a folder whose copy is in while the workspace's page, put up out of sight for its sandbox, comes up
/// (windows.rs `warm_workspace`): the folder is called ready once Open has a drawn page to show (2026-10-22).
pub const OPENING: &str = "opening";
/// The phase from which the sandbox answers end to end (ic's `verifying` passed), so its workspace's page can be put
/// up while this computer is connected to it and the folder's copy goes in.
const WARM_FROM: &str = "connecting-machine";

/// Whether a folder whose copy is in still waits for the workspace's page: only while that page was put up for its
/// sandbox, has not said it shows it, and [`crate::windows::WARM_FOR`] has not passed since the sandbox was made. Pure.
pub fn waits_for_page(warmth: crate::windows::Warmth, made_at: Option<u64>, now: u64) -> bool {
    warmth == crate::windows::Warmth::Warming
        && made_at
            .is_none_or(|at| now.saturating_sub(at) < crate::windows::WARM_FOR.as_millis() as u64)
}
/// The hold that is the reader's own pause (the agent's `DeviceSyncHold`), the one a press lifts.
const OWNER: &str = "owner";

/// Whether a first copy is done, by its status: `watching` is a copy that is done; every other word (`paused`,
/// `connecting-beta`, `scanning`, `reconciling`, `staging-beta`, `transitioning`, `saving`, and any it may add) is one
/// still followed. Pure.
pub fn copied(status: &str) -> bool {
    status.to_ascii_lowercase().contains("watching")
}

/// Why the agent holds a pairing's file sync still, owner's word first; empty while it runs. `heldBy` is the agent's one
/// answer to whether the sync runs (its holds.ts), where Mutagen's own `paused` only says whether Mutagen has caught up
/// with it. An agent older than holds says `paused` alone: read as the drive's hold where it reports a low disk, else as
/// a pause nobody explained, which is the owner's.
fn holds_of(pairing: &serde_json::Value) -> Vec<String> {
    if let Some(held) = pairing["heldBy"].as_array() {
        return held
            .iter()
            .filter_map(|hold| hold.as_str().map(str::to_string))
            .collect();
    }
    if pairing["paused"].as_bool() != Some(true) {
        return Vec::new();
    }
    let low_disk = pairing.get("lowDisk").is_some_and(|low| !low.is_null());
    vec![if low_disk { "low-disk" } else { OWNER }.to_string()]
}

/// A folder whose first copy is followed, as its pairing's report (`intentic-machine status --json`) finds it; none
/// while the report says nothing of its session yet and nothing holds it. A session seen running is followed to
/// `watching`. A HELD one is said as paused, with why ([`holds_of`]). Only the reader's own pause found BEFORE the copy
/// was ever seen running is no copy waiting: that pause is from before the ask, on a folder synced before, and it is in.
/// Pure.
pub fn copy_seen(record: &Record, pairing: &serde_json::Value) -> Option<Record> {
    let held = holds_of(pairing);
    if held.is_empty() {
        let said = pairing["mutagenStatus"].as_str()?;
        return Some(Record {
            standing: if copied(said) {
                Standing::Ready
            } else {
                Standing::Copying
            },
            status: Some(said.to_string()),
            held_by: Vec::new(),
            copy: serde_json::from_value(pairing["copy"].clone()).ok(),
            ran: true,
            ..record.clone()
        });
    }
    if !record.ran && held.iter().all(|hold| hold == OWNER) {
        return Some(Record {
            standing: Standing::Ready,
            status: None,
            held_by: Vec::new(),
            ..record.clone()
        });
    }
    Some(Record {
        standing: Standing::Copying,
        status: Some(PAUSED.to_string()),
        held_by: held,
        ..record.clone()
    })
}

/// What the card says when a setup finished and the folder's sync never started.
pub fn no_sync(name: &str) -> String {
    format!(
        "{name}'s sandbox works, but this folder isn't syncing to it. Its Devices page says why."
    )
}

/* NAMES. */

/// A sandbox's name as the platform takes one (`sandbox.create`: one to sixty characters), from the folder's own name,
/// else its name in `/work`. Pure.
pub fn sandbox_name_for(folder_name: &str, dir: &str) -> String {
    let trimmed: String = folder_name.trim().chars().take(60).collect();
    let trimmed = trimmed.trim().to_string();
    if crate::project::is_sandbox_name(&trimmed) {
        trimmed
    } else {
        dir.chars().take(60).collect()
    }
}

/// A short, stable key for a folder: its run id and its lock file's name. Pure.
pub fn key_of(path: &str) -> String {
    let digest = Sha256::digest(path.as_bytes());
    digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The run id a folder's setup streams under.
pub fn run_id(path: &str) -> String {
    format!("{RUN_PREFIX}{}", key_of(path))
}

/* NEWS. */

/// Whether a change is worth a notification, and the key it is noticed under: the folder copied in after its setup,
/// and each time it newly needs the reader (a failure, Docker, a question). Never twice for the same standing. Pure.
pub fn news(before: &Standing, after: &Standing, noticed: Option<&str>) -> Option<String> {
    let key = match after {
        Standing::Ready if matches!(before, Standing::Copying) => "ready",
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

/// The setup went from a stop to being made or being in: what was noticed about the stop is over. Pure.
fn moved_on(before: &Standing, after: &Standing) -> bool {
    before.kind() != after.kind()
        && matches!(
            after,
            Standing::Creating { .. } | Standing::Copying | Standing::Ready
        )
}

/// Where a finished run leaves the folder: its first copy under way, a question for the reader, or a failure in the
/// run's own words. Pure.
pub fn outcome(success: bool, code: Option<i32>, progress: &Progress) -> Standing {
    if success {
        return Standing::Copying;
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

/* THE SUPERVISOR — one thread, started at launch, for the life of the app. */

/// The records and where they are kept (lib.rs `manage`).
pub struct FolderSetups {
    path: PathBuf,
    records: Mutex<Vec<Record>>,
}

impl FolderSetups {
    pub fn load(app: &AppHandle) -> tauri::Result<FolderSetups> {
        let config = app.path().app_config_dir()?;
        let path = config.join(FILE);
        let mut records: Vec<Record> = crate::state::read_json(&path).unwrap_or_default();
        settle_on_launch(&mut records);
        // The one-per-computer sandbox's files: its record and its run lock. Its sandbox, if this computer still runs
        // it, is an ordinary sandbox now, which Devices lists like any other.
        let _ = std::fs::remove_file(config.join(RETIRED_RECORD));
        if let Ok(data) = app.path().app_data_dir() {
            let _ = std::fs::remove_file(data.join(RETIRED_LOCK));
        }
        crate::state::write_json(&path, &records);
        Ok(FolderSetups {
            path,
            records: Mutex::new(records),
        })
    }
}

/// What wakes the supervisor before its rest is over, and what for.
#[derive(Default)]
struct Wake {
    kicked: bool,
    asked: Vec<(String, Ask)>,
}

static WAKE: LazyLock<(Mutex<Wake>, Condvar)> = LazyLock::new(Default::default);
/// The platform turned the session away: not asked again until the workspace says who is signed in.
static REFUSED: AtomicBool = AtomicBool::new(false);
/// The app is quitting: a setup stopped now was cut short, not failed.
static EXITING: AtomicBool = AtomicBool::new(false);
/// When a sign-in last came back from the browser ([`signed_in`]).
static SIGNED_IN_AT: Mutex<Option<Instant>> = Mutex::new(None);
/// How long a sign-in that came back waits for the workspace to say who signed in before reading signed out again.
const SIGNED_IN_GRACE: Duration = Duration::from_secs(90);

/// Wake the supervisor for a round now.
pub fn kick() {
    let (wake, bell) = &*WAKE;
    if let Ok(mut wake) = wake.lock() {
        wake.kicked = true;
    }
    bell.notify_all();
}

fn ask(path: &str, asked: Ask) {
    let (wake, bell) = &*WAKE;
    if let Ok(mut wake) = wake.lock() {
        wake.kicked = true;
        wake.asked.retain(|(held, _)| held != path);
        wake.asked.push((path.to_string(), asked));
    }
    bell.notify_all();
}

/// The workspace said who is signed in (`intentic://roster`), or someone signed in or out: asked again from scratch.
pub fn account_changed() {
    REFUSED.store(false, Ordering::SeqCst);
    kick();
}

/// A sign-in came back from the browser (auth.rs `complete`). Every folder waiting on it says so at once, and its
/// setup starts as soon as the workspace has said who signed in.
pub fn signed_in(app: &AppHandle) {
    *SIGNED_IN_AT.lock().unwrap() = Some(Instant::now());
    for record in all(app) {
        if record.standing == Standing::SignedOut {
            update(app, &record.path, |record| {
                record.standing = Standing::SignedIn;
            });
        }
    }
    account_changed();
}

/// Rest for `pause`, or until kicked; answers what was asked meanwhile.
fn rest(pause: Duration) -> Vec<(String, Ask)> {
    let (wake, bell) = &*WAKE;
    let Ok(held) = wake.lock() else {
        std::thread::sleep(pause);
        return Vec::new();
    };
    let mut held = match bell.wait_timeout_while(held, pause, |wake| !wake.kicked) {
        Ok((held, _)) => held,
        Err(poisoned) => poisoned.into_inner().0,
    };
    held.kicked = false;
    std::mem::take(&mut held.asked)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// Every folder's record.
pub fn all(app: &AppHandle) -> Vec<Record> {
    app.state::<FolderSetups>().records.lock().unwrap().clone()
}

/// The record of the folder at `root`, by the path its windows are told, or the same folder spelled another way.
pub fn of_folder(app: &AppHandle, root: &Path) -> Option<Record> {
    let shown = root.display().to_string();
    let records = all(app);
    records
        .iter()
        .find(|record| record.path == shown)
        .or_else(|| {
            records.iter().find(|record| {
                crate::project::folder_paths_same(Path::new(&record.path), root, cfg!(windows))
            })
        })
        .cloned()
}

/// The folders on their way to a sandbox of their own: never asked into a second, nor nested in or around another.
pub fn on_their_way(app: &AppHandle) -> Vec<PathBuf> {
    all(app)
        .into_iter()
        .filter(|record| record.standing.on_its_way())
        .map(|record| PathBuf::from(record.path))
        .collect()
}

/// Whether any folder's setup may still put a sandbox on this machine: what keeps this machine counted as a sandbox
/// host while its listing shows none yet (commands.rs `sandbox_list`, state.rs `forgets_hosting`).
pub fn underway(app: &AppHandle) -> bool {
    all(app).iter().any(|record| record.standing.on_its_way())
}

/// Whether a folder's setup is running right now (a handed-over setup waits its turn: commands.rs `setup_run`).
pub fn running() -> bool {
    crate::scripts::running_ids()
        .iter()
        .any(|id| id.starts_with(RUN_PREFIX))
}

/// The sandboxes the records know by their platform row, its slug and its address (bindings.rs).
pub fn known_rows(app: &AppHandle) -> Vec<crate::bindings::Row> {
    all(app)
        .into_iter()
        .filter_map(|record| {
            Some(crate::bindings::Row {
                id: record.sandbox_id?,
                slug: record.slug,
                hostname: record.hostname,
            })
        })
        .collect()
}

/// Every window told every record.
fn emit(app: &AppHandle, records: &[Record]) {
    if let Err(error) = app.emit(EVENT, records) {
        eprintln!("intentic: the windows could not be told about the folders' sandboxes: {error}");
    }
}

/// One change to a folder's record: written, sent to every window, and a notification put up when it is news.
/// Answers the record as it is now, or none when there is no record for `path`.
fn update(app: &AppHandle, path: &str, change: impl FnOnce(&mut Record)) -> Option<Record> {
    let held = app.state::<FolderSetups>();
    let (before, after, records) = {
        let mut records = held.records.lock().unwrap();
        let record = records.iter_mut().find(|record| record.path == path)?;
        let before = record.clone();
        change(record);
        if *record == before {
            return Some(before);
        }
        record.updated_at = now_ms().max(before.updated_at + 1);
        if let Some(key) = news(
            &before.standing,
            &record.standing,
            record.noticed.as_deref(),
        ) {
            record.noticed = Some(key);
        } else if moved_on(&before.standing, &record.standing) {
            record.noticed = None;
        }
        let after = record.clone();
        crate::state::write_json(&held.path, &*records);
        (before, after, records.clone())
    };
    emit(app, &records);
    crate::first_task::folder_changed(app, &after);
    if after.noticed.is_some() && after.noticed != before.noticed {
        notify(app, &after);
    }
    Some(after)
}

/// A folder asked for, put in line (or brought back into line after a failure), or left where it is when it is on its
/// way already. Answers its record.
fn upsert(app: &AppHandle, path: &str, name: &str) -> Record {
    let held = app.state::<FolderSetups>();
    let existing = held
        .records
        .lock()
        .unwrap()
        .iter()
        .find(|record| record.path == path)
        .cloned();
    match existing {
        Some(record) if record.standing.on_its_way() => record,
        Some(record) => update(app, path, |record| {
            // Asked afresh after a failure, or after a folder that was in (its pairing since let go of): in line again,
            // on the same row when it has one.
            record.standing = Standing::default();
            record.asked_at = now_ms();
            record.status = None;
            record.held_by = Vec::new();
            record.ran = false;
            if !record.made {
                record.name = name.to_string();
            }
        })
        .unwrap_or(record),
        None => {
            let record = Record {
                path: path.to_string(),
                name: name.to_string(),
                asked_at: now_ms(),
                updated_at: now_ms(),
                ..Record::default()
            };
            let records = {
                let mut records = held.records.lock().unwrap();
                records.push(record.clone());
                crate::state::write_json(&held.path, &*records);
                records.clone()
            };
            emit(app, &records);
            record
        }
    }
}

/// A folder's record forgotten.
fn forget(app: &AppHandle, path: &str) {
    let held = app.state::<FolderSetups>();
    let records = {
        let mut records = held.records.lock().unwrap();
        records.retain(|record| record.path != path);
        crate::state::write_json(&held.path, &*records);
        records.clone()
    };
    emit(app, &records);
}

/// The reader is in a window of this computer (the main one or a folder's), where the card already says it.
fn reader_here(app: &AppHandle) -> bool {
    crate::windows::focused_page(app).is_some_and(|label| {
        label == crate::windows::HOME || label.starts_with(crate::local::FILES)
    })
}

/// The system's notification for a record's news.
fn notify(app: &AppHandle, record: &Record) {
    if reader_here(app) {
        return;
    }
    let name = &record.name;
    let folder = Some(format!("{}{}", crate::notice::FOLDER, record.path));
    let (kind, title, body, path) = match &record.standing {
        Standing::Ready => (
            NoticeKind::Finished,
            format!("{name}'s sandbox is ready"),
            "Its agents can start on it now.".to_string(),
            record
                .sandbox_id
                .as_deref()
                .map(|id| crate::project::project_path(id, name)),
        ),
        Standing::Failed { reason } => (
            NoticeKind::Asks,
            format!("{name}'s sandbox wasn't set up"),
            reason.clone(),
            folder,
        ),
        Standing::NeedsDocker { reason } => (
            NoticeKind::Asks,
            format!("{name}'s sandbox needs Docker"),
            match reason {
                DockerReason::NotInstalled => "Install Docker Desktop, and Intentic sets it up.",
                DockerReason::NotRunning => "Start Docker, and Intentic carries on.",
                DockerReason::NotAllowed => {
                    "Docker turns this account away. Devices says how to fix it."
                }
            }
            .to_string(),
            Some(crate::notice::THIS_DEVICE.to_string()),
        ),
        Standing::Waiting { .. } => (
            NoticeKind::Asks,
            format!("{name}'s sandbox needs your OK"),
            "This computer needs a few things before it can run a sandbox.".to_string(),
            folder,
        ),
        _ => return,
    };
    let body: String = body.chars().take(200).collect();
    crate::notice::show(
        app,
        NoticeArgs {
            key: format!("folder-setup:{}", key_of(&record.path)),
            kind,
            title,
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
        .name("folder-setups".into())
        .spawn(move || supervise(&app));
    if let Err(error) = spawned {
        eprintln!("intentic: no thread for the folders' sandboxes: {error}");
    }
}

fn supervise(app: &AppHandle) {
    // The agent first: which folders are in a sandbox is its pairings' to say (bindings.rs), and nothing else holds it.
    crate::bindings::refresh(app);
    // A first task kept across the quit moves on from where it was.
    crate::first_task::on_launch(app);
    let mut launch = true;
    let mut asked = Vec::new();
    loop {
        round(app, launch, &asked);
        launch = false;
        asked = rest(pause_for(&all(app)));
    }
}

/// One round: each folder decided in the order it was asked, one setup made per round, then the first copies.
fn round(app: &AppHandle, launch: bool, asked: &[(String, Ask)]) {
    let account = account_for_round(app, &all(app));
    let pc = Pc::now();
    let just_signed_in = SIGNED_IN_AT
        .lock()
        .unwrap()
        .is_some_and(|at| at.elapsed() < SIGNED_IN_GRACE);
    let mut docker: Option<Result<(), DockerReason>> = None;
    let mut made: Option<String> = None;
    let mut records = all(app);
    records.sort_by_key(|record| record.asked_at);
    for record in records {
        let wanted = asked
            .iter()
            .find(|(path, _)| *path == record.path)
            .map(|(_, ask)| *ask);
        let looked = account.is_some() && asks_the_machine(&record, wanted, launch);
        let docker_now = if looked {
            *docker.get_or_insert_with(docker_facts)
        } else {
            Ok(())
        };
        let facts = Facts {
            account: account.clone(),
            docker: docker_now,
            launch,
            asked: wanted,
            pc,
            just_signed_in,
        };
        match decide(&record, &facts) {
            Decision::Keep => {}
            Decision::Become(standing) => {
                update(app, &record.path, |held| held.standing = standing);
            }
            Decision::Reset => {
                update(app, &record.path, |held| *held = reset_for(held));
                kick();
            }
            Decision::Create { consent } | Decision::Resume { consent } => {
                // One setup at a time on this docker: the rest wait their turn, saying behind whom.
                if let Some(first) = &made {
                    let behind = Some(first.clone());
                    update(app, &record.path, |held| {
                        if !matches!(held.standing, Standing::Waiting { .. }) {
                            held.standing = Standing::Queued { behind };
                        }
                    });
                    continue;
                }
                if matches!(record.standing, Standing::Creating { .. }) {
                    update(app, &record.path, |held| {
                        held.standing = Standing::Interrupted;
                    });
                    if facts.docker.is_err() && !record.resume_on_launch {
                        kick();
                        continue;
                    }
                }
                made = Some(record.name.clone());
                create(app, &record.path, consent);
                docker = None;
            }
        }
    }
    if made.is_some() {
        kick();
    }
    if all(app)
        .iter()
        .any(|record| record.standing == Standing::Copying)
    {
        let report = crate::bindings::refresh(app);
        follow_copies(app, report.as_ref());
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

/// Whether the container `slug` is here, as `ic` lists this machine's sandboxes.
fn container_of(app: &AppHandle, slug: &str) -> Container {
    let listing = crate::scripts::ic_listing(
        app,
        crate::commands::list_script(crate::scripts::Host::current(), crate::commands::VERSION),
    );
    match listing {
        Ok(rows) if rows.iter().any(|row| row["slug"].as_str() == Some(slug)) => Container::Here,
        Ok(_) => Container::Missing,
        Err(error) => {
            eprintln!("intentic: this computer's sandboxes could not be listed: {error}");
            Container::Unknown
        }
    }
}

/// Who is signed in for this round: the app's roster, and, where it names nobody while a folder waits on a sign-in, the
/// platform asked now (account.rs `learn_account`). A sign-in the workspace has not announced is still a sign-in: the
/// workspace announces the account only once it has a sandbox to list, so a reader signing in for their first one was
/// read as signed out, and asked to sign in again once the grace below ran out (2026-10-21). Not asked after the
/// platform turned the session away: nothing changes that until someone signs in again ([`account_changed`]).
fn account_for_round(app: &AppHandle, records: &[Record]) -> Option<String> {
    if REFUSED.load(Ordering::SeqCst) {
        return None;
    }
    let held = app
        .state::<AppState>()
        .roster()
        .account
        .map(|account| account.email);
    if held.is_some() || !records.iter().any(waits_on_account) {
        return held;
    }
    let window = any_window(app)?;
    match tauri::async_runtime::block_on(crate::account::learn_account(app, &window)) {
        crate::account::Session::Someone(account) => Some(account.email),
        crate::account::Session::Nobody | crate::account::Session::Unknown => None,
    }
}

/// A folder whose next step needs someone signed in: one waiting on the sign-in, or in line to be made. Pure.
pub fn waits_on_account(record: &Record) -> bool {
    matches!(
        record.standing,
        Standing::SignedOut | Standing::SignedIn | Standing::Queued { .. } | Standing::Interrupted
    )
}

/// A window whose webview holds the workspace's session (every window shares one browser profile, account.rs).
fn any_window(app: &AppHandle) -> Option<Webview> {
    app.get_webview(crate::windows::WORKSPACE)
        .or_else(|| app.get_webview(crate::windows::HOME))
        .or_else(|| app.webviews().into_values().next())
}

const WAITING_FOR_SETUP: &str = "Waiting for another sandbox's setup on this computer to finish.";

/// Make the folder's sandbox, or finish making it: the row (when the record has none), its setup code, and the connect
/// script with the folder as its project. BLOCKING, for minutes, on the supervisor's own thread.
fn create(app: &AppHandle, path: &str, consent: bool) {
    if crate::onboarding::start_pc_setup_if_needed(app, consent) {
        update(app, path, |record| record.standing = pc_setting_up());
        return;
    }
    let Some(window) = any_window(app) else {
        // No window to read the session from: the next round, once one is open.
        return;
    };
    // A setup handed over from the workspace finishes first: both would drive the same docker.
    let mut said = false;
    while crate::scripts::is_running(crate::commands::SETUP_RUN) {
        if !said {
            update(app, path, |record| {
                record.standing = Standing::Creating {
                    phase: None,
                    step: Some(WAITING_FOR_SETUP.to_string()),
                    percent: 0,
                    left: None,
                };
            });
            said = true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    // The machine agent being put in place ahead (agent_install.rs): its download is the one this setup would make.
    crate::agent_install::wait();
    // A setup a crashed launch left running: followed to its end rather than raced, then the round decides again.
    if follow_live_run(app, path) {
        kick();
        return;
    }
    let roster = app.state::<AppState>().roster();
    let Some(account) = roster.account.as_ref().map(|account| account.email.clone()) else {
        update(app, path, |record| record.standing = Standing::SignedOut);
        return;
    };
    let folder = crate::project::folder_name(Path::new(path));
    let Some(record) = update(app, path, |record| {
        record.account = Some(account);
        record.attempt += 1;
        record.started_at = Some(now_ms());
        record.standing = Standing::Creating {
            phase: None,
            step: None,
            percent: 0,
            left: None,
        };
        record.requirements.clear();
        record.consented = consent;
        record.resume_on_launch = false;
        if record.sandbox_name.is_none() {
            record.sandbox_name = Some(sandbox_name_for(&folder, &record.name));
        }
    }) else {
        return;
    };
    let name = record.sandbox_name.clone().unwrap_or_default();

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
                    update(app, path, |record| record.sandbox_id = Some(id.clone()));
                    // Listed at once, so the folder's sandbox is live before the workspace next lists the account's.
                    let state = app.state::<AppState>();
                    state.remember_roster(crate::project::with_row(state.roster(), &id, &name));
                    id
                }
                Ok(Made::SignedOut) => return signed_out(app, path),
                Ok(Made::Refused(why)) | Err(why) => return failed(app, path, why),
            }
        }
    };

    let minted =
        tauri::async_runtime::block_on(crate::project::mint_code(app, &window, &sandbox_id, None));
    // A row this record made earlier that the platform no longer has (deleted from another device): the record lets go
    // of it, and the next round makes a fresh one.
    if minted
        .as_ref()
        .is_ok_and(|answered| row_gone(reused, answered))
    {
        update(app, path, |record| {
            record.sandbox_id = None;
            record.slug = None;
            record.hostname = None;
            record.announced = false;
            record.standing = Standing::default();
        });
        kick();
        return;
    }
    let (code, slug) = match minted.map(crate::project::minted_code) {
        Ok(Minted::Code {
            code,
            slug,
            hostname,
        }) => {
            update(app, path, |record| {
                if slug.is_some() {
                    record.slug.clone_from(&slug);
                }
                if hostname.is_some() {
                    record.hostname = hostname;
                }
            });
            (code, slug)
        }
        Ok(Minted::SignedOut) => return signed_out(app, path),
        Ok(Minted::Refused(why)) | Err(why) => {
            discard_unannounced(app, &window, path);
            return failed(app, path, why);
        }
    };

    let image_ready = crate::commands::sandbox_image_ready();
    let args = SetupArgs {
        code,
        sandbox_id: Some(sandbox_id.clone()),
        name: Some(name.clone()),
        cf_token: None,
        sync_dir: Some(path.to_string()),
        platform_url: None,
        project: Some(record.name.clone()),
        slug: slug.clone(),
        minted_at: Some(now_ms() / 1000),
        profile: None,
    };
    let script =
        crate::commands::setup_script(&args, &crate::commands::SetupContext::of(app, consent));

    let progress = Arc::new(Mutex::new(Progress::new(cfg!(windows), image_ready)));
    let clock = Arc::new(Mutex::new(StepClock::default()));
    let heard = hearing(app, path, &progress, Some(&clock));
    // The run lock is taken the moment the script starts, and given back however it ends.
    let lock = lock_path(app, path);
    let spawned: crate::scripts::OnSpawn = {
        let lock = lock.clone();
        Box::new(move |child: &crate::scripts::Spawned| take_lock(&lock, child))
    };
    // The sandbox image, fetched ahead while this setup installs Docker (prefetch.rs), as a handed-over setup does.
    crate::prefetch::begin_for_setup(app, consent);
    let ended = crate::scripts::run_heard(app, &run_id(path), script, Some(heard), Some(spawned));
    if let Some(lock) = &lock {
        let _ = std::fs::remove_file(lock);
    }
    if EXITING.load(Ordering::SeqCst) {
        // Stopped by the app's own quit: not a failure to tell anyone about. The next launch finds it creating, and runs
        // it again.
        return;
    }
    let progress = progress
        .lock()
        .map(|held| held.clone())
        .unwrap_or_else(|poisoned| poisoned.into_inner().clone());
    match ended {
        // Made at the device's step ([`made_ahead`]), and followed since: the script's end files its log, whatever the
        // device's own connect came to (the script says that in its log and its warning).
        Ok(ended)
            if all(app)
                .iter()
                .any(|held| held.path == path && made_this_run(held)) =>
        {
            clock_out(app, &clock, if ended.success { "done" } else { "failed" });
            update(app, path, |record| record.log_path = ended.log.clone());
            if record_is(app, path, &Standing::Copying) {
                let report = crate::bindings::refresh(app);
                follow_copies(app, report.as_ref());
            }
        }
        Ok(ended) => {
            let standing = outcome(ended.success, ended.code, &progress);
            clock_out(app, &clock, step_outcome(&standing, ended.code));
            let made = standing == Standing::Copying;
            if made {
                finished(app, &sandbox_id, slug.as_deref(), &name);
                // A run whose last phase was not heard (an older `ic`) puts the page up now.
                warm(app, path);
            } else if matches!(standing, Standing::Failed { .. }) {
                discard_unannounced(app, &window, path);
            }
            // Made, and the run said the folder's sync did not finish: no pairing is coming, so the card says so now
            // rather than after [`COPY_SILENCE`] of a copy that never started.
            let standing = if made && progress.sync_unfinished {
                Standing::Failed {
                    reason: no_sync(&record.name),
                }
            } else {
                standing
            };
            update(app, path, |record| {
                record.log_path = ended.log.clone();
                record.requirements.clone_from(&progress.requirements);
                if made {
                    record.made = true;
                    record.made_at = Some(now_ms());
                    record.consented = false;
                    record.requirements.clear();
                }
                record.standing = standing;
            });
            if record_is(app, path, &Standing::Copying) {
                // The folder's pairing is the agent's now: its windows hear they have a sandbox, and its copy is followed.
                let report = crate::bindings::refresh(app);
                follow_copies(app, report.as_ref());
            }
        }
        Err(why) => {
            clock_out(app, &clock, "failed");
            discard_unannounced(app, &window, path);
            failed(app, path, why);
        }
    }
}

fn record_is(app: &AppHandle, path: &str, standing: &Standing) -> bool {
    all(app)
        .iter()
        .any(|record| record.path == path && record.standing == *standing)
}

/// Whether minting a code for a row this record already held says the row is gone: the platform answers a sandbox it
/// has no row for (or not for this account) with 404. A row made by this very attempt is never read as gone. Pure.
fn row_gone(reused: bool, answered: &crate::account::Answered) -> bool {
    reused && matches!(answered, crate::account::Answered::Json { status: 404, .. })
}

fn signed_out(app: &AppHandle, path: &str) {
    REFUSED.store(true, Ordering::SeqCst);
    update(app, path, |record| record.standing = Standing::SignedOut);
}

fn failed(app: &AppHandle, path: &str, reason: String) {
    update(app, path, |record| {
        record.standing = Standing::Failed { reason }
    });
}

/// A setup that stopped before its sandbox could have announced itself ([`discards_row`]): its row is taken off the
/// account (`/rpc/sandbox/delete`, which the platform holds in its own trash for the recovery window), the record
/// forgets it, so the next try makes a fresh one. Best effort: a row the platform would not delete stays.
fn discard_unannounced(app: &AppHandle, window: &Webview, path: &str) {
    let Some(record) = all(app).into_iter().find(|record| record.path == path) else {
        return;
    };
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
    update(app, path, |record| {
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

/* WHERE A SETUP'S TIME GOES — each step's seconds, sent as the handed-over setup's are (`desktop_install_step`, with
 * `run: folder`), and the press-to-copied time once the folder is in (`desktop_folder_sandbox_ready`): what the
 * ~25 s target is measured by (launch.rs reports). */

/// The step the run is on, since when, and within it the agent's own step (`sync-enrolling`…), since when.
#[derive(Default)]
struct StepClock {
    phase: Option<String>,
    since: Option<Instant>,
    inner: Option<(String, Instant)>,
}

/// A step the clock moved off: the plan's step it ran inside (none for one of the plan's own), its name, how long.
type Moved = (Option<String>, String, Duration);

/// Which agent's own steps a plan step holds, by the prefix they are named with: the sync agent's in `desktop-sync`,
/// the device agent's in `connecting-machine`. Before the first of them, the agent's shim and its self-update run, timed
/// as `<prefix>-preparing` (the stretch that took 30 s once, 2026-10-22). Pure.
fn inner_prefix(phase: &str) -> Option<&'static str> {
    match phase {
        "desktop-sync" => Some("sync"),
        "connecting-machine" => Some("device"),
        _ => None,
    }
}

impl StepClock {
    /// A line heard at `now`: the plan's step it leaves the run on (`phase`) and the phase the line itself names, if
    /// any (`said`). The steps moved off, the inner one before the one holding it. Pure.
    fn heard(&mut self, phase: Option<&str>, said: Option<&str>, now: Instant) -> Vec<Moved> {
        let mut moved = Vec::new();
        if self.phase.as_deref() != phase {
            moved.extend(self.inner_off(now));
            if let (Some(left), Some(since)) = (self.phase.take(), self.since) {
                moved.push((None, left, now.saturating_duration_since(since)));
            }
            self.phase = phase.map(str::to_string);
            self.since = Some(now);
            if let Some(prefix) = phase.and_then(inner_prefix) {
                self.inner = Some((format!("{prefix}-preparing"), now));
            }
        }
        let prefix = self.phase.as_deref().and_then(inner_prefix);
        if let (Some(said), Some(prefix)) = (said, prefix) {
            let ours = said
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('-'));
            if ours && self.inner.as_ref().is_none_or(|(held, _)| held != said) {
                moved.extend(self.inner_off(now));
                self.inner = Some((said.to_string(), now));
            }
        }
        moved
    }

    /// The run ended at `now`: the steps it was on. Pure.
    fn out(&mut self, now: Instant) -> Vec<Moved> {
        let mut moved = self.inner_off(now);
        if let (Some(left), Some(since)) = (self.phase.take(), self.since.take()) {
            moved.push((None, left, now.saturating_duration_since(since)));
        }
        moved
    }

    fn inner_off(&mut self, now: Instant) -> Vec<Moved> {
        self.inner
            .take()
            .map(|(inner, since)| {
                (
                    self.phase.clone(),
                    inner,
                    now.saturating_duration_since(since),
                )
            })
            .into_iter()
            .collect()
    }
}

/// Seconds to a tenth, as every timing is reported in.
fn tenths(elapsed: Duration) -> u64 {
    (elapsed.as_millis() / 100) as u64
}

fn report(app: &AppHandle, moved: Vec<Moved>, ending: &str) {
    for (parent, step, took) in moved {
        crate::launch::note_folder_step(app, parent.as_deref(), &step, tenths(took), ending);
    }
}

/// The steps a line moved the run off, reported as done.
fn clock_to(
    app: &AppHandle,
    clock: &Arc<Mutex<StepClock>>,
    phase: Option<&str>,
    said: Option<&str>,
) {
    let moved = match clock.lock() {
        Ok(mut held) => held.heard(phase, said, Instant::now()),
        Err(_) => return,
    };
    report(app, moved, "done");
}

/// The steps the run ended on, reported with how it ended.
fn clock_out(app: &AppHandle, clock: &Arc<Mutex<StepClock>>, ending: &str) {
    let moved = match clock.lock() {
        Ok(mut held) => held.out(Instant::now()),
        Err(_) => return,
    };
    report(app, moved, ending);
}

/// How a run ended, for the step it ended on, in the handed-over setup's words (installTelemetry.ts `runEnding`). Pure.
pub fn step_outcome(standing: &Standing, code: Option<i32>) -> &'static str {
    match standing {
        Standing::Copying => "done",
        Standing::Waiting { .. } if code == Some(4) => "parked",
        Standing::Waiting { .. } => "consent",
        _ => "failed",
    }
}

/// What hears a setup's lines (its own run, or one a crashed launch left running): each folded into `progress`, the
/// record moved on when what the card shows changed, and each step's time kept (`clock`, for a run of this launch's).
fn hearing(
    app: &AppHandle,
    path: &str,
    progress: &Arc<Mutex<Progress>>,
    clock: Option<&Arc<Mutex<StepClock>>>,
) -> Heard {
    let app = app.clone();
    let path = path.to_string();
    let progress = Arc::clone(progress);
    let clock = clock.map(Arc::clone);
    let warmed = Arc::new(AtomicBool::new(false));
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
        if let Some(clock) = &clock {
            let said = crate::setup_progress::parse_step(line).map(|(phase, _)| phase);
            clock_to(&app, clock, shown.phase.as_deref(), said.as_deref());
        }
        update(&app, &path, |record| {
            if matches!(record.standing, Standing::Creating { .. }) {
                record.standing = Standing::Creating {
                    phase: shown.phase.clone(),
                    step: shown.step.clone(),
                    percent: shown.percent,
                    left: shown.seconds_left(),
                };
            }
            if may_have_announced(shown.phase.as_deref()) {
                record.announced = true;
            }
            record.requirements.clone_from(&shown.requirements);
        });
        if shown.phase.as_deref() == Some(WARM_FROM) && !warmed.swap(true, Ordering::SeqCst) {
            made_ahead(&app, &path, shown.sync_unfinished);
        }
    })
}

/* THE FOLDER IS IN BEFORE THIS COMPUTER IS A DEVICE (2026-10-22). `ic` connects this computer as a device last, after
 * the sandbox was verified end to end, and never fails a setup over it (connect.rs `run_host_agent`): 4 s at the
 * median, 13 s with the agent's first start. The folder waited for it all the same, since it was called made only when
 * the script ended. It is made now at that step's start ([`WARM_FROM`]): its copy is followed and its workspace put up
 * while the device connects behind it, and the script's end only files its log. */

/// Whether `record` was made by its setup under way now: made since that setup started. Pure.
pub fn made_this_run(record: &Record) -> bool {
    record.made
        && record
            .made_at
            .zip(record.started_at)
            .is_some_and(|(made, started)| made >= started)
}

/// The sandbox answers end to end and the folder's sync was set up: the folder is made (or made with a sync that never
/// started, said so), its workspace put up, and its copy followed for as long as the script still runs.
fn made_ahead(app: &AppHandle, path: &str, sync_unfinished: bool) {
    let Some(record) = all(app).into_iter().find(|record| record.path == path) else {
        return;
    };
    let (Some(sandbox), Some(name)) = (record.sandbox_id.clone(), record.sandbox_name.clone())
    else {
        return;
    };
    finished(app, &sandbox, record.slug.as_deref(), &name);
    let standing = if sync_unfinished {
        Standing::Failed {
            reason: no_sync(&record.name),
        }
    } else {
        Standing::Copying
    };
    update(app, path, |held| {
        if !matches!(held.standing, Standing::Creating { .. }) {
            return;
        }
        held.made = true;
        held.made_at = Some(now_ms());
        held.consented = false;
        held.requirements.clear();
        held.standing = standing;
    });
    warm(app, path);
    let app = app.clone();
    let path = path.to_string();
    std::thread::spawn(move || {
        // The supervisor is held by this run until it ends, and takes the copy over then.
        let run = run_id(&path);
        while crate::scripts::is_running(&run) && record_is(&app, &path, &Standing::Copying) {
            let report = crate::bindings::refresh(&app);
            follow_copies(&app, report.as_ref());
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/* ONE RUN PER FOLDER, ACROSS LAUNCHES TOO.
 *
 * A quit stops the setups it is running (`before_exit`), but a hard crash stops nothing: its script goes on, writing to
 * its own files (scripts.rs `Spool`), and the next launch would find the record `creating` and start a second setup
 * beside the first, both claiming one row and driving one docker. So a run holds a lock while it lives, a pidfile in the
 * app's data folder with the script's pid and the start time its system gives that process. A launch that finds the
 * lock's process alive follows that run from its files until it ends ([`follow_live_run`]), then decides again. */

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

/// Who holds `lock`, given the start time the system gives its pid now (`None`: no such process) and the time now (Unix
/// seconds). A lock that recorded no start time is believed for [`LOCK_TRUST`] while its pid lives. Pure.
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

/// When the system says process `pid` started, or none when there is no such process.
fn process_started(pid: u32) -> Option<String> {
    crate::launch::process_identity(pid)
}

/// Where a folder's lock lives: the app's data folder.
fn lock_path(app: &AppHandle, path: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("folder-setup-{}.pid.json", key_of(path))))
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
            at: now_ms() / 1000,
            out: Some(child.out.display().to_string()),
            err: Some(child.err.display().to_string()),
        },
    );
}

/// A folder's setup a crashed launch left running, followed from its files until it ends: true when there was one. A
/// lock whose run is gone is taken over (removed here, taken again by the run about to start).
fn follow_live_run(app: &AppHandle, path: &str) -> bool {
    let Some(lock_file) = lock_path(app, path) else {
        return false;
    };
    let Some(lock) = crate::state::read_json::<RunLock>(&lock_file) else {
        return false;
    };
    let live = || {
        holder(
            Some(&lock),
            process_started(lock.pid).as_deref(),
            now_ms() / 1000,
        ) == Holder::Live
    };
    if !live() {
        let _ = std::fs::remove_file(&lock_file);
        return false;
    }
    update(app, path, |record| {
        record.standing = Standing::Creating {
            phase: None,
            step: Some(FOLLOWING_RUN.to_string()),
            percent: 0,
            left: None,
        };
    });
    let progress = Arc::new(Mutex::new(Progress::new(cfg!(windows), false)));
    let heard = hearing(app, path, &progress, None);
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
        let _ = std::fs::remove_file(&lock_file);
    }
    true
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

/// Each folder's first copy, as the machine agent reports its pairing (`report`): done once Mutagen watches for changes
/// ([`copy_seen`]). A folder with no pairing [`COPY_SILENCE`] after its setup finished never started syncing. Nothing
/// while the agent could not be read.
fn follow_copies(app: &AppHandle, report: Option<&serde_json::Value>) {
    let Some(report) = report else {
        return;
    };
    let copying: Vec<Record> = all(app)
        .into_iter()
        .filter(|record| record.standing == Standing::Copying)
        .collect();
    for record in copying {
        let pairings = crate::project::pairings_of(report, Path::new(&record.path), cfg!(windows));
        let ours = pairings
            .iter()
            .find(|pairing| {
                record
                    .slug
                    .as_deref()
                    .is_some_and(|slug| pairing["slug"].as_str() == Some(slug))
                    || record.hostname.as_deref().is_some_and(|hostname| {
                        pairing["sandboxId"].as_str()
                            == Some(crate::bindings::agent_id_of(hostname).as_str())
                    })
            })
            .or_else(|| pairings.first());
        let Some(pairing) = ours else {
            let silent = record
                .made_at
                .is_some_and(|at| now_ms().saturating_sub(at) > COPY_SILENCE.as_millis() as u64);
            if silent {
                let reason = no_sync(&record.name);
                update(app, &record.path, |held| {
                    if held.standing == Standing::Copying {
                        held.standing = Standing::Failed { reason };
                    }
                });
            }
            continue;
        };
        let Some(mut seen) = copy_seen(&record, pairing) else {
            continue;
        };
        // The copy is in: ready once Open has a drawn page to show, not a page to load.
        let warmth = record
            .sandbox_id
            .as_deref()
            .map_or(crate::windows::Warmth::Cold, crate::windows::warmth);
        if seen.standing == Standing::Ready {
            seen.copied_at = Some(record.copied_at.unwrap_or_else(now_ms));
            if waits_for_page(warmth, record.made_at, now_ms()) {
                seen.standing = Standing::Copying;
                seen.status = Some(OPENING.to_string());
            }
        }
        let now_ready = seen.standing == Standing::Ready;
        update(app, &record.path, |held| {
            // Only a folder still copying: one asked again meanwhile is its own.
            if held.standing == Standing::Copying {
                held.standing = seen.standing.clone();
                held.status = seen.status.clone();
                held.held_by = seen.held_by.clone();
                held.copy = seen.copy.clone();
                held.ran = seen.ran;
                held.copied_at = seen.copied_at;
            }
        });
        if now_ready {
            let workspace = match warmth {
                crate::windows::Warmth::Shown => "shown",
                crate::windows::Warmth::Warming => "late",
                crate::windows::Warmth::Cold => "cold",
            };
            note_ready(app, &seen, workspace);
        }
    }
}

/// A folder just called ready: its press-to-ready time, the part of it its copy took after its sandbox was made, and
/// how long it then waited for its workspace's page, with how that ended (`workspace`).
fn note_ready(app: &AppHandle, record: &Record, workspace: &str) {
    let now = now_ms();
    let asked = Duration::from_millis(now.saturating_sub(record.asked_at));
    let copied = record.copied_at.unwrap_or(now);
    let copying = record
        .made_at
        .map(|at| Duration::from_millis(copied.saturating_sub(at)));
    let opening = record
        .copied_at
        .map(|at| Duration::from_millis(now.saturating_sub(at)));
    crate::launch::note_folder_ready(
        app,
        tenths(asked),
        copying.map(tenths),
        opening.map(tenths),
        workspace,
    );
}

/// The workspace's page, put up for a folder's sandbox, says it shows it (windows.rs): each folder whose copy is in and
/// waited on that page is ready now, rather than at the supervisor's next round.
pub fn workspace_shown(app: &AppHandle, sandbox: &str) {
    let opening: Vec<Record> = all(app)
        .into_iter()
        .filter(|record| {
            record.standing == Standing::Copying
                && record.status.as_deref() == Some(OPENING)
                && record.sandbox_id.as_deref() == Some(sandbox)
        })
        .collect();
    for record in opening {
        let mut flipped = false;
        update(app, &record.path, |held| {
            if held.standing == Standing::Copying && held.status.as_deref() == Some(OPENING) {
                held.standing = Standing::Ready;
                held.status = Some("watching".to_string());
                flipped = true;
            }
        });
        if flipped {
            note_ready(app, &record, "shown");
        }
    }
}

/// Put the workspace's page up out of sight for the folder's sandbox, on the folder (windows.rs `warm_workspace`), once
/// the sandbox answers end to end. Nothing for a record with no sandbox yet.
fn warm(app: &AppHandle, path: &str) {
    let Some(record) = all(app).into_iter().find(|record| record.path == path) else {
        return;
    };
    if let Some(sandbox) = record.sandbox_id.as_deref() {
        crate::windows::warm_workspace(
            app,
            sandbox,
            &crate::project::project_path(sandbox, &record.name),
        );
    }
}

/// A folder asked for its own sandbox (project.rs `project_create`, first_task.rs): put in line under `name`, its name
/// in `/work`, and the supervisor told. Answers at once, whatever is under way.
pub fn begin(app: &AppHandle, root: &Path, name: &str) -> Record {
    let record = upsert(app, &root.display().to_string(), name);
    kick();
    record
}

/// The app is quitting: every folder's setup under way is stopped with everything it started, and left `creating` for
/// the next launch to run again (lib.rs, `RunEvent::Exit`).
pub fn before_exit() {
    EXITING.store(true, Ordering::SeqCst);
    for id in crate::scripts::running_ids() {
        if id.starts_with(RUN_PREFIX) {
            if let Err(error) = crate::scripts::stop(&id) {
                eprintln!("intentic: a folder's sandbox setup was not stopped: {error}");
            }
        }
    }
}

/* WHAT THE WINDOWS CALL — each about the window's own folder, never a folder a page names. */

/// The folder a window shows, or why it has none.
fn window_folder(app: &AppHandle, window: &Webview) -> Result<String, String> {
    let root = crate::local::folder_of(app, window.label())
        .ok_or_else(|| "This window shows no folder of its own.".to_string())?;
    of_folder(app, &root)
        .map(|record| record.path)
        .ok_or_else(|| "This folder isn't on its way to a sandbox.".to_string())
}

/// Every folder's record, for a window opening after the last change (every later one arrives as
/// `desktop://folder-setups`).
#[tauri::command]
pub fn folder_setups(app: AppHandle) -> Vec<Record> {
    all(&app)
}

/// "Try again" on the window's folder, or the card's go-ahead for what this computer needs first (`consent`).
#[tauri::command]
pub fn folder_setup_retry(app: AppHandle, window: Webview, consent: bool) -> Result<(), String> {
    let path = window_folder(&app, &window)?;
    ask(&path, Ask::Retry { consent });
    Ok(())
}

/// Look again now: Docker was just started, or the reader is waiting on the card.
#[tauri::command]
pub fn folder_setup_check() {
    kick();
}

/// Restart or sign out for what the window's folder's setup asked of Windows: the next launch runs it again, agreed to.
#[tauri::command]
pub fn folder_setup_end_session(
    app: AppHandle,
    window: Webview,
    how: SessionEnd,
) -> Result<(), String> {
    let path = window_folder(&app, &window)?;
    update(&app, &path, |record| {
        record.resume_on_launch = true;
        record.consented = true;
    });
    crate::commands::end_session(how).inspect_err(|_| {
        update(&app, &path, |record| record.resume_on_launch = false);
    })
}

/// The window's folder no longer asked for: a setup that stopped is put away, and a row nothing of which ever ran goes
/// off the account with it. A setup under way is not cancelled here: it is minutes from done, and its card says so.
#[tauri::command]
pub async fn folder_setup_dismiss(app: AppHandle, window: Webview) -> Result<(), String> {
    let path = window_folder(&app, &window)?;
    let record = all(&app).into_iter().find(|record| record.path == path);
    if record.is_some_and(|record| {
        matches!(
            record.standing,
            Standing::Creating { .. } | Standing::Copying | Standing::Interrupted
        )
    }) {
        return Err(
            "This folder's sandbox is being set up. It's a minute or two from done.".to_string(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(session) = any_window(&app) {
            discard_unannounced(&app, &session, &path);
        }
        forget(&app, &path);
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(standing: Standing) -> Record {
        Record {
            path: "C:\\Users\\me\\shop".into(),
            name: "shop".into(),
            standing,
            account: Some("me@example.com".into()),
            asked_at: 1,
            ..Record::default()
        }
    }

    fn made(standing: Standing) -> Record {
        Record {
            sandbox_id: Some("cm-shop".into()),
            slug: Some("sandbox-2c8eb2c5b3a5".into()),
            hostname: Some("sandbox-2c8eb2c5b3a5.sbx.intentic.dev".into()),
            made: true,
            announced: true,
            ..record(standing)
        }
    }

    fn facts() -> Facts {
        Facts {
            account: Some("me@example.com".into()),
            docker: Ok(()),
            launch: false,
            asked: None,
            pc: Pc::Unknown,
            just_signed_in: false,
        }
    }

    /// The record is one object, its state a word beside the rest, as the windows read it (desktop.ts `FolderSetup`).
    #[test]
    fn the_record_is_one_object_its_state_a_word_beside_the_rest() {
        let creating = Record {
            standing: Standing::Creating {
                phase: Some("pulling-image".into()),
                step: Some("using the image already here".into()),
                percent: 12,
                left: None,
            },
            ..record(Standing::default())
        };
        let json = serde_json::to_value(&creating).unwrap();
        assert_eq!(json["state"], "creating");
        assert_eq!(json["phase"], "pulling-image");
        assert_eq!(json["percent"], 12);
        assert_eq!(json["path"], "C:\\Users\\me\\shop");
        assert_eq!(json["name"], "shop");
        assert_eq!(json["askedAt"], 1);
        let queued = serde_json::to_value(record(Standing::Queued {
            behind: Some("notes".into()),
        }))
        .unwrap();
        assert_eq!(
            (queued["state"].as_str(), queued["behind"].as_str()),
            (Some("queued"), Some("notes"))
        );
        let waiting = serde_json::to_value(record(Standing::Waiting {
            waiting_for: WaitingFor::Restart,
        }))
        .unwrap();
        assert_eq!(waiting["for"], "restart");
        let back: Record =
            serde_json::from_value(serde_json::to_value(&creating).unwrap()).unwrap();
        assert_eq!(back, creating);
        // A record from before a field existed still reads.
        let old: Record =
            serde_json::from_str(r#"{"path":"/a","name":"a","state":"queued"}"#).unwrap();
        assert_eq!(old.standing, Standing::Queued { behind: None });
    }

    #[test]
    fn nobody_signed_in_is_signed_out_whatever_it_was() {
        let nobody = Facts {
            account: None,
            ..facts()
        };
        for standing in [
            Standing::default(),
            Standing::NeedsDocker {
                reason: DockerReason::NotRunning,
            },
            Standing::Failed { reason: "x".into() },
        ] {
            assert_eq!(
                decide(&record(standing), &nobody),
                Decision::Become(Standing::SignedOut)
            );
        }
        // Back from the browser, the account on its way: kept as signed in for the grace.
        let back = Facts {
            just_signed_in: true,
            ..nobody.clone()
        };
        assert_eq!(decide(&record(Standing::SignedIn), &back), Decision::Keep);
        // A folder whose sandbox is made is followed, whoever is signed in.
        assert_eq!(decide(&made(Standing::Copying), &nobody), Decision::Keep);
    }

    #[test]
    fn a_folder_asked_for_is_made_as_soon_as_someone_is_signed_in_and_docker_answers() {
        assert_eq!(
            decide(&record(Standing::default()), &facts()),
            Decision::Create { consent: false }
        );
        assert_eq!(
            decide(&record(Standing::SignedOut), &facts()),
            Decision::Create { consent: false }
        );
        // Another account signed in: the folder starts over for it, unless its sandbox is made already.
        let other = Facts {
            account: Some("ada@example.com".into()),
            ..facts()
        };
        assert_eq!(
            decide(&record(Standing::default()), &other),
            Decision::Reset
        );
        assert_eq!(decide(&made(Standing::Copying), &other), Decision::Keep);
        let fresh = reset_for(&made(Standing::Failed { reason: "x".into() }));
        assert_eq!(
            (
                fresh.sandbox_id,
                fresh.account,
                fresh.name.as_str(),
                fresh.standing
            ),
            (None, None, "shop", Standing::default())
        );
    }

    #[test]
    fn docker_is_waited_for_and_never_started() {
        let off = Facts {
            docker: Err(DockerReason::NotRunning),
            ..facts()
        };
        assert_eq!(
            decide(&record(Standing::default()), &off),
            Decision::Become(Standing::NeedsDocker {
                reason: DockerReason::NotRunning
            })
        );
        assert_eq!(
            decide(
                &record(Standing::NeedsDocker {
                    reason: DockerReason::NotRunning
                }),
                &off
            ),
            Decision::Keep
        );
        // Once it answers, the folder's setup runs.
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
    fn this_pcs_own_setup_waits_for_consent_and_runs_ahead_of_the_folders() {
        let needs = Facts {
            docker: Err(DockerReason::NotInstalled),
            pc: Pc::NeedsSetup,
            ..facts()
        };
        assert_eq!(
            decide(&record(Standing::default()), &needs),
            Decision::Become(Standing::Waiting {
                waiting_for: WaitingFor::Consent
            })
        );
        let waiting = record(Standing::Waiting {
            waiting_for: WaitingFor::Consent,
        });
        assert_eq!(decide(&waiting, &needs), Decision::Keep);
        let yes = Facts {
            asked: Some(Ask::Retry { consent: true }),
            ..needs.clone()
        };
        assert_eq!(decide(&waiting, &yes), Decision::Create { consent: true });
        // While this PC's own setup runs, the folder says so rather than asking for Docker.
        let setting_up = Facts {
            pc: Pc::SettingUp,
            ..needs.clone()
        };
        assert_eq!(
            decide(&record(Standing::default()), &setting_up),
            Decision::Become(pc_setting_up())
        );
        assert_eq!(
            decide(&record(pc_setting_up()), &setting_up),
            Decision::Keep
        );
        let cant = Facts {
            pc: Pc::CantRun,
            ..needs
        };
        assert!(matches!(
            decide(&record(Standing::default()), &cant),
            Decision::Become(Standing::Failed { .. })
        ));
    }

    #[test]
    fn a_stop_that_needs_the_reader_stays_until_they_answer() {
        let failed = record(Standing::Failed { reason: "x".into() });
        assert_eq!(decide(&failed, &facts()), Decision::Keep);
        let again = Facts {
            asked: Some(Ask::Retry { consent: false }),
            ..facts()
        };
        assert_eq!(decide(&failed, &again), Decision::Create { consent: false });
        // Windows ended the session for it: the next launch runs it again, agreed to.
        let resumed = Record {
            resume_on_launch: true,
            ..record(Standing::Waiting {
                waiting_for: WaitingFor::Restart,
            })
        };
        let launch = Facts {
            launch: true,
            docker: Err(DockerReason::NotRunning),
            ..facts()
        };
        assert_eq!(
            decide(&resumed, &launch),
            Decision::Create { consent: true }
        );
    }

    #[test]
    fn a_setup_the_last_quit_cut_short_is_run_again_on_the_same_row() {
        let cut = Record {
            consented: true,
            ..made(Standing::Creating {
                phase: Some("pulling-image".into()),
                step: None,
                percent: 30,
                left: None,
            })
        };
        let cut = Record { made: false, ..cut };
        assert_eq!(decide(&cut, &facts()), Decision::Resume { consent: true });
        assert_eq!(
            decide(&record(Standing::Interrupted), &facts()),
            Decision::Create { consent: false }
        );
    }

    #[test]
    fn a_row_is_announced_from_the_moment_its_container_is_started() {
        assert!(!may_have_announced(None));
        assert!(!may_have_announced(Some("pulling-image")));
        for phase in ANNOUNCING {
            assert!(may_have_announced(Some(phase)), "{phase}");
        }
    }

    #[test]
    fn only_a_row_nothing_of_which_ever_ran_is_taken_off_the_account() {
        let unfinished = Record {
            sandbox_id: Some("cm-shop".into()),
            ..record(Standing::Failed { reason: "x".into() })
        };
        assert!(discards_row(&unfinished, Container::Missing));
        let with_slug = Record {
            slug: Some("sandbox-x".into()),
            ..unfinished.clone()
        };
        assert!(discards_row(&with_slug, Container::Missing));
        assert!(!discards_row(&with_slug, Container::Here));
        assert!(!discards_row(&with_slug, Container::Unknown));
        let announced = Record {
            announced: true,
            ..unfinished.clone()
        };
        assert!(!discards_row(&announced, Container::Missing));
        assert!(!discards_row(&made(Standing::Copying), Container::Missing));
        assert!(!discards_row(
            &record(Standing::default()),
            Container::Missing
        ));
    }

    #[test]
    fn a_finished_run_is_a_copy_under_way_a_question_or_a_failure() {
        let progress = Progress::new(false, true);
        assert_eq!(outcome(true, Some(0), &progress), Standing::Copying);
        assert!(matches!(
            outcome(false, Some(7), &progress),
            Standing::Failed { reason } if reason.contains("status 7")
        ));
        assert_eq!(
            outcome(false, Some(4), &progress),
            Standing::Waiting {
                waiting_for: WaitingFor::Restart
            }
        );
        assert_eq!(step_outcome(&Standing::Copying, Some(0)), "done");
        assert_eq!(
            step_outcome(
                &Standing::Waiting {
                    waiting_for: WaitingFor::Restart
                },
                Some(4)
            ),
            "parked"
        );
        assert_eq!(
            step_outcome(&Standing::Failed { reason: "x".into() }, Some(1)),
            "failed"
        );
    }

    #[test]
    fn a_first_copy_is_done_once_mutagen_watches_for_changes() {
        let copying = made(Standing::Copying);
        let running = serde_json::json!({ "mutagenStatus": "staging-beta" });
        let seen = copy_seen(&copying, &running).unwrap();
        assert_eq!(
            (seen.standing.clone(), seen.status.as_deref(), seen.ran),
            (Standing::Copying, Some("staging-beta"), true)
        );
        let watching = serde_json::json!({ "mutagenStatus": "Watching for changes" });
        assert_eq!(
            copy_seen(&seen, &watching).unwrap().standing,
            Standing::Ready
        );
        // Nothing said yet: nothing to change.
        assert_eq!(copy_seen(&copying, &serde_json::json!({})), None);
    }

    #[test]
    fn a_first_copy_carries_the_agents_count_of_it_and_none_from_an_older_agent() {
        let copying = made(Standing::Copying);
        let counted = serde_json::json!({
            "mutagenStatus": "staging-beta",
            "copy": { "files": 328, "bytes": 3145728, "stagedFiles": 142, "stagingFiles": 328, "stagedBytes": 1200000 }
        });
        assert_eq!(
            copy_seen(&copying, &counted).unwrap().copy,
            Some(CopyMeasure {
                files: Some(328),
                bytes: Some(3_145_728),
                staged_files: Some(142),
                staging_files: Some(328),
                staged_bytes: Some(1_200_000),
            })
        );
        let older = serde_json::json!({ "mutagenStatus": "scanning" });
        assert_eq!(copy_seen(&copying, &older).unwrap().copy, None);
    }

    #[test]
    fn a_copy_is_held_by_the_agents_holds_and_not_by_mutagens_pause() {
        let copying = Record {
            ran: true,
            ..made(Standing::Copying)
        };
        let low = serde_json::json!({ "heldBy": ["low-disk"], "mutagenStatus": "paused" });
        let held = copy_seen(&copying, &low).unwrap();
        assert_eq!(
            (held.standing, held.status.as_deref(), held.held_by),
            (
                Standing::Copying,
                Some(PAUSED),
                vec!["low-disk".to_string()]
            )
        );
        // The reader's own pause, found before the copy ever ran, is a folder synced before: it is in.
        let fresh = made(Standing::Copying);
        let paused = serde_json::json!({ "heldBy": ["owner"], "mutagenStatus": "paused" });
        assert_eq!(
            copy_seen(&fresh, &paused).unwrap().standing,
            Standing::Ready
        );
        // An agent older than holds: `paused` with a low disk is the drive's.
        let older = serde_json::json!({ "paused": true, "lowDisk": { "free": 1 } });
        assert_eq!(
            copy_seen(&copying, &older).unwrap().held_by,
            vec!["low-disk".to_string()]
        );
    }

    #[test]
    fn a_notification_is_put_up_once_for_each_thing_that_is_news() {
        assert_eq!(
            news(&Standing::Copying, &Standing::Ready, None).as_deref(),
            Some("ready")
        );
        // Ready found on a launch, not after a copy this run followed, is nobody's news.
        assert_eq!(news(&Standing::default(), &Standing::Ready, None), None);
        let failed = Standing::Failed { reason: "x".into() };
        assert_eq!(
            news(
                &Standing::Creating {
                    phase: None,
                    step: None,
                    percent: 1,
                    left: None
                },
                &failed,
                None
            )
            .as_deref(),
            Some("failed")
        );
        assert_eq!(
            news(
                &Standing::Creating {
                    phase: None,
                    step: None,
                    percent: 1,
                    left: None
                },
                &failed,
                Some("failed")
            ),
            None
        );
        assert_eq!(
            news(&failed, &Standing::Failed { reason: "y".into() }, None),
            None
        );
        assert!(moved_on(
            &failed,
            &Standing::Creating {
                phase: None,
                step: None,
                percent: 0,
                left: None
            }
        ));
    }

    #[test]
    fn a_launch_forgets_folders_that_are_in_and_keeps_the_rest() {
        let mut records = vec![
            made(Standing::Ready),
            record(Standing::Failed { reason: "x".into() }),
            record(Standing::Creating {
                phase: None,
                step: None,
                percent: 3,
                left: None,
            }),
        ];
        settle_on_launch(&mut records);
        assert_eq!(
            records
                .iter()
                .map(|record| record.standing.kind())
                .collect::<Vec<_>>(),
            vec!["failed", "creating"]
        );
    }

    /* WHERE A SETUP'S TIME GOES, DOWN TO THE AGENT'S OWN STEPS (2026-10-22). */
    #[test]
    fn the_agents_own_steps_are_timed_inside_the_plans_and_the_stretch_before_them_too() {
        let start = Instant::now();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        let named = |moved: Vec<Moved>| {
            moved
                .into_iter()
                .map(|(parent, step, took)| (parent, step, took.as_secs()))
                .collect::<Vec<_>>()
        };
        let mut clock = StepClock::default();
        assert!(clock
            .heard(Some("waiting-health"), Some("waiting-health"), at(0))
            .is_empty());
        // Into the sync step: what ran before it is the plan's own step.
        assert_eq!(
            named(clock.heard(Some("desktop-sync"), Some("desktop-sync"), at(4))),
            vec![(None, "waiting-health".to_string(), 4)]
        );
        // The shim and the agent's self-update, until the agent's first step of its own.
        assert_eq!(
            named(clock.heard(Some("desktop-sync"), Some("sync-enrolling"), at(34))),
            vec![(
                Some("desktop-sync".to_string()),
                "sync-preparing".to_string(),
                30
            )]
        );
        // A line naming nothing, or another agent's step, moves nothing.
        assert!(clock.heard(Some("desktop-sync"), None, at(35)).is_empty());
        assert!(clock
            .heard(Some("desktop-sync"), Some("device-starting"), at(35))
            .is_empty());
        assert_eq!(
            named(clock.heard(Some("desktop-sync"), Some("sync-linking"), at(36))),
            vec![(
                Some("desktop-sync".to_string()),
                "sync-enrolling".to_string(),
                2
            )]
        );
        // Off the sync step: the agent's last step, then the plan's step that held it.
        assert_eq!(
            named(clock.heard(Some("verifying"), Some("verifying"), at(40))),
            vec![
                (
                    Some("desktop-sync".to_string()),
                    "sync-linking".to_string(),
                    4
                ),
                (None, "desktop-sync".to_string(), 36),
            ]
        );
        clock.heard(
            Some("connecting-machine"),
            Some("connecting-machine"),
            at(41),
        );
        assert_eq!(
            named(clock.out(at(44))),
            vec![
                (
                    Some("connecting-machine".to_string()),
                    "device-preparing".to_string(),
                    3
                ),
                (None, "connecting-machine".to_string(), 3),
            ]
        );
    }

    /* THE FOLDER IS IN BEFORE THIS COMPUTER IS A DEVICE (2026-10-22). */
    #[test]
    fn a_folder_counts_as_made_by_this_run_only_when_made_since_it_started() {
        let record = |made: bool, made_at: Option<u64>, started_at: Option<u64>| Record {
            made,
            made_at,
            started_at,
            ..Record::default()
        };
        assert!(made_this_run(&record(true, Some(2_000), Some(1_000))));
        // Made by an earlier attempt, and being set up again: this run has not made it.
        assert!(!made_this_run(&record(true, Some(500), Some(1_000))));
        assert!(!made_this_run(&record(false, None, Some(1_000))));
        assert!(!made_this_run(&record(true, Some(2_000), None)));
    }

    /* READY MEANS OPEN SHOWS A DRAWN PAGE (2026-10-22). */
    #[test]
    fn a_folder_whose_copy_is_in_waits_for_its_page_only_while_it_comes_up() {
        use crate::windows::{Warmth, WARM_FOR};
        let made = 1_000_000;
        let within = made + WARM_FOR.as_millis() as u64 - 1;
        // Put up for its sandbox and not yet drawn: the folder waits.
        assert!(waits_for_page(Warmth::Warming, Some(made), within));
        // Drawn, or never put up (a workspace the reader is looking at): ready at once, as before.
        assert!(!waits_for_page(Warmth::Shown, Some(made), within));
        assert!(!waits_for_page(Warmth::Cold, Some(made), within));
        // A page that never says (one older than this app): ready once the wait is out, never held for good.
        assert!(!waits_for_page(
            Warmth::Warming,
            Some(made),
            made + WARM_FOR.as_millis() as u64
        ));
    }

    #[test]
    fn the_supervisor_rests_by_what_it_waits_for() {
        assert_eq!(pause_for(&[]), Duration::from_secs(120));
        assert_eq!(
            pause_for(&[made(Standing::Copying)]),
            Duration::from_secs(3)
        );
        assert_eq!(
            pause_for(&[record(Standing::default())]),
            Duration::from_secs(5)
        );
        assert_eq!(
            pause_for(&[record(Standing::NeedsDocker {
                reason: DockerReason::NotRunning
            })]),
            Duration::from_secs(15)
        );
        assert_eq!(
            pause_for(&[record(Standing::Failed { reason: "x".into() })]),
            Duration::from_secs(120)
        );
        // Back from the browser: looked at again within moments.
        assert_eq!(
            pause_for(&[record(Standing::SignedIn)]),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn only_a_folder_on_its_way_to_being_made_waits_on_the_account() {
        for standing in [
            Standing::SignedOut,
            Standing::SignedIn,
            Standing::default(),
            Standing::Interrupted,
        ] {
            assert!(waits_on_account(&record(standing.clone())), "{standing:?}");
        }
        for standing in [
            Standing::Copying,
            Standing::Ready,
            Standing::Failed { reason: "x".into() },
            Standing::NeedsDocker {
                reason: DockerReason::NotRunning,
            },
        ] {
            assert!(!waits_on_account(&record(standing.clone())), "{standing:?}");
        }
    }

    #[test]
    fn a_folders_sandbox_is_called_after_the_folder() {
        assert_eq!(sandbox_name_for("Shop", "shop"), "Shop");
        assert_eq!(sandbox_name_for("  ", "shop"), "shop");
        let long = "x".repeat(80);
        assert_eq!(sandbox_name_for(&long, "x").chars().count(), 60);
        // A key is short, stable and the same for the same folder.
        assert_eq!(key_of("/a"), key_of("/a"));
        assert_ne!(key_of("/a"), key_of("/b"));
        assert_eq!(key_of("/a").len(), 12);
        assert!(run_id("/a").starts_with(RUN_PREFIX));
    }

    #[test]
    fn a_folder_on_its_way_is_one_not_yet_in_nor_turned_down() {
        assert!(Standing::default().on_its_way());
        assert!(Standing::Copying.on_its_way());
        assert!(!Standing::Ready.on_its_way());
        assert!(!Standing::Failed { reason: "x".into() }.on_its_way());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_process_has_a_start_and_a_pid_nobody_holds_has_none() {
        assert!(process_started(std::process::id()).is_some());
        assert_eq!(process_started(u32::MAX - 1), None);
    }

    #[test]
    fn a_lock_is_held_only_by_the_very_process_that_took_it() {
        let lock = RunLock {
            pid: 7,
            started: Some("123".into()),
            at: 100,
            out: None,
            err: None,
        };
        assert_eq!(holder(None, None, 0), Holder::Free);
        assert_eq!(holder(Some(&lock), Some("123"), 200), Holder::Live);
        assert_eq!(holder(Some(&lock), Some("999"), 200), Holder::Stale);
        assert_eq!(holder(Some(&lock), None, 200), Holder::Stale);
        let unknown = RunLock {
            started: None,
            ..lock
        };
        assert_eq!(holder(Some(&unknown), Some("1"), 200), Holder::Live);
        assert_eq!(
            holder(Some(&unknown), Some("1"), 100 + LOCK_TRUST.as_secs()),
            Holder::Stale
        );
    }
}
