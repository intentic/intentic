//! Why this session's desktop can or cannot be captured right now: what Windows says about the session (locked, on the
//! computer's screen or disconnected, a Remote Desktop one), which desktop receives input, whether the display is on,
//! and how long nobody has touched the computer. Duplication answers `E_ACCESSDENIED` for several of these alike, so a
//! refusal is explained by asking, in the order [`State::blocked`] gives, rather than by the error alone.
//!
//! The display's state comes from `GUID_CONSOLE_DISPLAY_STATE`, a power-setting notification registered once per
//! process with a callback (no window needed); Windows sends the current state as it registers.

use serde::{Deserialize, Serialize};
use std::sync::Once;
use std::sync::atomic::{AtomicU8, Ordering};

/// What a desktop that cannot be captured is blocked by, most specific first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Blocked {
    /// This session is not the one on the computer's screen: another user's is, or this one was disconnected.
    NotOnScreen,
    /// The display is off (the computer was left idle, or it is in Modern Standby): Windows composes no picture.
    DisplayOff,
    /// A secure desktop takes input: the sign-in screen, a UAC prompt or Ctrl+Alt+Del. Only a process running as
    /// SYSTEM may see it.
    SecureDesktop,
    /// The session is locked (the lock screen shows).
    Locked,
    /// Refused with none of the above true: the person's own desktop showing, the display on, the session unlocked.
    Unknown,
}

impl Blocked {
    /// What a viewer is told, on the placeholder and in `/info`.
    pub fn words(self) -> &'static str {
        match self {
            Blocked::NotOnScreen => {
                "This Windows session is not the one on the computer's screen (another user is signed in at it, or this session was disconnected)"
            }
            Blocked::DisplayOff => {
                "The computer's display is off (it was left idle, or it is asleep): moving the mouse or pressing a key wakes it"
            }
            Blocked::SecureDesktop => {
                "Secure desktop (sign-in, lock screen, UAC or Ctrl+Alt+Del): not visible remotely without the lock screen and admin prompts service"
            }
            Blocked::Locked => "The computer is locked",
            Blocked::Unknown => "Windows refused to share the desktop picture right now",
        }
    }
}

/// The display's power state, as `GUID_CONSOLE_DISPLAY_STATE` last said.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Display {
    Off,
    On,
    Dimmed,
    Unknown,
}

static DISPLAY: AtomicU8 = AtomicU8::new(u8::MAX);
static WATCHING: Once = Once::new();

/// The display's state now. The first call registers the notification (Windows answers it with the current state at
/// once); `Unknown` until it has.
pub fn display() -> Display {
    watch_display();
    match DISPLAY.load(Ordering::Relaxed) {
        0 => Display::Off,
        1 => Display::On,
        2 => Display::Dimmed,
        _ => Display::Unknown,
    }
}

fn watch_display() {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Power::{
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, POWERBROADCAST_SETTING,
        PowerSettingRegisterNotification,
    };
    use windows::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
    use windows::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK;

    unsafe extern "system" fn changed(
        _context: *const core::ffi::c_void,
        _kind: u32,
        setting: *const core::ffi::c_void,
    ) -> u32 {
        // SAFETY: Windows hands a POWERBROADCAST_SETTING for the GUID registered, its data right after the header.
        unsafe {
            let s = setting.cast::<POWERBROADCAST_SETTING>();
            if !s.is_null() && (*s).DataLength >= 1 {
                DISPLAY.store((*s).Data[0], Ordering::Relaxed);
            }
        }
        0
    }

    WATCHING.call_once(|| {
        // Kept for the process's life: the registration reads it whenever the state changes.
        let params = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(changed),
            Context: std::ptr::null_mut(),
        }));
        let mut handle = std::ptr::null_mut::<core::ffi::c_void>();
        // SAFETY: the GUID, the callback flag with its parameters (leaked above), and an out-pointer for the handle.
        let r = unsafe {
            PowerSettingRegisterNotification(
                &GUID_CONSOLE_DISPLAY_STATE,
                DEVICE_NOTIFY_CALLBACK,
                HANDLE(std::ptr::from_mut(params).cast()),
                &mut handle,
            )
        };
        if r.0 != 0 {
            log::debug!(
                "the display's state is not watched (PowerSettingRegisterNotification: {})",
                r.0
            );
        }
    });
}

