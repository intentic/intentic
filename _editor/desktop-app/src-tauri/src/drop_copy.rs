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
// itself. A drop big enough to be worth it is then copied two ways, each where it is fastest (measured on Docker
// Desktop for Windows, 2026-10-09):
//
// - folders and small files as one tar archive streamed into the sandbox's own `tar -x` (`docker exec -i`): about
//   2,000 small files a second, but only ~20 MB/s, since every byte crosses Docker's API;
// - files from MOUNTED_FROM up by a throwaway helper container that bind-mounts the dropped folder read-only beside
//   the sandbox's workspace volume and tars across: ~190 MB/s, but ~300 files a second, since each file is opened
//   over Docker Desktop's file sharing. A place it cannot mount (a network share), and any file the helper had
//   trouble reading, goes the first way instead.
//
// A file written but not whole (a failed read, which tar pads out; a cancel partway) is removed from the workspace at
// the end, so a failed file is missing rather than there and wrong.
//
// The page hears how far it has got through `intentic:drop-copy` events and draws the same card it draws for an
// upload. Anything the app will not take (no Docker, no container on that port, a drop too small to bother, a file
// with no place on disk) is said back as `declined`, and the page uploads the drop the way it always has.
//
// The page can only name files the user dropped: a `File` with a place on disk exists only for something a person
// dragged in or picked. What it names freely, the folder they go into, is held to a plain relative path below /work.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Files below /work that a route wrote but not whole: padded after a failed read, or cut off by a cancel. Taken
    /// out again by a later route landing the file, and removed from the workspace at the end (`remove_spoiled`), so a
    /// failed file is missing rather than there and wrong.
    spoiled: HashSet<String>,
    /// The file the streamed route is writing now.
    in_flight: Option<String>,
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
            in_flight: None,
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
}

/// Why a copy stopped before the end.
#[derive(Debug, PartialEq, Eq)]
enum Stop {
    Cancelled,
    Failed(String),
}

fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "cancelled")
}

/* THE STREAMED ROUTE: folders and small files, one archive into `tar -x` in the sandbox. */

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

/// Writes `items` as one tar archive into `out`, named by their paths below /work. A file that will not open is
/// skipped and recorded; one that fails partway is padded (see [`Exact`]) and recorded. `Err` only for the archive
/// itself: `out` refusing a write (the copy on the other end is gone) or the cancel.
fn write_archive<W: Write>(
    out: W,
    items: &[&Item],
    cancel: &AtomicBool,
    meter: &mut Meter,
) -> io::Result<()> {
    let mut builder = tar::Builder::new(out);
    for item in items {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if item.kind == Kind::Dir {
            let mut head = header(Kind::Dir, 0, item.mtime);
            builder.append_data(&mut head, &item.name, io::empty())?;
            continue;
        }
        let opened = std::fs::File::open(&item.source).and_then(|file| {
            let size = file.metadata()?.len();
            Ok((file, size))
        });
        let (file, size) = match opened {
            Ok(opened) => opened,
            Err(error) => {
                meter.copied.fail(item, error.to_string());
                continue;
            }
        };
        meter.copied.current.clone_from(&item.name);
        // Until the file's last byte is out: an archive ended here (a cancel, the other end gone) leaves it partial.
        meter.in_flight = Some(item.name.clone());
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
        meter.in_flight = None;
        meter.copied.live_bytes = 0;
        match error {
            Some(error) => {
                meter.spoiled.insert(item.name.clone());
                meter.copied.fail(item, error);
            }
            None => {
                meter.spoiled.remove(&item.name);
                meter.copied.land(item);
            }
        }
    }
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

/// `items` through `docker exec -i -u 0 <container> tar -x -C /work`: the archive on tar's stdin, unpacked by the
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
            "exec", "-i", "-u", "0", container, "tar", "-x", "-f", "-", "-C", WORK,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
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
    let written = match child.stdin.take() {
        Some(stdin) => write_archive(
            BufWriter::with_capacity(1 << 20, stdin),
            items,
            cancel,
            meter,
        ),
        None => Err(io::Error::other("docker took no input")),
    };
    if written.is_err() {
        let _ = child.kill();
        if let Some(name) = meter.in_flight.take() {
            meter.spoiled.insert(name);
        }
    }
    let status = child.wait();
    let said = stderr
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    if cancel.load(Ordering::SeqCst) {
        return Err(Stop::Cancelled);
    }
    match copy_error(
        written.as_ref().err(),
        status.ok().map(|status| status.success()),
        &said,
    ) {
        Some(error) => Err(Stop::Failed(error)),
        None => Ok(()),
    }
}

