use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::clock;
use super::model::{Check, Fix, Repair, DISK, DOCKER, DOCKER_APP, NETWORK, PREREQUISITES, WSL};
use crate::docker::{self, Engine};
use crate::prepare::plan;

/* THE MACHINE'S LAYERS — prerequisites, Docker Desktop, the engine, WSL, the disk, the network, the agent. Gathered
once per pass, every probe bounded; read by pure functions below, so a finding's words and its category are tested
against fact literals rather than against whatever machine the tests happen to run on. */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Windows,
    Linux,
    Macos,
    /// ic runs inside a WSL distro, against Docker Desktop's integration on the Windows side.
    Wsl,
}

impl Os {
    pub fn detect() -> Os {
        if cfg!(windows) {
            return Os::Windows;
        }
        if cfg!(target_os = "macos") {
            return Os::Macos;
        }
        if inside_wsl(&std::fs::read_to_string("/proc/version").unwrap_or_default()) {
            Os::Wsl
        } else {
            Os::Linux
        }
    }

    pub fn wire(self) -> &'static str {
        match self {
            Os::Windows => "windows",
            Os::Linux => "linux",
            Os::Macos => "macos",
            Os::Wsl => "wsl",
        }
    }
}

/// WSL's kernel names its maker in `/proc/version` ("…-microsoft-standard-WSL2"). Pure.
pub fn inside_wsl(proc_version: &str) -> bool {
    proc_version.to_ascii_lowercase().contains("microsoft")
}

/// Docker Desktop on this machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desktop {
    /// Not what runs Docker here: Docker Engine on Linux, or another runtime on a Mac. Nothing of its to check.
    Absent,
    NotInstalled,
    Stopped,
    Running,
}

/// WSL, as far as it matters to Docker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Wsl {
    NotApplicable,
    /// Windows: `wsl --list --running` answered with these distros; None when it never answered.
    Windows {
        running: Option<Vec<String>>,
    },
    /// ic runs inside this distro.
    Inside {
        distro: String,
        /// A `docker` command exists here.
        cli: bool,
        /// …and it is Docker Desktop's (its integration puts it under /mnt/wsl/docker-desktop).
        integration: bool,
    },
}

/// The machine agent (`intentic-machine`), which runs this command by itself when a sandbox stops answering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    /// This run is the agent's own.
    Itself,
    NotInstalled,
    Stopped,
    Running,
}

pub struct DeviceFacts {
    pub os: Os,
    /// Windows: `ic docker prepare`'s reading of this PC; Err when it would not describe itself in time.
    pub windows: Option<std::result::Result<plan::Facts, String>>,
    pub desktop: Desktop,
    /// Docker Desktop starts at sign-in; None when that could not be read.
    pub autostart: Option<bool>,
    pub engine: Engine,
    /// Linux Docker Engine under systemd: whether its service is active. None without systemd.
    pub engine_service: Option<bool>,
    pub wsl: Wsl,
    /// Free space on the drive that holds Docker's data, in whole GiB, and what that drive is called.
    pub free_gib: Option<u64>,
    pub disk_place: String,
    pub agent: Agent,
}

/// How long the engine gets to answer one question in a diagnosis.
pub const ENGINE_ASK: Duration = Duration::from_secs(10);

/// How long an engine that Docker Desktop is running may go on not answering before it counts as wedged rather than
/// starting: the fleet's figure, which is what keeps a restart from fighting a Docker Desktop still booting.
pub const WEDGE_PATIENCE: Duration = Duration::from_secs(90);

/// Read the machine. `patience` is how long to watch an engine that Docker Desktop is running and that does not
/// answer before calling it wedged: zero for doctor, which reports what it sees now.
pub fn gather(os: Os, patience: Duration, agent_run: bool) -> DeviceFacts {
    let windows = (os == Os::Windows).then(windows_facts);
    let mut engine = docker::engine(ENGINE_ASK);
    let (mut desktop, autostart) = desktop(os, windows.as_ref().and_then(|f| f.as_ref().ok()));
    if engine.up() && desktop != Desktop::Absent {
        desktop = Desktop::Running;
    }
    if desktop == Desktop::Running && !patience.is_zero() && stuck(&engine) {
        engine = watch_engine(patience);
    }
    let engine_service = if os == Os::Linux && desktop == Desktop::Absent && !engine.up() {
        systemd_active("docker", false)
    } else {
        None
    };
    let (free_gib, disk_place) = free_space(os, engine.up());
    DeviceFacts {
        os,
        windows,
        desktop,
        autostart,
        wsl: wsl(os),
        engine,
        engine_service,
        free_gib,
        disk_place,
        agent: if agent_run { Agent::Itself } else { agent() },
    }
}

/// An engine that may yet come up by itself: not refused, and there to ask.
fn stuck(engine: &Engine) -> bool {
    matches!(
        engine,
        Engine::Down(_) | Engine::Erroring(_) | Engine::Silent
    )
}

/// Watch an engine Docker Desktop is running until it answers or `patience` runs out, saying so once.
fn watch_engine(patience: Duration) -> Engine {
    crate::ui::note(&format!(
        "Docker Desktop is running but its engine is not answering — giving it {} seconds before calling it stuck…",
        patience.as_secs()
    ));
    let deadline = Instant::now() + patience;
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let engine = docker::engine(ENGINE_ASK);
        if !stuck(&engine) || Instant::now() >= deadline {
            return engine;
        }
    }
}

#[cfg(windows)]
fn windows_facts() -> std::result::Result<plan::Facts, String> {
    crate::prepare::facts::probe_within(Duration::from_secs(90))
}

#[cfg(not(windows))]
fn windows_facts() -> std::result::Result<plan::Facts, String> {
    Err("not Windows".to_string())
}

/* DOCKER DESKTOP, per OS. */

/// Where Docker Desktop's executable lives on Windows, spelled for this side: C:\ on Windows, /mnt/c inside WSL.
pub fn windows_desktop_exe(os: Os) -> PathBuf {
    match os {
        Os::Wsl => PathBuf::from("/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe"),
        _ => {
            let root =
                std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".to_string());
            Path::new(&root)
                .join("Docker")
                .join("Docker")
                .join("Docker Desktop.exe")
        }
    }
}

