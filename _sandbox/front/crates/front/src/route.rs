//! Which side answers a request: Node, or a preview upstream. Decided by the listener it arrived on and the leftmost
//! DNS label of its Host; the label rules mirror the contract's hostnames.ts and are held to its shared fixture.

/// Where a connection came in; each listener answers a different set of hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    /// The daemon's own port: Node, whatever the host.
    Daemon,
    /// The preview port, which the tunnel and a hosted machine's front door also land on.
    Preview,
    /// The machine-published loopback port; `tls` is the certified `<id>.local.<zone>` name, which is never a preview.
    Loopback { tls: bool },
    /// A stream arriving down the ingress tunnel.
    Tunnel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Node,
    Preview,
}

/// The leftmost DNS label of a Host header, port stripped; empty when there is none.
pub fn label_of(host: &str) -> &str {
    host.split(':')
        .next()
        .unwrap_or("")
        .split('.')
        .next()
        .unwrap_or("")
}

// With an id, the key must end in the exact `-<id>` suffix, so a key containing `-` stays unambiguous.
fn key_from_host<'a>(prefix: &str, host: &'a str, sandbox_id: Option<&str>) -> Option<&'a str> {
    let key = label_of(host).strip_prefix(prefix)?;
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
    sandbox_id.is_some_and(|id| label_of(host).strip_prefix("sandbox-") == Some(id))
}

pub fn target(lane: Lane, host: &str, sandbox_id: Option<&str>) -> Target {
    match lane {
        Lane::Daemon | Lane::Loopback { tls: true } => Target::Node,
        Lane::Loopback { tls: false } if is_preview_host(host, sandbox_id) => Target::Preview,
        Lane::Loopback { tls: false } => Target::Node,
        Lane::Preview | Lane::Tunnel if is_daemon_host(host, sandbox_id) => Target::Node,
        Lane::Preview | Lane::Tunnel => Target::Preview,
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
    fn each_lane_answers_its_own_hosts() {
        let id = Some("abcdef012345");
        let daemon = "sandbox-abcdef012345.sbx.example.test";
        let preview = "preview-web-abcdef012345.sbx.example.test";
        assert_eq!(target(Lane::Daemon, preview, id), Target::Node);
        assert_eq!(target(Lane::Tunnel, daemon, id), Target::Node);
        assert_eq!(target(Lane::Tunnel, preview, id), Target::Preview);
        assert_eq!(
            target(Lane::Preview, "stray.sbx.example.test", id),
            Target::Preview
        );
        assert_eq!(
            target(Lane::Loopback { tls: true }, "preview-web.localhost", None),
            Target::Node
        );
        assert_eq!(
            target(Lane::Loopback { tls: false }, "preview-web.localhost", None),
            Target::Preview
        );
        assert_eq!(
            target(Lane::Loopback { tls: false }, "127.0.0.1:28123", None),
            Target::Node
        );
    }
}
