/* `ic runner` — RUNNERS on this machine: sandbox-image containers that belong to a parent sandbox instead
 * of a person, executing turns it dispatches (design: docs/remote-runners-plan.md at the workspace root;
 * the daemon halves are `sandbox/src/runners/` and the sandbox contract's runner contract).
 *
 * `up` is `sandbox connect` minus the platform: the same run contract, spoken by the image itself
 * (contract.rs — nothing here states a docker-run shape), with the runner seed in the env instead of a
 * setup code, no tunnel grant, no Google client, no local publish. The container boots as a loopback
 * daemon, redeems its pairing against the parent over HTTPS, and dials the parent's WebSocket; from there
 * the parent's Devices/agents surfaces are where it is watched, not this terminal.
 *
 * A runner may also arrive wearing its PARENT'S SHAPE, two optional files the parent's daemon shipped here
 * through the host agent: the parent's approved environment overlay with the sha256 that pins it (built
 * BEFORE boot through the same byte-exact check `ic sandbox rebuild` runs — the parent's owner approved
 * those bytes, and a runner has no owner of its own to re-approve them), and a settings-only sandbox
 * definition the daemon seeds itself from on first boot (SANDBOX_DEFINITION_SEED, the run contract's fleet
 * door). Both optional: a bare runner still runs turns, it just isn't the parent's twin. */

use crate::contract::{self, RunRequest};
use crate::docker;
use crate::health;
use crate::logfile::Log;
use crate::sandbox::{self, connect::env_or, recreate, CONTAINER_PREFIX};
use crate::ui;
use crate::util::{bail, base64, nul_frame, sha256_hex, Result};

/// Every runner slug wears this prefix inside the ordinary sandbox namespace, so every existing flow
/// (list, update, remove, cleanup.sh) already recognises a runner as a sandbox container — which it is.
const SLUG_PREFIX: &str = "runner-";

/// A generated name when the caller supplies none: short, unique enough for one machine, and obviously
/// machine-minted so nobody mistakes it for something they chose.
fn generated_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}").chars().rev().take(6).collect()
}

fn slug_of(name: &str) -> Result<String> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        bail!("runner names are lowercase letters, digits and dashes — '{name}' is not.");
    }
    Ok(format!("{SLUG_PREFIX}{name}"))
}

/// Everything `runner up` takes. A struct (connect::Args' shape) because the optional shape files pushed the
/// positional form past what reads at a call site.
pub struct Up {
    pub parent_url: String,
    pub pair_token: String,
    pub name: Option<String>,
    /// A settings-only sandbox.toml the daemon seeds itself from on first boot (SANDBOX_DEFINITION_SEED).
    pub definition_file: Option<String>,
    /// The parent's approved overlay, built here before boot — only beside the hash that pins it.
    pub overlay_file: Option<String>,
    pub environment_hash: Option<String>,
}

/// A parent-shipped overlay, checked and named: the byte-exact hash check `ic sandbox rebuild` runs (only
/// content that still hashes to what the parent's owner approved is ever built), the same base rule, and the
/// same target-tag derivation. Pure, so every refusal is assertable without docker.
pub(crate) struct VerifiedOverlay {
    pub base: String,
    pub target: String,
    pub runtime_lines: String,
}

pub(crate) fn verified_overlay(
    content: &str,
    hash: &str,
    image: &str,
    slug: &str,
) -> Result<VerifiedOverlay> {
    let have = sha256_hex(content.as_bytes());
    if have != hash {
        bail!("the shipped overlay does not hash to what the parent's owner approved (expected {hash}, found {have}).\n       Re-create the runner from the parent sandbox, which ships the pair together.");
    }
    let Some(base) = recreate::overlay_base(content) else {
        bail!("the shipped overlay has no FROM instruction.");
    };
    // The recreate flow's belt-and-braces, held here too: official images, the dev tag, or the exact image
    // this invocation was explicitly pointed at (SANDBOX_IMAGE) — never a base of the overlay's own choosing.
    if !recreate::base_is_allowed(&base, Some(image), None) {
        bail!(
            "the shipped overlay must start with FROM {}:<tag> (or FROM this runner's own image, {image}); found {base}.",
            recreate::DEFAULT_REGISTRY
        );
    }
    let runtime_lines: String = content
        .lines()
        .filter(|line| line.starts_with("# intentic:runtime "))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(VerifiedOverlay {
        base,
        // sha256_hex is 64 chars and `have == hash` above, so the slice cannot be short.
        target: format!("intentic-sandbox-env-{slug}:{}", &hash[..12]),
        runtime_lines,
    })
}

