//! INTENTIC'S ENGINE ON A NAMED PIPE (2026-10-10), as `ic`, the desktop app and the machine agent all reach it.
//!
//! The engine's own API is TLS over TCP on `127.0.0.1` (`engine.json` `host`). The docker CLI on Windows reads TCP
//! slowly whatever is behind it: measured on omen, `docker cp` out of a container came at 36–40 MB/s from our engine
//! and from Docker Desktop alike once Docker Desktop was put behind a loopback TCP proxy, while curl and .NET pulled the
//! same archive at 290–313 MB/s, and the same docker.exe over a named pipe at 284–286 MB/s. Docker Desktop is fast
//! because its CLI talks to a named pipe. So `ic` runs a relay (`ic engine relay`, its engine/relay.rs) that serves the
//! engine on a pipe of its own and carries each connection to the TLS endpoint, and `engine.json` names it (`pipe`).
//!
//! The pipe is the fast way, never the only one: every client uses it only while it is there, and the TCP endpoint
//! otherwise, so a relay that is not running costs speed and nothing else.

/// The pipe's last path segment for `distro` and the Windows account `user`: a test engine's distro has a pipe of its
/// own, and so does every account on a shared PC (pipe names are machine-wide). Anything but a letter, digit, dot,
/// dash or underscore becomes `_`. Pure.
pub fn leaf(distro: &str, user: &str) -> String {
    let clean = |text: &str| -> String {
        text.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    format!("{}.{}", clean(distro), clean(user))
}

/// `DOCKER_HOST` for the pipe named `leaf`. Pure.
pub fn host_for(leaf: &str) -> String {
    format!("npipe:////./pipe/{leaf}")
}

/// The Windows path of the pipe a `DOCKER_HOST` names (`npipe:////./pipe/x` → `\\.\pipe\x`), when it names one. Pure.
pub fn path_of(host: &str) -> Option<String> {
    let leaf = host.strip_prefix("npipe:////./pipe/")?;
    (!leaf.is_empty() && !leaf.contains(['/', '\\'])).then(|| format!(r"\\.\pipe\{leaf}"))
}

/// Which way a client reaches the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint<'a> {
    /// The relay's pipe: plain HTTP over it, no TLS variables (the relay holds the client certificate).
    Pipe(&'a str),
    /// The TLS endpoint, with `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH`.
    Tcp(&'a str),
}

/// The pipe when the record names one and it is there (`present` asked of its path), the TCP endpoint otherwise. Pure.
pub fn choose<'a>(
    tcp: &'a str,
    pipe: Option<&'a str>,
    present: impl Fn(&str) -> bool,
) -> Endpoint<'a> {
    match pipe {
        Some(pipe) if path_of(pipe).is_some_and(|path| present(&path)) => Endpoint::Pipe(pipe),
        _ => Endpoint::Tcp(tcp),
    }
}

/// Whether a pipe of this path is served now, without connecting to it: `WaitNamedPipeW` answers at once when there is
/// no such pipe, and when one of its instances is free; a pipe whose instances are all busy is still there.
#[cfg(windows)]
pub fn present(path: &str) -> bool {
    extern "system" {
        fn WaitNamedPipeW(name: *const u16, timeout_ms: u32) -> i32;
    }
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call; the call only reads it.
    if unsafe { WaitNamedPipeW(wide.as_ptr(), 1) } != 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(ERROR_FILE_NOT_FOUND)
}

/// No named pipes off Windows: always the TCP endpoint.
#[cfg(not(windows))]
pub fn present(_path: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pipe_is_named_by_distro_and_account_and_spelled_both_ways() {
        let leaf = leaf("intentic-engine", "Ada Byron");
        assert_eq!(leaf, "intentic-engine.Ada_Byron");
        assert_eq!(super::leaf("intentic-engine", "zoë"), "intentic-engine.zo_");
        let host = host_for(&leaf);
        assert_eq!(host, "npipe:////./pipe/intentic-engine.Ada_Byron");
        assert_eq!(
            path_of(&host).as_deref(),
            Some(r"\\.\pipe\intentic-engine.Ada_Byron")
        );
        assert_eq!(path_of("tcp://127.0.0.1:2378"), None);
        assert_eq!(path_of("npipe:////./pipe/"), None);
    }

    #[test]
    fn the_pipe_is_used_only_while_it_is_there() {
        let tcp = "tcp://127.0.0.1:2378";
        let pipe = "npipe:////./pipe/intentic-engine.me";
        assert_eq!(choose(tcp, Some(pipe), |_| true), Endpoint::Pipe(pipe));
        assert_eq!(choose(tcp, Some(pipe), |_| false), Endpoint::Tcp(tcp));
        assert_eq!(choose(tcp, None, |_| true), Endpoint::Tcp(tcp));
        assert_eq!(
            choose(tcp, Some("npipe:////./pipe/a/b"), |_| true),
            Endpoint::Tcp(tcp)
        );
    }
}
