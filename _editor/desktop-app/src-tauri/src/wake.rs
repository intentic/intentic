use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuItem, MenuItemBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::setup_link::{WakeArgs, WakeState};
use crate::windows::WORKSPACE;

/* THE WAKE WORD, HEARD WITH THE APP IN THE TRAY (2026-10-13).

The workspace's page can listen on the microphone for a wake word ("Leon" unless the reader named another) and does all
of the listening itself: the microphone, the audio worklet, the transcription, what a heard word starts. A browser tab
listens while it is open. This app's window spends most of its life closed to the tray, so the app's part is to keep
that page somewhere it can go on listening, and to say in the tray what it is doing:

- the page has the microphone without a prompt nobody would see (microphone.rs), and an audio context that starts with
  nobody there to click (windows.rs `BROWSER_ARGS`);
- the × hides the workspace rather than destroying it, as it always has, so a page that was listening goes on listening;
- a launch whose page was listening when the app last ran loads the workspace hidden (`resume_on_launch`), so it listens
  again after a restart with nothing on screen, a launch at sign-in included (autostart.rs). On Windows, that is all it
  takes. On Linux WebKitGTK answers no `getUserMedia` made while the window is off screen until the window is shown
  (measured on 2.54, 2026-10-13: the request waited, and was answered the moment the window came up), so there the page
  is ready and starts listening the first time the reader opens it; capture that began on screen goes on after the ×;
- the tray says what the page last said, "Listen for “Leon”" ticked while it is wanted, and pauses, resumes or switches
  it off by telling the page (`send`), which does it and says so again.

The page says what it is doing on `intentic://wake?state=…&word=…` whenever that changes (setup_link.rs `WakeArgs`), and
is told on `intentic-desktop-wake` with `{ do: "on" | "off" | "pause" | "resume", minutes? }`. The app keeps whether
listening is wanted, and the word, in `wake.json`, which is all the next launch needs; the page keeps its own settings.
The tray's rows come with "Open workspace", once an account has been seen (lib.rs `offer_workspace`): listening is the
workspace's, and an install that never signed in has no workspace to listen in. */

/// The word a page listens for until it says otherwise: the web's own default.
pub const DEFAULT_WORD: &str = "Leon";

/// Whether listening is wanted and for which word, as the page last said: what a launch reads to load the workspace
/// hidden (`resume_on_launch`) and what titles the tray's row before the page has said anything this run.
const FILE: &str = "wake.json";

/// The DOM event the page listens on, dispatched by `eval` like every other word the app says to a page.
const EVENT: &str = "intentic-desktop-wake";

/// How long a pause from the tray holds the listening.
pub const PAUSE_MINUTES: u32 = 60;

/// How often a word the page has not answered yet is said again, and how many times. A page loading in the tray
/// (`send` with no workspace) or reloading has no listener for a while, and a word dispatched before it has one is lost;
/// the page answers a word that changes something by saying what it is doing now (`agrees`). Every word means the same
/// thing said twice, so saying it again costs nothing. A minute covers a cold load of the page.
const SAY_AGAIN_EVERY: Duration = Duration::from_secs(3);
const SAY_AGAIN_TIMES: u32 = 20;

/// `wake.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stored {
    /// Listening is wanted: the page said anything but `off`.
    pub on: bool,
    pub word: String,
}

impl Default for Stored {
    fn default() -> Self {
        Stored {
            on: false,
            word: DEFAULT_WORD.to_string(),
        }
    }
}

/// A file read back as the page would have said it: a word out of shape (a hand edit) is the default one.
fn stored_or_default(stored: Option<Stored>) -> Stored {
    match stored {
        Some(stored) if crate::setup_link::is_wake_word(&stored.word) => stored,
        Some(stored) => Stored {
            on: stored.on,
            word: DEFAULT_WORD.to_string(),
        },
        None => Stored::default(),
    }
}

