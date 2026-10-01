//! Whether a sandbox still exists, asked of the platform (`GET /api/reachability/<id>`) and kept a minute. Only a
//! definite 404 refuses: a timeout, a 5xx, an unreachable platform or none configured all answer that it exists, since
//! reachability must not depend on the platform being up, and a failure is never kept. The platform answers 404 for a
//! deletion record alone, and 200 for an id it has no record of either way, so a platform reading a database that forgot
//! a sandbox does not take it off the edge (api app.ts, 2026-10-02). The answer's body (the lane it names) is not read:
//! every sandbox is reached the same way, down the tunnel it dials, so existence is all that decides.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use http::{Request, StatusCode};
use http_body_util::Empty;

use crate::platform::{self, PlatformClient};

const REACHABILITY_PATH: &str = "/api/reachability/";

// Flattens a redial storm without much revocation delay; asked only at registration and on a miss.
const KEEP_FOR: Duration = Duration::from_secs(60);

// The platform is on no hot path and must not hang one.
const PATIENCE: Duration = Duration::from_secs(5);

// Past this many answers the expired ones go, so ids nobody holds cannot grow the map without bound.
const ROOM: usize = 10_000;

pub struct Revocation {
    base: String,
    client: PlatformClient,
    keep_for: Duration,
    kept: Mutex<HashMap<String, (bool, Instant)>>,
}

impl Revocation {
    /// `platform_url` empty turns the check off: every signed grant registers and every id exists.
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

    /// Does this sandbox still exist? The registration gate (may a tunnel presenting a grant for it be held?) and a
    /// miss's verdict both ask it, and share one cache.
    pub async fn allows(&self, id: &str) -> bool {
        if self.base.is_empty() {
            return true;
        }
        if let Some((answer, at)) = self.kept().get(id)
            && at.elapsed() < self.keep_for
        {
            return *answer;
        }
        let asked = tokio::time::timeout(PATIENCE, self.ask(id)).await;
        let answer = match asked {
            Ok(Ok(Some(answer))) => answer,
            Ok(Ok(None)) => return true,
            Ok(Err(error)) => {
                tracing::warn!(%error, sandbox = id, "reachability lookup failed; assuming the sandbox exists");
                return true;
            }
            Err(_) => {
                tracing::warn!(
                    sandbox = id,
                    "reachability lookup timed out; assuming the sandbox exists"
                );
                return true;
            }
        };
        let mut kept = self.kept();
        if kept.len() >= ROOM {
            let keep_for = self.keep_for;
            kept.retain(|_, (_, at)| at.elapsed() < keep_for);
        }
        kept.insert(id.to_owned(), (answer, Instant::now()));
        answer
    }

    // `None` for an answer that is no statement about this sandbox (a 5xx), which is neither kept nor acted on.
    async fn ask(&self, id: &str) -> anyhow::Result<Option<bool>> {
        let request =
            Request::get(format!("{}{REACHABILITY_PATH}{id}", self.base)).body(Empty::new())?;
        let answer = self.client.request(request).await?;
        let status = answer.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(Some(false));
        }
        if !status.is_success() {
            tracing::warn!(%status, sandbox = id, "reachability lookup answered an error; assuming the sandbox exists");
            return Ok(None);
        }
        Ok(Some(true))
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, HashMap<String, (bool, Instant)>> {
        self.kept
            .lock()
            .expect("the reachability cache is never poisoned")
    }
}
