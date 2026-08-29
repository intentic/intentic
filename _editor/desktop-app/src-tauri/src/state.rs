use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::setup_link::{RecreateArgs, SetupArgs, SyncArgs};

/* THE TWO ORIGINS, AND THEY ARE NOT THE SAME HOST.
 *
 * `APP_URL` is the SPA — the page the workspace window loads, and the origin the daemon must emit CORS for.
 * `PLATFORM_URL` is the platform's API, where a setup code is redeemed (`POST /setup/claim`) and where the
 * daemon announces itself once it boots.
 *
 * Naming both is not tidiness. The platform default used to be APP_URL, so every desktop setup ran
 * `connect.ps1` with `PLATFORM_URL=https://app.intentic.dev`, the claim POSTed at a static site, and the run
 * died on `HTTP 405 Method Not Allowed` right after "redeeming the setup code" — which reads as a bad code
 * rather than a wrong host. connect.sh had already met this and special-cases a 405 to say so in words. The
 * scripts' own default was correct the whole time; the app overrode it with something worse. */
pub const APP_URL: &str = "https://app.intentic.dev";
pub const PLATFORM_URL: &str = "https://api.intentic.dev";

/// What the workspace window's × does — the two answers its confirmation offers (windows.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    /// The window steps aside and the app stays up, reachable from the tray.
    Tray,
    /// The close ends the app, exactly as the tray menu's Quit does.
    Quit,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The workspace SPA origin. Unset ⇒ INTENTIC_APP_URL env ⇒ [`APP_URL`].
    pub app_url: Option<String>,
    /// The platform API origin setup codes are claimed against. Unset ⇒ INTENTIC_PLATFORM_URL env ⇒
    /// [`PLATFORM_URL`] — never the app origin, which answers a claim POST with 405.
    pub platform_url: Option<String>,
}

/// A setup parked across a Windows restart. See [`AppState::park_setup`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedSetup {
    pub args: SetupArgs,
    /// Unix seconds. The point of writing it down: after a restart there is nothing else left that knows how
    /// long ago this was, and the setup code inside expires.
    pub saved_at: u64,
}

pub struct AppState {
    config_dir: PathBuf,
    pub settings: Mutex<Settings>,
    /* A request waiting for the launcher UI to pick up. Parked in state rather than carried on the event,
     * because the link that creates it is also what OPENS the launcher window — an event emitted alongside
     * would fire before that window's listener exists. The launcher reads these on mount and on the bare
     * notification, so both orderings land. */
    pub pending: Mutex<Option<SetupArgs>>,
    pub pending_recreate: Mutex<Option<RecreateArgs>>,
    /// A desktop-sync enrollment the SPA handed over (`intentic://sync`), waiting for the launcher face to
    /// ask for the folder and run it. Same taken-not-read contract as the two above.
    pub pending_sync: Mutex<Option<SyncArgs>>,
    /// slug → display name, ours to remember: docker knows only container names, and the name the user typed
    /// into the SPA never reaches the machine any other way.
    names: Mutex<BTreeMap<String, String>>,
    /// Minted on first read, then held for the process — see [`AppState::install_id`].
    install_id: Mutex<Option<String>>,
}

impl AppState {
    pub fn load(app: &AppHandle) -> tauri::Result<AppState> {
        let config_dir = app.path().app_config_dir()?;
        std::fs::create_dir_all(&config_dir)?;
        let settings = read_json(&config_dir.join("settings.json")).unwrap_or_default();
        let names = read_json(&config_dir.join("sandboxes.json")).unwrap_or_default();
        Ok(AppState {
            config_dir,
            settings: Mutex::new(settings),
            pending: Mutex::new(None),
            pending_recreate: Mutex::new(None),
            pending_sync: Mutex::new(None),
            names: Mutex::new(names),
            install_id: Mutex::new(None),
        })
    }

