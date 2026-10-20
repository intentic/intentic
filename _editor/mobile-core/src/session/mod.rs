//! Who the app is signed in as, on the platform and on each sandbox. The platform session is Better Auth's cookie:
//! the platform runs no bearer plugin, so the signed cookie value is the credential, kept whole. A sandbox's session
//! is the daemon's own 30-day token, minted from a proof the platform vouches for (an identity assertion) and renewed
//! with itself inside its last week, the way the web client keeps it (`sandboxSession.ts`).

use crate::net::{Auth, Http, HttpError};
use crate::wire::auth::{
    EmailCodeKind, EmailCodeRequest, EmailCodeSignIn, GOOGLE_SIGN_IN, GoogleSignIn, OneTimeToken,
    SEND_EMAIL_CODE, SESSION_COOKIE, SIGN_IN_EMAIL_CODE, SIGN_OUT, SignedIn, VERIFY_ONE_TIME_TOKEN,
    Verified,
};
use crate::wire::platform::{
    DESKTOP_REDEEM, HandoffRedeem, IDENTITY_ASSERTION, ME, MintedProof, Redeemed, SANDBOX_LIST,
    SandboxId, SandboxList, SandboxSummary, User, WAKE,
};
use crate::wire::session::{CONNECT_TOKEN_HEADER, DaemonSession, SESSION, SessionRefusal};
use crate::wire::{Endpoint, Method, Millis};
use serde::Serialize;
use serde::de::DeserializeOwned;

/// A daemon session is renewed once it has less than this left: the web client's seven days.
const RENEW_WITHIN_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Http(#[from] HttpError),
    #[error("the platform signed in without setting its session cookie")]
    NoCookie,
    #[error("signed out")]
    SignedOut,
    #[error("this sandbox has no address yet")]
    NoAddress,
    #[error("the sandbox refused: {0:?}")]
    Refused(SessionRefusal),
}

/// A platform sign-in: the cookie that is the session, and whose it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedInAs {
    pub cookie: String,
    pub email: String,
}

fn method(endpoint: &Endpoint) -> reqwest::Method {
    match endpoint.method {
        Method::Get => reqwest::Method::GET,
        _ => reqwest::Method::POST,
    }
}

/// The platform, reached at `api` (`https://api.intentic.dev`) on behalf of the web origin `web`.
pub struct Platform<'a> {
    pub http: &'a Http,
    pub api: &'a str,
    pub web: &'a str,
}

