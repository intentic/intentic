//! What the edge's suites stand up around it, all over real sockets: a platform key that mints grants, a sandbox that
//! dials the tunnel door and answers down it, a platform that answers the reachability question, and a browser.

#![allow(dead_code)]

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use bytes::Bytes;
use http::header::{self, HeaderMap, HeaderValue};
use http::{Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use intentic_ingress::body::{self, Body};
use intentic_ingress::edge::{Edge, EdgeOptions, Via};
use intentic_ingress::grant::GrantKey;
use intentic_ingress::registry::Registry;
use intentic_ingress::revocation::Revocation;
use intentic_ingress::serve::{self, Listening};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tunnel::{Close, Ended, GRANT_HEADER, LANE_HEADER, unwrap_envelope};

pub const SANDBOX_ID: &str = "abcdef012345";
pub const OTHER_ID: &str = "0123456789ab";
pub const ZONE: &str = "sbx.example.test";

pub fn daemon_host(id: &str) -> String {
    format!("sandbox-{id}.{ZONE}")
}

/// A platform key pair: the edge is given the public half, the suite mints grants with the private one.
pub struct Keys {
    pair: Ed25519KeyPair,
    pub public_pem: String,
}

impl Default for Keys {
    fn default() -> Self {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let mut spki = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        spki.extend_from_slice(pair.public_key().as_ref());
        let public_pem = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            STANDARD.encode(spki)
        );
        Self { pair, public_pem }
    }
}

impl Keys {
    pub fn grant(&self, id: &str) -> String {
        let payload = format!(r#"{{"sub":"{id}","iat":1700000000}}"#);
        let signature = self.pair.sign(payload.as_bytes());
        format!(
            "ig1.{}.{}",
            URL_SAFE_NO_PAD.encode(payload),
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        )
    }

    pub fn key(&self) -> GrantKey {
        GrantKey::from_pem(&self.public_pem).unwrap()
    }
}

/// One machine's options with nothing around it: no platform, no cluster, no replay.
pub fn lone(keys: &Keys) -> EdgeOptions {
    EdgeOptions {
        key: keys.key(),
        revocation: Revocation::new(""),
        registry: Arc::new(Registry::new()),
        cluster: None,
        peers: None,
        instance: "solo".into(),
        hosted_app_prefix: None,
        build: String::new(),
        transports: Vec::new(),
    }
}

pub struct Running {
    pub edge: Arc<Edge>,
    pub port: u16,
    pub listening: Listening,
}

pub async fn start(options: EdgeOptions) -> Running {
    let edge = Edge::new(options);
    let serving = edge.clone();
    let listening = serve::listen("127.0.0.1:0", move |request, remote| {
        serving
            .clone()
            .handle(request.map(body::incoming), remote, Via::Proxy)
    })
    .await
    .unwrap();
    Running {
        edge,
        port: listening.address.port(),
        listening,
    }
}

pub struct Door {
    pub running: Running,
    pub quic: SocketAddr,
    pub trust: rustls::pki_types::CertificateDer<'static>,
}

// An edge with both doors: the WebSocket one and the QUIC one, on a certificate for the zone, declaring the second.
pub async fn door(keys: &Keys) -> Door {
    let running = start(EdgeOptions {
        transports: tunnel::Transport::ALL.to_vec(),
        ..lone(keys)
    })
    .await;
    let issued =
        rcgen::generate_simple_self_signed(vec![format!("*.{ZONE}"), ZONE.to_owned()]).unwrap();
    let slot = Arc::new(intentic_ingress::tls::CertificateSlot::default());
    slot.replace(&issued.cert.pem(), &issued.signing_key.serialize_pem())
        .unwrap();
    let endpoint = intentic_ingress::quic::endpoint("127.0.0.1:0".parse().unwrap(), slot).unwrap();
    let address = endpoint.local_addr().unwrap();
    tokio::spawn(intentic_ingress::quic::accept(
        endpoint,
        running.edge.clone(),
    ));
    Door {
        running,
        quic: address,
        trust: issued.cert.der().clone(),
    }
}

/// Polls until `condition` holds, or fails naming what it waited for rather than hanging.
pub async fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..300 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

/// What the fake sandbox's daemon answers a plain request with.
pub type Answering = Arc<dyn Fn(&Request<Incoming>) -> Response<Body> + Send + Sync>;

/// Answers `served <host><path>`, the Host the request was made to proving it survived every hop.
pub fn serving(name: &'static str) -> Answering {
    Arc::new(move |request| {
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .or_else(|| {
                request
                    .uri()
                    .authority()
                    .map(|authority| authority.to_string())
            })
            .unwrap_or_default();
        let path = request
            .uri()
            .path_and_query()
            .map_or("/", |path| path.as_str());
        Response::new(body::full(format!("{name} {host}{path}")))
    })
}

/// A sandbox holding one tunnel: its daemon answers down the h2 session, and an upgrade whose envelope names a host
/// starting `nobody` is declined, any other answered 101 and echoed.
pub struct Sandbox {
    closing: watch::Sender<Option<Close>>,
    pub ended: JoinHandle<Ended>,
    pub seen: Arc<Mutex<Vec<HeaderMap>>>,
}

impl Sandbox {
    pub fn close(&self) {
        self.closing.send_replace(Some(Close::AWAY));
    }

