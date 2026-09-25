//! Everything a browser sees of a sandbox's front and of the edge in front of it, outside the daemon's oRPC contract: a
//! terminal socket's path and messages, the WebTransport session's path, and the verdict the edge refuses with. These
//! are the only definition; `cargo test -p browser-wire` writes their TypeScript, and the manifest the contract's lock
//! pins, into the contract.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a terminal socket opens, on a sandbox's address: a WebSocket, whether over TCP or on a WebTransport stream.
pub const TERMINAL_PATH: &str = "/system/terminal";

/// The upgrade a terminal socket opens with, whichever carrier its bytes ride.
pub const TERMINAL_UPGRADE: &str = "websocket";

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
    /// The browser's keepalive against an idle tunnel; answered `pong`.
    Ping,
}

/// What a terminal socket sends as JSON text; the pane's own bytes travel as binary messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "browser-wire.ts")]
pub enum TerminalServerMessage {
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
