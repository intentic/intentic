//! THE LAST BUILD THAT BOOTED (2026-11-16). A sandbox whose daemon runs the compiled trees mounted from a checkout
//! (dev-mounts.mjs: `/opt/sandbox/dist` and each workspace package's `dist`) changes build without its container
//! changing: `ic sandbox dev`, `dev-restart.sh`, or a build in the checkout under a running daemon. On 2026-11-11 one such
//! build crashed at boot ("Opening the netd door", a TypeError) and netd restarted it 16 times in four minutes, until a
//! later rebuild fixed it; `ic`'s probation, which puts a parked container back, keeps none for the dev loop, and a parked
//! container would mount the same broken checkout anyway. So the way back lives here, beside the restarts.
//!
//! - A start whose daemon reports ready (`/health`'s `boot.ready`, asked on Node's own socket) and is still the same
//!   process `GRACE` later is a build that boots. Its trees' JavaScript is copied to the history volume
//!   (`daemon-builds/last-good`), the one kept build, replaced only by a newer build that boots. Builds are told apart by
//!   a fingerprint of the trees (every file's path, size and mtime), since a checkout build always says 0.0.0. A build
//!   that changed under the running daemon is not kept: it is not the one that booted.
//! - `STRIKES` starts in a row that exit before ready, within `STRIKE_WINDOW`, start the kept build instead: the same
//!   command with `--import` of netd's own loader (fallback-hook.mjs), which reads each module's source from the kept
//!   copy. It is written down (`rolled-back` in netd-kills.jsonl, with the boot error the daemon left in
//!   boot-failure.json), and the daemon it starts is told so (`ROLLED_BACK_ENV`), which puts it on the owner's card.
//! - The kept build failing the same way gives up: back to the live build, restarted as before, written down as
//!   `rollback-failed`, never back and forth between two bad builds.
//! - A new build in the trees (a rebuild, an update) is tried first, with strikes of its own, whatever happened before;
//!   a recreated or restarted container starts with no strikes. Neither forgets the kept build.
//!
//! A sandbox on a baked image has nothing mounted and this stays off: its build cannot change without a new container,
//! whose way back is `ic`'s probation (ic/src/sandbox/probation.rs) or the platform's.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::records::{self, NETD_KILLS_FILE, Records};

/// Pre-ready exits in a row that roll back to the kept build, or give the kept build up.
pub const STRIKES: u32 = 3;
/// How close together those exits are: netd's backoff makes three crashes at boot about ten seconds, and a build that
/// fails once an hour is not this problem.
pub const STRIKE_WINDOW: Duration = Duration::from_secs(10 * 60);
/// How long a ready daemon keeps running before its build is kept.
const GRACE: Duration = Duration::from_secs(60);
/// How often a start not yet ready is asked.
const ASK_EVERY: Duration = Duration::from_secs(5);
const ASK_TIMEOUT: Duration = Duration::from_secs(5);

/// The kept build's directory, for the loader.
pub const FALLBACK_ROOT_ENV: &str = "INTENTIC_FALLBACK_ROOT";
/// Told to a daemon started on the kept build: what was rolled back from, to, and why (JSON, `RolledBack`). The daemon
/// reads it as `INTENTIC_ROLLED_BACK` (system/boot/restarts/rolled-back.ts).
pub const ROLLED_BACK_ENV: &str = "INTENTIC_ROLLED_BACK";

/// Where the image puts the daemon, and the mounts under it that are not compiled trees: the checkout itself
/// (read-only, for its manifests) and netd's own directory.
const SANDBOX_ROOT: &str = "/opt/sandbox";
const NOT_TREES: [&str; 2] = ["/opt/sandbox/dev-checkout", "/opt/sandbox/netd"];
const MOUNTINFO: &str = "/proc/self/mountinfo";
const HOOK_FILE: &str = "fallback-hook.mjs";
const HOOK: &str = include_str!("fallback-hook.mjs");
const KEPT_DIR: &str = "last-good";
const BUILD_FILE: &str = "build.json";
// The history volume's own default, as records.rs reads it.
const HISTORY_ROOT_ENV: &str = "HISTORY_ROOT";
const BOOT_FAILURE_FILE: &str = "boot-failure.json";

