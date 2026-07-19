use sha2::{Digest, Sha256};

/// The per-sandbox identity: sha256(connectToken) first 12 hex chars — must mirror
/// `sandboxIdFromToken` in _libs/sandbox-contract/src/tunnel-ids.ts and connect.sh's fallback.
pub fn sandbox_id_from_token(connect_token: &str) -> String {
    let digest = Sha256::digest(connect_token.as_bytes());
    let mut hex = String::with_capacity(12);
    for byte in digest.iter().take(6) {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// connect.sh's SLUG derivation: explicit subdomain → hostname's leftmost label → token hash.
pub fn derive_slug(subdomain: Option<&str>, hostname: Option<&str>, connect_token: &str) -> String {
    if let Some(subdomain) = subdomain {
        if !subdomain.is_empty() {
            return subdomain.to_string();
        }
    }
    if let Some(hostname) = hostname {
        if let Some(label) = hostname.split('.').next() {
            if !label.is_empty() {
                return label.to_string();
            }
        }
    }
    sandbox_id_from_token(connect_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_hash_matches_sandbox_contract() {
        // Pinned against sha256("token") — the same derivation tunnel-ids.ts documents.
        assert_eq!(sandbox_id_from_token("token"), "3c469e9d6c58");
    }

    #[test]
    fn slug_prefers_subdomain_then_hostname_label() {
        assert_eq!(
            derive_slug(Some("custom"), Some("sandbox-abc.zone.dev"), "t"),
            "custom"
        );
        assert_eq!(
            derive_slug(None, Some("sandbox-abc.zone.dev"), "t"),
            "sandbox-abc"
        );
        assert_eq!(derive_slug(Some(""), None, "token"), "3c469e9d6c58");
    }
}
