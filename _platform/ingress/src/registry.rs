//! Which tunnel serves which sandbox on this machine, per slot, and nothing else. A newer tunnel for an id and slot takes
//! it and closes the older with `DISPLACED_CODE`, whose teardown then cannot evict it. Only the socket slot is the
//! sandbox's home in the cluster, so only its arrivals and departures are the cluster's news.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tokio::sync::watch;
use tunnel::{Close, DISPLACED_CODE};

use crate::session::Session;

/// A held tunnel: the session requests ride, and what asks its WebSocket to close.
pub struct Held {
    pub session: Session,
    pub closing: watch::Sender<Option<Close>>,
}

/// Where a tunnel is held: the interactive socket every front dials first (`/tunnel/v2`, or a legacy front's interactive
/// lane, either one the sandbox's home in the cluster), the bulk socket beside it, or the QUIC connection that carries
/// every request while it lasts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Socket,
    Bulk,
    Quic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Arrived,
    Left,
}

type Listener = Box<dyn Fn(&str, Change) + Send + Sync>;

#[derive(Default)]
pub struct Registry {
    held: Mutex<Slots>,
    listener: OnceLock<Listener>,
}

#[derive(Default)]
struct Slots {
    socket: HashMap<String, Held>,
    bulk: HashMap<String, Held>,
    quic: HashMap<String, Held>,
}

impl Slots {
    fn of(&mut self, slot: Slot) -> &mut HashMap<String, Held> {
        match slot {
            Slot::Socket => &mut self.socket,
            Slot::Bulk => &mut self.bulk,
            Slot::Quic => &mut self.quic,
        }
    }
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Who hears a socket tunnel arrive or leave; set once, before the first tunnel registers.
    pub fn on_change(&self, listener: impl Fn(&str, Change) + Send + Sync + 'static) {
        let _ = self.listener.set(Box::new(listener));
    }

    /// Takes `id` in `slot` for this tunnel, closing whatever held it; answers whether something was displaced. The
    /// replacement is in place before the loser is told, so the id never routes nowhere.
    pub fn register(&self, id: &str, slot: Slot, held: Held) -> bool {
        let previous = self.lock().of(slot).insert(id.to_owned(), held);
        if let Some(previous) = &previous {
            previous.closing.send_replace(Some(Close {
                code: DISPLACED_CODE,
                reason: "displaced by a newer tunnel".into(),
            }));
        }
        if slot == Slot::Socket {
            self.tell(id, Change::Arrived);
        }
        previous.is_some()
    }

    /// Gives `id` up only if this session still holds it: a displaced tunnel's teardown runs after its replacement took
    /// the id.
    pub fn unregister(&self, id: &str, slot: Slot, session: &Session) {
        let removed = {
            let mut slots = self.lock();
            let held = slots.of(slot);
            let still = held.get(id).is_some_and(|held| held.session.same(session));
            still.then(|| held.remove(id)).flatten()
        };
        if removed.is_some() && slot == Slot::Socket {
            self.tell(id, Change::Left);
        }
    }

    /// Closes and drops the socket tunnel a peer's newer registration claimed, raising no change: the id moved, it
    /// did not leave the cluster. Answers whether one was held.
    pub fn displace(&self, id: &str, reason: String) -> bool {
        let Some(held) = self.lock().socket.remove(id) else {
            return false;
        };
        held.closing.send_replace(Some(Close {
            code: DISPLACED_CODE,
            reason: reason.into(),
        }));
        true
    }

    pub fn lookup(&self, id: &str, slot: Slot) -> Option<Session> {
        self.lock()
            .of(slot)
            .get(id)
            .map(|held| held.session.clone())
    }

    /// Sandboxes with a socket tunnel here.
    pub fn size(&self) -> usize {
        self.lock().socket.len()
    }

    pub fn ids(&self) -> Vec<String> {
        self.lock().socket.keys().cloned().collect()
    }

