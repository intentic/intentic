//! Whether a sandbox still exists, asked of the platform (`GET /api/reachability/<id>`) and kept a minute. Only the
//! platform's own deletion record refuses, and only once it has said so twice: a 404 whose body is that record
//! (`is_deletion_record`), then the record again at least `CONFIRM_AFTER` later with no answer between that the sandbox
//! exists. Everything else answers that it exists: a timeout, a 5xx, an unreachable platform or none configured, since
//! reachability must not depend on the platform being up, and a 404 that is not the record, since something in front of
//! the api answers 404 too (a misrouted hostname, a placeholder page) and one such answer used to close every tunnel the
//! edge held with `DELETED_CODE`, each netd then waiting an hour before it dialled again (2026-11-09). A failure is never
//! kept. The platform answers 404 for a deletion record alone, and 200 for an id it has no record of either way, so a
//! platform reading a database that forgot a sandbox does not take it off the edge (api app.ts, 2026-10-02). A success's
//! body (the lane it names) is not read: every sandbox is reached the same way, down the tunnel it dials, so existence
//! is all that decides.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use http::{Request, StatusCode};
use http_body_util::{BodyExt, Empty, Limited};
use serde_json::Value;

use crate::platform::{self, PlatformClient};

const REACHABILITY_PATH: &str = "/api/reachability/";

/// Flattens a redial storm without much revocation delay. Asked at registration, on a miss, and for every held sandbox
/// once its answer expires (`Edge::recheck_held`), so a deleted sandbox's tunnels close within about two of these, plus
/// `CONFIRM_AFTER`.
pub const KEEP_FOR: Duration = Duration::from_secs(60);

/// How long after a first deletion record the second must come to confirm it. Long enough to outlast a blip, a rolling
/// api restart behind its proxy or a hostname route being changed, both of which take tens of seconds, and short beside
/// what either side costs: a deletion already takes up to two minutes to reach the tunnels (`KEEP_FOR` twice), while a
/// wrong one closes every tunnel of the sandbox and its netd waits an hour (netd's `DELETED_PACE`) before it dials
/// again. The held-sandbox pass waits this long and asks again (`Edge::recheck_once`); 10 s was the other end weighed,
/// which a restart outlasts.
pub const CONFIRM_AFTER: Duration = Duration::from_secs(30);

// A first deletion record nothing confirmed by now is forgotten, and the next one starts over: the held-sandbox pass asks
// every minute, so ten of them may fail between the two, and two blips hours apart never add up to a deletion.
const DOUBT_LASTS: Duration = Duration::from_secs(10 * 60);

// The platform is on no hot path and must not hang one.
const PATIENCE: Duration = Duration::from_secs(5);

// A deletion record is a few dozen bytes; a 404 longer than this is somebody's page and is not read to its end.
const RECORD_BYTES: usize = 4096;

// The refusal the api answers a deleted sandbox today (app.ts `kit.refuse(404, "deleted sandbox")`): the api's own
// `{ "error": … }` shape with a text no other route of it answers and nothing in front of it writes.
const DELETION_ERROR: &str = "deleted sandbox";

// Past this many answers the expired ones go, and if every one is still fresh the new answer is not kept: a miss is
// asked for any 12 hex digits a stranger names, so ids nobody holds must not grow the map without bound. (Before
// 2026-10-05 a full map of fresh answers still took the new one.)
const ROOM: usize = 10_000;

/// What the platform's word on a sandbox comes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    /// It exists, or the platform said nothing either way.
    Exists,
    /// The platform's deletion record, heard once and not yet confirmed: treated as existing, and asked again once
    /// `CONFIRM_AFTER` has passed, never sooner.
    Doubted,
    /// The deletion record twice, `CONFIRM_AFTER` or more apart, with no answer between that it exists.
    Deleted,
}

#[derive(Debug, Clone, Copy)]
enum Kept {
    // The platform's answer, fresh for `keep_for`.
    Answer { exists: bool, at: Instant },
    // A first deletion record, waiting for its confirmation.
    Doubt { since: Instant },
}

// What one question of the platform came to.
enum Said {
    Exists,
    Deleted,
    // No statement about this sandbox (a 5xx, a 404 that is not the record): neither kept nor acted on.
    Nothing,
}

