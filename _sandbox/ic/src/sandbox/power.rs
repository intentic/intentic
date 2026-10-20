use std::time::Duration;

use serde_json::Value;

use crate::docker;
use crate::record;
use crate::sandbox::intent::{self, Action};
use crate::sandbox::recreate::{self, Preflight};
use crate::sandbox::{
    container_of, desired, ledger, lock, mirror, parked_of, probation, resolve_slug, resume,
    CONTAINER_PREFIX, TUNNEL_PREFIX,
};
use crate::shape::Ask;
use crate::ui;
use crate::util::{bail, Result};

/* `ic sandbox start|stop|restart` — a sandbox's power, and the one door every restart goes through, so the shape saved for the next restart is applied whichever button asked. */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Power {
    Start,
    Stop,
    Restart,
}

impl Power {
    fn verb(self) -> &'static str {
        match self {
            Power::Start => "start",
            Power::Stop => "stop",
            Power::Restart => "restart",
        }
    }

    /// The action's live line, in the present tense.
    fn acting(self) -> &'static str {
        match self {
            Power::Start => "Starting",
            Power::Stop => "Stopping",
            Power::Restart => "Restarting",
        }
    }

    /// The past tense its verdict settles on.
    fn done(self) -> &'static str {
        match self {
            Power::Start => "started",
            Power::Stop => "stopped",
            Power::Restart => "restarted",
        }
    }
}

/// The verdict a power change settles on: `intentic: <slug> stopped.` in a log, as it always was.
fn verdict(slug: &str, power: Power, tunnel: bool) -> String {
    format!(
        "{slug} {}{}.",
        power.done(),
        if tunnel { ", with its tunnel" } else { "" }
    )
}

/// The command a reader wants after a power change: the way back.
fn afterwards(slug: &str, power: Power) -> Vec<(String, String)> {
    match power {
        Power::Stop => vec![("start it".to_string(), format!("ic sandbox start {slug}"))],
        Power::Start | Power::Restart => {
            vec![(
                "check on it".to_string(),
                format!("ic sandbox doctor {slug}"),
            )]
        }
    }
}

/// Long enough for `docker stop`'s grace period plus a slow disk; a docker CLI that takes longer is a machine in
/// trouble, and the caller is a button somebody is watching.
const POWER_LIMIT: Duration = Duration::from_secs(180);

/// The order the containers are powered in: the tunnel sidecar goes wherever its sandbox goes, since a started
/// sandbox nobody can reach is not started. Stopping fells the tunnel first so nothing routes into a container on
/// its way down; starting raises it last. Pure, so the order is asserted without a daemon.
fn order(power: Power, container: &str, sidecar: Option<&str>) -> Vec<String> {
    let mut order: Vec<String> = vec![container.to_string()];
    if let Some(sidecar) = sidecar {
        if power == Power::Stop {
            order.insert(0, sidecar.to_string());
        } else {
            order.push(sidecar.to_string());
        }
    }
    order
}

/// Who asked: a person (a terminal, the desktop app, the machine agent relaying a button), or the keeper's own repair.
/// Only the keeper's restarts count toward the ledger's limit on automatic ones (ledger.rs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum By {
    Person,
    Keeper,
}

pub fn run(power: Power, slug: Option<String>) -> Result<()> {
    run_by(power, slug, By::Person)
}

pub fn run_by(power: Power, slug: Option<String>, by: By) -> Result<()> {
    run_by_reading(power, slug, by, |_| {})
}

