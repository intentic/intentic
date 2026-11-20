//! One linked sandbox's uplink: remoted dials `<daemon base>/system/device-uplink` with the uplink's token and this
//! computer's name, and the WebSocket's binary messages then carry one yamux session, exactly the ingress tunnel's
//! carrier (the tunnel crate's `pump` and `mux`). netd opens a stream per viewer and per call of the daemon's; remoted
//! accepts each and serves it as one HTTP/1.1 connection (http.rs) and opens none. netd pings and drops a silent peer; so
//! does remoted, after the tunnel's `DEAD_AFTER`.
//!
//! The uplink is dialled again with a backoff whenever it drops, so it outlives the sandbox restarting. A newer uplink of
//! the same device displaces it (4001): dialled again like any drop. The sandbox withdrawing it (4003: the device's
//! remote switches went off there, or it was disconnected) stops the dialling until the agent starts it again, which
//! moves its `generation`. A token or a device the sandbox does not know (401, 403) is tried again on a long backoff, in
//! case the sandbox comes back knowing it.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use http::Uri;
use http::header::{AUTHORIZATION, HeaderValue, USER_AGENT};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_util::either::Either;
use tunnel::{Close, Ended, Liveness};

use crate::config::{Config, UplinkConfig};
use crate::daemon::Daemon;
use crate::status::UplinkState;

/// Where remoted dials the sandbox (browser-wire's `DEVICE_UPLINK_PATH`).
pub const UPLINK_PATH: &str = "/system/device-uplink";

/// The device an uplink is for, on its upgrade (browser-wire's `DEVICE_HEADER`).
pub const DEVICE_HEADER: &str = "x-intentic-device";

/// A newer uplink of the same device replaced this one (browser-wire's `DEVICE_UPLINK_DISPLACED`).
pub const DISPLACED: u16 = 4001;

/// The sandbox withdrew this uplink (browser-wire's `DEVICE_UPLINK_WITHDRAWN`).
pub const WITHDRAWN: u16 = 4003;

// A dial's TCP connect, TLS and upgrade together; the edge answers its own errors at once.
const DIAL_PATIENCE: Duration = Duration::from_secs(15);

const BACKOFF_FIRST: Duration = Duration::from_secs(1);

// A sandbox restarting is back within tens of seconds, and its people are waiting on this uplink.
const BACKOFF_MAX: Duration = Duration::from_secs(30);

// A token the sandbox does not know stays unknown until the agent is asked to start again.
const REFUSED_MAX: Duration = Duration::from_secs(300);

// An uplink held this long had worked: its next drop starts the backoff over.
const HELD_LONG: Duration = Duration::from_secs(30);

// What a closing uplink's close frame is given to leave.
const CLOSE_PATIENCE: Duration = Duration::from_secs(2);

type Io = Either<TcpStream, tokio_rustls::client::TlsStream<TcpStream>>;

/// Why a dial did not give an uplink.
#[derive(Debug)]
pub enum DialError {
    /// The sandbox answered, and does not take this token or device.
    Refused(u16),
    Failed(String),
}

// How a held uplink ended.
enum Held {
    /// Its configuration is gone: remoted serves this sandbox no more.
    Removed,
    /// Its address or credentials changed: dial again at once.
    Redial,
    Ended(Ended),
}

struct Backoff {
    next: Duration,
}

impl Backoff {
    fn new() -> Self {
        Self {
            next: BACKOFF_FIRST,
        }
    }

    // The wait before the next try, jittered by a fifth either way so several computers do not dial in step.
    fn take(&mut self, max: Duration) -> Duration {
        let base = self.next.min(max);
        self.next = (base * 2).min(max);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(0);
        let spread = f64::from(nanos % 1000) / 1000.0 * 0.4 - 0.2;
        base.mul_f64(1.0 + spread)
    }

    fn reset(&mut self) {
        self.next = BACKOFF_FIRST;
    }
}

fn current(config: &watch::Receiver<Config>, id: &str) -> Option<UplinkConfig> {
    config
        .borrow()
        .uplinks
        .iter()
        .find(|uplink| uplink.id == id)
        .cloned()
}

