//! Secrets at rest: AES-256-GCM under a key the app unwraps from the Android Keystore at each start (`Config`). The
//! nonce is random per value and stored in front of its ciphertext; the key's name is bound in as associated data, so
//! a sealed value copied under another name does not open.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};

pub struct Sealer {
    key: LessSafeKey,
    random: SystemRandom,
}

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("the secret key is not 32 bytes of base64")]
    Key,
    #[error("a sealed value did not open: another key, or tampered")]
    Open,
    #[error("no random bytes")]
    Random,
}

impl Sealer {
    pub fn new(key_base64: &str) -> Result<Sealer, SealError> {
        let bytes = STANDARD.decode(key_base64).map_err(|_| SealError::Key)?;
        let key = UnboundKey::new(&AES_256_GCM, &bytes).map_err(|_| SealError::Key)?;
        Ok(Sealer {
            key: LessSafeKey::new(key),
            random: SystemRandom::new(),
        })
    }

    pub fn seal(&self, name: &str, plain: &[u8]) -> Result<Vec<u8>, SealError> {
        let mut nonce = [0u8; NONCE_LEN];
        self.random
            .fill(&mut nonce)
            .map_err(|_| SealError::Random)?;
        let mut sealed = plain.to_vec();
        self.key
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(name.as_bytes()),
                &mut sealed,
            )
            .map_err(|_| SealError::Random)?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&sealed);
        Ok(out)
    }

    pub fn open(&self, name: &str, sealed: &[u8]) -> Result<Vec<u8>, SealError> {
        if sealed.len() < NONCE_LEN {
            return Err(SealError::Open);
        }
        let (nonce, body) = sealed.split_at(NONCE_LEN);
        let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| SealError::Open)?;
        let mut body = body.to_vec();
        let plain = self
            .key
            .open_in_place(nonce, Aad::from(name.as_bytes()), &mut body)
            .map_err(|_| SealError::Open)?;
        Ok(plain.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    #[test]
    fn opens_what_it_sealed_under_the_same_name_only() {
        let sealer = Sealer::new(KEY).unwrap();
        let sealed = sealer.seal("platform", b"session=abc").unwrap();
        assert_eq!(sealer.open("platform", &sealed).unwrap(), b"session=abc");
        assert!(
            sealer.open("sandbox:1", &sealed).is_err(),
            "a value moved under another name"
        );
        let other = Sealer::new("HwAeAB0AHAAbABoAGQAYABcAFgAVABQAEwASABEAEAA=").unwrap();
        assert!(
            other.open("platform", &sealed).is_err(),
            "another device's key"
        );
        assert!(Sealer::new("short").is_err());
    }
}
