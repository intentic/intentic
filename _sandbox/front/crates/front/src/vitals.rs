//! The sandbox's proof of life, `GET /system/vitals` on the daemon's own host, answered by the front before anything
//! waits for Node: whether Node's link is up, how long its event loop takes to answer the front's ping, how often the
//! front restarted it, how long the container has run, and the container's pressure stall. Node's own heartbeat on
//! `/events` rides its event loop, so a sandbox busy enough to starve that loop would look exactly like a dead one.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use browser_wire::{NodeLink, Pressure, SandboxVitals, VITALS_PATH};
use front_wire::Question;
use http::header::{self, HeaderMap, HeaderValue};
use http::{Method, Response, StatusCode};
use relay::body::{self, Body};
use tokio::time::MissedTickBehavior;

use crate::link::Link;
use crate::supervise::Restarts;

// How often the front pings Node, each ping only once the one before it was answered.
const PING_EVERY: Duration = Duration::from_secs(2);

// The container's own cgroup: its pressure covers everything in the box, the daemon and its workload alike.
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

const METHODS: &str = "GET, HEAD, OPTIONS";

// Chrome's ceiling, as the daemon's own preflights answer.
const PREFLIGHT_MAX_AGE: &str = "7200";

/// Whether the front answers this path itself. Asked only of the daemon's own host: a preview's app may serve the same
/// path, and that is the app's.
pub fn serves(path: &str) -> bool {
    path == VITALS_PATH
}

pub struct Vitals {
    link: &'static Link,
    restarts: Arc<Restarts>,
    started: Instant,
    cgroup: PathBuf,
    ping: Mutex<Ping>,
}

impl Vitals {
    pub fn new(link: &'static Link, restarts: Arc<Restarts>) -> Self {
        Self {
            link,
            restarts,
            started: Instant::now(),
            cgroup: PathBuf::from(CGROUP_ROOT),
            ping: Mutex::default(),
        }
    }

    /// Pings Node every `PING_EVERY` while it is up, each once the previous one was answered, for as long as the front
    /// runs. A ping has no patience of its own: a Node slow to answer is the lag it measures, and a connection that ends
    /// fails it.
    pub async fn keep_pinging(&self) {
        let mut state = self.link.state();
        let mut tick = tokio::time::interval(PING_EVERY);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let generation = match state.wait_for(Option::is_some).await {
                Ok(up) => up.unwrap_or_default(),
                Err(_) => return,
            };
            let sent = Instant::now();
            self.ping
                .lock()
                .expect("ping poisoned")
                .sent(generation, sent);
            // A refusal is an answer too: an older Node refuses a question it does not know, and does so at once.
            let answered = self.link.asked(Question::Ping, None).await.is_ok();
            self.ping
                .lock()
                .expect("ping poisoned")
                .replied(generation, sent.elapsed(), answered);
        }
    }

    pub fn read(&self) -> SandboxVitals {
        let now = Instant::now();
        let up = *self.link.state().borrow();
        SandboxVitals {
            node: node_link(up.is_some(), self.link.said_hello() || self.restarts.ever()),
            lag_ms: self.ping.lock().expect("ping poisoned").lag(up, now),
            restarts: self.restarts.within_window(now),
            uptime_s: u32::try_from(now.duration_since(self.started).as_secs()).unwrap_or(u32::MAX),
            pressure: pressure(&self.cgroup),
        }
    }

    /// The route's answer: the vitals to a GET, a preflight's to OPTIONS. Any origin may read it and nothing may cache
    /// it; no credential is asked for, since it carries nothing of the workspace.
    pub fn respond(&self, method: &Method, request: &HeaderMap) -> Response<Body> {
        let mut response = match *method {
            Method::GET | Method::HEAD => {
                let json = serde_json::to_vec(&self.read()).expect("vitals always serialize");
                let mut response = Response::new(body::full(json));
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                );
                response
            }
            Method::OPTIONS => preflight(request),
            _ => {
                let mut response = Response::new(body::empty());
                *response.status_mut() = StatusCode::METHOD_NOT_ALLOWED;
                response
                    .headers_mut()
                    .insert(header::ALLOW, HeaderValue::from_static(METHODS));
                response
            }
        };
        let headers = response.headers_mut();
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
        headers.insert("timing-allow-origin", HeaderValue::from_static("*"));
        response
    }
}

