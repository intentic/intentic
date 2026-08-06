use std::path::Path;

use crate::contract::{self, RunRequest};
use crate::docker;
use crate::health;
use crate::logfile::Log;
use crate::record;
use crate::sandbox::{resolve_slug, CONTAINER_PREFIX};
use crate::util::{bail, sha256_hex, Fail, Result};

/* Swap THIS machine's sandbox container onto a different image, preserving /work, /history, the tunnel, and
 * every setting the container carries — recreate.sh's four modes as verbs. One engine, four pre-steps,
 * because the four were always one flow:
 *
 *   ic sandbox rebuild <slug> <sha256>    the owner-approved overlay (hash = what the owner reviewed)
 *   ic sandbox update [slug]              the fresh :<channel> base, overlay re-applied on top
 *   ic sandbox rollback [slug]            back to the image this sandbox came from
 *   ic sandbox dev [slug]                 the locally-built dev image (the dogfood loop)
 *
 * The sandbox holds no HOST Docker socket (its own engine is nested — it cannot recreate its own
 * container), which is why every mode runs HERE, on the machine that runs the container.
 *
 * HOW THE CONTAINER IS RUN is deliberately not written in this file — see contract.rs. */

const APPROVED_FILE: &str = "/work/.intentic/environment.approved.Dockerfile";
const DEV_TAG: &str = "intentic-sandbox:dev";
const DEFAULT_REGISTRY: &str = "ghcr.io/intentic/sandbox";

pub enum Mode {
    Rebuild { hash: String },
    Update { channel: Option<String> },
    Rollback,
    Dev,
}

impl Mode {
    fn name(&self) -> &'static str {
        match self {
            Mode::Rebuild { .. } => "rebuild",
            Mode::Update { .. } => "update",
            Mode::Rollback => "rollback",
            Mode::Dev => "dev",
        }
    }
}

