//! Passkeys for a sandbox that asks for one. The daemon takes this app's apk-key-hash origin for the editor's passkeys
//! once the editor's asset links name the app's certificate, so a passkey made on the web signs in here and the other
//! way round. The ceremony itself is Credential Manager's, in the app; here are the daemon calls on either side of it.

use super::{Client, session_key};
use crate::bridge::Outcome;
use crate::net::Auth;
use crate::session::SessionError;
use crate::wire::session::DaemonSession;
use serde::Deserialize;
use serde_json::Value;

const ASSERT_OPTIONS: &str = "/system/passkeys/assert/options";
const ASSERT: &str = "/system/passkeys/assert";
const REGISTER_OPTIONS: &str = "/system/passkeys/register/options";
const REGISTER: &str = "/system/passkeys/register";

#[derive(Deserialize)]
struct Registered {
    session: DaemonSession,
}

impl Client {
    /// The daemon's base, the platform cookie and this app's passkey origin, for `sandbox`.
    async fn passkey_target(
        &self,
        sandbox: &str,
    ) -> Result<(String, String, String), SessionError> {
        let origin = self.config.passkey_origin.clone().ok_or_else(|| {
            SessionError::Http(crate::net::HttpError::Decode(
                "passkeys are off in this build".into(),
            ))
        })?;
        let state = self.state.lock().await;
        let cookie = state
            .platform
            .clone()
            .ok_or(SessionError::SignedOut)?
            .cookie;
        let base = state
            .sandboxes
            .iter()
            .find(|summary| summary.id == sandbox)
            .and_then(|summary| summary.daemon_url.clone())
            .ok_or(SessionError::NoAddress)?;
        Ok((base, cookie, origin))
    }

    pub(super) async fn passkey_options(
        &self,
        sandbox: &str,
        register: bool,
    ) -> Result<Outcome, SessionError> {
        let (base, cookie, origin) = self.passkey_target(sandbox).await?;
        let headers = [("origin", origin.as_str())];
        let mut options: Value = if register {
            // Adding a passkey needs the person proven another way first: a fresh assertion, spent on this call.
            let proof = self.platform().identity_assertion(&cookie, sandbox).await?;
            let url = format!("{base}{REGISTER_OPTIONS}");
            self.http
                .json(
                    reqwest::Method::POST,
                    &url,
                    Auth::Bearer(&proof),
                    &headers,
                    Some(&serde_json::json!({})),
                )
                .await?
                .value
        } else {
            let url = format!("{base}{ASSERT_OPTIONS}");
            self.http
                .json(
                    reqwest::Method::POST,
                    &url,
                    Auth::None,
                    &headers,
                    Some(&serde_json::json!({})),
                )
                .await?
                .value
        };
        if let Some(fields) = options.as_object_mut()
            && fields.remove("available") == Some(Value::Bool(false))
        {
            return Err(SessionError::Http(crate::net::HttpError::Decode(
                "this sandbox holds no passkey for you yet".into(),
            )));
        }
        Ok(Outcome::PasskeyOptions {
            json: options.to_string(),
        })
    }

    pub(super) async fn passkey_response(
        &'static self,
        sandbox: String,
        register: bool,
        json: &str,
    ) -> Result<(), SessionError> {
        let (base, cookie, origin) = self.passkey_target(&sandbox).await?;
        let headers = [("origin", origin.as_str())];
        let response: Value = serde_json::from_str(json).map_err(|error| {
            SessionError::Http(crate::net::HttpError::Decode(error.to_string()))
        })?;
        let body = serde_json::json!({ "response": response });
        let session: DaemonSession = if register {
            let proof = self
                .platform()
                .identity_assertion(&cookie, &sandbox)
                .await?;
            let url = format!("{base}{REGISTER}");
            self.http
                .json::<Registered>(
                    reqwest::Method::POST,
                    &url,
                    Auth::Bearer(&proof),
                    &headers,
                    Some(&body),
                )
                .await?
                .value
                .session
        } else {
            let url = format!("{base}{ASSERT}");
            self.http
                .json(
                    reqwest::Method::POST,
                    &url,
                    Auth::None,
                    &headers,
                    Some(&body),
                )
                .await?
                .value
        };
        let kept = serde_json::to_string(&session).unwrap_or_default();
        self.stored(|store| store.put_secret(&session_key(&sandbox), &kept));
        // The link stopped on the step-up: with a session held, it connects now.
        if self.state.lock().await.open.as_deref() == Some(sandbox.as_str()) {
            self.open(sandbox).await;
        }
        Ok(())
    }
}
