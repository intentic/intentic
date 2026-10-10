// See plan.rs's header: these bodies only compile into the Windows binary; the constants they are built from
// are asserted on every runner.
#![cfg_attr(not(windows), allow(dead_code))]

use std::time::Duration;
#[cfg(windows)]
use std::time::Instant;

#[cfg(windows)]
use super::plan::Facts;
#[cfg(windows)]
use super::shell;

/* DOING SOMETHING ABOUT IT — one function per requirement, each one honest about what it achieved. */

/// What a fix actually accomplished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Done {
    /// In effect now; carry on.
    Now,
    /// Windows has to restart before it takes effect.
    AfterRestart,
    /// Only the next sign-in picks it up.
    AfterSignOut,
}

/// Why a fix did not happen. Cancelled is not a failure — it is an answer, and it gets its own sentence.
#[derive(Debug, Clone)]
pub enum Trouble {
    /// The administrator prompt was dismissed.
    Cancelled,
    /// The administrator prompt closed itself, twice, with nobody answering it.
    Unanswered,
    Failed(String),
}

pub type Fixed = Result<Done, Trouble>;

/// Docker's stable download for the current release. Docker publishes here permanently; it is what
/// `docs.docker.com` links to, and it is the route for every PC without the Windows package manager.
const INSTALLER_URL: &str =
    "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";

/// How long Docker Desktop gets to bring its engine up. A FIRST start creates the WSL2 distro, unpacks the
/// engine and starts a VM, and three minutes is normal on a laptop; the old shim allowed five and it was the
/// right call. Narrated throughout, because a silent five minutes is indistinguishable from a hang.
const DAEMON_TIMEOUT: Duration = Duration::from_secs(300);

#[cfg(windows)]
fn from_exit(output: &shell::Output, what: &str, on_success: Done) -> Fixed {
    if output.code == shell::CANCELLED {
        return Err(Trouble::Cancelled);
    }
    if output.code == shell::UNANSWERED {
        return Err(Trouble::Unanswered);
    }
    if output.ok {
        return Ok(on_success);
    }
    // The elevated child's transcript is in stdout (shell::run_elevated_watched), and its last few lines are the ones
    // that say why. The whole thing can be pages of dism progress.
    let tail: Vec<&str> = output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let tail = tail
        .iter()
        .rev()
        .take(4)
        .rev()
        .copied()
        .collect::<Vec<&str>>()
        .join("\n         ");
    // The sentence is for the row on the screen; Windows' own last words go to the log, where somebody
    // reading a transcript can find them under it.
    if !tail.is_empty() {
        crate::ui::note(&format!("Windows reported:\n         {tail}"));
    }
    Err(Trouble::Failed(format!(
        "{what} did not finish (Windows reported code {}). The log below has what Windows said; trying again often works.",
        output.code
    )))
}

/* `wsl --install --no-distribution` is the modern one-liner for all three, and `--no-distribution` matters: without it Windows also installs Ubuntu. */
const ENABLE_WSL: &str = "\
wsl.exe --install --no-distribution *>> $Log\n\
if ($LASTEXITCODE -eq 0) { exit 0 }\n\
Add-Content -Path $Log -Value \"wsl --install exited $LASTEXITCODE - falling back to dism\"\n\
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart *>> $Log\n\
$a = $LASTEXITCODE\n\
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart *>> $Log\n\
$b = $LASTEXITCODE\n\
# dism's 3010 is success-with-restart-required, which is exactly what we expect here.\n\
if (($a -eq 0 -or $a -eq 3010) -and ($b -eq 0 -or $b -eq 3010)) { exit 0 }\n\
exit 1\n";

#[cfg(windows)]
pub fn install_intentic_engine() -> Fixed {
    let mut progress = |sentence: &str, _percent: Option<u64>| super::progress(sentence);
    // `ic docker prepare` installs the engine only where it chose it: this PC's sandboxes run on it.
    crate::engine::install(&mut progress, true)
        .map(|_| Done::Now)
        .map_err(Trouble::Failed)
}

#[cfg(windows)]
pub fn start_intentic_engine() -> Fixed {
    crate::engine::start()
        .map(|_| Done::Now)
        .map_err(Trouble::Failed)
}

/// Path for step markers: separate from [`shell::run_elevated_watched`]'s transcript, which it deletes.
pub fn elevated_steps_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "intentic-elevated-steps-{}.log",
        std::process::id()
    ))
}

fn step_function_name(id: &str) -> String {
    format!("Step-{id}")
}

/// Turn a script body into a function body: every `exit` statement becomes `return`.
pub fn as_step_function(function_name: &str, body: &str) -> String {
    let (converted, _) = convert_exit_to_return(body);
    format!("function {function_name} {{\n{converted}\n}}\n")
}

fn convert_exit_to_return(body: &str) -> (String, usize) {
    let bytes = body.as_bytes();
    let mut out = String::with_capacity(body.len());
    let mut index = 0;
    let mut converted = 0;
    while index < bytes.len() {
        if index + 4 <= bytes.len()
            && &bytes[index..index + 4] == b"exit"
            && bytes.get(index + 4) != Some(&b'e')
        {
            let before_ok = index == 0
                || matches!(bytes[index - 1], b' ' | b'\t' | b';' | b'{' | b'\n' | b'\r');
            let after = bytes.get(index + 4).copied();
            let after_ok =
                after.is_none_or(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | b';' | b'}'));
            if before_ok && after_ok {
                out.push_str("return");
                index += 4;
                converted += 1;
                continue;
            }
        }
        out.push(char::from(bytes[index]));
        index += 1;
    }
    (out, converted)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StepProgress {
    pub started: bool,
    pub exit_code: Option<i32>,
}

