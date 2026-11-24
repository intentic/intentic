// Each platform's half of this file is dead code on the other, and both halves are tested on every platform.
#![allow(dead_code)]

/* WHAT AN UNINSTALL TOUCHES OUTSIDE ic'S OWN HOME, platform by platform: the desktop app (its installer's own
uninstaller on Windows, its package or AppImage on Linux, and the per-user folders and entries it writes that no
package manager knows about), the PATH entries and links the install scripts made, and ic's own binary, which on
Windows cannot delete itself while it runs.

Every function here is best-effort and says what it could not do rather than stopping: an uninstall that stops halfway
leaves more behind than one that finishes and names its leftovers. */

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::docker;

/// The desktop app's identifier (tauri.conf.json `identifier`): the name of every per-user folder it writes.
pub const APP_ID: &str = "dev.intentic.desktop";

/// How the desktop app is installed here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppInstall {
    /// Its NSIS uninstaller, as the Windows uninstall entry names it.
    Windows { uninstaller: String },
    /// A deb or rpm, by package name.
    Package { manager: Packager, name: String },
    /// An AppImage the person downloaded, found through the deep-link handler it registered.
    AppImage(PathBuf),
    /// Only the folders and entries a run of the app left; the program itself is gone.
    LeftoversOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Packager {
    Dpkg,
    Rpm,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct App {
    pub install: AppInstall,
    pub version: Option<String>,
}

/// The app's processes: the window app and its file server. The NSIS hook ends the same two by name.
#[cfg(windows)]
const APP_PROCESSES: [&str; 2] = ["intentic-desktop.exe", "intentic-files.exe"];
/// Linux matches a process's 15-character `comm`, in which `intentic-desktop` is `intentic-deskto`.
#[cfg(not(windows))]
const APP_PROCESSES: [&str; 2] = ["intentic-deskto", "intentic-files"];

/// End the app, so neither its engine keeper nor its sandbox supervisor puts back what the uninstall removes.
pub fn stop_app() {
    for name in APP_PROCESSES {
        #[cfg(windows)]
        let _ = docker::run_bounded(
            "taskkill",
            &["/F", "/T", "/IM", name],
            Duration::from_secs(20),
        );
        #[cfg(not(windows))]
        let _ = docker::run_bounded("pkill", &["-x", name], Duration::from_secs(10));
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The folders and files the app writes for this user, wherever they are now. On Linux the XDG variables move them.
pub fn app_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    if cfg!(windows) {
        for base in [env_dir("APPDATA"), env_dir("LOCALAPPDATA")]
            .into_iter()
            .flatten()
        {
            files.push(base.join(APP_ID));
        }
        return files;
    }
    let Some(home) = home() else {
        return files;
    };
    let config = env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
    let data = env_dir("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share"));
    let cache = env_dir("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache"));
    files.push(config.join(APP_ID));
    files.push(data.join(APP_ID));
    files.push(cache.join(APP_ID));
    // The tray's "Start Intentic at login" (autostart.rs), and the intentic:// handler the deep-link plugin registers
    // at every launch: a removed package leaves both, and the handler would hand links to a program that is gone.
    files.push(config.join("autostart").join(format!("{APP_ID}.desktop")));
    files.push(handler_file(&data));
    files
}

fn handler_file(data: &Path) -> PathBuf {
    data.join("applications")
        .join("intentic-desktop-handler.desktop")
}

/// The program a `.desktop` file's `Exec=` line starts, unquoted. Pure.
pub fn exec_program(desktop_file: &str) -> Option<String> {
    let exec = desktop_file
        .lines()
        .find_map(|line| line.trim().strip_prefix("Exec="))?
        .trim();
    let program = if let Some(quoted) = exec.strip_prefix('"') {
        quoted.split('"').next()?
    } else {
        exec.split_whitespace().next()?
    };
    (!program.is_empty()).then(|| program.to_string())
}

/// `mimeapps.list` without the lines that hand `intentic://` to our handler. None when there was nothing to take out.
/// Pure.
pub fn without_our_handler(mimeapps: &str) -> Option<String> {
    let mut changed = false;
    let mut kept = Vec::new();
    for line in mimeapps.lines() {
        if line.trim_start().starts_with("x-scheme-handler/intentic=")
            && line.contains("intentic-desktop-handler.desktop")
        {
            changed = true;
            continue;
        }
        kept.push(line);
    }
    changed.then(|| {
        let mut text = kept.join("\n");
        if mimeapps.ends_with('\n') {
            text.push('\n');
        }
        text
    })
}

