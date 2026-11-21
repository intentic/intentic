//! One viewer's peer connection: str0m driven by castd's runtime, fed the datagrams the shared port routed to it, the
//! viewer's channels mapped to the media socket's traffic (browser-wire's `RTC_CHANNELS`), and, where the viewer's
//! offer carried a receive-only H.264 video section, the pictures as RTP on that track ([`Feedback`], `track`).

use super::chunk::{TextJoiner, media_chunks};
use super::{Datagram, Ice, Service};
use browser_wire::RTC_MESSAGE_MAX;
use bytes::Bytes;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use str0m::bwe::{Bitrate, BweKind};
use str0m::change::SdpOffer;
use str0m::channel::{ChannelData, ChannelId};
use str0m::crypto::CryptoProvider;
use str0m::format::Codec;
use str0m::media::{MediaKind, MediaTime, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::rtp::Extension;
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, Rtc};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// What the viewer's writer hands its peer once the peer carries the stream.
pub enum ToPeer {
    /// A JSON message, on `media` in order with the pictures.
    Text(String),
    /// A video message (header and payload), on `media`, cut into chunks when it is longer than a message may be.
    Video(Vec<u8>),
    /// A picture for the video track: one H.264 access unit (Annex B), when its content was captured, and whether it is
    /// a keyframe. Only once the peer opened with a track ([`Peer::track`]); dropped otherwise.
    Frame {
        unit: Bytes,
        captured: Instant,
        key: bool,
    },
    /// An Opus packet on `audio`, dropped rather than queued when the channel is full.
    Audio(Vec<u8>),
    /// A `pointer` message: on the unordered `pointer` channel where the viewer opened one, else on `media` in order.
    Pointer(String),
    /// A candidate the viewer trickled (`rtcCandidate`, `candidate:…`): taken with full ICE, ignored by ICE-lite, which
    /// learns the viewer's address from its checks.
    Candidate(String),
}

/// What a peer tells the viewer's socket.
pub enum PeerEvent {
    /// `media` and `input` are open: the stream may move onto them, its pictures onto the track when [`Peer::track`]
    /// says one carries them.
    Open,
    /// A JSON message the viewer sent on `input`.
    Input(String),
    /// The viewer's decoder lost the track's stream (PLI or FIR): a keyframe, please.
    Keyframe,
    /// The round trip RTCP measured, in milliseconds (the track's receiver reports).
    Rtt(u32),
    /// The peer is gone, in words for the log; the stream belongs on the socket.
    Closed(String),
}

/// What the pictures are, for a viewer's offer that asks for them on a video track.
#[derive(Debug, Clone, Copy, Default)]
pub struct Pictures {
    /// The pictures are one H.264 stream (a single stripe), so a track can carry them.
    pub trackable: bool,
    /// The stream's `profile_idc` (from its codec string), to pick the payload type that names that profile.
    pub profile: Option<u8>,
    /// Where the track's congestion control starts, and the most castd would ever send, kbit/s.
    pub start_kbps: u32,
    pub max_kbps: u32,
}

/// What a peer's video track says about its link, read by the bitrate controller and the per-viewer skip (hub.rs):
/// str0m's congestion control's estimate (Google's, over transport-wide feedback), and how far what castd sent on the
/// track runs ahead of [`TRACK_SHARE`] of it, as a bucket that share drains: the frames to drop at the source when an
/// encoder puts out more than its target (openh264 at its QP ceiling on content too busy for the link), which would
/// otherwise fill the bottleneck's buffer, and every retransmission behind it.
#[derive(Debug, Default)]
pub struct Feedback {
    estimate_kbps: AtomicU32,
    /// Whether the track's packets go out twice ([`Copies`]).
    copies: AtomicBool,
    /// The share of packets the link loses as [`Copies`] reads it, in millionths; 0 before it read any.
    loss_ppm: AtomicU32,
    queued: Mutex<Bucket>,
    /// Since when the oldest packet str0m has yet to send on the track (a picture's or a resend's) has waited in its
    /// pacer; None while it holds none.
    unsent_since: Mutex<Option<Instant>>,
    /// The capture time the track's RTP clock counts from: its first picture's.
    base: OnceLock<Instant>,
}

#[derive(Debug, Default)]
struct Bucket {
    bytes: f64,
    at: Option<Instant>,
}

impl Feedback {
    /// The congestion controller's estimate, kbit/s; None until it made one.
    pub fn estimate_kbps(&self) -> Option<f64> {
        match self.estimate_kbps.load(Ordering::Relaxed) {
            0 => None,
            kbps => Some(f64::from(kbps)),
        }
    }

    /// What of the estimate the pictures may take, kbit/s: all of it, or half while the track's packets go out twice
    /// ([`Feedback::copies`]): str0m paces the copies and the estimate counts them as it does the pictures, so pictures
    /// sent at the whole estimate would leave them no room. None until there is an estimate.
    pub fn media_kbps(&self) -> Option<f64> {
        let estimate = self.estimate_kbps()?;
        Some(if self.copies() {
            estimate / 2.0
        } else {
            estimate
        })
    }

