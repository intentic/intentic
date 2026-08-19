use sha2::{Digest, Sha256};

/// One error type for the whole binary: a message for a person at a terminal. Every failure path here ends
/// in prose (the flows are interactive installers, not a library), so carrying anything richer than the
/// sentence would only be unwrapped again at the one place it is printed — main, which exits 1 with it.
#[derive(Debug)]
pub struct Fail(pub String);

pub type Result<T> = std::result::Result<T, Fail>;

impl<E: std::fmt::Display> From<E> for Fail {
    fn from(err: E) -> Self {
        Fail(err.to_string())
    }
}

/// `bail!("…")` — stop the flow with a message. The scripts' `echo "error: …" >&2; exit 1`, as a Result.
macro_rules! bail {
    ($($arg:tt)*) => {
        return Err(crate::util::Fail(format!($($arg)*)))
    };
}
pub(crate) use bail;

/* A PHASE OF THE FLOW, ANNOUNCED ONCE — prose for the terminal, and a name for anything watching.
 *
 * The connect flow is read by two audiences at once: a person watching a terminal, and the desktop app,
 * which spawns this binary and turns its stdout into a progress bar (desktop-app/src/setupPlan.ts). The
 * second one needs to know WHICH phase started, and it cannot be asked to recognise the sentence: every
 * rewording of a step's prose would silently move somebody's progress bar, which is the one thing a
 * progress bar must never do.
 *
 * So a step carries its phase id in front of the sentence, and the id is the same vocabulary the platform's
 * setup report uses (SetupReportSchema.stage) — the browser's wait screen and the app's bar name the same
 * phase because they read the same word. Anything printed WITHOUT one is ordinary narration: detail under
 * whichever step is running, never a step of its own.
 *
 * HOW it reaches each audience is ui.rs's, and only that part differs: a pipe still gets this exact line,
 * a terminal gets the step drawn into a checklist with the id left off (there it says the same thing twice,
 * in a shape that reads like an error code). */
pub fn step(phase: &str, message: &str) {
    crate::ui::step(phase, message);
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// The per-sandbox slug the connect token derives when no explicit subdomain/hostname names it:
/// sha256(token) truncated to 12 hex chars — the same key the public hostname uses (sandbox-<id>.<zone>),
/// derived identically everywhere or a flow targets someone else's container/volumes.
pub fn slug_from_token(token: &str) -> String {
    sha256_hex(token.as_bytes())[..12].to_string()
}

/// `YYYYmmdd-HHMMSS` (UTC) for log-file names. Hand-derived from the epoch (Howard Hinnant's
/// civil-from-days) rather than pulling a date crate for one filename; UTC on purpose — the name only has
/// to sort and be readable, and local-offset lookup is the part of every date crate that grows platform hair.
pub fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

/// NAME=VALUE pairs, NUL-framed — the framing the run contract reads on stdin. NUL and not newline because
/// HOST_SSH_KEY is a multi-line private key: line framing re-splits it, which is the incident that made the
/// scripts adopt `printf '%s=%s\0'` in the first place. Empty values are dropped CALLER-side (an empty
/// secret would shadow the workspace .env the user writes later), matching connect.sh's env_pairs block.
pub fn nul_frame(pairs: &[(&str, &str)]) -> Vec<u8> {
    let mut framed = Vec::new();
    for (name, value) in pairs {
        framed.extend_from_slice(name.as_bytes());
        framed.push(b'=');
        framed.extend_from_slice(value.as_bytes());
        framed.push(0);
    }
    framed
}

/// Parse `KEY=value` lines (the setup-code claim, `intentic tunnel …` output) into a lookup. First
/// occurrence wins, mirroring how the scripts' `sed -n 's/^KEY=//p' | head -1` reads.
pub fn kv_lines(text: &str) -> impl Fn(&str) -> Option<String> + '_ {
    move |key: &str| {
        text.lines().find_map(|line| {
            line.strip_prefix(key)
                .and_then(|rest| rest.strip_prefix('='))
                .map(str::to_string)
        })
    }
}

/// HOST_NAME normalized to a valid deploy.config identifier (^[a-zA-Z_]\w*$): lower-cased, trimmed,
/// non-alnum/underscore → `_`, a leading digit prefixed with `_`; "self" is reserved (legacy HOST_SSH_KEY)
/// and becomes "host". Empty in, empty out — the caller decides the fallback. Unix-only like its one
/// caller, machine enrolment (Windows deploy targets go through connect's dind path instead).
#[cfg(unix)]
pub fn normalize_host_name(raw: &str) -> String {
    let mut name: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.starts_with(|c: char| c.is_ascii_digit()) {
        name.insert(0, '_');
    }
    if name == "self" {
        name = "host".to_string();
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_the_scripts_derivation() {
        // printf '%s' token | sha256sum | cut -c1-12
        assert_eq!(slug_from_token("token"), "3c469e9d6c58");
        assert_eq!(slug_from_token("token").len(), 12);
    }

    #[test]
    fn timestamps_are_sortable_and_shaped() {
        let stamp = timestamp();
        assert_eq!(stamp.len(), 15);
        assert_eq!(stamp.as_bytes()[8], b'-');
        assert!(stamp[..8].chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn nul_framing_survives_multiline_values() {
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----";
        let framed = nul_frame(&[("HOST_SSH_KEY", key), ("ZONE", "example.com")]);
        let parts: Vec<&[u8]> = framed
            .split(|byte| *byte == 0)
            .filter(|part| !part.is_empty())
            .collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], format!("HOST_SSH_KEY={key}").as_bytes());
    }

    #[test]
    fn kv_lines_reads_first_occurrence_and_exact_keys() {
        let lookup_in =
            "TUNNEL_TOKEN=abc\nSANDBOX_HOSTNAME=sandbox-1.example.com\nTUNNEL_TOKEN=second\n";
        let lookup = kv_lines(lookup_in);
        assert_eq!(lookup("TUNNEL_TOKEN").as_deref(), Some("abc"));
        assert_eq!(
            lookup("SANDBOX_HOST"),
            None,
            "prefix of a key must not match it"
        );
        assert_eq!(lookup("MISSING"), None);
    }

    #[cfg(unix)]
    #[test]
    fn host_names_normalize_like_connect_host() {
        assert_eq!(normalize_host_name("My-Server.local"), "my_server_local");
        assert_eq!(normalize_host_name("9front"), "_9front");
        assert_eq!(normalize_host_name("self"), "host");
        assert_eq!(normalize_host_name("  "), "");
    }
}
