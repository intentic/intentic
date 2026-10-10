//! WHICH ENGINE THIS PC'S SANDBOXES RUN ON, AND THE MOVE TO THE OTHER (2026-10-10): Docker Desktop or Intentic's engine
//! (a dockerd in a WSL distro of ours), every sandbox moved from one to the other at the reader's word, the reader's
//! preference, and the copies a move leaves behind. This device's engine card draws it (src/device/engine.ts). Every
//! answer is `ic engine`'s own: this app runs it and reads what it prints.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::commands;
use crate::scripts::{self, Heard, Host, Stream};

/// The run a move streams under (`desktop://run` and its transcript); windows.rs `run_said` names it when Quit asks.
pub const RUN: &str = "engine-move";

/// What every window hears of a move: each `intentic-move:` line ic prints, as its JSON with the engine it goes `to`,
/// then how the run ended (`step: "exit"`, a [`MoveEnd`]).
pub const EVENT: &str = "desktop://engine-move";

/// How ic marks the lines of a move meant for this app (its engine/moves.rs `say`).
const MARKER: &str = "intentic-move:";

/// ic's exit when another move is running on this PC (its main.rs guard): this one never started.
const EXIT_BUSY: i32 = 3;

/// `ic engine status --json` reads the engine's record, WSL's list of distros and docker: seconds, bounded well past.
const STATUS_LIMIT: Duration = Duration::from_secs(30);

/// `ic engine prefer` writes one file.
const PREFER_LIMIT: Duration = Duration::from_secs(60);

/// `ic engine cleanup --now` may start Intentic's engine to remove what it keeps, then removes a few things per copy.
const CLEANUP_LIMIT: Duration = Duration::from_secs(600);

/// A move this app started (the card's or Repair's) is running. ic refuses a second move only once the first has written
/// its journal, which is minutes in when Intentic's engine is installed first, so this app holds one at a time itself.
static MOVING: AtomicBool = AtomicBool::new(false);

/// This app's one move at a time, given back when dropped.
pub struct Claim(());

impl Drop for Claim {
    fn drop(&mut self) {
        MOVING.store(false, Ordering::SeqCst);
    }
}

/// The turn to move, unless a move of this app's is running.
pub fn claim() -> Option<Claim> {
    if MOVING.swap(true, Ordering::SeqCst) {
        // Held by the move already running: only its own claim gives it back. A `Claim` made here only to be refused would
        // give it back on being dropped.
        None
    } else {
        Some(Claim(()))
    }
}

/// An engine as ic's command line spells it, for a move or a preference: `intentic` or `docker-desktop`, nothing else
/// reaches the command line.
pub fn move_target(to: &str) -> Result<&'static str, String> {
    match to {
        "intentic" => Ok("intentic"),
        "docker-desktop" => Ok("docker-desktop"),
        other => Err(format!(
            "{other:?} is not an engine: say intentic or docker-desktop"
        )),
    }
}

/// The same engine as ic names it in what it prints (`status --json`, a move's lines): `intentic` or `dockerDesktop`.
fn engine_id(target: &str) -> &'static str {
    if target == "docker-desktop" {
        "dockerDesktop"
    } else {
        "intentic"
    }
}

/// One line of a move as ic printed it: the JSON object after [`MARKER`], when it names its step. Pure.
pub fn parse_move_line(line: &str) -> Option<Value> {
    let json = line.trim().strip_prefix(MARKER)?;
    let said: Value = serde_json::from_str(json.trim()).ok()?;
    said.get("step")?.as_str()?;
    Some(said)
}

/// How a move ended, for the card that started it and every window following it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveEnd {
    /// `moved`: the sandboxes are on the other engine and the PC runs on it. `failed`: it stopped. `busy`: another move
    /// was running, and this one never started.
    pub outcome: &'static str,
    /// ic's exit code: 0 moved, 1 stopped with every sandbox put back, 3 another move running; none when it was killed.
    pub code: Option<i32>,
    /// Every sandbox is where it was before the move: so for every ending ic chose itself, never for one cut short.
    pub put_back: bool,
    /// ic ran, so its steps and this end reached every window ([`EVENT`]). Not for a move refused because one of this
    /// app's own was running: nothing was told to the windows following that one.
    pub ran: bool,
    /// The engine the PC runs on after it, as ic named it (`intentic`, `dockerDesktop`).
    pub engine: Option<String>,
    /// How many sandboxes moved.
    pub count: Option<u64>,
    /// Why it stopped, in ic's words.
    pub reason: Option<String>,
    /// The run's transcript.
    pub log: Option<String>,
}

