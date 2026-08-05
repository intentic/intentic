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

/// Whether there is a terminal to prompt on — an actual open of the console's write side.
pub fn have_tty() -> bool {
    std::fs::OpenOptions::new()
        .write(true)
        .open(TTY_OUT)
        .is_ok()
}

/// Print `prompt` on the terminal and read one line from it. None when there is no terminal or the read
/// fails — callers treat that as "no answer", which for consent questions means refusal.
pub fn ask(prompt: &str) -> Option<String> {
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
