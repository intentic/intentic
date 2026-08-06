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

/* Is this address a platform on THIS machine? The one question that turns TLS verification off, so it is
 * asked of the parsed HOST and nothing else.
 *
 * It used to be a substring search for "//localhost" anywhere in the string, which any address can be dressed
 * up to satisfy — `https://not-your-platform.example//localhost` is a perfectly ordinary URL whose host is
 * not local at all, and it silently bought a claim that accepts any certificate. `http::Uri` is already in
 * this binary's dependency graph (ureq parses with it), so the honest answer costs nothing to ship. */
fn is_local(platform_url: &str) -> bool {
    let host = platform_url
        .parse::<http::Uri>()
        .ok()
        .and_then(|uri| uri.host().map(str::to_ascii_lowercase));
    matches!(host.as_deref(), Some("localhost" | "127.0.0.1"))
}

/// POST `<platform>/setup/claim` with the code. LOCAL DEV ONLY: a localhost platform runs on a repo-CA cert
/// the system doesn't trust, so localhost claims skip TLS verification — never for real domains.
pub fn claim(platform_url: &str, code: &str) -> Result<Claim> {
    println!("intentic: redeeming the setup code…");
    let localhost = is_local(platform_url);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_local_host_skips_verification() {
        assert!(is_local("http://localhost:6480"));
        assert!(is_local("https://127.0.0.1:6480/api"));
        assert!(is_local("http://LOCALHOST:6480"));
        assert!(!is_local("https://api.intentic.dev"));
    }

    /* THE DRESSED-UP ADDRESS THE OLD SUBSTRING CHECK ACCEPTED.
     *
     * Every one of these contains "//localhost" or "//127.0.0.1" somewhere, and not one of them is served by
     * this machine — so each used to redeem a setup code over a connection that accepts any certificate. */
    #[test]
    fn a_remote_host_cannot_dress_itself_up_as_local() {
        assert!(!is_local("https://evil.example//localhost"));
        assert!(!is_local("https://evil.example/x//127.0.0.1"));
        assert!(!is_local("https://evil.example/?next=//localhost"));
        assert!(!is_local("https://localhost.evil.example"));
    }
}
