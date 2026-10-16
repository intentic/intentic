//! The local Security card, through the OS's own `ic`. Its PIN is fed on stdin, never argv or a log.

use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;

static CHANGING: Mutex<()> = Mutex::new(());

fn valid_pin(pin: &str) -> bool {
    (4..=12).contains(&pin.len()) && pin.bytes().all(|byte| byte.is_ascii_digit())
}

fn read() -> Result<Value, String> {
    let mut command = Command::new("/usr/bin/ic");
    command.args(["os", "lock", "status", "--json"]);
    let ran = intentic_bounded::capture(
        command,
        Duration::from_secs(10),
        intentic_bounded::Reach::Tree,
    )
    .map_err(|_| "The screen lock could not be read.")?;
    if !ran.success() {
        return Err(
            "The screen lock could not be read. Update this computer and try again.".into(),
        );
    }
    serde_json::from_str::<Value>(&ran.stdout)
        .ok()
        .filter(|value| {
            value["enabled"].is_boolean()
                && value["idleMinutes"]
                    .as_u64()
                    .is_some_and(|n| (1..=240).contains(&n))
        })
        .ok_or_else(|| "The screen lock did not answer with its settings.".into())
}

fn change(args: &[&str], pin: Option<crate::keyring::Secret>) -> Result<Value, String> {
    let _guard = CHANGING
        .try_lock()
        .map_err(|_| "The screen lock is already changing. Try again in a moment.")?;
    let mut command = Command::new("/usr/bin/ic");
    command.args(["os", "lock"]).args(args);
    command.envs(crate::commands::app_env(crate::commands::VERSION));
    let (code, timed_out) = if let Some(pin) = pin {
        let ran = crate::keyring::capture_fed(command, &pin, Duration::from_secs(25))
            .map_err(|_| "The screen lock could not be changed.")?;
        (ran.code, ran.timed_out)
    } else {
        let ran = intentic_bounded::capture(
            command,
            Duration::from_secs(25),
            intentic_bounded::Reach::Tree,
        )
        .map_err(|_| "The screen lock could not be changed.")?;
        (ran.code, ran.timed_out)
    };
    // No child output is reflected: this path handled a PIN, so errors must never echo its input.
    if code != Some(0) || timed_out {
        return Err("The screen lock could not be changed. Try again.".into());
    }
    read()
}

#[tauri::command]
pub async fn os_lock_status() -> Result<Option<Value>, String> {
    if !crate::os::is_intentic_os() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(|| read().map(Some))
        .await
        .map_err(|_| "The screen lock could not be read.")?
}

#[tauri::command]
pub async fn os_lock_set_pin(mut pin: String) -> Result<Value, String> {
    if !valid_pin(&pin) {
        pin.clear();
        return Err("Use a PIN of 4 to 12 digits.".into());
    }
    let pin = crate::keyring::Secret::from(pin);
    tauri::async_runtime::spawn_blocking(move || change(&["set-pin"], Some(pin)))
        .await
        .map_err(|_| "The screen lock could not be changed.")?
}

#[tauri::command]
pub async fn os_lock_off() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| change(&["off"], None))
        .await
        .map_err(|_| "The screen lock could not be changed.")?
}

#[tauri::command]
pub async fn os_lock_idle(minutes: u16) -> Result<Value, String> {
    if !(1..=240).contains(&minutes) {
        return Err("Choose between 1 and 240 minutes.".into());
    }
    tauri::async_runtime::spawn_blocking(move || change(&["idle", &minutes.to_string()], None))
        .await
        .map_err(|_| "The screen lock could not be changed.")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_validation_never_accepts_flags_or_other_passwords() {
        for pin in ["1234", "0000", "123456789012"] {
            assert!(valid_pin(pin));
        }
        for pin in [
            "123",
            "1234567890123",
            "１２３４",
            "1234\n",
            "--off",
            "12 4",
        ] {
            assert!(!valid_pin(pin));
        }
    }
}
