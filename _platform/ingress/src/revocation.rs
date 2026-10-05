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

/// Flattens a redial storm without much revocation delay. Asked at registration, on a miss, and for every held sandbox
/// once its answer expires (`Edge::recheck_held`), so a deleted sandbox's tunnels close within about two of these.
pub const KEEP_FOR: Duration = Duration::from_secs(60);

// The platform is on no hot path and must not hang one.
const PATIENCE: Duration = Duration::from_secs(5);

// Past this many answers the expired ones go, and if every one is still fresh the new answer is not kept: a miss is
// asked for any 12 hex digits a stranger names, so ids nobody holds must not grow the map without bound. (Before
// 2026-10-05 a full map of fresh answers still took the new one.)
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
        self.keep(id, answer, ROOM);
        answer
    }

    // Keeps an answer, sweeping the expired first when the map is at `room`, and keeping nothing new past it.
    fn keep(&self, id: &str, answer: bool, room: usize) {
        let mut kept = self.kept();
        if kept.len() >= room && !kept.contains_key(id) {
            let keep_for = self.keep_for;
            kept.retain(|_, (_, at)| at.elapsed() < keep_for);
            if kept.len() >= room {
                return;
            }
        }
        kept.insert(id.to_owned(), (answer, Instant::now()));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cache_never_grows_past_its_room_and_sweeps_the_expired_first() {
        let fresh = Revocation::keeping("http://platform.test", Duration::from_secs(3600));
        for index in 0..5 {
            fresh.keep(&format!("{index:012x}"), true, 3);
        }
        assert_eq!(fresh.kept().len(), 3, "nothing new is kept past the room");
        fresh.keep(&format!("{:012x}", 0), false, 3);
        assert_eq!(
            fresh
                .kept()
                .get(&format!("{:012x}", 0))
                .map(|(answer, _)| *answer),
            Some(false),
            "a kept id is refreshed"
        );

        let expiring = Revocation::keeping("http://platform.test", Duration::ZERO);
        for index in 0..5 {
            expiring.keep(&format!("{index:012x}"), true, 3);
        }
        assert!(expiring.kept().len() <= 3);
        assert!(
            expiring.kept().contains_key(&format!("{:012x}", 4)),
            "the expired made room"
        );
    }
}
