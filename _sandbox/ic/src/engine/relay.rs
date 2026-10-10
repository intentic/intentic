//! THE ENGINE ON A NAMED PIPE (2026-10-10): `ic engine relay`, and how `ic engine start` keeps one running.
//!
//! Every docker CLI on Windows reads TCP slowly, whichever engine is behind it (docker-host/src/engine_pipe.rs has the
//! measurements: 36–40 MB/s over TCP, 284–286 MB/s over a pipe, Docker Desktop's own 140). Docker Desktop's CLI talks to
//! a named pipe; ours talked to the engine's TLS endpoint. This relay gives our engine a pipe too:
//!
//! - one pipe per distro and Windows account (`\\.\pipe\<distro>.<user>`), message mode as Docker's own pipes are (a
//!   client's half-close is a zero-length message), remote clients refused, and only this account and SYSTEM let in;
//! - each connection is carried to the engine's TLS endpoint with the account's client certificate, so the engine's own
//!   API stays TLS-only and the pipe adds no way in that the certificate did not already give;
//! - a connection is opened to the engine only once its client says something, so a probe that opens and closes the
//!   pipe costs nothing;
//! - it runs from a copy of ic named by its hash (`~/.intentic/engine/relay/ic-<hash>.exe`), never from the ic that the
//!   machine agent and the setup scripts replace, and a newer ic's start hands over to a newer copy: the copy named in
//!   `relay/current` is the one that serves, and one that finds another named there stops taking connections and ends
//!   when its own are done;
//! - `ic engine stop`, `hold` and `remove` end it by emptying that file.
//!
//! The pipe is a speed-up, never a dependency: `engine.json` names it (`pipe`), and every client uses it only while it
//! is there (`intentic_docker_host::engine_pipe::choose`), the TLS endpoint otherwise.

use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intentic_docker_host::engine_pipe;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::{ClientConfig, ClientConnection, RootCertStore};

use super::paths;
use super::record::EngineRecord;

/// How often a relay looks whether it is still the one named in `relay/current`.
const LOOK_EVERY_MS: u32 = 5_000;
/// How long a newer relay waits for an older one to let go of the pipe.
const HANDOVER: Duration = Duration::from_secs(20);
/// How long a relay that has been replaced waits for its own connections before it ends anyway.
const DRAIN: Duration = Duration::from_secs(600);
/// Each direction's buffer, and the pipe's own buffers (advisory to Windows).
const CHUNK: usize = 256 * 1024;
const PIPE_BUFFER: u32 = 1 << 20;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Where the relay lives, and who serves.                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

fn relay_dir() -> Option<PathBuf> {
    paths::home().map(|home| home.join(".intentic").join("engine").join("relay"))
}

fn current_path() -> Option<PathBuf> {
    relay_dir().map(|dir| dir.join("current"))
}

/// The copy of ic named as the one that serves, if any.
fn current() -> Option<String> {
    let text = std::fs::read_to_string(current_path()?).ok()?;
    let name = text.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn set_current(name: &str) -> Result<(), String> {
    let path = current_path().ok_or("could not find this account's home folder.")?;
    if let Some(dir) = path.parent() {
        paths::ensure_dir(dir)?;
    }
    std::fs::write(&path, name).map_err(|error| format!("{}: {error}", path.display()))
}

/// The pipe's last path segment for this account's engine.
pub fn leaf(distro: &str) -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string());
    engine_pipe::leaf(distro, &user)
}

