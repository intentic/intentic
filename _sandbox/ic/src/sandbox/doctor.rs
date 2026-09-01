use std::net::ToSocketAddrs;
use std::time::{Duration, Instant};

use crate::checks::{self, Finding, Outcome};
use crate::docker;
use crate::health;
use crate::sandbox::CONTAINER_PREFIX;
use crate::util::{bail, kv_lines, Result};

/* THE REACHABILITY CHAIN — machine → container → daemon → platform, and edge → browser.
 *
 * connect used to stop at "the daemon answers /health inside the container", which proves the first half of
 * the chain and none of the second: a grant the hub refuses, a name still propagating, or a daemon that
 * cannot reach the platform to register all looked like success in the terminal — and then like a dead
 * workspace in the browser, with nothing anywhere naming the broken link. This module probes every link and
 * names the one that is broken, with its fix.
 *
 * THERE IS NO LOCAL HALF OF REACHABILITY LEFT TO PROBE. It used to be a cloudflared sidecar container beside
 * the sandbox, then an in-box tunnel agent holding named shares, and each move stranded a probe that went on
 * reporting every healthy sandbox as broken. The fabric is the platform's own edge now, dialled outbound by
 * the daemon itself, so a daemon that is up either reached it or did not — which the two public links below
 * already answer, from outside, where the answer actually matters.
 *
 * Two callers, one chain. connect runs it as a postflight WITH PATIENCE: a just-claimed name and an agent
 * still coming up are ordinary states of a fresh setup, so inconclusive links are re-probed until the
 * deadline and only then reported as failures. `ic sandbox doctor` runs it with none: a diagnosis of an
 * existing sandbox wants the state of this moment, not a two-minute wait.
 *
 * Classification is pure and tested; the probes beside it do the IO. The chain's order is its dependency
 * order — a daemon that is down makes "registered with the platform?" unknowable, and the report says
 * exactly that instead of piling three consequences onto one cause. */

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
                    let health_json = docker::exec_capture(
                        &container,
                        &["curl", "-sf", "http://localhost:8787/health"],
                    )
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
                            settle(&mut settled, URL, probe_public(url, &host), last_round);
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
        /* WHAT IT IS STILL WAITING FOR. A new name propagating and a daemon still dialling the edge are
         * ordinary states of a fresh setup, so this loop is patient by design — but two minutes of a step
         * that says only "verifying" is indistinguishable from a hang, and the user has no way to learn
         * that the settled links already passed. Naming the outstanding ones costs nothing. */
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

// ─── the links ─────────────────────────────────────────────────────────────

fn probe_container(container: &str) -> Verdict {
    let status = docker::inspect(container, "{{.State.Status}} {{.RestartCount}}");
    classify_container(status.as_deref(), container)
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
    match status {
        "running" if restarts >= 3 => Verdict::Pending(Outcome::Fail {
            problem: format!("the container is crash-looping ({restarts} restarts)."),
            remedy: format!("read its log: docker logs --tail 100 {container}"),
        }),
        "running" => Verdict::Settled(Outcome::Pass),
        "restarting" => Verdict::Pending(Outcome::Fail {
            problem: "the container keeps restarting.".to_string(),
            remedy: format!("read its log: docker logs --tail 100 {container}"),
        }),
        other => Verdict::Settled(Outcome::Fail {
            problem: format!("the container is {other}, not running."),
            remedy: format!("start it: docker start {container}"),
        }),
    }
}

