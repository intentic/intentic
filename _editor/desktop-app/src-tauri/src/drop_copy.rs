/* A BIG DROP ON THE WORKSPACE, COPIED INTO A SANDBOX ON THIS COMPUTER BY THE APP RATHER THAN THROUGH THE PAGE. */
//
// A folder dropped on the workspace's explorer normally goes the browser's way: the page walks it, reads every file
// and uploads it over HTTP to the sandbox's daemon. For a sandbox on this same computer that is the long way round,
// and for a big folder a costly one: a 30 GB folder of 66,000 films and stills froze the page for minutes and then
// never got going (2026-10-09). The app can do better, because it can see what the page cannot: where the dropped
// folder is on disk, and the Docker engine the sandbox runs in.
//
// So, on Windows, where WebView2 hands the app a dropped file's place: the page posts the drop's `File`s to the app
// (`chrome.webview.postMessageWithAdditionalObjects`), naming the folder they go into and the loopback port it reaches
// its sandbox on. The message is a JSON string: wry's handler, which carries Tauri's IPC, hears every message first and
// reads it as a string; an object makes it return an error, and WebView2 then calls no handler registered after it,
// this one included (seen on omen, 2026-10-09). Tauri, finding the string is none of its calls, logs a console.error
// in the page and does nothing else. The app finds the container publishing that port and walks the dropped folders
// itself. A drop big enough to be worth it is then copied by the routes each kind of file is fastest on (measured on
// Docker Desktop for Windows, 2026-10-09; see the desktop app's README):
//
// - staged: folders and files under MOUNTED_FROM are read by the app, READERS at once, into tar archives on this
//   computer's own disk, and a helper container that mounts those archives unpacks each into the workspace volume as
//   it is completed. Opening a file on Windows costs milliseconds (3.6 ms each under load on omen), so one at a time
//   20,000 stills took over a minute just to read; and every byte sent through Docker's API (`docker exec -i`) crawls
//   when the engine is busy. A local archive is neither: 20,000 stills staged in under a second, unpacked in four.
// - mounted: files from MOUNTED_FROM up are read by a helper container that bind-mounts the dropped folder read-only
//   beside the workspace volume and tars across: ~190 MB/s, but a few milliseconds per file over Docker Desktop's
//   file sharing, which a big file repays and a small one does not.
// - streamed: one archive into the sandbox's own `tar -x` through `docker exec -i`, for what the other two cannot
//   take: a big file on a place that will not mount (a network share), a file a helper had trouble with, and
//   everything when no helper will run.
//
// A file counts done only once the tar writing it into the workspace has shown it got past it: named the next file
// with no complaint between, or exited 0 at the archive's end. What went into a pipe is not yet in the workspace, and a
// full disk fails the write after the app has long moved on. A file written but not whole (a failed read, which tar
// pads out; a write that failed; an unpack cancelled partway) is removed from the workspace at the end, so a failed
// file is missing rather than there and wrong. A file no tar started on is left alone, older copy and all.
//
// The page hears how far it has got through `intentic:drop-copy` events and draws the same card it draws for an
// upload. Anything the app will not take (no Docker, no container on that port, a drop too small to bother, a file
// with no place on disk) is said back as `declined`, and the page uploads the drop the way it always has.
//
// The page can only name files the user dropped: a `File` with a place on disk exists only for something a person
// dragged in or picked. What it names freely, the folder they go into, is held to a plain relative path below /work.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::scripts::Binds;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

/// What the page's message says it is (`intentic` in the posted object).
pub const COPY: &str = "drop-copy";
pub const CANCEL: &str = "drop-copy-cancel";
/// The event the page hears the copy on.
const EVENT: &str = "intentic:drop-copy";
/// Where a sandbox's workspace is inside its container (@intentic/sandbox-run's WORKSPACE_ROOT).
const WORK: &str = "/work";
/// The container name prefix `ic` gives a sandbox (@intentic/sandbox-run's SANDBOX_CONTAINER_PREFIX).
const CONTAINER_PREFIX: &str = "intentic-sandbox-";
/// How often the page hears about a walk or a copy, at most.
const TICK: Duration = Duration::from_millis(250);
/// Folders deeper than this are left out, as the page's own walk leaves them (dropEntries.ts MAX_DEPTH).
const MAX_DEPTH: usize = 64;
/// Failed files the page is told of by name; the count covers the rest (the card shows as many).
const FAILURES_NAMED: usize = 50;
/// How long the container lookup may take: a running engine answers `docker ps` in well under a second.
const LOOKUP_LIMIT: Duration = Duration::from_secs(15);

/* WHAT THE PAGE ASKS. */

/// The page's request, as it posts it alongside the dropped files.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    /// The loopback port the page reaches its sandbox's daemon on: what names the container.
    pub port: u16,
    /// The folder the drop goes into, relative to /work; empty for the workspace's root.
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub skip: Skip,
    /// File names that make a folder a project the page offers to install (@intentic/workspace-setup MANIFESTS):
    /// where the walk finds one, the page is told, as its own walk would have told it.
    #[serde(default)]
    pub manifests: Vec<String>,
    /// The smallest drop worth copying this way; a smaller one is declined and uploaded as usual, which keeps the
    /// upload's own skipping of unchanged files.
    pub at_least: Threshold,
}

/// What the page's own walk leaves out (dropEntries.ts DROP_SKIP), sent so the two walks cannot drift apart.
#[derive(Debug, Default, Deserialize)]
pub struct Skip {
    #[serde(default)]
    pub dirs: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub prefixes: Vec<String>,
    #[serde(default)]
    pub keep: Vec<String>,
}

impl Skip {
    fn dir(&self, name: &str) -> bool {
        self.dirs.iter().any(|dir| dir == name)
    }

    fn file(&self, name: &str) -> bool {
        !self.keep.iter().any(|keep| keep == name)
            && (self.files.iter().any(|file| file == name)
                || self
                    .prefixes
                    .iter()
                    .any(|prefix| name.starts_with(prefix.as_str())))
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Threshold {
    pub files: u64,
    pub bytes: u64,
}

/// The page's message as a request, or nothing for one that is not well formed: an id that is a plain token, a
/// target that is a plain relative path, and lists of a sane length.
pub fn parse_request(message: &Value) -> Option<Request> {
    let request: Request = serde_json::from_value(message.clone()).ok()?;
    let names_ok = |names: &[String]| names.len() <= 256 && names.iter().all(|name| is_name(name));
    (is_id(&request.id)
        && request.port != 0
        && is_target(&request.target)
        && names_ok(&request.skip.dirs)
        && names_ok(&request.skip.files)
        && names_ok(&request.skip.prefixes)
        && names_ok(&request.skip.keep)
        && names_ok(&request.manifests))
    .then_some(request)
}

/// The id a cancel names, if it is one this module could have minted a run for.
pub fn cancel_id(message: &Value) -> Option<&str> {
    message["id"].as_str().filter(|id| is_id(id))
}

fn is_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// One file or folder name: no separator, not `.` or `..`, nothing a path could be built out of.
fn is_name(name: &str) -> bool {
    (1..=255).contains(&name.len())
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
}

/// A folder below /work, as the page names it: empty for /work itself, or names joined by `/`.
pub fn is_target(target: &str) -> bool {
    target.is_empty() || (target.len() <= 1024 && target.split('/').all(is_name))
}

/* THE CONTAINER. */

/// The sandbox container publishing `127.0.0.1:<port>`, from `docker ps --format '{{.Names}}\t{{.Ports}}'`: the
/// address the page reaches its daemon on is the one thing it and this app both know about the sandbox.
pub fn container_for_port(listing: &str, port: u16) -> Option<String> {
    let published = format!("127.0.0.1:{port}->");
    listing.lines().find_map(|line| {
        let (name, ports) = line.split_once('\t')?;
        let name = name.trim();
        (name.starts_with(CONTAINER_PREFIX)
            && crate::setup_link::is_slug(&name[CONTAINER_PREFIX.len()..])
            && ports
                .split(',')
                .any(|port| port.trim().starts_with(&published)))
        .then(|| name.to_string())
    })
}

fn find_container(port: u16) -> Result<String, String> {
    let mut command = crate::scripts::docker_command();
    command.args([
        "ps",
        "--filter",
        &format!("name={CONTAINER_PREFIX}"),
        "--format",
        "{{.Names}}\t{{.Ports}}",
    ]);
    let listing = crate::scripts::capture("docker ps", command, LOOKUP_LIMIT)
        .map_err(|silence| format!("Docker didn't answer: {silence}"))?;
    if !listing.success {
        return Err(format!("Docker refused: {}", listing.stderr.trim()));
    }
    container_for_port(&listing.stdout, port)
        .ok_or_else(|| format!("No sandbox on this computer answers on port {port}."))
}

/* THE WALK. */

/// One dropped file or folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    pub name: String,
    pub dir: bool,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dir,
    File,
}

/// One file or folder to copy: its path below /work (`/`-separated), its path within the drop (which starts with its
/// root's name), where it is on disk, and the root it came in under.
#[derive(Debug)]
struct Item {
    name: String,
    relative: String,
    source: PathBuf,
    kind: Kind,
    size: u64,
    mtime: u64,
    root: usize,
}

#[derive(Debug, Default)]
pub struct Scan {
    pub roots: Vec<Root>,
    /// Each root's place on disk, in `roots` order.
    places: Vec<PathBuf>,
    items: Vec<Item>,
    pub files: u64,
    pub bytes: u64,
    /// Files and folders found and not read: a folder that would not list, a name that is not Unicode, a link.
    pub unreadable: u64,
    /// Drop-relative paths of the project manifests found, for the page's install offer.
    pub manifests: Vec<String>,
}

fn mtime_of(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_secs())
}

fn join(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

/// Walks the dropped `sources` the way the page's own walk would (dropEntries.ts): ignored folders and secret files
/// left out, links not followed, `target`'s own `.git` never written over. `tick` hears the running totals and the
/// path just found. A cancel stops the walk where it is.
pub fn scan(
    sources: &[PathBuf],
    target: &str,
    skip: &Skip,
    manifests: &HashSet<&str>,
    cancel: &AtomicBool,
    tick: &mut dyn FnMut(&Scan, &str),
) -> Scan {
    let mut scan = Scan::default();
    let mut last = Instant::now();
    for source in sources {
        let Some(name) = source
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
        else {
            scan.unreadable += 1;
            continue;
        };
        // /work/.git is a pointer file: a repo dropped on the root would aim a folder at it (dropEntries.ts).
        if target.is_empty() && name == ".git" {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(source) else {
            scan.unreadable += 1;
            continue;
        };
        let root = scan.roots.len();
        scan.roots.push(Root {
            name: name.clone(),
            dir: metadata.is_dir(),
            files: 0,
            bytes: 0,
        });
        scan.places.push(source.clone());
        let mut pending = vec![(source.clone(), name, metadata, 0usize)];
        while let Some((path, relative, metadata, depth)) = pending.pop() {
            if cancel.load(Ordering::Relaxed) {
                return scan;
            }
            let leaf = relative.rsplit('/').next().unwrap_or(&relative).to_string();
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                scan.unreadable += 1;
                continue;
            }
            if metadata.is_file() {
                if skip.file(&leaf) {
                    continue;
                }
                if manifests.contains(leaf.as_str()) {
                    scan.manifests.push(relative.clone());
                }
                scan.files += 1;
                scan.bytes += metadata.len();
                scan.roots[root].files += 1;
                scan.roots[root].bytes += metadata.len();
                scan.items.push(Item {
                    name: join(target, &relative),
                    relative: relative.clone(),
                    source: path,
                    kind: Kind::File,
                    size: metadata.len(),
                    mtime: mtime_of(&metadata),
                    root,
                });
                if last.elapsed() >= TICK {
                    last = Instant::now();
                    tick(&scan, &relative);
                }
                continue;
            }
            if !metadata.is_dir() || skip.dir(&leaf) || depth > MAX_DEPTH {
                continue;
            }
            scan.items.push(Item {
                name: join(target, &relative),
                relative: relative.clone(),
                source: path.clone(),
                kind: Kind::Dir,
                size: 0,
                mtime: mtime_of(&metadata),
                root,
            });
            let Ok(entries) = std::fs::read_dir(&path) else {
                scan.unreadable += 1;
                continue;
            };
            for entry in entries {
                let Ok(entry) = entry else {
                    scan.unreadable += 1;
                    continue;
                };
                let (Some(child), Ok(metadata)) = (
                    entry.file_name().to_str().map(str::to_string),
                    entry.metadata(),
                ) else {
                    scan.unreadable += 1;
                    continue;
                };
                pending.push((entry.path(), join(&relative, &child), metadata, depth + 1));
            }
        }
    }
    scan
}

/* HOW FAR IT HAS GOT. */

/// How far a copy has got, over both routes: whole files and their bytes, the bytes of files going now, and per root.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Copied {
    pub done: u64,
    pub done_bytes: u64,
    pub live_bytes: u64,
    pub failed: u64,
    /// The first FAILURES_NAMED failures: the file's path below /work, and why.
    pub failures: Vec<(String, String)>,
    /// Per root, in [`Scan::roots`] order: files done and failed.
    pub roots: Vec<(u64, u64)>,
    pub current: String,
}

impl Copied {
    fn fail(&mut self, item: &Item, error: String) {
        self.failed += 1;
        self.roots[item.root].1 += 1;
        if self.failures.len() < FAILURES_NAMED {
            self.failures.push((item.name.clone(), error));
        }
    }

    fn land(&mut self, item: &Item) {
        self.done += 1;
        self.done_bytes += item.size;
        self.roots[item.root].0 += 1;
    }
}

/// The copy's totals, and what the page hears of them: one report per TICK at most.
struct Meter<'a> {
    copied: Copied,
    last: Instant,
    tick: &'a mut dyn FnMut(&Copied),
    /// Files below /work that a route's tar started writing and did not show it finished: padded after a failed read,
    /// a write that failed, cut off by a cancel. Taken out again by a later route landing the file, and removed from
    /// the workspace at the end (`remove_spoiled`), so a failed file is missing rather than there and wrong.
    spoiled: HashSet<String>,
}

impl<'a> Meter<'a> {
    fn new(roots: usize, tick: &'a mut dyn FnMut(&Copied)) -> Self {
        Self {
            copied: Copied {
                roots: vec![(0, 0); roots],
                ..Copied::default()
            },
            last: Instant::now(),
            tick,
            spoiled: HashSet::new(),
        }
    }

    fn report(&mut self) {
        if self.last.elapsed() >= TICK {
            self.last = Instant::now();
            (self.tick)(&self.copied);
        }
    }

    fn read(&mut self, bytes: u64) {
        self.copied.live_bytes += bytes;
        self.report();
    }

    /// A file is in the workspace whole: counted done, and no longer spoiled if an earlier route left it partial.
    fn landed(&mut self, item: &Item) {
        self.spoiled.remove(&item.name);
        self.copied.land(item);
    }
}

/// Why a copy stopped before the end.
#[derive(Debug, PartialEq, Eq)]
enum Stop {
    Cancelled,
    Failed(String),
}

