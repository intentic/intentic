//! A connected computer's remote screen and terminals, served by its `intentic-remoted` (2026-11-20). remoted dials the
//! sandbox at browser-wire's `DEVICE_UPLINK_PATH` with a token Node registered for that device, and the WebSocket then
//! carries one yamux session on which netd opens a stream per exchange, each one HTTP/1.1 connection remoted serves:
//! a person's viewer at `DEVICE_MEDIA_PATH` or `DEVICE_TERMINAL_PATH`, its path rewritten to remoted's own
//! (`proxy.rs`), and each connection Node makes to the device's socket, `<devices dir>/<device>.sock`, where it asks
//! remoted's control routes as it asks castd's. The session is the tunnel crate's, run with its ends swapped: here netd
//! opens and pings, as the edge opens and netd pings on `/tunnel/v2`.
//!
//! Node registers a device by its token's SHA-256 and withdraws it; netd never sees a token it was not shown at a dial.
//! The newest uplink of a device replaces the one before it (closed with `DEVICE_UPLINK_DISPLACED`), a withdrawal closes
//! it with `DEVICE_UPLINK_WITHDRAWN`, and registrations outlive a Node restart, as terminals and media sockets do: the
//! next Node hears them whole in `ToNode::DeviceUplinks` after its hello.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use browser_wire::{DEVICE_HEADER, DEVICE_UPLINK_DISPLACED, DEVICE_UPLINK_WITHDRAWN};
use http::header::{AUTHORIZATION, HeaderMap};
use http::{Request, Response, StatusCode, Version};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use netd_wire::{DeviceUplinkState, ToNode};
use relay::body::{self, Body};
use tokio::net::UnixListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::Role;
use tunnel::{Close, Liveness, mux};

use crate::term::Handshake;

// How long a refused uplink's close frame gets to leave before its socket is dropped.
const CLOSE_PATIENCE: std::time::Duration = std::time::Duration::from_secs(1);

const UPGRADES: &str = "a device's uplink opens as a WebSocket";
const UNKNOWN: &str = "no device is registered for this uplink's token";
const ANOTHER: &str = "this uplink's token is another device's";

/// What netd tells Node, handed in so the registry is tested without a link.
pub type Tell = Arc<dyn Fn(&ToNode) + Send + Sync>;

/// One registered device: the digest its uplink must present, and the uplink while one is up.
struct Registered {
    digest: String,
    uplink: Option<Uplink>,
}

/// A held uplink: the session to open streams on, what closes its socket, and the socket served to Node.
struct Uplink {
    id: u64,
    opener: mux::Opener,
    // Shared with the uplink's own task, so a close sent as the uplink is dropped still reaches its socket.
    closing: Arc<watch::Sender<Option<Close>>>,
    serving: Option<JoinHandle<()>>,
}

impl Uplink {
    fn close(mut self, code: u16, reason: &'static str) {
        self.closing.send_replace(Some(Close {
            code,
            reason: reason.into(),
        }));
        if let Some(serving) = self.serving.take() {
            serving.abort();
        }
    }
}

pub struct Devices {
    registered: Mutex<HashMap<String, Registered>>,
    dir: PathBuf,
    tell: Tell,
    next: AtomicU64,
}

/// `[A-Za-z0-9_-]{1,64}`: a device's and a session's name, each of which becomes part of a path or a file name.
pub fn is_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Lowercase hex SHA-256 of a token's UTF-8 bytes, as Node registers it.
pub fn digest_of(token: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, token.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// The bearer token an upgrade carries, if any.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|token| !token.is_empty())
}

fn plain(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body::full(message.to_owned()))
        .expect("a static response always builds")
}

impl Devices {
    /// `dir` is where each connected device's socket for Node goes, made owner-only when the first one is.
    pub fn new(dir: PathBuf, tell: Tell) -> Self {
        Self {
            registered: Mutex::new(HashMap::new()),
            dir,
            tell,
            next: AtomicU64::new(1),
        }
    }

