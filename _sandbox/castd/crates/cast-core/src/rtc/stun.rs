//! Just enough STUN (RFC 8489) to route a datagram: whether it is a binding request, and the ufrag of castd's own peer
//! it names. Every viewer's peer shares castd's one UDP port, and a viewer's first packet to it is its ICE check, whose
//! USERNAME is `<castd's ufrag>:<the viewer's ufrag>` (RFC 8445 §7.2.2); everything after that comes from an address
//! already seen. str0m checks the message itself (integrity, fingerprint) once it reaches the right peer.
//!
//! With full ICE (port.rs), also the binding request the port sends a STUN server to learn its server-reflexive
//! address, and the success response that answers it.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

const MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
const HEADER_LEN: usize = 20;
const USERNAME: u16 = 0x0006;
const MAPPED_ADDRESS: u16 = 0x0001;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;

/// A fresh transaction ID: 96 bits from the process's random hasher keys (RFC 8489 wants them random; they need not be
/// secret, only unlikely to repeat).
pub fn transaction_id() -> [u8; 12] {
    use std::hash::{BuildHasher, Hasher};
    let state = std::collections::hash_map::RandomState::new();
    let mut id = [0u8; 12];
    for (i, chunk) in id.chunks_mut(8).enumerate() {
        let mut h = state.build_hasher();
        h.write_usize(i);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos()),
        );
        chunk.copy_from_slice(&h.finish().to_be_bytes()[..chunk.len()]);
    }
    id
}

/// A binding request with no attributes: what a STUN server answers with the address the request came from.
pub fn binding_request(transaction: [u8; 12]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER_LEN);
    packet.extend_from_slice(&BINDING_REQUEST.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet.extend_from_slice(&MAGIC_COOKIE);
    packet.extend_from_slice(&transaction);
    packet
}

/// A binding success response's transaction ID and the address it maps: XOR-MAPPED-ADDRESS, else (an RFC 3489 server)
/// MAPPED-ADDRESS. None for anything else.
pub fn binding_success(packet: &[u8]) -> Option<([u8; 12], SocketAddr)> {
    if packet.len() < HEADER_LEN
        || packet[4..8] != MAGIC_COOKIE
        || u16::from_be_bytes([packet[0], packet[1]]) != BINDING_SUCCESS
    {
        return None;
    }
    let transaction: [u8; 12] = packet[8..20].try_into().ok()?;
    let length = usize::from(u16::from_be_bytes([packet[2], packet[3]]));
    let attributes = packet.get(HEADER_LEN..HEADER_LEN + length)?;
    let (mut xored, mut plain) = (None, None);
    let mut at = 0;
    while at + 4 <= attributes.len() {
        let kind = u16::from_be_bytes([attributes[at], attributes[at + 1]]);
        let len = usize::from(u16::from_be_bytes([attributes[at + 2], attributes[at + 3]]));
        let value = attributes.get(at + 4..at + 4 + len)?;
        match kind {
            XOR_MAPPED_ADDRESS => xored = address(value, Some(&packet[4..20])),
            MAPPED_ADDRESS => plain = address(value, None),
            _ => {}
        }
        at += 4 + len.div_ceil(4) * 4;
    }
    Some((transaction, xored.or(plain)?))
}

