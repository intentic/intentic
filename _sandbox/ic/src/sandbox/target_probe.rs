use std::time::Duration;

use crate::docker;
use crate::logfile::Log;
use crate::util::Fail;

/* ASKING THE TARGET IMAGE ABOUT THIS SANDBOX BEFORE A SWAP ONTO IT. Two questions are the target's to answer rather than
the running daemon's, because only the target's own code knows: what its state conversions would do to the data
(preflight.rs, `state-plan.js`), and what overlay its daemon composes for this sandbox (composition.rs,
`compose-overlay.js`). Both run one of the image's scripts in a throwaway container over read-only mounts of the running
container's data, with no network, and both read one JSON line back. This is that container, once. */

/// Where a sandbox's stored data lives in its container, the planner's flag for each, and whether a container
/// always has it: the run contract's `DATA_MOUNTS` (_shared/sandbox-run), which this binary cannot import, so a
/// test holds this copy to the contract's golden/data-mounts.json. `/agent-auth` rides only where the container has
/// it (a dev sandbox sharing AI logins); without it the planner looked for those vaults in the workspace.
pub(crate) const DATA_MOUNTS: [(&str, &str, bool); 3] = [
    ("/work", "--workspace", true),
    ("/history", "--history", true),
    ("/agent-auth", "--auth", false),
];

/// `docker run`'s own exits: 125 when docker could not run the container, 126 and 127 when the command could not
/// be started in it. The probe never ran, which says nothing about the image's code.
pub(crate) const DOCKER_COULD_NOT_RUN: std::ops::RangeInclusive<i32> = 125..=127;

/// One data volume as the image's script sees it: the running container's source, where it is mounted, and the
/// planner's flag naming that place.
pub(crate) struct Mount {
    pub(crate) source: String,
    pub(crate) destination: &'static str,
    pub(crate) flag: &'static str,
}

/// The running container's data mounts (DATA_MOUNTS), or why there are none to show: a required one is missing.
pub(crate) fn data_mounts(container: &str) -> Result<Vec<Mount>, String> {
    let mut mounts = Vec::new();
    for (destination, flag, required) in DATA_MOUNTS {
        match docker::mount_source(container, destination) {
            Some(source) => mounts.push(Mount {
                source,
                destination,
                flag,
            }),
            None if required => {
                return Err(format!(
                    "{container} has no mount at {destination} to show the image"
                ))
            }
            None => {}
        }
    }
    Ok(mounts)
}

/// One run of one of the target image's scripts.
pub(crate) struct Probe<'a> {
    /// The probe container's name. Named at all so a probe that outlives its deadline can be removed (killing the CLI
    /// leaves the container running), and never under CONTAINER_PREFIX: every listing of the sandboxes on this machine
    /// is keyed on that prefix, and a probe must not read as a sandbox.
    pub(crate) name: String,
    pub(crate) image: &'a str,
    /// The script, by its path in the image.
    pub(crate) script: &'a str,
    pub(crate) mounts: &'a [Mount],
    /// -v specs beyond the data, as they are: the dev loop's compiled trees, which replace the image's own copy of the
    /// daemon, and a key the script reads. The caller says `:ro` where it means it.
    pub(crate) extra: &'a [String],
    /// `NAME=value` for the container's environment.
    pub(crate) env: &'a [String],
    /// The script's own arguments.
    pub(crate) args: &'a [String],
}

/// Where a dev sandbox's checkout is mounted (dev-mounts.mjs), and the checkout's script that lays its package
/// manifests over the image's baked ones (docker-entrypoint.sh runs it before every daemon start).
const DEV_CHECKOUT: &str = "/opt/sandbox/dev-checkout";
const DEV_HEAL: &str = "/opt/sandbox/dev-checkout/_sandbox/sandbox/scripts/dev-heal-manifests.mjs";

/// Whether the -v specs mount a dev checkout. Matched on the destination, since a Windows source carries a colon.
fn mounts_dev_checkout(extra: &[String]) -> bool {
    let marker = format!(":{DEV_CHECKOUT}");
    extra.iter().any(|spec| {
        spec.split_once(&marker)
            .is_some_and(|(_, rest)| rest.is_empty() || rest.starts_with(':'))
    })
}

