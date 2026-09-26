//! What the tunnel's two Rust ends share to relay HTTP: the edge (`_platform/ingress`) between browsers and tunnels,
//! the front (`_sandbox/front`) between tunnels, listeners, Node and previews. One body type, one list of what never
//! crosses a hop, one reading of a request's host, one HTTP/1.1 exchange over any byte stream with upgrades spliced,
//! and one redial ladder.

pub mod backoff;
pub mod body;
mod exchange;
mod headers;

pub use backoff::Backoff;
pub use exchange::exchange;
pub use headers::{HOP_BY_HOP, for_next_hop, host_of, is_upgrade, label_of, strip_hop_by_hop};
