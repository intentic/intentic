use std::sync::OnceLock;

/* WHAT A REPORT MAY SAY ABOUT THE MACHINE IT CAME FROM. A setup failure (`/setup/report`) and a host report
(`/host-report`) carry free text off this computer: a docker log tail, a path, a command to run. The platform stores it
and shows it on the owner's page and to its admins beside the owner's address, so it leaves here with the machine's
private details taken out: this user's home directory (as `~`), anyone's home directory under /home or Users, the user
and host names, email and IP addresses, and anything shaped like a credential (a `Bearer` value, a `sk-`/`ghp_`-style
key, a `*_TOKEN=`/`password:` value, a long random-looking string such as a connect or pair token). Loopback addresses
stay: they say which port collided and name nobody.

(2026-11-24) Hand-rolled rather than `regex`: the bootstrap shims download this binary on every run, and every pattern
here is a run of ASCII characters a short scan reads. What looks random is judged by its mix of letters and digits, so
a CamelCase name or a lowercase hex digest (an image, a container) is kept. */

/// What a credential is replaced with.
pub const REDACTED: &str = "<redacted>";

/// Who and where this machine is, as text may name it.
#[derive(Default)]
pub struct Own {
    pub homes: Vec<String>,
    pub users: Vec<String>,
    pub hosts: Vec<String>,
}

/// Words a user or host name may also be that a report needs to keep: a machine called `sandbox` must not turn every
/// `ic sandbox …` into `ic <host> …`.
const COMMON: &[&str] = &[
    "root",
    "user",
    "users",
    "admin",
    "administrator",
    "docker",
    "runner",
    "ubuntu",
    "debian",
    "intentic",
    "node",
    "host",
    "email",
    "redacted",
    "public",
    "default",
    "shared",
    "home",
    "sandbox",
    "localhost",
    "this-device",
];

impl Own {
    /// This machine, read from the environment and the files that name it; nothing is run.
    fn this_machine() -> Own {
        let env = |key: &str| {
            std::env::var(key)
                .ok()
                .map(|value| value.trim().to_string())
        };
        let file = |path: &str| {
            std::fs::read_to_string(path)
                .ok()
                .map(|value| value.trim().to_string())
        };
        let homes: Vec<String> = ["HOME", "USERPROFILE"]
            .iter()
            .filter_map(|key| env(key))
            .collect();
        let mut users: Vec<String> = ["USER", "USERNAME", "LOGNAME"]
            .iter()
            .filter_map(|key| env(key))
            .collect();
        users.extend(homes.iter().filter_map(|home| last_segment(home)));
        let mut hosts: Vec<Option<String>> = vec![
            env("HOST_LABEL"),
            env("COMPUTERNAME"),
            env("HOSTNAME"),
            file("/etc/hostname"),
            file("/proc/sys/kernel/hostname"),
        ];
        // A fully qualified name is also written by its first label (`ada-laptop.local` as `ada-laptop`).
        let first_labels: Vec<Option<String>> = hosts
            .iter()
            .flatten()
            .filter_map(|host| {
                host.split_once('.')
                    .map(|(label, _)| Some(label.to_string()))
            })
            .collect();
        hosts.extend(first_labels);
        Own {
            homes: kept(homes, 4),
            users: kept(users, 3),
            hosts: kept(hosts.into_iter().flatten().collect(), 3),
        }
    }
}

/// The names long enough to replace and not common words, each once, the longest first so a longer name is never
/// half-replaced by a shorter one inside it.
fn kept(names: Vec<String>, min: usize) -> Vec<String> {
    let mut names: Vec<String> = names
        .into_iter()
        .filter(|name| {
            name.len() >= min
                && name != "/"
                && !COMMON.contains(&name.to_ascii_lowercase().as_str())
        })
        .collect();
    names.sort_by_key(|name| std::cmp::Reverse(name.len()));
    names.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    names
}