/// What the app tells the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    On,
    Off,
    Pause { minutes: u32 },
    Resume,
}

/// The event's `detail`, as the page reads it.
fn detail(command: Command) -> serde_json::Value {
    match command {
        Command::On => serde_json::json!({ "do": "on" }),
        Command::Off => serde_json::json!({ "do": "off" }),
        Command::Pause { minutes } => serde_json::json!({ "do": "pause", "minutes": minutes }),
        Command::Resume => serde_json::json!({ "do": "resume" }),
    }
}

/// The script that tells the workspace's page `command`: only a page of the app's own origin hears it, so the offline
/// page (offline.rs) or a page still on its way somewhere else is told nothing. The origin rides as a JSON string,
/// which is a JavaScript string literal, as in windows.rs `open_in_place`.
fn command_script(origin: &str, command: Command) -> String {
    let origin = serde_json::to_string(origin).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(() => {{ if (location.origin === {origin}) {{ window.dispatchEvent(new CustomEvent('{EVENT}', {{ detail: {} }})); }} }})();",
        detail(command)
    )
}

/// Whether the page saying `state` has done what `command` asked, or said something that makes asking again pointless:
/// a page that is not listening has nothing to pause, and one that is not paused nothing to resume.
fn agrees(command: Command, state: WakeState) -> bool {
    match command {
        Command::On => state != WakeState::Off,
        Command::Off => state == WakeState::Off,
        Command::Pause { .. } => state != WakeState::Listening,
        Command::Resume => state != WakeState::Paused,
    }
}

/// The state the tray shows: what the page said this run, or before it has said anything, what it said when the app
/// last ran (a page that was listening is being loaded to listen again, `resume_on_launch`).
fn shown_state(reported: Option<WakeState>, stored_on: bool) -> WakeState {
    reported.unwrap_or(if stored_on {
        WakeState::Listening
    } else {
        WakeState::Off
    })
}

/// "Listen for “Leon”". An `&` in the word is doubled: both menus read a single one as the mark of an access key.
fn listen_text(word: &str) -> String {
    format!("Listen for “{}”", word.replace('&', "&&"))
}

/// The second row's words and whether it can be pressed, for the state the tray shows.
fn pause_row(state: WakeState) -> (&'static str, bool) {
    match state {
        WakeState::Listening => ("Pause listening for 1 hour", true),
        WakeState::Paused => ("Resume listening", true),
        // The browser holds the audio until somebody clicks in the page: the row takes them there.
        WakeState::Blocked => ("Click to resume listening", true),
        WakeState::Off | WakeState::Error => ("Pause listening for 1 hour", false),
    }
}

/// What a press on the second row does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PauseAction {
    Tell(Command),
    /// The workspace on screen and focused, for the click the browser waits for.
    ShowWorkspace,
    Nothing,
}

fn pause_action(state: WakeState) -> PauseAction {
    match state {
        WakeState::Listening => PauseAction::Tell(Command::Pause {
            minutes: PAUSE_MINUTES,
        }),
        WakeState::Paused => PauseAction::Tell(Command::Resume),
        WakeState::Blocked => PauseAction::ShowWorkspace,
        WakeState::Off | WakeState::Error => PauseAction::Nothing,
    }
}

/// What the first row's press asks for: listening when it is off, and off whatever else it is doing.
fn listen_command(state: WakeState) -> Command {
    if state == WakeState::Off {
        Command::On
    } else {
        Command::Off
    }
}

/// The app's whole record of the wake word.
pub struct Wake(Mutex<Standing>);

struct Standing {
    path: PathBuf,
    stored: Stored,
    /// What the page said this run; none until it has.
    reported: Option<WakeState>,
    /// The word said to the page and not answered yet, with the count of the saying it belongs to: a newer word
    /// replaces it, and the older one's repeats stop.
    pending: Option<(Command, u64)>,
    said: u64,
}

