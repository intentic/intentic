//! Which peer holds which sandbox's tunnels, so a miss here goes to the machine that has one, once. Only peers discovery
//! knows are heard, and an entry nobody refreshes expires. `Holds` crosses between machines of different builds during
//! a roll, so its shape only grows.
//!
//! Since 2026-10-05 every slot is news (a sandbox held only over QUIC on another machine is that machine's to answer,
//! not `no-tunnel` here), and each holding carries when it registered and which front instance dialled it, so what a
//! peer hears is ordered: an `add` older than this machine's own registration in that slot is stale and ignored rather
//! than displacing the newer tunnel (a delayed one did), a newer one of the same front displaces it, and between two
//! copies of one sandbox the one that registered first holds it on every machine, the other closed with
//! `HELD_ELSEWHERE_CODE`. A full `set` never displaces a tunnel of the same front. An older peer's message names its
//! socket ids alone (`ids`), and is read as it always was: newest wins.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde::{Deserialize, Serialize};

use tunnel::{Close, DISPLACED_CODE, HELD_ELSEWHERE_CODE, Identity};

use crate::body::{self, Body};
use crate::grant::is_sandbox_id;
use crate::peers::{Peer, Peers};
use crate::registry::{Change, Elsewhere, Holding, Registry, Slot};

/// Marks a request already handed on once; a hop-marked miss is final.
pub const HOP_HEADER: &str = "x-intentic-hop";

pub const HOLDS_PATH: &str = "/internal/v1/holds";

/// Each machine pushes its whole held-id list this often, which repairs any message lost between.
pub const SYNC_EVERY: Duration = Duration::from_secs(30);

/// An entry two syncs stale is dropped, whether or not discovery has noticed its peer is gone.
pub const REMOTE_TTL: Duration = Duration::from_secs(65);

// A peer that has not answered by now will not; the next sync repeats the same fact.
const SEND_PATIENCE: Duration = Duration::from_secs(5);

// Far above any real cluster's id list.
const MAX_HOLDS_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Add,
    Remove,
    Set,
}

// What an older peer's message says of when its socket ids registered: nothing, which reads as newest, as it always did.
const UNORDERED: u64 = u64::MAX;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holds {
    /// The sender as its peers reach it; heard only if discovery knows it.
    pub from: Peer,
    /// The sending machine.
    pub instance: String,
    pub op: Op,
    /// Socket slots alone, as every peer before 2026-10-05 reads them.
    pub ids: Vec<String>,
    /// Every slot, each with when it registered and the front that dialled it; empty from an older peer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tunnels: Vec<Holding>,
}

impl Holds {
    fn well_formed(&self) -> bool {
        !self.from.host.is_empty()
            && self.from.port > 0
            && self.from.internal_port > 0
            && self.ids.iter().all(|id| is_sandbox_id(id))
            && self.tunnels.iter().all(|tunnel| is_sandbox_id(&tunnel.id))
    }

    // What the message holds: its tunnels, or an older peer's socket ids, unordered.
    fn holdings(&self) -> Vec<Holding> {
        if !self.tunnels.is_empty() {
            return self.tunnels.clone();
        }
        self.ids
            .iter()
            .map(|id| Holding {
                id: id.clone(),
                slot: Slot::Socket,
                since: UNORDERED,
                instance: None,
                host: String::new(),
            })
            .collect()
    }
}

// One peer's holding of a sandbox, and when this machine last heard of it.
#[derive(Debug, Clone)]
struct Remote {
    peer: Peer,
    at: Instant,
    holding: Holding,
}

/// What a peer's holding means for one this machine holds of the same sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Meets {
    /// The peer's is the newer tunnel of the same front (or of one naming no instance): it takes the slot.
    Displace,
    /// Another copy of the sandbox registered before this machine's one did: this machine's is refused.
    Refuse,
    /// The peer's message is older than this machine's registration in the slot: it changes nothing.
    Stale,
    /// This machine's copy registered first: the peer's is to be refused there.
    Incumbent,
    /// Another slot, or a silent holder of another instance in another slot, which its own silence check ends.
    Unrelated,
}

