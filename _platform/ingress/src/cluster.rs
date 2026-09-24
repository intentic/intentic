//! Which peer holds which sandbox's interactive tunnel, so a miss here goes to the machine that has it, once. A peer's
//! `add` displaces a local tunnel; a full `set` never does. Only peers discovery knows are heard, and an entry nobody
//! refreshes expires. `Holds` crosses between machines of different builds during a roll, so its shape only grows.

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

use crate::body::{self, Body};
use crate::grant::is_sandbox_id;
use crate::peers::{Peer, Peers};
use crate::registry::{Change, Registry, Slot};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holds {
    /// The sender as its peers reach it; heard only if discovery knows it.
    pub from: Peer,
    pub instance: String,
    pub op: Op,
    pub ids: Vec<String>,
}

impl Holds {
    fn well_formed(&self) -> bool {
        !self.from.host.is_empty()
            && self.from.port > 0
            && self.from.internal_port > 0
            && self.ids.iter().all(|id| is_sandbox_id(id))
    }
}

pub struct Cluster {
    instance: String,
    /// This machine as peers reach it; an empty host receives and routes but never advertises.
    this: Peer,
    peers: Peers,
    registry: Arc<Registry>,
    ttl: Duration,
    remote: Mutex<HashMap<String, (Peer, Instant)>>,
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
        cluster.registry.on_change(move |id, change| {
            if let Some(cluster) = told.upgrade() {
                cluster.local_change(id, change);
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

    /// The peer a locally unknown id is held by, if one claimed it and has kept claiming it.
    pub fn holder(&self, id: &str) -> Option<Peer> {
        let mut remote = self.remote();
        let (peer, at) = remote.get(id)?;
        if at.elapsed() > self.ttl {
            remote.remove(id);
            return None;
        }
        Some(peer.clone())
    }

    /// Stops trusting the current holder of `id`, which a forward found to be wrong.
    pub fn forget(&self, id: &str) {
        self.remote().remove(id);
    }

    pub fn remote_count(&self) -> usize {
        self.remote().len()
    }

    pub fn receive(&self, holds: Holds) {
        if self.is_closed() || !self.knows(&holds.from) {
            tracing::info!(from = %holds.from.key(), instance = %holds.instance, op = ?holds.op, "holds message from a peer discovery does not know; ignored");
            return;
        }
        let at = Instant::now();
        let from = holds.from.key();
        match holds.op {
            Op::Add => {
                for id in holds.ids {
                    if self.registry.displace(
                        &id,
                        format!("displaced by a newer tunnel on {}", holds.instance),
                    ) {
                        tracing::info!(sandbox = %id, peer = %from, "local tunnel displaced by a newer one on a peer");
                    }
                    self.remote().insert(id, (holds.from.clone(), at));
                }
            }
            // Only the current holder may withdraw an id: a displaced peer's late `remove` must not erase the winner.
            Op::Remove => {
                let mut remote = self.remote();
                for id in holds.ids {
                    if remote.get(&id).is_some_and(|(peer, _)| peer.key() == from) {
                        remote.remove(&id);
                    }
                }
            }
            Op::Set => {
                let mut remote = self.remote();
                remote.retain(|_, (peer, _)| peer.key() != from);
                for id in holds.ids {
                    if self.registry.lookup(&id, Slot::Interactive).is_some() {
                        tracing::warn!(sandbox = %id, peer = %from, "a peer also holds a tunnel this machine holds");
                    }
                    remote.insert(id, (holds.from.clone(), at));
                }
            }
        }
    }

    /// Expires what no peer refreshed and pushes this machine's whole list to every peer.
    pub async fn tick(&self) {
        if self.is_closed() {
            return;
        }
        let ttl = self.ttl;
        self.remote().retain(|_, (_, at)| at.elapsed() <= ttl);
        let holds = self.holds(Op::Set, self.registry.ids());
        let peers: Vec<Peer> = self.peers.borrow().clone();
        futures_util::future::join_all(peers.iter().map(|peer| self.send(peer, &holds))).await;
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.remote().clear();
    }

    /// This machine's own list, as the internal surface answers a peer's greeting.
    pub fn own(&self) -> Holds {
        self.holds(Op::Set, self.registry.ids())
    }

    fn local_change(self: Arc<Self>, id: &str, change: Change) {
        let op = match change {
            Change::Arrived => Op::Add,
            Change::Left => Op::Remove,
        };
        let holds = self.holds(op, vec![id.to_owned()]);
        let peers: Vec<Peer> = self.peers.borrow().clone();
        for peer in peers {
            let cluster = self.clone();
            let holds = holds.clone();
            tokio::spawn(async move { cluster.send(&peer, &holds).await });
        }
    }

    fn holds(&self, op: Op, ids: Vec<String>) -> Holds {
        Holds {
            from: self.this.clone(),
            instance: self.instance.clone(),
            op,
            ids,
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

    fn remote(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Peer, Instant)>> {
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
        cluster
            .remote()
            .retain(|_, (peer, _)| keys.contains(&peer.key()));
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
