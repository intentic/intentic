//! The service manager's side: installing, removing and asking about the service, and the service's own entry point.

use super::{DESCRIPTION, DISPLAY_NAME, Installed, SERVICE, binary, home, secure};
use parking_lot::{Condvar, Mutex};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{ERROR_CALL_NOT_IMPLEMENTED, ERROR_SERVICE_DOES_NOT_EXIST, NO_ERROR};
use windows::Win32::System::Services::{
    ChangeServiceConfig2W, ChangeServiceConfigW, CloseServiceHandle, ControlService, CreateServiceW, DeleteService,
    ENUM_SERVICE_TYPE, OpenSCManagerW, OpenServiceW, QueryServiceStatusEx, RegisterServiceCtrlHandlerExW,
    SC_ACTION, SC_ACTION_RESTART, SC_HANDLE, SC_MANAGER_ALL_ACCESS, SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO,
    SERVICE_ACCEPT_SESSIONCHANGE, SERVICE_ACCEPT_SHUTDOWN, SERVICE_ACCEPT_STOP, SERVICE_ALL_ACCESS,
    SERVICE_AUTO_START, SERVICE_CONFIG_DESCRIPTION, SERVICE_CONFIG_FAILURE_ACTIONS, SERVICE_CONTROL_INTERROGATE,
    SERVICE_CONTROL_SESSIONCHANGE, SERVICE_CONTROL_SHUTDOWN, SERVICE_CONTROL_STOP, SERVICE_DESCRIPTIONW,
    SERVICE_ERROR_NORMAL, SERVICE_FAILURE_ACTIONSW, SERVICE_NO_CHANGE, SERVICE_QUERY_STATUS, SERVICE_RUNNING,
    SERVICE_START_PENDING, SERVICE_STATUS, SERVICE_STATUS_CURRENT_STATE, SERVICE_STATUS_HANDLE,
    SERVICE_STATUS_PROCESS, SERVICE_STOP_PENDING, SERVICE_STOPPED, SERVICE_TABLE_ENTRYW, SERVICE_WIN32_OWN_PROCESS,
    SetServiceStatus, StartServiceCtrlDispatcherW, StartServiceW,
};
use windows::core::{PCWSTR, PWSTR};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A service-manager handle, closed when dropped.
struct Sc(SC_HANDLE);

impl Drop for Sc {
    fn drop(&mut self) {
        // SAFETY: a handle this process opened.
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

fn manager(access: u32) -> Result<Sc, String> {
    // SAFETY: the local service manager.
    unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), access) }
        .map(Sc)
        .map_err(|e| format!("the service manager: {e}"))
}

fn service(manager: &Sc, access: u32) -> windows::core::Result<Sc> {
    let name = wide(SERVICE);
    // SAFETY: an open manager and a zero-terminated name.
    unsafe { OpenServiceW(manager.0, PCWSTR(name.as_ptr()), access) }.map(Sc)
}

fn process_status(service: &Sc) -> Option<SERVICE_STATUS_PROCESS> {
    let mut buf = vec![0u8; std::mem::size_of::<SERVICE_STATUS_PROCESS>()];
    let mut need = 0u32;
    // SAFETY: a buffer the size of the struct asked for.
    unsafe { QueryServiceStatusEx(service.0, SC_STATUS_PROCESS_INFO, Some(&mut buf), &mut need) }.ok()?;
    // SAFETY: the buffer holds one SERVICE_STATUS_PROCESS, read unaligned.
    Some(unsafe { std::ptr::read_unaligned(buf.as_ptr().cast::<SERVICE_STATUS_PROCESS>()) })
}

fn state_word(state: SERVICE_STATUS_CURRENT_STATE) -> &'static str {
    match state {
        SERVICE_RUNNING => "running",
        SERVICE_STOPPED => "stopped",
        SERVICE_START_PENDING => "starting",
        SERVICE_STOP_PENDING => "stopping",
        _ => "other",
    }
}

