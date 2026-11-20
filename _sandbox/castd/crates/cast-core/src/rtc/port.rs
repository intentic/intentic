//! castd's one UDP port for every peer, and which peer each datagram is for. With full ICE it also asks STUN servers
//! which address the port is reached at from outside (its server-reflexive candidates), and routes the answers to a
//! peer's own checks back to that peer.

use super::{Ice, RtcConfig, stun};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, oneshot};

/// One datagram for a peer, with where it came from and when.
pub struct Datagram {
    pub source: SocketAddr,
    pub bytes: Vec<u8>,
    pub at: Instant,
}

/// How many datagrams may wait for a peer's task before more are dropped: a peer that stalled must not hold the reader,
/// and UDP was always allowed to lose them.
const PEER_QUEUE: usize = 1024;

/// The UDP port every peer shares, and which peer each datagram is for.
pub struct Service {
    pub(super) socket: Arc<UdpSocket>,
    /// Host candidates: where the port is published.
    pub(super) candidates: Vec<SocketAddr>,
    pub(super) ice: Ice,
    /// Server-reflexive candidates STUN servers named, each with its base (the host candidate it is the outside of).
    pub(super) reflexive: Mutex<Vec<(SocketAddr, SocketAddr)>>,
    routes: Mutex<Routes>,
    /// The port's own STUN requests still waiting for their answer, by transaction.
    asking: Mutex<HashMap<[u8; 12], oneshot::Sender<SocketAddr>>>,
}

/// What the port was started with: where viewers are told to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gathered {
    /// Host candidates, a port 0 made the one bound.
    pub host: Vec<SocketAddr>,
    /// Server-reflexive candidates STUN answered with (full ICE only).
    pub reflexive: Vec<SocketAddr>,
}

/// How long the port waits for a STUN server's answer, and how often it asks.
const STUN_WAIT: Duration = Duration::from_millis(500);
const STUN_TRIES: usize = 3;

#[derive(Default)]
struct Routes {
    by_ufrag: HashMap<String, mpsc::Sender<Datagram>>,
    by_source: HashMap<SocketAddr, String>,
}

static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

/// Binds `bind` and starts reading it; from now on `hello` offers a peer when `candidates` name somewhere to reach it.
/// Answers the candidates as viewers will be told them, a port 0 among them made the one bound. castd's ICE-lite.
pub async fn start(
    bind: SocketAddr,
    candidates: Vec<SocketAddr>,
) -> std::io::Result<Vec<SocketAddr>> {
    start_with(RtcConfig {
        bind,
        candidates,
        ice: Ice::Lite,
        stun: Vec::new(),
    })
    .await
    .map(|g| g.host)
}

/// Binds the port as `config` says. With full ICE and STUN servers, a host candidate of each server's address family
/// is made sure of (the address the route to that server leaves from, at the bound port, when none was named) and
/// each server is asked for the port's address outside: the answers are the server-reflexive candidates, based on that
/// host candidate. A server that does not answer is logged and left out.
pub async fn start_with(config: RtcConfig) -> std::io::Result<Gathered> {
    let socket = UdpSocket::bind(config.bind).await?;
    let bound = socket.local_addr()?;
    // A candidate given without knowing the port (the tests' `:0`) is the one bound.
    let mut candidates: Vec<SocketAddr> = config
        .candidates
        .into_iter()
        .map(|c| {
            if c.port() == 0 {
                SocketAddr::new(c.ip(), bound.port())
            } else {
                c
            }
        })
        .collect();
    let stun = if config.ice == Ice::Full {
        config.stun
    } else {
        Vec::new()
    };
    for server in &stun {
        if !candidates.iter().any(|c| c.is_ipv4() == server.is_ipv4())
            && let Some(base) = route_from(bound, *server)
        {
            candidates.push(base);
        }
    }
    let service = Arc::new(Service {
        socket: Arc::new(socket),
        candidates: candidates.clone(),
        ice: config.ice,
        reflexive: Mutex::new(Vec::new()),
        routes: Mutex::new(Routes::default()),
        asking: Mutex::new(HashMap::new()),
    });
    if SERVICE.set(service.clone()).is_err() {
        return Err(std::io::Error::other("castd's peer port is already open"));
    }
    tokio::spawn(service.clone().read());
    let mut reflexive: Vec<(SocketAddr, SocketAddr)> = Vec::new();
    for server in stun {
        let Some(base) = candidates
            .iter()
            .find(|c| c.is_ipv4() == server.is_ipv4())
            .copied()
        else {
            log::warn!("rtc: no host candidate to base what STUN server {server} says on");
            continue;
        };
        match service.ask(server).await {
            Ok(mapped) if !reflexive.iter().any(|(m, _)| *m == mapped) => {
                reflexive.push((mapped, base))
            }
            Ok(_) => {}
            Err(e) => log::warn!("rtc: STUN server {server}: {e}"),
        }
    }
    *service.reflexive.lock() = reflexive.clone();
    Ok(Gathered {
        host: candidates,
        reflexive: reflexive.into_iter().map(|(m, _)| m).collect(),
    })
}

