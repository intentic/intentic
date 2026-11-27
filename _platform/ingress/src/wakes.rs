//! Waking a hosted sandbox that sleeps, for a request at one of its wake doors (2026-11-27). A hosted machine idle-stops
//! and holds no tunnel while it sleeps, so a webhook or a Slack or Telegram event sent to it then met `no-tunnel` and was
//! lost unless its sender retried until somebody woke the machine. Before it sleeps, its daemon names the public paths a
//! request may wake it at and the SHA-256 of a secret such a request carries (a webhook's fire token, an extension
//! route's wake secret); the platform keeps only those digests.
//!
//! A plain request (not an upgrade, not a CORS preflight) to a sandbox holding no tunnel anywhere asks the platform
//! (`POST /api/ingress/wake` under the platform token) with its path and the digests of every value it carries that could
//! be such a secret: each query value, and a bearer token. The secret itself never leaves the edge. The platform answers
//! at once whether a start is under way, never holding the ask for the boot, and the edge holds the request for nothing:
//! a start answers the sender 503 with `Retry-After`, anything else the `no-tunnel` verdict exactly as before. So a
//! sender that retries (Slack, Telegram, most webhook senders) is answered by the woken machine, and one that never
//! retries still loses what it sent while the machine slept.
//!
//! The platform is on no hot path: the ask has two seconds, a sandbox the platform says has no doors is not asked about
//! again for a minute, and a platform from before the route (404) is not asked again for ten, with nothing said above
//! debug. Off when the edge has no platform address or no platform token.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{Method, Request, StatusCode, header};
use http_body_util::{BodyExt, Full, Limited};
use percent_encoding::percent_decode_str;
use ring::digest::{SHA256, digest};
use serde::Deserialize;

use crate::platform::{self, PlatformPoster};

/// The route the edge asks, as api-contract's `PLATFORM_INGRESS.requestWake` declares it.
pub const WAKE_PATH: &str = "/api/ingress/wake";

/// What a sender is told to wait when the platform names nothing: about a stopped machine's boot to a held tunnel.
pub const DEFAULT_RETRY_AFTER: u64 = 60;

// The ask must never hold a miss up for long: past this the request is answered as it always was.
const PATIENCE: Duration = Duration::from_secs(2);

// A sandbox the platform says has no doors is not asked about again for this long.
const QUIET_FOR: Duration = Duration::from_secs(60);

// A platform from before the route answers 404; it is not asked again for this long.
const UNSERVED_FOR: Duration = Duration::from_secs(600);

// The contract's bounds: at most this many digests, of values no longer than this, for a path no longer than this.
const DIGESTS_MAX: usize = 16;
const VALUE_MAX: usize = 512;
const PATH_MAX: usize = 2_048;

// The platform's answer is a few dozen bytes.
const ANSWER_BYTES: usize = 4_096;

// Past this many quiet sandboxes the expired go, and a new one is not kept: a miss is asked for any id a stranger names.
const ROOM: usize = 10_000;

#[derive(Deserialize)]
struct Answer {
    waking: bool,
    listening: bool,
    #[serde(rename = "retryAfter")]
    retry_after: Option<u64>,
}

/// What the platform is asked about one request, read off it before anything is awaited: its path as it arrived and the
/// digests of what it carries (`digests`).
pub struct Ask {
    pub path: String,
    pub digests: Vec<String>,
}

impl Ask {
    pub fn of<B>(request: &Request<B>) -> Self {
        Self {
            path: request.uri().path().to_owned(),
            digests: digests(request),
        }
    }
}

pub struct Wakes {
    base: String,
    token: String,
    client: PlatformPoster,
    quiet: Mutex<HashMap<String, Instant>>,
    unserved_until: Mutex<Option<Instant>>,
}

impl Wakes {
    /// Either empty turns asking off: every miss answers `no-tunnel` as it did before wake doors.
    pub fn new(platform_url: &str, token: &str) -> Self {
        Self {
            base: platform_url.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            client: platform::poster(),
            quiet: Mutex::new(HashMap::new()),
            unserved_until: Mutex::new(None),
        }
    }

    pub fn enabled(&self) -> bool {
        !self.base.is_empty() && !self.token.is_empty()
    }

