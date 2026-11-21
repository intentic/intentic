//! Which encoder a Linux screen is sent with: NVENC where an NVIDIA driver answers castd's self-test, then VA-API's
//! (Intel, AMD, D3D12 on WSL2), then the software encoder (openh264 in the default build). Both hardware encoders'
//! libraries are opened at run time, so a build with them runs anywhere.
//!
//! Each hardware encoder is tested once, as remoted starts, in a child process of its own (`intentic-remoted
//! encoder-probe <name>`): a GPU driver may crash rather than fail (Mesa's d3d12 driver does in its video processor),
//! and a crash there must cost that encoder, not remoted. The probe runs on a thread of its own, so `/info` never
//! waits for it; a screen opened before it finished waits for it.
//!
//! Every encoder that passed is tried in that order when a screen opens (a driver out of sessions, a size one does not
//! take), before the software encoder takes the picture.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use cast_core::encoder::{EncoderConfig, EncoderKind, Encoders, VideoEncoder};

/// How long one encoder's probe may take: NVENC's first CUDA context on WSL2 takes 2.5 s.
const PROBE_PATIENCE: Duration = Duration::from_secs(30);

/// What the probe found: the encoders screens use first, and a line for each encoder about why it is or is not used.
#[derive(Clone)]
pub struct Picked {
    pub primary: Arc<dyn EncoderKind>,
    /// `(name, "ok" | why not)`, those used first first.
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

    /// What screens are encoded with: the picked encoders, the software one taking what none of them can open.
    pub fn encoders(&self) -> Encoders {
        Encoders {
            primary: self.wait().primary,
            fallback: super::super::software(),
        }
    }
}

/// The hardware encoders that passed, tried in order on each open.
struct Chain(Vec<Arc<dyn EncoderKind>>);

impl EncoderKind for Chain {
    fn name(&self) -> &'static str {
        self.0[0].name()
    }

    fn hardware(&self) -> bool {
        true
    }

    fn open(&self, cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
        let mut why = Vec::new();
        for kind in &self.0 {
            match kind.open(cfg) {
                Ok(enc) => return Ok(enc),
                Err(e) => why.push(format!("{}: {e}", kind.name())),
            }
        }
        Err(why.join("; "))
    }
}

/// `INTENTIC_REMOTED_ENCODER`: `software` keeps the hardware encoders out (a comparison, a driver misbehaving);
/// `nvenc` or `vaapi` tries that one alone before the software encoder.
fn pick() -> Picked {
    let software = super::super::software();
    let mut notes = Vec::new();
    let wanted = std::env::var("INTENTIC_REMOTED_ENCODER").ok();
    let mut passed: Vec<Arc<dyn EncoderKind>> = Vec::new();
    for candidate in candidates() {
        let name = candidate.name;
        if let Some(only) = wanted.as_deref().filter(|w| !w.is_empty() && *w != name) {
            notes.push((
                name.to_owned(),
                format!("left out (INTENTIC_REMOTED_ENCODER={only})"),
            ));
            continue;
        }
        let started = Instant::now();
        match (candidate.test)() {
            Ok((kind, detail)) => {
                log::info!(
                    "encoder {name}: self-test passed ({} ms){}",
                    started.elapsed().as_millis(),
                    detail.map(|d| format!(": {d}")).unwrap_or_default()
                );
                notes.push((name.to_owned(), "ok".to_owned()));
                passed.push(kind);
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
    let primary: Arc<dyn EncoderKind> = match passed.len() {
        0 => software,
        1 => passed.remove(0),
        _ => Arc::new(Chain(passed)),
    };
    // Those used, in the order they are tried, lead the list.
    let order = |name: &str| {
        notes
            .iter()
            .position(|(n, note)| n == name && note == "ok")
            .unwrap_or(usize::MAX)
    };
    let mut sorted = notes.clone();
    sorted.sort_by_key(|(name, note)| (note != "ok", order(name)));
    Picked {
        primary,
        notes: sorted,
    }
}

type Test = Box<dyn Fn() -> Result<(Arc<dyn EncoderKind>, Option<String>), String>>;

struct Candidate {
    name: &'static str,
    test: Test,
}

/// The hardware encoders this build has, in the order they are preferred, each with its test.
fn candidates() -> Vec<Candidate> {
    let mut out = Vec::new();
    #[cfg(feature = "nvenc")]
    out.push(Candidate {
        name: "nvenc",
        test: Box::new(|| {
            let detail = in_child("nvenc")?;
            Ok((
                Arc::new(cast_core::encoder::Backend::Nvenc) as Arc<dyn EncoderKind>,
                detail,
            ))
        }),
    });
    #[cfg(not(feature = "nvenc"))]
    out.push(Candidate {
        name: "nvenc",
        test: Box::new(|| Err("this build has no NVENC (the `nvenc` feature)".into())),
    });
    #[cfg(feature = "vaapi")]
    out.push(Candidate {
        name: "vaapi",
        test: Box::new(|| {
            let wanted = cast_core::vaapi::VaapiKind::default();
            if wanted.vpp {
                match in_child("vaapi-vpp") {
                    Ok(detail) => return Ok((Arc::new(wanted) as Arc<dyn EncoderKind>, detail)),
                    Err(e) => log::info!("encoder vaapi: its video processor is not used: {e}"),
                }
            }
            let detail = in_child("vaapi")?;
            Ok((
                Arc::new(cast_core::vaapi::VaapiKind { vpp: false }) as Arc<dyn EncoderKind>,
                detail,
            ))
        }),
    });
    #[cfg(not(feature = "vaapi"))]
    out.push(Candidate {
        name: "vaapi",
        test: Box::new(|| Err("this build has no VA-API (the `vaapi` feature)".into())),
    });
    out
}

/// Runs `intentic-remoted encoder-probe <name>` and reads its answer: Ok with what it says of the device, or why not.
#[allow(dead_code)]
fn in_child(name: &str) -> Result<Option<String>, String> {
    use std::io::Read;
    use std::os::unix::process::ExitStatusExt;
    let exe =
        std::env::current_exe().map_err(|e| format!("cannot find remoted's own binary: {e}"))?;
    let mut child = std::process::Command::new(exe)
        .args(["encoder-probe", name])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("the probe did not start: {e}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < PROBE_PATIENCE => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "the self-test did not finish in {} s",
                    PROBE_PATIENCE.as_secs()
                ));
            }
            Err(e) => return Err(format!("the probe was lost: {e}")),
        }
    };
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    let answer = out
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok());
    match answer {
        Some(a) if a["ok"] == true => Ok(a["detail"].as_str().map(str::to_owned)),
        Some(a) => Err(a["error"]
            .as_str()
            .unwrap_or("the self-test failed")
            .to_owned()),
        None => Err(match status.signal() {
            Some(signal) => format!("the GPU driver crashed in the self-test (signal {signal})"),
            None => format!(
                "the self-test said nothing (exit {})",
                status.code().unwrap_or(-1)
            ),
        }),
    }
}

