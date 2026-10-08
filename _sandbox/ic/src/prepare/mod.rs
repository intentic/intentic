pub mod facts;
pub mod fix;
pub mod plan;
pub mod shell;
pub mod watch;

#[cfg(windows)]
use crate::util::bail;
use crate::util::Result;

/* `ic docker prepare` — GET THIS MACHINE TO A RUNNING DOCKER, OR SAY EXACTLY WHY NOT. */

/// Unix reads neither field — its Docker install belongs to connect.sh, and this is a verdict there. The
/// allow is narrower than a `cfg`: the shape of the command is the same on both, and only the flow differs.
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Args {
    /// Consent, pre-given. `-y` from the shims, or INSTALL_DOCKER=1 from the desktop app.
    pub yes: bool,
    /// Report and change nothing. What support asks for, and what the smoke tier runs.
    pub dry_run: bool,
}

/* THE TWO WAYS THIS COMMAND STOPS WITHOUT ANYTHING BEING WRONG — as exit codes, because a caller must not have to read prose to tell them from a crash. */

/// Requirements were found and reported, and NOTHING was changed — the caller has the list and has to come
/// back with consent (`-y`, or `INSTALL_DOCKER=1`).
#[cfg_attr(not(windows), allow(dead_code))]
pub const EXIT_NEEDS_CONSENT: i32 = 3;
/// Windows has to end this session — a restart, or a sign-out — before the setup can go further. Everything
/// that could be done has been. One code for both because they are one idea as far as any caller is
/// concerned: nothing is wrong, nothing more can happen in THIS session, and the setup resumes in the next.
#[cfg_attr(not(windows), allow(dead_code))]
pub const EXIT_NEEDS_RESTART: i32 = 4;

/// Whether anything is parsing this output. The same test ui.rs uses to pick its mode, asked here because
/// the markers below are for a reader that has no screen — in a terminal they are a screenful of JSON in
/// the middle of the one screen somebody is trying to read.
#[cfg(windows)]
fn piped() -> bool {
    use std::io::IsTerminal;
    !std::io::stdout().is_terminal()
}

/// The machine-readable half of a requirement, for the desktop app. A DIFFERENT prefix from `intentic: [x] y`
/// on purpose: that vocabulary moves a progress bar, and a requirement is not a step. The app's parser would
/// otherwise see a phase called `requirement` and slide its cursor to a step that does not exist.
#[cfg(windows)]
fn announce(requirement: &plan::Requirement) {
    if !piped() {
        return;
    }
    let line = serde_json::json!({
        "id": requirement.id,
        "title": requirement.title,
        "problem": requirement.problem,
        "remedy": requirement.remedy,
        "action": requirement.action.id(),
        "detail": requirement.detail,
    });
    println!("intentic-requirement: {line}");
}

/* WHAT IS HAPPENING TO ONE REQUIREMENT, RIGHT NOW — the marker that turns a list into a live checklist. */
#[cfg(windows)]
fn announce_state(id: &str, state: &str, detail: Option<&str>) {
    announce_live(id, state, detail, Live::default());
}

/// What a live reading carries besides its sentence, for an app to DRAW rather than read: a bar that fills, and a
/// row that turns to the person when the wait is on them. Both left out of the marker when unset, so an app from
/// before them sees exactly the marker it always did and draws the sentence under a spinner, which is right too.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Live {
    /// The row is waiting on the PERSON (Windows' permission prompt), not on the machine.
    pub needs_you: bool,
    /// How far through a measured job (the download), 0 to 100.
    pub percent: Option<u64>,
}

#[cfg(any(windows, test))]
fn live_marker(id: &str, state: &str, detail: Option<&str>, live: Live) -> serde_json::Value {
    let mut line = serde_json::json!({ "id": id, "state": state, "detail": detail });
    if live.needs_you {
        line["needs"] = serde_json::json!("you");
    }
    if let Some(percent) = live.percent {
        line["percent"] = serde_json::json!(percent.min(100));
    }
    line
}

#[cfg(windows)]
fn announce_live(id: &str, state: &str, detail: Option<&str>, live: Live) {
    if !piped() {
        return;
    }
    println!(
        "intentic-requirement-state: {}",
        live_marker(id, state, detail, live)
    );
}

