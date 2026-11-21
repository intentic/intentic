//! A local named pipe both ends read and write at once: overlapped I/O, so a thread blocked reading never holds back
//! another one writing (a handle opened for synchronous I/O serialises every call on it). Messages are a 4-byte
//! little-endian length and that many bytes of JSON.
//!
//! The server end is made with an access list (SDDL) and refuses remote clients; either end can ask who the other is
//! (its process id, that process's image path and session), which is how the helper and remoted check each other.

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::path::PathBuf;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
    HLOCAL, LocalFree,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_SHARE_NONE,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    WriteFile,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_WAIT, WaitNamedPipeW,
};
use windows::Win32::System::Threading::CreateEventW;
use windows::core::PCWSTR;

/// The largest message either end accepts: a pointer shape's PNG is the biggest thing sent.
const MAX_MESSAGE: usize = 4 << 20;

pub struct Pipe {
    handle: HANDLE,
    server: bool,
    /// One message written at a time, whichever thread sends it.
    sending: parking_lot::Mutex<()>,
}

// SAFETY: a pipe handle opened for overlapped I/O; every call carries its own OVERLAPPED and event.
unsafe impl Send for Pipe {}
unsafe impl Sync for Pipe {}

impl Pipe {
    /// A server instance of `name` (`\\.\pipe\…`) whose access list is `sddl`. `first`: fail if the name is already
    /// taken (another process squatting it), as only the first instance may ask.
    pub fn create(name: &str, sddl: &str, first: bool) -> Result<Pipe, String> {
        let wide_sddl = crate::displays::wide(sddl);
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: a zero-terminated SDDL string and an out-pointer, freed below with LocalFree.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(wide_sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
        }
        .map_err(|e| format!("the pipe's access list {sddl:?}: {e}"))?;
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: false.into(),
        };
        let wide_name = crate::displays::wide(name);
        let mut open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
        if first {
            open |= FILE_FLAG_FIRST_PIPE_INSTANCE;
        }
        // SAFETY: a name, modes, sizes and the security attributes made above.
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide_name.as_ptr()),
                open,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                255,
                1 << 16,
                1 << 16,
                0,
                Some(&sa),
            )
        };
        // SAFETY: the descriptor ConvertString… allocated.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(sd.0)));
        }
        if handle.is_invalid() {
            return Err(format!("CreateNamedPipe {name}: {}", std::io::Error::last_os_error()));
        }
        Ok(Pipe {
            handle,
            server: true,
            sending: parking_lot::Mutex::new(()),
        })
    }

    /// Waits for a client on this server instance.
    pub fn accept(&self) -> Result<(), String> {
        // A client that connected between the create and this call is ERROR_PIPE_CONNECTED: connected.
        self.overlapped(
            // SAFETY: this server instance and the call's OVERLAPPED.
            |ov| unsafe { ConnectNamedPipe(self.handle, Some(ov)) },
            Some(ERROR_PIPE_CONNECTED.to_hresult()),
        )
        .map(|_| ())
    }

    /// The client end of `name`, waiting up to `wait_ms` for an instance to be free.
    pub fn open(name: &str, wait_ms: u32) -> Result<Pipe, String> {
        let wide = crate::displays::wide(name);
        // SAFETY: a zero-terminated name.
        if wait_ms > 0 && !unsafe { WaitNamedPipeW(PCWSTR(wide.as_ptr()), wait_ms) }.as_bool() {
            return Err(format!("{name}: {}", std::io::Error::last_os_error()));
        }
        // SAFETY: a zero-terminated name; identification-level impersonation only, so the server learns who called but
        // cannot act as this process.
        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                None,
            )
        }
        .map_err(|e| format!("{name}: {e}"))?;
        Ok(Pipe {
            handle,
            server: false,
            sending: parking_lot::Mutex::new(()),
        })
    }

    /// Whether a server instance of `name` exists now (nothing is opened).
    pub fn exists(name: &str) -> bool {
        let wide = crate::displays::wide(name);
        // SAFETY: a zero-terminated name; a wait of 1 ms answers at once either way.
        unsafe { WaitNamedPipeW(PCWSTR(wide.as_ptr()), 1) }.as_bool()
    }

    /// The process at the other end.
    pub fn peer_pid(&self) -> Option<u32> {
        let mut pid = 0u32;
        // SAFETY: a connected pipe and an out-pointer.
        let r = unsafe {
            if self.server {
                GetNamedPipeClientProcessId(self.handle, &mut pid)
            } else {
                GetNamedPipeServerProcessId(self.handle, &mut pid)
            }
        };
        r.ok().map(|()| pid)
    }

    /// The SID (`S-1-5-18` for SYSTEM) that owns the pipe: who created its server end. A process cannot make an object
    /// owned by another account, so a pipe owned by SYSTEM was made by SYSTEM.
    pub fn owner_sid(&self) -> Option<String> {
        use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, GetSecurityInfo, SE_KERNEL_OBJECT};
        use windows::Win32::Security::{OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID};
        let mut owner = PSID::default();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: this pipe's handle and out-pointers; the descriptor holding the owner is freed below.
        unsafe {
            let r = GetSecurityInfo(
                self.handle,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION,
                Some(&mut owner),
                None,
                None,
                None,
                Some(&mut sd),
            );
            if r.0 != 0 {
                return None;
            }
            let mut text = windows::core::PWSTR::null();
            let out = ConvertSidToStringSidW(owner, &mut text).ok().and_then(|()| text.to_string().ok());
            if !text.is_null() {
                let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            }
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            out
        }
    }

    /// Ends whatever reads or writes on this pipe now, from another thread: they return errors.
    pub fn cancel(&self) {
        // SAFETY: cancels this handle's pending I/O, from any thread.
        unsafe {
            let _ = CancelIoEx(self.handle, None);
        }
    }

    fn write_all(&self, mut buf: &[u8]) -> Result<(), String> {
        while !buf.is_empty() {
            // SAFETY: the rest of the buffer, alive until the write completes (the call waits for it).
            let n = self.overlapped(|ov| unsafe { WriteFile(self.handle, Some(buf), None, Some(ov)) }, None)?;
            if n == 0 {
                return Err("the pipe took nothing".into());
            }
            buf = &buf[n as usize..];
        }
        Ok(())
    }

    fn read_exact(&self, buf: &mut [u8]) -> Result<(), String> {
        let mut at = 0;
        while at < buf.len() {
            let rest = &mut buf[at..];
            // SAFETY: the rest of the buffer, alive until the read completes (the call waits for it).
            let n = self.overlapped(|ov| unsafe { ReadFile(self.handle, Some(rest), None, Some(ov)) }, None)?;
            if n == 0 {
                return Err("the pipe closed".into());
            }
            at += n as usize;
        }
        Ok(())
    }

    /// Sends one message.
    pub fn send<T: Serialize>(&self, message: &T) -> Result<(), String> {
        let body = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        let mut framed = Vec::with_capacity(body.len() + 4);
        framed.extend_from_slice(&(body.len() as u32).to_le_bytes());
        framed.extend_from_slice(&body);
        let _one = self.sending.lock();
        self.write_all(&framed)
    }

    /// Waits for one message.
    pub fn recv<T: DeserializeOwned>(&self) -> Result<T, String> {
        let mut len = [0u8; 4];
        self.read_exact(&mut len)?;
        let len = u32::from_le_bytes(len) as usize;
        if len > MAX_MESSAGE {
            return Err(format!("a message of {len} bytes is too large"));
        }
        let mut body = vec![0u8; len];
        self.read_exact(&mut body)?;
        serde_json::from_slice(&body).map_err(|e| format!("a message that does not parse: {e}"))
    }

    /// Runs one overlapped call and waits for it: the bytes it moved. `done`: an error that means the call already
    /// succeeded.
    fn overlapped(
        &self,
        call: impl FnOnce(*mut OVERLAPPED) -> windows::core::Result<()>,
        done: Option<windows::core::HRESULT>,
    ) -> Result<u32, String> {
        // SAFETY: a manual-reset event for this call alone, closed below.
        let event = unsafe { CreateEventW(None, true, false, None) }.map_err(|e| e.to_string())?;
        let mut ov = OVERLAPPED {
            hEvent: event,
            ..Default::default()
        };
        let started = call(&mut ov);
        let result = match started {
            Err(e) if Some(e.code()) == done => Ok(0),
            Err(e) if e.code() != ERROR_IO_PENDING.to_hresult() => Err(format!("{e} ({:?})", e.code().0 & 0xFFFF)),
            _ => {
                let mut n = 0u32;
                // SAFETY: the OVERLAPPED the call was given, alive until it completes (this waits for it).
                unsafe { GetOverlappedResult(self.handle, &ov, &mut n, true) }
                    .map(|()| n)
                    .map_err(|e| format!("{e} ({:?})", e.code().0 & 0xFFFF))
            }
        };
        // SAFETY: the event made above.
        unsafe {
            let _ = CloseHandle(event);
        }
        result
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        // SAFETY: this pipe's own handle.
        unsafe {
            if self.server {
                let _ = DisconnectNamedPipe(self.handle);
            }
            let _ = CloseHandle(self.handle);
        }
    }
}

/// A process's image path (`QueryFullProcessImageNameW`, which a process may ask about almost any other).
pub fn process_image(pid: u32) -> Option<PathBuf> {
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    // SAFETY: a process handle closed below, and a buffer of its stated size.
    unsafe {
        let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(p);
        r.ok()?;
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

/// A process's session.
pub fn process_session(pid: u32) -> Option<u32> {
    let mut session = 0u32;
    // SAFETY: a plain query.
    unsafe { windows::Win32::System::RemoteDesktop::ProcessIdToSessionId(pid, &mut session) }.ok()?;
    Some(session)
}

/// Whether two paths name the same file as Windows compares them: case-insensitively, `/` and `\` alike.
pub fn same_path(a: &std::path::Path, b: &std::path::Path) -> bool {
    let norm = |p: &std::path::Path| {
        p.to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .to_lowercase()
    };
    norm(a) == norm(b)
}
