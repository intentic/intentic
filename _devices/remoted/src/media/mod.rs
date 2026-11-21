//! A person's view of this computer's screens: browser-wire's media socket on `/media/<session>`, sessions
//! `screen-<monitor id>`, served from cast-core (the capture, encoder, input and flow control castd is built from),
//! behind the same token as a terminal with `s = media/<session>`.
//!
//! - [`Platform`] is what each OS brings ([`platform`]): its monitors, encoders, what `/info` says about them, and
//!   opening one.
//! - [`Screens`] holds one pipeline per monitor, shared by every viewer of every uplink: opened on the first viewer,
//!   stopped [`LINGER`] after the last left (a reload or a tab switch rejoins a running one), ended alone when its
//!   capture fails for good (its viewers told why, the next one opening it again).
//! - [`upgrade`] is the route: the token checked with [`MEDIA_SUBJECT`](crate::token::MEDIA_SUBJECT), `allow.view`
//!   required, `allow.control` and the person's pause gating input ([`crate::daemon::Daemon::screen_input_allowed`]),
//!   the socket counted as a person (`view` or `control`) so the status, the notice and the drops cover it.
//! - Peer connections: one UDP port for every screen, full ICE, its server-reflexive candidates from the STUN servers
//!   the sandbox names (`iceServers` in the configuration, the `remoteIceServers` setting), started on the first
//!   screen's first viewer.

pub mod platform;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(windows)]
pub mod windows;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use bytes::Bytes;
use cast_core::encoder::{EncoderConfig, EncoderKind, Encoders, VideoEncoder};
use cast_core::hub::{Client, Hub};
use cast_core::video::{Video, VideoConfig};
use http::{Request, Response, StatusCode};
use http_body_util::Full;
use hyper::body::Incoming;
use serde::Serialize;

pub use platform::{Opened, Platform, Stop};

use crate::daemon::Daemon;
use crate::status::PersonKind;
use crate::term::socket::Revocation;
use crate::token;

/// One screen, as `/info` lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

/// What a screen's session is called: `screen-<monitor id>`.
pub const SESSION_PREFIX: &str = "screen-";

/// How long a screen keeps running after its last viewer left: a reload, a reconnect or a second tab finds it warm.
pub const LINGER: Duration = Duration::from_secs(10);

/// [`LINGER`], or `INTENTIC_REMOTED_LINGER_MS` (a test's own).
pub fn linger() -> Duration {
    std::env::var("INTENTIC_REMOTED_LINGER_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
        .map_or(LINGER, Duration::from_millis)
}

/// A media socket's largest message from a viewer: a clipboard image (15 MiB of PNG) in base64, as castd's.
const MAX_MESSAGE: usize = 24 << 20;

/// The close code a socket gets when its screen failed or could not open: the WebSocket's "internal error".
pub const SCREEN_FAILED: u16 = 1011;

/// This computer's platform: Linux's X11, virtual desktop and Wayland screens, Windows' DXGI ones, else none.
pub fn platform() -> Arc<dyn Platform> {
    static PLATFORM: OnceLock<Arc<dyn Platform>> = OnceLock::new();
    PLATFORM
        .get_or_init(|| {
            #[cfg(target_os = "linux")]
            return Arc::new(linux::Linux::new());
            #[cfg(windows)]
            return Arc::new(windows::Windows::new());
            #[cfg(not(any(target_os = "linux", windows)))]
            return Arc::new(platform::Unsupported);
        })
        .clone()
}

/// Every screen a viewer could open now.
pub fn monitors() -> Vec<Monitor> {
    platform().monitors()
}

/// The encoders a screen could be sent with.
pub fn encoders() -> Vec<String> {
    platform().encoders()
}

/// remoted's pipeline settings before a platform tunes them: castd's defaults for a viewer across a network (no loopback
/// viewer reaches a device, so neither the local quality nor exact pictures apply), on the software encoder.
pub fn base_video() -> VideoConfig {
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get()) as u32;
    VideoConfig {
        crop: None,
        fps: 60,
        preset: "ultrafast".into(),
        threads: (cores / 4).clamp(1, 4),
        convert_threads: (cores as usize / 2).clamp(1, 4),
        crf: 24.0,
        max_kbps: 30_000,
        paintover_crf: 16.0,
        paintover_burst: 3,
        paintover_delay_ms: 150,
        min_kbps: 500,
        local_crf: 18.0,
        local_max_kbps: 200_000,
        local_fps: 60,
        lossless: false,
        lossless_delay: Duration::from_millis(100),
        coalesce: Duration::ZERO,
        stripes: 1,
        adaptive_threads: true,
        encoder: Encoders {
            primary: software(),
            fallback: software(),
        },
    }
}

