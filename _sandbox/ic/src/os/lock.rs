//! The desktop's optional screen PIN. It is the lock screen's own secret, never an account password: ic keeps a salted
//! hash of it in a folder only the `intentic` user can read, and the lock screen asks ic (`ic os lock check`, through
//! pam_exec in the desktop image's /etc/pam.d/swaylock) instead of the account database. The `intentic` account's own
//! password stays locked, so no login (a console, the session's text prompt, SSH) ever accepts the PIN, and the PIN is
//! never a way in to the account that runs Docker.

use std::io::Read;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::Paths;
use crate::util::{bail, Fail, Result};

const HEADER: &str = "# intentic-lock ";

/// The session's lock screen. It locks only while a PIN is set, so it can never lock with nothing that unlocks.
const SCREEN_LOCK: &str = "/usr/libexec/intentic-os/screen-lock";

/// PBKDF2-HMAC-SHA256 rounds. Only the account the PIN protects can read the hash, so the lockout below is what stands
/// between a person at the keyboard and the PIN; the rounds make a copied file slow to search, at about a tenth of a
/// second per unlock.
const ROUNDS: u32 = 210_000;

/// Misses in a row that cost nothing. From this one on, each miss starts a wait, doubling from [`FIRST_WAIT_SECS`] up
/// to [`LONGEST_WAIT_SECS`], during which no PIN is checked at all.
const FREE_MISSES: u32 = 5;
const FIRST_WAIT_SECS: u64 = 30;
const LONGEST_WAIT_SECS: u64 = 3600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub idle_minutes: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            idle_minutes: 5,
        }
    }
}

fn parse_config(config: &str) -> Settings {
    config
        .lines()
        .next()
        .and_then(|line| line.strip_prefix(HEADER))
        .and_then(|json| serde_json::from_str::<Settings>(json).ok())
        .filter(|settings| (1..=240).contains(&settings.idle_minutes))
        .unwrap_or_default()
}

fn config(settings: &Settings) -> String {
    // A user unit owns swayidle. Reloading sway restarts that one unit rather than accumulating idle daemons.
    let mut text = format!(
        "{HEADER}{}\n# idle-minutes {}\nexec_always systemctl --user {} intentic-lock.service\n",
        serde_json::to_string(settings).expect("lock settings"),
        settings.idle_minutes,
        if settings.enabled { "restart" } else { "stop" }
    );
    if settings.enabled {
        // `exec`, not exec_always: it runs once, as the session starts. A machine with a PIN starts locked, so turning
        // it off and on again is no way past the PIN.
        text.push_str(&format!("exec {SCREEN_LOCK}\n"));
    }
    text
}

fn path(paths: &Paths) -> PathBuf {
    paths.at("/etc/intentic/sway.d/60-lock.conf")
}

/// The PIN's own folder: the `intentic` user's alone (0700), beside the rest of what `ic os` keeps.
fn folder(paths: &Paths) -> PathBuf {
    paths.at("/var/lib/intentic-os/screen-lock")
}

fn pin_file(paths: &Paths) -> PathBuf {
    folder(paths).join("pin")
}

fn attempts_file(paths: &Paths) -> PathBuf {
    folder(paths).join("attempts.json")
}

fn settings(paths: &Paths) -> Settings {
    parse_config(&std::fs::read_to_string(path(paths)).unwrap_or_default())
}

/// What the lock is: on only while the settings say so AND a PIN is stored, since a lock without a PIN cannot open.
fn current(paths: &Paths) -> Settings {
    let settings = settings(paths);
    Settings {
        enabled: settings.enabled && pin_file(paths).is_file(),
        ..settings
    }
}

pub fn status(json: bool) -> Result<()> {
    let settings = current(&Paths::here());
    if json {
        super::emit_json(&serde_json::to_value(&settings)?);
    } else {
        crate::ui::note(&format!(
            "Screen lock is {}; locks after {} minutes.",
            if settings.enabled { "on" } else { "off" },
            settings.idle_minutes
        ));
    }
    Ok(())
}

fn valid_pin(pin: &[u8]) -> bool {
    (4..=12).contains(&pin.len()) && pin.iter().all(u8::is_ascii_digit)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.is_ascii() || !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok())
        .collect()
}

/// The stored form of a PIN: `pbkdf2-sha256$<rounds>$<salt>$<hash>`, both in hex. Pure.
fn hashed(pin: &[u8], salt: &[u8]) -> String {
    let rounds = NonZeroU32::new(ROUNDS).expect("rounds");
    let mut hash = [0u8; 32];
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA256,
        rounds,
        salt,
        pin,
        &mut hash,
    );
    format!("pbkdf2-sha256${ROUNDS}${}${}", hex(salt), hex(&hash))
}