/// Read `STEP:<id>:start` and `STEP:<id>:exit:<code>` lines written by the elevated batch script.
pub fn parse_elevated_steps(text: &str, ids: &[&'static str]) -> Vec<(&'static str, StepProgress)> {
    use std::collections::HashMap;
    let mut by_id: HashMap<&str, StepProgress> = HashMap::new();
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("STEP:") else {
            continue;
        };
        let mut parts = rest.splitn(3, ':');
        let Some(id) = parts.next() else {
            continue;
        };
        let Some(kind) = parts.next() else {
            continue;
        };
        match kind {
            "start" => {
                let entry = by_id.entry(id).or_default();
                entry.started = true;
            }
            "exit" => {
                let Some(code_text) = parts.next() else {
                    continue;
                };
                let Ok(code) = code_text.trim().parse::<i32>() else {
                    continue;
                };
                let entry = by_id.entry(id).or_default();
                entry.started = true;
                entry.exit_code = Some(code);
            }
            _ => {}
        }
    }
    ids.iter()
        .map(|id| (*id, by_id.get(id).cloned().unwrap_or_default()))
        .collect()
}

pub fn build_elevated_batch_script(steps_path: &std::path::Path, ids: &[(&str, String)]) -> String {
    let steps = steps_path.to_string_lossy().replace('\'', "''");
    let mut script = format!("$Steps = '{steps}'\n");
    for (id, body) in ids {
        script.push_str(&as_step_function(&step_function_name(id), body));
        script.push_str(&format!(
            "Add-Content -Path $Steps -Value 'STEP:{id}:start'\n\
             $code = @({})[-1]\n\
             if ($null -eq $code) {{ $code = $LASTEXITCODE }}\n\
             Add-Content -Path $Steps -Value \"STEP:{id}:exit:$code\"\n",
            step_function_name(id)
        ));
    }
    script.push_str("exit 0\n");
    script
}

#[cfg(windows)]
fn fixed_from_elevated_step(id: &str, progress: &StepProgress) -> Fixed {
    let Some(code) = progress.exit_code else {
        return Err(Trouble::Failed(format!("{id} did not finish")));
    };
    match id {
        "wsl-features" if code == 0 || code == 3010 => {
            if wsl_works_now() {
                crate::ui::note("WSL2 is working already; no restart is needed for it.");
                Ok(Done::Now)
            } else {
                Ok(Done::AfterRestart)
            }
        }
        "wsl-kernel" if code == 0 => Ok(Done::Now),
        "docker-users" if code == 0 => Ok(Done::AfterSignOut),
        _ if code == 0 => Ok(Done::Now),
        _ => Err(Trouble::Failed(format!(
            "{id} did not finish (Windows reported code {code})"
        ))),
    }
}

fn relay_step_lines(text: &str, on_step: &mut dyn FnMut(&str, &str)) {
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("STEP:") else {
            continue;
        };
        let mut parts = rest.splitn(3, ':');
        let (Some(id), Some(kind)) = (parts.next(), parts.next()) else {
            continue;
        };
        match kind {
            "start" => on_step(id, "start"),
            "exit" => {
                if let Some(code) = parts.next() {
                    on_step(id, &format!("exit:{code}"));
                }
            }
            _ => {}
        }
    }
}

