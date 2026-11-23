//! Administrator runs (Windows), the parts that are not Windows' own: what the caller and the helper say over the
//! administrator pipe, the sandbox's grant each run must carry and the checks on it, the command line a program and
//! its arguments become, where a bare program name is found, the `service admin-run` arguments and the one-line status
//! it writes. The Win32 side (the helper's server, the elevated token, the process, the caller's connection) is
//! `windows::admin`; everything here builds and is tested everywhere.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Moves when either side's messages change meaning. The administrator pipe's own, so cast-win's helper protocol (which
/// a service installed on a PC speaks until someone sets it up again, through a UAC prompt) never moves for it.
pub const ADMIN_PROTOCOL: u32 = 1;

/// What `service install` records in `Installed.features` for a service whose helper serves administrator runs.
pub const FEATURE: &str = "admin-run";

/// `service admin-run`'s exit code when the command did not run (the status file says why).
pub const NOT_RAN: i32 = 125;

/// Why a command did not run, as the status file's `reason` says it.
pub mod reason {
    pub const NOT_WINDOWS: &str = "not-windows";
    pub const NOT_INSTALLED: &str = "not-installed";
    pub const OUTDATED: &str = "outdated";
    pub const NOT_RUNNING: &str = "not-running";
    pub const UNREACHABLE: &str = "unreachable";
    pub const REFUSED: &str = "refused";
    /// The service pins no sandbox key: it was set up before administrator runs were signed.
    pub const UNTRUSTED: &str = "untrusted";
    pub const NOBODY_SIGNED_IN: &str = "nobody-signed-in";
    pub const NOT_ADMINISTRATOR: &str = "not-administrator";
    pub const START_FAILED: &str = "start-failed";
    pub const LOST: &str = "lost";
    /// `service admin-run` called without a program (the caller's mistake, not the computer's).
    pub const USAGE: &str = "usage";
}

/// The caller to the helper: a hello, then exactly one run.
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ToAdmin {
    /// The protocol, and the secret the service wrote where only the installing user can read it.
    Hello { protocol: u32, secret: String },
    /// Start `program` with `args` in `cwd` (None: the person's profile folder) as the signed-in person's administrator,
    /// with the sandbox's `grant` for exactly this command ([`Grants::admit`]).
    Run {
        program: String,
        args: Vec<String>,
        cwd: Option<String>,
        grant: Option<String>,
    },
}

impl ToAdmin {
    /// The message's kind, for a log line: never its content (a hello carries the secret).
    pub fn kind(&self) -> &'static str {
        match self {
            ToAdmin::Hello { .. } => "hello",
            ToAdmin::Run { .. } => "run",
        }
    }
}

/// The helper to the caller: a welcome (or a refusal), then started (or failed), the output, and the exit code.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FromAdmin {
    Welcome {
        protocol: u32,
        version: String,
    },
    Refused {
        why: String,
    },
    Started {
        pid: u32,
    },
    /// `reason` is one of [`reason`]'s: refused, untrusted, nobody-signed-in, not-administrator or start-failed.
    Failed {
        reason: String,
        why: String,
    },
    /// A chunk of the command's output as it came, base64 (it is bytes, in whatever code page the command wrote).
    Out {
        stream: Stream,
        data: String,
    },
    Exited {
        code: u32,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

/// `service admin-run`'s arguments.
#[derive(Debug, PartialEq, Eq)]
pub struct RunArgs {
    pub status: PathBuf,
    pub cwd: Option<String>,
    pub grant: Option<String>,
    pub program: String,
    pub args: Vec<String>,
}

/// Parses `--status <file> [--cwd <dir>] [--grant <envelope>] -- <program> [<arg>…]` (what follows `admin-run`). The
/// error carries the status file when it was named, so even a mistaken call answers there.
pub fn parse_args(args: &[String]) -> Result<RunArgs, (Option<PathBuf>, String)> {
    let mut status = None;
    let mut cwd = None;
    let mut grant = None;
    let mut rest = args.iter();
    let mut program = None;
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--" => {
                program = rest.next().cloned();
                break;
            }
            "--status" | "--cwd" | "--grant" => {
                let Some(value) = rest.next() else {
                    return Err((status, format!("{arg} takes a value")));
                };
                match arg.as_str() {
                    "--status" => status = Some(PathBuf::from(value)),
                    "--cwd" => cwd = Some(value.clone()),
                    _ => grant = Some(value.clone()),
                }
            }
            other if other.starts_with("--") => {
                return Err((status, format!("unknown argument {other:?}")));
            }
            // The program without a `--` before it.
            _ => {
                program = Some(arg.clone());
                break;
            }
        }
    }
    let Some(status) = status else {
        return Err((None, "admin-run takes --status <file>".into()));
    };
    let Some(program) = program.filter(|p| !p.is_empty()) else {
        return Err((Some(status), "admin-run takes a program after --".into()));
    };
    Ok(RunArgs {
        status,
        cwd,
        grant,
        program,
        args: rest.cloned().collect(),
    })
}

/// The status line of a command that ran.
pub fn status_ran(code: u32) -> String {
    serde_json::json!({ "ran": true, "exitCode": code }).to_string()
}