/// Whether `pin` is the one `stored` was made from, compared in constant time. Anything malformed matches nothing. Pure.
fn matches(stored: &str, pin: &[u8]) -> bool {
    let fields: Vec<&str> = stored.trim().split('$').collect();
    let [kind, rounds, salt, hash] = fields.as_slice() else {
        return false;
    };
    let (Some(rounds), Some(salt), Some(hash)) = (
        rounds.parse::<u32>().ok().and_then(NonZeroU32::new),
        unhex(salt),
        unhex(hash),
    ) else {
        return false;
    };
    *kind == "pbkdf2-sha256"
        && salt.len() >= 16
        && hash.len() == 32
        && ring::pbkdf2::verify(ring::pbkdf2::PBKDF2_HMAC_SHA256, rounds, &salt, pin, &hash).is_ok()
}

/// The misses in a row since the last right PIN, and until when (seconds since the epoch) no PIN is checked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attempts {
    misses: u32,
    wait_until: u64,
}

/// The count after one more miss at `now`. Pure.
fn after_miss(before: Attempts, now: u64) -> Attempts {
    let misses = before.misses.saturating_add(1);
    let wait_until = if misses < FREE_MISSES {
        0
    } else {
        let doublings = (misses - FREE_MISSES).min(16);
        now + (FIRST_WAIT_SECS << doublings).min(LONGEST_WAIT_SECS)
    };
    Attempts { misses, wait_until }
}

fn read_attempts(paths: &Paths) -> Attempts {
    super::read_json(&attempts_file(paths))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

/// The folder for the PIN, made private if it is not. A folder root made is handed to `intentic`, whose lock screen
/// reads it: `sudo ic os lock set-pin` at a console must not leave a PIN the session can never check.
fn private_folder(paths: &Paths) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = folder(paths);
    match std::fs::create_dir_all(&dir) {
        Ok(()) => (),
        Err(err) => bail!("Could not make {}: {err}.", dir.display()),
    }
    let metadata = std::fs::symlink_metadata(&dir).map_err(|err| Fail(err.to_string()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("{} must be a folder, not a link.", dir.display());
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|err| Fail(format!("Could not make {} private: {err}.", dir.display())))?;
    hand_to_intentic(&dir)?;
    Ok(dir)
}

/// Give a path root just made to the `intentic` user. Its owner says who made it, so no uid lookup is needed.
fn hand_to_intentic(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;
    let owner = std::fs::metadata(path)
        .map_err(|err| Fail(err.to_string()))?
        .uid();
    if owner == 0 {
        std::os::unix::fs::chown(
            path,
            Some(super::tool::INTENTIC_UID),
            Some(super::tool::INTENTIC_UID),
        )
        .map_err(|err| {
            Fail(format!(
                "Could not give {} to intentic: {err}.",
                path.display()
            ))
        })?;
    }
    Ok(())
}

fn write_private(path: &Path, body: &[u8]) -> Result<()> {
    super::write_atomic_mode(path, body, 0o600)?;
    hand_to_intentic(path)
}

fn write_attempts(paths: &Paths, attempts: Attempts) -> Result<()> {
    private_folder(paths)?;
    write_private(
        &attempts_file(paths),
        format!("{}\n", serde_json::to_string(&attempts)?).as_bytes(),
    )
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// Whether `pin` opens the lock at `now`, counting a miss. A wait in force refuses before any PIN is compared.
fn verify(paths: &Paths, pin: &[u8], now: u64) -> Result<()> {
    let attempts = read_attempts(paths);
    if now < attempts.wait_until {
        bail!(
            "Too many wrong PINs: the lock screen takes another in {} seconds.",
            attempts.wait_until - now
        );
    }
    let Ok(stored) = std::fs::read_to_string(pin_file(paths)) else {
        bail!("No screen PIN is set.");
    };
    if valid_pin(pin) && matches(&stored, pin) {
        if attempts != Attempts::default() {
            let _ = std::fs::remove_file(attempts_file(paths));
        }
        return Ok(());
    }
    // A miss that cannot be written down still fails. It only goes uncounted: a full disk must not lock the owner out.
    if let Err(err) = write_attempts(paths, after_miss(attempts, now)) {
        crate::ui::warn(&format!("A wrong PIN could not be counted: {}", err.0));
    }
    bail!("That is not the screen PIN.")
}

/// `ic os lock check`: the PIN on stdin, as pam_exec's `expose_authtok` writes it. Exit 0 opens the lock screen.
pub fn check() -> Result<()> {
    // pam_exec names the account being unlocked. The PIN belongs to the session's account and nobody else's.
    if std::env::var("PAM_USER").is_ok_and(|user| user != "intentic") {
        bail!("The screen PIN unlocks only the intentic user's session.");
    }
    let mut pin = Vec::new();
    std::io::stdin().take(64).read_to_end(&mut pin)?;
    // Some pam_exec releases send the PIN's terminating NUL too.
    while matches!(pin.last(), Some(b'\0' | b'\n' | b'\r')) {
        pin.pop();
    }
    let result = verify(&Paths::here(), &pin, now_secs());
    pin.fill(0);
    std::hint::black_box(&pin);
    result
}

fn save(paths: &Paths, settings: &Settings) -> Result<()> {
    super::write_atomic(&path(paths), config(settings).as_bytes())?;
    // The next login reads the same config. With no desktop session there is nothing to restart now. The session is
    // looked for rather than read off SWAYSOCK: the machine agent that may call this starts before sway and has none.
    if super::sway::socket().is_some() {
        let mut command = Command::new("systemctl");
        command.args([
            "--user",
            if settings.enabled { "restart" } else { "stop" },
            "intentic-lock.service",
        ]);
        let ran = intentic_bounded::capture(
            command,
            Duration::from_secs(10),
            intentic_bounded::Reach::Tree,
        )?;
        if !ran.success() {
            bail!("The PIN settings were saved, but the screen lock could not start. Sign out and back in to use them.");
        }
    }
    Ok(())
}

fn store_pin(paths: &Paths, pin: &[u8]) -> Result<()> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt)
        .map_err(|err| Fail(format!("Could not make a salt for the PIN: {err}.")))?;
    private_folder(paths)?;
    write_private(
        &pin_file(paths),
        format!("{}\n", hashed(pin, &salt)).as_bytes(),
    )?;
    // A new PIN starts with a clean count.
    let _ = std::fs::remove_file(attempts_file(paths));
    Ok(())
}

