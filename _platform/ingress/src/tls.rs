//! The edge's own TLS: one wildcard certificate in the slot both tunnel ends share (`relay::tls`), swapped in place
//! when a fresh one arrives, so a renewal never restarts a listener or drops a connection.

pub use relay::tls::{CertificateSlot, acceptor};