/// The error a cancel ends an archive with. Not `ErrorKind::Interrupted`: `io::Copy`, which tar copies a file's bytes
/// with, retries a read that says that, forever.
fn cancelled() -> io::Error {
    io::Error::other("cancelled")
}

/* READING: the files every route but the mounted one reads itself, many at once. */

/// Files the app reads at once. Opening a file on Windows costs milliseconds whatever its size (3.6 ms each on omen
/// with its CI running, 2026-10-09), and the wait is the disk's and the scanner's, not this thread's: 20,000 stills took
/// 72 s read one at a time, 13 s sixteen at a time.
const READERS: usize = 16;
/// Files read and not yet written, at most. Each is under MOUNTED_FROM, so this and READERS bound the memory a copy
/// holds to about (READAHEAD + READERS) × MOUNTED_FROM.
const READAHEAD: usize = 32;

/// One item as an archive writer gets it.
enum Ready {
    Dir,
    /// The whole file, read by a reader.
    Bytes(Vec<u8>),
    /// A file too big to hold in memory: the writer reads it from disk as it writes it.
    Open,
    /// A file that would not read.
    Failed(String),
}

/// Reads one file whole, or says it is too big to (from the scan, or grown past MOUNTED_FROM since).
fn read_whole(item: &Item) -> Ready {
    if item.size >= MOUNTED_FROM {
        return Ready::Open;
    }
    let read = std::fs::File::open(&item.source).and_then(|file| {
        let mut bytes = Vec::with_capacity(usize::try_from(item.size).unwrap_or(0));
        file.take(MOUNTED_FROM).read_to_end(&mut bytes)?;
        Ok(bytes)
    });
    match read {
        Ok(bytes) if bytes.len() as u64 >= MOUNTED_FROM => Ready::Open,
        Ok(bytes) => Ready::Bytes(bytes),
        Err(error) => Ready::Failed(error.to_string()),
    }
}

/// Hands every item to `put` as it is ready: the folders first, in walk order, so the tree is there before anything
/// lands in it; then the files, as READERS threads finish reading them. An error from `put` stops the readers and is
/// returned; so does the cancel.
fn each_ready<'i>(
    items: &[&'i Item],
    cancel: &AtomicBool,
    put: &mut dyn FnMut(&'i Item, Ready) -> io::Result<()>,
) -> io::Result<()> {
    for &item in items.iter().filter(|item| item.kind == Kind::Dir) {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        put(item, Ready::Dir)?;
    }
    let files: Vec<&Item> = items
        .iter()
        .copied()
        .filter(|item| item.kind == Kind::File)
        .collect();
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let (send, ready) = mpsc::sync_channel::<(usize, Ready)>(READAHEAD);
        for _ in 0..READERS.min(files.len()) {
            let (send, files, next) = (send.clone(), &files, &next);
            scope.spawn(move || {
                while !cancel.load(Ordering::Relaxed) {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&item) = files.get(index) else {
                        break;
                    };
                    // A send that fails is the writer gone: the copy has stopped.
                    if send.send((index, read_whole(item))).is_err() {
                        break;
                    }
                }
            });
        }
        drop(send);
        for (index, item) in ready {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            put(files[index], item)?;
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        Ok(())
    })
}

/// What became of one item put into an archive: whether it went in whole, and how many bytes of it went in.
struct Appended {
    whole: bool,
    bytes: u64,
}

/// Appends one ready item to `builder`. A file that will not read is recorded failed and left out; a big file read
/// from disk that fails partway is padded out (see [`Exact`]) and recorded failed, and is the caller's to mark spoiled
/// once a tar has written it. `Err` only for the archive itself: `out` refusing a write, or the cancel, both possibly
/// partway through the item.
fn append<W: Write>(
    builder: &mut tar::Builder<W>,
    item: &Item,
    ready: Ready,
    cancel: &AtomicBool,
    meter: &mut Meter,
) -> io::Result<Appended> {
    let (file, size) = match ready {
        Ready::Dir => {
            let mut head = header(Kind::Dir, 0, item.mtime);
            builder.append_data(&mut head, &item.name, io::empty())?;
            return Ok(Appended {
                whole: true,
                bytes: 0,
            });
        }
        Ready::Failed(error) => {
            meter.copied.fail(item, error);
            return Ok(Appended {
                whole: false,
                bytes: 0,
            });
        }
        Ready::Bytes(bytes) => {
            meter.copied.current.clone_from(&item.name);
            let mut head = header(Kind::File, bytes.len() as u64, item.mtime);
            builder.append_data(&mut head, &item.name, bytes.as_slice())?;
            return Ok(Appended {
                whole: true,
                bytes: bytes.len() as u64,
            });
        }
        Ready::Open => {
            let opened = std::fs::File::open(&item.source).and_then(|file| {
                let size = file.metadata()?.len();
                Ok((file, size))
            });
            match opened {
                Ok(opened) => opened,
                Err(error) => {
                    meter.copied.fail(item, error.to_string());
                    return Ok(Appended {
                        whole: false,
                        bytes: 0,
                    });
                }
            }
        }
    };
    meter.copied.current.clone_from(&item.name);
    // The file's bytes count while it goes, and are the caller's to count once it has gone.
    let before = meter.copied.live_bytes;
    let mut head = header(Kind::File, size, item.mtime);
    let mut exact = Exact {
        inner: file,
        remaining: size,
        error: None,
        meter: &mut *meter,
        cancel,
    };
    builder.append_data(&mut head, &item.name, &mut exact)?;
    let error = exact.error.take();
    meter.copied.live_bytes = before;
    if let Some(error) = error {
        meter.copied.fail(item, error);
        return Ok(Appended {
            whole: false,
            bytes: size,
        });
    }
    Ok(Appended {
        whole: true,
        bytes: size,
    })
}

/* THE STREAMED ROUTE: one archive into `tar -x` in the sandbox, for what the other routes cannot take. */

/// A file's bytes, exactly as many as its header says. The header is written before the first byte is read, so a
/// file that shrinks, or fails to read halfway, is padded out with zeros rather than leaving the archive misaligned
/// for every file after it; its failure is recorded, and the page is told it did not land whole. A cancel is the
/// one error passed on: it ends the archive.
struct Exact<'a, 'm, R> {
    inner: R,
    remaining: u64,
    error: Option<String>,
    meter: &'a mut Meter<'m>,
    cancel: &'a AtomicBool,
}

impl<R: Read> Read for Exact<'_, '_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if self.remaining == 0 {
            return Ok(0);
        }
        let want = buf
            .len()
            .min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
        let got = if self.error.is_some() {
            0
        } else {
            loop {
                match self.inner.read(&mut buf[..want]) {
                    Ok(got) => break got,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        self.error = Some(error.to_string());
                        break 0;
                    }
                }
            }
        };
        let got = if got == 0 {
            // Short or failed: zeros for the rest of what the header promised.
            self.error
                .get_or_insert_with(|| "it got shorter while it was being copied".to_string());
            buf[..want].fill(0);
            want
        } else {
            got
        };
        self.remaining -= got as u64;
        self.meter.read(got as u64);
        Ok(got)
    }
}

fn header(kind: Kind, size: u64, mtime: u64) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(match kind {
        Kind::Dir => tar::EntryType::Directory,
        Kind::File => tar::EntryType::Regular,
    });
    header.set_size(size);
    header.set_mode(if kind == Kind::Dir { 0o755 } else { 0o644 });
    header.set_mtime(mtime);
    // Owned by root, as everything else in /work is: tar run as root keeps the archive's owners.
    header.set_uid(0);
    header.set_gid(0);
    header
}

/* LANDING: a file counts done once the tar writing it into the workspace has shown it got past it. */

/// What a `tar -x -v` writing into the workspace has said, read against the members it was given, in their order.
/// tar names each member as it starts writing it, and complains about one it could not write before it names the
/// next; with its stderr joined to its stdout the two come in the order tar wrote them. So a member is whole once tar
/// names a later one with no complaint between, or once tar exits 0 after it. Counting a file done as it went into the
/// pipe, as this module first did, counted a file the sandbox then failed to write (a full disk) as landed, and left
/// it there cut short (2026-10-10).
struct Writes<'i> {
    members: Vec<Member<'i>>,
    /// Members are named by their path within the drop (the mounting helper's) rather than below /work.
    by_relative: bool,
    /// The bytes of a member count as going (`live_bytes`) from when it went in until it lands (the streamed route's).
    holds_live: bool,
    /// The first member tar has not named.
    next: usize,
    /// The member tar named last, being written until it names another.
    writing: Option<usize>,
    /// Members from here on have not been vouched for by whatever produced the archive: tar got past them, but a
    /// complaint about reading one may still be on its way (the mounting helper's reading tar, on another stream).
    gate: usize,
    /// The bytes of the files landed.
    landed_bytes: u64,
    /// tar's complaints, in its words, for the card when the copy fails.
    complaints: String,
    /// tar's lines as they arrive, while the archive is still being written (the streamed route's).
    heard: Option<mpsc::Receiver<String>>,
    /// The archive is partway through a member: ended now, it leaves tar with some of that member.
    cut: bool,
}

struct Member<'i> {
    item: &'i Item,
    /// Not whole whatever tar says: it would not read whole and was padded.
    troubled: bool,
    /// Already counted failed, by the route that padded it.
    counted: bool,
    /// tar complained about it: not whole, unless tar exits 0, which makes every complaint a warning.
    complained: bool,
    /// tar named it, so it has written some of it at least.
    named: bool,
    /// tar got past it without a complaint, waiting for the gate.
    passed: bool,
    landed: bool,
}

/// How much of tar's complaining the card is told.
const COMPLAINTS: usize = 4 * 1024;
/// How far past the member it expects next a name is looked for. tar names members in order and passes over only the
/// ones that never went in, so a name further on is not one; the bound keeps a tar whose lines never match a name from
/// costing a search of the whole archive per line.
const NAMES_AHEAD: usize = 256;

impl<'i> Writes<'i> {
    fn new(by_relative: bool, holds_live: bool, heard: Option<mpsc::Receiver<String>>) -> Self {
        Self {
            members: Vec::new(),
            by_relative,
            holds_live,
            next: 0,
            writing: None,
            gate: usize::MAX,
            landed_bytes: 0,
            complaints: String::new(),
            heard,
            cut: false,
        }
    }

    fn push(&mut self, item: &'i Item, troubled: bool) {
        self.members.push(Member {
            item,
            troubled,
            counted: troubled,
            complained: false,
            named: false,
            passed: false,
            landed: false,
        });
    }

    fn key(&self, index: usize) -> &str {
        let item = self.members[index].item;
        if self.by_relative {
            &item.relative
        } else {
            &item.name
        }
    }

    /// The member `name` is, looked for from the first tar has not named; a folder tar names with a `/` after.
    fn find(&self, name: &str) -> Option<usize> {
        let bare = name.strip_suffix('/').unwrap_or(name);
        let upto = self.members.len().min(self.next + NAMES_AHEAD);
        (self.next..upto).find(|&index| {
            let key = self.key(index);
            key == name || key == bare
        })
    }

    /// tar has named the member at `index`, so it got past the one before. Members passed over were never in the
    /// archive (the reading tar could not open them, and said so), or have a name tar did not print as one line; none
    /// of them counts as named.
    fn named(&mut self, index: usize, meter: &mut Meter) {
        if let Some(before) = self.writing.take() {
            self.pass(before, meter);
        }
        self.members[index].named = true;
        self.writing = Some(index);
        self.next = index + 1;
    }

    fn pass(&mut self, index: usize, meter: &mut Meter) {
        self.members[index].passed = true;
        if index < self.gate {
            self.land(index, meter);
        }
    }

    fn land(&mut self, index: usize, meter: &mut Meter) {
        let member = &mut self.members[index];
        if member.troubled || member.complained || member.landed {
            return;
        }
        member.landed = true;
        let item = member.item;
        if item.kind == Kind::File {
            self.landed_bytes += item.size;
            if self.holds_live {
                meter.copied.live_bytes = meter.copied.live_bytes.saturating_sub(item.size);
            }
            meter.landed(item);
        }
    }

    /// Whatever produced the archive has got past every member before `upto` without a complaint of its own: those tar
    /// got past land now.
    fn vouch(&mut self, upto: usize, meter: &mut Meter) {
        let from = self.gate.min(self.members.len());
        self.gate = upto;
        for index in from..upto.min(self.members.len()) {
            if self.members[index].passed {
                self.land(index, meter);
            }
        }
    }

    /// The member a complaint (what follows its `tar: `) is about: the one whose path it starts with (the longest that
    /// fits, a name may hold `: `).
    fn about(&self, said: &str) -> Option<usize> {
        let from = self.next.saturating_sub(NAMES_AHEAD);
        let upto = self.members.len().min(self.next + NAMES_AHEAD);
        (from..upto)
            .filter(|&index| {
                said.strip_prefix(self.key(index))
                    .is_some_and(|rest| rest.starts_with(": "))
            })
            .max_by_key(|&index| self.key(index).len())
    }

    /// One of tar's complaints: about the member it names, else about the member being written. tar's closing
    /// "Exiting with failure status due to previous errors" is said once it got to the archive's end, every complaint
    /// already made: the member it was on is as whole as nothing said otherwise.
    fn complaint(&mut self, said: &str, meter: &mut Meter) {
        match self.about(said) {
            Some(index) => self.members[index].complained = true,
            None if said.starts_with("Exiting with failure status") => {
                if let Some(last) = self.writing.take() {
                    self.pass(last, meter);
                }
            }
            None => {
                if let Some(index) = self.writing {
                    self.members[index].complained = true;
                }
            }
        }
        if self.complaints.len() < COMPLAINTS {
            self.complaints.push_str("tar: ");
            self.complaints.push_str(said);
            self.complaints.push('\n');
        }
    }

    /// One line from a tar writing these members and nothing else: a name, a complaint, or nothing to go on.
    fn hear(&mut self, line: &str, meter: &mut Meter) {
        if let Some(index) = self.find(line) {
            self.named(index, meter);
        } else if let Some(said) = line.strip_prefix("tar: ") {
            self.complaint(said, meter);
        }
    }

    /// Takes in what tar has said so far, without waiting.
    fn catch_up(&mut self, meter: &mut Meter) {
        let Some(heard) = self.heard.take() else {
            return;
        };
        for line in heard.try_iter() {
            self.hear(&line, meter);
        }
        self.heard = Some(heard);
    }

    /// Takes in the rest of what tar said, once it has exited.
    fn hear_out(&mut self, meter: &mut Meter) {
        if let Some(heard) = self.heard.take() {
            for line in heard.iter() {
                self.hear(&line, meter);
            }
        }
    }

    /// tar has exited. `exited_ok`: with 0, so what it complained about were warnings, and the member it was on is
    /// whole too. `complete`: the archive it was given held every member whole, so after a 0 every member landed, named
    /// or not (a name tar printed that was not read as one).
    fn end(&mut self, exited_ok: bool, complete: bool, meter: &mut Meter) {
        let last = self.writing.take();
        if !exited_ok {
            return;
        }
        for index in 0..self.members.len() {
            self.members[index].complained = false;
            if self.members[index].passed {
                self.pass(index, meter);
            }
        }
        if let Some(last) = last {
            self.pass(last, meter);
        }
        if complete {
            for index in 0..self.members.len() {
                self.pass(index, meter);
            }
        }
    }

