//! The client the app drives: the platform session, the sandboxes, and the open sandbox's link. It keeps what it
//! learns in the store and says it as whole-state events, store first, so a cold start shows the last board before
//! any network answers.

mod act;
mod board;
mod conversations;
mod link;
mod passkey;
mod push;

use crate::bridge::{Config, Event, Outcome, Request, SandboxRow, SessionState};
use crate::conversation::Conversation;
use crate::net::Auth;
use crate::net::Http;
use crate::session::{Platform, SessionError, SignedInAs};
use crate::store::{Store, StoreError};
use crate::wire::agents::AgentSummary;
use crate::wire::attach::{AgentTranscript, TRANSCRIPT, transcript_query};
use crate::wire::platform::SandboxSummary;
use crate::wire::session::DaemonSession;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::task::JoinHandle;

pub(crate) type Sink = Box<dyn Fn(Event) + Send + Sync>;

// Store keys. Secrets: the platform cookie, and one daemon session per sandbox (`sandbox:<id>`).
const PLATFORM: &str = "platform";
const EMAIL: &str = "email";
const SANDBOXES: &str = "sandboxes";
const OPEN: &str = "open";

fn failed(error: SessionError) -> Outcome {
    // A refusal's body names its case: Better Auth's `{code, message}` and oRPC's `{code, message, ...}` alike.
    let code = match &error {
        SessionError::Http(crate::net::HttpError::Status { status, body }) => {
            serde_json::from_str::<crate::wire::auth::AuthError>(body)
                .ok()
                .and_then(|refusal| refusal.code)
                // Better Auth's rate limiter answers a bare 429.
                .or_else(|| (*status == 429).then(|| "TOO_MANY_REQUESTS".to_owned()))
        }
        _ => None,
    };
    Outcome::Failed {
        message: error.to_string(),
        code,
    }
}

fn board_key(sandbox: &str) -> String {
    format!("board:{sandbox}")
}

fn session_key(sandbox: &str) -> String {
    format!("sandbox:{sandbox}")
}

#[derive(Default)]
struct State {
    platform: Option<SignedInAs>,
    sandboxes: Vec<SandboxSummary>,
    open: Option<String>,
    link: Option<JoinHandle<()>>,
}

pub(crate) struct Client {
    http: Http,
    config: Config,
    store: Mutex<Store>,
    events: Sink,
    state: tokio::sync::Mutex<State>,
    /// The conversations the app has open, by agent id: read by the JNI row functions, so behind a plain lock.
    conversations: Mutex<HashMap<String, conversations::Open>>,
}

impl Client {
    pub(crate) fn new(config: Config, store: Store, events: Sink) -> Client {
        Client {
            http: Http::new(),
            config,
            store: Mutex::new(store),
            events,
            state: tokio::sync::Mutex::new(State::default()),
            conversations: Mutex::new(HashMap::new()),
        }
    }

    /// `agent`'s rows, for the app's list to read.
    pub(crate) fn conversation(&self, agent: &str) -> Option<Arc<Mutex<Conversation>>> {
        let open = self.conversations.lock().ok()?;
        open.get(agent).map(|open| open.rows.clone())
    }

    /// The open sandbox's daemon address and session token, once the link has minted one.
    async fn daemon(&self, sandbox: &str) -> Option<(String, String)> {
        let base = {
            let state = self.state.lock().await;
            state
                .sandboxes
                .iter()
                .find(|summary| summary.id == sandbox)?
                .daemon_url
                .clone()?
        };
        let session: Option<DaemonSession> = self.stored(|store| {
            Ok(store
                .secret(&session_key(sandbox))?
                .and_then(|json| serde_json::from_str(&json).ok()))
        });
        Some((base, session?.token))
    }

    async fn open_conversation(&'static self, agent: String) {
        let Some(sandbox) = self.state.lock().await.open.clone() else {
            return;
        };
        let Ok(mut open) = self.conversations.lock() else {
            return;
        };
        if open.contains_key(&agent) {
            return;
        }
        // The board knows whether a run is going; until it says, try attaching once.
        let (runs, watching) = tokio::sync::watch::channel(Some(String::new()));
        let rows = Arc::new(Mutex::new(Conversation::default()));
        let task = tokio::spawn(conversations::follow(
            self,
            sandbox,
            agent.clone(),
            rows.clone(),
            watching,
        ));
        open.insert(agent, conversations::Open { rows, task, runs });
    }