    /// Whether the track's packets go out twice, each again on the RTX stream right behind it ([`Copies`]).
    pub fn copies(&self) -> bool {
        self.copies.load(Ordering::Relaxed)
    }

    /// The share of packets the link loses, as the copies' policy reads it ([`Copies`]); 0 until it read some.
    pub fn loss(&self) -> f64 {
        f64::from(self.loss_ppm.load(Ordering::Relaxed)) / 1e6
    }

    fn set_estimate(&self, kbps: u32) {
        self.drain(Instant::now());
        self.estimate_kbps.store(kbps.max(1), Ordering::Relaxed);
    }

    fn set_copies(&self, on: bool) {
        self.drain(Instant::now());
        self.copies.store(on, Ordering::Relaxed);
    }

    fn drain_bytes_per_ms(&self) -> f64 {
        self.media_kbps().unwrap_or(0.0) * TRACK_SHARE / 8.0
    }

    fn drain(&self, now: Instant) {
        let rate = self.drain_bytes_per_ms();
        let mut b = self.queued.lock();
        if let Some(at) = b.at {
            let ms = now.saturating_duration_since(at).as_secs_f64() * 1000.0;
            b.bytes = (b.bytes - ms * rate).max(0.0);
        }
        b.at = Some(now);
    }

    /// `bytes` more went out on the track; nothing is counted before there is an estimate to drain it, and never more
    /// than [`AHEAD_AT_MOST`] of the share: what a link's buffer held past that it dropped, and the estimate that
    /// collapsed after such a loss would otherwise hold the capture back for seconds while nothing is in flight.
    fn written(&self, bytes: usize) {
        if self.estimate_kbps().is_none() {
            return;
        }
        self.drain(Instant::now());
        let most = self.drain_bytes_per_ms() * AHEAD_AT_MOST.as_secs_f64() * 1000.0;
        let mut b = self.queued.lock();
        b.bytes = (b.bytes + bytes as f64).min(most);
    }

    /// The RTP timestamp of a picture captured at `captured`: 90 kHz from the track's first picture.
    pub fn rtp_of(&self, captured: Instant) -> u32 {
        let base = *self.base.get_or_init(|| captured);
        (captured.saturating_duration_since(base).as_micros() as u64 * 9 / 100) as u32
    }

    /// How far what castd sent on the track runs ahead of its share of the estimate, in milliseconds of that share (0
    /// before there is an estimate), or how long the oldest packet str0m still holds has waited, whichever is more:
    /// every resend the viewer asks for goes ahead of the pictures in str0m's pacer, so after a burst of loss the
    /// pictures can queue there behind them with the bucket empty (measured: a second of standing delay through a
    /// 3 Mbit/s step, until this counted it).
    pub fn queue_ms(&self) -> f64 {
        let now = Instant::now();
        self.drain(now);
        let rate = self.drain_bytes_per_ms();
        let counted = if rate > 0.0 {
            self.queued.lock().bytes / rate
        } else {
            0.0
        };
        let waiting = self.unsent_since.lock().map_or(0.0, |at| {
            now.saturating_duration_since(at).as_secs_f64() * 1000.0
        });
        counted.max(waiting)
    }

    fn set_unsent_since(&self, at: Option<Instant>) {
        *self.unsent_since.lock() = at;
    }
}

/// A peer connection's handle: dropping it ends the peer and frees its ufrag on the port.
pub struct Peer {
    tx: mpsc::UnboundedSender<ToPeer>,
    task: JoinHandle<()>,
    feedback: Arc<Feedback>,
    track: Arc<OnceLock<bool>>,
}

impl Peer {
    /// Hands the peer something to send; false once the peer has ended.
    pub fn send(&self, message: ToPeer) -> bool {
        self.tx.send(message).is_ok()
    }