fn desktop(os: Os, windows: Option<&plan::Facts>) -> (Desktop, Option<bool>) {
    match os {
        Os::Windows => {
            let installed = windows.is_some_and(|facts| !facts.docker_desktop_path.is_empty())
                || windows_desktop_exe(os).exists();
            if !installed {
                return (Desktop::NotInstalled, None);
            }
            let autostart = std::env::var("APPDATA")
                .ok()
                .and_then(|dir| autostart_in(&Path::new(&dir).join("Docker")));
            (running_on_windows("tasklist.exe"), autostart)
        }
        Os::Wsl => {
            if !windows_desktop_exe(os).exists() {
                return (Desktop::NotInstalled, None);
            }
            (running_on_windows("tasklist.exe"), None)
        }
        Os::Macos => {
            let home = std::env::var("HOME").unwrap_or_default();
            let installed = Path::new("/Applications/Docker.app").exists()
                || Path::new(&home).join("Applications/Docker.app").exists();
            if !installed {
                // Colima, OrbStack and friends answer as `docker` too; only no docker at all is "not installed".
                return if docker::cli_present() {
                    (Desktop::Absent, None)
                } else {
                    (Desktop::NotInstalled, None)
                };
            }
            let running = docker::run_bounded(
                "pgrep",
                &["-f", "com.docker.backend"],
                Duration::from_secs(5),
            )
            .is_ok_and(|ran| ran.code == Some(0));
            let settings = Path::new(&home).join("Library/Group Containers/group.com.docker");
            (
                if running {
                    Desktop::Running
                } else {
                    Desktop::Stopped
                },
                autostart_in(&settings),
            )
        }
        Os::Linux => {
            let context =
                docker::run_bounded("docker", &["context", "show"], Duration::from_secs(10))
                    .ok()
                    .filter(|ran| ran.code == Some(0))
                    .map(|ran| ran.stdout.trim().to_string())
                    .unwrap_or_default();
            if !Path::new("/opt/docker-desktop").exists() || context != "desktop-linux" {
                return (Desktop::Absent, None);
            }
            let running = systemd_active("docker-desktop", true) == Some(true);
            let enabled = docker::run_bounded(
                "systemctl",
                &["--user", "is-enabled", "docker-desktop"],
                Duration::from_secs(5),
            )
            .ok()
            .map(|ran| ran.stdout.trim() == "enabled");
            (
                if running {
                    Desktop::Running
                } else {
                    Desktop::Stopped
                },
                enabled,
            )
        }
    }
}

/// Docker Desktop's processes, off `tasklist` (inside WSL, the Windows one through interop). Its engine is asked
/// separately: the process list says yes long before the engine answers, and keeps saying it after it has died.
fn running_on_windows(tasklist: &str) -> Desktop {
    let ran = docker::run_bounded(
        tasklist,
        &["/FI", "IMAGENAME eq Docker Desktop.exe", "/NH"],
        Duration::from_secs(10),
    );
    match ran {
        Ok(ran) if ran.stdout.contains("Docker Desktop.exe") => Desktop::Running,
        _ => Desktop::Stopped,
    }
}

/// `systemctl [--user] is-active <unit>`: Some(true) active, Some(false) anything else, None without systemctl.
fn systemd_active(unit: &str, user: bool) -> Option<bool> {
    let mut args = Vec::new();
    if user {
        args.push("--user");
    }
    args.extend(["is-active", unit]);
    let ran = docker::run_bounded("systemctl", &args, Duration::from_secs(5)).ok()?;
    if ran.timed_out {
        return None;
    }
    Some(ran.stdout.trim() == "active")
}

/// Docker Desktop's start-at-sign-in switch, off its settings file in `dir` (`settings-store.json`, or the older
/// `settings.json`). None when neither says.
pub fn autostart_in(dir: &Path) -> Option<bool> {
    ["settings-store.json", "settings.json"]
        .iter()
        .find_map(|name| std::fs::read_to_string(dir.join(name)).ok())
        .and_then(|text| autostart_of(&text))
}

/// The switch out of the settings text: `AutoStart` in the current file, `autoStart` in the older one. Pure.
pub fn autostart_of(settings: &str) -> Option<bool> {
    let value: serde_json::Value = serde_json::from_str(settings).ok()?;
    value
        .get("AutoStart")
        .or_else(|| value.get("autoStart"))
        .and_then(serde_json::Value::as_bool)
}

/* WSL. */

fn wsl(os: Os) -> Wsl {
    match os {
        Os::Windows => {
            // `--running` is the one listing that does not boot a distro; WSL_UTF8 stops its UTF-16 output.
            let mut command = std::process::Command::new("wsl.exe");
            command
                .args(["--list", "--running", "--quiet"])
                .env("WSL_UTF8", "1");
            let running = match docker::bounded(command, Duration::from_secs(15)) {
                Ok(ran) if ran.timed_out => None,
                Ok(ran) => Some(distros_of(&ran.stdout)),
                Err(_) => Some(Vec::new()),
            };
            Wsl::Windows { running }
        }
        Os::Wsl => {
            let cli = docker::cli_present();
            let integration = Path::new("/mnt/wsl/docker-desktop").exists()
                || std::fs::read_link("/usr/bin/docker")
                    .is_ok_and(|target| target.to_string_lossy().contains("docker-desktop"));
            Wsl::Inside {
                distro: std::env::var("WSL_DISTRO_NAME")
                    .unwrap_or_else(|_| "this distro".to_string()),
                cli,
                integration,
            }
        }
        _ => Wsl::NotApplicable,
    }
}

/// `wsl --list --quiet` output as distro names: NULs from an older WSL's UTF-16 dropped, blanks skipped. Pure.
pub fn distros_of(listing: &str) -> Vec<String> {
    listing
        .replace('\0', "")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.contains(' '))
        .map(str::to_string)
        .collect()
}

/* DISK — the host's own free space, where Docker's data lives. Never `df` inside WSL: its virtual disk is sparse, and
it reported 680 GB free on a host with 2 (setup-wsl-fleet.ps1). */

