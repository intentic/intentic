use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;

use super::Paths;

/* THE HOST POLICY, AND HOW A SANDBOX CONTAINER RUNS ON INTENTIC OS.

`/usr/lib/intentic-os/os.json` ships the defaults and `/etc/intentic/os.json` holds the owner's own values, which win
key by key: `{ "isolation": "auto", "pairOnLan": true, "updates": "stage" }`. A file that is missing or unreadable
counts as saying nothing, so a machine with neither runs on the defaults.

`isolation` is why this file exists. A sandbox started privileged (the Docker capability) holds the host's root under
runc: a `--privileged` container can mount the host's disks and load kernel modules. In a Kata microVM it gets a kernel
of its own, and the privilege stops at the VM's edge. `container` keeps runc, `vm` puts every sandbox container in a
microVM, and `auto` puts the privileged ones there. The image owns its run line (contract.rs); all ic does is add
`--runtime=kata` right after `run`, at each place it executes a sandbox's run line (connect, every recreate, the
runner), and never on the tunnel sidecar. A run line a microVM cannot honour (the host's network, PID or IPC namespace,
the Docker socket, a GPU), or a dockerd without the `kata` runtime, stays on runc with one line saying why. The
decision is a pure function of the line, the policy and whether dockerd has the runtime, so every branch is a test. */

/// How sandbox containers run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    /// A microVM for a sandbox started privileged, runc for the rest.
    Auto,
    /// A microVM for every sandbox container.
    Vm,
    /// runc for every sandbox container.
    Container,
}

impl Isolation {
    /// The policy file's word for it.
    pub fn word(self) -> &'static str {
        match self {
            Isolation::Auto => "auto",
            Isolation::Vm => "vm",
            Isolation::Container => "container",
        }
    }

    fn from_word(word: &str) -> Option<Isolation> {
        match word {
            "auto" => Some(Isolation::Auto),
            "vm" => Some(Isolation::Vm),
            "container" => Some(Isolation::Container),
            _ => None,
        }
    }
}

/// What the daily update timer does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Updates {
    /// Download a newer image and stage it for the next boot; a reboot into it waits for an approval.
    Stage,
    /// Check nothing.
    Off,
}

impl Updates {
    pub fn word(self) -> &'static str {
        match self {
            Updates::Stage => "stage",
            Updates::Off => "off",
        }
    }
}

/// The host policy, both files laid over the defaults.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub isolation: Isolation,
    /// Whether first-boot pairing serves its page on the local network.
    pub pair_on_lan: bool,
    pub updates: Updates,
}

impl Default for Policy {
    fn default() -> Policy {
        Policy {
            isolation: Isolation::Auto,
            pair_on_lan: true,
            updates: Updates::Stage,
        }
    }
}

/// The defaults with each layer laid over them in order, key by key, and a sentence for every value that was not
/// understood. An isolation word nobody knows is `auto`, said, rather than whatever the layer under it said: a typo in
/// the owner's file must not quietly keep a looser setting. Pure.
pub fn merged(layers: &[(String, Value)]) -> (Policy, Vec<String>) {
    let mut policy = Policy::default();
    let mut said = Vec::new();
    for (name, layer) in layers {
        let Some(layer) = layer.as_object() else {
            said.push(format!(
                "{name} is not a JSON object; its settings were ignored."
            ));
            continue;
        };
        if let Some(value) = layer.get("isolation") {
            policy.isolation = match value.as_str().and_then(Isolation::from_word) {
                Some(isolation) => isolation,
                None => {
                    said.push(format!(
                        "{name}: isolation {value} is not one of auto, vm or container; using auto."
                    ));
                    Isolation::Auto
                }
            };
        }
        if let Some(value) = layer.get("pairOnLan") {
            match value.as_bool() {
                Some(on) => policy.pair_on_lan = on,
                None => said.push(format!(
                    "{name}: pairOnLan {value} is not true or false; kept {}.",
                    policy.pair_on_lan
                )),
            }
        }
        if let Some(value) = layer.get("updates") {
            match value.as_str() {
                Some("stage") => policy.updates = Updates::Stage,
                Some("off") => policy.updates = Updates::Off,
                _ => said.push(format!(
                    "{name}: updates {value} is not stage or off; kept {}.",
                    policy.updates.word()
                )),
            }
        }
    }
    (policy, said)
}

