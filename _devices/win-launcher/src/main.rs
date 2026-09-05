#![windows_subsystem = "windows"]

/* THE ONE WAY TO START A CONSOLE PROGRAM ON WINDOWS WITHOUT PUTTING A WINDOW ON SOMEBODY'S DESKTOP.
 *
 * Windows starts a `HKCU\…\Run` entry in the interactive session, and it allocates a console for any program
 * whose PE subsystem says CONSOLE. Both machine-side agents ship as bun-compiled console binaries, so a Run
 * entry naming one directly parked a terminal window on the desktop from logon until that process exited —
 * 1-2 seconds of black window at every boot, on a machine whose owner had asked to see nothing at all.
 *
 * FIVE MECHANISMS, MEASURED on a Windows 11 desktop with Windows Terminal as the default console host, by
 * enumerating top-level windows every 25 ms across each launch:
 *
 *     console program, started the way Explorer starts a Run entry     ~1.2 s visible
 *     powershell.exe -WindowStyle Hidden -Command <program>            ~2.6 s visible
 *     Task Scheduler logon task, InteractiveToken, console action      ~2.1 s visible
 *     Task Scheduler logon task → hidden PowerShell → console program  ~1.5 s visible
 *     THIS: GUI-subsystem parent → child with CREATE_NO_WINDOW         nothing, ever
 *
 * `-WindowStyle Hidden` is the one that surprises, and it is worth writing down because it is what everyone
 * reaches for first (this repo included — `_tools/scripts/ci/setup-windows-runner.ps1` rested on it): it hides
 * the console the PowerShell host owns, but under Windows Terminal the window belongs to WindowsTerminal.exe,
 * a different process that does not take the hint. The same fact rules out the other tempting shortcut,
 * hiding the console from inside the agent through `bun:ffi` ShowWindow: the window that would have to be
 * hidden is not ours to hide, and it is mapped before our first line runs either way.
 *
 * What remains is the PE subsystem, which is decided at link time and cannot be flashed: the loader creates NO
 * console for a GUI-subsystem process, so there is nothing to show. `bun build --compile` can produce one
 * (`--windows-hide-console`, verified), but that binary is 85 MB and a GUI-subsystem CLI writes to no
 * terminal — `intentic-machine status` would print into the void. Hence a separate program, this one, whose whole
 * job is to be that subsystem for four milliseconds.
 *
 * WHAT THE CHILD INHERITS, which is the second reason this exists. CREATE_NO_WINDOW gives the agent a console
 * of its own with no window on it. That is strictly better than the DETACHED_PROCESS it gets when a terminal
 * starts it: a console child of a console-LESS process is handed a brand-new console, window and all, so every
 * `spawn` inside the loop (git, ssh, docker, mutagen, reg.exe) had to remember `windowsHide` or flash a black
 * window on an idle desktop. A child of a process started HERE inherits a console that has no window to show.
 *
 * By default nothing is waited for: the child is not a job-object member — Rust does not put it in one — so it
 * outlives this process by construction, and its pid is written to stdout for the one caller that has a pipe on
 * it (an agent starting its own loop, which needs the pid to watch). Started from the Run key there is no stdout
 * at all and that write is dropped. `--wait` is for the other kind of caller, a Task Scheduler action, which is
 * only "running" while its own process is; see the parser. */

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

#[cfg(windows)]
use std::io::Write;

/// One launch: where the child's output goes, what to run, and whether this process outlives it.
#[derive(Debug, PartialEq, Eq)]
struct Launch {
    log: PathBuf,
    wait: bool,
    program: OsString,
    args: Vec<OsString>,
}

const USAGE: &str = "usage: intentic-launch --log <file> [--wait] -- <program> [args...]";

/* The command line, minus argv[0]. Deliberately rigid — `--log <file> [--wait] -- <program> [args...]`, in that
 * order, no `--log=` spelling, no flags after the separator — because there is exactly one kind of author for
 * these command lines: code in @intentic/local-agent writing a registry value, or a provisioning script writing
 * a scheduled task. A lenient parser would only widen what a typo can mean at logon, where nobody is watching
 * and the failure is silence.
 *
 * `--log` is REQUIRED for the same reason. A program started from the Run key has no terminal, no parent
 * waiting on it and no exit code anyone will see; the log file is the only surface on which "it did not start"
 * can be a sentence rather than an absence.
 *
 * `--wait` IS FOR A SUPERVISOR, and it is the difference between two callers that want opposite things. An
 * agent starting its own resident loop wants this process gone immediately — it has a pidfile and a settle
 * check of its own, and a launcher hanging around would just be a second process to reason about. A Task
 * Scheduler action wants the opposite: the task counts as RUNNING for exactly as long as its action process
 * lives, and that is what makes `-MultipleInstances IgnoreNew` suppress the watchdog repetitions and
 * `Stop-ScheduledTask` reach the thing it started. Fire-and-forget there would start a second listener every
 * few minutes. */
