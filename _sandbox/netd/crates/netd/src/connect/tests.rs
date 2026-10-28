use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

// Every socket kind keeps scatter/gather available to Hyper, and sends all the slices in order, empty ones included.
async fn round_trip(io: Io, mut peer: impl AsyncRead + AsyncWrite + Unpin) {
    assert!(io.is_write_vectored());
    let mut stream = TokioIo::new(io);
    let slices = [
        io::IoSlice::new(b"headers\r\n"),
        io::IoSlice::new(b""),
        io::IoSlice::new(b"body"),
    ];
    let written = stream.write_vectored(&slices).await.unwrap();
    assert_eq!(written, b"headers\r\nbody".len());
    stream.flush().await.unwrap();
    let mut received = [0; b"headers\r\nbody".len()];
    peer.read_exact(&mut received).await.unwrap();
    assert_eq!(&received, b"headers\r\nbody");

    peer.write_all(b"answer").await.unwrap();
    peer.flush().await.unwrap();
    let mut answer = [0; 6];
    stream.read_exact(&mut answer).await.unwrap();
    assert_eq!(&answer, b"answer");
}

async fn tcp_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (near, (far, _)) = tokio::try_join!(
        TcpStream::connect(listener.local_addr().unwrap()),
        listener.accept(),
    )
    .unwrap();
    (near, far)
}

#[tokio::test]
async fn nodes_unix_socket_writes_every_slice() {
    let (near, far) = UnixStream::pair().unwrap();
    round_trip(
        Io::Unix {
            inner: TokioIo::new(near),
        },
        far,
    )
    .await;
}

#[tokio::test]
async fn a_previews_tcp_socket_writes_every_slice() {
    let (near, far) = tcp_pair().await;
    round_trip(
        Io::Tcp {
            inner: TokioIo::new(near),
        },
        far,
    )
    .await;
}

#[tokio::test]
async fn a_previews_tls_socket_writes_every_slice() {
    let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
    let slot = Arc::new(relay::tls::CertificateSlot::default());
    slot.replace(&issued.cert.pem(), &issued.signing_key.serialize_pem())
        .unwrap();
    let acceptor = relay::tls::acceptor(slot);
    let connector = UpstreamConnector::new();
    let (near, far) = tcp_pair().await;
    let (near, far) = tokio::try_join!(
        connector
            .tls
            .connect(ServerName::try_from("localhost").unwrap(), near),
        acceptor.accept(far),
    )
    .unwrap();
    round_trip(
        Io::Tls {
            inner: TokioIo::new(near),
        },
        far,
    )
    .await;
}
