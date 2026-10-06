use serde_json::{json, Value};

use crate::util::plural;

/* WHAT `ic sandbox fix` FOUND AND WHO CAN CLOSE IT, pure. The engine around it (mod.rs) gathers facts and applies
repairs; everything that decides — a check's category, the outcome, the one sentence a run ends on, its exit code and
the report the platform stores — is here, where a test can reach it without a Docker engine. */

// The check ids: the platform contract's `HOST_CHECKS` (@intentic/api-contract), in the order ic checks them. A
// test reads that list out of the contract's own source, so the two cannot drift.
pub const PREREQUISITES: &str = "prerequisites";
pub const DOCKER_APP: &str = "docker-app";
pub const DOCKER: &str = "docker";
pub const WSL: &str = "wsl";
pub const DISK: &str = "disk";
pub const CONTAINER: &str = "container";
pub const DAEMON: &str = "daemon";
pub const REGISTRATION: &str = "registration";
pub const NETWORK: &str = "network";
pub const TUNNEL: &str = "tunnel";
pub const AGENT: &str = "agent";

pub const ORDER: [&str; 11] = [
    PREREQUISITES,
    DOCKER_APP,
    DOCKER,
    WSL,
    DISK,
    CONTAINER,
    DAEMON,
    REGISTRATION,
    NETWORK,
    TUNNEL,
    AGENT,
];

/// A check's name as a row prints it, and as the report's `label` carries it.
pub fn label(id: &str) -> &'static str {
    match id {
        PREREQUISITES => "Windows prerequisites",
        DOCKER_APP => "Docker Desktop",
        DOCKER => "Docker engine",
        WSL => "WSL",
        DISK => "Disk space",
        CONTAINER => "Sandbox container",
        DAEMON => "Daemon health",
        REGISTRATION => "Platform registration",
        NETWORK => "Network",
        TUNNEL => "Public URL",
        AGENT => "Machine agent",
        _ => "Check",
    }
}

/// Where a check stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Ok,
    /// Degraded but working: named, never what a run fails on.
    Warn,
    Fail,
    /// A repair is working on it right now.
    Fixing,
    /// Cannot be checked: an earlier layer is down, or the value it reads is not there.
    Skip,
}

impl State {
    pub fn wire(self) -> &'static str {
        match self {
            State::Ok => "ok",
            State::Warn => "warn",
            State::Fail => "fail",
            State::Fixing => "fixing",
            State::Skip => "skip",
        }
    }
}

/// Who can close a finding: the contract's `fix`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Who {
    /// ic does, in every mode but doctor, the machine agent's `--auto` included.
    Auto,
    /// ic can once someone says yes in its terminal (or passed `--yes` / `--accept <check>`).
    Consent,
    /// Only a person can: a firmware switch, a dialog in Docker Desktop, disk only they can free.
    You,
}

impl Who {
    pub fn wire(self) -> &'static str {
        match self {
            Who::Auto => "auto",
            Who::Consent => "consent",
            Who::You => "you",
        }
    }
}

/// Something ic knows how to do about a finding. The category is the repair's own: whether a thing is safe to do
/// unasked does not change with the machine it is done on.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Repair {
    /// Launch Docker Desktop and wait for its engine.
    StartDesktop,
    /// Stop every Docker Desktop process and start it again: an app that is up with an engine that is not.
    RestartDesktop,
    /// Windows' last resort: Docker Desktop stopped, `wsl --shutdown`, Docker Desktop started. Takes every WSL
    /// distro down with it.
    ShutdownWsl,
    /// Inside WSL: `docker desktop restart` from the Windows side, which re-applies an integration that is switched
    /// on and merely absent.
    ReapplyIntegration,
    /// Docker Desktop switched off Windows containers.
    LinuxContainers,
    /// Linux Docker Engine: `sudo systemctl start docker`.
    StartEngine,
    /// Docker Desktop's own start-at-sign-in switched on, so a reboot does not take the sandbox down with it.
    AutoStart,
    /// One of `ic docker prepare`'s elevated Windows fixes, by its requirement id.
    Prerequisite(&'static str),
    /// `ic sandbox tidy`: images and records nothing uses. Never a volume.
    Tidy,
    /// `docker builder prune`: build cache, rebuilt on demand by the next build that wants it.
    PruneBuilder,
    /// `ic sandbox start` on a sandbox nobody stopped on purpose.
    Start,
    /// The same, on one its owner stopped (`ic sandbox stop`).
    StartHeld,
    /// `ic sandbox watch`: finish or undo a swap that was cut off.
    Watch,
    /// `ic sandbox restart`.
    Restart,
    /// The same, on a sandbox whose agents are mid-turn: the restart cuts them, so it waits for a yes, and the
    /// machine agent's `--auto` leaves it for its next pass, when they may have finished.
    RestartBusy,
    /// The same, on a sandbox the keeper has already restarted by itself three times in two hours (ledger.rs): a loop
    /// a fourth restart will not end, so it waits for a person.
    RestartAgain,
    /// Stop and remove the tunnel container an older setup left beside the sandbox, which nothing uses any more.
    RetireSidecar,
    /// `ic sandbox rollback`: the version before the last update.
    Rollback,
    /// `ic sandbox reshape --memory <n>g`, after the kernel killed it for memory.
    RaiseMemory(u64),
}