fn parse(argv: Vec<OsString>) -> Result<Launch, String> {
    let mut rest = argv.into_iter().peekable();
    match rest.next() {
        Some(flag) if flag == "--log" => {}
        _ => return Err(format!("expected --log first. {USAGE}")),
    }
    let log = rest
        .next()
        .ok_or_else(|| format!("--log needs a path. {USAGE}"))?;
    if log.is_empty() {
        return Err(format!("--log needs a path. {USAGE}"));
    }
    let wait = rest.peek().is_some_and(|next| next == "--wait");
    if wait {
        rest.next();
    }
    match rest.next() {
        Some(separator) if separator == "--" => {}
        _ => {
            return Err(format!(
                "expected -- between the launcher's own flags and the program. {USAGE}"
            ))
        }
    }
    let program = rest
        .next()
        .ok_or_else(|| format!("nothing to run after --. {USAGE}"))?;
    Ok(Launch {
        log: PathBuf::from(log),
        wait,
        program,
        args: rest.collect(),
    })
}

/* Start it, hand back the pid and (with `--wait`) the child itself. CREATE_NO_WINDOW rather than
 * DETACHED_PROCESS: the two are mutually exclusive (CREATE_NO_WINDOW "is ignored if it is used with either
 * CREATE_NEW_CONSOLE or DETACHED_PROCESS"), and a hidden console beats no console — see the header. Both stdio
 * ends are the same append-opened file, so a restart adds to the record rather than truncating the pass that
 * explains why it restarted. */
#[cfg(windows)]
fn start(launch: &Launch) -> Result<std::process::Child, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    if let Some(dir) = launch.log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let out = open_log(&launch.log)?;
    let err = out.try_clone().map_err(|why| {
        format!(
            "could not open {} for the child's stderr: {why}",
            launch.log.display()
        )
    })?;
    Command::new(&launch.program)
        .args(&launch.args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|why| {
            format!(
                "could not start {}: {why}",
                launch.program.to_string_lossy()
            )
        })
}

#[cfg(windows)]
fn open_log(path: &std::path::Path) -> Result<std::fs::File, String> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|why| format!("could not open {}: {why}", path.display()))
}

// The failure of a launch nobody watched, written where the agent's own notes and docs already point. Silent
// if even that fails: there is no second place to say it, and a launcher that dies loudly on a locked log file
// would be a worse bargain than one that dies quietly having tried.
#[cfg(windows)]
fn note(log: &std::path::Path, why: &str) {
    if let Ok(mut file) = open_log(log) {
        let _ = writeln!(file, "intentic-launch: {why}");
    }
}

#[cfg(windows)]
fn main() -> ExitCode {
    let launch = match parse(std::env::args_os().skip(1).collect()) {
        Ok(launch) => launch,
        // No log path was parsed, so stderr is the only place left — and it exists precisely when a person
        // typed the malformed command line, which is the only way one gets malformed.
        Err(why) => {
            eprintln!("{why}");
            return ExitCode::FAILURE;
        }
    };
    let mut child = match start(&launch) {
        Ok(child) => child,
        Err(why) => {
            note(&launch.log, &why);
            return ExitCode::FAILURE;
        }
    };
    // The pid, for the one caller that has a pipe on this: an agent that has to watch what it just started.
    // Written before any waiting, so `--wait` does not hold it back, and dropped when there is no stdout.
    let _ = writeln!(std::io::stdout(), "{}", child.id());
    if !launch.wait {
        return ExitCode::SUCCESS;
    }
    /* THE CHILD'S OWN VERDICT, PASSED THROUGH, because with `--wait` this process is standing in for it: Task
     * Scheduler reads the action's exit code, and reporting SUCCESS for a listener that crashed is how a
     * restart-on-failure setting comes to have nothing to fire on. Codes above 255 cannot survive an ExitCode,
     * so anything that does not fit is reported as a plain failure rather than truncated into a lie — 256
     * would otherwise become 0. */
    match child.wait() {
        Ok(status) => match status.code() {
            Some(0) => ExitCode::SUCCESS,
            Some(code) => u8::try_from(code).map_or(ExitCode::FAILURE, ExitCode::from),
            None => ExitCode::FAILURE,
        },
        Err(why) => {
            note(
                &launch.log,
                &format!("lost track of {}: {why}", launch.program.to_string_lossy()),
            );
            ExitCode::FAILURE
        }
    }
}

