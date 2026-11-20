//! What the computer plays, as cast-core's [`AudioSource`]: WASAPI loopback of the default output device (no driver,
//! nothing installed), in shared mode with Windows converting the device's own format to cast-core's 48 kHz stereo
//! 16-bit (`AUTOCONVERTPCM`). The capture buffer is 20 ms and is drained every 2 ms, so a 10 ms packet leaves within
//! about 12 ms of being played. When nothing plays, loopback delivers nothing at all: a read that waited a whole
//! packet's time returns silence, which cast-core does not send, and its loop goes on noticing whether anyone still
//! listens. The default device is looked up at every open, so headphones plugged in are followed after the old
//! device's capture fails (`AUDCLNT_E_DEVICE_INVALIDATED` closes it; cast-core opens it again).
//!
//! The loop follows voxl's Windows loopback (MIT).

use cast_core::audio::{AudioSource, CHANNELS, FRAME, RATE};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, IAudioCaptureClient,
    IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX, eConsole, eRender,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
};

const WAVE_FORMAT_PCM: u16 = 1;

/// WASAPI loopback of the default output device.
#[derive(Default)]
pub struct Loopback {
    client: Option<IAudioClient>,
    capture: Option<IAudioCaptureClient>,
    /// Interleaved stereo samples read and not yet handed out.
    pending: VecDeque<i16>,
}

// The COM objects are used on the audio thread alone, which opens, reads and closes them.
unsafe impl Send for Loopback {}

impl Loopback {
    pub fn new() -> Loopback {
        Loopback::default()
    }

    /// Moves what WASAPI holds into `pending`.
    fn drain(&mut self) -> Result<(), String> {
        let cap = self.capture.as_ref().ok_or("loopback is not open")?;
        // SAFETY: the capture client's buffer, read and released packet by packet.
        unsafe {
            loop {
                match cap.GetNextPacketSize() {
                    Ok(0) => return Ok(()),
                    Ok(_) => {}
                    Err(e) => return Err(format!("loopback: {e}")),
                }
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .map_err(|e| format!("loopback: {e}"))?;
                let n = frames as usize * CHANNELS as usize;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    self.pending.extend(std::iter::repeat_n(0i16, n));
                } else {
                    self.pending.extend(
                        std::slice::from_raw_parts(data as *const i16, n)
                            .iter()
                            .copied(),
                    );
                }
                let _ = cap.ReleaseBuffer(frames);
            }
        }
    }
}

impl AudioSource for Loopback {
    fn open(&mut self) -> Result<(), String> {
        let e = |e: windows::core::Error| format!("loopback: {e}");
        // SAFETY: COM on this (the audio) thread, and the default output device's audio client.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let en: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(e)?;
            let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).map_err(e)?;
            let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(e)?;
            let align = u16::from(CHANNELS) * 2;
            let fmt = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_PCM,
                nChannels: u16::from(CHANNELS),
                nSamplesPerSec: RATE,
                nAvgBytesPerSec: RATE * u32::from(align),
                nBlockAlign: align,
                wBitsPerSample: 16,
                cbSize: 0,
            };
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    // 20 ms of buffer, in 100 ns units.
                    200_000,
                    0,
                    &fmt,
                    None,
                )
                .map_err(e)?;
            let capture: IAudioCaptureClient = client.GetService().map_err(e)?;
            client.Start().map_err(e)?;
            self.client = Some(client);
            self.capture = Some(capture);
        }
        self.pending.clear();
        Ok(())
    }

    fn read(&mut self, pcm: &mut [i16]) -> Result<(), String> {
        let want = FRAME * CHANNELS as usize;
        // A packet's worth of time: if nothing played by then, it is a packet of silence.
        let deadline = Instant::now() + Duration::from_millis(10);
        loop {
            self.drain()?;
            if self.pending.len() >= want {
                for (dst, src) in pcm[..want].iter_mut().zip(self.pending.drain(..want)) {
                    *dst = src;
                }
                return Ok(());
            }
            if Instant::now() >= deadline {
                let have = self.pending.len();
                for (i, dst) in pcm[..want].iter_mut().enumerate() {
                    *dst = if i < have { self.pending[i] } else { 0 };
                }
                self.pending.clear();
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn close(&mut self) {
        if let Some(c) = self.client.take() {
            // SAFETY: the client `open` started.
            let _ = unsafe { c.Stop() };
        }
        self.capture = None;
        self.pending.clear();
    }
}
