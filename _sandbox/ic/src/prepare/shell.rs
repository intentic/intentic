// See plan.rs's header: the encoders are asserted on every runner, the runners only exist on Windows.
#![cfg_attr(not(windows), allow(dead_code))]

/* HOW THIS BINARY TALKS TO WINDOWS — one shape for every call, and it is not a quoted command line. */

#[cfg(windows)]
use std::process::{Command, Stdio};

/// The encoding every script here is run with, shared with the desktop app (`intentic-docker-host`).
pub use intentic_docker_host::powershell::encoded;

/* CLIXML — POWERSHELL'S OTHER OUTPUT FORMAT, WHICH ARRIVES UNINVITED AND IS NOT OPTIONAL TO HANDLE. */

/// Every script's first two lines. `$ProgressPreference` is the fix; `$ErrorActionPreference` is set here so
/// that a script which does not say otherwise behaves the same way the elevated ones already did.
const PREAMBLE: &str =
    "$ProgressPreference = 'SilentlyContinue'\n$ErrorActionPreference = 'Continue'\n";

/// Drop any CLIXML document from captured text, leaving the rest exactly as it was. Pure, and tested on every
/// runner: this is a parser for somebody else's format, which is not something to find out about on Windows.
pub fn strip_clixml(text: &str) -> String {
    if !text.contains("CLIXML") && !text.contains("<Objs") {
        return text.to_string();
    }
    let mut kept: Vec<&str> = Vec::new();
    // The document is normally one line after its header, but nothing promises that, so the end is looked for
    // rather than assumed.
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if inside {
            inside = !trimmed.contains("</Objs>");
            continue;
        }
        if trimmed.starts_with("#< CLIXML") || trimmed.starts_with("<Objs") {
            inside = !trimmed.contains("</Objs>");
            continue;
        }
        kept.push(line);
    }
    kept.join("\n")
}

/// What a run of PowerShell came back with. Non-zero is ordinary here — half of these calls are probes whose
/// "no" arrives as an exit code — so this is a value, not an error.
#[cfg(windows)]
pub struct Output {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// The UAC prompt was dismissed. Windows' own ERROR_CANCELLED, reused so the elevated wrapper can report
/// "the user said no" as something other than "the command failed".
#[cfg(windows)]
pub const CANCELLED: i32 = 1223;

#[cfg(windows)]
fn powershell() -> Command {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
    ]);
    command
}

/// Run a script as this user and capture it. Every script is run behind [`PREAMBLE`] and every capture comes
/// back through [`strip_clixml`], so no caller has to remember either.
#[cfg(windows)]
pub fn run(script: &str) -> Output {
    let result = powershell()
        .args(["-EncodedCommand", &encoded(&format!("{PREAMBLE}{script}"))])
        .stdin(Stdio::null())
        .output();
    match result {
        Ok(output) => Output {
            ok: output.status.success(),
            code: output.status.code().unwrap_or(-1),
            stdout: strip_clixml(&String::from_utf8_lossy(&output.stdout)),
            stderr: strip_clixml(&String::from_utf8_lossy(&output.stderr)),
        },
        Err(error) => Output {
            ok: false,
            code: -1,
            stdout: String::new(),
            stderr: format!("could not run powershell: {error}"),
        },
    }
}

/// The same, with a deadline: for a probe that must not hang the flow reading it (a WSL that stopped answering makes
/// `wsl --status` inside the probe wait for good). A run that is cut off comes back not ok, saying so.
#[cfg(windows)]
pub fn run_within(script: &str, limit: std::time::Duration) -> Output {
    let mut command = powershell();
    command.args(["-EncodedCommand", &encoded(&format!("{PREAMBLE}{script}"))]);
    match crate::docker::bounded(command, limit) {
        Ok(ran) if ran.timed_out => Output {
            ok: false,
            code: -1,
            stdout: String::new(),
            stderr: format!("it did not answer within {} seconds", limit.as_secs()),
        },
        Ok(ran) => Output {
            ok: ran.code == Some(0),
            code: ran.code.unwrap_or(-1),
            stdout: strip_clixml(&ran.stdout),
            stderr: strip_clixml(&ran.stderr),
        },
        Err(fail) => Output {
            ok: false,
            code: -1,
            stdout: String::new(),
            stderr: fail.0,
        },
    }
}

