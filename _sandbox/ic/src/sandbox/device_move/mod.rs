use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::docker::{self, Target};
use crate::engine::moves;
use crate::logfile::intentic_home;
use crate::sandbox::now_ms;
use crate::util::{bail, Fail, Result};

#[cfg(all(test, unix))]
mod channel_tests;
mod into;
mod out;
pub mod stream;
pub mod wire;

pub use into::{run as move_in, InArgs};
pub use out::{run as move_out, OutArgs};

/* MOVING ONE SANDBOX TO ANOTHER OF THE OWNER'S COMPUTERS (2026-11-11). The owner moved "translations" from rog (Windows,
run by ic) to z440 (Linux, Compose under Komodo) by hand: SSH, a tar of each Docker volume, the at-rest key copied
across, a Compose file written from memory, both copies stopped by hand. This is that, as two ic runs the machine agents
start for the calling sandbox's daemon (`sandboxes move`), and nothing else touches the bytes:

  source  `ic sandbox move-out <slug> --plan-only`      what would move, how big (read-only, for the owner's card)
  target  `ic sandbox move-in <slug> --plan -`          checks, pulls and builds while the source still runs, then
                                                        listens and prints its public key; receives; creates; starts
  target  `ic sandbox move-in <slug> --peer <key>`      the source's public key, handed to the waiting run (a file)
  source  `ic sandbox move-out <slug> --peer <key> …`   dials (or listens for the relay), stops the sandbox held, sends
                                                        one stream, waits for the target's verdict, parks its copy

The stream (wire.rs) is one encrypted channel: the manifest (the container's whole inspect, env included, the channel
record), the at-rest and backup keys, and each volume as a tar checked file by file on arrival (engine/moves.rs's
manifest), the image itself only when the target could not make it from a registry or its recipe. The target makes the
sandbox through the run contract stamped as ITS OWN (this machine's side, label and engine), or as a Compose folder
(compose_out.rs), writes the takeover marker (takeover.rs) so the platform makes it the active host, starts it and waits
for its tunnel. Only then does the source rename its copy `<container>.moved`, kept for engine/moves.rs's KEEP_DAYS and
removed by the same cleanup an engine move's copies are.

Failure anywhere before the target's verdict undoes both halves, each on its own: the target removes what it made, the
source starts its sandbox again. Each run is detached from the agent that started it and journals itself here with a
heartbeat; a run that died (a reboot mid-copy) is undone by the next `ic sandbox move-*` or `ic sandbox tidy` once its
heartbeat is stale. The one state that is never undone blindly is a source that sent everything and never heard back:
the target may be up, so it stays stopped and says so (`ic sandbox start` brings it back). */

/// The plan's and the manifest's format.
pub const VERSION: u32 = 1;
/// How long a run without a heartbeat is taken for dead.
const STALE_MS: u64 = 10 * 60 * 1000;
/// How often a running move says it is alive.
const BEAT: Duration = Duration::from_secs(30);

/// What would move, read off the source before anything stops: the owner's card shows its size, and the target prepares
/// from it while the sandbox still runs. Carries no secret: the env and the keys travel only inside the stream.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub v: u32,
    pub slug: String,
    /// The image the container runs (SANDBOX_IMAGE).
    pub image: String,
    /// The base it was built on (SANDBOX_BASE_IMAGE), the image itself for a stock sandbox.
    pub base_image: String,
    /// `repo@sha256:…` the base was pulled as, when a registry holds it.
    #[serde(default)]
    pub base_digest: Option<String>,
    /// The same for the image, when it is a registry's own (a stock sandbox).
    #[serde(default)]
    pub image_digest: Option<String>,
    /// The overlay recipe that builds `image` on `base_image`, when one was found whose hash the image's tag names.
    #[serde(default)]
    pub recipe: Option<String>,
    /// The image goes inside the stream: neither a registry nor a recipe can make it on the other computer. Read off
    /// the plan by the target; the stream itself carries the image when the target's go-ahead asks for it.
    #[serde(default)]
    pub carry_image: bool,
    pub volumes: Vec<PlanVolume>,
    /// Everything the stream will carry, in bytes (volumes, and the image when carried).
    pub bytes: u64,
    pub running: bool,
    /// The id of the at-rest key the container mounts (at_rest.rs `key_id_of`), so the target refuses before anything
    /// stops when it already holds a different key for this sandbox.
    #[serde(default)]
    pub key_id: Option<String>,
    #[serde(default)]
    pub backup_key: bool,
    /// Its reach probe said `reachable` when planned: the target then waits for its tunnel before calling it up.
    #[serde(default)]
    pub reachable: bool,
    pub ic_version: String,
    /// The source's label, for the target's words and the journal.
    pub from: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanVolume {
    pub name: String,
    pub destination: String,
    /// Holds a Docker engine's own data: copied by a privileged helper (engine/moves.rs DOCKER_DATA).
    pub docker_data: bool,
    pub bytes: u64,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

/// The first record of the stream: the plan as it stands now that the sandbox is stopped, and what only the stream may
/// carry.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub v: u32,
    pub move_id: String,
    pub plan: Plan,
    /// The sandbox container's whole `docker inspect`, its env (CONNECT_TOKEN, SANDBOX_GRANT) included.
    pub inspect: Value,
    /// The channel record's text (record.rs `serialize`).
    #[serde(default)]
    pub record: Option<String>,
}

