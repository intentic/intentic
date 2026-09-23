use std::path::Path;

use crate::checks;
use crate::contract::{self, RunRequest};
use crate::docker;
use crate::health;
use crate::logfile::Log;
use crate::record;
use crate::sandbox::{resolve_slug, staged, CONTAINER_PREFIX};
use crate::util::{bail, sha256_hex, Fail, Result};

/* Swap THIS machine's sandbox container onto a different image, preserving /work, /history, the tunnel, and every setting the container carries. */

const APPROVED_FILE: &str = "/work/.intentic/local/environment.approved.Dockerfile";
const DEV_TAG: &str = "intentic-sandbox:dev";
// pub(crate): runner.rs names the same registry in its refusal when a shipped overlay's base is not allowed.
pub(crate) const DEFAULT_REGISTRY: &str = "ghcr.io/intentic/sandbox";

pub enum Mode {
    Rebuild {
        hash: String,
    },
    /// `force` is the owner saying they mean to leave a locally-built image behind; without it, an update
    /// aimed at a sandbox built from a checkout is refused rather than granted (see `built_from_checkout`).
    Update {
        channel: Option<String>,
        force: bool,
    },
    Rollback,
    Dev,
    Reshape(Reshape),
}

/// What `ic sandbox reshape` was asked to change. Every field is "leave it" when None. The two caps carry the
/// contract's own spellings (`12g`, `4`) or the EMPTY string, which is the contract's "clear this" — main.rs
/// maps the verb's `default` onto it. The two switches edit the owner's directive tokens (SANDBOX_RUNTIME):
/// they add or withdraw the OWNER's ask only, never what the approved overlay demands, which rides beside them
/// untouched and is unioned back in by the image.
#[derive(Default, Clone)]
pub struct Reshape {
    pub memory: Option<String>,
    pub cpus: Option<String>,
    pub privileged: Option<bool>,
    pub gpus: Option<bool>,
}

// The directive tokens the two switches stand for, in the contract's single-token spelling
// (@intentic/sandbox-run RUNTIME_DIRECTIVES). Named here only to EDIT the owner's list; validated in the image.
const PRIVILEGED_TOKEN: &str = "--privileged";
const GPUS_TOKEN: &str = "--gpus=all";
const HOST_RUNTIME_ENV: &str = "SANDBOX_RUNTIME";

/* How long the cutover will wait for dockerd to hand back the loopback port the container it just stopped was publishing (see the launch in `recreate`). */
const PORT_RELEASE_TRIES: u32 = 3;
const PORT_RELEASE_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/* Did a launch fail because its published port is still taken? */
fn port_still_held(refusal: &str) -> bool {
    refusal.contains("port is already allocated")
}

impl Mode {
    fn name(&self) -> &'static str {
        match self {
            Mode::Rebuild { .. } => "rebuild",
            Mode::Update { .. } => "update",
            Mode::Rollback => "rollback",
            Mode::Dev => "dev",
            Mode::Reshape(_) => "reshape",
        }
    }
}

/// How far a run goes. `Applied` is every verb that ends with the sandbox on a different image; `Staged`
/// stops at the seam — everything that BUILDS the target, and nothing that touches the container.
#[derive(Clone, Copy, PartialEq)]
enum Reach {
    Staged,
    Applied,
}

pub fn run(mode: Mode, slug: Option<String>) -> Result<()> {
    recreate(mode, slug, Reach::Applied, false)
}

/// `ic sandbox prepare` — the pull and the overlay rebuild, taken off the click. Runs against a live sandbox
/// that keeps serving throughout, and leaves the container untouched whether it succeeds or fails.
///
/// `auto` is the machine agent's background tick speaking (@intentic/machine runs this on a timer so the
/// update card can offer a half-minute restart without anyone clicking Download first). Same flow, three
/// softened edges, each because nobody is watching: a pinned or locally-built sandbox is skipped rather than
/// offered the channel it deliberately left, low disk is "not now" rather than a warning scrolled past, and
/// a container parked mid-recreate is left exactly where a person's interrupted command left it.
pub fn prepare(slug: Option<String>, channel: Option<String>, auto: bool) -> Result<()> {
    recreate(
        Mode::Update {
            channel,
            force: false,
        },
        slug,
        Reach::Staged,
        auto,
    )
}

