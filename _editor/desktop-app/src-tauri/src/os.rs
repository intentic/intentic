//! INTENTIC OS (2026-10-13): this computer as the OS itself reports it, when it is Intentic OS, and the changes the
//! reader makes to it from This device (src/device/intenticOs/): an update downloaded and staged for the next boot, the
//! previous version queued instead, the other channel, the restart into what is waiting. Every answer and every change
//! is `ic os`'s own (_os/README.md, "The host interface"): this app runs it and reads what it prints, never bootc or
//! systemctl. It runs the OS's own `ic` (`/usr/bin/ic`, baked into the image), never the one beside this app: the two
//! can be at different versions, and only the OS's is sure to know `ic os`.
//!
//! The desktop edition's sway session starts this app with `INTENTIC_KIOSK=1` ([`kiosk`]): its windows then fill the
//! screen, its × hides nothing (windows.rs), and it never updates itself, since the OS image carries it (update.rs).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::scripts::{self, Heard, Stream};

/// What every window hears of a run: that it began, each line it prints, and how it ended ([`Said`]).
pub const EVENT: &str = "desktop://os-run";

/// ic's exit on a machine that is not Intentic OS (no release.json): it refused, and changed nothing.
const EXIT_NOT_OS: i32 = 3;

/// `ic os status --json` reads release.json, the boot's health and `bootc status` through `sudo -n`: seconds.
const STATUS_LIMIT: Duration = Duration::from_secs(30);

/// `ic os update --check --json` asks the image's registry for its newest tag.
const CHECK_LIMIT: Duration = Duration::from_secs(120);

/// A run downloads a whole OS image (an update, the other channel) on whatever line this computer has.
const RUN_LIMIT: Duration = Duration::from_secs(60 * 60);

/// Where Intentic OS keeps what this app reads of it: the record its image build writes, which only Intentic OS has, and
/// its own `ic`. Paths rather than constants so a test can point them at a folder of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub release: PathBuf,
    pub ic: PathBuf,
}

impl Image {
    /// Where every Intentic OS image puts them.
    pub fn installed() -> Image {
        Image {
            release: PathBuf::from("/usr/lib/intentic-os/release.json"),
            ic: PathBuf::from("/usr/bin/ic"),
        }
    }

    /// This computer runs Intentic OS: the record is there, as `ic os` itself decides.
    pub fn present(&self) -> bool {
        self.release.is_file()
    }

    /// The OS's own `ic`, which every `ic os` call runs.
    fn ic(&self) -> Result<&Path, String> {
        if self.ic.is_file() {
            Ok(&self.ic)
        } else {
            Err(format!(
                "Intentic OS's own ic is not at {}, so this computer's system can't be read or changed from here.",
                self.ic.display()
            ))
        }
    }
}

/// Whether this computer runs Intentic OS, read once: the record changes only with the image, which needs a restart.
pub fn is_intentic_os() -> bool {
    static PRESENT: OnceLock<bool> = OnceLock::new();
    *PRESENT.get_or_init(|| Image::installed().present())
}

/// `INTENTIC_KIOSK` as the desktop edition's session sets it: `1`, and nothing else, turns kiosk mode on. Pure.
pub fn kiosk_from(value: Option<&OsStr>) -> bool {
    value.is_some_and(|value| value == "1")
}

/// This app is the screen: the desktop edition's sway session started it full screen, with nothing behind it to go
/// back to, and restarts it if it exits. Read once, at the first ask.
pub fn kiosk() -> bool {
    static KIOSK: OnceLock<bool> = OnceLock::new();
    *KIOSK.get_or_init(|| kiosk_from(std::env::var_os("INTENTIC_KIOSK").as_deref()))
}

/// The OS image carries this app and updates it with everything else: in kiosk mode, and anywhere on Intentic OS.
pub fn image_carries_app() -> bool {
    kiosk() || is_intentic_os()
}

/* WHAT `ic os` IS ASKED. */

/// An image tag `ic os channel` takes: `stable` or `beta`, nothing else reaches the command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Beta,
}