/// The compiled trees a mountinfo names under `root`: the bind mounts over the image's own copies. Pure.
pub fn trees_in(mountinfo: &str, root: &str, not: &[&str]) -> Vec<PathBuf> {
    let mut trees: Vec<PathBuf> = mountinfo
        .lines()
        .filter_map(|line| line.split(' ').nth(4))
        .filter(|point| point.starts_with(&format!("{root}/")) && !not.contains(point))
        .map(PathBuf::from)
        .collect();
    trees.sort();
    trees.dedup();
    trees
}

/// One build of the trees: a hash of what is in them, and its newest file's time, which names it for a person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub hash: String,
    pub built_at: u64,
}

// The files a build is, and the ones kept: what a module load reads. Source maps and declarations are left behind.
fn counts(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("js" | "mjs" | "cjs" | "json")
    )
}

// Every counted file under `dir`, with its size and mtime, sorted by path.
fn files(dir: &Path, into: &mut Vec<(PathBuf, u64, u64)>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        let path = entry.path();
        if meta.is_dir() {
            files(&path, into)?;
        } else if meta.is_file() && counts(&path) {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |at| u64::try_from(at.as_nanos()).unwrap_or(u64::MAX));
            into.push((path, meta.len(), mtime));
        }
    }
    Ok(())
}

fn listed(trees: &[PathBuf]) -> std::io::Result<Vec<(PathBuf, u64, u64)>> {
    let mut all = Vec::new();
    for tree in trees {
        files(tree, &mut all)?;
    }
    all.sort();
    Ok(all)
}

// FNV-1a: the same answer from every build of netd, unlike std's hasher.
fn fnv(bytes: &[u8], mut hash: u64) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The build `trees` hold now; None when one cannot be read through.
pub fn fingerprint(trees: &[PathBuf]) -> Option<Build> {
    let all = listed(trees).ok()?;
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for tree in trees {
        hash = fnv(tree.as_os_str().as_encoded_bytes(), hash);
        hash = fnv(b"\n", hash);
    }
    let mut newest = 0_u64;
    for (path, len, mtime) in &all {
        hash = fnv(path.as_os_str().as_encoded_bytes(), hash);
        hash = fnv(&len.to_le_bytes(), hash);
        hash = fnv(&mtime.to_le_bytes(), hash);
        newest = newest.max(*mtime);
    }
    Some(Build {
        hash: format!("{hash:016x}"),
        built_at: newest / 1_000_000,
    })
}

/// The kept build's record, beside its files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub build: Build,
    pub trees: Vec<PathBuf>,
    pub kept_at: u64,
}

