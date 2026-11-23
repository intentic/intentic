//! Uplinks: a far end that dials this netd at a path of its own with a token Node registered for it, after which the
//! WebSocket carries one yamux session on which netd opens a stream per exchange, each one HTTP/1.1 connection the far
//! end serves. The session is the tunnel crate's, run with its ends swapped: here netd opens and pings, as the edge opens
//! and netd pings on `/tunnel/v2`; a stream the far end opens is refused, so an uplink never reaches into this sandbox.
//!
//! One registry per kind, each with its own registrations, so one kind's token never opens another's uplink:
//!
//! - a connected computer's `intentic-remoted` (2026-11-20, [`Kind::device`]): a person's viewer at `DEVICE_MEDIA_PATH`
//!   or `DEVICE_TERMINAL_PATH`, its path rewritten to remoted's own (`proxy.rs`), and each connection Node makes to the
//!   device's socket, `<devices dir>/<device>.sock`, where it asks remoted's control routes as it asks castd's;
//! - a runner's netd (2026-11-23, [`Kind::runner`]): a person's view of the runner at `RUNNER_VIEW_PATH`, gated by
//!   netd's allowlist and Node's ticket (`proxy.rs`), and a runner-slot preview.
//!
//! Node registers a far end by its token's SHA-256 and withdraws it; netd never sees a token it was not shown at a dial.
//! The newest uplink of a name replaces the one before it (closed with the kind's displaced code), a withdrawal closes
//! it with the kind's withdrawn code, and registrations outlive a Node restart, as terminals and media sockets do: the
//! next Node hears them whole after its hello.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use browser_wire::{
    DEVICE_HEADER, DEVICE_UPLINK_DISPLACED, DEVICE_UPLINK_WITHDRAWN, RUNNER_HEADER,
    RUNNER_UPLINK_DISPLACED, RUNNER_UPLINK_WITHDRAWN,
};
use http::header::{AUTHORIZATION, HeaderMap};
use http::{Request, Response, StatusCode, Version};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use netd_wire::{DeviceUplinkState, RunnerUplinkState, ToNode};
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

/// What differs between one kind of uplink and another.
pub struct Kind {
    /// The far end as a log line names it.
    noun: &'static str,
    /// The header a dial names its far end in.
    header: &'static str,
    displaced: u16,
    withdrawn: u16,
    /// Where each far end's socket for Node goes, made owner-only when the first one is; none serves no socket.
    dir: Option<PathBuf>,
    /// Every registration and whether its uplink is up, as Node is told.
    report: fn(Vec<(String, bool)>) -> ToNode,
    upgrades: &'static str,
    unknown: &'static str,
    another: &'static str,
}

impl Kind {
    /// A connected computer's remoted, served to Node on `<dir>/<device>.sock`.
    pub fn device(dir: PathBuf) -> Self {
        Self {
            noun: "device",
            header: DEVICE_HEADER,
            displaced: DEVICE_UPLINK_DISPLACED,
            withdrawn: DEVICE_UPLINK_WITHDRAWN,
            dir: Some(dir),
            report: |held| ToNode::DeviceUplinks {
                uplinks: held
                    .into_iter()
                    .map(|(device, connected)| DeviceUplinkState { device, connected })
                    .collect(),
            },
            upgrades: "a device's uplink opens as a WebSocket",
            unknown: "no device is registered for this uplink's token",
            another: "this uplink's token is another device's",
        }
    }

    /// A runner's netd, which nothing on this side dials but netd's own proxy.
    pub fn runner() -> Self {
        Self {
            noun: "runner",
            header: RUNNER_HEADER,
            displaced: RUNNER_UPLINK_DISPLACED,
            withdrawn: RUNNER_UPLINK_WITHDRAWN,
            dir: None,
            report: |held| ToNode::RunnerUplinks {
                uplinks: held
                    .into_iter()
                    .map(|(runner, connected)| RunnerUplinkState { runner, connected })
                    .collect(),
            },
            upgrades: "a runner's uplink opens as a WebSocket",
            unknown: "no runner is registered for this uplink's token",
            another: "this uplink's token is another runner's",
        }
    }
}

/// What netd tells Node, handed in so the registry is tested without a link.
pub type Tell = Arc<dyn Fn(&ToNode) + Send + Sync>;

/// One registered far end: the digest its uplink must present, and the uplink while one is up.
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

pub struct Uplinks {
    kind: Kind,
    registered: Mutex<HashMap<String, Registered>>,
    tell: Tell,
    next: AtomicU64,
}

