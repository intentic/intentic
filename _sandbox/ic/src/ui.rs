use std::collections::BTreeMap;
use std::io::{IsTerminal, Write};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/* EVERY BYTE THIS BINARY SHOWS A PERSON, IN ONE PLACE — and the reason it can be pretty at all.
 *
 * The shapes below are a CONTRACT, not house style: docs/cli-output-protocol.md writes down the line format,
 * the three modes and the row vocabulary, and _devices/local-agent/src/ui.ts is this module's TypeScript
 * twin — the sync and device agents render through it, so an install reads as one program.
 *
 * The install output is read by two audiences that want opposite things. The desktop app spawns this binary
 * with piped stdio (desktop-app/src-tauri/src/scripts.rs) and turns `intentic: [phase] …` markers into a
 * progress bar; a CI step does the same with a log file. Those readers need output that never changes shape.
 * A person pasting the one-liner into a terminal needs the opposite: hierarchy, colour, a sense of how much
 * is left, and no forty lines of docker layer hashes.
 *
 * So the audiences are split by the one test that actually distinguishes them — is stdout a terminal — and
 * the split is total. `Mode::Plain` emits byte-for-byte what this binary has always emitted, so nothing that
 * parses it can tell this module was ever written. `Mode::Rich` is the redesign, and it can only ever be
 * reached by a human. The same test already gates the Windows requirement announcements (prepare/mod.rs).
 *
 * THE LIVE REGION IS EXACTLY ONE LINE. Redrawing a whole checklist in place needs the cursor moved up N
 * lines, which needs N to be right, which needs to know when a line wrapped — and this binary runs under
 * `curl | sudo sh`, inside dash, on PowerShell 5.1, in terminals of unknown width. A single line repainted
 * with a carriage return needs none of that, and a truncation to the narrowest width we might be on keeps
 * even that line from wrapping. Everything already settled scrolls above it as ordinary output.
 *
 * Consequence, and the one rule callers must follow: anything that writes to stdout WITHOUT going through
 * this module (docker's own output, a piped installer, get.docker.com) has to be bracketed by `suspend` and
 * `resume`, or it will land on top of the live line. */

// ── modes and capabilities ──────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// A person is watching: hierarchy, colour, a repainting status line.
    Rich,
    /// Something is parsing: the historical marker stream, unchanged.
    Plain,
}

/// One step of the flow as the reader meets it: the phase id the wire carries, the words a person reads, and
/// roughly how long it takes. Weights are seconds and they are guesses — they exist so the estimate is about
/// TIME left rather than STEPS left, since "8 of 9" on the near side of a four-minute pull is a lie a step
/// counter tells. They are only ever compared, never shown.
#[derive(Clone, Copy)]
pub struct PlanStep {
    pub phase: &'static str,
    pub label: &'static str,
    pub weight: u32,
}

struct Glyphs {
    ok: &'static str,
    fail: &'static str,
    warn: &'static str,
    skip: &'static str,
    spinner: &'static [&'static str],
}

const UNICODE: Glyphs = Glyphs {
    ok: "✓",
    fail: "✗",
    warn: "!",
    skip: "·",
    spinner: &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII: Glyphs = Glyphs {
    ok: "+",
    fail: "x",
    warn: "!",
    skip: "-",
    spinner: &["|", "/", "-", "\\"],
};

const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const GREEN: &str = "\x1b[32m";
const RED: &str = "\x1b[31m";
const YELLOW: &str = "\x1b[33m";
const CYAN: &str = "\x1b[36m";
const RESET: &str = "\x1b[0m";

// ── state ───────────────────────────────────────────────────────────────────

struct State {
    mode: Mode,
    color: bool,
    glyphs: &'static Glyphs,
    width: usize,
    plan: Vec<PlanStep>,
    /// Index into `plan` of the running step, when it is one the plan carries.
    index: Option<usize>,
    /// Ordinal of the running step for display — counts every step, planned or not.
    ordinal: usize,
    label: String,
    detail: String,
    started: Instant,
    step_started: Instant,
    frame: usize,
    /// A live line is currently on screen and owes an erase before anything else prints.
    live: bool,
    suspended: bool,
    /// Weight of every step already finished, in the plan's own units.
    behind: u32,
    /// Layer id → how far through it docker has reported, for the pull's real fraction.
    layers: BTreeMap<String, f32>,
    /// The pull's readout, never allowed to fall — see `pull_line`.
    pull_percent: u32,
    spinning: bool,
}

static UI: OnceLock<Mutex<State>> = OnceLock::new();

fn ui() -> MutexGuard<'static, State> {
    let cell = UI.get_or_init(|| Mutex::new(State::detect()));
    // A panic while the lock was held must not take every later message with it — the flows here report
    // failures as prose, and a poisoned renderer would replace that with a second, worse panic.
    cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl State {
    fn detect() -> State {
        let terminal = std::io::stdout().is_terminal();
        // The protocol's override, honoured by both renderers (docs/cli-output-protocol.md). `nested` is a
        // CHILD's mode — this binary is the one that sets it on the agents it spawns, never the one that runs
        // inside somebody else's checklist — so it is not a value this reads.
        let mode = match std::env::var("INTENTIC_UI").as_deref() {
            Ok("plain") => Mode::Plain,
            Ok("rich") => Mode::Rich,
            _ if std::env::var("INTENTIC_PLAIN").as_deref() == Ok("1") => Mode::Plain,
            _ if terminal => Mode::Rich,
            _ => Mode::Plain,
        };
        // Windows consoles need virtual-terminal processing switched on before any escape means anything, and
        // a console old enough to refuse is also one we should not send box-drawing to.
        let vt = enable_vt();
        let color = mode == Mode::Rich
            && vt
            && (std::env::var_os("FORCE_COLOR").is_some()
                || std::env::var_os("NO_COLOR").is_none());
        State {
            mode,
            color,
            glyphs: if vt && unicode_safe() {
                &UNICODE
            } else {
                &ASCII
            },
            width: terminal_width(),
            plan: Vec::new(),
            index: None,
            ordinal: 0,
            label: String::new(),
            detail: String::new(),
            started: Instant::now(),
            step_started: Instant::now(),
            frame: 0,
            live: false,
            suspended: false,
            behind: 0,
            layers: BTreeMap::new(),
            pull_percent: 0,
            spinning: false,
        }
    }

    fn paint(&self, text: &str, color: &str) -> String {
        if self.color {
            format!("{color}{text}{RESET}")
        } else {
            text.to_string()
        }
    }
}

/// Terminal width, without a crate for it and without spawning anything. `COLUMNS` is exported by most
/// interactive shells; 80 is the floor every terminal has agreed on since 1978, and being wrong low only
/// costs a shorter line, while being wrong high wraps the one line we repaint and corrupts it.
fn terminal_width() -> usize {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|columns| *columns >= 40)
        .unwrap_or(80)
        .min(120)
}

