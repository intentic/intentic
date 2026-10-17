//! sway's IPC (i3's framing) over its Unix socket: run a command list, read the tree or the workspaces, and subscribe to
//! events. The few messages Intentic OS's desktop needs, shared by `ic` and the desktop app (README.md says why).
#![cfg(unix)]

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

const MAGIC: &[u8; 6] = b"i3-ipc";
const MAX_PAYLOAD: usize = 16 * 1024 * 1024;
/// A request answers from sway's memory; past this the session is gone or wedged.
const REPLY_LIMIT: Duration = Duration::from_secs(3);

/// The message types sent. i3's numbering, which sway keeps.
pub const RUN_COMMAND: u32 = 0;
pub const GET_WORKSPACES: u32 = 1;
pub const SUBSCRIBE: u32 = 2;
pub const GET_TREE: u32 = 4;
pub const GET_VERSION: u32 = 7;

/// The event types received on a subscription: the high bit set over the event's number.
pub const EVENT_WORKSPACE: u32 = 0x8000_0000;
pub const EVENT_WINDOW: u32 = 0x8000_0003;
pub const EVENT_BINDING: u32 = 0x8000_0005;

pub fn write_frame(out: &mut impl Write, kind: u32, payload: &[u8]) -> io::Result<()> {
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

/// One frame: its type and its JSON. The length is checked before the payload is allocated.
pub fn read_frame(input: &mut impl Read) -> io::Result<(u32, Value)> {
    let mut header = [0; 14];
    input.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header[6..10].try_into().expect("four bytes")) as usize;
    if &header[..6] != MAGIC || length > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid compositor IPC frame",
        ));
    }
    let kind = u32::from_le_bytes(header[10..14].try_into().expect("four bytes"));
    let mut payload = vec![0; length];
    input.read_exact(&mut payload)?;
    let value = serde_json::from_slice(&payload)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    Ok((kind, value))
}

fn connect(socket: &Path) -> io::Result<UnixStream> {
    let stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(REPLY_LIMIT))?;
    stream.set_write_timeout(Some(REPLY_LIMIT))?;
    Ok(stream)
}

/// One request and its reply, on a connection of its own.
pub fn request(socket: &Path, kind: u32, payload: &str) -> io::Result<Value> {
    let mut stream = connect(socket)?;
    write_frame(&mut stream, kind, payload.as_bytes())?;
    let (reply, value) = read_frame(&mut stream)?;
    if reply != kind {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Unexpected compositor reply",
        ));
    }
    Ok(value)
}

/// Whether every command of a run succeeded, from sway's reply to it. Pure.
pub fn succeeded(reply: &Value) -> bool {
    reply
        .as_array()
        .is_some_and(|rows| rows.iter().all(|row| row["success"] == true))
}

/// A command list (`;`-separated), Err unless sway ran every one.
pub fn command(socket: &Path, commands: &str) -> io::Result<()> {
    if succeeded(&request(socket, RUN_COMMAND, commands)?) {
        Ok(())
    } else {
        Err(io::Error::other("The compositor refused the command"))
    }
}

/// A connection receiving `events` (`window`, `workspace`, `binding`, …) until it closes. Its reads wait as long as it
/// takes: an event stream is quiet for as long as nothing happens on the screen.
pub fn subscribe(socket: &Path, events: &[&str]) -> io::Result<UnixStream> {
    let mut stream = connect(socket)?;
    let names = serde_json::to_string(events).map_err(io::Error::other)?;
    write_frame(&mut stream, SUBSCRIBE, names.as_bytes())?;
    let (kind, answer) = read_frame(&mut stream)?;
    if kind != SUBSCRIBE || answer["success"] != true {
        return Err(io::Error::other("The compositor refused events"));
    }
    stream.set_read_timeout(None)?;
    Ok(stream)
}

/// Whether a `GET_VERSION` answer is at least `major.minor`. An answer without the numbers is not. Pure.
pub fn at_least(version: &Value, major: u64, minor: u64) -> bool {
    match (version["major"].as_u64(), version["minor"].as_u64()) {
        (Some(have_major), Some(have_minor)) => (have_major, have_minor) >= (major, minor),
        _ => false,
    }
}

