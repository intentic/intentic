//! A media socket client over castd's Unix socket, for the bench binary and the integration test: what the editor's
//! side does, minus decoding.

use crate::header::Header;
use browser_wire::{BrowserMediaClientMessage, BrowserMediaServerMessage};
use futures_util::{SinkExt, StreamExt};
use std::time::{Duration, Instant};
use tokio::net::UnixStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

pub struct MediaClient {
    ws: WebSocketStream<UnixStream>,
    /// When the latest `hello` arrived: header capture times count from it.
    pub hello_at: Option<Instant>,
}

/// What came off the socket.
#[derive(Debug)]
pub enum Received {
    Json(BrowserMediaServerMessage),
    /// A video or audio message: its header, payload size, and when it arrived.
    Media {
        header: Header,
        len: usize,
        at: Instant,
    },
}

impl MediaClient {
    /// Opens `GET /system/browser-media/<session>?token=…` on `socket`.
    pub async fn connect(socket: &str, session: &str, token: &str) -> Result<MediaClient, String> {
        let stream = UnixStream::connect(socket)
            .await
            .map_err(|e| format!("connect {socket}: {e}"))?;
        let url = format!(
            "ws://castd{}/{session}?token={token}",
            browser_wire::BROWSER_MEDIA_PATH
        );
        let req = url.into_client_request().map_err(|e| e.to_string())?;
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
                    return Some(Received::Media {
                        header,
                        len: b.len() - crate::header::LEN,
                        at,
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
