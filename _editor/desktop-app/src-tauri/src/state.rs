use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::setup_link::{RecreateArgs, Roster, RosterEntry, SetupArgs, SyncArgs};

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

/// The two ways a Windows session ends on a requirement's behalf. Both come back to the same place — the Run entry
/// starts this app at the next sign-in either way (resume.rs) — so what differs is how far the machine goes down in
/// between, and
/// which of the two a resumed setup should remember: a sign-out that did not refresh a login token is
/// answered by a restart, and only the resumed run can know it is the second attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionEnd {
    Restart,
    SignOut,
}

impl SessionEnd {
    /// What a parked setup that predates `how` ended with: a restart, the only kind there was.
    fn before_how() -> SessionEnd {
        SessionEnd::Restart
    }
}

/// A setup parked across a Windows restart. See [`AppState::park_setup`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedSetup {
    pub args: SetupArgs,
    /// Unix seconds. The point of writing it down: after a restart there is nothing else left that knows how
    /// long ago this was, and the setup code inside expires.
    pub saved_at: u64,
    /// Which way the session ended on this setup's behalf. A file written before 2026-09-15 has none: every
    /// setup parked then was parked across a restart, the only way a session ended on its behalf.
    #[serde(default = "SessionEnd::before_how")]
    pub how: SessionEnd,
}

/// The colour scheme the workspace is in, as its page last announced it — the one fact the app's own faces
/// need in order to be drawn in the same light as the screen they stand in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Light,
    Dark,
}

impl Mode {
    /// The wire spelling, on a link and in the page's own `data-mode`.
    pub fn parse(value: &str) -> Option<Mode> {
        match value {
            "light" => Some(Mode::Light),
            "dark" => Some(Mode::Dark),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Mode::Light => "light",
            Mode::Dark => "dark",
        }
    }
}

/// Which of the app's two faces the user was last seen choosing: the workspace (the hosted editor) or Home (the
/// main local window, windows.rs `HOME`: the editor's shell on a folder of this computer, with This device beside
/// it). What a launch and the tray's "Open Intentic" open onto (lib.rs `opening`), kept on disk as `last-face.json`.
/// The spelling `home` is the one the launcher's card had before the main window took its place (2026-09-30), so a
/// file written then still reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Face {
    Home,
    Workspace,
}

/// Where the main window opens on a machine that has never pointed it anywhere: a folder of Intentic's own under the
/// user's home, `~/intentic/local`, made on first launch. Opinionated on purpose: a first launch asks nothing, and a
/// folder the app owns is one it can open without reading anybody's documents. `intentic/` leaves room beside it.
pub fn default_home_folder(home: &Path) -> PathBuf {
    home.join("intentic").join("local")
}

/// The face an install that has no `last-face.json` yet was last using. Before the file existed the only record
/// was whether the workspace had ever been shown, and from its first showing a launch always opened it; an
/// install that never showed it opened Home. The file, once written, is the answer.
fn face_or_migrated(stored: Option<Face>, workspace_seen: bool) -> Face {
    match stored {
        Some(face) => face,
        None if workspace_seen => Face::Workspace,
        None => Face::Home,
    }
}

/// A folder or document the user opened in a local window (local.rs), newest first: what Home and the tray
/// offer to open again. The path is the one the user chose, as the app resolved it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: String,
    pub folder: bool,
    /// Unix seconds.
    pub opened_at: u64,
}

/// A recent as Home shows it (`local_recents`): the stored entry, plus two facts read at the moment of asking and
/// never stored, since both change behind this app's back. `exists` is whether the path is there now (a folder
/// moved or a drive unplugged is shown as such, with the way to forget it); `sandbox` is whether the folder has a
/// sandbox of its own in `projects.json` (project.rs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentView {
    pub path: String,
    pub folder: bool,
    pub opened_at: u64,
    pub exists: bool,
    pub sandbox: bool,
}

/// The views of `recents`, in their order. `exists` is asked of the caller so the rule is testable without a disk.
pub fn recent_views(
    recents: Vec<Recent>,
    projects: &[Project],
    exists: impl Fn(&Path) -> bool,
) -> Vec<RecentView> {
    recents
        .into_iter()
        .map(|recent| {
            let path = Path::new(&recent.path);
            let sandbox = recent.folder
                && projects
                    .iter()
                    .any(|project| Path::new(&project.path) == path);
            RecentView {
                exists: exists(path),
                sandbox,
                path: recent.path,
                folder: recent.folder,
                opened_at: recent.opened_at,
            }
        })
        .collect()
}

