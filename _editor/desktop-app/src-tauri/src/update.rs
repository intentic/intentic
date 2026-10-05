use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

/* This app is tray-resident by design — the × hides the workspace rather than ending the process (windows.rs) — and `main` cuts a release most days. */

/// Where a user goes when this app cannot update itself — the page that offers every artifact by name.
const DOWNLOADS_URL: &str = "https://intentic.dev/download";

/// Long enough for the first window to paint and for a handed-over setup to get going. The check is one small
/// JSON fetch, but a release-day launch would otherwise start a 100 MB download beside a container pull.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);

/// The resident cadence. A tray-resident app has to re-ask; this is the interval that made a machine left up
/// for a week check exactly once before.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// How stale the last check may be when the workspace comes back on screen before it is worth re-asking.
/// Cheaper than shortening `CHECK_EVERY` and it covers the case the interval cannot: a laptop that spent the
/// night asleep with this app in the tray wakes with a timer that has not fired.
const RECHECK_ON_SHOW_AFTER: Duration = Duration::from_secs(60 * 60);

/// After this many consecutive failures the app stops trying and says so. The population this exists for is
/// not having a bad afternoon — it is holding a pubkey that can never verify another release — and retrying
/// forever would only mean never telling them.
const GIVE_UP_AFTER: u32 = 3;

/* WHAT THE APP IS DOING ABOUT ITS OWN VERSION, as one value that every surface renders. */
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Stage {
    /// Nothing asked yet. The state every launch starts in and the only one with nothing to say.
    #[default]
    Idle,
    Checking,
    /// This build is the released one.
    Current,
    Downloading {
        version: String,
        percent: u8,
    },
    /// Downloaded, verified, on disk. The ONLY state that offers a button — an "Update" that then starts a
    /// download is the thing this module exists not to be.
    Ready {
        version: String,
    },
    /// This copy cannot replace itself: a deb/rpm install, or a manifest it will never be able to verify. The
    /// version is what we know of it, which for a failure may be nothing.
    Manual {
        version: Option<String>,
        reason: String,
        url: String,
    },
    /// A deb or rpm upgrade already replaced this app on disk while it ran ([`replaced_on_disk`]): only a restart onto
    /// it is left, and that is the offer, never a download of what is installed already.
    Installed,
}

impl Stage {
    /// What the tray entry says, and whether it can be clicked. The tray is the backstop surface, so it states
    /// the same fact the banner does rather than only appearing when there is something to press.
    fn tray(&self) -> (String, bool) {
        match self {
            Stage::Idle | Stage::Checking => ("Checking for updates…".into(), false),
            Stage::Current => ("Intentic is up to date".into(), false),
            Stage::Downloading { version, percent } => {
                (format!("Downloading {version}… {percent}%"), false)
            }
            Stage::Ready { version } => (format!("Restart to update to {version}"), true),
            Stage::Manual { version, .. } => match version {
                Some(version) => (format!("Download Intentic {version}"), true),
                None => ("Download the latest Intentic".into(), true),
            },
            Stage::Installed => ("Restart to use the new Intentic".into(), true),
        }
    }

    /// The version this app would move to, where one is known — what the workspace page is told.
    pub fn ready_version(&self) -> Option<&str> {
        match self {
            Stage::Ready { version } => Some(version.as_str()),
            _ => None,
        }
    }
}

/// Everything this app knows about its own next version. One managed value; `stage` is what the surfaces read
/// and the rest is what the worker needs to get from one to the next.
#[derive(Default)]
pub struct UpdateState {
    stage: Mutex<Stage>,
    /// The release `check()` returned, kept for as long as its download is staged — `install` is a method on
    /// it, so without this the bytes on disk could not be applied without asking the network again.
    ready: Mutex<Option<Staged>>,
    last_check: Mutex<Option<Instant>>,
    failures: Mutex<u32>,
    /// Set once, never cleared: the process is on its way out from the moment this is true, and a second
    /// installer racing the first is the one way this can leave a machine with no working app at all.
    installing: AtomicBool,
    /// The update is on disk and only the restart onto it is left, held because a local window had unsaved changes
    /// when it was due (Linux, the one platform `install` returns on). The offer then means that restart.
    restart_due: AtomicBool,
}

struct Staged {
    update: Update,
    file: PathBuf,
}

