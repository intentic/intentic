use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

/* KEEPING THE APP ON THE VERSION THAT WAS RELEASED, WITHOUT EVER ASKING FIRST.
 *
 * This app is tray-resident by design — the × hides the workspace rather than ending the process (windows.rs)
 * — and `main` cuts a release most days. Before this module the two facts met as follows: ONE check, at
 * startup, emitting a notice that read "it installs the next time you quit", with nothing anywhere in this
 * crate that installed anything, ever. A machine left up for a week checked once; a machine quit nightly
 * installed nothing either. Every copy in the wild simply stayed where it was.
 *
 * That is worse than a stale app. The `ic` CLI a setup downloads is pinned to THIS build's release tag
 * (commands.rs `ic_url`), so an app that never updates also freezes the flow it drives — and the
 * `intentic-requirement:` protocol the Windows setup screen is built around arrived in one commit, which an
 * older app receives, cannot parse, and renders as an install that hangs on "checking Docker".
 *
 * THE SHAPE IS THE ONE THE SANDBOX ALREADY USES. `ic sandbox prepare` pulls and builds the next image without
 * touching the running container, writes `/history/update-staged.json` to say so, and a later `ic sandbox
 * update` swaps onto what is already downloaded — seconds of downtime instead of minutes. This is that,
 * applied to the shell:
 *
 *   check on a schedule → download to disk, silently → offer the swap → apply it on quit, or on the click
 *
 * WHAT IS NEVER DONE: nothing is installed while a script run is live, and nothing is installed under a
 * question. An install replaces the running executable and ends the process; doing that behind somebody's
 * four-minute `connect.ps1` would kill the install they are watching. `busy()` is the whole guard, and it is
 * checked at the last possible moment rather than at the start of the download.
 *
 * WHY THE BYTES GO TO DISK. `Update::download` verifies the release's minisign signature and hands back a
 * `Vec<u8>` — around 15 MB of NSIS installer on Windows and roughly 100 MB of AppImage on Linux. Holding the
 * latter resident for the days this process routinely lives would be a real cost for an app that is idle for
 * almost all of it, so the verified bytes are staged under this app's own cache directory and read back at
 * install time. That trades nothing away: the staging directory and the installed application are the same
 * user's, on both platforms (`installMode: currentUser` puts the Windows install under %LOCALAPPDATA%), so
 * anything able to tamper with a staged installer can already replace the app it would be installing over.
 *
 * WHAT THIS CANNOT DO, AND SAYS SO. `latest.json` names exactly two artifacts — the AppImage for
 * `linux-x86_64` and the NSIS installer for `windows-x86_64` (build-desktop.sh) — so a copy installed from the
 * `.deb` or the `.rpm` has no artifact of its own to be updated with. Left alone the plugin would fetch the
 * AppImage and hand it to `dpkg`, which rejects it as not a package: a failure with nothing useful in it. So a
 * deb/rpm build is recognised up front and offered the download page instead. The same ending catches the
 * other population that can never update itself: every copy installed at or before v1.213.0 was compiled with
 * a pubkey whose private half was lost, so it rejects every manifest signed since, forever. Those two are the
 * only cases where this app asks a person to do something, and it is better than the silence they get now.
 */

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

/* WHAT THE APP IS DOING ABOUT ITS OWN VERSION, as one value that every surface renders.
 *
 * Three of them draw this: the launcher's notice, the tray entry, and — through the one-way channel the
 * workspace window already has — the SPA's own banner. One value rather than three booleans is what stops
 * them disagreeing, which the old event could not help doing: it carried a version and nothing about whether
 * anything had been downloaded, so the only sentence available was a guess about the future ("it installs the
 * next time you quit") that happened to be false. */
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
}