/// Which requirement the fixes below are currently working on, so their progress readings can be attributed
/// to a row rather than being loose lines in a log. Set by [`apply`] around one fix at a time — the flow is
/// strictly sequential, which is why one slot is enough.
#[cfg(windows)]
static WORKING_ON: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);

/// A CHANGING MEASUREMENT while a requirement is being fixed — what [`fix`] calls instead of `ui::progress`.
/// It still prints the human line (the log is a trail, and the timings in it are the only record of where a
/// slow install went); it additionally attributes the reading to the row the app is drawing.
#[cfg(windows)]
pub fn progress(text: &str) {
    crate::ui::progress(text);
    let working_on = WORKING_ON
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(id) = *working_on {
        announce_state(id, "running", Some(text));
    }
}

/// A reading that changes every second (a clock, a download): the row's detail and the screen's live line, never
/// a line of its own in the log. Milestones still go through [`progress`], so the log keeps its trail.
#[cfg(windows)]
pub fn live(text: &str, live: Live) {
    crate::ui::live(text);
    let working_on = WORKING_ON
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(id) = *working_on {
        announce_live(id, "running", Some(text), live);
    }
}

/// A reading for one named row, from work running BESIDE the fix the flow is on (the Docker Desktop download, on its
/// own thread while WSL2 is turned on). The row always gets it; the screen's live line only when no other fix owns it,
/// so two jobs do not take turns repainting one line.
#[cfg(windows)]
pub fn live_for(id: &str, text: &str, live: Live) {
    let foreground = WORKING_ON
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_none_or(|working_on| working_on == id);
    if foreground {
        crate::ui::live(text);
    }
    announce_live(id, "running", Some(text), live);
}

/// What can still be done in the session that turning WSL2 on has to end with a restart: what needs no running WSL.
/// The Docker Desktop download and install are the long ones, and doing them now is what makes that restart the only
/// one; starting Docker, and anything that asks its engine, waits for the next session.
#[cfg_attr(not(windows), allow(dead_code))]
const BEFORE_RESTART: [&str; 2] = ["docker-desktop", "docker-path"];

/// What an elevated fix says while it runs: who it is waiting on, and for how long. `what` is the work, in a
/// reader's words ("Turning on WSL2"); `stage` is asked each second for where that work is, when it can say.
/// The two edges, the prompt going up and being answered, are also logged once, as the trail of where time went.
#[cfg(windows)]
pub fn elevated_watch<'a>(
    what: &'a str,
    mut stage: impl FnMut() -> Option<String> + 'a,
) -> impl FnMut(shell::Elevation) + 'a {
    let mut seen_asking = false;
    let mut seen_running = false;
    let mut last_stage: Option<String> = None;
    move |at| match at {
        shell::Elevation::Asking(waited) => {
            if !seen_asking {
                seen_asking = true;
                crate::ui::note("waiting for Windows' permission prompt to be answered...");
            }
            live(
                &watch::asking(waited),
                Live {
                    needs_you: true,
                    percent: None,
                },
            );
        }
        shell::Elevation::Running(elapsed) => {
            if !seen_running {
                seen_running = true;
                crate::ui::note("permission given; working...");
            }
            let now = stage();
            if now.is_some() && now != last_stage {
                if let Some(said) = &now {
                    crate::ui::note(&format!("{what}: {said}"));
                }
                last_stage = now.clone();
            }
            live(
                &watch::working(what, now.as_deref(), elapsed),
                Live::default(),
            );
        }
    }
}

/// The checklist, as the terminal draws it. Same row vocabulary as checks::print_row, because a user meeting
/// both in one run should not have to learn two.
#[cfg(windows)]
fn draw(facts: &plan::Facts) {
    use crate::ui::{self, RowOutcome};

    ui::note(&plan::summary(facts));
    for row in plan::checklist(facts) {
        match row.state {
            plan::RowState::Ok => ui::row(RowOutcome::Pass, row.area, ""),
            // The row vocabulary is shared with checks::print_row on purpose — a Windows user meets both
            // checklists in one run and should not have to learn two.
            plan::RowState::Failed(problem) => ui::row(RowOutcome::Fail, row.area, &problem),
            plan::RowState::Unjudged => ui::row(RowOutcome::Skip, row.area, "not checked yet"),
        }
    }
    for note in plan::advisories(facts) {
        ui::row(RowOutcome::Warn, &note, "");
    }
}

