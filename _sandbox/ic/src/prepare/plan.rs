/* Compiled everywhere, TESTED everywhere, called only by the Windows build. That is deliberate and it is the
 * whole design: the Windows installer is cross-built on a Linux runner that can never execute a line of it, so
 * the decisions live in pure functions the runner CAN execute. The allow keeps that from reading as rot. */
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Deserialize;

/* WHAT THIS PC IS, AND WHAT THAT MEANS FOR DOCKER — the facts, and the pure reading of them.
 *
 * Windows is the one platform where "install Docker" is a tree rather than a step, and the shim that used to
 * own it could see two leaves of that tree: `docker` on PATH, and a daemon answering. Everything else arrived
 * as the same sentence — "docker is not installed and winget is unavailable" — including the cases where
 * Docker was installed, where Windows could not run it at all, and where the fix was in firmware and no amount
 * of re-running would ever reach it.
 *
 * So the machine is PROBED into facts (facts.rs, one read-only call) and the facts are READ here, by a
 * function with no I/O in it. That split is what makes this testable at all: every combination below is a
 * `Facts` literal in the tests at the bottom, checked on the Linux runner that cross-builds the Windows
 * binary and can never execute it.
 *
 * UNKNOWN IS NOT FALSE. The three hardware facts are `Option<bool>` because a machine whose CIM is broken
 * answers nothing, and a classifier that read that silence as "virtualization is off" would send somebody
 * into their BIOS over a WMI fault. Only an explicit `Some(false)` accuses the machine. Same discipline as
 * checks::Outcome::Skip and the daemon's "unknown" adapter health. */

/* `Win32_Processor.Architecture` — the numeric form, because the string one is localized.
 *
 * Note that ZERO is a real value here (32-bit x86) rather than a missing one, which is why the fact is an
 * Option: a machine whose CIM would not answer must not arrive looking like a Pentium. */
pub const ARCH_X64: u16 = 9;
pub const ARCH_ARM64: u16 = 12;

/// Windows 10 21H2. Docker Desktop's own floor, and below it neither WSL2 nor this flow is worth attempting.
pub const MIN_BUILD: u32 = 19044;

/// The image is multi-GB and docker's "no space left" arrives minutes into the pull. Same figure the Unix
/// disk check uses, so a Windows machine and a Linux one refuse at the same line.
pub const MIN_FREE_GIB: u64 = 5;
pub const TIGHT_FREE_GIB: u64 = 15;

/// Everything the probe reads, plus the three docker facts the caller fills from [`crate::docker`]. One
/// struct rather than two, so a test case is one literal and the classifier has one input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Facts {
    /// `CurrentBuildNumber`. 0 = could not be read, which is unknown and never a refusal.
    pub build: u32,
    /// `23H2` and the like — prose only, for the row the user reads.
    pub display_version: String,
    pub product_name: String,
    /// `Core` is Home, `Professional`/`Enterprise` have Hyper-V. WSL2 works on all of them.
    pub edition_id: String,
    /// None = could not be read. See [`ARCH_X64`] for why that is not spelled `0`.
    pub arch: Option<u16>,
    /// A hypervisor is already running here, which PROVES the hardware can virtualize.
    pub hypervisor_present: Option<bool>,
    /// The firmware switch (VT-x / AMD-V / SVM). Reads false while Hyper-V owns the CPU, so it is only ever
    /// believed together with `hypervisor_present`.
    pub virtualization_firmware: Option<bool>,
    /// Second Level Address Translation. WSL2 and Hyper-V both require it and no setting turns it on.
    pub slat: Option<bool>,
    /// Manufacturer + model, lowercased — how we notice this Windows is itself a guest.
    pub vm_hint: String,
    /// The Host Compute Service exists, i.e. the VirtualMachinePlatform feature is on. Readable without
    /// administrator, unlike `Get-WindowsOptionalFeature`, which is why the services stand in for the features.
    pub service_vmcompute: bool,
    /// `WslService` (modern, Store-delivered WSL) or `LxssManager` (the in-box one) exists, i.e. the Windows
    /// Subsystem for Linux feature is on. A proxy, and treated as one: see [`wsl_functioning`].
    pub service_wsl: bool,
    /// `wsl --status` exited zero.
    pub wsl_status_ok: bool,
    pub wsl_status: String,
    /// `wsl --version` output; empty when this WSL has no kernel of its own (the old in-box one).
    pub wsl_version: String,
    /// Windows has staged a servicing operation that only a restart completes.
    pub reboot_pending: bool,
    pub elevated: bool,
    /// The Windows package manager. Absent on Windows Server and on plenty of Windows 10 installs — the
    /// hole the reported failure fell through.
    pub winget: bool,
    /// `Docker Desktop.exe`'s full path, empty when it is not installed. Installed-but-not-on-PATH is a
    /// state of its own, and this is what tells it from not-installed.
    pub docker_desktop_path: String,
    pub docker_desktop_version: String,
    /// This login token carries the `docker-users` group. A token, not the group's roster: adding somebody
    /// to a group does nothing until they sign in again, and that is the fact worth acting on.
    pub in_docker_users: bool,
    /// The group's ROSTER carries this account, whatever the token above says. The two disagree for exactly
    /// as long as it takes to sign out and back in — and Docker Desktop's installer adds whoever ran it, so
    /// on a machine that has just installed Docker they always disagree. Told apart because the remedies are
    /// nothing alike: one is a UAC prompt, the other is a sign-out that the first cannot substitute for.
    pub in_docker_users_group: bool,
    /// Free space on the system drive, whole GiB. None when the drive would not answer.
    pub free_gib: Option<u64>,
    /// `USERNAME` — the short form, for prose.
    pub user: String,
    /// `whoami`, i.e. `DOMAIN\user`. What a group membership has to be spelled with, and read HERE rather
    /// than inside the elevated helper that uses it: that one may be running as a different account entirely.
    pub user_qualified: String,

    // ---- filled by the caller from crate::docker, not by the probe ----
    pub docker_cli: bool,
    pub docker_daemon: bool,
    /// `docker version --format {{.Server.Os}}` — `windows` here is Docker Desktop in Windows-container mode.
    pub docker_server_os: Option<String>,
}

/// How an unmet requirement gets met. This is what the app turns into a button and what the terminal turns
/// into a question, so it is a closed set rather than free prose: a requirement nobody can act on is a dead
/// end wearing an error message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// We do it, here, now.
    Fix,
    /// We do it, but Windows will ask for administrator first.
    FixElevated,
    /// Windows has to restart before anything else can proceed.
    Restart,
    /// A firmware setting. Windows cannot change it and neither can we.
    Firmware,
    /// This Windows is a guest; the fix is on its host.
    HostVm,
    /// A person has to do something we cannot do for them — free up disk space, finish Docker Desktop's
    /// first-run screens.
    User,
    /// Done, but it only takes effect on the next sign-in.
    SignOut,
    /// Not something this build can run on.
    Unsupported,
}

