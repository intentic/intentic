use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::setup_link::{RecreateArgs, SetupArgs};

pub const APP_URL: &str = "https://app.intentic.dev";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The workspace SPA origin. Unset ⇒ INTENTIC_APP_URL env ⇒ the hosted app.
    pub app_url: Option<String>,
    /// The platform origin setup codes are claimed against. Unset ⇒ INTENTIC_PLATFORM_URL env ⇒ app URL default.
    pub platform_url: Option<String>,
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
    /// slug → display name, ours to remember: docker knows only container names, and the name the user typed
    /// into the SPA never reaches the machine any other way.
    names: Mutex<BTreeMap<String, String>>,
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
            names: Mutex::new(names),
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
            .unwrap_or_else(|| APP_URL.into())
    }

    pub fn save_settings(&self, settings: Settings) {
        *self.settings.lock().unwrap() = settings.clone();
        write_json(&self.config_dir.join("settings.json"), &settings);
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
