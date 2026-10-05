pub mod chain;
pub mod clock;
pub mod desktop;
pub mod host;
pub mod model;
pub mod repair;
pub mod report;

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use desktop::Applied;
use host::{DeviceFacts, Os};
use model::{Check, Outcome, Repair, Source, Stage, State, Who};
use report::{Poster, Target};

use crate::ui::{self, RowOutcome};
use crate::util::{Fail, Result};

/* `ic sandbox fix` AND `ic sandbox doctor` — ONE ENGINE. Every layer between this machine and a sandbox is checked in
order (model::ORDER), each with a deadline. Then, unless this is doctor: the automatic fixes (safe, and applied
unasked, the machine agent's `--auto` included), a re-check, and the fixes that need a yes, one question at a time,
each followed by a re-check. The run ends on one sentence and an exit code. While it runs, a sandbox with a report key
has its progress on the page that asked (report.rs). There is no command channel from the platform to this machine:
the page only ever reads what this reports. */

pub enum Mode {
    /// Read-only: check, name, never change anything or report.
    Doctor,
    Fix {
        /// Unattended: automatic fixes only, nothing asked.
        auto: bool,
        /// Every consent given in advance.
        yes: bool,
        /// Consent given in advance for these check ids.
        accept: Vec<String>,
    },
}

pub struct Args {
    pub slug: Option<String>,
    pub code: Option<String>,
    pub mode: Mode,
    pub json: bool,
    pub source: Source,
}

/// How many repairs one run applies before it stops and reports: a loop that keeps finding something new to do is
/// a machine that changes under it faster than it can be fixed.
const MAX_REPAIRS: usize = 12;

/// Where a repair applies: the machine (None), or one sandbox.
type Scope = Option<String>;

struct Sandbox {
    slug: String,
    facts: chain::ChainFacts,
    /// Its own checks: container, daemon, registration, tunnel.
    own: Vec<Check>,
    /// The network check, for the platform and edge this sandbox uses.
    network: Check,
}

struct Snapshot {
    host: DeviceFacts,
    /// prerequisites, docker-app, docker, wsl, disk, agent: whichever apply here.
    host_checks: Vec<Check>,
    sandboxes: Vec<Sandbox>,
}

impl Snapshot {
    /// One sandbox's report: the machine's checks and its own, in the contract's order.
    fn checks_of(&self, sandbox: &Sandbox) -> Vec<Check> {
        let mut checks: Vec<Check> = self
            .host_checks
            .iter()
            .chain(sandbox.own.iter())
            .chain(std::iter::once(&sandbox.network))
            .cloned()
            .collect();
        checks.sort_by_key(|check| model::ORDER.iter().position(|id| *id == check.id));
        checks
    }

    /// The check a repair came from, where it stands now.
    fn check(&self, scope: &Scope, id: &str) -> Option<&Check> {
        match scope {
            None => self.host_checks.iter().find(|check| check.id == id),
            Some(slug) => self
                .sandboxes
                .iter()
                .find(|sandbox| &sandbox.slug == slug)
                .and_then(|sandbox| {
                    sandbox
                        .own
                        .iter()
                        .chain(std::iter::once(&sandbox.network))
                        .find(|check| check.id == id)
                }),
        }
    }
}

