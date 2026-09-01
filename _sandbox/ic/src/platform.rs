use std::time::Duration;

use crate::util::{bail, kv_lines, step, Result};

/* The setup-code claim. The platform's one-liner carries ONE short-lived code instead of raw tokens (nothing
 * secret lands in shell history or `ps`); redeeming it answers KEY=value lines — CONNECT_TOKEN plus either
 * the intentic-provided tunnel values or the own-Cloudflare zone/subdomain picks. */

/// What a claim can carry. SYNC_DIR is deliberately NOT here — it is the user's local-folder opt-in, carried
/// on the command as an env var, never through the platform.
#[derive(Default)]
pub struct Claim {
    pub connect_token: Option<String>,
    /// The sandbox's reachability grant on the self-hosted tunnel hub: the account token the in-box agent
    /// enables with, the hub as this machine reaches it, and the namespace its public names live under.
    /// Replaces the Cloudflare connector token this flow used to carry.
    pub sandbox_hostname: Option<String>,
    pub sync_pair_token: Option<String>,
    /// The one-shot pairing the CONNECTED-COMPUTER agent redeems, so this machine's sandboxes can be managed
    /// from the browser instead of from a terminal here. Minted per claim like the sync one beside it, and inert
    /// when the flow installs no agent.
    pub host_pair_token: Option<String>,
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
    // host.docker.internal is how a container spells "this machine" — the same three-host list the daemon's
    // announcer trusts (announce.ts LOCAL_HOSTS), and the spelling a containerized dev run hands this binary.
    matches!(
        host.as_deref(),
        Some("localhost" | "127.0.0.1" | "host.docker.internal")
    )
}

/// The agent every platform call uses. LOCAL DEV ONLY: a localhost platform runs on a repo-CA cert the
/// system doesn't trust, so localhost calls skip TLS verification — never for real domains.
pub fn agent_for(platform_url: &str) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .disable_verification(is_local(platform_url))
                .build(),
        )
        .build()
        .new_agent()
}

/// POST `<platform>/setup/claim` with the code.
pub fn claim(platform_url: &str, code: &str) -> Result<Claim> {
    step("claiming-code", "redeeming the setup code…");
    let agent = agent_for(platform_url);
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
        sandbox_hostname: lookup("SANDBOX_HOSTNAME"),
        sync_pair_token: lookup("SYNC_PAIR_TOKEN"),
        host_pair_token: lookup("HOST_PAIR_TOKEN"),
        owner_email: lookup("OWNER_EMAIL"),
    })
}

/* SETUP TELEMETRY FOR THE WIZARD — the terminal is not where the user is looking.
 *
 * The setup wizard sits in a browser watching the registry while this flow runs in a terminal the user may
 * have closed, on a machine the browser cannot see. Until this existed, the wizard's only evidence was the
 * claim timestamp: anything that failed after it — a dead pull, a rejected tunnel, a container that never
 * came healthy — left the browser guessing by elapsed time, and the real reason scrolled away in a window
 * nobody was watching. Every stage transition and every terminal failure is therefore POSTed to
 * /setup/report against the same setup code the claim used: possession of a live code is the auth, exactly
 * the claim's trust.
 *
 * Reporting is BEST-EFFORT BY DESIGN: its own short timeout, every error swallowed. The report exists to
 * explain a failure, so it must never cause one — and a headless install with no setup code (env-var-only)
 * simply has no wizard watching, so `code: None` makes every call a no-op. */
pub struct Reporter {
    platform_url: String,
    code: Option<String>,
    stage: std::cell::RefCell<String>,
    // A structured failure already went out — the flow's closing prose must not overwrite it with less.
    reported: std::cell::Cell<bool>,
}

impl Reporter {
    pub fn new(platform_url: &str, code: Option<String>) -> Self {
        Reporter {
            platform_url: platform_url.to_string(),
            code,
            stage: std::cell::RefCell::new("preflight".to_string()),
            reported: std::cell::Cell::new(false),
        }
    }

    /// A stage transition: remembered (it names any later failure) and shown on the wizard as live progress.
    pub fn stage(&self, stage: &str) {
        *self.stage.borrow_mut() = stage.to_string();
        self.post(stage, Vec::new());
    }

    /// A check run's collected findings — preflight or postflight — under the stage that ran them.
    pub fn findings_failed(&self, stage: &str, failures: Vec<crate::checks::WireFailure>) {
        self.reported.set(true);
        self.post(stage, failures);
    }

    /// A terminal failure anywhere in the flow: the current stage plus the flow's own message. The remedy is
    /// left empty — the flow's messages already carry their fix, and the wizard adds the one instruction
    /// that is always true (fix it and re-run the same command).
    pub fn failure(&self, message: &str) {
        if self.reported.get() {
            return;
        }
        let stage = self.stage.borrow().clone();
        self.post(
            &stage,
            vec![crate::checks::WireFailure {
                check: stage.clone(),
                problem: message.to_string(),
                remedy: String::new(),
            }],
        );
    }

    fn post(&self, stage: &str, failed: Vec<crate::checks::WireFailure>) {
        let Some(code) = &self.code else {
            return;
        };
        // The platform's schema caps each field at 2000 chars and rejects the WHOLE report past it — and a
        // flow failure can carry a docker log tail. A clipped reason on the wizard beats none at all.
        let failed: Vec<crate::checks::WireFailure> = failed
            .into_iter()
            .map(|failure| crate::checks::WireFailure {
                check: clip(failure.check, 120),
                problem: clip(failure.problem, 2000),
                remedy: clip(failure.remedy, 2000),
            })
            .collect();
        // Not agent_for's 30s: a slow platform must not stall the setup it is only narrating.
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(5)))
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .disable_verification(is_local(&self.platform_url))
                    .build(),
            )
            .build()
            .new_agent();
        let body = serde_json::json!({ "code": code, "stage": stage, "failed": failed });
        let _ = agent
            .post(format!("{}/setup/report", self.platform_url))
            .send_json(&body);
    }
}

/// Clip to `max` chars on a char boundary, marking the cut — validators count Unicode code points, and a
/// byte-truncation could split a multi-byte character and produce invalid UTF-8 wire bytes.
fn clip(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        return text;
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipping_respects_char_boundaries_and_short_text() {
        assert_eq!(clip("short".into(), 10), "short");
        let clipped = clip("é".repeat(30), 10);
        assert_eq!(clipped.chars().count(), 10);
        assert!(clipped.ends_with('…'));
    }

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
