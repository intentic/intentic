use std::collections::BTreeSet;
use std::path::Path;

use crate::selfhost::Root;
use crate::ui;
use crate::util::Result;

/* Remove EVERYTHING intentic put on THIS machine as a deploy target — cleanup-host.sh as a verb. */

const STATE_DIR: &str = "/opt/intentic";
const TUNNEL_UNIT: &str = "intentic-host-ssh-tunnel.service";
const TUNNEL_LOG: &str = "/var/log/intentic-host-ssh-tunnel.log";

pub struct Args {
    pub yes: bool,
    pub keep_user: bool,
}

pub fn run(args: Args) -> Result<()> {
    let confirm_env = std::env::var("CONFIRM")
        .map(|value| value == "1")
        .unwrap_or(false);
    let keep_user = args.keep_user
        || std::env::var("KEEP_USER")
            .map(|value| value == "1")
            .unwrap_or(false);
    let host_user = std::env::var("HOST_USER")
        .ok()
        .filter(|user| !user.is_empty())
        .unwrap_or_else(|| "intentic".to_string());

    // Removes system state (containers, a systemd unit, a user), so it needs root — same bar as enrolment.
    let root = Root::acquire("machine removal")?;
    let have_docker = crate::docker::cli_present() && crate::docker::daemon_reachable();

    // ---- discover the footprint (read-only) ----
    // Compose projects live one-per-dir under /opt/intentic (<dir> = <project>) with the compose.yaml the
    // provider wrote — enough to `compose down -v` each without guessing.
    let mut projects: Vec<String> = Vec::new();
    if Path::new(STATE_DIR).is_dir() {
        if let Ok(entries) = std::fs::read_dir(STATE_DIR) {
            for entry in entries.filter_map(|entry| entry.ok()) {
                if entry.path().join("compose.yaml").is_file() {
                    projects.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
    }
    projects.sort();

    // Stamped (intentic.id label), compose-project members (catches unstamped sidecars like Komodo's
    // postgres), and intentic-named singles (forgejo, runner, tunnel connector, backup, periphery).
    let mut containers: BTreeSet<String> = BTreeSet::new();
    let mut volumes: BTreeSet<String> = BTreeSet::new();
    if have_docker {
        collect_lines(
            &root,
            &[
                "ps",
                "-a",
                "--format",
                "{{.Names}}",
                "--filter",
                "label=intentic.id",
            ],
            &mut containers,
        );
        for project in &projects {
            let filter = format!("label=com.docker.compose.project={project}");
            collect_lines(
                &root,
                &["ps", "-a", "--format", "{{.Names}}", "--filter", &filter],
                &mut containers,
            );
            collect_lines(
                &root,
                &["volume", "ls", "-q", "--filter", &filter],
                &mut volumes,
            );
        }
        collect_lines(
            &root,
            &[
                "ps",
                "-a",
                "--format",
                "{{.Names}}",
                "--filter",
                "name=^intentic-",
            ],
            &mut containers,
        );
    }
    let unit_present = Path::new(&format!("/etc/systemd/system/{TUNNEL_UNIT}")).is_file();
    let user_present = !keep_user
        && std::process::Command::new("id")
            .arg(&host_user)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    let state_present = Path::new(STATE_DIR).is_dir();

    if containers.is_empty()
        && volumes.is_empty()
        && !state_present
        && !unit_present
        && !user_present
    {
        ui::quiet("nothing to clean — no intentic footprint found on this server.");
        return Ok(());
    }

    // ---- announce the consequence, then confirm ----
    let mut consequence = String::new();
    consequence.push_str("This will remove the following from this server:\n");
    if !containers.is_empty() {
        consequence.push_str(&format!("  containers ({}):\n", containers.len()));
        for name in &containers {
            consequence.push_str(&format!("    - {name}\n"));
        }
    }
    if !volumes.is_empty() {
        consequence.push_str(&format!(
            "  docker volumes ({}) — databases included:\n",
            volumes.len()
        ));
        for name in &volumes {
            consequence.push_str(&format!("    - {name}\n"));
        }
    }
    if state_present {
        consequence.push_str(&format!("  {STATE_DIR} — all deployment state + secrets, including the on-host restic backup repo:\n"));
        consequence.push_str("    any backups stored only here are gone with it.\n");
    }
    if unit_present {
        consequence.push_str(&format!(
            "  the {TUNNEL_UNIT} systemd unit (this server's SSH tunnel connector)\n"
        ));
    }
    if user_present {
        consequence.push_str(&format!(
            "  the {host_user} service user, its home directory and SSH keys\n"
        ));
    }
    consequence.push_str(
        "kept: Docker Engine, openssh-server, the cloudflared binary, pulled docker images.\n",
    );
    consequence.push_str("not reachable from here: this server's Cloudflare tunnels + DNS records — remove the server on the\n");
    consequence.push_str("Infra screen and apply (or run `intentic deploy destroy` in your sandbox) so the prune deletes them.");

    let yes = args.yes || confirm_env;
    if !ui::confirm(
        "Remove all of the above from this server?",
        &consequence,
        yes,
    )? {
        ui::cancelled();
        return Ok(());
    }

    // ---- remove flow ----
    let mut plan = Vec::new();
    if have_docker {
        if !projects.is_empty() {
            plan.push(ui::PlanStep {
                phase: "teardown-stacks",
                label: "Tear down deployed stacks",
                weight: 5,
            });
        }
        if !containers.is_empty() {
            plan.push(ui::PlanStep {
                phase: "remove-containers",
                label: "Remove remaining containers",
                weight: 3,
            });
        }
        if !volumes.is_empty() {
            plan.push(ui::PlanStep {
                phase: "remove-volumes",
                label: "Remove docker volumes",
                weight: 3,
            });
        }
    }
    if unit_present {
        plan.push(ui::PlanStep {
            phase: "remove-tunnel",
            label: "Remove SSH tunnel connector",
            weight: 2,
        });
    }
    if state_present {
        plan.push(ui::PlanStep {
            phase: "remove-state",
            label: "Remove state directory",
            weight: 2,
        });
    }
    if user_present {
        plan.push(ui::PlanStep {
            phase: "remove-user",
            label: "Remove service user",
            weight: 2,
        });
    }

    ui::begin("disconnect this server", plan, None);

    if have_docker {
        for project in &projects {
            ui::step(
                "teardown-stacks",
                &format!("tearing down the {project} stack…"),
            );
            let dir = format!("{STATE_DIR}/{project}");
            root.quiet(
                "docker",
                &[
                    "compose",
                    "-p",
                    project,
                    "--project-directory",
                    &dir,
                    "--env-file",
                    &format!("{dir}/.env"),
                    "-f",
                    &format!("{dir}/compose.yaml"),
                    "down",
                    "-v",
                ],
            );
        }
        if !containers.is_empty() {
            ui::step("remove-containers", "removing the remaining containers…");
            for name in &containers {
                root.quiet("docker", &["rm", "-f", name]);
            }
        }
        if !volumes.is_empty() {
            ui::step("remove-volumes", "removing the docker volumes…");
            for volume in &volumes {
                root.quiet("docker", &["volume", "rm", "-f", volume]);
            }
        }
    } else if !projects.is_empty() {
        ui::warn("docker is not running, so deployed containers and volumes could not be removed.");
    }

    if unit_present {
        ui::step("remove-tunnel", "removing the SSH tunnel connector…");
        root.quiet("systemctl", &["disable", "--now", TUNNEL_UNIT]);
        root.quiet("rm", &["-f", &format!("/etc/systemd/system/{TUNNEL_UNIT}")]);
        root.quiet("systemctl", &["daemon-reload"]);
    }
    // The non-systemd fallback ran cloudflared detached; stop it either way.
    root.quiet("pkill", &["-f", "cloudflared tunnel --no-autoupdate run"]);
    root.quiet("rm", &["-f", TUNNEL_LOG]);

    if state_present {
        ui::step("remove-state", &format!("removing {STATE_DIR}…"));
        root.quiet("rm", &["-rf", STATE_DIR]);
    }

    if user_present {
        ui::step(
            "remove-user",
            &format!("removing the {host_user} service user…"),
        );
        root.quiet("pkill", &["-u", &host_user]);
        if !root.quiet("userdel", &["-r", &host_user]) {
            root.quiet("userdel", &[&host_user]);
        }
    }

    ui::finished(
        "This server no longer runs anything Intentic put on it.",
        None,
        "",
        &[(
            "reclaim disk space".to_string(),
            "docker image prune -a".to_string(),
        )],
    );
    Ok(())
}

fn collect_lines(root: &Root, args: &[&str], into: &mut BTreeSet<String>) {
    if let Some(output) = root.capture("docker", args) {
        into.extend(
            output
                .lines()
                .map(str::to_string)
                .filter(|line| !line.is_empty()),
        );
    }
}