/// The software encoder this build has: openh264 (BSD, the default build's), else x264 with the `x264` feature (GPL,
/// never shipped), else none, which a platform replaces with a hardware one or refuses to open with.
#[allow(unreachable_code)]
pub fn software() -> Arc<dyn EncoderKind> {
    #[cfg(feature = "openh264")]
    return Arc::new(cast_core::openh264::OpenH264);
    #[cfg(feature = "x264")]
    return Arc::new(cast_core::encoder::Backend::X264);
    Arc::new(NoEncoder)
}

/// The software encoder of a build without one: every open says so.
pub struct NoEncoder;

impl EncoderKind for NoEncoder {
    fn name(&self) -> &'static str {
        "none"
    }
    fn hardware(&self) -> bool {
        false
    }
    fn open(&self, _cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
        Err("this intentic-remoted was built without a software H.264 encoder".into())
    }
}

/// One monitor's pipeline and the viewers on it.
pub struct Screen {
    pub monitor: String,
    pub hub: Arc<Hub>,
    recorder: Arc<cast_core::record::Recorder>,
    running: Mutex<Option<Pipeline>>,
    viewers: AtomicUsize,
    /// Moves on every join and leave, so a linger that started before a rejoin stops nothing.
    turn: AtomicU64,
}

struct Pipeline {
    video: Video,
    input: bool,
    stops: Vec<Stop>,
}

/// One running screen, as `/stats` lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub monitor: String,
    pub viewers: usize,
    /// What the current picture is encoded with (`nvenc`, `mf`, `openh264`, …).
    pub encoder: &'static str,
    /// How the picture is made (Windows: duplication, the helper, GDI or a placeholder, and why).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<serde_json::Value>,
}

impl Screen {
    fn alive(&self) -> bool {
        self.running
            .lock()
            .expect("screen poisoned")
            .as_ref()
            .is_some_and(|running| !running.video.finished())
    }

    /// Ends the pipeline and what the platform started for it; blocking (it joins the capture thread).
    fn stop(&self) {
        let Some(running) = self.running.lock().expect("screen poisoned").take() else {
            return;
        };
        running.video.stop();
        self.release(running.input, running.stops);
    }

    fn release(&self, input: bool, stops: Vec<Stop>) {
        if input && let Some(input) = self.hub.input.lock().take() {
            input.send(cast_core::input::InputEvent::Shutdown);
        }
        for stop in stops {
            stop();
        }
        log::info!("screen {} stopped", self.monitor);
    }
}

/// A viewer's hold on a screen: the screen lingers once the last is dropped.
pub struct Seat {
    screen: Arc<Screen>,
    screens: Weak<Screens>,
}

impl Seat {
    pub fn screen(&self) -> &Arc<Screen> {
        &self.screen
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        let turn = self.screen.turn.fetch_add(1, Ordering::SeqCst) + 1;
        if self.screen.viewers.fetch_sub(1, Ordering::SeqCst) != 1 {
            return;
        }
        let Some(screens) = self.screens.upgrade() else {
            return;
        };
        let screen = self.screen.clone();
        let linger = screens.linger;
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return screens.retire(&screen);
        };
        runtime.spawn(async move {
            tokio::time::sleep(linger).await;
            if screen.viewers.load(Ordering::SeqCst) == 0
                && screen.turn.load(Ordering::SeqCst) == turn
            {
                let _ = tokio::task::spawn_blocking(move || screens.retire(&screen)).await;
            }
        });
    }
}

/// One monitor's place in the registry: its screen while one runs, held across an open so two viewers open it once.
type Slot = Arc<tokio::sync::Mutex<Option<Arc<Screen>>>>;

/// The screens remoted is serving now, by monitor id.
pub struct Screens {
    platform: Arc<dyn Platform>,
    slots: Mutex<HashMap<String, Slot>>,
    linger: Duration,
}

impl Screens {
    pub fn new(platform: Arc<dyn Platform>, linger: Duration) -> Arc<Self> {
        Arc::new(Self {
            platform,
            slots: Mutex::new(HashMap::new()),
            linger,
        })
    }

    pub fn platform(&self) -> &Arc<dyn Platform> {
        &self.platform
    }

