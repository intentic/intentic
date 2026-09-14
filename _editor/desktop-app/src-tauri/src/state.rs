use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::setup_link::{RecreateArgs, SetupArgs, SyncArgs};

/* `APP_URL` is the SPA origin the daemon must allow through CORS. */
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
/* A request waiting for the launcher UI to pick up. */
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

/* A SETUP THAT A RESTART INTERRUPTED — the one piece of this app's state that has to outlive the process by design rather than by accident. */
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

/* The launcher and the workspace are separate webviews with separate storage. */
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

/* This id ties an install run to the workspace it opens. */
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

/* This app spawns the shipped connect scripts precisely so the desktop and terminal paths cannot disagree (scripts.rs states the case). */
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
