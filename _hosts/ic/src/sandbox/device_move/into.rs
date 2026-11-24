use std::io::Read;
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::out::accept_within;
use super::stream::Incoming;
use super::wire::{self, Keys, Kind, Role, Session};
use super::{here_target, peer_path, same_sandbox, say, update, Manifest, Plan, VERSION};
use crate::docker::{self, Target};
use crate::engine::moves;
use crate::logfile::{intentic_home, Log};
use crate::sandbox::compose_out::{self, HostStamps};
use crate::sandbox::{at_rest, container_of, is_slug, labels, parked_of, side, takeover};
use crate::util::{bail, Fail, Result};

/* THE TARGET'S HALF (`ic sandbox move-in`). Everything that can fail without the sandbox stopping fails here first, while
the source still runs: docker answers, no sandbox of that name is here, no different at-rest key for it is here, its
volumes are free, the disk has room, the base image is pulled by the digest the source runs and the overlay built from
the recipe the image's tag names. Only then does it listen, print its public key and wait for the source. */

/// How long a prepared target waits for its source to connect and prove itself.
const CONNECT_WAIT: Duration = Duration::from_secs(15 * 60);
/// How long the source's key may take to reach this run once a greeting is in (`move-in --peer`).
const PEER_WAIT: Duration = Duration::from_secs(3 * 60);
/// How long a started sandbox has to say its tunnel is up.
const TUNNEL_WAIT: Duration = Duration::from_secs(10 * 60);
/// How long the stream may say nothing: the source measures and lists each volume (`du`, the file manifest) before
/// its first byte, which takes minutes on a large one; its own reader is killed if it stalls (stream.rs).
const QUIET: Duration = Duration::from_secs(60 * 60);
/// Greetings from strangers tolerated before the move gives up on the port.
const MAX_STRANGERS: u32 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Manager {
    Ic,
    Compose,
}

impl Manager {
    pub fn parse(word: &str) -> Option<Manager> {
        match word {
            "ic" => Some(Manager::Ic),
            "compose" => Some(Manager::Compose),
            _ => None,
        }
    }
}

pub struct InArgs {
    pub slug: String,
    pub move_id: String,
    /// The source's plan, as JSON, or `-` for stdin.
    pub plan: Option<String>,
    pub peer: Option<String>,
    pub manager: String,
}

pub fn run(args: InArgs) -> Result<()> {
    super::check_move_id(&args.move_id)?;
    if !is_slug(&args.slug) {
        bail!("'{}' is not a sandbox name.", args.slug);
    }
    if let Some(peer) = &args.peer {
        return super::hand_peer(&args.slug, &args.move_id, peer);
    }
    let Some(manager) = Manager::parse(&args.manager) else {
        bail!("--manager is `ic` or `compose`, not '{}'.", args.manager);
    };
    let text = match args.plan.as_deref() {
        Some("-") => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text)?;
            text
        }
        Some(text) => text.to_string(),
        None => bail!("hand the source's plan with --plan (JSON, or - for stdin)."),
    };
    let plan: Plan = serde_json::from_str(&text)
        .map_err(|err| Fail(format!("the plan is not readable: {err}")))?;
    if plan.v > VERSION {
        bail!("the other computer's ic is newer than this one: update ic here (it updates with this computer's agent), then move again.");
    }
    if plan.slug != args.slug {
        bail!("the plan is for {}, not {}.", plan.slug, args.slug);
    }
    docker::require_daemon()?;
    super::recover();
    let log = Log::create_named("move", &format!("move-in-{}", args.slug))?;
    update(&args.move_id, |attempt| {
        attempt.slug = args.slug.clone();
        attempt.role = "target".into();
    })?;
    let beating = super::beat(&args.move_id);
    let received = receive(&args.move_id, &plan, manager, &log);
    drop(beating);
    let _ = std::fs::remove_file(peer_path(&args.move_id));
    match received {
        Ok(()) => {
            super::finish(&args.move_id);
            Ok(())
        }
        Err(Fail(reason)) => {
            if let Some(attempt) = super::load()
                .attempts
                .into_iter()
                .find(|a| a.move_id == args.move_id)
            {
                super::remove_made(&attempt, &here_target());
            }
            super::finish(&args.move_id);
            say(&args.slug, "failed", json!({ "reason": reason }));
            bail!(
                "{} was not moved here: {reason} What this computer made for it is removed.",
                args.slug
            )
        }
    }
}

