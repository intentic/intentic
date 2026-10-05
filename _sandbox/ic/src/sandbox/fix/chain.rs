use std::time::Duration;

use serde_json::Value;

use super::clock;
use super::model::{Check, Fix, Repair, CONTAINER, DAEMON, REGISTRATION, TUNNEL};
use crate::docker::{self, Asked};
use crate::record::{ChannelRecord, Phase};
use crate::sandbox::ledger::{self, Ledger};
use crate::sandbox::side::Side;
use crate::sandbox::{container_of, parked_of, TUNNEL_PREFIX};

/* ONE SANDBOX'S OWN LINKS — container, daemon, registration, and its public address from outside. Gathered through
docker with a deadline on every call, read by the pure functions below. */

/// What the container's own env says: the run that created it is the only record of what it was given, and it
/// answers for a stopped container too.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Env {
    pub token: Option<String>,
    pub platform: Option<String>,
    pub public_url: Option<String>,
    pub grant: Option<String>,
    pub ingress: Option<String>,
    pub host_label: Option<String>,
    /// Which side of this computer created it: `windows` for ic on Windows, `linux` for ic in WSL or on Linux. One
    /// Docker Desktop engine serves both sides, so both see every container.
    pub host_platform: Option<String>,
    /// The environment of that side: `windows`, a WSL distro's name, `linux`, `macos` (side.rs). Absent on a container
    /// from before it was stamped.
    pub host_env: Option<String>,
}

impl Env {
    /// Off `KEY=value` pairs, NUL-framed as docker::container_env_nul reads them. Empty values read as absent. Pure.
    pub fn parse(nul_framed: &str) -> Env {
        let value = |name: &str| {
            nul_framed
                .split('\0')
                .find_map(|pair| pair.strip_prefix(&format!("{name}=")).map(str::to_string))
                .filter(|value| !value.is_empty())
        };
        Env {
            token: value("CONNECT_TOKEN"),
            platform: value("PLATFORM_URL"),
            public_url: value("SANDBOX_PUBLIC_URL"),
            grant: value("SANDBOX_GRANT"),
            ingress: value("INGRESS_URL"),
            host_label: value("HOST_LABEL"),
            host_platform: value("HOST_PLATFORM"),
            host_env: value("HOST_ENV"),
        }
    }

    /// The side that created the container, when it says. Pure.
    pub fn side(&self) -> Option<Side> {
        self.host_platform
            .as_deref()
            .map(|platform| Side::new(platform, self.host_env.as_deref()))
    }
}

/// The container, as `docker inspect` describes it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Inspected {
    /// running, exited, created, restarting, paused, dead.
    pub status: String,
    pub restarting: bool,
    pub restarts: u64,
    /// The kernel stopped it for running out of memory.
    pub oom: bool,
    pub exit_code: i64,
    pub started_ms: Option<u64>,
    /// The memory cap docker enforces, in bytes; 0 for none.
    pub memory: u64,
    /// Docker's own restart policy for it (`unless-stopped`, the run contract's); empty when an older reading had none.
    pub restart_policy: String,
    /// When it last stopped.
    pub finished_ms: Option<u64>,
}

/// The inspect format [`Inspected::parse`] reads: one line, `|`-separated.
pub const INSPECT: &str = "{{.State.Status}}|{{.State.Restarting}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.HostConfig.Memory}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.FinishedAt}}";

impl Inspected {
    /// Pure.
    pub fn parse(line: &str) -> Option<Inspected> {
        let fields: Vec<&str> = line.trim().split('|').collect();
        if fields.len() < 7 {
            return None;
        }
        Some(Inspected {
            status: fields[0].to_string(),
            restarting: fields[1] == "true",
            restarts: fields[2].parse().unwrap_or(0),
            oom: fields[3] == "true",
            exit_code: fields[4].parse().unwrap_or(0),
            started_ms: clock::rfc3339_ms(fields[5]),
            memory: fields[6].parse().unwrap_or(0),
            restart_policy: fields
                .get(7)
                .map(|policy| policy.to_string())
                .unwrap_or_default(),
            finished_ms: fields.get(8).and_then(|at| clock::rfc3339_ms(at)),
        })
    }