/// `run_by`, handing `read` the sandbox's env (NUL-framed, as `docker::container_env_nul` reads it; None when docker
/// would not say) as soon as the look before the change has read it, before anything is started: what lets
/// `ic sandbox wakes` name who is waking a sandbox without asking docker for its env again (sleep.rs). Not called when
/// the change stops before it reads the container (docker down, the lock, no such sandbox).
pub(crate) fn run_by_reading(
    power: Power,
    slug: Option<String>,
    by: By,
    read: impl FnOnce(Option<&str>),
) -> Result<()> {
    docker::require_daemon()?;
    let slug = resolve_slug(slug, &format!("ic sandbox {}", power.verb()))?;
    let _held = lock::hold_for_person(&slug)?;
    let container = format!("{CONTAINER_PREFIX}{slug}");
    let tunnel = format!("{TUNNEL_PREFIX}{slug}");
    let mut found = look(&container, &tunnel);
    let exists = match &found {
        Some(found) => found.sandbox.is_some(),
        None => docker::container_exists(&container),
    };
    if !exists {
        // An interrupted swap parked the sandbox with no replacement: starting it IS putting it back.
        if power != Power::Stop && docker::container_exists(&parked_of(&slug)) {
            probation::watch_one(&slug)?;
            ui::note(&format!(
                "{slug} was left set aside by an interrupted update. It is back under its own name."
            ));
            // Looked at again: what is under its own name now is the container that was parked.
            found = look(&container, &tunnel);
        } else {
            bail!("{}", crate::sandbox::missing(&slug));
        }
    }
    let inspect = found.as_ref().and_then(|found| found.sandbox.as_ref());
    let env = match &found {
        Some(_) => inspect.map(env_of),
        None => env_now(&container),
    };
    remember_key(&slug, env.as_deref());
    read(env.as_deref());
    if power != Power::Stop {
        refuse_lost_key(&slug, &container, found.as_ref())?;
    }
    let has_tunnel = match &found {
        Some(found) => found.tunnel,
        None => docker::container_exists(&tunnel),
    };
    // Optional: a sandbox reached over the owner's own proxy has none.
    let sidecar = has_tunnel.then_some(tunnel.as_str());
    desired::adopt_legacy(&slug, &container)?;

    /* A START OR RESTART WITH A SHAPE WAITING IS THE RECREATE THAT APPLIES IT: the same image, the saved shape, the same pre-flight as any swap. */
    if power != Power::Stop {
        if let Some(waiting) = record::read(&slug)?.desired {
            ui::note(&format!(
                "{slug} has a shape saved for its next restart ({}), so it is recreated with that shape.",
                waiting.describe()
            ));
            recreate::reshape(slug.clone(), Ask::default(), Preflight::Run)?;
            if let Some(sidecar) = sidecar {
                power_one("start", sidecar)?;
            }
            let kind = if power == Power::Restart {
                ledger::RESTART
            } else {
                ledger::START
            };
            ledger::note(&slug, kind, by == By::Keeper);
            ui::done(&verdict(&slug, power, sidecar.is_some()));
            ui::later(&afterwards(&slug, power));
            return Ok(());
        }
    }

    ui::act(&format!("{} {slug}", power.acting()));
    // Why it goes down, told to the sandbox before it does (intent.rs).
    match power {
        Power::Restart => intent::leave(&container, Action::Restart, &asked(power, by)),
        Power::Stop => intent::leave(&container, Action::Stop, &asked(power, by)),
        Power::Start => false,
    };
    // The turns a restart cuts are picked up again by the daemon's next boot (resume.rs).
    if power == Power::Restart && resume::ask(&container) {
        ui::note(&format!(
            "{slug}'s agents pick up the turns this restart cuts once it is back."
        ));
    }
    /* NOTED BEFORE IT IS MADE: the ledger's moment then falls before the daemon start it causes, which is how the
    probation watch tells a start made through ic from a crash (probation.rs restarts_seen). A start or restart docker
    refuses still counts as one tried. */
    match power {
        Power::Restart => note(&slug, &container, inspect, power, ledger::RESTART, by),
        Power::Start => note(&slug, &container, inspect, power, ledger::START, by),
        Power::Stop => {}
    }
    power_all(power, &container, sidecar)?;
    rest(
        &slug,
        if power == Power::Stop {
            Rest::Held
        } else {
            Rest::Awake
        },
    );
    ui::done(&verdict(&slug, power, sidecar.is_some()));
    ui::later(&afterwards(&slug, power));
    Ok(())
}