    /// Lets `device`'s remoted hold an uplink presenting the token with this digest. A different digest closes the
    /// uplink the earlier token holds; the same one changes nothing.
    pub fn register(&self, device: String, digest: String) {
        if !is_name(&device) || digest.len() != 64 {
            tracing::warn!(%device, "refused a device registration with a name or digest netd cannot use");
            return;
        }
        let replaced = {
            let mut registered = self.registered.lock().expect("devices poisoned");
            match registered.get_mut(&device) {
                Some(known) if known.digest == digest => return,
                Some(known) => {
                    known.digest = digest;
                    known.uplink.take()
                }
                None => {
                    registered.insert(
                        device.clone(),
                        Registered {
                            digest,
                            uplink: None,
                        },
                    );
                    None
                }
            }
        };
        if let Some(uplink) = replaced {
            remove_socket(&self.socket_of(&device));
            uplink.close(DEVICE_UPLINK_WITHDRAWN, "the device's token was replaced");
        }
        tracing::info!(%device, "a device may hold an uplink");
        self.report_again();
    }

    /// Forgets `device`: its uplink is closed, its socket removed, and a later dial refused.
    pub fn withdraw(&self, device: &str) {
        let Some(known) = self
            .registered
            .lock()
            .expect("devices poisoned")
            .remove(device)
        else {
            return;
        };
        if let Some(uplink) = known.uplink {
            remove_socket(&self.socket_of(device));
            uplink.close(DEVICE_UPLINK_WITHDRAWN, "the sandbox withdrew this device");
        }
        tracing::info!(%device, "a device's uplink was withdrawn");
        self.report_again();
    }

    /// Every registered device and whether its uplink is up.
    pub fn report(&self) -> ToNode {
        let registered = self.registered.lock().expect("devices poisoned");
        let mut uplinks: Vec<DeviceUplinkState> = registered
            .iter()
            .map(|(device, known)| DeviceUplinkState {
                device: device.clone(),
                connected: known.uplink.is_some(),
            })
            .collect();
        uplinks.sort_by(|a, b| a.device.cmp(&b.device));
        ToNode::DeviceUplinks { uplinks }
    }

    /// Tells Node where every device stands: on each change, and to a Node that just said hello.
    pub fn report_again(&self) {
        (self.tell)(&self.report());
    }

    /// The session of `device`'s uplink, while one is up.
    pub fn opener(&self, device: &str) -> Option<mux::Opener> {
        self.registered
            .lock()
            .expect("devices poisoned")
            .get(device)?
            .uplink
            .as_ref()
            .map(|uplink| uplink.opener.clone())
    }

    /// Answers an upgrade at `DEVICE_UPLINK_PATH`: 101 for a token Node registered, then the uplink runs on its own.
    pub fn uplink(self: &Arc<Self>, mut request: Request<Incoming>) -> Response<Body> {
        let handshake = match request.version() {
            Version::HTTP_11 => Handshake::of(request.headers()),
            _ => None,
        };
        let Some(handshake) = handshake else {
            return plain(StatusCode::UPGRADE_REQUIRED, UPGRADES);
        };
        let device = match self.admit(request.headers()) {
            Ok(device) => device,
            Err(refusal) => return refusal,
        };
        let upgrade = hyper::upgrade::on(&mut request);
        let devices = self.clone();
        tokio::spawn(async move {
            let Ok(upgraded) = upgrade.await else {
                return;
            };
            let socket = WebSocketStream::from_raw_socket(
                TokioIo::new(upgraded),
                Role::Server,
                Some(tunnel::socket_config()),
            )
            .await;
            devices.run(device, socket).await;
        });
        handshake.switching()
    }

    // The device a dial's token was registered for, and its digest; a refusal for anything else.
    fn admit(&self, headers: &HeaderMap) -> Result<(String, String), Response<Body>> {
        let Some(token) = bearer(headers) else {
            return Err(plain(StatusCode::UNAUTHORIZED, UNKNOWN));
        };
        let digest = digest_of(token);
        let named = headers
            .get(DEVICE_HEADER)
            .and_then(|value| value.to_str().ok());
        let registered = self.registered.lock().expect("devices poisoned");
        let Some(device) = registered
            .iter()
            .find(|(_, known)| known.digest == digest)
            .map(|(device, _)| device.clone())
        else {
            tracing::info!(named, "refused a device uplink whose token no device holds");
            return Err(plain(StatusCode::UNAUTHORIZED, UNKNOWN));
        };
        if named.is_some_and(|named| named != device) {
            tracing::warn!(%device, named, "refused a device uplink naming another device than its token's");
            return Err(plain(StatusCode::FORBIDDEN, ANOTHER));
        }
        Ok((device, digest))
    }

