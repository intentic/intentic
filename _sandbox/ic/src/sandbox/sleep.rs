use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::docker;
use crate::record::ChannelRecord;
use crate::sandbox::fix::chain::{self, Env, WorkSignal};
use crate::sandbox::fix::host::Os;
use crate::sandbox::fix::model::{self, Check, Fix, Outcome, Source, Stage, CONTAINER};
use crate::sandbox::fix::report::{self, Poster, Target};
use crate::sandbox::lock::{self, Wait};
use crate::sandbox::power::{self, By, Power};
use crate::sandbox::side::{self, Unattended};
use crate::sandbox::{container_of, inside, mirror, now_ms, parked_of, resolve_slug};
use crate::ui;
use crate::util::{bail, Result};

/* `ic sandbox sleep` AND `ic sandbox wakes` — A SANDBOX ON THIS COMPUTER THAT NOBODY USES, PUT TO SLEEP, AND STARTED
AGAIN WHEN SOMEBODY OPENS IT.

A local sandbox runs for as long as the computer does, and one nobody has touched for an hour holds its memory for
nothing. The machine agent's keeper runs `ic sandbox sleep --idle <minutes>` on its sweeps: a sandbox whose daemon says
it has been quiet that long (nobody in its editor, nothing working, no terminal in use, no workspace app open: the work
signal's `quietSince`, chain.rs) and has no wake promised within that window is stopped through Docker, which its
`unless-stopped` policy then leaves down, and its record says `asleep` (record.rs). Its page is told (a host report
with `asleep`). Opening it in the browser leaves a wake request on the platform, which cannot reach this machine;
`ic sandbox wakes`, which the agent polls while anything here sleeps, asks for those requests and starts each sandbox
asked for, as a person's start. The keeper's fix run leaves a sandbox asleep alone and an attended fix starts it
(chain.rs); every start, restart and recreate wakes it. */

/// What `ic sandbox sleep` was asked.
pub struct Args {
    pub slug: Option<String>,
    /// Sleep only what has been quiet this many minutes (the keeper's form); None puts the sandbox to sleep now.
    pub idle: Option<u64>,
    pub json: bool,
    pub source: Source,
}

/// Whether the daemon's work signal lets a sandbox sleep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Sleep,
    /// It stays awake, and why, in a few words.
    Awake(&'static str),
}

/// The why of a daemon that is not quiet: it is busy, or too old to say (an older daemon writes no `quietSince`).
const NOT_QUIET: &str = "no quiet signal (busy, or an older daemon)";

/// The decision, pure over the signal and the clock: a signal that reads, written within the last three minutes, with
/// nothing working, quiet for at least `idle_ms`, and no wake promised before that long from now. A wake promised
/// further out does not hold it awake, and nothing on this computer starts a sleeping sandbox for a clock: that is the
/// window's trade. Pure.
pub fn sleep_verdict(signal: Option<WorkSignal>, now_ms: u64, idle_ms: u64) -> Verdict {
    let Some(signal) = signal else {
        return Verdict::Awake("unreadable");
    };
    if !signal.fresh(now_ms) {
        return Verdict::Awake("signal stale");
    }
    if signal.live_turns > 0 {
        return Verdict::Awake("busy");
    }
    let Some(quiet_since) = signal.quiet_since else {
        return Verdict::Awake(NOT_QUIET);
    };
    if now_ms.saturating_sub(quiet_since) < idle_ms {
        return Verdict::Awake("not quiet long enough");
    }
    if signal
        .next_wake_at
        .is_some_and(|at| at.saturating_sub(now_ms) <= idle_ms)
    {
        return Verdict::Awake("a wake is due");
    }
    Verdict::Sleep
}

