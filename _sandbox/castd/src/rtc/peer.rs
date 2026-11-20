//! One viewer's peer connection: str0m driven by castd's runtime, fed the datagrams the shared port routed to it, the
//! viewer's channels mapped to the media socket's traffic (browser-wire's `RTC_CHANNELS`).

use super::chunk::{TextJoiner, media_chunks};
use super::{Datagram, Service};
use browser_wire::RTC_MESSAGE_MAX;
use std::collections::VecDeque;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use str0m::change::SdpOffer;
use str0m::channel::{ChannelData, ChannelId};
use str0m::crypto::CryptoProvider;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, Rtc};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// What the viewer's writer hands its peer once the peer carries the stream.
pub enum ToPeer {
    /// A JSON message, on `media` in order with the pictures.
    Text(String),
    /// A video message (header and payload), on `media`, cut into chunks when it is longer than a message may be.
    Video(Vec<u8>),
    /// An Opus packet on `audio`, dropped rather than queued when the channel is full.
    Audio(Vec<u8>),
}

/// What a peer tells the viewer's socket.
pub enum PeerEvent {
    /// `media` and `input` are open: the stream may move onto them.
    Open,
    /// A JSON message the viewer sent on `input`.
    Input(String),
    /// The peer is gone, in words for the log; the stream belongs on the socket.
    Closed(String),
}

/// A peer connection's handle: dropping it ends the peer and frees its ufrag on the port.
pub struct Peer {
    tx: mpsc::UnboundedSender<ToPeer>,
    task: JoinHandle<()>,
}

impl Peer {
    /// Hands the peer something to send; false once the peer has ended.
    pub fn send(&self, message: ToPeer) -> bool {
        self.tx.send(message).is_ok()
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

fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    PROVIDER
        .get_or_init(|| Arc::new(str0m::crypto::from_feature_flags()))
        .clone()
}

/// Takes the viewer's offer: the answer to send it (castd's candidates are in it), and the peer, whose events arrive
/// on `events`. Refused with words when castd serves no peer port or the offer is not one it can answer.
pub fn accept(
    offer: &str,
    events: mpsc::UnboundedSender<PeerEvent>,
) -> Result<(String, Peer), String> {
    let service = Service::get().ok_or("castd takes no peer connections (no --rtc-udp)")?;
    if service.candidates.is_empty() {
        return Err("castd's peer port is published nowhere a viewer can reach".into());
    }
    let offer = SdpOffer::from_sdp_string(offer).map_err(|e| format!("not an SDP offer: {e}"))?;
    let creds = IceCreds::new();
    let ufrag = creds.ufrag.clone();
    let mut rtc = Rtc::builder()
        .set_ice_lite(true)
        .set_local_ice_credentials(creds)
        .set_crypto_provider(provider())
        .set_sctp_max_buffered_amount(SEND_BUFFER)
        .set_sctp_max_message_size(RECEIVE_MAX)
        .build(Instant::now());
    for address in &service.candidates {
        let candidate =
            Candidate::host(*address, "udp").map_err(|e| format!("candidate {address}: {e}"))?;
        rtc.add_local_candidate(candidate);
    }
    let answer = rtc
        .sdp_api()
        .accept_offer(offer)
        .map_err(|e| format!("the offer cannot be answered: {e}"))?;
    let datagrams = service.register(&ufrag);
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(Running {
        rtc,
        service,
        ufrag,
        datagrams,
        outgoing: rx,
        events,
    }));
    Ok((answer.to_sdp_string(), Peer { tx, task }))
}

struct Running {
    rtc: Rtc,
    service: Arc<Service>,
    ufrag: String,
    datagrams: mpsc::Receiver<Datagram>,
    outgoing: mpsc::UnboundedReceiver<ToPeer>,
    events: mpsc::UnboundedSender<PeerEvent>,
}

/// The viewer's channels as they open, by the label each was opened with.
#[derive(Default)]
struct Channels {
    media: Option<ChannelId>,
    audio: Option<ChannelId>,
    input: Option<ChannelId>,
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
        let timeout = loop {
            match r.rtc.poll_output() {
                Ok(Output::Timeout(at)) => break at,
                Ok(Output::Transmit(t)) => {
                    let _ = r.service.socket.send_to(&t.contents, t.destination).await;
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
                    Event::ChannelOpen(id, label) => {
                        match label.as_str() {
                            "media" => channels.media = Some(id),
                            "audio" => channels.audio = Some(id),
                            "input" => channels.input = Some(id),
                            other => log::debug!("rtc: ignoring a channel named {other:?}"),
                        }
                        if !open && channels.media.is_some() && channels.input.is_some() {
                            open = true;
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
                    }
                    Event::ChannelBufferedAmountLow(id) if Some(id) == channels.media => {
                        flush(&mut r.rtc, channels.media, &mut waiting);
                    }
                    _ => {}
                },
                Err(e) => return format!("str0m: {e}"),
            }
        };
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
                take(&mut r.rtc, &channels, &mut waiting, message);
                // Whatever else is ready goes into the same flight, before str0m is polled for its packets.
                while let Ok(message) = r.outgoing.try_recv() {
                    take(&mut r.rtc, &channels, &mut waiting, message);
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

/// Queues `message` behind what waits for `media`, or sends sound now or never, then sends what fits.
fn take(
    rtc: &mut Rtc,
    channels: &Channels,
    waiting: &mut VecDeque<(bool, Vec<u8>)>,
    message: ToPeer,
) {
    match message {
        ToPeer::Text(text) => waiting.push_back((false, text.into_bytes())),
        ToPeer::Video(bytes) => match media_chunks(&bytes) {
            Some(chunks) => waiting.extend(chunks.into_iter().map(|c| (true, c))),
            None => log::warn!(
                "rtc: a video message of {} bytes is past what castd cuts",
                bytes.len()
            ),
        },
        ToPeer::Audio(bytes) => {
            if let Some(mut channel) = channels.audio.and_then(|id| rtc.channel(id)) {
                // A full buffer drops the packet: sound late is worth nothing, and Opus conceals one missing.
                let _ = channel.write(true, &bytes);
            }
            return;
        }
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
