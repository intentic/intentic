pub mod facts;
pub mod policy;
pub mod render;
pub mod status;

use std::collections::{BTreeSet, HashMap};
use std::io::BufRead as _;
use std::time::Duration;

use serde_json::Value;

use crate::docker;
use crate::record;
use crate::sandbox::intent::{self, Action};
use crate::sandbox::lock::{self, Wait};
use crate::sandbox::{container_of, side, CONTAINER_PREFIX, PARKED_SUFFIX};
use crate::ui;
use crate::util::{bail, Result};
use facts::{Container, Net, Network, NoFence};
use policy::{Baseline, Kind, Policy, Profile};
use render::{Change, Way};
use status::Applied;

/* `ic sandbox egress` — WHAT A SANDBOX MAY REACH AROUND THE MACHINE IT RUNS ON (2026-10-27).

A sandbox reaches the internet and, through Docker's NAT, whatever its host reaches: the owner's LAN, the host itself,
networks behind a VPN, link-local metadata. Its agent is root in the container and may hold NET_ADMIN or run privileged,
so the fence lives in the host's network namespace, as nftables rules ic owns (render.rs says which and why). The
policy is the sandbox's channel record's (`egress_policy`, record.rs), so every restart path keeps it; the machine's
own word over it is `/etc/intentic/os.json`'s `egress` on Intentic OS, else `~/.intentic/egress.json`.

The rules go in through a short-lived helper container on the engine's host network, started from an image the engine
already has (the sandbox's own: it ships `nft`), never pulled. That reaches the right namespace wherever docker is: a
Linux server, ic's WSL engine, Intentic OS, Docker Desktop's VM, a remote engine.

FAIL CLOSED. A sandbox whose effective policy is not open, running, whose rules cannot be put in, is stopped, with the
reason left in its restart intent, and its status says `failed` with the same reason. An engine that cannot take rules
at all (no nftables in its kernel, an image without nft) is `unsupported`: the policy is held and nothing enforces it.

ic checks no signature and no tightening: its local caller is the machine's owner. The machine agent is the gate for a
change that comes from anywhere else. */

/// How long one helper run may take: an image start and one nft transaction.
const HELPER_LIMIT: Duration = Duration::from_secs(60);
/// The file inside the sandbox the status is written to (the contract's EGRESS_STATUS_FILE).
pub const STATUS_FILE: &str = "/run/intentic/egress.json";
/// What the helper's read prints between the resolvers and the table.
const MARK: &str = "@@ic-egress@@";

/* ---- The machine's baseline ---- */

/// The machine's baseline, with a sentence for anything in it that did not read.
pub fn baseline() -> (Baseline, Vec<String>) {
    if let Some(on_os) = crate::os::policy::egress(&crate::os::Paths::here()) {
        return on_os;
    }
    let path = crate::logfile::intentic_home().join("egress.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (Baseline::default(), Vec::new());
    };
    let name = path.display().to_string();
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => policy::baseline_over(Baseline::default(), &name, &value),
        Err(_) => (
            Baseline {
                minimum: Profile::InternetOnly,
                never_allow: Vec::new(),
            },
            vec![format!(
                "{name} is not JSON; every sandbox is held at internet-only until it reads."
            )],
        ),
    }
}

/* ---- What docker says ---- */

/// One container's inspect object, None when docker has no such container (or did not answer).
fn inspect_container(name: &str) -> Option<Value> {
    let ran = docker::capture_bounded(
        &["inspect", "--type", "container", name],
        docker::READ_LIMIT,
    )
    .ok()?;
    let parsed: Value = serde_json::from_str(&ran.stdout).ok()?;
    parsed.as_array()?.first().cloned()
}