struct Engine {
    os: Os,
    doctor: bool,
    auto: bool,
    yes: bool,
    accept: Vec<String>,
    json: bool,
    source: Source,
    /// The one sandbox asked for, when one was.
    explicit: Option<String>,
    slugs: Vec<String>,
    tried: HashSet<(Scope, Repair)>,
    declined: HashSet<(Scope, Repair)>,
    /// A consent was needed and nobody could be asked (exit 3).
    unasked: bool,
    /// Repairs that took, per scope.
    fixed: HashMap<Scope, usize>,
    attempted: bool,
    /// A Windows restart or sign-out stands in the way (exit 4).
    session: bool,
    oom_seen: HashSet<String>,
    networks: HashMap<(String, Option<String>), Check>,
    shown: HashMap<(Scope, &'static str), (State, Option<String>)>,
    poster: Poster,
    targets: HashMap<String, Target>,
    /// PLATFORM_URL, or the platform ic always talks to.
    default_platform: String,
    /// PLATFORM_URL was set: it wins over what a container says.
    platform_forced: bool,
    machine: String,
    /// Per sandbox, whether an unattended run leaves it to the other side of this computer, and which side that is:
    /// read once per run, off the container's env.
    sides: HashMap<String, Option<String>>,
}

pub fn run(args: Args) -> Result<()> {
    if args.json {
        ui::send_human_to_stderr();
    }
    let (doctor, auto, yes, accept) = match args.mode {
        Mode::Doctor => (true, false, false, Vec::new()),
        Mode::Fix { auto, yes, accept } => (false, auto, yes, accept),
    };
    let forced = std::env::var("PLATFORM_URL")
        .ok()
        .filter(|url| !url.is_empty());
    let default_platform = forced
        .clone()
        .unwrap_or_else(|| "https://api.intentic.dev".to_string())
        .trim_end_matches('/')
        .to_string();
    let mut explicit = args.slug.map(|slug| named(&slug));
    if !doctor {
        if let Some(code) = args.code.filter(|code| !code.is_empty()) {
            match report::claim(&default_platform, &code) {
                Ok(Some(claimed)) => {
                    let slug = format!("sandbox-{}", claimed.sandbox);
                    crate::record::remember_report(&slug, &claimed.key, Some(&default_platform));
                    explicit = Some(slug);
                }
                Ok(None) => ui::warn(
                    "that fix code is unknown or older than 30 minutes, so your browser will not see this run — copy the command again from your browser to watch it there. Fixing anyway.",
                ),
                Err(fail) => ui::warn(&format!(
                    "{}\nFixing anyway, without reporting to your browser.",
                    fail.0
                )),
            }
        }
    }
    let mut engine = Engine {
        os: Os::detect(),
        doctor,
        auto,
        yes,
        accept,
        json: args.json,
        source: args.source,
        slugs: explicit.iter().cloned().collect(),
        explicit,
        tried: HashSet::new(),
        declined: HashSet::new(),
        unasked: false,
        fixed: HashMap::new(),
        attempted: false,
        session: false,
        oom_seen: HashSet::new(),
        networks: HashMap::new(),
        shown: HashMap::new(),
        poster: Poster::start(),
        targets: HashMap::new(),
        default_platform,
        platform_forced: forced.is_some(),
        machine: crate::sandbox::connect::machine_label(),
        sides: HashMap::new(),
    };
    engine.go()
}

/// A sandbox's 12-hex id names the `sandbox-<id>` it runs as, the way the platform's pages name it.
fn named(given: &str) -> String {
    if given.starts_with("sandbox-") || report::tunnel_id(given).is_none() {
        return given.to_string();
    }
    let prefixed = format!("sandbox-{given}");
    let known = crate::record::record_path(&prefixed).exists()
        || docker_knows(&crate::sandbox::container_of(&prefixed));
    if known && !docker_knows(&crate::sandbox::container_of(given)) {
        prefixed
    } else {
        given.to_string()
    }
}

fn docker_knows(container: &str) -> bool {
    matches!(
        crate::docker::ask(
            &["inspect", "--format", "{{.Id}}", container],
            crate::docker::READ_LIMIT
        ),
        crate::docker::Asked::Said(_)
    )
}

/// Every sandbox on this machine: its containers when the engine answers, else the channel records ic keeps for
/// them, which is what lets a machine whose Docker is down still say which sandboxes it is down for.
fn discover(engine_up: bool) -> Vec<String> {
    if engine_up {
        let filter = format!("name=^{}", crate::sandbox::CONTAINER_PREFIX);
        if let Some(names) = crate::docker::ask(
            &["ps", "-a", "--filter", &filter, "--format", "{{.Names}}"],
            crate::docker::READ_LIMIT,
        )
        .said()
        {
            let names: Vec<String> = names
                .lines()
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect();
            return crate::sandbox::slugs_of(&names);
        }
    }
    let mut slugs: Vec<String> = std::fs::read_dir(crate::logfile::intentic_home())
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    name.strip_prefix("sandbox-")
                        .and_then(|rest| rest.strip_suffix(".channel"))
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    slugs.sort();
    slugs
}

/// The side to leave a sandbox to: the one that created it, when that is not this one. A container from before
/// HOST_PLATFORM is anyone's. Pure.
fn elsewhere(created: Option<&str>, here: &str) -> Option<String> {
    created
        .filter(|created| !created.eq_ignore_ascii_case(here))
        .map(str::to_string)
}

/// How a side is called where a person reads it.
fn side_name(side: &str) -> &str {
    match side {
        "windows" => "Windows",
        "linux" => "WSL or Linux",
        other => other,
    }
}

/// Said for a sandbox an unattended run left to the side that created it. Pure.
fn elsewhere_sentence(side: &str) -> String {
    format!(
        "left alone: ic on {} created it, and the machine agent there keeps it.",
        side_name(side)
    )
}

/// The `--json` answer for such a sandbox: settled as far as this side goes, with nothing checked. Never posted: the
/// side that keeps it reports for it. Pure.
fn elsewhere_report(side: &str) -> serde_json::Value {
    serde_json::json!({
        "stage": Stage::Done.wire(),
        "outcome": "elsewhere",
        "doing": elsewhere_sentence(side),
        "checks": [],
    })
}

/// What a repair is doing, and the finding that made it: an unasked restart that cuts every running turn has to say
/// why in the log the machine agent keeps. Bounded by what the platform stores for `doing`. Pure.
fn doing_because(repair: &Repair, check: Option<&Check>) -> String {
    let doing = repair.doing();
    let Some(problem) =
        check.and_then(|check| check.problem.as_deref().map(|problem| (check.id, problem)))
    else {
        return doing;
    };
    let said = format!(
        "{doing}, because {}: {}",
        model::label(problem.0),
        problem.1
    );
    if said.chars().count() <= DOING_MAX {
        return said;
    }
    let mut cut: String = said.chars().take(DOING_MAX - 1).collect();
    cut.push('…');
    cut
}

/// The platform's limit on `doing` (@intentic/api-contract's HostReportInputSchema).
const DOING_MAX: usize = 300;

/// The next repair to make, in check order: every automatic one before any that needs a yes. Pure.
fn next(
    snapshot: &Snapshot,
    tried: &HashSet<(Scope, Repair)>,
    declined: &HashSet<(Scope, Repair)>,
) -> Option<(Scope, &'static str, Repair)> {
    let mut candidates: Vec<(Scope, &Check)> = snapshot
        .host_checks
        .iter()
        .map(|check| (None, check))
        .collect();
    for sandbox in &snapshot.sandboxes {
        for check in sandbox.own.iter().chain(std::iter::once(&sandbox.network)) {
            candidates.push((Some(sandbox.slug.clone()), check));
        }
    }
    candidates.sort_by_key(|(_, check)| model::ORDER.iter().position(|id| *id == check.id));
    let open = |who: Who| {
        candidates.iter().find_map(|(scope, check)| {
            let repair = check.repair()?;
            if repair.who() != who || !matches!(check.state, State::Fail | State::Warn) {
                return None;
            }
            // A machine repair offered by a sandbox's check (none today) is still the machine's.
            let scope = if repair.host() { None } else { scope.clone() };
            let key = (scope.clone(), repair.clone());
            (!tried.contains(&key) && !declined.contains(&key))
                .then(|| (scope, check.id, repair.clone()))
        })
    };
    open(Who::Auto).or_else(|| open(Who::Consent))
}

impl Engine {
    fn go(&mut self) -> Result<()> {
        ui::note(&format!(
            "{} — checking this machine and {}…",
            if self.doctor { "doctor" } else { "fix" },
            match &self.explicit {
                Some(slug) => format!("sandbox {slug}"),
                None => "its sandboxes".to_string(),
            }
        ));
        let mut snapshot = self.examine(true);
        self.post(&snapshot, Stage::Checking, None, None);
        let mut repairs = 0;
        while !self.doctor && !self.session && repairs < MAX_REPAIRS {
            let Some((scope, id, repair)) = next(&snapshot, &self.tried, &self.declined) else {
                break;
            };
            if repair.who() == Who::Consent && !self.permitted(&snapshot, &scope, id, &repair) {
                self.declined.insert((scope, repair));
                continue;
            }
            repairs += 1;
            let took = self.repair(&snapshot, &scope, id, &repair);
            snapshot = self.examine(false);
            let closed = snapshot
                .check(&scope, id)
                .is_none_or(|check| check.state != State::Fail && check.repair() != Some(&repair));
            if took && closed {
                *self.fixed.entry(scope).or_insert(0) += 1;
            }
        }
        self.finish(snapshot)
    }

