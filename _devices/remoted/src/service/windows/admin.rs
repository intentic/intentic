//! Administrator runs: the helper (SYSTEM, in the session on the computer's screen) starts a command for the person's
//! remoted with the signed-in person's own elevated token in their session, which is what clicking Yes on a UAC prompt
//! gives (their profile, their HKCU and %APPDATA%, any window on their desktop), and relays its output and exit code.
//!
//! - [`serve`], the helper's side: `\\.\pipe\intentic-remoted-admin-<session>`, with the desktop pipe's access list,
//!   client check and secret. One thread a connection: a hello, one run, its output, its exit code. A run starts only
//!   with a grant one of the sandbox keys pinned at install signed for exactly its PowerShell command
//!   ([`wire::Grants`]), and only from PowerShell's own folders, which only an administrator can change.
//! - [`cli`], the caller's side: `intentic-remoted service admin-run`, which the machine agent spawns like any process.
//!   It checks the pipe's server as remoted checks the desktop pipe's, passes the output on to its own stdout and
//!   stderr as it comes, and writes one status line before it exits.
//!
//! A pipe and a protocol of their own ([`crate::service::admin`]): cast-win's helper protocol is what every service
//! installed on a PC speaks until someone sets it up again through a UAC prompt, so administrator runs never move it.

use super::finder::SERVICE_OWNERS;
use super::helper::check;
use super::{Installed, admin_pipe_name, binary, home, scm};
use crate::service::admin::{
    self as wire, ADMIN_PROTOCOL, FromAdmin, Grants, Refusal, Stream, ToAdmin, reason,
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cast_win::helper::pipe::{self, Pipe};
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_NO_TOKEN, ERROR_NOT_ALL_ASSIGNED,
    GENERIC_READ, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAGS, LUID,
    SetHandleInformation,
};
use windows::Win32::Security::{
    AdjustTokenPrivileges, CheckTokenMembership, CreateWellKnownSid, DuplicateTokenEx,
    GetTokenInformation, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW, PSID,
    SE_ASSIGNPRIMARYTOKEN_NAME, SE_INCREASE_QUOTA_NAME, SE_PRIVILEGE_ENABLED, SE_TCB_NAME,
    SECURITY_ATTRIBUTES, SECURITY_MAX_SID_SIZE, SecurityIdentification, SecurityImpersonation,
    SetTokenInformation, TOKEN_ADJUST_PRIVILEGES, TOKEN_ALL_ACCESS, TOKEN_ELEVATION_TYPE,
    TOKEN_LINKED_TOKEN, TOKEN_PRIVILEGES, TOKEN_QUERY, TokenElevationType, TokenElevationTypeFull,
    TokenElevationTypeLimited, TokenImpersonation, TokenLinkedToken, TokenPrimary, TokenSessionId,
    WinBuiltinAdministratorsSid,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::IO::CancelSynchronousIo;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::RemoteDesktop::WTSQueryUserToken;
use windows::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    CreateProcessAsUserW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetCurrentProcess, GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcessToken, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, STARTUPINFOW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

/// How long the outputs may stay open after the command ended: something it started in the background may hold them.
const DRAIN: Duration = Duration::from_secs(2);
/// How much of the command's output one message carries at most.
const CHUNK: usize = 16 << 10;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A handle closed when dropped.
struct Owned(HANDLE);

// SAFETY: a kernel handle, which any thread of the process may use.
unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}

