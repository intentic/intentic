//! One server, two jobs: an upgrade to a tunnel door (`/tunnel/v2`, or the legacy `/tunnel/v1`) is a sandbox
//! registering, found by path since the edge's own name carries no id; anything else is a browser, routed by its host
//! per request, never per connection, since h2 coalesces names. A request rides its sandbox's tunnel here, else goes to
//! the peer holding it, else is refused with a verdict. A hosted sandbox is no exception: it is reached only down the
//! tunnel it dials, and one that dials nothing answers `no-tunnel`, which is what the editor wakes it on.
//!
//! One holder per sandbox (2026-10-05): a tunnel from a front of another instance than the live one holding the sandbox,
//! here or on a peer, is refused (409 naming where the holder runs, or `HELD_ELSEWHERE_CODE`). A held QUIC connection is
//! proven by a probe stream at registration and every `PROBE_EVERY`, takes requests only once proven, and is closed with
//! `DEMOTED_CODE` when a probe or a stalled request finds it serving nothing, the socket carrying on meanwhile. Every held
//! sandbox's existence is asked again as its cached answer expires, and one the platform deleted is closed with
//! `DELETED_CODE`, rather than staying reachable until its front happened to redial.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

pub use browser_wire::{EdgeVerdict as Verdict, VERDICT_HEADER};
use futures_util::StreamExt;
use http::header::{self, HeaderValue};
use http::uri::PathAndQuery;
use http::{Method, Request, Response, StatusCode};
use hyper::upgrade::Upgraded;
use hyper_util::rt::{TokioExecutor, TokioIo};
use relay::{host_of, is_upgrade, label_of};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tunnel::{
    BULK_HEADER, BulkRoutes, CONNECTION_WINDOW, Close, DELETED_CODE, DEMOTED_CODE, Ended,
    GRANT_HEADER, HELD_ELSEWHERE_CODE, HOLDER_HEADER, HOST_HEADER, Heard, INSTANCE_HEADER,
    Identity, LANE_HEADER, Lane, Liveness, PROBE_EVERY, PROBE_PATIENCE, STREAM_WINDOW,
    TRANSPORTS_HEADER, TUNNEL_PATH, Transport, host_owner_id, mux,
};

use crate::body::{self, Body};
use crate::cluster::{Cluster, HOP_HEADER};
use crate::forward::{ForwardError, Forwarder};
use crate::grant::GrantKey;
use crate::legacy;
use crate::peers::Peers;
use crate::registry::{Elsewhere, Held, Holder, Registry, Slot};
use crate::revocation::Revocation;
use crate::session::{Failed, Session};

// A QUIC connection that has not said who it is by now never will.
const HELLO_PATIENCE: Duration = Duration::from_secs(10);

// A front acknowledges a `Held` the moment it reads it; one that has not by now gave up on this connection.
const ACKNOWLEDGED_WITHIN: Duration = Duration::from_secs(5);

// A refused socket's close frame gets this long to leave before the connection goes.
const REFUSAL_GRACE: Duration = Duration::from_secs(2);

/// How many held sandboxes' existence is asked of the platform at once when their cached answers expire: thousands of
/// tunnels must not become thousands of simultaneous requests.
pub const RECHECK_AT_ONCE: usize = 8;

pub struct EdgeOptions {
    pub key: GrantKey,
    pub revocation: Revocation,
    pub registry: Arc<Registry>,
    /// Where a locally unknown sandbox may be found; `None` is one machine, where a miss is final.
    pub cluster: Option<Arc<Cluster>>,
    /// For `/health` only: how many other machines this one knows of.
    pub peers: Option<Peers>,
    pub instance: String,
    /// Which image this process is, baked at build; empty is an unreleased build.
    pub build: String,
    /// What this edge serves beyond HTTPS over TCP, because its own configuration binds it: declared to every front on
    /// its tunnel's answer and to everyone else on `/health`, so nothing has to find out by failing.
    pub transports: Vec<Transport>,
}

