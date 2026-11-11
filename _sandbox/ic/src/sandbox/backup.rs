use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use crate::checks;
use crate::docker;
use crate::logfile::{intentic_home, Log};
use crate::record::{self, Phase};
use crate::sandbox::at_rest;
use crate::sandbox::backup_repo::{self, Location};
use crate::sandbox::backup_seal::{self, KeyPlan, TargetKey};
use crate::sandbox::inside::{self, Read};
use crate::sandbox::lock::{self, Wait};
use crate::sandbox::side::{self, Side, Unattended};
use crate::sandbox::{container_of, now_ms, parked_of, resolve_slug};
use crate::util::{bail, Fail, Result};

/* BACKUPS THAT OUTLIVE DOCKER.

Everything a sandbox holds lives in two Docker volumes, and so did every safety net until now: the workspace timeline,
the conversion journal's pre-images, the parked container. Docker Desktop's "Purge data", a lost WSL disk image or a
`docker system prune --volumes` takes all of them at once. `ic sandbox backup` copies the sandbox's /work and /history
into a restic repository on this machine's own disk, outside Docker (`~/.intentic/backups/<slug>/repo`): incremental,
deduplicated, and encrypted with a key kept apart from it (`~/.intentic/keys/backup-<slug>.key`), so the repository
alone reveals nothing, secrets included, to whatever else reads or syncs that folder. restic runs in its own pinned
image (the deploy engine's, _deploy/state-resolver/src/lib/images.ts), so nothing is installed on the host.

Since 2026-11-11 a backup is self-contained: each snapshot also carries the sandbox's at-rest key, sealed under the backup
password (backup_seal.rs), so the repository and its key are all a restore on another machine, or into another sandbox,
needs. And the repository may live elsewhere: a folder or a restic URL saved per sandbox (backup_repo.rs). */

const RESTIC_IMAGE: &str =
    "restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510";

/// A background run skips a sandbox whose last full backup is younger than this.
const AUTO_EVERY: Duration = Duration::from_secs(20 * 60 * 60);
/// A backup of a large workspace takes a while the first time; past this something is wrong.
const LIMIT: Duration = Duration::from_secs(3 * 60 * 60);

/// Where a consistent copy of the conversation database is taken while the daemon runs (see `stage_database`).
const STAGED_DB: &str = "/history/.ic/backup/conversations.db";

/// What a backup covers. `State` is the quick one taken before every swap: the daemon's own files and the
/// conversation database, which is what an update converts, without the worktrees and caches.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Full,
    State,
}

/// Rebuildable or regrowable, and some of it large: never worth a backup's time or disk.
const ALWAYS_EXCLUDED: [&str; 12] = [
    "node_modules",
    ".venv",
    "__pycache__",
    "/src/work/.intentic/local/cache",
    "/src/work/.intentic/local/tmp",
    "/src/history/engines",
    "/src/history/said-index",
    "/src/history/logs",
    "/src/history/offload",
    "/src/history/overlays",
    "/src/history/.pnpm-store",
    "/src/history/.ic/backup-restore",
];

/// Also left out of the quick pre-update backup: the big stores an update does not convert.
const STATE_EXCLUDED: [&str; 8] = [
    "/src/history/conversations",
    "/src/history/worktrees",
    "/src/history/gits",
    "/src/history/scopes",
    "/src/history/blobs",
    "/src/history/backups",
    "/src/history/trash",
    "/src/history/exports",
];

pub fn backups_dir(slug: &str) -> PathBuf {
    intentic_home().join("backups").join(slug)
}

pub fn repo_dir(slug: &str) -> PathBuf {
    backups_dir(slug).join("repo")
}

pub fn key_path(slug: &str) -> PathBuf {
    intentic_home()
        .join("keys")
        .join(format!("backup-{slug}.key"))
}

fn last_path(slug: &str) -> PathBuf {
    backups_dir(slug).join("last-full-backup")
}

/// 32 bytes from the operating system's random source, as hex: the backup password's format since the first backup.
/// (Until 2026-11-11 it was hashed out of the standard library's hasher seeds, which are random but no CSPRNG; keys
/// made that way keep working, since restic only ever reads the file.)
fn random_hex() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|err| {
        Fail(format!(
            "the operating system gave no random bytes for a backup key ({err}). Nothing was changed."
        ))
    })?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The sandbox's backup key, made once and kept readable by this user alone. Losing it loses the backups, so it is
/// named when it is made; it never enters the repository it opens.
fn ensure_key(slug: &str) -> Result<PathBuf> {
    let path = key_path(slug);
    if path.exists() {
        return Ok(path);
    }
    let dir = path.parent().expect("key path has a parent");
    std::fs::create_dir_all(dir)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    std::io::Write::write_all(&mut file, random_hex()?.as_bytes())?;
    file.sync_all()?;
    crate::ui::note(&format!(
        "Made the backup key for {slug}: {}. Keep it with the backups: they cannot be read without it.",
        path.display()
    ));
    Ok(path)
}

/// The volumes a backup reads: what the sandbox's container (live or parked) mounts, else the names the run contract
/// gives them, when docker has them.
fn sources(slug: &str) -> (Option<String>, Option<String>) {
    for container in [container_of(slug), parked_of(slug)] {
        if docker::container_exists(&container) {
            return (
                docker::mount_source(&container, "/work"),
                docker::mount_source(&container, "/history"),
            );
        }
    }
    let named = |name: String| docker::ok(&["volume", "inspect", &name]).then_some(name);
    (
        named(format!("intentic-workspace-{slug}")),
        named(format!("intentic-history-{slug}")),
    )
}

