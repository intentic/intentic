use std::process::Command;
use std::time::Duration;

use crate::util::{bail, Fail, Result};

/* THE MACHINE'S OWN TOOLS AS THE SETTINGS VERBS RUN THEM: nmcli, wpctl, swaymsg, udisksctl and lsblk, as the user ic
runs as (the `intentic` user, whom the image's polkit rules let change exactly what these verbs change), never through
sudo. Every call has a deadline: a NetworkManager or a sound server that stops answering must not park the machine
agent's tool call, or the desktop app's card, for good. A tool that fails is answered in its own words, which are the
only diagnosis there is. */

/// `program args…` with a deadline: what it printed on stdout, or Err with what it said on its way out.
pub fn capture(program: &str, args: &[&str], limit: Duration) -> Result<String> {
    finish(
        program,
        args,
        limit,
        crate::docker::run_bounded(program, args, limit)?,
    )
}

/// [`capture`] for a tool that talks to the session's own services (wpctl to the sound server): `XDG_RUNTIME_DIR`
/// names the session's folder, which the machine agent's user service and the screen's session both set, and which a
/// shell without a login (or root at the console) may not.
pub fn capture_in_session(program: &str, args: &[&str], limit: Duration) -> Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    let inherited = std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty());
    let uid = uid();
    if inherited.is_none() || uid == Some(0) {
        command.env("XDG_RUNTIME_DIR", session_runtime_dir(uid));
    }
    finish(
        program,
        args,
        limit,
        crate::docker::bounded(command, limit)?,
    )
}

/// The same, with `input` on its stdin and then stdin closed: how a secret reaches a tool without riding on its command
/// line, which anyone on the machine can read (`ps`).
pub fn capture_with_input(
    program: &str,
    args: &[&str],
    input: &[u8],
    limit: Duration,
) -> Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    let ran =
        intentic_bounded::capture_with_input(command, input, limit, intentic_bounded::Reach::Child)
            .map_err(|err| Fail(format!("could not run {program}: {err}")))?;
    finish(
        program,
        args,
        limit,
        crate::docker::Bounded {
            code: ran.code,
            timed_out: ran.timed_out,
            stdout: ran.stdout.trim_end().to_string(),
            stderr: ran.stderr.trim_end().to_string(),
        },
    )
}

fn finish(
    program: &str,
    args: &[&str],
    limit: Duration,
    ran: crate::docker::Bounded,
) -> Result<String> {
    if ran.timed_out {
        bail!(
            "{program} {} did not answer within {}s.",
            args.first().copied().unwrap_or_default(),
            limit.as_secs()
        );
    }
    if ran.code != Some(0) {
        bail!("{}", last_words(&ran.stdout, &ran.stderr, program));
    }
    Ok(ran.stdout)
}

/// What a tool said on its way out: its last line on stderr, else on stdout, else that it failed. `Error: ` and
/// `error: ` prefixes go, since the sentence is quoted inside one of ic's own. Pure.
pub fn last_words(stdout: &str, stderr: &str, program: &str) -> String {
    let last = |text: &str| {
        text.lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
            .map(str::to_string)
    };
    let said = last(stderr).or_else(|| last(stdout));
    match said {
        Some(line) => {
            let bare = line
                .strip_prefix("Error: ")
                .or_else(|| line.strip_prefix("error: "))
                .unwrap_or(&line);
            format!("{program}: {bare}")
        }
        None => format!("{program} failed and said nothing."),
    }
}

/// Stop the verb with one sentence and `code`, for a caller that tells outcomes apart by the exit code (the contract
/// names each: a Wi-Fi network that needs its password, a screen verb on an edition with none, a drive too big).
pub fn exit_with(code: i32, message: &str) -> ! {
    crate::ui::error(message);
    std::process::exit(code);
}

/// The uid ic runs as, as `id -u` says it. The settings verbs reach the `intentic` user's own session services (its
/// sound server, its screen), whose sockets live under `/run/user/<uid>`.
pub fn uid() -> Option<u32> {
    let said = crate::docker::run_bounded("id", &["-u"], Duration::from_secs(5)).ok()?;
    said.stdout.trim().parse().ok()
}

/// The uid of the `intentic` user, fixed by the image (sysusers.d/intentic.conf): whose session root reaches into.
pub const INTENTIC_UID: u32 = 1990;

/// The runtime folder of the session the settings verbs act on: the caller's own, or, for root (a person at the console
/// with sudo), the `intentic` user's, whose screen and sound these are. Pure.
pub fn session_runtime_dir(uid: Option<u32>) -> String {
    match uid {
        Some(0) | None => format!("/run/user/{INTENTIC_UID}"),
        Some(uid) => format!("/run/user/{uid}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_is_quoted_by_its_last_line_without_its_own_error_prefix() {
        assert_eq!(
            last_words(
                "",
                "Warning: x\nError: NetworkManager is not running.\n",
                "nmcli"
            ),
            "nmcli: NetworkManager is not running."
        );
        assert_eq!(
            last_words("Volume: 0.40\n\n", "", "wpctl"),
            "wpctl: Volume: 0.40"
        );
        assert_eq!(
            last_words("  ", "", "udisksctl"),
            "udisksctl failed and said nothing."
        );
    }

    #[test]
    fn root_acts_on_the_intentic_users_session_and_anyone_else_on_their_own() {
        assert_eq!(session_runtime_dir(Some(1990)), "/run/user/1990");
        assert_eq!(session_runtime_dir(Some(1000)), "/run/user/1000");
        assert_eq!(session_runtime_dir(Some(0)), "/run/user/1990");
        assert_eq!(session_runtime_dir(None), "/run/user/1990");
    }

    #[cfg(unix)]
    #[test]
    fn input_reaches_the_tool_and_a_failure_is_its_own_words() {
        let echoed = capture_with_input(
            "sh",
            &["-c", "read -r line; echo \"[$line]\""],
            b"secret\n",
            Duration::from_secs(20),
        )
        .expect("sh runs");
        assert_eq!(echoed, "[secret]");
        let failed = capture(
            "sh",
            &["-c", "echo 'Error: nope' >&2; exit 4"],
            Duration::from_secs(20),
        )
        .expect_err("it failed");
        assert_eq!(failed.0, "sh: nope");
    }
}
