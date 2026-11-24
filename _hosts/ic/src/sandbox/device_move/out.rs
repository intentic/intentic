use std::collections::BTreeMap;
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::wire::{self, Keys, Kind, Role, Session};
use super::{here_target, say, stream, update, Manifest, Plan, PlanVolume, VERSION};
use crate::docker::{self, Target};
use crate::engine::moves;
use crate::logfile::Log;
use crate::sandbox::at_rest;
use crate::sandbox::power::{self, Power};
use crate::sandbox::{container_of, is_slug, lock, now_ms, MOVED_SUFFIX, TUNNEL_PREFIX};
use crate::util::{bail, sha256_hex, Fail, Result};

/* THE SOURCE'S HALF (`ic sandbox move-out`): plan, then, once the owner said yes and the target is ready, send. The
sandbox keeps running through the planning and through the target's whole preparation; it is stopped (held, as
`ic sandbox stop` holds it) only once the target has proved who it is and said it is ready to receive. */

/// How long one direct dial may take before the next address, or the relay, is tried.
const DIAL: Duration = Duration::from_secs(5);
/// How long the relay has to connect once this side listens.
const RELAY_WAIT: Duration = Duration::from_secs(5 * 60);
/// How long the target may take to say it is ready after the greeting (it waits for this side's key to reach it).
const READY_WAIT: Duration = Duration::from_secs(5 * 60);
/// How long the target may take to make, start and reach the sandbox after the last byte.
const VERDICT_WAIT: Duration = Duration::from_secs(45 * 60);

pub struct OutArgs {
    pub slug: String,
    pub move_id: String,
    pub plan_only: bool,
    pub peer: Option<String>,
    pub connect: Vec<String>,
    pub listen: bool,
}

pub fn run(args: OutArgs) -> Result<()> {
    super::check_move_id(&args.move_id)?;
    if !is_slug(&args.slug) {
        bail!("{}", crate::sandbox::missing(&args.slug));
    }
    docker::require_daemon()?;
    super::recover();
    let log = Log::create_named("move", &format!("move-out-{}", args.slug))?;
    if args.plan_only {
        let (plan, _) = build_plan(&args.slug, true, &log)?;
        say(&args.slug, "plan", json!({ "plan": plan }));
        return Ok(());
    }
    let Some(peer) = args.peer.as_deref().and_then(wire::decode_key) else {
        bail!("name the target's key with --peer: it is what proves the computer this sandbox goes to.");
    };
    send(&args, peer, &log)
}

/* ——— The plan. ——— */

/// What would move. `measure` sizes the volumes, reads the reach probe and looks for the recipe that makes the image
/// (minutes on a big sandbox); without it the plan is only what the stream is checked against.
pub fn build_plan(slug: &str, measure: bool, log: &Log) -> Result<(Plan, Value)> {
    let on = here_target();
    let container = container_of(slug);
    if !docker::container_exists(&container) {
        bail!("{}", crate::sandbox::missing(slug));
    }
    let inspect = moves::inspect_on(&on, &container)?;
    let env = moves::env_of(&inspect);
    let Some(image) = moves::env_value(&env, "SANDBOX_IMAGE") else {
        bail!("{slug} predates the run contract, so it cannot be made again on another computer — run `ic sandbox update {slug}` once, then move it.");
    };
    let base_image = moves::env_value(&env, "SANDBOX_BASE_IMAGE").unwrap_or_else(|| image.clone());
    if docker::mount_source(&container, at_rest::PREVIOUS_KEY_MOUNT).is_some() {
        bail!("{slug} is in the middle of an at-rest key rotation. Restart it through ic once (`ic sandbox restart {slug}`) so the rotation finishes, then move it.");
    }
    let key_id = key_bytes(&container)?.and_then(|bytes| at_rest::key_id_of(&bytes));
    let mut volumes = Vec::new();
    for (name, destination) in moves::named_volumes(&inspect) {
        let docker_data = destination == moves::DOCKER_DATA;
        let bytes = if measure {
            moves::volume_bytes(&on, &name, &image).unwrap_or(0)
        } else {
            0
        };
        volumes.push(PlanVolume {
            labels: volume_labels(&on, &name),
            name,
            destination,
            docker_data,
            bytes,
        });
    }
    let base_digest = moves::repo_digest(&on, &base_image);
    let image_digest = if image == base_image {
        base_digest.clone()
    } else {
        moves::repo_digest(&on, &image)
    };
    let recipe = if measure && image != base_image && image_digest.is_none() {
        find_recipe(&container, slug, &image, &base_image, log)
    } else {
        None
    };
    let carry_image = needs_carrying(
        &image,
        &base_image,
        base_digest.is_some(),
        image_digest.is_some(),
        recipe.is_some(),
    );
    let mut bytes: u64 = volumes.iter().map(|volume| volume.bytes).sum();
    if measure && carry_image {
        bytes += moves::image_bytes(&on, &image).unwrap_or(0);
    }
    let running = inspect["State"]["Running"].as_bool() == Some(true);
    let reachable = measure
        && running
        && crate::health::reach_state(&container).as_deref() == Some("reachable");
    let plan = Plan {
        v: VERSION,
        slug: slug.to_string(),
        image,
        base_image,
        base_digest,
        image_digest,
        recipe,
        carry_image,
        volumes,
        bytes,
        running,
        key_id,
        backup_key: crate::sandbox::backup::key_path(slug).is_file(),
        reachable,
        ic_version: crate::VERSION.to_string(),
        from: crate::sandbox::connect::machine_label(),
    };
    log.line(&format!(
        "plan: {}",
        serde_json::to_string(&plan).unwrap_or_default()
    ));
    Ok((plan, inspect))
}