/* Everywhere else this is a program with nothing to do, and it says so rather than not existing: the parser
 * above is the part that can be wrong in an interesting way, and keeping the crate buildable on Linux is what
 * lets `cargo test` cover it in CI beside the two crates that already run there. */
#[cfg(not(windows))]
fn main() -> ExitCode {
    match parse(std::env::args_os().skip(1).collect()) {
        Ok(launch) => eprintln!(
            "intentic-launch starts a program without a console window, which is a Windows problem and has no meaning here. Run {} yourself; its log would have been {}.",
            launch.program.to_string_lossy(),
            launch.log.display()
        ),
        Err(why) => eprintln!("{why}"),
    }
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::{parse, Launch};
    use std::ffi::OsString;
    use std::path::PathBuf;

    fn argv(parts: &[&str]) -> Vec<OsString> {
        parts.iter().map(OsString::from).collect()
    }

    #[test]
    fn takes_the_log_then_the_command() {
        let launch = parse(argv(&[
            "--log",
            "C:\\log\\host.log",
            "--",
            "C:\\bin\\intentic-host.exe",
            "run",
            "--foreground",
        ]))
        .unwrap();
        assert_eq!(
            launch,
            Launch {
                log: PathBuf::from("C:\\log\\host.log"),
                wait: false,
                program: OsString::from("C:\\bin\\intentic-host.exe"),
                args: argv(&["run", "--foreground"]),
            }
        );
    }

    /* Fire-and-forget is the DEFAULT, and that is the whole difference between the two callers: an agent's Run
     * entry wants this process gone at once, a scheduled task wants it to stand in for what it started. */
    #[test]
    fn waits_only_when_asked() {
        assert!(
            !parse(argv(&["--log", "/tmp/x.log", "--", "agent"]))
                .unwrap()
                .wait
        );
        let waiting = parse(argv(&[
            "--log",
            "/tmp/x.log",
            "--wait",
            "--",
            "cmd.exe",
            "/c",
            "run.cmd",
        ]))
        .unwrap();
        assert!(waiting.wait);
        assert_eq!(waiting.program, OsString::from("cmd.exe"));
        assert_eq!(waiting.args, argv(&["/c", "run.cmd"]));
    }

    // `--wait` is ours and belongs before the separator; after it, it is the child's business.
    #[test]
    fn never_reads_the_childs_wait_flag_as_its_own() {
        let launch = parse(argv(&["--log", "/tmp/x.log", "--", "agent", "--wait"])).unwrap();
        assert!(!launch.wait);
        assert_eq!(launch.args, argv(&["--wait"]));
    }

    #[test]
    fn runs_a_program_that_takes_no_arguments() {
        let launch = parse(argv(&["--log", "/tmp/x.log", "--", "mutagen"])).unwrap();
        assert!(launch.args.is_empty());
    }

    /* Everything after the separator belongs to the child, including the tokens this program has flags for.
     * A parser that kept looking would eat a `--log` the agent meant for mutagen. */
    #[test]
    fn hands_the_child_its_own_flags_verbatim() {
        let launch = parse(argv(&[
            "--log",
            "/tmp/x.log",
            "--",
            "agent",
            "--log",
            "elsewhere",
            "--",
        ]))
        .unwrap();
        assert_eq!(launch.args, argv(&["--log", "elsewhere", "--"]));
    }

    #[test]
    fn refuses_a_command_line_that_could_mean_two_things() {
        // No log: the failure of a logon launch would have nowhere to be written.
        assert!(parse(argv(&["C:\\bin\\intentic-host.exe", "run"])).is_err());
        assert!(parse(argv(&["--log"])).is_err());
        assert!(parse(argv(&["--log", ""])).is_err());
        // No separator: `--log x agent` reads as an agent named by a flag's value.
        assert!(parse(argv(&["--log", "/tmp/x.log", "agent"])).is_err());
        // Nothing to run.
        assert!(parse(argv(&["--log", "/tmp/x.log", "--"])).is_err());
        assert!(parse(Vec::new()).is_err());
    }
}