    pub fn running(&self) -> bool {
        self.status == "running" && !self.restarting
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Container {
    /// Docker did not answer about it.
    Unknown,
    /// No container of that name; `parked` when an interrupted swap left it under its parked name.
    Missing {
        parked: bool,
    },
    Present(Inspected),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Health {
    NotAsked,
    /// The daemon did not answer /health.
    Silent,
    Answered(Value),
}

/// The public address, probed from this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Public {
    NotAsked,
    /// Its name does not resolve from here.
    Dns(String),
    /// An HTTP answer, with the edge's `x-intentic-edge` verdict when it gave one.
    Answered {
        status: u16,
        edge: Option<String>,
    },
    Unreachable(String),
}

pub struct ChainFacts {
    pub slug: String,
    pub record: ChannelRecord,
    pub env: Env,
    pub container: Container,
    /// The tunnel sidecar an older setup runs beside the sandbox: None when there is none.
    pub sidecar_running: Option<bool>,
    /// The kernel stopped this container for memory at some point in this run (sticky: a start clears the flag).
    pub oom_seen: bool,
    pub health: Health,
    /// What the daemon wrote to /history/boot-failure.json since the container last started.
    pub boot_failure: Option<String>,
    /// The memory the engine has, in bytes (for a raise after an OOM kill).
    pub engine_memory: Option<u64>,
    pub public: Public,
    /// How many agent turns run inside, from the daemon's work signal; None when it does not say, or said it too long
    /// ago to be believed.
    pub live_turns: Option<u32>,
    pub now_ms: u64,
    /// The repairs made to it through ic, off its own volume (ledger.rs).
    pub ledger: Ledger,
    /// It stands stopped because a person stopped it outside ic (see `stopped_by_person`).
    pub stopped_outside: bool,
}

/* GATHERING. */

/// How long `/health` gets from inside the container; the exec around it gets a little longer.
const HEALTH_CURL_SECS: &str = "5";
const EXEC_LIMIT: Duration = Duration::from_secs(15);

pub fn gather(slug: &str, engine_up: bool, oom_seen: bool) -> ChainFacts {
    let container = container_of(slug);
    let mut facts = ChainFacts {
        slug: slug.to_string(),
        record: if engine_up {
            crate::sandbox::mirror::reconcile(slug)
        } else {
            crate::record::read(slug).unwrap_or_default()
        },
        env: Env::default(),
        container: Container::Unknown,
        sidecar_running: None,
        oom_seen,
        health: Health::NotAsked,
        boot_failure: None,
        engine_memory: None,
        public: Public::NotAsked,
        live_turns: None,
        now_ms: crate::sandbox::now_ms(),
        ledger: Ledger::default(),
        stopped_outside: false,
    };
    if !engine_up {
        return facts;
    }
    facts.container = match docker::ask(
        &["inspect", "--format", INSPECT, &container],
        docker::READ_LIMIT,
    ) {
        Asked::Said(line) => Inspected::parse(&line).map_or(Container::Unknown, Container::Present),
        Asked::Refused(_) => Container::Missing {
            parked: matches!(
                docker::ask(
                    &["inspect", "--format", "{{.Id}}", &parked_of(slug)],
                    docker::READ_LIMIT
                ),
                Asked::Said(_)
            ),
        },
        Asked::Silent => Container::Unknown,
    };
    // The env of whichever container holds this sandbox, and the report key it yields, kept for later runs.
    let holder = match &facts.container {
        Container::Missing { parked: true } => Some(parked_of(slug)),
        Container::Present(_) => Some(container.clone()),
        _ => None,
    };
    if let Some(holder) = holder {
        if let Some(env) = docker::ask(
            &[
                "inspect",
                "--format",
                "{{range .Config.Env}}{{.}}{{printf \"\\x00\"}}{{end}}",
                &holder,
            ],
            docker::READ_LIMIT,
        )
        .said()
        {
            facts.env = Env::parse(&env);
            // The other side's sandbox gets no record here: that side keeps one (record.rs, audit 2026-10 item 18).
            super::report::remember_unless_elsewhere(
                slug,
                facts.env.token.as_deref(),
                facts.env.platform.as_deref(),
                facts.env.side().as_ref(),
            );
        }
        facts.ledger = ledger::read(&holder);
    }
    let sidecar = format!("{TUNNEL_PREFIX}{slug}");
    facts.sidecar_running = docker::ask(
        &["inspect", "--format", "{{.State.Running}}", &sidecar],
        docker::READ_LIMIT,
    )
    .said()
    .map(|running| running.trim() == "true");
    let Container::Present(state) = &facts.container else {
        return facts;
    };
    if stop_worth_asking(state) {
        facts.stopped_outside = stopped_by_person(state, stop_heard(&container, state));
    }
    facts.oom_seen |= state.oom;
    if state.running() {
        facts.health = ask_health(&container);
        if health_worth_a_second_look(&facts) {
            std::thread::sleep(SECOND_LOOK);
            facts.health = ask_health(&container);
        }
    }
    if !matches!(facts.health, Health::Answered(_)) {
        facts.boot_failure = crate::sandbox::probation::boot_failure_since(
            &container,
            state.started_ms.unwrap_or(0),
        );
    }
    if facts.oom_seen {
        facts.engine_memory =
            docker::ask(&["info", "--format", "{{.MemTotal}}"], docker::READ_LIMIT)
                .said()
                .and_then(|total| total.trim().parse().ok());
    }
    // Asked of every running daemon, answering or not (2026-10-05): one whose /health is wedged can still be running
    // turns, and a restart cuts them all the same.
    if state.running() {
        facts.live_turns = docker::ask(&["exec", &container, "cat", WORK_SIGNAL], EXEC_LIMIT)
            .said()
            .and_then(|body| live_turns(&body, facts.now_ms));
    }
    if let (Health::Answered(_), Some(url)) = (&facts.health, facts.env.public_url.clone()) {
        facts.public = probe_public(&url);
        if public_worth_a_second_look(&facts.public) {
            std::thread::sleep(SECOND_LOOK);
            facts.public = probe_public(&url);
        }
    }
    facts
}

fn ask_health(container: &str) -> Health {
    match docker::ask(
        &[
            "exec",
            container,
            "curl",
            "-sf",
            "-m",
            HEALTH_CURL_SECS,
            "http://localhost:8787/health",
        ],
        EXEC_LIMIT,
    ) {
        Asked::Said(body) => serde_json::from_str(&body).map_or(Health::Silent, Health::Answered),
        _ => Health::Silent,
    }
}

/* A SECOND LOOK BEFORE A RESTART. A daemon redials a dropped tunnel within seconds, and one busy for a moment answers
again a moment later, so one probe that lands in that gap is no reason to cut every turn the sandbox runs. A reading
that would lead to a restart is taken again after a pause, and the second one decides. */

/// The pause between the two looks: longer than a daemon takes to redial its tunnel.
const SECOND_LOOK: Duration = Duration::from_secs(20);

/// A running daemon past its start that did not answer /health. Pure.
pub fn health_worth_a_second_look(facts: &ChainFacts) -> bool {
    matches!(facts.health, Health::Silent)
        && matches!(&facts.container, Container::Present(state) if state.running())
        && up_for(facts).is_some_and(|up| up >= STARTING_MS)
}

/// An edge that answers for the address with no tunnel behind it, which is what a redial in progress looks like
/// too. Its other verdicts are not a restart's to fix. Pure.
pub fn public_worth_a_second_look(public: &Public) -> bool {
    matches!(public, Public::Answered { status: 502 | 503 | 530, edge }
        if !matches!(edge.as_deref(), Some("unknown-sandbox" | "dropped")))
}

/* THE DAEMON'S WORK SIGNAL (the daemon's workload/work-signal.ts): how many turns run, rewritten at least every minute
while it lives. A restart cuts them, so an unattended fix asks first. */

const WORK_SIGNAL: &str = "/run/intentic/work.json";
/// Older than this, the count is what a hung daemon left behind: nothing to protect, and nothing to believe.
const WORK_SIGNAL_STALE_MS: u64 = 3 * 60_000;

/// The live turns `body` says, when it says it recently enough. The container's clock is this machine's. Pure.
pub fn live_turns(body: &str, now_ms: u64) -> Option<u32> {
    let value: Value = serde_json::from_str(body.trim()).ok()?;
    let at = value.get("at")?.as_u64()?;
    if now_ms.saturating_sub(at) > WORK_SIGNAL_STALE_MS {
        return None;
    }
    value
        .get("liveTurns")?
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
}

/// The restart a broken link gets: unasked while nothing runs inside, with a yes while agents are mid-turn, and with
/// a yes once the keeper has restarted it by itself three times in two hours (ledger.rs). Every automatic restart in
/// this file goes through here (2026-10-05: the silent-daemon one did not, and cut running turns unasked). Pure.
fn restart_for(facts: &ChainFacts) -> Repair {
    if facts.live_turns.is_some_and(|n| n > 0) {
        Repair::RestartBusy
    } else if facts.ledger.restarts_exhausted(facts.now_ms).is_some() {
        Repair::RestartAgain
    } else {
        Repair::Restart
    }
}

/// Whether this run already restarted it, any way. Pure.
fn restarted(tried: &dyn Fn(&Repair) -> bool) -> bool {
    tried(&Repair::Restart) || tried(&Repair::RestartBusy) || tried(&Repair::RestartAgain)
}

/// The remedy that goes with [`restart_for`]: says what a restart would cut when it would cut something, and how
/// often the keeper has restarted it already when that is why it stopped. Pure.
fn restart_remedy(facts: &ChainFacts, what: &str) -> String {
    let slug = &facts.slug;
    if let (Some(exhausted), Repair::RestartAgain) = (
        facts.ledger.restarts_exhausted(facts.now_ms),
        restart_for(facts),
    ) {
        let back = if facts.record.previous.is_some() {
            format!("roll back (ic sandbox rollback {slug}) or look at its log (ic sandbox logs {slug})")
        } else {
            format!("look at its log (ic sandbox logs {slug})")
        };
        return format!(
            "restarted {} times since {} and it did not stay well; {back}. To restart it once more anyway: ic sandbox restart {slug}",
            exhausted.count,
            crate::util::utc_minute(exhausted.since)
        );
    }
    match facts.live_turns {
        Some(1) => format!(
            "1 agent turn is running here, and a restart cuts it: {what} once it has finished, or now: ic sandbox restart {slug}"
        ),
        Some(n) if n > 1 => format!(
            "{n} agent turns are running here, and a restart cuts them: {what} once they have finished, or now: ic sandbox restart {slug}"
        ),
        _ => format!("{what}: ic sandbox restart {slug}"),
    }
}

/// The public URL's `/health` from this machine, with the edge's own verdict header when it answered for the box.
pub fn probe_public(url: &str) -> Public {
    let Some(host) = host_of(url) else {
        return Public::NotAsked;
    };
    if let Err(why) = super::host::resolve(&host, super::host::NET_LIMIT) {
        return Public::Dns(why);
    }
    // Statuses are answers here, not errors: a 502 with its verdict header is the whole diagnosis.
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(super::host::NET_LIMIT))
        .http_status_as_error(false)
        .build()
        .new_agent();
    match agent
        .get(format!("{}/health", url.trim_end_matches('/')))
        .call()
    {
        Ok(response) => Public::Answered {
            status: response.status().as_u16(),
            edge: response
                .headers()
                .get("x-intentic-edge")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        },
        Err(err) => Public::Unreachable(err.to_string()),
    }
}

/// The URL's hostname, without a URL crate: scheme stripped, then everything before the first path or port
/// separator. Pure.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host: String = rest
        .chars()
        .take_while(|c| *c != '/' && *c != ':')
        .collect();
    (!host.is_empty()).then_some(host)
}

