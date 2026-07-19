use std::process::Command;

use crate::docker::{self, DockerProbe};
use crate::engine::quiet;
use crate::progress::Reporter;
use crate::types::{
    Check, CheckId, CheckState, Engine, EnvironmentReport, Error, FixOutcome, Result,
};

pub fn probe() -> EnvironmentReport {
    let direct = Engine::HostDocker { via_sg: false };
    let mut checks: Vec<Check> = Vec::new();
    let mut engine: Option<Engine> = None;

    match docker::probe(&direct) {
        DockerProbe::Ready => {
            checks.push(ok(CheckId::DockerInstalled, "Docker is installed"));
            checks.push(ok(CheckId::DockerRunning, "Docker daemon is running"));
            checks.push(ok(
                CheckId::DockerPermission,
                "Docker is usable without root",
            ));
            engine = Some(direct);
        }
        DockerProbe::NotInstalled => {
            checks.push(fixable_or_manual(
                CheckId::DockerInstalled,
                "Docker is not installed",
                "The app installs Docker Engine for you (you'll be asked to authorize).",
                &format!("Install Docker Engine yourself: {}", install_command_hint()),
            ));
        }
        DockerProbe::DaemonDown => {
            checks.push(ok(CheckId::DockerInstalled, "Docker is installed"));
            checks.push(fixable_or_manual(
                CheckId::DockerRunning,
                "Docker daemon is not running",
                "The app starts and enables the Docker service (you'll be asked to authorize).",
                "Start it yourself: sudo systemctl enable --now docker",
            ));
        }
        DockerProbe::PermissionDenied => {
            checks.push(ok(CheckId::DockerInstalled, "Docker is installed"));
            checks.push(ok(CheckId::DockerRunning, "Docker daemon is running"));
            // Freshly added group membership works through `sg docker` without a re-login.
            let via_sg = Engine::HostDocker { via_sg: true };
            if user_in_docker_group() && docker::probe(&via_sg) == DockerProbe::Ready {
                checks.push(Check {
                    id: CheckId::DockerPermission,
                    title: "Docker is usable without root".into(),
                    state: CheckState::Ok,
                    detail: "Group membership is fresh — applied via sg until your next login."
                        .into(),
                });
                engine = Some(via_sg);
            } else {
                checks.push(fixable_or_manual(
                    CheckId::DockerPermission,
                    "Your user can't reach the Docker socket",
                    "The app adds you to the docker group (you'll be asked to authorize).",
                    "Add yourself: sudo usermod -aG docker $USER, then log out and back in.",
                ));
            }
        }
        DockerProbe::Failed(message) => {
            checks.push(Check {
                id: CheckId::DockerInstalled,
                title: "Docker probe failed".into(),
                state: CheckState::Manual,
                detail: message,
            });
        }
    }

    let ready = engine.is_some();
    EnvironmentReport {
        os: "linux".into(),
        checks,
        engine,
        ready,
    }
}

pub fn fix(check: CheckId, reporter: &dyn Reporter) -> Result<FixOutcome> {
    match check {
        CheckId::DockerInstalled => install_docker(reporter),
        CheckId::DockerRunning => start_daemon(reporter),
        CheckId::DockerPermission => fix_permission(reporter),
        other => Err(Error::Setup(format!("{other:?} is not a Linux fix"))),
    }
}

/// One elevation prompt does the whole job: install, enable the service, and join the group.
fn install_docker(reporter: &dyn Reporter) -> Result<FixOutcome> {
    let Some(script) = install_script(&os_release(), &current_user()) else {
        return Ok(FixOutcome::Manual {
            instructions: install_command_hint(),
        });
    };
    reporter.log(
        "fix",
        "installing Docker Engine — authorize the prompt to continue…",
    );
    elevated(&script, reporter)?;
    Ok(FixOutcome::Fixed)
}

fn start_daemon(reporter: &dyn Reporter) -> Result<FixOutcome> {
    reporter.log(
        "fix",
        "starting the Docker service — authorize the prompt to continue…",
    );
    elevated("systemctl enable --now docker", reporter)?;
    Ok(FixOutcome::Fixed)
}

fn fix_permission(reporter: &dyn Reporter) -> Result<FixOutcome> {
    reporter.log(
        "fix",
        "adding you to the docker group — authorize the prompt to continue…",
    );
    elevated(&format!("usermod -aG docker {}", current_user()), reporter)?;
    if docker::probe(&Engine::HostDocker { via_sg: true }) == DockerProbe::Ready {
        return Ok(FixOutcome::Fixed);
    }
    Ok(FixOutcome::Manual {
        instructions: "Group added — log out and back in, then re-check.".into(),
    })
}