/// How a peer's `arriving` holding meets this machine's `local` one of the same sandbox, whose carrier is `alive`.
pub fn meets(local: &Holding, alive: bool, arriving: &Holding) -> Meets {
    let copies = match (&local.instance, &arriving.instance) {
        (Some(mine), Some(theirs)) => mine != theirs,
        _ => false,
    };
    if copies && alive {
        // Earlier wins, the instance breaking a tie, so both machines reach the same answer.
        let first = (arriving.since, &arriving.instance) < (local.since, &local.instance);
        return if first {
            Meets::Refuse
        } else {
            Meets::Incumbent
        };
    }
    if local.slot != arriving.slot {
        Meets::Unrelated
    } else if arriving.since >= local.since {
        Meets::Displace
    } else {
        Meets::Stale
    }
}

pub struct Cluster {
    instance: String,
    /// This machine as peers reach it; an empty host receives and routes but never advertises.
    this: Peer,
    peers: Peers,
    registry: Arc<Registry>,
    ttl: Duration,
    remote: Mutex<HashMap<String, Vec<Remote>>>,
    client: Client<HttpConnector, Full<Bytes>>,
    closed: AtomicBool,
}

impl Cluster {
    pub fn new(
        instance: &str,
        this: Peer,
        peers: Peers,
        registry: Arc<Registry>,
        ttl: Duration,
    ) -> Arc<Self> {
        let cluster = Arc::new(Self {
            instance: instance.to_owned(),
            this,
            peers,
            registry,
            ttl,
            remote: Mutex::new(HashMap::new()),
            client: Client::builder(TokioExecutor::new()).build_http(),
            closed: AtomicBool::new(false),
        });
        let told = Arc::downgrade(&cluster);
        cluster.registry.on_change(move |holding, change| {
            if let Some(cluster) = told.upgrade() {
                cluster.local_change(holding, change);
            }
        });
        cluster
    }

