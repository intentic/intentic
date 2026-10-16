//! The desktop's optional PIN. Only the root helper handles the password; settings contain no PIN or hash.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::Paths;
use crate::util::{bail, Fail, Result};

const HEADER: &str = "# intentic-lock ";

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
    format!(
        "{HEADER}{}\n# idle-minutes {}\nexec_always systemctl --user {} intentic-lock.service\n",
        serde_json::to_string(settings).expect("lock settings"),
        settings.idle_minutes,
        if settings.enabled { "restart" } else { "stop" }
    )
}

fn path(paths: &Paths) -> std::path::PathBuf {
    paths.at("/etc/intentic/sway.d/60-lock.conf")
}

fn settings(paths: &Paths) -> Settings {
    parse_config(&std::fs::read_to_string(path(paths)).unwrap_or_default())
}

pub fn status(json: bool) -> Result<()> {
    let settings = settings(&Paths::here());
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

/// Never put a PIN in argv, an error, or a transcript. The helper also validates it before touching `intentic`.
fn password(pin: Option<&[u8]>) -> Result<()> {
    let mut command = super::bootc::privileged(
        "/usr/libexec/intentic-os/lock-pin",
        if pin.is_some() { &[] } else { &["--off"] },
    );
    intentic_bounded::own_group(&mut command);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Fail("The screen lock could not change this computer's PIN.".into()))?;
    if let Some(mut input) = child.stdin.take() {
        if let Some(pin) = pin {
            if input.write_all(pin).is_err() {
                let _ = child.kill();
                let _ = child.wait();
                bail!("The screen lock could not read the PIN.");
            }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait()? {
            Some(status) if status.success() => return Ok(()),
            Some(_) => bail!("The screen lock could not change this computer's PIN."),
            None if Instant::now() >= deadline => {
                let _ = intentic_bounded::kill_tree(child.id(), intentic_bounded::Signal::Kill);
                let _ = child.kill();
                let _ = child.wait();
                bail!("The screen lock did not answer in time.");
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
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
    let result = password(Some(&pin));
    pin.fill(0);
    std::hint::black_box(&pin);
    result?;
    let paths = Paths::here();
    save(
        &paths,
        &Settings {
            enabled: true,
            ..settings(&paths)
        },
    )
}

pub fn off() -> Result<()> {
    password(None)?;
    let paths = Paths::here();
    save(
        &paths,
        &Settings {
            enabled: false,
            ..settings(&paths)
        },
    )
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
    fn settings_round_trip_and_reload_controls_one_service() {
        let settings = Settings {
            enabled: true,
            idle_minutes: 12,
        };
        let rendered = config(&settings);
        assert_eq!(parse_config(&rendered), settings);
        assert_eq!(rendered, "# intentic-lock {\"enabled\":true,\"idleMinutes\":12}\n# idle-minutes 12\nexec_always systemctl --user restart intentic-lock.service\n");
        assert_eq!(config(&Settings::default()), "# intentic-lock {\"enabled\":false,\"idleMinutes\":5}\n# idle-minutes 5\nexec_always systemctl --user stop intentic-lock.service\n");
    }
}
