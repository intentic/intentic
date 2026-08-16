use serde::Serialize;

use crate::docker;

/* THE PREFLIGHT/DOCTOR CHECK ENGINE — every prerequisite verified, every failure reported at once.
 *
 * The flows in this binary used to answer "why did setup fail" one failure at a time: bail at the first
 * broken prerequisite, let the user fix it, re-run, hit the next. Each message was good; the experience was
 * a guessing loop. This module inverts it: a check RUNS TO AN OUTCOME instead of bailing, a runner executes
 * the whole list and prints each verdict as it lands, and the summary names every failure WITH its fix — so
 * one run of the command is one complete diagnosis of the machine.
 *
 * The same engine serves both moments that need it: preflight (connect, before anything is mutated — every
 * check here is read-only by construction) and the doctor (an existing sandbox that went dark — see
 * sandbox/doctor.rs). Decisions are pure functions over probed facts, tested without docker or a network;
 * the thin `check_*` wrappers beside them do the probing. Put new checks on that side of the line too.
 *
 * `Skip` is a real answer and not a pass: a probe that cannot run on this platform must say so rather than
 * claim the machine is fine — the same lesson the daemon's adapter health encodes with "unknown". */

pub enum Outcome {
    Pass,
    /// Degraded but workable — named so the user is not surprised later, never fails the run.
    Warn {
        problem: String,
    },
    /// A prerequisite is broken. `remedy` names what to do about it, in the user's terms.
    Fail {
        problem: String,
        remedy: String,
    },
    /// The probe cannot run here (platform limits, a value not known yet). Never fails the run.
    Skip {
        why: String,
    },
}

pub struct Finding {
    pub name: &'static str,
    pub outcome: Outcome,
}

impl Finding {
    pub fn failed(&self) -> bool {
        matches!(self.outcome, Outcome::Fail { .. })
    }
}

/// A named check whose body probes and classifies. Boxed so a list can mix closures.
pub struct Check {
    pub name: &'static str,
    pub probe: Box<dyn FnOnce() -> Outcome>,
}

impl Check {
    pub fn new(name: &'static str, probe: impl FnOnce() -> Outcome + 'static) -> Self {
        Check {
            name,
            probe: Box::new(probe),
        }
    }
}

/// One finding as a report row — shared by the preflight runner and the doctor's chain so every diagnosis
/// in this binary reads the same.
pub fn print_row(finding: &Finding) {
    match &finding.outcome {
        Outcome::Pass => println!("  ok    {}", finding.name),
        Outcome::Warn { problem } => println!("  warn  {} — {problem}", finding.name),
        Outcome::Fail { .. } => println!("  FAIL  {}", finding.name),
        Outcome::Skip { why } => println!("  skip  {} — {why}", finding.name),
    }
}

/// Run every check in order, printing each verdict as it lands — the user watches the diagnosis happen
/// rather than staring at a silent pause. Returns ALL findings; nothing short-circuits.
///
/// `phase` names the run for anything counting steps (util::step); the rows under it are that step's detail.
pub fn run(phase: &str, header: &str, checks: Vec<Check>) -> Vec<Finding> {
    crate::util::step(phase, header);
    let mut findings = Vec::with_capacity(checks.len());
    for check in checks {
        let finding = Finding {
            name: check.name,
            outcome: (check.probe)(),
        };
        print_row(&finding);
        findings.push(finding);
    }
    findings
}

/// The composed all-failures report — what the flow bails with, so the terminal shows every problem and its
/// fix in one block. None when nothing failed. Pure over findings, tested below.
pub fn failure_summary(findings: &[Finding]) -> Option<String> {
    let failures: Vec<&Finding> = findings.iter().filter(|finding| finding.failed()).collect();
    if failures.is_empty() {
        return None;
    }
    let count = if failures.len() == 1 {
        "1 problem".to_string()
    } else {
        format!("{} problems", failures.len())
    };
    Some(compose(&failures, &count))
}

fn compose(failures: &[&Finding], count: &str) -> String {
    let mut text = format!("found {count} — fix them and re-run the same command:\n");
    for (index, finding) in failures.iter().enumerate() {
        if let Outcome::Fail { problem, remedy } = &finding.outcome {
            text.push_str(&format!(
                "\n  {}. {}\n     problem: {problem}\n     fix:     {remedy}\n",
                index + 1,
                finding.name
            ));
        }
    }
    text
}