/// What a power change says of itself in the sandbox's restart intent when its caller gave no reason of its own. Pure.
fn asked(power: Power, by: By) -> String {
    match by {
        By::Person => format!(
            "`ic sandbox {}` was run on this device (a terminal, the desktop app, or a button relayed by the machine agent).",
            power.verb()
        ),
        By::Keeper => format!("the keeper's repair chose to {} it.", power.verb()),
    }
}

/* ONE LOOK BEFORE A POWER CHANGE (2026-10-19). A start asked docker four separate questions about the same two
containers before anything started: does the sandbox exist, its env (for the report key), its whole inspect (for a lost
key), and does the legacy tunnel sidecar exist. ic no longer creates that sidecar, so on every machine set up since it is
a name docker does not have. Each question is a docker CLI call, and on rog (Docker Desktop) each one cost between 90 and
510 ms, measured. `docker inspect --type container <sandbox> <tunnel>` answers all
four in one call: docker prints every container it found as one JSON array and names the rest on stderr (exiting 1), so
the sandbox's own object carries its existence, its `.Config.Env` and its mounts, and the sidecar exists when it is
among them. `--type container` asks after nothing but containers, which is all either name ever is: an untyped inspect
of a missing name goes on to ask after an image, a network and a volume of that name too (twice the time of a typed one,
measured on docker 29). An answer that is not a JSON array (a docker that timed out, a CLI that printed nothing) is
asked the old way, one question at a time. */

/// What the look found: the sandbox container's own inspect object, and whether the tunnel sidecar exists.
#[derive(Clone, Debug, PartialEq)]
struct Found {
    sandbox: Option<Value>,
    tunnel: bool,
}

/// The look; None when docker's answer does not read, so the caller asks the old way.
fn look(container: &str, tunnel: &str) -> Option<Found> {
    let ran = docker::capture_bounded(
        &["inspect", "--type", "container", container, tunnel],
        docker::READ_LIMIT,
    )
    .ok()?;
    if ran.timed_out {
        return None;
    }
    found_of(&ran.stdout, container, tunnel)
}

/// The look's stdout read, whatever docker exited with (it exits 1 for a name it did not find, after printing the
/// rest). None for anything but a JSON array. Pure.
fn found_of(stdout: &str, container: &str, tunnel: &str) -> Option<Found> {
    let objects: Vec<Value> = serde_json::from_str(stdout.trim()).ok()?;
    let named = |name: &str| {
        objects
            .iter()
            .find(|object| {
                object["Name"]
                    .as_str()
                    .is_some_and(|named| named.trim_start_matches('/') == name)
            })
            .cloned()
    };
    Some(Found {
        sandbox: named(container),
        tunnel: named(tunnel).is_some(),
    })
}

/// A container's env out of its inspect object, NUL-framed the way `docker::container_env_nul` reads it. Pure.
fn env_of(inspect: &Value) -> String {
    inspect["Config"]["Env"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|pair| format!("{pair}\0"))
        .collect()
}

/// The env asked on its own, for a look that did not read.
fn env_now(container: &str) -> Option<String> {
    docker::ask(
        &[
            "inspect",
            "--format",
            "{{range .Config.Env}}{{.}}{{printf \"\\x00\"}}{{end}}",
            container,
        ],
        docker::READ_LIMIT,
    )
    .said()
}

