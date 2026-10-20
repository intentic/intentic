//! Notifications: registering this phone's FCM token on the platform's relay for each sandbox and subscribing that
//! relay channel on each daemon, and keeping the `/events` stream shut while the app is out of sight, since a
//! connected stream counts as present and a present member is not notified.

use super::{Client, session_key};
use crate::bridge::Outcome;
use crate::net::Auth;
use crate::session::SessionError;
use crate::wire::act::Accepted;
use crate::wire::platform::{
    PUSH_REGISTER, PUSH_UNREGISTER, PushApp, PushDevice, PushDeviceId, PushGrant, PushPlatform,
    SandboxSummary,
};
use crate::wire::push::{
    NOTIFICATION, PushChannel, PushChannelId, SUBSCRIBE, SentNotification, UNSUBSCRIBE,
    notification_query,
};
use crate::wire::session::DaemonSession;
use serde::{Deserialize, Serialize};

/// What one sandbox's relay registration is, kept so a rotated token can retire the old one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Registered {
    token: String,
    device_id: String,
}

fn push_key(sandbox: &str) -> String {
    format!("push:{sandbox}")
}

impl Client {
    /// Registers `token` for every sandbox this account can open; a sandbox already registered under it is left be.
    pub(super) async fn register_push(&'static self, token: String) -> Result<(), SessionError> {
        let (cookie, sandboxes) = {
            let state = self.state.lock().await;
            let cookie = state
                .platform
                .clone()
                .ok_or(SessionError::SignedOut)?
                .cookie;
            (cookie, state.sandboxes.clone())
        };
        let mut failed = None;
        for sandbox in &sandboxes {
            if let Err(error) = self.register_one(&cookie, sandbox, &token).await {
                log::info!("push on {}: {error}", sandbox.id);
                failed = Some(error);
            }
        }
        failed.map_or(Ok(()), Err)
    }

    async fn register_one(
        &self,
        cookie: &str,
        sandbox: &SandboxSummary,
        token: &str,
    ) -> Result<(), SessionError> {
        let held: Option<Registered> = self.stored(|store| store.get_json(&push_key(&sandbox.id)));
        if held.as_ref().is_some_and(|held| held.token == token) {
            return Ok(());
        }
        let device = PushDevice {
            platform: PushPlatform::Android,
            token: token.to_owned(),
            app: Some(PushApp::Editor),
            sandbox: Some(sandbox.id.clone()),
        };
        let url = format!("{}{}", self.config.api_url, PUSH_REGISTER.path);
        let headers = [("origin", self.config.web_url.as_str())];
        let grant: PushGrant = self
            .http
            .json(
                reqwest::Method::POST,
                &url,
                Auth::Cookie(cookie),
                &headers,
                Some(&device),
            )
            .await?
            .value;
        let device_id = grant.device_id.clone();
        let (base, session) = self.daemon_for(cookie, sandbox).await?;
        let _: Accepted = self
            .http
            .json(
                reqwest::Method::POST,
                &format!("{base}{}", SUBSCRIBE.path),
                Auth::Bearer(&session.token),
                &[],
                Some(&PushChannel::from(grant)),
            )
            .await?
            .value;
        self.stored(|store| {
            store.put_json(
                &push_key(&sandbox.id),
                &Registered {
                    token: token.to_owned(),
                    device_id: device_id.clone(),
                },
            )
        });
        // The old token's channel would only ever fail: retire it on both ends, best effort.
        if let Some(old) = held.filter(|old| old.device_id != device_id) {
            let _ = self
                .http
                .json::<serde_json::Value>(
                    reqwest::Method::POST,
                    &format!("{base}{}", UNSUBSCRIBE.path),
                    Auth::Bearer(&session.token),
                    &[],
                    Some(&PushChannelId {
                        id: old.device_id.clone(),
                    }),
                )
                .await;
            let _ = self
                .http
                .json::<serde_json::Value>(
                    reqwest::Method::POST,
                    &format!("{}{}", self.config.api_url, PUSH_UNREGISTER.path),
                    Auth::Cookie(cookie),
                    &headers,
                    Some(&PushDeviceId {
                        device_id: old.device_id,
                    }),
                )
                .await;
        }
        Ok(())
    }