/* THE READINGS. `tried` answers for this sandbox's own repairs. */

/// How long a container may have been up before a daemon that does not answer counts as broken rather than
/// starting.
const STARTING_MS: u64 = 90_000;
/// How long a daemon may run without its tunnel before a restart is the fix rather than patience.
const TUNNEL_GRACE_MS: u64 = 180_000;
/// A container this restart-heavy is crash-looping, whatever its current state says.
const CRASH_LOOP_RESTARTS: u64 = 3;
/// A cutover whose heartbeat is this fresh is in progress somewhere (probation.rs's own figure).
fn cutover_alive(record: &ChannelRecord, now_ms: u64) -> bool {
    record
        .swap
        .as_ref()
        .is_some_and(|swap| crate::sandbox::probation::cutover_in_progress(swap, now_ms))
}

/// A swap is on the record: a probation, or a cutover nobody is finishing. `ic sandbox watch` owns what happens next.
fn swap_on_record(record: &ChannelRecord) -> bool {
    record.swap.is_some()
}

fn up_for(facts: &ChainFacts) -> Option<u64> {
    match &facts.container {
        Container::Present(state) => state
            .started_ms
            .map(|started| facts.now_ms.saturating_sub(started)),
        _ => None,
    }
}

/// The version before the last update, as the fix a failure that follows one gets — or the log, when there is none.
fn way_back(facts: &ChainFacts, tried: &dyn Fn(&Repair) -> bool) -> (String, Fix) {
    let slug = &facts.slug;
    if facts.record.previous.is_some() && !tried(&Repair::Rollback) {
        return (
            format!("if this began with an update, go back to the version before it: ic sandbox rollback {slug}"),
            Fix::Do(Repair::Rollback),
        );
    }
    (
        format!("read what it says: ic sandbox logs {slug} — and run the setup command from your browser again if it does not start."),
        Fix::You,
    )
}

/// The memory to raise an OOM-killed sandbox to: half again as much (at least 2 GiB more), within what the engine
/// has less a GiB for everything else. None when there is no cap to raise (the engine itself ran out) or no room. Pure.
pub fn raised_memory(cap_bytes: u64, engine_bytes: Option<u64>) -> Option<u64> {
    const GIB: u64 = 1024 * 1024 * 1024;
    if cap_bytes == 0 {
        return None;
    }
    let cap = cap_bytes.div_ceil(GIB);
    let want = (cap + 2).max((cap * 3).div_ceil(2));
    let room = engine_bytes
        .map(|total| (total / GIB).saturating_sub(1))
        .unwrap_or(want);
    let target = want.min(room);
    (target > cap).then_some(target)
}

/// The GiB to raise to, when that is still a repair to offer.
fn memory_fix(facts: &ChainFacts, tried: &dyn Fn(&Repair) -> bool) -> Option<u64> {
    let Container::Present(state) = &facts.container else {
        return None;
    };
    let gib = raised_memory(state.memory, facts.engine_memory)?;
    (!tried(&Repair::RaiseMemory(gib))).then_some(gib)
}

