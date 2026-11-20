//! One viewer's media socket: `GET /system/browser-media/<session>?token=…` upgraded to a WebSocket that speaks
//! browser-wire's media protocol. JSON text both ways (`BrowserMediaClientMessage` in, `BrowserMediaServerMessage` out),
//! and binary video and audio out, each behind the 16-byte header (header.rs). A message castd cannot parse is ignored,
//! never an error: the socket and castd outlive any viewer's mistake.

use crate::desktop::ClipContent;
use crate::hub::{Client, Out, WantSize};
use crate::input::{InputEvent, Mods};
use crate::keys;
use crate::server::App;
use axum::extract::ws::{Message, WebSocket};
use browser_wire::{
    BrowserMediaClientMessage, BrowserMediaServerMessage, KeyAction, PointerAction,
};
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// How often castd pings a viewer for the round trip, and how often it sends `stats`.
const PING_EVERY: Duration = Duration::from_millis(500);
const STATS_EVERY: Duration = Duration::from_secs(1);

/// Where a viewer's stream goes: its socket, or the peer connection it opened beside it (src/rtc).
enum Carrier {
    Socket,
    Peer(crate::rtc::Peer),
}

/// What the socket's reader tells the writer about the peer.
enum CarrierChange {
    /// The peer's channels are open: the stream moves there.
    ToPeer(crate::rtc::Peer),
    /// The peer is gone, or was never taken: the stream is the socket's, with `rtcClosed` saying why.
    ToSocket(String),
}

/// How long a socket castd ends may take to send its close frame before its writer is stopped anyway.
const CLOSE_WITHIN: Duration = Duration::from_secs(1);