#[cfg(windows)]
fn enable_vt() -> bool {
    // kernel32 is linked into every Windows binary; declaring the three calls here avoids a crate in a
    // binary the setup one-liner downloads on every run.
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;
    extern "system" {
        fn GetStdHandle(handle: u32) -> *mut core::ffi::c_void;
        fn GetConsoleMode(handle: *mut core::ffi::c_void, mode: *mut u32) -> i32;
        fn SetConsoleMode(handle: *mut core::ffi::c_void, mode: u32) -> i32;
    }
    unsafe {
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if handle.is_null() {
            return false;
        }
        let mut mode: u32 = 0;
        if GetConsoleMode(handle, &mut mode) == 0 {
            return false;
        }
        if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
            return true;
        }
        SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0
    }
}

#[cfg(not(windows))]
fn enable_vt() -> bool {
    true
}

/// Whether the glyphs above will render. Unix terminals have been UTF-8 by default for two decades, and a
/// locale is frequently unset under `sudo` and inside `curl … | sh`, so an unset one is not evidence of
/// anything; only an explicitly non-UTF-8 locale is.
#[cfg(not(windows))]
fn unicode_safe() -> bool {
    match std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LC_CTYPE"))
        .or_else(|_| std::env::var("LANG"))
    {
        Ok(locale) if !locale.is_empty() => {
            let locale = locale.to_ascii_lowercase();
            locale.contains("utf-8") || locale.contains("utf8")
        }
        _ => true,
    }
}

#[cfg(windows)]
fn unicode_safe() -> bool {
    // A console that took VT is modern enough for these; one that refused would print mojibake.
    true
}

// ── the public surface ──────────────────────────────────────────────────────

pub fn mode() -> Mode {
    ui().mode
}

pub fn is_rich() -> bool {
    mode() == Mode::Rich
}

/// The banner, and the shape of what is about to happen. `steps` is drawn as a promise about SCOPE and TIME
/// rather than a list — a list here would be read once and then repeated line by line as the run ticks it
/// off, and two renderings of the same nine things is how a screen stops being read at all.
pub fn begin(title: &str, plan: Vec<PlanStep>) {
    let mut state = ui();
    state.plan = plan;
    state.started = Instant::now();
    if state.mode == Mode::Plain {
        return;
    }
    let count = state.plan.len();
    let seconds: u32 = state.plan.iter().map(|step| step.weight).sum();
    let heading = state.paint(title, BOLD);
    let version = env!("CARGO_PKG_VERSION");
    let stamp = if version == "0.0.0" {
        String::new()
    } else {
        state.paint(&format!("ic {version}"), DIM)
    };
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out);
    if stamp.is_empty() {
        let _ = writeln!(out, "  {heading}");
    } else {
        // Right-aligned against the padded plain text, so the escapes never count toward the column.
        let pad = state
            .width
            .saturating_sub(3 + title.chars().count() + version.len() + 3);
        let _ = writeln!(out, "  {heading}{:pad$}{stamp}", "", pad = pad);
    }
    if count > 0 {
        let minutes = (seconds as f32 / 60.0).round().max(1.0) as u32;
        let summary = format!(
            "  {count} steps, roughly {minutes} minute{}. One long download in the middle is most of it.",
            if minutes == 1 { "" } else { "s" }
        );
        let _ = writeln!(out, "{}", state.paint(&summary, DIM));
    }
    let _ = writeln!(out);
    let _ = out.flush();
    drop(state);
    start_spinner();
}

