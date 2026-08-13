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

/// The `docker run … sandbox run-command …` argv that ASKS the image for its run command. Split from the
/// call below so it can be asserted without a docker daemon: this is the highest-risk, least-observable
/// logic in the binary — every flag here decides something about the container that is then invisible
/// (a dropped `--environment-hash` produces a sandbox that boots, serves, and reports its overlay as not
/// applied; a dropped `--dns` silently strips a restricted network's resolvers).
fn run_command_argv(
    request: &RunRequest,
    no_local_publish: bool,
    unsupported: &[String],
) -> Vec<String> {
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
    args
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
    let args = run_command_argv(request, no_local_publish, unsupported);
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
    parse_probes(&output)
}

/// TSV → probes. Split out so the tolerance is assertable: a malformed line is DROPPED rather than
/// failing the flow, because the alternative is that one unreadable line costs the user their whole
/// recreate over an optional extra the sandbox works fine without.
fn parse_probes(output: &str) -> Vec<Probe> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn request<'a>(image: &'a str, slug: &'a str) -> RunRequest<'a> {
        RunRequest {
            image,
            slug,
            base_image: image,
            channel: None,
            previous_image: None,
            environment_hash: None,
            runtime: None,
            mounts: None,
            dns: None,
        }
    }

    /// The value that follows `flag` in an argv, so assertions read as pairs rather than indices.
    fn value_of<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
        argv.iter()
            .position(|arg| arg == flag)
            .and_then(|i| argv.get(i + 1))
            .map(String::as_str)
    }

    #[test]
    fn the_ask_runs_the_image_and_names_the_verb() {
        let argv = run_command_argv(
            &request("ghcr.io/intentic/sandbox:stable", "abc123"),
            false,
            &[],
        );
        // -i, because the env pairs ride stdin; --rm, because this container only prints and exits;
        // --entrypoint intentic, because the image's default entrypoint is the daemon.
        assert_eq!(
            argv[..8],
            [
                "run",
                "-i",
                "--rm",
                "--entrypoint",
                "intentic",
                "ghcr.io/intentic/sandbox:stable",
                "sandbox",
                "run-command"
            ]
        );
        // json, never the shell line: this caller spawns the argv directly and must not re-implement quoting.
        assert_eq!(value_of(&argv, "--format"), Some("json"));
    }

    #[test]
    fn optional_flags_ride_only_when_they_carry_something() {
        // The bare shape: nothing optional invented, and no empty-valued flags (an empty `--channel` would
        // pin the sandbox to a channel named "" on the next update).
        let bare = run_command_argv(&request("img", "abc"), false, &[]);
        for absent in [
            "--channel",
            "--previous-image",
            "--environment-hash",
            "--runtime",
            "--mounts",
            "--dns",
            "--no-local-publish",
        ] {
            assert!(
                !bare.contains(&absent.to_string()),
                "{absent} must not appear when unset"
            );
        }

        let mut full = request("img", "abc");
        full.channel = Some("core-stable");
        full.previous_image = Some("img:1");
        full.environment_hash = Some("deadbeef");
        full.runtime = Some("# intentic:runtime --gpus=all");
        full.mounts = Some("vol:/agent-auth");
        full.dns = Some("1.1.1.1 1.0.0.1");
        let argv = run_command_argv(&full, false, &[]);
        assert_eq!(value_of(&argv, "--slug"), Some("abc"));
        assert_eq!(value_of(&argv, "--base-image"), Some("img"));
        assert_eq!(value_of(&argv, "--channel"), Some("core-stable"));
        assert_eq!(value_of(&argv, "--previous-image"), Some("img:1"));
        assert_eq!(value_of(&argv, "--environment-hash"), Some("deadbeef"));
        assert_eq!(
            value_of(&argv, "--runtime"),
            Some("# intentic:runtime --gpus=all")
        );
        assert_eq!(value_of(&argv, "--mounts"), Some("vol:/agent-auth"));
        // Space-separated resolvers stay ONE argv element — the run contract splits them, not the shell.
        assert_eq!(value_of(&argv, "--dns"), Some("1.1.1.1 1.0.0.1"));
    }

    #[test]
    fn unsupported_uses_the_attached_form_and_is_omitted_when_empty() {
        assert!(!run_command_argv(&request("img", "a"), false, &[])
            .iter()
            .any(|arg| arg.starts_with("--unsupported")));
        // ATTACHED, not separated: the values ARE docker flags, and a CLI reading `--unsupported --gpus=all`
        // sees a flag it has never heard of rather than a value, and refuses the whole verb.
        let argv = run_command_argv(&request("img", "a"), false, &["--gpus=all".into()]);
        assert!(argv.contains(&"--unsupported=--gpus=all".to_string()));
        assert!(!argv.contains(&"--unsupported".to_string()));
        // Several tokens stay in one attached element, space-joined.
        let many = run_command_argv(
            &request("img", "a"),
            true,
            &["--gpus=all".into(), "--device=/dev/net/tun".into()],
        );
        assert!(many.contains(&"--unsupported=--gpus=all --device=/dev/net/tun".to_string()));
        // The retry's shape: the loopback shortcut dropped, everything else identical.
        assert!(many.contains(&"--no-local-publish".to_string()));
    }

    #[test]
    fn probe_lines_parse_and_a_malformed_one_is_dropped_not_fatal() {
        let probes = parse_probes(
            "--gpus=all\truntime\tnvidia\n--device=/dev/net/tun\tdevice\t/dev/net/tun\n",
        );
        assert_eq!(probes.len(), 2);
        assert_eq!(probes[0].token, "--gpus=all");
        assert_eq!(probes[0].kind, "runtime");
        assert_eq!(probes[0].target, "nvidia");
        assert_eq!(probes[1].kind, "device");

        // A short line, a blank line, and an image that answered nothing at all: none is fatal, because an
        // optional extra must never cost the user the recreate.
        assert_eq!(parse_probes("--gpus=all\truntime\n\n").len(), 0);
        assert_eq!(parse_probes("").len(), 0);
        // A target containing a tab cannot happen (the vocabulary has none), but splitn(3) keeps any
        // remainder ON the target rather than silently truncating it.
        assert_eq!(parse_probes("t\tk\ta\tb")[0].target, "a\tb");
    }

    #[test]
    fn an_unknown_probe_kind_reads_as_unavailable_rather_than_as_satisfied() {
        // An image newer than this binary may know a probe kind this loop does not. Guessing "yes" would
        // put a flag on the docker run that the host cannot honour and fail the whole launch.
        let probes = parse_probes("--gpus=all\tsome-future-kind\twhatever");
        assert_eq!(
            unsupported_on_this_host(&probes),
            vec!["--gpus=all".to_string()]
        );
    }

    #[test]
    fn a_device_probe_answers_from_the_filesystem() {
        // Satisfied: /dev/null exists on every host this runs on.
        assert!(
            unsupported_on_this_host(&parse_probes("--device=/dev/null\tdevice\t/dev/null"))
                .is_empty()
        );
        // Unsatisfied: a path that cannot exist reports the token as unavailable.
        assert_eq!(
            unsupported_on_this_host(&parse_probes(
                "--device=/dev/nope\tdevice\t/dev/intentic-no-such-node"
            )),
            vec!["--device=/dev/nope".to_string()]
        );
    }
}