/// The desktop app, if any of it is here.
pub fn find_app() -> Option<App> {
    #[cfg(windows)]
    {
        let uninstaller = uninstall_entry("UninstallString")?;
        Some(App {
            install: AppInstall::Windows { uninstaller },
            version: uninstall_entry("DisplayVersion"),
        })
    }
    #[cfg(not(windows))]
    {
        find_linux_app()
    }
}

#[cfg(not(windows))]
fn find_linux_app() -> Option<App> {
    const INSTALLED: &str = "/usr/bin/intentic-desktop";
    if Path::new(INSTALLED).exists() {
        if let Some((manager, name)) = owning_package(INSTALLED) {
            return Some(App {
                version: package_version(manager, &name),
                install: AppInstall::Package { manager, name },
            });
        }
    }
    let data = env_dir("XDG_DATA_HOME")
        .or_else(|| home().map(|home| home.join(".local").join("share")))?;
    if let Some(program) = std::fs::read_to_string(handler_file(&data))
        .ok()
        .and_then(|text| exec_program(&text))
        .filter(|program| program.to_ascii_lowercase().ends_with(".appimage"))
        .map(PathBuf::from)
        .filter(|program| program.exists())
    {
        return Some(App {
            install: AppInstall::AppImage(program),
            version: None,
        });
    }
    app_files().iter().any(|path| path.exists()).then_some(App {
        install: AppInstall::LeftoversOnly,
        version: None,
    })
}

#[cfg(not(windows))]
fn owning_package(path: &str) -> Option<(Packager, String)> {
    let limit = Duration::from_secs(15);
    if let Ok(ran) = docker::run_bounded("dpkg", &["-S", path], limit) {
        if ran.code == Some(0) {
            // `intentic: /usr/bin/intentic-desktop`
            if let Some(name) = ran
                .stdout
                .lines()
                .next()
                .and_then(|line| line.split(':').next())
            {
                let name = name.trim();
                if !name.is_empty() {
                    return Some((Packager::Dpkg, name.to_string()));
                }
            }
        }
    }
    if let Ok(ran) = docker::run_bounded("rpm", &["-qf", "--qf", "%{NAME}", path], limit) {
        let name = ran.stdout.trim();
        if ran.code == Some(0) && !name.is_empty() {
            return Some((Packager::Rpm, name.to_string()));
        }
    }
    None
}

#[cfg(not(windows))]
fn package_version(manager: Packager, name: &str) -> Option<String> {
    let limit = Duration::from_secs(15);
    let ran = match manager {
        Packager::Dpkg => {
            docker::run_bounded("dpkg-query", &["-W", "-f", "${Version}", name], limit)
        }
        Packager::Rpm => docker::run_bounded("rpm", &["-q", "--qf", "%{VERSION}", name], limit),
    }
    .ok()?;
    let version = ran.stdout.trim();
    (ran.code == Some(0) && !version.is_empty()).then(|| version.to_string())
}

/// The command that removes the package, as a person would type it. Pure.
pub fn package_removal(manager: Packager, name: &str, root: bool) -> Vec<String> {
    let mut argv: Vec<String> = if root { vec![] } else { vec!["sudo".into()] };
    match manager {
        Packager::Dpkg => {
            argv.extend(["apt-get".into(), "remove".into(), "-y".into(), name.into()])
        }
        Packager::Rpm => argv.extend(["rpm".into(), "-e".into(), name.into()]),
    }
    argv
}

/// What removing the app came to.
pub enum AppRemoval {
    Done,
    /// Something a person finishes: the problem, and the command.
    Left {
        problem: String,
        fix: String,
    },
}

/// The app off this device: its program, then its per-user folders and entries.
pub fn remove_app(app: &App) -> AppRemoval {
    let outcome = match &app.install {
        AppInstall::Windows { uninstaller } => run_windows_uninstaller(uninstaller),
        AppInstall::Package { manager, name } => remove_package(*manager, name),
        AppInstall::AppImage(path) => match std::fs::remove_file(path) {
            Ok(()) => AppRemoval::Done,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppRemoval::Done,
            Err(error) => AppRemoval::Left {
                problem: format!("{} could not be deleted: {error}.", path.display()),
                fix: format!("rm {}", path.display()),
            },
        },
        AppInstall::LeftoversOnly => AppRemoval::Done,
    };
    let stuck = remove_app_files();
    match outcome {
        AppRemoval::Done if !stuck.is_empty() => AppRemoval::Left {
            problem: format!("{} could not be deleted.", stuck.join(", ")),
            fix: "close Intentic, then run ic uninstall again".to_string(),
        },
        other => other,
    }
}