/// The tray's own row, held so its text can follow the state without rebuilding the menu (lib.rs builds it).
pub struct TrayUpdate(pub MenuItem<Wry>);

pub fn stage(app: &AppHandle) -> Stage {
    app.state::<UpdateState>().stage.lock().unwrap().clone()
}

/* The store and the three notifications are one function precisely so they cannot come apart. */
fn set(app: &AppHandle, next: Stage) {
    {
        let state = app.state::<UpdateState>();
        let mut held = state.stage.lock().unwrap();
        if *held == next {
            return;
        }
        *held = next.clone();
    }
    let _ = app.emit("desktop://update", next.clone());
    if let Some(tray) = app.try_state::<TrayUpdate>() {
        let (text, enabled) = next.tray();
        let _ = tray.0.set_text(text);
        let _ = tray.0.set_enabled(enabled);
    }
    announce_to_workspace(app, &next);
}

/* The workspace window is remote content with an empty capability list, and that does not change here. */
fn announce_to_workspace(app: &AppHandle, stage: &Stage) {
    let Some(window) = app.get_webview_window(crate::windows::WORKSPACE) else {
        return;
    };
    let Some(version) = stage.ready_version() else {
        return;
    };
    let script = format!(
        "window.dispatchEvent(new CustomEvent('intentic-desktop-update', {{ detail: {{ version: \"{}\" }} }}));",
        escape_js(version)
    );
    let _ = window.eval(&script);
}

/// Everything that would end a JavaScript string literal early. Deliberately not a JSON encoder: the only
/// values that reach it are semver strings off a signed manifest, and the point is that a surprise cannot
/// become a statement.
pub fn escape_js(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .flat_map(|character| match character {
            '\\' => vec!['\\', '\\'],
            '"' => vec!['\\', '"'],
            '\'' => vec!['\\', '\''],
            '<' => vec!['\\', 'u', '0', '0', '3', 'c'],
            other => vec![other],
        })
        .collect()
}

/* WHETHER THIS PROCESS CAN REPLACE ITSELF AT ALL, decided once, before anything is fetched. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Updatable {
    /// An artifact `latest.json` names: the NSIS installer, or the AppImage.
    Yes,
    /// A `.deb` or `.rpm` — real installs, with no artifact of their own in the manifest. Asked anyway, so
    /// the fact is stated only when there is something being missed (`check_now`).
    OtherPackaging,
    /// Nothing bundled this: `tauri dev`, a bare `cargo run`. It has no release to be behind, so it is not
    /// told anything at all rather than told it cannot update.
    NotARelease,
}

fn updatable() -> Updatable {
    use tauri::utils::config::BundleType;
    match tauri::utils::platform::bundle_type() {
        Some(BundleType::Deb) | Some(BundleType::Rpm) => Updatable::OtherPackaging,
        Some(_) => Updatable::Yes,
        None => Updatable::NotARelease,
    }
}

/* AN UPGRADE THE PACKAGE MANAGER ALREADY INSTALLED (2026-10-05).
 *
 * A deb or an rpm carries no maintainer script that ends or restarts this app (tauri.conf.json has none to give), so
 * after `apt upgrade` the old app and its file server ran on until Quit, and the next check offered the very release the
 * package manager had just installed, as a download. Linux keeps a running binary's file alive under the process even
 * once its path names another one, so the app asks: is the file at the path it was started from (Tauri reads it before
 * main) still the one running (`/proc/self/exe`)? Another file there is a newer install, and the offer becomes a
 * restart onto it. Only for deb and rpm: the AppImage and the Windows installer replace the app through this module, and
 * know it. No version is read off the new file: running it to ask would start a second copy of the app. */

/// A file's identity: its device and inode.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
type FileId = (u64, u64);

/// Whether the binary at the path this process started from is another file than the one it runs: replaced on disk.
/// A path with nothing there any more (the app uninstalled under itself) is not an install to restart onto. Pure.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn replaced(running: Option<FileId>, on_disk: Option<FileId>) -> bool {
    matches!((running, on_disk), (Some(running), Some(on_disk)) if running != on_disk)
}

#[cfg(target_os = "linux")]
fn replaced_on_disk() -> bool {
    use std::os::unix::fs::MetadataExt;
    let id = |metadata: std::io::Result<std::fs::Metadata>| {
        metadata
            .ok()
            .map(|metadata| (metadata.dev(), metadata.ino()))
    };
    let Ok(started) = tauri::utils::platform::current_exe() else {
        return false;
    };
    replaced(
        id(std::fs::metadata("/proc/self/exe")),
        id(std::fs::metadata(started)),
    )
}

