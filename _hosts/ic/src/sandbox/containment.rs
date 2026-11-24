use std::time::Duration;

use serde_json::{json, Value};

use crate::checks::{Finding, Outcome};
use crate::docker;
use crate::shape::{self, Shape};
use crate::ui;

/* WHAT HOLDS A RUNAWAY INSIDE A SANDBOX, READ FROM INSIDE IT (2026-11-05). On rog one process an agent started grew to
17.6 GB of RSS and 33 GB of swap: the container had an 18 GiB memory cap and no swap bound at all, so it paged into the
WSL VM's whole swap, the VM thrashed for 1 h 48 m, the daemon froze and five turns were cut. ic had asked for a bound
(`--memory-swap`), and the engine dropped it: its dockerd reports no swap-limit support, says so in one warning line at
`docker run`, and records the container with `MemorySwap: -1` as if nothing had been asked. So docker's own account of a
container's swap is not evidence of anything here. What is: the kernel's own files inside the container,
/sys/fs/cgroup/memory.swap.max at its root and /sys/fs/cgroup/workload/memory.swap.max at the leaf every process but the
daemon and netd runs in, which the sandbox bounds itself whatever the engine does (the sandbox's
system/resources/memory-records.ts owns those bounds). This module reads them for `ic sandbox list --json` and `ic sandbox
doctor`, changes the leaf's swap live when that is all the owner changed, and says after a launch when the engine
ignored the bound it was handed. */

const GIB: u64 = 1024 * 1024 * 1024;

/// One read inside a running sandbox. A listing makes one per running sandbox, so it is short: a sandbox that does not
/// answer an exec in this long is listed without the reading rather than holding every screen that waits on the list.
const READ_LIMIT: Duration = Duration::from_secs(5);

/// The doctor's reads, which may walk /proc once: still bounded, since a doctor is most asked of a machine in trouble.
const DOCTOR_LIMIT: Duration = Duration::from_secs(10);

/// One cgroup's swap bound as the kernel holds it: a number of bytes, or `max`, which is none at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bound {
    Bytes(u64),
    Unbounded,
}

impl Bound {
    /// The kernel's spelling (`max`, or bytes); None for anything else, such as a file that is not there.
    fn parse(text: &str) -> Option<Bound> {
        match text.trim() {
            "max" => Some(Bound::Unbounded),
            digits => digits.parse::<u64>().ok().map(Bound::Bytes),
        }
    }

    /// The contract's spelling: bytes, or null for unbounded.
    fn json(self) -> Value {
        match self {
            Bound::Bytes(bytes) => json!(bytes),
            Bound::Unbounded => Value::Null,
        }
    }

    fn words(self) -> String {
        match self {
            Bound::Bytes(bytes) => gib_words(bytes),
            Bound::Unbounded => "none".to_string(),
        }
    }
}

/// What a live reshape left in the override file (shape::WORKLOAD_BOUNDS_OVERRIDE): the swap in force, in whole GiB, and
/// whether the owner asked for the default rather than a number. The sandbox reads only `swapGib` (it needs the number);
/// the marker is ic's, so that a swap set back to the default reads back as the default and a later change of the cap
/// moves it, instead of the number the default happened to come to being pinned as the owner's ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Live {
    pub gib: u64,
    pub default: bool,
}

impl Live {
    /// The owner's ask it stands for: None for the default, the number otherwise.
    pub fn ask(self) -> Option<u64> {
        (!self.default).then_some(self.gib)
    }
}

/// What bounds a running sandbox's swap, as the kernel inside it holds it, and the swap a live reshape wrote into it.
/// `workload` is None on an image from before the sandbox bounded its own leaf (it has no such leaf).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reading {
    pub root: Option<Bound>,
    pub workload: Option<Bound>,
    /// The live override, when one was written.
    pub live: Option<Live>,
}

/// The three files, one per line, each named so a file that is not there reads as absent rather than shifting the rest.
fn bounds_script() -> String {
    format!(
        "printf 'root=%s\\n' \"$(cat /sys/fs/cgroup/memory.swap.max 2>/dev/null)\"; \
         printf 'workload=%s\\n' \"$(cat /sys/fs/cgroup/workload/memory.swap.max 2>/dev/null)\"; \
         printf 'override=%s\\n' \"$(cat {} 2>/dev/null | tr -d '\\n')\"",
        shape::WORKLOAD_BOUNDS_OVERRIDE
    )
}

/// The value of one `name=value` line of a script's answer. Pure.
fn field<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    text.lines()
        .find_map(|line| line.trim_end_matches('\r').strip_prefix(prefix.as_str()))
}

/// `{"swapGib": n}` (with ic's `"default": true` beside it when the default was asked) read back; None for anything else
/// (a file torn mid-write, a hand edit). Pure.
pub fn override_live(text: &str) -> Option<Live> {
    let value = serde_json::from_str::<Value>(text.trim()).ok()?;
    let gib = value.get("swapGib")?.as_u64().filter(|gib| *gib >= 1)?;
    Some(Live {
        gib,
        default: value.get("default").and_then(Value::as_bool) == Some(true),
    })
}