impl Channel {
    pub fn parse(value: &str) -> Result<Channel, String> {
        match value {
            "stable" => Ok(Channel::Stable),
            "beta" => Ok(Channel::Beta),
            other => Err(format!("{other:?} is not a channel: say stable or beta")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
        }
    }
}

/// A change to the OS, run and followed to its end. `apply` reboots into what it staged or queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    /// Download and stage the newer image for the next boot.
    Update { apply: bool },
    /// Queue the previous deployment for the next boot.
    Rollback { apply: bool },
    /// Stage the same edition from the other channel.
    Channel(Channel),
    /// Restart into whatever waits, the orderly way.
    Reboot,
}

impl Verb {
    /// What `ic` is given. Pure.
    pub fn args(self) -> Vec<&'static str> {
        let mut args = vec!["os"];
        match self {
            Verb::Update { apply } => {
                args.push("update");
                if apply {
                    args.push("--apply");
                }
            }
            Verb::Rollback { apply } => {
                args.push("rollback");
                if apply {
                    args.push("--apply");
                }
            }
            Verb::Channel(channel) => args.extend(["channel", channel.as_str()]),
            Verb::Reboot => args.push("reboot"),
        }
        args
    }

    /// The verb as every window hears it.
    pub fn name(self) -> &'static str {
        match self {
            Verb::Update { .. } => "update",
            Verb::Rollback { .. } => "rollback",
            Verb::Channel(_) => "channel",
            Verb::Reboot => "reboot",
        }
    }

    /// The run it streams under (`desktop://run`, its transcript, and what a Quit names, windows.rs `run_said`).
    pub fn run(self) -> &'static str {
        match self {
            Verb::Update { .. } => "os-update",
            Verb::Rollback { .. } => "os-rollback",
            Verb::Channel(_) => "os-channel",
            Verb::Reboot => "os-reboot",
        }
    }

    /// It ends with this computer restarting, and every sandbox on it with it.
    pub fn restarts(self) -> bool {
        match self {
            Verb::Update { apply } | Verb::Rollback { apply } => apply,
            Verb::Channel(_) => false,
            Verb::Reboot => true,
        }
    }

    fn apply(self) -> bool {
        self.restarts()
    }

    fn channel(self) -> Option<&'static str> {
        match self {
            Verb::Channel(channel) => Some(channel.as_str()),
            _ => None,
        }
    }
}

const STATUS_ARGS: [&str; 3] = ["os", "status", "--json"];
const CHECK_ARGS: [&str; 4] = ["os", "update", "--check", "--json"];

/* WHAT `ic os` SAID. */

/// The status in what `ic os status --json` printed: its one object, which names this OS. Pure.
pub fn status_from(stdout: &str) -> Option<Value> {
    scripts::json_object_in(stdout).filter(|status| {
        status["os"] == "intentic-os"
            && status["edition"].is_string()
            && status["version"].is_string()
    })
}

/// The answer in what `ic os update --check --json` printed: whether a newer image is out, and which. Pure.
pub fn check_from(stdout: &str) -> Option<Value> {
    scripts::json_object_in(stdout).filter(|check| check["available"].is_boolean())
}

/// What ic said on its way out of a short call that failed: its `error:` line, else its last line. Pure.
fn last_words(stdout: &str, stderr: &str, what: &str) -> String {
    let mut reading = Reading::default();
    for line in stderr.lines() {
        reading.hear(Stream::Stderr, line);
    }
    reading
        .reason()
        .or_else(|| {
            stdout
                .lines()
                .map(str::trim)
                .rfind(|line| !line.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("{what} failed"))
}

/// How a run ended, for the window that asked and every window following it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEnd {
    /// `update`, `rollback`, `channel` or `reboot`.
    pub verb: &'static str,
    /// It was to restart this computer into what it staged or queued.
    pub apply: bool,
    /// `done`: ic did it (a restart is on its way when `apply`). `failed`: it stopped. `notOs`: ic says this is not
    /// Intentic OS. `busy`: another change to the OS, or other work of this app's, was running, and this one never
    /// started.
    pub outcome: &'static str,
    /// ic's exit code; none when it was stopped.
    pub code: Option<i32>,
    /// It ran past [`RUN_LIMIT`] and was stopped with everything it started.
    pub timed_out: bool,
    /// Why it stopped, in ic's words.
    pub reason: Option<String>,
    /// The run's transcript.
    pub log: Option<String>,
    /// ic ran, so its lines and this end reached every window ([`EVENT`]).
    pub ran: bool,
}

/// What every window hears of a run, in order: `started`, each `line`, then `exit` with the [`RunEnd`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Said {
    Started {
        verb: &'static str,
        apply: bool,
        channel: Option<&'static str>,
    },
    Line {
        verb: &'static str,
        stream: Stream,
        text: String,
    },
    Exit(RunEnd),
}