/// Both files as they are on this machine, merged, with what was not understood. A missing file says nothing; one
/// that is there and is not JSON is said and skipped.
pub fn read(paths: &Paths) -> (Policy, Vec<String>) {
    let mut layers = Vec::new();
    let mut said = Vec::new();
    for path in [paths.policy_defaults(), paths.policy_owner()] {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(value) => layers.push((path.display().to_string(), value)),
            Err(err) => said.push(format!(
                "{} is not JSON ({err}); its settings were ignored.",
                path.display()
            )),
        }
    }
    let (policy, mut more) = merged(&layers);
    said.append(&mut more);
    (policy, said)
}

/// This machine's policy, read once per run, its warnings said once.
pub fn current() -> Policy {
    static READ: OnceLock<Policy> = OnceLock::new();
    *READ.get_or_init(|| {
        let (policy, said) = read(&Paths::here());
        for sentence in said {
            crate::ui::warn(&sentence);
        }
        policy
    })
}

/// How long dockerd may take to list its runtimes.
const RUNTIMES_LIMIT: Duration = Duration::from_secs(10);

/// Whether `docker info --format '{{json .Runtimes}}'` names a runtime called `kata`. Pure.
pub fn has_kata(runtimes: &str) -> bool {
    serde_json::from_str::<Value>(runtimes.trim())
        .ok()
        .and_then(|runtimes| runtimes.as_object().map(|map| map.contains_key("kata")))
        .unwrap_or(false)
}

/// Whether dockerd has the `kata` runtime; false on any failure, and asked once per run.
pub fn kata_available() -> bool {
    static ASKED: OnceLock<bool> = OnceLock::new();
    *ASKED.get_or_init(|| {
        crate::docker::capture_bounded(&["info", "--format", "{{json .Runtimes}}"], RUNTIMES_LIMIT)
            .ok()
            .filter(|ran| !ran.timed_out && ran.code == Some(0))
            .is_some_and(|ran| has_kata(&ran.stdout))
    })
}

/// Which runtime a sandbox's run line gets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// runc, as the line stands: the policy does not ask for a microVM.
    Runc,
    /// A Kata microVM: `--runtime=kata` goes in after `run`.
    Kata,
    /// The policy asks for a microVM and this line cannot have one; runc, and the reason is said.
    RuncBecause(String),
}

/// The runtime for one run line under `policy`. Pure.
pub fn vm_runtime(argv: &[String], policy: &Policy, kata_available: bool) -> Decision {
    let line = read_line(argv);
    let wanted = match policy.isolation {
        Isolation::Container => false,
        Isolation::Vm => true,
        Isolation::Auto => line.privileged,
    };
    if !wanted {
        return Decision::Runc;
    }
    if !kata_available {
        return Decision::RuncBecause("dockerd has no kata runtime".to_string());
    }
    match line.blockers.into_iter().next() {
        Some(why) => Decision::RuncBecause(why),
        None => Decision::Kata,
    }
}

/// The run line with `--runtime=kata` right after its leading `run`; any other line as it is. Pure.
pub fn with_kata(argv: &[String]) -> Vec<String> {
    crate::sandbox::labels::into_run(argv, &["--runtime=kata".to_string()])
}

/// A sandbox's run line as ic is about to execute it, under this machine's policy: unchanged off Intentic OS and under
/// `isolation: container`, and otherwise with the runtime [`vm_runtime`] picks. What was decided is said once a run, as
/// a note for a microVM and a warning for a microVM the policy wanted and could not have.
pub fn sandbox_run(argv: Vec<String>) -> Vec<String> {
    if !super::on_intentic_os() {
        return argv;
    }
    let policy = current();
    if policy.isolation == Isolation::Container {
        return argv;
    }
    static SAID: AtomicBool = AtomicBool::new(false);
    let first = !SAID.swap(true, Ordering::SeqCst);
    match vm_runtime(&argv, &policy, kata_available()) {
        Decision::Runc => argv,
        Decision::Kata => {
            if first {
                crate::ui::note(&format!(
                    "this sandbox runs in a Kata microVM (isolation: {}).",
                    policy.isolation.word()
                ));
            }
            with_kata(&argv)
        }
        Decision::RuncBecause(why) => {
            if first {
                crate::ui::warn(&format!(
                    "this sandbox runs as a plain container, not in a microVM (isolation: {}): {why}.",
                    policy.isolation.word()
                ));
            }
            argv
        }
    }
}

