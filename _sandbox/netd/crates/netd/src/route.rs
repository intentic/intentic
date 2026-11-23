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
    /// On a runner: a stream its parent's netd opened down the runner's uplink (2026-11-23, `parent.rs`). Routed as the
    /// loopback port is, never guarded (the parent's netd and daemon already gated it), and marked `parent` to Node and
    /// castd, never `loopback`.
    Parent,
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

/// Which of a connected computer's remote routes a request names: its screen's media socket or a terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceRoute {
    Media,
    Terminal,
}

impl DeviceRoute {
    /// The path remoted serves it under, the session after it.
    pub fn upstream(self) -> &'static str {
        match self {
            Self::Media => browser_wire::DEVICE_MEDIA_UPSTREAM,
            Self::Terminal => browser_wire::DEVICE_TERMINAL_UPSTREAM,
        }
    }
}

/// What a request under a device route asks for: one device's session, or nothing it could name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceView<'a> {
    Session {
        route: DeviceRoute,
        device: &'a str,
        session: &'a str,
    },
    BadName,
}

/// `/system/device-media/<device>/<session>` or `/system/device-terminal/<device>/<session>`, each name
/// `[A-Za-z0-9_-]{1,64}`: the device names a socket file and the session a path on remoted, so nothing else passes.
pub fn device_view(path: &str) -> Option<DeviceView<'_>> {
    let (route, rest) = [
        (DeviceRoute::Media, browser_wire::DEVICE_MEDIA_PATH),
        (DeviceRoute::Terminal, browser_wire::DEVICE_TERMINAL_PATH),
    ]
    .into_iter()
    .find_map(|(route, prefix)| Some((route, path.strip_prefix(prefix)?)))?;
    if rest.is_empty() {
        return Some(DeviceView::BadName);
    }
    let named = rest.strip_prefix('/')?;
    Some(match named.split_once('/') {
        Some((device, session))
            if crate::uplinks::is_name(device) && crate::uplinks::is_name(session) =>
        {
            DeviceView::Session {
                route,
                device,
                session,
            }
        }
        _ => DeviceView::BadName,
    })
}

/// A connected computer's remoted dialling its uplink: the exact path, nothing under it.
pub fn is_device_uplink(path: &str) -> bool {
    path == browser_wire::DEVICE_UPLINK_PATH
}

/// A runner's netd dialling its uplink to this parent: the exact path, nothing under it.
pub fn is_runner_uplink(path: &str) -> bool {
    path == browser_wire::RUNNER_UPLINK_PATH
}

/// The desktop's view socket on a runner, which the daemon serves (`desktop/desktop-view.routes.ts`).
pub const DESKTOP_VIEW_PATH: &str = "/system/desktop-view";

/// What a person may open of a runner through `RUNNER_VIEW_PATH`: the whole allowlist. Each but the media socket opens
/// only with a ticket the parent's daemon minted for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerRoute {
    Terminal,
    BrowserView,
    DesktopView,
    /// A window's (or the desktop's) media socket, which castd's own token admits.
    Media(String),
}

impl RunnerRoute {
    /// The path asked for on the runner.
    pub fn path(&self) -> String {
        match self {
            Self::Terminal => browser_wire::TERMINAL_PATH.to_owned(),
            Self::BrowserView => browser_wire::BROWSER_VIEW_PATH.to_owned(),
            Self::DesktopView => DESKTOP_VIEW_PATH.to_owned(),
            Self::Media(session) => format!("{}/{session}", browser_wire::BROWSER_MEDIA_PATH),
        }
    }

    /// Whether the parent's daemon must admit it with a ticket before it opens.
    pub fn ticketed(&self) -> bool {
        !matches!(self, Self::Media(_))
    }
}

/// What a request under the runner view path asks for: one runner's allowed route, a name netd cannot use, or a path on
/// the runner that is not on the allowlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerView {
    Route { runner: String, route: RunnerRoute },
    BadName,
    NotAllowed,
}

/// `/system/runner-view/<runner>/<rest>`, the runner `[A-Za-z0-9_-]{1,64}` and `<rest>` exactly one of
/// `system/terminal`, `system/browser-view`, `system/desktop-view` or `system/browser-media/<session>` (the session a
/// name too). Matched as written: no decoding, no dot segments, nothing after, so `system/terminal/../../orpc` or
/// `system%2Fterminal` is simply not on the list.
pub fn runner_view(path: &str) -> Option<RunnerView> {
    let rest = path.strip_prefix(browser_wire::RUNNER_VIEW_PATH)?;
    if rest.is_empty() {
        return Some(RunnerView::BadName);
    }
    let named = rest.strip_prefix('/')?;
    let Some((runner, asked)) = named.split_once('/') else {
        return Some(RunnerView::BadName);
    };
    if !crate::uplinks::is_name(runner) {
        return Some(RunnerView::BadName);
    }
    let route = match asked {
        "system/terminal" => RunnerRoute::Terminal,
        "system/browser-view" => RunnerRoute::BrowserView,
        "system/desktop-view" => RunnerRoute::DesktopView,
        other => match other.strip_prefix("system/browser-media/") {
            Some(session) if crate::uplinks::is_name(session) => {
                RunnerRoute::Media(session.to_owned())
            }
            _ => return Some(RunnerView::NotAllowed),
        },
    };
    Some(RunnerView::Route {
        runner: runner.to_owned(),
        route,
    })
}