impl Wake {
    pub fn load(app: &AppHandle) -> tauri::Result<Wake> {
        let path = app.path().app_config_dir()?.join(FILE);
        let stored = stored_or_default(crate::state::read_json(&path));
        Ok(Wake(Mutex::new(Standing {
            path,
            stored,
            reported: None,
            pending: None,
            said: 0,
        })))
    }

    fn state(&self) -> WakeState {
        let standing = self.0.lock().unwrap();
        shown_state(standing.reported, standing.stored.on)
    }
}

/* THE TRAY'S TWO ROWS — retitled in place, never rebuilt: a rebuilt tray menu flickers on Windows (lib.rs). */

pub struct TrayWake {
    pub listen: CheckMenuItem<Wry>,
    pub pause: MenuItem<Wry>,
}

/// The menu ids lib.rs `create_tray` routes here.
pub const LISTEN_ROW: &str = "wake-listen";
pub const PAUSE_ROW: &str = "wake-pause";

/// Both rows, as the record stands. Not in the menu yet: they come with "Open workspace" (lib.rs `offer_workspace`).
pub fn tray_rows(app: &AppHandle) -> tauri::Result<TrayWake> {
    let (word, state) = {
        let wake = app.state::<Wake>();
        let standing = wake.0.lock().unwrap();
        (
            standing.stored.word.clone(),
            shown_state(standing.reported, standing.stored.on),
        )
    };
    let (pause_text, pause_enabled) = pause_row(state);
    Ok(TrayWake {
        listen: CheckMenuItemBuilder::with_id(LISTEN_ROW, listen_text(&word))
            .checked(state != WakeState::Off)
            .build(app)?,
        pause: MenuItemBuilder::with_id(PAUSE_ROW, pause_text)
            .enabled(pause_enabled)
            .build(app)?,
    })
}

/// Both rows put back to what the record says.
fn refresh_tray(app: &AppHandle) {
    let (word, state) = {
        let wake = app.state::<Wake>();
        let standing = wake.0.lock().unwrap();
        (
            standing.stored.word.clone(),
            shown_state(standing.reported, standing.stored.on),
        )
    };
    let Some(tray) = app.try_state::<TrayWake>() else {
        return;
    };
    let (pause_text, pause_enabled) = pause_row(state);
    let _ = tray.listen.set_text(listen_text(&word));
    let _ = tray.listen.set_checked(state != WakeState::Off);
    let _ = tray.pause.set_text(pause_text);
    let _ = tray.pause.set_enabled(pause_enabled);
}

/// "Listen for “…”" was pressed. The menu has already ticked or unticked the row itself; it is put back to what the
/// page last said, and changes when the page says it did what it was told.
pub fn listen_pressed(app: &AppHandle) {
    let state = app.state::<Wake>().state();
    refresh_tray(app);
    send(app, listen_command(state));
}

/// The second row was pressed: pause, resume, or the workspace brought up for the click the browser waits for.
pub fn pause_pressed(app: &AppHandle) {
    match pause_action(app.state::<Wake>().state()) {
        PauseAction::Tell(command) => send(app, command),
        PauseAction::ShowWorkspace => crate::windows::show_workspace(app),
        PauseAction::Nothing => {}
    }
}

/* WHAT THE PAGE SAYS, AND WHAT IT IS TOLD. */

/// The page said what its listening is doing (`intentic://wake`, from the workspace only): kept for the tray, written
/// to `wake.json` when what the next launch needs changed, and an unanswered word it agrees with stops being repeated.
pub fn reported(app: &AppHandle, args: WakeArgs) {
    {
        let wake = app.state::<Wake>();
        let mut standing = wake.0.lock().unwrap();
        standing.reported = Some(args.state);
        if standing
            .pending
            .is_some_and(|(command, _)| agrees(command, args.state))
        {
            standing.pending = None;
        }
        let stored = Stored {
            on: args.state != WakeState::Off,
            word: args.word,
        };
        // Written under the lock, so two reports in a row land on disk in the order they came.
        if standing.stored != stored {
            crate::state::write_json(&standing.path, &stored);
            standing.stored = stored;
        }
    }
    refresh_tray(app);
}

