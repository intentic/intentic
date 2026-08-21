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

/* DOING SOMETHING ABOUT IT — one function per requirement, each one honest about what it achieved.
 *
 * The rule this file is organised around: a fix reports what it CHANGED, not what it attempted. Turning on an
 * optional feature succeeds instantly and does nothing until the machine restarts; adding somebody to a group
 * succeeds instantly and does nothing until they sign in again. A fix that returned a bare "done" for either
 * of those produces the worst outcome in this whole flow — a setup that carries on, fails on the very thing it
 * just "fixed", and reports it as a second, unrelated problem.
 *
 * So [`Done`] has three values, and the two that are not `Now` are what the restart and sign-out screens are
 * built from. */

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
    // The elevated child's transcript is in stdout (shell::run_elevated), and its last few lines are the ones
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
    Err(Trouble::Failed(if tail.is_empty() {
        format!("{what} failed (exit {})", output.code)
    } else {
        format!("{what} failed (exit {}):\n         {tail}", output.code)
    }))
}

/* WSL2, WHICH IS TWO WINDOWS FEATURES AND A KERNEL.
 *
 * `wsl --install --no-distribution` is the modern one-liner for all three, and `--no-distribution` matters:
 * without it Windows also installs Ubuntu, which is a gigabyte nobody asked for and a first-run wizard that
 * wants a username and password — inside a hidden elevated window, where nobody can answer it.
 *
 * The flag arrived in Windows 11 21H2 / Windows 10 build 19044-era servicing, and on anything older
 * `wsl --install` either does not exist or ignores it. So the fallback enables the same two features through
 * dism, which has worked unchanged since WSL2 shipped. Either way the machine has to restart. */
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
    from_exit(
        &shell::run_elevated(ENABLE_WSL),
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
    from_exit(&shell::run_elevated(UPDATE_WSL), "updating WSL2", Done::Now)
}

/* INSTALLING DOCKER DESKTOP, BY WHICHEVER ROUTE THIS PC HAS.
 *
 * The package manager when there is one: it handles the download, the hash and the elevation itself, and a PC
 * that has it is a PC where this is one line.
 *
 * And when there is not — Windows Server, plenty of Windows 10, any machine where the App Installer was never
 * provisioned — the installer is fetched from Docker's own permanent URL and run with its silent-install
 * flags. That branch is this whole change's original reason for existing: the shim used to stop here with
 * "winget is unavailable", which told the user to go and do by hand the two steps below. */
const INSTALL_WITH_WINGET: &str = "\
winget.exe install --id Docker.DockerDesktop --exact --silent --accept-package-agreements --accept-source-agreements *>> $Log\n\
# -1978335189 is winget's \"already installed\", which is a success for our purposes.\n\
if ($LASTEXITCODE -eq -1978335189) { exit 0 }\n\
exit $LASTEXITCODE\n";

#[cfg(windows)]
pub fn install_docker_desktop(facts: &Facts) -> Fixed {
    if facts.winget {
        return from_exit(
            &shell::run_elevated(INSTALL_WITH_WINGET),
            "installing Docker Desktop",
            Done::Now,
        );
    }
    let installer = std::env::temp_dir().join("Docker Desktop Installer.exe");
    if let Err(problem) = download(INSTALLER_URL, &installer) {
        return Err(Trouble::Failed(problem));
    }
    super::progress(
        "running Docker's installer (this takes a few minutes, and it says nothing while it works)",
    );
    let path = installer.to_string_lossy().replace('\'', "''");
    // `install` (not the bare exe) is the unattended entry point; --accept-license is what the interactive
    // installer's first screen asks, and --backend=wsl-2 stops it choosing Hyper-V on a Pro machine, which
    // would then need a different set of features than the ones we just turned on.
    let script = format!(
        "& '{path}' install --quiet --accept-license --backend=wsl-2 *>> $Log\n\
         exit $LASTEXITCODE\n"
    );
    let outcome = from_exit(
        &shell::run_elevated(&script),
        "installing Docker Desktop",
        Done::Now,
    );
    let _ = std::fs::remove_file(&installer);
    outcome
}

/* THE DOWNLOAD, WITH A NUMBER ON IT.
 *
 * 600 MB with no output is the single longest silence in this whole flow, and the desktop app draws its
 * progress from these lines — so this reports every 25 MB rather than streaming quietly and hoping.
 *
 * Streamed to disk, never buffered: the alternative is holding the installer in memory on a machine we have
 * just established is short of resources, for no benefit at all. */