impl MoveEnd {
    /// The end as the windows hear it: a `step`, like every line before it.
    fn as_event(&self) -> Value {
        let mut event = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(object) = event.as_object_mut() {
            object.insert("step".to_string(), Value::from("exit"));
        }
        event
    }
}

/// What a move said that its ending is read from: `done`'s engine and count, `failed`'s reason, and ic's own `error:`
/// line, which is all there is from a move that stopped before it had a sandbox in hand (no room on the disk, an engine
/// that would not start) and from one that never began (another move running).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MoveReading {
    /// Where the move goes, as ic's command line spells it.
    to: Option<&'static str>,
    engine: Option<String>,
    count: Option<u64>,
    failed: Option<String>,
    error: Option<String>,
}

impl MoveReading {
    /// The reading of a move to `to` (`intentic` or `docker-desktop`).
    pub fn towards(to: &'static str) -> MoveReading {
        MoveReading {
            to: Some(to),
            ..MoveReading::default()
        }
    }

    /// Take one line of the run; a move line comes back as its JSON, for the windows. Pure.
    pub fn hear(&mut self, stream: Stream, line: &str) -> Option<Value> {
        if stream == Stream::Stderr {
            if self.error.is_none() {
                self.error = line
                    .trim()
                    .strip_prefix("error:")
                    .map(|rest| rest.trim().to_string())
                    .filter(|rest| !rest.is_empty());
            }
            return None;
        }
        let said = parse_move_line(line)?;
        match said["step"].as_str() {
            Some("done") => {
                self.engine = said["engine"].as_str().map(str::to_string);
                self.count = said["count"].as_u64();
            }
            Some("failed") => self.failed = said["reason"].as_str().map(str::to_string),
            _ => {}
        }
        Some(said)
    }

    /// How the run ended, from ic's exit and what it said on the way. Exit 1 is ic's own failure path, which puts every
    /// sandbox back before it exits (and 2, a command line it did not take, never touched one); a run killed part way, or
    /// one that died some other way, leaves them wherever it had got to. Pure.
    pub fn end(&self, code: Option<i32>, log: Option<String>) -> MoveEnd {
        let (outcome, put_back) = match code {
            Some(0) => ("moved", false),
            Some(EXIT_BUSY) => ("busy", true),
            Some(1 | 2) => ("failed", true),
            _ => ("failed", false),
        };
        MoveEnd {
            outcome,
            code,
            put_back,
            ran: true,
            // A move with nothing to carry, or onto the engine already in use, says where the PC runs in words only.
            engine: self.engine.clone().or_else(|| {
                (outcome == "moved")
                    .then_some(self.to)
                    .flatten()
                    .map(|to| engine_id(to).to_string())
            }),
            count: self.count,
            reason: if outcome == "moved" {
                None
            } else {
                self.failed.clone().or_else(|| self.error.clone())
            },
            log,
        }
    }
}

/// The `ic` this app runs `ic engine` with: its own, which knows every field the card reads, else the one installed.
fn ic_program() -> Option<PathBuf> {
    commands::bundled_ic().or_else(|| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .ok();
        scripts::ic_candidates(Host::current(), home.as_deref())
            .into_iter()
            .map(PathBuf::from)
            .find(|candidate| candidate.is_file())
    })
}

/// `ic engine <args>`, to its exit or killed at `limit`, told what every run of this app is (`app_env`).
fn ic_engine(args: &[&str], limit: Duration) -> Result<scripts::Captured, String> {
    let ic = ic_program().ok_or_else(|| scripts::IC_MISSING.to_string())?;
    let mut command = Command::new(&ic);
    if let Some(dir) = ic.parent() {
        command.current_dir(dir);
    }
    command.arg("engine").args(args);
    command.envs(commands::app_env(commands::VERSION));
    intentic_bounded::no_window(&mut command);
    let what = format!("ic engine {}", args.first().copied().unwrap_or_default());
    scripts::capture(&what, command, limit).map_err(|silence| silence.to_string())
}