/// An address attribute's value: family, port and address, XORed with the magic cookie and transaction (`xor`, the
/// header's bytes 4 to 20) for XOR-MAPPED-ADDRESS.
fn address(value: &[u8], xor: Option<&[u8]>) -> Option<SocketAddr> {
    let family = *value.get(1)?;
    let mask = |i: usize| xor.map_or(0, |x| x[i]);
    let port = u16::from_be_bytes([value.get(2)? ^ mask(0), value.get(3)? ^ mask(1)]);
    let ip = match family {
        0x01 => {
            let b = value.get(4..8)?;
            IpAddr::V4(Ipv4Addr::new(
                b[0] ^ mask(0),
                b[1] ^ mask(1),
                b[2] ^ mask(2),
                b[3] ^ mask(3),
            ))
        }
        0x02 => {
            let b = value.get(4..20)?;
            let mut o = [0u8; 16];
            for (i, v) in o.iter_mut().enumerate() {
                *v = b[i] ^ mask(i);
            }
            IpAddr::V6(Ipv6Addr::from(o))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

/// A binding success response mapping `mapped`, as a STUN server sends it (XOR-MAPPED-ADDRESS): for tests and fakes.
pub fn binding_success_for(transaction: [u8; 12], mapped: SocketAddr) -> Vec<u8> {
    let mut header = Vec::with_capacity(16);
    header.extend_from_slice(&MAGIC_COOKIE);
    header.extend_from_slice(&transaction);
    let mut value = vec![0u8, if mapped.is_ipv4() { 0x01 } else { 0x02 }];
    let port = mapped.port().to_be_bytes();
    value.extend_from_slice(&[port[0] ^ header[0], port[1] ^ header[1]]);
    let ip: Vec<u8> = match mapped.ip() {
        IpAddr::V4(v4) => v4.octets().to_vec(),
        IpAddr::V6(v6) => v6.octets().to_vec(),
    };
    value.extend(ip.iter().enumerate().map(|(i, b)| b ^ header[i]));
    let mut packet = Vec::new();
    packet.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
    packet.extend_from_slice(&((4 + value.len()) as u16).to_be_bytes());
    packet.extend_from_slice(&header);
    packet.extend_from_slice(&XOR_MAPPED_ADDRESS.to_be_bytes());
    packet.extend_from_slice(&(value.len() as u16).to_be_bytes());
    packet.extend_from_slice(&value);
    packet
}

/// A binding request's transaction ID, for a fake STUN server to answer. None for anything else.
pub fn binding_request_id(packet: &[u8]) -> Option<[u8; 12]> {
    (packet.len() >= HEADER_LEN
        && packet[4..8] == MAGIC_COOKIE
        && u16::from_be_bytes([packet[0], packet[1]]) == BINDING_REQUEST)
        .then(|| packet[8..20].try_into().ok())
        .flatten()
}

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
    fn a_stun_servers_answer_maps_the_ports_address() {
        let id = transaction_id();
        assert_ne!(id, transaction_id(), "two transactions with one ID");
        let request = binding_request(id);
        assert_eq!(
            (request.len(), binding_request_id(&request)),
            (20, Some(id))
        );
        // A request names no peer: it is the port's own question.
        assert_eq!(local_ufrag(&request), None);
        for mapped in ["203.0.113.7:61000", "[2001:db8::5]:443"] {
            let mapped: SocketAddr = mapped.parse().unwrap();
            let answer = binding_success_for(id, mapped);
            assert_eq!(binding_success(&answer), Some((id, mapped)));
            assert_eq!(binding_request_id(&answer), None);
        }
        // RFC 5769's sample IPv4 response: XOR-MAPPED-ADDRESS 192.0.2.1:32853 behind SOFTWARE, with integrity and
        // fingerprint after it.
        let sample: [u8; 80] = [
            0x01, 0x01, 0x00, 0x3c, 0x21, 0x12, 0xa4, 0x42, 0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34,
            0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae, 0x80, 0x22, 0x00, 0x0b, 0x74, 0x65, 0x73, 0x74,
            0x20, 0x76, 0x65, 0x63, 0x74, 0x6f, 0x72, 0x20, 0x00, 0x20, 0x00, 0x08, 0x00, 0x01,
            0xa1, 0x47, 0xe1, 0x12, 0xa6, 0x43, 0x00, 0x08, 0x00, 0x14, 0x2b, 0x91, 0xf5, 0x99,
            0xfd, 0x9e, 0x90, 0xc3, 0x8c, 0x74, 0x89, 0xf9, 0x2a, 0xf9, 0xba, 0x53, 0xf0, 0x6b,
            0xe7, 0xd7, 0x80, 0x28, 0x00, 0x04, 0xc0, 0x7d, 0x4c, 0x96,
        ];
        let (tid, addr) = binding_success(&sample).unwrap();
        assert_eq!(addr, "192.0.2.1:32853".parse().unwrap());
        assert_eq!(tid[..4], [0xb7, 0xe7, 0xa7, 0x01]);
        // A request, a cut response, DTLS: no answer.
        assert_eq!(binding_success(&request), None);
        assert_eq!(
            binding_success(&binding_success_for(id, "1.2.3.4:5".parse().unwrap())[..24]),
            None
        );
        assert_eq!(binding_success(&[22u8; 40]), None);
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
