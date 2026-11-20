//! cast-win: the Windows platform for cast-core. Empty on any other target.
//!
//! - [`capture`]: DXGI Desktop Duplication of one monitor, frames kept on the GPU for a hardware encoder or read back
//!   for a software one; [`gdi`] where duplication is not offered.
//! - [`nvenc`]: NVIDIA's encoder on D3D11 reading the captured textures in place; [`mft`]: Media Foundation's hardware
//!   H.264 encoders (Intel Quick Sync, AMD, NVIDIA's own) the same way; openh264 (cast-core) in software.
//! - [`select`]: which of them a monitor is encoded with, each proven by a self-test first.
//! - [`input`]: SendInput; [`clipboard`]: the clipboard both ways; [`audio`]: WASAPI loopback.
#![cfg(windows)]

pub mod audio;
pub mod capture;
pub mod clipboard;
pub mod cursor;
pub mod d3d;
pub mod displays;
pub mod gdi;
pub mod input;
pub mod mft;
pub mod nvenc;
pub mod placeholder;
pub mod screen;
pub mod select;

/// Makes the process per-monitor DPI aware (v2), so every coordinate (DXGI's desktop, the cursor, SendInput's virtual
/// desktop) is in physical pixels, and `DuplicateOutput1` is allowed. Call it before anything opens a window or asks
/// for a coordinate; later calls change nothing.
pub fn init_process() {
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
    };
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: a process-wide flag.
        if let Err(e) =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
        {
            log::warn!(
                "not per-monitor DPI aware ({e}): a scaled monitor's coordinates may be off"
            );
        }
    });
}

/// Puts this thread on the desktop that receives input (a lock screen or a UAC prompt), where it may: only a process
/// running as SYSTEM can open those, so for a person's own process this changes nothing.
pub fn follow_input_desktop() {
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, OpenInputDesktop,
        SetThreadDesktop,
    };
    // GENERIC_ALL
    let access = DESKTOP_ACCESS_FLAGS(0x1000_0000);
    // SAFETY: a desktop handle that is closed again when it cannot be used.
    if let Ok(d) = unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, access) }
        && unsafe { SetThreadDesktop(d) }.is_err()
    {
        let _ = unsafe { CloseDesktop(d) };
    }
}

/// Whether the desktop receiving input is the person's own (`Default`): false on a secure desktop (a lock screen's
/// sign-in, a UAC prompt, Ctrl+Alt+Del), which a process that is not SYSTEM cannot open at all.
pub fn input_desktop_is_default() -> bool {
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetUserObjectInformationW,
        OpenInputDesktop, UOI_NAME,
    };
    // SAFETY: a desktop handle closed below, and a name buffer of its stated size.
    unsafe {
        let Ok(d) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else {
            return false;
        };
        let mut name = [0u16; 64];
        let mut need = 0u32;
        let ok = GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(d.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            std::mem::size_of_val(&name) as u32,
            Some(&mut need),
        )
        .is_ok();
        let _ = CloseDesktop(d);
        ok && displays::from_wide(&name).eq_ignore_ascii_case("Default")
    }
}

/// Keeps the display (and the computer) awake for as long as the calling thread lives: a capture's thread calls it, so
/// a screen someone is watching does not go dark under them (Windows stops composing a display it turned off, and
/// duplication is then refused). The request ends with the thread; nothing is changed in the power settings.
pub fn keep_display_on() {
    use windows::Win32::System::Power::{
        ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
    };
    // SAFETY: a flag on this thread's own execution state.
    unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED) };
}