impl Action {
    /// The wire spelling the app reads.
    pub fn id(self) -> &'static str {
        match self {
            Action::Fix => "fix",
            Action::FixElevated => "fixElevated",
            Action::Restart => "restart",
            Action::Firmware => "firmware",
            Action::HostVm => "hostVm",
            Action::User => "user",
            Action::SignOut => "signOut",
            Action::Unsupported => "unsupported",
        }
    }

    /// Whether we can resolve this ourselves given consent. The rest need a human, a restart or a new PC.
    pub fn ours(self) -> bool {
        matches!(self, Action::Fix | Action::FixElevated)
    }
}

/// One thing standing between this PC and a running sandbox.
#[derive(Debug, Clone)]
pub struct Requirement {
    /// Stable id — what analytics count and what the app switches on. Never reworded.
    pub id: &'static str,
    /// The checklist row, in the reader's terms.
    pub title: String,
    /// What is actually wrong.
    pub problem: String,
    /// What happens next, or what the reader must do.
    pub remedy: String,
    pub action: Action,
    /// The long form, when there is one worth printing in full — the firmware walkthrough, mostly.
    pub detail: Option<String>,
}

fn req(id: &'static str, title: &str, problem: &str, remedy: &str, action: Action) -> Requirement {
    Requirement {
        id,
        title: title.to_string(),
        problem: problem.to_string(),
        remedy: remedy.to_string(),
        action,
        detail: None,
    }
}

/* THE FIRMWARE WALKTHROUGH. This is the one outcome where the user has to leave Windows, and the difference
 * between a good and a bad version of this message is whether they get back. "Enable virtualization in your
 * BIOS" is technically complete and practically useless: the key differs per maker, the setting has four
 * different names, and it lives under a different menu on every board. */
const FIRMWARE_STEPS: &str = "\
How to turn it on:

  1. Save your work and restart this PC.
  2. As it starts, press the setup key repeatedly, before Windows loads:
       HP / Omen ............ Esc, then F10
       Asus / ROG ........... F2  (or Del)
       Lenovo / ThinkPad .... F1  (or F2, or the small Novo button)
       Dell ................. F2
       Acer ................. F2
       MSI .................. Del
       Gigabyte / ASRock .... Del  (or F2)
       Surface .............. hold Volume-Up while powering on
  3. Find the setting. It is called one of:
       Intel VT-x, Intel Virtualization Technology, VMX,
       AMD-V, SVM Mode, or just Virtualization
     Usually under Advanced, CPU Configuration, Overclocking, or Security.
  4. Turn it on, then save and exit (usually F10).
  5. Let Windows start, and run the setup again.

If you cannot find it, search the web for your PC model plus \"enable virtualization\" -
every maker has a page for it.";

/// Which host hypervisor this guest is running on, if we can tell — the nested-virtualization instructions
/// differ per host, and naming the right one is the difference between a fix and a search.
fn guest_of(vm_hint: &str) -> Option<&'static str> {
    const SIGNS: [(&str, &str); 6] = [
        ("vmware", "VMware"),
        ("virtualbox", "VirtualBox"),
        ("innotek", "VirtualBox"),
        ("qemu", "QEMU/KVM"),
        ("xen", "Xen"),
        ("virtual machine", "Hyper-V"),
    ];
    SIGNS
        .iter()
        .find(|(sign, _)| vm_hint.contains(sign))
        .map(|(_, name)| *name)
}

fn nested_steps(host: Option<&str>) -> String {
    let per_host = match host {
        Some("VMware") => "VMware: tick \"Virtualize Intel VT-x/EPT or AMD-V/RVI\" in this VM's Processor settings (the VM must be powered off).",
        Some("VirtualBox") => "VirtualBox: nested virtualization is only supported on AMD hosts, and only with `VBoxManage modifyvm <name> --nested-hw-virt on`. On an Intel host, Docker cannot run in this VM.",
        Some("QEMU/KVM") => "QEMU/KVM: start the guest with `-cpu host` and make sure the host has `kvm_intel nested=1` (or `kvm_amd nested=1`).",
        Some("Hyper-V") => "Hyper-V: on the HOST, run `Set-VMProcessor -VMName <name> -ExposeVirtualizationExtensions $true` with this VM shut down.",
        _ => "Your virtualization software needs \"nested virtualization\" (sometimes \"expose hardware virtualization\") switched on for this VM, with the VM powered off.",
    };
    format!(
        "This Windows is running inside a virtual machine, and its host is not passing the CPU's\n\
         virtualization through. Docker needs it, and nothing inside this VM can turn it on.\n\n\
         {per_host}\n\n\
         Then start this VM again and run the setup."
    )
}

/// WSL is not merely installed but WORKING: `wsl --status` exited zero and this WSL has a kernel of its own.
/// `wsl --version` only answers on the modern, self-updating WSL, which is the only one Docker's backend wants.
///
/// This is the fact; [`Facts::service_wsl`] is only ever the proxy for it, used when there is nothing running
/// to ask.
fn wsl_functioning(facts: &Facts) -> bool {
    facts.wsl_status_ok && !facts.wsl_version.trim().is_empty()
}

/* PROOF, FROM SOMETHING ALREADY RUNNING, THAT THIS PROCESSOR VIRTUALIZES.
 *
 * This exists because of a trap that costs a working machine its setup. `Win32_Processor` answers from wherever
 * it is asked — and once Hyper-V owns the CPU, it is asked from inside the hypervisor's own partition, where
 * the virtualization extensions are not visible. So a perfectly healthy Windows 11 PC, currently running WSL2
 * and Docker, reports:
 *
 *     VirtualizationFirmwareEnabled           : False
 *     SecondLevelAddressTranslationExtensions : False
 *     VMMonitorModeExtensions                 : False
 *
 * Read literally, that is a PC we would send into its BIOS and then declare unsupportable hardware. It is in
 * fact the machine this was tested on. Every one of those flags is believable ONLY when nothing here is already
 * virtualizing; the moment something is, the running thing is the better witness. */
fn virtualization_proven(facts: &Facts) -> bool {
    facts.hypervisor_present == Some(true)
        || wsl_functioning(facts)
        || facts.docker_server_os.as_deref() == Some("linux")
}

/// True when the hardware can virtualize, as far as anything here can tell. Something already virtualizing is
/// proof; otherwise the firmware flag speaks; and silence from both means we do not know, which is not a
/// refusal.
fn virtualization_ok(facts: &Facts) -> Option<bool> {
    if virtualization_proven(facts) {
        return Some(true);
    }
    // Otherwise the firmware flag is the whole answer, INCLUDING its absence: no flag and nothing running is
    // "we could not tell", not "it is off".
    facts.virtualization_firmware
}

/// Everything Docker Desktop's WSL2 backend needs from WSL itself.
fn wsl_ready(facts: &Facts) -> bool {
    facts.service_vmcompute && wsl_functioning(facts)
}