/// What a run line says that the decision turns on.
#[derive(Debug, Default, PartialEq, Eq)]
struct Line {
    privileged: bool,
    /// Why a microVM cannot honour this line, one sentence per flag, in the order they appear.
    blockers: Vec<String>,
}

/* `docker run`'s options that take a value as the next word. Everything up to the image is an option, and a word that
follows one of these is its value, not the image: without the list a `--name x` would end the options at `x`. A long
option missing here is read as a switch, which is what every unknown one in the run contract's lines is. */
const VALUE_OPTIONS: &[&str] = &[
    "add-host",
    "annotation",
    "attach",
    "blkio-weight",
    "blkio-weight-device",
    "cap-add",
    "cap-drop",
    "cgroup-parent",
    "cgroupns",
    "cidfile",
    "cpu-count",
    "cpu-percent",
    "cpu-period",
    "cpu-quota",
    "cpu-rt-period",
    "cpu-rt-runtime",
    "cpu-shares",
    "cpus",
    "cpuset-cpus",
    "cpuset-mems",
    "detach-keys",
    "device",
    "device-cgroup-rule",
    "device-read-bps",
    "device-read-iops",
    "device-write-bps",
    "device-write-iops",
    "dns",
    "dns-option",
    "dns-opt",
    "dns-search",
    "domainname",
    "entrypoint",
    "env",
    "env-file",
    "expose",
    "gpus",
    "group-add",
    "health-cmd",
    "health-interval",
    "health-retries",
    "health-start-interval",
    "health-start-period",
    "health-timeout",
    "hostname",
    "ip",
    "ip6",
    "ipc",
    "isolation",
    "kernel-memory",
    "label",
    "label-file",
    "link",
    "link-local-ip",
    "log-driver",
    "log-opt",
    "mac-address",
    "memory",
    "memory-reservation",
    "memory-swap",
    "memory-swappiness",
    "mount",
    "name",
    "net",
    "net-alias",
    "network",
    "network-alias",
    "oom-score-adj",
    "pid",
    "pids-limit",
    "platform",
    "publish",
    "pull",
    "restart",
    "runtime",
    "security-opt",
    "shm-size",
    "stop-signal",
    "stop-timeout",
    "storage-opt",
    "sysctl",
    "tmpfs",
    "ulimit",
    "user",
    "userns",
    "uts",
    "volume",
    "volume-driver",
    "volumes-from",
    "workdir",
];

/// The one-letter options that take a value (`-e`, `-v`, `-p`, …); the rest (`-d`, `-i`, `-t`) are switches.
const VALUE_SHORTS: &[char] = &['a', 'c', 'e', 'h', 'l', 'm', 'p', 'u', 'v', 'w'];

/// Each option of a run line as (long name, value), short ones under their long names, up to the image. Pure.
fn options(argv: &[String]) -> Vec<(String, Option<String>)> {
    let mut words = argv.iter().skip(usize::from(
        argv.first().is_some_and(|first| first == "run"),
    ));
    let mut found = Vec::new();
    while let Some(word) = words.next() {
        if let Some(long) = word.strip_prefix("--") {
            let (name, value) = match long.split_once('=') {
                Some((name, value)) => (name.to_string(), Some(value.to_string())),
                None if VALUE_OPTIONS.contains(&long) => (long.to_string(), words.next().cloned()),
                None => (long.to_string(), None),
            };
            found.push((name, value));
        } else if let Some(short) = word.strip_prefix('-').filter(|short| !short.is_empty()) {
            // `-v x`, `-vx`, `-v=x`; a cluster of switches (`-it`) carries no value.
            let mut letters = short.chars();
            let letter = letters.next().unwrap_or_default();
            if VALUE_SHORTS.contains(&letter) {
                let rest: String = letters.collect();
                let value = if rest.is_empty() {
                    words.next().cloned()
                } else {
                    Some(rest.trim_start_matches('=').to_string())
                };
                found.push((long_of(letter).to_string(), value));
            }
        } else {
            break;
        }
    }
    found
}

