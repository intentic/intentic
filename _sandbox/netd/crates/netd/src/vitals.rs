//! The sandbox's proof of life, `GET /system/vitals` on the daemon's own host, answered by netd before anything
//! waits for Node: whether Node's link is up, how long its event loop takes to answer netd's ping, how often the
//! netd restarted it, how long the container has run, and the container's pressure stall. Node's own heartbeat on
//! `/events` rides its event loop, so a sandbox busy enough to starve that loop would look exactly like a dead one.
//! The same ping is how netd finds a Node that is stuck rather than busy, and has it restarted; a Node that never
//! says hello at all is found by a deadline on its first one (2026-10-05: one that hung before its hello was never
//! killed, since pings start only at the hello). The vitals also carry where the ingress tunnel stands and how often it
//! dropped in the last hour.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use browser_wire::{NodeLink, Pressure, SandboxVitals, VITALS_PATH};
use http::header::{self, HeaderMap, HeaderValue};
use http::{Method, Response, StatusCode};
use netd_wire::Question;
use relay::body::{self, Body};
use tokio::sync::watch;
use tokio::time::MissedTickBehavior;

use crate::link::Link;
use crate::standing::Standing;
use crate::supervise::Restarts;

// How often netd pings Node, each ping only once the one before it was answered.
const PING_EVERY: Duration = Duration::from_secs(2);

// How long a ping may go unanswered before Node is called stuck, killed and restarted. Node's link answers a ping the
// moment its event loop turns, so a Node busy but alive answers within seconds however loaded it is; one silent this
// long has a loop that is not turning at all, and would otherwise stay up for good as an outage the editor reads as
// busy. Pings start only once Node said hello, which it does last in its start, so a long boot is never timed.
const STUCK_AFTER: Duration = Duration::from_secs(5 * 60);

// How long a started Node has to say its first hello before it is called stuck and restarted as after a crash. Node says
// hello last in its start, after it converged the stored files and opened its stores, which includes setting aside and
// salvaging a damaged conversations database (ready-aspen-kd6c); generous for that, and for a loaded machine, while a
// Node hung at boot is still found within minutes rather than never.
const HELLO_DEADLINE: Duration = Duration::from_secs(3 * 60);

// How often the vitals file is written when nothing else changed it: the restart count is a window that empties as it
// ages, and a reader holds whatever was written last.
const REWRITE_EVERY: Duration = Duration::from_secs(60);

// The container's own cgroup: its pressure covers everything in the box, the daemon and its workload alike.
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

const METHODS: &str = "GET, HEAD, OPTIONS";

// Chrome's ceiling, as the daemon's own preflights answer.
const PREFLIGHT_MAX_AGE: &str = "7200";

/// Whether netd answers this path itself. Asked only of the daemon's own host: a preview's app may serve the same
/// path, and that is the app's.
pub fn serves(path: &str) -> bool {
    path == VITALS_PATH
}

pub struct Vitals {
    link: &'static Link,
    restarts: Arc<Restarts>,
    tunnel: Arc<Standing>,
    started: Instant,
    cgroup: PathBuf,
    ping: Mutex<Ping>,
    stuck: watch::Sender<()>,
    // `STUCK_AFTER` and `HELLO_DEADLINE`, fields so a test runs the rules in a second rather than minutes.
    stuck_after: Duration,
    hello_within: Duration,
}

impl Vitals {
    pub fn new(link: &'static Link, restarts: Arc<Restarts>, tunnel: Arc<Standing>) -> Self {
        Self {
            link,
            restarts,
            tunnel,
            started: Instant::now(),
            cgroup: PathBuf::from(CGROUP_ROOT),
            ping: Mutex::default(),
            stuck: watch::Sender::new(()),
            stuck_after: STUCK_AFTER,
            hello_within: HELLO_DEADLINE,
        }
    }