fn recreate(mode: Mode, slug: Option<String>, reach: Reach, auto: bool) -> Result<()> {
    if !docker::cli_present() {
        bail!("docker is required — run this on the machine that runs the sandbox.");
    }
    // What the user typed, for every re-run hint below: `prepare` is `update` stopped early, so the mode's own
    // name would send someone back to the command that does the whole thing.
    let verb = match reach {
        Reach::Staged => "prepare",
        Reach::Applied => mode.name(),
    };
    let slug = resolve_slug(slug, &format!("ic sandbox {verb}"))?;
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
        // Un-parking a half-finished recreate restarts a container somebody's interrupted command chose to
        // stop, and a background tick has no idea why it was interrupted. A person's next prepare/update
        // restores it; auto leaves the machine exactly as it found it and says which command to reach for.
        if auto {
            bail!(
                "sandbox {slug} was left parked by an interrupted recreate — run `ic sandbox update {slug}` yourself to put it back."
            );
        }
        println!("intentic: restoring the sandbox an interrupted recreate left parked…");
        docker::quiet(&["rename", &parked, &container]);
        docker::quiet(&["start", &container]);
    }

    /* Preparing holds a SECOND full copy of the image until a swap consumes it, and a machine that also carries a rollback pin can be holding three. */
    if reach == Reach::Staged {
        match checks::check_disk() {
            checks::Outcome::Fail { problem, remedy } => bail!(
                "{problem}\n       {remedy}\n       Nothing was downloaded and your sandbox is untouched."
            ),
            checks::Outcome::Warn { problem } => {
                println!("intentic: {problem}");
/* A person reading this warning can weigh it; a timer cannot, and "proceed" from a timer is how a machine that was merely getting full gets filled. */
                if auto {
                    println!("intentic: skipping this background download — the space above is a person's call. `ic sandbox prepare {slug}` still takes it by hand.");
                    return Ok(());
                }
            }
            _ => {}
        }
    }

    // The tag this sandbox follows. An explicit --channel wins and is remembered; otherwise the remembered
    // one, and `stable` for a sandbox that predates the record. SANDBOX_IMAGE still overrides everything:
    // it is how a pinned or locally-built image is passed in, and a channel is a default, not a policy.
    let saved = record::read(&slug);
    let channel = match &mode {
        Mode::Update {
            channel: Some(chosen),
            ..
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

    /* The EXACT image the running sandbox was built from, captured before anything pulls. */
    let current_base = docker::container_env_value(&container, "SANDBOX_BASE_IMAGE");
    let sandbox_image = docker::container_env_value(&container, "SANDBOX_IMAGE");

    /* AN UNATTENDED PREPARE ONLY TRACKS THE OFFICIAL REGISTRY. */
    if auto
        && image_override.is_none()
        && !follows_registry(current_base.as_deref(), sandbox_image.as_deref())
    {
        println!("intentic: sandbox {slug} runs a pinned or locally-built image — background downloads don't apply to it.");
        return Ok(());
    }

    /* AN UPDATE DOES NOT REFRESH AN IMAGE BUILT FROM A CHECKOUT, IT REPLACES IT. */
    if matches!(mode, Mode::Update { force: false, .. })
        && image_override.is_none()
        && built_from_checkout(current_base.as_deref(), sandbox_image.as_deref())
    {
        bail!(
            "sandbox {slug} runs an image built from a checkout ({DEV_TAG}), so an update would move it onto {registry_image} rather than refresh it.\n       Rebuild it from that checkout instead: `pnpm rebuild:sandbox {slug}`.\n       To move it onto the published image anyway: `ic sandbox update {slug} --force`."
        );
    }

    let old_base_id = if current_base.is_none() || current_base == sandbox_image {
        docker::inspect(&container, "{{.Image}}")
    } else {
        current_base.as_deref().and_then(docker::image_id)
    };

    let log = Log::create_named("recreate", &format!("recreate-{verb}"))?;
    let workdir = tempfile::tempdir()?;
    let overlay_path = workdir.path().join("overlay.Dockerfile");

    // ——— The mode pre-step: produce target/base/env-hash and the overlay file (may be empty). ———
    let mut env_hash: Option<String> = None;
    // Whether this update is riding an image `prepare` already built. Decided in the Update arm below, read
    // again by the build block, which then has nothing left to build.
    let mut prepared = false;
    match &mode {
        Mode::Rebuild { hash } => {
            // Copy the approved overlay out ONCE and hash/build that same copy — byte-exact, no window
            // between the check and the build. The overlay lives on the workspace volume the agent can
            // write, so only content that still hashes to what the owner reviewed is ever built.
            if let Some(reason) = docker::cp_out(&container, APPROVED_FILE, &overlay_path) {
                bail!("no approved overlay could be read from the sandbox — approve the proposal on the Environment card first, or fix what docker reported.\n       docker: {reason}");
            }
            let have = sha256_hex(&std::fs::read(&overlay_path)?);
            if have != *hash {
                bail!("the approved overlay changed since it was reviewed (expected {hash}, found {have}).\n       Re-review and re-approve it on the Environment card, then run the fresh command it shows.");
            }
            env_hash = Some(hash.clone());
        }
        Mode::Update { .. } => {
            /* The approved overlay comes out FIRST here, ahead of the decision below. */
            stage_overlay(&container, &overlay_path)?;
            let approved = std::fs::read(&overlay_path).unwrap_or_default();
            let approved_hash = (!approved.is_empty()).then(|| sha256_hex(&approved));

            /* WHAT `prepare` LEFT READY, when it is still the right thing to swap onto — the whole point of preparing. */
            prepared = reach == Reach::Applied
                // SANDBOX_IMAGE names an exact image to run — a pinned build, a locally-built one. Someone
                // who passed it asked for THAT image, not for whatever was staged for the channel.
                && image_override.is_none()
                && staged_still_fits(&saved, &channel, approved_hash.as_deref(), old_base_id.as_deref())
                && docker::image_exists(saved.staged.as_deref().unwrap_or_default());
            /* A staged entry that no longer fits is DROPPED here — from the record AND from the sandbox, in one call. */
            if !prepared && reach == Reach::Applied {
                if saved.staged.is_some() {
                    println!("intentic: the prepared update no longer fits this sandbox — updating the ordinary way.");
                }
                clear_staged(&slug, &container, &saved);
            }
            if prepared {
                println!("intentic: using the update prepared earlier — nothing to download.");
            } else {
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
                /* "Already current" means THIS CONTAINER runs the image the tag now names — not that the pull moved nothing. */
                let already_current = match (&old_base_id, &pulled) {
                    (Some(old), Some(new)) => old == new,
                    _ => cached.is_some() && cached == pulled,
                };
                if already_current {
                    /* Nothing is waiting for this sandbox, whatever the record last said. */
                    clear_staged(&slug, &container, &saved);
                    println!("intentic: no newer sandbox image is available yet — your sandbox is already on the latest :{channel} it can pull.");
                    println!("          If the app still shows an update, the new release's image may still be publishing — try again in a few minutes.");
                    return Ok(());
                }
            }
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
            stage_overlay(&container, &overlay_path)?;
            /* The overlay must ride the TARGET, not its own FROM: the FROM names the channel tag, which now points at the very build being rolled back from. */
            let approved = std::fs::read_to_string(&overlay_path)?;
            if !approved.is_empty() {
                let (hash, rebased) = rebase_overlay(&approved, &registry_image);
                env_hash = Some(hash);
                std::fs::write(&overlay_path, rebased)?;
            }
        }
        Mode::Reshape(_) => {
            /* Nothing to fetch and nothing to build: the target is the image this container already runs. */
            stage_overlay(&container, &overlay_path)?;
            env_hash = docker::container_env_value(&container, "SANDBOX_ENVIRONMENT_HASH");
        }
        Mode::Dev => {
            if !docker::image_exists(DEV_TAG) {
                bail!("image {DEV_TAG} not found — run 'pnpm build:sandbox' first.");
            }
            // The overlay's tooling must ride the dev image too, or the dev loop and the rebuild loop are
            // mutually exclusive: this flow would hand you a fresh daemon missing the docker/vpn
            // capability's packages, while rebuild would hand you the packages on the LAST RELEASE's
            // daemon. The FROM is rewritten to the dev tag; --base-image below keeps composing against it.
            let staged = stage_overlay(&container, &overlay_path)?;
            let approved = std::fs::read_to_string(&overlay_path)?;
            if !approved.is_empty() {
                let (hash, rebased) = rebase_overlay(&approved, DEV_TAG);
                env_hash = Some(hash);
                std::fs::write(&overlay_path, rebased)?;
            }
            // Said out loud, because this is the loop a developer runs a dozen times a day: the one shape
            // where a dev swap legitimately hands back a bare image is a sandbox that has nothing approved,
            // and it should look different on screen from one that kept its environment.
            if !staged {
                println!("intentic: no approved environment recipe on this sandbox — recreating it from {DEV_TAG} alone.");
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
        if !base_is_allowed(
            &base_image,
            current_base.as_deref(),
            rollback_target.as_deref(),
        ) {
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
        /* One arm, because a rollback IS an update pointed at the pinned image — same overlay rebuild, same base pinning, same health gate — with one inversion. */
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
            }
            /* A prepared update is the same derivation already performed, so this arm's own answer and the record's staged image are the same string by construction. */
            if prepared {
                target_image = saved.staged.clone().unwrap_or(target_image);
            } else if !overlay.is_empty() {
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
                let hash = env_hash.as_deref().expect("dev set the hash");
                target_image = format!("intentic-sandbox-dev-env-{slug}:{}", &hash[..12]);
                println!("intentic: building {target_image} — the overlay's tooling on top of {DEV_TAG}…");
                build_overlay(&target_image, &overlay_path, false, &log);
            }
        }
        Mode::Reshape(_) => {
            // The image the container runs NOW (SANDBOX_IMAGE, stamped by whichever runner made it) and the
            // base it composes against — both replayed as they are, because nothing about the image changes.
            let Some(running) = sandbox_image.clone() else {
                bail!("this sandbox predates the run contract (no SANDBOX_IMAGE on its container) — run `ic sandbox update {slug}` once, then reshape it.");
            };
            target_image = running;
            if base_image.is_empty() {
                base_image = current_base.clone().unwrap_or_else(|| target_image.clone());
            }
            if !docker::image_exists(&target_image) {
                bail!("the image this sandbox runs ({target_image}) is no longer on this machine, so it cannot be recreated as it is — run `ic sandbox update {slug}` first. The sandbox is untouched.");
            }
        }
    }
    if !docker::image_exists(&target_image) {
        bail!("{target_image} is not available (pull or overlay build failed) — the sandbox is untouched. Log: {}", log.path.display());
    }

    /* `prepare` stops here, which is the whole of what makes it safe to run at any moment: the container has not been read from since the overlay copy. */
    if reach == Reach::Staged {
        return record_staged(
            Prepared {
                slug: &slug,
                container: &container,
                channel: &channel,
                image: &target_image,
                base_image: &base_image,
                env_hash: env_hash.as_deref(),
            },
            &saved,
            &log,
        );
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
    // a daemon edit restarts in seconds instead of a rebuild — newline-separated -v specs, straight through.
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
    /* THE OWNER'S OWN DIRECTIVES, the second source beside the overlay's: what the container carries now (SANDBOX_RUNTIME, replayed by every other mode). */
    let carried_runtime =
        docker::container_env_value(&container, HOST_RUNTIME_ENV).unwrap_or_default();
    let (host_runtime, seeds) = match &mode {
        Mode::Reshape(ask) => reshape_seeds(ask, &carried_runtime),
        _ => (carried_runtime, Vec::new()),
    };
    // Which asks this host cannot honour — probed via the image (the list lives in the run contract), so
    // the sandbox starts without an optional extra instead of `docker run` refusing the whole launch.
    let probes = if runtime_lines.is_empty() && host_runtime.is_empty() {
        Vec::new()
    } else {
        contract::host_probes(&target_image, &runtime_lines, &host_runtime, &log)
    };
    let unsupported = contract::unsupported_on_this_host(&probes);

    // The resolvers the container was created with. The hand-written recreates silently DROPPED these on
    // every swap — a restricted-network sandbox lost its split-horizon config the first time its owner
    // rebuilt it; replaying them through the contract is what fixed that class.
    // `HostConfig` is docker's key, not this repo's vocabulary: under any other name the template errors, the
    // inspect returns None, and the resolvers are dropped exactly as the hand-written recreates used to drop them.
    let dns = docker::inspect(&container, "{{join .HostConfig.Dns \" \"}}")
        .filter(|servers| !servers.is_empty());

    /* What the record's `previous` becomes — the rollback target — decided by identity above and pinned under a protected local tag. */
    let new_base_id = docker::image_id(&base_image);
    let next = next_previous(
        &saved,
        old_base_id.as_deref(),
        new_base_id.as_deref(),
        &slug,
    );
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
        // Never on a recreate: the seed is a first-boot thing, already consumed on the volume this container
        // keeps, and the daemon guards against replays anyway (workspaceArrivedEmpty).
        definition_b64: None,
    };
    let argv = contract::run_command(&request, &env_nul, false, &unsupported, &seeds, &log)?;

    // Before the cutover, where a failure still leaves the running container alone: a network pruned while
    // this sandbox was stopped would otherwise refuse the replacement after the old one is parked.
    crate::sandbox::ensure_network(&slug)?;

    println!("intentic: recreating the sandbox from {target_image}…");
    log.section(&format!("previous container logs ({container})"));
    docker::logs_into(&container, "5000", &log);

    /* The channel record — written BEFORE the swap and before the LAUNCH: a swap that starts and then crash-loops is exactly the case rollback is for. */
    /* Reshape reuses the staged image because it does not build one. */
    let reshaping = matches!(mode, Mode::Reshape(_));
    record::write(
        &slug,
        &record::ChannelRecord {
            channel: Some(channel.clone()),
            current: Some(base_image.clone()),
            previous: next.clone(),
            ..(if reshaping {
                saved.clone()
            } else {
                record::ChannelRecord::default()
            })
        },
    )?;

    /* The cutover PARKS the old container instead of destroying it: stop, rename aside, and only a replacement that answers health earns the rm. */
    docker::quiet(&["rm", "-f", &parked]);
    docker::quiet(&["stop", &container]);
    docker::quiet(&["rename", &container, &parked]);
    log.section("run command");

    /* THE PORT THIS CUTOVER JUST FREED IS NOT FREE YET, and that is a race rather than a refusal. */
    let mut launched = docker::run_argv(&argv, &log);
    for _ in 0..PORT_RELEASE_TRIES {
        // The last attempt's refusal alone, so a conflict on an earlier attempt cannot keep this true once a later
        // one has failed for some other reason.
        match &launched {
            Err(refusal) if port_still_held(refusal) => {}
            _ => break,
        }
        // The refused attempt leaves a created-but-stopped container holding the name, exactly as below.
        docker::quiet(&["rm", "-f", &container]);
        std::thread::sleep(PORT_RELEASE_WAIT);
        launched = docker::run_argv(&argv, &log);
    }

    // Two attempts: everything the run can lose WITHOUT the sandbox being broken comes off together on the
    // retry — the loopback shortcut (docker refuses the whole launch when its port is already held) and
    // EVERY optional directive, even ones whose probe passed: a probe answers a question docker answers
    // again at run time, and it can answer differently (an nvidia runtime registered against a mismatched
    // driver satisfies `docker info` and then fails the container). A sandbox that comes back saying it has
    // no GPU beats no sandbox. The failed attempt leaves a created-but-stopped container holding the name.
    if launched.is_err() {
        docker::quiet(&["rm", "-f", &container]);
        let all_optional: Vec<String> = probes.iter().map(|probe| probe.token.clone()).collect();
        let retry_argv =
            match contract::run_command(&request, &env_nul, true, &all_optional, &seeds, &log) {
                Ok(retry_argv) => retry_argv,
                Err(err) => {
                    restore_parked(&container, &parked, &slug, &saved);
                    return Err(err);
                }
            };
        if let Err(refusal) = docker::run_argv(&retry_argv, &log) {
            restore_parked(&container, &parked, &slug, &saved);
            bail!(
                "starting the recreated sandbox failed (a runtime flag the host rejects, e.g. --privileged or /dev/net/tun?).\n{refusal}\n       Your previous sandbox was restored. The old container's logs and this error are saved to {}.",
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
        restore_parked(&container, &parked, &slug, &saved);
        return Err(err);
    }
    health::wait_ready(&container);
    docker::quiet(&["rm", "-f", &parked]);

    /* Take the "an update is ready for you" offer back, now that the swap is real. */
    if !reshaping {
        staged::withdraw(&container);
    }

    /* The record keeps ONE way back, so a superseded pin is dropped — kept, every update would retain a whole extra image, forever. */
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
        // What is IN FORCE, read back off the container rather than echoed from the ask: the contract may have
        // bounded a cap to the machine, and a host without the runtime may have dropped the GPU.
        Mode::Reshape(_) => println!(
            "intentic: sandbox reshaped — {}. The values live on the sandbox and survive every later update.",
            describe_shape(&container)
        ),
    }
    println!(
        "Logs: docker logs -f {container} (recreate log: {})",
        log.path.display()
    );
    Ok(())
}

/// `ic sandbox reshape` — the same image, a different share of this machine. Always a named slug: the verb
/// changes a container's privileges, and "the one sandbox here" is not a thing to guess at for that.
pub fn reshape(slug: String, ask: Reshape) -> Result<()> {
    if ask.memory.is_none() && ask.cpus.is_none() && ask.privileged.is_none() && ask.gpus.is_none()
    {
        bail!("nothing to change — give at least one of --memory, --cpus, --privileged, --gpus.");
    }
    recreate(Mode::Reshape(ask), Some(slug), Reach::Applied, false)
}

/* THE RESHAPE'S PAYLOAD, as pure arithmetic on strings so it can be asserted without a container. */
fn reshape_seeds(ask: &Reshape, carried: &str) -> (String, Vec<contract::Seed>) {
    let tokens = apply_switches(carried, ask.privileged, ask.gpus);
    let mut seeds: Vec<contract::Seed> = Vec::new();
    if let Some(memory) = &ask.memory {
        seeds.push(("SANDBOX_MEMORY".to_string(), memory.clone()));
    }
    if let Some(cpus) = &ask.cpus {
        seeds.push(("SANDBOX_CPUS".to_string(), cpus.clone()));
    }
    if ask.privileged.is_some() || ask.gpus.is_some() {
        seeds.push((HOST_RUNTIME_ENV.to_string(), tokens.clone()));
    }
    (tokens, seeds)
}

/// The owner's token list with the two switches applied: `Some(true)` adds the token once, `Some(false)`
/// withdraws it, `None` leaves it. Order is kept, so an unrelated token the owner carries rides on unchanged.
fn apply_switches(carried: &str, privileged: Option<bool>, gpus: Option<bool>) -> String {
    let mut tokens: Vec<String> = carried
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    tokens.dedup();
    for (token, switch) in [(PRIVILEGED_TOKEN, privileged), (GPUS_TOKEN, gpus)] {
        match switch {
            Some(true) if !tokens.iter().any(|have| have == token) => {
                tokens.push(token.to_string())
            }
            Some(false) => tokens.retain(|have| have != token),
            _ => {}
        }
    }
    tokens.join(" ")
}

/// The container's share of this machine as docker now enforces it, for the reshape's closing line: the
/// cgroup caps (0 = unbounded) and whether it runs privileged. Read, not echoed — see the caller.
fn describe_shape(container: &str) -> String {
    let field = |format: &str| docker::inspect(container, format).unwrap_or_default();
    let memory = match field("{{.HostConfig.Memory}}").parse::<u64>() {
        Ok(0) | Err(_) => "memory unbounded".to_string(),
        Ok(bytes) => format!("memory {}g", bytes / (1024 * 1024 * 1024)),
    };
    let cpus = match field("{{.HostConfig.NanoCpus}}").parse::<u64>() {
        Ok(0) | Err(_) => "every CPU".to_string(),
        Ok(nanos) => format!("{} CPUs", nanos / 1_000_000_000),
    };
    let privileged = if field("{{.HostConfig.Privileged}}") == "true" {
        "privileged"
    } else {
        "unprivileged"
    };
    format!("{memory}, {cpus}, {privileged}")
}

/* WHAT `prepare` LEAVES BEHIND: a built image, the host record naming it, and the sandbox told about it. */
/// What a prepare built, named the way the record and the marker both need it.
struct Prepared<'a> {
    slug: &'a str,
    container: &'a str,
    channel: &'a str,
    image: &'a str,
    base_image: &'a str,
    env_hash: Option<&'a str>,
}

fn record_staged(what: Prepared<'_>, saved: &record::ChannelRecord, log: &Log) -> Result<()> {
    let version = staged::image_version(what.image);
    record::write(
        what.slug,
        &record::ChannelRecord {
            staged: Some(what.image.to_string()),
            staged_base: docker::image_id(what.base_image),
            staged_env: what.env_hash.map(str::to_string),
            staged_channel: Some(what.channel.to_string()),
            staged_version: version.clone(),
            ..saved.clone()
        },
    )?;
    staged::announce(
        what.container,
        version.as_deref(),
        what.channel,
        what.image,
        log,
    );
    match &version {
        Some(version) => println!("intentic: {version} is downloaded and built, and your sandbox is still running on the old one."),
        None => println!("intentic: the next update is downloaded and built, and your sandbox is still running on the old one."),
    }
    println!(
        "          Applying it is now a restart of about half a minute: ic sandbox update {}",
        what.slug
    );
    Ok(())
}

/// Forget a staged update, on both sides at once — the host record and the sandbox's own copy of the fact.
/// Best-effort on the record: this runs where something better has already been decided, and a record that
/// cannot be rewritten must not turn a working update into a failed command.
fn clear_staged(slug: &str, container: &str, saved: &record::ChannelRecord) {
    if saved.staged.is_none() {
        return;
    }
    let _ = record::write(slug, &saved.without_staged());
    staged::withdraw(container);
}

/// Is what `prepare` left still the right thing to swap onto? Pure, because every clause here is a way for a
/// fast update to hand someone the wrong image, and none of them is observable afterwards:
///
///   • a DIFFERENT CHANNEL was asked for — a `--channel beta` update must not take a stable build
///   • the OWNER RE-APPROVED a different environment recipe since — they get the recipe they approved
///   • the sandbox has ALREADY REACHED that base by another route — there is nothing left to apply
///
/// The staged image's own existence is checked by the caller (it needs a daemon); everything else is here.
fn staged_still_fits(
    saved: &record::ChannelRecord,
    channel: &str,
    approved_hash: Option<&str>,
    old_base_id: Option<&str>,
) -> bool {
    saved.staged.is_some()
        && saved.staged_channel.as_deref() == Some(channel)
        && saved.staged_env.as_deref() == approved_hash
        && (saved.staged_base.is_none() || saved.staged_base.as_deref() != old_base_id)
}

/// What a copy of the approved overlay came back with. `Stock` is a sandbox that has no overlay at all — no
/// capability enabled, nothing approved — and staging an empty file for it is right: there is nothing to
/// re-apply. `Lost` is the same empty answer from a sandbox that HAS one, which is not a shape but a fault.
enum Overlay {
    Copied,
    Stock,
    Lost,
}

/* Treating those two alike is what made a dev rebuild able to strip a sandbox in silence: the copy came back with nothing, the flow staged an empty overlay. */
fn overlay_outcome(copied: bool, has_one: bool) -> Overlay {
    match (copied, has_one) {
        (true, _) => Overlay::Copied,
        (false, false) => Overlay::Stock,
        (false, true) => Overlay::Lost,
    }
}

/* Whether the sandbox has an approved overlay ANYWAY, asked two ways because the copy's own answer is the one in doubt. */
fn overlay_exists(container: &str) -> bool {
    docker::exec_ok(container, &["test", "-f", APPROVED_FILE])
        || docker::container_env_value(container, "SANDBOX_ENVIRONMENT_HASH").is_some()
}

/// Stage the sandbox's approved overlay at `dest` for the flow to build from. True when there is one; false
/// for a stock sandbox, whose empty file every caller reads as "nothing to re-apply".
fn stage_overlay(container: &str, dest: &Path) -> Result<bool> {
    let reason = docker::cp_out(container, APPROVED_FILE, dest);
    let copied = reason.is_none();
    match overlay_outcome(copied, !copied && overlay_exists(container)) {
        Overlay::Copied => Ok(true),
        Overlay::Stock => {
            std::fs::write(dest, b"")
                .map_err(|err| Fail(format!("could not stage the overlay: {err}")))?;
            Ok(false)
        }
        Overlay::Lost => bail!(
            "this sandbox has an approved environment, but its recipe could not be read out of {container}:\n       {}\n       Recreating now would drop everything the recipe installs, so the sandbox is untouched.",
            reason.unwrap_or_default()
        ),
    }
}

/// Stdin build (`docker build -t <tag> -`), progress live on the terminal and teed into the log. Failure is
/// detected by the caller via `image_exists` — mirroring the script, where the pipeline's status was tee's.
/// pub(crate): `ic runner up` builds a parent-shipped overlay through this same door (runner.rs).
pub(crate) fn build_overlay(tag: &str, overlay: &Path, pull: bool, log: &Log) {
    log.section(&format!("docker build {tag}"));
    let content = std::fs::read(overlay).unwrap_or_default();
    let mut args = vec!["build"];
    if pull {
        args.push("--pull");
    }
    args.extend_from_slice(&["-t", tag, "-"]);
    let _ = docker::stream(&args, Some(&content), docker::Shown::Raw, log);
}

/// The overlay a re-basing recreate builds and the hash its container carries, derived together because they have
/// to name the SAME base — the one arm the two modes that move an overlay onto another image share (dev onto
/// DEV_TAG, rollback onto the pinned previous build). The daemon recomposes the approved file from
/// SANDBOX_BASE_IMAGE on every boot and compares that hash with SANDBOX_ENVIRONMENT_HASH, so the hash is the
/// REBASED file's; pinning the pre-rebase bytes leaves a recreate that worked reading as "pending rebuild" forever.
fn rebase_overlay(approved: &str, base: &str) -> (String, String) {
    let rebased = rewrite_from(approved, base);
    (sha256_hex(rebased.as_bytes()), rebased)
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
/// pub(crate): the runner-up overlay path reads its base the same way (runner.rs).
pub(crate) fn overlay_base(overlay: &str) -> Option<String> {
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
pub(crate) fn base_is_allowed(
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
    format!(
        "intentic-sandbox-rollback-{slug}:{}",
        &id[..id.len().min(12)]
    )
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
fn restore_parked(container: &str, parked: &str, slug: &str, saved: &record::ChannelRecord) {
    if !docker::container_exists(parked) {
        return;
    }
    docker::quiet(&["rm", "-f", container]);
    docker::quiet(&["rename", parked, container]);
    docker::quiet(&["start", container]);
    match saved.current {
        // Byte for byte what was there, staged keys included: the swap this record described did not happen,
        // and a prepared image that was never applied is still sitting on this machine waiting to be.
        Some(_) => {
            let _ = record::write(slug, saved);
        }
        // No record existed before this swap — none must exist after its failure.
        None => {
            let _ = std::fs::remove_file(record::record_path(slug));
        }
    }
    println!("intentic: the previous sandbox container was restored and is starting again.");
}

/// Whether this container follows the official registry — the question an UNATTENDED prepare asks before
/// touching anything. Judged from the run contract's own stamps (index.ts writes both at `docker run`; the
/// agent can write neither): the base the overlay extends when the container is an overlay build, else the
/// image it was run from. Pure, because a wrong answer here is silent in both directions — a skipped stock
/// sandbox never gets its background download, and a tracked dev sandbox gets an "update ready" card that
/// would move it onto :stable.
///
/// A rollback pin reads as off-registry ON PURPOSE: a rolled-back sandbox is a person mid-decision, and the
/// next release is theirs to take by hand (the update card still offers it — this only stops the download
/// from happening behind their back). Their next update puts the base back on the registry, and the timer
/// resumes with it. A container carrying neither stamp predates the run contract; a background job does not
/// guess about a box it cannot classify.
/// Was this sandbox's image built from a checkout on this machine (the dogfood loop's `intentic-sandbox:dev`,
/// or an environment overlay composed on top of it)? Exactly that one tag, never "any non-registry image":
/// a rollback pin is a local tag too, and an update off one is how a rolled-back sandbox rejoins its channel.
/// The daemon's twin, which decides what the Environment card offers, is DEV_SANDBOX_IMAGE in the contract's
/// policy/overlay-lint.ts.
fn built_from_checkout(current_base: Option<&str>, sandbox_image: Option<&str>) -> bool {
    current_base.or(sandbox_image) == Some(DEV_TAG)
}

fn follows_registry(current_base: Option<&str>, sandbox_image: Option<&str>) -> bool {
    current_base.or(sandbox_image).is_some_and(|followed| {
        followed
            .strip_prefix(&format!("{DEFAULT_REGISTRY}:"))
            .is_some_and(|tag| !tag.is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(current: Option<&str>, previous: Option<&str>) -> record::ChannelRecord {
        record::ChannelRecord {
            channel: Some("stable".to_string()),
            current: current.map(str::to_string),
            previous: previous.map(str::to_string),
            ..record::ChannelRecord::default()
        }
    }

    /// A record with an update prepared for `channel`, built from base id `base` with overlay hash `env`.
    fn prepared(channel: &str, base: &str, env: Option<&str>) -> record::ChannelRecord {
        record::ChannelRecord {
            staged: Some("intentic-sandbox-env-abc:0123456789ab".to_string()),
            staged_base: Some(base.to_string()),
            staged_env: env.map(str::to_string),
            staged_channel: Some(channel.to_string()),
            staged_version: Some("1.4.2".to_string()),
            ..saved(Some("ghcr.io/intentic/sandbox:stable"), None)
        }
    }

    /* THE RESHAPE'S ARITHMETIC. */
    #[test]
    fn switches_edit_only_their_own_token_and_leave_the_rest_of_the_owners_list_alone() {
        assert_eq!(apply_switches("", Some(true), None), "--privileged");
        assert_eq!(
            apply_switches("--privileged", Some(true), None),
            "--privileged"
        );
        assert_eq!(
            apply_switches("--privileged --gpus=all", Some(false), None),
            "--gpus=all"
        );
        assert_eq!(
            apply_switches("--privileged", None, Some(true)),
            "--privileged --gpus=all"
        );
        // A token the owner carries that this binary knows nothing about rides on untouched.
        assert_eq!(
            apply_switches(
                "--device=/dev/net/tun --privileged",
                Some(false),
                Some(true)
            ),
            "--device=/dev/net/tun --gpus=all"
        );
        assert_eq!(apply_switches("--gpus=all", Some(false), Some(false)), "");
        assert_eq!(
            apply_switches("  --privileged   --privileged ", None, None),
            "--privileged"
        );
    }

    /* WHICH LAUNCH FAILURES ARE WORTH WAITING OUT. */
    #[test]
    fn only_a_held_port_is_worth_waiting_out_and_the_address_is_never_matched_on() {
        // Verbatim dockerd, the refusal this whole retry exists for.
        assert!(port_still_held(
            "docker: Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint intentic-sandbox-sandbox-0738cd6b5027 (c3808c38): Bind for 127.0.0.1:29293 failed: port is already allocated"
        ));
        // The same refusal for a different sandbox's port: matched on the message, so no port arithmetic here
        // has to agree with the contract's.
        assert!(port_still_held(
            "Bind for 127.0.0.1:28937 failed: port is already allocated"
        ));
        // The failures the publish-less retry is for — waiting changes none of them.
        assert!(!port_still_held(
            "docker: Error response from daemon: could not select device driver \"\" with capabilities: [[gpu]]"
        ));
        assert!(!port_still_held(
            "docker: Error response from daemon: privileged mode is incompatible with this host"
        ));
        assert!(!port_still_held(""));
    }

    #[test]
    fn a_reshape_seeds_exactly_what_was_asked_and_re_states_the_token_list_only_when_a_switch_moved(
    ) {
        let caps_only = Reshape {
            memory: Some("12g".into()),
            cpus: Some(String::new()),
            ..Reshape::default()
        };
        let (runtime, seeds) = reshape_seeds(&caps_only, "--gpus=all");
        // The carried list is still what the host is probed about…
        assert_eq!(runtime, "--gpus=all");
        // …but it is NOT re-stated as a seed: it replays off the old container like every other pair.
        assert_eq!(
            seeds,
            vec![
                ("SANDBOX_MEMORY".to_string(), "12g".to_string()),
                ("SANDBOX_CPUS".to_string(), String::new()),
            ]
        );

        let switch = Reshape {
            privileged: Some(true),
            ..Reshape::default()
        };
        let (runtime, seeds) = reshape_seeds(&switch, "--gpus=all");
        assert_eq!(runtime, "--gpus=all --privileged");
        assert_eq!(
            seeds,
            vec![(
                "SANDBOX_RUNTIME".to_string(),
                "--gpus=all --privileged".to_string()
            )]
        );

        // Withdrawing the last token seeds an EMPTY list, which is the contract's "clear", not "leave it".
        let withdraw = Reshape {
            gpus: Some(false),
            ..Reshape::default()
        };
        let (runtime, seeds) = reshape_seeds(&withdraw, "--gpus=all");
        assert_eq!(runtime, "");
        assert_eq!(seeds, vec![("SANDBOX_RUNTIME".to_string(), String::new())]);
    }

    #[test]
    fn a_prepared_update_for_this_channel_and_this_recipe_is_taken() {
        // The ordinary case, and the whole point: the pull and the overlay build already happened, so the
        // click is a cutover. `old` is what the container runs now; `new` is what was staged.
        assert!(staged_still_fits(
            &prepared("stable", "sha256:new", Some("deadbeef")),
            "stable",
            Some("deadbeef"),
            Some("sha256:old")
        ));
        // A stock sandbox has no overlay on either side, and absent must match absent.
        assert!(staged_still_fits(
            &prepared("stable", "sha256:new", None),
            "stable",
            None,
            Some("sha256:old")
        ));
    }

    #[test]
    fn a_prepared_update_for_a_different_channel_is_not_this_update() {
        // `ic sandbox update --channel beta` on a sandbox with a stable build staged must fetch beta. Taking
        // the staged one would move the sandbox onto a channel by the name of the one it was asked for.
        assert!(!staged_still_fits(
            &prepared("stable", "sha256:new", None),
            "beta",
            None,
            Some("sha256:old")
        ));
    }

    #[test]
    fn a_recipe_the_owner_has_re_approved_since_invalidates_what_was_staged() {
        /* The staged image bakes the overlay it was built with. */
        assert!(!staged_still_fits(
            &prepared("stable", "sha256:new", Some("deadbeef")),
            "stable",
            Some("cafebabe"),
            Some("sha256:old")
        ));
        // Approved since a STOCK prepare: still not what is staged.
        assert!(!staged_still_fits(
            &prepared("stable", "sha256:new", None),
            "stable",
            Some("cafebabe"),
            Some("sha256:old")
        ));
        // And the reverse — a recipe withdrawn after the prepare.
        assert!(!staged_still_fits(
            &prepared("stable", "sha256:new", Some("deadbeef")),
            "stable",
            None,
            Some("sha256:old")
        ));
    }

    #[test]
    fn a_sandbox_that_already_reached_the_staged_base_has_nothing_to_apply() {
        // Prepared, then updated by some other route (a second machine's flow, a hand-typed command). The
        // container is already on it, so the ordinary path runs and reports "already current" honestly
        // instead of the fast path performing a restart that changes nothing.
        assert!(!staged_still_fits(
            &prepared("stable", "sha256:same", None),
            "stable",
            None,
            Some("sha256:same")
        ));
    }

    #[test]
    fn a_record_with_nothing_staged_never_takes_the_fast_path() {
        assert!(!staged_still_fits(
            &saved(Some("img:1"), None),
            "stable",
            None,
            Some("sha256:old")
        ));
        // A base identity that could not be resolved at prepare time is not a match against the container's:
        // it is an unknown, and an unknown must not be read as "already applied".
        let unknown_base = record::ChannelRecord {
            staged_base: None,
            ..prepared("stable", "sha256:new", None)
        };
        assert!(staged_still_fits(&unknown_base, "stable", None, None));
    }

    #[test]
    fn only_a_sandbox_on_the_official_registry_is_tracked_unattended() {
        // The stock shape: base and image are the same registry ref.
        assert!(follows_registry(
            Some("ghcr.io/intentic/sandbox:stable"),
            Some("ghcr.io/intentic/sandbox:stable")
        ));
        // An overlay build: the image is local, the base it extends is the registry's.
        assert!(follows_registry(
            Some("ghcr.io/intentic/sandbox:stable"),
            Some("intentic-sandbox-env-abc:0123456789ab")
        ));
        // Any channel counts — following beta is still following the registry.
        assert!(follows_registry(
            Some("ghcr.io/intentic/sandbox:beta"),
            None
        ));
    }

    #[test]
    fn a_pinned_dev_or_rolled_back_sandbox_is_left_alone_unattended() {
        // The dev loop: staging :stable here would light an "update ready" card whose click moves a
        // deliberately-local sandbox onto the release it is dogfooding ahead of.
        assert!(!follows_registry(
            Some("intentic-sandbox:dev"),
            Some("intentic-sandbox:dev")
        ));
        // A rollback pin: the owner just fled the current release; the next one is theirs to take by hand.
        assert!(!follows_registry(
            Some("intentic-sandbox-rollback-abc:0123456789ab"),
            None
        ));
        // A custom registry, and a bare tag with no registry at all.
        assert!(!follows_registry(
            Some("registry.example.com/sandbox:v1"),
            None
        ));
        assert!(!follows_registry(None, Some("my-own-build:latest")));
        // Neither stamp: a container older than the run contract — unclassifiable, so untouched.
        assert!(!follows_registry(None, None));
        // The registry name alone, with no tag, names nothing pullable.
        assert!(!follows_registry(Some("ghcr.io/intentic/sandbox:"), None));
    }

    #[test]
    fn only_the_dogfood_base_refuses_a_registry_update() {
        // The dev loop, with and without an overlay of its own: a pull would hand it a published build, and the
        // working tree it came from would be the only way back.
        assert!(built_from_checkout(Some(DEV_TAG), Some(DEV_TAG)));
        assert!(built_from_checkout(
            Some(DEV_TAG),
            Some("intentic-sandbox-dev-env-abc:0123456789ab")
        ));
        // No base stamped at all, the shape of a bare dev run: the image itself answers.
        assert!(built_from_checkout(None, Some(DEV_TAG)));
        // NARROWER THAN follows_registry ON PURPOSE. Both of these are unpublished too, and updating off either is
        // ordinary: a rollback pin is how a rolled-back sandbox rejoins its channel, and a pinned build is a choice
        // of image rather than a checkout.
        assert!(!built_from_checkout(
            Some("intentic-sandbox-rollback-abc:0123456789ab"),
            None
        ));
        assert!(!built_from_checkout(None, Some("my-own-build:latest")));
        assert!(!built_from_checkout(
            Some("ghcr.io/intentic/sandbox:stable"),
            Some("intentic-sandbox-env-abc:0123456789ab")
        ));
        // A container older than the run contract stamps neither, and is left updatable.
        assert!(!built_from_checkout(None, None));
    }

    #[test]
    fn a_sandbox_with_nothing_approved_stages_an_empty_overlay_and_carries_on() {
        // The stock shape: no capability enabled, no custom section, no file to copy. Every flow reads the
        // empty overlay as "nothing to re-apply", which is exactly right here.
        assert!(matches!(overlay_outcome(false, false), Overlay::Stock));
    }

    #[test]
    fn a_sandbox_that_has_a_recipe_the_copy_cannot_read_stops_the_flow_instead_of_stripping_it() {
        /* The dev loop's silent downgrade. */
        assert!(matches!(overlay_outcome(false, true), Overlay::Lost));
    }

    #[test]
    fn a_copy_that_lands_is_built_without_a_second_opinion() {
        // The evidence is only ever gathered for a copy that failed, so both answers must build the same
        // thing: an approved-but-never-built overlay carries no stamp yet, and that FIRST rebuild after an
        // approval is the one that must work.
        assert!(matches!(overlay_outcome(true, false), Overlay::Copied));
        assert!(matches!(overlay_outcome(true, true), Overlay::Copied));
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
                &saved(
                    Some("img:2"),
                    Some("intentic-sandbox-rollback-abc:0123456789ab")
                ),
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
        assert_eq!(
            rollback_tag("a", "sha256:abc"),
            "intentic-sandbox-rollback-a:abc"
        );
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
        assert!(base_is_allowed(
            "ghcr.io/intentic/sandbox:stable",
            None,
            None
        ));
        assert!(base_is_allowed(
            "ghcr.io/intentic/sandbox:1.2.3",
            None,
            None
        ));
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

    /// Both modes that move an overlay onto another image, since the hash each stamps is the one the daemon will
    /// recompute from the base it left the container on — not the bytes it was handed.
    #[test]
    fn a_rebase_pins_the_hash_of_the_overlay_as_the_new_base_leaves_it() {
        let approved = "# Composed\n\nFROM ghcr.io/intentic/sandbox:stable\n\nRUN npm install -g posthog-cli\n";
        for base in [DEV_TAG, "intentic-sandbox-prev-demo:0e2a1f"] {
            let (hash, rebased) = rebase_overlay(approved, base);
            assert_eq!(overlay_base(&rebased).as_deref(), Some(base));
            assert_eq!(hash, sha256_hex(rebased.as_bytes()));
            assert_ne!(hash, sha256_hex(approved.as_bytes()));
        }

        // Every sandbox the app offers the checkout rebuild on already sits on the dev base (the daemon gates that
        // button on it), so there the rebase is the identity and the two hashes cannot disagree.
        let (hash, rebased) = rebase_overlay(approved, DEV_TAG);
        let again = rebase_overlay(&rebased, DEV_TAG);
        assert_eq!(again.0, hash);
        assert_eq!(again.1, rebased);
    }
}
