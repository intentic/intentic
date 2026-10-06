//! The control socket between intentic-netd and the Node daemon: length-prefixed JSON frames over one Unix socket, the
//! netd owning every socket and byte and Node every decision about them. Nothing here is ever seen by a browser (that
//! is `browser-wire`). These types are the socket's only definition; `cargo test -p netd-wire` writes their
//! TypeScript, and the manifest the contract's lock pins, into the contract.
//!
//! Either side may ask the other a question: an `Ask` carrying an id, answered by an `Answer` or a `Refused` carrying the
//! same one, which the asker waits `ASK_PATIENCE` for. Everything else is told and never answered.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where netd tells the daemon it spawns to dial the control socket.
pub const NETD_SOCKET_ENV: &str = "INTENTIC_NETD_SOCKET";

/// Where netd tells the daemon it spawns to serve HTTP, the only listener the daemon has.
pub const NODE_SOCKET_ENV: &str = "INTENTIC_NODE_SOCKET";

/// netd's instance, which netd tells the daemon it spawns: random, minted once per netd process, which lives
/// as long as its container. netd presents it on every tunnel it dials and the daemon in its announce, so the edge
/// and the platform can tell two copies of one sandbox apart (2026-10-05).
pub const INSTANCE_ENV: &str = "INTENTIC_INSTANCE";

/// Which start of the daemon this is, counted by netd from 1 and set on each daemon it spawns, which says it back
/// in its hello. A connection whose hello names an older start, or none, never takes the control socket from a daemon
/// that already said hello on it (2026-10-05).
pub const GENERATION_ENV: &str = "INTENTIC_NODE_GENERATION";

/// How long either side waits for the answer to a question it asked before giving up on it.
pub const ASK_PATIENCE: Duration = Duration::from_secs(5);

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

/// Request headers only netd sets on what it forwards to Node; it strips them from everything arriving outside.
/// Exported as a literal type, so a Node constant naming one that drifts from this spelling fails to compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[ts(export, export_to = "wire.ts")]
pub enum NetdHeader {
    /// A preview request handed back for Node to answer, the value naming what Node already decided: `outbox`.
    #[serde(rename = "x-intentic-preview")]
    Preview,
    /// A preview request whose upstream refused the connection; the value is that upstream's port.
    #[serde(rename = "x-intentic-preview-unreachable")]
    PreviewUnreachable,
}

impl NetdHeader {
    pub const ALL: [Self; 2] = [Self::Preview, Self::PreviewUnreachable];

    pub const fn name(self) -> &'static str {
        match self {
            Self::Preview => "x-intentic-preview",
            Self::PreviewUnreachable => "x-intentic-preview-unreachable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[ts(export, export_to = "wire.ts")]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

/// Every port netd binds, as Node's config names them; an absent one is not bound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub struct Certificate {
    pub certificate: String,
    pub private_key: String,
}

/// The ingress tunnel's door, the reachability grant it presents there, and the daemon's transfer routes it announces
/// (`METHOD /path` each, as the daemon names them), which the edge sends down the bulk socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[ts(export, export_to = "wire.ts")]
pub struct TunnelConfig {
    pub url: String,
    pub grant: String,
    #[serde(default)]
    pub bulk: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "wire.ts")]
pub enum Scheme {
    Http,
    Https,
}

/// A local upstream a preview host relays to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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

/// An answer Node renders whole when asked, for netd to write as it stands: a refusal page, or the probe's report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[ts(export, export_to = "wire.ts")]
pub struct Page {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

/// What becomes of a preview host's request, decided by Node once, when asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "to", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum PreviewRoute {
    /// netd relays it to this upstream.
    Upstream { upstream: Upstream },
    /// netd answers it with this page.
    Page { page: Page },
    /// The sandbox's outbox: handed back to Node marked `outbox`, which serves the file it names.
    Outbox,
}

/// What a terminal socket opens onto, as Node decided from its ticket, session name and working directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "plan", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
#[serde(rename_all_fields = "camelCase")]
pub enum TerminalPlan {
    /// The tmux session `name`, created in `create_in` when it does not exist yet; without a directory it is only ever
    /// attached, so a session that is gone fails as itself rather than as a bare shell in its place. netd composes
    /// the command.
    Session {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        create_in: Option<String>,
    },
    /// A service's log, followed from its first line.
    Tail { path: String },
    /// Opens only to end at once: the session names nothing there is to show.
    Exit { code: i32, reason: String },
    /// Closed with this WebSocket close code before anything is attached.
    Refused { code: u16, reason: String },
}

/// A question netd asks Node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "question", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum Question {
    /// What becomes of a request to a preview host; `probe` when it asks the preview probe's path.
    Preview {
        host: String,
        #[serde(default)]
        probe: bool,
    },
    /// A terminal socket asking to open, its query string as the browser sent it.
    Terminal { query: String },
    /// Whether Node's event loop turns, and how fast: answered `pong` at once, by the link itself. netd sends one
    /// every 2 s once the previous one is answered, and reports the round trip as the vitals' lag. An older Node answers
    /// with a refusal, or with an answer netd cannot read, and either still counts as answered.
    Ping,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "answer", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum Answer {
    Preview {
        route: PreviewRoute,
    },
    Terminal {
        plan: TerminalPlan,
        /// The member whose ticket opened it, lowercased; absent when the daemon runs without auth.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        member: Option<String>,
    },
    Pong,
}

