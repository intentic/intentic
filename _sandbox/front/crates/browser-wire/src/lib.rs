//! Everything a browser sees of a sandbox's front and of the edge in front of it, outside the daemon's oRPC contract: a
//! terminal socket's path and messages, the front's vitals, the WebTransport session's path, and the verdict the edge
//! refuses with. These are the only definition; `cargo test -p browser-wire` writes their TypeScript, and the manifest
//! the contract's lock pins, into the contract.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a terminal socket opens, on a sandbox's address: a WebSocket, whether over TCP or on a WebTransport stream.
pub const TERMINAL_PATH: &str = "/system/terminal";

/// The upgrade a terminal socket opens with, whichever carrier its bytes ride.
pub const TERMINAL_UPGRADE: &str = "websocket";

/// Where the front answers its [`SandboxVitals`], on a sandbox's address: a plain GET any origin may read, never
/// forwarded to Node.
pub const VITALS_PATH: &str = "/system/vitals";

/// Where a browser opens its WebTransport session, on the address of the sandbox the session's streams reach; the edge
/// answers it, never the sandbox.
pub const WEBTRANSPORT_PATH: &str = "/system/transport";

/// The ALPN a browser's HTTP/3, and so its WebTransport session, negotiates with the edge.
pub const H3_ALPN: &str = "h3";

/// Why the edge could not carry a request to a sandbox, in a header the edge exposes to any origin.
pub const VERDICT_HEADER: &str = "x-intentic-edge";

/// The edge's verdicts, the only values [`VERDICT_HEADER`] carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum EdgeVerdict {
    /// No tunnel is registered: the box is off, and one that comes back redials within seconds.
    NoTunnel,
    /// The platform has no such sandbox, and no tunnel for it will be accepted again.
    UnknownSandbox,
    /// A tunnel was held and the forward failed mid-flight.
    Dropped,
}

impl EdgeVerdict {
    pub const ALL: [Self; 3] = [Self::NoTunnel, Self::UnknownSandbox, Self::Dropped];

    pub const fn name(self) -> &'static str {
        match self {
            Self::NoTunnel => "no-tunnel",
            Self::UnknownSandbox => "unknown-sandbox",
            Self::Dropped => "dropped",
        }
    }
}

/// The sandbox's proof of life, measured by the front and answered by it at [`VITALS_PATH`] whatever state Node is in:
/// the daemon's own heartbeat rides Node's event loop, so a sandbox busy enough to starve it would otherwise look dead.
/// It carries nothing of the workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub struct SandboxVitals {
    pub node: NodeLink,
    /// How long Node's event loop takes to answer the front, in milliseconds: the round trip of the last ping it
    /// answered, or how long the one outstanding has waited when that is longer. The front pings every 2 s, only once
    /// the previous ping is answered. Null before the first ping, and while Node is not `up`.
    pub lag_ms: Option<u32>,
    /// How many times the front restarted Node in the last 10 minutes.
    pub restarts: u32,
    /// Seconds since the front, and so the container, started.
    pub uptime_s: u32,
    /// The container's pressure stall; null where the cgroup's pressure files cannot be read.
    pub pressure: Option<Pressure>,
    /// Where the ingress tunnel stands and how often it dropped (2026-10-05: a tunnel that dropped once a minute for
    /// four hours was counted nowhere). Absent from an older front.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tunnel: Option<TunnelVitals>,
}

/// The ingress tunnel as the front holds it: the interactive socket, which every request can ride, and QUIC beside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub struct TunnelVitals {
    pub state: TunnelState,
    /// How many times a registered interactive socket dropped in the last hour.
    pub drops_last_hour: u32,
    /// Where the copy holding this sandbox's tunnel runs, as the edge named it, while `state` is `elsewhere`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub holder: Option<String>,
    /// Whether a QUIC connection is held beside the socket.
    pub quic: bool,
}

/// Where the front's tunnel stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum TunnelState {
    /// No tunnel is configured: the sandbox is reachable on loopback only.
    Off,
    /// Configured and not held right now: dialling, or waiting to redial.
    Dialling,
    /// The edge holds the interactive socket.
    Held,
    /// Another copy of this sandbox holds the tunnel, and the edge refused this one three times in a row; the front
    /// dials every 15 minutes meanwhile.
    Elsewhere,
    /// The platform deleted this sandbox, and the front stopped dialling.
    Deleted,
}

impl TunnelState {
    pub const ALL: [Self; 5] = [
        Self::Off,
        Self::Dialling,
        Self::Held,
        Self::Elsewhere,
        Self::Deleted,
    ];
}

/// Where the front's control link to Node stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum NodeLink {
    /// Node has not said hello since the container started.
    Starting,
    /// Node's control link is open and it said hello on it.
    Up,
    /// Node was up or was restarted before, and is not up now: its link dropped, or its process exited and the front is
    /// starting it again.
    Restarting,
}

impl NodeLink {
    pub const ALL: [Self; 3] = [Self::Starting, Self::Up, Self::Restarting];
}

/// The share of the last 10 seconds, as a percentage, in which some of the container's tasks stalled waiting for each
/// resource: cgroup v2's `some avg10` from `cpu.pressure`, `memory.pressure` and `io.pressure`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[ts(export, export_to = "browser-wire.ts")]
pub struct Pressure {
    pub cpu: f32,
    pub memory: f32,
    pub io: f32,
}

