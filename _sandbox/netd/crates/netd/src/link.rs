//! netd's half of the control socket: accepts Node's connection, reads what it sends, asks it questions and answers
//! its. One Node at a time. A connection whose first frame does not decode is not Node's (an agent that took the socket
//! for the HTTP one, `curl --unix-socket`): it is refused and the live link stands, since Node reads its link closing as
//! the box going down. A reply netd cannot read refuses its own question and leaves the link up: that is how an
//! older Node answers a question it does not know.
//!
//! Which connection is the link: a new one takes it at its first frame while no Node that said hello holds it (a
//! restarted Node, whose predecessor's connection is gone or never said hello), and every question in flight on the old
//! one fails. While a Node that said hello holds it, a new connection is held back until its own hello, and takes the
//! link only if that names a newer start of the daemon (`GENERATION_ENV`, counted by netd as it spawns each one);
//! one naming the same start or none is a copy, refused, and the live link stands. A connection that lost the link is
//! closed and nothing it sent afterwards is applied (2026-10-05: the newest connection took the writer, and the older
//! one's frames were still applied).
//!
//! The listener itself is kept: an accept that fails is retried, and after a few in a row the socket is bound again,
//! rather than leaving a netd that no restarted Node can reach.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use anyhow::anyhow;
use netd_wire::{
    ASK_PATIENCE, Answer, FromNode, LENGTH_BYTES, MAX_FRAME_BYTES, NetdAnswer, NetdQuestion,
    Question, ToNode, frame,
};
use relay::Backoff;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, watch};

/// What Node has said about itself: its connection's generation while it is up, nothing while it is not.
pub type NodeState = Option<u64>;

/// Configuration Node pushes, handed to whoever applies it.
#[derive(Debug)]
pub enum Pushed {
    Listen(netd_wire::ListenConfig),
    Certificate(Option<netd_wire::Certificate>),
    Tunnel(Option<netd_wire::TunnelConfig>),
    /// A new Node said hello: anything netd reports must be told again.
    Hello,
    /// Close the member's terminals, or every member's.
    Revoke(Option<String>),
    Watch(netd_wire::WatchedCheckout),
    Unwatch(String),
    /// A question Node asked; whoever applies it answers with `Link::answer` and this id.
    Asked {
        id: u32,
        question: NetdQuestion,
    },
}

/// How a question netd asked ended: Node's answer, its refusal and why, or the reason there was neither.
#[derive(Debug)]
enum Reply {
    Answered(Answer),
    Refused(String),
    Lost(&'static str),
}

type Pending = HashMap<u32, oneshot::Sender<Reply>>;

// Frames a held-back connection may send before its hello: a starting Node sends its listen config, certificate and
// tunnel, and may ask a sync or two. Past this it is no Node starting.
const HELD_BACK_FRAMES: usize = 64;

// Accepts that fail in a row before the socket is bound again: one failure is usually the process's file limit, which a
// pause outlasts; several in a row may be a listener that will not accept again.
const ACCEPT_FAILURES_BEFORE_REBIND: u32 = 3;

// Between failed accepts, and between failed binds.
const ACCEPT_RETRY: Backoff = Backoff::new(
    Duration::from_millis(100),
    Duration::from_secs(5),
    Duration::from_secs(60),
);
const BIND_RETRY: Backoff = Backoff::new(
    Duration::from_secs(1),
    Duration::from_secs(30),
    Duration::from_secs(60),
);

// Where the connection holding the link stands: whether its Node said hello, and the start it named then (none from a
// Node older than generations).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Said {
    Nothing,
    Hello(Option<u64>),
}

// The connection holding the link.
struct Current {
    connection: u64,
    said: Said,
    writer: mpsc::UnboundedSender<Vec<u8>>,
    // Raised when another connection takes the link: this one's reader stops, and nothing more it sent is applied.
    stop: watch::Sender<bool>,
}

pub struct Link {
    state: watch::Sender<NodeState>,
    said_hello: AtomicBool,
    current: Mutex<Option<Current>>,
    // Which connection holds the link and what it said, for a held-back connection to wait on.
    holding: watch::Sender<Option<(u64, Said)>>,
    pending: Mutex<Pending>,
    next_id: AtomicU32,
    pushed: mpsc::UnboundedSender<Pushed>,
}

impl Link {
    pub fn new(pushed: mpsc::UnboundedSender<Pushed>) -> Self {
        Self {
            state: watch::Sender::new(None),
            said_hello: AtomicBool::new(false),
            current: Mutex::new(None),
            holding: watch::Sender::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            pushed,
        }
    }

    pub fn state(&self) -> watch::Receiver<NodeState> {
        self.state.subscribe()
    }

    /// Whether any Node said hello since netd started.
    pub fn said_hello(&self) -> bool {
        self.said_hello.load(Ordering::Relaxed)
    }