pub struct Edge {
    key: GrantKey,
    revocation: Revocation,
    registry: Arc<Registry>,
    cluster: Option<Arc<Cluster>>,
    peers: Option<Peers>,
    forwarder: Forwarder,
    instance: String,
    build: String,
    transports: Vec<Transport>,
}

impl Edge {
    pub fn new(options: EdgeOptions) -> Arc<Self> {
        Arc::new(Self {
            key: options.key,
            revocation: options.revocation,
            registry: options.registry,
            cluster: options.cluster,
            peers: options.peers,
            forwarder: Forwarder::default(),
            instance: options.instance,
            build: options.build,
            transports: options.transports,
        })
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.registry
    }

    pub async fn handle(
        self: Arc<Self>,
        request: Request<Body>,
        remote: SocketAddr,
    ) -> Response<Body> {
        let upgrade = is_upgrade(request.headers(), request.version());
        if upgrade && let Some(door) = Door::at(&request) {
            return self.accept_tunnel(request, door, remote).await;
        }
        let host = host_of(&request);
        let Some(id) = host_owner_id(&host).map(str::to_owned) else {
            if upgrade {
                return refused(StatusCode::NOT_FOUND, "no sandbox is named by this address");
            }
            return self.serve_own(&request);
        };
        let hop = request.headers().contains_key(HOP_HEADER);
        if let Some((session, slot)) = self.session_for(&id, &host, &request, true) {
            let mut request = request;
            request.headers_mut().remove(HOP_HEADER);
            return self
                .through(&id, &host, session, slot, request, upgrade)
                .await;
        }
        let holder = if hop {
            None
        } else {
            self.cluster
                .as_ref()
                .and_then(|cluster| cluster.holder(&id))
        };
        if let Some(peer) = holder {
            let forwarded = if upgrade {
                self.forwarder
                    .upgrade(&peer, request, &host, remote.ip())
                    .await
            } else {
                self.forwarder
                    .request(&peer, request, &host, remote.ip())
                    .await
            };
            return forwarded.unwrap_or_else(|error| {
                if let ForwardError::Unreachable(why) = &error
                    && let Some(cluster) = &self.cluster
                {
                    cluster.forget(&id);
                    tracing::info!(sandbox = %id, peer = %peer.key(), %why, "peer unreachable; forgetting it as the holder");
                }
                if upgrade {
                    refused_upgrade(Verdict::NoTunnel, &sentence(Verdict::NoTunnel, label_of(&host)))
                } else {
                    unreachable(&host, Verdict::NoTunnel)
                }
            });
        }
        let verdict = self.miss(&id, hop).await;
        if upgrade {
            return refused_upgrade(verdict, &sentence(verdict, label_of(&host)));
        }
        if is_cors_preflight(&request) {
            return preflight(verdict);
        }
        unreachable(&host, verdict)
    }

    // The QUIC connection while it holds and was proven, whose streams never queue behind each other; else the
    // interactive socket, unless the daemon announced the request as a transfer (or it is a preview's) and the bulk
    // socket is held.
    fn session_for(
        &self,
        id: &str,
        host: &str,
        request: &Request<Body>,
        quic: bool,
    ) -> Option<(Session, Slot)> {
        if quic && let Some(quic) = self.registry.lookup(id, Slot::Quic) {
            return Some((quic, Slot::Quic));
        }
        let socket = self.registry.lookup(id, Slot::Socket);
        let bulk = self.registry.lookup(id, Slot::Bulk);
        let path = request
            .uri()
            .path_and_query()
            .map_or("/", PathAndQuery::as_str);
        let transfer = socket
            .as_ref()
            .or(bulk.as_ref())
            .is_some_and(|held| held.carries_bulk(host, request.method().as_str(), path));
        if transfer && let Some(bulk) = bulk {
            return Some((bulk, Slot::Bulk));
        }
        socket.map(|socket| (socket, Slot::Socket))
    }

