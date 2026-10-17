//! Which sandboxes may show windows on this computer's screen: This computer's Sandbox windows card, through the OS's
//! own `ic os screen` (ic's os/screen.rs holds the rules and serves the sockets). Off for every sandbox until the
//! owner turns one on; the running service takes a change up within seconds.

use std::time::Duration;

use serde_json::Value;

/// `ic os screen status` lists this machine's sandboxes through docker: seconds.
const LIMIT: Duration = Duration::from_secs(30);

/// ic's exit on a machine that is not Intentic OS, and on an edition with no screen (the contract's
/// IC_OS_NO_SCREEN_EXIT): both mean there is nothing to show, never a failure.
const EXIT_NOT_OS: i32 = 3;
const EXIT_NO_SCREEN: i32 = 4;

fn run(args: &[&str]) -> Result<intentic_bounded::Captured, String> {
    let command = crate::os::ic_os_command(&crate::os::Image::installed(), args)?;
    let ran = intentic_bounded::capture(command, LIMIT, intentic_bounded::Reach::Tree)
        .map_err(|error| format!("ic os would not run: {error}"))?;
    if ran.timed_out {
        return Err(format!(
            "ic os screen did not answer within {}s",
            LIMIT.as_secs()
        ));
    }
    Ok(ran)
}

/// `{"available", "reason", "sandboxes": [{"slug", "allowed", "socket"}]}` from ic's last JSON line, or None for an
/// answer this app cannot read. Pure.
pub fn status_from(stdout: &str) -> Option<Value> {
    let line = stdout
        .lines()
        .map(str::trim)
        .rfind(|line| line.starts_with('{'))?;
    let value: Value = serde_json::from_str(line).ok()?;
    let rows_read = value["sandboxes"].as_array()?.iter().all(|row| {
        row["slug"].as_str().is_some_and(crate::setup_link::is_slug)
            && row["allowed"].is_boolean()
            && row["socket"].is_boolean()
    });
    (rows_read
        && value["available"].is_boolean()
        && (value["reason"].is_null() || value["reason"].is_string()))
    .then_some(value)
}

fn read() -> Result<Option<Value>, String> {
    let ran = run(&["os", "screen", "status", "--json"])?;
    if matches!(ran.code, Some(EXIT_NOT_OS | EXIT_NO_SCREEN)) {
        return Ok(None);
    }
    if !ran.success() {
        return Err(crate::os::last_words(
            &ran.stdout,
            &ran.stderr,
            "ic os screen status",
        ));
    }
    status_from(&ran.stdout)
        .map(Some)
        .ok_or_else(|| "ic os screen status said nothing this app can read".to_string())
}

#[tauri::command]
pub async fn os_screen_status() -> Result<Option<Value>, String> {
    if !crate::os::is_intentic_os() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(read)
        .await
        .map_err(|_| "The screen's sandbox windows could not be read.".to_string())?
}

/// Let one sandbox draw, or stop it (which closes its windows), then the status after.
#[tauri::command]
pub async fn os_screen_allow(slug: String, allowed: bool) -> Result<Option<Value>, String> {
    if !crate::setup_link::is_slug(&slug) {
        return Err(format!("{slug:?} is not a sandbox"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let verb = if allowed { "allow" } else { "deny" };
        let ran = run(&["os", "screen", verb, &slug])?;
        if !ran.success() {
            return Err(crate::os::last_words(
                &ran.stdout,
                &ran.stderr,
                "ic os screen",
            ));
        }
        read()
    })
    .await
    .map_err(|_| "The screen's sandbox windows could not be changed.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_is_read_from_ics_last_json_line_and_nothing_malformed_passes() {
        let good = r#"{"available":true,"reason":null,"sandboxes":[{"slug":"work","allowed":true,"socket":true},{"slug":"lab","allowed":false,"socket":false}]}"#;
        assert_eq!(
            status_from(&format!("fetching ic…\n{good}\n")).unwrap()["sandboxes"][1]["slug"],
            "lab"
        );
        let off =
            r#"{"available":false,"reason":"The screen service is not running.","sandboxes":[]}"#;
        assert_eq!(status_from(off).unwrap()["available"], false);
        for bad in [
            "",
            "not json",
            r#"{"available":true,"reason":null}"#,
            r#"{"available":"yes","reason":null,"sandboxes":[]}"#,
            r#"{"available":true,"reason":7,"sandboxes":[]}"#,
            r#"{"available":true,"reason":null,"sandboxes":[{"slug":"../x","allowed":true,"socket":false}]}"#,
            r#"{"available":true,"reason":null,"sandboxes":[{"slug":"work","allowed":"yes","socket":false}]}"#,
        ] {
            assert!(status_from(bad).is_none(), "{bad}");
        }
    }
}
