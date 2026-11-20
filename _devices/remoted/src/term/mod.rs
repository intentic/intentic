//! People's terminals on this computer: created by the daemon (`POST /terminals`, Node through netd), attached by a
//! viewer's socket (`/terminal/<session>?token=…`), listed and ended by name. A terminal outlives every viewer leaving
//! and the uplink dropping, for as long as remoted runs; it ends when its program exits, when it is deleted, when its
//! uplink's terminal switch goes off or its uplink is removed, and with remoted. Each uplink's terminals are its own:
//! one sandbox cannot list, open or end another's.

pub mod deflate;
pub mod outbox;
pub mod screen;
pub mod session;
pub mod shell;
pub mod socket;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::environments::{self, Environment};
use crate::status::Status;
use session::{Ended, Session};

/// Terminals one uplink may hold at once; a create past it is refused (429).
pub const MAX_PER_UPLINK: usize = 16;

/// Terminals remoted holds at once, across every uplink.
pub const MAX_TERMINALS: usize = 64;

/// The size a terminal starts at when the create names none: the editor's own default.
pub const DEFAULT_SIZE: (u16, u16) = (80, 24);

/// `POST /terminals`'s body.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    pub session: String,
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

/// One terminal as the daemon lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub session: String,
    pub title: String,
    pub environment: String,
    pub created_at: u64,
    pub viewers: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// 400, in words.
    Asked(String),
    /// 409.
    Exists,
    /// 429.
    TooMany,
    /// 500: the program could not be started.
    Failed(String),
}

