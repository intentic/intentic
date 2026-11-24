use ring::{aead, hkdf};
use serde_json::{json, Value};

use crate::sandbox::at_rest;
use crate::util::{bail, Fail, Result};

/* THE AT-REST KEY TRAVELS INSIDE THE BACKUP (2026-11-11).

A backup holds the sandbox's credential stores encrypted with its at-rest key (at_rest.rs), and until now not that key:
restoring on another machine meant copying the repository, the backup key AND `~/.intentic/keys/at-rest-<slug>.key` by
hand, and keeping the slug. Every backup now carries the at-rest key too, sealed under a key derived from the backup's own
password, so the repository and its password are the whole of what a restore needs. Nothing new is trusted: whoever holds
the backup password can already read every file in the repository, and the sealed key opens only what they can read.
The owner's chosen scope: the key travels in backups and in moves, never to the platform or anyone's keyring.

How it rides: as one file in the same snapshot, `/src/ic/at-rest-key.sealed.json`, written by the restic worker into its
own throwaway filesystem just before `restic backup` reads it. That is the least surprising place restic offers: it is
deduplicated, forgotten and pruned with the snapshot it belongs to, `restic ls` shows it, `restic dump <snapshot>
/src/ic/at-rest-key.sealed.json` reads it, and a snapshot from before it simply lacks the file. (A second `--stdin`
snapshot would be pruned on its own schedule and could outlive or predate the files it opens; a repository-level file
outside restic's format would be one restic itself knows nothing about.) The plaintext key is never written anywhere but
`~/.intentic/keys`, and it is sealed in memory here.

Sealing: HKDF-SHA256 over the backup password (as restic reads it: the password file, trimmed) with the fixed info
SEAL_INFO gives an AES-256-GCM key; a fresh random 96-bit nonce per seal; the key id rides beside it as the AEAD's
additional data, so a sealed file whose id was edited does not open. The key file's bytes are sealed exactly as they are
(raw, hex or base64), so what a restore writes back is the file the daemon read. */

/// Where the sealed key sits in a snapshot (the restic worker's own filesystem, beside the volumes it mounts at /src).
pub const SEALED_DIR: &str = "/src/ic";
pub const SEALED_FILE: &str = "/src/ic/at-rest-key.sealed.json";
const SEAL_INFO: &[u8] = b"intentic-backup-at-rest-v1";
const VERSION: u64 = 1;
const NONCE_LEN: usize = 12;

/// An at-rest key brought out of a backup: the key file's bytes and the id the daemon knows it by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Carried {
    pub content: Vec<u8>,
    pub key_id: String,
}

/// The password restic reads off a password file: the file, trimmed of the whitespace around it.
pub fn password_of(file: &[u8]) -> &[u8] {
    let start = file
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(file.len());
    let end = file
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map_or(start, |at| at + 1);
    &file[start..end]
}

fn sealing_key(password: &[u8]) -> aead::LessSafeKey {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &[]).extract(password);
    let okm = prk
        .expand(&[SEAL_INFO], &aead::AES_256_GCM)
        .expect("32 bytes is within HKDF-SHA256's output");
    aead::LessSafeKey::new(okm.into())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok())
        .collect()
}

/// The sealed form of the at-rest key file `key_content`, under the backup password: `{v, keyId, nonce, ciphertext}`.
/// Refused for what the daemon would not read as a key, which nothing should be sealed as.
pub fn seal(password: &[u8], key_content: &[u8]) -> Result<Value> {
    let Some(key_id) = at_rest::key_id_of(key_content) else {
        bail!("the at-rest key file is not a key the daemon reads (32 bytes, 64 hex digits or base64 of 32 bytes)");
    };
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce)
        .map_err(|err| Fail(format!("the operating system gave no random bytes ({err})")))?;
    let mut sealed = key_content.to_vec();
    sealing_key(password)
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(key_id.as_bytes()),
            &mut sealed,
        )
        .map_err(|_| Fail("the at-rest key could not be sealed".to_string()))?;
    Ok(json!({
        "v": VERSION,
        "keyId": key_id,
        "nonce": hex(&nonce),
        "ciphertext": hex(&sealed),
    }))
}

