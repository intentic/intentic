use std::time::Duration;

use serde::Deserialize;

use crate::tty;
use crate::util::{bail, Result};

/* Connect flows call Cloudflare directly; tunnel and DNS creation use `intentic tunnel`. */

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

#[derive(Deserialize)]
struct ZonesEnvelope {
    #[serde(default)]
    result: Vec<Zone>,
    #[serde(default)]
    result_info: Option<PageInfo>,
}

#[derive(Deserialize)]
struct PageInfo {
    #[serde(default)]
    total_pages: u32,
}

/// How many pages of 50 zones are read before the list is taken as complete: an account with more than a thousand
/// zones picks from the first thousand rather than holding a setup on a request per page.
const ZONE_PAGES_MAX: u32 = 20;

/// Whether the page just read says there is another after it. A reply that names no page count is a single page, as
/// the platform's and the deploy engine's own clients read it (`_platform/api/src/sandbox/cloudflare.ts`,
/// `_deploy/providers/src/network/cloudflare-api.ts`), which this one used to differ from by reading page one only.
fn more_zone_pages(envelope: &ZonesEnvelope, page: u32) -> bool {
    page < ZONE_PAGES_MAX
        && envelope
            .result_info
            .as_ref()
            .is_some_and(|info| info.total_pages > page)
}

/// Every zone name the token can see, 50 to a page.
fn zone_names(token: &str) -> Result<Vec<String>> {
    let mut names = Vec::new();
    let mut page = 1;
    loop {
        let mut response = agent()
            .get(format!("{API}/zones?per_page=50&page={page}"))
            .header("Authorization", &format!("Bearer {token}"))
            .call()
            .map_err(|err| crate::util::Fail(format!("could not list Cloudflare zones: {err}")))?;
        let envelope: ZonesEnvelope = response
            .body_mut()
            .read_json()
            .map_err(|err| crate::util::Fail(format!("could not list Cloudflare zones: {err}")))?;
        let more = more_zone_pages(&envelope, page);
        names.extend(envelope.result.into_iter().map(|zone| zone.name));
        if !more {
            return Ok(names);
        }
        page += 1;
    }
}

#[derive(Deserialize)]
struct Zone {
    name: String,
}

/// Resolve the zone the tunnel lives under BEFORE the tunnel step, so a token that sees several zones gets a
/// clear choice here instead of a bare "multiple zones" crash deep inside the CLI: one zone auto-picks, more
/// prompt on the terminal, and a non-interactive run gets the exact remedy (set ZONE) with the options named.
pub fn resolve_zone(token: &str, subject: &str) -> Result<String> {
    crate::ui::note("resolving the Cloudflare zone…");
    let zones = zone_names(token)?;
    if zones.is_empty() {
        bail!("the Cloudflare API token sees no zones — add a domain to the account, or broaden the token's Zone:Read scope, at https://dash.cloudflare.com/profile/api-tokens, then re-run.");
    }
    if zones.len() == 1 {
        crate::ui::note(&format!(
            "using the only zone the token sees — {}.",
            zones[0]
        ));
        return Ok(zones[0].clone());
    }
    if tty::have_tty() {
        // A question owns the screen while it is asked — see the same handover in sandbox/connect.rs.
        crate::ui::suspend();
        eprintln!("\nintentic: this Cloudflare token can use several zones — pick the one {subject} should use:");
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
        println!();
        crate::ui::resume();
        crate::ui::note(&format!("using zone {zone}."));
        return Ok(zone.clone());
    }
    let listing: String = zones.iter().map(|zone| format!("  - {zone}\n")).collect();
    bail!(
        "the Cloudflare API token sees multiple zones; set ZONE to choose one. The token can use:\n{listing}       Re-run with ZONE set in the environment (alongside CF_TOKEN), e.g. ZONE={}",
        zones[0]
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn zone_pages_follow_the_count_the_reply_names() {
        let page = |json: &str| serde_json::from_str::<super::ZonesEnvelope>(json).unwrap();
        let first_of_three =
            page(r#"{"result":[{"name":"a.dev"}],"result_info":{"page":1,"total_pages":3}}"#);
        assert!(super::more_zone_pages(&first_of_three, 1));
        assert!(!super::more_zone_pages(&first_of_three, 3));
        // No count named: one page, as the TypeScript clients read it.
        assert!(!super::more_zone_pages(&page(r#"{"result":[]}"#), 1));
        // A count past the cap stops at the cap rather than walking every page.
        let huge = page(r#"{"result":[],"result_info":{"total_pages":500}}"#);
        assert!(super::more_zone_pages(&huge, super::ZONE_PAGES_MAX - 1));
        assert!(!super::more_zone_pages(&huge, super::ZONE_PAGES_MAX));
    }
}
