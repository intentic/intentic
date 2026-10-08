/* THE LAUNCH A RESTART LEAVES BEHIND: a Run entry, taken away again by this app, never a RunOnce (2026-10-08).
 *
 * A setup that needs Windows to end the session (commands.rs `end_session`) asks Windows to start this app at the next
 * sign-in, so the setup picks up by itself. That was a `RunOnce` value, and Windows deletes a RunOnce value BEFORE it
 * starts the program: a launch that then crashed or hung was the only one there would be, and the setup sat parked until
 * somebody thought to open the app. The value now lives under `Run`, which Windows leaves alone, so every sign-in tries
 * again until this app takes it away: when the setup it was for has run (commands.rs `setup_run`, whichever way it
 * ended), when that setup is given up (`forget_resumable_setup`, a code that ran out included), and at any launch that
 * finds nothing parked ([`settle`]). An app that went on starting itself at every sign-in after its setup
 * was done would be a worse bug than the one this fixes, so every one of those ends in [`settle`]. A RunOnce value of
 * the same name, from a version before this, goes whenever this one is written or taken away. */

use std::path::Path;

use tauri::{AppHandle, Manager};

/// The value's name, under both keys.
const VALUE: &str = "IntenticResumeSetup";
#[cfg_attr(not(windows), allow(dead_code))]
const RUN: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg_attr(not(windows), allow(dead_code))]
const RUN_ONCE: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce";

/// What the entry starts this app with beside its own path: a launch Windows made for a parked setup rather than one a
/// person asked for, as a process listing or the startup apps list shows it. Nothing reads it as a path: a launch's
/// arguments are files to open only when they do not start with `-` (local.rs `arg_path`).
pub const ARG: &str = "--resume-setup";

/// The entry's command line: the app's own path, quoted (it has spaces on every ordinary install, and Windows hands the
/// value to the shell as a command line), then [`ARG`].
#[cfg_attr(not(windows), allow(dead_code))]
pub fn command_line(exe: &Path) -> String {
    format!("\"{}\" {ARG}", exe.display())
}

/// `reg.exe`'s arguments that write the entry under `Run`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn add_args(command: &str) -> Vec<String> {
    ["add", RUN, "/v", VALUE, "/t", "REG_SZ", "/d", command, "/f"]
        .map(str::to_string)
        .to_vec()
}

/// `reg.exe`'s arguments that take the value off `key`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn delete_args(key: &str) -> Vec<String> {
    ["delete", key, "/v", VALUE, "/f"]
        .map(str::to_string)
        .to_vec()
}

/// Whether the next sign-in still has something to start this app for: a setup parked across the session's end
/// (state.rs `ParkedSetup`). This computer's own sandbox ends the session the same way (machine_sandbox.rs
/// `resume_on_launch`) but is not counted: its record can wait on a sign-in to the platform indefinitely, and an entry
/// kept for that would start the app at every sign-in. For it the entry does what RunOnce did: one launch.
pub const fn wanted(parked_setup: bool) -> bool {
    parked_setup
}

/// Ask Windows to start this app at the next sign-in, and take an older version's RunOnce of the same name away, which
/// would start a second copy beside it. Err with what went wrong when the entry could not be written.
#[cfg(windows)]
pub fn register() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("could not work out where this app lives: {error}"))?;
    let written = reg(&add_args(&command_line(&exe)));
    let _ = reg(&delete_args(RUN_ONCE));
    written
}

/// Take the entry away, under both keys. A value that is not there is what `reg.exe` refuses, and is what this wants.
#[cfg(windows)]
fn remove() {
    for key in [RUN, RUN_ONCE] {
        let _ = reg(&delete_args(key));
    }
}

/// Off Windows nothing ends a session for a setup, so there is never an entry to take away.
#[cfg(not(windows))]
fn remove() {}

/// One `reg.exe`, with no window and a bound: the registry answers in milliseconds, and a launch must not wait on it.
#[cfg(windows)]
fn reg(args: &[String]) -> Result<(), String> {
    let mut command = std::process::Command::new("reg.exe");
    command.args(args);
    intentic_bounded::no_window(&mut command);
    match crate::scripts::capture("reg.exe", command, std::time::Duration::from_secs(10)) {
        Ok(answer) if answer.success => Ok(()),
        Ok(answer) => Err(answer.stderr.trim().to_string()),
        Err(silence) => Err(silence.to_string()),
    }
}

/// Take the entry away once nothing is waiting for a sign-in ([`wanted`]). BLOCKING for two `reg.exe` runs on Windows,
/// so off the launch's thread and off a command's; nothing at all elsewhere.
pub fn settle(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let parked = app
        .state::<crate::state::AppState>()
        .parked_setup()
        .is_some();
    if !wanted(parked) {
        remove();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_starts_this_app_quoted_and_marked_as_a_resume() {
        let line = command_line(Path::new(
            r"C:\Users\Ann Smith\AppData\Local\Intentic\intentic.exe",
        ));
        assert_eq!(
            line,
            r#""C:\Users\Ann Smith\AppData\Local\Intentic\intentic.exe" --resume-setup"#
        );
        // Never a path to open: a launch's arguments are files only when they do not start with `-`.
        assert!(ARG.starts_with('-'));
    }

    #[test]
    fn the_entry_goes_under_run_and_comes_off_both_keys() {
        let add = add_args("\"C:\\a b\\intentic.exe\" --resume-setup");
        assert_eq!(
            add,
            [
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "IntenticResumeSetup",
                "/t",
                "REG_SZ",
                "/d",
                "\"C:\\a b\\intentic.exe\" --resume-setup",
                "/f",
            ]
        );
        // Run, never RunOnce: Windows deletes a RunOnce value before the launch it makes, so a crash gets no second one.
        assert!(!add.iter().any(|arg| arg.ends_with("RunOnce")));
        assert_eq!(
            delete_args(RUN_ONCE),
            [
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce",
                "/v",
                "IntenticResumeSetup",
                "/f",
            ]
        );
        assert_eq!(delete_args(RUN)[1], RUN);
    }

    #[test]
    fn the_entry_stays_only_while_a_setup_waits_for_a_sign_in() {
        assert!(wanted(true));
        // Nothing parked: the app must not start at the next sign-in, nor at any after it.
        assert!(!wanted(false));
    }
}