fn log(line: &str) {
    let Some(dir) = relay_dir() else { return };
    let path = dir.join("relay.log");
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 1 << 20) {
        let _ = std::fs::rename(&path, dir.join("relay.log.1"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{} {line}", crate::sandbox::now_ms());
    }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Keeping one running: `ic engine start` and `stop`.                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/// A relay of this ic serving `record`'s engine, and the record naming its pipe. Started from a copy of this binary
/// (copied once per build), handed over to when an older copy serves, left alone when this copy already does.
pub fn ensure(record: &mut EngineRecord) -> Result<(), String> {
    let dir = relay_dir().ok_or("could not find this account's home folder.")?;
    paths::ensure_dir(&dir)?;
    let copy = private_copy(&dir)?;
    let name = copy
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let leaf = leaf(&record.distro);
    let path = format!(r"\\.\pipe\{leaf}");
    let serving = current();
    set_current(&name)?;
    if serving.as_deref() != Some(name.as_str()) || !engine_pipe::present(&path) {
        spawn(&copy)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !engine_pipe::present(&path) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        if !engine_pipe::present(&path) {
            return Err(format!(
                "the relay did not open {path} (see {})",
                dir.join("relay.log").display()
            ));
        }
    }
    let host = engine_pipe::host_for(&leaf);
    if record.pipe.as_deref() != Some(host.as_str()) {
        record.pipe = Some(host);
        record.save()?;
    }
    // Copies no relay runs from any more; one still running refuses to go, and goes on a later start.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if file.starts_with("ic-") && file.ends_with(".exe") && file != name {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// Every relay of this account stops taking connections, and ends once its own are done.
pub fn stop() {
    if let Some(path) = current_path() {
        let _ = std::fs::write(path, "");
    }
}

/// The relay folder, once nothing runs from it any more (the removal of the engine).
pub fn remove_files() {
    stop();
    if let Some(dir) = relay_dir() {
        let deadline = Instant::now() + Duration::from_secs(8);
        while std::fs::remove_dir_all(&dir).is_err() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

/// This binary, copied to `ic-<first 12 hex of its SHA-256>.exe` in `dir` unless that copy is there already.
fn private_copy(dir: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let exe =
        std::env::current_exe().map_err(|error| format!("could not find ic itself: {error}"))?;
    let bytes = std::fs::read(&exe).map_err(|error| format!("{}: {error}", exe.display()))?;
    let digest = Sha256::digest(&bytes);
    let hash: String = digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let copy = dir.join(format!("ic-{hash}.exe"));
    if !copy.is_file() {
        let staged = dir.join(format!("ic-{hash}.exe.new"));
        std::fs::write(&staged, &bytes)
            .map_err(|error| format!("{}: {error}", staged.display()))?;
        std::fs::rename(&staged, &copy).map_err(|error| format!("{}: {error}", copy.display()))?;
    }
    Ok(copy)
}

fn spawn(copy: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    super::windows::keep_own_handles();
    Command::new(copy)
        .args(["engine", "relay"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not start the relay: {error}"))
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* `ic engine relay`: the server.                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

pub fn run() -> Result<(), String> {
    let record = EngineRecord::load().ok_or("the intentic engine is not installed on this PC.")?;
    let port = super::windows::port_from_host(&record.host);
    let config = tls_config(Path::new(&record.cert_path))?;
    let me = std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    let still_mine = || current().as_deref() == Some(me.as_str());
    let path = format!(r"\\.\pipe\{}", leaf(&record.distro));
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let security = Security::this_account().map_err(|error| format!("pipe security: {error}"))?;

    // The first instance claims the name, which an older relay may hold for a few seconds more.
    let deadline = Instant::now() + HANDOVER;
    let mut listening = loop {
        match create_instance(&wide, true, &security) {
            Ok(pipe) => break pipe,
            Err(error) if Instant::now() < deadline && still_mine() => {
                let _ = error;
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(error) => {
                log(&format!("{me}: could not claim {path}: {error}"));
                return Err(format!("could not claim {path}: {error}"));
            }
        }
    };
    log(&format!("{me}: serving {path} for 127.0.0.1:{port}"));
    let active = Arc::new(AtomicUsize::new(0));
    let event = Event::new().map_err(|error| error.to_string())?;
    loop {
        match listening.accept(&event, &|| !still_mine()) {
            Ok(true) => {
                let next = create_instance(&wide, false, &security);
                let connected = std::mem::replace(
                    &mut listening,
                    match next {
                        Ok(next) => next,
                        Err(error) => {
                            log(&format!("{me}: could not open another instance: {error}"));
                            return Err(error.to_string());
                        }
                    },
                );
                let config = config.clone();
                let active = active.clone();
                active.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    serve(connected, &config, port);
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Ok(false) => break,
            Err(error) => {
                log(&format!("{me}: waiting for a client failed: {error}"));
                break;
            }
        }
    }
    drop(listening);
    log(&format!(
        "{me}: no longer the relay; ending once its connections are done"
    ));
    let deadline = Instant::now() + DRAIN;
    while active.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

fn tls_config(certs: &Path) -> Result<Arc<ClientConfig>, String> {
    let read = |name: &str| certs.join(name);
    let mut roots = RootCertStore::empty();
    for cert in
        CertificateDer::pem_file_iter(read("ca.pem")).map_err(|error| format!("ca.pem: {error}"))?
    {
        let cert = cert.map_err(|error| format!("ca.pem: {error}"))?;
        roots
            .add(cert)
            .map_err(|error| format!("ca.pem: {error}"))?;
    }
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(read("cert.pem"))
        .map_err(|error| format!("cert.pem: {error}"))?
        .collect::<Result<_, _>>()
        .map_err(|error| format!("cert.pem: {error}"))?;
    let key = PrivateKeyDer::from_pem_file(read("key.pem"))
        .map_err(|error| format!("key.pem: {error}"))?;
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|error| error.to_string())?
            .with_root_certificates(roots)
            .with_client_auth_cert(chain, key)
            .map_err(|error| format!("the client certificate: {error}"))?;
    Ok(Arc::new(config))
}

/// One client, carried to the engine until either side ends. Three threads, so no direction waits on another: the
/// client's bytes go up from one, the engine's are read and decrypted on a second, and this one writes them to the
/// pipe (measured on omen: one thread taking turns used under half a core and moved 125–170 MB/s).
fn serve(pipe: Pipe, config: &Arc<ClientConfig>, port: u16) {
    let (Ok(up_event), Ok(down_event)) = (Event::new(), Event::new()) else {
        pipe.finish();
        return;
    };
    let mut buffer = vec![0u8; CHUNK];
    // Nothing is opened to the engine for a client that never speaks (a probe of whether the pipe is there).
    let first = match pipe.read(&up_event, &mut buffer) {
        Ok(Got::Bytes(read)) => read,
        _ => {
            pipe.finish();
            return;
        }
    };
    let (tls, mut from_engine) = match Tls::open(config, port) {
        Ok(opened) => opened,
        Err(error) => {
            log(&format!(
                "could not reach the engine at 127.0.0.1:{port}: {error}"
            ));
            pipe.finish();
            return;
        }
    };
    if tls.send(&buffer[..first]).is_err() {
        tls.shutdown();
        pipe.finish();
        return;
    }
    let pipe = Arc::new(pipe);
    let up = {
        let pipe = pipe.clone();
        let tls = tls.clone();
        std::thread::spawn(move || loop {
            match pipe.read(&up_event, &mut buffer) {
                Ok(Got::Bytes(read)) => {
                    if tls.send(&buffer[..read]).is_err() {
                        tls.shutdown();
                        break;
                    }
                }
                // The client is done sending (stdin's end in `docker run -i`): the engine hears the same.
                Ok(Got::EndOfMessages) => {
                    let _ = tls.close_write();
                    break;
                }
                Ok(Got::Closed) | Err(_) => {
                    tls.shutdown();
                    break;
                }
            }
        })
    };
    let (plain_out, plain_in) = std::sync::mpsc::sync_channel::<Vec<u8>>(8);
    let down = {
        let tls = tls.clone();
        std::thread::spawn(move || {
            let mut wire = vec![0u8; CHUNK];
            loop {
                let read = match from_engine.read(&mut wire) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                let mut plain = Vec::with_capacity(read);
                let open = match tls.receive(&wire[..read], &mut plain) {
                    Ok(open) => open,
                    Err(_) => break,
                };
                if !plain.is_empty() && plain_out.send(plain).is_err() {
                    break;
                }
                if !open {
                    break;
                }
            }
        })
    };
    for plain in plain_in.iter() {
        if !pipe.write_all(&down_event, &plain).unwrap_or(false) {
            break;
        }
    }
    // Gone before the engine's thread is waited for, which may be waiting to hand over more.
    drop(plain_in);
    // The engine is done (or the client is gone): the client hears the end (a zero-length message), reads what is
    // left, and the pipe closes, which also ends a read pending in the client's direction.
    let _ = pipe.write_all(&down_event, &[]);
    pipe.finish();
    tls.shutdown();
    let _ = up.join();
    let _ = down.join();
}

/// How many encrypted bytes may wait for the engine's socket before the client's direction stops reading the pipe.
const QUEUE_LIMIT: usize = 8 << 20;

/// One TLS session to the engine. Every record is made, and handed to the one thread that writes the socket, under the
/// session's lock, so records reach the engine in the order they were numbered whichever direction made them (the
/// client's data, or a reply the engine's own records call for), and no lock is held while a socket blocks.
struct Tls {
    connection: Mutex<ClientConnection>,
    to_socket: Mutex<std::sync::mpsc::Sender<Vec<u8>>>,
    queued: Arc<AtomicUsize>,
    control: TcpStream,
}

impl Tls {
    fn open(config: &Arc<ClientConfig>, port: u16) -> io::Result<(Arc<Tls>, TcpStream)> {
        let mut socket = TcpStream::connect((Ipv4Addr::LOCALHOST, port))?;
        socket.set_nodelay(true)?;
        let name = ServerName::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST).into());
        let mut connection =
            ClientConnection::new(config.clone(), name).map_err(io::Error::other)?;
        while connection.is_handshaking() {
            connection.complete_io(&mut socket)?;
        }
        let reader = socket.try_clone()?;
        let control = socket.try_clone()?;
        let queued = Arc::new(AtomicUsize::new(0));
        let (to_socket, from_tls) = std::sync::mpsc::channel::<Vec<u8>>();
        {
            let queued = queued.clone();
            let mut socket = socket;
            std::thread::spawn(move || {
                for wire in from_tls.iter() {
                    queued.fetch_sub(wire.len(), Ordering::SeqCst);
                    if socket.write_all(&wire).is_err() {
                        let _ = socket.shutdown(Shutdown::Both);
                        break;
                    }
                }
            });
        }
        Ok((
            Arc::new(Tls {
                connection: Mutex::new(connection),
                to_socket: Mutex::new(to_socket),
                queued,
                control,
            }),
            reader,
        ))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ClientConnection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The session's pending records, queued for the socket in order. Called with the session locked.
    fn flush_locked(&self, connection: &mut ClientConnection) -> io::Result<()> {
        if !connection.wants_write() {
            return Ok(());
        }
        let mut wire = Vec::new();
        while connection.wants_write() {
            connection.write_tls(&mut wire)?;
        }
        self.queued.fetch_add(wire.len(), Ordering::SeqCst);
        self.to_socket
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .send(wire)
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
    }

    /// Plaintext out. Waits, without the lock, while the socket is far behind, so a slow engine slows the client.
    fn send(&self, plain: &[u8]) -> io::Result<()> {
        while self.queued.load(Ordering::SeqCst) > QUEUE_LIMIT {
            std::thread::sleep(Duration::from_millis(1));
        }
        let mut connection = self.lock();
        connection.writer().write_all(plain)?;
        self.flush_locked(&mut connection)
    }

    fn close_write(&self) -> io::Result<()> {
        let mut connection = self.lock();
        connection.send_close_notify();
        self.flush_locked(&mut connection)
    }

    /// The engine's bytes in, its plaintext appended to `plain`; false once the engine has closed the session.
    fn receive(&self, wire: &[u8], plain: &mut Vec<u8>) -> io::Result<bool> {
        let mut open = true;
        let mut connection = self.lock();
        let mut rest = wire;
        while !rest.is_empty() {
            connection.read_tls(&mut rest)?;
            let state = connection.process_new_packets().map_err(io::Error::other)?;
            let waiting = state.plaintext_bytes_to_read();
            if waiting > 0 {
                let start = plain.len();
                plain.resize(start + waiting, 0);
                connection.reader().read_exact(&mut plain[start..])?;
            }
            if state.peer_has_closed() {
                open = false;
            }
        }
        self.flush_locked(&mut connection)?;
        Ok(open)
    }

    fn shutdown(&self) {
        let _ = self.control.shutdown(Shutdown::Both);
    }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The pipe, through Win32: overlapped, so one connection is read and written at the same time from two threads.     */
/* ------------------------------------------------------------------------------------------------------------------ */

type Handle = *mut c_void;

#[repr(C)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: Handle,
}

impl Overlapped {
    fn on(event: &Event) -> Overlapped {
        Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: event.0,
        }
    }
}

#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: *mut c_void,
    inherit: i32,
}

extern "system" {
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_buffer: u32,
        in_buffer: u32,
        default_timeout: u32,
        security: *const SecurityAttributes,
    ) -> Handle;
    fn ConnectNamedPipe(pipe: Handle, overlapped: *mut Overlapped) -> i32;
    fn DisconnectNamedPipe(pipe: Handle) -> i32;
    fn FlushFileBuffers(file: Handle) -> i32;
    fn CreateEventW(
        security: *const c_void,
        manual_reset: i32,
        initial: i32,
        name: *const u16,
    ) -> Handle;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetOverlappedResult(
        file: Handle,
        overlapped: *mut Overlapped,
        transferred: *mut u32,
        wait: i32,
    ) -> i32;
    fn CancelIoEx(file: Handle, overlapped: *mut Overlapped) -> i32;
    fn ReadFile(
        file: Handle,
        buffer: *mut u8,
        len: u32,
        read: *mut u32,
        overlapped: *mut Overlapped,
    ) -> i32;
    fn WriteFile(
        file: Handle,
        buffer: *const u8,
        len: u32,
        written: *mut u32,
        overlapped: *mut Overlapped,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetCurrentProcess() -> Handle;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        info: *mut c_void,
        len: u32,
        needed: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: *mut c_void, text: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
}

const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
const PIPE_TYPE_MESSAGE: u32 = 0x0000_0004;
const PIPE_READMODE_MESSAGE: u32 = 0x0000_0002;
const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
const PIPE_UNLIMITED_INSTANCES: u32 = 255;
const ERROR_BROKEN_PIPE: i32 = 109;
const ERROR_NO_DATA: i32 = 232;
const ERROR_PIPE_NOT_CONNECTED: i32 = 233;
const ERROR_MORE_DATA: i32 = 234;
const ERROR_PIPE_CONNECTED: i32 = 535;
const ERROR_OPERATION_ABORTED: i32 = 995;
const ERROR_IO_PENDING: i32 = 997;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;

fn last_error() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn closed(error: i32) -> bool {
    matches!(
        error,
        ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED | ERROR_OPERATION_ABORTED
    )
}

/// A manual-reset event for one thread's overlapped calls.
struct Event(Handle);

// SAFETY: an event handle is a kernel object usable from any thread; each is used by one thread at a time here.
unsafe impl Send for Event {}

impl Event {
    fn new() -> io::Result<Event> {
        // SAFETY: no name and no security attributes: a fresh unnamed event, owned by the returned value.
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Event(handle))
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateEventW and is closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// The DACL every instance gets: this account and SYSTEM, nobody else.
struct Security {
    attributes: SecurityAttributes,
}

impl Security {
    fn this_account() -> io::Result<Security> {
        let sid = account_sid()?;
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})(A;;GA;;;SY)")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut descriptor: *mut c_void = std::ptr::null_mut();
        // SAFETY: `sddl` is NUL-terminated; the descriptor is allocated by the call and kept for the process's life.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Security {
            attributes: SecurityAttributes {
                length: std::mem::size_of::<SecurityAttributes>() as u32,
                descriptor,
                inherit: 0,
            },
        })
    }
}

/// This process's account, as an SDDL SID string (`S-1-5-21-…`).
fn account_sid() -> io::Result<String> {
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_USER: u32 = 1;
    let mut token: Handle = std::ptr::null_mut();
    // SAFETY: the pseudo-handle of this process; the token handle is closed below.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut needed = 0u32;
    // SAFETY: a size query with no buffer; the call writes only `needed`.
    unsafe { GetTokenInformation(token, TOKEN_USER, std::ptr::null_mut(), 0, &mut needed) };
    // Pointer-aligned storage: TOKEN_USER starts with the SID's pointer.
    let mut info = vec![
        0usize;
        (needed as usize)
            .div_ceil(std::mem::size_of::<usize>())
            .max(1)
    ];
    // SAFETY: `info` holds at least `needed` bytes.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TOKEN_USER,
            info.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    // SAFETY: closed once; the SID lives in `info`, not in the token.
    unsafe { CloseHandle(token) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let sid = info[0] as *mut c_void;
    let mut text: *mut u16 = std::ptr::null_mut();
    // SAFETY: `sid` points into `info`, alive for the call; the string is freed with LocalFree below.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut len = 0usize;
    // SAFETY: a NUL-terminated string the call allocated; read up to its NUL, then freed once.
    let sid = unsafe {
        while *text.add(len) != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        sid
    };
    Ok(sid)
}

fn create_instance(name: &[u16], first: bool, security: &Security) -> io::Result<Pipe> {
    let open = PIPE_ACCESS_DUPLEX
        | FILE_FLAG_OVERLAPPED
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    let mode = PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_REJECT_REMOTE_CLIENTS;
    // SAFETY: `name` is NUL-terminated and the security attributes outlive the call.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open,
            mode,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER,
            PIPE_BUFFER,
            0,
            &security.attributes,
        )
    };
    if handle as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(Pipe(handle))
}

/// What one read of the pipe brought.
enum Got {
    Bytes(usize),
    /// A zero-length message: the client closed its writing half.
    EndOfMessages,
    /// The client is gone.
    Closed,
}

/// One instance of the pipe, read from one thread and written from another.
struct Pipe(Handle);

// SAFETY: a pipe handle opened for overlapped I/O takes concurrent reads and writes from different threads, each with
// its own OVERLAPPED and event, which is how every method here uses it.
unsafe impl Send for Pipe {}
unsafe impl Sync for Pipe {}

impl Pipe {
    /// Wait for a client, looking every few seconds whether to give up (`stop`): true once one has connected.
    fn accept(&self, event: &Event, stop: &dyn Fn() -> bool) -> io::Result<bool> {
        let mut overlapped = Overlapped::on(event);
        // SAFETY: `overlapped` and its event stay alive until the operation is complete or cancelled below.
        if unsafe { ConnectNamedPipe(self.0, &mut overlapped) } == 0 {
            match last_error() {
                ERROR_PIPE_CONNECTED => return Ok(true),
                ERROR_IO_PENDING => {}
                error => return Err(io::Error::from_raw_os_error(error)),
            }
        }
        loop {
            // SAFETY: the event belongs to `overlapped`'s pending operation.
            match unsafe { WaitForSingleObject(event.0, LOOK_EVERY_MS) } {
                WAIT_OBJECT_0 => {
                    let mut transferred = 0u32;
                    // SAFETY: the operation has completed; this reads its status.
                    if unsafe { GetOverlappedResult(self.0, &mut overlapped, &mut transferred, 0) }
                        == 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    return Ok(true);
                }
                WAIT_TIMEOUT if stop() => {
                    let mut transferred = 0u32;
                    // SAFETY: cancel the pending connect, then wait for it to end before `overlapped` goes away.
                    unsafe {
                        CancelIoEx(self.0, &mut overlapped);
                        GetOverlappedResult(self.0, &mut overlapped, &mut transferred, 1);
                    }
                    return Ok(false);
                }
                WAIT_TIMEOUT => {}
                _ => return Err(io::Error::last_os_error()),
            }
        }
    }

    fn read(&self, event: &Event, buffer: &mut [u8]) -> io::Result<Got> {
        let mut overlapped = Overlapped::on(event);
        let len = buffer.len().min(u32::MAX as usize) as u32;
        // SAFETY: `buffer` and `overlapped` outlive the operation, which GetOverlappedResult waits for.
        if unsafe {
            ReadFile(
                self.0,
                buffer.as_mut_ptr(),
                len,
                std::ptr::null_mut(),
                &mut overlapped,
            )
        } == 0
        {
            match last_error() {
                ERROR_IO_PENDING | ERROR_MORE_DATA => {}
                error if closed(error) => return Ok(Got::Closed),
                error => return Err(io::Error::from_raw_os_error(error)),
            }
        }
        let mut transferred = 0u32;
        // SAFETY: waits for the read above to finish.
        if unsafe { GetOverlappedResult(self.0, &mut overlapped, &mut transferred, 1) } == 0 {
            return match last_error() {
                // A message longer than the buffer: this much now, the rest on the next read.
                ERROR_MORE_DATA => Ok(Got::Bytes(transferred as usize)),
                error if closed(error) => Ok(Got::Closed),
                error => Err(io::Error::from_raw_os_error(error)),
            };
        }
        Ok(if transferred == 0 {
            Got::EndOfMessages
        } else {
            Got::Bytes(transferred as usize)
        })
    }

    /// Every byte of `data` as messages (an empty `data` is one zero-length message: the end, to the client). False
    /// when the client is gone.
    fn write_all(&self, event: &Event, data: &[u8]) -> io::Result<bool> {
        let mut offset = 0usize;
        loop {
            let chunk = &data[offset..data.len().min(offset + PIPE_BUFFER as usize)];
            let mut overlapped = Overlapped::on(event);
            // SAFETY: `chunk` and `overlapped` outlive the operation, which GetOverlappedResult waits for.
            if unsafe {
                WriteFile(
                    self.0,
                    chunk.as_ptr(),
                    chunk.len() as u32,
                    std::ptr::null_mut(),
                    &mut overlapped,
                )
            } == 0
            {
                match last_error() {
                    ERROR_IO_PENDING => {}
                    error if closed(error) => return Ok(false),
                    error => return Err(io::Error::from_raw_os_error(error)),
                }
            }
            let mut transferred = 0u32;
            // SAFETY: waits for the write above to finish.
            if unsafe { GetOverlappedResult(self.0, &mut overlapped, &mut transferred, 1) } == 0 {
                let error = last_error();
                return if closed(error) {
                    Ok(false)
                } else {
                    Err(io::Error::from_raw_os_error(error))
                };
            }
            offset += transferred as usize;
            if offset >= data.len() {
                return Ok(true);
            }
        }
    }

    /// Let the client read what is still in the pipe, then end the connection (which also ends a read pending on it).
    fn finish(&self) {
        // SAFETY: plain calls on a handle this value owns; a client that is gone makes them fail, harmlessly.
        unsafe {
            FlushFileBuffers(self.0);
            DisconnectNamedPipe(self.0);
        }
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateNamedPipeW and is closed once.
        unsafe { CloseHandle(self.0) };
    }
}