    /// Files tar started and did not finish, for `remove_spoiled`: a later route landing one takes it off again.
    fn spoil(&self, meter: &mut Meter) {
        for member in &self.members {
            if member.named && !member.landed && member.item.kind == Kind::File {
                meter.spoiled.insert(member.item.name.clone());
            }
        }
    }

    /// The members that did not land, in order.
    fn unlanded(&self) -> impl Iterator<Item = &'i Item> + '_ {
        self.members
            .iter()
            .filter(|member| !member.landed)
            .map(|member| member.item)
    }
}

/// Writes `items` as one tar archive into `out`, named by their paths below /work, each put in `writes` as it goes in:
/// counted done only once the tar unpacking it says it landed, and a file that would not read whole marked as it goes
/// (see [`append`]). `Err` only for the archive itself; the builder still ends the archive, so a tar reading it gets
/// to the end of what it was sent.
fn write_archive<'i, W: Write>(
    out: W,
    items: &[&'i Item],
    cancel: &AtomicBool,
    meter: &mut Meter,
    writes: &mut Writes<'i>,
) -> io::Result<()> {
    let mut builder = tar::Builder::new(out);
    each_ready(items, cancel, &mut |item, ready| {
        // A member from its header on: an archive cut partway through it leaves tar with some of it.
        let goes_in = !matches!(ready, Ready::Failed(_));
        if goes_in {
            writes.push(item, false);
            writes.cut = true;
        }
        let appended = append(&mut builder, item, ready, cancel, meter)?;
        writes.cut = false;
        if goes_in && !appended.whole {
            if appended.bytes == 0 {
                // Would not open: nothing of it went in.
                writes.members.pop();
            } else if let Some(member) = writes.members.last_mut() {
                // Padded, and counted failed by `append`: spoiled once tar has written it.
                member.troubled = true;
                member.counted = true;
            }
        } else if goes_in && writes.holds_live {
            // Sent, and going until tar says it landed.
            meter.copied.live_bytes += appended.bytes;
        }
        writes.catch_up(meter);
        meter.report();
        Ok(())
    })?;
    builder.into_inner()?.flush()
}

/// Why a copy did not land, in the words the card shows: Docker's own where it said any.
fn copy_error(written: Option<&io::Error>, exited_ok: Option<bool>, said: &str) -> Option<String> {
    let said = said.trim();
    match (written, exited_ok) {
        (None, Some(true)) => None,
        _ if !said.is_empty() => Some(format!("Docker stopped the copy: {said}")),
        (Some(error), _) => Some(format!("The copy stopped: {error}")),
        _ => Some("Docker stopped the copy without saying why.".to_string()),
    }
}

/// Waits for `child` at most `limit`, then kills it.
fn wait_for(child: &mut Child, limit: Duration) -> io::Result<ExitStatus> {
    let until = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= until {
            let _ = child.kill();
            return child.wait();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// `read`'s lines, as they come, on a thread of its own, each passed to `send` until it refuses one. Bytes that are
/// not UTF-8 are replaced rather than ending the reading, which would lose every line after.
fn each_line(read: impl Read + Send + 'static, send: impl Fn(String) -> bool + Send + 'static) {
    std::thread::spawn(move || {
        use std::io::BufRead;
        let mut read = io::BufReader::new(read);
        let mut line = Vec::new();
        loop {
            line.clear();
            match read.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&line);
            if !send(text.trim_end_matches(['\n', '\r']).to_string()) {
                break;
            }
        }
    });
}

/// `read`'s lines, as they come.
fn lines_of(read: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (lines, heard) = mpsc::channel::<String>();
    each_line(read, move |line| lines.send(line).is_ok());
    heard
}

/// What the sandbox's tar runs for the streamed route: the archive on its stdin unpacked into /work, naming each member
/// as it starts it (`-v`, which GNU tar flushes line by line) with its complaints on the same stream. Names as they are
/// (`literal`), not escaped as tar escapes them in a C locale. A time stamp in the future is no reason to doubt a file.
const STREAM_SCRIPT: &str =
    "tar -x -v --quoting-style=literal --warning=no-timestamp -f - -C /work 2>&1";

/// `items` through `docker exec -i -u 0 <container> sh -c 'tar -x …'`: the archive on tar's stdin, unpacked by the
/// sandbox's own tar into its workspace, parent folders and all. Not `docker cp -`, which unpacks through Docker
/// Desktop's backend at about 20 ms a file: 20,000 stills took 170 s that way on omen (2026-10-09).
fn stream(
    container: &str,
    items: &[&Item],
    cancel: &AtomicBool,
    meter: &mut Meter,
) -> Result<(), Stop> {
    let mut command = crate::scripts::docker_command();
    command
        .args([
            "exec",
            "-i",
            "-u",
            "0",
            container,
            "sh",
            "-c",
            STREAM_SCRIPT,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| Stop::Failed(format!("Docker wouldn't start the copy: {error}")))?;
    let stderr = child.stderr.take().map(|stderr| {
        std::thread::spawn(move || {
            let mut said = String::new();
            let _ = stderr.take(16 * 1024).read_to_string(&mut said);
            said
        })
    });
    let mut writes = Writes::new(false, true, child.stdout.take().map(lines_of));
    let live_before = meter.copied.live_bytes;
    let written = match child.stdin.take() {
        Some(stdin) => write_archive(
            BufWriter::with_capacity(1 << 20, stdin),
            items,
            cancel,
            meter,
            &mut writes,
        ),
        None => Err(io::Error::other("docker took no input")),
    };
    // Cut partway through a member: tar has some of it, and may read the archive's end the builder wrote after it as
    // the rest of it, and say nothing.
    let cut = writes.cut;
    if cut {
        if let Some(member) = writes.members.last_mut() {
            member.troubled = true;
        }
    }
    // The archive has ended either way, so tar ends by itself, having said what it wrote. Docker is given a while to
    // pass that on after a failure or a cancel; after a whole archive, tar takes as long as the disk takes.
    let status = if written.is_ok() {
        child.wait()
    } else {
        wait_for(&mut child, LOOKUP_LIMIT)
    };
    writes.hear_out(meter);
    let said = stderr
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let cancelled = cancel.load(Ordering::SeqCst);
    let exited_ok = status.as_ref().is_ok_and(ExitStatus::success);
    // tar's 0 vouches for every member only if the archive ended at a member's end: whole, or cut between two by a
    // cancel (an archive cut short at a header reads to tar as one that ended).
    writes.end(exited_ok, !cut && (written.is_ok() || cancelled), meter);
    // What did not land is no longer going.
    meter.copied.live_bytes = live_before;
    let error = copy_error(
        written.as_ref().err(),
        status.ok().map(|status| status.success()),
        &format!("{said}{}", writes.complaints),
    );
    settle_stream(&writes, error.as_deref(), cancelled, meter);
    match error {
        _ if cancelled => Err(Stop::Cancelled),
        Some(error) => Err(Stop::Failed(error)),
        None => Ok(()),
    }
}

/// What the streamed route's tar did not land: a file it started on is spoiled, and each is counted failed (not for a
/// cancel, which counts nothing failed), with the copy's error or else tar's complaining. A file tar never named was
/// never written, and is left alone.
fn settle_stream(writes: &Writes, error: Option<&str>, cancelled: bool, meter: &mut Meter) {
    writes.spoil(meter);
    for member in &writes.members {
        if member.landed || member.item.kind != Kind::File {
            continue;
        }
        if !cancelled && !member.counted {
            let why = error.map_or_else(
                || format!("tar did not write it whole: {}", writes.complaints.trim()),
                str::to_string,
            );
            meter.copied.fail(member.item, why);
        }
    }
}

/* THE STAGED ROUTE: folders and small files, in archives on this computer's disk that a helper unpacks. */

/// When a staged archive is closed and handed to the helper: at this many files, this many bytes, or this long after
/// it was opened, whichever comes first. Small enough that the card's count of files done moves every second or so.
#[derive(Debug, Clone, Copy)]
struct Limits {
    files: usize,
    bytes: u64,
    open: Duration,
    /// Archives handed over and not yet unpacked, at most: with the one being written, what the copy holds on this
    /// computer's disk at once.
    ahead: usize,
}

const STAGE: Limits = Limits {
    files: 2_000,
    bytes: 256 * 1024 * 1024,
    open: Duration::from_secs(2),
    ahead: 2,
};

/// How long a helper stopped by a cancel is listened to for what it said before it went.
const HEARD_OUT: Duration = Duration::from_secs(2);

/// What the staging helper runs: each archive named on its stdin unpacked into /work, and said back on stdout: that it
/// opened it, then tar's own lines (each member as it starts writing it, names as they are, and its complaints in
/// order between them, see [`Writes`]), then whether it unpacked whole. The helper's own lines start with `/`, which
/// none of tar's do. An archive that stops partway (a full disk, a cancel) is known member by member: what tar got past
/// landed, the member it was on is partial, and the rest of it, like every archive it never opened, was never written.
const STAGE_SCRIPT: &str = "while IFS= read -r part; do echo \"/opened $part\"; \
    if tar -x -v --quoting-style=literal --warning=no-timestamp -b 2048 -f \"/stage/$part\" -C /work \
    --no-same-owner 2>&1; then echo \"/ok $part\"; else echo \"/failed $part\"; fi; done";

/// The helper that unpacks staged archives, as the staged route talks to it. A trait so the tests can stand in for
/// Docker.
trait Unpacker {
    /// Asks for one complete archive, by its file name in the staging folder, to be unpacked.
    fn unpack(&mut self, part: &str) -> io::Result<()>;
    /// The next answer, waiting at most `wait` for it.
    fn answer(&mut self, wait: Duration) -> Answer;
    /// Stops the helper now, partway through whatever it is unpacking. What it said before it went is still answered,
    /// and then that it has gone.
    fn halt(&mut self) {}
}

#[derive(Debug, PartialEq, Eq)]
enum Answer {
    /// The helper has started on an archive.
    Opened(String),
    /// A line of the tar unpacking the archive the helper is on.
    Said(String),
    /// An archive, and whether it unpacked whole.
    Unpacked(String, bool),
    Waiting,
    /// The helper has gone: it exited, or never got going (a folder Docker would not mount).
    Gone,
}

/// The staging helper as a `docker run`: the staging folder read-only at /stage, the workspace volume at /work.
struct StageHelper {
    name: String,
    child: Child,
    stdin: Option<ChildStdin>,
    answers: mpsc::Receiver<String>,
}

impl StageHelper {
    fn start(
        name: &str,
        image: &str,
        volume: &str,
        stage: &Path,
        binds: Binds,
    ) -> io::Result<Self> {
        let args = stage_args(name, image, volume, stage, binds).ok_or_else(|| {
            io::Error::other(format!(
                "the container engine cannot mount {}",
                stage.display()
            ))
        })?;
        let mut command = crate::scripts::docker_command();
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        // No stdout is a helper that says nothing and has gone.
        let answers = match child.stdout.take() {
            Some(stdout) => lines_of(stdout),
            None => mpsc::channel().1,
        };
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in io::BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("drop copy: staging helper: {line}");
                }
            });
        }
        Ok(Self {
            name: name.to_string(),
            stdin: child.stdin.take(),
            child,
            answers,
        })
    }

    /// Ends the helper: closing its stdin ends its loop once the archive going is unpacked (after a cancel it has
    /// already gone, see [`Unpacker::halt`]).
    fn stop(mut self) {
        self.stdin = None;
        let _ = self.child.wait();
    }
}

impl Unpacker for StageHelper {
    fn unpack(&mut self, part: &str) -> io::Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::other("the helper is stopped"))?;
        writeln!(stdin, "{part}")?;
        stdin.flush()
    }

    fn answer(&mut self, wait: Duration) -> Answer {
        match self.answers.recv_timeout(wait) {
            Ok(line) => parse_answer(&line),
            Err(mpsc::RecvTimeoutError::Timeout) => Answer::Waiting,
            Err(mpsc::RecvTimeoutError::Disconnected) => Answer::Gone,
        }
    }

    /// Removes the container at once (killing the CLI alone leaves it running), then lets the CLI end by itself, which
    /// it does once the container has gone and it has passed on what the helper said: killing it first could lose the
    /// name of a file the helper had started, and leave that file partial and unmarked.
    fn halt(&mut self) {
        self.stdin = None;
        let mut remove = crate::scripts::docker_command();
        remove.args(["rm", "-f", &self.name]);
        let _ = crate::scripts::capture("docker rm", remove, LOOKUP_LIMIT);
        let _ = wait_for(&mut self.child, LOOKUP_LIMIT);
    }
}

/// A line the staging helper wrote on stdout: its own start with `/`, anything else is tar's.
fn parse_answer(line: &str) -> Answer {
    let Some(said) = line.strip_prefix('/') else {
        return Answer::Said(line.to_string());
    };
    match said.split_once(' ') {
        Some(("opened", part)) => Answer::Opened(part.to_string()),
        Some(("ok", part)) => Answer::Unpacked(part.to_string(), true),
        Some(("failed", part)) => Answer::Unpacked(part.to_string(), false),
        _ => Answer::Waiting,
    }
}

/// The staging helper's `docker run`, or None when the engine cannot mount the staging folder.
pub fn stage_args(
    name: &str,
    image: &str,
    volume: &str,
    stage: &Path,
    binds: Binds,
) -> Option<Vec<String>> {
    let mut args = run_args(name);
    args.extend([
        "-v".to_string(),
        format!("{}:/stage:ro", binds.source(stage)?),
        "-v".to_string(),
        format!("{volume}:{WORK}"),
        image.to_string(),
        "-c".to_string(),
        STAGE_SCRIPT.to_string(),
    ]);
    Some(args)
}

/// One staged archive: its file name, what went into it whole (folders and files), and the bytes of those files.
struct Part<'i> {
    name: String,
    whole: Vec<&'i Item>,
    bytes: u64,
}

/// The archive being written, and when it was opened.
struct Open<'i> {
    builder: tar::Builder<BufWriter<std::fs::File>>,
    part: Part<'i>,
    files: usize,
    since: Instant,
}

/// Why staging stopped before its end, when it did.
enum Halt {
    Cancelled,
    /// The helper went, or this computer's disk refused a write: what is left goes the streamed route.
    Broken(String),
}