/// The long name of a one-letter option the decision reads.
fn long_of(letter: char) -> &'static str {
    match letter {
        'v' => "volume",
        'e' => "env",
        'p' => "publish",
        'u' => "user",
        'w' => "workdir",
        'h' => "hostname",
        'l' => "label",
        'm' => "memory",
        'a' => "attach",
        _ => "cpu-shares",
    }
}

/// What a run line asks for that the decision reads. Pure.
fn read_line(argv: &[String]) -> Line {
    let mut line = Line::default();
    for (name, value) in options(argv) {
        let value = value.unwrap_or_default();
        match name.as_str() {
            "privileged" => line.privileged = value.is_empty() || value == "true",
            "network" | "net" | "pid" | "ipc" | "uts" => {
                if value == "host" || value.starts_with("container:") {
                    line.blockers.push(format!(
                        "it shares a namespace a microVM cannot (--{name} {value})"
                    ));
                }
            }
            "volume" if bind_source(&value).ends_with("docker.sock") => line.blockers.push(
                format!("it binds the Docker socket ({})", bind_source(&value)),
            ),
            "mount"
                if mount_source(&value).is_some_and(|source| source.ends_with("docker.sock")) =>
            {
                line.blockers.push(format!(
                    "it binds the Docker socket ({})",
                    mount_source(&value).unwrap_or_default()
                ))
            }
            "use-api-socket" => line
                .blockers
                .push("it is given the Docker API socket (--use-api-socket)".to_string()),
            "gpus" => line
                .blockers
                .push(format!("it passes a GPU through (--gpus={value})")),
            "runtime" => line
                .blockers
                .push(format!("its run line already names the {value} runtime")),
            _ => {}
        }
    }
    line
}

/// The host side of a `-v` spec.
fn bind_source(spec: &str) -> &str {
    spec.split(':').next().unwrap_or_default()
}