/// A start that would only end in docker's "not a directory" mount error, refused with what it means and the way on:
/// the key its stores are encrypted with is gone (at_rest.rs lost_key), so neither a start nor the recreate a saved
/// shape asks for can bring it up. Read off the look where there was one, else asked. An inspect that answers nothing
/// leaves the start to say what docker says.
fn refuse_lost_key(slug: &str, container: &str, found: Option<&Found>) -> Result<()> {
    let inspect = match found {
        Some(found) => found.sandbox.clone(),
        None => docker::inspect(container, "{{json .}}")
            .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
    };
    let Some(inspect) = inspect else {
        return Ok(());
    };
    match crate::sandbox::at_rest::lost_key(&inspect) {
        Some(key) => bail!("{}", crate::sandbox::at_rest::lost_key_message(slug, &key)),
        None => Ok(()),
    }
}

/// The report key rides on the env a verb can read now, for a later `ic sandbox fix` that cannot.
fn remember_key(slug: &str, env: Option<&str>) {
    if let Some(env) = env {
        crate::sandbox::fix::report::remember_from_env(slug, env.as_bytes());
    }
}

/// A start's or restart's note in the ledger, on the container the look found, so the ledger need not ask again which
/// container holds the volume (ledger.rs `note_on`). A start also takes whether it runs from the look, a moment ago under
/// the lock with nothing in between; a restart, which tells the sandbox why and asks it to resume its turns first, asks
/// again. Without a look, the note asks everything itself, as it always did.
fn note(slug: &str, container: &str, inspect: Option<&Value>, power: Power, kind: &str, by: By) {
    let auto = by == By::Keeper;
    match inspect {
        Some(inspect) => {
            let running = (power == Power::Start)
                .then(|| inspect["State"]["Running"].as_bool())
                .flatten();
            ledger::note_on(container, running, kind, auto);
        }
        None => ledger::note(slug, kind, auto),
    }
}

/// Every container is tried, in `order`, and what refused is said after: a tunnel that would not stop must not leave
/// the sandbox itself running.
fn power_all(power: Power, container: &str, sidecar: Option<&str>) -> Result<()> {
    let refused: Vec<String> = order(power, container, sidecar)
        .iter()
        .filter_map(|name| power_one(power.verb(), name).err().map(|err| err.0))
        .collect();
    if !refused.is_empty() {
        bail!("{}", refused.join("\n       "));
    }
    Ok(())
}

/* ASLEEP, NOT STOPPED. `ic sandbox sleep` takes the containers down exactly as a stop does (through Docker's API, so the
`unless-stopped` policy leaves them down, the tunnel first), but nobody decided the sandbox should stay down: the next
wake starts it again (sleep.rs), and the fix engine reads it as well rather than as a stop to ask about. Not a repair
the keeper's restart limit counts (ledger.rs SLEEP). The caller holds the sandbox's lock and has seen it running.
Answers whether a tunnel sidecar went down with it. */
pub(crate) fn sleep(slug: &str, alarm: Option<u64>) -> Result<bool> {
    let container = container_of(slug);
    remember_key(slug, env_now(&container).as_deref());
    let tunnel = format!("{TUNNEL_PREFIX}{slug}");
    let sidecar = docker::container_exists(&tunnel).then_some(tunnel.as_str());
    // Noted while it still runs, so the moment is the container's own clock (inside.rs).
    ledger::note(slug, ledger::SLEEP, false);
    intent::leave(
        &container,
        Action::Stop,
        "put to sleep: nothing was working in it and it had been quiet past the idle limit; the next wake starts it again.",
    );
    power_all(Power::Stop, &container, sidecar)?;
    settle(slug, Rest::Asleep, alarm);
    Ok(sidecar.is_some())
}

/// How a sandbox stands, as its record says: running or meant to (`Awake`), stopped on purpose (`Held`), or put to
/// sleep for idleness (`Asleep`). The two down states never stand together.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rest {
    Awake,
    Held,
    Asleep,
}

impl Rest {
    /// The record's `held` and `asleep`. Pure.
    fn flags(self) -> (bool, bool) {
        match self {
            Rest::Awake => (false, false),
            Rest::Held => (true, false),
            Rest::Asleep => (false, true),
        }
    }
}

