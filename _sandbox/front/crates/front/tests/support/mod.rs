//! A stand-in for the Node daemon: plays Node's end of the control lane and serves HTTP on the front's Node socket, so
//! the real binary is driven exactly as the daemon drives it. The process the front supervises is a bare `sleep`.

// Each test crate compiles this module whole and uses its own part of it.
#![allow(dead_code)]

use std::convert::Infallible;
use std::net::TcpListener as StdListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use front_wire::{Answer, FromNode, LENGTH_BYTES, PreviewRoute, Question, ToNode, frame};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, watch};

pub const SANDBOX_ID: &str = "abcdef012345";

pub fn free_port() -> u16 {
    StdListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

pub type Router = Arc<dyn Fn(&str) -> PreviewRoute + Send + Sync>;

pub struct Harness {
    pub dir: PathBuf,
    lane: Arc<Mutex<OwnedWriteHalf>>,
    pub tunnel: watch::Receiver<Option<bool>>,
    _front: Child,
}

impl Harness {
    pub async fn start(name: &str, route: Router) -> Self {
        let dir = std::env::temp_dir().join(format!("front-it-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let front = Command::new(env!("CARGO_BIN_EXE_intentic-front"))
            .args(["--run-dir", dir.to_str().unwrap(), "--", "sleep", "3600"])
            .env("FRONT_LOG", "warn")
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        serve_node_http(dir.join("node.sock")).await;
        let lane = loop {
            match UnixStream::connect(dir.join("front.sock")).await {
                Ok(lane) => break lane,
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        };
        let (mut reader, writer) = lane.into_split();
        let writer = Arc::new(Mutex::new(writer));
        let (tunnel_sender, tunnel) = watch::channel(None);
        let answering = writer.clone();
        tokio::spawn(async move {
            loop {
                let mut length = [0_u8; LENGTH_BYTES];
                if reader.read_exact(&mut length).await.is_err() {
                    return;
                }
                let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
                reader.read_exact(&mut bytes).await.unwrap();
                match serde_json::from_slice::<ToNode>(&bytes).unwrap() {
                    ToNode::Ask {
                        id,
                        question: Question::Preview { host },
                    } => {
                        let answer = FromNode::Answer {
                            id,
                            answer: Answer::Preview {
                                route: route(&host),
                            },
                        };
                        answering
                            .lock()
                            .await
                            .write_all(&frame(&answer).unwrap())
                            .await
                            .unwrap();
                    }
                    ToNode::Tunnel { connected } => {
                        tunnel_sender.send_replace(Some(connected));
                    }
                }
            }
        });
        Self {
            dir,
            lane: writer,
            tunnel,
            _front: front,
        }
    }

    pub async fn send(&self, message: &FromNode) {
        self.lane
            .lock()
            .await
            .write_all(&frame(message).unwrap())
            .await
            .unwrap();
    }

    pub async fn hello(&self) {
        self.send(&FromNode::Hello {
            build: "test".into(),
            pid: std::process::id(),
        })
        .await;
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Waits until a TCP port the front was told to bind accepts.
pub async fn bound(port: u16) {
    for _ in 0..200 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the front never bound port {port}");
}

// Node's HTTP: names what it saw, and upgrades `Upgrade: echo` into a byte echo.
async fn serve_node_http(path: PathBuf) {
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let service = service_fn(|mut request: Request<Incoming>| async move {
                    if request
                        .headers()
                        .get("upgrade")
                        .is_some_and(|value| value == "echo")
                    {
                        let upgrading = hyper::upgrade::on(&mut request);
                        tokio::spawn(async move {
                            let mut upgraded = TokioIo::new(upgrading.await.unwrap());
                            let mut buffer = [0_u8; 1024];
                            while let Ok(read) = upgraded.read(&mut buffer).await {
                                if read == 0 || upgraded.write_all(&buffer[..read]).await.is_err() {
                                    return;
                                }
                            }
                        });
                        return Ok::<_, Infallible>(
                            Response::builder()
                                .status(StatusCode::SWITCHING_PROTOCOLS)
                                .header("connection", "upgrade")
                                .header("upgrade", "echo")
                                .body(Full::new(Bytes::new()))
                                .unwrap(),
                        );
                    }
                    let host = request
                        .headers()
                        .get("host")
                        .map(|value| value.to_str().unwrap().to_owned())
                        .unwrap_or_default();
                    let mark = request
                        .headers()
                        .get("x-intentic-preview")
                        .map(|value| value.to_str().unwrap().to_owned());
                    let body = format!(
                        "node saw {host} {} mark={}",
                        request.uri(),
                        mark.as_deref().unwrap_or("-")
                    );
                    Ok(Response::new(Full::new(Bytes::from(body))))
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades()
                    .await;
            });
        }
    });
}