    // One exchange down a held tunnel. A QUIC carrier that stalled on it is demoted (closed, its front redialling it) and
    // the request, when it can be sent again, rides the socket instead, once.
    async fn through(
        &self,
        id: &str,
        host: &str,
        session: Session,
        slot: Slot,
        request: Request<Body>,
        upgrade: bool,
    ) -> Response<Body> {
        let (why, again) = match session.send(request, host).await {
            Ok(answer) => return answer,
            Err(Failed::Dropped(dropped)) => (dropped.0, None),
            Err(Failed::Stalled { why, request }) => {
                let demoted = slot == Slot::Quic
                    && self.registry.close_if(
                        id,
                        Slot::Quic,
                        &session,
                        Close {
                            code: DEMOTED_CODE,
                            reason: "a request stalled on it".into(),
                        },
                    );
                if demoted {
                    tracing::warn!(sandbox = %id, %why, "demoted a QUIC tunnel that stalled a request; the socket carries it");
                }
                (why, request)
            }
        };
        if let Some(request) = again
            && let Some((socket, _)) = self.session_for(id, host, &request, false)
        {
            match socket.exchange(*request, host).await {
                Ok(answer) => return answer,
                Err(dropped) => {
                    tracing::debug!(sandbox = %id, why = %dropped.0, "the socket dropped a request QUIC stalled on");
                }
            }
        }
        tracing::debug!(sandbox = %id, upgrade, %why, "an exchange through a held tunnel failed");
        if upgrade {
            refused_upgrade(
                Verdict::Dropped,
                &format!("{} dropped the connection.", label_of(host)),
            )
        } else {
            unreachable(host, Verdict::Dropped)
        }
    }

    // Whether another live copy holds `id`, here or on a peer: a front naming no instance never asks.
    fn held_elsewhere(&self, id: &str, identity: Option<&Identity>) -> Option<Elsewhere> {
        self.registry.held_elsewhere(id, identity).or_else(|| {
            self.cluster
                .as_ref()
                .and_then(|cluster| cluster.held_elsewhere(id, identity))
        })
    }