/// Whether the image must ride inside the stream: no registry holds it and no recipe makes it. Pure.
pub fn needs_carrying(
    image: &str,
    base: &str,
    base_pulled: bool,
    image_pulled: bool,
    recipe: bool,
) -> bool {
    if image == base {
        !base_pulled
    } else {
        !image_pulled && !(recipe && base_pulled)
    }
}

/// The 12 hex digits an overlay build's tag names (`intentic-sandbox-env-<slug>:<hash12>`, recreate.rs). Pure.
pub fn overlay_tag_hash(image: &str) -> Option<&str> {
    let (name, tag) = image.rsplit_once(':')?;
    (name.starts_with("intentic-sandbox-env-")
        && tag.len() == 12
        && tag.chars().all(|c| c.is_ascii_hexdigit()))
    .then_some(tag)
}

/// The first of `candidates` whose hash the image's tag names: the recipe that built it. Pure.
pub fn recipe_for(image: &str, candidates: &[String]) -> Option<String> {
    let wanted = overlay_tag_hash(image)?;
    candidates
        .iter()
        .find(|content| !content.is_empty() && sha256_hex(content.as_bytes()).starts_with(wanted))
        .cloned()
}

/// The recipe that built the running overlay: the approved file as it is, or as the base's composer composes it (what
/// an update builds, composition.rs). None when neither hashes to the image's tag: the image is then carried.
fn find_recipe(container: &str, slug: &str, image: &str, base: &str, log: &Log) -> Option<String> {
    overlay_tag_hash(image)?;
    let dir = tempfile::tempdir().ok()?;
    let path = dir.path().join("approved.Dockerfile");
    crate::sandbox::recreate::stage_overlay(container, &path).ok()?;
    let approved = std::fs::read_to_string(&path).ok()?;
    if let Some(found) = recipe_for(image, std::slice::from_ref(&approved)) {
        return Some(found);
    }
    let composed =
        crate::sandbox::composition::for_target(container, slug, base, base, &approved, &[], log);
    recipe_for(image, &[composed.content])
}

fn volume_labels(on: &Target, volume: &str) -> BTreeMap<String, String> {
    docker::capture_on(
        on,
        &["volume", "inspect", "--format", "{{json .Labels}}", volume],
        docker::READ_LIMIT,
    )
    .ok()
    .and_then(|ran| serde_json::from_str::<BTreeMap<String, String>>(ran.stdout.trim()).ok())
    .unwrap_or_default()
}

/// The at-rest key the container mounts, read through docker so its spelling on this engine's host does not matter.
fn key_bytes(container: &str) -> Result<Option<Vec<u8>>> {
    if docker::mount_source(container, at_rest::KEY_MOUNT).is_none() {
        return Ok(None);
    }
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("key");
    if let Some(reason) = docker::cp_out(container, at_rest::KEY_MOUNT, &path) {
        bail!("could not read the at-rest key {container} mounts: {reason}. Nothing was moved.");
    }
    Ok(Some(std::fs::read(&path)?))
}

/* ——— Sending. ——— */

