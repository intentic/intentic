//! Which tunnel serves which sandbox on this machine, per slot, and who dialled it. One holder per sandbox
//! (2026-10-05): a registration from a netd of another instance than one already holding the sandbox, whose carrier is
//! alive, is refused (`Elsewhere`), so two containers holding one grant no longer trade the tunnel every minute. A netd
//! naming no instance predates instances and keeps the old rule: the newest registration for an id and slot takes it and
//! closes the older with `DISPLACED_CODE`, whose teardown then cannot evict it. The same instance replaces its own older
//! registration the same way. Every arrival and departure, in any slot, is the cluster's news, with when it registered
//! and who dialled it, so a peer orders what it hears and knows a sandbox held only over QUIC.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tunnel::{Close, DISPLACED_CODE, Heard, Identity};

use crate::session::Session;

/// A held tunnel: the session requests ride, and what asks its carrier to close.
pub struct Held {
    pub session: Session,
    pub closing: watch::Sender<Option<Close>>,
}

/// Who holds a registration: netd that dialled it (none for one from before instances), when it registered, when
/// its carrier last heard it, and whether the carrier may take requests yet.
#[derive(Debug, Clone)]
pub struct Holder {
    pub identity: Option<Identity>,
    /// Wall-clock milliseconds since the epoch at registration, which machines order registrations by.
    pub since: u64,
    pub heard: Arc<Heard>,
    /// A socket takes requests at once; a QUIC connection once it answered a probe, since its handshake and hello cross
    /// a path that may carry nothing else.
    pub ready: Arc<AtomicBool>,
}

impl Holder {
    /// A carrier ready for requests now.
    pub fn new(identity: Option<Identity>, heard: Arc<Heard>) -> Self {
        Self {
            identity,
            since: now_ms(),
            heard,
            ready: Arc::new(AtomicBool::new(true)),
        }
    }

    /// A carrier that takes requests only once `ready` is raised.
    pub fn proving(identity: Option<Identity>, heard: Arc<Heard>) -> Self {
        Self {
            ready: Arc::new(AtomicBool::new(false)),
            ..Self::new(identity, heard)
        }
    }

    fn instance(&self) -> Option<&str> {
        self.identity
            .as_ref()
            .map(|identity| identity.instance.as_str())
    }
}

/// Where a tunnel is held: the interactive socket every netd dials first (`/tunnel/v2`, or a legacy netd's interactive
/// lane, either one the sandbox's home in the cluster), the bulk socket beside it, or the QUIC connection that carries
/// every request while it lasts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    Socket,
    Bulk,
    Quic,
}

impl Slot {
    pub const ALL: [Self; 3] = [Self::Socket, Self::Bulk, Self::Quic];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Arrived,
    Left,
}

/// A registration as the cluster tells it: the sandbox, the slot, when it registered (wall-clock milliseconds), and the
/// netd that dialled it with where that netd runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holding {
    pub id: String,
    pub slot: Slot,
    pub since: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub host: String,
}

/// Another live copy of the sandbox holds it: where that copy runs, as its netd named the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Elsewhere {
    pub instance: String,
    pub host: String,
}

type Listener = Box<dyn Fn(&Holding, Change) + Send + Sync>;

struct Entry {
    held: Held,
    holder: Holder,
}

impl Entry {
    fn holding(&self, id: &str, slot: Slot) -> Holding {
        Holding {
            id: id.to_owned(),
            slot,
            since: self.holder.since,
            instance: self.holder.instance().map(str::to_owned),
            host: self
                .holder
                .identity
                .as_ref()
                .map(|identity| identity.host.clone())
                .unwrap_or_default(),
        }
    }

    // Whether this entry keeps `newcomer` out: another instance's, from another place, and its carrier alive. One
    // machine's environment cannot run two copies of a sandbox at once (one engine, one container name), so a new
    // instance from the very place the holder runs is that container started again after a crash or a recreate: it
    // replaces the holder instead of waiting out the old carrier's silence, which a refusal's backoff would stretch to
    // minutes of downtime. Only a place both netd instances named counts; two machines labelled alike stay newest-wins.
    fn keeps_out(&self, newcomer: &Identity) -> Option<Elsewhere> {
        let identity = self.holder.identity.as_ref()?;
        let same_place = !identity.host.is_empty() && identity.host == newcomer.host;
        (identity.instance != newcomer.instance && !same_place && self.holder.heard.alive()).then(
            || Elsewhere {
                instance: identity.instance.clone(),
                host: identity.host.clone(),
            },
        )
    }
}