pub fn up(args: Up) -> Result<()> {
    let Up {
        parent_url,
        pair_token,
        name,
        definition_file,
        overlay_file,
        environment_hash,
    } = args;
    docker::require_daemon()?;
    if !parent_url.starts_with("http://") && !parent_url.starts_with("https://") {
        bail!("the parent URL must be the sandbox's web address (https://…) — got '{parent_url}'.");
    }
    if pair_token.trim().is_empty() {
        bail!("the pairing token is empty — mint one in the parent sandbox (POST /system/runners/pair) and pass it with --pair.");
    }
    if overlay_file.is_some() != environment_hash.is_some() {
        bail!("--overlay-file and --environment-hash travel together — the hash is what pins the overlay to the bytes the parent's owner approved.");
    }
    let name = name.unwrap_or_else(generated_name);
    let slug = slug_of(&name)?;
    let container = format!("{CONTAINER_PREFIX}{slug}");
    if docker::container_exists(&container) {
        bail!("a runner named '{name}' already exists here — remove it first: ic runner remove {name}");
    }
    let image = env_or("SANDBOX_IMAGE", "ghcr.io/intentic/sandbox:stable");
    let log = Log::create("runner-up")?;

    // Read both shape files up front, so a missing path is a sentence naming it rather than a mid-flow stop.
    let overlay = overlay_file
        .map(|path| {
            std::fs::read_to_string(&path).map_err(|err| {
                crate::util::Fail(format!("could not read the overlay file {path}: {err}"))
            })
        })
        .transpose()?;
    let definition = definition_file
        .map(|path| {
            std::fs::read_to_string(&path).map_err(|err| {
                crate::util::Fail(format!("could not read the definition file {path}: {err}"))
            })
        })
        .transpose()?;

    /* The parent's overlay, built BEFORE anything boots (the recreate flow's ordering: a failed build leaves
     * this machine with nothing to clean up). The base pulled is the overlay's own FROM — with an overlay in
     * play, SANDBOX_IMAGE's default is not what runs here, the built image is. */
    let (run_image, base_image, env_hash, runtime_lines) = match (&overlay, &environment_hash) {
        (Some(content), Some(hash)) => {
            let verified = verified_overlay(content, hash, &image, &slug)?;
            sandbox::connect::ensure_image(&verified.base, &log)?;
            let workdir = tempfile::tempdir()?;
            let overlay_path = workdir.path().join("overlay.Dockerfile");
            std::fs::write(&overlay_path, content)?;
            println!(
                "intentic: building {} from the parent's approved overlay…",
                verified.target
            );
            recreate::build_overlay(&verified.target, &overlay_path, false, &log);
            if !docker::image_exists(&verified.target) {
                bail!(
                    "the overlay build failed — nothing was started. Log: {}",
                    log.path.display()
                );
            }
            (
                verified.target,
                verified.base,
                Some(hash.clone()),
                verified.runtime_lines,
            )
        }
        _ => {
            sandbox::connect::ensure_image(&image, &log)?;
            (image.clone(), image.clone(), None, String::new())
        }
    };

    // Which of the overlay's optional asks THIS machine cannot honour — probed exactly as a recreate probes,
    // so a runner built from a GPU overlay starts (without the GPU, said out loud) instead of failing launch.
    let probes = if runtime_lines.is_empty() {
        Vec::new()
    } else {
        // A runner is a fresh container with no owner asks of its own: only the overlay's directives to probe.
        contract::host_probes(&run_image, &runtime_lines, "", &log)
    };
    let unsupported = contract::unsupported_on_this_host(&probes);

    // The whole difference from a person's sandbox is these two values — and the absences around them: no
    // setup code, no tunnel grant, no Google client, so the daemon boots loopback and only ever dials OUT.
    let env_pairs = nul_frame(&[
        ("RUNNER_PARENT_URL", parent_url.as_str()),
        ("RUNNER_PAIR_TOKEN", pair_token.as_str()),
    ]);
    let definition_b64 = definition
        .as_deref()
        .map(|content| base64(content.as_bytes()));
    let request = RunRequest {
        image: &run_image,
        slug: &slug,
        base_image: &base_image,
        channel: None,
        previous_image: None,
        environment_hash: env_hash.as_deref(),
        runtime: (!runtime_lines.is_empty()).then_some(runtime_lines.as_str()),
        mounts: None,
        dns: None,
        definition_b64: definition_b64.as_deref(),
    };
    // no_local_publish unconditionally: the loopback shortcut exists for a browser on this machine, and
    // nobody browses to a runner — claiming a port here could only collide with the sandbox someone uses.
    let argv = contract::run_command(&request, &env_pairs, true, &unsupported, &[], &log)?;
    log.section(&format!("docker run {run_image}"));
    if !docker::run_argv(&argv, &log) {
        docker::quiet(&["rm", "-f", &container]);
        let tail = log.tail(5);
        bail!(
            "starting the runner failed — the full docker error is saved to {}.\n{tail}",
            log.path.display()
        );
    }
    ui::note("waiting for the runner daemon to come up…");
    health::wait_answering(&container, &log, "")?;
    println!("Runner '{name}' is up and enrolling with {parent_url}.");
    println!("Watch it from the parent sandbox (GET /system/runners); logs here: docker logs {container}");
    println!("Remove it (container and volumes): ic runner remove {name}");
    Ok(())
}