/* STOPPED ON PURPOSE. A stop through ic is the owner's decision, and `ic sandbox fix` (the machine agent's `--auto`
among its callers) must never undo it unasked; a start or restart through ic is the decision reversed. Read through
the mirror first, so a stale record on this side is never stamped as the newest. A stop a person made outside ic
(Docker Desktop's Stop button) is recorded here too once the fix engine has seen it (fix/chain.rs), and a sandbox found
running again is the decision reversed — a sleep's as much as a stop's. */
pub(crate) fn rest(slug: &str, rest: Rest) {
    settle(slug, rest, None);
}

/// `rest`, with the alarm a sleep sets (sleep.rs). Any other change of rest clears the alarm, and the mark of a start
/// made for one: a sandbox started, stopped or put to sleep again is past that alarm.
fn settle(slug: &str, rest: Rest, alarm: Option<u64>) {
    let Some(next) = settled(&mirror::reconcile(slug), rest, alarm) else {
        return;
    };
    if record::write(slug, &next).is_ok() {
        mirror::push(slug);
    }
}

/// The record a change of rest leaves, None when it leaves the record as it is. Pure.
fn settled(
    saved: &record::ChannelRecord,
    rest: Rest,
    alarm: Option<u64>,
) -> Option<record::ChannelRecord> {
    let (held, asleep) = rest.flags();
    let alarm = alarm.filter(|_| asleep);
    if saved.held == held && saved.asleep == asleep && saved.wake_at == alarm {
        return None;
    }
    Some(record::ChannelRecord {
        held,
        asleep,
        wake_at: alarm,
        alarm_woke_at: None,
        ..saved.clone()
    })
}

/* NO LONGER ASLEEP, WITH NOTHING TO WAKE (2026-10-19). A record that says asleep keeps `ic sandbox wakes` asking the
platform about its sandbox, and the machine agent polling, for as long as it says so. A sandbox that went to the trash
(trash.rs stash) or is gone from the engine altogether (sleep.rs, records an older ic left) can be woken by nothing, so
its record stops saying asleep: the write a start's `rest` makes, on the record in this home. Nothing is pushed to the
sandbox's volume, which no live container holds any more (the trash reconciles while one still does). A restore starts
the sandbox anyway. The caller holds the sandbox's lock. Answers whether the record changed. */
pub(crate) fn forget_sleep(slug: &str) -> bool {
    let Ok(saved) = record::read(slug) else {
        return false;
    };
    if !saved.asleep {
        return false;
    }
    settled(&saved, Rest::Awake, None).is_some_and(|next| record::write(slug, &next).is_ok())
}