fn preflight(request: &HeaderMap) -> Response<Body> {
    let mut response = Response::new(body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(METHODS),
    );
    // Named back rather than `*`, which never covers `authorization`: whatever a caller's fetch adds may come.
    if let Some(asked) = request.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, asked.clone());
    }
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static(PREFLIGHT_MAX_AGE),
    );
    response
}

// A Node that was up once, or that the front had to restart, and is not up now is restarting; one that never came yet
// is starting.
fn node_link(up: bool, came_before: bool) -> NodeLink {
    match (up, came_before) {
        (true, _) => NodeLink::Up,
        (false, true) => NodeLink::Restarting,
        (false, false) => NodeLink::Starting,
    }
}

// The ping on one connection of Node's: a figure measured on another says nothing of the Node there now.
#[derive(Default)]
struct Ping {
    generation: Option<u64>,
    answered: Option<Duration>,
    waiting_since: Option<Instant>,
}

impl Ping {
    fn sent(&mut self, generation: u64, at: Instant) {
        if self.generation != Some(generation) {
            *self = Self {
                generation: Some(generation),
                ..Self::default()
            };
        }
        self.waiting_since = Some(at);
    }

    // `answered` is false when the connection ended first: nothing was measured, and a new Node starts unknown.
    fn replied(&mut self, generation: u64, took: Duration, answered: bool) {
        if self.generation == Some(generation) {
            self.waiting_since = None;
            if answered {
                self.answered = Some(took);
            }
        }
    }

    /// The last answered round trip, or how long the outstanding ping has waited when that is longer; none while Node
    /// is not up, or before a ping of this connection's.
    fn lag(&self, up: Option<u64>, now: Instant) -> Option<u32> {
        if up.is_none() || up != self.generation {
            return None;
        }
        let waiting = self
            .waiting_since
            .map(|since| now.saturating_duration_since(since));
        self.answered
            .into_iter()
            .chain(waiting)
            .max()
            .map(|lag| u32::try_from(lag.as_millis()).unwrap_or(u32::MAX))
    }
}

// All three or none: the kernel writes them together for every cgroup below the root when it keeps pressure at all.
fn pressure(cgroup: &Path) -> Option<Pressure> {
    let some_avg10_of = |resource: &str| {
        std::fs::read_to_string(cgroup.join(format!("{resource}.pressure")))
            .ok()
            .as_deref()
            .and_then(some_avg10)
    };
    Some(Pressure {
        cpu: some_avg10_of("cpu")?,
        memory: some_avg10_of("memory")?,
        io: some_avg10_of("io")?,
    })
}