/// The app's per-user folders and entries. Answers what could not be removed.
pub fn remove_app_files() -> Vec<String> {
    let mut stuck = Vec::new();
    for path in app_files() {
        if !remove_path(&path, 6) {
            stuck.push(path.display().to_string());
        }
    }
    #[cfg(not(windows))]
    unhand_intentic_links();
    #[cfg(windows)]
    forget_protocol_handler();
    stuck
}

/// Remove a file or a folder, trying again a few times: a WebView's helper processes outlive the app by a moment and
/// hold its files until they exit. True when it is gone.
pub fn remove_path(path: &Path, tries: u32) -> bool {
    for attempt in 0..tries.max(1) {
        let gone = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        match gone {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) if attempt + 1 < tries => std::thread::sleep(Duration::from_millis(500)),
            Err(_) => {}
        }
    }
    !path.exists()
}

#[cfg(not(windows))]
fn unhand_intentic_links() {
    let Some(home) = home() else {
        return;
    };
    let config = env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
    let data = env_dir("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share"));
    for list in [
        config.join("mimeapps.list"),
        data.join("applications").join("mimeapps.list"),
    ] {
        if let Some(text) = std::fs::read_to_string(&list)
            .ok()
            .and_then(|text| without_our_handler(&text))
        {
            let _ = std::fs::write(&list, text);
        }
    }
    let _ = docker::run_bounded(
        "update-desktop-database",
        &[&data.join("applications").to_string_lossy()],
        Duration::from_secs(15),
    );
}

#[cfg(not(windows))]
fn remove_package(manager: Packager, name: &str) -> AppRemoval {
    let root = docker::is_root();
    let argv = package_removal(manager, name, root);
    let shown = argv.join(" ");
    // Root is asked for at the step that needs it, and only where somebody is there to give it (cli-output-protocol.md).
    if !root && !crate::tty::have_tty() {
        return AppRemoval::Left {
            problem: format!("removing the {name} package needs an administrator, and nobody is at this terminal."),
            fix: shown,
        };
    }
    if !root {
        crate::ui::note(&format!("Removing the {name} package needs your password."));
    }
    crate::ui::suspend();
    let ran = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .status();
    crate::ui::resume();
    match ran {
        Ok(status) if status.success() => AppRemoval::Done,
        _ => AppRemoval::Left {
            problem: format!("the {name} package was not removed."),
            fix: shown,
        },
    }
}

#[cfg(windows)]
fn remove_package(_: Packager, _: &str) -> AppRemoval {
    AppRemoval::Done
}

#[cfg(not(windows))]
fn run_windows_uninstaller(_: &str) -> AppRemoval {
    AppRemoval::Done
}

/// One value of the app's uninstall entry, the one Tauri's installer writes (`HKCU\…\Uninstall\Intentic`).
#[cfg(windows)]
fn uninstall_entry(value: &str) -> Option<String> {
    let ran = docker::run_bounded(
        "reg",
        &["query", UNINSTALL_KEY, "/v", value],
        Duration::from_secs(15),
    )
    .ok()?;
    if ran.code != Some(0) {
        return None;
    }
    reg_value(&ran.stdout, value)
}

#[cfg(windows)]
const UNINSTALL_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Intentic";

/// A value out of `reg query`'s answer: `    <name>    REG_SZ    <data>`. Pure.
pub fn reg_value(output: &str, name: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.strip_prefix(name)?.trim_start();
        let (kind, data) = rest.split_once(char::is_whitespace)?;
        kind.starts_with("REG_")
            .then(|| data.trim().to_string())
            .filter(|data| !data.is_empty())
    })
}

/// The program and arguments an UninstallString names: `"C:\…\uninstall.exe"` or a bare path. Pure.
pub fn uninstaller_program(uninstall_string: &str) -> String {
    let trimmed = uninstall_string.trim();
    match trimmed.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(rest).to_string(),
        None => trimmed.to_string(),
    }
}

