//! A screen-cast stream from PipeWire, as cast-core's [`Capture`]. libpipewire-0.3 is opened at run time and the few
//! calls used are written out here (MIT headers, pipewire 1.0's), so remoted builds without its headers and runs where
//! it is not installed.
//!
//! The stream runs on PipeWire's own thread (a `pw_thread_loop`). Each buffer that carries a picture is copied there
//! into the latest picture, row runs that differ from what was there before marked as damage (the compositor's own
//! damage list is used where it sends one), and the capture thread is woken; the capture copies the damaged runs into
//! the picture the encoder reads. Buffers are shared memory (MemFd or MemPtr): the compositor converts on its side.
//! The cursor comes as metadata, sent to viewers as its shape and position, so it is never baked into the picture.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::os::fd::{IntoRawFd, OwnedFd};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cast_core::capture::{Capture, Damage};
use cast_core::geometry::Rect;
use cast_core::hub::Hub;
use cast_core::wake::{Waitable, Wake};

use super::pod::{self, Value};

#[repr(C)]
struct SpaHook {
    words: [usize; 6],
}

#[repr(C)]
struct PwStreamEvents {
    version: u32,
    destroy: Option<unsafe extern "C" fn(*mut c_void)>,
    state_changed: Option<unsafe extern "C" fn(*mut c_void, c_int, c_int, *const c_char)>,
    control_info: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    io_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32)>,
    param_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    add_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
    remove_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
    process: Option<unsafe extern "C" fn(*mut c_void)>,
    drained: Option<unsafe extern "C" fn(*mut c_void)>,
    command: Option<unsafe extern "C" fn(*mut c_void, *const c_void)>,
    trigger_done: Option<unsafe extern "C" fn(*mut c_void)>,
}

#[repr(C)]
struct PwBuffer {
    buffer: *mut SpaBuffer,
    user_data: *mut c_void,
    size: u64,
    requested: u64,
}

#[repr(C)]
struct SpaBuffer {
    n_metas: u32,
    n_datas: u32,
    metas: *mut SpaMeta,
    datas: *mut SpaData,
}

