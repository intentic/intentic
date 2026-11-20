//! What the capture, encode, audio, cursor and clipboard threads share with the viewers' sockets: who is connected,
//! what each has acknowledged, who drives the window, and the picture's geometry.

use crate::exact::Exact;
use crate::geometry::Rect;
use crate::header::{FLAG_CLIP, Header, KIND_LOSSLESS, LEN};
use crate::rate::Viewer;
use browser_wire::{BrowserMediaServerMessage, MediaAudio, MediaCursor};
use bytes::Bytes;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// A video or audio message, shared by every viewer it goes to. Its header's capture time is written per viewer (since
/// that viewer's own `hello`), so the payload is copied once per viewer, by that viewer's writer.
pub struct Media {
    pub header: Header,
    pub captured: Instant,
    pub payload: Bytes,
}

impl Media {
    /// The message as a viewer whose clock started at `epoch` receives it.
    pub fn bytes_since(&self, epoch: Instant) -> Vec<u8> {
        let mut h = self.header;
        h.capture_ms = self
            .captured
            .saturating_duration_since(epoch)
            .as_millis()
            .min(u32::MAX as u128) as u32;
        let mut out = Vec::with_capacity(LEN + self.payload.len());
        out.resize(LEN, 0);
        h.write(&mut out);
        out.extend_from_slice(&self.payload);
        out
    }

    /// The message as a viewer drawing only `clip` of its picture receives it: the `clip` flag, and the rectangle
    /// ahead of the access unit (browser-wire's MEDIA_CLIP_LEN).
    pub fn clipped_since(&self, epoch: Instant, clip: Rect) -> Vec<u8> {
        let mut h = self.header;
        h.flags |= FLAG_CLIP;
        h.capture_ms = ms_since(self.captured, epoch);
        let mut out = Vec::with_capacity(LEN + CLIP_LEN + self.payload.len());
        out.resize(LEN, 0);
        h.write(&mut out);
        out.extend_from_slice(&rect_bytes(clip));
        out.extend_from_slice(&self.payload);
        out
    }
}

/// How many bytes a rectangle takes on the wire (browser-wire's MEDIA_CLIP_LEN).
pub const CLIP_LEN: usize = browser_wire::MEDIA_CLIP_LEN;

/// A rectangle as the wire carries it: x, y, width, height, u16 big-endian each.
pub fn rect_bytes(r: Rect) -> [u8; CLIP_LEN] {
    let mut b = [0u8; CLIP_LEN];
    for (i, v) in [r.x, r.y, r.w, r.h].into_iter().enumerate() {
        b[i * 2..i * 2 + 2].copy_from_slice(&(v.min(u16::MAX as u32) as u16).to_be_bytes());
    }
    b
}

fn ms_since(at: Instant, epoch: Instant) -> u32 {
    at.saturating_duration_since(epoch)
        .as_millis()
        .min(u32::MAX as u128) as u32
}

/// An exact copy of a rectangle of the picture (browser-wire's `lossless` kind): the X server's BGRX pixels, row after
/// row, read once the screen was still. Shared by every viewer it goes to; the frame it follows is each viewer's own.
pub struct Lossless {
    pub rect: Rect,
    pub captured: Instant,
    pub pixels: Bytes,
}

impl Lossless {
    /// The message for a viewer whose clock started at `epoch` and whose last video frame was `after`.
    pub fn bytes_since(&self, epoch: Instant, after: u32) -> Vec<u8> {
        let h = Header {
            kind: KIND_LOSSLESS,
            flags: 0,
            id: after,
            capture_ms: ms_since(self.captured, epoch),
            stripe_top: 0,
            stripe_index: 0,
            stripe_count: 0,
        };
        let mut out = Vec::with_capacity(LEN + CLIP_LEN + self.pixels.len());
        out.resize(LEN, 0);
        h.write(&mut out);
        out.extend_from_slice(&rect_bytes(self.rect));
        out.extend_from_slice(&self.pixels);
        out
    }
}