/// How many recents are kept: what fits a menu without scrolling.
const RECENTS: usize = 12;

/// A folder of this computer that has a sandbox of its own (project.rs): opening it again reaches that sandbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    /// Its name inside the sandbox's `/work`.
    pub dir: String,
    /// The platform's row for the sandbox, which the workspace opens at.
    pub sandbox_id: Option<String>,
    /// The sandbox's slug on this machine.
    pub slug: Option<String>,
}

pub struct AppState {
    config_dir: PathBuf,
    pub settings: Mutex<Settings>,
    /* A request waiting for This device, in the main window, to pick up. */
    pub pending: Mutex<Option<SetupArgs>>,
    pub pending_recreate: Mutex<Option<RecreateArgs>>,
    /// A desktop-sync enrollment the SPA handed over (`intentic://sync`), waiting for This device to ask for the
    /// folder and run it. Same taken-not-read contract as the two above.
    pub pending_sync: Mutex<Option<SyncArgs>>,
    /// This launch opened the app's own face because the engine was asleep (lib.rs), so this launch is the one
    /// that hands over to the workspace once it wakes. In-process only: a launch is not a thing to remember.
    pub pending_docker: Mutex<bool>,
    /// slug → display name, ours to remember: docker knows only container names, and the name the user typed
    /// into the SPA never reaches the machine any other way.
    names: Mutex<BTreeMap<String, String>>,
    /// Minted on first read, then held for the process — see [`AppState::install_id`].
    install_id: Mutex<Option<String>>,
    /// The workspace's colour scheme, as last announced; `None` until any page has said. Kept on disk so a
    /// card opened before the workspace (a resume after a restart, the tray's "Home") is drawn the
    /// way the workspace was last seen rather than the way this binary happens to default.
    ui_mode: Mutex<Option<Mode>>,
    /// Whether a sandbox has ever run on THIS machine. Kept on disk because the question is asked at the one
    /// moment nothing can be measured: a launch whose Docker is not running cannot be asked what it hosts.
    hosts_sandboxes: Mutex<bool>,
    /// Whether this install has ever shown the workspace. What decided a launch before `last_face` existed, and
    /// still the migration for an install that has no `last-face.json` (see [`face_or_migrated`]), and the older
    /// half of [`AppState::account_seen`].
    workspace_seen: Mutex<bool>,
    /// The face a launch and the tray's "Open Intentic" open onto (lib.rs `opening`).
    last_face: Mutex<Face>,
    /// Whether a sign-in has ever completed here (`intentic://auth`, auth.rs). What earns the tray its "Open
    /// workspace" row and tells Home whether this install has an account to go back to.
    account_seen: Mutex<bool>,
    /// Held across every read-modify-write of `recent-local.json` and `projects.json`. Each file is written whole
    /// (`write_json`), but two opens finishing together each read the list, add their own entry and write it
    /// back, and without this the second write drops the first one's entry.
    lists: Mutex<()>,
    /// The folder a local window asked a sandbox for, waiting for the setup page's code (project.rs). In-process
    /// only: a question a quit left unanswered is asked again.
    pub pending_project: Mutex<Option<PathBuf>>,
    /// The folder the main window was last pointed at (`home-folder.json`), which the next launch opens it on; none
    /// until it has been pointed anywhere, which is [`AppState::default_home`].
    home_folder: Mutex<Option<PathBuf>>,
    /// `~/intentic/local` ([`default_home_folder`]), or a folder in the app's own config dir where the OS names no home.
    default_home: PathBuf,
    /// Who is signed in to the workspace and the sandboxes its switcher last listed (`roster.json`,
    /// `intentic://roster`): what a local window shows of the account, since that window cannot ask the platform
    /// itself. Empty until the workspace has said, and again after a sign-out.
    roster: Mutex<Roster>,
}