/// The address a datagram from the port to `server` leaves from: the bound one when it names an address, else the
/// interface the route to `server` takes, at the bound port. None where there is no route.
fn route_from(bound: SocketAddr, server: SocketAddr) -> Option<SocketAddr> {
    if bound.is_ipv4() == server.is_ipv4() && !bound.ip().is_unspecified() {
        return Some(bound);
    }
    let any: SocketAddr = if server.is_ipv4() {
        "0.0.0.0:0".parse().ok()?
    } else {
        "[::]:0".parse().ok()?
    };
    // A connected UDP socket sends nothing; it only picks the route.
    let probe = std::net::UdpSocket::bind(any).ok()?;
    probe.connect(server).ok()?;
    Some(SocketAddr::new(probe.local_addr().ok()?.ip(), bound.port()))
}

pub(super) fn offered() -> bool {
    SERVICE
        .get()
        .is_some_and(|s| !s.candidates.is_empty() || !s.reflexive.lock().is_empty())
}

impl Service {
    pub(super) fn get() -> Option<Arc<Service>> {
        SERVICE.get().cloned()
    }

    async fn read(self: Arc<Self>) {
        let mut buf = vec![0u8; 2048];
        loop {
            let (n, source) = match self.socket.recv_from(&mut buf).await {
                Ok(read) => read,
                // An ICMP error for an earlier send surfaces on the next read on Linux; it ends nothing.
                Err(e) => {
                    log::debug!("rtc: reading the peer port: {e}");
                    continue;
                }
            };
            let bytes = &buf[..n];
            // The answer to one of the port's own STUN questions is no peer's.
            if let Some((transaction, mapped)) = stun::binding_success(bytes)
                && let Some(asked) = self.asking.lock().remove(&transaction)
            {
                let _ = asked.send(mapped);
                continue;
            }
            let target = {
                let mut routes = self.routes.lock();
                let known = routes
                    .by_source
                    .get(&source)
                    .and_then(|ufrag| routes.by_ufrag.get(ufrag))
                    .cloned();
                // A check names its peer, and a viewer whose address changed (another interface, a NAT rebinding) checks
                // again from the new one, which then routes there.
                match stun::local_ufrag(bytes) {
                    Some(ufrag) => match routes.by_ufrag.get(ufrag).cloned() {
                        Some(tx) => {
                            routes.by_source.insert(source, ufrag.to_string());
                            Some(tx)
                        }
                        None => known,
                    },
                    None => known,
                }
            };
            let Some(tx) = target else {
                continue;
            };
            let _ = tx.try_send(Datagram {
                source,
                bytes: bytes.to_vec(),
                at: Instant::now(),
            });
        }
    }

    /// Asks the STUN server `server` which address the port's datagrams arrive from.
    async fn ask(&self, server: SocketAddr) -> Result<SocketAddr, String> {
        let transaction = stun::transaction_id();
        let (tx, mut rx) = oneshot::channel();
        self.asking.lock().insert(transaction, tx);
        let request = stun::binding_request(transaction);
        let mut answer = Err(format!("no answer in {STUN_TRIES} tries"));
        for _ in 0..STUN_TRIES {
            if let Err(e) = self.socket.send_to(&request, server).await {
                answer = Err(format!("sending: {e}"));
                break;
            }
            if let Ok(Ok(mapped)) = tokio::time::timeout(STUN_WAIT, &mut rx).await {
                answer = Ok(mapped);
                break;
            }
        }
        self.asking.lock().remove(&transaction);
        answer
    }

    /// Full ICE sends checks of its own: what comes back from where a peer sent goes to that peer, as its datagrams
    /// from an address its viewer checked from do.
    pub(super) fn sent_to(&self, destination: SocketAddr, ufrag: &str) {
        self.routes
            .lock()
            .by_source
            .entry(destination)
            .or_insert_with(|| ufrag.to_string());
    }

    pub(super) fn register(&self, ufrag: &str) -> mpsc::Receiver<Datagram> {
        let (tx, rx) = mpsc::channel(PEER_QUEUE);
        self.routes.lock().by_ufrag.insert(ufrag.to_string(), tx);
        rx
    }

    pub(super) fn forget(&self, ufrag: &str) {
        let mut routes = self.routes.lock();
        routes.by_ufrag.remove(ufrag);
        routes.by_source.retain(|_, u| u != ufrag);
    }

    /// The candidate a datagram from `source` was sent to, as str0m must be told: behind a container's port publish
    /// castd sees its own address rather than the one the viewer sent to, so it is the first candidate of the
    /// source's family (each is the same port on another of the host's addresses).
    pub(super) fn destination_for(&self, source: SocketAddr) -> SocketAddr {
        self.candidates
            .iter()
            .find(|c| c.is_ipv4() == source.is_ipv4())
            .or(self.candidates.first())
            .copied()
            .unwrap_or(source)
    }
}