    /// Waits up to `patience` for a Node that has said hello; false when none turned up.
    pub async fn ready(&self, patience: Duration) -> bool {
        let mut state = self.state.subscribe();
        tokio::time::timeout(patience, state.wait_for(Option::is_some))
            .await
            .is_ok_and(|seen| seen.is_ok())
    }

    /// Asks Node and waits `ASK_PATIENCE` for its answer; fails at once when no Node is connected.
    pub async fn ask(&self, question: Question) -> anyhow::Result<Answer> {
        match self.asked(question, Some(ASK_PATIENCE)).await? {
            Ok(answer) => Ok(answer),
            Err(refusal) => Err(anyhow!("the daemon refused: {refusal}")),
        }
    }

    /// Asks Node and waits for its reply, an answer or a refusal and why, for `patience` or, without one, for as long as
    /// the connection it was asked on lasts. Fails when there is no reply: no Node connected, or none in time.
    pub async fn asked(
        &self,
        question: Question,
        patience: Option<Duration>,
    ) -> anyhow::Result<Result<Answer, String>> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (answered, reply) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending poisoned")
            .insert(id, answered);
        if !self.tell(&ToNode::Ask { id, question }) {
            self.pending.lock().expect("pending poisoned").remove(&id);
            return Err(anyhow!("the daemon is not connected"));
        }
        let reply = match patience {
            None => reply.await,
            Some(patience) => match tokio::time::timeout(patience, reply).await {
                Ok(reply) => reply,
                Err(_) => {
                    self.pending.lock().expect("pending poisoned").remove(&id);
                    return Err(anyhow!("the daemon did not answer within {patience:?}"));
                }
            },
        };
        match reply {
            Ok(Reply::Answered(answer)) => Ok(Ok(answer)),
            Ok(Reply::Refused(refusal)) => Ok(Err(refusal)),
            Ok(Reply::Lost(why)) => Err(anyhow!(why)),
            Err(_) => Err(anyhow!("the daemon went away before answering")),
        }
    }

    /// Answers a question Node asked, or refuses it with why.
    pub fn answer(&self, id: u32, answer: Result<NetdAnswer, String>) {
        let _ = self.tell(&match answer {
            Ok(answer) => ToNode::Answer { id, answer },
            Err(message) => ToNode::Refused { id, message },
        });
    }

    /// Sends a message to the current Node; false when there is none to send it to.
    pub fn tell(&self, message: &ToNode) -> bool {
        let bytes = frame(message).expect("a ToNode always serializes");
        self.current
            .lock()
            .expect("the link is never poisoned")
            .as_ref()
            .is_some_and(|current| current.writer.send(bytes).is_ok())
    }

    /// Serves the control socket at `path` for as long as netd runs: a failed accept is retried, and the socket is
    /// bound again after `ACCEPT_FAILURES_BEFORE_REBIND` in a row or when binding failed.
    pub async fn serve(&'static self, path: &Path) {
        let mut connection = 0_u64;
        let mut binding = BIND_RETRY;
        loop {
            let _ = std::fs::remove_file(path);
            let listener = match UnixListener::bind(path) {
                Ok(listener) => listener,
                Err(error) => {
                    let wait = binding.after(Duration::ZERO);
                    tracing::error!(%error, path = %path.display(), ?wait, "could not bind the control socket; trying again");
                    tokio::time::sleep(wait).await;
                    continue;
                }
            };
            binding = BIND_RETRY;
            let mut failures = Failures::default();
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        failures = Failures::default();
                        connection += 1;
                        tokio::spawn(self.connection(connection, stream));
                    }
                    Err(error) => {
                        let (wait, rebind) = failures.after();
                        tracing::warn!(%error, ?wait, rebind, "the control socket failed to accept a connection");
                        tokio::time::sleep(wait).await;
                        if rebind {
                            break;
                        }
                    }
                }
            }
        }
    }

    // A connection takes the link only once its first frame decodes: replacing the writer at accept would hang up on
    // the live Node for whatever dialed the socket, and Node stops the box when its link closes unasked.
    async fn connection(&'static self, connection: u64, stream: UnixStream) {
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let first = match first_message(&mut reader).await {
            Ok(Some(first)) => first,
            Ok(None) => return,
            Err(stray) => {
                tracing::warn!(why = %stray.why, "refused a connection to the control socket that is not the daemon's; the daemon's link stands");
                if stray.spoke_http {
                    let _ = writer.write_all(not_http_response().as_bytes()).await;
                    let _ = writer.shutdown().await;
                }
                return;
            }
        };
        // Read in a task of its own, so waiting on this connection's frames beside anything else never cuts one short.
        let (arriving, mut frames) = mpsc::unbounded_channel::<io::Result<Vec<u8>>>();
        let reading = tokio::spawn(async move {
            loop {
                match read_frame(&mut reader).await {
                    Ok(Some(bytes)) => {
                        if arriving.send(Ok(bytes)).is_err() {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(error) => {
                        let _ = arriving.send(Err(error));
                        return;
                    }
                }
            }
        });
        let (sender, mut outgoing) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            while let Some(bytes) = outgoing.recv().await {
                if writer.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });
        let (stop, mut stopped) = watch::channel(false);
        let Some(held_back) = self
            .take_link(connection, first, &sender, &stop, &mut frames)
            .await
        else {
            reading.abort();
            return;
        };
        drop(sender);
        for message in held_back {
            self.receive(connection, message);
        }
        loop {
            let bytes = tokio::select! {
                frame = frames.recv() => match frame {
                    Some(Ok(bytes)) => bytes,
                    Some(Err(error)) => {
                        tracing::warn!(%error, "the control socket closed on an unreadable frame");
                        break;
                    }
                    None => break,
                },
                _ = stopped.wait_for(|stopped| *stopped) => break,
            };
            // Another connection may have taken the link while this frame waited: it is not this one's to apply.
            if !self.holds(connection) {
                break;
            }
            match serde_json::from_slice::<FromNode>(&bytes) {
                Ok(message) => self.receive(connection, message),
                Err(error) => {
                    let Some(id) = unreadable_reply(&bytes) else {
                        tracing::warn!(%error, "the control socket closed on a frame from the daemon that does not decode");
                        break;
                    };
                    tracing::debug!(%error, id, "the daemon's reply is unreadable; its question counts as refused");
                    self.settle(id, Reply::Refused(format!("an unreadable reply: {error}")));
                }
            }
        }
        reading.abort();
        self.lost(connection);
    }

    // Takes the link for `connection`, answering what it sent before taking it, in order; none when it is refused. Free
    // or held by a Node that has not said hello, the link is taken at once. Held by one that has, this connection is
    // held back until its own hello, which takes the link only if it names a newer start; and if the holder goes first,
    // it takes the link then.
    async fn take_link(
        &self,
        connection: u64,
        first: FromNode,
        writer: &mpsc::UnboundedSender<Vec<u8>>,
        stop: &watch::Sender<bool>,
        frames: &mut mpsc::UnboundedReceiver<io::Result<Vec<u8>>>,
    ) -> Option<Vec<FromNode>> {
        let mut held_back = vec![first];
        let mut holding = self.holding.subscribe();
        loop {
            let named = held_back.iter().find_map(|message| match message {
                FromNode::Hello { generation, .. } => Some(*generation),
                _ => None,
            });
            let live = *holding.borrow_and_update();
            match decide(live, named) {
                Decision::Take => {
                    self.take(connection, writer.clone(), stop.clone());
                    return Some(held_back);
                }
                Decision::Refuse(live) => {
                    tracing::warn!(
                        connection,
                        live = ?live,
                        named = ?named.flatten(),
                        "refused a second daemon on the control socket: the daemon holding it said hello, and this one names no newer start; the live link stands"
                    );
                    return None;
                }
                Decision::Wait => {}
            }
            if held_back.len() == 1 {
                tracing::info!(
                    connection,
                    "a new connection to the control socket waits for its hello: a daemon that said hello holds the link"
                );
            }
            tokio::select! {
                frame = frames.recv() => {
                    let message = match frame {
                        Some(Ok(bytes)) => serde_json::from_slice::<FromNode>(&bytes).ok()?,
                        _ => return None,
                    };
                    if held_back.len() >= HELD_BACK_FRAMES {
                        tracing::warn!(connection, "a held-back connection to the control socket sent too much before its hello; refused");
                        return None;
                    }
                    held_back.push(message);
                }
                changed = holding.changed() => changed.ok()?,
            }
        }
    }

    // This connection takes the link: the one holding it is stopped and hung up, and every question asked on it fails.
    // A new connection is not up until it says hello, whatever the one it replaces had said.
    fn take(
        &self,
        connection: u64,
        writer: mpsc::UnboundedSender<Vec<u8>>,
        stop: watch::Sender<bool>,
    ) {
        let previous = self
            .current
            .lock()
            .expect("the link is never poisoned")
            .replace(Current {
                connection,
                said: Said::Nothing,
                writer,
                stop,
            });
        if let Some(previous) = previous {
            previous.stop.send_replace(true);
        }
        self.state.send_replace(None);
        self.holding.send_replace(Some((connection, Said::Nothing)));
        self.fail_pending("the daemon reconnected before answering");
    }

    fn holds(&self, connection: u64) -> bool {
        self.current
            .lock()
            .expect("the link is never poisoned")
            .as_ref()
            .is_some_and(|current| current.connection == connection)
    }

    // Only the current connection's end means Node is gone; an older one closing after its replacement means nothing.
    fn lost(&self, connection: u64) {
        let mut current = self.current.lock().expect("the link is never poisoned");
        if current
            .as_ref()
            .is_some_and(|current| current.connection == connection)
        {
            *current = None;
            drop(current);
            self.state.send_replace(None);
            self.holding.send_replace(None);
            self.fail_pending("the daemon went away before answering");
        }
    }

    fn fail_pending(&self, why: &'static str) {
        for (_, answered) in self.pending.lock().expect("pending poisoned").drain() {
            let _ = answered.send(Reply::Lost(why));
        }
    }

    fn receive(&self, connection: u64, message: FromNode) {
        match message {
            FromNode::Hello {
                build,
                pid,
                generation,
            } => {
                tracing::info!(%build, pid, generation, "the daemon is up");
                if let Some(current) = self
                    .current
                    .lock()
                    .expect("the link is never poisoned")
                    .as_mut()
                    .filter(|current| current.connection == connection)
                {
                    current.said = Said::Hello(generation);
                }
                self.said_hello.store(true, Ordering::Relaxed);
                self.state.send_replace(Some(connection));
                self.holding
                    .send_replace(Some((connection, Said::Hello(generation))));
                let _ = self.pushed.send(Pushed::Hello);
            }
            FromNode::Listen { config } => {
                let _ = self.pushed.send(Pushed::Listen(config));
            }
            FromNode::Certificate { certificate } => {
                let _ = self.pushed.send(Pushed::Certificate(certificate));
            }
            FromNode::Tunnel { tunnel } => {
                let _ = self.pushed.send(Pushed::Tunnel(tunnel));
            }
            FromNode::Revoke { member } => {
                let _ = self.pushed.send(Pushed::Revoke(member));
            }
            FromNode::Watch { checkout } => {
                let _ = self.pushed.send(Pushed::Watch(checkout));
            }
            FromNode::Unwatch { dir } => {
                let _ = self.pushed.send(Pushed::Unwatch(dir));
            }
            FromNode::Ask { id, question } => {
                let _ = self.pushed.send(Pushed::Asked { id, question });
            }
            FromNode::Answer { id, answer } => self.settle(id, Reply::Answered(answer)),
            FromNode::Refused { id, message } => self.settle(id, Reply::Refused(message)),
        }
    }

    fn settle(&self, id: u32, reply: Reply) {
        if let Some(answered) = self.pending.lock().expect("pending poisoned").remove(&id) {
            let _ = answered.send(reply);
        }
    }
}