impl AppState {
    pub fn load(app: &AppHandle) -> tauri::Result<AppState> {
        let config_dir = app.path().app_config_dir()?;
        std::fs::create_dir_all(&config_dir)?;
        let settings = read_json(&config_dir.join("settings.json")).unwrap_or_default();
        let names = read_json(&config_dir.join("sandboxes.json")).unwrap_or_default();
        let ui_mode = read_json(&config_dir.join("ui-mode.json"));
        let hosts_sandboxes = read_json(&config_dir.join("hosts-sandboxes.json")).unwrap_or(false);
        let workspace_seen = read_json(&config_dir.join("workspace-seen.json")).unwrap_or(false);
        let last_face = face_or_migrated(
            read_json(&config_dir.join("last-face.json")),
            workspace_seen,
        );
        let account_seen = read_json(&config_dir.join("account-seen.json")).unwrap_or(false);
        let home_folder = read_json(&config_dir.join("home-folder.json"));
        let roster = read_roster(&config_dir);
        let default_home = app.path().home_dir().map_or_else(
            |_| config_dir.join("local"),
            |home| default_home_folder(&home),
        );
        Ok(AppState {
            config_dir,
            settings: Mutex::new(settings),
            pending: Mutex::new(None),
            pending_recreate: Mutex::new(None),
            pending_sync: Mutex::new(None),
            pending_docker: Mutex::new(false),
            names: Mutex::new(names),
            install_id: Mutex::new(None),
            ui_mode: Mutex::new(ui_mode),
            hosts_sandboxes: Mutex::new(hosts_sandboxes),
            workspace_seen: Mutex::new(workspace_seen),
            last_face: Mutex::new(last_face),
            account_seen: Mutex::new(account_seen),
            lists: Mutex::new(()),
            pending_project: Mutex::new(None),
            home_folder: Mutex::new(home_folder),
            default_home,
            roster: Mutex::new(roster),
        })
    }

    /* WHETHER THIS MACHINE IS A SANDBOX HOST, which is the whole of the licence to start its Docker. */

    pub fn hosts_sandboxes(&self) -> bool {
        *self.hosts_sandboxes.lock().unwrap()
    }

    /// Written the moment a sandbox is seen or made here. A machine that hosted one and currently shows none is a
    /// machine whose Docker is down, which is exactly the state this answer is for, so it is unwritten only on a listing
    /// that proves there is none left ([`forgets_hosting`], 2026-10-05). Only writes on the change, like
    /// [`AppState::remember_ui_mode`] — this is asked on every listing.
    pub fn remember_hosts_sandboxes(&self) {
        let mut held = self.hosts_sandboxes.lock().unwrap();
        if *held {
            return;
        }
        *held = true;
        write_json(&self.config_dir.join("hosts-sandboxes.json"), &true);
    }

    /// The last sandbox here is gone: launches stop starting Docker Desktop for one. Only on the change.
    pub fn forget_hosts_sandboxes(&self) {
        let mut held = self.hosts_sandboxes.lock().unwrap();
        if !*held {
            return;
        }
        *held = false;
        write_json(&self.config_dir.join("hosts-sandboxes.json"), &false);
    }

    pub fn workspace_seen(&self) -> bool {
        *self.workspace_seen.lock().unwrap()
    }

    /// Written the first time the workspace is on screen, and never unwritten.
    pub fn remember_workspace_seen(&self) {
        let mut held = self.workspace_seen.lock().unwrap();
        if *held {
            return;
        }
        *held = true;
        write_json(&self.config_dir.join("workspace-seen.json"), &true);
    }

    /* THE FACE THE USER WAS LAST USING, and whether they have an account to go back to. */

    pub fn last_face(&self) -> Face {
        *self.last_face.lock().unwrap()
    }

    /// Written only on a change, like [`AppState::remember_ui_mode`]: the workspace is shown far more often than the
    /// face changes.
    pub fn remember_last_face(&self, face: Face) {
        let mut held = self.last_face.lock().unwrap();
        if *held == face {
            return;
        }
        *held = face;
        write_json(&self.config_dir.join("last-face.json"), &face);
    }

    /// A sign-in completed here, or (before `account-seen.json` existed) the workspace was shown, which an install
    /// only did for somebody with an account.
    pub fn account_seen(&self) -> bool {
        *self.account_seen.lock().unwrap() || self.workspace_seen()
    }

    /// Written the first time a sign-in completes, and never unwritten: signing out is not the account going away.
    pub fn remember_account_seen(&self) {
        let mut held = self.account_seen.lock().unwrap();
        if *held {
            return;
        }
        *held = true;
        write_json(&self.config_dir.join("account-seen.json"), &true);
    }

    /* THE ACCOUNT AND ITS SANDBOXES, as the workspace last told them. */

    pub fn roster(&self) -> Roster {
        self.roster.lock().unwrap().clone()
    }

