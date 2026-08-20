use std::io::{BufRead, BufReader, Write};

/* Interactive input comes from the CONTROLLING TERMINAL, never stdin. The bootstrap shims pipe this binary's
 * flows from `curl … | sh`, where stdin is the script text — the same constraint the shell versions lived
 * under. And the probe must be an OPEN, not a permission check: /dev/tty is world-readable on every machine,
 * but opening it fails with ENXIO whenever the process has no controlling terminal (systemd, CI, setsid).
 * `[ -r /dev/tty ]` passed in exactly those cases, the read then failed, and its empty-answer fallback landed
 * on a default the caller read as YES — which silently approved a root-level Docker install on every headless
 * run. So: open is the probe, and a failed read is a refusal, never a default. */

#[cfg(unix)]
const TTY_IN: &str = "/dev/tty";
#[cfg(unix)]
const TTY_OUT: &str = "/dev/tty";
// Windows' spelling of the same idea: the console devices, reachable regardless of stream redirection.
#[cfg(windows)]
const TTY_IN: &str = "CONIN$";
#[cfg(windows)]
const TTY_OUT: &str = "CONOUT$";

/* THE CALLER SAYING "THERE IS NOBODY HERE TO ASK", rather than us working it out.
 *
 * Every probe below is an INFERENCE about whether a person is present, and the desktop app is the one caller
 * that already knows the answer for certain: it spawns these flows with no window, no console and closed
 * stdin, from a GUI process. A question asked on that run reaches nobody and is answered by nobody, and the
 * cost of the inference being wrong there is not a bad guess — it is a setup that never ends, on a machine
 * whose owner is watching a spinner.
 *
 * The probes are good and they are kept; this is the belt to their braces, and it costs one environment
 * variable. Set it and every prompt in this binary becomes "no answer", which each caller already handles —
 * a consent question refuses, a destructive one refuses, and a picker falls back to its default. */
pub fn prompting_disabled() -> bool {
    disabled_by(std::env::var(NO_PROMPT).ok().as_deref())
}

/// The variable, named once. The desktop app sets it (desktop-app/src-tauri/src/commands.rs) and the
/// contract is written down in docs/cli-output-protocol.md alongside INTENTIC_UI.
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