impl Repair {
    pub fn who(&self) -> Who {
        match self {
            Repair::StartDesktop
            | Repair::Tidy
            | Repair::Start
            | Repair::Watch
            | Repair::Restart
            | Repair::RetireSidecar => Who::Auto,
            _ => Who::Consent,
        }
    }

    /// Whether this repair is the machine's rather than one sandbox's.
    pub fn host(&self) -> bool {
        !matches!(
            self,
            Repair::Start
                | Repair::StartHeld
                | Repair::Watch
                | Repair::Restart
                | Repair::RestartBusy
                | Repair::RestartAgain
                | Repair::RetireSidecar
                | Repair::Rollback
                | Repair::RaiseMemory(_)
        )
    }

    /// What ic is doing while it does this: the report's `doing`, and the narration line.
    pub fn doing(&self) -> String {
        match self {
            Repair::StartDesktop => "Starting Docker Desktop".to_string(),
            Repair::RestartDesktop => "Restarting Docker Desktop".to_string(),
            Repair::ShutdownWsl => "Restarting WSL and Docker Desktop".to_string(),
            Repair::ReapplyIntegration => {
                "Re-applying Docker Desktop's WSL integration".to_string()
            }
            Repair::LinuxContainers => "Switching Docker to Linux containers".to_string(),
            Repair::StartEngine => "Starting Docker's engine".to_string(),
            Repair::AutoStart => "Turning on Docker Desktop's start at sign-in".to_string(),
            Repair::Prerequisite(id) => format!("Fixing a Windows prerequisite ({id})"),
            Repair::Tidy => "Removing what updates left behind".to_string(),
            Repair::PruneBuilder => "Clearing Docker's build cache".to_string(),
            Repair::Start | Repair::StartHeld => "Starting the sandbox".to_string(),
            Repair::Watch => "Finishing an interrupted update".to_string(),
            Repair::Restart | Repair::RestartBusy | Repair::RestartAgain => {
                "Restarting the sandbox".to_string()
            }
            Repair::RetireSidecar => {
                "Removing the tunnel container an older setup left".to_string()
            }
            Repair::Rollback => "Going back to the version before the last update".to_string(),
            Repair::RaiseMemory(gib) => format!("Giving the sandbox {gib} GiB of memory"),
        }
    }

