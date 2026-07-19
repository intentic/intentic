use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use intentic_desktop_core::reconcile::ReconcileContext;
use intentic_desktop_core::types::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::setup_link::SetupArgs;

pub const APP_URL: &str = "https://app.intentic.dev";
const ROOTFS_URL: &str = "https://gitlab.com/radarsu/intentic/-/releases/permalink/latest/downloads/desktop/intentic-machine-amd64.tar.gz";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The workspace SPA origin. Unset ⇒ INTENTIC_APP_URL env ⇒ the hosted app.
    pub app_url: Option<String>,
    /// The platform origin setup codes are claimed against. Unset ⇒ INTENTIC_PLATFORM_URL env ⇒ app URL default.
    pub platform_url: Option<String>,
    /// Where the WSL machine rootfs downloads from. Unset ⇒ the latest release asset.
    pub rootfs_url: Option<String>,
}

pub struct AppState {
    config_dir: PathBuf,
    data_dir: PathBuf,
    pub settings: Mutex<Settings>,
    /// The engine the last probe selected — every sandbox operation uses it.
    pub engine: Mutex<Option<Engine>>,
    /// A setup request waiting for the launcher UI to pick up.
    pub pending: Mutex<Option<SetupArgs>>,
    /// slug → display name, ours to remember (docker only knows container names).
    names: Mutex<BTreeMap<String, String>>,
}

impl AppState {
    pub fn load(app: &AppHandle) -> tauri::Result<AppState> {
        let config_dir = app.path().app_config_dir()?;
        let data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&config_dir)?;
        std::fs::create_dir_all(&data_dir)?;
        let settings = read_json(&config_dir.join("settings.json")).unwrap_or_default();
        let names = read_json(&config_dir.join("sandboxes.json")).unwrap_or_default();
        Ok(AppState {
            config_dir,
            data_dir,
            settings: Mutex::new(settings),
            engine: Mutex::new(None),
            pending: Mutex::new(None),
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

    pub fn reconcile_context(&self) -> ReconcileContext {
        let configured = self.settings.lock().unwrap().rootfs_url.clone();
        let rootfs_url = configured
            .or_else(|| std::env::var("INTENTIC_ROOTFS_URL").ok())
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| ROOTFS_URL.into());
        ReconcileContext {
            rootfs_url,
            data_dir: self.data_dir.clone(),
        }
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
