//! The change feed: a generation per checkout Node asked the front to count, moving whenever anything a `git status`
//! there reads may have changed. Every watch lives in one inotify instance, whose one queue orders every event, so a
//! sync that creates a sentinel and waits to read its event back has counted every write that finished before it.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use front_wire::WatchedCheckout;
use futures_util::StreamExt;
use inotify::{EventMask, EventStream, Inotify, WatchDescriptor, WatchMask, Watches};
use tokio::sync::watch;

// What a git dir holds that a status reads: the index, HEAD, and the heads of a merge, pick, revert or rebase underway.
const CHECKOUT_FILES: [&str; 6] = [
    "index",
    "HEAD",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
];

// Past this, a sync answers that nothing is known rather than keep a caller waiting on a reader that fell behind.
const SYNC_PATIENCE: Duration = Duration::from_secs(2);

fn tree_mask() -> WatchMask {
    WatchMask::CREATE
        | WatchMask::DELETE
        | WatchMask::MODIFY
        | WatchMask::ATTRIB
        | WatchMask::MOVED_FROM
        | WatchMask::MOVED_TO
        | WatchMask::DELETE_SELF
        | WatchMask::MOVE_SELF
        | WatchMask::ONLYDIR
}

fn git_mask() -> WatchMask {
    WatchMask::CREATE
        | WatchMask::DELETE
        | WatchMask::MODIFY
        | WatchMask::MOVED_FROM
        | WatchMask::MOVED_TO
        | WatchMask::ONLYDIR
}

#[derive(Debug)]
enum Watched {
    /// A directory of the checkout rooted at this path.
    Tree(PathBuf),
    /// A git dir: some checkout's own (its index and HEAD), some checkouts' common one (their packed refs), or both.
    GitDir(PathBuf),
    /// A directory under this common dir's `refs`.
    Refs(PathBuf),
    /// This common dir's `info`, where `exclude` lives.
    Info(PathBuf),
    Sentinel,
}

#[derive(Debug)]
struct Checkout {
    generation: u64,
    git_dir: PathBuf,
    common_dir: PathBuf,
    trees: HashSet<WatchDescriptor>,
    /// A watch the kernel refused (its limit): some change here could go unseen, so no count is claimed.
    blind: bool,
    /// Whether its first walk has finished: a count claimed before every directory is watched could miss a write.
    walked: bool,
}

#[derive(Default)]
struct State {
    checkouts: HashMap<PathBuf, Checkout>,
    watched: HashMap<WatchDescriptor, Watched>,
}

impl State {
    fn bump_where(&mut self, wanted: impl Fn(&Checkout) -> bool) {
        for checkout in self
            .checkouts
            .values_mut()
            .filter(|checkout| wanted(checkout))
        {
            checkout.generation += 1;
        }
    }

    fn bump(&mut self, dir: &Path) {
        if let Some(checkout) = self.checkouts.get_mut(dir) {
            checkout.generation += 1;
        }
    }
}

pub struct Feed {
    watches: Mutex<Watches>,
    state: Mutex<State>,
    sentinels: PathBuf,
    next_sentinel: AtomicU64,
    /// The highest sentinel the reader has read back.
    seen: watch::Sender<u64>,
}

impl Feed {
    /// Starts the feed with its sentinels under `sentinels` (created here); the reader runs until the process ends.
    pub fn start(sentinels: PathBuf) -> anyhow::Result<Arc<Self>> {
        std::fs::create_dir_all(&sentinels)?;
        let inotify = Inotify::init()?;
        let events = inotify.into_event_stream(vec![0_u8; 64 * 1024])?;
        let mut watches = events.watches();
        let sentinel = watches.add(&sentinels, WatchMask::CREATE | WatchMask::ONLYDIR)?;
        let feed = Arc::new(Self {
            watches: Mutex::new(watches),
            state: Mutex::new(State::default()),
            sentinels,
            next_sentinel: AtomicU64::new(0),
            seen: watch::Sender::new(0),
        });
        feed.state
            .lock()
            .expect("feed state poisoned")
            .watched
            .insert(sentinel, Watched::Sentinel);
        tokio::spawn(feed.clone().read(events));
        Ok(feed)
    }

