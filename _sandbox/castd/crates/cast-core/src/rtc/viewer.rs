//! The viewer's side of a media peer, in Rust: what the editor's `mediaRtc.ts` does, for the tests and the bench. It
//! offers the three channels with browser-wire's reliability, runs full ICE as the controlling agent from a UDP socket
//! of its own, joins castd's chunked video, and chunks its own long JSON the way castd expects.

use browser_wire::{MEDIA_HEADER_LEN, RTC_CHANNELS, RTC_MESSAGE_MAX};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::channel::{ChannelConfig, ChannelData, ChannelId, Reliability};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;

/// What arrived on the peer.
#[derive(Debug)]
pub enum Arrived {
    /// A JSON message on `media`.
    Text(String),
    /// A video message on `media`, whole again, or an audio message on `audio`, with when its last part arrived.
    Media(Vec<u8>, Instant),
}

pub struct RtcViewer {
    rtc: Rtc,
    socket: UdpSocket,
    local: SocketAddr,
    pending: Option<SdpPendingOffer>,
    labels: HashMap<ChannelId, &'static str>,
    open: Vec<&'static str>,
    inbox: VecDeque<Arrived>,
    // A chunked video message being joined: its header and the payload so far, the next index and the count.
    joining: Option<(Vec<u8>, u8, u8)>,
    pub ice: IceConnectionState,
    /// ICE checks the other side sent this viewer: none from an ICE-lite castd, some from a full agent.
    pub checks_heard: usize,
}

impl RtcViewer {
    /// A viewer on a fresh UDP socket on `ip`, and the SDP offer to send castd.
    pub async fn offer(ip: IpAddr) -> Result<(RtcViewer, String), String> {
        let socket = UdpSocket::bind(SocketAddr::new(ip, 0))
            .await
            .map_err(|e| format!("bind: {e}"))?;
        let local = socket.local_addr().map_err(|e| e.to_string())?;
        let mut rtc = Rtc::builder()
            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
            .build(Instant::now());
        rtc.add_local_candidate(Candidate::host(local, "udp").map_err(|e| e.to_string())?);
        let mut api = rtc.sdp_api();
        let mut labels = HashMap::new();
        for (label, ordered, retransmits) in RTC_CHANNELS {
            let id = api.add_channel_with_config(ChannelConfig {
                label: label.into(),
                ordered,
                reliability: retransmits.map_or(Reliability::Reliable, |retransmits| {
                    Reliability::MaxRetransmits { retransmits }
                }),
                ..ChannelConfig::default()
            });
            labels.insert(id, label);
        }
        let (offer, pending) = api.apply().ok_or("no offer to make")?;
        Ok((
            RtcViewer {
                rtc,
                socket,
                local,
                pending: Some(pending),
                labels,
                open: Vec::new(),
                inbox: VecDeque::new(),
                joining: None,
                ice: IceConnectionState::New,
                checks_heard: 0,
            },
            offer.to_sdp_string(),
        ))
    }

    pub fn answer(&mut self, sdp: &str) -> Result<(), String> {
        let answer = SdpAnswer::from_sdp_string(sdp).map_err(|e| e.to_string())?;
        let pending = self.pending.take().ok_or("answered twice")?;
        self.rtc
            .sdp_api()
            .accept_answer(pending, answer)
            .map_err(|e| e.to_string())
    }

    /// Whether the channel named `label` is open.
    pub fn is_open(&self, label: &str) -> bool {
        self.open.contains(&label)
    }

    /// Sends a JSON message on `input`, as binary chunks when it is longer than one message may be. False when the
    /// channel is not open or its buffer is full.
    pub fn send(&mut self, text: &str) -> bool {
        let Some(id) = self.id_of("input") else {
            return false;
        };
        let Some(mut channel) = self.rtc.channel(id) else {
            return false;
        };
        if text.len() <= RTC_MESSAGE_MAX {
            return channel.write(false, text.as_bytes()).unwrap_or(false);
        }
        let parts: Vec<&[u8]> = text.as_bytes().chunks(RTC_MESSAGE_MAX - 2).collect();
        let Ok(count) = u8::try_from(parts.len()) else {
            return false;
        };
        parts.iter().enumerate().all(|(index, part)| {
            let mut chunk = vec![index as u8, count];
            chunk.extend_from_slice(part);
            channel.write(true, &chunk).unwrap_or(false)
        })
    }