fn classify_daemon(health: Option<&serde_json::Value>, container: &str) -> Verdict {
    let Some(health) = health else {
        return Verdict::Pending(Outcome::Fail {
            problem: "the daemon inside the container does not answer /health.".to_string(),
            remedy: format!("read its log: docker logs --tail 100 {container}"),
        });
    };
    if health.get("ready").and_then(serde_json::Value::as_bool) == Some(false) {
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
            remedy: "check the container's outbound network, then re-check with: ic sandbox doctor"
                .to_string(),
        }),
        "rejected" | "unreachable" => {
            let remedy = if retrying == Some(false) {
                format!(
                    "the daemon stopped retrying — restart it to retry: docker restart {container}"
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
    let resolved = (host, 443u16)
        .to_socket_addrs()
        .map(|mut addrs| addrs.next().is_some())
        .unwrap_or(false);
    if resolved {
        return Verdict::Settled(Outcome::Pass);
    }
    Verdict::Pending(Outcome::Fail {
        problem: format!("DNS for {host} does not resolve from this machine."),
        remedy: "a fresh name can take a minute to propagate; if this persists, check this machine's DNS — every sandbox name is served by the hub's one wildcard record.".to_string(),
    })
}

fn probe_public(url: &str, host: &str) -> Verdict {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .new_agent();
    let result = match agent.get(format!("{url}/health")).call() {
        Ok(response) => Ok(response.status().as_u16()),
        Err(ureq::Error::StatusCode(status)) => Ok(status),
        Err(err) => Err(err.to_string()),
    };
    classify_public(&result, host)
}

fn classify_public(result: &std::result::Result<u16, String>, host: &str) -> Verdict {
    match result {
        Ok(200) => Verdict::Settled(Outcome::Pass),
        /* The edge's own "I am up, nothing is registered for this name" answers. The cause is upstream of
         * anything visible from here: no tunnel is registered under this sandbox's id, which means the daemon
         * has not dialled the edge (yet, or at all). The daemon link above says whether it is even running. */
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

// ─── the command ───────────────────────────────────────────────────────────

/// `ic sandbox doctor [slug]` — the chain, read-only, right now: for the sandbox that was fine last week and
/// is a dead tab today. Exit code 1 when any link is broken, so scripts can watch it too.
pub fn run(slug: Option<String>) -> Result<()> {
    docker::require_daemon()?;
    let slug = super::resolve_slug(slug, "ic sandbox doctor")?;
    let container = format!("{CONTAINER_PREFIX}{slug}");
    println!("intentic: doctor — checking sandbox {slug}…");
    let public_url = container_public_url(&container);
    let findings = verify_chain(&slug, public_url.as_deref(), Duration::ZERO);
    match checks::failure_summary(&findings) {
        Some(summary) => bail!("{summary}"),
        None => {
            match public_url {
                Some(url) => {
                    println!("intentic: every link checks out — the sandbox is reachable at {url}.")
                }
                None => println!("intentic: every checkable link checks out."),
            }
            Ok(())
        }
    }
}

/// SANDBOX_PUBLIC_URL from the container's own env — inspect works on a stopped container too, so the
/// doctor can name the URL of a sandbox that is down.
pub fn container_public_url(container: &str) -> Option<String> {
    container_env(container, "SANDBOX_PUBLIC_URL")
}

/// One value out of the container's own env, empty read as absent — the run that created this container is
/// the only record of what it was given, and it answers for a stopped one too.
fn container_env(container: &str, key: &str) -> Option<String> {
    let env = docker::container_env_nul(container).ok()?;
    let text = String::from_utf8_lossy(&env).replace('\0', "\n");
    let value = kv_lines(&text)(key);
    value.filter(|value| !value.is_empty())
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
        match classify_container(Some("exited 0"), "c") {
            Verdict::Settled(Outcome::Fail { remedy, .. }) => {
                assert!(remedy.contains("docker start c"))
            }
            _ => panic!("an exited container must fail with the start command"),
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
        match classify_announce(Some(&gave_up), "c") {
            Verdict::Pending(Outcome::Fail { problem, remedy }) => {
                assert!(problem.contains("could not be reached"));
                assert!(remedy.contains("docker restart c"));
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
        match classify_public(&Ok(530), "sandbox-x.example.com") {
            Verdict::Pending(Outcome::Fail { problem, .. }) => {
                assert!(problem.contains("no tunnel is registered"))
            }
            _ => panic!("530 is the no-tunnel symptom"),
        }
        assert!(matches!(
            classify_public(&Ok(200), "h"),
            Verdict::Settled(Outcome::Pass)
        ));
        assert!(matches!(
            classify_public(&Err("tls handshake".into()), "h"),
            Verdict::Pending(Outcome::Fail { .. })
        ));
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
