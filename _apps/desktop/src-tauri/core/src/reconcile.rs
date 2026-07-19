use std::path::PathBuf;

use crate::progress::Reporter;
use crate::types::{CheckId, EnvironmentReport, FixOutcome, Result};

/// Everything platform fixes need from the shell layer: where the WSL rootfs comes from and where
/// app-owned machine state lives.
#[derive(Debug, Clone)]
pub struct ReconcileContext {
    pub rootfs_url: String,
    pub data_dir: PathBuf,
}

pub fn probe(context: &ReconcileContext) -> EnvironmentReport {
    #[cfg(target_os = "linux")]
    {
        crate::linux::probe()
    }
    #[cfg(target_os = "windows")]
    {
        crate::windows::probe(context)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = context;
        EnvironmentReport {
            os: std::env::consts::OS.into(),
            checks: vec![crate::types::Check {
                id: CheckId::DockerInstalled,
                title: "Unsupported platform".into(),
                state: crate::types::CheckState::Manual,
                detail: "The desktop app supports Windows and Linux — use the copy-paste command instead.".into(),
            }],
            engine: None,
            ready: false,
        }
    }
}

pub fn fix(
    context: &ReconcileContext,
    check: CheckId,
    reporter: &dyn Reporter,
) -> Result<FixOutcome> {
    #[cfg(target_os = "linux")]
    {
        let _ = context;
        crate::linux::fix(check, reporter)
    }
    #[cfg(target_os = "windows")]
    {
        crate::windows::fix(context, check, reporter)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (context, check, reporter);
        Ok(FixOutcome::Manual {
            instructions: "Unsupported platform.".into(),
        })
    }
}