    /// Counts a checkout from now on: its tree as git sees it, and the git files a status reads. Again for one already
    /// counted, it only adds watches for directories that appeared since.
    pub fn watch(self: &Arc<Self>, checkout: &WatchedCheckout) {
        let dir = PathBuf::from(&checkout.dir);
        let git_dir = PathBuf::from(&checkout.git_dir);
        let common_dir = PathBuf::from(&checkout.common_dir);
        {
            let mut state = self.state.lock().expect("feed state poisoned");
            state
                .checkouts
                .entry(dir.clone())
                .or_insert_with(|| Checkout {
                    generation: 0,
                    git_dir: git_dir.clone(),
                    common_dir: common_dir.clone(),
                    trees: HashSet::new(),
                    blind: false,
                    walked: false,
                });
        }
        self.add(&git_dir, git_mask(), Watched::GitDir(git_dir.clone()));
        self.add(&common_dir, git_mask(), Watched::GitDir(common_dir.clone()));
        self.add(
            &common_dir.join("info"),
            git_mask(),
            Watched::Info(common_dir.clone()),
        );
        for refs in directories_under(&common_dir.join("refs")) {
            self.add(&refs, git_mask(), Watched::Refs(common_dir.clone()));
        }
        self.walk_into(&dir, &dir);
        if let Some(checkout) = self
            .state
            .lock()
            .expect("feed state poisoned")
            .checkouts
            .get_mut(&dir)
        {
            checkout.walked = true;
        }
    }

    /// Stops counting the checkout at `dir`, and drops its git dirs' watches once no other checkout reads them.
    pub fn unwatch(&self, dir: &str) {
        let dir = PathBuf::from(dir);
        let mut state = self.state.lock().expect("feed state poisoned");
        let Some(checkout) = state.checkouts.remove(&dir) else {
            return;
        };
        let mut drop: Vec<WatchDescriptor> = checkout.trees.into_iter().collect();
        let shared = |path: &Path| {
            state
                .checkouts
                .values()
                .any(|other| other.git_dir == path || other.common_dir == path)
        };
        for path in [&checkout.git_dir, &checkout.common_dir] {
            if !shared(path) {
                drop.extend(
                    state
                        .watched
                        .iter()
                        .filter_map(|(wd, watched)| match watched {
                            Watched::GitDir(of) | Watched::Refs(of) | Watched::Info(of)
                                if of == path =>
                            {
                                Some(wd.clone())
                            }
                            _ => None,
                        }),
                );
            }
        }
        let mut watches = self.watches.lock().expect("feed watches poisoned");
        for wd in drop {
            state.watched.remove(&wd);
            let _ = watches.remove(wd);
        }
    }

    /// Forgets every checkout: a daemon that just started names again the ones it wants counted.
    pub fn reset(&self) {
        let dirs: Vec<PathBuf> = self
            .state
            .lock()
            .expect("feed state poisoned")
            .checkouts
            .keys()
            .cloned()
            .collect();
        for dir in dirs {
            self.unwatch(&dir.to_string_lossy());
        }
    }

    /// Each checkout's generation, once every write that finished before this call has been read: null for one not
    /// counted, one a watch was refused for, or when the reader did not catch up in time.
    pub async fn sync(&self, dirs: &[String]) -> Vec<Option<u64>> {
        let sentinel = self.next_sentinel.fetch_add(1, Ordering::Relaxed) + 1;
        let path = self.sentinels.join(sentinel.to_string());
        let caught_up = std::fs::write(&path, b"").is_ok() && {
            let mut seen = self.seen.subscribe();
            tokio::time::timeout(SYNC_PATIENCE, seen.wait_for(|seen| *seen >= sentinel))
                .await
                .is_ok_and(|read| read.is_ok())
        };
        let _ = std::fs::remove_file(&path);
        let state = self.state.lock().expect("feed state poisoned");
        dirs.iter()
            .map(|dir| {
                state
                    .checkouts
                    .get(Path::new(dir))
                    .filter(|checkout| caught_up && checkout.walked && !checkout.blind)
                    .map(|checkout| checkout.generation)
            })
            .collect()
    }

