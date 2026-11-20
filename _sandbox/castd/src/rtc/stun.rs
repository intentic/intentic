//! Just enough STUN (RFC 8489) to route a datagram: whether it is a binding request, and the ufrag of castd's own peer
//! it names. Every viewer's peer shares castd's one UDP port, and a viewer's first packet to it is its ICE check, whose
//! USERNAME is `<castd's ufrag>:<the viewer's ufrag>` (RFC 8445 §7.2.2); everything after that comes from an address
//! already seen. str0m checks the message itself (integrity, fingerprint) once it reaches the right peer.

const MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
const HEADER_LEN: usize = 20;
const USERNAME: u16 = 0x0006;
const BINDING_REQUEST: u16 = 0x0001;

/// The local half of a binding request's USERNAME: which of castd's peers the viewer is checking. None for anything
/// that is not a well-formed binding request with one.
pub fn local_ufrag(packet: &[u8]) -> Option<&str> {
    if packet.len() < HEADER_LEN || packet[4..8] != MAGIC_COOKIE {
        return None;
    }
    if u16::from_be_bytes([packet[0], packet[1]]) != BINDING_REQUEST {
        return None;
    }
    let length = usize::from(u16::from_be_bytes([packet[2], packet[3]]));
    let attributes = packet.get(HEADER_LEN..HEADER_LEN + length)?;
    let mut at = 0;
    while at + 4 <= attributes.len() {
        let kind = u16::from_be_bytes([attributes[at], attributes[at + 1]]);
        let len = usize::from(u16::from_be_bytes([attributes[at + 2], attributes[at + 3]]));
        let value = attributes.get(at + 4..at + 4 + len)?;
        if kind == USERNAME {
            let username = std::str::from_utf8(value).ok()?;
            let (local, _) = username.split_once(':')?;
            return valid_ufrag(local).then_some(local);
        }
        // Each attribute is padded to four bytes.
        at += 4 + len.div_ceil(4) * 4;
    }
    None
}

/// What castd accepts as one of its own ufrags: ICE's characters (RFC 8839 `ice-char`), 4 to 256 of them.
pub fn valid_ufrag(ufrag: &str) -> bool {
    (4..=256).contains(&ufrag.len())
        && ufrag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    // A binding request as a browser sends it: a USERNAME, then attributes str0m reads and this does not.
    fn request(username: &str) -> Vec<u8> {
        let mut attributes = Vec::new();
        attributes.extend_from_slice(&0x0024u16.to_be_bytes()); // PRIORITY
        attributes.extend_from_slice(&4u16.to_be_bytes());
        attributes.extend_from_slice(&[0, 0, 0, 1]);
        attributes.extend_from_slice(&USERNAME.to_be_bytes());
        attributes.extend_from_slice(&(username.len() as u16).to_be_bytes());
        attributes.extend_from_slice(username.as_bytes());
        attributes.resize(attributes.len().div_ceil(4) * 4, 0);
        let mut packet = Vec::new();
        packet.extend_from_slice(&BINDING_REQUEST.to_be_bytes());
        packet.extend_from_slice(&(attributes.len() as u16).to_be_bytes());
        packet.extend_from_slice(&MAGIC_COOKIE);
        packet.extend_from_slice(&[7; 12]);
        packet.extend_from_slice(&attributes);
        packet
    }

    #[test]
    fn a_binding_request_names_the_peer_it_checks() {
        assert_eq!(
            local_ufrag(&request("Ab3+/xyz:remoteFrag")),
            Some("Ab3+/xyz")
        );
        // Padding after an odd-length USERNAME is not part of it.
        assert_eq!(local_ufrag(&request("abcde:f")), Some("abcde"));
    }

    #[test]
    fn anything_else_names_no_peer() {
        assert_eq!(local_ufrag(&[]), None);
        // A binding response, a request with no USERNAME, a ufrag that is no ICE ufrag, DTLS.
        let mut response = request("abcd:efgh");
        response[1] = 0x01;
        response[0] = 0x01;
        assert_eq!(local_ufrag(&response), None);
        assert_eq!(local_ufrag(&request("no-colon")), None);
        assert_eq!(local_ufrag(&request("../x:y")), None);
        assert_eq!(local_ufrag(&request("abc:y")), None);
        let mut dtls = vec![22u8, 254, 253];
        dtls.resize(40, 0);
        assert_eq!(local_ufrag(&dtls), None);
        // A length that runs past the packet.
        let mut cut = request("abcd:efgh");
        cut.truncate(30);
        assert_eq!(local_ufrag(&cut), None);
    }
}
