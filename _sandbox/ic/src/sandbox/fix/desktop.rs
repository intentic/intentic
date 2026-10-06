use std::path::Path;
use std::time::{Duration, Instant};

use super::host::{DeviceFacts, Os};
use crate::docker::{self, Engine};

/* DOCKER DESKTOP, WSL AND THE ENGINE, PUT RIGHT — per OS, every command bounded. The Windows recoveries are the ones the
CI fleet proved on real machines (_tools/scripts/ci/setup-wsl-fleet.ps1): an engine that answers 500 after
`wsl --shutdown` gets every Docker Desktop process stopped and the app started again, and WSL itself is only ever shut
down with Docker Desktop stopped first. */

/// What a repair left behind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    /// In effect now.
    Now,
    /// Windows has to restart before it takes effect. Made only by the Windows repairs (`applied`).
    #[cfg_attr(not(windows), allow(dead_code))]
    AfterRestart,
    /// Only the next sign-in picks it up.
    #[cfg_attr(not(windows), allow(dead_code))]
    AfterSignOut,
}

pub type Done = std::result::Result<Applied, String>;

/// A first start creates Docker Desktop's VM and unpacks its engine: minutes on a laptop.
const START_WAIT: Duration = Duration::from_secs(300);
/// A restart of an app that has run here before.
const RESTART_WAIT: Duration = Duration::from_secs(240);

pub fn start(facts: &DeviceFacts) -> Done {
    launch(facts)?;
    wait_engine(START_WAIT)
}

fn launch(facts: &DeviceFacts) -> std::result::Result<(), String> {
    match facts.os {
        Os::Windows => windows_launch(facts),
        // `start` detaches it from this shell; run from a Windows folder, or cmd complains about the UNC path. The
        // launcher is wherever the shared discovery found it on the Windows side, not where a default install puts it.
        Os::Wsl => {
            let exe = super::host::windows_desktop_exe(Os::Wsl).ok_or_else(|| {
                "Docker Desktop could not be found on the Windows side of this PC.".to_string()
            })?;
            run_in(
                "cmd.exe",
                &["/c", "start", "", &exe],
                Some("/mnt/c"),
                Duration::from_secs(30),
            )
        }
        Os::Macos => run("open", &["-a", "Docker"], Duration::from_secs(30)),
        Os::Linux => run(
            "systemctl",
            &["--user", "start", "docker-desktop"],
            Duration::from_secs(60),
        ),
    }
}

#[cfg(windows)]
fn windows_facts(facts: &DeviceFacts) -> crate::prepare::plan::Facts {
    facts
        .windows
        .as_ref()
        .and_then(|found| found.as_ref().ok())
        .cloned()
        .unwrap_or_default()
}

#[cfg(windows)]
fn windows_launch(facts: &DeviceFacts) -> std::result::Result<(), String> {
    crate::prepare::fix::start_docker_desktop(&windows_facts(facts))
        .map(|_| ())
        .map_err(trouble)
}

#[cfg(not(windows))]
fn windows_launch(_facts: &DeviceFacts) -> std::result::Result<(), String> {
    Err("Docker Desktop for Windows is started from Windows.".to_string())
}

#[cfg(windows)]
fn trouble(trouble: crate::prepare::fix::Trouble) -> String {
    match trouble {
        crate::prepare::fix::Trouble::Cancelled => {
            "Windows asked for permission and the prompt was closed, so nothing was changed."
                .to_string()
        }
        crate::prepare::fix::Trouble::Failed(why) => why,
    }
}

#[cfg(windows)]
fn applied(done: crate::prepare::fix::Fixed) -> Done {
    match done {
        Ok(crate::prepare::fix::Done::Now) => Ok(Applied::Now),
        Ok(crate::prepare::fix::Done::AfterRestart) => Ok(Applied::AfterRestart),
        Ok(crate::prepare::fix::Done::AfterSignOut) => Ok(Applied::AfterSignOut),
        Err(why) => Err(trouble(why)),
    }
}

/// Every Docker Desktop process, and any docker CLI left hanging on a dead engine for half an hour (age-guarded, so
/// a `docker` a person is running is never in scope). The fleet's list, verbatim.
const STOP_DESKTOP: &str = "\
$names = @('Docker Desktop', 'com.docker.backend', 'com.docker.build', 'com.docker.dev-envs', 'com.docker.extensions')\n\
Get-Process -Name $names -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue\n\
$strays = @(Get-Process -Name 'docker' -ErrorAction SilentlyContinue | Where-Object { try { $_.StartTime -lt (Get-Date).AddMinutes(-30) } catch { $false } })\n\
if ($strays.Count -gt 0) { $strays | Stop-Process -Force -ErrorAction SilentlyContinue }\n\
exit 0\n";

