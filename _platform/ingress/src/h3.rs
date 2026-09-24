//! HTTP/3 for browsers on the QUIC endpoint the fronts dial, found through the Alt-Svc TCP answers carry. Each request
//! reaches the handler a TCP one does, so routing, refusals and tunnels are the TCP path's. The only extended CONNECT is
//! WebTransport's (`webtransport.rs`), so a WebSocket stays on TCP.

use std::net::SocketAddr;
use std::sync::Arc;

use bytes::{Buf, Bytes};
use h3::error::Code;
use h3::server::RequestStream;
use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use tokio::sync::mpsc;

use crate::body::{Body, BoxError};
use crate::edge::{Edge, Via};
use crate::webtransport;

/// Answers a browser's requests for as long as its connection lasts, or until a WebTransport session takes it.
pub async fn serve(edge: Arc<Edge>, connection: quinn::Connection) {
    let remote = connection.remote_address();
    let Ok(mut accepted) = h3::server::builder()
        .enable_extended_connect(true)
        .enable_webtransport(true)
        .enable_datagram(true)
        .max_webtransport_sessions(1)
        .build::<_, Bytes>(h3_quinn::Connection::new(connection))
        .await
    else {
        return;
    };
    // Each request resolves on its own task, so one slow head never holds up the next; a session comes back here for the
    // connection it takes.
    let (asking, mut asked) = mpsc::channel(1);
    loop {
        tokio::select! {
            accepting = accepted.accept() => match accepting {
                Ok(Some(resolver)) => {
                    let edge = edge.clone();
                    let asking = asking.clone();
                    tokio::spawn(async move {
                        let Ok((request, stream)) = resolver.resolve_request().await else {
                            return;
                        };
                        if !webtransport::asks(&request) {
                            return answer(edge, request, stream, remote).await;
                        }
                        match webtransport::admits(&request) {
                            Some(host) => {
                                let _ = asking.send((request, stream, host)).await;
                            }
                            None => webtransport::refuse(stream, StatusCode::NOT_FOUND).await,
                        }
                    });
                }
                Ok(None) => return,
                Err(error) => {
                    tracing::debug!(%error, %remote, "an HTTP/3 connection ended");
                    return;
                }
            },
            Some((request, stream, host)) = asked.recv() => {
                drop(asked);
                return webtransport::serve(edge, request, stream, accepted, host, remote).await;
            }
        }
    }
}

pub(crate) async fn answer(
    edge: Arc<Edge>,
    request: Request<()>,
    stream: RequestStream<h3_quinn::BidiStream<Bytes>, Bytes>,
    remote: SocketAddr,
) {
    let (mut send, recv) = stream.split();
    let response = edge
        .handle(request.map(|()| sent(recv)), remote, Via::Direct)
        .await;
    let (parts, mut body) = response.into_parts();
    if send
        .send_response(Response::from_parts(parts, ()))
        .await
        .is_err()
    {
        return;
    }
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            send.stop_stream(Code::H3_INTERNAL_ERROR);
            return;
        };
        match frame.into_data() {
            Ok(data) => {
                if send.send_data(data).await.is_err() {
                    return;
                }
            }
            Err(frame) => {
                if let Ok(trailers) = frame.into_trailers() {
                    let _ = send.send_trailers(trailers).await;
                    return;
                }
            }
        }
    }
    let _ = send.finish().await;
}

// The request's body as the handler reads any other: its data frames in order, ended by the browser's own finish.
fn sent(recv: RequestStream<h3_quinn::RecvStream, Bytes>) -> Body {
    let frames = futures_util::stream::unfold(Some(recv), |recv| async move {
        let mut recv = recv?;
        match recv.recv_data().await {
            Ok(Some(mut chunk)) => {
                let data = chunk.copy_to_bytes(chunk.remaining());
                Some((Ok(Frame::data(data)), Some(recv)))
            }
            Ok(None) => None,
            Err(error) => Some((Err(Box::new(error) as BoxError), None)),
        }
    });
    StreamBody::new(frames).boxed_unsync()
}
