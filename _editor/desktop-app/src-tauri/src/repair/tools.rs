//! Repair's hands: `ic` and read-only checks, never a shell.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use crate::commands::{self, VERSION};
use crate::fix;
use crate::scripts;
use crate::scripts::Host;

const CONTAINER_PREFIX: &str = "intentic-sandbox-";
const READ_LIMIT: Duration = Duration::from_secs(120);
const FIX_LIMIT: Duration = Duration::from_secs(600);
/// How much of a move's transcript the model reads, from its end.
const MOVE_SAID: usize = 8000;
const LOG_TAIL_MAX: u32 = 80;

pub fn needs_approval(name: &str) -> bool {
    matches!(
        name,
        "fix" | "engine_start" | "engine_move" | "sandbox_restart" | "sandbox_rollback"
    )
}

pub fn run_read_only(
    app: &tauri::AppHandle,
    name: &str,
    args: &Value,
    home: &str,
) -> Result<String, String> {
    match name {
        "doctor" => doctor(app, args, home),
        "engine_status" => engine_status(app, home),
        "pc_check" => pc_check(app, home),
        "sandbox_list" => sandbox_list(app, home),
        "sandbox_logs" => sandbox_logs(args, home),
        "setup_log" => setup_log(app, home),
        other if needs_approval(other) => Err(format!("{other} needs the reader's Allow")),
        _ => Err(format!("unknown tool {name}")),
    }
}

pub fn run_mutating(
    app: &tauri::AppHandle,
    name: &str,
    args: &Value,
    home: &str,
) -> Result<String, String> {
    match name {
        "fix" => fix_tool(app, args, home),
        "engine_start" => ic_simple(app, &["engine", "start"], Duration::from_secs(180), home),
        "engine_move" => engine_move(app, args, home),
        "sandbox_restart" => sandbox_power(app, args, "restart", home),
        "sandbox_rollback" => sandbox_rollback(app, args, home),
        _ => Err(format!("unknown mutating tool {name}")),
    }
}

fn doctor(app: &tauri::AppHandle, args: &Value, home: &str) -> Result<String, String> {
    let slug = args.get("slug").and_then(Value::as_str);
    let mut ic_args = vec!["sandbox".into(), "doctor".into()];
    if let Some(slug) = slug {
        if !crate::setup_link::is_slug(slug) {
            return Err("that is not a sandbox name".into());
        }
        ic_args.push(slug.into());
    }
    ic_args.push("--json".into());
    ic_json(app, &ic_args, READ_LIMIT, home)
}

fn engine_status(app: &tauri::AppHandle, home: &str) -> Result<String, String> {
    ic_simple(
        app,
        &["engine", "status", "--json"],
        Duration::from_secs(30),
        home,
    )
}

fn pc_check(app: &tauri::AppHandle, home: &str) -> Result<String, String> {
    let env = crate::commands::app_env(crate::commands::VERSION);
    let ended = scripts::run_ic(
        app,
        "repair-pc-check",
        &["docker".into(), "prepare".into(), "--dry-run".into()],
        &env,
        READ_LIMIT,
    )?;
    let raw = transcript(&ended);
    let mut summary = String::new();
    for line in raw.lines() {
        if line.contains("intentic-prepare-summary:") {
            summary = line
                .split_once("intentic-prepare-summary:")
                .map(|(_, json)| json.trim())
                .unwrap_or("")
                .to_string();
        }
    }
    if summary.is_empty() {
        summary = raw.chars().take(4000).collect();
    }
    Ok(super::scrub::scrub(&summary, home))
}

fn sandbox_list(app: &tauri::AppHandle, home: &str) -> Result<String, String> {
    let rows = scripts::ic_listing(app, commands::list_script(Host::current(), VERSION))?;
    Ok(super::scrub::scrub(
        &serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into()),
        home,
    ))
}

fn sandbox_logs(args: &Value, home: &str) -> Result<String, String> {
    let slug = args
        .get("slug")
        .and_then(Value::as_str)
        .ok_or_else(|| "sandbox_logs needs a slug".to_string())?;
    if !crate::setup_link::is_slug(slug) {
        return Err("that is not a sandbox name".into());
    }
    let tail = args
        .get("lines")
        .and_then(Value::as_u64)
        .map(|n| n.min(LOG_TAIL_MAX as u64) as u32)
        .unwrap_or(40);
    let text = scripts::logs_tail(&format!("{CONTAINER_PREFIX}{slug}"), tail)?;
    Ok(super::scrub::scrub(&text, home))
}