    /// Greets the machines already known, then keeps up with discovery and syncs every `every`, until `close`.
    pub fn start(self: &Arc<Self>, every: Duration) {
        let known: Vec<Peer> = self.peers.borrow().clone();
        for peer in known {
            tokio::spawn(greet(self.clone(), peer));
        }
        tokio::spawn(follow(Arc::downgrade(self), self.peers.clone()));
        let ticking = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                let Some(cluster) = ticking.upgrade() else {
                    return;
                };
                if cluster.is_closed() {
                    return;
                }
                cluster.tick().await;
            }
        });
    }

    /// The peer a locally unknown id is held by, in any slot, if one claimed it and has kept claiming it.
    pub fn holder(&self, id: &str) -> Option<Peer> {
        let ttl = self.ttl;
        let mut remote = self.remote();
        let held = remote.get_mut(id)?;
        held.retain(|entry| entry.at.elapsed() <= ttl);
        let found = held
            .iter()
            .find(|entry| entry.holding.slot == Slot::Socket)
            .or_else(|| held.first())
            .map(|entry| entry.peer.clone());
        if held.is_empty() {
            remote.remove(id);
        }
        found
    }

    /// Whether a peer holds `id` for a front of another instance than `identity`'s, as it said within the TTL: the
    /// one-holder rule across machines, asked before a registration is answered.
    pub fn held_elsewhere(&self, id: &str, identity: Option<&Identity>) -> Option<Elsewhere> {
        let instance = &identity?.instance;
        let ttl = self.ttl;
        self.remote().get(id)?.iter().find_map(|entry| {
            let theirs = entry.holding.instance.as_ref()?;
            (theirs != instance && entry.at.elapsed() <= ttl).then(|| Elsewhere {
                instance: theirs.clone(),
                host: entry.holding.host.clone(),
            })
        })
    }

    /// Stops trusting the current holder of `id`, which a forward found to be wrong.
    pub fn forget(&self, id: &str) {
        self.remote().remove(id);
    }

    pub fn remote_count(&self) -> usize {
        self.remote().len()
    }

    pub fn receive(self: &Arc<Self>, holds: Holds) {
        if self.is_closed() || !self.knows(&holds.from) {
            tracing::info!(from = %holds.from.key(), instance = %holds.instance, op = ?holds.op, "holds message from a peer discovery does not know; ignored");
            return;
        }
        let at = Instant::now();
        let from = holds.from.key();
        let holdings = holds.holdings();
        match holds.op {
            Op::Add => {
                for arriving in holdings {
                    if self.meet(&holds, &arriving, true) {
                        self.record(&holds.from, arriving, at);
                    }
                }
            }
            // Only the current holder may withdraw an id: a displaced peer's late `remove` must not erase the winner.
            Op::Remove => {
                let mut remote = self.remote();
                for leaving in holdings {
                    if let Some(held) = remote.get_mut(&leaving.id) {
                        held.retain(|entry| {
                            !(entry.peer.key() == from && entry.holding.slot == leaving.slot)
                        });
                        if held.is_empty() {
                            remote.remove(&leaving.id);
                        }
                    }
                }
            }
            Op::Set => {
                self.remote().retain(|_, held| {
                    held.retain(|entry| entry.peer.key() != from);
                    !held.is_empty()
                });
                for arriving in holdings {
                    self.meet(&holds, &arriving, false);
                    self.record(&holds.from, arriving, at);
                }
            }
        }
    }

    // Applies what a peer's holding means for this machine's own of the same sandbox; answers whether to record the
    // peer as a holder. A full `set` (`displacing` false) only ever refuses a later copy, never displaces a tunnel.
    fn meet(self: &Arc<Self>, holds: &Holds, arriving: &Holding, displacing: bool) -> bool {
        let mut record = true;
        for slot in Slot::ALL {
            let Some(local) = self.registry.holding(&arriving.id, slot) else {
                continue;
            };
            let alive = self.registry.alive(&arriving.id, slot);
            match meets(&local, alive, arriving) {
                Meets::Displace if displacing => {
                    let reason = format!("displaced by a newer tunnel on {}", holds.instance);
                    let close = Close {
                        code: DISPLACED_CODE,
                        reason: reason.into(),
                    };
                    if self.registry.displace_slot(&arriving.id, slot, close) {
                        tracing::info!(sandbox = %arriving.id, ?slot, peer = %holds.from.key(), "local tunnel displaced by a newer one on a peer");
                    }
                }
                Meets::Displace => {
                    tracing::warn!(sandbox = %arriving.id, ?slot, peer = %holds.from.key(), "a peer also holds a tunnel this machine holds");
                }
                Meets::Refuse => {
                    let close = Close {
                        code: HELD_ELSEWHERE_CODE,
                        reason: tunnel::Identity::named_host(&arriving.host)
                            .to_owned()
                            .into(),
                    };
                    if self.registry.displace_slot(&arriving.id, slot, close) {
                        tracing::warn!(sandbox = %arriving.id, ?slot, peer = %holds.from.key(), holder = %arriving.host, "another copy of this sandbox registered first on a peer; refused the one here");
                    }
                }
                Meets::Stale if displacing => record = false,
                Meets::Incumbent => {
                    record = false;
                    tracing::warn!(sandbox = %arriving.id, ?slot, peer = %holds.from.key(), "a peer took a later copy of a sandbox this machine holds; telling it");
                    let telling = self.clone();
                    let answer = self.holds(Op::Add, Vec::new(), vec![local]);
                    let peer = holds.from.clone();
                    tokio::spawn(async move { telling.send(&peer, &answer).await });
                }
                Meets::Stale | Meets::Unrelated => {}
            }
        }
        record
    }

    fn record(&self, from: &Peer, holding: Holding, at: Instant) {
        let mut remote = self.remote();
        let held = remote.entry(holding.id.clone()).or_default();
        let key = from.key();
        held.retain(|entry| !(entry.peer.key() == key && entry.holding.slot == holding.slot));
        held.push(Remote {
            peer: from.clone(),
            at,
            holding,
        });
    }

    /// Expires what no peer refreshed and pushes this machine's whole list to every peer.
    pub async fn tick(&self) {
        if self.is_closed() {
            return;
        }
        let ttl = self.ttl;
        self.remote().retain(|_, held| {
            held.retain(|entry| entry.at.elapsed() <= ttl);
            !held.is_empty()
        });
        let holds = self.own();
        let peers: Vec<Peer> = self.peers.borrow().clone();
        futures_util::future::join_all(peers.iter().map(|peer| self.send(peer, &holds))).await;
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.remote().clear();
    }

    /// This machine's own list, as the internal surface answers a peer's greeting.
    pub fn own(&self) -> Holds {
        self.holds(Op::Set, self.registry.ids(), self.registry.holdings())
    }

    fn local_change(self: Arc<Self>, holding: &Holding, change: Change) {
        let op = match change {
            Change::Arrived => Op::Add,
            Change::Left => Op::Remove,
        };
        let ids = if holding.slot == Slot::Socket {
            vec![holding.id.clone()]
        } else {
            Vec::new()
        };
        let holds = self.holds(op, ids, vec![holding.clone()]);
        let peers: Vec<Peer> = self.peers.borrow().clone();
        for peer in peers {
            let cluster = self.clone();
            let holds = holds.clone();
            tokio::spawn(async move { cluster.send(&peer, &holds).await });
        }
    }

    fn holds(&self, op: Op, ids: Vec<String>, tunnels: Vec<Holding>) -> Holds {
        Holds {
            from: self.this.clone(),
            instance: self.instance.clone(),
            op,
            ids,
            tunnels,
        }
    }

    // Best effort: a failure only logs, since the next sync repeats the same fact.
    async fn send(&self, peer: &Peer, holds: &Holds) {
        if self.is_closed() || self.this.host.is_empty() {
            return;
        }
        let body = serde_json::to_vec(holds).expect("a holds message serializes");
        let request = Request::post(holds_url(peer))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from(body)))
            .expect("a holds request builds");
        match tokio::time::timeout(SEND_PATIENCE, self.client.request(request)).await {
            Ok(Ok(answer)) if answer.status().is_success() => {}
            Ok(Ok(answer)) => {
                tracing::warn!(peer = %peer.key(), op = ?holds.op, status = %answer.status(), "holds message refused")
            }
            Ok(Err(error)) => {
                tracing::warn!(peer = %peer.key(), op = ?holds.op, %error, "holds message failed")
            }
            Err(_) => tracing::warn!(peer = %peer.key(), op = ?holds.op, "holds message timed out"),
        }
    }

    fn knows(&self, peer: &Peer) -> bool {
        let key = peer.key();
        self.peers.borrow().iter().any(|known| known.key() == key)
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    fn remote(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Remote>>> {
        self.remote
            .lock()
            .expect("the cluster map is never poisoned")
    }
}

pub fn holds_url(peer: &Peer) -> String {
    format!("http://{}{HOLDS_PATH}", peer.address(peer.internal_port))
}

// Tells a newly seen peer what this machine holds and asks what it holds, without waiting for the next sync.
async fn greet(cluster: Arc<Cluster>, peer: Peer) {
    let own = cluster.own();
    let telling = cluster.clone();
    let told = peer.clone();
    tokio::spawn(async move { telling.send(&told, &own).await });
    let request = Request::get(holds_url(&peer))
        .body(Full::new(Bytes::new()))
        .expect("a holds request builds");
    let asked = tokio::time::timeout(SEND_PATIENCE, async {
        let answer = cluster.client.request(request).await.ok()?;
        if !answer.status().is_success() {
            return None;
        }
        let body = http_body_util::Limited::new(answer.into_body(), MAX_HOLDS_BYTES)
            .collect()
            .await
            .ok()?
            .to_bytes();
        serde_json::from_slice::<Holds>(&body)
            .ok()
            .filter(Holds::well_formed)
    })
    .await;
    match asked {
        Ok(Some(holds)) => cluster.receive(holds),
        _ => tracing::info!(peer = %peer.key(), "could not read a new peer's holds; the sync will"),
    }
}

// On every discovery change: entries of a machine that left go at once, and a machine that arrived is greeted.
async fn follow(cluster: Weak<Cluster>, mut peers: Peers) {
    let mut known: HashSet<String> = peers.borrow().iter().map(Peer::key).collect();
    while peers.changed().await.is_ok() {
        let Some(cluster) = cluster.upgrade() else {
            return;
        };
        if cluster.is_closed() {
            return;
        }
        let next: Vec<Peer> = peers.borrow_and_update().clone();
        let keys: HashSet<String> = next.iter().map(Peer::key).collect();
        cluster.remote().retain(|_, held| {
            held.retain(|entry| keys.contains(&entry.peer.key()));
            !held.is_empty()
        });
        for peer in next {
            if !known.contains(&peer.key()) {
                tokio::spawn(greet(cluster.clone(), peer));
            }
        }
        known = keys;
    }
}

/// The cluster's own surface, on the private port and never the public one: GET answers what this machine holds, POST
/// hears what a peer holds.
pub async fn internal(cluster: Arc<Cluster>, request: Request<Incoming>) -> Response<Body> {
    let path = request.uri().path();
    if path == "/health" {
        return json(
            StatusCode::OK,
            &serde_json::json!({ "status": "ok", "instance": cluster.instance }),
        );
    }
    if path != HOLDS_PATH {
        return json(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": "not an internal path" }),
        );
    }
    if request.method() == Method::GET {
        return json(StatusCode::OK, &cluster.own());
    }
    if request.method() != Method::POST {
        return json(
            StatusCode::METHOD_NOT_ALLOWED,
            &serde_json::json!({ "error": "GET or POST" }),
        );
    }
    let Ok(body) = http_body_util::Limited::new(request.into_body(), MAX_HOLDS_BYTES)
        .collect()
        .await
    else {
        return json(
            StatusCode::PAYLOAD_TOO_LARGE,
            &serde_json::json!({ "error": "holds message too large" }),
        );
    };
    let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&body.to_bytes()) else {
        return json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "error": "not json" }),
        );
    };
    let Some(holds) = serde_json::from_value::<Holds>(parsed)
        .ok()
        .filter(Holds::well_formed)
    else {
        return json(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "error": "not a holds message" }),
        );
    };
    cluster.receive(holds);
    json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