    /// The screens running now (for `/stats`): monitor id, viewers, the encoder the current picture runs on, and how
    /// the platform says the picture is made.
    pub fn running(&self) -> Vec<Running> {
        let slots = self.slots.lock().expect("screens poisoned").clone();
        slots
            .values()
            .filter_map(|slot| slot.try_lock().ok().and_then(|held| held.clone()))
            .filter(|screen| screen.alive())
            .map(|screen| Running {
                monitor: screen.monitor.clone(),
                viewers: screen.viewers.load(Ordering::SeqCst),
                encoder: *screen.hub.encoder.lock(),
                capture: self.platform.screen_status(&screen.monitor),
            })
            .collect()
    }

    /// A running screen's recorder (its screenshots), when the screen runs now.
    pub fn recorder(&self, monitor: &str) -> Option<Arc<cast_core::record::Recorder>> {
        let slot = self
            .slots
            .lock()
            .expect("screens poisoned")
            .get(monitor)
            .cloned()?;
        let held = slot.try_lock().ok()?;
        held.as_ref()
            .filter(|screen| screen.alive())
            .map(|screen| screen.recorder.clone())
    }

    /// Takes a seat on `monitor`'s screen, opening it when nobody watches it yet. Two viewers arriving together open it
    /// once; a screen being opened (a display starting, a portal asking) holds only those who want that screen.
    pub async fn join(self: &Arc<Self>, monitor: &str) -> Result<Seat, String> {
        let slot = self
            .slots
            .lock()
            .expect("screens poisoned")
            .entry(monitor.to_owned())
            .or_default()
            .clone();
        let mut held = slot.lock().await;
        if let Some(screen) = held.as_ref().filter(|screen| screen.alive()) {
            screen.turn.fetch_add(1, Ordering::SeqCst);
            screen.viewers.fetch_add(1, Ordering::SeqCst);
            return Ok(Seat {
                screen: screen.clone(),
                screens: Arc::downgrade(self),
            });
        }
        // A screen that ended (failed, or lingered out while this viewer waited) is opened afresh.
        if let Some(stale) = held.take() {
            let _ = tokio::task::spawn_blocking(move || stale.stop()).await;
        }
        let this = self.clone();
        let id = monitor.to_owned();
        let screen = tokio::task::spawn_blocking(move || this.open(&id))
            .await
            .map_err(|e| format!("opening the screen panicked: {e}"))??;
        screen.viewers.fetch_add(1, Ordering::SeqCst);
        *held = Some(screen.clone());
        Ok(Seat {
            screen,
            screens: Arc::downgrade(self),
        })
    }

    fn open(self: &Arc<Self>, monitor: &str) -> Result<Arc<Screen>, String> {
        let started = std::time::Instant::now();
        let hub = Hub::new(1.0, self.platform.audio_format(monitor));
        let opened = self.platform.open(monitor, &hub, base_video())?;
        let Opened {
            source,
            video,
            input,
            audio,
            stops,
        } = opened;
        let has_input = input.is_some();
        *hub.input.lock() = input;
        let screen = Arc::new(Screen {
            monitor: monitor.to_owned(),
            hub: hub.clone(),
            recorder: cast_core::record::Recorder::new(hub.clone(), Duration::from_secs(60), None),
            running: Mutex::new(None),
            viewers: AtomicUsize::new(0),
            turn: AtomicU64::new(0),
        });
        // A capture that fails for good ends this screen alone: its viewers hear why, the next viewer opens it again.
        let failing = Arc::downgrade(&screen);
        *hub.on_fatal.lock() = Some(Box::new(move |why: String| {
            let Some(screen) = failing.upgrade() else {
                return;
            };
            let ending: Vec<Arc<Client>> = screen.hub.clients.lock().clone();
            for client in ending {
                client.end(SCREEN_FAILED, &format!("the screen stopped: {why}"));
            }
            // The capture thread is this one: it ends by itself once this returns, so nothing joins it.
            let running = screen.running.lock().expect("screen poisoned").take();
            if let Some(running) = running {
                std::thread::spawn(move || screen.release(running.input, running.stops));
            }
        }));
        let video = match cast_core::video::spawn(video, hub.clone(), source) {
            Ok(video) => video,
            Err(e) => {
                screen.release(has_input, stops);
                return Err(format!("the screen's pipeline did not start: {e}"));
            }
        };
        start_audio(audio, &hub);
        *screen.running.lock().expect("screen poisoned") = Some(Pipeline {
            video,
            input: has_input,
            stops,
        });
        log::info!(
            "screen {monitor} opened: {}x{} on {} in {} ms",
            hub.width.load(Ordering::Relaxed),
            hub.height.load(Ordering::Relaxed),
            *hub.encoder.lock(),
            started.elapsed().as_millis()
        );
        Ok(screen)
    }