#[repr(C)]
struct SpaMeta {
    kind: u32,
    size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct SpaData {
    kind: u32,
    flags: u32,
    fd: i64,
    mapoffset: u32,
    maxsize: u32,
    data: *mut c_void,
    chunk: *mut SpaChunk,
}

#[repr(C)]
struct SpaChunk {
    offset: u32,
    size: u32,
    stride: i32,
    flags: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SpaMetaRegion {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[repr(C)]
struct SpaMetaCursor {
    id: u32,
    flags: u32,
    x: i32,
    y: i32,
    hot_x: i32,
    hot_y: i32,
    bitmap_offset: u32,
}

#[repr(C)]
struct SpaMetaBitmap {
    format: u32,
    w: u32,
    h: u32,
    stride: i32,
    offset: u32,
}

const CHUNK_FLAG_CORRUPTED: i32 = 1;
const STREAM_FLAG_AUTOCONNECT: u32 = 1;
const STREAM_FLAG_MAP_BUFFERS: u32 = 1 << 2;
const DIRECTION_INPUT: u32 = 0;
const STATE_ERROR: c_int = -1;
const STATE_UNCONNECTED: c_int = 0;
const STATE_STREAMING: c_int = 3;

/// The size cursor metadata asks room for: the cursor, its bitmap's header, and a `w` x `h` RGBA bitmap.
const fn cursor_meta_size(w: u32, h: u32) -> i32 {
    (size_of::<SpaMetaCursor>() + size_of::<SpaMetaBitmap>()) as i32 + (w * h * 4) as i32
}

type P = *mut c_void;

/// libpipewire-0.3's entry points.
struct Pw {
    _lib: libloading::Library,
    init: unsafe extern "C" fn(*mut c_int, *mut *mut *mut c_char),
    version: unsafe extern "C" fn() -> *const c_char,
    thread_loop_new: unsafe extern "C" fn(*const c_char, *const c_void) -> P,
    thread_loop_start: unsafe extern "C" fn(P) -> c_int,
    thread_loop_stop: unsafe extern "C" fn(P),
    thread_loop_destroy: unsafe extern "C" fn(P),
    thread_loop_lock: unsafe extern "C" fn(P),
    thread_loop_unlock: unsafe extern "C" fn(P),
    thread_loop_get_loop: unsafe extern "C" fn(P) -> P,
    context_new: unsafe extern "C" fn(P, P, usize) -> P,
    context_connect_fd: unsafe extern "C" fn(P, c_int, P, usize) -> P,
    context_destroy: unsafe extern "C" fn(P),
    core_disconnect: unsafe extern "C" fn(P) -> c_int,
    properties_new_string: unsafe extern "C" fn(*const c_char) -> P,
    stream_new: unsafe extern "C" fn(P, *const c_char, P) -> P,
    stream_add_listener: unsafe extern "C" fn(P, *mut SpaHook, *const PwStreamEvents, *mut c_void),
    stream_connect: unsafe extern "C" fn(P, u32, u32, u32, *mut *const c_void, u32) -> c_int,
    stream_disconnect: unsafe extern "C" fn(P) -> c_int,
    stream_destroy: unsafe extern "C" fn(P),
    stream_dequeue_buffer: unsafe extern "C" fn(P) -> *mut PwBuffer,
    stream_queue_buffer: unsafe extern "C" fn(P, *mut PwBuffer) -> c_int,
    stream_update_params: unsafe extern "C" fn(P, *mut *const c_void, u32) -> c_int,
}

macro_rules! sym {
    ($lib:expr, $name:literal) => {
        // SAFETY: the symbol is libpipewire's, with the signature its header declares, repeated by the field's type.
        *unsafe { $lib.get(concat!($name, "\0").as_bytes()) }.map_err(|e| format!("libpipewire lacks {}: {e}", $name))?
    };
}

impl Pw {
    fn load() -> Result<Pw, String> {
        // SAFETY: loading the library runs its constructors, which set up its own state.
        let lib = unsafe { libloading::Library::new("libpipewire-0.3.so.0") }.map_err(|e| {
            format!("libpipewire-0.3.so.0 not found ({e}): PipeWire is not installed")
        })?;
        let pw = Pw {
            init: sym!(lib, "pw_init"),
            version: sym!(lib, "pw_get_library_version"),
            thread_loop_new: sym!(lib, "pw_thread_loop_new"),
            thread_loop_start: sym!(lib, "pw_thread_loop_start"),
            thread_loop_stop: sym!(lib, "pw_thread_loop_stop"),
            thread_loop_destroy: sym!(lib, "pw_thread_loop_destroy"),
            thread_loop_lock: sym!(lib, "pw_thread_loop_lock"),
            thread_loop_unlock: sym!(lib, "pw_thread_loop_unlock"),
            thread_loop_get_loop: sym!(lib, "pw_thread_loop_get_loop"),
            context_new: sym!(lib, "pw_context_new"),
            context_connect_fd: sym!(lib, "pw_context_connect_fd"),
            context_destroy: sym!(lib, "pw_context_destroy"),
            core_disconnect: sym!(lib, "pw_core_disconnect"),
            properties_new_string: sym!(lib, "pw_properties_new_string"),
            stream_new: sym!(lib, "pw_stream_new"),
            stream_add_listener: sym!(lib, "pw_stream_add_listener"),
            stream_connect: sym!(lib, "pw_stream_connect"),
            stream_disconnect: sym!(lib, "pw_stream_disconnect"),
            stream_destroy: sym!(lib, "pw_stream_destroy"),
            stream_dequeue_buffer: sym!(lib, "pw_stream_dequeue_buffer"),
            stream_queue_buffer: sym!(lib, "pw_stream_queue_buffer"),
            stream_update_params: sym!(lib, "pw_stream_update_params"),
            _lib: lib,
        };
        // SAFETY: pw_init takes null arguments; it may be called more than once.
        unsafe { (pw.init)(std::ptr::null_mut(), std::ptr::null_mut()) };
        Ok(pw)
    }
}

/// libpipewire, loaded once for the process.
fn pw() -> Result<&'static Pw, String> {
    static PW: std::sync::OnceLock<Result<Pw, String>> = std::sync::OnceLock::new();
    PW.get_or_init(Pw::load).as_ref().map_err(Clone::clone)
}

/// Whether libpipewire can be loaded here, and its version.
pub fn available() -> Result<String, String> {
    let pw = pw()?;
    // SAFETY: a static string.
    Ok(unsafe { CStr::from_ptr((pw.version)()) }
        .to_string_lossy()
        .into_owned())
}

/// The negotiated picture.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Format {
    format: u32,
    width: u32,
    height: u32,
}

/// What PipeWire's thread hands the capture thread.
struct Latest {
    format: Option<Format>,
    /// Bumped when the format changes: the capture opened at another one rebuilds.
    generation: u64,
    /// BGRX, `width * 4` a row.
    picture: Vec<u8>,
    /// Areas changed since the capture last took them, and when the first of them arrived.
    damage: Vec<SpaMetaRegion>,
    damaged_at: Option<Instant>,
    error: Option<String>,
    pictures: u64,
    /// The cursor's shape last sent, by the compositor's id for it.
    cursor_id: u32,
    cursor_hidden: bool,
}

struct Shared {
    latest: Mutex<Latest>,
    wake: Wake,
    hub: Arc<Hub>,
    /// The stream, for `update_params` from the format callback (PipeWire's thread, under its lock).
    stream: std::sync::atomic::AtomicPtr<c_void>,
}

/// The listener PipeWire calls back with: kept at a fixed address for the stream's life.
struct Listener {
    hook: SpaHook,
    events: PwStreamEvents,
    shared: Arc<Shared>,
}

/// A PipeWire connection and the one stream on it.
pub struct Stream {
    pw: &'static Pw,
    thread_loop: P,
    context: P,
    core: P,
    stream: P,
    listener: Box<Listener>,
}

// The pointers are PipeWire's, used under its thread loop's lock from whichever thread holds the Stream.
unsafe impl Send for Stream {}

impl Stream {
    /// Connects to the PipeWire remote the portal opened (`fd`) and starts receiving node `node`.
    pub fn connect(fd: OwnedFd, node: u32, hub: Arc<Hub>) -> Result<Stream, String> {
        let pw = pw()?;
        let shared = Arc::new(Shared {
            latest: Mutex::new(Latest {
                format: None,
                generation: 0,
                picture: Vec::new(),
                damage: Vec::new(),
                damaged_at: None,
                error: None,
                pictures: 0,
                cursor_id: 0,
                cursor_hidden: false,
            }),
            wake: Wake::new().map_err(|e| format!("a wake pipe: {e}"))?,
            hub,
            stream: std::sync::atomic::AtomicPtr::new(std::ptr::null_mut()),
        });
        let listener = Box::new(Listener {
            hook: SpaHook { words: [0; 6] },
            events: PwStreamEvents {
                version: 2,
                destroy: None,
                state_changed: Some(on_state),
                control_info: None,
                io_changed: None,
                param_changed: Some(on_param),
                add_buffer: None,
                remove_buffer: None,
                process: Some(on_process),
                drained: None,
                command: None,
                trigger_done: None,
            },
            shared,
        });
        let name = CString::new("intentic-remoted").expect("a name");
        // SAFETY: PipeWire's constructors, each checked; on failure what was made is torn down below.
        unsafe {
            let thread_loop = (pw.thread_loop_new)(name.as_ptr(), std::ptr::null());
            if thread_loop.is_null() {
                return Err("pw_thread_loop_new failed".into());
            }
            let mut made = Stream {
                pw,
                thread_loop,
                context: std::ptr::null_mut(),
                core: std::ptr::null_mut(),
                stream: std::ptr::null_mut(),
                listener,
            };
            let loop_ = (pw.thread_loop_get_loop)(thread_loop);
            made.context = (pw.context_new)(loop_, std::ptr::null_mut(), 0);
            if made.context.is_null() {
                return Err("pw_context_new failed".into());
            }
            if (pw.thread_loop_start)(thread_loop) < 0 {
                return Err("pw_thread_loop_start failed".into());
            }
            (pw.thread_loop_lock)(thread_loop);
            let connected = (|| {
                made.core = (pw.context_connect_fd)(
                    made.context,
                    fd.into_raw_fd(),
                    std::ptr::null_mut(),
                    0,
                );
                if made.core.is_null() {
                    return Err("cannot connect to the portal's PipeWire remote".to_string());
                }
                let props = CString::new(
                    "media.type=Video media.category=Capture media.role=Screen node.name=intentic-remoted",
                )
                .expect("properties");
                made.stream = (pw.stream_new)(
                    made.core,
                    name.as_ptr(),
                    (pw.properties_new_string)(props.as_ptr()),
                );
                if made.stream.is_null() {
                    return Err("pw_stream_new failed".into());
                }
                made.listener
                    .shared
                    .stream
                    .store(made.stream, std::sync::atomic::Ordering::Release);
                let listener: *mut Listener = &mut *made.listener;
                (pw.stream_add_listener)(
                    made.stream,
                    &mut (*listener).hook,
                    &(*listener).events,
                    listener.cast(),
                );
                let format = enum_format();
                let mut params = [format.as_ptr().cast::<c_void>()];
                let r = (pw.stream_connect)(
                    made.stream,
                    DIRECTION_INPUT,
                    node,
                    STREAM_FLAG_AUTOCONNECT | STREAM_FLAG_MAP_BUFFERS,
                    params.as_mut_ptr(),
                    1,
                );
                if r < 0 {
                    return Err(format!("pw_stream_connect failed ({r})"));
                }
                Ok(())
            })();
            (pw.thread_loop_unlock)(thread_loop);
            connected?;
            Ok(made)
        }
    }