    fn close_conversation(&self, agent: &str) {
        if let Ok(mut open) = self.conversations.lock()
            && let Some(open) = open.remove(agent)
        {
            open.task.abort();
        }
    }

    fn close_conversations(&self) {
        if let Ok(mut open) = self.conversations.lock() {
            for (_, open) in open.drain() {
                open.task.abort();
            }
        }
    }

    /// A send started `run` in `agent`'s conversation: attach to it now rather than when the board says so.
    fn run_started(&self, agent: &str, run: String) {
        if let Ok(open) = self.conversations.lock()
            && let Some(open) = open.get(agent)
        {
            open.runs.send_replace(Some(run));
        }
    }

    /// Tells each open conversation its agent's run as the board now sees it.
    fn runs_changed(&self, agents: &[AgentSummary]) {
        let Ok(open) = self.conversations.lock() else {
            return;
        };
        for agent in agents {
            if let Some(open) = open.get(&agent.id) {
                open.runs.send_if_modified(|run| {
                    let changed = *run != agent.run;
                    *run = agent.run.clone();
                    changed
                });
            }
        }
    }

    async fn older_rows(&self, agent: &str) -> Result<(), SessionError> {
        let Some(rows) = self.conversation(agent) else {
            return Ok(());
        };
        let Some(sandbox) = self.state.lock().await.open.clone() else {
            return Ok(());
        };
        let Some((base, token)) = self.daemon(&sandbox).await else {
            return Ok(());
        };
        let Some(before) = rows
            .lock()
            .ok()
            .filter(|held| held.more())
            .map(|held| held.from())
        else {
            return Ok(());
        };
        let url = format!(
            "{base}{}{}",
            TRANSCRIPT.path_with(&[("id", agent)]),
            transcript_query(Some(before), Some(10))
        );
        let page = self
            .http
            .json::<AgentTranscript>(
                reqwest::Method::GET,
                &url,
                Auth::Bearer(&token),
                &[],
                None::<&()>,
            )
            .await?;
        if let Ok(mut held) = rows.lock()
            // Another page landed first: this one is no longer the one above.
            && held.from() == before
        {
            let change = held.older(page.value);
            self.emit(Event::Rows {
                agent: agent.to_owned(),
                count: held.len() as u32,
                change: match change {
                    crate::conversation::Change::Inserted { at, count } => {
                        crate::bridge::RowChange::Inserted {
                            at: at as u32,
                            count: count as u32,
                        }
                    }
                    _ => crate::bridge::RowChange::Reset,
                },
                live: held.live(),
                more: held.more(),
            });
        }
        Ok(())
    }