fn last_segment(path: &str) -> Option<String> {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
}

fn own() -> &'static Own {
    static OWN: OnceLock<Own> = OnceLock::new();
    OWN.get_or_init(Own::this_machine)
}

/// `text` as it may leave this machine.
pub fn scrub(text: &str) -> String {
    scrub_with(text, own(), &[])
}

/// The same, with values the caller knows are secret (a setup code) taken out wherever they appear.
pub fn scrub_known(text: &str, secrets: &[&str]) -> String {
    scrub_with(text, own(), secrets)
}

/// The scrub over a given machine. Pure. Credentials go first, so a token that happens to contain a user name is
/// replaced whole; emails before names, since an address's local part is often the user name.
pub fn scrub_with(text: &str, own: &Own, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for secret in secrets.iter().filter(|secret| secret.len() >= 6) {
        out = out.replace(secret, REDACTED);
    }
    out = url_userinfo(&out);
    out = assignments(&out);
    out = bearer(&out);
    out = runs(&out, is_token_char, |_, run, _| credential(run));
    out = runs(&out, is_email_char, |_, run, _| email(run));
    for home in &own.homes {
        for written in spellings(home) {
            out = replace_bounded(&out, &written, "~", is_path_name_char);
        }
    }
    out = other_homes(&out);
    out = runs(&out, |b| b.is_ascii_digit() || b == b'.', ipv4);
    out = runs(&out, |b| b.is_ascii_hexdigit() || b == b':', ipv6);
    for host in &own.hosts {
        out = replace_bounded(&out, host, "<host>", is_host_char);
    }
    for user in &own.users {
        out = replace_bounded(&out, user, "<user>", is_word_char);
    }
    out
}

fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_host_char(b: u8) -> bool {
    is_word_char(b) || b == b'-'
}

fn is_path_name_char(b: u8) -> bool {
    is_host_char(b) || b == b'.'
}

fn is_token_char(b: u8) -> bool {
    is_host_char(b)
}

fn is_email_char(b: u8) -> bool {
    is_path_name_char(b) || matches!(b, b'%' | b'+' | b'@')
}