pub enum Out {
    /// A JSON message.
    Text(String),
    /// A `hello`: this viewer's capture clock restarts when it is sent.
    Hello(String),
    Media(Arc<Media>),
    /// A video message for a viewer that draws only this rectangle of it (`clip`).
    Clipped(Arc<Media>, Rect),
    /// An exact copy of part of the picture, drawn after the video frame with this id.
    Lossless(Arc<Lossless>, u32),
    /// A WebSocket ping carrying the time it was sent, for the round trip.
    Ping(u64),
    /// The socket's close frame, its code and words: the last thing a viewer castd ends is sent (`Client::end`).
    Close(u16, String),
}

pub struct Inflight {
    pub id: u32,
    pub sent: Instant,
    pub bytes: usize,
}

/// Send->ack delay tracking: `base` is the (slowly expiring) minimum, the excess over it is queueing somewhere on the
/// path (network buffers or a slow decoder).
pub struct DelayEst {
    pub base_ms: f64,
    pub base_at: Instant,
    pub queue_ms: f64,
}

pub struct RateEst {
    pub window_start: Instant,
    pub bytes: usize,
    pub rate_bps: f64,
}

pub use crate::geometry::ResizeLimits;

/// Who a new viewer is: what its token allows, whether castd itself is the viewer (a recording), and how it reaches
/// castd.
#[derive(Debug, Clone, Copy, Default)]
pub struct Joining {
    pub read_only: bool,
    pub internal: bool,
    /// On this computer's own loopback (netd said so).
    pub local: bool,
    /// Asked for `clip`ped frames and `lossless` copies.
    pub lossless: bool,
}

/// A size the viewer's box asks for: CSS pixels and device pixel ratio.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WantSize {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

pub struct Client {
    pub id: u64,
    pub tx: mpsc::UnboundedSender<Out>,
    /// Input from this viewer is ignored (a read-only token).
    pub read_only: bool,
    /// castd's own viewer (a recording): never steers the bitrate, never falls behind.
    pub internal: bool,
    /// Reaches castd on this computer's own loopback (netd's MEDIA_LISTENER_HEADER): while it drives, castd encodes for
    /// no network at all.
    pub local: bool,
    /// Asked for `clip`ped frames and `lossless` copies (MEDIA_LOSSLESS_QUERY); castd sends them while it is `local`
    /// and its stream is on the socket.
    pub lossless: bool,
    /// Its stream rides a peer connection now, where no copy goes.
    pub on_peer: AtomicBool,
    /// Where its picture is exact (exact.rs), kept by the encode thread.
    pub exact: Mutex<Exact>,
    /// How many pictures a second its display shows, as its last `resize` said (0: never said).
    pub display_hz: AtomicU32,
    pub video: AtomicBool,
    pub audio: AtomicBool,
    pub inflight: Mutex<VecDeque<Inflight>>,
    /// Smoothed min RTT (ms), from WebSocket pings.
    pub min_rtt_ms: AtomicU32,
    /// Exponentially-weighted estimate of delivered bytes/sec, from acks.
    pub delivered: Mutex<RateEst>,
    pub needs_keyframe: AtomicBool,
    /// Has received a keyframe since (re)starting video.
    pub started: AtomicBool,
    /// Fell behind while someone else steers the bitrate: frames are skipped until its backlog drains, then it gets a
    /// keyframe.
    pub skipping: AtomicBool,
    pub delay: Mutex<DelayEst>,
    /// When this viewer last sent input, in ms since the hub started (0: never).
    pub last_input: AtomicU64,
    /// The size this viewer's box last asked for.
    pub want_size: Mutex<Option<WantSize>>,
    /// Video messages sent in the current second, for `stats`.
    pub frames: AtomicU32,
    /// The decode time its last ack reported, in microseconds.
    pub decode_us: AtomicU32,
    /// When the newest token this viewer showed expires, in ms since the epoch: the one it opened with, or a fresher
    /// one it sent on the socket (`token`). u64::MAX for castd's own viewers, which hold none.
    pub token_exp: AtomicU64,
    /// Why castd ended this viewer's socket, once it has: the close code and its words.
    ended: Mutex<Option<(u16, String)>>,
    /// Wakes the socket's loop when castd ends it.
    pub ending: tokio::sync::Notify,
}

