use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::docker;
use crate::logfile::Log;

/* WHAT THE SANDBOX SEES OF A DOWNLOAD WHILE IT RUNS. `staged.rs` tells it about a prepare once it is over; until then
the update card could only offer a button for a download that was already happening behind it. So while `ic sandbox
prepare` works, it keeps this marker on /history: the step it is on and how far the pull has got, rewritten every few
seconds, and gone the moment the prepare ends, whichever way it ends. A killed ic cannot remove it, so the daemon
passes it on only while its heartbeat is fresh (PREPARING_FRESH_MS), and a stuck bar is never what a crash leaves. */

/// Where the daemon looks, beside the staged marker (the daemon's `updatePreparingDocument`).
pub const MARKER: &str = "/history/update-preparing.json";
/// How often the marker is rewritten when nothing has moved: the heartbeat the daemon's freshness window is sized to.
const HEARTBEAT: Duration = Duration::from_secs(4);
/// The soonest a moved percent is written after the last write, so a pull's burst of layer lines is one exec, not forty.
const SOONEST: Duration = Duration::from_millis(900);
/// How often the writer wakes to look: short, so the end of a prepare never waits a whole heartbeat to be heard.
const TICK: Duration = Duration::from_millis(200);

/// The step a prepare is on, in the words the contract's `phase` carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Pulling the new image.
    Download,
    /// Building this sandbox's approved environment on it.
    Build,
    /// Checking this sandbox's stored files against it (the state pre-flight).
    Check,
}

impl Phase {
    fn word(self) -> &'static str {
        match self {
            Phase::Download => "download",
            Phase::Build => "build",
            Phase::Check => "check",
        }
    }
}

/// What the writer draws from, shared with the output pumps that feed it docker's layer lines.
#[derive(Default)]
struct Progress {
    /// None until something real happens: a pull that finds the image current prints no layer, and a check that
    /// found nothing to download must not flash "Downloading" on a card for the second it took.
    phase: Option<Phase>,
    layers: BTreeMap<String, f32>,
    percent: u32,
    /// Something moved since the last write.
    moved: bool,
}

impl Progress {
    /// One line of docker's pull output. Only a download moves the percent; a layer line from a pull the build does
    /// on its own base is the build's business, and never walks the phase back to Download.
    fn observe(&mut self, line: &str) {
        let Some((layer, done)) = crate::ui::parse_layer(line) else {
            return;
        };
        if self.phase.is_some_and(|phase| phase != Phase::Download) {
            return;
        }
        self.phase = Some(Phase::Download);
        self.layers.insert(layer, done);
        self.percent = crate::ui::pull_percent(&self.layers, self.percent);
        self.moved = true;
    }

    fn enter(&mut self, phase: Phase) {
        if self.phase != Some(phase) {
            self.phase = Some(phase);
            self.moved = true;
        }
    }
}

/// The prepare this process is announcing, for the output pumps to feed. One at a time, as one ic runs one prepare.
static WATCHED: Mutex<Option<Arc<Mutex<Progress>>>> = Mutex::new(None);

/// Feed one line of a docker command's output to the prepare being announced, if there is one. Called from every
/// pull's output pump, on a terminal or not: the machine agent's background prepare has no terminal, and that is the
/// download a card most needs to see.
pub fn observe(line: &str) {
    let Some(progress) = WATCHED
        .lock()
        .ok()
        .and_then(|watched| watched.as_ref().map(Arc::clone))
    else {
        return;
    };
    if let Ok(mut progress) = progress.lock() {
        progress.observe(line);
    };
}

/// A prepare being announced. Dropping it ends the announcement: the writer stops, and the marker, if one was ever
/// written, is removed. That is every way a prepare ends in this process, the `?` in the middle of a failed pull
/// included.
pub struct Announcing {
    container: String,
    progress: Arc<Mutex<Progress>>,
    stop: Arc<AtomicBool>,
    wrote: Arc<AtomicBool>,
    writer: Option<JoinHandle<()>>,
}

/// Start announcing a prepare of `container`'s next update from `channel`. Writes nothing until the prepare does
/// something worth drawing (a layer, a build, a check).
pub fn start(container: &str, channel: &str, log: &Log) -> Announcing {
    let progress = Arc::new(Mutex::new(Progress::default()));
    if let Ok(mut watched) = WATCHED.lock() {
        *watched = Some(Arc::clone(&progress));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let wrote = Arc::new(AtomicBool::new(false));
    let writer = {
        let (container, channel, log) = (container.to_string(), channel.to_string(), log.clone());
        let (progress, stop, wrote) =
            (Arc::clone(&progress), Arc::clone(&stop), Arc::clone(&wrote));
        std::thread::spawn(move || {
            write_while(&container, &channel, &progress, &stop, &wrote, &log)
        })
    };
    Announcing {
        container: container.to_string(),
        progress,
        stop,
        wrote,
        writer: Some(writer),
    }
}

impl Announcing {
    /// The prepare moved on to `phase`; the next write says so.
    pub fn enter(&self, phase: Phase) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.enter(phase);
        }
    }
}