/// A PHASE OF THE FLOW, ANNOUNCED ONCE — prose for the terminal, and a name for anything watching.
///
/// The phase id is the vocabulary the desktop app's plan and the platform's setup report both use, so it must
/// keep going out on the wire exactly as it always has. It is also the one thing a person reading a terminal
/// should never see: `[waiting-health] waiting for the sandbox daemon to come up…` says the same thing twice,
/// once in a shape that reads like an error code. In `Rich` the id selects the step's own words from the plan
/// and the sentence is dropped; off the plan, the sentence is all there is and it is used.
pub fn step(phase: &str, message: &str) {
    let mut state = ui();
    if state.mode == Mode::Plain {
        println!("intentic: [{phase}] {message}");
        return;
    }
    settle_current(&mut state);
    let planned = state
        .plan
        .iter()
        .position(|planned| planned.phase == phase)
        .filter(|found| state.index.is_none_or(|current| *found >= current));
    state.index = planned;
    state.label = planned
        .map(|at| state.plan[at].label.to_string())
        .unwrap_or_else(|| capitalize(message));
    state.detail.clear();
    state.layers.clear();
    state.pull_percent = 0;
    state.ordinal += 1;
    state.step_started = Instant::now();
    state.frame = 0;
    repaint(&mut state);
}

/// Replace the running step's sub-detail — the pull's layer count, a boot step's name. Rich only: in Plain
/// this is narration nobody asked for, and the marker stream is a contract.
pub fn detail(text: &str) {
    let mut state = ui();
    if state.mode == Mode::Plain {
        return;
    }
    if state.detail == text {
        return;
    }
    state.detail = text.to_string();
    repaint(&mut state);
}

/// A settled verdict about one thing — the preflight's checks, the doctor's links, a Windows requirement.
/// `note` is the half-sentence that follows a warn/skip/fail; empty for a pass.
pub fn row(outcome: RowOutcome, name: &str, note: &str) {
    let mut state = ui();
    if state.mode == Mode::Plain {
        // Byte-for-byte the historical rows, including the two-space gutter and the column padding. The
        // separator appears only when there is something after it — the Windows checklist has rows with no
        // note at all, and " — " with nothing behind it reads as truncation.
        let tail = if note.is_empty() {
            String::new()
        } else {
            format!(" — {note}")
        };
        match outcome {
            RowOutcome::Pass => println!("  ok    {name}{tail}"),
            RowOutcome::Warn => println!("  warn  {name}{tail}"),
            RowOutcome::Fail => println!("  FAIL  {name}{tail}"),
            RowOutcome::Skip => println!("  skip  {name}{tail}"),
        }
        return;
    }
    let (glyph, color) = match outcome {
        RowOutcome::Pass => (state.glyphs.ok, GREEN),
        RowOutcome::Warn => (state.glyphs.warn, YELLOW),
        RowOutcome::Fail => (state.glyphs.fail, RED),
        RowOutcome::Skip => (state.glyphs.skip, DIM),
    };
    let marker = state.paint(glyph, color);
    let body = if note.is_empty() {
        name.to_string()
    } else {
        format!("{name} — {note}")
    };
    for (index, part) in wrap(&body, state.width.saturating_sub(10))
        .iter()
        .enumerate()
    {
        let painted = state.paint(part, DIM);
        let rendered = if index == 0 {
            format!("        {marker} {painted}")
        } else {
            format!("          {painted}")
        };
        above(&mut state, &rendered);
    }
}

#[derive(Clone, Copy)]
pub enum RowOutcome {
    Pass,
    Warn,
    Fail,
    Skip,
}

/// Narration under the running step — the `intentic: …` sentences the flows print as they go. The prefix is
/// part of the Plain contract and is re-added there, so callers pass the sentence alone.
pub fn note(text: &str) {
    let mut state = ui();
    if state.mode == Mode::Plain {
        println!("intentic: {text}");
        return;
    }
    for part in wrap(text, state.width.saturating_sub(8)) {
        let body = state.paint(&format!("        {part}"), DIM);
        above(&mut state, &body);
    }
}

/// Narration that is a caution rather than progress — degraded, not broken. Goes to stderr in Plain, as it
/// always did. Continuation lines align under the first, so a two-sentence caution reads as one thing.
pub fn warn(text: &str) {
    let mut state = ui();
    if state.mode == Mode::Plain {
        for (index, part) in text.lines().enumerate() {
            if index == 0 {
                eprintln!("intentic: {part}");
            } else {
                eprintln!("          {part}");
            }
        }
        return;
    }
    let marker = state.paint(state.glyphs.warn, YELLOW);
    let mut first = true;
    for paragraph in text.lines() {
        for part in wrap(paragraph, state.width.saturating_sub(9)) {
            let body = state.paint(&part, DIM);
            let rendered = if first {
                format!("     {marker}  {body}")
            } else {
                format!("        {body}")
            };
            first = false;
            above(&mut state, &rendered);
        }
    }
}

