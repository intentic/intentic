//! `intentic://fix`: `ic`'s own repair of a sandbox on this machine that the workspace cannot reach (Docker Desktop
//! not started after a reboot, a stopped container, a full disk). The recovery panel's button parks the request here
//! and brings the launcher forward; the launcher runs it and draws it from `ic`'s `intentic-fix:` lines
//! (`src/fixReport.ts`). `ic` reports each run to the platform itself, so nothing here talks to the platform.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::scripts;
use crate::setup_link::{is_fix_code, is_slug, FixArgs};

/// The run id the launcher follows. One fix runs at a time, so one id is enough.
pub const RUN: &str = "fix";

/// How long a fix may run before it is stopped with everything it started: starting Docker Desktop alone is
/// given five minutes (scripts.rs `ENGINE_LIMIT`), and the checks and repairs after it need room too.
pub const LIMIT: Duration = Duration::from_secs(600);

/// Told to the launcher when a request is parked for it to take.
const PENDING_EVENT: &str = "desktop://pending-fix";

/// The request the launcher has not taken yet. Taken, not read, as every parked request is (commands.rs).
static PENDING: Mutex<Option<FixArgs>> = Mutex::new(None);

/// Whether an `ic sandbox fix` is running now.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// A check's id as `ic` names its checks (`docker-app`, `disk`), on its way to `--accept`: a plain token that no
/// command line reads as a flag or as a second value.
pub fn is_check_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// `ic sandbox fix <slug> [--code <code>] --source app --json [--accept <id>,…]`, with every value held to its shape
/// first. `--json` keeps stdout to the machine lines the launcher reads; `--source app` is what the report says ran
/// it. `accept` is the user's yes to the consent checks it names, the click that stands in for a terminal's.
pub fn fix_args(slug: &str, code: Option<&str>, accept: &[String]) -> Result<Vec<String>, String> {
    if !is_slug(slug) {
        return Err(format!("{slug:?} is not a sandbox's name"));
    }
    let mut args = vec!["sandbox".to_string(), "fix".to_string(), slug.to_string()];
    if let Some(code) = code {
        if !is_fix_code(code) {
            return Err("that fix code is not one the recovery panel makes".to_string());
        }
        args.extend(["--code".to_string(), code.to_string()]);
    }
    args.extend([
        "--source".to_string(),
        "app".to_string(),
        "--json".to_string(),
    ]);
    if let Some(bad) = accept.iter().find(|id| !is_check_id(id)) {
        return Err(format!("{bad:?} is not one of ic's checks"));
    }
    if !accept.is_empty() {
        args.extend(["--accept".to_string(), accept.join(",")]);
    }
    Ok(args)
}

/// The link landing (windows.rs `handle_link`): park it and bring the launcher forward. While a fix runs, a second
/// link only brings the launcher forward, onto the run already going.
pub fn requested(app: &AppHandle, args: FixArgs) {
    let parked = !RUNNING.load(Ordering::SeqCst);
    if parked {
        *PENDING.lock().unwrap_or_else(PoisonError::into_inner) = Some(args);
    }
    crate::windows::show_launcher(app);
    if parked {
        let _ = app.emit(PENDING_EVENT, ());
    }
}

/// Taken, not read: a request is run by whichever launcher mount picks it up first, and only once.
#[tauri::command]
pub fn take_pending_fix() -> Option<FixArgs> {
    PENDING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
}

/// How a fix ended, for the launcher's verdict: `ic`'s exit code (0 healthy or fixed, 1 something left, 3 a consent
/// with no terminal to ask it in, 4 a restart or sign-out to finish), or none when it was stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixEnd {
    pub code: Option<i32>,
    pub timed_out: bool,
}

/// Run `ic sandbox fix` under [`RUN`], its lines streamed as every run's are (`desktop://run`). Refused while one is
/// running. `Err` when it never ran (a value of the wrong shape, no `ic` on this device, one already going); an `ic`
/// that exits non-zero ran, and its [`FixEnd`] says how.
#[tauri::command]
pub async fn sandbox_fix(
    app: AppHandle,
    slug: String,
    code: Option<String>,
    accept: Vec<String>,
) -> Result<FixEnd, String> {
    let args = fix_args(&slug, code.as_deref(), &accept)?;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A fix is already running on this device.".to_string());
    }
    let env = crate::commands::app_env(crate::commands::VERSION);
    let ran = tauri::async_runtime::spawn_blocking(move || {
        scripts::run_ic(&app, RUN, &args, &env, LIMIT)
    })
    .await;
    RUNNING.store(false, Ordering::SeqCst);
    let ended = ran.map_err(|error| error.to_string())??;
    Ok(FixEnd {
        code: ended.code,
        timed_out: ended.timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    /// The link's run: the code rides along so the panel that asked mirrors it, and nothing is accepted.
    #[test]
    fn a_fix_from_the_link_claims_its_code() {
        assert_eq!(
            fix_args("sandbox-3f2a9c1d7e4b", Some("Xy_9-k2"), &[]).unwrap(),
            strings(&[
                "sandbox",
                "fix",
                "sandbox-3f2a9c1d7e4b",
                "--code",
                "Xy_9-k2",
                "--source",
                "app",
                "--json"
            ])
        );
        assert_eq!(
            fix_args("work", None, &[]).unwrap(),
            strings(&["sandbox", "fix", "work", "--source", "app", "--json"])
        );
    }

    /// A consent button's re-run: no code, and the one check the user said yes to; several are joined as `ic`
    /// takes them.
    #[test]
    fn a_consent_re_run_accepts_the_checks_it_names() {
        assert_eq!(
            fix_args("work", None, &strings(&["docker-app"])).unwrap(),
            strings(&[
                "sandbox",
                "fix",
                "work",
                "--source",
                "app",
                "--json",
                "--accept",
                "docker-app"
            ])
        );
        assert_eq!(
            fix_args("work", None, &strings(&["wsl", "disk"]))
                .unwrap()
                .last()
                .map(String::as_str),
            Some("wsl,disk")
        );
    }

    /// Every value is refused before it reaches the command line when it is not a plain token: a flag, a second
    /// value smuggled in with a comma or a space, a path.
    #[test]
    fn a_value_of_the_wrong_shape_never_reaches_the_command_line() {
        for slug in ["", "-rf", "--json", "a b", "a/b", "..", "a.b", "_x"] {
            assert!(fix_args(slug, None, &[]).is_err(), "{slug:?}");
        }
        for code in ["", "--accept", "-x", "a b", "a,b", "a/b"] {
            assert!(fix_args("work", Some(code), &[]).is_err(), "{code:?}");
        }
        let too_long = "x".repeat(65);
        for id in [
            "",
            "-x",
            "--yes",
            ".hidden",
            "a,b",
            "a b",
            "a/b",
            "a\nb",
            too_long.as_str(),
        ] {
            assert!(
                fix_args("work", None, &strings(&["disk", id])).is_err(),
                "{id:?}"
            );
        }
        assert!(is_check_id("docker-app"));
        assert!(is_check_id("wsl.features_2"));
        assert!(is_check_id(&"x".repeat(64)));
    }
}
