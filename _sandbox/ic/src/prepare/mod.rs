pub mod facts;
pub mod fix;
pub mod plan;
pub mod shell;

#[cfg(windows)]
use crate::util::bail;
use crate::util::Result;

/* `ic docker prepare` — GET THIS MACHINE TO A RUNNING DOCKER, OR SAY EXACTLY WHY NOT.
 *
 * This is the flow that replaced fourteen lines of connect.ps1. Those lines asked two questions — is `docker`
 * on PATH, does `docker info` answer — and turned every "no" into one of three sentences, the most common of
 * which was "docker is not installed and winget is unavailable", a dead end on a machine where nothing was
 * actually wrong except the route.
 *
 * What replaces it is: examine the machine once (facts.rs), read the examination (plan.rs), show the whole
 * checklist, ask ONE question covering everything that has to change, and then do it (fix.rs) — re-examining
 * between passes so each round sees the machine as the last round left it, not as it was at the start.
 *
 * THREE READERS, ONE RUN. A person at a terminal gets the checklist and the question. The desktop app gets
 * the same lines plus one `intentic-requirement:` per unmet requirement, which is what its cards are drawn
 * from — it has no terminal to answer a question on, so its first pass ends here with the list and its second
 * carries the consent back as INSTALL_DOCKER=1. And the platform's setup page gets the same diagnosis a
 * moment later, because `ic sandbox connect`'s preflight asks plan.rs the same question (checks.rs). */

/// Unix reads neither field — its Docker install belongs to connect.sh, and this is a verdict there. The
/// allow is narrower than a `cfg`: the shape of the command is the same on both, and only the flow differs.
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Args {
    /// Consent, pre-given. `-y` from the shims, or INSTALL_DOCKER=1 from the desktop app.
    pub yes: bool,
    /// Report and change nothing. What support asks for, and what the smoke tier runs.
    pub dry_run: bool,
}

/* THE TWO WAYS THIS COMMAND STOPS WITHOUT ANYTHING BEING WRONG — as exit codes, because a caller must not
 * have to read prose to tell them from a crash.
 *
 * The desktop app's FIRST pass is designed to end here: examine, report, change nothing, wait to be asked
 * again with consent. Until now that ended the same way a genuine failure does — `exit 1` and a line on
 * stderr reading "there is no terminal to ask on, so nothing was changed" — which is a developer's sentence
 * describing normal behaviour, and it is what a user meets whenever the requirement lines fail to reach the
 * screen for any other reason. One reported install ended exactly there with nothing on screen at all.
 *
 * So the expected stops get their own codes. The app maps them to "here is what this PC needs" and never to
 * a red box; a terminal user sees the same checklist it always did; a script still stops, because both are
 * non-zero. 3 and 4 are chosen to sit above the 1 that means "it broke" and below the 125+ range shells
 * reserve for their own signalling. */

/// Requirements were found and reported, and NOTHING was changed — the caller has the list and has to come
/// back with consent (`-y`, or `INSTALL_DOCKER=1`).
#[cfg_attr(not(windows), allow(dead_code))]
pub const EXIT_NEEDS_CONSENT: i32 = 3;
/// Windows has to restart before the setup can go further. Everything that could be done has been.
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

/* WHAT IS HAPPENING TO ONE REQUIREMENT, RIGHT NOW — the marker that turns a list into a live checklist.
 *
 * `intentic-requirement:` says a thing is unmet. It says nothing at all about the ten minutes that follow,
 * during which the app could draw exactly one row — "Set up Docker" — with a spinner on it, while WSL2 was
 * turned on, 600 MB came down, an installer ran, an engine started and a daemon was waited for. The reader
 * with the least patience in this whole flow is the one on a machine that needs the most work, and they were
 * the one shown the least.
 *
 * So each requirement reports its own state as it is worked through, and the `detail` carries the changing
 * measurement under it — the megabytes, the seconds left on the engine wait. Same prefix family as the
 * announcement and the same rule: pipes only, never a phase id, so nothing here can move a progress bar. */