fn setup_log(_app: &tauri::AppHandle, home: &str) -> Result<String, String> {
    let path = latest_setup_log();
    let Some(path) = path else {
        return Ok("No setup transcript on this PC yet.".into());
    };
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| format!("could not read log: {error}"));
    Ok(super::scrub::scrub(&super::scrub::bound(text), home))
}

fn latest_setup_log() -> Option<String> {
    let dir = super::user_home()?.join(".intentic/logs");
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(&dir).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("desktop-setup-") || !name.ends_with(".log") {
            continue;
        }
        let modified = entry.metadata().ok()?.modified().ok()?;
        if newest.as_ref().is_none_or(|(at, _)| modified > *at) {
            newest = Some((modified, entry.path()));
        }
    }
    newest.map(|(_, path)| path.to_string_lossy().into_owned())
}

fn fix_tool(app: &tauri::AppHandle, args: &Value, home: &str) -> Result<String, String> {
    let slug = args
        .get("slug")
        .and_then(Value::as_str)
        .ok_or_else(|| "fix needs a slug".to_string())?;
    let code = args.get("code").and_then(Value::as_str);
    let ic_args = fix::fix_args(slug, code, &[])?;
    let env = crate::commands::app_env(crate::commands::VERSION);
    let ended = scripts::run_ic(app, "repair-fix", &ic_args, &env, FIX_LIMIT)?;
    Ok(super::scrub::scrub(
        &super::scrub::bound(transcript(&ended).chars().take(8000).collect()),
        home,
    ))
}

fn sandbox_power(
    app: &tauri::AppHandle,
    args: &Value,
    action: &str,
    home: &str,
) -> Result<String, String> {
    let slug = args
        .get("slug")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{action} needs a slug"))?;
    if !crate::setup_link::is_slug(slug) {
        return Err("that is not a sandbox name".into());
    }
    let run = commands::power_script(slug, action, Host::current(), VERSION)?;
    scripts::run(app, &format!("repair-{action}:{slug}"), run)
        .map_err(|error| error.to_string())?;
    Ok(super::scrub::scrub(
        &format!("sandbox {slug} {action} started"),
        home,
    ))
}

fn sandbox_rollback(app: &tauri::AppHandle, args: &Value, home: &str) -> Result<String, String> {
    let slug = args
        .get("slug")
        .and_then(Value::as_str)
        .ok_or_else(|| "sandbox_rollback needs a slug".to_string())?;
    if !crate::setup_link::is_slug(slug) {
        return Err("that is not a sandbox name".into());
    }
    let run = commands::recreate_script(slug, None, true, Host::current(), VERSION);
    scripts::run(app, &format!("repair-rollback:{slug}"), run)
        .map_err(|error| error.to_string())?;
    Ok(super::scrub::scrub(
        &format!("rollback started for {slug}"),
        home,
    ))
}

/// `ic engine move --to <to> --yes` through the card's own run (engine.rs `run_move`): the ic beside this app, one move
/// at a time with the card's, and every step on the card while the model waits. The model reads how it ended, at the end
/// of a transcript the copies' byte counts make long; a move that did not finish is this tool failing, in ic's words.
/// No limit of its own: ic fails a copy that moves no byte for ten minutes and puts everything back, and killing it part
/// way is the one ending that would leave sandboxes stopped.
fn engine_move(app: &tauri::AppHandle, args: &Value, home: &str) -> Result<String, String> {
    let to = args
        .get("to")
        .and_then(Value::as_str)
        .ok_or_else(|| "engine_move needs `to`: intentic or docker-desktop".to_string())?;
    let to = crate::engine::move_target(to)?;
    let _claim = crate::engine::claim()
        .ok_or_else(|| "A move between engines is already running on this PC.".to_string())?;
    let end = crate::engine::run_move(app, to)?;
    let transcript = end
        .log
        .as_deref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let said = super::scrub::scrub(
        &super::scrub::bound(crate::engine::move_digest(&transcript, MOVE_SAID)),
        home,
    );
    if end.outcome == "moved" {
        Ok(said)
    } else {
        Err(said)
    }
}

fn ic_simple(
    app: &tauri::AppHandle,
    args: &[&str],
    limit: Duration,
    home: &str,
) -> Result<String, String> {
    let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    ic_json(app, &owned, limit, home)
}

fn ic_json(
    app: &tauri::AppHandle,
    args: &[String],
    limit: Duration,
    home: &str,
) -> Result<String, String> {
    let env = crate::commands::app_env(crate::commands::VERSION);
    let ended = scripts::run_ic(app, "repair-ic", args, &env, limit)?;
    Ok(super::scrub::scrub(
        &super::scrub::bound(transcript(&ended).chars().take(8000).collect()),
        home,
    ))
}

fn transcript(ended: &scripts::Ended) -> String {
    ended
        .log
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default()
}