/// The block a stopped run ends on: every unmet requirement, with what to do about it, and the long form
/// where there is one. The same shape checks::failure_summary produces, so the two halves of a failed setup
/// read alike.
#[cfg(windows)]
fn explain(unmet: &[plan::Requirement]) -> String {
    let mut text = if unmet.len() == 1 {
        "1 thing is in the way:\n".to_string()
    } else {
        format!("{} things are in the way:\n", unmet.len())
    };
    for (index, requirement) in unmet.iter().enumerate() {
        text.push_str(&format!(
            "\n  {}. {}\n     problem: {}\n     fix:     {}\n",
            index + 1,
            requirement.title,
            requirement.problem,
            requirement.remedy
        ));
        if let Some(detail) = &requirement.detail {
            text.push('\n');
            for line in detail.lines() {
                text.push_str(&format!("     {line}\n"));
            }
        }
    }
    text
}

#[cfg(windows)]
pub fn run(args: Args) -> Result<()> {
    use crate::util::step;
    use plan::Action;

    step("checking-docker", "checking this PC for Docker...");
    let mut facts = facts::probe().map_err(crate::util::Fail)?;
    draw(&facts);

    let unmet = plan::requirements(&facts);
    if unmet.is_empty() {
        crate::ui::note("Docker is ready on this PC.");
        return Ok(());
    }
    for requirement in &unmet {
        announce(requirement);
    }

    // Things nobody here can do anything about — firmware, a host machine's settings, a PC this build does
    // not run on, a full disk. Reported and stopped on, without asking to change anything: consent for work
    // that cannot happen is a question with no honest answer.
    //
    // A restart and a sign-out are NOT in that set. Both are things this flow knows how to park on and come
    // back from, and both have their own screen below; listing them here would report a machine that is one
    // session away from ready as one that cannot run a sandbox.
    let stuck: Vec<plan::Requirement> = unmet
        .iter()
        .filter(|requirement| {
            !requirement.action.ours()
                && requirement.action != Action::Restart
                && requirement.action != Action::SignOut
        })
        .cloned()
        .collect();
    if !stuck.is_empty() {
        bail!("{}", explain(&stuck));
    }

    // Report-only, by request. Everything left on the list is ours to fix (the `stuck` check above already
    // took the ones that are not, as a real failure), so this is the consent stop with the asking left out.
    if args.dry_run {
        println!("{}", explain(&unmet));
        stop(
            EXIT_NEEDS_CONSENT,
            "nothing was changed - this was a dry run.",
        );
    }

    // A restart Windows was already waiting for, with nothing else to do first.
    if unmet.iter().all(|r| r.action == Action::Restart) {
        return restart(&unmet, args.yes);
    }
    /* A stale login token cannot reach Docker until the user signs in again. */
    if let Some(stale) = unmet.iter().find(|r| r.action == Action::SignOut) {
        return sign_out(std::slice::from_ref(stale), &facts.user);
    }

    consent(&unmet, args.yes)?;

    // The 600 MB download starts now, on its own thread, rather than when its turn in the list comes: it then runs
    // while Windows' permission prompt for WSL2 waits on the person and while the features are turned on, which is
    // minutes on most PCs. The install itself still takes its turn (`apply`).
    let mut docker_download = unmet.iter().any(|r| r.id == "docker-desktop").then(|| {
        announce_state(
            "docker-desktop",
            "running",
            Some("downloading Docker Desktop alongside the other steps..."),
        );
        std::thread::spawn(|| fix::download_installer(&fix::installer_path(), "docker-desktop"))
    });

    /* Fixes change the machine under their own diagnosis: installing Docker Desktop makes `docker-desktop` go away and `docker-path` appear. */
    let mut previous: Vec<&'static str> = unmet.iter().map(|r| r.id).collect();
    // Set once a fix has left Windows needing a restart (turning WSL2 on): the rest of the list is still worked through,
    // but only what needs no running WSL (`BEFORE_RESTART`), and the restart is asked for at the end, once.
    let mut restart_after: Option<plan::Requirement> = None;
    for pass in 0..3 {
        if pass > 0 {
            facts = facts::probe().map_err(crate::util::Fail)?;
        }
        let todo = plan::requirements(&facts);
        if todo.is_empty() {
            break;
        }
        let ids: Vec<&'static str> = todo.iter().map(|r| r.id).collect();
        if pass > 0 && ids == previous {
            bail!(
                "{}",
                format!(
                    "nothing changed after trying to fix it:\n{}",
                    explain(&todo)
                )
            );
        }
        previous = ids;

        for requirement in &todo {
            if restart_after.is_some() && !BEFORE_RESTART.contains(&requirement.id) {
                continue;
            }
            // Uncovered by an earlier fix in this very pass: installing Docker Desktop adds the account to
            // docker-users itself, so the requirement that was a UAC prompt when the list was drawn is a
            // sign-out by the time we reach it. Parked properly rather than reported as a wall.
            if requirement.action == Action::SignOut {
                announce(requirement);
                announce_state(requirement.id, "done", Some("waiting for the next sign-in"));
                return sign_out_or_restart(requirement, &facts.user, args.yes);
            }
            // A fix in the last pass left Windows waiting for a restart (the Docker Desktop installer does): the
            // same parking as the examination's, not the wall below, which would report a machine one restart
            // from ready as a failure.
            if requirement.action == Action::Restart {
                announce(requirement);
                return restart(std::slice::from_ref(requirement), args.yes);
            }
            if !requirement.action.ours() {
                // Reached only when a fix uncovered something new that is not ours (a full disk, say). Report
                // it the same way the first round would have.
                for uncovered in &todo {
                    announce(uncovered);
                }
                bail!("{}", explain(&todo));
            }
            let outcome = match apply(requirement, &facts, &mut docker_download) {
                Ok(outcome) => outcome,
                // A restart is coming anyway, and the next session retries whatever failed before it (a download
                // cut by the network resumes where it stopped): the failure is on its row, and the restart still
                // goes ahead rather than leaving the PC halfway with a wall of red.
                Err(failure) if restart_after.is_some() => {
                    crate::ui::warn(&format!(
                        "{}: {} - the setup tries again after the restart.",
                        requirement.title, failure.0
                    ));
                    continue;
                }
                Err(failure) => return Err(failure),
            };
            match outcome {
                Outcome::Continue => {}
                Outcome::Restart => {
                    let mut pending = requirement.clone();
                    pending.action = Action::Restart;
                    pending.remedy =
                        "restart this PC and run the same command again - the setup picks up from here."
                            .to_string();
                    announce(&pending);
                    // Done as far as anything here can take it — the row is finished, and what is left is
                    // the machine going down and coming back.
                    announce_state(requirement.id, "done", Some("waiting for the restart"));
                    restart_after = Some(pending);
                }
                /* The fix worked and changed nothing yet, which is the whole point of `Done::AfterSignOut`. */
                // Two fixes end here: granting the group, and starting an engine that then refuses the
                // account. Either way the row that was being worked on is finished, and what is left is the
                // one requirement plan.rs builds for exactly this — the same words the examination uses.
                // The restart already coming is a new sign-in too.
                Outcome::SignOut if restart_after.is_some() => {
                    announce_state(requirement.id, "done", Some("waiting for the restart"));
                }
                Outcome::SignOut => {
                    let pending = plan::sign_out_requirement(&facts);
                    announce_state(requirement.id, "done", None);
                    announce(&pending);
                    announce_state(pending.id, "done", Some("waiting for the next sign-in"));
                    return sign_out_or_restart(&pending, &facts.user, args.yes);
                }
            }
        }
        if let Some(pending) = restart_after.take() {
            return restart(std::slice::from_ref(&pending), args.yes);
        }
    }

    // The verdict is the machine's, not the fixer's: re-examine and believe that.
    facts = facts::probe().map_err(crate::util::Fail)?;
    let left = plan::requirements(&facts);
    if !left.is_empty() {
        for requirement in &left {
            announce(requirement);
        }
        bail!("{}", explain(&left));
    }
    step("checking-docker", "Docker is ready.");
    Ok(())
}

