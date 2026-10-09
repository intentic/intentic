//! What `ic engine install` still has to do — pure, so a test can lock the idempotent rules.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallFacts {
    pub distro_registered: bool,
    /// `ca.pem`, `cert.pem`, and `key.pem` under `%USERPROFILE%\.intentic\engine\tls\`.
    pub windows_client_tls_complete: bool,
    /// `server-cert.pem` in the distro's `/etc/intentic-engine/tls/`.
    pub distro_server_tls_present: bool,
    pub cli_present: bool,
    /// When `cli_present`, whether `docker.exe --version` names the pinned CLI build.
    pub cli_version_matches: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InstallStep {
    ImportDistro,
    GenerateTls,
    InstallCli,
    WriteRecord,
    RegisterAutostart,
    StartEngine,
}

/// Steps in the order `install` runs them. An existing distro is never re-imported (data lives in its VHDX).
pub fn install_steps(facts: &InstallFacts) -> Vec<InstallStep> {
    let mut steps = Vec::new();
    if !facts.distro_registered {
        steps.push(InstallStep::ImportDistro);
    }
    if !facts.windows_client_tls_complete || !facts.distro_server_tls_present {
        steps.push(InstallStep::GenerateTls);
    }
    if !facts.cli_present || !facts.cli_version_matches {
        steps.push(InstallStep::InstallCli);
    }
    steps.push(InstallStep::WriteRecord);
    steps.push(InstallStep::RegisterAutostart);
    steps.push(InstallStep::StartEngine);
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> InstallFacts {
        InstallFacts {
            distro_registered: false,
            windows_client_tls_complete: false,
            distro_server_tls_present: false,
            cli_present: false,
            cli_version_matches: false,
        }
    }

    #[test]
    fn fresh_pc_runs_every_step() {
        assert_eq!(
            install_steps(&fresh()),
            vec![
                InstallStep::ImportDistro,
                InstallStep::GenerateTls,
                InstallStep::InstallCli,
                InstallStep::WriteRecord,
                InstallStep::RegisterAutostart,
                InstallStep::StartEngine,
            ]
        );
    }

    #[test]
    fn existing_distro_is_never_reimported() {
        let facts = InstallFacts {
            distro_registered: true,
            ..fresh()
        };
        assert!(!install_steps(&facts).contains(&InstallStep::ImportDistro));
    }

    #[test]
    fn tls_runs_when_only_the_windows_half_is_missing() {
        let facts = InstallFacts {
            distro_registered: true,
            windows_client_tls_complete: false,
            distro_server_tls_present: true,
            cli_present: true,
            cli_version_matches: true,
        };
        assert_eq!(
            install_steps(&facts),
            vec![
                InstallStep::GenerateTls,
                InstallStep::WriteRecord,
                InstallStep::RegisterAutostart,
                InstallStep::StartEngine,
            ]
        );
    }

    #[test]
    fn tls_runs_when_only_the_distro_half_is_missing() {
        let facts = InstallFacts {
            distro_registered: true,
            windows_client_tls_complete: true,
            distro_server_tls_present: false,
            cli_present: true,
            cli_version_matches: true,
        };
        assert!(install_steps(&facts).contains(&InstallStep::GenerateTls));
    }

    #[test]
    fn cli_skipped_when_present_and_version_matches() {
        let facts = InstallFacts {
            distro_registered: true,
            windows_client_tls_complete: true,
            distro_server_tls_present: true,
            cli_present: true,
            cli_version_matches: true,
        };
        assert!(!install_steps(&facts).contains(&InstallStep::InstallCli));
    }

    #[test]
    fn cli_reinstalled_when_version_differs() {
        let facts = InstallFacts {
            distro_registered: true,
            windows_client_tls_complete: true,
            distro_server_tls_present: true,
            cli_present: true,
            cli_version_matches: false,
        };
        assert!(install_steps(&facts).contains(&InstallStep::InstallCli));
    }
}
