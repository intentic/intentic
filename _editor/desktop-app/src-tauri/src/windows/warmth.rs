use super::scripts::open_in_place;
use super::{build_workspace, WORKSPACE};
use crate::state::AppState;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};

/* THE WORKSPACE, PUT UP AHEAD OF ITS OPEN (2026-10-22) — so "Open" is the page on screen, never its loading.
 *
 * A folder's new sandbox used to say it was ready, and its Open then built the workspace's page from nothing in front of
 * the reader: the app's bundle, the sign-in, the sandbox's list and its first connection, seconds of a loading screen
 * after being told it was done. Now the folder's setup has the page loaded out of sight, at the folder's own address,
 * as soon as the sandbox answers end to end (folder_setup.rs), and calls the folder ready only once the page says it
 * shows that sandbox (`intentic://window?do=shown`, the web's SandboxGate.vue), or after [`WARM_FOR`] without a word.
 * Open is then [`show_workspace_over`] swapping in a page that is already drawn. */

/// What the workspace's page was put up for, and what it last said it shows.
#[derive(Debug, Default)]
pub(super) struct Warm {
    /// The sandbox the page was sent to ahead of its open.
    sandbox: Option<String>,
    /// The address it was sent to: an open of the same one swaps the page in without telling it anything.
    path: Option<String>,
    /// The sandbox the page last said it shows, connected and drawn. Cleared whenever the page is sent anywhere else.
    shown: Option<String>,
}

impl Warm {
    pub(super) fn clear(&mut self) {
        *self = Warm::default();
    }

    /// Whether an open of `path` has to tell the page where to go: not when it was put up there ahead of this open.
    /// Either way the open uses it up: from here on the page is the reader's, and goes wherever they take it. Pure.
    pub(super) fn must_tell(&mut self, path: &str) -> bool {
        let there = self.path.as_deref() == Some(path);
        self.clear();
        !there
    }
}

pub(super) static WARM: LazyLock<Mutex<Warm>> = LazyLock::new(Mutex::default);

/// How long a folder's setup waits for the page put up ahead to say it shows the sandbox, before calling the folder
/// ready anyway: a page older than this app says nothing, and one that cannot connect is the workspace's to explain.
pub const WARM_FOR: Duration = Duration::from_secs(25);

/// How the workspace's page stands for `sandbox`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Warmth {
    /// Not put up for it: an open builds or routes the page as it always did.
    Cold,
    /// Put up for it, and not yet saying it shows it.
    Warming,
    /// Says it shows it, connected and drawn.
    Shown,
}

pub fn warmth(sandbox: &str) -> Warmth {
    let held = WARM.lock().unwrap();
    if held.shown.as_deref() == Some(sandbox) {
        Warmth::Shown
    } else if held.sandbox.as_deref() == Some(sandbox) {
        Warmth::Warming
    } else {
        Warmth::Cold
    }
}

/// Put the workspace's page up out of sight at `path` (a folder's sandbox, project.rs `project_path`), for `sandbox`:
/// built there when the frame has none, told to go there when it has one nobody is looking at. A page on screen is the
/// reader's and is left alone, and so is one already put up for the same address. Whether it was put up.
pub fn warm_workspace(app: &AppHandle, sandbox: &str, path: &str) -> bool {
    let path = crate::found::with_found(app, path);
    {
        let held = WARM.lock().unwrap();
        if held.sandbox.as_deref() == Some(sandbox) && held.path.as_deref() == Some(path.as_str()) {
            return true;
        }
    }
    let state = app.state::<AppState>();
    let base = state.app_url();
    let origin = url::Url::parse(&base)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    let target = format!("{}{path}", base.trim_end_matches('/'));
    match crate::frame::face(app, WORKSPACE) {
        Some(_) if crate::frame::shown() == Some(WORKSPACE) && crate::frame::on_screen(app) => {
            return false
        }
        Some(face) => {
            if face.eval(open_in_place(&origin, &path, &target)).is_err() {
                return false;
            }
        }
        None => {
            let Ok(url) = target.parse::<Url>() else {
                return false;
            };
            if build_workspace(app, url).is_none() {
                return false;
            }
        }
    }
    *WARM.lock().unwrap() = Warm {
        sandbox: Some(sandbox.to_string()),
        path: Some(path),
        shown: None,
    };
    true
}

/// The workspace's page says it shows `sandbox`, connected and drawn: a folder whose setup waited on it is ready.
pub(super) fn workspace_shown(app: &AppHandle, sandbox: String) {
    WARM.lock().unwrap().shown = Some(sandbox.clone());
    crate::folder_setup::workspace_shown(app, &sandbox);
}

#[cfg(test)]
mod tests {
    use super::*;

    /* A PAGE PUT UP AHEAD OF ITS OPEN IS SWAPPED IN AS IT IS, ONCE (2026-10-22). */
    #[test]
    fn an_open_of_the_address_the_page_was_put_up_at_tells_it_nothing_and_uses_it_up() {
        let mut warm = Warm {
            sandbox: Some("sbx".to_string()),
            path: Some("/?sandbox=sbx&project=shop".to_string()),
            shown: Some("sbx".to_string()),
        };
        assert!(!warm.must_tell("/?sandbox=sbx&project=shop"));
        // From then on the page is the reader's: the next open of the same address routes it as every open did.
        assert!(warm.must_tell("/?sandbox=sbx&project=shop"));
    }

    #[test]
    fn an_open_of_anywhere_else_tells_the_page_and_forgets_what_it_said() {
        let mut warm = Warm {
            sandbox: Some("sbx".to_string()),
            path: Some("/?sandbox=sbx&project=shop".to_string()),
            shown: Some("sbx".to_string()),
        };
        assert!(warm.must_tell("/?sandbox=sbx&project=shop&task=abc"));
        assert_eq!(warm.shown, None);
        assert_eq!(warm.sandbox, None);
    }
}