/// What one fix left behind.
#[cfg(windows)]
enum Outcome {
    Continue,
    Restart,
    SignOut,
}

#[cfg(windows)]
fn apply(
    requirement: &plan::Requirement,
    facts: &plan::Facts,
    docker_download: &mut Option<std::thread::JoinHandle<std::result::Result<(), String>>>,
) -> Result<Outcome> {
    use crate::util::step;

    let doing = match requirement.id {
        "wsl-features" => {
            "turning on the Windows features Docker needs (Windows will ask for permission)..."
        }
        "wsl-kernel" => "updating WSL2 (Windows will ask for permission)...",
        "docker-desktop" => "downloading and installing Docker Desktop (about 600 MB)...",
        "docker-path" => "finding Docker on this PC...",
        "docker-users" => {
            "allowing this account to use Docker (Windows will ask for permission)..."
        }
        "docker-running" => "starting Docker Desktop (accept its welcome screen if one appears)...",
        "docker-linux-containers" => "switching Docker to Linux containers...",
        _ => "preparing Docker...",
    };
    step("installing-docker", doing);
    // The row this fix belongs to starts moving before the fix does, so the app can draw it as working
    // rather than as still-pending through however many minutes it takes.
    announce_state(requirement.id, "running", Some(doing));
    *WORKING_ON
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(requirement.id);

    let outcome = match requirement.id {
        "wsl-features" => fix::enable_wsl_features(),
        "wsl-kernel" => fix::update_wsl_kernel(),
        "docker-desktop" => fix::install_docker_desktop(docker_download.take()),
        "docker-path" => fix::put_docker_on_path(facts),
        "docker-users" => fix::add_to_docker_users(facts),
        "docker-running" => fix::start_docker_desktop(facts).and_then(|_| fix::wait_for_daemon()),
        "docker-linux-containers" => fix::switch_to_linux_containers(facts),
        other => Err(fix::Trouble::Failed(format!(
            "no idea how to fix '{other}' - this is a bug in intentic, please report it."
        ))),
    };
    // Whatever happened, nothing after this point is this requirement's progress.
    *WORKING_ON
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;

    match outcome {
        Ok(fix::Done::Now) => {
            crate::ui::row(crate::ui::RowOutcome::Pass, &requirement.title, "");
            announce_state(requirement.id, "done", None);
            Ok(Outcome::Continue)
        }
        Ok(fix::Done::AfterRestart) => Ok(Outcome::Restart),
        Ok(fix::Done::AfterSignOut) => Ok(Outcome::SignOut),
        // Dismissing the prompt is an ANSWER, and it gets its own sentence: "failed" would be an accusation
        // about a machine that is fine and a decision that was deliberate.
        Err(fix::Trouble::Cancelled) => {
            let reason = format!(
                "Windows asked for permission and the prompt was closed, so nothing was changed for \"{}\". Try again and choose Yes when Windows asks.",
                requirement.title
            );
            announce_state(requirement.id, "failed", Some(reason.as_str()));
            bail!("{reason}")
        }
        // Not an answer at all: the prompt waited, closed itself, was asked again and waited out again.
        Err(fix::Trouble::Unanswered) => {
            let reason = format!(
                "Windows' permission prompt for \"{}\" closed itself twice without an answer, so nothing was changed. Try again, and when Windows asks, choose Yes: if no prompt shows, look for a flashing shield on the taskbar.",
                requirement.title
            );
            announce_state(requirement.id, "failed", Some(reason.as_str()));
            bail!("{reason}")
        }
        Err(fix::Trouble::Failed(problem)) => {
            announce_state(requirement.id, "failed", Some(problem.as_str()));
            bail!("{problem}")
        }
    }
}