    /// Once it opened: whether its video track carries the pictures (the offer had one castd can send H.264 on), and
    /// what that track says about its link. None for pictures on `media`.
    pub fn track(&self) -> Option<Arc<Feedback>> {
        (self.track.get() == Some(&true)).then(|| self.feedback.clone())
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// What may sit in SCTP's send buffer, sent and not yet acknowledged. A keyframe of a large screen is a few hundred
/// kilobytes, and castd's own ack window bounds how much video waits; str0m's default (128 KiB) held a keyframe back a
/// round trip per 128 KiB.
const SEND_BUFFER: usize = 4 * 1024 * 1024;
/// The largest message castd takes from a viewer: a pasted image's `clipboard` arrives chunked well below this.
const RECEIVE_MAX: u32 = 16 * 1024 * 1024;
/// How long a peer may take from the answer to its open channels, past which castd gives up on it.
const OPEN_WITHIN: Duration = Duration::from_secs(20);
/// How long an open peer may hear nothing at all: a browser re-checks consent every five seconds (RFC 7675).
const SILENT_FOR: Duration = Duration::from_secs(15);
/// How long ICE may stay disconnected before the peer is let go: str0m's `Disconnected` can resolve by itself.
const DISCONNECTED_FOR: Duration = Duration::from_secs(5);
/// The share of a track's congestion estimate castd sends at: the rest is room for retransmissions (a loss repaired
/// costs its packet again) and for the estimate to be a little high without filling the bottleneck's buffer.
pub const TRACK_SHARE: f64 = 0.85;
/// The furthest a track is counted ahead of its share (`Feedback::queue_ms`): about what a home router buffers.
const AHEAD_AT_MOST: Duration = Duration::from_millis(500);
/// What a track keeps to answer NACKs with: str0m's defaults (`send_buffer_video`, its RTX cache's age), without the
/// cap on resends.
const RTX_PACKETS: usize = 1000;
const RTX_AGE: Duration = Duration::from_secs(3);
/// The lowest a track's congestion control starts at, kbit/s.
const TRACK_START_KBPS: u32 = 2000;
/// How many due timeouts the peer takes in a row, and for how long at most, before it reads what came in: a frame's
/// packets, and then some, never so many that what the viewer says waits behind them.
const DUE_AT_ONCE: usize = 1024;
const DUE_FOR: Duration = Duration::from_millis(5);
/// How often str0m reports the round trip and the track's counters.
const STATS_EVERY: Duration = Duration::from_millis(500);
/// When a track's packets go out twice ([`Copies`]): from a round trip this long and this share of packets lost, off
/// again below the lower pair, and never sooner than [`COPIES_HOLD`] after going on.
const COPIES_ON_RTT: Duration = Duration::from_millis(80);
const COPIES_OFF_RTT: Duration = Duration::from_millis(60);
const COPIES_ON_LOSS: f64 = 0.003;
const COPIES_OFF_LOSS: f64 = 0.001;
const COPIES_HOLD: Duration = Duration::from_secs(10);
/// A second that lost more than this was a queue overflowing (a link's cap falling), which the congestion control
/// answers, not the steady loss copies are for: the copies' policy leaves it out (measured on the bench: 17 to 57% in
/// the seconds after its cap fell, and at most 5.4% in any second of 2% random loss).
const BURST_LOSS: f64 = 0.1;
/// How many of str0m's stats samples (one every [`STATS_EVERY`]) the copies' policy reads, and the fewest it decides on.
const COPIES_WINDOW: usize = 20;
const COPIES_SAMPLES_MIN: usize = 6;
/// The RTP header extension id castd offers the playout delay under (renumbered to the viewer's on answering): a
/// zero delay tells the viewer's jitter buffer to show each picture as soon as it is whole.
const PLAYOUT_DELAY_EXT: u8 = 6;

fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    PROVIDER
        .get_or_init(|| Arc::new(str0m::crypto::from_feature_flags()))
        .clone()
}

/// Takes the viewer's offer: the answer to send it (castd's candidates are in it), and the peer, whose events arrive
/// on `events`. Refused with words when castd serves no peer port or the offer is not one it can answer. Pictures go on
/// `media`; [`accept_with`] lets a video track the offer asks for carry them.
pub fn accept(
    offer: &str,
    events: mpsc::UnboundedSender<PeerEvent>,
) -> Result<(String, Peer), String> {
    accept_with(offer, events, Pictures::default())
}

/// [`accept`], with what the pictures are: when they are `trackable` and the offer has a receive-only video section
/// with H.264 in it, the peer opens with its track carrying them ([`Peer::track`]).
pub fn accept_with(
    offer: &str,
    events: mpsc::UnboundedSender<PeerEvent>,
    pictures: Pictures,
) -> Result<(String, Peer), String> {
    let service = Service::get().ok_or("castd takes no peer connections (no --rtc-udp)")?;
    let reflexive = service.reflexive.lock().clone();
    if service.candidates.is_empty() && reflexive.is_empty() {
        return Err("castd's peer port is published nowhere a viewer can reach".into());
    }
    let offer = SdpOffer::from_sdp_string(offer).map_err(|e| format!("not an SDP offer: {e}"))?;
    let creds = IceCreds::new();
    let ufrag = creds.ufrag.clone();
    let mut builder = Rtc::builder()
        .set_ice_lite(service.ice == Ice::Lite)
        .set_local_ice_credentials(creds)
        .set_crypto_provider(provider())
        .set_sctp_max_buffered_amount(SEND_BUFFER)
        .set_sctp_max_message_size(RECEIVE_MAX)
        .set_stats_interval(Some(STATS_EVERY))
        // castd's pictures are H.264 and nothing else; the viewer's offer names which of its payload types those are.
        .clear_codecs()
        .enable_h264(true)
        .set_extension(PLAYOUT_DELAY_EXT, Extension::PlayoutDelay);
    if pictures.trackable {
        // From where castd aims now, but no lower than a typical uplink carries: the socket's own controller may have
        // been pressed to its floor by the very link the track is here to cross, and the estimate climbs slowly from
        // there (a few hundred kbit/s a second at a 100 ms round trip).
        let start = pictures.start_kbps.max(TRACK_START_KBPS);
        builder = builder.enable_bwe(Some(Bitrate::kbps(u64::from(start))));
    }
    let mut rtc = builder.build(Instant::now());
    for address in &service.candidates {
        let candidate =
            Candidate::host(*address, "udp").map_err(|e| format!("candidate {address}: {e}"))?;
        rtc.add_local_candidate(candidate);
    }
    for (address, base) in reflexive {
        match Candidate::server_reflexive(address, base, "udp") {
            Ok(candidate) => {
                rtc.add_local_candidate(candidate);
            }
            Err(e) => log::warn!("rtc: server-reflexive candidate {address}: {e}"),
        }
    }
    let answer = rtc
        .sdp_api()
        .accept_offer(offer)
        .map_err(|e| format!("the offer cannot be answered: {e}"))?;
    let datagrams = service.register(&ufrag);
    let (tx, rx) = mpsc::unbounded_channel();
    let feedback = Arc::new(Feedback::default());
    let track = Arc::new(OnceLock::new());
    let task = tokio::spawn(run(Running {
        rtc,
        service,
        ufrag,
        datagrams,
        outgoing: rx,
        events,
        pictures,
        feedback: feedback.clone(),
        track: track.clone(),
    }));
    Ok((
        answer.to_sdp_string(),
        Peer {
            tx,
            task,
            feedback,
            track,
        },
    ))
}

struct Running {
    rtc: Rtc,
    service: Arc<Service>,
    ufrag: String,
    datagrams: mpsc::Receiver<Datagram>,
    outgoing: mpsc::UnboundedReceiver<ToPeer>,
    events: mpsc::UnboundedSender<PeerEvent>,
    pictures: Pictures,
    feedback: Arc<Feedback>,
    /// Set once, as the peer opens: whether the track carries the pictures.
    track: Arc<OnceLock<bool>>,
}

/// The viewer's channels as they open, by the label each was opened with, and its video section.
#[derive(Default)]
struct Channels {
    media: Option<ChannelId>,
    audio: Option<ChannelId>,
    input: Option<ChannelId>,
    pointer: Option<ChannelId>,
    /// The video section castd may send on (the offer's receive-only one).
    video: Option<Mid>,
    /// Once open with a track: where its pictures go.
    track: Option<Track>,
}

/// The video track carrying the pictures: its section, and the H.264 payload type the viewer named.
struct Track {
    mid: Mid,
    pt: Pt,
    /// A picture could not be written: every one after it would be decoded against the wrong reference, with nothing
    /// lost on the wire to say so, so none goes until the keyframe asked for.
    broken: bool,
    /// Whether its packets go out twice.
    copies: Copies,
}

/// Whether a track's packets go out twice: each again on the RTX stream right behind it, unasked (str0m's proactive
/// RTX). A browser hands an H.264 picture to its decoder only once every packet before it has arrived (libwebrtc's
/// packet buffer), so a lost packet holds the picture, and every one behind it, until the resend its NACK asked for
/// arrives, a round trip later: on a long link with steady loss the picture stalls at every loss. With a copy right
/// behind each packet a loss holds nothing unless the copy is lost too. The copies take their part of the congestion
/// estimate, which the encoder leaves them ([`Feedback::media_kbps`]), so they go on only where the round trip is long
/// and loss steady, and off again once either is not.
#[derive(Debug, Default)]
struct Copies {
    /// str0m's last [`COPIES_WINDOW`] stats samples, oldest first: the share of packets lost in the second before each
    /// (from transport-wide feedback), and the round trip.
    samples: VecDeque<(Option<f32>, Option<Duration>)>,
    /// Since when the copies have been on.
    on_since: Option<Instant>,
    /// On or off for the whole session whatever the link (`CAST_TRACK_COPIES=1` or `0`, for measuring).
    forced: Option<bool>,
}

impl Copies {
    fn new() -> Self {
        let forced = match std::env::var("CAST_TRACK_COPIES").as_deref() {
            Ok("1") => Some(true),
            Ok("0") => Some(false),
            _ => None,
        };
        Copies {
            forced,
            ..Copies::default()
        }
    }

