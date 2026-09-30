use std::time::{Duration, Instant};

use crate::checks::{self, Finding, Outcome};
use crate::docker;
use crate::health;
use crate::sandbox::CONTAINER_PREFIX;
use crate::util::kv_lines;

/* THE REACHABILITY CHAIN, WAITED ON — machine → container → daemon → platform, and edge → browser. What connect's
postflight runs with patience after a launch. `ic sandbox doctor` itself is the fix engine run read-only
(sandbox/fix), which checks the layers under this chain too: Docker Desktop, WSL, the disk, the network. */

/// A link's verdict this round: settled, or worth re-probing while patience remains — carrying the outcome
/// to report if it runs out.
enum Verdict {
    Settled(Outcome),
    Pending(Outcome),
}

const LINKS: [&str; 5] = [
    "Sandbox container",
    "Daemon health",
    "Platform registration",
    "Public DNS",
    "Public URL",
];
const CONTAINER: usize = 0;
const DAEMON: usize = 1;
const ANNOUNCE: usize = 2;
const DNS: usize = 3;
const URL: usize = 4;

/// Probe every link until each settles or patience runs out, printing verdicts as they land. The public URL
/// is None when the container does not carry one — the reachability links then say so rather than guess.
pub fn verify_chain(slug: &str, public_url: Option<&str>, patience: Duration) -> Vec<Finding> {
    let container = format!("{CONTAINER_PREFIX}{slug}");
    let deadline = Instant::now() + patience;
    let mut settled: [Option<Outcome>; 5] = [const { None }; 5];
    /* WHAT THIS CONTAINER WAS GIVEN TO DIAL THE EDGE WITH, read once, before any patience is spent. */
    let missing_reach = match public_url {
        Some(_) => missing_reach_env(&container),
        None => Vec::new(),
    };

    loop {
        let last_round = Instant::now() >= deadline;

        if settled[CONTAINER].is_none() {
            settle(
                &mut settled,
                CONTAINER,
                probe_container(&container),
                last_round,
            );
        }
        // The daemon and its registration read the same /health document — one exec, two links. Both are
        // unknowable while the container check hasn't passed, and the report says so rather than stacking
        // three consequences onto one cause.
        if settled[DAEMON].is_none() || settled[ANNOUNCE].is_none() {
            match &settled[CONTAINER] {
                Some(Outcome::Fail { .. }) => {
                    skip_both(&mut settled, "unknowable while the container is down");
                }
                _ => {
                    let health_json = docker::ask(
                        &[
                            "exec",
                            &container,
                            "curl",
                            "-sf",
                            "-m",
                            "5",
                            "http://localhost:8787/health",
                        ],
                        Duration::from_secs(15),
                    )
                    .said()
                    .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok());
                    if settled[DAEMON].is_none() {
                        settle(
                            &mut settled,
                            DAEMON,
                            classify_daemon(health_json.as_ref(), &container),
                            last_round,
                        );
                    }
                    if settled[ANNOUNCE].is_none() {
                        settle(
                            &mut settled,
                            ANNOUNCE,
                            classify_announce(health_json.as_ref(), &container),
                            last_round,
                        );
                    }
                }
            }
        }
        match public_url.and_then(host_of) {
            None => {
                if settled[DNS].is_none() {
                    let warn = Outcome::Warn {
                        problem: "the container carries no SANDBOX_PUBLIC_URL, so reachability from outside cannot be verified".to_string(),
                    };
                    settle(&mut settled, DNS, Verdict::Settled(warn), last_round);
                    settle(
                        &mut settled,
                        URL,
                        Verdict::Settled(Outcome::Skip {
                            why: "no public URL to probe".to_string(),
                        }),
                        last_round,
                    );
                }
            }
            Some(host) => {
                if settled[DNS].is_none() {
                    settle(&mut settled, DNS, probe_dns(&host), last_round);
                }
                if settled[URL].is_none() {
                    // Probing the URL before its DNS resolves can only fail for the reason the DNS link
                    // already names — wait for that link rather than report one cause twice.
                    match &settled[DNS] {
                        Some(Outcome::Pass) => {
                            let url = public_url.expect("host implies url");
                            settle(
                                &mut settled,
                                URL,
                                probe_public(url, &host, &missing_reach),
                                last_round,
                            );
                        }
                        Some(_) => settle(
                            &mut settled,
                            URL,
                            Verdict::Settled(Outcome::Skip {
                                why: "unknowable while DNS does not resolve".to_string(),
                            }),
                            last_round,
                        ),
                        None => {}
                    }
                }
            }
        }

        if settled.iter().all(Option::is_some) {
            break;
        }
        if last_round {
            // Anything still unsettled had its Pending outcome forced by settle(); one more pass writes them.
            continue;
        }
        /* WHAT IT IS STILL WAITING FOR. */
        let waiting: Vec<&str> = LINKS
            .iter()
            .zip(settled.iter())
            .filter(|(_, outcome)| outcome.is_none())
            .map(|(name, _)| *name)
            .collect();
        crate::ui::detail(&format!("waiting on {}", waiting.join(", ").to_lowercase()));
        std::thread::sleep(Duration::from_secs(5));
    }

    LINKS
        .iter()
        .zip(settled)
        .map(|(name, outcome)| Finding {
            name,
            outcome: outcome.expect("all links settled"),
        })
        .collect()
}