    /// Whether this consent is given: in advance (`--yes`, `--accept <check>`), or by a person at the terminal.
    fn permitted(&mut self, snapshot: &Snapshot, scope: &Scope, id: &str, repair: &Repair) -> bool {
        if self.auto {
            self.unasked = true;
            return false;
        }
        if self.yes || self.accept.iter().any(|accepted| accepted == id) {
            return true;
        }
        if !crate::tty::have_tty() {
            self.unasked = true;
            return false;
        }
        let question = repair.question(scope.as_deref());
        self.post(
            snapshot,
            Stage::Asking,
            Some(&question),
            scope.as_ref().map(|_| (scope, id)),
        );
        ui::suspend();
        let yes = crate::tty::confirm(&question, false);
        ui::resume();
        yes
    }

    /// Apply one repair and say how it went. True when it ran without an error.
    fn repair(
        &mut self,
        snapshot: &Snapshot,
        scope: &Scope,
        id: &'static str,
        repair: &Repair,
    ) -> bool {
        self.attempted = true;
        let doing = doing_because(repair, snapshot.check(scope, id));
        ui::note(&format!(
            "{doing}{}…",
            scope
                .as_ref()
                .map(|slug| format!(" ({slug})"))
                .unwrap_or_default()
        ));
        self.post(snapshot, Stage::Fixing, Some(&doing), Some((scope, id)));
        let result = repair::apply(repair, scope.as_deref(), &snapshot.host, !self.auto);
        self.tried.insert((scope.clone(), repair.clone()));
        match result {
            Ok(Applied::Now) => true,
            Ok(Applied::AfterRestart | Applied::AfterSignOut) => {
                self.session = true;
                ui::note(
                    "done — Windows applies it once this PC restarts, or you sign out and back in.",
                );
                false
            }
            Err(why) => {
                ui::warn(&format!("{doing} did not work: {why}"));
                false
            }
        }
    }