pub fn container(facts: &ChainFacts, engine_up: bool, tried: &dyn Fn(&Repair) -> bool) -> Check {
    let slug = &facts.slug;
    let name = container_of(slug);
    if !engine_up {
        return Check::skip(
            CONTAINER,
            "unknowable while Docker's engine does not answer",
        );
    }
    let state = match &facts.container {
        Container::Unknown => return Check::skip(CONTAINER, "docker did not answer about it"),
        Container::Missing { parked: true } => {
            return Check::fail(
                CONTAINER,
                "an interrupted update left this sandbox set aside, with nothing started in its place.",
                format!("put it back: ic sandbox start {slug}"),
                if tried(&Repair::Watch) { Fix::You } else { Fix::Do(Repair::Watch) },
            )
        }
        Container::Missing { parked: false } => {
            return Check::fail(
                CONTAINER,
                format!("there is no container named {name} on this machine."),
                "run the setup command from your browser again: it brings the sandbox back with its files.",
                Fix::You,
            )
        }
        Container::Present(state) => state,
    };
    if cutover_alive(&facts.record, facts.now_ms) {
        return Check::warn(
            CONTAINER,
            "an update of this sandbox is in progress; it finishes or undoes itself.",
        );
    }
    let oom = if state.oom || facts.oom_seen {
        " — the kernel stopped it for running out of memory"
    } else {
        ""
    };
    if state.restarting || (state.status == "running" && state.restarts >= CRASH_LOOP_RESTARTS) {
        let problem = format!(
            "the container keeps crashing ({} restarts){oom}.",
            state.restarts
        );
        if swap_on_record(&facts.record) && !tried(&Repair::Watch) {
            return Check::fail(
                CONTAINER,
                problem,
                format!("let the probation judge it: ic sandbox watch {slug}"),
                Fix::Do(Repair::Watch),
            );
        }
        if let Some(gib) = (facts.oom_seen || state.oom)
            .then(|| memory_fix(facts, tried))
            .flatten()
        {
            return Check::fail(
                CONTAINER,
                problem,
                format!("give it more memory: ic sandbox reshape {slug} --memory {gib}g"),
                Fix::Do(Repair::RaiseMemory(gib)),
            );
        }
        let (remedy, fix) = way_back(facts, tried);
        return Check::fail(CONTAINER, problem, remedy, fix);
    }
    match state.status.as_str() {
        "running" => {
            // The tunnel container an older setup ran beside the sandbox; nothing has created one since the daemon
            // dials its own tunnel (connect.rs). Stopped, it is retired rather than started again (2026-10-05): it holds
            // nothing, and starting it unasked revived a connector nothing uses.
            if facts.sidecar_running == Some(false) && !tried(&Repair::RetireSidecar) {
                return Check::warn_fix(
                    CONTAINER,
                    format!("a tunnel container from an older setup ({TUNNEL_PREFIX}{slug}) is stopped; the sandbox dials its own tunnel now and does not need it."),
                    format!("remove it: docker rm {TUNNEL_PREFIX}{slug}"),
                    Fix::Do(Repair::RetireSidecar),
                );
            }
            if facts.oom_seen {
                if let Some(gib) = memory_fix(facts, tried) {
                    return Check::warn_fix(
                        CONTAINER,
                        "it ran out of memory and the kernel stopped it; it runs again now, and will again run out.",
                        format!("give it more memory: ic sandbox reshape {slug} --memory {gib}g"),
                        Fix::Do(Repair::RaiseMemory(gib)),
                    );
                }
            }
            Check::ok(CONTAINER)
        }
        "paused" => Check::fail(
            CONTAINER,
            "the container is paused.",
            format!("restart it: ic sandbox restart {slug}"),
            Fix::You,
        ),
        status => {
            let exit = if state.exit_code != 0 {
                format!(" (exit code {})", state.exit_code)
            } else {
                String::new()
            };
            let problem = format!("the container is {status}, not running{oom}{exit}.");
            let start = format!("start it: ic sandbox start {slug}");
            if facts.record.held || facts.stopped_outside {
                let how = if facts.stopped_outside {
                    "It was stopped outside intentic (Docker Desktop's Stop button, or docker stop), so it is left for you to start."
                } else {
                    "It was stopped on purpose (ic sandbox stop)."
                };
                return Check::fail(
                    CONTAINER,
                    format!("{problem} {how}"),
                    start,
                    if tried(&Repair::StartHeld) {
                        Fix::You
                    } else {
                        Fix::Do(Repair::StartHeld)
                    },
                );
            }
            if !tried(&Repair::Start) {
                return Check::fail(CONTAINER, problem, start, Fix::Do(Repair::Start));
            }
            let (remedy, fix) = way_back(facts, tried);
            Check::fail(
                CONTAINER,
                format!("{problem} Starting it did not hold."),
                remedy,
                fix,
            )
        }
    }
}

/* STOPPED BY A PERSON, OUTSIDE ic. The run contract starts every sandbox `--restart unless-stopped`, so Docker itself
restarts one that crashed or exited, and brings back at its own start every one that was running when it went down. A
sandbox that stands Exited, not restarting, with a clean exit (0, or 143 for the SIGTERM `docker stop` sends), was
stopped through Docker's API by somebody: Docker Desktop's Stop button, `docker stop`. The keeper used to start it again
at its next sweep (audit 2026-10, class 5). The proof that the engine has been up past the stop, and so would have
restarted the container were it not a person's stop, is the engine's own event log, which holds only what happened
since the engine last started: a `stop` or `kill` of this container in it. A stop the log no longer holds reads as
unknown and the sandbox is started as before; the fix engine records a stop it did see as held (power.rs), so a later
restart of the engine does not forget it. */

/// Worth asking the engine's event log about: Exited, not restarting, under a policy that would have restarted it,
/// with the exit a stop leaves. Pure.
pub fn stop_worth_asking(state: &Inspected) -> bool {
    state.status == "exited"
        && !state.restarting
        && matches!(state.restart_policy.as_str(), "unless-stopped" | "always")
        && matches!(state.exit_code, 0 | 143)
}

/// Whether a person stopped it: worth asking, and the engine's log since its last start holds the stop. Pure.
pub fn stopped_by_person(state: &Inspected, stop_heard: bool) -> bool {
    stop_worth_asking(state) && stop_heard
}

/// Whether `docker events` lines (one action each) hold a stop or a kill. Pure.
pub fn stop_in_events(actions: &str) -> bool {
    actions
        .lines()
        .map(str::trim)
        .any(|action| action == "stop" || action == "kill" || action.starts_with("kill:"))
}

/// The engine's event log around the container's last stop, asked with an end so it answers at once.
fn stop_heard(container: &str, state: &Inspected) -> bool {
    let Some(finished) = state.finished_ms else {
        return false;
    };
    let since = (finished / 1000).saturating_sub(10).to_string();
    let until = (crate::sandbox::now_ms() / 1000 + 1).to_string();
    let filter = format!("container={container}");
    docker::ask(
        &[
            "events",
            "--since",
            &since,
            "--until",
            &until,
            "--filter",
            "type=container",
            "--filter",
            &filter,
            "--format",
            "{{.Action}}",
        ],
        docker::READ_LIMIT,
    )
    .said()
    .is_some_and(|actions| stop_in_events(&actions))
}

fn running(facts: &ChainFacts) -> bool {
    matches!(&facts.container, Container::Present(state) if state.running())
}

pub fn daemon(facts: &ChainFacts, tried: &dyn Fn(&Repair) -> bool) -> Check {
    let slug = &facts.slug;
    if !running(facts) {
        return Check::skip(DAEMON, "unknowable while the container is not running");
    }
    let health = match &facts.health {
        Health::NotAsked => return Check::skip(DAEMON, "not asked"),
        Health::Answered(health) => health,
        Health::Silent => {
            if let Some(error) = &facts.boot_failure {
                let (remedy, fix) = way_back(facts, tried);
                return Check::fail(
                    DAEMON,
                    format!("the daemon could not start: {error}"),
                    remedy,
                    fix,
                );
            }
            if up_for(facts).is_some_and(|up| up < STARTING_MS) {
                return Check::warn(
                    DAEMON,
                    "the daemon is still starting — it keeps going in the background.",
                );
            }
            if cutover_alive(&facts.record, facts.now_ms) {
                return Check::warn(
                    DAEMON,
                    "an update of this sandbox is in progress; it finishes or undoes itself.",
                );
            }
            let problem = "the daemon inside the container does not answer /health.";
            if swap_on_record(&facts.record) && !tried(&Repair::Watch) {
                return Check::fail(
                    DAEMON,
                    problem,
                    format!("let the probation judge it: ic sandbox watch {slug}"),
                    Fix::Do(Repair::Watch),
                );
            }
            if !swap_on_record(&facts.record) && !restarted(tried) {
                return Check::fail(
                    DAEMON,
                    problem,
                    restart_remedy(facts, "restart it"),
                    Fix::Do(restart_for(facts)),
                );
            }
            let (remedy, fix) = way_back(facts, tried);
            return Check::fail(DAEMON, problem, remedy, fix);
        }
    };
    if crate::health::journal_failed(health) {
        let (remedy, fix) = way_back(facts, tried);
        return Check::fail(
            DAEMON,
            "the daemon could not convert this sandbox's stored files to its version, and put them back.",
            remedy,
            fix,
        );
    }
    let ready = health
        .get("boot")
        .and_then(|boot| boot.get("ready"))
        .or_else(|| health.get("ready"))
        .and_then(Value::as_bool);
    if ready == Some(false) {
        let step = crate::health::running_step(health).unwrap_or_else(|| "converging".to_string());
        return Check::warn(
            DAEMON,
            format!("the daemon answers but is still warming up ({step}) — it keeps going in the background."),
        );
    }
    Check::ok(DAEMON)
}