/// Record a verdict: settled outcomes latch immediately, pending ones only once patience is spent. Prints
/// the row the moment it latches, so a patient postflight narrates instead of freezing.
fn settle(settled: &mut [Option<Outcome>; 5], link: usize, verdict: Verdict, last_round: bool) {
    let outcome = match verdict {
        Verdict::Settled(outcome) => outcome,
        Verdict::Pending(outcome) if last_round => outcome,
        Verdict::Pending(_) => return,
    };
    let finding = Finding {
        name: LINKS[link],
        outcome,
    };
    checks::print_row(&finding);
    settled[link] = Some(finding.outcome);
}

fn skip_both(settled: &mut [Option<Outcome>; 5], why: &str) {
    for link in [DAEMON, ANNOUNCE] {
        if settled[link].is_none() {
            settle(
                settled,
                link,
                Verdict::Settled(Outcome::Skip {
                    why: why.to_string(),
                }),
                true,
            );
        }
    }
}

// the links

fn probe_container(container: &str) -> Verdict {
    let status = docker::ask(
        &[
            "inspect",
            "--format",
            "{{.State.Status}} {{.RestartCount}}",
            container,
        ],
        docker::READ_LIMIT,
    )
    .said();
    // An interrupted swap leaves the sandbox set aside under its parked name: that is not a sandbox to set up again.
    let parked = format!("{container}{}", super::PARKED_SUFFIX);
    if status.is_none()
        && docker::ask(
            &["inspect", "--format", "{{.Id}}", &parked],
            docker::READ_LIMIT,
        )
        .said()
        .is_some()
    {
        return Verdict::Settled(Outcome::Fail {
            problem: "an interrupted update left this sandbox set aside, with nothing started in its place.".to_string(),
            remedy: format!("put it back: ic sandbox start {}", slug_of(container)),
        });
    }
    classify_container(status.as_deref(), container)
}

/// The slug a container name carries, for the `ic sandbox …` remedies: ic is the one host authority, and a raw docker
/// verb would skip the saved shape, the tunnel sidecar and the lock.
fn slug_of(container: &str) -> &str {
    container
        .strip_prefix(CONTAINER_PREFIX)
        .unwrap_or(container)
}

fn classify_container(inspect: Option<&str>, container: &str) -> Verdict {
    let Some(inspect) = inspect else {
        return Verdict::Settled(Outcome::Fail {
            problem: format!("no container named {container} on this machine."),
            remedy: "run the connect one-liner from the platform's setup screen.".to_string(),
        });
    };
    let mut parts = inspect.split_whitespace();
    let status = parts.next().unwrap_or("?");
    let restarts: u32 = parts
        .next()
        .and_then(|count| count.parse().ok())
        .unwrap_or(0);
    let slug = slug_of(container);
    match status {
        "running" if restarts >= 3 => Verdict::Pending(Outcome::Fail {
            problem: format!("the container is crash-looping ({restarts} restarts)."),
            remedy: format!("read its log: ic sandbox logs {slug} --tail 100"),
        }),
        "running" => Verdict::Settled(Outcome::Pass),
        "restarting" => Verdict::Pending(Outcome::Fail {
            problem: "the container keeps restarting.".to_string(),
            remedy: format!("read its log: ic sandbox logs {slug} --tail 100"),
        }),
        other => Verdict::Settled(Outcome::Fail {
            problem: format!("the container is {other}, not running."),
            remedy: format!("start it: ic sandbox start {slug}"),
        }),
    }
}