/// Whether the plan the target prepared from still describes what arrived. Pure.
pub fn same_sandbox(planned: &Plan, arrived: &Plan) -> Option<String> {
    if planned.slug != arrived.slug {
        return Some(format!(
            "the stream carries {}, not {}.",
            arrived.slug, planned.slug
        ));
    }
    if planned.image != arrived.image {
        return Some(format!(
            "{} changed its image since the move was planned ({} → {}).",
            planned.slug, planned.image, arrived.image
        ));
    }
    let names = |plan: &Plan| {
        plan.volumes
            .iter()
            .map(|v| v.name.clone())
            .collect::<Vec<_>>()
    };
    if names(planned) != names(arrived) {
        return Some(format!(
            "{}'s volumes changed since the move was planned.",
            planned.slug
        ));
    }
    if planned.key_id != arrived.key_id {
        return Some(format!(
            "{}'s at-rest key changed since the move was planned.",
            planned.slug
        ));
    }
    None
}

/// A move id: what names the peer file, so nothing but letters, digits and dashes. Pure.
pub fn valid_move_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn check_move_id(id: &str) -> Result<()> {
    if !valid_move_id(id) {
        bail!("'{id}' is not a move id (letters, digits and dashes, at most 64).");
    }
    Ok(())
}

/// One `intentic-move:` progress line, the flow line the daemon relays (engine/moves.rs's format).
pub fn say(slug: &str, step: &str, detail: Value) {
    moves::say(slug, step, detail);
}

/// The docker this ic runs against, as an explicit target: the stream's helpers run there.
pub fn here_target() -> Target {
    if docker::intentic_engine_in_use() {
        if let Some(env) = crate::engine::reach() {
            return Target::Intentic(env);
        }
    }
    Target::DockerDesktop
}

/* ——— The journal of moves in flight on this machine. ——— */

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub move_id: String,
    pub slug: String,
    /// `source` or `target`.
    pub role: String,
    pub started: u64,
    pub heartbeat: u64,
    /// Source: the sandbox ran when the move began, and this move stopped it.
    #[serde(default)]
    pub was_running: bool,
    #[serde(default)]
    pub stopped: bool,
    /// Source: everything was sent and the verdict never came; never undone blindly.
    #[serde(default)]
    pub awaiting_verdict: bool,
    /// Target: what this move made, removed by its undo.
    #[serde(default)]
    pub volumes: Vec<String>,
    #[serde(default)]
    pub containers: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Journal {
    #[serde(default)]
    pub attempts: Vec<Attempt>,
}

static JOURNAL: Mutex<()> = Mutex::new(());

fn journal_path() -> PathBuf {
    intentic_home().join("device-moves.json")
}