impl Drop for Announcing {
    fn drop(&mut self) {
        if let Ok(mut watched) = WATCHED.lock() {
            *watched = None;
        }
        self.stop.store(true, Ordering::SeqCst);
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        // Silent and best-effort, like the staged marker's withdrawal: a container mid-swap has nothing to be told,
        // and a marker left behind goes stale on its own.
        if self.wrote.load(Ordering::SeqCst) {
            docker::quiet(&["exec", &self.container, "rm", "-f", MARKER]);
        }
    }
}

/// The writer: every tick, writes when something moved and the last write is far enough back, or when the heartbeat
/// is due. Nothing at all until the prepare has a phase.
fn write_while(
    container: &str,
    channel: &str,
    progress: &Mutex<Progress>,
    stop: &AtomicBool,
    wrote: &AtomicBool,
    log: &Log,
) {
    let started_at = now_ms();
    let mut last: Option<Instant> = None;
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(TICK);
        let due = last.map_or(Duration::MAX, |at| at.elapsed());
        let json = {
            let Ok(mut progress) = progress.lock() else {
                return;
            };
            let Some(phase) = progress.phase else {
                continue;
            };
            if !(progress.moved && due >= SOONEST) && due < HEARTBEAT {
                continue;
            }
            progress.moved = false;
            let percent = (phase == Phase::Download).then_some(progress.percent);
            marker(channel, started_at, now_ms(), phase, percent)
        };
        // A container too old to hold the file, or stopped under us, just means nothing is drawn; the prepare itself
        // is what matters and carries on.
        let script = format!("cat > {MARKER}.tmp && mv {MARKER}.tmp {MARKER}");
        if docker::capture_with_stdin(
            &["exec", "-i", container, "sh", "-c", &script],
            json.as_bytes(),
            log,
        )
        .is_ok()
        {
            wrote.store(true, Ordering::SeqCst);
        }
        last = Some(Instant::now());
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0)
}

/// The marker's JSON, in the contract's shape (PreparingUpdateSchema). Pure, so its shape is asserted without a
/// container.
pub fn marker(
    channel: &str,
    started_at: u128,
    at: u128,
    phase: Phase,
    percent: Option<u32>,
) -> String {
    let mut fields = serde_json::Map::new();
    fields.insert("channel".into(), serde_json::Value::from(channel));
    // u128 is not a JSON number serde_json takes; milliseconds since 1970 fit a u64 for the next half-billion years.
    fields.insert(
        "startedAt".into(),
        serde_json::Value::from(u64::try_from(started_at).unwrap_or(u64::MAX)),
    );
    fields.insert(
        "at".into(),
        serde_json::Value::from(u64::try_from(at).unwrap_or(u64::MAX)),
    );
    fields.insert("phase".into(), serde_json::Value::from(phase.word()));
    if let Some(percent) = percent {
        fields.insert("percent".into(), serde_json::Value::from(percent.min(100)));
    }
    serde_json::Value::Object(fields).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_carries_the_contracts_fields_and_a_percent_only_while_downloading() {
        let value: serde_json::Value =
            serde_json::from_str(&marker("stable", 1_000, 5_000, Phase::Download, Some(42)))
                .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "channel": "stable", "startedAt": 1000, "at": 5000, "phase": "download", "percent": 42 })
        );
        let building: serde_json::Value =
            serde_json::from_str(&marker("beta", 1_000, 9_000, Phase::Build, None)).unwrap();
        assert_eq!(
            building,
            serde_json::json!({ "channel": "beta", "startedAt": 1000, "at": 9000, "phase": "build" })
        );
        assert_eq!(Phase::Check.word(), "check");
    }

    #[test]
    fn a_channel_with_a_quote_in_it_is_escaped_rather_than_breaking_the_file() {
        let value: serde_json::Value =
            serde_json::from_str(&marker("a\"b", 1, 2, Phase::Check, None)).unwrap();
        assert_eq!(value["channel"], "a\"b");
    }

    #[test]
    fn nothing_is_drawn_until_a_layer_moves_and_the_percent_follows_the_layers() {
        let mut progress = Progress::default();
        progress.observe("Status: Image is up to date for ghcr.io/intentic/sandbox:stable");
        progress.observe("stable: Pulling from intentic/sandbox");
        assert_eq!(
            progress.phase, None,
            "a pull that found the image current is no download"
        );
        progress.observe("6e3729cf69e0: Pulling fs layer");
        progress.observe("a1b2c3d4e5f6: Pull complete");
        assert_eq!(progress.phase, Some(Phase::Download));
        assert_eq!(progress.percent, 50);
        assert!(progress.moved);
    }

    #[test]
    fn a_later_step_is_never_walked_back_to_download_by_a_pull_inside_it() {
        let mut progress = Progress::default();
        progress.observe("6e3729cf69e0: Downloading [==>   ] 12MB/45MB");
        progress.enter(Phase::Build);
        progress.moved = false;
        progress.observe("a1b2c3d4e5f6: Pulling fs layer");
        assert_eq!(progress.phase, Some(Phase::Build));
        assert!(!progress.moved);
        // Entering the step it is already on is not a move either.
        progress.enter(Phase::Build);
        assert!(!progress.moved);
    }
}
