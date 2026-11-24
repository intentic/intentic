//! WHERE DOCKER DESKTOP FOR WINDOWS IS INSTALLED — one discovery, in two depths.
//!
//! Program Files is only the default. The installer takes a folder of its own, newer builds install per user under
//! `LOCALAPPDATA`, and a PC whose Docker was put somewhere else still has to be found rather than told it has no Docker
//! to start. [`LOCATE`] asks every way an install can answer (the registry, the uninstall entry, the CLI on PATH, the
//! Start-menu shortcuts) and costs a PowerShell start, so it is run where a flow asks once: `ic`'s probe of the PC, its
//! repairs, the desktop app's start, and any lookup from inside WSL. [`default_installs`] is its first list, the
//! folders an install lands in by default, which a plain file check answers in microseconds: what a path that runs on
//! every `docker` spawn can afford.
//!
//! Paths are cut by `\` rather than by `Path`, so the Windows spellings are asserted on the Linux runner that
//! cross-builds both binaries, and translated for WSL ([`wsl_path`]) rather than assumed to sit at `/mnt/c`.

/// The launcher's file name.
pub const EXE: &str = "Docker Desktop.exe";

/// The PowerShell that finds Docker Desktop: leaves its launcher's full path in `$dd` (empty when there is none) and
/// the version its uninstall entry records in `$ddVer`. A fragment, so `ic`'s probe of the PC embeds it and
/// [`locate_script`] prints it. ASCII and PowerShell 5.1, for the reasons `ic`'s `prepare/shell.rs` gives.
pub const LOCATE: &str = r#"
$ddCandidates = @()
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
  if ($base) { $ddCandidates += (Join-Path $base 'Docker\Docker\Docker Desktop.exe') }
}
# A per-user install (Docker Desktop 4.72+, the installer's default since 4.83, and what Intentic's setup installs).
if ($env:LOCALAPPDATA) { $ddCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe') }
foreach ($key in @('HKLM:\SOFTWARE\Docker Inc.\Docker\1.0', 'HKCU:\SOFTWARE\Docker Inc.\Docker\1.0')) {
  $app = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).AppPath
  if ($app) { $ddCandidates += (Join-Path $app 'Docker Desktop.exe') }
}
$ddVer = ''
foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop')) {
  $uninstall = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if ($uninstall) {
    if (($ddVer -eq '') -and $uninstall.DisplayVersion) { $ddVer = [string]$uninstall.DisplayVersion }
    if ($uninstall.InstallLocation) { $ddCandidates += (Join-Path $uninstall.InstallLocation 'Docker Desktop.exe') }
    if ($uninstall.DisplayIcon) { $ddCandidates += ([string]$uninstall.DisplayIcon -replace ',-?\d+$', '').Trim('"') }
  }
}
# The docker CLI ships inside the app: <app>\resources\bin\docker.exe, so a docker on PATH names its own app.
$cli = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($cli -and $cli.Source) {
  $ddCandidates += (Join-Path (Split-Path (Split-Path (Split-Path $cli.Source -Parent) -Parent) -Parent) 'Docker Desktop.exe')
}
# The shortcuts Docker's installer leaves, read for the app they point at.
foreach ($lnk in @(
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Docker Desktop.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Docker Desktop.lnk'),
  (Join-Path $env:PUBLIC 'Desktop\Docker Desktop.lnk'))) {
  if (Test-Path $lnk) {
    try { $ddCandidates += (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath } catch { }
  }
}
$dd = ''
foreach ($candidate in $ddCandidates) {
  if (($dd -eq '') -and $candidate -and ($candidate -like '*Docker Desktop.exe') -and (Test-Path $candidate)) { $dd = $candidate }
}
"#;

/// [`LOCATE`] as a script of its own, printing the launcher's path (nothing when there is none). Read its output with
/// [`located`].
pub fn locate_script() -> String {
    format!("$ProgressPreference = 'SilentlyContinue'\n{LOCATE}\nWrite-Output $dd\n")
}

/// The path [`locate_script`] printed, or None when it found nothing. The last line naming the launcher, so a stray
/// line a profile or a warning printed ahead of it is not taken for the answer.
pub fn located(stdout: &str) -> Option<String> {
    stdout
        .replace('\0', "")
        .lines()
        .map(|line| line.trim().trim_matches('"'))
        .rfind(|line| is_launcher(line))
        .map(str::to_string)
}

/// Whether a Windows path names the launcher itself.
fn is_launcher(path: &str) -> bool {
    path.rsplit_once('\\')
        .is_some_and(|(dir, leaf)| !dir.is_empty() && leaf.eq_ignore_ascii_case(EXE))
}

/// Where a default install puts the launcher, in the order worth trying: [`LOCATE`]'s first list. Each base is the
/// Windows variable of that name (`ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA`); an unset or empty one is
/// skipped.
pub fn default_installs(
    program_files: Option<&str>,
    program_files_x86: Option<&str>,
    local_app_data: Option<&str>,
) -> Vec<String> {
    let local_programs = local_app_data
        .filter(|base| !base.is_empty())
        .map(|base| format!("{}\\Programs", base.trim_end_matches('\\')));
    let per_user = local_programs
        .as_ref()
        .map(|programs| format!("{programs}\\DockerDesktop\\{EXE}"));
    [
        program_files.map(str::to_string),
        program_files_x86.map(str::to_string),
        local_app_data.map(str::to_string),
        local_programs,
    ]
    .into_iter()
    .flatten()
    .filter(|base| !base.is_empty())
    .map(|base| format!("{}\\Docker\\Docker\\{EXE}", base.trim_end_matches('\\')))
    .chain(per_user)
    .collect()
}

/// [`default_installs`] from this process's own environment. Empty off Windows, where none of the three is set.
pub fn default_installs_here() -> Vec<String> {
    let var = |name: &str| std::env::var(name).ok();
    default_installs(
        var("ProgramFiles").as_deref(),
        var("ProgramFiles(x86)").as_deref(),
        var("LOCALAPPDATA").as_deref(),
    )
}

/// The launcher beside the CLI that shipped inside it — `<app>\resources\bin\docker.exe` — which is how an install in a
/// folder nobody guessed still gets found.
pub fn app_beside_cli(cli: &str) -> Option<String> {
    let (app, leaf) = cli.rsplit_once("\\resources\\bin\\")?;
    leaf.eq_ignore_ascii_case("docker.exe")
        .then(|| format!("{app}\\{EXE}"))
}

/// The folder of the CLI Docker Desktop ships inside itself, beside its launcher: `<app>\resources\bin`.
pub fn cli_folder_beside(app: &str) -> Option<String> {
    let (dir, leaf) = app.rsplit_once('\\')?;
    (!dir.is_empty() && leaf.eq_ignore_ascii_case(EXE)).then(|| format!("{dir}\\resources\\bin"))
}

/// That CLI itself: `<app>\resources\bin\docker.exe`, the inverse of [`app_beside_cli`].
pub fn cli_beside(app: &str) -> Option<String> {
    cli_folder_beside(app).map(|dir| format!("{dir}\\docker.exe"))
}

/// The folder the launcher sits in, where Docker Desktop's other tools (`DockerCli.exe`) live too.
pub fn app_folder(app: &str) -> Option<String> {
    let (dir, _) = app.rsplit_once('\\')?;
    (!dir.is_empty()).then(|| dir.to_string())
}

/// Where WSL mounts the Windows drives, from `/etc/wsl.conf`'s `[automount] root`; `/mnt/` when it says nothing.
/// Always ends in `/`.
pub fn wsl_mount_root(wsl_conf: &str) -> String {
    let mut section = String::new();
    for line in wsl_conf.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            section = name.trim().to_ascii_lowercase();
            continue;
        }
        if section != "automount" {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if key.trim().eq_ignore_ascii_case("root") {
                let root = value.trim().trim_matches('"').trim_matches('\'');
                if !root.is_empty() {
                    return format!("{}/", root.trim_end_matches('/'));
                }
            }
        }
    }
    "/mnt/".to_string()
}