    /// A daemon session for any sandbox, not only the open one: the held one, or one minted and kept.
    async fn daemon_for(
        &self,
        cookie: &str,
        sandbox: &SandboxSummary,
    ) -> Result<(String, DaemonSession), SessionError> {
        let key = session_key(&sandbox.id);
        let held: Option<DaemonSession> = self.stored(|store| {
            Ok(store
                .secret(&key)?
                .and_then(|json| serde_json::from_str(&json).ok()))
        });
        let session = self
            .platform()
            .daemon_session(cookie, sandbox, held.as_ref(), super::link::now())
            .await?;
        if held.as_ref() != Some(&session) {
            let json = serde_json::to_string(&session).unwrap_or_default();
            self.stored(|store| store.put_secret(&key, &json));
        }
        let base = sandbox.daemon_url.clone().ok_or(SessionError::NoAddress)?;
        Ok((base, session))
    }

    /// What the notification `tag` from `sandbox` said. The app may have been started by the notification itself, so
    /// the sandbox is looked for among the kept ones too.
    pub(super) async fn notification(
        &self,
        sandbox: &str,
        tag: &str,
    ) -> Result<Outcome, SessionError> {
        let (cookie, mut sandboxes) = {
            let state = self.state.lock().await;
            let cookie = state.platform.clone().map(|platform| platform.cookie);
            (cookie, state.sandboxes.clone())
        };
        let cookie = match cookie {
            Some(cookie) => cookie,
            None => self
                .stored(|store| store.secret(super::PLATFORM))
                .ok_or(SessionError::SignedOut)?,
        };
        if sandboxes.is_empty() {
            sandboxes = self
                .stored(|store| store.get_json(super::SANDBOXES))
                .unwrap_or_default();
        }
        let summary = sandboxes
            .iter()
            .find(|summary| summary.id == sandbox)
            .ok_or(SessionError::NoAddress)?;
        let (base, session) = self.daemon_for(&cookie, summary).await?;
        let url = format!("{base}{}{}", NOTIFICATION.path, notification_query(tag));
        let sent = self
            .http
            .json::<SentNotification>(
                reqwest::Method::GET,
                &url,
                Auth::Bearer(&session.token),
                &[],
                None::<&()>,
            )
            .await;
        Ok(match sent {
            Ok(answer) => Outcome::Notification {
                title: Some(answer.value.title),
                body: Some(answer.value.body),
                url: answer.value.url,
                require_interaction: answer.value.require_interaction.unwrap_or(false),
                silent: answer.value.silent.unwrap_or(false),
            },
            Err(crate::net::HttpError::Status { status: 404, .. }) => Outcome::Notification {
                title: None,
                body: None,
                url: None,
                require_interaction: false,
                silent: false,
            },
            Err(error) => return Err(error.into()),
        })
    }

    /// The credentials the shared WebView signs in with: the platform cookie, and a daemon session for `sandbox` (the
    /// open one when absent), minted if none is held.
    pub(super) async fn web_session(
        &self,
        sandbox: Option<String>,
    ) -> Result<Outcome, SessionError> {
        let (cookie, sandboxes, open) = {
            let state = self.state.lock().await;
            let cookie = state
                .platform
                .clone()
                .ok_or(SessionError::SignedOut)?
                .cookie;
            (cookie, state.sandboxes.clone(), state.open.clone())
        };
        let daemon = match sandbox
            .or(open)
            .and_then(|id| sandboxes.into_iter().find(|summary| summary.id == id))
        {
            Some(summary) => {
                let (_, session) = self.daemon_for(&cookie, &summary).await?;
                Some(crate::bridge::WebDaemonSession {
                    sandbox: summary.id,
                    token: session.token,
                    expires_at: session.expires_at.0 as f64,
                    email: session.email,
                })
            }
            None => None,
        };
        Ok(Outcome::WebSession {
            api_url: self.config.api_url.clone(),
            cookie,
            daemon,
        })
    }

    /// The app came into sight or left it: the open sandbox's link runs only while it is in sight.
    pub(super) async fn visible(&'static self, visible: bool) {
        if visible {
            let open = self.state.lock().await.open.clone();
            let running = self
                .state
                .lock()
                .await
                .link
                .as_ref()
                .is_some_and(|link| !link.is_finished());
            if let Some(open) = open
                && !running
            {
                self.open(open).await;
            }
        } else if let Some(link) = self.state.lock().await.link.take() {
            link.abort();
        }
    }
}