/// `avg10` of a pressure file's `some` line (`some avg10=12.34 avg60=… avg300=… total=…`): the share of the last ten
/// seconds, as a percentage, in which at least one task stalled on the resource.
fn some_avg10(psi: &str) -> Option<f32> {
    psi.lines()
        .find_map(|line| line.strip_prefix("some "))?
        .split_whitespace()
        .find_map(|field| field.strip_prefix("avg10="))?
        .parse()
        .ok()
        .filter(|share: &f32| share.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CPU: &str = "some avg10=12.34 avg60=5.00 avg300=1.25 total=5007643\nfull avg10=99.00 avg60=0.00 avg300=0.00 total=1097926\n";

    #[test]
    fn the_node_is_starting_until_it_first_comes_and_restarting_whenever_it_is_down_after() {
        assert_eq!(node_link(false, false), NodeLink::Starting);
        assert_eq!(node_link(true, false), NodeLink::Up);
        assert_eq!(node_link(true, true), NodeLink::Up);
        assert_eq!(node_link(false, true), NodeLink::Restarting);
    }

    #[test]
    fn lag_is_the_last_round_trip_or_the_outstanding_wait_whichever_is_longer() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut ping = Ping::default();
        assert_eq!(ping.lag(None, at(0)), None);
        assert_eq!(ping.lag(Some(1), at(0)), None, "before the first ping");

        ping.sent(1, at(0));
        assert_eq!(
            ping.lag(Some(1), at(300)),
            Some(300),
            "only the wait so far"
        );
        ping.replied(1, Duration::from_millis(40), true);
        assert_eq!(ping.lag(Some(1), at(5_000)), Some(40));

        ping.sent(1, at(2_000));
        assert_eq!(
            ping.lag(Some(1), at(2_010)),
            Some(40),
            "a fresh wait is shorter"
        );
        assert_eq!(
            ping.lag(Some(1), at(2_900)),
            Some(900),
            "a longer wait wins"
        );
        assert_eq!(ping.lag(None, at(2_900)), None, "Node is not up");

        // The connection ended first: nothing measured, and the next Node's lag starts unknown.
        ping.replied(1, Duration::from_millis(900), false);
        assert_eq!(ping.lag(Some(1), at(3_000)), Some(40));
        assert_eq!(ping.lag(Some(2), at(3_000)), None);
        ping.sent(2, at(4_000));
        assert_eq!(ping.lag(Some(2), at(4_005)), Some(5));
        // A late reply on the old connection moves nothing.
        ping.replied(1, Duration::from_millis(1), true);
        assert_eq!(ping.lag(Some(2), at(4_005)), Some(5));
    }

    #[test]
    fn a_lag_past_u32_saturates() {
        let start = Instant::now();
        let mut ping = Ping::default();
        ping.sent(1, start);
        ping.replied(1, Duration::from_secs(u64::from(u32::MAX)), true);
        assert_eq!(ping.lag(Some(1), start), Some(u32::MAX));
    }

    #[test]
    fn pressure_is_the_some_lines_avg10() {
        assert_eq!(some_avg10(CPU), Some(12.34));
        assert_eq!(
            some_avg10("some avg10=0.00 avg60=0.00 avg300=0.00 total=0"),
            Some(0.0)
        );
        assert_eq!(
            some_avg10("full avg10=3.00 avg60=0.00 avg300=0.00 total=0"),
            None
        );
        assert_eq!(some_avg10("some avg60=1.00 total=0"), None);
        assert_eq!(some_avg10("some avg10=NaN"), None);
        assert_eq!(some_avg10(""), None);
    }

    #[test]
    fn pressure_is_read_from_the_cgroups_three_files_or_not_at_all() {
        let dir = std::env::temp_dir().join(format!("front-vitals-psi-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cpu.pressure"), CPU).unwrap();
        std::fs::write(
            dir.join("memory.pressure"),
            "some avg10=0.49 avg60=1.51 avg300=0.84 total=5186628\n",
        )
        .unwrap();
        assert_eq!(pressure(&dir), None, "io.pressure is missing");
        std::fs::write(
            dir.join("io.pressure"),
            "some avg10=100.00 avg60=1.09 avg300=0.57 total=9188501\n",
        )
        .unwrap();
        assert_eq!(
            pressure(&dir),
            Some(Pressure {
                cpu: 12.34,
                memory: 0.49,
                io: 100.0
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_preflight_names_back_the_headers_it_was_asked_for() {
        let mut asked = HeaderMap::new();
        asked.insert(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            HeaderValue::from_static("authorization, x-request-id"),
        );
        let answer = preflight(&asked);
        assert_eq!(answer.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            answer.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "authorization, x-request-id"
        );
        assert_eq!(
            answer.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            METHODS
        );
        assert!(
            !preflight(&HeaderMap::new())
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_HEADERS)
        );
    }
}