/// A consistent copy of `conversations.db` taken beside it while the daemon writes to it (SQLite's VACUUM INTO reads
/// one snapshot of the database), so the backup never holds a database file and a write-ahead log from two moments.
/// False when the container is not running, in which case nothing writes and the files are backed up as they are.
fn stage_database(container: &str) -> bool {
    if docker::inspect(container, "{{.State.Running}}").as_deref() != Some("true") {
        return false;
    }
    let script = format!(
        "const {{DatabaseSync}}=require('node:sqlite');const fs=require('node:fs');fs.mkdirSync('/history/.ic/backup',{{recursive:true}});fs.rmSync('{STAGED_DB}',{{force:true}});const db=new DatabaseSync('/history/conversations.db');db.exec('PRAGMA busy_timeout=10000');db.exec(\"VACUUM INTO '{STAGED_DB}'\");db.close();"
    );
    docker::exec_ok(container, &["node", "-e", &script])
}

/// The owner of this user's files, for the repository restic (running as root to read the volumes) writes: a backup
/// this user cannot delete without sudo would be a disk they cannot get back.
#[cfg(unix)]
fn owner_ids() -> Option<String> {
    let id = |flag: &str| {
        std::process::Command::new("id")
            .arg(flag)
            .output()
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Some(format!("{}:{}", id("-u")?, id("-g")?))
}

#[cfg(not(unix))]
fn owner_ids() -> Option<String> {
    None
}

/// The worker container's name: per sandbox AND per side (2026-10-05). Both sides of a PC drive one engine, and one
/// shared name meant each side's `rm -f` before its run killed the other side's backup in the middle of it; a name of
/// this side's own is only ever a run of this side's that outlived its ic. Pure.
pub fn worker_name(slug: &str, side: &Side) -> String {
    let side: String = side
        .wire()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    format!("intentic-backup-{slug}-{side}")
}

/// A repository and the password file that opens it.
pub struct Repo {
    pub location: Location,
    pub key: PathBuf,
}

/// Where a sandbox's backups go: the repository saved for it (backup_repo.rs), else this machine's own disk.
pub fn location_of(slug: &str) -> Location {
    backup_repo::saved(slug).unwrap_or_else(|| Location::Folder(repo_dir(slug)))
}

/// The repository a backup writes to, with its key made if this is the first.
fn for_backup(slug: &str) -> Result<Repo> {
    Ok(Repo {
        location: location_of(slug),
        key: ensure_key(slug)?,
    })
}

/// Whether a repository holds backups already, as far as this machine can tell without opening it: a folder's restic
/// config, or for a remote one the stamp a finished full backup leaves.
fn has_backups(slug: &str, location: &Location) -> bool {
    match location {
        Location::Folder(path) => path.join("config").exists(),
        Location::Remote(_) => last_path(slug).exists(),
    }
}

/// `docker run` of restic with the repository and key mounted, running `script` in the image's shell (restic's image
/// is Alpine) so a folder repository can be handed back to this user afterwards. A folder repository runs with no
/// network at all; a remote one gets the default network, the NAMES of the credential variables set here (docker copies
/// their values, backup_repo.rs), and for sftp this user's ~/.ssh, copied in so ssh accepts its owner and modes.
fn restic(
    slug: &str,
    repo: &Repo,
    mounts: &[String],
    script: &str,
    log: &Log,
) -> Result<docker::Bounded> {
    let here = side::here();
    let name = worker_name(slug, &here);
    docker::quiet(&["rm", "-f", &name]);
    let labels = crate::sandbox::labels::args(
        slug,
        crate::sandbox::labels::Kind::BackupWorker,
        &here.wire(),
    );
    let key_mount = docker::bind_spec(&repo.key, "/key:ro")?;
    let mut setup: Vec<String> = Vec::new();
    match &repo.location {
        Location::Folder(path) => {
            std::fs::create_dir_all(path)?;
            setup.extend([
                "--network".to_string(),
                "none".to_string(),
                "-e".to_string(),
                "RESTIC_REPOSITORY=/repo".to_string(),
                "-v".to_string(),
                docker::bind_spec(path, "/repo")?,
            ]);
        }
        Location::Remote(url) => {
            setup.extend(["-e".to_string(), format!("RESTIC_REPOSITORY={url}")]);
            setup.extend(backup_repo::passed_env(
                std::env::vars_os().map(|(name, _)| name.to_string_lossy().to_string()),
            ));
            if let Some(ssh) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join(".ssh"))
                .filter(|ssh| repo.location.is_sftp() && ssh.is_dir())
            {
                setup.extend(["-v".to_string(), docker::bind_spec(&ssh, "/host-ssh:ro")?]);
            }
        }
    }
    let ssh = if repo.location.is_sftp() {
        "if [ -d /host-ssh ]; then mkdir -p /root/.ssh && cp -R /host-ssh/. /root/.ssh/ && chmod -R go-rwx /root/.ssh; fi; "
    } else {
        ""
    };
    let chown = owner_ids()
        .filter(|_| !repo.location.is_remote())
        .map(|ids| format!(" ; status=$?; chown -R {ids} /repo; exit $status"))
        .unwrap_or_default();
    let full_script = format!("{ssh}{script}{chown}");
    let mut args: Vec<&str> = vec!["run"];
    args.extend(labels.iter().map(String::as_str));
    args.extend_from_slice(&["--rm", "--name", &name]);
    args.extend(setup.iter().map(String::as_str));
    args.extend_from_slice(&["-e", "RESTIC_PASSWORD_FILE=/key", "-v", &key_mount]);
    for mount in mounts {
        args.extend_from_slice(&["-v", mount]);
    }
    args.extend_from_slice(&["--entrypoint", "sh", RESTIC_IMAGE, "-c", &full_script]);
    log.line(&format!("docker {}", args.join(" ")));
    let ran = docker::capture_bounded(&args, LIMIT)?;
    log.line(&ran.stdout);
    log.line(&ran.stderr);
    if ran.timed_out {
        docker::quiet(&["rm", "-f", &name]);
    }
    Ok(ran)
}

