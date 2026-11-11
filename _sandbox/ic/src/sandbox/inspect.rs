use std::io::Write as _;
use std::time::Duration;

use crate::docker;
use crate::sandbox::{container_of, resolve_slug};
use crate::ui;
use crate::util::{bail, Result};

/* `ic sandbox inspect` — another sandbox's records, read through the sandbox's own `agents` and `diagnostics` commands
and the one host authority, rather than by whoever can type `docker exec`: an agent once read another sandbox's /history
as root through the machine agent's `run_command`. This verb runs a fixed list of reads instead, and the machine agent's
`inspect_sandbox` tool runs this verb. Both CLIs answer an exec with no conversation stamp as an unstamped caller,
which the daemon limits to conversations that are nobody's home and not private. */

/// How long one read may take. `agents bundle` gathers a whole conversation; past this the sandbox is stuck, and a
/// model or a person is waiting.
pub const LIMIT: Duration = Duration::from_secs(60);

/// The `agents` verbs that only read: the fleet, one conversation, a search, and one conversation's debug bundle.
pub const AGENTS_READS: [&str; 4] = ["ls", "show", "find", "bundle"];

/// The `diagnostics` verbs, every one of them a read of the sandbox's own records.
pub const DIAGNOSTICS_READS: [&str; 7] = [
    "errors",
    "slow",
    "turns",
    "resources",
    "restarts",
    "timeline",
    "failures",
];

/// Flags no read may carry, wherever they stand: `--on` reads a LINKED sandbox instead of this one, and `--out` writes
/// a file.
const REFUSED_FLAGS: [&str; 2] = ["--on", "--out"];

/// What inspect runs, said under every refusal. Pure.
pub fn allowed() -> String {
    format!(
        "Allowed: agents {}; diagnostics {}; or either one's --help.",
        either(&AGENTS_READS),
        either(&DIAGNOSTICS_READS)
    )
}

/// `a, b or c`. Pure.
fn either(words: &[&str]) -> String {
    match words.split_last() {
        Some((last, [])) => last.to_string(),
        Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
        None => String::new(),
    }
}

/// The argv `docker exec` runs in the container for `command` and its `args`, or the sentence refusing it. The first
/// argument has to be one of the command's reads (or `--help`/`-h` alone), and `--on`, `--out` and their `=` spellings
/// are refused wherever they stand, even after `--`: what a CLI that is not ours yet does with them is not ours to
/// guess. Pure.
pub fn argv(command: &str, args: &[String]) -> std::result::Result<Vec<String>, String> {
    let reads: &[&str] = match command {
        "agents" => &AGENTS_READS,
        "diagnostics" => &DIAGNOSTICS_READS,
        "" => return Err(format!("inspect needs a command to run. {}", allowed())),
        other => return Err(format!("inspect does not run {other}. {}", allowed())),
    };
    if let Some(flag) = args.iter().find_map(|arg| refused_flag(arg)) {
        return Err(match flag {
            "--on" => format!(
                "inspect reads only the named sandbox's own records, so it does not take --on (that reads a linked sandbox). {}",
                allowed()
            ),
            _ => format!(
                "inspect prints what it reads and writes no file, so it does not take --out. {}",
                allowed()
            ),
        });
    }
    match args.first().map(String::as_str) {
        None | Some("") => {
            return Err(format!(
                "inspect needs to know what {command} should read. {}",
                allowed()
            ))
        }
        Some("--help" | "-h") if args.len() == 1 => {}
        Some("--help" | "-h") => {
            return Err(format!(
                "{command} --help takes nothing after it. {}",
                allowed()
            ))
        }
        Some(verb) if reads.contains(&verb) => {}
        Some(verb) => {
            return Err(format!(
                "inspect does not run {command} {verb}: it only reads. {}",
                allowed()
            ))
        }
    }
    let mut argv = vec![command.to_string()];
    argv.extend(args.iter().cloned());
    Ok(argv)
}