    /// The consent question, asked in the terminal and shown on the page while it waits. `slug` names the
    /// sandbox for a sandbox's own repair.
    pub fn question(&self, slug: Option<&str>) -> String {
        let of = slug.map(|slug| format!(" {slug}")).unwrap_or_default();
        match self {
            Repair::RestartDesktop => {
                "Restart Docker Desktop? Every sandbox on this machine restarts with it.".to_string()
            }
            Repair::ShutdownWsl => "Restart WSL and Docker Desktop? This stops every WSL distro on this PC, including anything running in them.".to_string(),
            Repair::ReapplyIntegration => {
                "Restart Docker Desktop to re-apply its WSL integration?".to_string()
            }
            Repair::LinuxContainers => "Switch Docker Desktop to Linux containers?".to_string(),
            Repair::StartEngine => "Start Docker's engine (sudo systemctl start docker)?".to_string(),
            Repair::AutoStart => {
                "Make Docker Desktop start when you sign in, so a restart does not stop your sandbox?"
                    .to_string()
            }
            Repair::Prerequisite(id) => format!(
                "Fix this Windows prerequisite ({id})? Windows asks for permission."
            ),
            Repair::PruneBuilder => {
                "Clear Docker's build cache to free disk space? It is rebuilt when needed.".to_string()
            }
            Repair::StartHeld => {
                format!("Sandbox{of} was stopped on purpose. Start it again?")
            }
            Repair::Rollback => format!(
                "Take sandbox{of} back to the version it ran before its last update?"
            ),
            Repair::RaiseMemory(gib) => format!(
                "Give sandbox{of} {gib} GiB of memory? It restarts for about a minute."
            ),
            Repair::RestartBusy => format!(
                "Agents in sandbox{of} are mid-turn, and a restart cuts them. Restart it now?"
            ),
            Repair::RestartAgain => format!(
                "Sandbox{of} was restarted three times in the last two hours and did not stay well. Restart it once more?"
            ),
            other => format!("{}?", other.doing()),
        }
    }
}

/// How a finding gets closed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fix {
    /// Nothing to do: a pass, a skip, a warn that only informs.
    None,
    /// Only a person can.
    You,
    Do(Repair),
}

/// One check, as it stands.
#[derive(Clone, Debug, PartialEq)]
pub struct Check {
    pub id: &'static str,
    pub state: State,
    /// On warn/fail: what is wrong, in the user's terms.
    pub problem: Option<String>,
    /// On warn/fail: what closes it.
    pub remedy: Option<String>,
    pub fix: Fix,
    /// The why of a skip or the detail of a pass: the row's note, never on the wire.
    pub note: Option<String>,
    /// Closing it takes a Windows restart or sign-out: nothing more can happen in this session (exit 4).
    pub session: bool,
}

impl Check {
    fn new(id: &'static str, state: State) -> Check {
        Check {
            id,
            state,
            problem: None,
            remedy: None,
            fix: Fix::None,
            note: None,
            session: false,
        }
    }

    pub fn ok(id: &'static str) -> Check {
        Check::new(id, State::Ok)
    }

    pub fn skip(id: &'static str, why: impl Into<String>) -> Check {
        Check {
            note: Some(why.into()),
            ..Check::new(id, State::Skip)
        }
    }

    pub fn warn(id: &'static str, problem: impl Into<String>) -> Check {
        Check {
            problem: Some(problem.into()),
            ..Check::new(id, State::Warn)
        }
    }

    pub fn fail(
        id: &'static str,
        problem: impl Into<String>,
        remedy: impl Into<String>,
        fix: Fix,
    ) -> Check {
        Check {
            problem: Some(problem.into()),
            remedy: Some(remedy.into()),
            fix,
            ..Check::new(id, State::Fail)
        }
    }

    /// A warn with a way to close it.
    pub fn warn_fix(
        id: &'static str,
        problem: impl Into<String>,
        remedy: impl Into<String>,
        fix: Fix,
    ) -> Check {
        Check {
            remedy: Some(remedy.into()),
            fix,
            ..Check::warn(id, problem)
        }
    }

    pub fn needs_session(self) -> Check {
        Check {
            session: true,
            ..self
        }
    }

    pub fn label(&self) -> &'static str {
        label(self.id)
    }

    /// The category the report carries.
    pub fn who(&self) -> Option<Who> {
        match &self.fix {
            Fix::None => None,
            Fix::You => Some(Who::You),
            Fix::Do(repair) => Some(repair.who()),
        }
    }

    pub fn repair(&self) -> Option<&Repair> {
        match &self.fix {
            Fix::Do(repair) => Some(repair),
            _ => None,
        }
    }

    pub fn failed(&self) -> bool {
        self.state == State::Fail
    }
}

/// How a run ended for one sandbox: the contract's `outcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing on this machine was wrong.
    Healthy,
    /// Something was, and is not now.
    Fixed,
    /// A `you` check, or a `consent` one nobody agreed to, is left.
    NeedsYou,
    /// A fix was tried and did not take.
    Failed,
}