/// A question Node asks netd.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "question", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum NetdQuestion {
    /// Where each checkout's count stands, once every write that finished before this was sent is counted.
    Sync { dirs: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "answer", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum NetdAnswer {
    /// Each asked checkout's generation, in the order asked: a number that moves whenever anything a `git status` there
    /// reads may have changed, and null for a checkout netd is not counting.
    Sync {
        // A JSON number: far below 2^53 for any checkout's lifetime of events.
        #[ts(type = "Array<number | null>")]
        generations: Vec<Option<u64>>,
    },
}

/// A checkout whose changes netd counts: its working tree, the git dir holding its index and HEAD, and the common
/// dir holding refs and excludes (the git dir itself for a repository's main checkout).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub struct WatchedCheckout {
    pub dir: String,
    pub git_dir: String,
    pub common_dir: String,
}

/// Everything Node sends netd.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum FromNode {
    /// Node's HTTP socket is accepting; once per Node process. `generation` is the `GENERATION_ENV` it was started with,
    /// absent from a Node that predates it.
    Hello {
        build: String,
        pid: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        generation: Option<u64>,
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
    Ask {
        id: u32,
        question: NetdQuestion,
    },
    Answer {
        id: u32,
        answer: Answer,
    },
    Refused {
        id: u32,
        message: String,
    },
    /// Closes every terminal the member opened; naming none closes every terminal a member opened.
    Revoke {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        member: Option<String>,
    },
    /// Counts this checkout's changes from now on; the same checkout again changes nothing.
    Watch {
        checkout: WatchedCheckout,
    },
    /// Stops counting the checkout at `dir`.
    Unwatch {
        dir: String,
    },
}

/// Why netd stopped dialling the ingress at its usual pace, past an ordinary drop it redials at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "refusal", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum TunnelRefusal {
    /// Another copy of this sandbox (a container holding the same grant) holds its tunnel, running on `host` as the
    /// edge named it: the edge refused this netd three times in a row, and netd now dials every 15 minutes.
    Elsewhere { host: String },
    /// The platform deleted this sandbox: the edge closed its tunnel for that, and netd stopped dialling.
    Deleted,
}

/// Everything netd sends Node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "wire.ts")]
pub enum ToNode {
    Ask {
        id: u32,
        question: Question,
    },
    Answer {
        id: u32,
        answer: NetdAnswer,
    },
    Refused {
        id: u32,
        message: String,
    },
    /// Where the ingress tunnel's interactive socket stands, told on every change and again to each Node that says
    /// hello. `reason` says why it is not held, in netd's words (a drop, the edge's refusal), and `refused` when
    /// netd stopped redialling at its usual pace (2026-10-05).
    Tunnel {
        connected: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        refused: Option<TunnelRefusal>,
    },
}

impl ToNode {
    /// The tunnel is held.
    pub fn tunnel_held() -> Self {
        Self::Tunnel {
            connected: true,
            reason: None,
            refused: None,
        }
    }
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