/// Single-quoted for the image's shell.
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The restic command lines a backup runs, pure over what it knows, so the paths and exclusions are asserted.
/// `sealed` is the at-rest key sealed under the backup password (backup_seal.rs), written into the worker's own
/// filesystem and backed up in the same snapshot; None when the sandbox has no at-rest key, and then nothing is.
pub fn backup_script(
    slug: &str,
    scope: Scope,
    database_staged: bool,
    reason: &str,
    sealed: Option<&str>,
) -> String {
    let mut excludes: Vec<&str> = ALWAYS_EXCLUDED.to_vec();
    if scope == Scope::State {
        excludes.extend_from_slice(&STATE_EXCLUDED);
    }
    // The live database files are replaced by the consistent copy when there is one.
    if database_staged {
        excludes.extend_from_slice(&[
            "/src/history/conversations.db",
            "/src/history/conversations.db-wal",
            "/src/history/conversations.db-shm",
        ]);
    }
    let paths = match scope {
        Scope::Full => "/src/work /src/history",
        Scope::State => "/src/work/.intentic /src/history",
    };
    let exclude_args: String = excludes
        .iter()
        .map(|path| format!(" --exclude {}", quoted(path)))
        .collect();
    let (stage_key, key_path) = match sealed {
        Some(sealed) => (
            format!(
                "mkdir -p {dir} && printf '%s' {} > {file} && ",
                quoted(sealed),
                dir = backup_seal::SEALED_DIR,
                file = backup_seal::SEALED_FILE,
            ),
            format!(" {}", backup_seal::SEALED_DIR),
        ),
        None => (String::new(), String::new()),
    };
    format!(
        "(restic cat config >/dev/null 2>&1 || restic init >/dev/null) && {stage_key}restic backup --json --quiet --host {} --tag intentic --tag {} --exclude-caches{exclude_args} {paths}{key_path}",
        quoted(slug),
        quoted(reason),
    )
}

/// The snapshot id restic's JSON summary names.
fn snapshot_of(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|line| line["message_type"] == "summary")
        .and_then(|summary| {
            summary["snapshot_id"]
                .as_str()
                .map(|id| id.chars().take(8).collect())
        })
}

/// Take a backup. Returns the snapshot id. The caller holds the sandbox's lock.
pub fn take(slug: &str, scope: Scope, reason: &str) -> Result<String> {
    let (work, history) = sources(slug);
    let (Some(work), Some(history)) = (work, history) else {
        bail!("{slug} has no workspace and history volumes on this machine to back up.");
    };
    let log = Log::create_named("backup", &format!("backup-{slug}"))?;
    let container = [container_of(slug), parked_of(slug)]
        .into_iter()
        .find(|name| docker::container_exists(name))
        .unwrap_or_default();
    let repo = for_backup(slug)?;
    let sealed = sealed_key(slug, &container, &repo, &log);
    let staged = !container.is_empty() && stage_database(&container);
    let mounts = vec![
        format!("{work}:/src/work:ro"),
        format!("{history}:/src/history:ro"),
    ];
    let ran = restic(
        slug,
        &repo,
        &mounts,
        &backup_script(slug, scope, staged, reason, sealed.as_deref()),
        &log,
    )?;
    if staged {
        docker::exec_ok(&container, &["rm", "-f", STAGED_DB]);
    }
    if ran.timed_out || ran.code != Some(0) {
        bail!(
            "the backup of {slug} did not finish{}. Log: {}",
            if ran.timed_out { " in time" } else { "" },
            log.path.display()
        );
    }
    let snapshot = snapshot_of(&ran.stdout).unwrap_or_else(|| "saved".to_string());
    // Said on the sandbox's own volume, where every side reads it: tidy on another side removes its own stale copy of
    // this sandbox once this, the keeping side's, is newer than it (tidy.rs).
    if !container.is_empty() {
        let _ = inside::write_stamped(
            &container,
            BACKUP_FILE,
            &backup_body(&side::here(), &snapshot, scope),
        );
    }
    if scope == Scope::Full {
        let _ = std::fs::write(last_path(slug), now_ms().to_string());
        // Old snapshots go on the full, daily run only: a quick pre-update backup never waits on a prune.
        let _ = restic(
            slug,
            &repo,
            &[],
            &format!("restic forget --host {} --keep-last 3 --keep-daily 7 --keep-weekly 4 --prune >/dev/null", quoted(slug)),
            &log,
        );
    }
    Ok(snapshot)
}

/// The at-rest key the sandbox's stores are encrypted with, sealed under the backup password: the file its container
/// mounts (live or parked), else ic's own key for it. None when it has none (encryption at rest off), or when this
/// machine cannot read the one it mounts (a volume, a file out of its sight), which the log says. The plaintext key is
/// read here and sealed in memory; it is written nowhere.
fn sealed_key(slug: &str, container: &str, repo: &Repo, log: &Log) -> Option<String> {
    let mounted = (!container.is_empty())
        .then(|| docker::inspect(container, "{{json .}}"))
        .flatten()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|inspect| at_rest::key_file(&inspect))
        .map(|file| at_rest::local_path_of(&file));
    let mounts_key =
        !container.is_empty() && docker::mount_source(container, at_rest::KEY_MOUNT).is_some();
    let file = match mounted {
        Some(file) => file,
        None if mounts_key => {
            log.line("the container's at-rest key is not a file this machine can read: this backup carries no key");
            return None;
        }
        // Mounting none, it may still have ic's own (a stopped sandbox's volumes, a container made again since).
        None => at_rest::sandbox_key(slug),
    };
    let content = match std::fs::read(&file) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound && !mounts_key => return None,
        Err(err) => {
            log.line(&format!(
                "the at-rest key {} could not be read ({err}): this backup carries no key",
                file.display()
            ));
            return None;
        }
    };
    let password = std::fs::read(&repo.key).ok()?;
    match backup_seal::seal(backup_seal::password_of(&password), &content) {
        Ok(sealed) => Some(sealed.to_string()),
        Err(Fail(why)) => {
            log.line(&format!(
                "the at-rest key was not sealed into this backup: {why}"
            ));
            None
        }
    }
}