impl Outcome {
    pub fn wire(self) -> &'static str {
        match self {
            Outcome::Healthy => "healthy",
            Outcome::Fixed => "fixed",
            Outcome::NeedsYou => "needs-you",
            Outcome::Failed => "failed",
        }
    }
}

/// The outcome over the checks a run ended on. Only failures decide it: a warning (Docker Desktop not set to start
/// at sign-in, a tight disk) rides along without making a working sandbox read as broken. `fixed` counts the repairs
/// that took; `attempted` whether any repair ran at all, since an automatic fix left standing means it did not take
/// only if it was tried (doctor tries nothing). Pure.
pub fn outcome(checks: &[Check], fixed: usize, attempted: bool) -> Outcome {
    let left: Vec<&Check> = checks.iter().filter(|check| check.failed()).collect();
    if left.is_empty() {
        return if fixed > 0 {
            Outcome::Fixed
        } else {
            Outcome::Healthy
        };
    }
    let for_a_person = left
        .iter()
        .any(|check| matches!(check.who(), Some(Who::You | Who::Consent) | None));
    if for_a_person || !attempted {
        Outcome::NeedsYou
    } else {
        Outcome::Failed
    }
}

/// The one sentence a run ends on. Pure.
pub fn verdict(outcome: Outcome, fixed: usize, left: &[&Check]) -> String {
    let things = plural(fixed, "thing");
    match outcome {
        Outcome::Healthy => {
            "Your sandbox is running and reachable — return to your browser.".to_string()
        }
        Outcome::Fixed => {
            format!("Fixed {things}; your sandbox is back — return to your browser.")
        }
        Outcome::NeedsYou | Outcome::Failed => {
            let lead = if fixed > 0 {
                format!("Fixed {things}. ")
            } else {
                String::new()
            };
            match left {
                [] => format!("{lead}Nothing is left that ic can see — return to your browser."),
                [one] => format!("{lead}One thing is left for you: {}", closing(one)),
                many => format!(
                    "{lead}{} things are left for you, each with its fix below.",
                    many.len()
                ),
            }
        }
    }
}

/// What a person does about one check, as the end of a sentence.
fn closing(check: &Check) -> String {
    let remedy = check
        .remedy
        .clone()
        .or_else(|| check.problem.clone())
        .unwrap_or_else(|| check.label().to_string());
    let mut text = remedy.trim().to_string();
    if !text.ends_with(['.', '!', '?']) {
        text.push('.');
    }
    text
}

/// The numbered block under a verdict with more than one thing left, or the detail under one: every failure with
/// its problem and its fix, the shape `checks::failure_summary` prints. Pure.
pub fn left_block(left: &[(Option<&str>, &Check)]) -> String {
    let mut text = String::new();
    for (index, (slug, check)) in left.iter().enumerate() {
        let name = match slug {
            Some(slug) => format!("{} ({slug})", check.label()),
            None => check.label().to_string(),
        };
        text.push_str(&format!("\n  {}. {name}\n", index + 1));
        if let Some(problem) = &check.problem {
            text.push_str(&format!("     problem: {problem}\n"));
        }
        if let Some(remedy) = &check.remedy {
            text.push_str(&format!("     fix:     {remedy}\n"));
        }
    }
    text
}

/// The exit code: 0 healthy or fixed; 4 a Windows restart or sign-out stands between here and the rest; 3 only
/// consent is missing and nobody was there to give it (the agent's `--auto`, a run with no terminal); 1 anything else
/// left. The same 3 and 4 `ic docker prepare` stops on (docs/ops/cli-output-protocol.md). Pure.
pub fn exit_code(left: &[&Check], session: bool, could_ask: bool) -> i32 {
    if session {
        return 4;
    }
    if left.is_empty() {
        return 0;
    }
    if !could_ask && left.iter().all(|check| check.who() == Some(Who::Consent)) {
        return 3;
    }
    1
}

/// The contract's `source`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Agent,
    Command,
    App,
}

impl Source {
    pub fn wire(self) -> &'static str {
        match self {
            Source::Agent => "agent",
            Source::Command => "command",
            Source::App => "app",
        }
    }
}

