#![windows_subsystem = "windows"]

/* Windows starts the launcher from HKCU and forwards its arguments to the child. */

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

/* The command line, minus argv[0]. */
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

/* Start it, hand back the pid and (with `--wait`) the child itself. */
#[cfg(windows)]
fn start(launch: &Launch) -> Result<std::process::Child, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    if let Some(dir) = launch.log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    rotate_if_large(&launch.log);
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

/// How big the agent's log may get before the previous one is set aside; one rollover is kept, so the pair is
/// bounded at twice this. Matches LOG_ROTATE_BYTES in @intentic/local-agent, the other place that opens this file.
#[cfg(windows)]
const LOG_ROTATE_BYTES: u64 = 8 * 1024 * 1024;

/// Rolled here because this is where the file is OPENED. The agent cannot do it: it writes through the handle this
/// process hands it, so renaming the path from inside would move a name nothing is writing to. Best-effort — a log
/// that will not roll is not a reason to refuse to start the agent.
#[cfg(windows)]
fn rotate_if_large(path: &std::path::Path) {
    let too_big = std::fs::metadata(path).is_ok_and(|file| file.len() >= LOG_ROTATE_BYTES);
    if too_big {
        let mut previous = path.as_os_str().to_owned();
        previous.push(".1");
        let _ = std::fs::rename(path, previous);
    }
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

/* THE CHILD LIVES AND DIES WITH THIS PROCESS under `--wait` (2026-10-05). The logon task supervises this process, not
the agent: a launcher ended from Task Scheduler, or killed, used to leave the agent running with nobody watching it, and
the next watchdog start then found the agent's pidfile held and left again. So the child goes into a job that is killed
when its last handle closes, which is when this process ends, however it ends. `SILENT_BREAKAWAY_OK` keeps the job to
the child alone: what the agent starts to outlive itself (`ic` mid-swap, Mutagen's daemon, an upgrade) never joins it.
Best-effort, like the log: a job that cannot be made is noted, and the agent runs as before. */
#[cfg(windows)]
mod job {
    use std::ffi::c_void;

    type Handle = *mut c_void;

    /// JOBOBJECT_BASIC_LIMIT_INFORMATION, field for field.
    #[repr(C)]
    struct BasicLimits {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    /// JOBOBJECT_EXTENDED_LIMIT_INFORMATION, its IO_COUNTERS spelled out.
    #[repr(C)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const LIMIT_SILENT_BREAKAWAY_OK: u32 = 0x0000_1000;
    const LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetLastError() -> u32;
    }

    /// Puts `child` in a job that ends it when this process ends. The job's handle is never closed here on purpose:
    /// the system closes it as this process exits, and that is what kills the child.
    pub fn bind(child: &std::process::Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        // SAFETY: plain Win32 calls on a handle this process owns and a zeroed C struct of integers.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return Err(format!(
                    "could not create a job object (error {})",
                    GetLastError()
                ));
            }
            let mut limits: ExtendedLimits = std::mem::zeroed();
            limits.basic.limit_flags = LIMIT_KILL_ON_JOB_CLOSE | LIMIT_SILENT_BREAKAWAY_OK;
            let size = u32::try_from(std::mem::size_of::<ExtendedLimits>()).unwrap_or(u32::MAX);
            if SetInformationJobObject(
                job,
                EXTENDED_LIMIT_INFORMATION,
                std::ptr::from_mut(&mut limits).cast(),
                size,
            ) == 0
            {
                return Err(format!(
                    "could not set the job's limits (error {})",
                    GetLastError()
                ));
            }
            if AssignProcessToJobObject(job, child.as_raw_handle().cast()) == 0 {
                return Err(format!(
                    "could not put the child in its job (error {})",
                    GetLastError()
                ));
            }
        }
        Ok(())
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
    if let Err(why) = job::bind(&child) {
        note(
            &launch.log,
            &format!("{why}; the agent is not ended if this launcher is"),
        );
    }
    /* THE CHILD'S OWN VERDICT, PASSED THROUGH, because with `--wait` this process is standing in for it: Task Scheduler
    reads the action's exit code. Only the child's own 0 is a success: a code that does not fit a byte (an NTSTATUS from a
    crash, the agent's watchdog ending it with TerminateProcess) and a wait that failed are both failures, so the task
    never reads a dead agent as one that finished. */
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

/* Everywhere else this is a program with nothing to do, and it says so rather than not existing. */
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

    /* Fire-and-forget is the DEFAULT, and that is the whole difference between the two callers: an agent's Run entry wants this process gone at once. */
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

    /* Everything after the separator belongs to the child, including the tokens this program has flags for. */
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
