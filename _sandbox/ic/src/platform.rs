use std::time::Duration;

use crate::util::{bail, kv_lines, Result};

/* The setup-code claim. The platform's one-liner carries ONE short-lived code instead of raw tokens (nothing
 * secret lands in shell history or `ps`); redeeming it answers KEY=value lines — CONNECT_TOKEN plus either
 * the intentic-provided tunnel values or the own-Cloudflare zone/subdomain picks. */

/// What a claim can carry. SYNC_DIR is deliberately NOT here — it is the user's local-folder opt-in, carried
/// on the command as an env var, never through the platform.
#[derive(Default)]
pub struct Claim {
    pub connect_token: Option<String>,
    pub tunnel_token: Option<String>,
    pub sandbox_hostname: Option<String>,
    pub zone: Option<String>,
    pub subdomain: Option<String>,
    pub sync_pair_token: Option<String>,
    pub owner_email: Option<String>,
}

/// POST `<platform>/setup/claim` with the code. LOCAL DEV ONLY: a localhost platform runs on a repo-CA cert
/// the system doesn't trust, so localhost claims skip TLS verification — never for real domains.
pub fn claim(platform_url: &str, code: &str) -> Result<Claim> {
    println!("intentic: redeeming the setup code…");
    let localhost = platform_url.contains("//localhost") || platform_url.contains("//127.0.0.1");
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .disable_verification(localhost)
                .build(),
        )
        .build()
        .new_agent();
    let url = format!("{platform_url}/setup/claim");
    let body = match agent.post(&url).send_form([("code", code)]) {
        Ok(mut response) => response.body_mut().read_to_string().map_err(|err| {
            crate::util::Fail(format!(
                "could not read the platform's claim response: {err}"
            ))
        })?,
        // Name the real cause instead of always blaming the code: a 405 means PLATFORM_URL hit the static
        // web app (app.*) instead of the API (api.*); a 4xx means the code really is bad or expired.
        Err(ureq::Error::StatusCode(405)) => {
            bail!("{url} returned HTTP 405 — PLATFORM_URL must be the platform's API origin (e.g. https://api.intentic.dev), not the web app.")
        }
        Err(ureq::Error::StatusCode(400 | 401 | 403 | 404 | 410)) => {
            bail!("the setup code is invalid or expired — refresh the platform's setup page and copy a fresh command.")
        }
        Err(ureq::Error::StatusCode(status)) => {
            bail!("the platform returned HTTP {status} redeeming the setup code — refresh the setup page and try again.")
        }
        Err(_) => bail!("could not reach the platform at {platform_url} to redeem the setup code."),
    };
    let lookup = kv_lines(&body);
    Ok(Claim {
        connect_token: lookup("CONNECT_TOKEN"),
        tunnel_token: lookup("TUNNEL_TOKEN"),
        sandbox_hostname: lookup("SANDBOX_HOSTNAME"),
        zone: lookup("ZONE"),
        subdomain: lookup("SUBDOMAIN"),
        sync_pair_token: lookup("SYNC_PAIR_TOKEN"),
        owner_email: lookup("OWNER_EMAIL"),
    })
}