fn free_space(os: Os, engine_up: bool) -> (Option<u64>, String) {
    const KIB_PER_GIB: u64 = 1024 * 1024;
    match os {
        Os::Windows => windows_free(),
        #[cfg(unix)]
        Os::Wsl => (
            crate::checks::free_kib("/mnt/c").map(|kib| kib / KIB_PER_GIB),
            "C: (the Windows drive Docker Desktop keeps its disk on)".to_string(),
        ),
        #[cfg(unix)]
        Os::Macos => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
            (
                crate::checks::free_kib(&home).map(|kib| kib / KIB_PER_GIB),
                home,
            )
        }
        #[cfg(unix)]
        Os::Linux => {
            let root = engine_up
                .then(|| {
                    docker::ask(&["info", "-f", "{{.DockerRootDir}}"], ENGINE_ASK)
                        .said()
                        .map(|dir| dir.trim().to_string())
                })
                .flatten()
                .filter(|dir| Path::new(dir).exists())
                .unwrap_or_else(|| "/".to_string());
            (
                crate::checks::free_kib(&root).map(|kib| kib / KIB_PER_GIB),
                root,
            )
        }
        #[cfg(not(unix))]
        _ => {
            let _ = (engine_up, KIB_PER_GIB);
            (None, String::new())
        }
    }
}

/// The drive %LOCALAPPDATA% is on (Docker Desktop's data lives under it), asked of Windows directly.
#[cfg(windows)]
fn windows_free() -> (Option<u64>, String) {
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let root = std::env::var("LOCALAPPDATA")
        .ok()
        .and_then(|dir| {
            Path::new(&dir)
                .components()
                .next()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
        })
        .map(|drive| format!("{drive}\\"))
        .unwrap_or_else(|| "C:\\".to_string());
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let mut available: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    // SAFETY: a NUL-terminated wide string and three out-pointers to locals, which is the whole contract.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    let gib = (ok != 0).then_some(available / (1024 * 1024 * 1024));
    (gib, root)
}

#[cfg(not(windows))]
fn windows_free() -> (Option<u64>, String) {
    (None, String::new())
}

/* THE MACHINE AGENT: its pidfile (`~/.intentic/machine/machine.pid`, local-agent's detached.ts) names the process. */