    /// Written only on a change: the workspace says it on every load and every change to either.
    pub fn remember_roster(&self, roster: Roster) {
        let mut held = self.roster.lock().unwrap();
        if *held == roster {
            return;
        }
        write_json(&self.config_dir.join("roster.json"), &roster);
        *held = roster;
    }

    pub fn ui_mode(&self) -> Option<Mode> {
        *self.ui_mode.lock().unwrap()
    }

    /// Remember the scheme the workspace announced. Written only when it changed: the page says it on every
    /// load, and a file rewritten on every load is a file that is sometimes half-written.
    pub fn remember_ui_mode(&self, mode: Mode) -> bool {
        let mut held = self.ui_mode.lock().unwrap();
        if *held == Some(mode) {
            return false;
        }
        *held = Some(mode);
        write_json(&self.config_dir.join("ui-mode.json"), &mode);
        true
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
    /// Deliberately NOT a [`Settings`] field: `settings_set` saves that struct wholesale, so changing an
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
    pub fn park_setup(&self, args: &SetupArgs, how: SessionEnd) {
        let parked = ParkedSetup {
            args: args.clone(),
            saved_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_secs())
                .unwrap_or(0),
            how,
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

    /* THE FOLDERS THAT HAVE A SANDBOX OF THEIR OWN. */

    pub fn projects(&self) -> Vec<Project> {
        read_json(&self.config_dir.join("projects.json")).unwrap_or_default()
    }

    /// One entry per folder: a folder set up again (its sandbox removed, a new one made) replaces its entry.
    pub fn remember_project(&self, project: Project) {
        let _held = self.lists.lock().unwrap();
        let mut projects = self.projects();
        projects.retain(|held| held.path != project.path);
        projects.push(project);
        write_json(&self.config_dir.join("projects.json"), &projects);
    }

    /// The entries `gone` picks, taken out of `projects.json` and answered; nothing is written when it picks none.
    pub fn forget_projects(&self, gone: impl Fn(&Project) -> bool) -> Vec<Project> {
        let _held = self.lists.lock().unwrap();
        let (dropped, kept): (Vec<Project>, Vec<Project>) = self
            .projects()
            .into_iter()
            .partition(|project| gone(project));
        if !dropped.is_empty() {
            write_json(&self.config_dir.join("projects.json"), &kept);
        }
        dropped
    }

    /* THE FOLDER THE MAIN WINDOW SHOWS. */

    /// The folder the main window opens on: the one it was last pointed at, or `~/intentic/local`.
    pub fn home_folder(&self) -> PathBuf {
        self.home_folder
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| self.default_home.clone())
    }

    /// The folder a first launch makes and opens (`~/intentic/local`), and the one the main window falls back to when
    /// the folder it was pointed at has gone.
    pub fn default_home(&self) -> &Path {
        &self.default_home
    }

    /// The main window was pointed at `path`: the next launch opens it there. Written only on a change.
    pub fn remember_home_folder(&self, path: &Path) {
        let mut held = self.home_folder.lock().unwrap();
        if held.as_deref() == Some(path) {
            return;
        }
        *held = Some(path.to_path_buf());
        write_json(&self.config_dir.join("home-folder.json"), &path);
    }

    /* WHAT WAS OPENED LOCALLY, newest first. */

    pub fn recents(&self) -> Vec<Recent> {
        read_json(&self.config_dir.join("recent-local.json")).unwrap_or_default()
    }

    /// Moves `path` to the front, or puts it there; the oldest past [`RECENTS`] fall off.
    pub fn remember_recent(&self, path: &Path, folder: bool) {
        let _held = self.lists.lock().unwrap();
        let path = path.display().to_string();
        let mut recents = self.recents();
        recents.retain(|recent| recent.path != path);
        recents.insert(
            0,
            Recent {
                path,
                folder,
                opened_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|since| since.as_secs())
                    .unwrap_or(0),
            },
        );
        recents.truncate(RECENTS);
        write_json(&self.config_dir.join("recent-local.json"), &recents);
    }

    /// Home's "Forget": the entry goes, whether or not its path is still there. Nothing is written when there was
    /// nothing to forget.
    pub fn forget_recent(&self, path: &str) {
        let _held = self.lists.lock().unwrap();
        let mut recents = self.recents();
        let before = recents.len();
        recents.retain(|recent| recent.path != path);
        if recents.len() != before {
            write_json(&self.config_dir.join("recent-local.json"), &recents);
        }
    }

