use crate::cloudflare;
use crate::docker;
use crate::logfile::Log;
use crate::selfhost;
use crate::ui;
use crate::util::{bail, kv_lines, normalize_host_name, Result};

/* Enroll THIS machine as a deploy target for an existing sandbox — connect-host.sh as a verb. */

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// How many tokens a person may paste before enrollment stops.
const TOKEN_TRIES: usize = 3;

/// The Cloudflare token question: what it is for and where it does not go, then the hidden read.
fn ask_cf_token() -> Option<String> {
    ui::secret(
        "Your Cloudflare API token?",
        "It creates this server's tunnel, and it is not stored on this server.",
    )
}

/// Ask until a token validates, at most [`TOKEN_TRIES`] times. Nobody to ask, or every try wrong, is a stop that says
/// to set the variable instead.
fn ask_until_valid(
    mut ask: impl FnMut() -> Option<String>,
    validate: impl Fn(&str) -> Result<()>,
) -> Result<String> {
    let set_it = "set CF_TOKEN, then run the same command again.";
    for tried in 1..=TOKEN_TRIES {
        let Some(token) = ask() else {
            bail!(
                "{}",
                ui::explain(
                    "This server needs a Cloudflare API token for its tunnel.",
                    Some("CF_TOKEN is not set, and nobody is at this terminal to paste it."),
                    Some(set_it),
                )
            );
        };
        let token = token.trim().to_string();
        let why = if token.is_empty() {
            "nothing was pasted.".to_string()
        } else {
            match validate(&token) {
                Ok(()) => return Ok(token),
                Err(crate::util::Fail(why)) => why,
            }
        };
        if tried < TOKEN_TRIES {
            ui::warn(&format!("That token did not work: {why}"));
        }
    }
    bail!(
        "{}",
        ui::explain(
            &format!("No working Cloudflare API token after {TOKEN_TRIES} tries."),
            Some("a token needs Zone:Read, DNS:Edit and Cloudflare Tunnel:Edit, at https://dash.cloudflare.com/profile/api-tokens."),
            Some(set_it),
        )
    )
}

pub fn run() -> Result<()> {
    let sandbox_url = env("SANDBOX_URL").unwrap_or_default();
    let connect_token = env("CONNECT_TOKEN").unwrap_or_default();
    let mut cf_token = env("CF_TOKEN").unwrap_or_default();
    let mut zone = env("ZONE").unwrap_or_default();
    let host_tunnel_token = env("HOST_SSH_TUNNEL_TOKEN").unwrap_or_default();
    let host_hostname = env("HOST_SSH_HOSTNAME").unwrap_or_default();
    // The id the tunnel is named for, when a server-connect code's answer gave one (connect-host.sh exports it).
    let host_id = env("HOST_ID");
    let host_user = env("HOST_USER").unwrap_or_else(|| "intentic".to_string());
    let sandbox_image =
        env("SANDBOX_IMAGE").unwrap_or_else(|| "ghcr.io/intentic/sandbox:stable".to_string());
    let cloudflared_version = env("CLOUDFLARED_VERSION").unwrap_or_else(|| "2026.10.0".to_string());

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

    let plan_steps = if provided_tunnel {
        vec![
            ui::PlanStep {
                phase: "check-docker",
                label: "Check Docker",
                weight: 2,
            },
            ui::PlanStep {
                phase: "setup-user",
                label: "Set up the service user",
                weight: 1,
            },
            ui::PlanStep {
                phase: "pull-image",
                label: "Pull the CLI image",
                weight: 30,
            },
            ui::PlanStep {
                phase: "install-cloudflared",
                label: "Install cloudflared",
                weight: 10,
            },
            ui::PlanStep {
                phase: "run-connector",
                label: "Run the SSH connector",
                weight: 2,
            },
            ui::PlanStep {
                phase: "enroll-sandbox",
                label: "Enroll with the sandbox",
                weight: 3,
            },
        ]
    } else {
        vec![
            ui::PlanStep {
                phase: "check-docker",
                label: "Check Docker",
                weight: 2,
            },
            ui::PlanStep {
                phase: "validate-token",
                label: "Validate Cloudflare API token",
                weight: 2,
            },
            ui::PlanStep {
                phase: "setup-user",
                label: "Set up the service user",
                weight: 1,
            },
            ui::PlanStep {
                phase: "pull-image",
                label: "Pull the CLI image",
                weight: 30,
            },
            ui::PlanStep {
                phase: "create-tunnel",
                label: "Create the SSH tunnel",
                weight: 10,
            },
            ui::PlanStep {
                phase: "install-cloudflared",
                label: "Install cloudflared",
                weight: 10,
            },
            ui::PlanStep {
                phase: "run-connector",
                label: "Run the SSH connector",
                weight: 2,
            },
            ui::PlanStep {
                phase: "enroll-sandbox",
                label: "Enroll with the sandbox",
                weight: 3,
            },
        ]
    };
    ui::begin("connect this server", plan_steps, Some(&host_name));

    // Enrollment mutates the host (creates a user, installs packages), so it needs root — checked before
    // anything else rather than failing deep in a package install.
    let root = selfhost::Root::acquire("machine enrolment")?;

    ui::step("check-docker", "checking Docker…");
    docker::require_daemon()?;

    if sandbox_url.is_empty() || connect_token.is_empty() {
        bail!("SANDBOX_URL and CONNECT_TOKEN are required — copy the one-liner from the Infra screen.");
    }
    if !provided_tunnel {
        // The connect command no longer carries the token: the person who runs it pastes it here, unseen.
        let pasted = cf_token.is_empty();
        if pasted {
            cf_token = ask_until_valid(ask_cf_token, cloudflare::validate_token)?;
        }
        ui::step("validate-token", "validating Cloudflare API token…");
        // A pasted token was validated as it was pasted.
        if !pasted {
            cloudflare::validate_token(&cf_token)?;
        }
        if zone.is_empty() {
            zone = cloudflare::resolve_zone(&cf_token, "this server's tunnel")?;
        }
    }

    ui::step("setup-user", "registering the deploy target…");
    let host_ssh_key = selfhost::setup_service_user(&root, &host_user, "intentic-host")?;

    ui::step("pull-image", "pulling the intentic CLI image…");
    let log = Log::create("connect-host")?;
    docker::pull(&sandbox_image, &log)?;

    let (connector_token, host_address);
    if provided_tunnel {
        ui::detail(&format!(
            "using the pre-provisioned SSH tunnel ({host_hostname})"
        ));
        connector_token = host_tunnel_token;
        host_address = host_hostname;
    } else {
        ui::step("create-tunnel", "creating this server's SSH tunnel…");
        let args = tunnel_args(
            &cf_token,
            &connect_token,
            &host_name,
            &zone,
            host_id.as_deref(),
            &sandbox_image,
        );
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = docker::capture(&arg_refs).map_err(|err| {
            crate::util::Fail(format!(
                "failed to create this server's SSH tunnel: {}",
                err.0
            ))
        })?;
        let lookup = kv_lines(&out);
        connector_token = lookup("HOST_SSH_TUNNEL_TOKEN").unwrap_or_default();
        host_address = lookup("HOST_SSH_HOSTNAME").unwrap_or_default();
        if connector_token.is_empty() || host_address.is_empty() {
            bail!("failed to create this server's SSH tunnel (see the output above).");
        }
    }
    ui::step("install-cloudflared", "installing cloudflared…");
    selfhost::install_cloudflared(&root, &cloudflared_version)?;
    ui::step("run-connector", "starting the SSH connector…");
    selfhost::run_ssh_connector(&root, &connector_token, "the connect-host one-liner")?;

    // Self-register with the sandbox's daemon. cfToken rides along only on the own-Cloudflare path — the
    // pre-provisioned one has no token to hand over. (The script had to JSON-encode the multi-line key
    // through the image's node; a real JSON serializer is the whole of what that hack asked for.)
    ui::step("enroll-sandbox", "enrolling with the sandbox…");
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
        // sandbox-contract's CONNECT_TOKEN_HEADER, held to this spelling by api-contract's ingress.test.ts.
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

    ui::finished(
        &format!("{host_name} is connected."),
        Some(&format!("SSH reachable at {host_address}")),
        "Provision from the Infra screen to deploy onto it.",
        &[(
            "refresh".to_string(),
            "run this command again to refresh the key or tunnel".to_string(),
        )],
    );
    Ok(())
}