#[derive(Default)]
pub struct Registry {
    held: Mutex<Slots>,
    listener: OnceLock<Listener>,
}

#[derive(Default)]
struct Slots {
    socket: HashMap<String, Entry>,
    bulk: HashMap<String, Entry>,
    quic: HashMap<String, Entry>,
}

impl Slots {
    fn of(&mut self, slot: Slot) -> &mut HashMap<String, Entry> {
        match slot {
            Slot::Socket => &mut self.socket,
            Slot::Bulk => &mut self.bulk,
            Slot::Quic => &mut self.quic,
        }
    }

    fn get(&self, slot: Slot) -> &HashMap<String, Entry> {
        match slot {
            Slot::Socket => &self.socket,
            Slot::Bulk => &self.bulk,
            Slot::Quic => &self.quic,
        }
    }

    fn elsewhere(&self, id: &str, newcomer: &Identity) -> Option<Elsewhere> {
        Slot::ALL
            .into_iter()
            .find_map(|slot| self.get(slot).get(id)?.keeps_out(newcomer))
    }
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Who hears a tunnel arrive or leave, in any slot; set once, before the first tunnel registers.
    pub fn on_change(&self, listener: impl Fn(&Holding, Change) + Send + Sync + 'static) {
        let _ = self.listener.set(Box::new(listener));
    }

    /// Whether a netd of `identity` would be refused `id` here: another instance holds a slot of it and its carrier is
    /// alive. Asked before an upgrade is answered, so a refused netd hears 409 rather than a 101 and a close; a netd
    /// naming none is never refused.
    pub fn held_elsewhere(&self, id: &str, identity: Option<&Identity>) -> Option<Elsewhere> {
        self.lock().elsewhere(id, identity?)
    }

    /// Takes `id` in `slot` for this tunnel, answering whether it displaced one, or refuses it because another live
    /// instance holds the sandbox. A registration that takes the sandbox from another instance (its carriers are all
    /// silent, so it is gone) closes what that instance still held in the other slots. The replacement is in place
    /// before the loser is told, so the id never routes nowhere.
    pub fn admit(
        &self,
        id: &str,
        slot: Slot,
        held: Held,
        holder: Holder,
    ) -> Result<bool, Elsewhere> {
        let entry = Entry { held, holder };
        let holding = entry.holding(id, slot);
        let (previous, stale) = {
            let mut slots = self.lock();
            let mut stale = Vec::new();
            if let Some(newcomer) = entry.holder.identity.as_ref() {
                if let Some(elsewhere) = slots.elsewhere(id, newcomer) {
                    return Err(elsewhere);
                }
                let instance = newcomer.instance.as_str();
                for other in Slot::ALL.into_iter().filter(|other| *other != slot) {
                    let theirs = slots.get(other).get(id).is_some_and(|held| {
                        held.holder
                            .instance()
                            .is_some_and(|theirs| theirs != instance)
                    });
                    if theirs && let Some(gone) = slots.of(other).remove(id) {
                        stale.push((other, gone));
                    }
                }
            }
            (slots.of(slot).insert(id.to_owned(), entry), stale)
        };
        if let Some(previous) = &previous {
            previous.held.closing.send_replace(Some(Close {
                code: DISPLACED_CODE,
                reason: "displaced by a newer tunnel".into(),
            }));
        }
        for (other, gone) in stale {
            gone.held.closing.send_replace(Some(Close {
                code: DISPLACED_CODE,
                reason: "displaced by another copy that took the sandbox".into(),
            }));
            self.tell(&gone.holding(id, other), Change::Left);
        }
        self.tell(&holding, Change::Arrived);
        Ok(previous.is_some())
    }

    /// Takes `id` in `slot` for a tunnel from a netd that names no instance: newest wins, as it always did. Answers
    /// whether something was displaced.
    pub fn register(&self, id: &str, slot: Slot, held: Held) -> bool {
        self.admit(
            id,
            slot,
            held,
            Holder::new(None, Arc::new(Heard::default())),
        )
        .unwrap_or(false)
    }

    /// Gives `id` up only if this session still holds it: a displaced tunnel's teardown runs after its replacement took
    /// the id.
    pub fn unregister(&self, id: &str, slot: Slot, session: &Session) {
        let removed = {
            let mut slots = self.lock();
            let held = slots.of(slot);
            let still = held
                .get(id)
                .is_some_and(|entry| entry.held.session.same(session));
            still.then(|| held.remove(id)).flatten()
        };
        if let Some(removed) = removed {
            self.tell(&removed.holding(id, slot), Change::Left);
        }
    }

