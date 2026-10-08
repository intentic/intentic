/* THE SANDBOX IMAGE, FETCHED BEFORE DOCKER EXISTS — so a fresh PC's longest download overlaps its slowest waits. */

// On a PC with no Docker yet, setup used to download nothing of the sandbox image until Docker Desktop was installed,
// Windows had restarted and the engine had come up: then `docker pull` started on 1.8 GB (116 layers), and the whole
// of it was waited out in front of the person. None of that download needs Docker. A registry is plain HTTPS, so
// `ic image prefetch` fetches the image's blobs into a cache of its own while WSL2 is turned on, while Windows waits for
// its restart, while Docker Desktop installs and starts; and `ic sandbox connect`, when it reaches the pull, loads that
// cache into Docker instead (`load_if_cached`), fetching only what is still missing. Anything unusual (an image this
// cannot resolve anonymously, a load Docker refuses) falls back to `docker pull`, which is where every setup was before.
//
// The cache is `~/.intentic/image-cache/<image>/`: `blobs/sha256/<hex>` (an OCI layout's own blob paths), `state.json`
// (what a watcher reads: the manifest being fetched, bytes done and due), and `lock`, held by whichever process is
// fetching, so a prefetch the app started and the connect run that needs its result never write the same blob twice.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::fetch;

/// The image a sandbox runs when nothing names another: the same default `ic sandbox connect` uses.
pub const DEFAULT_IMAGE: &str = "ghcr.io/intentic/sandbox:stable";

/// What a registry is asked to answer a tag with: an index (several platforms) or a single manifest, in either the
/// OCI or the Docker spelling.
const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

/// Blobs fetched at once. Docker's own pull uses three; a fourth helps a CDN that is slower per connection than the
/// line is, and more just splits the same bandwidth thinner.
const PARALLEL: usize = 4;

/// A cache nobody has touched for this long is from a setup that was given up on: swept by the next prefetch or connect.
const STALE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// How long a connect run waits on a prefetch that holds the cache without anything arriving before it stops trusting
/// it and pulls instead.
const STALL: Duration = Duration::from_secs(120);

/// `ghcr.io/intentic/sandbox:stable`, taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub registry: String,
    pub repository: String,
    pub tag: String,
}

impl Reference {
    /// Only a reference that names its registry and a tag: a registry-less name is Docker Hub's or a local build's,
    /// and a digest reference is pinned on purpose — both are `docker pull`'s business, as before.
    pub fn parse(image: &str) -> Option<Reference> {
        let image = image.trim();
        if image.contains('@') {
            return None;
        }
        let (registry, rest) = image.split_once('/')?;
        if !(registry.contains('.') || registry.contains(':') || registry == "localhost") {
            return None;
        }
        let (repository, tag) = match rest.rsplit_once(':') {
            Some((repository, tag)) if !tag.contains('/') => (repository, tag),
            _ => (rest, "latest"),
        };
        if repository.is_empty() || tag.is_empty() {
            return None;
        }
        Some(Reference {
            registry: registry.to_string(),
            repository: repository.to_string(),
            tag: tag.to_string(),
        })
    }

    pub fn full(&self) -> String {
        format!("{}/{}:{}", self.registry, self.repository, self.tag)
    }

    /// A folder name that is the same reference every time and a path on every OS.
    fn slug(&self) -> String {
        self.full()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }
}

/// One blob, as a manifest lists it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Descriptor {
    #[serde(rename = "mediaType")]
    pub media_type: String,
    pub digest: String,
    pub size: u64,
}

/// The image for this machine, resolved: its manifest (bytes as served, since the digest is of those bytes), and what
/// that manifest lists.
#[derive(Debug, Clone)]
pub struct Plan {
    pub manifest: Descriptor,
    pub manifest_bytes: Vec<u8>,
    pub config: Descriptor,
    pub layers: Vec<Descriptor>,
}

impl Plan {
    /// Bytes to fetch for the whole image: what a progress bar fills towards.
    pub fn total(&self) -> u64 {
        self.config.size + self.layers.iter().map(|layer| layer.size).sum::<u64>()
    }
}

/// What `state.json` says, for a process watching another one fetch.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub reference: String,
    pub manifest_digest: String,
    pub done: u64,
    pub total: u64,
    /// `fetching` or `ready`.
    pub state: String,
}

/// The platform a sandbox runs as on this machine: Linux, on this CPU (Docker Desktop's VM matches its host's).
pub fn platform_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "amd64",
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// Where one image's cache lives. `INTENTIC_IMAGE_CACHE` moves the root (tests, and a PC whose home is the small disk).
pub fn dir_for(reference: &Reference) -> Option<PathBuf> {
    let root = std::env::var_os("INTENTIC_IMAGE_CACHE")
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .or_else(|| home().map(|home| home.join(".intentic").join("image-cache")))?;
    Some(root.join(reference.slug()))
}

fn blob_path(dir: &Path, digest: &str) -> PathBuf {
    dir.join("blobs")
        .join("sha256")
        .join(digest.trim_start_matches("sha256:"))
}

use crate::util::sha256_hex;

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("sha256:{}", hex(&hasher.finalize())))
}

