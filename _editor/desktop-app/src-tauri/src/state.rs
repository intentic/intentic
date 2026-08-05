use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::setup_link::{RecreateArgs, SetupArgs};

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The workspace SPA origin. Unset ⇒ INTENTIC_APP_URL env ⇒ [`APP_URL`].
    pub app_url: Option<String>,
    /// The platform API origin setup codes are claimed against. Unset ⇒ INTENTIC_PLATFORM_URL env ⇒
    /// [`PLATFORM_URL`] — never the app origin, which answers a claim POST with 405.
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
            .unwrap_or_else(|| PLATFORM_URL.into())
    }

    pub fn save_settings(&self, settings: Settings) {
        *self.settings.lock().unwrap() = settings.clone();
        write_json(&self.config_dir.join("settings.json"), &settings);
    }

    /// True exactly once per install — the first time a close hides the window instead of ending the app.
    ///
    /// Deliberately NOT a [`Settings`] field: the launcher UI saves that struct wholesale, so changing an
    /// origin there would re-arm a notice the user has already read. And it claims the marker by WRITING it,
    /// answering false if that write fails — a notice this app cannot remember having shown is one it would
    /// show on every close, which is worse than the silence.
    pub fn claim_tray_notice(&self) -> bool {
        let marker = self.config_dir.join("tray-notice-shown");
        if marker.exists() {
            return false;
        }
        std::fs::write(&marker, "").is_ok()
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