/// What keeps a sandbox from sleeping before its daemon is even asked: an update in flight or on probation (the watch
/// would judge a sandbox it finds down as failing, and go back), one an interrupted update left set aside, and, for the
/// keeper's sweep, one its owner stopped on purpose. Pure.
pub fn held_back(record: &ChannelRecord, parked: bool, sweep: bool) -> Option<&'static str> {
    if record.swap.is_some() {
        return Some("an update is in flight or on probation");
    }
    if parked {
        return Some("an interrupted update left it set aside");
    }
    if sweep && record.held {
        return Some("held (stopped on purpose)");
    }
    None
}

/// How long a sandbox has been quiet, for the line that says it slept. Pure.
fn quiet_for(signal: Option<WorkSignal>, now_ms: u64) -> String {
    let minutes = signal
        .and_then(|signal| signal.quiet_since)
        .map_or(0, |since| now_ms.saturating_sub(since) / 60_000);
    format!(
        "quiet for {}",
        crate::util::plural(minutes as usize, "minute")
    )
}

/// One sandbox's line: `{"slug","slept","why"}` for `--json`, else a sentence. Pure.
fn line(slug: &str, slept: bool, why: &str, json: bool) -> String {
    if json {
        return json!({ "slug": slug, "slept": slept, "why": why }).to_string();
    }
    if slept {
        format!("intentic: {slug} is asleep; it starts again when somebody opens it.")
    } else {
        format!("intentic: {slug} stays awake: {why}.")
    }
}

fn say(slug: &str, slept: bool, why: &str, json: bool) {
    let said = line(slug, slept, why, json);
    if json {
        report::emit(&said);
    } else {
        println!("{said}");
    }
}

pub fn run(args: Args) -> Result<()> {
    if args.json {
        ui::send_human_to_stderr();
    }
    docker::require_daemon()?;
    match args.idle {
        None => sleep_now(args.slug, args.json, args.source),
        Some(minutes) => sleep_idle(args.slug, minutes, args.json, args.source),
    }
}

/// The explicit form: this sandbox, now, as `ic sandbox stop` would take it down. Fails when it cannot.
fn sleep_now(slug: Option<String>, json: bool, source: Source) -> Result<()> {
    let slug = resolve_slug(slug, "ic sandbox sleep")?;
    let _held = lock::hold_for_person(&slug)?;
    let container = container_of(&slug);
    let refused = if !docker::container_exists(&container) {
        Some(format!(
            "sandbox container {container} does not exist on this machine."
        ))
    } else if let Some(why) = held_back(
        &mirror::reconcile(&slug),
        docker::container_exists(&parked_of(&slug)),
        false,
    ) {
        Some(format!("{slug} was not put to sleep: {why}."))
    } else if !inside::running(&container) {
        Some(format!(
            "{slug} is not running, so there is nothing to put to sleep (ic sandbox start {slug} starts it)."
        ))
    } else {
        put_to_sleep(&slug, source).err().map(|fail| fail.0)
    };
    if let Some(refused) = refused {
        if json {
            say(&slug, false, &refused, true);
        }
        bail!("{refused}");
    }
    say(&slug, true, "asked to sleep now", json);
    Ok(())
}

/// The keeper's form: every sandbox this side keeps (or the one named), each slept only if it has been quiet long
/// enough. A sandbox that stays awake is an answer, not a failure.
fn sleep_idle(slug: Option<String>, minutes: u64, json: bool, source: Source) -> Result<()> {
    let idle_ms = minutes.saturating_mul(60_000);
    let slugs = match slug {
        Some(slug) => vec![resolve_slug(Some(slug), "ic sandbox sleep")?],
        None => match crate::sandbox::live_slugs() {
            Some(slugs) => slugs,
            None => bail!("docker could not list this machine's sandboxes."),
        },
    };
    for slug in slugs {
        let (slept, why) = consider(&slug, idle_ms, source);
        say(&slug, slept, &why, json);
    }
    Ok(())
}

