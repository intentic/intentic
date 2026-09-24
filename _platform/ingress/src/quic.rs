//! The edge's UDP door, told apart by ALPN: a front presenting its grant in a hello is held as its sandbox's carrier, each
//! request then a stream of its own, and a browser speaks HTTP/3. It needs the certificate the TLS listener serves, since
//! QUIC is TLS or nothing.

use std::net::SocketAddr;
use std::sync::Arc;

use quinn::crypto::rustls::QuicServerConfig;
use quinn::{Endpoint, ServerConfig};

use crate::edge::Edge;
use crate::tls::CertificateSlot;

/// A browser's HTTP/3, beside the fronts' tunnel on the one endpoint.
const H3: &[u8] = b"h3";

pub fn endpoint(address: SocketAddr, slot: Arc<CertificateSlot>) -> anyhow::Result<Endpoint> {
    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])?
    .with_no_client_auth()
    .with_cert_resolver(slot);
    tls.alpn_protocols = vec![tunnel::quic::ALPN.to_vec(), H3.to_vec()];
    let mut server = ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(tls)?));
    server.transport_config(tunnel::quic::transport());
    Ok(Endpoint::server(server, address)?)
}

/// Accepts connections for as long as the endpoint is open.
pub async fn accept(endpoint: Endpoint, edge: Arc<Edge>) {
    while let Some(incoming) = endpoint.accept().await {
        let edge = edge.clone();
        tokio::spawn(async move {
            let connection = match incoming.await {
                Ok(connection) => connection,
                Err(error) => {
                    tracing::debug!(%error, "a QUIC handshake failed");
                    return;
                }
            };
            let protocol = connection
                .handshake_data()
                .and_then(|data| data.downcast::<quinn::crypto::rustls::HandshakeData>().ok())
                .and_then(|data| data.protocol);
            if protocol.as_deref() == Some(H3) {
                crate::h3::serve(edge, connection).await;
            } else {
                edge.hold_quic(connection).await;
            }
        });
    }
}