/// The staged route's state between the items `each_ready` hands it.
struct Stager<'i, 'u> {
    dir: &'u Path,
    limits: Limits,
    unpacker: &'u mut dyn Unpacker,
    open: Option<Open<'i>>,
    handed: VecDeque<Part<'i>>,
    count: usize,
    /// Items done with: unpacked whole, or failed in a way another route would fail at too (a file that will not read).
    settled: HashSet<*const Item>,
    halt: Option<Halt>,
    /// The archive the helper said it opened and has not answered for yet, followed member by member.
    unpacking: Option<(String, Writes<'i>)>,
}

impl<'i> Stager<'i, '_> {
    fn put(
        &mut self,
        item: &'i Item,
        ready: Ready,
        cancel: &AtomicBool,
        meter: &mut Meter,
    ) -> io::Result<()> {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if self.open.is_none() {
            self.count += 1;
            let name = format!("part-{:05}.tar", self.count);
            let file = std::fs::File::create(self.dir.join(&name))?;
            self.open = Some(Open {
                builder: tar::Builder::new(BufWriter::with_capacity(1 << 20, file)),
                part: Part {
                    name,
                    whole: Vec::new(),
                    bytes: 0,
                },
                files: 0,
                since: Instant::now(),
            });
        }
        let open = self.open.as_mut().expect("opened above");
        let appended = append(&mut open.builder, item, ready, cancel, meter)?;
        if appended.whole {
            open.part.whole.push(item);
            open.part.bytes += appended.bytes;
            meter.copied.live_bytes += appended.bytes;
        } else if appended.bytes == 0 {
            // Would not read: the streamed route would fail at it just the same.
            self.settled.insert(item);
        } else {
            // Padded: it goes in as it is, is spoiled once the helper has written it (removed at the end), and is not
            // tried again.
            open.part.whole.push(item);
            self.settled.insert(item);
        }
        if item.kind == Kind::File {
            open.files += 1;
        }
        if open.files >= self.limits.files
            || open.part.bytes >= self.limits.bytes
            || open.since.elapsed() >= self.limits.open
        {
            self.hand_over(cancel, meter)?;
        }
        if !self.hear(Duration::ZERO, meter) {
            return Err(self.broken("the staging helper stopped"));
        }
        meter.report();
        Ok(())
    }

    /// Closes the archive being written, padded out to whole RECORDs for the helper's `tar -b 2048`, and hands it to
    /// the helper once fewer than `limits.ahead` are waiting on it.
    fn hand_over(&mut self, cancel: &AtomicBool, meter: &mut Meter) -> io::Result<()> {
        let Some(open) = self.open.take() else {
            return Ok(());
        };
        let mut file = open
            .builder
            .into_inner()?
            .into_inner()
            .map_err(|error| error.into_error())?;
        let written = file.metadata()?.len();
        let padding = (RECORD - written % RECORD) % RECORD;
        file.write_all(&vec![0u8; usize::try_from(padding).unwrap_or(0)])?;
        file.flush()?;
        drop(file);
        while self.handed.len() >= self.limits.ahead {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            if !self.hear(Duration::from_millis(200), meter) {
                return Err(self.broken("the staging helper stopped"));
            }
        }
        if let Err(error) = self.unpacker.unpack(&open.part.name) {
            let _ = std::fs::remove_file(self.dir.join(&open.part.name));
            return Err(self.broken(&format!(
                "the staging helper would not take an archive: {error}"
            )));
        }
        self.handed.push_back(open.part);
        Ok(())
    }

    /// Takes in the helper's answers: an archive unpacked whole lands its files; one that did not lands what tar got
    /// past and leaves the rest for the streamed route (see [`Stager::settle`]). Waits for the first answer at most
    /// `wait`. False once the helper has gone.
    fn hear(&mut self, wait: Duration, meter: &mut Meter) -> bool {
        let mut wait = wait;
        loop {
            match self.unpacker.answer(wait) {
                Answer::Waiting => return true,
                Answer::Gone => return false,
                Answer::Opened(name) => {
                    let Some(part) = self.handed.iter().find(|part| part.name == name) else {
                        continue;
                    };
                    let mut writes = Writes::new(false, false, None);
                    for item in &part.whole {
                        // Padded on the way in, and so never whole.
                        writes.push(item, self.settled.contains(&(*item as *const Item)));
                    }
                    self.unpacking = Some((name, writes));
                }
                Answer::Said(line) => {
                    if let Some((_, writes)) = &mut self.unpacking {
                        writes.hear(&line, meter);
                    }
                }
                Answer::Unpacked(name, whole) => {
                    let Some(at) = self.handed.iter().position(|part| part.name == name) else {
                        continue;
                    };
                    let part = self.handed.remove(at).expect("found above");
                    let followed = match self.unpacking.take() {
                        Some((opened, writes)) if opened == name => Some(writes),
                        other => {
                            self.unpacking = other;
                            None
                        }
                    };
                    self.settle(&part, followed, whole, meter);
                    if !whole {
                        eprintln!(
                            "drop copy: {} did not unpack; streaming its files",
                            part.name
                        );
                    }
                    meter.report();
                }
            }
            wait = Duration::ZERO;
        }
    }

    /// What became of an archive the helper is done with, `whole` or not: what tar got past lands, what it started on
    /// and did not finish is spoiled, and the rest, never written, is left alone. Its files that did not land are left
    /// for the streamed route. Without tar's own lines (`followed`), an archive that did not unpack whole may have left
    /// any of its files partial.
    fn settle(
        &mut self,
        part: &Part<'i>,
        followed: Option<Writes<'i>>,
        whole: bool,
        meter: &mut Meter,
    ) {
        let _ = std::fs::remove_file(self.dir.join(&part.name));
        meter.copied.live_bytes = meter.copied.live_bytes.saturating_sub(part.bytes);
        let Some(mut writes) = followed else {
            for item in &part.whole {
                // Padded ones are settled already, and written all the same.
                if whole && self.settled.insert(*item) {
                    if item.kind == Kind::File {
                        meter.landed(item);
                    }
                } else if item.kind == Kind::File {
                    meter.spoiled.insert(item.name.clone());
                }
            }
            return;
        };
        writes.end(whole, whole, meter);
        writes.spoil(meter);
        if whole {
            // Padded, and written: tar named it or not.
            for member in writes.members.iter().filter(|member| member.troubled) {
                if member.item.kind == Kind::File {
                    meter.spoiled.insert(member.item.name.clone());
                }
            }
        }
        for member in writes.members.iter().filter(|member| member.landed) {
            self.settled.insert(member.item);
        }
    }

    fn broken(&mut self, reason: &str) -> io::Error {
        self.halt = Some(Halt::Broken(reason.to_string()));
        io::Error::other(reason.to_string())
    }
}

/// The staged route: `items` read by the app many at once into archives in `dir`, each unpacked by `unpacker` as soon
/// as it is complete. Returns what is left for the streamed route: nothing when every archive unpacked; otherwise the
/// items of the archives that did not (see [`Stager::hear`]) and every item not staged yet. A cancel stops the helper
/// where it is: what it unpacked whole stays, and of the archive it was on only the files tar had started are spoiled.
fn stage<'i>(
    dir: &Path,
    items: &[&'i Item],
    unpacker: &mut dyn Unpacker,
    limits: Limits,
    cancel: &AtomicBool,
    meter: &mut Meter,
) -> Result<Vec<&'i Item>, Stop> {
    let mut stager = Stager {
        dir,
        limits,
        unpacker,
        open: None,
        handed: VecDeque::new(),
        count: 0,
        settled: HashSet::new(),
        halt: None,
        unpacking: None,
    };
    let written = each_ready(items, cancel, &mut |item, ready| {
        stager.put(item, ready, cancel, meter)
    });
    let written = written.and_then(|()| stager.hand_over(cancel, meter));
    if let Err(error) = written {
        if cancel.load(Ordering::SeqCst) {
            stager.halt = Some(Halt::Cancelled);
        } else if stager.halt.is_none() {
            stager.halt = Some(Halt::Broken(format!("staging stopped: {error}")));
        }
    }
    // The archive being written when staging stopped was never handed over: nothing of it is in the workspace.
    if let Some(open) = stager.open.take() {
        drop(open.builder);
        let _ = std::fs::remove_file(dir.join(&open.part.name));
    }
    // The helper unpacks what it was handed whatever went wrong on this side, so its answers say what became of each;
    // only a cancel, or the helper going, stops the wait for them.
    while !matches!(stager.halt, Some(Halt::Cancelled)) && !stager.handed.is_empty() {
        if cancel.load(Ordering::SeqCst) {
            stager.halt = Some(Halt::Cancelled);
        } else if !stager.hear(Duration::from_millis(200), meter) {
            if stager.halt.is_none() {
                stager.halt = Some(Halt::Broken("the staging helper stopped".to_string()));
            }
            break;
        }
    }
    if matches!(stager.halt, Some(Halt::Cancelled)) {
        // Stopped at once, then heard out: an archive it finished meanwhile lands, and the one it was on says which of
        // its files tar had started. Never reading these, as this route first did, spoiled every file of every archive
        // handed over, and the copy's end deleted older copies of files it had never written (2026-10-10).
        stager.unpacker.halt();
        let until = Instant::now() + HEARD_OUT;
        while !stager.handed.is_empty()
            && Instant::now() < until
            && stager.hear(Duration::from_millis(200), meter)
        {}
    }
    // Handed over and never answered for. The one the helper had opened stopped partway: what tar got past landed,
    // and the member it was on is partial. The rest it never opened, and nothing of them is in the workspace.
    let mut opened = stager.unpacking.take();
    for part in std::mem::take(&mut stager.handed) {
        if opened.as_ref().is_some_and(|(name, _)| *name == part.name) {
            let followed = opened.take().map(|(_, writes)| writes);
            stager.settle(&part, followed, false, meter);
        } else {
            let _ = std::fs::remove_file(dir.join(&part.name));
            meter.copied.live_bytes = meter.copied.live_bytes.saturating_sub(part.bytes);
        }
    }
    match stager.halt {
        Some(Halt::Cancelled) => return Err(Stop::Cancelled),
        Some(Halt::Broken(reason)) => eprintln!("drop copy: streaming the rest: {reason}"),
        None => {}
    }
    Ok(items
        .iter()
        .copied()
        .filter(|item| !stager.settled.contains(&(*item as *const Item)))
        .collect())
}

/// The staged route against Docker: a helper on the sandbox's image and volume, a staging folder of its own under this
/// computer's temp folder, removed at the end.
fn stage_into<'i>(
    id: &str,
    sandbox: &Sandbox,
    items: &[&'i Item],
    binds: Binds,
    cancel: &AtomicBool,
    meter: &mut Meter,
) -> Result<Vec<&'i Item>, Stop> {
    // Names the copy's helpers by the request, so a cancel can find them.
    let name = format!("intentic-drop-copy-{}-stage", &id[..id.len().min(12)]);
    let dir = std::env::temp_dir().join(format!("intentic-drop-copy-{id}"));
    let started = std::fs::create_dir_all(&dir)
        .and_then(|()| StageHelper::start(&name, &sandbox.image, &sandbox.volume, &dir, binds));
    let mut helper = match started {
        Ok(helper) => helper,
        Err(error) => {
            eprintln!(
                "drop copy: streaming the small files: the staging helper wouldn't start: {error}"
            );
            let _ = std::fs::remove_dir_all(&dir);
            return Ok(items.to_vec());
        }
    };
    let left = stage(&dir, items, &mut helper, STAGE, cancel, meter);
    helper.stop();
    let _ = std::fs::remove_dir_all(&dir);
    left
}

/* THE MOUNTED ROUTE: big files, by a helper container that sees the dropped folder. */

/// Files from this size up go the mounted route; smaller ones are staged. Each file opened over Docker Desktop's file
/// sharing costs milliseconds (7 ms each under load on omen), which a big file repays and a small one does not: with
/// its CI running, 2,000 files of 256 KB took 31 s mounted and 13 s staged; 256 of 2 MB, 9.2 s and 8.9 s; 64 of 8 MB,
/// 6.3 s and 8.1 s, since staging writes every byte to this computer's disk first (2026-10-09).
const MOUNTED_FROM: u64 = 2 * 1024 * 1024;
/// The helper's tar record, 1 MiB (`-b 2048`). At tar's default 10 KiB every read crosses the file sharing on its
/// own: 1 GiB took 16 s rather than 6.
const RECORD: u64 = 1024 * 1024;
/// What the helper runs: the listed files out of /src, as root-owned 644 files, into the target below /work. The
/// reading tar's `-v` names each file as it starts reading it and `--checkpoint` says every 16 MiB how far it has got,
/// with its complaints, on stderr. The writing tar's `-v` names each file as it starts writing it, with its complaints,
/// on stdout: it runs a record or more behind the reading one, and only its word says a file is in the workspace
/// whole. Read for the reading tar's side alone, a write that failed (a full disk) came after the reading tar had
/// moved on, was taken for nobody's, and left a file cut short counted done (2026-10-10). Names as they are.
const HELPER_SCRIPT: &str =
    "mkdir -p \"/work/$1\" && tar -C /src --null --no-recursion -T - -b 2048 -cvf - \
    --quoting-style=literal --checkpoint=16 --checkpoint-action=echo=%u --owner=0 --group=0 \
    --mode=go-w,a-x,a+X | tar -C \"/work/$1\" -b 2048 -xvf - --no-same-owner --quoting-style=literal \
    --warning=no-timestamp 2>&1";

/// Whether a dropped item's place can be bind-mounted: a path on one of this computer's drives. A network share is
/// not something Docker Desktop mounts, nor something our engine's distro sees.
fn mountable(place: &Path, binds: Binds) -> bool {
    place.is_absolute()
        && !place.to_string_lossy().starts_with(r"\\")
        && binds.source(place).is_some()
}

/// What the helpers need of the sandbox: the image it runs, which is already here, and the volume its /work is.
#[derive(Debug, PartialEq, Eq)]
pub struct Sandbox {
    pub image: String,
    pub volume: String,
}

/// The sandbox, from `docker inspect` (`image<TAB>volume`).
pub fn parse_inspect(out: &str) -> Option<Sandbox> {
    let (image, volume) = out.trim().split_once('\t')?;
    (!image.is_empty() && !volume.is_empty()).then(|| Sandbox {
        image: image.to_string(),
        volume: volume.to_string(),
    })
}

fn inspect(container: &str) -> Result<Sandbox, String> {
    let mut command = crate::scripts::docker_command();
    command.args([
        "inspect",
        "--format",
        "{{.Image}}\t{{range .Mounts}}{{if eq .Destination \"/work\"}}{{.Name}}{{end}}{{end}}",
        container,
    ]);
    let answer = crate::scripts::capture("docker inspect", command, LOOKUP_LIMIT)
        .map_err(|silence| format!("Docker didn't answer: {silence}"))?;
    parse_inspect(&answer.stdout).ok_or_else(|| {
        format!(
            "Docker said nothing usable about {container}: {}",
            answer.stderr.trim()
        )
    })
}

/// What every helper's `docker run` starts with: named so a cancel can remove it (killing the CLI leaves a container
/// running), no network, never a pull, its script run by `sh`.
fn run_args(name: &str) -> Vec<String> {
    [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        "--network",
        "none",
        "--pull",
        "never",
        "--log-driver",
        "none",
        "--entrypoint",
        "sh",
    ]
    .map(String::from)
    .to_vec()
}

/// The mounting helper's `docker run`: each dropped root read-only at /src/<its name>, the workspace volume at /work.
pub fn helper_args(
    name: &str,
    image: &str,
    volume: &str,
    mounts: &[(&Path, &str)],
    target: &str,
    binds: Binds,
) -> Vec<String> {
    let mut args = run_args(name);
    for (place, root) in mounts {
        // Only places `mountable` let through get here; one the engine cannot see after all fails the helper, and its
        // files go the streamed route.
        let source = binds
            .source(place)
            .unwrap_or_else(|| place.display().to_string());
        args.push("-v".to_string());
        args.push(format!("{source}:/src/{root}:ro"));
    }
    args.push("-v".to_string());
    args.push(format!("{volume}:{WORK}"));
    args.extend([image, "-c", HELPER_SCRIPT, "sh", target].map(String::from));
    args
}