// What becomes of a new connection, given who holds the link (`live`) and the start its own hello named, once it said
// one (`named`).
#[derive(Debug, PartialEq, Eq)]
enum Decision {
    Take,
    Wait,
    Refuse(Option<u64>),
}

fn decide(live: Option<(u64, Said)>, named: Option<Option<u64>>) -> Decision {
    match (live, named) {
        // Free, or held by a Node still starting: a restarted Node takes it at its first frame, as it always did.
        (None | Some((_, Said::Nothing)), _) => Decision::Take,
        (Some((_, Said::Hello(_))), None) => Decision::Wait,
        (Some((_, Said::Hello(live))), Some(named)) => {
            if newer(named, live) {
                Decision::Take
            } else {
                Decision::Refuse(live)
            }
        }
    }
}

// Whether a hello naming start `named` comes from a newer daemon than the one that said `live`: only a named start can
// be newer, and any named start is newer than a Node that predates generations.
fn newer(named: Option<u64>, live: Option<u64>) -> bool {
    match (named, live) {
        (Some(named), Some(live)) => named > live,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

// Failed accepts in a row, and the pause after each.
struct Failures {
    count: u32,
    retry: Backoff,
}

impl Default for Failures {
    fn default() -> Self {
        Self {
            count: 0,
            retry: ACCEPT_RETRY,
        }
    }
}

impl Failures {
    // The pause after one more failure, and whether the socket is to be bound again after it.
    fn after(&mut self) -> (Duration, bool) {
        self.count += 1;
        let rebind = self.count >= ACCEPT_FAILURES_BEFORE_REBIND;
        if rebind {
            self.count = 0;
        }
        (self.retry.after(Duration::ZERO), rebind)
    }
}

/// The id of a frame that is a reply (an answer or a refusal) whatever else it holds, so a reply that does not decode
/// settles its own question: an older Node answers a question it does not know with an answer missing its body.
fn unreadable_reply(bytes: &[u8]) -> Option<u32> {
    #[derive(serde::Deserialize)]
    struct Envelope {
        kind: String,
        id: Option<u32>,
    }
    let envelope: Envelope = serde_json::from_slice(bytes).ok()?;
    matches!(envelope.kind.as_str(), "answer" | "refused")
        .then_some(envelope.id)
        .flatten()
}

/// One frame's JSON, or none at a clean end of stream.
pub async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    match read_length(reader).await? {
        Some(length) => read_body(reader, length).await.map(Some),
        None => Ok(None),
    }
}

async fn read_length<R: AsyncReadExt + Unpin>(
    reader: &mut R,
) -> io::Result<Option<[u8; LENGTH_BYTES]>> {
    let mut length = [0_u8; LENGTH_BYTES];
    match reader.read_exact(&mut length).await {
        Ok(_) => Ok(Some(length)),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error),
    }
}