/// The app's own uninstaller, silent. NSIS copies itself to %TEMP% and starts that copy (an uninstaller cannot delete
/// the folder it runs from), so the program started here returns at once: the removal is waited for by watching the
/// uninstall entry go. `INTENTIC_UNINSTALL=done` tells its hook that this run already did the rest
/// (installer-hooks.nsh), so it does not call ic back. Never with `_?=`: an uninstaller run in place is how the hook
/// recognises the first half of a reinstall, which keeps the shortcuts and the start-at-login value.
#[cfg(windows)]
fn run_windows_uninstaller(uninstall_string: &str) -> AppRemoval {
    let program = uninstaller_program(uninstall_string);
    let left = |problem: String| AppRemoval::Left {
        problem,
        fix: "Settings, then Apps, then Intentic, then Uninstall".to_string(),
    };
    let started = std::process::Command::new(&program)
        .arg("/S")
        .env("INTENTIC_UNINSTALL", "done")
        .status();
    match started {
        Ok(status) if status.success() => {}
        Ok(status) => {
            return left(format!(
                "the Intentic app's uninstaller ended with {}.",
                status.code().unwrap_or(-1)
            ))
        }
        Err(error) => {
            return left(format!(
                "the Intentic app's uninstaller did not start: {error}."
            ))
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(240);
    while std::time::Instant::now() < deadline {
        if uninstall_entry("UninstallString").is_none() {
            return AppRemoval::Done;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    left("the Intentic app's uninstaller did not finish within 4 minutes.".to_string())
}

/// `HKCU\Software\Classes\intentic`, the intentic:// handler: the uninstaller removes it only while it still names the
/// app it installed, and one an older or a moved install wrote stays, starting a program that is gone.
#[cfg(windows)]
fn forget_protocol_handler() {
    let _ = docker::run_bounded(
        "reg",
        &["delete", r"HKCU\Software\Classes\intentic", "/f"],
        Duration::from_secs(15),
    );
}

/// The command-line links and PATH entries the install scripts and the agent's setup made, for the folders given.
/// POSIX: the `~/.local/bin` links that point into one of them. Windows: those folders' entries in the user's PATH,
/// matched whole, the rest of the value left as it was. Answers what was not done.
pub fn unlink_commands(dirs: &[PathBuf]) -> Option<String> {
    #[cfg(windows)]
    {
        remove_from_user_path(dirs)
    }
    #[cfg(not(windows))]
    {
        let home = home()?;
        let bin = home.join(".local").join("bin");
        for name in ["ic", "intentic-machine"] {
            let link = bin.join(name);
            let Ok(target) = std::fs::read_link(&link) else {
                continue;
            };
            if dirs.iter().any(|dir| target.starts_with(dir)) {
                let _ = std::fs::remove_file(&link);
            }
        }
        None
    }
}

/// The PowerShell edit the app's installer uses for its own `bin` (installer-hooks.nsh INTENTIC_CLI_PATH): the value is
/// read unexpanded and written back under the kind it had, so `%USERPROFILE%`-style entries keep expanding, and only
/// whole entries naming one of the folders go. The folders arrive by environment variable, so no character in a name
/// can end a quoted string. Then the broadcast, so a terminal started from Explorer sees the change.
#[cfg(windows)]
const PATH_DROP_PS: &str = r#"$ErrorActionPreference = 'Stop'
$drop = @($env:INTENTIC_PATH_DROP -split '\|' | Where-Object { $_ })
$k = Get-Item -LiteralPath 'HKCU:\Environment'
if ($k.GetValueNames() -contains 'Path') {
  $raw = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $e = @($raw -split ';')
  $keep = @($e | Where-Object { $entry = $_; $expanded = [Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\'); -not ($drop | Where-Object { $_.TrimEnd('\') -ieq $expanded }) })
  if ($keep.Count -ne $e.Count) {
    Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Type $k.GetValueKind('Path') -Value ($keep -join ';')
    $s = '[DllImport("user32.dll",CharSet=CharSet.Auto)]public static extern IntPtr SendMessageTimeout(IntPtr w,uint m,UIntPtr wp,string lp,uint f,uint t,out UIntPtr r);'
    Add-Type -Namespace Intentic -Name Native -MemberDefinition $s
    $r = [UIntPtr]::Zero
    [void][Intentic.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
  }
}"#;

#[cfg(windows)]
fn remove_from_user_path(dirs: &[PathBuf]) -> Option<String> {
    let joined: Vec<String> = dirs.iter().map(|dir| dir.display().to_string()).collect();
    let mut command = std::process::Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            PATH_DROP_PS,
        ])
        .env("INTENTIC_PATH_DROP", joined.join("|"));
    match docker::bounded(command, Duration::from_secs(90)) {
        Ok(ran) if ran.code == Some(0) => None,
        Ok(ran) => Some(format!(
            "your PATH still names {}: {}",
            joined.join(" and "),
            ran.stderr
                .lines()
                .next()
                .unwrap_or("PowerShell refused the change")
                .trim()
        )),
        Err(fail) => Some(format!(
            "your PATH still names {}: {}",
            joined.join(" and "),
            fail.0
        )),
    }
}

/// Delete ic's own binary. A running program cannot delete itself on Windows, but it can be moved aside on its
/// volume: it is renamed into %TEMP% and a detached `cmd` deletes it once this process has exited. POSIX unlinks it
/// as it runs. Answers what was not done.
pub fn remove_binary(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let running = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.canonicalize().ok())
        .zip(path.canonicalize().ok())
        .is_some_and(|(exe, target)| exe == target);
    if !running || !cfg!(windows) {
        return std::fs::remove_file(path)
            .err()
            .map(|error| format!("{} could not be deleted: {error}", path.display()));
    }
    #[cfg(windows)]
    {
        delete_after_exit(path)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn delete_after_exit(path: &Path) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let aside = std::env::temp_dir().join(format!("ic-uninstalled-{}.exe", std::process::id()));
    if let Err(error) = std::fs::rename(path, &aside) {
        return Some(format!("{} could not be deleted: {error}", path.display()));
    }
    // `ping` is the wait cmd has: three echoes are two seconds, by which this process has long exited.
    let script = format!(
        "ping -n 3 127.0.0.1 >nul & del /f /q \"{}\"",
        aside.display()
    );
    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.args(["/d", "/c", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    if let Some(root) = std::env::var_os("SystemRoot") {
        cmd.current_dir(root);
    }
    let _ = cmd.spawn();
    None
}

/// A directory removed only when nothing is left in it. True when it is gone.
pub fn remove_if_empty(dir: &Path) -> bool {
    match std::fs::remove_dir(dir) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_desktop_files_program_is_read_quoted_or_bare() {
        assert_eq!(
            exec_program("[Desktop Entry]\nExec=\"/home/a/Apps/Intentic 1.2.AppImage\" %u\n")
                .as_deref(),
            Some("/home/a/Apps/Intentic 1.2.AppImage")
        );
        assert_eq!(
            exec_program("Exec=/home/a/Intentic.AppImage %u").as_deref(),
            Some("/home/a/Intentic.AppImage")
        );
        assert_eq!(exec_program("Name=x"), None);
    }

    #[test]
    fn only_our_intentic_handler_leaves_mimeapps() {
        let list = "[Default Applications]\nx-scheme-handler/intentic=intentic-desktop-handler.desktop\ntext/html=firefox.desktop\n";
        assert_eq!(
            without_our_handler(list).as_deref(),
            Some("[Default Applications]\ntext/html=firefox.desktop\n")
        );
        assert_eq!(
            without_our_handler("x-scheme-handler/intentic=other.desktop\n"),
            None
        );
    }

    #[test]
    fn a_reg_query_value_is_read_off_its_line() {
        let output = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Intentic\r\n    UninstallString    REG_SZ    \"C:\\Users\\a\\AppData\\Local\\Intentic\\uninstall.exe\"\r\n\r\n";
        assert_eq!(
            reg_value(output, "UninstallString").as_deref(),
            Some("\"C:\\Users\\a\\AppData\\Local\\Intentic\\uninstall.exe\"")
        );
        assert_eq!(reg_value(output, "DisplayVersion"), None);
        assert_eq!(
            uninstaller_program("\"C:\\Users\\a\\AppData\\Local\\Intentic\\uninstall.exe\""),
            "C:\\Users\\a\\AppData\\Local\\Intentic\\uninstall.exe"
        );
    }

    #[test]
    fn the_package_removal_asks_for_root_only_when_it_has_to() {
        assert_eq!(
            package_removal(Packager::Dpkg, "intentic", false).join(" "),
            "sudo apt-get remove -y intentic"
        );
        assert_eq!(
            package_removal(Packager::Rpm, "intentic", true).join(" "),
            "rpm -e intentic"
        );
    }

    #[test]
    fn a_folder_that_is_gone_counts_as_removed() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("a");
        std::fs::create_dir_all(inner.join("b")).unwrap();
        std::fs::write(inner.join("b").join("c"), "x").unwrap();
        assert!(remove_path(&inner, 1));
        assert!(remove_path(&inner, 1));
        assert!(!inner.exists());
    }
}