/// What a run said that its ending is read from: ic's first `error:` line, else the last thing it said on stderr.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Reading {
    error: Option<String>,
    last: Option<String>,
}

impl Reading {
    /// Take one line of the run. Pure.
    pub fn hear(&mut self, stream: Stream, line: &str) {
        let line = line.trim();
        if stream != Stream::Stderr || line.is_empty() {
            return;
        }
        if self.error.is_none() {
            self.error = line
                .strip_prefix("error:")
                .map(str::trim)
                .filter(|rest| !rest.is_empty())
                .map(str::to_string);
        }
        self.last = Some(line.to_string());
    }

    fn reason(&self) -> Option<String> {
        self.error.clone().or_else(|| self.last.clone())
    }

    /// How the run ended, from ic's exit and what it said on the way. Pure.
    pub fn end(
        &self,
        verb: Verb,
        code: Option<i32>,
        timed_out: bool,
        log: Option<String>,
    ) -> RunEnd {
        let outcome = match code {
            Some(0) if !timed_out => "done",
            Some(EXIT_NOT_OS) => "notOs",
            _ => "failed",
        };
        RunEnd {
            verb: verb.name(),
            apply: verb.apply(),
            outcome,
            code,
            timed_out,
            reason: (outcome != "done").then(|| self.reason()).flatten(),
            log,
            ran: true,
        }
    }
}

/// A run refused before it began: one of this app's OS changes, or other work of this app's on this computer, is going.
/// Told to no window, since those following the running one would read it as that one's end. Pure.
fn refused(verb: Verb) -> RunEnd {
    RunEnd {
        verb: verb.name(),
        apply: verb.apply(),
        outcome: "busy",
        code: None,
        timed_out: false,
        reason: None,
        log: None,
        ran: false,
    }
}

/* ONE CHANGE AT A TIME. bootc takes one transaction at a time itself, but this app holds its own turn, so a second press
 * from another window is answered at once rather than as bootc's lock error minutes into the first. */

static CHANGING: AtomicBool = AtomicBool::new(false);

/// This app's one change to the OS at a time, given back when dropped.
pub struct Claim(());

impl Drop for Claim {
    fn drop(&mut self) {
        CHANGING.store(false, Ordering::SeqCst);
    }
}

/// The turn to change the OS, unless a change of this app's is running.
pub fn claim() -> Option<Claim> {
    if CHANGING.swap(true, Ordering::SeqCst) {
        // Held by the running change: only its own claim gives it back.
        None
    } else {
        Some(Claim(()))
    }
}

/* RUNNING `ic os`. */

/// `ic os <args>` from the OS's own ic, told what every run of this app is (`app_env`).
fn ic_os_command(image: &Image, args: &[&str]) -> Result<Command, String> {
    let ic = image.ic()?;
    let mut command = Command::new(ic);
    command.args(args);
    command.envs(crate::commands::app_env(crate::commands::VERSION));
    Ok(command)
}

/// A short `ic os` call, to its exit or killed at `limit`.
fn ic_os(
    image: &Image,
    args: &[&str],
    limit: Duration,
) -> Result<intentic_bounded::Captured, String> {
    let command = ic_os_command(image, args)?;
    let ran = intentic_bounded::capture(command, limit, intentic_bounded::Reach::Tree)
        .map_err(|error| format!("ic os would not run: {error}"))?;
    if ran.timed_out {
        return Err(format!(
            "ic os {} did not answer within {}s",
            args.get(1).copied().unwrap_or_default(),
            limit.as_secs()
        ));
    }
    Ok(ran)
}