/// The status line of a command that did not run: `reason` one of [`reason`]'s, `error` a sentence a person can act on.
pub fn status_not_ran(reason: &str, error: &str) -> String {
    serde_json::json!({ "ran": false, "reason": reason, "error": error }).to_string()
}

/// Writes the status line (one JSON line) to `path`.
pub fn write_status(path: &std::path::Path, line: &str) {
    if let Err(e) = std::fs::write(path, format!("{line}\n")) {
        eprintln!(
            "intentic-remoted: writing the status to {}: {e}",
            path.display()
        );
    }
}

/// What a non-Windows build answers to `service admin-run`: the status file says so, and the exit code is 125.
pub fn not_windows(args: &[String]) -> i32 {
    let error = "Running a command as administrator is for Windows computers only.";
    match parse_args(args) {
        Ok(RunArgs { status, .. }) | Err((Some(status), _)) => {
            write_status(&status, &status_not_ran(reason::NOT_WINDOWS, error));
        }
        Err((None, _)) => {}
    }
    eprintln!("intentic-remoted: {error}");
    NOT_RAN
}

/// The command line `program args` makes, by the Microsoft C runtime's rules (what `CommandLineToArgvW`, PowerShell and
/// every MSVC program parse back into the same list). The program (argv[0]) is quoted when it holds a space or a tab
/// and never escaped, as the runtime reads backslashes there literally; it may hold no `"`. An argument with no space,
/// tab or `"` that is not empty goes as it is; any other is quoted, each `"` escaped as `\"` with the backslashes
/// before it doubled, and the backslashes at its end doubled.
pub fn command_line(program: &str, args: &[String]) -> Result<String, String> {
    if program.is_empty() {
        return Err("there is no program to run".into());
    }
    if program.contains('"') {
        return Err(format!(
            "a program's name cannot hold a double quote ({program})"
        ));
    }
    if program.contains('\0') || args.iter().any(|a| a.contains('\0')) {
        return Err("a program's name or an argument holds a NUL character".into());
    }
    let mut line = String::new();
    if program.contains([' ', '\t']) {
        line.push('"');
        line.push_str(program);
        line.push('"');
    } else {
        line.push_str(program);
    }
    for arg in args {
        line.push(' ');
        quote_arg(arg, &mut line);
    }
    Ok(line)
}