/// The build kept under `dir`, when there is a whole one.
pub fn kept(dir: &Path) -> Option<Kept> {
    let raw = std::fs::read(dir.join(KEPT_DIR).join(BUILD_FILE)).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Copies `build`, as `trees` hold it, to `dir`'s kept build, in place of the one before. False, with nothing changed,
/// when the trees are not that build any more by the end of the copy. Staged beside it and swapped in, so a copy cut
/// short never leaves half a build where a whole one was, and at most the kept build stays once it returns.
pub fn keep(dir: &Path, trees: &[PathBuf], build: &Build) -> std::io::Result<bool> {
    std::fs::create_dir_all(dir)?;
    // What an earlier copy cut short left.
    for entry in std::fs::read_dir(dir)?.flatten() {
        if entry.file_name().to_string_lossy().starts_with('.') {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let staging = dir.join(format!(".staging-{}", std::process::id()));
    let copied = (|| {
        for (path, _, _) in listed(trees)? {
            let relative = path.strip_prefix("/").unwrap_or(&path);
            let to = staging.join("files").join(relative);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&path, &to)?;
        }
        if fingerprint(trees).as_ref() != Some(build) {
            return Ok(false);
        }
        let record = Kept {
            build: build.clone(),
            trees: trees.to_vec(),
            kept_at: records::now_ms(),
        };
        std::fs::write(
            staging.join(BUILD_FILE),
            serde_json::to_vec(&record).map_err(std::io::Error::other)?,
        )?;
        Ok(true)
    })();
    if !matches!(copied, Ok(true)) {
        let _ = std::fs::remove_dir_all(&staging);
        return copied;
    }
    let current = dir.join(KEPT_DIR);
    let old = dir.join(".old");
    if current.exists() {
        std::fs::rename(&current, &old)?;
    }
    std::fs::rename(&staging, &current)?;
    let _ = std::fs::remove_dir_all(&old);
    Ok(true)
}

/// Which build a start runs.
#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    Live,
    /// The kept build; `first` on the start that rolled back.
    Kept {
        from: Build,
        to: Build,
        first: bool,
    },
}

/// What happened to the kept build when a choice changed, for the record.
#[derive(Debug, Clone, PartialEq)]
pub enum Turn {
    None,
    GaveUp { from: Build, to: Build },
}

#[derive(Debug, Clone, PartialEq)]
enum Mode {
    Live,
    OnKept {
        from: Build,
        to: Build,
    },
    /// The kept build failed too, for this live build: it runs as before.
    GaveUp,
}

/// THE RULE, without a clock or a disk: fed each start's live build and the kept one, and whether each start reached
/// ready. Pure.
#[derive(Debug)]
pub struct Judge {
    live: Option<Build>,
    strikes: Vec<Instant>,
    mode: Mode,
}

impl Default for Judge {
    fn default() -> Self {
        Self {
            live: None,
            strikes: Vec::new(),
            mode: Mode::Live,
        }
    }
}

impl Judge {
    /// Which build the next start runs, the trees holding `live` and `kept` kept.
    pub fn choose(&mut self, live: Option<&Build>, kept: Option<&Build>, now: Instant) -> Choice {
        let Some(live) = live else {
            return Choice::Live;
        };
        if self.live.as_ref() != Some(live) {
            // A new build is the owner's: it gets its own strikes, and whatever the last one came to is over.
            self.live = Some(live.clone());
            self.strikes.clear();
            self.mode = Mode::Live;
        }
        self.strikes
            .retain(|at| now.saturating_duration_since(*at) <= STRIKE_WINDOW);
        match &self.mode {
            Mode::OnKept { from, to } => Choice::Kept {
                from: from.clone(),
                to: to.clone(),
                first: false,
            },
            Mode::GaveUp => Choice::Live,
            Mode::Live => match kept {
                Some(kept) if kept != live && self.strikes.len() >= STRIKES as usize => {
                    self.strikes.clear();
                    self.mode = Mode::OnKept {
                        from: live.clone(),
                        to: kept.clone(),
                    };
                    Choice::Kept {
                        from: live.clone(),
                        to: kept.clone(),
                        first: true,
                    }
                }
                _ => Choice::Live,
            },
        }
    }

    /// A start ended without being asked to: `ready` when it got past the gate.
    pub fn exited(&mut self, ready: bool, now: Instant) -> Turn {
        if ready {
            self.strikes.clear();
            return Turn::None;
        }
        self.strikes.push(now);
        self.strikes
            .retain(|at| now.saturating_duration_since(*at) <= STRIKE_WINDOW);
        if let Mode::OnKept { from, to } = &self.mode
            && self.strikes.len() >= STRIKES as usize
        {
            let turn = Turn::GaveUp {
                from: from.clone(),
                to: to.clone(),
            };
            self.strikes.clear();
            self.mode = Mode::GaveUp;
            return turn;
        }
        Turn::None
    }
}

/// What a daemon on the kept build is told, and what netd-kills.jsonl says of a rollback.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolledBack {
    pub at: u64,
    pub kind: &'static str,
    pub from: Build,
    pub to: Build,
    pub failures: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
}

#[derive(Deserialize)]
struct BootFailure {
    error: Option<String>,
    step: Option<String>,
}

/// One start as the supervisor runs it.
pub struct Launch {
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub build: Option<Build>,
    pub on_kept: bool,
}

/// The container's own netd's way back, for the compiled trees it found mounted.
pub struct Fallback {
    trees: Vec<PathBuf>,
    dir: PathBuf,
    history: PathBuf,
    hook: PathBuf,
    node_socket: PathBuf,
    records: Arc<Records>,
    judge: Mutex<Judge>,
}

impl Fallback {
    /// The container's own netd's, when its daemon runs mounted trees; None on a baked image.
    pub fn discover(
        run_dir: &Path,
        node_socket: &Path,
        records: Arc<Records>,
    ) -> Option<Arc<Self>> {
        let mountinfo = std::fs::read_to_string(MOUNTINFO).ok()?;
        let trees = trees_in(&mountinfo, SANDBOX_ROOT, &NOT_TREES);
        if trees.is_empty() {
            return None;
        }
        let history = std::env::var_os(HISTORY_ROOT_ENV)
            .filter(|root| !root.is_empty())
            .map_or_else(|| PathBuf::from("/history"), PathBuf::from);
        tracing::info!(
            trees = trees.len(),
            "the daemon runs mounted compiled trees: the last build that booted is kept, and started after {STRIKES} failed boots"
        );
        Some(Arc::new(Self::new(
            trees,
            history,
            run_dir,
            node_socket,
            records,
        )))
    }