/// The bounds script's answer, read. Pure.
pub fn parse_reading(text: &str) -> Reading {
    Reading {
        root: field(text, "root").and_then(Bound::parse),
        workload: field(text, "workload").and_then(Bound::parse),
        live: field(text, "override").and_then(override_live),
    }
}

/// The bounds in force inside `container`, from one short exec. None when the container did not answer it (stopped,
/// wedged, or a docker that refused).
pub fn read(container: &str) -> Option<Reading> {
    read_within(container, READ_LIMIT)
}

fn read_within(container: &str, limit: Duration) -> Option<Reading> {
    let script = bounds_script();
    docker::ask(&["exec", container, "sh", "-c", &script], limit)
        .said()
        .map(|text| parse_reading(&text))
}

/// Every running container's reading at once, one thread each, so a listing of eight sandboxes waits about as long as
/// the slowest one rather than the sum of them.
pub fn read_all(containers: &[String]) -> Vec<(String, Reading)> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = containers
            .iter()
            .map(|container| {
                scope.spawn(move || read(container).map(|reading| (container.clone(), reading)))
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| handle.join().ok().flatten())
            .collect()
    })
}

/// The listing's two fields for one reading (`SandboxResourcesSchema`'s swapMaxBytes and workloadSwapMaxBytes): bytes,
/// null for unbounded, and absent when the file was not there to read. Pure.
pub fn listed_fields(reading: &Reading) -> Vec<(&'static str, Value)> {
    let mut fields = Vec::new();
    if let Some(root) = reading.root {
        fields.push(("swapMaxBytes", root.json()));
    }
    if let Some(workload) = reading.workload {
        fields.push(("workloadSwapMaxBytes", workload.json()));
    }
    fields
}

/// The swap a live reshape left in `container` (works on a stopped container too: the file is on its own filesystem,
/// which `docker cp` reads either way). None when there is none.
pub fn live_swap(container: &str) -> Option<Live> {
    let dir = tempfile::tempdir().ok()?;
    let path = dir.path().join("workload-bounds.json");
    if docker::cp_out(container, shape::WORKLOAD_BOUNDS_OVERRIDE, &path).is_some() {
        return None;
    }
    override_live(&std::fs::read_to_string(&path).ok()?)
}

/* THE SWAP CHANGED LIVE: no restart for a bound the kernel takes at once. */

/// What a live change of the swap reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leaf {
    /// The workload leaf holds the new bound now.
    Bounded,
    /// The image has no workload leaf (it predates the sandbox's own bounds): the value is kept for the next image.
    Missing,
    /// The leaf is there and refused the write.
    Refused,
}

/// The script a live reshape runs in the container: the override first (what the daemon and every later read take as
/// the swap now), written whole and renamed so a reader never sees half of it, then the leaf's own bound. Its answer
/// is one `override=` and one `leaf=` line.
fn live_script(json_text: &str, bytes: u64) -> String {
    let file = shape::WORKLOAD_BOUNDS_OVERRIDE;
    let dir = file
        .rsplit_once('/')
        .map_or("/run/intentic", |(dir, _)| dir);
    format!(
        "if mkdir -p {dir} && printf '%s' '{json_text}' > {file}.tmp && mv -f {file}.tmp {file}; \
         then echo override=ok; else echo override=failed; fi; \
         if [ -e /sys/fs/cgroup/workload/memory.swap.max ]; then \
           if printf '%s' {bytes} > /sys/fs/cgroup/workload/memory.swap.max 2>/dev/null; \
           then echo leaf=ok; else echo leaf=refused; fi; \
         else echo leaf=missing; fi"
    )
}

/// The live script's answer: None when the override could not be written (nothing changed that a later read would
/// see), else what became of the leaf. Pure.
fn live_outcome(text: &str) -> Option<Leaf> {
    if field(text, "override") != Some("ok") {
        return None;
    }
    Some(match field(text, "leaf") {
        Some("ok") => Leaf::Bounded,
        Some("missing") => Leaf::Missing,
        _ => Leaf::Refused,
    })
}

/* THE DEFAULT, AS THE SANDBOX WORKS IT OUT. The number ic writes into the override file is the one the sandbox then
holds its leaf to (the file wins over everything), so a default ic sizes differently from the sandbox is pinned as if
the owner had asked for it. ic once sized it from docker's `HostConfig.Memory`, which is 0 for a sandbox with no cap:
the formula's floor made that 1 GiB, where the sandbox itself, working from the machine's memory, would hold 4. So the
basis is read inside the container, from the two files the sandbox's own rule reads (daemon-cgroup.ts
`workloadSwapGib`, and the entrypoint's copy): its root cgroup's memory.max, and /proc/meminfo's MemTotal when that is
`max`. Writing `{"default": true}` with no number and leaving the sizing to the sandbox would not do: its keeper takes a
file without `swapGib` as no override and falls back to SANDBOX_SWAP, which still carries the owner's previous number
when the container was made with one. */

