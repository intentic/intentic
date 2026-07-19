use std::time::Duration;

use crate::claim::{claim, ClaimValues};
use crate::docker;
use crate::progress::Reporter;
use crate::slug::derive_slug;
use crate::tunnel;
use crate::types::{Engine, Error, Result, SandboxRecord, SandboxStatus, SetupMode, SetupRequest};

/// Constants mirrored from connect.sh — the desktop must launch byte-identical containers.
pub const SANDBOX_IMAGE: &str = "registry.gitlab.com/radarsu/intentic/sandbox:stable";
pub const CLOUDFLARED_IMAGE: &str = "cloudflare/cloudflared:2026.6.1";
pub const GOOGLE_CLIENT_ID: &str =
    "481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com";
pub const PLATFORM_URL: &str = "https://app.intentic.dev";
pub const ORIGIN_HOST: &str = "intentic-sandbox-workspace";
const SANDBOX_DNS: [&str; 2] = ["1.1.1.1", "1.0.0.1"];
const DAEMON_PORT: &str = "8787";
const PREVIEW_PORT: &str = "5173";

/// The env vars a recreate replays from the running container — dev-sandbox.sh/rebuild.sh's allowlist.
const ENV_REPLAY: [&str; 19] = [
    "WORKSPACE_ROOT",
    "HISTORY_ROOT",
    "AGENT_AUTH_DIR",
    "SANDBOX_HOST",
    "SANDBOX_PORT",
    "SANDBOX_NAME",
    "PREVIEW_PORT",
    "GOOGLE_CLIENT_ID",
    "CONNECT_TOKEN",
    "OWNER_EMAIL",
    "WEB_ORIGIN",
    "SANDBOX_PUBLIC_URL",
    "PLATFORM_URL",
    "CLOUDFLARE_API_TOKEN",
    "HOST_SSH_KEY",
    "SELF_HOST_USER",
    "SYNC_PAIR_TOKEN",
    "SELF_HOST_ADDRESS",
    "SELF_HOST_VIA",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Names {
    pub container: String,
    pub tunnel_container: String,
    pub workspace_volume: String,
    pub history_volume: String,
    pub network: String,
}

impl Names {
    pub fn for_slug(slug: &str) -> Names {
        Names {
            container: format!("intentic-sandbox-{slug}"),
            tunnel_container: format!("intentic-sandbox-tunnel-{slug}"),
            workspace_volume: format!("intentic-workspace-{slug}"),
            history_volume: format!("intentic-history-{slug}"),
            network: format!("intentic-workspace-{slug}"),
        }
    }
}

/// connect.sh's image_has_registry: a ref whose first path component looks like a host is pulled;
/// a registry-less tag (e.g. `intentic-sandbox:dev`) is only ever used from the local store.
pub fn is_registry_image(image: &str) -> bool {
    match image.split_once('/') {
        Some((first, _)) => first.contains('.') || first.contains(':') || first == "localhost",
        None => false,
    }
}

/// connect.sh's PLATFORM_URL_CONTAINER rewrite: a localhost platform must be dialed as
/// host.docker.internal from inside the container.
pub fn platform_url_for_container(platform_url: &str) -> String {
    platform_url
        .replacen("//localhost", "//host.docker.internal", 1)
        .replacen("//127.0.0.1", "//host.docker.internal", 1)
}

pub struct RunPlan {
    pub names: Names,
    pub slug: String,
    pub public_url: String,
    pub tunnel_token: Option<String>,
    pub args: Vec<String>,
}

/// Build the exact `docker run` argument vector for the sandbox container. Pure so the parity with
/// connect.sh:808-838 stays pinned by tests.
pub fn plan_run(
    request: &SetupRequest,
    values: &ClaimValues,
    tunnel_token: Option<String>,
    hostname: Option<String>,
) -> RunPlan {
    let slug = derive_slug(
        values.subdomain.as_deref(),
        hostname.as_deref().or(values.sandbox_hostname.as_deref()),
        &values.connect_token,
    );
    let names = Names::for_slug(&slug);
    let image = request
        .image
        .clone()
        .unwrap_or_else(|| SANDBOX_IMAGE.to_string());
    let public_url = match request.mode {
        SetupMode::Local => format!("http://127.0.0.1:{DAEMON_PORT}"),
        _ => format!(
            "https://{}",
            hostname
                .as_deref()
                .or(values.sandbox_hostname.as_deref())
                .unwrap_or_default()
        ),
    };

    let mut args: Vec<String> = [
        "run",
        "-d",
        "--init",
        "--restart",
        "unless-stopped",
        "--name",
        &names.container,
        "--network",
        &names.network,
        "--network-alias",
        ORIGIN_HOST,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=3",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    for dns in SANDBOX_DNS {
        args.push("--dns".into());
        args.push(dns.into());
    }
    args.push("-v".into());
    args.push(format!("{}:/work", names.workspace_volume));
    args.push("-v".into());
    args.push(format!("{}:/history", names.history_volume));
    if request.mode == SetupMode::Local {
        args.push("-p".into());
        args.push(format!("127.0.0.1:{DAEMON_PORT}:{DAEMON_PORT}"));
        args.push("-p".into());
        args.push(format!("127.0.0.1:{PREVIEW_PORT}:{PREVIEW_PORT}"));
    }

    let mut env = |key: &str, value: &str| {
        if !value.is_empty() {
            args.push("-e".into());
            args.push(format!("{key}={value}"));
        }
    };
    env("WORKSPACE_ROOT", "/work");
    env("HISTORY_ROOT", "/history");
    env("SANDBOX_HOST", "0.0.0.0");
    env("SANDBOX_PORT", DAEMON_PORT);
    env("SANDBOX_NAME", &names.container);
    env("SANDBOX_IMAGE", &image);
    env("PREVIEW_PORT", PREVIEW_PORT);
    env("GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID);
    env("CONNECT_TOKEN", &values.connect_token);
    env(
        "OWNER_EMAIL",
        values.owner_email.as_deref().unwrap_or_default(),
    );
    env("SANDBOX_PUBLIC_URL", &public_url);
    env(
        "PLATFORM_URL",
        &platform_url_for_container(&request.platform_url),
    );
    env(
        "SYNC_PAIR_TOKEN",
        values.sync_pair_token.as_deref().unwrap_or_default(),
    );
    if request.mode == SetupMode::Own {
        env(
            "CLOUDFLARE_API_TOKEN",
            request.cf_token.as_deref().unwrap_or_default(),
        );
    }
    args.push(image);

    RunPlan {
        names,
        slug,
        public_url,
        tunnel_token,
        args,
    }
}

/// The whole connect.sh flow, natively: claim → tunnel → image → container → sidecar → health.
pub fn run_setup(
    engine: &Engine,
    request: &SetupRequest,
    reporter: &dyn Reporter,
) -> Result<SandboxRecord> {
    reporter.started("claim", "Redeeming your setup code");
    let values = claim(&request.platform_url, &request.code)?;
    reporter.done("claim");

    let image = request
        .image
        .clone()
        .unwrap_or_else(|| SANDBOX_IMAGE.to_string());
    reporter.started("image", "Getting the sandbox image");
    ensure_image(engine, &image, reporter)?;
    reporter.done("image");

    let provisioned = match request.mode {
        SetupMode::Own => {
            reporter.started("tunnel", "Provisioning your Cloudflare tunnel");
            let cf_token = request.cf_token.as_deref().ok_or_else(|| {
                Error::Setup("the own-Cloudflare path needs your Cloudflare API token".into())
            })?;
            let provisioned = tunnel::provision_own(
                engine,
                &tunnel::OwnTunnelSpec {
                    image: &image,
                    cf_token,
                    connect_token: &values.connect_token,
                    zone: values.zone.as_deref(),
                    subdomain: values.subdomain.as_deref(),
                },
                reporter,
                "tunnel",
            )?;
            reporter.done("tunnel");
            Some(provisioned)
        }
        SetupMode::Intentic => {
            let token = values.tunnel_token.clone().ok_or_else(|| {
                Error::Setup(
                    "the platform did not provide a tunnel for this code — mint a fresh one".into(),
                )
            })?;
            let hostname = values.sandbox_hostname.clone().ok_or_else(|| {
                Error::Setup("the platform did not provide a hostname for this code".into())
            })?;
            Some(tunnel::ProvisionedTunnel {
                tunnel_token: token,
                hostname,
            })
        }
        SetupMode::Local => None,
    };

    let plan = plan_run(
        request,
        &values,
        provisioned.as_ref().map(|p| p.tunnel_token.clone()),
        provisioned.as_ref().map(|p| p.hostname.clone()),
    );

    reporter.started("container", "Starting your sandbox");
    docker::ensure_network(engine, &plan.names.network)?;
    docker::rm_force(engine, &plan.names.container);
    let arg_refs: Vec<&str> = plan.args.iter().map(String::as_str).collect();
    docker::capture(engine, &arg_refs)?;
    reporter.done("container");

    if let Some(token) = &plan.tunnel_token {
        reporter.started("sidecar", "Connecting the tunnel");
        docker::rm_force(engine, &plan.names.tunnel_container);
        docker::capture(
            engine,
            &[
                "run",
                "-d",
                "--restart",
                "unless-stopped",
                "--name",
                &plan.names.tunnel_container,
                "--network",
                &plan.names.network,
                "--log-opt",
                "max-size=10m",
                "--log-opt",
                "max-file=3",
                CLOUDFLARED_IMAGE,
                "tunnel",
                "--no-autoupdate",
                "run",
                "--token",
                token,
            ],
        )?;
        reporter.done("sidecar");
    }

    reporter.started("health", "Waiting for the daemon");
    health_wait(engine, &plan.names.container, reporter)?;
    reporter.done("health");

    Ok(SandboxRecord {
        slug: plan.slug,
        name: request.name.clone(),
        mode: request.mode,
        url: plan.public_url,
        container: plan.names.container.clone(),
        sync_pair_token: values.sync_pair_token,
    })
}

/// connect.sh's ensure_image: registry refs are always pulled fresh (the moving `stable` tag);
/// a registry-less dev tag is used from the local store only.
pub fn ensure_image(engine: &Engine, image: &str, reporter: &dyn Reporter) -> Result<()> {
    if !is_registry_image(image) {
        if docker::capture(engine, &["image", "inspect", "--format", "{{.Id}}", image]).is_ok() {
            reporter.log("image", &format!("using the local {image} image"));
            return Ok(());
        }
        return Err(Error::Setup(format!(
            "the dev image {image} is not in the local Docker store — build it with `pnpm build:sandbox` first"
        )));
    }
    docker::stream(engine, &["pull", image], reporter, "image")
}

pub fn health_wait(engine: &Engine, container: &str, reporter: &dyn Reporter) -> Result<()> {
    // connect.sh gives the daemon 30s; a cold WSL distro or slow disk deserves more headroom.
    for attempt in 0..45 {
        if docker::exec_capture(
            engine,
            container,
            &["curl", "-sf", "http://localhost:8787/health"],
        )
        .is_ok()
        {
            return Ok(());
        }
        if attempt % 5 == 4 {
            reporter.log("health", "still waiting for the daemon to come up…");
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    let logs = docker::logs_tail(engine, container, 50).unwrap_or_default();
    Err(Error::Setup(format!(
        "the sandbox did not become healthy — recent container logs:\n{logs}"
    )))
}

/// Pull the current image and recreate the container with its env/mounts/ports replayed —
/// rebuild.sh/update.sh semantics, volumes untouched.
pub fn update(engine: &Engine, slug: &str, reporter: &dyn Reporter) -> Result<()> {
    let names = Names::for_slug(slug);
    let env = docker::inspect_env(engine, &names.container)?;
    let image = env
        .iter()
        .find(|(key, _)| key == "SANDBOX_IMAGE")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| SANDBOX_IMAGE.to_string());

    reporter.started("image", "Pulling the latest sandbox image");
    ensure_image(engine, &image, reporter)?;
    reporter.done("image");

    let mut args: Vec<String> = [
        "run",
        "-d",
        "--init",
        "--restart",
        "unless-stopped",
        "--name",
        &names.container,
        "--network",
        &names.network,
        "--network-alias",
        ORIGIN_HOST,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=3",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    for dns in SANDBOX_DNS {
        args.push("--dns".into());
        args.push(dns.into());
    }
    args.push("-v".into());
    args.push(format!("{}:/work", names.workspace_volume));
    args.push("-v".into());
    args.push(format!("{}:/history", names.history_volume));
    for (binding, port) in docker::published_ports(engine, &names.container) {
        args.push("-p".into());
        args.push(format!("{binding}:{port}"));
    }
    if let Some(source) = docker::mount_source(engine, &names.container, "/agent-auth") {
        args.push("-v".into());
        args.push(format!("{source}:/agent-auth"));
    }
    for key in ENV_REPLAY {
        if let Some((_, value)) = env.iter().find(|(k, _)| k == key) {
            if !value.is_empty() {
                args.push("-e".into());
                args.push(format!("{key}={value}"));
            }
        }
    }
    args.push("-e".into());
    args.push(format!("SANDBOX_IMAGE={image}"));
    args.push(image);

    reporter.started("container", "Recreating the sandbox");
    docker::rm_force(engine, &names.container);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker::capture(engine, &arg_refs)?;
    reporter.done("container");

    reporter.started("health", "Waiting for the daemon");
    health_wait(engine, &names.container, reporter)?;
    reporter.done("health");
    Ok(())
}

/// cleanup.sh's remove_slug: containers, the named volumes docker rm won't touch, and the network.
pub fn remove(engine: &Engine, slug: &str) {
    let names = Names::for_slug(slug);
    for container in [
        &names.container,
        &names.tunnel_container,
        &format!("intentic-dind-host-{slug}"),
    ] {
        docker::rm_force(engine, container);
    }
    for volume in [
        &names.workspace_volume,
        &names.history_volume,
        &format!("intentic-dind-docker-{slug}"),
    ] {
        let _ = engine.docker(["volume", "rm", "-f", volume]).output();
    }
    let _ = engine.docker(["network", "rm", &names.network]).output();
}

pub fn start(engine: &Engine, slug: &str) -> Result<()> {
    let names = Names::for_slug(slug);
    docker::capture(engine, &["start", &names.container])?;
    if docker::container_state(engine, &names.tunnel_container).is_some() {
        docker::capture(engine, &["start", &names.tunnel_container])?;
    }
    Ok(())
}

pub fn stop(engine: &Engine, slug: &str) -> Result<()> {
    let names = Names::for_slug(slug);
    if docker::container_state(engine, &names.tunnel_container).is_some() {
        let _ = engine.docker(["stop", &names.tunnel_container]).output();
    }
    docker::capture(engine, &["stop", &names.container])?;
    Ok(())
}

pub fn list(engine: &Engine) -> Result<Vec<SandboxStatus>> {
    let rows = docker::ps_intentic(engine)?;
    let tunnel_states: std::collections::BTreeMap<String, bool> = rows
        .iter()
        .filter_map(|row| {
            let slug = row.names.strip_prefix("intentic-sandbox-tunnel-")?;
            Some((slug.to_string(), row.state == "running"))
        })
        .collect();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let slug = row.names.strip_prefix("intentic-sandbox-")?;
            if slug.starts_with("tunnel-") {
                return None;
            }
            let env = docker::inspect_env(engine, &row.names).unwrap_or_default();
            let url = env
                .iter()
                .find(|(key, _)| key == "SANDBOX_PUBLIC_URL")
                .map(|(_, value)| value.clone());
            Some(SandboxStatus {
                slug: slug.to_string(),
                container: row.names.clone(),
                running: row.state == "running",
                image: row.image.clone(),
                url,
                name: None,
                tunnel_running: tunnel_states.get(slug).copied(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(mode: SetupMode) -> SetupRequest {
        SetupRequest {
            platform_url: "https://app.intentic.dev".into(),
            code: "code".into(),
            mode,
            name: Some("work".into()),
            cf_token: (mode == SetupMode::Own).then(|| "cf-token".into()),
            sync_dir: None,
            image: None,
        }
    }

    fn values() -> ClaimValues {
        ClaimValues {
            connect_token: "token".into(),
            owner_email: Some("user@example.com".into()),
            sync_pair_token: Some("pair".into()),
            ..ClaimValues::default()
        }
    }

    #[test]
    fn registry_detection_matches_connect_sh() {
        assert!(is_registry_image(
            "registry.gitlab.com/radarsu/intentic/sandbox:stable"
        ));
        assert!(is_registry_image("localhost/x:dev"));
        assert!(is_registry_image("localhost:5000/x"));
        assert!(!is_registry_image("intentic-sandbox:dev"));
        assert!(!is_registry_image("ubuntu"));
    }

    #[test]
    fn platform_url_rewrites_loopback_for_the_container() {
        assert_eq!(
            platform_url_for_container("http://localhost:6480"),
            "http://host.docker.internal:6480"
        );
        assert_eq!(
            platform_url_for_container("https://127.0.0.1:6480"),
            "https://host.docker.internal:6480"
        );
        assert_eq!(
            platform_url_for_container("https://app.intentic.dev"),
            "https://app.intentic.dev"
        );
    }

    #[test]
    fn intentic_mode_run_args_mirror_connect_sh() {
        let plan = plan_run(
            &request(SetupMode::Intentic),
            &values(),
            Some("tunnel-token".into()),
            Some("sandbox-3c469e9d6c58.intentic.dev".into()),
        );
        assert_eq!(plan.slug, "sandbox-3c469e9d6c58");
        assert_eq!(plan.public_url, "https://sandbox-3c469e9d6c58.intentic.dev");
        let line = plan.args.join(" ");
        assert!(line.starts_with(
            "run -d --init --restart unless-stopped --name intentic-sandbox-sandbox-3c469e9d6c58 \
             --network intentic-workspace-sandbox-3c469e9d6c58 --network-alias intentic-sandbox-workspace \
             --add-host host.docker.internal:host-gateway --log-opt max-size=10m --log-opt max-file=3 \
             --dns 1.1.1.1 --dns 1.0.0.1"
        ));
        assert!(line.contains("-v intentic-workspace-sandbox-3c469e9d6c58:/work"));
        assert!(line.contains("-v intentic-history-sandbox-3c469e9d6c58:/history"));
        assert!(line.contains("-e SANDBOX_HOST=0.0.0.0"));
        assert!(line.contains("-e CONNECT_TOKEN=token"));
        assert!(line.contains("-e OWNER_EMAIL=user@example.com"));
        assert!(line.contains("-e SANDBOX_PUBLIC_URL=https://sandbox-3c469e9d6c58.intentic.dev"));
        assert!(line.contains("-e PLATFORM_URL=https://app.intentic.dev"));
        assert!(line.contains(&format!("-e GOOGLE_CLIENT_ID={GOOGLE_CLIENT_ID}")));
        assert!(!line.contains("-p "), "tunnel mode publishes no host ports");
        assert!(!line.contains("CLOUDFLARE_API_TOKEN"));
        assert!(line.ends_with(SANDBOX_IMAGE));
    }

    #[test]
    fn local_mode_publishes_loopback_ports_and_announces_the_local_url() {
        let plan = plan_run(&request(SetupMode::Local), &values(), None, None);
        // No hostname/subdomain → the slug falls back to the token hash.
        assert_eq!(plan.slug, "3c469e9d6c58");
        assert_eq!(plan.public_url, "http://127.0.0.1:8787");
        let line = plan.args.join(" ");
        assert!(line.contains("-p 127.0.0.1:8787:8787"));
        assert!(line.contains("-p 127.0.0.1:5173:5173"));
        assert!(line.contains("-e SANDBOX_PUBLIC_URL=http://127.0.0.1:8787"));
        assert!(plan.tunnel_token.is_none());
    }

    #[test]
    fn own_mode_carries_the_cloudflare_token_into_the_sandbox() {
        let mut own_values = values();
        own_values.zone = Some("example.com".into());
        own_values.subdomain = Some("sandbox-custom".into());
        let plan = plan_run(
            &request(SetupMode::Own),
            &own_values,
            Some("tt".into()),
            Some("sandbox-custom.example.com".into()),
        );
        assert_eq!(plan.slug, "sandbox-custom");
        let line = plan.args.join(" ");
        assert!(line.contains("-e CLOUDFLARE_API_TOKEN=cf-token"));
        assert!(line.contains("-e SANDBOX_PUBLIC_URL=https://sandbox-custom.example.com"));
    }

    #[test]
    fn empty_env_values_are_omitted_not_replayed() {
        let mut bare = values();
        bare.owner_email = None;
        bare.sync_pair_token = None;
        let plan = plan_run(&request(SetupMode::Local), &bare, None, None);
        let line = plan.args.join(" ");
        assert!(!line.contains("OWNER_EMAIL"));
        assert!(!line.contains("SYNC_PAIR_TOKEN"));
    }
}
