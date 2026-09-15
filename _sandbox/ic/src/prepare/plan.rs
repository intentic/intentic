/* Compiled everywhere, TESTED everywhere, called only by the Windows build. */
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Deserialize;

/* WHAT THIS PC IS, AND WHAT THAT MEANS FOR DOCKER — the facts, and the pure reading of them. */

/* `Win32_Processor.Architecture` — the numeric form, because the string one is localized. */
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
    /// The engine is up and REFUSED this account ("Access is denied" on its pipe). Never true alongside
    /// `docker_daemon`; false when the engine is simply not running. The one fact that settles the
    /// docker-users question, because it is Docker's own verdict rather than a prediction of it.
    pub docker_denied: bool,
    /// `docker version --format {{.Server.Os}}` — `windows` here is Docker Desktop in Windows-container mode.
    pub docker_server_os: Option<String>,
}

/// Whether the daemon's refusal (see `crate::docker::daemon_refusal`) is the engine turning THIS ACCOUNT away
/// rather than not being there at all. Docker's CLI reports the pipe's own error, and Windows spells a
/// permission failure on a named pipe exactly one way.
pub fn engine_denied(refusal: &str) -> bool {
    refusal.to_ascii_lowercase().contains("access is denied")
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

/* THE FIRMWARE WALKTHROUGH. */
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

/* This exists because of a trap that costs a working machine its setup. */
fn virtualization_proven(facts: &Facts) -> bool {
    facts.hypervisor_present == Some(true)
        || wsl_functioning(facts)
        || facts.docker_server_os.as_deref() == Some("linux")
        // An engine that refused this account is an engine that is RUNNING, on WSL2.
        || facts.docker_denied
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

/// The account, as prose: the name Windows knows it by, or "this account" when even that could not be read.
fn who(facts: &Facts) -> &str {
    if facts.user.is_empty() {
        "this account"
    } else {
        &facts.user
    }
}

/// THE ONE REQUIREMENT THAT IS ALREADY MET AND STILL IN THE WAY: the account is in Docker's group, and the
/// session it is signed into predates that. Built here, in one place, because three moments produce it (the
/// examination, the group fix finishing, the engine refusing a freshly started Docker) and a reader meeting
/// it twice must meet the same words.
pub fn sign_out_requirement(facts: &Facts) -> Requirement {
    req(
        "docker-users",
        "Permission to use Docker",
        &format!(
            "{} has been given permission to use Docker, and Windows only applies that at the next sign-in.",
            who(facts)
        ),
        "You need to sign out of Windows and back in; the setup continues from there. If you have already done that once and this is still here, restart the PC instead.",
        Action::SignOut,
    )
}

/* Read top to bottom: the early returns are not shortcuts, they are the DEPENDENCY ORDER. */
pub fn requirements(facts: &Facts) -> Vec<Requirement> {
    let mut found = Vec::new();

    // ---- things no amount of installing will change ----
    // An arch we could not read is not judged at all; one we read and do not recognise is judged, because
    // this build is 64-bit Intel/AMD and a 32-bit machine cannot run any of it.
    if let Some(arch) = facts.arch.filter(|arch| *arch != ARCH_X64) {
        let (problem, remedy) = if arch == ARCH_ARM64 {
            (
                "This is an ARM64 PC, and Intentic's Windows build is for 64-bit Intel and AMD processors only.",
                "Install Docker Desktop for Windows on ARM yourself (https://docs.docker.com/desktop/setup/install/windows-install/), then check again: the rest of the setup works under emulation.",
            )
        } else {
            (
                "This PC's processor is not a 64-bit Intel or AMD one, which is what Intentic's Windows build needs.",
                "Run your sandbox on a machine we host instead.",
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
                "This is Windows build {} ({}). Docker needs Windows 10 version 21H2 (build {MIN_BUILD}) or newer.",
                facts.build,
                if facts.display_version.is_empty() { "unknown release" } else { &facts.display_version }
            ),
            "Install Windows updates (Settings, then Windows Update) until this PC is on 21H2 or later, then check again.",
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
            "This processor lacks a feature Docker's Linux engine requires (Second Level Address Translation).",
            "Docker cannot run on this PC. Run your sandbox on a machine we host instead.",
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
                "This Windows is running inside a virtual machine, and the computer hosting it is not passing hardware virtualization through.",
                "Switch nested virtualization on for this VM, on the computer hosting it, then start the VM again.",
                Action::HostVm,
            )
        } else {
            req(
                "virtualization",
                "Hardware virtualization",
                "Virtualization is switched off in this PC's firmware (BIOS/UEFI).",
                "Restart into the firmware settings and turn it on: Windows cannot do this for you. The steps below walk you through it.",
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
            "Windows has updates that only a restart finishes, and the features Docker needs cannot be set up until then.",
            "Restart this PC; the setup continues once you are back.",
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
                "the two Windows features it needs (Windows Subsystem for Linux and Virtual Machine Platform) are switched off"
            }
            (false, true) => "the Windows Subsystem for Linux feature is switched off",
            _ => "the Virtual Machine Platform feature is switched off",
        };
        found.push(req(
            "wsl-features",
            "Windows features for Docker",
            &format!("Docker runs its Linux engine inside WSL2, and {missing}."),
            "We will turn them on. Windows asks for permission once, and then needs a restart.",
            Action::FixElevated,
        ));
    } else if !wsl_ready(facts) {
        found.push(req(
            "wsl-kernel",
            "Windows features for Docker",
            "WSL2 is installed but needs an update before Docker's engine can run inside it.",
            "We will update it. Windows asks for permission once; no restart is needed.",
            Action::FixElevated,
        ));
    }

    // ---- Docker itself ----
    if facts.docker_desktop_path.is_empty() && !facts.docker_cli {
        let how = if facts.winget {
            "We will install it with the Windows package manager (about 600 MB). Windows asks for permission once."
        } else {
            // The reported failure, and its fix: winget's absence is not a dead end, it is a different
            // download. Docker publishes the installer at a stable URL and it takes silent-install flags.
            "We will download it from docker.com and install it (about 600 MB). Windows asks for permission once."
        };
        found.push(req(
            "docker-desktop",
            "Docker Desktop",
            "Docker Desktop is not installed on this PC.",
            how,
            Action::Fix,
        ));
    } else if !facts.docker_cli {
        // Installed a moment ago, or installed by somebody whose PATH this shell never inherited.
        found.push(req(
            "docker-path",
            "Docker Desktop",
            "Docker Desktop is installed, but this setup cannot see it yet.",
            "We will use Docker's own program folder for this run: nothing to install.",
            Action::Fix,
        ));
    }

    /* PERMISSION: Docker's own verdict outranks every prediction of it. */
    // An engine that answered has already admitted this account, whatever the login token says about groups;
    // one that refused with "access is denied" is running and has not. Only when the engine is not there to
    // ask is the group's roster consulted, and then only to grant a membership that is plainly missing —
    // never to send somebody to sign out on the strength of a token that Docker has not yet been asked about.
    let refused = facts.docker_denied;
    let predicted =
        !facts.docker_daemon && !refused && !facts.in_docker_users && !facts.in_docker_users_group;
    if !facts.elevated && (refused || predicted) {
        found.push(if facts.in_docker_users_group {
            sign_out_requirement(facts)
        } else {
            req(
                "docker-users",
                "Permission to use Docker",
                &format!(
                    "{} does not have permission to use Docker on this PC yet.",
                    who(facts)
                ),
                "We will grant it. Windows asks for permission once, and then you need to sign out and back in.",
                Action::FixElevated,
            )
        });
    }

    if !facts.docker_daemon && !refused {
        found.push(req(
            "docker-running",
            "Docker Desktop running",
            "Docker Desktop is not running.",
            "We will start it and wait for its engine to come up. If it shows a welcome screen, accept it.",
            Action::Fix,
        ));
    } else if let Some(os) = facts.docker_server_os.as_deref() {
        if os != "linux" {
            found.push(req(
                "docker-linux-containers",
                "Linux containers",
                &format!("Docker is running, but in {os}-container mode, and a sandbox is a Linux container."),
                "We will switch Docker Desktop to Linux containers.",
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
            "Only {free} GB is free on this PC's system drive, and the sandbox image alone needs more than that."
        ),
        "Free up at least 5 GB (Settings, then System, then Storage), then check again.",
        Action::User,
    ))
}

/* THE CHECKLIST — the same diagnosis, drawn as rows rather than as a list of problems. */

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

/* Windows machine-wide startup is registered under HKLM. */
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

    /* Every branch above as a fact literal. */

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
            docker_denied: false,
            docker_server_os: Some("linux".to_string()),
        }
    }

    /* A PC WITH NOTHING RUNNING YET — no hypervisor, no WSL, no Docker. */
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

    /* No Docker or package manager is still a fixable setup state. */
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

    /* VIRTUALIZATION OFF IN FIRMWARE — the one outcome the user has to leave Windows for, and the one the old script could not see at all. */
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

    /* A RUNNING HYPERVISOR IS PROOF. */
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

    /* THE VERDICT WITH NO WAY BACK, AND THE MACHINE THAT PROVOKED IT. */
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
            // An engine that refused this account is an engine that is running, on WSL2.
            Facts {
                docker_denied: true,
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

    /* ZERO IS A PROCESSOR, NOT A SILENCE. */
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

    /* A PENDING RESTART COMES FIRST. */
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
                "Windows Subsystem for Linux and Virtual Machine Platform) are switched off",
            ),
            (
                false,
                true,
                "Windows Subsystem for Linux feature is switched off",
            ),
            (
                true,
                false,
                "Virtual Machine Platform feature is switched off",
            ),
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

    /// Docker Desktop installed and stopped — the commonest state on a developer's PC, and the one state
    /// where the group has to be PREDICTED because there is no engine to ask.
    fn stopped() -> Facts {
        Facts {
            docker_daemon: false,
            docker_denied: false,
            docker_server_os: None,
            ..healthy()
        }
    }

    #[test]
    fn the_docker_group_matters_only_for_a_non_administrator() {
        let plain = Facts {
            in_docker_users: false,
            in_docker_users_group: false,
            elevated: false,
            ..stopped()
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
            ..stopped()
        };
        assert!(
            !ids(&admin).contains(&"docker-users"),
            "an administrator reaches the engine regardless of the group"
        );
    }

    /* THE ENGINE'S OWN ANSWER OUTRANKS THE TOKEN — the fix for a sign-out that was asked for and changed nothing. */
    #[test]
    fn an_engine_that_answers_has_settled_the_permission_question() {
        // The login token says no group, the roster says whatever: Docker just answered this account.
        for roster in [true, false] {
            let facts = Facts {
                in_docker_users: false,
                in_docker_users_group: roster,
                elevated: false,
                ..healthy()
            };
            assert!(
                requirements(&facts).is_empty(),
                "an engine that answered is proof of permission, whatever whoami says (roster={roster})"
            );
        }
    }

    /* THE REPORTED FAILURE, AS A DIAGNOSIS. */
    #[test]
    fn an_engine_that_refuses_an_account_already_in_the_group_asks_for_a_sign_in() {
        let facts = Facts {
            docker_daemon: false,
            docker_denied: true,
            docker_server_os: None,
            in_docker_users: false,
            in_docker_users_group: true,
            elevated: false,
            ..healthy()
        };
        let found = requirements(&facts);
        assert_eq!(
            found.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec!["docker-users"],
            "a refusing engine is a RUNNING engine, so nothing may try to start it"
        );
        let group = &found[0];
        assert_eq!(
            group.action,
            Action::SignOut,
            "there is nothing left to add, so there is nothing to ask administrator for"
        );
        assert!(
            group.problem.contains("has been given permission"),
            "it must not accuse the machine of a missing membership it has: {}",
            group.problem
        );
        assert!(
            group.remedy.contains("sign out"),
            "the one thing that works: {}",
            group.remedy
        );
        assert!(
            group.remedy.contains("restart"),
            "and the way out when a sign-out did not do it: {}",
            group.remedy
        );
        assert!(
            !group.remedy.contains("administrator"),
            "asking for a prompt that cannot help is how this stopped at 8%: {}",
            group.remedy
        );
    }

    /// …and when the engine refuses an account the group really is missing, the administrator route.
    #[test]
    fn an_engine_that_refuses_an_account_missing_from_the_group_grants_it() {
        let facts = Facts {
            docker_daemon: false,
            docker_denied: true,
            docker_server_os: None,
            in_docker_users: false,
            in_docker_users_group: false,
            elevated: false,
            ..healthy()
        };
        let found = requirements(&facts);
        assert_eq!(
            found.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec!["docker-users"]
        );
        assert_eq!(found[0].action, Action::FixElevated);
        assert!(found[0].action.ours(), "this half is still ours to do");
    }

    /// A membership the roster already has and the token does not is NOT a reason to sign out while the
    /// engine is stopped: the token has not been tested against anything yet. Start Docker; it will say.
    #[test]
    fn a_stopped_engine_never_sends_an_account_to_sign_out_on_the_tokens_word_alone() {
        let facts = Facts {
            in_docker_users: false,
            in_docker_users_group: true,
            elevated: false,
            ..stopped()
        };
        assert_eq!(ids(&facts), vec!["docker-running"]);
    }

    #[test]
    fn a_refusal_is_recognised_by_windows_own_words_for_it() {
        assert!(engine_denied(
            "error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version\": open //./pipe/dockerDesktopLinuxEngine: Access is denied."
        ));
        assert!(!engine_denied(
            "error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified."
        ));
        assert!(!engine_denied(""));
    }

    /// The sign-out row is built once for the three moments that produce it, so they cannot drift.
    #[test]
    fn the_sign_out_row_names_the_account_and_is_a_sign_out() {
        let row = sign_out_requirement(&healthy());
        assert_eq!(row.id, "docker-users");
        assert_eq!(row.action, Action::SignOut);
        assert!(row.problem.starts_with("radarsu "), "{}", row.problem);
        let anonymous = sign_out_requirement(&Facts {
            user: String::new(),
            ..healthy()
        });
        assert!(
            anonymous.problem.starts_with("this account "),
            "{}",
            anonymous.problem
        );
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

    /* A FRESH PC, WHICH IS THE CASE THIS WHOLE MODULE EXISTS FOR: nothing installed, features off. */
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

    /* THE CHECKLIST'S THIRD STATE, which is the whole reason it is not just "the failures, inverted". */
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

    /* The registry must identify the target Windows installation. */
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