    pub fn app_url(&self) -> String {
        let configured = self.settings.lock().unwrap().app_url.clone();
        configured
            .or_else(|| std::env::var("INTENTIC_APP_URL").ok())
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| APP_URL.into())
    }

    pub fn platform_url(&self) -> String {
        let configured = self.settings.lock().unwrap().platform_url.clone();
        configured
            .or_else(|| std::env::var("INTENTIC_PLATFORM_URL").ok())
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| PLATFORM_URL.into())
    }

    pub fn save_settings(&self, settings: Settings) {
        *self.settings.lock().unwrap() = settings.clone();
        write_json(&self.config_dir.join("settings.json"), &settings);
    }

    /// What a close should do without asking again — `None` until the user has ticked "always do this".
    ///
    /// Deliberately NOT a [`Settings`] field: the launcher UI saves that struct wholesale, so changing an
    /// origin there would throw away an answer the user has already given and put the question back. An
    /// unreadable or unwritable file answers `None`, which is the question returning rather than a wrong × —
    /// the one failure mode here that cannot surprise anybody.
    pub fn close_action(&self) -> Option<CloseAction> {
        read_json(&self.close_action_path())
    }

    pub fn remember_close_action(&self, action: CloseAction) {
        write_json(&self.close_action_path(), &action);
    }

    fn close_action_path(&self) -> PathBuf {
        self.config_dir.join("close-action.json")
    }

    /* A SETUP THAT A RESTART INTERRUPTED — the one piece of this app's state that has to outlive the process
     * by design rather than by accident.
     *
     * Turning WSL2 on is the ordinary first step of a Windows install and it does nothing until the machine
     * reboots. Everything else this app parks lives in `pending`, in memory, which is exactly right for a
     * handover from a browser tab and exactly wrong here: the reboot is the point.
     *
     * On disk, with the time it was written, because the setup code inside it expires thirty minutes after
     * the platform minted it and a Windows feature install plus a restart can spend most of that. The age is
     * what lets the window say "your code expired while your PC restarted" instead of failing at the claim
     * with something that reads like a bad code. */
    pub fn park_setup(&self, args: &SetupArgs) {
        let parked = ParkedSetup {
            args: args.clone(),
            saved_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_secs())
                .unwrap_or(0),
        };
        write_json(&self.parked_setup_path(), &parked);
    }

    pub fn parked_setup(&self) -> Option<ParkedSetup> {
        read_json(&self.parked_setup_path())
    }

    /// Taken rather than left: a resume that has been offered has been offered, and a file that survives it
    /// would re-open the same card on every launch from here on.
    pub fn clear_parked_setup(&self) {
        let _ = std::fs::remove_file(self.parked_setup_path());
    }

    fn parked_setup_path(&self) -> PathBuf {
        self.config_dir.join("resume-setup.json")
    }

    /* THE ONE THING THAT TIES THIS APP'S TWO FACES TOGETHER IN ANALYTICS.
     *
     * The launcher and the workspace are separate webviews with separate storage, so a product event from the
     * install screen and one from the SPA a minute later have nothing in common — different anonymous ids,
     * two unrelated strangers. Both are handed THIS value instead: the launcher sends its events under it, and
     * the SPA carries it as a property, so the install a person ran and the workspace they landed in can be
     * read as one story.
     *
     * A random id per install and nothing else — never a hostname, a username or a machine fingerprint. It
     * identifies an installation of this app, which is what the question "did the install finish" is about,
     * and it is per-OS-user already because that is where the config dir lives.
     *
     * Minted on first read and cached for the process, so a config dir that has gone read-only produces one
     * id for this run rather than a fresh one per event — degraded, but not noise.
     */
    pub fn install_id(&self) -> String {
        let mut cached = self.install_id.lock().unwrap();
        if let Some(id) = cached.as_ref() {
            return id.clone();
        }
        let path = self.config_dir.join("install-id.json");
        let id = read_json::<String>(&path).unwrap_or_else(|| {
            let minted = uuid::Uuid::new_v4().to_string();
            write_json(&path, &minted);
            minted
        });
        *cached = Some(id.clone());
        id
    }

    pub fn name_of(&self, slug: &str) -> Option<String> {
        self.names.lock().unwrap().get(slug).cloned()
    }

    pub fn remember_name(&self, slug: &str, name: Option<&str>) {
        let mut names = self.names.lock().unwrap();
        match name {
            Some(name) if !name.is_empty() => names.insert(slug.to_string(), name.to_string()),
            _ => names.remove(slug),
        };
        write_json(&self.config_dir.join("sandboxes.json"), &*names);
    }

    pub fn forget(&self, slug: &str) {
        let mut names = self.names.lock().unwrap();
        names.remove(slug);
        write_json(&self.config_dir.join("sandboxes.json"), &*names);
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    if let Ok(serialized) = serde_json::to_string_pretty(value) {
        let _ = std::fs::write(path, serialized);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_in(config_dir: &Path) -> AppState {
        AppState {
            config_dir: config_dir.to_path_buf(),
            settings: Mutex::new(Settings::default()),
            pending: Mutex::new(None),
            pending_recreate: Mutex::new(None),
            pending_sync: Mutex::new(None),
            names: Mutex::new(BTreeMap::new()),
            install_id: Mutex::new(None),
        }
    }

    /* THE JOIN IS ONLY WORTH ANYTHING IF IT OUTLIVES THE PROCESS.
     *
     * This id is what ties an install the app ran to the workspace the user landed in afterwards, and those
     * two are often not the same run of the app — a setup ends, the window is handed over, the machine gets
     * restarted. An id minted per launch would still produce events; they would just quietly describe a new
     * stranger every time, which is the failure mode that looks like working software. */
    #[test]
    fn the_install_id_survives_a_restart() {
        let dir =
            std::env::temp_dir().join(format!("intentic-install-id-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp config dir");

        let minted = state_in(&dir).install_id();
        // A second AppState over the same config dir is what the next launch of the app is.
        let after_restart = state_in(&dir).install_id();

        assert_eq!(minted, after_restart);
        assert!(!minted.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* THE DEFAULT, PINNED TO THE CONNECT FLOW'S OWN.
     *
     * This app spawns the shipped connect scripts precisely so the desktop and terminal paths cannot disagree
     * (scripts.rs states the case). But it passes PLATFORM_URL in explicitly, which overrides the default the
     * flow would otherwise pick for itself — so on this one value the two ARE two copies, and the copy here
     * was wrong: it pointed at the SPA, the claim POST hit a static site, and every desktop install failed on
     * `HTTP 405 Method Not Allowed` one step after "redeeming the setup code".
     *
     * The default lives in the ic host-side CLI now (the scripts are bootstrap shims that forward env), so
     * this pins against ic's source — which ships in this same repo, in this same commit. */
    #[test]
    fn the_platform_default_is_the_one_the_connect_flow_picks_for_itself() {
        let connect = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../_sandbox/ic/src/sandbox/connect.rs");
        let source = std::fs::read_to_string(connect).expect("ic's connect.rs is readable");

        assert!(
            source.contains(&format!("env_or(\"PLATFORM_URL\", \"{PLATFORM_URL}\")")),
            "ic's connect flow no longer falls back to {PLATFORM_URL}. Whatever it picks now is what a \
             pasted command uses, and this app has to hand the same thing to the flow it spawns — the \
             platform's API origin, never the app's, which answers a claim POST with 405.",
        );
    }
}