/* THE REGISTRY, ANONYMOUSLY — the token dance every public registry does, and nothing else. */

/// The `key="value"` pairs of a `WWW-Authenticate: Bearer ...` challenge.
pub fn bearer_challenge(header: &str) -> Option<Vec<(String, String)>> {
    let rest = header.trim().strip_prefix("Bearer ")?;
    let mut pairs = Vec::new();
    let mut remaining = rest.trim();
    while !remaining.is_empty() {
        let (key, after) = remaining.split_once('=')?;
        let after = after.trim_start();
        let (value, next) = if let Some(quoted) = after.strip_prefix('"') {
            let end = quoted.find('"')?;
            (&quoted[..end], &quoted[end + 1..])
        } else {
            match after.find(',') {
                Some(end) => (&after[..end], &after[end..]),
                None => (after, ""),
            }
        };
        pairs.push((key.trim().to_string(), value.to_string()));
        remaining = next.trim_start().trim_start_matches(',').trim_start();
    }
    Some(pairs)
}

/// A manifest as the registry served it: its bytes, and what the response's headers said about them.
struct Document {
    bytes: Vec<u8>,
    media_type: Option<String>,
    digest: Option<String>,
}

/// One registry, asked anonymously: the pull token a 401 pointed at is fetched once and reused for every blob.
struct Registry {
    agent: ureq::Agent,
    reference: Reference,
    token: Mutex<Option<String>>,
}

impl Registry {
    fn new(reference: &Reference) -> Registry {
        Registry {
            agent: fetch::agent(),
            reference: reference.clone(),
            token: Mutex::new(None),
        }
    }

    fn url(&self, kind: &str, name: &str) -> String {
        let scheme = if self.reference.registry.starts_with("localhost") {
            "http"
        } else {
            "https"
        };
        format!(
            "{scheme}://{}/v2/{}/{kind}/{name}",
            self.reference.registry, self.reference.repository
        )
    }

    fn auth_headers(&self) -> Vec<(&'static str, String)> {
        match self.token.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            Some(token) => vec![("Authorization", format!("Bearer {token}"))],
            None => Vec::new(),
        }
    }

    /// Ask the challenge's realm for a pull token.
    fn authenticate(&self, challenge: &str) -> Result<(), String> {
        let pairs = bearer_challenge(challenge).ok_or_else(|| {
            format!("the registry asked for credentials this cannot give ({challenge})")
        })?;
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value.clone())
        };
        let realm = get("realm").ok_or("the registry's challenge names no realm")?;
        let scope = get("scope")
            .unwrap_or_else(|| format!("repository:{}:pull", self.reference.repository));
        let mut request = self.agent.get(&realm).query("scope", &scope);
        if let Some(service) = get("service") {
            request = request.query("service", &service);
        }
        let mut response = request
            .call()
            .map_err(|error| format!("could not get a pull token from {realm}: {error}"))?;
        let body: serde_json::Value = serde_json::from_slice(
            &response
                .body_mut()
                .read_to_vec()
                .map_err(|error| format!("could not read the pull token: {error}"))?,
        )
        .map_err(|error| format!("the pull token was not JSON: {error}"))?;
        let token = body["token"]
            .as_str()
            .or_else(|| body["access_token"].as_str())
            .ok_or("the registry's token answer had no token")?
            .to_string();
        *self.token.lock().unwrap_or_else(|p| p.into_inner()) = Some(token);
        Ok(())
    }

    /// GET a small document (a manifest), authenticating once when the registry asks.
    fn document(&self, url: &str) -> Result<Document, String> {
        for attempt in 0..2 {
            let mut request = self
                .agent
                .get(url)
                .header("Accept", MANIFEST_ACCEPT)
                .config()
                .http_status_as_error(false)
                .build();
            for (name, value) in self.auth_headers() {
                request = request.header(name, value);
            }
            let mut response = request.call().map_err(|error| format!("{url}: {error}"))?;
            let status = response.status().as_u16();
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
            };
            if status == 401 && attempt == 0 {
                let challenge = header("www-authenticate").unwrap_or_default();
                self.authenticate(&challenge)?;
                continue;
            }
            if status != 200 {
                return Err(format!("{url} answered {status}"));
            }
            let media_type = header("content-type");
            let digest = header("docker-content-digest");
            let bytes = response
                .body_mut()
                .read_to_vec()
                .map_err(|error| format!("could not read {url}: {error}"))?;
            return Ok(Document {
                bytes,
                media_type,
                digest,
            });
        }
        Err(format!("{url} refused the pull token it issued"))
    }

    /// The manifest of this machine's platform under the reference's tag.
    fn resolve(&self) -> Result<Plan, String> {
        let Document {
            bytes,
            media_type,
            digest,
        } = self.document(&self.url("manifests", &self.reference.tag))?;
        let document: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("the manifest was not JSON: {error}"))?;
        let media_type = document["mediaType"]
            .as_str()
            .map(str::to_string)
            .or(media_type)
            .unwrap_or_default();
        if document["manifests"].is_array() {
            let arch = platform_arch();
            let chosen = document["manifests"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|entry| {
                    entry["platform"]["os"] == "linux" && entry["platform"]["architecture"] == arch
                })
                .ok_or_else(|| format!("the image has no linux/{arch} build"))?;
            let digest = chosen["digest"]
                .as_str()
                .ok_or("the index lists a manifest without a digest")?;
            let Document {
                bytes,
                media_type: served_type,
                ..
            } = self.document(&self.url("manifests", digest))?;
            let media_type = chosen["mediaType"]
                .as_str()
                .map(str::to_string)
                .or(served_type)
                .unwrap_or_default();
            return plan_from(&bytes, &media_type, digest);
        }
        let digest = digest.unwrap_or_else(|| format!("sha256:{}", sha256_hex(&bytes)));
        plan_from(&bytes, &media_type, &digest)
    }

    /// One blob into the cache, resumed if a part is there, checked against its digest before it counts.
    fn blob(&self, dir: &Path, blob: &Descriptor, read: &AtomicU64) -> Result<(), String> {
        let path = blob_path(dir, &blob.digest);
        if path.exists() {
            read.store(blob.size, Ordering::Relaxed);
            return Ok(());
        }
        let url = self.url("blobs", &blob.digest);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let result = fetch::resumable(
                &self.agent,
                &url,
                &self.auth_headers(),
                &path,
                true,
                &mut |have, _| read.store(have, Ordering::Relaxed),
            );
            match result {
                Ok(()) => break,
                // A long fetch outlives an anonymous token (they last minutes): one fresh token, then the blob again.
                Err(error) if error.contains("401") && attempt == 1 => {
                    self.document(&self.url("manifests", &self.reference.tag))?;
                }
                Err(error) if attempt < 3 => {
                    crate::ui::note(&format!("a layer download broke ({error}); retrying"));
                    std::thread::sleep(Duration::from_secs(3 * attempt));
                }
                Err(error) => return Err(error),
            }
        }
        let actual = file_sha256(&path)?;
        if actual != blob.digest {
            let _ = std::fs::remove_file(&path);
            return Err(format!(
                "a layer arrived damaged ({} came back as {actual}); trying again starts it over",
                blob.digest
            ));
        }
        Ok(())
    }
}