/* Turning on WSL2 succeeds and does nothing until Windows restarts, and this is the moment where a setup that merely SAYS so gets abandoned. */
#[cfg(windows)]
fn restart(unmet: &[plan::Requirement], pre_consented: bool) -> Result<()> {
    use crate::tty;

    // A restart request owns the screen: the live step line is erased and the spinner stopped, or it repaints
    // over the one command the reader has to copy before rebooting.
    crate::ui::suspend();
    println!();
    println!("{}", explain(unmet));
    println!("Windows has to restart before Docker can run.");
    println!();
    println!("{}", resume_hint("After it comes back"));
    println!();
    /* Pre-consent covers installing things, never a restart: the desktop app passes it. */
    if !pre_consented && tty::have_tty() && tty::confirm("Restart this PC now?", false) {
        fix::restart_windows().map_err(crate::util::Fail)?;
        stop(
            EXIT_NEEDS_RESTART,
            "this PC is restarting in 10 seconds - run the command above once it is back.",
        );
    }
    stop(
        EXIT_NEEDS_RESTART,
        if unattended() {
            "this PC has to restart before Docker can run."
        } else {
            "this PC has to restart before Docker can run - restart it, then run the command above."
        },
    )
}

/// A FIX THAT ENDS ON A SIGN-OUT, on a PC that is also waiting for a restart: the restart is a new sign-in too.
/// Asking for the sign-out first sent a reader through it, back into the setup, and on to the restart it found
/// next — or, more often, away. Installing Docker Desktop is what leaves both behind, in the same minute.
#[cfg(windows)]
fn sign_out_or_restart(pending: &plan::Requirement, user: &str, pre_consented: bool) -> Result<()> {
    let restart_waiting = facts::probe()
        .map(|now| now.reboot_pending)
        .unwrap_or(false);
    if restart_waiting {
        let both = plan::restart_requirement();
        announce(&both);
        return restart(std::slice::from_ref(&both), pre_consented);
    }
    sign_out(std::slice::from_ref(pending), user)
}