fn receive(move_id: &str, plan: &Plan, manager: Manager, log: &Log) -> Result<()> {
    let slug = &plan.slug;
    say(slug, "checking", json!({}));
    let need_image = prepare(plan, log)?;
    let keys = Keys::generate()?;
    let listener = TcpListener::bind(("0.0.0.0", 0))?;
    let port = listener.local_addr()?.port();
    say(
        slug,
        "ready",
        json!({ "publicKey": wire::encode_key(&keys.public), "listen": lan_addresses(port), "port": port }),
    );
    let (mut connection, mut session) = admit(&listener, keys, move_id)?;
    // Past here, a failure is told to the source as the verdict it waits for, so it starts its sandbox again at once.
    let made = (|| -> Result<String> {
        session.send.send(
            &mut connection,
            Kind::Ack,
            json!({ "ready": true, "needImage": need_image })
                .to_string()
                .as_bytes(),
        )?;
        let carried = take_stream(&mut session, &mut connection, move_id, plan)?;
        make(move_id, plan, &carried, manager, log)
    })();
    match made {
        Ok(host) => {
            let verdict = json!({ "ok": true, "host": host });
            let told = session.send.send(
                &mut connection,
                Kind::Verdict,
                verdict.to_string().as_bytes(),
            );
            if told.is_ok() {
                let _ = session.receive.next(&mut connection);
            } else {
                crate::ui::warn(&format!(
                    "{slug} is up here, but the other computer could not be told: it keeps its copy stopped until somebody looks."
                ));
            }
            say(slug, "moved", json!({ "host": host }));
            crate::ui::done(&format!("{slug} moved here from {} and is up.", plan.from));
            Ok(())
        }
        Err(Fail(reason)) => {
            let verdict = json!({ "ok": false, "reason": reason });
            let _ = session.send.send(
                &mut connection,
                Kind::Verdict,
                verdict.to_string().as_bytes(),
            );
            let _ = session.send.end(&mut connection);
            Err(Fail(reason))
        }
    }
}

/* ——— Before anything stops on the source. ——— */

/// Every check and download that can happen while the source still runs. Answers whether the image must ride the
/// stream after all.
fn prepare(plan: &Plan, log: &Log) -> Result<bool> {
    let slug = &plan.slug;
    let on = here_target();
    for name in [container_of(slug), parked_of(slug)] {
        if docker::container_exists(&name) {
            bail!("a sandbox {slug} is already on this computer ({name}). Remove it here first if this move is to replace it.");
        }
    }
    let key_path = at_rest::sandbox_key(slug);
    if let Ok(existing) = std::fs::read(&key_path) {
        if at_rest::key_id_of(&existing) != plan.key_id {
            bail!(
                "this computer already holds a different at-rest key for {slug} ({}), and a key is never overwritten: it may be the only one that opens something. Move it aside if it is no longer needed, then move again.",
                key_path.display()
            );
        }
    }
    let base_here =
        |digest: &str| moves::repo_digest(&on, &plan.base_image).as_deref() == Some(digest);
    say(slug, "pulling", json!({ "image": plan.base_image }));
    let base_ok = match &plan.base_digest {
        Some(digest) => {
            base_here(digest) || moves::pull_as(&on, digest, &plan.base_image, slug, log)
        }
        None => docker::image_exists(&plan.base_image),
    };
    let mut need_image = false;
    if plan.image == plan.base_image {
        need_image = !base_ok;
    } else if docker::image_exists(&plan.image) && !plan.carry_image {
        // Already here: the same tag names the same recipe on the same base.
    } else if let Some(digest) = &plan.image_digest {
        if !moves::pull_as(&on, digest, &plan.image, slug, log) {
            need_image = true;
        }
    } else if let (Some(recipe), true) = (&plan.recipe, base_ok) {
        say(slug, "building", json!({ "image": plan.image }));
        build(slug, &plan.image, &plan.base_image, recipe, log)?;
    } else {
        need_image = true;
    }
    if need_image {
        say(
            slug,
            "image",
            json!({ "image": plan.image, "carried": true }),
        );
    }
    let helper = [&plan.image, &plan.base_image]
        .into_iter()
        .find(|image| docker::image_exists(image))
        .cloned();
    for volume in &plan.volumes {
        free_volume(&on, slug, &volume.name, helper.as_deref())?;
    }
    if let Some(helper) = &helper {
        if let Some(free) = free_bytes(&on, helper) {
            let needed = plan.bytes.saturating_add(moves::SPARE_BYTES);
            if free < needed {
                bail!(
                    "this computer has {:.1} GB free where docker keeps volumes, and {slug} needs about {:.1} GB. Free some space, then move again.",
                    free as f64 / 1e9,
                    needed as f64 / 1e9
                );
            }
        }
    }
    Ok(need_image)
}