impl Client {
    pub fn send(&self, m: Out) {
        let _ = self.tx.send(m);
    }

    /// Whether its frames are `clip`ped to where its picture is not exact, and exact copies go to it.
    pub fn exacting(&self) -> bool {
        self.lossless && self.local && !self.on_peer.load(Ordering::Relaxed)
    }

    /// Ends this viewer's socket with `code` and `reason` (cut to what a close frame carries); the first ending holds.
    pub fn end(&self, code: u16, reason: &str) {
        let mut ended = self.ended.lock();
        if ended.is_some() {
            return;
        }
        let mut words = reason.to_string();
        // A close frame's reason is at most 123 bytes of UTF-8.
        while words.len() > 123 {
            words.pop();
        }
        *ended = Some((code, words));
        drop(ended);
        // A permit is kept when the socket's loop is not waiting yet.
        self.ending.notify_one();
    }

    /// Why castd ended this viewer, once it has.
    pub fn ended(&self) -> Option<(u16, String)> {
        self.ended.lock().clone()
    }

    pub fn on_ack(&self, id: u32) {
        let mut q = self.inflight.lock();
        let mut acked = 0;
        let mut sample = None;
        while let Some(f) = q.front() {
            if wrapping_le(f.id, id) {
                acked += f.bytes;
                if f.id == id {
                    sample = Some(f.sent.elapsed().as_secs_f64() * 1000.0);
                }
                q.pop_front();
            } else {
                break;
            }
        }
        drop(q);
        if let Some(ms) = sample {
            let mut e = self.delay.lock();
            if ms < e.base_ms || e.base_at.elapsed().as_secs() >= 10 {
                e.base_ms = ms;
                e.base_at = Instant::now();
            }
            let qd = ms - e.base_ms;
            e.queue_ms = e.queue_ms * 0.7 + qd * 0.3;
        }
        let mut d = self.delivered.lock();
        d.bytes += acked;
        let el = d.window_start.elapsed().as_secs_f64();
        if el >= 0.5 {
            let r = d.bytes as f64 * 8.0 / el;
            d.rate_bps = if d.rate_bps == 0.0 {
                r
            } else {
                d.rate_bps * 0.6 + r * 0.4
            };
            d.bytes = 0;
            d.window_start = Instant::now();
        }
    }

    /// Frames in flight and age of the oldest unacknowledged one.
    pub fn backlog(&self) -> (usize, u128) {
        let q = self.inflight.lock();
        (
            q.len(),
            q.front().map(|f| f.sent.elapsed().as_millis()).unwrap_or(0),
        )
    }

    pub fn rtt_ms(&self) -> f64 {
        match self.min_rtt_ms.load(Ordering::Relaxed) {
            0 => 40.0,
            r => r as f64,
        }
    }

    /// Restart video for this viewer: a keyframe first, old acks void.
    pub fn restart_video(&self) {
        self.inflight.lock().clear();
        self.started.store(false, Ordering::Relaxed);
        self.skipping.store(false, Ordering::Relaxed);
        self.needs_keyframe.store(true, Ordering::Relaxed);
    }

    /// This viewer as the bitrate policy sees it.
    pub fn viewer(&self) -> Viewer {
        let (_, age) = self.backlog();
        Viewer {
            id: self.id,
            started: self.started.load(Ordering::Relaxed),
            internal: self.internal,
            last_input: self.last_input.load(Ordering::Relaxed),
            delivered_kbps: self.delivered.lock().rate_bps / 1000.0,
            queue_ms: self.delay.lock().queue_ms,
            backlog_age_ms: age as f64,
            rtt_ms: self.rtt_ms(),
        }
    }
}