/// What ic said on its way out of a run that failed: its `error:` line, else its last line. Pure.
fn last_words(stdout: &str, stderr: &str, what: &str) -> String {
    let said = |text: &str| {
        text.lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
            .map(str::to_string)
    };
    stderr
        .lines()
        .find_map(|line| line.trim().strip_prefix("error:"))
        .map(|reason| reason.trim().to_string())
        .filter(|reason| !reason.is_empty())
        .or_else(|| said(stderr))
        .or_else(|| said(stdout))
        .unwrap_or_else(|| format!("{what} failed"))
}

/// The status in what `ic engine status --json` printed: an object that names the engine sandboxes run on, which an
/// `ic` from before `--json` never prints. Pure.
pub fn status_from(stdout: &str) -> Option<Value> {
    scripts::json_object_in(stdout).filter(|status| status["engine"].is_string())
}

fn read_status() -> Result<Value, String> {
    let answer = ic_engine(&["status", "--json"], STATUS_LIMIT)?;
    if !answer.success {
        return Err(last_words(
            &answer.stdout,
            &answer.stderr,
            "ic engine status",
        ));
    }
    status_from(&answer.stdout)
        .ok_or_else(|| "ic engine status said nothing this app can read".to_string())
}

/// `ic engine status --json`, as ic printed it: which engine the sandboxes run on, whether a move is possible or worth
/// offering, a move under way and the copies earlier ones left. Null where there is no answer: on a computer that is not
/// a Windows PC, which has one engine and nothing to move between, and where ic is missing or did not answer, which the
/// card has nothing to say about (the reason goes to the app's own log).
#[tauri::command]
pub async fn engine_status() -> Option<Value> {
    if Host::current() != Host::Windows {
        return None;
    }
    tauri::async_runtime::spawn_blocking(|| match read_status() {
        Ok(status) => Some(status),
        Err(problem) => {
            eprintln!("intentic: the engine's status could not be read: {problem}");
            None
        }
    })
    .await
    .ok()
    .flatten()
}

/// A move asked for while one of this app's runs: `busy`, as ic answers for one running from anywhere else, and told to
/// no window, since those following the running move would read it as that move's end. Pure.
fn refused() -> MoveEnd {
    MoveEnd {
        ran: false,
        ..MoveReading::default().end(Some(EXIT_BUSY), None)
    }
}

/// Run `ic engine move --to <to> --yes` under [`RUN`], and tell every window each step it takes ([`EVENT`]). BLOCKING,
/// for minutes. `Err` only when it never started. The card and Repair both move through here: the ic beside this app
/// (an older installed one may not know `engine move`), and every window following the same steps whoever asked.
pub(crate) fn run_move(app: &AppHandle, to: &'static str) -> Result<MoveEnd, String> {
    let reading = Arc::new(Mutex::new(MoveReading::towards(to)));
    let heard: Heard = {
        let app = app.clone();
        let reading = Arc::clone(&reading);
        Arc::new(move |stream: Stream, line: &str| {
            let said = reading
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .hear(stream, line);
            if let Some(mut said) = said {
                // Which way it goes, on every step: a window that opens part way through has nothing else to read it from.
                if let Some(object) = said.as_object_mut() {
                    object
                        .entry("to")
                        .or_insert_with(|| Value::from(engine_id(to)));
                }
                let _ = app.emit(EVENT, said);
            }
        })
    };
    let ended = scripts::run_ic_heard(
        app,
        RUN,
        "ic engine move",
        &["engine", "move", "--to", to, "--yes"],
        &[],
        Some(heard),
    )?;
    let end = reading
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .end(ended.code, ended.log);
    let _ = app.emit(EVENT, end.as_event());
    Ok(end)
}