impl Platform<'_> {
    async fn call<O: DeserializeOwned>(
        &self,
        endpoint: &Endpoint,
        cookie: Option<&str>,
        body: Option<&impl Serialize>,
    ) -> Result<(O, Vec<String>), SessionError> {
        let url = format!("{}{}", self.api, endpoint.path);
        // Better Auth refuses a cookie-carrying POST without an Origin it trusts; the web origin is the one it does.
        let headers = [("origin", self.web)];
        let auth = cookie.map_or(Auth::None, Auth::Cookie);
        match self
            .http
            .json(method(endpoint), &url, auth, &headers, body)
            .await
        {
            Ok(answer) => Ok((answer.value, answer.cookies)),
            Err(HttpError::Status { status: 401, .. }) => Err(SessionError::SignedOut),
            Err(error) => Err(error.into()),
        }
    }

    async fn signed_in(
        &self,
        endpoint: &Endpoint,
        body: &impl Serialize,
    ) -> Result<SignedInAs, SessionError> {
        let (answer, cookies): (SignedIn, _) = self.call(endpoint, None, Some(body)).await?;
        Ok(SignedInAs {
            cookie: session_cookie(&cookies).ok_or(SessionError::NoCookie)?,
            email: answer.user.email,
        })
    }

    pub async fn send_email_code(&self, email: &str) -> Result<(), SessionError> {
        let body = EmailCodeRequest {
            email: email.to_owned(),
            kind: EmailCodeKind::SignIn,
        };
        self.call::<serde_json::Value>(&SEND_EMAIL_CODE, None, Some(&body))
            .await?;
        Ok(())
    }

    pub async fn sign_in_email(&self, email: &str, code: &str) -> Result<SignedInAs, SessionError> {
        let body = EmailCodeSignIn {
            email: email.to_owned(),
            otp: code.to_owned(),
        };
        self.signed_in(&SIGN_IN_EMAIL_CODE, &body).await
    }

    /// Signs in with a Google ID token minted for the web client id, which the platform and every daemon accept.
    pub async fn sign_in_google(&self, id_token: &str) -> Result<SignedInAs, SessionError> {
        let body = GoogleSignIn {
            id_token: id_token.to_owned(),
        };
        self.signed_in(&GOOGLE_SIGN_IN, &body).await
    }

    /// Finishes a sign-in made in the browser: the handoff the `intentic://` link carried, spent with the PKCE verifier
    /// only this app held, for a one-time token that opens a session of its own.
    pub async fn redeem(&self, handoff: &str, verifier: &str) -> Result<SignedInAs, SessionError> {
        let body = HandoffRedeem {
            handoff: handoff.to_owned(),
            verifier: verifier.to_owned(),
        };
        let (redeemed, _): (Redeemed, _) = self.call(&DESKTOP_REDEEM, None, Some(&body)).await?;
        let token = OneTimeToken {
            token: redeemed.ott,
        };
        let (verified, cookies): (Verified, _) = self
            .call(&VERIFY_ONE_TIME_TOKEN, None, Some(&token))
            .await?;
        Ok(SignedInAs {
            cookie: session_cookie(&cookies).ok_or(SessionError::NoCookie)?,
            email: verified.user.email,
        })
    }

    pub async fn sign_out(&self, cookie: &str) -> Result<(), SessionError> {
        self.call::<serde_json::Value>(&SIGN_OUT, Some(cookie), Some(&serde_json::json!({})))
            .await?;
        Ok(())
    }

    /// Whose session `cookie` is; `None` once it has ended.
    pub async fn me(&self, cookie: &str) -> Result<Option<User>, SessionError> {
        match self
            .call::<Option<User>>(&ME, Some(cookie), None::<&()>)
            .await
        {
            Ok((user, _)) => Ok(user),
            Err(SessionError::SignedOut) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn sandboxes(&self, cookie: &str) -> Result<Vec<SandboxSummary>, SessionError> {
        let (list, _): (SandboxList, _) =
            self.call(&SANDBOX_LIST, Some(cookie), None::<&()>).await?;
        Ok(list.sandboxes)
    }

    /// Asks the platform to start a hosted sandbox that is asleep.
    pub async fn wake(&self, cookie: &str, sandbox: &str) -> Result<(), SessionError> {
        let body = SandboxId {
            sandbox_id: sandbox.to_owned(),
        };
        self.call::<serde_json::Value>(&WAKE, Some(cookie), Some(&body))
            .await?;
        Ok(())
    }

    /// A session on `sandbox`'s daemon: `held` itself while it has more than a week left, `held` renewed while it is
    /// still alive, or a fresh one minted from an identity assertion.
    pub async fn daemon_session(
        &self,
        cookie: &str,
        sandbox: &SandboxSummary,
        held: Option<&DaemonSession>,
        now: Millis,
    ) -> Result<DaemonSession, SessionError> {
        let base = sandbox
            .daemon_url
            .as_deref()
            .ok_or(SessionError::NoAddress)?;
        if let Some(held) = held {
            if held.expires_at.0 - now.0 > RENEW_WITHIN_MS {
                return Ok(held.clone());
            }
            if held.expires_at > now
                && let Ok(renewed) = exchange(self.http, base, &held.token, None).await
            {
                return Ok(renewed);
            }
        }
        let proof = self.identity_assertion(cookie, &sandbox.id).await?;
        exchange(self.http, base, &proof, sandbox.token.as_deref()).await
    }

    /// A proof the platform vouches for, good for one call on `sandbox`'s daemon within two minutes.
    pub async fn identity_assertion(
        &self,
        cookie: &str,
        sandbox: &str,
    ) -> Result<String, SessionError> {
        let body = SandboxId {
            sandbox_id: sandbox.to_owned(),
        };
        let (proof, _): (MintedProof, _) = self
            .call(&IDENTITY_ASSERTION, Some(cookie), Some(&body))
            .await?;
        Ok(proof.assertion)
    }
}

/// Trades a proof (an assertion, a Google ID token, or a live session token) for a daemon session.
async fn exchange(
    http: &Http,
    base: &str,
    proof: &str,
    connect: Option<&str>,
) -> Result<DaemonSession, SessionError> {
    let url = format!("{base}{}", SESSION.path);
    let headers: Vec<(&str, &str)> = connect
        .map(|token| (CONNECT_TOKEN_HEADER, token))
        .into_iter()
        .collect();
    match http
        .json(
            reqwest::Method::POST,
            &url,
            Auth::Bearer(proof),
            &headers,
            None::<&()>,
        )
        .await
    {
        Ok(answer) => Ok(answer.value),
        Err(HttpError::Status { status, body }) => {
            Err(SessionError::Refused(SessionRefusal::of(status, &body)))
        }
        Err(error) => Err(error.into()),
    }
}

/// The session cookie's `name=value` among those an answer set.
fn session_cookie(cookies: &[String]) -> Option<String> {
    cookies
        .iter()
        .find(|cookie| cookie.starts_with(&format!("{SESSION_COOKIE}=")))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_session_cookie_whole_and_only_it() {
        let cookies = [
            "__Secure-better-auth.session_data=abc".to_owned(),
            format!("{SESSION_COOKIE}=tok.sig%3D"),
        ];
        assert_eq!(
            session_cookie(&cookies),
            Some(format!("{SESSION_COOKIE}=tok.sig%3D"))
        );
        assert_eq!(session_cookie(&cookies[..1]), None);
    }
}