/// The refused flag `arg` spells, if it spells one: `--on`, or `--on=<link>`. Pure.
fn refused_flag(arg: &str) -> Option<&'static str> {
    REFUSED_FLAGS.into_iter().find(|flag| {
        arg == *flag
            || arg
                .strip_prefix(flag)
                .is_some_and(|rest| rest.starts_with('='))
    })
}

/// Whether a `docker exec` failed because `command` is not in the container: an image from before it. Docker names the
/// command it could not find (`exec: "diagnostics": executable file not found in $PATH`) and exits 127 (126 on older
/// engines), on stdout from Docker 29 and on stderr before it, so both streams are read; the command named in docker's
/// own words is what tells this apart from a command that ran and printed something about a missing file. Pure.
pub fn command_missing(command: &str, code: Option<i32>, stdout: &str, stderr: &str) -> bool {
    let named = format!("\"{command}\": executable file not found");
    matches!(code, Some(126 | 127)) && (stderr.contains(&named) || stdout.contains(&named))
}

/// Whether `agents` answered a `bundle` with its whole usage page, which is what an `agents` from before `bundle` does
/// with a verb it does not know (exit 1, the page on stdout). A newer one's own refusals are one sentence. Pure.
pub fn bundle_missing(args: &[String], code: Option<i32>, stdout: &str) -> bool {
    args.first().is_some_and(|verb| verb == "bundle")
        && code == Some(1)
        && stdout.starts_with("agents — ")
        && !stdout.contains("agents bundle")
}

/// The stop for a container that is there but not running: asleep is said as asleep, since the keeper put it there and
/// opening it wakes it. Pure.
pub fn not_running(slug: &str, asleep: bool) -> String {
    let headline = if asleep {
        format!("{slug} is asleep, so its records cannot be read until it runs again.")
    } else {
        format!("{slug} is not running, so its records cannot be read.")
    };
    ui::explain(
        &headline,
        None,
        Some(&format!(
            "ic sandbox start {slug}, then run this command again."
        )),
    )
}

/// The stop for an image from before `command`. Pure.
pub fn too_old(slug: &str, command: &str) -> String {
    ui::explain(
        &format!("{slug} has no {command} command: its image predates it."),
        None,
        Some(&format!(
            "ic sandbox update {slug} brings it (the sandbox restarts onto the newer image)."
        )),
    )
}