/// What the sandbox sizes its default swap from: its root cgroup's memory.max and the machine's MemTotal (in kB), one
/// named line each.
const BASIS_SCRIPT: &str = "printf 'cap=%s\\n' \"$(cat /sys/fs/cgroup/memory.max 2>/dev/null)\"; \
     printf 'machine=%s\\n' \"$(sed -n 's/^MemTotal: *\\([0-9][0-9]*\\) kB$/\\1/p' /proc/meminfo 2>/dev/null)\"";

/// The bytes the sandbox's default swap is a share of, from the basis script's answer: its cap (a memory.max above 0),
/// else the machine's memory, else 1 GiB. daemon-cgroup.ts's `capBytes ?? machineBytes ?? GIB`, by the same reads. Pure.
pub fn default_basis(text: &str) -> u64 {
    let number = |name: &str| {
        field(text, name)
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
    };
    number("cap")
        .or_else(|| number("machine").map(|kib| kib.saturating_mul(1024)))
        .unwrap_or(GIB)
}

/// The default swap of the running `container` in whole GiB, sized as the sandbox sizes it. None when it did not answer.
fn default_swap_inside(container: &str) -> Option<u64> {
    docker::ask(&["exec", container, "sh", "-c", BASIS_SCRIPT], READ_LIMIT)
        .said()
        .map(|text| shape::default_swap_gib(default_basis(&text)))
}

/// The owner's own number of GiB in `target`, None when it asks for the default. Pure.
pub fn asked_swap_gib(target: &Shape) -> Option<u64> {
    target.swap.as_deref().and_then(shape::gib_of)
}

