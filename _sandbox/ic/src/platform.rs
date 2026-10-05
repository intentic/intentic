use std::time::Duration;

use crate::util::{bail, kv_lines, step, Result};

/* The setup-code claim. */

/// What a claim can carry. SYNC_DIR is deliberately NOT here — it is the user's local-folder opt-in, carried
/// on the command as an env var, never through the platform.
#[derive(Default)]
pub struct Claim {
    pub connect_token: Option<String>,
    /* WHAT MAKES THE SANDBOX REACHABLE, and the two values are useless apart: a platform-signed grant naming this sandbox's id. */
    pub sandbox_grant: Option<String>,
    pub ingress_url: Option<String>,
    /// The public name the platform published for this sandbox — the address the browser opens, and the
    /// source of the slug every container, network and later command is keyed by.
    pub sandbox_hostname: Option<String>,
    pub sync_pair_token: Option<String>,
    /// The one-shot pairing the CONNECTED-DEVICE agent redeems, so this machine's sandboxes can be managed
    /// from the browser instead of from a terminal here. Minted per claim like the sync one beside it, and inert
    /// when the flow installs no agent.
    pub host_pair_token: Option<String>,
    pub owner_email: Option<String>,
    /// The arriving profile's own sandbox, as base64 TOML. The daemon applies it once, to a workspace that
    /// arrived empty; a machine that already holds work ignores it, so replaying a command cannot overwrite.
    pub definition_seed: Option<String>,
}

/* Is this address a platform on THIS machine? */
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

/// The same agent with a shorter deadline, for calls that only narrate (the fix engine's reports) or only probe.
pub fn agent_within(platform_url: &str, limit: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(limit))
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .disable_verification(is_local(platform_url))
                .build(),
        )
        .build()
        .new_agent()
}

/// The claim's form: the code, and which machine and side of it is claiming (`host`, the name a person knows this
/// machine by; `os`, the side ic stamps on the sandbox it starts, `windows` or `linux/archlinux`), clipped to what the
/// platform keeps (SetupClaimerSchema). (2026-10-05) The platform records the first machine that claims a code and
/// refuses the same code on a different one while it lives, so one pasted command can no longer start two copies of a
/// sandbox (PowerShell and WSL on one PC took turns holding its tunnel). Pure.
pub fn claim_form(code: &str, host: &str, os: &str) -> Vec<(&'static str, String)> {
    let clip = |text: &str, max: usize| text.trim().chars().take(max).collect::<String>();
    let mut form = vec![("code", code.to_string())];
    for (field, value) in [("host", clip(host, 120)), ("os", clip(os, 40))] {
        if !value.is_empty() {
            form.push((field, value));
        }
    }
    form
}

/// The platform's own sentence out of a refusal's body: plain text after `error: `, or a JSON body's `message` or
/// `error`. Pure.
pub fn refusal_sentence(body: &str) -> Option<String> {
    let body = body.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        return ["message", "error"]
            .iter()
            .find_map(|key| value[*key].as_str())
            .map(str::trim)
            .filter(|said| !said.is_empty())
            .map(str::to_string);
    }
    let said = body.strip_prefix("error:").unwrap_or(body).trim();
    (!said.is_empty()).then(|| said.to_string())
}

/// POST `<platform>/setup/claim` with the code, naming this machine and its side.
pub fn claim(platform_url: &str, code: &str) -> Result<Claim> {
    step("claiming-code", "redeeming the setup code…");
    // Statuses are answers here: a 409's body is the platform's sentence about where the code was already used.
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .disable_verification(is_local(platform_url))
                .build(),
        )
        .build()
        .new_agent();
    let url = format!("{platform_url}/setup/claim");
    let form = claim_form(
        code,
        &crate::sandbox::connect::machine_label(),
        &crate::sandbox::side::here().wire(),
    );
    let mut response = match agent
        .post(&url)
        .send_form(form.iter().map(|(field, value)| (*field, value.as_str())))
    {
        Ok(response) => response,
        Err(_) => bail!("could not reach the platform at {platform_url} to redeem the setup code."),
    };
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|err| {
        crate::util::Fail(format!(
            "could not read the platform's claim response: {err}"
        ))
    })?;
    match status {
        200..=299 => {}
        // The code is live, and was redeemed on another machine (or the other side of this one): the platform says
        // where, and what to do, better than any sentence made up here.
        409 => match refusal_sentence(&body) {
            Some(said) => bail!("{said}"),
            None => bail!("this setup code was already used on another machine, and running it here as well would start a second copy of the same sandbox."),
        },
        // Name the real cause instead of always blaming the code: a 405 means PLATFORM_URL hit the static
        // web app (app.*) instead of the API (api.*); a 4xx means the code really is bad or expired.
        405 => bail!("{url} returned HTTP 405 — PLATFORM_URL must be the platform's API origin (e.g. https://api.intentic.dev), not the web app."),
        400 | 401 | 403 | 404 | 410 => {
            bail!("the setup code is invalid or expired — refresh the platform's setup page and copy a fresh command.")
        }
        status => bail!("the platform returned HTTP {status} redeeming the setup code — refresh the setup page and try again."),
    }
    let lookup = kv_lines(&body);
    Ok(Claim {
        connect_token: lookup("CONNECT_TOKEN"),
        sandbox_grant: lookup("SANDBOX_GRANT"),
        ingress_url: lookup("INGRESS_URL"),
        sandbox_hostname: lookup("SANDBOX_HOSTNAME"),
        sync_pair_token: lookup("SYNC_PAIR_TOKEN"),
        host_pair_token: lookup("HOST_PAIR_TOKEN"),
        owner_email: lookup("OWNER_EMAIL"),
        definition_seed: lookup("SANDBOX_DEFINITION_SEED"),
    })
}

