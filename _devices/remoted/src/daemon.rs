//! remoted as one value: the configuration as it stands, the terminals, every person's open socket, and the uplinks the
//! configuration names, each run by a task of its own. A change to the configuration is enforced here: a switch turned
//! off ends what it allowed and nothing else, `notBefore` moving drops every viewer, `paused` stops everyone's typing.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::watch;

use crate::config::{Config, UplinkConfig};
use crate::media::Screens;
use crate::status::{Person, PersonKind, Status};
use crate::term::Terminals;
use crate::term::socket::{DROPPED, Gate, Revocation};
use crate::token::{self, Claims, Refused};

// When an uplink's viewers were last dropped: every token minted before is refused (`?read_write=1`: only those that
// could type).
#[derive(Debug, Clone, Copy, Default)]
struct Drops {
    all: u64,
    read_write: u64,
}

struct Open {
    uplink: String,
    kind: PersonKind,
    read_only: bool,
    revocation: Arc<Revocation>,
}

pub struct Daemon {
    pub status: Arc<Status>,
    pub terminals: Arc<Terminals>,
    /// The screens being served: one pipeline per monitor, shared by every uplink's viewers.
    pub screens: Arc<Screens>,
    config: watch::Receiver<Config>,
    open: Mutex<HashMap<u64, Open>>,
    drops: Mutex<HashMap<String, Drops>>,
    next: AtomicU64,
    pub started: Instant,
}

/// One person's socket, counted for as long as it is held: in the status line, and for a drop to reach.
pub struct Viewer {
    pub id: u64,
    pub revocation: Arc<Revocation>,
    daemon: Arc<Daemon>,
}

impl Drop for Viewer {
    fn drop(&mut self) {
        self.daemon
            .open
            .lock()
            .expect("viewers poisoned")
            .remove(&self.id);
        self.daemon.status.person_left(self.id);
    }
}

impl Daemon {
    pub fn new(status: Arc<Status>, config: watch::Receiver<Config>) -> Arc<Self> {
        Self::with_screens(
            status,
            config,
            Screens::new(crate::media::platform(), crate::media::linger()),
        )
    }

    /// A daemon serving `screens` (a test's own platform).
    pub fn with_screens(
        status: Arc<Status>,
        config: watch::Receiver<Config>,
        screens: Arc<Screens>,
    ) -> Arc<Self> {
        Arc::new(Self {
            screens,
            terminals: Terminals::new(status.clone()),
            status,
            config,
            open: Mutex::new(HashMap::new()),
            drops: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            started: Instant::now(),
        })
    }

    pub fn config(&self) -> watch::Receiver<Config> {
        self.config.clone()
    }

    /// An uplink as the configuration holds it now.
    pub fn uplink(&self, id: &str) -> Option<UplinkConfig> {
        self.config
            .borrow()
            .uplinks
            .iter()
            .find(|uplink| uplink.id == id)
            .cloned()
    }

    pub fn paused(&self) -> bool {
        self.config.borrow().paused
    }

    /// Whether people's typing on this uplink's terminals reaches them now.
    pub fn terminal_input_allowed(&self, uplink: &str) -> bool {
        let config = self.config.borrow();
        !config.paused
            && config
                .uplinks
                .iter()
                .any(|held| held.id == uplink && held.allow.terminal)
    }

    /// Whether people's input on this uplink's screens reaches them now: its control switch on, and nobody paused.
    pub fn screen_input_allowed(&self, uplink: &str) -> bool {
        let config = self.config.borrow();
        !config.paused
            && config
                .uplinks
                .iter()
                .any(|held| held.id == uplink && held.allow.control)
    }

    /// Checks a viewer's token against the uplink's key, the subject it must open, and every drop since it was minted.
    pub fn check(
        &self,
        uplink: &UplinkConfig,
        subject: &str,
        token: &str,
    ) -> Result<Claims, Refused> {
        let key = uplink.key().ok_or(Refused::BadSignature)?;
        let claims = token::verify(&key, subject, token, token::now_ms())?;
        let not_before = self.config.borrow().not_before;
        let drops = self
            .drops
            .lock()
            .expect("drops poisoned")
            .get(&uplink.id)
            .copied()
            .unwrap_or_default();
        let before = not_before
            .max(drops.all)
            .max(if claims.ro { 0 } else { drops.read_write });
        if before > 0 && claims.iat < before {
            return Err(Refused::Dropped);
        }
        Ok(claims)
    }