#[cfg(windows)]
fn download(url: &str, into: &std::path::Path) -> Result<(), String> {
    let agent = ureq::Agent::config_builder()
        // No global timeout: this is a 600 MB body on whatever connection the user has. The read timeout is
        // what catches a dead transfer, and a global one would just cap slow connections at "failed".
        .timeout_global(None)
        .timeout_connect(Some(Duration::from_secs(30)))
        .build()
        .new_agent();
    let response = agent
        .get(url)
        .call()
        .map_err(|error| format!("could not download Docker Desktop from {url}: {error}"))?;
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
    let mut announced: u64 = 0;
    const ANNOUNCE_EVERY: u64 = 25 * 1024 * 1024;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("the Docker Desktop download stopped early: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("could not write the installer to disk: {error}"))?;
        written += read as u64;
        if written - announced >= ANNOUNCE_EVERY {
            announced = written;
            if total > 0 {
                super::progress(&format!(
                    "downloaded {} MB of {} MB",
                    written / (1024 * 1024),
                    total / (1024 * 1024)
                ));
            } else {
                super::progress(&format!("downloaded {} MB", written / (1024 * 1024)));
            }
        }
    }
    drop(file);
    // Rename only once it is whole: a half-downloaded installer that Windows agrees to run is worse than no
    // installer at all. The same download-then-rename the shims use for this binary.
    std::fs::rename(&temporary, into)
        .map_err(|error| format!("could not finish writing {}: {error}", into.display()))?;
    Ok(())
}

/// Docker's own program folder onto THIS process's PATH, so the `docker` we are about to call is found without
/// a new shell. A fresh install is not on the PATH any existing process inherited, and `ic sandbox connect`
/// runs inside this one.
#[cfg(windows)]
pub fn put_docker_on_path(facts: &Facts) -> Fixed {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if !facts.docker_desktop_path.is_empty() {
        if let Some(dir) = std::path::Path::new(&facts.docker_desktop_path).parent() {
            roots.push(dir.join("resources").join("bin"));
        }
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        roots.push(
            std::path::Path::new(&program_files)
                .join("Docker")
                .join("Docker")
                .join("resources")
                .join("bin"),
        );
    }
    let found = roots
        .into_iter()
        .find(|dir| dir.join("docker.exe").exists());
    let Some(dir) = found else {
        return Err(Trouble::Failed(
            "Docker Desktop is installed but its docker.exe is not where it usually lives - sign out and back in, then re-run.".to_string(),
        ));
    };
    let existing = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{existing};{}", dir.display()));
    if crate::docker::cli_present() {
        Ok(Done::Now)
    } else {
        Err(Trouble::Failed(format!(
            "added {} to this run's PATH, but docker still would not run.",
            dir.display()
        )))
    }
}

/* THE `docker-users` GROUP, AND WHY `net.exe`'S ANSWER IS NOT WORTH READING.
 *
 * `net localgroup` reports every one of these as exit code 2:
 *
 *     System error 1379 — the specified local group already exists.
 *     System error 1378 — the specified account name is already a member of the group.
 *     System error 1387 — no such account.
 *
 * The first two mean THIS IS ALREADY DONE and the third means it cannot be. Believing the exit code puts all
 * three on the same screen, and a real install ended there: Docker Desktop's own installer adds whoever ran
 * it to `docker-users`, so by the time this ran — seconds after that installer finished, in the same pass —
 * the account was already a member, `net` said 2, and a setup that had just done everything right stopped at
 * 8% claiming it could not grant a permission the machine had already granted.
 *
 * So the verdict is "the add worked, OR the account is in the group either way" — which is the fact this fix
 * is actually about, and is true whichever order things happened in. It is the same question
 * [`super::facts`] asks before deciding whether to come here at all. Failing means BOTH: the add was refused
 * and the roster does not have them, which is unambiguous and worth printing.
 *
 * The account name is passed IN rather than read inside the elevated script, because that script may be
 * running as somebody else entirely — whoever the UAC prompt was answered as — and adding the wrong account
 * to the group is a fix that changes nothing and says it worked. */
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
    from_exit(
        &shell::run_elevated(&script),
        "adding this account to docker-users",
        Done::AfterSignOut,
    )
}

