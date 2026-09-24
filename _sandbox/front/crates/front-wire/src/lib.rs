//! The control lane between intentic-front and the Node daemon: length-prefixed JSON frames over one Unix socket.
//! These types are the lane's only definition; `cargo test -p front-wire` writes their TypeScript into the contract.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A frame is this many bytes of big-endian length, then that many bytes of JSON.
pub const LENGTH_BYTES: usize = 4;

/// Longer than any honest message: a prefix past it means the stream is corrupt, not that a message is large.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// One message as a frame, length prefix included.
pub fn frame<T: Serialize>(message: &T) -> serde_json::Result<Vec<u8>> {
    let mut out = vec![0; LENGTH_BYTES];
    serde_json::to_writer(&mut out, message)?;
    let length =
        u32::try_from(out.len() - LENGTH_BYTES).expect("a frame never exceeds u32::MAX bytes");
    out[..LENGTH_BYTES].copy_from_slice(&length.to_be_bytes());
    Ok(out)
}

/// Request headers only the front sets on what it forwards to Node; it strips them from everything arriving outside.
/// Exported as a literal type, so a Node constant naming one that drifts from this spelling fails to compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "wire.ts")]
pub enum FrontHeader {
    /// A preview request Node answers itself: a refusal page, the probe, or the outbox.
    #[serde(rename = "x-intentic-preview")]
    Preview,
    /// A preview request whose upstream refused the connection; the value is that upstream's port.
    #[serde(rename = "x-intentic-preview-unreachable")]
    PreviewUnreachable,
}

impl FrontHeader {
    pub const ALL: [Self; 2] = [Self::Preview, Self::PreviewUnreachable];

    pub const fn name(self) -> &'static str {
        match self {
            Self::Preview => "x-intentic-preview",
            Self::PreviewUnreachable => "x-intentic-preview-unreachable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "wire.ts")]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

/// Every port the front binds, as Node's config names them; an absent one is not bound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub struct ListenConfig {
    pub daemon: Endpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preview: Option<Endpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub loopback: Option<Endpoint>,
    /// The 12-hex id every public hostname ends in; without one, a label's prefix alone classifies it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sandbox_id: Option<String>,
    /// Origins that may frame a preview besides the preview itself.
    pub frame_ancestors: Vec<String>,
    /// A preview path Node answers whatever its host resolves to.
    pub preview_probe_path: String,
}

/// A PEM certificate chain and its PEM private key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub struct Certificate {
    pub certificate: String,
    pub private_key: String,
}

/// The ingress tunnel's door and the reachability grant it presents there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "wire.ts")]
pub struct TunnelConfig {
    pub url: String,
    pub grant: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "wire.ts")]
pub enum Scheme {
    Http,
    Https,
}

/// A local upstream a preview host relays to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "wire.ts")]
pub struct Upstream {
    pub host: String,
    pub port: u16,
    pub scheme: Scheme,
    /// Rewrites Host and Origin to `localhost:<port>`, for an app that never agreed to its preview name.
    pub localhost: bool,
    /// Framed by the editor: `frame-ancestors` is set and `x-frame-options` dropped.
    pub frameable: bool,
}

/// Where a preview host's requests go, as Node resolved it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "to", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum PreviewRoute {
    Upstream {
        upstream: Upstream,
    },
    /// Node answers the request itself: a refusal page or the outbox.
    Node,
}

/// A question the front asks Node; the answer carries the same id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "question", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum Question {
    Preview { host: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "answer", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum Answer {
    Preview { route: PreviewRoute },
}

/// Everything Node sends the front.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum FromNode {
    /// Node's HTTP socket is accepting; once per Node process.
    Hello {
        build: String,
        pid: u32,
    },
    Listen {
        config: ListenConfig,
    },
    Certificate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        certificate: Option<Certificate>,
    },
    Tunnel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tunnel: Option<TunnelConfig>,
    },
    Answer {
        id: u32,
        answer: Answer,
    },
    Refused {
        id: u32,
        message: String,
    },
}

/// Everything the front sends Node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum ToNode {
    Ask { id: u32, question: Question },
    Tunnel { connected: bool },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_is_its_length_then_its_json() {
        let bytes = frame(&ToNode::Tunnel { connected: true }).unwrap();
        let json = br#"{"kind":"tunnel","connected":true}"#;
        assert_eq!(
            &bytes[..LENGTH_BYTES],
            &u32::try_from(json.len()).unwrap().to_be_bytes()
        );
        assert_eq!(&bytes[LENGTH_BYTES..], json);
    }

    #[test]
    fn a_header_name_is_its_serialized_spelling() {
        for header in FrontHeader::ALL {
            assert_eq!(
                serde_json::to_string(&header).unwrap(),
                format!("\"{}\"", header.name())
            );
        }
    }

    #[test]
    fn an_absent_option_is_an_absent_key() {
        let json = serde_json::to_string(&FromNode::Certificate { certificate: None }).unwrap();
        assert_eq!(json, r#"{"kind":"certificate"}"#);
        let back: FromNode = serde_json::from_str(r#"{"kind":"tunnel"}"#).unwrap();
        assert_eq!(back, FromNode::Tunnel { tunnel: None });
    }

    #[test]
    fn a_preview_route_reads_as_node_sends_it() {
        let route: PreviewRoute = serde_json::from_str(
            r#"{"to":"upstream","upstream":{"host":"127.0.0.1","port":5174,"scheme":"http","localhost":true,"frameable":true}}"#,
        )
        .unwrap();
        assert_eq!(
            route,
            PreviewRoute::Upstream {
                upstream: Upstream {
                    host: "127.0.0.1".into(),
                    port: 5174,
                    scheme: Scheme::Http,
                    localhost: true,
                    frameable: true
                },
            }
        );
    }
}
