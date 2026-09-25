//! intentic-ingress: reads its config, refuses to start unable to verify grants, then serves until told to stop. No
//! database and no migration: the process holds live connections only, so started and ready are the same moment.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use intentic_ingress::body;
use intentic_ingress::certificate::{self, Source};
use intentic_ingress::cluster::{self, Cluster, REMOTE_TTL, SYNC_EVERY};
use intentic_ingress::config::Config;
use intentic_ingress::edge::{Edge, EdgeOptions, Via, advertise};
use intentic_ingress::grant::GrantKey;
use intentic_ingress::peers::{self, FlyPeers, Peer, Peers};
use intentic_ingress::quic;
use intentic_ingress::registry::Registry;
use intentic_ingress::revocation::Revocation;
use intentic_ingress::serve;
use intentic_ingress::tls::{self, CertificateSlot};
use ring::rand::{SecureRandom, SystemRandom};
use tokio::signal::unix::{SignalKind, signal};
use tracing_subscriber::EnvFilter;
use tunnel::Close;

// Time for the close frames sent at shutdown to leave, so every sandbox redials at once instead of after a dead window.
const CLOSE_GRACE: Duration = Duration::from_millis(300);

fn main() -> ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("intentic-ingress: {error:#}");
            return ExitCode::from(1);
        }
    };
    let filter = EnvFilter::try_new(&config.log_level).unwrap_or_else(|_| EnvFilter::new("info"));
    if config.log_pretty {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .init();
    } else {
        tracing_subscriber::fmt()
            .json()
            .flatten_event(true)
            .with_env_filter(filter)
            .with_target(false)
            .init();
    }
    // No key, no edge: an edge that cannot verify must refuse everyone or accept everyone, both worse than not starting.
    if config.public_key.is_empty() {
        tracing::error!(
            "INGRESS_PUBLIC_KEY is unset: the edge cannot verify reachability grants and will not start"
        );
        return ExitCode::from(1);
    }
    let Some(key) = GrantKey::from_pem(&config.public_key) else {
        tracing::error!(
            "INGRESS_PUBLIC_KEY is not one Ed25519 public key in SPKI PEM; the edge will not start"
        );
        return ExitCode::from(1);
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("ingress")
        .build()
        .expect("a tokio runtime starts");
    match runtime.block_on(run(config, key)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(error = format!("{error:#}"), "the edge stopped");
            ExitCode::from(1)
        }
    }
}

