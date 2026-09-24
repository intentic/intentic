//! The reachability grant a tunnel presents on its upgrade: `ig1.<payload>.<signature>`, an Ed25519 signature by the
//! platform over the JSON `{sub, iat}`, both base64url. The edge holds the public half only, so it can verify a grant and
//! never mint one. Mirrors the contract's ingress-contract.ts and is held to its fixture.

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use ring::signature::{ED25519, UnparsedPublicKey};
use rustls::pki_types::SubjectPublicKeyInfoDer;
use rustls::pki_types::pem::PemObject;

const PREFIX: &str = "ig1";

// An Ed25519 SubjectPublicKeyInfo is this fixed DER header and then the 32-byte key.
const ED25519_SPKI_HEADER: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

// Padded or not, as Node's decoder reads it.
const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

#[derive(Debug, Clone, PartialEq)]
pub struct Grant {
    pub sandbox_id: String,
    /// Seconds since the epoch.
    pub issued_at: f64,
}

pub struct GrantKey(UnparsedPublicKey<[u8; 32]>);

impl GrantKey {
    /// The platform's public key, SPKI PEM; `None` when it is not one Ed25519 key. An env value may carry its newlines
    /// escaped.
    pub fn from_pem(pem: &str) -> Option<Self> {
        let der =
            SubjectPublicKeyInfoDer::from_pem_slice(pem.replace("\\n", "\n").as_bytes()).ok()?;
        let key: [u8; 32] = der
            .as_ref()
            .strip_prefix(&ED25519_SPKI_HEADER)?
            .try_into()
            .ok()?;
        Some(Self(UnparsedPublicKey::new(&ED25519, key)))
    }

    /// The claim of a grant this key signed; `None` for anything else, however malformed.
    pub fn verify(&self, token: &str) -> Option<Grant> {
        let mut parts = token.split('.');
        let (Some(PREFIX), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        let payload = BASE64URL.decode(payload).ok()?;
        let signature = BASE64URL.decode(signature).ok()?;
        self.0.verify(&payload, &signature).ok()?;
        let claim: serde_json::Value = serde_json::from_slice(&payload).ok()?;
        let sandbox_id = claim.get("sub")?.as_str()?;
        let issued_at = claim.get("iat")?.as_f64()?;
        is_sandbox_id(sandbox_id).then(|| Grant {
            sandbox_id: sandbox_id.to_owned(),
            issued_at,
        })
    }
}

/// Twelve lowercase hex digits, the only shape a sandbox id takes.
pub fn is_sandbox_id(text: &str) -> bool {
    text.len() == 12
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Claim {
        sandbox_id: String,
        issued_at: f64,
    }

    #[derive(Deserialize)]
    struct Case {
        token: String,
        claim: Option<Claim>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        public_key: String,
        grants: Vec<Case>,
    }

    #[test]
    fn every_grant_in_the_shared_fixture_verifies_as_the_contract_verifies_it() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../_shared/sandbox-contract/src/protocol/ingress-contract.fixture.json"
        ))
        .unwrap();
        let key = GrantKey::from_pem(&fixture.public_key).unwrap();
        assert!(fixture.grants.len() > 20);
        for Case { token, claim } in fixture.grants {
            let expected = claim.map(|claim| Grant {
                sandbox_id: claim.sandbox_id,
                issued_at: claim.issued_at,
            });
            assert_eq!(key.verify(&token), expected, "grant {token:?}");
        }
    }

    #[test]
    fn a_key_that_is_not_one_ed25519_spki_is_refused() {
        assert!(GrantKey::from_pem("").is_none());
        assert!(
            GrantKey::from_pem("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")
                .is_none()
        );
        // A P-256 key's SPKI: well-formed PEM naming another algorithm.
        let p256 = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUVyTWx+ba0rORouIzlxorOCevyMl\nlHcEsW3R00YaI7S6+7FIgmh/8zuBIX0NJn0oHMGs9ccIcwyXZsPl3rSU4g==\n-----END PUBLIC KEY-----\n";
        assert!(SubjectPublicKeyInfoDer::from_pem_slice(p256.as_bytes()).is_ok());
        assert!(GrantKey::from_pem(p256).is_none());
    }

    #[test]
    fn an_env_value_with_escaped_newlines_is_the_same_key() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../_shared/sandbox-contract/src/protocol/ingress-contract.fixture.json"
        ))
        .unwrap();
        let escaped = fixture.public_key.replace('\n', "\\n");
        let key = GrantKey::from_pem(&escaped).unwrap();
        assert!(key.verify(&fixture.grants[0].token).is_some());
    }
}
