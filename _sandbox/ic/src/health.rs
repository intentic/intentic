use std::time::{Duration, Instant};

use crate::docker;
use crate::logfile::Log;
use crate::util::{bail, Result};

/* The two waits after a launch, in order — because a daemon that ANSWERS is not yet a daemon that SERVES. */

const HEALTH_URL: &str = "http://localhost:8787/health";

/// netd's own answer about the daemon it runs (browser-wire's `SandboxVitals`), given whatever state Node is in: netd
/// answers it before it would wait for Node.
const VITALS_URL: &str = "http://localhost:8787/system/vitals";

/// Restarts of a crashed daemon, by netd inside a container that stays up, that make a crash loop: the editor's own
/// threshold (diagnose.ts CRASH_LOOP_RESTARTS). Docker's restart count never sees them, since netd is PID 1.
pub const CRASH_LOOP_RESTARTS: u32 = 3;

/// The line netd logs each time it restarts a daemon that crashed (_sandbox/netd/crates/netd/src/supervise.rs, held to
/// it by a test below).
const NETD_RESTARTING: &str = "the daemon crashed; restarting it";

/// How long the first answer may take. A clock rather than a count of reads, since a read's length depends on who
/// answers it: netd holds one for half a minute while its daemon is down. About what fifteen such reads came to, so a
/// first boot that converts state before it serves keeps the time it had; a daemon that keeps crashing is found long
/// before, by netd's count of restarts.
const ANSWER_BUDGET: Duration = Duration::from_secs(8 * 60);

/// Reads of `/health` that may fail before the wait gives up: what a daemon with no netd in front of it (an image from
/// before netd, refusing the connection while it starts) has always been given.
const ANSWER_READS: u32 = 15;

/// How long one read of `/health` in the waits below may take, in curl's `-m` seconds: a daemon that took the
/// connection and never answers fails the read instead of holding the update forever. Past the half minute netd
/// holds a request while its daemon is not up, so a read still rides that hold to its answer, and a wait's reach stays
/// what it was.
const WAIT_READ_SECS: &str = "35";

/// How long the readiness wait holds. A clock rather than a count of reads: while its daemon restarts, the
/// netd holds a request for up to half a minute before answering 503, so a count could stretch into an hour.
const READY_BUDGET: Duration = Duration::from_secs(120);

/// How long an open state journal may take to commit before the swap is undone. Longer than the plain wait,
/// since the journal only opens on an update that converts files, and a slow first boot after one is still a
/// healthy boot; rolling it back would undo work that was about to succeed.
const JOURNAL_BUDGET: Duration = Duration::from_secs(600);

/// What netd says of the daemon it runs: whether Node is `up`, `starting` or `restarting`, and how many times netd
/// restarted it in the last ten minutes.
#[derive(Debug, PartialEq)]
pub struct NodeVitals {
    pub node: String,
    pub restarts: u32,
}

/// The vitals of `container`'s daemon. None from a container with no netd to ask (an image from before it) or one not
/// answering at all yet.
pub fn vitals(container: &str) -> Option<NodeVitals> {
    let body = docker::exec_capture(container, &["curl", "-sf", "-m", "5", VITALS_URL])?;
    read_vitals(&body)
}

/// The vitals document → what the waits read of it. Pure. Anything without both fields is no answer.
fn read_vitals(body: &str) -> Option<NodeVitals> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    Some(NodeVitals {
        node: parsed.get("node")?.as_str()?.to_string(),
        restarts: u32::try_from(parsed.get("restarts")?.as_u64()?).unwrap_or(u32::MAX),
    })
}

/// Why `vitals` read as a daemon that keeps crashing, or None. Pure. Only a Node that is down now counts: one netd had
/// to restart three times and that then came up has recovered, and the waits go on reading it.
pub fn crash_loop(vitals: &NodeVitals) -> Option<String> {
    (vitals.node != "up" && vitals.restarts >= CRASH_LOOP_RESTARTS).then(|| {
        format!(
            "netd restarted it {} times in the last ten minutes, and it is down again",
            vitals.restarts
        )
    })
}

/// A crash loop read off the container's own log, for a daemon that dies before it ever reaches netd: netd binds no
/// port until its daemon names them, so such a container has no vitals to ask, and netd's log line is the only count of
/// its restarts. The last ten minutes, as netd's own count is.
pub fn crash_loop_in_logs(container: &str) -> Option<String> {
    crashes_in(&docker::stderr_since(container, "10m")?)
}