    /// Takes a stats sample at `now`: whether the packets go out twice, when that changes.
    fn update(&mut self, loss: Option<f32>, rtt: Option<Duration>, now: Instant) -> Option<bool> {
        self.samples.push_back((loss, rtt));
        while self.samples.len() > COPIES_WINDOW {
            self.samples.pop_front();
        }
        if self.forced.is_some() {
            return None;
        }
        let (loss, rtt) = (self.loss()?, self.rtt()?);
        match self.on_since {
            None if rtt >= COPIES_ON_RTT && loss >= COPIES_ON_LOSS => {
                self.on_since = Some(now);
                Some(true)
            }
            Some(since)
                if (rtt < COPIES_OFF_RTT || loss < COPIES_OFF_LOSS)
                    && now.saturating_duration_since(since) >= COPIES_HOLD =>
            {
                self.on_since = None;
                Some(false)
            }
            _ => None,
        }
    }

    /// The share of packets the link loses: the mean of the window's per-second figures, less any second past
    /// [`BURST_LOSS`]. None until [`COPIES_SAMPLES_MIN`] seconds count.
    fn loss(&self) -> Option<f64> {
        let losses: Vec<f64> = self
            .samples
            .iter()
            .filter_map(|(loss, _)| loss.map(f64::from))
            .filter(|loss| *loss <= BURST_LOSS)
            .collect();
        (losses.len() >= COPIES_SAMPLES_MIN)
            .then(|| losses.iter().sum::<f64>() / losses.len() as f64)
    }