#[cfg(windows)]
fn announce_state(id: &str, state: &str, detail: Option<&str>) {
    if !piped() {
        return;
    }
    let line = serde_json::json!({ "id": id, "state": state, "detail": detail });
    println!("intentic-requirement-state: {line}");
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
    let stuck: Vec<plan::Requirement> = unmet
        .iter()
        .filter(|requirement| !requirement.action.ours() && requirement.action != Action::Restart)
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

    consent(&unmet, args.yes)?;

    /* PASS BY PASS, RE-EXAMINING IN BETWEEN.
     *
     * Fixes change the machine under their own diagnosis: installing Docker Desktop makes `docker-desktop`
     * go away and `docker-path` appear, since a program installed thirty seconds ago is on nobody's PATH.
     * A single pass down the original list would either miss that or need the list to predict its own
     * consequences, and the second is how you get a fixer that is wrong about a machine it just changed.
     *
     * Three passes is the ceiling, and the no-progress guard below is the real stop: a fix that reports
     * success and changes nothing would otherwise loop until the ceiling, three times as slowly. */
    let mut previous: Vec<&'static str> = unmet.iter().map(|r| r.id).collect();
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
            if !requirement.action.ours() {
                // Reached only when a fix uncovered something new that is not ours (a full disk, say). Report
                // it the same way the first round would have.
                for uncovered in &todo {
                    announce(uncovered);
                }
                bail!("{}", explain(&todo));
            }
            match apply(requirement, &facts)? {
                Outcome::Continue => {}
                Outcome::Restart => {
                    let mut pending = vec![requirement.clone()];
                    pending[0].action = Action::Restart;
                    pending[0].remedy =
                        "restart this PC and run the same command again - the setup picks up from here."
                            .to_string();
                    for entry in &pending {
                        announce(entry);
                    }
                    // Done as far as anything here can take it — the row is finished, and what is left is
                    // the machine going down and coming back.
                    announce_state(requirement.id, "done", Some("waiting for the restart"));
                    return restart(&pending, args.yes);
                }
                Outcome::SignOut => {
                    let mut pending = requirement.clone();
                    pending.action = Action::SignOut;
                    pending.remedy =
                        "sign out of Windows and back in, then run the same command again."
                            .to_string();
                    announce(&pending);
                    announce_state(requirement.id, "done", Some("waiting for the next sign-in"));
                    bail!(
                        "{} was added to the docker-users group, but Windows only picks that up on the next sign-in.\n       Sign out and back in, then run the same command again.",
                        if facts.user.is_empty() { "this account" } else { &facts.user }
                    );
                }
            }
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
fn apply(requirement: &plan::Requirement, facts: &plan::Facts) -> Result<Outcome> {
    use crate::util::step;

    let doing = match requirement.id {
        "wsl-features" => "turning on WSL2 (Windows will ask for administrator)...",
        "wsl-kernel" => "updating WSL2...",
        "docker-desktop" => "installing Docker Desktop (about 600 MB)...",
        "docker-path" => "finding Docker on this PC...",
        "docker-users" => "allowing this account to use Docker...",
        "docker-running" => {
            "starting Docker Desktop (accept its first-run screens if they appear)..."
        }
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
        "docker-desktop" => fix::install_docker_desktop(facts),
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
            announce_state(
                requirement.id,
                "failed",
                Some("the administrator prompt was dismissed"),
            );
            bail!(
                "the administrator prompt was dismissed, so {} was not changed.\n       Run the same command again and choose Yes when Windows asks.",
                requirement.title.to_lowercase()
            )
        }
        Err(fix::Trouble::Failed(problem)) => {
            announce_state(requirement.id, "failed", Some(problem.as_str()));
            bail!("{problem}")
        }
    }
}

