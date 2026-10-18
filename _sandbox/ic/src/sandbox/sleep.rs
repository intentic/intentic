use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::docker;
use crate::record::ChannelRecord;
use crate::sandbox::fix::chain::{Env, WorkSignal};
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
(chain.rs); every start, restart and recreate wakes it.

THE ALARM (2026-10-18). A sleeping sandbox used to miss what it had scheduled: a cron came due with nothing running, and
fired once, late, at the next start. Now the sleep reads the soonest moment the daemon promised (the signal's
`nextWakeAt`, crons included) into the record as `wake_at`, and `ic sandbox wakes` starts the sandbox that long ahead of
it which its wakes have been taking (`wake_lead`), on this machine's clock alone, before asking the platform anything:
the daemon is up before the moment and fires it on the minute. A moment too close to be worth a sleep (`MIN_ASLEEP_MS`
past the lead) keeps it awake instead. A sandbox the alarm woke that no person has used since (the signal's `personAt`)
sleeps again after `ALARM_GRACE_MS` of quiet rather than the keeper's whole limit, so an hourly chore does not keep it up
half the day. */

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
/// Settings or a continuous event/listener automation holds this sandbox awake (the signal's `keepAwake`).
const KEPT_AWAKE: &str = "its settings or an enabled receiver requires it to stay awake";

// A heartbeat may predate a newly booked send. Ask the daemon itself immediately before sleep; an older daemon or
// an unreadable clock cannot certify it, so an unattended sleep leaves it running.
pub(super) const SLEEP_SOCKET: &str = "/run/intentic/sleep.sock";
const SLEEP_PROBE: &str = r#"const c=require('node:net').connect(process.argv[1]);c.setTimeout(10000,()=>{c.destroy();process.exitCode=1});c.on('data',b=>process.stdout.write(b));c.on('error',()=>{process.exitCode=1});"#;

fn confirmed_signal(container: &str) -> Option<WorkSignal> {
    confirmed_signal_with(container, docker::run_bounded)
}

fn confirmed_signal_with(
    container: &str,
    run: impl FnOnce(&str, &[&str], std::time::Duration) -> Result<docker::Bounded>,
) -> Option<WorkSignal> {
    let ran = run(
        "docker",
        &["exec", container, "node", "-e", SLEEP_PROBE, SLEEP_SOCKET],
        std::time::Duration::from_secs(12),
    )
    .ok()?;
    (ran.code == Some(0) && !ran.timed_out)
        .then(|| WorkSignal::parse(&ran.stdout))
        .flatten()
}

/// The shortest sleep worth taking: a moment due sooner than the alarm's lead and this keeps the sandbox awake, since
/// stopping it only to start it again a minute later frees nothing and costs a boot.
pub const MIN_ASLEEP_MS: u64 = 5 * 60_000;
/// How long a sandbox the alarm woke may stay quiet before it sleeps again, when no person has used it since.
pub const ALARM_GRACE_MS: u64 = 5 * 60_000;
/// The alarm's lead never goes under this, whatever the wakes measured: room for a slow disk and the daemon's boot.
pub const LEAD_FLOOR_MS: u64 = 2 * 60_000;
/// Nor over this: a start that applies a saved shape (a recreate) is the slowest there is, and gets all of it.
pub const LEAD_CEILING_MS: u64 = 10 * 60_000;
/// What a wake costs past docker's start, which is what the record measures: the daemon's boot up to its scheduler
/// (about a second and a half, measured on a sandbox of rog), with room for a loaded machine.
const BOOT_ALLOWANCE_MS: u64 = 60_000;

/// How long before its alarm `ic sandbox wakes` starts a sandbox: twice what its plain starts from sleep have been
/// taking, plus the daemon's boot, within the floor and the ceiling; the ceiling for a start that will apply a saved
/// shape. Pure.
pub fn wake_lead(record: &ChannelRecord) -> u64 {
    if record.desired.is_some() {
        return LEAD_CEILING_MS;
    }
    record
        .wake_cost
        .unwrap_or(0)
        .saturating_mul(2)
        .saturating_add(BOOT_ALLOWANCE_MS)
        .clamp(LEAD_FLOOR_MS, LEAD_CEILING_MS)
}

/// What a wake that took `took_ms` leaves as the cost: the slower of it and three quarters of the last, so one slow start
/// lengthens the lead at once and fades over the next few. Pure.
pub fn next_wake_cost(previous: Option<u64>, took_ms: u64) -> u64 {
    took_ms.max(previous.unwrap_or(0) / 4 * 3)
}

/// Whether a sleeping sandbox's alarm is due for its start now. A moment long past still wakes it: the daemon then fires
/// what it missed, late and saying so. Pure.
pub fn alarm_due(record: &ChannelRecord, now_ms: u64) -> bool {
    record.asleep
        && !record.held
        && record
            .wake_at
            .is_some_and(|at| at.saturating_sub(wake_lead(record)) <= now_ms)
}

/// The quiet a sleep needs this time: the keeper's limit, or the alarm's short grace for a sandbox the alarm woke that no
/// person has used since. A daemon that does not say when a person was last there gets the keeper's limit. Pure.
pub fn idle_limit(record: &ChannelRecord, signal: Option<WorkSignal>, idle_ms: u64) -> u64 {
    let unvisited = match (
        record.alarm_woke_at,
        signal.and_then(|signal| signal.person_at),
    ) {
        (Some(woke), Some(person)) => person < woke,
        _ => false,
    };
    if unvisited {
        idle_ms.min(ALARM_GRACE_MS)
    } else {
        idle_ms
    }
}

/// The decision, pure over the signal and the clock: a signal that reads, written within the last three minutes, with
/// nothing working, sleep not switched off by its owner, quiet for at least `idle_ms`, and no promised moment due within
/// the alarm's lead and the shortest sleep worth taking. A moment further out does not hold it awake: the sleep sets an
/// alarm for it, and `ic sandbox wakes` starts the sandbox `lead_ms` ahead. Pure.
pub fn sleep_verdict(
    signal: Option<WorkSignal>,
    now_ms: u64,
    idle_ms: u64,
    lead_ms: u64,
) -> Verdict {
    let Some(signal) = signal else {
        return Verdict::Awake("unreadable");
    };
    if !signal.fresh(now_ms) {
        return Verdict::Awake("signal stale");
    }
    if signal.live_turns > 0 {
        return Verdict::Awake("busy");
    }
    if signal.keep_awake {
        return Verdict::Awake(KEPT_AWAKE);
    }
    let Some(quiet_since) = signal.quiet_since else {
        return Verdict::Awake(NOT_QUIET);
    };
    if now_ms.saturating_sub(quiet_since) < idle_ms {
        return Verdict::Awake("not quiet long enough");
    }
    if signal
        .next_wake_at
        .is_some_and(|at| at.saturating_sub(now_ms) <= lead_ms.saturating_add(MIN_ASLEEP_MS))
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

/* A DEV SANDBOX ASKS ITS CHECKOUT BEFORE IT SLEEPS (2026-10-18). One that dev-sandbox.sh launched runs its checkout's
compiled code over an image that installed the dependencies of whenever it was built, so a dependency the checkout added
since crashes its next start, and after a sleep every wake is one. The checkout's own script (dev-before-sleep.mjs) says
whether the image still holds what the daemon needs and, when it does not, starts the rebuild while nobody is using the
sandbox: exit 75 and one line hold it awake for that. Anything else lets it sleep as before: a checkout this side cannot
see, one without the script, a node the login shell cannot find, or a script that took longer than a minute to answer. */
const DEV_ROOT_ENV: &str = "SANDBOX_DEV_ROOT";
const DEV_BEFORE_SLEEP: &str = "_sandbox/sandbox/scripts/dev-before-sleep.mjs";
const DEV_KEEP_AWAKE: i32 = 75;
const DEV_ASK_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// The line that asks, run by a login shell so node and pnpm are where the owner's own terminal finds them. Pure.
fn dev_ask_script(root: &str, slug: &str) -> String {
    let quoted = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    format!(
        "cd {} && exec node {DEV_BEFORE_SLEEP} {}",
        quoted(root),
        quoted(slug)
    )
}

/// The checkout's answer: the reason to stay awake, or None to sleep. Pure.
fn held_by_checkout(code: Option<i32>, stdout: &str) -> Option<String> {
    (code == Some(DEV_KEEP_AWAKE)).then(|| {
        stdout
            .lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
            .unwrap_or("its dev checkout asked")
            .to_string()
    })
}

fn dev_checkout_holds_awake(slug: &str, container: &str) -> Option<String> {
    let root = docker::container_env_value(container, DEV_ROOT_ENV)?;
    if !std::path::Path::new(&root).join(DEV_BEFORE_SLEEP).is_file() {
        return None;
    }
    let ran =
        docker::run_bounded("sh", &["-lc", &dev_ask_script(&root, slug)], DEV_ASK_LIMIT).ok()?;
    held_by_checkout(ran.code, &ran.stdout)
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

/// One sandbox's line: `{"slug","slept","why"}` for `--json`, with `wakeAt` when its sleep set an alarm, else the
/// sentence a person reads. Pure.
fn line(slug: &str, slept: bool, why: &str, alarm: Option<u64>, now_ms: u64, json: bool) -> String {
    if json {
        let mut said = json!({ "slug": slug, "slept": slept, "why": why });
        if let Some(at) = alarm.filter(|_| slept) {
            said["wakeAt"] = json!(at);
        }
        return said.to_string();
    }
    match (slept, alarm) {
        (true, Some(at)) => format!(
            "{slug} is asleep. It starts again when somebody opens it, or ahead of what it has scheduled in {}.",
            crate::util::plural((at.saturating_sub(now_ms) / 60_000) as usize, "minute")
        ),
        (true, None) => format!("{slug} is asleep. It starts again when somebody opens it."),
        (false, _) => format!("{slug} stays awake: {why}."),
    }
}

fn say(slug: &str, slept: bool, why: &str, alarm: Option<u64>, json: bool) {
    let said = line(slug, slept, why, alarm, now_ms(), json);
    if json {
        report::emit(&said);
    } else if slept {
        ui::done(&said);
    } else {
        ui::quiet(&said);
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
    let mut alarm = None;
    let refused = if !docker::container_exists(&container) {
        Some(crate::sandbox::missing(&slug))
    } else if let Some(why) = held_back(
        &mirror::reconcile(&slug),
        docker::container_exists(&parked_of(&slug)),
        false,
    ) {
        Some(format!("{slug} was not put to sleep: {why}."))
    } else if !inside::running(&container) {
        Some(format!(
            "{slug} is not running, so there is nothing to put to sleep."
        ))
    } else {
        // A person's sleep keeps the schedule's alarm as the keeper's does, so what it promised still comes on time; one
        // already overdue is left for the next visit rather than starting it straight back up under their hand.
        let now = now_ms();
        let signal = confirmed_signal(&container).ok_or_else(|| {
            crate::util::Fail("the daemon could not confirm its wake alarm; left awake".to_string())
        })?;
        alarm = signal.next_wake_at.filter(|at| *at > now);
        put_to_sleep(&slug, source, alarm).err().map(|fail| fail.0)
    };
    if let Some(refused) = refused {
        if json {
            say(&slug, false, &refused, None, true);
        }
        bail!("{refused}");
    }
    say(&slug, true, "asked to sleep now", alarm, json);
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
            None => bail!(
                "{}",
                ui::explain(
                    "No sandbox was put to sleep.",
                    Some("Docker could not list the sandboxes on this device."),
                    Some("ic docker prepare --dry-run"),
                )
            ),
        },
    };
    for slug in slugs {
        let (slept, why, alarm) = consider(&slug, idle_ms, source);
        say(&slug, slept, &why, alarm, json);
    }
    Ok(())
}

/// One sandbox through every reason to leave it awake, put to sleep when none holds: whether it slept, why, and the
/// alarm its sleep set.
fn consider(slug: &str, idle_ms: u64, source: Source) -> (bool, String, Option<u64>) {
    let (slept, why, alarm) = considered(slug, idle_ms, source);
    (slept, why, alarm.filter(|_| slept))
}

fn considered(slug: &str, idle_ms: u64, source: Source) -> (bool, String, Option<u64>) {
    // Only this side's own: another side's keeper runs its own sweep, and only the side that slept a sandbox asks for
    // its wakes (its record is the one that says asleep). One adopted from a silent keeper is left awake for the same
    // reason.
    match side::unattended(slug) {
        Unattended::Ours => {}
        Unattended::Theirs(keeper) => return (false, format!("kept by {}", keeper.name()), None),
        Unattended::Adopted(adoption) => {
            return (false, format!("kept by {}", adoption.from.name()), None)
        }
    }
    // Never under another ic run: an update, a backup, a person's restart.
    let _held = match lock::hold(slug, Wait::Skip) {
        Ok(Some(held)) => held,
        Ok(None) => return (false, "another ic run is working on it".to_string(), None),
        Err(fail) => return (false, fail.0, None),
    };
    let container = container_of(slug);
    if !inside::running(&container) {
        let asleep = crate::record::read(slug).is_ok_and(|record| record.asleep);
        return (
            false,
            if asleep { "asleep" } else { "not running" }.to_string(),
            None,
        );
    }
    let record = mirror::reconcile(slug);
    if let Some(why) = held_back(&record, docker::container_exists(&parked_of(slug)), true) {
        return (false, why.to_string(), None);
    }
    let signal = confirmed_signal(&container);
    let now = now_ms();
    let idle_ms = idle_limit(&record, signal, idle_ms);
    match sleep_verdict(signal, now, idle_ms, wake_lead(&record)) {
        Verdict::Awake(why) => (false, why.to_string(), None),
        Verdict::Sleep => {
            if let Some(why) = dev_checkout_holds_awake(slug, &container) {
                return (false, why, None);
            }
            // The checkout's pre-sleep hook can take a minute. Revalidate after it, so a booking made during that wait
            // replaces the alarm and work that began in it keeps the container up.
            let signal = confirmed_signal(&container);
            let now = now_ms();
            if let Verdict::Awake(why) = sleep_verdict(signal, now, idle_ms, wake_lead(&record)) {
                return (false, why.to_string(), None);
            }
            let quiet = quiet_for(signal, now);
            let _why = crate::sandbox::intent::Reason::hold(
                format!(
                    "put to sleep: no agent turn was running and it was {quiet}, past the {} limit; the next wake starts it again.",
                    crate::util::plural((idle_ms / 60_000) as usize, "minute")
                ),
                &[],
            );
            let alarm = signal.and_then(|signal| signal.next_wake_at);
            match put_to_sleep(slug, source, alarm) {
                Ok(()) => (true, quiet, alarm),
                Err(fail) => (false, format!("could not stop it: {}", fail.0), None),
            }
        }
    }
}

/// Stop it as a stop does, record it asleep with the alarm its daemon's promises set, and tell its page. The caller holds
/// its lock.
fn put_to_sleep(slug: &str, source: Source, alarm: Option<u64>) -> Result<()> {
    // Read while it still runs; a stopped container's env reads the same, so nothing hangs on the order.
    let reporter = Reporter::of(slug);
    power::sleep(slug, alarm)?;
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
/// The same, for a start ahead of the sandbox's alarm.
const WAKING_FOR_ALARM: &str = "Waking it up: something it scheduled is due";

/// Why `ic sandbox wakes` starts a sandbox: somebody opened it, or its alarm is due.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeFor {
    Visit,
    Alarm,
}

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

/// The sleeping sandboxes whose alarm is due for their start, the soonest moment first. Pure.
pub fn due_alarms(asleep: &[(String, ChannelRecord)], now_ms: u64) -> Vec<String> {
    let mut due: Vec<(u64, String)> = asleep
        .iter()
        .filter(|(_, record)| alarm_due(record, now_ms))
        .map(|(slug, record)| (record.wake_at.unwrap_or(0), slug.clone()))
        .collect();
    due.sort();
    due.into_iter().map(|(_, slug)| slug).collect()
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

/// One woken sandbox's `--json` line, with `"for":"alarm"` when its alarm woke it. Pure.
fn woke_line(slug: &str, failed: Option<&str>, why: WakeFor) -> String {
    let mut line = match failed {
        None => json!({ "slug": slug, "woke": true }),
        Some(error) => json!({ "slug": slug, "woke": false, "error": error }),
    };
    if why == WakeFor::Alarm {
        line["for"] = json!("alarm");
    }
    line.to_string()
}

/// The run's last `--json` line: how many sandboxes on this side are still asleep, which is what tells the machine
/// agent to stop polling. Pure.
fn asleep_line(count: usize) -> String {
    json!({ "asleep": count }).to_string()
}

/// What a wake from sleep leaves on the record, under its lock when nobody else holds it (a wake that cannot write it
/// only loses a measurement): how long the start took, which the next alarm's lead is measured from, and for an alarm's
/// start when it was. A start that applied a saved shape is a recreate, not the measure of a wake, and leaves the cost.
fn note_wake(slug: &str, started_at: u64, took_ms: u64, why: WakeFor, recreated: bool) {
    let Ok(Some(_held)) = lock::hold(slug, Wait::Skip) else {
        return;
    };
    let saved = mirror::reconcile(slug);
    let next = ChannelRecord {
        alarm_woke_at: (why == WakeFor::Alarm).then_some(started_at),
        wake_cost: if recreated {
            saved.wake_cost
        } else {
            Some(next_wake_cost(saved.wake_cost, took_ms))
        },
        ..saved.clone()
    };
    if next != saved && crate::record::write(slug, &next).is_ok() {
        mirror::push(slug);
    }
}

/// Starts one sleeping sandbox as a person's start would: it clears `asleep`, and it is never one the keeper's repair
/// limit counts, an alarm being its owner's own schedule rather than a repair. Answers why it did not start.
fn start_from_sleep(slug: &str, why: WakeFor) -> Option<String> {
    let recreates = crate::record::read(slug).is_ok_and(|record| record.desired.is_some());
    let started_at = now_ms();
    let clock = std::time::Instant::now();
    let failed = power::run_by(Power::Start, Some(slug.to_string()), By::Person)
        .err()
        .map(|fail| fail.0);
    if failed.is_none() {
        let took = u64::try_from(clock.elapsed().as_millis()).unwrap_or(u64::MAX);
        note_wake(slug, started_at, took, why, recreates);
    }
    failed
}

/// `ic sandbox wakes`: polled every few seconds while anything here sleeps, so it asks docker nothing at all until a
/// record says asleep, and a platform it cannot reach is nothing to wake rather than an error. Alarms come first and need
/// no platform: this machine's clock is the whole of their question.
pub fn wakes(args: WakesArgs) -> Result<()> {
    if args.json {
        ui::send_human_to_stderr();
    }
    let asleep = asleep_here();
    let alarms = due_alarms(&asleep, now_ms());
    let mut woken: Vec<(String, Option<Target>, WakeFor)> = alarms
        .iter()
        .map(|slug| (slug.clone(), None, WakeFor::Alarm))
        .collect();
    let waiting: Vec<(String, ChannelRecord)> = asleep
        .iter()
        .filter(|(slug, _)| !alarms.contains(slug))
        .cloned()
        .collect();
    for (platform, asked) in asks_of(&waiting, report::forced_platform().as_deref()) {
        let targets: Vec<Target> = asked.iter().map(|(_, target)| target.clone()).collect();
        let ids = report::wakes(&platform, &targets);
        woken.extend(
            asked
                .into_iter()
                .filter(|(_, target)| ids.contains(&target.sandbox))
                .map(|(slug, target)| (slug, Some(target), WakeFor::Visit)),
        );
    }
    // Started only for a wake: the poll that finds nothing spends nothing on it.
    let mut poster = (!woken.is_empty()).then(Poster::start);
    for (slug, target, why) in &woken {
        let reporter = match target {
            Some(target) => Some(Reporter {
                target: target.clone(),
                machine: docker::container_env_value(&container_of(slug), "HOST_LABEL")
                    .unwrap_or_else(crate::sandbox::connect::machine_label),
            }),
            None => Reporter::of(slug),
        };
        let doing = if *why == WakeFor::Alarm {
            WAKING_FOR_ALARM
        } else {
            WAKING
        };
        // Told first, so the page says who is waking it while the start runs; the poster sends it beside the start.
        if let (Some(poster), Some(reporter)) = (&poster, &reporter) {
            poster.send(
                &reporter.target,
                Stage::Fixing,
                reporter.body(args.source, Stage::Fixing, Some(doing), None, &[], false),
            );
        }
        let failed = start_from_sleep(slug, *why);
        if let (Some(poster), Some(reporter)) = (&poster, &reporter) {
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
            poster.send(&reporter.target, Stage::Done, done);
        }
        if args.json {
            report::emit(&woke_line(slug, failed.as_deref(), *why));
        } else if let Some(error) = &failed {
            ui::warn(&format!("{slug} could not be woken: {error}"));
        } else if *why == WakeFor::Alarm {
            ui::done(&format!("{slug} woke up ahead of something it scheduled."));
        } else {
            ui::done(&format!("{slug} woke up because somebody opened it."));
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
        ui::quiet(&format!(
            "Nothing to wake. {} asleep here.",
            crate::util::plural(left, "sandbox")
        ));
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
            person_at: None,
            keep_awake: false,
        }
    }

    /// The lead every verdict below is asked with: the floor, as a sandbox that has never been woken has.
    const LEAD: u64 = LEAD_FLOOR_MS;

    #[test]
    fn the_sleep_confirmation_asks_the_live_daemon_with_a_bounded_host_only_probe() {
        let signal = confirmed_signal_with("sandbox-test", |program, args, limit| {
            assert_eq!(program, "docker");
            assert_eq!(args, ["exec", "sandbox-test", "node", "-e", SLEEP_PROBE, SLEEP_SOCKET]);
            assert_eq!(limit, std::time::Duration::from_secs(12));
            Ok(docker::Bounded {
                code: Some(0), timed_out: false, stderr: String::new(),
                stdout: json!({ "liveTurns": 0, "at": NOW, "quietSince": NOW - 45 * MIN, "nextWakeAt": NOW + 60 * MIN }).to_string(),
            })
        }).expect("a fresh signal");
        assert_eq!(signal.next_wake_at, Some(NOW + 60 * MIN));
        assert_eq!(
            sleep_verdict(Some(signal), NOW, 30 * MIN, LEAD),
            Verdict::Sleep
        );
    }

    #[test]
    fn a_failed_or_partial_confirmation_never_becomes_a_sleep_without_an_alarm() {
        let valid = json!({ "liveTurns": 0, "at": NOW, "quietSince": NOW - 45 * MIN }).to_string();
        for (code, timed_out, stdout) in [
            (Some(1), false, valid.as_str()),
            (None, true, valid.as_str()),
            (Some(0), true, valid.as_str()),
            (Some(0), false, r#"{"error":"could not confirm sleep"}"#),
            (Some(0), false, ""),
            (Some(0), false, r#"{"liveTurns":0,"at":"#),
        ] {
            let signal = confirmed_signal_with("sandbox-test", |_, _, _| {
                Ok(docker::Bounded {
                    code,
                    timed_out,
                    stdout: stdout.to_string(),
                    stderr: String::new(),
                })
            });
            assert_eq!(
                sleep_verdict(signal, NOW, 30 * MIN, LEAD),
                Verdict::Awake("unreadable")
            );
        }
        let signal = confirmed_signal_with("sandbox-test", |_, _, _| {
            Err(crate::util::Fail("Docker unavailable".to_string()))
        });
        assert_eq!(
            sleep_verdict(signal, NOW, 30 * MIN, LEAD),
            Verdict::Awake("unreadable")
        );
    }

    #[test]
    fn a_sandbox_quiet_long_enough_with_nothing_due_sleeps() {
        assert_eq!(
            sleep_verdict(Some(quiet(45)), NOW, 30 * MIN, LEAD),
            Verdict::Sleep
        );
        assert_eq!(
            sleep_verdict(Some(quiet(30)), NOW, 30 * MIN, LEAD),
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
                30 * MIN,
                LEAD
            ),
            Verdict::Sleep,
            "a wake further out than the lead and the shortest sleep sets an alarm rather than holding it"
        );
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    next_wake_at: Some(NOW + 8 * MIN),
                    ..quiet(45)
                }),
                NOW,
                30 * MIN,
                LEAD
            ),
            Verdict::Sleep,
            "a moment inside the old window but past the lead and five minutes asleep sleeps with its alarm"
        );
    }

    #[test]
    fn every_reason_to_stay_awake_is_named() {
        let idle = 30 * MIN;
        assert_eq!(
            sleep_verdict(None, NOW, idle, LEAD),
            Verdict::Awake("unreadable")
        );
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    at: NOW - 3 * MIN - 1,
                    ..quiet(45)
                }),
                NOW,
                idle,
                LEAD
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
                idle,
                LEAD
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
                idle,
                LEAD
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
                idle,
                LEAD
            ),
            Verdict::Awake(NOT_QUIET)
        );
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    quiet_since: None,
                    keep_awake: true,
                    ..quiet(45)
                }),
                NOW,
                idle,
                LEAD
            ),
            Verdict::Awake(KEPT_AWAKE),
            "sleep switched off is named rather than read as a daemon that never went quiet"
        );
        assert_eq!(
            sleep_verdict(Some(quiet(29)), NOW, idle, LEAD),
            Verdict::Awake("not quiet long enough")
        );
        assert_eq!(
            sleep_verdict(
                Some(WorkSignal {
                    quiet_since: Some(NOW + MIN),
                    ..quiet(0)
                }),
                NOW,
                idle,
                LEAD
            ),
            Verdict::Awake("not quiet long enough"),
            "a quiet stamp from the future is no quiet yet"
        );
        for due in [NOW + LEAD + MIN_ASLEEP_MS, NOW + MIN, NOW - MIN] {
            assert_eq!(
                sleep_verdict(
                    Some(WorkSignal {
                        next_wake_at: Some(due),
                        ..quiet(45)
                    }),
                    NOW,
                    idle,
                    LEAD
                ),
                Verdict::Awake("a wake is due"),
                "{due}"
            );
        }
    }

    #[test]
    fn only_the_checkouts_exit_75_holds_a_dev_sandbox_awake_and_its_last_line_says_why() {
        assert_eq!(
            held_by_checkout(
                Some(75),
                "intentic: reading\nits image lacks mediaplex 1.0.0\n\n"
            ),
            Some("its image lacks mediaplex 1.0.0".to_string())
        );
        assert_eq!(
            held_by_checkout(Some(75), ""),
            Some("its dev checkout asked".to_string())
        );
        // A checkout that says sleep, fails, or never answered: it sleeps as before.
        for code in [Some(0), Some(1), Some(2), None] {
            assert_eq!(
                held_by_checkout(code, "its image lacks x 1"),
                None,
                "{code:?}"
            );
        }
    }

    #[test]
    fn the_dev_ask_quotes_the_checkout_and_the_slug_for_the_shell() {
        assert_eq!(
            dev_ask_script("/home/ada/it's here", "sandbox-0123456789ab"),
            "cd '/home/ada/it'\\''s here' && exec node _sandbox/sandbox/scripts/dev-before-sleep.mjs 'sandbox-0123456789ab'"
        );
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
            None,
            NOW,
            true,
        ))
        .expect("JSON");
        assert_eq!(
            slept,
            json!({ "slug": "sandbox-0123456789ab", "slept": true, "why": "quiet for 40 minutes" })
        );
        assert_eq!(
            line("sandbox-0123456789ab", true, "x", None, NOW, false),
            "sandbox-0123456789ab is asleep. It starts again when somebody opens it."
        );
        assert_eq!(
            line("work", false, "busy", Some(NOW + 9 * MIN), NOW, false),
            "work stays awake: busy."
        );
        assert_eq!(
            line("nightly", true, "x", Some(NOW + 47 * MIN), NOW, false),
            "nightly is asleep. It starts again when somebody opens it, or ahead of what it has scheduled in 47 minutes."
        );
        assert_eq!(
            serde_json::from_str::<Value>(&line(
                "nightly",
                true,
                "quiet",
                Some(NOW + MIN),
                NOW,
                true
            ))
            .expect("JSON"),
            json!({ "slug": "nightly", "slept": true, "why": "quiet", "wakeAt": NOW + MIN })
        );
        assert_eq!(quiet_for(Some(quiet(40)), NOW), "quiet for 40 minutes");
        assert_eq!(quiet_for(Some(quiet(1)), NOW), "quiet for 1 minute");
        assert_eq!(
            serde_json::from_str::<Value>(&woke_line("s", None, WakeFor::Visit)).expect("JSON"),
            json!({ "slug": "s", "woke": true })
        );
        assert_eq!(
            serde_json::from_str::<Value>(&woke_line(
                "s",
                Some("no such container"),
                WakeFor::Visit
            ))
            .expect("JSON"),
            json!({ "slug": "s", "woke": false, "error": "no such container" })
        );
        assert_eq!(
            serde_json::from_str::<Value>(&woke_line("s", None, WakeFor::Alarm)).expect("JSON"),
            json!({ "slug": "s", "woke": true, "for": "alarm" })
        );
        assert_eq!(asleep_line(2), r#"{"asleep":2}"#);
    }

    #[test]
    fn the_lead_is_twice_what_wakes_took_plus_the_boot_within_its_bounds() {
        let measured = |cost: Option<u64>| ChannelRecord {
            wake_cost: cost,
            ..ChannelRecord::default()
        };
        assert_eq!(
            wake_lead(&measured(None)),
            LEAD_FLOOR_MS,
            "never woken: the floor"
        );
        assert_eq!(
            wake_lead(&measured(Some(3_000))),
            LEAD_FLOOR_MS,
            "a quick start: still the floor"
        );
        assert_eq!(
            wake_lead(&measured(Some(90_000))),
            240_000,
            "twice the cost and the boot"
        );
        assert_eq!(
            wake_lead(&measured(Some(3_600_000))),
            LEAD_CEILING_MS,
            "never past the ceiling"
        );
        let reshaping = ChannelRecord {
            desired: Some(crate::shape::Shape::default()),
            ..measured(Some(3_000))
        };
        assert_eq!(
            wake_lead(&reshaping),
            LEAD_CEILING_MS,
            "a start that recreates gets all of it"
        );
    }

    #[test]
    fn a_slow_wake_lengthens_the_cost_at_once_and_fades_over_the_next() {
        assert_eq!(next_wake_cost(None, 4_000), 4_000);
        assert_eq!(next_wake_cost(Some(4_000), 60_000), 60_000);
        assert_eq!(next_wake_cost(Some(60_000), 4_000), 45_000);
        assert_eq!(next_wake_cost(Some(45_000), 4_000), 33_750);
    }

    #[test]
    fn an_alarm_is_due_its_lead_ahead_and_stays_due_once_passed() {
        let alarmed = |at: u64| ChannelRecord {
            asleep: true,
            wake_at: Some(at),
            ..ChannelRecord::default()
        };
        assert!(!alarm_due(&alarmed(NOW + LEAD + 1), NOW));
        assert!(alarm_due(&alarmed(NOW + LEAD), NOW));
        assert!(
            alarm_due(&alarmed(NOW - 60 * MIN), NOW),
            "a moment passed while it slept still wakes it"
        );
        assert!(
            !alarm_due(
                &ChannelRecord {
                    asleep: false,
                    ..alarmed(NOW)
                },
                NOW
            ),
            "only a sleeper"
        );
        assert!(
            !alarm_due(
                &ChannelRecord {
                    held: true,
                    ..alarmed(NOW)
                },
                NOW
            ),
            "never one stopped on purpose"
        );
        assert!(
            !alarm_due(
                &ChannelRecord {
                    asleep: true,
                    ..ChannelRecord::default()
                },
                NOW
            ),
            "no alarm, no wake"
        );
        let asleep = vec![
            ("later".to_string(), alarmed(NOW - MIN)),
            (
                "none".to_string(),
                ChannelRecord {
                    asleep: true,
                    ..ChannelRecord::default()
                },
            ),
            ("sooner".to_string(), alarmed(NOW - 5 * MIN)),
            ("far".to_string(), alarmed(NOW + 60 * MIN)),
        ];
        assert_eq!(
            due_alarms(&asleep, NOW),
            vec!["sooner".to_string(), "later".to_string()]
        );
    }

    #[test]
    fn a_sandbox_the_alarm_woke_and_nobody_used_since_sleeps_after_the_short_grace() {
        let woke = ChannelRecord {
            alarm_woke_at: Some(NOW - 20 * MIN),
            ..ChannelRecord::default()
        };
        let person = |at: Option<u64>| {
            Some(WorkSignal {
                person_at: at,
                ..quiet(6)
            })
        };
        assert_eq!(idle_limit(&woke, person(Some(0)), 30 * MIN), ALARM_GRACE_MS);
        assert_eq!(
            idle_limit(&woke, person(Some(NOW - 30 * MIN)), 30 * MIN),
            ALARM_GRACE_MS,
            "a person before the wake is the boot before"
        );
        assert_eq!(
            idle_limit(&woke, person(Some(NOW - 10 * MIN)), 30 * MIN),
            30 * MIN,
            "a person since: the keeper's limit"
        );
        assert_eq!(
            idle_limit(&woke, person(None), 30 * MIN),
            30 * MIN,
            "a daemon that does not say: the keeper's limit"
        );
        assert_eq!(
            idle_limit(&ChannelRecord::default(), person(Some(0)), 30 * MIN),
            30 * MIN,
            "woken by a person"
        );
        assert_eq!(
            idle_limit(&woke, person(Some(0)), 2 * MIN),
            2 * MIN,
            "never longer than the keeper asked"
        );
        assert_eq!(
            sleep_verdict(
                person(Some(0)),
                NOW,
                idle_limit(&woke, person(Some(0)), 30 * MIN),
                LEAD
            ),
            Verdict::Sleep,
            "quiet six minutes after the scheduled work: asleep again"
        );
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