fn quote_arg(arg: &str, out: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

/// Whether a Windows path is rooted: `C:…`, `\…`, `/…` or a UNC path. A relative one is the run's folder's.
fn rooted(path: &str) -> bool {
    let b = path.as_bytes();
    path.starts_with(['\\', '/']) || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

fn join(dir: &str, name: &str) -> String {
    format!("{}\\{name}", dir.trim_end_matches(['\\', '/']))
}

/// Where `program` is, as a person's shell in `cwd` with `path` (theirs, from their environment) would find it: a path
/// (`.\setup.exe`, `tools\x`, `C:\…`) against `cwd`, a bare name along `path`, `.exe` tried first where the name has no
/// extension. None: not found here, and Windows' own search (the system folders) has the last word. The run's folder
/// matters because Windows resolves a relative program against the starting process's folder (the helper's), not the
/// one it starts the program in; the person's PATH because the helper's is SYSTEM's, which lacks their own entries
/// (winget's WindowsApps among them).
pub fn resolve_program(
    program: &str,
    cwd: Option<&str>,
    path: Option<&str>,
    is_file: &dyn Fn(&str) -> bool,
) -> Option<String> {
    let names = |base: &str| -> Vec<String> {
        let file = base.rsplit(['\\', '/']).next().unwrap_or(base);
        if file.contains('.') {
            vec![base.to_owned()]
        } else {
            vec![format!("{base}.exe"), base.to_owned()]
        }
    };
    if program.contains(['\\', '/', ':']) {
        let program = program.replace('/', "\\");
        let full = match cwd {
            Some(cwd) if !rooted(&program) => {
                let mut relative = program.as_str();
                while let Some(rest) = relative.strip_prefix(".\\") {
                    relative = rest;
                }
                join(cwd, relative)
            }
            _ => program,
        };
        return names(&full).into_iter().find(|p| is_file(p));
    }
    for dir in path?.split(';') {
        let dir = dir.trim().trim_matches('"');
        // An entry that is not a full path would be the helper's folder's.
        if dir.is_empty() || !rooted(dir) {
            continue;
        }
        if let Some(found) = names(&join(dir, program)).into_iter().find(|p| is_file(p)) {
            return Some(found);
        }
    }
    None
}

/// A variable of an environment block (`NAME=value\0…\0\0`, as UTF-16), its name matched as Windows does, ignoring case.
pub fn env_block_var(block: &[u16], name: &str) -> Option<String> {
    block
        .split(|&u| u == 0)
        .take_while(|entry| !entry.is_empty())
        .find_map(|entry| {
            let entry = String::from_utf16_lossy(entry);
            // `=C:=C:\…` entries start with their `=`: the name ends at the first one after it.
            let at = entry.get(1..)?.find('=')? + 1;
            entry[..at]
                .eq_ignore_ascii_case(name)
                .then(|| entry[at + 1..].to_owned())
        })
}

/// At most `max` characters of `text`, an ellipsis saying where it was cut.
pub fn excerpt(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

/// Whether a hello's secret is the service's, compared in constant time (cast-win's helper compares the same way).
pub fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// The sandbox's grant.

/// What a grant's signature covers before the payload: the domain, then one NUL. The sandbox's keyring signing key
/// signs Passwords grants too, under another domain, so neither kind can stand for the other.
pub const GRANT_DOMAIN: &[u8] = b"intentic-admin-run/grant/v1";
/// The longest a grant may last, issued to expiring.
pub const GRANT_LONGEST_MS: u64 = 300_000;
/// How far ahead of this computer's clock a grant may say it was issued (the sandbox's clock and this one differ).
pub const GRANT_SKEW_MS: u64 = 30_000;
/// The PowerShell invocation a grant covers, before its script: the machine agent's POWERSHELL_FLAGS.
pub const POWERSHELL_FLAGS: [&str; 5] = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
];
/// The programs a grant covers, by file name.
pub const POWERSHELLS: [&str; 2] = ["pwsh.exe", "powershell.exe"];

/// A grant's envelope: the payload's JSON and its Ed25519 signature, each base64url without padding.
#[derive(Deserialize)]
struct Envelope {
    payload: String,
    sig: String,
}

/// What a grant says (read tolerantly: other fields are ignored).
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrantPayload {
    pub kind: String,
    /// Lowercase hex SHA-256 of the script's UTF-8.
    pub command_sha256: String,
    /// Once only: a run with a nonce already used is refused.
    pub nonce: String,
    /// Epoch milliseconds.
    pub issued_at: u64,
    pub expires_at: u64,
}

/// Why a run was refused: [`reason::REFUSED`] or [`reason::UNTRUSTED`], and a sentence.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
    pub reason: &'static str,
    pub why: String,
}

fn refused(why: impl Into<String>) -> Refusal {
    Refusal {
        reason: reason::REFUSED,
        why: why.into(),
    }
}

/// Whether `key` is a sandbox key as `service install --trust` takes it: base64url without padding (43 characters)
/// of a raw 32-byte Ed25519 public key.
pub fn valid_key(key: &str) -> bool {
    key.len() == 43 && URL_SAFE_NO_PAD.decode(key).is_ok_and(|k| k.len() == 32)
}

/// Lowercase hex SHA-256 of `text`'s UTF-8.
pub fn sha256_hex(text: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The payload of `envelope` when its signature verifies under one of `keys` (each as [`valid_key`] takes it).
pub fn verify_grant(envelope: &str, keys: &[String]) -> Result<GrantPayload, String> {
    let envelope: Envelope =
        serde_json::from_str(envelope).map_err(|_| "the grant is not a grant's envelope")?;
    let payload = URL_SAFE_NO_PAD
        .decode(&envelope.payload)
        .map_err(|_| "the grant's payload is not base64url")?;
    let sig = URL_SAFE_NO_PAD
        .decode(&envelope.sig)
        .ok()
        .filter(|s| s.len() == 64)
        .ok_or("the grant's signature is not 64 bytes of base64url")?;
    let mut signed = Vec::with_capacity(GRANT_DOMAIN.len() + 1 + payload.len());
    signed.extend_from_slice(GRANT_DOMAIN);
    signed.push(0);
    signed.extend_from_slice(&payload);
    let verified = keys.iter().any(|key| {
        URL_SAFE_NO_PAD.decode(key).is_ok_and(|key| {
            ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
                .verify(&signed, &sig)
                .is_ok()
        })
    });
    if !verified {
        return Err(format!(
            "the grant is not signed by a sandbox this service trusts ({} pinned): set the service up again from the sandbox that asks",
            keys.len()
        ));
    }
    serde_json::from_slice(&payload).map_err(|_| "the grant's payload does not parse".into())
}

/// Whether a payload is a grant for a run as administrator that holds at `now_ms`.
pub fn check_payload(payload: &GrantPayload, now_ms: u64) -> Result<(), String> {
    if payload.kind != "admin-run" {
        return Err(format!(
            "the grant is for {:?}, not a run as administrator",
            payload.kind
        ));
    }
    if payload.expires_at <= payload.issued_at {
        return Err("the grant expires before it was issued".into());
    }
    if payload.expires_at - payload.issued_at > GRANT_LONGEST_MS {
        return Err("the grant lasts longer than 5 minutes".into());
    }
    if payload.issued_at > now_ms.saturating_add(GRANT_SKEW_MS) {
        return Err(
            "the grant was issued in the future: this computer's clock or the sandbox's is wrong"
                .into(),
        );
    }
    if now_ms > payload.expires_at {
        return Err("the grant expired".into());
    }
    if payload.nonce.is_empty() || payload.nonce.len() > 128 {
        return Err("the grant's nonce is not one".into());
    }
    Ok(())
}

/// Whether `program args` is exactly the command a payload approved: PowerShell (by file name), the machine agent's
/// flags in their order, and the script whose SHA-256 the grant carries.
pub fn check_command(payload: &GrantPayload, program: &str, args: &[String]) -> Result<(), String> {
    let name = program.rsplit(['\\', '/']).next().unwrap_or(program);
    if !POWERSHELLS.iter().any(|p| p.eq_ignore_ascii_case(name)) {
        return Err(format!(
            "a grant covers PowerShell (pwsh.exe or powershell.exe) only, not {name}"
        ));
    }
    let (Some((script, flags)), true) =
        (args.split_last(), args.len() == POWERSHELL_FLAGS.len() + 1)
    else {
        return Err("the arguments are not the approved PowerShell invocation".into());
    };
    if !flags
        .iter()
        .zip(POWERSHELL_FLAGS)
        .all(|(arg, flag)| arg.eq_ignore_ascii_case(flag))
    {
        return Err("the arguments are not the approved PowerShell invocation".into());
    }
    if sha256_hex(script) != payload.command_sha256 {
        return Err("the script is not the one approved".into());
    }
    Ok(())
}

/// Whether `path` (a full Windows path, the program a run starts) lies inside one of `folders`: compared as Windows
/// compares, ignoring case and `/` against `\`, and never through a `.` or `..` part.
pub fn inside(path: &str, folders: &[String]) -> bool {
    let norm = |p: &str| {
        let p = p.replace('/', "\\").to_lowercase();
        p.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(p)
    };
    let path = norm(path);
    if path.split('\\').any(|part| part == "." || part == "..") {
        return false;
    }
    folders.iter().any(|folder| {
        let folder = norm(folder);
        let folder = folder.trim_end_matches('\\');
        !folder.is_empty()
            && path
                .strip_prefix(folder)
                .is_some_and(|rest| rest.starts_with('\\') && rest.len() > 1)
    })
}

/// The keys a service pinned and the nonces grants have used: what each run is checked against.
pub struct Grants {
    keys: Vec<String>,
    /// Each nonce used, until its grant's expiry (when it could no longer pass anyway).
    used: Mutex<HashMap<String, u64>>,
}

impl Grants {
    pub fn new(keys: Vec<String>) -> Grants {
        Grants {
            keys,
            used: Mutex::new(HashMap::new()),
        }
    }

    /// How many keys are pinned.
    pub fn keys(&self) -> usize {
        self.keys.len()
    }

    /// Admits a run of `program args` at `now_ms` when `grant` approves exactly it, using the grant's nonce up; refuses
    /// it otherwise, saying why. The nonce is used only once every other check passed.
    pub fn admit(
        &self,
        grant: Option<&str>,
        program: &str,
        args: &[String],
        now_ms: u64,
    ) -> Result<(), Refusal> {
        let Some(grant) = grant else {
            return Err(refused("a run as administrator needs the sandbox's grant"));
        };
        if self.keys.is_empty() {
            return Err(Refusal {
                reason: reason::UNTRUSTED,
                why: "this service was set up before administrator runs were signed, or by another sandbox: set it up again from the sandbox that asks".into(),
            });
        }
        let payload = verify_grant(grant, &self.keys).map_err(refused)?;
        check_payload(&payload, now_ms).map_err(refused)?;
        check_command(&payload, program, args).map_err(refused)?;
        let mut used = self
            .used
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        used.retain(|_, expires| *expires >= now_ms);
        if used.contains_key(&payload.nonce) {
            return Err(refused("the grant was used already"));
        }
        used.insert(payload.nonce, payload.expires_at);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// The Microsoft C runtime's parse of a command line's arguments after argv[0] (2008 and later rules, which
    /// CommandLineToArgvW shares for everything but a doubled quote inside quotes, which `command_line` never writes).
    fn parse_msvc(args: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut chars = args.chars().peekable();
        loop {
            while chars.peek().is_some_and(|c| *c == ' ' || *c == '\t') {
                chars.next();
            }
            if chars.peek().is_none() {
                return out;
            }
            let mut arg = String::new();
            let mut quoted = false;
            while let Some(&c) = chars.peek() {
                if !quoted && (c == ' ' || c == '\t') {
                    break;
                }
                chars.next();
                match c {
                    '\\' => {
                        let mut n = 1;
                        while chars.peek() == Some(&'\\') {
                            chars.next();
                            n += 1;
                        }
                        if chars.peek() == Some(&'"') {
                            arg.extend(std::iter::repeat_n('\\', n / 2));
                            if n % 2 == 1 {
                                chars.next();
                                arg.push('"');
                            }
                        } else {
                            arg.extend(std::iter::repeat_n('\\', n));
                        }
                    }
                    '"' => quoted = !quoted,
                    c => arg.push(c),
                }
            }
            out.push(arg);
        }
    }

    #[test]
    fn plain_arguments_go_as_they_are() {
        assert_eq!(
            command_line(
                "pwsh.exe",
                &strings(&["-NoProfile", "-Command", "Get-Date"])
            )
            .unwrap(),
            "pwsh.exe -NoProfile -Command Get-Date"
        );
        assert_eq!(
            command_line("x", &strings(&[r"C:\dir\", r"a\\b"])).unwrap(),
            r"x C:\dir\ a\\b"
        );
    }

    #[test]
    fn spaces_quotes_and_backslashes_are_quoted_by_the_runtime_rules() {
        let cases: &[(&str, &str)] = &[
            ("", r#""""#),
            ("a b", r#""a b""#),
            ("a\tb", "\"a\tb\""),
            (r#"say "hi""#, r#""say \"hi\"""#),
            (r#"a"b"#, r#""a\"b""#),
            (r#"a\"b"#, r#""a\\\"b""#),
            (r#"a\\"b"#, r#""a\\\\\"b""#),
            (r"C:\Program Files\", r#""C:\Program Files\\""#),
            (r"C:\a b\\", r#""C:\a b\\\\""#),
            (r"a\b c", r#""a\b c""#),
        ];
        for (arg, want) in cases {
            assert_eq!(
                command_line("p", &[(*arg).to_owned()]).unwrap(),
                format!("p {want}"),
                "{arg:?}"
            );
        }
    }

    #[test]
    fn every_argument_parses_back_to_itself() {
        let args = strings(&[
            "",
            " ",
            "\"",
            "\\",
            "\\\\",
            "\\\"",
            "a b",
            "a\\",
            "a b\\",
            "a b\\\\",
            "\"a b\"",
            "x\\\"y z",
            "trailing\\\\\\",
            "tab\there",
            "-Command",
            "Write-Output \"C:\\Program Files\\\"; exit 3",
            "ünïcödé ✓",
        ]);
        let line = command_line("program", &args).unwrap();
        let rest = line.strip_prefix("program ").unwrap();
        assert_eq!(parse_msvc(rest), args);
    }

    #[test]
    fn the_program_is_quoted_but_never_escaped() {
        assert_eq!(
            command_line(
                r"C:\Program Files\PowerShell\7\pwsh.exe",
                &strings(&["-c", "1"])
            )
            .unwrap(),
            r#""C:\Program Files\PowerShell\7\pwsh.exe" -c 1"#
        );
        assert!(command_line(r#"a"b.exe"#, &[]).is_err());
        assert!(command_line("", &[]).is_err());
        assert!(command_line("a.exe", &strings(&["nul\0here"])).is_err());
    }

    #[test]
    fn a_bare_name_is_found_along_the_persons_path_exe_first() {
        let files = [
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Users\p\AppData\Local\Microsoft\WindowsApps\winget.exe",
            r"C:\tools\thing",
            r"C:\tools\thing.exe",
            r"C:\tools\run.cmd",
        ];
        let is_file = |p: &str| files.contains(&p);
        let path = r#"C:\Windows\System32\WindowsPowerShell\v1.0\;relative\dir;"C:\tools";C:\Users\p\AppData\Local\Microsoft\WindowsApps"#;
        let find = |program: &str| resolve_program(program, Some(r"C:\work"), Some(path), &is_file);
        assert_eq!(
            find("powershell").as_deref(),
            Some(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        );
        assert_eq!(
            find("winget").as_deref(),
            Some(r"C:\Users\p\AppData\Local\Microsoft\WindowsApps\winget.exe")
        );
        assert_eq!(find("thing").as_deref(), Some(r"C:\tools\thing.exe"));
        assert_eq!(find("run.cmd").as_deref(), Some(r"C:\tools\run.cmd"));
        // Not found: Windows' own search has the last word.
        assert_eq!(find("cmd"), None);
        assert_eq!(resolve_program("powershell", None, None, &is_file), None);
    }

    #[test]
    fn a_path_is_the_runs_folders_unless_it_is_rooted() {
        let files = [r"C:\work\setup.exe", r"C:\work\sub\tool.exe", r"D:\x\y.exe"];
        let is_file = |p: &str| files.contains(&p);
        let find = |program: &str| resolve_program(program, Some(r"C:\work\"), None, &is_file);
        assert_eq!(find(r".\setup.exe").as_deref(), Some(r"C:\work\setup.exe"));
        assert_eq!(find("./setup").as_deref(), Some(r"C:\work\setup.exe"));
        assert_eq!(find(r"sub\tool").as_deref(), Some(r"C:\work\sub\tool.exe"));
        assert_eq!(
            find("sub/tool.exe").as_deref(),
            Some(r"C:\work\sub\tool.exe")
        );
        assert_eq!(find(r"D:\x\y").as_deref(), Some(r"D:\x\y.exe"));
        assert_eq!(find(r"D:\x\missing.exe"), None);
    }

    #[test]
    fn an_environment_blocks_variables_are_read_ignoring_case() {
        let block: Vec<u16> = "=C:=C:\\\0Path=C:\\a;C:\\b\0USERPROFILE=C:\\Users\\p\0EMPTY=\0\0"
            .encode_utf16()
            .collect();
        assert_eq!(env_block_var(&block, "PATH").as_deref(), Some(r"C:\a;C:\b"));
        assert_eq!(
            env_block_var(&block, "UserProfile").as_deref(),
            Some(r"C:\Users\p")
        );
        assert_eq!(env_block_var(&block, "EMPTY").as_deref(), Some(""));
        assert_eq!(env_block_var(&block, "=C:").as_deref(), Some("C:\\"));
        assert_eq!(env_block_var(&block, "MISSING"), None);
        assert_eq!(env_block_var(&[0, 0], "PATH"), None);
    }

    #[test]
    fn the_arguments_need_a_status_file_and_a_program() {
        let parse = |list: &[&str]| parse_args(&strings(list));
        assert_eq!(
            parse(&[
                "--status", "s.json", "--cwd", r"C:\w", "--", "pwsh", "-c", "--status"
            ])
            .unwrap(),
            RunArgs {
                status: PathBuf::from("s.json"),
                cwd: Some(r"C:\w".into()),
                grant: None,
                program: "pwsh".into(),
                args: strings(&["-c", "--status"]),
            }
        );
        let granted = parse(&["--grant", "{}", "--status", "s", "--", "x"]).unwrap();
        assert_eq!(granted.grant.as_deref(), Some("{}"));
        assert!(parse(&["--status", "s", "--grant"]).is_err());
        assert_eq!(
            parse(&["--status", "s", "cmd", "/c"]).unwrap().args,
            strings(&["/c"])
        );
        assert_eq!(parse(&["--status", "s", "--", "x"]).unwrap().cwd, None);
        assert_eq!(parse(&["--", "x"]).unwrap_err().0, None);
        assert_eq!(
            parse(&["--status", "s", "--"]).unwrap_err().0,
            Some(PathBuf::from("s"))
        );
        assert!(parse(&["--status", "s", "--bogus", "--", "x"]).is_err());
        assert!(parse(&["--status"]).is_err());
    }

    #[test]
    fn the_status_is_one_json_line() {
        assert_eq!(status_ran(3), r#"{"exitCode":3,"ran":true}"#);
        let line = status_not_ran(reason::NOT_INSTALLED, "Set it up.");
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "ran": false, "reason": "not-installed", "error": "Set it up." })
        );
        assert!(!line.contains('\n'));
    }

    #[test]
    fn a_non_windows_build_answers_not_windows() {
        let dir = std::env::temp_dir().join(format!("remoted-admin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let status = dir.join("status.json");
        let code = not_windows(&strings(&["--status", status.to_str().unwrap(), "--", "x"]));
        assert_eq!(code, NOT_RAN);
        let text = std::fs::read_to_string(&status).unwrap();
        assert!(text.ends_with('\n') && text.lines().count() == 1);
        let value: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(value["ran"], false);
        assert_eq!(value["reason"], "not-windows");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_wire_is_tagged_camel_case_json() {
        let hello = ToAdmin::Hello {
            protocol: ADMIN_PROTOCOL,
            secret: "s".into(),
        };
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            serde_json::json!({ "t": "hello", "protocol": 1, "secret": "s" })
        );
        assert_eq!(hello.kind(), "hello");
        let run: ToAdmin = serde_json::from_value(serde_json::json!({
            "t": "run", "program": "pwsh", "args": ["-c", "1"], "cwd": null, "grant": "g"
        }))
        .unwrap();
        assert!(
            run == ToAdmin::Run {
                program: "pwsh".into(),
                args: strings(&["-c", "1"]),
                cwd: None,
                grant: Some("g".into()),
            }
        );
        // A run without a grant parses (and the helper refuses it, saying why).
        let bare: ToAdmin =
            serde_json::from_value(serde_json::json!({ "t": "run", "program": "p", "args": [] }))
                .unwrap();
        assert!(matches!(
            bare,
            ToAdmin::Run {
                grant: None,
                cwd: None,
                ..
            }
        ));
        for (message, json) in [
            (
                FromAdmin::Out {
                    stream: Stream::Stderr,
                    data: "aGk=".into(),
                },
                serde_json::json!({ "t": "out", "stream": "stderr", "data": "aGk=" }),
            ),
            (
                FromAdmin::Failed {
                    reason: reason::NOT_ADMINISTRATOR.into(),
                    why: "w".into(),
                },
                serde_json::json!({ "t": "failed", "reason": "not-administrator", "why": "w" }),
            ),
            (
                FromAdmin::Exited { code: 0xC000_0005 },
                serde_json::json!({ "t": "exited", "code": 3_221_225_477u32 }),
            ),
            (
                FromAdmin::Started { pid: 7 },
                serde_json::json!({ "t": "started", "pid": 7 }),
            ),
        ] {
            assert_eq!(serde_json::to_value(&message).unwrap(), json);
            assert_eq!(serde_json::from_value::<FromAdmin>(json).unwrap(), message);
        }
    }

    #[test]
    fn excerpts_and_secrets() {
        assert_eq!(excerpt("abc", 5), "abc");
        assert_eq!(excerpt("abcdef", 3), "abc…");
        assert_eq!(excerpt("ąęść", 2), "ąę…");
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "ab"));
        assert!(!same_secret("", ""));
    }

    // The sandbox's grant: the test vector the TypeScript signer was checked against.
    const KEY: &str = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
    const SCRIPT: &str = "Get-Service Spooler | Format-List *";
    const PAYLOAD: &str = r#"{"kind":"admin-run","commandSha256":"f18ad9dcb02fccf0166beea59abd9e32541e82cb2567cd03959bda808b14d7be","nonce":"AAECAwQFBgcICQoLDA0ODw","issuedAt":1795400000000,"expiresAt":1795400300000}"#;
    const ENVELOPE: &str = r#"{"payload":"eyJraW5kIjoiYWRtaW4tcnVuIiwiY29tbWFuZFNoYTI1NiI6ImYxOGFkOWRjYjAyZmNjZjAxNjZiZWVhNTlhYmQ5ZTMyNTQxZTgyY2IyNTY3Y2QwMzk1OWJkYTgwOGIxNGQ3YmUiLCJub25jZSI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHciLCJpc3N1ZWRBdCI6MTc5NTQwMDAwMDAwMCwiZXhwaXJlc0F0IjoxNzk1NDAwMzAwMDAwfQ","sig":"iAcYj9YGvrU8kmaA5a3oStMqlGb31HSVKboBDqD2aXLnl2SFhucx8K4mI_1N3JTZjmntUy3kmDWSNorKoz82CQ"}"#;
    const NOW: u64 = 1_795_400_100_000;
    const PWSH: &str = r"C:\Program Files\PowerShell\7\pwsh.exe";

    fn invocation(script: &str) -> Vec<String> {
        let mut args = strings(&POWERSHELL_FLAGS);
        args.push(script.to_owned());
        args
    }

    fn grants() -> Grants {
        Grants::new(vec![KEY.to_owned()])
    }

    /// The envelope with its payload replaced, its signature left as it was.
    fn with_payload(payload: &[u8]) -> String {
        let envelope: serde_json::Value = serde_json::from_str(ENVELOPE).unwrap();
        serde_json::json!({ "payload": URL_SAFE_NO_PAD.encode(payload), "sig": envelope["sig"] })
            .to_string()
    }

    #[test]
    fn the_test_vector_verifies() {
        assert_eq!(
            sha256_hex(SCRIPT),
            "f18ad9dcb02fccf0166beea59abd9e32541e82cb2567cd03959bda808b14d7be"
        );
        let payload = verify_grant(ENVELOPE, &[KEY.to_owned()]).unwrap();
        assert_eq!(
            payload,
            serde_json::from_str::<GrantPayload>(PAYLOAD).unwrap()
        );
        assert_eq!(payload.nonce, "AAECAwQFBgcICQoLDA0ODw");
        assert_eq!(
            grants().admit(Some(ENVELOPE), PWSH, &invocation(SCRIPT), NOW),
            Ok(())
        );
        // The flags compare ignoring case, the program by its file name.
        let shouted: Vec<String> = invocation(SCRIPT)
            .iter()
            .map(|a| {
                if a == SCRIPT {
                    a.clone()
                } else {
                    a.to_uppercase()
                }
            })
            .collect();
        assert_eq!(
            grants().admit(Some(ENVELOPE), "POWERSHELL.EXE", &shouted, NOW),
            Ok(())
        );
    }

    #[test]
    fn a_changed_payload_byte_does_not_verify() {
        let mut payload = PAYLOAD.as_bytes().to_vec();
        // The last digit of expiresAt: a payload that still parses, no longer the one signed.
        let at = payload.len() - 2;
        payload[at] = b'1';
        let tampered = with_payload(&payload);
        assert!(verify_grant(&tampered, &[KEY.to_owned()]).is_err());
        let refusal = grants()
            .admit(Some(&tampered), PWSH, &invocation(SCRIPT), NOW)
            .unwrap_err();
        assert_eq!(refusal.reason, reason::REFUSED);
        assert!(refusal.why.contains("not signed"), "{}", refusal.why);
        // The signed payload put back the same way verifies: only that byte made the difference.
        assert!(verify_grant(&with_payload(PAYLOAD.as_bytes()), &[KEY.to_owned()]).is_ok());
    }

    #[test]
    fn another_key_does_not_verify_but_one_of_several_pinned_does() {
        let mut other = URL_SAFE_NO_PAD.decode(KEY).unwrap();
        other[0] ^= 1;
        let other = URL_SAFE_NO_PAD.encode(other);
        assert!(valid_key(&other));
        let refusal = Grants::new(vec![other.clone()])
            .admit(Some(ENVELOPE), PWSH, &invocation(SCRIPT), NOW)
            .unwrap_err();
        assert_eq!(refusal.reason, reason::REFUSED);
        let both = Grants::new(vec![other, KEY.to_owned()]);
        assert_eq!(
            both.admit(Some(ENVELOPE), PWSH, &invocation(SCRIPT), NOW),
            Ok(())
        );
    }

    #[test]
    fn a_grant_holds_only_within_its_times() {
        let admit = |now| grants().admit(Some(ENVELOPE), PWSH, &invocation(SCRIPT), now);
        assert_eq!(admit(1_795_400_300_000), Ok(()));
        assert_eq!(
            admit(1_795_400_300_001).unwrap_err().why,
            "the grant expired"
        );
        // Issued up to 30 s ahead of this clock is a clocks' difference; more is refused.
        assert_eq!(admit(1_795_400_000_000 - 30_000), Ok(()));
        assert!(
            admit(1_795_400_000_000 - 30_001)
                .unwrap_err()
                .why
                .contains("future")
        );
        let payload = |kind: &str, issued: u64, expires: u64| GrantPayload {
            kind: kind.into(),
            command_sha256: sha256_hex(SCRIPT),
            nonce: "n".into(),
            issued_at: issued,
            expires_at: expires,
        };
        assert!(check_payload(&payload("admin-run", NOW, NOW + 300_000), NOW).is_ok());
        assert!(check_payload(&payload("admin-run", NOW, NOW + 300_001), NOW).is_err());
        assert!(check_payload(&payload("admin-run", NOW, NOW), NOW).is_err());
        assert!(check_payload(&payload("password", NOW, NOW + 1), NOW).is_err());
    }

    #[test]
    fn only_the_approved_command_runs() {
        let refuse = |program: &str, args: &[String]| {
            grants()
                .admit(Some(ENVELOPE), program, args, NOW)
                .unwrap_err()
        };
        let changed = refuse(
            PWSH,
            &invocation("Get-Service Spooler | Format-List *; Remove-Item x"),
        );
        assert_eq!(changed.reason, reason::REFUSED);
        assert_eq!(changed.why, "the script is not the one approved");
        let cmd = refuse(r"C:\Windows\System32\cmd.exe", &invocation(SCRIPT));
        assert!(cmd.why.contains("cmd.exe"), "{}", cmd.why);
        assert!(
            refuse("pwsh", &invocation(SCRIPT))
                .why
                .contains("PowerShell")
        );
        let mut extra = invocation(SCRIPT);
        extra.push("-x".into());
        assert!(refuse(PWSH, &extra).why.contains("arguments"));
        let mut swapped = invocation(SCRIPT);
        swapped.swap(0, 1);
        assert!(refuse(PWSH, &swapped).why.contains("arguments"));
        let mut file = invocation(SCRIPT);
        file[4] = "-File".into();
        assert!(refuse(PWSH, &file).why.contains("arguments"));
        assert!(refuse(PWSH, &[SCRIPT.to_owned()]).why.contains("arguments"));
    }

    #[test]
    fn a_grant_runs_once_and_a_refused_run_leaves_it_unused() {
        let grants = grants();
        // Refused for its command: the nonce is not used up.
        assert!(
            grants
                .admit(Some(ENVELOPE), PWSH, &invocation("other"), NOW)
                .is_err()
        );
        assert_eq!(
            grants.admit(Some(ENVELOPE), PWSH, &invocation(SCRIPT), NOW),
            Ok(())
        );
        let again = grants
            .admit(Some(ENVELOPE), PWSH, &invocation(SCRIPT), NOW + 1)
            .unwrap_err();
        assert_eq!(again.reason, reason::REFUSED);
        assert_eq!(again.why, "the grant was used already");
    }

    #[test]
    fn no_grant_is_refused_and_no_pinned_key_is_untrusted() {
        let none = grants()
            .admit(None, PWSH, &invocation(SCRIPT), NOW)
            .unwrap_err();
        assert_eq!(none.reason, reason::REFUSED);
        assert_eq!(none.why, "a run as administrator needs the sandbox's grant");
        let unpinned = Grants::new(Vec::new())
            .admit(Some(ENVELOPE), PWSH, &invocation(SCRIPT), NOW)
            .unwrap_err();
        assert_eq!(unpinned.reason, reason::UNTRUSTED);
        for broken in ["", "{}", r#"{"payload":"!","sig":"AA"}"#, "not json"] {
            let refusal = grants().admit(Some(broken), PWSH, &invocation(SCRIPT), NOW);
            assert_eq!(refusal.unwrap_err().reason, reason::REFUSED, "{broken}");
        }
    }

    #[test]
    fn a_pinned_key_is_43_characters_of_base64url_of_32_bytes() {
        assert!(valid_key(KEY));
        assert!(!valid_key(&KEY[..42]));
        assert!(!valid_key(&format!("{KEY}=")));
        assert!(!valid_key(&KEY.replace('-', "+")));
        assert!(!valid_key(&URL_SAFE_NO_PAD.encode([0u8; 31])));
        assert!(!valid_key(""));
    }

    #[test]
    fn a_program_must_lie_inside_a_trusted_folder() {
        let folders = vec![
            r"C:\Windows\System32\WindowsPowerShell".to_owned(),
            r"C:\Program Files\PowerShell\".to_owned(),
        ];
        let powershell = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        assert!(inside(powershell, &folders));
        assert!(inside(
            r"\\?\c:\program files\powershell\7\pwsh.exe",
            &folders
        ));
        assert!(inside(
            "C:/Program Files/PowerShell/7-preview/pwsh.exe",
            &folders
        ));
        assert!(!inside(
            r"C:\Program Files\PowerShell\..\..\Users\x\pwsh.exe",
            &folders
        ));
        assert!(!inside(r"C:\Program Files\PowerShellX\pwsh.exe", &folders));
        assert!(!inside(
            r"C:\Users\p\AppData\Local\Microsoft\WindowsApps\pwsh.exe",
            &folders
        ));
        assert!(!inside(r"C:\Program Files\PowerShell", &folders));
        assert!(!inside(r"C:\x\pwsh.exe", &[String::new()]));
    }
}
