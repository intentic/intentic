//! TLS for the loopback listener: the certificate slot both tunnel ends share (`relay::tls`), swapped in place when Node
//! renews it, so a renewal never restarts a listener or drops a connection. A pair whose key is not the certificate's
//! is refused there, keeping the one held.

use front_wire::Certificate;
pub use relay::tls::{CertificateSlot, acceptor};

/// What Node pushed: a certificate to hold, or none, which empties the slot.
pub fn apply(slot: &CertificateSlot, certificate: Option<&Certificate>) -> anyhow::Result<()> {
    match certificate {
        Some(pem) => slot.replace(&pem.certificate, &pem.private_key),
        None => {
            slot.clear();
            Ok(())
        }
    }
}
