use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intentic_sway_ipc as ipc;
use serde_json::{json, Value};

use super::Paths;
use crate::sandbox::listing::{self, Seen};
use crate::util::{bail, Fail, Result};

mod wayland;

/* SANDBOX WINDOWS ON THIS COMPUTER'S SCREEN (desktop edition).

`ic os screen serve` runs inside the sway session and gives a running sandbox a Wayland socket of its own through
security-context-v1, so every window it opens is tagged by sway with the sandbox's slug and denied the protocols that
would let it read or drive anything else (wayland.rs). Three rules hold it, all here, in the one process that hands the
sockets out:

- OFF UNTIL THE OWNER SAYS. A sandbox draws only once the owner allows it (This computer, or `ic os screen allow`);
  the list is `/var/lib/intentic-os/screen-allowed.json`, empty on a new machine. Every sandbox gets the (empty,
  read-only) socket folder mounted when it is made (policy.rs), so allowing or denying one takes effect within a few
  seconds, with no recreate, and the sandbox can never write into the session's runtime folder.
- NEVER THE WHOLE SCREEN. A sandbox window wears an amber frame and its sandbox's name (the sway config's
  50-sandbox-windows.conf); fullscreen would hide both, and the bar, and let it pass for the system. sway grants any
  client's fullscreen request, so this service watches sway's window events and takes it back at once.
- NOTHING SERVED UNWATCHED. While that watch is down (sway restarting, its IPC refusing) every socket is closed, and a
  window from a sandbox that may no longer draw is closed too. The sockets are never available without the rules. */

/// The security context's engine: what sway tags every window from a sandbox's socket with (`sandbox_engine`).
pub const ENGINE: &str = "dev.intentic.sandbox";

const POLL: Duration = Duration::from_secs(3);
const DOCKER_LIMIT: Duration = Duration::from_secs(20);

/// The session's runtime folder for the screen sockets. The directory, rather than its socket, is mounted into a
/// sandbox: a listener replaced after a sway restart then reaches containers already running. Only security-context
/// listeners ever go here, never sway's own socket.
fn session_folder(paths: &Paths) -> PathBuf {
    paths.at(&format!("/run/user/{}/intentic", super::tool::INTENTIC_UID))
}

fn root(paths: &Paths) -> PathBuf {
    session_folder(paths).join("screen")
}

fn grants_file(paths: &Paths) -> PathBuf {
    paths.at("/var/lib/intentic-os/screen-allowed.json")
}

/// A slug can never choose a directory outside this sandbox's own mount. Pure.
pub fn directory(paths: &Paths, slug: &str) -> Result<PathBuf> {
    if !crate::sandbox::is_slug(slug) {
        bail!("{slug:?} is not a sandbox slug; no screen directory was made.");
    }
    Ok(root(paths).join(slug))
}

/// Whether a container runtime lets a Unix socket from the host cross into the sandbox: not Kata's microVM, where it
/// would take waypipe over vsock, which is not built. The one answer both the run policy and the service use. Pure.
pub fn shares_sockets(runtime: &str) -> bool {
    !runtime.starts_with("kata")
}