pub struct Revocation {
    base: String,
    client: PlatformClient,
    keep_for: Duration,
    confirm_after: Duration,
    kept: Mutex<HashMap<String, Kept>>,
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
            confirm_after: CONFIRM_AFTER,
            kept: Mutex::new(HashMap::new()),
        }
    }

    /// The same, waiting `wait` rather than `CONFIRM_AFTER` before a deletion record may be confirmed.
    pub fn confirming_after(mut self, wait: Duration) -> Self {
        self.confirm_after = wait;
        self
    }

    pub fn enforced(&self) -> bool {
        !self.base.is_empty()
    }

    pub fn confirm_after(&self) -> Duration {
        self.confirm_after
    }

    /// Does this sandbox still exist? The registration gate (may a tunnel presenting a grant for it be held?) and a
    /// miss's verdict both ask it, and share one cache. A doubted deletion still exists here.
    pub async fn allows(&self, id: &str) -> bool {
        self.standing(id).await != Standing::Deleted
    }

    /// The platform's word on this sandbox, kept or asked for.
    pub async fn standing(&self, id: &str) -> Standing {
        if self.base.is_empty() {
            return Standing::Exists;
        }
        let confirms = match self.kept().get(id).copied() {
            Some(Kept::Answer { exists, at }) if at.elapsed() < self.keep_for => {
                return if exists {
                    Standing::Exists
                } else {
                    Standing::Deleted
                };
            }
            // Not asked again before it could be confirmed, so a browser retrying a deleted sandbox's address costs no
            // lookup per retry.
            Some(Kept::Doubt { since }) if since.elapsed() < self.confirm_after => {
                return Standing::Doubted;
            }
            Some(Kept::Doubt { since }) => since.elapsed() < DOUBT_LASTS,
            // A deletion already believed, its answer expired: the record again is a third word, not a first, so a
            // deleted sandbox's netd redialling an hour later is refused rather than held while it is doubted anew.
            Some(Kept::Answer { exists: false, .. }) => true,
            Some(Kept::Answer { exists: true, .. }) | None => false,
        };
        let said = match tokio::time::timeout(PATIENCE, self.ask(id)).await {
            Ok(Ok(said)) => said,
            Ok(Err(error)) => {
                tracing::warn!(%error, sandbox = id, "reachability lookup failed; assuming the sandbox exists");
                Said::Nothing
            }
            Err(_) => {
                tracing::warn!(
                    sandbox = id,
                    "reachability lookup timed out; assuming the sandbox exists"
                );
                Said::Nothing
            }
        };
        let (standing, kept) = match said {
            // Neither kept nor acted on, and a doubt stands as it was.
            Said::Nothing => return Standing::Exists,
            Said::Exists => (
                Standing::Exists,
                Kept::Answer {
                    exists: true,
                    at: Instant::now(),
                },
            ),
            Said::Deleted if confirms => {
                tracing::info!(
                    sandbox = id,
                    "the platform said again that this sandbox was deleted; believing it"
                );
                (
                    Standing::Deleted,
                    Kept::Answer {
                        exists: false,
                        at: Instant::now(),
                    },
                )
            }
            Said::Deleted => {
                tracing::warn!(
                    sandbox = id,
                    "the platform says this sandbox was deleted; asking again before believing it"
                );
                (
                    Standing::Doubted,
                    Kept::Doubt {
                        since: Instant::now(),
                    },
                )
            }
        };
        self.keep(id, kept, ROOM);
        standing
    }

    // Keeps an entry, sweeping the expired first when the map is at `room`, and keeping nothing new past it.
    fn keep(&self, id: &str, entry: Kept, room: usize) {
        let mut kept = self.kept();
        if kept.len() >= room && !kept.contains_key(id) {
            let keep_for = self.keep_for;
            kept.retain(|_, entry| match entry {
                Kept::Answer { at, .. } => at.elapsed() < keep_for,
                Kept::Doubt { since } => since.elapsed() < DOUBT_LASTS,
            });
            if kept.len() >= room {
                return;
            }
        }
        kept.insert(id.to_owned(), entry);
    }

    async fn ask(&self, id: &str) -> anyhow::Result<Said> {
        let request =
            Request::get(format!("{}{REACHABILITY_PATH}{id}", self.base)).body(Empty::new())?;
        let answer = self.client.request(request).await?;
        let status = answer.status();
        if status.is_success() {
            return Ok(Said::Exists);
        }
        if status != StatusCode::NOT_FOUND {
            tracing::warn!(%status, sandbox = id, "reachability lookup answered an error; assuming the sandbox exists");
            return Ok(Said::Nothing);
        }
        let body = Limited::new(answer.into_body(), RECORD_BYTES)
            .collect()
            .await
            .map(|collected| collected.to_bytes());
        if body.is_ok_and(|body| is_deletion_record(&body)) {
            return Ok(Said::Deleted);
        }
        tracing::warn!(
            sandbox = id,
            "reachability lookup answered a 404 that is not the platform's deletion record; assuming the sandbox exists"
        );
        Ok(Said::Nothing)
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, HashMap<String, Kept>> {
        self.kept
            .lock()
            .expect("the reachability cache is never poisoned")
    }
}