/* WHAT IS STANDING IN THE WAY, IN THE ORDER IT HAS TO BE DEALT WITH.
 *
 * Read top to bottom: the early returns are not shortcuts, they are the DEPENDENCY ORDER. Telling somebody
 * their WSL2 is missing while their CPU cannot virtualize at all is three true sentences and one wasted
 * afternoon — the second fact only becomes actionable after the first is fixed, and a list that does not say
 * so reads as four unrelated problems.
 *
 * Disk space rides along with every blocker rather than waiting behind it: it is independent of all of this,
 * and a machine that is about to be sent into its BIOS may as well learn now that it also needs 5 GB. */
pub fn requirements(facts: &Facts) -> Vec<Requirement> {
    let mut found = Vec::new();

    // ---- things no amount of installing will change ----
    // An arch we could not read is not judged at all; one we read and do not recognise is judged, because
    // this build is 64-bit Intel/AMD and a 32-bit machine cannot run any of it.
    if let Some(arch) = facts.arch.filter(|arch| *arch != ARCH_X64) {
        let (problem, remedy) = if arch == ARCH_ARM64 {
            (
                "this is an ARM64 PC, and intentic's Windows build is 64-bit Intel/AMD only.",
                "install Docker Desktop for Windows on ARM yourself (https://docs.docker.com/desktop/setup/install/windows-install/), then re-run - the rest of the setup works under emulation.",
            )
        } else {
            (
                "this PC's processor is not 64-bit Intel or AMD, which is what intentic's Windows build needs.",
                "run your sandbox on another machine, or in the cloud from the setup screen.",
            )
        };
        found.push(req(
            "arch",
            "This PC's processor",
            problem,
            remedy,
            Action::Unsupported,
        ));
        found.extend(disk(facts));
        return found;
    }
    if facts.build > 0 && facts.build < MIN_BUILD {
        found.push(req(
            "windows-version",
            "Windows version",
            &format!(
                "this is Windows build {} ({}). Docker needs Windows 10 version 21H2 (build {MIN_BUILD}) or newer.",
                facts.build,
                if facts.display_version.is_empty() { "unknown release" } else { &facts.display_version }
            ),
            "install Windows updates until this PC is on 21H2 or later (Settings -> Windows Update), then re-run.",
            Action::Unsupported,
        ));
        found.extend(disk(facts));
        return found;
    }
    // `&& !virtualization_proven` is the whole guard against the worst verdict this file can reach. Unsupported
    // hardware is the one conclusion with no way back, so it is never drawn from a flag that a running
    // hypervisor is known to falsify.
    if facts.slat == Some(false) && !virtualization_proven(facts) {
        found.push(req(
            "slat",
            "Processor features",
            "this processor has no Second Level Address Translation (SLAT), which Docker's Linux engine requires.",
            "Docker cannot run on this PC. Run your sandbox on another machine, or in the cloud from the setup screen.",
            Action::Unsupported,
        ));
        found.extend(disk(facts));
        return found;
    }

    // ---- virtualization: firmware, or somebody else's firmware ----
    if virtualization_ok(facts) == Some(false) {
        let guest = guest_of(&facts.vm_hint);
        let mut requirement = if guest.is_some() {
            req(
                "nested-virtualization",
                "Hardware virtualization",
                "this Windows is a virtual machine, and its host is not passing hardware virtualization through.",
                "switch nested virtualization on for this VM, on the machine hosting it, then start it again.",
                Action::HostVm,
            )
        } else {
            req(
                "virtualization",
                "Hardware virtualization",
                "virtualization is switched off in this PC's firmware (BIOS/UEFI).",
                "restart into firmware setup and turn it on - Windows cannot do this for you.",
                Action::Firmware,
            )
        };
        requirement.detail = Some(if guest.is_some() {
            nested_steps(guest)
        } else {
            FIRMWARE_STEPS.to_string()
        });
        found.push(requirement);
        found.extend(disk(facts));
        return found;
    }

    // ---- a restart Windows is already waiting for ----
    // Enabling optional features on top of a staged servicing operation is how a machine ends up with a
    // half-installed WSL and a `wsl --install` that reports success and changes nothing.
    if facts.reboot_pending {
        found.push(req(
            "pending-restart",
            "A restart Windows is waiting for",
            "Windows has updates staged that only a restart finishes, and turning on features before that is unreliable.",
            "restart this PC, then run the setup again.",
            Action::Restart,
        ));
        found.extend(disk(facts));
        return found;
    }

    // ---- WSL2, which is what Docker's Linux engine actually runs in ----
    // Working WSL outranks the service names, for the same reason as above: the services are how we GUESS the
    // features are on, and a machine that just answered `wsl --status` has told us directly.
    if !wsl_functioning(facts) && (!facts.service_wsl || !facts.service_vmcompute) {
        let missing = match (facts.service_wsl, facts.service_vmcompute) {
            (false, false) => {
                "Windows Subsystem for Linux and Virtual Machine Platform are both off"
            }
            (false, true) => "Windows Subsystem for Linux is off",
            _ => "Virtual Machine Platform is off",
        };
        found.push(req(
            "wsl-features",
            "WSL2",
            &format!("{missing}. Docker runs Linux containers inside WSL2, so they have to be on first."),
            "turn them on with `wsl --install --no-distribution` (Windows will ask for administrator), then restart.",
            Action::FixElevated,
        ));
    } else if !wsl_ready(facts) {
        found.push(req(
            "wsl-kernel",
            "WSL2",
            "WSL is installed but has no current Linux kernel, or is still defaulting to version 1.",
            "update it with `wsl --update` and make version 2 the default.",
            Action::FixElevated,
        ));
    }

    // ---- Docker itself ----
    if facts.docker_desktop_path.is_empty() && !facts.docker_cli {
        let how = if facts.winget {
            "install Docker Desktop with the Windows package manager (about 600 MB)."
        } else {
            // The reported failure, and its fix: winget's absence is not a dead end, it is a different
            // download. Docker publishes the installer at a stable URL and it takes silent-install flags.
            "download Docker Desktop from docker.com and install it (about 600 MB) - this PC has no Windows package manager, so the installer is fetched directly."
        };
        found.push(req(
            "docker-desktop",
            "Docker Desktop",
            "Docker Desktop is not installed.",
            how,
            Action::Fix,
        ));
    } else if !facts.docker_cli {
        // Installed a moment ago, or installed by somebody whose PATH this shell never inherited.
        found.push(req(
            "docker-path",
            "Docker on this session's PATH",
            "Docker Desktop is installed but `docker` is not on this shell's PATH.",
            "use Docker's own program folder for this run - nothing to install.",
            Action::Fix,
        ));
    }

    /* Non-administrators need this group to reach the engine, and Docker's installer only adds the user who
     * ran it. A token without it produces "access is denied" on the pipe, which reads like a broken install.
     *
     * TWO STATES, NOT ONE. "not in the group" is fixable with administrator; "in the group, but this login
     * token predates that" is not fixable by anything at all except a new sign-in. Collapsing them sends a
     * machine that is one sign-out from ready to a UAC prompt, where the add cannot do anything — which is
     * how a reported install stopped dead: Docker Desktop's installer had already added the account moments
     * earlier, in the same pass. */
    if !facts.in_docker_users && !facts.elevated {
        let who = if facts.user.is_empty() {
            "this account"
        } else {
            &facts.user
        };
        found.push(if facts.in_docker_users_group {
            req(
                "docker-users",
                "Permission to use Docker",
                &format!("{who} is in this PC's docker-users group, but this sign-in was issued before that and does not carry it."),
                "sign out of Windows and back in - the group needs a new login token, and nothing else issues one.",
                Action::SignOut,
            )
        } else {
            req(
                "docker-users",
                "Permission to use Docker",
                &format!("{who} is not in this PC's docker-users group, so Docker will refuse the connection."),
                "add this account to docker-users (Windows will ask for administrator), then sign out and back in.",
                Action::FixElevated,
            )
        });
    }

    if !facts.docker_daemon {
        found.push(req(
            "docker-running",
            "Docker running",
            "Docker Desktop is not running.",
            "start it and wait for its engine to come up.",
            Action::Fix,
        ));
    } else if let Some(os) = facts.docker_server_os.as_deref() {
        if os != "linux" {
            found.push(req(
                "docker-linux-containers",
                "Linux containers",
                &format!("Docker is running, but in {os}-container mode - a sandbox is a Linux container."),
                "switch Docker Desktop to Linux containers.",
                Action::Fix,
            ));
        }
    }

    found.extend(disk(facts));
    found
}

