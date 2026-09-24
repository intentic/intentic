//! The ingress tunnel's wire, as both of its ends speak it: the edge that holds a sandbox's tunnels
//! (`_platform/ingress`) and the front that dials them (`_sandbox/front`). A tunnel is one WebSocket carrying one HTTP/2
//! session, the edge the client; an upgrade rides a CONNECT stream whose headers carry the browser's h1 head.

mod envelope;
mod pump;
pub mod quic;

use std::time::Duration;

pub use envelope::{HOP_BY_HOP, unwrap_envelope, wrap_envelope};
pub use pump::{Close, Ended, pump, raised};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

/// The tunnel door on the edge, versioned so a new session shape takes a new path.
pub const TUNNEL_PATH: &str = "/tunnel/v1";

/// The reachability grant rides this header on the tunnel's upgrade.
pub const GRANT_HEADER: &str = "x-intentic-grant";

/// Names a tunnel's lane on its upgrade; a tunnel naming none is the interactive one.
pub const LANE_HEADER: &str = "x-intentic-lane";

/// The close code of a tunnel a newer one for the same sandbox and lane displaced.
pub const DISPLACED_CODE: u16 = 4001;

/// Both ends ping this often, and forget a peer silent this long: a path that died without a FIN reports nothing else.
pub const PING_EVERY: Duration = Duration::from_secs(15);
pub const DEAD_AFTER: Duration = Duration::from_secs(45);

/// Per-stream receive window: the session crosses the internet, where h2's 64 KiB default starves a transfer.
pub const STREAM_WINDOW: u32 = 1024 * 1024;

/// Session receive window, twice a stream's and near the bandwidth-delay product, since a larger one queues a keystroke
/// behind a download on a slow link.
pub const CONNECTION_WINDOW: u32 = 2 * STREAM_WINDOW;

/// Streams one session carries at once; many stay open a session's whole life.
pub const MAX_STREAMS: u32 = 1024;

// Bytes a tunnel's socket reads into at once, allocated up front for each one: an edge holds thousands of mostly idle
// tunnels, and a larger frame still grows the buffer for itself.
const READ_BUFFER: usize = 16 * 1024;

/// How both ends open a tunnel's WebSocket.
pub fn socket_config() -> WebSocketConfig {
    WebSocketConfig::default().read_buffer_size(READ_BUFFER)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane {
    Interactive,
    Bulk,
}

impl Lane {
    pub const ALL: [Self; 2] = [Self::Interactive, Self::Bulk];

    pub const fn name(self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Bulk => "bulk",
        }
    }

    /// The lane a tunnel's upgrade names.
    pub fn named(header: Option<&str>) -> Self {
        if header == Some(Self::Bulk.name()) {
            Self::Bulk
        } else {
            Self::Interactive
        }
    }
}

/// The leftmost DNS label of a Host, port stripped; empty when there is none.
pub fn label_of(host: &str) -> &str {
    host.split(':')
        .next()
        .unwrap_or("")
        .split('.')
        .next()
        .unwrap_or("")
}

/// The sandbox a Host belongs to: its leftmost label ends in `-<12 hex>`. Ownership is a parse, never a registry.
pub fn host_owner_id(host: &str) -> Option<&str> {
    let label = label_of(host);
    let (_, id) = label.rsplit_once('-')?;
    (id.len() == 12
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
    .then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTRACT: &str =
        include_str!("../../../../../_shared/sandbox-contract/src/protocol/ingress-contract.ts");
    const LANES: &str =
        include_str!("../../../../../_shared/sandbox-contract/src/protocol/tunnel-lanes.ts");

    #[test]
    fn every_constant_the_contract_names_is_the_contracts() {
        let pinned = [
            (
                CONTRACT,
                format!("export const INGRESS_TUNNEL_PATH = \"{TUNNEL_PATH}\";"),
            ),
            (
                CONTRACT,
                format!("export const INGRESS_GRANT_HEADER = \"{GRANT_HEADER}\";"),
            ),
            (
                LANES,
                format!("export const INGRESS_LANE_HEADER = \"{LANE_HEADER}\";"),
            ),
        ];
        for (source, line) in pinned {
            assert!(
                source.contains(&line),
                "the contract no longer says `{line}`: bring the tunnel crate in step"
            );
        }
    }

    #[derive(serde::Deserialize)]
    struct Owned {
        host: String,
        owner: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct Fixture {
        owners: Vec<Owned>,
    }

    #[test]
    fn every_host_in_the_shared_fixture_is_owned_as_the_contract_owns_it() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../../../_shared/sandbox-contract/src/protocol/ingress-contract.fixture.json"
        ))
        .unwrap();
        assert!(fixture.owners.len() > 10);
        for Owned { host, owner } in fixture.owners {
            assert_eq!(host_owner_id(&host), owner.as_deref(), "owner of {host:?}");
        }
    }

    #[test]
    fn a_tunnel_is_interactive_unless_it_names_the_bulk_lane() {
        assert_eq!(Lane::named(Some("bulk")), Lane::Bulk);
        assert_eq!(Lane::named(Some("interactive")), Lane::Interactive);
        assert_eq!(Lane::named(Some("anything")), Lane::Interactive);
        assert_eq!(Lane::named(None), Lane::Interactive);
    }
}