    /// Stops a screen nobody came back to, and forgets it.
    fn retire(&self, screen: &Arc<Screen>) {
        if screen.viewers.load(Ordering::SeqCst) > 0 {
            return;
        }
        screen.stop();
    }

    /// Stops every screen, then what the platform keeps beside them (remoted ending).
    pub fn stop_all(&self) {
        self.stop_screens();
        self.platform.shutdown();
    }

    fn stop_screens(&self) {
        let slots: Vec<_> = self
            .slots
            .lock()
            .expect("screens poisoned")
            .values()
            .cloned()
            .collect();
        for slot in slots {
            if let Ok(held) = slot.try_lock()
                && let Some(screen) = held.as_ref()
            {
                screen.stop();
            }
        }
    }
}

// A Windows build always has Opus (cast-core's opus1).
#[cfg(any(feature = "opus", windows))]
fn start_audio(audio: Option<Box<dyn cast_core::audio::AudioSource>>, hub: &Arc<Hub>) {
    if let Some(source) = audio {
        cast_core::audio::spawn(source, 128_000, hub.clone());
    }
}

#[cfg(not(any(feature = "opus", windows)))]
fn start_audio(audio: Option<Box<dyn cast_core::audio::AudioSource>>, _hub: &Arc<Hub>) {
    if audio.is_some() {
        log::info!(
            "this intentic-remoted was built without Opus: the screen goes without its sound"
        );
    }
}

/// The monitor a session names, when it is one of the screens there are now.
pub fn monitor_of(platform: &dyn Platform, session: &str) -> Option<String> {
    let id = session.strip_prefix(SESSION_PREFIX)?;
    platform
        .monitors()
        .iter()
        .any(|monitor| monitor.id == id)
        .then(|| id.to_owned())
}

/// What a media socket asks of remoted while it runs: the uplink's control switch and the pause, a fresh token checked
/// as at the upgrade, and the drop that ends it.
struct MediaGuard {
    daemon: Arc<Daemon>,
    uplink: String,
    subject: String,
    revocation: Arc<Revocation>,
    watcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl cast_core::media::Guard for MediaGuard {
    fn input_allowed(&self) -> bool {
        self.daemon.screen_input_allowed(&self.uplink)
    }

    fn refresh(&self, token: &str, read_only: bool) -> Option<u64> {
        let uplink = self.daemon.uplink(&self.uplink)?;
        let claims = self.daemon.check(&uplink, &self.subject, token).ok()?;
        (claims.ro == read_only).then_some(claims.exp)
    }

    fn joined(&self, client: &Arc<Client>) {
        let revocation = self.revocation.clone();
        let client = client.clone();
        // Polled rather than awaited: a drop has seconds to land, and the terminal's revocation keeps its waiting
        // private to the terminal socket.
        let watching = tokio::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_millis(200));
            let code = loop {
                every.tick().await;
                if let Some(code) = revocation.code() {
                    break code;
                }
            };
            client.end(code, "this computer's screen was taken from this viewer");
        });
        *self.watcher.lock().expect("guard poisoned") = Some(watching);
    }
}

type Answer = Response<Full<Bytes>>;

fn refusal(status: StatusCode, words: &str) -> Answer {
    Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(
            serde_json::json!({ "error": words }).to_string(),
        )))
        .expect("a JSON answer always builds")
}

