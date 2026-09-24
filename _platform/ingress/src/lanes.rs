//! Which of a sandbox's tunnels a browser request rides: a preview's dev server or any name but the daemon's is bulk, and
//! a daemon request rides its raw route's lane, the route found as the daemon's router finds it. The table is generated
//! from the contract's raw-routes.ts (tunnel-lanes.json); this file and tunnel-lanes.ts are held to one fixture.

use std::sync::LazyLock;

use serde::Deserialize;
use tunnel::{Lane, host_owner_id, label_of};

// The daemon's own label is this prefix and the sandbox id.
const DAEMON_PREFIX: &str = "sandbox-";

#[derive(Deserialize)]
struct Declared {
    method: String,
    path: String,
    lane: String,
}

// A route template split once: a literal segment, or `None` for a `{param}`; `tail` for a trailing `/*`.
struct Route {
    method: String,
    segments: Vec<Option<String>>,
    tail: bool,
    lane: Lane,
}

static TABLE: LazyLock<Vec<Route>> = LazyLock::new(|| {
    let declared: Vec<Declared> = serde_json::from_str(include_str!(
        "../../../_shared/sandbox-contract/src/protocol/tunnel-lanes.json"
    ))
    .expect("the contract's lane table parses");
    declared.into_iter().map(compile).collect()
});

fn compile(declared: Declared) -> Route {
    let mut parts: Vec<&str> = declared.path.split('/').skip(1).collect();
    let tail = parts.last() == Some(&"*");
    if tail {
        parts.pop();
    }
    Route {
        method: declared.method,
        segments: parts
            .into_iter()
            .map(|part| (!(part.starts_with('{') && part.ends_with('}'))).then(|| part.to_owned()))
            .collect(),
        tail,
        lane: Lane::named(Some(&declared.lane)),
    }
}

/// The lane a request to `host` rides: `method` as the browser sent it, `path` with its query.
pub fn lane_of(host: &str, method: &str, path: &str) -> Lane {
    let Some(id) = host_owner_id(host) else {
        return Lane::Bulk;
    };
    if label_of(host).strip_prefix(DAEMON_PREFIX) != Some(id) {
        return Lane::Bulk;
    }
    let method = method.to_ascii_uppercase();
    let path = path.split('?').next().unwrap_or_default();
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    let matching = TABLE
        .iter()
        .filter(|route| answers(&route.method, &method) && takes(route, &segments));
    let served = if method == "OPTIONS" {
        most_literal(matching)
    } else {
        matching.into_iter().next()
    };
    served.map_or(Lane::Interactive, |route| route.lane)
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

// A preflight belongs to no route, so the most literal one that would answer its path names it: a literal segment
// outranks a parameter at the first place two routes differ.
fn most_literal<'a>(routes: impl Iterator<Item = &'a Route>) -> Option<&'a Route> {
    routes.fold(None, |best, route| match best {
        Some(best) if !more_literal(route, best) => Some(best),
        _ => Some(route),
    })
}

fn more_literal(a: &Route, b: &Route) -> bool {
    a.segments
        .iter()
        .enumerate()
        .find(|(index, segment)| {
            segment.is_none() != b.segments.get(*index).is_none_or(Option::is_none)
        })
        .is_some_and(|(_, segment)| segment.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Case {
        host: String,
        method: String,
        path: String,
        lane: String,
    }

    #[derive(Deserialize)]
    struct Fixture {
        lanes: Vec<Case>,
    }

    #[test]
    fn every_request_in_the_shared_fixture_rides_the_lane_the_contract_gives_it() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../_shared/sandbox-contract/src/protocol/ingress-contract.fixture.json"
        ))
        .unwrap();
        assert!(fixture.lanes.len() > 20);
        for Case {
            host,
            method,
            path,
            lane,
        } in fixture.lanes
        {
            assert_eq!(
                lane_of(&host, &method, &path).name(),
                lane,
                "{method} {host}{path}"
            );
        }
    }

    #[test]
    fn the_table_holds_the_daemons_transfers() {
        assert!(TABLE.len() > 100);
        assert!(
            TABLE
                .iter()
                .filter(|route| route.lane == Lane::Bulk)
                .count()
                > 5
        );
    }
}