/// The crash loop in a stretch of netd's log, with the error the daemon printed before its last restart. Pure.
fn crashes_in(log: &str) -> Option<String> {
    let lines: Vec<&str> = log.lines().map(str::trim).collect();
    let restarts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.contains(NETD_RESTARTING))
        .map(|(at, _)| at)
        .collect();
    if restarts.len() < CRASH_LOOP_RESTARTS as usize {
        return None;
    }
    let last = restarts[restarts.len() - 1];
    let from = restarts[restarts.len() - 2] + 1;
    let count = restarts.len();
    Some(
        match lines[from..last]
            .iter()
            .rfind(|line| line.contains("Error"))
        {
            Some(error) => format!(
                "netd restarted it {count} times in the last ten minutes, each time after {}",
                crate::sandbox::preflight::clip(error, 200)
            ),
            None => format!("netd restarted it {count} times in the last ten minutes"),
        },
    )
}

/// Why `container`'s daemon reads as one that keeps crashing, or None: netd's vitals where it answers them, its log
/// where it cannot (a daemon that never got far enough to have netd listen).
pub fn crashing(container: &str) -> Option<String> {
    match vitals(container) {
        Some(node) => crash_loop(&node),
        None => crash_loop_in_logs(container),
    }
}

/// Why a daemon gave no first answer.
#[derive(Debug, PartialEq)]
pub enum Silent {
    /// netd keeps restarting it (`crashing`), and why.
    Crashing(String),
    /// It recorded why it could not start (/history/boot-failure.json).
    Failed(String),
    /// Nothing answered within the wait, which ran this many seconds.
    Quiet(u64),
}