/// Tell the workspace's page `command`, and again every few seconds until it answers in agreement or a minute has
/// gone (`SAY_AGAIN_EVERY`). With no workspace there is no page to tell: `on` loads it hidden first, `off` is written
/// down for the next launch, and a pause or a resume has nothing to act on.
pub fn send(app: &AppHandle, command: Command) {
    if app.get_webview_window(WORKSPACE).is_none() {
        match command {
            Command::On => crate::windows::load_workspace_hidden(app),
            Command::Off => return off_unheard(app),
            Command::Pause { .. } | Command::Resume => return,
        }
    }
    let origin = url::Url::parse(&app.state::<crate::state::AppState>().app_url())
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    let script = command_script(&origin, command);
    // Pending before it is said, so an answer that comes straight back finds it.
    let said = {
        let wake = app.state::<Wake>();
        let mut standing = wake.0.lock().unwrap();
        standing.said += 1;
        standing.pending = Some((command, standing.said));
        standing.said
    };
    if let Some(window) = app.get_webview_window(WORKSPACE) {
        let _ = window.eval(&script);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..SAY_AGAIN_TIMES {
            tokio::time::sleep(SAY_AGAIN_EVERY).await;
            let unanswered = matches!(
                app.state::<Wake>().0.lock().unwrap().pending,
                Some((_, pending)) if pending == said
            );
            if !unanswered {
                return;
            }
            if let Some(window) = app.get_webview_window(WORKSPACE) {
                let _ = window.eval(&script);
            }
        }
        let wake = app.state::<Wake>();
        let mut standing = wake.0.lock().unwrap();
        if matches!(standing.pending, Some((_, pending)) if pending == said) {
            standing.pending = None;
        }
    });
}

/// "Off" with no page to say it to: there is nothing listening, so it is only what the next launch loads.
fn off_unheard(app: &AppHandle) {
    {
        let wake = app.state::<Wake>();
        let mut standing = wake.0.lock().unwrap();
        standing.reported = Some(WakeState::Off);
        if standing.stored.on {
            standing.stored.on = false;
            crate::state::write_json(&standing.path, &standing.stored);
        }
    }
    refresh_tray(app);
}

