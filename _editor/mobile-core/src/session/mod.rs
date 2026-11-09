//! Who the app is signed in as, on the platform and on each sandbox. The platform session is Better Auth's cookie:
//! the platform runs no bearer plugin, so the signed cookie value is the credential, kept whole. A sandbox's session
//! is the daemon's own 30-day token, minted from a proof the platform vouches for (an identity assertion) and renewed
//! with itself inside its last week, the way the web client keeps it (`sandboxSession.ts`).

use crate::net::{Answer, Auth, Http, HttpError, refusal_names};
use crate::wire::auth::{
    EmailCodeKind, EmailCodeRequest, EmailCodeSignIn, GOOGLE_SIGN_IN, GoogleSignIn, OneTimeToken,
    SEND_EMAIL_CODE, SESSION_COOKIE, SIGN_IN_EMAIL_CODE, SIGN_OUT, SignedIn, VERIFY_ONE_TIME_TOKEN,
    Verified,
};
use crate::wire::platform::{
    DESKTOP_REDEEM, HandoffRedeem, IDENTITY, IDENTITY_ASSERTION, ME, MintedProof, PlatformIdentity,
    Redeemed, SANDBOX_LIST, SandboxId, SandboxList, SandboxSummary, User, WAKE,
};
use crate::wire::session::{CONNECT_TOKEN_HEADER, DaemonSession, SESSION, SessionRefusal};
use crate::wire::{Endpoint, Method, Millis};
use serde::Serialize;
use serde::de::DeserializeOwned;

