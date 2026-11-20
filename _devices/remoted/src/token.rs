//! The token a person's viewer opens a socket with, `?token=` on its upgrade: castd's format exactly
//! (`_sandbox/castd/README.md`, "The token"), so the daemon mints both with one function. The daemon mints it under the
//! uplink's media key and remoted only checks it. `s` names what it opens: `terminal/<session>`, or `media/<session>` for
//! a screen (phase 2).
//!
//! Format: `base64url(payload) + "." + base64url(HMAC-SHA256(key, payload))`, both without padding, where `payload` is
//! the UTF-8 JSON `{"s":…,"exp":<ms>,"ro":<bool>,"iat":<ms>}` as signed. The MAC covers the payload's bytes as sent; the
//! JSON is parsed only after the MAC matched.
//!
//! Kept here rather than taken from castd: castd is a Linux binary crate. When cast-core carries the token, this module
//! becomes a re-export of it; castd's test vector below holds the two equal meanwhile.

use base64::Engine;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// What a token's subject starts with for a terminal.
pub const TERMINAL_SUBJECT: &str = "terminal/";

/// What a token's subject starts with for a screen.
pub const MEDIA_SUBJECT: &str = "media/";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Claims {
    /// What the token opens: `terminal/<session>` or `media/<session>`.
    pub s: String,
    /// When it stops opening sockets, in milliseconds since the epoch.
    pub exp: u64,
    /// A read-only viewer: it watches, and what it types is dropped.
    #[serde(default)]
    pub ro: bool,
    /// When it was minted, in milliseconds since the epoch; 0 and left out when the minter does not say.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub iat: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    Malformed,
    BadSignature,
    OtherSession,
    Expired,
    /// Minted before the viewers were last dropped.
    Dropped,
}

impl Refused {
    pub fn words(self) -> &'static str {
        match self {
            Refused::Malformed => "malformed token",
            Refused::BadSignature => "bad token signature",
            Refused::OtherSession => "token is for another session",
            Refused::Expired => "token expired",
            Refused::Dropped => "token was minted before the viewers were dropped",
        }
    }
}

/// The media key as the config carries it: base64url of the key's bytes (padding optional), as the daemon makes it.
pub fn decode_key(text: &str) -> Option<Vec<u8>> {
    let trimmed = text.trim();
    let key = URL_SAFE_NO_PAD
        .decode(trimmed.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(trimmed))
        .ok()?;
    (!key.is_empty()).then_some(key)
}

/// Mints a token: the daemon does this in TypeScript; here for tests.
pub fn sign(key: &[u8], claims: &Claims) -> String {
    let payload = serde_json::to_vec(claims).expect("claims serialize");
    sign_payload(key, &payload)
}

/// Mints a token over payload bytes as given.
pub fn sign_payload(key: &[u8], payload: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(payload);
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(payload),
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

/// Checks a token against the key and the subject it must open, at `now_ms`.
pub fn verify(key: &[u8], subject: &str, token: &str, now_ms: u64) -> Result<Claims, Refused> {
    let (payload, sig) = token.split_once('.').ok_or(Refused::Malformed)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| Refused::Malformed)?;
    let sig = URL_SAFE_NO_PAD
        .decode(sig)
        .map_err(|_| Refused::Malformed)?;
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| Refused::BadSignature)?;
    mac.update(&payload);
    // Constant time.
    mac.verify_slice(&sig).map_err(|_| Refused::BadSignature)?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| Refused::Malformed)?;
    if claims.s != subject {
        return Err(Refused::OtherSession);
    }
    if claims.exp <= now_ms {
        return Err(Refused::Expired);
    }
    Ok(claims)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // castd's own vector (_sandbox/castd/src/token.rs), computed there with Node's crypto: the same bytes must verify here.
    const KEY: &[u8] = b"castd-test-key";
    const PAYLOAD: &str = r#"{"s":"browser-own","exp":1893456000000,"ro":false}"#;
    const TOKEN: &str = "eyJzIjoiYnJvd3Nlci1vd24iLCJleHAiOjE4OTM0NTYwMDAwMDAsInJvIjpmYWxzZX0.YKTUvxiTZMF1qntsiKCawvxUDDzjYqLIgo9u7ovM2yU";
    const READ_ONLY: &str = "eyJzIjoiYnJvd3Nlci1vd24iLCJleHAiOjE4OTM0NTYwMDAwMDAsInJvIjp0cnVlfQ.pjevX1BbOWyWEvjGnL0pHTHEPQGANDz1M_C9oDrj9L8";
    const NOW: u64 = 1_800_000_000_000;

    #[test]
    fn castds_test_vector_signs_and_verifies_here() {
        assert_eq!(sign_payload(KEY, PAYLOAD.as_bytes()), TOKEN);
        let claims = Claims {
            s: "browser-own".into(),
            exp: 1_893_456_000_000,
            ro: false,
            iat: 0,
        };
        assert_eq!(sign(KEY, &claims), TOKEN);
        assert_eq!(verify(KEY, "browser-own", TOKEN, NOW), Ok(claims));
        assert!(verify(KEY, "browser-own", READ_ONLY, NOW).unwrap().ro);
    }

    #[test]
    fn a_wrong_key_subject_or_time_is_refused() {
        assert_eq!(
            verify(b"another-key", "browser-own", TOKEN, NOW),
            Err(Refused::BadSignature)
        );
        assert_eq!(
            verify(KEY, "terminal/browser-own", TOKEN, NOW),
            Err(Refused::OtherSession)
        );
        assert_eq!(
            verify(KEY, "browser-own", TOKEN, 1_893_456_000_000),
            Err(Refused::Expired)
        );
    }

    #[test]
    fn garbage_is_refused_without_panicking() {
        for garbage in ["", ".", "abc", "a.b.c", "!!!.???"] {
            assert!(verify(KEY, "x", garbage, NOW).is_err(), "{garbage}");
        }
        let odd = sign_payload(KEY, b"[1,2,3]");
        assert_eq!(verify(KEY, "x", &odd, NOW), Err(Refused::Malformed));
    }

    #[test]
    fn the_media_key_reads_with_or_without_padding() {
        let key = [7_u8; 32];
        let unpadded = URL_SAFE_NO_PAD.encode(key);
        let padded = URL_SAFE.encode(key);
        assert_eq!(unpadded.len(), 43);
        assert_eq!(decode_key(&unpadded), Some(key.to_vec()));
        assert_eq!(decode_key(&padded), Some(key.to_vec()));
        assert_eq!(decode_key(""), None);
        assert_eq!(decode_key("not base64!"), None);
    }
}