    /// The round trip: the shortest the window saw, which queueing does not lengthen.
    fn rtt(&self) -> Option<Duration> {
        self.samples.iter().filter_map(|(_, rtt)| *rtt).min()
    }
}

async fn run(mut r: Running) {
    let started = Instant::now();
    let why = drive(&mut r, started).await;
    r.service.forget(&r.ufrag);
    r.rtc.disconnect();
    log::info!("rtc: peer {} closed: {why}", r.ufrag);
    let _ = r.events.send(PeerEvent::Closed(why));
}

/// Runs the peer until it ends, and says why.
async fn drive(r: &mut Running, started: Instant) -> String {
    let mut channels = Channels::default();
    let mut open = false;
    // Messages for `media` that SCTP's buffer could not take yet, oldest first: each stays in order behind the last.
    let mut waiting: VecDeque<(bool, Vec<u8>)> = VecDeque::new();
    let mut joiner = TextJoiner::default();
    let mut heard = Instant::now();
    let mut disconnected: Option<Instant> = None;
    loop {
        // str0m hands out one paced packet per timeout: a timeout already due is taken here, not after a trip through
        // tokio's millisecond timer, which spread a frame's packets a millisecond apart (7 ms for a 720p delta on a LAN).
        let mut due = 0;
        let polled = Instant::now();
        let timeout = loop {
            match r.rtc.poll_output() {
                Ok(Output::Timeout(at)) => {
                    let now = Instant::now();
                    if at > now || due >= DUE_AT_ONCE || now.duration_since(polled) >= DUE_FOR {
                        break at;
                    }
                    due += 1;
                    if let Err(e) = r.rtc.handle_input(Input::Timeout(now)) {
                        return format!("str0m: {e}");
                    }
                }
                Ok(Output::Transmit(t)) => {
                    if r.service.ice == Ice::Full {
                        r.service.sent_to(t.destination, &r.ufrag);
                    }
                    // Never waited on: a send buffer full of what the path still holds (a burst into a slow link) would
                    // stall this loop, and with it everything the viewer says, for as long as the link takes to drain.
                    // UDP was always allowed to lose a datagram, and every protocol on it repairs one.
                    if let Err(e) = r.service.socket.try_send_to(&t.contents, t.destination) {
                        log::debug!("rtc: a datagram to {} dropped: {e}", t.destination);
                    }
                }
                Ok(Output::Event(event)) => match event {
                    Event::IceConnectionStateChange(state) => {
                        disconnected = match state {
                            IceConnectionState::Disconnected => {
                                disconnected.or(Some(Instant::now()))
                            }
                            _ => None,
                        };
                    }
                    Event::MediaAdded(added) => {
                        if added.kind == MediaKind::Video && added.direction.is_sending() {
                            channels.video.get_or_insert(added.mid);
                        }
                    }
                    Event::ChannelOpen(id, label) => {
                        match label.as_str() {
                            "media" => channels.media = Some(id),
                            "audio" => channels.audio = Some(id),
                            "input" => channels.input = Some(id),
                            "pointer" => channels.pointer = Some(id),
                            other => log::debug!("rtc: ignoring a channel named {other:?}"),
                        }
                        if !open && channels.media.is_some() && channels.input.is_some() {
                            open = true;
                            channels.track =
                                open_track(&mut r.rtc, channels.video, &r.pictures, &r.feedback);
                            let _ = r.track.set(channels.track.is_some());
                            let _ = r.events.send(PeerEvent::Open);
                        }
                    }
                    Event::ChannelData(ChannelData { id, binary, data }) => {
                        if Some(id) != channels.input {
                            continue;
                        }
                        let text = if binary {
                            joiner.push(&data)
                        } else {
                            String::from_utf8(data).ok()
                        };
                        if let Some(text) = text {
                            let _ = r.events.send(PeerEvent::Input(text));
                        }
                    }
                    Event::ChannelClose(id) => {
                        if Some(id) == channels.media || Some(id) == channels.input {
                            return "the viewer closed its channels".into();
                        }
                        if Some(id) == channels.pointer {
                            channels.pointer = None;
                        }
                    }
                    Event::ChannelBufferedAmountLow(id) if Some(id) == channels.media => {
                        flush(&mut r.rtc, channels.media, &mut waiting);
                    }
                    Event::KeyframeRequest(_) if channels.track.is_some() => {
                        let _ = r.events.send(PeerEvent::Keyframe);
                    }
                    Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                        r.feedback.set_estimate((estimate.as_u64() / 1000) as u32);
                    }
                    Event::PeerStats(stats) => {
                        if let Some(rtt) = stats.rtt.filter(|_| channels.track.is_some()) {
                            let _ = r.events.send(PeerEvent::Rtt(rtt.as_millis() as u32));
                        }
                        if let Some(track) = channels.track.as_mut() {
                            let now = Instant::now();
                            let changed =
                                track
                                    .copies
                                    .update(stats.egress_loss_fraction, stats.rtt, now);
                            if let Some(loss) = track.copies.loss() {
                                r.feedback
                                    .loss_ppm
                                    .store((loss * 1e6).round() as u32, Ordering::Relaxed);
                            }
                            if let Some(on) = changed {
                                set_copies(&mut r.rtc, track, &r.feedback, on);
                            }
                        }
                    }
                    _ => {}
                },
                Err(e) => return format!("str0m: {e}"),
            }
        };
        if let Some(track) = &channels.track {
            let since = r
                .rtc
                .direct_api()
                .stream_tx_by_mid(track.mid, None)
                .and_then(|tx| tx.queue_info().and_then(|q| q.first_unsent()));
            r.feedback.set_unsent_since(since);
        }
        if !r.rtc.is_alive() {
            return "the connection ended".into();
        }
        let now = Instant::now();
        if !open && now.duration_since(started) > OPEN_WITHIN {
            return format!("no channels open within {OPEN_WITHIN:?}");
        }
        if now.duration_since(heard) > SILENT_FOR {
            return format!("nothing heard for {SILENT_FOR:?}");
        }
        if disconnected.is_some_and(|at| now.duration_since(at) > DISCONNECTED_FOR) {
            return "ICE disconnected".into();
        }
        // Wake for the next timeout, and at least once a second for the deadlines above.
        let wake = timeout.min(now + Duration::from_secs(1));
        tokio::select! {
            datagram = r.datagrams.recv() => {
                let Some(datagram) = datagram else {
                    return "the peer port closed".into();
                };
                heard = datagram.at;
                let Ok(contents) = datagram.bytes.as_slice().try_into() else {
                    continue;
                };
                let receive = Receive {
                    proto: Protocol::Udp,
                    source: datagram.source,
                    destination: r.service.destination_for(datagram.source),
                    contents,
                };
                if let Err(e) = r.rtc.handle_input(Input::Receive(datagram.at, receive)) {
                    return format!("str0m: {e}");
                }
            }
            message = r.outgoing.recv() => {
                let Some(message) = message else {
                    return "the viewer's socket closed".into();
                };
                take(r, &mut channels, &mut waiting, message);
                // Whatever else is ready goes into the same flight, before str0m is polled for its packets.
                while let Ok(message) = r.outgoing.try_recv() {
                    take(r, &mut channels, &mut waiting, message);
                }
            }
            () = tokio::time::sleep_until(tokio::time::Instant::from_std(wake)) => {
                if let Err(e) = r.rtc.handle_input(Input::Timeout(Instant::now())) {
                    return format!("str0m: {e}");
                }
            }
        }
    }
}