/// A launch: the workspace loaded hidden, after `after`, when its page was listening when the app last ran and an
/// account has been seen here. The page picks its listening up from its own settings; nothing is said to it, since a
/// word from here could end a pause it is keeping. A launch that put a window on screen waits a few seconds, so that
/// window's first paint is not shared with a second page.
pub fn resume_on_launch(app: &AppHandle, after: Duration) {
    let wanted = app.state::<Wake>().0.lock().unwrap().stored.on;
    if !wanted || !app.state::<crate::state::AppState>().account_seen() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(after).await;
        crate::windows::load_workspace_hidden(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [WakeState; 5] = [
        WakeState::Off,
        WakeState::Listening,
        WakeState::Paused,
        WakeState::Blocked,
        WakeState::Error,
    ];

    #[test]
    fn the_page_hears_one_event_with_its_command_and_only_on_the_apps_origin() {
        assert_eq!(
            command_script("https://app.intentic.dev", Command::Pause { minutes: 60 }),
            "(() => { if (location.origin === \"https://app.intentic.dev\") { window.dispatchEvent(new CustomEvent('intentic-desktop-wake', { detail: {\"do\":\"pause\",\"minutes\":60} })); } })();"
        );
        assert!(command_script("https://a", Command::On).contains(r#"{"do":"on"}"#));
        assert!(command_script("https://a", Command::Off).contains(r#"{"do":"off"}"#));
        assert!(command_script("https://a", Command::Resume).contains(r#"{"do":"resume"}"#));
        // An origin cannot end the statement it rides in.
        let script = command_script("https://a\"); alert(1); (\"", Command::On);
        assert!(
            script.contains(r#"location.origin === "https://a\"); alert(1); (\"""#),
            "{script}"
        );
    }

    #[test]
    fn the_listen_row_is_ticked_unless_the_page_is_off_and_names_the_word() {
        assert_eq!(listen_text("Leon"), "Listen for “Leon”");
        assert_eq!(listen_text("Rock & Roll"), "Listen for “Rock && Roll”");
        for state in ALL {
            assert_eq!(
                listen_command(state),
                if state == WakeState::Off {
                    Command::On
                } else {
                    Command::Off
                },
                "{state:?}"
            );
        }
    }

    #[test]
    fn the_second_row_pauses_resumes_or_takes_the_reader_to_the_click_the_browser_waits_for() {
        assert_eq!(
            pause_row(WakeState::Listening),
            ("Pause listening for 1 hour", true)
        );
        assert_eq!(
            pause_action(WakeState::Listening),
            PauseAction::Tell(Command::Pause { minutes: 60 })
        );
        assert_eq!(pause_row(WakeState::Paused), ("Resume listening", true));
        assert_eq!(
            pause_action(WakeState::Paused),
            PauseAction::Tell(Command::Resume)
        );
        assert_eq!(
            pause_row(WakeState::Blocked),
            ("Click to resume listening", true)
        );
        assert_eq!(pause_action(WakeState::Blocked), PauseAction::ShowWorkspace);
        for state in [WakeState::Off, WakeState::Error] {
            assert!(!pause_row(state).1, "{state:?}");
            assert_eq!(pause_action(state), PauseAction::Nothing);
        }
    }

    /// Before the page has said anything this run, the tray says what it said when the app last ran.
    #[test]
    fn the_tray_starts_from_what_the_last_run_was_told() {
        assert_eq!(shown_state(None, false), WakeState::Off);
        assert_eq!(shown_state(None, true), WakeState::Listening);
        assert_eq!(
            shown_state(Some(WakeState::Blocked), false),
            WakeState::Blocked
        );
        assert_eq!(shown_state(Some(WakeState::Off), true), WakeState::Off);
    }

    #[test]
    fn a_word_is_said_again_until_the_page_answers_in_agreement() {
        assert!(agrees(Command::On, WakeState::Listening));
        assert!(agrees(Command::On, WakeState::Blocked));
        assert!(!agrees(Command::On, WakeState::Off));
        assert!(agrees(Command::Off, WakeState::Off));
        assert!(!agrees(Command::Off, WakeState::Paused));
        assert!(agrees(Command::Pause { minutes: 60 }, WakeState::Paused));
        assert!(!agrees(
            Command::Pause { minutes: 60 },
            WakeState::Listening
        ));
        assert!(agrees(Command::Resume, WakeState::Listening));
        assert!(!agrees(Command::Resume, WakeState::Paused));
    }

    #[test]
    fn the_file_holds_whether_listening_is_wanted_and_the_word() {
        let stored = Stored {
            on: true,
            word: "Leon".into(),
        };
        assert_eq!(
            serde_json::to_value(&stored).unwrap(),
            serde_json::json!({ "on": true, "word": "Leon" })
        );
        assert_eq!(stored_or_default(Some(stored.clone())), stored);
        assert_eq!(stored_or_default(None), Stored::default());
        assert_eq!(Stored::default().word, "Leon");
        assert!(!Stored::default().on);
        // A hand-edited word the tray could not show is the default one; whether listening is wanted stands.
        assert_eq!(
            stored_or_default(Some(Stored {
                on: true,
                word: "x".repeat(41)
            })),
            Stored {
                on: true,
                word: "Leon".into()
            }
        );
    }
}
