use std::collections::BTreeMap;

use crate::http;
use crate::types::{Error, Result};

/// What `POST /setup/claim` redeems a setup code for — the same KEY=value contract connect.sh parses.
#[derive(Debug, Clone, Default)]
pub struct ClaimValues {
    pub connect_token: String,
    pub owner_email: Option<String>,
    pub sync_pair_token: Option<String>,
    /// Intentic-provided path: run the sidecar with this connector token, no Cloudflare API calls.
    pub tunnel_token: Option<String>,
    pub sandbox_hostname: Option<String>,
    /// Own-Cloudflare path: provision the tunnel ourselves under this zone/subdomain.
    pub zone: Option<String>,
    pub subdomain: Option<String>,
}

pub fn claim(platform_url: &str, code: &str) -> Result<ClaimValues> {
    let url = format!("{}/setup/claim", platform_url.trim_end_matches('/'));
    let body = http::post_form(&url, &[("code", code)])?;
    let values = parse_claim(&body);
    if values.connect_token.is_empty() {
        return Err(Error::Setup(
            "the setup code was not accepted (expired or already used) — mint a fresh one on the setup page".into(),
        ));
    }
    Ok(values)
}

pub fn parse_claim(body: &str) -> ClaimValues {
    let map: BTreeMap<&str, &str> = body
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect();
    let get = |key: &str| {
        map.get(key)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
    };
    ClaimValues {
        connect_token: get("CONNECT_TOKEN").unwrap_or_default(),
        owner_email: get("OWNER_EMAIL"),
        sync_pair_token: get("SYNC_PAIR_TOKEN"),
        tunnel_token: get("TUNNEL_TOKEN"),
        sandbox_hostname: get("SANDBOX_HOSTNAME"),
        zone: get("ZONE"),
        subdomain: get("SUBDOMAIN"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_intentic_path_payload() {
        let body = "CONNECT_TOKEN=abc123\nTUNNEL_TOKEN=eyJ0dW5uZWw\nSANDBOX_HOSTNAME=sandbox-3c469e9d6c58.intentic.dev\nSYNC_PAIR_TOKEN=pair\nOWNER_EMAIL=user@example.com\n";
        let values = parse_claim(body);
        assert_eq!(values.connect_token, "abc123");
        assert_eq!(values.tunnel_token.as_deref(), Some("eyJ0dW5uZWw"));
        assert_eq!(
            values.sandbox_hostname.as_deref(),
            Some("sandbox-3c469e9d6c58.intentic.dev")
        );
        assert_eq!(values.owner_email.as_deref(), Some("user@example.com"));
        assert_eq!(values.zone, None);
    }

    #[test]
    fn parses_the_own_cloudflare_payload_and_ignores_noise() {
        let body =
            "CONNECT_TOKEN=abc\nZONE=example.com\nSUBDOMAIN=sandbox-abc\nEMPTY=\nnot a pair\n";
        let values = parse_claim(body);
        assert_eq!(values.zone.as_deref(), Some("example.com"));
        assert_eq!(values.subdomain.as_deref(), Some("sandbox-abc"));
        assert_eq!(values.tunnel_token, None);
    }
}
