use std::time::Duration;

use serde::Deserialize;

use crate::util::{bail, Result};

/* The connect preflight checks the owner's Cloudflare token (CF_TOKEN) here, directly against Cloudflare. */

const API: &str = "https://api.cloudflare.com/client/v4";

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .new_agent()
}

#[derive(Deserialize)]
struct VerifyEnvelope {
    success: bool,
    #[serde(default)]
    result: Option<VerifyResult>,
}

#[derive(Deserialize)]
struct VerifyResult {
    #[serde(default)]
    status: String,
}

/// Token verify — the same Bearer/api.cloudflare.com auth intentic itself uses. A network failure is
/// reported as such, never conflated with a bad token; an auth status IS the bad-token answer.
pub fn validate_token(token: &str) -> Result<()> {
    let invalid = || {
        crate::util::Fail(
            "the Cloudflare API token is invalid or inactive (token verify failed). Re-check the token and its scopes (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit) at https://dash.cloudflare.com/profile/api-tokens.".to_string(),
        )
    };
    let mut response = match agent()
        .get(format!("{API}/user/tokens/verify"))
        .header("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(401 | 403)) => return Err(invalid()),
        Err(err) => bail!("could not reach the Cloudflare API to validate the token: {err}"),
    };
    let envelope: VerifyEnvelope = response.body_mut().read_json().map_err(|_| invalid())?;
    if !envelope.success
        || envelope.result.map(|result| result.status) != Some("active".to_string())
    {
        return Err(invalid());
    }
    Ok(())
}