/// The helper's file list: paths within the drop, NUL-separated, as `tar --null -T -` reads them.
fn helper_list(items: &[&Item]) -> Vec<u8> {
    items
        .iter()
        .flat_map(|item| item.relative.bytes().chain([0]))
        .collect()
}

/// A line the helper's reading tar wrote on stderr.
#[derive(Debug, PartialEq, Eq)]
pub enum Said<'a> {
    /// `--checkpoint`: this many records written.
    Records(u64),
    /// `-v`: a listed file has started, if it is one (Docker's own warnings come on the same stream).
    Name(&'a str),
    /// tar on one file: its path within the drop, and what went wrong.
    Trouble(&'a str, &'a str),
    /// Anything else: Docker's own words, tar giving up.
    Other(&'a str),
}

pub fn said(line: &str) -> Said<'_> {
    if let Some(rest) = line.strip_prefix("tar: ") {
        if let Ok(records) = rest.trim().parse() {
            return Said::Records(records);
        }
        return match rest.split_once(": ") {
            Some((path, trouble)) => Said::Trouble(path, trouble),
            None => Said::Other(line),
        };
    }
    if line.is_empty() || line.starts_with("docker: ") {
        return Said::Other(line);
    }
    Said::Name(line)
}

/// A line of the mounting helper's: its reading tar's on stderr, its writing tar's on stdout.
enum Heard {
    Reading(String),
    Writing(String),
}

/// The big files, through the helper. Returns what is left for the streamed route: every file the helper's writing
/// tar did not show it wrote whole (see [`Writes`]), whether the reading tar had trouble with it, the writing tar
/// could not write it, or the helper stopped before it. A failure of this route costs speed and never a file.
#[allow(clippy::too_many_arguments)]
fn mount<'i>(
    id: &str,
    sandbox: &Sandbox,
    target: &str,
    scan: &Scan,
    items: &[&'i Item],
    binds: Binds,
    cancel: &AtomicBool,
    meter: &mut Meter,
) -> Result<Vec<&'i Item>, Stop> {
    let name = format!("intentic-drop-copy-{}", &id[..id.len().min(12)]);
    let roots: Vec<usize> = {
        let mut roots: Vec<usize> = items.iter().map(|item| item.root).collect();
        roots.sort_unstable();
        roots.dedup();
        roots
    };
    let mounts: Vec<(&Path, &str)> = roots
        .iter()
        .map(|&root| (scan.places[root].as_path(), scan.roots[root].name.as_str()))
        .collect();
    let mut command = crate::scripts::docker_command();
    command
        .args(helper_args(
            &name,
            &sandbox.image,
            &sandbox.volume,
            &mounts,
            target,
            binds,
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("drop copy: streaming the big files too: the helper wouldn't start: {error}");
            return Ok(items.to_vec());
        }
    };
    // Written on a thread of its own: tar reads the list as it goes, so a long one would fill the pipe while this
    // thread waits on stderr.
    let list = helper_list(items);
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&list);
        });
    }
    let (lines, heard) = mpsc::channel::<Heard>();
    if let Some(stderr) = child.stderr.take() {
        let lines = lines.clone();
        each_line(stderr, move |line| lines.send(Heard::Reading(line)).is_ok());
    }
    match child.stdout.take() {
        Some(stdout) => each_line(stdout, move |line| lines.send(Heard::Writing(line)).is_ok()),
        None => drop(lines),
    }
    let mut follow = Follow::new(items);
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let mut remove = crate::scripts::docker_command();
            remove.args(["rm", "-f", &name]);
            let _ = crate::scripts::capture("docker rm", remove, LOOKUP_LIMIT);
            let _ = wait_for(&mut child, LOOKUP_LIMIT);
            // Heard out, so a file the writing tar got past counts as landed and stays; the one it was on is partial.
            // The reading tar was stopped too, and what it got past is all it vouches for.
            let until = Instant::now() + HEARD_OUT;
            while let Ok(line) = heard.recv_timeout(until.saturating_duration_since(Instant::now()))
            {
                follow.hear(line, meter);
            }
            follow.end(None, meter);
            return Err(Stop::Cancelled);
        }
        match heard.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => follow.hear(line, meter),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break child.wait(),
        }
    };
    Ok(follow.end(status.ok(), meter))
}

/// What the helper has said so far, read against its list: its reading tar names each file as it starts reading it, in
/// list order, and complains about one it could not read before it names the next; its writing tar does the same for
/// writing them (`writes`). A file lands once the writing tar got past it and the reading tar vouched for it.
struct Follow<'s, 'i> {
    items: &'s [&'i Item],
    total: u64,
    writes: Writes<'i>,
    /// The first listed file the reading tar has not named or passed over.
    next: usize,
    /// Bytes the reading tar has sent, from its records count.
    read_bytes: u64,
    /// Docker's or tar's last words that were about no one file.
    last_words: String,
}

impl<'s, 'i> Follow<'s, 'i> {
    fn new(items: &'s [&'i Item]) -> Self {
        let mut writes = Writes::new(true, false, None);
        for item in items {
            writes.push(item, false);
        }
        // Nothing vouched for until the reading tar has moved past it.
        writes.gate = 0;
        Self {
            items,
            total: items.iter().map(|item| item.size).sum(),
            writes,
            next: 0,
            read_bytes: 0,
            last_words: String::new(),
        }
    }

    fn hear(&mut self, line: Heard, meter: &mut Meter) {
        match line {
            Heard::Reading(line) => self.reading(&line, meter),
            Heard::Writing(line) => self.writes.hear(&line, meter),
        }
        meter.copied.live_bytes = self.read_bytes.saturating_sub(self.writes.landed_bytes);
        meter.report();
    }

    /// One line of the reading tar's.
    fn reading(&mut self, line: &str, meter: &mut Meter) {
        let items = self.items;
        let upto = items.len().min(self.next + NAMES_AHEAD);
        match said(line) {
            Said::Records(records) => self.read_bytes = (records * RECORD).min(self.total),
            Said::Name(name) => {
                match (self.next..upto).find(|&index| items[index].relative == name) {
                    Some(index) => {
                        meter.copied.current.clone_from(&items[index].name);
                        self.next = index + 1;
                        // Done reading every file before this one.
                        self.writes.vouch(index, meter);
                    }
                    None => self.last_words = line.to_string(),
                }
            }
            Said::Trouble(path, _) => {
                // The file it is reading, coming up short (tar pads it out), or one it could not open, never named,
                // which it moves past.
                let from = self.next.saturating_sub(1);
                match (from..upto).find(|&index| items[index].relative == path) {
                    Some(index) => {
                        self.writes.members[index].troubled = true;
                        if index >= self.next {
                            self.next = index + 1;
                            self.writes.vouch(self.next, meter);
                        }
                    }
                    None => self.last_words = line.to_string(),
                }
            }
            Said::Other(words) => {
                if !words.is_empty() {
                    self.last_words = words.to_string();
                }
            }
        }
    }

    /// The helper has gone, with the writing tar's `status` (the pipeline's), or none for a cancel. Returns the files
    /// that did not land, for the streamed route; the ones the writing tar started on are spoiled until then. After an
    /// exit the reading tar has said all it will, and vouches for every file it did not complain about; after a cancel
    /// only for those it got past.
    fn end(mut self, status: Option<ExitStatus>, meter: &mut Meter) -> Vec<&'i Item> {
        let exited_ok = status.is_some_and(|status| status.success());
        if status.is_some() {
            self.writes.vouch(self.items.len(), meter);
        }
        self.writes.end(exited_ok, false, meter);
        self.writes.spoil(meter);
        meter.copied.live_bytes = 0;
        let left: Vec<&'i Item> = self.writes.unlanded().collect();
        if status.is_some() && (!exited_ok || !left.is_empty()) {
            eprintln!(
                "drop copy: the helper ({status:?}) left {} files for the streamed route: {}{}",
                left.len(),
                self.writes.complaints.trim(),
                self.last_words
            );
        }
        left
    }
}

/// Removes from the workspace the files a route wrote but not whole, by name below /work, NUL-separated on `xargs`'s
/// input so no name is read as an option or split at a space.
fn remove_spoiled(container: &str, spoiled: &HashSet<String>) {
    if spoiled.is_empty() {
        return;
    }
    let mut command = crate::scripts::docker_command();
    command
        .args([
            "exec", "-i", "-u", "0", "-w", WORK, container, "xargs", "-0", "rm", "-f", "--",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let names: Vec<u8> = spoiled
        .iter()
        .flat_map(|name| name.bytes().chain([0]))
        .collect();
    let removed = command.spawn().and_then(|mut child| {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(&names)?;
        }
        child.wait_with_output()
    });
    match removed {
        Ok(output) if output.status.success() => {}
        Ok(output) => eprintln!(
            "drop copy: could not remove {} partial files: {}",
            spoiled.len(),
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(error) => eprintln!(
            "drop copy: could not remove {} partial files: {error}",
            spoiled.len()
        ),
    }
}

/* ONE COPY, START TO FINISH. */

/// The cancel flags of the copies running now, by the page's id for each.
fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNNING.get_or_init(Mutex::default)
}

/// A copy's cancel flag, made as its message arrives: on WebView2's own thread, which hears the page's messages in
/// the order it sent them, so a cancel that follows a request always finds the request's flag, however long the copy
/// takes to get going.
pub fn register(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut copies) = running().lock() {
        copies.insert(id.to_string(), flag.clone());
    }
    flag
}

/// The page's Cancel: the copy stops at the next read, and what it already copied stays.
pub fn cancel(id: &str) {
    if let Some(flag) = running()
        .lock()
        .ok()
        .and_then(|copies| copies.get(id).cloned())
    {
        flag.store(true, Ordering::SeqCst);
    }
}

fn copied_json(copied: &Copied) -> Value {
    json!({
        "done": copied.done,
        "doneBytes": copied.done_bytes,
        "sentBytes": copied.done_bytes + copied.live_bytes,
        "failed": copied.failed,
        "current": copied.current,
        "roots": copied.roots.iter().map(|(done, failed)| json!({ "done": done, "failed": failed })).collect::<Vec<_>>(),
    })
}

fn with(id: &str, kind: &str, mut detail: Value) -> Value {
    detail["id"] = json!(id);
    detail["kind"] = json!(kind);
    detail
}

/// Runs one request to its end, telling the page each step through `emit`. `sources` are the dropped files' places,
/// or why the app could not learn them; `cancel` is the flag [`register`] made for it.
pub fn run(
    request: Request,
    sources: Result<Vec<PathBuf>, String>,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(Value),
) {
    let id = request.id.clone();
    // Heard at once, so the page's wait for an answer measures whether this app is listening, not how long Docker takes.
    emit(with(&id, "received", json!({})));
    let declined = |reason: String| with(&id, "declined", json!({ "reason": reason }));
    let found = sources
        .and_then(|sources| {
            if sources.is_empty() {
                Err("The drop named no place on disk.".to_string())
            } else {
                Ok(sources)
            }
        })
        .and_then(|sources| Ok((sources, find_container(request.port)?)));
    match found {
        // A page that stopped waiting (its own deadline, or a Cancel) has already moved on.
        _ if cancel.load(Ordering::SeqCst) => {}
        Ok((sources, container)) => copy_into(&request, &sources, &container, cancel, emit),
        Err(reason) => emit(declined(reason)),
    }
    if let Ok(mut copies) = running().lock() {
        copies.remove(&id);
    }
}

/// Which way each item goes.
#[derive(Debug, Default)]
struct Routes<'s> {
    /// Folders and small files, read by the app.
    staged: Vec<&'s Item>,
    /// Big files on a place that mounts, read by a helper.
    mounted: Vec<&'s Item>,
    /// Big files on a place that does not.
    streamed: Vec<&'s Item>,
}

fn routes(scan: &Scan, binds: Binds) -> Routes<'_> {
    let mut routes = Routes::default();
    for item in &scan.items {
        if item.kind == Kind::Dir || item.size < MOUNTED_FROM {
            routes.staged.push(item);
        } else if mountable(&scan.places[item.root], binds) {
            routes.mounted.push(item);
        } else {
            routes.streamed.push(item);
        }
    }
    routes
}

fn copy_into(
    request: &Request,
    sources: &[PathBuf],
    container: &str,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(Value),
) {
    let id = request.id.as_str();
    let manifests: HashSet<&str> = request.manifests.iter().map(String::as_str).collect();
    let scan = scan(
        sources,
        &request.target,
        &request.skip,
        &manifests,
        cancel,
        &mut |scan, current| {
            emit(with(
                id,
                "scanning",
                json!({ "files": scan.files, "bytes": scan.bytes, "current": current }),
            ));
        },
    );
    if cancel.load(Ordering::SeqCst) {
        return emit(with(
            id,
            "finished",
            json!({ "cancelled": true, "done": 0, "doneBytes": 0, "sentBytes": 0, "failed": 0 }),
        ));
    }
    if scan.files < request.at_least.files && scan.bytes < request.at_least.bytes {
        return emit(with(id, "declined", json!({ "reason": "small" })));
    }
    emit(with(
        id,
        "copying",
        json!({
            "files": scan.files,
            "bytes": scan.bytes,
            "unreadable": scan.unreadable,
            "manifests": scan.manifests,
            "roots": scan.roots.iter().map(|root| json!({
                "name": root.name, "dir": root.dir, "files": root.files, "bytes": root.bytes,
            })).collect::<Vec<_>>(),
        }),
    ));
    let binds = Binds::of_engine();
    let routes = routes(&scan, binds);
    let mut tick = |copied: &Copied| emit(with(id, "progress", copied_json(copied)));
    let mut meter = Meter::new(scan.roots.len(), &mut tick);
    // Without the sandbox's image and volume no helper runs, and everything goes the streamed route.
    let helpers = inspect(container)
        .map_err(|reason| eprintln!("drop copy: streaming everything: {reason}"))
        .ok();
    let outcome = (|| {
        let mut left = routes.streamed.clone();
        match &helpers {
            Some(sandbox) => {
                left.extend(stage_into(
                    id,
                    sandbox,
                    &routes.staged,
                    binds,
                    cancel,
                    &mut meter,
                )?);
                if !routes.mounted.is_empty() {
                    left.extend(mount(
                        id,
                        sandbox,
                        &request.target,
                        &scan,
                        &routes.mounted,
                        binds,
                        cancel,
                        &mut meter,
                    )?);
                }
            }
            None => {
                left.extend(&routes.staged);
                left.extend(&routes.mounted);
            }
        }
        if left.is_empty() {
            return Ok(());
        }
        stream(container, &left, cancel, &mut meter)
    })();
    remove_spoiled(container, &meter.spoiled);
    let copied = meter.copied;
    let mut detail = copied_json(&copied);
    detail["failures"] = copied
        .failures
        .iter()
        .map(|(path, error)| json!({ "path": path, "error": error }))
        .collect();
    match outcome {
        Ok(()) => {}
        Err(Stop::Cancelled) => detail["cancelled"] = json!(true),
        Err(Stop::Failed(error)) => detail["error"] = json!(error),
    }
    emit(with(id, "finished", detail));
}

