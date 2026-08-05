use std::time::Duration;

use serde::Deserialize;

use crate::tty;
use crate::util::{bail, Result};

/* The two Cloudflare calls the connect flows make DIRECTLY (everything else — tunnel + DNS creation — goes
 * through `intentic tunnel …` inside the image, where the logic lives once). Validated up front rather than
 * failing later deep inside `intentic deploy apply`: Cloudflare is the reachability fabric, and a bad token
 * should stop the flow while the user is still looking at it. The token never reaches the platform. */

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
    println!("intentic: validating Cloudflare API token…");
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

#[derive(Deserialize)]
struct ZonesEnvelope {
    #[serde(default)]
    result: Vec<Zone>,
}

#[derive(Deserialize)]
struct Zone {
    name: String,
}

/// Resolve the zone the tunnel lives under BEFORE the tunnel step, so a token that sees several zones gets a
/// clear choice here instead of a bare "multiple zones" crash deep inside the CLI: one zone auto-picks, more
/// prompt on the terminal, and a non-interactive run gets the exact remedy (set ZONE) with the options named.
pub fn resolve_zone(token: &str, subject: &str) -> Result<String> {
    println!("intentic: resolving the Cloudflare zone…");
    let mut response = agent()
        .get(format!("{API}/zones?per_page=50"))
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|err| crate::util::Fail(format!("could not list Cloudflare zones: {err}")))?;
    let envelope: ZonesEnvelope = response
        .body_mut()
        .read_json()
        .map_err(|err| crate::util::Fail(format!("could not list Cloudflare zones: {err}")))?;
    let zones: Vec<String> = envelope.result.into_iter().map(|zone| zone.name).collect();
    if zones.is_empty() {
        bail!("the Cloudflare API token sees no zones — add a domain to the account, or broaden the token's Zone:Read scope, at https://dash.cloudflare.com/profile/api-tokens, then re-run.");
    }
    if zones.len() == 1 {
        println!(
            "intentic: using the only zone the token sees — {}.",
            zones[0]
        );
        return Ok(zones[0].clone());
    }
    if tty::have_tty() {
        eprintln!("intentic: this Cloudflare token can use several zones — pick the one {subject} should use:");
        for (i, zone) in zones.iter().enumerate() {
            eprintln!("  {}) {zone}", i + 1);
        }
        let choice = tty::ask("intentic: zone number [1]: ").unwrap_or_default();
        let choice = if choice.is_empty() {
            "1".to_string()
        } else {
            choice
        };
        let index: usize = choice
            .parse()
            .map_err(|_| crate::util::Fail(format!("invalid selection '{choice}'.")))?;
        let zone = zones
            .get(index.wrapping_sub(1))
            .ok_or_else(|| crate::util::Fail(format!("'{choice}' is out of range.")))?;
        println!("intentic: using zone {zone}.");
        return Ok(zone.clone());
    }
    let listing: String = zones.iter().map(|zone| format!("  - {zone}\n")).collect();
    bail!(
        "the Cloudflare API token sees multiple zones; set ZONE to choose one. The token can use:\n{listing}       Re-run with ZONE set in the environment (alongside CF_TOKEN), e.g. ZONE={}",
        zones[0]
    );
}
