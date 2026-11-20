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
//!
//! A device daemon on a computer behind a NAT starts the port with full ICE instead ([`start_with`], [`Ice::Full`]):
//! its answer adds the server-reflexive candidates STUN servers named, it takes the viewer's trickled candidates
//! (`rtcCandidate`), and it sends checks of its own, so a viewer behind a NAT of its own can be reached too. The answers
//! to those checks come back to the peer that sent them.

pub mod chunk;
mod peer;
mod port;
pub mod stun;
pub mod viewer;

pub use peer::{Peer, PeerEvent, ToPeer, accept};
use port::{Datagram, Service};
pub use port::{Gathered, start, start_with};

/// Which ICE the port's peers run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Ice {
    /// Answer checks, send none; host candidates only (castd's: its candidates are published, its viewers check them).
    #[default]
    Lite,
    /// A full agent: server-reflexive candidates from STUN, the viewer's candidates taken, checks sent both ways.
    Full,
}

/// How to start the peer port.
#[derive(Debug, Clone)]
pub struct RtcConfig {
    /// The UDP address to bind.
    pub bind: std::net::SocketAddr,
    /// Host candidates: where viewers reach the port (a port 0 is the one bound).
    pub candidates: Vec<std::net::SocketAddr>,
    pub ice: Ice,
    /// STUN servers to learn the port's server-reflexive address from (full ICE only).
    pub stun: Vec<std::net::SocketAddr>,
}

/// Whether this castd takes peer connections: its `hello` says `rtc`.
pub fn offered() -> bool {
    port::offered()
}