/// Change the swap of a RUNNING sandbox to `target`'s without recreating it: the override file the sandbox reads its
/// bounds from, the workload leaf's memory.swap.max itself, and (best effort) docker's own bound on the container root.
/// None when the container would not answer the read the default is sized from, or would not take the override at all,
/// which the caller answers by recreating it as before (and a recreated sandbox sizes its default itself).
///
/// `docker update --memory-swap` is asked for and its answer ignored: an engine without swap-limit support (rog's, on
/// 2026-11-05) takes it with a warning and keeps the container unbounded, which is exactly why the leaf is written
/// first. Where the engine does support it, it bounds the root at the cap plus the same swap, as a recreate would.
pub fn apply_live(container: &str, target: &Shape) -> Option<(u64, Leaf)> {
    let cap = docker::inspect(container, "{{.HostConfig.Memory}}")
        .and_then(|bytes| bytes.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let gib = match asked_swap_gib(target) {
        Some(gib) => gib,
        None => default_swap_inside(container)?,
    };
    // The marker rides only for the default, so a file holding the owner's number is exactly the sandbox's own shape.
    let json_text = if target.swap.is_none() {
        json!({ "swapGib": gib, "default": true })
    } else {
        json!({ "swapGib": gib })
    }
    .to_string();
    let script = live_script(&json_text, gib * GIB);
    let said = docker::ask(&["exec", container, "sh", "-c", &script], DOCTOR_LIMIT).said()?;
    let leaf = live_outcome(&said)?;
    if cap > 0 {
        let memory = cap.to_string();
        let memory_swap = (cap + gib * GIB).to_string();
        let _ = docker::ask(
            &[
                "update",
                "--memory",
                &memory,
                "--memory-swap",
                &memory_swap,
                container,
            ],
            Duration::from_secs(20),
        );
    }
    Some((gib, leaf))
}

/* AFTER A LAUNCH: say once when the engine dropped the bound it was handed. */

/// docker's own words when it accepts a run and drops its `--memory-swap` (daemon/daemon_unix.go): an engine that reports
/// no swap-limit support.
const SWAP_DROPPED: &str = "Memory limited without swap";

/// Whether a launch docker accepted said it dropped the swap bound. Pure.
pub fn swap_dropped(said: &str) -> bool {
    said.contains(SWAP_DROPPED)
}

/// Whether the engine reports no swap-limit support (`docker info`'s SwapLimit); None when it did not say.
pub fn engine_swap_limit() -> Option<bool> {
    match docker::ask(
        &["info", "--format", "{{.SwapLimit}}"],
        Duration::from_secs(15),
    )
    .said()?
    .trim()
    {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// The one line said after a launch whose swap bound the engine ignored: what it means and where to read the bound in
/// force. Pure.
pub fn ignored_line(slug: &str) -> String {
    format!(
        "this Docker engine ignores --memory-swap (it reports no swap-limit support), so docker does not bound how much swap {slug} may use: the sandbox's own workload bound applies instead. `ic sandbox doctor {slug}` reports the bound in force."
    )
}

/// After `docker run` created a sandbox container: one warning when the engine dropped its swap bound. docker's own
/// warning is the evidence when the run line asked for a bound; `docker info` is asked only when it did not (an image
/// whose run contract predates `--memory-swap`), so a launch on a healthy engine costs nothing more.
pub fn after_launch(slug: &str, argv: &[String], said: &str) {
    let asked = argv.iter().any(|arg| arg == "--memory-swap");
    if swap_dropped(said) || (!asked && engine_swap_limit() == Some(false)) {
        ui::warn(&ignored_line(slug));
    }
}

/* `ic sandbox doctor`'s containment checks. Each is a warning at worst, never a failure: a sandbox that is reachable
and working is not broken because a runaway would not be held, but its owner should hear it before one happens. */

/// What the doctor reads inside a running sandbox beyond the bounds: the swap of the machine it runs on (`/proc/swaps`
/// in a container is the VM's or the host's), and every process running the daemon's entry point with its cgroup.
fn doctor_script() -> String {
    format!(
        "{}; \
         s=0; while read -r f t z u p; do case \"$z\" in ''|*[!0-9]*) ;; *) s=$((s+z));; esac; done < /proc/swaps; \
         printf 'swaps=%s\\n' \"$s\"; \
         for p in /proc/[0-9]*; do \
           c=$(tr '\\000' ' ' < $p/cmdline 2>/dev/null) || continue; \
           case \"$c\" in *'/opt/sandbox/dist/main.js'*) \
             printf 'proc=%s\\t%s\\n' \"$(cat $p/cgroup 2>/dev/null | head -n 1)\" \"$c\";; esac; \
         done",
        bounds_script()
    )
}

/// What the doctor's script said.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Inside {
    pub bounds: Reading,
    /// The machine's swap in bytes, as the sandbox sees it.
    pub host_swap: Option<u64>,
    /// The daemon's cgroup (`0::/daemon`), or None when no daemon process was found.
    pub daemon_cgroup: Option<String>,
}

/// The doctor script's answer, read. The daemon is the process whose program is node and whose arguments name the
/// daemon's entry point; netd, which carries the same line as its child's arguments, is not it. Pure.
pub fn parse_inside(text: &str) -> Inside {
    let daemon_cgroup = text.lines().find_map(|line| {
        let (cgroup, cmdline) = line
            .trim_end_matches('\r')
            .strip_prefix("proc=")?
            .split_once('\t')?;
        let program = cmdline.split_whitespace().next()?;
        (program == "node" || program.ends_with("/node")).then(|| cgroup.trim().to_string())
    });
    Inside {
        bounds: parse_reading(text),
        host_swap: field(text, "swaps")
            .and_then(|kib| kib.trim().parse::<u64>().ok())
            .map(|kib| kib * 1024),
        daemon_cgroup,
    }
}

/// The check names, as the doctor prints them and its `--json` carries them.
pub const SWAP_BOUND: &str = "Swap bound";
pub const ENGINE_SWAP: &str = "Engine swap limit";
pub const HOST_SWAP: &str = "Machine swap";
pub const OOM_KILLER: &str = "Out-of-memory killer";
pub const DAEMON_LEAF: &str = "Daemon's own cgroup";

fn gib_words(bytes: u64) -> String {
    let gib = bytes as f64 / GIB as f64;
    if (gib - gib.round()).abs() < 0.05 {
        format!("{} GiB", gib.round() as u64)
    } else {
        format!("{gib:.1} GiB")
    }
}

/// (a) Whether anything bounds the sandbox's swap: the leaf the sandbox holds itself, or docker's bound on the root. Pure.
pub fn swap_bound_outcome(bounds: &Reading, slug: &str) -> Outcome {
    match (bounds.root, bounds.workload) {
        (_, Some(Bound::Bytes(_))) | (Some(Bound::Bytes(_)), _) => Outcome::Pass,
        (None, None) => Outcome::Skip {
            why: "the sandbox's cgroup files could not be read".to_string(),
        },
        (_, workload) => Outcome::Warn {
            problem: format!(
                "nothing bounds how much swap {slug} may use ({}): one runaway process can page into all of this machine's swap, and the whole machine slows to a crawl long before anything is stopped. {}",
                match workload {
                    None => "the container's swap is unbounded, and its image is older than the bound a sandbox holds its own work to".to_string(),
                    Some(_) => "unbounded at the container and at its workload".to_string(),
                },
                match workload {
                    None => format!("Updating it (ic sandbox update {slug}) brings an image that bounds its own work."),
                    Some(_) => format!("Restarting it (ic sandbox restart {slug}) puts its own bound back; `ic sandbox shape {slug} --swap 4g --when now` sets one at once."),
                }
            ),
        },
    }
}

/// (b) Whether the engine honours `--memory-swap`. `intentic` is whether it is Intentic's own engine, whose keeper
/// fixes this at its next start. Pure.
pub fn engine_swap_outcome(swap_limit: Option<bool>, intentic: bool) -> Outcome {
    match swap_limit {
        Some(true) => Outcome::Pass,
        None => Outcome::Skip {
            why: "the Docker engine did not say".to_string(),
        },
        Some(false) => Outcome::Warn {
            problem: format!(
                "this Docker engine reports no swap-limit support, so it ignores the swap bound each sandbox is started with (`docker inspect` then shows MemorySwap -1); only the bound a sandbox holds its own work to applies. {}",
                if intentic {
                    "Intentic's engine sets this up when it next starts; `ic engine restart` does it now, and restarts every sandbox on it, so pick a quiet moment."
                } else {
                    "It needs swap accounting in the kernel and the memory controller in the cgroup dockerd runs in; the engine's maker documents how."
                }
            ),
        },
    }
}

/// (c) Whether the machine's swap is more than twice the sandbox's cap: room for a runaway to thrash the machine for an
/// hour where it would otherwise have met its OOM in a minute. Pure.
pub fn host_swap_outcome(host_swap: Option<u64>, cap: u64, bounds: &Reading) -> Outcome {
    let (Some(swap), true) = (host_swap, cap > 0) else {
        return Outcome::Skip {
            why: "the machine's swap or the sandbox's memory cap is not known".to_string(),
        };
    };
    if swap <= cap.saturating_mul(2) {
        return Outcome::Pass;
    }
    let held = match bounds.workload {
        Some(Bound::Bytes(bytes)) => format!(
            "The sandbox's own bound ({} for its work) is what keeps a runaway out of it.",
            gib_words(bytes)
        ),
        _ => "Nothing in the sandbox keeps a runaway out of it, see the swap bound above."
            .to_string(),
    };
    Outcome::Warn {
        problem: format!(
            "this machine has {} of swap, more than twice the sandbox's {} memory cap: a process that outgrows the cap can keep paging into it for a long time (on 2026-11-05 one paged 33 GB and froze a machine for almost two hours) before any out-of-memory kill. {held}",
            gib_words(swap),
            gib_words(cap)
        ),
    }
}

/// (e) Whether the daemon runs in its own `/daemon` leaf, where a runaway in the sandbox's work cannot take the memory it
/// needs to keep answering. Pure.
pub fn daemon_leaf_outcome(daemon_cgroup: Option<&str>, slug: &str) -> Outcome {
    match daemon_cgroup {
        None => Outcome::Skip {
            why: "the sandbox's daemon is not running".to_string(),
        },
        Some(cgroup) if cgroup.rsplit("::").next() == Some("/daemon") => Outcome::Pass,
        Some(cgroup) => Outcome::Warn {
            problem: format!(
                "the sandbox's daemon runs in {} instead of its own /daemon cgroup, so a runaway in the sandbox's work competes with it for memory and the daemon is what freezes first. Restarting it (ic sandbox restart {slug}) puts it back; if it is still there after, its image is older than these bounds and ic sandbox update {slug} brings them.",
                cgroup.rsplit("::").next().unwrap_or(cgroup)
            ),
        },
    }
}

/// (d) A userland out-of-memory killer in a WSL distro that cannot see the sandbox's processes: each WSL distro has
/// processes of its own, and the sandboxes run in the engine's. Measured on rog, 2026-11-05: earlyoom in `archlinux`
/// logged `selected myself` and `Could not find a process to kill` while a sandbox paged the VM to a standstill. `found`
/// is each other distro with the killers running in it. Pure.
pub fn oom_killer_outcome(engine_distro: &str, found: &[(String, Vec<String>)]) -> Outcome {
    let named: Vec<String> = found
        .iter()
        .filter(|(distro, killers)| {
            !killers.is_empty() && !distro.eq_ignore_ascii_case(engine_distro)
        })
        .map(|(distro, killers)| format!("{} in {distro}", killers.join(" and ")))
        .collect();
    if named.is_empty() {
        return Outcome::Pass;
    }
    Outcome::Warn {
        problem: format!(
            "{} runs, but the sandboxes run in {engine_distro}, whose processes it cannot see: when memory runs short it can only stop what runs beside it, never a runaway in a sandbox. It does not protect the sandboxes; the bound each sandbox holds its own work to does.",
            named.join(", ")
        ),
    }
}

/// The WSL distro the engine's containers run in, when this side can tell: Intentic's engine, Docker Desktop's, or this
/// very distro for a Docker engine installed in it.
fn engine_distro() -> Option<String> {
    if docker::intentic_engine_in_use() {
        return Some(crate::engine::DISTRO.to_string());
    }
    if cfg!(windows) {
        return (crate::engine::stamp() == "docker-desktop").then(|| "docker-desktop".to_string());
    }
    std::env::var("WSL_DISTRO_NAME")
        .ok()
        .filter(|name| !name.is_empty())
}

/// `wsl.exe <args>`, bounded, with its output as text: WSL_UTF8 asks for UTF-8, and the NULs of the UTF-16 an older WSL
/// prints anyway are dropped, which leaves the ASCII of a distro's name readable either way.
fn wsl(args: &[&str], limit: Duration) -> Option<String> {
    let mut command = std::process::Command::new("wsl.exe");
    command.args(args).env("WSL_UTF8", "1");
    let ran = docker::bounded(command, limit).ok()?;
    (!ran.timed_out && ran.code == Some(0)).then(|| ran.stdout.replace('\0', ""))
}

/// The distro names of `wsl.exe -l --running -q`. Pure.
fn running_of(listing: &str) -> Vec<String> {
    listing
        .lines()
        .map(|line| line.trim().trim_start_matches('\u{feff}'))
        .filter(|line| !line.is_empty() && !line.contains(' '))
        .map(str::to_string)
        .collect()
}

/// The userland OOM killers running in each running WSL distro, asked of each through wsl.exe (`--running` boots
/// nothing, and a distro that runs is not started again by an exec in it). Only on Windows, or inside WSL where wsl.exe
/// reaches the Windows side; elsewhere there are no distros to ask.
fn killers_by_distro() -> Option<Vec<(String, Vec<String>)>> {
    let in_wsl = std::env::var("WSL_DISTRO_NAME").is_ok_and(|name| !name.is_empty());
    if !cfg!(windows) && !in_wsl {
        return None;
    }
    let distros = running_of(&wsl(&["-l", "--running", "-q"], Duration::from_secs(15))?);
    if distros.is_empty() {
        return None;
    }
    Some(
        distros
            .into_iter()
            .map(|distro| {
                let said = wsl(
                    &[
                        "-d",
                        &distro,
                        "--exec",
                        "sh",
                        "-c",
                        "for k in earlyoom systemd-oomd nohang; do pgrep -x $k >/dev/null 2>&1 && echo $k; done; true",
                    ],
                    Duration::from_secs(10),
                )
                .unwrap_or_default();
                let killers = said
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_string)
                    .collect();
                (distro, killers)
            })
            .collect(),
    )
}

/// What the machine-wide checks read: the engine's swap-limit support, the WSL distro its containers run in, and the OOM
/// killers running in each WSL distro. The same for every sandbox, so read once per run and kept: a doctor over eight
/// sandboxes asks `docker info` and wsl.exe once rather than eight times, each of which may wait seconds on a machine in
/// trouble. A doctor is one short-lived process, so nothing kept here outlives the answer it went into.
struct Machine {
    swap_limit: Option<bool>,
    intentic: bool,
    engine_distro: Option<String>,
    killers: Option<Vec<(String, Vec<String>)>>,
}

fn machine() -> &'static Machine {
    static READ: std::sync::OnceLock<Machine> = std::sync::OnceLock::new();
    READ.get_or_init(|| Machine {
        swap_limit: engine_swap_limit(),
        intentic: docker::intentic_engine_in_use(),
        engine_distro: engine_distro(),
        killers: killers_by_distro(),
    })
}