/// A CHANGING MEASUREMENT under the running step — megabytes downloaded, seconds left before a wait gives up.
/// Windows-only today: it is the Docker Desktop installer that reports bytes, and the pull reports layers
/// through [`pull_line`] instead.
/// A pipe gets one line per reading, because an install log is a trail and the timings in it are the only
/// record of where a slow install went. A screen gets the newest reading in place, because forty lines of
/// "downloaded 210 MB" is the same information rendered as noise.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn progress(text: &str) {
    let mut state = ui();
    if state.mode == Mode::Plain {
        println!("      {text}");
        return;
    }
    state.detail = text.to_string();
    repaint(&mut state);
}

/// Feed one line of docker's pull output into the live progress. Returns whether the line was ABSORBED — a
/// caller in Rich prints only what this refuses, which is how the pull's forty lines of layer chatter become
/// one readout without also hiding the "unauthorized" that is the whole diagnosis of a failed pull.
pub fn pull_line(text: &str) -> bool {
    if is_pull_noise(text) {
        return true;
    }
    let Some((layer, done)) = parse_layer(text) else {
        return false;
    };
    let mut state = ui();
    state.layers.insert(layer, done);
    state.pull_percent = pull_percent(&state.layers, state.pull_percent);
    state.detail = format!("{} layers · {}%", state.layers.len(), state.pull_percent);
    repaint(&mut state);
    true
}

/// Hand the terminal to a subprocess that writes its own output (docker build, get.docker.com, the piped
/// agent installers). The live line is erased first, and the spinner stops repainting over what follows.
pub fn suspend() {
    let mut state = ui();
    if state.mode == Mode::Plain {
        return;
    }
    erase(&mut state);
    state.suspended = true;
}

pub fn resume() {
    let mut state = ui();
    if state.mode == Mode::Plain {
        return;
    }
    state.suspended = false;
    repaint(&mut state);
}

/// The end of a successful run, RICH ONLY — callers keep their historical prose for `Plain`, because that
/// ending is seven specific sentences that something downstream may be reading and no abstraction over them
/// would be byte-identical by construction.
///
/// The shape is the argument: a verdict, the one address that matters, the one instruction the reader has to
/// act on, and only then the commands they will want in a week — dim, aligned, and visibly a footnote. The
/// old ending gave all seven the same weight, which put "go back to your browser" third.
pub fn finished(
    verdict: &str,
    address: Option<&str>,
    instruction: &str,
    footnotes: &[(String, String)],
) {
    let mut state = ui();
    if state.mode == Mode::Plain {
        return;
    }
    settle_current(&mut state);
    state.spinning = false;
    let took = format!("took {}", human_duration(state.started.elapsed()));
    let pad = state
        .width
        .saturating_sub(6 + verdict.chars().count() + took.chars().count());
    let marker = state.paint(state.glyphs.ok, GREEN);
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "  {marker}  {}{:pad$}{}",
        state.paint(verdict, BOLD),
        "",
        state.paint(&took, DIM),
        pad = pad
    );
    if let Some(address) = address {
        let _ = writeln!(out);
        let _ = writeln!(out, "     {}", state.paint(address, CYAN));
    }
    if !instruction.is_empty() {
        let _ = writeln!(out);
        let _ = writeln!(out, "     {instruction}");
    }
    if !footnotes.is_empty() {
        let _ = writeln!(out);
        let column = footnotes
            .iter()
            .map(|(what, _)| what.chars().count())
            .max()
            .unwrap_or(0);
        for (index, (what, command)) in footnotes.iter().enumerate() {
            let heading = if index == 0 { "later" } else { "" };
            let row = format!("     {heading:<6} {what:<column$}   {command}");
            let _ = writeln!(out, "{}", state.paint(&truncate(&row, state.width), DIM));
        }
    }
    let _ = writeln!(out);
    let _ = out.flush();
}