    // One uplink from its socket to its end: held as the device's (replacing any before it) while its registration
    // stands, its socket served to Node, then forgotten if it is still the device's own.
    async fn run<S>(self: Arc<Self>, (device, digest): (String, String), socket: WebSocketStream<S>)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (closing, closed) = watch::channel(None);
        let closing = Arc::new(closing);
        let (session, mut pumping) = tunnel::pump(socket, Liveness::Pings, closed);
        let (opener, mut driving) = mux::client(session);
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let uplink = Uplink {
            id,
            opener: opener.clone(),
            closing: closing.clone(),
            serving: None,
        };
        let path = self.socket_of(&device);
        let displaced = match self.install(&device, &digest, uplink, &path, opener) {
            Ok(displaced) => displaced,
            // Withdrawn or re-registered while the upgrade completed: this token opens nothing any more.
            Err(refused) => {
                refused.close(DEVICE_UPLINK_WITHDRAWN, "the sandbox withdrew this device");
                let _ = tokio::time::timeout(CLOSE_PATIENCE, pumping.ended()).await;
                return;
            }
        };
        if let Some(displaced) = displaced {
            tracing::info!(%device, "a newer uplink replaced the device's earlier one");
            displaced.close(DEVICE_UPLINK_DISPLACED, "a newer uplink replaced this one");
        }
        tracing::info!(%device, "a device's uplink is up");
        self.report_again();
        let ended = tokio::select! {
            ended = pumping.ended() => format!("{ended:?}"),
            driven = &mut driving => format!("the session ended: {driven:?}"),
        };
        driving.abort();
        let mine = {
            let mut registered = self.registered.lock().expect("devices poisoned");
            match registered.get_mut(&device) {
                Some(known) if known.uplink.as_ref().is_some_and(|held| held.id == id) => {
                    known.uplink.take()
                }
                _ => None,
            }
        };
        tracing::info!(%device, %ended, "a device's uplink ended");
        if let Some(uplink) = mine {
            remove_socket(&path);
            uplink.close(1001, "the uplink ended");
            self.report_again();
        }
        drop(closing);
    }

    // Holds `uplink` as the device's while its registration still names `digest`, answering the uplink it displaced;
    // the uplink itself back when the registration is gone or names another token. The socket is bound under the lock,
    // after the displaced one's file is gone, so the path always reaches the newest uplink.
    fn install(
        &self,
        device: &str,
        digest: &str,
        uplink: Uplink,
        path: &Path,
        opener: mux::Opener,
    ) -> Result<Option<Uplink>, Uplink> {
        let mut registered = self.registered.lock().expect("devices poisoned");
        let Some(known) = registered
            .get_mut(device)
            .filter(|known| known.digest == digest)
        else {
            return Err(uplink);
        };
        let displaced = known.uplink.replace(uplink);
        remove_socket(path);
        let serving = self.serve_socket(device, path, opener);
        if let Some(held) = known.uplink.as_mut() {
            held.serving = serving;
        }
        Ok(displaced)
    }

    fn socket_of(&self, device: &str) -> PathBuf {
        self.dir.join(format!("{device}.sock"))
    }

    // Node's socket for the device: each connection a stream down the uplink, spliced until either side ends.
    fn serve_socket(
        &self,
        device: &str,
        path: &Path,
        opener: mux::Opener,
    ) -> Option<JoinHandle<()>> {
        let bound = std::fs::create_dir_all(&self.dir)
            .and_then(|()| {
                std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))
            })
            .and_then(|()| UnixListener::bind(path))
            .and_then(|listener| {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
                Ok(listener)
            });
        let listener = match bound {
            Ok(listener) => listener,
            Err(error) => {
                tracing::error!(%error, %device, path = %path.display(), "could not serve the device's socket to the daemon");
                return None;
            }
        };
        let device = device.to_owned();
        Some(tokio::spawn(async move {
            loop {
                let mut local = match listener.accept().await {
                    Ok((local, _)) => local,
                    Err(error) => {
                        tracing::warn!(%error, %device, "the device's socket failed to accept");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let opener = opener.clone();
                let device = device.clone();
                tokio::spawn(async move {
                    match opener.open().await {
                        Ok(mut far) => {
                            let _ = tokio::io::copy_bidirectional(&mut local, &mut far).await;
                        }
                        Err(error) => {
                            tracing::debug!(%error, %device, "the device's uplink opened no stream for the daemon");
                        }
                    }
                });
            }
        }))
    }
}