/// The `announce` block of /health: whether this daemon reached the platform to register — the one link nothing
/// outside the container can probe.
pub fn registration(facts: &ChainFacts, tried: &dyn Fn(&Repair) -> bool) -> Check {
    let Health::Answered(health) = &facts.health else {
        return Check::skip(REGISTRATION, "unknowable while the daemon does not answer");
    };
    let Some(announce) = health.get("announce") else {
        return Check::skip(
            REGISTRATION,
            "this daemon predates registration reporting — update the sandbox",
        );
    };
    let state = announce.get("state").and_then(Value::as_str).unwrap_or("");
    let detail = announce
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or("the daemon could not register with the platform")
        .to_string();
    let retrying = announce.get("retrying").and_then(Value::as_bool);
    match state {
        "registered" => Check::ok(REGISTRATION),
        "off" => Check::skip(REGISTRATION, "headless — this sandbox has no platform to register with"),
        "pending" => Check::warn(
            REGISTRATION,
            "the daemon has not registered with the platform yet — it keeps trying.",
        ),
        "rejected" | "unreachable" if retrying == Some(false) => {
            if restarted(tried) {
                Check::fail(
                    REGISTRATION,
                    format!("{detail} (it stopped retrying, and a restart did not help)"),
                    "run the setup command from your browser again: it gives the sandbox fresh credentials.",
                    Fix::You,
                )
            } else {
                Check::fail(
                    REGISTRATION,
                    format!("{detail} (it stopped retrying)"),
                    restart_remedy(facts, "restart it to retry"),
                    Fix::Do(restart_for(facts)),
                )
            }
        }
        "rejected" => Check::fail(
            REGISTRATION,
            detail,
            "the platform turned it away: run the setup command from your browser again.",
            Fix::You,
        ),
        "unreachable" => Check::fail(
            REGISTRATION,
            detail,
            "it keeps retrying; the Network check says whether this machine reaches the platform, and a firewall or proxy may be stopping the container alone.",
            Fix::You,
        ),
        other => Check::skip(REGISTRATION, format!("unrecognized registration state '{other}'")),
    }
}

pub fn tunnel(facts: &ChainFacts, tried: &dyn Fn(&Repair) -> bool) -> Check {
    let slug = &facts.slug;
    let Some(url) = &facts.env.public_url else {
        return match &facts.container {
            Container::Present(_) => Check::warn(
                TUNNEL,
                "the container carries no SANDBOX_PUBLIC_URL, so reachability from outside cannot be verified.",
            ),
            _ => Check::skip(TUNNEL, "unknowable while the container cannot be read"),
        };
    };
    let host = host_of(url).unwrap_or_else(|| url.clone());
    match &facts.public {
        Public::NotAsked => Check::skip(TUNNEL, "unknowable while the daemon does not answer"),
        Public::Dns(why) => Check::fail(
            TUNNEL,
            format!("DNS for {host} does not resolve from this machine: {why}."),
            "a fresh name can take a minute to reach every resolver; if this persists, check this machine's DNS.",
            Fix::You,
        ),
        Public::Unreachable(why) => Check::fail(
            TUNNEL,
            format!("could not reach https://{host} from this machine: {why}"),
            "check this machine's outbound HTTPS; the Network check says whether the platform is reachable.",
            Fix::You,
        ),
        Public::Answered { status: 200, .. } => Check::ok(TUNNEL),
        Public::Answered { status, edge } if matches!(status, 502 | 503 | 530) => {
            let missing: Vec<&str> = [("SANDBOX_GRANT", &facts.env.grant), ("INGRESS_URL", &facts.env.ingress)]
                .into_iter()
                .filter(|(_, value)| value.is_none())
                .map(|(name, _)| name)
                .collect();
            if !missing.is_empty() {
                return Check::fail(
                    TUNNEL,
                    format!(
                        "the edge answers HTTP {status} for {host} — this container carries no {}, so its daemon dials no tunnel.",
                        missing.join(" and ")
                    ),
                    "run the setup command from your browser again: what the container is missing rides in with it.",
                    Fix::You,
                );
            }
            match edge.as_deref() {
                Some("unknown-sandbox") => Check::fail(
                    TUNNEL,
                    format!("the edge answers HTTP {status} for {host}: the platform no longer knows this sandbox."),
                    "it was removed from your account; set it up again from your browser.",
                    Fix::You,
                ),
                Some("dropped") => Check::fail(
                    TUNNEL,
                    format!("the edge lost its connection to this sandbox mid-request (HTTP {status})."),
                    format!("retry in a moment; if it persists: ic sandbox restart {slug}"),
                    Fix::You,
                ),
                _ => {
                    let problem = format!(
                        "the edge answers HTTP {status} for {host} — it is up, but no tunnel is registered for this sandbox."
                    );
                    let settled = up_for(facts).is_some_and(|up| up >= TUNNEL_GRACE_MS);
                    if settled && !swap_on_record(&facts.record) && !restarted(tried) {
                        Check::fail(
                            TUNNEL,
                            problem,
                            restart_remedy(facts, "restart it so its daemon dials the edge again"),
                            Fix::Do(restart_for(facts)),
                        )
                    } else {
                        Check::fail(
                            TUNNEL,
                            problem,
                            format!("give it a minute to dial the edge; if this persists: ic sandbox restart {slug}"),
                            Fix::You,
                        )
                    }
                }
            }
        }
        Public::Answered { status, .. } => Check::fail(
            TUNNEL,
            format!("https://{host} answered HTTP {status} instead of the daemon's health."),
            "if this persists, run the setup command from your browser again.",
            Fix::You,
        ),
    }
}