/// Whether a 404's body is the platform's own deletion record: a JSON object saying `"deleted": true`, or the refusal
/// the api answers a deleted sandbox today, `{"error":"deleted sandbox"}`. A page, plain text, or any other JSON (the
/// api's own `not a sandbox id` included) is not.
pub fn is_deletion_record(body: &[u8]) -> bool {
    let Ok(Value::Object(record)) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    record.get("deleted") == Some(&Value::Bool(true))
        || record.get("error").and_then(Value::as_str) == Some(DELETION_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exists() -> Kept {
        Kept::Answer {
            exists: true,
            at: Instant::now(),
        }
    }

    #[test]
    fn the_cache_never_grows_past_its_room_and_sweeps_the_expired_first() {
        let fresh = Revocation::keeping("http://platform.test", Duration::from_secs(3600));
        for index in 0..5 {
            fresh.keep(&format!("{index:012x}"), exists(), 3);
        }
        assert_eq!(fresh.kept().len(), 3, "nothing new is kept past the room");
        let refreshed = Kept::Answer {
            exists: false,
            at: Instant::now(),
        };
        fresh.keep(&format!("{:012x}", 0), refreshed, 3);
        assert!(
            matches!(
                fresh.kept().get(&format!("{:012x}", 0)),
                Some(Kept::Answer { exists: false, .. })
            ),
            "a kept id is refreshed"
        );

        let expiring = Revocation::keeping("http://platform.test", Duration::ZERO);
        for index in 0..5 {
            expiring.keep(&format!("{index:012x}"), exists(), 3);
        }
        assert!(expiring.kept().len() <= 3);
        assert!(
            expiring.kept().contains_key(&format!("{:012x}", 4)),
            "the expired made room"
        );
    }

    // A doubt holds its place until it lapses, then makes room like an expired answer.
    #[test]
    fn a_doubt_is_swept_only_once_it_lapsed() {
        let revocation = Revocation::keeping("http://platform.test", Duration::from_secs(3600));
        let lapsed = Instant::now()
            .checked_sub(DOUBT_LASTS + Duration::from_secs(1))
            .expect("the clock reads past ten minutes");
        revocation.keep("000000000000", Kept::Doubt { since: lapsed }, 2);
        revocation.keep(
            "000000000001",
            Kept::Doubt {
                since: Instant::now(),
            },
            2,
        );
        revocation.keep("000000000002", exists(), 2);
        let mut kept = revocation.kept().keys().cloned().collect::<Vec<_>>();
        kept.sort();
        assert_eq!(kept, ["000000000001", "000000000002"]);
    }

    #[test]
    fn only_the_platforms_own_record_is_a_deletion() {
        for record in [
            r#"{"error":"deleted sandbox"}"#,
            r#"{"deleted":true}"#,
            r#"{"error":"deleted sandbox","deleted":true}"#,
        ] {
            assert!(is_deletion_record(record.as_bytes()), "{record}");
        }
        for other in [
            "",
            "gone",
            "404 Not Found",
            "<!DOCTYPE html><html><body>Not Found</body></html>",
            "{}",
            r#"{"error":"not a sandbox id"}"#,
            r#"{"error":"Not Found"}"#,
            r#"{"deleted":"true"}"#,
            r#"{"deleted":false,"error":"x"}"#,
            r#"["deleted sandbox"]"#,
            r#""deleted sandbox""#,
            r#"{"message":"deleted sandbox"}"#,
        ] {
            assert!(!is_deletion_record(other.as_bytes()), "{other}");
        }
    }
}
