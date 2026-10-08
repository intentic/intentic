//! WHAT THIS COMPUTER ALREADY USES (`found_on_machine`): the AI tools signed in here and the projects they worked in,
//! read from those tools' own files, so a first launch can offer them in place of an empty folder and a blank sign-in.
//!
//! Identity only. A login is recognised by the shape of its tool's file and named by the account it is for (an email,
//! a plan); no token is kept, returned or sent anywhere. The sandbox signs in on its own instead (Connect, with this
//! computer catching the browser's redirect), because these logins renew with single-use refresh tokens: a copy in a
//! sandbox and the original here would each log the other out the first time either renewed
//! (`_sandbox/sandbox/src/runtimes/claude/claude-credentials.ts`).
//!
//! Projects come from the tools' own histories, never from a crawl of the disk: Claude Code's sessions and trusted
//! folders, Codex's trusted projects and sessions, the last windows of the VS Code family and JetBrains' recent
//! projects. On Windows the homes of the WSL distros that are running are read as well, through `\\wsl.localhost`,
//! since that is where many people's code lives; a distro that is not running is never started for it.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::{AppState, Project};

/// What was found, as the local page draws it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub providers: Vec<FoundProvider>,
    pub projects: Vec<FoundProject>,
}

/// A subscription some tool on this computer is signed in to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundProvider {
    /// The sandbox's id for it (`PROVIDER_SPECS` in sandbox-contract), what the workspace's `?found=` names.
    pub provider: &'static str,
    /// The tools it was found signed in through, in the order they were read: `claude-code`, `codex`, `gemini-cli`,
    /// `opencode`, `hermes`, `openclaw`.
    pub tools: Vec<&'static str>,
    pub email: Option<String>,
    /// The plan as the tool recorded it (`max`, `pro`, `team`, `plus`…), when it did.
    pub plan: Option<String>,
    /// The WSL distro it was found in, when it was found nowhere else.
    pub wsl: Option<String>,
}

/// A folder some tool on this computer worked in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundProject {
    /// Where this computer opens it: `\\wsl.localhost\<distro>\…` for a distro's.
    pub path: String,
    /// How the tools spelled it: the Linux path for a distro's, otherwise `path`.
    pub shown: String,
    pub name: String,
    /// The tools whose history named it: `claude-code`, `codex`, `vscode`, `cursor`, `vscodium`, `windsurf`,
    /// `jetbrains`.
    pub sources: Vec<&'static str>,
    /// Unix seconds of the newest use any of them recorded, when one did.
    pub last_active: Option<u64>,
    pub wsl: Option<String>,
    /// It is a git repository.
    pub git: bool,
    /// It already has a sandbox of its own (`projects.json`).
    pub sandbox: bool,
}

/// How many projects are offered: a page's worth, newest first.
const PROJECTS: usize = 12;
/// How long one reading answers again before the machine is read anew.
const FRESH: Duration = Duration::from_secs(120);
/// The most of one history file read to find the folder it ran in: the first lines say it, and a session's later
/// lines can be megabytes of tool output.
const HEAD_BYTES: u64 = 256 * 1024;
/// Session folders and files looked at per tool, newest first, so a years-long history costs what a week's does.
const SESSIONS: usize = 300;

/// The last reading, kept so the empty folder's page, the rail's tile and a setup's link ask the disk once.
#[derive(Default)]
pub struct FoundCache(Mutex<Option<(Instant, Found)>>);

impl FoundCache {
    fn fresh(&self) -> Option<Found> {
        let held = self.0.lock().unwrap();
        held.as_ref()
            .filter(|(at, _)| at.elapsed() < FRESH)
            .map(|(_, found)| found.clone())
    }

    fn keep(&self, found: &Found) {
        *self.0.lock().unwrap() = Some((Instant::now(), found.clone()));
    }

    /// The last reading however old it is: what a setup's link carries, which must not wait on the disk.
    fn last(&self) -> Option<Found> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .map(|(_, found)| found.clone())
    }
}

/// The local page's question. Off the main thread: a distro's files are read over the network share WSL serves.
#[tauri::command]
pub async fn found_on_machine(app: AppHandle) -> Result<Found, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.state::<FoundCache>();
        if let Some(found) = cache.fresh() {
            return found;
        }
        let found = app.path().home_dir().map_or_else(
            |_| Found::default(),
            |home| scan_machine(&home, &app.state::<AppState>().projects()),
        );
        cache.keep(&found);
        found
    })
    .await
    .map_err(|error| format!("this computer could not be read: {error}"))
}

/// A workspace path with what was found added, when it is one a sandbox is first met at: the setup page, or a folder's
/// own sandbox opened on its folder (`/?sandbox=…&project=…`, project.rs, which has no setup page in its way).
/// `found=claude,codex` names the subscriptions signed in here, so the new sandbox's Connect offers them. Only ids
/// travel, never an email. Read from the last reading alone, since this is on the way to a window and must not wait on
/// the disk; a setup started before the page ever asked carries nothing, which is the page as it was.
pub fn with_found(app: &AppHandle, path: &str) -> String {
    let providers = app
        .try_state::<FoundCache>()
        .and_then(|cache| cache.last())
        .map(|found| found.providers)
        .unwrap_or_default();
    path_with_found(path, &providers)
}

fn path_with_found(path: &str, providers: &[FoundProvider]) -> String {
    let is_setup = path == "/setup" || path.starts_with("/setup?");
    let is_project = path.starts_with("/?") && path.contains("project=");
    if !(is_setup || is_project) || providers.is_empty() || path.contains("found=") {
        return path.to_string();
    }
    let ids: Vec<&str> = providers.iter().map(|found| found.provider).collect();
    let joiner = if path.contains('?') { '&' } else { '?' };
    format!("{path}{joiner}found={}", ids.join(","))
}

/* WHERE TO LOOK */