async fn run(config: Config, key: GrantKey) -> anyhow::Result<()> {
    let instance = [&config.instance_id, &config.fly_machine_id]
        .into_iter()
        .find(|name| !name.is_empty())
        .cloned()
        .unwrap_or_else(random_name);
    let this = Peer {
        host: [&config.advertise_host, &config.fly_private_ip]
            .into_iter()
            .find(|host| !host.is_empty())
            .cloned()
            .unwrap_or_default(),
        port: config.port,
        internal_port: config.internal_port,
    };
    // A static list wins when given; otherwise the Fly app's DNS when there is an app; otherwise this is one machine.
    let (peers, discovery): (Peers, String) =
        if !config.peers.is_empty() || config.fly_app_name.is_empty() {
            let list = peers::parse_peer_list(&config.peers, config.port, config.internal_port)?;
            let described = if list.is_empty() {
                "single machine".to_owned()
            } else {
                format!("{} static peers", list.len())
            };
            (peers::fixed(list), described)
        } else {
            let fly = FlyPeers::new(
                &config.fly_app_name,
                &config.fly_private_ip,
                config.port,
                config.internal_port,
            );
            (fly.start(), format!("fly app {}", config.fly_app_name))
        };
    if !config.peers.is_empty() && this.host.is_empty() {
        tracing::warn!(
            "INGRESS_PEERS is set but INGRESS_ADVERTISE_HOST is not: this machine will forward to its peers but cannot tell them what it holds"
        );
    }

    let registry = Arc::new(Registry::new());
    let cluster = Cluster::new(
        &instance,
        this.clone(),
        peers.clone(),
        registry.clone(),
        REMOTE_TTL,
    );
    cluster.start(SYNC_EVERY);

    // Fly's private network is unreachable from the internet; off Fly the operator keeps this port unpublished.
    let internal_host = [&config.internal_host, &config.fly_private_ip]
        .into_iter()
        .find(|host| !host.is_empty())
        .cloned()
        .unwrap_or_else(|| "0.0.0.0".to_owned());
    let surface = cluster.clone();
    let internal = serve::listen(
        (internal_host.as_str(), config.internal_port),
        move |request, _| cluster::internal(surface.clone(), request),
    )
    .await?;

    let revocation = Revocation::new(&config.platform_url);
    let revoking = if revocation.enforced() {
        config.platform_url.clone()
    } else {
        "off (no PLATFORM_URL)".to_owned()
    };
    let edge = Edge::new(EdgeOptions {
        key,
        revocation,
        registry: registry.clone(),
        cluster: Some(cluster.clone()),
        peers: Some(peers),
        instance: instance.clone(),
        hosted_app_prefix: (!config.hosted_app_prefix.is_empty())
            .then(|| config.hosted_app_prefix.clone()),
        build: config.build.clone(),
        transports: config.transports(),
    });
    let alt_svc = match config.alt_svc.as_str() {
        "" => None,
        value => Some(
            http::HeaderValue::from_str(value)
                .map_err(|_| anyhow::anyhow!("INGRESS_ALT_SVC is no header value"))?,
        ),
    };
    let serving = edge.clone();
    let advertised = alt_svc.clone();
    let public = serve::listen(
        (config.host.as_str(), config.port),
        move |request, remote| {
            let serving = serving.clone();
            let alt_svc = advertised.clone();
            async move {
                let response = serving
                    .handle(request.map(body::incoming), remote, Via::Proxy)
                    .await;
                advertise(response, alt_svc.as_ref())
            }
        },
    )
    .await?;
    // One slot, filled once, for both doors that terminate TLS here.
    let slot = if config.tls_port.is_some() || config.quic_port.is_some() {
        let slot = Arc::new(CertificateSlot::default());
        certificate::keep(slot.clone(), certificate_source(&config)?);
        Some(slot)
    } else {
        None
    };
    let quic = match (config.quic_port, &slot) {
        (Some(port), Some(slot)) => {
            let address = tokio::net::lookup_host((config.quic_host.as_str(), port))
                .await?
                .next()
                .ok_or_else(|| {
                    anyhow::anyhow!("INGRESS_QUIC_HOST {} names no address", config.quic_host)
                })?;
            let endpoint = quic::endpoint(address, slot.clone())?;
            tokio::spawn(quic::accept(endpoint.clone(), edge.clone()));
            Some(endpoint)
        }
        _ => None,
    };
    let secure = match (config.tls_port, &slot) {
        (None, _) | (_, None) => None,
        (Some(port), Some(slot)) => {
            let slot = slot.clone();
            let listener = tokio::net::TcpListener::bind((config.host.as_str(), port)).await?;
            let serving = edge.clone();
            Some(serve::serve_tls_on(
                listener,
                tls::acceptor(slot),
                config.proxy_protocol,
                move |request, remote| {
                    let serving = serving.clone();
                    let alt_svc = alt_svc.clone();
                    async move {
                        let response = serving
                            .handle(request.map(body::incoming), remote, Via::Direct)
                            .await;
                        advertise(response, alt_svc.as_ref())
                    }
                },
            )?)
        }
    };
    let terminating = secure.as_ref().map_or_else(
        || "off (no INGRESS_TLS_PORT)".to_owned(),
        |secure| {
            let behind = if config.proxy_protocol {
                " behind PROXY headers"
            } else {
                ""
            };
            format!("{}{behind}", secure.address)
        },
    );
    tracing::info!(
        address = %public.address,
        instance = %instance,
        build = if config.build.is_empty() { "(unreleased build)" } else { config.build.as_str() },
        revocation = %revoking,
        cluster = %discovery,
        replay = if config.hosted_app_prefix.is_empty() { "off (no HOSTED_APP_PREFIX)".to_owned() } else { format!("apps {}-<id>", config.hosted_app_prefix) },
        internal = %internal.address,
        tls = %terminating,
        quic = quic.as_ref().and_then(|endpoint| endpoint.local_addr().ok()).map_or_else(|| "off (no INGRESS_QUIC_PORT)".to_owned(), |address| address.to_string()),
        advertise = if this.host.is_empty() { "(none)" } else { this.host.as_str() },
        "intentic ingress listening"
    );

    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let signal = tokio::select! {
        _ = terminate.recv() => "SIGTERM",
        _ = interrupt.recv() => "SIGINT",
    };
    tracing::info!(signal, "shutting down");
    cluster.close();
    registry.close_all(&Close::AWAY);
    tokio::time::sleep(CLOSE_GRACE).await;
    if let Some(endpoint) = &quic {
        endpoint.close(tunnel::quic::AWAY, b"going away");
    }
    public.stop().await;
    if let Some(secure) = secure {
        secure.stop().await;
    }
    internal.stop().await;
    Ok(())
}

fn random_name() -> String {
    let mut bytes = [0_u8; 6];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system has randomness");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// A PEM pair on disk wins when named; otherwise the platform's, which takes its token and its address.
fn certificate_source(config: &Config) -> anyhow::Result<Source> {
    if !config.tls_cert_file.is_empty() && !config.tls_key_file.is_empty() {
        return Ok(Source::Files {
            chain: config.tls_cert_file.clone().into(),
            key: config.tls_key_file.clone().into(),
        });
    }
    if !config.platform_token.is_empty() && !config.platform_url.is_empty() {
        return Ok(Source::Platform {
            url: config.platform_url.clone(),
            token: config.platform_token.clone(),
        });
    }
    anyhow::bail!(
        "INGRESS_TLS_PORT or INGRESS_QUIC_PORT is set but no certificate is: name INGRESS_TLS_CERT_FILE and INGRESS_TLS_KEY_FILE, or INGRESS_PLATFORM_TOKEN with PLATFORM_URL"
    )
}