/// One UAC prompt for every elevated requirement in this pass. Step markers go to [`elevated_steps_log_path`].
#[cfg(windows)]
pub fn run_elevated_batch(
    requirements: &[&super::plan::Requirement],
    facts: &Facts,
    on_step: &mut dyn FnMut(&str, &str),
) -> Result<Vec<(&'static str, Fixed)>, Trouble> {
    use super::plan::Action;

    let mut ids: Vec<&'static str> = Vec::new();
    let mut bodies: Vec<(&str, String)> = Vec::new();
    for requirement in requirements {
        if requirement.action != Action::FixElevated {
            continue;
        }
        let body = match requirement.id {
            "wsl-features" => ENABLE_WSL.to_string(),
            "wsl-kernel" => UPDATE_WSL.to_string(),
            "docker-users" => {
                let who = if facts.user_qualified.is_empty() {
                    facts.user.clone()
                } else {
                    facts.user_qualified.clone()
                };
                if who.is_empty() {
                    return Err(Trouble::Failed(
                        "could not work out which account to add to docker-users.".to_string(),
                    ));
                }
                ADD_TO_DOCKER_USERS.replace("%NAME%", &who.replace('\'', "''"))
            }
            _ => continue,
        };
        ids.push(requirement.id);
        bodies.push((requirement.id, body));
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let steps_path = elevated_steps_log_path();
    let _ = std::fs::remove_file(&steps_path);
    let script = build_elevated_batch_script(&steps_path, &bodies);
    let steps_for_watch = steps_path.clone();
    let mut watch = super::elevated_watch("Setting up this PC", move || {
        let text = std::fs::read(&steps_for_watch).ok()?;
        let text = String::from_utf8_lossy(&text);
        text.lines().rev().find_map(|line| {
            let rest = line.trim().strip_prefix("STEP:")?;
            let mut parts = rest.splitn(3, ':');
            let id = parts.next()?;
            let kind = parts.next()?;
            Some(format!("{id}: {kind}"))
        })
    });
    let output = shell::run_elevated_watched(&script, &mut watch);
    let step_text = std::fs::read(&steps_path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    relay_step_lines(&step_text, on_step);
    let _ = std::fs::remove_file(&steps_path);

    if output.code == shell::CANCELLED {
        return Err(Trouble::Cancelled);
    }
    if output.code == shell::UNANSWERED {
        return Err(Trouble::Unanswered);
    }

    let progress = parse_elevated_steps(&step_text, &ids);
    Ok(progress
        .into_iter()
        .map(|(id, step)| (id, fixed_from_elevated_step(id, &step)))
        .collect())
}

#[cfg(windows)]
pub fn enable_wsl_features() -> Fixed {
    let mut watch = super::elevated_watch("Turning on WSL2", || None);
    let done = from_exit(
        &shell::run_elevated_watched(ENABLE_WSL, &mut watch),
        "turning on WSL2",
        Done::AfterRestart,
    )?;
    // A restart is what turning a Windows feature ON needs. A PC whose features were already on (Hyper-V's machine
    // platform, an older WSL) only had WSL itself installed by that, and asking it to restart anyway was a restart
    // for nothing: so the machine is asked, and only a feature Windows is still waiting to finish means one.
    Ok(if done == Done::AfterRestart && wsl_works_now() {
        crate::ui::note("WSL2 is working already; no restart is needed for it.");
        Done::Now
    } else {
        done
    })
}

/// Whether WSL2 runs right now, with no Windows feature left waiting for a restart: the examination's own reading.
#[cfg(windows)]
fn wsl_works_now() -> bool {
    super::facts::probe()
        .map(|facts| restart_unneeded(&facts))
        .unwrap_or(false)
}

/// [`wsl_works_now`]'s verdict on a reading. Pure, so the rule is tested where the probe cannot run.
pub fn restart_unneeded(facts: &super::plan::Facts) -> bool {
    super::plan::wsl_ready(facts) && !facts.servicing_reboot_pending
}

/// The kernel and the default version, for a machine whose features are already on. Neither needs a restart:
/// `wsl --update` replaces a component, it does not enable one.
const UPDATE_WSL: &str = "\
wsl.exe --update *>> $Log\n\
$updated = $LASTEXITCODE\n\
wsl.exe --set-default-version 2 *>> $Log\n\
if ($updated -eq 0) { exit 0 }\n\
exit $updated\n";

#[cfg(windows)]
pub fn update_wsl_kernel() -> Fixed {
    let mut watch = super::elevated_watch("Updating WSL2", || None);
    from_exit(
        &shell::run_elevated_watched(UPDATE_WSL, &mut watch),
        "updating WSL2",
        Done::Now,
    )
}

/* ONE ROUTE FOR DOCKER DESKTOP: our own download, then Docker's installer — because only that route can be WATCHED. */
// This used to prefer `winget install` where winget existed (most Windows 10 and 11 PCs). It was one line, and it
// was also one silent elevated call that downloaded 600 MB and ran an installer inside it: a reported setup sat on
// "installing Docker Desktop (about 600 MB)..." for minutes, with no way to tell a download from a permission
// prompt nobody could see from a hang. The direct download is the same file from the same place (winget's
// manifest points at desktop.docker.com too), and here every second of it can be told: megabytes, rate, time
// left; then the prompt, until it is answered; then Docker's installer, phase by phase from its own log.
// What winget's manifest hash vouched for, Docker's Authenticode signature vouches for instead: checked by the
// elevated script before it runs anything, because that is the side about to act on the file.

/// The signature, then the installer, as this user. `%PATH%` is the downloaded file. `install` (not the bare exe) is the
/// unattended entry point; `--user` installs for this account alone under `%LOCALAPPDATA%\Programs\DockerDesktop`,
/// which needs no administrator, installs no privileged service and adds nobody to `docker-users` (Docker Desktop on
/// WSL2 needs neither: per-user installs since 4.72, no group check since 4.65); --accept-license is what the
/// interactive installer's first screen asks; and --backend=wsl-2 is the only backend a per-user install has, said
/// anyway.
///
/// This used to run elevated, as an all-users install: a permission prompt here, a second one to grant `docker-users`,
/// and the sign-out (or, with the restart Docker's installer left pending, the second restart) the group then needed.
/// The output is piped so PowerShell waits for the installer, which is a windowed program.
const RUN_DOCKER_INSTALLER: &str = "\
$installer = '%PATH%'\n\
$sig = Get-AuthenticodeSignature -FilePath $installer\n\
$signer = ''\n\
if ($sig.SignerCertificate) { $signer = $sig.SignerCertificate.Subject }\n\
Write-Output (\"signature: \" + $sig.Status + \" \" + $signer)\n\
if (($sig.Status -ne 'Valid') -or ($signer -notmatch '(^|, )O=Docker Inc(,|$)')) { exit %UNSIGNED% }\n\
& $installer install --user --quiet --accept-license --backend=wsl-2 2>&1 | ForEach-Object { [string]$_ }\n\
exit $LASTEXITCODE\n";

/// [`RUN_DOCKER_INSTALLER`]'s exit when the file is not Docker's. Far from anything an installer returns.
const UNSIGNED: i32 = 7861;

fn run_docker_installer_script(installer: &str) -> String {
    RUN_DOCKER_INSTALLER
        .replace("%PATH%", &installer.replace('\'', "''"))
        .replace("%UNSIGNED%", &UNSIGNED.to_string())
}

/// Where the installer is downloaded to: a folder of its own in this account's temp folder, kept across runs, so a
/// download that a restart (or a closed window) cut short is resumed rather than started over.
pub fn installer_path() -> std::path::PathBuf {
    std::env::temp_dir()
        .join("intentic-docker")
        .join("Docker Desktop Installer.exe")
}

/* 600 MB is the longest wait before the restart, and the desktop app draws it from these readings. */
/// Download Docker Desktop's installer, telling `row` (the requirement it is for) how it goes each second. Runs on a
/// thread of its own beside turning WSL2 on (mod.rs), which is why the row is named rather than taken from what the
/// flow is working on.
#[cfg(windows)]
pub fn download_installer(into: &std::path::Path, row: &'static str) -> Result<(), String> {
    super::live_for(row, "Connecting to docker.com...", super::Live::default());
    let started = Instant::now();
    let mut resumed_from: Option<u64> = None;
    let mut told = Instant::now() - Duration::from_secs(5);
    let mut logged_tenth: u64 = 0;
    let mut last = (0, 0);
    crate::fetch::resumable(
        &crate::fetch::agent(),
        INSTALLER_URL,
        &[],
        into,
        false,
        &mut |have, total| {
            last = (have, total);
            let from = *resumed_from.get_or_insert(have);
            if told.elapsed() < Duration::from_secs(1) {
                return;
            }
            told = Instant::now();
            let reading = super::watch::download_resumed(have, total, started.elapsed(), from);
            super::live_for(
                row,
                &reading,
                super::Live {
                    needs_you: false,
                    percent: super::watch::percent(have, total),
                },
            );
            // The row is told every second; the log only every tenth of the way, which is a trail rather than a stream.
            let tenth = (have * 10).checked_div(total).unwrap_or(0);
            if tenth > logged_tenth {
                logged_tenth = tenth;
                crate::ui::note(&reading);
            }
        },
    )
    .map_err(|error| {
        format!("Docker Desktop could not be downloaded ({error}). Check this PC's internet connection, then try again: the download continues from where it stopped.")
    })?;
    crate::ui::note(&super::watch::download_resumed(
        last.0,
        last.1,
        started.elapsed(),
        resumed_from.unwrap_or(0),
    ));
    Ok(())
}

/// Install Docker Desktop for this account: the download (already running on its own thread when `download` is
/// given, else done here), then Docker's installer, watched, with no permission prompt.
#[cfg(windows)]
pub fn install_docker_desktop(
    download: Option<std::thread::JoinHandle<Result<(), String>>>,
) -> Fixed {
    let installer = installer_path();
    let downloaded = match download {
        Some(running) => running.join().unwrap_or_else(|_| {
            Err("the Docker Desktop download stopped unexpectedly.".to_string())
        }),
        None => download_installer(&installer, "docker-desktop"),
    };
    downloaded.map_err(Trouble::Failed)?;
    super::progress("downloaded; installing it for this account (no permission prompt)");
    let script = run_docker_installer_script(&installer.to_string_lossy());
    let started = std::time::SystemTime::now();
    let mut last_stage: Option<String> = None;
    let output = shell::run_watched(&script, &mut |elapsed| {
        let now = docker_install_stage(started);
        if now.is_some() && now != last_stage {
            if let Some(said) = &now {
                crate::ui::note(&format!("Installing Docker Desktop: {said}"));
            }
            last_stage = now.clone();
        }
        super::live(
            &super::watch::working("Installing Docker Desktop", now.as_deref(), elapsed),
            super::Live::default(),
        );
    });
    if output.code == UNSIGNED {
        let _ = std::fs::remove_file(&installer);
        return Err(Trouble::Failed(
            "The downloaded Docker Desktop installer is not signed by Docker, so it was not run. Try again; if this keeps happening, something on this network is changing downloads.".to_string(),
        ));
    }
    let done = from_exit(&output, "installing Docker Desktop", Done::Now);
    if done.is_ok() {
        let _ = std::fs::remove_file(&installer);
    }
    done
}

/// Where Docker's installer says it is, from its own log, once that log is this run's: a file written before this run
/// started is the LAST install's, and its "Installation succeeded" would be a lie told about this one. A per-user
/// install and an all-users one log to different places, so every place is asked and the newest answers.
#[cfg(windows)]
fn docker_install_stage(since: std::time::SystemTime) -> Option<String> {
    let (_, path) = super::watch::docker_install_logs(
        std::env::var("LOCALAPPDATA").ok().as_deref(),
        std::env::var("ProgramData").ok().as_deref(),
    )
    .into_iter()
    .filter_map(|path| {
        let modified = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()?;
        (modified >= since).then_some((modified, path))
    })
    .max_by_key(|(modified, _)| *modified)?;
    let bytes = std::fs::read(&path).ok()?;
    super::watch::docker_stage(&String::from_utf8_lossy(&bytes))
}

/// Docker's own program folder onto THIS process's PATH; a later `ic` process adopts it itself (main.rs).
#[cfg(windows)]
pub fn put_docker_on_path(facts: &Facts) -> Fixed {
    let Some(dir) = crate::docker::program_folder(&facts.docker_desktop_path) else {
        return Err(Trouble::Failed(
            "Docker Desktop is installed, but its docker program is not where it usually lives. Sign out of Windows and back in, then try again.".to_string(),
        ));
    };
    crate::docker::append_to_path(&dir);
    if crate::docker::cli_present() {
        Ok(Done::Now)
    } else {
        Err(Trouble::Failed(format!(
            "Docker's program folder ({}) was found, but its docker program still would not run. Repairing Docker Desktop from Windows' Apps settings usually fixes this.",
            dir.display()
        )))
    }
}

/* THE `docker-users` GROUP, AND WHY `net.exe`'S ANSWER IS NOT WORTH READING. */
const ADD_TO_DOCKER_USERS: &str = "\
$name = '%NAME%'\n\
$short = $name\n\
if ($name.Contains('\\')) { $short = $name.Split('\\')[-1] }\n\
# The group is created by Docker's installer; make sure it exists so this works in either order.\n\
net.exe localgroup docker-users /add *>> $Log\n\
net.exe localgroup docker-users $name /add *>> $Log\n\
$added = $LASTEXITCODE\n\
# A clean add is a yes. A 2 is not a no - it is the code for 'already a member' as well - so it is not read\n\
# as one, and the roster below settles it instead. See this constant's header.\n\
if ($added -eq 0) { exit 0 }\n\
$out = (net.exe localgroup docker-users 2>&1)\n\
Add-Content -Path $Log -Value ($out | Out-String)\n\
$roster = @()\n\
foreach ($line in $out) { $roster += ([string]$line).Trim() }\n\
# A local member is listed bare, a domain or Entra one as DOMAIN\\user, and `whoami` spells it the second way.\n\
if ($roster -contains $name) { exit 0 }\n\
if ($roster -contains $short) { exit 0 }\n\
exit 1\n";

#[cfg(windows)]
pub fn add_to_docker_users(facts: &Facts) -> Fixed {
    let who = if facts.user_qualified.is_empty() {
        facts.user.clone()
    } else {
        facts.user_qualified.clone()
    };
    if who.is_empty() {
        return Err(Trouble::Failed(
            "could not work out which account to add to docker-users.".to_string(),
        ));
    }
    let script = ADD_TO_DOCKER_USERS.replace("%NAME%", &who.replace('\'', "''"));
    let mut watch = super::elevated_watch("Giving this account permission to use Docker", || None);
    from_exit(
        &shell::run_elevated_watched(&script, &mut watch),
        "adding this account to docker-users",
        Done::AfterSignOut,
    )
}

/* STARTING DOCKER DESKTOP, from wherever it is — and if that is nowhere we can see, from the Start menu. */
const START_DOCKER_DESKTOP: &str = "\
$known = '%PATH%'\n\
%LOCATE_DOCKER_DESKTOP%\n\
if (($known -ne '') -and (Test-Path $known)) { $dd = $known }\n\
if ($dd -ne '') { Start-Process -FilePath $dd; exit 0 }\n\
# A shortcut whose target could not be read is still what a click in the Start menu launches.\n\
foreach ($lnk in @(\n\
  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs\\Docker Desktop.lnk'),\n\
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Docker Desktop.lnk'),\n\
  (Join-Path $env:PUBLIC 'Desktop\\Docker Desktop.lnk'))) {\n\
  if (Test-Path $lnk) { Start-Process -FilePath $lnk; exit 0 }\n\
}\n\
exit 2\n";

/// [`START_DOCKER_DESKTOP`] with the path the probe already found (empty for none) and the shared discovery
/// (`intentic_docker_host::desktop_app::LOCATE`) for when it found none or the app has moved since.
fn start_docker_desktop_script(known: &str) -> String {
    START_DOCKER_DESKTOP
        .replace("%PATH%", &known.replace('\'', "''"))
        .replace(
            "%LOCATE_DOCKER_DESKTOP%",
            intentic_docker_host::desktop_app::LOCATE,
        )
}

/// Exit code of [`START_DOCKER_DESKTOP`] when nothing on its list exists.
const NOT_FOUND: i32 = 2;

/* A FIRST START THAT STAYS IN THE TRAY. Docker Desktop's first start opens its dashboard in front of everything, on
its onboarding: a survey, then an offer to sign in, neither of which a sandbox needs. Every later start goes to the
tray by itself, because "Open Docker Dashboard when Docker Desktop starts" is off by default. The installer has no
flag for this (`--accept-license` covers only the licence), but Docker reads both answers from its per-user settings
file at startup: `DisplayedOnboarding` (the onboarding has been shown) and `OpenUIOnStartupDisabled` (that checkbox).
So setup writes them before the first start. Only on a first start: an install whose onboarding has run is left
exactly as its owner set it. The file is written from here as UTF-8 without a BOM, because Docker rejects a BOM,
replaces the file and shows the first-run dialog anyway (getmonoceros/workbench#119 is that bug, from a PowerShell
5.1 `Set-Content`). */

/// Docker Desktop's `settings-store.json` with its first-run screens answered: `DisplayedOnboarding` on, and
/// `OpenUIOnStartupDisabled` on unless somebody already chose. `existing` is the file's text, None when there is no
/// file yet. Answers None when there is nothing to write: the onboarding has already run (its owner's settings
/// stand), or the text is not a JSON object (Docker's to read, not ours to rewrite). Pure.
pub fn quiet_first_start(existing: Option<&str>) -> Option<String> {
    let mut value = match existing {
        Some(text) => serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?,
        None => serde_json::Value::Object(serde_json::Map::new()),
    };
    let settings = value.as_object_mut()?;
    if settings.get("DisplayedOnboarding") == Some(&serde_json::Value::Bool(true)) {
        return None;
    }
    settings.insert("DisplayedOnboarding".to_string(), true.into());
    settings
        .entry("OpenUIOnStartupDisabled")
        .or_insert(true.into());
    serde_json::to_string_pretty(&value).ok()
}

/// [`quiet_first_start`] on this account's Docker Desktop settings, before Docker is started. Best effort: a start
/// that would have shown the onboarding still starts, so a failure here is a note in the log and nothing more.
#[cfg(windows)]
fn keep_first_start_in_tray() {
    let Some(dir) =
        std::env::var_os("APPDATA").map(|dir| std::path::Path::new(&dir).join("Docker"))
    else {
        return;
    };
    let store = dir.join("settings-store.json");
    let existing = match std::fs::read_to_string(&store) {
        Ok(text) => Some(text),
        // Docker Desktop 4.34 and older keep `settings.json` and newer ones migrate it on their first start; a
        // `settings-store.json` written beside it would be read in its place and lose everything it holds.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if dir.join("settings.json").exists() {
                return;
            }
            None
        }
        Err(_) => return,
    };
    let Some(text) = quiet_first_start(existing.as_deref()) else {
        return;
    };
    let written = std::fs::create_dir_all(&dir)
        .map_err(|error| error.to_string())
        .and_then(|()| crate::sandbox::fix::desktop::write_beside(&store, &text));
    match written {
        Ok(()) => crate::ui::note("Docker Desktop will start in the system tray, without its welcome screens."),
        Err(error) => crate::ui::note(&format!(
            "Docker Desktop's first-start settings were not written ({error}); it may open its welcome screen."
        )),
    }
}