impl Owned {
    /// The handle, no longer closed here (something else owns it now).
    fn into_raw(self) -> HANDLE {
        let handle = self.0;
        std::mem::forget(self);
        handle
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: a handle this process opened and nothing else closes.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

// The helper's side.

/// What the helper serves administrator runs with: its session, and what the service handed it.
pub struct Serving {
    pub session: u32,
    pub user_sid: String,
    pub clients: Vec<PathBuf>,
    pub secret: String,
    pub version: String,
    /// The pinned sandbox keys and the grants' nonces used.
    pub grants: Grants,
}

/// Milliseconds since the epoch, as a grant's times are.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The folders a run's PowerShell must come from: Windows PowerShell's and PowerShell's under Program Files, each of
/// which only an administrator can change (so a program of the user cannot stand its own pwsh.exe there).
fn powershell_folders() -> Vec<String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let files = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    [
        format!(r"{root}\System32\WindowsPowerShell"),
        format!(r"{root}\SysWOW64\WindowsPowerShell"),
        format!(r"{files}\PowerShell"),
    ]
    .into_iter()
    .map(|f| std::fs::canonicalize(&f).map_or(f, |p| p.to_string_lossy().into_owned()))
    .collect()
}

/// Serves administrator runs on this session's administrator pipe, forever (the helper's thread).
pub fn serve(serving: Serving) {
    enable_privileges();
    let serving = Arc::new(serving);
    let name = admin_pipe_name(serving.session);
    // SYSTEM, and the user the service was installed for; nobody else may even open it.
    let sddl = format!("D:P(A;;GA;;;SY)(A;;GRGW;;;{})", serving.user_sid);
    log::info!(
        "administrator runs served on {name} ({} sandbox keys pinned)",
        serving.grants.keys()
    );
    let mut first = true;
    loop {
        let server = match Pipe::create(&name, &sddl, first) {
            Ok(p) => p,
            Err(e) => {
                log::error!("{e}");
                if first {
                    // Someone else holds the name: never serve under it.
                    log::error!("administrator runs are not served here");
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        first = false;
        if let Err(e) = server.accept() {
            log::warn!("{name}: {e}");
            continue;
        }
        let Some(peer) = server.peer_pid() else {
            continue;
        };
        if let Err(why) = check(peer, serving.session, &serving.clients) {
            log::warn!("administrator runs: refused process {peer}: {why}");
            continue;
        }
        let serving = serving.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("admin-run-{peer}"))
            .spawn(move || {
                let pipe = Arc::new(server);
                if let Err(e) = connection(pipe.clone(), peer, &serving) {
                    log::warn!("administrator run for process {peer}: {e}");
                }
                linger(&pipe);
            });
        if let Err(e) = spawned {
            log::warn!("administrator run for process {peer}: {e}");
        }
    }
}

/// How long the last answer waits for the caller to read it and hang up.
const LINGER: Duration = Duration::from_secs(5);

/// Holds the pipe open until the caller has read the last message and hung up, for [`LINGER`] at most: a server's
/// `DisconnectNamedPipe` (the pipe's drop) throws away what the caller has not read yet, so a refusal sent just before
/// it reached the caller as a broken pipe ("lost") rather than as the refusal it was (found on rog, 2026-11-23).
fn linger(pipe: &Arc<Pipe>) {
    let done = Arc::new(AtomicBool::new(false));
    let (weak, flag) = (Arc::downgrade(pipe), done.clone());
    let _ = std::thread::Builder::new()
        .name("admin-run-linger".into())
        .spawn(move || {
            let until = Instant::now() + LINGER;
            while Instant::now() < until {
                if flag.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if let Some(pipe) = weak.upgrade() {
                pipe.cancel();
            }
        });
    // Ends when the caller hangs up (or the timer cancels it); anything it still says is of no use now.
    let _ = pipe.recv::<ToAdmin>();
    done.store(true, Ordering::Relaxed);
}

/// One caller: its hello, its one run, the run's output and exit code.
fn connection(pipe: Arc<Pipe>, peer: u32, serving: &Serving) -> Result<(), String> {
    match pipe.recv::<ToAdmin>()? {
        ToAdmin::Hello { protocol, secret } => {
            if !wire::same_secret(&secret, &serving.secret) {
                let _ = pipe.send(&FromAdmin::Refused {
                    why: "a wrong secret".into(),
                });
                return Err("it said hello with a wrong secret".into());
            }
            pipe.send(&FromAdmin::Welcome {
                protocol: ADMIN_PROTOCOL,
                version: serving.version.clone(),
            })?;
            if protocol != ADMIN_PROTOCOL {
                return Err(format!(
                    "it speaks protocol {protocol}, this helper {ADMIN_PROTOCOL}"
                ));
            }
        }
        other => {
            return Err(format!(
                "it began with a {} rather than a hello",
                other.kind()
            ));
        }
    }
    let ToAdmin::Run {
        program,
        args,
        cwd,
        grant,
    } = pipe.recv::<ToAdmin>()?
    else {
        return Err("it said hello twice".into());
    };
    log::info!(
        "administrator run for process {peer}: {program} {}",
        wire::excerpt(&args.join(" "), 200)
    );
    // The grant before anything else: nothing is started, nor any token asked for, without it.
    if let Err(Refusal { reason, why }) =
        serving
            .grants
            .admit(grant.as_deref(), &program, &args, now_ms())
    {
        log::warn!("administrator run for process {peer} refused ({reason}): {why}");
        pipe.send(&FromAdmin::Failed {
            reason: reason.into(),
            why,
        })?;
        return Ok(());
    }
    match start(serving.session, &program, &args, cwd.as_deref()) {
        Ok(child) => relay(&pipe, peer, child),
        Err(Failure { reason, why }) => {
            log::warn!("administrator run for process {peer} did not start ({reason}): {why}");
            pipe.send(&FromAdmin::Failed {
                reason: reason.into(),
                why,
            })?;
        }
    }
    Ok(())
}

/// Why a run did not start: one of `refused`, `nobody-signed-in`, `not-administrator`, `start-failed`, and a sentence.
struct Failure {
    reason: &'static str,
    why: String,
}

impl Failure {
    fn start(why: String) -> Failure {
        Failure {
            reason: reason::START_FAILED,
            why,
        }
    }
}

/// A command started suspended, in its job, with the helper's ends of its outputs.
struct Child {
    process: Owned,
    thread: Owned,
    job: Arc<Owned>,
    pid: u32,
    stdout: std::fs::File,
    stderr: std::fs::File,
}

/// Enables what starting a process as another user takes on the helper's own token (it is SYSTEM's, which holds each
/// of them): `WTSQueryUserToken` needs SeTcbPrivilege, `CreateProcessAsUser` the other two. Once, at the start.
fn enable_privileges() {
    let mut token = HANDLE::default();
    // SAFETY: this process's token, with the access adjusting it takes; closed by `Owned`.
    if let Err(e) = unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
    } {
        log::warn!("administrator runs: this helper's token: {e}; starting a command may fail");
        return;
    }
    let token = Owned(token);
    let mut missing = Vec::new();
    for (name, label) in [
        (SE_TCB_NAME, "SeTcbPrivilege"),
        (SE_ASSIGNPRIMARYTOKEN_NAME, "SeAssignPrimaryTokenPrivilege"),
        (SE_INCREASE_QUOTA_NAME, "SeIncreaseQuotaPrivilege"),
    ] {
        let mut luid = LUID::default();
        // SAFETY: a privilege's name and an out-pointer; then one privilege enabled on the token opened above.
        // AdjustTokenPrivileges succeeds even for a privilege the token does not hold, saying so in the last error.
        let enabled = unsafe {
            LookupPrivilegeValueW(PCWSTR::null(), name, &mut luid).is_ok() && {
                let privileges = TOKEN_PRIVILEGES {
                    PrivilegeCount: 1,
                    Privileges: [LUID_AND_ATTRIBUTES {
                        Luid: luid,
                        Attributes: SE_PRIVILEGE_ENABLED,
                    }],
                };
                AdjustTokenPrivileges(token.0, false, Some(&privileges), 0, None, None).is_ok()
                    && GetLastError() != ERROR_NOT_ALL_ASSIGNED
            }
        };
        if !enabled {
            missing.push(label);
        }
    }
    if !missing.is_empty() {
        log::warn!(
            "administrator runs: this helper could not enable {}; starting a command may fail",
            missing.join(", ")
        );
    }
}

fn token_info<T: Default>(
    token: HANDLE,
    class: windows::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> windows::core::Result<T> {
    let mut value = T::default();
    let mut len = 0u32;
    // SAFETY: a buffer the size of the class's fixed-size answer.
    unsafe {
        GetTokenInformation(
            token,
            class,
            Some(std::ptr::from_mut(&mut value).cast()),
            std::mem::size_of::<T>() as u32,
            &mut len,
        )
    }?;
    Ok(value)
}

/// Whether a token (one without a linked token: no UAC split) is a member of BUILTIN\Administrators.
fn is_administrator(token: &Owned) -> windows::core::Result<bool> {
    let mut sid = [0u32; (SECURITY_MAX_SID_SIZE as usize).div_ceil(4)];
    let mut size = SECURITY_MAX_SID_SIZE;
    let admins = PSID(sid.as_mut_ptr().cast());
    let mut identify = HANDLE::default();
    let mut member = windows::core::BOOL::default();
    // SAFETY: a SID written into a buffer of the largest SID's size; an identification-level copy of the token (what
    // CheckTokenMembership asks), closed by `Owned`; an out-pointer.
    unsafe {
        CreateWellKnownSid(WinBuiltinAdministratorsSid, None, Some(admins), &mut size)?;
        DuplicateTokenEx(
            token.0,
            TOKEN_QUERY,
            None,
            SecurityIdentification,
            TokenImpersonation,
            &mut identify,
        )?;
        let identify = Owned(identify);
        CheckTokenMembership(Some(identify.0), admins, &mut member)?;
    }
    Ok(member.as_bool())
}

/// The signed-in person's administrator token in `session`, as a primary token of its own: the linked (elevated) one
/// of a UAC split token, else theirs when it is already an administrator's.
fn elevated_token(session: u32) -> Result<Owned, Failure> {
    let mut user = HANDLE::default();
    // SAFETY: an out-pointer; the call takes SeTcbPrivilege, which the helper holds as SYSTEM.
    if let Err(e) = unsafe { WTSQueryUserToken(session, &mut user) } {
        let nobody = e.code() == ERROR_NO_TOKEN.to_hresult()
            || e.code() == ERROR_FILE_NOT_FOUND.to_hresult();
        return Err(if nobody {
            Failure {
                reason: reason::NOBODY_SIGNED_IN,
                why: "Nobody is signed in on this computer's screen, so there are no administrator rights to run it with: sign in at the computer first.".into(),
            }
        } else {
            Failure::start(format!(
                "Windows did not give the signed-in person's token to the service: {e}."
            ))
        });
    }
    let user = Owned(user);
    let unknown = |e: windows::core::Error| {
        Failure::start(format!(
            "Windows did not say whether the signed-in person is an administrator: {e}."
        ))
    };
    let kind: TOKEN_ELEVATION_TYPE = token_info(user.0, TokenElevationType).map_err(unknown)?;
    let elevated = if kind == TokenElevationTypeLimited {
        // With SeTcbPrivilege the linked token comes as a primary token (without, an identification-level copy).
        let linked: TOKEN_LINKED_TOKEN = token_info(user.0, TokenLinkedToken).map_err(|e| {
            Failure::start(format!(
                "Windows did not give the signed-in person's administrator token: {e}."
            ))
        })?;
        Owned(linked.LinkedToken)
    } else if kind == TokenElevationTypeFull || is_administrator(&user).map_err(unknown)? {
        user
    } else {
        return Err(Failure {
            reason: reason::NOT_ADMINISTRATOR,
            why: "The account signed in on this computer's screen is not an administrator, so there are no administrator rights to run it with.".into(),
        });
    };
    let mut primary = HANDLE::default();
    // SAFETY: the token above copied as a primary token of this helper's own, closed by `Owned`.
    unsafe {
        DuplicateTokenEx(
            elevated.0,
            TOKEN_ALL_ACCESS,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        )
    }
    .map_err(|e| {
        Failure::start(format!(
            "Windows did not let the signed-in person's administrator token start a program: {e}."
        ))
    })?;
    let primary = Owned(primary);
    // Its windows belong on this session's desktop, whatever session the linked token said.
    let theirs = token_info::<u32>(primary.0, TokenSessionId).ok();
    if theirs != Some(session) {
        log::info!(
            "administrator runs: the elevated token is in session {theirs:?}; moved to {session}"
        );
        // SAFETY: a token of this helper's own and a u32; moving it takes SeTcbPrivilege.
        unsafe {
            SetTokenInformation(
                primary.0,
                TokenSessionId,
                std::ptr::from_ref(&session).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        }
        .map_err(|e| {
            Failure::start(format!(
                "Windows did not let the administrator token into session {session}: {e}."
            ))
        })?;
    }
    Ok(primary)
}

/// The signed-in person's environment for a token (theirs and the system's variables, nothing of the helper's).
struct Environment(*mut core::ffi::c_void);

impl Environment {
    fn of(token: &Owned) -> windows::core::Result<Environment> {
        let mut block = std::ptr::null_mut();
        // SAFETY: an out-pointer for a block freed by Drop.
        unsafe { CreateEnvironmentBlock(&mut block, Some(token.0), false) }?;
        Ok(Environment(block))
    }

    /// The block's UTF-16, its closing double NUL included.
    fn units(&self) -> &[u16] {
        let p = self.0.cast::<u16>().cast_const();
        let mut n = 0;
        // SAFETY: `NAME=value\0` strings ending in an empty one: read up to and including the double NUL.
        unsafe {
            while !(*p.add(n) == 0 && *p.add(n + 1) == 0) {
                n += 1;
            }
            std::slice::from_raw_parts(p, n + 2)
        }
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        // SAFETY: the block CreateEnvironmentBlock made.
        unsafe {
            let _ = DestroyEnvironmentBlock(self.0);
        }
    }
}

/// An anonymous pipe for one of the command's outputs: the command's end (inheritable) and the helper's (not).
fn output_pipe(inherit: &SECURITY_ATTRIBUTES) -> Result<(Owned, Owned), String> {
    let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
    // SAFETY: out-pointers for the two ends, each closed by `Owned`.
    unsafe { CreatePipe(&mut read, &mut write, Some(inherit), 64 << 10) }
        .map_err(|e| e.to_string())?;
    let (read, write) = (Owned(read), Owned(write));
    // SAFETY: the helper's end is never inherited.
    unsafe { SetHandleInformation(read.0, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) }
        .map_err(|e| e.to_string())?;
    Ok((write, read))
}

/// A process attribute list naming the only handles the command inherits, so a run started at the same moment never
/// inherits another's ends.
struct HandleList {
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
    _buffer: Vec<usize>,
    handles: Box<[HANDLE; 3]>,
}

impl HandleList {
    fn new(handles: [HANDLE; 3]) -> Result<HandleList, String> {
        let mut size = 0usize;
        // SAFETY: asks the list's size only (failing with ERROR_INSUFFICIENT_BUFFER, as documented).
        let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut size) };
        let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr().cast());
        // SAFETY: a buffer of the size asked for, deleted by Drop once initialized.
        unsafe { InitializeProcThreadAttributeList(Some(list), 1, None, &mut size) }
            .map_err(|e| e.to_string())?;
        let made = HandleList {
            list,
            _buffer: buffer,
            handles: Box::new(handles),
        };
        // SAFETY: the handles' array lives as long as the list (both held by `made`).
        unsafe {
            UpdateProcThreadAttribute(
                made.list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(made.handles.as_ptr().cast()),
                std::mem::size_of::<[HANDLE; 3]>(),
                None,
                None,
            )
        }
        .map_err(|e| e.to_string())?;
        Ok(made)
    }
}

impl Drop for HandleList {
    fn drop(&mut self) {
        // SAFETY: a list initialized in `new`.
        unsafe { DeleteProcThreadAttributeList(self.list) };
    }
}

/// Starts `program args` in `cwd` (None: the person's profile folder) with the signed-in person's administrator token
/// in `session`, suspended and in a job of its own, its stdin NUL and its outputs on pipes to the helper.
fn start(
    session: u32,
    program: &str,
    args: &[String],
    cwd: Option<&str>,
) -> Result<Child, Failure> {
    let token = elevated_token(session)?;
    let env = Environment::of(&token).map_err(|e| {
        Failure::start(format!(
            "Windows did not make the signed-in person's environment: {e}."
        ))
    })?;
    let cwd = cwd
        .map(str::to_owned)
        .or_else(|| wire::env_block_var(env.units(), "USERPROFILE"));
    let path = wire::env_block_var(env.units(), "Path");
    // Anything there but a folder (an app execution alias such as winget's is a reparse point, not a file).
    let app = wire::resolve_program(program, cwd.as_deref(), path.as_deref(), &|p: &str| {
        std::fs::symlink_metadata(p).is_ok_and(|m| !m.is_dir())
    });
    // PowerShell from its own folders only: the grant covers the script, the folder is what keeps the program Windows'.
    let canonical = app
        .as_deref()
        .and_then(|a| std::fs::canonicalize(a).ok())
        .map(|p| p.to_string_lossy().into_owned());
    if !canonical
        .as_deref()
        .is_some_and(|p| wire::inside(p, &powershell_folders()))
    {
        return Err(Failure {
            reason: reason::REFUSED,
            why: format!(
                "{} is not PowerShell from Windows' own folder or Program Files, which only an administrator can change",
                app.as_deref().unwrap_or(program)
            ),
        });
    }
    let shown = app.as_deref().unwrap_or(program);
    let line = wire::command_line(shown, args).map_err(|e| Failure::start(format!("{e}.")))?;
    let failed = |what: &str, e: String| {
        Failure::start(format!(
            "Windows could not start {shown} as administrator ({what}): {e}."
        ))
    };
    // SAFETY: a job with no limits (it ends nothing when closed), closed by `Owned`.
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map(Owned)
        .map_err(|e| failed("a job object", e.to_string()))?;
    let inherit = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: true.into(),
    };
    // SAFETY: NUL opened to read, inheritable, closed by `Owned`.
    let nul = unsafe {
        CreateFileW(
            windows::core::w!("NUL"),
            GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            Some(&inherit),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .map(Owned)
    .map_err(|e| failed("its stdin", e.to_string()))?;
    let (out_child, out_ours) = output_pipe(&inherit).map_err(|e| failed("its stdout", e))?;
    let (err_child, err_ours) = output_pipe(&inherit).map_err(|e| failed("its stderr", e))?;
    let handles = HandleList::new([nul.0, out_child.0, err_child.0])
        .map_err(|e| failed("the handles it inherits", e))?;
    let mut desktop = wide("winsta0\\default");
    let si = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
            lpDesktop: PWSTR(desktop.as_mut_ptr()),
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: nul.0,
            hStdOutput: out_child.0,
            hStdError: err_child.0,
            ..Default::default()
        },
        lpAttributeList: handles.list,
    };
    let app_w = app.as_deref().map(wide);
    let cwd_w = cwd.as_deref().map(wide);
    let flags = CREATE_UNICODE_ENVIRONMENT
        | CREATE_NO_WINDOW
        | CREATE_SUSPENDED
        | EXTENDED_STARTUPINFO_PRESENT;
    let create = |flags: PROCESS_CREATION_FLAGS| {
        let mut line = wide(&line);
        let mut pi = PROCESS_INFORMATION::default();
        // SAFETY: the token, zero-terminated strings (the command line writable, as the call asks), the person's
        // environment block, the extended startup info (its handle list alive in `handles`) and an out struct.
        unsafe {
            CreateProcessAsUserW(
                Some(token.0),
                app_w
                    .as_ref()
                    .map_or(PCWSTR::null(), |a| PCWSTR(a.as_ptr())),
                Some(PWSTR(line.as_mut_ptr())),
                None,
                None,
                true,
                flags,
                Some(env.0.cast_const()),
                cwd_w
                    .as_ref()
                    .map_or(PCWSTR::null(), |c| PCWSTR(c.as_ptr())),
                std::ptr::from_ref(&si).cast::<STARTUPINFOW>(),
                &mut pi,
            )
        }
        .map(|()| pi)
    };
    // Out of the helper's job (which ends with the service): the command is the person's own, and outlives a helper
    // started again elsewhere. A helper in a job that allows no breaking away (one run by hand) keeps it in its job.
    let started = match create(flags | CREATE_BREAKAWAY_FROM_JOB) {
        Err(e) if e.code() == ERROR_ACCESS_DENIED.to_hresult() => {
            let again = create(flags);
            if again.is_ok() {
                log::info!(
                    "administrator runs: this helper's job lets nothing break away; the run stays in it"
                );
            }
            again
        }
        other => other,
    };
    drop(handles);
    drop((nul, out_child, err_child));
    let pi = started.map_err(|e| failed("CreateProcessAsUser", e.to_string()))?;
    let (process, thread) = (Owned(pi.hProcess), Owned(pi.hThread));
    // SAFETY: the suspended process into its job; ended if it cannot be, as nothing could end what it starts then.
    if let Err(e) = unsafe { AssignProcessToJobObject(job.0, process.0) } {
        // SAFETY: the process just made, never resumed.
        unsafe {
            let _ = TerminateProcess(process.0, 1);
        }
        return Err(failed("its job object", e.to_string()));
    }
    // SAFETY: the helper's ends of the pipes, owned by these files from here on.
    let (stdout, stderr) = unsafe {
        (
            std::fs::File::from_raw_handle(out_ours.into_raw().0),
            std::fs::File::from_raw_handle(err_ours.into_raw().0),
        )
    };
    Ok(Child {
        process,
        thread,
        job: Arc::new(job),
        pid: pi.dwProcessId,
        stdout,
        stderr,
    })
}

/// Reads one output to its end (or until `stop`), each chunk sent as it came. A caller gone stops the sending, never
/// the reading: the command must not block on a full pipe before the job is ended.
fn read_output(mut file: std::fs::File, stream: Stream, pipe: &Pipe, stop: &AtomicBool) {
    let mut buf = vec![0u8; CHUNK];
    let mut sending = true;
    while !stop.load(Ordering::SeqCst) {
        match file.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                if sending {
                    let data = STANDARD.encode(&buf[..n]);
                    sending = pipe.send(&FromAdmin::Out { stream, data }).is_ok();
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            // Cancelled (`stop`), or the pipe failed.
            Err(_) => return,
        }
    }
}

/// Lets the command run and relays it: its output as it comes, then its exit code. The caller hanging up (its
/// deadline ended it) ends the job, the command and everything it started with it.
fn relay(pipe: &Arc<Pipe>, peer: u32, child: Child) {
    let Child {
        process,
        thread,
        job,
        pid,
        stdout,
        stderr,
    } = child;
    if pipe.send(&FromAdmin::Started { pid }).is_err() {
        log::warn!("administrator run {pid}: the caller hung up before it began; ended");
        // SAFETY: the run's job, with its one process never resumed.
        unsafe {
            let _ = TerminateJobObject(job.0, 1);
        }
        return;
    }
    log::info!("administrator run {pid} started for process {peer}");
    let finished = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let (ended_tx, ended_rx) = std::sync::mpsc::channel::<()>();
    let readers: Vec<_> = [(stdout, Stream::Stdout), (stderr, Stream::Stderr)]
        .into_iter()
        .filter_map(|(file, stream)| {
            let (pipe, stop, ended) = (pipe.clone(), stop.clone(), ended_tx.clone());
            std::thread::Builder::new()
                .name(format!("admin-run-{pid}-{stream:?}"))
                .spawn(move || {
                    read_output(file, stream, &pipe, &stop);
                    let _ = ended.send(());
                })
                .inspect_err(|e| log::warn!("administrator run {pid}: its {stream:?}: {e}"))
                .ok()
        })
        .collect();
    drop(ended_tx);
    let watcher = {
        let (pipe, finished, job) = (pipe.clone(), finished.clone(), job.clone());
        std::thread::Builder::new()
            .name(format!("admin-run-{pid}-caller"))
            .spawn(move || {
                // Nothing more is said after the run: any end of reading is the caller gone.
                while pipe.recv::<serde_json::Value>().is_ok() {}
                if !finished.load(Ordering::SeqCst) {
                    log::info!(
                        "administrator run {pid}: the caller hung up; ending it and everything it started"
                    );
                    // SAFETY: the run's job, alive while this thread holds it.
                    unsafe {
                        let _ = TerminateJobObject(job.0, 1);
                    }
                }
            })
    };
    if let Err(e) = &watcher {
        log::warn!("administrator run {pid}: nothing watches its caller: {e}");
    }
    // SAFETY: the run's main thread, created suspended.
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        log::warn!(
            "administrator run {pid}: it could not be resumed ({}); ended",
            std::io::Error::last_os_error()
        );
        // SAFETY: the run's job.
        unsafe {
            let _ = TerminateJobObject(job.0, 1);
        }
    }
    drop(thread);
    // SAFETY: the run's process handle, waited on until it ends.
    unsafe { WaitForSingleObject(process.0, INFINITE) };
    let deadline = Instant::now() + DRAIN;
    let mut ended = 0;
    while ended < readers.len() {
        match ended_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(()) => ended += 1,
            Err(_) => {
                log::info!(
                    "administrator run {pid}: its output is still held open by something it started; not waiting"
                );
                break;
            }
        }
    }
    stop.store(true, Ordering::SeqCst);
    for reader in readers {
        // A read blocked on a pipe something left running holds: cancelled, again until the thread notices `stop`.
        let deadline = Instant::now() + Duration::from_secs(1);
        while !reader.is_finished() && Instant::now() < deadline {
            // SAFETY: a live thread's handle; cancels its synchronous read, if one is pending.
            unsafe {
                let _ = CancelSynchronousIo(HANDLE(reader.as_raw_handle()));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if reader.is_finished() {
            let _ = reader.join();
        } else {
            log::warn!("administrator run {pid}: an output reader did not stop");
        }
    }
    let mut code = 0u32;
    // SAFETY: the ended process's handle and an out-pointer.
    if let Err(e) = unsafe { GetExitCodeProcess(process.0, &mut code) } {
        log::warn!("administrator run {pid}: its exit code: {e}");
        code = 1;
    }
    // Before the exit code goes: the caller hanging up once it has it is not a deadline.
    finished.store(true, Ordering::SeqCst);
    let gone = pipe.send(&FromAdmin::Exited { code }).is_err();
    log::info!(
        "administrator run {pid} for process {peer} exited with {code}{}",
        if gone { " (its caller was gone)" } else { "" }
    );
    // The watcher's read ends now; the job closes with no limit set, so what the command started in the background
    // keeps running.
    pipe.cancel();
    if let Ok(watcher) = watcher {
        let _ = watcher.join();
    }
}

// The caller's side: `intentic-remoted service admin-run`.

/// Why the command did not run, as the status file says it.
struct NotRan {
    reason: String,
    error: String,
}

fn not_ran(reason: &str, error: impl Into<String>) -> NotRan {
    NotRan {
        reason: reason.into(),
        error: error.into(),
    }
}

const SET_UP: &str = "from this device's Remote access section in Intentic (one administrator's yes at this computer)";

/// Whether the administrator pipe is listening: asked a few times, as the moment between one caller's connection and
/// the helper's next instance reads as none.
fn listening(name: &str) -> bool {
    (0..5).any(|i| {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
        Pipe::exists(name)
    })
}

/// Connects to the helper's administrator pipe, checks its server as remoted checks the desktop pipe's (owned by SYSTEM
/// or Administrators, running the service's binary, in this session), and says hello with the service's secret.
fn connect(name: &str, by_hand: bool) -> Result<Pipe, NotRan> {
    let unreachable = |why: String| {
        not_ran(
            reason::UNREACHABLE,
            format!(
                "The lock screen and admin prompts service's helper could not be reached: {why}."
            ),
        )
    };
    let pipe = Pipe::open(name, 2_000).map_err(unreachable)?;
    let pid = pipe
        .peer_pid()
        .ok_or_else(|| unreachable("its process is unknown".into()))?;
    // The service's helper runs as SYSTEM; one run by hand for a test (another home) is the user's own.
    if !by_hand {
        let owner = pipe
            .owner_sid()
            .ok_or_else(|| unreachable("the pipe's owner is unknown".into()))?;
        if !SERVICE_OWNERS.contains(&owner.as_str()) {
            return Err(unreachable(format!(
                "the pipe is owned by {owner}, not by the service"
            )));
        }
    }
    if let (Some(theirs), Some(ours)) = (
        pipe::process_session(pid),
        pipe::process_session(std::process::id()),
    ) && theirs != ours
    {
        return Err(unreachable(format!(
            "the helper (process {pid}) is in session {theirs}, not {ours}"
        )));
    }
    match pipe::process_image(pid) {
        Some(image) if !pipe::same_path(&image, &binary()) => {
            return Err(unreachable(format!(
                "the pipe's server runs {} rather than the service's {}",
                image.display(),
                binary().display()
            )));
        }
        Some(_) => {}
        // A SYSTEM process the user may not open cannot be asked: the owner check stands for it.
        None if !by_hand => {}
        None => {
            return Err(unreachable(format!(
                "the helper's image (process {pid}) is unknown"
            )));
        }
    }
    let secret = std::fs::read_to_string(home().join("secret"))
        .map_err(|e| unreachable(format!("the service's secret: {e}")))?;
    pipe.send(&ToAdmin::Hello {
        protocol: ADMIN_PROTOCOL,
        secret: secret.trim().to_owned(),
    })
    .map_err(unreachable)?;
    match pipe.recv::<FromAdmin>().map_err(unreachable)? {
        FromAdmin::Welcome { protocol, .. } if protocol == ADMIN_PROTOCOL => Ok(pipe),
        FromAdmin::Welcome { protocol, version } => Err(not_ran(
            reason::OUTDATED,
            format!(
                "The lock screen and admin prompts service on this computer ({version}) speaks administrator-run protocol {protocol} and this remoted {ADMIN_PROTOCOL}: set it up again {SET_UP}."
            ),
        )),
        FromAdmin::Refused { why } => Err(not_ran(
            reason::REFUSED,
            format!(
                "The lock screen and admin prompts service's helper refused this remoted: {why}."
            ),
        )),
        _ => Err(unreachable(
            "it answered something other than a welcome".into(),
        )),
    }
}

/// The run, from the checks to the exit code.
fn run(args: &wire::RunArgs) -> Result<u32, NotRan> {
    // A helper run by hand for a test (another home) has no service in the service manager.
    let by_hand = std::env::var_os("INTENTIC_REMOTED_SERVICE_HOME").is_some();
    let state = if by_hand {
        "run by hand"
    } else {
        let Some(state) = scm::query() else {
            return Err(not_ran(
                reason::NOT_INSTALLED,
                format!(
                    "The lock screen and admin prompts service, which runs commands as administrator, is not installed on this computer: set it up {SET_UP}."
                ),
            ));
        };
        if !Installed::read().is_some_and(|i| i.features.iter().any(|f| f == wire::FEATURE)) {
            return Err(not_ran(
                reason::OUTDATED,
                format!(
                    "The lock screen and admin prompts service on this computer was installed before it could run commands as administrator: set it up again {SET_UP}."
                ),
            ));
        }
        state
    };
    let session = pipe::process_session(std::process::id()).unwrap_or(0);
    let name = admin_pipe_name(session);
    if !listening(&name) {
        return Err(not_ran(
            reason::NOT_RUNNING,
            format!(
                "The lock screen and admin prompts service is {state}, but its helper is not listening in this session ({session}): it serves only the session on the computer's screen, and starts again within seconds after it ends."
            ),
        ));
    }
    let pipe = connect(&name, by_hand)?;
    // Where the run starts: the folder asked for, else this process's own, as any process started from here would.
    let cwd = args.cwd.clone().or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|d| d.to_string_lossy().into_owned())
    });
    let lost = |e: String| {
        not_ran(
            reason::LOST,
            format!(
                "The connection to the service's helper broke before the command ended ({e}); the command may have ended with it."
            ),
        )
    };
    pipe.send(&ToAdmin::Run {
        program: args.program.clone(),
        args: args.args.clone(),
        cwd,
        grant: args.grant.clone(),
    })
    .map_err(lost)?;
    let (mut stdout, mut stderr) = (std::io::stdout(), std::io::stderr());
    loop {
        match pipe.recv::<FromAdmin>().map_err(lost)? {
            FromAdmin::Out { stream, data } => {
                let Ok(bytes) = STANDARD.decode(data) else {
                    continue;
                };
                // A closed stdout or stderr here is no reason to stop the command.
                let _ = match stream {
                    Stream::Stdout => stdout.write_all(&bytes).and_then(|()| stdout.flush()),
                    Stream::Stderr => stderr.write_all(&bytes).and_then(|()| stderr.flush()),
                };
            }
            FromAdmin::Exited { code } => return Ok(code),
            FromAdmin::Failed { reason, why } => {
                return Err(NotRan { reason, error: why });
            }
            FromAdmin::Started { .. } | FromAdmin::Welcome { .. } | FromAdmin::Refused { .. } => {}
        }
    }
}