/// Every containment check for one sandbox, read now. `cap` is its memory cap in bytes (0 for none); `running` whether
/// its container runs, without which nothing inside it can be read.
pub fn findings(slug: &str, container: &str, cap: u64, running: bool) -> Vec<Finding> {
    let inside = running
        .then(|| {
            docker::ask(
                &["exec", container, "sh", "-c", &doctor_script()],
                DOCTOR_LIMIT,
            )
            .said()
        })
        .flatten()
        .map(|text| parse_inside(&text));
    let not_running = || Outcome::Skip {
        why: if running {
            "the sandbox did not answer a read inside it".to_string()
        } else {
            "the sandbox is not running".to_string()
        },
    };
    let machine = machine();
    let oom = match (&machine.engine_distro, &machine.killers) {
        (Some(engine), Some(found)) => oom_killer_outcome(engine, found),
        (None, Some(_)) => Outcome::Skip {
            why: "which WSL distro runs the Docker engine is not known here".to_string(),
        },
        (_, None) => Outcome::Skip {
            why: "no WSL here".to_string(),
        },
    };
    vec![
        Finding {
            name: SWAP_BOUND,
            outcome: inside.as_ref().map_or_else(not_running, |inside| {
                swap_bound_outcome(&inside.bounds, slug)
            }),
        },
        Finding {
            name: ENGINE_SWAP,
            outcome: engine_swap_outcome(machine.swap_limit, machine.intentic),
        },
        Finding {
            name: HOST_SWAP,
            outcome: inside.as_ref().map_or_else(not_running, |inside| {
                host_swap_outcome(inside.host_swap, cap, &inside.bounds)
            }),
        },
        Finding {
            name: OOM_KILLER,
            outcome: oom,
        },
        Finding {
            name: DAEMON_LEAF,
            outcome: inside.as_ref().map_or_else(not_running, |inside| {
                daemon_leaf_outcome(inside.daemon_cgroup.as_deref(), slug)
            }),
        },
    ]
}