/// One home folder to read: this computer's own, or a running WSL distro's as Windows reaches it.
struct Home {
    /// Where the home is, as this process opens it.
    root: PathBuf,
    /// The home as its own tools spell paths under it: `C:\Users\ada`, or `/home/ada` inside a distro.
    recorded: String,
    /// `%APPDATA%` on Windows, `~/.config` elsewhere and in a distro: where editors keep their state.
    config: PathBuf,
    /// `~/.local/share` (or `XDG_DATA_HOME`): where opencode keeps its logins.
    data: PathBuf,
    /// Claude Code's folder and its account file, moved together by `CLAUDE_CONFIG_DIR`.
    claude_dir: PathBuf,
    claude_json: PathBuf,
    /// Codex's folder, moved by `CODEX_HOME`.
    codex_dir: PathBuf,
    /// For a distro's home: its name and its `/` as this process opens it.
    wsl: Option<(String, PathBuf)>,
    /// Folders under which nothing is anybody's project: the home's tool folders and Intentic's own, and for this
    /// computer's home its temporary folder.
    skip: Vec<PathBuf>,
}

impl Home {
    /// This computer's own home, with the variables its tools honour. Read here and nowhere else: a distro's
    /// environment is not this process's to read.
    fn native(root: &Path) -> Home {
        let var = |name: &str| {
            std::env::var_os(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        let config = if cfg!(windows) {
            var("APPDATA").unwrap_or_else(|| root.join("AppData").join("Roaming"))
        } else {
            var("XDG_CONFIG_HOME").unwrap_or_else(|| root.join(".config"))
        };
        let data = if cfg!(windows) {
            root.join(".local").join("share")
        } else {
            var("XDG_DATA_HOME").unwrap_or_else(|| root.join(".local").join("share"))
        };
        let (claude_dir, claude_json) = match var("CLAUDE_CONFIG_DIR") {
            Some(dir) => (dir.clone(), dir.join(".claude.json")),
            None => (root.join(".claude"), root.join(".claude.json")),
        };
        let codex_dir = var("CODEX_HOME").unwrap_or_else(|| root.join(".codex"));
        let mut skip = own_folders(root, &claude_dir, &codex_dir);
        skip.push(std::env::temp_dir());
        Home {
            root: root.to_path_buf(),
            recorded: root.display().to_string(),
            config,
            data,
            claude_dir,
            claude_json,
            codex_dir,
            wsl: None,
            skip,
        }
    }

    /// A Linux home with every tool where it keeps itself by default: a distro's, or a plain one in a test.
    fn linux(root: &Path, recorded: &str, wsl: Option<(String, PathBuf)>) -> Home {
        let (claude_dir, codex_dir) = (root.join(".claude"), root.join(".codex"));
        Home {
            root: root.to_path_buf(),
            recorded: recorded.to_string(),
            config: root.join(".config"),
            data: root.join(".local").join("share"),
            skip: own_folders(root, &claude_dir, &codex_dir),
            claude_json: root.join(".claude.json"),
            claude_dir,
            codex_dir,
            wsl,
        }
    }

    /// The home of `user` in the distro whose `/` is `root`.
    fn of_user(name: &str, root: &Path, user: &str) -> Home {
        Home::linux(
            &root.join("home").join(user),
            &format!("/home/{user}"),
            Some((name.to_string(), root.to_path_buf())),
        )
    }

    fn distro(&self) -> Option<String> {
        self.wsl.as_ref().map(|(name, _)| name.clone())
    }

    /// A folder a tool recorded, as this process opens it: a distro's Linux path is put under the distro's root,
    /// and anything that is not an absolute path is no folder at all.
    fn host_path(&self, recorded: &str) -> Option<PathBuf> {
        let recorded = recorded.trim();
        match &self.wsl {
            None => Some(PathBuf::from(recorded)).filter(|path| path.is_absolute()),
            Some((_, root)) => {
                if !recorded.starts_with('/') {
                    return None;
                }
                let mut path = root.clone();
                for segment in recorded.split('/').filter(|segment| !segment.is_empty()) {
                    path.push(segment);
                }
                Some(path)
            }
        }
    }
}

/// Everything this computer's tools say, read from its own home and every running distro's.
fn scan_machine(home: &Path, projects: &[Project]) -> Found {
    let mut homes = vec![Home::native(home)];
    let distros = running_distros();
    for (name, root) in &distros {
        homes.extend(distro_homes(name, root));
    }
    scan(&homes, &distros, projects)
}

fn scan(homes: &[Home], distros: &[(String, PathBuf)], projects: &[Project]) -> Found {
    let mut providers = Providers::default();
    let mut candidates = Candidates::default();
    for home in homes {
        claude_code(home, &mut providers, &mut candidates);
        codex(home, &mut providers, &mut candidates);
        gemini_cli(home, &mut providers);
        opencode(home, &mut providers);
        hermes(home, &mut providers);
        openclaw(home, &mut providers);
        editors(home, distros, &mut candidates);
        jetbrains(home, &mut candidates);
    }
    Found {
        providers: providers.0,
        projects: candidates.finish(projects),
    }
}

/// The distros running now, by name, each with its `/` as Windows reaches it. Never one that is stopped: reading its
/// files would start it, which is a minute of somebody's memory spent on a guess. Also how the machine agents of this
/// PC's distros are found (agents.rs).
#[cfg(windows)]
pub(crate) fn running_distros() -> Vec<(String, PathBuf)> {
    let mut command = std::process::Command::new("wsl.exe");
    command.args(["--list", "--running", "--quiet"]);
    // UTF-8 instead of the UTF-16 wsl.exe prints to anything that is not a console.
    command.env("WSL_UTF8", "1");
    intentic_bounded::no_window(&mut command);
    let Ok(ran) = intentic_bounded::capture(
        command,
        Duration::from_secs(5),
        intentic_bounded::Reach::Child,
    ) else {
        return Vec::new();
    };
    if !ran.success() {
        return Vec::new();
    }
    distro_names(&ran.stdout)
        .into_iter()
        .map(|name| {
            let root = PathBuf::from(format!(r"\\wsl.localhost\{name}"));
            (name, root)
        })
        .collect()
}

#[cfg(not(windows))]
pub(crate) fn running_distros() -> Vec<(String, PathBuf)> {
    Vec::new()
}

/// `wsl --list --quiet` as names: NULs dropped in case it answered in UTF-16 anyway, Docker Desktop's own distros
/// skipped, since nobody's code lives in them.
#[cfg_attr(not(windows), allow(dead_code))]
fn distro_names(listing: &str) -> Vec<String> {
    listing
        .replace(['\0', '\u{feff}'], "")
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.starts_with("docker-desktop"))
        .map(str::to_string)
        .collect()
}

/// The people's homes in a distro: each folder under its `/home`.
fn distro_homes(name: &str, root: &Path) -> Vec<Home> {
    let Ok(entries) = fs::read_dir(root.join("home")) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .take(8)
        .map(|entry| Home::of_user(name, root, &entry.file_name().to_string_lossy()))
        .collect()
}

/// The folders of a home that hold nobody's project: Intentic's own (its sandboxes' folders, `~/intentic`) and the
/// tools' own, whose histories are what is being read.
fn own_folders(root: &Path, claude_dir: &Path, codex_dir: &Path) -> Vec<PathBuf> {
    vec![
        root.join("intentic"),
        root.join(".intentic"),
        claude_dir.to_path_buf(),
        codex_dir.to_path_buf(),
        root.join(".cursor"),
        root.join(".gemini"),
        root.join(".hermes"),
        root.join(".openclaw"),
    ]
}

/* THE SUBSCRIPTIONS */

#[derive(Default)]
struct Providers(Vec<FoundProvider>);

impl Providers {
    /// One more sighting of `provider`: the first email and plan read stand, and having been seen outside a distro
    /// is what it is said to be.
    fn add(
        &mut self,
        provider: &'static str,
        tool: &'static str,
        email: Option<String>,
        plan: Option<String>,
        home: &Home,
    ) {
        let wsl = home.distro();
        if let Some(found) = self.0.iter_mut().find(|found| found.provider == provider) {
            if !found.tools.contains(&tool) {
                found.tools.push(tool);
            }
            found.email = found.email.take().or(email);
            found.plan = found.plan.take().or(plan);
            if wsl.is_none() {
                found.wsl = None;
            }
            return;
        }
        self.0.push(FoundProvider {
            provider,
            tools: vec![tool],
            email,
            plan,
            wsl,
        });
    }
}

/// Claude Code: `.credentials.json` holds the login, `.claude.json` the account it is for. A login kept in the system's
/// keychain leaves no credentials file, only the account, so the account alone counts when the file is not there.
fn claude_code(home: &Home, providers: &mut Providers, candidates: &mut Candidates) {
    let account = read_json(&home.claude_json);
    for folder in account
        .as_ref()
        .and_then(|account| account.get("projects"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|projects| projects.keys())
    {
        candidates.add(home, folder, "claude-code", None);
    }
    claude_sessions(home, candidates);

    let credentials = read_json(&home.claude_dir.join(".credentials.json"));
    let login = credentials
        .as_ref()
        .and_then(|file| file.get("claudeAiOauth"));
    let profile = account
        .as_ref()
        .and_then(|account| account.get("oauthAccount"));
    let signed_in = login
        .is_some_and(|login| has_text(login, "refreshToken") || has_text(login, "accessToken"))
        || (credentials.is_none()
            && profile.is_some_and(|profile| has_text(profile, "emailAddress")));
    if signed_in {
        providers.add(
            "claude",
            "claude-code",
            profile.and_then(|profile| text(profile, "emailAddress")),
            login.and_then(|login| text(login, "subscriptionType")),
            home,
        );
    }
}

/// Each of Claude Code's project folders holds its sessions, and the newest one's first lines say where it ran: the
/// folder's own name is the path with every separator turned into `-`, which cannot be read back.
fn claude_sessions(home: &Home, candidates: &mut Candidates) {
    for folder in newest_entries(&home.claude_dir.join("projects"), SESSIONS, true) {
        let sessions = newest_entries(&folder, 3, false);
        let newest = sessions.first().and_then(|file| modified(file));
        for session in sessions.iter().filter(|file| has_extension(file, "jsonl")) {
            if let Some(cwd) = first_text(session, &["cwd"]) {
                candidates.add(home, &cwd, "claude-code", newest);
                break;
            }
        }
    }
}

/// Codex: `auth.json` in ChatGPT mode is a subscription, its `id_token` naming the account and the plan. The token is
/// an identity claim decoded here and dropped; nothing that signs a request is read. An API-key login is not a
/// subscription, and its key is the sandbox's to import, not this app's.
fn codex(home: &Home, providers: &mut Providers, candidates: &mut Candidates) {
    if let Ok(config) = read_head(&home.codex_dir.join("config.toml"), HEAD_BYTES) {
        for folder in toml_projects(&config) {
            candidates.add(home, &folder, "codex", None);
        }
    }
    for session in codex_sessions(&home.codex_dir.join("sessions")) {
        if let Some(cwd) = first_text(&session, &["payload", "cwd"]) {
            candidates.add(home, &cwd, "codex", modified(&session));
        }
    }

    let Some(auth) = read_json(&home.codex_dir.join("auth.json")) else {
        return;
    };
    let tokens = auth.get("tokens").filter(|tokens| tokens.is_object());
    let chatgpt = auth.get("auth_mode").and_then(Value::as_str) == Some("chatgpt")
        || tokens.is_some_and(|tokens| has_text(tokens, "refresh_token"));
    if !chatgpt {
        return;
    }
    let claims = tokens
        .and_then(|tokens| text(tokens, "id_token"))
        .and_then(|jwt| jwt_claims(&jwt));
    let email = claims.as_ref().and_then(|claims| text(claims, "email"));
    let plan = claims
        .as_ref()
        .and_then(|claims| claims.get("https://api.openai.com/auth"))
        .and_then(|auth| text(auth, "chatgpt_plan_type"));
    providers.add("codex", "codex", email, plan, home);
}

/// Codex keeps a session per file under `sessions/<year>/<month>/<day>/`; the newest days are read first, and only as
/// many files as [`SESSIONS`].
fn codex_sessions(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for year in descending(root) {
        for month in descending(&year) {
            for day in descending(&month) {
                let mut sessions: Vec<PathBuf> = descending(&day)
                    .into_iter()
                    .filter(|file| has_extension(file, "jsonl"))
                    .collect();
                sessions.truncate(SESSIONS - files.len());
                files.extend(sessions);
                if files.len() >= SESSIONS {
                    return files;
                }
            }
        }
    }
    files
}

/// Gemini CLI signed in with Google: `oauth_creds.json`, the account in `google_accounts.json`.
fn gemini_cli(home: &Home, providers: &mut Providers) {
    let dir = home.root.join(".gemini");
    let Some(login) = read_json(&dir.join("oauth_creds.json")) else {
        return;
    };
    if !has_text(&login, "refresh_token") && !has_text(&login, "access_token") {
        return;
    }
    let email =
        read_json(&dir.join("google_accounts.json")).and_then(|accounts| text(&accounts, "active"));
    providers.add("gemini", "gemini-cli", email, None, home);
}

/// opencode's `auth.json`: one entry per provider, `type: "oauth"` for a subscription it signed in to. OpenCode 2 moves
/// these into its SQLite database (`opencode.db`) on its first run and leaves the file, so a login made only under
/// OpenCode 2 is not found here.
fn opencode(home: &Home, providers: &mut Providers) {
    let Some(auth) = read_json(&home.data.join("opencode").join("auth.json")) else {
        return;
    };
    for (id, entry) in auth.as_object().into_iter().flatten() {
        if text(entry, "type").as_deref() == Some("oauth") {
            if let Some(provider) = subscription_of(id) {
                providers.add(provider, "opencode", None, None, home);
            }
        }
    }
}

/// Hermes Agent's `auth.json`: the logins it holds itself under `providers`, and its credential pool, whose OAuth
/// entries are subscriptions (an `api_key` entry is the sandbox's importer's).
fn hermes(home: &Home, providers: &mut Providers) {
    let Some(auth) = read_json(&home.root.join(".hermes").join("auth.json")) else {
        return;
    };
    for (id, entry) in auth
        .get("providers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if holds_login(entry, 3) {
            if let Some(provider) = subscription_of(id) {
                providers.add(provider, "hermes", None, None, home);
            }
        }
    }
    for (id, entries) in auth
        .get("credential_pool")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let oauth = entries.as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| text(entry, "auth_type").as_deref() == Some("oauth"))
        });
        if oauth {
            if let Some(provider) = subscription_of(id) {
                providers.add(provider, "hermes", None, None, home);
            }
        }
    }
}