    /// Counts a person's socket in: it is listed in the status, and a drop closes it.
    pub fn viewer(
        self: &Arc<Self>,
        uplink: &str,
        kind: PersonKind,
        session: &str,
        read_only: bool,
    ) -> Viewer {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let revocation = Arc::new(Revocation::default());
        self.open.lock().expect("viewers poisoned").insert(
            id,
            Open {
                uplink: uplink.to_owned(),
                kind,
                read_only,
                revocation: revocation.clone(),
            },
        );
        self.status.person_joined(
            id,
            Person {
                uplink: uplink.to_owned(),
                kind,
                session: session.to_owned(),
                read_only,
                since: token::now_ms(),
            },
        );
        Viewer {
            id,
            revocation,
            daemon: self.clone(),
        }
    }

    /// Closes the viewers of one uplink (or of every uplink) with 4001, only those that can type with
    /// `read_write_only`, and refuses every token minted before now that would open such a socket again. Answers how
    /// many it closed.
    pub fn drop_viewers(&self, uplink: Option<&str>, read_write_only: bool) -> usize {
        let now = token::now_ms();
        if let Some(uplink) = uplink {
            let mut drops = self.drops.lock().expect("drops poisoned");
            let held = drops.entry(uplink.to_owned()).or_default();
            if read_write_only {
                held.read_write = now;
            } else {
                held.all = now;
            }
        }
        self.revoke(|open| {
            uplink.is_none_or(|uplink| open.uplink == uplink)
                && !(read_write_only && open.read_only)
        })
    }

    fn revoke(&self, which: impl Fn(&Open) -> bool) -> usize {
        let open = self.open.lock().expect("viewers poisoned");
        let mut closed = 0;
        for held in open.values().filter(|held| which(held)) {
            held.revocation.revoke(DROPPED);
            closed += 1;
        }
        closed
    }

    pub fn viewers(&self) -> usize {
        self.open.lock().expect("viewers poisoned").len()
    }

    /// Follows the configuration until remoted ends: starts each uplink it names, and enforces what changed.
    pub async fn run(self: Arc<Self>) {
        let mut config = self.config.clone();
        let mut running: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
        let mut before = Config::default();
        // wsl.exe takes most of a second to list its distros: the uplinks do not wait for it.
        let status = self.status.clone();
        tokio::spawn(async move { status.environments(crate::environments::list().await) });
        loop {
            let now = config.borrow_and_update().clone();
            self.enforce(&before, &now);
            running.retain(|_, task| !task.is_finished());
            for uplink in &now.uplinks {
                if !running.contains_key(&uplink.id) {
                    let task = tokio::spawn(crate::uplink::run(self.clone(), uplink.id.clone()));
                    running.insert(uplink.id.clone(), task);
                }
            }
            before = now;
            if config.changed().await.is_err() {
                return;
            }
        }
    }

    fn enforce(&self, before: &Config, now: &Config) {
        self.status.paused(now.paused);
        if now.paused != before.paused {
            log::info!(
                "people's input {}",
                if now.paused {
                    "paused by the person at this computer"
                } else {
                    "resumed"
                }
            );
        }
        if now.not_before > before.not_before && now.not_before > 0 {
            let closed = self.revoke(|_| true);
            log::info!(
                "every person's session ended by the person at this computer ({closed} closed)"
            );
        }
        let terminals_now: HashSet<&str> = now
            .uplinks
            .iter()
            .filter(|uplink| uplink.allow.terminal)
            .map(|uplink| uplink.id.as_str())
            .collect();
        for uplink in &before.uplinks {
            let id = uplink.id.as_str();
            let gone = !now.uplinks.iter().any(|held| held.id == id);
            if gone {
                self.terminals
                    .end_all(Some(id), "remote access to this computer was turned off");
                self.revoke(|open| open.uplink == id);
                self.drops.lock().expect("drops poisoned").remove(id);
            } else if uplink.allow.terminal && !terminals_now.contains(id) {
                self.terminals
                    .end_all(Some(id), "terminals were switched off on this computer");
            }
            // Watching switched off ends that uplink's screens' viewers; control switched off leaves them watching
            // (`screen_input_allowed`).
            let viewing_now = now
                .uplinks
                .iter()
                .any(|held| held.id == id && held.allow.view);
            if !gone && uplink.allow.view && !viewing_now {
                let closed = self.revoke(|open| {
                    open.uplink == id && matches!(open.kind, PersonKind::View | PersonKind::Control)
                });
                log::info!(
                    "uplink {id}: watching screens switched off ({closed} viewer(s) closed)"
                );
            }
        }
    }
}