pub fn run(mode: Mode, slug: Option<String>) -> Result<()> {
    if !docker::cli_present() {
        bail!("docker is required — run this on the machine that runs the sandbox.");
    }
    let slug = resolve_slug(slug, &format!("ic sandbox {}", mode.name()))?;
    let container = format!("{CONTAINER_PREFIX}{slug}");
    let parked = format!("{container}.previous");
    if !docker::container_exists(&container) {
        // A recreate that died between parking the old container and starting its replacement leaves the
        // name empty and the sandbox parked — put it back rather than sending the owner to the wizard.
        if !docker::container_exists(&parked) {
            bail!(
                "sandbox container {container} does not exist on this machine — re-run connect first."
            );
        }
        println!("intentic: restoring the sandbox an interrupted recreate left parked…");
        docker::quiet(&["rename", &parked, &container]);
        docker::quiet(&["start", &container]);
    }

    // The tag this sandbox follows. An explicit --channel wins and is remembered; otherwise the remembered
    // one, and `stable` for a sandbox that predates the record. SANDBOX_IMAGE still overrides everything:
    // it is how a pinned or locally-built image is passed in, and a channel is a default, not a policy.
    let saved = record::read(&slug);
    let channel = match &mode {
        Mode::Update {
            channel: Some(chosen),
        } => chosen.clone(),
        _ => saved
            .channel
            .clone()
            .unwrap_or_else(|| "stable".to_string()),
    };
    let image_override = std::env::var("SANDBOX_IMAGE")
        .ok()
        .filter(|value| !value.is_empty());
    let mut registry_image = image_override
        .clone()
        .unwrap_or_else(|| format!("{DEFAULT_REGISTRY}:stable"));
    if image_override.is_none() {
        if let Mode::Update { .. } = mode {
            registry_image = format!("{DEFAULT_REGISTRY}:{channel}");
        }
    }

    /* The EXACT image the running sandbox was built from, captured before anything pulls. Identity is what
     * the update and rollback decisions below are made from, because every name involved (:stable, :beta)
     * is a tag the registry MOVES — by name, a stock update is :stable → :stable even when the images
     * differ, which is precisely the case rollback exists for. A stock container's base is the container's
     * own image (inspect .Image — exact even on a shared daemon); an overlay container's is its base tag's
     * local resolution, still un-moved this side of the pull. */
    let current_base = container_env(&container, "SANDBOX_BASE_IMAGE");
    let sandbox_image = container_env(&container, "SANDBOX_IMAGE");
    let old_base_id = if current_base.is_none() || current_base == sandbox_image {
        docker::inspect(&container, "{{.Image}}")
    } else {
        current_base.as_deref().and_then(docker::image_id)
    };

    let log = Log::create_named("recreate", &format!("recreate-{}", mode.name()))?;
    let workdir = tempfile::tempdir()?;
    let overlay_path = workdir.path().join("overlay.Dockerfile");

    // ——— The mode pre-step: produce target/base/env-hash and the overlay file (may be empty). ———
    let mut env_hash: Option<String> = None;
    match &mode {
        Mode::Rebuild { hash } => {
            // Copy the approved overlay out ONCE and hash/build that same copy — byte-exact, no window
            // between the check and the build. The overlay lives on the workspace volume the agent can
            // write, so only content that still hashes to what the owner reviewed is ever built.
            if !docker::cp_out(&container, APPROVED_FILE, &overlay_path) {
                bail!("no approved overlay found in the sandbox — approve the proposal on the Environment card first.");
            }
            let have = sha256_hex(&std::fs::read(&overlay_path)?);
            if have != *hash {
                bail!("the approved overlay changed since it was reviewed (expected {hash}, found {have}).\n       Re-review and re-approve it on the Environment card, then run the fresh command it shows.");
            }
            env_hash = Some(hash.clone());
        }
        Mode::Update { .. } => {
            // Pull the latest base up front — a moved tag is exactly what makes an update available, and
            // `docker run` reuses a cached tag without re-pulling. A no-op is reported honestly, not
            // recreated into the same image and claimed as success.
            println!("intentic: pulling {registry_image}…");
            let cached = docker::image_id(&registry_image);
            let _ = docker::pull(&registry_image, &log);
            let pulled = docker::image_id(&registry_image);
            if pulled.is_none() {
                bail!("{registry_image} is not available (pull failed) — the sandbox is untouched. Log: {}", log.path.display());
            }
            /* "Already current" means THIS CONTAINER runs the image the tag now names — not that the pull
             * moved nothing. Two sandboxes share one daemon: the first update refreshes the cache, and a
             * cache-only before/after told the second it was current while it ran last week's build. The
             * cache heuristic survives only for a base whose identity is unknowable. */
            let already_current = match (&old_base_id, &pulled) {
                (Some(old), Some(new)) => old == new,
                _ => cached.is_some() && cached == pulled,
            };
            if already_current {
                println!("intentic: no newer sandbox image is available yet — your sandbox is already on the latest :{channel} it can pull.");
                println!("          If the app still shows an update, the new release's image may still be publishing — try again in a few minutes.");
                return Ok(());
            }
            // Re-apply the approved overlay (if any) FROM the fresh base, so the extended environment carries on.
            copy_overlay_or_empty(&container, &overlay_path)?;
        }
        Mode::Rollback => {
            let Some(previous) = saved.previous.clone() else {
                bail!("nothing to roll back to — this sandbox has not been updated since the rollback record existed.\n       The record is written on every update from now on; {}", record::record_path(&slug).display());
            };
            registry_image = previous;
            // NO pull, and no "is there anything newer" check: the point of a rollback is to reach an image
            // already on this machine — one the registry moved the tag away from, pinned under the record's
            // protected tag. (A registry ref here is an older record; for those the pull attempt below is
            // still the only chance.)
            if !docker::image_exists(&registry_image) {
                println!(
                    "intentic: {registry_image} is not on this machine any more — pulling it…"
                );
                let _ = docker::pull(&registry_image, &log);
            }
            println!("intentic: rolling back to {registry_image}…");
            copy_overlay_or_empty(&container, &overlay_path)?;
            /* The overlay must ride the TARGET, not its own FROM: the FROM names the channel tag, which now
             * points at the very build being rolled back from. Hash the APPROVED content first — what the
             * owner reviewed IS what gets applied, re-based onto a target no agent can choose (the record is
             * a host-side file) — then the same first-FROM rewrite the dev flow uses. */
            let overlay = std::fs::read_to_string(&overlay_path)?;
            if !overlay.is_empty() {
                env_hash = Some(sha256_hex(overlay.as_bytes()));
                std::fs::write(&overlay_path, rewrite_from(&overlay, &registry_image))?;
            }
        }
        Mode::Dev => {
            if !docker::image_exists(DEV_TAG) {
                bail!("image {DEV_TAG} not found — run 'pnpm build:sandbox' first.");
            }
            // The overlay's tooling must ride the dev image too, or the dev loop and the rebuild loop are
            // mutually exclusive: this flow would hand you a fresh daemon missing the docker/vpn
            // capability's packages, while rebuild would hand you the packages on the LAST RELEASE's
            // daemon. The FROM is rewritten to the dev tag; --base-image below keeps composing against it.
            copy_overlay_or_empty(&container, &overlay_path)?;
            let overlay = std::fs::read_to_string(&overlay_path)?;
            if !overlay.is_empty() {
                std::fs::write(&overlay_path, rewrite_from(&overlay, DEV_TAG))?;
            }
        }
    }

    let overlay = std::fs::read_to_string(&overlay_path).unwrap_or_default();

    // The base the overlay extends, checked belt-and-braces (the daemon already enforced it at approval):
    // any OFFICIAL sandbox image, the exact base this container was created from (SANDBOX_BASE_IMAGE, set
    // at docker run by whichever runner made it — not a value the agent can write), or the rollback target
    // the host-side record names (the rollback pre-step just rewrote the FROM to it).
    let rollback_target = matches!(mode, Mode::Rollback).then(|| registry_image.clone());
    let mut base_image = String::new();
    if !overlay.is_empty() {
        base_image = overlay_base(&overlay).unwrap_or_default();
        if base_image.is_empty() {
            bail!("the approved overlay has no FROM instruction.");
        }
        if !base_is_allowed(&base_image, current_base.as_deref(), rollback_target.as_deref()) {
            bail!(
                "the approved overlay must start with FROM {DEFAULT_REGISTRY}:<tag>\n       (or FROM this sandbox's own base, {}); found {base_image}.",
                current_base.as_deref().unwrap_or("<none>")
            );
        }
    }

    // Build the overlay (when there is one) BEFORE touching the container, so a failed build leaves the
    // sandbox running untouched. Stdin build — an overlay is FROM + RUN/ENV only, no build context.
    let mut target_image;
    match &mode {
        Mode::Rebuild { .. } => {
            let hash = env_hash.as_deref().expect("rebuild set the hash");
            target_image = format!("intentic-sandbox-env-{slug}:{}", &hash[..12]);
            println!("intentic: building {target_image} from the approved overlay…");
            build_overlay(&target_image, &overlay_path, false, &log);
        }
        /* One arm, because a rollback IS an update pointed at the pinned image — same overlay rebuild, same
         * base pinning, same health gate — with one inversion: nothing may touch the registry. Update
         * --pulls the overlay's FROM (the tag it just fetched); rollback must not, because the pin exists
         * precisely BECAUSE the registry moved on, and a --pull here fetches the very build being escaped.
         * Rollback's env hash was settled in its pre-step (the APPROVED content's, before the FROM
         * rewrite), so only the image tag derives from the rewritten bytes. */
        Mode::Update { .. } | Mode::Rollback => {
            let fresh = matches!(mode, Mode::Update { .. });
            target_image = registry_image.clone();
            if base_image.is_empty() {
                base_image = registry_image.clone();
            }
            if !overlay.is_empty() {
                // The full hash pins SANDBOX_ENVIRONMENT_HASH (so the daemon reports the overlay as
                // Applied); the first 12 chars tag the built image — same derivation as rebuild.
                let hash = sha256_hex(overlay.as_bytes());
                target_image = format!("intentic-sandbox-env-{slug}:{}", &hash[..12]);
                if env_hash.is_none() {
                    env_hash = Some(hash);
                }
                println!(
                    "intentic: rebuilding your environment overlay on the {} base…",
                    if fresh { "new" } else { "rollback" }
                );
                build_overlay(&target_image, &overlay_path, fresh, &log);
            }
        }
        Mode::Dev => {
            target_image = DEV_TAG.to_string();
            base_image = DEV_TAG.to_string();
            if !overlay.is_empty() {
                let hash = sha256_hex(overlay.as_bytes());
                target_image = format!("intentic-sandbox-dev-env-{slug}:{}", &hash[..12]);
                env_hash = Some(hash);
                println!("intentic: building {target_image} — the overlay's tooling on top of {DEV_TAG}…");
                build_overlay(&target_image, &overlay_path, false, &log);
            }
        }
    }
    if !docker::image_exists(&target_image) {
        bail!("{target_image} is not available (pull or overlay build failed) — the sandbox is untouched. Log: {}", log.path.display());
    }

    // ——— Ask the TARGET IMAGE for its own run command: env in, command out. ———
    let mut env_nul = docker::container_env_nul(&container)?;
    // A container's env is fixed for its life, so REPLAYING it means every allowlisted value is immutable
    // until the owner re-runs the whole connect wizard — a heavy price for changing one string, and an
    // impossible one for values that did not exist when the container was created (WEB_ORIGIN taught us: a
    // sandbox built before the daemon had a CORS allowlist could never gain one). INTENTIC_SET_ENV is the
    // escape hatch — NAME=VALUE per line, PREPENDED because the contract resolves each name to its FIRST
    // occurrence: what the caller asked for beats what the old container carried, and only the allowlist
    // survives, so nothing else in the caller's shell can leak into the container.
    if let Ok(set_env) = std::env::var("INTENTIC_SET_ENV") {
        if !set_env.is_empty() {
            let mut merged: Vec<u8> = Vec::new();
            for line in set_env.lines() {
                merged.extend_from_slice(line.as_bytes());
                merged.push(0);
            }
            merged.extend_from_slice(&env_nul);
            env_nul = merged;
        }
    }

    // The /agent-auth mount is a mount+env pair: replaying AGENT_AUTH_DIR without its volume would point
    // the daemon at an empty container-local dir, stranding the shared credentials.
    let mut mounts: Vec<String> = Vec::new();
    if let Some(auth) = docker::inspect(
        &container,
        "{{range .Mounts}}{{if eq .Destination \"/agent-auth\"}}{{if eq .Type \"volume\"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}",
    ) {
        if !auth.is_empty() {
            mounts.push(format!("{auth}:/agent-auth"));
        }
    }
    // The dev wrapper binds the checkout's compiled trees over the image's baked copies (dev-mounts.mjs), so
    // a daemon edit reloads in seconds instead of a rebuild — newline-separated -v specs, straight through.
    if let Ok(dev_mounts) = std::env::var("INTENTIC_DEV_MOUNTS") {
        mounts.extend(
            dev_mounts
                .lines()
                .filter(|line| !line.is_empty())
                .map(str::to_string),
        );
    }

    let runtime_lines: String = overlay
        .lines()
        .filter(|line| line.starts_with("# intentic:runtime "))
        .collect::<Vec<_>>()
        .join("\n");
    // Which asks this host cannot honour — probed via the image (the list lives in the run contract), so
    // the sandbox starts without an optional extra instead of `docker run` refusing the whole launch.
    let probes = if runtime_lines.is_empty() {
        Vec::new()
    } else {
        contract::host_probes(&target_image, &runtime_lines, &log)
    };
    let unsupported = contract::unsupported_on_this_host(&probes);

    // The resolvers the container was created with. The hand-written recreates silently DROPPED these on
    // every swap — a restricted-network sandbox lost its split-horizon config the first time its owner
    // rebuilt it; replaying them through the contract is what fixed that class.
    let dns = docker::inspect(&container, "{{join .HostConfig.Dns \" \"}}")
        .filter(|servers| !servers.is_empty());

    /* What the record's `previous` becomes — the rollback target — decided by identity above and pinned
     * under a protected local tag. Unpinned, the replaced image goes dangling the moment its tag moves,
     * one routine `docker image prune` from deleting the only way back. The tag is created BEFORE the
     * record that names it, so the record never points at nothing. */
    let new_base_id = docker::image_id(&base_image);
    let next = next_previous(&saved, old_base_id.as_deref(), new_base_id.as_deref(), &slug);
    if next != saved.previous {
        if let (Some(pin), Some(old)) = (next.as_deref(), old_base_id.as_deref()) {
            docker::quiet(&["tag", old, pin]);
        }
    }

    let mounts_joined = (!mounts.is_empty()).then(|| mounts.join("\n"));
    let request = RunRequest {
        image: &target_image,
        slug: &slug,
        base_image: &base_image,
        channel: Some(&channel),
        // The daemon's Update card offers exactly what `ic sandbox rollback` will do — the record's own
        // target — never the base tag that was replaced, a name whose meaning the registry moves.
        previous_image: next.as_deref(),
        environment_hash: env_hash.as_deref(),
        runtime: (!runtime_lines.is_empty()).then_some(runtime_lines.as_str()),
        mounts: mounts_joined.as_deref(),
        dns: dns.as_deref(),
    };
    let argv = contract::run_command(&request, &env_nul, false, &unsupported, &log)?;

    println!("intentic: recreating the sandbox from {target_image}…");
    log.section(&format!("previous container logs ({container})"));
    docker::logs_into(&container, "5000", &log);

    // The channel record — written BEFORE the swap and before the LAUNCH: a swap that starts and then
    // crash-loops is exactly the case rollback is for. A launch that fails outright rewinds it below.
    record::write(&slug, &channel, &base_image, next.as_deref())?;

    /* The cutover PARKS the old container instead of destroying it: stop, rename aside, and only a
     * replacement that answers health earns the rm. Every failure path below puts the parked container
     * back, so the worst outcome of an update is the sandbox you already had — `rm -f` first meant a
     * failed launch left nothing, and the documented recovery was re-running the connect wizard. */
    docker::quiet(&["rm", "-f", &parked]);
    docker::quiet(&["stop", &container]);
    docker::quiet(&["rename", &container, &parked]);
    log.section("run command");

    // Two attempts: everything the run can lose WITHOUT the sandbox being broken comes off together on the
    // retry — the loopback shortcut (docker refuses the whole launch when its port is already held) and
    // EVERY optional directive, even ones whose probe passed: a probe answers a question docker answers
    // again at run time, and it can answer differently (an nvidia runtime registered against a mismatched
    // driver satisfies `docker info` and then fails the container). A sandbox that comes back saying it has
    // no GPU beats no sandbox. The failed attempt leaves a created-but-stopped container holding the name.
    if !docker::run_argv(&argv, &log) {
        docker::quiet(&["rm", "-f", &container]);
        let all_optional: Vec<String> = probes.iter().map(|probe| probe.token.clone()).collect();
        let retry_argv = match contract::run_command(&request, &env_nul, true, &all_optional, &log) {
            Ok(retry_argv) => retry_argv,
            Err(err) => {
                restore_parked(&container, &parked, &slug, &channel, &saved);
                return Err(err);
            }
        };
        if !docker::run_argv(&retry_argv, &log) {
            restore_parked(&container, &parked, &slug, &channel, &saved);
            let tail = log.tail(5);
            bail!(
                "starting the recreated sandbox failed (a runtime flag the host rejects, e.g. --privileged or /dev/net/tun?).\n{tail}\n       Your previous sandbox was restored. The old container's logs and this error are saved to {}.",
                log.path.display()
            );
        }
        println!("intentic: recreated without the local shortcut (its port is taken) — this browser reaches the sandbox over its tunnel.");
    }

    println!("intentic: waiting for the sandbox daemon to come up…");
    if let Err(err) = health::wait_answering(
        &container,
        &log,
        "\n       Your previous sandbox was restored — the update did not take.",
    ) {
        restore_parked(&container, &parked, &slug, &channel, &saved);
        return Err(err);
    }
    health::wait_ready(&container);
    docker::quiet(&["rm", "-f", &parked]);

    /* The record keeps ONE way back, so a superseded pin is dropped — kept, every update would retain a
     * whole extra image, forever. Never the pin the record still names, and never the base just moved
     * onto (a rollback's target IS the old `previous`). */
    if let Some(old_pin) = saved.previous.as_deref() {
        if old_pin.starts_with(&format!("intentic-sandbox-rollback-{slug}:"))
            && Some(old_pin) != next.as_deref()
            && old_pin != base_image
        {
            docker::quiet(&["rmi", old_pin]);
        }
    }

    match &mode {
        Mode::Rebuild { .. } => println!("intentic: sandbox rebuilt — the Environment card will show Applied once it reconnects."),
        Mode::Update { .. } => {
            println!("intentic: sandbox updated to {target_image} (channel {channel}).");
            // Named on success, not only in the failure paths: a bad build is usually one that STARTS, and
            // the moment to learn the way back is before anyone needs it.
            if next.is_some() {
                println!("          Roll back with: ic sandbox rollback {slug}");
            }
        }
        Mode::Rollback => println!("intentic: sandbox rolled back to {target_image} — run rollback again to return."),
        Mode::Dev => println!("intentic: sandbox is live on {target_image} — docker logs -f {container}"),
    }
    println!(
        "Logs: docker logs -f {container} (recreate log: {})",
        log.path.display()
    );
    Ok(())
}