/// A failure in the shape the platform's /setup/report stores — what the setup wizard renders when the
/// terminal is no longer in front of the user. Warns ride along too: a degraded setup is worth a sentence
/// on the wizard, with an empty remedy marking it non-fatal.
#[derive(Serialize)]
pub struct WireFailure {
    pub check: String,
    pub problem: String,
    pub remedy: String,
}

pub fn wire_failures(findings: &[Finding]) -> Vec<WireFailure> {
    findings
        .iter()
        .filter_map(|finding| match &finding.outcome {
            Outcome::Fail { problem, remedy } => Some(WireFailure {
                check: finding.name.to_string(),
                problem: problem.clone(),
                remedy: remedy.clone(),
            }),
            _ => None,
        })
        .collect()
}

// ───────────────────────────────────────────────────────────────────────────
// Docker — the one prerequisite every flow shares.
// ───────────────────────────────────────────────────────────────────────────

/// The facts the docker probe gathers; classification over them is pure (and tested), the gathering is not.
/// This owns the diagnoses' prose for every flow — docker::require_daemon is the bail-shaped reading of the
/// same classification. Docker installs the socket root-owned with a `docker` group, so naming the group is
/// the actual fix in that state; "start Docker" would send the user to restart a daemon already up.
pub struct DockerFacts {
    pub cli_present: bool,
    pub daemon_reachable: bool,
    /// The wrong-container-platform diagnosis when reachable (Windows containers mode on Docker Desktop) —
    /// (problem, remedy), owned by docker::wrong_container_platform.
    pub platform_problem: Option<(String, String)>,
    /// Unix: the socket exists but this user cannot talk to it — the docker-group case.
    pub socket_needs_group: bool,
    pub user: String,
}

pub fn docker_outcome(facts: &DockerFacts) -> Outcome {
    if !facts.cli_present {
        return Outcome::Fail {
            problem: "docker is not installed.".to_string(),
            remedy: "install Docker (https://docs.docker.com/get-docker/), or run the connect one-liner, which offers to install it.".to_string(),
        };
    }
    if facts.daemon_reachable {
        if let Some((problem, remedy)) = &facts.platform_problem {
            return Outcome::Fail {
                problem: problem.clone(),
                remedy: remedy.clone(),
            };
        }
        return Outcome::Pass;
    }
    if facts.socket_needs_group {
        return Outcome::Fail {
            problem: "the docker daemon is running, but this user can't talk to it.".to_string(),
            remedy: format!(
                "add yourself to the docker group (then log out and back in): sudo usermod -aG docker {} && newgrp docker — or re-run with sudo.",
                facts.user
            ),
        };
    }
    Outcome::Fail {
        problem: "the docker daemon is not running or not reachable.".to_string(),
        remedy: "start Docker, then re-run.".to_string(),
    }
}

pub fn check_docker() -> Outcome {
    let cli = docker::cli_present();
    let daemon = cli && docker::daemon_reachable();
    let facts = DockerFacts {
        cli_present: cli,
        daemon_reachable: daemon,
        platform_problem: if daemon {
            docker::wrong_container_platform(docker::server_os().as_deref())
        } else {
            None
        },
        socket_needs_group: socket_needs_group(),
        user: std::env::var("USER").unwrap_or_else(|_| "$USER".to_string()),
    };
    docker_outcome(&facts)
}

#[cfg(unix)]
fn socket_needs_group() -> bool {
    std::path::Path::new("/var/run/docker.sock").exists() && !docker::is_root()
}

#[cfg(not(unix))]
fn socket_needs_group() -> bool {
    false
}

// ───────────────────────────────────────────────────────────────────────────
// Disk space — the image is multi-GB, and docker's "no space left" arrives minutes into the pull.
// ───────────────────────────────────────────────────────────────────────────

const DISK_FAIL_GIB: u64 = 5;
const DISK_WARN_GIB: u64 = 15;

/// Available KiB → outcome. The thresholds bracket the sandbox image (a few GB) plus working volumes:
/// under FAIL the pull itself will die; under WARN it will fit and then crowd the workspace.
pub fn disk_outcome(avail_kib: Option<u64>, mount: &str) -> Outcome {
    let Some(avail) = avail_kib else {
        return Outcome::Skip {
            why: format!("could not read free space on {mount}"),
        };
    };
    let gib = avail / (1024 * 1024);
    if gib < DISK_FAIL_GIB {
        return Outcome::Fail {
            problem: format!(
                "only {gib} GiB free on {mount} — the sandbox image alone needs more."
            ),
            remedy: "free at least 5 GiB (docker system prune reclaims old images), then re-run."
                .to_string(),
        };
    }
    if gib < DISK_WARN_GIB {
        return Outcome::Warn {
            problem: format!(
                "{gib} GiB free on {mount} — enough to install, tight for a workspace."
            ),
        };
    }
    Outcome::Pass
}