    fn id_of(&self, label: &str) -> Option<ChannelId> {
        self.labels
            .iter()
            .find(|(_, l)| **l == label)
            .map(|(id, _)| *id)
            .filter(|_| self.is_open(label))
    }

    /// The next thing that arrived, driving the connection for up to `within`.
    pub async fn recv(&mut self, within: Duration) -> Option<Arrived> {
        let until = Instant::now() + within;
        loop {
            if let Some(arrived) = self.inbox.pop_front() {
                return Some(arrived);
            }
            if !self.pump(until).await {
                return self.inbox.pop_front();
            }
        }
    }

    /// Drives the connection until `until`, or until something arrives; false once `until` passed.
    pub async fn pump(&mut self, until: Instant) -> bool {
        let mut buf = vec![0u8; 2048];
        loop {
            let timeout = loop {
                match self.rtc.poll_output() {
                    Ok(Output::Timeout(at)) => break at,
                    Ok(Output::Transmit(t)) => {
                        let _ = self.socket.send_to(&t.contents, t.destination).await;
                    }
                    Ok(Output::Event(event)) => self.event(event),
                    Err(_) => return false,
                }
            };
            if !self.inbox.is_empty() {
                return true;
            }
            let now = Instant::now();
            if now >= until {
                return false;
            }
            let wake = timeout.min(until);
            tokio::select! {
                read = self.socket.recv_from(&mut buf) => {
                    let Ok((n, source)) = read else { continue };
                    if super::stun::binding_request_id(&buf[..n]).is_some() {
                        self.checks_heard += 1;
                    }
                    let Ok(contents) = buf[..n].try_into() else { continue };
                    let _ = self.rtc.handle_input(Input::Receive(
                        Instant::now(),
                        Receive { proto: Protocol::Udp, source, destination: self.local, contents },
                    ));
                }
                () = tokio::time::sleep_until(tokio::time::Instant::from_std(wake)) => {
                    let _ = self.rtc.handle_input(Input::Timeout(Instant::now()));
                }
            }
        }
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::IceConnectionStateChange(state) => self.ice = state,
            Event::ChannelOpen(id, _) => {
                if let Some(label) = self.labels.get(&id) {
                    self.open.push(label);
                }
            }
            Event::ChannelClose(id) => {
                let label = self.labels.get(&id).copied();
                self.open.retain(|l| Some(*l) != label);
            }
            Event::ChannelData(ChannelData { id, binary, data }) => {
                match (self.labels.get(&id).copied(), binary) {
                    (Some("media"), false) => {
                        if let Ok(text) = String::from_utf8(data) {
                            self.inbox.push_back(Arrived::Text(text));
                        }
                    }
                    (Some("media"), true) => self.join(data),
                    (Some("audio"), true) => {
                        self.inbox.push_back(Arrived::Media(data, Instant::now()))
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// One video message, or one chunk of it: whole messages go straight out, chunks once the last is in.
    fn join(&mut self, data: Vec<u8>) {
        if data.len() < MEDIA_HEADER_LEN {
            return;
        }
        let (index, count) = (data[14], data[15]);
        if count <= 1 {
            self.inbox.push_back(Arrived::Media(data, Instant::now()));
            return;
        }
        let joining = match self.joining.take() {
            Some(j) if index == j.1 && count == j.2 && j.0[2..6] == data[2..6] => Some(j),
            // A first chunk starts afresh; anything else out of turn is dropped with what was gathered.
            _ if index == 0 => {
                let mut header = data[..MEDIA_HEADER_LEN].to_vec();
                header[14] = 0;
                header[15] = 0;
                Some((header, 0, count))
            }
            _ => None,
        };
        let Some((mut whole, _, count)) = joining else {
            return;
        };
        whole.extend_from_slice(&data[MEDIA_HEADER_LEN..]);
        if index + 1 == count {
            self.inbox.push_back(Arrived::Media(whole, Instant::now()));
        } else {
            self.joining = Some((whole, index + 1, count));
        }
    }
}