    pub fn new(
        trees: Vec<PathBuf>,
        history: PathBuf,
        run_dir: &Path,
        node_socket: &Path,
        records: Arc<Records>,
    ) -> Self {
        Self {
            trees,
            dir: history.join("daemon-builds"),
            history,
            hook: run_dir.join(HOOK_FILE),
            node_socket: node_socket.to_owned(),
            records,
            judge: Mutex::default(),
        }
    }

    /// Which build the next start runs, with what it is started with. `args` is the command's own.
    pub async fn launch(self: &Arc<Self>, args: &[OsString]) -> Launch {
        let this = self.clone();
        let (live, kept) =
            tokio::task::spawn_blocking(move || (fingerprint(&this.trees), kept(&this.dir)))
                .await
                .unwrap_or((None, None));
        // A kept build of other trees (a package added or gone) cannot stand in for these.
        let usable = kept.filter(|kept| kept.trees == self.trees);
        let choice = self.judge.lock().expect("judge poisoned").choose(
            live.as_ref(),
            usable.as_ref().map(|kept| &kept.build),
            Instant::now(),
        );
        let Choice::Kept { from, to, first } = choice else {
            return Launch {
                args: args.to_vec(),
                env: Vec::new(),
                build: live,
                on_kept: false,
            };
        };
        let failure = self.boot_failure();
        let rolled = RolledBack {
            at: records::now_ms(),
            kind: "rolled-back",
            from,
            to,
            failures: STRIKES,
            error: failure.as_ref().and_then(|failure| failure.error.clone()),
            step: failure.and_then(|failure| failure.step),
        };
        if first {
            tracing::error!(
                from = %rolled.from.hash,
                to = %rolled.to.hash,
                error = rolled.error.as_deref().unwrap_or("unknown"),
                "the daemon failed {STRIKES} times before it was ready: starting the last build that booted instead"
            );
            self.records.append(NETD_KILLS_FILE, &rolled);
        }
        if let Err(error) = std::fs::write(&self.hook, HOOK) {
            tracing::error!(%error, "could not write the fallback loader: starting the live build");
            return Launch {
                args: args.to_vec(),
                env: Vec::new(),
                build: live,
                on_kept: false,
            };
        }
        let mut with_hook = vec![OsString::from(format!("--import={}", self.hook.display()))];
        with_hook.extend(args.iter().cloned());
        Launch {
            args: with_hook,
            env: vec![
                (
                    FALLBACK_ROOT_ENV.into(),
                    self.dir.join(KEPT_DIR).into_os_string(),
                ),
                (
                    ROLLED_BACK_ENV.into(),
                    serde_json::to_string(&rolled).unwrap_or_default().into(),
                ),
            ],
            build: live,
            on_kept: true,
        }
    }

    /// Watches one start: marks `ready` once its daemon says so, and keeps its build once it has run `GRACE` past that.
    /// Aborted when the start ends.
    pub async fn watch(
        self: Arc<Self>,
        launch_build: Option<Build>,
        on_kept: bool,
        ready: Arc<AtomicBool>,
    ) {
        loop {
            tokio::time::sleep(ASK_EVERY).await;
            if says_ready(&self.node_socket).await {
                break;
            }
        }
        ready.store(true, Ordering::SeqCst);
        tokio::time::sleep(GRACE).await;
        let Some(build) = launch_build.filter(|_| !on_kept) else {
            return;
        };
        let this = self.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if kept(&this.dir).is_some_and(|kept| kept.build == build && kept.trees == this.trees) {
                return;
            }
            match keep(&this.dir, &this.trees, &build) {
                Ok(true) => tracing::info!(build = %build.hash, "kept this build as the last one that booted"),
                Ok(false) => tracing::info!("the compiled trees changed under the running daemon: its build is not kept"),
                Err(error) => tracing::warn!(%error, "could not keep the build that booted"),
            }
        })
        .await;
    }

    /// A start ended without being asked to.
    pub fn exited(&self, ready: bool) {
        let turn = self
            .judge
            .lock()
            .expect("judge poisoned")
            .exited(ready, Instant::now());
        if let Turn::GaveUp { from, to } = turn {
            tracing::error!(
                from = %from.hash,
                to = %to.hash,
                "the last build that booted failed {STRIKES} times too: starting the live build again, as before"
            );
            self.records.append(
                NETD_KILLS_FILE,
                &RolledBack {
                    at: records::now_ms(),
                    kind: "rollback-failed",
                    from,
                    to,
                    failures: STRIKES,
                    error: None,
                    step: None,
                },
            );
        }
    }

    fn boot_failure(&self) -> Option<BootFailure> {
        let raw = std::fs::read(self.history.join(BOOT_FAILURE_FILE)).ok()?;
        serde_json::from_slice(&raw).ok()
    }
}