/// The at-rest key out of its sealed form. Refused for another password, an edited file, or a version this ic does not
/// know; the id is checked against the key that came out.
pub fn unseal(password: &[u8], sealed: &Value) -> Result<Carried> {
    if sealed["v"].as_u64() != Some(VERSION) {
        bail!("the sealed at-rest key is of a version this ic does not read; update ic");
    }
    let (Some(key_id), Some(nonce), Some(mut data)) = (
        sealed["keyId"].as_str(),
        sealed["nonce"].as_str().and_then(unhex),
        sealed["ciphertext"].as_str().and_then(unhex),
    ) else {
        bail!("the sealed at-rest key is not whole");
    };
    let Ok(nonce) = <[u8; NONCE_LEN]>::try_from(nonce.as_slice()) else {
        bail!("the sealed at-rest key is not whole");
    };
    let content = sealing_key(password)
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(key_id.as_bytes()),
            &mut data,
        )
        .map_err(|_| {
            Fail("the sealed at-rest key does not open with this backup's password".to_string())
        })?
        .to_vec();
    if at_rest::key_id_of(&content).as_deref() != Some(key_id) {
        bail!("the sealed at-rest key is not the key it names");
    }
    Ok(Carried {
        content,
        key_id: key_id.to_string(),
    })
}

/// What the sandbox a backup is restored into mounts as its at-rest key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetKey {
    /// No key at all: its daemon encrypts nothing and could read no encrypted store.
    None,
    /// A key file this machine read, by its id.
    Known(String),
    /// A key this machine cannot read (a volume, a file out of its sight).
    Unknown,
}

/// What a restore into a sandbox does about the credential stores in the backup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyPlan {
    /// They open with the key the target mounts already: written as they are.
    AsIs,
    /// No key came with the backup and the target is another sandbox: they stay out, and it keeps its own (the only
    /// answer before keys travelled, kept for backups taken before).
    Exclude,
    /// The carried key is mounted as the target's PREVIOUS key (at_rest.rs), by a recreate before the files are
    /// written: its daemon reads them with it at boot and re-encrypts them under its own key.
    Previous,
    /// The same sandbox, mounting no key: the carried key is written back as its own, and a recreate mounts it.
    Mount,
}