/// The frame around a stopped run. The words are the flow's own — `checks::failure_summary` composes a
/// numbered problem/fix block and it is already the right information — so this only supplies what plain
/// text could not: that the run STOPPED, in a colour nobody scrolls past.
pub fn error(message: &str) {
    let mut state = ui();
    if state.mode == Mode::Plain {
        eprintln!("error: {message}");
        return;
    }
    erase(&mut state);
    state.spinning = false;
    let mut lines = message.lines();
    let first = lines.next().unwrap_or_default();
    let marker = state.paint(state.glyphs.fail, RED);
    let mut out = std::io::stderr().lock();
    let _ = writeln!(out);
    for (index, part) in wrap(first, state.width.saturating_sub(6))
        .iter()
        .enumerate()
    {
        let painted = state.paint(part, RED);
        if index == 0 {
            let _ = writeln!(out, "  {marker}  {painted}");
        } else {
            let _ = writeln!(out, "     {painted}");
        }
    }
    for rest in lines {
        let trimmed = rest.trim_end();
        if trimmed.is_empty() {
            let _ = writeln!(out);
            continue;
        }
        let indent = trimmed.len() - trimmed.trim_start().len();
        let body = trimmed.trim_start();
        // `checks::failure_summary` composes `problem: …` / `fix: …` under each numbered failure. Dimming the
        // label and hanging the wrap under the value keeps that column readable however long the remedy is —
        // and the remedy is the only line on this screen the reader is going to act on.
        match body
            .split_once(": ")
            .filter(|(label, _)| matches!(label.trim_end(), "problem" | "fix") && indent > 0)
        {
            Some((label, value)) => {
                // "problem:" is the wider of the two labels; padding to it puts both values in one column.
                let padded = format!("{:<9}", format!("{label}:"));
                let column = indent + 2 + padded.len();
                for (index, part) in wrap(value, state.width.saturating_sub(column + 1))
                    .iter()
                    .enumerate()
                {
                    if index == 0 {
                        let _ = writeln!(
                            out,
                            "  {:indent$}{}{part}",
                            "",
                            state.paint(&padded, DIM),
                            indent = indent
                        );
                    } else {
                        let _ = writeln!(out, "{:column$}{part}", "", column = column);
                    }
                }
            }
            None => {
                for (index, part) in wrap(body, state.width.saturating_sub(indent + 4))
                    .iter()
                    .enumerate()
                {
                    let hang = if index == 0 { indent } else { indent + 3 };
                    let _ = writeln!(out, "  {:hang$}{part}", "", hang = hang);
                }
            }
        }
    }
    let _ = writeln!(out);
    let _ = out.flush();
}

// ── the live line ───────────────────────────────────────────────────────────

/// Turn the running step into a settled line above the cursor. Its duration is the point: afterwards a
/// four-minute pull and a half-second check look identical, and neither the user nor whoever reads their
/// pasted transcript can tell which part was slow.
fn settle_current(state: &mut State) {
    if state.label.is_empty() {
        return;
    }
    erase(state);
    if let Some(at) = state.index {
        state.behind += state.plan[at].weight;
    }
    let took = human_duration(state.step_started.elapsed());
    // Padding is measured on the UNPAINTED line — colour escapes are zero-width on screen and would
    // otherwise push the duration off the right edge by however many bytes they happen to be.
    let bare = format!("  {}  {:>2}  {}", "x", state.ordinal, state.label);
    let pad = state
        .width
        .saturating_sub(1 + bare.chars().count() + took.chars().count());
    println!(
        "  {}  {}  {}{:pad$}{}",
        state.paint(state.glyphs.ok, GREEN),
        state.paint(&format!("{:>2}", state.ordinal), DIM),
        state.label,
        "",
        state.paint(&took, DIM),
        pad = pad
    );
    state.label.clear();
    state.detail.clear();
}

/// Print something ABOVE the live line: erase, write, redraw.
fn above(state: &mut State, text: &str) {
    erase(state);
    println!("{text}");
    repaint(state);
}

fn erase(state: &mut State) {
    if !state.live {
        return;
    }
    let mut out = std::io::stdout().lock();
    // Spaces rather than an erase-to-end-of-line escape: this is the one repaint that has to work on a
    // console that refused virtual-terminal processing, where an escape would print as literal text.
    let _ = write!(out, "\r{:width$}\r", "", width = state.width);
    let _ = out.flush();
    state.live = false;
}

fn repaint(state: &mut State) {
    if state.mode == Mode::Plain || state.suspended || state.label.is_empty() {
        return;
    }
    let spinner = state.glyphs.spinner[state.frame % state.glyphs.spinner.len()];
    let elapsed = human_duration(state.step_started.elapsed());
    let right = match remaining(state) {
        Some(left) if state.step_started.elapsed() >= Duration::from_secs(5) => {
            format!("{elapsed} · ~{left} left")
        }
        _ => elapsed,
    };
    let head = format!("  {spinner}  {:>2}  {}", state.ordinal, state.label);
    let middle = if state.detail.is_empty() {
        String::new()
    } else {
        format!("  ·  {}", state.detail)
    };
    // Budget: the line must never reach the last column, or a terminal wraps it and the carriage return
    // above no longer returns to its start.
    let budget = state.width.saturating_sub(1);
    let fixed = head.chars().count() + right.chars().count() + 1;
    let middle = truncate(&middle, budget.saturating_sub(fixed));
    let pad = budget.saturating_sub(fixed + middle.chars().count());
    let text = if state.color {
        let middle = if middle.is_empty() {
            String::new()
        } else {
            state.paint(&middle, DIM)
        };
        format!(
            "  {}  {}  {}{middle}{:pad$} {}",
            state.paint(spinner, CYAN),
            state.paint(&format!("{:>2}", state.ordinal), DIM),
            state.label,
            "",
            state.paint(&right, DIM),
            pad = pad
        )
    } else {
        format!("{head}{middle}{:pad$} {right}", "", pad = pad)
    };
    let mut out = std::io::stdout().lock();
    let _ = write!(out, "\r{text}");
    let _ = out.flush();
    state.live = true;
}

