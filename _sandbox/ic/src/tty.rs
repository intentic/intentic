use std::io::{BufRead, BufReader, Write};

/* Interactive input comes from the CONTROLLING TERMINAL, never stdin. */

#[cfg(unix)]
const TTY_IN: &str = "/dev/tty";
#[cfg(unix)]
const TTY_OUT: &str = "/dev/tty";
// Windows' spelling of the same idea: the console devices, reachable regardless of stream redirection.
#[cfg(windows)]
const TTY_IN: &str = "CONIN$";
#[cfg(windows)]
const TTY_OUT: &str = "CONOUT$";

/* THE CALLER SAYING "THERE IS NOBODY HERE TO ASK", rather than us working it out. */
pub fn prompting_disabled() -> bool {
    disabled_by(std::env::var(NO_PROMPT).ok().as_deref())
}

/// The variable, named once. The desktop app sets it (desktop-app/src-tauri/src/commands.rs) and the
/// contract is written down in docs/ops/cli-output-protocol.md alongside INTENTIC_UI.
pub const NO_PROMPT: &str = "INTENTIC_NO_PROMPT";

/// Split from the read so the RULE is testable without mutating a process-wide environment from a test
/// harness that runs its cases in parallel. Exactly `1` — an unset variable, an empty one and a `0` all
/// leave the probes in charge, so nothing here can accidentally silence a real terminal.
fn disabled_by(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Whether there is a terminal to prompt on — an actual open of the console's write side.
pub fn have_tty() -> bool {
    if prompting_disabled() {
        return false;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .open(TTY_OUT)
        .is_ok()
}

/// Print `prompt` on the terminal and read one line from it. None when there is no terminal or the read
/// fails — callers treat that as "no answer", which for consent questions means refusal.
pub fn ask(prompt: &str) -> Option<String> {
    // Guarded here as well as in `have_tty`, because callers reach `ask` directly (the zone picker, the
    // remove flow's "which one?") and a guard on only the probe would leave those holes open.
    if prompting_disabled() {
        return None;
    }
    let mut out = std::fs::OpenOptions::new().write(true).open(TTY_OUT).ok()?;
    out.write_all(prompt.as_bytes()).ok()?;
    out.flush().ok()?;
    let input = std::fs::File::open(TTY_IN).ok()?;
    let mut line = String::new();
    BufReader::new(input).read_line(&mut line).ok()?;
    if line.is_empty() {
        return None; // EOF without input — a closed terminal, not an empty answer.
    }
    Some(line.trim_end_matches(['\r', '\n']).to_string())
}

/// Like [`ask`], with what is typed kept off the screen: for a secret (an API token) a person pastes. None when there is
/// no terminal, when the read fails, or when the echo could not be turned off, since a secret is never read where it
/// would show.
#[cfg(unix)]
pub fn ask_secret(prompt: &str) -> Option<String> {
    if prompting_disabled() {
        return None;
    }
    let mut out = std::fs::OpenOptions::new().write(true).open(TTY_OUT).ok()?;
    let input = std::fs::File::open(TTY_IN).ok()?;
    // `stty` on the terminal itself, not on whatever stdin is: no new dependency for one hidden line.
    let stty = |setting: &str| {
        std::fs::File::open(TTY_IN).ok().is_some_and(|tty| {
            std::process::Command::new("stty")
                .arg(setting)
                .stdin(tty)
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        })
    };
    /// Echo comes back on every way out of the read, an early return and a panic included.
    struct EchoBack<F: Fn(&str) -> bool>(F);
    impl<F: Fn(&str) -> bool> Drop for EchoBack<F> {
        fn drop(&mut self) {
            (self.0)("echo");
        }
    }
    if !stty("-echo") {
        return None;
    }
    let _echo = EchoBack(stty);
    out.write_all(prompt.as_bytes()).ok()?;
    out.flush().ok()?;
    let mut line = String::new();
    let read = BufReader::new(input).read_line(&mut line);
    // The Enter that ended the line was not echoed either.
    let _ = out.write_all(b"\n");
    let _ = out.flush();
    read.ok()?;
    if line.is_empty() {
        return None;
    }
    Some(line.trim_end_matches(['\r', '\n']).to_string())
}

/// Windows has no `stty`, and nothing that asks for a secret runs there (server enrollment is Linux only): no answer,
/// which callers treat as nobody at the terminal and stop with the variable to set instead.
#[cfg(windows)]
pub fn ask_secret(_prompt: &str) -> Option<String> {
    None
}

/// Write one line to the terminal, beside a question: what answering does, or the rows to pick from. Nothing when
/// there is no terminal, since a line meant for the person asking has no other reader.
pub fn say(line: &str) {
    if prompting_disabled() {
        return;
    }
    if let Ok(mut out) = std::fs::OpenOptions::new().write(true).open(TTY_OUT) {
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

// The engine's Windows removal is its one caller left (engine/windows.rs, compiled on Windows only); everything else
// asks through ui::confirm.
#[cfg_attr(not(windows), allow(dead_code))]
/// yes/no with default NO — `[y/N]`. `force` (the -y flag) short-circuits to yes; no terminal is no.
pub fn confirm(question: &str, force: bool) -> bool {
    if force {
        return true;
    }
    match ask(&format!("{question} [y/N] ")) {
        Some(answer) => answer.starts_with(['y', 'Y']),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_one_takes_the_prompts_away() {
        assert!(disabled_by(Some("1")));
        // Everything else leaves the probes in charge — a truthy-looking value is not the contract, because
        // the one thing this must never do is silence a question a real person is sitting in front of.
        assert!(!disabled_by(None));
        assert!(!disabled_by(Some("")));
        assert!(!disabled_by(Some("0")));
        assert!(!disabled_by(Some("true")));
        assert!(!disabled_by(Some("yes")));
    }

    #[test]
    fn the_variable_is_named_once() {
        assert_eq!(NO_PROMPT, "INTENTIC_NO_PROMPT");
    }
}