/* THE MOUNTED ROUTE: big files, by a helper container that sees the dropped folder. */

/// Files from this size up go the mounted route. Opening a file over Docker Desktop's file sharing costs about 3 ms,
/// which the mounted route's ~9x speed repays from roughly 100 KB.
const MOUNTED_FROM: u64 = 256 * 1024;
/// The helper's tar record, 1 MiB (`-b 2048`). At tar's default 10 KiB every read crosses the file sharing on its
/// own: 1 GiB took 16 s rather than 6.
const RECORD: u64 = 1024 * 1024;
/// What the helper runs: the listed files out of /src, as root-owned 644 files, into the target below /work. `-v`
/// names each file as it starts and `--checkpoint` says every 16 MiB how far it has got, both on stderr.
const HELPER_SCRIPT: &str =
    "mkdir -p \"/work/$1\" && tar -C /src --null --no-recursion -T - -b 2048 -cvf - \
    --checkpoint=16 --checkpoint-action=echo=%u --owner=0 --group=0 --mode=go-w,a-x,a+X \
    | tar -C \"/work/$1\" -b 2048 -xf - --no-same-owner";

/// Whether a dropped item's place can be bind-mounted: a path on one of this computer's drives. A network share is
/// not something Docker Desktop mounts.
fn mountable(place: &Path) -> bool {
    place.is_absolute() && !place.to_string_lossy().starts_with(r"\\")
}

/// The sandbox container's image and the volume its /work is, from `docker inspect` (`image<TAB>volume`): the helper
/// runs the image that is already here and mounts that same volume.
pub fn parse_inspect(out: &str) -> Option<(String, String)> {
    let (image, volume) = out.trim().split_once('\t')?;
    (!image.is_empty() && !volume.is_empty()).then(|| (image.to_string(), volume.to_string()))
}

fn inspect(container: &str) -> Result<(String, String), String> {
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

/// The helper's `docker run`: named so a cancel can remove it (killing the CLI leaves a container running), no
/// network, never a pull, each dropped root read-only at /src/<its name>, the workspace volume at /work.
pub fn helper_args(
    name: &str,
    image: &str,
    volume: &str,
    mounts: &[(&Path, &str)],
    target: &str,
) -> Vec<String> {
    let mut args: Vec<String> = [
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
    .to_vec();
    for (place, root) in mounts {
        args.push("-v".to_string());
        args.push(format!("{}:/src/{root}:ro", place.display()));
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

/// A line the helper wrote on stderr.
#[derive(Debug, PartialEq, Eq)]
pub enum Said<'a> {
    /// `--checkpoint`: this many records written.
    Records(u64),
    /// `-v`: the next listed file has started.
    Started,
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
    Said::Started
}

/// The big files, through the helper. Returns what is left for the streamed route: the files the helper had trouble
/// with, and, when it could not do its job (it would not mount, Docker refused it), the file it was on and the rest. A
/// failure of this route costs speed and never a file.
fn mount<'i>(
    container: &str,
    id: &str,
    target: &str,
    scan: &Scan,
    items: &[&'i Item],
    cancel: &AtomicBool,
    meter: &mut Meter,
) -> Result<Vec<&'i Item>, Stop> {
    let (image, volume) = match inspect(container) {
        Ok(found) => found,
        Err(reason) => {
            eprintln!("drop copy: streaming the big files too: {reason}");
            return Ok(items.to_vec());
        }
    };
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
        .args(helper_args(&name, &image, &volume, &mounts, target))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
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
    let (lines, heard) = mpsc::channel::<String>();
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in io::BufReader::new(stderr).lines().map_while(Result::ok) {
                if lines.send(line).is_err() {
                    break;
                }
            }
        });
    }
    let total: u64 = items.iter().map(|item| item.size).sum();
    let mut follow = Follow::default();
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let mut remove = crate::scripts::docker_command();
            remove.args(["rm", "-f", &name]);
            let _ = crate::scripts::capture("docker rm", remove, LOOKUP_LIMIT);
            let _ = child.kill();
            let _ = child.wait();
            if let Some((index, _)) = follow.going {
                meter.spoiled.insert(items[index].name.clone());
            }
            return Err(Stop::Cancelled);
        }
        match heard.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => follow.hear(&line, items, total, meter),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break child.wait(),
        }
    };
    Ok(follow.end(status.ok(), items, meter))
}