/// Where the last backup of a sandbox is said, on its own volume.
pub const BACKUP_FILE: &str = "/history/.ic/backup.json";

/// What `backup.json` says: which side took the backup, when (the container's clock), and which snapshot. Pure.
pub fn backup_body(side: &Side, snapshot: &str, scope: Scope) -> Value {
    json!({
        "side": side.platform,
        "env": side.env,
        "at": inside::NOW,
        "snapshot": snapshot,
        "scope": if scope == Scope::Full { "full" } else { "state" },
    })
}

/// Which side's backup a sandbox's `backup.json` names, and when it was taken. Pure.
pub fn backup_of(value: &Value) -> Option<(Side, u64)> {
    let platform = value["side"].as_str().filter(|side| !side.is_empty())?;
    Some((
        Side::new(platform, value["env"].as_str()),
        value["at"].as_u64()?,
    ))
}

/// The last backup any side said it took of this sandbox, off its volume.
pub fn last_said(slug: &str) -> Option<(Side, u64)> {
    let holder = inside::holder(slug)?;
    match inside::read(&holder, BACKUP_FILE) {
        Read::Found(value) => backup_of(&value),
        _ => None,
    }
}

/// When this side last backed this sandbox up: the stamp a full backup leaves, else the moment its repository last
/// took a snapshot (an older ic left no stamp). None when there is no repository here at all.
pub fn last_here(slug: &str) -> Option<u64> {
    if let Some(stamp) = std::fs::read_to_string(last_path(slug))
        .ok()
        .and_then(|text| text.trim().parse().ok())
    {
        return Some(stamp);
    }
    let repo = repo_dir(slug);
    [repo.join("snapshots"), repo]
        .iter()
        .find_map(|path| {
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
        })
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
}

/// The sandboxes this side holds backups of: a folder under `backups/`, or a key without one.
pub fn held_here() -> Vec<String> {
    let mut slugs: Vec<String> = Vec::new();
    let mut add = |slug: String| {
        if !slug.is_empty() && !slugs.contains(&slug) {
            slugs.push(slug);
        }
    };
    if let Ok(entries) = std::fs::read_dir(intentic_home().join("backups")) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                add(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(intentic_home().join("keys")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(slug) = name
                .strip_prefix("backup-")
                .and_then(|rest| rest.strip_suffix(".key"))
            {
                add(slug.to_string());
            }
        }
    }
    slugs.sort();
    slugs
}

/// This side's backups of a sandbox gone, repository and key. Ok(bytes the repository held) when nothing is left.
pub fn discard(slug: &str) -> std::result::Result<u64, String> {
    let dir = backups_dir(slug);
    let size = dir_size(&dir);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|err| format!("{}: {err}", dir.display()))?;
    }
    let key = key_path(slug);
    if key.exists() {
        std::fs::remove_file(&key).map_err(|err| format!("{}: {err}", key.display()))?;
    }
    Ok(size)
}

fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|entry| dir_size(&entry.path())).sum())
        .unwrap_or(0)
}

/// Why a background backup should not run now, if it should not. Pure over what it is given.
pub fn auto_skip(
    last_full: Option<u64>,
    now: u64,
    disk_short: bool,
    swapping: bool,
) -> Option<&'static str> {
    if swapping {
        return Some("a swap is in flight");
    }
    if disk_short {
        return Some("this machine is short of disk; `ic sandbox backup` by hand still takes one");
    }
    if last_full.is_some_and(|last| now.saturating_sub(last) < AUTO_EVERY.as_millis() as u64) {
        return Some("a backup ran within the last day");
    }
    None
}

/// What `--repo default` says: back to this machine's own disk.
pub const DEFAULT_REPO: &str = "default";