/* `Start-Process -Verb RunAs` is the only way to raise a process from a non-elevated one, and it hands back an exit code and nothing else. */
#[cfg(windows)]
pub fn run_elevated(script: &str) -> Output {
    let log = std::env::temp_dir().join(format!("intentic-elevated-{}.log", std::process::id()));
    let log_path = log.to_string_lossy().replace('\'', "''");
    // The child gets the same preamble the parent does: it is the one writing the transcript, and a progress
    // record serialised into that file is XML in the middle of the reason a fix failed.
    let child = format!("{PREAMBLE}${LOG} = '{log_path}'\n{script}\n");
    let outer = format!(
        "try {{\n  \
           $p = Start-Process -FilePath 'powershell.exe' \
             -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{encoded}') \
             -Verb RunAs -WindowStyle Hidden -Wait -PassThru\n  \
           exit $p.ExitCode\n\
         }} catch {{\n  exit {CANCELLED}\n}}\n",
        encoded = encoded(&child)
    );
    let mut output = run(&outer);
    if let Ok(transcript) = std::fs::read_to_string(&log) {
        output.stdout = strip_clixml(&transcript);
    }
    let _ = std::fs::remove_file(&log);
    output
}

/// The PowerShell variable an elevated script appends its output to — `wsl.exe --install *>> $Log`. Named
/// here so the one place that defines it and the several that use it cannot disagree.
pub const LOG: &str = "Log";

#[cfg(test)]
mod tests {
    use super::*;

    /* THE EXACT BYTES A REAL INSTALL PUT ON SOMEBODY'S SCREEN, where the reason should have been. */
    const REPORTED: &str = "\
System error 1379 has occurred.\n\
The specified local group already exists.\n\
#< CLIXML\n\
<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\"><Obj S=\"progress\" RefId=\"0\"><TN RefId=\"0\"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N=\"SourceId\">1</I64><PR N=\"Record\"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>\n";

    #[test]
    fn the_progress_xml_that_buried_a_real_error_message_is_removed() {
        let cleaned = strip_clixml(REPORTED);
        assert!(
            cleaned.contains("The specified local group already exists."),
            "the reason has to survive: {cleaned}"
        );
        assert!(!cleaned.contains("CLIXML"), "got: {cleaned}");
        assert!(!cleaned.contains("Preparing modules"), "got: {cleaned}");
        assert!(
            !cleaned.contains('<'),
            "no XML may be left at all: {cleaned}"
        );
    }

    #[test]
    fn text_without_any_xml_in_it_is_returned_untouched() {
        // The common case by far, and the one where a clever parser would be a liability.
        for ordinary in [
            "",
            "ok\n",
            "System error 1378 has occurred.\n  indented\n\nblank above",
        ] {
            assert_eq!(strip_clixml(ordinary), ordinary);
        }
    }

    #[test]
    fn a_document_split_over_several_lines_is_still_removed_whole() {
        let text =
            "before\n#< CLIXML\n<Objs Version=\"1.1.0.1\">\n<Obj S=\"progress\" />\n</Objs>\nafter";
        assert_eq!(strip_clixml(text), "before\nafter");
        // …and one that never closes must not eat the file looking for an end that is not coming, beyond the
        // document itself — the header is the point of no return either way.
        assert_eq!(strip_clixml("before\n#< CLIXML\n<Objs>\n"), "before");
    }

    /* What makes the noise above impossible in the first place. */
    #[test]
    fn every_script_runs_with_the_progress_stream_switched_off() {
        assert!(PREAMBLE.contains("$ProgressPreference = 'SilentlyContinue'"));
        assert!(PREAMBLE.contains("$ErrorActionPreference = 'Continue'"));
        assert!(PREAMBLE.ends_with('\n'), "it is a prefix, not a statement");
        assert!(PREAMBLE.is_ascii(), "same rule as every other script here");
    }
}