    /// The seconds a sender should wait when the platform started this sandbox for the request, or is still booting it
    /// for an earlier one; `None` when the request wakes nothing, or the platform could not say.
    pub async fn ask(&self, id: &str, request: Ask) -> Option<u64> {
        if !self.enabled() || self.quiet(id) || self.unserved() || request.path.len() > PATH_MAX {
            return None;
        }
        let path = request.path;
        let asked =
            serde_json::json!({ "sandboxId": id, "path": path, "digests": request.digests });
        let answer = match tokio::time::timeout(PATIENCE, self.post(asked.to_string())).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(error)) => {
                tracing::debug!(%error, sandbox = id, "the request wake ask failed; answering as before");
                return None;
            }
            Err(_) => {
                tracing::debug!(
                    sandbox = id,
                    "the request wake ask timed out; answering as before"
                );
                return None;
            }
        }?;
        if !answer.listening {
            self.keep_quiet(id);
        }
        answer.waking.then(|| {
            tracing::info!(sandbox = id, %path, "a request at a wake door is waking a sleeping sandbox");
            answer
                .retry_after
                .unwrap_or(DEFAULT_RETRY_AFTER)
                .clamp(1, 3_600)
        })
    }

    async fn post(&self, body: String) -> anyhow::Result<Option<Answer>> {
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("{}{WAKE_PATH}", self.base))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .body(Full::new(Bytes::from(body)))?;
        let answer = self.client.request(request).await?;
        let status = answer.status();
        if status == StatusCode::NOT_FOUND {
            // A platform from before request wakes: nothing to say, and nothing to ask it for a while.
            *self.unserved_guard() = Some(Instant::now() + UNSERVED_FOR);
            return Ok(None);
        }
        if !status.is_success() {
            tracing::debug!(%status, "the platform refused the request wake ask");
            return Ok(None);
        }
        let bytes = Limited::new(answer.into_body(), ANSWER_BYTES)
            .collect()
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?
            .to_bytes();
        Ok(serde_json::from_slice(&bytes).ok())
    }

    fn quiet(&self, id: &str) -> bool {
        self.quiet_guard()
            .get(id)
            .is_some_and(|until| *until > Instant::now())
    }

    fn keep_quiet(&self, id: &str) {
        let mut quiet = self.quiet_guard();
        let now = Instant::now();
        if quiet.len() >= ROOM && !quiet.contains_key(id) {
            quiet.retain(|_, until| *until > now);
            if quiet.len() >= ROOM {
                return;
            }
        }
        quiet.insert(id.to_owned(), now + QUIET_FOR);
    }

    fn unserved(&self) -> bool {
        self.unserved_guard()
            .is_some_and(|until| until > Instant::now())
    }

    fn quiet_guard(&self) -> std::sync::MutexGuard<'_, HashMap<String, Instant>> {
        self.quiet.lock().expect("the quiet map is never poisoned")
    }

    fn unserved_guard(&self) -> std::sync::MutexGuard<'_, Option<Instant>> {
        self.unserved_until
            .lock()
            .expect("the unserved stamp is never poisoned")
    }
}

/// The SHA-256 (lowercase hex) of every value `request` carries that could be a wake door's secret, at most sixteen:
/// each query value as it arrived and, when it differs, as it decodes, then a bearer token. Values past 512 bytes are no
/// door's secret and are skipped.
pub fn digests<B>(request: &Request<B>) -> Vec<String> {
    let mut values: Vec<String> = Vec::new();
    for pair in request.uri().query().unwrap_or("").split('&') {
        let raw = pair.split_once('=').map_or("", |(_, value)| value);
        if raw.is_empty() || raw.len() > VALUE_MAX {
            continue;
        }
        values.push(raw.to_owned());
        let plussed = raw.replace('+', " ");
        if let Ok(decoded) = percent_decode_str(&plussed).decode_utf8()
            && decoded != raw
        {
            values.push(decoded.into_owned());
        }
    }
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty() && token.len() <= VALUE_MAX);
    // The bearer goes first, so a query long enough to fill the list cannot crowd it out.
    let mut digests: Vec<String> = bearer
        .into_iter()
        .map(str::to_owned)
        .chain(values)
        .map(|value| hex(digest(&SHA256, value.as_bytes()).as_ref()))
        .collect();
    digests.dedup();
    digests.truncate(DIGESTS_MAX);
    digests
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(value: &str) -> String {
        hex(digest(&SHA256, value.as_bytes()).as_ref())
    }

    #[test]
    fn every_query_value_and_a_bearer_are_hashed_never_sent() {
        let request = Request::get("/automations/a1/fire?token=tok-1&wake=s%2Fecret&empty=&flag")
            .header(header::AUTHORIZATION, "Bearer bearer-1")
            .body(())
            .unwrap();
        let hashed = digests(&request);
        assert_eq!(
            hashed,
            [
                sha("bearer-1"),
                sha("tok-1"),
                sha("s%2Fecret"),
                sha("s/ecret")
            ]
        );
        assert!(hashed.iter().all(|each| each.len() == 64));
    }

    #[test]
    fn no_more_than_sixteen_and_nothing_overlong() {
        let query = (0..40)
            .map(|index| format!("k{index}=v{index}"))
            .collect::<Vec<_>>()
            .join("&");
        let long = "x".repeat(VALUE_MAX + 1);
        let request = Request::get(format!("/hook?long={long}&{query}"))
            .header(header::AUTHORIZATION, "Bearer first")
            .body(())
            .unwrap();
        let hashed = digests(&request);
        assert_eq!(hashed.len(), DIGESTS_MAX);
        assert_eq!(hashed[0], sha("first"));
        assert!(!hashed.contains(&sha(&long)));
    }

    #[test]
    fn off_without_a_platform_or_a_token() {
        assert!(!Wakes::new("", "token").enabled());
        assert!(!Wakes::new("https://api.test", "").enabled());
        assert!(Wakes::new("https://api.test/", "token").enabled());
    }

    #[test]
    fn the_quiet_map_never_grows_past_its_room() {
        let wakes = Wakes::new("https://api.test", "token");
        for index in 0..(ROOM + 5) {
            wakes.keep_quiet(&format!("{index:012x}"));
        }
        assert_eq!(wakes.quiet_guard().len(), ROOM);
        assert!(wakes.quiet(&format!("{:012x}", 0)));
        assert!(!wakes.quiet(&format!("{:012x}", ROOM + 1)));
    }
}