/// The swap on record, as a sentence for a person (doctor prints it under the checks).
pub fn swap_note(record: &ChannelRecord, slug: &str) -> Option<String> {
    let swap = record.swap.as_ref()?;
    Some(match (swap.phase, swap.until) {
        (Phase::Probation, Some(until)) => format!(
            "{slug} moved onto {} and is on probation for {} more; the version before it is parked and ready.",
            swap.to.as_deref().unwrap_or("a new version"),
            crate::sandbox::probation::remaining(until)
        ),
        _ => format!("a swap of {slug} was interrupted; `ic sandbox watch {slug}` finishes or undoes it."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::Swap;
    use crate::sandbox::fix::model::{State, Who};

    const NOW: u64 = 1_790_769_600_000;
    const GIB: u64 = 1024 * 1024 * 1024;

    fn running_box() -> Inspected {
        Inspected {
            status: "running".to_string(),
            started_ms: Some(NOW - 3_600_000),
            ..Inspected::default()
        }
    }

    fn facts(container: Container) -> ChainFacts {
        ChainFacts {
            slug: "sandbox-0123456789ab".to_string(),
            record: ChannelRecord::default(),
            env: Env {
                token: Some("t".to_string()),
                public_url: Some("https://sandbox-0123456789ab.intentic.app".to_string()),
                grant: Some("g".to_string()),
                ingress: Some("https://edge.intentic.dev".to_string()),
                ..Env::default()
            },
            container,
            sidecar_running: None,
            oom_seen: false,
            health: Health::NotAsked,
            boot_failure: None,
            engine_memory: None,
            public: Public::NotAsked,
            live_turns: None,
            now_ms: NOW,
            ledger: Ledger::default(),
            stopped_outside: false,
        }
    }

    fn stopped() -> ChainFacts {
        facts(Container::Present(Inspected {
            status: "exited".to_string(),
            exit_code: 137,
            ..running_box()
        }))
    }

    fn never(_: &Repair) -> bool {
        false
    }

    fn always(_: &Repair) -> bool {
        true
    }

    #[test]
    fn inspect_output_parses_and_dockers_zero_time_is_no_time() {
        let parsed = Inspected::parse("exited|false|4|true|137|0001-01-01T00:00:00Z|8589934592")
            .expect("parses");
        assert_eq!(parsed.status, "exited");
        assert_eq!(parsed.restarts, 4);
        assert!(parsed.oom);
        assert_eq!(parsed.exit_code, 137);
        assert_eq!(parsed.started_ms, None);
        assert_eq!(parsed.memory, 8 * GIB);
        assert_eq!(Inspected::parse("running|false"), None);
    }

    #[test]
    fn a_stopped_sandbox_is_started_unasked_unless_its_owner_stopped_it() {
        let check = container(&stopped(), true, &never);
        assert_eq!(check.repair(), Some(&Repair::Start));
        assert_eq!(check.who(), Some(Who::Auto));
        assert_eq!(
            check.remedy.as_deref(),
            Some("start it: ic sandbox start sandbox-0123456789ab")
        );
        assert!(check
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("exit code 137")));
        let held = ChainFacts {
            record: ChannelRecord {
                held: true,
                ..ChannelRecord::default()
            },
            ..stopped()
        };
        let asked = container(&held, true, &never);
        assert_eq!(asked.repair(), Some(&Repair::StartHeld));
        assert_eq!(asked.who(), Some(Who::Consent));
        assert!(asked
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("stopped on purpose")));
    }

    #[test]
    fn a_start_that_did_not_hold_after_an_update_offers_the_way_back() {
        let updated = ChainFacts {
            record: ChannelRecord {
                previous: Some("ghcr.io/intentic/sandbox:1.2.3".to_string()),
                ..ChannelRecord::default()
            },
            ..stopped()
        };
        let started = |r: &Repair| *r == Repair::Start;
        let check = container(&updated, true, &started);
        assert_eq!(check.repair(), Some(&Repair::Rollback));
        let never_updated = container(&stopped(), true, &started);
        assert_eq!(never_updated.who(), Some(Who::You));
        assert!(never_updated
            .remedy
            .as_deref()
            .is_some_and(|r| r.contains("ic sandbox logs")));
    }

    #[test]
    fn a_crash_loop_after_an_oom_kill_asks_for_memory_first() {
        let looping = ChainFacts {
            engine_memory: Some(32 * GIB),
            ..facts(Container::Present(Inspected {
                restarts: 5,
                oom: true,
                memory: 8 * GIB,
                ..running_box()
            }))
        };
        let check = container(&looping, true, &never);
        assert_eq!(check.repair(), Some(&Repair::RaiseMemory(12)));
        assert!(check
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("5 restarts") && p.contains("memory")));
        // A probation on record is the watch's to judge first.
        let probation = ChainFacts {
            record: ChannelRecord {
                swap: Some(Swap {
                    phase: Phase::Probation,
                    at: NOW - 60_000,
                    verb: "update".to_string(),
                    from: None,
                    to: None,
                    until: Some(NOW + 60_000),
                    reach: None,
                    strikes: 0,
                    daemon_start: None,
                    daemon_restarts: 0,
                    alive: None,
                }),
                ..ChannelRecord::default()
            },
            ..looping
        };
        assert_eq!(
            container(&probation, true, &never).repair(),
            Some(&Repair::Watch)
        );
    }

    #[test]
    fn memory_is_raised_by_half_within_what_the_engine_has() {
        assert_eq!(raised_memory(8 * GIB, Some(32 * GIB)), Some(12));
        assert_eq!(
            raised_memory(2 * GIB, Some(32 * GIB)),
            Some(4),
            "at least two more"
        );
        assert_eq!(
            raised_memory(8 * GIB, Some(10 * GIB)),
            Some(9),
            "a GiB is left for the rest"
        );
        assert_eq!(
            raised_memory(8 * GIB, Some(9 * GIB)),
            None,
            "no room to raise into"
        );
        assert_eq!(
            raised_memory(0, Some(32 * GIB)),
            None,
            "no cap: the engine itself ran out"
        );
    }

    #[test]
    fn a_missing_container_is_the_setup_commands_and_a_parked_one_is_put_back() {
        let missing = container(&facts(Container::Missing { parked: false }), true, &never);
        assert_eq!(missing.who(), Some(Who::You));
        assert!(missing
            .remedy
            .as_deref()
            .is_some_and(|r| r.contains("setup command")));
        let parked = container(&facts(Container::Missing { parked: true }), true, &never);
        assert_eq!(parked.repair(), Some(&Repair::Watch));
        assert_eq!(container(&stopped(), false, &never).state, State::Skip);
    }

    fn answering(health: Value) -> ChainFacts {
        ChainFacts {
            health: Health::Answered(health),
            ..facts(Container::Present(running_box()))
        }
    }

    #[test]
    fn a_silent_daemon_is_restarted_unless_it_is_still_starting_or_a_swap_owns_it() {
        let silent = ChainFacts {
            health: Health::Silent,
            ..facts(Container::Present(running_box()))
        };
        assert_eq!(daemon(&silent, &never).repair(), Some(&Repair::Restart));
        let young = ChainFacts {
            health: Health::Silent,
            ..facts(Container::Present(Inspected {
                started_ms: Some(NOW - 30_000),
                ..running_box()
            }))
        };
        assert_eq!(daemon(&young, &never).state, State::Warn);
        let failed_boot = ChainFacts {
            boot_failure: Some("state conversion 12 threw".to_string()),
            ..silent
        };
        let check = daemon(&failed_boot, &never);
        assert!(check
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("could not start: state conversion 12 threw")));
        assert_eq!(check.who(), Some(Who::You));
    }

    #[test]
    fn a_failed_conversion_offers_the_rollback_and_a_warming_daemon_names_its_step() {
        let mut failed = answering(
            serde_json::json!({ "boot": { "ready": true }, "state": { "journal": "failed" } }),
        );
        failed.record.previous = Some("ghcr.io/intentic/sandbox:1.2.3".to_string());
        let check = daemon(&failed, &never);
        assert_eq!(check.repair(), Some(&Repair::Rollback));
        assert_eq!(check.remedy.as_deref(), Some("if this began with an update, go back to the version before it: ic sandbox rollback sandbox-0123456789ab"));
        let warming = daemon(
            &answering(
                serde_json::json!({ "boot": { "ready": false, "steps": [{ "state": "running", "label": "index the workspace" }] } }),
            ),
            &never,
        );
        assert_eq!(warming.state, State::Warn);
        assert!(warming
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("index the workspace")));
    }

    #[test]
    fn a_registration_that_gave_up_is_restarted_and_one_still_trying_is_left_to_the_network() {
        let gave_up = answering(
            serde_json::json!({ "announce": { "state": "unreachable", "detail": "the platform could not be reached", "retrying": false } }),
        );
        let check = registration(&gave_up, &never);
        assert_eq!(check.repair(), Some(&Repair::Restart));
        assert_eq!(
            check.remedy.as_deref(),
            Some("restart it to retry: ic sandbox restart sandbox-0123456789ab")
        );
        assert_eq!(registration(&gave_up, &always).who(), Some(Who::You));
        let trying = answering(
            serde_json::json!({ "announce": { "state": "unreachable", "detail": "x", "retrying": true } }),
        );
        assert_eq!(registration(&trying, &never).who(), Some(Who::You));
        let registered = answering(serde_json::json!({ "announce": { "state": "registered" } }));
        assert_eq!(registration(&registered, &never).state, State::Ok);
        let older = answering(serde_json::json!({ "ready": true }));
        assert_eq!(registration(&older, &never).state, State::Skip);
    }

    #[test]
    fn the_edges_verdict_decides_the_tunnels_fix() {
        let with = |status, edge: Option<&str>| ChainFacts {
            public: Public::Answered {
                status,
                edge: edge.map(str::to_string),
            },
            ..answering(serde_json::json!({ "ready": true }))
        };
        assert_eq!(tunnel(&with(200, None), &never).state, State::Ok);
        let no_tunnel = tunnel(&with(502, Some("no-tunnel")), &never);
        assert_eq!(
            no_tunnel.repair(),
            Some(&Repair::Restart),
            "an hour up and no tunnel: restart"
        );
        let unknown = tunnel(&with(502, Some("unknown-sandbox")), &never);
        assert_eq!(unknown.who(), Some(Who::You));
        assert!(unknown
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("no longer knows")));
        let mut ungranted = with(502, Some("no-tunnel"));
        ungranted.env.grant = None;
        let check = tunnel(&ungranted, &never);
        assert!(check
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("carries no SANDBOX_GRANT")));
        assert_eq!(check.who(), Some(Who::You));
        // A daemon that only just started gets its minute to dial.
        let young = ChainFacts {
            container: Container::Present(Inspected {
                started_ms: Some(NOW - 20_000),
                ..running_box()
            }),
            ..with(530, None)
        };
        assert_eq!(tunnel(&young, &never).who(), Some(Who::You));
    }

    #[test]
    fn a_restart_that_would_cut_running_turns_waits_for_a_yes() {
        let busy = |n| ChainFacts {
            public: Public::Answered {
                status: 502,
                edge: Some("no-tunnel".to_string()),
            },
            live_turns: Some(n),
            ..answering(serde_json::json!({ "ready": true }))
        };
        let idle = tunnel(&busy(0), &never);
        assert_eq!(
            idle.repair(),
            Some(&Repair::Restart),
            "nothing runs: unasked"
        );
        let one = tunnel(&busy(1), &never);
        assert_eq!(one.repair(), Some(&Repair::RestartBusy));
        assert_eq!(one.who(), Some(Who::Consent));
        assert!(one
            .remedy
            .as_deref()
            .is_some_and(|r| r.contains("1 agent turn is running here, and a restart cuts it")));
        let three = tunnel(&busy(3), &never);
        assert!(three
            .remedy
            .as_deref()
            .is_some_and(|r| r.contains("3 agent turns are running here")));
        // Restarted already this run, either way: not again.
        let after = |repair: &Repair| *repair == Repair::RestartBusy;
        assert_eq!(tunnel(&busy(3), &after).who(), Some(Who::You));
        let gave_up = ChainFacts {
            live_turns: Some(2),
            ..answering(
                serde_json::json!({ "announce": { "state": "unreachable", "detail": "x", "retrying": false } }),
            )
        };
        assert_eq!(
            registration(&gave_up, &never).repair(),
            Some(&Repair::RestartBusy)
        );
        assert_eq!(registration(&gave_up, &after).who(), Some(Who::You));
    }

    #[test]
    fn the_work_signal_is_believed_only_while_it_is_fresh() {
        assert_eq!(
            live_turns(r#"{"liveTurns":2,"at":1000}"#, 1_000 + 60_000),
            Some(2)
        );
        assert_eq!(
            live_turns("{\"liveTurns\":0,\"at\":1000}\n", 1_000),
            Some(0)
        );
        assert_eq!(
            live_turns(r#"{"liveTurns":2,"at":1000}"#, 1_000 + 4 * 60_000),
            None,
            "a count a hung daemon left behind"
        );
        assert_eq!(
            live_turns("cat: /run/intentic/work.json: No such file", 0),
            None
        );
        assert_eq!(live_turns(r#"{"at":1000}"#, 1_000), None);
    }

    #[test]
    fn only_a_reading_that_would_restart_gets_a_second_look() {
        let silent = ChainFacts {
            health: Health::Silent,
            ..facts(Container::Present(running_box()))
        };
        assert!(health_worth_a_second_look(&silent));
        let young = ChainFacts {
            container: Container::Present(Inspected {
                started_ms: Some(NOW - 30_000),
                ..running_box()
            }),
            ..silent
        };
        assert!(
            !health_worth_a_second_look(&young),
            "still starting: no restart to confirm"
        );
        assert!(!health_worth_a_second_look(&answering(
            serde_json::json!({ "ready": true })
        )));
        let edge = |status, verdict: Option<&str>| Public::Answered {
            status,
            edge: verdict.map(str::to_string),
        };
        assert!(public_worth_a_second_look(&edge(502, Some("no-tunnel"))));
        assert!(public_worth_a_second_look(&edge(530, None)));
        assert!(!public_worth_a_second_look(&edge(200, None)));
        assert!(!public_worth_a_second_look(&edge(
            502,
            Some("unknown-sandbox")
        )));
        assert!(!public_worth_a_second_look(&edge(502, Some("dropped"))));
        assert!(!public_worth_a_second_look(&Public::Unreachable(
            "timeout".to_string()
        )));
    }

    #[test]
    fn the_restart_policy_and_the_last_stop_are_read_and_an_older_reading_lacks_them() {
        let parsed = Inspected::parse(
            "exited|false|0|false|143|2026-10-05T20:00:00Z|0|unless-stopped|2026-10-05T22:45:30.5Z",
        )
        .expect("parses");
        assert_eq!(parsed.restart_policy, "unless-stopped");
        assert_eq!(parsed.finished_ms, Some(1_791_240_330_500));
        let older =
            Inspected::parse("exited|false|0|false|0|0001-01-01T00:00:00Z|0").expect("parses");
        assert_eq!(older.restart_policy, "");
        assert_eq!(older.finished_ms, None);
    }

    #[test]
    fn a_container_a_person_stopped_outside_ic_waits_for_a_yes() {
        let stopped_by_hand = Inspected {
            status: "exited".to_string(),
            exit_code: 143,
            restart_policy: "unless-stopped".to_string(),
            ..running_box()
        };
        assert!(stop_worth_asking(&stopped_by_hand));
        assert!(stopped_by_person(&stopped_by_hand, true));
        assert!(
            !stopped_by_person(&stopped_by_hand, false),
            "a stop the engine's log does not hold is not proven"
        );
        for not_a_stop in [
            Inspected {
                exit_code: 137,
                ..stopped_by_hand.clone()
            },
            Inspected {
                restart_policy: "no".to_string(),
                ..stopped_by_hand.clone()
            },
            Inspected {
                restarting: true,
                ..stopped_by_hand.clone()
            },
            Inspected {
                status: "running".to_string(),
                ..stopped_by_hand.clone()
            },
        ] {
            assert!(!stop_worth_asking(&not_a_stop), "{not_a_stop:?}");
        }
        assert!(stop_in_events("kill\ndie\nstop\n"));
        assert!(stop_in_events("kill\n"));
        assert!(!stop_in_events("die\nstart\n"));
        assert!(!stop_in_events(""));

        let check = container(
            &ChainFacts {
                stopped_outside: true,
                ..facts(Container::Present(Inspected {
                    exit_code: 0,
                    ..stopped_by_hand
                }))
            },
            true,
            &never,
        );
        assert_eq!(check.repair(), Some(&Repair::StartHeld));
        assert_eq!(check.who(), Some(Who::Consent));
        assert!(check
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("stopped outside intentic")));
    }

    #[test]
    fn a_stopped_tunnel_container_from_an_older_setup_is_retired_not_started() {
        let with_sidecar = ChainFacts {
            sidecar_running: Some(false),
            ..facts(Container::Present(running_box()))
        };
        let check = container(&with_sidecar, true, &never);
        assert_eq!(
            check.state,
            State::Warn,
            "nothing about the sandbox is broken"
        );
        assert_eq!(check.repair(), Some(&Repair::RetireSidecar));
        assert_eq!(check.who(), Some(Who::Auto));
        let retired = |r: &Repair| *r == Repair::RetireSidecar;
        assert_eq!(container(&with_sidecar, true, &retired).state, State::Ok);
        let running_sidecar = ChainFacts {
            sidecar_running: Some(true),
            ..facts(Container::Present(running_box()))
        };
        assert_eq!(container(&running_sidecar, true, &never).state, State::Ok);
    }

    #[test]
    fn a_silent_daemon_running_turns_is_not_restarted_unasked() {
        let busy = ChainFacts {
            health: Health::Silent,
            live_turns: Some(2),
            ..facts(Container::Present(running_box()))
        };
        let check = daemon(&busy, &never);
        assert_eq!(check.repair(), Some(&Repair::RestartBusy));
        assert_eq!(check.who(), Some(Who::Consent));
        assert!(check
            .remedy
            .as_deref()
            .is_some_and(|r| r.contains("2 agent turns are running here")));
        let after = |r: &Repair| *r == Repair::RestartBusy;
        assert_eq!(daemon(&busy, &after).who(), Some(Who::You));
    }

    #[test]
    fn three_automatic_restarts_in_two_hours_hand_the_fourth_to_a_person() {
        let mut ledger = Ledger::default();
        for minutes_ago in [90, 40, 10] {
            ledger = ledger.noted(
                crate::sandbox::ledger::RESTART,
                NOW - minutes_ago * 60_000,
                true,
            );
        }
        let looping = ChainFacts {
            health: Health::Silent,
            ledger,
            ..facts(Container::Present(running_box()))
        };
        let check = daemon(&looping, &never);
        assert_eq!(check.repair(), Some(&Repair::RestartAgain));
        assert_eq!(check.who(), Some(Who::Consent));
        let remedy = check.remedy.clone().unwrap_or_default();
        assert!(remedy.contains("restarted 3 times since"), "{remedy}");
        assert!(
            remedy.contains("ic sandbox logs sandbox-0123456789ab"),
            "{remedy}"
        );
        // With a version to go back to, the way back is named first.
        let updated = ChainFacts {
            record: ChannelRecord {
                previous: Some("pin".to_string()),
                ..ChannelRecord::default()
            },
            ..looping
        };
        assert!(daemon(&updated, &never)
            .remedy
            .unwrap_or_default()
            .contains("roll back (ic sandbox rollback sandbox-0123456789ab)"));
        // The same rule holds for the tunnel's restart and a registration that gave up.
        let tunnel_down = ChainFacts {
            public: Public::Answered {
                status: 502,
                edge: Some("no-tunnel".to_string()),
            },
            health: Health::Answered(serde_json::json!({ "ready": true })),
            ..updated
        };
        assert_eq!(
            tunnel(&tunnel_down, &never).repair(),
            Some(&Repair::RestartAgain)
        );
    }

    #[test]
    fn env_is_read_off_the_nul_framed_listing_with_empties_absent() {
        let env = Env::parse("CONNECT_TOKEN=abc\0PLATFORM_URL=https://api.intentic.dev\0SANDBOX_GRANT=\0HOST_LABEL=ada\0");
        assert_eq!(env.token.as_deref(), Some("abc"));
        assert_eq!(env.platform.as_deref(), Some("https://api.intentic.dev"));
        assert_eq!(env.grant, None);
        assert_eq!(env.host_label.as_deref(), Some("ada"));
        assert_eq!(env.host_platform, None);
        let wsl = Env::parse("HOST_PLATFORM=linux\0HOST_LABEL=rog\0HOST_ENV=archlinux\0");
        assert_eq!(wsl.host_platform.as_deref(), Some("linux"));
        assert_eq!(wsl.side(), Some(Side::new("linux", Some("archlinux"))));
        assert_eq!(env.side(), None);
    }

    #[test]
    fn host_extraction_handles_the_shapes_connect_writes() {
        assert_eq!(
            host_of("https://sandbox-x.example.com/").as_deref(),
            Some("sandbox-x.example.com")
        );
        assert_eq!(
            host_of("http://localhost:6480").as_deref(),
            Some("localhost")
        );
        assert_eq!(host_of("not a url"), None);
    }
}