/* THE RESTART, WHICH IS THE ONE PLACE A SETUP CAN LOSE SOMEBODY.
 *
 * Turning on WSL2 succeeds and does nothing until Windows restarts, and this is the moment where a setup that
 * merely SAYS so gets abandoned: the user is now several minutes in, has answered a UAC prompt, and is being
 * asked to reboot and then find the command again.
 *
 * So: offer to do it, and say what to run afterwards either way. The desktop app takes the other route
 * entirely — it has already been handed the requirement above, and it remembers the setup across the restart
 * so nothing has to be found again. */
#[cfg(windows)]
fn restart(unmet: &[plan::Requirement], pre_consented: bool) -> Result<()> {
    use crate::tty;

    let again = rerun_command();
    // A restart request owns the screen: the live step line is erased and the spinner stopped, or it repaints
    // over the one command the reader has to copy before rebooting.
    crate::ui::suspend();
    println!();
    println!("{}", explain(unmet));
    println!("Windows has to restart before Docker can run.");
    println!();
    println!("After it comes back, run this again:");
    println!();
    println!("  {again}");
    println!();
    /* Pre-consent covers installing things, never a restart: the desktop app passes it, and a window that
     * rebooted somebody's PC without a second click would be indefensible. It shows its own button instead.
     *
     * And either way this ends NON-ZERO. A restart scheduled ten seconds from now is not a run that
     * succeeded — the caller (connect.ps1, and the app behind it) has to stop here rather than march on into
     * a sandbox launch on a machine that is about to go down. */
    if !pre_consented && tty::have_tty() && tty::confirm("Restart this PC now?", false) {
        fix::restart_windows().map_err(crate::util::Fail)?;
        stop(
            EXIT_NEEDS_RESTART,
            "this PC is restarting in 10 seconds - run the command above once it is back.",
        );
    }
    stop(
        EXIT_NEEDS_RESTART,
        "this PC has to restart before Docker can run - restart it, then run the command above.",
    )
}

/* AN EXPECTED STOP, SAID AS ONE. Everything above that ends a run through `bail!` is reported by main as
 * `error: …`, in red, on stderr — which is right for a failure and wrong for the two outcomes this command
 * is DESIGNED to reach: a machine that needs consent, and a machine that needs a restart. Neither is
 * anything going wrong, and dressing them as errors is how a first-run install reads like a crash.
 *
 * So they leave through here instead: an ordinary sentence, and one of the documented codes above rather
 * than the 1 that means "it broke". It exits the process rather than returning, because there is nothing
 * after it — the same thing main does with a `Fail`, one frame earlier and with a code that carries meaning. */
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
        /* THE DESKTOP APP'S FIRST PASS LANDS EXACTLY HERE, and it is the most-travelled line in this file:
         * every Windows install that needs anything at all reaches it. It used to leave as `error: there is
         * no terminal to ask on, so nothing was changed` — a sentence about our own plumbing, on stderr, in
         * red, describing a run that did precisely what it was designed to do. The app has the requirement
         * lines already and draws them as a list with a button; this is only the note behind that button. */
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

/* Unix keeps its own route. connect.sh installs Docker there, with the root it asks for at the top of the
 * script, and duplicating that here would be a second implementation of a thing that works — the exact trade
 * the desktop app's scripts.rs header talks itself out of. What this IS good for on Unix is the verdict:
 * `ic docker prepare` answers "can this machine run a sandbox" everywhere. */
#[cfg(not(windows))]
pub fn run(_args: Args) -> Result<()> {
    crate::util::step("checking-docker", "checking Docker...");
    crate::docker::require_daemon()?;
    println!("  Docker is ready on this machine.");
    Ok(())
}

#[cfg(test)]
mod tests {
    /* The flow above is Windows-only; its DECISIONS are plan.rs's and are tested there against fact
     * literals, on every runner. What is asserted here is the one thing that spans both and that no unit
     * test elsewhere covers: the marker the desktop app parses. Its prefix must never collide with the step
     * vocabulary, because the app's step regex would then match it and move a progress bar to a phase that
     * does not exist. */

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
