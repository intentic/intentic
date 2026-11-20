//! A media socket client, for the bench binary and the tests: what the editor's side does, minus decoding. Over castd's
//! Unix socket (`connect`), or any byte stream a server answers on (`over`).

use crate::geometry::Rect;
use crate::header::{FLAG_CLIP, Header, KIND_LOSSLESS, KIND_VIDEO};
use browser_wire::{BrowserMediaClientMessage, BrowserMediaServerMessage};
use futures_util::{SinkExt, StreamExt};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// The stream `connect` dials: castd's Unix socket.
#[cfg(unix)]
pub type Socket = tokio::net::UnixStream;
#[cfg(not(unix))]
pub type Socket = tokio::net::TcpStream;

pub struct MediaClient<S = Socket> {
    ws: WebSocketStream<S>,
    /// When the latest `hello` arrived: header capture times count from it.
    pub hello_at: Option<Instant>,
}

/// What came off the socket.
#[derive(Debug)]
pub enum Received {
    Json(BrowserMediaServerMessage),
    /// A video, audio or lossless message: its header, payload size, and when it arrived; for a `clip`ped frame or a
    /// lossless copy, the rectangle its payload starts with, and for a lossless copy its BGRX pixels.
    Media {
        header: Header,
        len: usize,
        at: Instant,
        rect: Option<Rect>,
        pixels: Option<Vec<u8>>,
    },
}

/// The rectangle a payload starts with (browser-wire's MEDIA_CLIP_LEN bytes).
fn rect_of(payload: &[u8]) -> Option<Rect> {
    let n = |i: usize| -> Option<u32> {
        Some(u32::from(u16::from_be_bytes(
            payload.get(i..i + 2)?.try_into().ok()?,
        )))
    };
    Some(Rect {
        x: n(0)?,
        y: n(2)?,
        w: n(4)?,
        h: n(6)?,
    })
}

#[cfg(unix)]
impl MediaClient<tokio::net::UnixStream> {
    /// Opens `GET /system/browser-media/<session>?token=…` on `socket`.
    pub async fn connect(socket: &str, session: &str, token: &str) -> Result<MediaClient, String> {
        Self::connect_as(socket, session, token, crate::media::Reach::default()).await
    }

    /// The same, as a viewer that reaches castd as `reach` says: on this computer's loopback (the header netd sets on
    /// such an upgrade), asking for exact copies (the query).
    pub async fn connect_as(
        socket: &str,
        session: &str,
        token: &str,
        reach: crate::media::Reach,
    ) -> Result<MediaClient, String> {
        let stream = tokio::net::UnixStream::connect(socket)
            .await
            .map_err(|e| format!("connect {socket}: {e}"))?;
        Self::over(stream, session, token, reach).await
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> MediaClient<S> {
    /// Opens the media socket on a connected `stream`, as a viewer that reaches the server as `reach` says.
    pub async fn over(
        stream: S,
        session: &str,
        token: &str,
        reach: crate::media::Reach,
    ) -> Result<MediaClient<S>, String> {
        let lossless = if reach.lossless {
            format!("&{}=1", browser_wire::MEDIA_LOSSLESS_QUERY)
        } else {
            String::new()
        };
        let url = format!(
            "ws://castd{}/{session}?token={token}{lossless}",
            browser_wire::BROWSER_MEDIA_PATH
        );
        let mut req = url.into_client_request().map_err(|e| e.to_string())?;
        if reach.local {
            req.headers_mut().insert(
                browser_wire::MEDIA_LISTENER_HEADER,
                browser_wire::MEDIA_LOOPBACK
                    .parse()
                    .expect("a header value"),
            );
        }
        let (ws, _) = tokio_tungstenite::client_async(req, stream)
            .await
            .map_err(|e| format!("upgrade: {e}"))?;
        Ok(MediaClient { ws, hello_at: None })
    }

    pub async fn send(&mut self, m: &BrowserMediaClientMessage) -> Result<(), String> {
        let text = serde_json::to_string(m).map_err(|e| e.to_string())?;
        self.ws
            .send(Message::Text(text.into()))
            .await
            .map_err(|e| e.to_string())
    }

    /// The next message, or None when the socket closed or `within` passed.
    pub async fn recv(&mut self, within: Duration) -> Option<Received> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let msg = tokio::time::timeout_at(deadline, self.ws.next())
                .await
                .ok()??
                .ok()?;
            let at = Instant::now();
            match msg {
                Message::Text(t) => {
                    let Ok(m) = serde_json::from_str::<BrowserMediaServerMessage>(t.as_str())
                    else {
                        continue;
                    };
                    if matches!(m, BrowserMediaServerMessage::Hello { .. }) {
                        self.hello_at = Some(at);
                    }
                    return Some(Received::Json(m));
                }
                Message::Binary(b) => {
                    let header = Header::read(&b)?;
                    let payload = &b[crate::header::LEN..];
                    let framed = header.kind == KIND_LOSSLESS
                        || (header.kind == KIND_VIDEO && header.flags & FLAG_CLIP != 0);
                    let pixels = (header.kind == KIND_LOSSLESS)
                        .then(|| payload.get(crate::hub::CLIP_LEN..).map(<[u8]>::to_vec))
                        .flatten();
                    return Some(Received::Media {
                        header,
                        len: payload.len(),
                        at,
                        rect: framed.then(|| rect_of(payload)).flatten(),
                        pixels,
                    });
                }
                Message::Close(_) => return None,
                _ => {}
            }
        }
    }

    /// How long after its capture a message arrived, from the header's time since `hello`.
    pub fn latency_ms(&self, header: &Header, at: Instant) -> Option<f64> {
        let hello = self.hello_at?;
        let captured = hello + Duration::from_millis(u64::from(header.capture_ms));
        Some(at.saturating_duration_since(captured).as_secs_f64() * 1000.0)
    }

    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}
