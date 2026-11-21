//! The video pipeline (voxl's): damage-driven capture -> I420 -> x264 -> viewers, with ack-based flow control. What
//! castd changed: the picture may be a crop of the screen, a resize carries the viewer's scale, the bitrate and the
//! flow gate follow one viewer (rate.rs) instead of the slowest, and a viewer that falls behind is skipped until a
//! keyframe rather than holding everyone back. What the platform captures is a `ScreenSource` (capture.rs), what encodes
//! it an `EncoderKind` (encoder.rs).

use crate::capture::{Capture, ScreenSource};
use crate::encoder::{Encoded, EncoderConfig, EncoderKind, Encoders, VideoEncoder};
use crate::exact;
use crate::frame::{Frame, FrameFormat};
use crate::geometry::{Band, Rect};
use crate::header::{FLAG_KEY, FLAG_REFINE, Header, KIND_VIDEO};
use crate::hub::{Client, Hub, Inflight, Lossless, Media, Out};
use crate::rate::{self, RateCtl};
use crate::wake::wait_any;
use bytes::Bytes;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct VideoConfig {
    /// Capture only this region of the screen (a desktop app's window).
    pub crop: Option<Rect>,
    pub fps: u32,
    pub preset: String,
    pub threads: u32,
    pub convert_threads: usize,
    pub crf: f32,
    pub max_kbps: u32,
    pub paintover_crf: f32,
    pub paintover_burst: u32,
    pub paintover_delay_ms: u64,
    pub min_kbps: u32,
    /// While a viewer on this computer's loopback drives: motion's quality, the bitrate ceiling (where the rate starts
    /// too) and the frame rate at most.
    pub local_crf: f32,
    pub local_max_kbps: u32,
    pub local_fps: u32,
    /// Exact copies (exact.rs) for local viewers that ask, once the screen has been still this long.
    pub lossless: bool,
    pub lossless_delay: Duration,
    pub coalesce: Duration,
    pub stripes: u32,
    pub adaptive_threads: bool,
    /// The encoder `--encoder` selected (encoder::select), and the one that takes over a picture it cannot open at.
    pub encoder: Encoders,
}

struct Job {
    buf: Box<Frame>,
    idx: usize,
    force_idr: bool,
    paintover: bool,
    /// Last pass of a paint-over burst.
    paintover_final: bool,
    /// New content over much of the picture after a lull (FreshContent): given a keyframe's budget.
    fresh: bool,
    /// The most a keyframe or fresh frame may be, in kbit, when a viewer's pictures ride a track: what the slowest
    /// such link carries in [`KEY_WINDOW`] (None: a keyframe's usual budget).
    key_kbit: Option<u32>,
    /// Rows that changed in this capture.
    band: Option<Band>,
    /// Per-macroblock change map for this capture (None: analyse everything).
    mb_dirty: Option<Arc<Vec<u8>>>,
    /// The part of the picture whose content changed in this capture (not what a refinement sharpens): what an exact
    /// viewer's picture stops being exact in.
    changed: Option<Rect>,
    captured_at: Instant,
}

/// An exact copy of part of the picture, read by the capture thread once the screen was still and sent by the encode
/// thread in order with the frames before it.
struct ExactCopy {
    rect: Rect,
    pixels: Vec<u8>,
    captured_at: Instant,
}

/// What the capture thread hands the encode thread, in order.
enum Work {
    Frame(Job),
    Copy(ExactCopy),
}
fn union(a: Option<Band>, b: Band) -> Band {
    match a {
        None => b,
        Some(a) => Band {
            y0: a.y0.min(b.y0),
            y1: a.y1.max(b.y1),
        },
    }
}

/// One capture/encode setup for the current screen size.
struct Pipeline {
    cap: Box<dyn Capture>,
    /// The frames the capture fills and the encoders read.
    format: FrameFormat,
    job_tx: mpsc::SyncSender<Work>,
    ret_rx: mpsc::Receiver<(usize, Box<Frame>)>,
    encode: std::thread::JoinHandle<()>,
}

/// The running pipeline: its capture thread, which owns the encode thread. Dropping it leaves the pipeline running
/// (castd's runs for the process's life); [`Video::stop`] ends it.
pub struct Video {
    hub: Arc<Hub>,
    capture: std::thread::JoinHandle<()>,
}

impl Video {
    /// Ends the capture and encode threads and waits for them: the hub's viewers stay connected and hear nothing more.
    /// A daemon serving a screen on demand calls it once the last viewer left.
    pub fn stop(self) {
        self.hub.stopped.store(true, Ordering::Relaxed);
        self.hub.wake();
        let _ = self.capture.join();
    }

    /// Whether the capture thread has ended (stopped, or failed through `Hub::on_fatal`).
    pub fn finished(&self) -> bool {
        self.capture.is_finished()
    }
}