pub fn set_pin() -> Result<()> {
    let mut pin = Vec::new();
    std::io::stdin().take(14).read_to_end(&mut pin)?;
    if pin.last() == Some(&b'\n') {
        pin.pop();
    }
    if !valid_pin(&pin) {
        pin.fill(0);
        bail!("Use a PIN of 4 to 12 digits.");
    }
    let paths = Paths::here();
    let result = store_pin(&paths, &pin);
    pin.fill(0);
    std::hint::black_box(&pin);
    result?;
    save(
        &paths,
        &Settings {
            enabled: true,
            ..settings(&paths)
        },
    )
}

/// A lock screen already up when the PIN goes (turned off over SSH, or by the machine's agent) would have nothing left
/// that it accepts. swaylock unlocks and exits on SIGUSR1.
fn release_lock_screen() {
    let mut command = Command::new("pkill");
    command.args(["-USR1", "-x", "swaylock"]);
    let _ = intentic_bounded::capture(
        command,
        Duration::from_secs(5),
        intentic_bounded::Reach::Child,
    );
}

pub fn off() -> Result<()> {
    let paths = Paths::here();
    match std::fs::remove_file(pin_file(&paths)) {
        Ok(()) => (),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => (),
        Err(err) => bail!("Could not remove the screen PIN: {err}."),
    }
    let _ = std::fs::remove_file(attempts_file(&paths));
    save(
        &paths,
        &Settings {
            enabled: false,
            ..settings(&paths)
        },
    )?;
    release_lock_screen();
    Ok(())
}

