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
    if !docker::container_exists(&container) {
        bail!(
            "sandbox container {container} does not exist on this machine — re-run connect first."
        );
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
            // `docker run` reuses a cached tag without re-pulling. A no-op pull is reported honestly, not
            // recreated into the same image and claimed as success.
            println!("intentic: pulling {registry_image}…");
            let before = docker::image_id(&registry_image);
            let _ = docker::pull(&registry_image, &log);
            let after = docker::image_id(&registry_image);
            if before.is_some() && before == after {
                println!("intentic: no newer sandbox image is available yet — your sandbox is already on the latest :{channel} it can pull.");
                println!("          If the app still shows an update, the new release's image may still be publishing — try again in a few minutes.");
                return Ok(());
            }
            if after.is_none() {
                bail!("{registry_image} is not available (pull failed) — the sandbox is untouched. Log: {}", log.path.display());
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
            // already on this machine — usually one the registry moved the tag away from, so a pull would at
            // best no-op and at worst fetch the very build being rolled back from.
            if !docker::image_exists(&registry_image) {
                println!(
                    "intentic: {registry_image} is not on this machine any more — pulling it…"
                );
                let _ = docker::pull(&registry_image, &log);
            }
            println!("intentic: rolling back to {registry_image}…");
            copy_overlay_or_empty(&container, &overlay_path)?;
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
    // any OFFICIAL sandbox image, or the exact base this container was created from (SANDBOX_BASE_IMAGE,
    // set at docker run by whichever runner made it — not a value the agent can write).
    let current_base = container_env(&container, "SANDBOX_BASE_IMAGE");
    let mut base_image = String::new();
    if !overlay.is_empty() {
        base_image = overlay
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .find_map(|line| {
                line.strip_prefix("FROM ")
                    .map(|rest| rest.split_whitespace().next().unwrap_or("").to_string())
            })
            .unwrap_or_default();
        if base_image.is_empty() {
            bail!("the approved overlay has no FROM instruction.");
        }
        let official = base_image
            .strip_prefix(&format!("{DEFAULT_REGISTRY}:"))
            .is_some_and(|tag| !tag.is_empty());
        if !official
            && base_image != DEV_TAG
            && current_base.as_deref() != Some(base_image.as_str())
        {
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
        // One arm, because a rollback IS an update pointed at an older tag: same overlay rebuild, same base
        // pinning, same health gate. Only where the image came from differs, and that was settled above.
        Mode::Update { .. } | Mode::Rollback => {
            target_image = registry_image.clone();
            if base_image.is_empty() {
                base_image = registry_image.clone();
            }
            if !overlay.is_empty() {
                // The full hash pins SANDBOX_ENVIRONMENT_HASH (so the daemon reports the overlay as
                // Applied); the first 12 chars tag the built image — same derivation as rebuild.
                let hash = sha256_hex(overlay.as_bytes());
                target_image = format!("intentic-sandbox-env-{slug}:{}", &hash[..12]);
                env_hash = Some(hash);
                println!("intentic: rebuilding your environment overlay on the new base…");
                build_overlay(&target_image, &overlay_path, true, &log);
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

    let previous_image = current_base.clone();
    let mounts_joined = (!mounts.is_empty()).then(|| mounts.join("\n"));
    let request = RunRequest {
        image: &target_image,
        slug: &slug,
        base_image: &base_image,
        channel: Some(&channel),
        previous_image: previous_image.as_deref(),
        environment_hash: env_hash.as_deref(),
        runtime: (!runtime_lines.is_empty()).then_some(runtime_lines.as_str()),
        mounts: mounts_joined.as_deref(),
        dns: dns.as_deref(),
    };
    let argv = contract::run_command(&request, &env_nul, false, &unsupported, &log)?;

    println!("intentic: recreating the sandbox from {target_image}…");
    log.section(&format!("previous container logs ({container})"));
    docker::logs_into(&container, "5000", &log);

    // The channel record — written BEFORE the rm, because the rm is what makes the old base unknowable, and
    // before the LAUNCH: a swap that starts and then crash-loops is exactly the case rollback is for.
    let next_previous = next_previous(&mode, &saved, previous_image.as_deref(), &base_image);
    record::write(&slug, &channel, &base_image, next_previous.as_deref())?;

    docker::quiet(&["rm", "-f", &container]);
    log.section("run command");
    log.line(&argv.join(" "));

    // Two attempts: everything the run can lose WITHOUT the sandbox being broken comes off together on the
    // retry — the loopback shortcut (docker refuses the whole launch when its port is already held) and
    // EVERY optional directive, even ones whose probe passed: a probe answers a question docker answers
    // again at run time, and it can answer differently (an nvidia runtime registered against a mismatched
    // driver satisfies `docker info` and then fails the container). A sandbox that comes back saying it has
    // no GPU beats no sandbox. The failed attempt leaves a created-but-stopped container holding the name.
    if !docker::run_argv(&argv, &log) {
        docker::quiet(&["rm", "-f", &container]);
        let all_optional: Vec<String> = probes.iter().map(|probe| probe.token.clone()).collect();
        let retry_argv = contract::run_command(&request, &env_nul, true, &all_optional, &log)?;
        if !docker::run_argv(&retry_argv, &log) {
            let tail = log.tail(5);
            bail!(
                "starting the recreated sandbox failed (a runtime flag the host rejects, e.g. --privileged or /dev/net/tun?).\n{tail}\n       The previous container's logs and this error are saved to {}. Re-run your connect one-liner to restore the stock sandbox.",
                log.path.display()
            );
        }
        println!("intentic: recreated without the local shortcut (its port is taken) — this browser reaches the sandbox over its tunnel.");
    }

    println!("intentic: waiting for the sandbox daemon to come up…");
    health::wait_answering(
        &container,
        &log,
        "\n       Re-run your connect one-liner to restore the stock sandbox.",
    )?;
    health::wait_ready(&container);

    match &mode {
        Mode::Rebuild { .. } => println!("intentic: sandbox rebuilt — the Environment card will show Applied once it reconnects."),
        Mode::Update { .. } => {
            println!("intentic: sandbox updated to {target_image} (channel {channel}).");
            // Named on success, not only in the failure paths: a bad build is usually one that STARTS, and
            // the moment to learn the way back is before anyone needs it.
            if previous_image.is_some() {
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

/// What the record's `previous` becomes on this swap. `previous` is what a rollback returns to, and the
/// property that matters is that a rollback SWAPS rather than appends: one button with no "how far back"
/// control has to be its own undo, or pressing it twice walks backwards through history with no way
/// forward. An unchanged base (a rebuild, a re-run of the same update) leaves the rollback target where it
/// was — overwriting it with the image we are already on would quietly turn the button into a no-op. And a
/// first-ever swap records none rather than inventing one: the daemon then offers no rollback, honestly.
fn next_previous(
    mode: &Mode,
    saved: &record::ChannelRecord,
    previous_image: Option<&str>,
    base_image: &str,
) -> Option<String> {
    match mode {
        Mode::Rollback => saved.current.clone(),
        _ if previous_image.is_some() && previous_image != Some(base_image) => {
            previous_image.map(str::to_string)
        }
        _ => saved.previous.clone(),
    }
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
    fn an_update_records_what_it_replaced_and_a_rollback_swaps_the_pair() {
        // Update img:1 → img:2: the replaced image becomes the rollback target.
        let update = Mode::Update { channel: None };
        assert_eq!(
            next_previous(&update, &saved(None, None), Some("img:1"), "img:2").as_deref(),
            Some("img:1")
        );
        // Rolling back onto img:1: `previous` becomes the image we are LEAVING, so the next rollback goes
        // forward again — pressing the button twice returns you to where you started.
        assert_eq!(
            next_previous(
                &Mode::Rollback,
                &saved(Some("img:2"), Some("img:1")),
                Some("img:2"),
                "img:1"
            )
            .as_deref(),
            Some("img:2")
        );
    }

    #[test]
    fn a_swap_that_does_not_move_the_base_leaves_the_rollback_target_alone() {
        // A rebuild (same base, new overlay) must not overwrite `previous` with the image we are already on.
        let rebuild = Mode::Rebuild {
            hash: "0".repeat(64),
        };
        assert_eq!(
            next_previous(
                &rebuild,
                &saved(Some("img:2"), Some("img:1")),
                Some("img:2"),
                "img:2"
            )
            .as_deref(),
            Some("img:1")
        );
    }

    #[test]
    fn a_first_ever_swap_records_no_rollback_target_rather_than_inventing_one() {
        let update = Mode::Update { channel: None };
        assert_eq!(
            next_previous(&update, &saved(None, None), None, "img:1"),
            None
        );
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
