use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::docker;
use crate::logfile::intentic_home;
use crate::sandbox::loopback;
use crate::sandbox::{container_of, now_ms};
use crate::ui;
use crate::util::{bail, Result};

/* `ic sandbox session <slug> --json` — a daemon session for the sandbox's owner, minted by the machine that runs it.

The desktop app's offline face and `ic sandbox attention` reach a sandbox over its loopback port with no network, where
no sign-in the browser knows works (Google's keys and the platform are fetched; a passkey answers only on the editor's
own origin). The daemon takes one more proof: the machine itself. `docker exec` runs its `host-session-cli.js` inside the
container as root, which reads the session secret and the owner file directly and prints a session for the bound owner
(the daemon's auth/host/host-session.ts has the trust model). There is no HTTP route for it, and a sandbox nobody has signed
in to yet mints none: the first binding still takes a real sign-in.

The token is a credential: it goes to stdout and to this user's own session cache (0600, under ~/.intentic/sessions),
and nowhere else: never a log, never an argument. */

/// The daemon's mint, as the image ships it. An image from before it has no such file.
const SCRIPT: &str = "/opt/sandbox/dist/auth/host/host-session-cli.js";

/// A mint reads two small files and signs a token; past this the container is in trouble.
const LIMIT: Duration = Duration::from_secs(20);

/// How long before a cached session expires it is minted again rather than used: a session that runs out between the
/// read and the call is a refusal nobody needed.
const RENEW_AHEAD_MS: u64 = 60 * 60 * 1000;

/// The daemon's exit codes (host-session.ts `HOST_SESSION_EXIT`).
const NO_OWNER: i32 = 3;
const OWNER_UNREADABLE: i32 = 4;
const ACCESS_REMOVED: i32 = 5;

/// One minted session and where to use it: what `--json` prints, and what the cache keeps.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSession {
    pub slug: String,
    pub sandbox_id: Option<String>,
    pub platform_id: Option<String>,
    pub local_port: Option<u16>,
    pub email: String,
    pub token: String,
    pub expires_at: u64,
}

impl HostSession {
    /// Whether it is still worth sending at `now`. Pure.
    pub fn fresh_at(&self, now: u64) -> bool {
        self.expires_at > now.saturating_add(RENEW_AHEAD_MS)
    }
}

/// What the daemon's script printed. Pure.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Minted {
    email: String,
    token: String,
    expires_at: u64,
    platform_id: Option<String>,
}

/// The script's one JSON line, out of whatever else rode on stdout. Pure.
fn minted_from(stdout: &str) -> Option<Minted> {
    stdout
        .lines()
        .map(str::trim)
        .rfind(|line| line.starts_with('{'))
        .and_then(|line| serde_json::from_str(line).ok())
}

/// Why no session came back, in words a person can act on. Pure.
fn refusal(slug: &str, code: Option<i32>, stderr: &str) -> String {
    let said = stderr.trim();
    if code == Some(127) || code == Some(126) || said.contains("Cannot find module") {
        return ui::explain(
            &format!("{slug} cannot be opened without the internet yet."),
            Some("It runs a version from before this computer could sign in to it on its own."),
            Some(&format!("ic sandbox update {slug}")),
        );
    }
    match code {
        Some(NO_OWNER) => ui::explain(
            &format!("Nobody has signed in to {slug} yet."),
            Some("Its owner signs in once, with the internet, before this computer can open it on its own."),
            None,
        ),
        Some(OWNER_UNREADABLE) => ui::explain(
            &format!("{slug}'s owner file cannot be read, so it cannot say whose it is."),
            None,
            Some(&format!("ic sandbox reset-owner {slug}")),
        ),
        Some(ACCESS_REMOVED) => ui::explain(
            &format!("Signing in to {slug} has been turned off."),
            Some("Its account was deleted, which ends every way in."),
            None,
        ),
        None => ui::explain(
            &format!("{slug} did not make a session in time."),
            Some(&format!("It did not answer within {}s.", LIMIT.as_secs())),
            Some(&format!("ic sandbox doctor {slug}")),
        ),
        Some(_) => ui::explain(
            &format!("{slug} did not make a session."),
            (!said.is_empty()).then_some(said),
            Some(&format!("ic sandbox doctor {slug}")),
        ),
    }
}