fn classify_daemon(health: Option<&serde_json::Value>, container: &str) -> Verdict {
    let Some(health) = health else {
        return Verdict::Pending(Outcome::Fail {
            problem: "the daemon inside the container does not answer /health.".to_string(),
            remedy: format!(
                "read its log: ic sandbox logs {} --tail 100",
                slug_of(container)
            ),
        });
    };
    if health::journal_failed(health) {
        return Verdict::Settled(Outcome::Fail {
            problem: "the daemon could not convert this sandbox's stored files to its version, and put them back.".to_string(),
            remedy: format!(
                "go back to the version before it: ic sandbox rollback {}",
                slug_of(container)
            ),
        });
    }
    // `boot.ready` where the daemon reports it (every daemon since the boot chain), a top-level `ready` for older ones.
    let ready = health
        .get("boot")
        .and_then(|boot| boot.get("ready"))
        .or_else(|| health.get("ready"))
        .and_then(serde_json::Value::as_bool);
    if ready == Some(false) {
        let step = health::running_step(health).unwrap_or_else(|| "converging".to_string());
        return Verdict::Pending(Outcome::Warn {
            problem: format!("the daemon answers but is still warming up ({step}) — it keeps going in the background."),
        });
    }
    Verdict::Settled(Outcome::Pass)
}

/// The `announce` block of /health — the one link nothing outside the container can probe: whether THIS
/// daemon reached the platform to register. Without it the wizard waits forever on a sandbox that is,
/// locally, perfectly healthy.
fn classify_announce(health: Option<&serde_json::Value>, container: &str) -> Verdict {
    let Some(announce) = health.and_then(|value| value.get("announce")) else {
        // No health answer: the daemon link already names it. Health without the block: an older daemon.
        return match health {
            None => Verdict::Pending(Outcome::Skip {
                why: "unknowable while the daemon does not answer".to_string(),
            }),
            Some(_) => Verdict::Settled(Outcome::Skip {
                why: "this daemon predates registration reporting — update the sandbox".to_string(),
            }),
        };
    };
    let state = announce
        .get("state")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let detail = announce
        .get("detail")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("no detail")
        .to_string();
    let retrying = announce
        .get("retrying")
        .and_then(serde_json::Value::as_bool);
    match state {
        "registered" => Verdict::Settled(Outcome::Pass),
        "off" => Verdict::Settled(Outcome::Skip {
            why: "headless — this sandbox has no platform to register with".to_string(),
        }),
        "pending" => Verdict::Pending(Outcome::Fail {
            problem: "the daemon has not been able to register with the platform yet.".to_string(),
            remedy: format!(
                "check the container's outbound network, then re-check with: ic sandbox doctor {}",
                slug_of(container)
            ),
        }),
        "rejected" | "unreachable" => {
            let remedy = if retrying == Some(false) {
                format!(
                    "the daemon stopped retrying — restart it to retry: ic sandbox restart {}",
                    slug_of(container)
                )
            } else {
                "it is still retrying; if this persists, check the container's outbound network."
                    .to_string()
            };
            Verdict::Pending(Outcome::Fail {
                problem: detail,
                remedy,
            })
        }
        other => Verdict::Settled(Outcome::Skip {
            why: format!("unrecognized registration state '{other}'"),
        }),
    }
}

/// The URL's hostname, without pulling a URL crate: scheme stripped, then everything before the first
/// path/port separator. Enough for the two shapes connect ever writes (https://host and https://host/).
fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host: String = rest
        .chars()
        .take_while(|c| *c != '/' && *c != ':')
        .collect();
    (!host.is_empty()).then_some(host)
}

fn probe_dns(host: &str) -> Verdict {
    // Bounded: the system resolver's own timeouts can run to minutes.
    let resolved = super::fix::host::resolve(host, Duration::from_secs(10)).is_ok();
    if resolved {
        return Verdict::Settled(Outcome::Pass);
    }
    Verdict::Pending(Outcome::Fail {
        problem: format!("DNS for {host} does not resolve from this machine."),
        remedy: "a fresh name can take a minute to propagate; if this persists, check this machine's DNS — every sandbox name is served by the hub's one wildcard record.".to_string(),
    })
}

/// The reachability values this container was NOT given, off its own environment — the record of what the
/// docker run that made it carried. Unreadable (no such container, no daemon) reads as nothing missing: a
/// cause is never invented, and the container link above already names that case.
fn missing_reach_env(container: &str) -> Vec<&'static str> {
    let Some(text) = container_env_text(container) else {
        return Vec::new();
    };
    let lookup = kv_lines(&text);
    ["SANDBOX_GRANT", "INGRESS_URL"]
        .into_iter()
        .filter(|key| lookup(key).unwrap_or_default().is_empty())
        .collect()
}

fn probe_public(url: &str, host: &str, missing_reach: &[&str]) -> Verdict {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .new_agent();
    let result = match agent.get(format!("{url}/health")).call() {
        Ok(response) => Ok(response.status().as_u16()),
        Err(ureq::Error::StatusCode(status)) => Ok(status),
        Err(err) => Err(err.to_string()),
    };
    classify_public(&result, host, missing_reach)
}

