// See plan.rs's header: the probe's PARSE is exercised on every runner, its RUN only on Windows.
#![cfg_attr(not(windows), allow(dead_code))]

use super::plan::Facts;
#[cfg(windows)]
use super::shell;

/* READING THE MACHINE — once, read-only, in one call.
 *
 * Twelve facts, twelve `powershell.exe` launches, on the slowest process-spawn platform there is: that is the
 * version of this that never got written. PowerShell costs the better part of a second to start, and a
 * checklist that takes fifteen seconds to appear is one people interrupt.
 *
 * So the probe is ONE script that answers everything and prints one line of JSON. Nothing here decides
 * anything — the reading is plan.rs's job — and nothing here writes: every statement below is a query, which
 * is what makes it safe to run before consent has been asked for anything. */

/// The probe. ASCII on purpose (see shell.rs), PowerShell 5.1 on purpose — `powershell.exe` is still the
/// default on every Windows 10 and 11, and a script that needs 7.x is a script that needs an install first.
///
/// Every fact that can be UNKNOWN says so with `$null` rather than a default: `virtualizationFirmware = false`
/// on a machine whose CIM is broken would send its owner into their BIOS for nothing.
const PROBE: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$env:WSL_UTF8 = '1'

$reg = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$cs = Get-CimInstance -ClassName Win32_ComputerSystem
$cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
$disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + $env:SystemDrive + "'")

$hyper = $null
$vmHint = ''
if ($cs) {
  if ($null -ne $cs.HypervisorPresent) { $hyper = [bool]$cs.HypervisorPresent }
  $vmHint = ('' + $cs.Manufacturer + ' ' + $cs.Model).ToLower()
}

$virt = $null
$slat = $null
# Null, not zero: 0 is a REAL architecture in this enumeration (32-bit x86), so a machine that would not
# answer must not arrive looking like an old Pentium.
$arch = $null
if ($cpu) {
  if ($null -ne $cpu.VirtualizationFirmwareEnabled) { $virt = [bool]$cpu.VirtualizationFirmwareEnabled }
  if ($null -ne $cpu.SecondLevelAddressTranslationExtensions) { $slat = [bool]$cpu.SecondLevelAddressTranslationExtensions }
  $arch = [int]$cpu.Architecture
}

$wslStatus = ''
$wslOk = $false
$wslVersion = ''
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
  $wslStatus = (wsl.exe --status 2>&1 | Out-String)
  $wslOk = ($LASTEXITCODE -eq 0)
  $v = (wsl.exe --version 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0) { $wslVersion = $v }
}

$pending = $false
foreach ($key in @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')) {
  if (Test-Path $key) { $pending = $true }
}

$dd = ''
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if ($base -and ($dd -eq '')) {
    $candidate = Join-Path $base 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $candidate) { $dd = $candidate }
  }
}
$ddVer = ''
$uninstall = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop'
if ($uninstall) { $ddVer = [string]$uninstall.DisplayVersion }

# Two names for one feature. `LxssManager` is the in-box WSL's service; the modern WSL that ships as a Store
# package registers `WslService` instead and does NOT create the old one. Asking only for `LxssManager` reads a
# perfectly good WSL 2.7 machine as "WSL is switched off".
$wslService = $false
foreach ($name in @('WslService', 'LxssManager')) {
  if (Get-Service -Name $name) { $wslService = $true }
}