/// Move every sandbox this side of the PC keeps onto `to` (`intentic` or `docker-desktop`), then switch the PC onto it:
/// minutes long, streamed as every run is (`desktop://run`) and step by step to every window ([`EVENT`]). A move already
/// running from this app answers `busy`, as ic does for one running from anywhere else, and is not told to the windows
/// following it. `Err` when it never ran: a value of the wrong shape, no `ic` beside this app.
#[tauri::command]
pub async fn engine_move(app: AppHandle, to: String) -> Result<MoveEnd, String> {
    let to = move_target(&to)?;
    let Some(claim) = claim() else {
        return Ok(refused());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _claim = claim;
        run_move(&app, to)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `ic engine prefer <engine>`: the reader's word on which engine this PC should use, kept for every later choice. A
/// "Not now" to the move is a preference for Docker Desktop. Moves nothing.
#[tauri::command]
pub async fn engine_prefer(engine: String) -> Result<(), String> {
    let engine = move_target(&engine)?;
    tauri::async_runtime::spawn_blocking(move || {
        let answer = ic_engine(&["prefer", engine], PREFER_LIMIT)?;
        if answer.success {
            Ok(())
        } else {
            Err(last_words(
                &answer.stdout,
                &answer.stderr,
                "ic engine prefer",
            ))
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `ic engine cleanup --now`: remove the stopped copies a move left on the other engine now, rather than once their
/// days are up. A copy on a Docker Desktop that is not running stays for a later round, which the status then shows.
#[tauri::command]
pub async fn engine_cleanup() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let answer = ic_engine(&["cleanup", "--now"], CLEANUP_LIMIT)?;
        if answer.success {
            Ok(())
        } else {
            Err(last_words(
                &answer.stdout,
                &answer.stderr,
                "ic engine cleanup",
            ))
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// A move's transcript as Repair hands it to the model: every line but the byte counts a copy prints every two seconds
/// and the steps of installing Intentic's engine first, kept from the end back as far as `budget` bytes go, since how a
/// move ended is at its end. Pure.
pub fn move_digest(transcript: &str, budget: usize) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut size = 0;
    for line in transcript.lines().rev().filter(|line| !progress_tick(line)) {
        if size + line.len() + 1 > budget {
            kept.push("…");
            break;
        }
        size += line.len() + 1;
        kept.push(line);
    }
    kept.reverse();
    kept.join("\n")
}

/// A line that only says how far a step has got: a copy's bytes, or a sentence of installing our engine.
fn progress_tick(line: &str) -> bool {
    parse_move_line(line).is_some_and(|said| match said["step"].as_str() {
        Some("image" | "volume") => said.get("done").is_some(),
        Some("engine") => true,
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_move_goes_to_one_of_two_engines_spelled_as_ics_command_line_spells_them() {
        assert_eq!(move_target("intentic"), Ok("intentic"));
        assert_eq!(move_target("docker-desktop"), Ok("docker-desktop"));
        // ic's own id for Docker Desktop is what it prints, never what it takes; a flag or a second word never reaches it.
        for bad in [
            "",
            "dockerDesktop",
            "native",
            "--yes",
            "intentic --yes",
            "Intentic",
        ] {
            assert!(move_target(bad).is_err(), "{bad:?}");
        }
        assert_eq!(engine_id("docker-desktop"), "dockerDesktop");
        assert_eq!(engine_id("intentic"), "intentic");
    }

    #[test]
    fn a_move_line_is_the_json_after_its_marker_and_nothing_else_is() {
        assert_eq!(
            parse_move_line(
                r#"intentic-move: {"slug":"work","step":"begin","index":0,"count":2,"bytes":512}"#
            ),
            Some(json!({ "slug": "work", "step": "begin", "index": 0, "count": 2, "bytes": 512 }))
        );
        // A line as the transcript or a console hands it over: padded, with a carriage return.
        assert_eq!(
            parse_move_line("  intentic-move: {\"slug\":\"\",\"step\":\"done\",\"engine\":\"intentic\",\"count\":1}\r"),
            Some(json!({ "slug": "", "step": "done", "engine": "intentic", "count": 1 }))
        );
        for other in [
            "intentic: moved 1 sandbox to Intentic's engine.",
            "intentic-move: {\"slug\":\"work\"}",
            "intentic-move: {\"step\":3}",
            "intentic-move: [\"step\"]",
            "intentic-move: {\"step\":\"image\"",
            "intentic-prefetch: {\"step\":\"done\"}",
            "",
        ] {
            assert_eq!(parse_move_line(other), None, "{other:?}");
        }
    }

    fn read(lines: &[(Stream, &str)]) -> (MoveReading, Vec<Value>) {
        let mut reading = MoveReading::default();
        let said = lines
            .iter()
            .filter_map(|(stream, line)| reading.hear(*stream, line))
            .collect();
        (reading, said)
    }

    #[test]
    fn a_move_that_finished_says_where_the_pc_runs_now_and_how_many_moved() {
        let (reading, said) = read(&[
            (
                Stream::Stdout,
                r#"intentic-move: {"slug":"work","step":"begin","index":0,"count":1,"bytes":10}"#,
            ),
            (
                Stream::Stdout,
                r#"intentic-move: {"slug":"work","step":"volume","done":5,"total":10}"#,
            ),
            (
                Stream::Stdout,
                r#"intentic-move: {"slug":"work","step":"moved"}"#,
            ),
            (
                Stream::Stdout,
                r#"intentic-move: {"slug":"","step":"done","engine":"intentic","count":1}"#,
            ),
            (
                Stream::Stdout,
                "intentic: moved 1 sandbox to Intentic's engine.",
            ),
        ]);
        // Every move line goes to the windows; the narration does not.
        assert_eq!(said.len(), 4);
        let end = reading.end(Some(0), Some("/logs/move.log".into()));
        assert_eq!(
            end,
            MoveEnd {
                outcome: "moved",
                code: Some(0),
                put_back: false,
                ran: true,
                engine: Some("intentic".into()),
                count: Some(1),
                reason: None,
                log: Some("/logs/move.log".into()),
            }
        );
    }

    #[test]
    fn a_move_with_nothing_to_carry_still_moved_and_says_where_the_pc_runs() {
        // ic switches the PC and says so in words only: no `done` line, exit 0.
        let mut reading = MoveReading::towards("docker-desktop");
        let said = reading.hear(
            Stream::Stdout,
            "intentic: no sandbox to carry — this PC now runs its sandboxes on Docker Desktop.",
        );
        assert_eq!(said, None);
        let end = reading.end(Some(0), None);
        assert_eq!(
            (end.outcome, end.count, end.reason, end.engine.as_deref()),
            ("moved", None, None, Some("dockerDesktop"))
        );
        // Only a move that moved says where the PC runs now.
        assert_eq!(reading.end(Some(1), None).engine, None);
    }

    #[test]
    fn a_move_that_failed_with_a_sandbox_in_hand_says_why_and_that_all_is_back() {
        let (reading, _) = read(&[
            (
                Stream::Stdout,
                r#"intentic-move: {"slug":"work","step":"begin","index":0,"count":1,"bytes":10}"#,
            ),
            (
                Stream::Stdout,
                r#"intentic-move: {"slug":"","step":"failed","reason":"work: the copy of work-data does not match"}"#,
            ),
            (
                Stream::Stderr,
                "error: the move to Intentic's engine did not finish: work: the copy of work-data does not match",
            ),
            (
                Stream::Stderr,
                "       Every sandbox is back on Docker Desktop as it was, and this PC still runs on it.",
            ),
        ]);
        let end = reading.end(Some(1), None);
        assert_eq!(end.outcome, "failed");
        assert!(end.put_back);
        // The step's own reason, not the sentence wrapped around it.
        assert_eq!(
            end.reason.as_deref(),
            Some("work: the copy of work-data does not match")
        );
    }

    #[test]
    fn a_move_that_stopped_before_any_sandbox_says_ics_own_error() {
        let (reading, said) = read(&[
            (Stream::Stderr, "! warning first"),
            (
                Stream::Stderr,
                "error: Intentic's engine needs about 12.0 GB free on C:\\ for the copies, and 3.1 GB is free — free some space, then try again.",
            ),
            (Stream::Stderr, "error: a second error line is not the reason"),
        ]);
        assert!(said.is_empty());
        let end = reading.end(Some(1), None);
        assert_eq!(end.outcome, "failed");
        assert!(end.put_back);
        assert!(end
            .reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("Intentic's engine needs about 12.0 GB")));
    }

    #[test]
    fn another_move_running_is_busy_and_nothing_was_touched() {
        let (reading, _) = read(&[(
            Stream::Stderr,
            "error: a move between container engines is running on this PC: try again once it has finished (`ic engine status` shows it).",
        )]);
        let end = reading.end(Some(3), None);
        assert_eq!(end.outcome, "busy");
        assert!(end.put_back);
        assert!(end.reason.is_some());
        assert!(end.ran);
        // This app's own guard answers the same, with no words of ic's to carry, and nothing went to the windows.
        let ours = refused();
        assert_eq!(
            (ours.outcome, ours.code, ours.reason),
            ("busy", Some(3), None)
        );
        assert!(!ours.ran);
    }

    #[test]
    fn a_move_cut_short_is_never_said_to_have_put_everything_back() {
        let reading = MoveReading::default();
        for code in [None, Some(101), Some(-1)] {
            let end = reading.end(code, None);
            assert_eq!(end.outcome, "failed", "{code:?}");
            assert!(!end.put_back, "{code:?}");
        }
        // A command line the ic did not take touched nothing.
        assert!(reading.end(Some(2), None).put_back);
    }

    #[test]
    fn the_end_reaches_the_windows_as_a_step_of_its_own_in_their_spelling() {
        let end = MoveReading::default().end(Some(1), Some("/logs/m.log".into()));
        assert_eq!(
            end.as_event(),
            json!({
                "step": "exit",
                "outcome": "failed",
                "code": 1,
                "putBack": true,
                "ran": true,
                "engine": null,
                "count": null,
                "reason": null,
                "log": "/logs/m.log",
            })
        );
    }

    #[test]
    fn the_status_is_the_object_that_names_the_engine() {
        let line = r#"{"engine":"dockerDesktop","canMove":true,"offerMove":false,"moves":null}"#;
        assert_eq!(
            status_from(&format!("intentic: fetched ic\n{line}\n")),
            Some(
                json!({ "engine": "dockerDesktop", "canMove": true, "offerMove": false, "moves": null })
            )
        );
        // An ic from before `--json` prints words; an object without the engine is not a status.
        assert_eq!(status_from("Engine: dockerDesktop\nInstalled: no\n"), None);
        assert_eq!(status_from(r#"{"installed":true}"#), None);
        assert_eq!(status_from(""), None);
    }

    #[test]
    fn a_failed_runs_last_words_are_its_error_line_first() {
        assert_eq!(
            last_words(
                "intentic: removed the copy of a",
                "warning\nerror: no home folder\n",
                "ic engine cleanup"
            ),
            "no home folder"
        );
        assert_eq!(
            last_words("said this\n\n", "", "ic engine prefer"),
            "said this"
        );
        assert_eq!(
            last_words("", "\n  \n", "ic engine prefer"),
            "ic engine prefer failed"
        );
    }

    #[test]
    fn repair_reads_a_moves_ending_without_its_byte_counts() {
        let mut transcript =
            String::from("intentic: installing Intentic's engine first (about 95 MB)…\n");
        transcript.push_str(
            "intentic-move: {\"slug\":\"\",\"step\":\"engine\",\"sentence\":\"Downloading\",\"percent\":40}\n",
        );
        transcript.push_str(
            "intentic-move: {\"slug\":\"work\",\"step\":\"begin\",\"index\":0,\"count\":1,\"bytes\":10}\n",
        );
        transcript
            .push_str("intentic-move: {\"slug\":\"work\",\"step\":\"image\",\"images\":[\"ghcr.io/intentic/sandbox:stable\"]}\n");
        for done in 0..500 {
            transcript.push_str(&format!(
                "intentic-move: {{\"slug\":\"work\",\"step\":\"image\",\"done\":{done},\"total\":500}}\n"
            ));
        }
        transcript.push_str("intentic-move: {\"slug\":\"work\",\"step\":\"moved\"}\n");
        transcript.push_str(
            "intentic: moved 1 sandbox to Intentic's engine.\n\n[ic exited with Some(0)]\n",
        );
        let digest = move_digest(&transcript, 8000);
        assert!(!digest.contains("\"done\""));
        assert!(!digest.contains("\"step\":\"engine\""));
        assert!(digest.contains("\"images\""));
        assert!(digest.ends_with("[ic exited with Some(0)]"));
        assert!(digest.starts_with("intentic: installing"));

        // Past the budget, the end is what stays.
        let short = move_digest(&transcript, 80);
        assert!(short.starts_with('…'));
        assert!(short.ends_with("[ic exited with Some(0)]"));
        assert!(short.len() <= 80 + "…\n".len());
    }

    #[test]
    fn one_move_at_a_time_from_this_app() {
        let first = claim().expect("nothing is moving yet");
        // Refused, and refused again: a refusal never gives back the turn the running move holds.
        assert!(claim().is_none());
        assert!(claim().is_none());
        drop(first);
        let second = claim().expect("the first move gave its turn back");
        assert!(claim().is_none());
        drop(second);
    }
}