/// What the status read comes to: none where ic says this is not Intentic OS.
fn read_status(image: &Image) -> Result<Option<Value>, String> {
    let ran = ic_os(image, &STATUS_ARGS, STATUS_LIMIT)?;
    if ran.code == Some(EXIT_NOT_OS) {
        return Ok(None);
    }
    if !ran.success() {
        return Err(last_words(&ran.stdout, &ran.stderr, "ic os status"));
    }
    status_from(&ran.stdout)
        .map(Some)
        .ok_or_else(|| "ic os status said nothing this app can read".to_string())
}

fn read_check(image: &Image) -> Result<Value, String> {
    let ran = ic_os(image, &CHECK_ARGS, CHECK_LIMIT)?;
    if !ran.success() {
        return Err(last_words(&ran.stdout, &ran.stderr, "ic os update --check"));
    }
    check_from(&ran.stdout)
        .ok_or_else(|| "ic os update --check said nothing this app can read".to_string())
}

/// What the commands answer on a computer that is not Intentic OS.
const NOT_OS: &str = "This computer doesn't run Intentic OS.";

/// `ic os status --json`, as ic printed it: the edition, version and channel, what bootc has booted, staged and kept to
/// roll back to, whether a restart is waiting, the boot's health and how sandboxes are isolated. Null on a computer that
/// is not Intentic OS, which has no card for it; `Err` with ic's words when it did not answer.
#[tauri::command]
pub async fn os_status() -> Result<Option<Value>, String> {
    if !is_intentic_os() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(|| read_status(&Image::installed()))
        .await
        .map_err(|error| error.to_string())?
}

/// `ic os update --check --json`: whether a newer image is out on this computer's channel (`available`, `version`,
/// `digest`). Downloads nothing.
#[tauri::command]
pub async fn os_update_check() -> Result<Value, String> {
    if !is_intentic_os() {
        return Err(NOT_OS.to_string());
    }
    tauri::async_runtime::spawn_blocking(|| read_check(&Image::installed()))
        .await
        .map_err(|error| error.to_string())?
}

/// Run `verb` with the OS's own ic and tell every window each line ([`EVENT`]). BLOCKING, for minutes: a download of a
/// whole image. `Err` only when it never started.
fn run(app: &AppHandle, image: &Image, verb: Verb) -> Result<RunEnd, String> {
    let command = ic_os_command(image, &verb.args())?;
    let _ = app.emit(
        EVENT,
        Said::Started {
            verb: verb.name(),
            apply: verb.apply(),
            channel: verb.channel(),
        },
    );
    let reading = Arc::new(Mutex::new(Reading::default()));
    let heard: Heard = {
        let app = app.clone();
        let reading = Arc::clone(&reading);
        Arc::new(move |stream: Stream, line: &str| {
            reading
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .hear(stream, line);
            let _ = app.emit(
                EVENT,
                Said::Line {
                    verb: verb.name(),
                    stream,
                    text: line.to_string(),
                },
            );
        })
    };
    let ended = match scripts::run_command_heard(
        app,
        verb.run(),
        "ic os",
        command,
        Some(RUN_LIMIT),
        Some(heard),
    ) {
        Ok(ended) => ended,
        Err(error) => {
            // The windows were told it began: they are told it is over, with why.
            let _ = app.emit(
                EVENT,
                Said::Exit(RunEnd {
                    outcome: "failed",
                    reason: Some(error.clone()),
                    ..refused(verb)
                }),
            );
            return Err(error);
        }
    };
    let end = reading.lock().unwrap_or_else(PoisonError::into_inner).end(
        verb,
        ended.code,
        ended.timed_out,
        ended.log,
    );
    let _ = app.emit(EVENT, Said::Exit(end.clone()));
    Ok(end)
}

