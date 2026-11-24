#![cfg_attr(not(windows), allow(dead_code))]
//! WHAT RUNS IN THE BACKGROUND (2026-11-24). A person's private laptop kept starting `VmmemWSL` at every sign-in after
//! they "turned Intentic off": the app's tray row only ever switched the app's own start at login, while the engine's
//! sign-in start (`IntenticEngine`) ran regardless and nothing on screen named it. One setting answers the one question
//! a person has, and every starter reads it:
//!
//! - `always`: the engine starts at sign-in and is kept up; sandboxes here stay reachable from the browser.
//! - `whenOpen`: nothing at sign-in; the app starts the engine while it is open and stops it when it quits.
//! - `off`: nothing runs, the app open or not, until the person turns it on or starts it themselves.
//!
//! It is stored in `~/.intentic/engine/background.json`. The engine's hold (`held`, record.rs) carries it out, since
//! everything that keeps the engine up already leaves a held engine alone: the sign-in start, the app's keeper and the
//! machine agent's `ic sandbox fix`. A hold now says which kind it is, on its first line: `off` (the setting), `closed`
//! (the app quit, or WSL was shut down under an app in `whenOpen`; the app's next start lifts it) or a person's own stop
//! (anything else, which is every hold written before kinds existed).

use serde::{Deserialize, Serialize};

use super::paths;

/// When the engine runs (the module comment says what each means).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Always,
    WhenOpen,
    Off,
}

impl Mode {
    /// The word `ic engine status --json` and `background.json` use, and the desktop app reads.
    pub fn id(self) -> &'static str {
        match self {
            Mode::Always => "always",
            Mode::WhenOpen => "whenOpen",
            Mode::Off => "off",
        }
    }

    /// A word a person types or the app sends. Pure.
    pub fn parse(word: &str) -> Option<Mode> {
        match word.trim() {
            "always" => Some(Mode::Always),
            "whenOpen" | "when-open" | "open" => Some(Mode::WhenOpen),
            "off" => Some(Mode::Off),
            _ => None,
        }
    }

    /// How a person reads it.
    pub fn sentence(self) -> &'static str {
        match self {
            Mode::Always => "always: starts at sign-in and keeps your sandboxes reachable",
            Mode::WhenOpen => "when Intentic is open: starts with the app and stops when it quits",
            Mode::Off => "off: nothing runs until you turn it on",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Stored {
    mode: Mode,
}

/// The mode this account chose, when it chose one.
pub fn stored() -> Option<Mode> {
    let text = std::fs::read_to_string(paths::background_path()?).ok()?;
    serde_json::from_str::<Stored>(&text)
        .ok()
        .map(|stored| stored.mode)
}

pub fn save(mode: Mode) -> Result<(), String> {
    let path = paths::background_path().ok_or("could not find this account's home folder.")?;
    if let Some(parent) = path.parent() {
        paths::ensure_dir(parent)?;
    }
    let text = serde_json::to_string(&Stored { mode })
        .map_err(|error| format!("could not write the background setting: {error}"))?;
    // Whole, then renamed over the old one: the app reads it every few seconds.
    let staged = path.with_extension("json.new");
    std::fs::write(&staged, text).map_err(|error| format!("{}: {error}", staged.display()))?;
    std::fs::rename(&staged, &path).map_err(|error| format!("{}: {error}", path.display()))
}

/// The mode of a PC that never chose one: what it did before the setting existed. A sign-in start registered (the
/// engine's own, or the app's) means it came up at every sign-in; none means somebody took it away, and it stays away.
/// Pure.
pub fn inferred(starts_at_sign_in: bool) -> Mode {
    if starts_at_sign_in {
        Mode::Always
    } else {
        Mode::WhenOpen
    }
}

/// Why the engine is held down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldKind {
    /// A person stopped it (`ic engine stop`, Stop now), or a hold from before kinds: until a start.
    Stopped,
    /// The setting is `off`.
    Off,
    /// The app quit, or WSL was shut down under it, and the engine waits for the app's next start.
    Closed,
}

impl HoldKind {
    pub fn id(self) -> &'static str {
        match self {
            HoldKind::Stopped => "stopped",
            HoldKind::Off => "off",
            HoldKind::Closed => "closed",
        }
    }

    /// The held file's text: the kind's word, a colon, and why, for a person reading the file. A person's stop keeps
    /// the plain text holds have always had.
    pub fn text(self, why: &str) -> String {
        match self {
            HoldKind::Stopped => why.to_string(),
            HoldKind::Off | HoldKind::Closed => format!("{}: {why}", self.id()),
        }
    }

    /// The kind a held file's text says. Pure.
    pub fn of(text: &str) -> HoldKind {
        let first = text.trim_start();
        if first.starts_with("off:") {
            HoldKind::Off
        } else if first.starts_with("closed:") {
            HoldKind::Closed
        } else {
            HoldKind::Stopped
        }
    }
}

/// What a background start (`ic engine start --quiet`: the sign-in start, the app's keeper) does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuietStart {
    /// Leave it as it is.
    Skip,
    /// Start it, lifting a `closed` hold first when there is one.
    Start { lift_closed: bool },
}

