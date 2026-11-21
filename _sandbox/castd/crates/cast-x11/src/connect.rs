//! Connecting to an X display. castd's displays are its own (Xvfb), reached as `$XAUTHORITY` says; a daemon serving a
//! person's session found the session's display and cookie file itself (a systemd user service starts without
//! `DISPLAY` or `XAUTHORITY` in its environment) and names the file with [`set_authority`], which every connection
//! cast-x11 opens after it reads, without the process's environment being changed under its threads.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use x11rb::rust_connection::{DefaultStream, RustConnection};

static AUTHORITY: RwLock<Option<PathBuf>> = RwLock::new(None);

/// The Xauthority file local displays are connected with from now on; None goes back to `$XAUTHORITY`.
pub fn set_authority(path: Option<PathBuf>) {
    *AUTHORITY.write().unwrap_or_else(|e| e.into_inner()) = path;
}

/// The file [`set_authority`] named, if any.
pub fn authority() -> Option<PathBuf> {
    AUTHORITY.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Connects to `display` (None: `$DISPLAY`): a local one with the cookie [`set_authority`]'s file holds for it when a
/// file was named, anything else as x11rb does.
pub fn connect(display: Option<&str>) -> Result<(RustConnection, usize), String> {
    let named = authority();
    let local = display.and_then(local_display);
    let (Some(file), Some((number, screen))) = (named, local) else {
        return RustConnection::connect(display).map_err(|e| e.to_string());
    };
    let socket = format!("/tmp/.X11-unix/X{number}");
    let stream = std::os::unix::net::UnixStream::connect(&socket)
        .map_err(|e| format!("{socket}: {e}"))?;
    let (stream, _) = DefaultStream::from_unix_stream(stream).map_err(|e| e.to_string())?;
    let (name, data) = cookie(&file, number).unwrap_or_default();
    let conn = RustConnection::connect_to_stream_with_auth_info(stream, screen, name, data)
        .map_err(|e| e.to_string())?;
    Ok((conn, screen))
}

/// `:N` or `:N.S` (or `unix:N`): the display and screen numbers of a display on this computer.
pub fn local_display(display: &str) -> Option<(u16, usize)> {
    let rest = display
        .strip_prefix("unix:")
        .or_else(|| display.strip_prefix(':'))?;
    let (number, screen) = match rest.split_once('.') {
        Some((number, screen)) => (number, screen.parse().ok()?),
        None => (rest, 0),
    };
    Some((number.parse().ok()?, screen))
}

/// The MIT-MAGIC-COOKIE-1 an Xauthority file holds for display `number` (an entry of this host's first, else any
/// entry for that number or for every display).
pub fn cookie(file: &Path, number: u16) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut bytes = Vec::new();
    std::fs::File::open(file).ok()?.read_to_end(&mut bytes).ok()?;
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().as_bytes().to_vec())
        .unwrap_or_default();
    let wanted = number.to_string().into_bytes();
    let mut fallback = None;
    for entry in entries(&bytes) {
        if entry.name != b"MIT-MAGIC-COOKIE-1"
            || !(entry.number.is_empty() || entry.number == wanted)
        {
            continue;
        }
        // 256 is FamilyLocal: an entry for this host's local connections.
        if entry.family == 256 && entry.address == host {
            return Some((entry.name.to_vec(), entry.data.to_vec()));
        }
        fallback.get_or_insert((entry.name.to_vec(), entry.data.to_vec()));
    }
    fallback
}

struct Entry<'a> {
    family: u16,
    address: &'a [u8],
    number: &'a [u8],
    name: &'a [u8],
    data: &'a [u8],
}

/// An Xauthority file's entries: a big-endian family, then address, display number, name and data, each a big-endian
/// u16 length and its bytes.
fn entries(bytes: &[u8]) -> Vec<Entry<'_>> {
    let mut out = Vec::new();
    let mut at = 0;
    let u16_at = |at: usize| -> Option<u16> {
        Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
    };
    while let Some(family) = u16_at(at) {
        at += 2;
        let mut fields: [&[u8]; 4] = [&[]; 4];
        for field in &mut fields {
            let Some(len) = u16_at(at) else { return out };
            at += 2;
            let Some(value) = bytes.get(at..at + len as usize) else {
                return out;
            };
            *field = value;
            at += len as usize;
        }
        out.push(Entry {
            family,
            address: fields[0],
            number: fields[1],
            name: fields[2],
            data: fields[3],
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(family: u16, address: &[u8], number: &[u8], name: &[u8], data: &[u8]) -> Vec<u8> {
        let mut out = family.to_be_bytes().to_vec();
        for field in [address, number, name, data] {
            out.extend((field.len() as u16).to_be_bytes());
            out.extend(field);
        }
        out
    }

    #[test]
    fn a_local_display_is_read_with_its_screen() {
        assert_eq!(local_display(":0"), Some((0, 0)));
        assert_eq!(local_display(":12.1"), Some((12, 1)));
        assert_eq!(local_display("unix:3"), Some((3, 0)));
        assert_eq!(local_display("host:0"), None);
        assert_eq!(local_display(":x"), None);
    }

    #[test]
    fn the_cookie_for_a_display_number_is_found_in_an_xauthority_file() {
        let dir = std::env::temp_dir().join(format!("cast-x11-xauth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Xauthority");
        let mut bytes = entry(256, b"otherhost", b"0", b"MIT-MAGIC-COOKIE-1", b"wrong-host");
        bytes.extend(entry(256, b"h", b"1", b"MIT-MAGIC-COOKIE-1", b"display-one"));
        bytes.extend(entry(256, b"h", b"0", b"XDM-AUTHORIZATION-1", b"other-scheme"));
        std::fs::write(&file, &bytes).unwrap();
        assert_eq!(
            cookie(&file, 1),
            Some((b"MIT-MAGIC-COOKIE-1".to_vec(), b"display-one".to_vec()))
        );
        // No entry of this host for :0: the other host's is the fallback, the other scheme never.
        assert_eq!(
            cookie(&file, 0),
            Some((b"MIT-MAGIC-COOKIE-1".to_vec(), b"wrong-host".to_vec()))
        );
        assert_eq!(cookie(&file, 2), None);
        // A truncated file yields what it holds whole.
        std::fs::write(&file, &bytes[..bytes.len() - 3]).unwrap();
        assert!(cookie(&file, 1).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