/// `[A-Za-z0-9_-]{1,64}`: a device's, a runner's and a session's name, each of which becomes part of a path or a file name.
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

impl Uplinks {
    pub fn new(kind: Kind, tell: Tell) -> Self {
        Self {
            kind,
            registered: Mutex::new(HashMap::new()),
            tell,
            next: AtomicU64::new(1),
        }
    }

    /// Lets `device`'s far end hold an uplink presenting the token with this digest. A different digest closes the
    /// uplink the earlier token holds; the same one changes nothing.
    pub fn register(&self, device: String, digest: String) {
        if !is_name(&device) || digest.len() != 64 {
            tracing::warn!(%device, kind = self.kind.noun, "refused a registration with a name or digest netd cannot use");
            return;
        }
        let replaced = {
            let mut registered = self.registered.lock().expect("uplinks poisoned");
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
            self.remove_socket(&device);
            uplink.close(self.kind.withdrawn, "the token was replaced");
        }
        tracing::info!(%device, kind = self.kind.noun, "may hold an uplink");
        self.report_again();
    }

    /// Forgets `device`: its uplink is closed, its socket removed, and a later dial refused.
    pub fn withdraw(&self, device: &str) {
        let Some(known) = self
            .registered
            .lock()
            .expect("uplinks poisoned")
            .remove(device)
        else {
            return;
        };
        if let Some(uplink) = known.uplink {
            self.remove_socket(device);
            uplink.close(self.kind.withdrawn, "the sandbox withdrew this uplink");
        }
        tracing::info!(%device, kind = self.kind.noun, "an uplink was withdrawn");
        self.report_again();
    }

    /// Every registered device and whether its uplink is up.
    pub fn report(&self) -> ToNode {
        let registered = self.registered.lock().expect("uplinks poisoned");
        let mut held: Vec<(String, bool)> = registered
            .iter()
            .map(|(device, known)| (device.clone(), known.uplink.is_some()))
            .collect();
        held.sort();
        (self.kind.report)(held)
    }

    /// Tells Node where every device stands: on each change, and to a Node that just said hello.
    pub fn report_again(&self) {
        (self.tell)(&self.report());
    }

    /// The session of `device`'s uplink, while one is up.
    pub fn opener(&self, device: &str) -> Option<mux::Opener> {
        self.registered
            .lock()
            .expect("uplinks poisoned")
            .get(device)?
            .uplink
            .as_ref()
            .map(|uplink| uplink.opener.clone())
    }

