use std::io::{Read, Write};

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::hkdf;
use ring::rand::SystemRandom;

use crate::util::{bail, Fail, Result};

/* THE MOVE'S OWN CHANNEL (2026-11-11). One sandbox crosses from one of the owner's computers to another over a single
TCP stream: dialled directly on the LAN, or pumped by the calling sandbox's daemon between two `devices reach` tunnels when
no direct route exists. Either way the bytes pass through things that must not read them (the relay daemon, the LAN), and
the stream carries the sandbox's credentials and at-rest key. No new crate: `ring`, already built for rustls, has all of it.

- Each side makes an EPHEMERAL X25519 key for this move alone. The daemon passes each side the other's public key through
  the two device flows (agents never see them); the hello on the wire must name exactly that key, so a stranger who reaches
  the port is refused before any agreement.
- HKDF-SHA256 over the shared secret, salted with the move id and bound to both public keys, gives one AES-256-GCM key per
  direction, so the target's verdict can never be a replayed source frame.
- Records are framed (u32 length, ≤ 1 MiB of plaintext each) and sealed with a 96-bit nonce that is the record's counter:
  a dropped, repeated or reordered record fails to open. The stream ends with an authenticated END record naming how many
  records came before it; a stream that stops without one is a failure, never a short sandbox.

Rejected: TLS with self-signed certificates (rustls is only built on Windows here, and pinning the certificate is the
same key exchange with more parts); a ticket the daemon mints (it would hold a secret that opens the stream). */

/// What a sealed record holds at most, before its kind byte and tag.
pub const MAX_RECORD: usize = 1 << 20;
const TAG_LEN: usize = 16;
const MAGIC: &[u8; 8] = b"ICMOVE1\n";
/// The longest move id a hello carries.
const MAX_ID: usize = 64;

/// Which end of the move a side is: the source sends the sandbox, the target receives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Source,
    Target,
}

impl Role {
    fn byte(self) -> u8 {
        match self {
            Role::Source => b'S',
            Role::Target => b'T',
        }
    }

    fn other(self) -> Role {
        match self {
            Role::Source => Role::Target,
            Role::Target => Role::Source,
        }
    }
}

/// What a sealed record is. The kind rides inside the sealed plaintext, so it is authenticated with the payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The source's manifest: everything the target needs to make the sandbox again (JSON).
    Manifest,
    /// A section of bytes begins (JSON: what it is).
    Begin,
    /// Bytes of the section in progress.
    Data,
    /// The section ends (JSON: its file list's count and hash, for the target to compare).
    Finish,
    /// A key file's bytes (JSON: which, and the bytes).
    Key,
    /// The target's answer: up, or failed and why (JSON).
    Verdict,
    /// The source has taken the verdict.
    Ack,
    /// The authenticated end of a direction's stream (8 bytes: how many records came before it).
    End,
}

impl Kind {
    fn byte(self) -> u8 {
        match self {
            Kind::Manifest => 1,
            Kind::Begin => 2,
            Kind::Data => 3,
            Kind::Finish => 4,
            Kind::Key => 5,
            Kind::Verdict => 6,
            Kind::Ack => 7,
            Kind::End => 0x7f,
        }
    }

    fn of(byte: u8) -> Option<Kind> {
        Some(match byte {
            1 => Kind::Manifest,
            2 => Kind::Begin,
            3 => Kind::Data,
            4 => Kind::Finish,
            5 => Kind::Key,
            6 => Kind::Verdict,
            7 => Kind::Ack,
            0x7f => Kind::End,
            _ => return None,
        })
    }
}

/// A side's ephemeral key for one move: its public half travels, the private half never leaves this process.
pub struct Keys {
    pub public: [u8; 32],
    private: EphemeralPrivateKey,
}

impl Keys {
    pub fn generate() -> Result<Keys> {
        let private = EphemeralPrivateKey::generate(&X25519, &SystemRandom::new())
            .map_err(|_| Fail("could not make a key for the move.".to_string()))?;
        let public_key = private
            .compute_public_key()
            .map_err(|_| Fail("could not make a key for the move.".to_string()))?;
        let mut public = [0u8; 32];
        public.copy_from_slice(public_key.as_ref());
        Ok(Keys { public, private })
    }
}

