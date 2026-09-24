//! The PROXY protocol header a TCP passthrough puts before the connection it hands on (v1 text or v2 binary): the only
//! place the browser's own address survives, since the socket's peer is the proxy. Read to its exact end, so the TLS
//! handshake that follows starts on its first byte.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use tokio::io::{AsyncRead, AsyncReadExt};

const V2_SIGNATURE: [u8; 12] = [
    0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
];

// A v1 line is at most 107 bytes, its CRLF included.
const V1_MAX: usize = 107;

/// The address the connection came from, or `None` for a header that names none (v1 `UNKNOWN`, v2 `LOCAL`, a family
/// other than TCP over IPv4 or IPv6), where the socket's own peer stands.
pub async fn read(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<Option<SocketAddr>> {
    let mut start = [0_u8; 12];
    stream.read_exact(&mut start[..6]).await?;
    if &start[..6] == b"PROXY " {
        return read_v1(stream).await;
    }
    stream.read_exact(&mut start[6..]).await?;
    if start != V2_SIGNATURE {
        return Err(invalid("the connection opens with no PROXY header"));
    }
    let mut fixed = [0_u8; 4];
    stream.read_exact(&mut fixed).await?;
    let [version_command, family, high, low] = fixed;
    if version_command >> 4 != 2 {
        return Err(invalid("a PROXY v2 header of another version"));
    }
    let mut rest = vec![0_u8; usize::from(u16::from_be_bytes([high, low]))];
    stream.read_exact(&mut rest).await?;
    if version_command & 0x0f == 0 {
        return Ok(None);
    }
    let port = |at: usize| u16::from_be_bytes([rest[at], rest[at + 1]]);
    match family {
        0x11 if rest.len() >= 12 => {
            let ip = Ipv4Addr::new(rest[0], rest[1], rest[2], rest[3]);
            Ok(Some(SocketAddr::new(IpAddr::V4(ip), port(8))))
        }
        0x21 if rest.len() >= 36 => {
            let octets: [u8; 16] = rest[..16].try_into().expect("sixteen bytes");
            Ok(Some(SocketAddr::new(
                IpAddr::V6(Ipv6Addr::from(octets)),
                port(32),
            )))
        }
        _ => Ok(None),
    }
}

async fn read_v1(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<Option<SocketAddr>> {
    let mut line = b"PROXY ".to_vec();
    while !line.ends_with(b"\r\n") {
        if line.len() >= V1_MAX {
            return Err(invalid("a PROXY v1 line longer than the protocol allows"));
        }
        line.push(stream.read_u8().await?);
    }
    let text = std::str::from_utf8(&line[..line.len() - 2])
        .map_err(|_| invalid("a PROXY v1 line that is not text"))?;
    let fields: Vec<&str> = text.split(' ').collect();
    match fields.as_slice() {
        ["PROXY", "UNKNOWN", ..] => Ok(None),
        ["PROXY", "TCP4" | "TCP6", source, _, port, _] => {
            let ip: IpAddr = source
                .parse()
                .map_err(|_| invalid("a PROXY v1 source that is not an address"))?;
            let port: u16 = port
                .parse()
                .map_err(|_| invalid("a PROXY v1 source port that is not a port"))?;
            Ok(Some(SocketAddr::new(ip, port)))
        }
        _ => Err(invalid("a PROXY v1 line of no known shape")),
    }
}

fn invalid(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, why)
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncWriteExt;

    use super::*;

    async fn parsed(header: &[u8]) -> (io::Result<Option<SocketAddr>>, Vec<u8>) {
        let (mut near, mut far) = tokio::io::duplex(4096);
        near.write_all(header).await.unwrap();
        near.write_all(b"\x16tls").await.unwrap();
        drop(near);
        let answer = read(&mut far).await;
        let mut rest = Vec::new();
        far.read_to_end(&mut rest).await.unwrap();
        (answer, rest)
    }

    #[tokio::test]
    async fn a_v1_line_names_the_browser_and_leaves_the_handshake_whole() {
        let (answer, rest) = parsed(b"PROXY TCP4 203.0.113.7 10.0.0.1 51234 443\r\n").await;
        assert_eq!(answer.unwrap(), Some("203.0.113.7:51234".parse().unwrap()));
        assert_eq!(rest, b"\x16tls");
        let (answer, _) = parsed(b"PROXY TCP6 2001:db8::7 2001:db8::1 51234 443\r\n").await;
        assert_eq!(
            answer.unwrap(),
            Some("[2001:db8::7]:51234".parse().unwrap())
        );
        let (answer, _) = parsed(b"PROXY UNKNOWN\r\n").await;
        assert_eq!(answer.unwrap(), None);
    }

    #[tokio::test]
    async fn a_v2_header_names_the_browser_and_leaves_the_handshake_whole() {
        let mut header = V2_SIGNATURE.to_vec();
        header.extend_from_slice(&[0x21, 0x11, 0x00, 0x0c]);
        header.extend_from_slice(&[203, 0, 113, 7, 10, 0, 0, 1]);
        header.extend_from_slice(&51234_u16.to_be_bytes());
        header.extend_from_slice(&443_u16.to_be_bytes());
        let (answer, rest) = parsed(&header).await;
        assert_eq!(answer.unwrap(), Some("203.0.113.7:51234".parse().unwrap()));
        assert_eq!(rest, b"\x16tls");

        let mut six = V2_SIGNATURE.to_vec();
        six.extend_from_slice(&[0x21, 0x21, 0x00, 0x24]);
        six.extend_from_slice(&"2001:db8::7".parse::<Ipv6Addr>().unwrap().octets());
        six.extend_from_slice(&"2001:db8::1".parse::<Ipv6Addr>().unwrap().octets());
        six.extend_from_slice(&51234_u16.to_be_bytes());
        six.extend_from_slice(&443_u16.to_be_bytes());
        let (answer, _) = parsed(&six).await;
        assert_eq!(
            answer.unwrap(),
            Some("[2001:db8::7]:51234".parse().unwrap())
        );

        // A health check's LOCAL command names nobody, with any trailing TLVs skipped.
        let mut local = V2_SIGNATURE.to_vec();
        local.extend_from_slice(&[0x20, 0x00, 0x00, 0x03, 1, 2, 3]);
        let (answer, rest) = parsed(&local).await;
        assert_eq!(answer.unwrap(), None);
        assert_eq!(rest, b"\x16tls");
    }

    #[tokio::test]
    async fn a_connection_with_no_header_is_refused() {
        let (answer, _) = parsed(b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03\x00").await;
        assert!(answer.is_err());
        let (answer, _) = parsed(&[b'P'; 200]).await;
        assert!(answer.is_err());
        let (answer, _) = parsed(b"PROXY TCP4 not-an-address 10.0.0.1 1 2\r\n").await;
        assert!(answer.is_err());
    }
}