async fn read_body<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    length: [u8; LENGTH_BYTES],
) -> io::Result<Vec<u8>> {
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a {length}-byte frame is past the socket's limit"),
        ));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    Ok(bytes)
}

/// Why a new connection is not Node's, and whether it spoke HTTP, which is answered in HTTP so its client says why.
#[derive(Debug)]
struct Stray {
    why: String,
    spoke_http: bool,
}

/// A new connection's first message, none when it hung up without a whole one, or why it is not Node's.
async fn first_message<R: AsyncReadExt + Unpin>(reader: &mut R) -> Result<Option<FromNode>, Stray> {
    let stray = |why: String| Stray {
        why,
        spoke_http: false,
    };
    let length = match read_length(reader).await {
        Ok(Some(length)) => length,
        Ok(None) => return Ok(None),
        Err(error) => return Err(stray(error.to_string())),
    };
    if spoke_http(length) {
        return Err(Stray {
            why: format!(
                "it spoke HTTP ({:?}…)",
                String::from_utf8_lossy(&length).trim_end()
            ),
            spoke_http: true,
        });
    }
    let bytes = match read_body(reader, length).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(stray(error.to_string())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| stray(format!("its first frame is not the daemon's: {error}")))
}

// A request line opens with an upper-case method (`GET `, `POST`, `PRI ` for HTTP/2's preface); as a length that is
// past 1 GiB, so no frame of Node's reads this way.
fn spoke_http(length: [u8; LENGTH_BYTES]) -> bool {
    length
        .iter()
        .all(|byte| byte.is_ascii_uppercase() || *byte == b' ')
}