/// Free space, as a requirement rather than a check — it belongs in the same list as everything else the user
/// has to deal with, and it is the only one on it that we cannot fix at all.
fn disk(facts: &Facts) -> Option<Requirement> {
    let free = facts.free_gib?;
    if free >= MIN_FREE_GIB {
        return None;
    }
    Some(req(
        "disk-space",
        "Free disk space",
        &format!(
            "only {free} GiB free on this PC's system drive - the sandbox image alone needs more than that."
        ),
        "free at least 5 GiB (Settings -> System -> Storage), then re-run.",
        Action::User,
    ))
}

/* THE CHECKLIST — the same diagnosis, drawn as rows rather than as a list of problems.
 *
 * [`requirements`] answers "what is wrong", which is what the fixer needs. A person reading a terminal needs
 * the other half too: what was LOOKED at. A machine that prints two failures and nothing else has not told
 * anybody whether it checked virtualization and liked it, or never got that far — and "never got that far" is
 * the common case, because the dependency order above returns early.
 *
 * So the rows are a fixed list in the order the machine is examined, each one either fine, broken, or NOT YET
 * JUDGED because something above it has to be dealt with first. The third state is the point of this
 * function: it is the difference between a checklist and a list that merely looks complete. */

/// Every area of the machine, in examination order, with the requirement ids that belong to it.
pub const AREAS: [(&str, &[&str]); 8] = [
    ("This PC", &["arch", "windows-version", "slat"]),
    (
        "Hardware virtualization",
        &["virtualization", "nested-virtualization"],
    ),
    ("No restart pending", &["pending-restart"]),
    ("WSL2", &["wsl-features", "wsl-kernel"]),
    ("Docker Desktop", &["docker-desktop", "docker-path"]),
    ("Permission to use Docker", &["docker-users"]),
    (
        "Docker's engine",
        &["docker-running", "docker-linux-containers"],
    ),
    ("Free disk space", &["disk-space"]),
];

