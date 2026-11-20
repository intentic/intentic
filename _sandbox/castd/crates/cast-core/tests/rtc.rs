//! A viewer's peer connection to castd's peer port, with str0m on both ends and nothing else of castd: ICE (castd
//! ICE-lite, the viewer controlling), DTLS and SCTP over loopback UDP, the three channels opened with browser-wire's
//! reliability, castd's video cut into chunks and joined back, sound, and the viewer's long JSON chunked the other way.

use browser_wire::{MEDIA_HEADER_LEN, RTC_MESSAGE_MAX};
use cast_core::rtc::viewer::{Arrived, RtcViewer};
use cast_core::rtc::{PeerEvent, ToPeer};
use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// A video message: castd's header (kind video, the key flag, frame `id`) and `len` bytes of payload.
fn video(id: u32, len: usize) -> Vec<u8> {
    let mut m = vec![0u8; MEDIA_HEADER_LEN];
    m[0] = 1;
    m[1] = 1;
    m[2..6].copy_from_slice(&id.to_be_bytes());
    m.extend((0..len).map(|i| (i * 7 % 256) as u8));
    m
}

async fn next_event(
    events: &mut mpsc::UnboundedReceiver<PeerEvent>,
    viewer: &mut RtcViewer,
) -> PeerEvent {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(event) = events.try_recv() {
            return event;
        }
        assert!(
            Instant::now() < until,
            "castd's peer said nothing within 10 s"
        );
        // The viewer's own loop has to run for castd's to hear anything.
        viewer
            .pump(Instant::now() + Duration::from_millis(20))
            .await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_viewer_opens_the_three_channels_and_the_stream_crosses_both_ways() {
    let candidates = cast_core::rtc::start(
        "127.0.0.1:0".parse().unwrap(),
        vec!["127.0.0.1:0".parse().unwrap()],
    )
    .await
    .expect("the peer port");
    assert!(cast_core::rtc::offered());
    // Port 0 named the port bound, whatever it turned out to be.
    let [bound] = candidates[..] else {
        panic!("one candidate, not {candidates:?}")
    };
    assert_ne!(bound.port(), 0);

    let (mut viewer, offer) = RtcViewer::offer(LOOPBACK).await.unwrap();
    let (events_tx, mut events) = mpsc::unbounded_channel();
    let (answer, peer) = cast_core::rtc::accept(&offer, events_tx).expect("castd answers");
    // ICE-lite: castd's one host candidate, on the port it bound, is in the answer; nothing trickles.
    assert!(answer.contains("a=ice-lite"), "{answer}");
    assert!(
        answer.contains(&format!("127.0.0.1 {} typ host", bound.port())),
        "{answer}"
    );
    viewer.answer(&answer).unwrap();

    assert!(matches!(
        next_event(&mut events, &mut viewer).await,
        PeerEvent::Open
    ));
    let until = Instant::now() + Duration::from_secs(5);
    while !(viewer.is_open("media") && viewer.is_open("input") && viewer.is_open("audio")) {
        assert!(
            viewer.pump(until).await || Instant::now() < until,
            "the viewer's channels did not open"
        );
    }

    // castd to viewer: a hello, a keyframe five chunks long, a delta that fits whole, and a sound packet, in order on
    // `media` apart from the sound.
    let key = video(1, 4 * (RTC_MESSAGE_MAX - MEDIA_HEADER_LEN) + 99);
    let delta = video(2, 300);
    assert!(peer.send(ToPeer::Text(r#"{"type":"hello"}"#.into())));
    assert!(peer.send(ToPeer::Video(key.clone())));
    assert!(peer.send(ToPeer::Video(delta.clone())));
    assert!(peer.send(ToPeer::Audio(vec![
        2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xfc
    ])));
    let mut media = Vec::new();
    let mut sound = 0;
    while media.len() < 3 || sound < 1 {
        match viewer
            .recv(Duration::from_secs(5))
            .await
            .expect("castd's stream on the peer")
        {
            Arrived::Text(text) => media.push(text.into_bytes()),
            Arrived::Media(bytes, _) if bytes[0] == 2 => sound += 1,
            Arrived::Media(bytes, _) => media.push(bytes),
        }
    }
    assert_eq!(media, [br#"{"type":"hello"}"#.to_vec(), key, delta]);
    // ICE-lite answers checks and sends none of its own.
    assert_eq!(viewer.checks_heard, 0, "an ICE-lite castd sent checks");

    // Viewer to castd: an ack, then a paste longer than a message may be, which arrives whole.
    assert!(viewer.send(r#"{"type":"ack","id":1}"#));
    let paste = format!(
        r#"{{"type":"text","text":"{}"}}"#,
        "ą".repeat(RTC_MESSAGE_MAX)
    );
    assert!(viewer.send(&paste));
    let mut inputs = Vec::new();
    while inputs.len() < 2 {
        match next_event(&mut events, &mut viewer).await {
            PeerEvent::Input(text) => inputs.push(text),
            PeerEvent::Open => {}
            PeerEvent::Closed(why) => panic!("the peer closed: {why}"),
        }
    }
    assert_eq!(inputs, [r#"{"type":"ack","id":1}"#.to_string(), paste]);

    // Dropping castd's side ends it: the viewer's channels close or its ICE stops hearing castd.
    drop(peer);
    assert!(!matches!(events.try_recv(), Ok(PeerEvent::Open)));
}

#[tokio::test]
async fn an_offer_that_is_no_sdp_is_refused_with_words() {
    let (tx, _rx) = mpsc::unbounded_channel();
    // Whether or not the other test bound the port first, this offer is refused before anything is bound to it.
    let refused = cast_core::rtc::accept("not sdp", tx);
    assert!(refused.is_err());
}