    /* The local windows and the workspace are separate webviews with separate storage. */
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

/// Whether a listing proves this machine hosts no sandbox any more, so `hosts-sandboxes.json` may be cleared and a
/// launch stop starting Docker Desktop for one (2026-10-05: it never was, and every launch after the last sandbox was
/// removed still started Docker). All three must say so: `ic sandbox list --json` answered (`rows`, which a failed
/// listing never is) with no sandbox of this side's own (a row the other side of this computer keeps, `keptElsewhere`,
/// is that side's to start Docker for); `ic`'s trash holds nothing a `restore` could bring back (`trash_empty`, `None`
/// when it could not be read, which is a doubt and keeps the flag); and this computer's own sandbox is not one the app
/// is making or keeps (`machine_holds`, machine_sandbox.rs). Pure.
pub fn forgets_hosting(
    rows: &[serde_json::Value],
    trash_empty: Option<bool>,
    machine_holds: bool,
) -> bool {
    let own = rows
        .iter()
        .any(|row| row["keptElsewhere"].as_str().is_none());
    !own && trash_empty == Some(true) && !machine_holds
}

/// The file's value, or None when it is absent or unusable. A file that won't parse is set aside as
/// `<name>.json.unreadable` rather than left for the next write to replace; every failure but absence is logged.
/// `roster.json` as either shape it has had: the account and its sandboxes, or the bare list of sandboxes it was first
/// written as (before the account rode with them), read as that list with nobody named.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredRoster {
    Current(Roster),
    Sandboxes(Vec<RosterEntry>),
}

fn read_roster(config_dir: &Path) -> Roster {
    match read_json::<StoredRoster>(&config_dir.join("roster.json")) {
        Some(StoredRoster::Current(roster)) => roster,
        Some(StoredRoster::Sandboxes(sandboxes)) => Roster {
            account: None,
            sandboxes,
        },
        None => Roster::default(),
    }
}

pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            eprintln!("intentic: could not read {}: {error}", path.display());
            return None;
        }
    };
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(error) => {
            let aside = path.with_extension("json.unreadable");
            eprintln!(
                "intentic: {} does not parse ({error}); set aside as {}",
                path.display(),
                aside.display()
            );
            if let Err(error) = std::fs::rename(path, &aside) {
                eprintln!("intentic: could not set {} aside: {error}", path.display());
            }
            None
        }
    }
}