/// What a terminal socket asks of the daemon while it runs.
pub struct TerminalGate {
    pub daemon: Arc<Daemon>,
    pub uplink: String,
    pub subject: String,
}

impl Gate for TerminalGate {
    fn input_allowed(&self) -> bool {
        self.daemon.terminal_input_allowed(&self.uplink)
    }

    fn refresh(&self, token: &str, read_only: bool) -> Option<u64> {
        let uplink = self.daemon.uplink(&self.uplink)?;
        let claims = self.daemon.check(&uplink, &self.subject, token).ok()?;
        // A fresh token keeps the socket's own access, never more or less.
        (claims.ro == read_only).then_some(claims.exp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Allow;

    fn uplink(id: &str, terminal: bool) -> UplinkConfig {
        UplinkConfig {
            id: id.into(),
            url: "http://127.0.0.1:1".into(),
            device: "dev".into(),
            uplink_token: "t".into(),
            media_key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc".into(),
            allow: Allow {
                terminal,
                ..Allow::default()
            },
            generation: 1,
            ice_servers: None,
        }
    }

    fn token(ro: bool, iat: u64) -> String {
        token::sign(
            &[7_u8; 32],
            &Claims {
                s: "terminal/t-1".into(),
                exp: token::now_ms() + 60_000,
                ro,
                iat,
            },
        )
    }

    #[tokio::test]
    async fn a_drop_refuses_every_token_minted_before_it_and_a_read_write_drop_spares_the_watchers()
    {
        let (_sender, config) = watch::channel(Config {
            uplinks: vec![uplink("a", true)],
            ..Config::default()
        });
        let daemon = Daemon::new(Arc::new(Status::default()), config);
        let held = daemon.uplink("a").unwrap();
        let minted = token::now_ms() - 1;
        assert!(
            daemon
                .check(&held, "terminal/t-1", &token(false, minted))
                .is_ok()
        );
        let writer = daemon.viewer("a", PersonKind::Terminal, "t-1", false);
        let watcher = daemon.viewer("a", PersonKind::Terminal, "t-1", true);
        assert_eq!(daemon.drop_viewers(Some("a"), true), 1);
        assert_eq!(writer.revocation.code(), Some(DROPPED));
        assert_eq!(watcher.revocation.code(), None);
        assert_eq!(
            daemon.check(&held, "terminal/t-1", &token(false, minted)),
            Err(Refused::Dropped)
        );
        assert!(
            daemon
                .check(&held, "terminal/t-1", &token(true, minted))
                .is_ok()
        );
        assert_eq!(
            daemon.check(&held, "terminal/t-1", &token(false, 0)),
            Err(Refused::Dropped)
        );
        drop(writer);
        assert_eq!(daemon.status.people().len(), 1);
    }

    #[tokio::test]
    async fn typing_reaches_a_terminal_only_while_its_switch_is_on_and_nobody_paused() {
        let (sender, config) = watch::channel(Config {
            uplinks: vec![uplink("a", true), uplink("b", false)],
            ..Config::default()
        });
        let daemon = Daemon::new(Arc::new(Status::default()), config);
        assert!(daemon.terminal_input_allowed("a"));
        assert!(!daemon.terminal_input_allowed("b"));
        assert!(!daemon.terminal_input_allowed("c"));
        sender.send_modify(|config| config.paused = true);
        assert!(!daemon.terminal_input_allowed("a"));
    }
}