/// The container's inspect object, for its addressing.
fn inspected(container: &str) -> Option<Value> {
    docker::capture_bounded(&["inspect", "--format", "{{json .}}", container], LIMIT)
        .ok()
        .filter(|ran| ran.code == Some(0))
        .and_then(|ran| serde_json::from_str(ran.stdout.trim()).ok())
}

/// A fresh session from the sandbox, kept in this user's cache for the next caller. Err says why there is none.
pub fn mint(slug: &str) -> Result<HostSession> {
    docker::require_daemon()?;
    let container = container_of(slug);
    let Some(inspected) = inspected(&container) else {
        bail!("{}", crate::sandbox::missing(slug));
    };
    if inspected["State"]["Running"] != true {
        bail!(
            "{}",
            ui::explain(
                &format!("{slug} is not running, so it cannot make a session."),
                None,
                Some(&format!("ic sandbox start {slug}")),
            )
        );
    }
    // Run as the container's own user (root): the script reads the 0600 session secret, which nothing else may.
    let ran = docker::capture_bounded(&["exec", &container, "node", SCRIPT], LIMIT)?;
    let minted = match (ran.timed_out, ran.code) {
        (false, Some(0)) => minted_from(&ran.stdout),
        _ => None,
    };
    let Some(minted) = minted else {
        bail!(
            "{}",
            refusal(
                slug,
                if ran.timed_out { None } else { ran.code },
                &ran.stderr
            )
        );
    };
    let (sandbox_id, local_port) = loopback::addressing(&inspected);
    let session = HostSession {
        slug: slug.to_string(),
        sandbox_id,
        platform_id: minted.platform_id,
        local_port,
        email: minted.email,
        token: minted.token,
        expires_at: minted.expires_at,
    };
    if let Err(err) = remember(&session) {
        // A cache that cannot be written costs the next caller a mint, nothing more.
        ui::warn(&format!("The session was not kept for later: {err}"));
    }
    Ok(session)
}

/// `ic sandbox session <slug> --json`: one line of JSON on stdout, and nothing else there.
pub fn run_json(slug: &str) -> Result<()> {
    let session = mint(slug)?;
    // allow(terminal-output): the --json answer, one line the desktop app reads.
    println!(
        "{}",
        serde_json::to_string(&session).map_err(|err| crate::util::Fail(err.to_string()))?
    );
    Ok(())
}

/* THE CACHE: one file per sandbox, this user's alone. A session lasts a week, the daemon takes it only on the loopback
port (host-session.ts), and minting one is a `docker exec` of a second or so, which `ic sandbox attention` would
otherwise pay for every sandbox on every round. */

fn cache_dir() -> PathBuf {
    intentic_home().join("sessions")
}

fn cache_file_in(dir: &Path, slug: &str) -> PathBuf {
    dir.join(format!("{slug}.json"))
}

/// The session last minted for `slug`, while it is still worth sending; None otherwise (none kept, one this binary
/// cannot read, one about to expire).
pub fn cached(slug: &str) -> Option<HostSession> {
    cached_in(&cache_dir(), slug, now_ms())
}

fn cached_in(dir: &Path, slug: &str, now: u64) -> Option<HostSession> {
    let text = std::fs::read_to_string(cache_file_in(dir, slug)).ok()?;
    serde_json::from_str::<HostSession>(&text)
        .ok()
        .filter(|session| session.slug == slug && session.fresh_at(now))
}

/// The cached session or a fresh one.
pub fn cached_or_minted(slug: &str) -> Result<HostSession> {
    match cached(slug) {
        Some(session) => Ok(session),
        None => mint(slug),
    }
}

/// Drops the cached session, after the daemon refused it (re-keyed, a new owner).
pub fn forget(slug: &str) {
    let _ = std::fs::remove_file(cache_file_in(&cache_dir(), slug));
}