/// `GET /media/<session>?token=…`: a person's media socket on one of this computer's screens.
pub async fn upgrade(
    request: Request<Incoming>,
    daemon: Arc<Daemon>,
    uplink_id: String,
    session: String,
) -> Answer {
    let Some(uplink) = daemon.uplink(&uplink_id) else {
        return refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "this uplink is being closed",
        );
    };
    let query = request.uri().query().unwrap_or("").to_owned();
    let Some(token) = crate::http::param(&query, "token") else {
        return refusal(StatusCode::UNAUTHORIZED, "a screen opens with ?token=");
    };
    let subject = format!("{}{session}", token::MEDIA_SUBJECT);
    let claims = match daemon.check(&uplink, &subject, token) {
        Ok(claims) => claims,
        Err(refused) => return refusal(StatusCode::FORBIDDEN, refused.words()),
    };
    if !uplink.allow.view {
        return refusal(
            StatusCode::FORBIDDEN,
            "watching this computer's screens is switched off for this sandbox",
        );
    }
    let screens = daemon.screens.clone();
    let Some(monitor) = monitor_of(screens.platform().as_ref(), &session) else {
        return refusal(StatusCode::NOT_FOUND, "no such screen on this computer");
    };
    if crate::http::handshake(request.headers()).is_none() {
        return refusal(StatusCode::UPGRADE_REQUIRED, "a screen is a WebSocket");
    }
    let Some(key) = uplink.key() else {
        return refusal(StatusCode::FORBIDDEN, "bad token signature");
    };
    start_rtc(&daemon).await;
    let (mut parts, _body) = request.into_parts();
    use axum::extract::FromRequestParts;
    let ws = match axum::extract::WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(ws) => ws,
        Err(rejection) => {
            return refusal(StatusCode::UPGRADE_REQUIRED, &rejection.body_text());
        }
    };
    let kind = if !claims.ro && uplink.allow.control {
        PersonKind::Control
    } else {
        PersonKind::View
    };
    let task_daemon = daemon.clone();
    let response = ws
        .max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| async move {
            let daemon = task_daemon;
            let viewer = daemon.viewer(&uplink_id, kind, &session, claims.ro);
            let seat = match screens.join(&monitor).await {
                Ok(seat) => seat,
                Err(why) => {
                    log::warn!("uplink {uplink_id}: screen {monitor} did not open: {why}");
                    return close(socket, &format!("the screen did not open: {why}")).await;
                }
            };
            log::info!(
                "uplink {uplink_id}: a person {} screen {monitor}",
                if kind == PersonKind::Control {
                    "controls"
                } else {
                    "watches"
                }
            );
            let screen = seat.screen().clone();
            let app = cast_core::server::App {
                hub: screen.hub.clone(),
                key: Arc::new(key),
                session: Arc::new(subject.clone()),
                recorder: screen.recorder.clone(),
            };
            let guard = Arc::new(MediaGuard {
                daemon: daemon.clone(),
                uplink: uplink_id.clone(),
                subject,
                revocation: viewer.revocation.clone(),
                watcher: Mutex::new(None),
            });
            let reach = cast_core::media::Reach::default();
            let core_claims = cast_core::token::Claims {
                s: claims.s.clone(),
                exp: claims.exp,
                ro: claims.ro,
                iat: claims.iat,
            };
            cast_core::media::serve_guarded(socket, app, core_claims, reach, Some(guard.clone()))
                .await;
            if let Some(watching) = guard.watcher.lock().expect("guard poisoned").take() {
                watching.abort();
            }
            log::info!("uplink {uplink_id}: a person left screen {monitor}");
            drop(seat);
            drop(viewer);
        });
    let (parts, _) = response.into_parts();
    Response::from_parts(parts, Full::new(Bytes::new()))
}

/// `GET /screenshot/<session>`: a running screen's current picture as a PNG, the one its viewers are being sent (a
/// placeholder included). The sandbox's own call down its uplink, as `/stats` is; viewing must be allowed. A screen
/// nobody watches is not opened for it.
pub async fn screenshot(daemon: &Daemon, uplink_id: &str, session: &str) -> Answer {
    let Some(uplink) = daemon.uplink(uplink_id) else {
        return refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "this uplink is being closed",
        );
    };
    if !uplink.allow.view {
        return refusal(
            StatusCode::FORBIDDEN,
            "watching this computer's screens is switched off for this sandbox",
        );
    }
    let Some(monitor) = session.strip_prefix(SESSION_PREFIX) else {
        return refusal(StatusCode::NOT_FOUND, "no such screen on this computer");
    };
    let Some(recorder) = daemon.screens.recorder(monitor) else {
        return refusal(
            StatusCode::NOT_FOUND,
            "that screen is not running (nobody is watching it)",
        );
    };
    use http_body_util::BodyExt;
    let response = cast_core::record::screenshot(axum::extract::State(recorder)).await;
    let (parts, body) = response.into_parts();
    let bytes = body
        .collect()
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();
    Response::from_parts(parts, Full::new(bytes))
}

/// Closes a socket whose screen never opened, saying why.
async fn close(mut socket: axum::extract::ws::WebSocket, why: &str) {
    let mut words = why.to_owned();
    while words.len() > 123 {
        words.pop();
    }
    let frame = axum::extract::ws::CloseFrame {
        code: SCREEN_FAILED,
        reason: words.into(),
    };
    let _ = socket
        .send(axum::extract::ws::Message::Close(Some(frame)))
        .await;
}

