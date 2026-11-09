//! The core's one HTTP client and what it reads: JSON calls to the platform and to a sandbox's daemon, and the
//! daemon's server-sent event streams. Credentials go per request (a daemon's bearer token, the platform's session
//! cookie), never into a shared jar, so signing out of one sandbox cannot leak into another.

pub mod sse;

use futures_util::StreamExt;
use serde::Serialize;
use serde::de::DeserializeOwned;
use sse::{Frame, SseEvent, SseParser, orpc_frame};
use std::time::Duration;

/// A daemon writes to a stream at least every five seconds (oRPC's keep-alive): this long with no bytes is a dead
/// connection, though nothing closed it. The web client gives a turn's stream the same thirty seconds.
pub const STREAM_IDLE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy)]
pub enum Auth<'a> {
    None,
    /// A daemon session token, or a proof `/system/session` exchanges for one.
    Bearer(&'a str),
    /// The platform's session cookie, `name=value`.
    Cookie(&'a str),
}

#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    #[error("no connection: {0}")]
    Network(String),
    #[error("{status}: {body}")]
    Status { status: u16, body: String },
    #[error("an answer that does not read: {0}")]
    Decode(String),
    #[error("the stream went quiet")]
    Idle,
}

impl From<reqwest::Error> for HttpError {
    fn from(error: reqwest::Error) -> Self {
        HttpError::Network(error.to_string())
    }
}

#[derive(Clone)]
pub struct Http {
    client: reqwest::Client,
}

impl Default for Http {
    fn default() -> Self {
        Http::new()
    }
}

impl Http {
    pub fn new() -> Http {
        let client = reqwest::Client::builder()
            .user_agent(concat!("IntenticAndroid/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_default();
        Http { client }
    }

    fn request(
        &self,
        method: reqwest::Method,
        url: &str,
        auth: Auth,
        headers: &[(&str, &str)],
    ) -> reqwest::RequestBuilder {
        let mut builder = self.client.request(method, url);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        match auth {
            Auth::None => builder,
            Auth::Bearer(token) => builder.bearer_auth(token),
            Auth::Cookie(cookie) => builder.header(reqwest::header::COOKIE, cookie),
        }
    }

    /// Sends `body` as JSON (or nothing) and reads the answer as JSON, with its `Set-Cookie` headers.
    pub async fn json<O: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        url: &str,
        auth: Auth<'_>,
        headers: &[(&str, &str)],
        body: Option<&impl Serialize>,
    ) -> Result<Answer<O>, HttpError> {
        let mut builder = self
            .request(method, url, auth, headers)
            .timeout(Duration::from_secs(30));
        if let Some(body) = body {
            builder = builder.json(body);
        }
        let response = builder.send().await?;
        let status = response.status();
        let cookies = set_cookies(&response);
        let bytes = response.bytes().await?;
        if !status.is_success() {
            return Err(HttpError::Status {
                status: status.as_u16(),
                body: String::from_utf8_lossy(&bytes).into_owned(),
            });
        }
        // An empty body reads as JSON null, for calls that answer nothing; `empty` says so, for a caller to whom null
        // is a statement (`Platform::me`).
        let empty = bytes.is_empty();
        let text = if empty { &b"null"[..] } else { &bytes[..] };
        let value =
            serde_json::from_slice(text).map_err(|error| HttpError::Decode(error.to_string()))?;
        Ok(Answer {
            value,
            cookies,
            empty,
        })
    }

    /// Opens an oRPC event iterator and hands each frame to `each` until the stream ends, goes quiet, or `each`
    /// returns false.
    pub async fn events<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        url: &str,
        auth: Auth<'_>,
        body: Option<&impl Serialize>,
        mut each: impl FnMut(Result<Frame<T>, serde_json::Error>) -> bool,
    ) -> Result<(), HttpError> {
        let mut builder = self
            .request(method, url, auth, &[])
            .header(reqwest::header::ACCEPT, "text/event-stream");
        if let Some(body) = body {
            builder = builder.json(body);
        }
        let response = builder.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(HttpError::Status {
                status: status.as_u16(),
                body,
            });
        }
        let mut bytes = response.bytes_stream();
        let mut parser = SseParser::default();
        let mut events: Vec<SseEvent> = Vec::new();
        loop {
            let chunk = match tokio::time::timeout(STREAM_IDLE, bytes.next()).await {
                Err(_) => return Err(HttpError::Idle),
                Ok(None) => {
                    parser.end(&mut events);
                    None
                }
                Ok(Some(chunk)) => Some(chunk?),
            };
            if let Some(chunk) = &chunk {
                parser.feed(chunk, &mut events);
            }
            for event in events.drain(..) {
                if let Some(frame) = orpc_frame::<T>(&event)
                    && !each(frame)
                {
                    return Ok(());
                }
            }
            if chunk.is_none() {
                return Ok(());
            }
        }
    }
}

/// A JSON answer and the cookies it set, `name=value` each.
#[derive(Debug)]
pub struct Answer<T> {
    pub value: T,
    pub cookies: Vec<String>,
    /// The body was empty, and `value` is what JSON null reads as.
    pub empty: bool,
}

/// Whether a refusal's body is the server's own JSON error: an object naming its case, as a non-empty string, under one
/// of `fields`. That is what tells a server refusing a credential from a page something in front of it answered (a
/// proxy's sign-in wall, a placeholder, an outage notice), which says nothing about the credential and must never end
/// a session or forget a token. Pure.
pub fn refusal_names(body: &str, fields: &[&str]) -> bool {
    let Ok(serde_json::Value::Object(refusal)) = serde_json::from_str::<serde_json::Value>(body)
    else {
        return false;
    };
    fields.iter().any(|field| {
        refusal
            .get(*field)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|case| !case.is_empty())
    })
}

fn set_cookies(response: &reqwest::Response) -> Vec<String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .map(|pair| pair.trim().to_owned())
        .filter(|pair| !pair.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_servers_own_json_error_names_its_refusal() {
        let rpc =
            r#"{"defined":false,"code":"UNAUTHORIZED","status":401,"message":"Unauthorized"}"#;
        assert!(refusal_names(rpc, &["code"]));
        assert!(refusal_names(
            r#"{"error":"session expired"}"#,
            &["code", "error"]
        ));
        for page in [
            "",
            "Unauthorized",
            "<!DOCTYPE html><html><body>Sign in to continue</body></html>",
            "null",
            "{}",
            r#"{"code":""}"#,
            r#"{"code":401}"#,
            r#"["UNAUTHORIZED"]"#,
        ] {
            assert!(!refusal_names(page, &["code", "error"]), "{page}");
        }
        // A field the caller does not take is not its server's word.
        assert!(!refusal_names(r#"{"error":"Forbidden"}"#, &["code"]));
    }
}