#[cfg(not(target_os = "linux"))]
fn replaced_on_disk() -> bool {
    false
}

/// Say so when a deb or rpm upgrade replaced this app on disk: true when it did (the stage is then [`Stage::Installed`]).
fn installed_anew(app: &AppHandle) -> bool {
    if updatable() != Updatable::OtherPackaging || !replaced_on_disk() {
        return false;
    }
    set(app, Stage::Installed);
    true
}

/// Where a verified download waits. The app's own cache directory: discardable by definition, per OS user like
/// everything else this app keeps, and cleared of anything stale on the way in.
fn staging_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("updates");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Throw away everything staged. Called before a download so two versions can never both be on disk, and
/// after an install attempt so a build that failed to apply cannot be retried on every launch forever — the
/// same take-once rule the parked setup has (state.rs), and for the same reason.
fn clear_staging(app: &AppHandle) {
    if let Some(dir) = staging_dir(app) {
        let _ = std::fs::remove_dir_all(&dir);
    }
    *app.state::<UpdateState>().ready.lock().unwrap() = None;
}

/* THE RESIDENT LOOP. */
pub fn start(app: &AppHandle) {
    // The one build that is told nothing at all: nobody bundled it, so it has no release to be behind and no
    // artifact it could be moved onto. Everything else checks — INCLUDING deb and rpm, which cannot install
    // what they find and are asked anyway, so a machine that is already current is not nagged about a swap it
    // does not need. Being unable to update yourself only matters when there is something to update to.
    if updatable() == Updatable::NotARelease {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Anything a previous session staged is unusable now: `install` is a method on the `Update` those
        // bytes came with, that value lived in memory, and it died with the process that held it. Re-checking
        // is what produces a fresh one — cheap, and the alternative is a cache directory that only grows.
        clear_staging(&app);
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            check_now(&app).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// The workspace coming back on screen is the cheapest signal that this machine is awake and in use. Nothing
/// is checked if the timer has already done it recently — this is a backstop for the sleep the interval cannot
/// see, not a second schedule.
pub fn nudge(app: &AppHandle) {
    // Two file reads, so asked every time rather than on the check's schedule.
    if installed_anew(app) {
        return;
    }
    let due = {
        let state = app.state::<UpdateState>();
        let last = *state.last_check.lock().unwrap();
        last.is_none_or(|last| last.elapsed() > RECHECK_ON_SHOW_AFTER)
    };
    if !due || busy_or_installing(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { check_now(&app).await });
}

/// Whether anything at all is going on that an install must not interrupt. A script run is a `connect.ps1`
/// somebody is watching; an install already under way is the one race that could leave this machine with two
/// installers writing over each other.
fn busy_or_installing(app: &AppHandle) -> bool {
    app.state::<UpdateState>().installing.load(Ordering::SeqCst) || crate::scripts::busy()
}

/* ONE PASS: ask, and download what comes back. */
async fn check_now(app: &AppHandle) {
    if app.state::<UpdateState>().installing.load(Ordering::SeqCst) {
        return;
    }
    if *app.state::<UpdateState>().failures.lock().unwrap() >= GIVE_UP_AFTER {
        return;
    }
    // Installed already, by the package manager: nothing to ask the network about.
    if installed_anew(app) {
        return;
    }
    /* What was true before this pass, so a failure can put it back. */
    let settled = stage(app);
    set(app, Stage::Checking);
    *app.state::<UpdateState>().last_check.lock().unwrap() = Some(Instant::now());

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => return record_failure(app, settled, None, &error.to_string()),
    };
    let found = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            *app.state::<UpdateState>().failures.lock().unwrap() = 0;
            return set(app, Stage::Current);
        }
        Err(error) => return record_failure(app, settled, None, &error.to_string()),
    };

    // Already holding this one: a check that fires while the same version sits staged must not download it
    // again, and must not drop the `Update` those staged bytes belong to.
    if settled.ready_version() == Some(found.version.as_str()) {
        return set(app, settled);
    }

    let version = found.version.clone();

    /* `latest.json` names an AppImage for `linux-x86_64`, so this copy has no artifact of its own to be moved onto. */
    if updatable() == Updatable::OtherPackaging {
        return set(
            app,
            Stage::Manual {
                version: Some(version),
                reason: "A newer Intentic is out. This one was installed from a .deb or .rpm, which \
                         can't replace itself — download the new version, or switch to the AppImage, \
                         which updates on its own."
                    .to_string(),
                url: DOWNLOADS_URL.to_string(),
            },
        );
    }
    set(
        app,
        Stage::Downloading {
            version: version.clone(),
            percent: 0,
        },
    );
    clear_staging(app);

    let progress = app.clone();
    let announced = AtomicU8::new(0);
    let seen = AtomicU64::new(0);
    let reporting = version.clone();
    let bytes = found
        .download(
            move |chunk, total| {
                let so_far = seen.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                let Some(total) = total.filter(|total| *total > 0) else {
                    return;
                };
                let percent = ((so_far.min(total) * 100) / total) as u8;
                /* Whole percents only, and only forwards. */
                if percent > announced.load(Ordering::Relaxed) {
                    announced.store(percent, Ordering::Relaxed);
                    set(
                        &progress,
                        Stage::Downloading {
                            version: reporting.clone(),
                            percent,
                        },
                    );
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) => return record_failure(app, settled, Some(version), &error.to_string()),
    };

    let Some(dir) = staging_dir(app) else {
        return record_failure(
            app,
            settled,
            Some(version),
            "this device has no writable cache directory",
        );
    };
    let file = dir.join(format!("intentic-{version}"));
    if let Err(error) = std::fs::write(&file, &bytes) {
        return record_failure(app, settled, Some(version), &error.to_string());
    }
    *app.state::<UpdateState>().failures.lock().unwrap() = 0;
    *app.state::<UpdateState>().ready.lock().unwrap() = Some(Staged {
        update: found,
        file,
    });
    set(app, Stage::Ready { version });
}