/// A session's name: what netd puts in a path and Node in a token.
pub fn valid_session(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

type Key = (String, String);

pub struct Terminals {
    sessions: Mutex<HashMap<Key, Arc<Session>>>,
    status: Arc<Status>,
}

impl Terminals {
    pub fn new(status: Arc<Status>) -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            status,
        })
    }

    pub async fn create(self: &Arc<Self>, uplink: &str, asked: Create) -> Result<Listed, Refused> {
        if !valid_session(&asked.session) {
            return Err(Refused::Asked(
                "a session is 1-64 of A-Z, a-z, 0-9, - and _".into(),
            ));
        }
        let environment_name = asked
            .environment
            .clone()
            .unwrap_or_else(|| environments::NATIVE.to_owned());
        let environment = Environment::parse(&environment_name)
            .ok_or_else(|| Refused::Asked(format!("{environment_name:?} is not an environment")))?;
        if let Environment::Wsl(_) = environment
            && !environments::list().await.contains(&environment_name)
        {
            return Err(Refused::Asked(format!(
                "{environment_name:?} is not a WSL distro on this computer"
            )));
        }
        let launch = shell::launch(&environment, asked.shell.as_deref(), asked.cwd.as_deref())
            .map_err(|refusal| Refused::Asked(refusal.0))?;
        let cols = asked
            .cols
            .filter(|cols| *cols > 0)
            .unwrap_or(DEFAULT_SIZE.0);
        let rows = asked
            .rows
            .filter(|rows| *rows > 0)
            .unwrap_or(DEFAULT_SIZE.1);
        let key = (uplink.to_owned(), asked.session.clone());
        {
            let sessions = self.sessions.lock().expect("terminals poisoned");
            if sessions.contains_key(&key) {
                return Err(Refused::Exists);
            }
            if sessions.len() >= MAX_TERMINALS
                || sessions.keys().filter(|(held, _)| held == uplink).count() >= MAX_PER_UPLINK
            {
                return Err(Refused::TooMany);
            }
        }
        let terminals = Arc::downgrade(self);
        let ended_key = key.clone();
        let session_name = asked.session.clone();
        let started = tokio::task::spawn_blocking(move || {
            Session::start(
                session_name,
                environment_name,
                launch,
                cols,
                rows,
                move |ended: Ended| {
                    if let Some(terminals) = terminals.upgrade() {
                        terminals.forget(&ended_key, &ended);
                    }
                },
            )
        })
        .await
        .map_err(|error| Refused::Failed(error.to_string()))?
        .map_err(|error| Refused::Failed(format!("{error:#}")))?;
        let listed = listed(&started);
        let count = {
            let mut sessions = self.sessions.lock().expect("terminals poisoned");
            // Two creates of one name raced past the check above: the later one's program is ended at once.
            if sessions.contains_key(&key) {
                drop(sessions);
                started.end("a terminal of this name already runs");
                return Err(Refused::Exists);
            }
            sessions.insert(key, started);
            sessions.len()
        };
        log::info!(
            "terminal {} opened in {} for uplink {uplink}",
            listed.session,
            listed.environment
        );
        self.status.terminals(count);
        Ok(listed)
    }

    fn forget(&self, key: &Key, ended: &Ended) {
        let count = {
            let mut sessions = self.sessions.lock().expect("terminals poisoned");
            sessions.remove(key);
            sessions.len()
        };
        log::info!(
            "terminal {} of uplink {} ended (code {}{})",
            key.1,
            key.0,
            ended.code,
            ended
                .reason
                .as_deref()
                .map(|reason| format!(", {reason}"))
                .unwrap_or_default()
        );
        self.status.terminals(count);
    }

    pub fn list(&self, uplink: &str) -> Vec<Listed> {
        let mut listed: Vec<Listed> = self
            .sessions
            .lock()
            .expect("terminals poisoned")
            .iter()
            .filter(|((held, _), _)| held == uplink)
            .map(|(_, session)| listed(session))
            .collect();
        listed.sort_by_key(|terminal| terminal.created_at);
        listed
    }

    pub fn get(&self, uplink: &str, session: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .expect("terminals poisoned")
            .get(&(uplink.to_owned(), session.to_owned()))
            .cloned()
    }

    /// Ends one terminal; false when the uplink has none of that name.
    pub fn end(&self, uplink: &str, session: &str, reason: &str) -> bool {
        match self.get(uplink, session) {
            Some(session) => {
                session.end(reason);
                true
            }
            None => false,
        }
    }

    /// Ends every terminal of one uplink, or of every uplink.
    pub fn end_all(&self, uplink: Option<&str>, reason: &str) {
        let ending: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .expect("terminals poisoned")
            .iter()
            .filter(|((held, _), _)| uplink.is_none_or(|uplink| held == uplink))
            .map(|(_, session)| session.clone())
            .collect();
        for session in ending {
            session.end(reason);
        }
    }

    pub fn count(&self) -> usize {
        self.sessions.lock().expect("terminals poisoned").len()
    }
}

fn listed(session: &Session) -> Listed {
    Listed {
        session: session.info.session.clone(),
        title: session.info.title.lock().expect("title poisoned").clone(),
        environment: session.info.environment.clone(),
        created_at: session.info.created_at,
        viewers: session.info.viewers.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_name_is_what_a_path_and_a_token_can_carry() {
        assert!(valid_session("t-AbC_09"));
        assert!(valid_session(&"x".repeat(64)));
        assert!(!valid_session(""));
        assert!(!valid_session(&"x".repeat(65)));
        assert!(!valid_session("../etc"));
        assert!(!valid_session("a b"));
    }

    #[test]
    fn a_create_reads_the_daemons_body_and_refuses_a_field_it_does_not_know() {
        let asked: Create = serde_json::from_str(
            r#"{"session":"t-1","environment":"wsl:Ubuntu","cols":120,"rows":40}"#,
        )
        .unwrap();
        assert_eq!(asked.session, "t-1");
        assert_eq!(asked.environment.as_deref(), Some("wsl:Ubuntu"));
        assert_eq!((asked.cols, asked.rows), (Some(120), Some(40)));
        assert!(
            serde_json::from_str::<Create>(r#"{"session":"t-1","command":"rm -rf /"}"#).is_err()
        );
    }
}