/// The sandboxes the owner lets draw here: none until they say so. A list that cannot be read lets none draw. Pure.
fn allowed_in(text: Option<Value>) -> BTreeSet<String> {
    text.as_ref()
        .and_then(|grants| grants["allowed"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|slug| crate::sandbox::is_slug(slug))
        .map(str::to_string)
        .collect()
}

pub fn allowed(paths: &Paths) -> BTreeSet<String> {
    allowed_in(super::read_json(&grants_file(paths)))
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
    let uid = super::tool::INTENTIC_UID;
    std::os::unix::fs::chown(path, Some(uid), Some(uid))
        .and_then(|()| fs::set_permissions(path, fs::Permissions::from_mode(0o700)))
        .map_err(|err| {
            Fail(format!(
                "Could not give {} to intentic: {err}.",
                path.display()
            ))
        })
}

fn prepare_root(paths: &Paths) -> Result<()> {
    private_directory(&session_folder(paths))?;
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

/// The running primary containers whose sockets can cross the container boundary and whose owner lets them draw.
/// Docker's runtime is inspected rather than guessed from today's policy: containers started under yesterday's policy
/// may still run. Pure.
fn wanted(seen: &[Seen], inspected: &str, allowed: &BTreeSet<String>) -> BTreeMap<String, Sandbox> {
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
        .filter(|sandbox| allowed.contains(&sandbox.slug))
        .filter_map(|sandbox| {
            let (id, runtime) = containers.get(sandbox.container.as_str())?;
            (!id.is_empty() && shares_sockets(runtime)).then(|| {
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

/// What sway is told about one window: nothing for a window that is not a sandbox's; a sandbox window whose owner has
/// not let it draw (never, or not any more) is closed; any other is taken out of fullscreen, where it would hide the
/// bar and its own frame and pass for the system. The sandbox is the one sway attests, never the window's own app id.
/// Pure.
fn window_rules(window: &Value, allowed: &BTreeSet<String>) -> Vec<String> {
    if window["sandbox_engine"] != ENGINE {
        return Vec::new();
    }
    let Some(id) = window["id"].as_i64().filter(|id| *id > 0) else {
        return Vec::new();
    };
    let slug = window["sandbox_app_id"].as_str();
    if slug.is_none_or(|slug| !allowed.contains(slug)) {
        return vec![format!("[con_id={id}] kill")];
    }
    if window["fullscreen_mode"].as_u64().unwrap_or(0) > 0 {
        return vec![format!("[con_id={id}] fullscreen disable")];
    }
    Vec::new()
}

/// The rules for every window on screen. Pure.
fn tree_rules(tree: &Value, allowed: &BTreeSet<String>) -> Vec<String> {
    ipc::windows(tree)
        .into_iter()
        .flat_map(|window| window_rules(window, allowed))
        .collect()
}

fn enforce(sway: &Path, commands: &[String]) {
    if !commands.is_empty() {
        // A window that closed meanwhile refuses its command; the rest still ran, and the next look covers it.
        let _ = ipc::command(sway, &commands.join("; "));
    }
}

/// The sockets handed out, with the listener that keeps each accepting. Shared with the watch, which closes them all
/// the moment it stops.
type Served = Arc<Mutex<BTreeMap<String, (Sandbox, wayland::Listener)>>>;

/// Subscribe to sway's window events and hold every new or changed sandbox window to its rules on a thread of its
/// own, so a fullscreen request is taken back as sway reports it rather than at the next look. Returns once the
/// subscription stands; `watching` goes false, and every socket closes, the moment it falls.
fn watch(paths: &Paths, sway: &Path, served: &Served, watching: &Arc<AtomicBool>) -> Result<()> {
    let mut events = ipc::subscribe(sway, &["window"]).map_err(|err| {
        Fail(format!(
            "The screen service could not watch sway's windows: {err}."
        ))
    })?;
    watching.store(true, Ordering::SeqCst);
    let (paths, sway, served, watching) = (
        paths.clone(),
        sway.to_path_buf(),
        Arc::clone(served),
        Arc::clone(watching),
    );
    std::thread::spawn(move || {
        while let Ok((kind, event)) = ipc::read_frame(&mut events) {
            if kind == ipc::EVENT_WINDOW {
                enforce(&sway, &window_rules(&event["container"], &allowed(&paths)));
            }
        }
        // Closed before the flag drops, so no socket outlives the rules even for the main loop's next tick.
        served.lock().expect("served").clear();
        watching.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// Every sandbox on the machine, and `docker inspect`'s name, id and runtime for each one running.
fn look() -> Result<(Vec<Seen>, String)> {
    let seen = listing::seen()?;
    let running: Vec<&str> = seen
        .iter()
        .filter(|sandbox| sandbox.running)
        .map(|sandbox| sandbox.container.as_str())
        .collect();
    if running.is_empty() {
        return Ok((seen, String::new()));
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
    Ok((seen, ran.stdout))
}

fn socket_exists(directory: &Path) -> bool {
    fs::symlink_metadata(directory.join("wayland-0"))
        .is_ok_and(|metadata| metadata.file_type().is_socket())
}

/// One row per sandbox on the machine: whether its owner lets it draw, and whether it has a live socket now. Pure but
/// for the socket's file, which `socket` answers.
fn rows(seen: &[Seen], allowed: &BTreeSet<String>, socket: impl Fn(&Seen) -> bool) -> Vec<Value> {
    seen.iter()
        .map(|sandbox| {
            json!({
                "slug": sandbox.slug,
                "allowed": allowed.contains(&sandbox.slug),
                "socket": sandbox.running && allowed.contains(&sandbox.slug) && socket(sandbox),
            })
        })
        .collect()
}

fn body(reason: Option<&str>, rows: Vec<Value>) -> Value {
    json!({ "available": reason.is_none(), "reason": reason, "sandboxes": rows })
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

const NOT_RUNNING: &str = "The screen service is not running.";

/// `ic os screen status [--json]`: `{"available", "reason", "sandboxes": [{"slug", "allowed", "socket"}]}`, every
/// sandbox on this machine whether it may draw or not, so This computer can offer the switch for each.
pub fn status(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    super::sway::require_screen()?;
    let paths = Paths::here();
    let seen = listing::seen();
    let recorded = super::read_json(&root(&paths).join("status.json"));
    let reason = if let Err(err) = &seen {
        Some(err.0.clone())
    } else if !serving(&paths) {
        Some(
            recorded
                .as_ref()
                .filter(|value| value["available"] == false)
                .and_then(|value| value["reason"].as_str())
                .unwrap_or(NOT_RUNNING)
                .to_string(),
        )
    } else {
        recorded
            .as_ref()
            .and_then(|value| value["reason"].as_str())
            .map(str::to_string)
    };
    let registered: BTreeSet<String> = recorded
        .as_ref()
        .and_then(|value| value["sandboxes"].as_array())
        .into_iter()
        .flatten()
        .filter(|sandbox| sandbox["socket"] == true)
        .filter_map(|sandbox| sandbox["slug"].as_str().map(str::to_string))
        .collect();
    let seen = seen.unwrap_or_default();
    let allowed = allowed(&paths);
    let value = body(
        reason.as_deref(),
        rows(&seen, &allowed, |sandbox| {
            reason.is_none()
                && registered.contains(&sandbox.slug)
                && directory(&paths, &sandbox.slug).is_ok_and(|dir| socket_exists(&dir))
        }),
    );
    if json {
        super::emit_json(&value);
    } else {
        if let Some(reason) = value["reason"].as_str() {
            crate::ui::note(reason);
        }
        let allowed: Vec<&str> = allowed.iter().map(String::as_str).collect();
        crate::ui::note(&if allowed.is_empty() {
            "No sandbox may show windows on this screen.".to_string()
        } else {
            format!("Sandboxes that may show windows: {}.", allowed.join(", "))
        });
    }
    Ok(())
}

/// `ic os screen allow|deny <slug>`: the owner's word on whether a sandbox may draw. Taken up by the running service
/// within a few seconds: a socket opens, or closes along with every window the sandbox has open.
pub fn set_allowed(slug: &str, allow: bool) -> Result<()> {
    super::sway::require_screen()?;
    if !crate::sandbox::is_slug(slug) {
        bail!("{slug:?} is not a sandbox slug.");
    }
    let paths = Paths::here();
    if allow && !listing::seen()?.iter().any(|sandbox| sandbox.slug == slug) {
        bail!("There is no sandbox called {slug} on this computer.");
    }
    let mut slugs = allowed(&paths);
    let changed = if allow {
        slugs.insert(slug.to_string())
    } else {
        slugs.remove(slug)
    };
    if changed {
        super::write_atomic(
            &grants_file(&paths),
            format!("{}\n", json!({ "allowed": slugs })).as_bytes(),
        )?;
    }
    crate::ui::done(&if allow {
        format!("{slug} may show windows on this computer's screen.")
    } else {
        format!("{slug} may no longer show windows on this computer's screen; any it has open are closed.")
    });
    Ok(())
}

pub fn serve() -> Result<()> {
    let paths = Paths::here();
    super::sway::require_screen()?;
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
            Some("The screen service is connecting to sway."),
            Vec::new(),
        ),
    )?;
    let result = serve_session(&paths);
    if let Err(err) = &result {
        record(&paths, &body(Some(&err.0), Vec::new()))?;
    }
    result
}

/// The first sway that names a window's security context, which the sandbox-window rules match on (sway 1.11).
const MARKING_SWAY: (u64, u64) = (1, 11);

fn serve_session(paths: &Paths) -> Result<()> {
    let sway = super::sway::require_socket()?;
    // An older sway would show sandbox windows with no frame and no name: indistinguishable from the system's own.
    let version = ipc::request(&sway, ipc::GET_VERSION, "").map_err(|err| {
        Fail(format!(
            "The screen service could not ask sway its version: {err}."
        ))
    })?;
    if !ipc::at_least(&version, MARKING_SWAY.0, MARKING_SWAY.1) {
        bail!(
            "sway {} cannot mark sandbox windows (that takes {}.{}), so none are shown.",
            version["human_readable"].as_str().unwrap_or("of this age"),
            MARKING_SWAY.0,
            MARKING_SWAY.1
        );
    }
    let mut compositor = wayland::Compositor::connect()?;
    let served: Served = Arc::default();
    let watching = Arc::new(AtomicBool::new(false));
    loop {
        // Roundtrips notice a dead compositor even on an otherwise idle machine. The wrapper starts us again with
        // the next session; dropping each close endpoint stops sway accepting through that listener.
        compositor.sync()?;
        if !watching.load(Ordering::SeqCst) {
            served.lock().expect("served").clear();
            if let Err(err) = watch(paths, &sway, &served, &watching) {
                record(paths, &body(Some(&err.0), Vec::new()))?;
                std::thread::sleep(POLL);
                continue;
            }
        }
        let allowed = allowed(paths);
        // Every look also squares the windows already open with the rules: those from before a (re)subscription, and
        // a sandbox's windows once its owner has stopped letting it draw.
        if let Ok(tree) = ipc::request(&sway, ipc::GET_TREE, "") {
            enforce(&sway, &tree_rules(&tree, &allowed));
        }
        let (seen, inspected) = match look() {
            Ok(found) => found,
            Err(err) => {
                served.lock().expect("served").clear();
                record(paths, &body(Some(&err.0), Vec::new()))?;
                std::thread::sleep(POLL);
                continue;
            }
        };
        let wanted = wanted(&seen, &inspected, &allowed);
        {
            let mut served = served.lock().expect("served");
            let current: BTreeMap<String, Sandbox> = served
                .iter()
                .map(|(slug, (sandbox, _))| (slug.clone(), sandbox.clone()))
                .collect();
            let present = current
                .keys()
                .filter(|slug| directory(paths, slug).is_ok_and(|dir| socket_exists(&dir)))
                .cloned()
                .collect();
            let (remove, start) = changes(&wanted, &current, &present);
            for slug in remove {
                served.remove(&slug);
            }
            // A watch that fell since the check above has cleared the map: open nothing until it stands again.
            if watching.load(Ordering::SeqCst) {
                for sandbox in start {
                    let result = prepare_directory(paths, &sandbox.slug)
                        .and_then(|dir| compositor.listen(&dir, &sandbox));
                    match result {
                        Ok(listener) => {
                            served.insert(sandbox.slug.clone(), (sandbox, listener));
                        }
                        Err(err) => crate::ui::warn(&format!(
                            "{} has no screen socket: {}",
                            sandbox.slug, err.0
                        )),
                    }
                }
            }
            let live: BTreeSet<&String> = served.keys().collect();
            record(
                paths,
                &body(
                    None,
                    rows(&seen, &allowed, |sandbox| {
                        live.contains(&sandbox.slug)
                            && directory(paths, &sandbox.slug).is_ok_and(|dir| socket_exists(&dir))
                    }),
                ),
            )?;
        }
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

    fn slugs(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| name.to_string()).collect()
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
    fn only_a_desktop_release_has_a_screen() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::under(dir.path());
        fs::create_dir_all(paths.release().parent().unwrap()).unwrap();
        for (text, screen) in [
            (r#"{"edition":"desktop"}"#, true),
            (r#"{"edition":"server"}"#, false),
            ("{}", false),
            ("broken", false),
        ] {
            fs::write(paths.release(), text).unwrap();
            assert_eq!(super::super::has_screen(&paths), screen);
        }
    }

    #[test]
    fn no_sandbox_may_draw_until_the_owner_says_and_a_list_that_cannot_be_read_allows_none() {
        assert!(allowed_in(None).is_empty());
        assert!(allowed_in(Some(json!("broken"))).is_empty());
        assert!(allowed_in(Some(json!({"allowed": "work"}))).is_empty());
        assert_eq!(
            allowed_in(Some(json!({"allowed": ["work", "../escape", 7, "lab"]}))),
            slugs(&["lab", "work"])
        );
    }

    #[test]
    fn only_allowed_running_inspected_containers_outside_kata_get_sockets() {
        let seen = [
            seen("work", true),
            seen("held", false),
            seen("vm", true),
            seen("missing", true),
            seen("../escape", true),
            seen("unasked", true),
        ];
        let inspected = "/intentic-sandbox-work\tid1\trunc\n/intentic-sandbox-held\tid2\trunc\n/intentic-sandbox-vm\tid3\tkata\n/intentic-sandbox-unasked\tid4\trunc\n";
        let everyone = slugs(&["work", "held", "vm", "missing", "../escape", "unasked"]);
        assert_eq!(
            wanted(&seen, inspected, &slugs(&["work", "held", "vm", "missing"])),
            BTreeMap::from([("work".into(), sandbox("work", "id1"))])
        );
        assert_eq!(wanted(&seen, inspected, &everyone).len(), 2);
        assert!(wanted(&seen, inspected, &BTreeSet::new()).is_empty());
    }

    #[test]
    fn the_run_policy_and_the_service_agree_on_which_runtimes_take_a_socket() {
        for runtime in ["runc", "crun", "runsc", "io.containerd.runc.v2", ""] {
            assert!(shares_sockets(runtime), "{runtime}");
        }
        for runtime in ["kata", "kata-qemu", "kata-fc"] {
            assert!(!shares_sockets(runtime), "{runtime}");
        }
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
    fn sandbox_windows_never_stay_fullscreen_and_close_once_their_sandbox_may_not_draw() {
        let allowed = slugs(&["work"]);
        let window = |extra: Value| {
            let mut window = json!({"id": 42, "sandbox_engine": ENGINE, "sandbox_app_id": "work", "fullscreen_mode": 0, "app_id": "anything"});
            for (key, value) in extra.as_object().unwrap() {
                window[key] = value.clone();
            }
            window
        };
        assert_eq!(
            window_rules(&window(json!({})), &allowed),
            Vec::<String>::new()
        );
        assert_eq!(
            window_rules(&window(json!({"fullscreen_mode": 1})), &allowed),
            vec!["[con_id=42] fullscreen disable"]
        );
        assert_eq!(
            window_rules(&window(json!({"fullscreen_mode": 2})), &allowed),
            vec!["[con_id=42] fullscreen disable"]
        );
        // A sandbox the owner has not let draw, or no longer does: closed, fullscreen or not.
        assert_eq!(
            window_rules(
                &window(json!({"sandbox_app_id": "other", "fullscreen_mode": 1})),
                &allowed
            ),
            vec!["[con_id=42] kill"]
        );
        assert_eq!(
            window_rules(&window(json!({"sandbox_app_id": null})), &allowed),
            vec!["[con_id=42] kill"]
        );
        // The window's own app id says nothing: only what sway attests counts.
        assert_eq!(
            window_rules(
                &window(json!({"sandbox_app_id": "other", "app_id": "work"})),
                &allowed
            ),
            vec!["[con_id=42] kill"]
        );
        // Not a sandbox's window (the app, Chromium): never touched, even fullscreen.
        for other in [
            json!({"sandbox_engine": null}),
            json!({"sandbox_engine": "org.flatpak"}),
        ] {
            let mut foreign = window(json!({"fullscreen_mode": 1}));
            foreign["sandbox_engine"] = other["sandbox_engine"].clone();
            assert_eq!(window_rules(&foreign, &allowed), Vec::<String>::new());
        }
        assert_eq!(
            window_rules(&window(json!({"id": null})), &allowed),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_whole_tree_is_squared_with_the_rules_tiled_and_floating() {
        let tree = json!({"type":"root","nodes":[{"type":"workspace",
            "nodes":[{"type":"con","id":2,"pid":1,"sandbox_engine":ENGINE,"sandbox_app_id":"work","fullscreen_mode":1},
                     {"type":"con","id":3,"pid":1,"app_id":"intentic","fullscreen_mode":0}],
            "floating_nodes":[{"type":"floating_con","id":4,"pid":2,"sandbox_engine":ENGINE,"sandbox_app_id":"gone","fullscreen_mode":0}]}]});
        assert_eq!(
            tree_rules(&tree, &slugs(&["work"])),
            vec!["[con_id=2] fullscreen disable", "[con_id=4] kill"]
        );
    }

    #[test]
    fn every_sandbox_is_listed_with_whether_it_may_draw_and_has_a_socket() {
        let seen = [seen("work", true), seen("lab", true), seen("held", false)];
        let allowed = slugs(&["work", "held"]);
        let value = body(None, rows(&seen, &allowed, |_| true));
        assert_eq!(
            value,
            json!({"available": true, "reason": null, "sandboxes": [
                {"slug": "work", "allowed": true, "socket": true},
                {"slug": "lab", "allowed": false, "socket": false},
                {"slug": "held", "allowed": true, "socket": false},
            ]})
        );
        assert_eq!(
            body(Some(NOT_RUNNING), Vec::new()),
            json!({"available": false, "reason": NOT_RUNNING, "sandboxes": []})
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