fn json(status: StatusCode, value: &impl Serialize) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body::full(
            serde_json::to_vec(value).expect("an answer serializes"),
        ))
        .expect("a JSON answer builds")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holding(slot: Slot, since: u64, instance: Option<&str>) -> Holding {
        Holding {
            id: "abcdef012345".into(),
            slot,
            since,
            instance: instance.map(str::to_owned),
            host: String::new(),
        }
    }

    // The 2026-10-05 cases: a delayed `add` displaced a newer local tunnel, and two copies of one sandbox each took it
    // from the other on whichever machine heard of the other last.
    #[test]
    fn a_peers_holding_is_ordered_against_this_machines_own() {
        let mine = holding(Slot::Socket, 1_000, Some("a1"));
        assert_eq!(
            meets(&mine, true, &holding(Slot::Socket, 2_000, Some("a1"))),
            Meets::Displace
        );
        assert_eq!(
            meets(&mine, true, &holding(Slot::Socket, 500, Some("a1"))),
            Meets::Stale
        );
        assert_eq!(
            meets(&mine, true, &holding(Slot::Quic, 2_000, Some("a1"))),
            Meets::Unrelated
        );
        // Two copies: the first to register holds it, whichever machine hears of the other.
        assert_eq!(
            meets(&mine, true, &holding(Slot::Socket, 500, Some("b2"))),
            Meets::Refuse
        );
        assert_eq!(
            meets(&mine, true, &holding(Slot::Quic, 2_000, Some("b2"))),
            Meets::Incumbent
        );
        let theirs = holding(Slot::Socket, 500, Some("b2"));
        assert_eq!(
            meets(&theirs, true, &mine),
            Meets::Incumbent,
            "the other machine agrees"
        );
        // A tie goes to the lower instance on both.
        assert_eq!(
            meets(
                &holding(Slot::Socket, 7, Some("b2")),
                true,
                &holding(Slot::Socket, 7, Some("a1"))
            ),
            Meets::Refuse
        );
        assert_eq!(
            meets(
                &holding(Slot::Socket, 7, Some("a1")),
                true,
                &holding(Slot::Socket, 7, Some("b2"))
            ),
            Meets::Incumbent
        );
        // A silent copy here is gone: the newer one takes its slot.
        assert_eq!(
            meets(&mine, false, &holding(Slot::Socket, 2_000, Some("b2"))),
            Meets::Displace
        );
        // An older peer's message is unordered, and newest-wins as it always was; so is a front naming no instance.
        assert_eq!(
            meets(&mine, true, &holding(Slot::Socket, UNORDERED, None)),
            Meets::Displace
        );
        assert_eq!(
            meets(
                &holding(Slot::Socket, 1_000, None),
                true,
                &holding(Slot::Socket, 900, Some("b2"))
            ),
            Meets::Stale
        );
    }

    #[test]
    fn an_older_peers_message_reads_as_socket_ids_and_a_newer_one_as_its_tunnels() {
        let older: Holds = serde_json::from_str(
            r#"{"from":{"host":"10.0.0.2","port":8080,"internalPort":8081},"instance":"m2","op":"add","ids":["abcdef012345"]}"#,
        )
        .unwrap();
        assert_eq!(older.holdings(), [holding(Slot::Socket, UNORDERED, None)]);
        let newer = Holds {
            tunnels: vec![holding(Slot::Quic, 5, Some("a1"))],
            ids: Vec::new(),
            ..older
        };
        let json = serde_json::to_string(&newer).unwrap();
        assert!(
            json.contains(
                r#""tunnels":[{"id":"abcdef012345","slot":"quic","since":5,"instance":"a1"}]"#
            ),
            "{json}"
        );
        let read: Holds = serde_json::from_str(&json).unwrap();
        assert_eq!(read.holdings(), [holding(Slot::Quic, 5, Some("a1"))]);
    }
}