    // THE SOCKET AS THE CONTRACT'S LOCK PINS IT (`contract-lock.ts`), written beside the TypeScript ts-rs writes: a
    // message, field or header that changes or goes away is a removal the lock flags, so a Node and a netd that disagree
    // are caught before they meet.
    #[test]
    fn the_socket_is_written_where_the_contract_locks_it() {
        let manifest = serde_json::json!({
            "env": {
                "netdSocket": NETD_SOCKET_ENV,
                "nodeSocket": NODE_SOCKET_ENV,
                "instance": INSTANCE_ENV,
                "generation": GENERATION_ENV,
            },
            "askPatienceMs": ASK_PATIENCE.as_millis(),
            "frame": {
                "lengthBytes": LENGTH_BYTES,
                "maxBytes": MAX_FRAME_BYTES,
            },
            "headers": NetdHeader::ALL.map(NetdHeader::name),
            "fromNode": schema::<FromNode>(),
            "toNode": schema::<ToNode>(),
        });
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../_shared/sandbox-contract/src/netd/generated/netd-wire.json"
        );
        let written = format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap());
        if std::fs::read_to_string(path).ok().as_deref() != Some(written.as_str()) {
            std::fs::write(path, written).unwrap();
        }
    }

    #[test]
    fn a_frame_is_its_length_then_its_json() {
        let bytes = frame(&ToNode::tunnel_held()).unwrap();
        let json = br#"{"kind":"tunnel","connected":true}"#;
        assert_eq!(
            &bytes[..LENGTH_BYTES],
            &u32::try_from(json.len()).unwrap().to_be_bytes()
        );
        assert_eq!(&bytes[LENGTH_BYTES..], json);
    }

    #[test]
    fn a_question_either_side_asks_is_answered_under_its_id() {
        let json = serde_json::to_string(&ToNode::Answer {
            id: 7,
            answer: NetdAnswer::Sync {
                generations: vec![Some(3), None],
            },
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"kind":"answer","id":7,"answer":{"answer":"sync","generations":[3,null]}}"#
        );
        let asked: FromNode = serde_json::from_str(
            r#"{"kind":"ask","id":7,"question":{"question":"sync","dirs":["/a"]}}"#,
        )
        .unwrap();
        assert_eq!(
            asked,
            FromNode::Ask {
                id: 7,
                question: NetdQuestion::Sync {
                    dirs: vec!["/a".into()]
                },
            }
        );
        let refused = serde_json::to_string(&ToNode::Refused {
            id: 8,
            message: "no feed".into(),
        })
        .unwrap();
        assert_eq!(refused, r#"{"kind":"refused","id":8,"message":"no feed"}"#);
    }

    #[test]
    fn a_terminal_is_planned_by_intent() {
        let plan: TerminalPlan =
            serde_json::from_str(r#"{"plan":"session","name":"main","createIn":"/workspace"}"#)
                .unwrap();
        assert_eq!(
            plan,
            TerminalPlan::Session {
                name: "main".into(),
                create_in: Some("/workspace".into())
            }
        );
        assert_eq!(
            serde_json::to_string(&TerminalPlan::Session {
                name: "agent-1".into(),
                create_in: None
            })
            .unwrap(),
            r#"{"plan":"session","name":"agent-1"}"#
        );
    }

    #[test]
    fn a_preview_question_is_a_plain_one_unless_it_says_probe() {
        let asked: Question =
            serde_json::from_str(r#"{"question":"preview","host":"preview-web.localhost"}"#)
                .unwrap();
        assert_eq!(
            asked,
            Question::Preview {
                host: "preview-web.localhost".into(),
                probe: false
            }
        );
        let page: PreviewRoute = serde_json::from_str(
            r#"{"to":"page","page":{"status":502,"headers":{"content-type":"text/html; charset=utf-8"},"body":"<p>no</p>"}}"#,
        )
        .unwrap();
        let PreviewRoute::Page { page } = page else {
            panic!("a page reads as one");
        };
        assert_eq!(
            (page.status, page.headers["content-type"].as_str()),
            (502, "text/html; charset=utf-8")
        );
        assert_eq!(
            serde_json::to_string(&PreviewRoute::Outbox).unwrap(),
            r#"{"to":"outbox"}"#
        );
    }

    #[test]
    fn a_ping_is_a_bare_question_and_its_pong_a_bare_answer() {
        assert_eq!(
            serde_json::to_string(&ToNode::Ask {
                id: 9,
                question: Question::Ping
            })
            .unwrap(),
            r#"{"kind":"ask","id":9,"question":{"question":"ping"}}"#
        );
        let answered: FromNode =
            serde_json::from_str(r#"{"kind":"answer","id":9,"answer":{"answer":"pong"}}"#).unwrap();
        assert_eq!(
            answered,
            FromNode::Answer {
                id: 9,
                answer: Answer::Pong
            }
        );
    }

    // An older Node reads `connected` alone and a newer one the rest; an older netd's frame reads as a bare state.
    #[test]
    fn a_tunnel_report_names_why_only_when_it_has_a_reason() {
        let refused = ToNode::Tunnel {
            connected: false,
            reason: Some("held by another copy on omen (windows)".into()),
            refused: Some(TunnelRefusal::Elsewhere {
                host: "omen (windows)".into(),
            }),
        };
        assert_eq!(
            serde_json::to_string(&refused).unwrap(),
            r#"{"kind":"tunnel","connected":false,"reason":"held by another copy on omen (windows)","refused":{"refusal":"elsewhere","host":"omen (windows)"}}"#
        );
        let deleted: ToNode = serde_json::from_str(
            r#"{"kind":"tunnel","connected":false,"refused":{"refusal":"deleted"}}"#,
        )
        .unwrap();
        assert_eq!(
            deleted,
            ToNode::Tunnel {
                connected: false,
                reason: None,
                refused: Some(TunnelRefusal::Deleted)
            }
        );
        let older: ToNode = serde_json::from_str(r#"{"kind":"tunnel","connected":true}"#).unwrap();
        assert_eq!(older, ToNode::tunnel_held());
    }

    #[test]
    fn a_hello_names_its_generation_and_an_older_one_none() {
        let hello: FromNode =
            serde_json::from_str(r#"{"kind":"hello","build":"b","pid":7,"generation":3}"#).unwrap();
        assert_eq!(
            hello,
            FromNode::Hello {
                build: "b".into(),
                pid: 7,
                generation: Some(3)
            }
        );
        let older: FromNode =
            serde_json::from_str(r#"{"kind":"hello","build":"b","pid":7}"#).unwrap();
        assert_eq!(
            older,
            FromNode::Hello {
                build: "b".into(),
                pid: 7,
                generation: None
            }
        );
    }

    #[test]
    fn a_header_name_is_its_serialized_spelling() {
        for header in NetdHeader::ALL {
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