/// Runs one uplink for as long as the configuration names it.
pub async fn run(daemon: Arc<Daemon>, id: String) {
    let mut config = daemon.config();
    let mut backoff = Backoff::new();
    let mut withdrawn: Option<u64> = None;
    let mut last_error: Option<String> = None;
    loop {
        let Some(uplink) = current(&config, &id) else {
            daemon.status.forget_uplink(&id);
            return;
        };
        if withdrawn == Some(uplink.generation) {
            if config.changed().await.is_err() {
                return;
            }
            continue;
        }
        withdrawn = None;
        if daemon.status.uplink_state(&id) != Some(UplinkState::Down) {
            daemon.status.uplink(
                &id,
                UplinkState::Connecting,
                uplink.generation,
                last_error.clone(),
            );
        }
        let wait = match dial(&uplink).await {
            Ok(socket) => {
                log::info!("uplink {id}: up to {}", uplink.url);
                daemon
                    .status
                    .uplink(&id, UplinkState::Up, uplink.generation, None);
                last_error = None;
                let up_since = Instant::now();
                match hold(&daemon, &uplink, socket, &mut config).await {
                    Held::Removed => {
                        log::info!("uplink {id}: closed, its sandbox's remote access is off here");
                        daemon.status.forget_uplink(&id);
                        return;
                    }
                    Held::Redial => {
                        log::info!(
                            "uplink {id}: dialling again with its new address or credentials"
                        );
                        backoff.reset();
                        continue;
                    }
                    Held::Ended(Ended::Closed(Some(WITHDRAWN))) => {
                        log::info!(
                            "uplink {id}: withdrawn by the sandbox; waiting to be started again"
                        );
                        withdrawn = Some(uplink.generation);
                        daemon
                            .status
                            .uplink(&id, UplinkState::Withdrawn, uplink.generation, None);
                        continue;
                    }
                    Held::Ended(ended) => {
                        let words = match ended {
                            Ended::Closed(Some(DISPLACED)) => {
                                "replaced by a newer uplink of this device".to_owned()
                            }
                            Ended::Closed(code) => format!("closed by the sandbox ({code:?})"),
                            Ended::Dropped(why) => why,
                        };
                        log::warn!("uplink {id}: dropped: {words}");
                        if up_since.elapsed() >= HELD_LONG {
                            backoff.reset();
                        }
                        daemon.status.uplink(
                            &id,
                            UplinkState::Down,
                            uplink.generation,
                            Some(words.clone()),
                        );
                        last_error = Some(words);
                        backoff.take(BACKOFF_MAX)
                    }
                }
            }
            Err(DialError::Refused(code)) => {
                let words = format!(
                    "the sandbox refused this computer's uplink ({code}): it does not know its {}",
                    if code == 401 { "token" } else { "device" }
                );
                if last_error.as_deref() != Some(&words) {
                    log::warn!("uplink {id}: {words}");
                }
                daemon.status.uplink(
                    &id,
                    UplinkState::Refused,
                    uplink.generation,
                    Some(words.clone()),
                );
                last_error = Some(words);
                backoff.take(REFUSED_MAX)
            }
            Err(DialError::Failed(words)) => {
                if last_error.as_deref() != Some(&words) {
                    log::warn!("uplink {id}: {words}");
                }
                let state = match daemon.status.uplink_state(&id) {
                    Some(UplinkState::Down) => UplinkState::Down,
                    _ => UplinkState::Connecting,
                };
                daemon
                    .status
                    .uplink(&id, state, uplink.generation, Some(words.clone()));
                last_error = Some(words);
                backoff.take(BACKOFF_MAX)
            }
        };
        // Waits out the backoff, unless what it would dial changes first.
        let until = tokio::time::Instant::now() + wait;
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(until) => break,
                changed = config.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    match current(&config, &id) {
                        Some(now) if now.same_dial(&uplink) && now.generation == uplink.generation => {}
                        _ => {
                            backoff.reset();
                            break;
                        }
                    }
                }
            }
        }
    }
}