    /// Asks every tunnel in every slot to close, as this process stops.
    pub fn close_all(&self, close: &Close) {
        let mut slots = self.lock();
        for held in slots
            .socket
            .values()
            .chain(slots.bulk.values())
            .chain(slots.quic.values())
        {
            held.closing.send_replace(Some(close.clone()));
        }
        slots.socket.clear();
        slots.bulk.clear();
        slots.quic.clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Slots> {
        self.held.lock().expect("the registry is never poisoned")
    }

    fn tell(&self, id: &str, change: Change) {
        if let Some(listener) = self.listener.get() {
            listener(id, change);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use hyper_util::rt::{TokioExecutor, TokioIo};
    use tokio::io::DuplexStream;

    use super::*;

    const ID: &str = "abcdef012345";

    // A session over a pipe nothing answers: the registry only ever compares one by identity.
    async fn held() -> (Held, Session, watch::Receiver<Option<Close>>, DuplexStream) {
        let (near, far) = tokio::io::duplex(1 << 16);
        let (sender, _) =
            hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(near))
                .await
                .unwrap();
        let session = Session::legacy(sender);
        let (closing, closed) = watch::channel(None);
        (
            Held {
                session: session.clone(),
                closing,
            },
            session,
            closed,
            far,
        )
    }

    fn closed_with(closed: &watch::Receiver<Option<Close>>) -> Option<(u16, String)> {
        closed
            .borrow()
            .as_ref()
            .map(|close| (close.code, close.reason.to_string()))
    }

    #[tokio::test]
    async fn routes_a_sandbox_to_the_tunnel_that_registered_it() {
        let registry = Registry::new();
        let (first, session, _, _pipe1) = held().await;
        assert!(!registry.register(ID, Slot::Socket, first));
        assert!(registry.lookup(ID, Slot::Socket).unwrap().same(&session));
        assert!(registry.lookup("000000000000", Slot::Socket).is_none());
        assert_eq!(registry.size(), 1);
        assert_eq!(registry.ids(), [ID]);
    }

    #[tokio::test]
    async fn a_second_tunnel_takes_the_id_and_closes_the_first() {
        let registry = Registry::new();
        let (older, _, older_closed, _pipe2) = held().await;
        let (newer, newer_session, _, _pipe3) = held().await;
        registry.register(ID, Slot::Socket, older);
        assert!(registry.register(ID, Slot::Socket, newer));
        assert_eq!(
            closed_with(&older_closed),
            Some((DISPLACED_CODE, "displaced by a newer tunnel".into()))
        );
        assert!(
            registry
                .lookup(ID, Slot::Socket)
                .unwrap()
                .same(&newer_session)
        );
        assert_eq!(registry.size(), 1);
    }

    #[tokio::test]
    async fn a_bulk_lane_is_held_beside_the_socket_tunnel_and_displaces_only_its_own_kind() {
        let changes = Arc::new(Mutex::new(Vec::new()));
        let registry = Registry::new();
        let heard = changes.clone();
        registry.on_change(move |id, change| heard.lock().unwrap().push((id.to_owned(), change)));
        let (interactive, interactive_session, interactive_closed, _pipe4) = held().await;
        registry.register(ID, Slot::Socket, interactive);
        changes.lock().unwrap().clear();

        let (older, older_session, older_closed, _pipe5) = held().await;
        let (newer, newer_session, _, _pipe6) = held().await;
        assert!(!registry.register(ID, Slot::Bulk, older));
        assert!(registry.register(ID, Slot::Bulk, newer));
        assert_eq!(
            closed_with(&older_closed).map(|(code, _)| code),
            Some(DISPLACED_CODE)
        );
        assert_eq!(closed_with(&interactive_closed), None);
        assert!(
            registry
                .lookup(ID, Slot::Bulk)
                .unwrap()
                .same(&newer_session)
        );
        assert!(
            registry
                .lookup(ID, Slot::Socket)
                .unwrap()
                .same(&interactive_session)
        );
        assert!(changes.lock().unwrap().is_empty());
        assert_eq!(registry.size(), 1);

        registry.unregister(ID, Slot::Bulk, &older_session);
        assert!(
            registry
                .lookup(ID, Slot::Bulk)
                .unwrap()
                .same(&newer_session)
        );
        registry.unregister(ID, Slot::Bulk, &newer_session);
        assert!(registry.lookup(ID, Slot::Bulk).is_none());
        assert!(registry.lookup(ID, Slot::Socket).is_some());
    }

    #[tokio::test]
    async fn a_displaced_tunnels_teardown_cannot_evict_its_replacement() {
        let registry = Registry::new();
        let (older, older_session, _, _pipe7) = held().await;
        let (newer, newer_session, _, _pipe8) = held().await;
        registry.register(ID, Slot::Socket, older);
        registry.register(ID, Slot::Socket, newer);
        registry.unregister(ID, Slot::Socket, &older_session);
        assert!(
            registry
                .lookup(ID, Slot::Socket)
                .unwrap()
                .same(&newer_session)
        );
        registry.unregister(ID, Slot::Socket, &newer_session);
        assert!(registry.lookup(ID, Slot::Socket).is_none());
        assert_eq!(registry.size(), 0);
    }

    #[tokio::test]
    async fn arrivals_and_departures_are_news_and_a_displacement_is_not() {
        let changes = Arc::new(Mutex::new(Vec::new()));
        let registry = Registry::new();
        let heard = changes.clone();
        registry.on_change(move |id, change| heard.lock().unwrap().push((id.to_owned(), change)));
        let (only, only_session, _, _pipe9) = held().await;
        registry.register(ID, Slot::Socket, only);
        registry.unregister(ID, Slot::Socket, &only_session);
        assert_eq!(
            *changes.lock().unwrap(),
            [
                (ID.to_owned(), Change::Arrived),
                (ID.to_owned(), Change::Left)
            ]
        );

        let (again, again_session, again_closed, _pipe10) = held().await;
        registry.register(ID, Slot::Socket, again);
        changes.lock().unwrap().clear();
        assert!(registry.displace(ID, "displaced by a newer tunnel on peer-b".into()));
        assert_eq!(
            closed_with(&again_closed),
            Some((
                DISPLACED_CODE,
                "displaced by a newer tunnel on peer-b".into()
            ))
        );
        assert!(registry.lookup(ID, Slot::Socket).is_none());
        registry.unregister(ID, Slot::Socket, &again_session);
        assert!(changes.lock().unwrap().is_empty());
        assert!(!registry.displace(ID, "again".into()));
    }
}
