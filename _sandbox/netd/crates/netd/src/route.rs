//! Which side answers a request: Node, or a preview upstream. Decided by the listener it arrived on and the leftmost
//! DNS label of its Host; the label rules mirror the contract's hostnames.ts and are held to its shared fixture.

/// Where a connection came in; each listener answers a different set of hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listener {
    /// The daemon's own port: Node, whatever the host.
    Daemon,
    /// The preview port, which the tunnel and a hosted machine's front door also land on.
    Preview,
    /// The machine-published loopback port; `tls` is the certified `<id>.local.<zone>` name, which is never a preview.
    Loopback { tls: bool },
    /// A stream arriving down the ingress tunnel, whichever carrier brought it.
    Tunnel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Node,
    Preview,
}

// With an id, the key must end in the exact `-<id>` suffix, so a key containing `-` stays unambiguous.
fn key_from_host<'a>(prefix: &str, host: &'a str, sandbox_id: Option<&str>) -> Option<&'a str> {
    let key = relay::label_of(host).strip_prefix(prefix)?;
    match sandbox_id {
        None => (!key.is_empty()).then_some(key),
        Some(id) => {
            let stem = key.strip_suffix(id)?.strip_suffix('-')?;
            (!stem.is_empty()).then_some(stem)
        }
    }
}

pub fn panel_from_host<'a>(host: &'a str, sandbox_id: Option<&str>) -> Option<&'a str> {
    key_from_host("preview-", host, sandbox_id)
}

pub fn port_slot_from_host<'a>(host: &'a str, sandbox_id: Option<&str>) -> Option<&'a str> {
    key_from_host("port-", host, sandbox_id)
}

pub fn public_slot_from_host<'a>(host: &'a str, sandbox_id: Option<&str>) -> Option<&'a str> {
    key_from_host("public-", host, sandbox_id)
}

pub fn is_preview_host(host: &str, sandbox_id: Option<&str>) -> bool {
    panel_from_host(host, sandbox_id).is_some()
        || port_slot_from_host(host, sandbox_id).is_some()
        || public_slot_from_host(host, sandbox_id).is_some()
}

/// `sandbox-<id>`: the daemon's own name. Without an id nothing is the daemon's, and the preview side refuses it.
pub fn is_daemon_host(host: &str, sandbox_id: Option<&str>) -> bool {
    sandbox_id.is_some_and(|id| relay::label_of(host).strip_prefix("sandbox-") == Some(id))
}

/// What a request under browser-wire's media path asks for: the window's media daemon by its session's name, or
/// nothing it could name. `None` is a path outside the media route entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Media<'a> {
    Session(&'a str),
    BadName,
}

/// `/system/browser-media/<session>`, the session `[A-Za-z0-9_-]{1,64}`. The name becomes a socket's file name, so
/// nothing else is let through: no dot, no slash, no escape.
pub fn media(path: &str) -> Option<Media<'_>> {
    let rest = path.strip_prefix(browser_wire::BROWSER_MEDIA_PATH)?;
    if rest.is_empty() {
        return Some(Media::BadName);
    }
    let name = rest.strip_prefix('/')?;
    let valid = (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    Some(if valid {
        Media::Session(name)
    } else {
        Media::BadName
    })
}

pub fn target(listener: Listener, host: &str, sandbox_id: Option<&str>) -> Target {
    match listener {
        Listener::Daemon | Listener::Loopback { tls: true } => Target::Node,
        Listener::Loopback { tls: false } if is_preview_host(host, sandbox_id) => Target::Preview,
        Listener::Loopback { tls: false } => Target::Node,
        Listener::Preview | Listener::Tunnel if is_daemon_host(host, sandbox_id) => Target::Node,
        Listener::Preview | Listener::Tunnel => Target::Preview,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HostCase {
        host: String,
        sandbox_id: Option<String>,
        panel: Option<String>,
        port: Option<String>,
        public: Option<String>,
    }

    #[test]
    fn the_shared_host_cases_parse_as_the_contract_parses_them() {
        let cases: Vec<HostCase> = serde_json::from_str(include_str!(
            "../../../../../_shared/sandbox-contract/src/ids/hostnames.fixture.json"
        ))
        .unwrap();
        assert!(cases.len() > 10);
        for case in cases {
            let id = case.sandbox_id.as_deref();
            assert_eq!(
                panel_from_host(&case.host, id),
                case.panel.as_deref(),
                "panel of {}",
                case.host
            );
            assert_eq!(
                port_slot_from_host(&case.host, id),
                case.port.as_deref(),
                "port of {}",
                case.host
            );
            assert_eq!(
                public_slot_from_host(&case.host, id),
                case.public.as_deref(),
                "public of {}",
                case.host
            );
        }
    }

    #[test]
    fn the_daemon_is_only_its_own_label() {
        let id = Some("abcdef012345");
        assert!(is_daemon_host("sandbox-abcdef012345.sbx.example.test", id));
        assert!(is_daemon_host(
            "sandbox-abcdef012345.sbx.example.test:443",
            id
        ));
        assert!(!is_daemon_host("sandbox-0123456789ab.sbx.example.test", id));
        assert!(!is_daemon_host(
            "sandbox-abcdef012345x.sbx.example.test",
            id
        ));
        assert!(!is_daemon_host(
            "sandbox-abcdef012345.sbx.example.test",
            None
        ));
    }

    #[test]
    fn a_media_path_names_one_session_or_none() {
        assert_eq!(
            media("/system/browser-media/browser-own"),
            Some(Media::Session("browser-own"))
        );
        assert_eq!(
            media("/system/browser-media/Agent_7-x"),
            Some(Media::Session("Agent_7-x"))
        );
        let longest = "a".repeat(64);
        assert_eq!(
            media(&format!("/system/browser-media/{longest}")),
            Some(Media::Session(longest.as_str()))
        );
        for bad in [
            "/system/browser-media",
            "/system/browser-media/",
            "/system/browser-media/..",
            "/system/browser-media/a.b",
            "/system/browser-media/a/b",
            "/system/browser-media/a%2fb",
            "/system/browser-media/ą",
            &format!("/system/browser-media/{}", "a".repeat(65)),
        ] {
            assert_eq!(media(bad), Some(Media::BadName), "{bad}");
        }
        // A path that only starts the same way is another route's.
        assert_eq!(media("/system/browser-mediax/a"), None);
        assert_eq!(media("/system/browser-view"), None);
        assert_eq!(media("/"), None);
    }

    #[test]
    fn each_listener_answers_its_own_hosts() {
        let id = Some("abcdef012345");
        let daemon = "sandbox-abcdef012345.sbx.example.test";
        let preview = "preview-web-abcdef012345.sbx.example.test";
        assert_eq!(target(Listener::Daemon, preview, id), Target::Node);
        assert_eq!(target(Listener::Tunnel, daemon, id), Target::Node);
        assert_eq!(target(Listener::Tunnel, preview, id), Target::Preview);
        assert_eq!(
            target(Listener::Preview, "stray.sbx.example.test", id),
            Target::Preview
        );
        assert_eq!(
            target(
                Listener::Loopback { tls: true },
                "preview-web.localhost",
                None
            ),
            Target::Node
        );
        assert_eq!(
            target(
                Listener::Loopback { tls: false },
                "preview-web.localhost",
                None
            ),
            Target::Preview
        );
        assert_eq!(
            target(Listener::Loopback { tls: false }, "127.0.0.1:28123", None),
            Target::Node
        );
    }
}