/// A public key as it travels in a flow line and a flag: base64url without padding. Pure.
pub fn encode_key(key: &[u8; 32]) -> String {
    crate::util::base64(key)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_")
}

/// The other way round; None for anything that is not 32 bytes of it. Pure.
pub fn decode_key(text: &str) -> Option<[u8; 32]> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let text = text.trim().trim_end_matches('=');
    let mut out = Vec::with_capacity(32);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let c = match c {
            b'+' => b'-',
            b'/' => b'_',
            c => c,
        };
        let value = ALPHABET.iter().position(|&a| a == c)? as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out.try_into().ok()
}

/// The plaintext hello each side sends first: who it is, which move, and its public key. Pure.
pub fn hello(role: Role, move_id: &str, public: &[u8; 32]) -> Vec<u8> {
    let id = move_id.as_bytes();
    let mut out = Vec::with_capacity(MAGIC.len() + 2 + 32 + id.len());
    out.extend_from_slice(MAGIC);
    out.push(role.byte());
    out.extend_from_slice(public);
    out.push(id.len().min(MAX_ID) as u8);
    out.extend_from_slice(&id[..id.len().min(MAX_ID)]);
    out
}

/// Read the other side's hello: refused unless it is the other role, of this move. Answers its public key.
pub fn read_hello(from: &mut impl Read, me: Role, move_id: &str) -> Result<[u8; 32]> {
    let mut head = [0u8; 8 + 1 + 32 + 1];
    from.read_exact(&mut head)
        .map_err(|err| Fail(format!("the other computer sent no greeting ({err}).")))?;
    if &head[..8] != MAGIC {
        bail!("whatever answered is not an ic taking part in a move.");
    }
    if head[8] != me.other().byte() {
        bail!("the other end is not the other side of this move.");
    }
    let mut public = [0u8; 32];
    public.copy_from_slice(&head[9..41]);
    let mut id = vec![0u8; head[41] as usize];
    from.read_exact(&mut id).map_err(|err| {
        Fail(format!(
            "the other computer's greeting was cut short ({err})."
        ))
    })?;
    if id != move_id.as_bytes() {
        bail!("the other end is taking part in a different move.");
    }
    Ok(public)
}

/// One direction's sealing key and its record counter.
pub struct Sealer {
    key: LessSafeKey,
    counter: u64,
}

/// One direction's opening key and the counter it expects next.
pub struct Opener {
    key: LessSafeKey,
    counter: u64,
    ended: bool,
}

/// Both directions of an agreed move, as this side sees them.
pub struct Session {
    pub send: Sealer,
    pub receive: Opener,
}

fn nonce(counter: u64) -> Nonce {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&counter.to_be_bytes());
    Nonce::assume_unique_for_key(bytes)
}

/// The two direction keys of a shared secret, bound to the move id and both public keys. Pure.
fn derive(
    shared: &[u8],
    move_id: &str,
    source: &[u8; 32],
    target: &[u8; 32],
) -> Result<(LessSafeKey, LessSafeKey)> {
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, move_id.as_bytes());
    let prk = salt.extract(shared);
    let key = |label: &[u8]| -> Result<LessSafeKey> {
        let info = [b"intentic-move/v1 ".as_slice(), label, source, target];
        let okm = prk
            .expand(&info, &AES_256_GCM)
            .map_err(|_| Fail("could not derive the move's keys.".to_string()))?;
        Ok(LessSafeKey::new(UnboundKey::from(okm)))
    };
    Ok((key(b"source-to-target")?, key(b"target-to-source")?))
}

/// Agree on the session from this side's keys and the peer's public key (already checked against the one the daemon
/// handed over). Consumes the private key: one agreement per move.
pub fn agree(keys: Keys, peer: &[u8; 32], role: Role, move_id: &str) -> Result<Session> {
    let (source, target) = match role {
        Role::Source => (keys.public, *peer),
        Role::Target => (*peer, keys.public),
    };
    let derived = agreement::agree_ephemeral(
        keys.private,
        &UnparsedPublicKey::new(&X25519, peer),
        |shared| derive(shared, move_id, &source, &target),
    )
    .map_err(|_| Fail("the other computer's key is not a usable key.".to_string()))??;
    let (to_target, to_source) = derived;
    let (send, receive) = match role {
        Role::Source => (to_target, to_source),
        Role::Target => (to_source, to_target),
    };
    Ok(Session {
        send: Sealer {
            key: send,
            counter: 0,
        },
        receive: Opener {
            key: receive,
            counter: 0,
            ended: false,
        },
    })
}