// Serves the uplink's streams until it ends, or until its configuration says to close it.
async fn hold(
    daemon: &Arc<Daemon>,
    uplink: &UplinkConfig,
    socket: WebSocketStream<Io>,
    config: &mut watch::Receiver<Config>,
) -> Held {
    let (closing, closed) = watch::channel(None);
    let (session, mut pumping) = tunnel::pump(socket, Liveness::Listens, closed);
    let (mut arrivals, driving) = tunnel::mux::server(EofGrace::new(session));
    // The session's task ends with its socket; aborted here so nothing of this uplink outlives its return.
    let _driving = AbortOnDrop(driving);
    let close = |closing: &watch::Sender<Option<Close>>, reason: &'static str| {
        let _ = closing.send(Some(Close {
            code: 1000,
            reason: reason.into(),
        }));
    };
    loop {
        tokio::select! {
            stream = arrivals.recv() => match stream {
                Some(stream) => {
                    tokio::spawn(crate::http::serve(stream, daemon.clone(), uplink.id.clone()));
                }
                // The session ended: the pump says how.
                None => return Held::Ended(pumping.ended().await),
            },
            ended = pumping.ended() => return Held::Ended(ended),
            changed = config.changed() => {
                let now = if changed.is_ok() { current(config, &uplink.id) } else { None };
                match now {
                    None => {
                        close(&closing, "remote access turned off on this computer");
                        let _ = tokio::time::timeout(CLOSE_PATIENCE, pumping.ended()).await;
                        return Held::Removed;
                    }
                    Some(now) if !now.same_dial(uplink) => {
                        close(&closing, "dialling again");
                        let _ = tokio::time::timeout(CLOSE_PATIENCE, pumping.ended()).await;
                        return Held::Redial;
                    }
                    // Started again over the same dial: the uplink held is the one asked for, at its new generation.
                    Some(now) => daemon.status.uplink(&uplink.id, UplinkState::Up, now.generation, None),
                }
            }
        }
    }
}

/// The session's end of the pump, whose end of input is held back for [`EOF_GRACE`]. The pump says how the socket ended by
/// whichever of its directions it finds stopped: the socket's reader, holding the far end's close code, or its writer,
/// which stops once the session it writes for has ended. The session ends on the reader's own end of input, two task
/// hops later, so a busy runtime can find both stopped and take the writer's word: a withdrawal (4003) read as a plain
/// drop would be dialled again at once. The grace keeps the session up until the reader's word is the only one.
struct EofGrace<S> {
    inner: S,
    ending: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

/// Long enough for the pump to hear its reader's end first; nothing waits on it but a session already over.
const EOF_GRACE: Duration = Duration::from_secs(1);

impl<S> EofGrace<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
            ending: None,
        }
    }
}

impl<S: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for EofGrace<S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use std::future::Future;
        use std::task::Poll;
        if let Some(ending) = self.ending.as_mut() {
            // Then the end of input, as it came.
            return ending.as_mut().poll(cx).map(|()| Ok(()));
        }
        let before = buf.filled().len();
        match std::pin::Pin::new(&mut self.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(())) if buf.filled().len() == before && buf.remaining() > 0 => {
                let mut ending = Box::pin(tokio::time::sleep(EOF_GRACE));
                let poll = ending.as_mut().poll(cx).map(|()| Ok(()));
                self.ending = Some(ending);
                poll
            }
            other => other,
        }
    }
}

impl<S: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for EofGrace<S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, bytes)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The uplink's address: the daemon base with its scheme made a WebSocket's.
pub fn uplink_url(base: &str) -> Option<String> {
    let base = base.trim_end_matches('/');
    let rest = base
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| {
            base.strip_prefix("http://")
                .map(|rest| format!("ws://{rest}"))
        })?;
    Some(format!("{rest}{UPLINK_PATH}"))
}

fn tls() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            // This computer's own store too: a company's TLS inspection is trusted where the browser trusts it.
            let native = rustls_native_certs::load_native_certs();
            let (added, _) = roots.add_parsable_certificates(native.certs);
            log::debug!("{added} certificates from this computer's store");
            let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("ring offers the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            Arc::new(config)
        })
        .clone()
}