    /// Closes and drops the socket tunnel a peer's newer registration claimed, raising no change: the id moved, it
    /// did not leave the cluster. Answers whether one was held.
    pub fn displace(&self, id: &str, reason: String) -> bool {
        self.displace_slot(
            id,
            Slot::Socket,
            Close {
                code: DISPLACED_CODE,
                reason: reason.into(),
            },
        )
    }

    /// Closes and drops the tunnel in `slot` with `close`, raising no change. Answers whether one was held.
    pub fn displace_slot(&self, id: &str, slot: Slot, close: Close) -> bool {
        let Some(entry) = self.lock().of(slot).remove(id) else {
            return false;
        };
        entry.held.closing.send_replace(Some(close));
        true
    }

    /// Closes the tunnel in `slot` with `close` if `session` still holds it, as when its carrier stopped answering;
    /// its own teardown then gives the slot up.
    pub fn close_if(&self, id: &str, slot: Slot, session: &Session, close: Close) -> bool {
        let slots = self.lock();
        let Some(entry) = slots
            .get(slot)
            .get(id)
            .filter(|entry| entry.held.session.same(session))
        else {
            return false;
        };
        entry.held.closing.send_replace(Some(close));
        true
    }

    /// Closes every tunnel `id` holds, in every slot, with `close`: the platform deleted it. Answers how many.
    pub fn close_id(&self, id: &str, close: &Close) -> usize {
        let slots = self.lock();
        let mut closed = 0;
        for slot in Slot::ALL {
            if let Some(entry) = slots.get(slot).get(id) {
                entry.held.closing.send_replace(Some(close.clone()));
                closed += 1;
            }
        }
        closed
    }

    /// The session requests to `id` ride in `slot`, once its carrier is ready for them.
    pub fn lookup(&self, id: &str, slot: Slot) -> Option<Session> {
        self.lock()
            .get(slot)
            .get(id)
            .filter(|entry| entry.holder.ready.load(Ordering::Relaxed))
            .map(|entry| entry.held.session.clone())
    }

    /// What this machine holds of `id` in `slot`, as the cluster tells it.
    pub fn holding(&self, id: &str, slot: Slot) -> Option<Holding> {
        self.lock()
            .get(slot)
            .get(id)
            .map(|entry| entry.holding(id, slot))
    }

    /// Whether the carrier holding `id` in `slot` was heard within the dead window.
    pub fn alive(&self, id: &str, slot: Slot) -> bool {
        self.lock()
            .get(slot)
            .get(id)
            .is_some_and(|entry| entry.holder.heard.alive())
    }

    /// Sandboxes with a socket tunnel here.
    pub fn size(&self) -> usize {
        self.lock().socket.len()
    }

    /// Sandboxes with a socket tunnel here, the sandbox's home in the cluster.
    pub fn ids(&self) -> Vec<String> {
        self.lock().socket.keys().cloned().collect()
    }

    /// Sandboxes holding anything here, in any slot.
    pub fn held_ids(&self) -> Vec<String> {
        let slots = self.lock();
        let mut ids: HashSet<String> = HashSet::new();
        for slot in Slot::ALL {
            ids.extend(slots.get(slot).keys().cloned());
        }
        ids.into_iter().collect()
    }

    /// Every registration here, in every slot, as the cluster tells it.
    pub fn holdings(&self) -> Vec<Holding> {
        let slots = self.lock();
        Slot::ALL
            .into_iter()
            .flat_map(|slot| {
                slots
                    .get(slot)
                    .iter()
                    .map(move |(id, entry)| entry.holding(id, slot))
            })
            .collect()
    }

    /// Asks every tunnel in every slot to close, as this process stops.
    pub fn close_all(&self, close: &Close) {
        let mut slots = self.lock();
        for entry in slots
            .socket
            .values()
            .chain(slots.bulk.values())
            .chain(slots.quic.values())
        {
            entry.held.closing.send_replace(Some(close.clone()));
        }
        slots.socket.clear();
        slots.bulk.clear();
        slots.quic.clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Slots> {
        self.held.lock().expect("the registry is never poisoned")
    }

    fn tell(&self, holding: &Holding, change: Change) {
        if let Some(listener) = self.listener.get() {
            listener(holding, change);
        }
    }
}

/// Wall-clock milliseconds since the epoch: what registrations on different machines are ordered by.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use hyper_util::rt::{TokioExecutor, TokioIo};
    use tokio::io::DuplexStream;

