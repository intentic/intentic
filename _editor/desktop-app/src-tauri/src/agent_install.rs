//! THE MACHINE AGENT, PUT ON THIS COMPUTER AHEAD OF ITS FIRST SANDBOX (2026-10-22).
//!
//! A folder's sandbox needs `intentic-machine` on this computer to sync the folder, and a computer that never had one
//! downloaded it in the middle of the folder's first setup, inside its sync step (the agent's ~42 MB, which the
//! desktop-sync step's 46 s median is mostly made of on a fresh computer). So at launch, a computer with no agent has
//! one put in place, in the background, by the same bundled sync script a setup runs, told to fetch the agent and stop
//! (`INTENTIC_AGENT_ONLY=1`: nothing is redeemed, enrolled or started). A setup that starts while it runs waits for it
//! ([`wait`]), since both would write the same partial download. Nothing depends on it: one that fails leaves the
//! setup's own script to fetch the agent as it always has.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::scripts::{self, Host, ScriptRun};

/// The run's id: what a setup waits on.
pub const RUN: &str = "agent-install";

/// How long after launch it starts: behind the window, the check and the image's own download starting.
const START_DELAY: Duration = Duration::from_secs(5);

/// How long a setup waits for it at most. The download it saves is the setup's own anyway, so a slow one only moves
/// where the wait is; this bound is for one that hangs.
const WAIT_AT_MOST: Duration = Duration::from_secs(5 * 60);

/// One per run of this app.
static STARTED: AtomicBool = AtomicBool::new(false);

/// Where this computer's agent is, as its installer puts it, under `home`.
fn installed_at(host: Host, home: Option<&str>) -> Option<String> {
    home.filter(|home| !home.is_empty()).and_then(|home| {
        scripts::sync_agent_candidates(host, Some(home))
            .into_iter()
            .next()
    })
}

/// Whether to put the agent here now: none at its installed place, and no setup running that fetches one itself. Pure.
pub fn wanted(installed: bool, setup_running: bool) -> bool {
    !installed && !setup_running
}

/// The run: the bundled sync script, with the app's own environment and told to fetch the agent alone.
pub fn script(host: Host, version: &str) -> ScriptRun {
    let mut env = crate::commands::app_env(version);
    env.push(("INTENTIC_AGENT_ONLY".into(), "1".into()));
    ScriptRun {
        file: host.script("sync.sh", "sync.ps1"),
        args: Vec::new(),
        env,
        elevate: false,
        host,
    }
}

/// At launch (lib.rs): put the agent in place, off this thread, when this computer has none.
pub fn begin(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(START_DELAY);
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok();
        let host = Host::current();
        let installed =
            installed_at(host, home.as_deref()).is_some_and(|path| Path::new(&path).is_file());
        let setup_running =
            scripts::is_running(crate::commands::SETUP_RUN) || crate::folder_setup::running();
        if !wanted(installed, setup_running) || STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(error) = scripts::run(&app, RUN, script(host, crate::commands::VERSION)) {
            eprintln!("intentic: the machine agent was not put in place ahead ({error}); a setup fetches it itself");
        }
    });
}

/// A setup about to start waits for the agent's download, when one runs, rather than starting a second one beside it.
pub fn wait() {
    let since = Instant::now();
    while scripts::is_running(RUN) && since.elapsed() < WAIT_AT_MOST {
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_is_put_in_place_only_on_a_computer_without_one_and_with_no_setup_fetching_it() {
        assert!(wanted(false, false));
        assert!(!wanted(true, false));
        // A setup running fetches its own: a second download beside it would write the same partial file.
        assert!(!wanted(false, true));
    }

    #[test]
    fn it_runs_the_bundled_sync_script_told_to_fetch_the_agent_alone() {
        let run = script(Host::Windows, "1.2.3");
        assert_eq!(run.file, "sync.ps1");
        assert!(run.args.is_empty());
        assert!(!run.elevate);
        let env = |name: &str| {
            run.env
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(env("INTENTIC_AGENT_ONLY"), Some("1"));
        // No sandbox to set up: none of a setup's own values ride along.
        assert_eq!(env("SANDBOX_URL"), None);
        assert_eq!(env("PAIR_TOKEN"), None);
        assert_eq!(script(Host::Unix, "1.2.3").file, "sync.sh");
    }

    #[test]
    fn the_agent_is_looked_for_where_its_installer_puts_it() {
        assert_eq!(
            installed_at(Host::Windows, Some("C:\\Users\\Ada")).as_deref(),
            Some("C:\\Users\\Ada\\.intentic\\machine\\bin\\intentic-machine.exe")
        );
        // No home, no place to look: never the bare name a PATH lookup would need running to answer.
        assert_eq!(installed_at(Host::Unix, None), None);
        assert_eq!(installed_at(Host::Unix, Some("")), None);
    }
}