/// What the helper has said so far, read against its list: the files run in list order, each named as it starts.
#[derive(Default)]
struct Follow {
    /// The next file in the list not yet started or refused.
    next: usize,
    /// The file going now, and whether tar has had trouble with it.
    going: Option<(usize, bool)>,
    /// Bytes of the files settled so far, the yardstick for the records count.
    settled_bytes: u64,
    /// The files tar had trouble with, by their place in the list: for the streamed route to try again. On Docker
    /// Desktop a read through the file sharing can fail where the app's own read of the same file does not (2026-10-09:
    /// "Cannot allocate memory" partway through a film).
    retry: Vec<usize>,
    /// Docker's or tar's last words that were about no one file.
    last_words: String,
}

impl Follow {
    fn settle(&mut self, items: &[&Item], meter: &mut Meter) {
        if let Some((index, troubled)) = self.going.take() {
            let item = items[index];
            self.settled_bytes += item.size;
            if !troubled {
                meter.copied.land(item);
            }
        }
    }

    fn hear(&mut self, line: &str, items: &[&Item], total: u64, meter: &mut Meter) {
        match said(line) {
            Said::Records(records) => {
                meter.copied.live_bytes = (records * RECORD)
                    .min(total)
                    .saturating_sub(self.settled_bytes);
            }
            Said::Started if self.next < items.len() => {
                self.settle(items, meter);
                meter.copied.live_bytes = 0;
                meter.copied.current.clone_from(&items[self.next].name);
                self.going = Some((self.next, false));
                self.next += 1;
            }
            Said::Trouble(path, _) => {
                match self.going {
                    // The file going now, coming up short: tar pads it out, so what landed is spoiled until the
                    // retry lands it whole.
                    Some((index, false)) if items[index].relative == path => {
                        self.going = Some((index, true));
                        meter.spoiled.insert(items[index].name.clone());
                        self.retry.push(index);
                    }
                    // A file tar could not open: it is never named as started, and the list moves past it.
                    _ if self.next < items.len() && items[self.next].relative == path => {
                        self.retry.push(self.next);
                        self.settled_bytes += items[self.next].size;
                        self.next += 1;
                    }
                    _ => self.last_words = line.to_string(),
                }
            }
            Said::Started => {}
            Said::Other(words) => {
                if !words.is_empty() {
                    self.last_words = words.to_string();
                }
            }
        }
        meter.report();
    }

