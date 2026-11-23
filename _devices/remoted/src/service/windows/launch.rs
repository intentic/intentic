//! The service's work: keeping one helper running as SYSTEM in the session on the computer's screen.
//!
//! The helper is started with the service's own token (SYSTEM) moved into the console session
//! (`SetTokenInformation(TokenSessionId)`; `WTSQueryUserToken` would give the signed-in user's, and there is none at
//! the sign-in screen), on `winsta0\default`, in a job that ends it with the service. It reads its configuration (the
//! secret, the clients allowed, the user) from its stdin and ends when stdin does; its stdout carries what it asks of
//! the service (Ctrl+Alt+Del, which only a service may send) and which desktop takes input; its stderr is its log.
//! The console moving to another session (a user switch, a sign-out) moves the helper with it.

use super::{HelperState, Installed, binary, home, scm, secure};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::FromRawHandle;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_TIMEOUT,
};
use windows::Win32::Security::{
    DuplicateTokenEx, SECURITY_ATTRIBUTES, SecurityImpersonation, SetTokenInformation,
    TOKEN_ALL_ACCESS, TOKEN_DUPLICATE, TOKEN_QUERY, TokenPrimary, TokenSessionId,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessAsUserW, GetCurrentProcess,
    GetExitCodeProcess, OpenProcessToken, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
    STARTUPINFOW, TerminateProcess, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

/// What the helper reads from its stdin, one JSON line.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperConfig {
    pub secret: String,
    pub clients: Vec<std::path::PathBuf>,
    pub user_sid: String,
    pub version: String,
    /// The sandbox keys whose grant an administrator run must carry (`Installed::admin_keys`).
    #[serde(default)]
    pub admin_keys: Vec<String>,
}

pub struct Prepared {
    config: HelperConfig,
}

/// Starts the log and writes this boot's secret where only the user may read it.
pub fn prepare() -> Result<Prepared, String> {
    let home = home();
    let log_path = home.join("service.log");
    if std::fs::metadata(&log_path).is_ok_and(|m| m.len() > 2 << 20) {
        let _ = std::fs::rename(&log_path, home.join("service.log.1"));
    }
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
            .target(env_logger::Target::Pipe(Box::new(file)))
            .try_init();
    }
    log::info!("intentic-remoted {} service starting", crate::VERSION);
    let installed =
        Installed::read().ok_or("service.json is missing: install the service again")?;
    let secret = secure::random_secret()?;
    let path = home.join("secret");
    let _ = std::fs::remove_file(&path);
    // Made empty, its access list set (SYSTEM, administrators, and the user to read), then written through the handle
    // opened before: the secret is never in a file anyone else may read.
    let mut file = std::fs::File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    secure::set_acl(
        &path,
        &format!(
            "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;{})",
            installed.user_sid
        ),
    )?;
    file.write_all(secret.as_bytes())
        .map_err(|e| e.to_string())?;
    drop(file);
    Ok(Prepared {
        config: HelperConfig {
            secret,
            clients: installed.clients,
            user_sid: installed.user_sid,
            version: crate::VERSION.to_string(),
            admin_keys: installed.admin_keys,
        },
    })
}

/// A helper process and what the service holds of it.
struct Helper {
    process: HANDLE,
    job: HANDLE,
    stdin: Option<std::fs::File>,
    session: u32,
    pid: u32,
}

impl Helper {
    fn exited(&self) -> bool {
        // SAFETY: a zero wait on this helper's process handle.
        unsafe { WaitForSingleObject(self.process, 0) != WAIT_TIMEOUT }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        drop(self.stdin.take());
        // SAFETY: the helper's process and job handles; it ends on stdin closing, else it is ended here.
        unsafe {
            if WaitForSingleObject(self.process, 2_000) == WAIT_TIMEOUT {
                let _ = TerminateProcess(self.process, 1);
            }
            let mut code = 0u32;
            let _ = GetExitCodeProcess(self.process, &mut code);
            log::info!(
                "helper {} in session {} ended ({code:#x})",
                self.pid,
                self.session
            );
            let _ = CloseHandle(self.process);
            let _ = CloseHandle(self.job);
        }
    }
}

