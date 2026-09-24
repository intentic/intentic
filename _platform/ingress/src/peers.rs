//! Who the other edge machines are. A peer is an address and two ports: the public one a forwarded request is routed on
//! by Host, and the internal one the holds protocol speaks on. A static list and Fly's internal DNS produce the same
//! shape, published on a watch channel whose holders see every change.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

// Bounds how stale the machine set gets; one local lookup, so cheap.
const FLY_POLL_EVERY: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub host: String,
    pub port: u16,
    pub internal_port: u16,
}

impl Peer {
    /// Identity for map keys: one host on two ports is two peers.
    pub fn key(&self) -> String {
        format!("{}|{}|{}", self.host, self.port, self.internal_port)
    }

    /// `host:port` as an address spells it, an IPv6 literal bracketed.
    pub fn address(&self, port: u16) -> String {
        if self.host.contains(':') {
            format!("[{}]:{port}", self.host)
        } else {
            format!("{}:{port}", self.host)
        }
    }
}

/// The current machine set, other than this one.
pub type Peers = watch::Receiver<Vec<Peer>>;

/// `host[:port[:internalPort]]`, comma-separated, an IPv6 literal bracketed (`[fdaa::1]:8080:8081`); a malformed entry
/// is an error, so a typo is a boot failure rather than a peer silently dropped.
pub fn parse_peer_list(list: &str, port: u16, internal_port: u16) -> anyhow::Result<Vec<Peer>> {
    list.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            parse_entry(entry, port, internal_port).ok_or_else(|| {
                anyhow::anyhow!("INGRESS_PEERS entry \"{entry}\" is not host[:port[:internalPort]]")
            })
        })
        .collect()
}

fn parse_entry(entry: &str, port: u16, internal_port: u16) -> Option<Peer> {
    let (host, ports) = match entry.strip_prefix('[') {
        Some(bracketed) => bracketed.split_once(']')?,
        None => entry
            .find(':')
            .map_or((entry, ""), |at| (&entry[..at], &entry[at..])),
    };
    if host.is_empty() {
        return None;
    }
    let numbers: Vec<u16> = if ports.is_empty() {
        Vec::new()
    } else {
        ports
            .strip_prefix(':')?
            .split(':')
            .map(|number| number.parse().ok())
            .collect::<Option<_>>()?
    };
    if numbers.len() > 2 {
        return None;
    }
    Some(Peer {
        host: host.to_owned(),
        port: numbers.first().copied().unwrap_or(port),
        internal_port: numbers.get(1).copied().unwrap_or(internal_port),
    })
}

/// A set that is what it was told and never moves.
pub fn fixed(peers: Vec<Peer>) -> Peers {
    let (published, peers) = watch::channel(sorted(peers));
    // Kept alive for the process's life: a receiver whose sender is gone reads as a set that ended.
    std::mem::forget(published);
    peers
}

fn sorted(peers: Vec<Peer>) -> Vec<Peer> {
    let by_key: BTreeMap<String, Peer> = peers.into_iter().map(|peer| (peer.key(), peer)).collect();
    by_key.into_values().collect()
}

/// The machines of a Fly app, from `<app>.internal`, this one left out by its private address.
pub struct FlyPeers {
    app: String,
    this: Option<IpAddr>,
    port: u16,
    internal_port: u16,
    published: watch::Sender<Vec<Peer>>,
}

impl FlyPeers {
    pub fn new(app: &str, this: &str, port: u16, internal_port: u16) -> Self {
        Self {
            app: app.to_owned(),
            this: this.parse().ok(),
            port,
            internal_port,
            published: watch::channel(Vec::new()).0,
        }
    }

    pub fn peers(&self) -> Peers {
        self.published.subscribe()
    }

