// See plan.rs's header: these bodies only compile into the Windows binary; the constants they are built from
// are asserted on every runner.
#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
use std::io::{Read, Write};
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
pub fn enable_wsl_features() -> Fixed {
    let mut watch = super::elevated_watch("Turning on WSL2", || None);
    from_exit(
        &shell::run_elevated_watched(ENABLE_WSL, &mut watch),
        "turning on WSL2",
        Done::AfterRestart,
    )
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

/// The elevated half: the signature, then the installer. `%PATH%` is the downloaded file. `install` (not the bare
/// exe) is the unattended entry point; --accept-license is what the interactive installer's first screen asks, and
/// --backend=wsl-2 stops it choosing Hyper-V on a Pro machine, which would then need a different set of features
/// than the ones we just turned on.
const RUN_DOCKER_INSTALLER: &str = "\
$installer = '%PATH%'\n\
$sig = Get-AuthenticodeSignature -FilePath $installer\n\
$signer = ''\n\
if ($sig.SignerCertificate) { $signer = $sig.SignerCertificate.Subject }\n\
Add-Content -Path $Log -Value (\"signature: \" + $sig.Status + \" \" + $signer)\n\
if (($sig.Status -ne 'Valid') -or ($signer -notmatch '(^|, )O=Docker Inc(,|$)')) { exit %UNSIGNED% }\n\
& $installer install --quiet --accept-license --backend=wsl-2 *>> $Log\n\
exit $LASTEXITCODE\n";

/// [`RUN_DOCKER_INSTALLER`]'s exit when the file is not Docker's. Far from anything an installer returns.
const UNSIGNED: i32 = 7861;

fn run_docker_installer_script(installer: &str) -> String {
    RUN_DOCKER_INSTALLER
        .replace("%PATH%", &installer.replace('\'', "''"))
        .replace("%UNSIGNED%", &UNSIGNED.to_string())
}

#[cfg(windows)]
pub fn install_docker_desktop(_facts: &Facts) -> Fixed {
    let installer = std::env::temp_dir().join("Docker Desktop Installer.exe");
    if let Err(problem) = download(INSTALLER_URL, &installer) {
        return Err(Trouble::Failed(problem));
    }
    super::progress("downloaded; Windows will now ask for permission to install it");
    let script = run_docker_installer_script(&installer.to_string_lossy());
    let started = std::time::SystemTime::now();
    let mut watch = super::elevated_watch("Installing Docker Desktop", move || {
        docker_install_stage(started)
    });
    let output = shell::run_elevated_watched(&script, &mut watch);
    let _ = std::fs::remove_file(&installer);
    if output.code == UNSIGNED {
        return Err(Trouble::Failed(
            "The downloaded Docker Desktop installer is not signed by Docker, so it was not run. Try again; if this keeps happening, something on this network is changing downloads.".to_string(),
        ));
    }
    from_exit(&output, "installing Docker Desktop", Done::Now)
}

/// Where Docker's installer says it is, from its own log, once that log is this run's: the file there before
/// this run started is the LAST install's, and its "Installation succeeded" would be a lie told about this one.
#[cfg(windows)]
fn docker_install_stage(since: std::time::SystemTime) -> Option<String> {
    let path = std::path::Path::new(super::watch::DOCKER_INSTALL_LOG);
    let modified = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()?;
    if modified < since {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    super::watch::docker_stage(&String::from_utf8_lossy(&bytes))
}

/* 600 MB is the longest wait in this whole flow, and the desktop app draws it from these readings. */
#[cfg(windows)]
fn download(url: &str, into: &std::path::Path) -> Result<(), String> {
    let agent = ureq::Agent::config_builder()
        // No global timeout: this is a 600 MB body on whatever connection the user has. The read timeout is
        // what catches a dead transfer, and a global one would just cap slow connections at "failed".
        .timeout_global(None)
        .timeout_connect(Some(Duration::from_secs(30)))
        .build()
        .new_agent();
    super::live("Connecting to docker.com...", super::Live::default());
    let response = agent
        .get(url)
        .call()
        .map_err(|error| format!("Docker Desktop could not be downloaded from {url} ({error}). Check this PC's internet connection, then try again."))?;
    let total: u64 = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let temporary = into.with_extension("part");
    let mut file = std::fs::File::create(&temporary)
        .map_err(|error| format!("could not write to {}: {error}", temporary.display()))?;
    let mut reader = response.into_body().into_reader();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut written: u64 = 0;
    let started = Instant::now();
    // The row is told every second; the log only every tenth of the way, which is a trail rather than a stream.
    let mut told = Instant::now();
    let mut logged_tenth: u64 = 0;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("The Docker Desktop download stopped early ({error}). Check this PC's internet connection, then try again."))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("could not write the installer to disk: {error}"))?;
        written += read as u64;
        if told.elapsed() >= Duration::from_secs(1) {
            told = Instant::now();
            let reading = super::watch::download(written, total, started.elapsed());
            super::live(
                &reading,
                super::Live {
                    needs_you: false,
                    percent: super::watch::percent(written, total),
                },
            );
            let tenth = (written * 10).checked_div(total).unwrap_or(0);
            if tenth > logged_tenth {
                logged_tenth = tenth;
                crate::ui::note(&reading);
            }
        }
    }
    drop(file);
    crate::ui::note(&super::watch::download(written, total, started.elapsed()));
    // Rename only once it is whole: a half-downloaded installer that Windows agrees to run is worse than no
    // installer at all. The same download-then-rename the shims use for this binary.
    std::fs::rename(&temporary, into)
        .map_err(|error| format!("could not finish writing {}: {error}", into.display()))?;
    Ok(())
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

/// Start Docker Desktop. Not elevated: it is a desktop app, and starting it as administrator gives its engine
/// a different user's context than the one that will use it.
#[cfg(windows)]
pub fn start_docker_desktop(facts: &Facts) -> Fixed {
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
                "Docker Desktop may be asking you something: look at its window for a welcome or sign-in screen. A first start also just takes a couple of minutes",
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
        "Docker Desktop was started, but its engine has not come up after five minutes. Look at the Docker Desktop window: it may be waiting for you to accept its terms or skip a sign-in. Once it says the engine is running, choose Check again.".to_string(),
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

/// Restart Windows, after saying so. `/t 10` rather than immediately: the app has just told somebody their PC
/// is about to restart, and ten seconds is the difference between an announcement and a surprise.
#[cfg(windows)]
pub fn restart_windows() -> Result<(), String> {
    let output = shell::run(
        "$ErrorActionPreference = 'Continue'\n\
         shutdown.exe /r /t 10 /c \"intentic: finishing Docker setup\"\n\
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
    fn done_distinguishes_the_two_fixes_that_do_not_take_effect_yet() {
        // The whole reason this enum has three values rather than being a bool.
        assert_ne!(Done::Now, Done::AfterRestart);
        assert_ne!(Done::Now, Done::AfterSignOut);
        assert_ne!(Done::AfterRestart, Done::AfterSignOut);
    }
}
