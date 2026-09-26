//! `/tunnel/v2` over TCP: one WebSocket carrying yamux, the edge opening a stream per exchange and the front serving
//! each as one HTTP/1.1 connection, as a QUIC stream is. Opening a stream costs no round trip (its first frame opens it),
//! and a transfer's frames interleave with every other stream's, so nothing is routed by what a request is for.

use std::future::poll_fn;
use std::task::Poll;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use yamux::{Config, Connection, ConnectionError, Mode};

use crate::MAX_STREAMS;

/// The protocol the WebSocket carries, as the manifest names it.
pub const PROTOCOL: &str = "yamux";

/// One exchange's byte stream, for HTTP/1.1 on either end.
pub type Stream = Compat<yamux::Stream>;

// yamux starts every stream's window at 256 KiB and requires the session's limit to cover that for every stream.
const STREAM_CREDIT: usize = 256 * 1024;

fn config() -> Config {
    let mut config = Config::default();
    config
        .set_max_connection_receive_window(Some(MAX_STREAMS as usize * STREAM_CREDIT))
        .set_max_num_streams(MAX_STREAMS as usize);
    config
}

type Asked = oneshot::Sender<Result<Stream, String>>;

/// The edge's side: a stream per exchange, for as long as the session runs.
#[derive(Clone)]
pub struct Opener {
    asks: mpsc::UnboundedSender<Asked>,
}

impl Opener {
    pub async fn open(&self) -> anyhow::Result<Stream> {
        let (asked, answer) = oneshot::channel();
        self.asks
            .send(asked)
            .map_err(|_| anyhow::anyhow!("the session has ended"))?;
        answer
            .await
            .map_err(|_| anyhow::anyhow!("the session ended before the stream opened"))?
            .map_err(|why| anyhow::anyhow!("the session refused a stream: {why}"))
    }
}

/// The session's own task: it moves every stream's bytes, and ends, with why, when the session does.
pub type Driving = JoinHandle<Result<(), ConnectionError>>;

/// Runs the edge's end of a session over `io`. A stream the front opens is refused: the front only answers.
pub fn client<S>(io: S) -> (Opener, Driving)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut connection = Connection::new(io.compat(), config(), Mode::Client);
    let (asks, mut asked) = mpsc::unbounded_channel::<Asked>();
    let mut waiting: Option<Asked> = None;
    let driving = tokio::spawn(poll_fn(move |cx| {
        loop {
            if waiting.is_none() {
                match asked.poll_recv(cx) {
                    Poll::Ready(Some(next)) => waiting = Some(next),
                    Poll::Ready(None) | Poll::Pending => break,
                }
            }
            let Some(next) = waiting.take() else {
                break;
            };
            match connection.poll_new_outbound(cx) {
                Poll::Ready(Ok(stream)) => {
                    let _ = next.send(Ok(stream.compat()));
                }
                Poll::Ready(Err(error)) => {
                    let _ = next.send(Err(error.to_string()));
                    return Poll::Ready(Err(error));
                }
                Poll::Pending => {
                    waiting = Some(next);
                    break;
                }
            }
        }
        loop {
            match connection.poll_next_inbound(cx) {
                Poll::Ready(Some(Ok(refused))) => drop(refused),
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Err(error)),
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
    }));
    (Opener { asks }, driving)
}

/// Runs the front's end of a session over `io`: every stream the edge opens arrives on the receiver.
pub fn server<S>(io: S) -> (mpsc::UnboundedReceiver<Stream>, Driving)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut connection = Connection::new(io.compat(), config(), Mode::Server);
    let (arriving, arrivals) = mpsc::unbounded_channel();
    let driving = tokio::spawn(poll_fn(move |cx| {
        loop {
            match connection.poll_next_inbound(cx) {
                Poll::Ready(Some(Ok(stream))) => {
                    let _ = arriving.send(stream.compat());
                }
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Err(error)),
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
    }));
    (arrivals, driving)
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[tokio::test]
    async fn every_stream_the_edge_opens_reaches_the_front_and_carries_both_ways() {
        let (edge_side, front_side) = tokio::io::duplex(1 << 16);
        let (opener, _edge) = client(edge_side);
        let (mut arrivals, _front) = server(front_side);
        tokio::spawn(async move {
            while let Some(mut stream) = arrivals.recv().await {
                tokio::spawn(async move {
                    let mut asked = [0_u8; 5];
                    stream.read_exact(&mut asked).await.unwrap();
                    stream.write_all(&asked).await.unwrap();
                    stream.write_all(b"!").await.unwrap();
                    stream.shutdown().await.unwrap();
                });
            }
        });
        let mut answers = Vec::new();
        for index in 0..20_u8 {
            let opener = opener.clone();
            answers.push(tokio::spawn(async move {
                let mut stream = opener.open().await.unwrap();
                let asked = [index; 5];
                stream.write_all(&asked).await.unwrap();
                let mut answer = Vec::new();
                stream.read_to_end(&mut answer).await.unwrap();
                assert_eq!(answer, [&asked[..], b"!"].concat());
            }));
        }
        for answer in answers {
            answer.await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_session_whose_socket_ends_ends_and_opens_nothing_more() {
        let (edge_side, front_side) = tokio::io::duplex(1 << 16);
        let (opener, edge) = client(edge_side);
        drop(front_side);
        let _ended = edge.await.unwrap();
        assert!(opener.open().await.is_err());
    }
}
