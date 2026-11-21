//! The screen's sound (voxl's): an [`AudioSource`] -> Opus, 10 ms packets, to every viewer that turned sound on.
//! Captures only while one has; silence is not sent. castd's source is a PulseAudio monitor (pulse.rs); a Windows
//! backend's would be WASAPI loopback, resampled to what [`AudioSource::read`] promises.

use browser_wire::MediaAudio;

pub const RATE: u32 = 48000;
pub const CHANNELS: u8 = 2;
/// Samples per channel in one packet: 10 ms.
pub const FRAME: usize = 480;

/// The sound's format for `hello`: Opus, 48 kHz stereo.
pub fn format() -> MediaAudio {
    MediaAudio {
        codec: "opus".into(),
        sample_rate: RATE,
        channels: CHANNELS,
    }
}

/// Where the sound comes from. Runs on the audio thread ([`spawn`]): `open` when the first viewer turns sound on,
/// `read` until nobody listens (checked every half second), then `close`.
pub trait AudioSource: Send + 'static {
    /// Starts capturing; an error is logged and the open tried again two seconds later.
    fn open(&mut self) -> Result<(), String>;
    /// Blocks until the next 10 ms are in `pcm`: 48 kHz, stereo, signed 16-bit, interleaved (FRAME * CHANNELS
    /// samples). An error closes the source, which is opened again while viewers listen.
    fn read(&mut self, pcm: &mut [i16]) -> Result<(), String>;
    /// Stops capturing.
    fn close(&mut self);
}

/// A platform's source picked at run time (a daemon's `Box<dyn AudioSource>`) is a source too.
impl AudioSource for Box<dyn AudioSource> {
    fn open(&mut self) -> Result<(), String> {
        (**self).open()
    }
    fn read(&mut self, pcm: &mut [i16]) -> Result<(), String> {
        (**self).read(pcm)
    }
    fn close(&mut self) {
        (**self).close()
    }
}

#[cfg(feature = "opus")]
pub use opus::spawn;