/// What the browser sends on a terminal socket, each a JSON text message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum TerminalClientMessage {
    /// Keystrokes, a paste or a mouse report, written into the pane as their UTF-8 bytes.
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    /// The client's liveness, the socket's only one: the editor sends one every 30 s and calls the socket stale after
    /// 90 s without a frame. The front answers `pong`, sends a WebSocket ping only to a client silent for 45 s, and closes
    /// one silent for 90.
    Ping,
}

/// What a terminal socket sends as JSON text; the pane's own bytes travel as binary messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum TerminalServerMessage {
    /// The shared pane's grid. Viewport resize requests remain the viewer's own available size.
    Grid {
        cols: u16,
        rows: u16,
    },
    /// The session is over, and the browser must not reconnect; `reason` is tmux's own words when it had any.
    Exit {
        code: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
    },
    Pong,
}

#[cfg(test)]
mod tests {
    use super::*;

    // A type's JSON Schema without the dialect banner, which every one repeats.
    fn schema<T: schemars::JsonSchema>() -> serde_json::Value {
        let mut schema = serde_json::to_value(schemars::schema_for!(T)).unwrap();
        schema.as_object_mut().unwrap().remove("$schema");
        schema
    }

    // THE WIRE THIS CRATE DEFINES, written where the contract's lock reads it (`contract-lock.ts`): the TypeScript side
    // reads these values instead of restating them, and one that changes or goes away is a removal the lock flags.
    #[test]
    fn the_wire_is_written_where_the_contract_locks_it() {
        let manifest = serde_json::json!({
            "edge": {
                "verdictHeader": VERDICT_HEADER,
                "verdicts": schema::<EdgeVerdict>(),
            },
            "terminal": {
                "path": TERMINAL_PATH,
                "upgrade": TERMINAL_UPGRADE,
                "client": schema::<TerminalClientMessage>(),
                "server": schema::<TerminalServerMessage>(),
            },
            "vitals": {
                "path": VITALS_PATH,
                "body": schema::<SandboxVitals>(),
            },
            "webTransport": {
                "path": WEBTRANSPORT_PATH,
                "alpn": H3_ALPN,
            },
        });
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../_shared/sandbox-contract/src/front/generated/browser-wire.json"
        );
        let written = format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap());
        if std::fs::read_to_string(path).ok().as_deref() != Some(written.as_str()) {
            std::fs::write(path, written).unwrap();
        }
    }

    #[test]
    fn a_verdict_is_its_serialized_spelling() {
        for verdict in EdgeVerdict::ALL {
            assert_eq!(
                serde_json::to_string(&verdict).unwrap(),
                format!("\"{}\"", verdict.name())
            );
        }
    }

    #[test]
    fn vitals_are_the_camel_case_json_the_editor_parses_with_null_for_what_is_unknown() {
        let vitals = SandboxVitals {
            node: NodeLink::Restarting,
            lag_ms: None,
            restarts: 2,
            uptime_s: 3600,
            pressure: Some(Pressure {
                cpu: 12.34,
                memory: 0.0,
                io: 1.5,
            }),
            tunnel: None,
        };
        assert_eq!(
            serde_json::to_string(&vitals).unwrap(),
            r#"{"node":"restarting","lagMs":null,"restarts":2,"uptimeS":3600,"pressure":{"cpu":12.34,"memory":0.0,"io":1.5}}"#
        );
        let flapping = SandboxVitals {
            tunnel: Some(TunnelVitals {
                state: TunnelState::Elsewhere,
                drops_last_hour: 171,
                holder: Some("rog (linux)".into()),
                quic: false,
            }),
            ..vitals
        };
        assert!(
            serde_json::to_string(&flapping).unwrap().ends_with(
                r#""tunnel":{"state":"elsewhere","dropsLastHour":171,"holder":"rog (linux)","quic":false}}"#
            )
        );
        let states: Vec<String> = TunnelState::ALL
            .iter()
            .map(|state| serde_json::to_string(state).unwrap())
            .collect();
        assert_eq!(
            states,
            [
                r#""off""#,
                r#""dialling""#,
                r#""held""#,
                r#""elsewhere""#,
                r#""deleted""#
            ]
        );
        let spellings: Vec<String> = NodeLink::ALL
            .iter()
            .map(|link| serde_json::to_string(link).unwrap())
            .collect();
        assert_eq!(spellings, [r#""starting""#, r#""up""#, r#""restarting""#]);
    }

    #[test]
    fn a_terminal_speaks_the_json_the_editor_sends_and_reads() {
        let resize: TerminalClientMessage =
            serde_json::from_str(r#"{"type":"resize","cols":120,"rows":40}"#).unwrap();
        assert_eq!(
            resize,
            TerminalClientMessage::Resize {
                cols: 120,
                rows: 40
            }
        );
        assert_eq!(
            serde_json::to_string(&TerminalServerMessage::Grid { cols: 80, rows: 24 }).unwrap(),
            r#"{"type":"grid","cols":80,"rows":24}"#
        );
        let ping: TerminalClientMessage = serde_json::from_str(r#"{"type":"ping"}"#).unwrap();
        assert_eq!(ping, TerminalClientMessage::Ping);
        assert_eq!(
            serde_json::to_string(&TerminalServerMessage::Exit {
                code: 0,
                reason: None
            })
            .unwrap(),
            r#"{"type":"exit","code":0}"#
        );
        assert_eq!(
            serde_json::to_string(&TerminalServerMessage::Pong).unwrap(),
            r#"{"type":"pong"}"#
        );
    }
}
