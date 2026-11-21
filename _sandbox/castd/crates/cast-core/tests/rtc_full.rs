//! The peer port as a full ICE agent, as a device daemon behind a NAT runs it: it asks a STUN server (a fake one on
//! loopback that answers as a NAT would, with an address outside) for its server-reflexive address, answers with that
//! candidate beside its host one and no `ice-lite`, sends checks of its own, takes a trickled candidate, and the
//! viewer's channels open. A binary of its own: the port is one per process.

use browser_wire::RTC_MESSAGE_MAX;
use cast_core::rtc::viewer::{Arrived, RtcViewer};
use cast_core::rtc::{Ice, PeerEvent, RtcConfig, ToPeer, stun};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
/// Where the fake NAT says the port is reached from outside (TEST-NET-3: nothing answers there).
const OUTSIDE: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);

/// A STUN server on loopback that answers every binding request with OUTSIDE at the asker's port.
async fn fake_stun() -> SocketAddr {
    let socket = UdpSocket::bind(SocketAddr::new(LOOPBACK, 0)).await.unwrap();
    let addr = socket.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 1500];
        while let Ok((n, from)) = socket.recv_from(&mut buf).await {
            if let Some(id) = stun::binding_request_id(&buf[..n]) {
                let mapped = SocketAddr::new(IpAddr::V4(OUTSIDE), from.port());
                let _ = socket
                    .send_to(&stun::binding_success_for(id, mapped), from)
                    .await;
            }
        }
    });
    addr
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_ice_port_learns_its_outside_address_and_a_viewer_connects() {
    let stun_server = fake_stun().await;
    // No host candidate named: the port's own address (bound to loopback) becomes the one the reflexive is based on.
    let gathered = cast_core::rtc::start_with(RtcConfig {
        bind: SocketAddr::new(LOOPBACK, 0),
        candidates: Vec::new(),
        ice: Ice::Full,
        stun: vec![stun_server],
    })
    .await
    .expect("the peer port");
    let [host] = gathered.host[..] else {
        panic!("one host candidate, not {:?}", gathered.host)
    };
    assert_eq!(host.ip(), LOOPBACK);
    assert_eq!(
        gathered.reflexive,
        [SocketAddr::new(IpAddr::V4(OUTSIDE), host.port())]
    );
    assert!(cast_core::rtc::offered());

    let (mut viewer, offer) = RtcViewer::offer(LOOPBACK).await.unwrap();
    let (events_tx, mut events) = mpsc::unbounded_channel();
    let (answer, peer) = cast_core::rtc::accept(&offer, events_tx).expect("an answer");
    assert!(!answer.contains("a=ice-lite"), "{answer}");
    assert!(
        answer.contains(&format!("127.0.0.1 {} typ host", host.port())),
        "{answer}"
    );
    assert!(
        answer.contains(&format!("{OUTSIDE} {} typ srflx raddr", host.port())),
        "{answer}"
    );
    // A trickled candidate is taken (one for an address nobody answers at changes nothing); garbage is ignored.
    assert!(peer.send(ToPeer::Candidate(
        "candidate:9 1 udp 1 192.0.2.9 9 typ host".into()
    )));
    assert!(peer.send(ToPeer::Candidate("not a candidate".into())));
    viewer.answer(&answer).unwrap();

    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(event) = events.try_recv() {
            match event {
                PeerEvent::Open => break,
                PeerEvent::Closed(why) => panic!("the peer closed: {why}"),
                PeerEvent::Input(_) | PeerEvent::Keyframe | PeerEvent::Rtt(_) => {}
            }
        }
        assert!(Instant::now() < until, "no open peer within 10 s");
        viewer
            .pump(Instant::now() + Duration::from_millis(20))
            .await;
    }
    // A full agent checks the viewer too.
    assert!(
        viewer.checks_heard > 0,
        "the port sent no checks of its own"
    );
    // And the stream crosses.
    assert!(peer.send(ToPeer::Text(r#"{"type":"hello"}"#.into())));
    match viewer.recv(Duration::from_secs(5)).await {
        Some(Arrived::Text(text)) => assert_eq!(text, r#"{"type":"hello"}"#),
        other => panic!("a hello on media, not {other:?}"),
    }
    assert!(viewer.send(&"x".repeat(RTC_MESSAGE_MAX / 2)) || viewer.is_open("input"));
}
