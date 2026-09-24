//! The edge's own TLS: one wildcard certificate in a slot swapped in place when a fresh one arrives, so a renewal never
//! restarts a listener or drops a connection. ALPN offers h2 first: a browser's many streams to one sandbox share a
//! connection, where six per origin would starve its long-lived ones.

use std::sync::{Arc, RwLock};

use anyhow::{Context, anyhow};
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
    /// Takes a PEM chain and its key; a pair that does not load leaves the slot as it was.
    pub fn replace(&self, chain: &str, key: &str) -> anyhow::Result<()> {
        let loaded = certified(chain, key)?;
        *self
            .0
            .write()
            .expect("the certificate slot is never poisoned") = Some(loaded);
        Ok(())
    }

    pub fn present(&self) -> bool {
        self.0
            .read()
            .expect("the certificate slot is never poisoned")
            .is_some()
    }
}

impl ResolvesServerCert for CertificateSlot {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.0
            .read()
            .expect("the certificate slot is never poisoned")
            .clone()
    }
}

fn certified(chain: &str, key: &str) -> anyhow::Result<Arc<CertifiedKey>> {
    let chain = CertificateDer::pem_slice_iter(chain.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .context("reading the certificate chain")?;
    if chain.is_empty() {
        return Err(anyhow!("the certificate PEM holds no certificate"));
    }
    let key = PrivateKeyDer::from_pem_slice(key.as_bytes()).context("reading the private key")?;
    let signer = ring::sign::any_supported_type(&key).context("loading the private key")?;
    let certified = CertifiedKey::new(chain, signer);
    certified
        .keys_match()
        .context("the private key is not the certificate's")?;
    Ok(Arc::new(certified))
}

pub fn acceptor(slot: Arc<CertificateSlot>) -> TlsAcceptor {
    let mut config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .with_no_client_auth()
        .with_cert_resolver(slot);
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    TlsAcceptor::from(Arc::new(config))
}
