//! A viewer's peer connection straight to castd: the media socket's traffic on DataChannels over DTLS and SCTP, for a
//! viewer on the sandbox's own network, where a public https page cannot open the plain `ws://` a LAN address would
//! need and no certificate names one. The media socket signals it (`rtcOffer`, `rtcAnswer`) and stays open beside it
//! as control and fallback: once the peer's `media` channel opens castd says `hello` there and moves the stream onto
//! it, and whenever the peer fails the stream comes back to the socket with another `hello`.
//!
//! castd is an ICE-lite agent on ONE UDP port for every viewer (`--rtc-udp`), with host candidates only, the addresses
//! the port is published on (`--rtc-candidates`): the viewer checks them and castd answers, so castd needs no STUN
//! server and never sends to an address that did not check it first. The port carries every peer: a datagram goes to
//! the peer whose ICE ufrag its binding request named ([`stun`]), and later ones from that address follow. Who may
//! connect is settled by the authenticated socket: the SDP castd answers carries its DTLS fingerprint and ICE password,
//! so only the viewer that holds the socket's token can complete the handshake.

pub mod chunk;
mod peer;
mod port;
pub mod stun;
pub mod viewer;

pub use peer::{Peer, PeerEvent, ToPeer, accept};
pub use port::start;
use port::{Datagram, Service};

/// Whether this castd takes peer connections: its `hello` says `rtc`.
pub fn offered() -> bool {
    port::offered()
}