/// The track the pictures go on, as the peer opens: the offer's receive-only video section, when castd's pictures are
/// one H.264 stream and the viewer named an H.264 payload type in packetization mode 1 (the profile the stream is,
/// where it named one). None leaves the pictures on `media`.
fn open_track(
    rtc: &mut Rtc,
    video: Option<Mid>,
    pictures: &Pictures,
    feedback: &Feedback,
) -> Option<Track> {
    let mid = video.filter(|_| pictures.trackable)?;
    let writer = rtc.writer(mid)?;
    let h264: Vec<_> = writer
        .payload_params()
        .filter(|p| {
            let spec = p.spec();
            spec.codec == Codec::H264 && spec.format.packetization_mode == Some(1)
        })
        .map(|p| (p.pt(), p.spec().format.profile_level_id))
        .collect();
    let same_profile =
        |level: &Option<u32>| level.is_some_and(|l| pictures.profile == Some((l >> 16) as u8));
    let pt = h264
        .iter()
        .find(|(_, level)| same_profile(level))
        .or(h264.first())
        .map(|(pt, _)| *pt)?;
    rtc.bwe().set_bitrate(
        Bitrate::kbps(300),
        Bitrate::kbps(u64::from(pictures.max_kbps.max(1000))),
    );
    // Every resend the viewer asks for goes, however many: str0m's default drops all queued ones once what it resent
    // passes 15% of what it sent in the last second, which on a lossy link is exactly when pictures wait on them.
    if let Some(tx) = rtc.direct_api().stream_tx_by_mid(mid, None) {
        tx.set_rtx_cache(RTX_PACKETS, RTX_AGE, None);
    }

    log::info!("rtc: the pictures ride the video track ({mid}, payload type {pt})");
    let mut track = Track {
        mid,
        pt,
        broken: false,
        copies: Copies::new(),
    };
    if track.copies.forced == Some(true) {
        set_copies(rtc, &mut track, feedback, true);
    }
    Some(track)
}