/// Repaint on a timer so a wait is never mistaken for a hang. Every wait in this binary blocks in a sleep
/// loop or inside a subprocess, so the tick cannot come from the flow itself; the thread is a daemon and
/// dies with the process.
fn start_spinner() {
    {
        let mut state = ui();
        if state.mode == Mode::Plain || state.spinning {
            return;
        }
        state.spinning = true;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(110));
        let mut state = ui();
        if !state.spinning {
            return;
        }
        state.frame = state.frame.wrapping_add(1);
        repaint(&mut state);
    });
}

// ── estimates ───────────────────────────────────────────────────────────────

/* A FRACTION, NOT A TALLY OF FINISHED LAYERS. Docker does not reliably print `Pull complete` for every layer
 * when it is not talking to a terminal — a real six-layer pull measured here reported three — so a count of
 * completions stalls partway and stays there, which reads as a stuck install during the exact minutes this
 * line exists to reassure through. Averaging each layer's own progress always advances, and the step's tick
 * is what says "finished"; the number itself never has to reach anything.
 *
 * Clamped monotonic against `floor` because the DENOMINATOR GROWS: docker announces layers as it discovers
 * them, so the honest average genuinely falls the moment a seventh appears, and a readout that goes backwards
 * costs more trust than the two points of precision it just bought. Capped below 100 for the same reason the
 * step estimate is: only the flow knows a step is done, and it has not said so yet. */
fn pull_percent(layers: &BTreeMap<String, f32>, floor: u32) -> u32 {
    if layers.is_empty() {
        return floor;
    }
    let sum: f32 = layers.values().sum();
    let percent = ((sum / layers.len() as f32) * 100.0).round() as u32;
    floor.max(percent.min(99))
}

/// Time left, as a human phrase, from the plan's remaining weight and the pace this run has actually kept.
/// Clamped, because one slow step on a fast machine (or the reverse) should nudge the estimate rather than
/// replace it — an estimate that swings is worse than a rough one that holds still. `None` while there is not
/// yet enough evidence to say anything, and below the threshold where a countdown stops helping.
fn estimate(total: u32, consumed: f32, elapsed: f32) -> Option<String> {
    if total == 0 || consumed < 1.0 {
        return None;
    }
    let pace = (elapsed / consumed).clamp(0.5, 3.0);
    let left = ((total as f32 - consumed) * pace).max(0.0);
    if left < 20.0 {
        return None;
    }
    Some(human_duration(Duration::from_secs_f32(left)))
}

/// How far into the running step we are, 0..1. Docker's layers when there are any — real progress through
/// the biggest download in the install — and otherwise the clock against this step's own weight, capped
/// short of the end, because a timer that reaches 100% is an estimate claiming a step is finished when the
/// only thing that knows is the flow, which has not said so.
fn step_fraction(state: &State) -> f32 {
    if !state.layers.is_empty() {
        let sum: f32 = state.layers.values().sum();
        return sum / state.layers.len() as f32;
    }
    let Some(at) = state.index else {
        return 0.0;
    };
    let weight = state.plan[at].weight as f32;
    if weight <= 0.0 {
        return 0.0;
    }
    (state.step_started.elapsed().as_secs_f32() / weight).min(0.9)
}

/// This run's own numbers, handed to the pure [`estimate`] above.
fn remaining(state: &State) -> Option<String> {
    let total: u32 = state.plan.iter().map(|step| step.weight).sum();
    let inside = state.plan[state.index?].weight as f32 * step_fraction(state);
    estimate(
        total,
        state.behind as f32 + inside,
        state.started.elapsed().as_secs_f32(),
    )
}

fn human_duration(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    if seconds >= 90 {
        let minutes = (seconds as f32 / 60.0).round() as u64;
        return format!("{minutes}m");
    }
    if seconds >= 10 {
        return format!("{seconds}s");
    }
    format!("{:.1}s", elapsed.as_secs_f32())
}

