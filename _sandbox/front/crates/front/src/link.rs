//! The front's half of the control socket: accepts Node's connection, reads what it sends, asks it questions and answers
//! its. One Node at a time; a new connection (a restarted Node) replaces the old once its first frame decodes, and every
//! question in flight on the old fails. A connection whose first frame does not decode is not Node's (an agent that took
//! the socket for the HTTP one, `curl --unix-socket`): it is refused and the live link stands, since Node reads its
//! link closing as the box going down. A reply the front cannot read refuses its own question and leaves the link up:
//! that is how an older Node answers a question it does not know.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use anyhow::{Context, anyhow};
use front_wire::{
    ASK_PATIENCE, Answer, FromNode, FrontAnswer, FrontQuestion, LENGTH_BYTES, MAX_FRAME_BYTES,
    Question, ToNode, frame,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedReadHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, watch};

/// What Node has said about itself: its connection's generation while it is up, nothing while it is not.
pub type NodeState = Option<u64>;

/// Configuration Node pushes, handed to whoever applies it.
#[derive(Debug)]
pub enum Pushed {
    Listen(front_wire::ListenConfig),
    Certificate(Option<front_wire::Certificate>),
    Tunnel(Option<front_wire::TunnelConfig>),
    /// A new Node said hello: anything the front reports must be told again.
    Hello,
    /// Close the member's terminals, or every member's.
    Revoke(Option<String>),
    Watch(front_wire::WatchedCheckout),
    Unwatch(String),
    /// A question Node asked; whoever applies it answers with `Link::answer` and this id.
    Asked {
        id: u32,
        question: FrontQuestion,
    },
}

/// How a question the front asked ended: Node's answer, its refusal and why, or the reason there was neither.
#[derive(Debug)]
enum Reply {
    Answered(Answer),
    Refused(String),
    Lost(&'static str),
}

type Pending = HashMap<u32, oneshot::Sender<Reply>>;

pub struct Link {
    state: watch::Sender<NodeState>,
    said_hello: AtomicBool,
    writer: Mutex<Option<(u64, mpsc::UnboundedSender<Vec<u8>>)>>,
    pending: Mutex<Pending>,
    next_id: AtomicU32,
    pushed: mpsc::UnboundedSender<Pushed>,
}

impl Link {
    pub fn new(pushed: mpsc::UnboundedSender<Pushed>) -> Self {
        Self {
            state: watch::Sender::new(None),
            said_hello: AtomicBool::new(false),
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            pushed,
        }
    }

    pub fn state(&self) -> watch::Receiver<NodeState> {
        self.state.subscribe()
    }

    /// Whether any Node said hello since the front started.
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
    pub fn answer(&self, id: u32, answer: Result<FrontAnswer, String>) {
        let _ = self.tell(&match answer {
            Ok(answer) => ToNode::Answer { id, answer },
            Err(message) => ToNode::Refused { id, message },
        });
    }

    /// Sends a message to the current Node; false when there is none to send it to.
    pub fn tell(&self, message: &ToNode) -> bool {
        let bytes = frame(message).expect("a ToNode always serializes");
        self.writer
            .lock()
            .expect("writer poisoned")
            .as_ref()
            .is_some_and(|(_, writer)| writer.send(bytes).is_ok())
    }

    pub async fn serve(&'static self, path: &Path) -> anyhow::Result<()> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)
            .with_context(|| format!("binding the control socket {}", path.display()))?;
        let mut generation = 0_u64;
        loop {
            let (stream, _) = listener.accept().await?;
            generation += 1;
            tokio::spawn(self.connection(generation, stream));
        }
    }