/// The contract's `stage`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Checking,
    Fixing,
    Asking,
    Done,
}

impl Stage {
    pub fn wire(self) -> &'static str {
        match self {
            Stage::Checking => "checking",
            Stage::Fixing => "fixing",
            Stage::Asking => "asking",
            Stage::Done => "done",
        }
    }
}

/// One `HostReportInput`, before it is JSON.
pub struct Report<'a> {
    pub source: Source,
    pub machine: &'a str,
    pub os: &'a str,
    /// Which environment of the machine ran it (side.rs: `windows`, a WSL distro's name): with `machine` and `os` it
    /// names the reporter, so a Windows agent's report and a WSL agent's do not overwrite each other.
    pub env: Option<&'a str>,
    pub stage: Stage,
    pub doing: Option<&'a str>,
    pub outcome: Option<Outcome>,
    pub checks: &'a [Check],
}

/// The platform's caps (`HostCheckSchema`, `HostReportInputSchema`): a value past one fails the whole report, so it
/// is clipped here rather than lost there.
const LABEL_MAX: usize = 120;
const TEXT_MAX: usize = 2000;
const DOING_MAX: usize = 300;
const MACHINE_MAX: usize = 120;
const ENV_MAX: usize = 80;
const CHECKS_MAX: usize = 24;

/// The report as the contract's `HostReportInputSchema` reads it, field for field. Problem, remedy and fix ride on a
/// warn or a fail only; `outcome` on `done` only. Pure.
pub fn wire(report: &Report<'_>) -> Value {
    let checks: Vec<Value> = report
        .checks
        .iter()
        .take(CHECKS_MAX)
        .map(|check| {
            let mut row = json!({
                "id": check.id,
                "label": clip(check.label(), LABEL_MAX),
                "state": check.state.wire(),
            });
            if matches!(check.state, State::Warn | State::Fail) {
                if let Some(problem) = &check.problem {
                    row["problem"] = json!(clip(problem, TEXT_MAX));
                }
                if let Some(remedy) = &check.remedy {
                    row["remedy"] = json!(clip(remedy, TEXT_MAX));
                }
                if let Some(who) = check.who() {
                    row["fix"] = json!(who.wire());
                }
            }
            row
        })
        .collect();
    let mut body = json!({
        "source": report.source.wire(),
        "machine": clip(report.machine, MACHINE_MAX),
        "os": report.os,
        "stage": report.stage.wire(),
        "checks": checks,
    });
    if let Some(doing) = report.doing.filter(|doing| !doing.is_empty()) {
        body["doing"] = json!(clip(doing, DOING_MAX));
    }
    if let Some(env) = report.env.filter(|env| !env.is_empty()) {
        body["env"] = json!(clip(env, ENV_MAX));
    }
    if report.stage == Stage::Done {
        if let Some(outcome) = report.outcome {
            body["outcome"] = json!(outcome.wire());
        }
    }
    body
}

/// How old the machine agent's last upkeep pass may be and still ride a report: a pass runs every six hours, so two days
/// means the agent has stopped running it, and an old count would read as a machine that never converged.
const UPKEEP_FRESH_MS: u64 = 2 * 24 * 60 * 60 * 1000;
/// The contract's caps on the upkeep summary (`HostReportInputSchema.upkeep`).
const UPKEEP_KINDS_MAX: usize = 20;
const UPKEEP_KIND_MAX: usize = 40;
const UPKEEP_VERSION_MAX: usize = 40;