fn power_one(verb: &str, name: &str) -> Result<()> {
    let ran = docker::capture_bounded(&[verb, name], POWER_LIMIT)?;
    if ran.timed_out {
        bail!(
            "{}",
            ui::explain(
                &format!(
                    "docker {verb} {name} did not finish within {}s.",
                    POWER_LIMIT.as_secs()
                ),
                Some("Docker on this device is not answering in time."),
                Some("restart Docker, then run the same command again."),
            )
        );
    }
    if ran.code != Some(0) {
        bail!("docker {verb} {name} failed: {}", ran.stderr);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sandbox_is_held_or_asleep_never_both() {
        assert_eq!(Rest::Awake.flags(), (false, false));
        assert_eq!(Rest::Held.flags(), (true, false));
        assert_eq!(Rest::Asleep.flags(), (false, true));
    }

    #[test]
    fn a_change_of_rest_rewrites_the_record_only_when_it_changes_it() {
        let asleep = record::ChannelRecord {
            asleep: true,
            wake_at: Some(9),
            alarm_woke_at: Some(3),
            wake_cost: Some(2_176),
            report_key: Some("k".to_string()),
            ..record::ChannelRecord::default()
        };
        let woken = settled(&asleep, Rest::Awake, None).expect("a sleeper woken changes");
        assert_eq!(
            (woken.held, woken.asleep, woken.wake_at, woken.alarm_woke_at),
            (false, false, None, None)
        );
        assert_eq!(
            (woken.wake_cost, woken.report_key.as_deref()),
            (Some(2_176), Some("k")),
            "everything else stays"
        );
        assert_eq!(settled(&woken, Rest::Awake, None), None);
        let slept = settled(&woken, Rest::Asleep, Some(42)).expect("a sleep changes");
        assert_eq!((slept.asleep, slept.wake_at), (true, Some(42)));
        assert_eq!(
            settled(&woken, Rest::Held, Some(42)).map(|held| (held.held, held.wake_at)),
            Some((true, None)),
            "only a sleep keeps an alarm"
        );
    }

    #[test]
    fn one_look_answers_whether_the_sandbox_and_its_tunnel_exist_with_the_sandboxs_own_inspect() {
        let container = "intentic-sandbox-sandbox-0123456789ab";
        let tunnel = "intentic-sandbox-tunnel-sandbox-0123456789ab";
        // What docker prints for `inspect --type container <sandbox> <tunnel>` when only the sandbox exists (exit 1,
        // "No such container" on stderr).
        let sandbox = serde_json::json!({
            "Name": format!("/{container}"),
            "State": { "Running": false },
            "Config": { "Env": ["CONNECT_TOKEN=t", "HOST_LABEL=rog", "PATH=/bin"] },
            "Mounts": [],
        });
        let alone = serde_json::to_string_pretty(&serde_json::json!([sandbox])).unwrap();
        let found = found_of(&alone, container, tunnel).expect("an array reads");
        assert_eq!(found.sandbox.as_ref(), Some(&sandbox));
        assert!(!found.tunnel);
        assert_eq!(
            env_of(found.sandbox.as_ref().unwrap()),
            "CONNECT_TOKEN=t\0HOST_LABEL=rog\0PATH=/bin\0",
            "framed as container_env_nul frames it"
        );
        assert_eq!(
            crate::sandbox::fix::chain::Env::parse(&env_of(&sandbox))
                .host_label
                .as_deref(),
            Some("rog")
        );
        let both =
            serde_json::json!([sandbox, { "Name": format!("/{tunnel}"), "Config": { "Env": [] } }]);
        let found = found_of(&both.to_string(), container, tunnel).expect("an array reads");
        assert!(found.sandbox.is_some() && found.tunnel);
        // Only the tunnel: the sandbox is missing, whatever else docker found.
        let found = found_of(
            &serde_json::json!([{ "Name": format!("/{tunnel}") }]).to_string(),
            container,
            tunnel,
        )
        .expect("an array reads");
        assert_eq!((found.sandbox, found.tunnel), (None, true));
        assert_eq!(
            found_of("[]\n", container, tunnel),
            Some(Found {
                sandbox: None,
                tunnel: false
            }),
            "neither exists"
        );
        // Nothing that reads: the old questions are asked instead.
        for said in [
            "",
            "Cannot connect to the Docker daemon",
            "{\"Name\":\"x\"}",
        ] {
            assert_eq!(found_of(said, container, tunnel), None, "{said}");
        }
        assert_eq!(env_of(&serde_json::json!({})), "");
    }

    #[test]
    fn the_tunnel_falls_first_and_rises_last() {
        let sidecar = Some("intentic-sandbox-tunnel-work");
        assert_eq!(
            order(Power::Stop, "intentic-sandbox-work", sidecar),
            vec!["intentic-sandbox-tunnel-work", "intentic-sandbox-work"]
        );
        for power in [Power::Start, Power::Restart] {
            assert_eq!(
                order(power, "intentic-sandbox-work", sidecar),
                vec!["intentic-sandbox-work", "intentic-sandbox-tunnel-work"]
            );
        }
        assert_eq!(
            order(Power::Restart, "intentic-sandbox-work", None),
            vec!["intentic-sandbox-work"]
        );
    }
}