/// Start Docker Desktop. Not elevated: it is a desktop app, and starting it as administrator gives its engine
/// a different user's context than the one that will use it.
#[cfg(windows)]
pub fn start_docker_desktop(facts: &Facts) -> Fixed {
    let path = if facts.docker_desktop_path.is_empty() {
        std::env::var("ProgramFiles")
            .map(|root| format!("{root}\\Docker\\Docker\\Docker Desktop.exe"))
            .unwrap_or_default()
    } else {
        facts.docker_desktop_path.clone()
    };
    if path.is_empty() || !std::path::Path::new(&path).exists() {
        return Err(Trouble::Failed(
            "could not find Docker Desktop to start it.".to_string(),
        ));
    }
    let quoted = path.replace('\'', "''");
    let output = shell::run(&format!("Start-Process -FilePath '{quoted}'\nexit 0\n"));
    if !output.ok {
        return Err(Trouble::Failed(format!(
            "could not start Docker Desktop: {}",
            output.stderr.trim()
        )));
    }
    Ok(Done::Now)
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
        if crate::docker::daemon_reachable() {
            return Ok(Done::Now);
        }
        if !hinted && started.elapsed() >= HINT_AFTER {
            hinted = true;
            /* THE THING THAT IS ACTUALLY ON SCREEN, SAID WHILE IT STILL HELPS.
             *
             * Docker Desktop's first run puts up a licence screen and, depending on the build, an offer to
             * sign in — and it does it in its OWN window, which on a machine where the setup was started from
             * a browser is behind everything else. Until somebody answers it there is no engine, forever. The
             * wait cannot tell that apart from a slow boot, so it stops trying to and names both. */
            super::progress(
                "Docker Desktop may be asking you something - check its window for a licence or sign-in screen; a first start also just takes a couple of minutes",
            );
        }
        if said.elapsed() >= Duration::from_secs(20) {
            said = Instant::now();
            let left = deadline.saturating_duration_since(Instant::now()).as_secs();
            super::progress(&format!(
                "still waiting for Docker's engine ({left}s before we give up)"
            ));
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    // Not a failure of ours, and the remedy is a human one: Docker Desktop asks for a licence acceptance and
    // sometimes a sign-in on its first run, and until somebody answers that, no engine appears.
    Err(Trouble::Failed(
        "Docker Desktop was started but its engine never came up.\n       Open Docker Desktop from the Start menu, accept its licence and finish its first-run screens - it may be waiting on a window behind this one. Then choose Check again.".to_string(),
    ))
}

/// Off Windows containers. `DockerCli.exe` is Docker Desktop's own switcher — the same thing the tray menu
/// calls, so this is the documented route rather than a poke at its settings file.
#[cfg(windows)]
pub fn switch_to_linux_containers(facts: &Facts) -> Fixed {
    let root = if facts.docker_desktop_path.is_empty() {
        std::env::var("ProgramFiles")
            .map(|root| format!("{root}\\Docker\\Docker"))
            .unwrap_or_default()
    } else {
        std::path::Path::new(&facts.docker_desktop_path)
            .parent()
            .map(|dir| dir.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    let cli = format!("{root}\\DockerCli.exe");
    if !std::path::Path::new(&cli).exists() {
        return Err(Trouble::Failed(
            "could not find Docker Desktop's own switcher. Right-click Docker's tray icon and choose \"Switch to Linux containers\", then re-run.".to_string(),
        ));
    }
    let quoted = cli.replace('\'', "''");
    let output = shell::run(&format!(
        "$ErrorActionPreference = 'Continue'\n& '{quoted}' -SwitchLinuxEngine\nexit $LASTEXITCODE\n"
    ));
    if !output.ok {
        return Err(Trouble::Failed(
            "could not switch Docker to Linux containers. Right-click Docker's tray icon and choose \"Switch to Linux containers\", then re-run.".to_string(),
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
        "could not restart this PC ({}). Restart it yourself, then run the setup again.",
        output.stderr.trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    // The struct is only USED here on Windows (see this file's header), but the substitution it feeds is
    // pure, so the test that guards it runs on every runner.
    use crate::prepare::plan::Facts;

    /* The bodies above are Windows-only and are covered by the Windows smoke tiers. What is worth asserting
     * on every runner is the constants they are built from: a download URL and a flag set are the two things
     * here that can be silently wrong for months. */

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

    /* THE REPORTED FAILURE, PINNED AT ITS CAUSE. `net localgroup` answers exit 2 for "the group already
     * exists", exit 2 for "already a member", and exit 2 for a genuine refusal. A real install stopped at 8%
     * with "adding this account to docker-users failed (exit 2)" seconds after Docker Desktop's own installer
     * had added that very account — the fix had succeeded before it ran, and it called that a failure.
     *
     * So the script must decide from the ROSTER and never from the exit code, and this is the assertion that
     * keeps a future edit from quietly putting `exit $LASTEXITCODE` back on the end. */
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

    #[test]
    fn done_distinguishes_the_two_fixes_that_do_not_take_effect_yet() {
        // The whole reason this enum has three values rather than being a bool.
        assert_ne!(Done::Now, Done::AfterRestart);
        assert_ne!(Done::Now, Done::AfterSignOut);
        assert_ne!(Done::AfterRestart, Done::AfterSignOut);
    }
}