/// A daemon session is renewed once it has less than this left: the web client's seven days.
const RENEW_WITHIN_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// How long the platform gets to say which database it reads, the web client's five seconds: a refresh waits on it.
const IDENTITY_PATIENCE: std::time::Duration = std::time::Duration::from_secs(5);

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
    /// One call, its answer whole. Signed out only on a 401 whose body is the platform's own error, oRPC's and Better
    /// Auth's alike naming its `code`: a 401 page from something in front of the api (a proxy's sign-in wall, an outage
    /// page) stays an error like a 5xx, since signing out forgets everything the app keeps.
    async fn answer<O: DeserializeOwned>(
        &self,
        endpoint: &Endpoint,
        cookie: Option<&str>,
        body: Option<&impl Serialize>,
    ) -> Result<Answer<O>, SessionError> {
        let url = format!("{}{}", self.api, endpoint.path);
        // Better Auth refuses a cookie-carrying POST without an Origin it trusts; the web origin is the one it does.
        let headers = [("origin", self.web)];
        let auth = cookie.map_or(Auth::None, Auth::Cookie);
        match self
            .http
            .json(method(endpoint), &url, auth, &headers, body)
            .await
        {
            Ok(answer) => Ok(answer),
            Err(HttpError::Status { status: 401, body }) if refusal_names(&body, &["code"]) => {
                Err(SessionError::SignedOut)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn call<O: DeserializeOwned>(
        &self,
        endpoint: &Endpoint,
        cookie: Option<&str>,
        body: Option<&impl Serialize>,
    ) -> Result<(O, Vec<String>), SessionError> {
        let answer = self.answer(endpoint, cookie, body).await?;
        Ok((answer.value, answer.cookies))
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

    /// Whose session `cookie` is; `None` once it has ended, which the caller acts on by forgetting everything. So only
    /// the platform's own two words for that are `None`: a 200 whose body is JSON `null`, and a 401 carrying its own
    /// error. Better Auth and the api answer 500 when their database fails, never `null`; an empty 200, a page, a body
    /// that is not a user, a 5xx or no answer at all is an error, which keeps the session and everything kept with it.
    pub async fn me(&self, cookie: &str) -> Result<Option<User>, SessionError> {
        match self
            .answer::<Option<User>>(&ME, Some(cookie), None::<&()>)
            .await
        {
            Ok(answer) if answer.empty => Err(SessionError::Http(HttpError::Decode(
                "an empty answer says nothing about the session".into(),
            ))),
            Ok(answer) => Ok(answer.value),
            Err(SessionError::SignedOut) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Which database the platform reads (`GET /api/identity`, no session): random per database, so a different one
    /// than a kept list came from means that list's rows were not deleted, only not found. `None` when it cannot say.
    pub async fn identity(&self) -> Option<String> {
        let url = format!("{}{}", self.api, IDENTITY.path);
        let asked = self.http.json::<PlatformIdentity>(
            method(&IDENTITY),
            &url,
            Auth::None,
            &[],
            None::<&()>,
        );
        match tokio::time::timeout(IDENTITY_PATIENCE, asked).await {
            Ok(Ok(answer)) => Some(answer.value.identity).filter(|identity| !identity.is_empty()),
            Ok(Err(error)) => {
                log::info!("identity: {error}");
                None
            }
            Err(_) => None,
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
    use wiremock::matchers::{method as with_method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const UNAUTHORIZED: &str =
        r#"{"defined":false,"code":"UNAUTHORIZED","status":401,"message":"Unauthorized"}"#;

    // A platform answering `route` with `status` and `body` as JSON (or HTML, when it starts with `<`).
    async fn answering(route: &str, status: u16, body: &str) -> MockServer {
        let server = MockServer::start().await;
        let kind = if body.starts_with('<') {
            "text/html"
        } else {
            "application/json"
        };
        Mock::given(with_method("GET"))
            .and(path(route))
            .respond_with(ResponseTemplate::new(status).set_body_raw(body.to_owned(), kind))
            .mount(&server)
            .await;
        server
    }

    fn platform<'a>(http: &'a Http, api: &'a str) -> Platform<'a> {
        Platform {
            http,
            api,
            web: "https://app.test",
        }
    }

    // Ending the session forgets everything the app keeps, so only the platform's own two words for it end it.
    #[tokio::test]
    async fn only_a_null_or_the_platforms_own_401_ends_the_session() {
        let http = Http::new();
        for (status, body) in [(200, "null"), (401, UNAUTHORIZED)] {
            let server = answering(ME.path, status, body).await;
            let me = platform(&http, &server.uri()).me("session=abc").await;
            assert!(matches!(me, Ok(None)), "{status} {body}: {me:?}");
        }
        let user = r#"{"id":"usr_1","email":"ada@example.com","name":"Ada","image":null}"#;
        let server = answering(ME.path, 200, user).await;
        let me = platform(&http, &server.uri()).me("session=abc").await;
        assert_eq!(me.unwrap().unwrap().email, "ada@example.com");
    }

    #[tokio::test]
    async fn an_outage_or_a_page_in_front_of_the_api_keeps_the_session() {
        let http = Http::new();
        for (status, body) in [
            (200, ""),
            (
                200,
                "<!DOCTYPE html><html><body>We'll be right back</body></html>",
            ),
            (200, "{}"),
            (200, r#""null""#),
            (401, "<html><body>Sign in to continue</body></html>"),
            (401, ""),
            (401, r#"{"message":"Unauthorized"}"#),
            (
                500,
                r#"{"code":"INTERNAL_SERVER_ERROR","message":"Failed to get session"}"#,
            ),
            (502, "<html>Bad Gateway</html>"),
            (503, ""),
        ] {
            let server = answering(ME.path, status, body).await;
            let me = platform(&http, &server.uri()).me("session=abc").await;
            assert!(me.is_err(), "{status} {body}: {me:?}");
            assert!(
                !matches!(me, Err(SessionError::SignedOut)),
                "{status} {body}"
            );
        }
        // Nothing listening at all.
        let me = platform(&http, "http://127.0.0.1:1")
            .me("session=abc")
            .await;
        assert!(
            matches!(me, Err(SessionError::Http(HttpError::Network(_)))),
            "{me:?}"
        );
    }

    #[tokio::test]
    async fn the_list_signs_out_only_on_the_platforms_own_401() {
        let http = Http::new();
        let server = answering(SANDBOX_LIST.path, 401, UNAUTHORIZED).await;
        let listed = platform(&http, &server.uri())
            .sandboxes("session=abc")
            .await;
        assert!(matches!(listed, Err(SessionError::SignedOut)), "{listed:?}");
        for (status, body) in [
            (401, "<html><body>Sign in to continue</body></html>"),
            (200, "<html><body>Sign in to continue</body></html>"),
            (200, ""),
            (500, UNAUTHORIZED),
        ] {
            let server = answering(SANDBOX_LIST.path, status, body).await;
            let listed = platform(&http, &server.uri())
                .sandboxes("session=abc")
                .await;
            assert!(
                matches!(listed, Err(SessionError::Http(_))),
                "{status} {body}: {listed:?}"
            );
        }
    }

    #[tokio::test]
    async fn the_platform_names_its_database_or_nothing() {
        let http = Http::new();
        let named = r#"{"identity":"db-1","since":"2026-10-02T08:00:00.000Z"}"#;
        let server = answering(IDENTITY.path, 200, named).await;
        assert_eq!(
            platform(&http, &server.uri()).identity().await.as_deref(),
            Some("db-1")
        );
        for (status, body) in [
            (200, "<html>placeholder</html>"),
            (200, r#"{"identity":""}"#),
            (200, r#"{"identity":"","since":"2026-10-02T08:00:00.000Z"}"#),
            (404, r#"{"error":"Not Found"}"#),
            (503, ""),
        ] {
            let server = answering(IDENTITY.path, status, body).await;
            assert_eq!(
                platform(&http, &server.uri()).identity().await,
                None,
                "{status} {body}"
            );
        }
    }

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