    /// Asks the platform again, every `every`, whether each sandbox held here still exists, `RECHECK_AT_ONCE` at a
    /// time; the revocation cache asks only for answers that expired. One the platform deleted has every tunnel closed
    /// with `DELETED_CODE`, and its front stops dialling. Before 2026-10-05 existence was asked only at registration,
    /// so a deleted sandbox stayed reachable until its front happened to redial.
    pub fn recheck_held(self: &Arc<Self>, every: Duration) {
        if !self.revocation.enforced() {
            return;
        }
        let edge = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                let Some(edge) = edge.upgrade() else {
                    return;
                };
                edge.recheck_once().await;
            }
        });
    }

    /// One pass of `recheck_held`; answers how many sandboxes it closed.
    pub async fn recheck_once(&self) -> usize {
        let held = self.registry.held_ids();
        let deleted = std::sync::atomic::AtomicUsize::new(0);
        futures_util::stream::iter(held)
            .for_each_concurrent(RECHECK_AT_ONCE, |id| {
                let deleted = &deleted;
                async move {
                    if self.revocation.allows(&id).await {
                        return;
                    }
                    let close = Close {
                        code: DELETED_CODE,
                        reason: "this sandbox was deleted".into(),
                    };
                    let closed = self.registry.close_id(&id, &close);
                    if closed > 0 {
                        deleted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        tracing::info!(sandbox = %id, closed, "closed the tunnels of a sandbox the platform deleted");
                    }
                }
            })
            .await;
        deleted.into_inner()
    }

    // Which verdict a miss answers: a sandbox the platform no longer knows is gone, any other is not connected, hosted or
    // not. A hop-marked miss asks nothing, since the peer that sent it believed a tunnel was held and the 502 is what
    // lets it forget.
    async fn miss(&self, id: &str, hop: bool) -> Verdict {
        if hop || self.revocation.allows(id).await {
            Verdict::NoTunnel
        } else {
            Verdict::UnknownSandbox
        }
    }

    // A host naming no sandbox: `/health` for a load balancer, the door's own name, else a stray subdomain.
    fn serve_own(&self, request: &Request<Body>) -> Response<Body> {
        match request.uri().path() {
            "/health" => {
                let health = serde_json::json!({
                    "status": "ok",
                    "tunnels": self.registry.size(),
                    "instance": self.instance,
                    "peers": self.peers.as_ref().map_or(0, |peers| peers.borrow().len()),
                    "remote": self.cluster.as_ref().map_or(0, |cluster| cluster.remote_count()),
                    "build": self.build,
                    "transports": self.transports.iter().map(|transport| transport.token()).collect::<Vec<_>>(),
                    // Which tunnel doors this build serves, so nothing publishes a front ahead of the edge it dials
                    // (require-edge-door.sh). Not `tunnels`, which has always been the count.
                    "doors": [legacy::PATH, TUNNEL_PATH],
                });
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::CACHE_CONTROL, "no-store")
                    .body(body::full(health.to_string()))
                    .expect("the health answer builds")
            }
            TUNNEL_PATH | legacy::PATH => {
                let mut response = text(
                    StatusCode::UPGRADE_REQUIRED,
                    "the tunnel door takes a websocket upgrade",
                );
                response
                    .headers_mut()
                    .insert(header::UPGRADE, HeaderValue::from_static("websocket"));
                response
            }
            _ => text(StatusCode::NOT_FOUND, "no sandbox is named by this address"),
        }
    }

    // Two gates in order: the signature is free and refuses a stranger before the platform is ever asked, then the
    // existence check, a round trip, for a caller that already proved who it is.
    async fn accept_tunnel(
        self: Arc<Self>,
        mut request: Request<Body>,
        door: Door,
        remote: SocketAddr,
    ) -> Response<Body> {
        let grant = request
            .headers()
            .get(GRANT_HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|grant| !grant.is_empty());
        let Some(claim) = grant.and_then(|grant| self.key.verify(grant)) else {
            tracing::info!(%remote, "tunnel refused: no valid reachability grant");
            return refused(
                StatusCode::UNAUTHORIZED,
                "a tunnel presents a reachability grant",
            );
        };
        if !self.revocation.allows(&claim.sandbox_id).await {
            tracing::info!(sandbox = %claim.sandbox_id, "tunnel refused: the platform says this sandbox is gone");
            // The verdict tells a front this is a deletion, after which it stops dialling.
            return with_verdict(
                refused(StatusCode::FORBIDDEN, "that sandbox no longer exists"),
                Verdict::UnknownSandbox,
            );
        }
        let header = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
        };
        let identity = Identity::of_headers(header(INSTANCE_HEADER), header(HOST_HEADER));
        if let Some(elsewhere) = self.held_elsewhere(&claim.sandbox_id, identity.as_ref()) {
            tracing::info!(
                sandbox = %claim.sandbox_id,
                instance = ?identity.as_ref().map(|identity| &identity.instance),
                holder = %elsewhere.instance,
                holder_host = %elsewhere.host,
                "tunnel refused: another copy of this sandbox holds it"
            );
            return held_by_another(&elsewhere);
        }
        let Some(accept) = websocket_accept(&request) else {
            return refused(
                StatusCode::BAD_REQUEST,
                "the tunnel door takes a websocket upgrade",
            );
        };
        let upgrading = hyper::upgrade::on(&mut request);
        let edge = self.clone();
        tokio::spawn(async move {
            match upgrading.await {
                Ok(upgraded) => edge.hold(claim.sandbox_id, door, identity, upgraded).await,
                Err(error) => tracing::debug!(%error, "a tunnel's upgrade never completed"),
            }
        });
        let mut switching = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_ACCEPT, accept);
        if !self.transports.is_empty() {
            switching = switching.header(TRANSPORTS_HEADER, Transport::declare(&self.transports));
        }
        switching.body(body::empty()).expect("a 101 builds")
    }

    /// Holds a front's QUIC connection as its sandbox's carrier: the hello's grant is checked as a WebSocket's is, a
    /// front of another instance than the live holder is refused, and a named front's acknowledgement is waited for
    /// before the connection is registered. Proven by a probe at once and every `PROBE_EVERY`, it takes requests from its
    /// first answered probe and is closed with `DEMOTED_CODE` at its first unanswered one; else it is closed with the
    /// code a displacement, a deletion or a shutdown names.
    pub async fn hold_quic(self: Arc<Self>, connection: quinn::Connection) {
        let remote = connection.remote_address();
        let Ok(Ok(introduction)) =
            tokio::time::timeout(HELLO_PATIENCE, tunnel::quic::introduced(&connection)).await
        else {
            connection.close(quinn::VarInt::from_u32(0), b"no hello");
            return;
        };
        let identity = introduction.identity.clone();
        let refusal = match self.key.verify(&introduction.grant) {
            None => Err((tunnel::quic::Hello::Refused, None)),
            Some(claim) if !self.revocation.allows(&claim.sandbox_id).await => {
                Err((tunnel::quic::Hello::Gone, Some(claim.sandbox_id)))
            }
            Some(claim) => Ok(claim),
        };
        let claim = match refusal {
            Ok(claim) => claim,
            Err((hello, sandbox)) => {
                tracing::info!(%remote, ?sandbox, ?hello, "QUIC tunnel refused");
                let _ = tokio::time::timeout(
                    HELLO_PATIENCE,
                    introduction.answer(hello, ACKNOWLEDGED_WITHIN),
                )
                .await;
                connection.close(tunnel::quic::REFUSED, b"refused");
                return;
            }
        };
        let id = claim.sandbox_id;
        if let Some(elsewhere) = self.held_elsewhere(&id, identity.as_ref()) {
            tracing::info!(sandbox = %id, %remote, holder = %elsewhere.instance, holder_host = %elsewhere.host, "QUIC tunnel refused: another copy of this sandbox holds it");
            let named = Identity::named_host(&elsewhere.host).to_owned();
            let _ = tokio::time::timeout(HELLO_PATIENCE, introduction.held_elsewhere(&named)).await;
            connection.close(tunnel::quic::HELD_ELSEWHERE, named.as_bytes());
            return;
        }
        match introduction
            .answer(tunnel::quic::Hello::Held, ACKNOWLEDGED_WITHIN)
            .await
        {
            Ok(true) => {}
            _ => {
                tracing::info!(sandbox = %id, %remote, "QUIC tunnel not registered: its front did not acknowledge the hello");
                connection.close(quinn::VarInt::from_u32(0), b"no acknowledgement");
                return;
            }
        }
        let (closing, mut closed) = watch::channel(None);
        let session = Session::quic(connection.clone());
        let heard = Arc::new(Heard::default());
        let holder = Holder::proving(identity, heard.clone());
        let ready = holder.ready.clone();
        let admitted = self.registry.admit(
            &id,
            Slot::Quic,
            Held {
                session: session.clone(),
                closing,
            },
            holder,
        );
        let displaced = match admitted {
            Ok(displaced) => displaced,
            Err(elsewhere) => {
                let named = Identity::named_host(&elsewhere.host).to_owned();
                tracing::info!(sandbox = %id, %remote, holder = %elsewhere.instance, "QUIC tunnel refused: another copy of this sandbox took it first");
                connection.close(tunnel::quic::HELD_ELSEWHERE, named.as_bytes());
                return;
            }
        };
        tracing::info!(sandbox = %id, displaced, %remote, "QUIC tunnel registered");
        let probing = connection.clone();
        let proven = heard.clone();
        let probes = async move {
            loop {
                match tokio::time::timeout(PROBE_PATIENCE, tunnel::quic::probe(&probing)).await {
                    Ok(Ok(())) => {
                        proven.answer();
                        ready.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    Ok(Err(error)) => return format!("a probe failed: {error}"),
                    Err(_) => return format!("a probe went unanswered for {PROBE_PATIENCE:?}"),
                }
                tokio::time::sleep(PROBE_EVERY).await;
            }
        };
        let ended = tokio::select! {
            error = connection.closed() => error.to_string(),
            why = probes => {
                connection.close(tunnel::quic::DEMOTED, why.as_bytes());
                tracing::warn!(sandbox = %id, %why, "demoted a QUIC tunnel that serves no probe; the socket carries it");
                format!("demoted: {why}")
            }
            close = tunnel::raised(&mut closed) => {
                connection.close(quinn::VarInt::from_u32(u32::from(close.code)), close.reason.as_bytes());
                format!("closed here: {}", close.reason)
            }
        };
        self.registry.unregister(&id, Slot::Quic, &session);
        tracing::info!(sandbox = %id, %ended, "QUIC tunnel closed");
    }

    // Holds a registered tunnel for as long as its WebSocket lives; every way it can end (a close, a silent peer, a
    // displacement, the session failing) ends the pump, and one teardown follows, so the registry never keeps a dead one.
    async fn hold(
        self: Arc<Self>,
        id: String,
        door: Door,
        identity: Option<Identity>,
        upgraded: Upgraded,
    ) {
        let socket = WebSocketStream::from_raw_socket(
            TokioIo::new(upgraded),
            Role::Server,
            Some(tunnel::socket_config()),
        )
        .await;
        let (closing, closed) = watch::channel(None);
        let (session_side, mut pumping) = tunnel::pump(socket, door.liveness(), closed);
        let (session, mut driving) = match &door {
            Door::Mux(_, routes) => {
                let (opener, driving) = mux::client(session_side);
                (Session::mux(opener, routes.clone()), Driving::Mux(driving))
            }
            Door::Legacy(_) => {
                let opened = hyper::client::conn::http2::Builder::new(TokioExecutor::new())
                    .initial_stream_window_size(STREAM_WINDOW)
                    .initial_connection_window_size(CONNECTION_WINDOW)
                    .handshake(TokioIo::new(session_side))
                    .await;
                match opened {
                    Ok((sender, connection)) => (
                        Session::legacy(sender),
                        Driving::H2(tokio::spawn(connection)),
                    ),
                    Err(error) => {
                        tracing::warn!(sandbox = %id, %error, "a legacy tunnel failed to open a session");
                        return;
                    }
                }
            }
        };
        let slot = door.slot();
        let refusing = closing.clone();
        let admitted = self.registry.admit(
            &id,
            slot,
            Held {
                session: session.clone(),
                closing,
            },
            Holder::new(identity, pumping.heard()),
        );
        let displaced = match admitted {
            Ok(displaced) => displaced,
            // Another copy registered between this one's upgrade and now.
            Err(elsewhere) => {
                tracing::info!(sandbox = %id, door = door.name(), holder = %elsewhere.instance, "tunnel refused: another copy of this sandbox took it first");
                refusing.send_replace(Some(Close {
                    code: HELD_ELSEWHERE_CODE,
                    reason: Identity::named_host(&elsewhere.host).to_owned().into(),
                }));
                let _ = tokio::time::timeout(REFUSAL_GRACE, pumping.ended()).await;
                driving.abort();
                return;
            }
        };
        tracing::info!(sandbox = %id, door = door.name(), displaced, tunnels = self.registry.size(), "tunnel registered");
        let ended = tokio::select! {
            ended = pumping.ended() => ended,
            why = driving.ended() => Ended::Dropped(why),
        };
        driving.abort();
        self.registry.unregister(&id, slot, &session);
        tracing::info!(sandbox = %id, door = door.name(), ?ended, tunnels = self.registry.size(), "tunnel closed");
    }
}

