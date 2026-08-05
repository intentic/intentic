use crate::docker;
use crate::logfile::Log;
use crate::util::{bail, Result};

/* THE RUN CONTRACT STAYS WITH THE IMAGE — this module is a caller, never an author.
 *
 * How a sandbox container is run (volumes, network + alias, capability posture, env allowlist) is defined
 * once, in TypeScript (@intentic/sandbox-run), and the image speaks it: `intentic sandbox run-command`
 * prints the docker argv, `intentic sandbox host-probes` prints what to ask the host first. This binary
 * executes those answers verbatim. Re-stating the shape here would recreate the exact drift the contract
 * was built to end (the SYS_ADMIN incident: six hand-copied run blocks, updated across three commits, while
 * sandboxes created the ordinary way silently lost turn isolation) — and it would break the property that a
 * stale ic still runs a NEW image correctly, because the contract ships with the image, not with ic. */

pub struct RunRequest<'a> {
    pub image: &'a str,
    pub slug: &'a str,
    pub base_image: &'a str,
    pub channel: Option<&'a str>,
    pub previous_image: Option<&'a str>,
    pub environment_hash: Option<&'a str>,
    /// The overlay's `# intentic:runtime` directive lines, verbatim — validated inside the image.
    pub runtime: Option<&'a str>,
    /// Extra -v specs, newline-separated (the /agent-auth replay, dev compiled-tree binds).
    pub mounts: Option<&'a str>,
    /// Resolvers, space-separated (fresh public resolvers dodge negatively-cached tunnel NXDOMAINs).
    pub dns: Option<&'a str>,
}

/// Ask `image` for its own run command and return the argv to execute. `env_nul` rides stdin NUL-framed.
/// `--format json` rather than the sh line: this caller spawns the argv directly, so nothing here has to
/// re-implement (or trust its own reading of) shell quoting.
pub fn run_command(
    request: &RunRequest,
    env_nul: &[u8],
    no_local_publish: bool,
    unsupported: &[String],
    log: &Log,
) -> Result<Vec<String>> {
    let mut args: Vec<String> = [
        "run",
        "-i",
        "--rm",
        "--entrypoint",
        "intentic",
        request.image,
        "sandbox",
        "run-command",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let mut flag = |name: &str, value: &str| {
        args.push(name.to_string());
        args.push(value.to_string());
    };
    flag("--slug", request.slug);
    flag("--image", request.image);
    flag("--base-image", request.base_image);
    if let Some(channel) = request.channel {
        flag("--channel", channel);
    }
    if let Some(previous) = request.previous_image {
        flag("--previous-image", previous);
    }
    if let Some(hash) = request.environment_hash {
        flag("--environment-hash", hash);
    }
    if let Some(runtime) = request.runtime {
        flag("--runtime", runtime);
    }
    if let Some(mounts) = request.mounts {
        flag("--mounts", mounts);
    }
    if let Some(dns) = request.dns {
        flag("--dns", dns);
    }
    args.push("--format".to_string());
    args.push("json".to_string());
    if no_local_publish {
        args.push("--no-local-publish".to_string());
    }
    // `--unsupported=…` attached, omitted when empty: its values ARE docker flags, and a CLI reading
    // `--unsupported --gpus=all` sees an unknown flag rather than a value.
    if !unsupported.is_empty() {
        args.push(format!("--unsupported={}", unsupported.join(" ")));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = docker::capture_with_stdin(&arg_refs, env_nul, log).map_err(|_| {
        crate::util::Fail(format!(
            "{} could not produce its run command (an unsupported runtime directive, or an image too old to carry the run contract — run the update flow first). Log: {}",
            request.image,
            log.path.display()
        ))
    })?;
    let argv: Vec<String> = serde_json::from_str(output.trim()).map_err(|err| {
        crate::util::Fail(format!(
            "{} answered an unreadable run command ({err}). Log: {}",
            request.image,
            log.path.display()
        ))
    })?;
    if argv.is_empty() {
        bail!(
            "{} answered an empty run command. Log: {}",
            request.image,
            log.path.display()
        );
    }
    Ok(argv)
}

pub struct Probe {
    pub token: String,
    pub kind: String,
    pub target: String,
}

/// Which of the overlay's asks this host has to be quizzed about — one TSV line per optional directive
/// (`--gpus=all<TAB>runtime<TAB>nvidia`). An image too old to know the verb answers nothing, which reads as
/// "nothing optional to probe" — the flow then behaves exactly as it did before probes existed.
pub fn host_probes(image: &str, runtime_lines: &str, log: &Log) -> Vec<Probe> {
    let args = [
        "run",
        "-i",
        "--rm",
        "--entrypoint",
        "intentic",
        image,
        "sandbox",
        "host-probes",
        "--runtime",
        runtime_lines,
    ];
    let Ok(output) = docker::capture_with_stdin(&args, &[], log) else {
        return Vec::new();
    };
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            Some(Probe {
                token: parts.next()?.to_string(),
                kind: parts.next()?.to_string(),
                target: parts.next()?.to_string(),
            })
        })
        .filter(|probe| !probe.token.is_empty())
        .collect()
}

/// Run the probes against THIS host; returns the tokens the host cannot provide. Only the two kinds the
/// contract promises are interpreted — an image newer than this binary may know a third, and that reads as
/// unsupported with a message: the sandbox starts without the extra and says so, which beats guessing yes
/// and failing the launch.
pub fn unsupported_on_this_host(probes: &[Probe]) -> Vec<String> {
    let mut unsupported = Vec::new();
    for probe in probes {
        let satisfied = match probe.kind.as_str() {
            "runtime" => docker::try_capture(&["info", "--format", "{{json .Runtimes}}"])
                .is_some_and(|runtimes| runtimes.contains(&format!("\"{}\"", probe.target))),
            "device" => std::path::Path::new(&probe.target).exists(),
            other => {
                eprintln!(
                    "intentic: unknown host probe '{other}' — treating {} as unavailable.",
                    probe.token
                );
                false
            }
        };
        if !satisfied {
            eprintln!(
                "intentic: this host cannot provide {} — the sandbox starts without it.",
                probe.token
            );
            unsupported.push(probe.token.clone());
        }
    }
    unsupported
}
