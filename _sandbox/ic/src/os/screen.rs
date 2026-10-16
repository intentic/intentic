use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::Paths;
use crate::sandbox::listing::{self, Seen};
use crate::util::{bail, Fail, Result};

mod wayland;

// The directory, rather than its socket, is mounted into a sandbox. Replacing a listener after a sway restart then
// reaches containers already running. Only the security-context listener ever goes here, never sway's own socket.
const ROOT: &str = "/run/user/1990/intentic/screen";
const UID: u32 = 1990;
const POLL: Duration = Duration::from_secs(3);
const DOCKER_LIMIT: Duration = Duration::from_secs(20);

pub fn desktop_edition(paths: &Paths) -> bool {
    super::read_json(&paths.release()).is_some_and(|release| release["edition"] == "desktop")
}

fn root(paths: &Paths) -> PathBuf {
    paths.at(ROOT)
}

/// A slug can never choose a directory outside this sandbox's own mount. Pure.
pub fn directory(paths: &Paths, slug: &str) -> Result<PathBuf> {
    if !crate::sandbox::is_slug(slug) {
        bail!("{slug:?} is not a sandbox slug; no screen directory was made.");
    }
    Ok(root(paths).join(slug))
}

fn private_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(err) => bail!("Could not make {}: {err}.", path.display()),
    }
    let metadata = fs::symlink_metadata(path).map_err(|err| Fail(err.to_string()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("{} must be a directory, not a link.", path.display());
    }
    // connect/recreate can run as root; Docker must never get to create a root-owned mount source for us.
    std::os::unix::fs::chown(path, Some(UID), Some(UID))
        .and_then(|()| fs::set_permissions(path, fs::Permissions::from_mode(0o700)))
        .map_err(|err| {
            Fail(format!(
                "Could not give {} to intentic: {err}.",
                path.display()
            ))
        })
}

fn prepare_root(paths: &Paths) -> Result<()> {
    private_directory(&paths.at("/run/user/1990/intentic"))?;
    private_directory(&root(paths))
}

/// Called before docker run, even when sway has not started yet.
pub fn prepare_directory(paths: &Paths, slug: &str) -> Result<PathBuf> {
    let directory = directory(paths, slug)?;
    prepare_root(paths)?;
    private_directory(&directory)?;
    Ok(directory)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Sandbox {
    slug: String,
    id: String,
}

/// The running primary containers whose sockets can cross the container boundary. Docker's runtime is inspected,
/// rather than guessed from today's policy: containers started under yesterday's policy may still run. Pure.
fn wanted(seen: &[Seen], inspected: &str) -> BTreeMap<String, Sandbox> {
    let containers: BTreeMap<&str, (&str, &str)> = inspected
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            Some((
                fields.next()?.trim_start_matches('/'),
                (fields.next()?, fields.next()?),
            ))
        })
        .collect();
    seen.iter()
        .filter(|sandbox| sandbox.running && crate::sandbox::is_slug(&sandbox.slug))
        .filter_map(|sandbox| {
            let (id, runtime) = containers.get(sandbox.container.as_str())?;
            (!id.is_empty() && !runtime.starts_with("kata")).then(|| {
                (
                    sandbox.slug.clone(),
                    Sandbox {
                        slug: sandbox.slug.clone(),
                        id: (*id).to_string(),
                    },
                )
            })
        })
        .collect()
}

/// A replacement container with the same slug needs a new instance id. A listener whose pathname vanished also
/// needs replacing, even while its old fd still exists in sway. Pure.
fn changes(
    wanted: &BTreeMap<String, Sandbox>,
    served: &BTreeMap<String, Sandbox>,
    present: &BTreeSet<String>,
) -> (Vec<String>, Vec<Sandbox>) {
    let remove = served
        .iter()
        .filter(|(slug, sandbox)| wanted.get(*slug) != Some(*sandbox) || !present.contains(*slug))
        .map(|(slug, _)| slug.clone())
        .collect();
    let start = wanted
        .iter()
        .filter(|(slug, sandbox)| served.get(*slug) != Some(*sandbox) || !present.contains(*slug))
        .map(|(_, sandbox)| sandbox.clone())
        .collect();
    (remove, start)
}