/// Runs the pipeline on a thread named `capture`. With a source that resizes (RandR, no crop), a viewer's size request
/// ends the capture loop: the encoder drains, the screen is resized and the pipeline is rebuilt at the new size, and
/// viewers get the new geometry and a keyframe. A capture that fails for good goes to [`Hub::fatal`]: castd ends, a
/// daemon with `on_fatal` set ends this pipeline alone.
pub fn spawn(
    cfg: VideoConfig,
    hub: Arc<Hub>,
    mut source: Box<dyn ScreenSource>,
) -> Result<Video, String> {
    *hub.resize_limits.lock() = if cfg.crop.is_some() {
        None
    } else {
        source.resize_limits()
    };
    let mut p = build(&cfg, &hub, source.as_mut())?;
    let thread_hub = hub.clone();
    let capture = std::thread::Builder::new()
        .name("capture".into())
        .spawn(move || {
            let hub = thread_hub;
            loop {
                let Pipeline {
                    mut cap,
                    format,
                    job_tx,
                    ret_rx,
                    encode,
                } = p;
                let ended = capture_loop(
                    cap.as_mut(),
                    format,
                    cfg.clone(),
                    hub.clone(),
                    job_tx,
                    ret_rx,
                );
                let failed = match ended {
                    Err(_) if hub.is_stopped() => None,
                    Err(e) if cap.geometry_changed() => {
                        log::info!("capture geometry changed: {e}");
                        None
                    }
                    Err(e) => Some(format!("capture loop ended: {e}")),
                    Ok(()) => None,
                };
                drop(cap);
                let _ = encode.join();
                if let Some(why) = failed {
                    return hub.fatal(why);
                }
                if hub.is_stopped() {
                    log::info!("capture stopped");
                    return;
                }
                if let Some(crop) = hub.crop_req.lock().take() {
                    *hub.crop.lock() = Some(crop);
                }
                let req = hub.resize_req.lock().take();
                if let Some((w, h, scale)) = req {
                    hub.set_scale(scale);
                    if hub.resize_limits.lock().is_some()
                        && let Err(e) = source.resize(w, h)
                    {
                        log::warn!("resize to {w}x{h} failed: {e}");
                    }
                }

                p = match build(&cfg, &hub, source.as_mut()) {
                    Ok(p) => p,
                    Err(e) => return hub.fatal(format!("video restart failed: {e}")),
                };
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Video { hub, capture })
}

fn build(
    cfg: &VideoConfig,
    hub: &Arc<Hub>,
    source: &mut dyn ScreenSource,
) -> Result<Pipeline, String> {
    let crop = (*hub.crop.lock()).or(cfg.crop);
    let cap = source.open(crop)?;
    let area = cap.area();
    *hub.crop.lock() = cap.cropped().then_some(area);
    let (w, h) = (area.w, area.h);
    let screen = cap.screen();
    hub.width.store(w, Ordering::Relaxed);
    hub.height.store(h, Ordering::Relaxed);
    hub.screen_width.store(screen.0, Ordering::Relaxed);
    hub.screen_height.store(screen.1, Ordering::Relaxed);
    hub.activity.reset(w, h);
    log::info!(
        "capturing {}x{} @ {} fps, preset {} threads {}",
        w,
        h,
        cfg.fps,
        cfg.preset,
        cfg.threads
    );

    let (job_tx, job_rx) = mpsc::sync_channel::<Work>(1);
    let (ret_tx, ret_rx) = mpsc::channel::<(usize, Box<Frame>)>();
    // A hardware encoder is one engine: stripes would only spend its sessions (a GeForce allows a few at once).
    let hardware = cfg.encoder.primary.hardware();
    let layout = stripe_layout(h, if hardware { 1 } else { cfg.stripes });
    let mut stripes = Vec::new();
    let mut format = FrameFormat::I420;
    for &(y, sh) in &layout {
        let fixed = if cfg.adaptive_threads {
            1
        } else {
            (cfg.threads / layout.len() as u32).max(1)
        };
        let ecfg = EncoderConfig {
            width: w,
            height: sh,
            fps: cfg.fps,
            preset: cfg.preset.clone(),
            threads: fixed,
            crf: cfg.crf,
            max_kbps: cfg.max_kbps,
        };
        let max_threads = if cfg.adaptive_threads {
            (cfg.threads / layout.len() as u32).max(1)
        } else {
            1
        };
        let primary = &cfg.encoder.primary;
        let fallback = &cfg.encoder.fallback;
        let (kind, enc) = match primary.open(&ecfg) {
            Ok(e) => (primary.clone(), e),
            Err(e) if hardware => {
                log::warn!(
                    "{} cannot encode {w}x{sh} ({e}); {} takes this picture",
                    primary.name(),
                    fallback.name()
                );
                (fallback.clone(), fallback.open(&ecfg)?)
            }
            Err(e) => return Err(e),
        };
        // The frames this encoder reads that the capture can fill, else the fallback's (which reads I420).
        let (kind, mut enc) = match common_format(enc.as_ref(), cap.as_ref()) {
            Some(f) => {
                format = f;
                (kind, enc)
            }
            None => {
                log::warn!(
                    "{} reads no frame this capture fills; {} takes this picture",
                    enc.name(),
                    fallback.name()
                );
                let enc = fallback.open(&ecfg)?;
                format = common_format(enc.as_ref(), cap.as_ref())
                    .ok_or_else(|| format!("{} reads no frame this capture fills", enc.name()))?;
                (fallback.clone(), enc)
            }
        };
        // Sliced threads are x264's; a hardware encoder never fans out.
        let max_threads = if enc.threaded() { max_threads } else { 1 };
        if stripes.is_empty() {
            *hub.encoder.lock() = enc.name();
        }
        if stripes.is_empty()
            && let Some(codec) = crate::encoder::codec_string(&enc.headers())
        {
            *hub.codec.lock() = codec;
        }
        stripes.push(Stripe {
            y: y as usize,
            h: sh as usize,
            enc,
            kind,
            cfg: ecfg,
            max_threads,
            applied_kbps: 0,
            applied_crf: -1.0,
        });
    }
    *hub.stripes.lock() = layout;
    let hub2 = hub.clone();
    let quality = Quality {
        crf: cfg.crf,
        paintover_crf: cfg.paintover_crf,
        local_crf: cfg.local_crf,
    };
    let encode = std::thread::Builder::new()
        .name("encode".into())
        .spawn(move || encode_loop(stripes, job_rx, ret_tx, hub2, quality))
        .map_err(|e| e.to_string())?;
    // New geometry (and a keyframe) for viewers already connected; nobody at startup.
    hub.restart_clients();
    Ok(Pipeline {
        cap,
        format,
        job_tx,
        ret_rx,
        encode,
    })
}

/// The first frame format `enc` reads that `cap` fills.
fn common_format(enc: &dyn VideoEncoder, cap: &dyn Capture) -> Option<FrameFormat> {
    enc.formats()
        .iter()
        .copied()
        .find(|f| cap.formats().contains(f))
}

/// Waits for the capture's news or the hub's wake, at most `timeout_ms`.
fn wait(cap: &dyn Capture, hub: &Hub, timeout_ms: i32) {
    match cap.waitable() {
        Some(w) => wait_any(&[w, hub.waker.waitable()], timeout_ms),
        None => wait_any(&[hub.waker.waitable()], timeout_ms),
    }
}

/// What holds the next capture back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flow {
    Open,
    /// The steering viewer's acks are behind; a keyframe still goes.
    Acks,
    /// The steering viewer's track has run too far ahead of its link's share: the frame is dropped at the source, a
    /// keyframe too (one sent into a full link only waits there longer), up to `TRACK_HOLD_MAX`.
    Track,
}

/// Longest a track that ran ahead holds a keyframe back: past it one goes, however far ahead.
const TRACK_HOLD_MAX: Duration = Duration::from_secs(1);

/// What may hold the next capture back. Only the steering viewer gates the capture: anyone else who falls behind is
/// skipped by the encode loop instead. A viewer silent for 4 s (a dead socket, a tab the browser froze) is reset to
/// wait for a keyframe, so it stops counting as behind. A viewer whose pictures ride a track acks nothing: what gates it
/// is how far the track runs ahead of its link's share (`Client::track_full`).
fn flow(hub: &Hub, interval_ms: f64) -> Flow {
    let steer = hub.steering.load(Ordering::Relaxed);
    let mut flow = Flow::Open;
    for c in hub.video_clients() {
        if c.internal {
            continue;
        }
        if c.on_track().is_some() {
            if c.id == steer && c.track_full(interval_ms) {
                flow = Flow::Track;
            }
            continue;
        }
        let (n, age) = c.backlog();
        if n == 0 {
            continue;
        }
        if age > 4000 {
            log::warn!("viewer {} stalled ({n} frames, {age} ms); resyncing", c.id);
            c.inflight.lock().clear();
            c.needs_keyframe.store(true, Ordering::Relaxed);
            c.started.store(false, Ordering::Relaxed);
            continue;
        }
        if c.id == steer && rate::behind(n, age as f64, c.rtt_ms(), interval_ms) {
            flow = Flow::Acks;
        }
    }
    flow
}

/// How much of a track's link a keyframe (or a fresh frame) may take: a keyframe that takes longer to cross the link
/// than this fills the bottleneck's buffer, what overflows is lost, and the congestion estimate collapses under the
/// loss (measured: about a megabyte in a quarter second as a cap fell). Pictures behind it wait as long.
const KEY_WINDOW: Duration = Duration::from_millis(200);
/// The least a keyframe is allowed whatever the link, kbit: below it a 1080p keyframe is mush the paint-over has to
/// redo anyway, and a link this slow takes a moment to carry one regardless.
const KEY_FLOOR_KBIT: u32 = 160;

/// A keyframe's budget on a track whose congestion control estimates `estimate_kbps`, kbit.
fn key_budget_kbit(estimate_kbps: f64) -> u32 {
    ((estimate_kbps * KEY_WINDOW.as_secs_f64()) as u32).max(KEY_FLOOR_KBIT)
}

/// Past this, one step of the capture loop (or one picture's encode) is logged by name: the bench once saw six seconds
/// with no picture encoded, the flow open and nothing skipped, and never again in 60 runs, so a stall says where it is.
const STEP_SLOW: Duration = Duration::from_secs(1);

/// The step of the capture loop it is in, and since when ([`STEP_SLOW`]).
struct Step {
    name: &'static str,
    at: Instant,
}

impl Step {
    fn new() -> Step {
        Step {
            name: "start",
            at: Instant::now(),
        }
    }

    fn enter(&mut self, name: &'static str) {
        let took = self.at.elapsed();
        if took > STEP_SLOW {
            log::warn!("capture: {} ms in {}", took.as_millis(), self.name);
        }
        self.name = name;
        self.at = Instant::now();
    }
}

/// Least time between two keyframes a lagging viewer's recovery may ask for: each one is a burst for every viewer.
const RECOVERY_KEYFRAME_GAP: Duration = Duration::from_secs(1);

/// Regional sharpening. Blocks encoded while they changed carry motion-level quality;
/// once a block has been still for a while it is re-encoded at paint-over quality,
/// even while other parts of the screen keep moving (a playing video would otherwise
/// keep the frame-level paint-over from ever running).
struct Refiner {
    epoch: Instant,
    changed_ms: Vec<u32>,
    pending: Vec<bool>,
    last_refine: Instant,
    cols: usize,
}

const REFINE_STILL_MS: u32 = 300;
const REFINE_EVERY: Duration = Duration::from_millis(250);

impl Refiner {
    fn new(blocks: usize, cols: usize) -> Self {
        Refiner {
            epoch: Instant::now(),
            changed_ms: vec![0; blocks],
            pending: vec![false; blocks],
            last_refine: Instant::now(),
            cols,
        }
    }
    fn now(&self) -> u32 {
        self.epoch.elapsed().as_millis() as u32
    }
    fn mark(&mut self, dirty: &[u8]) {
        let now = self.now();
        for (i, &d) in dirty.iter().enumerate() {
            if d != 0 {
                self.pending[i] = true;
                self.changed_ms[i] = now;
            }
        }
    }
    fn mark_all(&mut self) {
        let now = self.now();
        self.pending.fill(true);
        self.changed_ms.fill(now);
    }
    fn clear_all(&mut self) {
        self.pending.fill(false);
    }
    /// Every block not yet sharpened (1 = encode) and the row band they span.
    fn pending_map(&self) -> Option<(Vec<u8>, Band)> {
        let (mut r0, mut r1) = (usize::MAX, 0);
        let map: Vec<u8> = self
            .pending
            .iter()
            .enumerate()
            .map(|(i, &p)| {
                if p {
                    r0 = r0.min(i / self.cols);
                    r1 = r1.max(i / self.cols + 1);
                }
                p as u8
            })
            .collect();
        (r1 > r0).then(|| {
            (
                map,
                Band {
                    y0: (r0 * 16) as u32,
                    y1: (r1 * 16) as u32,
                },
            )
        })
    }
    /// Blocks due for sharpening (1 = refine) and the row band they span.
    fn due(&mut self) -> Option<(Vec<u8>, Band)> {
        if self.last_refine.elapsed() < REFINE_EVERY {
            return None;
        }
        let now = self.now();
        let mut map = vec![0u8; self.pending.len()];
        let (mut r0, mut r1, mut any) = (usize::MAX, 0, false);
        for (i, m) in map.iter_mut().enumerate() {
            if self.pending[i] && now.saturating_sub(self.changed_ms[i]) >= REFINE_STILL_MS {
                *m = 1;
                self.pending[i] = false;
                let row = i / self.cols;
                r0 = r0.min(row);
                r1 = r1.max(row + 1);
                any = true;
            }
        }
        if !any {
            return None;
        }
        self.last_refine = Instant::now();
        Some((
            map,
            Band {
                y0: (r0 * 16) as u32,
                y1: (r1 * 16) as u32,
            },
        ))
    }
}

/// A page that loads, a route that changes, a panel that opens: much of the picture turns into new content at once,
/// after a while of only small changes. Squeezed into the steady per-frame budget (1.25 frames at the cap), such a frame
/// came out at a QP so high that most of the old page stayed showing through the new one (24-25 dB luma against the
/// settled picture on a text page) until the paint-over 150 ms later. Its first frames get a keyframe's budget instead:
/// a link pays one larger frame, the person sees the new page clean at once. A scroll or a drag starts the same way and
/// costs nothing extra (its motion vectors are cheap whatever the cap); a video or an animation gets the budget only at
/// its start, since large changes that keep coming are no onset.
struct FreshContent {
    /// When the last large change was captured.
    last_large: Option<Instant>,
    /// When the onset that opened the current window was captured, and how many of its frames got the budget.
    onset: Option<(Instant, u32)>,
}

/// The share of the picture's macroblocks that must change for a capture to count as large.
const FRESH_SHARE: f64 = 1.0 / 3.0;
/// How long without a large change before the next one is an onset.
const FRESH_QUIET: Duration = Duration::from_millis(300);
/// How long after an onset, and for how many frames, large changes keep the budget: a page often paints in steps (the
/// first paint, then its images and web fonts).
const FRESH_WINDOW: Duration = Duration::from_millis(250);
const FRESH_FRAMES: u32 = 3;

impl FreshContent {
    fn new() -> Self {
        FreshContent {
            last_large: None,
            onset: None,
        }
    }

    /// Notes a motion frame that changed `changed` of the picture's `total` macroblocks; whether it gets the budget.
    fn motion(&mut self, changed: usize, total: usize, at: Instant) -> bool {
        if (changed as f64) < total as f64 * FRESH_SHARE {
            return false;
        }
        let lull = self
            .last_large
            .is_none_or(|t| at.saturating_duration_since(t) >= FRESH_QUIET);
        self.last_large = Some(at);
        if lull {
            self.onset = Some((at, 1));
            return true;
        }
        match &mut self.onset {
            Some((start, n))
                if *n < FRESH_FRAMES && at.saturating_duration_since(*start) < FRESH_WINDOW =>
            {
                *n += 1;
                true
            }
            _ => false,
        }
    }
}

/// Viewers on this computer get an exact copy only while their round trip says the link is no network: a copy is the
/// changed area's raw pixels, which a slower link would queue every frame behind.
const LOSSLESS_MAX_RTT_MS: f64 = 20.0;

/// Whether `c` takes exact copies now: it draws them, its picture has started, it keeps up, and its link is local.
fn takes_copies(c: &Client) -> bool {
    c.exacting()
        && c.started.load(Ordering::Relaxed)
        && !c.skipping.load(Ordering::Relaxed)
        && c.rtt_ms() <= LOSSLESS_MAX_RTT_MS
}

/// The box of what is lossy for every viewer that takes exact copies now; None when each one's picture is exact.
fn lossy_area(clients: &[Arc<Client>]) -> Option<Rect> {
    clients
        .iter()
        .filter(|c| takes_copies(c))
        .filter_map(|c| c.exact.lock().lossy)
        .reduce(exact::union)
}

/// Sends an exact copy to every viewer it makes exact somewhere, drawn after the last frame each was sent.
fn send_copy(hub: &Hub, copy: ExactCopy) {
    let bytes = copy.pixels.len() as u64;
    let shared = Arc::new(Lossless {
        rect: copy.rect,
        captured: copy.captured_at,
        pixels: Bytes::from(copy.pixels),
    });
    for c in hub.video_clients() {
        if !takes_copies(&c) {
            continue;
        }
        let mut st = c.exact.lock();
        if !exact::wants_copy(&st, copy.rect) {
            continue;
        }
        c.send(Out::Lossless(shared.clone(), st.last_id));
        exact::copied(&mut st, copy.rect);
        hub.stats.lossless.fetch_add(1, Ordering::Relaxed);
        hub.stats.lossless_bytes.fetch_add(bytes, Ordering::Relaxed);
    }
}

/// Notes the damage the capture has taken for /wait, whether or not anyone is watching.
pub(crate) fn note_changes(cap: &mut dyn Capture, hub: &Hub) {
    let d = cap.damage();
    if !d.changes.is_empty() {
        hub.activity.note(&d.changes);
        d.changes.clear();
    }
}

fn capture_loop(
    cap: &mut dyn Capture,
    format: FrameFormat,
    cfg: VideoConfig,
    hub: Arc<Hub>,
    job_tx: mpsc::SyncSender<Work>,
    ret_rx: mpsc::Receiver<(usize, Box<Frame>)>,
) -> Result<(), String> {
    let area = cap.area();
    let (w, h) = (area.w as usize, area.h as usize);
    let mut pool: Vec<Option<Box<Frame>>> = vec![
        Some(Box::new(cap.new_frame(format)?)),
        Some(Box::new(cap.new_frame(format)?)),
    ];
    let full = cap.damage().full();
    let mut pending: [Option<Band>; 2] = [Some(full), Some(full)];
    let mut next_idx = 0usize;
    // The frame rate follows the viewer driving: the local one's display, up to --local-fps, else --fps.
    let mut fps = hub.fps.load(Ordering::Relaxed);
    if fps == 0 {
        fps = cfg.fps;
        hub.fps.store(fps, Ordering::Relaxed);
    }
    let mut last_capture = Instant::now() - Duration::from_secs(1);
    let mut last_motion = Instant::now();
    let mut last_copy = Instant::now() - Duration::from_secs(1);
    let mut copy_pace = exact::CopyPace::new(cfg.lossless_delay);
    let mut paintover_left = 0u32;
    let mut rc = RateCtl::new(cfg.max_kbps as f64, cfg.min_kbps as f64);
    let mut local = false;
    hub.ceiling_kbps.store(cfg.max_kbps, Ordering::Relaxed);
    hub.local_steering.store(false, Ordering::Relaxed);
    hub.target_kbps.store(rc.target as u32, Ordering::Relaxed);
    let mut had_clients = false;
    let mut full_next = true;
    let mut refiner = Refiner::new(w.div_ceil(16) * h.div_ceil(16), w.div_ceil(16));
    let mut fresh = FreshContent::new();
    // Since when the flow has held the capture back (a track's keyframe waits at most TRACK_HOLD_MAX).
    let mut held_since: Option<Instant> = None;
    let mut step = Step::new();

    loop {
        if hub.is_stopped()
            || hub.resize_req.lock().is_some()
            || hub.crop_req.lock().is_some()
            || cap.needs_rebuild()
        {
            return Ok(());
        }
        let interval = Duration::from_secs_f64(1.0 / fps as f64);
        // Allow slight early capture so source jitter doesn't alias into dropped frames.
        let min_interval = interval.mul_f64(0.85);
        let interval_ms = interval.as_secs_f64() * 1000.0;
        step.enter("pump");
        cap.pump()?;
        if cap.needs_rebuild() {
            return Ok(());
        }
        note_changes(cap, &hub);
        hub.drain_wake();
        step.enter("snapshots");
        let snaps = std::mem::take(&mut *hub.snapshots.lock());
        if !snaps.is_empty() {
            // The whole current screen, whether or not anyone is watching. Damage
            // stays pending, so the stream still sends what changed. Only the pixels
            // are copied here (the framebuffer is live); the PNG is made off this thread.
            // The capturer takes the damage for exactly these pixels with them, so the
            // screenshot's seq covers what it shows and nothing drawn after it.
            let bgrx = cap.snapshot()?;
            note_changes(cap, &hub);
            let shot = Arc::new(crate::record::Snapshot {
                width: w,
                height: h,
                bgrx,
                seq: hub.activity.seq(),
            });
            for tx in snaps {
                let _ = tx.send(shot.clone());
            }
        }
        while let Ok((i, b)) = ret_rx.try_recv() {
            pool[i] = Some(b);
        }
        step.enter("clients");
        let clients = hub.video_clients();
        if clients.is_empty() {
            if had_clients {
                rc = RateCtl::new(cfg.max_kbps as f64, cfg.min_kbps as f64);
                local = false;
                hub.local_steering.store(false, Ordering::Relaxed);
                hub.target_kbps.store(rc.target as u32, Ordering::Relaxed);
                hub.steering.store(0, Ordering::Relaxed);
            }
            fps = cfg.fps;
            hub.fps.store(fps, Ordering::Relaxed);
            had_clients = false;
            wait(cap, &hub, 500);
            continue;
        }
        let viewers: Vec<rate::Viewer> = clients.iter().map(|c| c.viewer()).collect();
        step.enter("rate");
        let steer = rate::steering(&viewers);
        hub.steering
            .store(steer.map_or(0, |v| v.id), Ordering::Relaxed);
        // A viewer on this computer's loopback drives: no network to spare, so the ceiling (and the rate, at once) is
        // the local one, motion is encoded sharper, and the frame rate may follow its display.
        let driver = steer.and_then(|v| clients.iter().find(|c| c.id == v.id));
        let driver_local = driver.is_some_and(|c| c.local);
        if driver_local != local {
            local = driver_local;
            let ceiling = if local {
                cfg.local_max_kbps
            } else {
                cfg.max_kbps
            };
            rc.set_ceiling(ceiling as f64, local);
            hub.local_steering.store(local, Ordering::Relaxed);
        }
        rc.note_encoded(hub.stats.bytes.load(Ordering::Relaxed), Instant::now());
        rc.update(steer);
        hub.target_kbps.store(rc.target as u32, Ordering::Relaxed);
        // The pace is the driving viewer's (its last input), else the steering one's; with neither (a restart's viewers
        // waiting on their keyframe) it holds. Only the capture's: Chromium on Xvfb draws on its own 60 Hz clock
        // whatever RandR's refresh rate says (measured 2026-11-20), so a faster pace needs a window started with
        // --disable-frame-rate-limit.
        let pace = hub.driver().or_else(|| driver.cloned());
        let want_fps = pace.map_or(fps, |c| {
            rate::frame_rate(
                cfg.fps,
                cfg.local_fps,
                c.local.then(|| c.display_hz.load(Ordering::Relaxed)),
            )
        });
        if want_fps != fps {
            log::info!("{fps} -> {want_fps} frames per second at most");
            fps = want_fps;
            hub.fps.store(fps, Ordering::Relaxed);
            continue;
        }
        // A lagging viewer's recovery waits for a gap since the last keyframe; a new viewer, a viewer whose decoder
        // broke, and the steering one do not.
        let recent_key = hub.last_keyframe.lock().elapsed() < RECOVERY_KEYFRAME_GAP;
        let want_key = clients.iter().any(|c| {
            c.needs_keyframe.load(Ordering::Relaxed)
                && !(recent_key && c.skipping.load(Ordering::Relaxed))
        });
        if !had_clients {
            had_clients = true;
            // Our shm copy may be stale: re-grab everything once.
            cap.grab(full)?;
            pending = [Some(full), Some(full)];
            cap.damage().damaged = true;
            full_next = true;
        }
        let paintover_due = paintover_left > 0
            && last_motion.elapsed() >= Duration::from_millis(cfg.paintover_delay_ms);
        // An exact copy of what is lossy for the local viewers that draw them, once the screen has been still: read
        // here, sent by the encode thread after every frame queued before it.
        let damaged = cap.damage().damaged;
        let lossy = if cfg.lossless && !damaged && !want_key {
            lossy_area(&clients)
        } else {
            None
        };
        if !damaged {
            copy_pace.still(last_copy.elapsed().min(last_motion.elapsed()));
        }
        if let Some(rect) = lossy {
            let quiet = last_motion.elapsed().min(last_copy.elapsed());
            if quiet >= copy_pace.wait() {
                last_copy = Instant::now();
                copy_pace.sent();
                let copy = ExactCopy {
                    rect,
                    pixels: cap.region(rect)?,
                    captured_at: Instant::now(),
                };
                if job_tx.send(Work::Copy(copy)).is_err() {
                    return Err("encoder gone".into());
                }
                continue;
            }
        }
        if !damaged && !want_key && !paintover_due {
            let mut timeout = if paintover_left == 0 {
                100
            } else {
                cfg.paintover_delay_ms
                    .saturating_sub(last_motion.elapsed().as_millis() as u64) as i32
                    + 1
            };
            if lossy.is_some() {
                let quiet = last_motion.elapsed().min(last_copy.elapsed());
                let left = copy_pace.wait().saturating_sub(quiet).as_millis() as i32 + 1;
                timeout = timeout.min(left);
            }
            wait(cap, &hub, timeout);
            continue;
        }
        let since = last_capture.elapsed();
        if since < min_interval {
            let rem = min_interval - since;
            wait_any(
                &[hub.waker.waitable()],
                (rem.as_micros() as i32 + 999) / 1000,
            );
            continue;
        }
        // Apps present a frame as a burst of puts; give the burst a moment to land so
        // the capture holds one whole frame instead of its first tiles.
        if let Some(t) = cap.damage().damaged_at {
            let el = t.elapsed();
            if el < cfg.coalesce {
                let rem = cfg.coalesce - el;
                std::thread::sleep(rem);
                continue;
            }
        }
        step.enter("flow");
        let held = match flow(&hub, interval_ms) {
            Flow::Open => false,
            Flow::Acks => !want_key,
            Flow::Track => !want_key || held_since.is_some_and(|at| at.elapsed() < TRACK_HOLD_MAX),
        };
        if held {
            held_since.get_or_insert_with(Instant::now);
            hub.stats.flow_blocked.fetch_add(1, Ordering::Relaxed);
            wait(cap, &hub, 4);
            continue;
        }
        held_since = None;
        // Need a free buffer (the encoder may still hold the other).
        step.enter("buffer");
        if pool[next_idx].is_none() {
            match ret_rx.recv_timeout(Duration::from_millis(50)) {
                Ok((i, b)) => pool[i] = Some(b),
                Err(_) => continue,
            }
            if pool[next_idx].is_none() {
                continue;
            }
        }

        step.enter("grab");
        let t0 = Instant::now();
        let origin = cap.damage().damaged_at.unwrap_or(t0);
        hub.stats
            .damage_wait_us
            .fetch_add((t0 - origin).as_micros() as u64, Ordering::Relaxed);
        let mut band = None;
        let mut mb_dirty = (!full_next).then(|| cap.damage().take_mb_map());
        if full_next {
            cap.damage().take_mb_map();
            full_next = false;
        }
        match &mb_dirty {
            Some(m) => refiner.mark(m),
            None => refiner.mark_all(),
        }
        if cap.damage().damaged {
            band = cap.damage().take_band();
            if let Some(b) = band {
                cap.grab(b)?;
            }
        }
        let t1 = Instant::now();
        let is_motion = band.is_some();
        if !is_motion && !want_key && !paintover_due {
            // Damage was empty after all.
            continue;
        }
        // What this capture changed, for the exact viewers' clips: the changed blocks' box, else the damaged rows.
        let changed = band.map(|b| {
            mb_dirty
                .as_ref()
                .and_then(|m| exact::bounding_box(m, w.div_ceil(16), w as u32, h as u32))
                .unwrap_or(Rect {
                    x: 0,
                    y: b.y0,
                    w: w as u32,
                    h: b.y1.saturating_sub(b.y0),
                })
        });
        // Sharpen only what was sent at motion quality; nothing pending, nothing to send.
        let paint_map = if paintover_due && !is_motion && !want_key {
            match refiner.pending_map() {
                Some(m) => Some(m),
                None => {
                    paintover_left = 0;
                    continue;
                }
            }
        } else {
            None
        };
        let idx = next_idx;
        let mut buf = pool[idx].take().unwrap();
        let todo = match (pending[idx], band) {
            (p, Some(b)) => Some(union(p, b)),
            (p, None) => p,
        };
        if let Some(b) = band {
            pending[1 - idx] = Some(union(pending[1 - idx], b));
        }
        pending[idx] = None;
        if let Some(t) = todo {
            cap.fill(&mut buf, t.y0 as usize, t.y1 as usize, cfg.convert_threads)?;
        }
        let t2 = Instant::now();
        hub.stats
            .grab_us
            .fetch_add((t1 - t0).as_micros() as u64, Ordering::Relaxed);
        hub.stats
            .convert_us
            .fetch_add((t2 - t1).as_micros() as u64, Ordering::Relaxed);
        hub.stats.captured.fetch_add(1, Ordering::Relaxed);

        let blocks = refiner.pending.len();
        let fresh_frame = is_motion
            && !want_key
            && fresh.motion(
                mb_dirty
                    .as_ref()
                    .map_or(blocks, |m| m.iter().filter(|&&d| d != 0).count()),
                blocks,
                t0,
            );
        let mut refine = None;
        let paintover = if is_motion {
            copy_pace.moved(last_copy.elapsed());
            last_motion = Instant::now();
            paintover_left = cfg.paintover_burst;
            // Piggyback sharpening of blocks that have gone still on this frame; not on a fresh one, whose budget is
            // for the new content at motion quality.
            refine = if want_key || fresh_frame {
                None
            } else {
                refiner.due()
            };
            refine.is_some()
        } else if paintover_due {
            paintover_left -= 1;
            hub.stats.paintovers.fetch_add(1, Ordering::Relaxed);
            true
        } else {
            false
        };
        if want_key {
            for c in &clients {
                c.needs_keyframe.store(false, Ordering::Relaxed);
            }
            *hub.last_keyframe.lock() = Instant::now();
            // A keyframe is squeezed into the rate cap; sharpen all of it once still.
            refiner.mark_all();
        }
        let frame_paintover = paintover && refine.is_none();
        if frame_paintover && paintover_left == 0 {
            refiner.clear_all();
        }
        // A refinement frame encodes what moved plus what is due; everything else stays skipped.
        let mb_map = if want_key {
            None
        } else if frame_paintover {
            paint_map.map(|(m, b)| {
                band = Some(match band {
                    Some(x) => union(Some(x), b),
                    None => b,
                });
                Arc::new(m)
            })
        } else if let Some((rmap, rband)) = refine.take() {
            band = Some(match band {
                Some(b) => union(Some(b), rband),
                None => rband,
            });
            let mut m = mb_dirty.take().unwrap_or_else(|| vec![1; rmap.len()]);
            for (d, r) in m.iter_mut().zip(rmap) {
                *d |= r;
            }
            hub.stats.refines.fetch_add(1, Ordering::Relaxed);
            Some(Arc::new(m))
        } else {
            mb_dirty.take().map(Arc::new)
        };
        last_capture = t0;
        next_idx = 1 - idx;
        if job_tx
            .send(Work::Frame(Job {
                buf,
                idx,
                force_idr: want_key,
                paintover,
                paintover_final: frame_paintover && paintover_left == 0,
                fresh: fresh_frame,
                // Every viewer gets the keyframe, the one that asked for it (not started, so not steering) as well:
                // the slowest track's link sets its size.
                key_kbit: clients
                    .iter()
                    .filter(|c| !c.internal)
                    .filter_map(|c| c.on_track()?.estimate_kbps())
                    .min_by(f64::total_cmp)
                    .map(key_budget_kbit),
                mb_dirty: mb_map,
                band,
                changed,
                captured_at: origin,
            }))
            .is_err()
        {
            return Err("encoder gone".into());
        }
    }
}

/// Split the screen into horizontal stripes, each an independent H.264 stream.
/// x264 pays ~9 ms of CPU per 2560x1600 frame even when nothing changed, and sliced
/// threading triples that; independent single-threaded stripes are encoded in
/// parallel (low latency) and only when they changed (low CPU).
fn stripe_layout(height: u32, n: u32) -> Vec<(u32, u32)> {
    let n = n.clamp(1, 16);
    let each = (height.div_ceil(n) + 15) & !15;
    let mut v = Vec::new();
    let mut y = 0;
    while y < height {
        let h = each.min(height - y);
        v.push((y, h));
        y += h;
    }
    v
}

struct Stripe {
    y: usize,
    h: usize,
    enc: Box<dyn VideoEncoder>,
    /// What opened `enc`, and opens it again with other threads.
    kind: Arc<dyn EncoderKind>,
    cfg: EncoderConfig,
    /// Sliced threads to fan out to under sustained heavy motion (1 = never).
    max_threads: u32,
    applied_kbps: u32,
    applied_crf: f32,
}

// Room voxl's encode loop leaves before the stream in each stripe's buffer; castd writes its headers per viewer
// instead, so none is needed.
const HDR: usize = 0;

struct SendPtr<T>(*const T);
unsafe impl<T> Send for SendPtr<T> {}
impl<T> Clone for SendPtr<T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T> Copy for SendPtr<T> {}

struct StripeJob {
    /// Valid until the worker replies: the encode loop waits for every stripe.
    buf: SendPtr<Frame>,
    ts: i64,
    force_idr: bool,
    /// A paint-over or refinement pass (`crf` is the paint-over CRF).
    paintover: bool,
    /// New content after a lull (FreshContent): a keyframe's budget at motion quality.
    fresh: bool,
    /// A keyframe's (and a fresh frame's) most, kbit, on a track (`Job::key_kbit`).
    key_kbit: Option<u32>,
    crf: f32,
    cap: u32,
    mb_dirty: Option<Arc<Vec<u8>>>,
    mb_cols: usize,
}

type StripeResult = (usize, Option<(bool, Vec<u8>)>);

/// x264's sliced threading costs ~3x the CPU of one thread on desktop content (and on
/// small updates is even slower), so a stripe encodes single-threaded and only fans out
/// while sustained heavy motion would otherwise blow the frame budget.
struct ThreadGovernor {
    threads: u32,
    ewma_ms: f64,
    heavy: u32,
    light_since: Option<Instant>,
    budget_ms: f64,
    /// One-thread encode time as a function of changed macroblocks, learned from
    /// single-threaded frames, to tell when one thread would fit again.
    fit: CostFit,
    /// Predicted one-thread time while threaded.
    predicted_ms: f64,
}

/// Exponentially weighted least squares fit of encode ms = a + b * changed MBs.
#[derive(Default)]
struct CostFit {
    w: f64,
    x: f64,
    y: f64,
    xx: f64,
    xy: f64,
}

impl CostFit {
    fn add(&mut self, x: f64, y: f64) {
        let k = 0.995;
        self.w = self.w * k + 1.0;
        self.x = self.x * k + x;
        self.y = self.y * k + y;
        self.xx = self.xx * k + x * x;
        self.xy = self.xy * k + x * y;
    }
    fn predict(&self, x: f64) -> Option<f64> {
        if self.w < 30.0 {
            return None;
        }
        let var = self.xx * self.w - self.x * self.x;
        if var <= f64::EPSILON * self.w * self.w {
            return Some(self.y / self.w);
        }
        let b = (self.xy * self.w - self.x * self.y) / var;
        let a = (self.y - b * self.x) / self.w;
        Some(a + b * x)
    }
}

impl ThreadGovernor {
    fn want(&mut self, enc_ms: f64, changed_mbs: f64, max: u32) -> Option<u32> {
        self.ewma_ms = self.ewma_ms * 0.8 + enc_ms * 0.2;
        if self.threads == 1 {
            self.fit.add(changed_mbs, enc_ms);
            // Before one thread runs out of frame budget: encode times vary from frame to
            // frame, and at ~90% of the budget on average enough frames miss it to drop
            // the frame rate.
            self.heavy = if self.ewma_ms > self.budget_ms * 0.65 {
                self.heavy + 1
            } else {
                0
            };
            if self.heavy >= 20 {
                self.predicted_ms = self.ewma_ms;
                return Some(max);
            }
            return None;
        }
        // Without enough one-thread history, assume one thread is no faster than these.
        let one = self.fit.predict(changed_mbs).unwrap_or(enc_ms);
        self.predicted_ms = self.predicted_ms * 0.8 + one * 0.2;
        if self.predicted_ms < self.budget_ms * 0.5 {
            // One thread would fit with room to spare (switching reopens the encoder,
            // which costs a keyframe, so not on a brief lull).
            let since = *self.light_since.get_or_insert_with(Instant::now);
            (since.elapsed() >= Duration::from_secs(2)).then_some(1)
        } else {
            self.light_since = None;
            None
        }
    }
}

/// x264's CRF raises the QP of frames it judges complex, and its quick half-resolution
/// estimate can't follow a dragged window or a fast scroll: the moved area counts as new
/// pixels and the QP lands 7-10 steps above `--crf`, although the real search codes the
/// move as cheap motion vectors (a few KB a frame). Big moves went blocky, with nothing
/// saved that the bitrate cap needed. Motion frames that come out that cheap get a CRF
/// lowered by what the estimate adds, so they stay at the configured quality. Video and
/// new content really are complex, and x264's higher QP there saves real bits, so those
/// are left alone, as are the lower QPs x264 picks for small updates (typing) and
/// paint-overs. VBV still raises the QP when the link is short.
#[derive(Default)]
struct MotionQuality {
    /// QP steps x264's complexity estimate adds to the next frame (negative for simple
    /// ones). x264 blurs it over the frames it encodes, paint-overs included, so each
    /// frame's is a good guess at the next one's.
    complexity: f32,
    /// log2 of the bits per changed macroblock of recent motion frames, scaled to the
    /// configured CRF. Averaged in the log domain: one frame of new content (a menu
    /// opening mid-drag) shouldn't outweigh the run of cheap frames around it.
    mb_bits_log2: f32,
    /// QP steps taken off the CRF of motion frames now.
    applied: f32,
}

/// Most QP steps taken off a motion frame's CRF.
const MAX_MOTION_EXCESS: f32 = 12.0;

/// Bits per changed macroblock (at the configured CRF) under which motion counts as
/// cheap: a dragged window or a scrolled page costs 10-30, video and new content 50 and
/// more.
const CHEAP_MB_BITS: f32 = 40.0;

impl MotionQuality {
    /// The CRF to encode a motion frame with, for the configured `crf`.
    fn crf(&mut self, crf: f32) -> f32 {
        let want = if self.mb_bits_log2 < CHEAP_MB_BITS.log2() {
            self.complexity.clamp(0.0, MAX_MOTION_EXCESS)
        } else {
            0.0
        };
        // Whole steps, and only once the estimate has moved a full step: every change
        // reconfigures x264.
        if (want - self.applied).abs() >= 1.0 {
            self.applied = want.round();
        }
        (crf - self.applied).max(0.0)
    }

    /// Notes what x264 made of a frame it was given `crf` for. `size` is set for a
    /// motion frame (not a paint-over).
    fn note(&mut self, e: &Encoded, crf: f32, size: Option<MotionSize>) {
        // A keyframe's QP isn't picked from the complexity estimate.
        let (false, Some(qp)) = (e.keyframe, e.qp) else {
            return;
        };
        self.observe(crf, qp, e);
        // Small updates cost more per macroblock (headers, a cursor's edges) and never
        // get x264's QP up; only big ones tell what kind of motion this is.
        if let Some(m) = size.filter(|m| m.changed * 16 >= m.mbs) {
            // Halving the quantizer step (6 QP) about doubles the bits.
            let b = (m.bits.max(1) as f32 / m.changed.max(1) as f32).log2() + (qp - m.crf) / 6.0;
            self.mb_bits_log2 = self.mb_bits_log2 * 0.7 + b * 0.3;
        }
    }

    /// x264 starts from QP0 = `crf` + complexity. VBV may raise that before the frame
    /// (to `qp`) and row by row within it (to an average x264 doesn't report), never
    /// below QP0 or, with a VBV buffer over 1.1 frames, below the frame's starting QP,
    /// and `e.crf_avg` is `crf` + average - QP0. So the complexity lies between
    /// `qp - e.crf_avg` (no row raised) and `qp - crf` (nothing raised before the
    /// frame), give or take the rounding of `qp`: one value when VBV stayed out, a range
    /// when it didn't. Then the last estimate is kept while it fits, else moved to the
    /// nearest end, so a frame VBV squeezed doesn't throw away what earlier frames showed.
    fn observe(&mut self, crf: f32, qp: f32, e: &Encoded) {
        let lo = qp - 0.5 - e.crf_avg;
        let hi = qp + 0.5 - crf;
        self.complexity = if hi - lo < 1.25 {
            (lo + hi) / 2.0
        } else {
            self.complexity.max(lo).min(hi)
        };
    }
}

/// How big a motion frame came out, for MotionQuality.
#[derive(Clone, Copy)]
struct MotionSize {
    bits: usize,
    /// Macroblocks that changed, of the stripe's `mbs`.
    changed: usize,
    mbs: usize,
    /// The configured CRF.
    crf: f32,
}

fn stripe_worker(
    i: usize,
    mut s: Stripe,
    rx: mpsc::Receiver<StripeJob>,
    done: mpsc::Sender<StripeResult>,
    debug: bool,
) {
    let mut gov = ThreadGovernor {
        threads: 1,
        ewma_ms: 0.0,
        heavy: 0,
        light_since: None,
        budget_ms: 1000.0 / s.cfg.fps as f64,
        fit: CostFit::default(),
        predicted_ms: 0.0,
    };
    let mut motion = MotionQuality::default();
    while let Ok(job) = rx.recv() {
        let buf = unsafe { &*job.buf.0 };
        let is_motion = !job.force_idr && !job.paintover;
        let crf = if is_motion {
            motion.crf(job.crf)
        } else {
            job.crf
        };
        if let (true, Some(most)) = (job.force_idr || job.fresh, job.key_kbit) {
            // On a track the keyframe is what the link carries in KEY_WINDOW, a full buffer of that size: no ack
            // holds the next pictures back while a larger one crosses, and the bottleneck's buffer would overflow. The
            // paint-over sharpens it once the screen is still. A track carries one stripe (rtc's `Pictures`), so the
            // stripe's buffer is the picture's.
            s.enc.set_rate_key(crf, job.cap, most);
            s.applied_kbps = 0;
        } else if job.force_idr || job.fresh {
            // A keyframe is what a new viewer sees first, and a fresh frame the new page; don't starve either to the
            // steady-state frame budget. Eight frames of buffer at 4x the cap, full, of which x264 lets one frame take
            // half: up to 16 frames' worth of the cap, though CRF keeps most far under it. The next frame sets the cap
            // back.
            let boost = job.cap.saturating_mul(4).max(16_000);
            s.enc.set_rate_buf(crf, boost, boost / s.cfg.fps.max(1) * 8);
            s.applied_kbps = 0;
        } else {
            let moved = s.applied_kbps == 0
                || (job.cap as f64 - s.applied_kbps as f64).abs() > s.applied_kbps as f64 * 0.04;
            if crf != s.applied_crf || moved {
                s.enc.set_rate(crf, job.cap);
                s.applied_crf = crf;
                s.applied_kbps = job.cap;
            }
        }
        let picture = buf.picture(s.y, s.h);
        let mut out = Vec::with_capacity(64 << 10);
        out.resize(HDR, 0);
        // x264 wants X264_MBINFO_CONSTANT (1) on unchanged macroblocks of this stripe.
        let mut info = job.mb_dirty.as_ref().map(|d| {
            let rows = s.h.div_ceil(16);
            let start = (s.y / 16) * job.mb_cols;
            d[start..start + rows * job.mb_cols]
                .iter()
                .map(|&x| (x == 0) as u8)
                .collect::<Vec<u8>>()
        });
        // Changed macroblocks in this stripe (all of them without a damage map).
        let stripe_mbs = s.h.div_ceil(16) * job.mb_cols;
        let changed = info
            .as_ref()
            .map_or(stripe_mbs, |m| m.iter().filter(|&&c| c == 0).count());
        let te = Instant::now();
        let r = s.enc.encode(
            &picture,
            job.ts,
            job.force_idr,
            None,
            info.as_deref_mut(),
            &mut out,
        );
        if te.elapsed() > STEP_SLOW {
            log::warn!(
                "stripe y{}: one picture took {} ms to encode",
                s.y,
                te.elapsed().as_millis()
            );
        }
        if debug {
            log::info!(
                "stripe y{} encode {} us wall, thread cpu total {} us, {} bytes",
                s.y,
                te.elapsed().as_micros(),
                crate::wake::thread_cpu_us(),
                out.len()
            );
        }
        if s.max_threads > 1
            && let Some(t) = gov.want(
                te.elapsed().as_secs_f64() * 1000.0,
                changed as f64,
                s.max_threads,
            )
        {
            match s.kind.open(&EncoderConfig {
                threads: t,
                ..s.cfg.clone()
            }) {
                Ok(e) => {
                    log::info!(
                        "stripe {i}: encoder now {t} thread(s) (encode {:.1} ms)",
                        gov.ewma_ms
                    );
                    // A fresh encoder opens with an IDR on its next frame, and
                    // its rate control starts over.
                    s.enc = e;
                    motion = MotionQuality::default();
                    s.applied_kbps = 0;
                    gov.threads = t;
                    gov.heavy = 0;
                    gov.light_since = None;
                }
                Err(e) => log::error!("encoder reopen failed: {e}"),
            }
        }
        let res = match r {
            Ok(e) => {
                let size = is_motion.then(|| MotionSize {
                    bits: (out.len() - HDR) * 8,
                    changed,
                    mbs: stripe_mbs,
                    crf: job.crf,
                });
                motion.note(&e, crf, size);
                (out.len() > HDR).then_some((e.keyframe, out))
            }
            Err(e) => {
                log::error!("{e}");
                None
            }
        };
        if done.send((i, res)).is_err() {
            return;
        }
    }
}

/// The CRFs a frame is encoded at: motion's, the local viewer's motion, and the paint-over's.
#[derive(Clone, Copy)]
struct Quality {
    crf: f32,
    paintover_crf: f32,
    local_crf: f32,
}

fn encode_loop(
    stripes_in: Vec<Stripe>,
    rx: mpsc::Receiver<Work>,
    ret: mpsc::Sender<(usize, Box<Frame>)>,
    hub: Arc<Hub>,
    quality: Quality,
) {
    let epoch = Instant::now();
    let mut frame_id: u32 = 0;
    let n = stripes_in.len();
    let debug_stripes = std::env::var("CASTD_DEBUG_STRIPES").is_ok();
    // Geometry and paint-over bookkeeping stay here; encoders move to their workers.
    let mut stripes: Vec<(usize, usize, bool)> =
        stripes_in.iter().map(|s| (s.y, s.h, false)).collect();
    let (done_tx, done_rx) = mpsc::channel::<StripeResult>();
    let workers: Vec<(mpsc::Sender<StripeJob>, std::thread::JoinHandle<()>)> = stripes_in
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let (tx, rx) = mpsc::channel();
            let done = done_tx.clone();
            let h = std::thread::Builder::new()
                .name(format!("enc-{i}"))
                .spawn(move || stripe_worker(i, s, rx, done, debug_stripes))
                .unwrap();
            (tx, h)
        })
        .collect();
    let whole = Rect {
        x: 0,
        y: 0,
        w: hub.width.load(Ordering::Relaxed),
        h: hub.height.load(Ordering::Relaxed),
    };
    while let Ok(work) = rx.recv() {
        let job = match work {
            Work::Frame(job) => job,
            Work::Copy(copy) => {
                send_copy(&hub, copy);
                continue;
            }
        };
        let t0 = Instant::now();
        let selected: Vec<bool> = stripes
            .iter()
            .map(|&(y, h, touched)| {
                job.force_idr
                    || (job.paintover && touched)
                    || job
                        .band
                        .is_some_and(|b| (b.y0 as usize) < y + h && (b.y1 as usize) > y)
            })
            .collect();
        if !selected.iter().any(|&x| x) {
            let _ = ret.send((job.idx, job.buf));
            continue;
        }
        let target = hub.target_kbps.load(Ordering::Relaxed);
        let motion_crf = if hub.local_steering.load(Ordering::Relaxed) {
            quality.local_crf
        } else {
            quality.crf
        };
        let want_crf = if job.paintover {
            quality.paintover_crf.min(motion_crf)
        } else {
            motion_crf
        };
        // Each stripe may use up to twice its area share of the budget; the delay-based
        // controller reins the total in if several stripes move at once.
        let share = ((target as u64 * 2) / n as u64).max(target as u64 / n as u64 + 1) as u32;
        let ts = job.captured_at.duration_since(epoch).as_millis() as i64;
        // Persistent per-stripe workers keep each encoder's state warm in one core's cache.
        let buf_ptr = SendPtr(&*job.buf as *const Frame);
        let mut pending = 0;
        for (i, &on) in selected.iter().enumerate() {
            if on {
                let cap = if job.paintover {
                    share.saturating_mul(2)
                } else {
                    share
                };
                let _ = workers[i].0.send(StripeJob {
                    buf: buf_ptr,
                    ts,
                    force_idr: job.force_idr,
                    paintover: job.paintover,
                    fresh: job.fresh,
                    key_kbit: job.key_kbit,
                    crf: want_crf,
                    cap,
                    mb_dirty: job.mb_dirty.clone(),
                    mb_cols: job.buf.width().div_ceil(16),
                });
                pending += 1;
            }
        }
        let mut results: Vec<Option<(bool, Vec<u8>)>> = (0..n).map(|_| None).collect();
        for _ in 0..pending {
            if let Ok((i, r)) = done_rx.recv() {
                results[i] = r;
            }
        }
        let _ = ret.send((job.idx, job.buf));
        for (y, h, touched) in stripes.iter_mut() {
            if job.paintover_final {
                *touched = false;
            }
            if job
                .band
                .is_some_and(|b| (b.y0 as usize) < *y + *h && (b.y1 as usize) > *y)
            {
                *touched = true;
            }
        }
        let parts: Vec<(usize, bool, Vec<u8>)> = results
            .into_iter()
            .enumerate()
            .filter_map(|(i, r)| r.map(|(k, o)| (i, k, o)))
            .collect();
        if parts.is_empty() {
            continue;
        }
        let enc_us = t0.elapsed().as_micros() as u64;
        let all_key = parts.len() == n && parts.iter().all(|p| p.1);
        let total: usize = parts.iter().map(|p| p.2.len()).sum();
        hub.stats.encode_us.fetch_add(enc_us, Ordering::Relaxed);
        hub.stats.encoded.fetch_add(1, Ordering::Relaxed);
        hub.stats.bytes.fetch_add(total as u64, Ordering::Relaxed);
        if all_key {
            hub.stats.keyframes.fetch_add(1, Ordering::Relaxed);
            hub.stats.key_bytes.store(total as u64, Ordering::Relaxed);
        }
        frame_id = frame_id.wrapping_add(1);
        let flags =
            if all_key { FLAG_KEY } else { 0 } | if job.paintover { FLAG_REFINE } else { 0 };
        let msgs: Vec<Arc<Media>> = parts
            .into_iter()
            .map(|(i, key, out)| {
                Arc::new(Media {
                    header: Header {
                        kind: KIND_VIDEO,
                        // A stripe's own keyframe can start that stripe's decoder even when the others are deltas.
                        flags: flags | if key { FLAG_KEY } else { 0 },
                        id: frame_id,
                        capture_ms: 0,
                        stripe_top: stripes[i].0 as u16,
                        stripe_index: i as u8,
                        stripe_count: n as u8,
                    },
                    captured: job.captured_at,
                    payload: Bytes::from(out),
                })
            })
            .collect();
        let now = Instant::now();
        let steer = hub.steering.load(Ordering::Relaxed);
        let interval_ms = 1000.0 / hub.fps.load(Ordering::Relaxed).max(1) as f64;
        for c in hub.video_clients() {
            let mut starting = false;
            if !c.started.load(Ordering::Relaxed) {
                if !all_key {
                    continue;
                }
                starting = true;
                c.started.store(true, Ordering::Relaxed);
                c.skipping.store(false, Ordering::Relaxed);
                c.inflight.lock().clear();
            } else if !c.internal && c.id != steer {
                if c.skipping.load(Ordering::Relaxed) {
                    // Skipped until what it has drains; then it waits for a keyframe like a new viewer.
                    if c.drained(interval_ms) {
                        c.started.store(false, Ordering::Relaxed);
                        c.needs_keyframe.store(true, Ordering::Relaxed);
                        hub.wake();
                    }
                    hub.stats.skipped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                if c.behind(interval_ms) {
                    let (backlog, age) = c.backlog();
                    log::debug!(
                        "viewer {} fell behind ({backlog} frames, {age} ms); skipping",
                        c.id
                    );
                    c.skipping.store(true, Ordering::Relaxed);
                    hub.stats.skipped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }
            // A track's pictures are never acked: its congestion control stands for the acks.
            if c.on_track().is_none() {
                let mut q = c.inflight.lock();
                if q.len() > 600 {
                    // Only the steering viewer can get here: it gates the capture, so this is a leak, not a link.
                    log::warn!("viewer {} hopelessly behind; resyncing", c.id);
                    q.clear();
                    drop(q);
                    c.restart_video();
                    continue;
                }
                q.push_back(Inflight {
                    id: frame_id,
                    sent: now,
                    bytes: total,
                });
            }
            c.frames.fetch_add(1, Ordering::Relaxed);
            if c.exacting() {
                // Drawn only where this viewer's picture is not exact (exact.rs); what it changes is lossy until the
                // next exact copy.
                let clip =
                    exact::frame_clip(&mut c.exact.lock(), frame_id, starting, job.changed, whole);
                for m in &msgs {
                    c.send(Out::Clipped(m.clone(), clip));
                }
            } else {
                for m in &msgs {
                    c.send(Out::Media(m.clone()));
                }
            }
        }
        hub.stats.send_lat_us.fetch_add(
            job.captured_at.elapsed().as_micros() as u64,
            Ordering::Relaxed,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_track_keyframe_is_what_its_link_carries_in_a_fifth_of_a_second() {
        assert_eq!(key_budget_kbit(3000.0), 600);
        assert_eq!(key_budget_kbit(9000.0), 1800);
        // A link too slow for any keyframe still gets one worth showing.
        assert_eq!(key_budget_kbit(200.0), KEY_FLOOR_KBIT);
    }

    #[test]
    fn a_page_that_loads_after_a_lull_gets_the_budget_for_its_first_paints() {
        let mut fresh = FreshContent::new();
        let t = Instant::now();
        let ms = |n: u64| t + Duration::from_millis(n);
        // Hovering a link: small changes never count.
        assert!(!fresh.motion(40, 3600, ms(0)));
        // The new page's first paint, its images 20 ms later, its web fonts 60 ms after that.
        assert!(fresh.motion(3500, 3600, ms(100)));
        assert!(fresh.motion(1800, 3600, ms(120)));
        assert!(fresh.motion(2000, 3600, ms(180)));
        // A fourth large paint inside the window is past the frames it allows.
        assert!(!fresh.motion(2000, 3600, ms(200)));
        // The next page, after a lull.
        assert!(fresh.motion(3600, 3600, ms(900)));
    }

    #[test]
    fn large_changes_that_keep_coming_get_it_only_at_their_start() {
        let mut fresh = FreshContent::new();
        let t = Instant::now();
        // A full-screen video at 60 fps: its first frames are an onset, the rest steady motion.
        let boosted = (0..600u64)
            .filter(|&i| fresh.motion(3600, 3600, t + Duration::from_micros(i * 16_667)))
            .count();
        assert_eq!(boosted, FRESH_FRAMES as usize);
    }
}

/// MotionQuality against x264's own rate control.
#[cfg(all(test, feature = "x264"))]
mod motion {
    use super::*;
    use crate::encoder::Planes;
    use crate::frame::Picture;

    const W: usize = 1280;
    const H: usize = 768;

    /// What the screen shows in a test sequence.
    #[derive(Clone, Copy)]
    enum Scene {
        /// A window of text-like detail dragged 48 px a frame across a gradient desktop.
        Drag,
        /// Noise over the whole screen, new every frame: content that really is complex.
        Noise,
    }

    fn draw(y: &mut [u8], scene: Scene, frame: usize) {
        match scene {
            Scene::Drag => {
                let (ww, wh) = (W / 2, H / 2);
                let x0 = 48 * frame % (W - ww);
                let y0 = H / 4;
                for row in 0..H {
                    let line = &mut y[row * W..(row + 1) * W];
                    line.fill((40 + row * 120 / H) as u8);
                    if (y0..y0 + wh).contains(&row) {
                        let r = row - y0;
                        for (x, p) in line[x0..x0 + ww].iter_mut().enumerate() {
                            // Lines of "glyphs": dark strokes on white, a gap between lines.
                            let glyph =
                                ((x / 9) as u64 * 2654435761 + (r / 18) as u64 * 40503) >> 7;
                            let ink = r % 18 < 12 && (glyph >> (x % 9 + r % 18 % 6)) & 1 == 1;
                            *p = if ink { 30 } else { 235 };
                        }
                    }
                }
            }
            Scene::Noise => {
                let mut state = (frame as u64 + 1).wrapping_mul(0x9E3779B97F4A7C15);
                for p in y.iter_mut() {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    *p = 64 + (state % 128) as u8;
                }
            }
        }
    }

    /// One frame as a stripe worker saw it: the CRF it handed x264 and what came back.
    struct Frame {
        crf: f32,
        e: Encoded,
        complexity: f32,
    }

    /// Encodes frames the way a stripe worker does, under a bitrate cap of `max_kbps`
    /// (0: none), with or without MotionQuality.
    struct Run {
        enc: crate::x264::X264,
        motion: MotionQuality,
        correct: bool,
        crf: f32,
        max_kbps: u32,
        applied: f32,
        y: Vec<u8>,
        n: usize,
    }

    impl Run {
        fn new(correct: bool, crf: f32, max_kbps: u32) -> Run {
            Run {
                enc: crate::x264::X264::new(&EncoderConfig {
                    width: W as u32,
                    height: H as u32,
                    fps: 60,
                    preset: "ultrafast".into(),
                    threads: 1,
                    crf,
                    max_kbps,
                })
                .unwrap(),
                motion: MotionQuality::default(),
                correct,
                crf,
                max_kbps,
                applied: crf,
                y: vec![0; W * H],
                n: 0,
            }
        }

        /// Encodes the next frame of `scene` as a motion frame, or the current picture
        /// again as a paint-over at `paintover_crf`.
        fn frame(&mut self, scene: Scene, paintover_crf: Option<f32>) -> Frame {
            let motion = paintover_crf.is_none();
            if motion {
                draw(&mut self.y, scene, self.n);
            }
            let c = match paintover_crf {
                Some(c) => c,
                None if self.correct => self.motion.crf(self.crf),
                None => self.crf,
            };
            if c != self.applied {
                self.enc.set_rate(c, self.max_kbps);
                self.applied = c;
            }
            let (u, v) = (vec![128u8; W * H / 4], vec![128u8; W * H / 4]);
            let planes = Picture::I420(Planes {
                y: &self.y,
                u: &u,
                v: &v,
                stride_y: W,
                stride_uv: W / 2,
            });
            let mut out = Vec::new();
            let e = self
                .enc
                .encode(
                    &planes,
                    self.n as i64 * 16,
                    self.n == 0,
                    None,
                    None,
                    &mut out,
                )
                .unwrap();
            let mbs = W / 16 * H / 16;
            let size = motion.then_some(MotionSize {
                bits: out.len() * 8,
                changed: mbs,
                mbs,
                crf: self.crf,
            });
            self.motion.note(&e, c, size);
            self.n += 1;
            Frame {
                crf: c,
                complexity: self.motion.complexity,
                e,
            }
        }

        /// 40 motion frames of `scene`; returns the last 30, once rate control settled.
        fn motion(mut self, scene: Scene) -> Vec<Frame> {
            (0..40).map(|_| self.frame(scene, None)).skip(10).collect()
        }
    }

    fn mean(v: impl Iterator<Item = f32>) -> f32 {
        let (sum, n) = v.fold((0.0, 0), |(s, n), x| (s + x, n + 1));
        sum / n as f32
    }

    fn qp(f: &Frame) -> f32 {
        f.e.qp.unwrap()
    }

    #[test]
    fn dragged_window_stays_at_crf() {
        let crf = 24.0;
        let plain = mean(Run::new(false, crf, 0).motion(Scene::Drag).iter().map(qp));
        let corrected = mean(Run::new(true, crf, 0).motion(Scene::Drag).iter().map(qp));
        // The scene has to show the problem for the check below to mean anything.
        assert!(
            plain > crf + 3.0,
            "x264 coded the drag at QP {plain:.1} without the correction (CRF {crf})"
        );
        assert!(
            corrected < crf + 1.0,
            "drag frames at QP {corrected:.1} for CRF {crf}"
        );
    }

    /// Under a bitrate cap VBV raises rows within a frame, which the frame's starting QP
    /// doesn't show; the estimate must not take that for a simple frame and drop the
    /// correction.
    #[test]
    fn capped_drag_keeps_its_estimate() {
        let crf = 24.0;
        // Without a cap the complexity is exactly what x264 added to the QP.
        let plain = Run::new(false, crf, 0).motion(Scene::Drag);
        let complexity = mean(plain.iter().map(|f| qp(f) - f.crf));
        let capped = Run::new(true, crf, 20_000).motion(Scene::Drag);
        let start_qp_says = capped
            .iter()
            .map(|f| qp(f) - f.e.crf_avg)
            .fold(f32::MAX, f32::min);
        assert!(
            start_qp_says < complexity - 4.0,
            "VBV never raised rows enough to matter (lowest {start_qp_says:.1}, complexity {complexity:.1})"
        );
        let lowest = capped.iter().map(|f| f.complexity).fold(f32::MAX, f32::min);
        assert!(
            lowest > complexity - 3.0,
            "estimate fell to {lowest:.1} under the cap, complexity {complexity:.1}"
        );
    }

    /// Content that really is complex keeps x264's QP: lowering it would only spend bits.
    #[test]
    fn complex_content_is_left_alone() {
        let crf = 24.0;
        let plain = mean(Run::new(false, crf, 0).motion(Scene::Noise).iter().map(qp));
        let corrected = Run::new(true, crf, 0).motion(Scene::Noise);
        assert!(
            plain > crf + 3.0,
            "x264 didn't raise the QP for noise ({plain:.1}, CRF {crf})"
        );
        let lowered = corrected.iter().filter(|f| f.crf != crf).count();
        assert_eq!(lowered, 0, "{lowered} noise frames got a lowered CRF");
    }

    /// Once the screen goes still the paint-overs show x264 forgetting the drag, so the
    /// next motion frame isn't handed the drag's correction.
    #[test]
    fn paintovers_wind_the_correction_down() {
        let crf = 24.0;
        let mut run = Run::new(true, crf, 0);
        for _ in 0..40 {
            run.frame(Scene::Drag, None);
        }
        let during = crf - run.motion.crf(crf);
        for _ in 0..3 {
            run.frame(Scene::Drag, Some(16.0));
        }
        let after = crf - run.motion.crf(crf);
        assert!(
            after <= during / 2.0,
            "correction {after} after the paint-overs, {during} during the drag"
        );
    }
}