fn wrapping_le(a: u32, b: u32) -> bool {
    b.wrapping_sub(a) < 0x8000_0000
}

#[derive(Default)]
pub struct Stats {
    pub captured: AtomicU64,
    pub encoded: AtomicU64,
    pub bytes: AtomicU64,
    pub encode_us: AtomicU64,
    pub grab_us: AtomicU64,
    pub convert_us: AtomicU64,
    pub flow_blocked: AtomicU64,
    pub paintovers: AtomicU64,
    pub keyframes: AtomicU64,
    pub refines: AtomicU64,
    pub skipped: AtomicU64,
    /// Exact copies sent (one per viewer each went to), and their pixels' bytes.
    pub lossless: AtomicU64,
    pub lossless_bytes: AtomicU64,
    pub damage_wait_us: AtomicU64,
    pub send_lat_us: AtomicU64,
}

pub struct Hub {
    pub epoch: Instant,
    pub clients: Mutex<Vec<Arc<Client>>>,
    pub next_id: AtomicU64,
    pub stats: Stats,
    /// The picture's size in display pixels (the crop's when there is one).
    pub width: AtomicU32,
    pub height: AtomicU32,
    /// The whole screen's size.
    pub screen_width: AtomicU32,
    pub screen_height: AtomicU32,
    /// The region of the screen the picture is (`--crop`), None when it is the whole screen.
    pub crop: Mutex<Option<Rect>>,
    /// A new region the daemon asked for, applied by the video thread.
    pub crop_req: Mutex<Option<Rect>>,
    /// A size the daemon pinned the screen to (an emulated phone): viewers' boxes are remembered meanwhile, not applied.
    pub pinned: Mutex<Option<WantSize>>,
    /// Display pixels per CSS pixel, as the driving viewer last asked (f64 bits).
    scale: AtomicU64,
    /// The H.264 codec string of the current stream (`avc1.64001f`).
    pub codec: Mutex<String>,
    /// The encoder the current picture runs on (`x264`, `nvenc`).
    pub encoder: Mutex<&'static str>,
    /// The sound's format, when castd captures any.
    pub audio: Option<MediaAudio>,
    /// Encoded stripes as (y, height).
    pub stripes: Mutex<Vec<(u32, u32)>>,
    /// Adaptive bitrate cap applied by the encoder (kbit/s).
    pub target_kbps: AtomicU32,
    /// The viewer the bitrate follows now (0: none), chosen by the capture thread.
    pub steering: AtomicU64,
    /// That viewer is on this computer's loopback: motion is encoded at the local quality.
    pub local_steering: AtomicBool,
    /// Frames per second the capture aims at now: the local rate while a local viewer drives, else `--fps`.
    pub fps: AtomicU32,
    /// The latest cursor message, replayed to new viewers.
    pub cursor: Mutex<Option<String>>,
    /// Wakes the capture thread (acks, joins, keyframe requests).
    pub waker: crate::wake::Wake,
    /// Where viewers' input goes: the platform's input thread (input.rs), once it started.
    pub input: Mutex<Option<crate::input::Input>>,
    /// A screen size the driving viewer asked for, applied by the video thread: display pixels and the scale.
    pub resize_req: Mutex<Option<(u32, u32, f64)>>,
    /// The smallest and largest screen a resize may set, when the screen can be resized (no `--crop`, a source that
    /// resizes: RandR on Xvfb).
    pub resize_limits: Mutex<Option<ResizeLimits>>,
    /// Screenshot requests, answered by the capture thread with the current picture.
    pub snapshots: Mutex<Vec<tokio::sync::oneshot::Sender<Arc<crate::record::Snapshot>>>>,
    /// When each part of the picture last changed (`/wait`).
    pub activity: crate::wait::Activity,
    /// When the last keyframe went out.
    pub last_keyframe: Mutex<Instant>,
    /// Tokens minted before this (`iat`, ms since the epoch) open nothing: the daemon dropped every viewer then
    /// (`POST /viewers/drop`, `--not-before`), so whatever was handed out before it is dead.
    pub not_before: AtomicU64,
    /// The same for read-write tokens alone: the daemon dropped the read-write viewers then (a desktop's control
    /// handed back), and a read-only token still opens.
    pub not_before_rw: AtomicU64,
    /// How long past its newest token's expiry a viewer's socket stays open (browser-wire's
    /// MEDIA_TOKEN_GRACE_SECONDS, in ms; a test's own).
    pub token_grace_ms: AtomicU64,
}