fn not_http_response() -> String {
    let body = "This is intentic-netd's control socket, which only the sandbox daemon speaks: it is not HTTP.\n\
                Reach the daemon through the sandbox's own commands (agents, capabilities, secrets, ...) instead.\n";
    format!(
        "HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use netd_wire::PreviewRoute;
    use tokio::net::UnixStream;
    use tokio::net::unix::OwnedReadHalf;

    async fn node_side(
        path: &Path,
    ) -> (BufReader<OwnedReadHalf>, tokio::net::unix::OwnedWriteHalf) {
        let (reader, writer) = UnixStream::connect(path).await.unwrap().into_split();
        (BufReader::new(reader), writer)
    }

    #[tokio::test]
    async fn a_question_is_answered_by_its_id_and_hello_marks_node_up() {
        let dir = std::env::temp_dir().join(format!("netd-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("netd.sock");
        let (pushed, mut received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let served = path.clone();
        tokio::spawn(async move { link.serve(&served).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (mut reader, mut writer) = node_side(&path).await;
        writer
            .write_all(
                &frame(&FromNode::Hello {
                    build: "test".into(),
                    pid: 7,
                    generation: None,
                })
                .unwrap(),
            )
            .await
            .unwrap();
        assert!(link.ready(Duration::from_secs(2)).await);
        assert!(matches!(received.recv().await, Some(Pushed::Hello)));

        let asked = tokio::spawn(async move {
            link.ask(Question::Preview {
                host: "preview-web.localhost".into(),
                probe: false,
            })
            .await
        });
        let question: ToNode =
            serde_json::from_slice(&read_frame(&mut reader).await.unwrap().unwrap()).unwrap();
        let ToNode::Ask { id, .. } = question else {
            panic!("expected a question, got {question:?}")
        };
        let answer = Answer::Preview {
            route: PreviewRoute::Outbox,
        };
        writer
            .write_all(
                &frame(&FromNode::Answer {
                    id,
                    answer: answer.clone(),
                })
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(asked.await.unwrap().unwrap(), answer);

        drop(writer);
        drop(reader);
        let mut state = link.state();
        tokio::time::timeout(Duration::from_secs(2), state.wait_for(Option::is_none))
            .await
            .unwrap()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn served(
        name: &str,
    ) -> (
        &'static Link,
        std::path::PathBuf,
        mpsc::UnboundedReceiver<Pushed>,
    ) {
        let dir = std::env::temp_dir().join(format!("netd-link-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("netd.sock");
        let (pushed, received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let socket = path.clone();
        tokio::spawn(async move { link.serve(&socket).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        (link, path, received)
    }

    async fn hello(writer: &mut tokio::net::unix::OwnedWriteHalf) {
        hello_as(writer, None).await;
    }

    // Node's hello naming the start netd spawned it as.
    async fn hello_as(writer: &mut tokio::net::unix::OwnedWriteHalf, generation: Option<u64>) {
        let hello = FromNode::Hello {
            build: "test".into(),
            pid: 7,
            generation,
        };
        writer.write_all(&frame(&hello).unwrap()).await.unwrap();
    }

    // A ping answered over Node's own connection: proof netd still holds it as the link.
    async fn ping_round_trip(
        link: &'static Link,
        reader: &mut BufReader<OwnedReadHalf>,
        writer: &mut tokio::net::unix::OwnedWriteHalf,
    ) {
        let pinged = tokio::spawn(async move {
            link.asked(Question::Ping, Some(Duration::from_secs(2)))
                .await
        });
        let asked = tokio::time::timeout(Duration::from_secs(2), read_frame(reader))
            .await
            .expect("netd asks over Node's connection")
            .unwrap()
            .expect("Node's connection is still open");
        let ToNode::Ask { id, .. } = serde_json::from_slice::<ToNode>(&asked).unwrap() else {
            panic!("expected a question")
        };
        let pong = FromNode::Answer {
            id,
            answer: Answer::Pong,
        };
        writer.write_all(&frame(&pong).unwrap()).await.unwrap();
        assert_eq!(pinged.await.unwrap().unwrap(), Ok(Answer::Pong));
    }

    // The 2026-10-04 restart: an agent ran `curl --unix-socket /run/intentic/netd.sock http://sandbox/...`. netd
    // handed the link to curl at accept, Node saw its own connection close and stopped, and the box went with it.
    #[tokio::test]
    async fn an_http_client_on_the_control_socket_is_told_so_and_node_keeps_the_link() {
        let (link, path, _received) = served("http").await;
        let (mut reader, mut writer) = node_side(&path).await;
        hello(&mut writer).await;
        assert!(link.ready(Duration::from_secs(2)).await);

        let mut curl = UnixStream::connect(&path).await.unwrap();
        curl.write_all(b"GET /agents/witty-lantern-2z8k HTTP/1.1\r\nHost: sandbox\r\nUser-Agent: curl/8.0\r\nAccept: */*\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(2), curl.read_to_string(&mut response))
            .await
            .expect("netd hangs up on it")
            .unwrap();
        assert!(
            response.starts_with("HTTP/1.1 400 Bad Request\r\n"),
            "{response}"
        );
        assert!(response.contains("control socket"), "{response}");

        assert_eq!(*link.state().borrow(), Some(1));
        ping_round_trip(link, &mut reader, &mut writer).await;
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn a_connection_whose_first_frame_is_not_nodes_is_refused_and_node_keeps_the_link() {
        let (link, path, _received) = served("stray").await;
        let (mut reader, mut writer) = node_side(&path).await;
        hello(&mut writer).await;
        assert!(link.ready(Duration::from_secs(2)).await);

        let not_node = br#"{"kind":"nonsense"}"#;
        let mut framed = u32::try_from(not_node.len())
            .unwrap()
            .to_be_bytes()
            .to_vec();
        framed.extend_from_slice(not_node);
        for stray in [framed, vec![0xff; 8], Vec::new()] {
            let mut connection = UnixStream::connect(&path).await.unwrap();
            connection.write_all(&stray).await.unwrap();
            connection.shutdown().await.unwrap();
            let mut left = Vec::new();
            tokio::time::timeout(Duration::from_secs(2), connection.read_to_end(&mut left))
                .await
                .expect("netd hangs up on it")
                .unwrap();
            assert!(left.is_empty());
        }

        assert_eq!(*link.state().borrow(), Some(1));
        ping_round_trip(link, &mut reader, &mut writer).await;
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // Node says hello last, once it serves HTTP, so a restarted Node takes the link at its first frame, whatever it is,
    // when the Node before it never said hello (it is gone, or died starting).
    #[tokio::test]
    async fn a_restarted_node_takes_a_link_no_hello_holds_at_its_first_frame() {
        let (link, path, mut received) = served("restart").await;
        let (mut old_reader, mut old_writer) = node_side(&path).await;
        let listen = FromNode::Unwatch { dir: "/old".into() };
        old_writer
            .write_all(&frame(&listen).unwrap())
            .await
            .unwrap();
        assert!(matches!(received.recv().await, Some(Pushed::Unwatch(dir)) if dir == "/old"));

        let (mut reader, mut writer) = node_side(&path).await;
        let unwatch = FromNode::Unwatch {
            dir: "/workspace".into(),
        };
        writer.write_all(&frame(&unwatch).unwrap()).await.unwrap();
        assert!(matches!(received.recv().await, Some(Pushed::Unwatch(dir)) if dir == "/workspace"));
        let old_end = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut old_reader))
            .await
            .expect("the old connection is hung up")
            .unwrap();
        assert!(old_end.is_none());
        // Whatever the old one sends now is never applied.
        let _ = old_writer
            .write_all(
                &frame(&FromNode::Unwatch {
                    dir: "/stale".into(),
                })
                .unwrap(),
            )
            .await;

        hello_as(&mut writer, Some(2)).await;
        assert!(link.ready(Duration::from_secs(2)).await);
        assert!(matches!(received.recv().await, Some(Pushed::Hello)));
        assert_eq!(*link.state().borrow(), Some(2));
        ping_round_trip(link, &mut reader, &mut writer).await;
        assert!(
            received.try_recv().is_err(),
            "nothing of the old connection's was applied"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // netd spawned a newer daemon while the older one's connection still stood: the newer start's hello takes the
    // link, what it sent before is applied then and in order, and the older is hung up.
    #[tokio::test]
    async fn a_newer_start_takes_the_link_at_its_hello_and_the_older_is_hung_up() {
        let (link, path, mut received) = served("newer").await;
        let (mut old_reader, mut old_writer) = node_side(&path).await;
        hello_as(&mut old_writer, Some(1)).await;
        assert!(link.ready(Duration::from_secs(2)).await);
        assert!(matches!(received.recv().await, Some(Pushed::Hello)));

        let (mut reader, mut writer) = node_side(&path).await;
        let unwatch = FromNode::Unwatch {
            dir: "/workspace".into(),
        };
        writer.write_all(&frame(&unwatch).unwrap()).await.unwrap();
        // Held back: the live daemon keeps the link, and nothing of the newcomer's is applied yet.
        assert!(
            tokio::time::timeout(Duration::from_millis(200), received.recv())
                .await
                .is_err()
        );
        assert_eq!(*link.state().borrow(), Some(1));

        hello_as(&mut writer, Some(2)).await;
        assert!(matches!(received.recv().await, Some(Pushed::Unwatch(dir)) if dir == "/workspace"));
        assert!(matches!(received.recv().await, Some(Pushed::Hello)));
        assert_eq!(*link.state().borrow(), Some(2));
        let old_end = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut old_reader))
            .await
            .expect("the old connection is hung up")
            .unwrap();
        assert!(old_end.is_none());
        ping_round_trip(link, &mut reader, &mut writer).await;
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // A second daemon with the live one's environment (a guest, an agent's copy): its hello names the same start, so it
    // is refused, and nothing it sent before its hello was applied.
    #[tokio::test]
    async fn a_copy_naming_the_same_start_or_none_is_refused_and_the_live_link_stands() {
        let (link, path, mut received) = served("copy").await;
        let (mut reader, mut writer) = node_side(&path).await;
        hello_as(&mut writer, Some(3)).await;
        assert!(link.ready(Duration::from_secs(2)).await);
        assert!(matches!(received.recv().await, Some(Pushed::Hello)));

        for named in [Some(3), Some(2), None] {
            let (mut copy_reader, mut copy_writer) = node_side(&path).await;
            let listen = FromNode::Unwatch {
                dir: "/taken".into(),
            };
            copy_writer
                .write_all(&frame(&listen).unwrap())
                .await
                .unwrap();
            hello_as(&mut copy_writer, named).await;
            let refused =
                tokio::time::timeout(Duration::from_secs(2), read_frame(&mut copy_reader))
                    .await
                    .expect("the copy is hung up")
                    .unwrap();
            assert!(refused.is_none(), "{named:?}");
        }
        assert!(
            received.try_recv().is_err(),
            "nothing of a copy's was applied"
        );
        assert_eq!(*link.state().borrow(), Some(1));
        ping_round_trip(link, &mut reader, &mut writer).await;
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // The restart race: the newer daemon dialled before netd read the older one's connection end.
    #[tokio::test]
    async fn a_held_back_connection_takes_the_link_when_the_live_one_goes() {
        let (link, path, mut received) = served("handover").await;
        let (old_reader, mut old_writer) = node_side(&path).await;
        hello_as(&mut old_writer, Some(1)).await;
        assert!(link.ready(Duration::from_secs(2)).await);
        assert!(matches!(received.recv().await, Some(Pushed::Hello)));

        let (mut reader, mut writer) = node_side(&path).await;
        let unwatch = FromNode::Unwatch {
            dir: "/workspace".into(),
        };
        writer.write_all(&frame(&unwatch).unwrap()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(old_writer);
        drop(old_reader);
        assert!(matches!(received.recv().await, Some(Pushed::Unwatch(dir)) if dir == "/workspace"));
        hello(&mut writer).await;
        assert!(matches!(received.recv().await, Some(Pushed::Hello)));
        assert_eq!(*link.state().borrow(), Some(2));
        ping_round_trip(link, &mut reader, &mut writer).await;
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn only_a_named_newer_start_displaces_a_daemon_that_said_hello() {
        let up = |generation| Some((1, Said::Hello(generation)));
        assert_eq!(decide(None, None), Decision::Take);
        assert_eq!(decide(Some((1, Said::Nothing)), None), Decision::Take);
        assert_eq!(decide(up(Some(1)), None), Decision::Wait);
        assert_eq!(decide(up(Some(1)), Some(Some(2))), Decision::Take);
        assert_eq!(
            decide(up(Some(2)), Some(Some(2))),
            Decision::Refuse(Some(2))
        );
        assert_eq!(decide(up(Some(2)), Some(None)), Decision::Refuse(Some(2)));
        assert_eq!(decide(up(None), Some(Some(1))), Decision::Take);
        assert_eq!(decide(up(None), Some(None)), Decision::Refuse(None));
    }

    #[test]
    fn failed_accepts_pause_and_every_third_in_a_row_binds_again() {
        let mut failures = Failures::default();
        let rebinds: Vec<bool> = (0..7).map(|_| failures.after().1).collect();
        assert_eq!(rebinds, [false, false, true, false, false, true, false]);
        let (wait, _) = Failures::default().after();
        assert!(wait <= Duration::from_millis(200), "{wait:?}");
    }

    #[test]
    fn only_a_request_line_reads_as_http() {
        for method in [b"GET ", b"POST", b"PUT ", b"HEAD", b"PRI "] {
            assert!(spoke_http(*method));
        }
        assert!(!spoke_http(1024_u32.to_be_bytes()));
        assert!(!spoke_http(
            u32::try_from(MAX_FRAME_BYTES).unwrap().to_be_bytes()
        ));
    }

    #[test]
    fn only_a_reply_with_an_id_settles_a_question_when_it_does_not_decode() {
        assert_eq!(unreadable_reply(br#"{"kind":"answer","id":5}"#), Some(5));
        assert_eq!(
            unreadable_reply(br#"{"kind":"refused","id":6,"message":7}"#),
            Some(6)
        );
        assert_eq!(unreadable_reply(br#"{"kind":"answer"}"#), None);
        assert_eq!(unreadable_reply(br#"{"kind":"hello","id":5}"#), None);
        assert_eq!(unreadable_reply(b"not json"), None);
    }

    // What an older Node does with a question it does not know: its answerer returns nothing, and the frame it writes is
    // an answer with no body. That question is refused and the link stays up for the next one.
    #[tokio::test]
    async fn an_answer_the_netd_cannot_read_refuses_its_question_and_keeps_the_link() {
        let dir = std::env::temp_dir().join(format!("netd-link-older-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("netd.sock");
        let (pushed, _received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let served = path.clone();
        tokio::spawn(async move { link.serve(&served).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (mut reader, mut writer) = node_side(&path).await;
        let hello = FromNode::Hello {
            build: "older".into(),
            pid: 7,
            generation: None,
        };
        writer.write_all(&frame(&hello).unwrap()).await.unwrap();
        assert!(link.ready(Duration::from_secs(2)).await);
        assert!(link.said_hello());

        let pinged = tokio::spawn(async move { link.asked(Question::Ping, None).await });
        let question: ToNode =
            serde_json::from_slice(&read_frame(&mut reader).await.unwrap().unwrap()).unwrap();
        let ToNode::Ask { id, question } = question else {
            panic!("expected a question, got {question:?}")
        };
        assert_eq!(question, Question::Ping);
        let bodiless = format!(r#"{{"kind":"answer","id":{id}}}"#);
        let mut framed = u32::try_from(bodiless.len())
            .unwrap()
            .to_be_bytes()
            .to_vec();
        framed.extend_from_slice(bodiless.as_bytes());
        writer.write_all(&framed).await.unwrap();
        let refusal = pinged.await.unwrap().unwrap().unwrap_err();
        assert!(
            refusal.starts_with("an unreadable reply: missing field `answer`"),
            "{refusal}"
        );

        let asked = tokio::spawn(async move { link.asked(Question::Ping, None).await });
        let question: ToNode =
            serde_json::from_slice(&read_frame(&mut reader).await.unwrap().unwrap()).unwrap();
        let ToNode::Ask { id, .. } = question else {
            panic!("expected a question, got {question:?}")
        };
        let pong = FromNode::Answer {
            id,
            answer: Answer::Pong,
        };
        writer.write_all(&frame(&pong).unwrap()).await.unwrap();
        assert_eq!(asked.await.unwrap().unwrap(), Ok(Answer::Pong));
        assert_eq!(*link.state().borrow(), Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn node_asks_the_netd_under_the_same_envelope_and_hears_the_answer_by_its_id() {
        let dir = std::env::temp_dir().join(format!("netd-link-asked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("netd.sock");
        let (pushed, mut received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let served = path.clone();
        tokio::spawn(async move { link.serve(&served).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (mut reader, mut writer) = node_side(&path).await;
        let asked = FromNode::Ask {
            id: 41,
            question: NetdQuestion::Sync {
                dirs: vec!["/workspace".into()],
            },
        };
        writer.write_all(&frame(&asked).unwrap()).await.unwrap();
        let Some(Pushed::Asked { id, question }) = received.recv().await else {
            panic!("Node's question reaches whoever answers it");
        };
        assert_eq!(
            (id, question),
            (
                41,
                NetdQuestion::Sync {
                    dirs: vec!["/workspace".into()]
                }
            )
        );
        link.answer(
            id,
            Ok(NetdAnswer::Sync {
                generations: vec![Some(9)],
            }),
        );
        link.answer(42, Err("no feed".into()));
        let answered: ToNode =
            serde_json::from_slice(&read_frame(&mut reader).await.unwrap().unwrap()).unwrap();
        assert_eq!(
            answered,
            ToNode::Answer {
                id: 41,
                answer: NetdAnswer::Sync {
                    generations: vec![Some(9)]
                }
            }
        );
        let refused: ToNode =
            serde_json::from_slice(&read_frame(&mut reader).await.unwrap().unwrap()).unwrap();
        assert_eq!(
            refused,
            ToNode::Refused {
                id: 42,
                message: "no feed".into()
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