/// Which tunnel door an upgrade knocked on, and on which lane.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Door {
    /// `/tunnel/v2`: a WebSocket carrying yamux, and the transfer routes its front announced.
    Mux(Lane, BulkRoutes),
    /// `/tunnel/v1`: a legacy front's lane, an h2 session.
    Legacy(Lane),
}

impl Door {
    fn at(request: &Request<Body>) -> Option<Self> {
        let header = |name| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
        };
        let lane = Lane::named(header(LANE_HEADER));
        match request.uri().path() {
            TUNNEL_PATH => Some(Self::Mux(
                lane,
                BulkRoutes::parse(header(BULK_HEADER).unwrap_or("")),
            )),
            legacy::PATH => Some(Self::Legacy(lane)),
            _ => None,
        }
    }

    fn lane(&self) -> Lane {
        match self {
            Self::Mux(lane, _) | Self::Legacy(lane) => *lane,
        }
    }

    // Who keeps the socket alive. A `/tunnel/v2` front always pings, so the edge only listens. A `/tunnel/v1` front
    // may predate that one-sided rule: some never ping and only answer the edge's pings, and an edge that stopped
    // pinging dropped them for silence every `DEAD_AFTER` (each drop cutting that sandbox's terminals and streams).
    fn liveness(&self) -> Liveness {
        match self {
            Self::Mux(..) => Liveness::Listens,
            Self::Legacy(_) => Liveness::Pings,
        }
    }

    // Either door's interactive lane is the sandbox's home, so a front moving between doors displaces its own older one.
    fn slot(&self) -> Slot {
        match self.lane() {
            Lane::Interactive => Slot::Socket,
            Lane::Bulk => Slot::Bulk,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Mux(Lane::Interactive, _) => "v2 interactive",
            Self::Mux(Lane::Bulk, _) => "v2 bulk",
            Self::Legacy(Lane::Interactive) => "v1 interactive",
            Self::Legacy(Lane::Bulk) => "v1 bulk",
        }
    }
}