/// A Windows drive path as a WSL distro reaches it: `C:\Program Files\x` under `/mnt/` is `/mnt/c/Program Files/x`.
/// None for anything that is not on a drive letter (a UNC share, a relative path), which no mount spells.
pub fn wsl_path(windows: &str, mount_root: &str) -> Option<String> {
    let mut chars = windows.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    if chars.next() != Some(':') {
        return None;
    }
    let rest = chars.as_str();
    if !(rest.is_empty() || rest.starts_with('\\') || rest.starts_with('/')) {
        return None;
    }
    let rest = rest.replace('\\', "/");
    let rest = rest.trim_start_matches('/');
    Some(format!(
        "{}/{}{}{rest}",
        mount_root.trim_end_matches('/'),
        drive.to_ascii_lowercase(),
        if rest.is_empty() { "" } else { "/" }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_installs_are_the_probes_first_list_in_its_order() {
        assert_eq!(
            default_installs(
                Some(r"C:\Program Files"),
                Some(r"C:\Program Files (x86)"),
                Some(r"C:\Users\radar\AppData\Local")
            ),
            vec![
                r"C:\Program Files\Docker\Docker\Docker Desktop.exe",
                r"C:\Program Files (x86)\Docker\Docker\Docker Desktop.exe",
                r"C:\Users\radar\AppData\Local\Docker\Docker\Docker Desktop.exe",
                r"C:\Users\radar\AppData\Local\Programs\Docker\Docker\Docker Desktop.exe",
                r"C:\Users\radar\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe",
            ]
        );
        assert!(
            LOCATE.contains(r"Programs\DockerDesktop\Docker Desktop.exe"),
            "the probe must find the per-user install the cheap half finds"
        );
        // Every one of them is also in the probe's own list, so the cheap half can never find what the probe misses.
        for base in [
            "$env:ProgramFiles",
            "${env:ProgramFiles(x86)}",
            "$env:LOCALAPPDATA",
            "(Join-Path $env:LOCALAPPDATA 'Programs')",
        ] {
            assert!(LOCATE.contains(base), "the probe lost {base}");
        }
    }

    #[test]
    fn an_unset_or_empty_base_is_skipped_and_a_trailing_separator_is_not_doubled() {
        assert_eq!(
            default_installs(None, Some(""), Some("D:\\Local\\")),
            vec![
                r"D:\Local\Docker\Docker\Docker Desktop.exe",
                r"D:\Local\Programs\Docker\Docker\Docker Desktop.exe",
                r"D:\Local\Programs\DockerDesktop\Docker Desktop.exe",
            ]
        );
        assert_eq!(default_installs(None, None, None), Vec::<String>::new());
    }

    #[test]
    fn the_app_and_its_cli_name_each_other() {
        let app = r"D:\Tools\Docker\Docker Desktop.exe";
        let cli = r"D:\Tools\Docker\resources\bin\docker.exe";
        assert_eq!(cli_beside(app).as_deref(), Some(cli));
        assert_eq!(app_beside_cli(cli).as_deref(), Some(app));
        assert_eq!(
            cli_folder_beside(app).as_deref(),
            Some(r"D:\Tools\Docker\resources\bin")
        );
        assert_eq!(app_folder(app).as_deref(), Some(r"D:\Tools\Docker"));
        // Case as Windows spells it is not case as it matters.
        assert_eq!(
            app_beside_cli(r"C:\Docker\resources\bin\DOCKER.EXE").as_deref(),
            Some(r"C:\Docker\Docker Desktop.exe")
        );
        // A docker that did not ship inside Docker Desktop names no app.
        assert_eq!(
            app_beside_cli(r"C:\ProgramData\chocolatey\bin\docker.exe"),
            None
        );
        assert_eq!(
            cli_beside(r"C:\Program Files\Docker\Docker\Other.exe"),
            None
        );
        assert_eq!(app_folder(""), None);
    }

    #[test]
    fn the_located_path_is_the_last_line_naming_the_launcher() {
        assert_eq!(
            located("\r\nC:\\Users\\radar\\AppData\\Local\\Docker\\Docker\\Docker Desktop.exe\r\n")
                .as_deref(),
            Some(r"C:\Users\radar\AppData\Local\Docker\Docker\Docker Desktop.exe")
        );
        assert_eq!(
            located("WARNING: something a profile said\nD:\\Docker\\Docker Desktop.exe\n")
                .as_deref(),
            Some(r"D:\Docker\Docker Desktop.exe")
        );
        // Nothing found prints an empty line, and an older WSL's UTF-16 arrives with NULs through it.
        assert_eq!(located("\r\n"), None);
        assert_eq!(located(""), None);
        assert_eq!(
            located("C\0:\0\\\0D\0\\\0Docker Desktop.exe\0").as_deref(),
            Some(r"C:\D\Docker Desktop.exe")
        );
    }

    #[test]
    fn the_script_prints_what_the_fragment_found() {
        let script = locate_script();
        assert!(script.contains(LOCATE));
        assert!(script.trim_end().ends_with("Write-Output $dd"));
        assert!(
            script.is_ascii(),
            "PowerShell 5.1 reads a script in the ANSI code page"
        );
    }

    #[test]
    fn a_windows_path_is_translated_for_wsl_rather_than_assumed() {
        assert_eq!(
            wsl_path(
                r"C:\Program Files\Docker\Docker\Docker Desktop.exe",
                "/mnt/"
            )
            .as_deref(),
            Some("/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe")
        );
        // The per-user install, the one a hard-coded /mnt/c/Program Files read as not installed.
        assert_eq!(
            wsl_path(
                r"C:\Users\radar\AppData\Local\Docker\Docker\Docker Desktop.exe",
                "/mnt/"
            )
            .as_deref(),
            Some("/mnt/c/Users/radar/AppData/Local/Docker/Docker/Docker Desktop.exe")
        );
        // Another drive, another mount root, either separator.
        assert_eq!(
            wsl_path(r"D:\Apps\Docker\Docker Desktop.exe", "/win").as_deref(),
            Some("/win/d/Apps/Docker/Docker Desktop.exe")
        );
        assert_eq!(wsl_path("E:/x", "/").as_deref(), Some("/e/x"));
        assert_eq!(wsl_path("c:", "/mnt/").as_deref(), Some("/mnt/c"));
        // Nothing a mount spells.
        assert_eq!(wsl_path(r"\\wsl.localhost\archlinux\home", "/mnt/"), None);
        assert_eq!(wsl_path(r"Docker\Docker Desktop.exe", "/mnt/"), None);
        assert_eq!(wsl_path("C:relative", "/mnt/"), None);
        assert_eq!(wsl_path("", "/mnt/"), None);
    }

    #[test]
    fn the_mount_root_is_read_from_wsl_conf() {
        assert_eq!(wsl_mount_root(""), "/mnt/");
        assert_eq!(
            wsl_mount_root("[boot]\nsystemd=true\n[automount]\nenabled = true\nroot = /win\n"),
            "/win/"
        );
        assert_eq!(wsl_mount_root("[automount]\nroot = \"/\" # top\n"), "/");
        // A `root` under another section is not the mount's.
        assert_eq!(wsl_mount_root("[network]\nroot = /nope\n"), "/mnt/");
    }
}