/// The close code castd ends a socket with, by browser-wire's name for it (`MEDIA_CLOSE_CODES`).
pub fn close_code(name: &str) -> u16 {
    browser_wire::MEDIA_CLOSE_CODES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|&(_, code)| code)
        .expect("a close code browser-wire names")
}

impl Hub {
    pub fn new(scale: f64, audio: Option<MediaAudio>) -> Arc<Self> {
        Arc::new(Hub {
            epoch: Instant::now(),
            clients: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
            stats: Stats::default(),
            width: AtomicU32::new(0),
            height: AtomicU32::new(0),
            screen_width: AtomicU32::new(0),
            screen_height: AtomicU32::new(0),
            pinned: Mutex::new(None),
            crop: Mutex::new(None),
            crop_req: Mutex::new(None),
            scale: AtomicU64::new(scale.to_bits()),
            codec: Mutex::new("avc1.640028".into()),
            encoder: Mutex::new("x264"),
            audio,
            target_kbps: AtomicU32::new(0),
            steering: AtomicU64::new(0),
            local_steering: AtomicBool::new(false),
            fps: AtomicU32::new(0),
            stripes: Mutex::new(Vec::new()),
            cursor: Mutex::new(None),
            waker: crate::wake::Wake::new().expect("wake pipe"),
            input: Mutex::new(None),
            resize_req: Mutex::new(None),
            resize_limits: Mutex::new(None),
            snapshots: Mutex::new(Vec::new()),
            activity: Default::default(),
            last_keyframe: Mutex::new(Instant::now() - Duration::from_secs(60)),
            not_before: AtomicU64::new(0),
            not_before_rw: AtomicU64::new(0),
            token_grace_ms: AtomicU64::new(browser_wire::MEDIA_TOKEN_GRACE_SECONDS * 1000),
        })
    }

    /// Whether a token whose MAC, session and expiry held may still open a socket: minted after the last drop that
    /// covers it.
    pub fn token_allowed(&self, claims: &crate::token::Claims) -> bool {
        claims.iat >= self.not_before.load(Ordering::Relaxed)
            && (claims.ro || claims.iat >= self.not_before_rw.load(Ordering::Relaxed))
    }

    /// Ends every viewer's socket, or only the read-write ones, with the `dropped` close code, and refuses from now on
    /// every token minted before this (of that kind): what the daemon does when access is revoked or control handed
    /// back. castd's own viewers (a recording) go on. Answers how many sockets it ended.
    pub fn drop_viewers(&self, read_write_only: bool, reason: &str) -> usize {
        let now = crate::token::now_ms();
        let floor = if read_write_only {
            &self.not_before_rw
        } else {
            &self.not_before
        };
        floor.fetch_max(now, Ordering::Relaxed);
        let ending: Vec<Arc<Client>> = self
            .clients
            .lock()
            .iter()
            .filter(|c| !c.internal && !(read_write_only && c.read_only))
            .cloned()
            .collect();
        for c in &ending {
            c.end(close_code("dropped"), reason);
        }
        ending.len()
    }

    /// Whether a viewer's newest token expired more than the grace ago, at `now_ms` (since the epoch): its socket is
    /// then ended with the `expired` close code (media.rs). castd's own viewers never lapse.
    pub fn lapsed(&self, c: &Client, now_ms: u64) -> bool {
        let grace = self.token_grace_ms.load(Ordering::Relaxed);
        !c.internal && now_ms > c.token_exp.load(Ordering::Relaxed).saturating_add(grace)
    }

