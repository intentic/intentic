//! Which of a sandbox's two WebSockets an exchange rides while QUIC is not held. Streams on one TCP connection still
//! share its congestion window and wait out each other's losses, so a transfer rides a socket of its own and a keystroke
//! never queues behind it. What a transfer is, is the daemon's to say: the front announces the daemon's transfer routes
//! on each socket's upgrade (`BULK_HEADER`), and the edge matches every request against the announcement it holds, so
//! a route's socket follows the daemon that serves it, never the edge's build. Over QUIC nothing is announced or
//! matched: a stream that sends a burst yields by itself (`quic::Stream`).

use crate::host_owner_id;

/// Names a socket's lane on its upgrade; a socket naming none is the interactive one.
pub const LANE_HEADER: &str = "x-intentic-lane";

/// The daemon's transfer routes, announced on a socket's upgrade: `METHOD /path` entries, comma-separated, where a
/// `{param}` is one path segment, a trailing `/*` any further ones, and `ALL` every method.
pub const BULK_HEADER: &str = "x-intentic-bulk";

// The daemon's own label is this prefix and the sandbox id.
const DAEMON_PREFIX: &str = "sandbox-";

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

    /// The lane a socket's upgrade names.
    pub fn named(header: Option<&str>) -> Self {
        if header == Some(Self::Bulk.name()) {
            Self::Bulk
        } else {
            Self::Interactive
        }
    }
}

// One announced route: its method, its segments (`None` for a `{param}`), and whether a trailing `/*` takes the rest.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Route {
    method: String,
    segments: Vec<Option<String>>,
    tail: bool,
}

/// The routes a daemon announced as transfers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BulkRoutes(Vec<Route>);

impl BulkRoutes {
    /// What a header announces; an entry that is not `METHOD /path` is skipped.
    pub fn parse(header: &str) -> Self {
        Self(
            header
                .split(',')
                .filter_map(|entry| {
                    let (method, path) = entry.trim().split_once(' ')?;
                    let mut parts: Vec<&str> = path.strip_prefix('/')?.split('/').collect();
                    let tail = parts.last() == Some(&"*");
                    if tail {
                        parts.pop();
                    }
                    Some(Route {
                        method: method.to_ascii_uppercase(),
                        segments: parts
                            .into_iter()
                            .map(|part| {
                                (!(part.starts_with('{') && part.ends_with('}')))
                                    .then(|| part.to_owned())
                            })
                            .collect(),
                        tail,
                    })
                })
                .collect(),
        )
    }

    /// The header announcing `routes`, each `METHOD /path` as the daemon names it.
    pub fn announce(routes: &[String]) -> String {
        routes.join(", ")
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether a request to `host` rides the bulk socket: any preview's (a page load is hundreds of requests, and its
    /// assets can be large), and a daemon route announced as a transfer. `path` may carry its query.
    pub fn carries(&self, host: &str, method: &str, path: &str) -> bool {
        let Some(id) = host_owner_id(host) else {
            return true;
        };
        if relay::label_of(host).strip_prefix(DAEMON_PREFIX) != Some(id) {
            return true;
        }
        let method = method.to_ascii_uppercase();
        let segments: Vec<&str> = path
            .split('?')
            .next()
            .unwrap_or_default()
            .split('/')
            .skip(1)
            .collect();
        self.0
            .iter()
            .any(|route| answers(&route.method, &method) && takes(route, &segments))
    }
}

// The daemon's router answers a preflight at every route's path, every method with `ALL`, and HEAD with a GET route.
fn answers(declared: &str, method: &str) -> bool {
    method == "OPTIONS"
        || declared == method
        || declared == "ALL"
        || (declared == "GET" && method == "HEAD")
}

// A `{param}` takes one non-empty segment and a trailing `/*` one or more further ones.
fn takes(route: &Route, segments: &[&str]) -> bool {
    let fits = if route.tail {
        segments.len() > route.segments.len()
    } else {
        segments.len() == route.segments.len()
    };
    fits && route
        .segments
        .iter()
        .zip(segments)
        .all(|(wanted, segment)| match wanted {
            None => !segment.is_empty(),
            Some(literal) => literal == segment,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        host: String,
        method: String,
        path: String,
        lane: String,
    }

    #[derive(serde::Deserialize)]
    struct Fixture {
        bulk: Vec<String>,
        lanes: Vec<Case>,
    }

    // The contract's test holds `bulk` to what the daemon announces today and every case to the lane its own router
    // gives it, so this edge-side reading of the announcement and the daemon's router cannot disagree.
    #[test]
    fn every_request_in_the_shared_fixture_rides_the_lane_the_daemons_announcement_gives_it() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../../../_shared/sandbox-contract/src/protocol/ingress-contract.fixture.json"
        ))
        .unwrap();
        assert!(fixture.bulk.len() > 5);
        assert!(fixture.lanes.len() > 20);
        let routes = BulkRoutes::parse(&BulkRoutes::announce(&fixture.bulk));
        assert_eq!(routes.0.len(), fixture.bulk.len());
        for Case {
            host,
            method,
            path,
            lane,
        } in fixture.lanes
        {
            let carried = if routes.carries(&host, &method, &path) {
                Lane::Bulk
            } else {
                Lane::Interactive
            };
            assert_eq!(carried.name(), lane, "{method} {host}{path}");
        }
    }

    #[test]
    fn an_announcement_reads_back_its_params_its_tail_and_nothing_malformed() {
        let routes = BulkRoutes::parse(
            "GET /files/{id}/raw, ALL /mirror/*, bogus, POST no-slash, get /diff/raw",
        );
        assert_eq!(routes.0.len(), 3);
        let daemon = "sandbox-abcdef012345.sbx.test";
        assert!(routes.carries(daemon, "GET", "/files/abc/raw?x=1"));
        assert!(routes.carries(daemon, "HEAD", "/files/abc/raw"));
        assert!(!routes.carries(daemon, "GET", "/files//raw"));
        assert!(routes.carries(daemon, "DELETE", "/mirror/a/b"));
        assert!(!routes.carries(daemon, "DELETE", "/mirror"));
        assert!(routes.carries(daemon, "GET", "/diff/raw"));
        assert!(!routes.carries(daemon, "GET", "/agents"));
        assert!(routes.carries("preview-web-abcdef012345.sbx.test", "GET", "/"));
        assert!(BulkRoutes::parse("").is_empty());
    }

    #[test]
    fn a_socket_is_interactive_unless_it_names_the_bulk_lane() {
        assert_eq!(Lane::named(Some("bulk")), Lane::Bulk);
        assert_eq!(Lane::named(Some("interactive")), Lane::Interactive);
        assert_eq!(Lane::named(Some("anything")), Lane::Interactive);
        assert_eq!(Lane::named(None), Lane::Interactive);
    }
}