/// What Windows says about this process's session and the computer's screen now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// This process's session.
    pub session: u32,
    /// The session on the computer's screen (`WTSGetActiveConsoleSessionId`); `0xFFFFFFFF` while it changes.
    pub console: u32,
    /// A Remote Desktop session (duplication is not offered there; GDI serves).
    pub remote: bool,
    /// Whether this session is connected (not disconnected by a switch of user).
    pub connected: bool,
    /// Whether this session is locked; None where Windows would not say.
    pub locked: Option<bool>,
    /// The desktop receiving input (`Default`, `Winlogon`, `Screen-saver`); None when this process may not open it,
    /// which for a process that is not SYSTEM means a secure desktop.
    pub input_desktop: Option<String>,
    pub display: Display,
    /// Milliseconds since this session last had input.
    pub idle_ms: u64,
}

impl State {
    /// Asks Windows. Each call is a handful of cheap queries.
    pub fn now() -> State {
        use windows::Win32::System::RemoteDesktop::{
            ProcessIdToSessionId, WTSGetActiveConsoleSessionId,
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};
        let mut session = 0u32;
        // SAFETY: plain queries about this process, its session and the console.
        let console = unsafe {
            let _ = ProcessIdToSessionId(std::process::id(), &mut session);
            WTSGetActiveConsoleSessionId()
        };
        // SAFETY: a metric query.
        let remote = unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0;
        let (connected, locked) = session_info(session);
        State {
            session,
            console,
            remote,
            connected,
            locked,
            input_desktop: crate::input_desktop_name(),
            display: display(),
            idle_ms: idle_ms(),
        }
    }

    /// What blocks capture, given that duplication was refused. `secure_visible` is whether this process can see a
    /// secure desktop (it runs as SYSTEM), so a desktop other than `Default` does not block it.
    pub fn blocked(&self, secure_visible: bool) -> Blocked {
        if (self.console != u32::MAX && self.console != self.session && !self.remote)
            || !self.connected
        {
            return Blocked::NotOnScreen;
        }
        if self.display == Display::Off {
            return Blocked::DisplayOff;
        }
        let default = self
            .input_desktop
            .as_deref()
            .is_some_and(|d| d.eq_ignore_ascii_case("Default"));
        if !default && !secure_visible {
            return Blocked::SecureDesktop;
        }
        if self.locked == Some(true) && !secure_visible {
            return Blocked::Locked;
        }
        Blocked::Unknown
    }
}

/// Whether the session is connected, and whether it is locked (`WTSSessionInfoEx`; its lock flag reads backwards on
/// Windows 7 only, which cast-win does not run on).
fn session_info(session: u32) -> (bool, Option<bool>) {
    use windows::Win32::System::RemoteDesktop::{
        WTSDisconnected, WTSFreeMemory, WTSINFOEXW, WTSQuerySessionInformationW, WTSSessionInfoEx,
    };
    let mut buf = windows::core::PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: Windows allocates the answer, freed below; it is read only when it is at least a WTSINFOEXW.
    unsafe {
        if WTSQuerySessionInformationW(None, session, WTSSessionInfoEx, &mut buf, &mut bytes)
            .is_err()
            || buf.is_null()
        {
            return (true, None);
        }
        let out = if bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
            let info = &*buf.0.cast::<WTSINFOEXW>();
            if info.Level == 1 {
                let l1 = info.Data.WTSInfoExLevel1;
                let connected = l1.SessionState != WTSDisconnected;
                // WTS_SESSIONSTATE_LOCK = 0, WTS_SESSIONSTATE_UNLOCK = 1, WTS_SESSIONSTATE_UNKNOWN = -1.
                let locked = match l1.SessionFlags {
                    0 => Some(true),
                    1 => Some(false),
                    _ => None,
                };
                (connected, locked)
            } else {
                (true, None)
            }
        } else {
            (true, None)
        };
        WTSFreeMemory(buf.0.cast());
        out
    }
}