/// The Avail column of `df -Pk <path>` (POSIX -P: exactly two lines, KiB blocks, field 4). Pure, tested.
pub fn parse_df_avail(df_output: &str) -> Option<u64> {
    let data_line = df_output.lines().nth(1)?;
    data_line.split_whitespace().nth(3)?.parse().ok()
}

#[cfg(unix)]
pub fn check_disk() -> Outcome {
    // Native Linux stores images under DockerRootDir; Docker Desktop's root lives inside its VM, whose
    // backing file grows on the host disk — so when the reported root is not a local path, measure `/`.
    let root = docker::try_capture(&["info", "-f", "{{.DockerRootDir}}"])
        .map(|dir| dir.trim().to_string())
        .filter(|dir| std::path::Path::new(dir).exists())
        .unwrap_or_else(|| "/".to_string());
    let output = std::process::Command::new("df")
        .args(["-Pk", &root])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok());
    disk_outcome(output.as_deref().and_then(parse_df_avail), &root)
}

#[cfg(not(unix))]
pub fn check_disk() -> Outcome {
    Outcome::Skip {
        why: "no portable free-space probe on Windows — watch the pull for disk errors".to_string(),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Platform reachability — the claim, the announce, and the wizard all need this origin.
// ───────────────────────────────────────────────────────────────────────────

pub enum ProbeResult {
    Status(u16),
    Unreachable(String),
}

/// GET <platform>/health classified. Any HTTP status proves the origin is reachable; only 200 proves it is
/// the platform's API (app.* serves static files and answers 404 here — the same wrong-origin mistake the
/// claim's 405 message catches, caught before anything runs).
pub fn platform_outcome(result: &ProbeResult, platform_url: &str) -> Outcome {
    match result {
        ProbeResult::Status(200) => Outcome::Pass,
        ProbeResult::Status(status) => Outcome::Fail {
            problem: format!("{platform_url}/health answered HTTP {status} — that origin is not the platform API."),
            remedy: "PLATFORM_URL must be the platform's API origin (e.g. https://api.intentic.dev), not the web app.".to_string(),
        },
        ProbeResult::Unreachable(why) => Outcome::Fail {
            problem: format!("could not reach the platform at {platform_url} — {why}"),
            remedy: "check this machine's internet connection (DNS, proxy, firewall), then re-run.".to_string(),
        },
    }
}

pub fn check_platform(platform_url: &str) -> Outcome {
    let result = match crate::platform::agent_for(platform_url)
        .get(format!("{platform_url}/health"))
        .call()
    {
        Ok(response) => ProbeResult::Status(response.status().as_u16()),
        Err(ureq::Error::StatusCode(status)) => ProbeResult::Status(status),
        Err(err) => ProbeResult::Unreachable(err.to_string()),
    };
    platform_outcome(&result, platform_url)
}

// ───────────────────────────────────────────────────────────────────────────
// Cloudflare token — own-tunnel path only; the reachability fabric's credential.
// ───────────────────────────────────────────────────────────────────────────

pub fn check_cloudflare(token: &str) -> Outcome {
    match crate::cloudflare::validate_token(token) {
        Ok(()) => Outcome::Pass,
        Err(fail) => Outcome::Fail {
            problem: "the Cloudflare API token was rejected.".to_string(),
            remedy: fail.0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fail(name: &'static str) -> Finding {
        Finding {
            name,
            outcome: Outcome::Fail {
                problem: format!("{name} broke"),
                remedy: format!("fix {name}"),
            },
        }
    }

    #[test]
    fn summary_is_none_when_nothing_failed() {
        let findings = vec![
            Finding {
                name: "Docker",
                outcome: Outcome::Pass,
            },
            Finding {
                name: "Disk space",
                outcome: Outcome::Warn {
                    problem: "tight".into(),
                },
            },
            Finding {
                name: "Windows disk",
                outcome: Outcome::Skip { why: "n/a".into() },
            },
        ];
        assert!(failure_summary(&findings).is_none());
    }

    #[test]
    fn summary_names_every_failure_with_its_fix() {
        let findings = vec![
            fail("Docker"),
            Finding {
                name: "Platform",
                outcome: Outcome::Pass,
            },
            fail("Cloudflare token"),
        ];
        let summary = failure_summary(&findings).expect("two failures");
        assert!(summary.contains("2 problems"));
        assert!(summary.contains("1. Docker"));
        assert!(summary.contains("2. Cloudflare token"));
        assert!(summary.contains("fix Docker"));
        assert!(summary.contains("fix Cloudflare token"));
    }

    #[test]
    fn wire_failures_carry_only_hard_failures() {
        let findings = vec![
            fail("Docker"),
            Finding {
                name: "Disk space",
                outcome: Outcome::Warn {
                    problem: "tight".into(),
                },
            },
        ];
        let wire = wire_failures(&findings);
        assert_eq!(wire.len(), 1);
        assert_eq!(wire[0].check, "Docker");
        assert_eq!(wire[0].problem, "Docker broke");
        assert_eq!(wire[0].remedy, "fix Docker");
    }

    #[test]
    fn docker_classification_covers_the_four_states() {
        let base = DockerFacts {
            cli_present: true,
            daemon_reachable: true,
            platform_problem: None,
            socket_needs_group: false,
            user: "dev".into(),
        };
        assert!(matches!(docker_outcome(&base), Outcome::Pass));
        assert!(matches!(
            docker_outcome(&DockerFacts {
                cli_present: false,
                ..base_clone(&base)
            }),
            Outcome::Fail { .. }
        ));
        let group = docker_outcome(&DockerFacts {
            daemon_reachable: false,
            socket_needs_group: true,
            ..base_clone(&base)
        });
        match group {
            Outcome::Fail { remedy, .. } => assert!(remedy.contains("usermod -aG docker dev")),
            _ => panic!("group case must fail with the usermod remedy"),
        }
        let platform = docker_outcome(&DockerFacts {
            platform_problem: Some((
                "windows containers".into(),
                "switch to Linux containers".into(),
            )),
            ..base_clone(&base)
        });
        match platform {
            Outcome::Fail { problem, remedy } => {
                assert_eq!(problem, "windows containers");
                assert_eq!(remedy, "switch to Linux containers");
            }
            _ => panic!("platform mismatch must fail"),
        }
    }

    fn base_clone(facts: &DockerFacts) -> DockerFacts {
        DockerFacts {
            cli_present: facts.cli_present,
            daemon_reachable: facts.daemon_reachable,
            platform_problem: facts.platform_problem.clone(),
            socket_needs_group: facts.socket_needs_group,
            user: facts.user.clone(),
        }
    }

    #[test]
    fn disk_thresholds_bracket_the_image() {
        assert!(matches!(
            disk_outcome(Some(20 * 1024 * 1024), "/"),
            Outcome::Pass
        ));
        assert!(matches!(
            disk_outcome(Some(10 * 1024 * 1024), "/"),
            Outcome::Warn { .. }
        ));
        assert!(matches!(
            disk_outcome(Some(2 * 1024 * 1024), "/"),
            Outcome::Fail { .. }
        ));
        assert!(matches!(disk_outcome(None, "/"), Outcome::Skip { .. }));
    }

    #[test]
    fn df_posix_output_parses_and_garbage_does_not() {
        let df = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 102400000 51200000 46080000 53% /\n";
        assert_eq!(parse_df_avail(df), Some(46_080_000));
        assert_eq!(parse_df_avail(""), None);
        assert_eq!(
            parse_df_avail("df: /nope: No such file or directory\n"),
            None
        );
    }

    #[test]
    fn platform_probe_separates_wrong_origin_from_unreachable() {
        assert!(matches!(
            platform_outcome(&ProbeResult::Status(200), "https://api.intentic.dev"),
            Outcome::Pass
        ));
        match platform_outcome(&ProbeResult::Status(404), "https://app.intentic.dev") {
            Outcome::Fail { remedy, .. } => assert!(remedy.contains("API origin")),
            _ => panic!("404 is the wrong-origin case"),
        }
        match platform_outcome(
            &ProbeResult::Unreachable("dns error".into()),
            "https://api.intentic.dev",
        ) {
            Outcome::Fail { remedy, .. } => assert!(remedy.contains("internet connection")),
            _ => panic!("unreachable is the no-network case"),
        }
    }
}
