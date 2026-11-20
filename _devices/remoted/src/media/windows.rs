//! The Windows platform: cast-win. Every monitor attached to the desktop is a screen, captured with DXGI Desktop
//! Duplication (GDI where Windows refuses it), encoded by the first of NVENC, Media Foundation's hardware encoder and
//! openh264 that passes its self-test on that monitor's GPU, typed into with SendInput, its clipboard both ways, and the
//! computer's sound through WASAPI loopback, Opus-encoded.
//!
//! The self-tests run once, in the background, when the platform is first asked about its monitors, so `/info` lists
//! the encoders that passed without waiting for them; a screen opened before they finished runs them itself (they are
//! kept for the process's life, so never twice).

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use browser_wire::MediaAudio;
use cast_core::hub::Hub;
use cast_core::video::VideoConfig;

use super::Monitor;
use super::platform::{Opened, Platform};

/// How long a monitor list answers `/info` and the status line before DXGI is asked again.
const MONITORS_FRESH: Duration = Duration::from_secs(1);

pub struct Windows {
    monitors: Mutex<Option<(Instant, Vec<Monitor>)>>,
    /// Each monitor's encoder as its self-tests chose it, by monitor id, once the background tests finished.
    chosen: Arc<Mutex<Vec<(String, String)>>>,
    warmed: std::sync::Once,
}

impl Windows {
    pub fn new() -> Windows {
        cast_win::init_process();
        Windows {
            monitors: Mutex::new(None),
            chosen: Arc::new(Mutex::new(Vec::new())),
            warmed: std::sync::Once::new(),
        }
    }

    /// Runs every monitor's encoder self-tests on a thread of their own, once.
    fn warm(&self) {
        self.warmed.call_once(|| {
            let chosen = self.chosen.clone();
            let started = std::thread::Builder::new()
                .name("encoder-tests".into())
                .spawn(move || {
                    for d in cast_win::displays::displays() {
                        let c = cast_win::select::choose(&d);
                        log::info!("{} ({}): {}", d.name, d.id, c.label);
                        chosen
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .push((d.id.clone(), c.label));
                    }
                });
            if let Err(e) = started {
                log::warn!("encoder self-tests did not start: {e}");
            }
        });
    }
}

impl Default for Windows {
    fn default() -> Windows {
        Windows::new()
    }
}

impl Platform for Windows {
    fn monitors(&self) -> Vec<Monitor> {
        self.warm();
        let mut cached = self.monitors.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((at, list)) = cached.as_ref()
            && at.elapsed() < MONITORS_FRESH
        {
            return list.clone();
        }
        let list: Vec<Monitor> = cast_win::displays::displays()
            .into_iter()
            .map(|d| Monitor {
                width: d.width(),
                height: d.height(),
                id: d.id,
                name: d.name,
                x: d.rect.left,
                y: d.rect.top,
                scale: d.scale,
                primary: d.primary,
            })
            .collect();
        *cached = Some((Instant::now(), list.clone()));
        list
    }

    fn encoders(&self) -> Vec<String> {
        self.warm();
        let mut out: Vec<String> = Vec::new();
        for (_, label) in self
            .chosen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
        {
            if !out.contains(label) {
                out.push(label.clone());
            }
        }
        if !out.iter().any(|e| e == "openh264") {
            out.push("openh264".into());
        }
        out
    }

    fn describe(&self) -> serde_json::Value {
        serde_json::json!({
            "mode": "dxgi",
            "encoders": self
                .chosen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .iter()
                .map(|(id, label)| serde_json::json!({ "monitor": id, "encoder": label }))
                .collect::<Vec<_>>(),
            "audio": audio_format().is_some(),
        })
    }

    fn audio_format(&self, _monitor: &str) -> Option<MediaAudio> {
        audio_format()
    }

    fn open(&self, monitor: &str, hub: &Arc<Hub>, base: VideoConfig) -> Result<Opened, String> {
        let screen = cast_win::screen::open(monitor, hub, base)?;
        let stops = screen.stops();
        Ok(Opened {
            source: Box::new(screen.source),
            video: screen.video,
            input: screen.input,
            audio: audio_format().map(|_| {
                Box::new(cast_win::audio::Loopback::new()) as Box<dyn cast_core::audio::AudioSource>
            }),
            stops,
        })
    }
}

/// The computer's sound: a Windows build always encodes Opus (cast-core's opus1, where no libopus is linked).
fn audio_format() -> Option<MediaAudio> {
    Some(cast_core::audio::format())
}