    /// Answers an upgrade at the kind's uplink path: 101 for a token Node registered, then the uplink runs on its own.
    pub fn uplink(self: &Arc<Self>, mut request: Request<Incoming>) -> Response<Body> {
        let handshake = match request.version() {
            Version::HTTP_11 => Handshake::of(request.headers()),
            _ => None,
        };
        let Some(handshake) = handshake else {
            return plain(StatusCode::UPGRADE_REQUIRED, self.kind.upgrades);
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
            return Err(plain(StatusCode::UNAUTHORIZED, self.kind.unknown));
        };
        let digest = digest_of(token);
        let named = headers
            .get(self.kind.header)
            .and_then(|value| value.to_str().ok());
        let registered = self.registered.lock().expect("uplinks poisoned");
        let Some(device) = registered
            .iter()
            .find(|(_, known)| known.digest == digest)
            .map(|(device, _)| device.clone())
        else {
            tracing::info!(
                named,
                kind = self.kind.noun,
                "refused an uplink whose token nothing registered holds"
            );
            return Err(plain(StatusCode::UNAUTHORIZED, self.kind.unknown));
        };
        if named.is_some_and(|named| named != device) {
            tracing::warn!(%device, named, kind = self.kind.noun, "refused an uplink naming another name than its token's");
            return Err(plain(StatusCode::FORBIDDEN, self.kind.another));
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
        let displaced = match self.install(&device, &digest, uplink, opener) {
            Ok(displaced) => displaced,
            // Withdrawn or re-registered while the upgrade completed: this token opens nothing any more.
            Err(refused) => {
                refused.close(self.kind.withdrawn, "the sandbox withdrew this uplink");
                let _ = tokio::time::timeout(CLOSE_PATIENCE, pumping.ended()).await;
                return;
            }
        };
        if let Some(displaced) = displaced {
            tracing::info!(%device, kind = self.kind.noun, "a newer uplink replaced the earlier one");
            displaced.close(self.kind.displaced, "a newer uplink replaced this one");
        }
        tracing::info!(%device, kind = self.kind.noun, "an uplink is up");
        self.report_again();
        let ended = tokio::select! {
            ended = pumping.ended() => format!("{ended:?}"),
            driven = &mut driving => format!("the session ended: {driven:?}"),
        };
        driving.abort();
        let mine = {
            let mut registered = self.registered.lock().expect("uplinks poisoned");
            match registered.get_mut(&device) {
                Some(known) if known.uplink.as_ref().is_some_and(|held| held.id == id) => {
                    known.uplink.take()
                }
                _ => None,
            }
        };
        tracing::info!(%device, %ended, kind = self.kind.noun, "an uplink ended");
        if let Some(uplink) = mine {
            self.remove_socket(&device);
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
        opener: mux::Opener,
    ) -> Result<Option<Uplink>, Uplink> {
        let mut registered = self.registered.lock().expect("uplinks poisoned");
        let Some(known) = registered
            .get_mut(device)
            .filter(|known| known.digest == digest)
        else {
            return Err(uplink);
        };
        let displaced = known.uplink.replace(uplink);
        let serving = self.socket_of(device).and_then(|path| {
            let _ = std::fs::remove_file(&path);
            self.serve_socket(device, &path, opener)
        });
        if let Some(held) = known.uplink.as_mut() {
            held.serving = serving;
        }
        Ok(displaced)
    }

    fn socket_of(&self, device: &str) -> Option<PathBuf> {
        Some(self.kind.dir.as_ref()?.join(format!("{device}.sock")))
    }

    fn remove_socket(&self, device: &str) {
        if let Some(path) = self.socket_of(device) {
            let _ = std::fs::remove_file(path);
        }
    }

    // Node's socket for the device: each connection a stream down the uplink, spliced until either side ends.
    fn serve_socket(
        &self,
        device: &str,
        path: &Path,
        opener: mux::Opener,
    ) -> Option<JoinHandle<()>> {
        let dir = path.parent()?;
        let bound = std::fs::create_dir_all(dir)
            .and_then(|()| std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)))
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

    fn registry_of(kind: Kind) -> (Arc<Uplinks>, Arc<Mutex<Vec<ToNode>>>) {
        let told = Arc::new(Mutex::new(Vec::new()));
        let telling = told.clone();
        let uplinks = Uplinks::new(
            kind,
            Arc::new(move |message: &ToNode| telling.lock().unwrap().push(message.clone())),
        );
        (Arc::new(uplinks), told)
    }

    fn registry() -> (Arc<Uplinks>, Arc<Mutex<Vec<ToNode>>>) {
        registry_of(Kind::device(
            std::env::temp_dir().join(format!("netd-devices-{}", std::process::id())),
        ))
    }

    // Two registries, two sets of names and tokens: a device's token is nothing to the runners' registry, and a
    // runner's dial names itself in its own header.
    #[test]
    fn a_runner_is_admitted_only_by_the_runners_registry() {
        let (devices, _) = registry();
        let (runners, told) = registry_of(Kind::runner());
        devices.register("rog".into(), digest_of("device-token"));
        runners.register("r1".into(), digest_of("runner-token"));
        let headers = |token: &str, header: &str, named: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
            headers.insert(
                http::HeaderName::from_bytes(header.as_bytes()).unwrap(),
                named.parse().unwrap(),
            );
            headers
        };
        let status = |result: Result<(String, String), Response<Body>>| match result {
            Ok((name, _)) => Ok(name),
            Err(refusal) => Err(refusal.status().as_u16()),
        };
        assert_eq!(
            status(runners.admit(&headers("runner-token", RUNNER_HEADER, "r1"))),
            Ok("r1".to_owned())
        );
        assert_eq!(
            status(runners.admit(&headers("device-token", RUNNER_HEADER, "rog"))),
            Err(401)
        );
        assert_eq!(
            status(devices.admit(&headers("runner-token", DEVICE_HEADER, "r1"))),
            Err(401)
        );
        assert_eq!(
            status(runners.admit(&headers("runner-token", RUNNER_HEADER, "r2"))),
            Err(403)
        );
        assert_eq!(
            told.lock().unwrap().last(),
            Some(&ToNode::RunnerUplinks {
                uplinks: vec![RunnerUplinkState {
                    runner: "r1".into(),
                    connected: false
                }]
            })
        );
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