/// The machine agent's last upkeep pass (`~/.intentic/machine/upkeep.json`: its standing clean-up of what older
/// releases left on this computer) as a report's `upkeep`: the counts summed, the kinds it found, and the agent's
/// version, so the platform can tell whether a release brought machines to the current shape. None for a pass that is
/// missing, unreadable or stale. Pure.
pub fn upkeep_summary(raw: &Value, now_ms: u64) -> Option<Value> {
    let at = raw["at"].as_u64()?;
    if now_ms.saturating_sub(at) > UPKEEP_FRESH_MS {
        return None;
    }
    let sum = |key: &str| -> u64 {
        raw[key]
            .as_object()
            .map(|counts| counts.values().filter_map(Value::as_u64).sum())
            .unwrap_or(0)
    };
    let mut out = json!({
        "found": sum("found"),
        "fixed": sum("fixed"),
        "skipped": raw["skipped"].as_array().map_or(0, Vec::len),
    });
    if let Some(found) = raw["found"].as_object() {
        let kinds: serde_json::Map<String, Value> = found
            .iter()
            .filter_map(|(kind, count)| {
                count
                    .as_u64()
                    .map(|count| (clip(kind, UPKEEP_KIND_MAX), json!(count)))
            })
            .take(UPKEEP_KINDS_MAX)
            .collect();
        if !kinds.is_empty() {
            out["kinds"] = Value::Object(kinds);
        }
    }
    if let Some(version) = raw["version"]
        .as_str()
        .filter(|version| !version.is_empty())
    {
        out["agentVersion"] = json!(clip(version, UPKEEP_VERSION_MAX));
    }
    Some(out)
}

/// A finished report with the upkeep summary on it, when there is one.
pub fn with_upkeep(mut body: Value, upkeep: Option<&Value>) -> Value {
    if let Some(upkeep) = upkeep {
        body["upkeep"] = upkeep.clone();
    }
    body
}