fn look() -> Result<(Vec<Seen>, BTreeMap<String, Sandbox>)> {
    let seen = listing::seen()?;
    let running: Vec<&str> = seen
        .iter()
        .filter(|sandbox| sandbox.running)
        .map(|sandbox| sandbox.container.as_str())
        .collect();
    if running.is_empty() {
        return Ok((seen, BTreeMap::new()));
    }
    let mut args = vec![
        "inspect",
        "--format",
        "{{.Name}}\t{{.Id}}\t{{.HostConfig.Runtime}}",
    ];
    args.extend(running);
    let ran = crate::docker::capture_bounded(&args, DOCKER_LIMIT)?;
    if ran.timed_out || ran.code != Some(0) {
        bail!(
            "Docker could not identify the running sandboxes; their screen listeners were closed."
        );
    }
    let wanted = wanted(&seen, &ran.stdout);
    Ok((seen, wanted))
}

fn socket_exists(directory: &Path) -> bool {
    fs::symlink_metadata(directory.join("wayland-0"))
        .is_ok_and(|metadata| metadata.file_type().is_socket())
}

fn body(
    paths: &Paths,
    seen: &[Seen],
    served: &BTreeMap<String, Sandbox>,
    reason: Option<&str>,
) -> Value {
    let sandboxes: Vec<Value> = seen
        .iter()
        .map(|sandbox| {
            let socket = reason.is_none()
                && sandbox.running
                && served.contains_key(&sandbox.slug)
                && directory(paths, &sandbox.slug).is_ok_and(|directory| socket_exists(&directory));
            json!({ "slug": sandbox.slug, "socket": socket })
        })
        .collect();
    json!({ "available": reason.is_none(), "reason": reason, "sandboxes": sandboxes })
}

fn record(paths: &Paths, body: &Value) -> Result<()> {
    super::write_atomic(
        &root(paths).join("status.json"),
        format!("{body}\n").as_bytes(),
    )
}

/// The lock is also a liveness check for callers outside sway's environment. A killed server releases it immediately;
/// a leftover socket file alone must never claim the screen is available.
fn serving(paths: &Paths) -> bool {
    File::open(root(paths).join("serve.lock"))
        .is_ok_and(|file| matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)))
}