/// The `docker run` that creates this server's tunnel with the CLI in the sandbox image (`intentic tunnel host`).
/// HOST_ID, when a server-connect code's answer gave one, names the tunnel and its ssh-<id> record: that code's
/// CONNECT_TOKEN is single-use, so the id the CLI would otherwise digest from it is new on every run.
fn tunnel_args(
    cf_token: &str,
    connect_token: &str,
    host_name: &str,
    zone: &str,
    host_id: Option<&str>,
    sandbox_image: &str,
) -> Vec<String> {
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
    if let Some(host_id) = host_id {
        args.push("-e".into());
        args.push(format!("HOST_ID={host_id}"));
    }
    args.extend([sandbox_image.into(), "tunnel".into(), "host".into()]);
    args
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tunnel_is_named_for_the_host_id_a_code_gave_and_otherwise_as_before() {
        let with_id = tunnel_args(
            "cf",
            "once",
            "web_1",
            "example.dev",
            Some("0123456789ab"),
            "i",
        );
        assert_eq!(
            with_id.join(" "),
            "run --rm --entrypoint intentic -e CLOUDFLARE_API_TOKEN=cf -e CONNECT_TOKEN=once \
             -e HOST_NAME=web_1 -e ZONE=example.dev -e HOST_ID=0123456789ab i tunnel host"
        );
        // No HOST_ID (the env-var form, a sandbox from before it): exactly the arguments it always had.
        let without = tunnel_args("cf", "ct", "web_1", "", None, "i");
        assert_eq!(
            without.join(" "),
            "run --rm --entrypoint intentic -e CLOUDFLARE_API_TOKEN=cf -e CONNECT_TOKEN=ct \
             -e HOST_NAME=web_1 i tunnel host"
        );
    }

    #[test]
    fn nobody_to_paste_the_token_is_a_stop_that_names_the_variable() {
        let refused = ask_until_valid(|| None, |_| Ok(())).unwrap_err();
        assert!(
            refused
                .0
                .contains("fix:     set CF_TOKEN, then run the same command again."),
            "{}",
            refused.0
        );
    }

    #[test]
    fn a_token_is_asked_for_three_times_and_the_first_good_one_is_taken() {
        let mut asked = 0;
        let taken = ask_until_valid(
            || {
                asked += 1;
                Some(format!(" try-{asked} \n"))
            },
            |token| {
                if token == "try-2" {
                    Ok(())
                } else {
                    Err(crate::util::Fail("invalid".to_string()))
                }
            },
        )
        .unwrap();
        assert_eq!(taken, "try-2");

        let mut tries = 0;
        let refused = ask_until_valid(
            || {
                tries += 1;
                Some(String::new())
            },
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(tries, TOKEN_TRIES);
        assert!(refused.0.contains("after 3 tries"), "{}", refused.0);
        assert!(refused.0.contains("set CF_TOKEN"), "{}", refused.0);
    }
}