/// The event the page hears, as it receives it: JSON is a JavaScript literal.
fn event_script(detail: &Value) -> String {
    format!("window.dispatchEvent(new CustomEvent('{EVENT}', {{ detail: {detail} }}));")
}

/* WHERE THE PAGE'S MESSAGE ARRIVES: WebView2's own event on a page window. */

#[cfg(windows)]
pub fn watch(window: &tauri::WebviewWindow, app_origin: &url::Url) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::WebMessageReceivedEventHandler;

    let handle = window.clone();
    let origin = app_origin.origin();
    let watched = window.with_webview(move |webview| {
        let core = match unsafe { webview.controller().CoreWebView2() } {
            Ok(core) => core,
            Err(error) => return eprintln!("drop copy: no WebView2 to hear the page on: {error}"),
        };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut source = windows::core::PWSTR::null();
            unsafe { args.Source(&mut source)? };
            let source = webview2_com::take_pwstr(source);
            // A string, as the page sends it (see the top of this file); anything else is not this module's.
            let mut message = windows::core::PWSTR::null();
            if unsafe { args.TryGetWebMessageAsString(&mut message) }.is_err() {
                return Ok(());
            }
            let Ok(message) = serde_json::from_str::<Value>(&webview2_com::take_pwstr(message))
            else {
                return Ok(());
            };
            if !matches!(message["intentic"].as_str(), Some(COPY | CANCEL)) {
                return Ok(());
            }
            if url::Url::parse(&source).map(|url| url.origin()).ok() != Some(origin.clone()) {
                eprintln!(
                    "drop copy: refused a message from {source}, which is not the app's page"
                );
                return Ok(());
            }
            match message["intentic"].as_str() {
                Some(CANCEL) => {
                    if let Some(id) = cancel_id(&message) {
                        cancel(id);
                    }
                }
                Some(COPY) => {
                    let Some(request) = parse_request(&message) else {
                        eprintln!("drop copy: refused a request that is not well formed");
                        return Ok(());
                    };
                    // Read here, on the event: the objects are the event's, and gone once it returns.
                    let sources = places_of(&args);
                    let flag = register(&request.id);
                    let window = handle.clone();
                    std::thread::spawn(move || {
                        run(request, sources, &flag, &mut |detail| {
                            let _ = window.eval(event_script(&detail));
                        });
                    });
                }
                _ => {}
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(error) = unsafe { core.add_WebMessageReceived(&handler, &mut token) } {
            eprintln!("drop copy: WebView2 would not let the app hear the page: {error}");
        }
    });
    if let Err(error) = watched {
        eprintln!("drop copy: the window's WebView2 was not reachable: {error}");
    }

    /// The dropped files' places on disk, as WebView2 hands them over with the message.
    fn places_of(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Result<Vec<PathBuf>, String> {
        use windows::core::Interface;
        let too_old =
            |_| "This computer's WebView2 is too old to say where a dropped file is.".to_string();
        let args: ICoreWebView2WebMessageReceivedEventArgs2 = args.cast().map_err(too_old)?;
        let objects = unsafe { args.AdditionalObjects() }.map_err(too_old)?;
        let mut count = 0u32;
        unsafe { objects.Count(&mut count) }.map_err(too_old)?;
        let mut places = Vec::new();
        for index in 0..count {
            let file: ICoreWebView2File = unsafe { objects.GetValueAtIndex(index) }
                .and_then(|object| object.cast())
                .map_err(|_| "Something dropped has no place on disk.".to_string())?;
            let mut path = windows::core::PWSTR::null();
            unsafe { file.Path(&mut path) }
                .map_err(|_| "Something dropped has no place on disk.".to_string())?;
            let path = webview2_com::take_pwstr(path);
            if path.is_empty() || !std::path::Path::new(&path).is_absolute() {
                return Err("Something dropped has no place on disk.".to_string());
            }
            places.push(PathBuf::from(path));
        }
        Ok(places)
    }
}

/// Elsewhere the page is never told this app takes a drop (`nativeCopy` in the init script), so never asks.
#[cfg(not(windows))]
pub fn watch(_window: &tauri::WebviewWindow, _app_origin: &url::Url) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A folder of its own under the system's temp folder, gone when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("intentic-drop-copy-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request(value: Value) -> Option<Request> {
        parse_request(&value)
    }

    /// The page's rule, as dropEntries.ts sends it: a dropped repo keeps its `.git`.
    fn skip() -> Skip {
        Skip {
            dirs: vec!["node_modules".into(), "dist".into()],
            files: vec!["claude.json".into()],
            prefixes: vec![".env".into()],
            keep: vec![".env.example".into()],
        }
    }

    /// What the page sends, and the shapes refused: a target that climbs out of /work, an id that is not a token.
    #[test]
    fn a_request_is_taken_only_when_every_part_of_it_is_plain() {
        let good = json!({ "id": "a1-b2", "port": 28123, "target": "media/2026", "atLeast": { "files": 1000, "bytes": 1 } });
        assert!(request(good.clone()).is_some());
        for (field, value) in [
            ("target", json!("../etc")),
            ("target", json!("/etc")),
            ("target", json!("a//b")),
            ("target", json!("a\\b")),
            ("id", json!("x y")),
            ("port", json!(0)),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(request(bad).is_none(), "{field}");
        }
        let mut climbing = good;
        climbing["skip"] = json!({ "dirs": [".."] });
        assert!(request(climbing).is_none());
    }

    #[test]
    fn the_container_is_the_sandbox_publishing_the_port_the_page_reaches() {
        let listing = "intentic-sandbox-tunnel-abc\t\n\
                       intentic-sandbox-abc\t127.0.0.1:28124->8787/tcp\n\
                       intentic-sandbox-def\t0.0.0.0:3000->3000/tcp, 127.0.0.1:28123->8787/tcp\n\
                       other-thing\t127.0.0.1:28125->80/tcp\n";
        assert_eq!(
            container_for_port(listing, 28123).as_deref(),
            Some("intentic-sandbox-def")
        );
        assert_eq!(
            container_for_port(listing, 28124).as_deref(),
            Some("intentic-sandbox-abc")
        );
        assert_eq!(container_for_port(listing, 28125), None);
        assert_eq!(container_for_port(listing, 2812), None);
    }

    /// A folder as someone drops it: films, a project with its node_modules and a secret, an empty folder.
    fn dropped() -> (Scratch, PathBuf, PathBuf) {
        let base = Scratch::new();
        let marketing = base.path().join("marketing");
        fs::create_dir_all(marketing.join("films/2026")).unwrap();
        fs::create_dir_all(marketing.join("site/node_modules/left")).unwrap();
        fs::create_dir_all(marketing.join("empty")).unwrap();
        fs::write(marketing.join("films/2026/launch.mp4"), vec![7u8; 70_000]).unwrap();
        fs::write(marketing.join("site/package.json"), "{}").unwrap();
        fs::write(marketing.join("site/node_modules/left/index.js"), "x").unwrap();
        fs::write(marketing.join("site/.env"), "SECRET=1").unwrap();
        fs::write(marketing.join("site/.env.example"), "SECRET=").unwrap();
        let deep = format!(
            "{}/{}.txt",
            "nested-folder-name".repeat(3),
            "a-long-file-name".repeat(6)
        );
        fs::create_dir_all(marketing.join(deep.rsplit_once('/').unwrap().0)).unwrap();
        fs::write(marketing.join(&deep), "deep").unwrap();
        let loose = base.path().join("notes.md");
        fs::write(&loose, "notes").unwrap();
        (base, marketing, loose)
    }

    fn scanned(sources: &[PathBuf], target: &str) -> Scan {
        let manifests = HashSet::from(["package.json"]);
        scan(
            sources,
            target,
            &skip(),
            &manifests,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
    }

    /// The whole scan as the streamed route's archive, and what the copy counted once a tar unpacking it exited 0.
    fn archived(scan: &Scan) -> (Vec<u8>, Copied) {
        let mut archive = Vec::new();
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(scan.roots.len(), &mut tick);
        let items: Vec<&Item> = scan.items.iter().collect();
        let mut writes = Writes::new(false, true, None);
        write_archive(
            &mut archive,
            &items,
            &AtomicBool::new(false),
            &mut meter,
            &mut writes,
        )
        .unwrap();
        writes.end(true, true, &mut meter);
        (archive, meter.copied)
    }

    /// Unpacks `archive` the way the engine would, into a fresh folder, and lists what landed.
    fn unpacked(archive: &[u8]) -> (Scratch, Vec<String>) {
        let out = Scratch::new();
        tar::Archive::new(archive).unpack(out.path()).unwrap();
        let mut found = Vec::new();
        let mut pending = vec![out.path().to_path_buf()];
        while let Some(dir) = pending.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                let relative = path
                    .strip_prefix(out.path())
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if path.is_dir() {
                    found.push(format!("{relative}/"));
                    pending.push(path);
                } else {
                    found.push(relative);
                }
            }
        }
        found.sort();
        (out, found)
    }

    #[test]
    fn a_drop_lands_under_its_target_as_the_pages_own_walk_would_send_it() {
        let (_base, marketing, loose) = dropped();
        let scan = scanned(&[marketing, loose], "media");
        let (archive, copied) = archived(&scan);
        let (out, found) = unpacked(&archive);
        let deep = format!(
            "media/marketing/{}/{}.txt",
            "nested-folder-name".repeat(3),
            "a-long-file-name".repeat(6)
        );
        let mut expected = vec![
            "media/".to_string(),
            "media/marketing/".into(),
            "media/marketing/empty/".into(),
            "media/marketing/films/".into(),
            "media/marketing/films/2026/".into(),
            "media/marketing/films/2026/launch.mp4".into(),
            format!("media/marketing/{}/", "nested-folder-name".repeat(3)),
            deep.clone(),
            "media/marketing/site/".into(),
            "media/marketing/site/.env.example".into(),
            "media/marketing/site/package.json".into(),
            "media/notes.md".into(),
        ];
        expected.sort();
        assert_eq!(found, expected);
        assert_eq!(
            fs::read(out.path().join("media/marketing/films/2026/launch.mp4")).unwrap(),
            vec![7u8; 70_000]
        );
        assert_eq!(fs::read_to_string(out.path().join(deep)).unwrap(), "deep");
        assert_eq!(
            (
                scan.files,
                copied.done,
                copied.done_bytes,
                copied.failed,
                scan.manifests.clone()
            ),
            (
                5,
                5,
                70_000 + 2 + 7 + 4 + 5,
                0,
                vec!["marketing/site/package.json".to_string()]
            )
        );
        assert_eq!(
            scan.roots,
            vec![
                Root {
                    name: "marketing".into(),
                    dir: true,
                    files: 4,
                    bytes: 70_013
                },
                Root {
                    name: "notes.md".into(),
                    dir: false,
                    files: 1,
                    bytes: 5
                },
            ]
        );
        assert_eq!(copied.roots, vec![(4, 0), (1, 0)]);
    }

    /// On the workspace's root, a dropped `.git` would aim a folder at /work/.git, which is a pointer file.
    #[test]
    fn a_git_folder_dropped_on_the_root_is_left_where_it_is() {
        let base = Scratch::new();
        fs::create_dir_all(base.path().join(".git")).unwrap();
        fs::write(base.path().join(".git/HEAD"), "ref").unwrap();
        assert_eq!(scanned(&[base.path().join(".git")], "").files, 0);
        assert_eq!(scanned(&[base.path().join(".git")], "nested").files, 1);
    }

    /// The header goes out before the bytes, so a file that comes up short is padded and named, and the files after
    /// it land intact.
    #[test]
    fn a_file_that_comes_up_short_is_padded_and_named_and_the_rest_still_land() {
        let (_base, marketing, loose) = dropped();
        let scan = scanned(&[marketing.clone(), loose], "");
        // Gone between the walk and the copy: skipped and named, nothing written for it.
        fs::remove_file(marketing.join("site/package.json")).unwrap();
        let (archive, copied) = archived(&scan);
        assert_eq!((copied.done, copied.failed), (4, 1));
        assert_eq!(copied.failures[0].0, "marketing/site/package.json");
        let (out, _) = unpacked(&archive);
        assert_eq!(
            fs::read_to_string(out.path().join("notes.md")).unwrap(),
            "notes"
        );

        // Short partway: the bytes that were there, then zeros up to the size the header gave.
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(0, &mut tick);
        let cancel = AtomicBool::new(false);
        let mut short = Exact {
            inner: &b"abc"[..],
            remaining: 6,
            error: None,
            meter: &mut meter,
            cancel: &cancel,
        };
        let mut read = Vec::new();
        short.read_to_end(&mut read).unwrap();
        assert_eq!((read, short.error.is_some()), (b"abc\0\0\0".to_vec(), true));
    }

    /// A dropped `node_modules` is left out as the page's own walk leaves it out, at the top as much as below.
    #[test]
    fn an_ignored_folder_is_left_out_wherever_it_sits() {
        let base = Scratch::new();
        fs::create_dir_all(base.path().join("node_modules/pkg")).unwrap();
        fs::write(base.path().join("node_modules/pkg/index.js"), "x").unwrap();
        assert_eq!(scanned(&[base.path().join("node_modules")], "").files, 0);
    }

    #[test]
    fn a_cancel_ends_the_archive() {
        let (_base, marketing, _) = dropped();
        let scan = scanned(&[marketing], "");
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(scan.roots.len(), &mut tick);
        let items: Vec<&Item> = scan.items.iter().collect();
        let mut writes = Writes::new(false, true, None);
        let result = write_archive(
            Vec::new(),
            &items,
            &AtomicBool::new(true),
            &mut meter,
            &mut writes,
        );
        assert_eq!(result.unwrap_err().to_string(), "cancelled");
    }

    /// A cancel while a big file is being read from disk ends the archive there, rather than `io::copy` retrying the
    /// read that says so, which it does forever with `ErrorKind::Interrupted`.
    #[test]
    fn a_cancel_partway_through_a_big_file_ends_the_archive_there() {
        let base = Scratch::new();
        let film = base.path().join("film.mov");
        fs::File::create(&film)
            .unwrap()
            .set_len(MOUNTED_FROM * 2)
            .unwrap();
        let mut item = big("m/film.mov", MOUNTED_FROM * 2);
        item.source = film;
        let cancel = AtomicBool::new(false);
        let mut tick = |copied: &Copied| {
            if copied.live_bytes > 0 {
                cancel.store(true, Ordering::SeqCst);
            }
        };
        let mut meter = Meter::new(1, &mut tick);
        meter.last = Instant::now() - TICK;
        let started = Instant::now();
        let mut writes = Writes::new(false, true, None);
        let result = write_archive(io::sink(), &[&item], &cancel, &mut meter, &mut writes);
        assert_eq!(result.unwrap_err().to_string(), "cancelled");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(writes.cut);
        assert_eq!(writes.members.len(), 1);
    }

    /// Big files on a drive go mounted; folders, small files, and anything on a place that will not mount, streamed.
    #[test]
    fn each_file_goes_the_way_that_is_fastest_for_it() {
        let (_base, marketing, loose) = dropped();
        let big = marketing.join("films/2026/launch-4k.mp4");
        fs::File::create(&big)
            .unwrap()
            .set_len(MOUNTED_FROM)
            .unwrap();
        let scan = scanned(&[marketing, loose], "");
        let routes = routes(&scan, Binds::AsIs);
        assert_eq!(
            routes
                .mounted
                .iter()
                .map(|item| item.relative.as_str())
                .collect::<Vec<_>>(),
            vec!["marketing/films/2026/launch-4k.mp4"]
        );
        assert_eq!(
            (
                routes
                    .staged
                    .iter()
                    .filter(|item| item.kind == Kind::File)
                    .count(),
                routes
                    .staged
                    .iter()
                    .filter(|item| item.kind == Kind::Dir)
                    .count(),
                routes.streamed.len(),
            ),
            (5, 6, 0)
        );
        assert!(!mountable(Path::new(r"\\nas\films"), Binds::AsIs));
        assert!(!mountable(Path::new(r"\\nas\films"), Binds::Wsl));
    }

    /// Every item reaches the writer once: the folders first, then each file read whole, too big to hold, or failed.
    #[test]
    fn every_item_is_read_once_folders_first_then_files_as_they_are_read() {
        let base = Scratch::new();
        let mut owned = Vec::new();
        for folder in 0..4 {
            let dir = base.path().join(format!("d{folder}"));
            fs::create_dir_all(&dir).unwrap();
            owned.push(Item {
                kind: Kind::Dir,
                source: dir.clone(),
                ..big(&format!("d{folder}"), 0)
            });
            for file in 0..150 {
                let path = dir.join(format!("f{file}.jpg"));
                fs::write(&path, format!("{folder}/{file}")).unwrap();
                let mut item = big(&format!("d{folder}/f{file}.jpg"), 4);
                item.source = path;
                owned.push(item);
            }
        }
        let huge = base.path().join("huge.mov");
        fs::File::create(&huge)
            .unwrap()
            .set_len(MOUNTED_FROM)
            .unwrap();
        let mut huge_item = big("huge.mov", MOUNTED_FROM);
        huge_item.source = huge;
        owned.push(huge_item);
        let mut gone = big("gone.jpg", 10);
        gone.source = base.path().join("gone.jpg");
        owned.push(gone);
        let items: Vec<&Item> = owned.iter().collect();
        let mut seen: Vec<(String, &'static str)> = Vec::new();
        each_ready(&items, &AtomicBool::new(false), &mut |item, ready| {
            let what = match ready {
                Ready::Dir => "dir",
                Ready::Bytes(bytes) => {
                    let expected = fs::read(&item.source).unwrap();
                    assert_eq!(bytes, expected, "{}", item.relative);
                    "bytes"
                }
                Ready::Open => "open",
                Ready::Failed(_) => "failed",
            };
            seen.push((item.relative.clone(), what));
            Ok(())
        })
        .unwrap();
        assert_eq!(seen.len(), items.len());
        assert!(seen[..4].iter().all(|(_, what)| *what == "dir"));
        let count = |kind: &str| seen.iter().filter(|(_, what)| *what == kind).count();
        assert_eq!(
            (count("bytes"), count("open"), count("failed")),
            (600, 1, 1)
        );
        let unique: HashSet<&String> = seen.iter().map(|(name, _)| name).collect();
        assert_eq!(unique.len(), items.len());
    }

    /// A stand-in for the staging helper: unpacks each archive it is handed into `work` with the tar crate, as the
    /// helper's tar would, and answers; or answers that the archives in `fail` did not unpack; or goes after `gone_after`.
    struct FakeUnpacker {
        stage: PathBuf,
        work: PathBuf,
        fail: HashSet<String>,
        gone_after: Option<usize>,
        answers: VecDeque<Answer>,
        handed: usize,
        most_waiting: usize,
    }

    impl FakeUnpacker {
        fn new(stage: &Path, work: &Path) -> Self {
            Self {
                stage: stage.to_path_buf(),
                work: work.to_path_buf(),
                fail: HashSet::new(),
                gone_after: None,
                answers: VecDeque::new(),
                handed: 0,
                most_waiting: 0,
            }
        }
    }

    impl Unpacker for FakeUnpacker {
        fn unpack(&mut self, part: &str) -> io::Result<()> {
            if self.gone_after.is_some_and(|after| self.handed >= after) {
                return Err(io::Error::from(io::ErrorKind::BrokenPipe));
            }
            self.handed += 1;
            let bytes = fs::read(self.stage.join(part)).unwrap();
            // Whole RECORDs, as the helper's `tar -b 2048` reads them.
            assert_eq!(bytes.len() as u64 % RECORD, 0, "{part}");
            let whole = !self.fail.contains(part);
            if whole {
                tar::Archive::new(bytes.as_slice())
                    .unpack(&self.work)
                    .unwrap();
            }
            self.answers
                .push_back(Answer::Unpacked(part.to_string(), whole));
            self.most_waiting = self.most_waiting.max(self.answers.len());
            Ok(())
        }

        fn answer(&mut self, _wait: Duration) -> Answer {
            match self.answers.pop_front() {
                Some(answer) => answer,
                None if self.gone_after.is_some_and(|after| self.handed >= after) => Answer::Gone,
                None => Answer::Waiting,
            }
        }
    }

    /// A drop of `folders` × `files` small files under `marketing/`, scanned to land under `media/`.
    fn stills(folders: usize, files: usize) -> (Scratch, Scan) {
        let base = Scratch::new();
        for folder in 0..folders {
            let dir = base.path().join(format!("marketing/batch-{folder}"));
            fs::create_dir_all(&dir).unwrap();
            for file in 0..files {
                fs::write(
                    dir.join(format!("still-{file}.jpg")),
                    format!("still {folder}/{file}"),
                )
                .unwrap();
            }
        }
        let scan = scanned(&[base.path().join("marketing")], "media");
        (base, scan)
    }

    const SMALL_PARTS: Limits = Limits {
        files: 50,
        bytes: 1 << 30,
        open: Duration::from_secs(60),
        ahead: 2,
    };

    /// Many small files staged in archives of SMALL_PARTS.files, each unpacked as it is complete: every file lands
    /// with its own bytes, no more than `ahead` archives wait on the helper at once, and the staging folder ends empty.
    #[test]
    fn small_files_are_staged_in_archives_that_unpack_as_they_complete() {
        let (_base, scan) = stills(4, 60);
        let (stage_dir, work) = (Scratch::new(), Scratch::new());
        let mut unpacker = FakeUnpacker::new(stage_dir.path(), work.path());
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(scan.roots.len(), &mut tick);
        let items: Vec<&Item> = scan.items.iter().collect();
        let left = stage(
            stage_dir.path(),
            &items,
            &mut unpacker,
            SMALL_PARTS,
            &AtomicBool::new(false),
            &mut meter,
        )
        .unwrap();
        assert!(left.is_empty());
        assert_eq!(
            (
                meter.copied.done,
                meter.copied.failed,
                meter.copied.live_bytes,
                meter.copied.roots.clone()
            ),
            (240, 0, 0, vec![(240, 0)])
        );
        assert_eq!(
            fs::read_to_string(work.path().join("media/marketing/batch-3/still-59.jpg")).unwrap(),
            "still 3/59"
        );
        assert_eq!(unpacker.handed, 5);
        assert!(unpacker.most_waiting <= SMALL_PARTS.ahead);
        assert_eq!(fs::read_dir(stage_dir.path()).unwrap().count(), 0);
    }

    /// An archive that does not unpack leaves its files to the streamed route, marked spoiled until it lands them; the
    /// other archives' files land, and a helper that goes leaves everything it did not answer for.
    #[test]
    fn what_the_helper_did_not_unpack_is_left_for_the_streamed_route() {
        let (_base, scan) = stills(2, 60);
        let items: Vec<&Item> = scan.items.iter().collect();
        let (stage_dir, work) = (Scratch::new(), Scratch::new());
        let mut unpacker = FakeUnpacker::new(stage_dir.path(), work.path());
        unpacker.fail.insert("part-00002.tar".to_string());
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(scan.roots.len(), &mut tick);
        let left = stage(
            stage_dir.path(),
            &items,
            &mut unpacker,
            SMALL_PARTS,
            &AtomicBool::new(false),
            &mut meter,
        )
        .unwrap();
        let left_files = left.iter().filter(|item| item.kind == Kind::File).count();
        assert_eq!(
            (meter.copied.done, left_files, meter.spoiled.len()),
            (70, 50, 50)
        );
        // Streamed whole, each comes off the spoiled list once the sandbox's tar says so.
        let mut streamed = Vec::new();
        let mut writes = Writes::new(false, true, None);
        write_archive(
            &mut streamed,
            &left,
            &AtomicBool::new(false),
            &mut meter,
            &mut writes,
        )
        .unwrap();
        assert_eq!((meter.copied.done, meter.spoiled.len()), (70, 50));
        writes.end(true, true, &mut meter);
        assert_eq!((meter.copied.done, meter.spoiled.len()), (120, 0));

        let (stage_dir, work) = (Scratch::new(), Scratch::new());
        let mut unpacker = FakeUnpacker::new(stage_dir.path(), work.path());
        unpacker.gone_after = Some(1);
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(scan.roots.len(), &mut tick);
        let left = stage(
            stage_dir.path(),
            &items,
            &mut unpacker,
            SMALL_PARTS,
            &AtomicBool::new(false),
            &mut meter,
        )
        .unwrap();
        let left_files = left.iter().filter(|item| item.kind == Kind::File).count();
        assert_eq!(meter.copied.done as usize + left_files, 120);
        assert_eq!(meter.copied.done, 50);
        assert_eq!(fs::read_dir(stage_dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_cancel_stops_staging_and_leaves_no_archive_behind() {
        let (_base, scan) = stills(2, 60);
        let items: Vec<&Item> = scan.items.iter().collect();
        let (stage_dir, work) = (Scratch::new(), Scratch::new());
        let mut unpacker = FakeUnpacker::new(stage_dir.path(), work.path());
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(scan.roots.len(), &mut tick);
        let result = stage(
            stage_dir.path(),
            &items,
            &mut unpacker,
            SMALL_PARTS,
            &AtomicBool::new(true),
            &mut meter,
        );
        assert!(matches!(result, Err(Stop::Cancelled)));
        assert_eq!(fs::read_dir(stage_dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn the_staging_helper_is_heard_and_run_as_it_should_be() {
        assert_eq!(
            parse_answer("/opened part-00001.tar"),
            Answer::Opened("part-00001.tar".into())
        );
        assert_eq!(
            parse_answer("/ok part-00001.tar"),
            Answer::Unpacked("part-00001.tar".into(), true)
        );
        assert_eq!(
            parse_answer("/failed part-00002.tar"),
            Answer::Unpacked("part-00002.tar".into(), false)
        );
        assert_eq!(
            parse_answer("media/ok part.jpg"),
            Answer::Said("media/ok part.jpg".into())
        );
        assert_eq!(
            parse_answer("tar: something"),
            Answer::Said("tar: something".into())
        );
        let args = stage_args(
            "intentic-drop-copy-a1-stage",
            "sha256:abc",
            "intentic-workspace-x",
            Path::new("/tmp/stage"),
            Binds::AsIs,
        )
        .expect("a local folder mounts");
        assert_eq!(
            &args[13..19],
            &[
                "-v",
                "/tmp/stage:/stage:ro",
                "-v",
                "intentic-workspace-x:/work",
                "sha256:abc",
                "-c"
            ]
        );
    }

    #[test]
    fn on_our_engine_every_bind_source_is_where_its_distro_sees_the_drive() {
        let place = PathBuf::from(r"D:\movies\Moje filmy");
        let args = helper_args(
            "intentic-drop-copy-a1",
            "sha256:abc",
            "intentic-workspace-x",
            &[(place.as_path(), "films")],
            "media",
            Binds::Wsl,
        );
        assert!(args.contains(&"/mnt/d/movies/Moje filmy:/src/films:ro".to_string()));
        let staged = stage_args(
            "intentic-drop-copy-a1-stage",
            "sha256:abc",
            "intentic-workspace-x",
            Path::new(r"C:\Users\me\AppData\Local\Temp\intentic-drop-copy-a1"),
            Binds::Wsl,
        )
        .expect("a temp folder on C: mounts");
        assert!(staged.contains(
            &"/mnt/c/Users/me/AppData/Local/Temp/intentic-drop-copy-a1:/stage:ro".to_string()
        ));
        // A staging folder on a share has no place in the distro: the helper is never started, and the small files
        // are streamed instead.
        assert_eq!(
            stage_args(
                "n",
                "sha256:abc",
                "v",
                Path::new(r"\\nas\temp\stage"),
                Binds::Wsl
            ),
            None
        );
    }

    #[test]
    fn the_helper_mounts_each_root_read_only_beside_the_workspace_volume() {
        let place = PathBuf::from("/home/me/Movies/marketing");
        let args = helper_args(
            "intentic-drop-copy-a1",
            "sha256:abc",
            "intentic-workspace-x",
            &[(place.as_path(), "marketing")],
            "media",
            Binds::AsIs,
        );
        assert_eq!(
            args.iter()
                .map(String::as_str)
                .filter(|arg| !arg.contains("tar "))
                .collect::<Vec<_>>(),
            vec![
                "run",
                "--rm",
                "-i",
                "--name",
                "intentic-drop-copy-a1",
                "--network",
                "none",
                "--pull",
                "never",
                "--log-driver",
                "none",
                "--entrypoint",
                "sh",
                "-v",
                "/home/me/Movies/marketing:/src/marketing:ro",
                "-v",
                "intentic-workspace-x:/work",
                "sha256:abc",
                "-c",
                "sh",
                "media",
            ]
        );
        assert_eq!(
            parse_inspect("sha256:abc\tintentic-workspace-x\n"),
            Some(Sandbox {
                image: "sha256:abc".into(),
                volume: "intentic-workspace-x".into()
            })
        );
        assert_eq!(parse_inspect("sha256:abc\t\n"), None);
    }

    #[test]
    fn the_helpers_words_are_read_for_what_they_say() {
        assert_eq!(said("tar: 64"), Said::Records(64));
        assert_eq!(
            said("marketing/films/a.mp4"),
            Said::Name("marketing/films/a.mp4")
        );
        assert_eq!(
            said("tar: marketing/b.mov: Cannot open: Permission denied"),
            Said::Trouble("marketing/b.mov", "Cannot open: Permission denied")
        );
        assert_eq!(
            said("tar: Exiting with failure status due to previous errors"),
            Said::Other("tar: Exiting with failure status due to previous errors")
        );
        assert_eq!(
            said("docker: Error response from daemon: invalid mount config"),
            Said::Other("docker: Error response from daemon: invalid mount config")
        );
    }

    fn big(relative: &str, size: u64) -> Item {
        Item {
            name: format!("media/{relative}"),
            relative: relative.to_string(),
            source: PathBuf::new(),
            kind: Kind::File,
            size,
            mtime: 0,
            root: 0,
        }
    }

    #[cfg(unix)]
    fn exited(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn exited(code: i32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code as u32)
    }

    /// The helper's run as the card hears it: a file lands once its writing tar has moved past it and its reading tar
    /// vouched for it; the files the reading tar had trouble with go back to the streamed route rather than counted
    /// failed, the one it padded spoiled. Docker's own warning on stderr is nobody's file.
    #[test]
    fn the_helper_is_followed_file_by_file() {
        let owned = [
            big("m/a.mp4", 3 * RECORD),
            big("m/b.mov", RECORD),
            big("m/c.mp4", 2 * RECORD),
            big("m/d.mov", RECORD),
        ];
        let items: Vec<&Item> = owned.iter().collect();
        assert_eq!(
            helper_list(&items),
            b"m/a.mp4\0m/b.mov\0m/c.mp4\0m/d.mov\0".to_vec()
        );
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(1, &mut tick);
        let mut follow = Follow::new(&items);
        let reading = |line: &str| Heard::Reading(line.to_string());
        let writing = |line: &str| Heard::Writing(line.to_string());
        for line in [
            reading("WARNING: The requested image's platform (linux/amd64) does not match"),
            reading("m/a.mp4"),
            reading("tar: 2"),
            writing("m/a.mp4"),
            reading("tar: m/b.mov: Cannot open: Permission denied"),
            reading("m/c.mp4"),
            reading("tar: 4"),
            // The writing tar is past a.mp4 and on c.mp4 before the reading tar says it padded c.mp4.
            writing("m/c.mp4"),
            reading("tar: m/c.mp4: Read error at byte 1048576, while reading 1048576 bytes: Cannot allocate memory"),
            reading("m/d.mov"),
            writing("m/d.mov"),
            reading("tar: Exiting with failure status due to previous errors"),
        ] {
            follow.hear(line, &mut meter);
        }
        assert_eq!(
            (
                meter.copied.done,
                meter.copied.done_bytes,
                meter.copied.failed,
                meter.copied.current.as_str()
            ),
            (1, 3 * RECORD, 0, "media/m/d.mov")
        );
        let left = follow.end(Some(exited(0)), &mut meter);
        assert_eq!(
            left.iter()
                .map(|item| item.relative.as_str())
                .collect::<Vec<_>>(),
            vec!["m/b.mov", "m/c.mp4"]
        );
        assert_eq!(
            (
                meter.copied.done,
                meter.copied.done_bytes,
                meter.copied.roots.clone()
            ),
            (2, 4 * RECORD, vec![(2, 0)])
        );
        // b.mov was never written; c.mp4 was, padded, and goes once the streamed route lands it or the copy ends.
        assert_eq!(meter.spoiled, HashSet::from(["media/m/c.mp4".to_string()]));
    }

    /// A write that fails on the writing tar's side (a full disk) is said after the reading tar has moved on to the
    /// next file: it is still that file's, which is spoiled and handed back rather than counted done. A file the
    /// writing tar never named was never written, and is handed back without being spoiled.
    #[test]
    fn a_file_the_writing_tar_could_not_write_is_handed_back() {
        let owned = [
            big("m/a.bin", 3 * RECORD),
            big("m/b.bin", 2 * RECORD),
            big("m/c.bin", 2 * RECORD),
        ];
        let items: Vec<&Item> = owned.iter().collect();
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(1, &mut tick);
        let mut follow = Follow::new(&items);
        for line in [
            Heard::Reading("m/a.bin".into()),
            Heard::Reading("m/b.bin".into()),
            Heard::Writing("m/a.bin".into()),
            Heard::Writing("tar: m/a.bin: Wrote only 2969600 of 3145728 bytes".into()),
            Heard::Reading("m/c.bin".into()),
            Heard::Writing("m/b.bin".into()),
            Heard::Writing("m/c.bin".into()),
            Heard::Writing("tar: Exiting with failure status due to previous errors".into()),
        ] {
            follow.hear(line, &mut meter);
        }
        let left = follow.end(Some(exited(2)), &mut meter);
        assert_eq!(
            left.iter()
                .map(|item| item.relative.as_str())
                .collect::<Vec<_>>(),
            vec!["m/a.bin"]
        );
        assert_eq!(
            (meter.copied.done, meter.spoiled.clone()),
            (2, HashSet::from(["media/m/a.bin".to_string()]))
        );

        // A writing tar that stops (killed, out of memory) vouches for nothing it was on.
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(1, &mut tick);
        let mut follow = Follow::new(&items);
        for line in [
            Heard::Reading("m/a.bin".into()),
            Heard::Reading("m/b.bin".into()),
            Heard::Writing("m/a.bin".into()),
            Heard::Writing("m/b.bin".into()),
        ] {
            follow.hear(line, &mut meter);
        }
        let left = follow.end(Some(exited(137)), &mut meter);
        assert_eq!(
            left.iter()
                .map(|item| item.relative.as_str())
                .collect::<Vec<_>>(),
            vec!["m/b.bin", "m/c.bin"]
        );
        assert_eq!(
            (meter.copied.done, meter.spoiled.clone()),
            (1, HashSet::from(["media/m/b.bin".to_string()]))
        );
    }

    /// A helper that could not do its job (here, Docker refusing the mount) hands back everything, and spoils nothing:
    /// it wrote nothing.
    #[test]
    fn a_helper_that_stops_hands_back_what_it_did_not_finish() {
        let owned = [
            big("m/a.mp4", RECORD),
            big("m/b.mov", RECORD),
            big("m/c.mp4", RECORD),
        ];
        let items: Vec<&Item> = owned.iter().collect();
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(1, &mut tick);
        let mut follow = Follow::new(&items);
        follow.hear(
            Heard::Reading("docker: Error response from daemon: invalid mount config".into()),
            &mut meter,
        );
        let left = follow.end(Some(exited(125)), &mut meter);
        assert_eq!(left.len(), 3);
        assert_eq!((meter.copied.done, meter.spoiled.len()), (0, 0));
    }

    /// The streamed route counts a file done only once the sandbox's tar has written it: a write that fails partway (a
    /// full disk) leaves it spoiled and failed, though every byte of it went into the pipe; one tar never reached is
    /// failed and left alone, older copy and all.
    #[test]
    fn a_streamed_file_tar_could_not_write_is_spoiled_and_failed() {
        let base = Scratch::new();
        let mut owned = Vec::new();
        for name in ["a.jpg", "b.jpg", "c.jpg"] {
            let path = base.path().join(name);
            fs::write(&path, vec![1u8; 10_240]).unwrap();
            let mut item = big(&format!("m/{name}"), 10_240);
            item.source = path;
            owned.push(item);
        }
        let items: Vec<&Item> = owned.iter().collect();
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(1, &mut tick);
        // Left by an earlier route that failed partway through it.
        meter.spoiled.insert("media/m/a.jpg".to_string());
        let mut writes = Writes::new(false, true, None);
        write_archive(
            Vec::new(),
            &items,
            &AtomicBool::new(false),
            &mut meter,
            &mut writes,
        )
        .unwrap();
        assert_eq!(
            (meter.copied.done, meter.copied.live_bytes),
            (0, 3 * 10_240)
        );
        for line in [
            "media/m/a.jpg",
            "media/m/b.jpg",
            "tar: media/m/b.jpg: Wrote only 512 of 10240 bytes",
            "tar: Error is not recoverable: exiting now",
        ] {
            writes.hear(line, &mut meter);
        }
        writes.end(false, false, &mut meter);
        settle_stream(
            &writes,
            Some("Docker stopped the copy: tar: …"),
            false,
            &mut meter,
        );
        assert_eq!(
            (
                meter.copied.done,
                meter.copied.failed,
                meter.spoiled.clone()
            ),
            (1, 2, HashSet::from(["media/m/b.jpg".to_string()]))
        );

        // tar's 0 makes a complaint a warning.
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(1, &mut tick);
        let mut writes = Writes::new(false, true, None);
        write_archive(
            Vec::new(),
            &items,
            &AtomicBool::new(false),
            &mut meter,
            &mut writes,
        )
        .unwrap();
        writes.hear("media/m/a.jpg", &mut meter);
        writes.hear("tar: media/m/a.jpg: implausibly old time stamp", &mut meter);
        writes.end(true, true, &mut meter);
        assert_eq!(
            (
                meter.copied.done,
                meter.copied.live_bytes,
                meter.spoiled.len()
            ),
            (3, 0, 0)
        );
    }

    /// A staging helper that answers as the real one does: that it opened an archive, tar's names as it goes, and
    /// (unless `stop_after` names it stops partway) that it unpacked. Raises `cancel` when handed archive `cancel_at`.
    struct ScriptedUnpacker<'c> {
        stage: PathBuf,
        stop_after: usize,
        cancel: &'c AtomicBool,
        cancel_at: usize,
        handed: usize,
        answers: VecDeque<Answer>,
        halted: bool,
    }

    impl Unpacker for ScriptedUnpacker<'_> {
        fn unpack(&mut self, part: &str) -> io::Result<()> {
            self.handed += 1;
            if self.handed == 1 {
                let bytes = fs::read(self.stage.join(part)).unwrap();
                let mut archive = tar::Archive::new(bytes.as_slice());
                let names: Vec<String> = archive
                    .entries()
                    .unwrap()
                    .map(|entry| {
                        entry
                            .unwrap()
                            .path()
                            .unwrap()
                            .to_string_lossy()
                            .into_owned()
                    })
                    .collect();
                self.answers.push_back(Answer::Opened(part.to_string()));
                for name in names.into_iter().take(self.stop_after) {
                    self.answers.push_back(Answer::Said(name));
                }
            }
            if self.handed == self.cancel_at {
                self.cancel.store(true, Ordering::SeqCst);
            }
            Ok(())
        }

        fn answer(&mut self, _wait: Duration) -> Answer {
            match self.answers.pop_front() {
                Some(answer) => answer,
                None if self.halted => Answer::Gone,
                None => Answer::Waiting,
            }
        }

        fn halt(&mut self) {
            self.halted = true;
        }
    }

    /// A cancel while the helper is partway through an archive: what tar got past stays and counts done, the file it
    /// was on is spoiled, and nothing of the archives it never opened is touched, so older copies of their files stay.
    /// Spoiling every file handed over, as the staged route first did, deleted those older copies (2026-10-10).
    #[test]
    fn a_cancel_while_unpacking_spoils_only_the_file_tar_was_on() {
        let (_base, scan) = stills(1, 120);
        let items: Vec<&Item> = scan.items.iter().collect();
        let stage_dir = Scratch::new();
        let cancel = AtomicBool::new(false);
        let mut unpacker = ScriptedUnpacker {
            stage: stage_dir.path().to_path_buf(),
            // The two folders, then two stills, and on the third.
            stop_after: 5,
            cancel: &cancel,
            cancel_at: 2,
            handed: 0,
            answers: VecDeque::new(),
            halted: false,
        };
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(scan.roots.len(), &mut tick);
        let result = stage(
            stage_dir.path(),
            &items,
            &mut unpacker,
            SMALL_PARTS,
            &cancel,
            &mut meter,
        );
        assert!(matches!(result, Err(Stop::Cancelled)));
        assert_eq!(unpacker.handed, 2);
        assert_eq!(meter.copied.done, 2);
        assert_eq!(meter.spoiled.len(), 1);
        let spoiled = meter.spoiled.iter().next().unwrap();
        assert!(
            spoiled.starts_with("media/marketing/batch-0/still-"),
            "{spoiled}"
        );
        assert_eq!(fs::read_dir(stage_dir.path()).unwrap().count(), 0);
    }

    /// The streamed route marks a file it padded, and clears the mark when it lands the file whole, as a retry of a
    /// file the helper padded does.
    #[test]
    fn a_file_written_but_not_whole_is_marked_until_a_whole_copy_lands() {
        let base = Scratch::new();
        let whole = base.path().join("whole.mov");
        fs::write(&whole, vec![1u8; 4096]).unwrap();
        let mut gone = big("m/gone.mov", 4096);
        gone.source = base.path().join("not-there.mov");
        let mut retried = big("m/whole.mov", 4096);
        retried.source = whole;
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(1, &mut tick);
        meter.spoiled.insert("media/m/whole.mov".to_string());
        let mut writes = Writes::new(false, true, None);
        write_archive(
            Vec::new(),
            &[&gone, &retried],
            &AtomicBool::new(false),
            &mut meter,
            &mut writes,
        )
        .unwrap();
        // Not landed until the sandbox's tar says so.
        assert_eq!((meter.copied.done, meter.spoiled.len()), (0, 1));
        writes.hear("media/m/whole.mov", &mut meter);
        writes.end(true, true, &mut meter);
        // gone.mov never opened, so nothing of it was written and nothing is taken away.
        assert_eq!(
            (meter.copied.done, meter.copied.failed, meter.spoiled.len()),
            (1, 1, 0)
        );
    }

    /// Both routes against a real container, for a machine with Docker: DROP_COPY_CONTAINER names a running container
    /// with a volume at /work, DROP_COPY_SOURCE a folder to drop. Prints what the page would hear.
    #[test]
    #[ignore = "needs Docker and a container; run by hand"]
    fn a_real_drop_lands_in_a_real_container() {
        let container = std::env::var("DROP_COPY_CONTAINER").unwrap();
        let source = PathBuf::from(std::env::var("DROP_COPY_SOURCE").unwrap());
        let request = parse_request(&json!({ "id": "e2e-1", "port": 1, "target": "dropped", "skip": { "dirs": ["node_modules"] }, "atLeast": { "files": 0, "bytes": 0 } })).unwrap();
        let mut last = Value::Null;
        let started = Instant::now();
        let mut said = Instant::now();
        copy_into(
            &request,
            &[source],
            &container,
            &AtomicBool::new(false),
            &mut |event| {
                // Every event but progress, and progress every two seconds: files done (unpacked or landed) against
                // bytes sent (read and staged, or streamed), which says which half of a route is the slow one.
                if event["kind"] != "progress" || said.elapsed() >= Duration::from_secs(2) {
                    said = Instant::now();
                    let shown = if event["kind"] == "progress" {
                        format!(
                            "progress: {} done, {:.0} MB done, {:.0} MB sent, now {}",
                            event["done"],
                            event["doneBytes"].as_f64().unwrap_or(0.0) / 1e6,
                            event["sentBytes"].as_f64().unwrap_or(0.0) / 1e6,
                            event["current"]
                        )
                    } else {
                        event.to_string()
                    };
                    println!("{:>6.1}s {shown}", started.elapsed().as_secs_f64());
                }
                last = event;
            },
        );
        assert_eq!(last["kind"], "finished");
        assert!(last.get("error").is_none(), "{last}");
    }

    #[test]
    fn the_card_hears_dockers_own_words_when_the_copy_fails() {
        assert_eq!(copy_error(None, Some(true), ""), None);
        assert_eq!(
            copy_error(None, Some(false), "Error: No such container: x\n").as_deref(),
            Some("Docker stopped the copy: Error: No such container: x")
        );
        let pipe = io::Error::from(io::ErrorKind::BrokenPipe);
        assert!(copy_error(Some(&pipe), Some(false), "")
            .unwrap()
            .starts_with("The copy stopped"));
    }
}