/// Each maximal run of bytes `in_run` accepts, rewritten where `judge` (given the bytes either side) says so. Every
/// byte a run holds is ASCII, so each cut falls on a character boundary.
fn runs(
    text: &str,
    in_run: impl Fn(u8) -> bool,
    judge: impl Fn(Option<u8>, &str, Option<u8>) -> Option<String>,
) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if !in_run(bytes[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && in_run(bytes[at]) {
            at += 1;
        }
        let before = start.checked_sub(1).map(|i| bytes[i]);
        if let Some(rewritten) = judge(before, &text[start..at], bytes.get(at).copied()) {
            out.push_str(&text[copied..start]);
            out.push_str(&rewritten);
            copied = at;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// Every occurrence of `needle` (ASCII case aside) that is not part of a longer name, as `with`.
fn replace_bounded(text: &str, needle: &str, with: &str, is_name: fn(u8) -> bool) -> String {
    let (bytes, wanted) = (text.as_bytes(), needle.as_bytes());
    if wanted.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at + wanted.len() <= bytes.len() {
        let here = bytes[at..at + wanted.len()].eq_ignore_ascii_case(wanted);
        let open = at == 0 || !is_name(bytes[at - 1]) || !is_name(wanted[0]);
        let end = at + wanted.len();
        let close =
            end == bytes.len() || !is_name(bytes[end]) || !is_name(wanted[wanted.len() - 1]);
        if here && open && close && text.is_char_boundary(at) && text.is_char_boundary(end) {
            out.push_str(&text[copied..at]);
            out.push_str(with);
            copied = end;
            at = end;
        } else {
            at += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// A Windows home as a log may print it: as is, with forward slashes, and JSON-escaped.
fn spellings(home: &str) -> Vec<String> {
    let mut all = vec![home.to_string()];
    if home.contains('\\') {
        all.push(home.replace('\\', "/"));
        all.push(home.replace('\\', "\\\\"));
    }
    all
}

/// The name after `/home/` or `Users\` (any slashes, any case) of a home that is not this user's: another account's,
/// or a Windows home seen from WSL (`/mnt/c/Users/Ada`). A placeholder or a variable (`$USER`, `%USERNAME%`) stays.
fn other_homes(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        let Some(mut name_start) = home_parent_end(bytes, at) else {
            at += 1;
            continue;
        };
        while name_start < bytes.len() && matches!(bytes[name_start], b'/' | b'\\') {
            name_start += 1;
        }
        let mut name_end = name_start;
        while name_end < bytes.len() && is_path_name_char(bytes[name_end]) {
            name_end += 1;
        }
        if name_end > name_start {
            out.push_str(&text[copied..name_start]);
            out.push_str("<user>");
            copied = name_end;
        }
        at = name_end.max(at + 1);
    }
    out.push_str(&text[copied..]);
    out
}

/// Where `home` or `users` ends when it starts at `at` right after a slash, as a whole path segment.
fn home_parent_end(bytes: &[u8], at: usize) -> Option<usize> {
    if at == 0 || !matches!(bytes[at - 1], b'/' | b'\\') {
        return None;
    }
    ["home", "users"].iter().find_map(|segment| {
        let end = at + segment.len();
        let named = bytes.get(at..end)?.eq_ignore_ascii_case(segment.as_bytes());
        (named && matches!(bytes.get(end), Some(b'/' | b'\\'))).then_some(end)
    })
}

/// `scheme://user:password@host`: the part before the `@` is a credential.
fn url_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme) = rest.find("://") {
        let start = scheme + 3;
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest
            .find(|c: char| matches!(c, '/' | '@' | '?' | '#' | '"' | '\'') || c.is_whitespace())
            .unwrap_or(rest.len());
        if end > 0 && rest[end..].starts_with('@') {
            out.push_str(REDACTED);
            rest = &rest[end..];
        }
    }
    out.push_str(rest);
    out
}

/// Names whose value is a credential however it is written: `CONNECT_TOKEN=…`, `"connectToken": "…"`,
/// `password: …`, `?token=…`, `x-intentic-connect: …`.
fn sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    crate::logfile::sensitive_env_name(name)
        || ["Token", "Secret", "Password", "Key"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
        || [
            "token",
            "secret",
            "password",
            "passwd",
            "apikey",
            "api-key",
            "x-api-key",
            "x-intentic-connect",
            "access_token",
            "refresh_token",
            "client_secret",
        ]
        .contains(&lower.as_str())
        || header_like(name)
}

/// Header names whose whole value, to the end of the line, is the credential (`Authorization: Basic …`).
fn header_like(name: &str) -> bool {
    [
        "authorization",
        "proxy-authorization",
        "cookie",
        "set-cookie",
    ]
    .contains(&name.to_ascii_lowercase().as_str())
}

fn assignments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if !matches!(bytes[at], b'=' | b':') {
            at += 1;
            continue;
        }
        let name = name_before(text, at);
        if name.is_empty() || !sensitive_name(name) {
            at += 1;
            continue;
        }
        let (from, to) = value_span(bytes, at + 1, header_like(name));
        if to > from {
            out.push_str(&text[copied..from]);
            out.push_str(REDACTED);
            copied = to;
            at = to;
        } else {
            at += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// The name a `=` or `:` at `at` assigns to, past a closing quote (escaped or not).
fn name_before(text: &str, at: usize) -> &str {
    let bytes = text.as_bytes();
    let mut end = at;
    if end > 0 && matches!(bytes[end - 1], b'"' | b'\'') {
        end -= 1;
        if end > 0 && bytes[end - 1] == b'\\' {
            end -= 1;
        }
    }
    let mut start = end;
    while start > 0 && is_token_char(bytes[start - 1]) {
        start -= 1;
    }
    &text[start..end]
}

/// The value after a separator: a quoted one to its closing quote, else to the end of the word (or the line, for a
/// header). Spaces after the separator are skipped.
fn value_span(bytes: &[u8], mut at: usize, to_line_end: bool) -> (usize, usize) {
    while at < bytes.len() && bytes[at] == b' ' {
        at += 1;
    }
    if bytes.get(at) == Some(&b'\\') && matches!(bytes.get(at + 1), Some(b'"' | b'\'')) {
        at += 1;
    }
    if let Some(&quote) = bytes.get(at).filter(|b| matches!(b, b'"' | b'\'')) {
        let from = at + 1;
        let mut to = from;
        while to < bytes.len() && !matches!(bytes[to], b'\\' | b'\n') && bytes[to] != quote {
            to += 1;
        }
        return (from, to);
    }
    let mut to = at;
    while to < bytes.len() && !ends_value(bytes[to], to_line_end) {
        to += 1;
    }
    (at, to)
}

fn ends_value(b: u8, to_line_end: bool) -> bool {
    let word_ends = b.is_ascii_whitespace()
        || matches!(b, b'"' | b'\'' | b',' | b';' | b'&' | b'}' | b')' | b']');
    matches!(b, b'\n' | b'\r') || (!to_line_end && word_ends)
}

/// `Bearer <value>`, in any case.
fn bearer(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at + 7 <= bytes.len() {
        let word = bytes[at..at + 6].eq_ignore_ascii_case(b"bearer")
            && (at == 0 || !is_word_char(bytes[at - 1]));
        if !word || bytes[at + 6] != b' ' {
            at += 1;
            continue;
        }
        let from = at + 7;
        let mut to = from;
        while to < bytes.len()
            && (is_token_char(bytes[to]) || matches!(bytes[to], b'.' | b'~' | b'+' | b'/' | b'='))
        {
            to += 1;
        }
        if to - from >= 8 {
            out.push_str(&text[copied..from]);
            out.push_str(REDACTED);
            copied = to;
        }
        at = to.max(at + 1);
    }
    out.push_str(&text[copied..]);
    out
}

/// The prefixes providers give their keys.
const KEY_PREFIXES: &[&str] = &[
    "sk-",
    "sk_",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
];

/// A word that is a credential: a provider-prefixed key, or a long string whose mix of characters is a random one's
/// (a connect token is 22 base62 characters, a pair token 43 base64url). A CamelCase name has too few capitals and a
/// hex digest none, so both stay.
fn credential(run: &str) -> Option<String> {
    let prefixed = KEY_PREFIXES
        .iter()
        .any(|prefix| run.len() >= prefix.len() + 8 && run.starts_with(prefix));
    let count = |test: fn(&u8) -> bool| run.bytes().filter(test).count();
    let (upper, lower, digit) = (
        count(u8::is_ascii_uppercase),
        count(u8::is_ascii_lowercase),
        count(u8::is_ascii_digit),
    );
    let random = run.len() >= 20 && upper > 0 && lower > 0 && (digit > 0 || upper * 4 >= run.len());
    (prefixed || random).then(|| REDACTED.to_string())
}

/// `local@domain.tld`, with any trailing full stop kept outside it.
fn email(run: &str) -> Option<String> {
    let trimmed = run.trim_end_matches(['.', '-']);
    let (local, domain) = trimmed.split_once('@')?;
    let tld = domain.rsplit('.').next()?;
    let valid = !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && tld.len() >= 2
        && tld.bytes().all(|b| b.is_ascii_alphabetic());
    valid.then(|| format!("<email>{}", &run[trimmed.len()..]))
}

/// A dotted IPv4 address standing as its own word, but not loopback or the unspecified address.
fn ipv4(before: Option<u8>, run: &str, after: Option<u8>) -> Option<String> {
    let word = |b: Option<u8>| b.is_some_and(|b| b.is_ascii_alphanumeric());
    let trimmed = run.trim_end_matches('.');
    let parts: Vec<&str> = trimmed.split('.').collect();
    let address = parts.len() == 4
        && parts.iter().all(|part| {
            (1..=3).contains(&part.len()) && part.parse::<u16>().is_ok_and(|n| n <= 255)
        });
    let quiet = trimmed.starts_with("127.") || trimmed == "0.0.0.0";
    (address && !quiet && !word(before) && !word(after))
        .then(|| format!("<ip>{}", &run[trimmed.len()..]))
}

/// An IPv6 address standing as its own word: eight groups, or a `::` and at least two groups (so `::1` and `::` stay,
/// and a clock's `12:34:56` is not one).
fn ipv6(before: Option<u8>, run: &str, after: Option<u8>) -> Option<String> {
    let word = |b: Option<u8>| b.is_some_and(is_word_char);
    let trimmed = if run.ends_with("::") {
        run
    } else {
        run.trim_end_matches(':')
    };
    let groups: Vec<&str> = trimmed.split(':').collect();
    let named = groups.iter().filter(|group| !group.is_empty()).count();
    let shaped = groups.iter().all(|group| group.len() <= 4)
        && if trimmed.contains("::") {
            named >= 2
        } else {
            groups.len() == 8 && named == 8
        };
    (shaped && !word(before) && !word(after)).then(|| format!("<ip>{}", &run[trimmed.len()..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ada() -> Own {
        Own {
            homes: vec!["/home/ada".into(), "C:\\Users\\Ada".into()],
            users: vec!["ada".into()],
            hosts: vec!["ada-laptop".into()],
        }
    }

    fn scrubbed(text: &str) -> String {
        scrub_with(text, &ada(), &[])
    }

    #[test]
    fn the_home_directory_becomes_a_tilde_and_anyone_elses_home_loses_its_name() {
        assert_eq!(
            scrubbed("open /home/ada/.intentic/logs/x.log and /home/bob/x"),
            "open ~/.intentic/logs/x.log and /home/<user>/x"
        );
        assert_eq!(scrubbed(r"C:\Users\Ada\AppData\Local"), r"~\AppData\Local");
        assert_eq!(
            scrubbed(r#"{"path":"C:\\Users\\Ada\\x"}"#),
            r#"{"path":"~\\x"}"#
        );
        assert_eq!(
            scrubbed("/mnt/c/Users/Zoe/Docker"),
            "/mnt/c/Users/<user>/Docker"
        );
        assert_eq!(
            scrubbed("/home/$USER/x and /home/adam"),
            "/home/$USER/x and /home/<user>"
        );
    }

    #[test]
    fn the_user_and_host_names_are_replaced_as_whole_words_only() {
        assert_eq!(
            scrubbed("Ada on ada-laptop.local: sudo usermod -aG docker ada"),
            "<user> on <host>.local: sudo usermod -aG docker <user>"
        );
        assert_eq!(
            scrubbed("adapter canada ada-laptops"),
            "adapter canada <user>-laptops"
        );
        assert_eq!(scrubbed("exit code: 125, code=1"), "exit code: 125, code=1");
    }

    #[test]
    fn emails_and_addresses_are_replaced_and_loopback_stays() {
        assert_eq!(scrubbed("mail ada.l@example.co.uk."), "mail <email>.");
        assert_eq!(
            scrubbed("image@sha256:abc node@20.1.0"),
            "image@sha256:abc node@20.1.0"
        );
        assert_eq!(
            scrubbed("dial tcp 192.168.1.20:443, then 127.0.0.1:6480 and 0.0.0.0"),
            "dial tcp <ip>:443, then 127.0.0.1:6480 and 0.0.0.0"
        );
        assert_eq!(
            scrubbed("inet6 fe80::1c2:3ff:fe4d:5e6f/64 and ::1"),
            "inet6 <ip>/64 and ::1"
        );
        assert_eq!(scrubbed("2001:db8:85a3:0:0:8a2e:370:7334"), "<ip>");
        assert_eq!(
            scrubbed("at 12:34:56 std::io::Error v1.2.3.4"),
            "at 12:34:56 std::io::Error v1.2.3.4"
        );
    }

    #[test]
    fn credentials_are_redacted_however_they_are_written() {
        assert_eq!(
            scrubbed("Authorization: Bearer abc.def-ghi_jkl"),
            "Authorization: <redacted>"
        );
        assert_eq!(
            scrubbed("curl -H 'bearer abcdefgh1234'"),
            "curl -H 'bearer <redacted>'"
        );
        assert_eq!(
            scrubbed("key sk-proj-abcdefgh1234 and ghp_abcdefghijkl and github_pat_11ABCDEFG"),
            "key <redacted> and <redacted> and <redacted>"
        );
        assert_eq!(
            scrubbed("CONNECT_TOKEN=abc SYNC_PAIR_TOKEN=\"x y\" OWNER_EMAIL=a@b.co"),
            "CONNECT_TOKEN=<redacted> SYNC_PAIR_TOKEN=\"<redacted>\" OWNER_EMAIL=<redacted>"
        );
        assert_eq!(
            scrubbed(r#"{"connectToken": "abc", "password":"p"}"#),
            r#"{"connectToken": "<redacted>", "password":"<redacted>"}"#
        );
        assert_eq!(
            scrubbed(r#"{\"apiKey\":\"abc\"}"#),
            r#"{\"apiKey\":\"<redacted>\"}"#
        );
        assert_eq!(
            scrubbed("x-intentic-connect: Tok3n"),
            "x-intentic-connect: <redacted>"
        );
        assert_eq!(
            scrubbed("GET /claim?token=abc&x=1"),
            "GET /claim?token=<redacted>&x=1"
        );
        assert_eq!(
            scrubbed("https://ada:pw@git.example.com/r"),
            "https://<redacted>@git.example.com/r"
        );
    }

    #[test]
    fn random_looking_strings_go_and_names_and_digests_stay() {
        // A connect token (22 base62), a pair token (43 base64url), and one that happens to hold no digit.
        assert_eq!(
            scrubbed("token 4fK9qLmZ2xR7vT1bN8sWcD here"),
            "token <redacted> here"
        );
        assert_eq!(
            scrubbed("kQ3_vZ8-mN1xR5tY7wB2cD4fG6hJ9kL0pS3uV5xZ8aC"),
            REDACTED
        );
        assert_eq!(scrubbed("aBcDeFgHiJkLmNoPqRsTuV"), REDACTED);
        let kept = "HostReportInputSchema sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 Microsoft-Windows-Subsystem-Linux";
        assert_eq!(scrubbed(kept), kept);
    }

    #[test]
    fn a_known_secret_goes_wherever_it_appears() {
        assert_eq!(
            scrub_with("code AbC123xyZ90 failed", &Own::default(), &["AbC123xyZ90"]),
            "code <redacted> failed"
        );
    }

    #[test]
    fn common_words_and_short_names_are_never_taken_for_this_machine() {
        let kept = kept(
            vec![
                "sandbox".into(),
                "root".into(),
                "ab".into(),
                "Ada".into(),
                "ada".into(),
            ],
            3,
        );
        assert_eq!(kept, vec!["Ada".to_string()]);
        assert_eq!(last_segment(r"C:\Users\Ada\"), Some("Ada".to_string()));
    }

    #[test]
    fn text_with_no_ascii_is_left_whole() {
        assert_eq!(
            scrubbed("Zażółć gęślą jaźń — ada"),
            "Zażółć gęślą jaźń — <user>"
        );
    }
}
