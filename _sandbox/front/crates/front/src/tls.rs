//! TLS for the loopback listener: one certificate slot, swapped in place when Node renews it, so a renewal never
//! restarts a listener or drops a connection.

use std::sync::{Arc, RwLock};

use anyhow::{Context, anyhow};
use front_wire::Certificate;
use rustls::ServerConfig;
use rustls::crypto::ring;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use tokio_rustls::TlsAcceptor;

#[derive(Debug, Default)]
pub struct CertificateSlot(RwLock<Option<Arc<CertifiedKey>>>);

impl CertificateSlot {
    pub fn replace(&self, certificate: Option<&Certificate>) -> anyhow::Result<()> {
        let loaded = certificate.map(certified).transpose()?;
        *self.0.write().expect("certificate slot poisoned") = loaded;
        Ok(())
    }

    pub fn present(&self) -> bool {
        self.0.read().expect("certificate slot poisoned").is_some()
    }
}

impl ResolvesServerCert for CertificateSlot {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.0.read().expect("certificate slot poisoned").clone()
    }
}

fn certified(pem: &Certificate) -> anyhow::Result<Arc<CertifiedKey>> {
    let chain = CertificateDer::pem_slice_iter(pem.certificate.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .context("reading the certificate chain")?;
    if chain.is_empty() {
        return Err(anyhow!("the certificate PEM holds no certificate"));
    }
    let key = PrivateKeyDer::from_pem_slice(pem.private_key.as_bytes())
        .context("reading the private key")?;
    let signer = ring::sign::any_supported_type(&key).context("loading the private key")?;
    Ok(Arc::new(CertifiedKey::new(chain, signer)))
}

/// h2 first: HTTP/2 is why the loopback name exists, since six connections per origin starve long-lived streams.
pub fn acceptor(slot: Arc<CertificateSlot>) -> TlsAcceptor {
    let mut config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .with_no_client_auth()
        .with_cert_resolver(slot);
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    TlsAcceptor::from(Arc::new(config))
}