/// `intentic-remoted service admin-run --status <file> [--cwd <dir>] [--grant <envelope>] -- <program> [<arg>…]`: the
/// exit code (the command's, or 125 when it did not run), the status line written to `--status` first.
pub fn cli(args: &[String]) -> i32 {
    let args = match wire::parse_args(args) {
        Ok(args) => args,
        Err((status, why)) => {
            eprintln!(
                "intentic-remoted: {why}\nusage: intentic-remoted service admin-run --status <file> [--cwd <dir>] [--grant <envelope>] -- <program> [<arg>…]"
            );
            let Some(status) = status else {
                return 2;
            };
            wire::write_status(
                &status,
                &wire::status_not_ran(
                    reason::USAGE,
                    &format!("intentic-remoted service admin-run was called wrongly: {why}."),
                ),
            );
            return wire::NOT_RAN;
        }
    };
    match run(&args) {
        Ok(code) => {
            wire::write_status(&args.status, &wire::status_ran(code));
            // An NTSTATUS such as 0xC0000005 wraps into the i32 and back into the same u32 at exit.
            code as i32
        }
        Err(NotRan { reason, error }) => {
            eprintln!("intentic-remoted: not run as administrator: {error}");
            wire::write_status(&args.status, &wire::status_not_ran(&reason, &error));
            wire::NOT_RAN
        }
    }
}