/// Pure: a background start's decision from the setting, the hold, and whether the app asks (`--app`).
pub fn quiet_start(mode: Mode, hold: Option<HoldKind>, app: bool) -> QuietStart {
    match (mode, hold) {
        (Mode::Off, _) => QuietStart::Skip,
        (_, Some(HoldKind::Stopped | HoldKind::Off)) => QuietStart::Skip,
        (_, Some(HoldKind::Closed)) if app => QuietStart::Start { lift_closed: true },
        (_, Some(HoldKind::Closed)) => QuietStart::Skip,
        (Mode::Always, None) => QuietStart::Start { lift_closed: false },
        (Mode::WhenOpen, None) if app => QuietStart::Start { lift_closed: false },
        (Mode::WhenOpen, None) => QuietStart::Skip,
    }
}

/// Pure: whether the engine's own sign-in entry (`IntenticEngine`) belongs in the Run key. Only for `always`, and not
/// when the app starts at sign-in: the app starts the engine itself, and Windows' Startup apps then lists one Intentic
/// instead of an Intentic and a "Console Window Host".
pub fn engine_entry_wanted(mode: Mode, app_entry: bool) -> bool {
    mode == Mode::Always && !app_entry
}

/// Pure: whether Windows' Startup apps switched the Run value `value` off, from what `reg query` printed of
/// `…\Explorer\StartupApproved\Run`. Its data's first byte is even when the entry starts (02, 06) and odd when the person
/// turned it off there (03, 07); no such value means Windows was never asked, which starts it.
pub fn startup_disabled_in(listing: &str, value: &str) -> bool {
    listing.lines().any(|line| {
        let Some(rest) = line.trim_start().strip_prefix(value) else {
            return false;
        };
        let Some(data) = rest.trim_start().strip_prefix("REG_BINARY") else {
            return false;
        };
        let data = data.trim();
        data.get(..2)
            .and_then(|byte| u8::from_str_radix(byte, 16).ok())
            .is_some_and(|first| first % 2 == 1)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_read_the_words_people_and_the_app_use() {
        for mode in [Mode::Always, Mode::WhenOpen, Mode::Off] {
            assert_eq!(Mode::parse(mode.id()), Some(mode));
        }
        assert_eq!(Mode::parse("when-open"), Some(Mode::WhenOpen));
        assert_eq!(Mode::parse("sometimes"), None);
        assert_eq!(
            serde_json::to_string(&Stored {
                mode: Mode::WhenOpen
            })
            .unwrap(),
            r#"{"mode":"whenOpen"}"#
        );
    }

    #[test]
    fn a_pc_that_never_chose_keeps_doing_what_it_did() {
        assert_eq!(inferred(true), Mode::Always);
        assert_eq!(inferred(false), Mode::WhenOpen);
    }

    #[test]
    fn a_hold_says_its_kind_and_an_old_one_is_a_persons_stop() {
        assert_eq!(HoldKind::of("stopped by `ic engine stop`"), HoldKind::Stopped);
        assert_eq!(HoldKind::of("held by a move"), HoldKind::Stopped);
        for kind in [HoldKind::Off, HoldKind::Closed, HoldKind::Stopped] {
            assert_eq!(HoldKind::of(&kind.text("why")), kind);
        }
        assert_eq!(HoldKind::Off.text("set to off"), "off: set to off");
    }

    #[test]
    fn a_background_start_follows_the_setting_and_the_hold() {
        use QuietStart::*;
        // The sign-in start, with no app asking.
        assert_eq!(quiet_start(Mode::Always, None, false), Start { lift_closed: false });
        assert_eq!(quiet_start(Mode::WhenOpen, None, false), Skip);
        assert_eq!(quiet_start(Mode::Off, None, false), Skip);
        // The app open.
        assert_eq!(quiet_start(Mode::WhenOpen, None, true), Start { lift_closed: false });
        assert_eq!(quiet_start(Mode::Always, None, true), Start { lift_closed: false });
        assert_eq!(quiet_start(Mode::Off, None, true), Skip);
        // The app's next start lifts its own hold; nobody else's.
        assert_eq!(
            quiet_start(Mode::WhenOpen, Some(HoldKind::Closed), true),
            Start { lift_closed: true }
        );
        assert_eq!(quiet_start(Mode::Always, Some(HoldKind::Closed), false), Skip);
        assert_eq!(quiet_start(Mode::Always, Some(HoldKind::Stopped), true), Skip);
        assert_eq!(quiet_start(Mode::WhenOpen, Some(HoldKind::Off), true), Skip);
    }

    #[test]
    fn the_engine_has_a_sign_in_entry_only_when_nothing_else_starts_it() {
        assert!(engine_entry_wanted(Mode::Always, false));
        assert!(!engine_entry_wanted(Mode::Always, true));
        assert!(!engine_entry_wanted(Mode::WhenOpen, false));
        assert!(!engine_entry_wanted(Mode::Off, false));
    }

    #[test]
    fn startup_apps_switch_is_read_off_its_first_byte() {
        let listing = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run\r\n    IntenticEngine    REG_BINARY    030000004A8C1D7E2B5FDB01\r\n    Intentic    REG_BINARY    020000000000000000000000\r\n";
        assert!(startup_disabled_in(listing, "IntenticEngine"));
        assert!(!startup_disabled_in(listing, "Intentic"));
        assert!(!startup_disabled_in(listing, "IntenticMachine"));
        assert!(startup_disabled_in(
            "    Intentic    REG_BINARY    0700000000\r\n",
            "Intentic"
        ));
        assert!(!startup_disabled_in("", "Intentic"));
    }
}