/// Start Docker Desktop. Not elevated: it is a desktop app, and starting it as administrator gives its engine
/// a different user's context than the one that will use it.
#[cfg(windows)]
pub fn start_docker_desktop(facts: &Facts) -> Fixed {
    keep_first_start_in_tray();
    let output = shell::run(&start_docker_desktop_script(&facts.docker_desktop_path));
    if output.ok {
        return Ok(Done::Now);
    }
    if output.code == NOT_FOUND {
        return Err(Trouble::Failed(
            "Docker Desktop seems to be installed, but not anywhere this setup can find. Open Docker Desktop yourself from the Start menu, wait until it says the engine is running, then choose Check again.".to_string(),
        ));
    }
    Err(Trouble::Failed(format!(
        "Docker Desktop would not start ({}). Open it yourself from the Start menu, wait until it says the engine is running, then choose Check again.",
        output.stderr.trim()
    )))
}

/// Wait for the engine, saying so as it goes. The one place in this flow where patience is the fix.
#[cfg(windows)]
pub fn wait_for_daemon() -> Fixed {
    let started = Instant::now();
    let deadline = started + DAEMON_TIMEOUT;
    let mut said = Instant::now();
    // How long to wait before mentioning the thing that is USUALLY happening. A first start genuinely takes a
    // couple of minutes on a laptop (it creates the WSL2 distro, unpacks the engine and boots a VM), so
    // saying this at ten seconds would be crying wolf on every install; saying it only at the five-minute
    // timeout is telling somebody what to do after they have given up.
    const HINT_AFTER: Duration = Duration::from_secs(75);
    let mut hinted = false;
    while Instant::now() < deadline {
        match crate::docker::daemon_refusal() {
            None => return Ok(Done::Now),
            // The engine is up and has turned THIS ACCOUNT away: waiting longer changes nothing, and neither
            // would starting Docker again. What is left is the sign-in that hands out the group.
            Some(refusal) if super::plan::engine_denied(&refusal) => {
                return Ok(Done::AfterSignOut);
            }
            Some(_) => {}
        }
        if !hinted && started.elapsed() >= HINT_AFTER {
            hinted = true;
            /* Docker Desktop's first run puts up a licence screen and, depending on the build, an offer to sign in — and it does it in its OWN window. */
            super::progress(
                "Docker Desktop may be asking you something: open it from its whale icon in the system tray and look for a sign-in or update screen. A first start also just takes a couple of minutes",
            );
        }
        if said.elapsed() >= Duration::from_secs(20) {
            said = Instant::now();
            let left = deadline.saturating_duration_since(Instant::now()).as_secs();
            super::progress(&format!(
                "still waiting for Docker's engine ({left}s before giving up)"
            ));
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    // Not a failure of ours, and the remedy is a human one: Docker Desktop asks for a licence acceptance and
    // sometimes a sign-in on its first run, and until somebody answers that, no engine appears.
    Err(Trouble::Failed(
        "Docker Desktop was started, but its engine has not come up after five minutes. Open it from its whale icon in the system tray: it may be waiting for you to accept its terms or skip a sign-in. Once it says the engine is running, choose Check again.".to_string(),
    ))
}

/// Off Windows containers. `DockerCli.exe` is Docker Desktop's own switcher — the same thing the tray menu
/// calls, so this is the documented route rather than a poke at its settings file.
#[cfg(windows)]
pub fn switch_to_linux_containers(facts: &Facts) -> Fixed {
    use intentic_docker_host::desktop_app;
    let cli = std::iter::once(facts.docker_desktop_path.clone())
        .filter(|exe| !exe.is_empty())
        .chain(desktop_app::default_installs_here())
        .filter_map(|app| desktop_app::app_folder(&app))
        .map(|root| format!("{root}\\DockerCli.exe"))
        .find(|cli| std::path::Path::new(cli).exists());
    let Some(cli) = cli else {
        return Err(Trouble::Failed(
            "Docker Desktop's own switcher could not be found. Right-click Docker's icon in the system tray, choose \"Switch to Linux containers\", then choose Check again.".to_string(),
        ));
    };
    let quoted = cli.replace('\'', "''");
    let output = shell::run(&format!(
        "$ErrorActionPreference = 'Continue'\n& '{quoted}' -SwitchLinuxEngine\nexit $LASTEXITCODE\n"
    ));
    if !output.ok {
        return Err(Trouble::Failed(
            "Docker would not switch to Linux containers on its own. Right-click Docker's icon in the system tray, choose \"Switch to Linux containers\", then choose Check again.".to_string(),
        ));
    }
    // The switch restarts the engine, so the daemon goes away and comes back.
    wait_for_daemon()
}

/// Restart Windows after the reader confirms. `/t 0` only: any `/t` above 0 makes Windows imply `/f` and
/// force-close apps with unsaved work.
#[cfg(windows)]
pub fn restart_windows() -> Result<(), String> {
    let output = shell::run(
        "$ErrorActionPreference = 'Continue'\n\
         shutdown.exe /r /t 0 /c \"intentic: finishing Docker setup\"\n\
         exit $LASTEXITCODE\n",
    );
    if output.ok {
        return Ok(());
    }
    Err(format!(
        "Windows refused to restart ({}). Restart this PC yourself; the setup continues once you are back.",
        output.stderr.trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    // The struct is only USED here on Windows (see this file's header), but the substitution it feeds is
    // pure, so the test that guards it runs on every runner.
    use crate::prepare::plan::Facts;

    fn contains_exit_keyword(text: &str) -> bool {
        count_exit_keywords(text) > 0
    }

    fn count_exit_keywords(text: &str) -> usize {
        let bytes = text.as_bytes();
        let mut count = 0;
        let mut index = 0;
        while index + 4 <= bytes.len() {
            if &bytes[index..index + 4] != b"exit" {
                index += 1;
                continue;
            }
            if bytes.get(index + 4) == Some(&b'e') {
                index += 1;
                continue;
            }
            let before_ok = index == 0
                || matches!(bytes[index - 1], b' ' | b'\t' | b';' | b'{' | b'\n' | b'\r');
            let after = bytes.get(index + 4).copied();
            let after_ok =
                after.is_none_or(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | b';' | b'}'));
            if before_ok && after_ok {
                count += 1;
                index += 4;
            } else {
                index += 1;
            }
        }
        count
    }

    fn count_return_keywords(text: &str) -> usize {
        let bytes = text.as_bytes();
        let mut count = 0;
        let mut index = 0;
        while index + 6 <= bytes.len() {
            if &bytes[index..index + 6] != b"return" {
                index += 1;
                continue;
            }
            let before_ok = index == 0
                || matches!(bytes[index - 1], b' ' | b'\t' | b';' | b'{' | b'\n' | b'\r');
            let after = bytes.get(index + 6).copied();
            let after_ok =
                after.is_none_or(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | b';' | b'}'));
            if before_ok && after_ok {
                count += 1;
                index += 6;
            } else {
                index += 1;
            }
        }
        count
    }

    /* The bodies above are Windows-only and are covered by the Windows smoke tiers. */

    #[test]
    fn the_installer_url_is_dockers_own_permanent_one() {
        assert!(INSTALLER_URL.starts_with("https://desktop.docker.com/win/main/amd64/"));
        assert!(
            INSTALLER_URL.ends_with(".exe"),
            "it has to be the installer, not a landing page"
        );
        assert!(
            !INSTALLER_URL.contains(' '),
            "the space in the filename must stay percent-encoded"
        );
    }

    /* Nothing runs elevated that Docker did not sign. */
    #[test]
    fn the_installer_runs_only_after_its_docker_signature_checks_out() {
        let script = run_docker_installer_script("C:\\Temp\\It's\\Docker Desktop Installer.exe");
        let check = script
            .find("Get-AuthenticodeSignature")
            .expect("the signature is read");
        let gate = script
            .find("exit 7861")
            .expect("an unsigned file stops the script");
        let run = script
            .find("& $installer install")
            .expect("the installer is run");
        assert!(
            check < gate && gate < run,
            "check, then refuse, then run: {script}"
        );
        assert!(
            script.contains("'Valid'"),
            "an expired or tampered signature is not good enough"
        );
        assert!(
            script.contains("O=Docker Inc"),
            "signed by somebody is not signed by Docker"
        );
        assert!(
            script.contains("$installer = 'C:\\Temp\\It''s\\Docker Desktop Installer.exe'"),
            "{script}"
        );
        assert!(script.contains("--quiet --accept-license --backend=wsl-2"));
        assert!(!script.contains('%'), "every placeholder filled: {script}");
        assert!(script.is_ascii());
    }

    /* THE REPORTED FAILURE, PINNED AT ITS CAUSE. */
    #[test]
    fn the_group_fix_reads_the_roster_rather_than_believing_net_exes_exit_code() {
        assert!(
            !ADD_TO_DOCKER_USERS.contains("exit $LASTEXITCODE"),
            "handing net's code straight back is the bug: 'already a member' and a real refusal share it"
        );
        assert!(
            ADD_TO_DOCKER_USERS.contains("if ($added -eq 0) { exit 0 }"),
            "a clean add is still allowed to be the whole answer - the roster only ever ADDS outcomes"
        );
        assert!(
            ADD_TO_DOCKER_USERS.contains("$roster -contains $name")
                && ADD_TO_DOCKER_USERS.contains("$roster -contains $short"),
            "a local member is listed bare and a domain one as DOMAIN\\user - both have to count"
        );
        assert!(
            ADD_TO_DOCKER_USERS.contains("net.exe localgroup docker-users $name /add"),
            "it still has to try the add"
        );
        assert!(
            ADD_TO_DOCKER_USERS.is_ascii(),
            "same rule as every other script in this repo"
        );
    }

    /// The account is substituted in, not read inside the elevated script — that script may be running as
    /// whoever answered the UAC prompt, which is how you add the wrong person and report success.
    #[test]
    fn the_account_is_the_one_that_asked_and_its_quotes_cannot_escape_the_script() {
        let facts = Facts {
            user: "radar".to_string(),
            user_qualified: "rog\\radar".to_string(),
            ..Facts::default()
        };
        let who = if facts.user_qualified.is_empty() {
            facts.user.clone()
        } else {
            facts.user_qualified.clone()
        };
        let script = ADD_TO_DOCKER_USERS.replace("%NAME%", &who.replace('\'', "''"));
        assert!(script.contains("$name = 'rog\\radar'"));
        assert!(!script.contains("%NAME%"), "the placeholder must be spent");
        // A name with a quote in it is doubled, which is PowerShell's own escape inside a single-quoted
        // string - so it stays DATA rather than closing the literal and becoming script.
        let nasty = ADD_TO_DOCKER_USERS.replace("%NAME%", &"a'; exit 0 #".replace('\'', "''"));
        assert!(nasty.contains("$name = 'a''; exit 0 #'"));
    }

    /* THE REPORTED FAILURE: "could not find Docker Desktop to start it", on a PC that had it. */
    #[test]
    fn starting_docker_desktop_falls_back_to_the_start_menu_before_giving_up() {
        assert!(
            START_DOCKER_DESKTOP.contains("Docker Desktop.lnk"),
            "a shortcut is what a click in the Start menu launches, and it exists wherever Docker went"
        );
        assert!(start_docker_desktop_script("").contains("$env:LOCALAPPDATA"));
        assert!(
            START_DOCKER_DESKTOP.contains("exit 2"),
            "not found has to be told apart from would not start: the two sentences differ"
        );
        assert!(START_DOCKER_DESKTOP.is_ascii());
        // The known path rides in, quoted the same way every other substitution here is, beside the shared discovery.
        let script = start_docker_desktop_script("C:\\It's\\Docker Desktop.exe");
        assert!(script.contains("'C:\\It''s\\Docker Desktop.exe'"));
        assert!(script.contains(intentic_docker_host::desktop_app::LOCATE));
        assert!(!script.contains('%'), "every placeholder filled: {script}");
        assert!(script.is_ascii());
    }

    #[test]
    fn a_first_start_is_told_to_skip_the_onboarding_and_stay_in_the_tray() {
        let fresh: serde_json::Value =
            serde_json::from_str(&quiet_first_start(None).expect("no file yet is a first start"))
                .unwrap();
        assert_eq!(fresh["DisplayedOnboarding"], true);
        assert_eq!(fresh["OpenUIOnStartupDisabled"], true);

        // What the installer left (the licence it accepted, the backend) is kept beside the two answers.
        let installed = quiet_first_start(Some(
            r#"{"LicenseTermsVersion": 2, "WslEngineEnabled": true, "DisplayedOnboarding": false}"#,
        ))
        .expect("an onboarding not yet shown");
        let installed: serde_json::Value = serde_json::from_str(&installed).unwrap();
        assert_eq!(installed["LicenseTermsVersion"], 2);
        assert_eq!(installed["WslEngineEnabled"], true);
        assert_eq!(installed["DisplayedOnboarding"], true);
        assert_eq!(installed["OpenUIOnStartupDisabled"], true);
    }

    #[test]
    fn a_dashboard_somebody_asked_for_stays_asked_for() {
        let chosen = quiet_first_start(Some(r#"{"OpenUIOnStartupDisabled": false}"#)).unwrap();
        let chosen: serde_json::Value = serde_json::from_str(&chosen).unwrap();
        assert_eq!(chosen["OpenUIOnStartupDisabled"], false);
        assert_eq!(chosen["DisplayedOnboarding"], true);
    }

    #[test]
    fn an_install_that_has_run_before_is_left_alone() {
        // omen's file, abridged: onboarding done, the dashboard setting never touched. Nothing to write.
        assert_eq!(
            quiet_first_start(Some(
                r#"{"AutoStart": true, "DisplayedOnboarding": true, "SettingsVersion": 46}"#
            )),
            None
        );
        assert_eq!(quiet_first_start(Some("not json")), None);
        assert_eq!(quiet_first_start(Some("[1, 2]")), None);
    }

    #[test]
    fn a_byte_order_mark_is_read_past_and_never_written() {
        let text = quiet_first_start(Some("\u{feff}{\"LicenseTermsVersion\": 2}")).unwrap();
        assert!(
            !text.starts_with('\u{feff}'),
            "Docker rejects a BOM: {text}"
        );
        assert!(text.contains("\"LicenseTermsVersion\": 2"));
    }

    #[test]
    fn done_distinguishes_the_two_fixes_that_do_not_take_effect_yet() {
        // The whole reason this enum has three values rather than being a bool.
        assert_ne!(Done::Now, Done::AfterRestart);
        assert_ne!(Done::Now, Done::AfterSignOut);
        assert_ne!(Done::AfterRestart, Done::AfterSignOut);
    }

    #[test]
    fn elevated_step_bodies_lose_exit_and_gain_return() {
        for (label, body) in [
            ("ENABLE_WSL", ENABLE_WSL),
            ("UPDATE_WSL", UPDATE_WSL),
            ("ADD_TO_DOCKER_USERS", ADD_TO_DOCKER_USERS),
        ] {
            let exits = count_exit_keywords(body);
            assert!(exits > 0, "{label} must contain exit statements to convert");
            let function = as_step_function("Step-test", body);
            assert!(
                !contains_exit_keyword(&function),
                "{label} still contains exit: {function}"
            );
            assert_eq!(
                count_return_keywords(&function),
                exits,
                "{label}: return count must match former exit count"
            );
            if label == "ENABLE_WSL" {
                assert!(
                    function.contains("exited"),
                    "the Add-Content line about wsl --install must stay"
                );
            }
        }
    }

    #[test]
    fn the_elevated_batch_script_wraps_each_step_and_records_its_exit() {
        let script = build_elevated_batch_script(
            std::path::Path::new("C:\\Temp\\steps.log"),
            &[("wsl-features", "return 0\n".to_string())],
        );
        assert!(script.contains("$Steps = 'C:\\Temp\\steps.log'"));
        assert!(script.contains("function Step-wsl-features"));
        assert!(script.contains("STEP:wsl-features:start"));
        assert!(script.contains("STEP:wsl-features:exit:$code"));
        assert!(script.trim_end().ends_with("exit 0"));
    }

    #[test]
    fn the_elevated_step_file_parser_reads_each_exit_code() {
        let text = "\
STEP:wsl-features:start
STEP:wsl-features:exit:3010
STEP:wsl-kernel:start
STEP:wsl-kernel:exit:1
";
        let parsed = parse_elevated_steps(text, &["wsl-features", "wsl-kernel", "docker-users"]);
        assert_eq!(parsed[0].1.exit_code, Some(3010));
        assert_eq!(parsed[1].1.exit_code, Some(1));
        assert_eq!(parsed[2].1.exit_code, None);
    }
}