/* THE SAME PARKING, ONE SESSION SMALLER — and the outcome that used to leave through `bail!`. */
#[cfg(windows)]
fn sign_out(unmet: &[plan::Requirement], user: &str) -> Result<()> {
    let who = if user.is_empty() {
        "this account"
    } else {
        user
    };
    crate::ui::suspend();
    println!();
    println!("{}", explain(unmet));
    println!("{who} has the permission already. Windows hands it out with a new sign-in,");
    println!("and only then - so nothing else can happen first.");
    println!();
    println!("{}", resume_hint("After you sign back in"));
    println!();
    stop(
        EXIT_NEEDS_RESTART,
        if unattended() {
            "sign out of Windows and back in; if you already have, restart the PC instead."
        } else {
            "sign out of Windows and back in, then run the command above."
        },
    )
}

/// Whether something other than a person started this run — the desktop app says so outright
/// (`INTENTIC_NO_PROMPT`, docs/ops/cli-output-protocol.md, "Prompts"), and it parks the setup and brings it
/// back itself, so telling its user to paste a command into a terminal they do not have is worse than saying
/// nothing.
#[cfg(windows)]
fn unattended() -> bool {
    std::env::var("INTENTIC_NO_PROMPT").as_deref() == Ok("1")
}

/// What happens next, for whoever is reading: a saved setup that resumes on its own, or the command to
/// paste — with a code that may well have expired by then named as such.
#[cfg(windows)]
fn resume_hint(when: &str) -> String {
    if unattended() {
        return "Your setup is saved: it continues on its own once you are back.".to_string();
    }
    format!("{when}, run this again:\n\n  {}", rerun_command())
}

/* AN EXPECTED STOP, SAID AS ONE. */
#[cfg(windows)]
fn stop(code: i32, message: &str) -> ! {
    crate::ui::note(message);
    std::process::exit(code)
}

