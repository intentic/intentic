//! The front's half of the control lane: accepts Node's connection, reads what it sends, asks it questions. One Node
//! at a time; a new connection (a restarted Node) replaces the old, and every question in flight on the old fails.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use anyhow::{Context, anyhow};
use front_wire::{Answer, FromNode, LENGTH_BYTES, MAX_FRAME_BYTES, Question, ToNode, frame};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::net::unix::OwnedReadHalf;
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
    /// Answer with each checkout's generation, as `ToNode::Synced` carrying this id.
    Sync {
        id: u32,
        dirs: Vec<String>,
    },
}

type Pending = HashMap<u32, oneshot::Sender<Result<Answer, String>>>;

pub struct Link {
    state: watch::Sender<NodeState>,
    writer: Mutex<Option<(u64, mpsc::UnboundedSender<Vec<u8>>)>>,
    pending: Mutex<Pending>,
    next_id: AtomicU32,
    pushed: mpsc::UnboundedSender<Pushed>,
}

impl Link {
    pub fn new(pushed: mpsc::UnboundedSender<Pushed>) -> Self {
        Self {
            state: watch::Sender::new(None),
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            pushed,
        }
    }

    #[cfg(test)]
    pub fn state(&self) -> watch::Receiver<NodeState> {
        self.state.subscribe()
    }

    /// Waits up to `patience` for a Node that has said hello; false when none turned up.
    pub async fn ready(&self, patience: Duration) -> bool {
        let mut state = self.state.subscribe();
        tokio::time::timeout(patience, state.wait_for(Option::is_some))
            .await
            .is_ok_and(|seen| seen.is_ok())
    }

    /// Asks Node and waits for its answer; fails at once when no Node is connected.
    pub async fn ask(&self, question: Question, patience: Duration) -> anyhow::Result<Answer> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (answered, answer) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending poisoned")
            .insert(id, answered);
        if !self.tell(&ToNode::Ask { id, question }) {
            self.pending.lock().expect("pending poisoned").remove(&id);
            return Err(anyhow!("the daemon is not connected"));
        }
        match tokio::time::timeout(patience, answer).await {
            Ok(Ok(Ok(answer))) => Ok(answer),
            Ok(Ok(Err(refusal))) => Err(anyhow!("the daemon refused: {refusal}")),
            Ok(Err(_)) => Err(anyhow!("the daemon went away before answering")),
            Err(_) => {
                self.pending.lock().expect("pending poisoned").remove(&id);
                Err(anyhow!("the daemon did not answer within {patience:?}"))
            }
        }
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
            let (reader, mut writer) = stream.into_split();
            let (sender, mut frames) = mpsc::unbounded_channel::<Vec<u8>>();
            self.replace_writer(generation, sender);
            tokio::spawn(async move {
                while let Some(bytes) = frames.recv().await {
                    if writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            });
            tokio::spawn(async move {
                if let Err(error) = self.read(generation, reader).await {
                    tracing::warn!(%error, "the control lane closed on an unreadable frame");
                }
                self.lost(generation);
            });
        }
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

    fn fail_pending(&self, why: &str) {
        for (_, answered) in self.pending.lock().expect("pending poisoned").drain() {
            let _ = answered.send(Err(why.to_owned()));
        }
    }

    async fn read(&self, generation: u64, reader: OwnedReadHalf) -> anyhow::Result<()> {
        let mut reader = BufReader::new(reader);
        while let Some(bytes) = read_frame(&mut reader).await? {
            let message: FromNode =
                serde_json::from_slice(&bytes).context("decoding a frame from the daemon")?;
            self.receive(generation, message);
        }
        Ok(())
    }

    fn receive(&self, generation: u64, message: FromNode) {
        match message {
            FromNode::Hello { build, pid } => {
                tracing::info!(%build, pid, "the daemon is up");
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
            FromNode::Sync { id, dirs } => {
                let _ = self.pushed.send(Pushed::Sync { id, dirs });
            }
            FromNode::Answer { id, answer } => self.settle(id, Ok(answer)),
            FromNode::Refused { id, message } => self.settle(id, Err(message)),
        }
    }

    fn settle(&self, id: u32, result: Result<Answer, String>) {
        if let Some(answered) = self.pending.lock().expect("pending poisoned").remove(&id) {
            let _ = answered.send(result);
        }
    }
}

/// One frame's JSON, or none at a clean end of stream.
pub async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0_u8; LENGTH_BYTES];
    match reader.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a {length}-byte frame is past the lane's limit"),
        ));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    Ok(Some(bytes))
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
            link.ask(
                Question::Preview {
                    host: "preview-web.localhost".into(),
                },
                Duration::from_secs(2),
            )
            .await
        });
        let question: ToNode =
            serde_json::from_slice(&read_frame(&mut reader).await.unwrap().unwrap()).unwrap();
        let ToNode::Ask { id, .. } = question else {
            panic!("expected a question, got {question:?}")
        };
        let answer = Answer::Preview {
            route: PreviewRoute::Node,
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
}