/// Build the per-distro root script. get.docker.com covers the apt/dnf world; Arch and openSUSE
/// ship Docker in their own repos and are unsupported by the convenience script.
pub fn install_script(os_release: &str, user: &str) -> Option<String> {
    let field = |key: &str| {
        os_release
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{key}=")))
            .map(|value| value.trim_matches('"').to_lowercase())
            .unwrap_or_default()
    };
    let id = field("ID");
    let id_like = field("ID_LIKE");
    let matches =
        |needle: &str| id == needle || id_like.split_whitespace().any(|entry| entry == needle);
    let install = if matches("arch") {
        "pacman -Sy --noconfirm docker"
    } else if matches("suse") || id == "opensuse-tumbleweed" || id == "opensuse-leap" {
        "zypper --non-interactive install docker"
    } else if matches("debian")
        || matches("ubuntu")
        || matches("fedora")
        || matches("rhel")
        || matches("centos")
    {
        "curl -fsSL https://get.docker.com | sh"
    } else {
        return None;
    };
    Some(format!(
        "{install} && systemctl enable --now docker && usermod -aG docker {user}"
    ))
}

fn install_command_hint() -> String {
    "see https://docs.docker.com/engine/install/ for your distribution, then re-check.".into()
}

fn os_release() -> String {
    std::fs::read_to_string("/etc/os-release").unwrap_or_default()
}

fn current_user() -> String {
    std::env::var("USER").unwrap_or_else(|_| "root".into())
}

pub fn user_in_docker_group() -> bool {
    let Ok(output) = quiet(Command::new("getent"))
        .args(["group", "docker"])
        .output()
    else {
        return false;
    };
    in_group_line(&String::from_utf8_lossy(&output.stdout), &current_user())
}

pub fn in_group_line(line: &str, user: &str) -> bool {
    line.trim()
        .rsplit(':')
        .next()
        .is_some_and(|members| members.split(',').any(|member| member.trim() == user))
}

/// Run a root shell line: directly when we ARE root, else through polkit's GUI prompt.
fn elevated(script: &str, reporter: &dyn Reporter) -> Result<()> {
    let as_root = quiet(Command::new("id"))
        .arg("-u")
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == "0");
    let output = if as_root {
        quiet(Command::new("sh")).args(["-c", script]).output()?
    } else {
        quiet(Command::new("pkexec"))
            .args(["sh", "-c", script])
            .output()?
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        reporter.log("fix", &stderr);
        return Err(Error::Command {
            command: script.into(),
            stderr,
        });
    }
    Ok(())
}

fn ok(id: CheckId, title: &str) -> Check {
    Check {
        id,
        title: title.into(),
        state: CheckState::Ok,
        detail: String::new(),
    }
}

fn fixable_or_manual(id: CheckId, title: &str, fixable_detail: &str, manual_detail: &str) -> Check {
    let has_pkexec = quiet(Command::new("pkexec"))
        .arg("--version")
        .output()
        .is_ok();
    let as_root = quiet(Command::new("id"))
        .arg("-u")
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == "0");
    if has_pkexec || as_root {
        Check {
            id,
            title: title.into(),
            state: CheckState::Fixable,
            detail: fixable_detail.into(),
        }
    } else {
        Check {
            id,
            title: title.into(),
            state: CheckState::Manual,
            detail: manual_detail.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_script_picks_the_distro_path() {
        let arch = "ID=arch\nPRETTY_NAME=\"Arch Linux\"\n";
        assert_eq!(
            install_script(arch, "dev").as_deref(),
            Some("pacman -Sy --noconfirm docker && systemctl enable --now docker && usermod -aG docker dev")
        );
        let ubuntu = "ID=ubuntu\nID_LIKE=debian\n";
        assert!(install_script(ubuntu, "dev")
            .unwrap()
            .starts_with("curl -fsSL https://get.docker.com | sh"));
        let manjaro = "ID=manjaro\nID_LIKE=arch\n";
        assert!(install_script(manjaro, "dev")
            .unwrap()
            .starts_with("pacman"));
        assert_eq!(install_script("ID=nixos\n", "dev"), None);
    }

    #[test]
    fn group_membership_reads_the_members_field() {
        assert!(in_group_line("docker:x:970:alice,bob", "bob"));
        assert!(!in_group_line("docker:x:970:alice", "bob"));
        assert!(!in_group_line("", "bob"));
    }
}