fn classify_public(
    result: &std::result::Result<u16, String>,
    host: &str,
    missing_reach: &[&str],
) -> Verdict {
    match result {
        Ok(200) => Verdict::Settled(Outcome::Pass),
/* The same 502, with the cause already in hand: this container was created without the values its daemon dials with, so there is no tunnel to wait for. */
        Ok(status @ (502 | 503 | 530)) if !missing_reach.is_empty() => {
            Verdict::Settled(Outcome::Fail {
                problem: format!(
                    "the edge answers HTTP {status} for {host} — this container carries no {}, so its daemon dials no tunnel.",
                    missing_reach.join(" and ")
                ),
                remedy: "re-run the setup command from this sandbox's setup screen — what the container is missing rides in with it.".to_string(),
            })
        }
/* The edge's own "I am up, nothing is registered for this name" answers. */
        Ok(status @ (502 | 503 | 530)) => Verdict::Pending(Outcome::Fail {
            problem: format!("the edge answers HTTP {status} for {host} — it is up, but no tunnel is registered for this sandbox."),
            remedy: "if the daemon check passed, give it a moment to dial the edge; if this persists, re-run the connect one-liner.".to_string(),
        }),
        Ok(status) => Verdict::Pending(Outcome::Fail {
            problem: format!("https://{host} answered HTTP {status} instead of the daemon's health."),
            remedy: "if this persists, re-run the connect one-liner.".to_string(),
        }),
        Err(why) => Verdict::Pending(Outcome::Fail {
            problem: format!("could not reach https://{host} from this machine: {why}"),
            remedy: "check this machine's outbound HTTPS, then re-check with: ic sandbox doctor".to_string(),
        }),
    }
}

