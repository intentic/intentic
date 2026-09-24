//! The edge every sandbox is reached through. A sandbox on somebody's own machine dials it, presenting a grant the
//! platform signed, and every request whose Host ends in that sandbox's id rides that tunnel; a sandbox the platform hosts
//! on Fly is replayed to its app instead. Several machines behind one address hand a miss to whichever holds the tunnel.

pub mod body;
pub mod certificate;
pub mod cluster;
pub mod config;
pub mod edge;
pub mod forward;
pub mod grant;
pub mod h3;
pub mod lanes;
pub mod peers;
pub mod platform;
pub mod proxy_protocol;
pub mod quic;
pub mod registry;
pub mod revocation;
pub mod serve;
pub mod session;
pub mod tls;
pub mod webtransport;