/// One change to the OS: refused at once on a computer that is not Intentic OS, answered `busy` while another of this
/// app's runs, and, for one that restarts this computer, while any other work of this app's runs on it (a setup, a
/// recreate), which the restart would cut off.
async fn change(app: AppHandle, verb: Verb) -> Result<RunEnd, String> {
    if !is_intentic_os() {
        return Err(NOT_OS.to_string());
    }
    if verb.restarts() && scripts::busy() {
        return Ok(refused(verb));
    }
    let Some(claim) = claim() else {
        return Ok(refused(verb));
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _claim = claim;
        run(&app, &Image::installed(), verb)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `ic os update [--apply]`: download and stage the newer image for the next boot; with `apply`, restart into it.
#[tauri::command]
pub async fn os_update(app: AppHandle, apply: bool) -> Result<RunEnd, String> {
    change(app, Verb::Update { apply }).await
}

/// `ic os rollback [--apply]`: queue the previous deployment for the next boot; with `apply`, restart into it.
#[tauri::command]
pub async fn os_rollback(app: AppHandle, apply: bool) -> Result<RunEnd, String> {
    change(app, Verb::Rollback { apply }).await
}

/// `ic os reboot`: restart into whatever waits (a staged update, a queued rollback), the orderly way: every sandbox is
/// left the ask to resume its turns, and ic records which ran, before the OS restarts.
#[tauri::command]
pub async fn os_reboot(app: AppHandle) -> Result<RunEnd, String> {
    change(app, Verb::Reboot).await
}

/// `ic os channel <stable|beta>`: stage the same edition from the other channel for the next boot.
#[tauri::command]
pub async fn os_channel(app: AppHandle, channel: String) -> Result<RunEnd, String> {
    let channel = Channel::parse(&channel)?;
    change(app, Verb::Channel(channel)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A folder of its own under the temp dir, gone when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!(
                "intentic-os-{name}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("scratch folder");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn intentic_os_is_the_computer_with_the_images_record_and_its_ic_is_the_oss_own() {
        let scratch = Scratch::new("detect");
        let image = Image {
            release: scratch.0.join("release.json"),
            ic: scratch.0.join("ic"),
        };
        assert!(!image.present());
        assert!(image.ic().is_err());
        std::fs::write(
            &image.release,
            r#"{"name":"Intentic OS","edition":"desktop"}"#,
        )
        .unwrap();
        std::fs::write(&image.ic, "").unwrap();
        assert!(image.present());
        assert_eq!(image.ic().unwrap(), image.ic.as_path());
        // A folder where the record should be is not the record.
        let folder = Image {
            release: scratch.0.clone(),
            ic: image.ic.clone(),
        };
        assert!(!folder.present());
        // The image's own paths: never the ic beside this app.
        assert_eq!(
            Image::installed(),
            Image {
                release: PathBuf::from("/usr/lib/intentic-os/release.json"),
                ic: PathBuf::from("/usr/bin/ic"),
            }
        );
    }

    #[test]
    fn kiosk_mode_is_the_sessions_one_and_nothing_else() {
        assert!(kiosk_from(Some(OsStr::new("1"))));
        for other in ["", "0", "true", "yes", " 1", "1 "] {
            assert!(!kiosk_from(Some(OsStr::new(other))), "{other:?}");
        }
        assert!(!kiosk_from(None));
    }

    #[test]
    fn each_change_is_its_verb_on_ics_command_line() {
        let cases: [(Verb, &[&str]); 7] = [
            (Verb::Update { apply: false }, &["os", "update"]),
            (Verb::Update { apply: true }, &["os", "update", "--apply"]),
            (Verb::Rollback { apply: false }, &["os", "rollback"]),
            (
                Verb::Rollback { apply: true },
                &["os", "rollback", "--apply"],
            ),
            (Verb::Channel(Channel::Beta), &["os", "channel", "beta"]),
            (Verb::Channel(Channel::Stable), &["os", "channel", "stable"]),
            (Verb::Reboot, &["os", "reboot"]),
        ];
        for (verb, args) in cases {
            assert_eq!(verb.args(), args.to_vec(), "{verb:?}");
        }
        assert_eq!(STATUS_ARGS, ["os", "status", "--json"]);
        assert_eq!(CHECK_ARGS, ["os", "update", "--check", "--json"]);
    }

    #[test]
    fn only_a_change_that_applies_restarts_this_computer() {
        assert!(!Verb::Update { apply: false }.restarts());
        assert!(Verb::Update { apply: true }.restarts());
        assert!(!Verb::Rollback { apply: false }.restarts());
        assert!(Verb::Rollback { apply: true }.restarts());
        assert!(!Verb::Channel(Channel::Beta).restarts());
        assert!(Verb::Reboot.restarts());
        // Each streams under a run of its own, which a Quit names.
        for verb in [
            Verb::Update { apply: true },
            Verb::Rollback { apply: false },
            Verb::Channel(Channel::Stable),
            Verb::Reboot,
        ] {
            assert!(verb.run().starts_with("os-"), "{verb:?}");
        }
    }

    #[test]
    fn a_channel_is_stable_or_beta_and_nothing_else_reaches_the_command_line() {
        assert_eq!(Channel::parse("stable"), Ok(Channel::Stable));
        assert_eq!(Channel::parse("beta"), Ok(Channel::Beta));
        for bad in [
            "",
            "Beta",
            "nightly",
            "--apply",
            "beta --apply",
            "stable;reboot",
        ] {
            assert!(Channel::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_status_is_the_object_that_names_intentic_os() {
        let line = json!({
            "os": "intentic-os",
            "edition": "desktop",
            "version": "2026.10.13.0",
            "channel": "stable",
            "image": "ghcr.io/intentic/os-desktop:stable",
            "booted": { "image": "ghcr.io/intentic/os-desktop:stable", "version": "2026.10.13.0", "digest": "sha256:a", "timestamp": "2026-10-13T09:12:00Z" },
            "staged": null,
            "rollback": { "image": "ghcr.io/intentic/os-desktop:stable", "version": "2026.10.06.0", "digest": "sha256:b", "timestamp": null },
            "rollbackQueued": false,
            "rebootRequired": false,
            "health": { "verdict": "green", "failed": [] },
            "isolation": "auto",
            "vmRuntime": true
        });
        // Its one line, or that line after whatever else ic said first.
        assert_eq!(status_from(&line.to_string()), Some(line.clone()));
        assert_eq!(
            status_from(&format!("intentic: reading bootc\n{line}\n")),
            Some(line.clone())
        );
        // Another object, words, nothing: not a status.
        assert_eq!(
            status_from(r#"{"os":"fedora","edition":"server","version":"41"}"#),
            None
        );
        assert_eq!(
            status_from(r#"{"os":"intentic-os","edition":"server"}"#),
            None
        );
        assert_eq!(status_from("Intentic OS 2026.10.13.0 (stable)"), None);
        assert_eq!(status_from(""), None);
    }

    #[test]
    fn a_check_is_the_object_that_says_whether_one_is_available() {
        assert_eq!(
            check_from(r#"{"available":true,"version":"2026.10.20.0","digest":"sha256:c"}"#),
            Some(json!({ "available": true, "version": "2026.10.20.0", "digest": "sha256:c" }))
        );
        assert_eq!(
            check_from(r#"{"available":false,"version":null,"digest":null}"#),
            Some(json!({ "available": false, "version": null, "digest": null }))
        );
        assert_eq!(check_from(r#"{"available":"yes"}"#), None);
        assert_eq!(check_from("no update"), None);
    }

    /// The contract's examples of what `ic os` prints (_shared/sandbox-contract/golden/intentic-os.json), which ic's Rust
    /// produces field for field: every status and every check there reads here as ic printed it.
    #[test]
    fn every_answer_the_contract_pins_reads_as_ic_printed_it() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-contract/golden/intentic-os.json"
        ))
        .expect("the golden file is JSON");
        let statuses = golden["status"].as_array().expect("the golden statuses");
        assert!(!statuses.is_empty());
        for status in statuses {
            assert_eq!(status_from(&status.to_string()).as_ref(), Some(status));
        }
        let checks = golden["updateCheck"].as_array().expect("the golden checks");
        assert!(!checks.is_empty());
        for check in checks {
            assert_eq!(check_from(&check.to_string()).as_ref(), Some(check));
        }
    }

    #[test]
    fn a_run_that_finished_is_done_and_says_no_reason() {
        let mut reading = Reading::default();
        reading.hear(
            Stream::Stdout,
            "intentic: staged 2026.10.20.0 for the next boot",
        );
        reading.hear(Stream::Stderr, "! a warning on the way");
        let end = reading.end(
            Verb::Update { apply: false },
            Some(0),
            false,
            Some("/logs/u.log".into()),
        );
        assert_eq!(
            end,
            RunEnd {
                verb: "update",
                apply: false,
                outcome: "done",
                code: Some(0),
                timed_out: false,
                reason: None,
                log: Some("/logs/u.log".into()),
                ran: true,
            }
        );
    }

    #[test]
    fn a_run_that_failed_says_ics_own_error_line_first() {
        let mut reading = Reading::default();
        reading.hear(Stream::Stdout, "error: on stdout is not ic's error");
        reading.hear(
            Stream::Stderr,
            "  error: the registry did not answer: connection refused\r",
        );
        reading.hear(
            Stream::Stderr,
            "error: a second error line is not the reason",
        );
        reading.hear(Stream::Stderr, "       Nothing was staged.");
        let end = reading.end(Verb::Channel(Channel::Beta), Some(1), false, None);
        assert_eq!(end.outcome, "failed");
        assert_eq!(end.verb, "channel");
        assert_eq!(
            end.reason.as_deref(),
            Some("the registry did not answer: connection refused")
        );
        // With no error line, the last thing it said on stderr.
        let mut quiet = Reading::default();
        quiet.hear(Stream::Stderr, "sudo: a password is required");
        quiet.hear(Stream::Stderr, "   ");
        assert_eq!(
            quiet
                .end(Verb::Reboot, Some(1), false, None)
                .reason
                .as_deref(),
            Some("sudo: a password is required")
        );
        assert_eq!(
            Reading::default()
                .end(Verb::Reboot, Some(1), false, None)
                .reason,
            None
        );
    }

    #[test]
    fn a_run_cut_short_or_refused_by_ic_is_never_done() {
        let reading = Reading::default();
        for code in [None, Some(101), Some(-1)] {
            assert_eq!(
                reading
                    .end(Verb::Update { apply: true }, code, false, None)
                    .outcome,
                "failed",
                "{code:?}"
            );
        }
        let timed_out = reading.end(Verb::Update { apply: false }, Some(0), true, None);
        assert_eq!((timed_out.outcome, timed_out.timed_out), ("failed", true));
        let not_os = reading.end(Verb::Rollback { apply: true }, Some(3), false, None);
        assert_eq!((not_os.outcome, not_os.apply), ("notOs", true));
    }

    #[test]
    fn a_short_calls_last_words_are_its_error_line_first() {
        assert_eq!(
            last_words("", "warning\nerror: bootc status failed\n", "ic os status"),
            "bootc status failed"
        );
        assert_eq!(last_words("said this\n\n", "", "ic os status"), "said this");
        assert_eq!(
            last_words("", "\n \n", "ic os status"),
            "ic os status failed"
        );
    }

    #[test]
    fn the_windows_hear_a_run_in_their_spelling() {
        let started = Said::Started {
            verb: "channel",
            apply: false,
            channel: Some("beta"),
        };
        assert_eq!(
            serde_json::to_value(started).unwrap(),
            json!({ "kind": "started", "verb": "channel", "apply": false, "channel": "beta" })
        );
        let line = Said::Line {
            verb: "update",
            stream: Stream::Stderr,
            text: "! slow".into(),
        };
        assert_eq!(
            serde_json::to_value(line).unwrap(),
            json!({ "kind": "line", "verb": "update", "stream": "stderr", "text": "! slow" })
        );
        let end = Reading::default().end(
            Verb::Rollback { apply: true },
            Some(1),
            false,
            Some("/l".into()),
        );
        assert_eq!(
            serde_json::to_value(Said::Exit(end)).unwrap(),
            json!({
                "kind": "exit",
                "verb": "rollback",
                "apply": true,
                "outcome": "failed",
                "code": 1,
                "timedOut": false,
                "reason": null,
                "log": "/l",
                "ran": true,
            })
        );
        // A refusal ran nothing and is told to nobody.
        let busy = refused(Verb::Reboot);
        assert_eq!((busy.outcome, busy.ran, busy.apply), ("busy", false, true));
    }

    #[test]
    fn one_change_to_the_os_at_a_time_from_this_app() {
        let first = claim().expect("nothing is changing yet");
        assert!(claim().is_none());
        assert!(claim().is_none());
        drop(first);
        let second = claim().expect("the first change gave its turn back");
        assert!(claim().is_none());
        drop(second);
    }
}