// The task running a held tunnel's session, and how it ended.
enum Driving {
    Mux(mux::Driving),
    H2(JoinHandle<hyper::Result<()>>),
}

impl Driving {
    async fn ended(&mut self) -> String {
        match self {
            Self::Mux(driving) => match driving.await {
                Ok(Ok(())) => "the session ended".into(),
                Ok(Err(error)) => format!("the session failed: {error}"),
                Err(error) => error.to_string(),
            },
            Self::H2(driving) => match driving.await {
                Ok(Ok(())) => "the h2 session ended".into(),
                Ok(Err(error)) => format!("the h2 session failed: {error}"),
                Err(error) => error.to_string(),
            },
        }
    }

    fn abort(&self) {
        match self {
            Self::Mux(driving) => driving.abort(),
            Self::H2(driving) => driving.abort(),
        }
    }
}

/// Tells a browser answered over TCP where HTTP/3 reaches this edge; an answer naming its own is left as the sandbox sent it.
pub fn advertise(mut response: Response<Body>, alt_svc: Option<&HeaderValue>) -> Response<Body> {
    if let Some(alt_svc) = alt_svc {
        response
            .headers_mut()
            .entry(header::ALT_SVC)
            .or_insert_with(|| alt_svc.clone());
    }
    response
}

fn websocket_accept(request: &Request<Body>) -> Option<String> {
    let headers = request.headers();
    let upgrade = headers.get(header::UPGRADE)?.to_str().ok()?;
    let version = headers.get(header::SEC_WEBSOCKET_VERSION)?;
    let key = headers.get(header::SEC_WEBSOCKET_KEY)?;
    (request.method() == Method::GET
        && upgrade.eq_ignore_ascii_case("websocket")
        && version == "13")
        .then(|| derive_accept_key(key.as_bytes()))
}

