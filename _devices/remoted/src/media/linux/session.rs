//! Finding the person's graphical session from outside it. remoted is started by the machine agent, often as a systemd
//! service or at boot, with neither `DISPLAY` nor `XAUTHORITY` in its environment: the session's own processes carry
//! both (and `WAYLAND_DISPLAY` on a Wayland session), and a process of the same user may read another's environment.
//! Root reads every user's, which is how an agent running as root finds the seat's session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// What a session's processes say about where it draws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// The X display (`:0`), the session's own on X11, Xwayland's on Wayland.
    pub display: Option<String>,
    /// The cookie file that display takes.
    pub authority: Option<PathBuf>,
    /// The Wayland socket's name (`wayland-0`) on a Wayland session.
    pub wayland: Option<String>,
    /// The session's own word for itself: `x11`, `wayland`, `tty`.
    pub kind: Option<String>,
    /// The desktop (`XDG_CURRENT_DESKTOP`): `GNOME`, `KDE`, `XFCE`.
    pub desktop: Option<String>,
    pub runtime_dir: Option<String>,
    pub bus: Option<String>,
    pub uid: u32,
    /// How many of the session's processes said the same: the most said wins.
    pub votes: usize,
}

impl Found {
    pub fn is_wayland(&self) -> bool {
        self.wayland.is_some() || self.kind.as_deref() == Some("wayland")
    }
}

const KEYS: &[&str] = &[
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
];

/// The session most of the readable processes belong to, leaving out displays in `skip` (a virtual desktop remoted
/// started itself). Processes of this user only, unless remoted runs as root, which looks at everyone's and prefers a
/// session on a seat's display.
pub fn find(skip: &[String]) -> Option<Found> {
    let own = unsafe { libc::geteuid() };
    let mut tally: HashMap<(Option<String>, Option<String>, u32), Found> = HashMap::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return None;
    };
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().filter(|n| n.bytes().all(|b| b.is_ascii_digit())) else {
            continue;
        };
        let Some(uid) = owner(&entry.path()) else {
            continue;
        };
        if own != 0 && uid != own {
            continue;
        }
        if pid == std::process::id().to_string() {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path().join("environ")) else {
            continue;
        };
        let env = parse(&bytes);
        let display = env.get("DISPLAY").cloned();
        let wayland = env.get("WAYLAND_DISPLAY").cloned();
        if display.is_none() && wayland.is_none() {
            continue;
        }
        if display.as_ref().is_some_and(|d| skip.contains(d)) {
            continue;
        }
        let key = (display.clone(), wayland.clone(), uid);
        let held = tally.entry(key).or_insert_with(|| Found {
            display,
            authority: None,
            wayland,
            kind: None,
            desktop: None,
            runtime_dir: None,
            bus: None,
            uid,
            votes: 0,
        });
        held.votes += 1;
        // The first process that names each is as good as any: they all inherited the session's.
        if held.authority.is_none() {
            held.authority = env.get("XAUTHORITY").map(PathBuf::from);
        }
        if held.kind.is_none() {
            held.kind = env.get("XDG_SESSION_TYPE").cloned();
        }
        if held.desktop.is_none() {
            held.desktop = env.get("XDG_CURRENT_DESKTOP").cloned();
        }
        if held.runtime_dir.is_none() {
            held.runtime_dir = env.get("XDG_RUNTIME_DIR").cloned();
        }
        if held.bus.is_none() {
            held.bus = env.get("DBUS_SESSION_BUS_ADDRESS").cloned();
        }
    }
    let mut found: Vec<Found> = tally
        .into_values()
        .filter(|f| f.display.as_deref().is_none_or(display_exists) || f.wayland.is_some())
        .collect();
    // A Wayland session's processes all name its socket; an X session's its display. The busiest session is the one
    // the person is in; a seat display (:0) wins a tie over a nested or remote one.
    found.sort_by_key(|f| {
        (
            std::cmp::Reverse(f.votes),
            f.display.as_deref() != Some(":0"),
        )
    });
    let mut best = found.into_iter().next()?;
    if best.authority.is_none() {
        best.authority = default_authority(&best);
    }
    Some(best)
}

/// Where a session's cookie file is when its processes do not say: GDM's, then the home's.
fn default_authority(found: &Found) -> Option<PathBuf> {
    let runtime = found
        .runtime_dir
        .clone()
        .unwrap_or_else(|| format!("/run/user/{}", found.uid));
    let gdm = PathBuf::from(&runtime).join("gdm/Xauthority");
    if gdm.exists() {
        return Some(gdm);
    }
    home_of(found.uid)
        .map(|home| home.join(".Xauthority"))
        .filter(|p| p.exists())
}

/// A user's home, from the password database.
pub fn home_of(uid: u32) -> Option<PathBuf> {
    let text = std::fs::read_to_string("/etc/passwd").ok()?;
    text.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        let home = fields.get(5)?;
        (fields.get(2)?.parse::<u32>().ok()? == uid).then(|| PathBuf::from(home))
    })
}

/// Whether a local display's socket is there.
pub fn display_exists(display: &str) -> bool {
    cast_x11::connect::local_display(display)
        .is_some_and(|(n, _)| Path::new(&format!("/tmp/.X11-unix/X{n}")).exists())
}

fn owner(proc_dir: &Path) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(proc_dir).ok().map(|m| m.uid())
}

/// A process's environment block: `KEY=value` pairs separated by NULs, the keys remoted cares about.
pub fn parse(bytes: &[u8]) -> HashMap<String, String> {
    bytes
        .split(|b| *b == 0)
        .filter_map(|pair| std::str::from_utf8(pair).ok()?.split_once('='))
        .filter(|(key, value)| KEYS.contains(key) && !value.is_empty())
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_session_keys_of_an_environment_are_read() {
        let env = parse(b"HOME=/home/a\0DISPLAY=:0\0XAUTHORITY=/run/user/1000/gdm/Xauthority\0EMPTY=\0WAYLAND_DISPLAY=\0junk\0");
        assert_eq!(env.get("DISPLAY").map(String::as_str), Some(":0"));
        assert_eq!(
            env.get("XAUTHORITY").map(String::as_str),
            Some("/run/user/1000/gdm/Xauthority")
        );
        assert!(!env.contains_key("HOME"));
        assert!(!env.contains_key("WAYLAND_DISPLAY"), "an empty value says nothing");
    }

    #[test]
    fn a_session_is_wayland_by_its_socket_or_its_own_word() {
        let mut found = Found {
            display: Some(":0".into()),
            authority: None,
            wayland: None,
            kind: Some("x11".into()),
            desktop: None,
            runtime_dir: None,
            bus: None,
            uid: 1000,
            votes: 1,
        };
        assert!(!found.is_wayland());
        found.wayland = Some("wayland-0".into());
        assert!(found.is_wayland());
        found.wayland = None;
        found.kind = Some("wayland".into());
        assert!(found.is_wayland());
    }
}
