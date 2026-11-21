//! Which encoder a Linux screen is sent with. NVENC where an NVIDIA driver answers castd's self-test (the driver's
//! libraries are opened at run time, so a build with the `nvenc` feature runs anywhere), else the software encoder
//! (openh264 in the default build). The test runs once, on a thread of its own as remoted starts, so `/info` never
//! waits for it; a screen opened before it finished waits for it.

use std::sync::{Arc, Condvar, Mutex};

use cast_core::encoder::{EncoderKind, Encoders};

/// What the probe found: the encoder screens use first, and a line for each encoder about why it is or is not used.
#[derive(Clone)]
pub struct Picked {
    pub primary: Arc<dyn EncoderKind>,
    /// `(name, "ok" | why not)`, the one used first.
    pub notes: Vec<(String, String)>,
}

pub struct Probe {
    done: Mutex<Option<Picked>>,
    ready: Condvar,
}

impl Probe {
    /// Starts the probe on a thread named `encoder-probe`.
    pub fn start() -> Arc<Probe> {
        let probe = Arc::new(Probe {
            done: Mutex::new(None),
            ready: Condvar::new(),
        });
        let running = probe.clone();
        let started = std::thread::Builder::new()
            .name("encoder-probe".into())
            .spawn(move || {
                let picked = pick();
                *running.done.lock().expect("probe poisoned") = Some(picked);
                running.ready.notify_all();
            });
        if started.is_err() {
            *probe.done.lock().expect("probe poisoned") = Some(pick());
        }
        probe
    }

    /// The result, once there is one.
    pub fn peek(&self) -> Option<Picked> {
        self.done.lock().expect("probe poisoned").clone()
    }

    /// The result, waiting for the probe when it still runs.
    pub fn wait(&self) -> Picked {
        let mut done = self.done.lock().expect("probe poisoned");
        while done.is_none() {
            done = self.ready.wait(done).expect("probe poisoned");
        }
        done.clone().expect("a result")
    }

    /// What screens are encoded with: the picked encoder, the software one taking what it cannot open.
    pub fn encoders(&self) -> Encoders {
        Encoders {
            primary: self.wait().primary,
            fallback: super::super::software(),
        }
    }
}

/// `INTENTIC_REMOTED_ENCODER`: `software` keeps the hardware encoders out (a comparison, a driver misbehaving).
fn pick() -> Picked {
    let software = super::super::software();
    let mut notes = Vec::new();
    let forced_software = std::env::var("INTENTIC_REMOTED_ENCODER").is_ok_and(|e| e == "software");
    let mut primary = None;
    for (name, test) in hardware() {
        if forced_software {
            notes.push((name.to_owned(), "left out (INTENTIC_REMOTED_ENCODER=software)".to_owned()));
            continue;
        }
        let started = std::time::Instant::now();
        match test() {
            Ok(kind) => {
                log::info!("encoder {name}: self-test passed ({} ms)", started.elapsed().as_millis());
                notes.push((name.to_owned(), "ok".to_owned()));
                primary.get_or_insert(kind);
            }
            Err(why) => {
                log::info!("encoder {name}: not used: {why}");
                notes.push((name.to_owned(), why));
            }
        }
    }
    notes.push((
        software.name().to_owned(),
        if software.name() == "none" {
            "this build has no software H.264 encoder".to_owned()
        } else {
            "ok".to_owned()
        },
    ));
    // The one used first leads the list.
    let primary = primary.unwrap_or(software);
    notes.sort_by_key(|(name, _)| *name != primary.name());
    Picked { primary, notes }
}

type Test = fn() -> Result<Arc<dyn EncoderKind>, String>;

/// The hardware encoders this build has, each with its test.
fn hardware() -> Vec<(&'static str, Test)> {
    let mut out: Vec<(&'static str, Test)> = Vec::new();
    #[cfg(feature = "nvenc")]
    out.push(("nvenc", || {
        let kind = cast_core::encoder::Backend::Nvenc;
        cast_core::encoder::self_test(&kind).map_err(|e| nvenc_words(&e))?;
        Ok(Arc::new(kind) as Arc<dyn EncoderKind>)
    }));
    #[cfg(not(feature = "nvenc"))]
    out.push(("nvenc", || Err("this build has no NVENC (the `nvenc` feature)".into())));
    out.push(("vaapi", || {
        Err("not built: intentic-remoted has no VA-API encoder yet".into())
    }));
    out
}

/// The self-test's error, said the way a person can act on.
#[cfg(feature = "nvenc")]
fn nvenc_words(error: &str) -> String {
    if error.contains("libcuda") || error.contains("libnvidia-encode") {
        format!("no NVIDIA driver with its encoder is installed ({error})")
    } else {
        error.to_owned()
    }
}