impl Sealer {
    /// One record, framed and sealed, ready to write.
    pub fn seal(&mut self, kind: Kind, payload: &[u8]) -> Result<Vec<u8>> {
        if payload.len() > MAX_RECORD {
            bail!("a record of {} bytes is over the limit.", payload.len());
        }
        let mut sealed = Vec::with_capacity(1 + payload.len() + TAG_LEN);
        sealed.push(kind.byte());
        sealed.extend_from_slice(payload);
        self.key
            .seal_in_place_append_tag(nonce(self.counter), Aad::empty(), &mut sealed)
            .map_err(|_| Fail("could not seal a record.".to_string()))?;
        self.counter += 1;
        let mut record = Vec::with_capacity(4 + sealed.len());
        record.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
        record.extend_from_slice(&sealed);
        Ok(record)
    }

    /// Seal and write one record.
    pub fn send(&mut self, to: &mut impl Write, kind: Kind, payload: &[u8]) -> Result<()> {
        let record = self.seal(kind, payload)?;
        to.write_all(&record).map_err(|err| {
            Fail(format!(
                "the connection to the other computer broke ({err})."
            ))
        })
    }

    /// The authenticated end of this direction.
    pub fn end(&mut self, to: &mut impl Write) -> Result<()> {
        let count = self.counter;
        self.send(to, Kind::End, &count.to_be_bytes())?;
        to.flush().map_err(|err| {
            Fail(format!(
                "the connection to the other computer broke ({err})."
            ))
        })
    }
}

impl Opener {
    /// Read and open the next record. A record that does not open (tampered, reordered, replayed, under another key)
    /// is an error, and so is the stream stopping before its END.
    pub fn next(&mut self, from: &mut impl Read) -> Result<(Kind, Vec<u8>)> {
        if self.ended {
            bail!("the other computer sent more after it said it was done.");
        }
        let mut length = [0u8; 4];
        from.read_exact(&mut length).map_err(|err| {
            Fail(format!(
                "the stream from the other computer stopped before its end ({err})."
            ))
        })?;
        let length = u32::from_be_bytes(length) as usize;
        if !(1 + TAG_LEN..=1 + MAX_RECORD + TAG_LEN).contains(&length) {
            bail!("the other computer sent a record of an impossible size ({length} bytes).");
        }
        let mut sealed = vec![0u8; length];
        from.read_exact(&mut sealed).map_err(|err| {
            Fail(format!(
                "the stream from the other computer stopped inside a record ({err})."
            ))
        })?;
        let opened = self
            .key
            .open_in_place(nonce(self.counter), Aad::empty(), &mut sealed)
            .map_err(|_| {
                Fail("a record from the other computer did not authenticate: the stream was changed, reordered or cut, or it is not the computer this move was set up with.".to_string())
            })?;
        let expected = self.counter;
        self.counter += 1;
        let kind = Kind::of(opened[0]).ok_or_else(|| {
            Fail(format!(
                "the other computer sent a record of unknown kind {}.",
                opened[0]
            ))
        })?;
        let payload = opened[1..].to_vec();
        if kind == Kind::End {
            let said = payload
                .get(..8)
                .and_then(|bytes| bytes.try_into().ok())
                .map(u64::from_be_bytes);
            if said != Some(expected) {
                bail!("the other computer's stream ended with a count that does not match what arrived.");
            }
            self.ended = true;
        }
        Ok((kind, payload))
    }
}

