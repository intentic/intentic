use crate::cloudflare;
use crate::docker;
use crate::logfile::Log;
use crate::selfhost;
use crate::util::{bail, kv_lines, normalize_host_name, Result};

/* Enroll THIS machine as a deploy target for an existing sandbox — connect-host.sh as a verb.
 *
 * Run it on any host intentic should deploy onto — the sandbox's own machine or another; on as many machines
 * as you like (intentic splits services across them). It creates a dedicated service user + SSH key, exposes
 * this host's sshd over its OWN Cloudflare tunnel (ssh-<id>.<zone>), and self-registers with the sandbox's
 * daemon via POST /enroll (authenticated by the connection token). It does NOT create or recreate a sandbox.
 *
 * Two paths, matching the sandbox's setup mode (the Infra screen hands out the right one-liner): own
 * Cloudflare (CF_TOKEN creates the tunnel + DNS on the user's zone), or intentic-provided (the platform
 * minted the tunnel; the command carries its narrow connector token instead — no Cloudflare token here). */

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

pub fn run() -> Result<()> {
    let sandbox_url = env("SANDBOX_URL").unwrap_or_default();
    let connect_token = env("CONNECT_TOKEN").unwrap_or_default();
    let cf_token = env("CF_TOKEN").unwrap_or_default();
    let mut zone = env("ZONE").unwrap_or_default();
    let host_tunnel_token = env("HOST_SSH_TUNNEL_TOKEN").unwrap_or_default();
    let host_hostname = env("HOST_SSH_HOSTNAME").unwrap_or_default();
    let host_user = env("HOST_USER").unwrap_or_else(|| "intentic".to_string());
    let sandbox_image =
        env("SANDBOX_IMAGE").unwrap_or_else(|| "ghcr.io/intentic/sandbox:stable".to_string());
    let cloudflared_version = env("CLOUDFLARED_VERSION").unwrap_or_else(|| "2026.7.2".to_string());

    // Pre-provisioned host tunnel (intentic-provided sandboxes): the platform minted tunnel + DNS under its
    // own zone. HOST_NAME is then REQUIRED: the minted tunnel id is salted with the name picked on the Infra
    // screen, so a machine-hostname default here would silently desync from it.
    let provided_tunnel = !host_tunnel_token.is_empty() && !host_hostname.is_empty();
    let host_name = match env("HOST_NAME") {
        Some(raw) => {
            let normalized = normalize_host_name(&raw);
            if normalized.is_empty() && provided_tunnel {
                bail!("HOST_NAME could not be normalized to a deploy target id — copy the one-liner from the Infra screen.");
            }
            if normalized.is_empty() {
                default_host_name()
            } else {
                normalized
            }
        }
        None if provided_tunnel => bail!("HOST_NAME is required with a pre-provisioned tunnel — copy the one-liner from the Infra screen."),
        None => default_host_name(),
    };

    // Enrollment mutates the host (creates a user, installs packages), so it needs root — checked before
    // anything else rather than failing deep in a package install.
    let root = selfhost::Root::acquire("machine enrolment")?;

    println!("intentic: checking Docker…");
    docker::require_daemon()?;

    if sandbox_url.is_empty()
        || connect_token.is_empty()
        || (!provided_tunnel && cf_token.is_empty())
    {
        bail!("SANDBOX_URL and CONNECT_TOKEN (plus CF_TOKEN, unless the tunnel is pre-provisioned) are required — copy the one-liner from the Infra screen.");
    }
    if !provided_tunnel {
        cloudflare::validate_token(&cf_token)?;
        if zone.is_empty() {
            zone = cloudflare::resolve_zone(&cf_token, "this host's tunnel")?;
        }
    }

    let host_ssh_key = selfhost::setup_service_user(&root, &host_user, "intentic-host")?;
    println!("intentic: registered '{host_user}' on this host as deploy target \"{host_name}\".");

    let log = Log::create("connect-host")?;
    println!("intentic: pulling the intentic CLI image ({sandbox_image})…");
    docker::pull(&sandbox_image, &log)?;

    let (connector_token, host_address);
    if provided_tunnel {
        println!("intentic: using the pre-provisioned host SSH tunnel ({host_hostname}).");
        connector_token = host_tunnel_token;
        host_address = host_hostname;
    } else {
        println!("intentic: creating this host's SSH tunnel…");
        let mut args: Vec<String> = vec![
            "run".into(),
            "--rm".into(),
            "--entrypoint".into(),
            "intentic".into(),
            "-e".into(),
            format!("CLOUDFLARE_API_TOKEN={cf_token}"),
            "-e".into(),
            format!("CONNECT_TOKEN={connect_token}"),
            "-e".into(),
            format!("HOST_NAME={host_name}"),
        ];
        if !zone.is_empty() {
            args.push("-e".into());
            args.push(format!("ZONE={zone}"));
        }
        args.extend([sandbox_image.clone(), "tunnel".into(), "host".into()]);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = docker::capture(&arg_refs).map_err(|err| {
            crate::util::Fail(format!(
                "failed to create this host's SSH tunnel: {}",
                err.0
            ))
        })?;
        let lookup = kv_lines(&out);
        connector_token = lookup("HOST_SSH_TUNNEL_TOKEN").unwrap_or_default();
        host_address = lookup("HOST_SSH_HOSTNAME").unwrap_or_default();
        if connector_token.is_empty() || host_address.is_empty() {
            bail!("failed to create this host's SSH tunnel (see the output above).");
        }
    }
    selfhost::install_cloudflared(&root, &cloudflared_version)?;
    selfhost::run_ssh_connector(&root, &connector_token, "the connect-host one-liner")?;

    // Self-register with the sandbox's daemon. cfToken rides along only on the own-Cloudflare path — the
    // pre-provisioned one has no token to hand over. (The script had to JSON-encode the multi-line key
    // through the image's node; a real JSON serializer is the whole of what that hack asked for.)
    println!("intentic: enrolling with the sandbox…");
    let mut body = serde_json::json!({
        "name": host_name,
        "user": host_user,
        "address": host_address,
        "port": 22,
        "via": "cloudflared",
        "sshKey": host_ssh_key,
    });
    if !cf_token.is_empty() {
        body["cfToken"] = serde_json::Value::String(cf_token.clone());
        body["cfZone"] = serde_json::Value::String(zone.clone());
    }
    let result = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(30)))
        .build()
        .new_agent()
        .post(format!("{sandbox_url}/enroll"))
        .header("x-intentic-connect", &connect_token)
        .header("content-type", "application/json")
        .send(body.to_string().as_bytes());
    match result {
        Ok(_) => {}
        Err(ureq::Error::StatusCode(code)) => {
            bail!("enroll failed (HTTP {code}). Is the sandbox reachable at {sandbox_url} and is the DevOps capability active?")
        }
        Err(_) => bail!("enroll failed — could not reach the sandbox at {sandbox_url}."),
    }

    println!("intentic: this machine is enrolled as deploy target \"{host_name}\" (SSH reachable at {host_address}).");
    println!("Provision from the Infra screen to deploy onto it. Re-run this command anytime to refresh the key/tunnel.");
    Ok(())
}

fn default_host_name() -> String {
    let hostname = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();
    let normalized = normalize_host_name(&hostname);
    if normalized.is_empty() {
        "host".to_string()
    } else {
        normalized
    }
}