/// The requirements [`requirements`] stops at: everything below one of these is unjudged, not fine.
const BLOCKING: [&str; 6] = [
    "arch",
    "windows-version",
    "slat",
    "virtualization",
    "nested-virtualization",
    "pending-restart",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowState {
    Ok,
    Failed(String),
    /// Not judged: something above it decides whether this can even be assessed.
    Unjudged,
}

#[derive(Debug, Clone)]
pub struct Row {
    pub area: &'static str,
    pub state: RowState,
}

pub fn checklist(facts: &Facts) -> Vec<Row> {
    let unmet = requirements(facts);
    // The area the examination stopped in, if it stopped. Everything after it is unjudged.
    let stopped_at = unmet
        .iter()
        .find(|requirement| BLOCKING.contains(&requirement.id))
        .and_then(|requirement| {
            AREAS
                .iter()
                .position(|(_, ids)| ids.contains(&requirement.id))
        });
    AREAS
        .iter()
        .enumerate()
        .map(|(at, (area, ids))| {
            let failure = unmet
                .iter()
                .find(|requirement| ids.contains(&requirement.id));
            let state = match failure {
                Some(requirement) => RowState::Failed(requirement.problem.clone()),
                // Free space is measured whatever else is wrong (see `requirements`), so it is never unjudged.
                None if stopped_at.is_some_and(|blocker| at > blocker)
                    && *area != "Free disk space" =>
                {
                    RowState::Unjudged
                }
                None => RowState::Ok,
            };
            Row { area, state }
        })
        .collect()
}

/// Warnings — true, worth saying once, and never a reason to stop. Kept apart from [`requirements`] because
/// mixing "you should know" into "you must fix" is how a list of blockers stops being read.
pub fn advisories(facts: &Facts) -> Vec<String> {
    let mut notes = Vec::new();
    if let Some(free) = facts.free_gib {
        if (MIN_FREE_GIB..TIGHT_FREE_GIB).contains(&free) {
            notes.push(format!(
                "{free} GiB free - enough to install, tight once you start working in the sandbox."
            ));
        }
    }
    if virtualization_ok(facts).is_none() {
        notes.push(
            "could not read this PC's virtualization settings, so the setup will find out by trying."
                .to_string(),
        );
    }
    if facts.build == 0 {
        notes.push("could not read this PC's Windows version.".to_string());
    }
    notes
}

/// The build Windows 11 starts at. Every 11 machine reports a `CurrentBuildNumber` at or above this and
/// every 10 machine below it, which makes the number the only reliable way to name the OS — see
/// [`windows_name`].
pub const FIRST_WINDOWS_11_BUILD: u32 = 22_000;

/* WHAT THIS PC IS CALLED, AND WHY IT IS NOT WHAT THE REGISTRY SAYS.
 *
 * `HKLM\…\CurrentVersion\ProductName` was frozen at "Windows 10 …" when 11 shipped and has never been
 * corrected, so a Windows 11 machine introduces itself as "Windows 10 Pro" — which is exactly what a real
 * user saw on the first line of their checklist, above four things we were telling them to change. The
 * facts.rs OMEN fixture has carried that value with a comment about it since it was captured; nothing
 * DECIDES anything from the name, but this is the sentence a stranger reads first, and being visibly wrong
 * about the machine is not a good way to ask somebody for administrator.
 *
 * So the edition (the "Pro"/"Home" tail) is kept — that part of the registry value is right — and only the
 * family in front of it is re-derived from the build number, which is the version of record everywhere else
 * in this module. A name we cannot parse is left exactly as it is rather than guessed at.
 */
pub fn windows_name(product_name: &str, build: u32) -> String {
    let trimmed = product_name.trim();
    if trimmed.is_empty() {
        return "Windows".to_string();
    }
    // Only the values this rewrite is about: `Windows 10 Pro`, `Windows 10 Home`, `Windows 10 Enterprise`.
    // Anything else (a Server SKU, a name a future Windows invents) is somebody else's string.
    let Some(edition) = trimmed.strip_prefix("Windows 10") else {
        return trimmed.to_string();
    };
    if build == 0 || build < FIRST_WINDOWS_11_BUILD {
        return trimmed.to_string();
    }
    format!("Windows 11{edition}")
}

/// The line the checklist draws for a machine with nothing wrong — what it IS, rather than a bare "ok".
pub fn summary(facts: &Facts) -> String {
    let name = windows_name(&facts.product_name, facts.build);
    let release = if facts.display_version.is_empty() {
        String::new()
    } else {
        format!(" {}", facts.display_version)
    };
    let build = if facts.build == 0 {
        String::new()
    } else {
        format!(", build {}", facts.build)
    };
    format!("{name}{release}{build}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /* Every branch above as a fact literal. This runs on the Linux runner that CROSS-BUILDS the Windows
     * binary and cannot execute a line of it — which is the whole reason the classifier has no I/O in it.
     * The Windows-only halves (facts.rs's probe, fix.rs's remediations) are covered by the Windows smoke
     * tiers instead; this is the part where the decisions live. */

    /// A PC where everything is already right — the baseline every case below mutates.
    fn healthy() -> Facts {
        Facts {
            build: 22631,
            display_version: "23H2".to_string(),
            product_name: "Windows 11 Pro".to_string(),
            edition_id: "Professional".to_string(),
            arch: Some(ARCH_X64),
            hypervisor_present: Some(true),
            virtualization_firmware: Some(true),
            slat: Some(true),
            vm_hint: "asus system product name".to_string(),
            service_vmcompute: true,
            service_wsl: true,
            wsl_status_ok: true,
            wsl_status: "Default Version: 2".to_string(),
            wsl_version: "WSL version: 2.2.4.0".to_string(),
            reboot_pending: false,
            elevated: false,
            winget: true,
            docker_desktop_path: "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"
                .to_string(),
            docker_desktop_version: "4.34.0".to_string(),
            in_docker_users: true,
            in_docker_users_group: true,
            free_gib: Some(200),
            user: "radarsu".to_string(),
            user_qualified: "omen\\radarsu".to_string(),
            docker_cli: true,
            docker_daemon: true,
            docker_server_os: Some("linux".to_string()),
        }
    }

    /* A PC WITH NOTHING RUNNING YET — no hypervisor, no WSL, no Docker.
     *
     * The baseline for every judgement about HARDWARE, and it has to be, because [`virtualization_proven`]
     * makes those judgements conditional on nothing already virtualizing. Flipping `virtualization_firmware`
     * to false on top of `healthy()` describes a PC whose firmware virtualization is off while it runs Linux
     * containers in WSL2, which is not a machine — it is two fixtures glued together, and the assertion it
     * carried was only ever passing by accident. */
    fn bare() -> Facts {
        Facts {
            hypervisor_present: Some(false),
            service_vmcompute: false,
            service_wsl: false,
            wsl_status_ok: false,
            wsl_status: String::new(),
            wsl_version: String::new(),
            docker_desktop_path: String::new(),
            docker_desktop_version: String::new(),
            in_docker_users: false,
            in_docker_users_group: false,
            docker_cli: false,
            docker_daemon: false,
            docker_server_os: None,
            ..healthy()
        }
    }

    fn ids(facts: &Facts) -> Vec<&'static str> {
        requirements(facts).into_iter().map(|r| r.id).collect()
    }

    #[test]
    fn a_ready_machine_needs_nothing() {
        assert!(requirements(&healthy()).is_empty());
        assert!(advisories(&healthy()).is_empty());
    }

    /* THE REPORTED FAILURE. No Docker and no package manager was a dead end; it is now one fixable
     * requirement whose remedy names the direct download. */
    #[test]
    fn no_docker_and_no_package_manager_is_still_ours_to_fix() {
        let facts = Facts {
            winget: false,
            docker_desktop_path: String::new(),
            docker_desktop_version: String::new(),
            docker_cli: false,
            docker_daemon: false,
            docker_server_os: None,
            ..healthy()
        };
        let found = requirements(&facts);
        let desktop = found
            .iter()
            .find(|r| r.id == "docker-desktop")
            .expect("a missing Docker Desktop must be reported");
        assert_eq!(
            desktop.action,
            Action::Fix,
            "winget's absence must not turn this into a dead end"
        );
        assert!(
            desktop.remedy.contains("docker.com"),
            "the remedy must name the direct download: {}",
            desktop.remedy
        );
        // And the daemon that cannot be running either way is named too, not left to fail later.
        assert!(found.iter().any(|r| r.id == "docker-running"));
    }

    #[test]
    fn with_a_package_manager_the_remedy_uses_it() {
        let facts = Facts {
            winget: true,
            docker_desktop_path: String::new(),
            docker_cli: false,
            docker_daemon: false,
            docker_server_os: None,
            ..healthy()
        };
        let desktop = requirements(&facts)
            .into_iter()
            .find(|r| r.id == "docker-desktop")
            .expect("reported");
        assert!(
            desktop.remedy.contains("package manager"),
            "{}",
            desktop.remedy
        );
        assert!(!desktop.remedy.contains("docker.com"));
    }

    /* VIRTUALIZATION OFF IN FIRMWARE — the one outcome the user has to leave Windows for, and the one the
     * old script could not see at all. It must not be reported as something we will fix, and it must carry
     * the walkthrough: "enable it in your BIOS" is a sentence, not a fix. */
    #[test]
    fn firmware_virtualization_is_named_as_firmware_and_explained_in_full() {
        let facts = Facts {
            virtualization_firmware: Some(false),
            ..bare()
        };
        let found = requirements(&facts);
        assert_eq!(found.len(), 1, "nothing else is actionable until it is on");
        assert_eq!(found[0].id, "virtualization");
        assert_eq!(found[0].action, Action::Firmware);
        let detail = found[0].detail.as_deref().expect("the walkthrough");
        for expected in ["Intel VT-x", "SVM", "F10", "Lenovo"] {
            assert!(
                detail.contains(expected),
                "walkthrough must mention {expected}"
            );
        }
    }

    #[test]
    fn a_guest_without_nested_virtualization_is_sent_to_its_host_instead() {
        for (hint, expected) in [
            ("vmware, inc. vmware virtual platform", "VMware"),
            ("microsoft corporation virtual machine", "Hyper-V"),
            ("innotek gmbh virtualbox", "VirtualBox"),
            ("qemu standard pc", "QEMU/KVM"),
        ] {
            let facts = Facts {
                virtualization_firmware: Some(false),
                vm_hint: hint.to_string(),
                ..bare()
            };
            let found = requirements(&facts);
            assert_eq!(found[0].id, "nested-virtualization", "for {hint}");
            assert_eq!(found[0].action, Action::HostVm);
            let detail = found[0].detail.as_deref().expect("host instructions");
            assert!(
                detail.contains(expected),
                "{hint} must name {expected}, got: {detail}"
            );
        }
    }

    /* A RUNNING HYPERVISOR IS PROOF. Hyper-V hides the firmware flag from Win32_Processor, so a machine that
     * demonstrably virtualizes reports `VirtualizationFirmwareEnabled = false` — and reading that literally
     * sends a working PC into its BIOS. */
    #[test]
    fn a_running_hypervisor_outweighs_the_firmware_flag() {
        let facts = Facts {
            hypervisor_present: Some(true),
            virtualization_firmware: Some(false),
            ..healthy()
        };
        assert!(
            !ids(&facts).contains(&"virtualization"),
            "a machine already running a hypervisor can virtualize, whatever the flag says"
        );
    }

    /// Unknown is not false: a broken CIM must never be read as an accusation about the hardware.
    #[test]
    fn unreadable_hardware_facts_warn_rather_than_refuse() {
        let facts = Facts {
            hypervisor_present: None,
            virtualization_firmware: None,
            slat: None,
            ..bare()
        };
        assert!(
            !ids(&facts).contains(&"virtualization") && !ids(&facts).contains(&"slat"),
            "unknown hardware is never an accusation about the hardware"
        );
        assert!(
            advisories(&facts)
                .iter()
                .any(|note| note.contains("virtualization settings")),
            "it should say it could not tell"
        );
    }

    /// The same unknowns on a machine that is already running WSL2 are not worth a word: something answering
    /// is a better witness than a flag that would not.
    #[test]
    fn unknown_hardware_is_not_even_mentioned_once_something_is_running() {
        let facts = Facts {
            hypervisor_present: None,
            virtualization_firmware: None,
            slat: None,
            ..healthy()
        };
        assert!(requirements(&facts).is_empty());
        assert!(
            !advisories(&facts)
                .iter()
                .any(|note| note.contains("virtualization settings")),
            "nothing to warn about on a PC that is virtualizing as we speak"
        );
    }

    #[test]
    fn missing_slat_is_the_end_of_the_road_and_says_so() {
        let facts = Facts {
            slat: Some(false),
            ..bare()
        };
        let found = requirements(&facts);
        assert_eq!(found[0].id, "slat");
        assert_eq!(found[0].action, Action::Unsupported);
        assert!(!found[0].action.ours());
    }

    /* THE VERDICT WITH NO WAY BACK, AND THE MACHINE THAT PROVOKED IT. `SecondLevelAddressTranslationExtensions`
     * reads false under a running Hyper-V exactly as the firmware flag does, so the one requirement that tells
     * somebody to go and use a different computer must never be reachable from it alone. */
    #[test]
    fn no_running_machine_is_ever_declared_unsupported_hardware() {
        for proof in [
            Facts {
                hypervisor_present: Some(true),
                ..bare()
            },
            Facts {
                wsl_status_ok: true,
                wsl_version: "WSL version: 2.7.11.0".to_string(),
                ..bare()
            },
            Facts {
                docker_daemon: true,
                docker_server_os: Some("linux".to_string()),
                ..bare()
            },
        ] {
            let facts = Facts {
                slat: Some(false),
                virtualization_firmware: Some(false),
                ..proof
            };
            let found = ids(&facts);
            assert!(
                !found.contains(&"slat") && !found.contains(&"virtualization"),
                "something is virtualizing here, so neither flag is evidence: got {found:?}"
            );
        }
    }

    #[test]
    fn windows_too_old_is_refused_with_the_version_it_needs() {
        let facts = Facts {
            build: 18363,
            display_version: "1909".to_string(),
            ..healthy()
        };
        let found = requirements(&facts);
        assert_eq!(found[0].id, "windows-version");
        assert_eq!(found[0].action, Action::Unsupported);
        assert!(found[0].problem.contains("18363"));
        assert!(found[0].problem.contains("21H2"));
    }

    #[test]
    fn an_unreadable_build_number_is_not_treated_as_ancient() {
        let facts = Facts {
            build: 0,
            ..healthy()
        };
        assert!(!ids(&facts).contains(&"windows-version"));
        assert!(advisories(&facts)
            .iter()
            .any(|n| n.contains("Windows version")));
    }

    #[test]
    fn arm64_says_what_it_is_and_the_one_route_that_works() {
        let facts = Facts {
            arch: Some(ARCH_ARM64),
            ..healthy()
        };
        let found = requirements(&facts);
        assert_eq!(found[0].id, "arch");
        assert_eq!(found[0].action, Action::Unsupported);
        assert!(found[0].remedy.contains("ARM"));
    }

    /* ZERO IS A PROCESSOR, NOT A SILENCE. `Win32_Processor.Architecture` spells 32-bit x86 as 0, so the fact
     * cannot use 0 for "could not read" the way the build number does — a machine whose CIM was unavailable
     * would be told its perfectly good laptop is a Pentium and there is nothing to be done. */
    #[test]
    fn an_unreadable_processor_is_not_a_32_bit_one() {
        assert!(requirements(&Facts {
            arch: None,
            ..healthy()
        })
        .is_empty());

        let old = requirements(&Facts {
            arch: Some(0),
            ..healthy()
        });
        assert_eq!(old[0].id, "arch");
        assert_eq!(old[0].action, Action::Unsupported);
        assert!(
            !old[0].problem.contains("ARM"),
            "a 32-bit machine is not an ARM one: {}",
            old[0].problem
        );
    }

    /* A PENDING RESTART COMES FIRST. `wsl --install` on a machine with staged servicing reports success and
     * leaves the features off, which is a diagnosis nobody recovers from unaided. */
    #[test]
    fn a_pending_restart_is_dealt_with_before_features_are_touched() {
        let facts = Facts {
            reboot_pending: true,
            service_wsl: false,
            service_vmcompute: false,
            ..healthy()
        };
        let found = requirements(&facts);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "pending-restart");
        assert_eq!(found[0].action, Action::Restart);
    }

    #[test]
    fn wsl_features_off_are_ours_to_turn_on_with_administrator() {
        for (lxss, vmp, expected) in [
            (
                false,
                false,
                "Windows Subsystem for Linux and Virtual Machine Platform are both off",
            ),
            (false, true, "Windows Subsystem for Linux is off"),
            (true, false, "Virtual Machine Platform is off"),
        ] {
            let facts = Facts {
                service_wsl: lxss,
                service_vmcompute: vmp,
                ..bare()
            };
            let found = requirements(&facts);
            let wsl = found
                .iter()
                .find(|r| r.id == "wsl-features")
                .expect("reported");
            assert_eq!(wsl.action, Action::FixElevated);
            assert!(wsl.problem.contains(expected), "got: {}", wsl.problem);
        }
    }

    #[test]
    fn features_on_but_no_kernel_is_an_update_not_an_install() {
        let facts = Facts {
            wsl_version: String::new(),
            ..healthy()
        };
        let found = requirements(&facts);
        assert!(found.iter().any(|r| r.id == "wsl-kernel"));
        assert!(!found.iter().any(|r| r.id == "wsl-features"));
    }

    #[test]
    fn installed_but_off_path_is_its_own_state_and_needs_no_download() {
        let facts = Facts {
            docker_cli: false,
            docker_daemon: false,
            docker_server_os: None,
            ..healthy()
        };
        let found = requirements(&facts);
        assert!(
            found.iter().any(|r| r.id == "docker-path"),
            "an installed Docker that is merely off PATH must not be re-downloaded"
        );
        assert!(!found.iter().any(|r| r.id == "docker-desktop"));
    }

    #[test]
    fn windows_container_mode_is_caught_before_the_pull_rather_than_during_it() {
        let facts = Facts {
            docker_server_os: Some("windows".to_string()),
            ..healthy()
        };
        let found = requirements(&facts);
        assert_eq!(found[0].id, "docker-linux-containers");
        assert_eq!(found[0].action, Action::Fix);
    }

    #[test]
    fn an_unrecognised_server_platform_is_not_an_accusation() {
        // A daemon too old to report its platform has done nothing wrong; the same rule docker.rs states.
        let facts = Facts {
            docker_server_os: None,
            ..healthy()
        };
        assert!(requirements(&facts).is_empty());
    }

    #[test]
    fn the_docker_group_matters_only_for_a_non_administrator() {
        let plain = Facts {
            in_docker_users: false,
            in_docker_users_group: false,
            elevated: false,
            ..healthy()
        };
        let group = requirements(&plain)
            .into_iter()
            .find(|r| r.id == "docker-users")
            .expect("reported for a plain user");
        assert_eq!(group.action, Action::FixElevated);
        assert!(group.problem.contains("radarsu"));

        let admin = Facts {
            in_docker_users: false,
            in_docker_users_group: false,
            elevated: true,
            ..healthy()
        };
        assert!(
            !ids(&admin).contains(&"docker-users"),
            "an administrator reaches the engine regardless of the group"
        );
    }

    /* THE REPORTED FAILURE, AS A DIAGNOSIS. A machine that has just installed Docker Desktop is in
     * `docker-users` — Docker's own installer put it there — and carrying a login token issued before that.
     * Reading only the token asks for administrator to perform an add that has already happened, which is a
     * UAC prompt that cannot change anything, followed by `net`'s "already a member" reported as a failure.
     *
     * The two states have to be told apart, because a sign-out is not something administrator substitutes
     * for and administrator is not something a sign-out substitutes for. */
    #[test]
    fn an_account_already_in_the_group_is_asked_to_sign_out_rather_than_for_administrator() {
        let facts = Facts {
            in_docker_users: false,
            in_docker_users_group: true,
            elevated: false,
            ..healthy()
        };
        let group = requirements(&facts)
            .into_iter()
            .find(|r| r.id == "docker-users")
            .expect("a stale token is still a requirement");
        assert_eq!(
            group.action,
            Action::SignOut,
            "there is nothing left to add, so there is nothing to ask administrator for"
        );
        assert!(
            group.problem.contains("is in this PC's docker-users group"),
            "it must not accuse the machine of a missing membership it has: {}",
            group.problem
        );
        assert!(
            group.remedy.contains("sign out"),
            "the one thing that works: {}",
            group.remedy
        );
        assert!(
            !group.remedy.contains("administrator"),
            "asking for a prompt that cannot help is how this stopped at 8%: {}",
            group.remedy
        );
    }

    /// …and the same row keeps its old shape when the account really is missing from the group.
    #[test]
    fn an_account_missing_from_the_group_still_gets_the_administrator_route() {
        let facts = Facts {
            in_docker_users: false,
            in_docker_users_group: false,
            elevated: false,
            ..healthy()
        };
        let group = requirements(&facts)
            .into_iter()
            .find(|r| r.id == "docker-users")
            .expect("reported");
        assert_eq!(group.action, Action::FixElevated);
        assert!(group.action.ours(), "this half is still ours to do");
    }

    /// A token that already carries the group is the end of it — the roster is not asked, and no row is drawn
    /// either way.
    #[test]
    fn a_token_that_carries_the_group_needs_nothing_whatever_the_roster_says() {
        for roster in [true, false] {
            let facts = Facts {
                in_docker_users: true,
                in_docker_users_group: roster,
                ..healthy()
            };
            assert!(
                !ids(&facts).contains(&"docker-users"),
                "the token is what Docker's pipe reads, and it has the group"
            );
        }
    }

    #[test]
    fn disk_space_is_reported_alongside_a_blocker_it_has_nothing_to_do_with() {
        let facts = Facts {
            free_gib: Some(2),
            virtualization_firmware: Some(false),
            ..bare()
        };
        let found = ids(&facts);
        assert_eq!(
            found,
            vec!["virtualization", "disk-space"],
            "a machine heading into its BIOS should learn about the disk now, not on the next run"
        );
    }

    #[test]
    fn a_tight_disk_warns_and_a_full_one_blocks() {
        let tight = Facts {
            free_gib: Some(10),
            ..healthy()
        };
        assert!(requirements(&tight).is_empty());
        assert!(advisories(&tight).iter().any(|n| n.contains("tight")));
        assert_eq!(
            ids(&Facts {
                free_gib: Some(4),
                ..healthy()
            }),
            vec!["disk-space"]
        );
        // Unknown free space says nothing at all rather than guessing.
        assert!(requirements(&Facts {
            free_gib: None,
            ..healthy()
        })
        .is_empty());
        assert!(advisories(&Facts {
            free_gib: None,
            ..healthy()
        })
        .is_empty());
    }

    /* A FRESH PC, WHICH IS THE CASE THIS WHOLE MODULE EXISTS FOR: nothing installed, features off. It must
     * come back as an ordered, complete list of things we can do, not a single sentence about one of them. */
    #[test]
    fn a_bare_machine_gets_one_ordered_list_of_everything_it_needs() {
        let facts = Facts {
            service_wsl: false,
            service_vmcompute: false,
            wsl_status_ok: false,
            wsl_version: String::new(),
            winget: false,
            docker_desktop_path: String::new(),
            docker_desktop_version: String::new(),
            in_docker_users: false,
            in_docker_users_group: false,
            docker_cli: false,
            docker_daemon: false,
            docker_server_os: None,
            ..healthy()
        };
        assert_eq!(
            ids(&facts),
            vec![
                "wsl-features",
                "docker-desktop",
                "docker-users",
                "docker-running",
            ],
            "WSL2 before Docker, Docker before the group, the group before waiting on the engine"
        );
        assert!(
            requirements(&facts).iter().all(|r| r.action.ours()),
            "every one of these is ours to do - a fresh PC should never need the user to leave the window"
        );
    }

    /* THE CHECKLIST'S THIRD STATE, which is the whole reason it is not just "the failures, inverted".
     *
     * A PC whose firmware has virtualization switched off is never asked about WSL2 or Docker, because the
     * answers would be meaningless. Drawing those rows as ticks would be a lie, and leaving them out would
     * read as a shorter checklist on a more broken machine. */
    #[test]
    fn rows_below_a_blocker_are_unjudged_rather_than_passed() {
        let facts = Facts {
            virtualization_firmware: Some(false),
            free_gib: Some(500),
            ..bare()
        };
        let rows = checklist(&facts);
        let state = |area: &str| {
            rows.iter()
                .find(|row| row.area == area)
                .map(|row| row.state.clone())
                .expect("every area is drawn")
        };
        assert_eq!(state("This PC"), RowState::Ok);
        assert!(matches!(
            state("Hardware virtualization"),
            RowState::Failed(_)
        ));
        assert_eq!(
            state("WSL2"),
            RowState::Unjudged,
            "WSL2 was never assessed on a PC that cannot virtualize - saying it is fine would be a lie"
        );
        assert_eq!(state("Docker Desktop"), RowState::Unjudged);
        assert_eq!(
            state("Free disk space"),
            RowState::Ok,
            "free space is measured regardless of what else is wrong, so it is never unjudged"
        );
    }

    #[test]
    fn a_healthy_machine_draws_every_row_as_fine() {
        let rows = checklist(&healthy());
        assert_eq!(rows.len(), AREAS.len());
        assert!(rows.iter().all(|row| row.state == RowState::Ok));
    }

    #[test]
    fn a_failing_row_carries_the_problem_that_made_it_fail() {
        let facts = Facts {
            docker_desktop_path: String::new(),
            docker_cli: false,
            docker_daemon: false,
            docker_server_os: None,
            ..healthy()
        };
        let rows = checklist(&facts);
        let docker = rows
            .iter()
            .find(|row| row.area == "Docker Desktop")
            .expect("drawn");
        let RowState::Failed(problem) = &docker.state else {
            panic!("a missing Docker Desktop must fail its row")
        };
        assert!(problem.contains("not installed"), "{problem}");
        // Nothing blocked, so the rows either side are still judged normally.
        assert_eq!(
            rows.iter()
                .find(|row| row.area == "WSL2")
                .map(|row| row.state.clone()),
            Some(RowState::Ok)
        );
    }

    /// Every id the classifier can produce has a home on the checklist — otherwise a real failure is drawn as
    /// a passing row, which is the worst outcome this file has.
    #[test]
    fn every_requirement_id_belongs_to_an_area() {
        let known: Vec<&str> = AREAS
            .iter()
            .flat_map(|(_, ids)| ids.iter().copied())
            .collect();
        for id in [
            "arch",
            "windows-version",
            "slat",
            "virtualization",
            "nested-virtualization",
            "pending-restart",
            "wsl-features",
            "wsl-kernel",
            "docker-desktop",
            "docker-path",
            "docker-users",
            "docker-running",
            "docker-linux-containers",
            "disk-space",
        ] {
            assert!(known.contains(&id), "{id} is not on any checklist row");
        }
        for id in BLOCKING {
            assert!(known.contains(&id), "{id} blocks but has no row");
        }
    }

    #[test]
    fn wire_spellings_are_stable() {
        // The app switches on these strings; reordering the enum must not silently rename one.
        assert_eq!(Action::Fix.id(), "fix");
        assert_eq!(Action::FixElevated.id(), "fixElevated");
        assert_eq!(Action::Restart.id(), "restart");
        assert_eq!(Action::Firmware.id(), "firmware");
        assert_eq!(Action::HostVm.id(), "hostVm");
        assert_eq!(Action::User.id(), "user");
        assert_eq!(Action::SignOut.id(), "signOut");
        assert_eq!(Action::Unsupported.id(), "unsupported");
        for action in [
            Action::Restart,
            Action::Firmware,
            Action::HostVm,
            Action::User,
            Action::SignOut,
            Action::Unsupported,
        ] {
            assert!(!action.ours(), "{} is not ours to perform", action.id());
        }
    }

    #[test]
    fn the_summary_line_degrades_without_inventing_anything() {
        assert_eq!(summary(&healthy()), "Windows 11 Pro 23H2, build 22631");
        assert_eq!(
            summary(&Facts {
                product_name: String::new(),
                display_version: String::new(),
                build: 0,
                ..healthy()
            }),
            "Windows"
        );
    }

    /* THE REGISTRY LIES ABOUT WHICH WINDOWS THIS IS, and a real user met that lie on the first line of a
     * checklist that then asked them for administrator four times. `ProductName` was frozen at "Windows 10"
     * when 11 shipped; the build number is what everything else in this module already believes. */
    #[test]
    fn a_windows_11_machine_is_not_introduced_as_windows_10() {
        // The exact pair the reported machine printed: 25H2, build 26200, calling itself Windows 10 Pro.
        assert_eq!(windows_name("Windows 10 Pro", 26_200), "Windows 11 Pro");
        assert_eq!(windows_name("Windows 10 Home", 22_631), "Windows 11 Home");
        assert_eq!(
            windows_name("Windows 10 Enterprise", FIRST_WINDOWS_11_BUILD),
            "Windows 11 Enterprise"
        );
        // …and the summary line the checklist actually draws.
        assert_eq!(
            summary(&Facts {
                product_name: "Windows 10 Pro".to_string(),
                display_version: "25H2".to_string(),
                build: 26_200,
                ..healthy()
            }),
            "Windows 11 Pro 25H2, build 26200"
        );
    }

    #[test]
    fn a_machine_that_really_is_windows_10_keeps_its_name() {
        assert_eq!(windows_name("Windows 10 Pro", 19_045), "Windows 10 Pro");
        assert_eq!(
            windows_name("Windows 10 Pro", FIRST_WINDOWS_11_BUILD - 1),
            "Windows 10 Pro"
        );
        // A build we could not read is not evidence of anything, so the registry's word stands.
        assert_eq!(windows_name("Windows 10 Pro", 0), "Windows 10 Pro");
    }

    #[test]
    fn a_name_this_rule_is_not_about_is_left_alone() {
        // Server SKUs and anything a future Windows invents are somebody else's string.
        assert_eq!(
            windows_name("Windows Server 2022 Standard", 26_200),
            "Windows Server 2022 Standard"
        );
        assert_eq!(windows_name("Windows 11 Pro", 26_200), "Windows 11 Pro");
        assert_eq!(windows_name("", 26_200), "Windows");
        assert_eq!(windows_name("   ", 26_200), "Windows");
    }
}