/// Written whole or not at all: a sibling temp file renamed over the old one, so a crash mid-write cannot leave
/// half a file for the next launch to read.
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) {
    let written = serde_json::to_string_pretty(value)
        .map_err(std::io::Error::from)
        .and_then(|serialized| {
            let temp = path.with_extension("json.tmp");
            std::fs::write(&temp, serialized)?;
            std::fs::rename(&temp, path)
        });
    if let Err(error) = written {
        eprintln!("intentic: could not save {}: {error}", path.display());
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
            pending_docker: Mutex::new(false),
            names: Mutex::new(BTreeMap::new()),
            install_id: Mutex::new(None),
            // Read the way `load` reads it: the test below is about what survives a launch.
            ui_mode: Mutex::new(read_json(&config_dir.join("ui-mode.json"))),
            hosts_sandboxes: Mutex::new(
                read_json(&config_dir.join("hosts-sandboxes.json")).unwrap_or(false),
            ),
            workspace_seen: Mutex::new(
                read_json(&config_dir.join("workspace-seen.json")).unwrap_or(false),
            ),
            last_face: Mutex::new(face_or_migrated(
                read_json(&config_dir.join("last-face.json")),
                read_json(&config_dir.join("workspace-seen.json")).unwrap_or(false),
            )),
            account_seen: Mutex::new(
                read_json(&config_dir.join("account-seen.json")).unwrap_or(false),
            ),
            lists: Mutex::new(()),
            pending_project: Mutex::new(None),
            home_folder: Mutex::new(read_json(&config_dir.join("home-folder.json"))),
            default_home: default_home_folder(&config_dir.join("home")),
            roster: Mutex::new(read_roster(config_dir)),
        }
    }

    /* A FILE THIS APP CANNOT PARSE is kept, not written over by the default that stood in for it. */
    #[test]
    fn an_unparseable_file_is_set_aside_before_a_write_replaces_it() {
        let dir =
            std::env::temp_dir().join(format!("intentic-unreadable-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp config dir");
        let path = dir.join("sandboxes.json");
        std::fs::write(&path, r#"{"ab"#).expect("write");

        assert_eq!(read_json::<BTreeMap<String, String>>(&path), None);
        let names = BTreeMap::from([("a".to_string(), "Alpha".to_string())]);
        write_json(&path, &names);

        assert_eq!(
            std::fs::read_to_string(dir.join("sandboxes.json.unreadable")).expect("set aside"),
            r#"{"ab"#
        );
        assert_eq!(read_json::<BTreeMap<String, String>>(&path), Some(names));
        assert!(!dir.join("sandboxes.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* THE FILE A RESTART LEAVES BEHIND has to say which way the session ended. */
    #[test]
    fn a_parked_setup_remembers_how_the_session_ended() {
        let dir = std::env::temp_dir().join(format!("intentic-parked-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp config dir");
        let args = SetupArgs {
            code: "abc".into(),
            sandbox_id: None,
            name: None,
            cf_token: None,
            sync_dir: None,
            platform_url: None,
            project: None,
            slug: None,
            minted_at: Some(1_790_000_000),
            profile: None,
        };
        state_in(&dir).park_setup(&args, SessionEnd::SignOut);
        let parked = state_in(&dir).parked_setup().expect("parked");
        assert_eq!(parked.how, SessionEnd::SignOut);
        assert_eq!(parked.args.code, "abc");
        // When the code was minted outlives the park: the next restart's resume measures the code, not the park.
        assert_eq!(parked.args.minted_at, Some(1_790_000_000));

        // A file written before `how` existed still resumes, as the restart every setup was parked across then.
        std::fs::write(
            dir.join("resume-setup.json"),
            r#"{"args":{"code":"old","name":null,"cfToken":null,"syncDir":null,"platformUrl":null},"savedAt":1}"#,
        )
        .expect("write");
        let older = state_in(&dir).parked_setup().expect("older file parses");
        assert_eq!(older.how, SessionEnd::Restart);
        assert_eq!(older.args.code, "old");
        assert_eq!(older.args.minted_at, None);
        assert!(!dir.join("resume-setup.json.unreadable").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_ui_mode_is_kept_across_launches_and_written_only_on_change() {
        let dir = std::env::temp_dir().join(format!("intentic-mode-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp config dir");
        assert_eq!(state_in(&dir).ui_mode(), None);
        let state = state_in(&dir);
        assert!(state.remember_ui_mode(Mode::Light));
        assert!(
            !state.remember_ui_mode(Mode::Light),
            "same answer, nothing to write"
        );
        assert_eq!(state_in(&dir).ui_mode(), Some(Mode::Light));
        assert_eq!(Mode::parse("dark"), Some(Mode::Dark));
        assert_eq!(Mode::parse("sepia"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* A LAUNCH CANNOT MEASURE THIS: a machine whose Docker is down cannot be asked what it hosts, which is precisely when the answer decides what opens. */
    #[test]
    fn hosting_a_sandbox_is_remembered_across_launches() {
        let dir = std::env::temp_dir().join(format!("intentic-hosts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp config dir");

        assert!(
            !state_in(&dir).hosts_sandboxes(),
            "a machine nothing has run on yet is nobody's to wake"
        );
        let state = state_in(&dir);
        state.remember_hosts_sandboxes();
        assert!(state.hosts_sandboxes());
        // A second AppState over the same config dir is what the next launch of the app is — the one that
        // opens with Docker stopped and cannot ask docker anything.
        assert!(state_in(&dir).hosts_sandboxes());
        // The last sandbox gone, as a listing proved: the next launch has no Docker to start for one.
        state.forget_hosts_sandboxes();
        assert!(!state_in(&dir).hosts_sandboxes());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The flag is cleared only on proof: a listing that answered with nothing of this side's, an empty trash, and no
    /// sandbox of this computer's own on its way. Anything less, a doubt included, keeps it.
    #[test]
    fn hosting_is_forgotten_only_when_a_listing_proves_nothing_is_left() {
        let theirs = serde_json::json!({ "slug": "wsl-work", "keptElsewhere": "linux" });
        let mine = serde_json::json!({ "slug": "work" });
        assert!(forgets_hosting(&[], Some(true), false));
        assert!(forgets_hosting(
            std::slice::from_ref(&theirs),
            Some(true),
            false
        ));
        assert!(!forgets_hosting(
            std::slice::from_ref(&mine),
            Some(true),
            false
        ));
        assert!(!forgets_hosting(&[theirs, mine], Some(true), false));
        // A removed sandbox is still restorable for a week, and restoring it needs this machine's Docker.
        assert!(!forgets_hosting(&[], Some(false), false));
        // The trash could not be read: a doubt, which never clears anything.
        assert!(!forgets_hosting(&[], None, false));
        // This computer's own sandbox is being made, or kept, without a container listed yet.
        assert!(!forgets_hosting(&[], Some(true), true));
    }

    #[test]
    fn projects_whose_sandbox_is_gone_are_taken_out_and_the_rest_kept() {
        let dir = std::env::temp_dir().join(format!("intentic-projects-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp config dir");
        let state = state_in(&dir);
        for (path, id) in [("/a", Some("gone")), ("/b", Some("live")), ("/c", None)] {
            state.remember_project(Project {
                path: path.to_string(),
                dir: "x".to_string(),
                sandbox_id: id.map(str::to_string),
                slug: None,
            });
        }
        assert!(state.forget_projects(|_| false).is_empty());
        let dropped =
            state.forget_projects(|project| project.sandbox_id.as_deref() == Some("gone"));
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].path, "/a");
        let left: Vec<String> = state_in(&dir)
            .projects()
            .into_iter()
            .map(|project| project.path)
            .collect();
        assert_eq!(left, vec!["/b".to_string(), "/c".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
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

    /// Newest first, one entry per path however often it is opened, and no longer than a menu can show.
    #[test]
    fn recents_move_to_the_front_and_the_oldest_fall_off() {
        let dir = std::env::temp_dir().join(format!("intentic-recents-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = state_in(&dir);
        for index in 0..14 {
            state.remember_recent(Path::new(&format!("/folder-{index}")), true);
        }
        state.remember_recent(Path::new("/folder-3"), true);
        let recents = state.recents();
        assert_eq!(recents.len(), RECENTS);
        assert_eq!(recents[0].path, "/folder-3");
        assert_eq!(recents[1].path, "/folder-13");
        assert_eq!(
            recents
                .iter()
                .filter(|recent| recent.path == "/folder-3")
                .count(),
            1
        );
        assert!(!recents.iter().any(|recent| recent.path == "/folder-0"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Asked at a launch, before any window: written once, and read back by the next process.
    #[test]
    fn the_workspace_having_been_seen_survives_a_launch() {
        let dir = std::env::temp_dir().join(format!("intentic-seen-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!state_in(&dir).workspace_seen());
        state_in(&dir).remember_workspace_seen();
        assert!(state_in(&dir).workspace_seen());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// An install from before `last-face.json` keeps opening what it opened: the workspace once it had been shown,
    /// Home until then. The file, once there, is the answer whatever the older one says.
    #[test]
    fn the_last_face_is_migrated_from_the_workspace_having_been_seen() {
        assert_eq!(face_or_migrated(None, true), Face::Workspace);
        assert_eq!(face_or_migrated(None, false), Face::Home);
        assert_eq!(face_or_migrated(Some(Face::Home), true), Face::Home);
        assert_eq!(
            face_or_migrated(Some(Face::Workspace), false),
            Face::Workspace
        );
    }

    #[test]
    fn the_last_face_survives_a_launch_and_its_file_is_the_wire_word() {
        let dir = std::env::temp_dir().join(format!("intentic-face-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        state_in(&dir).remember_workspace_seen();
        assert_eq!(state_in(&dir).last_face(), Face::Workspace);
        state_in(&dir).remember_last_face(Face::Home);
        assert_eq!(state_in(&dir).last_face(), Face::Home);
        assert_eq!(
            std::fs::read_to_string(dir.join("last-face.json")).unwrap(),
            "\"home\""
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A first launch opens the main window on `~/intentic/local`; once it has been pointed elsewhere, every launch
    /// after opens it there.
    #[test]
    fn the_main_window_opens_on_intentic_local_until_it_is_pointed_at_another_folder() {
        assert_eq!(
            default_home_folder(Path::new("/home/ada")),
            PathBuf::from("/home/ada/intentic/local")
        );
        let dir = std::env::temp_dir().join(format!("intentic-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = state_in(&dir);
        assert_eq!(first.home_folder(), first.default_home());
        first.remember_home_folder(Path::new("/home/ada/Taxes 2026"));
        // Read back by the next launch, from disk.
        assert_eq!(
            state_in(&dir).home_folder(),
            PathBuf::from("/home/ada/Taxes 2026")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A sign-in completing is the new record; an install that only ever showed the workspace had an account too.
    #[test]
    fn an_account_is_seen_by_a_sign_in_or_by_the_workspace_having_been_shown() {
        let dir = std::env::temp_dir().join(format!("intentic-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!state_in(&dir).account_seen());
        state_in(&dir).remember_account_seen();
        assert!(state_in(&dir).account_seen());

        let legacy =
            std::env::temp_dir().join(format!("intentic-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&legacy).unwrap();
        state_in(&legacy).remember_workspace_seen();
        assert!(state_in(&legacy).account_seen());
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&legacy).unwrap();
    }

    /// The workspace's list outlives the launch, so a local window opened first thing next time lists it too; a
    /// sign-out's empty list replaces it.
    #[test]
    fn the_workspaces_sandboxes_are_kept_until_it_says_otherwise() {
        let dir = std::env::temp_dir().join(format!("intentic-roster-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(state_in(&dir).roster(), Roster::default());
        let told = Roster {
            account: Some(crate::setup_link::RosterAccount {
                email: "ada@example.com".into(),
                name: Some("Ada".into()),
                image: None,
            }),
            sandboxes: vec![RosterEntry {
                id: "s1".into(),
                name: "Shop".into(),
                place: "cloud".into(),
                shared: false,
            }],
        };
        state_in(&dir).remember_roster(told.clone());
        assert_eq!(state_in(&dir).roster(), told);
        state_in(&dir).remember_roster(Roster::default());
        assert_eq!(state_in(&dir).roster(), Roster::default());
        // The file as it was first written, a bare list, is read as that list with nobody named.
        std::fs::write(
            dir.join("roster.json"),
            r#"[{"id":"s1","name":"Shop","place":"cloud","shared":false}]"#,
        )
        .unwrap();
        assert_eq!(
            state_in(&dir).roster(),
            Roster {
                account: None,
                sandboxes: told.sandboxes.clone(),
            }
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Forgetting takes exactly the one entry, and leaves the file untouched when there was nothing to forget.
    #[test]
    fn a_forgotten_recent_goes_and_the_rest_keep_their_order() {
        let dir = std::env::temp_dir().join(format!("intentic-forget-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = state_in(&dir);
        for name in ["/a", "/b", "/c"] {
            state.remember_recent(Path::new(name), true);
        }
        state.forget_recent("/b");
        let paths: Vec<String> = state
            .recents()
            .into_iter()
            .map(|recent| recent.path)
            .collect();
        assert_eq!(paths, vec!["/c".to_string(), "/a".to_string()]);
        std::fs::remove_file(dir.join("recent-local.json")).unwrap();
        state.forget_recent("/a");
        assert!(
            !dir.join("recent-local.json").exists(),
            "nothing to forget, nothing written"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// What Home is told about each recent: whether it is still there, and whether a FOLDER has a sandbox of its
    /// own. A document never does, even one at a path a project once had.
    #[test]
    fn a_recent_says_whether_it_is_there_and_whether_its_folder_has_a_sandbox() {
        let recents = vec![
            Recent {
                path: "/home/me/app".into(),
                folder: true,
                opened_at: 3,
            },
            Recent {
                path: "/home/me/gone".into(),
                folder: true,
                opened_at: 2,
            },
            Recent {
                path: "/home/me/app".into(),
                folder: false,
                opened_at: 1,
            },
        ];
        let projects = [Project {
            path: "/home/me/app".into(),
            dir: "app".into(),
            sandbox_id: Some("sbx".into()),
            slug: None,
        }];
        let views = recent_views(recents, &projects, |path| {
            path != Path::new("/home/me/gone")
        });
        assert_eq!(
            views
                .iter()
                .map(|view| (view.exists, view.sandbox))
                .collect::<Vec<_>>(),
            vec![(true, true), (false, false), (true, false)]
        );
        let wire = serde_json::to_value(&views[0]).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "path": "/home/me/app", "folder": true, "openedAt": 3, "exists": true, "sandbox": true })
        );
    }

    /// Two opens finishing together each read the list and write it back; the lock is what keeps both entries.
    #[test]
    fn recents_remembered_at_once_from_many_threads_are_all_kept() {
        let dir = std::env::temp_dir().join(format!("intentic-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = std::sync::Arc::new(state_in(&dir));
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let state = std::sync::Arc::clone(&state);
                std::thread::spawn(move || {
                    state.remember_recent(Path::new(&format!("/folder-{index}")), true)
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(state.recents().len(), 8);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