/// Starts the peer port once, on the first screen's first viewer: full ICE on an ephemeral UDP port, its host candidate
/// the interface the route out leaves from, its server-reflexive ones from the STUN servers the uplinks name then (the
/// sandbox's `remoteIceServers`, which the agent writes into each uplink). One port serves every uplink, so an uplink
/// whose sandbox named none still gets another's reflexive candidates; with none named anywhere, host candidates only.
/// A port that cannot start leaves every viewer on its socket, which carries everything.
async fn start_rtc(daemon: &Daemon) {
    static STARTED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    STARTED
        .get_or_init(|| async {
            if std::env::var_os("INTENTIC_REMOTED_NO_RTC").is_some() {
                return log::info!("peer connections are off (INTENTIC_REMOTED_NO_RTC)");
            }
            let config = daemon.config().borrow().clone();
            let stun = stun_servers(&config).await;
            let config = cast_core::rtc::RtcConfig {
                bind: "0.0.0.0:0".parse().expect("an address"),
                candidates: host_candidates(),
                ice: cast_core::rtc::Ice::Full,
                stun,
            };
            match tokio::time::timeout(Duration::from_secs(3), cast_core::rtc::start_with(config))
                .await
            {
                Ok(Ok(gathered)) => log::info!(
                    "taking peer connections: host {:?}, reflexive {:?}",
                    gathered.host,
                    gathered.reflexive
                ),
                Ok(Err(e)) => log::warn!("no peer connections: {e}; viewers stay on their sockets"),
                Err(_) => log::warn!(
                    "the peer port took over 3 s to start; viewers stay on their sockets"
                ),
            }
        })
        .await;
}

/// The STUN servers the uplinks that let people watch name (`stun:host[:port]`; `stuns:` and `turn:` left out: the
/// port speaks plain STUN, and the uplink is the relay), resolved. None named: host candidates only.
async fn stun_servers(config: &crate::config::Config) -> Vec<std::net::SocketAddr> {
    let urls: Vec<String> = config
        .uplinks
        .iter()
        .filter(|uplink| uplink.allow.view)
        .filter_map(|uplink| uplink.ice_servers.as_ref())
        .flatten()
        .cloned()
        .collect();
    let mut out = Vec::new();
    for url in urls {
        let Some(with_port) = stun_host(&url) else {
            continue;
        };
        match tokio::time::timeout(Duration::from_secs(2), tokio::net::lookup_host(&with_port))
            .await
        {
            Ok(Ok(addresses)) => {
                for address in addresses.filter(|a| a.is_ipv4()).take(1) {
                    if !out.contains(&address) {
                        out.push(address);
                    }
                }
            }
            Ok(Err(e)) => log::warn!("STUN server {url}: {e}"),
            Err(_) => log::warn!("STUN server {url}: no address within 2 s"),
        }
    }
    out
}

/// The port's host candidate: the address of the interface the route out of this computer leaves from (a viewer on the
/// same network reaches it there), at the port bound (0 stands for it). Asked of the routing table by connecting a UDP
/// socket, which sends nothing. None where there is no route out.
fn host_candidates() -> Vec<std::net::SocketAddr> {
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").and_then(|socket| {
        // TEST-NET-1: never answered, only routed.
        socket.connect("192.0.2.1:9")?;
        socket.local_addr()
    });
    match probe {
        Ok(local) if !local.ip().is_unspecified() && !local.ip().is_loopback() => {
            vec![std::net::SocketAddr::new(local.ip(), 0)]
        }
        _ => Vec::new(),
    }
}

/// `host:port` of a `stun:` URL (RFC 7064: `stun:host[:port][?transport=udp]`, port 3478 when it names none); None for
/// any other scheme.
pub fn stun_host(url: &str) -> Option<String> {
    let host = url.strip_prefix("stun:")?;
    let host = host.split('?').next().unwrap_or(host);
    if host.is_empty() {
        return None;
    }
    let bracketed = host.starts_with('[');
    let has_port = host.rsplit_once(':').is_some_and(|(before, port)| {
        port.parse::<u16>().is_ok() && (!bracketed || before.ends_with(']'))
    });
    Some(if has_port {
        host.to_owned()
    } else {
        format!("{host}:3478")
    })
}

#[cfg(test)]
mod tests;