/// A manifest's own bytes, read for what it lists.
pub fn plan_from(bytes: &[u8], media_type: &str, digest: &str) -> Result<Plan, String> {
    let actual = format!("sha256:{}", sha256_hex(bytes));
    if actual != digest {
        return Err(format!(
            "the manifest does not match its digest ({digest}, got {actual})"
        ));
    }
    #[derive(Deserialize)]
    struct Manifest {
        config: Descriptor,
        layers: Vec<Descriptor>,
    }
    let manifest: Manifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("the manifest could not be read: {error}"))?;
    Ok(Plan {
        manifest: Descriptor {
            media_type: if media_type.is_empty() {
                "application/vnd.oci.image.manifest.v1+json".to_string()
            } else {
                media_type.to_string()
            },
            digest: digest.to_string(),
            size: bytes.len() as u64,
        },
        manifest_bytes: bytes.to_vec(),
        config: manifest.config,
        layers: manifest.layers,
    })
}

fn write_state(dir: &Path, state: &State) {
    if let Ok(text) = serde_json::to_string(state) {
        let temporary = dir.join("state.json.tmp");
        if std::fs::write(&temporary, text).is_ok() {
            let _ = std::fs::rename(&temporary, dir.join("state.json"));
        }
    }
}

pub fn read_state(dir: &Path) -> Option<State> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("state.json")).ok()?).ok()
}

/// The lock a fetching process holds. Released when the file is dropped, by the OS itself if the process dies.
fn try_lock(dir: &Path) -> Result<Option<File>, String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("lock"))
        .map_err(|error| format!("could not open the cache's lock: {error}"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => {
            Err(format!("could not lock the cache: {error}"))
        }
    }
}