/// The overlay built here from the recipe the source's image was built from, under the very tag it runs.
fn build(slug: &str, image: &str, base: &str, recipe: &str, log: &Log) -> Result<()> {
    let from = crate::sandbox::recreate::overlay_base(recipe).unwrap_or_else(|| base.to_string());
    if from != base && !docker::image_exists(&from) {
        docker::quiet(&["tag", base, &from]);
    }
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("overlay.Dockerfile");
    std::fs::write(&path, recipe)?;
    crate::sandbox::recreate::build_overlay(image, slug, &path, false, &from, log)
}

/// A volume of the sandbox's name already here: one this computer kept when the sandbox moved AWAY from it (superseded
/// now, with the copy it belonged to), an empty one, or somebody's data, which is refused.
fn free_volume(on: &Target, slug: &str, volume: &str, helper: Option<&str>) -> Result<()> {
    let exists = docker::capture_on(on, &["volume", "inspect", volume], docker::READ_LIMIT)
        .is_ok_and(|ran| ran.code == Some(0));
    if !exists {
        return Ok(());
    }
    let left_here = moves::load_journal().moved.into_iter().find(|moved| {
        !moved.removed
            && moved.slug == slug
            && moved.from == moves::DEVICE_FROM
            && moved.volumes.iter().any(|v| v == volume)
    });
    if let Some(moved) = left_here {
        for container in &moved.containers {
            let _ = docker::capture_on(on, &["rm", "-f", container], docker::READ_LIMIT);
        }
        moves::run_on(on, &["volume", "rm", volume], docker::READ_LIMIT)?;
        return Ok(());
    }
    let empty = helper.is_some_and(|helper| volume_empty(on, volume, helper));
    if !empty {
        bail!("a volume named {volume} already holds data on this computer, and no earlier move left it here. Remove or rename it, then move again.");
    }
    moves::run_on(on, &["volume", "rm", volume], docker::READ_LIMIT)
}

fn volume_empty(on: &Target, volume: &str, helper: &str) -> bool {
    let mount = format!("{volume}:/v:ro");
    docker::capture_on(
        on,
        &[
            "run",
            "--rm",
            "--network",
            "none",
            "--log-driver",
            "none",
            "-v",
            &mount,
            "--entrypoint",
            "sh",
            helper,
            "-c",
            "ls -A /v | head -c 1",
        ],
        Duration::from_secs(120),
    )
    .is_ok_and(|ran| ran.code == Some(0) && ran.stdout.trim().is_empty())
}