fn remove_socket(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_what_a_path_and_a_file_can_carry() {
        assert!(is_name("rog"));
        assert!(is_name("radarsu-server_2"));
        assert!(is_name(&"a".repeat(64)));
        for bad in [
            "",
            "rog::wsl:arch",
            "a.b",
            "a/b",
            "..",
            "ą",
            &"a".repeat(65),
        ] {
            assert!(!is_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_digest_is_the_hex_sha256_node_computes() {
        // `printf token | sha256sum`
        assert_eq!(
            digest_of("token"),
            "3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0"
        );
    }

    #[test]
    fn only_a_bearer_token_is_read() {
        let mut headers = HeaderMap::new();
        assert_eq!(bearer(&headers), None);
        headers.insert(AUTHORIZATION, "Bearer abc".parse().unwrap());
        assert_eq!(bearer(&headers), Some("abc"));
        headers.insert(AUTHORIZATION, "bearer  abc ".parse().unwrap());
        assert_eq!(bearer(&headers), Some("abc"));
        headers.insert(AUTHORIZATION, "Basic abc".parse().unwrap());
        assert_eq!(bearer(&headers), None);
        headers.insert(AUTHORIZATION, "Bearer ".parse().unwrap());
        assert_eq!(bearer(&headers), None);
    }

    fn registry() -> (Arc<Devices>, Arc<Mutex<Vec<ToNode>>>) {
        let told = Arc::new(Mutex::new(Vec::new()));
        let telling = told.clone();
        let dir = std::env::temp_dir().join(format!("netd-devices-{}", std::process::id()));
        let devices = Devices::new(
            dir,
            Arc::new(move |message: &ToNode| telling.lock().unwrap().push(message.clone())),
        );
        (Arc::new(devices), told)
    }

    #[test]
    fn node_hears_every_registration_whole_and_a_repeat_changes_nothing() {
        let (devices, told) = registry();
        devices.register("rog".into(), digest_of("one"));
        devices.register("omen".into(), digest_of("two"));
        devices.register("rog".into(), digest_of("one"));
        devices.register("bad name".into(), digest_of("three"));
        devices.withdraw("omen");
        devices.withdraw("never");
        let told = told.lock().unwrap();
        let states = |message: &ToNode| match message {
            ToNode::DeviceUplinks { uplinks } => uplinks
                .iter()
                .map(|state| (state.device.clone(), state.connected))
                .collect::<Vec<_>>(),
            other => panic!("told {other:?}"),
        };
        assert_eq!(
            told.iter().map(states).collect::<Vec<_>>(),
            [
                vec![("rog".to_owned(), false)],
                vec![("omen".to_owned(), false), ("rog".to_owned(), false)],
                vec![("rog".to_owned(), false)],
            ]
        );
    }

    #[test]
    fn a_dial_is_admitted_by_its_token_and_refused_for_naming_another_device() {
        let (devices, _) = registry();
        devices.register("rog".into(), digest_of("rog-token"));
        let headers = |token: Option<&str>, named: Option<&str>| {
            let mut headers = HeaderMap::new();
            if let Some(token) = token {
                headers.insert(AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
            }
            if let Some(named) = named {
                headers.insert(DEVICE_HEADER, named.parse().unwrap());
            }
            headers
        };
        let status = |result: Result<(String, String), Response<Body>>| match result {
            Ok((device, _)) => Ok(device),
            Err(refusal) => Err(refusal.status().as_u16()),
        };
        assert_eq!(
            status(devices.admit(&headers(Some("rog-token"), Some("rog")))),
            Ok("rog".to_owned())
        );
        assert_eq!(
            status(devices.admit(&headers(Some("rog-token"), None))),
            Ok("rog".to_owned())
        );
        assert_eq!(
            status(devices.admit(&headers(Some("rog-token"), Some("omen")))),
            Err(403)
        );
        assert_eq!(
            status(devices.admit(&headers(Some("guess"), Some("rog")))),
            Err(401)
        );
        assert_eq!(status(devices.admit(&headers(None, Some("rog")))), Err(401));
    }
}