/// `ic sandbox backup [slug] [--repo <where>] [--auto] [--json]`. `--repo` is kept for the sandbox (backup_repo.rs), and
/// every later backup of it, the unattended ones included, goes there.
pub fn run(slug: Option<String>, repo: Option<String>, auto: bool, as_json: bool) -> Result<()> {
    docker::require_daemon()?;
    let slug = resolve_slug(slug, "ic sandbox backup")?;
    if let Some(raw) = &repo {
        let location = (raw.trim() != DEFAULT_REPO)
            .then(|| backup_repo::parse(raw))
            .transpose()?;
        backup_repo::save(&slug, location.as_ref())?;
        if !as_json {
            crate::ui::note(&format!(
                "{slug}'s backups go to {} from now on.",
                location_of(&slug).spelled()
            ));
        }
    }
    let shown = location_of(&slug).spelled();
    // The daily backup of a sandbox is its own side's: the other side's machine agent backs it up into its own repo,
    // for as long as it looks after it (side.rs).
    let unattended = if auto {
        side::unattended(&slug)
    } else {
        Unattended::Ours
    };
    let adopted = match &unattended {
        Unattended::Adopted(adoption) => Some(adoption.clone()),
        _ => None,
    };
    let say = |result: &str, snapshot: Option<&str>, reason: Option<&str>| {
        if as_json {
            let mut line = json!({"slug": slug, "result": result});
            if let Some(adoption) = &adopted {
                line["adopted"] = adoption.json();
            }
            if let Some(snapshot) = snapshot {
                line["snapshot"] = json!(snapshot);
                line["repo"] = json!(shown);
            }
            if let Some(reason) = reason {
                line["reason"] = json!(reason);
            }
            // allow(terminal-output): the --json answer, one line the machine agent's daily backup reads.
            println!("{line}");
        } else if let Some(snapshot) = snapshot {
            if let Some(adoption) = &adopted {
                crate::ui::note(&format!("{slug}: {}", adoption.sentence()));
            }
            crate::ui::done(&format!(
                "Backed up {slug} (snapshot {snapshot}) to {shown}."
            ));
            crate::ui::later(&[("see them".to_string(), format!("ic sandbox backups {slug}"))]);
        } else {
            crate::ui::quiet(&format!(
                "No backup of {slug} this time: {}.",
                reason.unwrap_or("skipped")
            ));
        }
    };
    if let Unattended::Theirs(side) = &unattended {
        say("elsewhere", None, Some(&side::sentence(side)));
        return Ok(());
    }
    // The keeper's own round is also its heartbeat (side.rs), beside the one its fix sweep writes.
    if auto && unattended == Unattended::Ours {
        side::beat(&slug);
    }
    let Some(_held) = lock::hold(&slug, if auto { Wait::Skip } else { Wait::Block })? else {
        say("skipped", None, Some("another ic run is working on it"));
        return Ok(());
    };
    if auto {
        let last = std::fs::read_to_string(last_path(&slug))
            .ok()
            .and_then(|text| text.trim().parse().ok());
        let disk_short = matches!(
            checks::check_disk(),
            checks::Outcome::Warn { .. } | checks::Outcome::Fail { .. }
        );
        let swapping = record::read(&slug)
            .ok()
            .and_then(|record| record.swap)
            .is_some_and(|swap| swap.phase == Phase::Cutover);
        if let Some(reason) = auto_skip(last, now_ms(), disk_short, swapping) {
            say("skipped", None, Some(reason));
            return Ok(());
        }
    }
    let snapshot = take(&slug, Scope::Full, if auto { "daily" } else { "manual" })?;
    say("done", Some(&snapshot), None);
    Ok(())
}

/// The quick backup before a swap: only when this sandbox already has a repository (a first, full backup can take a
/// long time, and a person waiting on an update is not the one to pay for it), and never a reason to refuse the swap.
pub fn before_swap(slug: &str) {
    if !has_backups(slug, &location_of(slug)) {
        return;
    }
    match take(slug, Scope::State, "pre-update") {
        Ok(snapshot) => {
            // The plain sentence is a stage mark the desktop app reads (deviceUpdateStages.ts): it opens with "backed up".
            crate::ui::note(&format!(
                "backed up {slug}'s state before the swap (snapshot {snapshot})."
            ))
        }
        Err(Fail(reason)) => crate::ui::warn(&format!(
            "the backup before the swap did not finish, continuing without it: {reason}"
        )),
    }
}

