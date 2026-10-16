//! The fixed i3 IPC framing over a local Unix socket. Only command, tree, workspaces and subscribe are needed,
//! so std::os::unix suffices; an IPC crate would add its own event model and runtime for these four messages.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde_json::Value;

const MAGIC: &[u8; 6] = b"i3-ipc";
const MAX_PAYLOAD: usize = 16 * 1024 * 1024;

fn write_frame(out: &mut impl Write, kind: u32, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "IPC frame too large",
        ));
    }
    out.write_all(MAGIC)?;
    out.write_all(&(payload.len() as u32).to_le_bytes())?;
    out.write_all(&kind.to_le_bytes())?;
    out.write_all(payload)
}

pub(super) fn read_frame(input: &mut impl Read) -> io::Result<(u32, Value)> {
    let mut header = [0; 14];
    input.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header[6..10].try_into().unwrap()) as usize;
    if &header[..6] != MAGIC || length > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid compositor IPC frame",
        ));
    }
    let kind = u32::from_le_bytes(header[10..14].try_into().unwrap());
    let mut payload = vec![0; length];
    input.read_exact(&mut payload)?;
    let value = serde_json::from_slice(&payload)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    Ok((kind, value))
}

fn connect() -> io::Result<UnixStream> {
    let path = std::env::var_os("SWAYSOCK")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "No desktop session"))?;
    let socket = UnixStream::connect(path)?;
    socket.set_read_timeout(Some(Duration::from_secs(3)))?;
    socket.set_write_timeout(Some(Duration::from_secs(3)))?;
    Ok(socket)
}

pub(super) fn request(kind: u32, payload: &str) -> io::Result<Value> {
    let mut socket = connect()?;
    write_frame(&mut socket, kind, payload.as_bytes())?;
    let (reply, value) = read_frame(&mut socket)?;
    if reply != kind {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Unexpected compositor reply",
        ));
    }
    Ok(value)
}

pub(super) fn command(command: &str) -> io::Result<()> {
    let answer = request(0, command)?;
    if answer
        .as_array()
        .is_some_and(|rows| rows.iter().all(|row| row["success"] == true))
    {
        Ok(())
    } else {
        Err(io::Error::other("The compositor refused the window move"))
    }
}

pub(super) fn subscribe() -> io::Result<UnixStream> {
    let mut socket = connect()?;
    write_frame(&mut socket, 2, br#"["binding","window","workspace"]"#)?;
    let (kind, answer) = read_frame(&mut socket)?;
    if kind != 2 || answer["success"] != true {
        return Err(io::Error::other("The compositor refused events"));
    }
    // Event reads keep their partial header and payload until complete; reconnect only on EOF or an actual error.
    socket.set_read_timeout(None)?;
    Ok(socket)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_have_little_endian_lengths_and_types() {
        let mut frame = Vec::new();
        write_frame(&mut frame, 0x8000_0005, br#"{"change":"run"}"#).unwrap();
        assert_eq!(&frame[..14], b"i3-ipc\x10\0\0\0\x05\0\0\x80");
        assert_eq!(
            read_frame(&mut frame.as_slice()).unwrap(),
            (0x8000_0005, serde_json::json!({"change":"run"}))
        );
    }

    #[test]
    fn refuses_wrong_magic_truncation_and_unbounded_allocations() {
        assert!(read_frame(&mut b"xxxxxx\0\0\0\0\0\0\0\0".as_slice()).is_err());
        assert!(read_frame(&mut b"i3-ipc\xff\xff\xff\x7f\0\0\0\0".as_slice()).is_err());
        assert!(read_frame(&mut b"i3-ipc\x10\0\0\0\0\0\0\0{}".as_slice()).is_err());
    }
}