/// `intentic-remoted encoder-probe <name>`: one encoder's self-test, its answer a JSON line on stdout.
pub fn probe_main(args: &[String]) -> i32 {
    let result: Result<Option<String>, String> = match args.first().map(String::as_str) {
        #[cfg(feature = "nvenc")]
        Some("nvenc") => cast_core::encoder::self_test(&cast_core::encoder::Backend::Nvenc)
            .map(|()| cast_core::nvenc::Nvenc::device_name())
            .map_err(|e| nvenc_words(&e)),
        #[cfg(feature = "vaapi")]
        Some(name @ ("vaapi" | "vaapi-vpp")) => {
            let kind = cast_core::vaapi::VaapiKind {
                vpp: name == "vaapi-vpp",
            };
            cast_core::vaapi::device()
                .and_then(|d| {
                    if kind.vpp && !d.vpp {
                        return Err(format!("{} has no video processor", d.vendor));
                    }
                    cast_core::encoder::self_test(&kind)?;
                    Ok(Some(format!("{} on {}", d.vendor, d.node)))
                })
                .map_err(|e| vaapi_words(&e))
        }
        other => Err(format!("no encoder {other:?} in this build")),
    };
    let line = match result {
        Ok(detail) => serde_json::json!({ "ok": true, "detail": detail }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    println!("{line}");
    0
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

#[cfg(feature = "vaapi")]
fn vaapi_words(error: &str) -> String {
    if error.contains("libva.so.2") || error.contains("libva-drm.so.2") {
        format!("libva is not installed ({error})")
    } else {
        error.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fails(&'static str);

    impl EncoderKind for Fails {
        fn name(&self) -> &'static str {
            self.0
        }
        fn hardware(&self) -> bool {
            true
        }
        fn open(&self, _cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
            Err("out of sessions".into())
        }
    }

    #[test]
    fn a_chain_tries_each_encoder_and_says_why_none_opened() {
        let chain = Chain(vec![Arc::new(Fails("nvenc")), Arc::new(Fails("vaapi"))]);
        assert_eq!(chain.name(), "nvenc");
        let cfg = EncoderConfig {
            width: 64,
            height: 64,
            fps: 30,
            preset: "ultrafast".into(),
            threads: 1,
            crf: 24.0,
            max_kbps: 1000,
        };
        assert_eq!(
            chain.open(&cfg).err().as_deref(),
            Some("nvenc: out of sessions; vaapi: out of sessions")
        );
    }
}