    /// Opens a capture of the stream's picture once it has one, waiting up to `patience`.
    pub fn capture(&self, patience: Duration) -> Result<Box<dyn Capture>, String> {
        let shared = &self.listener.shared;
        let started = Instant::now();
        loop {
            {
                let latest = shared.latest.lock().expect("stream poisoned");
                if let Some(e) = &latest.error {
                    return Err(e.clone());
                }
                if let Some(format) = latest.format
                    && latest.pictures > 0
                {
                    let (w, h) = (format.width & !1, format.height & !1);
                    if w < 16 || h < 16 {
                        return Err(format!(
                            "the screen cast is {}x{}",
                            format.width, format.height
                        ));
                    }
                    let stride = format.width as usize * 4;
                    let mut picture = vec![0u8; w as usize * h as usize * 4];
                    for y in 0..h as usize {
                        picture[y * w as usize * 4..(y + 1) * w as usize * 4].copy_from_slice(
                            &latest.picture[y * stride..y * stride + w as usize * 4],
                        );
                    }
                    return Ok(Box::new(PwCapture {
                        shared: shared.clone(),
                        generation: latest.generation,
                        source_stride: stride,
                        width: w,
                        height: h,
                        picture,
                        damage: Damage::new(w, h),
                        rebuild: false,
                    }));
                }
            }
            if started.elapsed() > patience {
                return Err("the screen cast sent no picture".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The stream's size now, once it has one.
    pub fn size(&self) -> Option<(u32, u32)> {
        let latest = self.listener.shared.latest.lock().expect("stream poisoned");
        latest.format.map(|f| (f.width, f.height))
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let pw = self.pw;
        // SAFETY: tearing down in the reverse order of `connect`, the stream and core under the loop's lock, the loop
        // stopped before the context and the loop itself go.
        unsafe {
            (pw.thread_loop_lock)(self.thread_loop);
            if !self.stream.is_null() {
                (pw.stream_disconnect)(self.stream);
                (pw.stream_destroy)(self.stream);
            }
            if !self.core.is_null() {
                (pw.core_disconnect)(self.core);
            }
            (pw.thread_loop_unlock)(self.thread_loop);
            (pw.thread_loop_stop)(self.thread_loop);
            if !self.context.is_null() {
                (pw.context_destroy)(self.context);
            }
            (pw.thread_loop_destroy)(self.thread_loop);
        }
    }
}

/// The formats remoted takes: 32-bit RGB in either order, in shared memory, any size and rate.
fn enum_format() -> Vec<u8> {
    pod::object(
        pod::OBJECT_FORMAT,
        pod::PARAM_ENUM_FORMAT,
        &[
            (pod::FORMAT_MEDIA_TYPE, 0, Value::Id(pod::MEDIA_TYPE_VIDEO)),
            (
                pod::FORMAT_MEDIA_SUBTYPE,
                0,
                Value::Id(pod::MEDIA_SUBTYPE_RAW),
            ),
            (
                pod::FORMAT_VIDEO_FORMAT,
                0,
                Value::Choice(
                    pod::CHOICE_ENUM,
                    [
                        pod::VIDEO_FORMAT_BGRX,
                        pod::VIDEO_FORMAT_BGRX,
                        pod::VIDEO_FORMAT_BGRA,
                        pod::VIDEO_FORMAT_RGBX,
                        pod::VIDEO_FORMAT_RGBA,
                        pod::VIDEO_FORMAT_XRGB,
                        pod::VIDEO_FORMAT_XBGR,
                        pod::VIDEO_FORMAT_ARGB,
                        pod::VIDEO_FORMAT_ABGR,
                    ]
                    .into_iter()
                    .map(Value::Id)
                    .collect(),
                ),
            ),
            (
                pod::FORMAT_VIDEO_SIZE,
                0,
                Value::Choice(
                    pod::CHOICE_RANGE,
                    vec![
                        Value::Rect(1920, 1080),
                        Value::Rect(1, 1),
                        Value::Rect(16384, 16384),
                    ],
                ),
            ),
            (
                pod::FORMAT_VIDEO_FRAMERATE,
                0,
                Value::Choice(
                    pod::CHOICE_RANGE,
                    vec![
                        Value::Fraction(60, 1),
                        Value::Fraction(0, 1),
                        Value::Fraction(360, 1),
                    ],
                ),
            ),
        ],
    )
}

/// Once the format is settled: shared-memory buffers of the picture's size, and the metadata asked for.
fn buffer_params(f: Format) -> Vec<Vec<u8>> {
    let stride = f.width as i32 * 4;
    let region = size_of::<SpaMetaRegion>() as i32;
    vec![
        pod::object(
            pod::OBJECT_PARAM_BUFFERS,
            pod::PARAM_BUFFERS,
            &[
                (
                    pod::BUFFERS_BUFFERS,
                    0,
                    Value::Choice(
                        pod::CHOICE_RANGE,
                        vec![Value::Int(4), Value::Int(2), Value::Int(16)],
                    ),
                ),
                (pod::BUFFERS_BLOCKS, 0, Value::Int(1)),
                (pod::BUFFERS_SIZE, 0, Value::Int(stride * f.height as i32)),
                (pod::BUFFERS_STRIDE, 0, Value::Int(stride)),
                (
                    pod::BUFFERS_DATA_TYPE,
                    0,
                    Value::Choice(
                        pod::CHOICE_FLAGS,
                        vec![Value::Int(
                            (1 << pod::DATA_MEM_FD) | (1 << pod::DATA_MEM_PTR),
                        )],
                    ),
                ),
            ],
        ),
        pod::object(
            pod::OBJECT_PARAM_META,
            pod::PARAM_META,
            &[
                (pod::META_TYPE, 0, Value::Id(pod::META_HEADER)),
                (pod::META_SIZE, 0, Value::Int(32)),
            ],
        ),
        pod::object(
            pod::OBJECT_PARAM_META,
            pod::PARAM_META,
            &[
                (pod::META_TYPE, 0, Value::Id(pod::META_VIDEO_DAMAGE)),
                (
                    pod::META_SIZE,
                    0,
                    Value::Choice(
                        pod::CHOICE_RANGE,
                        vec![
                            Value::Int(region * 16),
                            Value::Int(region),
                            Value::Int(region * 16),
                        ],
                    ),
                ),
            ],
        ),
        pod::object(
            pod::OBJECT_PARAM_META,
            pod::PARAM_META,
            &[
                (pod::META_TYPE, 0, Value::Id(pod::META_CURSOR)),
                (
                    pod::META_SIZE,
                    0,
                    Value::Choice(
                        pod::CHOICE_RANGE,
                        vec![
                            Value::Int(cursor_meta_size(64, 64)),
                            Value::Int(cursor_meta_size(1, 1)),
                            // Mutter offers a fixed 384x384, others less: the range takes any of them.
                            Value::Int(cursor_meta_size(1024, 1024)),
                        ],
                    ),
                ),
            ],
        ),
    ]
}

unsafe fn listener<'a>(data: *mut c_void) -> &'a Listener {
    // SAFETY: `data` is the Box<Listener> registered with the stream, alive until the stream is destroyed.
    unsafe { &*(data as *const Listener) }
}

unsafe extern "C" fn on_state(data: *mut c_void, _old: c_int, state: c_int, error: *const c_char) {
    let l = unsafe { listener(data) };
    if state == STATE_ERROR || state == STATE_UNCONNECTED {
        let why = if error.is_null() {
            "the screen cast ended".to_string()
        } else {
            format!(
                "the screen cast failed: {}",
                unsafe { CStr::from_ptr(error) }.to_string_lossy()
            )
        };
        log::info!("pipewire: {why}");
        l.shared.latest.lock().expect("stream poisoned").error = Some(why);
        l.shared.wake.signal();
    } else if state == STATE_STREAMING {
        log::info!("pipewire: streaming");
    }
}

unsafe extern "C" fn on_param(data: *mut c_void, id: u32, param: *const c_void) {
    if id != pod::PARAM_FORMAT || param.is_null() {
        return;
    }
    let l = unsafe { listener(data) };
    // SAFETY: a POD is its body's size, then its type, then the body.
    let size = unsafe { *(param as *const u32) } as usize;
    let bytes = unsafe { std::slice::from_raw_parts(param as *const u8, size + 8) };
    let mut format = Format {
        format: 0,
        width: 0,
        height: 0,
    };
    for (key, value) in pod::properties(bytes) {
        match key {
            pod::FORMAT_VIDEO_FORMAT => format.format = value.u32().unwrap_or(0),
            pod::FORMAT_VIDEO_SIZE => {
                (format.width, format.height) = value.pair().unwrap_or((0, 0))
            }
            pod::FORMAT_VIDEO_MODIFIER => {
                log::info!("pipewire: the compositor offers DMA-BUF only")
            }
            _ => {}
        }
    }
    log::info!(
        "pipewire: {}x{}, format {}",
        format.width,
        format.height,
        format.format
    );
    {
        let mut latest = l.shared.latest.lock().expect("stream poisoned");
        if latest.format != Some(format) {
            latest.format = Some(format);
            latest.generation += 1;
            latest.picture = vec![0; format.width as usize * format.height as usize * 4];
            latest.pictures = 0;
            latest.damage.clear();
        }
    }
    let params = buffer_params(format);
    let mut ptrs: Vec<*const c_void> = params.iter().map(|p| p.as_ptr().cast()).collect();
    let stream = l.shared.stream.load(std::sync::atomic::Ordering::Acquire);
    if let Ok(pw) = pw() {
        // SAFETY: called on PipeWire's thread from its own callback, the stream alive; the PODs are copied.
        unsafe { (pw.stream_update_params)(stream, ptrs.as_mut_ptr(), ptrs.len() as u32) };
    }
}

unsafe extern "C" fn on_process(data: *mut c_void) {
    let l = unsafe { listener(data) };
    let Ok(pw) = pw() else { return };
    let stream = l.shared.stream.load(std::sync::atomic::Ordering::Acquire);
    // The newest buffer; older ones queued back unread.
    let mut newest: *mut PwBuffer = std::ptr::null_mut();
    loop {
        // SAFETY: on PipeWire's thread, the stream alive.
        let b = unsafe { (pw.stream_dequeue_buffer)(stream) };
        if b.is_null() {
            break;
        }
        if !newest.is_null() {
            unsafe { (pw.stream_queue_buffer)(stream, newest) };
        }
        newest = b;
    }
    if newest.is_null() {
        return;
    }
    // SAFETY: `newest` is non-null, a dequeued buffer that is ours until queued back below; its spa_buffer (checked
    // for null too), metas and datas are PipeWire's arrays, alive for as long.
    unsafe {
        let spa = (*newest).buffer;
        if !spa.is_null() {
            take(l, &*spa);
        }
        (pw.stream_queue_buffer)(stream, newest);
    }
}

/// Reads one buffer: the cursor, then the picture if it carries one.
unsafe fn take(l: &Listener, b: &SpaBuffer) {
    let metas: &[SpaMeta] = if b.metas.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(b.metas, b.n_metas as usize) }
    };
    let meta = |kind: u32| metas.iter().find(|m| m.kind == kind && !m.data.is_null());
    let mut latest = l.shared.latest.lock().expect("stream poisoned");
    let Some(format) = latest.format else { return };
    if latest.pictures == 0 {
        let kinds: Vec<(u32, u32)> = metas.iter().map(|m| (m.kind, m.size)).collect();
        log::debug!("pipewire: buffers carry metadata (type, size) {kinds:?}");
    }
    if let Some(m) = meta(pod::META_CURSOR) {
        unsafe { cursor(l, &mut latest, m) };
    }
    if b.n_datas == 0 || b.datas.is_null() {
        return;
    }
    let d = unsafe { &*b.datas };
    if d.chunk.is_null() || d.data.is_null() {
        if d.kind == pod::DATA_DMA_BUF && latest.error.is_none() {
            latest.error = Some(
                "the compositor sent DMA-BUF frames, which this remoted cannot read yet".into(),
            );
            l.shared.wake.signal();
        }
        return;
    }
    let chunk = unsafe { &*d.chunk };
    if chunk.size == 0 || chunk.flags & CHUNK_FLAG_CORRUPTED != 0 {
        // A buffer with only the cursor in it.
        return;
    }
    let (w, h) = (format.width as usize, format.height as usize);
    let stride = if chunk.stride > 0 {
        chunk.stride as usize
    } else {
        w * 4
    };
    let offset = chunk.offset as usize % (d.maxsize.max(1) as usize);
    let len = (d.maxsize as usize).saturating_sub(offset);
    if stride < w * 4 || len < stride * (h - 1) + w * 4 {
        return;
    }
    let src = unsafe { std::slice::from_raw_parts((d.data as *const u8).add(offset), len) };
    // The compositor's damage, when it sends it; else every row, which the comparison below narrows.
    let mut regions: Vec<SpaMetaRegion> = Vec::new();
    if let Some(m) = meta(pod::META_VIDEO_DAMAGE) {
        let n = m.size as usize / size_of::<SpaMetaRegion>();
        let list = unsafe { std::slice::from_raw_parts(m.data as *const SpaMetaRegion, n) };
        for r in list {
            if r.w == 0 || r.h == 0 {
                break;
            }
            regions.push(*r);
        }
    }
    if regions.is_empty() || latest.pictures == 0 {
        regions = vec![SpaMetaRegion {
            x: 0,
            y: 0,
            w: w as u32,
            h: h as u32,
        }];
    }
    let swap = !matches!(
        format.format,
        pod::VIDEO_FORMAT_BGRX | pod::VIDEO_FORMAT_BGRA
    );
    let shift = matches!(
        format.format,
        pod::VIDEO_FORMAT_XRGB
            | pod::VIDEO_FORMAT_ARGB
            | pod::VIDEO_FORMAT_XBGR
            | pod::VIDEO_FORMAT_ABGR
    );
    let first = latest.pictures == 0;
    let mut changed = Vec::new();
    for r in regions {
        let x0 = (r.x.max(0) as usize).min(w);
        let y0 = (r.y.max(0) as usize).min(h);
        let x1 = (x0 + r.w as usize).min(w);
        let y1 = (y0 + r.h as usize).min(h);
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        // Rows of this region that differ from what is held, as runs: copied, and noted as damage.
        let mut run: Option<(usize, usize, usize)> = None; // (y0, x_min, x_max)
        for y in y0..y1 {
            let s = &src[y * stride + x0 * 4..y * stride + x1 * 4];
            let dst = &mut latest.picture[(y * w + x0) * 4..(y * w + x1) * 4];
            let differs = if swap || shift {
                convert_row(s, dst, format.format)
            } else if first || s != &dst[..] {
                dst.copy_from_slice(s);
                true
            } else {
                false
            };
            match (differs, run) {
                (true, None) => run = Some((y, x0, x1)),
                (true, Some(_)) => {}
                (false, Some((ry, a, b))) => {
                    changed.push((a as u32, ry as u32, b as u32, y as u32));
                    run = None;
                }
                (false, None) => {}
            }
        }
        if let Some((ry, a, b)) = run {
            changed.push((a as u32, ry as u32, b as u32, y1 as u32));
        }
    }
    latest.pictures += 1;
    if !changed.is_empty() {
        latest.damaged_at.get_or_insert_with(Instant::now);
        for (x0, y0, x1, y1) in changed {
            latest.damage.push(SpaMetaRegion {
                x: x0 as i32,
                y: y0 as i32,
                w: x1 - x0,
                h: y1 - y0,
            });
        }
        drop(latest);
        l.shared.wake.signal();
    }
}

/// Converts one row of 32-bit RGB in `format` to BGRX into `dst`; whether it changed.
fn convert_row(src: &[u8], dst: &mut [u8], format: u32) -> bool {
    let mut changed = false;
    for (s, d) in src
        .as_chunks::<4>()
        .0
        .iter()
        .zip(dst.as_chunks_mut::<4>().0)
    {
        let px = match format {
            pod::VIDEO_FORMAT_RGBX | pod::VIDEO_FORMAT_RGBA => [s[2], s[1], s[0], 0xff],
            pod::VIDEO_FORMAT_XRGB | pod::VIDEO_FORMAT_ARGB => [s[3], s[2], s[1], 0xff],
            pod::VIDEO_FORMAT_XBGR | pod::VIDEO_FORMAT_ABGR => [s[1], s[2], s[3], 0xff],
            _ => [s[0], s[1], s[2], 0xff],
        };
        if *d != px {
            *d = px;
            changed = true;
        }
    }
    changed
}

/// The cursor metadata: its position for viewers, and its shape when the compositor sends a new one.
unsafe fn cursor(l: &Listener, latest: &mut Latest, m: &SpaMeta) {
    if (m.size as usize) < size_of::<SpaMetaCursor>() {
        return;
    }
    let c = unsafe { &*(m.data as *const SpaMetaCursor) };
    log::trace!(
        "pipewire: cursor {} at {},{} bitmap at {}",
        c.id,
        c.x,
        c.y,
        c.bitmap_offset
    );
    if c.id == 0 {
        if !latest.cursor_hidden {
            latest.cursor_hidden = true;
            l.shared.hub.set_cursor(cast_core::clipboard::cursor(
                0,
                0,
                &[],
                (0, 0),
                Some("none"),
            ));
        }
        return;
    }
    l.shared.hub.pointer_at(c.x, c.y);
    let offset = c.bitmap_offset as usize;
    if offset < size_of::<SpaMetaCursor>() || offset + size_of::<SpaMetaBitmap>() > m.size as usize
    {
        if latest.cursor_hidden {
            latest.cursor_hidden = false;
            latest.cursor_id = 0;
        }
        return;
    }
    let bm = unsafe { &*((m.data as *const u8).add(offset) as *const SpaMetaBitmap) };
    if bm.w == 0 || bm.h == 0 || bm.w > 1024 || bm.h > 1024 {
        return;
    }
    let stride = if bm.stride > 0 {
        bm.stride as usize
    } else {
        bm.w as usize * 4
    };
    let start = offset + bm.offset as usize;
    let need = stride * (bm.h as usize - 1) + bm.w as usize * 4;
    if start + need > m.size as usize {
        return;
    }
    let px = unsafe { std::slice::from_raw_parts((m.data as *const u8).add(start), need) };
    let mut rgba = Vec::with_capacity(bm.w as usize * bm.h as usize * 4);
    for y in 0..bm.h as usize {
        for s in px[y * stride..y * stride + bm.w as usize * 4]
            .as_chunks::<4>()
            .0
        {
            rgba.extend_from_slice(&match bm.format {
                pod::VIDEO_FORMAT_BGRA | pod::VIDEO_FORMAT_BGRX => [s[2], s[1], s[0], s[3]],
                pod::VIDEO_FORMAT_ARGB | pod::VIDEO_FORMAT_XRGB => [s[1], s[2], s[3], s[0]],
                pod::VIDEO_FORMAT_ABGR | pod::VIDEO_FORMAT_XBGR => [s[3], s[2], s[1], s[0]],
                _ => [s[0], s[1], s[2], s[3]],
            });
        }
    }
    latest.cursor_id = c.id;
    latest.cursor_hidden = false;
    let hot = (c.hot_x.max(0) as u32, c.hot_y.max(0) as u32);
    l.shared
        .hub
        .set_cursor(cast_core::clipboard::cursor(bm.w, bm.h, &rgba, hot, None));
}

/// The capture side: the picture the encoder reads, brought up to date from PipeWire's latest on each pump.
struct PwCapture {
    shared: Arc<Shared>,
    generation: u64,
    source_stride: usize,
    width: u32,
    height: u32,
    picture: Vec<u8>,
    damage: Damage,
    rebuild: bool,
}

impl Capture for PwCapture {
    fn area(&self) -> Rect {
        Rect {
            x: 0,
            y: 0,
            w: self.width,
            h: self.height,
        }
    }

    fn screen(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn cropped(&self) -> bool {
        false
    }

    fn damage(&mut self) -> &mut Damage {
        &mut self.damage
    }

    fn waitable(&self) -> Option<Waitable<'_>> {
        Some(self.shared.wake.waitable())
    }

    fn pump(&mut self) -> Result<(), String> {
        self.shared.wake.drain();
        let mut latest = self.shared.latest.lock().expect("stream poisoned");
        if let Some(e) = &latest.error {
            return Err(e.clone());
        }
        if latest.generation != self.generation {
            self.rebuild = true;
            return Ok(());
        }
        if latest.damage.is_empty() {
            return Ok(());
        }
        if let Some(at) = latest.damaged_at.take() {
            self.damage.damaged_at.get_or_insert(at);
        }
        let row = self.width as usize * 4;
        for r in std::mem::take(&mut latest.damage) {
            let x0 = (r.x.max(0) as u32).min(self.width);
            let y0 = (r.y.max(0) as u32).min(self.height);
            let x1 = (x0 + r.w).min(self.width);
            let y1 = (y0 + r.h).min(self.height);
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            for y in y0 as usize..y1 as usize {
                let s = &latest.picture[y * self.source_stride + x0 as usize * 4
                    ..y * self.source_stride + x1 as usize * 4];
                self.picture[y * row + x0 as usize * 4..y * row + x1 as usize * 4]
                    .copy_from_slice(s);
            }
            self.damage.add(x0, y0, x1, y1);
        }
        Ok(())
    }

    fn needs_rebuild(&self) -> bool {
        self.rebuild
    }

    fn geometry_changed(&self) -> bool {
        self.rebuild
    }

    fn pixels(&self) -> Option<(&[u8], usize)> {
        Some((&self.picture, self.width as usize * 4))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_structs_keep_pipewires_layout() {
        assert_eq!(size_of::<SpaHook>(), 48);
        assert_eq!(size_of::<SpaData>(), 40);
        assert_eq!(size_of::<SpaChunk>(), 16);
        assert_eq!(size_of::<SpaBuffer>(), 24);
        assert_eq!(size_of::<SpaMeta>(), 16);
        assert_eq!(size_of::<SpaMetaCursor>(), 28);
        assert_eq!(size_of::<SpaMetaBitmap>(), 20);
        assert_eq!(size_of::<SpaMetaRegion>(), 16);
        assert_eq!(std::mem::offset_of!(PwStreamEvents, process), 64);
    }

    #[test]
    fn rgb_rows_become_bgrx_and_say_whether_they_changed() {
        let src = [1, 2, 3, 4, 5, 6, 7, 8];
        let mut dst = [0u8; 8];
        assert!(convert_row(&src, &mut dst, pod::VIDEO_FORMAT_RGBX));
        assert_eq!(dst, [3, 2, 1, 0xff, 7, 6, 5, 0xff]);
        assert!(!convert_row(&src, &mut dst, pod::VIDEO_FORMAT_RGBX));
        assert!(convert_row(&src, &mut dst, pod::VIDEO_FORMAT_XRGB));
        assert_eq!(dst, [4, 3, 2, 0xff, 8, 7, 6, 0xff]);
    }
}