    /// Calls each Node the supervisor starts (its pid on `started`) stuck when it has not said hello within
    /// `HELLO_DEADLINE`, for as long as netd runs: a Node hung before its hello answers no ping, since none is
    /// sent until it says hello, and would otherwise hold the sandbox down for good.
    pub async fn deadline_first_hellos(&self, mut started: watch::Receiver<Option<u32>>) {
        loop {
            let pid = match started.wait_for(Option::is_some).await {
                Ok(pid) => *pid,
                Err(_) => return,
            };
            let mut state = self.link.state();
            // A connection of the Node before may not be read as gone yet; only a hello on another one counts.
            let before = *state.borrow_and_update();
            let greeted = tokio::time::timeout(
                self.hello_within,
                state.wait_for(|up| up.is_some() && *up != before),
            )
            .await
            .is_ok_and(|seen| seen.is_ok());
            if !greeted && *started.borrow() == pid {
                tracing::error!(
                    pid,
                    "the daemon has not said hello {:?} after it started: it is stuck before serving",
                    self.hello_within
                );
                self.stuck.send_replace(());
            }
            if started.wait_for(|now| *now != pid).await.is_err() {
                return;
            }
        }
    }

    /// Told each time a ping has gone unanswered for `STUCK_AFTER`: the Node on the link is stuck and is to be killed.
    pub fn stuck(&self) -> watch::Receiver<()> {
        self.stuck.subscribe()
    }