/// The findings as doctor's `--json` carries them, beside the report (never inside it: that is the platform's shape,
/// whose check ids are fixed). `bounds` is the reading itself, for a reader that wants the numbers. Pure.
pub fn findings_json(findings: &[Finding]) -> Value {
    Value::Array(
        findings
            .iter()
            .map(|finding| {
                let (state, said) = match &finding.outcome {
                    Outcome::Pass => ("ok", None),
                    Outcome::Warn { problem } => ("warn", Some(problem.as_str())),
                    // Never produced here; spelled for completeness, as the doctor's other rows spell it.
                    Outcome::Fail { problem, .. } => ("fail", Some(problem.as_str())),
                    Outcome::Skip { why } => ("skip", Some(why.as_str())),
                };
                let mut row = json!({ "check": finding.name, "state": state });
                if let Some(said) = said {
                    row["problem"] = json!(said);
                }
                row
            })
            .collect(),
    )
}

/// The bound in force, in words, for the line a live reshape ends on.
pub fn in_force_words(reading: &Reading) -> String {
    format!(
        "workload {}, container {}",
        reading
            .workload
            .map_or("not bounded by this image".to_string(), Bound::words),
        reading.root.map_or("unknown".to_string(), Bound::words)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB4: u64 = 4 * GIB;

    #[test]
    fn the_kernels_files_are_read_as_bytes_or_unbounded_and_a_missing_one_is_absent() {
        let reading = parse_reading("root=max\nworkload=4294967296\noverride={\"swapGib\":4}\n");
        assert_eq!(
            reading,
            Reading {
                root: Some(Bound::Unbounded),
                workload: Some(Bound::Bytes(GIB4)),
                live: Some(Live {
                    gib: 4,
                    default: false
                }),
            }
        );
        // An image from before the sandbox's own bounds has no leaf and no override.
        let old = parse_reading("root=max\nworkload=\noverride=\n");
        assert_eq!(old.workload, None);
        assert_eq!(old.live, None);
        assert_eq!(listed_fields(&old), vec![("swapMaxBytes", Value::Null)]);
        assert_eq!(
            listed_fields(&reading),
            vec![
                ("swapMaxBytes", Value::Null),
                ("workloadSwapMaxBytes", json!(GIB4))
            ]
        );
        // A torn or foreign override is no override.
        for torn in ["{\"swapGib\":", "{\"swapGib\":0}", "{\"swap\":4}", "4"] {
            assert_eq!(override_live(torn), None, "{torn}");
        }
        // The default asked live reads back as the default, with the number it came to beside it.
        let reset = override_live("{\"default\":true,\"swapGib\":4}").expect("an override");
        assert_eq!((reset.gib, reset.ask()), (4, None));
        assert_eq!(
            override_live("{\"swapGib\":2}").map(Live::ask),
            Some(Some(2))
        );
    }

    #[test]
    fn a_live_change_says_what_reached_the_leaf_and_nothing_counts_without_the_override() {
        assert_eq!(live_outcome("override=ok\nleaf=ok\n"), Some(Leaf::Bounded));
        assert_eq!(
            live_outcome("override=ok\nleaf=missing\n"),
            Some(Leaf::Missing)
        );
        assert_eq!(
            live_outcome("override=ok\nleaf=refused\n"),
            Some(Leaf::Refused)
        );
        assert_eq!(live_outcome("override=failed\nleaf=ok\n"), None);
        assert_eq!(live_outcome(""), None);
        let script = live_script("{\"swapGib\":2}", 2 * GIB);
        assert!(script.contains("/run/intentic/workload-bounds.json.tmp"));
        assert!(script.contains("printf '%s' 2147483648 > /sys/fs/cgroup/workload/memory.swap.max"));
    }

    #[test]
    fn the_swap_asked_is_the_owners_number_or_the_default_sized_inside() {
        let asked = Shape {
            swap: Some("6g".into()),
            ..Shape::default()
        };
        assert_eq!(asked_swap_gib(&asked), Some(6));
        assert_eq!(asked_swap_gib(&Shape::default()), None);
        let default_of = |text: &str| shape::default_swap_gib(default_basis(text));
        // A capped sandbox: a quarter of its root's memory.max, whatever the machine has.
        assert_eq!(default_of("cap=19327352832\nmachine=32768000\n"), 4);
        assert_eq!(default_of("cap=7516192768\nmachine=32768000\n"), 2);
    }

    // An uncapped sandbox sizes its default from the machine's memory, as the sandbox does (daemon-cgroup.ts): a 32 GiB
    // machine gives 4 GiB. Sized from docker's HostConfig.Memory of 0, as ic once did, it came to 1 GiB, which the
    // override file then pinned.
    #[test]
    fn an_uncapped_sandboxs_default_is_a_share_of_the_machines_memory() {
        let text = "cap=max\nmachine=32768000\n";
        assert_eq!(default_basis(text), 32_768_000 * 1024);
        assert_eq!(shape::default_swap_gib(default_basis(text)), 4);
        assert_eq!(
            shape::default_swap_gib(default_basis("cap=max\nmachine=8000000\n")),
            2
        );
        // Nothing readable is the sandbox's own last resort, 1 GiB, never 0.
        assert_eq!(default_basis("cap=\nmachine=\n"), GIB);
        assert_eq!(default_basis(""), GIB);
        assert_eq!(default_basis("cap=0\nmachine=8000000\n"), 8_000_000 * 1024);
        assert!(BASIS_SCRIPT.contains("/sys/fs/cgroup/memory.max"));
        assert!(BASIS_SCRIPT.contains("/proc/meminfo"));
    }

    #[test]
    fn docker_dropping_the_bound_is_read_off_its_own_warning() {
        assert!(swap_dropped("WARNING: Your kernel does not support swap limit capabilities or the cgroup is not mounted. Memory limited without swap.\n"));
        assert!(!swap_dropped(""));
        assert!(ignored_line("abc").contains("ic sandbox doctor abc"));
    }

    #[test]
    fn the_swap_bound_warns_only_when_nothing_holds_a_runaway() {
        let rog = Reading {
            root: Some(Bound::Unbounded),
            workload: Some(Bound::Unbounded),
            live: None,
        };
        assert!(matches!(
            swap_bound_outcome(&rog, "s"),
            Outcome::Warn { .. }
        ));
        let old_image = Reading {
            root: Some(Bound::Unbounded),
            workload: None,
            live: None,
        };
        let Outcome::Warn { problem } = swap_bound_outcome(&old_image, "s") else {
            panic!("an unbounded old image is a warning")
        };
        assert!(problem.contains("ic sandbox update s"));
        let leaf = Reading {
            workload: Some(Bound::Bytes(GIB4)),
            ..rog.clone()
        };
        assert!(matches!(swap_bound_outcome(&leaf, "s"), Outcome::Pass));
        let root = Reading {
            root: Some(Bound::Bytes(GIB4)),
            ..rog
        };
        assert!(matches!(swap_bound_outcome(&root, "s"), Outcome::Pass));
        assert!(matches!(
            swap_bound_outcome(&Reading::default(), "s"),
            Outcome::Skip { .. }
        ));
    }

    #[test]
    fn the_engine_and_the_machines_swap_are_warnings_never_failures() {
        assert!(matches!(
            engine_swap_outcome(Some(true), true),
            Outcome::Pass
        ));
        let Outcome::Warn { problem } = engine_swap_outcome(Some(false), true) else {
            panic!("no swap-limit support is a warning")
        };
        assert!(problem.contains("ic engine restart"));
        assert!(matches!(
            engine_swap_outcome(None, false),
            Outcome::Skip { .. }
        ));
        // rog, 2026-11-05: 22 GiB of disk swap and 12 GiB of zram against an 18 GiB cap.
        let rog_swap = (23_068_672 + 12_582_908) * 1024;
        let unbounded = Reading::default();
        assert!(matches!(
            host_swap_outcome(Some(rog_swap), 18 * GIB, &unbounded),
            Outcome::Pass
        ));
        assert!(matches!(
            host_swap_outcome(Some(rog_swap), 12 * GIB, &unbounded),
            Outcome::Warn { .. }
        ));
        assert!(matches!(
            host_swap_outcome(None, 12 * GIB, &unbounded),
            Outcome::Skip { .. }
        ));
    }

    #[test]
    fn the_daemon_is_found_by_its_program_and_held_to_its_own_leaf() {
        // As rog's sandbox answered: netd carries the daemon's line as its child's arguments, and is not the daemon.
        let text = "root=max\nworkload=max\noverride=\nswaps=35651580\n\
            proc=0::/daemon\t/opt/sandbox/netd/intentic-netd -- node /opt/sandbox/dist/main.js \n\
            proc=0::/workload\tnode --max-old-space-size=3072 /opt/sandbox/dist/main.js \n";
        let inside = parse_inside(text);
        assert_eq!(inside.daemon_cgroup.as_deref(), Some("0::/workload"));
        assert_eq!(inside.host_swap, Some(35_651_580 * 1024));
        assert!(matches!(
            daemon_leaf_outcome(inside.daemon_cgroup.as_deref(), "s"),
            Outcome::Warn { .. }
        ));
        assert!(matches!(
            daemon_leaf_outcome(Some("0::/daemon"), "s"),
            Outcome::Pass
        ));
        assert!(matches!(
            daemon_leaf_outcome(None, "s"),
            Outcome::Skip { .. }
        ));
    }

    #[test]
    fn an_oom_killer_beside_the_engine_is_named_and_one_inside_it_is_not() {
        let found = vec![
            ("archlinux".to_string(), vec!["earlyoom".to_string()]),
            ("intentic-engine".to_string(), vec!["earlyoom".to_string()]),
            ("Ubuntu".to_string(), Vec::new()),
        ];
        let Outcome::Warn { problem } = oom_killer_outcome("intentic-engine", &found) else {
            panic!("earlyoom in archlinux cannot see the sandboxes")
        };
        assert!(problem.starts_with("earlyoom in archlinux runs"));
        assert!(!problem.contains("in intentic-engine runs"));
        assert!(matches!(
            oom_killer_outcome("intentic-engine", &found[1..]),
            Outcome::Pass
        ));
    }

    #[test]
    fn running_distros_read_the_same_from_utf8_and_from_utf16_with_its_nuls_dropped() {
        assert_eq!(
            running_of("\u{feff}archlinux\r\n\r\nintentic-engine\r\n"),
            vec!["archlinux", "intentic-engine"]
        );
        let utf16: String = "archlinux\r\n"
            .encode_utf16()
            .flat_map(|unit| [char::from_u32(u32::from(unit)).unwrap(), '\0'])
            .collect();
        assert_eq!(running_of(&utf16.replace('\0', "")), vec!["archlinux"]);
    }

    #[test]
    fn the_json_carries_each_check_with_its_state_and_words() {
        let rows = findings_json(&[
            Finding {
                name: SWAP_BOUND,
                outcome: Outcome::Pass,
            },
            Finding {
                name: ENGINE_SWAP,
                outcome: Outcome::Warn {
                    problem: "ignored".to_string(),
                },
            },
        ]);
        assert_eq!(
            rows,
            json!([
                { "check": "Swap bound", "state": "ok" },
                { "check": "Engine swap limit", "state": "warn", "problem": "ignored" },
            ])
        );
    }
}