/// One sandbox through every reason to leave it awake, put to sleep when none holds: whether it slept, and why.
fn consider(slug: &str, idle_ms: u64, source: Source) -> (bool, String) {
    // Only this side's own: another side's keeper runs its own sweep, and only the side that slept a sandbox asks for
    // its wakes (its record is the one that says asleep). One adopted from a silent keeper is left awake for the same
    // reason.
    match side::unattended(slug) {
        Unattended::Ours => {}
        Unattended::Theirs(keeper) => return (false, format!("kept by {}", keeper.name())),
        Unattended::Adopted(adoption) => {
            return (false, format!("kept by {}", adoption.from.name()))
        }
    }
    // Never under another ic run: an update, a backup, a person's restart.
    let _held = match lock::hold(slug, Wait::Skip) {
        Ok(Some(held)) => held,
        Ok(None) => return (false, "another ic run is working on it".to_string()),
        Err(fail) => return (false, fail.0),
    };
    let container = container_of(slug);
    if !inside::running(&container) {
        let asleep = crate::record::read(slug).is_ok_and(|record| record.asleep);
        return (
            false,
            if asleep { "asleep" } else { "not running" }.to_string(),
        );
    }
    let record = mirror::reconcile(slug);
    if let Some(why) = held_back(&record, docker::container_exists(&parked_of(slug)), true) {
        return (false, why.to_string());
    }
    let signal = chain::read_work_signal(&container);
    let now = now_ms();
    match sleep_verdict(signal, now, idle_ms) {
        Verdict::Awake(why) => (false, why.to_string()),
        Verdict::Sleep => match put_to_sleep(slug, source) {
            Ok(()) => (true, quiet_for(signal, now)),
            Err(fail) => (false, format!("could not stop it: {}", fail.0)),
        },
    }
}

/// Stop it as a stop does, record it asleep, and tell its page. The caller holds its lock.
fn put_to_sleep(slug: &str, source: Source) -> Result<()> {
    // Read while it still runs; a stopped container's env reads the same, so nothing hangs on the order.
    let reporter = Reporter::of(slug);
    power::sleep(slug)?;
    if let Some(reporter) = reporter {
        let body = reporter.body(source, Stage::Done, None, Some(Outcome::Healthy), &[], true);
        report::post_now(&reporter.target, body);
    }
    Ok(())
}

/* REPORTING FOR A SANDBOX THAT SLEEPS OR WAKES, beside the fix engine's own reports and named the same way (the
container's HOST_LABEL, this side's os and environment), so the page sees one reporter. The page reads the newest:
`asleep` says asleep, a `fixing` while it wakes says who is waking it, and a `done` after says it is back. */

struct Reporter {
    target: Target,
    machine: String,
}

impl Reporter {
    /// Where this sandbox's reports go, off its container's env and its record; None when it has no key or no id.
    fn of(slug: &str) -> Option<Reporter> {
        let env = docker::container_env_nul(&container_of(slug))
            .map(|env| Env::parse(&String::from_utf8_lossy(&env)))
            .unwrap_or_default();
        let record = crate::record::read(slug).unwrap_or_default();
        let target = report::target_of(
            slug,
            env.token.as_deref(),
            env.platform.as_deref(),
            &record,
            report::forced_platform().as_deref(),
        )?;
        Some(Reporter {
            target,
            machine: env
                .host_label
                .unwrap_or_else(crate::sandbox::connect::machine_label),
        })
    }

    fn body(
        &self,
        source: Source,
        stage: Stage,
        doing: Option<&str>,
        outcome: Option<Outcome>,
        checks: &[Check],
        asleep: bool,
    ) -> Value {
        let env = side::here().env;
        model::wire(&model::Report {
            source,
            machine: &self.machine,
            os: Os::detect().wire(),
            env: env.as_deref(),
            stage,
            doing,
            outcome,
            checks,
            asleep,
        })
    }
}

/// What `ic sandbox wakes` was asked.
pub struct WakesArgs {
    pub json: bool,
    pub source: Source,
}