    fn add(&self, path: &Path, mask: WatchMask, watched: Watched) -> bool {
        let added = self
            .watches
            .lock()
            .expect("feed watches poisoned")
            .add(path, mask);
        match added {
            Ok(wd) => {
                let mut state = self.state.lock().expect("feed state poisoned");
                if let Watched::Tree(root) = &watched
                    && let Some(checkout) = state.checkouts.get_mut(root)
                {
                    checkout.trees.insert(wd.clone());
                }
                state.watched.insert(wd, watched);
                true
            }
            // A directory gone before its watch landed has nothing left to report.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "the change feed could not watch a directory");
                if let Watched::Tree(root) = &watched
                    && let Some(checkout) = self
                        .state
                        .lock()
                        .expect("feed state poisoned")
                        .checkouts
                        .get_mut(root)
                {
                    checkout.blind = true;
                }
                false
            }
        }
    }

    // Watches every directory of the checkout at `root` that git does not ignore, at or under `from`; bumps once they
    // are all watched, since a change landing before a watch did is otherwise unseen.
    fn walk_into(&self, root: &Path, from: &Path) {
        for dir in tree_directories(root, from) {
            self.add(&dir, tree_mask(), Watched::Tree(root.to_path_buf()));
        }
        self.state.lock().expect("feed state poisoned").bump(root);
    }

    async fn read(self: Arc<Self>, mut events: EventStream<Vec<u8>>) {
        while let Some(event) = events.next().await {
            match event {
                Ok(event) => self.handle(event.wd, event.mask, event.name.as_deref()),
                Err(error) => {
                    tracing::error!(%error, "the change feed stopped reading; every count is now unknown");
                    self.state
                        .lock()
                        .expect("feed state poisoned")
                        .checkouts
                        .values_mut()
                        .for_each(|checkout| checkout.blind = true);
                    return;
                }
            }
        }
    }

    fn handle(self: &Arc<Self>, wd: WatchDescriptor, mask: EventMask, name: Option<&OsStr>) {
        let mut state = self.state.lock().expect("feed state poisoned");
        if mask.contains(EventMask::Q_OVERFLOW) {
            tracing::warn!("the change feed's queue overflowed; every checkout counts as changed");
            state.bump_where(|_| true);
            return;
        }
        let Some(watched) = state.watched.get(&wd) else {
            return;
        };
        let name = name.and_then(OsStr::to_str);
        match watched {
            Watched::Sentinel => {
                if let Some(sentinel) = name.and_then(|name| name.parse::<u64>().ok()) {
                    self.seen.send_if_modified(|seen| {
                        let later = sentinel > *seen;
                        *seen = (*seen).max(sentinel);
                        later
                    });
                }
            }
            Watched::Tree(root) => {
                let root = root.clone();
                state.bump(&root);
                if mask.contains(EventMask::IGNORED) {
                    state.watched.remove(&wd);
                    if let Some(checkout) = state.checkouts.get_mut(&root) {
                        checkout.trees.remove(&wd);
                    }
                    return;
                }
                let grown = mask.contains(EventMask::ISDIR)
                    && mask.intersects(EventMask::CREATE | EventMask::MOVED_TO);
                // A `.gitignore` edit can un-ignore a directory, which then needs watching from the checkout's root.
                let rules = name == Some(".gitignore");
                drop(state);
                if grown || rules {
                    let feed = self.clone();
                    tokio::task::spawn_blocking(move || feed.walk_into(&root, &root));
                }
            }
            Watched::GitDir(dir) => {
                let dir = dir.clone();
                match name {
                    Some(file) if CHECKOUT_FILES.contains(&file) => {
                        state.bump_where(|checkout| checkout.git_dir == dir);
                    }
                    Some("packed-refs") => state.bump_where(|checkout| checkout.common_dir == dir),
                    _ => {}
                }
            }
            Watched::Refs(common) => {
                let common = common.clone();
                state.bump_where(|checkout| checkout.common_dir == common);
                let grown = mask.contains(EventMask::ISDIR)
                    && mask.intersects(EventMask::CREATE | EventMask::MOVED_TO);
                drop(state);
                if grown {
                    let refs = common.join("refs");
                    for dir in directories_under(&refs) {
                        self.add(&dir, git_mask(), Watched::Refs(common.clone()));
                    }
                    self.state
                        .lock()
                        .expect("feed state poisoned")
                        .bump_where(|checkout| checkout.common_dir == common);
                }
            }
            Watched::Info(common) => {
                if name == Some("exclude") {
                    let common = common.clone();
                    state.bump_where(|checkout| checkout.common_dir == common);
                }
            }
        }
    }
}