fn agent() -> Agent {
    let dir = crate::logfile::intentic_home().join("machine");
    if !dir.join("bin").exists() && !dir.join("machine.pid").exists() {
        return Agent::NotInstalled;
    }
    let pid = std::fs::read_to_string(dir.join("machine.pid"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|record| record["pid"].as_u64());
    match pid {
        Some(pid) if alive(pid) => Agent::Running,
        _ => Agent::Stopped,
    }
}

#[cfg(target_os = "linux")]
fn alive(pid: u64) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn alive(pid: u64) -> bool {
    docker::run_bounded("kill", &["-0", &pid.to_string()], Duration::from_secs(5))
        .is_ok_and(|ran| ran.code == Some(0))
}

#[cfg(windows)]
fn alive(pid: u64) -> bool {
    let filter = format!("PID eq {pid}");
    docker::run_bounded(
        "tasklist.exe",
        &["/FI", &filter, "/NH"],
        Duration::from_secs(10),
    )
    .is_ok_and(|ran| {
        ran.stdout
            .split_whitespace()
            .any(|word| word == pid.to_string())
    })
}

/* THE READINGS — pure over the facts above. `tried` answers whether a repair already ran this pass, which is how a
finding escalates: a start that did not take becomes a restart to ask for, and a restart that did not take becomes a
person's to finish. None means the check does not apply to this machine and is left out of the report. */

/// The `ic docker prepare` requirements that are this check's: what stands between Windows and Docker at all.
/// Docker Desktop's install and engine, the account's permission and the disk have checks of their own.
const PREREQUISITE_IDS: [&str; 8] = [
    "arch",
    "windows-version",
    "slat",
    "virtualization",
    "nested-virtualization",
    "pending-restart",
    "wsl-features",
    "wsl-kernel",
];

pub fn prerequisites(facts: &DeviceFacts, tried: &dyn Fn(&Repair) -> bool) -> Option<Check> {
    let windows = facts.windows.as_ref()?;
    let facts = match windows {
        Ok(facts) => facts,
        Err(why) => {
            return Some(Check::skip(
                PREREQUISITES,
                format!("this PC did not describe itself ({why})"),
            ))
        }
    };
    let unmet: Vec<plan::Requirement> = plan::requirements(facts)
        .into_iter()
        .filter(|requirement| PREREQUISITE_IDS.contains(&requirement.id))
        .collect();
    let Some(first) = unmet.first() else {
        return Some(Check::ok(PREREQUISITES));
    };
    let problem = unmet
        .iter()
        .map(|requirement| requirement.problem.clone())
        .collect::<Vec<String>>()
        .join(" ");
    let mut remedy = first.remedy.clone();
    if let Some(detail) = &first.detail {
        remedy.push_str("\n\n");
        remedy.push_str(detail);
    }
    let repair = Repair::Prerequisite(first.id);
    let check = match first.action {
        plan::Action::FixElevated if !tried(&repair) => {
            Check::fail(PREREQUISITES, problem, remedy, Fix::Do(repair))
        }
        plan::Action::Restart => {
            Check::fail(PREREQUISITES, problem, remedy, Fix::You).needs_session()
        }
        _ => Check::fail(PREREQUISITES, problem, remedy, Fix::You),
    };
    Some(check)
}

pub fn docker_app(facts: &DeviceFacts, tried: &dyn Fn(&Repair) -> bool) -> Option<Check> {
    let check = match facts.desktop {
        Desktop::Absent => return None,
        Desktop::NotInstalled => Check::fail(
            DOCKER_APP,
            "Docker Desktop is not installed on this machine.",
            match facts.os {
                Os::Wsl => "install Docker Desktop on Windows and switch on its WSL integration for this distro — never Docker Engine inside the distro — then run `ic sandbox fix` again.",
                Os::Macos => "install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/), then run `ic sandbox fix` again.",
                _ => "run the setup command from your browser again: it installs Docker Desktop, then your sandbox.",
            },
            Fix::You,
        ),
        Desktop::Stopped if !tried(&Repair::StartDesktop) => Check::fail(
            DOCKER_APP,
            "Docker Desktop is not running, so neither is your sandbox.",
            "start Docker Desktop and wait for its engine: `ic sandbox fix` does this by itself.",
            Fix::Do(Repair::StartDesktop),
        ),
        Desktop::Stopped => Check::fail(
            DOCKER_APP,
            "Docker Desktop was started and has not come up.",
            "open Docker Desktop and finish what it shows (its terms, a sign-in, an update); once it says the engine is running, run `ic sandbox fix` again.",
            Fix::You,
        ),
        Desktop::Running => match facts.autostart {
            Some(false) => Check::warn_fix(
                DOCKER_APP,
                "Docker Desktop does not start when you sign in, so a restart of this machine stops your sandbox until someone opens it.",
                "turn on \"Start Docker Desktop when you sign in\" in Docker Desktop's settings (General).",
                if tried(&Repair::AutoStart) {
                    Fix::You
                } else {
                    Fix::Do(Repair::AutoStart)
                },
            ),
            _ => Check::ok(DOCKER_APP),
        },
    };
    Some(check)
}

pub fn docker(facts: &DeviceFacts, tried: &dyn Fn(&Repair) -> bool) -> Check {
    let windowsish = matches!(facts.os, Os::Windows | Os::Wsl);
    match &facts.engine {
        Engine::Up(os) if os != "linux" => {
            let problem = format!(
                "Docker is running, but in {os}-container mode, and a sandbox is a Linux container."
            );
            if facts.os == Os::Windows && !tried(&Repair::LinuxContainers) {
                Check::fail(
                    DOCKER,
                    problem,
                    "switch Docker Desktop to Linux containers: `ic sandbox fix` does it once you say yes.",
                    Fix::Do(Repair::LinuxContainers),
                )
            } else {
                Check::fail(
                    DOCKER,
                    problem,
                    "right-click Docker's icon in the system tray and choose \"Switch to Linux containers\".",
                    Fix::You,
                )
            }
        }
        Engine::Up(_) => Check::ok(DOCKER),
        Engine::NoCli => match facts.desktop {
            Desktop::NotInstalled | Desktop::Stopped => {
                Check::skip(DOCKER, "unknowable until Docker Desktop runs")
            }
            _ if facts.os == Os::Wsl => Check::skip(DOCKER, "the WSL check names what is missing"),
            _ => Check::fail(
                DOCKER,
                "docker is not installed on this machine.",
                if facts.os == Os::Linux {
                    "install Docker Engine (https://docs.docker.com/engine/install/), then run `ic sandbox fix` again."
                } else {
                    "run the setup command from your browser again: it installs Docker, then your sandbox."
                },
                Fix::You,
            ),
        },
        Engine::Denied(_) => denied(facts, tried),
        stuck => match facts.desktop {
            Desktop::NotInstalled | Desktop::Stopped => {
                Check::skip(DOCKER, "unknowable while Docker Desktop is not running")
            }
            Desktop::Running if facts.os == Os::Wsl && !wsl_integrated(facts) => {
                Check::skip(DOCKER, "the WSL check names what is missing")
            }
            Desktop::Running => wedged(facts, stuck, tried),
            Desktop::Absent => engine_down(facts, stuck, windowsish, tried),
        },
    }
}

fn wsl_integrated(facts: &DeviceFacts) -> bool {
    matches!(
        facts.wsl,
        Wsl::Inside {
            cli: true,
            integration: true,
            ..
        }
    )
}

/// Docker Desktop is up and its engine is not: the state `wsl --shutdown` leaves it in, answering 500 for ever.
fn wedged(facts: &DeviceFacts, engine: &Engine, tried: &dyn Fn(&Repair) -> bool) -> Check {
    let how = match engine {
        Engine::Erroring(_) => "answers every request with an error",
        Engine::Silent => "does not answer at all",
        _ => "is not answering",
    };
    let vm_gone = matches!(&facts.wsl, Wsl::Windows { running: Some(distros) } if !distros.iter().any(|d| d == "docker-desktop"));
    let problem = format!(
        "Docker Desktop is running, but its engine {how}{}.",
        if vm_gone {
            " — its WSL distro (docker-desktop) is not running, which Docker Desktop does not notice by itself"
        } else {
            ""
        }
    );
    if !tried(&Repair::RestartDesktop) {
        return Check::fail(
            DOCKER,
            problem,
            "restart Docker Desktop: quit it from its icon and open it again, or say yes when `ic sandbox fix` asks.",
            Fix::Do(Repair::RestartDesktop),
        );
    }
    if facts.os == Os::Windows && !tried(&Repair::ShutdownWsl) {
        return Check::fail(
            DOCKER,
            format!("{problem} Restarting Docker Desktop did not help."),
            "restart WSL under it: quit Docker Desktop, run `wsl --shutdown`, then open Docker Desktop (`ic sandbox fix` does this once you say yes).",
            Fix::Do(Repair::ShutdownWsl),
        );
    }
    Check::fail(
        DOCKER,
        format!("{problem} Restarting it did not help."),
        "open Docker Desktop and finish what it shows (its terms, a sign-in, an update); once it says the engine is running, run `ic sandbox fix` again.",
        Fix::You,
    )
}

/// An engine that is not Docker Desktop's and does not answer.
fn engine_down(
    facts: &DeviceFacts,
    engine: &Engine,
    windowsish: bool,
    tried: &dyn Fn(&Repair) -> bool,
) -> Check {
    if matches!(engine, Engine::Silent) {
        return Check::fail(
            DOCKER,
            format!(
                "Docker's engine did not answer within {} seconds — it is running but stuck.",
                ENGINE_ASK.as_secs()
            ),
            "restart it (sudo systemctl restart docker), then run `ic sandbox fix` again.",
            Fix::You,
        );
    }
    let problem = "Docker's engine is not running.";
    if facts.os == Os::Linux && facts.engine_service == Some(false) && !tried(&Repair::StartEngine)
    {
        return Check::fail(
            DOCKER,
            problem,
            "start it: sudo systemctl start docker",
            Fix::Do(Repair::StartEngine),
        );
    }
    Check::fail(
        DOCKER,
        problem,
        if windowsish {
            "start Docker Desktop, then run `ic sandbox fix` again."
        } else if facts.os == Os::Macos {
            "start your Docker runtime, then run `ic sandbox fix` again."
        } else {
            "start it (sudo systemctl start docker, or sudo service docker start), then run `ic sandbox fix` again."
        },
        Fix::You,
    )
}

/// The engine is up and refuses this account.
fn denied(facts: &DeviceFacts, tried: &dyn Fn(&Repair) -> bool) -> Check {
    match facts.windows.as_ref().and_then(|facts| facts.as_ref().ok()) {
        Some(windows) => {
            if windows.in_docker_users_group {
                let parked = plan::sign_out_requirement(windows);
                return Check::fail(DOCKER, parked.problem, parked.remedy, Fix::You).needs_session();
            }
            let repair = Repair::Prerequisite("docker-users");
            Check::fail(
                DOCKER,
                "Docker's engine is running and refuses this account: it is not in the docker-users group.",
                "add it (Windows asks for permission), then sign out and back in.",
                if tried(&repair) { Fix::You } else { Fix::Do(repair) },
            )
        }
        None => Check::fail(
            DOCKER,
            "Docker's engine is running, but this user may not talk to it.",
            format!(
                "add yourself to the docker group, then log out and back in: sudo usermod -aG docker {}",
                std::env::var("USER").unwrap_or_else(|_| "$USER".to_string())
            ),
            Fix::You,
        ),
    }
}

pub fn wsl_check(facts: &DeviceFacts, tried: &dyn Fn(&Repair) -> bool) -> Option<Check> {
    let check = match &facts.wsl {
        Wsl::NotApplicable => return None,
        Wsl::Windows { running: None } => {
            let problem = "WSL does not answer (`wsl --list --running` did not finish in 15 seconds), and Docker Desktop runs inside it.";
            if tried(&Repair::ShutdownWsl) {
                Check::fail(WSL, problem, "restart this PC.", Fix::You)
            } else {
                Check::fail(
                    WSL,
                    problem,
                    "restart WSL: quit Docker Desktop, run `wsl --shutdown`, then open Docker Desktop (`ic sandbox fix` does this once you say yes).",
                    Fix::Do(Repair::ShutdownWsl),
                )
            }
        }
        Wsl::Windows { .. } => Check::ok(WSL),
        Wsl::Inside {
            distro,
            cli,
            integration,
        } => {
            let switch_on = format!(
                "in Docker Desktop on Windows, open Settings → Resources → WSL integration, switch on {distro}, then Apply & restart. Do not install Docker Engine inside the distro: it would be a second engine beside Docker Desktop's."
            );
            if facts.desktop == Desktop::NotInstalled {
                Check::skip(
                    WSL,
                    "unknowable until Docker Desktop is installed on Windows",
                )
            } else if !cli {
                Check::fail(
                    WSL,
                    format!("there is no docker command in {distro}: Docker Desktop's WSL integration is off for it."),
                    switch_on,
                    Fix::You,
                )
            } else if *integration && facts.desktop == Desktop::Running && !facts.engine.up() {
                let problem = format!(
                    "Docker Desktop is running on Windows, but its engine does not answer in {distro}: its WSL integration is not applied here."
                );
                if tried(&Repair::ReapplyIntegration) {
                    Check::fail(
                        WSL,
                        problem,
                        format!("{switch_on} If it is on already, Docker Desktop's error dialog offers \"Restart the WSL integration\"."),
                        Fix::You,
                    )
                } else {
                    Check::fail(
                        WSL,
                        problem,
                        "re-apply it: `docker desktop restart` on Windows (`ic sandbox fix` does this once you say yes).",
                        Fix::Do(Repair::ReapplyIntegration),
                    )
                }
            } else {
                Check::ok(WSL)
            }
        }
    };
    Some(check)
}

/// Below this, Docker's engine stops taking writes and a pull dies partway; the Unix and Windows setup checks
/// refuse at the same line (checks::disk_outcome, plan::MIN_FREE_GIB).
pub const DISK_FLOOR_GIB: u64 = plan::MIN_FREE_GIB;

pub fn disk(facts: &DeviceFacts, tried: &dyn Fn(&Repair) -> bool) -> Check {
    let Some(free) = facts.free_gib else {
        return Check::skip(
            DISK,
            if facts.disk_place.is_empty() {
                "could not read this machine's free space".to_string()
            } else {
                format!("could not read free space on {}", facts.disk_place)
            },
        );
    };
    let place = &facts.disk_place;
    if free < DISK_FLOOR_GIB {
        let problem = format!(
            "only {free} GiB free on {place} — a full disk stops Docker's engine answering and the sandbox writing."
        );
        let yours = "free at least 5 GiB (on Windows: Settings → System → Storage), then run `ic sandbox fix` again.";
        if !facts.engine.up() {
            return Check::fail(DISK, problem, yours, Fix::You);
        }
        if !tried(&Repair::Tidy) {
            return Check::fail(
                DISK,
                problem,
                "remove what updates left behind: ic sandbox tidy (never a volume)",
                Fix::Do(Repair::Tidy),
            );
        }
        if !tried(&Repair::PruneBuilder) {
            return Check::fail(
                DISK,
                problem,
                "clear Docker's build cache (docker builder prune): it is rebuilt when a build needs it.",
                Fix::Do(Repair::PruneBuilder),
            );
        }
        return Check::fail(DISK, problem, yours, Fix::You);
    }
    if free < plan::TIGHT_FREE_GIB {
        return Check::warn(
            DISK,
            format!("{free} GiB free on {place} — enough to run, tight for a workspace."),
        );
    }
    Check::ok(DISK)
}

pub fn agent_check(facts: &DeviceFacts) -> Check {
    use super::model::AGENT;
    match facts.agent {
        Agent::Itself | Agent::Running => Check::ok(AGENT),
        Agent::NotInstalled => Check::warn_fix(
            AGENT,
            "this machine's agent is not installed, so nothing here notices when your sandbox stops answering.",
            "run the setup command from your browser again: it connects this device, which installs the agent.",
            Fix::You,
        ),
        Agent::Stopped => Check::warn_fix(
            AGENT,
            "this machine's agent is installed but not running, so nothing here notices when your sandbox stops answering.",
            "start it: intentic-machine run",
            Fix::You,
        ),
    }
}

/* THE NETWORK — whether this machine reaches the platform and the edge, and whether its clock agrees with them. */

pub struct NetFacts {
    pub platform: String,
    /// The platform's host resolved.
    pub dns: std::result::Result<(), String>,
    /// `GET {platform}/health`: its status and how far this machine's clock is from the platform's `Date`, in
    /// seconds (positive: this machine is ahead).
    pub https: std::result::Result<(u16, Option<i64>), String>,
    /// The edge the daemon dials (INGRESS_URL), and whether it answered at all.
    pub ingress: Option<(String, std::result::Result<u16, String>)>,
    /// HTTPS_PROXY, when this machine sends HTTPS through one.
    pub proxy: Option<String>,
}

/// How far this machine's clock may be from the platform's before signed requests start failing.
pub const CLOCK_SKEW_MAX_SECS: i64 = 300;
/// How long one network probe may take.
pub const NET_LIMIT: Duration = Duration::from_secs(10);

pub fn gather_network(platform: &str, ingress: Option<&str>) -> NetFacts {
    let host = super::chain::host_of(platform).unwrap_or_default();
    let dns = resolve(&host, NET_LIMIT);
    let https = if dns.is_ok() {
        let agent = crate::platform::agent_within(platform, NET_LIMIT);
        match agent.get(format!("{platform}/health")).call() {
            Ok(response) => {
                let skew = response
                    .headers()
                    .get("date")
                    .and_then(|value| value.to_str().ok())
                    .and_then(clock::http_date_secs)
                    .map(|theirs| clock::now_secs() - theirs);
                Ok((response.status().as_u16(), skew))
            }
            Err(ureq::Error::StatusCode(status)) => Ok((status, None)),
            Err(err) => Err(err.to_string()),
        }
    } else {
        Err("its name did not resolve".to_string())
    };
    let ingress = ingress.filter(|url| !url.is_empty()).map(|url| {
        let url = url.trim_end_matches('/').to_string();
        let answered = match crate::platform::agent_within(&url, NET_LIMIT)
            .get(&url)
            .call()
        {
            Ok(response) => Ok(response.status().as_u16()),
            Err(ureq::Error::StatusCode(status)) => Ok(status),
            Err(err) => Err(err.to_string()),
        };
        (url, answered)
    });
    let proxy = ["HTTPS_PROXY", "https_proxy"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()));
    NetFacts {
        platform: platform.to_string(),
        dns,
        https,
        ingress,
        proxy,
    }
}

