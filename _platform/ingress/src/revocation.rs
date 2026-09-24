//! Whether a sandbox still exists and how it is reached, asked of the platform (`GET /api/reachability/<id>`) and kept a
//! minute. Only a definite 404 refuses: a timeout, a 5xx, an unreachable platform or none configured all answer that it
//! exists, since reachability must not depend on the platform being up, and a failure is never kept.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use http::{Request, StatusCode};
use http_body_util::{BodyExt, Empty};

use crate::platform::{self, PlatformClient};

const REACHABILITY_PATH: &str = "/api/reachability/";

// Flattens a redial storm without much revocation delay; asked only at registration and on a miss.
const KEEP_FOR: Duration = Duration::from_secs(60);

// The platform is on no hot path and must not hang one.
const PATIENCE: Duration = Duration::from_secs(5);

// Past this many answers the expired ones go, so ids nobody holds cannot grow the map without bound.
const ROOM: usize = 10_000;

// An answer larger than this is not one the platform gives.
const MAX_ANSWER: usize = 64 * 1024;

/// How a sandbox is reached: a hosted one replays to its Fly app, a tunnel one dials the edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Hosted,
    Tunnel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reachability {
    pub exists: bool,
    /// `None` when the platform did not say.
    pub reach: Option<Reach>,
    /// The Fly app to replay to, when the platform names one.
    pub app: Option<String>,
}

const UNKNOWN: Reachability = Reachability {
    exists: true,
    reach: None,
    app: None,
};

pub struct Revocation {
    base: String,
    client: PlatformClient,
    keep_for: Duration,
    kept: Mutex<HashMap<String, (Reachability, Instant)>>,
}

impl Revocation {
    /// `platform_url` empty turns the check off: every signed grant registers and every id exists on an unknown lane.
    pub fn new(platform_url: &str) -> Self {
        Self::keeping(platform_url, KEEP_FOR)
    }

    pub fn keeping(platform_url: &str, keep_for: Duration) -> Self {
        Self {
            base: platform_url.trim_end_matches('/').to_owned(),
            client: platform::client(),
            keep_for,
            kept: Mutex::new(HashMap::new()),
        }
    }

    pub fn enforced(&self) -> bool {
        !self.base.is_empty()
    }

    /// The registration gate: may a tunnel presenting a grant for this id be held?
    pub async fn allows(&self, id: &str) -> bool {
        self.lookup(id).await.exists
    }

    pub async fn lookup(&self, id: &str) -> Reachability {
        if self.base.is_empty() {
            return UNKNOWN;
        }
        if let Some((answer, at)) = self.kept().get(id)
            && at.elapsed() < self.keep_for
        {
            return answer.clone();
        }
        let asked = tokio::time::timeout(PATIENCE, self.ask(id)).await;
        let answer = match asked {
            Ok(Ok(Some(answer))) => answer,
            Ok(Ok(None)) => return UNKNOWN,
            Ok(Err(error)) => {
                tracing::warn!(%error, sandbox = id, "reachability lookup failed; assuming the sandbox exists");
                return UNKNOWN;
            }
            Err(_) => {
                tracing::warn!(
                    sandbox = id,
                    "reachability lookup timed out; assuming the sandbox exists"
                );
                return UNKNOWN;
            }
        };
        let mut kept = self.kept();
        if kept.len() >= ROOM {
            let keep_for = self.keep_for;
            kept.retain(|_, (_, at)| at.elapsed() < keep_for);
        }
        kept.insert(id.to_owned(), (answer.clone(), Instant::now()));
        answer
    }

    // `None` for an answer that is no statement about this sandbox (a 5xx), which is neither kept nor acted on.
    async fn ask(&self, id: &str) -> anyhow::Result<Option<Reachability>> {
        let request =
            Request::get(format!("{}{REACHABILITY_PATH}{id}", self.base)).body(Empty::new())?;
        let answer = self.client.request(request).await?;
        let status = answer.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(Some(Reachability {
                exists: false,
                reach: None,
                app: None,
            }));
        }
        if !status.is_success() {
            tracing::warn!(%status, sandbox = id, "reachability lookup answered an error; assuming the sandbox exists");
            return Ok(None);
        }
        let body = http_body_util::Limited::new(answer.into_body(), MAX_ANSWER)
            .collect()
            .await
            .map(|collected| collected.to_bytes())
            .unwrap_or_default();
        Ok(Some(read_answer(&body)))
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Reachability, Instant)>> {
        self.kept
            .lock()
            .expect("the reachability cache is never poisoned")
    }
}

// Read leniently: an older platform names no lane, and an answer that is not JSON still says the sandbox exists.
fn read_answer(body: &[u8]) -> Reachability {
    let parsed: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let reach = match parsed.get("lane").and_then(serde_json::Value::as_str) {
        Some("hosted") => Some(Reach::Hosted),
        Some("tunnel") => Some(Reach::Tunnel),
        _ => None,
    };
    let app = parsed
        .get("app")
        .and_then(serde_json::Value::as_str)
        .filter(|app| !app.is_empty())
        .map(str::to_owned);
    Reachability {
        exists: true,
        reach,
        app,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_is_read_leniently() {
        assert_eq!(
            read_answer(br#"{"ok":true,"lane":"hosted","app":"intentic-sbx-abcdef012345"}"#),
            Reachability {
                exists: true,
                reach: Some(Reach::Hosted),
                app: Some("intentic-sbx-abcdef012345".into())
            }
        );
        assert_eq!(
            read_answer(br#"{"ok":true,"lane":"tunnel"}"#).reach,
            Some(Reach::Tunnel)
        );
        assert_eq!(read_answer(br#"{"ok":true}"#), UNKNOWN);
        assert_eq!(read_answer(br#"{"lane":"elsewhere","app":""}"#), UNKNOWN);
        assert_eq!(read_answer(b"ok"), UNKNOWN);
    }
}