pub async fn serve(socket: WebSocket, app: App, claims: crate::token::Claims) {
    use futures_util::{SinkExt, StreamExt};
    let hub = app.hub.clone();
    let read_only = claims.ro;
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    let (carrier_tx, mut carrier_rx) = mpsc::unbounded_channel::<CarrierChange>();
    let client = hub.add_client(tx, read_only, false);
    client.token_exp.store(claims.exp, Ordering::Relaxed);
    log::info!(
        "viewer {} connected{}",
        client.id,
        if read_only { " (read-only)" } else { "" }
    );
    client.video.store(true, Ordering::Relaxed);
    client.send(Out::Hello(hub.hello(read_only)));
    if let Some(cursor) = hub.cursor.lock().clone() {
        client.send(Out::Text(cursor));
    }
    hub.wake();
    let writer = {
        let hub = hub.clone();
        let client = client.clone();
        tokio::spawn(async move {
            // This viewer's capture clock: header times count from its latest hello.
            let mut epoch = Instant::now();
            let mut carrier = Carrier::Socket;
            loop {
                let m = tokio::select! {
                    // A carrier change goes ahead of what is queued: the hello it sends is what the frames after it follow.
                    biased;
                    change = carrier_rx.recv() => {
                        let Some(change) = change else { break };
                        // A fresh hello on the carrier the stream now rides, ahead of anything queued, and a keyframe
                        // after it: the viewer believes pictures only from the carrier of the hello it heard last.
                        client.restart_video();
                        let hello = hub.hello(client.read_only);
                        epoch = Instant::now();
                        match change {
                            CarrierChange::ToPeer(peer) => {
                                log::info!("viewer {}: the stream moves onto its peer connection", client.id);
                                peer.send(crate::rtc::ToPeer::Text(hello));
                                carrier = Carrier::Peer(peer);
                            }
                            CarrierChange::ToSocket(reason) => {
                                log::info!("viewer {}: the stream is back on its socket ({reason})", client.id);
                                carrier = Carrier::Socket;
                                let closed = serde_json::to_string(&BrowserMediaServerMessage::RtcClosed { reason })
                                    .expect("rtcClosed serializes");
                                if sink.send(Message::Text(closed.into())).await.is_err()
                                    || sink.send(Message::Text(hello.into())).await.is_err()
                                {
                                    break;
                                }
                            }
                        }
                        hub.wake();
                        continue;
                    }
                    m = rx.recv() => match m { Some(m) => m, None => break },
                };
                if let Out::Hello(_) = &m {
                    epoch = Instant::now();
                }
                // castd ended the viewer: the close frame goes on the socket whichever way the stream rides, and
                // nothing after it (the peer goes with this writer).
                if let Out::Close(code, reason) = m {
                    let frame = axum::extract::ws::CloseFrame {
                        code,
                        reason: reason.into(),
                    };
                    let _ = sink.send(Message::Close(Some(frame))).await;
                    break;
                }
                // A peer that has ended drops what it is handed until its reader moves the stream back.
                if let Carrier::Peer(peer) = &carrier {
                    if !for_peer(m, epoch, peer, &mut sink).await {
                        break;
                    }
                    continue;
                }
                let msg = match m {
                    Out::Text(t) | Out::Hello(t) => Message::Text(t.into()),
                    Out::Media(media) => Message::Binary(media.bytes_since(epoch).into()),
                    Out::Ping(t) => Message::Ping(t.to_be_bytes().to_vec().into()),
                    // Sent above, before the carrier is asked.
                    Out::Close(..) => break,
                };
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
        })
    };
    let ticker = {
        let c = client.clone();
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut ping = tokio::time::interval(PING_EVERY);
            let mut last_stats = Instant::now();
            loop {
                ping.tick().await;
                // A viewer whose newest token expired long ago is cut off from the view socket that hands out fresh ones
                // (its access revoked, its tab gone): its socket ends.
                if hub.lapsed(&c, crate::token::now_ms()) {
                    c.end(
                        crate::hub::close_code("expired"),
                        "the token this socket holds expired long ago: dial again with a fresh one",
                    );
                }
                c.send(Out::Ping(hub.epoch.elapsed().as_micros() as u64));
                let since = last_stats.elapsed();
                if since >= STATS_EVERY {
                    last_stats = Instant::now();
                    let frames = c.frames.swap(0, Ordering::Relaxed);
                    let stats = BrowserMediaServerMessage::Stats {
                        rtt_ms: f64::from(c.min_rtt_ms.load(Ordering::Relaxed)),
                        target_kbps: hub.target_kbps.load(Ordering::Relaxed),
                        fps: f64::from(frames) / since.as_secs_f64(),
                        queue_ms: c.delay.lock().queue_ms.max(0.0),
                    };
                    if let Ok(t) = serde_json::to_string(&stats) {
                        c.send(Out::Text(t));
                    }
                }
            }
        })
    };
    let mut peer = PeerSide::default();
    let mut rtts = Rtts::default();
    loop {
        let msg = tokio::select! {
            msg = stream.next() => match msg { Some(Ok(msg)) => msg, _ => break },
            // castd ended it (`Client::end`): the daemon dropped its viewers, or its token lapsed.
            _ = client.ending.notified() => break,
            event = peer.next() => {
                peer.handle(event, &app, &client, &carrier_tx, &mut rtts);
                continue;
            }
        };
        match msg {
            Message::Text(t) => match serde_json::from_str::<BrowserMediaClientMessage>(t.as_str())
            {
                Ok(m) => {
                    if let Some(m) = peer.signal(m, &client, &carrier_tx) {
                        handle(&app, &client, m);
                    }
                }
                Err(e) => log::debug!(
                    "viewer {}: ignoring a message castd cannot read: {e}",
                    client.id
                ),
            },
            Message::Pong(p) => {
                // While the peer carries the stream its acks time the round trip (`Rtts::acked`); the socket's
                // pings would time the path the stream left.
                if let Ok(sent) = <[u8; 8]>::try_from(p.as_ref())
                    && !peer.carrying()
                {
                    let now = hub.epoch.elapsed().as_micros() as u64;
                    let rtt = (now.saturating_sub(u64::from_be_bytes(sent)) / 1000) as u32;
                    rtts.push(&client, rtt);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    ticker.abort();
    let mut writer = writer;
    if let Some((code, reason)) = client.ended() {
        log::info!("viewer {}: ending its socket ({code}: {reason})", client.id);
        client.send(Out::Close(code, reason));
        // The viewer answers the close frame with its own: read until it has (or the socket ends), so the closing
        // handshake completes and the viewer is sure to hear the code.
        let _ = tokio::time::timeout(CLOSE_WITHIN, async {
            while let Some(Ok(m)) = stream.next().await {
                if matches!(m, Message::Close(_)) {
                    break;
                }
            }
        })
        .await;
        let _ = tokio::time::timeout(CLOSE_WITHIN, &mut writer).await;
    }
    writer.abort();
    input(&app, InputEvent::ReleaseAll { client: client.id });
    hub.remove_client(client.id);
    log::info!("viewer {} disconnected", client.id);
}

/// The last 20 round trips, whose minimum is the viewer's.
#[derive(Default)]
struct Rtts(VecDeque<u32>);

impl Rtts {
    fn push(&mut self, client: &Client, rtt: u32) {
        self.0.push_back(rtt.max(1));
        if self.0.len() > 20 {
            self.0.pop_front();
        }
        if let Some(&min) = self.0.iter().min() {
            client.min_rtt_ms.store(min, Ordering::Relaxed);
        }
    }

    /// An ack that came back over the peer: how long its frame took out and back, less the viewer's decoding.
    fn acked(&mut self, client: &Client, id: u32, decode_ms: Option<f64>) {
        let sent = client
            .inflight
            .lock()
            .iter()
            .find(|f| f.id == id)
            .map(|f| f.sent.elapsed().as_secs_f64() * 1000.0);
        if let Some(ms) = sent {
            let decode = decode_ms
                .filter(|d| d.is_finite() && *d >= 0.0)
                .unwrap_or(0.0);
            self.push(client, (ms - decode).max(1.0) as u32);
        }
    }
}

/// Sends `m` over the peer, or on the socket what the peer does not carry: pings, which keep the socket alive, and a
/// JSON message longer than a DataChannel message (a copied image), which nothing orders against the pictures. False
/// once the socket is gone.
async fn for_peer<S>(m: Out, epoch: Instant, peer: &crate::rtc::Peer, sink: &mut S) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    use crate::rtc::ToPeer;
    use futures_util::SinkExt;
    let to_peer = match m {
        Out::Ping(t) => {
            return sink
                .send(Message::Ping(t.to_be_bytes().to_vec().into()))
                .await
                .is_ok();
        }
        Out::Text(t) if t.len() > browser_wire::RTC_MESSAGE_MAX => {
            return sink.send(Message::Text(t.into())).await.is_ok();
        }
        Out::Text(t) | Out::Hello(t) => ToPeer::Text(t),
        // The writer sends a close on the socket before it asks the carrier.
        Out::Close(..) => return false,
        Out::Media(media) => {
            let bytes = media.bytes_since(epoch);
            if media.header.kind == crate::header::KIND_AUDIO {
                ToPeer::Audio(bytes)
            } else {
                ToPeer::Video(bytes)
            }
        }
    };
    peer.send(to_peer);
    true
}

/// The socket's side of a viewer's peer: the offer it took, the peer until it opens, and whether the stream is on it.
#[derive(Default)]
struct PeerSide {
    events: Option<mpsc::UnboundedReceiver<crate::rtc::PeerEvent>>,
    pending: Option<crate::rtc::Peer>,
    carrying: bool,
}

impl PeerSide {
    fn carrying(&self) -> bool {
        self.carrying
    }

    /// The next thing the peer says; pending forever while there is no peer.
    async fn next(&mut self) -> crate::rtc::PeerEvent {
        if let Some(events) = self.events.as_mut() {
            return events
                .recv()
                .await
                .unwrap_or_else(|| crate::rtc::PeerEvent::Closed("the peer ended".into()));
        }
        std::future::pending().await
    }

    fn handle(
        &mut self,
        event: crate::rtc::PeerEvent,
        app: &App,
        client: &Arc<Client>,
        carrier: &mpsc::UnboundedSender<CarrierChange>,
        rtts: &mut Rtts,
    ) {
        use crate::rtc::PeerEvent;
        match event {
            PeerEvent::Open => {
                if let Some(peer) = self.pending.take() {
                    self.carrying = true;
                    let _ = carrier.send(CarrierChange::ToPeer(peer));
                }
            }
            PeerEvent::Input(text) => {
                match serde_json::from_str::<BrowserMediaClientMessage>(&text) {
                    // Signalling belongs on the socket; on the peer it is ignored.
                    Ok(
                        BrowserMediaClientMessage::RtcOffer { .. }
                        | BrowserMediaClientMessage::RtcCandidate { .. }
                        | BrowserMediaClientMessage::RtcClose,
                    ) => {}
                    Ok(m) => {
                        if let BrowserMediaClientMessage::Ack { id, decode_ms } = &m {
                            rtts.acked(client, *id, *decode_ms);
                        }
                        handle(app, client, m);
                    }
                    Err(e) => log::debug!(
                        "viewer {}: ignoring a peer message castd cannot read: {e}",
                        client.id
                    ),
                }
            }
            PeerEvent::Closed(reason) => {
                self.events = None;
                self.pending = None;
                // A stream on the peer comes back with a hello; an offer that never opened only hears why.
                if std::mem::take(&mut self.carrying) {
                    let _ = carrier.send(CarrierChange::ToSocket(reason));
                } else {
                    refuse(client, &reason);
                }
            }
        }
    }

    /// Takes the signalling messages (`rtcOffer`, `rtcCandidate`, `rtcClose`) and hands back every other one.
    fn signal(
        &mut self,
        m: BrowserMediaClientMessage,
        client: &Arc<Client>,
        carrier: &mpsc::UnboundedSender<CarrierChange>,
    ) -> Option<BrowserMediaClientMessage> {
        use BrowserMediaClientMessage as M;
        match m {
            M::RtcOffer { sdp } => {
                self.offer(&sdp, client, carrier);
                None
            }
            // castd is ICE-lite: it learns the viewer's address from its checks, and needs none of its candidates.
            M::RtcCandidate { .. } => None,
            M::RtcClose => {
                self.close(carrier, "the viewer closed its peer connection");
                None
            }
            m => Some(m),
        }
    }

    fn close(&mut self, carrier: &mpsc::UnboundedSender<CarrierChange>, reason: &str) {
        {
            self.events = None;
            self.pending = None;
        }
        // Only a stream that left the socket comes back with a hello; an offer never answered changes nothing.
        if std::mem::take(&mut self.carrying) {
            let _ = carrier.send(CarrierChange::ToSocket(reason.into()));
        }
    }
    fn offer(
        &mut self,
        sdp: &str,
        client: &Arc<Client>,
        carrier: &mpsc::UnboundedSender<CarrierChange>,
    ) {
        // A fresh offer replaces whatever peer there was: the viewer made a new connection.
        self.close(carrier, "the viewer offered another peer connection");
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        match crate::rtc::accept(sdp, events_tx) {
            Ok((answer, peer)) => {
                log::info!("viewer {}: answering its peer connection", client.id);
                self.events = Some(events_rx);
                self.pending = Some(peer);
                if let Ok(t) =
                    serde_json::to_string(&BrowserMediaServerMessage::RtcAnswer { sdp: answer })
                {
                    client.send(Out::Text(t));
                }
            }
            Err(reason) => refuse(client, &reason),
        }
    }
}

/// Tells the viewer its offer was not taken; the stream never left the socket.
fn refuse(client: &Client, reason: &str) {
    log::info!("viewer {}: no peer connection: {reason}", client.id);
    if let Ok(t) = serde_json::to_string(&BrowserMediaServerMessage::RtcClosed {
        reason: reason.into(),
    }) {
        client.send(Out::Text(t));
    }
}

/// A box castd will size the screen to: 1 to 16384 CSS pixels a side, 0.25 to 8 display pixels per CSS pixel.
pub fn sane_box(width: u32, height: u32, scale: f64) -> bool {
    (1..=16384).contains(&width)
        && (1..=16384).contains(&height)
        && scale.is_finite()
        && (0.25..=8.0).contains(&scale)
}

fn input(app: &App, ev: InputEvent) {
    if let Some(tx) = app.hub.input.lock().as_ref() {
        let _ = tx.send(ev);
    }
}

/// A point in picture pixels as a point on the screen: clamped to the picture, moved by the crop's origin. None for a
/// coordinate that is not a number.
fn to_screen(app: &App, x: f64, y: f64) -> Option<(i32, i32)> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let w = app.hub.width.load(Ordering::Relaxed).max(1) as f64;
    let h = app.hub.height.load(Ordering::Relaxed).max(1) as f64;
    let (ox, oy) = app
        .hub
        .crop
        .lock()
        .map_or((0, 0), |c| (c.x as i32, c.y as i32));
    Some((
        x.round().clamp(0.0, w - 1.0) as i32 + ox,
        y.round().clamp(0.0, h - 1.0) as i32 + oy,
    ))
}

/// Acts on one message from a viewer.
pub fn handle(app: &App, c: &Arc<Client>, m: BrowserMediaClientMessage) {
    use BrowserMediaClientMessage as M;
    let hub = &app.hub;
    // Watching needs only these; everything else acts on the window, which a read-only viewer may not.
    let watching = matches!(
        m,
        M::Ack { .. }
            | M::Keyframe
            | M::Pause
            | M::Resume
            | M::Audio { .. }
            | M::Ping { .. }
            | M::RtcOffer { .. }
            | M::RtcCandidate { .. }
            | M::RtcClose
            | M::Token { .. }
    );
    if c.read_only && !watching {
        return;
    }
    match m {
        M::Mouse {
            action,
            x,
            y,
            button,
            buttons,
            ctrl,
            shift,
            alt,
            ..
        } => {
            if action == PointerAction::Wheel {
                return;
            }
            let Some((x, y)) = to_screen(app, x, y) else {
                return;
            };
            hub.note_input(c);
            input(
                app,
                InputEvent::Mouse {
                    client: c.id,
                    action,
                    x,
                    y,
                    button,
                    buttons,
                    mods: Mods { ctrl, shift, alt },
                },
            );
        }
        M::Scroll { x, y, dx, dy } => {
            let Some((x, y)) = to_screen(app, x, y) else {
                return;
            };
            hub.note_input(c);
            input(app, InputEvent::Scroll { x, y, dx, dy });
        }
        M::Key {
            key,
            code,
            action,
            ctrl,
            shift,
            alt,
        } => {
            let keysyms = keys::key_keysyms(&key, code.as_deref());
            if keysyms.is_empty() {
                return;
            }
            hub.note_input(c);
            let altgr = keys::is_altgr_character(&key, ctrl == Some(true), alt == Some(true));
            input(
                app,
                InputEvent::Key {
                    client: c.id,
                    keysyms,
                    id: code.filter(|c| !c.is_empty()).unwrap_or(key),
                    action: action.unwrap_or(KeyAction::Press),
                    mods: Mods { ctrl, shift, alt },
                    altgr,
                },
            );
        }
        M::Text { text } => {
            if text.is_empty() {
                return;
            }
            hub.note_input(c);
            input(app, InputEvent::Text { text });
        }
        M::Clipboard { content } => {
            hub.note_input(c);
            input(app, InputEvent::Clipboard(ClipContent::from_wire(content)));
        }
        M::ReleaseAll => input(app, InputEvent::ReleaseAll { client: c.id }),
        M::Ack { id, decode_ms } => {
            if let Some(ms) = decode_ms.filter(|ms| ms.is_finite() && *ms >= 0.0) {
                c.decode_us
                    .store((ms * 1000.0).min(u32::MAX as f64) as u32, Ordering::Relaxed);
            }
            c.on_ack(id);
            hub.wake();
        }
        M::Keyframe => {
            c.started.store(false, Ordering::Relaxed);
            c.needs_keyframe.store(true, Ordering::Relaxed);
            hub.wake();
        }
        M::Resize {
            width,
            height,
            scale,
        } => {
            if sane_box(width, height, scale) {
                hub.on_resize(
                    c,
                    WantSize {
                        width,
                        height,
                        scale,
                    },
                );
            }
        }
        M::Pause => {
            c.video.store(false, Ordering::Relaxed);
            c.inflight.lock().clear();
            hub.wake();
        }
        M::Resume => {
            c.restart_video();
            c.video.store(true, Ordering::Relaxed);
            hub.wake();
        }
        M::Audio { on } => c.audio.store(on && hub.audio.is_some(), Ordering::Relaxed),
        M::Ping { t } => {
            if let Ok(pong) = serde_json::to_string(&BrowserMediaServerMessage::Pong { t }) {
                c.send(Out::Text(pong));
            }
        }
        // Signalling is the socket's (`PeerSide::signal`), never an action on the window.
        M::RtcOffer { .. } | M::RtcCandidate { .. } | M::RtcClose => {}
        M::Token { token } => refresh(app, c, &token),
    }
}

/// Takes a fresh token the viewer sent on its open socket: when it holds as at the upgrade (castd's key, this session,
/// not expired, minted after the last drop) and opens the access the socket has, the socket's lifetime counts from its
/// expiry. Anything else changes nothing: a token for other access is the viewer's to dial again with.
fn refresh(app: &App, c: &Client, token: &str) {
    match crate::token::verify(&app.key, &app.session, token, crate::token::now_ms()) {
        Ok(claims) if claims.ro != c.read_only => log::info!(
            "viewer {}: a fresh token for {} access refreshes nothing on a {} socket",
            c.id,
            if claims.ro { "read-only" } else { "read-write" },
            if c.read_only {
                "read-only"
            } else {
                "read-write"
            }
        ),
        Ok(claims) if !app.hub.token_allowed(&claims) => {
            log::info!(
                "viewer {}: a fresh token minted before the last drop refreshes nothing",
                c.id
            )
        }
        Ok(claims) => {
            c.token_exp.fetch_max(claims.exp, Ordering::Relaxed);
        }
        Err(refused) => log::info!(
            "viewer {}: a fresh token refused: {}",
            c.id,
            refused.words()
        ),
    }
}