/// A name lookup with a deadline: the resolver's own timeouts are the system's, and can be minutes.
pub fn resolve(host: &str, limit: Duration) -> std::result::Result<(), String> {
    use std::net::ToSocketAddrs;
    if host.is_empty() {
        return Err("no host to resolve".to_string());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let name = host.to_string();
    std::thread::spawn(move || {
        let found = (name.as_str(), 443u16)
            .to_socket_addrs()
            .map(|mut addrs| addrs.next().is_some())
            .map_err(|err| err.to_string());
        let _ = tx.send(found);
    });
    match rx.recv_timeout(limit) {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err("it resolved to nothing".to_string()),
        Ok(Err(why)) => Err(why),
        Err(_) => Err(format!("no answer within {} seconds", limit.as_secs())),
    }
}

/// The network check, pure over what the probes found.
pub fn network(facts: &NetFacts) -> Check {
    let proxied = facts
        .proxy
        .as_ref()
        .map(|proxy| format!(" This machine sends HTTPS through the proxy in HTTPS_PROXY ({proxy}): check it too."))
        .unwrap_or_default();
    let host = super::chain::host_of(&facts.platform).unwrap_or_else(|| facts.platform.clone());
    if let Err(why) = &facts.dns {
        return Check::fail(
            NETWORK,
            format!("this machine cannot resolve {host}: {why}."),
            format!("check this machine's DNS (a VPN or a captive portal is the usual cause), then run `ic sandbox fix` again.{proxied}"),
            Fix::You,
        );
    }
    match &facts.https {
        Err(why) => {
            return Check::fail(
                NETWORK,
                format!("this machine could not reach {} over HTTPS within {} seconds: {why}", facts.platform, NET_LIMIT.as_secs()),
                format!("check this machine's internet connection and firewall, then run `ic sandbox fix` again.{proxied}"),
                Fix::You,
            )
        }
        Ok((status, _)) if *status != 200 => {
            return Check::fail(
                NETWORK,
                format!("{}/health answered HTTP {status} — that origin is not the platform API.", facts.platform),
                "PLATFORM_URL must be the platform's API origin (e.g. https://api.intentic.dev), not the web app.",
                Fix::You,
            )
        }
        Ok((_, Some(skew))) if skew.abs() > CLOCK_SKEW_MAX_SECS => {
            let minutes = skew.abs() / 60;
            return Check::fail(
                NETWORK,
                format!(
                    "this machine's clock is {minutes} minutes {} the platform's, and signed requests from it are refused.",
                    if *skew > 0 { "ahead of" } else { "behind" }
                ),
                "set the clock automatically: Windows, Settings → Time & language → Date & time → Sync now; Linux, sudo timedatectl set-ntp true; macOS, System Settings → General → Date & Time.",
                Fix::You,
            );
        }
        Ok(_) => {}
    }
    if let Some((url, Err(why))) = &facts.ingress {
        return Check::fail(
            NETWORK,
            format!("this machine reaches the platform but not the edge your sandbox dials ({url}): {why}"),
            format!("check this machine's firewall for outbound HTTPS to {url}, then run `ic sandbox fix` again.{proxied}"),
            Fix::You,
        );
    }
    Check::ok(NETWORK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::fix::model::{State, Who};

    fn base(os: Os) -> DeviceFacts {
        DeviceFacts {
            os,
            windows: None,
            desktop: Desktop::Running,
            autostart: Some(true),
            engine: Engine::Up("linux".to_string()),
            engine_service: None,
            wsl: Wsl::NotApplicable,
            free_gib: Some(100),
            disk_place: "C:\\".to_string(),
            agent: Agent::Running,
        }
    }

    fn never(_: &Repair) -> bool {
        false
    }

    fn always(_: &Repair) -> bool {
        true
    }

    fn repair_of(check: &Check) -> Option<Repair> {
        check.repair().cloned()
    }

    #[test]
    fn wsl_is_recognised_by_its_kernel() {
        assert!(inside_wsl(
            "Linux version 6.18.33.2-microsoft-standard-WSL2 (root@1d2f) (gcc)"
        ));
        assert!(!inside_wsl("Linux version 6.8.0-45-generic (buildd@lcy02)"));
    }

    #[test]
    fn a_stopped_docker_desktop_is_started_unasked_and_then_handed_to_a_person() {
        let facts = DeviceFacts {
            desktop: Desktop::Stopped,
            engine: Engine::Down("cannot connect".to_string()),
            ..base(Os::Windows)
        };
        let first = docker_app(&facts, &never).expect("applies on Windows");
        assert_eq!(first.state, State::Fail);
        assert_eq!(repair_of(&first), Some(Repair::StartDesktop));
        assert_eq!(first.who(), Some(Who::Auto));
        // The engine is not judged while the app that runs it is down: one cause, one row.
        assert_eq!(docker(&facts, &never).state, State::Skip);
        let after = docker_app(&facts, &always).expect("applies");
        assert_eq!(after.who(), Some(Who::You));
        assert!(after
            .remedy
            .as_deref()
            .is_some_and(|r| r.contains("finish what it shows")));
    }

    #[test]
    fn a_wedged_engine_escalates_from_a_restart_to_wsl_to_a_person() {
        let facts = DeviceFacts {
            engine: Engine::Erroring("request returned 500 Internal Server Error".to_string()),
            wsl: Wsl::Windows {
                running: Some(vec!["Ubuntu".to_string()]),
            },
            ..base(Os::Windows)
        };
        let first = docker(&facts, &never);
        assert_eq!(repair_of(&first), Some(Repair::RestartDesktop));
        assert_eq!(first.who(), Some(Who::Consent));
        assert!(first
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("docker-desktop") && p.contains("error")));
        let restarted = |r: &Repair| *r == Repair::RestartDesktop;
        assert_eq!(
            repair_of(&docker(&facts, &restarted)),
            Some(Repair::ShutdownWsl)
        );
        let last = docker(&facts, &always);
        assert_eq!(last.who(), Some(Who::You));
        assert!(last
            .remedy
            .as_deref()
            .is_some_and(|r| r.contains("open Docker Desktop and finish what it shows")));
        // On a Mac there is no WSL to restart: a person is next.
        let mac = DeviceFacts {
            engine: Engine::Silent,
            ..base(Os::Macos)
        };
        assert_eq!(docker(&mac, &restarted).who(), Some(Who::You));
    }

    #[test]
    fn windows_containers_are_switched_with_consent() {
        let facts = DeviceFacts {
            engine: Engine::Up("windows".to_string()),
            ..base(Os::Windows)
        };
        assert_eq!(
            repair_of(&docker(&facts, &never)),
            Some(Repair::LinuxContainers)
        );
    }

    #[test]
    fn a_stopped_linux_engine_under_systemd_is_started_with_consent() {
        let facts = DeviceFacts {
            desktop: Desktop::Absent,
            engine: Engine::Down("Cannot connect to the Docker daemon".to_string()),
            engine_service: Some(false),
            ..base(Os::Linux)
        };
        let check = docker(&facts, &never);
        assert_eq!(repair_of(&check), Some(Repair::StartEngine));
        assert_eq!(
            check.remedy.as_deref(),
            Some("start it: sudo systemctl start docker")
        );
        assert!(
            docker_app(&facts, &never).is_none(),
            "Docker Engine has no app to check"
        );
    }

    #[test]
    fn a_unix_permission_refusal_names_the_docker_group() {
        let facts = DeviceFacts {
            desktop: Desktop::Absent,
            engine: Engine::Denied("permission denied while trying to connect".to_string()),
            ..base(Os::Linux)
        };
        let check = docker(&facts, &never);
        assert_eq!(check.who(), Some(Who::You));
        assert!(check
            .remedy
            .as_deref()
            .is_some_and(|r| r.contains("usermod -aG docker")));
    }

    #[test]
    fn autostart_off_is_a_warning_with_consent_never_a_failure() {
        let facts = DeviceFacts {
            autostart: Some(false),
            ..base(Os::Windows)
        };
        let check = docker_app(&facts, &never).expect("applies");
        assert_eq!(check.state, State::Warn);
        assert_eq!(repair_of(&check), Some(Repair::AutoStart));
        assert_eq!(
            autostart_of(r#"{"AutoStart": false, "Other": 1}"#),
            Some(false)
        );
        assert_eq!(autostart_of(r#"{"autoStart": true}"#), Some(true));
        assert_eq!(autostart_of("not json"), None);
    }

    #[test]
    fn a_low_disk_is_tidied_then_pruned_with_consent_then_handed_to_a_person() {
        let facts = DeviceFacts {
            free_gib: Some(3),
            ..base(Os::Linux)
        };
        let first = disk(&facts, &never);
        assert_eq!(repair_of(&first), Some(Repair::Tidy));
        assert_eq!(first.who(), Some(Who::Auto));
        let tidied = |r: &Repair| *r == Repair::Tidy;
        let second = disk(&facts, &tidied);
        assert_eq!(repair_of(&second), Some(Repair::PruneBuilder));
        assert_eq!(second.who(), Some(Who::Consent));
        assert_eq!(disk(&facts, &always).who(), Some(Who::You));
        // A full disk with no engine to tidy through is a person's straight away.
        let blocked = DeviceFacts {
            free_gib: Some(1),
            engine: Engine::Silent,
            ..base(Os::Windows)
        };
        assert_eq!(disk(&blocked, &never).who(), Some(Who::You));
        // The boundary, by value: 5 GiB is enough, 4 is not; under 15 warns.
        let at = |gib| {
            disk(
                &DeviceFacts {
                    free_gib: Some(gib),
                    ..base(Os::Linux)
                },
                &never,
            )
            .state
        };
        assert_eq!(at(4), State::Fail);
        assert_eq!(at(5), State::Warn);
        assert_eq!(at(14), State::Warn);
        assert_eq!(at(15), State::Ok);
    }

    #[test]
    fn inside_wsl_a_missing_integration_is_a_person_s_and_never_docker_engine_in_the_distro() {
        let facts = DeviceFacts {
            engine: Engine::NoCli,
            wsl: Wsl::Inside {
                distro: "Ubuntu".to_string(),
                cli: false,
                integration: false,
            },
            ..base(Os::Wsl)
        };
        let check = wsl_check(&facts, &never).expect("applies in WSL");
        assert_eq!(check.who(), Some(Who::You));
        let remedy = check.remedy.expect("a remedy");
        assert!(remedy.contains("WSL integration") && remedy.contains("Ubuntu"));
        assert!(remedy.contains("Do not install Docker Engine"));
        assert_eq!(docker(&facts, &never).state, State::Skip);
        // Switched on and merely absent: re-applied with consent.
        let absent = DeviceFacts {
            engine: Engine::Down("Cannot connect".to_string()),
            wsl: Wsl::Inside {
                distro: "Ubuntu".to_string(),
                cli: true,
                integration: true,
            },
            ..base(Os::Wsl)
        };
        assert_eq!(
            repair_of(&wsl_check(&absent, &never).expect("applies")),
            Some(Repair::ReapplyIntegration)
        );
    }

    #[test]
    fn a_wsl_that_never_answers_is_restarted_with_consent() {
        let facts = DeviceFacts {
            wsl: Wsl::Windows { running: None },
            ..base(Os::Windows)
        };
        assert_eq!(
            repair_of(&wsl_check(&facts, &never).expect("applies")),
            Some(Repair::ShutdownWsl)
        );
        assert!(wsl_check(&base(Os::Linux), &never).is_none());
        assert_eq!(
            distros_of("docker-desktop\r\nUbuntu\r\n\r\n"),
            vec!["docker-desktop".to_string(), "Ubuntu".to_string()]
        );
    }

    fn net() -> NetFacts {
        NetFacts {
            platform: "https://api.intentic.dev".to_string(),
            dns: Ok(()),
            https: Ok((200, Some(3))),
            ingress: Some(("https://edge.intentic.dev".to_string(), Ok(404))),
            proxy: None,
        }
    }

    #[test]
    fn the_network_names_dns_https_clock_and_edge_apart() {
        assert_eq!(network(&net()).state, State::Ok);
        let dns = network(&NetFacts {
            dns: Err("no such host".to_string()),
            ..net()
        });
        assert!(dns
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("cannot resolve api.intentic.dev")));
        let proxied = network(&NetFacts {
            https: Err("connection timed out".to_string()),
            proxy: Some("http://proxy:3128".to_string()),
            ..net()
        });
        assert!(proxied
            .remedy
            .as_deref()
            .is_some_and(|r| r.contains("HTTPS_PROXY (http://proxy:3128)")));
        // The clock boundary, by value: five minutes is tolerated, a second past it is not.
        let skewed = |secs| {
            network(&NetFacts {
                https: Ok((200, Some(secs))),
                ..net()
            })
            .state
        };
        assert_eq!(skewed(300), State::Ok);
        assert_eq!(skewed(-301), State::Fail);
        let behind = network(&NetFacts {
            https: Ok((200, Some(-900))),
            ..net()
        });
        assert!(behind
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("15 minutes behind")));
        let edge = network(&NetFacts {
            ingress: Some((
                "https://edge.intentic.dev".to_string(),
                Err("refused".to_string()),
            )),
            ..net()
        });
        assert!(edge
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("edge.intentic.dev")));
        for check in [dns, proxied, edge] {
            assert_eq!(check.who(), Some(Who::You));
        }
    }

    #[test]
    fn the_agent_is_a_warning_only() {
        for (agent, state) in [
            (Agent::Itself, State::Ok),
            (Agent::Running, State::Ok),
            (Agent::NotInstalled, State::Warn),
            (Agent::Stopped, State::Warn),
        ] {
            assert_eq!(
                agent_check(&DeviceFacts {
                    agent,
                    ..base(Os::Linux)
                })
                .state,
                state
            );
        }
    }

    #[test]
    fn a_windows_prerequisite_is_offered_with_consent_and_a_pending_restart_parks_the_session() {
        let features_off = plan::Facts {
            build: 22631,
            arch: Some(plan::ARCH_X64),
            hypervisor_present: Some(true),
            service_vmcompute: false,
            service_wsl: false,
            docker_cli: true,
            docker_daemon: true,
            docker_server_os: Some("linux".to_string()),
            ..plan::Facts::default()
        };
        let facts = DeviceFacts {
            windows: Some(Ok(features_off.clone())),
            ..base(Os::Windows)
        };
        let check = prerequisites(&facts, &never).expect("applies on Windows");
        assert_eq!(
            repair_of(&check),
            Some(Repair::Prerequisite("wsl-features"))
        );
        let pending = DeviceFacts {
            windows: Some(Ok(plan::Facts {
                reboot_pending: true,
                ..features_off
            })),
            ..base(Os::Windows)
        };
        let parked = prerequisites(&pending, &never).expect("applies");
        assert_eq!(parked.who(), Some(Who::You));
        assert!(parked.session, "a restart is the only way on");
        assert!(prerequisites(&base(Os::Linux), &never).is_none());
    }
}
