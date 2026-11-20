//! The token a media socket opens with, `?token=` on its upgrade. The Node daemon mints it and hands it to the editor
//! in the browser view socket's `media` message; castd only checks it.
//!
//! Format: `base64url(payload) + "." + base64url(HMAC-SHA256(key, payload))`, both base64url WITHOUT padding, where
//! `payload` is the UTF-8 JSON `{"s":"<session>","exp":<ms since the epoch>,"ro":<bool>}` and `key` is the raw bytes of
//! castd's `--key-file`, exactly as stored (no trimming). The MAC covers the payload's bytes as sent, so the minter's
//! key order and spacing are its own; castd parses the JSON only after the MAC matched. `s` must be castd's
//! `--session`, `exp` later than now, and `ro: true` makes the viewer read-only: it watches and its input is ignored.
//! A token is checked once, at the upgrade: a socket stays open after its token expires.
//!
//! Test vector (key = the 14 ASCII bytes `castd-test-key`, payload = `{"s":"browser-own","exp":1893456000000,"ro":false}`):
//! `eyJzIjoiYnJvd3Nlci1vd24iLCJleHAiOjE4OTM0NTYwMDAwMDAsInJvIjpmYWxzZX0.YKTUvxiTZMF1qntsiKCawvxUDDzjYqLIgo9u7ovM2yU`

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Claims {
    /// The session (window) the token opens.
    pub s: String,
    /// When it stops opening sockets, in milliseconds since the epoch.
    pub exp: u64,
    /// A read-only viewer.
    #[serde(default)]
    pub ro: bool,
    /// When it was minted, in milliseconds since the epoch: a token minted before the daemon last dropped the viewers
    /// opens nothing (`Hub::token_allowed`). 0, and left out of the payload, when the minter does not say.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub iat: u64,
}

fn is_zero(v: &u64) -> bool {
    *v == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    Malformed,
    BadSignature,
    OtherSession,
    Expired,
}

impl Refused {
    pub fn words(self) -> &'static str {
        match self {
            Refused::Malformed => "malformed token",
            Refused::BadSignature => "bad token signature",
            Refused::OtherSession => "token is for another session",
            Refused::Expired => "token expired",
        }
    }
}

/// Mints a token: what the daemon does in TypeScript, here for tests and the bench client.
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

/// Checks a token against castd's key and session at `now_ms`.
pub fn verify(key: &[u8], session: &str, token: &str, now_ms: u64) -> Result<Claims, Refused> {
    let (payload, sig) = token.split_once('.').ok_or(Refused::Malformed)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| Refused::Malformed)?;
    let sig = URL_SAFE_NO_PAD
        .decode(sig)
        .map_err(|_| Refused::Malformed)?;
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| Refused::BadSignature)?;
    mac.update(&payload);
    // verify_slice compares in constant time.
    mac.verify_slice(&sig).map_err(|_| Refused::BadSignature)?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| Refused::Malformed)?;
    if claims.s != session {
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
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"castd-test-key";
    const PAYLOAD: &str = r#"{"s":"browser-own","exp":1893456000000,"ro":false}"#;
    // Computed independently, with Node's crypto (createHmac("sha256") and base64url), not with this module.
    const TOKEN: &str = "eyJzIjoiYnJvd3Nlci1vd24iLCJleHAiOjE4OTM0NTYwMDAwMDAsInJvIjpmYWxzZX0.YKTUvxiTZMF1qntsiKCawvxUDDzjYqLIgo9u7ovM2yU";
    const READ_ONLY: &str = "eyJzIjoiYnJvd3Nlci1vd24iLCJleHAiOjE4OTM0NTYwMDAwMDAsInJvIjp0cnVlfQ.pjevX1BbOWyWEvjGnL0pHTHEPQGANDz1M_C9oDrj9L8";
    const NOW: u64 = 1_800_000_000_000;

    #[test]
    fn the_test_vector_signs_and_verifies() {
        assert_eq!(sign_payload(KEY, PAYLOAD.as_bytes()), TOKEN);
        let claims = Claims {
            s: "browser-own".into(),
            exp: 1_893_456_000_000,
            ro: false,
            iat: 0,
        };
        // serde writes the fields in declaration order, so this is the same payload byte for byte.
        assert_eq!(sign(KEY, &claims), TOKEN);
        assert_eq!(verify(KEY, "browser-own", TOKEN, NOW), Ok(claims));
        let ro = verify(KEY, "browser-own", READ_ONLY, NOW).unwrap();
        assert!(ro.ro);
    }

    #[test]
    fn a_wrong_key_session_or_time_is_refused() {
        assert_eq!(
            verify(b"another-key", "browser-own", TOKEN, NOW),
            Err(Refused::BadSignature)
        );
        assert_eq!(
            verify(KEY, "browser-other", TOKEN, NOW),
            Err(Refused::OtherSession)
        );
        assert_eq!(
            verify(KEY, "browser-own", TOKEN, 1_893_456_000_000),
            Err(Refused::Expired)
        );
    }

    #[test]
    fn a_tampered_or_garbled_token_is_refused_without_panicking() {
        // The read-only payload under the read-write token's MAC.
        let (ro_payload, _) = READ_ONLY.split_once('.').unwrap();
        let (_, mac) = TOKEN.split_once('.').unwrap();
        assert_eq!(
            verify(KEY, "browser-own", &format!("{ro_payload}.{mac}"), NOW),
            Err(Refused::BadSignature)
        );
        for garbage in [
            "",
            ".",
            "abc",
            "a.b.c",
            "!!!.???",
            &format!("{}.", ro_payload),
        ] {
            assert!(
                verify(KEY, "browser-own", garbage, NOW).is_err(),
                "{garbage}"
            );
        }
        // A valid MAC over something that is not the claims' JSON.
        let odd = sign_payload(KEY, b"[1,2,3]");
        assert_eq!(
            verify(KEY, "browser-own", &odd, NOW),
            Err(Refused::Malformed)
        );
    }
}