/// The first answer of `container`'s `/health`, or why none came.
///
/// Every pass first asks whether the daemon keeps crashing (`crashing`), which ends the wait at once with the error it
/// dies on. Without that, a daemon that dies before reaching netd was told apart from a slow one only by fifteen
/// refused reads, about half a minute, and said nothing of why; one that dies after it did was given about eight
/// minutes, since netd holds each read for half a minute before its 503. `/health` is read only once netd says Node is
/// up, the earliest it can answer anyway, or where no netd answers.
pub fn first_answer(container: &str) -> std::result::Result<String, Silent> {
    let started = crate::sandbox::now_ms();
    let clock = Instant::now();
    let mut failed_reads = 0;
    while failed_reads < ANSWER_READS && clock.elapsed() < ANSWER_BUDGET {
        let node = vitals(container);
        let looping = match &node {
            Some(node) => crash_loop(node),
            None => crash_loop_in_logs(container),
        };
        if let Some(looping) = looping {
            return Err(Silent::Crashing(looping));
        }
        if node.as_ref().is_none_or(|node| node.node == "up") {
            if let Some(answer) = docker::exec_capture(
                container,
                &["curl", "-sf", "-m", WAIT_READ_SECS, HEALTH_URL],
            ) {
                return Ok(answer);
            }
            failed_reads += 1;
        }
        // A daemon that recorded why it could not start has answered, just not over HTTP: no point waiting out the
        // rest of the budget on netd's "restarting" while it fails the same way again.
        if let Some(error) = crate::sandbox::probation::boot_failure_since(container, started) {
            return Err(Silent::Failed(error));
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err(Silent::Quiet(clock.elapsed().as_secs()))
}

/// Returns the first answer, which the readiness wait reads too (see [`wait_ready`]); the new version's failure in
/// its own words, with its logs saved, when there is none.
pub fn wait_answering(container: &str, log: &Log, remedy: &str) -> Result<String> {
    let silent = match first_answer(container) {
        Ok(answer) => return Ok(answer),
        Err(silent) => silent,
    };
    log.section(&format!("container logs ({container})"));
    docker::logs_into(container, "500", log);
    let saved = log.path.display();
    match silent {
        Silent::Crashing(looping) => bail!(
            "the new version's daemon keeps crashing: {looping}.\n       Its logs are saved to {saved}.{remedy}"
        ),
        Silent::Failed(error) => bail!(
            "the new version could not start: {error}\n       Its logs are saved to {saved}.{remedy}"
        ),
        Silent::Quiet(secs) => bail!(
            "the sandbox did not become healthy within {secs}s — its logs are saved to {saved}.{remedy}"
        ),
    }
}

/// The readiness gate: hold until `"ready":true`, echoing the running boot step's label as it changes — the
/// same chain the browser's warm-up screen shows. No hard failure: a slow boot is a slow boot, not a broken
/// sandbox, and the daemon is already reachable; past two minutes say so and hand the prompt back. A daemon
/// too old to report a boot answers neither field, which reads as "ready" — the old single-wait behaviour.
///
/// One answer makes it a hard gate: a state journal reported open (see [`Readiness`]). A journal still open
/// when the budget runs out is the Err a caller rolls back on. `answered` is what `wait_answering` got back.
pub fn wait_ready(container: &str, answered: &str) -> Result<()> {
    let mut readiness = Readiness::default();
    // A daemon that opened its journal and fell over before the first read below would otherwise answer
    // nothing, and pass for one too old to report anything.
    if let Ok(first) = serde_json::from_str::<serde_json::Value>(answered) {
        readiness.note(&first);
    }
    let started = Instant::now();
    let mut last_step = String::new();
    let mut crashing = None;
    loop {
        // A daemon that answered once and then fell over is not one that is ready: while netd says Node is down, the
        // wait holds (silence would read as an old daemon that reports nothing), and a crash loop ends it.
        let node = vitals(container);
        if let Some(looping) = node.as_ref().and_then(crash_loop) {
            crashing = Some(looping);
            break;
        }
        let down = node.as_ref().is_some_and(|node| node.node != "up");
        let health = if down {
            String::new()
        } else {
            docker::exec_capture(
                container,
                &["curl", "-sf", "-m", WAIT_READ_SECS, HEALTH_URL],
            )
            .unwrap_or_default()
        };
        let parsed = serde_json::from_str::<serde_json::Value>(&health).ok();
        if !down && readiness.admits(parsed.as_ref()) {
            return Ok(());
        }
        // A conversion that failed is not something more waiting can fix.
        if readiness.journal_failed {
            break;
        }
        if let Some(step) = parsed.as_ref().and_then(running_step) {
            if step != last_step {
                // The boot chain names its own steps; they are detail under the wait, never steps of their
                // own — a terminal shows the newest beside the spinner, a pipe gets one line each as before.
                crate::ui::detail(&step);
                if !crate::ui::is_rich() {
                    println!("intentic:   {step}…");
                }
                last_step = step;
            }
        }
        let budget = if readiness.journal_seen {
            JOURNAL_BUDGET
        } else {
            READY_BUDGET
        };
        if started.elapsed() >= budget {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    if let Some(looping) = crashing {
        bail!("the new version's daemon keeps crashing: {looping}.");
    }
    if readiness.journal_failed {
        bail!("the new version could not convert this sandbox's stored files; it put them back as they were.");
    }
    if readiness.journal_open {
        bail!(
            "the new version never finished converting the workspace state: its state journal was still open {}s after it started answering.",
            JOURNAL_BUDGET.as_secs()
        );
    }
    crate::ui::warn(&format!(
        "the daemon is still warming up after 2 minutes — it keeps going in the background.\nWatch it with: docker logs -f {container}"
    ));
    Ok(())
}

/// What one readiness wait has learned from the answers so far.
///
/// A daemon reports its state journal open from its start until it commits the conversions a new version
/// made, right after its readiness gate opens; until then the previous version can still restore the
/// pre-images. So once any answer said open, only a ready answer with the journal closed ends the wait, and
/// silence stops meaning "an old daemon that reports nothing": it is netd answering 503 while it
/// restarts a daemon that crashed mid-conversion.
#[derive(Default)]
struct Readiness {
    /// Some answer in this wait reported the journal open.
    journal_seen: bool,
    /// The newest readable answer still did.
    journal_open: bool,
    /// An answer reported the journal failed: the new version could not convert the files and put them back.
    journal_failed: bool,
}

impl Readiness {
    fn note(&mut self, health: &serde_json::Value) {
        self.journal_open = journal_open(health);
        self.journal_seen |= self.journal_open;
        self.journal_failed |= journal_failed(health);
    }

    /// May the wait end on this answer? None is no readable answer at all: an empty or unparsable body, or no
    /// answer (`curl -sf` fails on netd's 503 as it does on a refused connection).
    fn admits(&mut self, health: Option<&serde_json::Value>) -> bool {
        let Some(health) = health else {
            return !self.journal_seen;
        };
        self.note(health);
        !self.journal_open && !self.journal_failed && ready_flag(health) != Some(false)
    }
}

/// The daemon's readiness: `boot.ready` where the daemon reports it, a top-level `ready` for anything older
/// that did. Neither is a daemon too old to report a boot at all.
fn ready_flag(health: &serde_json::Value) -> Option<bool> {
    health
        .get("boot")
        .and_then(|boot| boot.get("ready"))
        .or_else(|| health.get("ready"))
        .and_then(|ready| ready.as_bool())
}

/// Whether a health document reports its state journal open (`"state":{"journal":"open"}`). A daemon too old
/// to know the conversion engine has no `state` at all, which reads as closed, and so does any shape this
/// binary does not recognise: only the one spelling the contract names counts.
pub fn journal_open(health: &serde_json::Value) -> bool {
    health
        .get("state")
        .and_then(|state| state.get("journal"))
        .and_then(|journal| journal.as_str())
        == Some("open")
}

/// Whether a health document reports that this boot's state conversion failed (`"state":{"journal":"failed"}`): the
/// daemon put the files back and runs on read-time conversion, which is a version that did not take.
pub fn journal_failed(health: &serde_json::Value) -> bool {
    health
        .get("state")
        .and_then(|state| state.get("journal"))
        .and_then(|journal| journal.as_str())
        == Some("failed")
}

/// How a running sandbox's own reach probe reads right now (`reachable`, `unreachable`, `checking`, `off`): what a swap
/// records before it stops the container, so the new version is held to the tunnel the old one had. None when the
/// container does not answer or its daemon is too old to probe.
pub fn reach_state(container: &str) -> Option<String> {
    let health = docker::exec_capture(container, &["curl", "-sf", "-m", "10", HEALTH_URL])?;
    let parsed: serde_json::Value = serde_json::from_str(&health).ok()?;
    parsed["reach"]["state"].as_str().map(str::to_string)
}

/// The label of any object in the health document with `"state":"running"` — a tree walk rather than a
/// schema, matching what the shell's grep did: the boot chain's shape belongs to the daemon, and this reader
/// must keep working as it grows. The doctor's daemon check names the same step.
pub fn running_step(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if map.get("state").and_then(|state| state.as_str()) == Some("running") {
                if let Some(label) = map.get("label").and_then(|label| label.as_str()) {
                    return Some(label.to_string());
                }
            }
            map.values().find_map(running_step)
        }
        serde_json::Value::Array(items) => items.iter().find_map(running_step),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// netd's vitals as the contract spells them (browser-wire's SandboxVitals, generated into the contract), which
    /// this reader must keep reading.
    const GOLDEN_WIRE: &str =
        include_str!("../../../_shared/sandbox-contract/src/netd/generated/browser-wire.json");

    #[test]
    fn the_vitals_are_read_by_the_names_and_values_netd_answers_with() {
        let wire: serde_json::Value = serde_json::from_str(GOLDEN_WIRE).expect("JSON");
        let vitals = &wire["vitals"];
        assert_eq!(
            vitals["path"],
            VITALS_URL.trim_start_matches("http://localhost:8787")
        );
        let body = &vitals["body"];
        assert_eq!(body["properties"]["node"]["$ref"], "#/$defs/NodeLink");
        assert_eq!(body["properties"]["restarts"]["type"], "integer");
        let links: Vec<&str> = body["$defs"]["NodeLink"]["oneOf"]
            .as_array()
            .expect("NodeLink is a oneOf")
            .iter()
            .filter_map(|link| link["const"].as_str())
            .collect();
        assert_eq!(links, ["starting", "up", "restarting"]);
    }

    #[test]
    fn a_daemon_down_after_three_restarts_is_a_crash_loop_and_nothing_less_is() {
        let read = |body: &str| read_vitals(body).expect("vitals");
        // netd's answer verbatim, from a sandbox whose daemon could not load a package (2026-10-06).
        let looping = read(
            r#"{"node":"restarting","lagMs":null,"restarts":3,"uptimeS":41,"pressure":null,"tunnel":{"state":"held","dropsLastHour":0,"quic":false}}"#,
        );
        assert_eq!(
            crash_loop(&looping).as_deref(),
            Some("netd restarted it 3 times in the last ten minutes, and it is down again")
        );
        // Two restarts is not yet a loop; three that ended with Node up is one that recovered.
        assert_eq!(
            crash_loop(&read(r#"{"node":"restarting","restarts":2}"#)),
            None
        );
        assert_eq!(crash_loop(&read(r#"{"node":"up","restarts":5}"#)), None);
        // A first boot that has not said hello yet is starting, not looping, until netd has had to restart it.
        assert_eq!(
            crash_loop(&read(r#"{"node":"starting","restarts":0}"#)),
            None
        );
        assert_eq!(
            crash_loop(&read(r#"{"node":"starting","restarts":3}"#)).as_deref(),
            Some("netd restarted it 3 times in the last ten minutes, and it is down again")
        );
        // What is not netd's answer is no answer: an image from before netd, a page in its place.
        assert_eq!(read_vitals("<html>not found</html>"), None);
        assert_eq!(read_vitals(r#"{"node":"up"}"#), None);
        assert_eq!(read_vitals(r#"{"restarts":3}"#), None);
    }

    /// netd's own source, for the one line of its log this binary reads.
    const NETD_SUPERVISE: &str = include_str!("../../netd/crates/netd/src/supervise.rs");

    #[test]
    fn the_restart_line_read_is_the_one_netd_logs() {
        assert!(
            NETD_SUPERVISE.contains(&format!("\"{NETD_RESTARTING}\"")),
            "netd no longer logs {NETD_RESTARTING:?}: the crash loop of a daemon that never reaches netd goes unseen"
        );
    }

    /// netd's stderr verbatim (2026-10-06), from a container whose daemon could not load a package, three restarts in.
    const LOOPING: &str = concat!(
        "2026-10-06T22:32:12.726649Z ERROR the daemon crashed; restarting it code=1 ran=180.166589ms\n",
        "node:internal/modules/package_json_reader:331\n",
        "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);\n",
        "        ^\n",
        "\n",
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ssh2' imported from /opt/sandbox/dist/capabilities/credentials/ssh-keys.js\n",
        "    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:331:9)\n",
        "    at ModuleJob.syncLink (node:internal/modules/esm/module_job:276:33) {\n",
        "  code: 'ERR_MODULE_NOT_FOUND'\n",
        "}\n",
        "\n",
        "Node.js v24.21.0\n",
        "2026-10-06T22:32:34.968079Z ERROR the daemon crashed; restarting it code=1 ran=168.365025ms\n",
        "node:internal/modules/package_json_reader:331\n",
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ssh2' imported from /opt/sandbox/dist/capabilities/credentials/ssh-keys.js\n",
        "Node.js v24.21.0\n",
        "2026-10-06T22:33:04.225244Z ERROR the daemon crashed; restarting it code=1 ran=182.637998ms\n",
    );

    #[test]
    fn netds_log_of_three_restarts_is_a_crash_loop_named_by_the_error_it_dies_on() {
        assert_eq!(
            crashes_in(LOOPING).as_deref(),
            Some("netd restarted it 3 times in the last ten minutes, each time after Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ssh2' imported from /opt/sandbox/dist/capabilities/credentials/ssh-keys.js")
        );
        // Two restarts is not yet a loop.
        let two = LOOPING
            .rsplit_once("2026-10-06T22:33:04")
            .map(|(before, _)| before)
            .unwrap();
        assert_eq!(crashes_in(two), None);
        // A crash that printed no error line is still counted.
        let bare = format!("{NETD_RESTARTING}\n{NETD_RESTARTING}\n{NETD_RESTARTING}\n");
        assert_eq!(
            crashes_in(&bare).as_deref(),
            Some("netd restarted it 3 times in the last ten minutes")
        );
        assert_eq!(crashes_in(""), None);
    }

    #[test]
    fn finds_the_running_step_wherever_the_schema_puts_it() {
        let health = serde_json::json!({
            "ready": false,
            "boot": { "steps": [
                { "state": "done", "label": "restore snapshots" },
                { "state": "running", "label": "index the workspace" },
            ]}
        });
        assert_eq!(
            running_step(&health).as_deref(),
            Some("index the workspace")
        );
        assert_eq!(running_step(&serde_json::json!({"ready": true})), None);
        // The journal's `state` is an object, not a step's state string, and must not be read as one.
        let converting = serde_json::json!({
            "state": { "journal": "open", "engine": 7 },
            "boot": { "steps": [{ "state": "running", "label": "convert state" }] }
        });
        assert_eq!(running_step(&converting).as_deref(), Some("convert state"));
    }

    /// The contract's example of `/health`'s `state` (StateStatusSchema, spelled once in its test and written to
    /// golden/), which this reader must keep reading.
    const GOLDEN_HEALTH: &str =
        include_str!("../../../_shared/sandbox-contract/golden/health-state.json");

    #[test]
    fn the_contracts_health_state_reads_as_an_open_journal() {
        let health: serde_json::Value = serde_json::from_str(GOLDEN_HEALTH).expect("JSON");
        assert_eq!(health["state"]["journal"], "open");
        assert!(journal_open(&health));
    }

    #[test]
    fn only_the_contracts_own_spelling_reads_as_an_open_journal() {
        assert!(journal_open(
            &serde_json::json!({ "state": { "journal": "open", "engine": 7 } })
        ));
        assert!(!journal_open(
            &serde_json::json!({ "state": { "journal": "none", "engine": 7 } })
        ));
        // A daemon from before the engine answers no `state` at all.
        assert!(!journal_open(
            &serde_json::json!({ "ok": true, "ready": true })
        ));
        // Shapes this binary does not know are closed, never guessed open: a guess here fails a swap.
        assert!(!journal_open(&serde_json::json!({ "state": "open" })));
        assert!(!journal_open(
            &serde_json::json!({ "state": { "journal": true } })
        ));
        assert!(!journal_open(
            &serde_json::json!({ "state": { "journal": "OPEN" } })
        ));
        assert!(!journal_open(&serde_json::json!(["state"])));
    }

    #[test]
    fn a_daemon_that_never_reports_a_journal_is_waited_for_exactly_as_before() {
        let mut readiness = Readiness::default();
        // Still booting: hold.
        assert!(!readiness.admits(Some(&serde_json::json!({ "ready": false }))));
        // An unreadable answer from a daemon that never opened a journal is the old single-wait "ready".
        assert!(readiness.admits(None));
        assert!(readiness.admits(Some(&serde_json::json!({ "ready": true }))));
        // Neither field at all: a daemon too old to report a boot.
        assert!(readiness.admits(Some(&serde_json::json!({ "ok": true }))));
        assert!(!readiness.journal_open);
    }

    #[test]
    fn once_a_journal_was_open_only_a_ready_answer_with_it_committed_ends_the_wait() {
        let mut readiness = Readiness::default();
        let open =
            serde_json::json!({ "ready": true, "state": { "journal": "open", "engine": 7 } });
        // Ready is not enough while the conversions are uncommitted.
        assert!(!readiness.admits(Some(&open)));
        // netd's 503 while it restarts a crashed daemon: silence is no longer readiness.
        assert!(!readiness.admits(None));
        assert!(
            readiness.journal_open,
            "an unreadable answer leaves the last word standing"
        );
        // Committed, but not ready.
        let committed_booting =
            serde_json::json!({ "ready": false, "state": { "journal": "none", "engine": 7 } });
        assert!(!readiness.admits(Some(&committed_booting)));
        assert!(!readiness.journal_open);
        // Still no readiness in silence, even after the commit: the rule is "once seen".
        assert!(!readiness.admits(None));
        assert!(readiness.admits(Some(&serde_json::json!({ "state": { "journal": "none" } }))));
    }

    #[test]
    fn readiness_is_read_where_the_daemon_reports_it() {
        let mut readiness = Readiness::default();
        // The daemon nests it under `boot`; a top-level-only reader returned on the first answer.
        assert!(!readiness.admits(Some(
            &serde_json::json!({ "ok": true, "boot": { "ready": false, "steps": [] } })
        )));
        assert!(readiness.admits(Some(
            &serde_json::json!({ "ok": true, "boot": { "ready": true, "steps": [] } })
        )));
        assert_eq!(
            ready_flag(&serde_json::json!({ "ready": false })),
            Some(false)
        );
        assert_eq!(ready_flag(&serde_json::json!({ "ok": true })), None);
    }

    #[test]
    fn the_answer_that_ended_the_first_wait_counts_toward_the_second() {
        // What wait_ready seeds from wait_answering: the journal opened, then the daemon went quiet.
        let mut readiness = Readiness::default();
        readiness.note(&serde_json::json!({ "state": { "journal": "open", "engine": 7 } }));
        assert!(!readiness.admits(None));
        assert!(readiness.journal_open);
    }
}