    /// The other side of this computer that created this sandbox, when an unattended run should leave it there. On
    /// Windows, ic on Windows and ic in WSL both drive Docker Desktop's one engine, and each side's machine agent runs
    /// its own keeper over every container that engine holds: two keepers, two unasked restarts of one sandbox, each
    /// side's own record of what it already tried. A container carries the side that created it (HOST_PLATFORM);
    /// that side's keeper is the one that keeps it. A person's own run still reaches every sandbox.
    fn side_of(&mut self, slug: &str) -> Option<String> {
        if let Some(side) = self.sides.get(slug) {
            return side.clone();
        }
        let created = chain::created_on(slug);
        let side = elsewhere(created.as_deref(), crate::sandbox::connect::host_platform());
        self.sides.insert(slug.to_string(), side.clone());
        side
    }

    fn examine(&mut self, first: bool) -> Snapshot {
        let patience = if self.doctor || !first {
            Duration::ZERO
        } else {
            host::WEDGE_PATIENCE
        };
        let host = host::gather(self.os, patience, self.source == Source::Agent);
        let engine_up = host.engine.up();
        if self.explicit.is_none() && (first || engine_up) {
            self.slugs = discover(engine_up);
        }
        if self.auto && engine_up {
            let mine: Vec<String> = self
                .slugs
                .clone()
                .into_iter()
                .filter(|slug| self.side_of(slug).is_none())
                .collect();
            self.slugs = mine;
        }
        let host_checks = {
            let tried = |repair: &Repair| self.tried.contains(&(None, repair.clone()));
            [
                host::prerequisites(&host, &tried),
                host::docker_app(&host, &tried),
                Some(host::docker(&host, &tried)),
                host::wsl_check(&host, &tried),
                Some(host::disk(&host, &tried)),
                Some(host::agent_check(&host)),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<Check>>()
        };
        let mut sandboxes = Vec::new();
        for slug in self.slugs.clone() {
            let facts = chain::gather(&slug, engine_up, self.oom_seen.contains(&slug));
            if facts.oom_seen {
                self.oom_seen.insert(slug.clone());
            }
            let own = {
                let scope = Some(slug.clone());
                let tried = |repair: &Repair| self.tried.contains(&(scope.clone(), repair.clone()));
                vec![
                    chain::container(&facts, engine_up, &tried),
                    chain::daemon(&facts, &tried),
                    chain::registration(&facts, &tried),
                    chain::tunnel(&facts, &tried),
                ]
            };
            let network = self.network_for(&facts);
            self.target(&facts);
            sandboxes.push(Sandbox {
                slug,
                facts,
                own,
                network,
            });
        }
        let snapshot = Snapshot {
            host,
            host_checks,
            sandboxes,
        };
        self.show(&snapshot, first);
        snapshot
    }

    /// The platform a sandbox reports to and registers with, as this machine reaches it.
    fn platform_of(&self, facts: &chain::ChainFacts) -> String {
        if self.platform_forced {
            return self.default_platform.clone();
        }
        facts
            .env
            .platform
            .as_deref()
            .map(report::from_host)
            .or_else(|| facts.record.report_platform.clone())
            .unwrap_or_else(|| self.default_platform.clone())
    }

    /// Checked once per platform and edge: the network is the machine's, whichever sandbox it is asked for.
    fn network_for(&mut self, facts: &chain::ChainFacts) -> Check {
        let key = (self.platform_of(facts), facts.env.ingress.clone());
        if let Some(check) = self.networks.get(&key) {
            return check.clone();
        }
        let check = host::network(&host::gather_network(&key.0, key.1.as_deref()));
        self.networks.insert(key, check.clone());
        check
    }

    /// Where this sandbox's reports go, when it has a key: the one its token yields, else the one kept for it.
    fn target(&mut self, facts: &chain::ChainFacts) {
        let Some(sandbox) = report::tunnel_id(&facts.slug) else {
            return;
        };
        let key = facts
            .env
            .token
            .as_deref()
            .map(report::report_key)
            .or_else(|| {
                crate::record::read(&facts.slug)
                    .ok()
                    .and_then(|record| record.report_key)
            });
        if let Some(key) = key {
            self.targets.insert(
                facts.slug.clone(),
                Target {
                    platform: self.platform_of(facts),
                    key,
                    sandbox,
                },
            );
        }
    }

    fn machine_of(&self, sandbox: &Sandbox) -> String {
        sandbox
            .facts
            .env
            .host_label
            .clone()
            .unwrap_or_else(|| self.machine.clone())
    }

    /// The rows, as they land: all of them the first time, then only the ones that changed.
    fn show(&mut self, snapshot: &Snapshot, first: bool) {
        let mut rows: Vec<(Scope, Check)> = snapshot
            .host_checks
            .iter()
            .map(|check| (None, check.clone()))
            .collect();
        for sandbox in &snapshot.sandboxes {
            for check in sandbox.own.iter().chain(std::iter::once(&sandbox.network)) {
                rows.push((Some(sandbox.slug.clone()), check.clone()));
            }
        }
        let mut heading: Option<Scope> = None;
        for (scope, check) in rows {
            let now = (check.state, check.problem.clone());
            let key = (scope.clone(), check.id);
            if !first && self.shown.get(&key) == Some(&now) {
                continue;
            }
            self.shown.insert(key, now);
            if heading.as_ref() != Some(&scope) {
                ui::note(&match &scope {
                    None => "this machine".to_string(),
                    Some(slug) => format!("sandbox {slug}"),
                });
                heading = Some(scope.clone());
            }
            row(&check);
        }
    }

    /// Report the stage to every sandbox with a key, and to `--json`'s reader. `fixing` marks the check being worked
    /// on (a machine's check on every sandbox's report).
    fn post(
        &self,
        snapshot: &Snapshot,
        stage: Stage,
        doing: Option<&str>,
        fixing: Option<(&Scope, &str)>,
    ) {
        if self.doctor {
            return;
        }
        if self.json {
            let slug = fixing.and_then(|(scope, _)| scope.as_deref());
            report::emit(&report::progress_line(slug, stage, doing));
        }
        for sandbox in &snapshot.sandboxes {
            let Some(target) = self.targets.get(&sandbox.slug) else {
                continue;
            };
            let mut checks = snapshot.checks_of(sandbox);
            if let (Some((scope, id)), Stage::Fixing) = (fixing, stage) {
                let ours = scope.as_ref().is_none_or(|slug| *slug == sandbox.slug);
                for check in checks.iter_mut().filter(|check| ours && check.id == id) {
                    check.state = State::Fixing;
                }
            }
            let machine = self.machine_of(sandbox);
            let body = model::wire(&model::Report {
                source: self.source,
                machine: &machine,
                os: self.os.wire(),
                stage,
                doing,
                outcome: None,
                checks: &checks,
            });
            self.poster.send(target, stage, body);
        }
    }

    fn fixed_for(&self, slug: &str) -> usize {
        self.fixed.get(&None).copied().unwrap_or(0)
            + self
                .fixed
                .get(&Some(slug.to_string()))
                .copied()
                .unwrap_or(0)
    }

    fn finish(&mut self, snapshot: Snapshot) -> Result<()> {
        // Every failure once: the machine's, then each sandbox's own, and a network failure shared by two sandboxes once.
        let mut left: Vec<(Option<&str>, &Check)> = snapshot
            .host_checks
            .iter()
            .filter(|c| c.failed())
            .map(|c| (None, c))
            .collect();
        for sandbox in &snapshot.sandboxes {
            for check in sandbox.own.iter().filter(|c| c.failed()) {
                left.push((Some(&sandbox.slug), check));
            }
            if sandbox.network.failed()
                && !left
                    .iter()
                    .any(|(_, c)| c.id == model::NETWORK && c.problem == sandbox.network.problem)
            {
                left.push((None, &sandbox.network));
            }
        }
        let session = self.session || left.iter().any(|(_, check)| check.session);

        let mut outcomes: Vec<(Option<String>, Outcome, Vec<&Check>)> = Vec::new();
        for sandbox in &snapshot.sandboxes {
            let checks = snapshot.checks_of(sandbox);
            let fixed = self.fixed_for(&sandbox.slug);
            let outcome = model::outcome(&checks, fixed, self.attempted);
            let body = model::wire(&model::Report {
                source: self.source,
                machine: &self.machine_of(sandbox),
                os: self.os.wire(),
                stage: Stage::Done,
                doing: None,
                outcome: Some(outcome),
                checks: &checks,
            });
            if self.json {
                report::emit(&report::result_line(&sandbox.slug, &body));
            }
            if let (false, Some(target)) = (self.doctor, self.targets.get(&sandbox.slug)) {
                self.poster.send(target, Stage::Done, body);
            }
            let theirs: Vec<&Check> = left
                .iter()
                .filter(|(slug, _)| slug.is_none_or(|slug| slug == sandbox.slug))
                .map(|(_, check)| *check)
                .collect();
            outcomes.push((Some(sandbox.slug.clone()), outcome, theirs));
        }
        let mut left_elsewhere: Vec<(&String, &String)> = self
            .sides
            .iter()
            .filter_map(|(slug, side)| side.as_ref().map(|side| (slug, side)))
            .collect();
        left_elsewhere.sort();
        for (slug, side) in &left_elsewhere {
            if self.json {
                report::emit(&report::result_line(slug, &elsewhere_report(side)));
            }
        }
        if snapshot.sandboxes.is_empty() {
            let outcome = model::outcome(&snapshot.host_checks, self.fixed_for(""), self.attempted);
            if self.json {
                let body = model::wire(&model::Report {
                    source: self.source,
                    machine: &self.machine,
                    os: self.os.wire(),
                    stage: Stage::Done,
                    doing: None,
                    outcome: Some(outcome),
                    checks: &snapshot.host_checks,
                });
                report::emit(&serde_json::json!({ "slug": null, "report": body }).to_string());
            }
            outcomes.push((
                None,
                outcome,
                left.iter().map(|(_, check)| *check).collect(),
            ));
        }
        self.poster.finish();

        if self.doctor {
            return self.doctor_ending(&snapshot, &left);
        }
        self.fix_ending(&snapshot, &outcomes, &left, &left_elsewhere);
        let code = model::exit_code(
            &left
                .iter()
                .map(|(_, check)| *check)
                .collect::<Vec<&Check>>(),
            session,
            !self.unasked,
        );
        let code = if snapshot.sandboxes.is_empty() && left_elsewhere.is_empty() && code == 0 {
            1
        } else {
            code
        };
        if code != 0 {
            std::process::exit(code);
        }
        Ok(())
    }

    fn fix_ending(
        &self,
        snapshot: &Snapshot,
        outcomes: &[(Option<String>, Outcome, Vec<&Check>)],
        left: &[(Option<&str>, &Check)],
        left_elsewhere: &[(&String, &String)],
    ) {
        for (slug, side) in left_elsewhere {
            ui::note(&format!("{slug}: {}", elsewhere_sentence(side)));
        }
        if snapshot.sandboxes.is_empty() && !left_elsewhere.is_empty() && left.is_empty() {
            return;
        }
        if snapshot.sandboxes.is_empty() && left.is_empty() {
            ui::note("there is no sandbox on this machine — run the setup command from your browser to set one up.");
            return;
        }
        let several = outcomes.len() > 1;
        for (slug, outcome, theirs) in outcomes {
            let fixed = slug
                .as_deref()
                .map_or(self.fixed_for(""), |slug| self.fixed_for(slug));
            let sentence = model::verdict(*outcome, fixed, theirs);
            match (several, slug) {
                (true, Some(slug)) => ui::note(&format!("{slug}: {sentence}")),
                _ => ui::note(&sentence),
            }
        }
        if left.len() > 1 {
            ui::note(&model::left_block(left));
        }
        if self.unasked
            && left
                .iter()
                .any(|(_, check)| check.who() == Some(Who::Consent))
        {
            ui::note(if self.auto {
                "the fixes above that need a yes were left alone: run `ic sandbox fix` in a terminal to be asked."
            } else {
                "nobody could be asked for the fixes above that need a yes: re-run with --yes, or --accept <check>, to go ahead."
            });
        }
    }

    /// Doctor's ending, as it always read: a probation or an interrupted swap named, then either every link checking
    /// out or the numbered block of what is broken, with the way back when a version before it is kept.
    fn doctor_ending(&self, snapshot: &Snapshot, left: &[(Option<&str>, &Check)]) -> Result<()> {
        for sandbox in &snapshot.sandboxes {
            if let Some(note) = chain::swap_note(&sandbox.facts.record, &sandbox.slug) {
                ui::note(&note);
            }
        }
        if left.is_empty() {
            let urls: Vec<&str> = snapshot
                .sandboxes
                .iter()
                .filter_map(|sandbox| sandbox.facts.env.public_url.as_deref())
                .collect();
            match urls.as_slice() {
                [url] => ui::note(&format!(
                    "every link checks out — the sandbox is reachable at {url}."
                )),
                _ if snapshot.sandboxes.is_empty() => {
                    ui::note("no sandbox on this machine to check.")
                }
                _ => ui::note("every checkable link checks out."),
            }
            return Ok(());
        }
        let count = crate::util::plural(left.len(), "problem");
        let mut text = format!(
            "found {count} — `ic sandbox fix` puts right what it can:\n{}",
            model::left_block(left)
        );
        if let [sandbox] = snapshot.sandboxes.as_slice() {
            if sandbox.facts.record.previous.is_some()
                && !sandbox.own.iter().all(|check| !check.failed())
            {
                text.push_str(&format!(
                    "\n       If this began with an update, go back to the version before it: ic sandbox rollback {}",
                    sandbox.slug
                ));
            }
        }
        Err(Fail(text))
    }
}

/// One check as a row: the same ok/warn/FAIL/skip column every diagnosis in this binary prints.
fn row(check: &Check) {
    let label = check.label();
    let problem = check.problem.as_deref().unwrap_or("");
    let note = check.note.as_deref().unwrap_or("");
    match check.state {
        State::Ok => ui::row(RowOutcome::Pass, label, note),
        State::Warn => ui::row(RowOutcome::Warn, label, problem),
        State::Fail => ui::row(RowOutcome::Fail, label, problem),
        State::Fixing => ui::row(RowOutcome::Warn, label, "fixing"),
        State::Skip => ui::row(RowOutcome::Skip, label, note),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::Fix;

    fn host_facts() -> DeviceFacts {
        DeviceFacts {
            os: Os::Linux,
            windows: None,
            desktop: host::Desktop::Absent,
            autostart: None,
            engine: crate::docker::Engine::Up("linux".to_string()),
            engine_service: None,
            wsl: host::Wsl::NotApplicable,
            free_gib: Some(100),
            disk_place: "/".to_string(),
            agent: host::Agent::Running,
        }
    }

    fn snapshot(host_checks: Vec<Check>, own: Vec<Check>) -> Snapshot {
        let facts = chain::ChainFacts {
            slug: "sandbox-0123456789ab".to_string(),
            record: crate::record::ChannelRecord::default(),
            env: chain::Env::default(),
            container: chain::Container::Unknown,
            sidecar_running: None,
            oom_seen: false,
            health: chain::Health::NotAsked,
            boot_failure: None,
            engine_memory: None,
            public: chain::Public::NotAsked,
            live_turns: None,
            now_ms: 0,
        };
        Snapshot {
            host: host_facts(),
            host_checks,
            sandboxes: vec![Sandbox {
                slug: "sandbox-0123456789ab".to_string(),
                facts,
                own,
                network: Check::ok(model::NETWORK),
            }],
        }
    }

    #[test]
    fn automatic_fixes_go_first_and_a_declined_consent_is_not_asked_again() {
        let snapshot = snapshot(
            vec![Check::fail(
                model::DOCKER,
                "stuck",
                "restart it",
                Fix::Do(Repair::RestartDesktop),
            )],
            vec![Check::fail(
                model::CONTAINER,
                "stopped",
                "start it",
                Fix::Do(Repair::Start),
            )],
        );
        let none = HashSet::new();
        let first = next(&snapshot, &none, &none).expect("something to do");
        assert_eq!(
            first,
            (
                Some("sandbox-0123456789ab".to_string()),
                model::CONTAINER,
                Repair::Start
            )
        );
        let mut tried = HashSet::new();
        tried.insert((Some("sandbox-0123456789ab".to_string()), Repair::Start));
        let second = next(&snapshot, &tried, &none).expect("the consent is next");
        assert_eq!(second, (None, model::DOCKER, Repair::RestartDesktop));
        let mut declined = HashSet::new();
        declined.insert((None, Repair::RestartDesktop));
        assert_eq!(next(&snapshot, &tried, &declined), None);
    }

    #[test]
    fn an_unattended_run_leaves_a_sandbox_to_the_side_of_this_computer_that_created_it() {
        assert_eq!(
            elsewhere(Some("linux"), "windows").as_deref(),
            Some("linux")
        );
        assert_eq!(
            elsewhere(Some("windows"), "linux").as_deref(),
            Some("windows")
        );
        assert_eq!(elsewhere(Some("linux"), "linux"), None);
        assert_eq!(elsewhere(Some("Windows"), "windows"), None);
        assert_eq!(
            elsewhere(None, "windows"),
            None,
            "a container from before HOST_PLATFORM is anyone's"
        );
        let report = elsewhere_report("linux");
        assert_eq!(report["outcome"], "elsewhere");
        assert_eq!(report["stage"], "done");
        assert!(report["doing"]
            .as_str()
            .is_some_and(|said| said.contains("ic on WSL or Linux created it")));
    }

    #[test]
    fn a_repair_says_the_finding_that_made_it() {
        let check = Check::fail(
            model::DAEMON,
            "the daemon inside the container does not answer /health.",
            "restart it",
            Fix::Do(Repair::Restart),
        );
        assert_eq!(
            doing_because(&Repair::Restart, Some(&check)),
            "Restarting the sandbox, because Daemon health: the daemon inside the container does not answer /health."
        );
        assert_eq!(
            doing_because(&Repair::Restart, None),
            "Restarting the sandbox"
        );
        let long = Check::fail(
            model::TUNNEL,
            "x".repeat(400),
            "r",
            Fix::Do(Repair::Restart),
        );
        let said = doing_because(&Repair::Restart, Some(&long));
        assert_eq!(said.chars().count(), DOING_MAX);
        assert!(said.ends_with('…'));
    }

    #[test]
    fn a_sandboxs_report_is_the_machines_checks_and_its_own_in_the_contracts_order() {
        let snapshot = snapshot(
            vec![
                Check::ok(model::DOCKER),
                Check::ok(model::AGENT),
                Check::ok(model::DISK),
            ],
            vec![Check::ok(model::CONTAINER), Check::ok(model::TUNNEL)],
        );
        let ids: Vec<&str> = snapshot
            .checks_of(&snapshot.sandboxes[0])
            .iter()
            .map(|check| check.id)
            .collect();
        assert_eq!(
            ids,
            vec!["docker", "disk", "container", "network", "tunnel", "agent"]
        );
    }
}