/// Milliseconds since the session's last input (keyboard or mouse, a viewer's included).
pub fn idle_ms() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut li = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: a sized struct to fill, and a tick count.
    unsafe {
        if !GetLastInputInfo(&mut li).as_bool() {
            return 0;
        }
        u64::from(GetTickCount().wrapping_sub(li.dwTime))
    }
}

/// How a screen's picture is being made now, and when it is not the desktop itself, why: what `/info` and `/stats`
/// report for each running screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    /// `dxgi` (desktop duplication), `helper` (duplication by the lock screen and admin prompts service), `gdi`, or
    /// `placeholder` (a picture saying why there is none).
    pub via: String,
    /// Why the picture is not duplicated, when it is not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<Blocked>,
    /// Those words, or another reason (a fallback's own).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The last error Windows gave.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Milliseconds since the Unix epoch at which this status began.
    pub since: u64,
}

impl CaptureStatus {
    pub fn new(via: &str) -> CaptureStatus {
        CaptureStatus {
            via: via.to_string(),
            blocked: None,
            reason: None,
            error: None,
            since: epoch_ms(),
        }
    }

    pub fn blocked(via: &str, blocked: Blocked, error: Option<String>) -> CaptureStatus {
        CaptureStatus {
            via: via.to_string(),
            blocked: Some(blocked),
            reason: Some(blocked.words().to_string()),
            error,
            since: epoch_ms(),
        }
    }

    /// Whether `other` says the same (so `since` is kept).
    pub fn same(&self, other: &CaptureStatus) -> bool {
        self.via == other.via && self.blocked == other.blocked && self.reason == other.reason
    }
}

/// A screen's status, shared between its capture (which writes it) and its owner (which reports it).
pub type StatusCell = std::sync::Arc<parking_lot::Mutex<CaptureStatus>>;

/// Sets `cell` to `next` unless it already says the same; logs a change.
pub fn report(cell: &StatusCell, name: &str, next: CaptureStatus) {
    let mut cur = cell.lock();
    if cur.same(&next) {
        if next.error.is_some() {
            cur.error = next.error;
        }
        return;
    }
    match &next.reason {
        Some(why) => log::info!("{name}: {} ({why})", next.via),
        None => log::info!("{name}: {}", next.via),
    }
    *cur = next;
}

pub fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        State {
            session: 1,
            console: 1,
            remote: false,
            connected: true,
            locked: Some(false),
            input_desktop: Some("Default".into()),
            display: Display::On,
            idle_ms: 0,
        }
    }

    #[test]
    fn a_refusal_is_explained_most_specific_first() {
        assert_eq!(state().blocked(false), Blocked::Unknown);
        let other = State {
            console: 2,
            ..state()
        };
        assert_eq!(other.blocked(false), Blocked::NotOnScreen);
        let off = State {
            display: Display::Off,
            locked: Some(true),
            ..state()
        };
        assert_eq!(off.blocked(false), Blocked::DisplayOff);
        let secure = State {
            input_desktop: None,
            locked: Some(true),
            ..state()
        };
        assert_eq!(secure.blocked(false), Blocked::SecureDesktop);
        // SYSTEM sees the secure desktop: that is not what blocks it.
        assert_eq!(secure.blocked(true), Blocked::Unknown);
        let locked = State {
            locked: Some(true),
            ..state()
        };
        assert_eq!(locked.blocked(false), Blocked::Locked);
        let gone = State {
            connected: false,
            ..state()
        };
        assert_eq!(gone.blocked(false), Blocked::NotOnScreen);
    }
}