/// What a wake's report says while it starts the sandbox.
const WAKING: &str = "Waking it up: somebody opened it";

/// This side's own sandboxes whose record says asleep: off the records in this home alone, no docker asked.
fn asleep_here() -> Vec<(String, ChannelRecord)> {
    crate::sandbox::fix::own_records()
        .into_iter()
        .filter_map(|slug| {
            let record = crate::record::read(&slug).ok()?;
            record.asleep.then_some((slug, record))
        })
        .collect()
}

/// The sandboxes asleep, grouped by the platform each reports to, each with where its reports go: what one ask per
/// platform carries. A sandbox with no key, or a slug with no tunnel id, cannot be asked about. Pure.
pub fn asks_of(
    asleep: &[(String, ChannelRecord)],
    forced: Option<&str>,
) -> BTreeMap<String, Vec<(String, Target)>> {
    let mut asks: BTreeMap<String, Vec<(String, Target)>> = BTreeMap::new();
    for (slug, record) in asleep {
        if let Some(target) = report::target_of(slug, None, None, record, forced) {
            asks.entry(target.platform.clone())
                .or_default()
                .push((slug.clone(), target));
        }
    }
    asks
}

/// One woken sandbox's `--json` line. Pure.
fn woke_line(slug: &str, failed: Option<&str>) -> String {
    match failed {
        None => json!({ "slug": slug, "woke": true }).to_string(),
        Some(error) => json!({ "slug": slug, "woke": false, "error": error }).to_string(),
    }
}

/// The run's last `--json` line: how many sandboxes on this side are still asleep, which is what tells the machine
/// agent to stop polling. Pure.
fn asleep_line(count: usize) -> String {
    json!({ "asleep": count }).to_string()
}