/// The probe's `docker run`. Split out so it is asserted without a daemon, because each flag is a promise about the
/// owner's data: `:ro` on every data mount is what makes asking harmless (the daemon's code opens its stores as it
/// composes, and would write to them), `--network none` keeps the script from reaching anything but those files, and
/// `--rm` leaves nothing behind.
///
/// With a dev checkout mounted, the checkout's dists replace the image's but its manifests do not, and a dist built
/// against a newer manifest (a new export subpath) cannot load under the baked one. The daemon's own start heals that
/// first (dev-heal-manifests.mjs), so the probe does too, or it refuses a swap whose daemon would have started
/// (2026-11-18: `@intentic/sandbox-contract/project-id`). The heal writes only this throwaway container's own layer,
/// and its words go to stderr so the script's answer stays the last line of stdout.
pub(crate) fn argv(probe: &Probe) -> Vec<String> {
    let heal = mounts_dev_checkout(probe.extra);
    let mut args: Vec<String> = [
        "run",
        "--rm",
        "--name",
        &probe.name,
        "--network",
        "none",
        // The image's own entrypoint is the daemon, which would boot and convert for real.
        "--entrypoint",
        if heal { "sh" } else { "node" },
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    for mount in probe.mounts {
        args.push("-v".to_string());
        args.push(format!("{}:{}:ro", mount.source, mount.destination));
    }
    for mount in probe.extra {
        args.push("-v".to_string());
        args.push(mount.clone());
    }
    for pair in probe.env {
        args.push("-e".to_string());
        args.push(pair.clone());
    }
    args.push(probe.image.to_string());
    if heal {
        args.push("-c".to_string());
        args.push(format!("node {DEV_HEAL} >&2 || true; exec node \"$@\""));
        // $0 for the shell; the script and its arguments are "$@".
        args.push("probe".to_string());
    }
    args.push(probe.script.to_string());
    args.extend(probe.args.iter().cloned());
    args
}

/// Run the probe once, bounded by `limit`, its whole output in the log. Err is docker not running it at all.
pub(crate) fn run(probe: &Probe, limit: Duration, log: &Log) -> Result<docker::Bounded, String> {
    let args = argv(probe);
    log.line(&crate::logfile::command_for_log("docker", &args));
    // A probe that an interrupted run left behind still holds the name, and would fail this one for a reason that has
    // nothing to do with the image.
    docker::quiet(&["rm", "-f", &probe.name]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let ran = docker::capture_bounded(&arg_refs, limit).map_err(|Fail(reason)| reason)?;
    log.line(&ran.stdout);
    log.line(&ran.stderr);
    if ran.timed_out {
        docker::quiet(&["rm", "-f", &probe.name]);
    }
    Ok(ran)
}

/// node's words for an entry script that is not there: every image built before that script. The script's own path,
/// quoted, as node names the module it could not find: a module the script imports and the image lacks names that
/// module instead (`Cannot find module '…/x.js' imported from …/state-plan.js`), and that image is broken, not old.
pub(crate) fn predates(stderr: &str, script: &str) -> bool {
    stderr.contains(&format!("Cannot find module '{script}'"))
}

/// The line of a script's stderr worth quoting in one warning: the last one naming an error (node's `TypeError: …`
/// comes after the source excerpt that threw it, docker's refusal after its own chatter). The log holds the rest.
pub(crate) fn error_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|line| line.contains("Error"))
        .map(|line| clip(line, 200))
}

/// The last line: a runtime that prints a notice to stdout before the answer must not cost the answer.
pub(crate) fn last_line(stdout: &str) -> Option<&str> {
    stdout.lines().map(str::trim).rfind(|line| !line.is_empty())
}

/// At most `limit` characters of `text`, marked when cut. Characters, not bytes: a cut through a multi-byte
/// character would panic.
pub fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mount(source: &str, destination: &'static str) -> Mount {
        Mount {
            source: source.to_string(),
            destination,
            flag: "--x",
        }
    }

    #[test]
    fn data_rides_read_only_env_rides_before_the_image_and_the_scripts_args_after_it() {
        let mounts = [mount("w", "/work"), mount("h", "/history")];
        let extra = ["/key:/run/secrets/k:ro".to_string()];
        let env = ["SANDBOX_VM=1".to_string()];
        let args = ["--base".to_string(), "img:1".to_string()];
        let argv = argv(&Probe {
            name: "intentic-compose-abc".to_string(),
            image: "img:1",
            script: "/opt/sandbox/dist/environment/compose-overlay.js",
            mounts: &mounts,
            extra: &extra,
            env: &env,
            args: &args,
        });
        assert_eq!(
            argv,
            [
                "run",
                "--rm",
                "--name",
                "intentic-compose-abc",
                "--network",
                "none",
                "--entrypoint",
                "node",
                "-v",
                "w:/work:ro",
                "-v",
                "h:/history:ro",
                "-v",
                "/key:/run/secrets/k:ro",
                "-e",
                "SANDBOX_VM=1",
                "img:1",
                "/opt/sandbox/dist/environment/compose-overlay.js",
                "--base",
                "img:1",
            ]
        );
    }

    #[test]
    fn a_dev_checkout_heals_the_baked_manifests_before_the_script_runs() {
        let mounts = [mount("w", "/work")];
        let extra = [
            "C:\\src\\intentic:/opt/sandbox/dev-checkout:ro".to_string(),
            "/x/dist:/opt/sandbox/dist:ro".to_string(),
        ];
        let args = ["--workspace".to_string(), "/work".to_string()];
        let argv = argv(&Probe {
            name: "intentic-preflight-abc".to_string(),
            image: "img:1",
            script: "/opt/sandbox/dist/state-plan.js",
            mounts: &mounts,
            extra: &extra,
            env: &[],
            args: &args,
        });
        assert_eq!(
            argv,
            [
                "run",
                "--rm",
                "--name",
                "intentic-preflight-abc",
                "--network",
                "none",
                "--entrypoint",
                "sh",
                "-v",
                "w:/work:ro",
                "-v",
                "C:\\src\\intentic:/opt/sandbox/dev-checkout:ro",
                "-v",
                "/x/dist:/opt/sandbox/dist:ro",
                "img:1",
                "-c",
                "node /opt/sandbox/dev-checkout/_sandbox/sandbox/scripts/dev-heal-manifests.mjs >&2 || true; exec node \"$@\"",
                "probe",
                "/opt/sandbox/dist/state-plan.js",
                "--workspace",
                "/work",
            ]
        );
        assert!(!mounts_dev_checkout(&[
            "/a:/opt/sandbox/dev-checkout-old:ro".to_string()
        ]));
        assert!(mounts_dev_checkout(&[
            "/a:/opt/sandbox/dev-checkout".to_string()
        ]));
    }

    #[test]
    fn a_missing_entry_script_is_an_old_image_and_a_missing_import_is_a_broken_one() {
        let script = "/opt/sandbox/dist/environment/compose-overlay.js";
        assert!(predates(
            "Error: Cannot find module '/opt/sandbox/dist/environment/compose-overlay.js'\n",
            script
        ));
        assert!(!predates(
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/opt/sandbox/dist/x.js' imported from /opt/sandbox/dist/environment/compose-overlay.js\n",
            script
        ));
    }
}