fn write_state(state: Option<&HelperState>) {
    let path = home().join("state.json");
    match state {
        Some(s) => {
            let _ = std::fs::write(&path, serde_json::to_string(s).unwrap_or_default());
        }
        None => {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Runs until the service is stopped: one helper in the console session, started again when it ends (after 2 s, at
/// most every 30 s while it keeps failing) or when the console moves.
pub fn supervise(prepared: &Prepared) {
    let mut helper: Option<Helper> = None;
    let mut failures = 0u32;
    let mut next_try = Instant::now();
    while !scm::stopping() && !UNINSTALL.load(std::sync::atomic::Ordering::Relaxed) {
        // SAFETY: a plain query.
        let console = unsafe { WTSGetActiveConsoleSessionId() };
        let stale = helper
            .as_ref()
            .is_some_and(|h| h.exited() || (console != u32::MAX && h.session != console));
        if stale {
            if helper.as_ref().is_some_and(Helper::exited) {
                failures += 1;
                next_try = Instant::now() + Duration::from_secs(2u64.pow(failures.min(4)).min(30));
            }
            helper = None;
            write_state(None);
        }
        if helper.is_none() && console != u32::MAX && Instant::now() >= next_try {
            match launch(console, &prepared.config) {
                Ok(h) => {
                    log::info!("helper {} started in session {console}", h.pid);
                    write_state(Some(&HelperState {
                        session: console,
                        pid: h.pid,
                        desktop: None,
                    }));
                    helper = Some(h);
                }
                Err(e) => {
                    failures += 1;
                    next_try = Instant::now() + Duration::from_secs(5);
                    log::warn!("the helper did not start in session {console}: {e}");
                }
            }
        }
        if helper.as_ref().is_some_and(|h| !h.exited()) && failures > 0 {
            failures = failures.saturating_sub(1);
        }
        scm::sleep(Duration::from_secs(1));
    }
    drop(helper);
    write_state(None);
    let _ = std::fs::remove_file(home().join("secret"));
    if UNINSTALL.load(std::sync::atomic::Ordering::Relaxed) {
        scm::remove_self();
    }
    log::info!("service stopped");
}

/// An anonymous pipe whose `child` end the helper inherits; the other end is the service's.
fn pipe(child_reads: bool) -> Result<(HANDLE, HANDLE), String> {
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: true.into(),
    };
    let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
    // SAFETY: out-pointers for the two ends.
    unsafe { CreatePipe(&mut read, &mut write, Some(&sa), 0) }.map_err(|e| e.to_string())?;
    let (child, ours) = if child_reads {
        (read, write)
    } else {
        (write, read)
    };
    // SAFETY: the service's own end is not inherited.
    unsafe {
        SetHandleInformation(
            ours,
            HANDLE_FLAG_INHERIT.0,
            windows::Win32::Foundation::HANDLE_FLAGS(0),
        )
    }
    .map_err(|e| e.to_string())?;
    Ok((child, ours))
}

/// Starts the helper as SYSTEM in `session`.
fn launch(session: u32, config: &HelperConfig) -> Result<Helper, String> {
    let mut own = HANDLE::default();
    let mut token = HANDLE::default();
    // SAFETY: this process's token duplicated as a primary token, moved to the console session (LocalSystem holds the
    // privilege that takes), and closed below.
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, &mut own)
            .map_err(|e| format!("the service's token: {e}"))?;
        let dup = DuplicateTokenEx(
            own,
            TOKEN_ALL_ACCESS,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut token,
        );
        let _ = CloseHandle(own);
        dup.map_err(|e| format!("DuplicateTokenEx: {e}"))?;
        if let Err(e) = SetTokenInformation(
            token,
            TokenSessionId,
            std::ptr::from_ref(&session).cast(),
            std::mem::size_of::<u32>() as u32,
        ) {
            let _ = CloseHandle(token);
            return Err(format!("moving the token to session {session}: {e}"));
        }
    }
    let close_token = || {
        // SAFETY: the token made above.
        unsafe {
            let _ = CloseHandle(token);
        }
    };
    let (stdin_child, stdin_ours) = pipe(true).inspect_err(|_| close_token())?;
    let (stdout_child, stdout_ours) = pipe(false).inspect_err(|_| close_token())?;
    let (stderr_child, stderr_ours) = pipe(false).inspect_err(|_| close_token())?;
    let mut desktop: Vec<u16> = "winsta0\\default\0".encode_utf16().collect();
    let si = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop.as_mut_ptr()),
        dwFlags: STARTF_USESTDHANDLES,
        hStdInput: stdin_child,
        hStdOutput: stdout_child,
        hStdError: stderr_child,
        ..Default::default()
    };
    let mut command: Vec<u16> = format!("\"{}\" desktop-helper\0", binary().display())
        .encode_utf16()
        .collect();
    let mut pi = PROCESS_INFORMATION::default();
    // The helper's process may be asked its image path by the user (remoted checks it), and nothing more.
    let process_sa = secure::Descriptor::new(&format!(
        "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x1000;;;{})",
        config.user_sid
    ))
    .inspect_err(|_| close_token())?;
    let attributes = process_sa.attributes();
    // SAFETY: the token, a writable command line, the startup info with the inherited ends, and an out struct.
    let started = unsafe {
        CreateProcessAsUserW(
            Some(token),
            PCWSTR::null(),
            Some(PWSTR(command.as_mut_ptr())),
            Some(&attributes),
            None,
            true,
            CREATE_NO_WINDOW | CREATE_SUSPENDED,
            None,
            PCWSTR::null(),
            &si,
            &mut pi,
        )
    };
    // SAFETY: the child's ends (it holds its own copies now) and the token.
    unsafe {
        let _ = CloseHandle(stdin_child);
        let _ = CloseHandle(stdout_child);
        let _ = CloseHandle(stderr_child);
    }
    close_token();
    if let Err(e) = started {
        // SAFETY: the service's ends of pipes nobody uses.
        unsafe {
            let _ = CloseHandle(stdin_ours);
            let _ = CloseHandle(stdout_ours);
            let _ = CloseHandle(stderr_ours);
        }
        return Err(format!("CreateProcessAsUser: {e}"));
    }
    // A job that ends the helper when the service's handle on it closes (the service ending, however it ends). An
    // administrator run the helper starts asks to break away from it (admin.rs): that is the person's own process,
    // which outlives a helper started again in another session, as a program they started themselves would.
    // SAFETY: a job, its limit, the helper put in it and then let run; handles kept in `Helper`.
    let job = unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null()).unwrap_or_default();
        let mut limit = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limit.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let _ = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limit).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        let _ = AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);
        let _ = CloseHandle(pi.hThread);
        job
    };
    // SAFETY: the service's ends, owned by these files from here on.
    let (mut stdin, stdout, stderr) = unsafe {
        (
            std::fs::File::from_raw_handle(stdin_ours.0),
            std::fs::File::from_raw_handle(stdout_ours.0),
            std::fs::File::from_raw_handle(stderr_ours.0),
        )
    };
    let pid = pi.dwProcessId;
    let line = serde_json::to_string(config).map_err(|e| e.to_string())?;
    let _ = writeln!(stdin, "{line}");
    let _ = stdin.flush();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            log::info!("helper {pid}: {line}");
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            asked(pid, session, &line);
        }
    });
    Ok(Helper {
        process: pi.hProcess,
        job,
        stdin: Some(stdin),
        session,
        pid,
    })
}

/// Set when the person's remoted asked, through the helper, for the service to be removed.
static UNINSTALL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// One line the helper wrote to the service: `{"sas":true}`, `{"desktop":"Winlogon"}`, or `{"uninstall":true}`.
fn asked(pid: u32, session: u32, line: &str) {
    let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    if message["uninstall"] == true {
        log::info!("helper {pid}: the person's remoted asked for the service to be removed");
        UNINSTALL.store(true, std::sync::atomic::Ordering::Relaxed);
        scm::wake();
    }
    if message["sas"] == true {
        log::info!("helper {pid}: Ctrl+Alt+Del");
        secure::send_sas();
    }
    if let Some(desktop) = message.get("desktop") {
        write_state(Some(&HelperState {
            session,
            pid,
            desktop: desktop.as_str().map(str::to_owned),
        }));
    }
}
