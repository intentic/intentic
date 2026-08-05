use std::collections::BTreeSet;
use std::path::Path;

use crate::selfhost::Root;
use crate::tty;
use crate::util::{bail, Result};

/* Remove EVERYTHING intentic put on THIS machine as a deploy target — cleanup-host.sh as a verb: the mirror
 * of enrolment plus what `intentic deploy apply` deployed here. It discovers the full local footprint,
 * prints exactly what it found, asks once, then removes. It does NOT uninstall shared software (Docker,
 * openssh-server, the cloudflared binary), and it CANNOT reach the user's Cloudflare account: this host's
 * tunnels + DNS records are owned by the sandbox — remove the server on the Infra screen and apply (or run
 * `intentic deploy destroy` there) so the prune deletes them. */

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
        println!("intentic: nothing to clean — no intentic footprint found on this machine.");
        return Ok(());
    }

    // ---- announce the plan, then confirm ----
    println!("intentic: this will remove the following from THIS machine:");
    if !containers.is_empty() {
        println!("  containers ({}):", containers.len());
        for name in &containers {
            println!("    - {name}");
        }
    }
    if !volumes.is_empty() {
        println!("  docker volumes ({}) — databases included:", volumes.len());
        for name in &volumes {
            println!("    - {name}");
        }
    }
    if state_present {
        println!("  {STATE_DIR} — all deployment state + secrets, INCLUDING the on-host restic backup repo:");
        println!("    any backups stored only here are gone with it.");
    }
    if unit_present {
        println!("  the {TUNNEL_UNIT} systemd unit (this host's SSH tunnel connector)");
    }
    if user_present {
        println!("  the '{host_user}' service user, its home directory and SSH keys");
    }
    println!("kept: Docker Engine, openssh-server, the cloudflared binary, pulled docker images.");
    println!("not reachable from here: this host's Cloudflare tunnels + DNS records — remove the server on the");
    println!("Infra screen and apply (or run `intentic deploy destroy` in your sandbox) so the prune deletes them.");

    if !args.yes && !confirm_env {
        match tty::ask("intentic: remove all of the above? [y/N] ") {
            None => bail!("no terminal to confirm on — re-run with -y (or CONFIRM=1) to proceed non-interactively."),
            Some(answer) if answer.starts_with(['y', 'Y']) => {}
            Some(_) => {
                println!("intentic: aborted — nothing was removed.");
                return Ok(());
            }
        }
    }

    // ---- remove ----
    if have_docker {
        for project in &projects {
            println!("intentic: tearing down the '{project}' stack…");
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
            println!("intentic: removing the remaining containers…");
            for name in &containers {
                root.quiet("docker", &["rm", "-f", name]);
            }
        }
        if !volumes.is_empty() {
            println!("intentic: removing the docker volumes…");
            for volume in &volumes {
                root.quiet("docker", &["volume", "rm", "-f", volume]);
            }
        }
    } else if !projects.is_empty() {
        eprintln!("intentic: warning — docker is not running, so deployed containers/volumes could not be removed.");
    }

    if unit_present {
        println!("intentic: removing the host SSH tunnel connector…");
        root.quiet("systemctl", &["disable", "--now", TUNNEL_UNIT]);
        root.quiet("rm", &["-f", &format!("/etc/systemd/system/{TUNNEL_UNIT}")]);
        root.quiet("systemctl", &["daemon-reload"]);
    }
    // The non-systemd fallback ran cloudflared detached; stop it either way.
    root.quiet("pkill", &["-f", "cloudflared tunnel --no-autoupdate run"]);
    root.quiet("rm", &["-f", TUNNEL_LOG]);

    if state_present {
        println!("intentic: removing {STATE_DIR}…");
        root.quiet("rm", &["-rf", STATE_DIR]);
    }

    if user_present {
        println!("intentic: removing the '{host_user}' service user…");
        root.quiet("pkill", &["-u", &host_user]);
        if !root.quiet("userdel", &["-r", &host_user]) {
            root.quiet("userdel", &[&host_user]);
        }
    }

    println!("intentic: done — this machine no longer runs anything intentic put on it.");
    println!("Reclaim image disk space with `docker image prune -a` if you want it back.");
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