pub fn load() -> Journal {
    std::fs::read_to_string(journal_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(journal: &Journal) -> Result<()> {
    let path = journal_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let staged = path.with_extension("json.new");
    std::fs::write(&staged, serde_json::to_string_pretty(journal)?)?;
    std::fs::rename(&staged, &path)?;
    Ok(())
}

/// Change this move's entry (made when missing) under the in-process lock.
pub fn update(move_id: &str, change: impl FnOnce(&mut Attempt)) -> Result<()> {
    let _guard = JOURNAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut journal = load();
    let at = match journal.attempts.iter().position(|a| a.move_id == move_id) {
        Some(at) => at,
        None => {
            journal.attempts.push(Attempt {
                move_id: move_id.to_string(),
                started: now_ms(),
                heartbeat: now_ms(),
                ..Attempt::default()
            });
            journal.attempts.len() - 1
        }
    };
    change(&mut journal.attempts[at]);
    save(&journal)
}

pub fn finish(move_id: &str) {
    let _guard = JOURNAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut journal = load();
    journal.attempts.retain(|a| a.move_id != move_id);
    let _ = save(&journal);
}

/// Beat this move's heartbeat every half minute until the returned guard is dropped.
pub struct Beating(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for Beating {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

pub fn beat(move_id: &str) -> Beating {
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let seen = std::sync::Arc::clone(&stop);
    let id = move_id.to_string();
    std::thread::spawn(move || {
        let step = Duration::from_millis(500);
        let mut waited = Duration::ZERO;
        while !seen.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(step);
            waited += step;
            if waited >= BEAT {
                waited = Duration::ZERO;
                let _ = update(&id, |attempt| attempt.heartbeat = now_ms());
            }
        }
    });
    Beating(stop)
}

/// What to do about an attempt whose run is gone. Pure.
#[derive(Debug, PartialEq, Eq)]
pub enum Leftover {
    /// Still beating: somebody's run is alive.
    Alive,
    /// A source that stopped its sandbox and never finished sending: start it again.
    Restart,
    /// A source that sent everything and never heard back: leave it stopped, and say so.
    Ambiguous,
    /// A target's partial copy: remove what it made.
    Remove,
    /// Nothing was changed by it.
    Forget,
}

pub fn leftover(attempt: &Attempt, now: u64) -> Leftover {
    if now.saturating_sub(attempt.heartbeat) < STALE_MS {
        return Leftover::Alive;
    }
    match attempt.role.as_str() {
        "source" if attempt.awaiting_verdict => Leftover::Ambiguous,
        "source" if attempt.stopped && attempt.was_running => Leftover::Restart,
        "target"
            if !attempt.volumes.is_empty()
                || !attempt.containers.is_empty()
                || !attempt.files.is_empty() =>
        {
            Leftover::Remove
        }
        _ => Leftover::Forget,
    }
}

/// Undo what a target attempt made on this machine. Best effort, each step on its own.
pub fn remove_made(attempt: &Attempt, on: &Target) {
    for container in attempt.containers.iter().rev() {
        let _ = docker::capture_on(on, &["rm", "-f", container], docker::READ_LIMIT);
    }
    for volume in &attempt.volumes {
        let _ = docker::capture_on(on, &["volume", "rm", "-f", volume], docker::READ_LIMIT);
    }
    for file in &attempt.files {
        let path = PathBuf::from(file);
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Settle the moves on this machine whose runs died: what `ic sandbox tidy` and every `move-*` start run.
pub fn recover() {
    let now = now_ms();
    for attempt in load().attempts {
        match leftover(&attempt, now) {
            Leftover::Alive => continue,
            Leftover::Restart => {
                crate::ui::note(&format!(
                    "a move of {} to another computer stopped halfway; starting it here again.",
                    attempt.slug
                ));
                if let Err(Fail(reason)) = crate::sandbox::power::run(
                    crate::sandbox::power::Power::Start,
                    Some(attempt.slug.clone()),
                ) {
                    crate::ui::warn(&format!("could not start {} again: {reason}", attempt.slug));
                    continue;
                }
            }
            Leftover::Ambiguous => {
                crate::ui::warn(&format!(
                    "a move of {slug} sent everything to the other computer and never heard whether it came up there. \
                     {slug} stays stopped here so two copies never run: look on the other computer, and if it is not there, \
                     `ic sandbox start {slug}` brings it back here.",
                    slug = attempt.slug
                ));
            }
            Leftover::Remove => remove_made(&attempt, &here_target()),
            Leftover::Forget => {}
        }
        finish(&attempt.move_id);
    }
}

/// Where the source's public key waits for the target's run (`move-in --peer`).
pub fn peer_path(move_id: &str) -> PathBuf {
    intentic_home()
        .join("moves")
        .join(format!("{move_id}.peer"))
}

/// `ic sandbox move-in <slug> --move <id> --peer <key>`: hand the waiting run the source's key.
pub fn hand_peer(slug: &str, move_id: &str, peer: &str) -> Result<()> {
    check_move_id(move_id)?;
    if wire::decode_key(peer).is_none() {
        bail!("that is not a move key.");
    }
    let waiting = load()
        .attempts
        .iter()
        .any(|a| a.move_id == move_id && a.slug == slug && a.role == "target");
    if !waiting {
        bail!("no move {move_id} of {slug} is waiting on this computer.");
    }
    let path = peer_path(move_id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o600));
    }
    let mut file = builder.tempfile_in(path.parent().expect("peer path has a folder"))?;
    std::io::Write::write_all(&mut file, peer.trim().as_bytes())?;
    file.persist(&path)
        .map_err(|err| Fail(format!("could not write {}: {}", path.display(), err.error)))?;
    say(slug, "peer", json!({}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Plan {
        Plan {
            v: VERSION,
            slug: "sandbox-1".into(),
            image: "img".into(),
            base_image: "img".into(),
            base_digest: None,
            image_digest: None,
            recipe: None,
            carry_image: false,
            volumes: vec![PlanVolume {
                name: "intentic-work-sandbox-1".into(),
                destination: "/work".into(),
                docker_data: false,
                bytes: 10,
                labels: BTreeMap::new(),
            }],
            bytes: 10,
            running: true,
            key_id: Some("abc".into()),
            backup_key: false,
            reachable: true,
            ic_version: "1".into(),
            from: "rog".into(),
        }
    }

    #[test]
    fn a_plan_round_trips_and_reads_camel_case() {
        let text = serde_json::to_string(&plan()).unwrap();
        assert!(text.contains("\"baseImage\":\"img\"") && text.contains("\"dockerData\":false"));
        assert_eq!(serde_json::from_str::<Plan>(&text).unwrap(), plan());
    }

    #[test]
    fn what_arrived_must_be_what_was_planned() {
        assert_eq!(same_sandbox(&plan(), &plan()), None);
        let mut other = plan();
        other.image = "img2".into();
        assert!(same_sandbox(&plan(), &other)
            .unwrap()
            .contains("changed its image"));
        let mut other = plan();
        other.volumes.clear();
        assert!(same_sandbox(&plan(), &other).unwrap().contains("volumes"));
        let mut other = plan();
        other.key_id = Some("def".into());
        assert!(same_sandbox(&plan(), &other)
            .unwrap()
            .contains("at-rest key"));
        let mut other = plan();
        other.volumes[0].bytes = 99;
        assert_eq!(same_sandbox(&plan(), &other), None);
    }

    #[test]
    fn move_ids_name_files_safely() {
        assert!(valid_move_id("a1b2-c3"));
        assert!(!valid_move_id(""));
        assert!(!valid_move_id("../x"));
        assert!(!valid_move_id(&"a".repeat(65)));
    }

    #[test]
    fn a_dead_run_is_settled_by_what_it_had_done() {
        let now = 100 * STALE_MS;
        let stale = Attempt {
            heartbeat: now - STALE_MS,
            ..Attempt::default()
        };
        let fresh = Attempt {
            heartbeat: now - 1,
            role: "source".into(),
            stopped: true,
            was_running: true,
            ..Attempt::default()
        };
        assert_eq!(leftover(&fresh, now), Leftover::Alive);
        let source = |stopped, was_running, awaiting_verdict| Attempt {
            role: "source".into(),
            stopped,
            was_running,
            awaiting_verdict,
            ..stale.clone()
        };
        assert_eq!(leftover(&source(true, true, false), now), Leftover::Restart);
        assert_eq!(leftover(&source(true, false, false), now), Leftover::Forget);
        assert_eq!(leftover(&source(false, true, false), now), Leftover::Forget);
        assert_eq!(
            leftover(&source(true, true, true), now),
            Leftover::Ambiguous
        );
        let target = Attempt {
            role: "target".into(),
            volumes: vec!["v".into()],
            ..stale.clone()
        };
        assert_eq!(leftover(&target, now), Leftover::Remove);
        let empty_target = Attempt {
            role: "target".into(),
            ..stale
        };
        assert_eq!(leftover(&empty_target, now), Leftover::Forget);
    }
}