/// The source of a `--mount` spec (`type=bind,source=/x,target=/y`).
fn mount_source(spec: &str) -> Option<&str> {
    spec.split(',').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        matches!(key, "source" | "src").then_some(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn argv(words: &str) -> Vec<String> {
        words.split_whitespace().map(str::to_string).collect()
    }

    /// A run line in the shape the run contract prints (_shared/sandbox-run sandboxRunArgv), with `extra` among its
    /// runtime directives.
    fn contract_line(extra: &str) -> Vec<String> {
        argv(&format!(
            "run -d --init --restart unless-stopped --stop-timeout 30 --name intentic-sandbox-work \
             --label dev.intentic.sandbox=work --network intentic-net-work --network-alias origin.local \
             --add-host host.docker.internal:host-gateway --dns 1.1.1.1 --log-opt max-size=10m --log-opt max-file=3 \
             --memory 12g --memory-swap 14g --cap-add=SYS_ADMIN {extra} -p 127.0.0.1:41234:8787 \
             -v intentic-workspace-work:/work -v intentic-history-work:/history \
             -v intentic-docker-work:/var/lib/docker -e SANDBOX_NAME=intentic-sandbox-work \
             -e SANDBOX_OVERLAY_RUNTIME=--privileged ghcr.io/intentic/sandbox:stable"
        ))
    }

    fn policy(isolation: Isolation) -> Policy {
        Policy {
            isolation,
            ..Policy::default()
        }
    }

    #[test]
    fn auto_puts_a_privileged_sandbox_in_a_microvm_and_leaves_the_rest_on_runc() {
        let auto = policy(Isolation::Auto);
        assert_eq!(
            vm_runtime(&contract_line("--privileged"), &auto, true),
            Decision::Kata
        );
        assert_eq!(
            vm_runtime(&contract_line("--privileged=true"), &auto, true),
            Decision::Kata
        );
        // Unprivileged, the word inside an env value, and an explicit false are all runc.
        assert_eq!(vm_runtime(&contract_line(""), &auto, true), Decision::Runc);
        assert_eq!(
            vm_runtime(&contract_line("--privileged=false"), &auto, true),
            Decision::Runc
        );
        assert_eq!(
            vm_runtime(
                &contract_line("--device=/dev/net/tun --cap-add=NET_ADMIN"),
                &auto,
                true
            ),
            Decision::Runc
        );
    }

    #[test]
    fn vm_means_every_sandbox_and_container_means_none() {
        assert_eq!(
            vm_runtime(&contract_line(""), &policy(Isolation::Vm), true),
            Decision::Kata
        );
        assert_eq!(
            vm_runtime(
                &contract_line("--privileged"),
                &policy(Isolation::Container),
                true
            ),
            Decision::Runc
        );
        // container never asks dockerd anything it does not need: no runtime, no warning.
        assert_eq!(
            vm_runtime(
                &contract_line("--privileged"),
                &policy(Isolation::Container),
                false
            ),
            Decision::Runc
        );
    }

    #[test]
    fn a_microvm_wanted_without_the_runtime_is_runc_and_says_so() {
        assert_eq!(
            vm_runtime(
                &contract_line("--privileged"),
                &policy(Isolation::Auto),
                false
            ),
            Decision::RuncBecause("dockerd has no kata runtime".to_string())
        );
        assert_eq!(
            vm_runtime(&contract_line(""), &policy(Isolation::Vm), false),
            Decision::RuncBecause("dockerd has no kata runtime".to_string())
        );
        // Not wanted, nothing to say even without the runtime.
        assert_eq!(
            vm_runtime(&contract_line(""), &policy(Isolation::Auto), false),
            Decision::Runc
        );
    }

    #[test]
    fn what_a_microvm_cannot_honour_keeps_the_line_on_runc_and_names_the_flag() {
        let vm = policy(Isolation::Vm);
        let because = |extra: &str| match vm_runtime(&contract_line(extra), &vm, true) {
            Decision::RuncBecause(why) => why,
            other => panic!("{extra}: {other:?}"),
        };
        assert!(because("--network host").contains("--network host"));
        assert!(because("--network=host").contains("--network host"));
        assert!(because("--net=host").contains("--net host"));
        assert!(because("--pid host").contains("--pid host"));
        assert!(because("--pid=host").contains("--pid host"));
        assert!(because("--ipc host").contains("--ipc host"));
        assert!(because("--ipc=container:other").contains("--ipc container:other"));
        assert!(because("--uts=host").contains("--uts host"));
        assert!(because("-v /var/run/docker.sock:/var/run/docker.sock")
            .contains("/var/run/docker.sock"));
        assert!(
            because("--volume=/run/docker.sock:/run/docker.sock:ro").contains("/run/docker.sock")
        );
        assert!(because("-v/var/run/docker.sock:/sock").contains("/var/run/docker.sock"));
        assert!(because(
            "--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock"
        )
        .contains("/var/run/docker.sock"));
        assert!(
            because("--mount=type=bind,src=/run/docker.sock,dst=/x").contains("/run/docker.sock")
        );
        assert!(because("--use-api-socket").contains("--use-api-socket"));
        // The run contract's GPU directive is always the attached spelling.
        assert!(because("--gpus=all").contains("--gpus=all"));
        assert!(because("--runtime=nvidia").contains("nvidia runtime"));
        assert!(because("--runtime nvidia").contains("nvidia runtime"));
        // The first blocker is the one said.
        assert!(because("--pid host --network host").contains("--pid host"));
    }

    #[test]
    fn the_sandboxs_own_network_and_volumes_are_no_blocker() {
        // The contract's `--network intentic-net-<slug>`, its named volumes, and a socket that is only an env value.
        let line = contract_line("--privileged -e DOCKER_HOST=unix:///var/run/docker.sock");
        assert_eq!(
            vm_runtime(&line, &policy(Isolation::Auto), true),
            Decision::Kata
        );
    }

    #[test]
    fn options_end_at_the_image_and_values_are_never_read_as_flags() {
        // `--name --privileged` names a container; it does not ask for privilege. And anything after the image is the
        // container's own command line.
        let line = argv("run -d --name --privileged img --privileged --network host");
        assert_eq!(read_line(&line), Line::default());
        let line = argv("run -it -e --privileged=yes -w /x --label --pid=host img");
        assert_eq!(read_line(&line), Line::default());
        // A run line with no leading `run` is read from its first word.
        assert!(read_line(&argv("--privileged img")).privileged);
    }

    #[test]
    fn the_runtime_goes_right_after_run_and_nowhere_else() {
        let line = argv("run -d --privileged --name x img");
        assert_eq!(
            with_kata(&line),
            argv("run --runtime=kata -d --privileged --name x img")
        );
        // Not a run line: left exactly as it is.
        assert_eq!(with_kata(&argv("create -d img")), argv("create -d img"));
        assert_eq!(with_kata(&[]), Vec::<String>::new());
    }

    #[test]
    fn dockers_runtime_list_is_read_by_its_key() {
        assert!(has_kata(
            r#"{"io.containerd.runc.v2":{"path":"runc"},"kata":{"runtimeType":"io.containerd.kata.v2"},"runc":{"path":"runc"}}"#
        ));
        assert!(!has_kata(
            r#"{"io.containerd.runc.v2":{"path":"runc"},"runc":{"path":"runc"}}"#
        ));
        assert!(!has_kata(r#"{"kata-qemu":{"path":"x"}}"#));
        assert!(!has_kata(""));
        assert!(!has_kata("Cannot connect to the Docker daemon"));
    }

    fn layer(name: &str, value: Value) -> (String, Value) {
        (name.to_string(), value)
    }

    #[test]
    fn the_owner_wins_key_by_key_over_the_shipped_defaults() {
        assert_eq!(merged(&[]), (Policy::default(), Vec::new()));
        let (policy, said) = merged(&[
            layer(
                "/usr/lib/intentic-os/os.json",
                json!({"isolation": "vm", "pairOnLan": true, "updates": "stage"}),
            ),
            layer("/etc/intentic/os.json", json!({"pairOnLan": false})),
        ]);
        assert_eq!(
            policy,
            Policy {
                isolation: Isolation::Vm,
                pair_on_lan: false,
                updates: Updates::Stage
            }
        );
        assert!(said.is_empty());
        let (policy, _) = merged(&[
            layer("defaults", json!({"isolation": "vm"})),
            layer("owner", json!({"isolation": "container", "updates": "off"})),
        ]);
        assert_eq!(policy.isolation, Isolation::Container);
        assert_eq!(policy.updates, Updates::Off);
    }

    #[test]
    fn a_value_nobody_knows_is_said_and_an_unknown_isolation_is_auto() {
        let (policy, said) = merged(&[
            layer("defaults", json!({"isolation": "container"})),
            layer(
                "/etc/intentic/os.json",
                json!({"isolation": "microvm", "pairOnLan": "yes", "updates": "daily"}),
            ),
        ]);
        assert_eq!(policy, Policy::default());
        assert_eq!(said.len(), 3, "{said:?}");
        assert!(said[0].contains("/etc/intentic/os.json") && said[0].contains("auto"));
        let (policy, said) = merged(&[layer("owner", json!(["vm"]))]);
        assert_eq!(policy, Policy::default());
        assert_eq!(said.len(), 1);
    }

    #[test]
    fn the_files_on_disk_are_read_in_order_and_a_missing_one_says_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::under(dir.path());
        assert_eq!(read(&paths), (Policy::default(), Vec::new()));
        let write = |path: std::path::PathBuf, text: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            paths.policy_defaults(),
            r#"{"isolation":"vm","pairOnLan":true}"#,
        );
        write(paths.policy_owner(), r#"{"pairOnLan":false}"#);
        let (policy, said) = read(&paths);
        assert_eq!(
            (policy.isolation, policy.pair_on_lan),
            (Isolation::Vm, false)
        );
        assert!(said.is_empty());
        write(paths.policy_owner(), "{not json");
        let (policy, said) = read(&paths);
        assert_eq!(
            (policy.isolation, policy.pair_on_lan),
            (Isolation::Vm, true)
        );
        assert_eq!(said.len(), 1);
    }
}