/// Reach the target: each address it listens on, directly; else listen here for the calling sandbox's relay.
fn dial(slug: &str, connect: &[String], listen: bool) -> Result<TcpStream> {
    for address in connect {
        let Ok(addresses) = address.to_socket_addrs() else {
            continue;
        };
        for address in addresses.collect::<Vec<SocketAddr>>() {
            if let Ok(stream) = TcpStream::connect_timeout(&address, DIAL) {
                say(slug, "connected", json!({ "via": "direct" }));
                return Ok(stream);
            }
        }
    }
    if listen {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        say(slug, "listening", json!({ "port": port }));
        if let Some(stream) = accept_within(&listener, RELAY_WAIT)? {
            say(slug, "connected", json!({ "via": "relay" }));
            return Ok(stream);
        }
    }
    say(slug, "unreachable", json!({}));
    bail!("the other computer could not be reached, directly or through the relay. {slug} was not touched.");
}

/// The next connection within `limit`, or None.
pub fn accept_within(listener: &TcpListener, limit: Duration) -> Result<Option<TcpStream>> {
    listener.set_nonblocking(true)?;
    let started = Instant::now();
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                return Ok(Some(stream));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if started.elapsed() > limit {
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Err(Fail(format!("could not take the connection: {error}"))),
        }
    }
}

/// The target's verdict on what it received.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    Up { host: String },
    Failed(String),
}

pub fn verdict_of(payload: &[u8]) -> Verdict {
    let value: Value = serde_json::from_slice(payload).unwrap_or(Value::Null);
    if value["ok"].as_bool() == Some(true) {
        Verdict::Up {
            host: value["host"]
                .as_str()
                .unwrap_or("the other computer")
                .to_string(),
        }
    } else {
        Verdict::Failed(
            value["reason"]
                .as_str()
                .unwrap_or("the other computer did not say why")
                .to_string(),
        )
    }
}

fn send(args: &OutArgs, peer: [u8; 32], log: &Log) -> Result<()> {
    let slug = &args.slug;
    let keys = Keys::generate()?;
    // First, before anything else: the daemon hands this to the target, which checks it on the greeting.
    say(
        slug,
        "key",
        json!({ "publicKey": wire::encode_key(&keys.public) }),
    );
    let container = container_of(slug);
    if !docker::container_exists(&container) {
        bail!("{}", crate::sandbox::missing(slug));
    }
    let mut connection = dial(slug, &args.connect, args.listen)?;
    connection.set_write_timeout(Some(moves::STALL))?;
    connection.set_read_timeout(Some(READY_WAIT))?;
    let mut session = wire::handshake(&mut connection, keys, Role::Source, &args.move_id, || {
        Ok(peer)
    })?;
    let (kind, ready) = session.receive.next(&mut connection)?;
    if kind != Kind::Ack {
        bail!("the other computer did not say it was ready. {slug} was not touched.");
    }
    let ready: Value = serde_json::from_slice(&ready).unwrap_or(Value::Null);
    let need_image = ready["needImage"].as_bool() == Some(true);
    connection.set_read_timeout(Some(moves::STALL))?;

    let _held = lock::hold_for_person(slug)?;
    let was_running = docker::inspect(&container, "{{.State.Running}}").as_deref() == Some("true");
    update(&args.move_id, |attempt| {
        attempt.slug = slug.clone();
        attempt.role = "source".into();
        attempt.was_running = was_running;
    })?;
    let _beat = super::beat(&args.move_id);
    let sent = (|| -> Result<Verdict> {
        if was_running {
            say(slug, "stopping", json!({}));
            power::run(Power::Stop, Some(slug.clone()))?;
            update(&args.move_id, |attempt| attempt.stopped = true)?;
        }
        let (plan, inspect) = build_plan(slug, false, log)?;
        send_all(
            &mut session,
            &mut connection,
            &args.move_id,
            &plan,
            inspect,
            need_image,
            log,
        )?;
        update(&args.move_id, |attempt| attempt.awaiting_verdict = true)?;
        say(slug, "verdict", json!({}));
        connection.set_read_timeout(Some(VERDICT_WAIT))?;
        match session.receive.next(&mut connection) {
            Ok((Kind::Verdict, payload)) => Ok(verdict_of(&payload)),
            Ok(_) => Err(Fail("the other computer answered out of turn.".into())),
            Err(Fail(reason)) => Err(Fail(format!("AMBIGUOUS:{reason}"))),
        }
    })();
    let outcome = match sent {
        Ok(Verdict::Up { host }) => {
            let _ = session.send.send(&mut connection, Kind::Ack, b"{}");
            let _ = session.send.end(&mut connection);
            park(slug, &host)?;
            super::finish(&args.move_id);
            say(slug, "moved", json!({ "to": host }));
            crate::ui::done(&format!(
                "{slug} now runs on {host}. This computer keeps its stopped copy as {container}{MOVED_SUFFIX} for {} days.",
                moves::KEEP_DAYS
            ));
            return Ok(());
        }
        Ok(Verdict::Failed(reason)) => reason,
        Err(Fail(reason)) => {
            if let Some(reason) = reason.strip_prefix("AMBIGUOUS:") {
                super::finish(&args.move_id);
                say(
                    slug,
                    "failed",
                    json!({ "reason": reason, "ambiguous": true }),
                );
                bail!(
                    "everything was sent, and then the connection broke before the other computer said whether {slug} came up there ({reason}). \
                     {slug} stays stopped here so two copies never run: look on the other computer, and if it is not there, \
                     `ic sandbox start {slug}` brings it back here."
                );
            }
            reason
        }
    };
    // Nothing reached the point of no return: the sandbox comes back here as it was.
    if was_running {
        if let Err(Fail(again)) = power::run(Power::Start, Some(slug.clone())) {
            crate::ui::warn(&format!("could not start {slug} again: {again}"));
        }
    }
    super::finish(&args.move_id);
    say(slug, "failed", json!({ "reason": outcome }));
    bail!("{slug} was not moved: {outcome} It is back as it was on this computer.");
}

