use crate::docker;
use crate::progress::Reporter;
use crate::sandbox::ORIGIN_HOST;
use crate::types::{Engine, Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvisionedTunnel {
    pub tunnel_token: String,
    pub hostname: String,
}

/// Inputs of the own-Cloudflare provision — one struct so call sites read like the connect.sh env.
pub struct OwnTunnelSpec<'a> {
    pub image: &'a str,
    pub cf_token: &'a str,
    pub connect_token: &'a str,
    pub zone: Option<&'a str>,
    pub subdomain: Option<&'a str>,
}

/// Own-Cloudflare path: create/refresh the sandbox tunnel + DNS exactly like connect.sh — by running
/// the bundled CLI inside the sandbox image (`--entrypoint intentic … sandbox-tunnel`) and capturing
/// the TUNNEL_TOKEN/SANDBOX_HOSTNAME lines it prints on stdout.
pub fn provision_own(
    engine: &Engine,
    spec: &OwnTunnelSpec<'_>,
    reporter: &dyn Reporter,
    stage: &str,
) -> Result<ProvisionedTunnel> {
    let mut args: Vec<String> = vec![
        "run".into(),
        "--rm".into(),
        "--entrypoint".into(),
        "intentic".into(),
        "-e".into(),
        format!("CLOUDFLARE_API_TOKEN={}", spec.cf_token),
        "-e".into(),
        format!("CONNECT_TOKEN={}", spec.connect_token),
    ];
    if let Some(zone) = spec.zone {
        args.push("-e".into());
        args.push(format!("ZONE={zone}"));
    }
    args.extend([
        spec.image.to_string(),
        "sandbox-tunnel".into(),
        "--service".into(),
        format!("http://{ORIGIN_HOST}:8787"),
        "--preview-service".into(),
        format!("http://{ORIGIN_HOST}:5173"),
        "--ssh-service".into(),
        format!("ssh://{ORIGIN_HOST}:22"),
    ]);
    if let Some(subdomain) = spec.subdomain {
        args.push("--subdomain".into());
        args.push(subdomain.to_string());
    }
    reporter.log(stage, "creating your Cloudflare tunnel and DNS records…");
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = docker::capture(engine, &arg_refs)?;
    parse_tunnel_output(&stdout).ok_or_else(|| {
        Error::Setup(format!(
            "sandbox-tunnel did not report a tunnel token (output: {stdout})"
        ))
    })
}

pub fn parse_tunnel_output(stdout: &str) -> Option<ProvisionedTunnel> {
    let find = |key: &str| {
        stdout
            .lines()
            .find_map(|line| {
                line.strip_prefix(key)
                    .and_then(|rest| rest.strip_prefix('='))
            })
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Some(ProvisionedTunnel {
        tunnel_token: find("TUNNEL_TOKEN")?,
        hostname: find("SANDBOX_HOSTNAME")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_cli_stdout_contract() {
        let out = "TUNNEL_TOKEN=eyJhIjoi\nSANDBOX_HOSTNAME=sandbox-abc.example.com\nSANDBOX_SSH_HOSTNAME=ssh-abc.example.com\n";
        assert_eq!(
            parse_tunnel_output(out),
            Some(ProvisionedTunnel {
                tunnel_token: "eyJhIjoi".into(),
                hostname: "sandbox-abc.example.com".into()
            })
        );
        assert_eq!(parse_tunnel_output("progress noise only"), None);
    }
}