/// `ic sandbox backups [slug] [--json]` — the snapshots kept for this sandbox (read-only).
pub fn list(slug: Option<String>, as_json: bool) -> Result<()> {
    docker::require_daemon()?;
    let slug = resolve_slug(slug, "ic sandbox backups")?;
    let location = location_of(&slug);
    if !has_backups(&slug, &location) || !key_path(&slug).is_file() {
        if as_json {
            // allow(terminal-output): the --json answer, an empty list.
            println!("[]");
        } else {
            crate::ui::quiet(&format!(
                "{slug} has no backups in {} yet.",
                location.spelled()
            ));
            crate::ui::later(&[("take one".to_string(), format!("ic sandbox backup {slug}"))]);
        }
        return Ok(());
    }
    let log = Log::create_named("backup", &format!("backups-{slug}"))?;
    let repo = Repo {
        location,
        key: key_path(&slug),
    };
    let ran = restic(
        &slug,
        &repo,
        &[],
        &format!("restic snapshots --json --host {}", quoted(&slug)),
        &log,
    )?;
    if ran.code != Some(0) {
        bail!(
            "{}",
            crate::ui::explain(
                &format!("{slug}'s backups could not be read."),
                Some(&format!(
                    "restic stopped. Its log is {}.",
                    log.path.display()
                )),
                None,
            )
        );
    }
    let snapshots: Vec<Value> = serde_json::from_str(ran.stdout.trim()).unwrap_or_default();
    if as_json {
        let rows: Vec<Value> = snapshots
            .iter()
            .map(|snapshot| json!({"id": snapshot["short_id"], "time": snapshot["time"], "tags": snapshot["tags"]}))
            .collect();
        // allow(terminal-output): the --json answer, the snapshot list the desktop app and the machine agent read.
        println!("{}", Value::Array(rows));
        return Ok(());
    }
    crate::ui::report(
        &format!("intentic · {slug} backups"),
        Some(&repo.location.spelled()),
    );
    if snapshots.is_empty() {
        crate::ui::quiet("There are no snapshots yet.");
    }
    let rows: Vec<crate::ui::Item> = snapshots
        .iter()
        .map(|snapshot| {
            let tags = snapshot["tags"]
                .as_array()
                .map(|tags| {
                    tags.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            crate::ui::Item::new(
                crate::ui::Tone::Ok,
                snapshot["short_id"].as_str().unwrap_or("?"),
                format!("{}  {tags}", snapshot["time"].as_str().unwrap_or("?")),
            )
        })
        .collect();
    crate::ui::items(&rows);
    crate::ui::later(&[(
        "restore one".to_string(),
        format!("ic sandbox backup-restore {slug} --snapshot <id> --to <folder>"),
    )]);
    Ok(())
}

/// `ic sandbox backup-restore <slug> --snapshot <id> (--to <folder> | --into <slug>) [--repo <where> --key-file <file>]`:
/// the backup's files into a folder on this machine to look through, or back into a sandbox's own volumes (stopped for
/// it, and started again), which is how a sandbox whose volumes were lost is brought back into a new one. The
/// repository is the one saved for `<slug>` on this machine unless `--repo` names another, and `--key-file` its
/// password file when this machine holds none for `<slug>`: a repository copied from another machine, a NAS, a bucket.
pub fn restore(
    from: String,
    snapshot: String,
    to: Option<PathBuf>,
    into: Option<String>,
    yes: bool,
    repo: Option<String>,
    key_file: Option<PathBuf>,
) -> Result<()> {
    docker::require_daemon()?;
    let location = match &repo {
        Some(raw) => backup_repo::parse(raw)?,
        None => location_of(&from),
    };
    let key = match key_file {
        Some(file) => std::path::absolute(file)?,
        None => key_path(&from),
    };
    if !key.is_file() {
        bail!(
            "{}",
            crate::ui::explain(
                "Nothing was restored.",
                Some(&format!(
                    "this device holds no key for {from}'s backups ({} is not there).",
                    key.display()
                )),
                Some("add --key-file <the backup key file>"),
            )
        );
    }
    if let Location::Folder(path) = &location {
        if !path.join("config").exists() {
            bail!(
                "{}",
                crate::ui::explain(
                    "Nothing was restored.",
                    Some(&format!(
                        "there are no backups of {from} at {}.",
                        path.display()
                    )),
                    Some(if repo.is_some() {
                        "check --repo: it names the folder holding the repository's `config`"
                    } else {
                        "ic sandbox backups, or --repo <where the repository is>"
                    }),
                )
            );
        }
    }
    let repo = Repo { location, key };
    let log = Log::create_named("backup", &format!("restore-{from}"))?;
    match (to, into) {
        (Some(folder), None) => {
            std::fs::create_dir_all(&folder)?;
            // A relative folder would reach docker as a volume NAME, and the files would land somewhere nobody looks.
            let folder = std::path::absolute(&folder)?;
            let target = docker::bind_spec(&folder, "/out")?;
            let ran = restic(
                &from,
                &repo,
                &[target],
                &format!(
                    "restic restore {} --exclude {} --target /out",
                    quoted(&snapshot),
                    quoted(backup_seal::SEALED_DIR)
                ),
                &log,
            )?;
            if ran.code != Some(0) {
                bail!(
                    "{}",
                    crate::ui::explain(
                        "The restore did not finish.",
                        Some(&format!(
                            "restic stopped. Its log is {}.",
                            log.path.display()
                        )),
                        None,
                    )
                );
            }
            crate::ui::done(&format!(
                "{from}'s files from snapshot {snapshot} are in {} (src/work and src/history).",
                folder.display()
            ));
            Ok(())
        }
        (None, Some(into)) => restore_into(&from, &repo, &snapshot, &into, yes, &log),
        _ => bail!(
            "{}",
            crate::ui::explain(
                "Nothing was restored.",
                Some("the command does not say where the files go."),
                Some("add --to <folder>, or --into <sandbox>."),
            )
        ),
    }
}

/// The at-rest key a snapshot carries (backup_seal.rs), unsealed with the repository's password. None for a snapshot
/// from before keys travelled or of a sandbox with encryption at rest off, and, said, for one that does not open.
fn carried_key(repo: &Repo, from: &str, snapshot: &str, log: &Log) -> Option<backup_seal::Carried> {
    let ran = restic(
        from,
        repo,
        &[],
        &format!(
            "restic dump --quiet {} {} 2>/dev/null || true",
            quoted(snapshot),
            backup_seal::SEALED_FILE
        ),
        log,
    )
    .ok()?;
    let sealed: Value = serde_json::from_str(ran.stdout.trim()).ok()?;
    let password = std::fs::read(&repo.key).ok()?;
    match backup_seal::unseal(backup_seal::password_of(&password), &sealed) {
        Ok(carried) => Some(carried),
        Err(Fail(why)) => {
            crate::ui::warn(&format!(
                "the at-rest key in {from}'s snapshot {snapshot} is not used: {why}."
            ));
            None
        }
    }
}

/// What the sandbox's container mounts as its at-rest key, as backup_seal::plan reads it.
fn target_key(container: &str) -> TargetKey {
    if docker::mount_source(container, at_rest::KEY_MOUNT).is_none() {
        return TargetKey::None;
    }
    at_rest::mounted_key_id(container).map_or(TargetKey::Unknown, TargetKey::Known)
}

/// Recreate the sandbox where it is, on its own image, so it mounts its keys again: with `previous` as its previous
/// at-rest key when given, by the door an operator's rotation uses (PREVIOUS_HOST_FILE_ENV, recreate.rs).
fn remount(slug: &str, previous: Option<&std::path::Path>) -> Result<()> {
    let name = at_rest::PREVIOUS_HOST_FILE_ENV;
    let before = std::env::var_os(name);
    if let Some(previous) = previous {
        std::env::set_var(name, previous);
    }
    let made = crate::sandbox::recreate::run(
        crate::sandbox::recreate::Mode::Reshape(crate::shape::Ask::default()),
        Some(slug.to_string()),
        crate::sandbox::recreate::Preflight::Skip,
    );
    match before {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
    made
}

/// What a person is told about the credential stores before and after a restore into a sandbox. Pure.
fn credentials_sentence(plan: KeyPlan, from: &str, into: &str) -> Option<String> {
    match plan {
        KeyPlan::AsIs => None,
        KeyPlan::Exclude => Some(format!(" {from}'s stored credentials are left out: they are encrypted with {from}'s own key, which this backup does not carry, and {into} keeps its own.")),
        KeyPlan::Previous => Some(format!(" {from}'s stored credentials come too: the at-rest key this backup carries is given to {into} as its previous key, and {into} re-encrypts them under its own as it starts.")),
        KeyPlan::Mount => Some(format!(" {into}'s at-rest key comes back out of the backup, and {into} is restarted once first to mount it.")),
    }
}

fn restore_into(
    from: &str,
    repo: &Repo,
    snapshot: &str,
    into: &str,
    yes: bool,
    log: &Log,
) -> Result<()> {
    let _held = lock::hold_for_person(into)?;
    let container = container_of(into);
    if !docker::container_exists(&container) {
        bail!(
            "{}",
            crate::ui::explain(
                &format!("Nothing was restored: there is no sandbox named {into} on this device."),
                Some("a backup is restored into a sandbox's volumes, so the sandbox has to exist first."),
                Some("set one up (it may be a new one, under any name), then run this again with --into <its name>."),
            )
        );
    }
    let (Some(work), Some(history)) = (
        docker::mount_source(&container, "/work"),
        docker::mount_source(&container, "/history"),
    ) else {
        bail!(
            "{}",
            crate::ui::explain(
                "Nothing was restored.",
                Some(&format!(
                    "{into} has no workspace or history volume to restore into."
                )),
                None,
            )
        );
    };
    /* THE CREDENTIAL STORES. A snapshot holds them encrypted with the at-rest key of the sandbox it was taken of, and the
    daemon refuses to boot over stores it cannot authenticate. A snapshot that carries that key (backup_seal.rs) brings it
    back: as the same sandbox's own key, or as the target's PREVIOUS key, so its daemon re-encrypts them under its own at
    boot. One that carries none (taken before 2026-11-11, or with encryption at rest off) restores into another sandbox
    as it always did: without them. */
    let same = from == into;
    let carried = carried_key(repo, from, snapshot, log);
    let own = same
        .then(|| std::fs::read(at_rest::sandbox_key(into)).ok())
        .flatten()
        .and_then(|content| at_rest::key_id_of(&content));
    let plan = backup_seal::plan(
        same,
        carried.as_ref().map(|carried| carried.key_id.as_str()),
        &target_key(&container),
        own.as_deref(),
    );
    let credentials = credentials_sentence(plan, from, into);
    if !crate::ui::confirm(
        &format!("Restore {from}'s snapshot {snapshot} into {into}?"),
        &format!(
            "{into} is stopped, the files the backup holds are written over its own, and it starts again.{}",
            credentials.as_deref().unwrap_or_default()
        ),
        yes,
    )? {
        crate::ui::cancelled();
        return Ok(());
    }
    // The keys first, before any file is written: a recreate that fails leaves the sandbox as it was.
    if let Some(carried) = &carried {
        if same {
            let own_path = at_rest::sandbox_key(into);
            if at_rest::place(&own_path, &carried.content)? {
                crate::ui::note(&format!(
                    "{into}'s at-rest key is back from the backup: {}. Keep that file: without it its credentials cannot be read.",
                    own_path.display()
                ));
            }
        }
        match plan {
            KeyPlan::Previous => {
                let previous = at_rest::place_previous(into, &carried.content)?;
                crate::ui::act(&format!(
                    "Restarting {into} with the backup's at-rest key as its previous key"
                ));
                remount(into, Some(&previous))?;
            }
            KeyPlan::Mount => {
                crate::ui::act(&format!("Restarting {into} with its at-rest key"));
                remount(into, None)?;
            }
            KeyPlan::AsIs | KeyPlan::Exclude => {}
        }
    }
    crate::ui::act(&format!(
        "Restoring {from}'s snapshot {snapshot} into {into}"
    ));
    docker::quiet(&["stop", &container]);
    let mounts = vec![
        format!("{work}:/src/work"),
        format!("{history}:/src/history"),
    ];
    let mut exclude = format!(" --exclude {}", quoted(backup_seal::SEALED_DIR));
    if plan == KeyPlan::Exclude {
        exclude.push_str(&format!(" --exclude {}", quoted(AUTH_SRC)));
    }
    // The consistent database copy the backup holds becomes the database, and a log from another moment goes.
    let script = format!(
        "restic restore {}{exclude} --target / && if [ -f {STAGED_DB_SRC} ]; then rm -f /src/history/conversations.db-wal /src/history/conversations.db-shm && mv {STAGED_DB_SRC} /src/history/conversations.db; fi",
        quoted(snapshot),
    );
    let ran = restic(from, repo, &mounts, &script, log);
    docker::quiet(&["start", &container]);
    let ran = ran?;
    if ran.code != Some(0) {
        bail!(
            "{}",
            crate::ui::explain(
                &format!("The restore into {into} did not finish."),
                Some(&format!(
                    "{into} was started again as it was left. restic's log is {}.",
                    log.path.display()
                )),
                None,
            )
        );
    }
    crate::ui::done(&format!(
        "{from}'s snapshot {snapshot} is restored into {into}, which is starting again.{}",
        credentials.as_deref().unwrap_or_default()
    ));
    Ok(())
}

/// Where the staged database copy sits in a restored tree.
const STAGED_DB_SRC: &str = "/src/history/.ic/backup/conversations.db";

/// The daemon's auth root under /work as a restored tree holds it (authRootOf, _sandbox/sandbox/src/state-paths.ts):
/// where the stores encrypted with the sandbox's own at-rest key are.
const AUTH_SRC: &str = "/src/work/.intentic/secrets/auth";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_backup_covers_both_volumes_and_leaves_out_what_regrows() {
        let script = backup_script("abc", Scope::Full, true, "daily", None);
        assert!(script.ends_with(" /src/work /src/history"), "{script}");
        assert!(
            script.contains("--host 'abc' --tag intentic --tag 'daily'"),
            "{script}"
        );
        assert!(script.contains("--exclude 'node_modules'"), "{script}");
        assert!(
            script.contains("--exclude '/src/history/engines'"),
            "{script}"
        );
        assert!(script.contains("--exclude-caches"), "{script}");
        // The live database is replaced by its consistent copy, which the backup keeps.
        assert!(
            script.contains("--exclude '/src/history/conversations.db-wal'"),
            "{script}"
        );
        assert!(!script.contains("/src/history/.ic/backup'"), "{script}");
        // The worktrees (agents' unfinished work) and the repositories' history are in a full backup.
        assert!(
            !script.contains("'/src/history/worktrees'") && !script.contains("'/src/history/gits'"),
            "{script}"
        );
        // A repository that does not exist yet is made first.
        assert!(
            script.starts_with("(restic cat config >/dev/null 2>&1 || restic init >/dev/null) && "),
            "{script}"
        );
    }

    #[test]
    fn the_quick_backup_before_a_swap_takes_the_state_an_update_converts() {
        let script = backup_script("abc", Scope::State, false, "pre-update", None);
        assert!(
            script.ends_with(" /src/work/.intentic /src/history"),
            "{script}"
        );
        assert!(
            script.contains("--exclude '/src/history/worktrees'"),
            "{script}"
        );
        // Without a consistent copy the database files themselves are the backup.
        assert!(!script.contains("conversations.db"), "{script}");
    }

    #[test]
    fn the_sealed_at_rest_key_rides_in_the_same_snapshot_only_when_there_is_one() {
        let sealed = r#"{"v":1,"keyId":"0123456789abcdef","nonce":"00","ciphertext":"11"}"#;
        let script = backup_script("abc", Scope::Full, false, "daily", Some(sealed));
        assert!(
            script.contains(&format!(
                "mkdir -p /src/ic && printf '%s' {} > /src/ic/at-rest-key.sealed.json && restic backup",
                quoted(sealed)
            )),
            "{script}"
        );
        assert!(
            script.ends_with(" /src/work /src/history /src/ic"),
            "{script}"
        );
        let state = backup_script("abc", Scope::State, false, "pre-update", Some(sealed));
        assert!(
            state.ends_with(" /src/work/.intentic /src/history /src/ic"),
            "{state}"
        );
        let off = backup_script("abc", Scope::Full, false, "daily", None);
        assert!(!off.contains("/src/ic"), "{off}");
    }

    #[test]
    fn a_restore_says_what_becomes_of_the_credentials() {
        assert_eq!(credentials_sentence(KeyPlan::AsIs, "a", "a"), None);
        let excluded = credentials_sentence(KeyPlan::Exclude, "a", "b").unwrap();
        assert!(excluded.contains("left out"), "{excluded}");
        let rotated = credentials_sentence(KeyPlan::Previous, "a", "b").unwrap();
        assert!(
            rotated.contains("previous key") && rotated.contains("re-encrypts"),
            "{rotated}"
        );
        assert!(credentials_sentence(KeyPlan::Mount, "a", "a")
            .unwrap()
            .contains("restarted once"));
    }

    #[test]
    fn a_background_backup_waits_for_a_day_disk_and_any_swap() {
        let day = 24 * 60 * 60 * 1000;
        assert_eq!(auto_skip(None, day, false, false), None);
        assert_eq!(auto_skip(Some(0), day, false, false), None);
        assert!(auto_skip(Some(day / 2), day, false, false).is_some());
        assert!(auto_skip(None, day, true, false).is_some());
        assert!(auto_skip(None, day, false, true).is_some());
    }

    #[test]
    fn the_snapshot_is_read_off_restics_summary() {
        let out = "{\"message_type\":\"status\"}\n{\"message_type\":\"summary\",\"snapshot_id\":\"1234abcd5678\"}";
        assert_eq!(snapshot_of(out).as_deref(), Some("1234abcd"));
        assert_eq!(snapshot_of("not json"), None);
    }

    #[test]
    fn each_side_has_a_backup_worker_of_its_own() {
        let arch = worker_name("sandbox-abc", &Side::new("linux", Some("Arch Linux")));
        assert_eq!(arch, "intentic-backup-sandbox-abc-linux-arch-linux");
        let windows = worker_name("sandbox-abc", &Side::new("windows", Some("windows")));
        assert_eq!(windows, "intentic-backup-sandbox-abc-windows");
        assert_ne!(arch, windows);
        assert_ne!(
            arch,
            worker_name("sandbox-abc", &Side::new("linux", Some("ubuntu")))
        );
    }

    #[test]
    fn the_last_backup_is_said_on_the_volume_with_its_side() {
        let body = backup_body(&Side::new("linux", Some("arch")), "1234abcd", Scope::Full);
        let written: Value =
            serde_json::from_str(&inside::stamp(&body.to_string(), 9)).expect("JSON");
        assert_eq!(written["snapshot"], "1234abcd");
        assert_eq!(written["scope"], "full");
        assert_eq!(
            backup_of(&written),
            Some((Side::new("linux", Some("arch")), 9))
        );
        assert_eq!(backup_of(&json!({ "at": 9 })), None);
    }

    #[test]
    fn a_value_reaches_the_shell_as_one_word() {
        assert_eq!(quoted("a b"), "'a b'");
        assert_eq!(quoted("it's"), "'it'\\''s'");
    }

    #[test]
    fn a_key_is_sixty_four_hex_characters_and_never_the_same_twice() {
        let (first, second) = (random_hex().unwrap(), random_hex().unwrap());
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