/// Fold `text` onto lines of at most `width`. Used for everything that SETTLES on the screen — a caution, a
/// check's note, a diagnosis — because truncating those loses the words that make them worth printing. Only
/// the live line truncates, and only because it is repainted and must never wrap.
///
/// A single word longer than the width is left to overflow: it is a URL or a container name, and breaking one
/// mid-token to protect a margin makes it unusable for the copy-paste it exists for.
fn wrap(text: &str, width: usize) -> Vec<String> {
    if width < 20 {
        return vec![text.to_string()];
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if current.is_empty() {
            current.push_str(word);
        } else if current.chars().count() + 1 + word.chars().count() <= width {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(std::mem::take(&mut current));
            current.push_str(word);
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    if limit <= 1 {
        return String::new();
    }
    let mut out: String = text.chars().take(limit - 1).collect();
    out.push('…');
    out
}

fn capitalize(text: &str) -> String {
    let trimmed = text.trim_end_matches(['…', '.', ' ']);
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/* The two lines docker brackets a pull with that say nothing the step's own label has not already said:
 * `stable: Pulling from intentic/sandbox` on the way in, and the fully-qualified reference echoed back on the
 * way out. Both are debris on a screen whose step already reads "Download the sandbox image", and the log
 * keeps them regardless.
 *
 * A bare token is the safe rule for the second: every line docker emits that a person needs — a status, a
 * digest, a warning, an "unauthorized" — is a sentence with spaces in it, so refusing only whitespace-free
 * lines can never swallow a diagnosis. */
fn is_pull_noise(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.contains(char::is_whitespace)
        || trimmed
            .split_once(": ")
            .is_some_and(|(_, rest)| rest.starts_with("Pulling from "))
}

/// How far through one layer each of docker's states is. `Downloading` and `Extracting` are the two that take
/// time; the rest are announcements either side of them. Spawned without a terminal docker cannot draw its
/// bars and prints one line per layer per state change instead, which is better for us than the bars: no
/// cursor tricks to undo, and a layer's last word is its state.
fn parse_layer(line: &str) -> Option<(String, f32)> {
    let (id, rest) = line.trim_end().split_once(": ")?;
    if id.len() < 6 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    // A state may be followed by docker's own progress detail ("Downloading [===>  ] 12MB/45MB").
    let state = rest.split_once(" [").map(|(head, _)| head).unwrap_or(rest);
    let done = match state.trim() {
        "Pulling fs layer" | "Waiting" => 0.0,
        "Downloading" => 0.15,
        "Verifying Checksum" | "Download complete" => 0.6,
        "Extracting" => 0.8,
        "Pull complete" | "Already exists" => 1.0,
        _ => return None,
    };
    Some((id.to_string(), done))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_lines_are_recognised_and_ordinary_output_is_not() {
        assert_eq!(
            parse_layer("6e3729cf69e0: Pull complete"),
            Some(("6e3729cf69e0".to_string(), 1.0))
        );
        assert_eq!(
            parse_layer("a1f1879bd7bf: Downloading [====>    ]  12.3MB/45.6MB"),
            Some(("a1f1879bd7bf".to_string(), 0.15))
        );
        assert_eq!(
            parse_layer("c4e6c4d4ab21: Already exists"),
            Some(("c4e6c4d4ab21".to_string(), 1.0))
        );
        // Everything that is not a layer must fall through to the terminal — an "unauthorized" here is the
        // whole diagnosis of a failed pull, and swallowing it would leave the user with a silent stop.
        assert_eq!(parse_layer("Status: Downloaded newer image for x"), None);
        assert_eq!(parse_layer("stable: Pulling from intentic/sandbox"), None);
        assert_eq!(parse_layer("Digest: sha256:6a1f0e4b"), None);
        assert_eq!(parse_layer("error: unauthorized"), None);
        assert_eq!(parse_layer(""), None);
        // A short or non-hex prefix is somebody's prose with a colon in it, not a layer.
        assert_eq!(parse_layer("note: Waiting"), None);
        assert_eq!(parse_layer("abc: Waiting"), None);
    }

    #[test]
    fn a_pulls_bracketing_lines_are_debris_and_its_diagnoses_are_not() {
        // What the step label already says.
        assert!(is_pull_noise("stable: Pulling from intentic/sandbox"));
        assert!(is_pull_noise("ghcr.io/intentic/sandbox:stable"));
        assert!(is_pull_noise("   "));
        // What a person needs. Swallowing any of these would turn a failed pull into a silent stop.
        assert!(!is_pull_noise("error: unauthorized"));
        assert!(!is_pull_noise("Status: Downloaded newer image for x"));
        assert!(!is_pull_noise("Digest: sha256:abc"));
        assert!(!is_pull_noise(
            "denied: requested access to the resource is denied"
        ));
        // A layer report is absorbed by the readout rather than by this rule — it has spaces.
        assert!(!is_pull_noise("6e3729cf69e0: Pull complete"));
    }

    #[test]
    fn durations_read_as_a_person_would_say_them() {
        assert_eq!(human_duration(Duration::from_millis(400)), "0.4s");
        assert_eq!(human_duration(Duration::from_secs(9)), "9.0s");
        assert_eq!(human_duration(Duration::from_secs(42)), "42s");
        assert_eq!(human_duration(Duration::from_secs(89)), "89s");
        assert_eq!(human_duration(Duration::from_secs(90)), "2m");
        assert_eq!(human_duration(Duration::from_secs(291)), "5m");
    }

    #[test]
    fn truncation_never_exceeds_its_budget() {
        // The live line is repainted with a carriage return; one character over the width wraps it and every
        // later repaint lands on the wrong row.
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello", 5), "hello");
        assert_eq!(truncate("hello", 4).chars().count(), 4);
        assert_eq!(truncate("hello", 1), "");
        assert_eq!(truncate("hello", 0), "");
        // Multi-byte characters are counted as characters, not bytes.
        assert_eq!(truncate("★★★★★", 3).chars().count(), 3);
    }

    fn layers(fractions: &[f32]) -> BTreeMap<String, f32> {
        fractions
            .iter()
            .enumerate()
            .map(|(index, done)| (format!("layer{index}"), *done))
            .collect()
    }

    #[test]
    fn the_pull_readout_advances_even_when_docker_under_reports() {
        // The measured case this exists for: six layers announced, only three ever reported `Pull complete`.
        // A completion tally shows "3 of 6" and freezes; the average keeps climbing off the other three.
        let stalled = layers(&[1.0, 1.0, 1.0, 0.6, 0.6, 0.8]);
        assert_eq!(pull_percent(&stalled, 0), 83);
        // Empty is not zero — it is "nothing measured yet", and must not drag a running readout back down.
        assert_eq!(pull_percent(&BTreeMap::new(), 42), 42);
    }

    #[test]
    fn the_pull_readout_never_goes_backwards_when_a_layer_appears() {
        // Docker announces layers as it discovers them, so the honest average FALLS the moment a new one
        // lands at zero. A progress readout that rewinds costs more trust than the precision it buys.
        let four_done = layers(&[1.0, 1.0]);
        let settled = pull_percent(&four_done, 0);
        assert_eq!(settled, 99, "two finished layers, capped below 100");
        let newcomer = layers(&[1.0, 1.0, 0.0]);
        assert_eq!(
            pull_percent(&newcomer, settled),
            settled,
            "a third layer at zero must not rewind the readout"
        );
    }

    #[test]
    fn the_pull_readout_stops_short_of_a_hundred() {
        // Only the flow knows a step finished, and the tick is what says so. A readout that reaches 100 while
        // the step is still running is the same lie as a timer that fills.
        assert_eq!(pull_percent(&layers(&[1.0, 1.0, 1.0]), 0), 99);
    }

    #[test]
    fn the_estimate_holds_still_rather_than_swinging() {
        // Half the work done in half the budgeted time: the remainder is quoted at the observed pace.
        assert_eq!(estimate(400, 200.0, 100.0).as_deref(), Some("2m"));
        // A machine three times slower than the plan expects is still only quoted at the 3x clamp, so one
        // stalled step cannot turn a five-minute install into an hour on screen.
        assert_eq!(estimate(400, 100.0, 6000.0).as_deref(), Some("15m"));
        // …and a machine far faster than the plan is floored at half, for the same reason in reverse: the
        // remaining 300 weight-seconds are quoted at 0.5x rather than the 0.01x this instant suggests.
        assert_eq!(estimate(400, 100.0, 1.0).as_deref(), Some("3m"));
    }

    #[test]
    fn the_estimate_stays_quiet_when_it_would_be_noise() {
        // Nothing consumed yet: any ratio here is division by almost nothing.
        assert_eq!(estimate(400, 0.0, 10.0), None);
        // No plan at all — the flows that announce steps without one still show a spinner, never a countdown.
        assert_eq!(estimate(0, 50.0, 10.0), None);
        // Under twenty seconds a countdown stops helping and starts being wrong on every repaint.
        assert_eq!(estimate(100, 95.0, 95.0), None);
    }

    #[test]
    fn wrapping_keeps_every_word_and_stays_inside_the_width() {
        let text = "the docker daemon is running, but this user can't talk to it right now";
        for width in [20, 32, 47, 80] {
            let lines = wrap(text, width);
            assert!(
                lines.iter().all(|line| line.chars().count() <= width),
                "width {width} overflowed: {lines:?}"
            );
            assert_eq!(
                lines.join(" "),
                text,
                "wrapping must not drop or reorder words at width {width}"
            );
        }
    }

    #[test]
    fn wrapping_leaves_an_unbreakable_token_whole() {
        // A URL or a container name is there to be copied; breaking one to protect a margin makes it useless.
        let long = "https://sandbox-3c469e9d6c58.intentic.dev/some/deep/path";
        assert_eq!(wrap(long, 30), vec![long.to_string()]);
        // A width too narrow to lay anything out is handed back untouched rather than shredded.
        assert_eq!(wrap("a b c", 5), vec!["a b c".to_string()]);
        assert_eq!(wrap("", 40), vec![String::new()]);
    }

    #[test]
    fn a_step_sentence_becomes_a_label_when_the_plan_does_not_carry_one() {
        assert_eq!(
            capitalize("creating the host SSH tunnel…"),
            "Creating the host SSH tunnel"
        );
        assert_eq!(capitalize("starting sandbox…"), "Starting sandbox");
        assert_eq!(capitalize(""), "");
    }
}