/// Sends the track's packets twice from now on, or once, and leaves the copies their part of the estimate.
fn set_copies(rtc: &mut Rtc, track: &mut Track, feedback: &Feedback, on: bool) {
    if let Some(tx) = rtc.direct_api().stream_tx_by_mid(track.mid, None) {
        tx.set_proactive_rtx(on);
    }
    feedback.set_copies(on);
    log::info!(
        "rtc: the track's packets go out {} (round trip {:?}, loss {:.2}%)",
        if on { "twice" } else { "once" },
        track.copies.rtt(),
        track.copies.loss().unwrap_or(0.0) * 100.0,
    );
}

/// One picture onto the track: its RTP time is its capture time ([`Feedback::rtp_of`]), and it asks the viewer for no
/// playout delay. False when it could not be written.
fn write_frame(
    rtc: &mut Rtc,
    track: &Track,
    feedback: &Feedback,
    unit: Bytes,
    captured: Instant,
) -> bool {
    let ticks = u64::from(feedback.rtp_of(captured));
    let Some(writer) = rtc.writer(track.mid) else {
        return false;
    };
    let len = unit.len();
    let written = writer
        .playout_delay(MediaTime::ZERO, MediaTime::ZERO)
        .write(
            track.pt,
            captured,
            MediaTime::from_90khz(ticks),
            unit.to_vec(),
        );
    match written {
        Ok(()) => {
            feedback.written(len);
            true
        }
        Err(e) => {
            log::warn!(
                "rtc: a picture could not be written on the track ({e}); waiting for a keyframe"
            );
            false
        }
    }
}

/// Queues `message` behind what waits for `media`, or sends sound, a pointer or a picture on the track now or never,
/// then sends what fits. A trickled candidate goes to ICE, when it is full ICE.
fn take(
    r: &mut Running,
    channels: &mut Channels,
    waiting: &mut VecDeque<(bool, Vec<u8>)>,
    message: ToPeer,
) {
    let rtc = &mut r.rtc;
    match message {
        ToPeer::Candidate(line) => {
            if r.service.ice == Ice::Full {
                // Browsers send the line without SDP's `a=`; an empty one ends the trickle.
                let line = line.trim().trim_start_matches("a=");
                if !line.is_empty() {
                    match Candidate::from_sdp_string(line) {
                        Ok(candidate) => rtc.add_remote_candidate(candidate),
                        Err(e) => log::debug!("rtc: ignoring a candidate: {e}"),
                    }
                }
            }
            return;
        }
        ToPeer::Text(text) => waiting.push_back((false, text.into_bytes())),
        ToPeer::Video(bytes) => match media_chunks(&bytes) {
            Some(chunks) => waiting.extend(chunks.into_iter().map(|c| (true, c))),
            None => log::warn!(
                "rtc: a video message of {} bytes is past what castd cuts",
                bytes.len()
            ),
        },
        ToPeer::Frame {
            unit,
            captured,
            key,
        } => {
            if let Some(track) = channels.track.as_mut()
                && (key || !track.broken)
            {
                track.broken = !write_frame(rtc, track, &r.feedback, unit, captured);
                if track.broken {
                    let _ = r.events.send(PeerEvent::Keyframe);
                }
            }
            return;
        }
        ToPeer::Audio(bytes) => {
            if let Some(mut channel) = channels.audio.and_then(|id| rtc.channel(id)) {
                // A full buffer drops the packet: sound late is worth nothing, and Opus conceals one missing.
                let _ = channel.write(true, &bytes);
            }
            return;
        }
        ToPeer::Pointer(text) => match channels.pointer.and_then(|id| rtc.channel(id)) {
            Some(mut channel) => {
                // Only the newest position counts: one the buffer cannot take is replaced by the next.
                let _ = channel.write(false, text.as_bytes());
                return;
            }
            None => waiting.push_back((false, text.into_bytes())),
        },
    }
    flush(rtc, channels.media, waiting);
}