pub fn list() -> Result<()> {
    docker::require_daemon()?;
    let runners: Vec<String> = sandbox::list_slugs()
        .into_iter()
        .filter_map(|slug| slug.strip_prefix(SLUG_PREFIX).map(str::to_string))
        .collect();
    if runners.is_empty() {
        println!("intentic: no runners on this machine.");
        return Ok(());
    }
    for name in runners {
        println!(
            "{:<9} {name}",
            sandbox::container_status(&format!("{SLUG_PREFIX}{name}"))
        );
    }
    Ok(())
}

/// Removal IS sandbox removal — a runner is a sandbox container, and the flow that removes those already
/// handles containers, named volumes and networks, with the confirmation this one inherits. Its work lives
/// in the parent's git, so nothing user-owned dies with it.
pub fn remove(name: String, yes: bool) -> Result<()> {
    let slug = slug_of(&name)?;
    sandbox::remove::run(sandbox::remove::Args {
        slugs: vec![slug],
        all: false,
        yes,
        agent_auth: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OVERLAY: &str = "FROM ghcr.io/intentic/sandbox:stable\n\nRUN apt-get install -y ffmpeg\n";

    fn hash_of(content: &str) -> String {
        sha256_hex(content.as_bytes())
    }

    // Fail carries its sentence as a field, not a Display impl, so the refusal tests read it directly.
    fn refusal(result: Result<VerifiedOverlay>) -> String {
        match result {
            Ok(_) => panic!("expected a refusal"),
            Err(err) => err.0,
        }
    }

    /// The trust anchor: only content that still hashes to what the parent's owner approved is ever built —
    /// the exact property `ic sandbox rebuild` holds, restated for an overlay that arrived over the wire.
    #[test]
    fn a_shipped_overlay_that_does_not_hash_to_its_pin_is_refused() {
        let err = refusal(verified_overlay(
            OVERLAY,
            &"a".repeat(64),
            "img",
            "runner-x",
        ));
        assert!(err.contains("does not hash"));
    }

    #[test]
    fn a_verified_overlay_names_its_base_target_and_runtime_asks() {
        let with_runtime = format!("# intentic:runtime --gpus=all\n{OVERLAY}");
        let hash = hash_of(&with_runtime);
        let Ok(verified) = verified_overlay(&with_runtime, &hash, "img", "runner-x") else {
            panic!("a pinned official overlay must verify");
        };
        assert_eq!(verified.base, "ghcr.io/intentic/sandbox:stable");
        // Same derivation as the rebuild flow: the first 12 hash chars tag the built image, per slug.
        assert_eq!(
            verified.target,
            format!("intentic-sandbox-env-runner-x:{}", &hash[..12])
        );
        assert_eq!(verified.runtime_lines, "# intentic:runtime --gpus=all");
    }

    /// The base rule survives the wire: an overlay whose FROM is neither official, the dev tag, nor the image
    /// this invocation was explicitly pointed at must not build, or a crafted overlay picks its own base.
    #[test]
    fn a_foreign_base_is_refused_and_an_explicit_image_match_is_allowed() {
        let foreign = "FROM evil.example/whatever:latest\nRUN true\n";
        let err = refusal(verified_overlay(
            foreign,
            &hash_of(foreign),
            "img",
            "runner-x",
        ));
        assert!(err.contains("must start with FROM"));

        let pinned = "FROM my-registry/custom:1\nRUN true\n";
        assert!(
            verified_overlay(pinned, &hash_of(pinned), "my-registry/custom:1", "runner-x").is_ok()
        );
    }

    #[test]
    fn an_overlay_with_no_from_is_refused() {
        let bare = "RUN true\n";
        let err = refusal(verified_overlay(bare, &hash_of(bare), "img", "runner-x"));
        assert!(err.contains("no FROM"));
    }
}