$groups = (whoami.exe /groups 2>&1 | Out-String)
$admin = $false
try {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# TWO DIFFERENT QUESTIONS ABOUT ONE GROUP, and the whole reason this block exists.
#
# `$groups` above is the LOGIN TOKEN, which is issued once at sign-in and never revised. The roster below is
# the group as it stands right now. They disagree for exactly as long as it takes somebody to sign out and
# back in - and Docker Desktop's own installer adds whoever ran it, so on a machine that has just installed
# Docker they disagree every time. Asking for administrator to add an account that is already there is a UAC
# prompt that cannot change anything; asking the user to sign out is the fix that works.
#
# Reading a local group needs no administrator, which is what makes this safe to ask before consent.
$me = ([string](whoami.exe)).Trim()
$short = $me
if ($me.Contains('\')) { $short = $me.Split('\')[-1] }
$roster = @()
foreach ($line in (net.exe localgroup docker-users 2>&1)) { $roster += ([string]$line).Trim() }
$inGroup = (($roster -contains $me) -or ($roster -contains $short))

$free = $null
if ($disk -and $disk.FreeSpace) { $free = [int64]([math]::Floor($disk.FreeSpace / 1GB)) }

@{
  build = [int]$reg.CurrentBuildNumber
  displayVersion = [string]$reg.DisplayVersion
  productName = [string]$reg.ProductName
  editionId = [string]$reg.EditionID
  arch = $arch
  hypervisorPresent = $hyper
  virtualizationFirmware = $virt
  slat = $slat
  vmHint = $vmHint
  serviceVmcompute = [bool](Get-Service -Name vmcompute)
  serviceWsl = $wslService
  wslStatusOk = $wslOk
  wslStatus = $wslStatus
  wslVersion = $wslVersion
  rebootPending = $pending
  elevated = $admin
  winget = [bool](Get-Command winget.exe)
  dockerDesktopPath = $dd
  dockerDesktopVersion = $ddVer
  inDockerUsers = ($groups -match 'docker-users')
  inDockerUsersGroup = [bool]$inGroup
  freeGib = $free
  user = [string]$env:USERNAME
  userQualified = $me
} | ConvertTo-Json -Compress
"#;

/// The probe's JSON into facts. Separate from running it, so the parse is exercised on the runner that
/// cross-builds this binary — a field renamed on one side of that boundary is otherwise only ever found by a
/// user, as a machine that mysteriously reports every fact as false.
pub fn parse(json: &str) -> Result<Facts, String> {
    let mut facts: Facts = serde_json::from_str(json.trim())
        .map_err(|error| format!("could not read this PC's own report: {error}"))?;
    // Older WSL builds print UTF-16 whatever the console is set to, which arrives here as text with NULs
    // through it. Only ever tested for emptiness, but it also gets shown, so clean it.
    facts.wsl_status = facts.wsl_status.replace('\0', "").trim().to_string();
    facts.wsl_version = facts.wsl_version.replace('\0', "").trim().to_string();
    Ok(facts)
}

/// Ask this PC about itself, then fold in what only [`crate::docker`] can answer. Docker's three facts are
/// gathered here rather than in the probe because this binary already owns them, and a second implementation
/// of "is the daemon up" in PowerShell is exactly the drift this module was built to avoid.
#[cfg(windows)]
pub fn probe() -> Result<Facts, String> {
    let output = shell::run(PROBE);
    if output.stdout.trim().is_empty() {
        return Err(format!(
            "could not read this PC's configuration{}",
            if output.stderr.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", output.stderr.trim())
            }
        ));
    }
    let mut facts = parse(&output.stdout)?;
    facts.docker_cli = crate::docker::cli_present();
    facts.docker_daemon = facts.docker_cli && crate::docker::daemon_reachable();
    facts.docker_server_os = if facts.docker_daemon {
        crate::docker::server_os()
    } else {
        None
    };
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepare::plan::{requirements, ARCH_X64};

    /* THE PROBE'S OUTPUT, AS THE PROBE ACTUALLY PRINTS IT. Captured from a real Windows 11 machine and
     * trimmed to one line, because the failure this guards against is silent: a key renamed on either side
     * leaves serde filling every field with its default, and a machine that is completely fine then reports
     * no Docker, no WSL and no virtualization. */
    const REAL: &str = r#"{"build":22631,"displayVersion":"23H2","productName":"Windows 11 Pro","editionId":"Professional","arch":9,"hypervisorPresent":true,"virtualizationFirmware":false,"slat":true,"vmHint":"asus system product name","serviceVmcompute":true,"serviceWsl":true,"wslStatusOk":true,"wslStatus":"Default Version: 2","wslVersion":"WSL version: 2.2.4.0","rebootPending":false,"elevated":false,"winget":true,"dockerDesktopPath":"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe","dockerDesktopVersion":"4.34.0","inDockerUsers":true,"inDockerUsersGroup":true,"freeGib":412,"user":"radarsu","userQualified":"omen\\radarsu"}"#;

    #[test]
    fn every_field_the_probe_prints_lands_somewhere() {
        let facts = parse(REAL).expect("the probe's own output must parse");
        assert_eq!(facts.build, 22631);
        assert_eq!(facts.display_version, "23H2");
        assert_eq!(facts.product_name, "Windows 11 Pro");
        assert_eq!(facts.edition_id, "Professional");
        assert_eq!(facts.arch, Some(ARCH_X64));
        assert_eq!(facts.hypervisor_present, Some(true));
        assert_eq!(facts.virtualization_firmware, Some(false));
        assert_eq!(facts.slat, Some(true));
        assert_eq!(facts.vm_hint, "asus system product name");
        assert!(facts.service_vmcompute && facts.service_wsl);
        assert!(facts.wsl_status_ok);
        assert_eq!(facts.wsl_version, "WSL version: 2.2.4.0");
        assert!(!facts.reboot_pending);
        assert!(!facts.elevated);
        assert!(facts.winget);
        assert!(facts.docker_desktop_path.ends_with("Docker Desktop.exe"));
        assert_eq!(facts.docker_desktop_version, "4.34.0");
        assert!(facts.in_docker_users);
        assert!(
            facts.in_docker_users_group,
            "the roster is a second, separate fact and has to arrive as one"
        );
        assert_eq!(facts.free_gib, Some(412));
        assert_eq!(facts.user, "radarsu");
        assert_eq!(
            facts.user_qualified, "omen\\radarsu",
            "the group-membership spelling has to survive the round trip"
        );
    }

    /* A SECOND REAL MACHINE, AND THE ONE THAT PAID FOR THIS TEST. Windows 11 25H2, an i9-11900H, WSL 2.7 with a
     * distro running and Docker Desktop 4.82 working — captured verbatim from the probe, `\r\n` and all.
     *
     * Read the flags: `slat` false and `virtualizationFirmware` false on a machine that is, at that moment,
     * running Linux containers. That is what `Win32_Processor` says once Hyper-V owns the CPU. An earlier draft
     * of this module believed it, and told this PC its processor was too old for Docker.
     *
     * Note `productName` too: "Windows 10 Pro" on a Windows 11 machine. That registry value was never updated
     * for 11, which is why nothing here decides anything from it and the build number is the version of record. */
    const OMEN: &str = r#"{"winget":true,"productName":"Windows 10 Pro","freeGib":402,"inDockerUsers":true,"inDockerUsersGroup":true,"wslVersion":"WSL version: 2.7.11.0\r\nKernel version: 6.18.33.2-2\r\n","arch":9,"dockerDesktopVersion":"4.82.0","build":26200,"user":"radar","displayVersion":"25H2","rebootPending":false,"dockerDesktopPath":"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe","virtualizationFirmware":false,"userQualified":"radarsu-omen17\\radar","editionId":"Professional","wslStatus":"Default Distribution: archlinux\r\nDefault Version: 2\r\n","wslStatusOk":true,"hypervisorPresent":true,"slat":false,"serviceVmcompute":true,"vmHint":"hp omen by hp laptop 17-ck0xxx","serviceWsl":true,"elevated":false}"#;

    /// The regression that matters most: a working PC must never be told its hardware is unsupported.
    #[test]
    fn a_running_hypervisor_is_believed_over_the_cpu_flags_it_masks() {
        let mut facts = parse(OMEN).expect("a real machine's report must parse");
        facts.docker_cli = true;
        facts.docker_daemon = true;
        facts.docker_server_os = Some("linux".to_string());

        assert_eq!(facts.slat, Some(false), "the flag really does read false");
        assert_eq!(facts.virtualization_firmware, Some(false));
        assert_eq!(facts.hypervisor_present, Some(true), "and this is why");

        let found = requirements(&facts);
        assert!(
            found.is_empty(),
            "a PC already running Docker on WSL2 has nothing left to fix, got {:?}",
            found.iter().map(|r| r.id).collect::<Vec<_>>()
        );
    }

    /// Store-delivered WSL registers `WslService` and never creates `LxssManager`. Reading only the old name
    /// told this machine to switch WSL on and restart, while WSL was running a distro.
    #[test]
    fn modern_wsl_is_recognised_by_its_own_service_name() {
        let facts = parse(OMEN).expect("parses");
        assert!(facts.service_wsl);
        assert!(
            !requirements(&facts).iter().any(|r| r.id == "wsl-features"),
            "WSL 2.7 with a default distro is not WSL switched off"
        );
    }

    /// `$null` is how the probe spells "I could not tell", and it has to survive the parse as `None`.
    #[test]
    fn nulls_arrive_as_unknown_rather_than_false() {
        let json = r#"{"build":0,"arch":null,"hypervisorPresent":null,"virtualizationFirmware":null,"slat":null,"freeGib":null}"#;
        let facts = parse(json).expect("a machine that answered nothing still parses");
        assert_eq!(facts.hypervisor_present, None);
        assert_eq!(facts.virtualization_firmware, None);
        assert_eq!(facts.slat, None);
        assert_eq!(facts.free_gib, None);
        // And it must not be read as a broken PC.
        assert!(requirements(&facts)
            .iter()
            .all(|r| r.id != "virtualization"));
    }

    #[test]
    fn a_field_the_probe_did_not_print_defaults_instead_of_failing() {
        // Forward compatibility in the one direction that matters: an older binary on a newer probe, and an
        // older probe on a newer binary, both keep working rather than refusing to read the machine at all.
        let facts = parse(r#"{"build":19045,"somethingNew":"ignored"}"#).expect("parses");
        assert_eq!(facts.build, 19045);
        assert!(facts.user.is_empty());
    }

    #[test]
    fn utf16_noise_from_older_wsl_is_cleaned_up() {
        let json = "{\"wslVersion\":\"W\\u0000S\\u0000L\\u0000\",\"wslStatus\":\"  x  \"}";
        let facts = parse(json).expect("parses");
        assert_eq!(facts.wsl_version, "WSL");
        assert_eq!(facts.wsl_status, "x");
    }

    /* THE MACHINE THAT REPORTED THIS. Docker Desktop had just been installed — its own installer adds
     * whoever ran it to `docker-users` — so the ROSTER says yes and the login token, issued at sign-in
     * before any of that, says no. The probe has to carry both, because they are the difference between
     * "ask for administrator" and "sign out", and only one of those can possibly work here. */
    #[test]
    fn the_group_roster_and_the_login_token_are_reported_separately() {
        let json = r#"{"inDockerUsers":false,"inDockerUsersGroup":true,"user":"radar"}"#;
        let facts = parse(json).expect("parses");
        assert!(!facts.in_docker_users, "the token predates the membership");
        assert!(facts.in_docker_users_group, "the group itself has them");
    }

    /// Reading a local group takes no administrator, which is what makes it safe to ask in a probe that runs
    /// before consent. This pins that the probe READS `docker-users` and never writes to it.
    #[test]
    fn the_group_is_read_and_never_added_to() {
        assert!(
            PROBE.contains("net.exe localgroup docker-users"),
            "the roster has to actually be asked for"
        );
        assert!(
            !PROBE.contains("/add"),
            "the probe runs before consent - it must never change a group"
        );
    }

    #[test]
    fn junk_is_a_message_rather_than_a_panic() {
        assert!(parse("not json").is_err());
        assert!(parse("").is_err());
    }

    /* The probe is also a PowerShell script this repo ships inside a binary, and it is subject to the same
     * rule every .ps1 here is (desktop-app/src-tauri/src/scripts.rs): no byte above 0x7F. It travels as
     * UTF-16 through -EncodedCommand so the code page cannot reach it, but it is READ by people, and the one
     * habit that keeps this whole class of bug away is not typing the characters at all. */
    #[test]
    fn the_probe_is_ascii_and_asks_for_nothing_it_should_not() {
        assert!(
            PROBE.is_ascii(),
            "the probe must be ASCII, like every other PowerShell in this repo"
        );
        for mutating in [
            "Set-",
            "New-Item",
            "Remove-",
            "Start-Process",
            "Install-",
            "Enable-",
        ] {
            assert!(
                !PROBE.contains(mutating),
                "the probe runs before any consent is asked for, so it must only ever read - found {mutating}"
            );
        }
        // The one exception to the rule above, stated so it cannot creep: setting WSL_UTF8 on our own
        // process environment is not a change to the machine.
        assert!(PROBE.contains("$env:WSL_UTF8"));
    }
}