/// The rule, pure over what a restore knows: whether the backup is of the sandbox it is restored into, the key that came
/// with it, what the target mounts, and (the same sandbox only) the id of ic's own key file for it, if one is there. A
/// previous key the daemon never needs costs nothing: it is tried only for a store whose id it carries.
pub fn plan(same: bool, carried: Option<&str>, target: &TargetKey, own: Option<&str>) -> KeyPlan {
    let Some(carried) = carried else {
        return if same {
            KeyPlan::AsIs
        } else {
            KeyPlan::Exclude
        };
    };
    match target {
        TargetKey::Known(id) if id == carried => KeyPlan::AsIs,
        TargetKey::Known(_) | TargetKey::Unknown => KeyPlan::Previous,
        // Another sandbox with no key could only be handed the carried key as its own, another sandbox's.
        TargetKey::None if !same => KeyPlan::Exclude,
        // ic's own key for it is another key: the recreate mounts that one, and the carried one beside it.
        TargetKey::None => match own {
            Some(own) if own != carried => KeyPlan::Previous,
            _ => KeyPlan::Mount,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [9u8; 32];

    #[test]
    fn a_sealed_key_opens_with_the_backup_password_and_carries_its_id() {
        let sealed = seal(b"0123abcd", &KEY).unwrap();
        assert_eq!(sealed["v"], 1);
        let id = at_rest::key_id_of(&KEY).unwrap();
        assert_eq!(sealed["keyId"], id.as_str());
        // The key is nowhere in what is stored.
        assert!(!sealed.to_string().contains(&hex(&KEY)));
        let carried = unseal(b"0123abcd", &sealed).unwrap();
        assert_eq!(carried.content, KEY.to_vec());
        assert_eq!(carried.key_id, id);
        // A fresh nonce each time.
        assert_ne!(seal(b"0123abcd", &KEY).unwrap()["nonce"], sealed["nonce"]);
    }

    #[test]
    fn a_sealed_key_refuses_another_password_and_an_edited_id() {
        let sealed = seal(b"right", &KEY).unwrap();
        assert!(unseal(b"wrong", &sealed)
            .unwrap_err()
            .0
            .contains("does not open"));
        let mut edited = sealed.clone();
        edited["keyId"] = json!("0000000000000000");
        assert!(unseal(b"right", &edited).is_err());
        let mut torn = sealed.clone();
        torn["ciphertext"] = json!("zz");
        assert!(unseal(b"right", &torn).is_err());
        let mut later = sealed;
        later["v"] = json!(2);
        assert!(unseal(b"right", &later).unwrap_err().0.contains("version"));
    }

    #[test]
    fn a_key_file_is_sealed_as_it_is_spelled() {
        let hex_key = format!("{}\n", hex(&KEY));
        let carried = unseal(b"p", &seal(b"p", hex_key.as_bytes()).unwrap()).unwrap();
        assert_eq!(carried.content, hex_key.as_bytes());
        assert_eq!(carried.key_id, at_rest::key_id_of(&KEY).unwrap());
        assert!(seal(b"p", b"not a key").is_err());
    }

    #[test]
    fn the_password_is_read_as_restic_reads_its_file() {
        assert_eq!(password_of(b"abc\n"), b"abc");
        assert_eq!(password_of(b"  abc\r\n"), b"abc");
        assert_eq!(password_of(b"\n"), b"");
    }

    #[test]
    fn a_restore_into_the_same_sandbox_writes_the_stores_and_mounts_the_key_it_lacks() {
        let known = |id: &str| TargetKey::Known(id.to_string());
        // A backup from before keys travelled restores into its own sandbox as it always did.
        assert_eq!(plan(true, None, &known("a"), None), KeyPlan::AsIs);
        assert_eq!(plan(true, Some("a"), &known("a"), Some("a")), KeyPlan::AsIs);
        // The sandbox now mounts another key (set up again on a new machine): the carried one rotates away.
        assert_eq!(
            plan(true, Some("a"), &known("b"), Some("b")),
            KeyPlan::Previous
        );
        assert_eq!(
            plan(true, Some("a"), &TargetKey::Unknown, None),
            KeyPlan::Previous
        );
        // No key mounted: the carried key becomes its own again, unless ic holds another one for it.
        assert_eq!(
            plan(true, Some("a"), &TargetKey::None, None),
            KeyPlan::Mount
        );
        assert_eq!(
            plan(true, Some("a"), &TargetKey::None, Some("a")),
            KeyPlan::Mount
        );
        assert_eq!(
            plan(true, Some("a"), &TargetKey::None, Some("b")),
            KeyPlan::Previous
        );
    }

    #[test]
    fn a_restore_into_another_sandbox_rotates_the_carried_key_and_excludes_only_without_one() {
        let known = |id: &str| TargetKey::Known(id.to_string());
        assert_eq!(plan(false, Some("a"), &known("b"), None), KeyPlan::Previous);
        assert_eq!(
            plan(false, Some("a"), &TargetKey::Unknown, None),
            KeyPlan::Previous
        );
        // Two sandboxes sharing one key (a shared logins volume): nothing to rotate.
        assert_eq!(plan(false, Some("a"), &known("a"), None), KeyPlan::AsIs);
        // No key came with it, or the target can hold none: the stores stay out, as before.
        assert_eq!(plan(false, None, &known("b"), None), KeyPlan::Exclude);
        assert_eq!(
            plan(false, Some("a"), &TargetKey::None, None),
            KeyPlan::Exclude
        );
    }
}