    use super::*;
    use tunnel::DEAD_AFTER;

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
        registry.on_change(move |holding, change| {
            heard
                .lock()
                .unwrap()
                .push((holding.id.clone(), holding.slot, change))
        });
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
        // The bulk lane's arrival is news of its own, which never touches the socket's.
        assert_eq!(
            *changes.lock().unwrap(),
            [
                (ID.to_owned(), Slot::Bulk, Change::Arrived),
                (ID.to_owned(), Slot::Bulk, Change::Arrived)
            ]
        );
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
        registry.on_change(move |holding, change| {
            heard.lock().unwrap().push((holding.id.clone(), change))
        });
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

    fn named(instance: &str, host: &str) -> Option<Identity> {
        Some(Identity {
            instance: instance.into(),
            host: host.into(),
        })
    }

    // The 2026-10-05 swap: two containers holding one grant, each taking the tunnel from the other every minute.
    #[tokio::test(start_paused = true)]
    async fn another_live_instance_is_refused_in_every_slot_and_the_holder_stands() {
        let registry = Registry::new();
        let (first, first_session, first_closed, _pipe11) = held().await;
        let heard = Arc::new(Heard::default());
        assert_eq!(
            registry.admit(
                ID,
                Slot::Socket,
                first,
                Holder::new(named("a1", "rog (linux)"), heard.clone())
            ),
            Ok(false)
        );
        for slot in Slot::ALL {
            let (second, _, second_closed, _pipe12) = held().await;
            let refused = registry.admit(
                ID,
                slot,
                second,
                Holder::new(named("b2", "omen (windows)"), Arc::default()),
            );
            assert_eq!(
                refused,
                Err(Elsewhere {
                    instance: "a1".into(),
                    host: "rog (linux)".into()
                }),
                "{slot:?}"
            );
            assert_eq!(closed_with(&second_closed), None);
        }
        assert_eq!(
            registry
                .held_elsewhere(ID, named("b2", "").as_ref())
                .map(|elsewhere| elsewhere.host),
            Some("rog (linux)".into())
        );
        assert_eq!(registry.held_elsewhere(ID, named("a1", "").as_ref()), None);
        assert_eq!(
            registry.held_elsewhere(ID, None),
            None,
            "a netd naming none is never refused"
        );
        assert!(
            registry
                .lookup(ID, Slot::Socket)
                .unwrap()
                .same(&first_session)
        );
        assert_eq!(closed_with(&first_closed), None);

        // Its own redial replaces it as always.
        let (again, again_session, _, _pipe13) = held().await;
        assert_eq!(
            registry.admit(
                ID,
                Slot::Socket,
                again,
                Holder::new(named("a1", "rog (linux)"), heard.clone())
            ),
            Ok(true)
        );
        assert_eq!(
            closed_with(&first_closed).map(|(code, _)| code),
            Some(DISPLACED_CODE)
        );
        assert!(
            registry
                .lookup(ID, Slot::Socket)
                .unwrap()
                .same(&again_session)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_holder_silent_past_the_dead_window_is_taken_over_with_what_it_held_beside() {
        let registry = Registry::new();
        let (socket, _, socket_closed, _pipe14) = held().await;
        let (quic, _, quic_closed, _pipe15) = held().await;
        registry
            .admit(
                ID,
                Slot::Socket,
                socket,
                Holder::new(named("a1", "rog"), Arc::default()),
            )
            .unwrap();
        registry
            .admit(
                ID,
                Slot::Quic,
                quic,
                Holder::new(named("a1", "rog"), Arc::default()),
            )
            .unwrap();
        tokio::time::advance(DEAD_AFTER + std::time::Duration::from_secs(1)).await;
        let (taking, taking_session, _, _pipe16) = held().await;
        assert_eq!(
            registry.admit(
                ID,
                Slot::Socket,
                taking,
                Holder::new(named("b2", "omen"), Arc::default())
            ),
            Ok(true)
        );
        assert!(
            registry
                .lookup(ID, Slot::Socket)
                .unwrap()
                .same(&taking_session)
        );
        assert_eq!(
            closed_with(&socket_closed).map(|(code, _)| code),
            Some(DISPLACED_CODE)
        );
        assert_eq!(
            closed_with(&quic_closed).map(|(code, _)| code),
            Some(DISPLACED_CODE)
        );
        assert!(registry.lookup(ID, Slot::Quic).is_none());
    }

    // A container started again where it ran (a crash, a recreate) is a new instance from the same place: it takes the
    // sandbox at once rather than being refused while the old carrier's silence runs out.
    #[tokio::test(start_paused = true)]
    async fn a_new_instance_from_the_holders_own_place_replaces_it() {
        let registry = Registry::new();
        let (first, _, first_closed, _pipe21) = held().await;
        let heard = Arc::new(Heard::default());
        assert_eq!(
            registry.admit(
                ID,
                Slot::Socket,
                first,
                Holder::new(named("a1", "rog (linux, archlinux)"), heard.clone())
            ),
            Ok(false)
        );
        assert_eq!(
            registry
                .held_elsewhere(ID, named("c3", "rog (linux, archlinux)").as_ref())
                .map(|elsewhere| elsewhere.host),
            None
        );
        let (again, again_session, _, _pipe22) = held().await;
        assert_eq!(
            registry.admit(
                ID,
                Slot::Socket,
                again,
                Holder::new(named("c3", "rog (linux, archlinux)"), Arc::default())
            ),
            Ok(true)
        );
        assert!(
            registry
                .lookup(ID, Slot::Socket)
                .unwrap()
                .same(&again_session)
        );
        assert_eq!(
            closed_with(&first_closed).map(|(code, _)| code),
            Some(DISPLACED_CODE)
        );
        // Another environment of the same machine is another place: still refused while the holder lives.
        assert!(
            registry
                .held_elsewhere(ID, named("d4", "rog (windows)").as_ref())
                .is_some()
        );
    }

    // An older netd names no instance: the newest still wins against it, and it against a named one, during the roll.
    #[tokio::test]
    async fn a_netd_naming_no_instance_keeps_newest_wins_either_way() {
        let registry = Registry::new();
        let (named_one, _, named_closed, _pipe17) = held().await;
        registry
            .admit(
                ID,
                Slot::Socket,
                named_one,
                Holder::new(named("a1", "rog"), Arc::default()),
            )
            .unwrap();
        let (older, _, older_closed, _pipe18) = held().await;
        assert!(registry.register(ID, Slot::Socket, older));
        assert_eq!(
            closed_with(&named_closed).map(|(code, _)| code),
            Some(DISPLACED_CODE)
        );
        let (again, _, _, _pipe19) = held().await;
        assert_eq!(
            registry.admit(
                ID,
                Slot::Socket,
                again,
                Holder::new(named("b2", "omen"), Arc::default())
            ),
            Ok(true)
        );
        assert_eq!(
            closed_with(&older_closed).map(|(code, _)| code),
            Some(DISPLACED_CODE)
        );
    }

    #[tokio::test]
    async fn a_proving_carrier_takes_no_requests_until_ready_and_a_deletion_closes_every_slot() {
        let registry = Registry::new();
        let (quic, quic_session, quic_closed, _pipe20) = held().await;
        let proving = Holder::proving(named("a1", "rog"), Arc::default());
        let ready = proving.ready.clone();
        registry.admit(ID, Slot::Quic, quic, proving).unwrap();
        assert!(registry.lookup(ID, Slot::Quic).is_none());
        assert!(registry.holding(ID, Slot::Quic).is_some());
        ready.store(true, Ordering::Relaxed);
        assert!(registry.lookup(ID, Slot::Quic).unwrap().same(&quic_session));
        let (socket, _, socket_closed, _pipe21) = held().await;
        registry
            .admit(
                ID,
                Slot::Socket,
                socket,
                Holder::new(named("a1", "rog"), Arc::default()),
            )
            .unwrap();
        let deleted = Close {
            code: tunnel::DELETED_CODE,
            reason: "deleted".into(),
        };
        assert_eq!(registry.close_id(ID, &deleted), 2);
        assert_eq!(
            closed_with(&quic_closed).map(|(code, _)| code),
            Some(tunnel::DELETED_CODE)
        );
        assert_eq!(
            closed_with(&socket_closed).map(|(code, _)| code),
            Some(tunnel::DELETED_CODE)
        );
        let mut held_ids = registry.held_ids();
        held_ids.sort();
        assert_eq!(held_ids, [ID]);
        let holdings = registry.holdings();
        assert_eq!(holdings.len(), 2);
        assert!(
            holdings
                .iter()
                .all(|holding| holding.instance.as_deref() == Some("a1"))
        );
    }
}
