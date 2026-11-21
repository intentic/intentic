//! The pictures on a video track: a viewer whose offer carries a receive-only video section gets them as RTP there,
//! castd's own (ICE-lite) port, str0m on both ends, over loopback UDP. And the ways it does not: castd not asked to
//! (an older castd's answer leaves the section silent), and an offer with no section (an older viewer). The `pointer`
//! channel carries `pointer`.

use cast_core::rtc::viewer::{Arrived, RtcViewer};
use cast_core::rtc::{PeerEvent, Pictures, ToPeer};
use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

const PICTURES: Pictures = Pictures {
    trackable: true,
    profile: Some(0x42),
    start_kbps: 2000,
    max_kbps: 30_000,
};

/// An H.264 access unit as castd's encoders write one, Annex B: an SPS (Constrained Baseline), a PPS and an IDR slice
/// whose body is `fill`.
fn idr(fill: u8) -> Vec<u8> {
    let mut au = vec![
        0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x40, 0x16, 0xec, 0x04, 0x40,
    ];
    au.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80]);
    au.extend_from_slice(&[0, 0, 0, 1, 0x65, 0x88, 0x84]);
    au.extend(std::iter::repeat_n(fill, 3000));
    au
}

/// Drives both ends until castd's peer says something.
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
        viewer
            .pump(Instant::now() + Duration::from_millis(20))
            .await;
    }
}

/// A viewer offering (or not) a video section, castd answering with `pictures`, until the peer opens.
async fn connect(
    track: bool,
    pictures: Pictures,
) -> (
    RtcViewer,
    cast_core::rtc::Peer,
    mpsc::UnboundedReceiver<PeerEvent>,
) {
    let (mut viewer, offer) = RtcViewer::offer_with(LOOPBACK, track).await.unwrap();
    assert_eq!(offer.contains("m=video"), track, "{offer}");
    let (events_tx, mut events) = mpsc::unbounded_channel();
    let (answer, peer) =
        cast_core::rtc::accept_with(&offer, events_tx, pictures).expect("castd answers");
    viewer.answer(&answer).unwrap();
    assert!(matches!(
        next_event(&mut events, &mut viewer).await,
        PeerEvent::Open
    ));
    (viewer, peer, events)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pictures_ride_the_track_only_where_both_ends_say_so() {
    cast_core::rtc::start(
        "127.0.0.1:0".parse().unwrap(),
        vec!["127.0.0.1:0".parse().unwrap()],
    )
    .await
    .expect("the peer port");

    // Both ask: the access unit castd hands the peer arrives on the track whole, its RTP time the capture's.
    let (mut viewer, peer, _events) = connect(true, PICTURES).await;
    let track = peer.track().expect("the pictures ride the track");
    let start = Instant::now();
    assert!(peer.send(ToPeer::Frame {
        unit: idr(7).into(),
        captured: start,
        key: true,
    }));
    assert!(peer.send(ToPeer::Frame {
        unit: idr(9).into(),
        captured: start + Duration::from_millis(100),
        key: true,
    }));
    assert!(peer.send(ToPeer::Pointer(r#"{"type":"pointer","x":3,"y":4}"#.into())));
    let mut pictures = Vec::new();
    let mut pointers = Vec::new();
    let until = Instant::now() + Duration::from_secs(10);
    while (pictures.len() < 2 || pointers.is_empty()) && Instant::now() < until {
        match viewer.recv(Duration::from_millis(200)).await {
            Some(Arrived::Picture(data, ticks)) => pictures.push((data, ticks)),
            Some(Arrived::Pointer(text)) => pointers.push(text),
            _ => {}
        }
    }
    assert_eq!(pictures.len(), 2, "both pictures on the track");
    for ((data, _), fill) in pictures.iter().zip([7u8, 9]) {
        assert!(
            data.windows(4).any(|w| w == [0x65, 0x88, 0x84, fill]),
            "the IDR's body arrived"
        );
        assert_eq!(data.iter().filter(|&&b| b == fill).count(), 3000);
    }
    // 100 ms apart on the 90 kHz clock, as they were captured.
    assert_eq!(pictures[1].1 - pictures[0].1, 9000);
    assert_eq!(track.rtp_of(start + Duration::from_millis(100)), 9000);
    assert_eq!(pointers, [r#"{"type":"pointer","x":3,"y":4}"#]);
    drop(peer);

    // castd not asked to carry them there (an older castd answers the same way): the section stays silent.
    let (_viewer, peer, _events) = connect(true, Pictures::default()).await;
    assert!(peer.track().is_none());
    drop(peer);

    // An offer with no video section (an older viewer): the pictures stay on `media`, whatever castd could do.
    let (_viewer, peer, _events) = connect(false, PICTURES).await;
    assert!(peer.track().is_none());
}