/// Sends what waits for `media`, in order, until SCTP's buffer is full; the rest goes when it drains.
fn flush(rtc: &mut Rtc, media: Option<ChannelId>, waiting: &mut VecDeque<(bool, Vec<u8>)>) {
    let Some(mut channel) = media.and_then(|id| rtc.channel(id)) else {
        return;
    };
    channel.set_buffered_amount_low_threshold(SEND_BUFFER / 2);
    while let Some((binary, bytes)) = waiting.front() {
        debug_assert!(*binary || bytes.len() <= RTC_MESSAGE_MAX);
        match channel.write(*binary, bytes) {
            Ok(true) => {
                waiting.pop_front();
            }
            Ok(false) => return,
            Err(e) => {
                log::warn!("rtc: writing on media: {e}");
                waiting.pop_front();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_waits_in_str0ms_pacer_counts_as_queued_with_the_bucket_empty() {
        let f = Feedback::default();
        f.set_estimate(3000);
        assert!(f.queue_ms() < 1.0);
        // Resends ahead of the pictures: the oldest unsent packet has waited 300 ms, though castd wrote nothing.
        f.set_unsent_since(Some(Instant::now() - Duration::from_millis(300)));
        assert!(f.queue_ms() >= 300.0, "{}", f.queue_ms());
        f.set_unsent_since(None);
        assert!(f.queue_ms() < 1.0);
        // What castd wrote past its share counts as before: 85% of 3000 kbit/s drains 318.75 bytes a millisecond.
        f.written(31_875);
        let ms = f.queue_ms();
        assert!((99.0..=100.0).contains(&ms), "{ms}");
    }

    #[test]
    fn copies_take_their_part_of_the_estimate() {
        let f = Feedback::default();
        f.set_estimate(3000);
        assert_eq!(f.media_kbps(), Some(3000.0));
        f.set_copies(true);
        assert!(f.copies());
        assert_eq!(f.media_kbps(), Some(1500.0));
        // The bucket drains at the pictures' share: 85% of 1500 kbit/s is 159.375 bytes a millisecond.
        f.written(15_900);
        let ms = f.queue_ms();
        assert!((99.0..=100.0).contains(&ms), "{ms}");
    }

    /// Feeds `copies` a stats sample every 500 ms from `at` (moved on past them): the decisions it took, by sample.
    fn feed(
        copies: &mut Copies,
        at: &mut Instant,
        samples: impl IntoIterator<Item = (f32, u64)>,
    ) -> Vec<(usize, bool)> {
        let mut decided = vec![];
        for (i, (loss, rtt_ms)) in samples.into_iter().enumerate() {
            *at += STATS_EVERY;
            let rtt = Some(Duration::from_millis(rtt_ms));
            if let Some(on) = copies.update(Some(loss), rtt, *at) {
                decided.push((i, on));
            }
        }
        decided
    }

    #[test]
    fn copies_go_on_where_the_round_trip_is_long_and_loss_steady() {
        let mut at = Instant::now();
        // 200 ms and 2%: on once there are enough samples to judge by, then left on.
        let mut copies = Copies::default();
        let decided = feed(&mut copies, &mut at, [(0.02, 200); 30]);
        assert_eq!(decided, [(COPIES_SAMPLES_MIN - 1, true)]);
        // 100 ms and 0.5%, as seconds of 400 packets see it, and a cap's fall: its burst does not count.
        let mut copies = Copies::default();
        let seconds = [
            0.005, 0.0025, 0.0075, 0.3, 0.55, 0.005, 0.0, 0.005, 0.0025, 0.01,
        ];
        let decided = feed(&mut copies, &mut at, seconds.map(|loss| (loss, 100)));
        assert_eq!(decided, [(COPIES_SAMPLES_MIN + 1, true)]);
    }

    #[test]
    fn copies_stay_off_on_a_short_round_trip_or_a_burst_of_loss() {
        let mut at = Instant::now();
        for rtt in [1, 20, 40, 79] {
            let mut copies = Copies::default();
            assert!(
                feed(&mut copies, &mut at, [(0.05, rtt); 30]).is_empty(),
                "{rtt} ms"
            );
        }
        // A link's cap falls at 200 ms: three samples (a second and a half) of heavy loss, none otherwise.
        let mut copies = Copies::default();
        let mut samples = vec![(0.0, 200); 30];
        samples[10..13].fill((0.3, 200));
        assert!(feed(&mut copies, &mut at, samples).is_empty());
        // The round trip is the shortest seen: a queue that lengthens it for a while does not count.
        let mut copies = Copies::default();
        let mut samples = vec![(0.02, 40); 30];
        samples[5..15].fill((0.02, 300));
        assert!(feed(&mut copies, &mut at, samples).is_empty());
    }

    #[test]
    fn copies_go_off_when_the_loss_stops_but_not_before_their_hold() {
        let mut at = Instant::now();
        let mut copies = Copies::default();
        assert_eq!(feed(&mut copies, &mut at, [(0.02, 200); 6]), [(5, true)]);
        // The loss stops at once: off when the window has forgotten it, and the copies have held 10 s.
        let decided = feed(&mut copies, &mut at, [(0.0, 200); 40]);
        assert_eq!(decided.len(), 1, "{decided:?}");
        let (i, on) = decided[0];
        assert!(!on);
        assert_eq!(STATS_EVERY * (i as u32 + 1), COPIES_HOLD);
        // A loss between the two thresholds changes nothing either way.
        let decided = feed(&mut copies, &mut at, [(0.0015, 200); 40]);
        assert!(decided.is_empty(), "{decided:?}");
    }

    #[test]
    fn forced_copies_hold_whatever_the_link() {
        let mut at = Instant::now();
        let mut copies = Copies {
            forced: Some(true),
            ..Copies::default()
        };
        assert!(feed(&mut copies, &mut at, [(0.05, 200); 30]).is_empty());
    }
}