pub fn status(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    let paths = Paths::here();
    let seen = listing::seen();
    let mut value = super::read_json(&root(&paths).join("status.json"))
        .unwrap_or_else(|| json!({ "available": false, "reason": "The screen service is not running.", "sandboxes": [] }));
    let reason = if !desktop_edition(&paths) {
        Some("Only the Intentic OS desktop edition can show sandbox windows.".to_string())
    } else if let Err(err) = &seen {
        Some(err.0.clone())
    } else if !serving(&paths) {
        Some(if value["available"] == false {
            value["reason"]
                .as_str()
                .unwrap_or("The screen service is not running.")
                .to_string()
        } else {
            "The screen service is not running.".to_string()
        })
    } else {
        value["reason"].as_str().map(str::to_string)
    };
    let registered: BTreeSet<String> = value["sandboxes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|sandbox| sandbox["socket"] == true)
        .filter_map(|sandbox| sandbox["slug"].as_str().map(str::to_string))
        .collect();
    let sandboxes: Vec<Value> = seen
        .unwrap_or_default()
        .iter()
        .map(|sandbox| {
            let socket = reason.is_none()
                && sandbox.running
                && registered.contains(&sandbox.slug)
                && directory(&paths, &sandbox.slug)
                    .is_ok_and(|directory| socket_exists(&directory));
            json!({ "slug": sandbox.slug, "socket": socket })
        })
        .collect();
    value = json!({ "available": reason.is_none(), "reason": reason, "sandboxes": sandboxes });
    if json {
        super::emit_json(&value);
    } else if let Some(reason) = value["reason"].as_str() {
        crate::ui::note(reason);
    } else {
        crate::ui::done(&format!(
            "Sandbox windows are available: {}.",
            value["sandboxes"]
        ));
    }
    Ok(())
}

pub fn serve() -> Result<()> {
    let paths = Paths::here();
    if !desktop_edition(&paths) {
        bail!("Only the Intentic OS desktop edition can show sandbox windows.");
    }
    prepare_root(&paths)?;
    let lock =
        File::create(root(&paths).join("serve.lock")).map_err(|err| Fail(err.to_string()))?;
    lock.try_lock().map_err(|err| {
        Fail(format!(
            "The screen service is already running, or its lock is unavailable: {err}."
        ))
    })?;
    record(
        &paths,
        &body(
            &paths,
            &[],
            &BTreeMap::new(),
            Some("The screen service is connecting to sway."),
        ),
    )?;
    let result = serve_session(&paths);
    if let Err(err) = &result {
        record(&paths, &body(&paths, &[], &BTreeMap::new(), Some(&err.0)))?;
    }
    result
}

fn serve_session(paths: &Paths) -> Result<()> {
    let mut compositor = wayland::Compositor::connect()?;
    let mut listeners = BTreeMap::new();
    let mut served = BTreeMap::new();
    loop {
        // Roundtrips notice a dead compositor even on an otherwise idle machine. The wrapper starts us again with
        // the next session; dropping each close endpoint stops sway accepting through that listener.
        compositor.sync()?;
        let (seen, wanted) = match look() {
            Ok(found) => found,
            Err(err) => {
                listeners.clear();
                served.clear();
                record(paths, &body(paths, &[], &served, Some(&err.0)))?;
                std::thread::sleep(POLL);
                continue;
            }
        };
        let present = served
            .keys()
            .filter(|slug| directory(paths, slug).is_ok_and(|dir| socket_exists(&dir)))
            .cloned()
            .collect();
        let (remove, start) = changes(&wanted, &served, &present);
        for slug in remove {
            listeners.remove(&slug);
            served.remove(&slug);
        }
        for sandbox in start {
            let result = prepare_directory(paths, &sandbox.slug)
                .and_then(|dir| compositor.listen(&dir, &sandbox));
            match result {
                Ok(listener) => {
                    listeners.insert(sandbox.slug.clone(), listener);
                    served.insert(sandbox.slug.clone(), sandbox);
                }
                Err(err) => {
                    crate::ui::warn(&format!("{} has no screen socket: {}", sandbox.slug, err.0))
                }
            }
        }
        record(paths, &body(paths, &seen, &served, None))?;
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(slug: &str, running: bool) -> Seen {
        Seen {
            slug: slug.into(),
            container: crate::sandbox::container_of(slug),
            running,
        }
    }

    fn sandbox(slug: &str, id: &str) -> Sandbox {
        Sandbox {
            slug: slug.into(),
            id: id.into(),
        }
    }

    #[test]
    fn screen_paths_are_per_sandbox_and_never_traverse() {
        let paths = Paths::under(Path::new("/tmp/os"));
        assert_eq!(
            directory(&paths, "work").unwrap(),
            Path::new("/tmp/os/run/user/1990/intentic/screen/work")
        );
        for slug in ["../work", "/work", "work/other", "", "a..b"] {
            assert!(directory(&paths, slug).is_err());
        }
    }

    #[test]
    fn only_a_desktop_release_enables_screen_mounts() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        fs::create_dir_all(paths.release().parent().unwrap()).unwrap();
        for (text, enabled) in [
            (r#"{"edition":"desktop"}"#, true),
            (r#"{"edition":"server"}"#, false),
            ("{}", false),
            ("broken", false),
        ] {
            fs::write(paths.release(), text).unwrap();
            assert_eq!(desktop_edition(&paths), enabled);
        }
    }

    #[test]
    fn only_running_inspected_containers_outside_kata_get_sockets() {
        let seen = [
            seen("work", true),
            seen("held", false),
            seen("vm", true),
            seen("missing", true),
            seen("../escape", true),
        ];
        assert_eq!(wanted(&seen, "/intentic-sandbox-work\tid1\trunc\n/intentic-sandbox-held\tid2\trunc\n/intentic-sandbox-vm\tid3\tkata\n"),
            BTreeMap::from([("work".into(), sandbox("work", "id1"))]));
    }

    #[test]
    fn diff_stops_removed_and_replaced_instances_and_repairs_vanished_sockets() {
        let old = BTreeMap::from([
            ("work".into(), sandbox("work", "old")),
            ("stopped".into(), sandbox("stopped", "id")),
            ("lost".into(), sandbox("lost", "id")),
        ]);
        let wanted = BTreeMap::from([
            ("work".into(), sandbox("work", "new")),
            ("lost".into(), sandbox("lost", "id")),
            ("fresh".into(), sandbox("fresh", "id")),
        ]);
        assert_eq!(
            changes(
                &wanted,
                &old,
                &BTreeSet::from(["work".into(), "stopped".into()])
            ),
            (
                vec!["lost".into(), "stopped".into(), "work".into()],
                vec![
                    sandbox("fresh", "id"),
                    sandbox("lost", "id"),
                    sandbox("work", "new")
                ]
            )
        );
        assert_eq!(
            changes(&wanted, &wanted, &wanted.keys().cloned().collect()),
            (vec![], vec![])
        );
    }

    #[test]
    fn a_stale_status_file_without_the_service_lock_is_not_available() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        fs::create_dir_all(root(&paths)).unwrap();
        let file = File::create(root(&paths).join("serve.lock")).unwrap();
        assert!(!serving(&paths));
        file.try_lock().unwrap();
        assert!(serving(&paths));
        drop(file);
        assert!(!serving(&paths));
    }
}