    fn platform(&self) -> Platform<'_> {
        Platform {
            http: &self.http,
            api: &self.config.api_url,
            web: &self.config.web_url,
        }
    }

    pub(crate) fn emit(&self, event: Event) {
        (self.events)(event);
    }

    /// Runs `work` on the store; a store that fails is logged and read as empty, never a crash.
    fn stored<T: Default>(&self, work: impl FnOnce(&Store) -> Result<T, StoreError>) -> T {
        match self.store.lock() {
            Ok(store) => work(&store).unwrap_or_else(|error| {
                log::warn!("store: {error}");
                T::default()
            }),
            Err(_) => T::default(),
        }
    }

    /// What the app sees first: the kept session, sandboxes and board, then the same refreshed from the network.
    pub(crate) async fn boot(&'static self) {
        let cookie: Option<String> = self.stored(|store| store.secret(PLATFORM));
        let email: Option<String> = self.stored(|store| store.get(EMAIL));
        let sandboxes: Vec<SandboxSummary> = self
            .stored(|store| store.get_json(SANDBOXES))
            .unwrap_or_default();
        let open: Option<String> = self.stored(|store| store.get(OPEN));
        let signed_in = match (cookie, email) {
            (Some(cookie), Some(email)) => Some(SignedInAs { cookie, email }),
            _ => None,
        };
        {
            let mut state = self.state.lock().await;
            state.platform = signed_in.clone();
            state.sandboxes = sandboxes;
            state.open = open.clone();
            self.say_session(&state);
            self.say_sandboxes(&state);
        }
        if let Some(open) = &open {
            let cards: Vec<AgentSummary> = self
                .stored(|store| store.get_json(&board_key(open)))
                .unwrap_or_default();
            self.say_board(open, &cards);
        }
        let Some(signed_in) = signed_in else {
            return;
        };
        match self.platform().me(&signed_in.cookie).await {
            Ok(Some(_)) => self.after_sign_in().await,
            Ok(None) => self.forget_everything().await,
            // Offline: keep showing what was kept; the link retries on its own once it runs.
            Err(error) => {
                log::info!("boot: the platform did not answer: {error}");
                self.after_sign_in().await;
            }
        }
    }

    pub(crate) async fn handle(&'static self, request: Request) -> Outcome {
        let done = match request {
            Request::Ping { echo } => return Outcome::Pong { echo },
            Request::SendEmailCode { email } => self.platform().send_email_code(&email).await,
            Request::SignInWithEmailCode { email, code } => {
                let signed_in = self.platform().sign_in_email(&email, &code).await;
                self.signed_in(signed_in).await
            }
            Request::SignInWithGoogle { id_token } => {
                let signed_in = self.platform().sign_in_google(&id_token).await;
                self.signed_in(signed_in).await
            }
            Request::RedeemHandoff { handoff, verifier } => {
                let signed_in = self.platform().redeem(&handoff, &verifier).await;
                self.signed_in(signed_in).await
            }
            Request::SignOut => {
                let cookie = self
                    .state
                    .lock()
                    .await
                    .platform
                    .clone()
                    .map(|platform| platform.cookie);
                if let Some(cookie) = cookie {
                    // Best effort: the session is forgotten here whether or not the platform heard.
                    let _ = self.platform().sign_out(&cookie).await;
                }
                self.forget_everything().await;
                Ok(())
            }
            Request::RefreshSandboxes => self.refresh_sandboxes().await,
            Request::OpenSandbox { sandbox } => {
                self.open(sandbox).await;
                Ok(())
            }
            Request::OpenConversation { agent } => {
                self.open_conversation(agent).await;
                Ok(())
            }
            Request::CloseConversation { agent } => {
                self.close_conversation(&agent);
                Ok(())
            }
            Request::OlderRows { agent } => self.older_rows(&agent).await,
            Request::Send {
                agent,
                text,
                attachments,
            } => {
                return self
                    .send(agent, text, attachments)
                    .await
                    .unwrap_or_else(failed);
            }
            Request::Steer { agent, text } => {
                return self.steer(agent, text).await.unwrap_or_else(failed);
            }
            Request::Stop { agent } => return self.stop(agent).await.unwrap_or_else(failed),
            Request::Answer { answer } => return self.answer(answer).await.unwrap_or_else(failed),
            Request::RegisterPush { token } => self.register_push(token).await,
            Request::PasskeyOptions { sandbox, register } => {
                return self
                    .passkey_options(&sandbox, register)
                    .await
                    .unwrap_or_else(failed);
            }
            Request::PasskeyResponse {
                sandbox,
                register,
                json,
            } => self.passkey_response(sandbox, register, &json).await,
            Request::WebSession { sandbox } => {
                return self.web_session(sandbox).await.unwrap_or_else(failed);
            }
            Request::Notification { sandbox, tag } => {
                return self
                    .notification(&sandbox, &tag)
                    .await
                    .unwrap_or_else(failed);
            }
            Request::Visible { visible } => {
                self.visible(visible).await;
                Ok(())
            }
            Request::OpenFixture {
                agent,
                json,
                rows,
                stream_ms,
                stream_delay_ms,
            } => {
                if crate::conversation::fixture::inflate(&json, 1).is_err() {
                    return Outcome::Failed {
                        message: "the fixture does not read".into(),
                        code: None,
                    };
                }
                self.close_conversation(&agent);
                let (runs, _) = tokio::sync::watch::channel(None);
                let held = Arc::new(Mutex::new(Conversation::default()));
                let task = tokio::spawn(conversations::fixture(
                    self,
                    agent.clone(),
                    held.clone(),
                    json,
                    rows as usize,
                    u64::from(stream_ms),
                    u64::from(stream_delay_ms),
                ));
                if let Ok(mut open) = self.conversations.lock() {
                    open.insert(
                        agent,
                        conversations::Open {
                            rows: held,
                            task,
                            runs,
                        },
                    );
                }
                Ok(())
            }
        };
        match done {
            Ok(()) => Outcome::Done,
            Err(error) => failed(error),
        }
    }

    async fn signed_in(
        &'static self,
        signed_in: Result<SignedInAs, SessionError>,
    ) -> Result<(), SessionError> {
        let signed_in = signed_in?;
        self.stored(|store| {
            store.put_secret(PLATFORM, &signed_in.cookie)?;
            store.put(EMAIL, &signed_in.email)
        });
        {
            let mut state = self.state.lock().await;
            state.platform = Some(signed_in);
            self.say_session(&state);
        }
        self.after_sign_in().await;
        Ok(())
    }

    /// Refreshes the sandboxes and connects to the open one, or the first.
    async fn after_sign_in(&'static self) {
        if let Err(error) = self.refresh_sandboxes().await {
            log::info!("sandboxes: {error}");
        }
        let next = {
            let state = self.state.lock().await;
            state
                .open
                .clone()
                .filter(|open| state.sandboxes.iter().any(|sandbox| &sandbox.id == open))
                .or_else(|| state.sandboxes.first().map(|sandbox| sandbox.id.clone()))
        };
        if let Some(next) = next {
            self.open(next).await;
        }
    }

    async fn refresh_sandboxes(&self) -> Result<(), SessionError> {
        let cookie = self
            .state
            .lock()
            .await
            .platform
            .clone()
            .map(|platform| platform.cookie);
        let Some(cookie) = cookie else {
            return Err(SessionError::SignedOut);
        };
        let sandboxes = match self.platform().sandboxes(&cookie).await {
            Err(SessionError::SignedOut) => {
                self.forget_everything().await;
                return Err(SessionError::SignedOut);
            }
            other => other?,
        };
        self.stored(|store| store.put_json(SANDBOXES, &sandboxes));
        let mut state = self.state.lock().await;
        state.sandboxes = sandboxes;
        self.say_sandboxes(&state);
        Ok(())
    }

    /// Opens `sandbox`: shows its kept board at once, then (re)starts its link.
    async fn open(&'static self, sandbox: String) {
        if self.state.lock().await.open.as_deref() != Some(sandbox.as_str()) {
            self.close_conversations();
        }
        let cards: Vec<AgentSummary> = self
            .stored(|store| store.get_json(&board_key(&sandbox)))
            .unwrap_or_default();
        self.say_board(&sandbox, &cards);
        self.stored(|store| store.put(OPEN, &sandbox));
        let mut state = self.state.lock().await;
        if let Some(link) = state.link.take() {
            link.abort();
        }
        state.open = Some(sandbox.clone());
        self.say_sandboxes(&state);
        let summary = state
            .sandboxes
            .iter()
            .find(|summary| summary.id == sandbox)
            .cloned();
        let cookie = state.platform.clone().map(|platform| platform.cookie);
        if let (Some(summary), Some(cookie)) = (summary, cookie) {
            state.link = Some(tokio::spawn(link::run(self, summary, cookie)));
        }
    }

    async fn forget_everything(&self) {
        self.close_conversations();
        self.stored(|store| store.forget_all());
        let mut state = self.state.lock().await;
        if let Some(link) = state.link.take() {
            link.abort();
        }
        *state = State::default();
        self.say_session(&state);
        self.say_sandboxes(&state);
    }

    fn say_session(&self, state: &State) {
        let state = match &state.platform {
            Some(platform) => SessionState::SignedIn {
                email: platform.email.clone(),
            },
            None => SessionState::SignedOut,
        };
        self.emit(Event::Session { state });
    }

    fn say_sandboxes(&self, state: &State) {
        let sandboxes = state
            .sandboxes
            .iter()
            .map(|sandbox| SandboxRow {
                id: sandbox.id.clone(),
                name: sandbox.name.clone(),
                role: sandbox.role.as_str().to_owned(),
                asleep: sandbox
                    .hosted
                    .as_ref()
                    .and_then(|hosted| hosted.state.as_deref())
                    .is_some_and(|hosted| hosted == "asleep"),
            })
            .collect();
        self.emit(Event::Sandboxes {
            sandboxes,
            open: state.open.clone(),
        });
    }

    fn say_board(&self, sandbox: &str, agents: &[AgentSummary]) {
        self.emit(Event::Board {
            sandbox: sandbox.to_owned(),
            cards: board::cards(agents),
        });
    }

    /// Keeps `agents` as `sandbox`'s board and says it.
    fn board_changed(&self, sandbox: &str, agents: &[AgentSummary]) {
        self.stored(|store| store.put_json(&board_key(sandbox), &agents));
        self.say_board(sandbox, agents);
        self.runs_changed(agents);
    }
}