/// Clip to `max` characters on a char boundary, marking the cut: the platform counts code points.
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The contract's own source, read at test time: the lists below are derived from it, not transcribed.
    fn contract() -> String {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../_shared/api-contract/src/ingress/ingress-schemas.ts"
        );
        std::fs::read_to_string(path).expect("the api contract is in this repository")
    }

    /// The quoted strings between `start` and the next `end` in the contract's source.
    fn quoted_after(source: &str, start: &str, end: &str) -> Vec<String> {
        let from = source.find(start).expect(start) + start.len();
        let rest = &source[from..];
        let body = &rest[..rest.find(end).expect(end)];
        body.split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn the_check_ids_are_the_contracts_in_its_order() {
        let ids = quoted_after(&contract(), "export const HOST_CHECKS = [", "]");
        assert_eq!(ids, ORDER.to_vec());
    }

    #[test]
    fn every_wire_word_is_one_the_contract_accepts() {
        let source = contract();
        let schema = &source[source
            .find("export const HostCheckSchema")
            .expect("HostCheckSchema")..];
        let states = quoted_after(schema, "state: z.enum([", "]");
        for state in [
            State::Ok,
            State::Warn,
            State::Fail,
            State::Fixing,
            State::Skip,
        ] {
            assert!(states.contains(&state.wire().to_string()), "{state:?}");
        }
        let fixes = quoted_after(schema, "fix: z.enum([", "]");
        assert_eq!(
            fixes,
            vec!["auto", "consent", "you"],
            "the three categories, in the contract's own order"
        );
        let input = &source[source
            .find("export const HostReportInputSchema")
            .expect("input schema")..];
        let sources = quoted_after(input, "source: z.enum([", "]");
        for s in [Source::Agent, Source::Command, Source::App] {
            assert!(sources.contains(&s.wire().to_string()));
        }
        let oses = quoted_after(input, "os: z.enum([", "]");
        assert_eq!(oses, vec!["windows", "linux", "macos", "wsl"]);
        let stages = quoted_after(input, "stage: z.enum([", "]");
        for stage in [Stage::Checking, Stage::Fixing, Stage::Asking, Stage::Done] {
            assert!(stages.contains(&stage.wire().to_string()));
        }
        let outcomes = quoted_after(input, "outcome: z.enum([", "]");
        for outcome in [
            Outcome::Healthy,
            Outcome::Fixed,
            Outcome::NeedsYou,
            Outcome::Failed,
        ] {
            assert!(outcomes.contains(&outcome.wire().to_string()));
        }
    }

    #[test]
    fn the_report_carries_exactly_the_contracts_field_names() {
        let checks = vec![
            Check::ok(DOCKER),
            Check::fail(
                CONTAINER,
                "the container is stopped.",
                "ic sandbox start sandbox-abc",
                Fix::Do(Repair::Start),
            ),
            Check::skip(DAEMON, "unknowable while the container is down"),
        ];
        let body = wire(&Report {
            source: Source::Agent,
            machine: "ada-laptop",
            os: "windows",
            env: None,
            stage: Stage::Done,
            doing: None,
            outcome: Some(Outcome::NeedsYou),
            checks: &checks,
        });
        assert_eq!(
            body,
            json!({
                "source": "agent",
                "machine": "ada-laptop",
                "os": "windows",
                "stage": "done",
                "outcome": "needs-you",
                "checks": [
                    { "id": "docker", "label": "Docker engine", "state": "ok" },
                    {
                        "id": "container",
                        "label": "Sandbox container",
                        "state": "fail",
                        "problem": "the container is stopped.",
                        "remedy": "ic sandbox start sandbox-abc",
                        "fix": "auto"
                    },
                    { "id": "daemon", "label": "Daemon health", "state": "skip" }
                ]
            })
        );
    }

    #[test]
    fn the_agents_upkeep_pass_rides_a_report_summed_and_only_while_fresh() {
        let now = 1_800_000_000_000_u64;
        let raw = json!({
            "at": now - 60_000,
            "version": "1.330.0",
            "found": { "retired-generation": 2, "stale-pairing": 3 },
            "fixed": { "retired-generation": 2 },
            "skipped": [{ "kind": "second-ic", "what": "/usr/local/bin/ic", "why": "needs sudo" }],
        });
        assert_eq!(
            upkeep_summary(&raw, now),
            Some(json!({
                "found": 5,
                "fixed": 2,
                "skipped": 1,
                "kinds": { "retired-generation": 2, "stale-pairing": 3 },
                "agentVersion": "1.330.0",
            }))
        );
        assert_eq!(
            upkeep_summary(&raw, now + 3 * 24 * 60 * 60 * 1000),
            None,
            "a pass two days old says nothing"
        );
        assert_eq!(upkeep_summary(&json!({}), now), None, "no pass, no summary");
        let body = with_upkeep(
            json!({ "stage": "done" }),
            upkeep_summary(&raw, now).as_ref(),
        );
        assert_eq!(body["upkeep"]["found"], json!(5));
        assert_eq!(
            with_upkeep(json!({ "stage": "done" }), None).get("upkeep"),
            None
        );
    }

    #[test]
    fn doing_rides_while_fixing_and_outcome_only_when_done() {
        let body = wire(&Report {
            source: Source::Command,
            machine: "m",
            os: "linux",
            env: Some("archlinux"),
            stage: Stage::Fixing,
            doing: Some("Starting Docker Desktop"),
            outcome: Some(Outcome::Fixed),
            checks: &[],
        });
        assert_eq!(body["doing"], json!("Starting Docker Desktop"));
        assert_eq!(body["env"], json!("archlinux"));
        assert_eq!(body.get("outcome"), None);
        let long = "x".repeat(400);
        let clipped = wire(&Report {
            source: Source::App,
            machine: &long,
            os: "macos",
            env: None,
            stage: Stage::Asking,
            doing: Some(&long),
            outcome: None,
            checks: &[],
        });
        assert_eq!(
            clipped["doing"].as_str().map(|s| s.chars().count()),
            Some(300)
        );
        assert_eq!(
            clipped["machine"].as_str().map(|s| s.chars().count()),
            Some(120)
        );
    }

    #[test]
    fn the_category_is_the_repairs_own() {
        for auto in [
            Repair::StartDesktop,
            Repair::Tidy,
            Repair::Start,
            Repair::Watch,
            Repair::Restart,
            Repair::RetireSidecar,
        ] {
            assert_eq!(auto.who(), Who::Auto, "{auto:?}");
        }
        for consent in [
            Repair::RestartDesktop,
            Repair::ShutdownWsl,
            Repair::ReapplyIntegration,
            Repair::LinuxContainers,
            Repair::StartEngine,
            Repair::AutoStart,
            Repair::Prerequisite("wsl-features"),
            Repair::PruneBuilder,
            Repair::StartHeld,
            Repair::RestartBusy,
            Repair::RestartAgain,
            Repair::Rollback,
            Repair::RaiseMemory(12),
        ] {
            assert_eq!(consent.who(), Who::Consent, "{consent:?}");
        }
        assert!(Repair::Tidy.host());
        assert!(!Repair::StartHeld.host());
        assert!(!Repair::RestartBusy.host());
        assert!(!Repair::RestartAgain.host());
        assert!(!Repair::RetireSidecar.host());
        assert!(Repair::RestartBusy
            .question(Some("sandbox-0123456789ab"))
            .contains("mid-turn, and a restart cuts them"));
        assert_eq!(Check::fail(DISK, "p", "r", Fix::You).who(), Some(Who::You));
        assert_eq!(Check::ok(DISK).who(), None);
    }

    fn failing(fix: Fix) -> Check {
        Check::fail(
            CONTAINER,
            "it is stopped.",
            "start it: ic sandbox start",
            fix,
        )
    }

    #[test]
    fn outcomes_follow_what_is_left_and_whether_anything_was_tried() {
        let warned = Check::warn(DOCKER_APP, "Docker Desktop does not start at sign-in.");
        assert_eq!(
            outcome(&[Check::ok(DOCKER), warned.clone()], 0, false),
            Outcome::Healthy
        );
        assert_eq!(outcome(&[Check::ok(DOCKER)], 2, true), Outcome::Fixed);
        assert_eq!(outcome(&[failing(Fix::You)], 1, true), Outcome::NeedsYou);
        assert_eq!(
            outcome(&[failing(Fix::Do(Repair::Rollback))], 0, true),
            Outcome::NeedsYou,
            "a consent nobody gave is left for a person"
        );
        assert_eq!(
            outcome(&[failing(Fix::Do(Repair::Start))], 0, true),
            Outcome::Failed,
            "an automatic fix that ran and left its check failing did not take"
        );
        assert_eq!(
            outcome(&[failing(Fix::Do(Repair::Start))], 0, false),
            Outcome::NeedsYou,
            "doctor tries nothing, so nothing it names failed"
        );
    }

    #[test]
    fn the_run_ends_on_one_clear_sentence() {
        assert_eq!(
            verdict(Outcome::Healthy, 0, &[]),
            "Your sandbox is running and reachable — return to your browser."
        );
        assert_eq!(
            verdict(Outcome::Fixed, 1, &[]),
            "Fixed 1 thing; your sandbox is back — return to your browser."
        );
        assert_eq!(
            verdict(Outcome::Fixed, 3, &[]),
            "Fixed 3 things; your sandbox is back — return to your browser."
        );
        let one = Check::fail(
            DOCKER_APP,
            "Docker Desktop is waiting on a dialog.",
            "open Docker Desktop and finish what it shows",
            Fix::You,
        );
        assert_eq!(
            verdict(Outcome::NeedsYou, 0, &[&one]),
            "One thing is left for you: open Docker Desktop and finish what it shows."
        );
        assert_eq!(
            verdict(Outcome::NeedsYou, 2, &[&one]),
            "Fixed 2 things. One thing is left for you: open Docker Desktop and finish what it shows."
        );
        let two = failing(Fix::You);
        assert_eq!(
            verdict(Outcome::NeedsYou, 0, &[&one, &two]),
            "2 things are left for you, each with its fix below."
        );
    }

    #[test]
    fn exit_codes_separate_done_waiting_on_consent_waiting_on_windows_and_stuck() {
        let consent = failing(Fix::Do(Repair::StartHeld));
        let you = failing(Fix::You);
        assert_eq!(exit_code(&[], false, true), 0);
        assert_eq!(exit_code(&[&consent], true, false), 4);
        assert_eq!(
            exit_code(&[&consent], false, false),
            3,
            "only consent is missing and nobody could be asked"
        );
        assert_eq!(
            exit_code(&[&consent], false, true),
            1,
            "a person was asked and said no"
        );
        assert_eq!(exit_code(&[&consent, &you], false, false), 1);
    }

    #[test]
    fn the_block_under_a_verdict_names_each_failure_with_its_fix() {
        let one = failing(Fix::You);
        let block = left_block(&[(Some("sandbox-abc"), &one)]);
        assert_eq!(
            block,
            "\n  1. Sandbox container (sandbox-abc)\n     problem: it is stopped.\n     fix:     start it: ic sandbox start\n"
        );
    }
}
