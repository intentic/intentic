//! One monitor put together for cast-core's pipeline: the encoder its self-tests chose, the capture that fills frames
//! where that encoder reads them, input mapped onto the monitor's place on the virtual desktop, and the clipboard. What
//! intentic-remoted's Windows platform and the `serve` example both open.

use crate::capture::{DxgiSource, Geometry};
use crate::displays;
use cast_core::hub::Hub;
use cast_core::video::VideoConfig;
use parking_lot::Mutex;
use std::sync::Arc;

pub struct Screen {
    pub source: DxgiSource,
    /// `base`, with the chosen encoder.
    pub video: VideoConfig,
    /// What it is encoded with, for `/info` and the log.
    pub encoder: String,
    pub passed_over: Vec<(String, String)>,
    /// Where the monitor sits on the virtual desktop, kept current by the capture: what input maps points with.
    pub geometry: Arc<Mutex<Geometry>>,
    pub name: String,
    /// SendInput for this monitor's viewers (cast-core's input thread).
    pub input: Option<cast_core::input::Input>,
    /// The clipboard watcher, stopped with the screen.
    pub clipboard: Option<crate::clipboard::Clipboard>,
}

impl Screen {
    /// What the screen's owner calls once its pipeline stopped: the clipboard watcher ends (the input thread ends when
    /// its last handle drops).
    pub fn stops(&self) -> Vec<Box<dyn FnOnce() + Send>> {
        let mut out: Vec<Box<dyn FnOnce() + Send>> = Vec::new();
        if let Some(c) = self.clipboard.clone() {
            out.push(Box::new(move || c.stop()));
        }
        out
    }
}

/// Opens monitor `id` for `hub`, starting from `base` (fps, quality, the bitrate's range).
pub fn open(id: &str, hub: &Arc<Hub>, base: VideoConfig) -> Result<Screen, String> {
    crate::init_process();
    let display = displays::find(id).ok_or_else(|| format!("no monitor {id} on this computer"))?;
    let choice = crate::select::choose(&display);
    for (what, why) in &choice.passed_over {
        log::info!("{}: {what} passed over ({why})", display.name);
    }
    log::info!("{}: encoded with {}", display.name, choice.label);
    hub.set_scale(display.scale);
    let source = DxgiSource::new(id, hub.clone(), choice.sink);
    let geometry = source.geometry.clone();
    let mut video = base;
    video.encoder = choice.encoders;
    // Hardware encoders are one engine each (video.rs never stripes for them); openh264 gets threads of its own.
    if video.encoder.primary.name() == "openh264" {
        video.threads = video.threads.max(2);
    }
    let clipboard = match crate::clipboard::Clipboard::spawn(hub.clone()) {
        Ok(c) => Some(c),
        Err(e) => {
            log::warn!("{}: no clipboard ({e})", display.name);
            None
        }
    };
    let input = match crate::input::spawn(geometry.clone(), clipboard.clone(), display.scale) {
        Ok(i) => Some(i),
        Err(e) => {
            log::warn!("{}: no input ({e})", display.name);
            None
        }
    };
    Ok(Screen {
        source,
        video,
        encoder: choice.label,
        passed_over: choice.passed_over,
        geometry,
        name: display.name,
        input,
        clipboard,
    })
}

/// CPU time this process has used, user and kernel, in seconds.
pub fn process_cpu_seconds() -> f64 {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let (mut c, mut e, mut k, mut u) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    let ft = |f: FILETIME| {
        ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64 / 1e7
    };
    // SAFETY: the current process's pseudo-handle and four FILETIMEs to fill.
    match unsafe { GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) } {
        Ok(()) => ft(k) + ft(u),
        Err(_) => 0.0,
    }
}