/// Free bytes where docker keeps its volumes, measured from inside a fresh one.
fn free_bytes(on: &Target, helper: &str) -> Option<u64> {
    let probe = format!("intentic-move-probe-{}", std::process::id());
    let mount = format!("{probe}:/probe");
    let ran = docker::capture_on(
        on,
        &[
            "run",
            "--rm",
            "--network",
            "none",
            "--log-driver",
            "none",
            "-v",
            &mount,
            "--entrypoint",
            "df",
            helper,
            "-B1",
            "--output=avail",
            "/probe",
        ],
        Duration::from_secs(120),
    );
    let _ = docker::capture_on(on, &["volume", "rm", "-f", &probe], docker::READ_LIMIT);
    ran.ok()
        .filter(|ran| ran.code == Some(0))
        .and_then(|ran| ran.stdout.lines().last()?.trim().parse().ok())
}

/// The addresses this computer is reached at on its network, for the source's direct dial: the one its default route
/// leaves from (asked of the operating system with a UDP socket that sends nothing). Never loopback, which on the source
/// would be the source itself.
fn lan_addresses(port: u16) -> Vec<String> {
    let mut found = Vec::new();
    for (bind, probe) in [("0.0.0.0:0", "192.0.2.1:9"), ("[::]:0", "[2001:db8::1]:9")] {
        let Ok(socket) = UdpSocket::bind(bind) else {
            continue;
        };
        if socket.connect(probe).is_err() {
            continue;
        }
        if let Ok(local) = socket.local_addr() {
            let ip = local.ip();
            if !ip.is_loopback() && !ip.is_unspecified() {
                found.push(std::net::SocketAddr::new(ip, port).to_string());
            }
        }
    }
    found
}

/// Take connections until one is the source this move was set up with; a stranger's is dropped before any agreement.
fn admit(listener: &TcpListener, keys: Keys, move_id: &str) -> Result<(TcpStream, Session)> {
    let started = Instant::now();
    let mut strangers = 0;
    loop {
        let left = CONNECT_WAIT.saturating_sub(started.elapsed());
        let Some(mut connection) = accept_within(listener, left)? else {
            bail!(
                "the other computer never connected (waited {} minutes).",
                CONNECT_WAIT.as_secs() / 60
            );
        };
        connection.set_read_timeout(Some(PEER_WAIT))?;
        connection.set_write_timeout(Some(moves::STALL))?;
        let checked = wire::greet(&mut connection, &keys.public, Role::Target, move_id)
            .and_then(|theirs| Ok((theirs, wait_peer(move_id)?)));
        match checked {
            Ok((theirs, wanted)) if wire::is_expected(&theirs, &wanted) => {
                connection.set_read_timeout(Some(QUIET))?;
                let session = wire::agree(keys, &theirs, Role::Target, move_id)?;
                return Ok((connection, session));
            }
            Ok(_) | Err(_) => {
                strangers += 1;
                if strangers >= MAX_STRANGERS {
                    bail!("{MAX_STRANGERS} connections that were not the source of this move: giving up on it.");
                }
            }
        }
    }
}