/// OpenClaw keeps a profile file per agent (`agents/<id>/agent/auth-profiles.json`); a profile of type `oauth`, or
/// `token` for a Claude setup token, is a subscription.
fn openclaw(home: &Home, providers: &mut Providers) {
    for agent in newest_entries(&home.root.join(".openclaw").join("agents"), 8, true) {
        let Some(file) = read_json(&agent.join("agent").join("auth-profiles.json")) else {
            continue;
        };
        let profiles = file.get("profiles").unwrap_or(&file);
        for profile in profiles
            .as_object()
            .into_iter()
            .flat_map(|profiles| profiles.values())
        {
            let kind = text(profile, "type").or_else(|| text(profile, "mode"));
            if !matches!(kind.as_deref(), Some("oauth" | "token")) {
                continue;
            }
            if let Some(provider) = text(profile, "provider").and_then(|id| subscription_of(&id)) {
                providers.add(provider, "openclaw", text(profile, "email"), None, home);
            }
        }
    }
}

/// The sandbox's provider for a tool's own name for a subscription login, or nothing for one the sandbox does not
/// sign in to.
fn subscription_of(id: &str) -> Option<&'static str> {
    match id.to_ascii_lowercase().as_str() {
        "anthropic" | "claude" | "claude-code" => Some("claude"),
        "openai" | "openai-codex" | "codex" | "chatgpt" => Some("codex"),
        "xai" | "grok" => Some("grok"),
        "kimi" | "kimi-for-coding" | "moonshot" | "moonshotai" => Some("kimi"),
        "google" | "gemini" | "google-gemini-cli" | "google-antigravity" => Some("gemini"),
        _ => None,
    }
}