/// Why a request to the platform did not land.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// No answer: the network, a timeout, a name that did not resolve.
    Unreached,
    /// An answer, with this status.
    Status(u16),
}

/* When this container goes, it stops holding its tunnel — and so does a container that is merely stopped, and so does one whose machine went to sleep. */
pub fn farewell(
    platform_url: &str,
    connect_token: &str,
    removed_by: &str,
) -> std::result::Result<(), Refusal> {
    // The container's own PLATFORM_URL is spelled from INSIDE it; on a dev box that is host.docker.internal,
    // which resolves nowhere out here.
    let from_host = platform_url.replace("//host.docker.internal", "//localhost");
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .disable_verification(is_local(&from_host))
                .build(),
        )
        .build()
        .new_agent();
    match agent
        .post(format!("{from_host}/sandbox/farewell"))
        .header("x-intentic-connect", connect_token)
        .send_json(serde_json::json!({ "removedBy": removed_by }))
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::StatusCode(status)) => Err(Refusal::Status(status)),
        Err(_) => Err(Refusal::Unreached),
    }
}

/* SETUP TELEMETRY FOR THE WIZARD — the terminal is not where the user is looking. */
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
    fn a_claim_names_the_machine_and_its_side_within_what_the_platform_keeps() {
        let form = claim_form("abc", "ROG", "linux/archlinux");
        assert_eq!(
            form,
            vec![
                ("code", "abc".to_string()),
                ("host", "ROG".to_string()),
                ("os", "linux/archlinux".to_string()),
            ]
        );
        let long = claim_form("abc", "", &format!("linux/{}", "d".repeat(60)));
        assert_eq!(long.len(), 2, "an empty host is left out");
        assert_eq!(long[1].1.chars().count(), 40);
    }

    #[test]
    fn a_refused_claim_says_the_platforms_own_sentence() {
        assert_eq!(
            refusal_sentence(
                "error: this setup code was already used on rog (windows) 3 minutes ago, and …"
            )
            .as_deref(),
            Some("this setup code was already used on rog (windows) 3 minutes ago, and …")
        );
        assert_eq!(
            refusal_sentence(r#"{"message":"already used on rog (windows)"}"#).as_deref(),
            Some("already used on rog (windows)")
        );
        assert_eq!(
            refusal_sentence(r#"{"error":"used elsewhere"}"#).as_deref(),
            Some("used elsewhere")
        );
        assert_eq!(refusal_sentence("  "), None);
        assert_eq!(refusal_sentence("error: "), None);
    }

    #[test]
    fn only_a_real_local_host_skips_verification() {
        assert!(is_local("http://localhost:6480"));
        assert!(is_local("https://127.0.0.1:6480/api"));
        assert!(is_local("http://LOCALHOST:6480"));
        assert!(!is_local("https://api.intentic.dev"));
    }

    /* Every one of these contains "//localhost" or "//127.0.0.1" somewhere, and not one of them is served by this machine. */
    #[test]
    fn a_remote_host_cannot_dress_itself_up_as_local() {
        assert!(!is_local("https://evil.example//localhost"));
        assert!(!is_local("https://evil.example/x//127.0.0.1"));
        assert!(!is_local("https://evil.example/?next=//localhost"));
        assert!(!is_local("https://localhost.evil.example"));
    }
}