/// Run one read in the sandbox and pass what it printed through: its stdout onto ic's stdout, untouched, so `--json`
/// and `agents bundle` stay parseable, and its stderr onto ic's stderr. Its exit code is ic's.
pub fn run(slug: String, command: String, args: Vec<String>) -> Result<()> {
    // Refused before docker is asked anything: a refusal is the same answer whatever state the machine is in.
    let argv = match argv(&command, &args) {
        Ok(argv) => argv,
        Err(refusal) => bail!("{refusal}"),
    };
    docker::require_daemon()?;
    let slug = resolve_slug(Some(slug), "ic sandbox inspect")?;
    let container = container_of(&slug);
    if !docker::container_exists(&container) {
        bail!("{}", crate::sandbox::missing(&slug));
    }
    if docker::inspect(&container, "{{.State.Running}}").as_deref() != Some("true") {
        let asleep = crate::record::read(&slug).is_ok_and(|record| record.asleep);
        bail!("{}", not_running(&slug, asleep));
    }
    // argv, never a shell: what the caller typed reaches the command as its own words, one argument each.
    let mut exec: Vec<&str> = vec!["exec", container.as_str()];
    exec.extend(argv.iter().map(String::as_str));
    let ran = docker::capture_bounded(&exec, LIMIT)?;
    if !ran.timed_out && command_missing(&command, ran.code, &ran.stdout, &ran.stderr) {
        bail!("{}", too_old(&slug, &command));
    }
    if command == "agents" && !ran.timed_out && bundle_missing(&args, ran.code, &ran.stdout) {
        bail!("{}", too_old(&slug, "agents bundle"));
    }
    // The command's own answer, written as it printed it rather than through the crate's print macro (which a --json run
    // reroutes): stdout stays the command's stdout, so a pipe into a JSON reader reads only it. A reader that stopped
    // early (`| head`) is done, not a failure.
    if !ran.stdout.is_empty() {
        let _ = writeln!(std::io::stdout().lock(), "{}", ran.stdout);
    }
    if !ran.stderr.is_empty() {
        let _ = writeln!(std::io::stderr().lock(), "{}", ran.stderr);
    }
    if ran.timed_out {
        bail!(
            "{command} in {slug} did not finish within {} seconds and was stopped; what it printed before then is above.",
            LIMIT.as_secs()
        );
    }
    match ran.code {
        Some(0) => Ok(()),
        Some(code) => std::process::exit(code),
        None => bail!("{command} in {slug} was ended by a signal."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn every_read_runs_as_its_own_argv() {
        for verb in AGENTS_READS {
            assert_eq!(
                argv("agents", &strings(&[verb, "glad-falcon-puep"])),
                Ok(strings(&["agents", verb, "glad-falcon-puep"]))
            );
        }
        for verb in DIAGNOSTICS_READS {
            assert_eq!(
                argv("diagnostics", &strings(&[verb, "--since", "60", "--json"])),
                Ok(strings(&["diagnostics", verb, "--since", "60", "--json"]))
            );
        }
        // Words stay whole: a search with spaces and quotes is one argument, never a shell's to split.
        assert_eq!(
            argv(
                "agents",
                &strings(&[
                    "show",
                    "glad-falcon-puep",
                    "--transcript",
                    "--last",
                    "40",
                    "--grep",
                    "it's; rm -rf /"
                ])
            ),
            Ok(strings(&[
                "agents",
                "show",
                "glad-falcon-puep",
                "--transcript",
                "--last",
                "40",
                "--grep",
                "it's; rm -rf /"
            ]))
        );
    }

    #[test]
    fn help_is_a_read_on_its_own() {
        assert_eq!(
            argv("agents", &strings(&["--help"])),
            Ok(strings(&["agents", "--help"]))
        );
        assert_eq!(
            argv("diagnostics", &strings(&["-h"])),
            Ok(strings(&["diagnostics", "-h"]))
        );
        assert_eq!(
            argv("agents", &strings(&["show", "--help"])),
            Ok(strings(&["agents", "show", "--help"]))
        );
        assert!(argv("agents", &strings(&["--help", "message"])).is_err());
    }

    #[test]
    fn a_verb_that_writes_or_reaches_elsewhere_is_refused_naming_what_is_allowed() {
        for verb in [
            "message",
            "resume",
            "delegate",
            "spawn",
            "wait",
            "send",
            "answer",
            "cancel",
            "merge",
            "settle",
            "links",
            "providers",
            "list",
            "help",
        ] {
            let refused = argv("agents", &strings(&[verb, "x"])).unwrap_err();
            assert!(
                refused.contains(&format!("does not run agents {verb}")),
                "{refused}"
            );
            assert!(refused.contains(&allowed()), "{refused}");
        }
        // A read of one command is not a read of the other.
        assert!(argv("diagnostics", &strings(&["show", "x"])).is_err());
        assert!(argv("agents", &strings(&["timeline", "x"])).is_err());
        assert_eq!(
            allowed(),
            "Allowed: agents ls, show, find or bundle; diagnostics errors, slow, turns, resources, restarts, timeline or failures; or either one's --help."
        );
    }

    #[test]
    fn only_the_two_commands_run_and_each_needs_a_read() {
        for command in ["", "sh", "bash", "cat", "node", "Agents", "agents;id"] {
            assert!(argv(command, &strings(&["ls"])).is_err(), "{command}");
        }
        assert!(argv("", &[])
            .unwrap_err()
            .starts_with("inspect needs a command to run."));
        assert!(argv("agents", &[]).unwrap_err().contains(&allowed()));
        assert!(argv("diagnostics", &strings(&[""])).is_err());
        // A flag first is not a verb.
        assert!(argv("agents", &strings(&["--json", "ls"])).is_err());
    }

    #[test]
    fn on_and_out_are_refused_in_every_spelling_and_place() {
        for args in [
            &["ls", "--on", "work"][..],
            &["show", "x", "--on=work"],
            &["errors", "--on"],
            &["bundle", "x", "--out", "/tmp/x.json"],
            &["bundle", "x", "--out=/tmp/x.json"],
            &["find", "--", "--on"],
        ] {
            let command = if DIAGNOSTICS_READS.contains(&args[0]) {
                "diagnostics"
            } else {
                "agents"
            };
            let refused = argv(command, &strings(args)).unwrap_err();
            assert!(refused.contains(&allowed()), "{refused}");
        }
        assert!(argv("agents", &strings(&["ls", "--on"]))
            .unwrap_err()
            .contains("does not take --on"));
        assert!(argv("agents", &strings(&["bundle", "x", "--out", "f"]))
            .unwrap_err()
            .contains("does not take --out"));
        // Flags that merely start with the same letters are someone else's.
        assert!(argv("agents", &strings(&["ls", "--owner", "me"])).is_ok());
        assert!(argv("agents", &strings(&["find", "--online"])).is_ok());
        assert!(argv("diagnostics", &strings(&["errors", "--output"])).is_ok());
    }

    #[test]
    fn a_command_the_image_does_not_have_is_told_apart_from_one_that_failed() {
        // Docker 29 says it on stdout, older engines on stderr, and some exit 126.
        let said = "OCI runtime exec failed: exec failed: unable to start container process: exec: \"diagnostics\": executable file not found in $PATH";
        assert!(command_missing("diagnostics", Some(127), said, ""));
        assert!(command_missing(
            "diagnostics",
            Some(127),
            "",
            &format!("{said}: unknown")
        ));
        assert!(command_missing(
            "diagnostics",
            Some(126),
            "",
            "OCI runtime exec failed: exec failed: container_linux.go:380: starting container process caused: exec: \"diagnostics\": executable file not found in $PATH: unknown"
        ));
        // The command's own failures are its own, even when what it printed quotes docker's words.
        assert!(!command_missing("agents", Some(127), said, ""));
        assert!(!command_missing("diagnostics", Some(1), said, ""));
        assert!(!command_missing(
            "agents",
            Some(1),
            "",
            "agents: no conversation matches \"x\""
        ));
        assert!(!command_missing(
            "diagnostics",
            Some(127),
            "",
            "diagnostics: something else went wrong"
        ));
        assert!(!command_missing("diagnostics", Some(0), said, ""));
        // An `agents` from before `bundle` answers it with its usage page; a newer one's refusal is its own sentence.
        let bundle = strings(&["bundle", "glad-falcon-puep"]);
        let old_usage = "agents — every conversation in this workspace: look one up, or start and supervise a new one\n\nLOOK UP\n  agents show <handle>";
        assert!(bundle_missing(&bundle, Some(1), old_usage));
        assert!(!bundle_missing(
            &bundle,
            Some(1),
            "agents — every conversation…\n  agents bundle <handle>"
        ));
        assert!(!bundle_missing(
            &bundle,
            Some(1),
            "agents: no conversation matches \"x\""
        ));
        assert!(!bundle_missing(
            &strings(&["show", "x"]),
            Some(1),
            old_usage
        ));
        assert!(!bundle_missing(&bundle, Some(0), old_usage));
    }

    #[test]
    fn a_stopped_sandbox_and_an_old_image_are_said_with_their_fix() {
        assert!(not_running("work", true).starts_with("work is asleep"));
        assert!(not_running("work", false).starts_with("work is not running"));
        assert!(not_running("work", false).contains("ic sandbox start work"));
        let old = too_old("work", "diagnostics");
        assert!(old.starts_with("work has no diagnostics command: its image predates it."));
        assert!(old.contains("ic sandbox update work"));
    }
}