/// Whether the daemon on `socket` is past its readiness gate. A daemon too old to report a boot is ready once it answers.
async fn says_ready(socket: &Path) -> bool {
    let asked = tokio::time::timeout(ASK_TIMEOUT, async {
        let mut stream = tokio::net::UnixStream::connect(socket).await?;
        stream
            .write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await?;
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await?;
        Ok::<_, std::io::Error>(answer)
    })
    .await;
    matches!(asked, Ok(Ok(answer)) if health_ready(&answer))
}

/// Whether a `/health` answer says ready. Pure.
pub fn health_ready(answer: &[u8]) -> bool {
    let Some(split) = answer.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    if !answer.starts_with(b"HTTP/1.1 200") && !answer.starts_with(b"HTTP/1.0 200") {
        return false;
    }
    let Ok(body) = serde_json::from_slice::<serde_json::Value>(&answer[split + 4..]) else {
        return false;
    };
    match body.get("boot").and_then(|boot| boot.get("ready")) {
        Some(ready) => ready.as_bool() == Some(true),
        None => body.get("ok").and_then(serde_json::Value::as_bool) == Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(hash: &str) -> Build {
        Build {
            hash: hash.into(),
            built_at: 1,
        }
    }

    // Three boots that never reach ready, the way netd's backoff spaces them.
    fn strike(judge: &mut Judge, live: &Build, kept: Option<&Build>, at: &mut Instant) -> Choice {
        let choice = judge.choose(Some(live), kept, *at);
        judge.exited(false, *at);
        *at += Duration::from_secs(5);
        choice
    }

    #[test]
    fn three_failed_boots_start_the_kept_build_once_and_stay_on_it() {
        let (bad, good) = (build("bad"), build("good"));
        let mut judge = Judge::default();
        let mut at = Instant::now();
        for _ in 0..STRIKES {
            assert_eq!(strike(&mut judge, &bad, Some(&good), &mut at), Choice::Live);
        }
        assert_eq!(
            judge.choose(Some(&bad), Some(&good), at),
            Choice::Kept {
                from: bad.clone(),
                to: good.clone(),
                first: true
            }
        );
        judge.exited(true, at);
        // A crash after ready, on the kept build, restarts the kept build without a second record.
        assert_eq!(
            judge.choose(Some(&bad), Some(&good), at),
            Choice::Kept {
                from: bad,
                to: good,
                first: false
            }
        );
    }

    #[test]
    fn a_kept_build_that_fails_too_is_given_up_for_the_live_one_never_back_and_forth() {
        let (bad, good) = (build("bad"), build("good"));
        let mut judge = Judge::default();
        let mut at = Instant::now();
        for _ in 0..STRIKES {
            strike(&mut judge, &bad, Some(&good), &mut at);
        }
        let mut turns = Vec::new();
        for _ in 0..STRIKES {
            assert!(matches!(
                judge.choose(Some(&bad), Some(&good), at),
                Choice::Kept { .. }
            ));
            turns.push(judge.exited(false, at));
            at += Duration::from_secs(5);
        }
        assert_eq!(
            turns.last(),
            Some(&Turn::GaveUp {
                from: bad.clone(),
                to: good.clone()
            })
        );
        for _ in 0..STRIKES * 3 {
            assert_eq!(strike(&mut judge, &bad, Some(&good), &mut at), Choice::Live);
        }
    }

    #[test]
    fn a_new_build_is_tried_first_with_strikes_of_its_own() {
        let (bad, good, fixed) = (build("bad"), build("good"), build("fixed"));
        let mut judge = Judge::default();
        let mut at = Instant::now();
        for _ in 0..STRIKES {
            strike(&mut judge, &bad, Some(&good), &mut at);
        }
        assert!(matches!(
            judge.choose(Some(&bad), Some(&good), at),
            Choice::Kept { .. }
        ));
        assert_eq!(judge.choose(Some(&fixed), Some(&good), at), Choice::Live);
        // Two strikes against the new build are not three.
        strike(&mut judge, &fixed, Some(&good), &mut at);
        strike(&mut judge, &fixed, Some(&good), &mut at);
        assert_eq!(judge.choose(Some(&fixed), Some(&good), at), Choice::Live);
    }

    #[test]
    fn nothing_rolls_back_without_a_different_kept_build_or_far_apart_failures() {
        let bad = build("bad");
        let mut judge = Judge::default();
        let mut at = Instant::now();
        for _ in 0..STRIKES * 2 {
            assert_eq!(strike(&mut judge, &bad, None, &mut at), Choice::Live);
            assert_eq!(strike(&mut judge, &bad, Some(&bad), &mut at), Choice::Live);
        }
        let (flaky, good) = (build("flaky"), build("good"));
        let mut judge = Judge::default();
        for _ in 0..STRIKES * 2 {
            assert_eq!(
                strike(&mut judge, &flaky, Some(&good), &mut at),
                Choice::Live
            );
            at += STRIKE_WINDOW;
        }
        // A boot that reached ready in between clears the count.
        let mut judge = Judge::default();
        for round in 0..STRIKES * 2 {
            judge.choose(Some(&flaky), Some(&good), at);
            judge.exited(round % 2 == 0, at);
        }
        assert_eq!(judge.choose(Some(&flaky), Some(&good), at), Choice::Live);
    }

    #[test]
    fn the_trees_are_the_mounts_under_the_daemon_but_the_checkout_and_netd() {
        let mountinfo = "\
1 0 8:1 / / rw - ext4 /dev/sda rw
2 1 8:2 /src/intentic /opt/sandbox/dev-checkout ro - ext4 /dev/sdd ro
3 1 8:2 /src/intentic/_sandbox/sandbox/dist /opt/sandbox/dist rw - ext4 /dev/sdd rw
4 1 8:2 /src/intentic/.image-out/netd /opt/sandbox/netd rw - ext4 /dev/sdd rw
5 1 8:2 /src/intentic/_tools/base/dist /opt/sandbox/node_modules/.pnpm/b/node_modules/@intentic/base/dist rw - ext4 /dev/sdd rw
6 1 8:3 /vol /history rw - ext4 /dev/sde rw";
        assert_eq!(
            trees_in(mountinfo, SANDBOX_ROOT, &NOT_TREES),
            vec![
                PathBuf::from("/opt/sandbox/dist"),
                PathBuf::from("/opt/sandbox/node_modules/.pnpm/b/node_modules/@intentic/base/dist"),
            ]
        );
    }

    #[test]
    fn health_is_ready_only_past_the_gate() {
        let answer = |status: &str, body: &str| {
            format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\r\n{body}")
        };
        assert!(health_ready(
            answer("200 OK", r#"{"ok":true,"boot":{"ready":true,"steps":[]}}"#).as_bytes()
        ));
        assert!(!health_ready(
            answer("200 OK", r#"{"ok":true,"boot":{"ready":false}}"#).as_bytes()
        ));
        assert!(health_ready(answer("200 OK", r#"{"ok":true}"#).as_bytes()));
        assert!(!health_ready(
            answer("503 Service Unavailable", r#"{"ok":true}"#).as_bytes()
        ));
        assert!(!health_ready(b"HTTP/1.1 200 OK\r\n\r\nnot json"));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("netd-fallback-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_build_is_kept_whole_and_replaces_the_one_before() {
        let root = scratch("keep");
        let tree = root.join("live/dist");
        std::fs::create_dir_all(tree.join("deep")).expect("tree");
        std::fs::write(tree.join("main.js"), "one").expect("write");
        std::fs::write(tree.join("deep/b.json"), "{}").expect("write");
        std::fs::write(tree.join("main.js.map"), "map").expect("write");
        let trees = vec![tree.clone()];
        let history = root.join("history");
        let first = fingerprint(&trees).expect("fingerprint");
        assert_eq!(fingerprint(&trees), Some(first.clone()));
        assert!(keep(&history, &trees, &first).expect("keep"));
        let copy = history
            .join(KEPT_DIR)
            .join("files")
            .join(tree.strip_prefix("/").expect("absolute"));
        assert_eq!(
            std::fs::read_to_string(copy.join("main.js")).expect("copied"),
            "one"
        );
        assert!(copy.join("deep/b.json").exists());
        assert!(
            !copy.join("main.js.map").exists(),
            "source maps are not kept"
        );
        assert_eq!(kept(&history).map(|kept| kept.build), Some(first.clone()));

        std::fs::write(tree.join("main.js"), "two!").expect("write");
        let second = fingerprint(&trees).expect("fingerprint");
        assert_ne!(second, first);
        // A build the trees no longer hold is not kept, and the kept one stays.
        assert!(!keep(&history, &trees, &first).expect("keep"));
        assert_eq!(kept(&history).map(|kept| kept.build), Some(first));
        assert!(keep(&history, &trees, &second).expect("keep"));
        assert_eq!(
            std::fs::read_to_string(copy.join("main.js")).expect("copied"),
            "two!"
        );
        let left: Vec<_> = std::fs::read_dir(&history)
            .expect("listed")
            .flatten()
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(
            left,
            vec![OsString::from(KEPT_DIR)],
            "one build on disk, nothing staged"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // The whole way back on a real Node, where there is one: a build that throws at load fails three starts, the fourth
    // runs the kept build through netd's own loader and is told it was rolled back, and a module the broken build
    // deleted is still found.
    #[tokio::test]
    async fn the_fourth_start_runs_the_kept_build_through_the_loader() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let root = scratch("launch");
        let tree = root.join("live/dist");
        std::fs::create_dir_all(&tree).expect("tree");
        std::fs::write(root.join("live/package.json"), r#"{"type":"module"}"#).expect("write");
        std::fs::write(tree.join("main.js"), r#"import { v } from "./b.js"; console.log(v, process.env.INTENTIC_ROLLED_BACK !== undefined);"#)
            .expect("write");
        std::fs::write(tree.join("b.js"), r#"export const v = "good";"#).expect("write");
        let history = root.join("history");
        let trees = vec![tree.clone()];
        let good = fingerprint(&trees).expect("fingerprint");
        assert!(keep(&history.join("daemon-builds"), &trees, &good).expect("keep"));
        std::fs::remove_file(tree.join("b.js")).expect("remove");
        std::fs::write(
            tree.join("main.js"),
            r#"throw new TypeError("broken build");"#,
        )
        .expect("write");
        std::fs::write(history.join(BOOT_FAILURE_FILE), r#"{"at":1,"version":"0.0.0","error":"TypeError: broken build","step":"Opening the netd door"}"#)
            .expect("write");

        let records = Arc::new(Records::in_dir(root.join("logs")));
        let fallback = Arc::new(Fallback::new(
            trees,
            history,
            &root,
            &root.join("node.sock"),
            records,
        ));
        let args = vec![OsString::from(tree.join("main.js"))];
        let run = |launch: &Launch| {
            std::process::Command::new("node")
                .args(&launch.args)
                .envs(launch.env.iter().cloned())
                .output()
                .expect("node runs")
        };
        for _ in 0..STRIKES {
            let launch = fallback.launch(&args).await;
            assert!(!launch.on_kept);
            assert!(!run(&launch).status.success());
            fallback.exited(false);
        }
        let launch = fallback.launch(&args).await;
        assert!(launch.on_kept);
        let ran = run(&launch);
        assert_eq!(
            String::from_utf8_lossy(&ran.stdout).trim(),
            "good true",
            "{}",
            String::from_utf8_lossy(&ran.stderr)
        );
        let written =
            std::fs::read_to_string(root.join("logs").join(NETD_KILLS_FILE)).expect("recorded");
        let line: serde_json::Value = serde_json::from_str(written.trim()).expect("one line");
        assert_eq!(line["kind"], "rolled-back");
        assert_eq!(line["to"]["hash"], good.hash.as_str());
        assert_eq!(line["step"], "Opening the netd door");
        let _ = std::fs::remove_dir_all(&root);
    }
}