pub fn idle(minutes: u16) -> Result<()> {
    if !(1..=240).contains(&minutes) {
        bail!("Choose between 1 and 240 minutes.");
    }
    let paths = Paths::here();
    save(
        &paths,
        &Settings {
            idle_minutes: minutes,
            ..settings(&paths)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_four_to_twelve_ascii_digits_are_pins() {
        for pin in [b"1234".as_slice(), b"0000", b"123456789012"] {
            assert!(valid_pin(pin));
        }
        for pin in [
            b"123".as_slice(),
            b"1234567890123",
            b"1234\n",
            b"12 4",
            b"123\0",
            b"--off",
        ] {
            assert!(!valid_pin(pin));
        }
    }

    #[test]
    fn no_pin_means_no_idle_lock() {
        assert_eq!(
            parse_config(""),
            Settings {
                enabled: false,
                idle_minutes: 5
            }
        );
        assert_eq!(
            parse_config("# intentic-lock {\"enabled\":true,\"idleMinutes\":0}"),
            Settings::default()
        );
    }

    #[test]
    fn settings_round_trip_and_a_pin_locks_the_session_from_its_start() {
        let settings = Settings {
            enabled: true,
            idle_minutes: 12,
        };
        let rendered = config(&settings);
        assert_eq!(parse_config(&rendered), settings);
        assert_eq!(rendered, "# intentic-lock {\"enabled\":true,\"idleMinutes\":12}\n# idle-minutes 12\nexec_always systemctl --user restart intentic-lock.service\nexec /usr/libexec/intentic-os/screen-lock\n");
        assert_eq!(config(&Settings::default()), "# intentic-lock {\"enabled\":false,\"idleMinutes\":5}\n# idle-minutes 5\nexec_always systemctl --user stop intentic-lock.service\n");
    }

    #[test]
    fn a_stored_pin_matches_only_itself_and_malformed_records_match_nothing() {
        let salt = [7u8; 16];
        let stored = hashed(b"4821", &salt);
        assert!(stored.starts_with("pbkdf2-sha256$210000$07070707"));
        assert!(!stored.contains("4821"));
        assert!(matches(&stored, b"4821"));
        assert!(matches(&format!("{stored}\n"), b"4821"));
        for wrong in [b"4822".as_slice(), b"", b"48210", b"482"] {
            assert!(!matches(&stored, wrong));
        }
        let hash = stored.rsplit('$').next().unwrap();
        for broken in [
            String::new(),
            "4821".to_string(),
            stored.replace("pbkdf2-sha256", "plain"),
            stored.replace("$210000$", "$0$"),
            "pbkdf2-sha256$210000$0707$".to_string(),
            format!("pbkdf2-sha256$210000${}${}", hex(&salt), &hash[..10]),
            format!("{stored}$extra"),
            format!("pbkdf2-sha256$210000$zz{}${hash}", "0".repeat(30)),
        ] {
            assert!(!matches(&broken, b"4821"), "{broken:?}");
        }
    }

    #[test]
    fn misses_are_free_four_times_then_each_doubles_a_wait_up_to_an_hour() {
        let mut attempts = Attempts::default();
        let mut waits = Vec::new();
        for _ in 0..14 {
            attempts = after_miss(attempts, 1000);
            waits.push(attempts.wait_until.saturating_sub(1000));
        }
        assert_eq!(
            waits,
            vec![0, 0, 0, 0, 30, 60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]
        );
        let worn = after_miss(
            Attempts {
                misses: u32::MAX,
                wait_until: 0,
            },
            1000,
        );
        assert_eq!(worn.misses, u32::MAX);
        assert_eq!(worn.wait_until, 1000 + 3600);
    }

    #[test]
    fn the_pin_checks_against_its_own_record_and_a_wait_refuses_even_the_right_pin() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        assert!(verify(&paths, b"4821", 100).is_err(), "no PIN set");
        store_pin(&paths, b"4821").unwrap();
        use std::os::unix::fs::PermissionsExt as _;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&folder(&paths)), 0o700);
        assert_eq!(mode(&pin_file(&paths)), 0o600);
        assert!(!std::fs::read_to_string(pin_file(&paths))
            .unwrap()
            .contains("4821"));

        assert!(verify(&paths, b"4821", 100).is_ok());
        for _ in 0..FREE_MISSES {
            assert!(verify(&paths, b"0000", 100).is_err());
        }
        assert_eq!(
            read_attempts(&paths),
            Attempts {
                misses: 5,
                wait_until: 130
            }
        );
        assert!(verify(&paths, b"4821", 129).is_err(), "inside the wait");
        assert!(verify(&paths, b"4821", 130).is_ok());
        assert_eq!(read_attempts(&paths), Attempts::default());
        assert!(!attempts_file(&paths).exists());

        // A new PIN starts with a clean count.
        for _ in 0..FREE_MISSES {
            let _ = verify(&paths, b"0000", 200);
        }
        store_pin(&paths, b"99887766").unwrap();
        assert!(verify(&paths, b"99887766", 200).is_ok());
        assert!(verify(&paths, b"4821", 200).is_err());
    }

    #[test]
    fn the_lock_is_on_only_while_a_pin_is_stored() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        let on = Settings {
            enabled: true,
            idle_minutes: 9,
        };
        super::super::write_atomic(&path(&paths), config(&on).as_bytes()).unwrap();
        assert_eq!(
            current(&paths),
            Settings {
                enabled: false,
                idle_minutes: 9
            }
        );
        store_pin(&paths, b"1234").unwrap();
        assert_eq!(current(&paths), on);
    }
}