/// The source's key, once the daemon has handed it over (`move-in --peer`).
fn wait_peer(move_id: &str) -> Result<[u8; 32]> {
    let path = peer_path(move_id);
    let started = Instant::now();
    loop {
        if let Some(key) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| wire::decode_key(&text))
        {
            return Ok(key);
        }
        if started.elapsed() > PEER_WAIT {
            bail!("the source's key never reached this computer.");
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/* ——— The stream. ——— */

/// What arrived beside the volumes.
struct Carried {
    manifest: Manifest,
    at_rest_key: Option<Vec<u8>>,
    backup_key: Option<Vec<u8>>,
}

enum Section {
    Volume {
        name: String,
        docker_data: bool,
        into: Incoming,
    },
    Image {
        name: String,
        into: Incoming,
    },
}

fn take_stream(
    session: &mut Session,
    connection: &mut TcpStream,
    move_id: &str,
    plan: &Plan,
) -> Result<Carried> {
    let slug = &plan.slug;
    let on = here_target();
    let mut manifest: Option<Manifest> = None;
    let (mut at_rest_key, mut backup_key) = (None, None);
    let mut open: Option<Section> = None;
    let mut last_said = Instant::now();
    let mut done = 0u64;
    let outcome = (|| -> Result<()> {
        loop {
            let (kind, payload) = session.receive.next(connection)?;
            match kind {
                Kind::Manifest => {
                    let arrived: Manifest = serde_json::from_slice(&payload)
                        .map_err(|err| Fail(format!("the manifest is not readable: {err}")))?;
                    if arrived.move_id != move_id {
                        bail!("the stream belongs to another move.");
                    }
                    if let Some(reason) = same_sandbox(plan, &arrived.plan) {
                        bail!("{reason}");
                    }
                    manifest = Some(arrived);
                }
                Kind::Key => match payload.split_first() {
                    Some((1, key)) => at_rest_key = Some(key.to_vec()),
                    Some((2, key)) => backup_key = Some(key.to_vec()),
                    _ => bail!("the other computer sent a key of an unknown kind."),
                },
                Kind::Begin => {
                    if manifest.is_none() || open.is_some() {
                        bail!("the stream is out of order.");
                    }
                    let begin: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
                    let name = begin["name"].as_str().unwrap_or_default().to_string();
                    done = 0;
                    open = Some(match begin["kind"].as_str() {
                        Some("volume") => {
                            let Some(volume) = plan.volumes.iter().find(|v| v.name == name) else {
                                bail!("the stream carries a volume ({name}) the plan never named.");
                            };
                            create_volume(&on, &name, &volume.labels)?;
                            update(move_id, |attempt| attempt.volumes.push(name.clone()))?;
                            let helper = helper_image(plan)?;
                            let writing = moves::helper_name(slug, "write");
                            let _ = docker::capture_on(
                                &on,
                                &["rm", "-f", &writing],
                                docker::READ_LIMIT,
                            );
                            let args = tar_in_args(&writing, &name, volume.docker_data, &helper);
                            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
                            say(
                                slug,
                                "volume",
                                json!({ "volume": name, "done": 0, "total": volume.bytes }),
                            );
                            Section::Volume {
                                docker_data: volume.docker_data,
                                into: Incoming::start(moves::archive_command(&on, &refs))?,
                                name,
                            }
                        }
                        Some("image") if name == plan.image => Section::Image {
                            into: Incoming::start(moves::archive_command(&on, &["load", "-q"]))?,
                            name,
                        },
                        _ => bail!("the stream carries something this ic does not know ({begin})."),
                    });
                }
                Kind::Data => {
                    let Some(section) = open.as_mut() else {
                        bail!("the stream is out of order.");
                    };
                    let (into, step) = match section {
                        Section::Volume { into, .. } => (into, "volume"),
                        Section::Image { into, .. } => (into, "image"),
                    };
                    done = into.write(&payload)?;
                    if last_said.elapsed() > Duration::from_secs(2) {
                        last_said = Instant::now();
                        say(slug, step, json!({ "done": done }));
                    }
                }
                Kind::Finish => {
                    let finish: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
                    match open.take() {
                        Some(Section::Volume {
                            name,
                            docker_data,
                            into,
                        }) => {
                            into.close()
                                .map_err(|Fail(reason)| Fail(format!("{name}: {reason}")))?;
                            let ours =
                                moves::manifest(&on, &name, &helper_image(plan)?, docker_data)?;
                            let theirs = (finish["files"].as_u64(), finish["hash"].as_str());
                            if theirs != (Some(ours.0), Some(ours.1.as_str())) {
                                bail!("the copy of {name} does not match the original ({} files there, {} here).", theirs.0.unwrap_or(0), ours.0);
                            }
                            say(
                                slug,
                                "volume",
                                json!({ "volume": name, "done": done, "files": ours.0, "checked": true }),
                            );
                        }
                        Some(Section::Image { name, into }) => {
                            into.close()
                                .map_err(|Fail(reason)| Fail(format!("{name}: {reason}")))?;
                            if !docker::image_exists(&name) {
                                bail!("{name} did not arrive whole.");
                            }
                        }
                        None => bail!("the stream is out of order."),
                    }
                }
                Kind::End => return Ok(()),
                Kind::Verdict | Kind::Ack => bail!("the source answered out of turn."),
            }
        }
    })();
    if let Err(error) = outcome {
        match open.take() {
            Some(Section::Volume { into, .. }) | Some(Section::Image { into, .. }) => {
                into.abandon()
            }
            None => {}
        }
        let _ = docker::capture_on(
            &on,
            &["rm", "-f", &moves::helper_name(slug, "write")],
            docker::READ_LIMIT,
        );
        return Err(error);
    }
    let Some(manifest) = manifest else {
        bail!("the stream ended without saying what it carried.");
    };
    for volume in &plan.volumes {
        if !super::load()
            .attempts
            .iter()
            .any(|a| a.move_id == move_id && a.volumes.contains(&volume.name))
        {
            bail!("the stream ended without {}.", volume.name);
        }
    }
    Ok(Carried {
        manifest,
        at_rest_key,
        backup_key,
    })
}

fn helper_image(plan: &Plan) -> Result<String> {
    [&plan.image, &plan.base_image]
        .into_iter()
        .find(|image| docker::image_exists(image))
        .cloned()
        .ok_or_else(|| {
            Fail(format!(
                "neither {} nor {} is on this computer to copy with.",
                plan.image, plan.base_image
            ))
        })
}

/// The helper that writes a tar from its stdin into a volume (engine/moves.rs's `copy_volume`, writing end). Pure.
pub fn tar_in_args(name: &str, volume: &str, docker_data: bool, helper: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        "--network",
        "none",
        "--log-driver",
        "none",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if docker_data {
        args.push("--privileged".into());
    }
    args.extend([
        "-v".into(),
        format!("{volume}:/to"),
        "--entrypoint".into(),
        "tar".into(),
        helper.into(),
    ]);
    args.extend(moves::TAR_IN.iter().map(|s| s.to_string()));
    args
}

/// The volume, with the labels it had there and this side named where the source's was.
fn create_volume(
    on: &Target,
    volume: &str,
    given: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    let here = side::here().wire();
    let mut args: Vec<String> = vec!["volume".into(), "create".into()];
    for (key, value) in given {
        let value = if key == labels::SIDE {
            here.as_str()
        } else {
            value.as_str()
        };
        args.extend(["--label".into(), format!("{key}={value}")]);
    }
    args.push(volume.to_string());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    moves::run_on(on, &refs, docker::READ_LIMIT)
}

/* ——— Making it, as this computer's own. ——— */

/// The source's inspect as this machine's: its side stamps (HOST_PLATFORM, HOST_ENV, HOST_ENGINE) and ic's side label
/// dropped, so the recreate stamps this side as it does for a container that names none, and its HOST_LABEL this
/// machine's. Pure.
pub fn restamped(inspect: &Value, label: &str) -> Value {
    let mut inspect = inspect.clone();
    let dropped = ["HOST_PLATFORM=", "HOST_ENV=", "HOST_ENGINE=", "HOST_LABEL="];
    if let Some(env) = inspect["Config"]["Env"].as_array_mut() {
        env.retain(|pair| {
            !pair
                .as_str()
                .is_some_and(|pair| dropped.iter().any(|name| pair.starts_with(name)))
        });
        if !label.is_empty() {
            env.push(Value::String(format!("HOST_LABEL={label}")));
        }
    }
    if let Some(labels) = inspect["Config"]["Labels"].as_object_mut() {
        labels.remove(labels::SIDE);
    }
    inspect
}

/// The record a moved sandbox starts with: what it is and what it was asked to be, nothing about the swaps and
/// versions kept on the computer it left. Pure.
pub fn carried_record(text: &str) -> crate::record::ChannelRecord {
    let was = crate::record::parse(text);
    crate::record::ChannelRecord {
        channel: was.channel,
        current: was.current,
        current_version: was.current_version,
        desired: was.desired,
        egress: was.egress,
        report_key: was.report_key,
        report_platform: was.report_platform,
        ..crate::record::ChannelRecord::default()
    }
}

/// Write a carried key unless this computer already holds the same one; a different one is never overwritten.
fn place_key(move_id: &str, path: &Path, bytes: &[u8], what: &str) -> Result<bool> {
    if at_rest::place(path, bytes)? {
        let file = path.to_string_lossy().to_string();
        update(move_id, |attempt| attempt.files.push(file))?;
        return Ok(true);
    }
    let here = std::fs::read(path).unwrap_or_default();
    if here != bytes
        && at_rest::key_id_of(&here).is_none_or(|id| Some(id) != at_rest::key_id_of(bytes))
    {
        bail!("this computer already holds a different {what} for this sandbox ({}); it is never overwritten.", path.display());
    }
    Ok(false)
}

fn make(
    move_id: &str,
    plan: &Plan,
    carried: &Carried,
    manager: Manager,
    log: &Log,
) -> Result<String> {
    let slug = &plan.slug;
    let on = here_target();
    let container = container_of(slug);
    let label = crate::sandbox::connect::machine_label();
    say(
        slug,
        "creating",
        json!({ "manager": if manager == Manager::Ic { "ic" } else { "compose" } }),
    );

    let key_path = match &carried.at_rest_key {
        Some(key) => {
            if at_rest::key_id_of(key) != plan.key_id {
                bail!("the at-rest key that arrived is not the one the plan named.");
            }
            let path = at_rest::sandbox_key(slug);
            place_key(move_id, &path, key, "at-rest key")?;
            Some(path)
        }
        None => None,
    };
    if let Some(key) = &carried.backup_key {
        let path = crate::sandbox::backup::key_path(slug);
        if let Err(Fail(reason)) = place_key(move_id, &path, key, "backup key") {
            crate::ui::warn(&format!(
                "{reason} Backups made on {} stay readable with its key there.",
                plan.from
            ));
        }
    }
    if let Some(text) = &carried.manifest.record {
        let path = crate::record::record_path(slug);
        if !path.exists() {
            crate::record::write(slug, &carried_record(text))?;
            let file = path.to_string_lossy().to_string();
            update(move_id, |attempt| attempt.files.push(file))?;
        }
    }

    moves::ensure_network_on(&on, slug)?;
    let inspect = restamped(&carried.manifest.inspect, &label);
    let mut create = moves::placeholder_args(&inspect, &container, &plan.image);
    if let (Manager::Compose, Some(key)) = (manager, &key_path) {
        // The Compose folder copies the key the container mounts: the placeholder mounts it for that read alone.
        let image = create.pop().expect("the image ends the line");
        create.extend([
            "-v".into(),
            docker::bind_spec(key, &format!("{}:ro", at_rest::KEY_MOUNT))?,
            image,
        ]);
    }
    let refs: Vec<&str> = create.iter().map(String::as_str).collect();
    moves::run_on(&on, &refs, Duration::from_secs(120))?;
    update(move_id, |attempt| {
        attempt.containers.push(container.clone());
        attempt.containers.push(parked_of(slug));
    })?;
    takeover::mark(&container, Some(&inspect), takeover::By::Move)?;

    match manager {
        Manager::Ic => {
            say(slug, "starting", json!({}));
            let probation = std::env::var("IC_PROBATION_SECONDS").ok();
            std::env::set_var("IC_PROBATION_SECONDS", "0");
            let made = moves::with_key_file(key_path.as_deref(), || {
                crate::sandbox::recreate::run(
                    crate::sandbox::recreate::Mode::Reshape(crate::shape::Ask::default()),
                    Some(slug.clone()),
                    crate::sandbox::recreate::Preflight::Skip,
                )
            });
            match probation {
                Some(value) => std::env::set_var("IC_PROBATION_SECONDS", value),
                None => std::env::remove_var("IC_PROBATION_SECONDS"),
            }
            made.map_err(|Fail(reason)| {
                Fail(format!("the sandbox did not come up here: {reason}"))
            })?;
            if !plan.running {
                crate::sandbox::power::run(crate::sandbox::power::Power::Stop, Some(slug.clone()))?;
            }
        }
        Manager::Compose => {
            let dir = compose_out::default_dir(&intentic_home(), slug);
            if !dir.exists() {
                let folder = dir.to_string_lossy().to_string();
                update(move_id, |attempt| attempt.files.push(folder))?;
            }
            let here = side::here();
            let stamps = HostStamps {
                platform: Some(here.platform.clone()),
                label: Some(label.clone()).filter(|label| !label.is_empty()),
                env: here.env.clone(),
            };
            compose_out::write_folder_as(slug, &dir, Some(stamps))?;
            moves::run_on(&on, &["rm", "-f", &container], docker::READ_LIMIT)?;
            if plan.running {
                say(
                    slug,
                    "starting",
                    json!({ "compose": dir.to_string_lossy() }),
                );
                compose_up(&dir, log)?;
            }
        }
    }
    if plan.running && plan.reachable {
        wait_tunnel(slug, &container)?;
    }
    Ok(label)
}

fn compose_up(dir: &PathBuf, log: &Log) -> Result<()> {
    let mut command = docker::command(&["compose", "up", "-d"]);
    command.current_dir(dir);
    let ran = docker::bounded(command, Duration::from_secs(60 * 60))?;
    log.line(&format!("compose up: {} {}", ran.stdout, ran.stderr));
    if ran.code != Some(0) {
        bail!(
            "docker compose up failed in {}: {}",
            dir.display(),
            moves::last_words(&ran.stderr)
        );
    }
    Ok(())
}

/// Wait for the started sandbox's own reach probe to say its tunnel is up, as it said on the source.
fn wait_tunnel(slug: &str, container: &str) -> Result<()> {
    say(slug, "waiting-tunnel", json!({}));
    let started = Instant::now();
    loop {
        if crate::health::reach_state(container).as_deref() == Some("reachable") {
            return Ok(());
        }
        if started.elapsed() > TUNNEL_WAIT {
            bail!(
                "it started here, but its tunnel did not come up within {} minutes.",
                TUNNEL_WAIT.as_secs() / 60
            );
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_moved_container_is_stamped_as_this_machines() {
        let inspect = json!({
            "Config": {
                "Env": ["CONNECT_TOKEN=t", "HOST_PLATFORM=windows", "HOST_ENV=x", "HOST_ENGINE=docker-desktop", "HOST_LABEL=rog"],
                "Labels": { "dev.intentic.side": "windows", "dev.intentic.sandbox": "s" }
            }
        });
        let ours = restamped(&inspect, "z440");
        assert_eq!(
            ours["Config"]["Env"],
            json!(["CONNECT_TOKEN=t", "HOST_LABEL=z440"])
        );
        assert_eq!(
            ours["Config"]["Labels"],
            json!({ "dev.intentic.sandbox": "s" })
        );
        assert_eq!(side::created_on_inspected(&ours), None);
    }

    #[test]
    fn a_carried_record_keeps_what_the_sandbox_is_not_where_it_was() {
        let text = "channel=beta\ncurrent=ghcr.io/intentic/sandbox:beta\ncurrent_version=1.2.3\nprevious=old\nheld=true\nstaged=x\n";
        let record = carried_record(text);
        assert_eq!(record.channel.as_deref(), Some("beta"));
        assert_eq!(record.current_version.as_deref(), Some("1.2.3"));
        assert_eq!(record.previous, None);
        assert_eq!(record.staged, None);
        assert!(!record.held);
    }

    #[test]
    fn the_writing_helper_is_privileged_only_for_docker_data() {
        let plain = tar_in_args("h", "vol", false, "img");
        assert!(plain.contains(&"vol:/to".to_string()) && plain.contains(&"-i".to_string()));
        assert!(!plain.contains(&"--privileged".to_string()));
        assert!(tar_in_args("h", "vol", true, "img").contains(&"--privileged".to_string()));
        assert_eq!(Manager::parse("compose"), Some(Manager::Compose));
        assert_eq!(Manager::parse("swarm"), None);
    }

    #[test]
    fn listen_addresses_are_never_loopback() {
        for address in lan_addresses(4242) {
            assert!(address.ends_with(":4242"));
            assert!(!address.starts_with("127.") && !address.starts_with("[::1]"));
        }
    }
}
