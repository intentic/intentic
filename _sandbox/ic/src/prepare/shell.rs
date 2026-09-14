// See plan.rs's header: the encoders are asserted on every runner, the runners only exist on Windows.
#![cfg_attr(not(windows), allow(dead_code))]

/* HOW THIS BINARY TALKS TO WINDOWS — one shape for every call, and it is not a quoted command line. */

#[cfg(windows)]
use std::process::{Command, Stdio};

/// base64, standard alphabet, no wrapping. Hand-rolled rather than pulled in: this binary is downloaded on
/// every run, and 20 lines beats a dependency for the one thing it is needed for.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// A PowerShell script as the argument `-EncodedCommand` wants: UTF-16LE, base64. Pure, so the encoding is
/// tested on the runner that cross-builds this and never runs it.
pub fn encoded(script: &str) -> String {
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64(&utf16)
}

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

    #[test]
    fn base64_matches_the_reference_vectors() {
        // RFC 4648's own test vectors — padding is where hand-rolled encoders go wrong.
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // High bytes must not sign-extend into the wrong sextet.
        assert_eq!(base64(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64(&[0x00, 0x00, 0x00]), "AAAA");
    }

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

    /* The two things that make the noise above impossible in the first place. */
    #[test]
    fn every_script_runs_with_the_progress_stream_switched_off() {
        assert!(PREAMBLE.contains("$ProgressPreference = 'SilentlyContinue'"));
        assert!(PREAMBLE.contains("$ErrorActionPreference = 'Continue'"));
        assert!(PREAMBLE.ends_with('\n'), "it is a prefix, not a statement");
        assert!(PREAMBLE.is_ascii(), "same rule as every other script here");
    }

    #[test]
    fn encoded_commands_are_utf16le_which_is_what_powershell_decodes() {
        // `echo hi` as PowerShell itself produces it — the one assertion that proves the byte order.
        assert_eq!(encoded("hi"), "aABpAA==");
        // Every ASCII character becomes two bytes, so the base64 is 4 chars per 3 BYTES, not per character.
        assert_eq!(encoded("abc").len(), 8);
    }
}