/// Fetch everything `plan` lists that the cache does not hold yet, `PARALLEL` at a time, calling `progress(done, total)`
/// about once a second from this thread. The caller holds the lock.
fn fetch_all(
    registry: &Arc<Registry>,
    dir: &Path,
    plan: &Plan,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    std::fs::create_dir_all(dir.join("blobs").join("sha256"))
        .map_err(|error| format!("could not create the cache: {error}"))?;
    std::fs::write(blob_path(dir, &plan.manifest.digest), &plan.manifest_bytes)
        .map_err(|error| format!("could not write the manifest: {error}"))?;
    let mut blobs = vec![plan.config.clone()];
    blobs.extend(plan.layers.iter().cloned());
    // Largest first, so the long poles start early and the last minute is not one 400 MB layer on one connection.
    blobs.sort_by_key(|blob| std::cmp::Reverse(blob.size));
    let counters: Arc<Vec<AtomicU64>> = Arc::new(
        blobs
            .iter()
            .map(|blob| {
                AtomicU64::new(fetch::on_disk(&blob_path(dir, &blob.digest)).min(blob.size))
            })
            .collect(),
    );
    let queue = Arc::new(Mutex::new((0..blobs.len()).collect::<Vec<usize>>()));
    let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let blobs = Arc::new(blobs);
    let total = plan.total();
    let mut workers = Vec::new();
    for _ in 0..PARALLEL {
        let (registry, queue, failure, blobs, counters, dir) = (
            registry.clone(),
            queue.clone(),
            failure.clone(),
            blobs.clone(),
            counters.clone(),
            dir.to_path_buf(),
        );
        workers.push(std::thread::spawn(move || loop {
            if failure.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
                return;
            }
            let next = {
                let mut queue = queue.lock().unwrap_or_else(|p| p.into_inner());
                if queue.is_empty() {
                    return;
                }
                queue.remove(0)
            };
            if let Err(error) = registry.blob(&dir, &blobs[next], &counters[next]) {
                *failure.lock().unwrap_or_else(|p| p.into_inner()) = Some(error);
                return;
            }
        }));
    }
    let done = || {
        counters
            .iter()
            .map(|counter| counter.load(Ordering::Relaxed))
            .sum::<u64>()
    };
    while workers.iter().any(|worker| !worker.is_finished()) {
        progress(done().min(total), total);
        std::thread::sleep(Duration::from_millis(500));
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(500)
            && workers.iter().any(|w| !w.is_finished())
        {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    for worker in workers {
        let _ = worker.join();
    }
    if let Some(error) = failure.lock().unwrap_or_else(|p| p.into_inner()).take() {
        return Err(error);
    }
    progress(total, total);
    Ok(())
}

/// Whether every blob `plan` lists is in the cache.
fn complete(dir: &Path, plan: &Plan) -> bool {
    std::iter::once(&plan.config)
        .chain(plan.layers.iter())
        .all(|blob| blob_path(dir, &blob.digest).exists())
}

/// The plan the cache already holds, from its own state and manifest blob: what a load uses when the registry cannot
/// be reached any more (the PC is offline now, the fetch was finished before).
fn cached_plan(dir: &Path) -> Option<Plan> {
    let state = read_state(dir)?;
    let bytes = std::fs::read(blob_path(dir, &state.manifest_digest)).ok()?;
    plan_from(&bytes, "", &state.manifest_digest).ok()
}

/// Resolve and fetch, with the lock held, keeping `state.json` current.
fn fetch_locked(
    reference: &Reference,
    dir: &Path,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Plan, String> {
    let registry = Arc::new(Registry::new(reference));
    let plan = match registry.resolve() {
        Ok(plan) => plan,
        Err(error) => match cached_plan(dir).filter(|plan| complete(dir, plan)) {
            Some(plan) => return Ok(plan),
            None => return Err(error),
        },
    };
    let mut state = State {
        reference: reference.full(),
        manifest_digest: plan.manifest.digest.clone(),
        done: 0,
        total: plan.total(),
        state: "fetching".to_string(),
    };
    write_state(dir, &state);
    let mut last_written = Instant::now() - Duration::from_secs(10);
    fetch_all(&registry, dir, &plan, &mut |done, total| {
        progress(done, total);
        if last_written.elapsed() >= Duration::from_secs(1) {
            last_written = Instant::now();
            state.done = done;
            write_state(dir, &state);
        }
    })?;
    state.done = state.total;
    state.state = "ready".to_string();
    write_state(dir, &state);
    Ok(plan)
}

/* `ic image prefetch` */

/// The marker the desktop app reads (`intentic-prefetch: {...}`), one JSON object per line.
fn marker(state: &str, done: u64, total: u64) -> String {
    serde_json::json!({ "state": state, "done": done, "total": total }).to_string()
}

/// Whether Docker Desktop (or a docker CLI) is installed here, engine running or not. On a PC that has it, Docker pulls
/// the image itself as soon as its engine is up, and very likely has it already: fetching 1.8 GB ahead there is waste.
fn docker_installed() -> bool {
    #[cfg(windows)]
    {
        crate::docker::program_folder("").is_some() || crate::docker::cli_present()
    }
    #[cfg(not(windows))]
    {
        crate::docker::cli_present()
    }
}

/// Every cache under the root that nobody has written for [`STALE`] and nobody holds: a setup that stopped, was moved
/// elsewhere, or pulled instead. Best effort, and never one that is locked.
fn sweep_stale(except: &Path) {
    let Some(root) = except.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if dir == except || !dir.is_dir() {
            continue;
        }
        let touched = std::fs::metadata(dir.join("state.json"))
            .or_else(|_| std::fs::metadata(&dir))
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok());
        if touched.is_some_and(|age| age > STALE) {
            if let Ok(Some(lock)) = try_lock(&dir) {
                drop(lock);
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }
}

/// Drop what was fetched ahead for `image` once Docker has the image by another way (a pull, or a copy it already
/// held): 1.8 GB that nothing will read again. Left alone while a prefetch holds it.
pub fn discard(image: &str) {
    let Some(dir) = Reference::parse(image).and_then(|reference| dir_for(&reference)) else {
        return;
    };
    if !dir.exists() {
        return;
    }
    if let Ok(Some(lock)) = try_lock(&dir) {
        drop(lock);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

pub fn prefetch(image: &str) -> crate::util::Result<()> {
    let say = |state: &str, done: u64, total: u64| {
        println!("intentic-prefetch: {}", marker(state, done, total))
    };
    let Some(reference) = Reference::parse(image) else {
        crate::util::bail!("{image} is not an image this can fetch ahead (it needs a registry and a tag); the setup will pull it instead.");
    };
    if crate::docker::daemon_refusal().is_none() && crate::docker::image_exists(image) {
        say("ready", 0, 0);
        return Ok(());
    }
    let Some(dir) = dir_for(&reference) else {
        crate::util::bail!("could not find this account's home folder to keep the image in.");
    };
    sweep_stale(&dir);
    // Worth it only where Docker is still to come: a PC with Docker installed pulls when its engine is up. A fetch an
    // earlier run started (before the restart that installed Docker) is still carried on with.
    if read_state(&dir).is_none() && docker_installed() {
        say("skipped", 0, 0);
        return Ok(());
    }
    let Some(_lock) = try_lock(&dir).map_err(crate::util::Fail)? else {
        // Another prefetch (or a connect run finishing one) holds it: that one is doing this work already.
        say("elsewhere", 0, 0);
        return Ok(());
    };
    let started = Instant::now();
    let mut told = Instant::now() - Duration::from_secs(10);
    let mut attempt = 0;
    loop {
        attempt += 1;
        let result = fetch_locked(&reference, &dir, &mut |done, total| {
            if told.elapsed() >= Duration::from_secs(2) {
                told = Instant::now();
                say("fetching", done, total);
            }
        });
        match result {
            Ok(plan) => {
                say("ready", plan.total(), plan.total());
                crate::ui::note(&format!(
                    "fetched {} MB of {} in {}s",
                    plan.total() / (1024 * 1024),
                    reference.full(),
                    started.elapsed().as_secs()
                ));
                return Ok(());
            }
            Err(error) if attempt < 4 => {
                crate::ui::note(&format!("the prefetch stopped ({error}); trying again"));
                std::thread::sleep(Duration::from_secs(10 * attempt));
            }
            Err(error) => {
                say("failed", 0, 0);
                crate::util::bail!("could not fetch {} ahead: {error}", reference.full());
            }
        }
    }
}

/// `ic image load`: the cache into Docker now, with a verdict a person can read. Support's way to finish a prefetch by
/// hand, and the way a test proves the archive loads without standing a whole sandbox up.
pub fn load_now(image: &str) -> crate::util::Result<()> {
    if let Some(refusal) = crate::docker::daemon_refusal() {
        crate::util::bail!(
            "Docker's engine is not answering ({refusal}); start Docker and try again."
        );
    }
    let log = crate::logfile::Log::create("image-load")?;
    let started = Instant::now();
    match load_if_cached(image, &log) {
        Cached::Loaded => {
            crate::ui::note(&format!(
                "{image} is in Docker now, loaded from the prefetched cache in {}s.",
                started.elapsed().as_secs()
            ));
            Ok(())
        }
        Cached::Nothing => {
            crate::util::bail!("nothing was prefetched for {image}; run `ic image prefetch` first.")
        }
        Cached::Failed(why) => {
            crate::util::bail!("the prefetched {image} could not be loaded: {why}")
        }
    }
}

/* `ic sandbox connect`, AT THE PULL */

/// What the cache did for a connect run's pull.
pub enum Cached {
    /// The image is in Docker now, from the cache.
    Loaded,
    /// Nothing was fetched ahead for this image: pull as always.
    Nothing,
    /// Something was, and it did not work out: pull, saying why.
    Failed(String),
}

/// If a prefetch ran for `image`, finish it (waiting for one still running) and load the result into Docker.
pub fn load_if_cached(image: &str, log: &crate::logfile::Log) -> Cached {
    let Some(reference) = Reference::parse(image) else {
        return Cached::Nothing;
    };
    let Some(dir) = dir_for(&reference) else {
        return Cached::Nothing;
    };
    sweep_stale(&dir);
    if read_state(&dir).is_none() {
        return Cached::Nothing;
    }
    crate::util::step(
        "pulling-image",
        &format!("using the sandbox image downloaded ahead of time ({image})..."),
    );
    match finish_and_load(&reference, &dir, image, log) {
        Ok(()) => {
            // The image is Docker's now; its 1.8 GB here would only be a second copy.
            let _ = std::fs::remove_dir_all(&dir);
            Cached::Loaded
        }
        Err(error) => Cached::Failed(error),
    }
}

fn mb(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

fn finish_and_load(
    reference: &Reference,
    dir: &Path,
    image: &str,
    log: &crate::logfile::Log,
) -> Result<(), String> {
    // A prefetch still running holds the lock: watch it rather than race it, and stop trusting it if it stalls.
    let mut watched = (0u64, Instant::now());
    let lock = loop {
        if let Some(lock) = try_lock(dir)? {
            break lock;
        }
        let state = read_state(dir).unwrap_or_default();
        if state.done > watched.0 {
            watched = (state.done, Instant::now());
        } else if watched.1.elapsed() > STALL {
            return Err(
                "the image download running in the background stopped making progress".to_string(),
            );
        }
        if state.total > 0 {
            crate::ui::progress(&format!(
                "downloading the sandbox image: {} of {} MB",
                mb(state.done),
                mb(state.total)
            ));
        }
        std::thread::sleep(Duration::from_secs(2));
    };
    let started = Instant::now();
    let mut told = Instant::now() - Duration::from_secs(10);
    let plan = fetch_locked(reference, dir, &mut |done, total| {
        if told.elapsed() >= Duration::from_secs(2) {
            told = Instant::now();
            let rate = done as f64 / started.elapsed().as_secs_f64().max(1.0);
            crate::ui::progress(&format!(
                "downloading the sandbox image: {} of {} MB ({:.1} MB/s)",
                mb(done),
                mb(total),
                rate / (1024.0 * 1024.0)
            ));
        }
    })?;
    crate::ui::progress("loading the downloaded image into Docker...");
    load(dir, &plan, reference, image, log)?;
    drop(lock);
    Ok(())
}

/* INTO DOCKER — an archive both of Docker's image stores read, streamed rather than written out a second time. */

/// The archive's three small documents: `oci-layout`, `index.json` (what the containerd image store reads, naming the
/// image by annotation) and `manifest.json` (what the classic store reads, naming it by RepoTags).
pub fn archive_documents(plan: &Plan, reference: &Reference) -> Vec<(String, Vec<u8>)> {
    let blob = |digest: &str| format!("blobs/sha256/{}", digest.trim_start_matches("sha256:"));
    let index = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{
            "mediaType": plan.manifest.media_type,
            "digest": plan.manifest.digest,
            "size": plan.manifest.size,
            "annotations": {
                "io.containerd.image.name": reference.full(),
                "org.opencontainers.image.ref.name": reference.tag,
            },
        }],
    });
    let legacy = serde_json::json!([{
        "Config": blob(&plan.config.digest),
        "RepoTags": [reference.full()],
        "Layers": plan.layers.iter().map(|layer| blob(&layer.digest)).collect::<Vec<_>>(),
    }]);
    vec![
        (
            "oci-layout".to_string(),
            br#"{"imageLayoutVersion":"1.0.0"}"#.to_vec(),
        ),
        ("index.json".to_string(), index.to_string().into_bytes()),
        ("manifest.json".to_string(), legacy.to_string().into_bytes()),
    ]
}

/// One ustar header. Names here are at most `blobs/sha256/<64 hex>`, well inside ustar's 100 bytes, and sizes inside
/// its 8 GiB; anything else is refused rather than written wrong.
pub fn tar_header(name: &str, size: u64, directory: bool) -> Result<[u8; 512], String> {
    if name.len() > 100 {
        return Err(format!("{name} is too long for the archive"));
    }
    if size >= 8 * 1024 * 1024 * 1024 {
        return Err(format!("{name} is too large for the archive"));
    }
    let mut header = [0u8; 512];
    let mut put = |at: usize, bytes: &[u8]| header[at..at + bytes.len()].copy_from_slice(bytes);
    put(0, name.as_bytes());
    put(
        100,
        if directory {
            b"0000755\0"
        } else {
            b"0000644\0"
        },
    );
    put(108, b"0000000\0");
    put(116, b"0000000\0");
    put(124, format!("{size:011o}\0").as_bytes());
    put(136, b"00000000000\0");
    put(148, b"        ");
    put(156, if directory { b"5" } else { b"0" });
    put(257, b"ustar\0");
    put(263, b"00");
    let sum: u32 = header.iter().map(|byte| *byte as u32).sum();
    header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    Ok(header)
}

fn write_entry(
    out: &mut dyn Write,
    name: &str,
    size: u64,
    body: &mut dyn Read,
) -> Result<(), String> {
    let io = |error: std::io::Error| format!("could not hand the image to Docker: {error}");
    out.write_all(&tar_header(name, size, false)?).map_err(io)?;
    let copied = std::io::copy(body, out).map_err(io)?;
    if copied != size {
        return Err(format!("{name} changed size while it was being loaded"));
    }
    let pad = (512 - (size % 512) as usize) % 512;
    out.write_all(&vec![0u8; pad]).map_err(io)
}

/// The whole archive, into `out`.
pub fn write_archive(
    out: &mut dyn Write,
    dir: &Path,
    plan: &Plan,
    reference: &Reference,
) -> Result<(), String> {
    let io = |error: std::io::Error| format!("could not hand the image to Docker: {error}");
    for (name, bytes) in archive_documents(plan, reference) {
        write_entry(out, &name, bytes.len() as u64, &mut bytes.as_slice())?;
    }
    for directory in ["blobs/", "blobs/sha256/"] {
        out.write_all(&tar_header(directory, 0, true)?)
            .map_err(io)?;
    }
    let manifest = format!(
        "blobs/sha256/{}",
        plan.manifest.digest.trim_start_matches("sha256:")
    );
    write_entry(
        out,
        &manifest,
        plan.manifest_bytes.len() as u64,
        &mut plan.manifest_bytes.as_slice(),
    )?;
    for blob in std::iter::once(&plan.config).chain(plan.layers.iter()) {
        let path = blob_path(dir, &blob.digest);
        let mut file = File::open(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        let name = format!("blobs/sha256/{}", blob.digest.trim_start_matches("sha256:"));
        write_entry(out, &name, blob.size, &mut file)?;
    }
    out.write_all(&[0u8; 1024]).map_err(io)
}

/// `docker load`, fed the archive, then the tag made certain: a store that loaded the image without the name it was
/// given (`Loaded image ID: sha256:...`) gets it from `docker tag`.
fn load(
    dir: &Path,
    plan: &Plan,
    reference: &Reference,
    image: &str,
    log: &crate::logfile::Log,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    log.section(&format!(
        "docker load ({} from the prefetched cache)",
        reference.full()
    ));
    let mut child = Command::new("docker")
        .args(["load"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not run docker load: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("docker load took no input")?;
    let written = {
        let mut buffered = std::io::BufWriter::with_capacity(1024 * 1024, &mut stdin);
        write_archive(&mut buffered, dir, plan, reference).and_then(|()| {
            buffered
                .flush()
                .map_err(|error| format!("could not hand the image to Docker: {error}"))
        })
    };
    drop(stdin);
    let output = child
        .wait_with_output()
        .map_err(|error| format!("docker load did not finish: {error}"))?;
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    log.write(said.as_bytes());
    written?;
    if !output.status.success() {
        return Err(format!(
            "docker load refused the downloaded image: {}",
            said.trim()
        ));
    }
    if !crate::docker::image_exists(image) {
        let id = said
            .lines()
            .find_map(|line| line.trim().strip_prefix("Loaded image ID: "))
            .map(str::trim)
            .ok_or_else(|| format!("docker load did not say what it loaded: {}", said.trim()))?;
        let tagged = Command::new("docker")
            .args(["tag", id, image])
            .output()
            .map_err(|error| format!("could not run docker tag: {error}"))?;
        if !tagged.status.success() || !crate::docker::image_exists(image) {
            return Err(format!(
                "docker loaded the image but would not name it {image}: {}",
                String::from_utf8_lossy(&tagged.stderr).trim()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_is_taken_apart_only_when_it_names_a_registry_and_a_tag() {
        assert_eq!(
            Reference::parse("ghcr.io/intentic/sandbox:stable"),
            Some(Reference {
                registry: "ghcr.io".into(),
                repository: "intentic/sandbox".into(),
                tag: "stable".into()
            })
        );
        assert_eq!(
            Reference::parse("localhost:5000/sandbox").map(|r| (r.registry, r.tag)),
            Some(("localhost:5000".into(), "latest".into()))
        );
        // Docker Hub and local builds, and a pinned digest: docker pull's, as before.
        assert_eq!(Reference::parse("intentic-sandbox:dev"), None);
        assert_eq!(Reference::parse("library/ubuntu:24.04"), None);
        assert_eq!(
            Reference::parse("ghcr.io/intentic/sandbox@sha256:abc"),
            None
        );
        assert_eq!(
            Reference::parse("ghcr.io/intentic/sandbox:stable")
                .unwrap()
                .slug(),
            "ghcr.io_intentic_sandbox_stable"
        );
    }

    #[test]
    fn a_registry_challenge_is_read_for_its_realm_service_and_scope() {
        let pairs = bearer_challenge(
            r#"Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:intentic/sandbox:pull""#,
        )
        .unwrap();
        assert_eq!(
            pairs,
            vec![
                ("realm".to_string(), "https://ghcr.io/token".to_string()),
                ("service".to_string(), "ghcr.io".to_string()),
                (
                    "scope".to_string(),
                    "repository:intentic/sandbox:pull".to_string()
                ),
            ]
        );
        assert_eq!(bearer_challenge("Basic realm=\"x\""), None);
        assert_eq!(
            bearer_challenge("Bearer realm=https://r/t, service=s").unwrap()[1],
            ("service".to_string(), "s".to_string())
        );
    }

    fn plan() -> Plan {
        let manifest = br#"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:cccc","size":3},"layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"sha256:aaaa","size":5},{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"sha256:bbbb","size":700}]}"#;
        let digest = format!("sha256:{}", sha256_hex(manifest));
        plan_from(
            manifest,
            "application/vnd.oci.image.manifest.v1+json",
            &digest,
        )
        .unwrap()
    }

    #[test]
    fn a_manifest_is_believed_only_when_it_matches_its_digest() {
        let plan = plan();
        assert_eq!(plan.layers.len(), 2);
        assert_eq!(plan.total(), 708);
        assert!(plan_from(&plan.manifest_bytes, "", "sha256:0000").is_err());
    }

    /* Both of Docker's stores have to find the image, and find it under its name. */
    #[test]
    fn the_archive_names_the_image_for_both_of_dockers_stores() {
        let reference = Reference::parse("ghcr.io/intentic/sandbox:stable").unwrap();
        let documents = archive_documents(&plan(), &reference);
        let get = |name: &str| -> serde_json::Value {
            serde_json::from_slice(&documents.iter().find(|(n, _)| n == name).unwrap().1).unwrap()
        };
        let index = get("index.json");
        assert_eq!(
            index["manifests"][0]["annotations"]["io.containerd.image.name"],
            "ghcr.io/intentic/sandbox:stable"
        );
        assert_eq!(
            index["manifests"][0]["digest"],
            plan().manifest.digest.as_str()
        );
        let legacy = get("manifest.json");
        assert_eq!(legacy[0]["RepoTags"][0], "ghcr.io/intentic/sandbox:stable");
        assert_eq!(legacy[0]["Config"], "blobs/sha256/cccc");
        assert_eq!(legacy[0]["Layers"][1], "blobs/sha256/bbbb");
        assert_eq!(get("oci-layout")["imageLayoutVersion"], "1.0.0");
    }

    /* The archive is hand-written, so it is read back by a real tar to prove it is one. */
    #[test]
    fn the_archive_is_a_tar_that_tar_itself_reads() {
        let dir = tempfile::tempdir().unwrap();
        let plan = plan();
        std::fs::create_dir_all(dir.path().join("blobs/sha256")).unwrap();
        for (digest, size) in [("cccc", 3usize), ("aaaa", 5), ("bbbb", 700)] {
            std::fs::write(
                dir.path().join("blobs/sha256").join(digest),
                vec![b'x'; size],
            )
            .unwrap();
        }
        let reference = Reference::parse("ghcr.io/intentic/sandbox:stable").unwrap();
        let mut archive = Vec::new();
        write_archive(&mut archive, dir.path(), &plan, &reference).unwrap();
        assert_eq!(archive.len() % 512, 0);
        let out = tempfile::tempdir().unwrap();
        let tar_file = out.path().join("image.tar");
        std::fs::write(&tar_file, &archive).unwrap();
        let listed = std::process::Command::new("tar")
            .arg("-tvf")
            .arg(&tar_file)
            .output()
            .unwrap();
        assert!(
            listed.status.success(),
            "{}",
            String::from_utf8_lossy(&listed.stderr)
        );
        let text = String::from_utf8_lossy(&listed.stdout);
        for name in [
            "oci-layout",
            "index.json",
            "manifest.json",
            "blobs/sha256/bbbb",
        ] {
            assert!(text.contains(name), "{name} missing from:\n{text}");
        }
        let extracted = std::process::Command::new("tar")
            .arg("-xf")
            .arg(&tar_file)
            .arg("-C")
            .arg(out.path())
            .output()
            .unwrap();
        assert!(extracted.status.success());
        assert_eq!(
            std::fs::read(out.path().join("blobs/sha256/bbbb")).unwrap(),
            vec![b'x'; 700]
        );
        assert_eq!(
            std::fs::read(
                out.path()
                    .join("blobs/sha256")
                    .join(plan.manifest.digest.trim_start_matches("sha256:"))
            )
            .unwrap(),
            plan.manifest_bytes
        );
    }

    #[test]
    fn the_header_refuses_what_ustar_cannot_hold() {
        assert!(tar_header(&"x".repeat(101), 1, false).is_err());
        assert!(tar_header("big", 8 * 1024 * 1024 * 1024, false).is_err());
        let header = tar_header("index.json", 1234, false).unwrap();
        assert_eq!(&header[124..136], b"00000002322\0");
        assert_eq!(&header[257..263], b"ustar\0");
    }

    #[test]
    fn the_prefetch_marker_is_one_json_object() {
        let line = marker("fetching", 10, 20);
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["state"], "fetching");
        assert_eq!(value["done"], 10);
        assert_eq!(value["total"], 20);
    }

    /// What was fetched ahead goes once Docker has the image another way, and abandoned caches go after two weeks;
    /// one a fetcher holds is never pulled from under it.
    #[test]
    fn a_cache_nobody_will_read_is_removed_and_a_held_one_is_not() {
        let root = tempfile::tempdir().unwrap();
        let fresh = root.path().join("ghcr.io_intentic_sandbox_stable");
        let old = root.path().join("ghcr.io_intentic_sandbox_beta");
        let held = root.path().join("ghcr.io_intentic_sandbox_edge");
        for dir in [&fresh, &old, &held] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("state.json"), "{}").unwrap();
        }
        let long_ago = std::time::SystemTime::now() - STALE - Duration::from_secs(60);
        for dir in [&old, &held] {
            std::fs::File::options()
                .write(true)
                .open(dir.join("state.json"))
                .unwrap()
                .set_modified(long_ago)
                .unwrap();
        }
        let holding = try_lock(&held).unwrap().expect("lock");
        sweep_stale(&fresh);
        assert!(fresh.exists(), "the cache in use is not swept");
        assert!(!old.exists(), "an abandoned one is");
        assert!(held.exists(), "one a fetcher holds is not, however old");
        drop(holding);
    }

    #[test]
    fn a_second_fetcher_finds_the_cache_taken() {
        let dir = tempfile::tempdir().unwrap();
        let first = try_lock(dir.path()).unwrap();
        assert!(first.is_some());
        // File locks are per open file description, so a second open in the same process stands in for a second process.
        assert!(try_lock(dir.path()).unwrap().is_none());
        drop(first);
        assert!(try_lock(dir.path()).unwrap().is_some());
    }
}