    /// The helper has exited. Every file it reached is settled, and the files it had trouble with are handed back;
    /// if it stopped before the end of its list, so are the file it was on and the rest.
    fn end<'i>(
        mut self,
        status: Option<ExitStatus>,
        items: &[&'i Item],
        meter: &mut Meter,
    ) -> Vec<&'i Item> {
        let reached_end = self.next == items.len();
        // tar exits 2 when some files had trouble, each already handed back; any other failure stopped the copy.
        let finished = status
            .is_some_and(|status| status.success() || (status.code() == Some(2) && reached_end));
        meter.copied.live_bytes = 0;
        let mut left: Vec<&Item> = self.retry.iter().map(|&index| items[index]).collect();
        if finished {
            self.settle(items, meter);
            return left;
        }
        eprintln!(
            "drop copy: the helper stopped ({:?}): {}; streaming the rest",
            status, self.last_words
        );
        let from = match self.going {
            // Already handed back with its trouble.
            Some((index, true)) => index + 1,
            // Started and not finished: what landed of it is partial until the streamed route sends it whole.
            Some((index, false)) => {
                meter.spoiled.insert(items[index].name.clone());
                index
            }
            None => self.next,
        };
        left.extend_from_slice(&items[from.min(items.len())..]);
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

/// Which way each item goes: big files on a place that mounts go mounted, everything else (folders first, so the
/// tree exists before anything lands in it) streamed.
fn routes(scan: &Scan) -> (Vec<&Item>, Vec<&Item>) {
    scan.items.iter().partition(|item| {
        item.kind == Kind::File && item.size >= MOUNTED_FROM && mountable(&scan.places[item.root])
    })
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
    let (mounted, streamed) = routes(&scan);
    let mut tick = |copied: &Copied| emit(with(id, "progress", copied_json(copied)));
    let mut meter = Meter::new(scan.roots.len(), &mut tick);
    let outcome = stream(container, &streamed, cancel, &mut meter).and_then(|()| {
        if mounted.is_empty() {
            return Ok(());
        }
        let left = mount(
            container,
            id,
            &request.target,
            &scan,
            &mounted,
            cancel,
            &mut meter,
        )?;
        if left.is_empty() {
            Ok(())
        } else {
            stream(container, &left, cancel, &mut meter)
        }
    });
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

    /// The whole scan as the streamed route's archive, and what the copy counted.
    fn archived(scan: &Scan) -> (Vec<u8>, Copied) {
        let mut archive = Vec::new();
        let mut tick = |_: &Copied| {};
        let mut meter = Meter::new(scan.roots.len(), &mut tick);
        let items: Vec<&Item> = scan.items.iter().collect();
        write_archive(&mut archive, &items, &AtomicBool::new(false), &mut meter).unwrap();
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
        let result = write_archive(Vec::new(), &items, &AtomicBool::new(true), &mut meter);
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
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
        let (mounted, streamed) = routes(&scan);
        assert_eq!(
            mounted
                .iter()
                .map(|item| item.relative.as_str())
                .collect::<Vec<_>>(),
            vec!["marketing/films/2026/launch-4k.mp4"]
        );
        // The folders lead, in walk order, so the tree is there before anything lands in it.
        assert_eq!(
            streamed
                .first()
                .map(|item| (item.relative.as_str(), item.kind)),
            Some(("marketing", Kind::Dir))
        );
        assert_eq!(
            streamed
                .iter()
                .filter(|item| item.kind == Kind::File)
                .count(),
            5
        );
        assert!(!mountable(Path::new(r"\\nas\films")));
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
            Some(("sha256:abc".into(), "intentic-workspace-x".into()))
        );
        assert_eq!(parse_inspect("sha256:abc\t\n"), None);
    }

    #[test]
    fn the_helpers_words_are_read_for_what_they_say() {
        assert_eq!(said("tar: 64"), Said::Records(64));
        assert_eq!(said("marketing/films/a.mp4"), Said::Started);
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

    /// The helper's run as the card hears it: a file done as the next starts, and the files tar had trouble with
    /// handed back to the streamed route rather than counted failed, the one it padded marked as spoiled.
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
        let mut follow = Follow::default();
        let total = 7 * RECORD;
        for line in [
            "m/a.mp4",
            "tar: 2",
            "tar: m/b.mov: Cannot open: Permission denied",
            "m/c.mp4",
            "tar: 4",
            "tar: m/c.mp4: Read error at byte 1048576, while reading 1048576 bytes: Cannot allocate memory",
            "m/d.mov",
        ] {
            follow.hear(line, &items, total, &mut meter);
        }
        assert_eq!(
            (
                meter.copied.done,
                meter.copied.done_bytes,
                meter.copied.failed
            ),
            (1, 3 * RECORD, 0)
        );
        let left = follow.end(Some(exited(2)), &items, &mut meter);
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

    /// A helper that could not do its job (here, Docker refusing the mount) hands back the file it was on and the
    /// rest, for the streamed route; what it wrote of the file it was on is spoiled until then.
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
        let mut follow = Follow::default();
        follow.hear("m/a.mp4", &items, 3 * RECORD, &mut meter);
        follow.hear("m/b.mov", &items, 3 * RECORD, &mut meter);
        let left = follow.end(Some(exited(125)), &items, &mut meter);
        assert_eq!(
            left.iter()
                .map(|item| item.relative.as_str())
                .collect::<Vec<_>>(),
            vec!["m/b.mov", "m/c.mp4"]
        );
        assert_eq!(
            (meter.copied.done, meter.spoiled.clone()),
            (1, HashSet::from(["media/m/b.mov".to_string()]))
        );
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
        write_archive(
            Vec::new(),
            &[&gone, &retried],
            &AtomicBool::new(false),
            &mut meter,
        )
        .unwrap();
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
        copy_into(
            &request,
            &[source],
            &container,
            &AtomicBool::new(false),
            &mut |event| {
                if event["kind"] != "progress" {
                    println!("{:>6.1}s {event}", started.elapsed().as_secs_f64());
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