/// Every window in a tree from `GET_TREE`, tiled and floating, at any depth, in the tree's order. A window is a
/// container with a client behind it (a `pid`); the splits that hold windows have none. Pure.
pub fn windows(tree: &Value) -> Vec<&Value> {
    fn collect<'a>(node: &'a Value, found: &mut Vec<&'a Value>) {
        if matches!(node["type"].as_str(), Some("con" | "floating_con")) && node["pid"].is_number()
        {
            found.push(node);
        }
        for key in ["nodes", "floating_nodes"] {
            for child in node[key].as_array().into_iter().flatten() {
                collect(child, found);
            }
        }
    }
    let mut found = Vec::new();
    collect(tree, &mut found);
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_have_little_endian_lengths_and_types() {
        let mut frame = Vec::new();
        write_frame(&mut frame, 0x8000_0005, br#"{"change":"run"}"#).unwrap();
        assert_eq!(&frame[..14], b"i3-ipc\x10\0\0\0\x05\0\0\x80");
        assert_eq!(
            read_frame(&mut frame.as_slice()).unwrap(),
            (0x8000_0005, json!({"change":"run"}))
        );
    }

    #[test]
    fn refuses_wrong_magic_truncation_and_unbounded_allocations() {
        assert!(read_frame(&mut b"xxxxxx\0\0\0\0\0\0\0\0".as_slice()).is_err());
        assert!(read_frame(&mut b"i3-ipc\xff\xff\xff\x7f\0\0\0\0".as_slice()).is_err());
        assert!(read_frame(&mut b"i3-ipc\x10\0\0\0\0\0\0\0{}".as_slice()).is_err());
    }

    #[test]
    fn a_command_run_succeeds_only_when_every_command_did() {
        assert!(succeeded(&json!([{"success":true},{"success":true}])));
        assert!(!succeeded(
            &json!([{"success":true},{"success":false,"error":"No matching node"}])
        ));
        assert!(!succeeded(&json!({"success":true})));
    }

    #[test]
    fn versions_compare_by_major_then_minor() {
        assert!(at_least(&json!({"major":1,"minor":11,"patch":0}), 1, 11));
        assert!(at_least(&json!({"major":2,"minor":0}), 1, 11));
        assert!(!at_least(&json!({"major":1,"minor":10,"patch":9}), 1, 11));
        assert!(!at_least(&json!({"human_readable":"1.11"}), 1, 11));
    }

    #[test]
    fn windows_are_found_tiled_and_floating_at_any_depth_but_never_containers() {
        let tree = json!({"type":"root","nodes":[{"type":"output","nodes":[{"type":"workspace",
            "nodes":[{"type":"con","id":2,"pid":10},{"type":"con","id":3,"nodes":[{"type":"con","id":4,"pid":11}]}],
            "floating_nodes":[{"type":"floating_con","id":5,"pid":12}]}]}]});
        let ids: Vec<i64> = windows(&tree)
            .iter()
            .map(|w| w["id"].as_i64().unwrap())
            .collect();
        assert_eq!(ids, vec![2, 4, 5]);
    }

    #[test]
    fn a_request_and_a_subscription_speak_to_a_real_socket() {
        use std::os::unix::net::UnixListener;
        let dir = std::env::temp_dir().join(format!("sway-ipc-test-{}", std::process::id()));
        let _ = std::fs::create_dir(&dir);
        let path = dir.join("sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        // What sway receives: a request's payload is a command list or an event list, not always JSON.
        let read_request = |stream: &mut std::os::unix::net::UnixStream| {
            let mut header = [0; 14];
            stream.read_exact(&mut header).unwrap();
            assert_eq!(&header[..6], MAGIC);
            let length = u32::from_le_bytes(header[6..10].try_into().unwrap()) as usize;
            let mut payload = vec![0; length];
            stream.read_exact(&mut payload).unwrap();
            (
                u32::from_le_bytes(header[10..14].try_into().unwrap()),
                String::from_utf8(payload).unwrap(),
            )
        };
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let (kind, payload) = read_request(&mut stream);
                match kind {
                    RUN_COMMAND => {
                        assert_eq!(payload, "nop");
                        write_frame(&mut stream, RUN_COMMAND, br#"[{"success":true}]"#).unwrap();
                    }
                    SUBSCRIBE => {
                        assert_eq!(payload, r#"["window"]"#);
                        write_frame(&mut stream, SUBSCRIBE, br#"{"success":true}"#).unwrap();
                        write_frame(&mut stream, EVENT_WINDOW, br#"{"change":"new"}"#).unwrap();
                    }
                    _ => unreachable!(),
                }
            }
        });
        command(&path, "nop").unwrap();
        let mut events = subscribe(&path, &["window"]).unwrap();
        assert_eq!(
            read_frame(&mut events).unwrap(),
            (EVENT_WINDOW, json!({"change":"new"}))
        );
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
