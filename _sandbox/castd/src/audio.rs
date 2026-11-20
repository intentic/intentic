//! The window's sound (voxl's): a PulseAudio source (the window's sink's monitor) -> Opus, 10 ms packets, to every viewer
//! that turned sound on. Captures only while one has; silence is not sent.

use crate::header::{Header, KIND_AUDIO};
use crate::hub::{Hub, Media, Out};
use bytes::Bytes;
use std::ffi::{CString, c_char, c_int, c_void};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

#[repr(C)]
struct PaSampleSpec {
    format: c_int,
    rate: u32,
    channels: u8,
}
#[repr(C)]
struct PaBufferAttr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    fragsize: u32,
}
#[link(name = "pulse-simple")]
unsafe extern "C" {
    fn pa_simple_new(
        server: *const c_char,
        name: *const c_char,
        dir: c_int,
        dev: *const c_char,
        stream: *const c_char,
        ss: *const PaSampleSpec,
        map: *const c_void,
        attr: *const PaBufferAttr,
        error: *mut c_int,
    ) -> *mut c_void;
    fn pa_simple_read(s: *mut c_void, data: *mut c_void, bytes: usize, error: *mut c_int) -> c_int;
    fn pa_simple_free(s: *mut c_void);
}
#[link(name = "opus")]
unsafe extern "C" {
    fn opus_encoder_create(
        fs: i32,
        channels: c_int,
        application: c_int,
        error: *mut c_int,
    ) -> *mut c_void;
    fn opus_encoder_ctl(st: *mut c_void, request: c_int, ...) -> c_int;
    fn opus_encode(
        st: *mut c_void,
        pcm: *const i16,
        frame_size: c_int,
        data: *mut u8,
        max: i32,
    ) -> i32;
}

pub const RATE: u32 = 48000;
pub const CHANNELS: u8 = 2;
const FRAME: usize = 480;
// libpulse's PA_SAMPLE_S16LE and PA_STREAM_RECORD; Opus's OPUS_APPLICATION_RESTRICTED_LOWDELAY and OPUS_SET_BITRATE.
const PA_SAMPLE_S16LE: c_int = 3;
const PA_STREAM_RECORD: c_int = 2;
const OPUS_APPLICATION_RESTRICTED_LOWDELAY: c_int = 2051;
const OPUS_SET_BITRATE_REQUEST: c_int = 4002;

pub fn spawn(source: String, bitrate: i32, hub: Arc<Hub>) {
    let started = std::thread::Builder::new()
        .name("audio".into())
        .spawn(move || unsafe { capture(source, bitrate, hub) });
    if let Err(e) = started {
        log::error!("audio thread: {e}");
    }
}

/// # Safety
/// Calls into libopus and libpulse with buffers sized as their APIs require.
unsafe fn capture(source: String, bitrate: i32, hub: Arc<Hub>) {
    let mut err = 0;
    let enc = unsafe {
        opus_encoder_create(
            RATE as i32,
            c_int::from(CHANNELS),
            OPUS_APPLICATION_RESTRICTED_LOWDELAY,
            &mut err,
        )
    };
    if enc.is_null() {
        log::error!("opus init failed: {err}");
        return;
    }
    unsafe { opus_encoder_ctl(enc, OPUS_SET_BITRATE_REQUEST, bitrate as c_int) };
    let name = c"castd";
    let Ok(dev) = CString::new(source) else {
        log::error!("--audio-source holds a NUL byte");
        return;
    };
    let ss = PaSampleSpec {
        format: PA_SAMPLE_S16LE,
        rate: RATE,
        channels: CHANNELS,
    };
    let frag = (FRAME * 4) as u32;
    let attr = PaBufferAttr {
        maxlength: frag * 8,
        tlength: u32::MAX,
        prebuf: u32::MAX,
        minreq: u32::MAX,
        fragsize: frag,
    };
    let mut pcm = vec![0i16; FRAME * CHANNELS as usize];
    let mut out = vec![0u8; 4000];
    let want = || {
        hub.clients
            .lock()
            .iter()
            .any(|c| c.audio.load(Ordering::Relaxed))
    };
    loop {
        if !want() {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        let s = unsafe {
            pa_simple_new(
                std::ptr::null(),
                name.as_ptr(),
                PA_STREAM_RECORD,
                dev.as_ptr(),
                name.as_ptr(),
                &ss,
                std::ptr::null(),
                &attr,
                &mut err,
            )
        };
        if s.is_null() {
            log::warn!("pulse connect failed ({err}); retrying");
            std::thread::sleep(Duration::from_secs(2));
            continue;
        }
        log::info!("audio capture started");
        let mut checked = 0u32;
        loop {
            let read = unsafe {
                pa_simple_read(s, pcm.as_mut_ptr() as *mut c_void, pcm.len() * 2, &mut err)
            };
            if read < 0 {
                log::warn!("pulse read failed ({err})");
                break;
            }
            let captured = Instant::now();
            checked += 1;
            if checked.is_multiple_of(50) && !want() {
                break;
            }
            if pcm.iter().all(|&s| s == 0) {
                continue;
            }
            let n = unsafe {
                opus_encode(
                    enc,
                    pcm.as_ptr(),
                    FRAME as c_int,
                    out.as_mut_ptr(),
                    out.len() as i32,
                )
            };
            if n <= 0 {
                continue;
            }
            let packet = Arc::new(Media {
                header: Header {
                    kind: KIND_AUDIO,
                    ..Header::default()
                },
                captured,
                payload: Bytes::copy_from_slice(&out[..n as usize]),
            });
            for c in hub.clients.lock().iter() {
                if c.audio.load(Ordering::Relaxed) && c.video.load(Ordering::Relaxed) {
                    c.send(Out::Media(packet.clone()));
                }
            }
        }
        unsafe { pa_simple_free(s) };
        log::info!("audio capture stopped");
    }
}
