// See plan.rs's header: the encoders are asserted on every runner, the runners only exist on Windows.
#![cfg_attr(not(windows), allow(dead_code))]

/* HOW THIS BINARY TALKS TO WINDOWS — one shape for every call, and it is not a quoted command line.
 *
 * Everything below runs PowerShell with `-EncodedCommand`, which takes base64 of UTF-16LE. That looks like
 * ceremony and removes two whole classes of bug:
 *
 *   • QUOTING. The probe embeds `'docker-users'`, `"DeviceID='C:'"` and `$env:ProgramFiles` in one script.
 *     Passed as `-Command "<script>"` that is a nesting problem with no correct answer, and every attempt
 *     produces a script that parses on the developer's machine and not on somebody's PC.
 *   • CODE PAGES. A .ps1 handed to `-File` is read in the machine's ANSI code page by Windows PowerShell 5.1
 *     (the whole story is in desktop-app/src-tauri/src/scripts.rs). Encoded commands carry their own
 *     encoding, so the text that arrives is the text that was sent.
 *
 * The scripts here are still written in ASCII, because they are also read by people in this repo, and because
 * one less encoding to think about is one less encoding to get wrong. */

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

/// Run a script as this user and capture it.
#[cfg(windows)]
pub fn run(script: &str) -> Output {
    let result = powershell()
        .args(["-EncodedCommand", &encoded(script)])
        .stdin(Stdio::null())
        .output();
    match result {
        Ok(output) => Output {
            ok: output.status.success(),
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        },
        Err(error) => Output {
            ok: false,
            code: -1,
            stdout: String::new(),
            stderr: format!("could not run powershell: {error}"),
        },
    }
}

/* RUNNING SOMETHING AS ADMINISTRATOR, AND STILL SEEING WHAT IT SAID.
 *
 * `Start-Process -Verb RunAs` is the only way to raise a process from a non-elevated one, and it hands back
 * an exit code and nothing else: the child gets its own console, so its output goes to a window that closes.
 * Hiding that window (which we do — a black console flashing over a setup screen reads as a crash) would
 * throw away the one thing worth having when `wsl --install` fails.
 *
 * So the elevated child appends what it runs to a transcript we name, and we read it back and print it as our
 * own. The user sees one UAC prompt, no flashing window, and the full output of what ran behind it.
 *
 * THE REDIRECTION GOES ON EACH COMMAND, not around the script. Wrapping the whole body in `& { … } *> file`
 * reads better and is a trap: `exit 0` inside a script block ends the RUNSPACE, not the block, so the script
 * stops with a file stream still open and its buffer unwritten — and every one of these scripts ends in an
 * exit code, because that is how the outcome gets back here. So [`LOG`] is a variable the caller's own
 * commands append to, and every `exit` sits at the top level where it belongs. */
#[cfg(windows)]
pub fn run_elevated(script: &str) -> Output {
    let log = std::env::temp_dir().join(format!("intentic-elevated-{}.log", std::process::id()));
    let log_path = log.to_string_lossy().replace('\'', "''");
    let child = format!("$ErrorActionPreference='Continue'\n${LOG} = '{log_path}'\n{script}\n");
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
        output.stdout = transcript;
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

    #[test]
    fn encoded_commands_are_utf16le_which_is_what_powershell_decodes() {
        // `echo hi` as PowerShell itself produces it — the one assertion that proves the byte order.
        assert_eq!(encoded("hi"), "aABpAA==");
        // Every ASCII character becomes two bytes, so the base64 is 4 chars per 3 BYTES, not per character.
        assert_eq!(encoded("abc").len(), 8);
    }
}