/// The command to paste after the restart, rebuilt from what this run was given. A setup code that will have
/// expired by then is named as such rather than handed over as if it still worked — codes last 30 minutes and
/// a Windows feature install plus a restart can eat most of that.
#[cfg(windows)]
fn rerun_command() -> String {
    match std::env::var("SETUP_CODE").ok().filter(|c| !c.is_empty()) {
        Some(code) => format!(
            "$env:SETUP_CODE='{code}'; irm https://intentic.dev/connect.ps1 | iex\n\n  \
             (that code expires 30 minutes after it was issued - if it has, open the setup page again for a fresh one)"
        ),
        None => "irm https://intentic.dev/connect.ps1 | iex".to_string(),
    }
}

/// ONE question, covering everything. Asked once, before anything is touched — the alternative is four
/// prompts in a row on a fresh PC, which is how a setup starts feeling like an interrogation.
#[cfg(windows)]
fn consent(unmet: &[plan::Requirement], pre_consented: bool) -> Result<()> {
    use crate::tty;

    if pre_consented {
        return Ok(());
    }
    // Same handover as the restart below — a question is not narration and must not be repainted over.
    crate::ui::suspend();
    println!();
    println!("To run a sandbox here, this needs to happen:");
    for requirement in unmet {
        println!("  - {}", requirement.remedy);
    }
    println!();
    println!("Docker Desktop is Docker Inc.'s software and its own licence applies:");
    println!("  https://www.docker.com/legal/docker-subscription-service-agreement");
    println!();
    if !tty::have_tty() {
        /* The desktop app's first setup pass enters here. */
        stop(
            EXIT_NEEDS_CONSENT,
            "nothing has been changed yet - re-run with -y (or INSTALL_DOCKER=1) to go ahead with the list above.",
        );
    }
    if !tty::confirm("Go ahead?", false) {
        stop(EXIT_NEEDS_CONSENT, "nothing was changed.");
    }
    println!();
    crate::ui::resume();
    Ok(())
}

/* Unix keeps its own route. */
#[cfg(not(windows))]
pub fn run(_args: Args) -> Result<()> {
    crate::util::step("checking-docker", "checking Docker...");
    crate::docker::require_daemon()?;
    println!("  Docker is ready on this machine.");
    Ok(())
}

#[cfg(test)]
mod tests {
    /* The flow above is Windows-only; its DECISIONS are plan.rs's and are tested there against fact literals, on every runner. */

    use super::{live_marker, Live};

    /* The app's parser (desktop.ts `parseRequirementState`) reads these fields by these names. */
    #[test]
    fn a_live_marker_carries_its_bar_and_its_ask_only_when_it_has_them() {
        let plain = live_marker("docker-desktop", "running", Some("x"), Live::default());
        assert_eq!(
            plain.to_string(),
            r#"{"detail":"x","id":"docker-desktop","state":"running"}"#,
            "an older app must see the marker it always did"
        );
        let download = live_marker(
            "docker-desktop",
            "running",
            Some("y"),
            Live {
                needs_you: false,
                percent: Some(35),
            },
        );
        assert_eq!(download["percent"], 35);
        assert!(download.get("needs").is_none());
        let asking = live_marker(
            "docker-desktop",
            "running",
            Some("z"),
            Live {
                needs_you: true,
                percent: None,
            },
        );
        assert_eq!(asking["needs"], "you");
        assert!(asking.get("percent").is_none());
        let over = live_marker(
            "docker-desktop",
            "running",
            None,
            Live {
                needs_you: false,
                percent: Some(140),
            },
        );
        assert_eq!(over["percent"], 100);
    }

    #[test]
    fn the_requirement_marker_cannot_be_mistaken_for_a_step() {
        // The app's own regex, copied from desktop-app/src/desktop.ts.
        let looks_like_a_step = |line: &str| {
            line.starts_with("intentic: [")
                && line
                    .trim_start_matches("intentic: [")
                    .split_once(']')
                    .is_some_and(|(phase, rest)| {
                        !phase.is_empty()
                            && phase.chars().all(|c| c.is_ascii_lowercase() || c == '-')
                            && rest.starts_with(' ')
                    })
        };
        assert!(looks_like_a_step("intentic: [checking-docker] checking..."));
        assert!(
            !looks_like_a_step("intentic-requirement: {\"id\":\"virtualization\"}"),
            "the requirement marker must not parse as a phase"
        );
    }
}
