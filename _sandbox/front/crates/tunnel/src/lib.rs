//! The ingress tunnel's wire, as both of its ends speak it: the edge that holds a sandbox's tunnels
//! (`_platform/ingress`) and the front that dials them (`_sandbox/front`). A tunnel is a carrier of byte streams, one
//! per exchange, each carrying plain HTTP/1.1 so that a body or an upgrade needs nothing of its own: a QUIC connection
//! where the edge declares one (`quic`), and two WebSockets carrying yamux beside it (`mux`), which carry every exchange
//! while QUIC is not held, a transfer on the bulk one (`bulk`). The edge opens the streams, the front serves them.

mod bulk;
pub mod mux;
mod pump;
pub mod quic;

use std::time::Duration;

pub use bulk::{BULK_HEADER, BulkRoutes, LANE_HEADER, Lane};
pub use pump::{Close, Ended, Liveness, pump, raised};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

/// The tunnel door on the edge, versioned so a new session shape takes a new path. `/tunnel/v1`, an h2 session over
/// two WebSocket lanes, is the edge's alone to answer now, for fronts that predate this one.
pub const TUNNEL_PATH: &str = "/tunnel/v2";

/// The reachability grant rides this header on the tunnel's upgrade.
pub const GRANT_HEADER: &str = "x-intentic-grant";

/// What the edge declares it serves besides its WebSockets, on its answer to a tunnel's upgrade and on `/health`: the
/// tokens of [`Transport`], comma-separated. An edge that names none serves none, which is every edge older than this.
pub const TRANSPORTS_HEADER: &str = "x-intentic-transports";

/// The upgrade a tunnel opens with, and the one a terminal opens with wherever it rides.
pub const WEBSOCKET_UPGRADE: &str = "websocket";

/// The close code of a tunnel a newer one for the same sandbox and slot displaced.
pub const DISPLACED_CODE: u16 = 4001;

/// The front pings this often, and both ends forget a peer silent this long: a path that died without a FIN reports
/// nothing else. QUIC's keep-alive and idle timeout run on the same two.
pub const PING_EVERY: Duration = Duration::from_secs(15);
pub const DEAD_AFTER: Duration = Duration::from_secs(45);

/// Per-stream receive window on QUIC and the legacy h2 session: the session crosses the internet, where h2's 64 KiB
/// default starves a transfer.
pub const STREAM_WINDOW: u32 = 1024 * 1024;

/// Session receive window, twice a stream's and near the bandwidth-delay product, since a larger one queues a keystroke
/// behind a download on a slow link.
pub const CONNECTION_WINDOW: u32 = 2 * STREAM_WINDOW;

/// Streams one carrier holds at once; many (a terminal, an event stream) stay open its whole life.
pub const MAX_STREAMS: u32 = 1024;

// Bytes a tunnel's socket reads into at once, allocated up front for each one: an edge holds thousands of mostly idle
// tunnels, and a larger frame still grows the buffer for itself.
const READ_BUFFER: usize = 16 * 1024;

/// How both ends open a tunnel's WebSocket.
pub fn socket_config() -> WebSocketConfig {
    WebSocketConfig::default().read_buffer_size(READ_BUFFER)
}

/// What an edge may serve beyond HTTPS over TCP, each only because its own configuration binds it: a front dials QUIC
/// and an editor opens WebTransport only where the edge declared it, never to find out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Transport {
    /// The tunnel over QUIC (`quic::ALPN`), beside the WebSocket.
    Quic,
    /// A browser's HTTP/3 on the same UDP port.
    H3,
    /// A browser's WebTransport session at a sandbox's `/system/transport`, which the editor's terminals ride.
    WebTransport,
}

impl Transport {
    pub const ALL: [Self; 3] = [Self::Quic, Self::H3, Self::WebTransport];

    pub const fn token(self) -> &'static str {
        match self {
            Self::Quic => "quic",
            Self::H3 => "h3",
            Self::WebTransport => "webtransport",
        }
    }

    /// The declaration's header value.
    pub fn declare(served: &[Self]) -> String {
        served
            .iter()
            .map(|transport| transport.token())
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// What a declaration names; a token this build does not know is skipped, and no header is nothing served.
    pub fn declared(header: Option<&str>) -> Vec<Self> {
        header
            .unwrap_or("")
            .split(',')
            .filter_map(|token| {
                Self::ALL
                    .into_iter()
                    .find(|transport| token.trim().eq_ignore_ascii_case(transport.token()))
            })
            .collect()
    }
}

/// The sandbox a Host belongs to: its leftmost label ends in `-<12 hex>`. Ownership is a parse, never a registry.
pub fn host_owner_id(host: &str) -> Option<&str> {
    let label = relay::label_of(host);
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

    // THE WIRE THIS CRATE DEFINES, written where the contract's lock reads it (`contract-lock.ts`), as ts-rs writes the
    // front's types: the TypeScript side reads these values instead of restating them, and a value that changes or goes
    // away is a removal the lock flags like any contract removal.
    #[test]
    fn the_wire_is_written_where_the_contract_locks_it() {
        let manifest = serde_json::json!({
            "path": TUNNEL_PATH,
            "upgrade": WEBSOCKET_UPGRADE,
            "headers": {
                "grant": GRANT_HEADER,
                "lane": LANE_HEADER,
                "bulk": BULK_HEADER,
                "transports": TRANSPORTS_HEADER,
            },
            "lanes": Lane::ALL.map(Lane::name),
            "mux": mux::PROTOCOL,
            "transports": Transport::ALL.map(Transport::token),
            "close": {
                "displaced": DISPLACED_CODE,
                "away": quic::AWAY.into_inner(),
                "refused": quic::REFUSED.into_inner(),
            },
            "liveness": {
                "pingEveryMs": PING_EVERY.as_millis(),
                "deadAfterMs": DEAD_AFTER.as_millis(),
            },
            "quic": {
                "alpn": std::str::from_utf8(quic::ALPN).unwrap(),
                "yieldAfterBytes": quic::YIELD_AFTER,
                "hello": {
                    "held": quic::Hello::Held as u8,
                    "refused": quic::Hello::Refused as u8,
                    "gone": quic::Hello::Gone as u8,
                },
            },
        });
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../_shared/sandbox-contract/src/front/generated/tunnel.json"
        );
        let written = format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap());
        if std::fs::read_to_string(path).ok().as_deref() != Some(written.as_str()) {
            std::fs::write(path, written).unwrap();
        }
    }

    #[test]
    fn a_declaration_reads_back_what_it_names_and_nothing_it_does_not_know() {
        assert_eq!(
            Transport::declare(&Transport::ALL),
            "quic, h3, webtransport"
        );
        assert_eq!(
            Transport::declared(Some("quic, h3, webtransport")),
            Transport::ALL
        );
        assert_eq!(
            Transport::declared(Some("WebTransport,carrier-pigeon")),
            [Transport::WebTransport]
        );
        assert_eq!(Transport::declared(Some("")), []);
        assert_eq!(Transport::declared(None), []);
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
}