    // A connection takes the link only once its first frame decodes: replacing the writer at accept would hang up on
    // the live Node for whatever dialed the socket, and Node stops the box when its link closes unasked.
    async fn connection(&'static self, generation: u64, stream: UnixStream) {
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
        let (sender, mut frames) = mpsc::unbounded_channel::<Vec<u8>>();
        self.replace_writer(generation, sender);
        tokio::spawn(async move {
            while let Some(bytes) = frames.recv().await {
                if writer.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });
        self.receive(generation, first);
        if let Err(error) = self.read(generation, reader).await {
            tracing::warn!(%error, "the control socket closed on an unreadable frame");
        }
        self.lost(generation);
    }

    // A new connection is not up until it says hello, whatever the one it replaces had said.
    fn replace_writer(&self, generation: u64, sender: mpsc::UnboundedSender<Vec<u8>>) {
        *self.writer.lock().expect("writer poisoned") = Some((generation, sender));
        self.state.send_replace(None);
        self.fail_pending("the daemon reconnected before answering");
    }

    // Only the current connection's end means Node is gone; an older one closing after its replacement means nothing.
    fn lost(&self, generation: u64) {
        let mut writer = self.writer.lock().expect("writer poisoned");
        if writer
            .as_ref()
            .is_some_and(|(current, _)| *current == generation)
        {
            *writer = None;
            drop(writer);
            self.state.send_replace(None);
            self.fail_pending("the daemon went away before answering");
        }
    }

    fn fail_pending(&self, why: &'static str) {
        for (_, answered) in self.pending.lock().expect("pending poisoned").drain() {
            let _ = answered.send(Reply::Lost(why));
        }
    }

    async fn read(
        &self,
        generation: u64,
        mut reader: BufReader<OwnedReadHalf>,
    ) -> anyhow::Result<()> {
        while let Some(bytes) = read_frame(&mut reader).await? {
            match serde_json::from_slice::<FromNode>(&bytes) {
                Ok(message) => self.receive(generation, message),
                Err(error) => {
                    let Some(id) = unreadable_reply(&bytes) else {
                        return Err(error).context("decoding a frame from the daemon");
                    };
                    tracing::debug!(%error, id, "the daemon's reply is unreadable; its question counts as refused");
                    self.settle(id, Reply::Refused(format!("an unreadable reply: {error}")));
                }
            }
        }
        Ok(())
    }

    fn receive(&self, generation: u64, message: FromNode) {
        match message {
            FromNode::Hello { build, pid } => {
                tracing::info!(%build, pid, "the daemon is up");
                self.said_hello.store(true, Ordering::Relaxed);
                self.state.send_replace(Some(generation));
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
    let body = "This is intentic-front's control socket, which only the sandbox daemon speaks: it is not HTTP.\n\
                Reach the daemon through the sandbox's own commands (agents, capabilities, secrets, ...) instead.\n";
    format!(
        "HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use front_wire::PreviewRoute;
    use tokio::net::UnixStream;

    async fn node_side(
        path: &Path,
    ) -> (BufReader<OwnedReadHalf>, tokio::net::unix::OwnedWriteHalf) {
        let (reader, writer) = UnixStream::connect(path).await.unwrap().into_split();
        (BufReader::new(reader), writer)
    }

    #[tokio::test]
    async fn a_question_is_answered_by_its_id_and_hello_marks_node_up() {
        let dir = std::env::temp_dir().join(format!("front-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("front.sock");
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
        let dir = std::env::temp_dir().join(format!("front-link-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("front.sock");
        let (pushed, received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let socket = path.clone();
        tokio::spawn(async move { link.serve(&socket).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        (link, path, received)
    }

    async fn hello(writer: &mut tokio::net::unix::OwnedWriteHalf) {
        let hello = FromNode::Hello {
            build: "test".into(),
            pid: 7,
        };
        writer.write_all(&frame(&hello).unwrap()).await.unwrap();
    }

    // A ping answered over Node's own connection: proof the front still holds it as the link.
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
            .expect("the front asks over Node's connection")
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

    // The 2026-10-04 restart: an agent ran `curl --unix-socket /run/intentic/front.sock http://sandbox/...`. The front
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
            .expect("the front hangs up on it")
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
                .expect("the front hangs up on it")
                .unwrap();
            assert!(left.is_empty());
        }

        assert_eq!(*link.state().borrow(), Some(1));
        ping_round_trip(link, &mut reader, &mut writer).await;
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // Node says hello last, once it serves HTTP, so a restarted Node takes the link at its first frame, whatever it is.
    #[tokio::test]
    async fn a_restarted_node_takes_the_link_at_its_first_frame_and_the_old_one_is_hung_up() {
        let (link, path, mut received) = served("restart").await;
        let (mut old_reader, mut old_writer) = node_side(&path).await;
        hello(&mut old_writer).await;
        assert!(link.ready(Duration::from_secs(2)).await);
        assert!(matches!(received.recv().await, Some(Pushed::Hello)));

        let (mut reader, mut writer) = node_side(&path).await;
        let unwatch = FromNode::Unwatch {
            dir: "/workspace".into(),
        };
        writer.write_all(&frame(&unwatch).unwrap()).await.unwrap();
        assert!(matches!(received.recv().await, Some(Pushed::Unwatch(dir)) if dir == "/workspace"));
        assert_eq!(*link.state().borrow(), None);
        let old_end = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut old_reader))
            .await
            .expect("the old connection is hung up")
            .unwrap();
        assert!(old_end.is_none());

        hello(&mut writer).await;
        assert!(link.ready(Duration::from_secs(2)).await);
        assert_eq!(*link.state().borrow(), Some(2));
        ping_round_trip(link, &mut reader, &mut writer).await;
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
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
    async fn an_answer_the_front_cannot_read_refuses_its_question_and_keeps_the_link() {
        let dir = std::env::temp_dir().join(format!("front-link-older-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("front.sock");
        let (pushed, _received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let served = path.clone();
        tokio::spawn(async move { link.serve(&served).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (mut reader, mut writer) = node_side(&path).await;
        let hello = FromNode::Hello {
            build: "older".into(),
            pid: 7,
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
    async fn node_asks_the_front_under_the_same_envelope_and_hears_the_answer_by_its_id() {
        let dir = std::env::temp_dir().join(format!("front-link-asked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("front.sock");
        let (pushed, mut received) = mpsc::unbounded_channel();
        let link: &'static Link = Box::leak(Box::new(Link::new(pushed)));
        let served = path.clone();
        tokio::spawn(async move { link.serve(&served).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (mut reader, mut writer) = node_side(&path).await;
        let asked = FromNode::Ask {
            id: 41,
            question: FrontQuestion::Sync {
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
                FrontQuestion::Sync {
                    dirs: vec!["/workspace".into()]
                }
            )
        );
        link.answer(
            id,
            Ok(FrontAnswer::Sync {
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
                answer: FrontAnswer::Sync {
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