impl Stage {
    /// What the tray entry says, and whether it can be clicked. The tray is the backstop surface — the app's
    /// own README tells the story of a user who never found this icon — so it states the same fact the
    /// banner does rather than only appearing when there is something to press.
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

/* MOVING TO A STATE, AND TELLING EVERY SURFACE AT ONCE.
 *
 * The store and the three notifications are one function precisely so they cannot come apart: a stage written
 * without an emit is a launcher notice frozen on the previous sentence, and an emit without the store is a
 * window that reopens showing something else. `update_state` reads the same value on mount, so a webview that
 * was not open when this ran catches up. */
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

/* TELLING THE HOSTED SPA, WITHOUT GIVING IT A COMMAND SURFACE.
 *
 * The workspace window is remote content with an empty capability list, and that does not change here. What it
 * already has is a one-way marker injected at load (`workspace_init_script`) and an `intentic://` navigation
 * this window intercepts — a channel INTO the app that is a link rather than IPC, so the same button works
 * from an external browser and a page that is somehow not ours can at worst ask for something it has no
 * credentials for.
 *
 * This is the load-time marker's missing half: a page open BEFORE the download finished would otherwise never
 * hear about it, and the banner would appear only on a reload — on the one screen whose whole problem is that
 * it is never reloaded. An event dispatched into the page is still one-way; nothing is returned and nothing is
 * callable. The version is escaped rather than trusted: it is ours, off a signed manifest, and it is still
 * being written into a JavaScript string literal. */
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

/* WHETHER THIS PROCESS CAN REPLACE ITSELF AT ALL, decided once, before anything is fetched.
 *
 * `bundle_type()` is the same call the updater plugin makes to choose its own install path, so there is no
 * second opinion to drift from: it reads a marker the bundler patched into this exact artifact. Deb and rpm
 * are recognised HERE rather than at install time because that is the difference between a sentence somebody
 * can act on and `dpkg` refusing an AppImage. */
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

/* THE RESIDENT LOOP. One check on arrival, then the cadence — and every wake re-reads the failure count, so
 * an app that has given up stops making requests rather than quietly making them forever. */
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

/* ONE PASS: ask, and download what comes back.
 *
 * Downloading without being asked is the whole point — an "Update" button that then makes somebody wait four
 * minutes for an AppImage is the experience this replaces, and it is why `Ready` is the only state with a
 * button on it. The download itself is safe to run beside anything: it writes to this app's cache directory
 * and touches nothing the machine is using. Only the INSTALL has to wait for a quiet moment. */
async fn check_now(app: &AppHandle) {
    if app.state::<UpdateState>().installing.load(Ordering::SeqCst) {
        return;
    }
    if *app.state::<UpdateState>().failures.lock().unwrap() >= GIVE_UP_AFTER {
        return;
    }
    /* What was true before this pass, so a failure can put it back. A half-finished check is not a fact about
     * this app's version, and the states it passes through on the way are the two that must never be left
     * standing: a tray row frozen on "Checking for updates…", or one frozen at 61%. */
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

    /* A .DEB OR .RPM INSTALL, WHICH IS ONLY A PROBLEM NOW THAT THERE IS SOMETHING TO MISS.
     *
     * `latest.json` names an AppImage for `linux-x86_64`, so this copy has no artifact of its own to be moved
     * onto — left to itself the plugin would download that AppImage and hand it to `dpkg`, which rejects it as
     * not a package: a failure with nothing in it a person could act on. Saying so is better, and saying so
     * HERE rather than at startup is what keeps it from being a permanent notice on a machine that is already
     * current. Nothing is downloaded: there is nothing this build could do with the bytes. */
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
                /* Whole percents only, and only forwards. This callback fires once per chunk — tens of
                 * thousands of times across a 100 MB AppImage — and an emit apiece would be three surfaces
                 * redrawing several hundred times a second for the whole download. */
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
            "this computer has no writable cache directory",
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

/* A FAILURE IS QUIET UNTIL IT IS A PATTERN, AND THEN IT IS SAID OUT LOUD.
 *
 * One failed check is a laptop on a train. Three in a row is this copy, specifically, being unable to update
 * itself — which for every install cut at or before v1.213.0 is permanent and structural: those builds were
 * compiled with a pubkey whose private half was lost, so a signature check that fails today fails forever.
 * Retrying silently is how they came to be a population nobody has ever told. */
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

/// Why an install was refused, in the words the screen shows. Refusals rather than queues: an update is
/// offered again a moment later, and holding one to run behind somebody's back is exactly what this must not do.
pub fn refusal(app: &AppHandle) -> Option<&'static str> {
    if app.state::<UpdateState>().installing.load(Ordering::SeqCst) {
        return Some("Intentic is already installing an update.");
    }
    if crate::scripts::busy() {
        return Some(
            "Something is running on this computer. Intentic will update once it finishes.",
        );
    }
    None
}

/* APPLYING IT — the swap, and the only part of this that the user can feel.
 *
 * Windows: the NSIS installer runs in `passive` mode (a progress bar, no questions), `install` ends this
 * process itself, and the installer starts the app again with the arguments it had. So nothing after the call
 * runs, and the relaunch is the installer's rather than ours.
 *
 * Linux: `install` rewrites the AppImage in place, keeping the old one until the write succeeds, and RETURNS.
 * Restarting is ours to do, and `restart()` is what knows an AppImage's real path — `current_exe` inside one
 * points into a squashfs mount that is about to be the previous version.
 *
 * Staging is cleared BEFORE the attempt, not after. On Windows there is no after; on Linux a staged file kept
 * past a failure is one that gets retried on every quit from here on. */
pub fn install(app: &AppHandle, restart: bool) -> Result<(), String> {
    if let Some(refusal) = refusal(app) {
        return Err(refusal.to_string());
    }
    let staged = app.state::<UpdateState>().ready.lock().unwrap().take();
    let Some(staged) = staged else {
        return Err("there is no downloaded update to install".to_string());
    };
    let bytes = std::fs::read(&staged.file)
        .map_err(|error| format!("the downloaded update could not be read: {error}"))?;
    app.state::<UpdateState>()
        .installing
        .store(true, Ordering::SeqCst);
    let _ = std::fs::remove_file(&staged.file);

    staged
        .update
        .install(bytes)
        .map_err(|error| format!("the update could not be installed: {error}"))?;
    // Windows never reaches this line. Linux does, having just replaced the file this process is running from.
    if restart {
        app.restart();
    }
    Ok(())
}

/* WHAT THE OFFER DOES WHEN IT IS TAKEN — one entry point for all three surfaces.
 *
 * The tray row, the launcher's button and the SPA's banner (through `intentic://update`) are three drawings of
 * one state, so they must not be three decisions about what pressing it means. `Ready` installs and comes
 * back; `Manual` opens the download page, which is the only thing left to offer a copy that cannot replace
 * itself; everything else is a press on a row that is not offering anything, and does nothing.
 *
 * Off the caller's thread, because on Windows installing ends this process from inside the call — doing that
 * on a tray menu callback tears down the very menu that is mid-event. */
pub fn act(app: &AppHandle) {
    match stage(app) {
        Stage::Ready { .. } => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = install(&app, true) {
                    eprintln!("intentic: {error}");
                }
            });
        }
        Stage::Manual { url, .. } => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url(url, None::<&str>);
        }
        _ => {}
    }
}

/* THE INVISIBLE PATH, AND THE ONE THAT MAKES "ALWAYS ON THE NEWEST VERSION" TRUE.
 *
 * Quitting is the perfect moment: the window is going anyway, nothing is being watched, and the next launch is
 * the new version with nobody having been asked about it. This is what the launcher's old notice claimed
 * happened and what nothing in this crate did.
 *
 * Called from the exit event, so it must not be slow and must not be able to stop the exit. It is a file write
 * on Linux and a ShellExecute on Windows; a failure leaves the app exactly as it was, which is the whole
 * promise. No restart, obviously — the user is leaving. */
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

    /* WHAT EACH STATE OFFERS. The tray is the surface a user meets when the window is not on screen at all —
     * this app lives in it — and the rule it has to keep is the same one the banner keeps: exactly one state
     * has a button, and that state is the one where the bytes are already on this machine. Anything else is a
     * button that starts a wait. */
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

    /* THE VERSION IS OURS AND IT IS STILL ESCAPED.
     *
     * It arrives on a minisign-verified manifest this repo publishes, so nothing hostile is expected in it —
     * and it is written into a JavaScript string literal inside a page loaded from app.intentic.dev, which is
     * the one place in this app where "expected" is not a good enough reason to skip the encoder. */
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