/// `ic sandbox wakes`: polled every few seconds while anything here sleeps, so it asks docker nothing at all until a
/// record says asleep, and a platform it cannot reach is nothing to wake rather than an error.
pub fn wakes(args: WakesArgs) -> Result<()> {
    if args.json {
        ui::send_human_to_stderr();
    }
    let asleep = asleep_here();
    let mut woken: Vec<(String, Target)> = Vec::new();
    for (platform, asked) in asks_of(&asleep, report::forced_platform().as_deref()) {
        let targets: Vec<Target> = asked.iter().map(|(_, target)| target.clone()).collect();
        let ids = report::wakes(&platform, &targets);
        woken.extend(
            asked
                .into_iter()
                .filter(|(_, target)| ids.contains(&target.sandbox)),
        );
    }
    // Started only for a wake: the poll that finds nothing spends nothing on it.
    let mut poster = (!woken.is_empty()).then(Poster::start);
    for (slug, target) in &woken {
        let machine = docker::container_env_value(&container_of(slug), "HOST_LABEL")
            .unwrap_or_else(crate::sandbox::connect::machine_label);
        let reporter = Reporter {
            target: target.clone(),
            machine,
        };
        // Told first, so the page says who is waking it while the start runs; the poster sends it beside the start.
        if let Some(poster) = &poster {
            poster.send(
                target,
                Stage::Fixing,
                reporter.body(args.source, Stage::Fixing, Some(WAKING), None, &[], false),
            );
        }
        // A person's visit, relayed: a start like theirs, which clears `asleep`, and never one the keeper's limit counts.
        let started = power::run_by(Power::Start, Some(slug.clone()), By::Person);
        let failed = started.err().map(|fail| fail.0);
        let done = match &failed {
            None => reporter.body(
                args.source,
                Stage::Done,
                None,
                Some(Outcome::Healthy),
                &[],
                false,
            ),
            Some(error) => reporter.body(
                args.source,
                Stage::Done,
                None,
                Some(Outcome::Failed),
                &[Check::fail(
                    CONTAINER,
                    error.as_str(),
                    format!("start it: ic sandbox start {slug}"),
                    Fix::You,
                )],
                false,
            ),
        };
        if let Some(poster) = &poster {
            poster.send(target, Stage::Done, done);
        }
        if args.json {
            report::emit(&woke_line(slug, failed.as_deref()));
        } else if let Some(error) = &failed {
            ui::warn(&format!("{slug} could not be woken: {error}"));
        } else {
            println!("intentic: {slug} woke up: somebody opened it.");
        }
    }
    if let Some(poster) = &mut poster {
        poster.finish();
    }
    let left = if woken.is_empty() {
        asleep.len()
    } else {
        asleep_here().len()
    };
    if args.json {
        report::emit(&asleep_line(left));
    } else if woken.is_empty() {
        println!("intentic: nothing to wake ({} asleep on this side).", left);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{Phase, Swap};

    const NOW: u64 = 1_791_240_330_000;
    const MIN: u64 = 60_000;

    fn quiet(minutes: u64) -> WorkSignal {
        WorkSignal {
            at: NOW - 20_000,
            live_turns: 0,
            quiet_since: Some(NOW - minutes * MIN),
            next_wake_at: None,
        }
    }

    #[test]
    fn a_sandbox_quiet_long_enough_with_nothing_due_sleeps() {
        assert_eq!(
            sleep_verdict(Some(quiet(45)), NOW, 30 * MIN),
            Verdict::Sleep
        );
        assert_eq!(
            sleep_verdict(Some(quiet(30)), NOW, 30 * MIN),
            Verdict::Sleep,
            "exactly the window is long enough"
        );
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    next_wake_at: Some(NOW + 31 * MIN),
                    ..quiet(45)
                }),
                NOW,
                30 * MIN
            ),
            Verdict::Sleep,
            "a wake further out than the window does not hold it"
        );
    }

    #[test]
    fn every_reason_to_stay_awake_is_named() {
        let idle = 30 * MIN;
        assert_eq!(sleep_verdict(None, NOW, idle), Verdict::Awake("unreadable"));
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    at: NOW - 3 * MIN - 1,
                    ..quiet(45)
                }),
                NOW,
                idle
            ),
            Verdict::Awake("signal stale"),
            "a quiet a hung daemon left behind is believed no more than its count"
        );
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    at: NOW - 3 * MIN,
                    ..quiet(45)
                }),
                NOW,
                idle
            ),
            Verdict::Sleep,
            "three minutes is still fresh"
        );
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    live_turns: 1,
                    ..quiet(45)
                }),
                NOW,
                idle
            ),
            Verdict::Awake("busy"),
            "work counts even beside a quiet stamp"
        );
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    quiet_since: None,
                    ..quiet(45)
                }),
                NOW,
                idle
            ),
            Verdict::Awake(NOT_QUIET)
        );
        assert_eq!(
            sleep_verdict(Some(quiet(29)), NOW, idle),
            Verdict::Awake("not quiet long enough")
        );
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    quiet_since: Some(NOW + MIN),
                    ..quiet(0)
                }),
                NOW,
                idle
            ),
            Verdict::Awake("not quiet long enough"),
            "a quiet stamp from the future is no quiet yet"
        );
        for due in [NOW + 30 * MIN, NOW + MIN, NOW - MIN] {
            assert_eq!(
                sleep_verdict(
                    Some(WorkSignal {
                        next_wake_at: Some(due),
                        ..quiet(45)
                    }),
                    NOW,
                    idle
                ),
                Verdict::Awake("a wake is due"),
                "{due}"
            );
        }
    }

    #[test]
    fn an_update_a_parked_container_and_for_the_sweep_a_hold_keep_it_awake() {
        let plain = ChannelRecord::default();
        assert_eq!(held_back(&plain, false, true), None);
        let swapping = ChannelRecord {
            swap: Some(Swap {
                phase: Phase::Probation,
                at: NOW - MIN,
                verb: "update".to_string(),
                from: None,
                to: None,
                until: Some(NOW + MIN),
                reach: None,
                strikes: 0,
                daemon_start: None,
                daemon_restarts: 0,
                alive: None,
            }),
            ..ChannelRecord::default()
        };
        assert!(held_back(&swapping, false, false).is_some_and(|why| why.contains("update")));
        assert!(held_back(&plain, true, false).is_some_and(|why| why.contains("set aside")));
        let held = ChannelRecord {
            held: true,
            ..ChannelRecord::default()
        };
        assert!(held_back(&held, false, true).is_some_and(|why| why.contains("held")));
        assert_eq!(
            held_back(&held, false, false),
            None,
            "a person asking for a sleep is not refused for a hold"
        );
    }

    #[test]
    fn the_lines_say_what_happened_to_each_sandbox() {
        let slept: Value = serde_json::from_str(&line(
            "sandbox-0123456789ab",
            true,
            "quiet for 40 minutes",
            true,
        ))
        .expect("JSON");
        assert_eq!(
            slept,
            json!({ "slug": "sandbox-0123456789ab", "slept": true, "why": "quiet for 40 minutes" })
        );
        assert_eq!(
            line("sandbox-0123456789ab", true, "x", false),
            "intentic: sandbox-0123456789ab is asleep; it starts again when somebody opens it."
        );
        assert_eq!(
            line("work", false, "busy", false),
            "intentic: work stays awake: busy."
        );
        assert_eq!(quiet_for(Some(quiet(40)), NOW), "quiet for 40 minutes");
        assert_eq!(quiet_for(Some(quiet(1)), NOW), "quiet for 1 minute");
        assert_eq!(
            serde_json::from_str::<Value>(&woke_line("s", None)).expect("JSON"),
            json!({ "slug": "s", "woke": true })
        );
        assert_eq!(
            serde_json::from_str::<Value>(&woke_line("s", Some("no such container")))
                .expect("JSON"),
            json!({ "slug": "s", "woke": false, "error": "no such container" })
        );
        assert_eq!(asleep_line(2), r#"{"asleep":2}"#);
    }

    #[test]
    fn one_ask_per_platform_carries_every_sandbox_asleep_that_can_be_asked_about() {
        let asleep = |key: Option<&str>, platform: Option<&str>| ChannelRecord {
            asleep: true,
            report_key: key.map(str::to_string),
            report_platform: platform.map(str::to_string),
            ..ChannelRecord::default()
        };
        let records = vec![
            (
                "sandbox-0123456789ab".to_string(),
                asleep(Some("a"), Some("https://p.example")),
            ),
            (
                "sandbox-ba9876543210".to_string(),
                asleep(Some("b"), Some("https://p.example")),
            ),
            (
                "sandbox-aaaaaaaaaaaa".to_string(),
                asleep(Some("c"), Some("https://q.example")),
            ),
            (
                "sandbox-bbbbbbbbbbbb".to_string(),
                asleep(None, Some("https://p.example")),
            ),
            (
                "work".to_string(),
                asleep(Some("d"), Some("https://p.example")),
            ),
        ];
        let asks = asks_of(&records, None);
        assert_eq!(
            asks.keys().cloned().collect::<Vec<_>>(),
            vec![
                "https://p.example".to_string(),
                "https://q.example".to_string()
            ]
        );
        let p: Vec<(&str, &str)> = asks["https://p.example"]
            .iter()
            .map(|(slug, target)| (slug.as_str(), target.sandbox.as_str()))
            .collect();
        assert_eq!(
            p,
            vec![
                ("sandbox-0123456789ab", "0123456789ab"),
                ("sandbox-ba9876543210", "ba9876543210")
            ],
            "no key, or no tunnel id, cannot be asked about"
        );
        let forced = asks_of(&records, Some("http://localhost:6480"));
        assert_eq!(
            forced.keys().cloned().collect::<Vec<_>>(),
            vec!["http://localhost:6480".to_string()]
        );
        assert!(asks_of(&[], None).is_empty());
    }
}
