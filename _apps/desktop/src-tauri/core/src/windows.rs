//! Windows environment: prefer a running Docker Desktop, otherwise manage our own WSL2 distro
//! (`intentic-machine`, imported from the released Alpine+dockerd rootfs) — Docker Desktop is never
//! installed by us. Parsers stay cfg-free so they compile and test on any host; process execution
//! is Windows-only.

/// wsl.exe writes UTF-16LE to pipes for its own output while Linux commands it hosts emit UTF-8 —
/// sniff the NUL bytes and decode accordingly.
pub fn decode_console(bytes: &[u8]) -> String {
    if bytes.iter().take(64).any(|byte| *byte == 0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

pub fn distro_listed(list_output: &str, distro: &str) -> bool {
    list_output
        .lines()
        .any(|line| line.trim().trim_matches('\u{feff}') == distro)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect()
    }

    #[test]
    fn decodes_wsl_utf16_and_plain_utf8() {
        assert_eq!(
            decode_console(&utf16("Ubuntu\r\nintentic-machine\r\n")),
            "Ubuntu\r\nintentic-machine\r\n"
        );
        assert_eq!(decode_console(b"linux utf8 output"), "linux utf8 output");
    }

    #[test]
    fn finds_the_managed_distro_in_the_list() {
        assert!(distro_listed(
            "Ubuntu\r\nintentic-machine\r\n",
            "intentic-machine"
        ));
        assert!(!distro_listed("Ubuntu\r\n", "intentic-machine"));
        assert!(distro_listed(
            "\u{feff}intentic-machine\r\n",
            "intentic-machine"
        ));
    }
}

#[cfg(target_os = "windows")]
pub use exec::{fix, probe};

#[cfg(target_os = "windows")]
mod exec {
    use std::path::Path;
    use std::process::Command;

    use super::{decode_console, distro_listed};
    use crate::docker::{self, DockerProbe};
    use crate::engine::{quiet, MACHINE_DISTRO};
    use crate::http;
    use crate::progress::Reporter;
    use crate::reconcile::ReconcileContext;
    use crate::types::{
        Check, CheckId, CheckState, Engine, EnvironmentReport, Error, FixOutcome, Result,
    };

    pub fn probe(context: &ReconcileContext) -> EnvironmentReport {
        let mut checks: Vec<Check> = Vec::new();
        let mut engine: Option<Engine> = None;

        // A working Docker Desktop wins — respect what the user already runs.
        let host = Engine::HostDocker { via_sg: false };
        match docker::probe(&host) {
            DockerProbe::Ready => {
                checks.push(Check {
                    id: CheckId::DockerDesktop,
                    title: "Docker Desktop is running".into(),
                    state: CheckState::Ok,
                    detail: String::new(),
                });
                return EnvironmentReport {
                    os: "windows".into(),
                    checks,
                    engine: Some(host),
                    ready: true,
                };
            }
            DockerProbe::DaemonDown if docker_desktop_installed() => {
                checks.push(Check {
                    id: CheckId::DockerDesktop,
                    title: "Docker Desktop is installed but not running".into(),
                    state: CheckState::Fixable,
                    detail: "The app starts Docker Desktop for you.".into(),
                });
                return EnvironmentReport {
                    os: "windows".into(),
                    checks,
                    engine: None,
                    ready: false,
                };
            }
            _ => {}
        }

        // The managed path: WSL2 → intentic-machine distro → dockerd inside it.
        let wsl_ok = wsl_available();
        checks.push(if wsl_ok {
            Check { id: CheckId::Wsl, title: "WSL 2 is available".into(), state: CheckState::Ok, detail: String::new() }
        } else {
            Check {
                id: CheckId::Wsl,
                title: "WSL 2 is not available".into(),
                state: CheckState::Fixable,
                detail: "The app enables WSL 2 (Windows will ask for administrator approval; a reboot may be needed).".into(),
            }
        });

        let distro_ok = wsl_ok && machine_distro_present();
        if wsl_ok {
            checks.push(if distro_ok {
                Check { id: CheckId::MachineDistro, title: "Sandbox machine is installed".into(), state: CheckState::Ok, detail: String::new() }
            } else {
                Check {
                    id: CheckId::MachineDistro,
                    title: "Sandbox machine is not installed".into(),
                    state: CheckState::Fixable,
                    detail: "The app downloads a ~50 MB Linux machine and imports it into WSL — no Docker Desktop needed.".into(),
                }
            });
        }

        if distro_ok {
            let wsl_engine = Engine::Wsl {
                distro: MACHINE_DISTRO.into(),
            };
            match docker::probe(&wsl_engine) {
                DockerProbe::Ready => {
                    checks.push(Check {
                        id: CheckId::MachineDocker,
                        title: "Sandbox machine is running".into(),
                        state: CheckState::Ok,
                        detail: String::new(),
                    });
                    engine = Some(wsl_engine);
                }
                _ => {
                    checks.push(Check {
                        id: CheckId::MachineDocker,
                        title: "Sandbox machine is stopped".into(),
                        state: CheckState::Fixable,
                        detail: "The app boots the machine's Docker engine.".into(),
                    });
                }
            }
        }

        let _ = context;
        let ready = engine.is_some();
        EnvironmentReport {
            os: "windows".into(),
            checks,
            engine,
            ready,
        }
    }

    pub fn fix(
        context: &ReconcileContext,
        check: CheckId,
        reporter: &dyn Reporter,
    ) -> Result<FixOutcome> {
        match check {
            CheckId::DockerDesktop => start_docker_desktop(reporter),
            CheckId::Wsl => install_wsl(reporter),
            CheckId::MachineDistro => import_machine(context, reporter),
            CheckId::MachineDocker => boot_machine_docker(reporter),
            other => Err(Error::Setup(format!("{other:?} is not a Windows fix"))),
        }
    }

    fn wsl(args: &[&str]) -> std::io::Result<(bool, String)> {
        let output = quiet(Command::new("wsl.exe")).args(args).output()?;
        let mut text = decode_console(&output.stdout);
        text.push_str(&decode_console(&output.stderr));
        Ok((output.status.success(), text))
    }

    fn wsl_available() -> bool {
        // `--status` succeeds only when the WSL platform is actually usable (not mid-install).
        wsl(&["--status"]).map(|(ok, _)| ok).unwrap_or(false)
    }

    fn machine_distro_present() -> bool {
        wsl(&["-l", "-q"])
            .map(|(ok, out)| ok && distro_listed(&out, MACHINE_DISTRO))
            .unwrap_or(false)
    }

    fn docker_desktop_installed() -> bool {
        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        Path::new(&program_files)
            .join(r"Docker\Docker\Docker Desktop.exe")
            .exists()
    }

    fn start_docker_desktop(reporter: &dyn Reporter) -> Result<FixOutcome> {
        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let exe = Path::new(&program_files).join(r"Docker\Docker\Docker Desktop.exe");
        reporter.log("fix", "starting Docker Desktop…");
        quiet(Command::new(exe)).spawn()?;
        // Docker Desktop takes a while to expose the engine; poll rather than guess.
        for _ in 0..60 {
            if docker::probe(&Engine::HostDocker { via_sg: false }) == DockerProbe::Ready {
                return Ok(FixOutcome::Fixed);
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
        Ok(FixOutcome::Manual {
            instructions:
                "Docker Desktop is starting slowly — wait for its whale icon, then re-check.".into(),
        })
    }

    /// `wsl --install --no-distro`, elevated through UAC. Exit code rides back via -PassThru.
    fn install_wsl(reporter: &dyn Reporter) -> Result<FixOutcome> {
        reporter.log("fix", "enabling WSL 2 — approve the administrator prompt…");
        let script = "$p = Start-Process -FilePath 'wsl.exe' -ArgumentList '--install','--no-distro' -Verb RunAs -Wait -PassThru; exit $p.ExitCode";
        let output = quiet(Command::new("powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()?;
        if !output.status.success() {
            return Err(Error::Command {
                command: "wsl --install --no-distro".into(),
                stderr: decode_console(&output.stderr),
            });
        }
        let _ = wsl(&["--update"]);
        if wsl_available() {
            return Ok(FixOutcome::Fixed);
        }
        Ok(FixOutcome::RebootRequired)
    }

    /// Download the released rootfs and import it as the managed distro.
    fn import_machine(context: &ReconcileContext, reporter: &dyn Reporter) -> Result<FixOutcome> {
        let tar = context.data_dir.join("intentic-machine-rootfs.tar.gz");
        reporter.log("fix", "downloading the sandbox machine…");
        http::download(&context.rootfs_url, &tar, reporter, "fix")?;
        let machine_dir = context.data_dir.join("machine");
        std::fs::create_dir_all(&machine_dir)?;
        reporter.log("fix", "importing it into WSL…");
        let (ok, out) = wsl(&[
            "--import",
            MACHINE_DISTRO,
            &machine_dir.to_string_lossy(),
            &tar.to_string_lossy(),
            "--version",
            "2",
        ])?;
        std::fs::remove_file(&tar).ok();
        if !ok {
            return Err(Error::Command {
                command: "wsl --import".into(),
                stderr: out,
            });
        }
        Ok(FixOutcome::Fixed)
    }

    fn boot_machine_docker(reporter: &dyn Reporter) -> Result<FixOutcome> {
        reporter.log("fix", "booting the sandbox machine's Docker engine…");
        let (ok, out) = wsl(&[
            "-d",
            MACHINE_DISTRO,
            "-u",
            "root",
            "--exec",
            "/usr/local/bin/intentic-machine-boot",
        ])?;
        if !ok {
            return Err(Error::Command {
                command: "intentic-machine-boot".into(),
                stderr: out,
            });
        }
        Ok(FixOutcome::Fixed)
    }
}