    /// Pings Node every `PING_EVERY` while it is up, each once the previous one was answered, for as long as netd
    /// runs. A ping has no patience of its own: a Node slow to answer is the lag it measures, and a connection that ends
    /// fails it. One unanswered for `STUCK_AFTER` tells `stuck`, and still waits for its connection to end.
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
            let mut asking = std::pin::pin!(self.link.asked(Question::Ping, None));
            let reply = match tokio::time::timeout(self.stuck_after, asking.as_mut()).await {
                Ok(reply) => reply,
                Err(_) => {
                    tracing::error!(
                        generation,
                        "the daemon has not answered a ping for {:?}: its event loop is stuck",
                        self.stuck_after
                    );
                    self.stuck.send_replace(());
                    asking.await
                }
            };
            let answered = reply.is_ok();
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
            tunnel: self.tunnel.vitals(now),
        }
    }

    /// Writes the vitals to `path` (browser-wire's `VITALS_FILE`) whenever they change, a restart or Node's link
    /// coming up or going down, and once a minute besides. Whole and then renamed into place, so a reader never sees
    /// half of one. For a host that reaches the container but not its address: a daemon that dies before it names
    /// netd's ports leaves netd listening on nothing (2026-10-06). Never returns.
    pub async fn keep_written(&self, path: &Path) {
        let mut link = self.link.state();
        let mut tick = tokio::time::interval(REWRITE_EVERY);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        tick.tick().await;
        let mut warned = false;
        loop {
            if let Err(error) = self.write(path) {
                // Once: a run directory that cannot be written stays so, and the route still answers.
                if !warned {
                    tracing::warn!(%error, path = %path.display(), "could not write the vitals file");
                    warned = true;
                }
            }
            tokio::select! {
                _ = tick.tick() => {}
                () = self.restarts.recorded() => {}
                // The link is the process's own and never dropped, so an error here cannot happen; a tick still ends it.
                _ = link.changed() => {}
            }
        }
    }

    fn write(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_vec(&self.read()).expect("vitals always serialize");
        let partial = path.with_extension("json.partial");
        std::fs::write(&partial, json)?;
        std::fs::rename(&partial, path)
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

// A Node that was up once, or that netd had to restart, and is not up now is restarting; one that never came yet
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
    use netd_wire::{Answer, FromNode, ToNode, frame};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::net::unix::OwnedReadHalf;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    use super::*;
    use crate::link::read_frame;

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
        let dir = std::env::temp_dir().join(format!("netd-vitals-psi-{}", std::process::id()));
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

    // The id of the ping netd asked, read off Node's side of the control socket.
    async fn asked_ping(reader: &mut BufReader<OwnedReadHalf>) -> u32 {
        let asked = read_frame(reader).await.unwrap().expect("the link is open");
        match serde_json::from_slice::<ToNode>(&asked).unwrap() {
            ToNode::Ask {
                id,
                question: Question::Ping,
            } => id,
            other => panic!("expected a ping, got {other:?}"),
        }
    }

    // A booting Node, then a slow one, then a stuck one, against a limit of two seconds.
    #[tokio::test]
    async fn only_a_ping_unanswered_for_the_limit_calls_node_stuck() {
        const LIMIT: Duration = Duration::from_secs(2);
        let dir = std::env::temp_dir().join(format!("netd-vitals-stuck-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("netd.sock");
        let (pushed, _received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let socket = path.clone();
        tokio::spawn(async move { link.serve(&socket).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut vitals = Vitals::new(link, Arc::default(), Arc::default());
        vitals.stuck_after = LIMIT;
        let vitals = Arc::new(vitals);
        let mut stuck = vitals.stuck();
        let pinging = vitals.clone();
        tokio::spawn(async move { pinging.keep_pinging().await });
        let (reader, mut writer) = UnixStream::connect(&path).await.unwrap().into_split();
        let mut reader = BufReader::new(reader);

        // Connected and still booting: it has not said hello, so nothing is asked and nothing is timed.
        let unwatch = FromNode::Unwatch {
            dir: "/workspace".into(),
        };
        writer.write_all(&frame(&unwatch).unwrap()).await.unwrap();
        assert!(timeout(LIMIT + LIMIT / 4, stuck.changed()).await.is_err());

        let hello = FromNode::Hello {
            build: "test".into(),
            pid: 7,
            generation: None,
        };
        writer.write_all(&frame(&hello).unwrap()).await.unwrap();
        // A quarter of the limit to answer is lag, not a hang.
        let id = asked_ping(&mut reader).await;
        assert!(timeout(LIMIT / 4, stuck.changed()).await.is_err());
        let pong = FromNode::Answer {
            id,
            answer: Answer::Pong,
        };
        // The next ping is sent only once this answer is in, so its limit runs from no earlier than now.
        let answered = Instant::now();
        writer.write_all(&frame(&pong).unwrap()).await.unwrap();

        // The next goes unanswered: the verdict comes once the limit has passed, not before.
        asked_ping(&mut reader).await;
        assert!(timeout(LIMIT * 3, stuck.changed()).await.is_ok());
        assert!(answered.elapsed() >= LIMIT);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The file a host reads when it cannot reach the address: written at once, and again on each restart, with the count
    // the route would answer.
    #[tokio::test]
    async fn the_vitals_are_written_down_and_written_again_on_every_restart() {
        let dir = std::env::temp_dir().join(format!("netd-vitals-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vitals.json");
        let (pushed, _received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let restarts = Arc::new(Restarts::default());
        let vitals = Arc::new(Vitals::new(link, restarts.clone(), Arc::default()));
        let writing = vitals.clone();
        let file = path.clone();
        tokio::spawn(async move { writing.keep_written(&file).await });
        let read = |path: &Path| -> Option<SandboxVitals> {
            serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
        };
        let settled = |want: u32| {
            let path = path.clone();
            async move {
                for _ in 0..100 {
                    if read(&path).is_some_and(|vitals| vitals.restarts == want) {
                        return read(&path);
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                read(&path)
            }
        };
        let first = settled(0).await.expect("written at once");
        assert_eq!((first.node, first.restarts), (NodeLink::Starting, 0));
        for _ in 0..3 {
            restarts.record(Instant::now());
        }
        let looping = settled(3).await.expect("written again");
        assert_eq!((looping.node, looping.restarts), (NodeLink::Restarting, 3));
        assert!(!path.with_extension("json.partial").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A Node that never says hello is called stuck once the deadline passes; the next one, which does, is left alone.
    #[tokio::test]
    async fn a_node_silent_past_its_first_hello_deadline_is_called_stuck() {
        const LIMIT: Duration = Duration::from_millis(500);
        let dir = std::env::temp_dir().join(format!("netd-vitals-hello-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("netd.sock");
        let (pushed, _received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let socket = path.clone();
        tokio::spawn(async move { link.serve(&socket).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut vitals = Vitals::new(link, Arc::default(), Arc::default());
        vitals.hello_within = LIMIT;
        let vitals = Arc::new(vitals);
        let mut stuck = vitals.stuck();
        let (pid, started) = watch::channel(None);
        let watching = vitals.clone();
        tokio::spawn(async move { watching.deadline_first_hellos(started).await });

        pid.send_replace(Some(41));
        assert!(timeout(LIMIT * 4, stuck.changed()).await.is_ok());

        pid.send_replace(None);
        pid.send_replace(Some(42));
        let (_reader, mut writer) = UnixStream::connect(&path).await.unwrap().into_split();
        let hello = FromNode::Hello {
            build: "test".into(),
            pid: 42,
            generation: Some(2),
        };
        writer.write_all(&frame(&hello).unwrap()).await.unwrap();
        assert!(timeout(LIMIT * 3, stuck.changed()).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