fn copy_overlay_or_empty(container: &str, dest: &Path) -> Result<()> {
    if !docker::cp_out(container, APPROVED_FILE, dest) {
        std::fs::write(dest, b"")
            .map_err(|err| Fail(format!("could not stage the overlay: {err}")))?;
    }
    Ok(())
}

/// Stdin build (`docker build -t <tag> -`), progress live on the terminal and teed into the log. Failure is
/// detected by the caller via `image_exists` — mirroring the script, where the pipeline's status was tee's.
fn build_overlay(tag: &str, overlay: &Path, pull: bool, log: &Log) {
    log.section(&format!("docker build {tag}"));
    let content = std::fs::read(overlay).unwrap_or_default();
    let mut args = vec!["build"];
    if pull {
        args.push("--pull");
    }
    args.extend_from_slice(&["-t", tag, "-"]);
    let _ = docker::stream_with_stdin(&args, &content, log);
}

/// Rewrite the FIRST `FROM` line to `base` — the dev-mode re-base. Only the first, as the sed range did:
/// a multi-stage overlay's later stages keep their own bases.
fn rewrite_from(overlay: &str, base: &str) -> String {
    let mut rewritten = Vec::new();
    let mut replaced = false;
    for line in overlay.lines() {
        if !replaced && line.trim_start().starts_with("FROM ") {
            rewritten.push(format!("FROM {base}"));
            replaced = true;
        } else {
            rewritten.push(line.to_string());
        }
    }
    let mut joined = rewritten.join("\n");
    if overlay.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// The image an overlay's FIRST `FROM` names — comments and blank lines skipped, so a Dockerfile that opens
/// with a comment block still reads correctly. None when there is no FROM at all.
fn overlay_base(overlay: &str) -> Option<String> {
    overlay
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .find_map(|line| {
            line.strip_prefix("FROM ")
                .map(|rest| rest.split_whitespace().next().unwrap_or("").to_string())
        })
}

/// May an overlay extend this base? Belt-and-braces — the daemon already enforced it at approval — but this
/// is the last check before a build, and the overlay lives on a volume the AGENT can write. Allowed: any
/// OFFICIAL sandbox image, the local dev tag, the exact base this container was created from
/// (SANDBOX_BASE_IMAGE, stamped at `docker run` by whichever runner made it — not a value the agent can
/// reach), or the rollback target the host-side channel record names (the rollback pre-step rewrites the
/// FROM to it, and the record is not agent-writable either). Anything else would let an approved-looking
/// overlay swap the base for an image of its choosing.
fn base_is_allowed(
    base_image: &str,
    current_base: Option<&str>,
    rollback_target: Option<&str>,
) -> bool {
    let official = base_image
        .strip_prefix(&format!("{DEFAULT_REGISTRY}:"))
        .is_some_and(|tag| !tag.is_empty());
    official
        || base_image == DEV_TAG
        || current_base == Some(base_image)
        || rollback_target == Some(base_image)
}

/// The protected local tag a rollback target is pinned under. The registry's tags MOVE — that is what an
/// update is — and the moment one moves, the image it left becomes dangling: one routine
/// `docker image prune` from deleting the only way back. A tag no other flow writes, per slug (two
/// sandboxes on one daemon must not fight over it), named by the image's own id (re-pinning is idempotent).
fn rollback_tag(slug: &str, image_id: &str) -> String {
    let id = image_id.trim_start_matches("sha256:");
    format!("intentic-sandbox-rollback-{slug}:{}", &id[..id.len().min(12)])
}

/// What the record's `previous` becomes on a swap whose bases resolved to these identities. `previous` is
/// what a rollback returns to, and two properties matter. IDENTITY, not names: a stock stable-channel
/// update is :stable → :stable by name while the images differ — exactly the case rollback exists for, and
/// the string comparison this replaces is how every such sandbox ended up with nothing to roll back to.
/// And a rollback SWAPS rather than appends: the build being LEFT becomes the new target, so one button
/// with no "how far back" control is its own undo — pressing it twice returns you forward. An unchanged
/// base (a rebuild, a re-run of the same update) keeps the target — overwriting it with the image we are
/// already on would quietly turn the button into a no-op — and an unknowable identity keeps it too, rather
/// than inventing one: on a first-ever swap the daemon then offers no rollback, honestly.
fn next_previous(
    saved: &record::ChannelRecord,
    old_base_id: Option<&str>,
    new_base_id: Option<&str>,
    slug: &str,
) -> Option<String> {
    match (old_base_id, new_base_id) {
        (Some(old), Some(new)) if old != new => Some(rollback_tag(slug, old)),
        _ => saved.previous.clone(),
    }
}

/// Put the parked container back under its name: the failed replacement (if any) is removed, the old
/// container returns and starts, and the channel record is rewound to what it said before the swap — the
/// swap it described did not happen. Best-effort on every step: this runs on the failure path, where the
/// one job is to leave the machine as close to "before" as it can reach.
fn restore_parked(
    container: &str,
    parked: &str,
    slug: &str,
    channel: &str,
    saved: &record::ChannelRecord,
) {
    if !docker::container_exists(parked) {
        return;
    }
    docker::quiet(&["rm", "-f", container]);
    docker::quiet(&["rename", parked, container]);
    docker::quiet(&["start", container]);
    match &saved.current {
        Some(current) => {
            let _ = record::write(
                slug,
                saved.channel.as_deref().unwrap_or(channel),
                current,
                saved.previous.as_deref(),
            );
        }
        // No record existed before this swap — none must exist after its failure.
        None => {
            let _ = std::fs::remove_file(record::record_path(slug));
        }
    }
    println!("intentic: the previous sandbox container was restored and is starting again.");
}

fn container_env(container: &str, name: &str) -> Option<String> {
    let env = docker::container_env_nul(container).ok()?;
    let text = String::from_utf8_lossy(&env);
    text.split('\0')
        .find_map(|pair| pair.strip_prefix(&format!("{name}=")).map(str::to_string))
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(current: Option<&str>, previous: Option<&str>) -> record::ChannelRecord {
        record::ChannelRecord {
            channel: Some("stable".to_string()),
            current: current.map(str::to_string),
            previous: previous.map(str::to_string),
        }
    }

    #[test]
    fn a_stock_stable_update_pins_the_replaced_image_even_though_the_names_match() {
        // :stable → :stable is string-equal on every stock update; only the ids know the image moved. The
        // string comparison this replaced recorded nothing here — every stock sandbox had no way back.
        assert_eq!(
            next_previous(
                &saved(None, None),
                Some("sha256:0123456789abcdef"),
                Some("sha256:fedcba9876543210"),
                "abc"
            )
            .as_deref(),
            Some("intentic-sandbox-rollback-abc:0123456789ab")
        );
    }

    #[test]
    fn a_rollback_pins_the_build_being_left_so_pressing_it_twice_returns_forward() {
        // Rolling back from bad build (id f…) onto the pinned good one (id 0…): `previous` becomes the
        // image being LEFT, so the next rollback goes forward again.
        assert_eq!(
            next_previous(
                &saved(
                    Some("ghcr.io/intentic/sandbox:stable"),
                    Some("intentic-sandbox-rollback-abc:0123456789ab")
                ),
                Some("sha256:fedcba9876543210"),
                Some("sha256:0123456789abcdef"),
                "abc"
            )
            .as_deref(),
            Some("intentic-sandbox-rollback-abc:fedcba987654")
        );
    }

    #[test]
    fn a_swap_that_does_not_move_the_base_leaves_the_rollback_target_alone() {
        // A rebuild (same base, new overlay) must not overwrite `previous` with the image we are already on.
        assert_eq!(
            next_previous(
                &saved(Some("img:2"), Some("intentic-sandbox-rollback-abc:0123456789ab")),
                Some("sha256:aaaa"),
                Some("sha256:aaaa"),
                "abc"
            )
            .as_deref(),
            Some("intentic-sandbox-rollback-abc:0123456789ab")
        );
    }

    #[test]
    fn an_unknowable_identity_keeps_the_target_rather_than_inventing_one() {
        // First-ever swap, nothing known: no target is recorded, and the daemon offers no rollback, honestly.
        assert_eq!(
            next_previous(&saved(None, None), None, Some("sha256:bbbb"), "abc"),
            None
        );
        // A target already on record survives a swap whose identities cannot be resolved.
        assert_eq!(
            next_previous(&saved(Some("img:2"), Some("pin:1")), None, None, "abc").as_deref(),
            Some("pin:1")
        );
    }

    #[test]
    fn the_pin_is_per_slug_and_named_by_the_images_own_id() {
        assert_eq!(
            rollback_tag("abc", "sha256:0123456789abcdef0123"),
            "intentic-sandbox-rollback-abc:0123456789ab"
        );
        // Docker prints ids both prefixed and bare — both pin to the same tag.
        assert_eq!(
            rollback_tag("abc", "0123456789abcdef0123"),
            "intentic-sandbox-rollback-abc:0123456789ab"
        );
        // A short id is not sliced past its end.
        assert_eq!(rollback_tag("a", "sha256:abc"), "intentic-sandbox-rollback-a:abc");
    }

    #[test]
    fn the_overlay_base_is_the_first_from_past_any_comments() {
        assert_eq!(
            overlay_base(
                "# a note\n\nFROM ghcr.io/intentic/sandbox:stable\nRUN apt-get install -y jq\n"
            )
            .as_deref(),
            Some("ghcr.io/intentic/sandbox:stable")
        );
        // `FROM x AS builder` names x, not the stage alias.
        assert_eq!(
            overlay_base("FROM ghcr.io/intentic/sandbox:1.2.3 AS base\n").as_deref(),
            Some("ghcr.io/intentic/sandbox:1.2.3")
        );
        // A commented-out FROM is not a FROM.
        assert_eq!(overlay_base("# FROM evil:latest\nRUN true\n"), None);
        assert_eq!(overlay_base(""), None);
    }

    #[test]
    fn an_overlay_may_only_extend_an_official_base_the_dev_tag_or_its_own() {
        // Official releases, any tag.
        assert!(base_is_allowed("ghcr.io/intentic/sandbox:stable", None, None));
        assert!(base_is_allowed("ghcr.io/intentic/sandbox:1.2.3", None, None));
        // The dogfood tag, so the dev loop and the rebuild loop are not mutually exclusive.
        assert!(base_is_allowed(DEV_TAG, None, None));
        // This container's own stamped base — the case that lets an already-extended sandbox rebuild.
        assert!(base_is_allowed(
            "intentic-sandbox-env-abc:0123456789ab",
            Some("intentic-sandbox-env-abc:0123456789ab"),
            None
        ));
    }

    #[test]
    fn the_rollback_pin_is_an_allowed_base_only_when_the_host_record_names_it() {
        // The rollback pre-step rewrites the FROM to the record's target; the record is host-side, so the
        // rewritten base is trusted — but only during a rollback that actually named it.
        assert!(base_is_allowed(
            "intentic-sandbox-rollback-abc:0123456789ab",
            None,
            Some("intentic-sandbox-rollback-abc:0123456789ab")
        ));
        assert!(!base_is_allowed(
            "intentic-sandbox-rollback-abc:0123456789ab",
            None,
            None
        ));
    }

    #[test]
    fn an_overlay_may_not_swap_the_base_for_an_image_of_its_choosing() {
        // The whole point of the check: the overlay lives on a volume the AGENT can write.
        assert!(!base_is_allowed("alpine:latest", None, None));
        assert!(!base_is_allowed(
            "evil.example.com/backdoor:latest",
            Some("ghcr.io/intentic/sandbox:stable"),
            None
        ));
        // A tagless official reference is refused rather than resolving to :latest.
        assert!(!base_is_allowed("ghcr.io/intentic/sandbox", None, None));
        assert!(!base_is_allowed("ghcr.io/intentic/sandbox:", None, None));
        // Near-misses on the registry path must not pass as official.
        assert!(!base_is_allowed(
            "ghcr.io/intentic/sandbox-evil:stable",
            None,
            None
        ));
        assert!(!base_is_allowed(
            "ghcr.io/notintentic/sandbox:stable",
            None,
            None
        ));
        // A different sandbox's env image is not this one's base.
        assert!(!base_is_allowed(
            "intentic-sandbox-env-other:abc",
            Some("intentic-sandbox-env-mine:abc"),
            None
        ));
    }

    #[test]
    fn rewrites_only_the_first_from() {
        let overlay = "# comment\nFROM ghcr.io/intentic/sandbox:stable\nRUN apt-get install -y jq\nFROM scratch AS second\n";
        let rewritten = rewrite_from(overlay, "intentic-sandbox:dev");
        assert!(rewritten.contains("FROM intentic-sandbox:dev\n"));
        assert!(rewritten.contains("FROM scratch AS second"));
        assert!(rewritten.ends_with('\n'));
    }
}