/* One failed check is a laptop on a train. */
fn record_failure(app: &AppHandle, settled: Stage, version: Option<String>, reason: &str) {
    eprintln!("intentic: update check failed: {reason}");
    let failures = {
        let state = app.state::<UpdateState>();
        let mut count = state.failures.lock().unwrap();
        *count += 1;
        *count
    };
    if failures < GIVE_UP_AFTER {
        // Back to whatever was true before this pass — an unfinished check is not a fact about the version.
        set(app, settled);
        return;
    }
    set(
        app,
        Stage::Manual {
            version,
            reason:
                "Intentic couldn't install its own update. Download the new version to move up."
                    .to_string(),
            url: DOWNLOADS_URL.to_string(),
        },
    );
}

/// What the refusal for unsaved changes says, compared by [`act`] to know it is one the user can act on.
const UNSAVED: &str = "Save or close the windows with unsaved changes first.";

/// What an update that is installed but held from restarting says: the restart is the user's to give once their
/// changes are saved, from the same offer.
const RESTART_HELD: &str = "The update is installed. Save or close the windows with unsaved changes, then restart Intentic to use it.";

/// Why an install was refused, in the words the screen shows. Refusals rather than queues: an update is
/// offered again a moment later, and holding one to run behind somebody's back is exactly what this must not do.
///
/// Unsaved changes in a local window refuse it too, and here rather than at the exit: the Windows installer ends
/// this process with `std::process::exit`, which no exit handler hears, and a restart cannot be held (windows.rs
/// `hold_quit`). After "Quit anyway" nothing counts as unsaved, so an update staged for the way out still installs.
pub fn refusal(app: &AppHandle) -> Option<&'static str> {
    if app.state::<UpdateState>().installing.load(Ordering::SeqCst) {
        return Some("Intentic is already installing an update.");
    }
    if crate::scripts::busy() || crate::project::busy() {
        return Some("Something is running on this device. Intentic will update once it finishes.");
    }
    if crate::windows::unsaved_windows() > 0 {
        return Some(UNSAVED);
    }
    None
}