fn stop(os: Os) -> std::result::Result<(), String> {
    match os {
        Os::Windows | Os::Wsl => powershell(os, STOP_DESKTOP, Duration::from_secs(60)),
        Os::Macos => {
            let _ = run(
                "osascript",
                &["-e", "quit app \"Docker\""],
                Duration::from_secs(30),
            );
            std::thread::sleep(Duration::from_secs(5));
            let _ = run(
                "pkill",
                &["-f", "com.docker.backend"],
                Duration::from_secs(10),
            );
            Ok(())
        }
        Os::Linux => run(
            "systemctl",
            &["--user", "stop", "docker-desktop"],
            Duration::from_secs(120),
        ),
    }
}

/// Up but not answering gets a restart, not more waiting: stop everything of Docker Desktop's, give it a moment, start
/// it, and wait for the engine.
pub fn restart(facts: &DeviceFacts) -> Done {
    stop(facts.os)?;
    std::thread::sleep(Duration::from_secs(8));
    launch(facts)?;
    wait_engine(RESTART_WAIT)
}

/// Windows' last resort: Docker Desktop stopped FIRST (a `wsl --shutdown` under a running Docker Desktop is what
/// wedges it), WSL shut down, Docker Desktop started. Never offered from inside WSL, where it would end this run too.
pub fn shutdown_wsl(facts: &DeviceFacts) -> Done {
    if facts.os != Os::Windows {
        return Err("WSL is restarted from Windows.".to_string());
    }
    stop(facts.os)?;
    std::thread::sleep(Duration::from_secs(3));
    run("wsl.exe", &["--shutdown"], Duration::from_secs(120))?;
    std::thread::sleep(Duration::from_secs(5));
    launch(facts)?;
    wait_engine(START_WAIT)
}

/// Inside WSL: `docker desktop restart` from the Windows side re-applies an integration that is switched on and merely
/// absent (the fleet's section 3b). It cannot switch on one that is off.
pub fn reapply_integration() -> Done {
    let cli = "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe";
    if !Path::new(cli).exists() {
        return Err(format!("Docker Desktop's own docker.exe is not at {cli}."));
    }
    run_in(
        cli,
        &["desktop", "restart"],
        Some("/mnt/c"),
        Duration::from_secs(180),
    )?;
    wait_engine(RESTART_WAIT)
}