/// Whether an entry holds a login of its own: a token field anywhere within `depth` levels.
fn holds_login(entry: &Value, depth: usize) -> bool {
    match entry {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            (matches!(
                key.as_str(),
                "access_token" | "refresh_token" | "access" | "refresh"
            ) && value.as_str().is_some_and(|token| !token.is_empty()))
                || (depth > 0 && holds_login(value, depth - 1))
        }),
        _ => false,
    }
}

/// The claims of a JWT, unverified: who it names, never whether to trust it.
fn jwt_claims(jwt: &str) -> Option<Value> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/* THE PROJECTS */

/// The editors of the VS Code family, by their folder under the config folder.
const EDITORS: [(&str, &str); 5] = [
    ("Code", "vscode"),
    ("Code - Insiders", "vscode"),
    ("Cursor", "cursor"),
    ("VSCodium", "vscodium"),
    ("Windsurf", "windsurf"),
];

/// The VS Code family's `storage.json`: the windows open when it last closed and the folders it keeps backups for.
/// Its full recent list is in a SQLite file this app has no reader for; the last windows are the folders that matter.
fn editors(home: &Home, distros: &[(String, PathBuf)], candidates: &mut Candidates) {
    for (dir, source) in EDITORS {
        let storage = home
            .config
            .join(dir)
            .join("User")
            .join("globalStorage")
            .join("storage.json");
        let Some(state) = read_json(&storage) else {
            continue;
        };
        let when = modified(&storage);
        let mut uris: Vec<String> = Vec::new();
        let windows = state.get("windowsState");
        uris.extend(
            windows
                .and_then(|windows| windows.get("lastActiveWindow"))
                .and_then(|window| text(window, "folder")),
        );
        for window in windows
            .and_then(|windows| windows.get("openedWindows"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            uris.extend(text(window, "folder"));
        }
        for folder in state
            .get("backupWorkspaces")
            .and_then(|backups| backups.get("folders"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            uris.extend(text(folder, "folderUri"));
        }
        for uri in uris {
            match folder_of_uri(&uri) {
                Some(EditorFolder::Local(path)) => candidates.add(home, &path, source, when),
                // A VS Code on Windows working in a distro: the folder is that distro's, reached the way its own
                // home is, and only while it runs.
                Some(EditorFolder::Wsl { distro, path }) => {
                    if let Some((name, root)) = distros
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case(&distro))
                    {
                        // Under the home of the user it is in, so that home's own folders are known as such.
                        let user = path
                            .strip_prefix("/home/")
                            .and_then(|rest| rest.split('/').next());
                        let inside = match user {
                            Some(user) if !user.is_empty() => Home::of_user(name, root, user),
                            _ => Home::linux(root, "/", Some((name.clone(), root.clone()))),
                        };
                        candidates.add(&inside, &path, source, when);
                    }
                }
                None => {}
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum EditorFolder {
    Local(String),
    Wsl { distro: String, path: String },
}

/// A folder URI as the VS Code family writes it: `file:///c%3A/Users/ada/app`, `file:///home/ada/app`, or
/// `vscode-remote://wsl%2Barchlinux/home/ada/app`. Any other remote (SSH, a container) is a folder of another machine.
fn folder_of_uri(uri: &str) -> Option<EditorFolder> {
    if let Some(rest) = uri.strip_prefix("file://") {
        let path = percent_decode(rest.strip_prefix("localhost").unwrap_or(rest));
        let bytes = path.as_bytes();
        // `/c:/Users/…`: a drive's path, with the URI's leading slash and its forward slashes.
        if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':'
        {
            return Some(EditorFolder::Local(path[1..].replace('/', "\\")));
        }
        return Some(EditorFolder::Local(path));
    }
    let rest = uri.strip_prefix("vscode-remote://")?;
    let (authority, path) = rest.split_once('/')?;
    let distro = percent_decode(authority).strip_prefix("wsl+")?.to_string();
    Some(EditorFolder::Wsl {
        distro,
        path: format!("/{}", percent_decode(path)),
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let hex = |byte: u8| (byte as char).to_digit(16);
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// JetBrains' IDEs: `<product><version>/options/recentProjects.xml` under the config folder's `JetBrains`.
fn jetbrains(home: &Home, candidates: &mut Candidates) {
    for product in newest_entries(&home.config.join("JetBrains"), 12, true) {
        let Ok(xml) = read_head(
            &product.join("options").join("recentProjects.xml"),
            2 * 1024 * 1024,
        ) else {
            continue;
        };
        for (folder, opened) in recent_projects_xml(&xml) {
            let folder = folder.replace("$USER_HOME$", &home.recorded);
            candidates.add(home, &folder, "jetbrains", opened);
        }
    }
}

/// The projects of a `recentProjects.xml`: each `<entry key="…">` that names a folder, with the newest of its
/// `projectOpenTimestamp` and `activationTimestamp` (milliseconds), when it has one.
fn recent_projects_xml(xml: &str) -> Vec<(String, Option<u64>)> {
    const OPEN: &str = "<entry key=\"";
    let mut projects = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(OPEN) {
        rest = &rest[start + OPEN.len()..];
        let Some(end) = rest.find('"') else {
            break;
        };
        let key = xml_unescape(&rest[..end]);
        let body_end = rest.find("</entry>").unwrap_or(rest.len());
        let body = &rest[..body_end];
        let names_folder = key.starts_with('/')
            || key.starts_with("$USER_HOME$")
            || key.as_bytes().get(1) == Some(&b':');
        if names_folder {
            let opened = ["projectOpenTimestamp", "activationTimestamp"]
                .iter()
                .filter_map(|name| xml_option(body, name))
                .max()
                .map(|millis| millis / 1000);
            projects.push((key, opened));
        }
        rest = &rest[end..];
    }
    projects
}

/// The value of `<option name="name" value="…" />` in `body`, as a number.
fn xml_option(body: &str, name: &str) -> Option<u64> {
    let marker = format!("name=\"{name}\" value=\"");
    let start = body.find(&marker)? + marker.len();
    let end = body[start..].find('"')? + start;
    body[start..end].parse().ok()
}

fn xml_unescape(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The table names of a Codex `config.toml`'s `[projects."<path>"]` tables: the folders it was told to trust.
fn toml_projects(toml: &str) -> Vec<String> {
    toml.lines()
        .filter_map(|line| {
            let inner = line.trim().strip_prefix("[projects.")?.strip_suffix(']')?;
            if let Some(quoted) = inner
                .strip_prefix('"')
                .and_then(|rest| rest.strip_suffix('"'))
            {
                return Some(
                    quoted
                        .replace("\\\\", "\u{0}")
                        .replace("\\\"", "\"")
                        .replace('\u{0}', "\\"),
                );
            }
            inner
                .strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
                .map(str::to_string)
        })
        .collect()
}

/// A folder seen in some history, gathered by where this process opens it.
struct Candidate {
    host: PathBuf,
    shown: String,
    sources: Vec<&'static str>,
    last_active: Option<u64>,
    wsl: Option<String>,
    /// The home it was found under, which it must not be.
    home: PathBuf,
    /// That home's [`Home::skip`].
    own: Vec<PathBuf>,
}

#[derive(Default)]
struct Candidates(HashMap<String, Candidate>);

impl Candidates {
    fn add(&mut self, home: &Home, recorded: &str, source: &'static str, when: Option<u64>) {
        let recorded = recorded.trim().trim_end_matches(['/', '\\']);
        let Some(host) = home.host_path(recorded) else {
            return;
        };
        let key = key_of(&host);
        let candidate = self.0.entry(key).or_insert_with(|| Candidate {
            host: host.clone(),
            shown: recorded.to_string(),
            sources: Vec::new(),
            last_active: None,
            wsl: home.distro(),
            home: home.root.clone(),
            own: home.skip.clone(),
        });
        if !candidate.sources.contains(&source) {
            candidate.sources.push(source);
        }
        candidate.last_active = candidate.last_active.max(when);
    }

    /// The folders worth offering, newest first: there now, a folder, nobody's whole home or the system's, not a tool's
    /// or Intentic's own, and not a folder that only holds others that were found (`~/repositories`, where somebody
    /// once started a session) unless it is a repository itself.
    fn finish(self, projects: &[Project]) -> Vec<FoundProject> {
        let mut kept: Vec<Candidate> = self
            .0
            .into_values()
            .filter(|candidate| {
                fs::metadata(&candidate.host).is_ok_and(|meta| meta.is_dir())
                    && crate::project::refusal(&candidate.host, Some(&candidate.home), &[])
                        .is_none()
                    && !linux_system(&candidate.shown, candidate.wsl.is_some())
                    && !candidate
                        .own
                        .iter()
                        .any(|own| candidate.host.starts_with(own))
            })
            .collect();
        let hosts: Vec<PathBuf> = kept
            .iter()
            .map(|candidate| candidate.host.clone())
            .collect();
        kept.retain(|candidate| {
            let holds_another = hosts
                .iter()
                .any(|other| other != &candidate.host && other.starts_with(&candidate.host));
            !holds_another || candidate.host.join(".git").exists()
        });
        kept.sort_by(|left, right| {
            right
                .last_active
                .cmp(&left.last_active)
                .then(right.sources.len().cmp(&left.sources.len()))
                .then(left.shown.cmp(&right.shown))
        });
        kept.truncate(PROJECTS);
        kept.into_iter()
            .map(|candidate| {
                let name = candidate.host.file_name().map_or_else(
                    || candidate.shown.clone(),
                    |name| name.to_string_lossy().to_string(),
                );
                FoundProject {
                    path: candidate.host.display().to_string(),
                    git: candidate.host.join(".git").exists(),
                    sandbox: projects
                        .iter()
                        .any(|project| Path::new(&project.path) == candidate.host),
                    shown: candidate.shown,
                    name,
                    sources: candidate.sources,
                    last_active: candidate.last_active,
                    wsl: candidate.wsl,
                }
            })
            .collect()
    }
}

/// A folder of a distro's system, refused as project.rs refuses this computer's own.
fn linux_system(shown: &str, in_distro: bool) -> bool {
    const SYSTEM: [&str; 12] = [
        "/bin",
        "/boot",
        "/dev",
        "/etc",
        "/lib",
        "/proc",
        "/sbin",
        "/sys",
        "/usr",
        "/var",
        "/tmp",
        "/mnt/wslg",
    ];
    in_distro
        && (shown == "/"
            || shown == "/home"
            || SYSTEM
                .iter()
                .any(|root| shown == *root || shown.starts_with(&format!("{root}/"))))
}

/// The key two spellings of one folder share: Windows' paths are the same folder whatever their case.
fn key_of(path: &Path) -> String {
    let text = path.display().to_string();
    if cfg!(windows) {
        text.to_lowercase().replace('/', "\\")
    } else {
        text
    }
}

/* READING */

fn read_head(path: &Path, limit: u64) -> std::io::Result<String> {
    let mut text = String::new();
    fs::File::open(path)?
        .take(limit)
        .read_to_string(&mut text)?;
    Ok(text)
}

/// A JSON file, or nothing for one that is not there, too big to be a settings file, or not JSON.
fn read_json(path: &Path) -> Option<Value> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 8 * 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// The first string at `keys` in the first lines of a JSON-lines file.
fn first_text(path: &Path, keys: &[&str]) -> Option<String> {
    let mut head = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(HEAD_BYTES)
        .read_to_end(&mut head)
        .ok()?;
    head.split(|byte| *byte == b'\n').take(60).find_map(|line| {
        let value: Value = serde_json::from_slice(line).ok()?;
        let mut at = &value;
        for key in keys {
            at = at.get(key)?;
        }
        at.as_str()
            .map(str::to_string)
            .filter(|text| !text.is_empty())
    })
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn has_text(value: &Value, key: &str) -> bool {
    text(value, key).is_some()
}

fn modified(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_secs())
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension().is_some_and(|found| found == extension)
}

/// A folder's entries, newest first by modification time, at most `limit`; only folders when `folders`.
fn newest_entries(dir: &Path, limit: usize, folders: bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dated: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir() == folders))
        .map(|entry| {
            let when = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(UNIX_EPOCH);
            (when, entry.path())
        })
        .collect();
    dated.sort_by_key(|(when, _)| std::cmp::Reverse(*when));
    dated
        .into_iter()
        .take(limit)
        .map(|(_, path)| path)
        .collect()
}

/// A folder's entries by name, last first: Codex names its days and sessions so that this is newest first.
fn descending(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    paths.reverse();
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCESS: &str = "sk-ant-oat01-ACCESS-never-shown";
    const REFRESH: &str = "sk-ant-ort01-REFRESH-never-shown";
    const CODEX_REFRESH: &str = "rt_CODEX-REFRESH-never-shown";

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("intentic-found-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn jwt(claims: &Value) -> String {
        let encode = |value: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value);
        format!(
            "{}.{}.signature",
            encode(b"{\"alg\":\"RS256\"}"),
            encode(claims.to_string().as_bytes())
        )
    }

    /// A lived-in Linux home: Claude Code and Codex signed in, Hermes and opencode holding logins of their own, and
    /// the folders their histories name, some real and some not.
    fn lived_in(root: &Path) -> Home {
        let home = Home::linux(root, &root.display().to_string(), None);
        let code = root.join("repositories");
        for project in ["app", "api", "notes"] {
            fs::create_dir_all(code.join(project)).unwrap();
        }
        fs::create_dir_all(code.join("app").join(".git")).unwrap();
        fs::create_dir_all(root.join("intentic").join("workspace-1").join("app")).unwrap();
        let path = |name: &str| code.join(name).display().to_string();

        write(
            &root.join(".claude").join(".credentials.json"),
            &serde_json::json!({ "claudeAiOauth": {
                "accessToken": ACCESS, "refreshToken": REFRESH, "expiresAt": 1, "subscriptionType": "max",
            }})
            .to_string(),
        );
        write(
            &root.join(".claude.json"),
            &serde_json::json!({
                "oauthAccount": { "emailAddress": "ada@example.com", "organizationName": "Example Org" },
                "projects": { code.display().to_string(): {}, path("api"): {}, "/nowhere/gone": {} },
            })
            .to_string(),
        );
        write(
            &root
                .join(".claude")
                .join("projects")
                .join("-repositories-app")
                .join("one.jsonl"),
            &format!(
                "{{\"type\":\"summary\"}}\n{}\n",
                serde_json::json!({ "cwd": path("app"), "type": "user" })
            ),
        );
        write(
            &root
                .join(".claude")
                .join("projects")
                .join("-intentic-workspace-1-app")
                .join("two.jsonl"),
            &format!(
                "{}\n",
                serde_json::json!({ "cwd": root.join("intentic").join("workspace-1").join("app").display().to_string() })
            ),
        );

        write(
            &root.join(".codex").join("auth.json"),
            &serde_json::json!({
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": null,
                "tokens": {
                    "id_token": jwt(&serde_json::json!({
                        "email": "ada@example.com",
                        "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" },
                    })),
                    "access_token": "codex-access",
                    "refresh_token": CODEX_REFRESH,
                },
            })
            .to_string(),
        );
        write(
            &root.join(".codex").join("config.toml"),
            &format!("model = \"gpt-5\"\n[projects.\"{}\"]\ntrust_level = \"trusted\"\n[mcp_servers.x]\n", path("notes")),
        );
        write(
            &root
                .join(".codex")
                .join("sessions")
                .join("2026")
                .join("10")
                .join("01")
                .join("rollout-a.jsonl"),
            &format!(
                "{}\n",
                serde_json::json!({ "type": "session_meta", "payload": { "cwd": path("api") } })
            ),
        );

        write(
            &root.join(".hermes").join("auth.json"),
            &serde_json::json!({
                "version": 1,
                "providers": { "openai-codex": { "tokens": { "access_token": "h", "refresh_token": "h2" } } },
                "credential_pool": {
                    "anthropic": [{ "auth_type": "oauth", "source": "claude_code" }],
                    "openrouter": [{ "auth_type": "api_key" }],
                },
            })
            .to_string(),
        );
        write(
            &root
                .join(".local")
                .join("share")
                .join("opencode")
                .join("auth.json"),
            &serde_json::json!({
                "xai": { "type": "oauth", "access": "x", "refresh": "y", "expires": 1 },
                "openrouter": { "type": "api", "key": "sk-or-never-shown" },
            })
            .to_string(),
        );
        write(
            &root.join(".config").join("Code").join("User").join("globalStorage").join("storage.json"),
            &serde_json::json!({
                "windowsState": { "lastActiveWindow": { "folder": format!("file://{}", path("notes")) } },
                "backupWorkspaces": { "folders": [{ "folderUri": "vscode-remote://ssh-remote%2Bbox/srv/app" }] },
            })
            .to_string(),
        );
        home
    }

    #[test]
    fn it_names_the_subscriptions_signed_in_here_and_never_their_tokens() {
        let root = scratch("subscriptions");
        let found = scan(&[lived_in(&root)], &[], &[]);

        let claude = found
            .providers
            .iter()
            .find(|found| found.provider == "claude")
            .unwrap();
        assert_eq!(claude.tools, vec!["claude-code", "hermes"]);
        assert_eq!(claude.email.as_deref(), Some("ada@example.com"));
        assert_eq!(claude.plan.as_deref(), Some("max"));
        assert_eq!(claude.wsl, None);
        let codex = found
            .providers
            .iter()
            .find(|found| found.provider == "codex")
            .unwrap();
        assert_eq!(codex.tools, vec!["codex", "hermes"]);
        assert_eq!(codex.plan.as_deref(), Some("plus"));
        assert!(found
            .providers
            .iter()
            .any(|found| found.provider == "grok" && found.tools == vec!["opencode"]));
        // An API key is the sandbox importer's, not a subscription.
        assert!(!found
            .providers
            .iter()
            .any(|found| found.tools.contains(&"opencode") && found.provider == "codex"));

        let said = serde_json::to_string(&found).unwrap();
        for secret in [
            ACCESS,
            REFRESH,
            CODEX_REFRESH,
            "codex-access",
            "sk-or-never-shown",
            "id_token",
        ] {
            assert!(!said.contains(secret), "{secret} reached the page");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn it_offers_the_folders_their_histories_name_newest_first_and_nothing_of_its_own() {
        let root = scratch("projects");
        let found = scan(&[lived_in(&root)], &[], &[]);
        let names: Vec<&str> = found
            .projects
            .iter()
            .map(|project| project.name.as_str())
            .collect();
        // `repositories` only holds the others; the Intentic folder and a folder that is gone are never offered.
        assert_eq!(names.len(), 3, "{names:?}");
        for name in ["app", "api", "notes"] {
            assert!(names.contains(&name), "{name} missing from {names:?}");
        }
        let api = found
            .projects
            .iter()
            .find(|project| project.name == "api")
            .unwrap();
        assert_eq!(api.sources, vec!["claude-code", "codex"]);
        let notes = found
            .projects
            .iter()
            .find(|project| project.name == "notes")
            .unwrap();
        assert_eq!(notes.sources, vec!["codex", "vscode"]);
        let app = found
            .projects
            .iter()
            .find(|project| project.name == "app")
            .unwrap();
        assert!(app.git);
        assert!(!api.git);
        // Every one carries a time, so the ones without fall behind them.
        assert!(found
            .projects
            .iter()
            .all(|project| project.last_active.is_some()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_folder_with_a_sandbox_says_so() {
        let root = scratch("sandbox");
        let home = lived_in(&root);
        let app = root.join("repositories").join("app").display().to_string();
        let projects = [Project {
            path: app.clone(),
            dir: "app".into(),
            sandbox_id: None,
            slug: None,
        }];
        let found = scan(&[home], &[], &projects);
        assert!(found
            .projects
            .iter()
            .any(|project| project.path == app && project.sandbox));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_distro_home_is_read_through_its_root_and_says_which_distro() {
        let distro = scratch("distro");
        let home_root = distro.join("home").join("ada");
        fs::create_dir_all(distro.join("home").join("ada").join("work").join("site")).unwrap();
        fs::create_dir_all(distro.join("usr").join("share")).unwrap();
        write(
            &home_root.join(".codex").join("config.toml"),
            "[projects.\"/home/ada/work/site\"]\n[projects.\"/usr/share\"]\n[projects.\"C:\\\\Users\\\\ada\"]\n",
        );
        write(
            &home_root.join(".claude").join(".credentials.json"),
            &serde_json::json!({ "claudeAiOauth": { "refreshToken": REFRESH } }).to_string(),
        );
        let homes = distro_homes("archlinux", &distro);
        assert_eq!(homes.len(), 1);
        assert_eq!(homes[0].recorded, "/home/ada");
        let found = scan(&homes, &[("archlinux".to_string(), distro.clone())], &[]);
        assert_eq!(found.projects.len(), 1, "{:?}", found.projects);
        let site = &found.projects[0];
        assert_eq!(site.shown, "/home/ada/work/site");
        assert_eq!(
            PathBuf::from(&site.path),
            distro.join("home").join("ada").join("work").join("site")
        );
        assert_eq!(site.wsl.as_deref(), Some("archlinux"));
        assert_eq!(found.providers[0].wsl.as_deref(), Some("archlinux"));
        fs::remove_dir_all(distro).unwrap();
    }

    #[test]
    fn a_windows_editor_in_a_running_distro_reaches_the_distros_folder() {
        let distro = scratch("editor-distro");
        fs::create_dir_all(distro.join("home").join("ada").join("blog")).unwrap();
        let native_root = scratch("editor-native");
        write(
            &native_root
                .join(".config")
                .join("Code")
                .join("User")
                .join("globalStorage")
                .join("storage.json"),
            &serde_json::json!({ "backupWorkspaces": { "folders": [
                { "folderUri": "vscode-remote://wsl%2Barchlinux/home/ada/blog" },
                { "folderUri": "vscode-remote://wsl%2Bubuntu/home/ada/stopped" },
            ]}})
            .to_string(),
        );
        let native = Home::linux(&native_root, &native_root.display().to_string(), None);
        let found = scan(&[native], &[("archlinux".to_string(), distro.clone())], &[]);
        assert_eq!(found.projects.len(), 1);
        assert_eq!(found.projects[0].wsl.as_deref(), Some("archlinux"));
        assert_eq!(found.projects[0].shown, "/home/ada/blog");
        fs::remove_dir_all(distro).unwrap();
        fs::remove_dir_all(native_root).unwrap();
    }

    #[test]
    fn folder_uris_read_as_the_editor_meant_them() {
        assert_eq!(
            folder_of_uri("file:///c%3A/Users/ada/My%20App"),
            Some(EditorFolder::Local(r"c:\Users\ada\My App".to_string()))
        );
        assert_eq!(
            folder_of_uri("file:///home/ada/app"),
            Some(EditorFolder::Local("/home/ada/app".to_string()))
        );
        assert_eq!(
            folder_of_uri("vscode-remote://wsl%2Barchlinux/home/ada/app"),
            Some(EditorFolder::Wsl {
                distro: "archlinux".to_string(),
                path: "/home/ada/app".to_string()
            })
        );
        assert_eq!(
            folder_of_uri("vscode-remote://ssh-remote%2Bbox/srv/app"),
            None
        );
        assert_eq!(
            folder_of_uri("vscode-remote://dev-container%2Babc/workspaces/app"),
            None
        );
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%41"), "%zzA");
    }

    #[test]
    fn jetbrains_recent_projects_are_read_with_their_newest_time() {
        let xml = r#"<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>
            <entry key="$USER_HOME$/IdeaProjects/shop &amp; co">
              <value><RecentProjectMetaInfo><option name="activationTimestamp" value="1790000000000" />
              <option name="projectOpenTimestamp" value="1780000000000" /></RecentProjectMetaInfo></value>
            </entry>
            <entry key="C:/work/old"><value><RecentProjectMetaInfo /></value></entry>
            <entry key="not-a-path"><value /></entry>
        </map></option></component></application>"#;
        assert_eq!(
            recent_projects_xml(xml),
            vec![
                (
                    "$USER_HOME$/IdeaProjects/shop & co".to_string(),
                    Some(1_790_000_000)
                ),
                ("C:/work/old".to_string(), None),
            ]
        );
    }

    #[test]
    fn codex_project_tables_are_read_with_their_escapes() {
        let toml = "[projects.\"/home/ada/app\"]\n[projects.'C:\\work\\literal']\n[projects.\"C:\\\\work\\\\basic\"]\n[profiles.x]\n";
        assert_eq!(
            toml_projects(toml),
            vec![
                "/home/ada/app".to_string(),
                r"C:\work\literal".to_string(),
                r"C:\work\basic".to_string()
            ]
        );
    }

    #[test]
    fn distro_listings_drop_docker_and_utf16_padding() {
        assert_eq!(
            distro_names(
                "\u{feff}a\0r\0c\0h\0l\0i\0n\0u\0x\0\r\0\n\0docker-desktop\r\nUbuntu-24.04\r\n\r\n"
            ),
            vec!["archlinux".to_string(), "Ubuntu-24.04".to_string()]
        );
    }

    #[test]
    fn where_a_sandbox_is_first_met_the_address_carries_the_subscriptions_found() {
        let found = |provider| FoundProvider {
            provider,
            tools: vec!["x"],
            email: Some("ada@example.com".into()),
            plan: None,
            wsl: None,
        };
        let providers = [found("claude"), found("codex")];
        assert_eq!(
            path_with_found("/setup", &providers),
            "/setup?found=claude,codex"
        );
        assert_eq!(
            path_with_found("/setup?project=app&machine=mine", &providers),
            "/setup?project=app&machine=mine&found=claude,codex"
        );
        assert_eq!(path_with_found("/setup", &[]), "/setup");
        assert_eq!(
            path_with_found("/?sandbox=sbx_1", &providers),
            "/?sandbox=sbx_1"
        );
        assert_eq!(
            path_with_found("/?sandbox=sbx_1&project=api", &providers),
            "/?sandbox=sbx_1&project=api&found=claude,codex"
        );
        assert_eq!(path_with_found("/setupx", &providers), "/setupx");
        assert_eq!(
            path_with_found("/setup?found=gemini", &providers),
            "/setup?found=gemini"
        );
        assert!(!path_with_found("/setup", &providers).contains("ada@"));
    }
}