// A CORS preflight must be answered 2xx or the request behind it is never sent, and that request carries the verdict.
fn is_cors_preflight(request: &Request<Body>) -> bool {
    request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
}

// The one edge error a person meets, in a terminal as often as in a browser.
fn sentence(verdict: Verdict, label: &str) -> String {
    match verdict {
        Verdict::UnknownSandbox => format!("{label} no longer exists."),
        Verdict::NoTunnel | Verdict::Dropped => format!("{label} is not connected right now."),
    }
}

// The edge's own errors are readable by any origin: one constant sentence each, no credential ever accepted on them,
// nothing per-reader, so `*` discloses nothing a stranger could not get by dialling the name.
fn with_verdict(mut response: Response<Body>, verdict: Verdict) -> Response<Body> {
    let headers = response.headers_mut();
    headers.insert(VERDICT_HEADER, HeaderValue::from_static(verdict.name()));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(VERDICT_HEADER),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("60"),
    );
    response
}

// 502 rather than 404: the browser's availability flow reads any 5xx as unreachable and wakes the box, and the verdict
// header says which kind.
fn unreachable(host: &str, verdict: Verdict) -> Response<Body> {
    let mut response = text(StatusCode::BAD_GATEWAY, &sentence(verdict, label_of(host)));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    with_verdict(response, verdict)
}

