//! castd's one UDP port for every peer, and which peer each datagram is for.

use super::stun;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

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
    pub(super) candidates: Vec<SocketAddr>,
    routes: Mutex<Routes>,
}

#[derive(Default)]
struct Routes {
    by_ufrag: HashMap<String, mpsc::Sender<Datagram>>,
    by_source: HashMap<SocketAddr, String>,
}

static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

/// Binds `bind` and starts reading it; from now on `hello` offers a peer when `candidates` name somewhere to reach it.
/// Answers the candidates as viewers will be told them, a port 0 among them made the one bound.
pub async fn start(
    bind: SocketAddr,
    candidates: Vec<SocketAddr>,
) -> std::io::Result<Vec<SocketAddr>> {
    let socket = UdpSocket::bind(bind).await?;
    let bound = socket.local_addr()?;
    // A candidate given without knowing the port (the tests' `:0`) is the one bound.
    let candidates: Vec<SocketAddr> = candidates
        .into_iter()
        .map(|c| {
            if c.port() == 0 {
                SocketAddr::new(c.ip(), bound.port())
            } else {
                c
            }
        })
        .collect();
    let service = Arc::new(Service {
        socket: Arc::new(socket),
        candidates: candidates.clone(),
        routes: Mutex::new(Routes::default()),
    });
    if SERVICE.set(service.clone()).is_err() {
        return Err(std::io::Error::other("castd's peer port is already open"));
    }
    tokio::spawn(service.read());
    Ok(candidates)
}

pub(super) fn offered() -> bool {
    SERVICE.get().is_some_and(|s| !s.candidates.is_empty())
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
