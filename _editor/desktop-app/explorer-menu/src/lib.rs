/* "OPEN WITH INTENTIC" IN WINDOWS 11'S CONTEXT MENU (README.md has the whole story).
 *
 * One DLL, two jobs:
 *   - com.rs: the menu entry itself, an IExplorerCommand that Explorer asks for its title and icon and tells when it is
 *     picked. Loaded by Explorer's COM surrogate (dllhost.exe), never into Explorer.
 *   - register.rs: DllInstall, which the installer calls through regsvr32 to give this DLL the package identity
 *     Windows 11 requires of a menu entry, and to take it away again (TrustSignerW is its one elevated step).
 *
 * Windows only; on any other target this crate is empty, so a workspace-wide `cargo check` on Linux passes over it. */
#![cfg_attr(not(windows), allow(unused))]

#[cfg(windows)]
mod com;
#[cfg(windows)]
mod register;

#[cfg(windows)]
mod exports {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicPtr, Ordering};

    use windows::Win32::Foundation::{HINSTANCE, HWND, S_FALSE, S_OK};
    use windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
    use windows::Win32::System::Threading::ExitProcess;
    use windows_core::{BOOL, GUID, HRESULT, PCWSTR};

    /// This DLL's own module handle, for finding the folder it was installed into (and the app beside it).
    pub static MODULE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    #[no_mangle]
    extern "system" fn DllMain(module: HINSTANCE, reason: u32, _reserved: *mut c_void) -> BOOL {
        if reason == DLL_PROCESS_ATTACH {
            MODULE.store(module.0, Ordering::SeqCst);
        }
        true.into()
    }

    #[no_mangle]
    unsafe extern "system" fn DllGetClassObject(
        clsid: *const GUID,
        iid: *const GUID,
        out: *mut *mut c_void,
    ) -> HRESULT {
        crate::com::class_object(clsid, iid, out)
    }

    #[no_mangle]
    extern "system" fn DllCanUnloadNow() -> HRESULT {
        if crate::com::in_use() {
            S_FALSE
        } else {
            S_OK
        }
    }

    /// `regsvr32 dll` by hand: register, prompting if it must.
    #[no_mangle]
    extern "system" fn DllRegisterServer() -> HRESULT {
        crate::register::logged("register", || crate::register::register(false))
    }

    #[no_mangle]
    extern "system" fn DllUnregisterServer() -> HRESULT {
        crate::register::logged("unregister", crate::register::unregister)
    }

    /// What the installer calls (installer-hooks.nsh): `regsvr32 /s /n /i:<mode> dll` to register, `/u` added to
    /// unregister. `quiet` never prompts; `interactive` may show the one UAC prompt signing on this PC needs.
    #[no_mangle]
    unsafe extern "system" fn DllInstall(install: BOOL, command_line: PCWSTR) -> HRESULT {
        let mode = if command_line.is_null() {
            String::new()
        } else {
            command_line.to_string().unwrap_or_default()
        };
        if !install.as_bool() {
            return crate::register::logged("unregister", crate::register::unregister);
        }
        let quiet = mode.trim() != "interactive";
        crate::register::logged(
            if quiet {
                "register (quiet)"
            } else {
                "register"
            },
            move || crate::register::register(quiet),
        )
    }

    /// The elevated step, as `rundll32 dll,TrustSigner <certificate file>` behind a UAC prompt (register.rs
    /// `trust_signer`). Its exit code is the answer the unelevated half waits for.
    #[no_mangle]
    unsafe extern "system" fn TrustSignerW(
        _window: HWND,
        _instance: HINSTANCE,
        command_line: PCWSTR,
        _show: i32,
    ) {
        let path = if command_line.is_null() {
            String::new()
        } else {
            command_line.to_string().unwrap_or_default()
        };
        let outcome = crate::register::trust_signer(&path);
        match &outcome {
            Ok(said) => crate::register::log(&format!("trust (elevated): {said}")),
            Err(said) => crate::register::log(&format!("trust (elevated) failed: {said}")),
        }
        ExitProcess(if outcome.is_ok() { 0 } else { 1 });
    }
}

#[cfg(windows)]
pub(crate) use exports::MODULE;