// A preflight for a request about to be refused is admitted: it promises nothing, and the refusal it unlocks is readable.
fn preflight(verdict: Verdict) -> Response<Body> {
    let mut response = Response::new(body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    with_verdict(response, verdict)
}

// A refused upgrade carries the same verdict; a browser cannot read a failed handshake, so this is for the next request
// and for a terminal held open against the box.
fn refused_upgrade(verdict: Verdict, sentence: &str) -> Response<Body> {
    with_verdict(refused(StatusCode::BAD_GATEWAY, sentence), verdict)
}

// A tunnel another live copy of its sandbox holds: 409, naming where that copy runs for the refused front to say.
fn held_by_another(elsewhere: &Elsewhere) -> Response<Body> {
    let named = Identity::named_host(&elsewhere.host);
    let mut response = refused(
        StatusCode::CONFLICT,
        &format!("another copy of this sandbox holds its tunnel, on {named}"),
    );
    if let Ok(holder) = HeaderValue::from_str(&elsewhere.host) {
        response.headers_mut().insert(HOLDER_HEADER, holder);
    }
    response
}

// An answer to an upgrade that is not taken, closing the connection since no keep-alive follows one.
fn refused(status: StatusCode, sentence: &str) -> Response<Body> {
    let mut response = text(status, sentence);
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

fn text(status: StatusCode, sentence: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body::full(format!("{sentence}\n")))
        .expect("a plain answer builds")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_edge_pings_legacy_fronts_and_leaves_v2_fronts_to_ping_it() {
        assert_eq!(Door::Legacy(Lane::Interactive).liveness(), Liveness::Pings);
        assert_eq!(
            Door::Mux(Lane::Interactive, BulkRoutes::parse("")).liveness(),
            Liveness::Listens
        );
    }

    #[test]
    fn http_3_is_advertised_unless_the_sandbox_named_its_own() {
        let value = HeaderValue::from_static("h3=\":443\"; ma=86400");
        let answered = advertise(text(StatusCode::OK, "hi"), Some(&value));
        assert_eq!(answered.headers()[header::ALT_SVC], value);
        let mut own = text(StatusCode::OK, "hi");
        own.headers_mut()
            .insert(header::ALT_SVC, HeaderValue::from_static("clear"));
        assert_eq!(
            advertise(own, Some(&value)).headers()[header::ALT_SVC],
            "clear"
        );
        assert!(
            advertise(text(StatusCode::OK, "hi"), None)
                .headers()
                .get(header::ALT_SVC)
                .is_none()
        );
    }
}