/// Dials the uplink and answers its WebSocket, upgraded.
pub async fn dial(uplink: &UplinkConfig) -> Result<WebSocketStream<Io>, DialError> {
    tokio::time::timeout(DIAL_PATIENCE, dial_now(uplink))
        .await
        .unwrap_or_else(|_| {
            Err(DialError::Failed(format!(
                "no answer from {} within {DIAL_PATIENCE:?}",
                uplink.url
            )))
        })
}

async fn dial_now(uplink: &UplinkConfig) -> Result<WebSocketStream<Io>, DialError> {
    let failed = |words: String| DialError::Failed(words);
    let url = uplink_url(&uplink.url)
        .ok_or_else(|| failed(format!("{} is not an http(s) address", uplink.url)))?;
    let uri: Uri = url
        .parse()
        .map_err(|error| failed(format!("{url}: {error}")))?;
    let secure = uri.scheme_str() == Some("wss");
    let host = uri
        .host()
        .ok_or_else(|| failed(format!("{url} names no host")))?;
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| failed(format!("{url}: {error}")))?;
    let headers = request.headers_mut();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", uplink.uplink_token))
            .map_err(|_| failed("the uplink token is not a header value".into()))?,
    );
    headers.insert(
        DEVICE_HEADER,
        HeaderValue::from_str(&uplink.device)
            .map_err(|_| failed("the device name is not a header value".into()))?,
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&format!("intentic-remoted/{}", crate::VERSION))
            .expect("a version is a header value"),
    );
    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| failed(format!("cannot reach {host}:{port}: {error}")))?;
    let _ = tcp.set_nodelay(true);
    let io: Io = if secure {
        let name = rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|error| failed(format!("{host}: {error}")))?;
        let tls = tokio_rustls::TlsConnector::from(tls())
            .connect(name, tcp)
            .await
            .map_err(|error| failed(format!("TLS with {host}: {error}")))?;
        Either::Right(tls)
    } else {
        Either::Left(tcp)
    };
    match tokio_tungstenite::client_async_with_config(request, io, Some(tunnel::socket_config()))
        .await
    {
        Ok((socket, _)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            let status = response.status().as_u16();
            if status == 401 || status == 403 {
                Err(DialError::Refused(status))
            } else {
                Err(failed(format!(
                    "the sandbox answered {status} instead of the uplink"
                )))
            }
        }
        Err(error) => Err(failed(format!("the uplink's upgrade failed: {error}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn the_sessions_end_of_input_arrives_a_grace_after_the_pump_ended() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (near, mut far) = tokio::io::duplex(64);
        let mut graced = EofGrace::new(near);
        far.write_all(b"ab").await.unwrap();
        drop(far);
        let mut read = [0_u8; 8];
        assert_eq!(graced.read(&mut read).await.unwrap(), 2);
        let started = tokio::time::Instant::now();
        assert_eq!(graced.read(&mut read).await.unwrap(), 0);
        assert_eq!(started.elapsed(), EOF_GRACE);
    }

    #[test]
    fn the_uplinks_address_is_the_daemon_base_as_a_websocket() {
        assert_eq!(
            uplink_url("https://a29b.intentic.app/").as_deref(),
            Some("wss://a29b.intentic.app/system/device-uplink")
        );
        assert_eq!(
            uplink_url("http://127.0.0.1:7071").as_deref(),
            Some("ws://127.0.0.1:7071/system/device-uplink")
        );
        assert_eq!(uplink_url("ftp://x"), None);
    }

    #[test]
    fn the_backoff_doubles_to_its_ceiling_within_its_jitter_and_starts_over() {
        let mut backoff = Backoff::new();
        let waits: Vec<Duration> = (0..8).map(|_| backoff.take(BACKOFF_MAX)).collect();
        assert!(waits[0] >= Duration::from_millis(800) && waits[0] <= Duration::from_millis(1200));
        assert!(waits[1] >= Duration::from_millis(1600) && waits[1] <= Duration::from_millis(2400));
        assert!(waits[7] <= BACKOFF_MAX.mul_f64(1.2) && waits[7] >= BACKOFF_MAX.mul_f64(0.8));
        backoff.reset();
        assert!(backoff.take(BACKOFF_MAX) <= Duration::from_millis(1200));
    }
}