/* APPLYING IT — the swap, and the only part of this that the user can feel. */
pub fn install(app: &AppHandle, restart: bool) -> Result<(), String> {
    if let Some(refusal) = refusal(app) {
        return Err(refusal.to_string());
    }
    let staged = app.state::<UpdateState>().ready.lock().unwrap().take();
    let Some(staged) = staged else {
        return Err("there is no downloaded update to install".to_string());
    };
    let version = staged.update.version.clone();
    let bytes = match std::fs::read(&staged.file) {
        Ok(bytes) => bytes,
        Err(error) => return Err(abandon(app, version, &error.to_string())),
    };
    // Asked again at the last moment the install can still be put back: reading a bundle of a hundred megabytes
    // takes a while, and a window edited meanwhile would be lost to the Windows installer, which ends this process
    // where nothing can ask (windows.rs `hold_quit`). The staged update goes back to be offered again.
    if crate::windows::unsaved_windows() > 0 {
        *app.state::<UpdateState>().ready.lock().unwrap() = Some(staged);
        return Err(UNSAVED.to_string());
    }
    app.state::<UpdateState>()
        .installing
        .store(true, Ordering::SeqCst);
    let _ = std::fs::remove_file(&staged.file);
    if let Err(error) = staged.update.install(bytes) {
        return Err(abandon(app, version, &error.to_string()));
    }
    // Windows never reaches this line. Linux does, having just replaced the file this process is running from.
    if restart {
        restart_onto_update(app)?;
    }
    Ok(())
}

/// The restart onto an update already on disk, unless a local window has unsaved changes now: a restart cannot be
/// held once asked for (windows.rs `hold_quit`), so it is not asked for. It waits, and the offer means it from then
/// on (`take_offer`); a quit meanwhile lands on the new version at the next launch all the same.
fn restart_onto_update(app: &AppHandle) -> Result<(), String> {
    if crate::windows::unsaved_windows() > 0 {
        app.state::<UpdateState>()
            .restart_due
            .store(true, Ordering::SeqCst);
        return Err(RESTART_HELD.to_string());
    }
    app.restart();
}

/// An install that failed has spent its staged bytes, so the offer becomes the download page with the reason on
/// it, and `installing` is released so a later check can stage the next release. Answers that sentence.
fn abandon(app: &AppHandle, version: String, error: &str) -> String {
    let reason = format!("Intentic couldn't install {version} ({error}). Download it instead.");
    eprintln!("intentic: {reason}");
    app.state::<UpdateState>()
        .installing
        .store(false, Ordering::SeqCst);
    set(
        app,
        Stage::Manual {
            version: Some(version),
            reason: reason.clone(),
            url: DOWNLOADS_URL.to_string(),
        },
    );
    reason
}

/* WHAT THE OFFER DOES WHEN IT IS TAKEN — one entry point for all three surfaces. BLOCKING: the install reads and
 * unpacks the whole download before it hands over, so every caller runs this off the main thread. */
pub fn take_offer(app: &AppHandle) -> Result<(), String> {
    // Installed already, with the restart held for unsaved changes: the offer is that restart.
    if app
        .state::<UpdateState>()
        .restart_due
        .load(Ordering::SeqCst)
    {
        return restart_onto_update(app);
    }
    match stage(app) {
        Stage::Ready { .. } => install(app, true),
        // The package manager installed it already: the offer is the restart onto it, once nothing runs that a
        // restart would leave behind.
        Stage::Installed => match refusal(app) {
            Some(refusal) => Err(refusal.to_string()),
            None => restart_onto_update(app),
        },
        Stage::Manual { url, .. } => {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|error| format!("could not open your browser: {error}"))
        }
        // A press this state has nothing to answer with — a banner from a moment ago, a download still being
        // written to disk. Answered rather than dropped, so the surface that pressed it can say so.
        other => Err(format!(
            "there is nothing to install yet (the update is {other:?})"
        )),
    }
}

/// The tray row and the `intentic://update` link, which have nowhere to show a refusal but the log — except the ones
/// the user has to act on before anything can happen, unsaved changes, which are said in a dialog.
pub fn act(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = take_offer(&app) {
            eprintln!("intentic: {error}");
            if error == UNSAVED || error == RESTART_HELD {
                use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                app.dialog()
                    .message(error)
                    .title("Save your changes first")
                    .kind(MessageDialogKind::Info)
                    .show(|_| {});
            }
        }
    });
}

