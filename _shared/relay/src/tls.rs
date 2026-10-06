//! The TLS both ends terminate: one certificate in a slot swapped in place when a fresh one arrives, so a renewal never
//! restarts a listener or drops a connection. ALPN offers h2 first: a browser's many streams to one origin share a
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
    /// Takes a PEM chain and its key; a pair that does not load, including a key that is not the certificate's, leaves
    /// the slot as it was. Accepting a mismatched pair would fail every handshake instead of keeping the old one.
    pub fn replace(&self, chain: &str, key: &str) -> anyhow::Result<()> {
        let loaded = certified(chain, key)?;
        *self
            .0
            .write()
            .expect("the certificate slot is never poisoned") = Some(loaded);
        Ok(())
    }

    /// Empties the slot: handshakes fail until a certificate arrives again.
    pub fn clear(&self) {
        *self
            .0
            .write()
            .expect("the certificate slot is never poisoned") = None;
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Issued {
        chain: String,
        key: String,
    }

    fn issue() -> Issued {
        let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        Issued {
            chain: issued.cert.pem(),
            key: issued.signing_key.serialize_pem(),
        }
    }

    fn held(slot: &CertificateSlot) -> Option<Arc<CertifiedKey>> {
        slot.0.read().unwrap().clone()
    }

    // The front once accepted any pair that parsed, so a renewal whose key did not belong to its certificate replaced a
    // working certificate with one every handshake failed on.
    #[test]
    fn a_key_that_is_not_the_certificates_is_refused_and_the_held_one_kept() {
        let slot = CertificateSlot::default();
        let first = issue();
        let second = issue();
        slot.replace(&first.chain, &first.key).unwrap();
        let before = held(&slot).unwrap();

        let error = slot.replace(&second.chain, &first.key).unwrap_err();

        assert_eq!(
            error.to_string(),
            "the private key is not the certificate's"
        );
        assert!(Arc::ptr_eq(&before, &held(&slot).unwrap()));
    }

    #[test]
    fn a_matching_pair_replaces_the_held_one() {
        let slot = CertificateSlot::default();
        let first = issue();
        let second = issue();
        slot.replace(&first.chain, &first.key).unwrap();
        let before = held(&slot).unwrap();

        slot.replace(&second.chain, &second.key).unwrap();

        assert!(!Arc::ptr_eq(&before, &held(&slot).unwrap()));
    }

    #[test]
    fn an_empty_chain_is_refused_and_clear_empties_the_slot() {
        let slot = CertificateSlot::default();
        let issued = issue();
        assert_eq!(
            slot.replace("", &issued.key).unwrap_err().to_string(),
            "the certificate PEM holds no certificate"
        );
        assert!(!slot.present());
        slot.replace(&issued.chain, &issued.key).unwrap();
        assert!(slot.present());
        slot.clear();
        assert!(!slot.present());
    }
}
