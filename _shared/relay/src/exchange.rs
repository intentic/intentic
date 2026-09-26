//! One HTTP/1.1 exchange over any byte stream: a tunnel's stream, a peer's TCP connection, a socket to Node or a dev
//! server. An upgrade is itself here, never a special case: when the far side answers 101, the caller's side and the far
//! side are spliced as soon as both are free, whatever carried either.

use http::{Request, Response, StatusCode};
use hyper::rt::{Read, Write};
use hyper_util::rt::TokioIo;

use crate::body::{self, Body};
use crate::headers::{is_upgrade, strip_hop_by_hop};

/// Sends `request` over `io` and answers the far side's response, its body streaming as it arrives. A request whose
/// headers ask for an upgrade (`for_next_hop` restates them) takes the caller's side of it from its extensions; a 101
/// is answered with its upgrade headers intact and an empty body, and any other answer has its hop-by-hop headers gone.
pub async fn exchange<I>(io: I, mut request: Request<Body>) -> Result<Response<Body>, hyper::Error>
where
    I: Read + Write + Send + Unpin + 'static,
{
    let near =
        is_upgrade(request.headers(), request.version()).then(|| hyper::upgrade::on(&mut request));
    let (mut sender, connection) = hyper::client::conn::http1::handshake(io).await?;
    if near.is_some() {
        tokio::spawn(connection.with_upgrades());
    } else {
        tokio::spawn(connection);
    }
    let mut answer = sender.send_request(request).await?;
    let near = match near {
        Some(near) if answer.status() == StatusCode::SWITCHING_PROTOCOLS => near,
        _ => {
            let (mut parts, incoming) = answer.into_parts();
            strip_hop_by_hop(&mut parts.headers);
            return Ok(Response::from_parts(parts, body::incoming(incoming)));
        }
    };
    let far = hyper::upgrade::on(&mut answer);
    tokio::spawn(async move {
        if let (Ok(near), Ok(far)) = tokio::join!(near, far) {
            let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(near), &mut TokioIo::new(far))
                .await;
        }
    });
    let (parts, _) = answer.into_parts();
    Ok(Response::from_parts(parts, body::empty()))
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use http::header;
    use http_body_util::BodyExt;
    use hyper::body::Incoming;
    use hyper::service::service_fn;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    use super::*;
    use crate::headers::for_next_hop;

    // A far side on one end of a pipe: `Upgrade: echo` is taken and echoed, anything else is named back.
    fn far_side(stream: DuplexStream) {
        let service = service_fn(|mut request: Request<Incoming>| async move {
            if request
                .headers()
                .get(header::UPGRADE)
                .is_some_and(|value| value == "echo")
            {
                let upgrading = hyper::upgrade::on(&mut request);
                tokio::spawn(async move {
                    let mut upgraded = TokioIo::new(upgrading.await.unwrap());
                    let mut buffer = [0_u8; 64];
                    while let Ok(read @ 1..) = upgraded.read(&mut buffer).await {
                        if upgraded.write_all(&buffer[..read]).await.is_err() {
                            return;
                        }
                    }
                });
                return Ok::<_, Infallible>(
                    Response::builder()
                        .status(StatusCode::SWITCHING_PROTOCOLS)
                        .header(header::CONNECTION, "upgrade")
                        .header(header::UPGRADE, "echo")
                        .body(body::empty())
                        .unwrap(),
                );
            }
            let named = format!("{} {}", request.method(), request.uri());
            Ok(Response::builder()
                .header(header::CONNECTION, "keep-alive")
                .header(
                    "x-seen",
                    request
                        .headers()
                        .get(header::HOST)
                        .cloned()
                        .unwrap_or(http::HeaderValue::from_static("-")),
                )
                .body(body::full(named))
                .unwrap())
        });
        tokio::spawn(
            hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades(),
        );
    }

    #[tokio::test]
    async fn a_plain_request_is_answered_with_its_hop_by_hop_headers_gone() {
        let (near, far) = tokio::io::duplex(1 << 16);
        far_side(far);
        let request = Request::builder()
            .uri("/files?x=1")
            .header(header::HOST, "sandbox-abcdef012345.sbx.test")
            .body(body::empty())
            .unwrap();
        let answer = exchange(TokioIo::new(near), request).await.unwrap();
        assert_eq!(answer.status(), StatusCode::OK);
        assert!(answer.headers().get(header::CONNECTION).is_none());
        assert_eq!(answer.headers()["x-seen"], "sandbox-abcdef012345.sbx.test");
        let body = answer.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"GET /files?x=1");
    }

    // The caller's side is a real h1 upgrade: a client dials a server whose service relays through `exchange`.
    #[tokio::test]
    async fn an_upgrade_is_spliced_once_the_far_side_answers_101() {
        let (client, server) = tokio::io::duplex(1 << 16);
        let service = service_fn(|request: Request<Incoming>| async move {
            let (far, remote) = tokio::io::duplex(1 << 16);
            far_side(remote);
            let upgrade = is_upgrade(request.headers(), request.version());
            let mut request = request.map(body::incoming);
            for_next_hop(request.headers_mut(), upgrade);
            Ok::<_, Infallible>(exchange(TokioIo::new(far), request).await.unwrap())
        });
        tokio::spawn(
            hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(server), service)
                .with_upgrades(),
        );
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(client))
            .await
            .unwrap();
        tokio::spawn(connection.with_upgrades());
        let request = Request::builder()
            .uri("/ws")
            .header(header::HOST, "sandbox-abcdef012345.sbx.test")
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "echo")
            .body(body::empty())
            .unwrap();
        let mut answer = sender.send_request(request).await.unwrap();
        assert_eq!(answer.status(), StatusCode::SWITCHING_PROTOCOLS);
        assert_eq!(answer.headers()[header::UPGRADE], "echo");
        let mut spliced = TokioIo::new(hyper::upgrade::on(&mut answer).await.unwrap());
        spliced.write_all(b"ping").await.unwrap();
        let mut echoed = [0_u8; 4];
        spliced.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");
    }
}