/// The networks named, each docker knows; a missing one is left out.
fn inspect_networks(names: &[String]) -> Vec<Network> {
    if names.is_empty() {
        return Vec::new();
    }
    let mut args: Vec<&str> = vec!["network", "inspect"];
    args.extend(names.iter().map(String::as_str));
    docker::capture_bounded(&args, docker::READ_LIMIT)
        .ok()
        .and_then(|ran| serde_json::from_str::<Value>(&ran.stdout).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(facts::network)
        .collect()
}

/// What one sandbox's fence is read from.
struct Seen {
    slug: String,
    inspected: Option<Value>,
    container: Option<Container>,
    networks: Vec<Network>,
}

fn see(slug: &str) -> Seen {
    let inspected = inspect_container(&container_of(slug));
    let container = inspected.as_ref().map(facts::container);
    let mut names: Vec<String> = container
        .iter()
        .flat_map(|container| {
            container
                .attachments
                .iter()
                .map(|attachment| attachment.network.clone())
        })
        .collect();
    let own = crate::sandbox::trash::network(slug);
    if !names.contains(&own) {
        names.push(own);
    }
    // No container (removed, or between Compose's remove and create): the shared networks ic fenced it on before, so
    // they stay fenced (facts.rs `fence`). One that is gone is left out by docker, and its fence with it.
    if container.is_none() {
        for name in status::read_applied(slug)
            .map(|applied| applied.fenced_networks)
            .unwrap_or_default()
        {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    Seen {
        slug: slug.to_string(),
        networks: inspect_networks(&names),
        inspected,
        container,
    }
}

/// Whether another side of this computer keeps the sandbox (side.rs): its policy is that side's, and so are its rules.
fn kept_elsewhere(seen: &Seen) -> Option<side::Side> {
    seen.inspected
        .as_ref()
        .and_then(side::created_on_inspected)
        .and_then(|created| side::elsewhere(Some(&created), &side::here()))
}

/* ---- The helper ---- */

/// What a helper run came to.
#[derive(Debug)]
enum Helper {
    Ran(String),
    /// The engine cannot take rules: said for the status.
    Unsupported(String),
    /// It ran and refused, or could not be run.
    Failed(String),
}

/// The images the helper may start from: `IC_EGRESS_IMAGE` first, then the images the engine's sandboxes run, which the
/// engine already holds (nothing is ever pulled: an engine may reach no registry).
fn helper_images(preferred: &[String]) -> Vec<String> {
    let mut images: Vec<String> = Vec::new();
    let mut push = |image: String| {
        if !image.is_empty() && !images.contains(&image) {
            images.push(image);
        }
    };
    if let Ok(image) = std::env::var("IC_EGRESS_IMAGE") {
        push(image);
    }
    for image in preferred {
        push(image.clone());
    }
    if let Some(names) = docker::ps_names(true, &format!("^{CONTAINER_PREFIX}")) {
        for name in names.iter().take(8) {
            if let Some(image) = docker::inspect(name, "{{.Image}}") {
                push(image);
            }
        }
    }
    images
}

/// The `docker run` that starts the helper: the host's network, NET_ADMIN and nothing else, as root, never pulled. Pure.
fn helper_args(name: &str, entrypoint: &str, image: &str, args: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        "--network",
        "host",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--user",
        "0:0",
        "--pull",
        "never",
        "--log-driver",
        "none",
        "--label",
        "dev.intentic.kind=egress-helper",
        "--entrypoint",
        entrypoint,
        image,
    ]
    .iter()
    .map(|word| word.to_string())
    .collect();
    out.extend(args.iter().map(|arg| arg.to_string()));
    out
}

/// Whether docker said the image has no such program, so the next image is tried. Pure.
fn missing_program(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("executable file not found")
        || lower.contains("no such file or directory: unknown")
}

/// Whether nft's own refusal says the kernel has no nf_tables (or no part the rules use). Pure.
fn kernel_cannot(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("protocol not supported")
        || lower.contains("operation not supported")
        || lower.contains("address family not supported")
}

fn run_helper(images: &[String], entrypoint: &str, args: &[&str], input: &[u8]) -> Helper {
    if images.is_empty() {
        return Helper::Unsupported(
            "no image on this engine to put the rules in with: the rules go in from a sandbox's own image, and none is here yet".to_string(),
        );
    }
    for (attempt, image) in images.iter().enumerate() {
        let name = format!("intentic-egress-{}-{attempt}", std::process::id());
        let argv = helper_args(&name, entrypoint, image, args);
        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let ran = intentic_bounded::capture_with_input(
            docker::command(&refs),
            input,
            HELPER_LIMIT,
            intentic_bounded::Reach::Child,
        );
        let ran = match ran {
            Ok(ran) => ran,
            Err(err) => return Helper::Failed(format!("docker could not be run: {err}")),
        };
        if ran.timed_out {
            docker::quiet(&["rm", "-f", &name]);
            return Helper::Failed(format!(
                "the helper that puts the rules in did not finish within {}s",
                HELPER_LIMIT.as_secs()
            ));
        }
        if ran.code == Some(0) {
            return Helper::Ran(ran.stdout);
        }
        let said = ran.stderr.trim().to_string();
        if missing_program(&said) {
            continue;
        }
        if kernel_cannot(&said) {
            return Helper::Unsupported(format!(
                "this engine's kernel cannot take nftables rules ({}): run sandboxes on an engine whose kernel has nf_tables",
                first_line(&said)
            ));
        }
        return Helper::Failed(format!("nft refused the rules: {}", first_lines(&said)));
    }
    Helper::Unsupported(
        "no image on this engine has nft: update the sandbox (its newer images carry nftables), or name one that does in IC_EGRESS_IMAGE".to_string(),
    )
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or_default().trim()
}

fn first_lines(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join(" / ")
}

/// What the engine's host says before anything is changed: the resolvers docker forwards to, and the table as it is.
#[derive(Debug, Default)]
struct Engine {
    resolvers: Vec<Net>,
    table: Option<Value>,
}

/// The read the helper does: the host's resolv.conf (docker's own resolver forwards to these, from the container's
/// side of the fence), then our table as JSON when there is one.
const READ_SCRIPT: &str = "cat /etc/resolv.conf 2>/dev/null; echo '@@ic-egress@@'; \
command -v nft >/dev/null 2>&1 || { echo 'nft: executable file not found' >&2; exit 127; }; \
nft list tables inet >/dev/null || exit 3; \
if nft list tables inet | grep -qx 'table inet intentic_egress'; then nft -j list table inet intentic_egress; else echo '{}'; fi";

fn read_engine(images: &[String]) -> std::result::Result<Engine, Helper> {
    match run_helper(images, "sh", &["-c", READ_SCRIPT], b"") {
        Helper::Ran(out) => Ok(engine_of(&out)),
        other => Err(other),
    }
}

/// The read's output taken apart. Pure.
fn engine_of(out: &str) -> Engine {
    let (resolv, table) = out.split_once(MARK).unwrap_or(("", out));
    let table = serde_json::from_str::<Value>(table.trim())
        .ok()
        .filter(|table| table.get("nftables").is_some());
    Engine {
        resolvers: facts::resolvers(resolv),
        table,
    }
}

fn apply_script(images: &[String], script: &str) -> Helper {
    run_helper(images, "nft", &["-f", "-"], script.as_bytes())
}

/* ---- Deciding ---- */

/// Each hostname entry as the host resolved it: what the status lists as `resolved`.
type Resolved = Vec<(String, Vec<String>)>;
/// One change for the table, with the sandbox it is for (empty for a stale sweep) and what it resolved.
type Pending = (String, Change, Resolved);

/// One sandbox's outcome, as its status will say it.
#[derive(Clone, Debug, PartialEq)]
struct Outcome {
    state: &'static str,
    reason: Option<String>,
    matched: Option<&'static str>,
    resolved: Vec<(String, Vec<String>)>,
}

/// What to do for one sandbox, before the engine is touched.
#[derive(Clone, Debug, PartialEq)]
enum Plan {
    /// Nothing to fence: open, or a network of its own with no traffic.
    Off,
    Fence(Box<render::Sandbox>, Vec<(String, Vec<String>)>),
    /// Rules cannot be drawn yet (no container, no address): kept, not failed.
    Pending(String),
    /// Rules can never be drawn for it as it runs.
    Cannot(String),
}

/// Resolve a hostname on the host, bounded: a resolver that hangs costs at most a few seconds, and an unresolved name
/// opens nothing.
fn resolve(name: &str) -> Vec<Net> {
    use std::net::ToSocketAddrs;
    let (send, receive) = std::sync::mpsc::channel();
    let owned = name.to_string();
    std::thread::spawn(move || {
        let found: Vec<Net> = (owned.as_str(), 0)
            .to_socket_addrs()
            .map(|addresses| {
                addresses
                    .filter_map(|address| Net::parse(&address.ip().to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let _ = send.send(found);
    });
    let mut found = receive
        .recv_timeout(Duration::from_secs(3))
        .unwrap_or_default();
    found.sort();
    found.dedup();
    found
}

/// One sandbox's plan, from its held policy, the baseline and what docker said. `resolve` answers a hostname. Pure
/// but for `resolve`.
fn plan(
    seen_slug: &str,
    held: Option<&Policy>,
    baseline: &Baseline,
    container: Option<&Container>,
    networks: &[Network],
    engine_resolvers: &[Net],
    resolve: &dyn Fn(&str) -> Vec<Net>,
) -> Plan {
    let held = held.cloned().unwrap_or_else(Policy::open);
    if policy::effective_profile(&held, baseline) == Profile::Open {
        return Plan::Off;
    }
    if container.is_some_and(|container| container.network_mode == "none") {
        return Plan::Off;
    }
    let fence = match facts::fence(seen_slug, container, networks) {
        Ok(fence) => fence,
        Err(NoFence::NotYet(why)) => {
            return if container.is_some_and(|container| container.running) {
                Plan::Cannot(why)
            } else {
                Plan::Pending(why)
            }
        }
        Err(NoFence::Never(why)) => return Plan::Cannot(why),
    };
    let mut resolved: Vec<(String, Vec<String>)> = Vec::new();
    let mut nets_of = |to: &str, record: bool| -> (Vec<Net>, bool) {
        match policy::destination_kind(to) {
            Some(Kind::Host) => (Vec::new(), true),
            Some(Kind::V4) | Some(Kind::V6) => (Net::parse(to).into_iter().collect(), false),
            Some(Kind::Name) => {
                let found = resolve(to);
                if record && !resolved.iter().any(|(seen, _)| seen == to) {
                    resolved.push((
                        to.to_string(),
                        found.iter().map(|net| net.text.clone()).collect(),
                    ));
                }
                (found, false)
            }
            None => (Vec::new(), false),
        }
    };
    let mut never: Vec<Net> = Vec::new();
    let mut never_host = false;
    for to in &baseline.never_allow {
        let (nets, host) = nets_of(to, false);
        never.extend(nets);
        never_host |= host;
    }
    let ways: Vec<Way> = policy::canonical(&held)
        .allow
        .iter()
        .map(|entry| {
            let (nets, host) = nets_of(&entry.to, true);
            Way {
                to: entry.to.clone(),
                nets,
                host,
                ports: entry.ports.clone(),
                protocol: entry.protocol,
            }
        })
        .collect();
    let mut resolvers: Vec<Net> = container
        .map(|container| container.dns.clone())
        .unwrap_or_default();
    resolvers.extend(engine_resolvers.iter().cloned());
    resolvers.retain(facts::is_private);
    resolvers.sort();
    resolvers.dedup();
    Plan::Fence(
        Box::new(render::Sandbox {
            slug: seen_slug.to_string(),
            fence,
            never,
            never_host,
            resolvers,
            ways,
        }),
        resolved,
    )
}

/* ---- Applying ---- */

/// Settle the rules of `slugs` (every sandbox this side keeps when None), and say what came of each. Never stops a
/// flow: a sandbox whose rules cannot go in is failed closed here, and the caller's own work goes on.
pub fn settle(slugs: Option<&[String]>) -> HashMap<String, Value> {
    settle_closing(slugs, true, None)
}

/// [`settle`], failing closed only when `close` says so: `set` tries a new policy without stopping anything, and
/// refuses it when its rules do not go in.
///
/// With a `follower` (`--follow`), FAST: no read of the engine first (its resolvers are the follower's, read when it
/// started), one `nft -f` through the follower's kept helper, and nothing swept that this call was not asked about.
fn settle_closing(
    slugs: Option<&[String]>,
    close: bool,
    follower: Option<&mut Follower>,
) -> HashMap<String, Value> {
    let (baseline, said) = baseline();
    for sentence in said {
        ui::warn(&sentence);
    }
    let all = crate::sandbox::live_slugs();
    let scope: Vec<String> = match slugs {
        Some(slugs) => slugs.to_vec(),
        None => all.clone().unwrap_or_default(),
    };
    let mut statuses = HashMap::new();
    // Only a sandbox whose policy fences it, or that ic put rules in for before, costs anything: a machine where
    // nobody set a policy asks the engine nothing.
    let mut seen: Vec<(Seen, Option<Policy>)> = Vec::new();
    for slug in &scope {
        let held = record::read(slug).ok().and_then(|record| record.egress);
        if !needs_rules(held.as_ref(), &baseline) && status::read_applied(slug).is_none() {
            continue;
        }
        let found = see(slug);
        if kept_elsewhere(&found).is_some() {
            continue;
        }
        seen.push((found, held));
    }
    if seen.is_empty() {
        return statuses;
    }
    let images: Vec<String> = seen
        .iter()
        .filter_map(|(found, _)| {
            found
                .container
                .as_ref()
                .map(|container| container.image.clone())
        })
        .collect();
    let fast = follower.is_some();
    let mut via = match follower {
        Some(follower) => Via::Kept(follower),
        None => Via::Once(helper_images(&images)),
    };
    let engine = match &mut via {
        Via::Kept(follower) => Ok(Engine {
            resolvers: follower.resolvers.clone(),
            table: None,
        }),
        Via::Once(images) => read_engine(images),
    };
    let (engine, unsupported, failed) = match engine {
        Ok(engine) => (engine, None, None),
        Err(Helper::Unsupported(why)) => (Engine::default(), Some(why), None),
        Err(Helper::Failed(why)) => (Engine::default(), None, Some(why)),
        Err(Helper::Ran(_)) => unreachable!("a read that ran is Ok"),
    };
    let mut outcomes: Vec<(String, Outcome)> = Vec::new();
    let mut changes: Vec<Pending> = Vec::new();
    let mut fenced_on: HashMap<String, Vec<String>> = HashMap::new();
    // What the table holds: read, or (fast) what ic remembers having put in.
    let in_table: BTreeSet<String> = match &engine.table {
        Some(table) => status::ids_in(table),
        None if fast => seen
            .iter()
            .filter(|(found, _)| status::read_applied(&found.slug).is_some())
            .map(|(found, _)| render::id(&found.slug))
            .collect(),
        None => BTreeSet::new(),
    };
    for (found, held) in &seen {
        let planned = plan(
            &found.slug,
            held.as_ref(),
            &baseline,
            found.container.as_ref(),
            &found.networks,
            &engine.resolvers,
            &resolve,
        );
        let id = render::id(&found.slug);
        let matched = |sandbox: &render::Sandbox| Some(sandbox.fence.matched.word());
        match planned {
            Plan::Off => {
                if in_table.contains(&id) {
                    changes.push((found.slug.clone(), Change::Remove(id), Vec::new()));
                }
                outcomes.push((found.slug.clone(), outcome("off", None, None, Vec::new())));
            }
            Plan::Pending(why) => {
                // Addresses a stopped container held may be another's by now: what was put in for them goes.
                if in_table.contains(&id) {
                    changes.push((String::new(), Change::Remove(id), Vec::new()));
                }
                outcomes.push((
                    found.slug.clone(),
                    outcome("pending", Some(why), None, Vec::new()),
                ));
            }
            Plan::Cannot(why) => {
                outcomes.push((
                    found.slug.clone(),
                    outcome(
                        "failed",
                        Some(format!("the fence cannot be drawn: {why}")),
                        None,
                        Vec::new(),
                    ),
                ));
            }
            Plan::Fence(sandbox, resolved) => {
                fenced_on.insert(found.slug.clone(), sandbox.fence.networks.clone());
                if let Some(why) = &unsupported {
                    outcomes.push((
                        found.slug.clone(),
                        outcome(
                            "unsupported",
                            Some(why.clone()),
                            matched(&sandbox),
                            resolved,
                        ),
                    ));
                } else if let Some(why) = &failed {
                    outcomes.push((
                        found.slug.clone(),
                        outcome("failed", Some(why.clone()), matched(&sandbox), resolved),
                    ));
                } else {
                    changes.push((found.slug.clone(), Change::Fence(*sandbox), resolved));
                }
            }
        }
    }
    // Chains of sandboxes no longer on this engine go too, whichever side put them in (only when docker answered, and
    // never on the fast path, which did not read the table).
    if let (Some(all), false) = (&all, fast) {
        let known: BTreeSet<String> = all.iter().map(|slug| render::id(slug)).collect();
        for stale in in_table.iter().filter(|id| !known.contains(*id)) {
            changes.push((String::new(), Change::Remove(stale.clone()), Vec::new()));
        }
    }
    if unsupported.is_none() && failed.is_none() && !changes.is_empty() {
        outcomes.extend(apply(&mut via, &changes, (!fast).then_some(&in_table)));
    }
    let now = crate::sandbox::now_ms();
    for (found, held) in &seen {
        let Some((_, outcome)) = outcomes.iter().find(|(slug, _)| *slug == found.slug) else {
            continue;
        };
        let advisory = found.container.as_ref().map(facts::advisory);
        let fenced_running = close
            && outcome.state == "failed"
            && found
                .container
                .as_ref()
                .is_some_and(|container| container.running);
        let mut outcome = outcome.clone();
        if fenced_running {
            outcome.reason = Some(fail_closed(
                &found.slug,
                outcome
                    .reason
                    .as_deref()
                    .unwrap_or("its rules could not be put in"),
            ));
        }
        let held_policy = held.clone().unwrap_or_else(Policy::open);
        let blocked = engine
            .table
            .as_ref()
            .map(|table| status::blocked(table, &found.slug, now))
            .or_else(|| status::read_applied(&found.slug).map(|applied| applied.blocked))
            .unwrap_or_default();
        let applied = Applied {
            revision: policy::revision(held.as_ref()),
            effective: policy::effective_profile(&held_policy, &baseline)
                .word()
                .to_string(),
            never_allow: baseline.never_allow.clone(),
            state: outcome.state.to_string(),
            reason: outcome.reason.clone(),
            matched: outcome.matched.map(str::to_string),
            advisory,
            applied_at: (outcome.state == "enforced").then_some(now),
            resolved: outcome.resolved.clone(),
            blocked,
            fenced_networks: fenced_on.get(&found.slug).cloned().unwrap_or_default(),
        };
        // Open, or a sandbox with no container left to fence: nothing of it is in the table any more.
        if outcome.state == "off" || (outcome.state == "pending" && found.inspected.is_none()) {
            status::forget_applied(&found.slug);
        } else {
            status::write_applied(&found.slug, &applied);
        }
        let shown = status::assemble(held.as_ref(), &baseline, Some(&applied), advisory);
        if found
            .container
            .as_ref()
            .is_some_and(|container| container.running)
            && outcome.state != "off"
        {
            write_inside(&found.slug, &shown);
        }
        statuses.insert(found.slug.clone(), shown);
    }
    statuses
}

fn outcome(
    state: &'static str,
    reason: Option<String>,
    matched: Option<&'static str>,
    resolved: Vec<(String, Vec<String>)>,
) -> Outcome {
    Outcome {
        state,
        reason,
        matched,
        resolved,
    }
}

/// Put the changes in, in one transaction; when it is refused, each sandbox's alone, so one sandbox's refusal fails
/// only that sandbox. The table goes once nothing is left in it.
fn apply(
    via: &mut Via,
    changes: &[Pending],
    in_table: Option<&BTreeSet<String>>,
) -> Vec<(String, Outcome)> {
    // The table is only dropped by a call that read it: a fast one does not know what other sides put in.
    let mut remaining: BTreeSet<String> = in_table.cloned().unwrap_or_default();
    for (_, change, _) in changes {
        match change {
            Change::Fence(sandbox) => {
                remaining.insert(render::id(&sandbox.slug));
            }
            Change::Remove(id) => {
                remaining.remove(id);
            }
        }
    }
    let all: Vec<Change> = changes
        .iter()
        .map(|(_, change, _)| change.clone())
        .collect();
    let drop_table = in_table.is_some() && remaining.is_empty();
    let whole = via.nft(&render::transaction(&all, drop_table));
    let mut outcomes = Vec::new();
    let mut said =
        |slug: &str, change: &Change, resolved: &[(String, Vec<String>)], result: &Helper| {
            if slug.is_empty() {
                return;
            }
            let (state, reason) = match (change, result) {
                (Change::Remove(_), Helper::Ran(_)) => ("off", None),
                (Change::Fence(_), Helper::Ran(_)) => ("enforced", None),
                (_, Helper::Unsupported(why)) => ("unsupported", Some(why.clone())),
                (_, Helper::Failed(why)) => ("failed", Some(why.clone())),
            };
            let matched = match change {
                Change::Fence(sandbox) => Some(sandbox.fence.matched.word()),
                Change::Remove(_) => None,
            };
            outcomes.push((
                slug.to_string(),
                outcome(state, reason, matched, resolved.to_vec()),
            ));
        };
    if matches!(whole, Helper::Failed(_)) && changes.len() > 1 {
        for (slug, change, resolved) in changes {
            let alone = via.nft(&render::transaction(std::slice::from_ref(change), false));
            said(slug, change, resolved, &alone);
        }
    } else {
        for (slug, change, resolved) in changes {
            said(slug, change, resolved, &whole);
        }
    }
    outcomes
}

/// FAIL CLOSED: stop a sandbox whose rules could not go in, saying why in its restart intent, and hold it stopped so
/// nothing starts it again unfenced behind the owner's back. Returns the reason its status gives.
fn fail_closed(slug: &str, why: &str) -> String {
    let container = container_of(slug);
    let reason = format!(
        "{why}. Its egress policy fences it, so it was stopped rather than left running unfenced; start it again once the cause is fixed (ic sandbox start {slug})."
    );
    intent::leave(
        &container,
        Action::Stop,
        &format!("the egress fence could not be put in: {why}"),
    );
    docker::quiet(&["stop", &container]);
    if let Ok(saved) = record::read(slug) {
        let _ = record::write(
            slug,
            &record::ChannelRecord {
                held: true,
                ..saved
            },
        );
    }
    ui::warn(&format!("{slug} was stopped: {reason}"));
    reason
}

/// The status, inside the sandbox, for its daemon and agents to read: a report, which the sandbox changing changes no
/// rule. Best-effort.
fn write_inside(slug: &str, shown: &Value) {
    let script = format!(
        "mkdir -p /run/intentic && cat > {STATUS_FILE}.tmp && mv {STATUS_FILE}.tmp {STATUS_FILE}"
    );
    docker::exec_stdin_ok(
        &container_of(slug),
        &["sh", "-c", &script],
        shown.to_string().as_bytes(),
    );
}

/* ---- Lifecycle ---- */

/// Whether a held policy fences under this baseline. Pure.
fn needs_rules(held: Option<&Policy>, baseline: &Baseline) -> bool {
    let held = held.cloned().unwrap_or_else(Policy::open);
    policy::effective_profile(&held, baseline) != Profile::Open
}

/// After a start, restart, recreate or setup ic performed: the sandbox's rules, synchronously, when it has a policy
/// that fences it or ic put rules in for it before. Nothing at all for a sandbox that never had any.
pub fn after_start(slug: &str) {
    settle(Some(&[slug.to_string()]));
}

/// [`after_start`] for a verb that may have named no sandbox (it then acted on the only one here).
pub fn after_start_of(slug: Option<&str>) {
    match slug {
        Some(slug) => after_start(slug),
        None => {
            let slugs = crate::sandbox::list_slugs();
            if slugs.len() == 1 {
                settle(Some(&slugs));
            }
        }
    }
}

/// `ic engine remove`, while the engine still answers: the whole table out of its host's namespace, which a removed
/// engine would otherwise leave behind for the next one to inherit.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn drop_table() {
    let images = helper_images(&[]);
    if let Ok(engine) = read_engine(&images) {
        if engine.table.is_some() {
            let _ = apply_script(&images, &render::transaction(&[], true));
        }
    }
}

/// A sandbox removed: its chains and sets go, and what ic remembered of them. The table goes with the last.
pub fn forget(slug: &str) {
    if status::read_applied(slug).is_none() {
        return;
    }
    let images = helper_images(&[]);
    let in_table = match read_engine(&images) {
        Ok(engine) => engine
            .table
            .as_ref()
            .map(status::ids_in)
            .unwrap_or_default(),
        // Remembered still: the watch's round takes it out once the engine answers.
        Err(_) => return,
    };
    let id = render::id(slug);
    if in_table.contains(&id) {
        let done = apply(
            &mut Via::Once(images.clone()),
            &[(slug.to_string(), Change::Remove(id), Vec::new())],
            Some(&in_table),
        );
        if done.iter().any(|(_, outcome)| outcome.state != "off") {
            return;
        }
    }
    status::forget_applied(slug);
}

/// The watch's round (the machine agent runs `ic sandbox watch` every minute): every rule reasserted, the counters
/// read, each sandbox's status written into it. What fails is failed closed and said. A sandbox some flow of ic's
/// holds is left to that flow, which settles its rules when it is done.
pub fn round(slug: Option<&str>) {
    let slugs: Vec<String> = match slug {
        Some(slug) => vec![slug.to_string()],
        None => {
            // And every sandbox ic put rules in for that is gone since, so its rules go with it.
            let mut slugs = crate::sandbox::list_slugs();
            for remembered in status::remembered() {
                if !slugs.contains(&remembered) {
                    slugs.push(remembered);
                }
            }
            slugs
        }
    };
    let mut free: Vec<String> = Vec::new();
    let mut holds = Vec::new();
    for slug in slugs {
        if let Ok(Some(held)) = lock::hold(&slug, Wait::Skip) {
            holds.push(held);
            free.push(slug);
        }
    }
    if !free.is_empty() {
        settle(Some(&free));
    }
    // With no sandbox left to fence, rules of sandboxes gone from this engine still go (settle's stale sweep).
    drop(holds);
}

/// A listing row's status: what the record holds, the baseline and what ic last did, with the container's own
/// privilege for `advisory`. Asks the engine nothing.
pub fn listed(slug: &str, held: Option<&Policy>, baseline: &Baseline, inspected: &Value) -> Value {
    let advisory = facts::advisory(&facts::container(inspected));
    status::assemble(
        held,
        baseline,
        status::read_applied(slug).as_ref(),
        Some(advisory),
    )
}

/* ---- The verbs ---- */

/// `ic sandbox egress <slug> --policy <JSON>`: the whole policy, saved only once its rules are in (or the sandbox is
/// not running, when they go in at its next start).
pub fn set(slug: &str, policy_json: &str, as_json: bool) -> Result<()> {
    if !crate::sandbox::is_slug(slug) {
        bail!("{}", crate::sandbox::missing(slug));
    }
    let asked = policy::parse(policy_json)?;
    let asked = policy::canonical(&asked);
    docker::require_daemon()?;
    let _held = lock::hold_for_person(slug)?;
    let found = see(slug);
    if found.inspected.is_none() && !docker::container_exists(&crate::sandbox::parked_of(slug)) {
        bail!("{}", crate::sandbox::missing(slug));
    }
    if let Some(keeper) = kept_elsewhere(&found) {
        bail!(
            "{}",
            ui::explain(
                &format!("{slug}'s egress policy was left as it is."),
                Some(&format!(
                    "{} It holds this sandbox's policy, and only ic there changes it.",
                    side::sentence(&keeper)
                )),
                Some(&format!(
                    "run the same command on that side ({}).",
                    keeper.name()
                )),
            )
        );
    }
    let saved = record::read(slug)?;
    let previous = saved.egress.clone();
    let running = found
        .container
        .as_ref()
        .is_some_and(|container| container.running);
    // The record holds it while the rules go in, so the round that puts them in reads it; put back if they do not.
    record::write(
        slug,
        &record::ChannelRecord {
            egress: Some(asked.clone()),
            ..saved.clone()
        },
    )?;
    let statuses = settle_closing(Some(&[slug.to_string()]), false, None);
    let shown = statuses.get(slug).cloned();
    let state = shown
        .as_ref()
        .and_then(|shown| shown["state"].as_str())
        .unwrap_or("pending")
        .to_string();
    let refused = running && matches!(state.as_str(), "failed" | "unsupported");
    if refused {
        let reason = shown
            .as_ref()
            .and_then(|shown| shown["reason"].as_str())
            .unwrap_or("the rules could not be put in")
            .to_string();
        let now = record::read(slug)?;
        record::write(
            slug,
            &record::ChannelRecord {
                egress: previous.clone(),
                ..now
            },
        )?;
        // The rules the policy before it fenced with go back in (a sandbox stopped by the attempt stays stopped).
        settle(Some(&[slug.to_string()]));
        bail!(
            "{}",
            ui::explain(
                &format!("{slug}'s egress policy was not saved."),
                Some(&format!("its rules could not be put in: {reason}")),
                Some("fix what that names, then set the policy again."),
            )
        );
    }
    crate::sandbox::mirror::push(slug);
    let (baseline, _) = baseline();
    let shown = shown.unwrap_or_else(|| {
        status::assemble(
            Some(&asked),
            &baseline,
            status::read_applied(slug).as_ref(),
            None,
        )
    });
    if as_json {
        // The --json answer, the sandbox's EgressStatus on one line: stdout, whatever the human lines do.
        crate::sandbox::fix::report::emit(&shown.to_string());
    } else {
        ui::done(&format!(
            "{slug}'s egress policy is saved: {}",
            sentence(&shown)
        ));
    }
    Ok(())
}

/// The status in words. Pure.
fn sentence(shown: &Value) -> String {
    let profile = shown["effectiveProfile"].as_str().unwrap_or("open");
    match shown["state"].as_str().unwrap_or("off") {
        "off" => "open, nothing fenced.".to_string(),
        "enforced" => format!(
            "{profile}, enforced{}.",
            if shown["advisory"] == true {
                " (advisory: it runs privileged, as the host's root)"
            } else {
                ""
            }
        ),
        "pending" => format!("{profile}, put in when it next starts."),
        state => format!(
            "{profile}, {state}: {}",
            shown["reason"].as_str().unwrap_or("")
        ),
    }
}

/// `ic sandbox egress <slug> [--json]`: the sandbox's EgressStatus, its counters read fresh when it is fenced.
pub fn show(slug: &str, as_json: bool) -> Result<()> {
    if !crate::sandbox::is_slug(slug) {
        bail!("{}", crate::sandbox::missing(slug));
    }
    let held = record::read(slug)?.egress;
    let (baseline, _) = baseline();
    let mut applied = status::read_applied(slug);
    let running =
        docker::inspect(&container_of(slug), "{{.State.Running}}").as_deref() == Some("true");
    if running
        && applied
            .as_ref()
            .is_some_and(|applied| applied.state == "enforced")
    {
        if let Ok(engine) = read_engine(&helper_images(&[])) {
            if let (Some(table), Some(applied)) = (engine.table.as_ref(), applied.as_mut()) {
                applied.blocked = status::blocked(table, slug, crate::sandbox::now_ms());
                status::write_applied(slug, applied);
            }
        }
    }
    let advisory = inspect_container(&container_of(slug))
        .map(|inspected| facts::advisory(&facts::container(&inspected)));
    let shown = status::assemble(held.as_ref(), &baseline, applied.as_ref(), advisory);
    if as_json {
        // The --json answer, the sandbox's EgressStatus on one line: stdout, whatever the human lines do.
        crate::sandbox::fix::report::emit(&shown.to_string());
        return Ok(());
    }
    ui::report(&format!("intentic · {slug}'s egress"), None);
    ui::plain(&sentence(&shown));
    for entry in shown["policy"]["allow"].as_array().into_iter().flatten() {
        ui::plain(&format!("  allow {}", entry));
    }
    for blocked in shown["blocked"].as_array().into_iter().flatten().take(10) {
        ui::plain(&format!(
            "  refused {}{} {} ×{}",
            blocked["to"].as_str().unwrap_or("?"),
            blocked["port"]
                .as_u64()
                .map(|port| format!(":{port}"))
                .unwrap_or_default(),
            blocked["protocol"].as_str().unwrap_or("?"),
            blocked["packets"]
        ));
    }
    Ok(())
}

/* ---- How the rules reach the engine ---- */

/// A one-shot helper per transaction (every flow, the watch), or the follower's kept one.
enum Via<'a> {
    Once(Vec<String>),
    Kept(&'a mut Follower),
}

impl Via<'_> {
    fn nft(&mut self, script: &str) -> Helper {
        match self {
            Via::Once(images) => apply_script(images, script),
            Via::Kept(follower) => follower.nft(script),
        }
    }
}

/// THE FOLLOWER'S KEPT HELPER. A one-shot helper costs an image start per transaction (most of a second on Docker
/// Desktop); a sandbox Compose recreated onto a new address must be fenced faster than that. So `--follow` keeps one
/// helper running on the host network (`sleep infinity`, ic's labels, NET_ADMIN alone) and puts each change in with
/// one `docker exec -i <helper> nft -f -`. It is named per side of the computer, so a follower started again (after a
/// kill that left it behind) takes the one there, and removed when the follower ends.
pub struct Follower {
    name: String,
    image: String,
    resolvers: Vec<Net>,
}

/// What a follower does with a helper of its name already on the engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Keep {
    /// None there: start one.
    Create,
    /// Running from an image that has nft: use it as it is.
    Reuse,
    /// Stopped, or from another image: remove it and start one.
    Replace,
}

/// The decision, from the existing helper's `{{.State.Running}} {{.Image}}` (None: there is none). Pure.
fn keep(existing: Option<(bool, &str)>, image: &str) -> Keep {
    match existing {
        None => Keep::Create,
        Some((true, have)) if have == image => Keep::Reuse,
        Some(_) => Keep::Replace,
    }
}

/// The kept helper's name on this side. Pure.
fn kept_name(side: &str) -> String {
    format!(
        "intentic-egress-follow-{}",
        &crate::util::sha256_hex(side.as_bytes())[..10]
    )
}

/// The `docker run` that starts the kept helper. Pure.
fn kept_args(name: &str, image: &str, side: &str) -> Vec<String> {
    [
        "run",
        "-d",
        "--name",
        name,
        "--restart",
        "no",
        "--network",
        "host",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--user",
        "0:0",
        "--pull",
        "never",
        "--log-driver",
        "none",
    ]
    .iter()
    .map(|word| word.to_string())
    .chain([
        "--label".to_string(),
        "dev.intentic.kind=egress-helper".to_string(),
        "--label".to_string(),
        format!("{}={side}", crate::sandbox::labels::SIDE),
        "--label".to_string(),
        format!("{}={}", crate::sandbox::labels::IC, crate::VERSION),
        "--entrypoint".to_string(),
        "sleep".to_string(),
        image.to_string(),
        "infinity".to_string(),
    ])
    .collect()
}

/// How often, and how far apart, the kept helper's name is asked for again while docker finishes removing the old one.
const HELPER_RESTART_TRIES: usize = 10;
const HELPER_RESTART_PAUSE: Duration = Duration::from_millis(200);

/// Whether docker refused a `run` because the name is still held by a container it is removing. Pure.
fn name_still_taken(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("is already in use")
        || lower.contains("removal of container")
        || lower.contains("is already in progress")
}

/// Whether docker's refusal of an exec says the helper is gone or down, so it is started again once. Pure.
fn helper_gone(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("no such container")
        || lower.contains("is not running")
        || lower.contains("is paused")
}

impl Follower {
    /// The kept helper up, from the first image that has nft, and the host's resolvers read through it.
    fn start() -> std::result::Result<Follower, Helper> {
        let side = side::here().wire();
        let name = kept_name(&side);
        let images = helper_images(&[]);
        let existing = docker::inspect(&name, "{{.State.Running}} {{.Image}}").map(|said| {
            let (running, image) = said.split_once(' ').unwrap_or((said.as_str(), ""));
            (running == "true", image.to_string())
        });
        let mut last = Helper::Unsupported(
            "no image on this engine has nft: update the sandbox, or name one that does in IC_EGRESS_IMAGE".to_string(),
        );
        for image in &images {
            match keep(
                existing
                    .as_ref()
                    .map(|(running, have)| (*running, have.as_str())),
                image,
            ) {
                Keep::Reuse => {}
                Keep::Replace | Keep::Create => {
                    docker::quiet(&["rm", "-f", &name]);
                    let args = kept_args(&name, image, &side);
                    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
                    if let Err(err) = docker::capture(&refs) {
                        last = Helper::Failed(format!(
                            "the follower's helper did not start: {}",
                            err.0
                        ));
                        continue;
                    }
                }
            }
            let mut follower = Follower {
                name: name.clone(),
                image: image.clone(),
                resolvers: Vec::new(),
            };
            match follower.exec(&["sh", "-c", READ_SCRIPT], b"") {
                Helper::Ran(out) => {
                    follower.resolvers = engine_of(&out).resolvers;
                    return Ok(follower);
                }
                // This image has no nft: the next one.
                Helper::Failed(why)
                    if missing_program(&why) || why.contains("executable file not found") =>
                {
                    docker::quiet(&["rm", "-f", &name]);
                }
                other => {
                    docker::quiet(&["rm", "-f", &name]);
                    return Err(other);
                }
            }
        }
        Err(last)
    }

    /// `docker exec -i <helper> <argv>` with `input` on its stdin, bounded.
    fn exec(&mut self, argv: &[&str], input: &[u8]) -> Helper {
        let mut args: Vec<&str> = vec!["exec", "-i", &self.name];
        args.extend_from_slice(argv);
        let ran = match intentic_bounded::capture_with_input(
            docker::command(&args),
            input,
            HELPER_LIMIT,
            intentic_bounded::Reach::Child,
        ) {
            Ok(ran) => ran,
            Err(err) => return Helper::Failed(format!("docker could not be run: {err}")),
        };
        if ran.timed_out {
            return Helper::Failed(format!(
                "nft did not finish within {}s",
                HELPER_LIMIT.as_secs()
            ));
        }
        if ran.code == Some(0) {
            return Helper::Ran(ran.stdout);
        }
        let said = ran.stderr.trim().to_string();
        if kernel_cannot(&said) {
            return Helper::Unsupported(format!(
                "this engine's kernel cannot take nftables rules ({}): run sandboxes on an engine whose kernel has nf_tables",
                first_line(&said)
            ));
        }
        if missing_program(&said) {
            return Helper::Failed(format!("executable file not found: {}", first_line(&said)));
        }
        Helper::Failed(format!("nft refused the rules: {}", first_lines(&said)))
    }

    /// One transaction through the kept helper. A helper someone removed or stopped is started again; while docker is
    /// still removing the old one (its name "already in use", "removal in progress") it is asked again for a moment.
    /// A helper that cannot be had at all is never a reason to fail a sandbox: the transaction then goes the one-shot
    /// way, as a watch round's does (2026-10-27: a `docker rm -f` of the helper mid-follow made the restart race the
    /// removal, and the follower stopped a sandbox whose rules were still in the kernel).
    fn nft(&mut self, script: &str) -> Helper {
        let first = self.exec(&["nft", "-f", "-"], script.as_bytes());
        let gone = matches!(&first, Helper::Failed(why) if helper_gone(why));
        if !gone {
            return first;
        }
        if self.restart() {
            return self.exec(&["nft", "-f", "-"], script.as_bytes());
        }
        ui::warn("the follower's helper could not be started again: this change goes through a one-shot helper");
        apply_script(&helper_images(std::slice::from_ref(&self.image)), script)
    }

    /// The kept helper started again under its name, waiting out a removal docker has not finished. Whether it is up.
    fn restart(&mut self) -> bool {
        let args = kept_args(&self.name, &self.image, &side::here().wire());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        for _ in 0..HELPER_RESTART_TRIES {
            docker::quiet(&["rm", "-f", &self.name]);
            match docker::capture(&refs) {
                Ok(_) => return true,
                Err(err) if name_still_taken(&err.0) => std::thread::sleep(HELPER_RESTART_PAUSE),
                Err(_) => return false,
            }
        }
        false
    }

    /// The helper's resolvers read again (a laptop that changed networks has other ones).
    fn refresh(&mut self) {
        if let Helper::Ran(out) = self.exec(&["sh", "-c", READ_SCRIPT], b"") {
            self.resolvers = engine_of(&out).resolvers;
        }
    }

    fn end(self) {
        docker::quiet(&["rm", "-f", &self.name]);
    }
}

/* ---- Following docker ---- */

/// What one docker event asks of the fence.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Event {
    /// A sandbox started or joined or left a network: its own rules again.
    Sandbox(String),
    /// Some other container started, joined or left a network: the exclusions of every fenced sandbox sharing one
    /// may have changed.
    Other,
}

/// The event a `docker events --format '{{json .}}'` line is, if the fence cares; `name_of` answers a container id
/// (None for one already gone). Pure but for `name_of`.
fn event_of(line: &str, name_of: &dyn Fn(&str) -> Option<String>) -> Option<Event> {
    let event: Value = serde_json::from_str(line).ok()?;
    let attributes = &event["Actor"]["Attributes"];
    let name = match (event["Type"].as_str()?, event["Action"].as_str()?) {
        ("container", "start") => attributes["name"].as_str().map(str::to_string),
        ("network", "connect" | "disconnect") => name_of(attributes["container"].as_str()?),
        _ => return None,
    };
    let Some(name) = name else {
        // A container gone already (a disconnect at its removal): only what it shared matters.
        return Some(Event::Other);
    };
    let name = name.trim_start_matches('/');
    let slug = name
        .strip_prefix(CONTAINER_PREFIX)
        .filter(|_| !name.starts_with(crate::sandbox::TUNNEL_PREFIX))
        .map(|slug| slug.strip_suffix(PARKED_SUFFIX).unwrap_or(slug))
        .filter(|slug| crate::sandbox::is_slug(slug));
    Some(match slug {
        Some(slug) => Event::Sandbox(slug.to_string()),
        None => Event::Other,
    })
}

/// The sandboxes one burst of events asks to settle: each named sandbox, and on any other container's event every
/// sandbox ic has rules in for (its exclusions may name that container). In first-seen order, each once. Pure.
fn to_settle(events: &[Event], fenced: &[String]) -> Vec<String> {
    let mut slugs: Vec<String> = Vec::new();
    let mut add = |slug: &String| {
        if !slugs.contains(slug) {
            slugs.push(slug.clone());
        }
    };
    for event in events {
        match event {
            Event::Sandbox(slug) => add(slug),
            Event::Other => fenced.iter().for_each(&mut add),
        }
    }
    slugs
}

/// How long a burst of events is gathered after its first (Compose's `up` sends several at once), and at most.
const BURST_QUIET: Duration = Duration::from_millis(100);
const BURST_MAX: Duration = Duration::from_millis(500);
/// How often the follower reads the host's resolvers again.
const RESOLVERS_EVERY: Duration = Duration::from_secs(600);

/// `ic sandbox egress --follow`: fences every sandbox start ic did not perform itself (Compose's `up`, Docker's own
/// restart policy, a person's `docker start`), and keeps every fenced sandbox's sibling exclusions current as other
/// containers come and go, with one `nft -f` through a kept helper per burst of events. Runs until stopped.
pub fn follow() -> Result<()> {
    docker::require_daemon()?;
    // Everything as it stands first (the full round: read, sweep, apply), then every change docker reports.
    settle(None);
    let mut follower = match Follower::start() {
        Ok(follower) => follower,
        Err(Helper::Unsupported(why)) | Err(Helper::Failed(why)) => {
            bail!("--follow could not start its helper: {why}")
        }
        Err(Helper::Ran(_)) => unreachable!("a start that ran is Ok"),
    };
    let mut command = docker::command(&[
        "events",
        "--filter",
        "type=container",
        "--filter",
        "event=start",
        "--filter",
        "type=network",
        "--filter",
        "event=connect",
        "--filter",
        "event=disconnect",
        "--format",
        "{{json .}}",
    ]);
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            follower.end();
            bail!("could not run docker events: {err}");
        }
    };
    let stdout = child.stdout.take().expect("stdout was piped");
    let (send, lines) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if send.send(line).is_err() {
                break;
            }
        }
    });
    ui::note("following docker's events: every sandbox start is fenced as it happens.");
    let mut resolvers_at = std::time::Instant::now();
    while let Ok(first) = lines.recv() {
        let began = std::time::Instant::now();
        let mut burst = vec![first];
        while began.elapsed() < BURST_MAX {
            match lines.recv_timeout(BURST_QUIET) {
                Ok(line) => burst.push(line),
                Err(_) => break,
            }
        }
        let name_of = |id: &str| docker::inspect(id, "{{.Name}}");
        let events: Vec<Event> = burst
            .iter()
            .filter_map(|line| event_of(line, &name_of))
            .collect();
        if events.is_empty() {
            continue;
        }
        if resolvers_at.elapsed() > RESOLVERS_EVERY {
            follower.refresh();
            resolvers_at = std::time::Instant::now();
        }
        let wanted = to_settle(&events, &status::remembered());
        // A flow of ic's holds a sandbox: it settles the rules itself when it is done.
        let mut holds = Vec::new();
        let mut free: Vec<String> = Vec::new();
        for slug in wanted {
            if let Ok(Some(held)) = lock::hold(&slug, Wait::Skip) {
                holds.push(held);
                free.push(slug);
            }
        }
        if !free.is_empty() {
            settle_closing(Some(&free), true, Some(&mut follower));
        }
        drop(holds);
    }
    let _ = child.wait();
    follower.end();
    bail!("docker's event stream ended (the engine stopped?): run `ic sandbox egress --follow` again once it is back.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fenced(allow: &str) -> Policy {
        policy::parse(&format!(r#"{{"profile":"internet-only","allow":{allow}}}"#)).unwrap()
    }

    fn running_on(network: &str, address: &str) -> Container {
        Container {
            running: true,
            network_mode: network.into(),
            attachments: vec![facts::Attachment {
                network: network.into(),
                addresses: vec![Net::parse(address).unwrap()],
            }],
            runtime: "runc".into(),
            dns: vec![],
            image: "sha256:abc".into(),
            privileged: false,
        }
    }

    fn own_network(slug: &str) -> Network {
        Network {
            name: crate::sandbox::trash::network(slug),
            subnets: vec![Net::parse("172.20.0.0/16").unwrap()],
            ours_for: Some(slug.into()),
            labelled: true,
            members: vec![],
        }
    }

    fn nas(name: &str) -> Vec<Net> {
        if name == "nas.lan" {
            vec![Net::parse("192.168.1.20").unwrap()]
        } else {
            vec![]
        }
    }

    #[test]
    fn open_plans_nothing_and_the_baseline_minimum_fences_anyway() {
        let container = running_on("intentic-workspace-work", "172.20.0.2");
        let networks = [own_network("work")];
        assert_eq!(
            plan(
                "work",
                None,
                &Baseline::default(),
                Some(&container),
                &networks,
                &[],
                &nas
            ),
            Plan::Off
        );
        let lifted = Baseline {
            minimum: Profile::InternetOnly,
            never_allow: vec![],
        };
        assert!(matches!(
            plan(
                "work",
                None,
                &lifted,
                Some(&container),
                &networks,
                &[],
                &nas
            ),
            Plan::Fence(..)
        ));
    }

    #[test]
    fn a_fence_resolves_names_on_the_host_and_keeps_only_private_resolvers() {
        let container = Container {
            dns: vec![Net::parse("8.8.8.8").unwrap()],
            ..running_on("intentic-workspace-work", "172.20.0.2")
        };
        let baseline = Baseline {
            minimum: Profile::Open,
            never_allow: vec!["host".into(), "10.0.0.0/8".into()],
        };
        let resolvers = [Net::parse("192.168.1.1").unwrap()];
        let Plan::Fence(sandbox, resolved) = plan(
            "work",
            Some(&fenced(
                r#"[{"to":"nas.lan","ports":[445]},{"to":"gone.lan"},{"to":"host"}]"#,
            )),
            &baseline,
            Some(&container),
            &[own_network("work")],
            &resolvers,
            &nas,
        ) else {
            panic!("not fenced");
        };
        assert_eq!(sandbox.resolvers, resolvers.to_vec());
        assert!(sandbox.never_host);
        assert_eq!(sandbox.never, vec![Net::parse("10.0.0.0/8").unwrap()]);
        assert_eq!(
            resolved,
            vec![
                ("gone.lan".to_string(), vec![]),
                ("nas.lan".to_string(), vec!["192.168.1.20".to_string()])
            ]
        );
        assert_eq!(sandbox.fence.matched, facts::Match::Network);
    }

    #[test]
    fn a_running_sandbox_that_cannot_be_matched_fails_and_a_stopped_one_waits() {
        let policy = fenced("[]");
        let host = Container {
            network_mode: "host".into(),
            ..running_on("host", "10.0.0.1")
        };
        assert!(matches!(
            plan(
                "work",
                Some(&policy),
                &Baseline::default(),
                Some(&host),
                &[],
                &[],
                &nas
            ),
            Plan::Cannot(_)
        ));
        let stopped = Container {
            running: false,
            attachments: vec![],
            ..running_on("proj_default", "10.0.0.1")
        };
        assert!(matches!(
            plan(
                "work",
                Some(&policy),
                &Baseline::default(),
                Some(&stopped),
                &[],
                &[],
                &nas
            ),
            Plan::Pending(_)
        ));
        let isolated = Container {
            network_mode: "none".into(),
            attachments: vec![],
            ..running_on("none", "10.0.0.1")
        };
        assert_eq!(
            plan(
                "work",
                Some(&policy),
                &Baseline::default(),
                Some(&isolated),
                &[],
                &[],
                &nas
            ),
            Plan::Off
        );
    }

    #[test]
    fn the_helper_is_the_hosts_network_net_admin_alone_and_never_a_pull() {
        let args = helper_args("intentic-egress-1-0", "nft", "sha256:abc", &["-f", "-"]);
        let joined = args.join(" ");
        assert!(joined.starts_with("run --rm -i --name intentic-egress-1-0 --network host --cap-drop ALL --cap-add NET_ADMIN"));
        assert!(joined.contains("--pull never"));
        assert!(joined.ends_with("--entrypoint nft sha256:abc -f -"));
        assert!(missing_program("docker: Error response from daemon: failed to create task: exec: \"nft\": executable file not found in $PATH"));
        assert!(kernel_cannot(
            "Error: Could not process rule: Operation not supported"
        ));
        assert!(!kernel_cannot("Error: syntax error, unexpected newline"));
    }

    #[test]
    fn the_read_splits_the_hosts_resolvers_from_the_table() {
        let engine = engine_of("nameserver 192.168.65.7\n@@ic-egress@@\n{\"nftables\":[{\"chain\":{\"name\":\"sbx_abcdefabcdef_input\"}}]}\n");
        assert_eq!(engine.resolvers, vec![Net::parse("192.168.65.7").unwrap()]);
        assert_eq!(status::ids_in(engine.table.as_ref().unwrap()).len(), 1);
        assert!(engine_of("nameserver 1.1.1.1\n@@ic-egress@@\n{}\n")
            .table
            .is_none());
    }

    #[test]
    fn a_sandbox_event_settles_it_and_any_other_container_settles_every_fenced_one() {
        let name_of = |id: &str| match id {
            "c0ffee" => Some("/intentic-sandbox-work".to_string()),
            "beef" => Some("/proj-db-1".to_string()),
            _ => None,
        };
        let line = |value: Value| value.to_string();
        let start = line(
            json!({ "Type": "container", "Action": "start", "Actor": { "Attributes": { "name": "intentic-sandbox-work" } } }),
        );
        assert_eq!(
            event_of(&start, &name_of),
            Some(Event::Sandbox("work".into()))
        );
        let joined = line(
            json!({ "Type": "network", "Action": "connect", "Actor": { "Attributes": { "container": "c0ffee", "name": "proj_default" } } }),
        );
        assert_eq!(
            event_of(&joined, &name_of),
            Some(Event::Sandbox("work".into()))
        );
        // A sibling joining or leaving, or one already gone, changes the exclusions of whoever shares its network.
        let sibling = line(
            json!({ "Type": "network", "Action": "connect", "Actor": { "Attributes": { "container": "beef" } } }),
        );
        assert_eq!(event_of(&sibling, &name_of), Some(Event::Other));
        let gone = line(
            json!({ "Type": "network", "Action": "disconnect", "Actor": { "Attributes": { "container": "dead" } } }),
        );
        assert_eq!(event_of(&gone, &name_of), Some(Event::Other));
        let postgres = line(
            json!({ "Type": "container", "Action": "start", "Actor": { "Attributes": { "name": "postgres" } } }),
        );
        assert_eq!(event_of(&postgres, &name_of), Some(Event::Other));
        // A parked copy is its sandbox; a tunnel and an event the fence does not follow are nothing.
        let parked = line(
            json!({ "Type": "container", "Action": "start", "Actor": { "Attributes": { "name": "intentic-sandbox-work.previous" } } }),
        );
        assert_eq!(
            event_of(&parked, &name_of),
            Some(Event::Sandbox("work".into()))
        );
        let tunnel = line(
            json!({ "Type": "container", "Action": "start", "Actor": { "Attributes": { "name": "intentic-sandbox-tunnel-work" } } }),
        );
        assert_eq!(event_of(&tunnel, &name_of), Some(Event::Other));
        let died = line(
            json!({ "Type": "container", "Action": "die", "Actor": { "Attributes": { "name": "intentic-sandbox-work" } } }),
        );
        assert_eq!(event_of(&died, &name_of), None);

        let fenced = vec!["work".to_string(), "lab".to_string()];
        assert_eq!(
            to_settle(&[Event::Sandbox("new".into())], &fenced),
            vec!["new".to_string()]
        );
        assert_eq!(
            to_settle(
                &[Event::Sandbox("lab".into()), Event::Other, Event::Other],
                &fenced
            ),
            vec!["lab".to_string(), "work".to_string()]
        );
        assert!(to_settle(&[], &fenced).is_empty());
    }

    #[test]
    fn the_followers_helper_is_kept_reused_while_it_runs_and_replaced_otherwise() {
        assert_eq!(keep(None, "sha256:a"), Keep::Create);
        assert_eq!(keep(Some((true, "sha256:a")), "sha256:a"), Keep::Reuse);
        assert_eq!(keep(Some((false, "sha256:a")), "sha256:a"), Keep::Replace);
        assert_eq!(keep(Some((true, "sha256:old")), "sha256:a"), Keep::Replace);
        // One per side of the computer, the same name every time it starts there.
        assert_eq!(kept_name("windows"), kept_name("windows"));
        assert_ne!(kept_name("windows"), kept_name("linux/archlinux"));
        assert!(kept_name("windows").starts_with("intentic-egress-follow-"));
        let args = kept_args("intentic-egress-follow-x", "sha256:a", "windows").join(" ");
        assert!(args.starts_with("run -d --name intentic-egress-follow-x --restart no --network host --cap-drop ALL --cap-add NET_ADMIN"));
        assert!(args.contains("--pull never"));
        assert!(args
            .contains("--label dev.intentic.kind=egress-helper --label dev.intentic.side=windows"));
        assert!(args.ends_with("--entrypoint sleep sha256:a infinity"));
        // An exec refused because the helper went away starts it again; nft's own refusal does not.
        assert!(helper_gone(
            "Error response from daemon: No such container: intentic-egress-follow-x"
        ));
        assert!(helper_gone(
            "Error response from daemon: container abc is not running"
        ));
        assert!(!helper_gone("Error: syntax error, unexpected newline"));
        // A restart that races docker's removal of the old helper waits; any other refusal does not.
        assert!(name_still_taken(
            "docker: Error response from daemon: Conflict. The container name \"/intentic-egress-follow-caf90169ee\" is already in use by container \"ba9fd2df\". You have to remove (or rename) that container to be able to reuse that name."
        ));
        assert!(name_still_taken(
            "Error response from daemon: removal of container ba9fd2df is already in progress"
        ));
        assert!(!name_still_taken(
            "Error response from daemon: No such image: sha256:0123"
        ));
    }

    #[test]
    fn the_status_reads_as_a_sentence() {
        assert_eq!(
            sentence(&json!({ "effectiveProfile": "open", "state": "off" })),
            "open, nothing fenced."
        );
        assert_eq!(
            sentence(
                &json!({ "effectiveProfile": "internet-only", "state": "enforced", "advisory": true })
            ),
            "internet-only, enforced (advisory: it runs privileged, as the host's root)."
        );
    }
}
