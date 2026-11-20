//! A PulseAudio source as the screen's sound (voxl's): castd's is the window's sink's monitor. Linux, the `pulse`
//! feature; PipeWire's Pulse server answers it too.

use crate::audio::{AudioSource, CHANNELS, FRAME, RATE};
use std::ffi::{CString, c_char, c_int, c_void};

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

// libpulse's PA_SAMPLE_S16LE and PA_STREAM_RECORD.
const PA_SAMPLE_S16LE: c_int = 3;
const PA_STREAM_RECORD: c_int = 2;

/// One PulseAudio source, recorded 10 ms at a time while open.
pub struct Pulse {
    source: CString,
    stream: *mut c_void,
}

// The stream is used by one thread at a time: the audio thread that owns the source.
unsafe impl Send for Pulse {}

impl Pulse {
    /// The source named `source` (`--audio-source`).
    pub fn new(source: String) -> Result<Pulse, String> {
        let source =
            CString::new(source).map_err(|_| "--audio-source holds a NUL byte".to_string())?;
        Ok(Pulse {
            source,
            stream: std::ptr::null_mut(),
        })
    }
}

impl AudioSource for Pulse {
    fn open(&mut self) -> Result<(), String> {
        self.close();
        let name = c"castd";
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
        let mut err = 0;
        // SAFETY: NUL-terminated names and specs that outlive the call.
        let s = unsafe {
            pa_simple_new(
                std::ptr::null(),
                name.as_ptr(),
                PA_STREAM_RECORD,
                self.source.as_ptr(),
                name.as_ptr(),
                &ss,
                std::ptr::null(),
                &attr,
                &mut err,
            )
        };
        if s.is_null() {
            return Err(format!("pulse connect failed ({err})"));
        }
        self.stream = s;
        Ok(())
    }

    fn read(&mut self, pcm: &mut [i16]) -> Result<(), String> {
        if self.stream.is_null() {
            return Err("pulse read on a closed source".into());
        }
        let mut err = 0;
        // SAFETY: an open stream, and pcm's own length in bytes.
        let read = unsafe {
            pa_simple_read(
                self.stream,
                pcm.as_mut_ptr() as *mut c_void,
                pcm.len() * 2,
                &mut err,
            )
        };
        if read < 0 {
            return Err(format!("pulse read failed ({err})"));
        }
        Ok(())
    }

    fn close(&mut self) {
        if !self.stream.is_null() {
            // SAFETY: the stream pa_simple_new made, freed once.
            unsafe { pa_simple_free(self.stream) };
            self.stream = std::ptr::null_mut();
        }
    }
}

impl Drop for Pulse {
    fn drop(&mut self) {
        self.close();
    }
}