/// Everything after the go-ahead: the manifest, the keys, the image when asked, each volume, the end.
fn send_all(
    session: &mut Session,
    connection: &mut TcpStream,
    move_id: &str,
    plan: &Plan,
    inspect: Value,
    need_image: bool,
    log: &Log,
) -> Result<()> {
    let slug = &plan.slug;
    let on = here_target();
    let container = container_of(slug);
    let manifest = Manifest {
        v: VERSION,
        move_id: move_id.to_string(),
        plan: plan.clone(),
        inspect,
        record: std::fs::read_to_string(crate::record::record_path(slug)).ok(),
    };
    session.send.send(
        connection,
        Kind::Manifest,
        serde_json::to_string(&manifest)?.as_bytes(),
    )?;
    say(slug, "keys", json!({}));
    if let Some(key) = key_bytes(&container)? {
        session
            .send
            .send(connection, Kind::Key, &[&[1u8][..], &key].concat())?;
    }
    if let Ok(key) = std::fs::read(crate::sandbox::backup::key_path(slug)) {
        session
            .send
            .send(connection, Kind::Key, &[&[2u8][..], &key].concat())?;
    }
    // The image first, when it rides along: the volumes' helpers on the other side run from it.
    if need_image {
        let total = moves::image_bytes(&on, &plan.image).unwrap_or(0);
        say(
            slug,
            "image",
            json!({ "image": plan.image, "done": 0, "total": total }),
        );
        stream::send(
            &mut session.send,
            connection,
            &json!({ "kind": "image", "name": plan.image }),
            moves::archive_command(&on, &["save", &plan.image]),
            &json!({}),
            slug,
            "image",
            total,
        )?;
    }
    for volume in &plan.volumes {
        let total = moves::volume_bytes(&on, &volume.name, &plan.image).unwrap_or(0);
        say(
            slug,
            "volume",
            json!({ "volume": volume.name, "done": 0, "total": total }),
        );
        let (files, hash) = moves::manifest(&on, &volume.name, &plan.image, volume.docker_data)?;
        let reading = moves::helper_name(slug, "read");
        let _ = docker::capture_on(&on, &["rm", "-f", &reading], docker::READ_LIMIT);
        let args = tar_out_args(&reading, &volume.name, volume.docker_data, &plan.image);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let sent = stream::send(
            &mut session.send,
            connection,
            &json!({ "kind": "volume", "name": volume.name }),
            moves::archive_command(&on, &refs),
            &json!({ "files": files, "hash": hash }),
            slug,
            "volume",
            total,
        );
        let _ = docker::capture_on(&on, &["rm", "-f", &reading], docker::READ_LIMIT);
        let sent =
            sent.map_err(|Fail(reason)| Fail(format!("copying {}: {reason}", volume.name)))?;
        log.line(&format!("{}: {sent} bytes, {files} files", volume.name));
    }
    session.send.end(connection)
}

/// The helper that reads a volume as a tar onto its stdout (engine/moves.rs's `copy_volume`, reading end). Pure.
pub fn tar_out_args(name: &str, volume: &str, docker_data: bool, helper: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "run",
        "--rm",
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
        format!("{volume}:/from:ro"),
        "--entrypoint".into(),
        "tar".into(),
        helper.into(),
    ]);
    args.extend(moves::TAR_OUT.iter().map(|s| s.to_string()));
    args
}