/// Send this side's hello and read the other's: answers the public key the other side says it has, not yet checked.
pub fn greet<S: Read + Write>(
    stream: &mut S,
    public: &[u8; 32],
    role: Role,
    move_id: &str,
) -> Result<[u8; 32]> {
    stream
        .write_all(&hello(role, move_id, public))
        .and_then(|()| stream.flush())
        .map_err(|err| Fail(format!("could not greet the other computer ({err}).")))?;
    read_hello(stream, role, move_id)
}

/// Whether the key a greeting named is the one the daemon handed over, compared in constant time. Pure.
pub fn is_expected(theirs: &[u8; 32], wanted: &[u8; 32]) -> bool {
    theirs
        .iter()
        .zip(wanted)
        .fold(0u8, |differ, (a, b)| differ | (a ^ b))
        == 0
}

/// Exchange hellos over `stream` and agree. `expected` answers the public key the daemon handed this side for its peer,
/// asked only once the peer's hello is in.
pub fn handshake<S: Read + Write>(
    stream: &mut S,
    keys: Keys,
    role: Role,
    move_id: &str,
    expected: impl FnOnce() -> Result<[u8; 32]>,
) -> Result<Session> {
    let theirs = greet(stream, &keys.public, role, move_id)?;
    if !is_expected(&theirs, &expected()?) {
        bail!("the computer that answered is not the one this move was set up with: its key differs from the one handed over. Nothing was sent.");
    }
    agree(keys, &theirs, role, move_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn pair(id: &str) -> (Session, Session) {
        let source = Keys::generate().unwrap();
        let target = Keys::generate().unwrap();
        let (sp, tp) = (source.public, target.public);
        (
            agree(source, &tp, Role::Source, id).unwrap(),
            agree(target, &sp, Role::Target, id).unwrap(),
        )
    }

    #[test]
    fn records_round_trip_in_both_directions_and_end_authenticated() {
        let (mut source, mut target) = pair("m1");
        let mut wire = Vec::new();
        source.send.send(&mut wire, Kind::Manifest, b"{}").unwrap();
        source
            .send
            .send(&mut wire, Kind::Data, &vec![7u8; MAX_RECORD])
            .unwrap();
        source.send.end(&mut wire).unwrap();
        let mut read = Cursor::new(wire);
        assert_eq!(
            target.receive.next(&mut read).unwrap(),
            (Kind::Manifest, b"{}".to_vec())
        );
        let (kind, data) = target.receive.next(&mut read).unwrap();
        assert_eq!((kind, data.len()), (Kind::Data, MAX_RECORD));
        assert_eq!(
            target.receive.next(&mut read).unwrap(),
            (Kind::End, 2u64.to_be_bytes().to_vec())
        );

        let mut back = Vec::new();
        target.send.send(&mut back, Kind::Verdict, b"ok").unwrap();
        assert_eq!(
            source.receive.next(&mut Cursor::new(back)).unwrap(),
            (Kind::Verdict, b"ok".to_vec())
        );
    }

    #[test]
    fn a_changed_byte_is_refused() {
        let (mut source, mut target) = pair("m1");
        let mut wire = source.send.seal(Kind::Data, b"hello").unwrap();
        let last = wire.len() - 1;
        wire[last] ^= 1;
        assert!(target.receive.next(&mut Cursor::new(wire)).is_err());
    }

    #[test]
    fn reordered_and_replayed_records_are_refused() {
        let (mut source, mut target) = pair("m1");
        let first = source.send.seal(Kind::Data, b"one").unwrap();
        let second = source.send.seal(Kind::Data, b"two").unwrap();
        let mut swapped = second.clone();
        swapped.extend_from_slice(&first);
        assert!(target.receive.next(&mut Cursor::new(swapped)).is_err());

        let (mut source, mut target) = pair("m1");
        let first = source.send.seal(Kind::Data, b"one").unwrap();
        let mut twice = first.clone();
        twice.extend_from_slice(&first);
        let mut read = Cursor::new(twice);
        target.receive.next(&mut read).unwrap();
        assert!(target.receive.next(&mut read).is_err());
    }

    #[test]
    fn a_stream_cut_before_its_end_is_a_failure() {
        let (mut source, mut target) = pair("m1");
        let mut wire = Vec::new();
        source.send.send(&mut wire, Kind::Data, b"one").unwrap();
        let mut read = Cursor::new(wire.clone());
        target.receive.next(&mut read).unwrap();
        let error = target.receive.next(&mut read).unwrap_err();
        assert!(error.0.contains("stopped before its end"), "{}", error.0);
        // Cut inside a record.
        let (mut source, mut target) = pair("m1");
        let record = source.send.seal(Kind::Data, b"abcdef").unwrap();
        let cut = record[..record.len() - 3].to_vec();
        assert!(target
            .receive
            .next(&mut Cursor::new(cut))
            .unwrap_err()
            .0
            .contains("inside a record"));
    }

    #[test]
    fn a_dropped_record_makes_the_end_fail() {
        let (mut source, mut target) = pair("m1");
        let _dropped = source.send.seal(Kind::Data, b"one").unwrap();
        let mut wire = Vec::new();
        source.send.end(&mut wire).unwrap();
        // The END was sealed under counter 1, the receiver expects counter 0: it does not open.
        assert!(target.receive.next(&mut Cursor::new(wire)).is_err());
    }

    #[test]
    fn keys_of_another_peer_or_move_do_not_open() {
        let source = Keys::generate().unwrap();
        let target = Keys::generate().unwrap();
        let stranger = Keys::generate().unwrap();
        let (sp, tp) = (source.public, target.public);
        let mut sending = agree(source, &tp, Role::Source, "m1").unwrap();
        // The target agreed with a stranger's key instead of the source's.
        let _ = sp;
        let mut wrong = agree(target, &stranger.public, Role::Target, "m1").unwrap();
        let record = sending.send.seal(Kind::Data, b"secret").unwrap();
        assert!(wrong.receive.next(&mut Cursor::new(record)).is_err());

        let (mut source, _) = pair("m1");
        let (_, mut other_move) = pair("m2");
        let record = source.send.seal(Kind::Data, b"x").unwrap();
        assert!(other_move.receive.next(&mut Cursor::new(record)).is_err());
    }

    #[test]
    fn a_record_does_not_open_in_the_direction_it_was_not_sealed_for() {
        let (mut source, _target) = pair("m1");
        let record = source.send.seal(Kind::Verdict, b"up").unwrap();
        // The source's own receive key is the target-to-source one.
        assert!(source.receive.next(&mut Cursor::new(record)).is_err());
    }

    #[test]
    fn hellos_name_role_move_and_key() {
        let keys = Keys::generate().unwrap();
        let said = hello(Role::Source, "move-1", &keys.public);
        assert_eq!(
            read_hello(&mut Cursor::new(said.clone()), Role::Target, "move-1").unwrap(),
            keys.public
        );
        assert!(read_hello(&mut Cursor::new(said.clone()), Role::Source, "move-1").is_err());
        assert!(read_hello(&mut Cursor::new(said), Role::Target, "move-2").is_err());
        assert!(read_hello(
            &mut Cursor::new(b"GET / HTTP/1.1\r\n\r\n".repeat(4)),
            Role::Target,
            "m"
        )
        .is_err());
    }

    #[test]
    fn a_handshake_with_the_wrong_expected_key_sends_nothing_sealed() {
        use std::net::{TcpListener, TcpStream};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let source = Keys::generate().unwrap();
        let target = Keys::generate().unwrap();
        let stranger = Keys::generate().unwrap().public;
        let target_public = target.public;
        let accepting = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            handshake(&mut stream, target, Role::Target, "m", || Ok(stranger)).map(|_| ())
        });
        let mut stream = TcpStream::connect(address).unwrap();
        let ours = handshake(&mut stream, source, Role::Source, "m", || Ok(target_public));
        assert!(ours.is_ok());
        let theirs = accepting.join().unwrap().unwrap_err();
        assert!(
            theirs.0.contains("not the one this move was set up with"),
            "{}",
            theirs.0
        );
    }

    #[test]
    fn keys_travel_as_base64url() {
        let keys = Keys::generate().unwrap();
        let text = encode_key(&keys.public);
        assert!(!text.contains('=') && !text.contains('+') && !text.contains('/'));
        assert_eq!(decode_key(&text), Some(keys.public));
        assert_eq!(decode_key("abc"), None);
    }
}