// `dir` and every directory under it, links not followed.
fn directories_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        found.push(next);
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                pending.push(entry.path());
            }
        }
    }
    found
}

// The directories of the checkout at `root`, at or under `from`, that git does not ignore: nested repositories and
// `.git` left out, links not followed. Walked from the root so every ignore file on the way applies.
fn tree_directories(root: &Path, from: &Path) -> Vec<PathBuf> {
    let within = from.to_path_buf();
    let root_owned = root.to_path_buf();
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .parents(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            let path = entry.path();
            if !entry.file_type().is_some_and(|kind| kind.is_dir()) {
                return false;
            }
            if entry.file_name() == ".git" {
                return false;
            }
            // Another repository's checkout answers for itself.
            if path != root_owned && path.join(".git").exists() {
                return false;
            }
            // Only the way down to `from`, and everything under it.
            path.starts_with(&within) || within.starts_with(path)
        })
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().starts_with(from))
        .map(|entry| entry.into_path())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    struct Repo {
        root: PathBuf,
        dir: PathBuf,
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn repo(name: &str) -> Repo {
        let root = std::env::temp_dir().join(format!("front-feed-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("work");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        git(&dir, &["init", "-q"]);
        std::fs::write(dir.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(dir.join("src/a.txt"), "a\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "one"]);
        Repo { root, dir }
    }

    fn checkout(repo: &Repo) -> WatchedCheckout {
        let git_dir = repo.dir.join(".git").to_string_lossy().into_owned();
        WatchedCheckout {
            dir: repo.dir.to_string_lossy().into_owned(),
            git_dir: git_dir.clone(),
            common_dir: git_dir,
        }
    }

    async fn generation(feed: &Feed, repo: &Repo) -> Option<u64> {
        feed.sync(&[repo.dir.to_string_lossy().into_owned()]).await[0]
    }

    fn feed(repo: &Repo) -> Arc<Feed> {
        Feed::start(repo.root.join("sentinels")).unwrap()
    }

    #[tokio::test]
    async fn a_write_that_finished_before_the_sync_is_always_counted() {
        let repo = repo("write");
        let feed = feed(&repo);
        feed.watch(&checkout(&repo));
        let before = generation(&feed, &repo).await.unwrap();
        for round in 0..50 {
            std::fs::write(repo.dir.join("src/a.txt"), format!("{round}\n")).unwrap();
            let after = generation(&feed, &repo).await.unwrap();
            assert!(after > before, "round {round}: a write went uncounted");
        }
    }

    #[tokio::test]
    async fn nothing_moves_the_count_while_nothing_changes() {
        let repo = repo("still");
        let feed = feed(&repo);
        feed.watch(&checkout(&repo));
        let first = generation(&feed, &repo).await.unwrap();
        assert_eq!(generation(&feed, &repo).await.unwrap(), first);
        // A read is not a change.
        let _ = std::fs::read(repo.dir.join("src/a.txt")).unwrap();
        assert_eq!(generation(&feed, &repo).await.unwrap(), first);
    }

    #[tokio::test]
    async fn an_ignored_directory_is_not_watched_and_a_new_one_is() {
        let repo = repo("dirs");
        std::fs::create_dir_all(repo.dir.join("target/debug")).unwrap();
        let feed = feed(&repo);
        feed.watch(&checkout(&repo));
        let first = generation(&feed, &repo).await.unwrap();
        std::fs::write(repo.dir.join("target/debug/out.bin"), "x").unwrap();
        assert_eq!(generation(&feed, &repo).await.unwrap(), first);

        std::fs::create_dir_all(repo.dir.join("src/deep")).unwrap();
        let grown = generation(&feed, &repo).await.unwrap();
        assert!(grown > first);
        // The new directory's own watch lands off the reader; once it has, a write inside it moves the count.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let watched = generation(&feed, &repo).await.unwrap();
        std::fs::write(repo.dir.join("src/deep/b.txt"), "b").unwrap();
        assert!(generation(&feed, &repo).await.unwrap() > watched);
    }

    #[tokio::test]
    async fn staging_and_committing_move_the_count() {
        let repo = repo("index");
        let feed = feed(&repo);
        feed.watch(&checkout(&repo));
        std::fs::write(repo.dir.join("src/a.txt"), "changed\n").unwrap();
        let edited = generation(&feed, &repo).await.unwrap();
        git(&repo.dir, &["add", "-A"]);
        let staged = generation(&feed, &repo).await.unwrap();
        assert!(staged > edited);
        git(&repo.dir, &["commit", "-q", "-m", "two"]);
        assert!(generation(&feed, &repo).await.unwrap() > staged);
    }

    #[tokio::test]
    async fn a_checkout_not_counted_answers_null_and_stops_when_unwatched() {
        let repo = repo("unwatch");
        let feed = feed(&repo);
        assert_eq!(generation(&feed, &repo).await, None);
        feed.watch(&checkout(&repo));
        assert!(generation(&feed, &repo).await.is_some());
        feed.unwatch(&repo.dir.to_string_lossy());
        assert_eq!(generation(&feed, &repo).await, None);
    }

    #[tokio::test]
    async fn a_nested_repository_is_left_to_its_own_count() {
        let repo = repo("nested");
        let inner = repo.dir.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        git(&inner, &["init", "-q"]);
        std::fs::write(repo.dir.join(".git/info/exclude"), "/inner\n").unwrap();
        let feed = feed(&repo);
        feed.watch(&checkout(&repo));
        let first = generation(&feed, &repo).await.unwrap();
        std::fs::write(inner.join("x.txt"), "x").unwrap();
        assert_eq!(generation(&feed, &repo).await.unwrap(), first);
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    // `FEED_BENCH=<checkout dir> cargo test -p intentic-front bench -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "measures a real checkout named by FEED_BENCH"]
    async fn a_real_checkout() {
        let dir = std::env::var("FEED_BENCH").unwrap();
        let git_dir = String::from_utf8(
            std::process::Command::new("git")
                .args(["-C", &dir, "rev-parse", "--absolute-git-dir"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_owned();
        let common_dir = String::from_utf8(
            std::process::Command::new("git")
                .args([
                    "-C",
                    &dir,
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                ])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_owned();
        let feed =
            Feed::start(std::env::temp_dir().join(format!("feed-bench-{}", std::process::id())))
                .unwrap();
        let started = std::time::Instant::now();
        feed.watch(&WatchedCheckout {
            dir: dir.clone(),
            git_dir,
            common_dir,
        });
        let walked = started.elapsed();
        let trees = feed
            .state
            .lock()
            .unwrap()
            .checkouts
            .values()
            .map(|c| c.trees.len())
            .sum::<usize>();
        let mut times = Vec::new();
        for _ in 0..200 {
            let at = std::time::Instant::now();
            assert!(feed.sync(std::slice::from_ref(&dir)).await[0].is_some());
            times.push(at.elapsed());
        }
        times.sort();
        println!(
            "walked {trees} directories in {walked:?}; sync p50 {:?} p99 {:?}",
            times[100], times[198]
        );
    }
}