    pub fn last_seen(&self) -> HeaderMap {
        self.seen
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default()
    }
}

/// Dials the tunnel door; `Err` carries the status of a refused upgrade.
pub async fn dial(
    port: u16,
    grant: &str,
    lane: Option<&str>,
    answering: Answering,
) -> Result<Sandbox, u16> {
    let mut request = format!("ws://127.0.0.1:{port}/tunnel/v1")
        .into_client_request()
        .unwrap();
    if !grant.is_empty() {
        request
            .headers_mut()
            .insert(GRANT_HEADER, HeaderValue::from_str(grant).unwrap());
    }
    if let Some(lane) = lane {
        request
            .headers_mut()
            .insert(LANE_HEADER, HeaderValue::from_str(lane).unwrap());
    }
    let (socket, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(opened) => opened,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            return Err(response.status().as_u16());
        }
        Err(error) => panic!("the dial failed: {error}"),
    };
    let (closing, closed) = watch::channel(None);
    let (session_side, mut pumping) = tunnel::pump(socket, closed);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seeing = seen.clone();
    let service = service_fn(move |mut request: Request<Incoming>| {
        let answering = answering.clone();
        let seen = seeing.clone();
        async move {
            if request.method() != Method::CONNECT {
                seen.lock().unwrap().push(request.headers().clone());
                return Ok::<_, Infallible>(answering(&request));
            }
            let head = unwrap_envelope(request.headers()).unwrap();
            seen.lock().unwrap().push(head.headers().clone());
            let declined = head
                .headers()
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|host| host.starts_with("nobody"));
            let upgrading = hyper::upgrade::on(&mut request);
            tokio::spawn(async move {
                let mut stream = TokioIo::new(upgrading.await.unwrap());
                if declined {
                    let _ = stream
                        .write_all(b"HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nnope")
                        .await;
                    let _ = stream.shutdown().await;
                    return;
                }
                if stream
                    .write_all(b"HTTP/1.1 101 Switching Protocols\r\nupgrade: echo\r\nconnection: Upgrade\r\n\r\n")
                    .await
                    .is_err()
                {
                    return;
                }
                let mut buffer = [0_u8; 4096];
                while let Ok(read) = stream.read(&mut buffer).await {
                    if read == 0 || stream.write_all(&buffer[..read]).await.is_err() {
                        return;
                    }
                }
            });
            Ok(Response::new(body::empty()))
        }
    });
    let serving = tokio::spawn(
        hyper::server::conn::http2::Builder::new(TokioExecutor::new())
            .serve_connection(TokioIo::new(session_side), service),
    );
    let ended = tokio::spawn(async move {
        let ended = pumping.ended().await;
        serving.abort();
        ended
    });
    Ok(Sandbox {
        closing,
        ended,
        seen,
    })
}

pub struct Answer {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: String,
}

pub async fn get(port: u16, host: &str, path: &str) -> Answer {
    send(port, Method::GET, host, path, &[], Bytes::new()).await
}

/// One request on a connection of its own, with the Host chosen, since Host is the only routing input.
pub async fn send(
    port: u16,
    method: Method,
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Bytes,
) -> Answer {
    let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection);
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, host);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = sender
        .send_request(request.body(Full::new(body)).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    Answer {
        status,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

/// Opens an upgrade the way a browser does, on a connection of its own: answers the response head, and the socket to
/// speak on past it.
pub async fn upgrade(port: u16, host: &str, path: &str, protocol: &str) -> (String, TcpStream) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream
        .write_all(
            format!(
                "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: Upgrade\r\nUpgrade: {protocol}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.unwrap() == 0 {
            break;
        }
        head.push(byte[0]);
    }
    (String::from_utf8_lossy(&head).into_owned(), stream)
}

/// A platform answering `/api/reachability/<id>` from a table, `(status, body)` per id and 404 for the rest, recording
/// every question.
pub struct Platform {
    pub url: String,
    pub asked: Arc<Mutex<Vec<String>>>,
    _listening: Listening,
}

pub async fn platform(answers: HashMap<String, (u16, String)>) -> Platform {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let recording = asked.clone();
    let answers = Arc::new(answers);
    let listening = serve::listen("127.0.0.1:0", move |request, _| {
        let answers = answers.clone();
        let asked = recording.clone();
        async move {
            let path = request.uri().path().to_owned();
            // Only the question counts: a port-watcher on the machine may probe any new listener.
            if path.starts_with("/api/reachability/") {
                asked.lock().unwrap().push(path.clone());
            }
            let id = path.rsplit('/').next().unwrap_or_default();
            let (status, answer) = answers.get(id).cloned().unwrap_or((404, "gone".to_owned()));
            let mut response = Response::new(body::full(answer));
            *response.status_mut() = StatusCode::from_u16(status).unwrap();
            response
        }
    })
    .await
    .unwrap();
    Platform {
        url: format!("http://127.0.0.1:{}", listening.address.port()),
        asked,
        _listening: listening,
    }
}

pub fn empty_request(uri: &str) -> Request<Empty<Bytes>> {
    Request::get(uri).body(Empty::new()).unwrap()
}

/// A session over a pipe nothing answers, for a registry entry that is never asked anything; keep the pipe alive.
pub async fn idle_session() -> (intentic_ingress::session::Session, tokio::io::DuplexStream) {
    let (near, far) = tokio::io::duplex(1 << 16);
    let (sender, _) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(near))
            .await
            .unwrap();
    (intentic_ingress::session::Session::h2(sender), far)
}