    pub fn wake(&self) {
        self.waker.signal();
    }

    pub fn drain_wake(&self) {
        self.waker.drain();
    }

    pub fn scale(&self) -> f64 {
        f64::from_bits(self.scale.load(Ordering::Relaxed))
    }

    pub fn set_scale(&self, scale: f64) {
        self.scale.store(scale.to_bits(), Ordering::Relaxed);
    }

    /// Milliseconds since the hub started, never 0 (0 means "never" in `last_input`).
    pub fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64 + 1
    }

    pub fn add_client(&self, tx: mpsc::UnboundedSender<Out>, joining: Joining) -> Arc<Client> {
        let c = Arc::new(Client {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            tx,
            read_only: joining.read_only,
            internal: joining.internal,
            local: joining.local,
            lossless: joining.lossless,
            on_peer: AtomicBool::new(false),
            exact: Mutex::new(Exact::default()),
            display_hz: AtomicU32::new(0),
            video: AtomicBool::new(false),
            audio: AtomicBool::new(false),
            inflight: Mutex::new(VecDeque::new()),
            min_rtt_ms: AtomicU32::new(0),
            delivered: Mutex::new(RateEst {
                window_start: Instant::now(),
                bytes: 0,
                rate_bps: 0.0,
            }),
            needs_keyframe: AtomicBool::new(true),
            started: AtomicBool::new(false),
            skipping: AtomicBool::new(false),
            delay: Mutex::new(DelayEst {
                base_ms: f64::MAX,
                base_at: Instant::now(),
                queue_ms: 0.0,
            }),
            last_input: AtomicU64::new(0),
            want_size: Mutex::new(None),
            frames: AtomicU32::new(0),
            decode_us: AtomicU32::new(0),
            token_exp: AtomicU64::new(u64::MAX),
            ended: Mutex::new(None),
            ending: tokio::sync::Notify::new(),
        });
        self.clients.lock().push(c.clone());
        c
    }

    pub fn remove_client(&self, id: u64) {
        self.clients.lock().retain(|c| c.id != id);
        self.wake();
    }

    pub fn video_clients(&self) -> Vec<Arc<Client>> {
        self.clients
            .lock()
            .iter()
            .filter(|c| c.video.load(Ordering::Relaxed))
            .cloned()
            .collect()
    }

    /// The viewer driving the window: the latest to send input. None while nobody has.
    pub fn driver(&self) -> Option<Arc<Client>> {
        self.clients
            .lock()
            .iter()
            .filter(|c| !c.read_only && !c.internal)
            .filter(|c| c.last_input.load(Ordering::Relaxed) > 0)
            .max_by_key(|c| c.last_input.load(Ordering::Relaxed))
            .cloned()
    }

    /// Notes input from `c`. A viewer that takes over driving brings the size its box last asked for with it.
    pub fn note_input(&self, c: &Client) {
        let before = self.driver().map(|d| d.id);
        c.last_input.store(self.now_ms(), Ordering::Relaxed);
        if before != Some(c.id)
            && self.pinned.lock().is_none()
            && let Some(want) = *c.want_size.lock()
        {
            self.request_resize(want);
        }
    }

    /// A viewer's box asks for `want`. Applied when it drives the window, or nobody does yet.
    pub fn on_resize(&self, c: &Client, want: WantSize) {
        *c.want_size.lock() = Some(want);
        if self.pinned.lock().is_some() {
            return;
        }
        let driver = self.driver();
        if driver.as_ref().is_none_or(|d| d.id == c.id) {
            self.request_resize(want);
        }
    }

    /// Pins the screen to `want` (the daemon emulating a phone), or with None hands it back to the driving viewer's
    /// box, else to the box a viewer asked for last.
    /// Returns the screen size it asked for, if a resize is under way.
    pub fn pin(&self, want: Option<WantSize>) -> Option<(u32, u32)> {
        *self.pinned.lock() = want;
        if let Some(w) = want {
            return self.request_resize(w);
        }
        let back = self.driver().and_then(|d| *d.want_size.lock()).or_else(|| {
            self.clients
                .lock()
                .iter()
                .rev()
                .filter(|c| !c.read_only && !c.internal)
                .find_map(|c| *c.want_size.lock())
        });
        back.and_then(|w| self.request_resize(w))
    }

    /// Asks the video thread for the screen `want` makes; returns that size, or None when nothing is to change.
    fn request_resize(&self, want: WantSize) -> Option<(u32, u32)> {
        let same_scale = (self.scale() - want.scale).abs() < 1e-6;
        let Some((min, max)) = *self.resize_limits.lock() else {
            // The screen keeps its size (a crop, or no RandR); the scale is still the viewer's.
            if !same_scale {
                self.set_scale(want.scale);
                self.restart_clients();
                self.wake();
            }
            return None;
        };
        let (w, h) = crate::geometry::fit(
            (want.width as f64 * want.scale).round() as u32,
            (want.height as f64 * want.scale).round() as u32,
            min,
            max,
        );
        let current = (
            self.width.load(Ordering::Relaxed),
            self.height.load(Ordering::Relaxed),
        );
        if (w, h) == current && same_scale {
            return None;
        }
        *self.resize_req.lock() = Some((w, h, want.scale));
        self.wake();
        Some((w, h))
    }

    /// Waits until the picture is `size` (the video thread rebuilt at it), at most `within`; whether it is.
    pub async fn settled_at(&self, size: (u32, u32), within: std::time::Duration) -> bool {
        let end = Instant::now() + within;
        loop {
            let now = (
                self.width.load(Ordering::Relaxed),
                self.height.load(Ordering::Relaxed),
            );
            if now == size && self.resize_req.lock().is_none() && self.crop_req.lock().is_none() {
                return true;
            }
            if Instant::now() >= end {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// The `hello` for a viewer.
    pub fn hello(&self, c: &Client) -> String {
        serde_json::to_string(&BrowserMediaServerMessage::Hello {
            width: self.width.load(Ordering::Relaxed),
            height: self.height.load(Ordering::Relaxed),
            scale: self.scale(),
            codec: self.codec.lock().clone(),
            audio: self.audio.clone(),
            read_only: c.read_only,
            rtc: crate::rtc::offered().then_some(true),
            local: c.local.then_some(true),
        })
        .expect("hello serializes")
    }

    /// After the stream restarts (new size or scale): every viewer needs the new geometry and a keyframe, and acks for
    /// the old stream's frames no longer apply.
    pub fn restart_clients(&self) {
        for c in self.clients.lock().iter() {
            c.restart_video();
            c.send(Out::Hello(self.hello(c)));
        }
    }

    /// Sends a JSON message to every viewer `to` accepts.
    pub fn broadcast(&self, msg: &BrowserMediaServerMessage, to: impl Fn(&Client) -> bool) {
        let Ok(text) = serde_json::to_string(msg) else {
            return;
        };
        for c in self.clients.lock().iter() {
            if !c.internal && to(c) {
                c.send(Out::Text(text.clone()));
            }
        }
    }

    /// A copy made on the screen (any owner but the platform's own): sent to every viewer that may drive it, since a
    /// read-only viewer's own clipboard is not someone else's to write. The platform leaves out what it set itself.
    pub fn clipboard_changed(&self, content: &crate::clipboard::ClipContent) {
        self.broadcast(
            &BrowserMediaServerMessage::Clipboard {
                content: content.to_wire(),
            },
            |c| !c.read_only,
        );
    }

    /// The pointer's shape changed: every viewer draws the new one, and a viewer that joins later gets it first.
    pub fn set_cursor(&self, cursor: MediaCursor) {
        let msg = BrowserMediaServerMessage::Cursor { cursor };
        if let Ok(text) = serde_json::to_string(&msg) {
            *self.cursor.lock() = Some(text);
        }
        self.broadcast(&msg, |_| true);
    }
}