/// The container's own environment as KEY=value lines — the run that created this container is the only
/// record of what it was given, and it answers for a stopped one too.
fn container_env_text(container: &str) -> Option<String> {
    let env = docker::ask(
        &[
            "inspect",
            "--format",
            "{{range .Config.Env}}{{.}}{{printf \"\\x00\"}}{{end}}",
            container,
        ],
        docker::READ_LIMIT,
    )
    .said()?;
    Some(env.replace('\0', "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(verdict: Verdict) -> Outcome {
        match verdict {
            Verdict::Settled(outcome) | Verdict::Pending(outcome) => outcome,
        }
    }

    #[test]
    fn a_missing_container_names_the_connect_one_liner() {
        match outcome(classify_container(None, "intentic-sandbox-x")) {
            Outcome::Fail { remedy, .. } => assert!(remedy.contains("connect one-liner")),
            _ => panic!("missing container must fail"),
        }
    }

    #[test]
    fn a_running_container_passes_and_a_crash_loop_is_named() {
        assert!(matches!(
            classify_container(Some("running 0"), "c"),
            Verdict::Settled(Outcome::Pass)
        ));
        match classify_container(Some("running 7"), "c") {
            Verdict::Pending(Outcome::Fail { problem, .. }) => {
                assert!(problem.contains("7 restarts"))
            }
            _ => panic!("a restart-heavy container is a crash loop"),
        }
        match classify_container(Some("exited 0"), "intentic-sandbox-work") {
            Verdict::Settled(Outcome::Fail { remedy, .. }) => {
                assert_eq!(remedy, "start it: ic sandbox start work")
            }
            _ => panic!("an exited container must fail with ic's own start command"),
        }
        match classify_container(Some("running 7"), "intentic-sandbox-work") {
            Verdict::Pending(Outcome::Fail { remedy, .. }) => {
                assert_eq!(remedy, "read its log: ic sandbox logs work --tail 100")
            }
            _ => panic!("a crash loop points at ic's own log verb"),
        }
    }

    #[test]
    fn readiness_is_read_where_the_daemon_reports_it_and_a_failed_conversion_is_a_failure() {
        // Every daemon since the boot chain reports `boot.ready`; the top-level `ready` was an older daemon's.
        let warming = serde_json::json!({ "boot": { "ready": false, "steps": [] } });
        assert!(matches!(
            classify_daemon(Some(&warming), "c"),
            Verdict::Pending(Outcome::Warn { .. })
        ));
        let failed =
            serde_json::json!({ "boot": { "ready": true }, "state": { "journal": "failed" } });
        match classify_daemon(Some(&failed), "intentic-sandbox-work") {
            Verdict::Settled(Outcome::Fail { remedy, .. }) => {
                assert!(remedy.contains("ic sandbox rollback work"))
            }
            _ => panic!("a failed conversion is a failure with the way back"),
        }
    }

    #[test]
    fn a_warming_daemon_is_a_warn_with_its_step_not_a_failure() {
        let health = serde_json::json!({
            "ready": false,
            "boot": { "steps": [{ "state": "running", "label": "index the workspace" }] }
        });
        match classify_daemon(Some(&health), "c") {
            Verdict::Pending(Outcome::Warn { problem }) => {
                assert!(problem.contains("index the workspace"))
            }
            _ => panic!("warming is a warn that names the step"),
        }
        assert!(matches!(
            classify_daemon(Some(&serde_json::json!({"ready": true})), "c"),
            Verdict::Settled(Outcome::Pass)
        ));
    }

    #[test]
    fn announce_states_map_to_the_link_verdicts() {
        let registered = serde_json::json!({ "announce": { "state": "registered" } });
        assert!(matches!(
            classify_announce(Some(&registered), "c"),
            Verdict::Settled(Outcome::Pass)
        ));

        let gave_up = serde_json::json!({ "announce": {
            "state": "unreachable", "detail": "the platform could not be reached", "retrying": false
        }});
        match classify_announce(Some(&gave_up), "intentic-sandbox-work") {
            Verdict::Pending(Outcome::Fail { problem, remedy }) => {
                assert!(problem.contains("could not be reached"));
                assert!(remedy.contains("ic sandbox restart work"));
            }
            _ => panic!("a given-up registration must fail with the restart remedy"),
        }

        // An older daemon has no block: say the reading is unavailable, never invent a verdict.
        let older = serde_json::json!({ "ready": true });
        match classify_announce(Some(&older), "c") {
            Verdict::Settled(Outcome::Skip { why }) => assert!(why.contains("update the sandbox")),
            _ => panic!("no block means skip, not a verdict"),
        }
    }

    #[test]
    fn public_probe_separates_edge_up_from_edge_unreachable() {
        match classify_public(&Ok(530), "sandbox-x.example.com", &[]) {
            Verdict::Pending(Outcome::Fail { problem, .. }) => {
                assert!(problem.contains("no tunnel is registered"))
            }
            _ => panic!("530 is the no-tunnel symptom"),
        }
        assert!(matches!(
            classify_public(&Ok(200), "h", &[]),
            Verdict::Settled(Outcome::Pass)
        ));
        assert!(matches!(
            classify_public(&Err("tls handshake".into()), "h", &[]),
            Verdict::Pending(Outcome::Fail { .. })
        ));
    }

    /* THE 502 THAT WILL NEVER CLEAR. */
    #[test]
    fn a_502_from_a_container_that_was_given_no_grant_is_settled_and_names_the_missing_value() {
        match classify_public(
            &Ok(502),
            "sandbox-x.example.com",
            &["SANDBOX_GRANT", "INGRESS_URL"],
        ) {
            Verdict::Settled(Outcome::Fail { problem, remedy }) => {
                assert!(problem.contains("SANDBOX_GRANT and INGRESS_URL"));
                assert!(problem.contains("dials no tunnel"));
                assert!(remedy.contains("re-run the setup command"));
            }
            _ => panic!("a container that cannot dial is a settled failure, not a pending one"),
        }
        // One half missing is the same fact, named precisely.
        match classify_public(&Ok(503), "h", &["INGRESS_URL"]) {
            Verdict::Settled(Outcome::Fail { problem, .. }) => {
                assert!(problem.contains("no INGRESS_URL"));
                assert!(!problem.contains("SANDBOX_GRANT"));
            }
            _ => panic!("a missing edge is a settled failure"),
        }
        // A healthy container still passes, and a non-edge status is untouched by any of this.
        assert!(matches!(
            classify_public(&Ok(200), "h", &["SANDBOX_GRANT"]),
            Verdict::Settled(Outcome::Pass)
        ));
        match classify_public(&Ok(404), "h", &["SANDBOX_GRANT"]) {
            Verdict::Pending(Outcome::Fail { problem, .. }) => assert!(problem.contains("404")),
            _ => panic!("a 404 is somebody else's problem and stays pending"),
        }
    }

    #[test]
    fn host_extraction_handles_the_shapes_connect_writes() {
        assert_eq!(
            host_of("https://sandbox-x.example.com").as_deref(),
            Some("sandbox-x.example.com")
        );
        assert_eq!(
            host_of("https://sandbox-x.example.com/").as_deref(),
            Some("sandbox-x.example.com")
        );
        assert_eq!(host_of("not a url"), None);
        assert_eq!(host_of("https://"), None);
    }
}