    /// Polls now and then every ten seconds, for the process's life.
    pub fn start(self) -> Peers {
        let peers = self.peers();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(FLY_POLL_EVERY);
            loop {
                every.tick().await;
                let name = format!("{}.internal", self.app);
                let answer = tokio::net::lookup_host((name.as_str(), 0))
                    .await
                    .map(|found| {
                        found
                            .map(|address| address.ip())
                            .filter(IpAddr::is_ipv6)
                            .collect()
                    });
                self.apply(answer);
            }
        });
        peers
    }

    /// One answer from DNS: published when the machine set moved, and a failed lookup keeps the last answer, since a
    /// DNS blip is not an empty app.
    pub fn apply(&self, answer: std::io::Result<Vec<IpAddr>>) {
        let addresses = match answer {
            Ok(addresses) => addresses,
            Err(error) => {
                tracing::warn!(%error, app = %self.app, "peer discovery did not resolve; keeping the last answer");
                return;
            }
        };
        let next = sorted(
            addresses
                .into_iter()
                .filter(|address| Some(*address) != self.this)
                .map(|address| Peer {
                    host: address.to_string(),
                    port: self.port,
                    internal_port: self.internal_port,
                })
                .collect(),
        );
        self.published.send_if_modified(|peers| {
            let moved = *peers != next;
            if moved {
                *peers = next;
            }
            moved
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(host: &str, port: u16, internal_port: u16) -> Peer {
        Peer {
            host: host.into(),
            port,
            internal_port,
        }
    }

    #[test]
    fn an_entry_naming_only_a_host_takes_this_machines_ports() {
        assert_eq!(
            parse_peer_list("10.0.0.2, edge-b", 8080, 8081).unwrap(),
            [peer("10.0.0.2", 8080, 8081), peer("edge-b", 8080, 8081)]
        );
    }

    #[test]
    fn explicit_ports_and_a_bracketed_ipv6_literal_are_read() {
        assert_eq!(
            parse_peer_list("127.0.0.1:9000:9001,[fdaa::2]:8080", 8080, 8081).unwrap(),
            [peer("127.0.0.1", 9000, 9001), peer("fdaa::2", 8080, 8081)]
        );
        assert_eq!(
            parse_peer_list("[fdaa::3]", 8080, 8081).unwrap(),
            [peer("fdaa::3", 8080, 8081)]
        );
    }

    #[test]
    fn an_empty_list_is_no_peers() {
        assert!(parse_peer_list("", 8080, 8081).unwrap().is_empty());
        assert!(parse_peer_list(" , ", 8080, 8081).unwrap().is_empty());
    }

    #[test]
    fn an_entry_it_cannot_read_is_refused() {
        for bad in [
            "fdaa::2:8080",
            "host:port",
            "host:1:2:3",
            "[fdaa::2",
            ":8080",
            "host:99999",
        ] {
            let refused = parse_peer_list(bad, 8080, 8081).unwrap_err().to_string();
            assert!(refused.contains("host[:port"), "{bad}: {refused}");
        }
    }

    #[test]
    fn a_fixed_set_is_ordered_and_never_moves() {
        let peers = fixed(vec![peer("b", 1, 2), peer("a", 1, 2)]);
        assert_eq!(
            peers
                .borrow()
                .iter()
                .map(|peer| peer.host.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(!peers.has_changed().unwrap());
    }

    #[test]
    fn fly_discovery_leaves_itself_out_and_publishes_only_a_moved_set() {
        let fly = FlyPeers::new("edge", "fdaa::1", 8080, 8081);
        let mut peers = fly.peers();
        let addresses = |list: &[&str]| {
            Ok(list
                .iter()
                .map(|address| address.parse().unwrap())
                .collect())
        };

        fly.apply(addresses(&["fdaa::3", "fdaa::1", "fdaa::2"]));
        assert!(peers.has_changed().unwrap());
        assert_eq!(
            peers
                .borrow_and_update()
                .iter()
                .map(Peer::key)
                .collect::<Vec<_>>(),
            ["fdaa::2|8080|8081", "fdaa::3|8080|8081"]
        );
        fly.apply(addresses(&["fdaa::2", "fdaa::3"]));
        assert!(!peers.has_changed().unwrap());
        fly.apply(Err(std::io::ErrorKind::NotFound.into()));
        assert!(!peers.has_changed().unwrap());
        assert_eq!(peers.borrow().len(), 2);
        fly.apply(addresses(&["fdaa::3"]));
        assert_eq!(
            peers
                .borrow_and_update()
                .iter()
                .map(|peer| peer.host.as_str())
                .collect::<Vec<_>>(),
            ["fdaa::3"]
        );
    }
}
