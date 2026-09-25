//! What the deployment injects, read from the environment once at start; nothing is baked but the build id. The edge
//! holds no credential that can create anything: it verifies a signature and forwards bytes.

use anyhow::Context;
use tunnel::Transport;

pub struct Config {
    /// The platform's Ed25519 public key, SPKI PEM; the edge refuses to start without it (`INGRESS_PUBLIC_KEY`).
    pub public_key: String,
    pub host: String,
    pub port: u16,
    /// Which image this is, baked at build (`INGRESS_BUILD`); empty is an unreleased build.
    pub build: String,
    /// This machine's name to peers and on `/health`; empty falls back to Fly's machine id, else a random one.
    pub instance_id: String,
    /// A static peer list off Fly, `host[:port[:internalPort]]` comma-separated (`INGRESS_PEERS`).
    pub peers: String,
    /// The address peers reach this machine at; empty routes but cannot advertise (`INGRESS_ADVERTISE_HOST`).
    pub advertise_host: String,
    /// The holds protocol's private listener, never published (`INGRESS_INTERNAL_PORT` / `_HOST`).
    pub internal_port: u16,
    pub internal_host: String,
    pub fly_app_name: String,
    pub fly_private_ip: String,
    pub fly_machine_id: String,
    /// Where to ask whether a sandbox still exists; empty turns revocation off (`PLATFORM_URL`).
    pub platform_url: String,
    /// Hosted sandboxes' Fly app prefix; empty replays nothing (`HOSTED_APP_PREFIX`).
    pub hosted_app_prefix: String,
    pub log_level: String,
    /// Human-readable lines instead of JSON (`LOG_PRETTY`).
    pub log_pretty: bool,
    /// Where the edge terminates TLS itself (`INGRESS_TLS_PORT`); `None` leaves TLS to whatever is in front of it.
    pub tls_port: Option<u16>,
    /// The certificate as a PEM pair an operator renews (`INGRESS_TLS_CERT_FILE` / `INGRESS_TLS_KEY_FILE`).
    pub tls_cert_file: String,
    pub tls_key_file: String,
    /// What this edge presents to the platform: to fetch the certificate it issued, and to wake a hosted sandbox
    /// (`INGRESS_PLATFORM_TOKEN`).
    pub platform_token: String,
    /// The TLS port sits behind a TCP passthrough that opens each connection with a PROXY header
    /// (`INGRESS_PROXY_PROTOCOL`).
    pub proxy_protocol: bool,
    /// Where the QUIC door listens on UDP (`INGRESS_QUIC_PORT`), with the TLS listener's certificate; `None` is off.
    pub quic_port: Option<u16>,
    /// The UDP address it binds (`INGRESS_QUIC_HOST`, else `INGRESS_HOST`); Fly carries UDP only to `fly-global-services`.
    pub quic_host: String,
    /// What TCP answers advertise HTTP/3 with, naming the public UDP port (`INGRESS_ALT_SVC`, e.g. `h3=":443"; ma=86400`).
    pub alt_svc: String,
}

impl Config {
    /// What this edge serves beyond HTTPS over TCP, read off what it binds: the QUIC door carries a front's tunnel, a
    /// browser's HTTP/3 and its WebTransport session alike, and the process does not start when it cannot bind it.
    pub fn transports(&self) -> Vec<Transport> {
        if self.quic_port.is_some() {
            Transport::ALL.to_vec()
        } else {
            Vec::new()
        }
    }

    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            public_key: text("INGRESS_PUBLIC_KEY"),
            host: text("INGRESS_HOST").or("0.0.0.0"),
            port: port("INGRESS_PORT", 8080)?,
            build: text("INGRESS_BUILD"),
            instance_id: text("INGRESS_INSTANCE_ID"),
            peers: text("INGRESS_PEERS"),
            advertise_host: text("INGRESS_ADVERTISE_HOST"),
            internal_port: port("INGRESS_INTERNAL_PORT", 8081)?,
            internal_host: text("INGRESS_INTERNAL_HOST"),
            fly_app_name: text("FLY_APP_NAME"),
            fly_private_ip: text("FLY_PRIVATE_IP"),
            fly_machine_id: text("FLY_MACHINE_ID"),
            platform_url: text("PLATFORM_URL"),
            hosted_app_prefix: text("HOSTED_APP_PREFIX"),
            log_level: text("LOG_LEVEL").or("info"),
            log_pretty: flag("LOG_PRETTY"),
            tls_port: match text("INGRESS_TLS_PORT").as_str() {
                "" => None,
                _ => Some(port("INGRESS_TLS_PORT", 0)?),
            },
            tls_cert_file: text("INGRESS_TLS_CERT_FILE"),
            tls_key_file: text("INGRESS_TLS_KEY_FILE"),
            platform_token: text("INGRESS_PLATFORM_TOKEN"),
            proxy_protocol: flag("INGRESS_PROXY_PROTOCOL"),
            quic_port: match text("INGRESS_QUIC_PORT").as_str() {
                "" => None,
                _ => Some(port("INGRESS_QUIC_PORT", 0)?),
            },
            quic_host: text("INGRESS_QUIC_HOST").or(&text("INGRESS_HOST").or("0.0.0.0")),
            alt_svc: text("INGRESS_ALT_SVC"),
        })
    }
}

fn text(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_owned()
}

fn flag(name: &str) -> bool {
    matches!(text(name).as_str(), "true" | "1" | "yes")
}

fn port(name: &str, default: u16) -> anyhow::Result<u16> {
    let value = text(name);
    if value.is_empty() {
        return Ok(default);
    }
    value
        .parse()
        .with_context(|| format!("{name}={value} is not a port"))
}

trait Or {
    fn or(self, fallback: &str) -> String;
}

impl Or for String {
    fn or(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}