/// The service's state (`running`, `stopped`, `starting`, `stopping`), or None when it is not installed.
pub fn query() -> Option<&'static str> {
    let m = manager(SC_MANAGER_CONNECT).ok()?;
    let s = service(&m, SERVICE_QUERY_STATUS).ok()?;
    Some(process_status(&s).map_or("other", |p| state_word(p.dwCurrentState)))
}

/// Stops the service if it runs, waiting up to 15 s for it to end (and so let go of its binary).
fn stop(s: &Sc) {
    let mut status = SERVICE_STATUS::default();
    // SAFETY: an open service and a status to fill.
    let _ = unsafe { ControlService(s.0, SERVICE_CONTROL_STOP, &mut status) };
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match process_status(s) {
            Some(p) if p.dwCurrentState != SERVICE_STOPPED => std::thread::sleep(Duration::from_millis(200)),
            _ => return,
        }
    }
}

/// Copies `from` over `to`, a few times while the old binary is still held by a process that is ending.
fn copy_binary(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    let mut last = String::new();
    for _ in 0..25 {
        match std::fs::copy(from, to) {
            Ok(_) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("copying {} to {}: {last}", from.display(), to.display()))
}

/// Installs (or updates) the service and starts it. Needs an administrator.
pub fn install(clients: &[PathBuf]) -> Result<(), String> {
    for c in clients {
        if !c.is_file() {
            return Err(format!("no remoted at {}", c.display()));
        }
    }
    let user_sid = secure::owner_sid(&clients[0])?;
    let m = manager(SC_MANAGER_ALL_ACCESS)?;
    let existing = service(&m, SERVICE_ALL_ACCESS).ok();
    if let Some(s) = &existing {
        stop(s);
    }
    let home = home();
    std::fs::create_dir_all(home.join("bin")).map_err(|e| format!("{}: {e}", home.display()))?;
    // SYSTEM and administrators may change it; everyone else may read and run it, never write.
    secure::set_acl(&home, "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)")?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    if !crate::service::windows::finder::same_file(&me, &binary()) {
        copy_binary(&me, &binary())?;
    }
    // Ctrl+Alt+Del from a service needs SoftwareSASGeneration to name services; what it was is kept for uninstall (a
    // re-install keeps the first install's record).
    let previous = Installed::read();
    let (before, set) = match previous.as_ref().filter(|p| p.sas_policy_set) {
        Some(p) => (p.sas_policy_before, true),
        None => {
            let before = secure::sas_policy();
            let set = !secure::sas_allows_services(before);
            if set {
                secure::set_sas_policy(Some(1))?;
            }
            (before, set)
        }
    };
    let installed = Installed {
        version: crate::VERSION.to_string(),
        clients: clients.to_vec(),
        user_sid,
        sas_policy_before: before,
        sas_policy_set: set,
    };
    std::fs::write(
        home.join("service.json"),
        serde_json::to_string_pretty(&installed).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("service.json: {e}"))?;
    let command = wide(&format!("\"{}\" service run", binary().display()));
    let s = match existing {
        Some(s) => {
            // SAFETY: an open service and zero-terminated strings; null leaves a setting as it is.
            unsafe {
                ChangeServiceConfigW(
                    s.0,
                    ENUM_SERVICE_TYPE(SERVICE_NO_CHANGE),
                    SERVICE_AUTO_START,
                    windows::Win32::System::Services::SERVICE_ERROR(SERVICE_NO_CHANGE),
                    PCWSTR(command.as_ptr()),
                    PCWSTR::null(),
                    None,
                    PCWSTR::null(),
                    PCWSTR::null(),
                    PCWSTR::null(),
                    PCWSTR::null(),
                )
            }
            .map_err(|e| format!("updating the service: {e}"))?;
            s
        }
        None => {
            let (name, display) = (wide(SERVICE), wide(DISPLAY_NAME));
            // SAFETY: an open manager and zero-terminated strings; no account names LocalSystem.
            unsafe {
                CreateServiceW(
                    m.0,
                    PCWSTR(name.as_ptr()),
                    PCWSTR(display.as_ptr()),
                    SERVICE_ALL_ACCESS,
                    SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_AUTO_START,
                    SERVICE_ERROR_NORMAL,
                    PCWSTR(command.as_ptr()),
                    PCWSTR::null(),
                    None,
                    PCWSTR::null(),
                    PCWSTR::null(),
                    PCWSTR::null(),
                )
            }
            .map(Sc)
            .map_err(|e| format!("creating the service: {e}"))?
        }
    };
    let mut description = wide(DESCRIPTION);
    let desc = SERVICE_DESCRIPTIONW {
        lpDescription: PWSTR(description.as_mut_ptr()),
    };
    // Restarted 5 s after a crash, the count reset after a day.
    let mut actions = [
        SC_ACTION {
            Type: SC_ACTION_RESTART,
            Delay: 5_000,
        },
        SC_ACTION {
            Type: SC_ACTION_RESTART,
            Delay: 5_000,
        },
        SC_ACTION {
            Type: SC_ACTION_RESTART,
            Delay: 30_000,
        },
    ];
    let failure = SERVICE_FAILURE_ACTIONSW {
        dwResetPeriod: 86_400,
        lpRebootMsg: PWSTR::null(),
        lpCommand: PWSTR::null(),
        cActions: actions.len() as u32,
        lpsaActions: actions.as_mut_ptr(),
    };
    // SAFETY: an open service and structs that outlive the calls.
    unsafe {
        let _ = ChangeServiceConfig2W(s.0, SERVICE_CONFIG_DESCRIPTION, Some(std::ptr::from_ref(&desc).cast()));
        let _ = ChangeServiceConfig2W(s.0, SERVICE_CONFIG_FAILURE_ACTIONS, Some(std::ptr::from_ref(&failure).cast()));
    }
    // SAFETY: an open service, no arguments.
    unsafe { StartServiceW(s.0, None) }.map_err(|e| format!("starting the service: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if process_status(&s).is_some_and(|p| p.dwCurrentState == SERVICE_RUNNING) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("the service did not start within 15 s".into())
}

/// Stops and removes the service, restores the Ctrl+Alt+Del policy and deletes its folder. Needs an administrator.
pub fn uninstall() -> Result<(), String> {
    let m = manager(SC_MANAGER_ALL_ACCESS)?;
    match service(&m, SERVICE_ALL_ACCESS) {
        Ok(s) => {
            stop(&s);
            // SAFETY: an open service.
            unsafe { DeleteService(s.0) }.map_err(|e| format!("removing the service: {e}"))?;
        }
        Err(e) if e.code() == ERROR_SERVICE_DOES_NOT_EXIST.to_hresult() => {}
        Err(e) => return Err(format!("the service: {e}")),
    }
    if let Some(installed) = Installed::read()
        && installed.sas_policy_set
    {
        secure::set_sas_policy(installed.sas_policy_before)?;
    }
    let home = home();
    let mut last = None;
    for _ in 0..25 {
        match std::fs::remove_dir_all(&home) {
            Ok(()) => {
                last = None;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                last = None;
                break;
            }
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if let Some(e) = last {
        return Err(format!("removing {}: {e}", home.display()));
    }
    // An empty Intentic folder this install made goes too; one holding the keyring's or anything else stays.
    if let Some(parent) = home.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

/// The service's status handle, as a number (the handle type is not Send).
/// The service removing itself, as the person's remoted asked through the helper: marked for deletion (the service
/// manager removes it once it stopped), the Ctrl+Alt+Del policy restored, and its folder deleted by a `cmd` started to
/// outlive it (a running program cannot delete its own file).
pub fn remove_self() {
    match manager(SC_MANAGER_ALL_ACCESS).and_then(|m| service(&m, SERVICE_ALL_ACCESS).map_err(|e| e.to_string())) {
        // SAFETY: this service's own handle.
        Ok(s) => match unsafe { DeleteService(s.0) } {
            Ok(()) => log::info!("the service is marked for removal"),
            Err(e) => log::warn!("removing the service: {e}"),
        },
        Err(e) => log::warn!("removing the service: {e}"),
    }
    if let Some(installed) = Installed::read()
        && installed.sas_policy_set
        && let Err(e) = secure::set_sas_policy(installed.sas_policy_before)
    {
        log::warn!("restoring SoftwareSASGeneration: {e}");
    }
    let home = home();
    let parent = home.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
    // Waits out this process's end, removes the folder, then the Intentic folder above it if nothing else is there.
    let script = format!(
        "ping -n 4 127.0.0.1 >nul & rmdir /s /q \"{}\" & rmdir \"{}\" 2>nul",
        home.display(),
        parent.display()
    );
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let started = std::process::Command::new("cmd.exe")
        .arg("/c")
        .raw_arg(&script)
        .current_dir(std::env::temp_dir())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn();
    if let Err(e) = started {
        log::warn!("the folder is left behind: {e}");
    }
    log::info!("removed at the person's remoted's request");
}

static STATUS: OnceLock<isize> = OnceLock::new();
static STOPPING: AtomicBool = AtomicBool::new(false);
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn report(state: SERVICE_STATUS_CURRENT_STATE, exit: u32) {
    let Some(handle) = STATUS.get() else {
        return;
    };
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN | SERVICE_ACCEPT_SESSIONCHANGE
        } else {
            0
        },
        dwWin32ExitCode: exit,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: if state == SERVICE_RUNNING || state == SERVICE_STOPPED { 0 } else { 10_000 },
    };
    // SAFETY: the handle the service manager gave this service.
    unsafe {
        let _ = SetServiceStatus(SERVICE_STATUS_HANDLE(*handle as *mut _), &status);
    }
}

/// Wakes the supervisor (a stop, or the console moving to another session).
pub fn wake() {
    *WAKE.0.lock() = true;
    WAKE.1.notify_all();
}

/// Waits up to `limit` for a wake.
pub fn sleep(limit: Duration) {
    let mut woken = WAKE.0.lock();
    if !*woken {
        WAKE.1.wait_for(&mut woken, limit);
    }
    *woken = false;
}

pub fn stopping() -> bool {
    STOPPING.load(Ordering::Relaxed)
}

unsafe extern "system" fn handler(
    control: u32,
    _event: u32,
    _data: *mut core::ffi::c_void,
    _context: *mut core::ffi::c_void,
) -> u32 {
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            STOPPING.store(true, Ordering::Relaxed);
            report(SERVICE_STOP_PENDING, 0);
            wake();
            NO_ERROR.0
        }
        SERVICE_CONTROL_SESSIONCHANGE => {
            wake();
            NO_ERROR.0
        }
        SERVICE_CONTROL_INTERROGATE => NO_ERROR.0,
        _ => ERROR_CALL_NOT_IMPLEMENTED.0,
    }
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut PWSTR) {
    let name = wide(SERVICE);
    // SAFETY: the service's name and the handler above, which lives for the process.
    let Ok(handle) = (unsafe { RegisterServiceCtrlHandlerExW(PCWSTR(name.as_ptr()), Some(handler), None) }) else {
        return;
    };
    let _ = STATUS.set(handle.0 as isize);
    report(SERVICE_START_PENDING, 0);
    let code = match super::launch::prepare() {
        Ok(prepared) => {
            report(SERVICE_RUNNING, 0);
            super::launch::supervise(&prepared);
            0
        }
        Err(e) => {
            log::error!("the service could not start: {e}");
            1
        }
    };
    report(SERVICE_STOPPED, code);
}

/// `service run`: hands this process to the service manager, which calls `service_main`.
pub fn run() -> i32 {
    let mut name = wide(SERVICE);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: PWSTR(name.as_mut_ptr()),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    // SAFETY: a table ending in a null entry, alive until the dispatcher returns (when the service stopped).
    match unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("intentic-remoted: `service run` is for the service manager to start ({e})");
            1
        }
    }
}