pub fn target(listener: Listener, host: &str, sandbox_id: Option<&str>) -> Target {
    match listener {
        Listener::Daemon | Listener::Loopback { tls: true } => Target::Node,
        Listener::Loopback { tls: false } | Listener::Parent
            if is_preview_host(host, sandbox_id) =>
        {
            Target::Preview
        }
        Listener::Loopback { tls: false } | Listener::Parent => Target::Node,
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
    fn a_device_path_names_one_device_and_session_or_none() {
        assert_eq!(
            device_view("/system/device-media/rog/screen-1"),
            Some(DeviceView::Session {
                route: DeviceRoute::Media,
                device: "rog",
                session: "screen-1"
            })
        );
        assert_eq!(
            device_view("/system/device-terminal/radarsu-server/t-Ab_9"),
            Some(DeviceView::Session {
                route: DeviceRoute::Terminal,
                device: "radarsu-server",
                session: "t-Ab_9"
            })
        );
        for bad in [
            "/system/device-media",
            "/system/device-media/",
            "/system/device-media/rog",
            "/system/device-media/rog/",
            "/system/device-media/rog/a/b",
            "/system/device-media/../screen-1",
            "/system/device-terminal/rog/a.b",
            "/system/device-terminal/rog::wsl:arch/t-1",
            &format!("/system/device-terminal/rog/{}", "a".repeat(65)),
        ] {
            assert_eq!(device_view(bad), Some(DeviceView::BadName), "{bad}");
        }
        assert_eq!(device_view("/system/device-mediax/rog/s"), None);
        assert_eq!(device_view("/system/device-uplink"), None);
        assert_eq!(DeviceRoute::Media.upstream(), "/media");
        assert_eq!(DeviceRoute::Terminal.upstream(), "/terminal");
        assert!(is_device_uplink("/system/device-uplink"));
        assert!(!is_device_uplink("/system/device-uplink/"));
        assert!(!is_device_uplink("/system/device-uplinks"));
    }

    #[test]
    fn a_runner_view_is_only_what_the_allowlist_names() {
        assert_eq!(
            runner_view("/system/runner-view/r1/system/terminal"),
            Some(RunnerView::Route {
                runner: "r1".into(),
                route: RunnerRoute::Terminal
            })
        );
        assert_eq!(
            runner_view("/system/runner-view/r-2/system/browser-view"),
            Some(RunnerView::Route {
                runner: "r-2".into(),
                route: RunnerRoute::BrowserView
            })
        );
        assert_eq!(
            runner_view("/system/runner-view/r1/system/desktop-view"),
            Some(RunnerView::Route {
                runner: "r1".into(),
                route: RunnerRoute::DesktopView
            })
        );
        assert_eq!(
            runner_view("/system/runner-view/r1/system/browser-media/desk_1"),
            Some(RunnerView::Route {
                runner: "r1".into(),
                route: RunnerRoute::Media("desk_1".into())
            })
        );
        for bad in [
            "/system/runner-view",
            "/system/runner-view/",
            "/system/runner-view/r1",
            "/system/runner-view/../system/terminal",
            "/system/runner-view/r.1/system/terminal",
        ] {
            assert_eq!(runner_view(bad), Some(RunnerView::BadName), "{bad}");
        }
        for refused in [
            "/system/runner-view/r1/",
            "/system/runner-view/r1/workspace/raw",
            "/system/runner-view/r1/orpc/agents/list",
            "/system/runner-view/r1/system/terminal/",
            "/system/runner-view/r1/system/terminal/../../orpc",
            "/system/runner-view/r1/system%2Fterminal",
            "/system/runner-view/r1/system/browser-media",
            "/system/runner-view/r1/system/browser-media/",
            "/system/runner-view/r1/system/browser-media/a/b",
            "/system/runner-view/r1/system/browser-media/a.b",
            "/system/runner-view/r1/system/device-uplink",
            "/system/runner-view/r1/system/runner-uplink",
            "/system/runner-view/r1/system/vitals",
        ] {
            assert_eq!(
                runner_view(refused),
                Some(RunnerView::NotAllowed),
                "{refused}"
            );
        }
        assert_eq!(runner_view("/system/runner-viewx/r1/system/terminal"), None);
        assert_eq!(runner_view("/system/runners/connect"), None);
        assert!(is_runner_uplink("/system/runner-uplink"));
        assert!(!is_runner_uplink("/system/runner-uplink/x"));
        assert_eq!(
            RunnerRoute::Media("s".into()).path(),
            "/system/browser-media/s"
        );
        assert!(!RunnerRoute::Media("s".into()).ticketed());
        assert!(RunnerRoute::Terminal.ticketed());
    }

    #[test]
    fn a_parent_stream_routes_as_the_loopback_port_does() {
        assert_eq!(
            target(Listener::Parent, "preview-web.localhost", None),
            Target::Preview
        );
        assert_eq!(target(Listener::Parent, "localhost", None), Target::Node);
        assert_eq!(
            target(
                Listener::Parent,
                "sandbox-abcdef012345.sbx.example.test",
                Some("abcdef012345")
            ),
            Target::Node
        );
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
