//! A stand-in for the Node daemon: plays Node's end of the control socket and serves HTTP on the front's Node socket, so
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
use front_wire::{
    Answer, FromNode, FrontAnswer, FrontQuestion, LENGTH_BYTES, Page, PreviewRoute, Question,
    TerminalPlan, ToNode, frame,
};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, watch};

pub const SANDBOX_ID: &str = "abcdef012345";

pub fn free_port() -> u16 {
    StdListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Node's answer to where a preview host's request goes: its host, and whether it asks the probe's path.
pub type Router = Arc<dyn Fn(&str, bool) -> PreviewRoute + Send + Sync>;

/// The page Node renders for a host it has no preview for.
pub fn nothing_here() -> PreviewRoute {
    PreviewRoute::Page {
        page: Page {
            status: 404,
            headers: [("content-type".to_owned(), "text/plain".to_owned())].into(),
            body: "no preview here".into(),
        },
    }
}

/// Node's answer to a terminal's query string: its plan, and the member it opens for.
pub type Planner = Arc<dyn Fn(&str) -> (TerminalPlan, Option<String>) + Send + Sync>;

fn no_terminals() -> Planner {
    Arc::new(|_| {
        (
            TerminalPlan::Refused {
                code: 1008,
                reason: "no terminals here".into(),
            },
            None,
        )
    })
}

pub struct Harness {
    pub dir: PathBuf,
    socket: Arc<Mutex<OwnedWriteHalf>>,
    pub tunnel: watch::Receiver<Option<bool>>,
    synced: Mutex<mpsc::UnboundedReceiver<(u32, Vec<Option<u64>>)>>,
    _front: Child,
}

impl Harness {
    pub async fn start(name: &str, route: Router) -> Self {
        Self::launch(name, route, no_terminals(), None, &[]).await
    }

    /// `bin` goes first on the front's PATH: a test's own tmux, in front of the machine's. `env` is set on the front.
    pub async fn launch(
        name: &str,
        route: Router,
        terminal: Planner,
        bin: Option<PathBuf>,
        env: &[(&str, &str)],
    ) -> Self {
        let dir = std::env::temp_dir().join(format!("front-it-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut command = Command::new(env!("CARGO_BIN_EXE_intentic-front"));
        command
            .args(["--run-dir", dir.to_str().unwrap(), "--", "sleep", "3600"])
            .env("FRONT_LOG", "warn")
            .envs(env.iter().copied())
            .stdout(Stdio::null())
            .kill_on_drop(true);
        if let Some(bin) = bin {
            let path = std::env::var_os("PATH").unwrap_or_default();
            let mut paths = vec![bin];
            paths.extend(std::env::split_paths(&path));
            command.env("PATH", std::env::join_paths(paths).unwrap());
        }
        let front = command.spawn().unwrap();
        serve_node_http(dir.join("node.sock")).await;
        let socket = loop {
            match UnixStream::connect(dir.join("front.sock")).await {
                Ok(socket) => break socket,
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        };
        let (mut reader, writer) = socket.into_split();
        let writer = Arc::new(Mutex::new(writer));
        let (tunnel_sender, tunnel) = watch::channel(None);
        let (synced_sender, synced) = mpsc::unbounded_channel();
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
                        question: Question::Preview { host, probe },
                    } => {
                        let answer = FromNode::Answer {
                            id,
                            answer: Answer::Preview {
                                route: route(&host, probe),
                            },
                        };
                        answering
                            .lock()
                            .await
                            .write_all(&frame(&answer).unwrap())
                            .await
                            .unwrap();
                    }
                    ToNode::Ask {
                        id,
                        question: Question::Terminal { query },
                    } => {
                        let (plan, member) = terminal(&query);
                        let answer = FromNode::Answer {
                            id,
                            answer: Answer::Terminal { plan, member },
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
                    ToNode::Answer {
                        id,
                        answer: FrontAnswer::Sync { generations },
                    } => {
                        let _ = synced_sender.send((id, generations));
                    }
                    ToNode::Refused { id, message } => {
                        panic!("the front refused question {id}: {message}")
                    }
                }
            }
        });
        Self {
            dir,
            socket: writer,
            tunnel,
            synced: Mutex::new(synced),
            _front: front,
        }
    }

    pub async fn send(&self, message: &FromNode) {
        self.socket
            .lock()
            .await
            .write_all(&frame(message).unwrap())
            .await
            .unwrap();
    }

    /// Asks the front where each checkout's count stands, as Node does, and waits for that answer.
    pub async fn sync(&self, id: u32, dirs: &[&str]) -> Vec<Option<u64>> {
        self.send(&FromNode::Ask {
            id,
            question: FrontQuestion::Sync {
                dirs: dirs.iter().map(|dir| (*dir).to_owned()).collect(),
            },
        })
        .await;
        let mut synced = self.synced.lock().await;
        loop {
            let (answered, generations) =
                tokio::time::timeout(Duration::from_secs(5), synced.recv())
                    .await
                    .expect("the front answers a sync")
                    .expect("the socket stays open");
            if answered == id {
                return generations;
            }
        }
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

// Node's HTTP: names what it saw, answers `/bench/bytes/<n>` or `?bench=<n>` with n bytes, and echoes `Upgrade: echo`.
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
                    let bench = request
                        .uri()
                        .path()
                        .strip_prefix("/bench/bytes/")
                        .or_else(|| {
                            request
                                .uri()
                                .query()
                                .and_then(|query| query.strip_prefix("bench="))
                        });
                    if let Some(size) = bench {
                        let size: usize = size.parse().unwrap();
                        return Ok(Response::new(Full::new(Bytes::from(vec![b'x'; size]))));
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