/* THE INVISIBLE PATH, AND THE ONE THAT MAKES "ALWAYS ON THE NEWEST VERSION" TRUE. */
pub fn install_on_exit(app: &AppHandle) {
    // An install already under way is what an "Update" click a moment ago started, and it is on its way to
    // ending this process by itself. Reaching the installer twice is the one race here that could leave a
    // machine with two installers writing over each other and no working app at the end of it.
    if app.state::<UpdateState>().installing.load(Ordering::SeqCst) {
        return;
    }
    if !matches!(stage(app), Stage::Ready { .. }) {
        return;
    }
    if let Err(error) = install(app, false) {
        eprintln!("intentic: update not installed on quit: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* WHAT EACH STATE OFFERS. */
    #[test]
    fn only_a_finished_download_is_offered_as_an_action() {
        for stage in [
            Stage::Idle,
            Stage::Checking,
            Stage::Current,
            Stage::Downloading {
                version: "1.2.3".into(),
                percent: 40,
            },
        ] {
            assert!(!stage.tray().1, "{stage:?} must not be clickable");
        }
        assert!(
            Stage::Ready {
                version: "1.2.3".into()
            }
            .tray()
            .1
        );
    }

    /// The two populations that can never update themselves — a deb/rpm install, and a copy whose pubkey can
    /// no longer verify a release — get a row that DOES something, because the alternative they have today is
    /// being told nothing at all.
    #[test]
    fn a_copy_that_cannot_update_itself_still_offers_the_download() {
        let manual = Stage::Manual {
            version: Some("1.2.3".into()),
            reason: "…".into(),
            url: DOWNLOADS_URL.into(),
        };
        let (text, enabled) = manual.tray();
        assert!(enabled);
        assert!(text.contains("1.2.3"));

        // A failure this app could not even name a version for still has to lead somewhere.
        let unknown = Stage::Manual {
            version: None,
            reason: "…".into(),
            url: DOWNLOADS_URL.into(),
        };
        assert!(unknown.tray().1);
    }

    /// A deb or rpm upgraded under the running app: the offer is the restart, and it is one.
    #[test]
    fn an_upgrade_already_installed_is_offered_as_a_restart() {
        let (text, enabled) = Stage::Installed.tray();
        assert!(enabled);
        assert!(text.starts_with("Restart"), "{text}");
        assert_eq!(Stage::Installed.ready_version(), None);
        assert_eq!(
            serde_json::to_value(Stage::Installed).unwrap(),
            serde_json::json!({ "kind": "installed" })
        );
    }

    /// The file at the path the app started from is another one than it runs: a newer install. The same file, or none
    /// at all there any more, is not.
    #[test]
    fn a_binary_replaced_on_disk_is_told_from_one_still_in_place() {
        assert!(replaced(Some((1, 10)), Some((1, 11))));
        assert!(replaced(Some((1, 10)), Some((2, 10))));
        assert!(!replaced(Some((1, 10)), Some((1, 10))));
        assert!(!replaced(Some((1, 10)), None));
        assert!(!replaced(None, Some((1, 10))));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_running_binary_still_in_place_is_not_replaced() {
        assert!(!replaced_on_disk());
    }

    #[test]
    fn a_downloading_row_says_how_far_it_has_got() {
        let (text, _) = Stage::Downloading {
            version: "1.2.3".into(),
            percent: 42,
        }
        .tray();
        assert!(text.contains("42%"), "{text}");
        assert!(text.contains("1.2.3"), "{text}");
    }

    /// Only `Ready` names a version to the workspace page: the banner exists to offer a swap that is already
    /// downloaded, and a page told about a version mid-download would draw a button that starts a wait.
    #[test]
    fn the_page_is_told_about_a_version_only_once_it_is_downloaded() {
        assert_eq!(
            Stage::Ready {
                version: "1.2.3".into()
            }
            .ready_version(),
            Some("1.2.3")
        );
        assert_eq!(
            Stage::Downloading {
                version: "1.2.3".into(),
                percent: 99
            }
            .ready_version(),
            None
        );
        assert_eq!(Stage::Current.ready_version(), None);
    }

    /* It arrives on a minisign-verified manifest this repo publishes, so nothing hostile is expected in it. */
    #[test]
    fn nothing_can_end_the_string_it_is_injected_into() {
        assert_eq!(escape_js("1.2.3"), "1.2.3");
        assert_eq!(escape_js("a\"b"), "a\\\"b");
        assert_eq!(escape_js("a\\b"), "a\\\\b");
        assert_eq!(escape_js("a'b"), "a\\'b");
        // The one that closes a <script> block rather than a string literal.
        assert_eq!(escape_js("</script>"), "\\u003c/script>");
        // Newlines end a statement, so they do not survive at all.
        assert_eq!(escape_js("1.2\n.3"), "1.2.3");
    }
}