/// The target is up: this computer's copy is set aside as `.moved`, recorded for engine/moves.rs's cleanup.
fn park(slug: &str, host: &str) -> Result<()> {
    let mut containers = Vec::new();
    for name in [container_of(slug), format!("{TUNNEL_PREFIX}{slug}")] {
        if !docker::container_exists(&name) {
            continue;
        }
        let moved = format!("{name}{MOVED_SUFFIX}");
        docker::quiet(&["stop", "-t", "30", &name]);
        docker::quiet(&["rm", "-f", &moved]);
        let ran = docker::capture_bounded(&["rename", &name, &moved], docker::READ_LIMIT)?;
        if ran.code != Some(0) {
            crate::ui::warn(&format!(
                "could not set {name} aside as {moved}: {}",
                ran.stderr.trim()
            ));
            continue;
        }
        containers.push(moved);
    }
    let inspect = docker::inspect(
        &format!("{}{MOVED_SUFFIX}", container_of(slug)),
        "{{json .Mounts}}",
    )
    .and_then(|mounts| serde_json::from_str::<Value>(&mounts).ok())
    .unwrap_or(Value::Null);
    let volumes: Vec<String> = moves::named_volumes(&json!({ "Mounts": inspect }))
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    // The record names a sandbox that no longer runs here: set aside beside it, so nothing here acts on it.
    let record = crate::record::record_path(slug);
    if record.exists() {
        let _ = std::fs::rename(&record, record.with_extension("moved"));
    }
    let now = now_ms();
    moves::update_journal(|journal| {
        journal.moved.push(moves::Moved {
            slug: slug.to_string(),
            from: moves::DEVICE_FROM.to_string(),
            to: host.to_string(),
            at: now,
            containers,
            volumes,
            images: Vec::new(),
            remove_after: now + moves::KEEP_DAYS * moves::DAY_MS,
            removed: false,
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_rides_the_stream_only_when_nothing_else_can_make_it() {
        // A stock sandbox: pulled by digest, or carried when no registry holds it.
        assert!(!needs_carrying("img", "img", true, true, false));
        assert!(needs_carrying("img", "img", false, false, false));
        // An overlay: pulled, built from its recipe on a pulled base, or carried.
        assert!(!needs_carrying("env", "base", true, true, false));
        assert!(!needs_carrying("env", "base", true, false, true));
        assert!(needs_carrying("env", "base", false, false, true));
        assert!(needs_carrying("env", "base", true, false, false));
    }

    #[test]
    fn the_recipe_is_the_one_the_tag_names() {
        let recipe = "FROM ghcr.io/intentic/sandbox:1.0\nRUN true\n".to_string();
        let image = format!(
            "intentic-sandbox-env-s:{}",
            &sha256_hex(recipe.as_bytes())[..12]
        );
        assert_eq!(
            recipe_for(&image, &["FROM x\n".into(), recipe.clone()]),
            Some(recipe.clone())
        );
        assert_eq!(recipe_for(&image, &["FROM x\n".into()]), None);
        assert_eq!(
            recipe_for("intentic-sandbox:dev", std::slice::from_ref(&recipe)),
            None
        );
        assert_eq!(
            overlay_tag_hash("intentic-sandbox-env-s:abcdef012345"),
            Some("abcdef012345")
        );
        assert_eq!(overlay_tag_hash("ghcr.io/intentic/sandbox:stable"), None);
    }

    #[test]
    fn a_verdict_reads_up_or_why_not() {
        assert_eq!(
            verdict_of(br#"{"ok":true,"host":"z440"}"#),
            Verdict::Up {
                host: "z440".into()
            }
        );
        assert_eq!(
            verdict_of(br#"{"ok":false,"reason":"disk full"}"#),
            Verdict::Failed("disk full".into())
        );
        assert!(matches!(verdict_of(b"garbage"), Verdict::Failed(_)));
    }

    #[test]
    fn the_reading_helper_is_privileged_only_for_docker_data() {
        let plain = tar_out_args("h", "vol", false, "img");
        assert!(!plain.contains(&"--privileged".to_string()));
        assert!(plain.contains(&"vol:/from:ro".to_string()));
        assert!(tar_out_args("h", "vol", true, "img").contains(&"--privileged".to_string()));
    }

    #[test]
    fn a_relay_that_never_comes_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(accept_within(&listener, Duration::from_millis(300))
            .unwrap()
            .is_none());
        let port = listener.local_addr().unwrap().port();
        let dialled = std::thread::spawn(move || TcpStream::connect(("127.0.0.1", port)).unwrap());
        assert!(accept_within(&listener, Duration::from_secs(10))
            .unwrap()
            .is_some());
        dialled.join().unwrap();
    }
}
