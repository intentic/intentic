//! The one core a process runs: its async runtime, its store, and the sink its events go to. The app starts it once,
//! from its `Application`, so it outlives every screen; a second start finds the first and keeps it.

use crate::bridge::{Config, Event, Request};
use crate::client::Client;
use crate::store::{SealError, Sealer, Store, StoreError};
use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI32, Ordering};

pub struct Core {
    runtime: tokio::runtime::Runtime,
    client: Client,
    calls: AtomicI32,
}

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("the store would not open: {0}")]
    Store(#[from] StoreError),
    #[error("the runtime would not start: {0}")]
    Runtime(#[from] std::io::Error),
    #[error(transparent)]
    Key(#[from] SealError),
}

static CORE: OnceLock<Core> = OnceLock::new();

impl Core {
    /// Starts the core, keeping its store under `data_dir`, or returns the one already running.
    pub fn start(
        data_dir: &Path,
        config: Config,
        events: impl Fn(Event) + Send + Sync + 'static,
    ) -> Result<&'static Core, StartError> {
        if let Some(core) = CORE.get() {
            return Ok(core);
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("core")
            .enable_all()
            .build()?;
        let store = Store::open(
            &data_dir.join("core.sqlite3"),
            Sealer::new(&config.secret_key)?,
        )?;
        // The grammars and the theme load while the first screen is built, not when its first code block is drawn.
        runtime.spawn_blocking(crate::render::warm);
        let core = Core {
            runtime,
            client: Client::new(config, store, Box::new(events)),
            calls: AtomicI32::new(0),
        };
        // Two threads racing to start: the loser's core is dropped and the winner's returned.
        let mut won = false;
        let core = CORE.get_or_init(|| {
            won = true;
            core
        });
        if won {
            core.runtime.spawn(core.client.boot());
        }
        Ok(core)
    }

    pub fn get() -> Option<&'static Core> {
        CORE.get()
    }

    /// An open conversation's rows, for the app's list to read row by row.
    pub fn conversation(
        &self,
        agent: &str,
    ) -> Option<std::sync::Arc<std::sync::Mutex<crate::conversation::Conversation>>> {
        self.client.conversation(agent)
    }

    /// Runs `request` on the core's runtime and returns its number; the answer arrives as an [`Event::Reply`].
    pub fn call(&'static self, request: Request) -> i32 {
        let id = self.calls.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        self.runtime.spawn(async move {
            let outcome = self.client.handle(request).await;
            self.client.emit(Event::Reply { id, outcome });
        });
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{Outcome, SessionState};
    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn answers_a_call_on_its_own_thread() {
        let dir = std::env::temp_dir().join(format!("intentic-mobile-core-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (sender, receiver) = mpsc::channel();
        let sender = Mutex::new(sender);
        let config = Config {
            api_url: "https://api.example".into(),
            web_url: "https://app.example".into(),
            passkey_origin: None,
            secret_key: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".into(),
        };
        let core = Core::start(&dir, config, move |event| {
            if let Ok(sender) = sender.lock() {
                let _ = sender.send(event);
            }
        })
        .unwrap();
        // Booting with nothing kept says "signed out" and "no sandboxes" before anything else.
        let first = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            first,
            Event::Session {
                state: SessionState::SignedOut
            }
        );
        let _sandboxes = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        let id = core.call(Request::Ping { echo: "hi".into() });
        let event = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            event,
            Event::Reply {
                id,
                outcome: Outcome::Pong { echo: "hi".into() }
            }
        );
    }
}