pub fn linux_containers(facts: &DeviceFacts) -> Done {
    #[cfg(windows)]
    {
        applied(crate::prepare::fix::switch_to_linux_containers(
            &windows_facts(facts),
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = facts;
        Err("switching container modes is Docker Desktop for Windows' own.".to_string())
    }
}

/// One of `ic docker prepare`'s elevated fixes. Each asks Windows for permission itself.
pub fn prerequisite(facts: &DeviceFacts, id: &str) -> Done {
    #[cfg(windows)]
    {
        match id {
            "wsl-features" => applied(crate::prepare::fix::enable_wsl_features()),
            "wsl-kernel" => applied(crate::prepare::fix::update_wsl_kernel()),
            "docker-users" => applied(crate::prepare::fix::add_to_docker_users(&windows_facts(
                facts,
            ))),
            other => Err(format!("no fix for the prerequisite '{other}'.")),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = facts;
        Err(format!("the prerequisite '{id}' is fixed from Windows."))
    }
}

/// Linux Docker Engine under systemd. `sudo` asks for its password on the terminal itself when it needs one.
pub fn start_engine() -> Done {
    #[cfg(unix)]
    let root = docker::is_root();
    #[cfg(not(unix))]
    let root = false;
    if root {
        run("systemctl", &["start", "docker"], Duration::from_secs(120))?;
    } else {
        run(
            "sudo",
            &["systemctl", "start", "docker"],
            Duration::from_secs(120),
        )?;
    }
    wait_engine(Duration::from_secs(60))
}

/// Docker Desktop's own start-at-sign-in, switched on where it keeps it.
pub fn enable_autostart(facts: &DeviceFacts) -> Done {
    let dir = match facts.os {
        Os::Windows => std::env::var("APPDATA")
            .ok()
            .map(|dir| Path::new(&dir).join("Docker")),
        Os::Macos => std::env::var("HOME")
            .ok()
            .map(|home| Path::new(&home).join("Library/Group Containers/group.com.docker")),
        Os::Linux => {
            run(
                "systemctl",
                &["--user", "enable", "docker-desktop"],
                Duration::from_secs(30),
            )?;
            return Ok(Applied::Now);
        }
        Os::Wsl => None,
    };
    let Some(dir) = dir else {
        return Err("Docker Desktop's settings could not be found from here.".to_string());
    };
    for name in ["settings-store.json", "settings.json"] {
        let path = dir.join(name);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(changed) = with_autostart(&text) else {
            return Err(format!(
                "{} is not the settings file ic expected.",
                path.display()
            ));
        };
        write_beside(&path, &changed)?;
        return Ok(Applied::Now);
    }
    Err(format!(
        "Docker Desktop has not written its settings in {} yet: open it once, then try again.",
        dir.display()
    ))
}

/// The settings text with start-at-sign-in on: `AutoStart` in the current file, `autoStart` in the older one, every
/// other setting as it was. None when the text is not a JSON object. Pure.
pub fn with_autostart(text: &str) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = value.as_object_mut()?;
    let key = if object.contains_key("autoStart") && !object.contains_key("AutoStart") {
        "autoStart"
    } else {
        "AutoStart"
    };
    object.insert(key.to_string(), serde_json::Value::Bool(true));
    serde_json::to_string_pretty(&value).ok()
}

/// Temp-then-rename, like every file ic writes: Docker Desktop reading it mid-write must see one whole file.
fn write_beside(path: &Path, text: &str) -> std::result::Result<(), String> {
    use std::io::Write;
    let dir = path.parent().ok_or("no folder to write in")?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|err| err.to_string())?;
    tmp.write_all(text.as_bytes())
        .map_err(|err| err.to_string())?;
    tmp.persist(path).map_err(|err| err.error.to_string())?;
    Ok(())
}

/// Wait for the engine, saying so as it goes: the one place in a fix where patience is the repair. An engine that
/// answers with a refusal has come up too; what refuses is the docker check's to name.
pub fn wait_engine(limit: Duration) -> Done {
    let started = Instant::now();
    let mut said = Instant::now();
    let mut hinted = false;
    loop {
        match docker::engine(super::host::ENGINE_ASK) {
            Engine::Up(_) | Engine::Denied(_) => return Ok(Applied::Now),
            _ if started.elapsed() >= limit => {
                return Err(format!(
                    "Docker's engine has not come up after {} minutes.",
                    limit.as_secs() / 60
                ))
            }
            _ => {}
        }
        if !hinted && started.elapsed() >= Duration::from_secs(75) {
            hinted = true;
            crate::ui::progress(
                "Docker Desktop may be asking you something: look at its window for a welcome, sign-in or update screen",
            );
        }
        if said.elapsed() >= Duration::from_secs(20) {
            said = Instant::now();
            let left = limit.saturating_sub(started.elapsed()).as_secs();
            crate::ui::progress(&format!(
                "still waiting for Docker's engine ({left}s before giving up)"
            ));
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

fn run(program: &str, args: &[&str], limit: Duration) -> std::result::Result<(), String> {
    run_in(program, args, None, limit)
}

fn run_in(
    program: &str,
    args: &[&str],
    dir: Option<&str>,
    limit: Duration,
) -> std::result::Result<(), String> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    if let Some(dir) = dir.filter(|dir| Path::new(dir).exists()) {
        command.current_dir(dir);
    }
    let ran = docker::bounded(command, limit).map_err(|err| err.0)?;
    if ran.timed_out {
        return Err(format!(
            "{program} did not finish within {} seconds.",
            limit.as_secs()
        ));
    }
    if ran.code != Some(0) {
        let said = if ran.stderr.trim().is_empty() {
            ran.stdout.trim().to_string()
        } else {
            ran.stderr.trim().to_string()
        };
        return Err(format!(
            "{program} {} failed{}",
            args.join(" "),
            if said.is_empty() {
                String::new()
            } else {
                format!(": {said}")
            }
        ));
    }
    Ok(())
}

/// A PowerShell script, as the encoded command every script in this binary is run as (prepare/shell.rs), with a
/// deadline. The same on Windows and, through interop, from inside WSL.
fn powershell(os: Os, script: &str, limit: Duration) -> std::result::Result<(), String> {
    let encoded = crate::prepare::shell::encoded(&format!(
        "$ProgressPreference = 'SilentlyContinue'\n$ErrorActionPreference = 'Continue'\n{script}"
    ));
    run_in(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ],
        (os == Os::Wsl).then_some("/mnt/c"),
        limit,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_is_switched_on_under_the_key_the_file_already_uses() {
        let current =
            with_autostart(r#"{"AutoStart": false, "MemoryMiB": 8192}"#).expect("an object");
        let value: serde_json::Value = serde_json::from_str(&current).expect("json");
        assert_eq!(value["AutoStart"], true);
        assert_eq!(value["MemoryMiB"], 8192, "every other setting stays");
        let older = with_autostart(r#"{"autoStart": false}"#).expect("an object");
        let value: serde_json::Value = serde_json::from_str(&older).expect("json");
        assert_eq!(value["autoStart"], true);
        assert_eq!(value.get("AutoStart"), None);
        assert_eq!(with_autostart("[1, 2]"), None);
    }

    /* The script ships inside this binary and runs on a user's Windows. */
    #[test]
    fn the_stop_script_stops_docker_desktop_and_only_old_docker_clis() {
        assert!(STOP_DESKTOP.is_ascii());
        for process in [
            "'Docker Desktop'",
            "'com.docker.backend'",
            "'com.docker.build'",
        ] {
            assert!(STOP_DESKTOP.contains(process), "{process}");
        }
        assert!(
            STOP_DESKTOP.contains("AddMinutes(-30)"),
            "a docker a person is running right now must never be in scope"
        );
        assert!(
            !STOP_DESKTOP.contains("wsl"),
            "stopping the app never touches WSL itself"
        );
    }
}