#[cfg(any(feature = "opus", feature = "opus1"))]
mod opus {
    use super::{AudioSource, CHANNELS, FRAME, RATE};
    use crate::header::{Header, KIND_AUDIO};
    use crate::hub::{Hub, Media, Out};
    use bytes::Bytes;
    #[cfg(feature = "opus")]
    use std::ffi::{c_int, c_void};
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    #[cfg(feature = "opus")]
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
        fn opus_encoder_destroy(st: *mut c_void);
    }

    // Opus's OPUS_APPLICATION_RESTRICTED_LOWDELAY and OPUS_SET_BITRATE.
    #[cfg(feature = "opus")]
    const OPUS_APPLICATION_RESTRICTED_LOWDELAY: c_int = 2051;
    #[cfg(feature = "opus")]
    const OPUS_SET_BITRATE_REQUEST: c_int = 4002;

    #[cfg(feature = "opus")]
    struct Encoder(*mut c_void);

    // One thread (the audio thread) uses the encoder.
    #[cfg(feature = "opus")]
    unsafe impl Send for Encoder {}

    #[cfg(feature = "opus")]
    impl Encoder {
        fn new(bitrate: i32) -> Result<Encoder, String> {
            let mut err = 0;
            // SAFETY: libopus allocates the encoder; null on failure.
            let enc = unsafe {
                opus_encoder_create(
                    RATE as i32,
                    c_int::from(CHANNELS),
                    OPUS_APPLICATION_RESTRICTED_LOWDELAY,
                    &mut err,
                )
            };
            if enc.is_null() {
                return Err(format!("opus init failed: {err}"));
            }
            // SAFETY: a live encoder and the request's one int argument.
            unsafe { opus_encoder_ctl(enc, OPUS_SET_BITRATE_REQUEST, bitrate as c_int) };
            Ok(Encoder(enc))
        }

        /// One 10 ms frame into `out`; the packet's length, or None.
        fn encode(&mut self, pcm: &[i16], out: &mut [u8]) -> Option<usize> {
            if pcm.len() < FRAME * CHANNELS as usize {
                return None;
            }
            // SAFETY: pcm holds a whole frame, out its stated length.
            let n = unsafe {
                opus_encode(
                    self.0,
                    pcm.as_ptr(),
                    FRAME as c_int,
                    out.as_mut_ptr(),
                    out.len() as i32,
                )
            };
            (n > 0).then_some(n as usize)
        }
    }

    #[cfg(feature = "opus")]
    impl Drop for Encoder {
        fn drop(&mut self) {
            // SAFETY: the encoder opus_encoder_create made, dropped once.
            unsafe { opus_encoder_destroy(self.0) }
        }
    }

    /// Without libopus (a Windows build has none to link): opus1, libopus 1.6 ported to Rust (BSD-3-Clause), with
    /// the same settings, restricted low delay at the asked bitrate.
    #[cfg(not(feature = "opus"))]
    struct Encoder(Box<opus1::OpusEncoder>);

    #[cfg(not(feature = "opus"))]
    impl Encoder {
        fn new(bitrate: i32) -> Result<Encoder, String> {
            const _: () = assert!(RATE == 48000, "opus1 is opened at 48 kHz");
            let mut enc = opus1::OpusEncoder::new(
                opus1::SampleRate::Hz48000,
                opus1::Channels::Stereo,
                opus1::Application::RestrictedLowDelay,
            )
            .map_err(|e| format!("opus init failed: {e:?}"))?;
            if let Some(bps) = std::num::NonZeroU32::new(bitrate.max(6000) as u32) {
                enc.set_bitrate(opus1::Bitrate::BitsPerSecond(bps));
            }
            Ok(Encoder(Box::new(enc)))
        }

        /// One 10 ms frame into `out`; the packet's length, or None.
        fn encode(&mut self, pcm: &[i16], out: &mut [u8]) -> Option<usize> {
            if pcm.len() < FRAME * CHANNELS as usize {
                return None;
            }
            let n = self
                .0
                .encode_i16(&pcm[..FRAME * CHANNELS as usize], FRAME, out)
                .ok()?;
            (n > 0).then_some(n)
        }
    }

    #[cfg(all(test, not(feature = "opus")))]
    mod opus1_tests {
        use super::{CHANNELS, Encoder, FRAME};

        #[test]
        fn opus1_encodes_ten_ms_of_stereo_and_its_packet_decodes() {
            let mut enc = Encoder::new(64_000).unwrap();
            let pcm: Vec<i16> = (0..FRAME * CHANNELS as usize)
                .map(|i| ((i as f32 / 2.0 * 0.06).sin() * 8000.0) as i16)
                .collect();
            let mut out = vec![0u8; 4000];
            let n = enc.encode(&pcm, &mut out).expect("a packet");
            assert!(n > 10 && n < 400, "{n} bytes for 10 ms at 64 kbit/s");
            let mut dec =
                opus1::OpusDecoder::new(opus1::SampleRate::Hz48000, opus1::Channels::Stereo)
                    .unwrap();
            let mut back = vec![0f32; FRAME * CHANNELS as usize];
            assert_eq!(dec.decode(&out[..n], FRAME, &mut back).unwrap(), FRAME);
        }
    }

    /// Starts the audio thread (named `audio`) on `source`, Opus at `bitrate` bits per second.
    pub fn spawn(source: impl AudioSource, bitrate: i32, hub: Arc<Hub>) {
        let started = std::thread::Builder::new()
            .name("audio".into())
            .spawn(move || capture(source, bitrate, hub));
        if let Err(e) = started {
            log::error!("audio thread: {e}");
        }
    }

    fn capture(mut source: impl AudioSource, bitrate: i32, hub: Arc<Hub>) {
        let mut enc = match Encoder::new(bitrate) {
            Ok(e) => e,
            Err(e) => {
                log::error!("{e}");
                return;
            }
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
            // The pipeline stopped (`video::Video::stop`): so does the sound.
            if hub.is_stopped() {
                return;
            }
            if !want() {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            if let Err(e) = source.open() {
                log::warn!("{e}; retrying");
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            log::info!("audio capture started");
            let mut checked = 0u32;
            loop {
                if let Err(e) = source.read(&mut pcm) {
                    log::warn!("{e}");
                    break;
                }
                let captured = Instant::now();
                checked += 1;
                if checked.is_multiple_of(50) && (!want() || hub.is_stopped()) {
                    break;
                }
                if pcm.iter().all(|&s| s == 0) {
                    continue;
                }
                let Some(n) = enc.encode(&pcm, &mut out) else {
                    continue;
                };
                let packet = Arc::new(Media {
                    header: Header {
                        kind: KIND_AUDIO,
                        ..Header::default()
                    },
                    captured,
                    payload: Bytes::copy_from_slice(&out[..n]),
                });
                for c in hub.clients.lock().iter() {
                    if c.audio.load(Ordering::Relaxed) && c.video.load(Ordering::Relaxed) {
                        c.send(Out::Media(packet.clone()));
                    }
                }
            }
            source.close();
            log::info!("audio capture stopped");
        }
    }
}

#[cfg(all(feature = "opus1", not(feature = "opus")))]
pub use opus::spawn;