fn remember(session: &HostSession) -> std::io::Result<()> {
    remember_in(&cache_dir(), session)
}

/// Written whole and private: the folder 0700 and the file 0600 from the moment it exists, never widened after.
fn remember_in(dir: &Path, session: &HostSession) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    restrict(dir, 0o700)?;
    let body = serde_json::to_vec(session).map_err(std::io::Error::other)?;
    let mut staged = tempfile::NamedTempFile::new_in(dir)?;
    std::io::Write::write_all(&mut staged, &body)?;
    // NamedTempFile is created 0600 on unix already; said again so the rule does not rest on a crate's default.
    restrict(staged.path(), 0o600)?;
    staged
        .persist(cache_file_in(dir, &session.slug))
        .map_err(|err| err.error)?;
    Ok(())
}

#[cfg(unix)]
fn restrict(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

/// A Windows profile folder is the user's own already.
#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scripts_line_is_read_out_of_whatever_else_was_printed() {
        let stdout = "(node:1) ExperimentalWarning: something\n{\"email\":\"o@x.dev\",\"token\":\"t\",\"expiresAt\":5,\"platformId\":null}\n";
        assert_eq!(
            minted_from(stdout),
            Some(Minted {
                email: "o@x.dev".to_string(),
                token: "t".to_string(),
                expires_at: 5,
                platform_id: None,
            })
        );
        assert_eq!(minted_from("nothing here"), None);
    }

    #[test]
    fn each_refusal_says_what_a_person_does_about_it() {
        assert!(refusal(
            "lab",
            Some(1),
            "Error: Cannot find module '/opt/sandbox/dist/auth/host/host-session-cli.js'"
        )
        .contains("ic sandbox update lab"));
        assert!(refusal("lab", Some(NO_OWNER), "").contains("Nobody has signed in"));
        assert!(refusal("lab", Some(OWNER_UNREADABLE), "").contains("ic sandbox reset-owner lab"));
        assert!(refusal("lab", Some(ACCESS_REMOVED), "").contains("turned off"));
        assert!(refusal("lab", None, "").contains("in time"));
        assert!(refusal("lab", Some(1), "disk full").contains("disk full"));
    }

    #[test]
    fn a_session_close_to_its_end_is_minted_again() {
        let session = HostSession {
            slug: "lab".to_string(),
            sandbox_id: Some("3c469e9d6c58".to_string()),
            platform_id: None,
            local_port: Some(30238),
            email: "o@x.dev".to_string(),
            token: "t".to_string(),
            expires_at: 10 * RENEW_AHEAD_MS,
        };
        assert!(session.fresh_at(0));
        assert!(!session.fresh_at(9 * RENEW_AHEAD_MS));
        // What --json prints, in the shape the desktop app reads.
        assert_eq!(
            serde_json::to_value(&session).unwrap(),
            serde_json::json!({ "slug": "lab", "sandboxId": "3c469e9d6c58", "platformId": null, "localPort": 30238, "email": "o@x.dev", "token": "t", "expiresAt": 10 * RENEW_AHEAD_MS })
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_cache_is_this_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("sessions");
        let session = HostSession {
            slug: "lab".to_string(),
            sandbox_id: None,
            platform_id: None,
            local_port: None,
            email: "o@x.dev".to_string(),
            token: "t".to_string(),
            expires_at: 30 * RENEW_AHEAD_MS,
        };
        remember_in(&dir, &session).unwrap();
        let mode = |path: PathBuf| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(dir.clone()), 0o700);
        assert_eq!(mode(cache_file_in(&dir, "lab")), 0o600);
        assert_eq!(cached_in(&dir, "lab", 0), Some(session));
        // Close to its end it is not handed out, and another sandbox's name finds nothing.
        assert_eq!(cached_in(&dir, "lab", 29 * RENEW_AHEAD_MS + 1), None);
        assert_eq!(cached_in(&dir, "other", 0), None);
    }
}
